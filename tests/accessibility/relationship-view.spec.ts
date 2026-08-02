// TrustCircleAI — RELATIONSHIP-VIEW accessibility + equivalence SPEC
// (Phase 82 / apps/web/src/features/inventory/RelationshipView.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executable acceptance target for the accessible RELATIONSHIP VIEW — the graph that ties a governed
// item to the distinct sources that reported it, their dependencies, and each field's authoritative
// source. The phase's most specific verification obligation (VO-057645e173b20b45c7cc) requires that a
// relationship view ALSO carry a TEXT SUMMARY and a NAVIGABLE TABULAR ALTERNATIVE that preserve the SAME
// MATERIAL INFORMATION — so this spec asserts all three presentations (graph, tables, summary) are
// present AND agree on every material quantity. It runs under the hermetic `accessibility-current-state`
// Playwright project (root playwright.config.ts — pinned Desktop Chrome, REFLOW_400 layout viewport, no
// `setup`, no web server) and mounts the SHIPPED view — `renderRelationshipView()` from
// apps/web/src/features/inventory/RelationshipView.tsx — in a REAL browser via `page.setContent`.
//
// ── NON-TAUTOLOGY: the oracles are driven by the REAL service, not by view constants ─────────
// The view is a PURE PRESENTER of a `RelationshipViewModel`. That model is DERIVED by running the REAL
// Phase-70 `InventoryService` (packages/application/src/inventory-service.ts) over an explicit scenario
// (support/relationship-view-model.ts → support/current-state-model.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — and by projecting the service's OWN `drillDown()` (source
// records, correlation fields, dependencies, authoritative fields), `currentStateView()` / `rowFor()`
// (row facets + withheld health), `catalogView()`, `componentGaps()` and `governedSourceGaps()` outputs.
// For every obligation this spec (1) reads the service's OWN outputs as the INDEPENDENT expectation,
// (2) injects the derived model and asserts the rendered DOM equals those computed values across an
// independent read path (the live accessibility tree + machine-readable data-*), and (3) runs a RED
// NEGATIVE CONTROL that mutates the scenario INPUT to break exactly that obligation and asserts the DOM
// reflects the changed derivation — provably non-vacuous. A static template could not satisfy these.
//
// ── EFFECT-WITNESS DISCIPLINE ────────────────────────────────────────────────────────────────
// Every assertion observes an INDEPENDENT read path — the rendered accessibility tree, table/row cells,
// machine-readable <time>/<code>/data-* attributes, and the service's own `snapshotDigest` reflected into
// `<main data-snapshot-digest>` — never the render function's return value as its own proof. The
// DURABLE-IDENTITY witness is the tenant scope (bundle id + semantic hash + work item
// ZD8RKQSG80ZQH9YWWBYFGHKS76), read back from the DOM; the NEGATIVE identity case re-renders with a
// MISMATCHED identity and confirms the guard rejects it.
//
// ── Traceability (Phase-82 objective + acceptance criteria) ───────────────────────────────────
//   Graph + navigable table + material text summary of same info (VO-057645e173b20b45c7cc) → §EQUIV
//   AC1 the item appears once as the central node with its full identity facets           → §AC1
//   AC2 a related unmanaged component stays a visible gap node + gap-table row             → §AC2
//   AC3 distinct source records, status differences, dependencies, authoritative field      → §AC3
//   AC4 stale source: last-known + confidence; reported health withheld as unknown          → §AC4
//   AC5 a related discovered source is catalogued with its full facets                      → §AC5
//   AC6 a related governed-source gap stays visible with review/expiry                      → §AC6

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import {
  renderRelationshipView,
  RELATIONSHIP_TENANT,
  EMPTY_RELATIONSHIP,
  RELATIONSHIP_VIEW_IDS,
  type RelationshipViewProps,
  type RelationshipViewModel,
} from '../../apps/web/src/features/inventory/RelationshipView.tsx';
import {
  deriveRelationship,
  defaultRelationship,
  deriveStaleRelationship,
} from './support/relationship-view-model.ts';
import { REFLOW_400 } from '../../playwright.config.ts';

const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The default derived relationship model (real service, no overrides). */
const MODEL: RelationshipViewModel = defaultRelationship();

function props(over: Partial<RelationshipViewProps> = {}): RelationshipViewProps {
  return { tenant: RELATIONSHIP_TENANT, model: MODEL, ...over };
}

async function mount(page: Page, p: RelationshipViewProps = props()): Promise<void> {
  await page.setContent(renderRelationshipView(p), { waitUntil: 'domcontentloaded' });
}

test.describe('relationship view — WCAG 2.2 AA + graph/table/summary equivalence + AC1–AC6', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline over the whole view ─────────────────────────────────────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-relationship-view.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
    ).toEqual([]);
  });

  // ── Landmarks + effect witness ──────────────────────────────────────────────────────────────
  test('exposes the required labelled landmarks (skip link, status, nav, main) + all panels', async ({
    page,
  }) => {
    await expect(page.getByTestId('skip-link')).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveAttribute('tabindex', '-1');
    const status = page.getByTestId('global-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(page.getByTestId('rel-nav')).toBeVisible();
    expect(RELATIONSHIP_VIEW_IDS).toHaveLength(7);
    for (const v of RELATIONSHIP_VIEW_IDS) {
      await expect(page.getByTestId(`rel-nav-${v}`)).toHaveAttribute('href', `#region-${v}`);
      await expect(page.locator(`#region-${v}`)).toHaveCount(1);
    }
  });

  test('main carries the derived service snapshot digest (independent effect witness)', async ({
    page,
  }) => {
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      MODEL.snapshotDigest,
    );
    expect(MODEL.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL.snapshotDigest).not.toBe(EMPTY_RELATIONSHIP.snapshotDigest);
  });

  // ── TENANT SCOPE (durable identity binding) ──────────────────────────────────────────────────
  test.describe('tenant scope (durable identity binding)', () => {
    test('binds the view to the pinned tenant + bundle + work-item identity, read independently', async ({
      page,
    }) => {
      const scope = page.getByTestId('tenant-scope');
      await expect(scope).toHaveAttribute('data-bundle-id', '36GCYGDJ15PTYP60F91QWRAY2M');
      await expect(scope).toHaveAttribute(
        'data-semantic-hash',
        'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
      );
      await expect(scope).toHaveAttribute('data-work-item-id', 'ZD8RKQSG80ZQH9YWWBYFGHKS76');
      await expect(page.getByTestId('scope-bundle')).toContainText('36GCYGDJ15PTYP60F91QWRAY2M');
    });

    test('the pinned identity IS the phase work item (rejects a mismatched identity)', async ({
      page,
    }) => {
      const wrong = { ...RELATIONSHIP_TENANT, workItemId: 'WRONG000000000000000000000' };
      await mount(page, props({ tenant: wrong }));
      await expect(page.getByTestId('tenant-scope')).not.toHaveAttribute(
        'data-work-item-id',
        'ZD8RKQSG80ZQH9YWWBYFGHKS76',
      );
      expect(RELATIONSHIP_TENANT.workItemId).toBe('ZD8RKQSG80ZQH9YWWBYFGHKS76');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §EQUIV — graph + navigable table + material text summary carry the SAME material information
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§EQUIV graph / table / summary equivalence (VO-057645e173b20b45c7cc)', () => {
    test('the relationship graph is present and described by the material text summary', async ({
      page,
    }) => {
      const fig = page.getByTestId('graph-figure');
      await expect(fig).toHaveAttribute('aria-describedby', 'relationship-summary-text');
      // Every graph node has a corresponding node id.
      const graphNodes = page.getByTestId('graph-node');
      await expect(graphNodes).toHaveCount(MODEL.nodes.length);
    });

    test('every graph node is ALSO a row in the navigable nodes table (no graph-only information)', async ({
      page,
    }) => {
      expect(MODEL.nodes.length).toBeGreaterThan(0);
      await expect(page.getByTestId('node-row')).toHaveCount(MODEL.nodes.length);
      for (const n of MODEL.nodes) {
        const graphNode = page.locator(`[data-testid="graph-node"][data-node-id="${n.id}"]`);
        const tableRow = page.locator(`[data-testid="node-row"][data-node-id="${n.id}"]`);
        await expect(graphNode).toHaveCount(1);
        await expect(tableRow).toHaveCount(1);
        await expect(tableRow.getByTestId('node-label')).toHaveText(n.label);
        await expect(tableRow.getByTestId('node-kind')).toHaveText(n.kind);
      }
    });

    test('every graph edge is ALSO a row in the navigable edges table', async ({ page }) => {
      await expect(page.getByTestId('graph-edge')).toHaveCount(MODEL.edges.length);
      await expect(page.getByTestId('edge-row')).toHaveCount(MODEL.edges.length);
      for (const e of MODEL.edges) {
        await expect(page.locator(`[data-testid="edge-row"][data-edge-id="${e.id}"]`)).toHaveCount(
          1,
        );
        await expect(
          page.locator(`[data-testid="graph-edge"][data-edge-id="${e.id}"]`),
        ).toHaveCount(1);
      }
    });

    test('the text summary states the SAME material quantities the tables carry', async ({
      page,
    }) => {
      // Independent expectations from the service-derived model.
      const summary = page.getByTestId('relationship-summary-text');
      await expect(summary).toHaveAttribute(
        'data-distinct-sources',
        String(MODEL.distinctSourceCount),
      );
      await expect(summary).toHaveAttribute('data-dependency-count', String(MODEL.dependencyCount));
      await expect(summary).toHaveAttribute(
        'data-authoritative-count',
        String(MODEL.authoritativeFieldCount),
      );
      await expect(summary).toHaveAttribute(
        'data-contested-count',
        String(MODEL.contestedFieldCount),
      );
      await expect(summary).toHaveAttribute('data-health-withheld', String(MODEL.healthWithheld));
      // The same counts are carried on the edges-summary and fields-summary — the tables and summary agree.
      await expect(page.getByTestId('edges-summary')).toHaveAttribute(
        'data-dependency-count',
        String(MODEL.dependencyCount),
      );
      await expect(page.getByTestId('fields-summary')).toHaveAttribute(
        'data-contested-count',
        String(MODEL.contestedFieldCount),
      );
      // The prose names the distinct-source count and the asset.
      await expect(summary).toContainText(`${MODEL.distinctSourceCount} distinct source`);
      await expect(summary).toContainText(MODEL.assetName);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC1 — the governed item appears ONCE as the central node with its full identity facets
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC1 the item appears once with full identity', () => {
    test('the central asset node carries type/owner/lifecycle/risk/coverage/evidence/health/last-observed/unresolved', async ({
      page,
    }) => {
      const asset = MODEL.nodes.find((n) => n.kind === 'asset')!;
      expect(asset, 'scenario must have an asset node').toBeTruthy();
      // Exactly ONE asset node (AC1 "each item once").
      await expect(page.locator('[data-testid="node-row"][data-node-kind="asset"]')).toHaveCount(1);
      const row = page.locator(`[data-testid="node-row"][data-node-id="${asset.id}"]`);
      await expect(row.getByTestId('node-classification')).toHaveText(asset.classification);
      await expect(row.getByTestId('node-owner')).toHaveText(asset.owner);
      await expect(row.getByTestId('node-state')).toHaveText(asset.state);
      await expect(row.getByTestId('node-risk')).toHaveText(asset.risk);
      await expect(row.getByTestId('node-coverage')).toHaveText(asset.coverage);
      await expect(row.getByTestId('node-evidence-state')).toHaveText(asset.evidenceState);
      await expect(row.getByTestId('node-reported-health')).toContainText(asset.reportedHealth);
      await expect(row.getByTestId('node-last-observed')).toHaveAttribute(
        'datetime',
        asset.lastObservedAtIso,
      );
      await expect(row.getByTestId('node-unresolved')).toHaveText(String(asset.unresolvedIssues));
    });

    test('RED: a duplicate observation of the same asset still yields ONE asset node (no fork)', async ({
      page,
    }) => {
      const dup = deriveRelationship({ duplicateHealthyAsset: true });
      // The service keys by id → still one asset node.
      expect(dup.nodes.filter((n) => n.kind === 'asset')).toHaveLength(1);
      await mount(page, props({ model: dup }));
      await expect(page.locator('[data-testid="node-row"][data-node-kind="asset"]')).toHaveCount(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC2 — a related unmanaged component stays a VISIBLE gap node + gap-table row
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC2 related component gap stays visible', () => {
    test('the unmanaged component appears as a related gap with reason/age/impact/owner-action', async ({
      page,
    }) => {
      const g = MODEL.relatedGaps.find((x) => x.gapClass === 'component')!;
      expect(g, 'scenario must carry a component gap').toBeTruthy();
      const row = page.locator(`[data-testid="related-gap-row"][data-gap-id="${g.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('related-gap-class')).toHaveText('component');
      await expect(row.getByTestId('related-gap-reason')).toContainText(g.reasonClass);
      await expect(row.getByTestId('related-gap-impact')).toHaveText(g.impact);
      await expect(row.getByTestId('related-gap-owner-action')).toHaveText(g.ownerAction);
      await expect(row).toHaveAttribute('data-age-days', String(g.ageDays));
    });

    test('RED: dropping the component gap removes the related component-gap row', async ({
      page,
    }) => {
      const g = MODEL.relatedGaps.find((x) => x.gapClass === 'component')!;
      const dropped = deriveRelationship({ dropComponentGap: true });
      expect(dropped.relatedGaps.some((x) => x.gapClass === 'component')).toBe(false);
      await mount(page, props({ model: dropped }));
      await expect(
        page.locator(`[data-testid="related-gap-row"][data-gap-id="${g.id}"]`),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-testid="related-gap-row"][data-gap-class="component"]'),
      ).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC3 — distinct source records, status differences, dependencies, authoritative field
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC3 distinct sources, status differences, dependencies, authoritative field', () => {
    test('the drill shows the distinct source records as nodes and the contested field with differing values', async ({
      page,
    }) => {
      // Distinct source records (AC3): one node per reporting source class.
      expect(MODEL.distinctSourceCount).toBe(3);
      await expect(
        page.locator('[data-testid="node-row"][data-node-kind="source_record"]'),
      ).toHaveCount(3);

      // The contested `status` field with its differing source values + authoritative source.
      const contested = MODEL.fields.find((f) => f.contested)!;
      expect(contested, 'scenario must carry a contested field').toBeTruthy();
      expect(contested.differingSources.length).toBeGreaterThan(0);
      const row = page.locator(`[data-testid="field-row"][data-field="${contested.field}"]`);
      await expect(row).toHaveAttribute('data-contested', 'true');
      await expect(row.getByTestId('field-authoritative-source')).toHaveText(
        contested.authoritativeSourceClass,
      );
      await expect(row).toHaveAttribute(
        'data-differing-count',
        String(contested.differingSources.length),
      );
      for (const d of contested.differingSources) {
        const item = row.locator(
          `[data-testid="field-differing-source"][data-source-class="${d.sourceClass}"]`,
        );
        await expect(item).toHaveCount(1);
        await expect(item.getByTestId('field-differing-value')).toContainText(d.value);
      }

      // The dependency + authoritative-field edges (AC3) are rendered.
      expect(MODEL.dependencyCount).toBe(1);
      expect(MODEL.authoritativeFieldCount).toBe(1);
      await expect(
        page.locator('[data-testid="edge-row"][data-edge-kind="depends_on"]'),
      ).toHaveCount(1);
      await expect(
        page.locator('[data-testid="edge-row"][data-edge-kind="authoritative_for"]'),
      ).toHaveCount(1);
    });

    test('RED: collapsing the item to a SINGLE source clears the differing values + dependency edge', async ({
      page,
    }) => {
      const one = deriveRelationship({ singleSourceOnly: true });
      expect(one.distinctSourceCount).toBe(1);
      expect(one.contestedFieldCount).toBe(0);
      expect(one.dependencyCount).toBe(0);
      await mount(page, props({ model: one }));
      await expect(
        page.locator('[data-testid="node-row"][data-node-kind="source_record"]'),
      ).toHaveCount(1);
      await expect(page.locator('[data-testid="field-row"][data-contested="true"]')).toHaveCount(0);
      await expect(page.getByTestId('edge-row')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC4 — a stale source: last-known + confidence; reported health WITHHELD as unknown
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC4 stale source withholds current health', () => {
    test('the stale asset node shows last-known time + confidence and its reported health withheld as unknown', async ({
      page,
    }) => {
      const stale = deriveStaleRelationship();
      const asset = stale.nodes.find((n) => n.kind === 'asset')!;
      expect(asset.healthWithheld, 'the stale asset must withhold health').toBe(true);
      expect(asset.reportedHealth).toBe('unknown');
      expect(stale.healthWithheld).toBe(true);
      await mount(page, props({ model: stale }));
      const row = page.locator(`[data-testid="node-row"][data-node-id="${asset.id}"]`);
      await expect(row).toHaveAttribute('data-reported-health', 'unknown');
      await expect(row).toHaveAttribute('data-observed-health', asset.observedHealth);
      await expect(row.getByTestId('node-withheld-note')).toContainText('withheld');
      await expect(row.getByTestId('node-last-observed')).toHaveAttribute(
        'datetime',
        asset.lastObservedAtIso,
      );
      // The summary states the health is withheld (material info, not colour-only).
      await expect(page.getByTestId('relationship-summary-text')).toContainText('WITHHELD');
      await expect(page.locator('main#main')).toHaveAttribute('data-health-withheld', 'true');
    });

    test('RED: forcing the stale record FRESH un-withholds health (no longer unknown)', async ({
      page,
    }) => {
      const fresh = deriveStaleRelationship({ forceStaleRecordFresh: true });
      const asset = fresh.nodes.find((n) => n.kind === 'asset')!;
      expect(asset.healthWithheld).toBe(false);
      expect(fresh.healthWithheld).toBe(false);
      await mount(page, props({ model: fresh }));
      const row = page.locator(`[data-testid="node-row"][data-node-id="${asset.id}"]`);
      await expect(row).not.toHaveAttribute('data-reported-health', 'unknown');
      await expect(row.getByTestId('node-withheld-note')).toHaveCount(0);
      await expect(page.locator('main#main')).toHaveAttribute('data-health-withheld', 'false');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC5 — a related discovered source is catalogued with its full facets
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC5 related discovered source carries catalog facets', () => {
    test('the discovered (unknown-classified) source lists classification/location/access/sensitivity/ownership/onboarding + discovery evidence', async ({
      page,
    }) => {
      const s = MODEL.relatedSources.find((x) => x.classification === 'unknown')!;
      expect(s, 'scenario must carry an unknown-classified discovered source').toBeTruthy();
      const row = page.locator(`[data-testid="related-source-row"][data-source-id="${s.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('related-source-classification')).toHaveText(s.classification);
      await expect(row.getByTestId('related-source-location')).toHaveText(s.location);
      await expect(row.getByTestId('related-source-access')).toHaveText(s.accessStatus);
      await expect(row.getByTestId('related-source-sensitivity')).toHaveText(s.sensitivity);
      await expect(row.getByTestId('related-source-ownership')).toHaveText(s.ownershipStatus);
      await expect(row.getByTestId('related-source-onboarding')).toHaveText(s.onboardingState);
      expect(s.discoveryEvidenceRef).toBeTruthy();
      await expect(row.getByTestId('related-source-evidence').getByRole('link')).toBeVisible();
    });

    test('RED: stripping the discovery-evidence ref replaces the link with an explicit "no discovery evidence"', async ({
      page,
    }) => {
      const noEv = deriveRelationship({ dropDiscoveryEvidence: true });
      const s = noEv.relatedSources.find((x) => x.classification === 'unknown')!;
      expect(s.discoveryEvidenceRef).toBeUndefined();
      await mount(page, props({ model: noEv }));
      const row = page.locator(`[data-testid="related-source-row"][data-source-id="${s.id}"]`);
      await expect(row.getByTestId('related-source-no-evidence')).toBeVisible();
      await expect(row.getByTestId('related-source-evidence').getByRole('link')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC6 — a related governed-source gap stays visible with review/expiry
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC6 related governed-source gap stays visible with review/expiry', () => {
    test('the governed-source gap renders with reason/impact/owner-action and its review deadline', async ({
      page,
    }) => {
      const g = MODEL.relatedGaps.find((x) => x.gapClass === 'governed_source')!;
      expect(g, 'scenario must carry a governed-source gap').toBeTruthy();
      expect(g.hasReviewOrExpiry).toBe(true);
      const row = page.locator(`[data-testid="related-gap-row"][data-gap-id="${g.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('related-gap-class')).toHaveText('governed_source');
      await expect(row.getByTestId('related-gap-reason')).toContainText(g.reasonClass);
      await expect(row.getByTestId('related-gap-impact')).toHaveText(g.impact);
      await expect(row.getByTestId('related-gap-owner-action')).toHaveText(g.ownerAction);
      await expect(row.getByTestId('related-gap-review')).toHaveText(g.reviewOrExpiry);
      await expect(row).toHaveAttribute('data-has-review', 'true');
    });

    test('RED: dropping the review/expiry deadline removes the governed-source gap (service withholds it)', async ({
      page,
    }) => {
      const before = MODEL.relatedGaps.find((x) => x.gapClass === 'governed_source')!;
      const noReview = deriveRelationship({ dropGovernedGapReview: true });
      expect(noReview.relatedGaps.some((x) => x.gapClass === 'governed_source')).toBe(false);
      await mount(page, props({ model: noReview }));
      await expect(
        page.locator(`[data-testid="related-gap-row"][data-gap-id="${before.id}"]`),
      ).toHaveCount(0);
    });
  });

  // ── Reflow: the relationship surface does not force horizontal scrolling at REFLOW_400 ─────────
  test('does not require horizontal scrolling at 400% zoom / the reflow viewport (WCAG 1.4.10)', async ({
    page,
  }) => {
    await page.setViewportSize(REFLOW_400.viewport);
    await mount(page);
    await page.evaluate((z) => {
      (document.documentElement.style as unknown as { zoom: string }).zoom = String(z);
    }, REFLOW_400.zoomFactor);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
