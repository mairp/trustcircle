// Phase 76 — automated acceptance tests for the OPERATIONAL and EXECUTIVE current-state query
// services (packages/projections/src/current-state-queries.ts), work item G0GRZVRX42CN40YNHRPHRR0B7D,
// bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// The query services are a PURE reshaping layer over the Phase-75 InventoryProjector. This suite
// drives the projector with the canonical six-AC event stream (tests/fixtures/inventory-events.ts)
// and asserts on the query services' INDEPENDENT read surface only — operationalView / operationalItem
// / executiveView — plus the projector's own drillDown for AC3's source-level correlation.
//
// Every AC block pairs a POSITIVE assertion with a NEGATIVE CONTROL, and ends with a NON-VACUITY
// probe that mutates the seed to a state where the assertion WOULD fail (RED) and confirms the
// seeded state does not (GREEN) — so a passing assertion cannot be an accident of an empty or
// mislabelled view. The overriding invariant under test is AC4: a stale item's health is reported
// as 'unknown', is flagged stale with confidence < 1, and NEVER inflates the executive health
// roll-up.
//
// Run: node --experimental-strip-types --test "tests/projector/current-state-queries.test.mjs"
//   (npm script: test:projector).

import test from 'node:test';
import assert from 'node:assert/strict';

import { InventoryProjector } from '../../packages/projections/src/inventory-projector.ts';
import { CurrentStateQueryService } from '../../packages/projections/src/current-state-queries.ts';
import * as F from '../fixtures/inventory-events.ts';

/** A fresh projector seeded with the canonical stream, wrapped in a query service. */
function seeded(overrides = {}) {
  const p = new InventoryProjector({ tenantId: F.TENANT, ...overrides });
  p.ingestBatch(F.inventoryEventStream());
  const svc = new CurrentStateQueryService(p, overrides.stalenessHorizonMillis);
  return { p, svc };
}

const AT = F.NOW; // the query instant every AC scenario is authored relative to.

function op(svc, assetId) {
  return svc.operationalItem(assetId, AT);
}

// ===========================================================================
// AC1 — a healthy, connected source appears ONCE with the full facet set, fresh.
// ===========================================================================

test('AC1: healthy connected asset surfaces once with full facets, fresh + safe', () => {
  const { svc } = seeded();
  const view = svc.operationalView(AT);

  // POSITIVE: exactly ONE operational row for the healthy asset, carrying every enumerated facet.
  const healthy = view.filter((i) => i.assetId === F.HEALTHY_ASSET_ID);
  assert.equal(healthy.length, 1, 'a healthy asset renders exactly once');
  const it = healthy[0];
  assert.equal(it.assetType, 'service');
  assert.equal(it.name, 'orders-api');
  assert.equal(it.ownerPrincipalId, F.OWNER); // owner (source identity + owner)
  assert.equal(it.ownershipGap, false);
  assert.equal(it.lifecycleState, 'operating'); // lifecycle state
  assert.equal(it.riskTier, 'moderate'); // risk
  assert.equal(it.coverage, 'covered'); // control coverage
  assert.equal(it.observedHealth, 'healthy'); // health
  assert.equal(it.evidenceState, 'current'); // evidence state
  assert.equal(it.unresolvedIssueCount, 0); // unresolved issues
  assert.equal(it.sourceRecordCount, 1);
  assert.equal(typeof it.freshness.lastKnownAt, 'number'); // last observation time
  // AC1 + AC4: fresh evidence ⇒ health SAFE to report, no action needed.
  assert.equal(it.reportedHealth, 'healthy');
  assert.equal(it.freshness.stale, false);
  assert.equal(it.freshness.confidence, 1);
  assert.equal(it.safeNextAction, 'none');

  // NEGATIVE CONTROL: the item is NOT flagged as any kind of gap or issue.
  assert.equal(it.hasVisibleComponentGap, false);
  assert.equal(it.freshness.ageMillis, 0);

  // NON-VACUITY: re-observe the SAME asset stale, and the same row must flip off 'healthy'/'none'.
  const stale = new InventoryProjector({ tenantId: F.TENANT });
  stale.ingestBatch(F.inventoryEventStream());
  const svc2 = new CurrentStateQueryService(stale);
  const far = op(svc2, F.HEALTHY_ASSET_ID);
  assert.equal(far.reportedHealth, 'healthy'); // baseline green at AT
  const later = svc2.operationalItem(F.HEALTHY_ASSET_ID, AT + 60 * 60_000); // 1h later than last obs
  assert.equal(later.freshness.stale, true, 'RED: a far-future query makes the item stale');
  assert.equal(later.reportedHealth, 'unknown', 'RED: stale ⇒ health not reported as current');
  assert.notEqual(later.safeNextAction, 'none');
});

// ===========================================================================
// AC2 — a discovered-but-unmanaged/orphaned component stays visible as a coverage gap,
//        NOT healthy, NOT disappearing.
// ===========================================================================

test('AC2: orphaned/unowned/uncovered component stays a visible gap, never healthy', () => {
  const { svc } = seeded();
  const it = op(svc, F.GAP_ASSET_ID);

  // POSITIVE: the item is present (not disappeared) and flagged as a coverage gap needing action.
  assert.equal(it.name, 'legacy-batch-job');
  assert.equal(it.lifecycleState, 'orphaned');
  assert.equal(it.ownershipGap, true); // required owner action: assign an owner
  assert.equal(it.hasVisibleComponentGap, true);
  assert.equal(it.coverage, 'gap');
  // It must NOT masquerade as healthy: reported health withheld; no fresh evidence.
  assert.equal(it.reportedHealth, 'unknown');
  assert.equal(it.observedHealth, 'unmanaged');

  // The executive roll-up keeps the gap on-screen WITH reason / age / required action (AC2).
  const ex = svc.executiveView(AT);
  const line = ex.componentGaps.find((g) => g.subjectId === F.GAP_ASSET_ID);
  assert.ok(line, 'the component gap is present in the executive inventory');
  assert.equal(line.reason, 'orphaned');
  assert.equal(line.impact, 'high');
  assert.ok(line.ageMillis > 0, 'the gap carries an age');
  assert.ok(line.requiredAction.length > 0, 'the gap names a required owner action');

  // NEGATIVE CONTROL: a fully-healthy asset produces NO component-gap line and NO ownership gap.
  const healthy = op(svc, F.HEALTHY_ASSET_ID);
  assert.equal(healthy.hasVisibleComponentGap, false);
  assert.equal(healthy.ownershipGap, false);
  assert.equal(
    ex.componentGaps.find((g) => g.subjectId === F.HEALTHY_ASSET_ID),
    undefined,
    'a healthy asset raises no component gap',
  );

  // NON-VACUITY: an empty projector yields NO component gaps — the seeded gap is not spurious.
  const empty = new CurrentStateQueryService(new InventoryProjector({ tenantId: F.TENANT }));
  assert.equal(empty.executiveView(AT).componentGaps.length, 0, 'RED: no seed ⇒ no gaps');
});

// ===========================================================================
// AC3 — related work across registered sources: distinct records, correlation,
//        status differences, dependencies, authoritative fields.
// ===========================================================================

test('AC3: related work surfaces distinct source records, disagreement, and edges', () => {
  const { p, svc } = seeded();
  const it = op(svc, F.CORR_ASSET_ID);

  // POSITIVE (operational): the item reports MULTIPLE distinct source records and an unresolved
  // issue (the sources disagree on a governed field), so the responder must reconcile.
  assert.equal(it.sourceRecordCount, 2, 'two distinct source records contribute');
  assert.ok(it.unresolvedIssueCount > 0, 'disagreeing sources open an unresolved issue');

  // POSITIVE (drill-down on the projector): the two DISTINCT source records, their status
  // difference, and the declared dependency + authoritative-field edges are all visible.
  const dd = p.drillDown(F.CORR_ASSET_ID, AT);
  assert.equal(dd.sourceRecords.length, 2);
  const classes = dd.sourceRecords.map((r) => r.sourceClass).sort();
  assert.deepEqual(classes, ['agentctl', 'kanban']); // distinct registered sources
  const statuses = new Set(dd.sourceRecords.map((r) => r.status));
  assert.ok(statuses.size >= 2, 'the records DIFFER on the governed status field');
  assert.ok(dd.dependencies.length >= 1, 'a depends_on edge is surfaced');
  assert.ok(dd.authoritativeFields.length >= 1, 'an authoritative_for attribution is surfaced');
  assert.ok(
    dd.authoritativeFields.some((a) => a.field === 'pipeline_state'),
    'the authoritative field is named',
  );

  // AC4 interaction: even with confidence 1, an UNRESOLVED correlation is not 'current' evidence,
  // so reported health is withheld and the safe action is to investigate before acting.
  assert.equal(it.reportedHealth, 'unknown');
  assert.notEqual(it.safeNextAction, 'none');

  // NEGATIVE CONTROL: the single-record healthy asset has exactly one record and NO disagreement.
  const solo = op(svc, F.HEALTHY_ASSET_ID);
  assert.equal(solo.sourceRecordCount, 1);
  assert.equal(solo.unresolvedIssueCount, 0);

  // NON-VACUITY: the two records are genuinely DISTINCT — dropping one changes the reported count.
  const one = new InventoryProjector({ tenantId: F.TENANT });
  one.ingestBatch(F.inventoryEventStream().filter((e) => e.aggregate_id !== F.AGENTCTL_RECORD));
  const svc2 = new CurrentStateQueryService(one);
  assert.equal(
    svc2.operationalItem(F.CORR_ASSET_ID, AT).sourceRecordCount,
    1,
    'RED: removing one record drops the count to 1',
  );
});

// ===========================================================================
// AC4 — a stale/unavailable source: data marked with last-known time AND confidence;
//        current health NOT inferred from stale data.  (The core governance rule.)
// ===========================================================================

test('AC4: stale source ⇒ health withheld, marked with last-known time + confidence', () => {
  const { svc } = seeded();
  const it = op(svc, F.STALE_ASSET_ID);

  // POSITIVE: the item is marked stale, carries a last-known time AND a sub-1 confidence, and its
  // OBSERVED health ('healthy') is NOT reported as current — reportedHealth is withheld.
  assert.equal(it.observedHealth, 'healthy', 'the raw observed health is still shown');
  assert.equal(it.reportedHealth, 'unknown', 'AC4: current health is NOT inferred from stale data');
  assert.equal(it.freshness.stale, true);
  assert.ok(it.freshness.confidence < 1, 'stale evidence drops confidence below 1');
  assert.equal(typeof it.freshness.lastKnownAt, 'number', 'last-known time is surfaced');
  assert.ok(it.freshness.ageMillis > 0);
  assert.equal(it.safeNextAction, 'investigate_stale');

  // POSITIVE (executive): the stale item is counted as 'unknown' health, NOT 'healthy'; the
  // aggregate freshness makes the reliance on stale data visible.
  const ex = svc.executiveView(AT);
  assert.ok(ex.freshness.staleItemCount >= 1, 'the roll-up counts the stale item');
  assert.ok(ex.freshness.anyStale, 'anyStale gates a "current" badge off');
  assert.ok(ex.freshness.minConfidence < 1, 'worst-case confidence is surfaced, not averaged away');

  // NEGATIVE CONTROL — the crux of AC4: the stale asset's OBSERVED 'healthy' must NOT appear in the
  // executive healthy count. Only genuinely-fresh healthy assets are counted.
  assert.equal(ex.byReportedHealth.healthy, 1, 'exactly the one FRESH healthy asset is counted');
  // If stale inference leaked, healthy would be ≥ 2 (orders-api + the stale etl-warehouse).
  assert.notEqual(ex.byReportedHealth.healthy, 2);

  // NON-VACUITY: re-seed the SAME asset with a FRESH, full-confidence record (freshness 'fresh',
  // confidence 1, observed now) and its reported health becomes 'healthy' — proving the withholding
  // above is caused by the STALE evidence, not a hard-coded 'unknown' for this asset.
  const freshStream = F.inventoryEventStream().map((e) => {
    if (e.aggregate_id !== F.STALE_RECORD) return e;
    return {
      ...e,
      occurred_at: new Date(AT).toISOString(),
      data: { ...e.data, freshness: 'fresh', confidence: 1, lastKnownAt: AT, observedAt: AT },
    };
  });
  const fresh = new InventoryProjector({ tenantId: F.TENANT });
  fresh.ingestBatch(freshStream);
  const svc2 = new CurrentStateQueryService(fresh);
  const atFresh = svc2.operationalItem(F.STALE_ASSET_ID, AT);
  assert.equal(atFresh.freshness.stale, false, 'GREEN: a fresh full-confidence record is not stale');
  assert.equal(atFresh.freshness.confidence, 1);
  assert.equal(atFresh.reportedHealth, 'healthy', 'GREEN: fresh evidence ⇒ health IS reported');
});

// ===========================================================================
// AC5 — an unregistered governance-relevant source appears in the catalog with discovery
//        evidence, type/unknown classification, location, access, sensitivity, ownership,
//        onboarding state.
// ===========================================================================

test('AC5: discovered unknown-class source appears in catalog posture with full metadata', () => {
  const { svc } = seeded();
  const ex = svc.executiveView(AT);
  const line = ex.catalog.find((c) => c.catalogId === F.DISCOVERED_CATALOG);

  // POSITIVE: the discovered source is catalogued with every enumerated metadata facet.
  assert.ok(line, 'the discovered source appears in the catalog posture');
  assert.equal(line.sourceClass, 'unknown'); // type/unknown classification
  assert.equal(line.classifiedUnknown, true);
  assert.equal(line.onboardingState, 'discovered'); // onboarding state
  assert.equal(line.accessState, 'reachable'); // access status
  assert.equal(line.sensitivity, 'restricted'); // sensitivity
  assert.equal(line.ownershipGap, true); // ownership status (unowned)
  assert.ok(line.observedLocations.length >= 1); // location
  assert.equal(typeof line.discoveryEvidence, 'string'); // discovery evidence
  assert.equal(line.needsAttention, true, 'an un-onboarded source stays an attention item');

  // NEGATIVE CONTROL: an unknown-class discovered source is NOT a governed asset row — it never
  // appears in the operational asset view (which is keyed on GovernedAsset).
  const asAsset = svc.operationalView(AT).find((i) => i.assetId === F.DISCOVERED_CATALOG);
  assert.equal(asAsset, undefined, 'a catalog entry is not a governed-asset row');

  // NON-VACUITY: an empty projector has an empty catalog — the seeded entry is not spurious.
  const empty = new CurrentStateQueryService(new InventoryProjector({ tenantId: F.TENANT }));
  assert.equal(empty.executiveView(AT).catalog.length, 0, 'RED: no seed ⇒ empty catalog');
});

// ===========================================================================
// AC6 — a discovered unsupported/inaccessible/sensitive/unowned/excluded source is visible as a
//        GOVERNED-SOURCE GAP with reason, impact, owner action, and review/expiry.
// ===========================================================================

test('AC6: excluded/inaccessible source is a visible governed-source gap with a deadline', () => {
  const { svc } = seeded();
  const ex = svc.executiveView(AT);

  // POSITIVE (governed-source gap): the excluded source is on-screen as a governed-source gap with
  // reason / impact / owner action / a review deadline.
  const gap = ex.governedSourceGaps.find((g) => g.subjectId === F.EXCLUDED_CATALOG);
  assert.ok(gap, 'the excluded source raises a governed-source gap');
  assert.equal(gap.gapClass, 'governed_source');
  assert.equal(gap.reason, 'excluded');
  assert.equal(gap.impact, 'high');
  assert.ok(gap.requiredAction.length > 0, 'names a required owner action');
  assert.equal(gap.hasDeadline, true, 'carries a review/expiry deadline');
  assert.equal(typeof gap.reviewAt, 'number');

  // POSITIVE (catalog posture): the same source is catalogued as unsupported/inaccessible/sensitive.
  const cat = ex.catalog.find((c) => c.catalogId === F.EXCLUDED_CATALOG);
  assert.ok(cat);
  assert.equal(cat.sourceClass, 'unsupported-vendor-x');
  assert.equal(cat.accessState, 'inaccessible');
  assert.equal(cat.sensitivity, 'sensitive');
  assert.equal(cat.onboardingState, 'excluded');
  assert.equal(cat.ownershipGap, true);
  assert.equal(cat.needsAttention, true);

  // NEGATIVE CONTROL: the AC2 COMPONENT gap is NOT mislabelled as a governed-source gap.
  assert.equal(
    ex.governedSourceGaps.find((g) => g.subjectId === F.GAP_ASSET_ID),
    undefined,
    'a component gap does not leak into the governed-source gap inventory',
  );
  // ...and vice-versa: the governed-source subject is not in the component-gap inventory.
  assert.equal(
    ex.componentGaps.find((g) => g.subjectId === F.EXCLUDED_CATALOG),
    undefined,
  );

  // NON-VACUITY: without the excluded-source events, there is NO governed-source gap.
  const noExcl = new InventoryProjector({ tenantId: F.TENANT });
  noExcl.ingestBatch(
    F.inventoryEventStream().filter(
      (e) => e.aggregate_id !== F.EXCLUDED_CATALOG && e.aggregate_id !== F.GOVERNED_GAP,
    ),
  );
  const svc2 = new CurrentStateQueryService(noExcl);
  assert.equal(
    svc2.executiveView(AT).governedSourceGaps.length,
    0,
    'RED: no excluded source ⇒ no governed-source gap',
  );
});

// ===========================================================================
// Cross-cutting: the executive roll-up is a faithful, TOTAL aggregation of the operational view,
// and is a pure derivation (identical snapshot ⇒ identical digest).
// ===========================================================================

test('executive roll-up totals reconcile with the operational view and are pure', () => {
  const { svc } = seeded();
  const view = svc.operationalView(AT);
  const ex = svc.executiveView(AT);

  // The asset count matches, and every count table sums to the population (TOTAL, no dropped items).
  assert.equal(ex.assetCount, view.length);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(ex.byLifecycle), view.length);
  assert.equal(sum(ex.byRisk), view.length);
  assert.equal(sum(ex.byCoverage), view.length);
  assert.equal(sum(ex.byReportedHealth), view.length);

  // The stale count and ownership-gap count agree between the two views (no divergence).
  assert.equal(ex.freshness.staleItemCount, view.filter((i) => i.freshness.stale).length);
  assert.equal(ex.freshness.ownershipGapCount, view.filter((i) => i.ownershipGap).length);
  assert.equal(ex.freshness.minConfidence, Math.min(...view.map((i) => i.freshness.confidence)));

  // Purity: a second query service over a freshly re-seeded projector yields the SAME digest.
  const { svc: svc2 } = seeded();
  assert.equal(
    svc2.executiveView(AT).snapshotDigest,
    ex.snapshotDigest,
    'identical seed ⇒ identical snapshot digest (pure derivation)',
  );

  // NON-VACUITY: a DIFFERENT query instant that changes staleness changes the digest — the digest
  // is not a constant.
  const laterDigest = svc.executiveView(AT + 24 * 60 * 60_000).snapshotDigest;
  assert.notEqual(laterDigest, ex.snapshotDigest, 'RED: a different instant ⇒ a different digest');
});

// ===========================================================================
// Guard rails — the service refuses a non-projector and a non-positive horizon.
// ===========================================================================

test('constructor rejects a non-projector and a non-positive horizon', () => {
  assert.throws(() => new CurrentStateQueryService({}), TypeError);
  assert.throws(
    () => new CurrentStateQueryService(new InventoryProjector({ tenantId: F.TENANT }), 0),
    RangeError,
  );
});
