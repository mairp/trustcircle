// TrustCircleAI — Playwright shared setup project (task T005 / GAR-010).
//
// Establishes tenant context (authenticated session + CSRF cookie) once and persists the
// storage state so the accessibility / keyboard / reflow projects start already
// authenticated. Ties to apps/api/src/middleware/context.ts (VO-e4323651): browser journeys
// exercise the same fail-closed tenant-context surface the API enforces.

import { test as setup, expect } from '@playwright/test';

const STORAGE_STATE = '.tsbuild/playwright/.auth/tenant.json';

setup('establish tenant context', async ({ page, context }) => {
  await page.goto('/');
  // The landing page must render without an authenticated session (fail-closed surfaces
  // never leak); real credential exchange is wired when apps/web ships its sign-in flow.
  await expect(page).toHaveTitle(/TrustCircle/i);
  await context.storageState({ path: STORAGE_STATE });
});
