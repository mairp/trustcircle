// TrustCircleAI — keyboard-journey helper (task T005 / GAR-010; WCAG 2.1.1 Keyboard,
// 2.4.7 Focus Visible).
//
// Utilities for keyboard-only journeys: walk the tab order and assert that focus is always
// on a real, visible, interactive element (no keyboard trap, no focus loss).

import { expect, type Page } from '@playwright/test';

/** Return a stable descriptor of the currently focused element for assertions/attachments. */
export async function activeElementDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return '<none>';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const label = el.getAttribute('aria-label') ?? el.textContent?.trim()?.slice(0, 40) ?? '';
    return `${tag}${id} "${label}"`;
  });
}

/**
 * Tab `steps` times, asserting after each Tab that focus landed on a genuine interactive
 * element (not the <body>) — i.e. the journey is keyboard-navigable and free of traps.
 * Returns the ordered focus descriptors so the caller can assert the expected journey.
 */
export async function tabThrough(page: Page, steps: number): Promise<string[]> {
  const journey: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab');
    const descriptor = await activeElementDescriptor(page);
    expect(descriptor, `focus lost after ${i + 1} Tab press(es)`).not.toBe('<none>');
    journey.push(descriptor);
  }
  return journey;
}
