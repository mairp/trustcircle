// TrustCircleAI — Phase 78 EXECUTIVE-POSTURE DOM-level RED witnesses.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item TRRGYA7N0K97QZ8JAMD077BRWP.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES (and why it is separate)
// ───────────────────────────────────────────────────────────────────────────────────────────
// executive-posture.spec.ts proves each obligation is SATISFIED (GREEN) and carries an inline RED
// control per obligation. This file is the concentrated NON-VACUITY witness at the DOM level: it
// mounts BOTH the healthy (GREEN) and mutated (RED) renders of the SAME view in a real browser and
// asserts the rendered accessibility tree MOVES when — and only when — the scenario INPUT moves.
// Each pair is A→B: same view, different service-derived model, observably different DOM. A static
// template (which cannot move) fails every RED half here.
//
// The expectations are read from the model DERIVED through the real Phase-70 InventoryService via
// deriveExecutivePosture(overrides) — never from view literals. Run under the hermetic
// `accessibility-current-state` Playwright project (no web server, no React, no auth setup).

import { test, expect, type Page } from '@playwright/test';

import {
  renderExecutivePosture,
  POSTURE_TENANT,
  type ExecutivePostureModel,
} from '../../apps/web/src/features/posture/ExecutivePosture.tsx';
import {
  deriveExecutivePosture,
  defaultExecutivePosture,
} from './support/executive-posture-model.ts';

function html(model: ExecutivePostureModel): string {
  return renderExecutivePosture({ tenant: POSTURE_TENANT, model });
}

async function mount(page: Page, model: ExecutivePostureModel): Promise<void> {
  await page.setContent(html(model), { waitUntil: 'domcontentloaded' });
}

async function firstRankSubject(page: Page, region: string): Promise<string | null> {
  const th = page.getByTestId(region).locator('tbody tr').first().locator('th[scope="row"]');
  return (await th.count()) === 0 ? null : ((await th.first().textContent())?.trim() ?? null);
}

test.describe('executive posture — DOM-level RED witnesses (each addition moves iff input moves)', () => {
  // ── ORDERING: swapping impacts flips the rendered rank-#1 subject ──────────────────────────────
  test('ORDERING moves: rank-#1 coverage subject flips when the input impacts are swapped', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ swapCoverageImpacts: true });
    const expectGreen = green.rankedCoverageGaps[0]!.subject;
    const expectRed = red.rankedCoverageGaps[0]!.subject;
    expect(expectRed, 'the fixtures must differ or the witness is vacuous').not.toBe(expectGreen);

    await mount(page, green);
    expect(await firstRankSubject(page, 'ranked-coverage-gaps')).toBe(expectGreen);

    await mount(page, red);
    expect(await firstRankSubject(page, 'ranked-coverage-gaps')).toBe(expectRed);
  });

  // ── CONFIDENCE: the rendered aggregate rises when the stale record is forced fresh ─────────────
  test('CONFIDENCE moves: the rendered aggregate rises when the stale record is forced fresh', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ forceStaleRecordFresh: true });
    expect(red.confidence.aggregate).toBeGreaterThan(green.confidence.aggregate);

    await mount(page, green);
    await expect(page.getByTestId('posture-confidence-line')).toHaveAttribute(
      'data-confidence',
      green.confidence.aggregate.toFixed(2),
    );
    await expect(page.getByTestId('confidence-band')).toHaveText(green.confidence.band);

    await mount(page, red);
    await expect(page.getByTestId('posture-confidence-line')).toHaveAttribute(
      'data-confidence',
      red.confidence.aggregate.toFixed(2),
    );
    await expect(page.getByTestId('confidence-band')).toHaveText(red.confidence.band);
    expect(red.confidence.band).not.toBe(green.confidence.band);
  });

  // ── SUMMARY: the rendered UNKNOWN figure drops when the stale record is forced fresh ───────────
  test('SUMMARY moves: the rendered UNKNOWN figure drops when the stale record is forced fresh', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ forceStaleRecordFresh: true });
    expect(red.summary.unknownCount).toBeLessThan(green.summary.unknownCount);

    await mount(page, green);
    await expect(page.getByTestId('posture-summary-figures')).toHaveAttribute(
      'data-unknown',
      String(green.summary.unknownCount),
    );

    await mount(page, red);
    await expect(page.getByTestId('posture-summary-figures')).toHaveAttribute(
      'data-unknown',
      String(red.summary.unknownCount),
    );
  });

  // ── COVERAGE (AC2): dropping the component gap empties the rendered ranked list ─────────────────
  test('COVERAGE moves: the rendered ranked-coverage rows vanish when the gap is dropped', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ dropComponentGap: true });
    expect(green.rankedCoverageGaps.length).toBeGreaterThan(0);
    expect(red.rankedCoverageGaps.length).toBe(0);

    await mount(page, green);
    await expect(page.getByTestId('ranked-coverage-gaps').locator('tbody tr')).toHaveCount(
      green.rankedCoverageGaps.length,
    );

    await mount(page, red);
    await expect(page.getByTestId('ranked-coverage-gaps').locator('tbody tr')).toHaveCount(0);
  });

  // ── TRENDS: the rendered coverage-trend direction leaves "aging" when the gap is dropped ────────
  test('TRENDS move: the rendered coverage direction leaves "aging" when the gap is dropped', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ dropComponentGap: true });

    await mount(page, green);
    const greenRow = page.getByTestId('gap-trends').locator('tbody tr[data-gap-class="coverage"]');
    await expect(greenRow).toHaveAttribute('data-direction', 'aging');
    await expect(greenRow).toHaveAttribute(
      'data-aged',
      String(green.trends.find((t) => t.gapClass === 'coverage')!.agedCount),
    );

    await mount(page, red);
    const redRow = page.getByTestId('gap-trends').locator('tbody tr[data-gap-class="coverage"]');
    await expect(redRow).not.toHaveAttribute('data-direction', 'aging');
    await expect(redRow).toHaveAttribute('data-aged', '0');
  });

  // ── AC4: forcing fresh removes the stale panel and stops withholding health ─────────────────────
  test('AC4 moves: the stale panel disappears (no withheld health) when the record is fresh', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ forceStaleRecordFresh: true });

    await mount(page, green);
    await expect(page.getByTestId('stale-marker')).toHaveAttribute(
      'data-reported-health',
      'unknown',
    );

    await mount(page, red);
    await expect(page.getByTestId('stale-marker')).toHaveCount(0);
    await expect(page.getByTestId('no-stale-inference')).toContainText('All contributing sources');
  });

  // ── AC5: stripping the discovery-evidence ref removes the rendered evidence link ────────────────
  test('AC5 moves: the discovery-evidence link becomes "no discovery evidence" when stripped', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ dropDiscoveryEvidence: true });

    await mount(page, green);
    // At least one discovered source has an evidence link in the GREEN render.
    await expect(page.getByTestId('discovered-sources').getByRole('link').first()).toBeVisible();

    await mount(page, red);
    // The unknown-classified discovered source now shows the "no discovery evidence" marker.
    await expect(
      page.getByTestId('discovered-sources').getByTestId('no-discovery-evidence').first(),
    ).toBeVisible();
  });

  // ── AC6: dropping the deadline drops the rendered governed-source row ───────────────────────────
  test('AC6 moves: a governed-source row disappears when its review/expiry deadline is dropped', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ dropGovernedGapReview: true });
    expect(red.rankedSourceGaps.length).toBeLessThan(green.rankedSourceGaps.length);

    await mount(page, green);
    await expect(page.getByTestId('ranked-source-gaps').locator('tbody tr')).toHaveCount(
      green.rankedSourceGaps.length,
    );

    await mount(page, red);
    await expect(page.getByTestId('ranked-source-gaps').locator('tbody tr')).toHaveCount(
      red.rankedSourceGaps.length,
    );
  });

  // ── AC3: collapsing to a single source shrinks the rendered distinct-source count ──────────────
  test('AC3 moves: the rendered distinct-source count shrinks when the input has one source', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ singleSourceOnly: true });

    await mount(page, green);
    const greenDistinct = await page
      .getByTestId('drilldown-text-summary')
      .getAttribute('data-distinct-sources');
    expect(Number(greenDistinct)).toBeGreaterThan(1);

    await mount(page, red);
    await expect(page.getByTestId('drilldown-text-summary')).toHaveAttribute(
      'data-distinct-sources',
      '1',
    );
  });

  // ── DIGEST: the rendered snapshot digest changes iff the governed state changes ────────────────
  test('DIGEST moves: <main data-snapshot-digest> changes when the scenario materially changes', async ({
    page,
  }) => {
    const green = defaultExecutivePosture();
    const red = deriveExecutivePosture({ dropComponentGap: true });
    expect(red.snapshotDigest).not.toBe(green.snapshotDigest);

    await mount(page, green);
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      green.snapshotDigest,
    );

    await mount(page, red);
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      red.snapshotDigest,
    );
  });
});
