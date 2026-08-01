// Phase 75 — automated acceptance tests for the PURE inventory-projector fold
// (packages/projections/src/inventory-projector.ts), work item F45MCD60YFGZ0WKBCE6565D3CZ.
//
// This suite exercises the projector through its INDEPENDENT read surface only — never the
// return value of a mutation. The witnesses are the re-readable query methods
// (currentStateView / rowFor / drillDown / catalog / componentGaps / governedSourceGaps /
// provenance / snapshotDigest). Every positive assertion is paired with a NEGATIVE CONTROL, and
// every AC block ends with a NON-VACUITY probe that drives the read model to a state where the
// assertion WOULD fail (RED) and then confirms the seeded state does not (GREEN) — so a passing
// assertion cannot be an accident of a mislabelled or empty read model.
//
// Run: node --experimental-strip-types --test "tests/projector/inventory-projector.test.mjs"
//   (npm script: test:projector).

import test from 'node:test';
import assert from 'node:assert/strict';

import { InventoryProjector } from '../../packages/projections/src/inventory-projector.ts';
import * as F from '../fixtures/inventory-events.ts';

/** A fresh projector seeded with the full canonical ordered stream. */
function seeded(overrides = {}) {
  const p = new InventoryProjector({ tenantId: F.TENANT, ...overrides });
  const entries = p.ingestBatch(F.inventoryEventStream());
  return { p, entries };
}

// ===========================================================================
// Ingest / provenance foundations — the fold applied every seeded delivery.
// ===========================================================================

test('ingest: every seeded delivery is applied and recorded in provenance', () => {
  const { p, entries } = seeded();
  const applied = entries.filter((e) => e.outcome === 'applied');

  // POSITIVE: all 14 canonical deliveries applied; the ledger is append-only and complete.
  assert.equal(entries.length, 14);
  assert.equal(applied.length, 14, 'every seeded delivery should apply exactly once');
  assert.equal(p.provenance().length, 14);
  for (const e of applied) {
    assert.ok(e.fact, 'an applied entry carries the produced fact kind + subject');
    assert.equal(typeof e.eventId, 'string');
    assert.ok(Number.isInteger(e.occurredAt) && e.occurredAt > 0);
  }

  // NEGATIVE CONTROL: nothing landed in the fail-visible (unapplied) set for a clean stream.
  assert.equal(p.unappliedDeliveries().length, 0);
});

// A stable digest over the read-model FACTS only (assets + records + gaps + catalog +
// relationships), excluding the provenance ledger — snapshotDigest() intentionally folds the
// ledger, so a recorded-but-not-applied delivery changes it. This helper witnesses that a
// non-applied delivery leaves the projected FACTS untouched.
function factSignature(p, at) {
  const rows = p.currentStateView(at).map((r) => ({
    id: r.assetId,
    name: r.name,
    obs: r.observedHealth,
    rep: r.reportedHealth,
    cov: r.coverage,
    conf: r.confidence,
    gap: r.hasVisibleComponentGap,
    recs: r.sourceRecordCount,
    ver: r.version,
  }));
  const gaps = p.coverageGaps().map((g) => ({ id: g.id, status: g.status, reason: g.reason }));
  const cat = p
    .catalog()
    .map((c) => ({ id: c.id, cls: c.sourceClass, onboard: c.onboardingState }));
  return JSON.stringify({ rows, gaps, cat });
}

test('ingest: a duplicate delivery is fail-visible, NOT silently re-applied (GAR-008)', () => {
  const { p } = seeded();
  const factsBefore = factSignature(p, F.NOW);

  // Re-deliver the AC1 asset event verbatim (same event_id + aggregate_version).
  const dup = F.inventoryEventStream().find(
    (e) => e.aggregate_id === F.HEALTHY_ASSET_ID && e.event_type.endsWith('asset.observed'),
  );
  const entry = p.ingestEvent(dup);

  // POSITIVE: the re-delivery is classified NOT-applied and shows up in the reconcile set...
  assert.notEqual(entry.outcome, 'applied');
  assert.equal(p.unappliedDeliveries().length, 1);
  // ...and the projected READ-MODEL FACTS are unchanged (a duplicate produces no second effect).
  assert.equal(factSignature(p, F.NOW), factsBefore, 'a duplicate must not mutate the read model');

  // NEGATIVE CONTROL: a genuinely NEW version for the same aggregate DOES change the facts,
  // proving the equality above is a real invariant, not a frozen/no-op projector.
  const bump = F.envelope({
    eventType: 'governance.inventory.asset.observed',
    aggregateType: 'governed_asset',
    aggregateId: F.HEALTHY_ASSET_ID,
    aggregateVersion: 2,
    occurredAt: F.NOW,
    data: {
      id: F.HEALTHY_ASSET_ID,
      assetType: 'service',
      name: 'orders-api-renamed',
      ownerPrincipalId: F.OWNER,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: F.NOW,
      version: 4,
      updatedAt: F.NOW,
      fields: [],
    },
  });
  const applied = p.ingestEvent(bump);
  assert.equal(applied.outcome, 'applied');
  assert.notEqual(factSignature(p, F.NOW), factsBefore, 'a new version must change the read model');
});

test('ingest: an event for another tenant is rejected at the scope boundary', () => {
  const { p } = seeded();
  const foreign = F.envelope({
    eventType: 'governance.inventory.asset.observed',
    aggregateType: 'governed_asset',
    aggregateId: F.HEALTHY_ASSET_ID,
    aggregateVersion: 1,
    tenantId: F.OTHER_TENANT,
    occurredAt: F.NOW,
    data: {
      id: F.HEALTHY_ASSET_ID,
      assetType: 'service',
      name: 'x',
      lifecycleState: 'operating',
      riskTier: 'low',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: F.NOW,
      version: 1,
      updatedAt: F.NOW,
      fields: [],
    },
  });
  // POSITIVE: cross-tenant ingest throws (scope isolation).
  assert.throws(() => p.ingestEvent(foreign), /scope/i);
  // NEGATIVE CONTROL: the same event under THIS tenant would be accepted (duplicate → recorded).
  const sameTenant = { ...foreign, tenant_id: F.TENANT };
  assert.doesNotThrow(() => p.ingestEvent(sameTenant));
});

// ===========================================================================
// AC1 — a healthy source is inventoried ONCE with the full attribute set.
// ===========================================================================

test('AC1: healthy asset appears once with a complete, current attribute set', () => {
  const { p } = seeded();
  const rows = p.currentStateView(F.NOW);

  // POSITIVE: exactly one row per seeded asset; no asset is duplicated.
  const healthyRows = rows.filter((r) => r.assetId === F.HEALTHY_ASSET_ID);
  assert.equal(healthyRows.length, 1, 'the healthy asset is inventoried exactly once');
  const row = healthyRows[0];

  // Full attribute set is populated and current.
  assert.equal(row.name, 'orders-api');
  assert.equal(row.assetType, 'service');
  assert.equal(row.ownerPrincipalId, F.OWNER);
  assert.equal(row.ownershipGap, false);
  assert.equal(row.lifecycleState, 'operating');
  assert.equal(row.riskTier, 'moderate');
  assert.equal(row.coverage, 'covered');
  assert.equal(row.observedHealth, 'healthy');
  assert.equal(row.reportedHealth, 'healthy', 'current evidence → health reported as-is');
  assert.equal(row.evidenceState, 'current');
  assert.equal(row.confidence, 1);
  assert.equal(row.hasVisibleComponentGap, false);
  assert.ok(row.sourceRecordCount >= 1);
  assert.ok(row.provenance && typeof row.provenance.eventId === 'string');

  // NEGATIVE CONTROL: the row set does NOT report the healthy asset as unmanaged/uncovered,
  // and no id appears twice across the whole current-state view.
  const ids = rows.map((r) => r.assetId);
  assert.equal(new Set(ids).size, ids.length, 'no asset id is inventoried twice');
  assert.notEqual(row.observedHealth, 'unmanaged');
  assert.notEqual(row.coverage, 'gap');

  // NON-VACUITY: an unknown asset id must throw — the view is not fabricating rows.
  assert.throws(() => p.rowFor(F.OTHER_TENANT, F.NOW), /unknown asset/);
});

// ===========================================================================
// AC2 — a discovered-but-unmanaged asset stays a VISIBLE coverage gap with
//        reason / age / impact / owner action.
// ===========================================================================

test('AC2: orphaned asset carries a visible component gap with reason/age/impact/action', () => {
  const { p } = seeded();
  const row = p.rowFor(F.GAP_ASSET_ID, F.NOW);

  // POSITIVE: the row flags a visible gap and is never covered+healthy.
  assert.equal(row.hasVisibleComponentGap, true);
  assert.equal(row.lifecycleState, 'orphaned');
  assert.equal(row.coverage, 'gap');
  assert.notEqual(row.observedHealth, 'healthy');

  const gaps = p.gapsForAsset(F.GAP_ASSET_ID);
  assert.equal(gaps.length, 1, 'the orphaned asset has exactly one component gap');
  const gap = gaps[0];
  assert.equal(gap.gapClass, 'component');
  assert.equal(gap.reason, 'orphaned'); // reason
  assert.equal(gap.impact, 'high'); // impact
  assert.ok(gap.requiredAction.length > 0); // owner action
  assert.ok(p.gapAge(gap.id, F.NOW) > 0, 'the gap has a positive age'); // age

  // The gap is in the still-VISIBLE component-gap set.
  assert.ok(p.componentGaps().some((g) => g.id === gap.id));

  // NEGATIVE CONTROL: the HEALTHY asset carries no visible component gap.
  assert.equal(p.rowFor(F.HEALTHY_ASSET_ID, F.NOW).hasVisibleComponentGap, false);
  assert.equal(p.gapsForAsset(F.HEALTHY_ASSET_ID).length, 0);

  // NON-VACUITY: resolve the gap → it must LEAVE the visible set (visibility is real state).
  const resolve = F.envelope({
    eventType: 'governance.inventory.coverage_gap.resolved',
    aggregateType: 'coverage_gap',
    aggregateId: F.COMPONENT_GAP,
    aggregateVersion: 2,
    occurredAt: F.NOW,
    data: {
      id: F.COMPONENT_GAP,
      status: 'resolved',
      resolution: 'owner assigned and control onboarded',
      resolvedAt: F.NOW,
    },
  });
  const before = p.componentGaps().length;
  const e = p.ingestEvent(resolve);
  assert.equal(e.outcome, 'applied');
  assert.equal(
    p.componentGaps().length,
    before - 1,
    'a resolved gap must drop out of the visible set',
  );
  assert.equal(p.rowFor(F.GAP_ASSET_ID, F.NOW).hasVisibleComponentGap, false);
});

// ===========================================================================
// AC3 — related work across kanban/agentctl surfaces distinct records with
//        correlation, status differences, dependencies, and authoritative fields.
// ===========================================================================

test('AC3: drill-down shows distinct records, disagreement, deps, and authoritative fields', () => {
  const { p } = seeded();
  const dd = p.drillDown(F.CORR_ASSET_ID, F.NOW);

  // POSITIVE: two DISTINCT source records from different classes.
  assert.equal(dd.sourceRecords.length, 2, 'kanban + agentctl are distinct records');
  const classes = new Set(dd.sourceRecords.map((r) => r.sourceClass));
  assert.ok(classes.has('kanban') && classes.has('agentctl'));

  // The records DISAGREE on a governed field → correlation pauses affected automation.
  assert.equal(dd.correlation.automationPaused, true, 'a field conflict pauses automation');
  assert.ok(dd.correlation.openCases.length >= 1, 'the disagreement opens a correlation case');

  // Dependency edge (depends_on) + authoritative-field attribution (authoritative_for).
  assert.equal(dd.dependencies.length, 1);
  assert.equal(dd.dependencies[0].fieldName, 'deployment_target');
  assert.equal(dd.authoritativeFields.length, 1);
  assert.equal(dd.authoritativeFields[0].field, 'pipeline_state');
  assert.equal(dd.authoritativeFields[0].authoritativeSourceId, F.KANBAN_CATALOG);

  // NEGATIVE CONTROL: the HEALTHY asset has a single record, no conflict, no deps.
  const clean = p.drillDown(F.HEALTHY_ASSET_ID, F.NOW);
  assert.equal(clean.sourceRecords.length, 1);
  assert.equal(clean.correlation.automationPaused, false);
  assert.equal(clean.correlation.openCases.length, 0);
  assert.equal(clean.dependencies.length, 0);
  assert.equal(clean.authoritativeFields.length, 0);

  // NON-VACUITY: drilling into an unknown asset throws — no fabricated correlation.
  assert.throws(() => p.drillDown(F.EXCLUDED_CATALOG, F.NOW), /unknown asset/);
});

// ===========================================================================
// AC4 — stale / unavailable source: marked with last-known time + confidence;
//        current health is NEVER inferred from stale data.
// ===========================================================================

test('AC4: stale source withholds current health but preserves last-known observation', () => {
  const { p } = seeded();
  const row = p.rowFor(F.STALE_ASSET_ID, F.NOW);

  // POSITIVE: the asset's OWN recorded health is 'healthy', but reported health is WITHHELD.
  assert.equal(row.observedHealth, 'healthy', 'the raw observation stays visible');
  assert.equal(row.reportedHealth, 'unknown', 'current health is NOT inferred from stale data');
  assert.ok(row.confidence < 1, 'stale evidence drops confidence below 1');
  assert.ok(row.confidence >= 0);
  assert.ok(row.lastObservationAt !== undefined, 'the last-known observation time is preserved');
  assert.ok(row.lastObservationAt < F.NOW, 'the last-known time is in the past');

  // NEGATIVE CONTROL: the fresh healthy asset reports its health and has full confidence.
  const fresh = p.rowFor(F.HEALTHY_ASSET_ID, F.NOW);
  assert.equal(fresh.reportedHealth, 'healthy');
  assert.equal(fresh.confidence, 1);

  // NON-VACUITY: deliver a FRESH, full-confidence observation for the same source record. The
  // withholding must LIFT — reported health becomes current and confidence reaches 1 — proving the
  // 'unknown'/0.4 above is caused by the stale evidence, not a hard-coded withhold.
  const fresh2 = F.envelope({
    eventType: 'governance.inventory.source_record.observed',
    aggregateType: 'source_record',
    aggregateId: F.STALE_RECORD,
    aggregateVersion: 2,
    occurredAt: F.NOW,
    source: {
      source_instance_id: F.STALE_CATALOG,
      external_id: 'warehouse/etl',
      source_revision: 'r1',
      observed_at: new Date(F.NOW).toISOString(),
    },
    data: {
      id: F.STALE_RECORD,
      catalogId: F.STALE_CATALOG,
      assetId: F.STALE_ASSET_ID,
      sourceClass: 'warehouse',
      externalKey: 'warehouse/etl',
      status: 'active',
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: F.NOW,
      observedAt: F.NOW,
    },
  });
  const e = p.ingestEvent(fresh2);
  assert.equal(e.outcome, 'applied');
  const refreshed = p.rowFor(F.STALE_ASSET_ID, F.NOW);
  assert.ok(refreshed.confidence > row.confidence, 'a fresh observation raises confidence');
  assert.equal(refreshed.reportedHealth, 'healthy', 'with fresh evidence, health is reported');
});

// ===========================================================================
// AC5 — an unregistered discovered source becomes a catalog entry with
//        discovery evidence / classification / location / access / sensitivity /
//        ownership / onboarding.
// ===========================================================================

test('AC5: a discovered unregistered source is catalogued with full discovery metadata', () => {
  const { p } = seeded();
  const catalog = p.catalog();
  const entry = catalog.find((c) => c.id === F.DISCOVERED_CATALOG);

  // POSITIVE: the discovered source is present with every governance facet.
  assert.ok(entry, 'the discovered source is present in the catalog');
  assert.equal(entry.sourceClass, 'unknown', 'unclassified → pinned to the unknown sentinel'); // classification
  assert.deepEqual([...entry.observedLocations], ['s3://acme-unmapped-bucket']); // location
  assert.equal(entry.accessState, 'reachable'); // access
  assert.equal(entry.sensitivity, 'restricted'); // sensitivity
  assert.equal(entry.ownerPrincipalId, undefined, 'an unowned discovered source has no owner'); // ownership
  assert.equal(entry.onboardingState, 'discovered'); // onboarding
  assert.equal(entry.discoveryEvidence, F.DISCOVERY_EVIDENCE); // discovery evidence
  // A not-yet-onboarded source may not masquerade as healthy.
  assert.notEqual(entry.healthState, 'healthy');

  // NEGATIVE CONTROL: an id never discovered is absent from the catalog.
  assert.equal(
    catalog.find((c) => c.id === F.OWNER),
    undefined,
  );

  // NON-VACUITY: the catalog carries exactly the two seeded discoveries, not a fabricated set.
  assert.equal(catalog.length, 2);
  assert.ok(catalog.every((c) => typeof c.discoveryEvidence === 'string'));
});

// ===========================================================================
// AC6 — an unsupported / inaccessible / sensitive / unowned / excluded source
//        becomes a VISIBLE governed-source gap with reason / impact / owner
//        action / review-or-expiry.
// ===========================================================================

test('AC6: excluded source raises a visible governed-source gap with a review deadline', () => {
  const { p } = seeded();
  const govGaps = p.governedSourceGaps();
  const gap = govGaps.find((g) => g.id === F.GOVERNED_GAP);

  // POSITIVE: the excluded/inaccessible source's gap is visible with a review-or-expiry deadline.
  assert.ok(gap, 'the excluded source raises a visible governed-source gap');
  assert.equal(gap.gapClass, 'governed_source');
  assert.equal(gap.reason, 'excluded'); // reason
  assert.equal(gap.impact, 'high'); // impact
  assert.ok(gap.requiredAction.length > 0); // owner action
  assert.ok(gap.reviewAt !== undefined && gap.reviewAt > F.NOW, 'a review deadline is set'); // review-or-expiry

  // The excluded catalog entry itself reflects the unsupported/inaccessible/sensitive facts.
  const entry = p.catalog().find((c) => c.id === F.EXCLUDED_CATALOG);
  assert.equal(entry.onboardingState, 'excluded');
  assert.equal(entry.accessState, 'inaccessible');
  assert.equal(entry.sensitivity, 'sensitive');

  // NEGATIVE CONTROL: the AC2 COMPONENT gap is not a governed-source gap.
  assert.equal(
    govGaps.some((g) => g.id === F.COMPONENT_GAP),
    false,
  );

  // NON-VACUITY: governedSourceGaps requires a review-or-expiry deadline — a governed-source gap
  // WITHOUT one must not appear. Raise such a gap and confirm it is excluded from the set.
  const noDeadline = F.envelope({
    eventType: 'governance.inventory.coverage_gap.raised',
    aggregateType: 'coverage_gap',
    aggregateId: '018f0000-0000-7000-8000-0000000000f3',
    aggregateVersion: 1,
    occurredAt: F.NOW,
    data: {
      id: '018f0000-0000-7000-8000-0000000000f3',
      subjectKind: 'source_catalog_entry',
      subjectId: F.DISCOVERED_CATALOG,
      gapClass: 'governed_source',
      reason: 'unsupported',
      impact: 'medium',
      requiredAction: 'evaluate onboarding support for the unknown source',
      status: 'open',
      firstSeenAt: F.NOW,
      // no reviewAt / expiresAt
    },
  });
  const e = p.ingestEvent(noDeadline);
  assert.equal(e.outcome, 'applied');
  assert.equal(
    p.governedSourceGaps().some((g) => g.id === noDeadline.data.id),
    false,
    'a governed-source gap without a review-or-expiry deadline is not surfaced here',
  );
});

// ===========================================================================
// Determinism — the fold is order-tolerant and the digest is a real witness.
// ===========================================================================

test('determinism: independent projectors over the same stream produce the same digest', () => {
  const a = seeded().p;
  const b = seeded().p;
  // POSITIVE: identical state → identical digest.
  assert.equal(a.snapshotDigest(F.NOW), b.snapshotDigest(F.NOW));

  // NEGATIVE CONTROL: a projector with ONE fewer event has a different digest.
  const partial = new InventoryProjector({ tenantId: F.TENANT });
  partial.ingestBatch(F.inventoryEventStream().slice(0, -1));
  assert.notEqual(partial.snapshotDigest(F.NOW), a.snapshotDigest(F.NOW));
});
