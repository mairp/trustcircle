import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';

async function openAs(
  page: Page,
  roles: string,
  tenantId = TENANT_A,
  tenantName = 'Operations tenant A',
) {
  await page.setExtraHTTPHeaders({
    'x-trustcircle-principal': 'operations-browser-operator',
    'x-trustcircle-tenant-id': tenantId,
    'x-trustcircle-tenant-name': tenantName,
    'x-trustcircle-roles': roles,
  });
  await page.goto('/');
}

test('auditor gets a read-only, filterable and accessible command center', async ({ page }) => {
  await openAs(page, 'auditor');
  await expect(page.getByRole('heading', { name: 'Prioritized attention queue' })).toBeVisible();
  await expect(page.getByText('Read-only case visibility')).toBeVisible();
  await expect(page.getByText(/Urgent totals above are unfiltered/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open governed case' })).toHaveCount(0);

  const severity = page.getByLabel('Severity');
  await severity.focus();
  await expect(severity).toBeFocused();
  await severity.selectOption('critical');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/severity=critical/);
  await expect(page.getByLabel('Severity')).toHaveValue('critical');
  await expect(page.getByRole('definition').filter({ hasText: '0' }).first()).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('authority matrix hides platform administration and exposes governed role intent', async ({
  page,
}) => {
  await openAs(page, 'platform_admin');
  await expect(page.locator('#operations-command-center')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Attention queue' })).toHaveCount(0);

  await openAs(page, 'governance_officer');
  await expect(page.locator('#operations-command-center')).toBeVisible();
  await expect(page.getByText(/Governed case commands are enabled/)).toBeVisible();
  await expect(page.getByText('Governed case commands available')).toBeVisible();
});

test('unverified and changed tenant context never reuses the prior workspace', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Authentication required' })).toBeVisible();
  await expect(page.getByText(/Protected governance data has not been requested/)).toBeVisible();

  await openAs(page, 'operator', TENANT_A, 'Operations tenant A');
  await expect(page.getByText('Operations tenant A')).toBeVisible();
  await openAs(page, 'operator', TENANT_B, 'Operations tenant B');
  await expect(page.getByText('Operations tenant B')).toBeVisible();
  await expect(page.getByText('Operations tenant A')).toHaveCount(0);
  await expect(page.getByRole('alert', { name: '' }).first()).toBeVisible();
});

test('400 percent zoom, forced colors and reduced motion preserve the queue order and controls', async ({
  page,
}) => {
  await openAs(page, 'auditor');
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 1024 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '4';
  });
  const reflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(reflow.scrollWidth, JSON.stringify(reflow)).toBeLessThanOrEqual(reflow.clientWidth + 1);
  await expect(page.getByRole('definition', { name: '' }).first()).toBeVisible();
  await expect(page.getByLabel('Domain')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply filters' })).toBeVisible();
});
