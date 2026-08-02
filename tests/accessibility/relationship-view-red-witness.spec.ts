// TrustCircleAI — Phase 82 RELATIONSHIP-VIEW DOM-level RED witnesses.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item ZD8RKQSG80ZQH9YWWBYFGHKS76.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES (and why it is separate)
// ───────────────────────────────────────────────────────────────────────────────────────────
// relationship-view.spec.ts proves each obligation is SATISFIED (GREEN) and carries an inline RED control
// per obligation. This file is the concentrated NON-VACUITY witness at the DOM level: it mounts BOTH the
// GREEN and the mutated (RED) renders of the SAME view in a real browser and asserts the rendered
// accessibility tree MOVES when — and only when — the scenario INPUT moves. Each pair is A→B: same view,
// different service-derived model, observably different DOM. A static template (which cannot move) fails
// every RED half here.
//
// One witness per relationship-view obligation —
//   EQUIV graph⇄table  — the graph node/edge counts and the table row counts move together;
//   AC1 identity        — a duplicate observation still yields ONE asset node (id-keyed, no fork);
//   AC2 component gap   — dropped ⇒ the gap node AND the gap row both vanish;
//   AC3 status diffs    — single source ⇒ the contested field + the dependency edge clear;
//   AC4 stale health    — forced fresh ⇒ the withheld-health note clears + data-health-withheld flips;
//   AC5 discovery ev.   — stripped ⇒ the discovery-evidence link → "no discovery evidence";
//   AC6 governed gap    — dropped review/expiry ⇒ the governed-source gap disappears;
//   DIGEST              — <main data-snapshot-digest> changes iff the governed state changes.
// Expectations are read from the model DERIVED through the real Phase-70 InventoryService via
// deriveRelationship() / deriveStaleRelationship() — never from view literals. Run under the hermetic
// `accessibility-current-state` Playwright project (no web server, no React, no auth).

import { test, expect, type Page } from '@playwright/test';

import {
  renderRelationshipView,
  RELATIONSHIP_TENANT,
  type RelationshipViewModel,
} from '../../apps/web/src/features/inventory/RelationshipView.tsx';
import {
  deriveRelationship,
  defaultRelationship,
  deriveStaleRelationship,
} from './support/relationship-view-model.ts';

function html(model: RelationshipViewModel): string {
  return renderRelationshipView({ tenant: RELATIONSHIP_TENANT, model });
}

async function mount(page: Page, model: RelationshipViewModel): Promise<void> {
  await page.setContent(html(model), { waitUntil: 'domcontentloaded' });
}

test.describe('relationship view — DOM-level RED witnesses (each presentation moves iff input moves)', () => {
  // ── EQUIV: the graph and the tables move together (no presentation drifts) ────────────────────────
  test('EQUIV moves: node/edge graph items and table rows change together when a source is dropped', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const red = deriveRelationship({ singleSourceOnly: true });
    expect(green.nodes.length).toBeGreaterThan(red.nodes.length);
    expect(green.edges.length).toBeGreaterThan(red.edges.length);

    await mount(page, green);
    await expect(page.getByTestId('graph-node')).toHaveCount(green.nodes.length);
    await expect(page.getByTestId('node-row')).toHaveCount(green.nodes.length);
    await expect(page.getByTestId('graph-edge')).toHaveCount(green.edges.length);
    await expect(page.getByTestId('edge-row')).toHaveCount(green.edges.length);

    await mount(page, red);
    // The graph and the table stay in lock-step — both drop to the RED counts.
    await expect(page.getByTestId('graph-node')).toHaveCount(red.nodes.length);
    await expect(page.getByTestId('node-row')).toHaveCount(red.nodes.length);
    await expect(page.getByTestId('graph-edge')).toHaveCount(red.edges.length);
    await expect(page.getByTestId('edge-row')).toHaveCount(red.edges.length);
  });

  // ── AC1: a duplicate observation still yields exactly ONE asset node (id-keyed, no fork) ──────────
  test('AC1 holds under duplication: a duplicate observation keeps a single asset node', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const dup = deriveRelationship({ duplicateHealthyAsset: true });
    expect(green.nodes.filter((n) => n.kind === 'asset')).toHaveLength(1);
    expect(dup.nodes.filter((n) => n.kind === 'asset')).toHaveLength(1);

    await mount(page, green);
    await expect(page.locator('[data-testid="node-row"][data-node-kind="asset"]')).toHaveCount(1);

    await mount(page, dup);
    await expect(page.locator('[data-testid="node-row"][data-node-kind="asset"]')).toHaveCount(1);
  });

  // ── AC2: the related component-gap row vanishes when the gap is dropped ──────────────────────────
  test('AC2 moves: the related component-gap row vanishes when the component gap is dropped', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const red = deriveRelationship({ dropComponentGap: true });
    expect(green.relatedGaps.some((g) => g.gapClass === 'component')).toBe(true);
    expect(red.relatedGaps.some((g) => g.gapClass === 'component')).toBe(false);

    await mount(page, green);
    await expect(
      page.locator('[data-testid="related-gap-row"][data-gap-class="component"]'),
    ).toHaveCount(1);

    await mount(page, red);
    await expect(
      page.locator('[data-testid="related-gap-row"][data-gap-class="component"]'),
    ).toHaveCount(0);
  });

  // ── AC3: collapsing to a single source clears the contested field + the dependency edge ──────────
  test('AC3 moves: the contested field row + dependency edge clear when the item has one source', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const red = deriveRelationship({ singleSourceOnly: true });
    expect(green.contestedFieldCount).toBeGreaterThan(0);
    expect(green.dependencyCount).toBeGreaterThan(0);
    expect(red.contestedFieldCount).toBe(0);
    expect(red.dependencyCount).toBe(0);

    await mount(page, green);
    await expect(page.locator('[data-testid="field-row"][data-contested="true"]')).toHaveCount(
      green.contestedFieldCount,
    );
    await expect(page.locator('[data-testid="edge-row"][data-edge-kind="depends_on"]')).toHaveCount(
      green.dependencyCount,
    );

    await mount(page, red);
    await expect(page.locator('[data-testid="field-row"][data-contested="true"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="edge-row"][data-edge-kind="depends_on"]')).toHaveCount(
      0,
    );
  });

  // ── AC4: forcing the stale record fresh clears the withheld-health note + flips the flag ─────────
  test('AC4 moves: the withheld-health note + data-health-withheld clear when the stale record is fresh', async ({
    page,
  }) => {
    const green = deriveStaleRelationship();
    const red = deriveStaleRelationship({ forceStaleRecordFresh: true });
    const staleAssetId = green.nodes.find((n) => n.kind === 'asset')!.id;
    expect(green.healthWithheld).toBe(true);
    expect(red.healthWithheld).toBe(false);

    await mount(page, green);
    await expect(page.locator('main#main')).toHaveAttribute('data-health-withheld', 'true');
    await expect(
      page
        .locator(`[data-testid="node-row"][data-node-id="${staleAssetId}"]`)
        .getByTestId('node-withheld-note'),
    ).toContainText('withheld');

    await mount(page, red);
    await expect(page.locator('main#main')).toHaveAttribute('data-health-withheld', 'false');
    await expect(
      page
        .locator(`[data-testid="node-row"][data-node-id="${staleAssetId}"]`)
        .getByTestId('node-withheld-note'),
    ).toHaveCount(0);
  });

  // ── AC5: stripping the discovery-evidence ref turns the link into a note ──────────────────────────
  test('AC5 moves: the discovery-evidence link becomes "no discovery evidence" when stripped', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const red = deriveRelationship({ dropDiscoveryEvidence: true });
    const sid = green.relatedSources.find((s) => s.classification === 'unknown')!.id;
    expect(green.relatedSources.find((s) => s.id === sid)!.discoveryEvidenceRef).toBeTruthy();
    expect(red.relatedSources.find((s) => s.id === sid)!.discoveryEvidenceRef).toBeUndefined();

    await mount(page, green);
    await expect(
      page
        .locator(`[data-testid="related-source-row"][data-source-id="${sid}"]`)
        .getByTestId('related-source-evidence')
        .getByRole('link'),
    ).toBeVisible();

    await mount(page, red);
    await expect(
      page
        .locator(`[data-testid="related-source-row"][data-source-id="${sid}"]`)
        .getByTestId('related-source-no-evidence'),
    ).toBeVisible();
  });

  // ── AC6: dropping the review/expiry deadline removes the governed-source gap from the surface ────
  test('AC6 moves: the governed-source gap disappears when its review/expiry deadline is dropped', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const red = deriveRelationship({ dropGovernedGapReview: true });
    const gid = green.relatedGaps.find((g) => g.gapClass === 'governed_source')!.id;
    expect(green.relatedGaps.some((g) => g.id === gid)).toBe(true);
    expect(red.relatedGaps.some((g) => g.id === gid)).toBe(false);

    await mount(page, green);
    await expect(page.locator(`[data-testid="related-gap-row"][data-gap-id="${gid}"]`)).toHaveCount(
      1,
    );

    await mount(page, red);
    await expect(page.locator(`[data-testid="related-gap-row"][data-gap-id="${gid}"]`)).toHaveCount(
      0,
    );
  });

  // ── DIGEST: the rendered snapshot digest changes iff the governed state changes ──────────────────
  test('DIGEST moves: <main data-snapshot-digest> changes when the scenario materially changes', async ({
    page,
  }) => {
    const green = defaultRelationship();
    const red = deriveRelationship({ dropComponentGap: true });
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
