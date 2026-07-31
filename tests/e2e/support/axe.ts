// TrustCircleAI — axe-core scan helper (task T005 / GAR-010).
//
// Wraps @axe-core/playwright so every accessibility spec runs the SAME WCAG 2.2 AA tag set.
// The tag set is imported from the root playwright.config.ts so the config and the scanner
// share exactly one definition (compatibility contract — VO-ec575c4ce42b548bfb4d).

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

import { AXE_WCAG_TAGS } from '../../../playwright.config.ts';

/**
 * Run an axe-core scan against the current page state and assert zero violations against the
 * WCAG 2.2 AA tag set. Attaches the full violation report to the test for triage.
 */
export async function expectNoAxeViolations(page: Page, testInfo: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();

  await testInfo.attach('axe-scan.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  expect(
    results.violations,
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
  ).toEqual([]);
}
