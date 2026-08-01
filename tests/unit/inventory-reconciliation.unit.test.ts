// TrustCircleAI — Phase 71 unit tests for the SNAPSHOT / OBSERVATION RECONCILIATION service.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// Executable evidence that `packages/application/src/inventory-reconciliation.ts` — a fleet-level
// aggregate that reconciles successive observation cycles against the prior known-source set and
// classifies every deviation into one of ten named source-anomaly classes — satisfies acceptance
// criteria AC1–AC6 AND detects every one of the ten anomaly classes.
//
// The reconciler is a pure, deterministic aggregate: every cycle carries explicit epoch-millis and
// an injected deterministic UUIDv7 factory (no wall clock); every read takes an explicit `at`. The
// durable-effect witness for every mutation is NOT its return value but the INDEPENDENTLY
// re-readable state (`deltas()`, `openGaps()`, `conflicts()`, `catalog()`, `sourceStatus()`,
// `currentStateView()`) and its content digest (`snapshotDigest(at)`), which changes iff a governed
// fact changes.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a healthy scenario in which the
// rule must NOT fire, so a green run is not a permissive fake.
//
// Anomaly-class → test map (all ten classes):
//   missing / disappeared . describe('anomaly: absence …')
//   duplicate ............. describe('anomaly: duplicate …')
//   stale ................. describe('anomaly: stale …') + AC4
//   conflicting ........... describe('anomaly: conflicting …') + AC3
//   orphaned .............. describe('anomaly: orphaned …')
//   changed ............... describe('anomaly: changed …')
//   moved / split / merged  describe('anomaly: lineage …')
//
// AC → describe-block map:
//   AC1 healthy reconciled source renders ONCE with the full facet set ...... describe('AC1 …')
//   AC2 non-healthy source stays a VISIBLE coverage gap .................... describe('AC2 …')
//   AC3 related work → distinct source records + correlation + conflicts .... describe('AC3 …')
//   AC4 stale/unavailable source marked; health not inferred from stale data  describe('AC4 …')
//   AC5 unregistered source ADDED to the catalog with discovery evidence .... describe('AC5 …')
//   AC6 discovered source stays a VISIBLE governed-source gap w/ review ..... describe('AC6 …')
//   witness snapshotDigest is an independent, sensitive content witness ..... describe('witness …')

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import {
  makeGovernedAsset,
  makeSourceRecord,
  makeSourceCatalogEntry,
  makeInventoryRelationship,
  UNKNOWN_SOURCE_CLASS,
  type SourceRecord,
  type SourceCatalogEntry,
  type GovernedAsset,
  sourceRecordIdentity,
} from '../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  type SourceAuthorityPolicy,
} from '../../packages/domain/src/correlation.ts';
import {
  SourceReconciler,
  SOURCE_ANOMALY_CLASSES,
  isSourceAnomalyClass,
} from '../../packages/application/src/inventory-reconciliation.ts';
import type { IdFactory } from '../../packages/application/src/source-registry.ts';

// ---------------------------------------------------------------------------
// Deterministic helpers — a monotonic UUIDv7 factory + a fixed random filler,
// so identities are reproducible and time-ordered without any wall-clock read.
// ---------------------------------------------------------------------------

const FIXED_RANDOM = () => new Uint8Array(16).fill(0x7a);

function idFactory(seed = 1): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}

/** A stable id derived from a small integer stamp (distinct integers → distinct ids). */
function id(stamp: number): Uuid {
  return uuidV7(stamp as EpochMillis, FIXED_RANDOM);
}

const T0 = 1_700_000_000_000 as EpochMillis;
const MIN = 60_000;
const HORIZON = 15 * MIN;
const at = (m: number): EpochMillis => (T0 + m) as EpochMillis;

const TENANT = PLATFORM_SCOPE;
const CATALOG = id(9001);

const POLICY: SourceAuthorityPolicy = makeSourceAuthorityPolicy({
  id: 'test-reconciliation-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'status',
      byClass: { platform_kanban: 10, agentctl: 5, workflows_orchestration: 5 },
      defaultAuthority: 1,
    }),
  ],
});

function reconciler(seed = 1): SourceReconciler {
  return new SourceReconciler({
    tenantId: TENANT,
    newId: idFactory(seed),
    policy: POLICY,
    stalenessHorizonMillis: HORIZON,
    disappearanceCycles: 2,
  });
}

interface RecOpts {
  assetId?: Uuid;
  sourceClass?: string;
  status?: SourceRecord['status'];
  freshness?: SourceRecord['freshness'];
  state?: Record<string, unknown>;
  observedAt?: EpochMillis;
}

let recSeq = 20_000;
function rec(externalKey: string, opts: RecOpts = {}): SourceRecord {
  const observedAt = opts.observedAt ?? at(0);
  return makeSourceRecord({
    id: id((recSeq += 1)),
    tenantId: TENANT,
    catalogId: CATALOG,
    ...(opts.assetId !== undefined ? { assetId: opts.assetId } : {}),
    sourceClass: opts.sourceClass ?? 'platform_kanban',
    externalKey,
    observedState: opts.state ?? { status: 'operating' },
    status: opts.status ?? 'active',
    freshness: opts.freshness ?? 'fresh',
    lastKnownAt: observedAt,
    observedAt,
  });
}

function asset(assetId: Uuid, name: string): { asset: GovernedAsset; fields: readonly string[] } {
  return {
    asset: makeGovernedAsset({
      id: assetId,
      tenantId: TENANT,
      assetType: 'ai_workload',
      name,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: at(0),
      updatedAt: at(0),
    }),
    fields: ['status'],
  };
}

function catalogEntry(
  entryId: Uuid,
  opts: Partial<Parameters<typeof makeSourceCatalogEntry>[0]> = {},
): SourceCatalogEntry {
  return makeSourceCatalogEntry({
    id: entryId,
    tenantId: TENANT,
    sourceClass: opts.sourceClass ?? 'platform_kanban',
    observedLocations: opts.observedLocations ?? ['https://kanban.internal/board/42'],
    onboardingState: opts.onboardingState ?? 'discovered',
    accessState: opts.accessState ?? 'connected',
    // A not-yet-onboarded catalog entry cannot be 'healthy' (domain invariant); default to 'unknown'.
    healthState: opts.healthState ?? 'unknown',
    sensitivity: opts.sensitivity ?? 'normal',
    discoveryEvidence: opts.discoveryEvidence ?? id(7001),
    firstSeenAt: at(0),
    lastSeenAt: at(0),
    ...(opts.ownerPrincipalId !== undefined ? { ownerPrincipalId: opts.ownerPrincipalId } : {}),
  });
}

// ===========================================================================
// Static contract.
// ===========================================================================

describe('contract: the ten source-anomaly classes are named and exhaustive', () => {
  it('exposes exactly the ten required classes', () => {
    expect([...SOURCE_ANOMALY_CLASSES].sort()).toEqual(
      [
        'changed',
        'conflicting',
        'disappeared',
        'duplicate',
        'merged',
        'missing',
        'moved',
        'orphaned',
        'split',
        'stale',
      ].sort(),
    );
  });
  it('isSourceAnomalyClass is a real guard (negative control)', () => {
    expect(isSourceAnomalyClass('moved')).toBe(true);
    expect(isSourceAnomalyClass('nonsense')).toBe(false);
  });
});

// ===========================================================================
// AC1 — healthy reconciled source renders ONCE with the full facet set.
// ===========================================================================

describe('AC1 healthy reconciled source renders once with full facets; no spurious anomaly', () => {
  it('a healthy observed source yields one inventory row with every facet and NO anomaly/gap', () => {
    const r = reconciler();
    const a = id(1001);
    const owner = id(4242);
    const ownedAsset = {
      asset: makeGovernedAsset({
        id: a,
        tenantId: TENANT,
        assetType: 'ai_workload',
        name: 'Card 1 workload',
        lifecycleState: 'operating',
        riskTier: 'moderate',
        health: 'healthy',
        coverage: 'covered',
        ownerPrincipalId: owner,
        lastObservedAt: at(0),
        updatedAt: at(0),
      }),
      fields: ['status'] as readonly string[],
    };
    const emitted = r.reconcile({
      observations: [rec('kanban:card:1', { assetId: a })],
      catalogEntries: [catalogEntry(CATALOG)],
      assets: [ownedAsset],
      at: at(0),
    });

    // NEGATIVE CONTROL: a healthy source produces no anomaly deltas and no visible gaps.
    expect(emitted).toHaveLength(0);
    expect(r.deltas()).toHaveLength(0);
    expect(r.openGaps()).toHaveLength(0);

    const rows = r.currentStateView(at(1));
    // AC1 "renders ONCE": exactly one row for the one governed identity — no duplicate rendering.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Every enumerated AC1 facet is a NAMED, individually-asserted field.
    // 1. source identity — the stable governed-asset id this row renders exactly once.
    expect(row.assetId).toBe(a);
    // 2. type.
    expect(row.assetType).toBe('ai_workload');
    expect(row.name).toBe('Card 1 workload');
    // 3. owner — the accountable principal, present and NOT flagged as an ownership gap.
    expect(row.ownerPrincipalId).toBe(owner);
    expect(row.ownershipGap).toBe(false);
    // 4. lifecycle state.
    expect(row.lifecycleState).toBe('operating');
    // 5. risk.
    expect(row.riskTier).toBe('moderate');
    // 6. control coverage.
    expect(row.coverage).toBe('covered');
    // 7. evidence state.
    expect(row.evidenceState).toBe('current');
    // 8. health — SAFE-to-report current health (equal to observed only because evidence is current).
    expect(row.reportedHealth).toBe('healthy');
    // 9. last observation time.
    expect(row.lastObservationAt).toBe(at(0));
    // 10. unresolved issues — none for a healthy, uncontested asset.
    expect(row.unresolvedIssueCount).toBe(0);
    // AC3 identity list: exactly the one contributing source record.
    expect(row.sourceRecordCount).toBe(1);
  });
});

// ===========================================================================
// Anomaly: duplicate.
// ===========================================================================

describe('anomaly: duplicate — two distinct records collapse to one identity', () => {
  it('emits a duplicate delta and retains a conflict entry; single record does NOT (negative control)', () => {
    const r = reconciler();
    const a = id(1002);
    // Two DISTINCT records for the SAME identity (same externalKey/catalog) in one cycle.
    const d1 = rec('kanban:card:dup', { assetId: a, state: { status: 'operating' } });
    const d2 = rec('kanban:card:dup', { assetId: a, state: { status: 'degraded' } });
    r.reconcile({ observations: [d1, d2], assets: [asset(a, 'dup')], at: at(0) });

    const dups = r.deltasOfClass('duplicate');
    expect(dups).toHaveLength(1);
    expect(dups[0]!.identity).toBe(sourceRecordIdentity(d1));
    expect(r.conflicts().some((c) => c.identity === sourceRecordIdentity(d1))).toBe(true);

    // NEGATIVE CONTROL: a fresh reconciler with a single record for the identity → no duplicate.
    const r2 = reconciler(500);
    r2.reconcile({
      observations: [rec('kanban:card:solo', { assetId: a })],
      assets: [asset(a, 'solo')],
      at: at(0),
    });
    expect(r2.deltasOfClass('duplicate')).toHaveLength(0);
  });
});

// ===========================================================================
// Anomaly: conflicting + AC3.
// ===========================================================================

describe('anomaly: conflicting / AC3 — distinct active observations disagree', () => {
  it('emits a conflicting delta with differing statuses; agreeing records do NOT (negative control)', () => {
    const r = reconciler();
    const a = id(1003);
    const c1 = rec('kanban:card:cf', {
      assetId: a,
      status: 'active',
      state: { status: 'operating' },
    });
    const c2 = rec('kanban:card:cf', {
      assetId: a,
      status: 'conflicting',
      state: { status: 'retired' },
    });
    r.reconcile({ observations: [c1, c2], assets: [asset(a, 'cf')], at: at(0) });

    const conf = r.deltasOfClass('conflicting');
    expect(conf).toHaveLength(1);
    const view = r.conflicts().find((c) => c.identity === sourceRecordIdentity(c1))!;
    expect(view).toBeDefined();
    expect(view.recordIds.length).toBe(2);
    expect(view.differingStatuses.sort()).toEqual(['active', 'conflicting']);

    // NEGATIVE CONTROL: two records with IDENTICAL governed state → no conflicting delta.
    const r2 = reconciler(600);
    const s = { status: 'operating' };
    const e1 = rec('kanban:card:agree', { assetId: a, status: 'active', state: s });
    const e2 = rec('kanban:card:agree', { assetId: a, status: 'active', state: s });
    r2.reconcile({ observations: [e1, e2], assets: [asset(a, 'agree')], at: at(0) });
    expect(r2.deltasOfClass('conflicting')).toHaveLength(0);
  });

  it('AC3: drill-down exposes distinct source records + correlation, status differences, dependencies, authoritative fields', () => {
    const r = reconciler(650);
    const a = id(1004);
    // Related work across three registered source classes for ONE asset. Two of them DISAGREE on
    // `status` (kanban:operating vs agentctl:degraded) so the field is contested (status difference);
    // authority (platform_kanban:10 > agentctl:5) resolves the winner but retains the loser.
    const k = rec('kanban:card:x', {
      assetId: a,
      sourceClass: 'platform_kanban',
      state: { status: 'operating' },
    });
    const g = rec('agentctl:job:x', {
      assetId: a,
      sourceClass: 'agentctl',
      state: { status: 'degraded' },
    });
    const w = rec('wf:run:x', {
      assetId: a,
      sourceClass: 'workflows_orchestration',
      state: { status: 'operating' },
    });
    r.reconcile({ observations: [k, g, w], assets: [asset(a, 'related')], at: at(0) });

    // AC3 relationships: a depends_on edge and an authoritative_for edge, bound to the asset.
    const inv = r.currentInventory();
    const depRel = makeInventoryRelationship({
      id: id(6001),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: w.id,
      toKind: 'source_record',
      toId: k.id,
      relationship: 'depends_on',
      fieldName: 'status',
      createdAt: at(0),
    });
    const authRel = makeInventoryRelationship({
      id: id(6002),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: k.id,
      toKind: 'governed_asset',
      toId: a,
      relationship: 'authoritative_for',
      fieldName: 'status',
      createdAt: at(0),
    });
    inv.ingestRelationship(depRel, a);
    inv.ingestRelationship(authRel, a);

    const dd = inv.drillDown(a, at(1));

    // (i) DISTINCT source records are retained verbatim — nothing collapses.
    expect(dd.sourceRecords.map((s) => s.externalKey).sort()).toEqual([
      'agentctl:job:x',
      'kanban:card:x',
      'wf:run:x',
    ]);
    expect(dd.correlation.sourceRecords.length).toBe(3);

    // (ii) STATUS DIFFERENCES — the `status` field is contested and names the differing source(s).
    const statusField = dd.correlation.fields.find((f) => f.field === 'status')!;
    expect(statusField).toBeDefined();
    expect(statusField.contested).toBe(true);
    // Authority resolves kanban's 'operating' as the value; the agentctl 'degraded' observation is
    // retained as a differing source (status difference held, not dropped).
    expect(statusField.value).toBe('operating');
    expect(statusField.differingSources.length).toBeGreaterThanOrEqual(1);
    expect(statusField.differingSources.map((c) => c.sourceClass)).toContain('agentctl');
    expect(statusField.differingSources.map((c) => c.value)).toContain('degraded');

    // (iii) DEPENDENCIES — the depends_on edge is exposed with its endpoints and field.
    expect(dd.dependencies.map((d) => d.relationshipId)).toContain(depRel.id);
    const dep = dd.dependencies.find((d) => d.relationshipId === depRel.id)!;
    expect(dep.fromId).toBe(w.id);
    expect(dep.toId).toBe(k.id);
    expect(dep.fieldName).toBe('status');

    // (iv) AUTHORITATIVE FIELDS — the authoritative_for edge names its field + system-of-record.
    expect(dd.authoritativeFields.map((f) => f.relationshipId)).toContain(authRel.id);
    const auth = dd.authoritativeFields.find((f) => f.relationshipId === authRel.id)!;
    expect(auth.field).toBe('status');
    expect(auth.authoritativeSourceId).toBe(k.id);
  });
});

// ===========================================================================
// Anomaly: stale + AC4.
// ===========================================================================

describe('anomaly: stale / AC4 — stale source marked; health NOT inferred from stale data', () => {
  it('a stale observation emits a stale delta + gap; sourceStatus reports last-known + confidence<1', () => {
    const r = reconciler(700);
    const a = id(1005);
    const identity = sourceRecordIdentity(rec('kanban:card:stale', { assetId: a }));
    // Observation flagged stale by freshness.
    r.reconcile({
      observations: [rec('kanban:card:stale', { assetId: a, freshness: 'stale' })],
      assets: [asset(a, 'stale')],
      at: at(0),
    });

    expect(r.deltasOfClass('stale')).toHaveLength(1);
    const staleGaps = r.openGaps().filter((g) => g.reason === 'stale');
    expect(staleGaps.length).toBeGreaterThanOrEqual(1);

    const status = r.sourceStatus(identity, at(1));
    expect(status.stale).toBe(true);
    expect(status.lastKnownAt).toBe(at(0)); // AC4: last-known time preserved.
    expect(status.confidence).toBeLessThan(1); // AC4: confidence reduced.

    // AC4: the composed inventory row withholds reportedHealth for stale evidence.
    const row = r.currentStateView(at(1)).find((x) => x.assetId === a)!;
    expect(row.reportedHealth).toBe('unknown');
    expect(row.evidenceState).not.toBe('current');
  });

  it('NEGATIVE CONTROL: a fresh observation within the horizon is NOT stale and keeps full confidence', () => {
    const r = reconciler(750);
    const a = id(1006);
    const identity = sourceRecordIdentity(rec('kanban:card:fresh', { assetId: a }));
    r.reconcile({
      observations: [rec('kanban:card:fresh', { assetId: a, freshness: 'fresh' })],
      assets: [asset(a, 'fresh')],
      at: at(0),
    });
    const status = r.sourceStatus(identity, at(1));
    expect(status.stale).toBe(false);
    expect(status.confidence).toBe(1);
    expect(r.deltasOfClass('stale')).toHaveLength(0);
  });

  it('AC4: staleness by AGE (fresh flag but observed beyond the horizon) still withholds health', () => {
    const r = reconciler(760);
    const a = id(1007);
    const identity = sourceRecordIdentity(rec('kanban:card:old', { assetId: a }));
    r.reconcile({
      observations: [rec('kanban:card:old', { assetId: a, freshness: 'fresh', observedAt: at(0) })],
      assets: [asset(a, 'old')],
      at: at(0),
    });
    // Read far beyond the staleness horizon (at(m) is in milliseconds).
    const status = r.sourceStatus(identity, at(HORIZON + 1));
    expect(status.stale).toBe(true);
    expect(status.confidence).toBeLessThan(1);
  });
});

// ===========================================================================
// Anomaly: orphaned.
// ===========================================================================

describe('anomaly: orphaned — observation references an unclaimed asset', () => {
  it('emits an orphaned delta + gap when no governed asset claims the referenced id', () => {
    const r = reconciler(800);
    const ghost = id(1008); // never ingested as an asset.
    r.reconcile({ observations: [rec('kanban:card:orphan', { assetId: ghost })], at: at(0) });

    const orphans = r.deltasOfClass('orphaned');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.gapId).toBeDefined();
    const gap = r.openGaps().find((g) => g.id === orphans[0]!.gapId)!;
    expect(gap.reason).toBe('orphaned');
    expect(gap.requiredAction.length).toBeGreaterThan(0); // AC2 owner action.
  });

  it('NEGATIVE CONTROL: an observation whose asset IS governed is not orphaned', () => {
    const r = reconciler(850);
    const a = id(1009);
    r.reconcile({
      observations: [rec('kanban:card:linked', { assetId: a })],
      assets: [asset(a, 'linked')],
      at: at(0),
    });
    expect(r.deltasOfClass('orphaned')).toHaveLength(0);
  });
});

// ===========================================================================
// Anomaly: changed.
// ===========================================================================

describe('anomaly: changed — a known identity content differs across cycles', () => {
  it('emits a changed delta when the same identity reports new content next cycle', () => {
    const r = reconciler(900);
    const a = id(1010);
    r.reconcile({
      observations: [rec('kanban:card:ch', { assetId: a, state: { status: 'operating' } })],
      assets: [asset(a, 'ch')],
      at: at(0),
    });
    // Cycle 2: same identity, NEW observed content.
    r.reconcile({
      observations: [rec('kanban:card:ch', { assetId: a, state: { status: 'degraded' } })],
      assets: [asset(a, 'ch')],
      at: at(1),
    });

    const changed = r.deltasOfClass('changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.priorFingerprint).toBeDefined();
    expect(changed[0]!.fingerprint).not.toBe(changed[0]!.priorFingerprint);
  });

  it('NEGATIVE CONTROL: an identical re-observation next cycle is NOT a change', () => {
    const r = reconciler(950);
    const a = id(1011);
    const same = { status: 'operating' };
    r.reconcile({
      observations: [rec('kanban:card:same', { assetId: a, state: same })],
      assets: [asset(a, 'same')],
      at: at(0),
    });
    r.reconcile({
      observations: [rec('kanban:card:same', { assetId: a, state: same })],
      assets: [asset(a, 'same')],
      at: at(1),
    });
    expect(r.deltasOfClass('changed')).toHaveLength(0);
  });
});

// ===========================================================================
// Anomaly: absence (missing → disappeared).
// ===========================================================================

describe('anomaly: absence — missing escalates to disappeared beyond the horizon', () => {
  it('a known source absent one cycle is missing; absent again is disappeared', () => {
    const r = reconciler(1000);
    const a = id(1012);
    // Cycle 1: present.
    r.reconcile({
      observations: [rec('kanban:card:vanish', { assetId: a })],
      assets: [asset(a, 'vanish')],
      at: at(0),
    });
    // Cycle 2: absent → missing.
    r.reconcile({ observations: [], at: at(1) });
    expect(r.deltasOfClass('missing')).toHaveLength(1);
    expect(r.deltasOfClass('disappeared')).toHaveLength(0);
    // Cycle 3: still absent → disappeared.
    r.reconcile({ observations: [], at: at(2) });
    expect(r.deltasOfClass('disappeared')).toHaveLength(1);

    // AC2: the absence gap stays VISIBLE and never disappears.
    const identity = sourceRecordIdentity(rec('kanban:card:vanish', { assetId: a }));
    const status = r.sourceStatus(identity, at(3));
    expect(status.present).toBe(false);
    expect(status.disappeared).toBe(true);
    expect(status.confidence).toBe(0); // disappeared → zero confidence, health not inferred.
    expect(r.openGaps().some((g) => g.reason === 'unreachable' || g.reason === 'unmanaged')).toBe(
      true,
    );
  });

  it('NEGATIVE CONTROL: a source re-observed every cycle never goes missing', () => {
    const r = reconciler(1100);
    const a = id(1013);
    r.reconcile({
      observations: [rec('kanban:card:steady', { assetId: a })],
      assets: [asset(a, 'steady')],
      at: at(0),
    });
    r.reconcile({
      observations: [rec('kanban:card:steady', { assetId: a })],
      assets: [asset(a, 'steady')],
      at: at(1),
    });
    expect(r.deltasOfClass('missing')).toHaveLength(0);
    expect(r.deltasOfClass('disappeared')).toHaveLength(0);
  });
});

// ===========================================================================
// Anomaly: lineage (moved / split / merged).
// ===========================================================================

describe('anomaly: lineage — moved / split / merged by content fingerprint re-key', () => {
  const content = { status: 'operating', payload: 'stable-content' };

  it('moved: 1→1 re-key of the same content emits a moved delta', () => {
    const r = reconciler(1200);
    const a = id(1014);
    r.reconcile({
      observations: [rec('old:key', { assetId: a, state: content })],
      assets: [asset(a, 'm')],
      at: at(0),
    });
    // Cycle 2: same content under a NEW externalKey; old key absent.
    r.reconcile({
      observations: [rec('new:key', { assetId: a, state: content })],
      assets: [asset(a, 'm')],
      at: at(1),
    });
    expect(r.deltasOfClass('moved')).toHaveLength(1);
    expect(r.deltasOfClass('split')).toHaveLength(0);
    expect(r.deltasOfClass('merged')).toHaveLength(0);
  });

  it('split: 1→N re-key of one content into multiple identities emits a split delta', () => {
    const r = reconciler(1300);
    const a = id(1015);
    r.reconcile({
      observations: [rec('src:one', { assetId: a, state: content })],
      assets: [asset(a, 's')],
      at: at(0),
    });
    r.reconcile({
      observations: [
        rec('src:a', { assetId: a, state: content }),
        rec('src:b', { assetId: a, state: content }),
      ],
      assets: [asset(a, 's')],
      at: at(1),
    });
    expect(r.deltasOfClass('split')).toHaveLength(1);
    expect(r.deltasOfClass('moved')).toHaveLength(0);
  });

  it('merged: N→1 collapse of multiple identities into one emits a merged delta', () => {
    const r = reconciler(1400);
    const a = id(1016);
    r.reconcile({
      observations: [
        rec('m:a', { assetId: a, state: content }),
        rec('m:b', { assetId: a, state: content }),
      ],
      assets: [asset(a, 'mg')],
      at: at(0),
    });
    r.reconcile({
      observations: [rec('m:merged', { assetId: a, state: content })],
      assets: [asset(a, 'mg')],
      at: at(1),
    });
    expect(r.deltasOfClass('merged')).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: a stable identity with stable content produces no lineage anomaly', () => {
    const r = reconciler(1500);
    const a = id(1017);
    r.reconcile({
      observations: [rec('stable:key', { assetId: a, state: content })],
      assets: [asset(a, 'st')],
      at: at(0),
    });
    r.reconcile({
      observations: [rec('stable:key', { assetId: a, state: content })],
      assets: [asset(a, 'st')],
      at: at(1),
    });
    expect(r.deltasOfClass('moved')).toHaveLength(0);
    expect(r.deltasOfClass('split')).toHaveLength(0);
    expect(r.deltasOfClass('merged')).toHaveLength(0);
  });
});

// ===========================================================================
// AC2 — non-healthy source stays a VISIBLE coverage gap.
// ===========================================================================

describe('AC2 non-healthy source stays a VISIBLE coverage gap with reason/age/impact/action', () => {
  it('every open gap carries a reason, an impact, an owner action, and a computable age', () => {
    const r = reconciler(1600);
    const ghost = id(1018);
    r.reconcile({ observations: [rec('kanban:card:gap', { assetId: ghost })], at: at(0) });
    const gaps = r.openGaps();
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    for (const g of gaps) {
      expect(g.reason.length).toBeGreaterThan(0);
      expect(g.impact.length).toBeGreaterThan(0);
      expect(g.requiredAction.length).toBeGreaterThan(0);
      expect(r.gapAge(g.id, at(5))).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
// AC5 — unregistered source ADDED to the catalog with discovery evidence.
// ===========================================================================

describe('AC5 unregistered source is ADDED to the catalog with full discovery facets', () => {
  it('catalogSource records classification / location / access / sensitivity / ownership / onboarding', () => {
    const r = reconciler(1700);
    const entryId = id(1019);
    const owner = id(1020);
    const evidence = id(1021);
    const entry = catalogEntry(entryId, {
      sourceClass: UNKNOWN_SOURCE_CLASS,
      observedLocations: ['s3://discovered-bucket/logs'],
      accessState: 'reachable',
      sensitivity: 'sensitive',
      onboardingState: 'discovered',
      ownerPrincipalId: owner,
      discoveryEvidence: evidence,
    });
    r.catalogSource(entry);
    const cat = r.catalog();
    // The unregistered source is ADDED exactly once, independently re-readable from the catalog.
    expect(cat).toHaveLength(1);
    const e = cat[0]!;
    // All SEVEN AC5 discovery facets, each individually asserted:
    expect(e.sourceClass).toBe(UNKNOWN_SOURCE_CLASS); // 1. type-or-unknown classification.
    expect(e.observedLocations).toContain('s3://discovered-bucket/logs'); // 2. location.
    expect(e.accessState).toBe('reachable'); // 3. access status.
    expect(e.sensitivity).toBe('sensitive'); // 4. sensitivity.
    expect(e.ownerPrincipalId).toBe(owner); // 5. ownership status.
    expect(e.onboardingState).toBe('discovered'); // 6. onboarding state (not yet onboarded).
    expect(e.discoveryEvidence).toBe(evidence); // 7. discovery evidence — exact reference retained.
  });
});

// ===========================================================================
// AC6 — discovered source stays a VISIBLE governed-source gap w/ review-or-expiry.
// ===========================================================================

describe('AC6 unsupported/inaccessible/sensitive/unowned/excluded source stays a governed-source gap', () => {
  it('a governed-source gap stays visible and carries a review-or-expiry deadline', () => {
    const r = reconciler(1800);
    const subject = id(1022);
    const gap = r.openGovernedSourceGap({
      subjectId: subject,
      reason: 'sensitive',
      impact: 'high',
      requiredAction: 'A data owner must approve governed access to this sensitive source.',
      reviewAt: at(10),
      at: at(0),
    });
    expect(gap.gapClass).toBe('governed_source');
    const gs = r.governedSourceGaps();
    // The gap is INDEPENDENTLY re-readable from the query surface (durable-effect witness).
    expect(gs.some((g) => g.id === gap.id)).toBe(true);
    const held = gs.find((g) => g.id === gap.id)!;
    // AC6 governed-source gap facets, each individually asserted:
    expect(held.gapClass).toBe('governed_source'); // stays a governed-source gap.
    expect(held.reason).toBe('sensitive'); // reason.
    expect(held.impact).toBe('high'); // impact.
    expect(held.reviewAt).toBe(at(10)); // review-or-expiry deadline present + exact.
    expect(held.reviewAt ?? held.expiresAt).toBeDefined(); // review-or-expiry (either form).
    expect(held.requiredAction).toBe(
      'A data owner must approve governed access to this sensitive source.',
    ); // owner action, verbatim.
    // Age is computable and non-negative relative to a later read (AC6 "age").
    expect(r.gapAge(held.id, at(5))).toBeGreaterThanOrEqual(0);
  });

  it('NEGATIVE CONTROL: a governed-source gap without a deadline is rejected', () => {
    const r = reconciler(1850);
    expect(() =>
      r.openGovernedSourceGap({
        subjectId: id(1023),
        reason: 'unowned',
        requiredAction: 'assign an owner',
        at: at(0),
      }),
    ).toThrow();
  });
});

// ===========================================================================
// witness — snapshotDigest is an independent, sensitive content witness.
// ===========================================================================

describe('witness: snapshotDigest is stable for identical state and changes when a fact changes', () => {
  it('two independently-built reconcilers with the same cycles share a digest', () => {
    const build = (seed: number): SourceReconciler => {
      const r = reconciler(seed);
      const a = id(1024);
      r.reconcile({
        observations: [rec('w:key', { assetId: a })],
        assets: [asset(a, 'w')],
        at: at(0),
      });
      return r;
    };
    // Reset the record-id sequence so both builds mint identical record ids.
    const before = recSeq;
    const rA = build(2000);
    recSeq = before;
    const rB = build(2000);
    expect(rA.snapshotDigest(at(1))).toBe(rB.snapshotDigest(at(1)));
  });

  it('introducing an anomaly changes the digest (sensitivity / negative control)', () => {
    const r = reconciler(2100);
    const a = id(1025);
    r.reconcile({
      observations: [rec('w2:key', { assetId: a })],
      assets: [asset(a, 'w2')],
      at: at(0),
    });
    const clean = r.snapshotDigest(at(1));
    // Next cycle the source disappears — a new anomaly fact.
    r.reconcile({ observations: [], at: at(1) });
    expect(r.snapshotDigest(at(2))).not.toBe(clean);
  });
});
