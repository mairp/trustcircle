// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — ECOSYSTEM HEALTH (browserless Playwright `ecosystem-health` project · T226).
// Requirements FR-008 · FR-027–FR-030 · FR-036–FR-042 · NFR-010 · SC-011 · SC-024.
// Acceptance: US6-AS1..US6-AS4 (spec.md US6 "Maintain Source and Workflow Health").
//
// This spec runs under the browserless `ecosystem-health` Playwright project (testMatch
// /ecosystem-health\.spec\.ts/). It never touches `page`; it drives the two signed-manifest scenario
// runners — tests/e2e/scenarios/connector-resilience.ts (connector outage, bounded retry, dead letter,
// replay, reconciliation, projection rebuild — FR-029/FR-030) and tests/e2e/scenarios/named-adapters.ts
// (Kanban / workflow_orchestration / agentctl / LISA / Wiggum + core-only activation — NFR-010) — each
// of which runs the REAL application/worker modules, and asserts the emitted manifests are signed,
// tamper-evident, pinned to the fixture world, and bind every acceptance concern to independent
// durable-read-path evidence and visible gap references.
//
// Journeys covered (per T226): connector outage, replay, dead letter, reconciliation, projection
// rebuild, profile (core-only) activation, and named-source drill-down. Each positive assertion is
// paired with a NEGATIVE control so the oracle is non-vacuous.
//
// Run: TC_NO_WEBSERVER=1 playwright test --project=ecosystem-health

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const resilienceMod = await import(join(ROOT, 'tests/e2e/scenarios/connector-resilience.ts'));
const namedMod = await import(join(ROOT, 'tests/e2e/scenarios/named-adapters.ts'));

const {
  emitConnectorResilienceManifest,
  verifyConnectorResilienceManifest,
  canonicalize: canonicalizeResilience,
  ACCEPTANCE,
  PINNED: RESILIENCE_PINNED,
} = resilienceMod as typeof import('./scenarios/connector-resilience.ts');

const {
  emitNamedAdaptersManifest,
  verifyNamedAdaptersManifest,
  canonicalize: canonicalizeNamed,
  PINNED: NAMED_PINNED,
  US6_AS1,
  JOURNEYS,
  projectJourneyManifest,
  verifyJourneyManifest,
} = namedMod as typeof import('./scenarios/named-adapters.ts');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const deep = <T>(o: T): T => JSON.parse(JSON.stringify(o));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A. CONNECTOR RESILIENCE — outage / bounded retry / dead letter / replay / reconciliation / rebuild.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('ecosystem health · connector resilience signed manifest (FR-029 / FR-030)', () => {
  test('emits a signed, pinned, tamper-evident manifest that verifies', () => {
    const manifest = emitConnectorResilienceManifest();

    // Signed: the stored digest equals a fresh sha256 over the canonical manifest.
    expect(sha256(canonicalizeResilience(manifest))).toBe(manifest.manifestDigest);
    expect(manifest.signature.algorithm).toBe('sha256');

    // Pinned identity (version references) — bound to the deterministic fixture world.
    expect(manifest.version.scenario).toBe(RESILIENCE_PINNED.scenario);
    expect(manifest.version.worldDigest).toBe(RESILIENCE_PINNED.worldDigest);
    expect(manifest.signature.boundWorldDigest).toBe(RESILIENCE_PINNED.worldDigest);

    // Positive: the untouched manifest verifies.
    expect(verifyConnectorResilienceManifest(manifest).ok).toBe(true);

    // NEGATIVE control: a single tampered byte breaks the signature.
    const tampered = deep(manifest);
    (tampered.lines[0].evidence[0] as { witnessed: string[] }).witnessed[0] += '_X';
    expect(sha256(canonicalizeResilience(tampered))).not.toBe(tampered.manifestDigest);
    expect(verifyConnectorResilienceManifest(tampered).ok).toBe(false);
  });

  test('binds requirement / assertion / audit references for every US6 acceptance criterion', () => {
    const manifest = emitConnectorResilienceManifest();
    expect(manifest.lines).toHaveLength(ACCEPTANCE.length);
    for (const spec of ACCEPTANCE) {
      const line = manifest.lines.find((l) => l.assertionRef === spec.assertionRef)!;
      expect(line).toBeTruthy();
      expect(line.requirementRefs.some((r) => r === 'FR-029' || r === 'FR-030')).toBe(true);
      expect(line.auditRef.obligationRef).toBe(spec.obligationRef);
      expect(line.assertionText).toBe(spec.text);
      expect(line.evidence.length).toBeGreaterThanOrEqual(1);
    }

    // NEGATIVE control: removing an acceptance line fails verification.
    const missing = deep(manifest);
    missing.lines = missing.lines.filter((l) => l.assertionRef !== 'US6-AS3');
    const v = verifyConnectorResilienceManifest(missing);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /missing acceptance line US6-AS3/.test(r))).toBe(true);
  });

  test('outage retries under the SAME idempotency key; terminal + exhausted STOP (bounded)', () => {
    const manifest = emitConnectorResilienceManifest();
    const as2 = manifest.lines.find((l) => l.assertionRef === 'US6-AS2')!;
    const retryWitness = as2.evidence.find((e) => e.readPath === 'retry-decision')!;
    // Bounded retry: transient retries with a real next-attempt; terminal + exhausted stop.
    expect(retryWitness.witnessed.some((w) => /transient: action=retry\|key=op-outage-42/.test(w))).toBe(true);
    expect(retryWitness.witnessed.some((w) => /terminal\(unauthorized\): action=stop/.test(w))).toBe(true);
    expect(retryWitness.witnessed.some((w) => /exhausted\(5\/5\): action=stop/.test(w))).toBe(true);
  });

  test('dead letter preserves the terminal message + refuses replay without authority (FR-030)', () => {
    const manifest = emitConnectorResilienceManifest();
    const as2 = manifest.lines.find((l) => l.assertionRef === 'US6-AS2')!;
    const dl = as2.evidence.find((e) => e.readPath === 'dead-letter-record')!;
    expect(dl.witnessed.some((w) => /replayState=held/.test(w))).toBe(true);
    expect(dl.witnessed.some((w) => /replay-without-authority-refused=true/.test(w))).toBe(true);
    expect(dl.witnessed.some((w) => /authorized: replayState=authorized/.test(w))).toBe(true);
  });

  test('replay reduces to exactly-one effect AND the projection rebuild is order-independent (SC-011)', () => {
    const manifest = emitConnectorResilienceManifest();
    const as3 = manifest.lines.find((l) => l.assertionRef === 'US6-AS3')!;
    const ingestion = as3.evidence.filter((e) => e.readPath === 'ingestion-state');
    expect(
      ingestion.some((e) => e.witnessed.some((w) => /onceDigest===twiceDigest → true/.test(w))),
    ).toBe(true);
    expect(
      ingestion.some((e) => e.witnessed.some((w) => /forwardDigest===rebuiltDigest → true/.test(w))),
    ).toBe(true);

    // The SC-011 success criterion is present and met.
    const sc = manifest.successCriteria.find((s) => s.id === 'SC-011')!;
    expect(sc.met).toBe(true);
  });

  test('reconciliation keeps conflict visible (resolved=false) and automation pauses safely', () => {
    const manifest = emitConnectorResilienceManifest();
    const as4 = manifest.lines.find((l) => l.assertionRef === 'US6-AS4')!;
    const run = as4.evidence.find((e) => e.readPath === 'reconciliation-run')!;
    expect(run.witnessed.some((w) => /cleanRun:.*resolved=true/.test(w))).toBe(true);
    expect(run.witnessed.some((w) => /driftedRun:.*resolved=false/.test(w))).toBe(true);

    // NEGATIVE control: forge the drifted run as resolved → conflict-visibility witness breaks.
    const forged = deep(manifest);
    const line = forged.lines.find((l) => l.assertionRef === 'US6-AS4')!;
    const w = line.evidence.find((e) => e.readPath === 'reconciliation-run')!;
    w.witnessed = w.witnessed.map((s) => s.replace(/driftedRun:(.*)resolved=false/, 'driftedRun:$1resolved=true'));
    const v = verifyConnectorResilienceManifest(forged);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /US6-AS4 does not witness the conflict staying visible/.test(r))).toBe(true);
  });

  test('every surfaced anomaly / drift stays visible with a specific owner action (gap register)', () => {
    const manifest = emitConnectorResilienceManifest();
    expect(manifest.gapRegister.length).toBeGreaterThan(0);
    for (const g of manifest.gapRegister) {
      expect(g.ownerAction).toBeTruthy();
      expect(g.ownerAction).not.toBe('investigate');
    }
    // The recovered backlog surfaces duplicate + gap + mapping + source-identity drift.
    const kinds = new Set(manifest.gapRegister.map((g) => g.kind));
    expect(kinds.has('duplicate')).toBe(true);
    expect(kinds.has('backlog_gap')).toBe(true);
    expect(kinds.has('mapping_change')).toBe(true);
    expect(kinds.has('source_identity_change')).toBe(true);
    // And reconciliation surfaces the conflicting drift.
    expect(kinds.has('conflicting')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// B. NAMED ADAPTERS + CORE-ONLY ACTIVATION — profile activation + named-source drill-down.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('ecosystem health · named adapters + core-only activation signed manifest (NFR-010)', () => {
  test('emits a signed, pinned, tamper-evident manifest that verifies', () => {
    const manifest = emitNamedAdaptersManifest();

    expect(sha256(canonicalizeNamed(manifest))).toBe(manifest.manifestDigest);
    expect(manifest.signature.algorithm).toBe('sha256');
    expect(manifest.version.scenario).toBe(NAMED_PINNED.scenario);
    expect(manifest.version.worldDigest).toBe(NAMED_PINNED.worldDigest);

    expect(verifyNamedAdaptersManifest(manifest).ok).toBe(true);

    // NEGATIVE control: a tampered adapter evidence witness breaks the signature.
    const tampered = deep(manifest);
    (tampered.adapterLines[0].evidence[0] as { witnessed: string[] }).witnessed[0] += '_X';
    expect(sha256(canonicalizeNamed(tampered))).not.toBe(tampered.manifestDigest);
    expect(verifyNamedAdaptersManifest(tampered).ok).toBe(false);
  });

  test('drills into all FIVE named sources; NONE is granted governance authority (SC-024)', () => {
    const manifest = emitNamedAdaptersManifest();
    const ids = manifest.adapterLines.map((l) => l.runnerRef).sort();
    expect(ids).toEqual([...NAMED_PINNED.namedAdapters].sort());
    for (const line of manifest.adapterLines) {
      expect(line.assertionRef).toBe(US6_AS1.assertionRef);
      expect(line.grantsGovernanceAuthority).toBe(false);
      // Least-privilege drill-down: the negotiated capability set is witnessed + refusal proven.
      const sdk = line.evidence.find((e) => e.readPath === 'adapter-sdk-verdict')!;
      expect(sdk.witnessed.some((w) => /undeclared refused=true/.test(w))).toBe(true);
      expect(sdk.witnessed.some((w) => /driftedMajor=false/.test(w))).toBe(true);
    }

    // NEGATIVE control: pretend an adapter grants authority → invariant breach detected.
    const forged = deep(manifest);
    forged.adapterLines[0].grantsGovernanceAuthority = true;
    const v = verifyNamedAdaptersManifest(forged);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /GRANTS governance authority/.test(r))).toBe(true);
  });

  test('only the CORE profile runs continuously; every named connector is intentionally_inactive (NFR-010)', () => {
    const manifest = emitNamedAdaptersManifest();
    const core = manifest.coreActivation;
    expect(core.requirementRefs).toContain('NFR-010');

    // Proof-before-active: core reaches active only when proven; readiness is core-only.
    const lifecycle = core.evidence.filter((e) => e.readPath === 'component-lifecycle');
    expect(
      lifecycle.some((e) =>
        e.witnessed.some((w) => /core activated:.*activationState=active\|runtimeState=active/.test(w)),
      ),
    ).toBe(true);
    const inactive = lifecycle.find((e) => e.detail.includes('optional/on-demand'))!;
    expect(inactive.witnessed.every((w) => /=intentionally_inactive$/.test(w))).toBe(true);

    const readiness = core.evidence.find((e) => e.readPath === 'readiness-verdict')!;
    expect(readiness.witnessed.some((w) => /verdict=ready\|coreHealthy=true/.test(w))).toBe(true);

    // NEGATIVE control: forge core-active witness away → proof-before-active witness breaks.
    const forged = deep(manifest);
    const w = forged.coreActivation.evidence.find((e) => e.readPath === 'component-lifecycle')!;
    w.witnessed = w.witnessed.map((s) => s.replace(/runtimeState=active/, 'runtimeState=stale'));
    const v = verifyNamedAdaptersManifest(forged);
    expect(v.ok).toBe(false);
  });

  test('every intentionally-inactive named source stays a visible gap with a specific owner action', () => {
    const manifest = emitNamedAdaptersManifest();
    expect(manifest.gapRegister.length).toBe(NAMED_PINNED.namedAdapters.length);
    for (const g of manifest.gapRegister) {
      expect(g.runtimeState).toBe('intentionally_inactive');
      expect(g.ownerAction).toBe('owner_approved_activation_to_enable');
    }
    const sc = manifest.successCriteria.find((s) => s.id === 'SC-024')!;
    expect(sc.met).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// C. PER-JOURNEY EVIDENCE (T272) — Scenario 9 / Scenario 10 / core-only profile are DISTINCT signed
//    artifacts, not one manifest under three names. A drift in one journey cannot mask another.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('ecosystem health · distinct per-journey evidence manifests (T272)', () => {
  test('each journey is a distinct, signed, independently-verifying artifact', () => {
    const full = emitNamedAdaptersManifest();
    for (const spec of JOURNEYS) {
      const m = projectJourneyManifest(spec, full);
      // Signed: stored digest equals a fresh canonical sha256.
      expect(sha256(canonicalizeNamed(m))).toBe(m.manifestDigest);
      expect(m.signature.boundJourney).toBe(spec.scope);
      expect(m.journeyScope).toBe(spec.scope);
      // Scope shape: exactly the journey's adapters; core line iff the profile journey.
      expect(m.adapterLines.map((l) => l.runnerRef).sort()).toEqual([...spec.adapters].sort());
      expect(Boolean(m.coreActivation)).toBe(spec.includesCore);
      // Independently verifies.
      expect(verifyJourneyManifest(m).ok).toBe(true);
    }
  });

  test('the three journey digests are pairwise DISTINCT (per-journey, not a shared copy)', () => {
    const full = emitNamedAdaptersManifest();
    const digests = JOURNEYS.map((j) => projectJourneyManifest(j, full).manifestDigest);
    expect(new Set(digests).size).toBe(digests.length);
    // Concrete: Kanban journey digest ≠ workflow/agentctl journey digest ≠ profile journey digest.
    const byScope = new Map(JOURNEYS.map((j) => [j.scope, projectJourneyManifest(j, full).manifestDigest]));
    expect(byScope.get('scenario-9-kanban-projection')).not.toBe(byScope.get('scenario-10-workflow-agentctl'));
    expect(byScope.get('scenario-9-kanban-projection')).not.toBe(byScope.get('profile-core-only-activation'));
    expect(byScope.get('scenario-10-workflow-agentctl')).not.toBe(byScope.get('profile-core-only-activation'));
  });

  test('NEGATIVE control: tampering the Kanban journey changes ONLY its digest, and fails verify', () => {
    const full = emitNamedAdaptersManifest();
    const kanban = projectJourneyManifest(JOURNEYS.find((j) => j.scope === 'scenario-9-kanban-projection')!, full);
    const wf = projectJourneyManifest(JOURNEYS.find((j) => j.scope === 'scenario-10-workflow-agentctl')!, full);

    const tampered = deep(kanban);
    (tampered.adapterLines[0].evidence[0] as { witnessed: string[] }).witnessed[0] += '_X';
    // The tamper breaks Kanban's signature…
    expect(sha256(canonicalizeNamed(tampered))).not.toBe(tampered.manifestDigest);
    expect(verifyJourneyManifest(tampered).ok).toBe(false);
    // …but the workflow/agentctl journey is untouched — a Kanban drift cannot be masked by, nor mask, it.
    expect(verifyJourneyManifest(wf).ok).toBe(true);
    expect(wf.manifestDigest).not.toBe(tampered.manifestDigest);
  });

  test('NEGATIVE control: a journey digest copied onto another scope fails verify (no shared copies)', () => {
    const full = emitNamedAdaptersManifest();
    const kanban = projectJourneyManifest(JOURNEYS.find((j) => j.scope === 'scenario-9-kanban-projection')!, full);
    // Forge: relabel the Kanban journey as the profile scope (the old byte-identical-copy defect).
    const forged = deep(kanban);
    forged.journeyScope = 'profile-core-only-activation';
    forged.signature.boundJourney = 'profile-core-only-activation';
    expect(verifyJourneyManifest(forged).ok).toBe(false);
  });
});
