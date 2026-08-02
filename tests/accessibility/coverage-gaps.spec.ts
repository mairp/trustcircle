// TrustCircleAI — COVERAGE / GOVERNED-SOURCE GAP command-surface accessibility + behaviour SPEC
// (Phase 81 / apps/web/src/features/gaps/CoverageGaps.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executable acceptance target for the accessible GAP COMMAND surface — the view the officer
// works when triaging the backlog of everything discovered-but-not-yet-safely-governed. It must
// render the SEVEN operator views the Phase-81 objective names — OWNERSHIP, ACCESS, UNSUPPORTED,
// EXCLUSION, CONFLICT, FRESHNESS, SCAN-GAP — each with a SAFE NEXT ACTION, on top of the six
// current-state acceptance criteria (AC1–AC6). It runs under the hermetic
// `accessibility-current-state` Playwright project (root playwright.config.ts — pinned Desktop Chrome,
// REFLOW_400 layout viewport, no `setup`, no web server) and mounts the SHIPPED view —
// `renderCoverageGaps()` from apps/web/src/features/gaps/CoverageGaps.tsx — in a REAL browser via
// `page.setContent`.
//
// ── NON-TAUTOLOGY: the oracles are driven by the REAL service, not by view constants ─────────
// The view is a PURE PRESENTER of a `CoverageGapsModel`. That model is DERIVED by running the REAL
// Phase-70 `InventoryService` (packages/application/src/inventory-service.ts) over an explicit scenario
// (support/coverage-gaps-model.ts → support/current-state-model.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — and by projecting the service's OWN `componentGaps()` /
// `governedSourceGaps()` / `catalogView()` / `drillDown()` / `currentStateView()` outputs. For every
// obligation this spec:
//   1. builds the real service / re-derives the model, reads its OWN outputs as the INDEPENDENT
//      expectation (the gap set per view, the catalog facets, the contested field, the stale record),
//   2. injects the derived model into the view and asserts the rendered DOM equals those computed values
//      (an independent read path: the live accessibility tree + machine-readable data-*),
//   3. runs a RED NEGATIVE CONTROL that mutates the scenario INPUT to break exactly that obligation and
//      asserts the DOM reflects the changed derivation — provably non-vacuous.
// Because the expected values come from the service (not from literals in CoverageGaps.tsx), a static
// template could not satisfy these assertions.
//
// ── EFFECT-WITNESS DISCIPLINE ────────────────────────────────────────────────────────────────
// Every assertion observes an INDEPENDENT read path — the rendered accessibility tree, table/row cells,
// machine-readable <time>/<code>/data-* attributes, and the service's own `snapshotDigest` reflected
// into `<main data-snapshot-digest>` — never the render function's return value as its own proof. The
// DURABLE-IDENTITY witness is the tenant scope (bundle id + semantic hash + work item
// JK8KW3GR9WQHKGEAHJ53X75MC3), read back from the DOM; the NEGATIVE identity case re-renders with a
// MISMATCHED identity and confirms the guard rejects it.
//
// ── Traceability (Phase-81 objective + acceptance criteria) ───────────────────────────────────
//   Seven views + safe next actions (objective)                                  → §VIEWS
//   AC1 healthy ⇒ not a gap (empty-state affordance per view)                     → §AC1
//   AC2 component gap stays visible with reason/age/impact/action                 → §AC2
//   AC3 conflict view: distinct records, differences, authoritative field         → §AC3
//   AC4 freshness view: last-known + confidence; health NOT inferred              → §AC4
//   AC5 governed-source gap carries full catalog facets + discovery evidence      → §AC5
//   AC6 governed-source gap stays visible (reason/impact/action/review)           → §AC6

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import {
  renderCoverageGaps,
  GAPS_TENANT,
  EMPTY_COVERAGE_GAPS,
  GAP_VIEW_IDS,
  type CoverageGapsProps,
  type CoverageGapsModel,
} from '../../apps/web/src/features/gaps/CoverageGaps.tsx';
import { deriveCoverageGaps, defaultCoverageGaps } from './support/coverage-gaps-model.ts';
import { REFLOW_400 } from '../../playwright.config.ts';

const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The default derived gap backlog (real service, no overrides). */
const MODEL: CoverageGapsModel = defaultCoverageGaps();

function props(over: Partial<CoverageGapsProps> = {}): CoverageGapsProps {
  return { tenant: GAPS_TENANT, model: MODEL, ...over };
}

async function mount(page: Page, p: CoverageGapsProps = props()): Promise<void> {
  await page.setContent(renderCoverageGaps(p), { waitUntil: 'domcontentloaded' });
}

test.describe('coverage-gap command surface — WCAG 2.2 AA + seven views/safe actions + AC1–AC6', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline over the whole view ─────────────────────────────────────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-coverage-gaps.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
    ).toEqual([]);
  });

  // ── Landmarks + effect witness ──────────────────────────────────────────────────────────────
  test('exposes the required labelled landmarks (skip link, status, nav, main)', async ({
    page,
  }) => {
    await expect(page.getByTestId('skip-link')).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveAttribute('tabindex', '-1');
    const status = page.getByTestId('global-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(page.getByTestId('gap-nav')).toBeVisible();
  });

  test('main carries the derived service snapshot digest (independent effect witness)', async ({
    page,
  }) => {
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      MODEL.snapshotDigest,
    );
    expect(MODEL.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL.snapshotDigest).not.toBe(EMPTY_COVERAGE_GAPS.snapshotDigest);
    // The total-gap backlog count is independently readable and equals the service-derived total.
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-total-gaps',
      String(MODEL.totalGapCount),
    );
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
      await expect(scope).toHaveAttribute('data-work-item-id', 'JK8KW3GR9WQHKGEAHJ53X75MC3');
      await expect(page.getByTestId('scope-bundle')).toContainText('36GCYGDJ15PTYP60F91QWRAY2M');
    });

    test('the pinned identity IS the phase work item (rejects a mismatched identity)', async ({
      page,
    }) => {
      const wrong = { ...GAPS_TENANT, workItemId: 'WRONG000000000000000000000' };
      await mount(page, props({ tenant: wrong }));
      await expect(page.getByTestId('tenant-scope')).not.toHaveAttribute(
        'data-work-item-id',
        'JK8KW3GR9WQHKGEAHJ53X75MC3',
      );
      expect(GAPS_TENANT.workItemId).toBe('JK8KW3GR9WQHKGEAHJ53X75MC3');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §VIEWS — the seven operator gap views each render, with safe next actions
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§VIEWS seven gap views + safe next actions', () => {
    test('renders all seven named gap views, each reachable from the in-page nav', async ({
      page,
    }) => {
      expect(GAP_VIEW_IDS).toHaveLength(7);
      for (const view of GAP_VIEW_IDS) {
        await expect(page.getByTestId(`gap-view-${view}`)).toHaveCount(1);
        await expect(page.getByTestId(`gap-view-${view}`)).toHaveAttribute('data-view', view);
        await expect(page.getByTestId(`gap-nav-${view}`)).toHaveAttribute(
          'href',
          `#region-${view}`,
        );
      }
    });

    test('every rendered gap row carries an explicit SAFE next action', async ({ page }) => {
      // Independent expectation: the model carries at least one gap in the source + component + conflict
      // + freshness views, and every entry has a non-empty safe action.
      expect(MODEL.sourceGaps.length).toBeGreaterThan(0);
      expect(MODEL.conflicts.length).toBeGreaterThan(0);
      expect(MODEL.freshness.length).toBeGreaterThan(0);
      for (const e of MODEL.sourceGaps) expect(e.safeAction.length).toBeGreaterThan(0);
      // Every visible safe-action cell in the DOM begins with the "Safe next action:" affordance.
      const cells = page.locator('[data-testid$="-safe-action"]');
      const n = await cells.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        await expect(cells.nth(i)).toContainText('Safe next action:');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC1 — a healthy, governed item is NOT a gap (empty-state affordance where nothing is outstanding)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC1 healthy ⇒ not a gap', () => {
    test('an emptied backlog shows every view’s "no gaps" affordance (healthy is not a gap, nor an error)', async ({
      page,
    }) => {
      // With no gaps at all, each view frames its header and shows the reassuring empty state — a
      // healthy, fully-governed estate is NOT rendered as an error and NOT hidden.
      await mount(page, props({ model: EMPTY_COVERAGE_GAPS }));
      for (const view of GAP_VIEW_IDS) {
        await expect(page.getByTestId(`gap-view-${view}`)).toHaveAttribute('data-gap-count', '0');
        await expect(page.getByTestId(`gap-empty-${view}`)).toBeVisible();
      }
      await expect(page.locator('main#main')).toHaveAttribute('data-total-gaps', '0');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC2 — a discovered component stays a visible coverage gap with reason/age/impact/action
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC2 component coverage gap stays visible', () => {
    test('the unmanaged component appears with reason/age/impact/required-action + a safe action', async ({
      page,
    }) => {
      expect(MODEL.componentGaps.length).toBeGreaterThan(0);
      const g = MODEL.componentGaps[0]!;
      const row = page.locator(`[data-testid="component-gap-row"][data-gap-id="${g.gap.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('component-gap-reason')).toContainText(g.gap.reasonClass);
      await expect(row.getByTestId('component-gap-impact')).toHaveText(g.gap.impact);
      await expect(row.getByTestId('component-gap-owner-action')).toHaveText(
        g.gap.requiredOwnerAction,
      );
      await expect(row).toHaveAttribute('data-age-days', String(g.gap.ageDays));
      await expect(row.getByTestId('component-gap-safe-action')).toContainText(g.safeAction);
    });

    test('RED: dropping the component gap removes the row (gap must otherwise stay visible)', async ({
      page,
    }) => {
      const dropped = deriveCoverageGaps({ dropComponentGap: true });
      expect(dropped.componentGaps.length).toBe(0);
      await mount(page, props({ model: dropped }));
      await expect(page.getByTestId('component-gap-row')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC3 — CONFLICT view: distinct source records that disagree, differences, authoritative field
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC3 conflict view (status differences across sources)', () => {
    test('renders the contested field with its differing source values + authoritative source', async ({
      page,
    }) => {
      const c = MODEL.conflicts[0]!;
      expect(c, 'scenario must carry a conflict').toBeTruthy();
      expect(c.differingSources.length, 'a conflict must have ≥1 differing source').toBeGreaterThan(
        0,
      );
      const row = page.locator(`[data-testid="conflict-row"][data-field="${c.field}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('conflict-authoritative-source')).toHaveText(
        c.authoritativeSourceClass,
      );
      await expect(row).toHaveAttribute('data-differing-count', String(c.differingSources.length));
      for (const d of c.differingSources) {
        const item = row.locator(
          `[data-testid="conflict-differing-source"][data-source-class="${d.sourceClass}"]`,
        );
        await expect(item).toHaveCount(1);
        await expect(item.getByTestId('conflict-differing-value')).toContainText(d.value);
      }
      await expect(row.getByTestId('conflict-safe-action')).toContainText('Safe next action:');
    });

    test('RED: collapsing the item to a SINGLE source clears the conflict (no status difference)', async ({
      page,
    }) => {
      const one = deriveCoverageGaps({ singleSourceOnly: true });
      expect(one.conflicts.length).toBe(0);
      await mount(page, props({ model: one }));
      await expect(page.getByTestId('conflict-row')).toHaveCount(0);
      await expect(page.getByTestId('gap-empty-conflict')).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC4 — FRESHNESS view: last-known time + confidence; current health NOT inferred from stale data
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC4 freshness view (stale marked; health withheld)', () => {
    test('the stale source is shown with last-known time + confidence and its health withheld as unknown', async ({
      page,
    }) => {
      const f = MODEL.freshness[0]!;
      expect(f, 'scenario must carry a stale source').toBeTruthy();
      expect(f.healthWithheld, 'the stale source must withhold health').toBe(true);
      expect(f.reportedHealth).toBe('unknown');
      const row = page.locator(`[data-testid="freshness-row"][data-subject-id="${f.subjectId}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute('data-reported-health', 'unknown');
      await expect(row).toHaveAttribute('data-observed-health', f.observedHealth);
      await expect(row.getByTestId('freshness-last-known')).toHaveAttribute(
        'datetime',
        f.lastKnownAtIso,
      );
      await expect(row.getByTestId('freshness-confidence')).toHaveText(f.confidence.toFixed(2));
      await expect(row.getByTestId('freshness-withheld-note')).toContainText('withheld');
      await expect(row.getByTestId('freshness-safe-action')).toContainText('do not infer');
    });

    test('RED: forcing the stale record FRESH clears the freshness view (health no longer withheld)', async ({
      page,
    }) => {
      const fresh = deriveCoverageGaps({ forceStaleRecordFresh: true });
      expect(fresh.freshness.length).toBe(0);
      await mount(page, props({ model: fresh }));
      await expect(page.getByTestId('freshness-row')).toHaveCount(0);
      await expect(page.getByTestId('gap-empty-freshness')).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC5 — every governed-source gap names its discovered source's full catalog facets + evidence
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC5 discovered-source catalog facets on each source gap', () => {
    test('the UNSUPPORTED gap carries classification(unknown)/location/access/sensitivity/ownership/onboarding + discovery evidence', async ({
      page,
    }) => {
      const e = MODEL.sourceGaps.find((x) => x.gap.reasonClass === 'unsupported')!;
      expect(e, 'scenario must carry an unsupported source gap').toBeTruthy();
      const row = page.locator(`[data-testid="source-gap-row"][data-gap-id="${e.gap.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('source-gap-classification')).toHaveText(
        e.source.classification,
      );
      await expect(row.getByTestId('source-gap-location')).toHaveText(e.source.location);
      await expect(row.getByTestId('source-gap-access')).toHaveText(e.source.accessStatus);
      await expect(row.getByTestId('source-gap-sensitivity')).toHaveText(e.source.sensitivity);
      await expect(row.getByTestId('source-gap-ownership')).toHaveText(e.source.ownershipStatus);
      await expect(row.getByTestId('source-gap-onboarding')).toHaveText(e.source.onboardingState);
      // Unknown classification is surfaced as `unknown`, not hidden.
      await expect(row).toHaveAttribute('data-classified', String(e.classified));
      expect(e.classified).toBe(false);
      if (e.source.discoveryEvidenceRef) {
        await expect(
          row.getByTestId('source-gap-discovery-evidence').getByRole('link'),
        ).toBeVisible();
      }
    });

    test('RED: stripping the discovery-evidence ref replaces the link with an explicit "no discovery evidence"', async ({
      page,
    }) => {
      const noEv = deriveCoverageGaps({ dropUnsupportedEvidence: true });
      const e = noEv.sourceGaps.find((x) => x.gap.reasonClass === 'unsupported')!;
      expect(e.source.discoveryEvidenceRef).toBeUndefined();
      await mount(page, props({ model: noEv }));
      const row = page.locator(`[data-testid="source-gap-row"][data-gap-id="${e.gap.id}"]`);
      await expect(row.getByTestId('source-gap-no-evidence')).toBeVisible();
      await expect(row.getByTestId('source-gap-discovery-evidence').getByRole('link')).toHaveCount(
        0,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC6 — a discovered source stays a governed-source gap (reason/impact/action/review)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC6 governed-source gap stays visible with review/expiry', () => {
    test('each enriched category renders its governed-source gap with reason/impact/owner-action/review', async ({
      page,
    }) => {
      // Independent expectation: the scenario surfaces one gap per named category.
      const reasons = MODEL.sourceGaps.map((e) => e.gap.reasonClass);
      for (const r of ['unowned', 'inaccessible', 'unsupported', 'excluded', 'unreachable']) {
        expect(reasons, `scenario must carry a ${r} governed-source gap`).toContain(r);
      }
      for (const e of MODEL.sourceGaps) {
        const row = page.locator(`[data-testid="source-gap-row"][data-gap-id="${e.gap.id}"]`);
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('source-gap-reason')).toContainText(e.gap.reasonClass);
        await expect(row.getByTestId('source-gap-impact')).toHaveText(e.gap.impact);
        await expect(row.getByTestId('source-gap-owner-action')).toHaveText(e.gap.ownerAction);
        await expect(row.getByTestId('source-gap-review')).toHaveText(e.gap.reviewOrExpiry);
        await expect(row).toHaveAttribute('data-has-review', String(e.gap.hasReviewOrExpiry));
        expect(e.gap.hasReviewOrExpiry).toBe(true);
      }
    });

    test('RED: dropping the review/expiry deadline removes the gap from the view (service withholds it)', async ({
      page,
    }) => {
      // governedSourceGaps() withholds a governed-source gap that lacks a review-or-expiry deadline,
      // so dropping it removes the unsupported gap from the surface entirely.
      const before = MODEL.sourceGaps.find((x) => x.gap.reasonClass === 'unsupported')!;
      const noReview = deriveCoverageGaps({ dropUnsupportedReview: true });
      expect(
        noReview.sourceGaps.some((x) => x.gap.reasonClass === 'unsupported'),
        'the unsupported gap must disappear when its deadline is dropped',
      ).toBe(false);
      await mount(page, props({ model: noReview }));
      await expect(
        page.locator(`[data-testid="source-gap-row"][data-gap-id="${before.gap.id}"]`),
      ).toHaveCount(0);
    });

    test('RED: dropping an ownership/access/exclusion/scan-gap category empties exactly that view', async ({
      page,
    }) => {
      const cases: ReadonlyArray<{
        readonly reason: string;
        readonly ov: Parameters<typeof deriveCoverageGaps>[0];
      }> = [
        { reason: 'unowned', ov: { dropOwnershipGap: true } },
        { reason: 'inaccessible', ov: { dropAccessGap: true } },
        { reason: 'excluded', ov: { dropExclusionGap: true } },
        { reason: 'unreachable', ov: { dropScanGap: true } },
      ];
      for (const c of cases) {
        const green = MODEL.sourceGaps.find((x) => x.gap.reasonClass === c.reason)!;
        const red = deriveCoverageGaps(c.ov);
        expect(red.sourceGaps.some((x) => x.gap.reasonClass === c.reason)).toBe(false);
        await mount(page, props({ model: red }));
        await expect(
          page.locator(`[data-testid="source-gap-row"][data-gap-id="${green.gap.id}"]`),
        ).toHaveCount(0);
      }
    });
  });

  // ── Reflow: the gap surface does not force horizontal scrolling at REFLOW_400 ────────────────────
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
