/**
 * Tooling acceptance for the contract-validation command (T011 / GAR-010).
 *
 * Runs the REAL CLI (`node packages/contracts/scripts/validate.ts`) as a black
 * box and asserts its three compatibility-governed legs (VO-ec575c4ce42b548bfb4d):
 *
 *   A. STRUCTURAL CONTRACT VALIDATION — passes on the clean tree; a dangling
 *      local `$ref` (a broken export) makes it BLOCK (exit 1).
 *   B. UNRESOLVED-PLACEHOLDER REJECTION — an injected `<REPLACE_ME>` / TODO
 *      placeholder makes it BLOCK; RFC 2606 `.invalid` hosts already present in
 *      the contracts do NOT trip it (proven by the clean-tree pass).
 *   C. GENERATED-DIFF CHECK — a source-contract change not reconciled with the
 *      committed generated surface makes it BLOCK; `--no-generated` isolates the
 *      structural/placeholder legs.
 *
 * Every mutation is made to a temp COPY-then-restore of a real contract, and the
 * suite asserts the working tree is byte-identical afterwards (validation must
 * never mutate a source contract). Node built-ins only → deterministic under
 * `npm ci` in the PR-validation gate (`test:tooling`).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(REPO_ROOT, 'packages', 'contracts', 'scripts', 'validate.ts');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts', 'governance-control-plane');
const EE = join(CONTRACTS_DIR, 'evidence-envelope.schema.json');
const GEN = join(REPO_ROOT, 'packages', 'contracts', 'src', 'generated', 'evidence-envelope.ts');

/** Run the validator CLI; returns {status, stdout, stderr}. Never throws on exit code. */
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

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** Mutate a file, run `fn`, then always restore its exact original bytes. */
function withMutation(file, mutate, fn) {
  const original = readFileSync(file, 'utf8');
  const before = sha256(file);
  try {
    writeFileSync(file, mutate(original), 'utf8');
    fn();
  } finally {
    writeFileSync(file, original, 'utf8');
  }
  assert.equal(sha256(file), before, 'file restored byte-identically after mutation');
}

test('artifact exists on disk', () => {
  assert.ok(existsSync(SCRIPT), 'validate.ts present');
});

test('clean tree: validate passes (exit 0) — .invalid hosts are NOT placeholders', () => {
  const r = runCli([]);
  assert.equal(r.status, 0, `validate should pass on clean tree\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /contracts:validate OK/);
  assert.match(r.stdout, /5 source contract\(s\) valid/);
});

test('clean tree: --json report is ok with no findings', () => {
  const r = runCli(['--json']);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.findings.length, 0);
  assert.equal(report.validated.length, 5);
});

test('A. NEGATIVE CONTROL: dangling local $ref blocks (exit 1), restore → 0', () => {
  withMutation(
    EE,
    (s) => s.replace('"$ref": "#/$defs/uuid"', '"$ref": "#/$defs/does_not_exist"'),
    () => {
      const r = runCli(['--no-generated']);
      assert.equal(r.status, 1, 'dangling $ref must block');
      assert.match(r.stderr, /dangling local \$ref/);
    },
  );
  assert.equal(runCli(['--no-generated']).status, 0, 'green again after restore');
});

test('A. NEGATIVE CONTROL: malformed contract fails to parse and blocks', () => {
  withMutation(
    EE,
    (s) => s.slice(0, 40), // truncate → invalid JSON
    () => {
      const r = runCli(['--no-generated']);
      assert.equal(r.status, 1, 'unparseable contract must block');
      assert.match(r.stderr, /failed to parse jsonschema/);
    },
  );
  assert.equal(runCli(['--no-generated']).status, 0);
});

test('B. NEGATIVE CONTROL: unresolved <REPLACE_ME> placeholder blocks, restore → 0', () => {
  withMutation(
    EE,
    (s) =>
      s.replace(
        '"title": "TrustCircleAI Evidence Envelope"',
        '"title": "TrustCircleAI Evidence Envelope <REPLACE_ME>"',
      ),
    () => {
      const r = runCli(['--no-generated']);
      assert.equal(r.status, 1, 'placeholder must block');
      assert.match(r.stderr, /unresolved placeholder/);
    },
  );
  assert.equal(runCli(['--no-generated']).status, 0);
});

test('B. NEGATIVE CONTROL: a TODO marker blocks', () => {
  withMutation(
    EE,
    (s) => s.replace('"title":', '"x-note": "TODO finish this",\n  "title":'),
    () => {
      const r = runCli(['--no-generated']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /TODO marker/);
    },
  );
  assert.equal(runCli(['--no-generated']).status, 0);
});

test('B. NEGATIVE CONTROL: resolvable example.com domain blocks (but .invalid does not)', () => {
  withMutation(
    EE,
    (s) => s.replace('"title":', '"x-docs": "https://example.com/evidence",\n  "title":'),
    () => {
      const r = runCli(['--no-generated']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /example\.com placeholder domain/);
    },
  );
  assert.equal(runCli(['--no-generated']).status, 0);
});

test('C. NEGATIVE CONTROL: source change not regenerated blocks via generated-diff, restore → 0', () => {
  // A real, structurally-valid source edit that changes the generated output but
  // is NOT reconciled with the committed generated module ⇒ generated-diff blocks.
  // (We tamper the committed generated module instead of the source so we do not
  // have to also regenerate; either drift direction is caught.)
  const original = readFileSync(GEN, 'utf8');
  const before = sha256(GEN);
  try {
    writeFileSync(GEN, original + '\nexport type ConsumerBreakingSneak = never;\n', 'utf8');
    const r = runCli([]);
    assert.equal(r.status, 1, 'generated drift must block full validate');
    assert.match(r.stderr, /generated module drifted/);
    // With --no-generated the SAME tree passes: proves the leg is isolable and the
    // block came specifically from the generated-diff check.
    assert.equal(runCli(['--no-generated']).status, 0, 'structural/placeholder legs still pass');
  } finally {
    writeFileSync(GEN, original, 'utf8');
  }
  assert.equal(sha256(GEN), before, 'generated module restored byte-identically');
  assert.equal(runCli([]).status, 0, 'full validate green again after restore');
});
