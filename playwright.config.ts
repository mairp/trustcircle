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
 * The browserless ECOSYSTEM-HEALTH project (Phase 8 / User Story 6 / ecosystem-health.spec.ts).
 *
 * Like the DISCOVERY project above, this exercises a SENSING/RESILIENCE edge of the platform — the
 * connector ecosystem's outage / bounded-retry / dead-letter / replay / reconciliation / projection-
 * rebuild path and the named-adapter + core-only activation profile — as PURE application/worker
 * logic driven through the signed-manifest scenario runners
 * (`tests/e2e/scenarios/connector-resilience.ts`, `tests/e2e/scenarios/named-adapters.ts`). No
 * `page`, no browser, no web server: an `ecosystem-health.spec.ts` test never opens a browser
 * context, so it runs on any host under `playwright test --project=ecosystem-health` even where a
 * browser binary / the apps/web preview server is absent. Kept as its own project (not a WCAG
 * capability project) so it neither depends on `setup` nor triggers the browser device profile, and
 * so the WCAG project contract (PLAYWRIGHT_PROJECT_NAMES) is unchanged and non-breaking.
 */
export const ECOSYSTEM_HEALTH_PROJECT_NAME = 'ecosystem-health' as const;

/**
 * The browserless AUDIT-TAMPER release gate (Phase 9 / T280 / audit-tamper.spec.ts).
 *
 * Drives the REAL `packages/audit-ledger/src/hash-chain.ts` + `checkpoints.ts` and a deterministic
 * incident/freeze responder to prove that a tamper of the append-only audit ledger (a mutated field,
 * a dropped/reordered record, a truncated checkpoint range) is DETECTED, that detection OPENS a
 * critical incident, and that the incident FREEZES the affected tenant's consequential/destructive
 * actions. No `page`, no browser, no web server: an `audit-tamper.spec.ts` test never opens a browser
 * context, so it runs on any host under `playwright test --project=audit-tamper`. Kept as its own
 * browserless project so it neither depends on `setup` nor triggers the browser device profile, and
 * so the WCAG project contract (PLAYWRIGHT_PROJECT_NAMES) is unchanged and non-breaking.
 */
export const AUDIT_TAMPER_PROJECT_NAME = 'audit-tamper' as const;

/**
 * The browserless EVIDENCE-RETENTION release gate (Phase 9 / T281 / evidence-retention.spec.ts).
 *
 * Drives the REAL `packages/evidence/src/retention.ts` to prove longest-applicable retention, the
 * missing-policy gap surface, active legal-hold enforcement, authorized release, signed disposition,
 * and access-history preservation. No `page`, no browser, no web server, so it runs on any host under
 * `playwright test --project=evidence-retention`. Kept as its own browserless project so it neither
 * depends on `setup` nor triggers the browser device profile, and so the WCAG project contract
 * (PLAYWRIGHT_PROJECT_NAMES) is unchanged and non-breaking.
 */
export const EVIDENCE_RETENTION_PROJECT_NAME = 'evidence-retention' as const;

/**
 * The browserless SCENARIO-SUITE release gate (Phase 9 / T294 / scenario-suite.spec.ts).
 *
 * Drives the REAL signed-result scenario runners in `tests/e2e/scenarios/*` (human decisions, federated
 * joint approval, standards applicability, integrity remediation, destructive rollback boundaries,
 * uncertain-remote-outcome reconciliation, bounded continuity, and controller-operations / role
 * dashboards) as PURE application/domain/policy/authz logic — the hermetic, host-runnable realization
 * of quickstart scenarios 2–8, 10, and the 15-dashboards slice whose full-browser+live-stack rendering
 * cannot run on a Docker-less / Chromium-less host. No `page`, no browser, no web server, so it runs on
 * any host under `playwright test --project=scenario-suite`. Kept as its own browserless project so it
 * neither depends on `setup` nor triggers the browser device profile, and so the WCAG project contract
 * (PLAYWRIGHT_PROJECT_NAMES) is unchanged and non-breaking.
 */
export const SCENARIO_SUITE_PROJECT_NAME = 'scenario-suite' as const;

/**
 * The browserless ACCESSIBILITY FULL-SUITE release gate (Phase 9 / T276 / full-suite.spec.ts).
 *
 * The `accessibility-current-state` project below (and the WCAG capability projects) drive a REAL
 * browser; on a host with no Chromium binary they cannot run. This release-gate project instead
 * asserts the WCAG 2.2 AA obligations (AR-001..AR-008 + SC-014) as PURE checks over the SAME
 * deterministic, dependency-free HTML that the shipped views render
 * (tests/accessibility/support/current-state-view.ts renderCurrentStateView()) — landmark/lang
 * structure, keyboard operability (skip link, focusable controls, min target size), programmatic
 * name/role/state + live regions, non-color meaning, focus-visible styling, 400%-reflow layout
 * rules, an accessible time-limit warning with an extension path, and non-visual chart/table
 * parity — plus a red-witness (deliberately regressed markup) per gate so the oracle is
 * non-vacuous. No `page`, no browser, no web server: a `full-suite.spec.ts` test never opens a
 * browser context, so it runs on any host under `playwright test --project=accessibility-full-suite`.
 * Kept as its OWN project (not one of the four contract names, no `setup` dependency, no browser
 * device) so the supported PLAYWRIGHT_PROJECT_NAMES surface is unchanged and non-breaking — exactly
 * as the browserless discovery / ecosystem-health projects are kept separate.
 */
export const ACCESSIBILITY_FULL_SUITE_PROJECT_NAME = 'accessibility-full-suite' as const;

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
 * The self-contained HUMAN-DECISION project (Phase 4 / User Story 2 / tests/e2e/human-decisions.spec.ts).
 *
 * Like `accessibility-current-state`, this project drives a real browser (Desktop Chrome) against a
 * HERMETIC in-page render — here the accessible decision queue, joint (cross-tenant) status, and
 * emergency-intervention surfaces mounted with `page.setContent(...)` over the fixed decision
 * projection (tests/fixtures/decisions.ts). It asserts queue prioritization, context, textual time
 * warnings, the full/withheld action sets, the three federated-approval gates + no evidence leak, and
 * the emergency stop-only / open-review contract, and scans each with axe-core (WCAG 2.2 AA). Because
 * the DOM is injected in-page it needs NO web server and NO tenant-auth `setup`, so it runs anywhere a
 * browser is present under `TC_NO_WEBSERVER=1`. Kept as its OWN project (not one of the four contract
 * names, no `setup` dependency) so the supported PLAYWRIGHT_PROJECT_NAMES surface is unchanged.
 */
export const HUMAN_DECISIONS_PROJECT_NAME = 'human-decisions' as const;

/**
 * The self-contained INTEGRITY-REMEDIATION project (Phase 5 / User Story 3 /
 * tests/e2e/integrity-remediation.spec.ts).
 *
 * Like `human-decisions`, this project drives a real browser (Desktop Chrome) against a HERMETIC
 * in-page render — here the accessible damaged-work QUEUE, the preserved-original EVIDENCE COMPARISON,
 * and the REMEDIATION DETAIL (bounded-automation gating + verified closure) surfaces mounted with
 * `page.setContent(...)` over the fixed integrity projection (tests/fixtures/integrity.ts). It asserts
 * queue prioritization + ownership honesty, original-intact + quarantine-containment banners, the
 * execute-if-pre-authorized gate, succeeded-is-not-closed, and the independent nine-gate verified
 * closure, and scans each with axe-core (WCAG 2.2 AA). Because the DOM is injected in-page it needs NO
 * web server and NO tenant-auth `setup`, so it runs anywhere a browser is present under
 * `TC_NO_WEBSERVER=1`. Kept as its OWN project (not one of the four contract names, no `setup`
 * dependency) so the supported PLAYWRIGHT_PROJECT_NAMES surface is unchanged and non-breaking.
 */
export const INTEGRITY_REMEDIATION_PROJECT_NAME = 'integrity-remediation' as const;

/**
 * The self-contained CONTROLLER-OPERATIONS project (Phase 6 / User Story 4 /
 * tests/e2e/controller-operations.spec.ts).
 *
 * Like `integrity-remediation`, this project drives a real browser (Desktop Chrome) against a HERMETIC
 * in-page render — here the accessible controller REGISTRY (drift never masked, exact permitted actions),
 * the OPERATION DETAIL (uncertainty ≠ success, awaiting-reconciliation, duplicate-effect, bounded
 * continuity, rollback-protects-newer), and the OPERATION ACTIONS surface (permitted-and-gated buttons,
 * required idempotency key) mounted with `page.setContent(...)` over the fixed controller world
 * (tests/fixtures/controllers.ts). It asserts the honest-control invariants and scans each with axe-core
 * (WCAG 2.2 AA). Because the DOM is injected in-page it needs NO web server and NO tenant-auth `setup`,
 * so it runs anywhere a browser is present under TC_NO_WEBSERVER=1. Kept as its OWN project (not one of
 * the four contract names, no `setup` dependency) so the supported PLAYWRIGHT_PROJECT_NAMES surface is
 * unchanged and non-breaking — exactly as the prior US4/US3/US2 hermetic projects are kept separate.
 */
export const CONTROLLER_OPERATIONS_PROJECT_NAME = 'controller-operations' as const;

/**
 * The self-contained COMPLIANCE-AUDIT-READINESS project (Phase 7 / User Story 5 /
 * tests/e2e/compliance-audit-readiness.spec.ts).
 *
 * Like `controller-operations`, this project drives a real browser (Desktop Chrome) against a HERMETIC
 * in-page render — here the accessible COVERAGE view (truthful design/operating/readiness/assessment/
 * certification boundary, readiness never promoted to certification), the APPLICABILITY REVIEW
 * (independent review, non-applicability expiry + reopened gap), the EVIDENCE EXPLORER (metadata /
 * provenance / custody / retention / hold / integrity without leaking unauthorized bodies), and the
 * AUDITOR TRACE (exact scope + instant reconstruction, ledger checkpoint, signed export manifests, and
 * explicit gaps) mounted with `page.setContent(...)` over the fixed compliance world
 * (tests/fixtures/compliance.ts). It asserts the truthful-claim invariants and scans each with axe-core
 * (WCAG 2.2 AA). Because the DOM is injected in-page it needs NO web server and NO tenant-auth `setup`,
 * so it runs anywhere a browser is present under TC_NO_WEBSERVER=1. Kept as its OWN project (not one of
 * the four contract names, no `setup` dependency) so the supported PLAYWRIGHT_PROJECT_NAMES surface is
 * unchanged and non-breaking — exactly as the prior US4/US3/US2 hermetic projects are kept separate.
 */
export const COMPLIANCE_AUDIT_PROJECT_NAME = 'compliance-audit-readiness' as const;
export const OPERATOR_CONSOLE_PROJECT_NAME = 'operator-console' as const;

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
      use: {
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },

    // (2) axe-core scans — WCAG 2.2 AA automated accessibility scanning.
    {
      name: 'accessibility',
      testDir: './tests',
      testMatch: [
        /e2e\/.*\.a11y\.spec\.ts/,
        /accessibility\/governed-platform-continuation\.spec\.ts/,
      ],
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
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
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
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
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },

    // (5) Open-boundary DISCOVERY — browserless pure-logic journeys over the governed
    // source-discovery agent. No `setup` dependency, no browser device profile, no web server:
    // a discovery-*.spec.ts test never touches `page`, so it runs anywhere.
    {
      name: DISCOVERY_PROJECT_NAME,
      testMatch: /discovery-.*\.spec\.ts/,
    },

    // (5b) ECOSYSTEM HEALTH — browserless pure-logic journeys over the connector-resilience +
    // named-adapter scenario runners (Phase 8 / US6). No `setup` dependency, no browser device
    // profile, no web server: an ecosystem-health.spec.ts test never touches `page`, so it runs
    // anywhere under `playwright test --project=ecosystem-health`.
    {
      name: ECOSYSTEM_HEALTH_PROJECT_NAME,
      testMatch: /ecosystem-health\.spec\.ts/,
    },

    // (5b-i) AUDIT TAMPER — browserless pure-logic proof (Phase 9 / T280) that a tamper of the
    // append-only audit ledger is detected, opens a critical incident, and freezes the affected
    // tenant's consequential/destructive actions. No `setup`, no browser device, no web server.
    {
      name: AUDIT_TAMPER_PROJECT_NAME,
      testMatch: /audit-tamper\.spec\.ts/,
    },

    // (5b-ii) EVIDENCE RETENTION — browserless pure-logic proof (Phase 9 / T281) of longest-policy
    // retention, missing-policy gaps, legal holds, authorized release, signed disposition, and access
    // history preservation over the real retention module. No `setup`, no browser, no web server.
    {
      name: EVIDENCE_RETENTION_PROJECT_NAME,
      testMatch: /evidence-retention\.spec\.ts/,
    },

    // (5b-iii) SCENARIO SUITE — browserless hermetic realization of quickstart scenarios 2–8, 10 and
    // the 15-dashboards slice (Phase 9 / T294), driving the real signed-result scenario runners in
    // tests/e2e/scenarios/*. No `setup`, no browser device, no web server: a scenario-suite.spec.ts
    // test never touches `page`, so it runs anywhere under `playwright test --project=scenario-suite`.
    {
      name: SCENARIO_SUITE_PROJECT_NAME,
      testMatch: /scenario-suite\.spec\.ts/,
    },

    // (5c) ACCESSIBILITY FULL-SUITE — browserless WCAG 2.2 AA release gate (Phase 9 / US-cross /
    // T276). Asserts AR-001..AR-008 + SC-014 as pure checks over the deterministic rendered HTML
    // of the officer's views. No `setup`, no browser device, no web server: a full-suite.spec.ts
    // test never touches `page`, so it runs anywhere under
    // `playwright test --project=accessibility-full-suite`.
    {
      name: ACCESSIBILITY_FULL_SUITE_PROJECT_NAME,
      testDir: './tests/accessibility',
      testMatch: /full-suite\.spec\.ts/,
    },

    // (6) CURRENT-STATE ACCESSIBILITY — hermetic, browser-driven WCAG 2.2 AA verification of
    // the officer's current-state views (keyboard, screen-reader, non-color, table-alternative,
    // 400% reflow) mounted in-page via setContent. Own testDir, own device+viewport, no `setup`
    // dependency, no web server: runs anywhere a browser is present under TC_NO_WEBSERVER=1.
    {
      name: ACCESSIBILITY_CURRENT_STATE_PROJECT_NAME,
      testDir: './tests/accessibility',
      testMatch: /.*\.spec\.ts/,
      // The browserless full-suite release gate (T276) runs under its own no-browser project above;
      // exclude it here so this browser-driven WCAG project never tries to launch Chromium for it.
      testIgnore: [/full-suite\.spec\.ts/, /governed-platform-continuation\.spec\.ts/],
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

    // (7) HUMAN DECISIONS — hermetic, browser-driven WCAG 2.2 AA + behavioral verification of the
    // decision queue / joint status / emergency-intervention surfaces (Phase 4 / US2). Own testMatch,
    // no `setup` dependency, no web server: runs anywhere a browser is present under TC_NO_WEBSERVER=1.
    {
      name: HUMAN_DECISIONS_PROJECT_NAME,
      testMatch: /human-decisions\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },

    // (8) INTEGRITY REMEDIATION — hermetic, browser-driven WCAG 2.2 AA + behavioral verification of the
    // damaged-work queue / evidence comparison / remediation detail surfaces (Phase 5 / US3). Own
    // testMatch, no `setup` dependency, no web server: runs anywhere a browser is present under
    // TC_NO_WEBSERVER=1.
    {
      name: INTEGRITY_REMEDIATION_PROJECT_NAME,
      testMatch: /integrity-remediation\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },

    // (9) CONTROLLER OPERATIONS — hermetic, browser-driven WCAG 2.2 AA + behavioral verification of the
    // controller registry / operation detail / operation actions surfaces (Phase 6 / US4). Own testMatch,
    // no `setup` dependency, no web server: runs anywhere a browser is present under TC_NO_WEBSERVER=1.
    {
      name: CONTROLLER_OPERATIONS_PROJECT_NAME,
      testMatch: /controller-operations\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },

    // (10) COMPLIANCE AUDIT READINESS — hermetic, browser-driven WCAG 2.2 AA + behavioral verification of
    // the coverage / applicability-review / evidence-explorer / auditor-trace surfaces (Phase 7 / US5). Own
    // testMatch, no `setup` dependency, no web server: runs anywhere a browser is present under
    // TC_NO_WEBSERVER=1.
    {
      name: COMPLIANCE_AUDIT_PROJECT_NAME,
      testMatch: /compliance-audit-readiness\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ...(INSTALLED_CHROMIUM ? { launchOptions: { executablePath: INSTALLED_CHROMIUM } } : {}),
      },
    },
    {
      name: OPERATOR_CONSOLE_PROJECT_NAME,
      testDir: './tests',
      testMatch: [
        /e2e\/operator-console.*\.spec\.ts/,
        /e2e\/operations-command-center\.spec\.ts/,
        /e2e\/governed-platform-continuation\.spec\.ts/,
        /accessibility\/operator-console\.spec\.ts/,
      ],
      use: {
        ...devices['Desktop Chrome'],
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
