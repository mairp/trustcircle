import { expect, test } from '@playwright/test';

import { expectNoTwoDimensionalScroll } from '../e2e/support/reflow.ts';

const trustedHeaders = {
  'x-trustcircle-principal': 'governance-continuation-a11y',
  'x-trustcircle-tenant-id': '00000000-0000-4000-8000-000000000001',
  'x-trustcircle-tenant-name': 'Governed continuation accessibility tenant',
  'x-trustcircle-roles': 'governance_officer',
};

const routes = [
  { route: '/trends', title: 'Trends and review changes', landmark: '#review-comparison' },
  {
    route: '/registers',
    title: 'Risk and exception registers',
    landmark: '#governed-register-workspace',
  },
  { route: '/evidence', title: 'Evidence lifecycle', landmark: '#evidence-assurance-workspace' },
  {
    route: '/automation',
    title: 'Monitoring and simulation',
    landmark: '#governed-monitoring-workspace',
  },
  {
    route: '/ai-governance',
    title: 'AI governance lifecycle',
    landmark: '#governed-ai-workspace',
  },
  {
    route: '/integrations',
    title: 'Integrations and connector kit',
    landmark: '#governed-connector-workspace',
  },
  {
    route: '/compliance',
    title: 'Compliance coverage',
    landmark: '.framework-matrix-workspace',
  },
] as const;

test.describe('governed platform continuation accessibility', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.setExtraHTTPHeaders(trustedHeaders);
  });

  test('keyboard focus, meaningful names, textual status, and non-color meaning remain available', async ({
    page,
  }) => {
    await page.goto('/compliance');

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to operating picture' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Compliance coverage' }),
    ).toBeVisible();
    const matrix = page.getByRole('region', {
      name: 'Framework applicability and assurance matrix',
    });
    await expect(matrix).toBeVisible();
    await expect(matrix.locator('.status-group')).toContainText(
      /current|partial|unknown|unavailable/i,
    );
    await expect(matrix.getByRole('status')).not.toBeEmpty();
    await expect(matrix).toContainText(/Applicability, duty, mapping, control coverage/i);
    await expect(matrix).toContainText(/Readiness is never certification/i);
  });

  test('all continuation workspaces fit a 390 CSS-pixel viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    for (const item of routes) {
      await page.goto(item.route);
      await expect(page.getByRole('heading', { level: 1, name: item.title })).toBeVisible();
      await expect(page.locator(item.landmark)).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(
        dimensions.scrollWidth,
        item.route + ': ' + JSON.stringify(dimensions),
      ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    }
  });

  test('all continuation workspaces reflow at the 400-percent zoom equivalent', async ({
    page,
  }) => {
    for (const item of routes) {
      await page.goto(item.route);
      await expect(page.locator(item.landmark)).toBeVisible();
      await expectNoTwoDimensionalScroll(page);
    }
  });

  test('forced colors and reduced motion preserve status and safety boundaries', async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.goto('/integrations');

    const status = page.locator('#governed-connector-workspace .status-group').first();
    await expect(status).toContainText(/current|partial|unknown|unavailable/i);
    const styles = await status.evaluate((element) => {
      const statusStyle = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        borderStyle: statusStyle.borderStyle,
        forcedColorAdjust: statusStyle.forcedColorAdjust,
        transitionDuration: statusStyle.transitionDuration,
        animationDuration: statusStyle.animationDuration,
        scrollBehavior: rootStyle.scrollBehavior,
      };
    });

    expect(styles.borderStyle).not.toBe('none');
    expect(styles.forcedColorAdjust).toBe('none');
    expect(['0s', '0.00001s', '0.01ms', '1e-05s']).toContain(styles.transitionDuration);
    expect(['0s', '0.00001s', '0.01ms', '1e-05s']).toContain(styles.animationDuration);
    expect(styles.scrollBehavior).toBe('auto');
    await expect(
      page.getByText(/Draft or conformance state is not activation authority/i),
    ).toBeVisible();
    await expect(page.getByText(/do not infer healthy operation/i)).toBeVisible();
  });
});
