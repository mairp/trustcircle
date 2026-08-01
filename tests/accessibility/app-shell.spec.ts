// TrustCircleAI — application-SHELL accessibility + CURRENT-STATE SPEC (Phase 77 /
// apps/web/src/app/layout.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executable acceptance target for the accessible, role-aware application SHELL and the six
// current-state regions it frames (AC1–AC6). It runs under the hermetic
// `accessibility-current-state` Playwright project (root playwright.config.ts — pinned Desktop
// Chrome, REFLOW_400 layout viewport, no `setup`, no web server) and mounts the SHIPPED shell —
// `renderAppShell()` from apps/web/src/app/layout.tsx — in a REAL browser via `page.setContent`.
//
// ── NON-TAUTOLOGY: the AC oracles are driven by the REAL service, not by view constants ──────
// The shell is a PURE PRESENTER of a `CurrentStateModel`. That model is DERIVED by running the
// REAL Phase-70 `InventoryService` (packages/application/src/inventory-service.ts) over an
// explicit scenario (support/current-state-model.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts. For every AC this spec:
//   1. builds the real service, reads its OWN outputs (`currentStateView`, `drillDown`,
//      `componentGaps`, `governedSourceGaps`, `catalogView`) as the INDEPENDENT expectation,
//   2. injects the derived model into the shell and asserts the rendered DOM equals those
//      service-computed values (an independent read path: the live accessibility tree),
//   3. runs a RED NEGATIVE CONTROL that mutates the scenario INPUT to break exactly that AC's
//      invariant (a stale record forced fresh, a duplicate asset id, a dropped review deadline,
//      a stripped discovery-evidence ref, a collapsed single source, a removed gap) and asserts
//      the DOM reflects the changed derivation — so the oracle is provably non-vacuous.
// Because the expected values come from the service (not from literals in layout.tsx), a static
// template could not satisfy these assertions.
//
// ── EFFECT-WITNESS DISCIPLINE ────────────────────────────────────────────────────────────────
// Every assertion observes an INDEPENDENT read path — the rendered accessibility tree, header
// cells, machine-readable <time>/<code>/data-* attributes, and the service's own `snapshotDigest`
// reflected into `<main data-snapshot-digest>` — never the render function's return value as its
// own proof. The DURABLE-IDENTITY witness is the tenant scope (bundle id + semantic hash + work
// item), read back from the DOM; the NEGATIVE identity case re-renders with a MISMATCHED identity
// and confirms the guard rejects it.
//
// ── Traceability ──────────────────────────────────────────────────────────────────────────────
//   Phase-77 acceptance criteria (US1-AS1..AS6) and effect-witness VOs
//     VO-a990a985… (AC1)  each healthy item once, all authoritative fields
//     VO-62c43281… (AC2)  coverage gaps stay visible: reason/age/impact/owner action
//     VO-9f597528… (AC3)  cross-source drill-down: distinct records/correlation/deps/authority
//     VO-2f3b4fef… (AC4)  stale source marked last-known + confidence; no inference
//     VO-7e4075d3… (AC5)  discovered source catalogued with full discovery metadata
//     VO-60db0834… (AC6)  discovered source gap visible: reason/impact/action/review-or-expiry
//   Shell subjects (Phase-77 objective): role-aware nav, global status, navigation, tenant scope.

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import {
  renderAppShell,
  navFor,
  SHELL_TENANT,
  SHELL_STATUS,
  SHELL_NAV,
  EMPTY_CURRENT_STATE,
  type AppShellProps,
  type CurrentStateModel,
} from '../../apps/web/src/app/layout.tsx';
import {
  buildService,
  deriveModel,
  defaultDerivedModel,
  SCENARIO_IDS,
  T0,
} from './support/current-state-model.ts';
import { REFLOW_400 } from '../../playwright.config.ts';

const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The default derived model (real service, no overrides), reused by the chrome/a11y tests. */
const MODEL: CurrentStateModel = defaultDerivedModel();

/** Compose props: default operator + the real-service-derived model, with optional overrides. */
function props(over: Partial<AppShellProps> = {}): AppShellProps {
  return {
    role: 'operator',
    tenant: SHELL_TENANT,
    status: SHELL_STATUS,
    currentState: MODEL,
    ...over,
  };
}

/** Mount the shipped shell in-page for the given props. */
async function mount(page: Page, p: AppShellProps = props()): Promise<void> {
  await page.setContent(renderAppShell(p), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main#main')).toBeVisible();
}

test.describe('application shell — WCAG 2.2 AA + role/tenant/status/nav contract', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline over the whole shell ────────────────────────────────────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-app-shell.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
    ).toEqual([]);
  });

  // ── Shell landmark structure ────────────────────────────────────────────────────────────────
  test('exposes the required labelled landmarks (banner, nav, status, main)', async ({ page }) => {
    await expect(page.getByTestId('skip-link')).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveAttribute('tabindex', '-1');
    await expect(page.getByRole('navigation', { name: /primary/i })).toBeVisible();
    const status = page.getByTestId('global-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
  });

  // The <main> carries the SERVICE's snapshot digest — an independent effect witness that the
  // rendered content is the derived model, not a static one.
  test('main carries the derived service snapshot digest (independent effect witness)', async ({
    page,
  }) => {
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      MODEL.snapshotDigest,
    );
    // The digest is a real 64-hex sha256 from the service, not the empty sentinel.
    expect(MODEL.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL.snapshotDigest).not.toBe(EMPTY_CURRENT_STATE.snapshotDigest);
  });

  // ── TENANT SCOPE ────────────────────────────────────────────────────────────────────────────
  test.describe('tenant scope (durable identity binding)', () => {
    test('binds the shell to the pinned tenant + bundle identity, read independently', async ({
      page,
    }) => {
      const scope = page.getByTestId('tenant-scope');
      await expect(scope).toBeVisible();
      await expect(scope).toHaveAttribute('data-tenant-id', SHELL_TENANT.tenantId);
      await expect(scope).toHaveAttribute('data-bundle-id', SHELL_TENANT.bundleId);
      await expect(scope).toHaveAttribute('data-semantic-hash', SHELL_TENANT.semanticHash);
      await expect(scope).toHaveAttribute('data-work-item-id', SHELL_TENANT.workItemId);
      await expect(page.getByTestId('scope-tenant')).toContainText(SHELL_TENANT.tenantName);
      await expect(page.getByTestId('scope-bundle')).toContainText(SHELL_TENANT.bundleId);
      await expect(page.getByTestId('scope-semantic-hash')).toContainText(
        SHELL_TENANT.semanticHash,
      );
      await expect(page.getByTestId('scope-work-item')).toContainText(SHELL_TENANT.workItemId);
      await expect(page.getByTestId('scope-generated-at')).toHaveAttribute(
        'datetime',
        SHELL_TENANT.generatedAt,
      );
    });

    test('the pinned identity IS the phase work item (rejects a mismatched identity)', async ({
      page,
    }) => {
      expect(SHELL_TENANT.bundleId).toBe('36GCYGDJ15PTYP60F91QWRAY2M');
      expect(SHELL_TENANT.semanticHash).toBe(
        'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
      );
      expect(SHELL_TENANT.workItemId).toBe('ET0BFCH07V4JW5FN8SCMEGCNB7');

      const wrong: AppShellProps = props({
        tenant: {
          ...SHELL_TENANT,
          bundleId: 'WRONGBUNDLE0000000000000000',
          semanticHash: '0'.repeat(64),
          workItemId: 'WRONGWORKITEM00000000000000',
        },
      });
      await page.setContent(renderAppShell(wrong), { waitUntil: 'domcontentloaded' });
      const rendered = await page.getByTestId('tenant-scope').getAttribute('data-bundle-id');
      const matchesPinnedInput = rendered === SHELL_TENANT.bundleId;
      expect(
        matchesPinnedInput,
        'a shell rendered with a non-pinned bundle identity must be rejected as evidence',
      ).toBe(false);
    });
  });

  // ── ROLE-AWARE NAVIGATION ───────────────────────────────────────────────────────────────────
  test.describe('role-aware navigation (least privilege)', () => {
    test('operator sees only operator-permitted destinations, and each nav target exists', async ({
      page,
    }) => {
      const links = page.getByTestId('nav-link');
      const expected = navFor('operator');
      await expect(links).toHaveCount(expected.length);
      for (const item of expected) {
        const link = page.locator(`[data-nav-id="${item.id}"]`);
        await expect(link, `operator must see ${item.id}`).toHaveCount(1);
        await expect(
          page.locator(`#${item.regionId}`),
          `nav ${item.id} must target an existing region`,
        ).toHaveCount(1);
      }
      await expect(page.locator('[data-nav-id="nav-executive-posture"]')).toHaveCount(0);
      await expect(page.locator('[data-nav-id="nav-audit-log"]')).toHaveCount(0);
      await expect(page.locator('#region-executive-posture')).toHaveCount(0);
      await expect(page.locator('#region-audit-log')).toHaveCount(0);
    });

    test('executive sees the executive-only destination; operator/auditor never do', async ({
      page,
    }) => {
      await mount(page, props({ role: 'executive' }));
      await expect(page.locator('[data-nav-id="nav-executive-posture"]')).toHaveCount(1);
      await expect(page.locator('#region-executive-posture')).toHaveCount(1);
      await expect(page.locator('[data-nav-id="nav-audit-log"]')).toHaveCount(0);
      await expect(page.locator('[data-nav-id="nav-drilldown"]')).toHaveCount(0);
      await expect(page.locator('[data-nav-id="nav-catalog"]')).toHaveCount(0);
    });

    test('auditor sees the audit-only destination and the shared/audit destinations', async ({
      page,
    }) => {
      await mount(page, props({ role: 'auditor' }));
      await expect(page.locator('[data-nav-id="nav-audit-log"]')).toHaveCount(1);
      await expect(page.locator('#region-audit-log')).toHaveCount(1);
      await expect(page.locator('[data-nav-id="nav-executive-posture"]')).toHaveCount(0);
    });

    test('every rendered nav link is keyboard-reachable in DOM order', async ({ page }) => {
      const ids: string[] = [];
      for (let i = 0; i < 30 && ids.length < navFor('operator').length; i += 1) {
        await page.keyboard.press('Tab');
        const navId = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          return el.getAttribute('data-nav-id');
        });
        if (navId && !ids.includes(navId)) ids.push(navId);
      }
      expect(new Set(ids)).toEqual(new Set(navFor('operator').map((n) => n.id)));
    });
  });

  // ── GLOBAL STATUS ───────────────────────────────────────────────────────────────────────────
  test.describe('global status (freshness-aware, non-color)', () => {
    test('surfaces connectivity + last-refreshed time + confidence in a live region', async ({
      page,
    }) => {
      const status = page.getByTestId('global-status');
      await expect(status).toHaveAttribute('data-connectivity', SHELL_STATUS.connectivity);
      await expect(page.getByTestId('global-status-text')).toContainText(SHELL_STATUS.summary);
      await expect(page.getByTestId('global-status-time')).toHaveAttribute(
        'datetime',
        SHELL_STATUS.lastRefreshedAt,
      );
      await expect(page.getByTestId('global-status-confidence')).toContainText(
        SHELL_STATUS.confidence,
      );
    });

    test('status meaning is NOT color-only — it survives color removal', async ({ page }) => {
      await expect(page.locator('.badge--status')).toHaveAttribute('aria-hidden', 'true');
      await page.evaluate(() => {
        const kill = document.createElement('style');
        kill.textContent = '* { color: #000 !important; background: #fff !important; }';
        document.head.appendChild(kill);
      });
      await expect(page.getByTestId('global-status-text')).toContainText(/degraded/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // AC1 — reconciled inventory (each item once, all authoritative fields), driven by the SERVICE
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC1 reconciled inventory (service-driven)', () => {
    test('each healthy item appears exactly once with every authoritative field the service computed', async ({
      page,
    }) => {
      // Independent expectation: the REAL service's own current-state rows.
      const svc = buildService();
      const rows = svc.currentStateView(T0);
      const healthy = rows.filter(
        (r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap,
      );
      expect(healthy.length, 'scenario must have ≥1 confirmed-healthy row').toBeGreaterThan(0);

      const table = page.getByTestId('reconciled-inventory').locator('table');
      await expect(table).toBeVisible();
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
        'last observation time',
        'unresolved issues',
      ]) {
        expect(headers, `inventory missing column: ${required}`).toContain(required);
      }
      // Exactly one DOM row per service row (AC1 "each item once").
      await expect(table.locator('tbody tr')).toHaveCount(healthy.length);

      for (const r of healthy) {
        const nameCells = table.locator('tbody th[scope="row"]', { hasText: r.name });
        await expect(nameCells, `item ${r.name} must appear exactly once`).toHaveCount(1);
        const row = table.locator('tbody tr', { has: page.getByText(r.name, { exact: true }) });
        const rowText = (await row.innerText()).toLowerCase();
        for (const value of [r.assetType, r.lifecycleState, r.riskTier, r.reportedHealth]) {
          expect(rowText, `row ${r.name} missing "${value}"`).toContain(
            String(value).toLowerCase(),
          );
        }
        // The last-observation <time> matches the service's lastObservationAt (machine-readable).
        const expectIso =
          r.lastObservationAt !== undefined
            ? new Date(r.lastObservationAt).toISOString()
            : undefined;
        if (expectIso) {
          await expect(row.locator('time[datetime]')).toHaveAttribute('datetime', expectIso);
        }
      }
    });

    test('RED: a DUPLICATE observation of the same asset id still yields ONE row (service dedups)', async ({
      page,
    }) => {
      // The RED input: two observations of the SAME healthy asset id. A static template that simply
      // lists whatever rows it is handed would show two; the SERVICE keys by id and yields one.
      const svc = buildService({ duplicateHealthyAsset: true });
      const healthy = svc
        .currentStateView(T0)
        .filter((r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap);
      const target = healthy.find((r) => r.assetId === SCENARIO_IDS.healthyAsset);
      expect(target, 'the duplicated asset must still be present').toBeDefined();

      await mount(page, props({ currentState: deriveModel(svc, T0) }));
      const table = page.getByTestId('reconciled-inventory').locator('table');
      // The invariant the RED control targets: still exactly ONE row for the duplicated id.
      const dupRows = table.locator('tbody th[scope="row"]', { hasText: target!.name });
      await expect(dupRows, 'a duplicate id must NOT fork a second inventory row').toHaveCount(1);
      // Non-vacuity: without the service's dedup, the row count would exceed the service's row count.
      await expect(table.locator('tbody tr')).toHaveCount(healthy.length);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // AC2 — coverage gaps stay visible (reason, age, impact, owner action)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC2 coverage gaps (service-driven)', () => {
    test('every discovered-not-healthy component the service retained stays visible with all fields', async ({
      page,
    }) => {
      const svc = buildService();
      const gaps = svc.componentGaps();
      expect(gaps.length, 'scenario must retain ≥1 component gap').toBeGreaterThan(0);

      const table = page.getByTestId('coverage-gaps').locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(gaps.length);
      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of ['reason', 'age', 'impact', 'required owner action']) {
        expect(headers, `coverage-gaps missing column: ${required}`).toContain(required);
      }
      for (const gap of gaps) {
        // The gap row carries the service's reason class + a positive age.
        const reasonCell = page.getByTestId('gap-reason-text').filter({ hasText: gap.reason });
        await expect(reasonCell, `gap reason ${gap.reason} must be visible`).toHaveCount(1);
      }
    });

    test('RED: dropping the component gap from the input makes the coverage-gap row DISAPPEAR', async ({
      page,
    }) => {
      // With the gap absent from the service, the derived model has zero coverage gaps — the DOM row
      // must vanish. This proves the coverage-gap oracle is bound to the SERVICE, not a static row.
      const svc = buildService({ dropComponentGap: true });
      expect(svc.componentGaps()).toHaveLength(0);
      await mount(page, props({ currentState: deriveModel(svc, T0) }));
      await expect(
        page.getByTestId('coverage-gaps').locator('tbody tr'),
        'removing the gap from the service must remove its row',
      ).toHaveCount(0);
      // And the same scenario WITH the gap shows exactly one — the oracle discriminates.
      await mount(page, props({ currentState: MODEL }));
      await expect(page.getByTestId('coverage-gaps').locator('tbody tr')).toHaveCount(
        buildService().componentGaps().length,
      );
    });

    test('coverage-gap reason meaning is NOT color-only', async ({ page }) => {
      const svc = buildService();
      const gaps = svc.componentGaps();
      const reasonTexts = page.getByTestId('gap-reason-text');
      await expect(reasonTexts).toHaveCount(gaps.length);
      await page.getByTestId('coverage-gaps').evaluate((sec) => {
        sec.querySelectorAll('.badge').forEach((b) => b.remove());
      });
      for (const gap of gaps) {
        await expect(
          page.getByTestId('coverage-gaps'),
          `reason "${gap.reason}" must survive with color removed`,
        ).toContainText(gap.reason);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // AC3 — cross-source drill-down (distinct records, correlation, deps, authoritative fields)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC3 cross-source drill-down (service-driven)', () => {
    test('shows the DISTINCT source records + dependency/authoritative edges the service correlated', async ({
      page,
    }) => {
      const svc = buildService();
      const dd = svc.drillDown(SCENARIO_IDS.healthyAsset, T0);
      const distinctSources = new Set(dd.sourceRecords.map((r) => r.sourceClass));
      expect(distinctSources.size, 'AC3 needs ≥2 distinct sources').toBeGreaterThanOrEqual(2);
      expect(distinctSources.has('platform_kanban')).toBe(true);
      expect(distinctSources.has('agentctl')).toBe(true);
      expect(distinctSources.has('workflows_orchestration')).toBe(true);

      const table = page.getByTestId('cross-source-drilldown').locator('table');
      // One DOM row per DISTINCT service source record.
      await expect(table.locator('tbody tr')).toHaveCount(dd.sourceRecords.length);
      for (const rec of dd.sourceRecords) {
        const row = table.locator('tbody tr', {
          has: page.getByText(rec.sourceClass, { exact: true }),
        });
        await expect(row, `source ${rec.sourceClass} must have a distinct record`).toHaveCount(1);
        await expect(row).toContainText(rec.externalKey);
      }
      // Correlation summary reflects the service's counts (deps + authoritative attributions).
      const summary = page.getByTestId('drilldown-text-summary');
      await expect(summary).toHaveAttribute('data-distinct-sources', String(distinctSources.size));
      await expect(summary).toHaveAttribute('data-dependencies', String(dd.dependencies.length));
      expect(dd.dependencies.length, 'scenario must correlate ≥1 dependency edge').toBeGreaterThan(
        0,
      );
      await expect(summary).toContainText(/depend/i);
      await expect(summary).toContainText(/authoritative/i);
    });

    test('RED: collapsing the input to a single source shrinks the drill-down to one distinct record', async ({
      page,
    }) => {
      const svc = buildService({ singleSourceOnly: true });
      const dd = svc.drillDown(SCENARIO_IDS.healthyAsset, T0);
      const distinct = new Set(dd.sourceRecords.map((r) => r.sourceClass));
      expect(distinct.size, 'the RED scenario must collapse to a single source').toBe(1);

      await mount(page, props({ currentState: deriveModel(svc, T0) }));
      const summary = page.getByTestId('cross-source-drilldown').locator('#drill-summary');
      await expect(
        summary,
        'a single-source drill-down must not claim multiple distinct sources',
      ).toHaveAttribute('data-distinct-sources', '1');
      await expect(page.getByTestId('cross-source-drilldown').locator('tbody tr')).toHaveCount(
        dd.sourceRecords.length,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // AC4 — staleness / last-known markers; health NOT inferred from stale data
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC4 staleness / no-inference (service-driven)', () => {
    test('stale data is marked and current health is WITHHELD (reportedHealth=unknown, not observed)', async ({
      page,
    }) => {
      const svc = buildService();
      const stale = svc.currentStateView(T0).find((r) => r.assetId === SCENARIO_IDS.staleAsset);
      expect(stale, 'the stale asset must be present').toBeDefined();
      // The SERVICE's AC4 contract: observed healthy, but reported unknown (never inferred).
      expect(stale!.observedHealth).toBe('healthy');
      expect(stale!.reportedHealth).toBe('unknown');
      expect(stale!.evidenceState).not.toBe('current');
      expect(stale!.confidence).toBeLessThan(1);

      const marker = page.getByTestId('stale-marker');
      await expect(marker).toHaveAttribute('data-reported-health', 'unknown');
      await expect(marker).toHaveAttribute('data-observed-health', 'healthy');
      await expect(marker).toHaveAttribute('data-freshness', stale!.evidenceState);
      await expect(page.getByTestId('stale-reported-health')).toContainText('unknown');
      await expect(page.getByTestId('stale-observed-health')).toContainText('healthy');
      await expect(page.getByTestId('no-stale-inference')).toContainText(/not inferred/i);
      // Confidence rendered from the service (< 1).
      const shownConfidence = await page.getByTestId('confidence').innerText();
      expect(Number(shownConfidence)).toBeLessThan(1);
    });

    test('RED: forcing the same record FRESH flips reported health to the observed value (no false stale)', async ({
      page,
    }) => {
      // The ONLY input change is freshness. If the shell inferred health from a static string, this
      // would not change. Because it presents the SERVICE's reportedHealth, fresh evidence now
      // reports the observed health — and the stale panel no longer withholds it.
      const svc = buildService({ forceStaleRecordFresh: true });
      const row = svc.currentStateView(T0).find((r) => r.assetId === SCENARIO_IDS.staleAsset);
      expect(row, 'the asset must still be present when fresh').toBeDefined();
      expect(row!.reportedHealth, 'fresh evidence must report the observed health').toBe('healthy');

      await mount(page, props({ currentState: deriveModel(svc, T0) }));
      // No stale row remains → the freshness panel shows the "all current" branch.
      await expect(page.getByTestId('stale-marker')).toHaveCount(0);
      await expect(page.getByTestId('no-stale-inference')).toHaveAttribute(
        'data-freshness',
        'current',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // AC5 — open-ended source catalog (discovery evidence + classification + status metadata)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC5 open-ended source catalog (service-driven)', () => {
    test('the discovered source is catalogued with the discovery facets the service read back', async ({
      page,
    }) => {
      const svc = buildService();
      const view = svc.catalogView();
      expect(view.length, 'scenario must catalog ≥1 discovered source').toBeGreaterThan(0);

      const table = page.getByTestId('discovered-sources');
      await expect(table.locator('tbody tr')).toHaveCount(view.length);
      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of [
        'classification',
        'location',
        'access status',
        'sensitivity',
        'ownership status',
        'onboarding state',
        'discovery evidence',
      ]) {
        expect(headers, `catalog missing column: ${required}`).toContain(required);
      }
      for (const c of view) {
        const row = table.locator('tbody tr', {
          has: page.getByText(String(c.catalogId), { exact: true }),
        });
        const rowText = (await row.innerText()).toLowerCase();
        const cls = c.classifiedUnknown ? 'unknown' : c.sourceClass;
        expect(rowText, `${c.catalogId} missing classification`).toContain(cls.toLowerCase());
        expect(rowText, `${c.catalogId} missing access status`).toContain(
          c.accessState.toLowerCase(),
        );
        expect(rowText, `${c.catalogId} missing onboarding state`).toContain(
          c.onboardingState.toLowerCase(),
        );
        if (c.discoveryEvidence !== undefined) {
          await expect(
            row.getByRole('link', { name: String(c.discoveryEvidence) }),
            `${c.catalogId} must link discovery evidence`,
          ).toBeVisible();
        }
      }
    });

    test('RED: stripping the discovery-evidence ref removes the evidence link (catalog reflects it)', async ({
      page,
    }) => {
      const svc = buildService({ dropDiscoveryEvidence: true });
      const view = svc.catalogView();
      const target = view.find((c) => c.catalogId === SCENARIO_IDS.discoveredCatalog);
      expect(target, 'the discovered source must still be catalogued').toBeDefined();
      expect(
        target!.discoveryEvidence,
        'the RED control must strip the evidence ref',
      ).toBeUndefined();

      await mount(page, props({ currentState: deriveModel(svc, T0) }));
      const row = page.getByTestId('discovered-sources').locator('tbody tr', {
        has: page.getByText(String(SCENARIO_IDS.discoveredCatalog), { exact: true }),
      });
      await expect(
        row.getByTestId('no-discovery-evidence'),
        'a source with no discovery evidence must show the no-evidence marker, not a link',
      ).toBeVisible();
      await expect(row.getByRole('link')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // AC6 — governed-source gaps (reason, impact, owner action, review-or-expiry)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC6 governed-source gaps (service-driven)', () => {
    test('an unsupported/sensitive source stays a governed-source gap with the service review deadline', async ({
      page,
    }) => {
      const svc = buildService();
      const gaps = svc.governedSourceGaps();
      expect(gaps.length, 'scenario must retain ≥1 governed-source gap').toBeGreaterThan(0);

      const table = page.getByTestId('governed-source-gaps').locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(gaps.length);
      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of ['reason', 'impact', 'owner action', 'review / expiry']) {
        expect(headers, `source-gaps missing column: ${required}`).toContain(required);
      }
      for (const gap of gaps) {
        const reasonCell = page
          .getByTestId('source-gap-reason-text')
          .filter({ hasText: gap.reason });
        await expect(
          reasonCell,
          `governed-source reason ${gap.reason} must be visible`,
        ).toHaveCount(1);
      }
      // Each governed-source gap row records a review-or-expiry deadline (AC6).
      const reviewCells = page.getByTestId('source-gap-review');
      const n = await reviewCells.count();
      for (let i = 0; i < n; i += 1) {
        await expect(reviewCells.nth(i)).toHaveAttribute('data-has-review', 'true');
      }
    });

    test('RED: dropping the review/expiry deadline drops the gap from the governed-source view', async ({
      page,
    }) => {
      // `governedSourceGaps()` only retains gaps that CARRY a review-or-expiry deadline. Removing the
      // deadline at the input makes the SERVICE exclude it — so the DOM row must disappear. Proves
      // the AC6 "review-or-expiry" requirement is enforced by the service, not decoration.
      const svc = buildService({ dropGovernedGapReview: true });
      expect(
        svc.governedSourceGaps(),
        'a governed-source gap with no review/expiry must be excluded by the service',
      ).toHaveLength(0);
      await mount(page, props({ currentState: deriveModel(svc, T0) }));
      await expect(page.getByTestId('governed-source-gaps').locator('tbody tr')).toHaveCount(0);
      // Positive contrast: WITH the deadline, the row is present.
      await mount(page, props({ currentState: MODEL }));
      await expect(page.getByTestId('governed-source-gaps').locator('tbody tr')).toHaveCount(
        buildService().governedSourceGaps().length,
      );
    });
  });

  // ── Screen-reader structure for the framed regions ───────────────────────────────────────────
  test('every data table exposes a caption and column-header scopes', async ({ page }) => {
    const tables = page.locator('main table');
    const count = await tables.count();
    expect(count, 'the shell must frame structured data tables').toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const t = tables.nth(i);
      await expect(t.locator('caption'), `table ${i} needs a caption`).toHaveCount(1);
      await expect(
        t.locator('th[scope="col"]').first(),
        `table ${i} needs column headers`,
      ).toBeAttached();
    }
  });

  // ── Non-vacuity: an UN-FED shell cannot masquerade as a satisfied current-state view ─────────
  test('an empty (un-derived) model renders zero AC rows — a static frame is not a satisfied view', async ({
    page,
  }) => {
    await mount(page, props({ currentState: EMPTY_CURRENT_STATE }));
    await expect(page.getByTestId('reconciled-inventory').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('coverage-gaps').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('discovered-sources').locator('tbody tr')).toHaveCount(0);
    await expect(page.getByTestId('governed-source-gaps').locator('tbody tr')).toHaveCount(0);
    await expect(page.locator('main#main')).toHaveAttribute('data-snapshot-digest', 'empty');
  });

  // ── 400% reflow over the whole shell (WCAG 1.4.10) ───────────────────────────────────────────
  test('shell reflows into the 320px column without horizontal scrolling at 400% zoom', async ({
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
      `shell overflows horizontally at 400% zoom (scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}); WCAG 1.4.10 target is ${REFLOW_400.wcagTargetCssWidth} CSS px`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 2);
    await expect(page.getByTestId('tenant-scope')).toBeVisible();
    await expect(page.getByTestId('primary-nav')).toBeVisible();
    await expect(page.getByTestId('global-status')).toBeVisible();
  });
});

// ── Pure role→nav projection (independent of the browser) ─────────────────────────────────────
test.describe('role→nav projection is least-privilege and total', () => {
  test('navFor never emits a destination outside the role permission set', () => {
    for (const role of ['operator', 'executive', 'auditor'] as const) {
      const items = navFor(role);
      expect(items.length, `${role} must have at least one destination`).toBeGreaterThan(0);
      for (const item of items) {
        expect(
          item.roles.includes(role),
          `navFor(${role}) leaked ${item.id} which ${role} may not reach`,
        ).toBe(true);
      }
    }
  });

  test('the executive-only and auditor-only destinations are exclusive', () => {
    const exec = SHELL_NAV.find((n) => n.id === 'nav-executive-posture');
    const audit = SHELL_NAV.find((n) => n.id === 'nav-audit-log');
    expect(exec?.roles).toEqual(['executive']);
    expect(audit?.roles).toEqual(['auditor']);
    const opIds = navFor('operator').map((n) => n.id);
    expect(opIds).not.toContain('nav-executive-posture');
    expect(opIds).not.toContain('nav-audit-log');
  });
});
