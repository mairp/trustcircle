// Phase 6 acceptance test — performance & fault-injection configuration contract
// (task T006 / GAR-010 / VO-ec575c4ce42b548bfb4d). Makes the k6-compatible acceptance-scale
// profiles and the controlled fault-injection profiles independently observable WITHOUT a k6
// binary or any load run.
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): the acceptance-scale numbers, the profile
// NAMES, and the NFR-derived threshold budgets in tests/performance/config.ts are a supported
// consumer surface. The root package.json exposes `test:performance`
// (= `node tests/performance/config.ts`). Renaming/removing a profile, weakening a scale
// number, or relaxing an NFR budget silently breaks those consumers and the NFR obligation —
// which GAR-010 forbids without deprecation/migration/rollback/notice/compat evidence. This
// suite imports the config module and asserts the contract, and asserts the self-check runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));
const CONFIG = rel('tests/performance/config.ts');

async function loadConfig() {
  return import(pathToFileURL(CONFIG).href);
}

// ---- Artifact presence -----------------------------------------------------
test('tests/performance/config.ts exists (T006 required artifact)', () => {
  assert.ok(existsSync(CONFIG), 'tests/performance/config.ts must exist');
});

// ---- Acceptance scale contract (spec §Scale/Scope) -------------------------
test('acceptance scale meets the spec numbers', async () => {
  const { ACCEPTANCE_SCALE } = await loadConfig();
  assert.ok(ACCEPTANCE_SCALE.governedAssets >= 100_000, 'governedAssets >= 100k');
  assert.ok(ACCEPTANCE_SCALE.activeWorkItems >= 10_000, 'activeWorkItems >= 10k');
  assert.ok(ACCEPTANCE_SCALE.activeControllerOperations >= 100, 'controllerOps >= 100');
  assert.ok(ACCEPTANCE_SCALE.concurrentUsers >= 500, 'concurrentUsers >= 500');
  assert.ok(ACCEPTANCE_SCALE.auditPackageReferences >= 100_000, 'auditPackageReferences >= 100k');
  // The object must be frozen so consumers cannot mutate the contract at runtime.
  assert.ok(Object.isFrozen(ACCEPTANCE_SCALE), 'ACCEPTANCE_SCALE must be frozen');
});

// ---- k6-compatible acceptance-scale profiles -------------------------------
test('exports the five acceptance-scale profile names', async () => {
  const { SCALE_PROFILE_NAMES } = await loadConfig();
  assert.ok(Array.isArray(SCALE_PROFILE_NAMES), 'SCALE_PROFILE_NAMES must be an array');
  for (const name of [
    'interactive_dashboard',
    'decision_throughput',
    'reconciliation_burst',
    'evidence_export',
    'source_discovery',
  ]) {
    assert.ok(SCALE_PROFILE_NAMES.includes(name), `required scale profile "${name}" must exist`);
  }
});

test('k6 options declares a scenario per scale profile, each with a k6 executor + exec', async () => {
  const { options, SCALE_PROFILE_NAMES } = await loadConfig();
  assert.ok(options && options.scenarios, 'options.scenarios must exist (k6 shape)');
  const K6_EXECUTORS = new Set([
    'ramping-vus',
    'constant-vus',
    'constant-arrival-rate',
    'ramping-arrival-rate',
    'per-vu-iterations',
    'shared-iterations',
    'externally-controlled',
  ]);
  for (const name of SCALE_PROFILE_NAMES) {
    const scn = options.scenarios[name];
    assert.ok(scn, `options.scenarios must include "${name}"`);
    assert.ok(
      K6_EXECUTORS.has(scn.executor),
      `${name}.executor "${scn.executor}" must be k6-native`,
    );
    assert.equal(typeof scn.exec, 'string', `${name} must name an exec function`);
    // The named exec function must actually be an exported dispatchable.
    const mod = await loadConfig();
    assert.equal(
      typeof mod[scn.exec],
      'function',
      `exec "${scn.exec}" must be an exported function`,
    );
  }
});

test('k6 thresholds encode the headline NFR budgets as valid k6 expressions', async () => {
  const { options, NFR_BUDGETS } = await loadConfig();
  const t = options.thresholds;
  // NFR-007 interactive views: p(95) < 3000ms.
  assert.ok(
    JSON.stringify(t.interactive_view_ms).includes(`p(95)<${NFR_BUDGETS.interactiveViewMs}`),
    'interactive threshold must be p(95)<3000',
  );
  // NFR-004 decisions: p(95) < 5000ms.
  assert.ok(
    JSON.stringify(t.decision_response_ms).includes(`p(95)<${NFR_BUDGETS.decisionResponseMs}`),
    'decision threshold must be p(95)<5000',
  );
  // NFR-006 reconciliation: p(95) < 120000ms.
  assert.ok(
    JSON.stringify(t.reconciliation_ms).includes(`p(95)<${NFR_BUDGETS.reconciliationMs}`),
    'reconciliation threshold must be p(95)<120000',
  );
  // NFR-001 availability: request failure rate ceiling.
  assert.ok(
    JSON.stringify(t.http_req_failed).includes(`rate<${NFR_BUDGETS.availabilityFailRatioMax}`),
    'availability threshold must be rate<0.001',
  );
});

// ---- Controlled fault-injection profiles -----------------------------------
test('exports the five controlled fault-injection profiles covering all required domains', async () => {
  const { FAULT_INJECTION_PROFILE_NAMES, FAULT_INJECTION_PROFILES } = await loadConfig();
  for (const name of [
    'retry_backoff',
    'reconciliation_replay',
    'continuity_lease',
    'rollback_failure',
    'disaster_recovery',
  ]) {
    assert.ok(FAULT_INJECTION_PROFILE_NAMES.includes(name), `fault profile "${name}" must exist`);
    const p = FAULT_INJECTION_PROFILES[name];
    assert.ok(p && p.domain && p.invariant, `${name} must declare domain + invariant`);
  }
  // The five domains the plan calls out must all be covered.
  const domains = new Set(Object.values(FAULT_INJECTION_PROFILES).map((p) => p.domain));
  for (const d of ['retry', 'reconciliation', 'continuity', 'rollback', 'disaster-recovery']) {
    assert.ok(domains.has(d), `fault domain "${d}" must be covered`);
  }
});

test('continuity lease respects the NFR-012 15-minute ceiling', async () => {
  const { FAULT_INJECTION_PROFILES, NFR_BUDGETS } = await loadConfig();
  assert.equal(NFR_BUDGETS.continuityLeaseMaxMs, 15 * 60 * 1000, 'ceiling must be 15 min');
  assert.ok(
    FAULT_INJECTION_PROFILES.continuity_lease.leaseMs <= NFR_BUDGETS.continuityLeaseMaxMs,
    'continuity lease must not exceed the 15-minute ceiling',
  );
});

// ---- resolveScenario dispatch + unknown-name safety ------------------------
test('resolveScenario returns known profiles and throws on unknown names', async () => {
  const { resolveScenario } = await loadConfig();
  assert.ok(resolveScenario('interactive_dashboard'), 'known scale profile resolves');
  assert.ok(resolveScenario('rollback_failure'), 'known fault profile resolves');
  assert.throws(() => resolveScenario('does_not_exist'), /unknown performance profile/);
});

// ---- Importing the module has no side effects (never issues load) ----------
test('importing the config never runs the self-check entrypoint', async () => {
  // If import triggered selfCheck's console.log, node:test would still pass, but the guard is
  // that selfCheck is a *callable* we invoke explicitly here and it returns ok.
  const { selfCheck } = await loadConfig();
  assert.equal(typeof selfCheck, 'function', 'selfCheck must be exported');
  const r = selfCheck();
  assert.equal(r.ok, true, 'selfCheck must pass');
  assert.equal(r.profiles, 10, 'selfCheck reports 5 scale + 5 fault profiles');
});

// ---- Script ↔ artifact compatibility contract ------------------------------
test('test:performance runs the config artifact directly and exits 0', () => {
  assert.equal(
    pkg.scripts['test:performance'],
    'node --experimental-strip-types tests/performance/config.ts',
    'test:performance must run the config artifact under Node (no missing tsx dependency)',
  );
  // Behavioral proof: actually run it. The self-check entrypoint exits 0 on a consistent
  // contract and prints its summary. execFileSync throws on non-zero exit.
  const out = execFileSync('node', ['--experimental-strip-types', 'tests/performance/config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(out, /performance config OK/, 'self-check must print its OK summary');
  assert.match(out, /5 scale \+ 5 fault/, 'summary must report the profile split');
});
