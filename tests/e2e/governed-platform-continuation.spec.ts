import { expect, test } from '@playwright/test';

const trustedHeaders = {
  'x-trustcircle-principal': 'governance-continuation-e2e',
  'x-trustcircle-tenant-id': '00000000-0000-4000-8000-000000000001',
  'x-trustcircle-tenant-name': 'Governed continuation tenant',
  'x-trustcircle-roles': 'governance_officer',
};

const stories = [
  {
    route: '/trends',
    title: 'Trends and review changes',
    landmark: '#review-comparison',
    empty: /Signed history is not currently comparable/i,
  },
  {
    route: '/registers',
    title: 'Risk and exception registers',
    landmark: '#governed-register-workspace',
    empty: /No authoritative register rows are available/i,
  },
  {
    route: '/evidence',
    title: 'Evidence lifecycle',
    landmark: '#evidence-assurance-workspace',
    empty: /Restore|Reconcile|Issue|unavailable|not available/i,
  },
  {
    route: '/automation',
    title: 'Monitoring and simulation',
    landmark: '#governed-monitoring-workspace',
    empty: /Restore|Reconcile|unavailable|not available/i,
  },
  {
    route: '/ai-governance',
    title: 'AI governance lifecycle',
    landmark: '#governed-ai-workspace',
    empty: /Restore|Reconcile|Register|unavailable|not available/i,
  },
  {
    route: '/integrations',
    title: 'Integrations and connector kit',
    landmark: '#governed-connector-workspace',
    empty: /No connector certification is visible/i,
  },
] as const;

test.describe('governed platform continuation', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.setExtraHTTPHeaders(trustedHeaders);
  });

  test('authorized roles can reach every primary story workspace', async ({ page }) => {
    for (const story of stories) {
      await page.goto(story.route);
      await expect(page.getByRole('heading', { level: 1, name: story.title })).toBeVisible();
      await expect(page.locator(story.landmark)).toBeVisible();
      await expect(page.locator(story.landmark).locator('.status-group').first()).toContainText(
        /current|partial|unknown|unavailable/i,
      );
    }
  });

  test('unauthorized requests fail closed for every primary story workspace', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const story of stories) {
      await page.goto(story.route);
      await expect(page.getByRole('heading', { name: 'Authentication required' })).toBeVisible();
      await expect(
        page.getByText(/Protected governance data has not been requested/i),
      ).toBeVisible();
      await expect(page.locator(story.landmark)).toHaveCount(0);
    }

    await context.close();
  });

  test('empty and degraded projections remain explicit for every primary story', async ({
    page,
  }) => {
    for (const story of stories) {
      await page.goto(story.route);
      const workspace = page.locator(story.landmark);
      await expect(workspace).toContainText(story.empty);
      await expect(workspace).toContainText(
        /Safe next action|before|not currently|not available|do not infer/i,
      );
    }
  });

  test('cross-cutting governance outcomes stay truthful and bounded', async ({ page }) => {
    await page.goto('/trends');
    await expect(page.locator('#review-comparison')).toContainText('Immutable review history');

    await page.goto('/registers');
    await expect(page.locator('#governed-register-workspace')).toContainText(
      /Sharing a view never broadens record or field authority/i,
    );

    await page.goto('/evidence');
    await expect(page.getByText('Original', { exact: true })).toBeVisible();
    await expect(page.getByText('Verified derivative', { exact: true })).toBeVisible();
    await expect(page.getByText(/Owners attest only exact evidence versions/i)).toBeVisible();

    await page.goto('/automation');
    await expect(page.getByRole('heading', { name: 'Non-mutating impact preview' })).toBeVisible();
    await expect(
      page.getByText(/Missing dependencies, expiry, or drift block publication/i),
    ).toBeVisible();

    await page.goto('/ai-governance');
    await expect(page.getByRole('heading', { name: 'Human authority boundary' })).toBeVisible();
    await expect(page.getByText(/generated assistance cannot become an approval/i)).toBeVisible();

    await page.goto('/integrations');
    await expect(
      page.getByRole('heading', { name: 'Certification authority boundary' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /never treats connector conformance as vendor security or legal certification/i,
      ),
    ).toBeVisible();

    await page.goto('/compliance');
    await expect(
      page.getByRole('heading', { name: 'Framework applicability and assurance matrix' }),
    ).toBeVisible();
    await expect(page.getByText(/does not produce one compliant status/i)).toBeVisible();
    await expect(page.getByText(/Readiness is never certification/i)).toBeVisible();
  });
});
