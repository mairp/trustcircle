// TrustCircleAI — 400% reflow helper (task T005 / GAR-010; WCAG 1.4.10 Reflow).
//
// Applies a 400% zoom to the document and asserts that content reflows into the
// 320-CSS-px column WITHOUT introducing two-dimensional (horizontal) scrolling. The
// geometry constants come from the root playwright.config.ts (single source of truth —
// compatibility contract VO-ec575c4ce42b548bfb4d).

import { expect, type Page } from '@playwright/test';

import { REFLOW_400 } from '../../../playwright.config.ts';

/** Apply the 400% zoom the reflow project relies on. */
export async function applyReflowZoom(page: Page): Promise<void> {
  await page.evaluate((factor) => {
    // `zoom` reflows layout the way browser zoom does; documentElement so it is global.
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom =
      String(factor);
  }, REFLOW_400.zoomFactor);
}

/**
 * Assert WCAG 1.4.10: after zooming to 400%, the page must not require horizontal scrolling
 * (no two-dimensional scroll) — i.e. scrollWidth must not exceed the visible client width.
 */
export async function expectNoTwoDimensionalScroll(page: Page): Promise<void> {
  await applyReflowZoom(page);

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });

  // A small tolerance for sub-pixel rounding; anything larger is a real horizontal scrollbar.
  expect(
    overflow.scrollWidth,
    `content overflows horizontally at 400% zoom (scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}); WCAG 1.4.10 target width is ${REFLOW_400.wcagTargetCssWidth} CSS px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 2);
}
