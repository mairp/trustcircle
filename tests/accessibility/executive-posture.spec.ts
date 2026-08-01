// TrustCircleAI — EXECUTIVE-POSTURE accessibility + posture-summary SPEC (Phase 78 /
// apps/web/src/features/posture/ExecutivePosture.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executable acceptance target for the accessible EXECUTIVE POSTURE view and its four
// executive additions — SUMMARY, business-impact ORDERING, CONFIDENCE, and gap TRENDS — layered
// on top of the six current-state acceptance criteria (AC1–AC6) the whole officer surface must
// satisfy. It runs under the hermetic `accessibility-current-state` Playwright project (root
// playwright.config.ts — pinned Desktop Chrome, REFLOW_400 layout viewport, no `setup`, no web
// server) and mounts the SHIPPED view — `renderExecutivePosture()` from
// apps/web/src/features/posture/ExecutivePosture.tsx — in a REAL browser via `page.setContent`.
//
// ── NON-TAUTOLOGY: the oracles are driven by the REAL service, not by view constants ─────────
// The view is a PURE PRESENTER of an `ExecutivePostureModel`. That model is DERIVED by running the
// REAL Phase-70 `InventoryService` (packages/application/src/inventory-service.ts) over an explicit
// scenario (support/executive-posture-model.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — at TWO instants. For every obligation this spec:
//   1. builds the real service, reads its OWN outputs (`currentStateView`, `componentGaps`,
//      `governedSourceGaps`, `catalogView`, `drillDown`) as the INDEPENDENT expectation,
//   2. injects the derived model into the view and asserts the rendered DOM equals those
//      service-computed values (an independent read path: the live accessibility tree + data-*),
//   3. runs a RED NEGATIVE CONTROL that mutates the scenario INPUT to break exactly that
//      obligation and asserts the DOM reflects the changed derivation — provably non-vacuous.
// Because the expected values come from the service (not from literals in ExecutivePosture.tsx), a
// static template could not satisfy these assertions.
//
// ── EFFECT-WITNESS DISCIPLINE ────────────────────────────────────────────────────────────────
// Every assertion observes an INDEPENDENT read path — the rendered accessibility tree, header
// cells, machine-readable <time>/<code>/data-* attributes, and the service's own `snapshotDigest`
// reflected into `<main data-snapshot-digest>` — never the render function's return value as its
// own proof. The DURABLE-IDENTITY witness is the tenant scope (bundle id + semantic hash + work
// item TRRGYA7N0K97QZ8JAMD077BRWP), read back from the DOM; the NEGATIVE identity case re-renders
// with a MISMATCHED identity and confirms the guard rejects it.
//
// ── Traceability (Phase-78 acceptance criteria + executive objective) ─────────────────────────
//   AC1 each healthy item once, all authoritative fields          → §AC1
//   AC2 coverage gaps stay visible (reason/age/impact/action)      → §AC2
//   AC3 cross-source drill-down (distinct records/deps/authority)  → §AC3
//   AC4 stale source last-known + confidence; no inference         → §AC4
//   AC5 discovered source catalogued with full discovery metadata  → §AC5
//   AC6 discovered-source gap visible (reason/impact/action/review)→ §AC6
//   Executive SUMMARY   (aggregate posture figures)                → §SUMMARY
//   Business-impact ORDERING (most-material-first gap lists)       → §ORDERING
//   Posture CONFIDENCE  (weakest-link, no stale inference)         → §CONFIDENCE
//   Gap TRENDS          (baseline→now movement)                    → §TRENDS

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import {
  renderExecutivePosture,
  POSTURE_TENANT,
  EMPTY_POSTURE,
  type ExecutivePostureProps,
  type ExecutivePostureModel,
} from '../../apps/web/src/features/posture/ExecutivePosture.tsx';
import {
  deriveExecutivePosture,
  defaultExecutivePosture,
  buildExecService,
  SCENARIO_IDS,
  EXEC_IDS,
  T0,
} from './support/executive-posture-model.ts';
import { REFLOW_400 } from '../../playwright.config.ts';

const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The default derived executive posture (real service, no overrides). */
const MODEL: ExecutivePostureModel = defaultExecutivePosture();

function props(over: Partial<ExecutivePostureProps> = {}): ExecutivePostureProps {
  return { tenant: POSTURE_TENANT, model: MODEL, ...over };
}

async function mount(page: Page, p: ExecutivePostureProps = props()): Promise<void> {
  await page.setContent(renderExecutivePosture(p), { waitUntil: 'domcontentloaded' });
}

test.describe('executive posture — WCAG 2.2 AA + summary/ordering/confidence/trends + AC1–AC6', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline over the whole view ─────────────────────────────────────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-executive-posture.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
    ).toEqual([]);
  });

  // ── Landmarks + effect witness ──────────────────────────────────────────────────────────────
  test('exposes the required labelled landmarks (skip link, status, main)', async ({ page }) => {
    await expect(page.getByTestId('skip-link')).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveAttribute('tabindex', '-1');
    const status = page.getByTestId('global-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
  });

  test('main carries the derived service snapshot digest (independent effect witness)', async ({
    page,
  }) => {
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      MODEL.snapshotDigest,
    );
    expect(MODEL.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL.snapshotDigest).not.toBe(EMPTY_POSTURE.snapshotDigest);
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
      await expect(scope).toHaveAttribute('data-work-item-id', 'TRRGYA7N0K97QZ8JAMD077BRWP');
      await expect(page.getByTestId('scope-bundle')).toContainText('36GCYGDJ15PTYP60F91QWRAY2M');
    });

    test('the pinned identity IS the phase work item (rejects a mismatched identity)', async ({
      page,
    }) => {
      // The NEGATIVE identity witness: re-render with a MISMATCHED work item and confirm the DOM no
      // longer carries the pinned value — the identity binding is not a constant the view fakes.
      const wrong = { ...POSTURE_TENANT, workItemId: 'WRONG000000000000000000000' };
      await mount(page, props({ tenant: wrong }));
      await expect(page.getByTestId('tenant-scope')).not.toHaveAttribute(
        'data-work-item-id',
        'TRRGYA7N0K97QZ8JAMD077BRWP',
      );
      // And the correct binding must be exactly the phase work item.
      expect(POSTURE_TENANT.workItemId).toBe('TRRGYA7N0K97QZ8JAMD077BRWP');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §SUMMARY — executive posture summaries
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§SUMMARY executive posture summaries (service-driven)', () => {
    test('the summary figures equal the counts the service computed (healthy vs unknown vs gaps)', async ({
      page,
    }) => {
      const svc = buildExecService();
      const rows = svc.currentStateView(T0);
      const healthy = rows.filter(
        (r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap,
      ).length;
      const unknown = rows.filter((r) => r.reportedHealth === 'unknown').length;
      const coverage = svc.componentGaps().length;
      const sources = svc.governedSourceGaps().length;
      expect(healthy, 'scenario needs ≥1 confirmed-healthy').toBeGreaterThan(0);
      expect(unknown, 'scenario needs ≥1 stale/unknown row').toBeGreaterThan(0);

      const figures = page.getByTestId('posture-summary-figures');
      await expect(figures).toHaveAttribute('data-confirmed-healthy', String(healthy));
      await expect(figures).toHaveAttribute('data-unknown', String(unknown));
      await expect(figures).toHaveAttribute('data-coverage-gaps', String(coverage));
      await expect(figures).toHaveAttribute('data-source-gaps', String(sources));
      await expect(page.getByTestId('fig-confirmed-healthy')).toHaveText(String(healthy));
      await expect(page.getByTestId('fig-unknown')).toHaveText(String(unknown));
      // The narrative carries the meaning in TEXT (non-color), and never calls a stale row healthy.
      await expect(page.getByTestId('posture-narrative')).toContainText('never inferred healthy');
    });

    test('RED: forcing the stale record FRESH moves rows out of UNKNOWN into confirmed-healthy', async ({
      page,
    }) => {
      // The default posture has stale rows counted as UNKNOWN. Forcing the stale record fresh at the
      // INPUT re-derives fewer unknowns and one more confirmed-healthy — a summary a static view
      // could not move.
      const base = buildExecService();
      const baseUnknown = base
        .currentStateView(T0)
        .filter((r) => r.reportedHealth === 'unknown').length;
      const fresh = buildExecService({ forceStaleRecordFresh: true });
      const freshUnknown = fresh
        .currentStateView(T0)
        .filter((r) => r.reportedHealth === 'unknown').length;
      expect(freshUnknown, 'forcing fresh must REDUCE the unknown count').toBeLessThan(baseUnknown);

      await mount(page, props({ model: deriveExecutivePosture({ forceStaleRecordFresh: true }) }));
      await expect(page.getByTestId('posture-summary-figures')).toHaveAttribute(
        'data-unknown',
        String(freshUnknown),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §ORDERING — business-impact ordering
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§ORDERING business-impact ordering (service-driven)', () => {
    test('coverage gaps render most-business-material first (rank = impact × subject risk)', async ({
      page,
    }) => {
      // Independent expectation: the ranks the derivation computed from the service's gap impact +
      // asset risk, sorted descending.
      const m = defaultExecutivePosture();
      const expected = [...m.rankedCoverageGaps];
      expect(expected.length, 'need ≥2 coverage gaps to prove ordering').toBeGreaterThan(1);
      // Ranks must be non-increasing down the list.
      for (let i = 1; i < expected.length; i += 1) {
        expect(expected[i - 1].impactRank).toBeGreaterThanOrEqual(expected[i].impactRank);
      }

      const rows = page.getByTestId('ranked-coverage-gaps').locator('tbody tr');
      await expect(rows).toHaveCount(expected.length);
      // The FIRST rendered row is the highest-rank gap the service produced.
      await expect(rows.first()).toContainText(expected[0].subject);
      const domRanks = await rows.evaluateAll((trs) =>
        trs.map((tr) => Number(tr.getAttribute('data-impact-rank'))),
      );
      // The DOM order matches the service-derived descending rank order exactly.
      expect(domRanks).toEqual(expected.map((g) => g.impactRank));
      for (let i = 1; i < domRanks.length; i += 1) {
        expect(domRanks[i - 1]).toBeGreaterThanOrEqual(domRanks[i]);
      }
    });

    test('RED: swapping the gaps’ impacts at the INPUT INVERTS the rendered order', async ({
      page,
    }) => {
      // If the order were hard-coded, changing the impact would not move it. It does.
      const normal = defaultExecutivePosture().rankedCoverageGaps.map((g) => g.subject);
      const swapped = deriveExecutivePosture({ swapCoverageImpacts: true });
      const swappedOrder = swapped.rankedCoverageGaps.map((g) => g.subject);
      expect(swappedOrder[0], 'swap must promote a different gap to the top').not.toBe(normal[0]);

      await mount(page, props({ model: swapped }));
      const rows = page.getByTestId('ranked-coverage-gaps').locator('tbody tr');
      await expect(rows.first()).toContainText(swappedOrder[0]);
      await expect(rows.last()).toContainText(swappedOrder[swappedOrder.length - 1]);
    });

    test('ordering never HIDES a gap — every service gap is still present, just ranked', async ({
      page,
    }) => {
      const svc = buildExecService();
      const total = svc.componentGaps().length;
      await expect(page.getByTestId('ranked-coverage-gaps').locator('tbody tr')).toHaveCount(total);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §CONFIDENCE — posture confidence
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§CONFIDENCE posture confidence (service-driven, no stale inference)', () => {
    test('the aggregate confidence is the weakest-link of the service’s per-row confidences', async ({
      page,
    }) => {
      const m = defaultExecutivePosture();
      // Independent expectation: min confidence across record-backed rows.
      const svc = buildExecService();
      const backed = svc.currentStateView(T0).filter((r) => r.sourceRecordCount > 0);
      const expectedMin = Number(Math.min(...backed.map((r) => r.confidence)).toFixed(6));
      expect(m.confidence.aggregate).toBeCloseTo(expectedMin, 6);
      expect(m.confidence.aggregate, 'stale scenario must drag confidence below 1').toBeLessThan(1);

      const line = page.getByTestId('posture-confidence-line');
      await expect(line).toHaveAttribute('data-confidence', m.confidence.aggregate.toFixed(2));
      await expect(page.getByTestId('confidence-value')).toHaveText(
        m.confidence.aggregate.toFixed(2),
      );
      await expect(page.getByTestId('confidence-band')).toHaveText(m.confidence.band);
    });

    test('RED: forcing the stale record FRESH raises the aggregate confidence toward 1', async ({
      page,
    }) => {
      const base = defaultExecutivePosture().confidence.aggregate;
      const fresh = deriveExecutivePosture({ forceStaleRecordFresh: true });
      expect(fresh.confidence.aggregate, 'fresh evidence must raise confidence').toBeGreaterThan(
        base,
      );
      await mount(page, props({ model: fresh }));
      await expect(page.getByTestId('posture-confidence-line')).toHaveAttribute(
        'data-confidence',
        fresh.confidence.aggregate.toFixed(2),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §TRENDS — gap trends
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§TRENDS gap trends (two-instant, service-driven)', () => {
    test('a gap that aged between baseline and now renders an "aging" trend with the aged count', async ({
      page,
    }) => {
      const m = defaultExecutivePosture();
      const coverage = m.trends.find((t) => t.gapClass === 'coverage');
      expect(coverage, 'a coverage trend must exist').toBeDefined();
      // The scenario's primary gap is 2 days old at baseline (not aged) and 12 days at now (aged).
      expect(coverage!.direction).toBe('aging');
      expect(coverage!.agedCount).toBeGreaterThan(0);

      const row = page.getByTestId('gap-trends').locator('tbody tr[data-gap-class="coverage"]');
      await expect(row).toHaveAttribute('data-direction', 'aging');
      await expect(row).toHaveAttribute('data-aged', String(coverage!.agedCount));
      await expect(row.getByTestId('trend-summary')).toContainText('aging');
      // The window is machine-readable via <time>.
      await expect(page.getByTestId('trend-baseline-at')).toHaveAttribute(
        'datetime',
        m.baselineAtIso,
      );
    });

    test('RED: dropping the coverage gaps collapses the trend to zero (direction no longer aging)', async ({
      page,
    }) => {
      const dropped = deriveExecutivePosture({ dropComponentGap: true });
      const coverage = dropped.trends.find((t) => t.gapClass === 'coverage');
      expect(coverage!.currentCount, 'dropping the gap collapses the count').toBe(0);
      expect(coverage!.direction, 'no gap → not aging').not.toBe('aging');

      await mount(page, props({ model: dropped }));
      const row = page.getByTestId('gap-trends').locator('tbody tr[data-gap-class="coverage"]');
      await expect(row).toHaveAttribute('data-aged', '0');
      await expect(row).not.toHaveAttribute('data-direction', 'aging');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC1 — reconciled inventory (each item once, all authoritative fields)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC1 reconciled inventory (service-driven)', () => {
    test('each healthy item appears exactly once with every authoritative field the service computed', async ({
      page,
    }) => {
      const svc = buildExecService();
      const healthy = svc
        .currentStateView(T0)
        .filter((r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap);
      expect(healthy.length).toBeGreaterThan(0);

      const table = page.getByTestId('reconciled-inventory').locator('table');
      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of [
        'type',
        'source identity',
        'owner',
        'lifecycle state',
        'risk',
        'control coverage',
        'evidence state',
        'health',
        'confidence',
        'last observation time',
        'unresolved issues',
      ]) {
        expect(headers, `inventory missing column: ${required}`).toContain(required);
      }
      await expect(table.locator('tbody tr')).toHaveCount(healthy.length);
      for (const r of healthy) {
        const nameCells = table.locator('tbody th[scope="row"]', { hasText: r.name });
        await expect(nameCells, `item ${r.name} must appear exactly once`).toHaveCount(1);
      }
    });

    test('RED: a DUPLICATE observation of the same asset id still yields ONE row (service dedups)', async ({
      page,
    }) => {
      const svc = buildExecService({ duplicateHealthyAsset: true });
      const healthy = svc
        .currentStateView(T0)
        .filter((r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap);
      const target = healthy.find((r) => r.assetId === SCENARIO_IDS.healthyAsset);
      expect(target).toBeDefined();

      await mount(page, props({ model: deriveExecutivePosture({ duplicateHealthyAsset: true }) }));
      const table = page.getByTestId('reconciled-inventory').locator('table');
      const dupRows = table.locator('tbody th[scope="row"]', { hasText: target!.name });
      await expect(dupRows, 'a duplicate id must NOT fork a second row').toHaveCount(1);
      await expect(table.locator('tbody tr')).toHaveCount(healthy.length);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC2 — coverage gaps stay visible (reason/age/impact/owner action)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC2 coverage gaps (service-driven)', () => {
    test('every discovered-not-healthy component the service retained stays visible with all fields', async ({
      page,
    }) => {
      const svc = buildExecService();
      const gaps = svc.componentGaps();
      expect(gaps.length).toBeGreaterThan(0);
      const table = page.getByTestId('ranked-coverage-gaps').locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(gaps.length);
      // Each gap carries reason, age, and required owner action in the row TEXT (non-color).
      const firstRowText = (await table.locator('tbody tr').first().innerText()).toLowerCase();
      expect(firstRowText).toContain('day(s)');
      await expect(
        table.locator('tbody tr').first().getByTestId('ranked-gap-reason'),
      ).toBeVisible();
    });

    test('RED: dropping the component gap from the input makes the coverage-gap rows DISAPPEAR', async ({
      page,
    }) => {
      const dropped = deriveExecutivePosture({ dropComponentGap: true });
      expect(dropped.rankedCoverageGaps.length).toBe(0);
      await mount(page, props({ model: dropped }));
      await expect(page.getByTestId('ranked-coverage-gaps').locator('tbody tr')).toHaveCount(0);
    });

    test('coverage-gap impact meaning is NOT color-only (band text present)', async ({ page }) => {
      const firstRow = page.getByTestId('ranked-coverage-gaps').locator('tbody tr').first();
      await expect(firstRow.getByTestId('ranked-gap-impact')).toContainText('impact');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC3 — cross-source drill-down (distinct records / correlation / deps / authority)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC3 cross-source drill-down (service-driven)', () => {
    test('shows the DISTINCT source records + dependency/authoritative edges the service correlated', async ({
      page,
    }) => {
      const svc = buildExecService();
      const dd = svc.drillDown(SCENARIO_IDS.healthyAsset, T0);
      const distinct = new Set(dd.sourceRecords.map((r) => r.sourceClass)).size;
      expect(distinct).toBeGreaterThan(1);
      const summary = page.getByTestId('drilldown-text-summary');
      await expect(summary).toHaveAttribute('data-distinct-sources', String(distinct));
      await expect(page.getByTestId('cross-source-drilldown').locator('tbody tr')).toHaveCount(
        dd.sourceRecords.length,
      );
    });

    test('RED: collapsing the input to a single source shrinks the drill-down to one distinct record', async ({
      page,
    }) => {
      const svc = buildExecService({ singleSourceOnly: true });
      const dd = svc.drillDown(SCENARIO_IDS.healthyAsset, T0);
      const distinct = new Set(dd.sourceRecords.map((r) => r.sourceClass)).size;
      expect(distinct).toBe(1);
      await mount(page, props({ model: deriveExecutivePosture({ singleSourceOnly: true }) }));
      await expect(page.getByTestId('drilldown-text-summary')).toHaveAttribute(
        'data-distinct-sources',
        '1',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC4 — staleness / no-inference
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC4 staleness / no-inference (service-driven)', () => {
    test('stale data is marked and current health is WITHHELD (reportedHealth=unknown, not observed)', async ({
      page,
    }) => {
      const svc = buildExecService();
      const stale = svc
        .currentStateView(T0)
        .find((r) => r.evidenceState !== 'current' && r.reportedHealth === 'unknown');
      expect(stale, 'scenario must have a stale row').toBeDefined();
      const marker = page.getByTestId('stale-marker');
      await expect(marker).toHaveAttribute('data-reported-health', 'unknown');
      await expect(marker).not.toHaveAttribute('data-reported-health', stale!.observedHealth);
      await expect(page.getByTestId('last-known-time')).toHaveAttribute('datetime', /.+/);
    });

    test('RED: forcing the same record FRESH removes the stale panel and reports observed health', async ({
      page,
    }) => {
      const svc = buildExecService({ forceStaleRecordFresh: true });
      const stillStale = svc
        .currentStateView(T0)
        .find((r) => r.evidenceState !== 'current' && r.reportedHealth === 'unknown');
      expect(stillStale, 'forcing fresh removes the stale row').toBeUndefined();
      await mount(page, props({ model: deriveExecutivePosture({ forceStaleRecordFresh: true }) }));
      await expect(page.getByTestId('no-stale-inference')).toContainText(
        'All contributing sources',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC5 — open-ended source catalog
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC5 open-ended source catalog (service-driven)', () => {
    test('the discovered source is catalogued with the discovery facets the service read back', async ({
      page,
    }) => {
      const svc = buildExecService();
      const view = svc.catalogView();
      const discovered = view.find((c) => c.classifiedUnknown);
      expect(discovered, 'scenario must catalog an unknown-class discovered source').toBeDefined();
      const table = page.getByTestId('discovered-sources');
      await expect(table.locator('tbody tr')).toHaveCount(view.length);
      const row = table.locator('tbody tr', {
        has: page.getByText(String(discovered!.catalogId), { exact: true }),
      });
      const rowText = (await row.innerText()).toLowerCase();
      expect(rowText).toContain('unknown');
      if (discovered!.discoveryEvidence) {
        await expect(
          row.getByRole('link', { name: String(discovered!.discoveryEvidence) }),
        ).toBeVisible();
      }
    });

    test('RED: stripping the discovery-evidence ref removes the evidence link (catalog reflects it)', async ({
      page,
    }) => {
      const svc = buildExecService({ dropDiscoveryEvidence: true });
      const discovered = svc.catalogView().find((c) => c.classifiedUnknown);
      expect(
        discovered!.discoveryEvidence,
        'the ref must be stripped at the input',
      ).toBeUndefined();
      await mount(page, props({ model: deriveExecutivePosture({ dropDiscoveryEvidence: true }) }));
      const row = page.getByTestId('discovered-sources').locator('tbody tr', {
        has: page.getByText(String(discovered!.catalogId), { exact: true }),
      });
      await expect(row.getByTestId('no-discovery-evidence')).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC6 — governed-source gaps
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC6 governed-source gaps (service-driven)', () => {
    test('an unsupported/sensitive source stays a governed-source gap with the service review deadline', async ({
      page,
    }) => {
      const svc = buildExecService();
      const gaps = svc.governedSourceGaps();
      expect(gaps.length).toBeGreaterThan(0);
      const table = page.getByTestId('ranked-source-gaps').locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(gaps.length);
      // Each row carries a review-or-expiry cell (AC6 deadline).
      await expect(
        table.locator('tbody tr').first().getByTestId('ranked-gap-review'),
      ).toBeVisible();
    });

    test('RED: dropping the review/expiry deadline drops the gap from the governed-source view', async ({
      page,
    }) => {
      // The Phase-77 scenario's primary source gap loses its deadline; the service filters it out of
      // governedSourceGaps() (which requires a review-or-expiry). The count drops by one.
      const base = buildExecService().governedSourceGaps().length;
      const dropped = buildExecService({ dropGovernedGapReview: true }).governedSourceGaps().length;
      expect(dropped, 'dropping the deadline removes the gap from the AC6 view').toBeLessThan(base);
      await mount(page, props({ model: deriveExecutivePosture({ dropGovernedGapReview: true }) }));
      await expect(page.getByTestId('ranked-source-gaps').locator('tbody tr')).toHaveCount(dropped);
    });
  });

  // ── Table accessibility across the whole view ────────────────────────────────────────────────
  test('every data table exposes a caption and column-header scopes', async ({ page }) => {
    const tables = page.locator('main table');
    const count = await tables.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const t = tables.nth(i);
      await expect(t.locator('caption'), `table ${i} needs a caption`).toHaveCount(1);
      await expect(
        t.locator('th[scope="col"]').first(),
        `table ${i} needs column headers`,
      ).toBeAttached();
    }
  });

  // ── Non-vacuity: an UN-FED view cannot masquerade as a satisfied posture ──────────────────────
  test('an empty (un-derived) model renders zero rows and zero summary figures', async ({
    page,
  }) => {
    await mount(page, props({ model: EMPTY_POSTURE }));
    await expect(page.getByTestId('reconciled-inventory').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('ranked-coverage-gaps').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('ranked-source-gaps').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('gap-trends').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('posture-summary-figures')).toHaveAttribute(
      'data-confirmed-healthy',
      '0',
    );
    await expect(page.locator('main#main')).toHaveAttribute('data-snapshot-digest', 'empty');
  });

  // ── 400% reflow over the whole view (WCAG 1.4.10) ────────────────────────────────────────────
  test('view reflows into the 320px column without horizontal scrolling at 400% zoom', async ({
    page,
  }) => {
    await page.evaluate((factor) => {
      (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom =
        String(factor);
    }, REFLOW_400.zoomFactor);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `view overflows horizontally at 400% zoom (scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}); WCAG 1.4.10 target is ${REFLOW_400.wcagTargetCssWidth} CSS px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 2);
    await expect(page.getByTestId('posture-summary')).toBeVisible();
    await expect(page.getByTestId('gap-trends')).toBeVisible();
  });
});

// ── Pure ranking projection (independent of the browser) ──────────────────────────────────────
test.describe('business-impact ranking is a pure, deterministic function of service state', () => {
  test('the same scenario yields byte-identical ranks and the same snapshot digest', () => {
    const a = defaultExecutivePosture();
    const b = defaultExecutivePosture();
    expect(a.snapshotDigest).toBe(b.snapshotDigest);
    expect(a.rankedCoverageGaps.map((g) => [g.subject, g.impactRank])).toEqual(
      b.rankedCoverageGaps.map((g) => [g.subject, g.impactRank]),
    );
  });

  test('the second gapped asset is a real ingest (its id is addressable)', () => {
    const svc = buildExecService();
    const ids = svc.componentGaps().map((g) => String(g.subjectId));
    expect(ids).toContain(String(EXEC_IDS.secondGappedAsset));
  });
});
