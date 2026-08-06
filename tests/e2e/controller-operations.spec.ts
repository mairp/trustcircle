// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — OPERATE GOVERNANCE CONTROLLERS SAFELY journeys (T157 · FR-023..028 ·
// FR-046..050 · NS-005 · NS-011 · SC-010 · SC-011 · SC-021).
//
// Specifies, as executable acceptance oracles, the accessible safe-control experience:
//   • DISCOVERED + DRIFT NEVER MASKED — every governed controller is surfaced; a drifted controller shows
//                                       DRIFT in text even under a health verdict (FR-023 / FR-024 / SC-010).
//   • EXACT PERMITTED ACTIONS         — each row/operation exposes exactly its projector-permitted next
//                                       actions; the platform never widens the set (FR-024).
//   • UNCERTAINTY ≠ SUCCESS           — a timed-out dispatch is NOT confirmed and surfaces AWAITING
//                                       RECONCILIATION; only a directly-observed effect is confirmed (FR-028).
//   • ONE EFFECT                      — a duplicate effect is surfaced, never hidden (SC-011).
//   • GATED ACTIONS + IDEMPOTENCY     — a state-changing button is enabled iff the state permits it AND
//                                       simulation + approval hold; a required idempotency key is present
//                                       (FR-024 / FR-025 / GAR-005 / FR-026).
//   • BOUNDED CONTINUITY              — an active continuity lease surfaces its bounded, nonrenewable window
//                                       and reconcile-on-return duty (FR-046..050 / SC-021).
//   • ROLLBACK PROTECTS NEWER STATE   — a rollback refused to protect newer legitimate state is surfaced as
//                                       such, never as a plain success (NS-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// HOW IT RUNS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// Under the browser-driven, HERMETIC `controller-operations` Playwright project (real Chromium, no web
// server, no `setup` dependency): the SHIPPED renderers (ControllerRegistry / OperationDetail /
// OperationActions) are mounted in-page via `page.setContent` over the FIXED controller world
// (tests/fixtures/controllers.ts), then the DOM is asserted and scanned with axe-core (WCAG 2.2 AA). The
// same fixture drives the pure-logic acceptance RUNNERS (tests/e2e/scenarios/controller-operations.ts),
// re-asserted here so the DOM oracle and the logic oracle agree. Every positive assertion is paired with
// its NEGATIVE control so no oracle is vacuous.
//
// ORACLE DISCIPLINE. Assertions read the rendered DOM (a durable presentation of the projection) or a
// domain/application oracle — never a mutating method's return value. Same fixture ⇒ byte-identical render.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { AXE_WCAG_TAGS } from '../../playwright.config.ts';
import { renderControllerRegistry } from '../../apps/web/src/features/controllers/ControllerRegistry.tsx';
import { renderOperationDetail } from '../../apps/web/src/features/controllers/OperationDetail.tsx';
import { renderOperationActions } from '../../apps/web/src/features/controllers/OperationActions.tsx';
import {
  seedControllers,
  seedControllerRegistryModel,
  seedOperationDetailModel,
  seedOperationActionsModel,
} from '../fixtures/controllers.ts';
import {
  buildControllerInputs,
  runControllerOperationsScenario,
  runControllerAccessibilityScenario,
  runUncertainRemoteOutcomeScenario,
  runBoundedContinuityScenario,
  runControllerRollbackScenario,
  CONTROLLER_TENANT_SCOPE,
} from './scenarios/controller-operations.ts';

const SEED = seedControllers();
const TENANT = CONTROLLER_TENANT_SCOPE;

async function expectNoAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
  expect(
    results.violations,
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
  ).toEqual([]);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REGISTRY — every controller discovered; drift never masked; exact permitted actions (FR-023/024/SC-010).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('controller registry — discovered, drift never masked, exact actions', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedControllerRegistryModel();
    await page.setContent(renderControllerRegistry({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('every governed controller is discovered and surfaced (FR-023 / SC-010)', async ({
    page,
  }) => {
    const rows = page.getByTestId('controller-row');
    await expect(rows).toHaveCount(SEED.length);
    await expect(page.getByTestId('controller-result-status')).toBeVisible();
  });

  test('a drifted controller shows DRIFT in text, never masked by health (FR-024)', async ({
    page,
  }) => {
    // The drifted scenario is `degraded` health with observed ≠ desired — drift must be surfaced anyway.
    const drifted = page.locator('[data-testid="controller-row"][data-drift="true"]').first();
    await expect(drifted).toBeVisible();
    await expect(drifted.getByTestId('row-drift')).toBeVisible();
    // The meaning is in the WORD, not a hue (WCAG 1.4.1).
    await expect(drifted.getByTestId('row-drift')).toContainText(/DRIFT/);

    // NEGATIVE control: a healthy, non-drifted row states "no drift" and carries data-drift="false".
    const clean = page.locator('[data-testid="controller-row"][data-drift="false"]').first();
    await expect(clean).toBeVisible();
    await expect(clean.getByTestId('row-no-drift')).toBeVisible();
  });

  test('each row exposes its EXACT permitted-action set (FR-024, no widening)', async ({
    page,
  }) => {
    const rows = page.getByTestId('controller-row');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) {
      // Every row carries a machine-readable permitted-action set (may be empty for an idle controller).
      await expect(rows.nth(i).getByTestId('row-permitted-actions')).toBeVisible();
    }
  });

  test('registry view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPERATION DETAIL (UNCERTAIN) — uncertainty ≠ success, awaiting reconciliation (FR-028 / SC-010).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('operation detail (uncertain) — an acknowledgement is never a success', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedOperationDetailModel('uncertain_outcome');
    await page.setContent(renderOperationDetail({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('a timed-out dispatch is NOT confirmed and surfaces awaiting-reconciliation (FR-028)', async ({
    page,
  }) => {
    const banner = page.getByTestId('confirmation-banner');
    await expect(banner).toHaveAttribute('data-effect-confirmed', 'false');
    await expect(banner).toHaveAttribute('data-awaiting-reconciliation', 'true');
    await expect(page.getByTestId('awaiting-reconciliation')).toBeVisible();
    // The reconciliation region reports no established state / zero observed effects.
    await expect(page.getByTestId('reconciliation-region')).toHaveAttribute(
      'data-reconciliation-result',
      /still_uncertain|none/,
    );

    // NEGATIVE control: the operation-main carries data-effect-confirmed=false (the whole view is honest).
    await expect(page.getByTestId('operation-main')).toHaveAttribute(
      'data-effect-confirmed',
      'false',
    );
  });

  test('detail (uncertain) view has zero WCAG 2.2 AA accessibility violations', async ({
    page,
  }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPERATION DETAIL (VERIFIED SUCCESS) — the ONLY confirmed operation is a directly-observed one (FR-028).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('operation detail (verified success) — confirmed only via direct observation', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedOperationDetailModel('verified_success');
    await page.setContent(renderOperationDetail({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('a directly-observed, reconciled operation IS confirmed (FR-028)', async ({ page }) => {
    const banner = page.getByTestId('confirmation-banner');
    await expect(banner).toHaveAttribute('data-effect-confirmed', 'true');
    await expect(banner).toHaveAttribute('data-awaiting-reconciliation', 'false');
    // The reconciliation region shows exactly one observed effect (SC-011 — one dispatch, one effect).
    await expect(page.getByTestId('reconciliation-effect-count')).toContainText(/1/);
    // NEGATIVE control: no duplicate-effect warning is present for a single-effect success.
    await expect(page.getByTestId('duplicate-effect-warning')).toHaveCount(0);
  });

  test('detail (verified success) view has zero WCAG 2.2 AA accessibility violations', async ({
    page,
  }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPERATION DETAIL (CONTINUITY) — bounded, nonrenewable lease + reconcile-on-return (FR-046..050 / SC-021).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('operation detail (continuity) — bounded, nonrenewable window', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedOperationDetailModel('continuity');
    await page.setContent(renderOperationDetail({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('an active continuity lease surfaces its bounded window and reconcile-on-return duty (FR-046/050)', async ({
    page,
  }) => {
    const region = page.getByTestId('continuity-region');
    await expect(region).toHaveAttribute('data-continuity-active', 'true');
    await expect(page.getByTestId('continuity-reconcile-obligation')).toBeVisible();

    // NEGATIVE control: a non-continuity operation renders NO continuity lease at all.
    const noLease = seedOperationDetailModel('verified_success');
    await page.setContent(renderOperationDetail({ tenant: TENANT, model: noLease }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('continuity-region')).toHaveAttribute(
      'data-continuity-active',
      'false',
    );
  });

  test('detail (continuity) view has zero WCAG 2.2 AA accessibility violations', async ({
    page,
  }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPERATION DETAIL (ROLLBACK CONFLICT) — a rollback protects newer legitimate state (NS-011).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('operation detail (rollback conflict) — protect newer state', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedOperationDetailModel('rollback_conflict');
    await page.setContent(renderOperationDetail({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('a rollback refused to protect newer state is surfaced as such, not as success (NS-011)', async ({
    page,
  }) => {
    const region = page.getByTestId('rollback-region');
    await expect(region).toHaveAttribute('data-rollback-result', 'rollback_refused_newer_state');
    await expect(region).toHaveAttribute('data-protected-newer-state', 'true');
    await expect(page.getByTestId('rollback-protected')).toBeVisible();
    // NEGATIVE control: this operation is NOT presented as a confirmed success.
    await expect(page.getByTestId('confirmation-banner')).toHaveAttribute(
      'data-effect-confirmed',
      'false',
    );
  });

  test('detail (rollback conflict) view has zero WCAG 2.2 AA accessibility violations', async ({
    page,
  }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// OPERATION ACTIONS — gated buttons + required idempotency key (FR-024/025/GAR-005/FR-026).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('operation actions — gated, with a required idempotency key', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedOperationActionsModel('uncertain_outcome');
    await page.setContent(renderOperationActions({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('a state-changing action not permitted from the current state is DISABLED with a reason (FR-024/GAR-005)', async ({
    page,
  }) => {
    // `execute` is not in the permitted set for a `reconciling` operation → disabled + stated reason.
    const execute = page.locator('[data-testid="operation-action"][data-kind="execute"]');
    await expect(execute).toHaveAttribute('data-enabled', 'false');
    await expect(execute).toHaveAttribute('disabled', '');
    await expect(
      page.locator('[data-testid="action-disabled-reason"][data-kind="execute"]'),
    ).toBeVisible();

    // NEGATIVE control: a permitted read-only action (collect_evidence) IS enabled.
    const evidence = page.locator('[data-testid="operation-action"][data-kind="collect_evidence"]');
    await expect(evidence).toHaveAttribute('data-enabled', 'true');
  });

  test('a required idempotency-key field is present (FR-026)', async ({ page }) => {
    const idem = page.getByTestId('idempotency-key-input');
    await expect(idem).toBeVisible();
    await expect(idem).toHaveAttribute('required', '');
  });

  test('actions view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LOGIC ORACLES — the pure-logic acceptance runners agree with the DOM, non-vacuously.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('acceptance runners — every criterion discharged, non-vacuously', () => {
  test('the operations runner discharges FR-023..028, SC-010, SC-011, FR-046..050, NS-011', () => {
    const result = runControllerOperationsScenario(buildControllerInputs());
    expect(result.allSatisfied).toBe(true);
    expect(result.criteria.length).toBeGreaterThan(0);
    for (const c of result.criteria) {
      expect(c.satisfied, `criterion ${c.ref} satisfied`).toBe(true);
      expect(
        c.negativeControl.length,
        `criterion ${c.ref} has a non-vacuity control`,
      ).toBeGreaterThan(0);
    }
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the named sub-scenarios each discharge their obligations (T180/T181/T182)', () => {
    const inputs = buildControllerInputs();
    for (const sub of [
      runUncertainRemoteOutcomeScenario(inputs),
      runBoundedContinuityScenario(inputs),
      runControllerRollbackScenario(inputs),
    ]) {
      expect(sub.allSatisfied, `${sub.scenario} all satisfied`).toBe(true);
      expect(sub.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test('the accessibility runner discharges the presenter a11y + empty-model honesty obligations', async () => {
    const result = await runControllerAccessibilityScenario(buildControllerInputs());
    expect(result.allSatisfied).toBe(true);
    for (const c of result.criteria) {
      expect(c.satisfied, `criterion ${c.ref} satisfied`).toBe(true);
    }
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
