// Phase 3 acceptance test — Prettier integration & generated-file exclusions (task T003).
//
// Asserts (a) the repo is clean under `prettier --check .`, (b) the prettier ignore mirrors
// the eslint generated-file exclusions, and (c) a negative control proving prettier's check
// actually detects a malformed file (non-vacuous).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const prettierBin = rel('node_modules/.bin/prettier');

// ---- BEHAVIORAL: the repo is clean under prettier --check ------------------
test('`prettier --check .` exits 0 on the current repo', () => {
  execFileSync(prettierBin, ['--check', '.'], { cwd: ROOT, stdio: 'pipe' });
});

// ---- Prettier ignore mirrors the generated-file exclusions -----------------
test('.prettierignore excludes generated + disposable artifacts', () => {
  const ignore = readFileSync(rel('.prettierignore'), 'utf8');
  for (const needle of [
    'node_modules',
    '.tsbuild',
    'packages/contracts/src/generated',
    'package-lock.json',
  ]) {
    assert.ok(ignore.includes(needle), `.prettierignore must exclude ${needle}`);
  }
});

// ---- BEHAVIORAL negative control: prettier detects a malformed file --------
test('negative control: prettier --check flags a mis-formatted file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-prettier-'));
  try {
    // Copy the real prettier config so formatting rules match the repo.
    writeFileSync(join(dir, '.prettierrc.json'), readFileSync(rel('.prettierrc.json')));
    // Deliberately mis-formatted TS (double quotes, no semi, bad spacing).
    writeFileSync(join(dir, 'bad.ts'), 'export const   x="y"\n');
    let failed = false;
    try {
      execFileSync(prettierBin, ['--check', 'bad.ts'], { cwd: dir, stdio: 'pipe' });
    } catch {
      failed = true;
    }
    assert.ok(failed, 'prettier --check must exit non-zero on a mis-formatted file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
