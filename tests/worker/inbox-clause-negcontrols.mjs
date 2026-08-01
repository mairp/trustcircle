// PER-CLAUSE NON-VACUITY HARNESS for the Phase-28 durable inbox consumer.
//
// The sole acceptance criterion (GAR-008 / VO-52d0780c11bcc6fd7583) is a CONJUNCTION of many
// clauses: versioned AND validated AND correlated AND deduplicated AND reconcilable AND
// retry-bounded AND safe-under {duplicate, delayed, partial, conflicting, uncertain}.
//
// A green positive test proves nothing on its own. This harness proves each clause-oracle is
// NON-VACUOUS: for every clause it injects a DISTINCT, targeted defect into the REAL source
// (apps/projector/src/inbox-consumer.ts) that breaks exactly that clause, re-runs the 12-test
// suite (tests/worker/inbox-consumer.test.mjs) in a CHILD process, and asserts:
//   (a) the test(s) that OWN that clause FAIL (the oracle catches the break — proves non-vacuity),
//   (b) the source is restored BYTE-IDENTICALLY afterward (digest before === digest after).
//
// Unlike the earlier two negative controls (which both only tripped test #7 RETRY-BOUNDED), each
// defect here is engineered to trip the test that MATCHES its clause — most importantly the
// DEDUPLICATED defect trips test #3 (DEDUPLICATED), demonstrating that oracle is real.
//
// This is a PLAIN script (NOT run under `node --test`) so it can spawn `node --test` children
// without nesting test runners. Run:
//   node --experimental-strip-types tests/worker/inbox-clause-negcontrols.mjs
// Exit code 0 == every clause oracle proven non-vacuous AND source restored byte-identically.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'apps/projector/src/inbox-consumer.ts');
const SUITE = join(ROOT, 'tests/worker/inbox-consumer.test.mjs');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const TEST_TITLES = {
  1: 'VALIDATED: a malformed envelope is rejected',
  2: 'VERSIONED: a cross-major schema_version is refused',
  3: 'DEDUPLICATED: re-delivering an applied event causes NO second effect',
  4: 'ORDERED: an out-of-order (delayed) event is BUFFERED',
  5: 'CONFLICT: a second event at an applied version is quarantined',
  6: 'QUARANTINE: an unsafe event is blocked from execution but visible',
  7: 'RETRY-BOUNDED: a transient apply failure retries to the bound',
  8: 'RETRY-BOUNDED: a FatalApplyError dead-letters immediately',
  9: 'UNCERTAIN: source ordering-uncertain forward jump buffers',
  10: 'RECONCILABLE: attempt history + cursor advance are reconstructable',
  11: 'CORRELATED: dedup is scoped per consumer',
  12: 'CONCURRENCY: concurrent delivery of one event applies exactly once',
};

const DEFECTS = [
  {
    clause: 'VALIDATED',
    owns: [1],
    patch: (s) =>
      s.replace(
        '    const validation = validateEnvelope(raw);\n    if (!validation.valid) {',
        '    const validation = validateEnvelope(raw);\n    if (false && !validation.valid) {',
      ),
  },
  {
    clause: 'VERSIONED (cross-major refused)',
    owns: [2],
    patch: (s) =>
      s.replace(
        '    const validation = validateEnvelope(raw);',
        "    if (raw && typeof raw === 'object') (raw as Record<string, unknown>).schema_version = SUPPORTED_SCHEMA_VERSION;\n    const validation = validateEnvelope(raw);",
      ),
  },
  {
    clause: 'DEDUPLICATED (safe under duplicate)',
    owns: [3],
    patch: (s) => {
      let out = s.replace(
        '      if (!insert.inserted && isTerminalState(existing.processingState)) {',
        '      if (false && !insert.inserted && isTerminalState(existing.processingState)) {',
      );
      out = out.replace(
        '      const step = applyDelivery(state, env);\n      const cls: DeliveryClassification = step.classification;',
        "      const step = applyDelivery(state, env);\n      let cls: DeliveryClassification = step.classification;\n      if (cls.decision === 'duplicate') cls = { decision: 'apply', reason: cls.reason };",
      );
      return out;
    },
  },
  {
    clause: 'ORDERED APPLY (safe under delayed / out-of-order)',
    owns: [4],
    patch: (s) =>
      s.replace(
        "        case 'out_of_order':\n        case 'gap':",
        "        case 'out_of_order':\n          return this.#doApply(tx, env, attemptNo, startedAt, step.state);\n        case 'gap':",
      ),
  },
  {
    clause: 'SAFE UNDER CONFLICTING (quarantine, no overwrite)',
    owns: [5],
    patch: (s) =>
      s.replace(
        "        case 'conflict':\n          // A different event already occupies this aggregate slot: QUARANTINE for human",
        "        case 'conflict':\n          return this.#doApply(tx, env, attemptNo, startedAt, step.state);\n          // A different event already occupies this aggregate slot: QUARANTINE for human",
      ),
  },
  {
    clause: 'QUARANTINE (unsafe/ambiguous blocked, still visible)',
    owns: [6],
    patch: (s) =>
      s.replace(
        '      const unsafeReason = this.#unsafeGuard ? this.#unsafeGuard(env) : null;',
        '      const unsafeReason = null;',
      ),
  },
  {
    clause: 'RETRY-BOUNDED (transient → bounded retries → dead-letter)',
    owns: [7],
    patch: (s) =>
      s.replace(
        '    if (attemptNo >= this.#maxAttempts) {',
        '    if (false && attemptNo >= this.#maxAttempts) {',
      ),
  },
  {
    clause: 'RETRY-BOUNDED (fatal → immediate dead-letter, no retries)',
    owns: [8],
    patch: (s) =>
      s.replace(
        '      const fatal = err instanceof FatalApplyError;',
        '      const fatal = false;',
      ),
  },
  {
    clause: 'SAFE UNDER UNCERTAIN (ordering-uncertain gap never applies)',
    owns: [9],
    patch: (s) =>
      s.replace(
        "        case 'out_of_order':\n        case 'gap':",
        "        case 'out_of_order':\n        case 'gap':\n          return this.#doApply(tx, env, attemptNo, startedAt, step.state);",
      ),
  },
  {
    clause: 'RECONCILABLE (append-only attempt history)',
    owns: [10],
    patch: (s) =>
      s.replace(
        '      correlationId: env.correlation_id,\n      startedAt,\n      endedAt,\n      outcome,\n      errorDetail,',
        "      correlationId: 'CORRUPTED',\n      startedAt,\n      endedAt,\n      outcome,\n      errorDetail,",
      ),
  },
  {
    clause: 'CORRELATED (dedup scoped per consumer)',
    owns: [11],
    patch: (s) =>
      s.replace('    this.#consumer = opts.consumer;', "    this.#consumer = 'SHARED';"),
  },
  {
    clause: 'CONCURRENCY / CORRELATED (per-aggregate lock serializes)',
    owns: [12],
    patch: (s) =>
      s.replace(
        '    const lockKey = `inbox:${this.#consumer}:${aggregateKey(env)}`;',
        '    const lockKey = `inbox:${this.#consumer}:${aggregateKey(env)}:${Math.random()}`;',
      ),
  },
];

/** Run the 12-test suite in a CHILD process; return the set of FAILING test indices. */
function runSuiteFailures() {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--test', '--experimental-strip-types', SUITE], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const failing = new Set();
  for (const m of out.matchAll(/^not ok (\d+) /gm)) failing.add(Number(m[1]));
  const passMatch = out.match(/# pass (\d+)/);
  const failMatch = out.match(/# fail (\d+)/);
  return {
    failing,
    pass: passMatch ? Number(passMatch[1]) : null,
    fail: failMatch ? Number(failMatch[1]) : null,
    raw: out,
  };
}

const results = [];
let ok = true;
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  ok = ok && pass;
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ── BASELINE ──────────────────────────────────────────────────────────────────
{
  const before = readFileSync(SRC);
  const r = runSuiteFailures();
  const pass = r.fail === 0 && r.pass === 12;
  record(
    'BASELINE clean suite passes 12/12',
    pass,
    pass ? '12/12' : `pass=${r.pass} fail=${r.fail}\n${r.raw}`,
  );
  if (sha(readFileSync(SRC)) !== sha(before))
    record('BASELINE did not mutate source', false, 'source changed');
}

// ── One case per clause defect ──────────────────────────────────────────────────
for (const d of DEFECTS) {
  const original = readFileSync(SRC);
  const originalSha = sha(original);
  const mutated = d.patch(original.toString('utf8'));
  const name = `NON-VACUOUS [${d.clause}] → owns #${d.owns.join(',')}`;
  if (mutated === original.toString('utf8')) {
    record(name, false, 'defect patch did not change source (stale anchor)');
    continue;
  }
  let detail = '';
  let pass = true;
  try {
    writeFileSync(SRC, mutated);
    const r = runSuiteFailures();
    const missed = d.owns.filter((idx) => !r.failing.has(idx));
    if (missed.length) {
      pass = false;
      detail =
        `expected #${missed.join(',')} (${missed.map((i) => TEST_TITLES[i]).join('; ')}) to FAIL, ` +
        `but failing set = {${[...r.failing].sort((a, b) => a - b).join(',')}}`;
    } else {
      detail = `tripped {${[...r.failing].sort((a, b) => a - b).join(',')}}`;
    }
    if (r.fail === null) {
      pass = false;
      detail = `suite did not produce a TAP summary\n${r.raw}`;
    }
  } finally {
    writeFileSync(SRC, original);
  }
  if (sha(readFileSync(SRC)) !== originalSha) {
    pass = false;
    detail += ' | RESTORE FAILED — source not byte-identical';
  }
  record(name, pass, detail);
}

// ── Verdict ─────────────────────────────────────────────────────────────────────
console.log('');
console.log(`FINAL: ${results.filter((r) => r.pass).length}/${results.length} checks passed`);
console.log(`SOURCE DIGEST (restored): ${sha(readFileSync(SRC))}`);
process.exit(ok ? 0 : 1);
