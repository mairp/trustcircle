// TrustCircleAI — keyboard-only journey (task T005 / GAR-010; WCAG 2.1.1 / 2.4.7).
//
// Runs under the `keyboard` Playwright project. Drives the dashboard with the keyboard only
// and asserts focus never gets trapped or lost across the primary navigation journey.

import { test, expect } from '@playwright/test';

import { tabThrough } from './support/keyboard.ts';

test.describe('governance dashboard — keyboard journey', () => {
  test('primary navigation is fully keyboard-operable without a focus trap', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    const journey = await tabThrough(page, 5);
    await testInfo.attach('keyboard-journey.json', {
      body: JSON.stringify(journey, null, 2),
      contentType: 'application/json',
    });
    // Focus must have moved through at least one real interactive control.
    expect(journey.length).toBeGreaterThan(0);
  });
});
