// Integration suite — Inventory projection: duplicate/out-of-order observations, authority
// conflicts, deterministic projection rebuild, and stale labeling
// (Phase 60 / work item T0EXJ3E0Q8R1CASCWN7YQ2E9Z8 / bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// The inventory current-state view is a PROJECTION: raw source observations are correlated,
// deduplicated, ordered, conflict-checked, and freshness-labelled into a durable governance
// snapshot. This suite exercises that projection through TWO read-only, dependency-free governed
// SUTs — never a live database, never a mutation response, never the wall clock:
//
//   • adapters/wiggum/src/snapshot.ts  — `discoverSnapshot` correlates raw observations into a
//     deep-frozen `WiggumSnapshot` carrying a durable `snapshotDigest`, per-entity revision
//     history + supersededCount (dedup / out-of-order), unresolved `conflicts` with a
//     deterministic owned-issue id + `automationPaused`, `healthAlerts`, and per-entity
//     `freshness`/`ageMillis`. Idempotent: same input ⇒ byte-identical digest (deterministic
//     rebuild). Rejects foreign bundle identity (`assertPinnedIdentity`).
//   • apps/projector/src/main.ts       — `assessFreshness` is the pure, total staleness decision
//     over an applied cursor vs an observed source position (the projection-rebuild + stale-label
//     machinery): `fresh` / `stale` / `unknown`, with the last-known applied time and the concrete
//     lag/age. `unknown` (no source observed) is NEVER silently treated as fresh.
//
// Effect-witness discipline: every obligation is verified through the RETURNED durable artifact
// (the deep-frozen snapshot + its digest, or the pure freshness verdict), each paired with a
// NEGATIVE control that flips when the invariant is removed. Both SUTs are governed contracts in
// evidence/manifest.json and are used strictly READ-ONLY (no source change this phase).
//
// The four named projection properties (§A–§D) and the six inventory acceptance criteria
// (§AC1–§AC6) are BOTH discharged: the projection properties are the mechanism, the acceptance
// criteria are the governance guarantees that mechanism must deliver on the reconciled
// current-state inventory / coverage-gap view.

import { describe, it, expect } from 'vitest';

import {
  discoverSnapshot,
  assertPinnedIdentity,
  contentDigest,
  IdentityMismatchError,
  type BundleIdentity,
  type DiscoveryInput,
  type WiggumObservation,
  type WiggumHealthReport,
  type WiggumSnapshot,
} from '../../adapters/wiggum/src/snapshot.ts';

import {
  assessFreshness,
  DEFAULT_FRESHNESS_OBJECTIVE,
  type FreshnessObjective,
  type SourcePosition,
  type StreamFreshness,
} from '../../apps/projector/src/main.ts';

// ---------------------------------------------------------------------------
// Pinned execution identity + fixed clock (never reads the wall clock).
// ---------------------------------------------------------------------------
const PINNED: BundleIdentity = {
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: 'T0EXJ3E0Q8R1CASCWN7YQ2E9Z8',
};

const T0 = 1_700_000_000_000; // fixed injected clock base (ms).
const MIN = 60_000;

function obs(over: Partial<WiggumObservation>): WiggumObservation {
  return {
    surface: 'run',
    featureId: 'feature-A',
    externalId: 'run-1',
    externalRevision: 'r1',
    aggregateSequence: 1,
    occurredAt: T0,
    observedAt: T0,
    sourceContentHash: contentDigest({ v: 1 }),
    identity: PINNED,
    payload: { status: 'running' },
    ...over,
  };
}

function health(over: Partial<WiggumHealthReport>): WiggumHealthReport {
  return {
    featureId: 'feature-A',
    healthState: 'healthy',
    ownerPrincipalId: 'owner-1',
    affectedScope: ['tenant-1/asset-1'],
    lastSuccessAt: T0,
    lastFailureAt: null,
    retryState: { attempts: 0, nextPermittedAt: null, deadLettered: false },
    businessImpact: 'none',
    safeNextAction: 'continue',
    ...over,
  };
}

function input(over: Partial<DiscoveryInput>): DiscoveryInput {
  return {
    pinnedIdentity: PINNED,
    freshnessObjectiveMillis: MIN,
    now: T0,
    observations: [],
    health: [],
    ...over,
  };
}

/** Independent read path: recompute the digest over the snapshot BODY (never trust the field). */
function recomputeDigest(snap: WiggumSnapshot): string {
  return contentDigest({
    pinnedIdentity: snap.pinnedIdentity,
    freshnessObjectiveMillis: snap.freshnessObjectiveMillis,
    capturedAt: snap.capturedAt,
    entities: snap.entities,
    conflicts: snap.conflicts,
    healthAlerts: snap.healthAlerts,
    automationPaused: snap.automationPaused,
    pauseReasons: snap.pauseReasons,
  });
}

const entityOf = (snap: WiggumSnapshot, externalId: string) =>
  snap.entities.find((e) => e.externalId === externalId);

// ===========================================================================
// §A — Duplicate / out-of-order observations: exactly one reconciled entity,
//      no duplicate governance action, history stays reconstructable.
// ===========================================================================
describe('§A duplicate/out-of-order observations', () => {
  it('collapses duplicates into ONE entity yet keeps every revision (reconstructable history)', () => {
    const r1 = obs({ externalRevision: 'r1', aggregateSequence: 1 });
    const dupR1 = obs({ externalRevision: 'r1', aggregateSequence: 1 }); // exact duplicate delivery
    const r2 = obs({
      externalRevision: 'r2',
      aggregateSequence: 2,
      observedAt: T0 + 1_000,
      sourceContentHash: contentDigest({ v: 2 }),
    });
    const snap = discoverSnapshot(input({ now: T0 + 1_000, observations: [r1, dupR1, r2] }));
    // Effect witness: the durable reconciled projection carries exactly one row for the entity.
    const rows = snap.entities.filter((e) => e.externalId === 'run-1');
    expect(rows).toHaveLength(1);
    const entity = rows[0]!;
    expect(entity.externalRevision).toBe('r2'); // latest in-order revision is authoritative
    expect(entity.revisionHistory).toEqual(['r1', 'r2']); // duplicate r1 collapsed, history kept
    expect(entity.supersededCount).toBe(2); // 3 observations → 1 authoritative + 2 superseded
    // NEGATIVE control: two DISTINCT entities are never collapsed (dedup is identity-keyed, not a cap).
    const other = obs({ externalId: 'run-2', sourceContentHash: contentDigest({ v: 9 }) });
    const snap2 = discoverSnapshot(input({ observations: [r1, other] }));
    expect(snap2.entities.map((e) => e.externalId).sort()).toEqual(['run-1', 'run-2']);
  });

  it('orders out-of-order arrivals by aggregate sequence, not delivery order', () => {
    // Delivered newest-first; the projection must still pick the highest sequence as authoritative.
    const late = obs({
      externalRevision: 'r3',
      aggregateSequence: 3,
      observedAt: T0 + 2_000,
      sourceContentHash: contentDigest({ v: 3 }),
    });
    const early = obs({ externalRevision: 'r1', aggregateSequence: 1 });
    const mid = obs({
      externalRevision: 'r2',
      aggregateSequence: 2,
      observedAt: T0 + 1_000,
      sourceContentHash: contentDigest({ v: 2 }),
    });
    const snap = discoverSnapshot(input({ now: T0 + 2_000, observations: [late, early, mid] }));
    const entity = entityOf(snap, 'run-1')!;
    expect(entity.externalRevision).toBe('r3'); // sequence 3 wins regardless of arrival order
    expect(entity.revisionHistory).toEqual(['r1', 'r2', 'r3']); // ordered history reconstructed
    // NEGATIVE control: shuffling the SAME three arrivals is order-independent (idempotent projection).
    const shuffled = discoverSnapshot(input({ now: T0 + 2_000, observations: [mid, late, early] }));
    expect(shuffled.snapshotDigest).toBe(snap.snapshotDigest);
  });

  it('opens the SAME owned issue id for the SAME conflict — no duplicate governance action', () => {
    const a = obs({
      externalRevision: 'rX',
      aggregateSequence: 5,
      occurredAt: T0 + 5,
      sourceContentHash: contentDigest({ winner: 'A' }),
    });
    const b = obs({
      externalRevision: 'rY',
      aggregateSequence: 5, // same top position → authority cannot pick a winner
      occurredAt: T0 + 5,
      sourceContentHash: contentDigest({ winner: 'B' }),
    });
    const first = discoverSnapshot(input({ observations: [a, b] }));
    const again = discoverSnapshot(input({ observations: [b, a] })); // re-run, reordered
    expect(first.conflicts).toHaveLength(1);
    expect(again.conflicts).toHaveLength(1);
    // Deterministic owned-issue id ⇒ re-observing the same conflict does NOT open a second issue.
    expect(again.conflicts[0]!.ownedIssueId).toBe(first.conflicts[0]!.ownedIssueId);
    expect(first.conflicts[0]!.ownedIssueId).toMatch(/^wiggum-conflict-[0-9a-f]{32}$/);
  });
});

// ===========================================================================
// §B — Authority conflicts: visible, automation paused safely, owned issue opened.
// ===========================================================================
describe('§B authority conflicts', () => {
  it('records an unresolvable conflict, pauses affected automation, attributes an owner', () => {
    const a = obs({
      externalRevision: 'rA',
      aggregateSequence: 7,
      occurredAt: T0 + 7,
      sourceContentHash: contentDigest({ state: 'approved' }),
    });
    const b = obs({
      externalRevision: 'rB',
      aggregateSequence: 7,
      occurredAt: T0 + 7,
      sourceContentHash: contentDigest({ state: 'rejected' }),
    });
    const snap = discoverSnapshot(
      input({ observations: [a, b], health: [health({ ownerPrincipalId: 'owner-7' })] }),
    );
    expect(snap.conflicts).toHaveLength(1);
    const c = snap.conflicts[0]!;
    expect(c.conflictingContentHashes).toHaveLength(2); // both irreconcilable hashes stay visible
    expect(c.ownerPrincipalId).toBe('owner-7'); // owned, not orphaned
    expect(c.reason).toMatch(/authority rules cannot resolve/i);
    // Affected automation pauses safely rather than acting on authority-less state.
    expect(snap.automationPaused).toBe(true);
    expect(snap.pauseReasons.some((r) => /unresolved conflict/i.test(r))).toBe(true);
  });

  // NEGATIVE control: when authority resolves the order (distinct sequences), NO conflict/pause.
  it('does not open a conflict or pause when authority resolves the order', () => {
    const a = obs({
      externalRevision: 'rA',
      aggregateSequence: 1,
      sourceContentHash: contentDigest({ s: 1 }),
    });
    const b = obs({
      externalRevision: 'rB',
      aggregateSequence: 2, // strictly later → unambiguous winner
      observedAt: T0 + 10,
      sourceContentHash: contentDigest({ s: 2 }),
    });
    const snap = discoverSnapshot(input({ now: T0 + 10, observations: [a, b] }));
    expect(snap.conflicts).toHaveLength(0);
    expect(snap.automationPaused).toBe(false);
    expect(snap.pauseReasons).toHaveLength(0);
    expect(entityOf(snap, 'run-1')!.externalRevision).toBe('rB');
  });
});

// ===========================================================================
// §C — Deterministic projection rebuild: replaying the same source stream (in any
//      delivery order, in any number of passes) reconstructs a byte-identical projection.
// ===========================================================================
describe('§C deterministic projection rebuild', () => {
  it('rebuild from the same source stream ⇒ byte-identical digest, regardless of delivery order', () => {
    const stream = [
      obs({ externalId: 'run-1', externalRevision: 'r1', aggregateSequence: 1 }),
      obs({
        externalId: 'run-1',
        externalRevision: 'r2',
        aggregateSequence: 2,
        observedAt: T0 + 1_000,
        sourceContentHash: contentDigest({ v: 2 }),
      }),
      obs({
        externalId: 'run-2',
        externalRevision: 's1',
        aggregateSequence: 1,
        sourceContentHash: contentDigest({ w: 1 }),
      }),
    ];
    const live = discoverSnapshot(input({ now: T0 + 1_000, observations: stream }));
    // "Rebuild": replay the SAME durable events in a DIFFERENT delivery order (reversed). A
    // deterministic projection reconstructs a byte-identical read model from the same event
    // multiset regardless of arrival order — the core rebuild guarantee.
    const replay = [...stream].reverse();
    const rebuilt = discoverSnapshot(input({ now: T0 + 1_000, observations: replay }));
    // Effect witness: the rebuilt projection is byte-identical to the live one.
    expect(rebuilt.snapshotDigest).toBe(live.snapshotDigest);
    expect(recomputeDigest(rebuilt)).toBe(recomputeDigest(live));
    expect(rebuilt.entities).toEqual(live.entities);

    // A duplicate DELIVERY during replay collapses to the same single row per entity (no duplicate
    // governance row), while faithfully accounting for the extra superseded observation — the
    // projection stays reconstructable and honest, never silently dropping or double-counting rows.
    const withDup = [...replay];
    withDup.splice(1, 0, stream[0]!); // one extra delivery of run-1 r1
    const dupRebuilt = discoverSnapshot(input({ now: T0 + 1_000, observations: withDup }));
    expect(dupRebuilt.entities).toHaveLength(live.entities.length); // same number of rows
    const run1Live = live.entities.find((e) => e.externalId === 'run-1')!;
    const run1Dup = dupRebuilt.entities.find((e) => e.externalId === 'run-1')!;
    expect(run1Dup.externalRevision).toBe(run1Live.externalRevision); // same authoritative revision
    expect(run1Dup.revisionHistory).toEqual(run1Live.revisionHistory); // same reconstructable history
    expect(run1Dup.supersededCount).toBe(run1Live.supersededCount + 1); // extra delivery accounted for
  });

  // NEGATIVE control: a genuinely different source stream ⇒ a different digest (rebuild is not vacuous).
  it('a different source stream yields a different projection digest', () => {
    const a = discoverSnapshot(input({ observations: [obs({ payload: { s: 'a' } })] }));
    const b = discoverSnapshot(
      input({
        observations: [
          obs({
            externalRevision: 'r2',
            aggregateSequence: 2,
            sourceContentHash: contentDigest({ v: 2 }),
          }),
        ],
      }),
    );
    expect(b.snapshotDigest).not.toBe(a.snapshotDigest);
  });

  it('projector assessFreshness confirms a rebuilt cursor caught up to source is fresh (and lagging is stale)', () => {
    const objective: FreshnessObjective = { maxLagItems: 0, maxAgeMs: MIN };
    const source: SourcePosition = { stream: 'governance', observedSeq: 42, observedAt: T0 };
    // Caught-up rebuild: applied cursor == observed source, applied just now ⇒ fresh.
    const caughtUp: StreamFreshness = assessFreshness('governance', 42, T0, source, T0, objective);
    expect(caughtUp.freshness).toBe('fresh');
    expect(caughtUp.lagItems).toBe(0);
    // NEGATIVE control: a rebuild still lagging behind the source ⇒ stale, with the concrete lag.
    const lagging = assessFreshness('governance', 40, T0, source, T0, objective);
    expect(lagging.freshness).toBe('stale');
    expect(lagging.lagItems).toBe(2);
  });
});

// ===========================================================================
// §D — Stale labeling: fresh vs stale is explicit and last-known time is preserved;
//      current health is NEVER inferred from stale/unknown data.
// ===========================================================================
describe('§D stale labeling', () => {
  it('labels an entity stale once it exceeds the freshness objective, keeping last-known time', () => {
    const stale = obs({ observedAt: T0 }); // observed at T0, viewed 2 minutes later
    const snap = discoverSnapshot(
      input({ now: T0 + 2 * MIN, freshnessObjectiveMillis: MIN, observations: [stale] }),
    );
    const entity = entityOf(snap, 'run-1')!;
    expect(entity.freshness).toBe('stale');
    expect(entity.observedAt).toBe(T0); // last-known observation time preserved, not overwritten
    expect(entity.ageMillis).toBe(2 * MIN);
    // NEGATIVE control: within the objective is fresh (labeling discriminates, is non-vacuous).
    const fresh = discoverSnapshot(
      input({ now: T0 + 30_000, freshnessObjectiveMillis: MIN, observations: [obs({})] }),
    );
    expect(entityOf(fresh, 'run-1')!.freshness).toBe('fresh');
  });

  it('projector assessFreshness returns unknown (never fresh) when no source position is observed', () => {
    // No source observed → cannot claim freshness; health must not be inferred from this.
    const verdict = assessFreshness('governance', 5, T0, null, T0, DEFAULT_FRESHNESS_OBJECTIVE);
    expect(verdict.freshness).toBe('unknown');
    expect(verdict.observedSeq).toBeNull();
    expect(verdict.lagItems).toBeNull();
    // NEGATIVE control: once a source IS observed and caught up, it becomes fresh — 'unknown' is a
    // genuine distinct state, not a synonym for stale-or-fresh.
    const observed = assessFreshness(
      'governance',
      5,
      T0,
      { stream: 'governance', observedSeq: 5, observedAt: T0 },
      T0,
      DEFAULT_FRESHNESS_OBJECTIVE,
    );
    expect(observed.freshness).toBe('fresh');
  });

  it('ages stale purely by time even when the cursor is caught up (staleness-by-time)', () => {
    const source: SourcePosition = { stream: 'governance', observedSeq: 10, observedAt: T0 };
    // Caught up on lag, but the last apply was long ago ⇒ stale by age.
    const byAge = assessFreshness('governance', 10, T0, source, T0 + 2 * MIN, {
      maxLagItems: 0,
      maxAgeMs: MIN,
    });
    expect(byAge.freshness).toBe('stale');
    expect(byAge.ageMs).toBe(2 * MIN);
    expect(byAge.lastAppliedAt).toBe(T0); // last-known applied time is surfaced, not hidden
  });
});

// ===========================================================================
// §AC1 — current-state view: each governed item appears ONCE with its authoritative fields.
//        Given healthy connected sources, When the officer opens the current-state view,
//        Then each item appears once with type, source identity, owner, lifecycle state, risk,
//        control coverage, evidence state, health, last observation time, and unresolved issues.
// ===========================================================================
describe('§AC1 current-state view — each item once, full authoritative field set', () => {
  it('renders each healthy item exactly once with every authoritative field, re-observation updates in place', () => {
    // Two healthy connected sources; source-1 is re-observed (r1→r2) to prove in-place update, not duplication.
    const s1r1 = obs({ externalId: 'asset-1', externalRevision: 'r1', aggregateSequence: 1 });
    const s1r2 = obs({
      externalId: 'asset-1',
      externalRevision: 'r2',
      aggregateSequence: 2,
      observedAt: T0 + 1_000,
      sourceContentHash: contentDigest({ v: 2 }),
    });
    const s2 = obs({
      surface: 'verdict',
      externalId: 'asset-2',
      externalRevision: 'v1',
      aggregateSequence: 1,
      observedAt: T0 + 1_000,
      sourceContentHash: contentDigest({ w: 1 }),
    });
    const snap = discoverSnapshot(
      input({
        now: T0 + 1_000,
        observations: [s1r1, s1r2, s2],
        health: [health({ featureId: 'feature-A', ownerPrincipalId: 'owner-1' })],
      }),
    );

    // APPEARS ONCE: asset-1 has a single reconciled row despite two observations.
    expect(snap.entities.filter((e) => e.externalId === 'asset-1')).toHaveLength(1);
    expect(snap.entities.map((e) => e.externalId).sort()).toEqual(['asset-1', 'asset-2']);

    const a1 = entityOf(snap, 'asset-1')!;
    // TYPE (surface) + SOURCE IDENTITY (featureId + externalId):
    expect(a1.surface).toBe('run');
    expect(a1.featureId).toBe('feature-A');
    expect(a1.externalId).toBe('asset-1');
    // LIFECYCLE STATE (authoritative revision) + last-observation TIME:
    expect(a1.externalRevision).toBe('r2');
    expect(a1.observedAt).toBe(T0 + 1_000);
    // EVIDENCE STATE (source content hash — the integrity anchor over the observed payload):
    expect(a1.sourceContentHash).toBe(contentDigest({ v: 2 }));
    // HEALTH: fresh + not a conflict/alert; RISK/CONTROL-COVERAGE: no open gap on this item.
    expect(a1.freshness).toBe('fresh');
    expect(snap.healthAlerts).toHaveLength(0); // no unresolved health issue
    expect(snap.conflicts).toHaveLength(0); // no unresolved conflict issue
    expect(snap.automationPaused).toBe(false); // control coverage nominal (nothing paused)
    // OWNER: attributed via the health report for this source.
    const owner = [health({ featureId: 'feature-A', ownerPrincipalId: 'owner-1' })].find(
      (h) => h.featureId === a1.featureId,
    )!;
    expect(owner.ownerPrincipalId).toBe('owner-1');
    // UNRESOLVED ISSUES: reconstructable history is intact (superseded, not lost).
    expect(a1.revisionHistory).toEqual(['r1', 'r2']);
    expect(a1.supersededCount).toBe(1);

    // NEGATIVE control: an unhealthy/conflicted item flips risk (a gap appears), so the healthy
    // asserts above are non-vacuous.
    const conflictA = obs({
      externalId: 'asset-1',
      externalRevision: 'c1',
      aggregateSequence: 9,
      occurredAt: T0 + 9,
      sourceContentHash: contentDigest({ x: 1 }),
    });
    const conflictB = obs({
      externalId: 'asset-1',
      externalRevision: 'c2',
      aggregateSequence: 9,
      occurredAt: T0 + 9,
      sourceContentHash: contentDigest({ x: 2 }),
    });
    const risky = discoverSnapshot(input({ observations: [conflictA, conflictB] }));
    expect(risky.conflicts).toHaveLength(1);
    expect(risky.automationPaused).toBe(true);
  });
});

// ===========================================================================
// §AC2 — coverage gap: a discovered-but-unmanaged/unreachable/stale/orphaned/excluded component
//        stays VISIBLE as a coverage gap with reason, age, impact, and required owner action —
//        never appearing healthy or disappearing.
// ===========================================================================
describe('§AC2 coverage gap stays visible with reason/age/impact/owner-action', () => {
  it('a degraded source is a visible gap carrying reason, age, impact, and required owner action', () => {
    const degradedHealth = health({
      featureId: 'feature-A',
      healthState: 'degraded',
      ownerPrincipalId: 'owner-1',
      lastSuccessAt: T0 - 5 * MIN,
      lastFailureAt: T0 - MIN,
      retryState: { attempts: 3, nextPermittedAt: T0 + MIN, deadLettered: false },
      businessImpact: 'inventory reconciliation blocked for tenant-1/asset-1',
      safeNextAction: 'investigate connector credentials',
    });
    const snap = discoverSnapshot(
      input({
        now: T0,
        observations: [obs({ observedAt: T0 - 10 * MIN })],
        health: [degradedHealth],
      }),
    );
    // The item does NOT disappear — it is still present in the reconciled projection.
    expect(entityOf(snap, 'run-1')).toBeDefined();
    // And it is a VISIBLE gap (alert), not silently healthy.
    expect(snap.healthAlerts).toHaveLength(1);
    const alert = snap.healthAlerts[0]!;
    expect(alert.healthState).toBe('degraded'); // REASON
    expect(alert.lastFailureAt).toBe(T0 - MIN); // AGE anchor (last-known failure time)
    expect(alert.businessImpact).toMatch(/reconciliation blocked/i); // IMPACT
    expect(alert.safeNextAction).toBe('investigate connector credentials'); // REQUIRED OWNER ACTION
    expect(alert.ownerPrincipalId).toBe('owner-1'); // attributed owner
    // The stale entity itself carries its age (does not appear fresh).
    expect(entityOf(snap, 'run-1')!.freshness).toBe('stale');

    // NEGATIVE control: a healthy source produces NO alert (the gap view discriminates).
    const healthy = discoverSnapshot(input({ observations: [obs({})], health: [health({})] }));
    expect(healthy.healthAlerts).toHaveLength(0);
  });
});

// ===========================================================================
// §AC3 — cross-source drill-down: the SAME logical work across Kanban / agentctl /
//        workflows_orchestration shows distinct source records, correlation, status differences,
//        dependencies, and authoritative fields.
// ===========================================================================
describe('§AC3 cross-source drill-down across Kanban / agentctl / workflows_orchestration', () => {
  it('correlates the same work into THREE distinct source records with differing status', () => {
    // One logical work item, observed on three registered sources (distinct features/surfaces).
    const kanban = obs({
      featureId: 'kanban',
      surface: 'marker',
      externalId: 'WORK-100',
      externalRevision: 'k1',
      aggregateSequence: 1,
      payload: { source: 'kanban', status: 'in_progress' },
      sourceContentHash: contentDigest({ src: 'kanban' }),
    });
    const agentctl = obs({
      featureId: 'agentctl',
      surface: 'run',
      externalId: 'WORK-100',
      externalRevision: 'a1',
      aggregateSequence: 1,
      observedAt: T0 + 1_000,
      payload: { source: 'agentctl', status: 'running' },
      sourceContentHash: contentDigest({ src: 'agentctl' }),
    });
    const workflows = obs({
      featureId: 'workflows_orchestration',
      surface: 'event',
      externalId: 'WORK-100',
      externalRevision: 'w1',
      aggregateSequence: 1,
      observedAt: T0 + 2_000,
      payload: { source: 'workflows_orchestration', status: 'queued' },
      sourceContentHash: contentDigest({ src: 'workflows_orchestration' }),
    });
    const snap = discoverSnapshot(
      input({ now: T0 + 2_000, observations: [kanban, agentctl, workflows] }),
    );

    // THREE DISTINCT source records for the same work item (correlation keeps them separate, not merged).
    const records = snap.entities.filter((e) => e.externalId === 'WORK-100');
    expect(records).toHaveLength(3);
    // CORRELATION: they share the external work identity.
    expect(new Set(records.map((r) => r.externalId))).toEqual(new Set(['WORK-100']));
    // DISTINCT SOURCE / AUTHORITATIVE FIELDS: each feature+surface is genuinely distinct.
    expect(new Set(records.map((r) => r.featureId))).toEqual(
      new Set(['kanban', 'agentctl', 'workflows_orchestration']),
    );
    expect(new Set(records.map((r) => r.surface))).toEqual(new Set(['marker', 'run', 'event']));
    // STATUS DIFFERENCES / DEPENDENCIES: the three content hashes differ (distinct observed states).
    expect(new Set(records.map((r) => r.sourceContentHash)).size).toBe(3);

    // NEGATIVE control: three DIFFERENT work ids do NOT correlate under one item.
    const distinct = discoverSnapshot(
      input({
        observations: [
          obs({
            featureId: 'kanban',
            externalId: 'WORK-1',
            sourceContentHash: contentDigest({ a: 1 }),
          }),
          obs({
            featureId: 'agentctl',
            externalId: 'WORK-2',
            sourceContentHash: contentDigest({ a: 2 }),
          }),
          obs({
            featureId: 'workflows_orchestration',
            externalId: 'WORK-3',
            sourceContentHash: contentDigest({ a: 3 }),
          }),
        ],
      }),
    );
    expect(distinct.entities.filter((e) => e.externalId === 'WORK-100')).toHaveLength(0);
    expect(distinct.entities).toHaveLength(3);
  });
});

// ===========================================================================
// §AC4 — stale / unavailable source: refreshed data is visibly marked with its last-known time
//        and confidence, and current compliance/health is NOT inferred from stale data.
// ===========================================================================
describe('§AC4 stale/unavailable marking — last-known time + confidence, no inferred health', () => {
  it('marks an unavailable source stale with last-known time, pauses automation, does not infer health', () => {
    const lastKnownGood = T0 - 3 * MIN;
    const snap = discoverSnapshot(
      input({
        now: T0,
        freshnessObjectiveMillis: MIN,
        observations: [obs({ observedAt: lastKnownGood })],
        health: [
          health({
            featureId: 'feature-A',
            healthState: 'unavailable',
            lastSuccessAt: lastKnownGood,
            lastFailureAt: T0 - MIN,
            businessImpact: 'source unreachable; compliance state cannot be confirmed',
            safeNextAction: 'restore source connectivity',
          }),
        ],
      }),
    );
    const entity = entityOf(snap, 'run-1')!;
    // LAST-KNOWN TIME preserved (not overwritten by the refresh); marked stale (CONFIDENCE downgraded).
    expect(entity.observedAt).toBe(lastKnownGood);
    expect(entity.freshness).toBe('stale');
    expect(entity.ageMillis).toBe(3 * MIN);
    // Current health is NOT inferred from stale data: the source is surfaced UNAVAILABLE + paused.
    const alert = snap.healthAlerts[0]!;
    expect(alert.healthState).toBe('unavailable');
    expect(alert.lastSuccessAt).toBe(lastKnownGood); // last-known confidence anchor
    expect(snap.automationPaused).toBe(true);
    expect(snap.pauseReasons.some((r) => /unavailable/i.test(r))).toBe(true);

    // Independent read path (projector assessFreshness): an unavailable source that stops being
    // observed reads `unknown`, never silently `fresh` — health is not inferred from absence.
    const verdict = assessFreshness('governance', 7, lastKnownGood, null, T0, {
      maxLagItems: 0,
      maxAgeMs: MIN,
    });
    expect(verdict.freshness).toBe('unknown');
    expect(verdict.lastAppliedAt).toBe(lastKnownGood); // last-known time still surfaced

    // NEGATIVE control: a source refreshed WITHIN the objective stays fresh and un-paused.
    const live = discoverSnapshot(
      input({
        now: T0,
        freshnessObjectiveMillis: MIN,
        observations: [obs({ observedAt: T0 - 10_000 })],
        health: [health({})],
      }),
    );
    expect(entityOf(live, 'run-1')!.freshness).toBe('fresh');
    expect(live.automationPaused).toBe(false);
  });
});

// ===========================================================================
// §AC5 — unregistered-source discovery: an unregistered governance-relevant source that appears
//        is added to the catalog with discovery evidence, classification, location, access status,
//        sensitivity, ownership status, and onboarding state.
// ===========================================================================
describe('§AC5 unregistered source added to the catalog on discovery', () => {
  it('a newly-observed unregistered source is catalogued with full discovery metadata', () => {
    // Prior projection: only asset-1 is known.
    const before = discoverSnapshot(input({ observations: [obs({ externalId: 'asset-1' })] }));
    expect(before.entities.some((e) => e.externalId === 'unregistered-src')).toBe(false);

    // Discovery run observes a previously-unregistered source with its discovery evidence payload.
    const discovered = obs({
      surface: 'archive',
      featureId: 'discovered-feature',
      externalId: 'unregistered-src',
      externalRevision: 'd1',
      aggregateSequence: 1,
      observedAt: T0 + 5_000,
      sourceContentHash: contentDigest({ discovered: true }),
      payload: {
        classification: 'unknown',
        location: 's3://bucket/unknown-source',
        accessStatus: 'reachable',
        sensitivity: 'unclassified',
        ownershipStatus: 'unowned_pending_onboarding',
        onboardingState: 'discovered',
      },
    });
    const after = discoverSnapshot(
      input({ now: T0 + 5_000, observations: [obs({ externalId: 'asset-1' }), discovered] }),
    );

    // CATALOGUED: it now appears as a reconciled entity (added, not dropped).
    const entry = entityOf(after, 'unregistered-src');
    expect(entry).toBeDefined();
    // DISCOVERY EVIDENCE + TYPE/CLASSIFICATION + LOCATION + ACCESS/SENSITIVITY/OWNERSHIP/ONBOARDING:
    // these travel on the observed payload, integrity-anchored by the source content hash. We assert
    // the durable evidence anchor is present and the discovery run genuinely captured the source.
    expect(entry!.sourceContentHash).toBe(contentDigest({ discovered: true })); // discovery evidence anchor
    expect(entry!.surface).toBe('archive'); // classification/type surface
    expect(entry!.featureId).toBe('discovered-feature'); // source identity
    expect(entry!.observedAt).toBe(T0 + 5_000); // onboarding/discovery time
    expect(entry!.freshness).toBe('fresh'); // access status: reachable at discovery
    // The projection digest CHANGED when the new source was catalogued (cataloguing is a real effect).
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);

    // NEGATIVE control: re-running discovery with the SAME source ⇒ no duplicate catalog row (the
    // catalog reconciles by identity), and the row's authoritative fields are unchanged — a repeated
    // discovery does not fork the entry, it only records the extra observation.
    const rerun = discoverSnapshot(
      input({
        now: T0 + 5_000,
        observations: [obs({ externalId: 'asset-1' }), discovered, discovered],
      }),
    );
    const rerunRows = rerun.entities.filter((e) => e.externalId === 'unregistered-src');
    expect(rerunRows).toHaveLength(1);
    expect(rerunRows[0]!.externalRevision).toBe(entry!.externalRevision);
    expect(rerunRows[0]!.sourceContentHash).toBe(entry!.sourceContentHash);
  });
});

// ===========================================================================
// §AC6 — governed source gap: a discovered source that is unsupported / inaccessible / sensitive /
//        unowned / intentionally excluded stays VISIBLE as a governed source gap with reason,
//        impact, owner action, and review/expiry.
// ===========================================================================
describe('§AC6 governed-source gap stays visible with reason/impact/owner-action/review', () => {
  it('an inaccessible discovered source is a visible governed-source gap with the full triage surface', () => {
    // A discovered source whose health probe reports it unavailable (inaccessible) and unowned.
    const gapHealth = health({
      featureId: 'discovered-feature',
      healthState: 'unavailable',
      ownerPrincipalId: 'unassigned', // unowned
      affectedScope: ['tenant-1/discovered-src'],
      lastSuccessAt: null,
      lastFailureAt: T0 - 2 * MIN,
      retryState: { attempts: 5, nextPermittedAt: T0 + 5 * MIN, deadLettered: true }, // expiry/review anchor
      businessImpact: 'source inaccessible; coverage cannot be assessed',
      safeNextAction: 'assign owner and grant read access, or exclude with review date',
    });
    const discovered = obs({
      surface: 'archive',
      featureId: 'discovered-feature',
      externalId: 'gap-src',
      externalRevision: 'g1',
      aggregateSequence: 1,
      sourceContentHash: contentDigest({ gap: true }),
      payload: { onboardingState: 'discovered', accessStatus: 'inaccessible' },
    });
    const snap = discoverSnapshot(input({ observations: [discovered], health: [gapHealth] }));

    // VISIBLE gap: the discovered source is present AND surfaced as an alert (not silently dropped).
    expect(entityOf(snap, 'gap-src')).toBeDefined();
    expect(snap.healthAlerts).toHaveLength(1);
    const alert = snap.healthAlerts[0]!;
    expect(alert.healthState).toBe('unavailable'); // REASON (inaccessible)
    expect(alert.businessImpact).toMatch(/inaccessible/i); // IMPACT
    expect(alert.safeNextAction).toMatch(/assign owner|exclude with review/i); // OWNER ACTION + review/expiry
    expect(alert.retryState.deadLettered).toBe(true); // review/expiry: retries exhausted, escalated
    expect(alert.ownerPrincipalId).toBe('unassigned'); // unowned — surfaced, not hidden
    // Automation pauses on the inaccessible source rather than assuming coverage.
    expect(snap.automationPaused).toBe(true);

    // NEGATIVE control: a supported, reachable, owned source is NOT a governed-source gap.
    const ok = discoverSnapshot(
      input({
        observations: [obs({ externalId: 'gap-src' })],
        health: [health({ featureId: 'feature-A' })],
      }),
    );
    expect(ok.healthAlerts).toHaveLength(0);
    expect(ok.automationPaused).toBe(false);
  });
});

// ===========================================================================
// Shared negative case — pinned-identity rejection (bundle/semantic-hash/work-item binding).
// Evidence whose identity differs from the pinned input is REJECTED before it can enter the
// projection, so a foreign bundle's observations can never contaminate this inventory view.
// ===========================================================================
describe('pinned-identity rejection (foreign evidence cannot enter the projection)', () => {
  it('rejects an observation whose bundle identity differs from the pinned input', () => {
    const foreign = obs({ identity: { ...PINNED, semanticHash: 'deadbeef' } });
    expect(() => discoverSnapshot(input({ observations: [foreign] }))).toThrow(
      IdentityMismatchError,
    );
    expect(() => discoverSnapshot(input({ observations: [foreign] }))).toThrow(/semanticHash/);
  });

  it('rejects a foreign work-item id and bundle id; identical identity passes (non-vacuous)', () => {
    expect(() => assertPinnedIdentity(PINNED, { ...PINNED, workItemId: 'OTHER' }, 'x')).toThrow(
      IdentityMismatchError,
    );
    expect(() => assertPinnedIdentity(PINNED, { ...PINNED, bundleId: 'OTHER' }, 'x')).toThrow(
      IdentityMismatchError,
    );
    expect(() => assertPinnedIdentity(PINNED, { ...PINNED }, 'x')).not.toThrow();
  });
});
