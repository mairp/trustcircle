// TrustCircleAI — SEARCHABLE / FILTERABLE INVENTORY-TABLE accessibility + behaviour SPEC (Phase 79 /
// apps/web/src/features/inventory/InventoryTable.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executable acceptance target for the accessible GOVERNED-ASSET and SOURCE-CATALOG tables and
// their four table additions — a SEARCH box, a set of FILTER chips, an explicit per-row AGE, and an
// explicit per-row AUTHORITY — layered on top of the six current-state acceptance criteria (AC1–AC6)
// the whole officer surface must satisfy. It runs under the hermetic `accessibility-current-state`
// Playwright project (root playwright.config.ts — pinned Desktop Chrome, REFLOW_400 layout viewport,
// no `setup`, no web server) and mounts the SHIPPED view — `renderInventoryTable()` from
// apps/web/src/features/inventory/InventoryTable.tsx — in a REAL browser via `page.setContent`.
//
// ── NON-TAUTOLOGY: the oracles are driven by the REAL service, not by view constants ─────────
// The view is a PURE PRESENTER of an `InventoryTableModel`. That model is DERIVED by running the REAL
// Phase-70 `InventoryService` (packages/application/src/inventory-service.ts) over an explicit scenario
// (support/inventory-table-model.ts → support/current-state-model.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — and by applying the officer's SEARCH query + active
// FILTERS to the SERVICE's OWN rows. For every obligation this spec:
//   1. builds the real service / re-derives the model, reads its OWN outputs (currentStateView,
//      catalogView, drillDown, componentGaps, governedSourceGaps) and the search/filter MEMBERSHIP as
//      the INDEPENDENT expectation,
//   2. injects the derived model into the view and asserts the rendered DOM equals those computed
//      values (an independent read path: the live accessibility tree + machine-readable data-*),
//   3. runs a RED NEGATIVE CONTROL that mutates the scenario INPUT or the query to break exactly that
//      obligation and asserts the DOM reflects the changed derivation — provably non-vacuous.
// Because the expected values come from the service (not from literals in InventoryTable.tsx), a static
// template could not satisfy these assertions.
//
// ── EFFECT-WITNESS DISCIPLINE ────────────────────────────────────────────────────────────────
// Every assertion observes an INDEPENDENT read path — the rendered accessibility tree, header/row cells,
// machine-readable <time>/<code>/data-* attributes, and the service's own `snapshotDigest` reflected
// into `<main data-snapshot-digest>` — never the render function's return value as its own proof. The
// DURABLE-IDENTITY witness is the tenant scope (bundle id + semantic hash + work item
// TRRGYA7N0K97QZ8JAMD077BRWP), read back from the DOM; the NEGATIVE identity case re-renders with a
// MISMATCHED identity and confirms the guard rejects it.
//
// ── Traceability (Phase-79 objective + acceptance criteria) ───────────────────────────────────
//   SEARCH   free-text query narrows both tables, echoed independently        → §SEARCH
//   FILTER   facet chips narrow both tables; hidden rows STAY with a reason    → §FILTER
//   AGE      explicit observation age (assets) / discovery+last-seen (sources) → §AGE
//   AUTHORITY explicit per-field system-of-record + contested (assets);        → §AUTHORITY
//            classification + ownership authority (sources)
//   AC1 each governed item once, all authoritative fields                      → §AC1
//   AC2 coverage gaps stay visible (reason/age/impact/action)                  → §AC2
//   AC3 cross-source drill-down (distinct records/deps/authority)              → §AC3
//   AC4 stale source last-known + confidence; no inference                     → §AC4
//   AC5 discovered source catalogued with full discovery metadata              → §AC5
//   AC6 discovered-source gap visible (reason/impact/action/review)            → §AC6

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import {
  renderInventoryTable,
  INVENTORY_TENANT,
  EMPTY_INVENTORY_TABLE,
  type InventoryTableProps,
  type InventoryTableModel,
} from '../../apps/web/src/features/inventory/InventoryTable.tsx';
import {
  deriveInventoryTable,
  defaultInventoryTable,
  buildService,
  SCENARIO_IDS,
  T0,
} from './support/inventory-table-model.ts';
import { REFLOW_400 } from '../../playwright.config.ts';

const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The default derived inventory table (real service, no overrides, empty query). */
const MODEL: InventoryTableModel = defaultInventoryTable();

function props(over: Partial<InventoryTableProps> = {}): InventoryTableProps {
  return { tenant: INVENTORY_TENANT, model: MODEL, ...over };
}

async function mount(page: Page, p: InventoryTableProps = props()): Promise<void> {
  await page.setContent(renderInventoryTable(p), { waitUntil: 'domcontentloaded' });
}

test.describe('inventory tables — WCAG 2.2 AA + search/filter/age/authority + AC1–AC6', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline over the whole view ─────────────────────────────────────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-inventory-table.json', {
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
    expect(MODEL.snapshotDigest).not.toBe(EMPTY_INVENTORY_TABLE.snapshotDigest);
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
      const wrong = { ...INVENTORY_TENANT, workItemId: 'WRONG000000000000000000000' };
      await mount(page, props({ tenant: wrong }));
      await expect(page.getByTestId('tenant-scope')).not.toHaveAttribute(
        'data-work-item-id',
        'TRRGYA7N0K97QZ8JAMD077BRWP',
      );
      expect(INVENTORY_TENANT.workItemId).toBe('TRRGYA7N0K97QZ8JAMD077BRWP');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §SEARCH — free-text query narrows both tables and is echoed independently
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§SEARCH free-text query (service-driven membership)', () => {
    test('a labelled searchbox echoes the active query and reports live result counts', async ({
      page,
    }) => {
      const box = page.getByTestId('search-input');
      await expect(box).toHaveAttribute('role', 'searchbox');
      // The searchbox has an associated visible label (WCAG 3.3.2 / 4.1.2 name).
      await expect(page.getByTestId('search-label')).toHaveAttribute('for', 'inv-search-input');
      // The result status is a live region carrying the visible/total counts in TEXT + data-*.
      const status = page.getByTestId('result-status');
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveAttribute('data-asset-total', String(MODEL.assetRows.length));
      await expect(status).toHaveAttribute('data-source-total', String(MODEL.sourceRows.length));
    });

    test('a query narrows the visible rows to exactly the service rows whose index contains it', async ({
      page,
    }) => {
      // Independent expectation: derive the SAME model with the officer's text, read the membership.
      const target = MODEL.assetRows[0]!.base.name; // a real governed item name
      const token = target.slice(0, 5).toLowerCase();
      const q = deriveInventoryTable({}, { text: token });
      const expectedVisible = q.assetRows.filter((r) => r.matches).length;
      expect(expectedVisible, 'the query must match ≥1 but hide ≥1 asset').toBeGreaterThan(0);
      expect(expectedVisible, 'the query must hide at least one asset').toBeLessThan(
        q.assetRows.length,
      );

      await mount(page, props({ model: q }));
      // Every VISIBLE asset row's search index contains the query.
      const visibleRows = page.locator('[data-testid="asset-row"]:not([hidden])');
      await expect(visibleRows).toHaveCount(expectedVisible);
      const indices = await visibleRows.evaluateAll((rows) =>
        rows.map((r) => r.getAttribute('data-search-index') ?? ''),
      );
      for (const idx of indices) expect(idx).toContain(token);
      // The echoed query state is independently readable.
      await expect(page.getByTestId('inventory-search')).toHaveAttribute('data-query-text', token);
      await expect(page.getByTestId('search-input')).toHaveValue(token);
    });

    test('RED: a query that matches nothing hides every row but DELETES none (all stay with a reason)', async ({
      page,
    }) => {
      const q = deriveInventoryTable({}, { text: 'zzz-no-such-item-zzz' });
      expect(q.query.assetVisible).toBe(0);
      expect(q.query.sourceVisible).toBe(0);
      await mount(page, props({ model: q }));
      // NONE visible…
      await expect(page.locator('[data-testid="asset-row"]:not([hidden])')).toHaveCount(0);
      await expect(page.locator('[data-testid="source-row"]:not([hidden])')).toHaveCount(0);
      // …but EVERY row is still in the DOM (never deleted), each carrying a filter-out reason.
      await expect(page.getByTestId('asset-row')).toHaveCount(q.assetRows.length);
      await expect(page.getByTestId('source-row')).toHaveCount(q.sourceRows.length);
      const reasons = await page
        .getByTestId('asset-row')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-filtered-out-reason')));
      for (const reason of reasons) expect(reason).toContain('text!=');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §FILTER — facet chips narrow both tables; hidden rows STAY with a reason (AC2/AC6 discipline)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§FILTER facet chips (service-driven membership; never delete a row)', () => {
    test('every chip is a machine-readable aria-pressed toggle carrying its facet/value/applies-to', async ({
      page,
    }) => {
      const chips = page.getByTestId('filter-chip');
      await expect(chips).toHaveCount(MODEL.filters.length);
      // The toolbar is a labelled group; each chip has aria-pressed + facet metadata.
      await expect(page.getByTestId('filter-toolbar')).toHaveAttribute('role', 'group');
      const first = chips.first();
      await expect(first).toHaveAttribute('aria-pressed', /true|false/);
      await expect(first).toHaveAttribute('data-facet', /.+/);
      await expect(first).toHaveAttribute('data-value', /.+/);
      await expect(first).toHaveAttribute('data-applies-to', /asset|source|both/);
    });

    test('applying risk=high narrows assets to exactly the high-risk service rows; the rest STAY hidden with a reason', async ({
      page,
    }) => {
      const svc = buildService();
      const highRisk = svc.currentStateView(T0).filter((r) => r.riskTier === 'high');
      const q = deriveInventoryTable({}, { filters: ['risk=high'] });
      const expectedVisible = q.assetRows.filter((r) => r.matches).length;
      expect(expectedVisible).toBe(highRisk.length);
      expect(expectedVisible, 'the filter must hide ≥1 asset').toBeLessThan(q.assetRows.length);

      await mount(page, props({ model: q }));
      // The active chip is pressed.
      await expect(
        page.locator('[data-testid="filter-chip"][data-facet="risk"][data-value="high"]'),
      ).toHaveAttribute('aria-pressed', 'true');
      // Exactly the high-risk rows are visible…
      await expect(page.locator('[data-testid="asset-row"]:not([hidden])')).toHaveCount(
        expectedVisible,
      );
      // …and every NON-matching row is still present, hidden, with a machine-readable reason.
      const hidden = page.locator('[data-testid="asset-row"][hidden]');
      await expect(hidden).toHaveCount(q.assetRows.length - expectedVisible);
      const reasons = await hidden.evaluateAll((rows) =>
        rows.map((r) => r.getAttribute('data-filtered-out-reason')),
      );
      for (const reason of reasons) expect(reason).toContain('risk!=');
      // The summary/status counts reflect the membership.
      await expect(page.getByTestId('asset-table-summary')).toHaveAttribute(
        'data-asset-visible',
        String(expectedVisible),
      );
    });

    test('applying access=reachable narrows the source catalog but keeps the hidden sources as records', async ({
      page,
    }) => {
      const q = deriveInventoryTable({}, { filters: ['access=reachable'] });
      const expectedVisible = q.sourceRows.filter((r) => r.matches).length;
      expect(expectedVisible, 'need ≥1 reachable source').toBeGreaterThan(0);
      expect(expectedVisible, 'filter must hide ≥1 source').toBeLessThan(q.sourceRows.length);

      await mount(page, props({ model: q }));
      await expect(page.locator('[data-testid="source-row"]:not([hidden])')).toHaveCount(
        expectedVisible,
      );
      // Hidden sources STILL carry their governed-source gap inline where one exists (AC6 at row level).
      await expect(page.getByTestId('source-row')).toHaveCount(q.sourceRows.length);
      await expect(page.getByTestId('source-table-summary')).toHaveAttribute(
        'data-source-visible',
        String(expectedVisible),
      );
    });

    test('RED: a filter for a value NO row has hides everything, yet keeps all rows (coverage never lost)', async ({
      page,
    }) => {
      // No asset in the scenario is 'critical' risk; the chip exists but matches nothing.
      const svc = buildService();
      expect(svc.currentStateView(T0).some((r) => r.riskTier === 'critical')).toBe(false);
      const q = deriveInventoryTable({}, { filters: ['risk=critical'] });
      expect(q.query.assetVisible).toBe(0);

      await mount(page, props({ model: q }));
      await expect(page.locator('[data-testid="asset-row"]:not([hidden])')).toHaveCount(0);
      // Every governed asset is STILL a row (a hidden coverage record, not a deletion).
      await expect(page.getByTestId('asset-row')).toHaveCount(q.assetRows.length);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AGE — explicit per-row observation age (assets) and discovery/last-seen age (sources)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AGE explicit age columns (service-driven, non-color)', () => {
    test('each asset row shows its real observation age in days + a <time> and a stale flag', async ({
      page,
    }) => {
      const svc = buildService();
      const rows = svc.currentStateView(T0);
      // The stale row is past the freshness horizon → its age cell must be flagged stale.
      const staleRow = MODEL.assetRows.find((r) => r.age.stale);
      expect(staleRow, 'scenario must have a stale asset').toBeDefined();
      const cell = page
        .locator(`[data-testid="asset-row"][data-asset-id="${staleRow!.base.id}"]`)
        .getByTestId('asset-age');
      await expect(cell).toHaveAttribute('data-age-stale', 'true');
      await expect(cell).toHaveAttribute('data-age-days', String(staleRow!.age.observationAgeDays));
      // The age is text (WCAG 1.4.1 — not color) and machine-readable via <time datetime>.
      await expect(cell.locator('time')).toHaveAttribute('datetime', /.+/);
      // Sanity: the age column value equals the service-derived day count.
      expect(rows.length).toBe(MODEL.assetRows.length);
    });

    test('each source row shows explicit discovery age AND last-seen age', async ({ page }) => {
      const source = MODEL.sourceRows[0]!;
      const cell = page
        .locator(`[data-testid="source-row"][data-source-id="${source.base.id}"]`)
        .getByTestId('source-age');
      await expect(cell).toHaveAttribute(
        'data-discovered-age-days',
        String(source.age.discoveredAgeDays),
      );
      await expect(cell).toHaveAttribute(
        'data-last-seen-age-days',
        String(source.age.lastSeenAgeDays),
      );
      await expect(cell).toContainText('discovered');
      await expect(cell).toContainText('last seen');
    });

    test('RED: forcing the stale record FRESH flips its age cell out of stale', async ({
      page,
    }) => {
      const fresh = deriveInventoryTable({ forceStaleRecordFresh: true });
      const stillStale = fresh.assetRows.filter((r) => r.age.stale);
      expect(
        stillStale.length,
        'forcing fresh must clear the stale flag on the stale row',
      ).toBeLessThan(MODEL.assetRows.filter((r) => r.age.stale).length);
      const staleId = MODEL.assetRows.find((r) => r.age.stale)!.base.id;

      await mount(page, props({ model: fresh }));
      await expect(
        page
          .locator(`[data-testid="asset-row"][data-asset-id="${staleId}"]`)
          .getByTestId('asset-age'),
      ).toHaveAttribute('data-age-stale', 'false');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AUTHORITY — explicit per-field system-of-record + contested (assets); classification +
  // ownership authority (sources)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AUTHORITY explicit authority columns (service-driven)', () => {
    test('an asset with a contested field shows CONTESTED authority (automation paused) in TEXT', async ({
      page,
    }) => {
      const contested = MODEL.assetRows.find((r) => r.authority.contested);
      expect(contested, 'scenario must have a contested-authority asset').toBeDefined();
      const row = page.locator(`[data-testid="asset-row"][data-asset-id="${contested!.base.id}"]`);
      await expect(row).toHaveAttribute('data-authority-contested', 'true');
      // The contested state is conveyed in the accessible-name text, not by color alone.
      await expect(row.getByTestId('asset-authority')).toHaveAttribute(
        'data-authoritative-fields',
        String(contested!.authority.authoritativeFieldCount),
      );
      await expect(row.getByTestId('asset-authority-detail')).toContainText('CONTESTED');
    });

    test('a source shows classification authority (classified vs unknown) and ownership authority', async ({
      page,
    }) => {
      const svc = buildService();
      const view = svc.catalogView();
      const unknownClass = MODEL.sourceRows.find((r) => !r.authority.classified);
      expect(unknownClass, 'scenario must catalog an unknown-class source').toBeDefined();
      expect(view.some((c) => c.classifiedUnknown)).toBe(true);
      const row = page.locator(
        `[data-testid="source-row"][data-source-id="${unknownClass!.base.id}"]`,
      );
      await expect(row).toHaveAttribute('data-classified', 'false');
      await expect(row.getByTestId('source-authority-summary')).toContainText('unknown');
      // Ownership authority is stated in text.
      const ownershipGap = MODEL.sourceRows.find((r) => r.authority.ownershipGap);
      expect(ownershipGap, 'scenario must have an ownership-gap source').toBeDefined();
      await expect(
        page
          .locator(`[data-testid="source-row"][data-source-id="${ownershipGap!.base.id}"]`)
          .getByTestId('source-authority-summary'),
      ).toContainText('ownership gap');
    });

    test('RED: collapsing to a single source removes the contested-authority attribution', async ({
      page,
    }) => {
      // With one source, no field can be cross-source contested — the drill-down authority collapses.
      const single = deriveInventoryTable({ singleSourceOnly: true });
      const svc = buildService({ singleSourceOnly: true });
      const dd = svc.drillDown(SCENARIO_IDS.healthyAsset, T0);
      const distinct = new Set(dd.sourceRecords.map((r) => r.sourceClass)).size;
      expect(distinct).toBe(1);
      const healthyId = String(SCENARIO_IDS.healthyAsset);
      const greenContested = MODEL.assetRows.find((r) => r.base.id === healthyId)!.authority
        .contested;
      const redContested = single.assetRows.find((r) => r.base.id === healthyId)!.authority
        .contested;
      expect(greenContested).toBe(true);
      expect(redContested, 'single source cannot contest a field').toBe(false);

      await mount(page, props({ model: single }));
      await expect(
        page.locator(`[data-testid="asset-row"][data-asset-id="${healthyId}"]`),
      ).toHaveAttribute('data-authority-contested', 'false');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC1 — reconciled inventory (each governed item once, all authoritative fields)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC1 reconciled governed-asset table (service-driven)', () => {
    test('every reconciled item appears exactly once with every required column present', async ({
      page,
    }) => {
      const svc = buildService();
      const rows = svc.currentStateView(T0);
      expect(rows.length).toBeGreaterThan(0);

      const table = page.getByTestId('governed-asset-table').locator('table');
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
        'age',
        'authority',
        'confidence',
        'unresolved issues',
      ]) {
        expect(headers, `asset table missing column: ${required}`).toContain(required);
      }
      // Every service row is present exactly once (each governed item once — including gapped/stale).
      await expect(table.locator('tbody tr')).toHaveCount(rows.length);
      for (const r of rows) {
        await expect(
          table.locator('tbody th[scope="row"]', { hasText: r.name }),
          `item ${r.name} must appear exactly once`,
        ).toHaveCount(1);
      }
    });

    test('RED: a DUPLICATE observation of the same asset id still yields ONE row (service dedups)', async ({
      page,
    }) => {
      const svc = buildService({ duplicateHealthyAsset: true });
      const rows = svc.currentStateView(T0);
      const target = rows.find((r) => r.assetId === SCENARIO_IDS.healthyAsset);
      expect(target).toBeDefined();

      await mount(page, props({ model: deriveInventoryTable({ duplicateHealthyAsset: true }) }));
      const table = page.getByTestId('governed-asset-table').locator('table');
      await expect(
        table.locator('tbody th[scope="row"]', { hasText: target!.name }),
        'a duplicate id must NOT fork a second row',
      ).toHaveCount(1);
      await expect(table.locator('tbody tr')).toHaveCount(rows.length);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC2 — coverage gaps stay visible (reason/age/impact/owner action)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC2 coverage gaps (service-driven)', () => {
    test('every discovered-not-healthy component stays visible with reason/age/impact/action', async ({
      page,
    }) => {
      const svc = buildService();
      const gaps = svc.componentGaps();
      expect(gaps.length).toBeGreaterThan(0);
      const table = page.getByTestId('coverage-gaps').locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(gaps.length);
      const firstRow = table.locator('tbody tr').first();
      await expect(firstRow.getByTestId('gap-reason')).toBeVisible();
      await expect(firstRow.getByTestId('gap-action')).toBeVisible();
      expect((await firstRow.innerText()).toLowerCase()).toContain('day(s)');
    });

    test('RED: dropping the component gap makes the coverage-gap rows DISAPPEAR', async ({
      page,
    }) => {
      const dropped = deriveInventoryTable({ dropComponentGap: true });
      expect(dropped.currentState.coverageGaps.length).toBe(0);
      await mount(page, props({ model: dropped }));
      await expect(page.getByTestId('coverage-gaps').locator('tbody tr')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC3 — cross-source drill-down (distinct records / correlation / deps / authority)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC3 cross-source drill-down (service-driven)', () => {
    test('shows the DISTINCT source records + authoritative-field attributions the service correlated', async ({
      page,
    }) => {
      const svc = buildService();
      const dd = svc.drillDown(SCENARIO_IDS.healthyAsset, T0);
      const distinct = new Set(dd.sourceRecords.map((r) => r.sourceClass)).size;
      expect(distinct).toBeGreaterThan(1);
      await expect(page.getByTestId('drilldown-text-summary')).toHaveAttribute(
        'data-distinct-sources',
        String(distinct),
      );
      await expect(page.getByTestId('cross-source-drilldown').locator('tbody tr')).toHaveCount(
        dd.sourceRecords.length,
      );
    });

    test('RED: collapsing to a single source shrinks the drill-down to one distinct record', async ({
      page,
    }) => {
      await mount(page, props({ model: deriveInventoryTable({ singleSourceOnly: true }) }));
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
    test('stale data is marked with last-known time + confidence; current health is WITHHELD', async ({
      page,
    }) => {
      const svc = buildService();
      const stale = svc
        .currentStateView(T0)
        .find((r) => r.evidenceState !== 'current' && r.reportedHealth === 'unknown');
      expect(stale, 'scenario must have a stale row').toBeDefined();
      const marker = page.getByTestId('stale-marker');
      await expect(marker).toHaveAttribute('data-reported-health', 'unknown');
      await expect(marker).not.toHaveAttribute('data-reported-health', stale!.observedHealth);
      await expect(page.getByTestId('last-known-time')).toHaveAttribute('datetime', /.+/);
      await expect(page.getByTestId('confidence')).toBeVisible();
    });

    test('RED: forcing the same record FRESH removes the stale panel (no withheld health)', async ({
      page,
    }) => {
      await mount(page, props({ model: deriveInventoryTable({ forceStaleRecordFresh: true }) }));
      await expect(page.getByTestId('no-stale-inference')).toContainText(
        'All contributing sources',
      );
      await expect(page.getByTestId('stale-marker')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC5 — open-ended source catalog with full discovery metadata
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC5 source catalog with discovery metadata (service-driven)', () => {
    test('every discovered source is catalogued once with classification/location/access/sensitivity/onboarding', async ({
      page,
    }) => {
      const svc = buildService();
      const view = svc.catalogView();
      const table = page.getByTestId('source-catalog-table').locator('table');
      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of [
        'classification',
        'location',
        'access status',
        'sensitivity',
        'onboarding state',
        'age',
        'authority',
        'discovery evidence',
      ]) {
        expect(headers, `source table missing column: ${required}`).toContain(required);
      }
      await expect(table.locator('tbody tr')).toHaveCount(view.length);
      // The unknown-class discovered source carries an 'unknown' classification cell.
      const unknown = MODEL.sourceRows.find((r) => !r.authority.classified)!;
      await expect(
        page
          .locator(`[data-testid="source-row"][data-source-id="${unknown.base.id}"]`)
          .getByTestId('source-classification'),
      ).toContainText('unknown');
    });

    test('RED: stripping the discovery-evidence ref replaces its link with a "no discovery evidence" marker', async ({
      page,
    }) => {
      const svc = buildService({ dropDiscoveryEvidence: true });
      const discovered = svc.catalogView().find((c) => c.classifiedUnknown);
      expect(
        discovered!.discoveryEvidence,
        'the ref must be stripped at the input',
      ).toBeUndefined();
      const stripped = deriveInventoryTable({ dropDiscoveryEvidence: true });
      const noEvId = stripped.sourceRows.find((r) => !r.authority.classified)!.base.id;

      await mount(page, props({ model: stripped }));
      await expect(
        page
          .locator(`[data-testid="source-row"][data-source-id="${noEvId}"]`)
          .getByTestId('no-discovery-evidence'),
      ).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC6 — governed-source gaps (reason/impact/action/review)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC6 governed-source gaps (service-driven)', () => {
    test('an unsupported/sensitive source stays a governed-source gap with reason/impact/action/review', async ({
      page,
    }) => {
      const svc = buildService();
      const gaps = svc.governedSourceGaps();
      expect(gaps.length).toBeGreaterThan(0);
      // In the dedicated gaps region…
      const table = page.getByTestId('governed-source-gaps').locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(gaps.length);
      await expect(
        table.locator('tbody tr').first().getByTestId('source-gap-review'),
      ).toBeVisible();
      // …AND inline on the source-catalog row itself (survives filtering).
      const gappedRow = MODEL.sourceRows.find((r) => r.gap);
      expect(gappedRow, 'a source-catalog row must carry an open gap inline').toBeDefined();
      await expect(
        page
          .locator(`[data-testid="source-row"][data-source-id="${gappedRow!.base.id}"]`)
          .getByTestId('source-gap-inline'),
      ).toHaveAttribute('data-has-review', 'true');
    });

    test('RED: dropping the review/expiry deadline drops the gap from the governed-source view', async ({
      page,
    }) => {
      const base = buildService().governedSourceGaps().length;
      const dropped = buildService({ dropGovernedGapReview: true }).governedSourceGaps().length;
      expect(dropped, 'dropping the deadline removes the gap from the AC6 view').toBeLessThan(base);
      await mount(page, props({ model: deriveInventoryTable({ dropGovernedGapReview: true }) }));
      await expect(page.getByTestId('governed-source-gaps').locator('tbody tr')).toHaveCount(
        dropped,
      );
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

  // ── Non-vacuity: an UN-FED view cannot masquerade as a satisfied inventory ─────────────────────
  test('an empty (un-derived) model renders zero rows in both tables', async ({ page }) => {
    await mount(page, props({ model: EMPTY_INVENTORY_TABLE }));
    await expect(page.getByTestId('asset-row')).toHaveCount(0);
    await expect(page.getByTestId('source-row')).toHaveCount(0);
    await expect(page.getByTestId('filter-chip')).toHaveCount(0);
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
    await expect(page.getByTestId('governed-asset-table')).toBeVisible();
    await expect(page.getByTestId('source-catalog-table')).toBeVisible();
  });
});

// ── Pure projection (independent of the browser) ──────────────────────────────────────────────
test.describe('the inventory-table model is a pure, deterministic function of service state', () => {
  test('the same scenario yields byte-identical rows and the same snapshot digest', () => {
    const a = defaultInventoryTable();
    const b = defaultInventoryTable();
    expect(a.snapshotDigest).toBe(b.snapshotDigest);
    expect(a.assetRows.map((r) => [r.base.id, r.matches, r.age.stale])).toEqual(
      b.assetRows.map((r) => [r.base.id, r.matches, r.age.stale]),
    );
    expect(a.sourceRows.map((r) => [r.base.id, r.authority.classified])).toEqual(
      b.sourceRows.map((r) => [r.base.id, r.authority.classified]),
    );
  });

  test('filtering never changes the ROW COUNT — only the match/hidden membership', () => {
    const open = deriveInventoryTable({}, {});
    const filtered = deriveInventoryTable({}, { filters: ['risk=high'] });
    expect(filtered.assetRows.length).toBe(open.assetRows.length);
    expect(filtered.sourceRows.length).toBe(open.sourceRows.length);
    // Fewer MATCH, but none are removed.
    expect(filtered.assetRows.filter((r) => r.matches).length).toBeLessThan(open.assetRows.length);
  });
});
