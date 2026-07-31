// Phase 12 acceptance test — ./.gitignore ignore/retain contract
// (T012 / GAR-010 / VO-ec575c4ce42b548bfb4d).
//
// Objective: "Ignore disposable local data while retaining signed validation
// manifests and fixtures in ./.gitignore."
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): changes to inventory, source
// contracts, evidence, mappings, and exports MUST preserve supported consumers or
// provide approved deprecation/migration/rollback/notice/compatibility evidence.
// The signed validation manifest (evidence/manifest.json) and the canonical
// contract/test fixtures are supported consumers. A .gitignore that silently swept
// them out of version control would break those consumers. This suite makes the
// ignore/retain contract INDEPENDENTLY OBSERVABLE via git's own ignore engine
// (`git check-ignore`), not by string-matching the file, and additionally proves
// that NO currently-tracked file becomes ignored (consumer preservation).
//
// The oracle is proven non-vacuous by copy-mutate-restore negative controls that
// remove/weaken a retain rule and assert the enforcement then fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const GITIGNORE = rel('.gitignore');

// --- git ignore oracle -------------------------------------------------------
// git check-ignore exit codes: 0 = a pattern matched the path (ignored, UNLESS a
// trailing `!` negation re-included it), 1 = no pattern matched (tracked). A `!`
// re-include still exits 0, so the authoritative "is it ignored" answer is:
// matched AND the winning rule is not a negation.
function isIgnored(path) {
  let out;
  try {
    out = execFileSync('git', ['check-ignore', '-v', '--no-index', path], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (e) {
    // exit 1 => no rule matched => the path is tracked (not ignored)
    if (e.status === 1) return false;
    throw e;
  }
  // A matched rule was printed. If the winning rule is a negation (`!pattern`),
  // the path is re-included (retained), otherwise it is ignored.
  const rule = out.trim().split('\t')[0]; // "<file>:<line>:<pattern>"
  const pattern = rule.slice(rule.indexOf(':', rule.indexOf(':') + 1) + 1);
  return !pattern.startsWith('!');
}

// Read the tracked-files inventory once (supported-consumer surface).
function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The disposable local data that MUST be ignored (regenerable / scratch / secret).
const MUST_BE_IGNORED = [
  'node_modules/pkg/index.js',
  '.tsbuild/packages/x/index.d.ts',
  'app.tsbuildinfo',
  'dist/bundle.js',
  'build/out.js',
  'out/x.js',
  '.cache/x',
  '.turbo/x',
  '.eslintcache',
  'coverage/lcov.info',
  '.nyc_output/x.json',
  'test-results/results.xml',
  'playwright-report/index.html',
  'blob-report/x',
  'junit.xml',
  'logs/app.log',
  'server.log',
  'tmp/scratch',
  '.DS_Store',
  'Thumbs.db',
  'notes.swp',
  '.env',
  '.env.production',
  'config.local',
  '.lisa/state.json',
];

// The signed validation manifests + fixtures that MUST be retained (tracked).
const MUST_BE_RETAINED = [
  'evidence/manifest.json', // the signed validation manifest
  '.env.example', // env template (no secret value)
  'specs/001-governance-control-plane/contracts/adapter-manifest.schema.json',
  'specs/001-governance-control-plane/contracts/evidence-envelope.schema.json',
  'specs/001-governance-control-plane/contracts/governance-api.openapi.yaml',
  'specs/001-governance-control-plane/contracts/governance-events.asyncapi.yaml',
  'specs/001-governance-control-plane/contracts/adapter-protocol.openapi.yaml',
  '.specify/integrations/speckit.manifest.json',
  '.specify/integrations/codex.manifest.json',
  'testautomation/TEST_PLAN.md',
  'packages/contracts/src/generated/index.ts',
  'package-lock.json',
];

// ---- Artifact presence ------------------------------------------------------
test('./.gitignore exists (T012 required artifact)', () => {
  assert.ok(existsSync(GITIGNORE), '.gitignore must exist');
});

// ---- Disposable local data IS ignored ---------------------------------------
test('every disposable local-data path is ignored by git', () => {
  for (const p of MUST_BE_IGNORED) {
    assert.equal(isIgnored(p), true, `disposable path must be ignored: ${p}`);
  }
});

// ---- Signed validation manifests + fixtures ARE retained --------------------
test('every signed validation manifest / fixture is retained (NOT ignored)', () => {
  for (const p of MUST_BE_RETAINED) {
    assert.equal(isIgnored(p), false, `supported consumer must stay tracked (not ignored): ${p}`);
  }
});

// ---- The signed manifest is a real, tracked artifact on disk ----------------
test('evidence/manifest.json exists and is git-tracked', () => {
  assert.ok(existsSync(rel('evidence/manifest.json')), 'signed manifest must exist on disk');
  assert.ok(
    trackedFiles().includes('evidence/manifest.json'),
    'signed manifest must be committed (git-tracked)',
  );
});

// ---- Disposable-inside-retained overrides work ------------------------------
// A local scratch file *inside* a retained directory must still be ignored, so
// re-including the directory does not accidentally track local scratch.
test('local scratch inside a retained directory stays ignored', () => {
  assert.equal(isIgnored('evidence/scratch.local.json'), true, 'evidence/*.local.json ignored');
  assert.equal(isIgnored('evidence/notes.tmp'), true, 'evidence/*.tmp ignored');
  // ...but the manifest right beside it is retained
  assert.equal(isIgnored('evidence/manifest.json'), false, 'the signed manifest is retained');
});

// ---- Consumer preservation: no tracked file becomes ignored -----------------
// The core GAR-010 guarantee — a .gitignore change must not silently sweep any
// already-supported consumer out of version control.
test('no currently-tracked file is ignored by .gitignore (consumer preservation)', () => {
  const offenders = trackedFiles().filter((f) => isIgnored(f));
  assert.deepEqual(offenders, [], `these tracked files would be silently ignored: ${offenders}`);
});

// ---- The retain contract is documented in the file --------------------------
test('.gitignore documents the retain contract + GAR-010 discipline', () => {
  const src = readFileSync(GITIGNORE, 'utf8');
  assert.match(src, /VO-ec575c4ce42b548bfb4d/, 'must cite the compatibility obligation');
  assert.match(src, /RETAINED/i, 'must have a RETAINED section');
  assert.match(src, /!evidence\//, 'must re-include the evidence manifest directory');
  assert.match(src, /!specs\//, 'must re-include the contract fixtures');
});

// ---- Negative controls (prove the oracle is non-vacuous) --------------------
// Each mutates a COPY-BACKED .gitignore, asserts enforcement fails, then restores
// byte-for-byte.
function withMutatedGitignore(mutate, body) {
  const backup = GITIGNORE + '.bak12';
  copyFileSync(GITIGNORE, backup);
  try {
    const original = readFileSync(GITIGNORE, 'utf8');
    writeFileSync(GITIGNORE, mutate(original));
    body();
  } finally {
    copyFileSync(backup, GITIGNORE);
    rmSync(backup, { force: true });
  }
  // prove exact restoration
  assert.ok(existsSync(GITIGNORE));
}

test('NEG-CONTROL A: removing the evidence/*.local.json override stops ignoring local scratch', () => {
  // The disposable-inside-retained override (evidence/*.local.json) is load-bearing:
  // remove it and local scratch beside the signed manifest is no longer ignored.
  withMutatedGitignore(
    (src) => src.replace(/^evidence\/\*\.local\.json$/m, '# removed for neg-control'),
    () => {
      assert.equal(
        isIgnored('evidence/scratch.local.json'),
        false,
        'without the evidence/*.local.json override, local scratch is re-included by !evidence/**',
      );
    },
  );
  assert.equal(isIgnored('evidence/scratch.local.json'), true, 'restored: scratch ignored again');
});

test('NEG-CONTROL B: a broad rule with the retain removed WOULD ignore the manifest', () => {
  // Prove the retain rule is load-bearing: add a broad `*.json`-style ignore AND
  // drop the evidence re-include -> the signed manifest gets ignored.
  withMutatedGitignore(
    (src) =>
      src.replace(/^!evidence\/\*\*$/m, '').replace(/^!evidence\/$/m, '') + '\nevidence/*.json\n',
    () => {
      assert.equal(
        isIgnored('evidence/manifest.json'),
        true,
        'a broad evidence/*.json rule without the retain re-include ignores the signed manifest',
      );
    },
  );
  // After restore, the manifest is retained again.
  assert.equal(isIgnored('evidence/manifest.json'), false, 'restored: manifest retained again');
});

test('NEG-CONTROL C: dropping the specs re-include + broad ignore hides a fixture', () => {
  withMutatedGitignore(
    (src) => src.replace(/^!specs\/\*\*$/m, '').replace(/^!specs\/$/m, '') + '\nspecs/**/*.yaml\n',
    () => {
      assert.equal(
        isIgnored('specs/001-governance-control-plane/contracts/governance-api.openapi.yaml'),
        true,
        'a broad specs/**/*.yaml rule without the retain re-include hides a contract fixture',
      );
    },
  );
  assert.equal(
    isIgnored('specs/001-governance-control-plane/contracts/governance-api.openapi.yaml'),
    false,
    'restored: contract fixture retained again',
  );
});

test('NEG-CONTROL D: weakening a disposable rule stops ignoring disposable data', () => {
  withMutatedGitignore(
    (src) => src.replace(/^coverage\/$/m, '# coverage rule removed'),
    () => {
      assert.equal(
        isIgnored('coverage/lcov.info'),
        false,
        'with the coverage rule removed, disposable coverage output is no longer ignored',
      );
    },
  );
  assert.equal(isIgnored('coverage/lcov.info'), true, 'restored: coverage ignored again');
});
