// TrustCircleAI — Phase 80 DRILL-DOWN DETAIL DOM-level RED witnesses.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item 384B1E4BN35A236DWJKY5MK8AE.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES (and why it is separate)
// ───────────────────────────────────────────────────────────────────────────────────────────
// inventory-detail.spec.ts proves each obligation is SATISFIED (GREEN) and carries an inline RED
// control per obligation. This file is the concentrated NON-VACUITY witness at the DOM level: it mounts
// BOTH the GREEN and the mutated (RED) renders of the SAME view in a real browser and asserts the
// rendered accessibility tree MOVES when — and only when — the scenario INPUT moves. Each pair is A→B:
// same view, different service-derived model, observably different DOM. A static template (which cannot
// move) fails every RED half here.
//
// One witness per drill-down obligation — AC1 idempotency (duplicate id ⇒ still one panel), AC3 distinct
// sources (single source shrinks the record set and clears the contested field), HISTORY (single source
// collapses each field to one version), AC2 component gap (dropped ⇒ rows vanish), AC4 stale (forced
// fresh ⇒ health no longer withheld), AC5 discovery evidence (stripped ⇒ link → note), AC6 review
// deadline (dropped ⇒ "no review or expiry"), plus the digest witness. Expectations are read from the
// model DERIVED through the real Phase-70 InventoryService via deriveInventoryDetail(overrides, assetId)
// — never from view literals. Run under the hermetic `accessibility-current-state` Playwright project
// (no web server, no React, no auth).

import { test, expect, type Page } from '@playwright/test';

import {
  renderInventoryDetail,
  DETAIL_TENANT,
  type InventoryDetailModel,
} from '../../apps/web/src/features/inventory/InventoryDetail.tsx';
import {
  deriveInventoryDetail,
  defaultInventoryDetail,
  SCENARIO_IDS,
} from './support/inventory-detail-model.ts';

function html(model: InventoryDetailModel): string {
  return renderInventoryDetail({ tenant: DETAIL_TENANT, model });
}

async function mount(page: Page, model: InventoryDetailModel): Promise<void> {
  await page.setContent(html(model), { waitUntil: 'domcontentloaded' });
}

async function recordCount(page: Page): Promise<number> {
  return page.locator('[data-testid="detail-record-row"]').count();
}

test.describe('inventory drill-down detail — DOM-level RED witnesses (each panel moves iff input moves)', () => {
  // ── AC1: a duplicate observation of the same id still yields ONE identity panel ─────────────────
  test('AC1 idempotent: a duplicate observation does NOT fork the identity panel', async ({
    page,
  }) => {
    const green = defaultInventoryDetail();
    const red = deriveInventoryDetail({ duplicateHealthyAsset: true });
    // Independent expectation: both derivations resolve to the SAME single asset id.
    expect(red.header.base.id).toBe(green.header.base.id);

    await mount(page, green);
    await expect(page.getByTestId('asset-identity')).toHaveCount(1);

    await mount(page, red);
    await expect(page.getByTestId('asset-identity')).toHaveCount(1);
    await expect(page.getByTestId('asset-identity')).toHaveAttribute(
      'data-asset-id',
      String(SCENARIO_IDS.healthyAsset),
    );
  });

  // ── AC3: collapsing to a single source shrinks the DISTINCT-record set and clears contested ─────
  test('AC3 moves: a single-source input shrinks the rendered record rows and clears the contested field', async ({
    page,
  }) => {
    const green = defaultInventoryDetail();
    const red = deriveInventoryDetail({ singleSourceOnly: true });
    expect(green.sourceRecords.length).toBeGreaterThan(red.sourceRecords.length);
    expect(green.fields.some((f) => f.contested)).toBe(true);
    expect(red.fields.some((f) => f.contested)).toBe(false);

    await mount(page, green);
    expect(await recordCount(page)).toBe(green.sourceRecords.length);
    await expect(
      page.locator('[data-testid="detail-field-row"][data-contested="true"]'),
    ).not.toHaveCount(0);

    await mount(page, red);
    expect(await recordCount(page)).toBe(red.sourceRecords.length);
    await expect(page.getByTestId('records-summary')).toHaveAttribute('data-distinct-sources', '1');
    await expect(
      page.locator('[data-testid="detail-field-row"][data-contested="true"]'),
    ).toHaveCount(0);
  });

  // ── HISTORY: a single source collapses each field's version list to one entry ───────────────────
  test('HISTORY moves: each field’s contributing-source version count shrinks when sources collapse', async ({
    page,
  }) => {
    const green = defaultInventoryDetail();
    const red = deriveInventoryDetail({ singleSourceOnly: true });
    const field = green.fields[0]!.field;
    const greenVersions = green.fields.find((f) => f.field === field)!.versions.length;
    const redVersions = red.fields.find((f) => f.field === field)!.versions.length;
    expect(greenVersions).toBeGreaterThan(redVersions);

    await mount(page, green);
    await expect(
      page.locator(`[data-testid="field-history"][data-field="${field}"]`),
    ).toHaveAttribute('data-version-count', String(greenVersions));

    await mount(page, red);
    await expect(
      page.locator(`[data-testid="field-history"][data-field="${field}"]`),
    ).toHaveAttribute('data-version-count', String(redVersions));
  });

  // ── AC2: dropping the component gap empties the rendered coverage-gap rows ───────────────────────
  test('AC2 moves: the component-gap rows vanish when the gap is dropped', async ({ page }) => {
    const green = deriveInventoryDetail({}, String(SCENARIO_IDS.gappedAsset));
    const red = deriveInventoryDetail({ dropComponentGap: true }, String(SCENARIO_IDS.gappedAsset));
    expect(green.componentGaps.length).toBeGreaterThan(0);
    expect(red.componentGaps.length).toBe(0);

    await mount(page, green);
    await expect(page.getByTestId('detail-component-gap-row')).toHaveCount(
      green.componentGaps.length,
    );

    await mount(page, red);
    await expect(page.getByTestId('detail-component-gap-row')).toHaveCount(0);
    await expect(page.getByTestId('no-component-gap')).toBeVisible();
  });

  // ── AC4: forcing the stale record fresh stops withholding health ────────────────────────────────
  test('AC4 moves: reportedHealth stops being withheld when the stale record is forced fresh', async ({
    page,
  }) => {
    const green = deriveInventoryDetail({}, String(SCENARIO_IDS.staleAsset));
    const red = deriveInventoryDetail(
      { forceStaleRecordFresh: true },
      String(SCENARIO_IDS.staleAsset),
    );
    expect(green.header.reportedHealth).toBe('unknown');
    expect(red.header.reportedHealth).not.toBe('unknown');

    await mount(page, green);
    await expect(page.getByTestId('identity-health')).toHaveAttribute(
      'data-reported-health',
      'unknown',
    );
    await expect(page.getByTestId('identity-health-note')).toBeVisible();

    await mount(page, red);
    await expect(page.getByTestId('identity-health')).toHaveAttribute(
      'data-reported-health',
      red.header.reportedHealth,
    );
    await expect(page.getByTestId('identity-health-note')).toHaveCount(0);
  });

  // ── AC5: stripping the discovery-evidence ref removes the rendered link ──────────────────────────
  test('AC5 moves: the discovery-evidence link becomes "no discovery evidence" when stripped', async ({
    page,
  }) => {
    const green = defaultInventoryDetail();
    const red = deriveInventoryDetail({ dropDiscoveryEvidence: true });
    expect(green.discoveredSource!.base.discoveryEvidenceRef).toBeTruthy();
    expect(red.discoveredSource!.base.discoveryEvidenceRef).toBeUndefined();

    await mount(page, green);
    await expect(page.getByTestId('ds-discovery-evidence').getByRole('link')).toBeVisible();

    await mount(page, red);
    await expect(page.getByTestId('ds-discovery-evidence').getByRole('link')).toHaveCount(0);
    await expect(page.getByTestId('ds-no-discovery-evidence')).toBeVisible();
  });

  // ── AC6: dropping the review/expiry deadline removes the gap from the AC6 view ───────────────────
  test('AC6 moves: the governed-source gap disappears from the drill-down when its deadline is dropped', async ({
    page,
  }) => {
    // governedSourceGaps() withholds a governed-source gap that has no review-or-expiry deadline, so
    // dropping the deadline removes the gap from the drill-down (visible → no longer tracked).
    const green = defaultInventoryDetail();
    const red = deriveInventoryDetail({ dropGovernedGapReview: true });
    expect(green.discoveredSource!.gap!.hasReviewOrExpiry).toBe(true);
    expect(red.discoveredSource!.gap).toBeUndefined();

    await mount(page, green);
    await expect(page.getByTestId('detail-source-gap')).toHaveAttribute('data-has-review', 'true');

    await mount(page, red);
    await expect(page.getByTestId('detail-source-gap')).toHaveCount(0);
    await expect(page.getByTestId('detail-source-no-gap')).toBeVisible();
  });

  // ── DIGEST: the rendered snapshot digest changes iff the governed state changes ─────────────────
  test('DIGEST moves: <main data-snapshot-digest> changes when the scenario materially changes', async ({
    page,
  }) => {
    const green = defaultInventoryDetail();
    const red = deriveInventoryDetail({ dropComponentGap: true });
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
