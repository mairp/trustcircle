// Integration suite — Wiggum read-only snapshot discovery
// (adapters/wiggum/src/snapshot.ts; T264 / US6).
//
// Independently observes the four effect-witness verification obligations. Each obligation is
// verified through the RETURNED snapshot (a durable, deep-frozen artifact carrying a content
// digest and the pinned bundle identity) — never through a mutation response — and each has a
// negative control that must fail when the invariant is removed.
//
//   VO-d982977672dda011fc65 — healthy sources → the correlated view reflects the source
//     change within the freshness objective.
//   VO-468734d7c60e0fbb801b — degradation → ownership/scope/last-success/failure/retry/impact/
//     safe-next-action are visible and alertable.
//   VO-d3ab0d39f511ca998e03 — duplicate/out-of-order updates → no duplicate governance action;
//     source history remains reconstructable.
//   VO-4c1d3e1127dd54c7664e — unresolvable conflicts → conflict stays visible, affected
//     automation pauses safely, an owned issue is opened.

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
} from '../../adapters/wiggum/src/snapshot.ts';

const PINNED: BundleIdentity = {
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: '6JKNDJBEQK0F5F6ATYED53PJ7Q',
};

const T0 = 1_700_000_000_000; // fixed injected clock base (ms); never reads wall clock.

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
    freshnessObjectiveMillis: 60_000,
    now: T0,
    observations: [],
    health: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Effect-witness discipline: durable, independently readable artifact.
// ---------------------------------------------------------------------------
describe('effect witness — durable snapshot digest + immutability', () => {
  it('produces a content digest that could not exist before discovery (durable identity)', () => {
    const snap = discoverSnapshot(input({ observations: [obs({})] }));
    expect(snap.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    // Independent read path: recompute the digest over the body and confirm it matches.
    const recomputed = contentDigest({
      pinnedIdentity: snap.pinnedIdentity,
      freshnessObjectiveMillis: snap.freshnessObjectiveMillis,
      capturedAt: snap.capturedAt,
      entities: snap.entities,
      conflicts: snap.conflicts,
      healthAlerts: snap.healthAlerts,
      automationPaused: snap.automationPaused,
      pauseReasons: snap.pauseReasons,
    });
    expect(recomputed).toBe(snap.snapshotDigest);
  });

  it('is deterministic (same input ⇒ identical digest) — no duplicate/nondeterministic action', () => {
    const a = discoverSnapshot(input({ observations: [obs({})] }));
    const b = discoverSnapshot(input({ observations: [obs({})] }));
    expect(b.snapshotDigest).toBe(a.snapshotDigest);
  });

  it('returns a deep-frozen, read-only artifact (originals never mutated)', () => {
    const observations = [obs({})];
    const snap = discoverSnapshot(input({ observations }));
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.entities)).toBe(true);
    expect(() => {
      // @ts-expect-error — mutating a frozen snapshot must throw in strict mode.
      snap.entities.push({});
    }).toThrow();
    // The caller's input array is untouched.
    expect(observations).toHaveLength(1);
  });

  // NEGATIVE CASE (shared): reject evidence whose identity differs from the pinned input.
  it('rejects observations whose bundle identity differs from the pinned input', () => {
    const wrong = obs({ identity: { ...PINNED, semanticHash: 'deadbeef' } });
    expect(() => discoverSnapshot(input({ observations: [wrong] }))).toThrow(IdentityMismatchError);
    expect(() => discoverSnapshot(input({ observations: [wrong] }))).toThrow(/semanticHash/);
  });

  it('assertPinnedIdentity rejects mismatched bundle id and work item', () => {
    expect(() => assertPinnedIdentity(PINNED, { ...PINNED, bundleId: 'OTHER' }, 'x')).toThrow(
      IdentityMismatchError,
    );
    expect(() => assertPinnedIdentity(PINNED, { ...PINNED, workItemId: 'OTHER' }, 'x')).toThrow(
      IdentityMismatchError,
    );
    // Positive control: identical identity passes.
    expect(() => assertPinnedIdentity(PINNED, { ...PINNED }, 'x')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VO-d982977672dda011fc65 — freshness objective.
// ---------------------------------------------------------------------------
describe('VO-d982 — state change reflected within the freshness objective', () => {
  it('reflects the latest source revision in the correlated view (fresh)', () => {
    const older = obs({ externalRevision: 'r1', aggregateSequence: 1, payload: { s: 'a' } });
    const newer = obs({
      externalRevision: 'r2',
      aggregateSequence: 2,
      observedAt: T0 + 1_000,
      sourceContentHash: contentDigest({ v: 2 }),
      payload: { s: 'b' },
    });
    const snap = discoverSnapshot(input({ now: T0 + 1_000, observations: [older, newer] }));
    const entity = snap.entities.find((e) => e.externalId === 'run-1')!;
    expect(entity.externalRevision).toBe('r2'); // authoritative = latest in-order
    expect(entity.freshness).toBe('fresh');
    expect(entity.ageMillis).toBeLessThanOrEqual(60_000);
  });

  it('marks an observation stale once it exceeds the freshness objective', () => {
    const stale = obs({ observedAt: T0 });
    const snap = discoverSnapshot(
      input({ now: T0 + 120_000, freshnessObjectiveMillis: 60_000, observations: [stale] }),
    );
    expect(snap.entities[0]!.freshness).toBe('stale');
  });

  // NEGATIVE CONTROL: a change within the objective must NOT be reported stale.
  it('does not mark a within-objective change stale (non-vacuous freshness)', () => {
    const snap = discoverSnapshot(
      input({ now: T0 + 30_000, freshnessObjectiveMillis: 60_000, observations: [obs({})] }),
    );
    expect(snap.entities[0]!.freshness).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// VO-468734d7c60e0fbb801b — degradation is visible and alertable.
// ---------------------------------------------------------------------------
describe('VO-468734 — degradation surfaces the full triage record', () => {
  it('emits an alert with ownership, scope, last success/failure, retry, impact, next action', () => {
    const degraded = health({
      healthState: 'degraded',
      lastSuccessAt: T0 - 10_000,
      lastFailureAt: T0 - 1_000,
      retryState: { attempts: 3, nextPermittedAt: T0 + 5_000, deadLettered: false },
      businessImpact: 'decision queue stale for tenant-1',
      safeNextAction: 'inspect connector; do not auto-repair',
    });
    const snap = discoverSnapshot(input({ health: [degraded] }));
    expect(snap.healthAlerts).toHaveLength(1);
    const a = snap.healthAlerts[0]!;
    expect(a.ownerPrincipalId).toBe('owner-1');
    expect(a.affectedScope).toContain('tenant-1/asset-1');
    expect(a.lastSuccessAt).toBe(T0 - 10_000);
    expect(a.lastFailureAt).toBe(T0 - 1_000);
    expect(a.retryState.attempts).toBe(3);
    expect(a.businessImpact).toMatch(/tenant-1/);
    expect(a.safeNextAction).toMatch(/inspect/);
  });

  // NEGATIVE CONTROL: a healthy source produces NO alert (alerting is non-vacuous).
  it('does not alert when the source is healthy', () => {
    const snap = discoverSnapshot(input({ health: [health({ healthState: 'healthy' })] }));
    expect(snap.healthAlerts).toHaveLength(0);
    expect(snap.automationPaused).toBe(false);
  });

  it('pauses affected automation when a source is unavailable', () => {
    const snap = discoverSnapshot(
      input({ health: [health({ healthState: 'unavailable', businessImpact: 'no reads' })] }),
    );
    expect(snap.automationPaused).toBe(true);
    expect(snap.pauseReasons.join(' ')).toMatch(/unavailable/);
  });
});

// ---------------------------------------------------------------------------
// VO-d3ab0d39f511ca998e03 — dedup + reconstructable history.
// ---------------------------------------------------------------------------
describe('VO-d3ab — duplicate/out-of-order updates: no duplicate action, history reconstructable', () => {
  it('collapses duplicate observations into one entity but keeps every revision', () => {
    const r1 = obs({ externalRevision: 'r1', aggregateSequence: 1 });
    const dupR1 = obs({ externalRevision: 'r1', aggregateSequence: 1 }); // exact duplicate
    const r2 = obs({
      externalRevision: 'r2',
      aggregateSequence: 2,
      sourceContentHash: contentDigest({ v: 2 }),
    });
    const snap = discoverSnapshot(input({ observations: [r1, dupR1, r2] }));
    const entities = snap.entities.filter((e) => e.externalId === 'run-1');
    expect(entities).toHaveLength(1); // no duplicate governance entity/action
    const e = entities[0]!;
    expect(e.externalRevision).toBe('r2');
    expect(e.revisionHistory).toEqual(['r1', 'r2']); // history reconstructable, deduped
  });

  it('orders out-of-order arrivals by aggregate sequence, not arrival order', () => {
    const r2 = obs({
      externalRevision: 'r2',
      aggregateSequence: 2,
      sourceContentHash: contentDigest({ v: 2 }),
    });
    const r1 = obs({ externalRevision: 'r1', aggregateSequence: 1 });
    // Arrives out of order: r2 before r1.
    const snap = discoverSnapshot(input({ observations: [r2, r1] }));
    const e = snap.entities.find((x) => x.externalId === 'run-1')!;
    expect(e.externalRevision).toBe('r2'); // highest sequence wins regardless of arrival
    expect(e.revisionHistory).toEqual(['r1', 'r2']); // reconstructed in true order
    expect(e.supersededCount).toBe(1);
  });

  // NEGATIVE CONTROL: two genuinely-distinct entities are NOT collapsed.
  it('does not collapse distinct entities (dedup is non-vacuous)', () => {
    const a = obs({ externalId: 'run-1' });
    const b = obs({ externalId: 'run-2' });
    const snap = discoverSnapshot(input({ observations: [a, b] }));
    expect(snap.entities.filter((e) => e.surface === 'run')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// VO-4c1d3e1127dd54c7664e — unresolvable conflict pauses automation + opens owned issue.
// ---------------------------------------------------------------------------
describe('VO-4c1d — conflicting states: visible, automation paused, owned issue opened', () => {
  const conflictInput = () => {
    const a = obs({
      externalRevision: 'rA',
      aggregateSequence: 5,
      occurredAt: T0 + 100,
      sourceContentHash: contentDigest({ side: 'A' }),
    });
    const b = obs({
      externalRevision: 'rB',
      aggregateSequence: 5, // same sequence AND
      occurredAt: T0 + 100, // same occurredAt, but different content ⇒ unresolvable
      sourceContentHash: contentDigest({ side: 'B' }),
    });
    return input({ observations: [a, b], health: [health({})] });
  };

  it('records the conflict, opens a deterministic owned issue, and pauses automation', () => {
    const snap = discoverSnapshot(conflictInput());
    expect(snap.conflicts).toHaveLength(1);
    const c = snap.conflicts[0]!;
    expect(c.conflictingContentHashes.length).toBeGreaterThanOrEqual(2);
    expect(c.ownedIssueId).toMatch(/^wiggum-conflict-[0-9a-f]{32}$/);
    expect(c.ownerPrincipalId).toBe('owner-1'); // ownership attributed for resolution
    expect(snap.automationPaused).toBe(true);
    expect(snap.pauseReasons.join(' ')).toMatch(/conflict/);
  });

  it('opens the SAME owned issue id for the SAME conflict (no duplicate governance action)', () => {
    const first = discoverSnapshot(conflictInput());
    const second = discoverSnapshot(conflictInput());
    expect(second.conflicts[0]!.ownedIssueId).toBe(first.conflicts[0]!.ownedIssueId);
  });

  // NEGATIVE CONTROL: a cleanly-resolvable update produces NO conflict and does NOT pause.
  it('does not open a conflict when authority rules resolve the order', () => {
    const r1 = obs({ externalRevision: 'r1', aggregateSequence: 1 });
    const r2 = obs({
      externalRevision: 'r2',
      aggregateSequence: 2,
      sourceContentHash: contentDigest({ v: 2 }),
    });
    const snap = discoverSnapshot(input({ observations: [r1, r2], health: [health({})] }));
    expect(snap.conflicts).toHaveLength(0);
    expect(snap.automationPaused).toBe(false);
  });
});
