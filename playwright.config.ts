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

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Resolve an installed full-Chromium executable for the hermetic current-state accessibility
 * project. Playwright pins an exact browser build; when the network-restricted host only has a
 * slightly older `chromium-<rev>` cached, `npx playwright install` cannot fetch the pinned
 * revision. Rather than fail the WCAG gate for an infrastructure reason, this locates ANY
 * installed full-Chromium `chrome` binary (chromium-<rev>/chrome-linux64/chrome) under the
 * Playwright browsers cache and pins it via `launchOptions.executablePath`. Returns undefined
 * when nothing is cached (CI with the
 * pinned build present), so Playwright's own resolution is used unchanged there.
 * `TC_CHROME_PATH` overrides everything for bespoke CI images.
 */
function resolveInstalledChromium(): string | undefined {
  const explicit = process.env.TC_CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return undefined;
  }
  // Prefer the highest-revision full chromium build available.
  const builds = entries
    .filter((e) => /^chromium-\d+$/.test(e))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    const exe = join(cacheRoot, build, 'chrome-linux64', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const INSTALLED_CHROMIUM = resolveInstalledChromium();

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

/**
 * The browserless open-boundary DISCOVERY project (Phase 58 / discovery-open-boundary.spec.ts).
 *
 * The four WCAG capability projects above drive a real browser against apps/web. The discovery
 * open-boundary journeys, by contrast, exercise the SENSING edge of the platform — the governed
 * source-discovery agent's open-ended catalog, reconciled inventory, coverage gaps, stale/rename/
 * disappearance handling, unsupported-source visibility, and explicit scan gaps — as PURE domain
 * logic (`apps/discovery-agent/src/main.ts`) with fully injected, deterministic collaborators. No
 * `page`, no browser, no web server: a `discovery-*.spec.ts` test never opens a browser context,
 * so it runs on any host under `playwright test --project=discovery` even where a browser binary /
 * the apps/web preview server is absent. Kept as its own project (not a WCAG capability project)
 * so it neither depends on `setup` nor triggers the browser device profile, and so the WCAG
 * project contract (PLAYWRIGHT_PROJECT_NAMES) is unchanged and non-breaking.
 */
export const DISCOVERY_PROJECT_NAME = 'discovery' as const;

/**
 * The self-contained CURRENT-STATE ACCESSIBILITY project (Phase 61 /
 * tests/accessibility/current-state.spec.ts).
 *
 * The four WCAG capability projects above drive a real browser against the apps/web preview
 * server. This project instead drives a real browser (Desktop Chrome) against a HERMETIC,
 * in-page render of the officer's current-state views — the reconciled inventory, coverage
 * gaps, cross-source drill-down, staleness/last-known markers, the open-ended source catalog,
 * and governed-source gaps — mounted with `page.setContent(...)` from a deterministic fixture
 * (tests/accessibility/support/current-state-view.ts). Because the DOM is injected in-page,
 * the spec needs NO web server, NO tenant-auth `setup`, and NO apps/web source to exist yet:
 * it runs anywhere a browser binary is present, under `TC_NO_WEBSERVER=1`.
 *
 * It pins the 400%-reflow layout viewport (REFLOW_400.viewport) so the same journey can assert
 * WCAG 1.4.10 reflow alongside keyboard, screen-reader (name/role/state + live regions),
 * non-color, and table-alternative behavior for current-state views. Kept as its OWN project
 * (not one of the four contract names, and with no `setup` dependency) so the supported
 * PLAYWRIGHT_PROJECT_NAMES surface is unchanged and non-breaking — exactly as the browserless
 * discovery project is kept separate.
 */
export const ACCESSIBILITY_CURRENT_STATE_PROJECT_NAME = 'accessibility-current-state' as const;

/**
 * `playwright test` starts the apps/web preview server (see `webServer` below) so the WCAG
 * journeys have a target. The browserless discovery suite needs no server; setting
 * `TC_NO_WEBSERVER=1` (which the `test:e2e:discovery` script does) omits the `webServer` block
 * entirely so the discovery project runs hermetically with zero external processes.
 */
const WEBSERVER_DISABLED = process.env.TC_NO_WEBSERVER === '1';

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

    // (5) Open-boundary DISCOVERY — browserless pure-logic journeys over the governed
    // source-discovery agent. No `setup` dependency, no browser device profile, no web server:
    // a discovery-*.spec.ts test never touches `page`, so it runs anywhere.
    {
      name: DISCOVERY_PROJECT_NAME,
      testMatch: /discovery-.*\.spec\.ts/,
    },

    // (6) CURRENT-STATE ACCESSIBILITY — hermetic, browser-driven WCAG 2.2 AA verification of
    // the officer's current-state views (keyboard, screen-reader, non-color, table-alternative,
    // 400% reflow) mounted in-page via setContent. Own testDir, own device+viewport, no `setup`
    // dependency, no web server: runs anywhere a browser is present under TC_NO_WEBSERVER=1.
    {
      name: ACCESSIBILITY_CURRENT_STATE_PROJECT_NAME,
      testDir: './tests/accessibility',
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // Pin the 400%-reflow layout viewport so the reflow assertions collapse to the
        // WCAG 1.4.10 320-CSS-px column when zoomed 4×.
        viewport: REFLOW_400.viewport,
        deviceScaleFactor: 1,
        // Use a full (non-headless-shell) Chromium so `zoom`/reflow and the full a11y tree
        // behave like a real browser, and fall back to any installed build on hosts that
        // cannot download Playwright's exact pinned revision.
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },
  ],

  // Only started when `playwright test` runs (never on import). Serves the built web app for the
  // WCAG capability projects. Omitted when TC_NO_WEBSERVER=1 so the browserless discovery suite
  // runs with zero external processes.
  ...(WEBSERVER_DISABLED
    ? {}
    : {
        webServer: {
          command: 'npm run --workspace @trustcircle/web preview',
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
