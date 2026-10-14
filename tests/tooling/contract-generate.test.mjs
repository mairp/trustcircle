/**
 * Tooling acceptance for the contract type-generation command (T010 / GAR-010).
 *
 * Runs the REAL CLI (`node packages/contracts/scripts/generate.ts`) as a
 * black box and asserts its compatibility-governed behavior (VO-ec575c4c):
 *
 *   - `--check` exits 0 when the committed generated surface matches the
 *     current source contracts;
 *   - a round-trip `generate` then `--check` is stable (idempotent);
 *   - `--check` exits NON-ZERO (blocks) when a generated module drifts from
 *     what the sources produce — the deprecation/notice guard for consumers;
 *   - restoring the module returns `--check` to 0 (non-vacuous).
 *
 * Node built-ins only, so it runs deterministically under `npm ci` in the PR
 * validation gate (`test:tooling`).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(REPO_ROOT, 'packages', 'contracts', 'scripts', 'generate.ts');
const GEN_DIR = join(REPO_ROOT, 'packages', 'contracts', 'src', 'generated');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts', 'governance-control-plane');

/** Run the generator CLI; returns {status, stdout, stderr}. Never throws on exit code. */
function runCli(args) {
  try {
    const stdout = execFileSync('node', ['--experimental-strip-types', SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

test('artifact + generated surface exist on disk', () => {
  assert.ok(existsSync(SCRIPT), 'generate.ts present');
  for (const f of [
    'index.ts',
    'governance-api.ts',
    'governance-events.ts',
    'evidence-envelope.ts',
  ]) {
    assert.ok(existsSync(join(GEN_DIR, f)), `generated ${f} present`);
  }
});

test('all five canonical source contracts are present to generate from', () => {
  for (const f of [
    'governance-api.openapi.yaml',
    'adapter-protocol.openapi.yaml',
    'governance-events.asyncapi.yaml',
    'evidence-envelope.schema.json',
    'adapter-manifest.schema.json',
  ]) {
    assert.ok(existsSync(join(CONTRACTS_DIR, f)), `source ${f} present`);
  }
});

test('--check exits 0 when committed output matches sources', () => {
  const r = runCli(['--check']);
  assert.equal(r.status, 0, `--check should pass\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /contracts:check OK/);
});

test('generate is idempotent: re-run leaves --check green (byte-stable)', () => {
  const before = snapshotGenerated();
  const gen = runCli([]);
  assert.equal(gen.status, 0, `generate should succeed\nstderr: ${gen.stderr}`);
  const after = snapshotGenerated();
  assert.deepEqual(after, before, 'regeneration must be byte-identical for unchanged sources');
  assert.equal(runCli(['--check']).status, 0);
});

test('NEGATIVE CONTROL: drift in a generated module makes --check block (exit 1), restore → 0', () => {
  const target = join(GEN_DIR, 'governance-api.ts');
  const original = readFileSync(target, 'utf8');
  try {
    writeFileSync(target, original + '\nexport type ConsumerBreakingSneak = never;\n', 'utf8');
    const drifted = runCli(['--check']);
    assert.equal(drifted.status, 1, '--check must fail on drift');
    assert.match(drifted.stderr, /out of date|drifted/);
  } finally {
    writeFileSync(target, original, 'utf8');
  }
  assert.equal(runCli(['--check']).status, 0, '--check must be green again after restore');
});

test('NEGATIVE CONTROL: a source-contract change unreconciled with output blocks --check', () => {
  // Regenerate first so disk is clean, then tamper a generated header digest to
  // simulate a source change that was not regenerated. Restore afterwards.
  const target = join(GEN_DIR, 'evidence-envelope.ts');
  const original = readFileSync(target, 'utf8');
  try {
    const tampered = original.replace(
      /Source sha256\s+: [0-9a-f]{64}/,
      'Source sha256   : ' + '0'.repeat(64),
    );
    assert.notEqual(tampered, original, 'header digest line present to tamper');
    writeFileSync(target, tampered, 'utf8');
    assert.equal(runCli(['--check']).status, 1, 'stale provenance must block');
  } finally {
    writeFileSync(target, original, 'utf8');
  }
  assert.equal(runCli(['--check']).status, 0);
});

function snapshotGenerated() {
  const out = {};
  for (const f of [
    'index.ts',
    'governance-api.ts',
    'adapter-protocol.ts',
    'governance-events.ts',
    'evidence-envelope.ts',
    'adapter-manifest.ts',
  ]) {
    out[f] = readFileSync(join(GEN_DIR, f), 'utf8');
  }
  return out;
}
