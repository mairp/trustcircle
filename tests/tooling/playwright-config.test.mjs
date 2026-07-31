// Phase 5 acceptance test — Playwright configuration contract (task T005 / GAR-010 /
// VO-ec575c4ce42b548bfb4d). Makes the browser-verification project surface (axe-core scans,
// keyboard journeys, 400% reflow) independently observable WITHOUT downloading a browser.
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): the Playwright project NAMES, the axe WCAG
// tag set, and the 400%-reflow geometry are a supported consumer surface. The root
// package.json exposes `test:e2e` (= `playwright test`) and `test:accessibility`
// (= `playwright test --project=accessibility`). Renaming/removing a project, or weakening
// the axe tag set / reflow width, silently breaks those consumers and the WCAG obligation —
// which GAR-010 forbids. This suite imports the config module and asserts the contract, and
// also asserts every capability spec/helper the config globs actually exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));

// ---- Artifact presence -----------------------------------------------------
test('playwright.config.ts exists at the repo root (T005 required artifact)', () => {
  assert.ok(existsSync(rel('playwright.config.ts')), 'playwright.config.ts must exist');
});

// ---- Exported contract (imported, not just text-matched) -------------------
test('config exports the four required project names', async () => {
  const mod = await import(pathToFileURL(rel('playwright.config.ts')).href);
  assert.ok(
    Array.isArray(mod.PLAYWRIGHT_PROJECT_NAMES),
    'PLAYWRIGHT_PROJECT_NAMES must be an array',
  );
  for (const name of ['setup', 'accessibility', 'keyboard', 'reflow-400']) {
    assert.ok(
      mod.PLAYWRIGHT_PROJECT_NAMES.includes(name),
      `required Playwright project "${name}" must be declared`,
    );
  }
});

test('the default export declares matching projects with dependency wiring', async () => {
  const mod = await import(pathToFileURL(rel('playwright.config.ts')).href);
  const config = mod.default;
  const names = config.projects.map((p) => p.name);
  for (const name of mod.PLAYWRIGHT_PROJECT_NAMES) {
    assert.ok(names.includes(name), `default export must define project "${name}"`);
  }
  // Capability projects must depend on setup so tenant context exists first.
  for (const cap of ['accessibility', 'keyboard', 'reflow-400']) {
    const proj = config.projects.find((p) => p.name === cap);
    assert.ok(proj.dependencies?.includes('setup'), `${cap} must depend on setup`);
  }
});

// ---- axe-core scan contract: WCAG 2.2 AA tag set ---------------------------
test('axe-core scans assert the WCAG 2.2 AA tag set', async () => {
  const mod = await import(pathToFileURL(rel('playwright.config.ts')).href);
  for (const tag of ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']) {
    assert.ok(mod.AXE_WCAG_TAGS.includes(tag), `axe tag set must include ${tag}`);
  }
});

// ---- 400% reflow geometry: 1280 / 4 == 320 CSS px (WCAG 1.4.10) ------------
test('400% reflow collapses to the WCAG 1.4.10 320 CSS px column', async () => {
  const mod = await import(pathToFileURL(rel('playwright.config.ts')).href);
  const r = mod.REFLOW_400;
  assert.equal(r.zoomFactor, 4, 'reflow must apply 400% (4x) zoom');
  assert.equal(
    r.viewport.width / r.zoomFactor,
    r.effectiveCssWidth,
    'effective width must equal layoutWidth / zoom',
  );
  assert.equal(
    r.effectiveCssWidth,
    r.wcagTargetCssWidth,
    'effective CSS width after 400% zoom must equal the WCAG 1.4.10 target of 320',
  );
  assert.equal(r.wcagTargetCssWidth, 320);
});

// ---- Capability specs + helpers the config globs must exist ----------------
test('each capability project has at least one real spec + helper on disk', () => {
  const required = [
    'tests/e2e/auth.setup.ts',
    'tests/e2e/governance-dashboard.a11y.spec.ts',
    'tests/e2e/governance-dashboard.keyboard.spec.ts',
    'tests/e2e/governance-dashboard.reflow.spec.ts',
    'tests/e2e/support/axe.ts',
    'tests/e2e/support/keyboard.ts',
    'tests/e2e/support/reflow.ts',
  ];
  for (const p of required) {
    assert.ok(existsSync(rel(p)), `${p} must exist so the Playwright glob is non-vacuous`);
  }
});

// ---- Script ↔ project compatibility contract -------------------------------
test('package scripts resolve to declared Playwright projects', async () => {
  const mod = await import(pathToFileURL(rel('playwright.config.ts')).href);
  assert.equal(pkg.scripts['test:e2e'], 'playwright test', 'test:e2e must run the full estate');
  // test:accessibility must target a project that actually exists.
  const m = /--project=([\w-]+)/.exec(pkg.scripts['test:accessibility'] ?? '');
  assert.ok(m, 'test:accessibility must pin a --project');
  assert.ok(
    mod.PLAYWRIGHT_PROJECT_NAMES.includes(m[1]),
    `test:accessibility targets undeclared project "${m?.[1]}"`,
  );
});

// ---- Devtool declaration ----------------------------------------------------
test('@playwright/test and @axe-core/playwright are declared devDependencies', () => {
  assert.ok(pkg.devDependencies['@playwright/test'], '@playwright/test must be a devDependency');
  assert.ok(
    pkg.devDependencies['@axe-core/playwright'],
    '@axe-core/playwright must be a devDependency',
  );
});
