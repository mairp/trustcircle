import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    'x-trustcircle-principal': 'operator-a11y',
    'x-trustcircle-tenant-id': '00000000-0000-4000-8000-000000000001',
    'x-trustcircle-tenant-name': 'Accessibility tenant',
    'x-trustcircle-roles': 'auditor',
  });
  await page.goto('/');
});

test('production route has zero automated WCAG 2.2 AA violations', async ({ page }) => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations).toEqual([]);
});

test('keyboard focus, forced colors, reduced motion and 400 percent reflow retain meaning', async ({
  page,
}) => {
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to operating picture' })).toBeFocused();
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 1024 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '4';
  });
  const reflow = await page.evaluate(() => {
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(reflow.scrollWidth, JSON.stringify(reflow)).toBeLessThanOrEqual(reflow.clientWidth + 1);
  await expect(page.locator('[data-quality]').first()).toContainText(
    /Unavailable|Unknown|Current|Stale|Partial|Degraded/,
  );
});
