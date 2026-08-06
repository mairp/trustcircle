import { expect, test } from '@playwright/test';

const trustedHeaders = {
  'x-trustcircle-principal': 'operator-roadmap-e2e',
  'x-trustcircle-tenant-id': '00000000-0000-4000-8000-000000000001',
  'x-trustcircle-tenant-name': 'Roadmap tenant',
  'x-trustcircle-roles': 'operator',
};

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(trustedHeaders);
});

test('role dashboard exposes route workspaces and disclosure-safe build identity', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Governance operating picture' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Operator command center' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Workspace navigation' }).first(),
  ).toContainText('Inventory');
  await expect(page.getByRole('link', { name: /Search governed records/ })).toBeVisible();
  await page.getByText('Support diagnostics').click();
  await expect(page.getByText('Application version')).toBeVisible();
  await expect(page.getByText('Approved-release drift')).toBeVisible();
  expect(await page.locator('form').count()).toBe(0);
});

test('domain routes preserve fail-visible explanation and route-based navigation', async ({
  page,
}) => {
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { level: 1, name: 'Governed inventory' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Blocked' }).first()).toBeVisible();
  await expect(page.getByText(/could not be read|not available/i).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Attention queue' }).first()).toHaveAttribute(
    'href',
    '/operations',
  );
});

test('global search, governed presets, and copilot remain role-scoped and explicit when empty', async ({
  page,
}) => {
  await page.goto('/search?view=unknown-records');
  await expect(page.getByRole('heading', { level: 1, name: 'Global search' })).toBeVisible();
  await expect(page.getByRole('search')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Unknown and unowned' })).toBeVisible();
  await expect(page.getByText('No matching governed records')).toBeVisible();
  await page.goto('/copilot?question=Which%20systems%20have%20stale%20evidence%3F');
  await expect(page.getByRole('heading', { level: 1, name: 'Governance copilot' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Facts', exact: true })).toBeVisible();
  await expect(page.getByText(/No answer is inferred/)).toBeVisible();
  await expect(page.getByText(/cannot approve, attest, verify, close, or execute/)).toBeVisible();
});

test('mobile navigation uses a compact disclosure without horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/trends');
  const mobileNavigation = page.locator('.mobile-workspace-navigation');
  await expect(mobileNavigation).toBeVisible();
  await expect(page.locator('.workspace-sidebar')).toBeHidden();
  await mobileNavigation.getByText('Navigate workspaces').click();
  await expect(mobileNavigation.getByRole('link', { name: 'Inventory' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
});

test('workspace routes fail closed without a verified identity', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/search');
  await expect(page.getByRole('heading', { name: 'Authentication required' })).toBeVisible();
  await expect(page.getByText(/Protected governance data has not been requested/)).toBeVisible();
  await context.close();
});
