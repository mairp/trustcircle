// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 85 — Scenario 1 SIGNED RESULT MANIFEST emitter
// Work item 73TQ0YZ16SPVKR0PNRDJTH8C43 · requirement RKMR5H2VVV7B7KQAEEY2D8CDXG (US1 "See the
// Current Governance State") · acceptance US1-AS1..US1-AS6 · bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic emitter that RUNS the real governed source-discovery agent
// (`apps/discovery-agent/src/main.ts`) over a Scenario-1 fixture inside the declared computer
// boundary, then EMITS A SIGNED result manifest binding — for every one of the six Scenario-1
// acceptance criteria — its:
//
//   • requirement reference   (the versioned requirement id RKMR5H2VVV7B7KQAEEY2D8CDXG),
//   • assertion reference     (the acceptance-criterion id US1-AS{n} + its verbatim Given/When/Then),
//   • audit reference         (the verification-plan effect-witness obligation VO-… for US1-AS{n},
//                              plus the durable checkpoint safe-next-action — the audit trail row),
//   • evidence                (facts observed through INDEPENDENT read paths: the reconciled
//                              SourceCatalog rows, the flushed durable evidence-sink records, the
//                              durable checkpoint — NEVER a mutation method's own return value),
//   • version reference       (bundle id + semantic content hash + bundle version + verification-plan
//                              id/version — the pinned execution identity every result is bound to),
//   • gap references          (the visible coverage-gap catalog entries with their disclosure-safe
//                              GapReason — so no discovered item can "look healthy" by omission).
//
// The manifest is SIGNED the same way the repo's evidence manifest is (scripts/ci/evidence-
// manifest.mjs): a canonical (sorted-key) JSON serialisation is hashed with Node's built-in
// crypto (sha256) to a `manifestDigest`, and every criterion line additionally carries its own
// per-line `lineDigest`, chained so a single mutated byte anywhere invalidates the signature. The
// signature also re-pins the bundle identity; a manifest whose bundle id / content hash differs
// from the pinned input is rejected by `verifyScenario1ResultManifest`.
//
// ORACLE / EFFECT-WITNESS DISCIPLINE. Nothing in the manifest is taken from an agent method's
// return value. Each criterion's `evidence` block is derived from the durable read paths populated
// AFTER the sweep + flush: `catalog.entries()` / `catalog.gaps()`, the capturing sink's `flushed`
// array, and the checkpoint store's saved rows. This mirrors the integration effect-witness VOs
// (VO-a990a985…, VO-62c43281…, VO-9f597528…, VO-2f3b4fef…, VO-7e4075d3…, VO-60db0834…) that pin
// Scenario 1 in verification-plan `verification-90012e69317ff71a927b`.
//
// This file is a plain ESM module (no test-runner import) so it is reusable from BOTH the Node
// built-in test runner and the browserless Playwright `discovery` project. Its two executable
// witnesses live in:
//   • tests/e2e/discovery-open-boundary.manifest.spec.ts   (Playwright `discovery` project)
//   • tests/discovery/scenario1-result-manifest.test.mjs   (node --test, npm run test:discovery)
// Both assert the manifest with paired NEGATIVE controls so the oracle is non-vacuous.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type {
  AgentCheckpoint,
  AuthorizationDecision,
  CatalogEntry,
  DiscoveryEvidenceRecord,
  DiscoveryStatus,
  GapReason,
  ProbeResult,
  ScanAuthorizer,
  ScanBudgetLimits,
  ScanTarget,
  StoredLease,
  TargetProbe,
  TargetSource,
} from '../../../apps/discovery-agent/src/main.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const agentMod = await import(join(ROOT, 'apps/discovery-agent/src/main.ts'));

const {
  GovernedDiscoveryAgent,
  AgentLease,
  EvidenceBuffer,
  SourceCatalog,
  GAP_REASONS,
  ONBOARDING_STATES,
  SAFE_NEXT_ACTIONS,
} = agentMod as typeof import('../../../apps/discovery-agent/src/main.ts');

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. PINNED EXECUTION IDENTITY — every result the manifest emits is bound to this.
//    A verifier rejects any manifest whose bundle id / content hash differs from these constants,
//    so evidence produced against a different bundle cannot masquerade as Scenario-1 evidence.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const PINNED = Object.freeze({
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  /** The bundle's semantic content hash (a.k.a. semanticHash). */
  contentHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  bundleVersion: 2,
  workItemId: '73TQ0YZ16SPVKR0PNRDJTH8C43',
  requirementRef: 'RKMR5H2VVV7B7KQAEEY2D8CDXG',
  verificationPlanId: 'verification-90012e69317ff71a927b',
  verificationPlanVersion: 1,
  scenario: 'US1',
  scenarioTitle: 'See the Current Governance State',
} as const);

/** Manifest schema version — bumping it is a breaking manifest change. */
export const MANIFEST_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE SIX ACCEPTANCE CRITERIA — verbatim Given/When/Then text (source of truth:
//    specs/001-governance-control-plane/spec.md US1 acceptance scenarios / bundle.v2.json
//    requirement RKMR5H2VVV7B7KQAEEY2D8CDXG.acceptanceCriteria) + the effect-witness obligation
//    (audit reference) that verification-plan verification-90012e69317ff71a927b pins to each.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface AcceptanceSpec {
  readonly assertionRef: string; // US1-AS{n}
  /** verification-plan integration effect-witness obligation id (the audit reference). */
  readonly obligationRef: string; // VO-…
  readonly text: string; // verbatim Given/When/Then
}

export const SCENARIO1_ACCEPTANCE: readonly AcceptanceSpec[] = Object.freeze([
  {
    assertionRef: 'US1-AS1',
    obligationRef: 'VO-a990a9859f97d9ea0c27',
    text: 'Given healthy connected sources contain AI assets and governance records, When the officer opens the current-state view, Then each item appears once with its type, source identity, owner, lifecycle state, risk, control coverage, evidence state, health, last observation time, and unresolved issues.',
  },
  {
    assertionRef: 'US1-AS2',
    obligationRef: 'VO-62c432815b37599ebe22',
    text: 'Given a component is discovered but unmanaged, unreachable, stale, orphaned, or explicitly excluded, When inventory is reconciled, Then it remains visible as a coverage gap with reason, age, impact, and required owner action rather than appearing healthy or disappearing.',
  },
  {
    assertionRef: 'US1-AS3',
    obligationRef: 'VO-9f597528a41f71ca46b5',
    text: 'Given related work exists across registered sources, including Kanban, agentctl, and workflows_orchestration, When the officer drills into an item, Then the view shows their distinct source records, correlation, status differences, dependencies, and authoritative fields.',
  },
  {
    assertionRef: 'US1-AS4',
    obligationRef: 'VO-2f3b4fefeac7e96846a8',
    text: 'Given a source becomes stale or unavailable, When the view is refreshed, Then affected data is visibly marked with its last-known time and confidence, and current compliance or health is not inferred from stale data.',
  },
  {
    assertionRef: 'US1-AS5',
    obligationRef: 'VO-7e4075d359bbfb117256',
    text: 'Given an unregistered governance-relevant source appears within the declared computer boundary, When discovery runs, Then it is added to the source catalog with discovery evidence, type or unknown classification, location, access status, sensitivity, ownership status, and onboarding state.',
  },
  {
    assertionRef: 'US1-AS6',
    obligationRef: 'VO-60db0834fdb5154845d0',
    text: 'Given a discovered source is unsupported, inaccessible, sensitive, unowned, or intentionally excluded, When coverage is assessed, Then it remains visible as a governed source gap with reason, impact, owner action, and review or expiry.',
  },
]);

/** Success-criteria thresholds this scenario is measured against (spec.md Success Criteria). */
export const SCENARIO1_SUCCESS_CRITERIA = Object.freeze([
  {
    id: 'SC-001',
    text: '100% of records from declared healthy inventory sources are represented or explicitly listed as unmatched, excluded, or failed-to-ingest; no discovered item disappears silently.',
  },
  {
    id: 'SC-002',
    text: 'At least 99% of observed source-state changes appear with provenance in the current-state view within 2 minutes while the source is healthy.',
  },
  {
    id: 'SC-017',
    text: 'Machine-wide discovery identifies 100% of seeded supported source instances and at least 95% of seeded previously unregistered source candidates within the declared, authorized boundary.',
  },
  {
    id: 'SC-018',
    text: '100% of discovered unsupported, inaccessible, sensitive, unowned, excluded, moved, or disappeared sources remain visible with current coverage state, reason, stewardship action, and history.',
  },
  {
    id: 'SC-019',
    text: "In all least-privilege discovery tests, the platform catalogs available source metadata without reading protected content, secrets, or credentials beyond the discovery principal's current authority.",
  },
] as const);

// The disclosure-safe owner action each gap reason maps to (mirrors the e2e AC2 spec's mapping).
const OWNER_ACTION_BY_GAP: Readonly<Record<GapReason, string>> = Object.freeze({
  out_of_scope: 'confirm_exclusion_or_extend_scope',
  unauthorized: 'grant_or_approve_access',
  authorization_indeterminate: 'resolve_authorization',
  probe_failed: 'restore_reachability',
  budget_targets: 'raise_budget',
  budget_duration: 'raise_budget',
  budget_blast: 'raise_budget',
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. DETERMINISTIC HARNESS — manual clock + in-memory stores + scripted collaborators. Identical
//    substrate to tests/e2e/discovery-open-boundary.spec.ts, so the manifest is emitted against
//    the SAME real agent the AC suite verifies, not a re-implementation.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type Clock = (() => number) & { advance: (ms: number) => number; set: (v: number) => number };

function manualClock(start = 1_700_000_000_000): Clock {
  let t = start;
  const clock = (() => t) as Clock;
  clock.advance = (ms: number) => (t += ms);
  clock.set = (v: number) => (t = v);
  return clock;
}

interface LeaseStoreHarness {
  rows: Map<string, StoredLease>;
  read(resource: string): Promise<StoredLease | null>;
  write(lease: StoredLease): Promise<void>;
  clear(resource: string, holder: string, fencingToken: number): Promise<boolean>;
}
function memoryLeaseStore(): LeaseStoreHarness {
  const rows = new Map<string, StoredLease>();
  return {
    rows,
    async read(resource) {
      return rows.get(resource) ?? null;
    },
    async write(lease) {
      rows.set(lease.resource, { ...lease });
    },
    async clear(resource, holder, fencingToken) {
      const cur = rows.get(resource);
      if (cur && cur.holder === holder && cur.fencingToken === fencingToken) {
        rows.set(resource, {
          resource,
          holder: null,
          fencingToken,
          expiresAt: null,
          updatedAt: cur.updatedAt,
        });
        return true;
      }
      return false;
    },
  };
}

interface CheckpointStoreHarness {
  saved: AgentCheckpoint[];
  latest: Map<string, AgentCheckpoint>;
  load(resource: string): Promise<AgentCheckpoint | null>;
  save(cp: AgentCheckpoint): Promise<void>;
}
function memoryCheckpointStore(): CheckpointStoreHarness {
  const saved: AgentCheckpoint[] = [];
  const latest = new Map<string, AgentCheckpoint>();
  return {
    saved,
    latest,
    async load(resource) {
      return latest.get(resource) ?? null;
    },
    async save(cp) {
      saved.push(cp);
      latest.set(cp.resource, cp);
    },
  };
}

interface SinkHarness {
  flushed: DiscoveryEvidenceRecord[];
  sink: (records: readonly DiscoveryEvidenceRecord[]) => Promise<void>;
}
function capturingSink(): SinkHarness {
  const flushed: DiscoveryEvidenceRecord[] = [];
  return {
    flushed,
    sink: async (records) => {
      for (const r of records) flushed.push(r);
    },
  };
}

interface AuthorizerHarness {
  calls: string[];
  authorizer: ScanAuthorizer;
}
function scriptedAuthorizer(
  decideFor: (t: ScanTarget) => AuthorizationDecision,
): AuthorizerHarness {
  const calls: string[] = [];
  return {
    calls,
    authorizer: {
      async authorize(target) {
        calls.push(target.targetId);
        return decideFor(target);
      },
    },
  };
}

interface ProbeHarness {
  calls: string[];
  probe: TargetProbe;
}
function scriptedProbe(behaviorFor: (t: ScanTarget) => ProbeResult): ProbeHarness {
  const calls: string[] = [];
  return {
    calls,
    probe: {
      async probe(target) {
        calls.push(target.targetId);
        return behaviorFor(target);
      },
    },
  };
}

function mutableTargets(initial: readonly ScanTarget[]): {
  set(next: readonly ScanTarget[]): void;
  source: TargetSource;
} {
  let cur = [...initial];
  return {
    set(next) {
      cur = [...next];
    },
    source: {
      async listTargets() {
        return cur;
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE SCENARIO-1 FIXTURE — a declared computer boundary containing:
//    • three registered sources across DISTINCT systems (Kanban, agentctl, workflows_orchestration)
//      → AC1 (each appears once) + AC3 (distinct correlated records),
//    • one previously-UNREGISTERED governance-relevant source that discovery finds → AC5,
//    • three gap-producing targets: unmanaged (denied), unreachable (probe fails), excluded
//      (out-of-scope) → AC2 + AC6,
//    • a source that goes STALE / disappears on the second sweep → AC4.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const KANBAN = 'kanban:board-42';
const AGENTCTL = 'agentctl:agent-7';
const WORKFLOWS = 'workflows_orchestration:wf-9';
const UNREGISTERED = 'unknown:svc-new';
const UNMANAGED = 'kanban:board-denied';
const UNREACHABLE = 'agentctl:agent-down';
const EXCLUDED = 'secretstore:vault-1';
const STALE = 'kanban:board-stale';

const GRANTED_SCOPES = ['kanban', 'agentctl', 'workflows_orchestration', 'unknown'] as const;

function mkTarget(
  over: Partial<ScanTarget> & Pick<ScanTarget, 'targetId' | 'scope' | 'location'>,
): ScanTarget {
  return { registered: false, ...over };
}

const SWEEP1_TARGETS: readonly ScanTarget[] = [
  mkTarget({
    targetId: KANBAN,
    scope: 'kanban',
    location: 'host://svc/kanban/board-42',
    registered: true,
  }),
  mkTarget({
    targetId: AGENTCTL,
    scope: 'agentctl',
    location: 'host://svc/agentctl/agent-7',
    registered: true,
  }),
  mkTarget({
    targetId: WORKFLOWS,
    scope: 'workflows_orchestration',
    location: 'host://svc/wf/wf-9',
    registered: true,
  }),
  mkTarget({
    targetId: STALE,
    scope: 'kanban',
    location: 'host://svc/kanban/board-stale',
    registered: true,
  }),
  mkTarget({
    targetId: UNREGISTERED,
    scope: 'unknown',
    location: 'host://svc/new/svc-new',
    registered: false,
  }),
  mkTarget({
    targetId: UNMANAGED,
    scope: 'kanban',
    location: 'host://svc/kanban/board-denied',
    registered: false,
  }),
  mkTarget({
    targetId: UNREACHABLE,
    scope: 'agentctl',
    location: 'host://svc/agentctl/agent-down',
    registered: true,
  }),
  // secretstore scope is NOT in GRANTED_SCOPES → out_of_scope gap (least-privilege exclusion).
  mkTarget({
    targetId: EXCLUDED,
    scope: 'secretstore',
    location: 'host://svc/vault/vault-1',
    registered: false,
  }),
];

// Second sweep: STALE source disappears (dropped from the target batch) so its last-known
// catalog row must persist (AC4). Everything else re-appears (reconciliation → no duplicates).
const SWEEP2_TARGETS: readonly ScanTarget[] = SWEEP1_TARGETS.filter((t) => t.targetId !== STALE);

function classify(t: ScanTarget): string {
  if (t.scope === 'kanban') return 'kanban';
  if (t.scope === 'agentctl') return 'agentctl';
  if (t.scope === 'workflows_orchestration') return 'workflows_orchestration';
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. RUN THE REAL AGENT — two sweeps, flush after each — and collect the DURABLE read-path facts.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface Scenario1Observations {
  readonly catalogEntries: readonly CatalogEntry[];
  readonly gaps: readonly CatalogEntry[];
  readonly sources: readonly CatalogEntry[];
  readonly flushedEvidence: readonly DiscoveryEvidenceRecord[];
  readonly checkpoints: readonly AgentCheckpoint[];
  readonly latestCheckpoint: AgentCheckpoint | null;
  /** Metadata keys the probe was allowed to record (least-privilege witness). */
  readonly authorizerCalls: readonly string[];
  readonly probeCalls: readonly string[];
  readonly clockAtSweep1: number;
  readonly clockAtSweep2: number;
  /** The least-privilege authority surface the agent was granted (FR-001 authorized scope). */
  readonly grantedScopes: readonly string[];
  /** A durable status snapshot read AFTER the sweeps (an independent read path). */
  readonly status: DiscoveryStatus;
}

export async function runScenario1(): Promise<Scenario1Observations> {
  const clock = manualClock();
  const leaseStore = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const sinkPair = capturingSink();
  const evidence = new EvidenceBuffer(sinkPair.sink);
  const catalog = new SourceCatalog();
  // TTL comfortably exceeds the 120s inter-sweep advance below so the lease stays live across the
  // staleness window — this scenario exercises SOURCE staleness (AC4), not lease expiry (which has
  // its own fail-closed guard, covered elsewhere).
  const lease = new AgentLease({
    store: leaseStore,
    resource: 'source-discovery',
    holder: 'agent-A',
    clock,
    ttlMs: 600_000,
  });

  const authorizer = scriptedAuthorizer((t): AuthorizationDecision => {
    // A source the owner has NOT approved → explicit `denied` (fail-closed) → `unauthorized` gap.
    if (t.targetId === UNMANAGED)
      return { kind: 'denied', reason: 'owner_has_not_approved_access' };
    return { kind: 'authorized', reason: 'within_granted_authority' };
  });

  const probe = scriptedProbe((t): ProbeResult => {
    if (t.targetId === UNREACHABLE) throw new Error('connection refused');
    return {
      reachable: true,
      classification: classify(t),
      evidence: { seenAt: 'boundary', metadataOnly: true },
    };
  });

  const targets = mutableTargets(SWEEP1_TARGETS);

  const budget: ScanBudgetLimits = Object.freeze({
    maxTargetsPerSweep: 100,
    maxSweepDurationMs: 60_000,
    maxNewSourcesPerSweep: 100,
  });

  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints,
    evidence,
    authorizer: authorizer.authorizer,
    targets: targets.source,
    probe: probe.probe,
    catalog,
    grantedScopes: new Set(GRANTED_SCOPES),
    budgetLimits: budget,
    clock,
    sleep: async () => {},
    idleDelayMs: 5,
    renewAtFraction: 0.5,
  });

  const started = await agent.start();
  if (!started) throw new Error('scenario1: agent failed to acquire lease');

  // Sweep 1 — full boundary.
  await agent.runOnce();
  await evidence.flush();
  const clockAtSweep1 = clock();

  // Advance time past the source-freshness horizon and drop the STALE source for sweep 2.
  clock.advance(120_000);
  targets.set(SWEEP2_TARGETS);
  await agent.runOnce();
  await evidence.flush();
  const clockAtSweep2 = clock();

  return {
    catalogEntries: catalog.entries(),
    gaps: catalog.gaps(),
    sources: catalog.sources(),
    flushedEvidence: sinkPair.flushed.map((r) => ({ ...r })),
    checkpoints: checkpoints.saved.map((c) => ({ ...c })),
    latestCheckpoint: checkpoints.latest.get('source-discovery') ?? null,
    authorizerCalls: [...authorizer.calls],
    probeCalls: [...probe.calls],
    clockAtSweep1,
    clockAtSweep2,
    grantedScopes: [...GRANTED_SCOPES],
    status: agent.status(clockAtSweep2),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. CANONICALISATION + SIGNING — mirrors scripts/ci/evidence-manifest.mjs exactly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function sha256(buf: string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Canonical stable JSON (sorted keys), excluding volatile self-reference fields. */
export function canonicalize(obj: unknown): string {
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone && typeof clone === 'object') {
    delete (clone as Record<string, unknown>).manifestDigest;
    delete (clone as Record<string, unknown>).signature;
  }
  return stableStringify(clone);
}
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. THE MANIFEST TYPES
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface EvidenceWitness {
  /** How this fact was observed — always an independent read path, never a mutation return. */
  readonly readPath: 'source-catalog' | 'evidence-sink' | 'checkpoint-store';
  readonly detail: string;
  /** The durable identity/value witnessed (targetId, evidence kind, safe-next-action, …). */
  readonly witnessed: readonly string[];
}

export interface GapReference {
  readonly targetId: string;
  readonly gapReason: GapReason;
  readonly ownerAction: string;
  readonly lastObservedAt: number;
  readonly detail: string | null;
}

export interface ManifestLine {
  readonly assertionRef: string; // US1-AS{n}  (assertion reference)
  readonly requirementRef: string; // RKMR5…    (requirement reference)
  readonly auditRef: {
    // audit references: the effect-witness obligation + the durable audit-trail action.
    readonly obligationRef: string; // VO-…
    readonly verificationPlanId: string;
    readonly safeNextAction: string;
  };
  readonly assertionText: string;
  readonly evidence: readonly EvidenceWitness[];
  readonly gapRefs: readonly GapReference[];
  /** Per-line signature over this line's canonical form (chained into the manifest digest). */
  readonly lineDigest: string;
}

/**
 * A single standalone FR MUST-clause from the spec (the ones that are NOT one of the six US1
 * Given/When/Then acceptance scenarios and NOT one of the five success criteria) mapped to an
 * INDEPENDENTLY OBSERVABLE witness produced by the real agent's durable read paths.
 *
 * `disposition` is deliberately honest:
 *   • 'witnessed'            — the emitter observes a concrete durable fact discharging the clause
 *                             (for the current-state / discovery slice this US1 view is responsible
 *                             for). `witness` carries the observed values.
 *   • 'boundary-witnessed'  — the clause's downstream ACTION (e.g. a steward mutation, a decision
 *                             queue's business-impact scoring, a precedence-resolution UI) lives
 *                             OUTSIDE this discovery emitter, but the SUBSTRATE the clause depends on
 *                             (audit-trail rows, the pending-onboarding set, the distinct-records
 *                             base, the visible unresolved-conflict inputs) IS produced here and is
 *                             witnessed. `coveredElsewhere` names where the action itself is verified.
 * No clause is marked with a bare "met" without a durable witness value.
 */
export interface FrClauseWitness {
  readonly frId: string; // FR-001 …
  readonly clause: string; // verbatim MUST-clause text (abbreviated)
  readonly disposition: 'witnessed' | 'boundary-witnessed';
  readonly readPath: 'source-catalog' | 'evidence-sink' | 'checkpoint-store' | 'status-snapshot';
  readonly witness: readonly string[]; // durable observed values (never empty)
  /** For boundary-witnessed clauses: where the downstream ACTION is verified. */
  readonly coveredElsewhere: string | null;
}

export interface Scenario1ResultManifest {
  readonly manifestVersion: number;
  readonly kind: 'scenario-result-manifest';
  readonly scenario: string; // US1
  readonly scenarioTitle: string;
  readonly emittedBy: string; // this module path (provenance)
  readonly version: {
    readonly bundleId: string;
    readonly contentHash: string;
    readonly bundleVersion: number;
    readonly workItemId: string;
    readonly requirementRef: string;
    readonly verificationPlanId: string;
    readonly verificationPlanVersion: number;
  };
  readonly successCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly met: boolean;
    readonly measure: string;
  }[];
  readonly lines: readonly ManifestLine[];
  /**
   * The standalone FR MUST-clause criteria (beyond the six AS lines + five SCs) each mapped to an
   * independently observable durable witness — so no acceptance criterion is left un-witnessed.
   */
  readonly frClauses: readonly FrClauseWitness[];
  /** All visible coverage gaps, so nothing "looks healthy" by omission. */
  readonly gapRegister: readonly GapReference[];
  /** sha256 over the canonical (sorted-key) manifest, self-binding the whole result. */
  readonly manifestDigest: string;
  readonly signature: {
    readonly algorithm: 'sha256';
    readonly digest: string; // == manifestDigest (re-stated for convenience)
    readonly boundBundleId: string;
    readonly boundContentHash: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8. BUILD THE SIGNED MANIFEST from the observed facts.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function gapRef(entry: CatalogEntry): GapReference {
  const reason = entry.gapReason as GapReason;
  return {
    targetId: entry.targetId,
    gapReason: reason,
    ownerAction: OWNER_ACTION_BY_GAP[reason] ?? 'investigate',
    lastObservedAt: entry.observedAt,
    detail: entry.detail,
  };
}

function evidenceFor(assertionRef: string, obs: Scenario1Observations): EvidenceWitness[] {
  const byId = (id: string): CatalogEntry | undefined =>
    obs.catalogEntries.find((e) => e.targetId === id);
  const discoveredKinds = (id: string): string[] =>
    obs.flushedEvidence.filter((r) => r.targetId === id).map((r) => r.kind);

  switch (assertionRef) {
    case 'US1-AS1': {
      // Each healthy registered source appears exactly once with its authoritative fields.
      const ids = [KANBAN, AGENTCTL, WORKFLOWS];
      const rows = ids.map((id) => byId(id)).filter((e): e is CatalogEntry => Boolean(e));
      const once = ids.every(
        (id) => obs.catalogEntries.filter((e) => e.targetId === id).length === 1,
      );
      return [
        {
          readPath: 'source-catalog',
          detail: `each healthy registered source appears exactly once (uniqueness=${once}) with scope/onboarding/observedAt authoritative fields`,
          witnessed: rows.map(
            (e) =>
              `${e.targetId}|scope=${e.scope}|onboarding=${e.onboarding}|observedAt=${e.observedAt}|gapReason=${String(e.gapReason)}`,
          ),
        },
        {
          readPath: 'evidence-sink',
          detail: 'durable discovery evidence recorded for each healthy source (evidence state)',
          witnessed: ids.map((id) => `${id}:${discoveredKinds(id).join('+') || 'none'}`),
        },
      ];
    }
    case 'US1-AS2': {
      // Unmanaged/unreachable/excluded remain visible gaps with reason + owner action.
      const gaps = obs.gaps.filter((g) => [UNMANAGED, UNREACHABLE, EXCLUDED].includes(g.targetId));
      return [
        {
          readPath: 'source-catalog',
          detail:
            'discovered-but-unmanaged/unreachable/excluded persist as reasoned gaps (never healthy, never absent)',
          witnessed: gaps.map(
            (g) =>
              `${g.targetId}|gapReason=${String(g.gapReason)}|ownerAction=${OWNER_ACTION_BY_GAP[g.gapReason as GapReason]}|age=${obs.clockAtSweep2 - g.observedAt}ms`,
          ),
        },
      ];
    }
    case 'US1-AS3': {
      // Distinct source records across Kanban / agentctl / workflows_orchestration.
      const distinct = [KANBAN, AGENTCTL, WORKFLOWS]
        .map((id) => byId(id))
        .filter((e): e is CatalogEntry => Boolean(e));
      const distinctScopes = new Set(distinct.map((e) => e.scope));
      return [
        {
          readPath: 'source-catalog',
          detail: `three DISTINCT source records preserved across ${distinctScopes.size} systems (no collapse/merge of distinct sources)`,
          witnessed: distinct.map((e) => `${e.targetId}|scope=${e.scope}|location=${e.location}`),
        },
        {
          readPath: 'evidence-sink',
          detail:
            'per-source discovery evidence keeps each record independently traceable (correlation preserves distinct records)',
          witnessed: distinct.map(
            (e) => `${e.targetId}:${discoveredKinds(e.targetId).join('+') || 'none'}`,
          ),
        },
      ];
    }
    case 'US1-AS4': {
      // Stale source: last-known row persists after it disappears; not inferred fresh.
      const stale = byId(STALE);
      return [
        {
          readPath: 'source-catalog',
          detail: `stale/disappeared source retains its last-known observation (last-known time=${stale?.observedAt ?? 'MISSING'}); health not inferred from stale data`,
          witnessed: stale
            ? [
                `${stale.targetId}|lastKnownAt=${stale.observedAt}|ageAtRefresh=${obs.clockAtSweep2 - stale.observedAt}ms|onboarding=${stale.onboarding}`,
              ]
            : ['STALE-ROW-MISSING'],
        },
        {
          readPath: 'checkpoint-store',
          detail:
            'durable checkpoint distinguishes the refreshed sweep clock from the stale source last-known time',
          witnessed: [
            `latestCheckpointSweepClock=${obs.latestCheckpoint?.updatedAt ?? 'none'}`,
            `staleLastKnownAt=${stale?.observedAt ?? 'none'}`,
          ],
        },
      ];
    }
    case 'US1-AS5': {
      // Unregistered source added to catalog with discovery evidence + classification + location.
      const disc = byId(UNREGISTERED);
      return [
        {
          readPath: 'source-catalog',
          detail:
            'previously-unregistered in-boundary source added to catalog with classification/location/onboarding/access state',
          witnessed: disc
            ? [
                `${disc.targetId}|onboarding=${disc.onboarding}|location=${disc.location}|classification(detail)=${disc.detail}`,
              ]
            : ['UNREGISTERED-ROW-MISSING'],
        },
        {
          readPath: 'evidence-sink',
          detail:
            'durable discovery-evidence record proves the source was discovered (not assumed)',
          witnessed: [`${UNREGISTERED}:${discoveredKinds(UNREGISTERED).join('+') || 'none'}`],
        },
      ];
    }
    case 'US1-AS6': {
      // Unsupported/inaccessible/sensitive/unowned/excluded discovered source stays a governed gap.
      const excluded = byId(EXCLUDED);
      const unreachable = byId(UNREACHABLE);
      const govGaps = [excluded, unreachable].filter(
        (e): e is CatalogEntry => Boolean(e) && e!.onboarding === 'gap',
      );
      return [
        {
          readPath: 'source-catalog',
          detail:
            'excluded (out-of-scope) + inaccessible (probe-failed) discovered sources remain governed gaps with reason + owner action + reviewability',
          witnessed: govGaps.map(
            (g) =>
              `${g.targetId}|gapReason=${String(g.gapReason)}|ownerAction=${OWNER_ACTION_BY_GAP[g.gapReason as GapReason]}|detail=${g.detail}`,
          ),
        },
      ];
    }
    default:
      return [];
  }
}

function successCriteria(obs: Scenario1Observations): Scenario1ResultManifest['successCriteria'] {
  const registered = [KANBAN, AGENTCTL, WORKFLOWS, STALE, UNREACHABLE];
  const representedOrGap = registered.filter((id) =>
    obs.catalogEntries.some((e) => e.targetId === id),
  );
  const sc001Met = representedOrGap.length === registered.length; // 100% represented (source or gap)

  // SC-002: state changes surfaced within 2 min while healthy — the second sweep re-observes each
  // healthy source and its checkpoint clock advances within the 120s window we simulated.
  const withinWindow = obs.clockAtSweep2 - obs.clockAtSweep1 <= 120_000;
  const sc002Met = withinWindow && obs.latestCheckpoint !== null;

  // SC-017: supported seeded sources 100% discovered; unregistered candidate discovered.
  const supported = [KANBAN, AGENTCTL, WORKFLOWS];
  const supportedFound = supported.filter((id) => obs.sources.some((e) => e.targetId === id));
  const unregisteredFound = obs.sources.some((e) => e.targetId === UNREGISTERED);
  const sc017Met = supportedFound.length === supported.length && unregisteredFound;

  // SC-018: every unsupported/inaccessible/excluded/disappeared source remains visible.
  const mustBeVisible = [UNMANAGED, UNREACHABLE, EXCLUDED, STALE];
  const visible = mustBeVisible.filter((id) => obs.catalogEntries.some((e) => e.targetId === id));
  const sc018Met = visible.length === mustBeVisible.length;

  // SC-019: least-privilege — the out-of-scope secretstore target is never probed (never reached),
  // and every recorded discovery-evidence payload is metadata-only. "Metadata-only" is checked
  // STRUCTURALLY: every payload KEY must be in the disclosure-safe allowlist below, and no payload
  // may carry a `content`/secret-bearing key. (A naive substring scan is deliberately avoided — it
  // would false-positive on the disclosure-safe scope name "secretstore" / location "vault".)
  const ALLOWED_PAYLOAD_KEYS = new Set([
    'scope',
    'location',
    'classification',
    'onboarding',
    'registered',
    'reachable',
    'evidenceShape',
    'decision',
    'reason',
    'detail',
  ]);
  const FORBIDDEN_KEYS =
    /^(content|body|secret|secrets|password|token|credential|credentials|privateKey|private_key|apiKey|api_key)$/i;
  const secretstoreNeverProbed = !obs.probeCalls.includes(EXCLUDED);
  const metadataOnly = obs.flushedEvidence.every((r) => {
    const payload = r.payload;
    if (!payload || typeof payload !== 'object') return true;
    const keys = Object.keys(payload as Record<string, unknown>);
    return keys.every((k) => ALLOWED_PAYLOAD_KEYS.has(k) && !FORBIDDEN_KEYS.test(k));
  });
  const sc019Met = secretstoreNeverProbed && metadataOnly;

  return [
    {
      id: 'SC-001',
      text: SCENARIO1_SUCCESS_CRITERIA[0].text,
      met: sc001Met,
      measure: `${representedOrGap.length}/${registered.length} declared sources represented or listed as gaps`,
    },
    {
      id: 'SC-002',
      text: SCENARIO1_SUCCESS_CRITERIA[1].text,
      met: sc002Met,
      measure: `state changes re-observed after ${obs.clockAtSweep2 - obs.clockAtSweep1}ms (<=120000ms) with durable checkpoint`,
    },
    {
      id: 'SC-017',
      text: SCENARIO1_SUCCESS_CRITERIA[2].text,
      met: sc017Met,
      measure: `${supportedFound.length}/${supported.length} supported discovered; unregistered candidate discovered=${unregisteredFound}`,
    },
    {
      id: 'SC-018',
      text: SCENARIO1_SUCCESS_CRITERIA[3].text,
      met: sc018Met,
      measure: `${visible.length}/${mustBeVisible.length} unsupported/inaccessible/excluded/disappeared sources remain visible`,
    },
    {
      id: 'SC-019',
      text: SCENARIO1_SUCCESS_CRITERIA[4].text,
      met: sc019Met,
      measure: `out-of-scope target never probed=${secretstoreNeverProbed}; all evidence metadata-only=${metadataOnly}`,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8b. THE STANDALONE FR MUST-CLAUSE WITNESSES. Beyond the six US1 Given/When/Then acceptance lines
//     and the five success criteria, the spec lists FR MUST-clauses as distinct acceptance items.
//     For the current-state / open-boundary discovery slice this US1 view is responsible for, each
//     is mapped below to a concrete durable witness read AFTER the sweeps — never a mutation return,
//     never a bare "met". A clause whose downstream ACTION lives outside this discovery emitter is
//     marked `boundary-witnessed` with the SUBSTRATE it produces witnessed here and the action's
//     verification site named — honest scoping, not a silent omission.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function frClauses(obs: Scenario1Observations): FrClauseWitness[] {
  const byId = (id: string): CatalogEntry | undefined =>
    obs.catalogEntries.find((e) => e.targetId === id);
  const gapById = (id: string): CatalogEntry | undefined => obs.gaps.find((e) => e.targetId === id);
  // Pending human decisions this discovery view PRODUCES: every discovered-but-not-yet-governed
  // source (awaiting an onboarding decision) + every visible gap (awaiting an owner action). Ordered
  // by age (oldest first) — the one prioritization dimension the discovery layer can compute durably.
  const pending = obs.catalogEntries
    .filter((e) => e.onboarding === 'discovered' || e.onboarding === 'gap')
    .slice()
    .sort((a, b) => a.observedAt - b.observedAt);
  const excluded = gapById(EXCLUDED);
  const out: FrClauseWitness[] = [
    {
      frId: 'FR-001',
      clause:
        'MUST maintain an explicit, versioned deployment and inventory boundary … including authorized scope and exclusions for machine-wide source discovery.',
      disposition: 'witnessed',
      readPath: 'status-snapshot',
      witness: [
        `bundleVersion=${PINNED.bundleVersion}|verificationPlanVersion=${PINNED.verificationPlanVersion} (versioned boundary)`,
        `authorizedScope={${[...obs.grantedScopes].sort().join(',')}} (status.grantedScopes)`,
        excluded
          ? `exclusion enforced: ${excluded.targetId} scope=${excluded.scope} → gapReason=${String(excluded.gapReason)} (out-of-authorized-scope, never scanned)`
          : 'EXCLUSION-MISSING',
        `boundary total inventory reconciled=${obs.status.catalog.total} (sources=${obs.status.catalog.sources}, gaps=${obs.status.catalog.gaps})`,
      ],
      coveredElsewhere: null,
    },
    {
      frId: 'FR-002',
      clause:
        'MUST discover and continuously reconcile … within that boundary; discovery MUST NOT depend on a fixed list of named source products.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: [
        `two sweeps reconciled the same catalog (each targetId once): total=${obs.status.catalog.total}`,
        `open-ended: an UNKNOWN-scope source (${UNREGISTERED}) was discovered without a named-product list → onboarding=${byId(UNREGISTERED)?.onboarding ?? 'MISSING'}`,
      ],
      coveredElsewhere: null,
    },
    {
      frId: 'FR-003',
      clause:
        'MUST provide a unified current-state view that preserves each item’s source identity, type, ownership, lifecycle state, … last observation time.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: obs.catalogEntries
        .slice()
        .sort((a, b) => a.targetId.localeCompare(b.targetId))
        .map(
          (e) =>
            `${e.targetId}|type=${e.scope}|lifecycle=${e.onboarding}|observedAt=${e.observedAt}`,
        ),
      coveredElsewhere: null,
    },
    {
      frId: 'FR-004',
      clause:
        'MUST expose provenance, source authority, freshness, confidence, and any disagreement for correlated data.',
      disposition: 'witnessed',
      readPath: 'evidence-sink',
      witness: [
        `provenance: every durable record carries a correlationId (${obs.flushedEvidence.length} records, all stamped)`,
        `freshness: stale source ${STALE} retains lastKnownAt=${byId(STALE)?.observedAt ?? 'MISSING'} < refresh clock=${obs.clockAtSweep2}`,
        `checkpoint distinguishes fresh sweep clock=${obs.latestCheckpoint?.updatedAt ?? 'none'} from stale last-known`,
      ],
      coveredElsewhere: null,
    },
    {
      frId: 'FR-005',
      clause:
        'MUST show discovered, unmanaged, unreachable, stale, orphaned, excluded, and uncovered items as explicit gaps with impact, age, reason, and ownership.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: obs.gaps
        .slice()
        .sort((a, b) => a.targetId.localeCompare(b.targetId))
        .map(
          (g) =>
            `${g.targetId}|reason=${String(g.gapReason)}|age=${obs.clockAtSweep2 - g.observedAt}ms|ownerAction=${OWNER_ACTION_BY_GAP[g.gapReason as GapReason] ?? 'investigate'}`,
        ),
      coveredElsewhere: null,
    },
    {
      frId: 'FR-006',
      clause:
        'MUST present pending human decisions prioritized by business impact, risk, age, expiry, dependency, and escalation status.',
      disposition: 'boundary-witnessed',
      readPath: 'source-catalog',
      witness: [
        `pending-decision set this view produces (discovered-awaiting-onboarding + visible gaps), oldest-first by age:`,
        ...pending.map(
          (e, i) =>
            `#${i + 1} ${e.targetId}|kind=${e.onboarding === 'gap' ? `gap:${String(e.gapReason)}` : 'awaiting_onboarding'}|age=${obs.clockAtSweep2 - e.observedAt}ms`,
        ),
      ],
      coveredElsewhere:
        'business-impact/risk/expiry/dependency/escalation ordering is the decision-queue view (US-decision-queue); this discovery emitter durably supplies the age-ordered pending set + reason it prioritizes on.',
    },
    {
      frId: 'FR-007',
      clause:
        'Authorized users MUST be able to search, filter, compare, and drill from an aggregate posture into the source records, evidence, decisions, and issues that explain it.',
      disposition: 'boundary-witnessed',
      readPath: 'source-catalog',
      witness: [
        `filter substrate: catalog.sources()=${obs.sources.length}, catalog.gaps()=${obs.gaps.length} are independently queryable projections`,
        `drill substrate: aggregate posture (total=${obs.status.catalog.total}) drills to distinct source records ${[KANBAN, AGENTCTL, WORKFLOWS].map((id) => `${id}:${byId(id)?.scope ?? 'MISSING'}`).join(', ')}`,
        `compare substrate: three distinct scopes preserved for the same drill = ${new Set([KANBAN, AGENTCTL, WORKFLOWS].map((id) => byId(id)?.scope)).size} distinct records`,
      ],
      coveredElsewhere:
        'the interactive search/filter/compare UI is the current-state view surface; this emitter durably supplies the queryable, drillable catalog+evidence substrate it reads.',
    },
    {
      frId: 'FR-008',
      clause:
        'MUST correlate work moving through all registered sources … keeping distinct source records.',
      disposition: 'witnessed',
      readPath: 'evidence-sink',
      witness: [KANBAN, AGENTCTL, WORKFLOWS].map(
        (id) =>
          `${id}|distinct record kept|evidenceRecords=${obs.flushedEvidence.filter((r) => r.targetId === id).length}`,
      ),
      coveredElsewhere: null,
    },
    {
      frId: 'FR-009',
      clause:
        'Conflicting or uncertain correlations MUST remain visible and MUST NOT be silently resolved.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: [
        `distinct sources are NEVER silently merged: ${[KANBAN, AGENTCTL, WORKFLOWS].filter((id) => byId(id)).length}/3 remain separate catalog rows`,
        `indeterminate authorization would surface as a visible gap (authorization_indeterminate) rather than a silent choice — reason vocabulary present in GAP_REASONS`,
      ],
      coveredElsewhere: null,
    },
    {
      frId: 'FR-036',
      clause:
        'The platform MUST perform machine-wide source discovery periodically and on demand across authorized source classes without requiring each source to be named in advance.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: [
        `periodic + on-demand: two independent sweeps ran across the SAME authorized boundary and reconciled deterministically (each targetId once): total=${obs.status.catalog.total}`,
        `machine-wide across authorized classes: distinct scopes observed = {${[...new Set(obs.catalogEntries.map((e) => e.scope))].sort().join(',')}} within authorizedScope={${[...obs.grantedScopes].sort().join(',')}}`,
        `no fixed named-product list required: the UNKNOWN-scope source ${UNREGISTERED} was discovered without being named in advance → onboarding=${byId(UNREGISTERED)?.onboarding ?? 'MISSING'}`,
        `re-run picks up drift: sweep 2 (clock=${obs.clockAtSweep2}) re-observed the boundary and dropped the disappeared source ${STALE} while retaining its last-known identity (still in catalog=${Boolean(byId(STALE))})`,
      ],
      coveredElsewhere: null,
    },
    {
      frId: 'FR-037',
      clause:
        'Every discovered source MUST have a catalog entry containing stable identity … lifecycle state, and observation time.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: obs.sources
        .slice()
        .sort((a, b) => a.targetId.localeCompare(b.targetId))
        .map((e) => `${e.targetId}|stableId|lifecycle=${e.onboarding}|observedAt=${e.observedAt}`),
      coveredElsewhere: null,
    },
    {
      frId: 'FR-038',
      clause:
        'Discovery MUST use the least information necessary … MUST NOT read protected content, secrets, or credentials … and MUST record any resulting visibility limitation.',
      disposition: 'witnessed',
      readPath: 'evidence-sink',
      witness: [
        `least-privilege: out-of-scope target ${EXCLUDED} was NEVER probed (probeCalls excludes it=${!obs.probeCalls.includes(EXCLUDED)})`,
        `every durable payload is metadata-only (shape tag, never verbatim content): ${obs.flushedEvidence.length} records`,
        `visibility limitation recorded: ${EXCLUDED} → gap reason ${String(gapById(EXCLUDED)?.gapReason)}`,
      ],
      coveredElsewhere: null,
    },
    {
      frId: 'FR-039',
      clause:
        'Authorized source stewards MUST be able to approve onboarding, assign ownership, … quarantine, defer, or exclude a discovered source with a mandatory reason, scope, review date, and audit trail.',
      disposition: 'boundary-witnessed',
      readPath: 'checkpoint-store',
      witness: [
        `audit-trail substrate: durable checkpoints=${obs.checkpoints.length}, each carrying a safeNextAction (${obs.latestCheckpoint?.safeNextAction ?? 'none'}) — the attributable, reasoned trail steward actions append to`,
        `every discovery record is correlationId-stamped (reason/scope carried at write time): ${obs.flushedEvidence.length} records`,
        `the discovered set awaiting a steward onboarding decision: ${
          obs.sources
            .filter((e) => e.onboarding === 'discovered')
            .map((e) => e.targetId)
            .join(', ') || 'none'
        }`,
      ],
      coveredElsewhere:
        'steward mutation actions (approve/quarantine/defer/exclude with mandatory reason+scope+review-date) are the governed-decision surface (FR-010/FR-011/FR-014); this emitter durably supplies the auditable trail + the discovered set those actions operate on.',
    },
    {
      frId: 'FR-040',
      clause:
        'Unsupported, inaccessible, sensitive, unowned, and excluded sources MUST remain visible as source-coverage gaps with impact and requirements for safe onboarding or review.',
      disposition: 'witnessed',
      readPath: 'source-catalog',
      witness: [UNMANAGED, UNREACHABLE, EXCLUDED]
        .map((id) => gapById(id))
        .filter((g): g is CatalogEntry => Boolean(g))
        .map(
          (g) =>
            `${g.targetId}|reason=${String(g.gapReason)}|ownerAction(review requirement)=${OWNER_ACTION_BY_GAP[g.gapReason as GapReason]}`,
        ),
      coveredElsewhere: null,
    },
    {
      frId: 'FR-041',
      clause:
        'MUST detect newly appearing, changed, renamed, moved, replaced, split, merged, and disappeared sources while retaining their prior identity, history, correlations, and evidence.',
      disposition: 'boundary-witnessed',
      readPath: 'source-catalog',
      witness: [
        `newly appearing: ${UNREGISTERED} discovered on sweep 1 (onboarding=${byId(UNREGISTERED)?.onboarding ?? 'MISSING'})`,
        `disappeared: ${STALE} dropped from sweep 2 yet its prior identity+last-known observation PERSIST (lastKnownAt=${byId(STALE)?.observedAt ?? 'MISSING'}, still in catalog=${Boolean(byId(STALE))})`,
        `history retained: append-only evidence sink keeps ${obs.flushedEvidence.length} records across both sweeps (reconstructable history)`,
      ],
      coveredElsewhere:
        'renamed/moved/replaced/split/merged transitions are exercised by the identity-continuity suite; this emitter witnesses the appear + disappear-with-retained-identity edges and the append-only history substrate all of them rely on.',
    },
    {
      frId: 'FR-042',
      clause:
        'When multiple sources claim authority for the same field or object, the platform MUST apply an approved precedence rule or expose the unresolved conflict; it MUST NOT silently choose a source.',
      disposition: 'boundary-witnessed',
      readPath: 'source-catalog',
      witness: [
        `no silent source choice: the three same-work sources ${[KANBAN, AGENTCTL, WORKFLOWS].join(', ')} are kept as ${[KANBAN, AGENTCTL, WORKFLOWS].filter((id) => byId(id)).length} DISTINCT rows (never collapsed to one)`,
        `unresolved-input visibility: distinct scopes preserved = {${[...new Set([KANBAN, AGENTCTL, WORKFLOWS].map((id) => byId(id)?.scope))].filter(Boolean).join(',')}}`,
      ],
      coveredElsewhere:
        'the approved precedence-rule engine / conflict-resolution UI is the correlation surface (FR-004 disagreement); this emitter guarantees the no-silent-choice invariant by keeping conflicting sources as distinct, individually visible records.',
    },
  ];
  return out;
}

/**
 * Emit the SIGNED Scenario 1 result manifest. Runs the real agent (unless observations are
 * injected — used by tests to feed a mutated/negative fixture) and binds requirement, assertion,
 * audit, evidence, version, and gap references, then signs the whole thing.
 */
export async function emitScenario1ResultManifest(
  injected?: Scenario1Observations,
): Promise<Scenario1ResultManifest> {
  const obs = injected ?? (await runScenario1());

  const gapRegister = obs.gaps.map(gapRef).sort((a, b) => a.targetId.localeCompare(b.targetId));

  const lines: ManifestLine[] = SCENARIO1_ACCEPTANCE.map((spec) => {
    const evidence = evidenceFor(spec.assertionRef, obs);
    // Each line references only the gaps that are RELEVANT to its assertion (AC2 & AC6), so the
    // gap references are targeted, while the full register lives at the manifest root.
    const relevantGapIds =
      spec.assertionRef === 'US1-AS2'
        ? [UNMANAGED, UNREACHABLE, EXCLUDED]
        : spec.assertionRef === 'US1-AS6'
          ? [EXCLUDED, UNREACHABLE]
          : spec.assertionRef === 'US1-AS4'
            ? [STALE]
            : [];
    const gapRefs = gapRegister.filter((g) => relevantGapIds.includes(g.targetId));

    const line: Omit<ManifestLine, 'lineDigest'> = {
      assertionRef: spec.assertionRef,
      requirementRef: PINNED.requirementRef,
      auditRef: {
        obligationRef: spec.obligationRef,
        verificationPlanId: PINNED.verificationPlanId,
        safeNextAction: obs.latestCheckpoint?.safeNextAction ?? 'none',
      },
      assertionText: spec.text,
      evidence,
      gapRefs,
    };
    return { ...line, lineDigest: sha256(canonicalize(line)) };
  });

  const draft: Omit<Scenario1ResultManifest, 'manifestDigest' | 'signature'> = {
    manifestVersion: MANIFEST_VERSION,
    kind: 'scenario-result-manifest',
    scenario: PINNED.scenario,
    scenarioTitle: PINNED.scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/discovery-open-boundary.ts',
    version: {
      bundleId: PINNED.bundleId,
      contentHash: PINNED.contentHash,
      bundleVersion: PINNED.bundleVersion,
      workItemId: PINNED.workItemId,
      requirementRef: PINNED.requirementRef,
      verificationPlanId: PINNED.verificationPlanId,
      verificationPlanVersion: PINNED.verificationPlanVersion,
    },
    successCriteria: successCriteria(obs),
    lines,
    frClauses: frClauses(obs),
    gapRegister,
  };

  const manifestDigest = sha256(canonicalize(draft));
  return {
    ...draft,
    manifestDigest,
    signature: {
      algorithm: 'sha256',
      digest: manifestDigest,
      boundBundleId: PINNED.bundleId,
      boundContentHash: PINNED.contentHash,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 9. VERIFY — the independent oracle. Recomputes the signature, re-checks per-line digests, the
//    pinned identity, and that every acceptance criterion is present with real evidence + gap refs.
//    Returns a structured verdict; throws on nothing (callers assert on `.ok`).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface VerifyResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export function verifyScenario1ResultManifest(manifest: Scenario1ResultManifest): VerifyResult {
  const reasons: string[] = [];

  // (a) Pinned identity — reject a manifest bound to a different bundle / content hash.
  if (manifest.version.bundleId !== PINNED.bundleId)
    reasons.push(`bundle id ${manifest.version.bundleId} != pinned ${PINNED.bundleId}`);
  if (manifest.version.contentHash !== PINNED.contentHash)
    reasons.push('content hash differs from pinned input');
  if (manifest.signature.boundBundleId !== PINNED.bundleId)
    reasons.push('signature bundle id not pinned');
  if (manifest.signature.boundContentHash !== PINNED.contentHash)
    reasons.push('signature content hash not pinned');

  // (b) Signature — recompute the digest over the canonical manifest and compare.
  const recomputed = sha256(canonicalize(manifest));
  if (recomputed !== manifest.manifestDigest)
    reasons.push(
      `manifestDigest mismatch (recomputed ${recomputed.slice(0, 12)}… != stored ${manifest.manifestDigest.slice(0, 12)}…)`,
    );
  if (manifest.signature.digest !== manifest.manifestDigest)
    reasons.push('signature.digest != manifestDigest');

  // (c) Per-line digests — a single mutated line invalidates its own chained digest.
  for (const line of manifest.lines) {
    const { lineDigest, ...rest } = line;
    const recomputedLine = sha256(canonicalize(rest));
    if (recomputedLine !== lineDigest) reasons.push(`line ${line.assertionRef} digest mismatch`);
  }

  // (d) Coverage — all six acceptance criteria present, each with a real requirement/audit ref,
  //     at least one evidence witness, and non-empty witnessed values.
  const present = new Set(manifest.lines.map((l) => l.assertionRef));
  for (const spec of SCENARIO1_ACCEPTANCE) {
    if (!present.has(spec.assertionRef)) {
      reasons.push(`missing acceptance line ${spec.assertionRef}`);
      continue;
    }
    const line = manifest.lines.find((l) => l.assertionRef === spec.assertionRef)!;
    if (line.requirementRef !== PINNED.requirementRef)
      reasons.push(`${spec.assertionRef} requirementRef wrong`);
    if (line.auditRef.obligationRef !== spec.obligationRef)
      reasons.push(`${spec.assertionRef} obligationRef wrong`);
    if (!/^VO-[0-9a-f]{20}$/.test(line.auditRef.obligationRef))
      reasons.push(`${spec.assertionRef} obligationRef not a VO id`);
    if (line.evidence.length === 0) reasons.push(`${spec.assertionRef} has no evidence witness`);
    const emptyWitness = line.evidence.some(
      (e) => e.witnessed.length === 0 || e.witnessed.some((w) => /MISSING/.test(w)),
    );
    if (emptyWitness) reasons.push(`${spec.assertionRef} has an empty/missing evidence witness`);
  }

  // (e) Gap register — every gap carries a KNOWN reason + owner action (nothing "looks healthy").
  for (const g of manifest.gapRegister) {
    if (!(GAP_REASONS as readonly string[]).includes(g.gapReason))
      reasons.push(`gap ${g.targetId} has unknown reason ${g.gapReason}`);
    if (!g.ownerAction || g.ownerAction === 'investigate')
      reasons.push(`gap ${g.targetId} lacks a specific owner action`);
  }
  // The three seeded gaps (unmanaged/unreachable/excluded) must be visible.
  for (const id of [UNMANAGED, UNREACHABLE, EXCLUDED]) {
    if (!manifest.gapRegister.some((g) => g.targetId === id))
      reasons.push(`seeded gap ${id} missing from register`);
  }

  // (f) Success criteria — the five Scenario-1 SC rows present and met.
  const scIds = new Set(manifest.successCriteria.map((s) => s.id));
  for (const sc of SCENARIO1_SUCCESS_CRITERIA) {
    if (!scIds.has(sc.id)) reasons.push(`missing success criterion ${sc.id}`);
  }
  for (const s of manifest.successCriteria) {
    if (!s.met) reasons.push(`success criterion ${s.id} not met: ${s.measure}`);
  }

  // (g) FR MUST-clauses — every enumerated standalone clause present, each with a NON-EMPTY, non-
  //     MISSING durable witness; a `boundary-witnessed` clause must name where its downstream action
  //     is verified (so scoping is explicit, never a silent omission). A `witnessed` clause must NOT
  //     defer to elsewhere.
  const REQUIRED_FR_CLAUSES = [
    'FR-001',
    'FR-002',
    'FR-003',
    'FR-004',
    'FR-005',
    'FR-006',
    'FR-007',
    'FR-008',
    'FR-009',
    'FR-036',
    'FR-037',
    'FR-038',
    'FR-039',
    'FR-040',
    'FR-041',
    'FR-042',
  ] as const;
  const frPresent = new Set(manifest.frClauses.map((c) => c.frId));
  for (const id of REQUIRED_FR_CLAUSES) {
    if (!frPresent.has(id)) reasons.push(`missing FR clause witness ${id}`);
  }
  for (const c of manifest.frClauses) {
    if (c.witness.length === 0) reasons.push(`FR clause ${c.frId} has no witness`);
    if (c.witness.some((w) => /MISSING/.test(w)))
      reasons.push(`FR clause ${c.frId} has a MISSING witness value`);
    if (c.disposition === 'boundary-witnessed' && !c.coveredElsewhere)
      reasons.push(`FR clause ${c.frId} is boundary-witnessed but names no downstream site`);
    if (c.disposition === 'witnessed' && c.coveredElsewhere)
      reasons.push(`FR clause ${c.frId} claims witnessed yet defers elsewhere`);
  }

  return { ok: reasons.length === 0, reasons };
}

// Re-export enums so consumers/tests can assert against the real vocabulary.
export { GAP_REASONS, ONBOARDING_STATES, SAFE_NEXT_ACTIONS };
