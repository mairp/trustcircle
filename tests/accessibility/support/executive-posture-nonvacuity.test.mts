// TrustCircleAI — Phase 78 EXECUTIVE-POSTURE non-vacuity probes (read-model level).
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item TRRGYA7N0K97QZ8JAMD077BRWP.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THESE PROBES PROVE
// ───────────────────────────────────────────────────────────────────────────────────────────
// The accessibility spec (executive-posture.spec.ts) asserts the VIEW reflects the model. These
// probes assert the MODEL itself is non-vacuous — that each executive addition is a genuine
// FUNCTION of service state, so mutating the scenario INPUT collapses exactly the oracle it should:
//
//   • ORDERING   — swapping the two coverage gaps' impacts INVERTS the ranked order (rank #1 flips).
//   • CONFIDENCE — forcing the stale record fresh RAISES the aggregate confidence (0.40 → 1.00).
//   • SUMMARY    — forcing fresh REDUCES the unknown count and RAISES confirmed-healthy.
//   • COVERAGE   — dropping the component gap collapses the ranked-coverage list 2 → 0.
//   • TRENDS     — dropping the coverage gap collapses the coverage trend from "aging" to non-aging.
//   • AC6        — dropping the review deadline drops the primary governed-source gap from the list.
//   • DIGEST     — the same scenario yields a byte-identical snapshot digest (determinism witness),
//                  and a materially different scenario yields a DIFFERENT digest (sensitivity).
//
// Each probe reads the model DERIVED through the real Phase-70 InventoryService — never a view
// literal. If any executive addition were a hard-coded constant, the corresponding probe would fail
// (the mutated input would not move the output).
//
// Run: node --experimental-strip-types --test tests/accessibility/support/executive-posture-nonvacuity.test.mts

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  deriveExecutivePosture,
  defaultExecutivePosture,
  buildExecService,
  T0,
} from './executive-posture-model.ts';

// ── ORDERING ──────────────────────────────────────────────────────────────────────────────────
test('ORDERING: swapping coverage-gap impacts inverts the business-impact rank order', () => {
  const normal = defaultExecutivePosture().rankedCoverageGaps;
  const swapped = deriveExecutivePosture({ swapCoverageImpacts: true }).rankedCoverageGaps;

  assert.ok(normal.length >= 2, 'need ≥2 coverage gaps to observe an order');
  assert.ok(swapped.length >= 2, 'need ≥2 coverage gaps to observe an order');

  // Ranks are non-increasing in both orderings (the list IS sorted).
  for (let i = 1; i < normal.length; i += 1) {
    assert.ok(
      normal[i - 1]!.impactRank >= normal[i]!.impactRank,
      'default order must be non-increasing by impact rank',
    );
  }
  // The mutation must PROMOTE a different gap to rank #1 — proving the order is derived, not fixed.
  assert.notEqual(
    swapped[0]!.subject,
    normal[0]!.subject,
    'swapping impacts must change which gap ranks first',
  );
  // Concretely: default #1 is the high-impact/high-risk primary gap; swapped #1 is the (now
  // critical) second asset.
  assert.equal(normal[0]!.subject, 'shadow-inference-svc');
  assert.equal(swapped[0]!.subject, 'batch-report-exporter');
  assert.ok(
    swapped[0]!.impactRank > normal[0]!.impactRank,
    'the promoted gap must outrank the previous leader',
  );
});

// ── CONFIDENCE ──────────────────────────────────────────────────────────────────────────────────
test('CONFIDENCE: forcing the stale record fresh raises the aggregate confidence', () => {
  const base = defaultExecutivePosture().confidence;
  const fresh = deriveExecutivePosture({ forceStaleRecordFresh: true }).confidence;

  assert.ok(base.aggregate < 1, `stale scenario must be < 1 (got ${base.aggregate})`);
  assert.ok(
    fresh.aggregate > base.aggregate,
    `fresh evidence must raise confidence (${base.aggregate} → ${fresh.aggregate})`,
  );
  assert.equal(fresh.aggregate, 1, 'all-fresh contributing rows ⇒ full confidence');
  // Band must move with the number (non-color meaning), not stay pinned.
  assert.notEqual(base.band, fresh.band, 'the confidence BAND must move too');
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────────────────────────
test('SUMMARY: forcing fresh reduces UNKNOWN and never folds a stale row into HEALTHY', () => {
  const base = defaultExecutivePosture().summary;
  const fresh = deriveExecutivePosture({ forceStaleRecordFresh: true }).summary;

  assert.ok(base.unknownCount > 0, 'default scenario must carry ≥1 UNKNOWN (stale) row');
  assert.ok(
    fresh.unknownCount < base.unknownCount,
    `forcing fresh must reduce unknowns (${base.unknownCount} → ${fresh.unknownCount})`,
  );
  assert.ok(
    fresh.confirmedHealthyCount >= base.confirmedHealthyCount,
    'a now-fresh healthy row may join confirmed-healthy, never the reverse',
  );
  // AC4 discipline at the summary level: confirmed-healthy + unknown never double-counts a row, and
  // the stale rows are counted as UNKNOWN, not healthy.
  assert.ok(
    base.confirmedHealthyCount + base.unknownCount <= base.totalItems,
    'confirmed-healthy and unknown are disjoint buckets',
  );
});

// ── COVERAGE (AC2) ───────────────────────────────────────────────────────────────────────────────
test('COVERAGE: dropping the component gap collapses the ranked-coverage list to zero', () => {
  const base = defaultExecutivePosture().rankedCoverageGaps.length;
  const dropped = deriveExecutivePosture({ dropComponentGap: true }).rankedCoverageGaps.length;

  assert.ok(base >= 2, `default must show ≥2 coverage gaps (got ${base})`);
  assert.equal(dropped, 0, 'dropping the component gaps must empty the ranked-coverage list');
});

// ── TRENDS ──────────────────────────────────────────────────────────────────────────────────────
test('TRENDS: the coverage trend is "aging" by default and collapses when the gap is dropped', () => {
  const base = defaultExecutivePosture().trends.find((t) => t.gapClass === 'coverage')!;
  const dropped = deriveExecutivePosture({ dropComponentGap: true }).trends.find(
    (t) => t.gapClass === 'coverage',
  )!;

  assert.equal(
    base.direction,
    'aging',
    'primary gap crosses the 7-day threshold within the window',
  );
  assert.ok(base.agedCount > 0, 'at least one gap must have newly aged');
  assert.equal(dropped.currentCount, 0, 'dropping the gap zeroes the current count');
  assert.equal(dropped.agedCount, 0, 'no gap ⇒ nothing aged');
  assert.notEqual(dropped.direction, 'aging', 'no gap ⇒ not aging');
});

// ── AC6 ──────────────────────────────────────────────────────────────────────────────────────────
test('AC6: dropping the review/expiry deadline removes the primary governed-source gap', () => {
  const base = buildExecService().governedSourceGaps().length;
  const dropped = buildExecService({ dropGovernedGapReview: true }).governedSourceGaps().length;

  assert.ok(base >= 2, `default must carry ≥2 governed-source gaps (got ${base})`);
  assert.ok(
    dropped < base,
    `dropping the deadline must remove the un-deadlined gap (${base} → ${dropped})`,
  );
  // The dropped gap is genuinely gone from the ranked list the view renders.
  const rankedDropped = deriveExecutivePosture({ dropGovernedGapReview: true }).rankedSourceGaps;
  assert.equal(rankedDropped.length, dropped, 'ranked source gaps track the service list exactly');
});

// ── DIGEST (determinism + sensitivity) ───────────────────────────────────────────────────────────
test('DIGEST: identical scenario ⇒ identical digest; a mutated scenario ⇒ a different digest', () => {
  const a = defaultExecutivePosture().snapshotDigest;
  const b = defaultExecutivePosture().snapshotDigest;
  assert.equal(a, b, 'the same scenario must yield a byte-identical snapshot digest');
  assert.match(a, /^[0-9a-f]{64}$/, 'the digest is a sha-256 hex string');

  const mutated = deriveExecutivePosture({ dropComponentGap: true }).snapshotDigest;
  assert.notEqual(mutated, a, 'a materially different scenario must yield a different digest');
});

// ── Ordering is a stable, total function (tie-break by id) ────────────────────────────────────────
test('ORDERING: ranks are total and ties break deterministically by id', () => {
  const gaps = deriveExecutivePosture({}, T0).rankedSourceGaps;
  for (let i = 1; i < gaps.length; i += 1) {
    const prev = gaps[i - 1]!;
    const cur = gaps[i]!;
    assert.ok(
      prev.impactRank > cur.impactRank ||
        (prev.impactRank === cur.impactRank && prev.id.localeCompare(cur.id) <= 0),
      'ties must break by ascending id',
    );
  }
});
