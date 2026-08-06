// TrustCircleAI — 400% reflow helper (task T005 / GAR-010; WCAG 1.4.10 Reflow).
//
// Emulates a 400% browser zoom by reducing the layout viewport to the equivalent
// 320-CSS-px column and asserts that no two-dimensional (horizontal) scrolling appears.
// The geometry constants come from the root playwright.config.ts (single source of truth —
// compatibility contract VO-ec575c4ce42b548bfb4d).

import { expect, type Page } from '@playwright/test';

import { REFLOW_400 } from '../../../playwright.config.ts';

/**
 * Emulate the CSS layout viewport produced by 400% browser zoom.
 *
 * CSS `zoom` does not update media queries, so it leaves desktop breakpoints active and is
 * not equivalent to browser zoom. The reduced viewport exercises the same 320 CSS-pixel
 * reflow boundary while allowing responsive navigation and grids to react normally.
 */
export async function applyReflowZoom(page: Page): Promise<void> {
  await page.setViewportSize({
    width: REFLOW_400.effectiveCssWidth,
    height: REFLOW_400.viewport.height / REFLOW_400.zoomFactor,
  });
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
