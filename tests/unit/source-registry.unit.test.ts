// TrustCircleAI — Phase 65 unit tests for the SOURCE REGISTRY application service.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// Executable evidence that `packages/application/src/source-registry.ts` — source-contract
// registration (versioned + validated), onboarding lifecycle, stewardship actions, exclusion
// reviews, and ownership / coverage-gap synthesis over the domain inventory model — satisfies
// acceptance criteria AC1–AC6.
//
// The registry is a pure, deterministic aggregate: every mutation takes an explicit `at` epoch and
// draws identity from an injected deterministic UUIDv7 factory (no wall clock). The durable-effect
// witness for every mutation is NOT its return value but the INDEPENDENTLY re-readable state
// (`catalog()`, `contracts()`, `coverageGaps()`, `currentStateView()`) and its content digest
// (`snapshotDigest()`), which changes iff a governed fact changes.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a healthy/rejected scenario in
// which the rule must NOT fire, so a green run is not a permissive fake.
//
// AC → describe-block map:
//   AC1 healthy connected sources render ONCE with the full facet set ...... describe('AC1 …')
//   AC2 non-healthy component stays a VISIBLE coverage gap .................. describe('AC2 …')
//   AC3 related work → distinct source records + contract lineage drilldown  describe('AC3 …')
//   AC4 stale/unavailable source marked; health not inferred from stale data describe('AC4 …')
//   AC5 unregistered source ADDED to catalog with discovery evidence ........ describe('AC5 …')
//   AC6 discovered source stays a VISIBLE governed-source gap w/ review ..... describe('AC6 …')
//
// Import paths mirror tests/unit/inventory-aggregates.unit.test.ts: relative, `.ts` extension.

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  makeReason,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import {
  makeSourceRecord,
  gapIsVisible,
  gapHasReviewOrExpiry,
  catalogEntryHasOwnershipGap,
  UNKNOWN_SOURCE_CLASS,
} from '../../packages/domain/src/inventory.ts';
import {
  SourceRegistry,
  canOnboardingTransition,
  assertOnboardingTransition,
  type IdFactory,
} from '../../packages/application/src/source-registry.ts';

// ---------------------------------------------------------------------------
// Deterministic helpers — a monotonic UUIDv7 factory + a fixed random filler,
// so identities are reproducible and time-ordered without any wall-clock read.
// ---------------------------------------------------------------------------

const FIXED_RANDOM = () => new Uint8Array(16).fill(0x7a);

/** A deterministic UUIDv7 factory: each call advances a counter used as the 48-bit timestamp. */
function idFactory(seed = 1): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}

const T0 = 1_700_000_000_000 as EpochMillis;
const MIN = 60_000;
const HORIZON = 15 * MIN;

function newRegistry(): SourceRegistry {
  return new SourceRegistry({
    tenantId: PLATFORM_SCOPE,
    newId: idFactory(),
    stalenessHorizonMillis: HORIZON,
  });
}

/** Discover → contract → assign owner → onboard → observe a fully healthy connected source. */
function onboardHealthy(
  reg: SourceRegistry,
  externalKey: string,
  sourceClass: string,
  at: EpochMillis,
): Uuid {
  const owner = uuidV7((at + 5) as EpochMillis, FIXED_RANDOM);
  const evidence = uuidV7((at + 6) as EpochMillis, FIXED_RANDOM);
  const entry = reg.discover({
    externalKey,
    sourceClass,
    location: `svc://${externalKey}`,
    accessState: 'connected',
    discoveryEvidence: evidence,
    at,
  });
  reg.registerContract({ sourceId: entry.id, version: 1, supportLevel: 'supported', at });
  reg.assignOwner({ sourceId: entry.id, ownerPrincipalId: owner, at });
  reg.transitionOnboarding({ sourceId: entry.id, to: 'pending', at });
  reg.transitionOnboarding({ sourceId: entry.id, to: 'onboarded', at });
  reg.recordObservation({
    sourceId: entry.id,
    accessState: 'connected',
    healthState: 'healthy',
    at,
  });
  return entry.id;
}

// ===========================================================================
// AC1 — Healthy connected sources render ONCE with the full facet set.
// ===========================================================================

describe('AC1 healthy connected sources render ONCE with the full facet set', () => {
  it('produces exactly one current-state row per source with every enumerated facet', () => {
    const reg = newRegistry();
    const a = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const b = onboardHealthy(reg, 'agentctl', 'agentctl', T0);

    const view = reg.currentStateView(T0);
    // ONCE: one row per source, no duplicates.
    expect(view).toHaveLength(2);
    expect(new Set(view.map((r) => r.sourceId)).size).toBe(2);

    const row = view.find((r) => r.sourceId === a)!;
    // Full facet set: type, identity, owner, lifecycle, access, health, sensitivity, evidence
    // state, last-observation time, unresolved issues, control coverage.
    expect(row.sourceClass).toBe('kanban');
    expect(row.sourceId).toBe(a);
    expect(row.ownerPrincipalId).toBeDefined();
    expect(row.ownershipGap).toBe(false);
    expect(row.onboardingState).toBe('onboarded');
    expect(row.accessState).toBe('connected');
    expect(row.observedHealth).toBe('healthy');
    expect(row.reportedHealth).toBe('healthy'); // fresh ⇒ reportable
    expect(row.staleness).toBe('fresh');
    expect(row.evidenceState).toBe('current');
    expect(row.lastKnownAt).toBe(T0);
    expect(row.confidence).toBe(1);
    expect(row.hasControlCoverage).toBe(true);
    expect(row.unresolvedIssueCount).toBe(0);
    expect(b).not.toBe(a);
  });

  // NEGATIVE CONTROL: a healthy onboarded source must NOT produce a coverage gap on reconcile
  // (green isn't a permissive fake — the gap machinery does not fire for a clean source).
  it('NEGATIVE CONTROL: reconcile opens no gap for a healthy connected onboarded source', () => {
    const reg = newRegistry();
    onboardHealthy(reg, 'kanban', 'kanban', T0);
    const gaps = reg.reconcile({ at: T0 });
    expect(gaps).toHaveLength(0);
    expect(reg.coverageGaps()).toHaveLength(0);
  });

  it('snapshotDigest is an independent witness: it changes iff a governed fact changes', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const before = reg.snapshotDigest();
    // A pure read must not change the digest.
    reg.currentStateView(T0);
    expect(reg.snapshotDigest()).toBe(before);
    // A governed mutation must change it.
    reg.recordObservation({
      sourceId: id,
      accessState: 'degraded',
      healthState: 'degraded',
      at: T0,
    });
    expect(reg.snapshotDigest()).not.toBe(before);
  });
});

// ===========================================================================
// AC2 — A non-healthy component stays a VISIBLE coverage gap.
// ===========================================================================

describe('AC2 discovered-but-unmanaged/unreachable/stale component stays a VISIBLE gap', () => {
  it('reconcile keeps an unmanaged discovered source visible as a gap with reason+action', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 'ghost',
      sourceClass: 'workflows_orchestration',
      location: 'svc://ghost',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    const gaps = reg.reconcile({ at: T0 });
    const g = gaps.find((x) => x.subjectId === e.id)!;
    expect(g).toBeDefined();
    expect(g.reason).toBe('unmanaged');
    expect(gapIsVisible(g)).toBe(true);
    expect(g.requiredAction.length).toBeGreaterThan(0);
    // AC2 age facet: age is derivable and non-negative.
    expect(reg.gapAge(g.id, (T0 + 5 * MIN) as EpochMillis)).toBe(5 * MIN);
    // Not healthy, not disappearing: it is still there on a second read.
    expect(reg.coverageGaps().some((x) => x.id === g.id)).toBe(true);
  });

  it('an unreachable source is kept visible as an "unreachable" gap', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    reg.recordObservation({
      sourceId: id,
      accessState: 'unreachable',
      healthState: 'unknown',
      at: T0,
    });
    const gaps = reg.reconcile({ at: T0 });
    expect(gaps.some((g) => g.subjectId === id && g.reason === 'unreachable')).toBe(true);
  });

  it('reconcile is idempotent: a second pass does not duplicate the gap', () => {
    const reg = newRegistry();
    reg.discover({
      externalKey: 'ghost',
      location: 'svc://ghost',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    const first = reg.reconcile({ at: T0 }).length;
    const second = reg.reconcile({ at: (T0 + MIN) as EpochMillis }).length;
    expect(second).toBe(first);
  });

  // NEGATIVE CONTROL: a healthy source never gets a component gap (rule bites only on non-healthy).
  it('NEGATIVE CONTROL: a healthy connected onboarded source yields no component gap', () => {
    const reg = newRegistry();
    onboardHealthy(reg, 'kanban', 'kanban', T0);
    const gaps = reg.reconcile({ at: T0 });
    expect(gaps.filter((g) => g.gapClass === 'component')).toHaveLength(0);
  });
});

// ===========================================================================
// AC3 — Related work across registered sources → distinct records + lineage.
// ===========================================================================

describe('AC3 related work across sources keeps DISTINCT records + contract lineage', () => {
  it('drillDown exposes distinct source records, contract history, and gaps per source', () => {
    const reg = newRegistry();
    const kanban = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const agentctl = onboardHealthy(reg, 'agentctl', 'agentctl', T0);

    // Distinct records for the same logical work-item, one per source.
    reg.attachRecord(
      makeSourceRecord({
        id: uuidV7((T0 + 10) as EpochMillis, FIXED_RANDOM),
        tenantId: PLATFORM_SCOPE,
        catalogId: kanban,
        sourceClass: 'kanban',
        externalKey: 'WORK-42',
        status: 'active',
        lastKnownAt: T0,
        observedAt: T0,
      }),
    );
    reg.attachRecord(
      makeSourceRecord({
        id: uuidV7((T0 + 11) as EpochMillis, FIXED_RANDOM),
        tenantId: PLATFORM_SCOPE,
        catalogId: agentctl,
        sourceClass: 'agentctl',
        externalKey: 'WORK-42',
        status: 'active',
        lastKnownAt: T0,
        observedAt: T0,
      }),
    );

    const d1 = reg.drillDown(kanban);
    const d2 = reg.drillDown(agentctl);
    // DISTINCT records: each source keeps its own record; they do not collapse.
    expect(d1.records).toHaveLength(1);
    expect(d2.records).toHaveLength(1);
    expect(d1.records[0]!.catalogId).toBe(kanban);
    expect(d2.records[0]!.catalogId).toBe(agentctl);
    // Authoritative contract lineage present per source.
    expect(d1.contracts).toHaveLength(1);
    expect(reg.latestContract(kanban)!.version).toBe(1);
  });

  it('re-attaching a record with the same identity does not create a duplicate', () => {
    const reg = newRegistry();
    const kanban = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const rec = makeSourceRecord({
      id: uuidV7((T0 + 10) as EpochMillis, FIXED_RANDOM),
      tenantId: PLATFORM_SCOPE,
      catalogId: kanban,
      sourceClass: 'kanban',
      externalKey: 'WORK-42',
      lastKnownAt: T0,
      observedAt: T0,
    });
    reg.attachRecord(rec);
    reg.attachRecord(rec);
    expect(reg.sourceRecordsFor(kanban)).toHaveLength(1);
  });

  // NEGATIVE CONTROL: records for different sources are NOT merged (distinct identities kept).
  it('NEGATIVE CONTROL: same external key under two sources yields two distinct records', () => {
    const reg = newRegistry();
    const kanban = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const agentctl = onboardHealthy(reg, 'agentctl', 'agentctl', T0);
    reg.attachRecord(
      makeSourceRecord({
        id: uuidV7((T0 + 10) as EpochMillis, FIXED_RANDOM),
        tenantId: PLATFORM_SCOPE,
        catalogId: kanban,
        sourceClass: 'kanban',
        externalKey: 'WORK-42',
        lastKnownAt: T0,
        observedAt: T0,
      }),
    );
    reg.attachRecord(
      makeSourceRecord({
        id: uuidV7((T0 + 11) as EpochMillis, FIXED_RANDOM),
        tenantId: PLATFORM_SCOPE,
        catalogId: agentctl,
        sourceClass: 'agentctl',
        externalKey: 'WORK-42',
        lastKnownAt: T0,
        observedAt: T0,
      }),
    );
    expect(reg.sourceRecordsFor(kanban)).toHaveLength(1);
    expect(reg.sourceRecordsFor(agentctl)).toHaveLength(1);
  });
});

// ===========================================================================
// AC4 — Stale/unavailable source marked; current health NOT inferred from stale data.
// ===========================================================================

describe('AC4 stale/unavailable source marked; health not inferred from stale data', () => {
  it('a source past the staleness horizon is marked stale with a decayed confidence', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const later = (T0 + HORIZON + MIN) as EpochMillis; // past horizon ⇒ stale.
    const row = reg.currentStateView(later).find((r) => r.sourceId === id)!;
    expect(row.staleness).toBe('stale');
    // Last-known time preserved; confidence below 1 (decayed) but positive.
    expect(row.lastKnownAt).toBe(T0);
    expect(row.confidence).toBeLessThan(1);
    expect(row.confidence).toBeGreaterThan(0);
    // Health NOT inferred from stale data: observed still 'healthy', reported downgraded.
    expect(row.observedHealth).toBe('healthy');
    expect(row.reportedHealth).toBe('unknown');
  });

  it('an unreachable source is unavailable with zero confidence and non-inferred health', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    reg.recordObservation({
      sourceId: id,
      accessState: 'unreachable',
      healthState: 'healthy',
      at: T0,
    });
    const row = reg.currentStateView(T0).find((r) => r.sourceId === id)!;
    expect(row.staleness).toBe('unavailable');
    expect(row.confidence).toBe(0);
    expect(row.reportedHealth).toBe('unknown');
  });

  // NEGATIVE CONTROL: a fresh source within the horizon keeps full confidence and reportable health.
  it('NEGATIVE CONTROL: a fresh source reports its observed health at full confidence', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const row = reg
      .currentStateView((T0 + HORIZON - MIN) as EpochMillis)
      .find((r) => r.sourceId === id)!;
    expect(row.staleness).toBe('fresh');
    expect(row.confidence).toBe(1);
    expect(row.reportedHealth).toBe('healthy');
  });
});

// ===========================================================================
// AC5 — Unregistered source ADDED to the catalog with discovery evidence.
// ===========================================================================

describe('AC5 unregistered governance-relevant source ADDED to catalog with discovery evidence', () => {
  it('discover() adds a catalog entry with evidence, unknown class, location, access, onboarding', () => {
    const reg = newRegistry();
    const evidence = uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM);
    const entry = reg.discover({
      externalKey: 'mystery-db',
      // no sourceClass ⇒ classified as UNKNOWN.
      location: 'pg://mystery',
      accessState: 'reachable',
      sensitivity: 'sensitive',
      discoveryEvidence: evidence,
      at: T0,
    });
    // Independently re-readable in the catalog (mutation response is not the proof).
    const readBack = reg.catalog().find((e) => e.id === entry.id)!;
    expect(readBack.sourceClass).toBe(UNKNOWN_SOURCE_CLASS);
    expect(readBack.discoveryEvidence).toBe(evidence);
    expect(readBack.observedLocations).toContain('pg://mystery');
    expect(readBack.accessState).toBe('reachable');
    expect(readBack.sensitivity).toBe('sensitive');
    expect(readBack.onboardingState).toBe('discovered');
    // Ownership status is a gap until a steward is assigned.
    expect(catalogEntryHasOwnershipGap(readBack)).toBe(true);
    // A row also appears in the current-state view flagged unknown.
    const row = reg.currentStateView(T0).find((r) => r.sourceId === entry.id)!;
    expect(row.classifiedUnknown).toBe(true);
    expect(row.discoveryEvidence).toBe(evidence);
  });

  it('re-discovering an existing source is idempotent (no duplicate row) and merges a location', () => {
    const reg = newRegistry();
    const evidence = uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM);
    const first = reg.discover({
      externalKey: 'mystery-db',
      location: 'pg://mystery',
      discoveryEvidence: evidence,
      at: T0,
    });
    const second = reg.discover({
      externalKey: 'mystery-db',
      location: 'pg://mystery-replica',
      discoveryEvidence: evidence,
      at: (T0 + MIN) as EpochMillis,
    });
    expect(second.id).toBe(first.id);
    expect(reg.catalog()).toHaveLength(1);
    expect(second.observedLocations).toEqual(['pg://mystery', 'pg://mystery-replica']);
    expect(second.lastSeenAt).toBe(T0 + MIN);
  });

  // NEGATIVE CONTROL: discovery requires discovery evidence — an undefined id is rejected.
  it('NEGATIVE CONTROL: discover() without valid discovery evidence is rejected', () => {
    const reg = newRegistry();
    expect(() =>
      reg.discover({
        externalKey: 'x',
        location: 'svc://x',
        // @ts-expect-error deliberately invalid evidence
        discoveryEvidence: 'not-a-uuid',
        at: T0,
      }),
    ).toThrow();
  });
});

// ===========================================================================
// AC6 — Discovered source stays a VISIBLE governed-source gap w/ review-or-expiry.
// ===========================================================================

describe('AC6 unsupported/inaccessible/sensitive/unowned/excluded source stays a VISIBLE gap', () => {
  it('assessCoverage synthesises a governed_source gap w/ review for each condition', () => {
    const reg = newRegistry();
    // Unowned + unknown + inaccessible + unsupported all at once.
    const e = reg.discover({
      externalKey: 'legacy',
      location: 'ssh://legacy',
      accessState: 'inaccessible',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    reg.registerContract({ sourceId: e.id, version: 1, supportLevel: 'unsupported', at: T0 });

    const gaps = reg.assessCoverage({ at: T0 });
    const mine = gaps.filter((g) => g.subjectId === e.id && g.gapClass === 'governed_source');
    const reasons = new Set(mine.map((g) => g.reason));
    expect(reasons.has('unsupported')).toBe(true);
    expect(reasons.has('inaccessible')).toBe(true);
    expect(reasons.has('unowned')).toBe(true);
    // Every governed-source gap is VISIBLE, has owner action + impact, and a review-or-expiry.
    for (const g of mine) {
      expect(gapIsVisible(g)).toBe(true);
      expect(g.requiredAction.length).toBeGreaterThan(0);
      expect(g.impact).not.toBe('unknown');
      expect(gapHasReviewOrExpiry(g)).toBe(true);
    }
  });

  it('exclude() keeps the source visible as a governed_source gap with a scheduled review', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    const { entry, gap } = reg.exclude({
      sourceId: id,
      reason: makeReason('deprecated_by_owner', 'Owner retired this integration'),
      requiredAction: 'Confirm the exclusion at the next quarterly review.',
      reviewAt: (T0 + 90 * 24 * 60 * MIN) as EpochMillis,
      at: T0,
    });
    // Not deleted: transitioned to excluded AND still queryable.
    expect(entry.onboardingState).toBe('excluded');
    expect(reg.catalog().some((x) => x.id === id)).toBe(true);
    expect(gap.gapClass).toBe('governed_source');
    expect(gap.reason).toBe('excluded');
    expect(gapHasReviewOrExpiry(gap)).toBe(true);
    // Independently re-readable as a visible gap for the source.
    expect(reg.gapsForSource(id).some((g) => g.id === gap.id && gapIsVisible(g))).toBe(true);
  });

  it('assessCoverage is idempotent per (source, reason)', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 'legacy',
      location: 'ssh://legacy',
      accessState: 'inaccessible',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    const first = reg.assessCoverage({ at: T0 }).filter((g) => g.subjectId === e.id).length;
    const second = reg
      .assessCoverage({ at: (T0 + MIN) as EpochMillis })
      .filter((g) => g.subjectId === e.id).length;
    expect(second).toBe(first);
  });

  it('exclude() without a review-or-expiry deadline is rejected (AC6 review requirement)', () => {
    const reg = newRegistry();
    const id = onboardHealthy(reg, 'kanban', 'kanban', T0);
    expect(() =>
      reg.exclude({
        sourceId: id,
        reason: makeReason('deprecated_by_owner', 'x'),
        requiredAction: 'do something',
        at: T0,
      }),
    ).toThrow();
  });

  // NEGATIVE CONTROL: a supported, owned, accessible, onboarded source has NO governed_source gap.
  it('NEGATIVE CONTROL: a fully governed source produces no governed_source gap', () => {
    const reg = newRegistry();
    onboardHealthy(reg, 'kanban', 'kanban', T0);
    const gaps = reg.assessCoverage({ at: T0 });
    expect(gaps.filter((g) => g.gapClass === 'governed_source')).toHaveLength(0);
  });
});

// ===========================================================================
// Lifecycle guard — the onboarding state machine bites (non-vacuous).
// ===========================================================================

describe('onboarding lifecycle guard', () => {
  it('permits declared transitions and rejects illegal ones', () => {
    expect(canOnboardingTransition('discovered', 'pending')).toBe(true);
    expect(canOnboardingTransition('pending', 'onboarded')).toBe(true);
    expect(canOnboardingTransition('discovered', 'onboarded')).toBe(false);
    expect(canOnboardingTransition('retired', 'pending')).toBe(false);
    expect(() => assertOnboardingTransition('discovered', 'onboarded')).toThrow();
  });

  it('cannot onboard a source lacking a contract or an owner (fail-visible)', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 's',
      location: 'svc://s',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    reg.transitionOnboarding({ sourceId: e.id, to: 'pending', at: T0 });
    // No contract, no owner ⇒ onboarding rejected.
    expect(() => reg.transitionOnboarding({ sourceId: e.id, to: 'onboarded', at: T0 })).toThrow();
  });
});

// ===========================================================================
// Contract registration — versioned + validated, append-only lineage.
// ===========================================================================

describe('source-contract registration (versioned + validated, append-only)', () => {
  it('appends monotonically-increasing versions and keeps the full lineage', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 's',
      location: 'svc://s',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    reg.registerContract({ sourceId: e.id, version: 1, at: T0 });
    reg.registerContract({ sourceId: e.id, version: 2, supportLevel: 'deprecated', at: T0 });
    expect(reg.contracts(e.id).map((c) => c.version)).toEqual([1, 2]);
    expect(reg.latestContract(e.id)!.supportLevel).toBe('deprecated');
  });

  it('re-registering an identical version is idempotent', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 's',
      location: 'svc://s',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    reg.registerContract({ sourceId: e.id, version: 1, supportLevel: 'supported', at: T0 });
    reg.registerContract({ sourceId: e.id, version: 1, supportLevel: 'supported', at: T0 });
    expect(reg.contracts(e.id)).toHaveLength(1);
  });

  it('re-registering the same version with a different payload is a conflict (rejected)', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 's',
      location: 'svc://s',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    reg.registerContract({ sourceId: e.id, version: 1, supportLevel: 'supported', at: T0 });
    expect(() =>
      reg.registerContract({ sourceId: e.id, version: 1, supportLevel: 'unsupported', at: T0 }),
    ).toThrow();
  });

  // NEGATIVE CONTROL: a non-increasing version is rejected (the monotonicity rule bites).
  it('NEGATIVE CONTROL: a version that does not strictly increase is rejected', () => {
    const reg = newRegistry();
    const e = reg.discover({
      externalKey: 's',
      location: 'svc://s',
      discoveryEvidence: uuidV7((T0 + 1) as EpochMillis, FIXED_RANDOM),
      at: T0,
    });
    reg.registerContract({ sourceId: e.id, version: 2, at: T0 });
    expect(() => reg.registerContract({ sourceId: e.id, version: 1, at: T0 })).toThrow();
  });
});
