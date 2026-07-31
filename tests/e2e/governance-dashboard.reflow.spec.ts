// TrustCircleAI — 400% reflow journey (task T005 / GAR-010; WCAG 1.4.10 Reflow).
//
// Runs under the `reflow-400` Playwright project (1280×1024 layout viewport). Applies 400%
// zoom (→ 320 CSS px column) and asserts no two-dimensional/horizontal scrolling appears.

import { test } from '@playwright/test';

import { expectNoTwoDimensionalScroll } from './support/reflow.ts';

test.describe('governance dashboard — 400% reflow (WCAG 1.4.10)', () => {
  test('content reflows into the 320px column without horizontal scroll', async ({ page }) => {
    await page.goto('/');
    await expectNoTwoDimensionalScroll(page);
  });
});
