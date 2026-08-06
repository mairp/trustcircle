// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — CONTAIN & REPAIR DAMAGED WORK journeys (T126 · FR-016..022 · SC-006..009).
//
// Specifies, as executable acceptance oracles, the accessible contain-and-repair experience:
//   • DETECTED + PRIORITIZED  — damaged governance work is surfaced in a queue ordered highest-attention
//                               first, priority stated in text (FR-016 / SC-006).
//   • ORIGINAL PRESERVED      — the preserved original is reported INTACT via a matching verify digest;
//                               an un-fed comparison can never masquerade as intact (FR-017 / SC-007).
//   • CONTAINED, INSPECTABLE  — an active quarantine BLOCKS the named capabilities while keeping the
//                               item inspectable (FR-019 / SC-007).
//   • OWNERSHIP HONESTY       — an ownerless case names an explicit gap, never a fabricated owner (FR-018).
//   • BOUNDED AUTOMATION      — only an all-steps-pre-authorized, no-ownership-gap plan enables the
//                               execute-if-pre-authorized mode; a destructive plan does not (FR-020/021/SC-008).
//   • SUCCEEDED ≠ CLOSED      — a repair that succeeded is succeeded-unverified, not closed (FR-020).
//   • VERIFIED CLOSURE        — a case is verified-closed ONLY when all nine gates pass under an
//                               independent verification (FR-022 / SC-009).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// HOW IT RUNS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// Under the browser-driven, HERMETIC `integrity-remediation` Playwright project (real Chromium, no web
// server, no `setup` dependency): the SHIPPED renderers (IntegrityQueue / EvidenceComparison /
// RemediationDetail) are mounted in-page via `page.setContent` over the FIXED integrity projection
// (tests/fixtures/integrity.ts), then the DOM is asserted and scanned with axe-core (WCAG 2.2 AA). The
// same fixture drives the pure-logic acceptance RUNNERS (tests/e2e/scenarios/integrity-remediation.ts),
// re-asserted here so the DOM oracle and the logic oracle agree. Every positive assertion is paired with
// its NEGATIVE control so no oracle is vacuous.
//
// ORACLE DISCIPLINE. Assertions read the rendered DOM (a durable presentation of the projection) or the
// domain oracle — never a mutating method's return value. Same fixture ⇒ byte-identical render.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { AXE_WCAG_TAGS } from '../../playwright.config.ts';
import { renderIntegrityQueue } from '../../apps/web/src/features/integrity/IntegrityQueue.tsx';
import { renderEvidenceComparison } from '../../apps/web/src/features/integrity/EvidenceComparison.tsx';
import { renderRemediationDetail } from '../../apps/web/src/features/integrity/RemediationDetail.tsx';
import {
  seedIntegrity,
  seedIntegrityQueueModel,
  seedEvidenceComparisonModel,
  seedRemediationDetailModel,
  seedVerifiedClosedDetailModel,
  TENANT_SCOPE,
} from '../fixtures/integrity.ts';
import {
  runIntegrityRemediationScenario,
  runIntegrityAccessibilityScenario,
  buildIntegrityInputs,
} from './scenarios/integrity-remediation.ts';

const SEED = seedIntegrity();
const CASE = (scenario: string): string =>
  String(SEED.find((s) => s.scenario === scenario)!.case.id);

async function expectNoAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
  expect(
    results.violations,
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
  ).toEqual([]);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// QUEUE — damaged work detected, prioritized, ownership-honest (FR-016, FR-018, SC-006).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('integrity queue — prioritized, ownership-honest, accessible', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedIntegrityQueueModel(SEED);
    await page.setContent(renderIntegrityQueue({ tenant: TENANT_SCOPE, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('every damaged case is surfaced, ordered highest-priority first, stated in text (FR-016 / SC-006)', async ({
    page,
  }) => {
    const rows = page.getByTestId('integrity-row');
    await expect(rows).toHaveCount(SEED.length);

    const priorities = await page
      .getByTestId('row-priority')
      .allInnerTexts()
      .then((xs) => xs.map((x) => Number(x.trim())));
    expect(priorities.length).toBe(SEED.length);
    const sorted = [...priorities].sort((a, b) => b - a);
    expect(priorities).toEqual(sorted); // non-increasing → highest-attention first

    // The result summary states the counts in TEXT (never color-only).
    await expect(page.getByTestId('integrity-result-status')).toHaveAttribute(
      'data-total',
      String(SEED.length),
    );

    // NEGATIVE control: the ascending order would NOT equal the descending sort (guards vacuity).
    const ascending = [...priorities].sort((a, b) => a - b);
    expect(ascending).not.toEqual(sorted);
  });

  test('the top row is the escalated, human-attention case (FR-016 / SC-006)', async ({ page }) => {
    const first = page.getByTestId('integrity-row').first();
    await expect(first).toHaveAttribute('data-case-id', CASE('unresolved_escalated'));
    await expect(first).toHaveAttribute('data-needs-attention', 'true');

    // NEGATIVE control: the verified-closed case is NOT flagged for attention.
    const closed = page.locator(
      `[data-testid="integrity-row"][data-case-id="${CASE('verified_closed')}"]`,
    );
    await expect(closed).toHaveAttribute('data-needs-attention', 'false');
  });

  test('an ownerless case names an explicit ownership gap, never a fabricated owner (FR-018)', async ({
    page,
  }) => {
    const escalated = page.locator(
      `[data-testid="integrity-row"][data-case-id="${CASE('unresolved_escalated')}"]`,
    );
    await expect(escalated).toHaveAttribute('data-ownership-gap', 'true');
    await expect(escalated.getByTestId('row-ownership-gap')).toBeVisible();
    // No owner cell is fabricated for the gap.
    await expect(escalated.getByTestId('row-owner')).toHaveCount(0);

    // NEGATIVE control: an owned case shows a named owner and NO gap.
    const owned = page.locator(
      `[data-testid="integrity-row"][data-case-id="${CASE('detected_preserved')}"]`,
    );
    await expect(owned).toHaveAttribute('data-ownership-gap', 'false');
    await expect(owned.getByTestId('row-owner')).toBeVisible();
  });

  test('only the verified-closed case is shown closed; all others are not (FR-022)', async ({
    page,
  }) => {
    const closed = page.locator(
      `[data-testid="integrity-row"][data-case-id="${CASE('verified_closed')}"]`,
    );
    await expect(closed).toHaveAttribute('data-closure-realized', 'true');
    await expect(closed.getByTestId('row-verified-closed')).toBeVisible();

    // NEGATIVE control: the auto-repairable case is NOT closed (a repair alone never closes a case).
    const auto = page.locator(
      `[data-testid="integrity-row"][data-case-id="${CASE('auto_repairable')}"]`,
    );
    await expect(auto).toHaveAttribute('data-closure-realized', 'false');
    await expect(auto.getByTestId('row-not-closed')).toBeVisible();
  });

  test('queue view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EVIDENCE COMPARISON — original preserved intact, damage contained (FR-017, FR-019, SC-007).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('evidence comparison — original intact, damage contained', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedEvidenceComparisonModel(SEED);
    await page.setContent(renderEvidenceComparison({ tenant: TENANT_SCOPE, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('the preserved original is reported INTACT with a matching verify digest (FR-017 / SC-007)', async ({
    page,
  }) => {
    await expect(page.getByTestId('compare-main')).toHaveAttribute('data-original-intact', 'true');
    const banner = page.getByTestId('preservation-banner');
    await expect(banner).toHaveAttribute('data-original-intact', 'true');
    await expect(banner).toHaveAttribute('role', 'status');
    // The intactness is checkable: the captured digest equals the independent verify digest.
    const captured = (await page.getByTestId('preservation-captured-digest').innerText()).trim();
    const verify = (await page.getByTestId('preservation-verify-digest').innerText()).trim();
    expect(captured).toBe(verify);

    // The original snapshot is NOT quarantined; the current (damaged) snapshot IS.
    const original = page.locator('[data-testid="evidence-snapshot"][data-side="original"]');
    const current = page.locator('[data-testid="evidence-snapshot"][data-side="current"]');
    await expect(original).toHaveAttribute('data-quarantined', 'false');
    await expect(current).toHaveAttribute('data-quarantined', 'true');
  });

  test('an active quarantine CONTAINS the damage while keeping it inspectable (FR-019 / SC-007)', async ({
    page,
  }) => {
    await expect(page.getByTestId('compare-main')).toHaveAttribute(
      'data-quarantine-contains',
      'true',
    );
    const containment = page.getByTestId('containment-banner');
    await expect(containment).toHaveAttribute('data-quarantine-contains', 'true');
    await expect(containment).toHaveAttribute('role', 'status');
    // Containment is scoped to NAMED blocked capabilities (not opaque, not a blanket ban).
    const blocked = await containment.getAttribute('data-blocked');
    expect(blocked && blocked.length).toBeTruthy();

    // Inspectability: the diff is fully rendered (containment ≠ opacity).
    const diffRows = page.getByTestId('diff-row');
    expect(await diffRows.count()).toBeGreaterThan(0);
    // NEGATIVE control: a safety-relevant checksum change is disclosed, not hidden.
    const checksum = page.locator('[data-testid="diff-row"][data-field="checksum"]');
    await expect(checksum).toHaveAttribute('data-safety-relevant', 'true');
    await expect(checksum).toHaveAttribute('data-change-kind', 'changed');
  });

  test('comparison view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REMEDIATION DETAIL — bounded automation, succeeded ≠ closed (FR-020, FR-021, SC-008).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('remediation detail — bounded automation, succeeded is not closed', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedRemediationDetailModel(SEED);
    await page.setContent(renderRemediationDetail({ tenant: TENANT_SCOPE, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('execute-if-pre-authorized is ENABLED only when every step is pre-authorized low-risk (FR-020/021/SC-008)', async ({
    page,
  }) => {
    await expect(page.getByTestId('detail-main')).toHaveAttribute('data-execute-enabled', 'true');
    const execute = page.locator(
      '[data-testid="remediation-mode"][data-mode="execute_if_pre_authorized"]',
    );
    await expect(execute).toHaveAttribute('data-execute-enabled', 'true');
    await expect(execute).not.toHaveAttribute('disabled', '');

    // Every rendered step is pre-authorized low-risk — the basis for the enabled gate.
    const steps = page.getByTestId('remediation-step');
    const n = await steps.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) {
      await expect(steps.nth(i)).toHaveAttribute('data-pre-authorized', 'true');
    }
    await expect(page.getByTestId('execute-gate-note')).toHaveAttribute(
      'data-execute-enabled',
      'true',
    );
  });

  test('a repair that succeeded is succeeded-unverified and NOT closed (FR-020)', async ({
    page,
  }) => {
    await expect(page.getByTestId('remediation-attempt')).toHaveAttribute(
      'data-outcome',
      'succeeded_unverified',
    );
    await expect(page.getByTestId('attempt-unverified')).toBeVisible();
    // Rollback stays available after a succeeded-unverified repair (way-back preserved).
    await expect(page.getByTestId('remediation-attempt')).toHaveAttribute(
      'data-rollback-available',
      'true',
    );
    // The case is NOT closed — closure is a separate verification act.
    await expect(page.getByTestId('detail-main')).toHaveAttribute('data-case-closed', 'false');
    const closure = page.getByTestId('closure-banner');
    await expect(closure).toHaveAttribute('data-case-closed', 'false');
    await expect(closure).toHaveAttribute('role', 'alert');
    // NEGATIVE control: no gates were verified for this un-closed case.
    await expect(page.getByTestId('verification-none')).toBeVisible();
  });

  test('detail view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// VERIFIED CLOSURE — closed only on an independent nine-gate pass (FR-022, SC-009).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('verified closure — closed only on an independent nine-gate pass', () => {
  test.beforeEach(async ({ page }) => {
    const model = seedVerifiedClosedDetailModel(SEED);
    await page.setContent(renderRemediationDetail({ tenant: TENANT_SCOPE, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();
  });

  test('the case is verified-closed and all nine gates are shown passed (FR-022 / SC-009)', async ({
    page,
  }) => {
    await expect(page.getByTestId('detail-main')).toHaveAttribute('data-case-closed', 'true');
    const closure = page.getByTestId('closure-banner');
    await expect(closure).toHaveAttribute('data-case-closed', 'true');
    await expect(closure).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('remediation-verification')).toHaveAttribute(
      'data-all-gates-passed',
      'true',
    );

    const gates = page.getByTestId('verification-gate');
    await expect(gates).toHaveCount(9);
    const n = await gates.count();
    for (let i = 0; i < n; i += 1) {
      // NEGATIVE control: were any gate false, closure could not be shown — assert every gate passed.
      await expect(gates.nth(i)).toHaveAttribute('data-passed', 'true');
    }
  });

  test('closure view has zero WCAG 2.2 AA accessibility violations', async ({ page }) => {
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LOGIC ORACLES — the pure-logic acceptance runners agree with the DOM, non-vacuously.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('acceptance runners — every criterion discharged, non-vacuously', () => {
  test('the remediation runner discharges FR-016..022, SC-006..009', () => {
    const result = runIntegrityRemediationScenario(buildIntegrityInputs(SEED));
    expect(result.allSatisfied).toBe(true);
    for (const ref of [
      'FR-016 / SC-006',
      'FR-017 / SC-007',
      'FR-018',
      'FR-019 / SC-007',
      'FR-020 / FR-021 / SC-008',
      'FR-020',
      'FR-022 / SC-009',
    ]) {
      const c = result.criteria.find((x) => x.ref === ref);
      expect(c, `criterion ${ref} present`).toBeDefined();
      expect(c!.satisfied, `criterion ${ref} satisfied`).toBe(true);
      expect(
        c!.negativeControl.length,
        `criterion ${ref} has a non-vacuity control`,
      ).toBeGreaterThan(0);
    }
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the accessibility runner discharges the presenter a11y + empty-model honesty obligations', async () => {
    const result = await runIntegrityAccessibilityScenario(buildIntegrityInputs(SEED));
    expect(result.allSatisfied).toBe(true);
    for (const ref of ['SC-006 / SC-007 / SC-009', 'FR-017 / FR-022 / GAR-004']) {
      const c = result.criteria.find((x) => x.ref === ref);
      expect(c, `criterion ${ref} present`).toBeDefined();
      expect(c!.satisfied, `criterion ${ref} satisfied`).toBe(true);
    }
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
