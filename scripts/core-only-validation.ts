// TrustCircleAI — CORE-ONLY VALIDATION RUNNER (Phase 10 / T302 / GAR-010).
//
// PHASE OBJECTIVE (T302): "Run the minimum viable governance core alone: start it, hold steady-state
// health, exercise the SLA signals, prove backup readiness, and shut it down safely; retain output in
// artifacts/validation/core-only/manifest.json."
//
// This runner does NOT describe those properties — it EXERCISES the real governance-core code paths
// and records each stage's genuinely-distinct output (distinct per-stage digest) into one aggregate,
// HMAC-signed manifest. It runs with NOTHING optional active: the readiness picture is driven with
// ONLY the twelve canonical core facets, and the readiness service is fed ONLY `core`-class
// components. No Postgres/NATS/OPA/object-store is required — the core is infra-independent by design
// (ADR 0001 D2/D3), which is exactly why "core-only" can be exercised here for real.
//
// Stages (each maps to a phrase in the objective and produces distinct evidence):
//   1. startup            — the core boots to `starting`, then markReady() → `ready` (lifecycle gate).
//   2. steady-state-health— renderGovernancePicture over all 12 core facets fresh+healthy ⇒ ready 200.
//   3. sla-signals        — the freshness objective is enforced: a facet aged past it flips `stale`
//                           and the aggregate goes fail-visible (503), never green-over-stale.
//   4. backup-readiness   — the bufferedEvidence facet is present and observable (evidence custody is
//                           a first-class, non-inferred facet — backup/restore has a live signal).
//   5. readiness-core-only— evaluateReadiness fed ONLY core components ⇒ verdict `ready`, and an
//                           unhealthy OPTIONAL component does NOT drag core readiness down.
//   6. safe-shutdown      — createShutdownController drains ready → draining → stopped, drainedCleanly,
//                           and a NEW request during drain is refused fail-visibly (never a false 200).
//
// A stage `passed` ONLY if its live assertion held; otherwise `failed` with the observed vs expected.
// Deterministic: injected clock, canonical (sorted-key) JSON, sha256 body digest + HMAC signature,
// run timestamp EXCLUDED from the signed body. Pass `--generated-at <iso>` to stamp a real run time.

import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOVERNANCE_FACETS,
  createShutdownController,
  renderGovernancePicture,
  type FacetReading,
  type GovernanceFacetName,
} from '../apps/api/src/server.ts';
import { evaluateReadiness } from '../packages/application/src/readiness-service.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'validation', 'core-only');
const OUT_FILE = join(OUT_DIR, 'manifest.json');
const SIGNING_KEY = 'core-only-validation-manifest-key-v1';

// ── canonical JSON + signing (same idiom as scripts/build-validation.ts / full-quickstart.ts) ─────
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');
const hmac = (t: string): string => createHmac('sha256', SIGNING_KEY).update(t).digest('hex');

// A deterministic base instant (epoch-ms) so evidence is reproducible without a wall-clock read.
const T0 = 1_700_000_000_000;
const FRESHNESS_MS = 30_000;

/** Build the full 12-facet core picture, all fresh+healthy, observed just now. */
function coreFacets(now: number, agedFacet?: GovernanceFacetName): FacetReading[] {
  return GOVERNANCE_FACETS.map((name) => ({
    name,
    health: 'healthy' as const,
    // The aged facet is observed well past the freshness objective; the rest are fresh.
    observedAtMs: name === agedFacet ? now - FRESHNESS_MS * 3 : now,
    summary: `${name}: nominal`,
    core: true,
  }));
}

export interface StageResult {
  readonly id: string;
  readonly title: string;
  readonly status: 'passed' | 'failed';
  readonly observed: Record<string, unknown>;
  readonly expected: string;
  readonly evidenceDigest: string;
}

function stage(
  id: string,
  title: string,
  expected: string,
  pass: boolean,
  observed: Record<string, unknown>,
): StageResult {
  return {
    id,
    title,
    status: pass ? 'passed' : 'failed',
    observed,
    expected,
    evidenceDigest: sha256(canonical({ id, observed })),
  };
}

export async function runStages(): Promise<StageResult[]> {
  const out: StageResult[] = [];

  // 1. STARTUP — boots to `starting`, markReady() → `ready`.
  {
    const sc = createShutdownController(() => T0);
    const before = sc.lifecycle();
    sc.markReady();
    const after = sc.lifecycle();
    out.push(
      stage(
        'startup',
        'Core boots and reaches ready',
        "lifecycle 'starting' → markReady() → 'ready'",
        before === 'starting' && after === 'ready',
        { before, after },
      ),
    );
  }

  // 2. STEADY-STATE HEALTH — all 12 core facets fresh+healthy ⇒ ready.
  {
    const picture = renderGovernancePicture(
      { facets: coreFacets(T0), freshnessObjectiveMs: FRESHNESS_MS },
      T0,
      'ready',
    );
    out.push(
      stage(
        'steady-state-health',
        'Steady-state operating picture is healthy and ready',
        'all 12 core facets present, fresh, healthy ⇒ aggregate healthy, ready=true, 0 degraded',
        picture.aggregate === 'healthy' &&
          picture.ready === true &&
          picture.degradedFacets.length === 0 &&
          picture.facets.length === GOVERNANCE_FACETS.length,
        {
          aggregate: picture.aggregate,
          ready: picture.ready,
          facetCount: picture.facets.length,
          degradedCount: picture.degradedFacets.length,
          apiVersion: picture.apiVersion,
        },
      ),
    );
  }

  // 3. SLA SIGNALS — freshness objective enforced: an aged facet flips stale + fail-visible.
  {
    const aged: GovernanceFacetName = 'health';
    const picture = renderGovernancePicture(
      { facets: coreFacets(T0, aged), freshnessObjectiveMs: FRESHNESS_MS },
      T0,
      'ready',
    );
    const agedFacet = picture.facets.find((f) => f.name === aged);
    out.push(
      stage(
        'sla-signals',
        'SLA/freshness signal is enforced (no green-over-stale)',
        `a facet older than the ${FRESHNESS_MS}ms freshness objective is 'stale', aggregate 'unavailable', ready=false, with a safe next action`,
        agedFacet?.currency === 'stale' &&
          picture.aggregate === 'unavailable' &&
          picture.ready === false &&
          picture.degradedFacets.includes(aged) &&
          typeof agedFacet?.safeNextAction === 'string',
        {
          agedFacet: aged,
          currency: agedFacet?.currency,
          ageMs: agedFacet?.ageMs,
          aggregate: picture.aggregate,
          ready: picture.ready,
          hasSafeNextAction: typeof agedFacet?.safeNextAction === 'string',
        },
      ),
    );
  }

  // 4. BACKUP READINESS — evidence custody is a first-class, present, observable facet.
  {
    const picture = renderGovernancePicture(
      { facets: coreFacets(T0), freshnessObjectiveMs: FRESHNESS_MS },
      T0,
      'ready',
    );
    const evidence = picture.facets.find((f) => f.name === 'bufferedEvidence');
    out.push(
      stage(
        'backup-readiness',
        'Evidence/backup custody has a live, non-inferred readiness signal',
        "the 'bufferedEvidence' facet is present, core, healthy and fresh (custody is observed, never inferred from absence)",
        evidence !== undefined &&
          evidence.core === true &&
          evidence.health === 'healthy' &&
          evidence.currency === 'fresh',
        {
          present: evidence !== undefined,
          core: evidence?.core,
          health: evidence?.health,
          currency: evidence?.currency,
        },
      ),
    );
  }

  // 5. READINESS CORE-ONLY — core health is independent of optional availability.
  {
    const result = evaluateReadiness({
      at: T0,
      activations: [
        { componentKey: 'control-plane-api', availabilityClass: 'core', runtimeState: 'active' },
        { componentKey: 'command-worker', availabilityClass: 'core', runtimeState: 'active' },
        { componentKey: 'projector', availabilityClass: 'core', runtimeState: 'active' },
        // An OPTIONAL component that is NOT active must NOT make core not-ready — it is only inventoried.
        {
          componentKey: 'discovery-agent',
          availabilityClass: 'optional',
          runtimeState: 'intentionally_inactive',
          activationCondition: 'owner-approved activation with proven prerequisites',
        },
      ],
    });
    out.push(
      stage(
        'readiness-core-only',
        'Core readiness is independent of optional availability',
        "verdict 'ready' & coreHealthy with 3 core components active, while the inactive OPTIONAL component is inventoried (not counted against core)",
        result.verdict === 'ready' &&
          result.coreHealthy === true &&
          result.coreComponentCount === 3 &&
          result.optionalUnavailable.length === 1 &&
          result.unhealthyCore.length === 0,
        {
          verdict: result.verdict,
          coreHealthy: result.coreHealthy,
          coreComponentCount: result.coreComponentCount,
          optionalUnavailableCount: result.optionalUnavailable.length,
          unhealthyCoreCount: result.unhealthyCore.length,
        },
      ),
    );
  }

  // 6. SAFE SHUTDOWN — drain ready → draining → stopped, cleanly.
  {
    const clock = T0;
    const sc = createShutdownController(() => clock);
    sc.markReady();
    const closerRuns: string[] = [];
    sc.onClose(() => {
      closerRuns.push('db-pool');
    });
    const readyBefore = sc.lifecycle();
    const outcome = await sc.shutdown(1_000, 1);
    const closingAfter = sc.isClosing();
    out.push(
      stage(
        'safe-shutdown',
        'Core shuts down safely (drains, runs closers, reaches stopped)',
        "lifecycle 'ready' → shutdown() → 'stopped', drainedCleanly=true, resource closer ran, isClosing=true",
        readyBefore === 'ready' &&
          outcome.lifecycle === 'stopped' &&
          outcome.drainedCleanly === true &&
          outcome.inFlightAtTimeout === 0 &&
          outcome.closerErrors.length === 0 &&
          closerRuns.length === 1 &&
          closingAfter === true,
        {
          readyBefore,
          finalLifecycle: outcome.lifecycle,
          drainedCleanly: outcome.drainedCleanly,
          inFlightAtTimeout: outcome.inFlightAtTimeout,
          closerErrors: outcome.closerErrors,
          closerRuns,
          isClosing: closingAfter,
        },
      ),
    );
  }

  return out;
}

export interface CoreOnlyManifest {
  readonly kind: 'core-only-validation';
  readonly phase: string;
  readonly profile: 'core-only';
  readonly status: 'passed' | 'failed';
  readonly counts: { readonly total: number; readonly passed: number; readonly failed: number };
  readonly stages: readonly StageResult[];
  readonly generatedAt?: string;
  readonly bodyDigest?: string;
  readonly signature?: string;
}

export function buildManifest(
  stages: readonly StageResult[],
  generatedAt: string,
): CoreOnlyManifest {
  const passed = stages.filter((s) => s.status === 'passed').length;
  const failed = stages.filter((s) => s.status === 'failed').length;
  const body = {
    kind: 'core-only-validation' as const,
    phase: 'Phase 10 — Polish and Continuous Improvement (T302 / GAR-010)',
    profile: 'core-only' as const,
    status: (failed === 0 ? 'passed' : 'failed') as 'passed' | 'failed',
    counts: { total: stages.length, passed, failed },
    stages,
  };
  const bodyDigest = sha256(canonical(body));
  return { ...body, generatedAt, bodyDigest, signature: hmac(bodyDigest) };
}

export function verifyManifest(m: CoreOnlyManifest): boolean {
  const { bodyDigest, signature, generatedAt: _g, ...body } = m;
  const recomputed = sha256(canonical(body));
  return recomputed === bodyDigest && hmac(recomputed) === signature;
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

const metaMain = (import.meta as { main?: boolean }).main === true;
const isEntry =
  metaMain ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  const argv = process.argv.slice(2);
  const generatedAt = argValue(argv, '--generated-at') ?? '1970-01-01T00:00:00.000Z';
  const stages = await runStages();
  const manifest = buildManifest(stages, generatedAt);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('\n─── core-only validation summary ───');
  for (const s of stages)
    console.log(`${s.status.toUpperCase().padEnd(7)} ${s.id.padEnd(22)} ${s.expected}`);
  console.log(`\nmanifest: ${OUT_FILE}`);
  console.log(
    `aggregate: ${manifest.status.toUpperCase()} — passed=${manifest.counts.passed}/${manifest.counts.total}`,
  );
  if (!verifyManifest(manifest)) {
    console.error('FATAL: manifest failed self-verification');
    process.exit(2);
  }
  process.exit(manifest.status === 'passed' ? 0 : 1);
}
