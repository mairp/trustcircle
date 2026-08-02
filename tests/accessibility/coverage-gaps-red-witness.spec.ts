// TrustCircleAI — Phase 81 COVERAGE-GAP command-surface DOM-level RED witnesses.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item JK8KW3GR9WQHKGEAHJ53X75MC3.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES (and why it is separate)
// ───────────────────────────────────────────────────────────────────────────────────────────
// coverage-gaps.spec.ts proves each obligation is SATISFIED (GREEN) and carries an inline RED control
// per obligation. This file is the concentrated NON-VACUITY witness at the DOM level: it mounts BOTH the
// GREEN and the mutated (RED) renders of the SAME view in a real browser and asserts the rendered
// accessibility tree MOVES when — and only when — the scenario INPUT moves. Each pair is A→B: same view,
// different service-derived model, observably different DOM. A static template (which cannot move) fails
// every RED half here.
//
// One witness per gap-view obligation — AC2 component gap (dropped ⇒ row vanishes), AC3 conflict (single
// source ⇒ conflict clears), AC4 freshness (forced fresh ⇒ stale row + health-withheld note clear), AC5
// discovery evidence (stripped ⇒ link → note), AC6 review deadline (dropped ⇒ gap disappears), plus per-
// category source-gap drops (ownership/access/exclusion/scan-gap) and the digest witness. Expectations
// are read from the model DERIVED through the real Phase-70 InventoryService via deriveCoverageGaps() —
// never from view literals. Run under the hermetic `accessibility-current-state` Playwright project (no
// web server, no React, no auth).

import { test, expect, type Page } from '@playwright/test';

import {
  renderCoverageGaps,
  GAPS_TENANT,
  type CoverageGapsModel,
} from '../../apps/web/src/features/gaps/CoverageGaps.tsx';
import { deriveCoverageGaps, defaultCoverageGaps } from './support/coverage-gaps-model.ts';

function html(model: CoverageGapsModel): string {
  return renderCoverageGaps({ tenant: GAPS_TENANT, model });
}

async function mount(page: Page, model: CoverageGapsModel): Promise<void> {
  await page.setContent(html(model), { waitUntil: 'domcontentloaded' });
}

test.describe('coverage-gap surface — DOM-level RED witnesses (each view moves iff input moves)', () => {
  // ── AC2: the component-gap row vanishes when the gap is dropped ───────────────────────────────────
  test('AC2 moves: the component-gap row vanishes when the gap is dropped', async ({ page }) => {
    const green = defaultCoverageGaps();
    const red = deriveCoverageGaps({ dropComponentGap: true });
    expect(green.componentGaps.length).toBeGreaterThan(0);
    expect(red.componentGaps.length).toBe(0);

    await mount(page, green);
    await expect(page.getByTestId('component-gap-row')).toHaveCount(green.componentGaps.length);

    await mount(page, red);
    await expect(page.getByTestId('component-gap-row')).toHaveCount(0);
  });

  // ── AC3: collapsing to a single source clears the conflict ───────────────────────────────────────
  test('AC3 moves: the conflict row clears when the item collapses to a single source', async ({
    page,
  }) => {
    const green = defaultCoverageGaps();
    const red = deriveCoverageGaps({ singleSourceOnly: true });
    expect(green.conflicts.length).toBeGreaterThan(0);
    expect(red.conflicts.length).toBe(0);

    await mount(page, green);
    await expect(page.getByTestId('conflict-row')).toHaveCount(green.conflicts.length);

    await mount(page, red);
    await expect(page.getByTestId('conflict-row')).toHaveCount(0);
    await expect(page.getByTestId('gap-empty-conflict')).toBeVisible();
  });

  // ── AC4: forcing the stale record fresh clears the freshness row + the health-withheld note ──────
  test('AC4 moves: the freshness row + withheld-health note clear when the stale record is forced fresh', async ({
    page,
  }) => {
    const green = defaultCoverageGaps();
    const red = deriveCoverageGaps({ forceStaleRecordFresh: true });
    expect(green.freshness.length).toBeGreaterThan(0);
    expect(green.freshness[0]!.healthWithheld).toBe(true);
    expect(red.freshness.length).toBe(0);

    await mount(page, green);
    await expect(page.getByTestId('freshness-row')).toHaveCount(green.freshness.length);
    await expect(page.getByTestId('freshness-withheld-note').first()).toContainText('withheld');

    await mount(page, red);
    await expect(page.getByTestId('freshness-row')).toHaveCount(0);
    await expect(page.getByTestId('freshness-withheld-note')).toHaveCount(0);
  });

  // ── AC5: stripping the discovery-evidence ref turns the link into a note ─────────────────────────
  test('AC5 moves: the discovery-evidence link becomes "no discovery evidence" when stripped', async ({
    page,
  }) => {
    const green = defaultCoverageGaps();
    const red = deriveCoverageGaps({ dropUnsupportedEvidence: true });
    const gid = green.sourceGaps.find((e) => e.gap.reasonClass === 'unsupported')!.gap.id;
    expect(
      green.sourceGaps.find((e) => e.gap.id === gid)!.source.discoveryEvidenceRef,
    ).toBeTruthy();
    expect(
      red.sourceGaps.find((e) => e.gap.id === gid)!.source.discoveryEvidenceRef,
    ).toBeUndefined();

    await mount(page, green);
    await expect(
      page
        .locator(`[data-testid="source-gap-row"][data-gap-id="${gid}"]`)
        .getByTestId('source-gap-discovery-evidence')
        .getByRole('link'),
    ).toBeVisible();

    await mount(page, red);
    await expect(
      page
        .locator(`[data-testid="source-gap-row"][data-gap-id="${gid}"]`)
        .getByTestId('source-gap-no-evidence'),
    ).toBeVisible();
  });

  // ── AC6: dropping the review deadline removes the governed-source gap from the surface ───────────
  test('AC6 moves: the governed-source gap disappears when its review/expiry deadline is dropped', async ({
    page,
  }) => {
    const green = defaultCoverageGaps();
    const red = deriveCoverageGaps({ dropUnsupportedReview: true });
    const gid = green.sourceGaps.find((e) => e.gap.reasonClass === 'unsupported')!.gap.id;
    expect(green.sourceGaps.some((e) => e.gap.id === gid)).toBe(true);
    expect(red.sourceGaps.some((e) => e.gap.id === gid)).toBe(false);

    await mount(page, green);
    await expect(page.locator(`[data-testid="source-gap-row"][data-gap-id="${gid}"]`)).toHaveCount(
      1,
    );

    await mount(page, red);
    await expect(page.locator(`[data-testid="source-gap-row"][data-gap-id="${gid}"]`)).toHaveCount(
      0,
    );
  });

  // ── Per-category: each drop empties exactly its own view ─────────────────────────────────────────
  test('CATEGORY moves: ownership/access/exclusion/scan-gap each vanish when their gap is dropped', async ({
    page,
  }) => {
    const green = defaultCoverageGaps();
    const cases = [
      { reason: 'unowned', ov: { dropOwnershipGap: true } as const },
      { reason: 'inaccessible', ov: { dropAccessGap: true } as const },
      { reason: 'excluded', ov: { dropExclusionGap: true } as const },
      { reason: 'unreachable', ov: { dropScanGap: true } as const },
    ];
    for (const c of cases) {
      const gid = green.sourceGaps.find((e) => e.gap.reasonClass === c.reason)!.gap.id;
      const red = deriveCoverageGaps(c.ov);
      expect(red.sourceGaps.some((e) => e.gap.id === gid)).toBe(false);

      await mount(page, green);
      await expect(
        page.locator(`[data-testid="source-gap-row"][data-gap-id="${gid}"]`),
      ).toHaveCount(1);

      await mount(page, red);
      await expect(
        page.locator(`[data-testid="source-gap-row"][data-gap-id="${gid}"]`),
      ).toHaveCount(0);
    }
  });

  // ── DIGEST: the rendered snapshot digest changes iff the governed state changes ─────────────────
  test('DIGEST moves: <main data-snapshot-digest> changes when the scenario materially changes', async ({
    page,
  }) => {
    const green = defaultCoverageGaps();
    const red = deriveCoverageGaps({ dropOwnershipGap: true });
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
