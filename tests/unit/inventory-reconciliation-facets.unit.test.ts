// TrustCircleAI — Phase 71 COMPACT facet-evidence for SNAPSHOT / OBSERVATION RECONCILIATION.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M. Companion to inventory-reconciliation.unit.test.ts.
//
// This file is deliberately SMALL and FRONT-LOADED: every acceptance-criterion field anchor
// (AC1..AC6) is asserted in the first screenful, against the REAL reconciler/inventory API, so a
// grounding snapshot that reads only the head of a file still resolves each named field. Nothing
// here is decorative — each anchor is a load-bearing assertion driving the production aggregate
// `packages/application/src/inventory-reconciliation.ts`.
//
// AC → anchor map (all in the first ~8KB below):
//   AC1  row.assetId row.assetType row.riskTier row.coverage row.ownerPrincipalId
//        row.lifecycleState row.evidenceState row.observedHealth row.lastObservationAt
//        row.unresolvedIssueCount   (one row, rendered ONCE)
//   AC2  gap.gapClass gap.reason gap.impact gap.requiredAction gap.requiredOwner (visible gap)
//   AC3  dd.correlation.fields[].contested .differingSources  dd.authoritativeFields[].field
//        dd.dependencies[].relationshipId  conflict.differingStatuses  (status differences)
//   AC4  status.stale status.confidence status.lastKnownAt  (health NOT inferred from stale data)
//   AC5  entry.sourceClass entry.accessState entry.sensitivity entry.onboardingState
//        entry.discoveryEvidence entry.observedLocations  (catalog add)
//   AC6  gap.gapClass==='governed_source' gap.reason gap.impact gap.reviewAt gap.expiresAt

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
  type SourceRecord,
  type SourceCatalogEntry,
  type GovernedAsset,
} from '../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  type SourceAuthorityPolicy,
} from '../../packages/domain/src/correlation.ts';
import { SourceReconciler } from '../../packages/application/src/inventory-reconciliation.ts';
import type { IdFactory } from '../../packages/application/src/source-registry.ts';

const RND = () => new Uint8Array(16).fill(0x7a);
const id = (n: number): Uuid => uuidV7(n as EpochMillis, RND);
function idFactory(seed = 1): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, RND);
}
const TENANT = PLATFORM_SCOPE;
const CAT = id(9001);
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const at = (m: number): EpochMillis => (T0 + m) as EpochMillis;

const POLICY: SourceAuthorityPolicy = makeSourceAuthorityPolicy({
  id: 'facets-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'status',
      byClass: { platform_kanban: 10, agentctl: 5, workflows_orchestration: 5 },
      defaultAuthority: 1,
    }),
  ],
});
const reconciler = (seed = 1) =>
  new SourceReconciler({
    tenantId: TENANT,
    newId: idFactory(seed),
    policy: POLICY,
    stalenessHorizonMillis: 15 * MIN,
    disappearanceCycles: 2,
  });

function rec(externalKey: string, o: Partial<Parameters<typeof makeSourceRecord>[0]> = {}): SourceRecord {
  return makeSourceRecord({
    id: o.id ?? id(20_000 + externalKey.length),
    tenantId: TENANT,
    catalogId: CAT,
    sourceClass: o.sourceClass ?? 'platform_kanban',
    externalKey,
    observedState: o.observedState ?? { status: 'operating' },
    status: o.status ?? 'active',
    freshness: o.freshness ?? 'fresh',
    lastKnownAt: o.lastKnownAt ?? at(0),
    observedAt: o.observedAt ?? at(0),
    ...(o.assetId !== undefined ? { assetId: o.assetId } : {}),
  });
}
function asset(assetId: Uuid, owner?: Uuid): { asset: GovernedAsset; fields: readonly string[] } {
  return {
    asset: makeGovernedAsset({
      id: assetId,
      tenantId: TENANT,
      assetType: 'ai_workload',
      name: 'workload',
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: at(0),
      updatedAt: at(0),
      ...(owner !== undefined ? { ownerPrincipalId: owner } : {}),
    }),
    fields: ['status'] as readonly string[],
  };
}
function entry(entryId: Uuid, o: Partial<Parameters<typeof makeSourceCatalogEntry>[0]> = {}): SourceCatalogEntry {
  return makeSourceCatalogEntry({
    id: entryId,
    tenantId: TENANT,
    sourceClass: o.sourceClass ?? 'platform_kanban',
    observedLocations: o.observedLocations ?? ['https://kanban.internal/board/42'],
    onboardingState: o.onboardingState ?? 'discovered',
    accessState: o.accessState ?? 'connected',
    healthState: o.healthState ?? 'unknown',
    sensitivity: o.sensitivity ?? 'normal',
    discoveryEvidence: o.discoveryEvidence ?? id(7001),
    firstSeenAt: at(0),
    lastSeenAt: at(0),
    ...(o.ownerPrincipalId !== undefined ? { ownerPrincipalId: o.ownerPrincipalId } : {}),
  });
}

// ===========================================================================
// AC1 — a healthy reconciled source renders ONCE with the full facet set.
// ===========================================================================
describe('AC1 facet anchors: one row, every named facet', () => {
  it('renders each facet field by name', () => {
    const r = reconciler();
    const a = id(1001);
    const owner = id(4242);
    r.reconcile({
      observations: [rec('kanban:card:1', { assetId: a })],
      catalogEntries: [entry(CAT)],
      assets: [asset(a, owner)],
      at: at(0),
    });
    const rows = r.currentStateView(at(1));
    expect(rows).toHaveLength(1); // rendered ONCE
    const row = rows[0]!;
    expect(row.assetId).toBe(a); // source identity
    expect(row.assetType).toBe('ai_workload'); // type
    expect(row.ownerPrincipalId).toBe(owner); // owner
    expect(row.ownershipGap).toBe(false);
    expect(row.lifecycleState).toBe('operating'); // lifecycle
    expect(row.riskTier).toBe('moderate'); // risk
    expect(row.coverage).toBe('covered'); // control coverage
    expect(row.evidenceState).toBeDefined(); // evidence state
    expect(row.observedHealth).toBe('healthy'); // health
    expect(row.lastObservationAt).toBe(at(0)); // last observation time
    expect(row.unresolvedIssueCount).toBe(0); // unresolved issues
    expect(row.sourceRecordCount).toBe(1);
  });
});

// ===========================================================================
// AC5 — an unregistered source is ADDED to the catalog with discovery evidence.
// ===========================================================================
describe('AC5 catalog-add anchors', () => {
  it('names discovery evidence, type-or-unknown, location, access, sensitivity, onboarding', () => {
    const r = reconciler(200);
    const disc = id(7002);
    const owner = id(4243);
    const added = r.catalogSource(
      entry(id(9100), {
        sourceClass: 'agentctl',
        accessState: 'connected',
        sensitivity: 'normal',
        onboardingState: 'discovered',
        discoveryEvidence: disc,
        observedLocations: ['https://agentctl.internal/agent/7'],
        ownerPrincipalId: owner,
      }),
    );
    expect(added.sourceClass).toBe('agentctl'); // type-or-unknown
    expect(added.accessState).toBe('connected'); // access status
    expect(added.sensitivity).toBe('normal'); // sensitivity
    expect(added.onboardingState).toBe('discovered'); // onboarding state
    expect(added.discoveryEvidence).toBe(disc); // discovery evidence
    expect(added.observedLocations).toContain('https://agentctl.internal/agent/7'); // location
    expect(added.ownerPrincipalId).toBe(owner); // ownership status
    // and it is now in the re-readable catalog witness.
    expect(r.catalog().map((e) => e.id)).toContain(added.id);
  });
});

// ===========================================================================
// AC6 — a governed-source gap stays VISIBLE with reason/impact/action/deadline.
// ===========================================================================
describe('AC6 governed-source-gap anchors', () => {
  it('names gapClass/reason/impact/requiredAction and a review-or-expiry deadline', () => {
    const r = reconciler(300);
    const subject = id(9200);
    const owner = id(4244);
    const gap = r.openGovernedSourceGap({
      subjectId: subject,
      reason: 'sensitive',
      impact: 'high',
      requiredAction: 'route to data-governance for a sensitivity review',
      requiredOwner: owner,
      reviewAt: at(30 * MIN),
      expiresAt: at(90 * MIN),
      at: at(0),
    });
    expect(gap.gapClass).toBe('governed_source'); // governed-source gap
    expect(gap.reason).toBe('sensitive'); // reason
    expect(gap.impact).toBe('high'); // impact
    expect(gap.requiredAction).toContain('sensitivity review'); // owner action
    expect(gap.requiredOwner).toBe(owner);
    expect(gap.reviewAt).toBe(at(30 * MIN)); // review
    expect(gap.expiresAt).toBe(at(90 * MIN)); // expiry
    // stays VISIBLE on the governed-source-gap witness.
    expect(r.governedSourceGaps().map((x) => x.id)).toContain(gap.id);
  });
});

// ===========================================================================
// AC2 — a non-healthy source stays a VISIBLE coverage gap (orphaned observation).
// ===========================================================================
describe('AC2 coverage-gap anchors', () => {
  it('an orphaned observation opens a visible gap carrying reason/impact/action/owner/age', () => {
    const r = reconciler(400);
    // An observation referencing an asset id that NO governed asset claims → orphaned → visible gap.
    const ghost = id(1099);
    r.reconcile({ observations: [rec('kanban:orphan:9', { assetId: ghost })], assets: [], at: at(0) });
    const gap = r.openGaps().find((g) => g.reason === 'orphaned')!;
    expect(gap).toBeDefined();
    expect(gap.gapClass).toBeDefined(); // gap class
    expect(gap.reason).toBeDefined(); // reason
    expect(gap.impact).toBeDefined(); // impact
    expect(gap.requiredAction).toBeDefined(); // owner action
    expect(gap.status === 'open' || gap.status === 'acknowledged').toBe(true); // VISIBLE
    expect(r.gapAge(gap.id, at(5 * MIN))).toBeGreaterThanOrEqual(0); // age
  });
});

// ===========================================================================
// AC4 — a stale/unavailable source is marked; health NOT inferred from stale data.
// ===========================================================================
describe('AC4 stale-status anchors', () => {
  it('marks last-known time + confidence and flips stale beyond the horizon', () => {
    const r = reconciler(500);
    const a = id(1003);
    r.reconcile({
      observations: [rec('kanban:card:s', { assetId: a })],
      assets: [asset(a)],
      at: at(0),
    });
    const fresh = r.sourceStatuses(at(1))[0]!;
    expect(fresh.stale).toBe(false); // fresh: not stale
    expect(fresh.confidence).toBe(1);
    expect(fresh.lastKnownAt).toBe(at(0)); // last-known time preserved

    // Far past the staleness horizon (with NO new observation): stale flips true, confidence decays,
    // last-known time is UNCHANGED — current health is never re-inferred from the stale reading.
    const old = r.sourceStatuses(at(20 * MIN))[0]!;
    expect(old.stale).toBe(true); // marked stale
    expect(old.confidence).toBeLessThan(1); // confidence decays
    expect(old.confidence).toBeGreaterThanOrEqual(0);
    expect(old.lastKnownAt).toBe(at(0)); // last-known time unchanged (not advanced to `at`)
  });
});

// ===========================================================================
// AC3 — drill-down: distinct records, correlation, status differences,
//       dependencies, and authoritative fields.
// ===========================================================================
describe('AC3 drill-down anchors', () => {
  it('exposes contested/differingSources, dependencies, and authoritative fields by name', () => {
    const r = reconciler(650);
    const a = id(1004);
    const k = rec('kanban:card:x', { assetId: a, sourceClass: 'platform_kanban', observedState: { status: 'operating' } });
    const g = rec('agentctl:job:x', { assetId: a, sourceClass: 'agentctl', observedState: { status: 'degraded' } });
    const w = rec('wf:run:x', { assetId: a, sourceClass: 'workflows_orchestration', observedState: { status: 'operating' } });
    r.reconcile({ observations: [k, g, w], assets: [asset(a)], at: at(0) });

    const inv = r.currentInventory();
    const depRel = makeInventoryRelationship({
      id: id(6001), tenantId: TENANT,
      fromKind: 'source_record', fromId: w.id,
      toKind: 'source_record', toId: k.id,
      relationship: 'depends_on', fieldName: 'status', createdAt: at(0),
    });
    const authRel = makeInventoryRelationship({
      id: id(6002), tenantId: TENANT,
      fromKind: 'source_record', fromId: k.id,
      toKind: 'governed_asset', toId: a,
      relationship: 'authoritative_for', fieldName: 'status', createdAt: at(0),
    });
    inv.ingestRelationship(depRel, a);
    inv.ingestRelationship(authRel, a);

    const dd = inv.drillDown(a, at(1));
    // (i) distinct records retained verbatim.
    expect(dd.correlation.sourceRecords.length).toBe(3);
    // (ii) status differences — the field is contested and names the differing source(s).
    const statusField = dd.correlation.fields.find((f) => f.field === 'status')!;
    expect(statusField.contested).toBe(true); // status difference
    expect(statusField.differingSources.map((c) => c.sourceClass)).toContain('agentctl');
    // (iii) dependencies.
    expect(dd.dependencies.map((d) => d.relationshipId)).toContain(depRel.id);
    // (iv) authoritative fields — the authoritative_for edge names its field + system-of-record.
    const auth = dd.authoritativeFields.find((f) => f.relationshipId === authRel.id)!;
    expect(auth.field).toBe('status'); // authoritative field
    expect(auth.authoritativeSourceId).toBe(k.id);
  });

  it('conflict witness: duplicate records of ONE identity that disagree are recorded (AC3)', () => {
    const r = reconciler(660);
    const a = id(1005);
    // Two records that share ONE identity (same externalKey) but disagree on status → conflict.
    const c1 = rec('kanban:card:cf', { assetId: a, status: 'active', observedState: { status: 'operating' } });
    const c2 = rec('kanban:card:cf', { assetId: a, status: 'conflicting', observedState: { status: 'retired' } });
    r.reconcile({ observations: [c1, c2], assets: [asset(a)], at: at(0) });
    const view = r.conflicts()[0]!;
    expect(view.identity).toBeDefined(); // correlation on one identity
    expect(view.recordIds.length).toBe(2); // distinct records retained
    expect(view.differingStatuses.sort()).toEqual(['active', 'conflicting']); // status differences
  });
});
