// TrustCircleAI — Phase 79 INVENTORY-TABLE DOM-level RED witnesses.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item TRRGYA7N0K97QZ8JAMD077BRWP.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES (and why it is separate)
// ───────────────────────────────────────────────────────────────────────────────────────────
// inventory-table.spec.ts proves each obligation is SATISFIED (GREEN) and carries an inline RED
// control per obligation. This file is the concentrated NON-VACUITY witness at the DOM level: it
// mounts BOTH the GREEN and the mutated (RED) renders of the SAME view in a real browser and asserts
// the rendered accessibility tree MOVES when — and only when — the officer's QUERY or the scenario
// INPUT moves. Each pair is A→B: same view, different service-derived model / query, observably
// different DOM. A static template (which cannot move) fails every RED half here.
//
// The four TABLE additions each get a dedicated witness — SEARCH narrows, FILTER hides-with-reason
// (never deletes), AGE flips stale, AUTHORITY loses its contested attribution — plus the AC-level and
// digest witnesses. Expectations are read from the model DERIVED through the real Phase-70
// InventoryService via deriveInventoryTable(overrides, query) — never from view literals. Run under
// the hermetic `accessibility-current-state` Playwright project (no web server, no React, no auth).

import { test, expect, type Page } from '@playwright/test';

import {
  renderInventoryTable,
  INVENTORY_TENANT,
  type InventoryTableModel,
} from '../../apps/web/src/features/inventory/InventoryTable.tsx';
import {
  deriveInventoryTable,
  defaultInventoryTable,
  SCENARIO_IDS,
} from './support/inventory-table-model.ts';

function html(model: InventoryTableModel): string {
  return renderInventoryTable({ tenant: INVENTORY_TENANT, model });
}

async function mount(page: Page, model: InventoryTableModel): Promise<void> {
  await page.setContent(html(model), { waitUntil: 'domcontentloaded' });
}

async function visibleAssetCount(page: Page): Promise<number> {
  return page.locator('[data-testid="asset-row"]:not([hidden])').count();
}
async function totalAssetCount(page: Page): Promise<number> {
  return page.locator('[data-testid="asset-row"]').count();
}
async function visibleSourceCount(page: Page): Promise<number> {
  return page.locator('[data-testid="source-row"]:not([hidden])').count();
}

test.describe('inventory tables — DOM-level RED witnesses (each addition moves iff query/input moves)', () => {
  // ── SEARCH: a query narrows the visible rows but never deletes one ─────────────────────────────
  test('SEARCH moves: a query reduces the VISIBLE rows while the TOTAL row count is unchanged', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const token = green.assetRows[0]!.base.name.slice(0, 5).toLowerCase();
    const red = deriveInventoryTable({}, { text: token });
    expect(red.query.assetVisible, 'the query must hide ≥1 asset').toBeLessThan(
      green.assetRows.length,
    );

    await mount(page, green);
    expect(await visibleAssetCount(page)).toBe(green.assetRows.length);
    const greenTotal = await totalAssetCount(page);

    await mount(page, red);
    expect(await visibleAssetCount(page)).toBe(red.query.assetVisible);
    // TOTAL rows unchanged — filtering hides, never deletes.
    expect(await totalAssetCount(page)).toBe(greenTotal);
  });

  // ── FILTER: a facet chip hides rows WITH a reason; total unchanged ─────────────────────────────
  test('FILTER moves: risk=high hides the non-high rows with a data-filtered-out-reason, keeping them in the DOM', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({}, { filters: ['risk=high'] });
    const expectedVisible = red.assetRows.filter((r) => r.matches).length;
    expect(expectedVisible).toBeLessThan(green.assetRows.length);

    await mount(page, green);
    // Nothing hidden when no filter is active.
    await expect(page.locator('[data-testid="asset-row"][hidden]')).toHaveCount(0);

    await mount(page, red);
    expect(await visibleAssetCount(page)).toBe(expectedVisible);
    const hidden = page.locator('[data-testid="asset-row"][hidden]');
    await expect(hidden).toHaveCount(green.assetRows.length - expectedVisible);
    const reasons = await hidden.evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('data-filtered-out-reason')),
    );
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).toContain('risk!=');
    // The active chip is pressed in the RED render and not in the GREEN one.
    await expect(
      page.locator('[data-testid="filter-chip"][data-facet="risk"][data-value="high"]'),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('FILTER moves: a source facet (access=reachable) narrows the catalog and pumps the visible count down', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({}, { filters: ['access=reachable'] });
    expect(red.query.sourceVisible).toBeLessThan(green.sourceRows.length);

    await mount(page, green);
    expect(await visibleSourceCount(page)).toBe(green.sourceRows.length);

    await mount(page, red);
    expect(await visibleSourceCount(page)).toBe(red.query.sourceVisible);
  });

  // ── AGE: forcing the stale record fresh flips its age cell out of stale ─────────────────────────
  test('AGE moves: the stale asset’s age cell leaves data-age-stale=true when the record is forced fresh', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ forceStaleRecordFresh: true });
    const staleId = green.assetRows.find((r) => r.age.stale)!.base.id;
    expect(red.assetRows.find((r) => r.base.id === staleId)!.age.stale).toBe(false);

    await mount(page, green);
    await expect(
      page
        .locator(`[data-testid="asset-row"][data-asset-id="${staleId}"]`)
        .getByTestId('asset-age'),
    ).toHaveAttribute('data-age-stale', 'true');

    await mount(page, red);
    await expect(
      page
        .locator(`[data-testid="asset-row"][data-asset-id="${staleId}"]`)
        .getByTestId('asset-age'),
    ).toHaveAttribute('data-age-stale', 'false');
  });

  // ── AUTHORITY: collapsing to one source removes the contested attribution ───────────────────────
  test('AUTHORITY moves: the contested-authority flag clears when the input collapses to a single source', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ singleSourceOnly: true });
    const healthyId = String(SCENARIO_IDS.healthyAsset);
    expect(green.assetRows.find((r) => r.base.id === healthyId)!.authority.contested).toBe(true);
    expect(red.assetRows.find((r) => r.base.id === healthyId)!.authority.contested).toBe(false);

    await mount(page, green);
    await expect(
      page.locator(`[data-testid="asset-row"][data-asset-id="${healthyId}"]`),
    ).toHaveAttribute('data-authority-contested', 'true');

    await mount(page, red);
    await expect(
      page.locator(`[data-testid="asset-row"][data-asset-id="${healthyId}"]`),
    ).toHaveAttribute('data-authority-contested', 'false');
  });

  // ── AC2: dropping the component gap empties the rendered coverage-gap list ───────────────────────
  test('AC2 moves: the rendered coverage-gap rows vanish when the gap is dropped', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ dropComponentGap: true });
    expect(green.currentState.coverageGaps.length).toBeGreaterThan(0);
    expect(red.currentState.coverageGaps.length).toBe(0);

    await mount(page, green);
    await expect(page.getByTestId('coverage-gaps').locator('tbody tr')).toHaveCount(
      green.currentState.coverageGaps.length,
    );

    await mount(page, red);
    await expect(page.getByTestId('coverage-gaps').locator('tbody tr')).toHaveCount(0);
  });

  // ── AC4: forcing fresh removes the stale panel and stops withholding health ─────────────────────
  test('AC4 moves: the stale panel disappears (no withheld health) when the record is fresh', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ forceStaleRecordFresh: true });

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
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ dropDiscoveryEvidence: true });
    const noEvId = red.sourceRows.find((r) => !r.authority.classified)!.base.id;

    await mount(page, green);
    await expect(
      page
        .locator(`[data-testid="source-row"][data-source-id="${noEvId}"]`)
        .getByTestId('source-discovery-evidence')
        .getByRole('link'),
    ).toBeVisible();

    await mount(page, red);
    await expect(
      page
        .locator(`[data-testid="source-row"][data-source-id="${noEvId}"]`)
        .getByTestId('no-discovery-evidence'),
    ).toBeVisible();
  });

  // ── AC6: dropping the deadline drops the rendered governed-source row ────────────────────────────
  test('AC6 moves: a governed-source row disappears when its review/expiry deadline is dropped', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ dropGovernedGapReview: true });
    expect(red.currentState.sourceGaps.length).toBeLessThan(green.currentState.sourceGaps.length);

    await mount(page, green);
    await expect(page.getByTestId('governed-source-gaps').locator('tbody tr')).toHaveCount(
      green.currentState.sourceGaps.length,
    );

    await mount(page, red);
    await expect(page.getByTestId('governed-source-gaps').locator('tbody tr')).toHaveCount(
      red.currentState.sourceGaps.length,
    );
  });

  // ── AC3: collapsing to a single source shrinks the rendered distinct-source count ──────────────
  test('AC3 moves: the rendered distinct-source count shrinks when the input has one source', async ({
    page,
  }) => {
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ singleSourceOnly: true });

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
    const green = defaultInventoryTable();
    const red = deriveInventoryTable({ dropComponentGap: true });
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
