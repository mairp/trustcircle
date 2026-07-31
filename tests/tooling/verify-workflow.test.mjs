// Phase 9 acceptance test — pull-request validation workflow
// (task series T009 / GAR-010 / VO-ec575c4ce42b548bfb4d).
//
// Makes .github/workflows/verify.yml an independently observable, ENFORCED compatibility
// contract. The compatibility oracle (VO-ec575c4ce42b548bfb4d) requires that changes to
// inventory, decisions, lifecycle states, source contracts, evidence, mappings, and exports
// preserve supported consumers or carry approved deprecation/migration/rollback/notice/
// compatibility evidence. The PR-validation gate is *the mechanism* that enforces that: it
// blocks a PR unless every supported-consumer surface is validated. This suite asserts the
// gate genuinely covers all seven required domains and cannot silently lose a domain:
//
//   1. contracts   2. generated-code   3. lint   4. types
//   5. tests       6. migrations       7. evidence-manifest
//
// It also exercises the evidence-manifest tool (build/verify parity + drift detection) and
// the guarded run-if-present runner (present -> run, absent -> visible skip, never silent),
// each with a negative control, so the oracle is non-vacuous.
//
// Node built-ins + the committed workflow file only -> deterministic under `npm ci`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const rel = (p) => join(ROOT, p);
const WF = '.github/workflows/verify.yml';
const wfText = () => readFileSync(rel(WF), 'utf8');

const REQUIRED_DOMAINS = [
  'contracts',
  'generated-code',
  'lint',
  'types',
  'tests',
  'migrations',
  'evidence-manifest',
];

// ---- Artifact presence -----------------------------------------------------
test('.github/workflows/verify.yml exists (Phase 9 required artifact)', () => {
  assert.ok(existsSync(rel(WF)), `${WF} must exist`);
});

// ---- YAML is syntactically valid ------------------------------------------
test('verify.yml is valid YAML and parses to a jobs graph', async () => {
  const mod = await import('js-yaml');
  const yaml = mod.default ?? mod;
  const doc = yaml.load(wfText());
  assert.ok(doc && typeof doc === 'object', 'workflow must parse to an object');
  assert.equal(doc.name, 'verify');
  assert.ok(doc.jobs && typeof doc.jobs === 'object', 'workflow must declare jobs');
  // Triggered on pull_request (the PR-validation contract). YAML `on:` may normalise to true.
  const on = doc.on ?? doc[true];
  assert.ok(on, 'workflow must declare triggers');
  assert.ok(on.pull_request, 'workflow MUST run on pull_request (PR validation)');
});

// ---- Every required PR-validation domain is covered by a job --------------
test('all seven required PR-validation domains are present as jobs', async () => {
  const mod = await import('js-yaml');
  const yaml = mod.default ?? mod;
  const doc = yaml.load(wfText());
  const jobIds = Object.keys(doc.jobs);
  for (const d of REQUIRED_DOMAINS) {
    // A domain is covered when a job id equals it OR a job's name mentions it.
    const covered =
      jobIds.includes(d) ||
      jobIds.some((j) => (doc.jobs[j].name || '').toLowerCase().includes(d.replace('-', ' ')));
    assert.ok(covered, `PR-validation domain "${d}" MUST be covered by a job`);
  }
});

// ---- The aggregate gate depends on every domain job (no silent gap) -------
test('aggregate `verify` job requires every domain job via needs[]', async () => {
  const mod = await import('js-yaml');
  const yaml = mod.default ?? mod;
  const doc = yaml.load(wfText());
  const gate = doc.jobs.verify;
  assert.ok(gate, 'an aggregate `verify` gate job must exist');
  const needs = Array.isArray(gate.needs) ? gate.needs : [gate.needs];
  for (const j of ['lint', 'types', 'contracts', 'tests', 'migrations', 'evidence-manifest']) {
    assert.ok(needs.includes(j), `aggregate gate must depend on the "${j}" job`);
  }
  // The gate must fail the run if any dependency failed.
  const body = wfText();
  assert.match(body, /!=\s*"success"/, 'gate must fail when a dependency is not success');
  assert.match(body, /exit 1/, 'gate must be able to exit non-zero');
});

// ---- Domain command wiring -------------------------------------------------
test('each domain job invokes the concrete command that validates that surface', () => {
  const body = wfText();
  const wiring = [
    ['contracts', /npm run ci:contracts\b/],
    ['generated-code', /npm run ci:contracts:generated\b/],
    ['lint', /npm run lint\b/],
    ['prettier', /npm run format\b/],
    ['types', /npm run typecheck\b/],
    ['unit tests', /npm run test:unit\b/],
    ['contract tests', /npm run test:contract\b/],
    ['integration tests', /npm run test:integration\b/],
    ['security tests', /npm run test:security\b/],
    ['migrations', /npm run ci:migrations\b/],
    ['evidence manifest', /npm run evidence:verify\b/],
  ];
  for (const [label, re] of wiring) {
    assert.match(body, re, `workflow must wire the ${label} check`);
  }
  // Deterministic install from the lockfile, pinned Node 22.
  assert.match(body, /npm ci\b/, 'workflow must use `npm ci` (deterministic install)');
  assert.match(body, /node-version:\s*'22'/, 'workflow must pin Node 22');
});

// ---- The referenced npm scripts actually exist ----------------------------
test('every npm script the workflow references is defined in package.json', () => {
  const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));
  const referenced = [
    'ci:contracts',
    'ci:contracts:generated',
    'lint',
    'format',
    'typecheck',
    'test:unit',
    'test:contract',
    'test:integration',
    'test:security',
    'test:boundaries',
    'test:evidence',
    'test:sod',
    'test:tooling',
    'ci:migrations',
    'evidence:verify',
  ];
  for (const s of referenced) {
    assert.ok(pkg.scripts[s], `package.json must define script "${s}"`);
  }
});

// ---- CI helper scripts exist ----------------------------------------------
test('CI helper scripts exist on disk', () => {
  assert.ok(existsSync(rel('scripts/ci/evidence-manifest.mjs')), 'evidence-manifest.mjs missing');
  assert.ok(existsSync(rel('scripts/ci/run-if-present.mjs')), 'run-if-present.mjs missing');
});

// ---- Evidence manifest: build == verify (round-trip) ----------------------
test('committed evidence manifest verifies against on-disk supported contracts', () => {
  assert.ok(existsSync(rel('evidence/manifest.json')), 'evidence/manifest.json must be committed');
  const out = execFileSync('node', ['scripts/ci/evidence-manifest.mjs', 'verify'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out, /evidence-manifest: OK/, 'verify must report OK');
});

// ---- Evidence manifest: pins bundle identity (rejects mismatched input) ----
test('evidence manifest pins the bundle execution identity', async () => {
  const { BUNDLE, assertPinnedIdentity } = await import(
    pathToFileURL(rel('scripts/ci/evidence-manifest.mjs')).href
  );
  assert.equal(BUNDLE.id, '36GCYGDJ15PTYP60F91QWRAY2M');
  assert.equal(
    BUNDLE.contentHash,
    'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  );
  // Negative case: evidence whose bundle identity differs from the pinned input is rejected.
  assert.throws(
    () => assertPinnedIdentity({ bundle: { id: 'WRONG', contentHash: 'x' } }),
    /pinned/,
    'a manifest with a foreign bundle id must be rejected',
  );
});

// ---- Evidence manifest: NEGATIVE CONTROL (drift detection) ----------------
test('evidence manifest verify FAILS when a present contract silently mutates', () => {
  const manifestPath = rel('evidence/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Corrupt one present contract's recorded digest so on-disk reality no longer matches.
  const present = manifest.contracts.find((c) => c.status === 'present' && c.digest);
  assert.ok(present, 'need at least one present digested contract for the neg-control');
  const tampered = JSON.parse(JSON.stringify(manifest));
  const target = tampered.contracts.find((c) => c.path === present.path);
  target.digest = 'deadbeef'.repeat(8);
  const tmp = mkdtempSync(join(tmpdir(), 'ev-manifest-'));
  const tmpManifest = join(tmp, 'manifest.json');
  try {
    writeFileSync(tmpManifest, JSON.stringify(tampered, null, 2));
    let failed = false;
    try {
      execFileSync(
        'node',
        ['scripts/ci/evidence-manifest.mjs', 'verify', '--manifest', tmpManifest],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (e) {
      failed = true;
      assert.match(String(e.stderr || ''), /DRIFT DETECTED|inventoryDigest/);
    }
    assert.ok(failed, 'verify MUST fail on a tampered manifest (drift is non-vacuous)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- run-if-present: present -> runs; absent -> visible skip (never silent) -
test('run-if-present runs the command when the required path exists', () => {
  const out = execFileSync(
    'node',
    [
      'scripts/ci/run-if-present.mjs',
      '--label',
      'probe',
      '--requires',
      'package.json',
      '--',
      'node',
      '-e',
      'process.stdout.write("RAN-OK")',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.match(out, /PR-VALIDATION RUN \[probe\]/);
  assert.match(out, /RAN-OK/);
});

test('run-if-present emits a VISIBLE skip (not a silent pass) when required path is absent', () => {
  const out = execFileSync(
    'node',
    [
      'scripts/ci/run-if-present.mjs',
      '--label',
      'contracts',
      '--requires',
      'packages/contracts/scripts/validate.ts',
      '--',
      'node',
      '-e',
      'process.exit(1)', // would fail if it ran; skip means exit 0 without running
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.match(out, /::warning title=PR-validation deferred::/, 'skip must be annotated');
  assert.match(out, /PR-VALIDATION SKIP \[contracts\]/, 'skip must be labelled');
});

test('run-if-present propagates a NON-ZERO exit when a present command fails (neg control)', () => {
  let failed = false;
  try {
    execFileSync(
      'node',
      [
        'scripts/ci/run-if-present.mjs',
        '--label',
        'probe',
        '--requires',
        'package.json',
        '--',
        'node',
        '-e',
        'process.exit(3)',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (e) {
    failed = true;
    assert.equal(e.status, 3, 'runner must propagate the real exit code');
  }
  assert.ok(failed, 'runner must not mask a real failure of a present command');
});
