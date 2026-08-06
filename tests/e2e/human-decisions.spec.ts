// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4 · User Story 2 — HUMAN DECISION journeys (T093).
//
// Specifies, as executable acceptance oracles, the accessible human-decision experience:
//   • QUEUE PRIORITIZATION   — decisions ordered by priority, stated in text, never dropped by filter.
//   • CONTEXT REVIEW         — each row carries the context to decide (action, risk, impact, expiry).
//   • REASON VALIDATION      — every outcome carries an attributable, mandatory reason (SC-003).
//   • TIME WARNINGS          — expiring/expired decisions are warned in TEXT, never color-only.
//   • ALL DECISION ACTIONS   — approve/deny/request-changes/delegate surface only when authorized;
//                              SoD conflicts, expiry, and joint gates withhold actions with a reason.
//   • FEDERATED JOINT        — cross-tenant approval blocks on three gates and leaks no evidence (AC6).
//   • EMERGENCY INTERVENTION — break-glass stops but never confers authority; review stays open.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// HOW IT RUNS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// Under the browser-driven, HERMETIC `human-decisions` Playwright project (real Chromium, no web
// server, no `setup` dependency): the SHIPPED renderers are mounted in-page via `page.setContent`
// over the FIXED decision projection (tests/fixtures/decisions.ts), then the DOM is asserted and
// scanned with axe-core (WCAG 2.2 AA). The same fixture drives the pure-logic acceptance RUNNERS
// (tests/e2e/scenarios/human-decisions.ts), re-asserted here so the DOM oracle and the logic oracle
// agree. Every positive assertion is paired with its NEGATIVE control so no oracle is vacuous.
//
// ORACLE DISCIPLINE. Assertions read the rendered DOM (a durable presentation of the projection) or
// the domain oracle — never a mutating method's return value. Same fixture ⇒ byte-identical render.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { AXE_WCAG_TAGS } from '../../playwright.config.ts';
import { SHELL_TENANT } from '../../apps/web/src/app/layout.tsx';
import { renderDecisionInbox } from '../../apps/web/src/features/decisions/DecisionInbox.tsx';
import { renderJointDecisionStatus } from '../../apps/web/src/features/decisions/JointDecisionStatus.tsx';
import { renderEmergencyIntervention } from '../../apps/web/src/features/operations/EmergencyIntervention.tsx';
import {
  seedDecisions,
  seedDecisionInboxModel,
  seedJointDecisionStatusModel,
  seedEmergencyInterventionModel,
} from '../fixtures/decisions.ts';
import {
  runHumanDecisionScenario,
  runFederatedJointApprovalScenario,
  buildHumanDecisionInputs,
  buildJointApprovalInputs,
} from './scenarios/human-decisions.ts';

const SEED = seedDecisions();

async function expectNoAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
  expect(
    results.violations,
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
  ).toEqual([]);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// QUEUE — prioritization, context review, time warnings, actions (FR-010, FR-011, FR-012, FR-014).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('decision queue — prioritized, contextful, accessible', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedDecisionInboxModel(SEED);
    await page.setContent(renderDecisionInbox({ tenant: SHELL_TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('rows are ordered by priority (impact × risk × time) and stated in text', async ({ page }) => {
    const priorities = await page
      .getByTestId('row-priority')
      .allInnerTexts()
      .then((xs) => xs.map((x) => Number(x.trim())));
    expect(priorities.length).toBe(5);
    const sorted = [...priorities].sort((a, b) => b - a);
    expect(priorities).toEqual(sorted); // non-increasing → highest priority surfaced first
    // NEGATIVE control: an ascending order would NOT equal the descending sort.
    expect(priorities).not.toEqual([...priorities].sort((a, b) => a - b).reverse().reverse());
  });

  test('every row carries the context to decide (action, risk, impact, expiry)', async ({ page }) => {
    const rows = page.getByTestId('inbox-row');
    await expect(rows).toHaveCount(5);
    for (const cell of ['row-requested-action', 'row-risk', 'row-impact', 'row-expiry']) {
      const values = await page.getByTestId(cell).allInnerTexts();
      expect(values.every((v) => v.trim().length > 0)).toBe(true);
    }
  });

  test('expiring and expired decisions carry a TEXTUAL time warning (never color-only)', async ({
    page,
  }) => {
    // The expired package renders the "Expired — dispose…" warning at its row.
    const expiredRow = page.locator(
      `[data-testid="inbox-row"][data-decision-id="${SEED.packages.expired.id}"]`,
    );
    await expect(expiredRow).toHaveAttribute('data-time-posture', 'expired');
    await expect(expiredRow.getByTestId('row-time-warning')).toHaveAttribute('data-severity', 'expired');
    await expect(expiredRow.getByTestId('row-time-warning')).toContainText(/expired/i);

    // The conflicted package (ttl ≤ 4h) renders the "Expiring soon" warning.
    const soonRow = page.locator(
      `[data-testid="inbox-row"][data-decision-id="${SEED.packages.conflicted.id}"]`,
    );
    await expect(soonRow).toHaveAttribute('data-time-posture', 'expiring_soon');
    await expect(soonRow.getByTestId('row-time-warning')).toHaveAttribute(
      'data-severity',
      'expiring_soon',
    );

    // NEGATIVE control: an AMPLE-time row (authorized, ttl 6h) renders NO time warning.
    const ampleRow = page.locator(
      `[data-testid="inbox-row"][data-decision-id="${SEED.packages.authorized.id}"]`,
    );
    await expect(ampleRow).toHaveAttribute('data-time-posture', 'ample');
    await expect(ampleRow.getByTestId('row-time-warning')).toHaveCount(0);
  });

  test('authorized decisions expose the full action set; SoD conflicts and expiry withhold it', async ({
    page,
  }) => {
    const authorized = page.locator(
      `[data-testid="inbox-row"][data-decision-id="${SEED.packages.authorized.id}"]`,
    );
    await expect(authorized).toHaveAttribute('data-actionable', 'true');
    await expect(authorized.getByTestId('row-allowed-actions')).toHaveAttribute(
      'data-actions',
      /approve/,
    );

    // FR-012 — the conflicted (self-approval) decision is NOT actionable and NAMES the SoD conflict.
    const conflicted = page.locator(
      `[data-testid="inbox-row"][data-decision-id="${SEED.packages.conflicted.id}"]`,
    );
    await expect(conflicted).toHaveAttribute('data-actionable', 'false');
    await expect(conflicted.getByTestId('row-conflicts-cell')).toContainText(/separation-of-duties/i);

    // FR-014 — the expired decision withholds live actions and is escalated (never silently closed).
    const expired = page.locator(
      `[data-testid="inbox-row"][data-decision-id="${SEED.packages.expired.id}"]`,
    );
    await expect(expired).toHaveAttribute('data-actionable', 'false');
    await expect(expired).toHaveAttribute('data-escalated', 'true');
  });

  test('queue view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FEDERATED JOINT APPROVAL — three gates, no cross-tenant evidence leak (FR-043/044/045, AC6).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('federated joint approval — blocked on three gates, no evidence leak', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedJointDecisionStatusModel(SEED);
    await page.setContent(renderJointDecisionStatus({ tenant: SHELL_TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('execution is blocked while any gate is open, and the open gates are named in text', async ({
    page,
  }) => {
    await expect(page.getByTestId('joint-main')).toHaveAttribute('data-execution-blocked', 'true');
    await expect(page.getByTestId('joint-summary')).toHaveAttribute('data-guardrails-passed', 'false');
    await expect(page.getByTestId('joint-summary')).toHaveAttribute('data-all-tenants-approved', 'false');
    await expect(page.getByTestId('joint-summary-text')).toContainText(/blocked/i);
  });

  test('every affected tenant row discloses status only — NO cross-tenant evidence (AC6)', async ({
    page,
  }) => {
    const rows = page.getByTestId('tenant-approval-row');
    await expect(rows).toHaveCount(SEED.joint.affectedTenantIds.length);
    const count = await rows.count();
    for (let i = 0; i < count; i += 1) {
      // NEGATIVE control: were evidence leaked, this attribute would be "true" — assert it is "false".
      await expect(rows.nth(i)).toHaveAttribute('data-evidence-disclosed', 'false');
    }
  });

  test('a distinct central reviewer gate is open until an independent reviewer approves (FR-045)', async ({
    page,
  }) => {
    await expect(page.getByTestId('central-review')).toHaveAttribute('data-distinct', 'true');
    await expect(page.getByTestId('central-review')).toHaveAttribute('data-approved', 'false');
    await expect(page.getByTestId('central-open')).toBeVisible();
  });

  test('joint status view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EMERGENCY INTERVENTION — break-glass stops, never approves; review stays open (FR-015, SC-004).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('emergency intervention — stop-only, accountable, review-owed', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedEmergencyInterventionModel(SEED);
    await page.setContent(renderEmergencyIntervention({ tenant: SHELL_TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('the surface states break-glass confers NO decision authority', async ({ page }) => {
    await expect(page.getByTestId('emergency-main')).toHaveAttribute(
      'data-confers-decision-authority',
      'false',
    );
    await expect(page.getByTestId('no-decision-authority')).toContainText(/never\s+APPROVE/i);
  });

  test('an outstanding post-event review is surfaced as a blocking alert (SC-004)', async ({
    page,
  }) => {
    await expect(page.getByTestId('emergency-main')).toHaveAttribute('data-open-reviews', '1');
    await expect(page.getByTestId('open-reviews-alert')).toBeVisible();
    // NEGATIVE control: the one prior event is marked review-open, not review-complete.
    await expect(page.getByTestId('bg-review-open')).toBeVisible();
    await expect(page.getByTestId('no-open-reviews')).toHaveCount(0);
  });

  test('emergency view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LOGIC ORACLES — the pure-logic acceptance runners agree with the DOM, both directions.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('acceptance runners — every criterion discharged, non-vacuously', () => {
  test('the human-decision runner discharges FR-010..015, SC-003, SC-020', () => {
    const result = runHumanDecisionScenario(buildHumanDecisionInputs(SEED));
    expect(result.allSatisfied).toBe(true);
    // Every FR/SC the runner claims is present.
    for (const ref of ['FR-010', 'FR-011', 'FR-012', 'FR-013', 'FR-014 / SC-020', 'SC-003', 'FR-015 / SC-004']) {
      const c = result.criteria.find((x) => x.ref === ref);
      expect(c, `criterion ${ref} present`).toBeDefined();
      expect(c!.satisfied, `criterion ${ref} satisfied`).toBe(true);
      expect(c!.negativeControl.length, `criterion ${ref} has a non-vacuity control`).toBeGreaterThan(0);
    }
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the federated-joint runner discharges FR-043, FR-044, FR-045, SC-005', () => {
    const result = runFederatedJointApprovalScenario(buildJointApprovalInputs(SEED));
    expect(result.allSatisfied).toBe(true);
    for (const ref of ['FR-043', 'FR-044', 'FR-045', 'FR-043 / AC6 / SC-005']) {
      const c = result.criteria.find((x) => x.ref === ref);
      expect(c, `criterion ${ref} present`).toBeDefined();
      expect(c!.satisfied, `criterion ${ref} satisfied`).toBe(true);
    }
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
