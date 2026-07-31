// TrustCircleAI — root Playwright configuration (task T005 / GAR-010 /
// VO-ec575c4ce42b548bfb4d).
//
// This file is the single source of truth for the browser-driven accessibility, keyboard,
// and reflow verification of apps/web. It declares Playwright *projects* — named,
// independently runnable slices of the end-to-end estate (`playwright test --project
// <name>`) — for the four capabilities the phase requires:
//
//   1. Playwright projects            — accessibility, keyboard, reflow-400 (+ setup) below.
//   2. axe-core scans                 — the `accessibility` project + tests/e2e/axe helpers,
//                                       which run @axe-core/playwright against WCAG 2.2 AA.
//   3. keyboard journeys              — the `keyboard` project drives tab-order / focus /
//                                       activation flows with the keyboard only (no mouse).
//   4. 400% reflow checks             — the `reflow-400` project pins a 1280×1024 layout
//                                       viewport, applies a 4× zoom so content reflows into
//                                       the WCAG 1.4.10 320-CSS-px column, and asserts no
//                                       two-dimensional (horizontal) scrolling appears.
//
// Compatibility contract (VO-ec575c4ce42b548bfb4d): the set of project NAMES here, and the
// device/viewport constants they pin, are a SUPPORTED consumer surface. The root
// package.json exposes `test:e2e` (= `playwright test`) and `test:accessibility`
// (= `playwright test --project=accessibility`). Renaming or removing a project name — or
// weakening the reflow viewport / axe tag set — is a breaking change to those consumers and
// to the WCAG obligation, and is forbidden without deprecation / migration / compatibility
// evidence. `tests/tooling/playwright-config.test.mjs` imports this module and asserts the
// project names, the axe WCAG tag set, the 400%-reflow geometry, and the
// script↔project compatibility, so the contract is mechanically enforced without needing a
// browser download. `PLAYWRIGHT_PROJECT_NAMES`, `AXE_WCAG_TAGS`, and `REFLOW_400` are the
// exported, asserted contract handles.
//
// The config is written so it can be *imported and structurally verified* under `npm ci`
// with no adjacent browser binary. Actually executing the suites (`playwright test`)
// additionally requires `npx playwright install`, which is a CI concern, not an import-time
// one — importing this file never launches a browser.

import { defineConfig, devices } from '@playwright/test';

/**
 * WCAG 2.2 AA success-criteria tag set that every axe-core scan MUST assert against. Kept as
 * an exported constant so the accessibility helper (tests/e2e/support/axe.ts) and the
 * structural test share exactly one definition — the compatibility contract cannot drift
 * between the config and the scanners that consume it.
 */
export const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/**
 * WCAG 1.4.10 Reflow geometry. Content must reflow without loss of information or
 * functionality, and without two-dimensional scrolling, down to an equivalent 320 CSS px
 * width (vertical scrolling content) / 256 CSS px height. We reproduce this by rendering a
 * 1280×1024 CSS viewport at deviceScaleFactor 1 and applying a 4× (=400%) page zoom, which
 * collapses the effective layout width to 1280 / 4 = 320 CSS px — the exact 1.4.10 target.
 */
export const REFLOW_400 = {
  /** Physical viewport the browser is given before zoom is applied. */
  viewport: { width: 1280, height: 1024 },
  /** The zoom factor the reflow helper applies (document.documentElement style zoom / 4×). */
  zoomFactor: 4,
  /** The effective CSS width after 400% zoom; MUST equal the WCAG 1.4.10 target of 320. */
  effectiveCssWidth: 1280 / 4,
  /** The WCAG 1.4.10 minimum equivalent width, in CSS px, that reflow must support. */
  wcagTargetCssWidth: 320,
} as const;

/**
 * Canonical, ordered list of the browser-verification project names. Consumed by the
 * tooling test as the compatibility contract and by the package scripts.
 */
export const PLAYWRIGHT_PROJECT_NAMES = [
  'setup',
  'accessibility',
  'keyboard',
  'reflow-400',
] as const;

export type PlaywrightProjectName = (typeof PLAYWRIGHT_PROJECT_NAMES)[number];

// The web app under test. Overridable for CI/preview deployments; the default is the local
// apps/web dev server. Importing this file never starts the server — `webServer` below is
// only honoured when `playwright test` actually runs.
const BASE_URL = process.env.TC_WEB_BASE_URL ?? 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/e2e',
  // Deterministic, hermetic runs: no accidental `.only`, retries only in CI, fixed workers.
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '.tsbuild/playwright-report' }],
    ['json', { outputFile: '.tsbuild/playwright-results.json' }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // Shared auth/context setup — runs first; every capability project depends on it so
    // tenant-context and CSRF cookies exist before the a11y/keyboard/reflow journeys run.
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },

    // (2) axe-core scans — WCAG 2.2 AA automated accessibility scanning.
    {
      name: 'accessibility',
      testMatch: /.*\.a11y\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] },
    },

    // (3) keyboard journeys — keyboard-only tab/focus/activation flows.
    {
      name: 'keyboard',
      testMatch: /.*\.keyboard\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        // No pointer: journeys must be completable with the keyboard alone.
        hasTouch: false,
      },
    },

    // (4) 400% reflow checks — WCAG 1.4.10; pin the layout viewport that, once zoomed 4×,
    // reflows into the 320-CSS-px column with no horizontal scrolling.
    {
      name: 'reflow-400',
      testMatch: /.*\.reflow\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: REFLOW_400.viewport,
        deviceScaleFactor: 1,
      },
    },
  ],

  // Only started when `playwright test` runs (never on import). Serves the built web app.
  webServer: {
    command: 'npm run --workspace @trustcircle/web preview',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
