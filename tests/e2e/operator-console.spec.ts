import { expect, test } from '@playwright/test';

const trustedHeaders = {
  'x-trustcircle-principal': 'operator-e2e',
  'x-trustcircle-tenant-id': '00000000-0000-4000-8000-000000000001',
  'x-trustcircle-tenant-name': 'E2E tenant',
  'x-trustcircle-roles': 'operator',
};

test('root is semantic HTML and remains fail-visible when API is unavailable', async ({ page }) => {
  await page.setExtraHTTPHeaders(trustedHeaders);
  const response = await page.goto('/');
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page).toHaveTitle('TrustCircle operator console');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Governance operating picture',
  );
  await expect(page.getByText('E2E tenant')).toBeVisible();
  await expect(page.locator('[data-quality="unavailable"]').first()).toBeVisible();
  await expect(page.getByText(/certification/i).last()).toBeVisible();
  expect(await page.locator('form').count()).toBe(0);
});

test('unverified identity fails closed without protected requests', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.getByRole('heading', { name: 'Authentication required' })).toBeVisible();
  await expect(page.getByText(/Protected governance data has not been requested/)).toBeVisible();
});

test('health is independent and readiness is fail-visible', async ({ request }) => {
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ service: 'web', authority: 'none' });
  const readiness = await request.get('/readiness');
  expect(readiness.status()).toBe(503);
  expect(await readiness.json()).toMatchObject({
    service: 'web',
    authority: 'none',
    status: 'unavailable',
  });
});

test('server-rendered truth survives JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    extraHTTPHeaders: trustedHeaders,
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[data-quality="unavailable"]').first()).toBeVisible();
  await context.close();
});
