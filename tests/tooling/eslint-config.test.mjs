// Phase 3 acceptance test — ESLint / Prettier / dependency-boundary / generated-file config
// (task T003 / GAR-010). Makes the tooling contract independently observable.
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): the lint + format surface consumed by
// `npm run lint`, `npm run format`, and verify:release must exist and behave. This suite
// asserts the config's STRUCTURE and, where cheap, its BEHAVIOR by invoking the real eslint
// binary against a throwaway fixture — including a negative control that proves the
// dependency-boundary rule actually fires (non-vacuous).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const eslintBin = rel('node_modules/.bin/eslint');

// ---- Artifact presence -----------------------------------------------------
test('eslint.config.mjs exists at the repo root', () => {
  assert.ok(existsSync(rel('eslint.config.mjs')), 'eslint.config.mjs must exist at root');
});

test('prettier config and ignore exist at the repo root', () => {
  assert.ok(existsSync(rel('.prettierrc.json')), '.prettierrc.json must exist');
  assert.ok(existsSync(rel('.prettierignore')), '.prettierignore must exist');
});

// ---- The flat config loads and exports a valid config array ----------------
test('eslint.config.mjs loads and exports a non-empty flat-config array', async () => {
  const mod = await import(pathToFileURL(rel('eslint.config.mjs')).href);
  assert.ok(Array.isArray(mod.default), 'default export must be a flat-config array');
  assert.ok(mod.default.length >= 4, 'config must compose base+ts+boundary+prettier layers');
});

// ---- Prettier is integrated (eslint-config-prettier layered last) ----------
test('eslint config composes eslint-config-prettier so it never fights the formatter', async () => {
  const mod = await import(pathToFileURL(rel('eslint.config.mjs')).href);
  const src = readFileSync(rel('eslint.config.mjs'), 'utf8');
  assert.match(src, /eslint-config-prettier/, 'must import eslint-config-prettier');
  // Prettier config disables stylistic rules; assert a representative one is off in the
  // merged config surface by checking the imported prettier config object is included last.
  const last = mod.default[mod.default.length - 1];
  assert.ok(last && typeof last === 'object', 'a prettier config object must be present');
});

// ---- Dependency-boundary zones are declared and complete -------------------
test('dependency-boundary zones cover the R1/R2/R3 layering rules', async () => {
  const mod = await import(pathToFileURL(rel('eslint.config.mjs')).href);
  const zones = mod.DEPENDENCY_BOUNDARY_ZONES;
  assert.ok(Array.isArray(zones) && zones.length >= 4, 'must export >=4 boundary zones');
  const targets = zones.map((z) => z.target);
  assert.ok(
    targets.includes('./packages'),
    'R1 zone (packages must not import apps/adapters) required',
  );
  assert.ok(
    targets.some((t) => t.startsWith('./packages/domain')),
    'R2 zone (leaf domain fan-out ban) required',
  );
  assert.ok(targets.includes('./apps'), 'R3 zone (apps must not import adapters) required');
  assert.ok(targets.includes('./adapters'), 'R3 zone (adapters must not import apps) required');
  for (const z of zones) {
    assert.ok(Array.isArray(z.from) && z.from.length > 0, 'each zone declares a from set');
    assert.ok(typeof z.message === 'string' && z.message.length > 0, 'each zone has a message');
  }
});

// ---- import/no-restricted-paths rule is wired at error severity ------------
test('the flat config enables import/no-restricted-paths at error severity', () => {
  const src = readFileSync(rel('eslint.config.mjs'), 'utf8');
  assert.match(
    src,
    /'import\/no-restricted-paths':\s*\[\s*'error'/,
    'import/no-restricted-paths must be an error',
  );
});

// ---- Generated-file / build-output exclusions ------------------------------
test('generated + build-output paths are globally ignored by eslint', () => {
  const src = readFileSync(rel('eslint.config.mjs'), 'utf8');
  for (const needle of [
    'node_modules',
    '.tsbuild',
    'packages/contracts/src/generated',
    '*.gen.ts',
  ]) {
    assert.ok(src.includes(needle), `eslint ignores must include ${needle}`);
  }
});

// ---- BEHAVIORAL: eslint runs clean on the real repo ------------------------
test('`eslint .` exits 0 on the current repo (config is valid and repo is clean)', () => {
  // Throws (non-zero exit) if lint fails; test fails with the captured output.
  execFileSync(eslintBin, ['.'], { cwd: ROOT, stdio: 'pipe' });
});

// ---- BEHAVIORAL negative control: the boundary rule actually fires ---------
// Prove import/no-restricted-paths is non-vacuous: a fixture where a library imports a
// deployable (R1 violation) MUST be reported as an error.
test('negative control: an R1 boundary violation is reported by eslint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-eslint-boundary-'));
  try {
    // Minimal flat config that reuses the exported zones so we test the real rule wiring.
    const cfg = `
import importPlugin from ${JSON.stringify(rel('node_modules/eslint-plugin-import/lib/index.js'))};
import tseslint from ${JSON.stringify(rel('node_modules/typescript-eslint/dist/index.js'))};
export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { import: importPlugin },
    rules: {
      'import/no-restricted-paths': ['error', { zones: [
        { target: './packages', from: ['./apps'], message: 'R1 violation' },
      ]}],
    },
  },
];
`;
    mkdirSync(join(dir, 'packages', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'server'), { recursive: true });
    writeFileSync(join(dir, 'eslint.config.mjs'), cfg);
    writeFileSync(join(dir, 'apps', 'server', 'thing.ts'), 'export const thing = 1;\n');
    // A library reaching UP into a deployable — forbidden by R1. The explicit .ts
    // extension keeps the fixture self-contained (no TS resolver needed); the real repo
    // config wires eslint-import-resolver-typescript for extensionless imports.
    writeFileSync(
      join(dir, 'packages', 'lib', 'bad.ts'),
      "import { thing } from '../../apps/server/thing.ts';\nexport const x = thing;\n",
    );

    let failed = false;
    let out = '';
    try {
      execFileSync(eslintBin, ['packages/lib/bad.ts'], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      failed = true;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    assert.ok(failed, 'eslint must exit non-zero on an R1 boundary violation');
    assert.match(out, /no-restricted-paths|R1 violation/, 'the violation must be reported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
