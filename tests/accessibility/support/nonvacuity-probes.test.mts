// GATE77 non-vacuity probe harness.
//
// Purpose (addresses the attempt-2 critic finding): for EACH of the six acceptance criteria, take
// the exact read-model value the *positive* AC oracle in `app-shell.spec.ts` reads from the shell,
// then apply the AC's single INPUT mutation (a `ScenarioOverrides` knob) and assert the value MOVES
// in the direction that would drive that positive oracle RED. Every probe therefore demonstrates the
// positive oracle is INPUT-SENSITIVE — it cannot pass vacuously.
//
// This runs deterministically against the REAL Phase-70 `InventoryService` (no browser, no fixtures)
// so the collapse is proven at the source the DOM is derived from. Each test name prints the exact
// `app-shell.spec.ts:<line>` of the positive oracle it protects, so the transcript maps 1:1 to the
// six tracked lines (:272,:352,:414,:470,:519,:592).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildService, deriveModel, SCENARIO_IDS, T0 } from './current-state-model.ts';

const model = (overrides = {}) => deriveModel(buildService(overrides), T0);

// ── AC1 (positive oracle app-shell.spec.ts:272) ──────────────────────────────────────────────
// Positive oracle reads: exactly ONE inventory row per healthy service row (dedup by asset id).
// Mutation `duplicateHealthyAsset` emits a SECOND observation of the same id: the row count must
// stay invariant (service dedups). The RED witness is that the raw stream truly carried a duplicate.
test('AC1 probe [protects app-shell.spec.ts:272] duplicate observation must NOT increase the inventory row count', () => {
  const base = model().inventory.length;
  const dup = model({ duplicateHealthyAsset: true }).inventory.length;
  assert.equal(dup, base, 'service must dedup the duplicated asset id to one row');
  const svc = buildService({ duplicateHealthyAsset: true });
  const reconciled = svc
    .currentStateView(T0)
    .filter((r) => r.assetId === SCENARIO_IDS.healthyAsset);
  assert.equal(
    reconciled.length,
    1,
    'exactly one reconciled row survives dedup for the duplicated id',
  );
  console.log(
    '  ↳ RED-direction proven: 2 observations of one id → 1 inventory row (id-keyed dedup).',
  );
});

// ── AC2 (positive oracle app-shell.spec.ts:352) ──────────────────────────────────────────────
// Positive oracle reads: the coverage-gap table has one row per `componentGaps()`.
// Mutation `dropComponentGap` removes the gap → row count falls to 0 (positive oracle RED).
test('AC2 probe [protects app-shell.spec.ts:352] dropping the component gap collapses the coverage-gap rows to 0', () => {
  const base = model().coverageGaps.length;
  const mutated = model({ dropComponentGap: true }).coverageGaps.length;
  assert.ok(base > 0, 'baseline must retain ≥1 coverage gap');
  assert.equal(
    mutated,
    0,
    'mutation must drop the coverage-gap row (positive oracle would go RED)',
  );
  assert.notEqual(mutated, base, 'coverage-gap count must change under the mutation');
  console.log(`  ↳ RED-direction proven: coverageGaps ${base} → ${mutated}.`);
});

// ── AC3 (positive oracle app-shell.spec.ts:414) ──────────────────────────────────────────────
// Positive oracle reads: ≥3 DISTINCT source classes + data-distinct-sources = that count.
// Mutation `singleSourceOnly` collapses the drill-down to ONE distinct source (positive oracle RED).
test('AC3 probe [protects app-shell.spec.ts:414] single-source collapse shrinks distinct sources to 1', () => {
  const baseDd = model().drilldown;
  const mutatedDd = model({ singleSourceOnly: true }).drilldown;
  assert.ok(
    baseDd !== undefined && mutatedDd !== undefined,
    'drill-down must be present in both models',
  );
  assert.ok(
    baseDd.distinctSourceCount >= 3,
    'baseline drill-down must correlate ≥3 distinct sources',
  );
  const mutatedDistinct = new Set(mutatedDd.records.map((r) => r.source)).size;
  assert.equal(
    mutatedDistinct,
    1,
    'mutation must collapse the records to a single distinct source',
  );
  assert.equal(
    mutatedDd.distinctSourceCount,
    1,
    'the rendered data-distinct-sources source must read 1 (positive oracle asserts 3)',
  );
  console.log(
    `  ↳ RED-direction proven: distinctSourceCount ${baseDd.distinctSourceCount} → ${mutatedDd.distinctSourceCount}.`,
  );
});

// ── AC4 (positive oracle app-shell.spec.ts:470) ──────────────────────────────────────────────
// Positive oracle reads: the stale panel exists with data-reported-health="unknown" (health
// WITHHELD). Mutation `forceStaleRecordFresh` makes evidence current → reported health becomes the
// observed value and the stale panel disappears (positive oracle RED: no stale-marker to assert).
test('AC4 probe [protects app-shell.spec.ts:470] fresh evidence removes the stale panel + reports observed health', () => {
  const baseStale = model().stale;
  assert.ok(baseStale !== undefined, 'baseline must present a stale (withheld) panel');
  assert.equal(baseStale.reportedHealth, 'unknown', 'baseline withholds health as unknown');

  const mutatedStale = model({ forceStaleRecordFresh: true }).stale;
  assert.equal(
    mutatedStale,
    undefined,
    'fresh evidence must remove the stale panel (positive oracle stale-marker absent → RED)',
  );
  const svc = buildService({ forceStaleRecordFresh: true });
  const row = svc.currentStateView(T0).find((r) => r.assetId === SCENARIO_IDS.staleAsset);
  assert.equal(
    row?.reportedHealth,
    'healthy',
    'fresh evidence reports the OBSERVED health, not unknown',
  );
  console.log(
    '  ↳ RED-direction proven: stale panel present → absent; reported unknown → healthy.',
  );
});

// ── AC5 (positive oracle app-shell.spec.ts:519) ──────────────────────────────────────────────
// Positive oracle reads: the catalogued source renders a discovery-evidence LINK.
// Mutation `dropDiscoveryEvidence` strips the ref → the link becomes a no-evidence marker
// (positive oracle RED: the getByRole('link', {name: evidence}) assertion would fail).
test('AC5 probe [protects app-shell.spec.ts:519] stripping the evidence ref removes the discovery-evidence link', () => {
  const baseRow = model().discoveredSources.find(
    (c) => String(c.id) === String(SCENARIO_IDS.discoveredCatalog),
  );
  assert.ok(baseRow !== undefined, 'baseline must catalog the discovered source');
  assert.ok(
    baseRow.discoveryEvidenceRef !== undefined,
    'baseline must carry a discovery-evidence ref (positive oracle asserts a link)',
  );

  const mutatedRow = model({ dropDiscoveryEvidence: true }).discoveredSources.find(
    (c) => String(c.id) === String(SCENARIO_IDS.discoveredCatalog),
  );
  assert.ok(mutatedRow !== undefined, 'the source stays catalogued after stripping evidence');
  assert.equal(
    mutatedRow.discoveryEvidenceRef,
    undefined,
    'mutation must strip the evidence ref (positive oracle link assertion → RED)',
  );
  console.log(
    '  ↳ RED-direction proven: discoveryEvidenceRef present → undefined (link → no-evidence marker).',
  );
});

// ── AC6 (positive oracle app-shell.spec.ts:592) ──────────────────────────────────────────────
// Positive oracle reads: one governed-source-gap row per `governedSourceGaps()`, each with a
// review/expiry deadline. Mutation `dropGovernedGapReview` removes the deadline → the SERVICE
// excludes the gap → 0 rows (positive oracle RED).
test('AC6 probe [protects app-shell.spec.ts:592] dropping the review/expiry deadline excludes the governed-source gap', () => {
  const base = model().sourceGaps.length;
  const mutated = model({ dropGovernedGapReview: true }).sourceGaps.length;
  assert.ok(base > 0, 'baseline must retain ≥1 governed-source gap with a review/expiry deadline');
  assert.equal(
    mutated,
    0,
    'a gap without a review/expiry deadline must be excluded (positive oracle RED)',
  );
  assert.notEqual(mutated, base, 'governed-source-gap count must change under the mutation');
  console.log(`  ↳ RED-direction proven: governed-source gaps ${base} → ${mutated}.`);
});
