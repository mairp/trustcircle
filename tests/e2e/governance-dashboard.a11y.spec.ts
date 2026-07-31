// TrustCircleAI — accessibility (axe-core) journey (task T005 / GAR-010).
//
// Runs under the `accessibility` Playwright project. Loads the governance dashboard and
// asserts zero WCAG 2.2 AA axe-core violations.

import { test } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';

test.describe('governance dashboard — axe-core WCAG 2.2 AA', () => {
  test('home view has no accessibility violations', async ({ page }, testInfo) => {
    await page.goto('/');
    await expectNoAxeViolations(page, testInfo);
  });
});
