// GATE77 DOM-level RED-witness spec (non-vacuity, browser read path).
//
// The six positive AC oracles in `app-shell.spec.ts` (lines :272,:352,:414,:470,:519,:592) each
// assert a DOM property the SHIPPED shell renders from the service-derived model. This spec proves
// those oracles are NON-VACUOUS at the DOM read path: for each AC it mounts the shell with the
// AC's single INPUT mutation applied, then asserts the *decisive DOM assertion the positive oracle
// makes* now FAILS — i.e. driving that positive oracle RED. Each test is GREEN precisely BECAUSE the
// positive oracle's DOM expectation is falsified by the mutated input (`await expect(...).rejects`).
//
// Runs under the same hermetic `accessibility-current-state` project (real Chromium, page.setContent,
// no web server). Complements support/nonvacuity-probes.test.mts, which proves the same six collapses
// at the read-model layer. Together they show every positive oracle depends on its un-mutated input.

import { test, expect, type Page } from '@playwright/test';

import {
  renderAppShell,
  SHELL_TENANT,
  SHELL_STATUS,
  type AppShellProps,
} from '../../apps/web/src/app/layout.tsx';
import { buildService, deriveModel, SCENARIO_IDS, T0 } from './support/current-state-model.ts';

function mutatedProps(overrides: Record<string, boolean>): AppShellProps {
  return {
    role: 'operator',
    tenant: SHELL_TENANT,
    status: SHELL_STATUS,
    currentState: deriveModel(buildService(overrides), T0),
  };
}

async function mount(page: Page, p: AppShellProps): Promise<void> {
  await page.setContent(renderAppShell(p), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('main#main')).toBeVisible();
}

test.describe('§NON-VACUITY DOM RED witnesses — each positive AC oracle fails under its input mutation', () => {
  test('AC1 RED-witness [:272]: with a duplicate id, the "one row per healthy service row" DOM assertion still holds ONE (dedup) — the naive two-row expectation is falsified', async ({
    page,
  }) => {
    // The positive oracle asserts DOM rows === healthy service rows. Under the duplicate mutation the
    // NAIVE (non-dedup) expectation of two rows for the id is falsified: only one row exists.
    await mount(page, mutatedProps({ duplicateHealthyAsset: true }));
    const svc = buildService({ duplicateHealthyAsset: true });
    const name = svc
      .currentStateView(T0)
      .find((r) => r.assetId === SCENARIO_IDS.healthyAsset)!.name;
    const rows = page
      .getByTestId('reconciled-inventory')
      .locator('table tbody th[scope="row"]', { hasText: name });
    // A vacuous "list whatever you're handed" view would show 2. Assert the naive expectation is RED.
    await expect(async () => {
      await expect(rows).toHaveCount(2, { timeout: 400 });
    }).rejects.toThrow();
    // And the correct (dedup) count is exactly 1 — the property the positive oracle guards.
    await expect(rows).toHaveCount(1);
  });

  test('AC2 RED-witness [:352]: dropping the component gap drives the coverage-gap "≥1 row" oracle RED', async ({
    page,
  }) => {
    await mount(page, mutatedProps({ dropComponentGap: true }));
    const rows = page.getByTestId('coverage-gaps').locator('tbody tr');
    // Positive oracle asserts one row per componentGaps() (≥1). Under the mutation it is 0 → RED.
    await expect(async () => {
      await expect(rows).toHaveCount(buildService().componentGaps().length, { timeout: 400 });
    }).rejects.toThrow();
    await expect(rows).toHaveCount(0);
  });

  test('AC3 RED-witness [:414]: single-source collapse drives the "data-distinct-sources = 3" oracle RED', async ({
    page,
  }) => {
    await mount(page, mutatedProps({ singleSourceOnly: true }));
    const summary = page.getByTestId('drilldown-text-summary');
    // Positive oracle asserts data-distinct-sources === 3. Under the collapse it is 1 → RED.
    await expect(async () => {
      await expect(summary).toHaveAttribute('data-distinct-sources', '3', { timeout: 400 });
    }).rejects.toThrow();
    await expect(summary).toHaveAttribute('data-distinct-sources', '1');
  });

  test('AC4 RED-witness [:470]: fresh evidence drives the "stale-marker present, health withheld" oracle RED', async ({
    page,
  }) => {
    await mount(page, mutatedProps({ forceStaleRecordFresh: true }));
    const marker = page.getByTestId('stale-marker');
    // Positive oracle asserts a stale-marker exists with reported-health="unknown". Fresh → absent → RED.
    await expect(async () => {
      await expect(marker).toHaveAttribute('data-reported-health', 'unknown', { timeout: 400 });
    }).rejects.toThrow();
    await expect(marker).toHaveCount(0);
  });

  test('AC5 RED-witness [:519]: stripping the evidence ref drives the "discovery-evidence link visible" oracle RED', async ({
    page,
  }) => {
    await mount(page, mutatedProps({ dropDiscoveryEvidence: true }));
    const row = page.getByTestId('discovered-sources').locator('tbody tr', {
      has: page.getByText(String(SCENARIO_IDS.discoveredCatalog), { exact: true }),
    });
    // Positive oracle asserts a discovery-evidence LINK is visible. Stripped → no link → RED.
    await expect(async () => {
      await expect(row.getByRole('link'), 'no evidence link should remain').toHaveCount(1, {
        timeout: 400,
      });
    }).rejects.toThrow();
    await expect(row.getByTestId('no-discovery-evidence')).toBeVisible();
  });

  test('AC6 RED-witness [:592]: dropping the review/expiry deadline drives the "≥1 governed-source gap row" oracle RED', async ({
    page,
  }) => {
    await mount(page, mutatedProps({ dropGovernedGapReview: true }));
    const rows = page.getByTestId('governed-source-gaps').locator('tbody tr');
    // Positive oracle asserts one row per governedSourceGaps() (≥1). Dropped deadline → 0 → RED.
    await expect(async () => {
      await expect(rows).toHaveCount(buildService().governedSourceGaps().length, { timeout: 400 });
    }).rejects.toThrow();
    await expect(rows).toHaveCount(0);
  });
});
