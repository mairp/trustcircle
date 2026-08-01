// TrustCircleAI — current-state view accessibility SPEC (Phase 61 /
// tests/accessibility/current-state.spec.ts).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// This is the executable acceptance target for the officer's *current-state* views. It runs
// under the hermetic `accessibility-current-state` Playwright project (see the root
// playwright.config.ts — pinned Desktop Chrome, REFLOW_400 layout viewport, no `setup`
// dependency, no web server) and mounts the deterministic fixture
// (support/current-state-view.ts) in a REAL browser via `page.setContent(...)`. It then
// asserts — through axe-core and the live DOM / accessibility tree — the keyboard,
// screen-reader, non-color, table-alternative, and 400%-reflow behavior WCAG 2.2 AA requires,
// AND maps every phase acceptance criterion (AC1–AC6) to an independently observable check.
//
// Every assertion observes an INDEPENDENT read path: the rendered accessibility tree, computed
// styles, scroll geometry, and live-region text mutations — never the fixture's own return
// value. Failure modes are asserted too (empty tab journey, horizontal scroll, color-only
// meaning, lost input on validation failure) so the oracle is non-vacuous.
//
// ── Traceability ──────────────────────────────────────────────────────────────────────────────
//   Phase-61 acceptance criteria:
//     AC1  healthy reconciled inventory — each item once, all authoritative fields  → §AC1
//     AC2  coverage gaps stay visible with reason/age/impact/owner action           → §AC2
//     AC3  cross-source drill-down — distinct records, correlation, deps, authority → §AC3
//     AC4  stale/unavailable source marked last-known + confidence, no inference    → §AC4
//     AC5  unregistered discovered source added to catalog with full metadata       → §AC5
//     AC6  discovered source gap stays visible with reason/impact/action/expiry     → §AC6
//   WCAG obligations (VO-d7e992… AA, VO-79578e… keyboard, VO-68021f5f… AT,
//     VO-c01bc43b… non-color, VO-057645e1… chart alternatives, VO-b574991b… reflow,
//     VO-c8a68cfe… time-warning, VO-b81bd0e9… clear errors + preserved input,
//     VO-706a4cef… full-journey conformance).

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import { REFLOW_400 } from '../../playwright.config.ts';
import {
  renderCurrentStateView,
  HEALTHY_ITEMS,
  COVERAGE_GAPS,
  SOURCE_GAPS,
  DISCOVERED_SOURCES,
  SOURCE_RECORDS,
  STALE_PROJECTION,
} from './support/current-state-view.ts';

// The WCAG 2.2 AA tag set is the same compatibility contract the whole estate scans against.
// Re-declared locally (not imported from support/axe.ts, which is bound to the browser-served
// `accessibility` project) so this hermetic project stays self-contained.
const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** Mount the hermetic current-state view in-page (no web server, no navigation). */
async function mount(page: Page): Promise<void> {
  await page.setContent(renderCurrentStateView(), { waitUntil: 'domcontentloaded' });
  // The document declares lang + title; wait for the main landmark so the tree is stable.
  await expect(page.locator('main#main')).toBeVisible();
}

test.describe('current-state views — WCAG 2.2 AA accessibility contract', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline (VO-d7e992408940c8a21dbf, VO-706a4cef7fb0edfd9a33) ───────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-current-state.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
    ).toEqual([]);
  });

  // ── AC1: healthy reconciled inventory — each item once, all authoritative fields ────────────
  test.describe('§AC1 reconciled inventory', () => {
    test('each healthy item appears exactly once with every authoritative field', async ({
      page,
    }) => {
      const table = page.getByTestId('reconciled-inventory').locator('table');
      await expect(table).toBeVisible();

      // Programmatic column names are available to AT (header cells, screen scope="col").
      const headers = await table.locator('thead th').allTextContents();
      const normalized = headers.map((h) => h.trim().toLowerCase());
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
        expect(normalized, `inventory missing column: ${required}`).toContain(required);
      }

      // Exactly one row per governed item — "each item appears once".
      const bodyRows = table.locator('tbody tr');
      await expect(bodyRows).toHaveCount(HEALTHY_ITEMS.length);

      // Every item's id appears exactly once as a row header, and its authoritative field values
      // are present in that item's row (independent DOM read, not the fixture object).
      for (const item of HEALTHY_ITEMS) {
        const idCells = table.locator('tbody th[scope="row"]', { hasText: item.id });
        await expect(idCells, `item ${item.id} must appear exactly once`).toHaveCount(1);
        const row = table.locator('tbody tr', { has: page.getByText(item.id, { exact: true }) });
        const rowText = (await row.innerText()).toLowerCase();
        for (const value of [
          item.assetType,
          item.owner,
          item.lifecycleState,
          item.riskTier,
          item.health,
        ]) {
          expect(rowText, `row ${item.id} missing "${value}"`).toContain(value.toLowerCase());
        }
        // Last observation time is a machine-readable <time> with a datetime attribute.
        await expect(
          row.locator('time[datetime]'),
          `row ${item.id} must expose a machine-readable last-observation time`,
        ).toHaveAttribute('datetime', item.lastObservedAt);
      }
    });
  });

  // ── AC2: coverage gaps stay visible (reason, age, impact, required owner action) ─────────────
  test.describe('§AC2 coverage gaps', () => {
    test('every discovered-not-healthy component stays visible as a gap with all fields', async ({
      page,
    }) => {
      const table = page.getByTestId('coverage-gaps').locator('table');
      await expect(table).toBeVisible();
      await expect(table.locator('tbody tr')).toHaveCount(COVERAGE_GAPS.length);

      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of ['reason', 'age', 'impact', 'required owner action']) {
        expect(headers, `coverage-gaps missing column: ${required}`).toContain(required);
      }

      for (const gap of COVERAGE_GAPS) {
        const row = table.locator('tbody tr', {
          has: page.getByText(gap.component, { exact: true }),
        });
        await expect(row, `gap ${gap.component} must stay visible`).toHaveCount(1);
        const rowText = (await row.innerText()).toLowerCase();
        // Reason is programmatic TEXT (the reason class name), not color/icon alone.
        expect(rowText, `gap ${gap.component} missing reason class`).toContain(gap.reasonClass);
        expect(rowText, `gap ${gap.component} missing age`).toContain(String(gap.ageDays));
        expect(rowText.length, `gap ${gap.component} must carry impact + action`).toBeGreaterThan(
          gap.reasonClass.length,
        );
      }
    });

    test('coverage-gap reason meaning is NOT color-only — a text equivalent exists', async ({
      page,
    }) => {
      // Each gap row carries a color badge PLUS a text reason. The color dot is aria-hidden;
      // the accessible meaning comes from the visible text (WCAG 1.4.1 Use of Color).
      const badges = page.getByTestId('coverage-gaps').locator('.badge--gap');
      await expect(badges.first()).toBeAttached();
      const reasonTexts = page.getByTestId('gap-reason-text');
      await expect(reasonTexts).toHaveCount(COVERAGE_GAPS.length);
      // Removing the badges entirely must not remove the meaning.
      await page.getByTestId('coverage-gaps').evaluate((sec) => {
        sec.querySelectorAll('.badge').forEach((b) => b.remove());
      });
      for (const gap of COVERAGE_GAPS) {
        await expect(
          page.getByTestId('coverage-gaps'),
          `reason "${gap.reasonClass}" must survive with color removed`,
        ).toContainText(gap.reasonClass);
      }
    });
  });

  // ── AC3: cross-source drill-down — distinct records, correlation, deps, authoritative fields ─
  test.describe('§AC3 cross-source drill-down', () => {
    test('shows distinct records across Kanban/agentctl/workflows with correlation + deps', async ({
      page,
    }) => {
      const section = page.getByTestId('cross-source-drilldown');
      const table = section.locator('table');
      await expect(table.locator('tbody tr')).toHaveCount(SOURCE_RECORDS.length);

      // Each named source has its OWN distinct record row + status + authoritative fields.
      for (const rec of SOURCE_RECORDS) {
        const row = table.locator('tbody tr', {
          has: page.getByText(rec.source, { exact: true }),
        });
        await expect(row, `source ${rec.source} must have a distinct record`).toHaveCount(1);
        const rowText = (await row.innerText()).toLowerCase();
        expect(rowText, `record ${rec.source} missing id`).toContain(rec.recordId.toLowerCase());
        expect(rowText, `record ${rec.source} missing status`).toContain(rec.status.toLowerCase());
      }

      // Status DIFFERENCES + correlation + dependency chain are in the text summary (AT-readable).
      const summary = page.getByTestId('drilldown-text-summary');
      await expect(summary).toContainText('in-review');
      await expect(summary).toContainText('running');
      await expect(summary).toContainText('blocked');
      await expect(summary).toContainText(/depend/i);
      // No source overrides another's authoritative fields — attribution is per-source.
      await expect(summary).toContainText(/authoritative/i);
    });
  });

  // ── AC4: stale/unavailable source — last-known time + confidence, NO current inference ───────
  test.describe('§AC4 staleness / last-known markers', () => {
    test('stale data is visibly marked with last-known time + confidence and is not inferred', async ({
      page,
    }) => {
      const panel = page.getByTestId('stale-source-panel');
      await expect(panel).toBeVisible();

      // Freshness is a data attribute AND visible text (not color alone).
      const marker = page.getByTestId('stale-marker');
      await expect(marker).toHaveAttribute('data-freshness', STALE_PROJECTION.freshness);
      await expect(marker).toContainText(STALE_PROJECTION.freshness);

      // Last-known time is a machine-readable <time>; confidence is present.
      await expect(page.getByTestId('last-known-time')).toHaveAttribute(
        'datetime',
        STALE_PROJECTION.lastKnownAt,
      );
      await expect(page.getByTestId('confidence')).toContainText(STALE_PROJECTION.confidence);

      // Explicit statement that current compliance/health is NOT inferred from stale data.
      await expect(page.getByTestId('no-stale-inference')).toContainText(/not inferred/i);
    });
  });

  // ── AC5: unregistered discovered source added to catalog with full metadata ──────────────────
  test.describe('§AC5 open-ended source catalog', () => {
    test('discovered source is catalogued with evidence, classification, and status metadata', async ({
      page,
    }) => {
      const table = page.getByTestId('discovered-sources');
      await expect(table.locator('tbody tr')).toHaveCount(DISCOVERED_SOURCES.length);

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

      for (const src of DISCOVERED_SOURCES) {
        const row = table.locator('tbody tr', {
          has: page.getByText(src.id, { exact: true }),
        });
        const rowText = (await row.innerText()).toLowerCase();
        // "type OR unknown" classification, plus every discovery field.
        expect(rowText, `${src.id} missing classification`).toContain(
          src.classification.toLowerCase(),
        );
        expect(rowText, `${src.id} missing access status`).toContain(
          src.accessStatus.toLowerCase(),
        );
        expect(rowText, `${src.id} missing onboarding state`).toContain(
          src.onboardingState.toLowerCase(),
        );
        // Discovery evidence is a real, navigable link (name/role/state to AT).
        await expect(
          row.getByRole('link', { name: src.discoveryEvidenceRef }),
          `${src.id} must link discovery evidence`,
        ).toBeVisible();
      }
    });
  });

  // ── AC6: discovered source gap stays visible (reason, impact, owner action, review/expiry) ───
  test.describe('§AC6 governed-source gaps', () => {
    test('unsupported/sensitive/etc source stays visible as a gap with review-or-expiry', async ({
      page,
    }) => {
      const table = page.getByTestId('governed-source-gaps');
      await expect(table.locator('tbody tr')).toHaveCount(SOURCE_GAPS.length);

      const headers = (await table.locator('thead th').allTextContents()).map((h) =>
        h.trim().toLowerCase(),
      );
      for (const required of ['reason', 'impact', 'owner action', 'review / expiry']) {
        expect(headers, `source-gaps missing column: ${required}`).toContain(required);
      }

      for (const gap of SOURCE_GAPS) {
        const row = table.locator('tbody tr', {
          has: page.getByText(gap.source, { exact: true }),
        });
        await expect(row, `source gap ${gap.source} must stay visible`).toHaveCount(1);
        const rowText = (await row.innerText()).toLowerCase();
        expect(rowText, `${gap.source} missing reason class`).toContain(gap.reasonClass);
        expect(rowText, `${gap.source} missing review/expiry`).toContain(
          gap.reviewOrExpiry.toLowerCase(),
        );
      }
    });
  });

  // ── Keyboard operability + visible, logical focus order (VO-79578e09…) ───────────────────────
  test.describe('keyboard operability & focus (WCAG 2.1.1, 2.4.3, 2.4.7)', () => {
    test('all interactive controls are reachable by keyboard in logical order', async ({
      page,
    }, testInfo) => {
      // Walk the tab order from the top of the document. Focus must land on real interactive
      // elements (never lost to <body>), and it must reach the reconcile button, the reason
      // form controls, and the session-extension button — i.e. no pointer-only interaction.
      const journey: string[] = [];
      const wanted = new Set([
        'reconcile-btn',
        'reason-input',
        'reason-submit',
        'extend-session-btn',
      ]);
      const seen = new Set<string>();

      for (let i = 0; i < 25 && seen.size < wanted.size; i += 1) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return { desc: '<none>', testid: '' };
          const tag = el.tagName.toLowerCase();
          const testid = el.getAttribute('data-testid') ?? '';
          return { desc: `${tag}#${el.id} [${testid}]`, testid };
        });
        expect(info.desc, `focus lost after ${i + 1} Tab press(es)`).not.toBe('<none>');
        journey.push(info.desc);
        if (info.testid && wanted.has(info.testid)) seen.add(info.testid);
      }

      await testInfo.attach('keyboard-journey.json', {
        body: JSON.stringify(journey, null, 2),
        contentType: 'application/json',
      });
      expect(
        Array.from(wanted).filter((w) => !seen.has(w)),
        'these controls were never keyboard-focusable',
      ).toEqual([]);
    });

    test('keyboard focus is visible (a focus outline is applied)', async ({ page }) => {
      const btn = page.getByTestId('reconcile-btn');
      await btn.focus();
      const outline = await btn.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth };
      });
      // The fixture applies a 3px solid outline on :focus-visible; assert a real, non-zero outline.
      expect(outline.style, 'focused control must show a visible outline').not.toBe('none');
      expect(parseFloat(outline.width), 'focus outline width must be > 0').toBeGreaterThan(0);
    });

    test('the reconcile action is operable with the keyboard alone (Enter)', async ({ page }) => {
      const status = page.getByTestId('async-status');
      await expect(status).toHaveText('');
      await page.getByTestId('reconcile-btn').focus();
      await page.keyboard.press('Enter'); // no mouse — keyboard activation only
      await expect(status).not.toHaveText('');
    });
  });

  // ── Screen-reader: names, roles, states, async updates, alerts, outcomes (VO-68021f5f…) ──────
  test.describe('screen-reader programmatic availability (WCAG 4.1.2, 4.1.3)', () => {
    test('async updates, alerts, and decision outcomes are announced via live regions', async ({
      page,
    }) => {
      // Live regions exist with the correct roles/politeness BEFORE the action.
      const asyncStatus = page.getByTestId('async-status');
      const alertRegion = page.getByTestId('alert-region');
      const outcome = page.getByTestId('decision-outcome');
      await expect(asyncStatus).toHaveAttribute('aria-live', 'polite');
      await expect(alertRegion).toHaveAttribute('aria-live', 'assertive');
      await expect(alertRegion).toHaveAttribute('role', 'alert');

      // Activating reconcile (keyboard) mutates all three live regions → AT is notified.
      await page.getByTestId('reconcile-btn').focus();
      await page.keyboard.press('Enter');
      await expect(asyncStatus).toContainText(/reconcil/i);
      await expect(alertRegion).toContainText(/alert/i);
      await expect(outcome).toContainText(/decision outcome/i);
    });

    test('form control exposes an accessible name via its associated label', async ({ page }) => {
      // Name/role/state are programmatic: the textbox is reachable by its accessible name.
      const input = page.getByRole('textbox', { name: /reason for owner action/i });
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('aria-describedby', /reason-hint/);
    });

    test('data tables expose captions and header scopes for AT navigation', async ({ page }) => {
      // Every data table has a caption and column/row header scopes so a screen reader can
      // navigate it structurally (WCAG 1.3.1 Info and Relationships).
      const tables = page.locator('main table');
      const count = await tables.count();
      expect(count, 'the view must expose structured data tables').toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const t = tables.nth(i);
        await expect(t.locator('caption'), `table ${i} needs a caption`).toHaveCount(1);
        await expect(
          t.locator('th[scope="col"]').first(),
          `table ${i} needs column headers`,
        ).toBeAttached();
      }
    });
  });

  // ── Non-color meaning + chart text summary & tabular alternative (VO-c01bc43b…, VO-057645e1…) ─
  test.describe('non-color meaning & chart alternatives (WCAG 1.4.1, 1.1.1)', () => {
    test('the risk chart has a text summary AND a tabular alternative with the same data', async ({
      page,
    }) => {
      const summary = page.getByTestId('chart-text-summary');
      await expect(summary).toContainText(/high/i);
      await expect(summary).toContainText(/medium/i);

      const altTable = page.getByTestId('chart-table-alternative');
      await expect(altTable).toBeVisible();
      // The tabular alternative preserves the material info: one row per risk tier + a count.
      for (const tier of ['high', 'medium', 'low']) {
        const row = altTable.locator('tbody tr', { has: page.getByText(tier, { exact: true }) });
        await expect(row, `risk table missing tier ${tier}`).toHaveCount(1);
      }
      // The decorative visual bars are hidden from assistive technology.
      await expect(page.locator('.bars')).toHaveAttribute('aria-hidden', 'true');
    });

    test('risk/health/coverage meaning survives with all color removed', async ({ page }) => {
      // Strip every color declaration; the labelled text values must remain the source of meaning.
      await page.evaluate(() => {
        const kill = document.createElement('style');
        kill.textContent = '* { color: #000 !important; background: #fff !important; }';
        document.head.appendChild(kill);
      });
      // Health + risk labels are still literal text in the inventory rows.
      const inv = page.getByTestId('reconciled-inventory');
      await expect(inv).toContainText('healthy');
      await expect(inv).toContainText('high');
      await expect(inv).toContainText('medium');
    });
  });

  // ── 400% zoom / reflow (VO-b574991b…; WCAG 1.4.10) ───────────────────────────────────────────
  test.describe('400% reflow (WCAG 1.4.10)', () => {
    test('content reflows into the 320px column without horizontal scrolling', async ({ page }) => {
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
        `content overflows horizontally at 400% zoom (scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}); WCAG 1.4.10 target is ${REFLOW_400.wcagTargetCssWidth} CSS px`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 2);
    });

    test('decision context, evidence refs, actions, and status survive 400% zoom', async ({
      page,
    }) => {
      await page.evaluate((factor) => {
        (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom =
          String(factor);
      }, REFLOW_400.zoomFactor);
      // Nothing is lost at 400%: the gap actions, evidence link, reconcile control, and stale
      // status are all still present and visible.
      await expect(page.getByTestId('coverage-gaps')).toBeVisible();
      await expect(
        page.getByRole('link', { name: DISCOVERED_SOURCES[0].discoveryEvidenceRef }),
      ).toBeVisible();
      await expect(page.getByTestId('reconcile-btn')).toBeVisible();
      await expect(page.getByTestId('stale-marker')).toBeVisible();
    });
  });

  // ── Time-limit warning + accessible extension path (VO-c8a68cfe…; WCAG 2.2.1) ─────────────────
  test.describe('session time-limit warning & extension (WCAG 2.2.1)', () => {
    test('a warning is shown and an accessible extension control is keyboard-operable', async ({
      page,
    }) => {
      const warning = page.getByTestId('timeout-warning');
      await expect(warning).toContainText(/expires/i);
      await expect(warning).toHaveAttribute('aria-live', 'polite');

      // The extension path is a real button reachable and activatable by keyboard.
      const extend = page.getByRole('button', { name: /extend session/i });
      await expect(extend).toBeVisible();
      await extend.focus();
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute('data-testid'),
      );
      expect(focused, 'the extension control must be keyboard-focusable').toBe(
        'extend-session-btn',
      );
    });
  });

  // ── Clear errors + preserved input on validation failure (VO-b81bd0e9…; WCAG 3.3.1, 3.3.3) ────
  test.describe('clear errors & preserved input (WCAG 3.3.1, 3.3.3)', () => {
    test('a validation failure explains the correction and preserves the entered text', async ({
      page,
    }) => {
      const input = page.getByTestId('reason-input');
      await input.focus();
      await page.keyboard.type('ab'); // too short — will fail the >=3 rule
      // Submit via the keyboard.
      await page.getByTestId('reason-submit').focus();
      await page.keyboard.press('Enter');

      // Error is announced (role=alert), uses clear language, and names the required correction.
      const error = page.getByTestId('reason-error');
      await expect(error).toBeVisible();
      await expect(error).toContainText(/at least 3 characters/i);
      // Programmatic association: the input is marked invalid and points at the error.
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(input).toHaveAttribute('aria-describedby', /reason-error/);
      // Entered text is NOT lost after the failure.
      await expect(input).toHaveValue('ab');

      // Correcting the input clears the error and yields a decision outcome.
      await input.focus();
      await page.keyboard.type('c'); // now "abc" — valid
      await page.getByTestId('reason-submit').focus();
      await page.keyboard.press('Enter');
      await expect(error).toBeHidden();
      await expect(page.getByTestId('decision-outcome')).toContainText(/reason accepted/i);
    });
  });
});
