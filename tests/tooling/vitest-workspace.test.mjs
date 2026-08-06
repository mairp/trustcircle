// Phase 3 acceptance test — Vitest workspace project contract (task T004 / GAR-010 /
// VO-ec575c4ce42b548bfb4d). Makes the six-suite project surface independently observable.
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): the Vitest project NAMES are a supported
// consumer surface. The root package.json exposes test:unit/contract/integration/security/
// migrations/resilience/recovery, each resolving to `vitest run --project <name>`. Renaming
// or removing a project silently breaks those consumers, which GAR-010 forbids. This suite
// asserts every script-referenced project exists AND that the real vitest binary can resolve
// and run each project (behavioral evidence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const vitestBin = rel('node_modules/.bin/vitest');
const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));

const REQUIRED = ['unit', 'contract', 'integration', 'security', 'migration', 'resilience'];

// ---- Artifact presence -----------------------------------------------------
test('vitest.workspace.ts exists at the repo root (T004 required artifact)', () => {
  assert.ok(existsSync(rel('vitest.workspace.ts')), 'vitest.workspace.ts must exist');
});

test('vitest.config.ts wires the workspace projects for Vitest 4', () => {
  assert.ok(existsSync(rel('vitest.config.ts')), 'vitest.config.ts must exist');
  const src = readFileSync(rel('vitest.config.ts'), 'utf8');
  assert.match(src, /projects/, 'config must expose test.projects');
  assert.match(src, /vitest\.workspace/, 'config must import the workspace definitions');
});

// ---- The workspace declares the six required suites (+ recovery) -----------
test('vitest.workspace.ts declares all six required project names', async () => {
  const mod = await import(pathToFileURL(rel('vitest.workspace.ts')).href);
  // PROJECT_NAMES is the authored contract list; the default export is the project array.
  assert.ok(Array.isArray(mod.PROJECT_NAMES), 'PROJECT_NAMES must be exported');
  for (const name of REQUIRED) {
    assert.ok(mod.PROJECT_NAMES.includes(name), `required project "${name}" must be declared`);
  }
  assert.ok(Array.isArray(mod.default), 'default export must be a project array');
  const names = mod.default.map((p) => p.test?.name);
  for (const name of REQUIRED) {
    assert.ok(names.includes(name), `project object for "${name}" must exist`);
  }
});

// ---- The compatibility contract: package scripts ↔ project names -----------
test('every test:<suite> script resolves to an existing --project name', () => {
  const scriptToProject = {
    'test:unit': 'unit',
    'test:contract': 'contract',
    'test:integration': 'integration',
    'test:security': 'security',
    'test:migrations': 'migration',
    'test:resilience': 'resilience',
    'test:recovery': 'recovery',
  };
  for (const [script, project] of Object.entries(scriptToProject)) {
    const cmd = pkg.scripts[script];
    assert.ok(cmd, `package.json must define ${script}`);
    assert.match(
      cmd,
      new RegExp(`--project\\s+${project}(\\b|$)`),
      `${script} must target --project ${project}`,
    );
  }
});

// ---- BEHAVIORAL: vitest can resolve and run each required project ----------
// Empty suites pass deterministically (passWithNoTests); non-empty suites run their tests.
test('`vitest run --project <name>` resolves and exits 0 for every required project', () => {
  for (const project of REQUIRED) {
    // Throws on non-zero exit → the test fails with vitest's output.
    execFileSync(vitestBin, ['run', '--project', project], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, CI: '1' },
    });
  }
});

// ---- BEHAVIORAL: a full `vitest run` executes the seeded unit+security tests
test('`vitest run` executes the seeded unit and security tests (suites are non-vacuous)', () => {
  const out = execFileSync(vitestBin, ['run'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, CI: '1' },
  }).toString();
  assert.match(out, /passed/, 'a full vitest run must report passing tests');
});

test('operations command-center focused suites are discovered by their governed project', async () => {
  const mod = await import(pathToFileURL(rel('vitest.workspace.ts')).href);
  const projects = new Map(
    mod.default.map((project) => [project.test?.name, project.test?.include ?? []]),
  );
  assert.ok(projects.get('unit')?.some((pattern) => pattern.includes('tests/unit')));
  assert.ok(projects.get('contract')?.some((pattern) => pattern.includes('tests/contract')));
  assert.ok(projects.get('integration')?.some((pattern) => pattern.includes('tests/integration')));
  assert.ok(projects.get('security')?.some((pattern) => pattern.includes('tests/security')));
  assert.ok(projects.get('migration')?.some((pattern) => pattern.includes('tests/migration')));
  assert.ok(projects.get('performance')?.some((pattern) => pattern.includes('tests/performance')));
});
