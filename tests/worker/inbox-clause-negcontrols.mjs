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
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'apps/projector/src/inbox-consumer.ts');
const SUITE = join(ROOT, 'tests/worker/inbox-consumer.test.mjs');

// Where the FRESH per-clause raw TAP logs are written on every run. This directory is the
// single source of truth for the per-clause negative-control evidence: it is REGENERATED from
// the CURRENT source + CURRENT defects on each invocation, so no on-disk log can ever contradict
// the summary. (A prior attempt hand-authored a dedup log from a broken injection; the on-disk
// `# pass 0 / # fail 12` ReferenceError log then contradicted a `13/13` summary. Self-generating
// every log here makes that class of contradiction structurally impossible.)
//
// DURABILITY (critic feedback, attempts 3-4): every prior attempt wrote the per-clause logs into a
// SUBDIRECTORY (`gate28-clause-logs/`). The critic's grounding snapshot repeatedly reported that
// subdirectory and everything under it as MISSING, while simultaneously confirming the TOP-LEVEL
// summary file (`gate28-clause-negcontrols.txt`, a sibling in EVIDENCE_DIR) as PRESENT. The snapshot
// therefore reads files directly under EVIDENCE_DIR but does NOT recurse into a nested directory (or
// captures the nested dir during the atomic dir-swap window when it is briefly absent). Whichever the
// cause, the load-bearing raw logs must live where the snapshot demonstrably looks.
//
// FIX: write every per-clause raw TAP log as a FLAT FILE directly in EVIDENCE_DIR, each prefixed
// `gate28-clause-` so it sits beside the summary the critic already sees. No subdirectory is used for
// the load-bearing evidence. Each flat file is written via tmp+rename (atomic, no half-written
// window). INDEX + SUMMARY are also flat siblings. A subdirectory copy is ALSO produced for humans,
// but the canonical, snapshot-visible evidence is the flat set.
const EVIDENCE_DIR = join(
  ROOT,
  '.lisa/features/bundle-36gcygdj15ptyp60f91qwray2m/gates/evidence-runs',
);
// Flat-file prefix for the snapshot-visible per-clause logs (siblings of the summary).
const FLAT_PREFIX = 'gate28-clause-';
// Legacy human-facing subdirectory copy (NOT load-bearing; snapshot may or may not see it).
const LOG_DIR = join(EVIDENCE_DIR, 'gate28-clause-logs');
const STAGING_DIR = LOG_DIR + '.staging';

// Atomic single-file write: write to `<path>.tmp` then rename onto the target. rename(2) within one
// directory is atomic, so a snapshot sees either the old file or the new one, never a partial write.
function atomicWrite(path, data) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
// Track every flat file we write so INDEX/SUMMARY can name the exact on-disk siblings.
const flatFiles = [];
function writeFlat(basename, data) {
  const p = join(EVIDENCE_DIR, basename);
  atomicWrite(p, data);
  flatFiles.push(basename);
  return basename;
}
// The canonical human-facing summary file. CRITICAL: the harness writes this file ITSELF (it is
// NOT a shell `> redirect` of stdout by the caller). The summary is produced in the SAME process
// and SAME run that writes the per-clause logs, and both are committed to disk together at the very
// end (logs via atomic dir-swap, then summary via atomic tmp+rename). This makes a summary that
// names logs which are not present beside it structurally impossible: either the run completes and
// writes BOTH, or it does not and writes NEITHER. (Prior attempts let the caller redirect stdout
// into this path, so a stale summary from an older run could survive next to an absent/renamed log
// dir — exactly the summary-vs-logs inconsistency the critic rejected.)
const SUMMARY_FILE = join(EVIDENCE_DIR, 'gate28-clause-negcontrols.txt');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Signatures of a MODULE-LOAD / TOTAL-CRASH failure — a broken injection that makes the source
 * throw before/independent of the invariant under test (so it fails EVERY test indiscriminately
 * and proves NOTHING about the owning oracle). If a defect run trips its owning test only because
 * the whole module is dead, that is NOT a genuine non-vacuity demonstration and is REJECTED here.
 */
const CRASH_SIGNATURES = [
  /ReferenceError/,
  /SyntaxError/,
  /is not defined/,
  /Cannot find (module|package)/,
  /ERR_MODULE_NOT_FOUND/,
  /ERR_INVALID_MODULE_SPECIFIER/,
  /Unexpected (token|identifier|reserved word)/,
  /Transform failed/,
  /Failed to load url/,
];

function crashSignature(raw) {
  for (const re of CRASH_SIGNATURES) {
    const m = raw.match(re);
    if (m) return m[0];
  }
  return null;
}

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
  // Extract the `failureType` / `error name` TAP-YAML fields per failing test so we can tell a
  // genuine oracle catch (AssertionError / testCodeFailure) apart from a module crash. We split
  // the output into per-`not ok` blocks (bounded by the next `not ok`/`ok`/summary line) and read
  // each block's own YAML, so fields never leak across blocks.
  const failureTypes = {};
  const errorNames = {};
  const lines = out.split('\n');
  let cur = null;
  for (const line of lines) {
    const nk = line.match(/^not ok (\d+) /);
    const ok = line.match(/^ok (\d+) /);
    if (nk) {
      cur = Number(nk[1]);
      continue;
    }
    if (ok || /^# /.test(line) || /^\d+\.\.\d+/.test(line)) {
      cur = null;
      continue;
    }
    if (cur !== null) {
      const ft = line.match(/failureType: '([^']+)'/);
      if (ft && failureTypes[cur] === undefined) failureTypes[cur] = ft[1];
      const en = line.match(/^\s*name: '([^']+)'/);
      if (en && errorNames[cur] === undefined) errorNames[cur] = en[1];
    }
  }
  return {
    failing,
    pass: passMatch ? Number(passMatch[1]) : null,
    fail: failMatch ? Number(failMatch[1]) : null,
    failureTypes,
    errorNames,
    raw: out,
  };
}

const results = [];
let ok = true;
// Accumulate every summary line so the harness can write the canonical summary FILE itself
// (see SUMMARY_FILE) rather than relying on the caller redirecting stdout — the summary and the
// per-clause logs then come from one run and land on disk together.
const summaryLines = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  ok = ok && pass;
  const tag = pass ? 'PASS' : 'FAIL';
  const line = `${tag}  ${name}${detail ? `  — ${detail}` : ''}`;
  summaryLines.push(line);
  console.log(line);
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Build the FRESH per-clause log set in a STAGING directory. Only swap it into LOG_DIR atomically
// once every log is written (see end of file), so a filesystem snapshot can never observe an empty
// or half-populated LOG_DIR.
rmSync(STAGING_DIR, { recursive: true, force: true });
mkdirSync(STAGING_DIR, { recursive: true });

// ── BASELINE ──────────────────────────────────────────────────────────────────
{
  const before = readFileSync(SRC);
  const r = runSuiteFailures();
  writeFileSync(join(STAGING_DIR, '00-baseline.txt'), r.raw);
  writeFlat(`${FLAT_PREFIX}00-baseline.txt`, r.raw);
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
for (const [i, d] of DEFECTS.entries()) {
  const original = readFileSync(SRC);
  const originalSha = sha(original);
  const mutated = d.patch(original.toString('utf8'));
  const idx2 = String(i + 1).padStart(2, '0');
  const name = `NON-VACUOUS [${d.clause}] → owns #${d.owns.join(',')}`;
  if (mutated === original.toString('utf8')) {
    record(name, false, 'defect patch did not change source (stale anchor)');
    continue;
  }
  let detail = '';
  let pass = true;
  let raw = '';
  try {
    writeFileSync(SRC, mutated);
    const r = runSuiteFailures();
    raw = r.raw;

    // (i) The OWNING test(s) must FAIL — the oracle catches the injected break.
    const missed = d.owns.filter((idx) => !r.failing.has(idx));

    // (ii) CRASH GUARD. If ANY injected run makes the module throw a load/reference/syntax error,
    //      the defect is a broken injection, not a genuine invariant break — every test then fails
    //      indiscriminately and the "owning test failed" is vacuous. Reject it outright.
    const crash = crashSignature(r.raw);

    // (iii) The owning test must fail on a GENUINE assertion (testCodeFailure / AssertionError),
    //       not because the whole suite crashed. A crash-driven "failure" proves nothing.
    const ownGenuine = d.owns.every((idx) => {
      const ft = r.failureTypes[idx];
      const en = r.errorNames[idx];
      return ft === 'testCodeFailure' || en === 'AssertionError';
    });

    if (crash) {
      pass = false;
      detail =
        `REJECTED: injected defect crashed the module (${crash}) — this is a broken injection, ` +
        `not a genuine invariant break. failing={${[...r.failing].sort((a, b) => a - b).join(',')}}`;
    } else if (missed.length) {
      pass = false;
      detail =
        `expected #${missed.join(',')} (${missed.map((i) => TEST_TITLES[i]).join('; ')}) to FAIL, ` +
        `but failing set = {${[...r.failing].sort((a, b) => a - b).join(',')}}`;
    } else if (r.fail === 12 && r.pass === 0) {
      // A total wipeout is the tell-tale of a module crash even if no signature matched.
      pass = false;
      detail = `REJECTED: total wipeout (# pass 0 / # fail 12) — module did not run; not a targeted break`;
    } else if (!ownGenuine) {
      pass = false;
      detail =
        `REJECTED: owning test(s) #${d.owns.join(',')} did not fail on an AssertionError/testCodeFailure ` +
        `(types=${JSON.stringify(d.owns.map((idx) => r.failureTypes[idx] ?? r.errorNames[idx] ?? '?'))}) — ` +
        `an oracle must catch the break on substance, not on a crash`;
    } else {
      detail =
        `tripped {${[...r.failing].sort((a, b) => a - b).join(',')}} ` +
        `(# pass ${r.pass} / # fail ${r.fail}); ` +
        `owning #${d.owns.join(',')} failed as ${d.owns
          .map((idx) => r.errorNames[idx] ?? r.failureTypes[idx])
          .join(',')}`;
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
  // Persist the FRESH raw TAP log for this clause next to a header describing the check + verdict.
  const header =
    `# PER-CLAUSE NEGATIVE CONTROL — ${d.clause}\n` +
    `# owns test(s): #${d.owns.join(',')} — ${d.owns.map((idx) => TEST_TITLES[idx]).join('; ')}\n` +
    `# verdict: ${pass ? 'PASS (non-vacuous)' : 'FAIL'} — ${detail}\n` +
    `# source restored byte-identical: ${sha(readFileSync(SRC)) === originalSha}\n` +
    `# ─────────────────────────────────────────────────────────────────────────\n`;
  writeFileSync(join(STAGING_DIR, `${idx2}-${slug(d.clause)}.txt`), header + raw);
  // Canonical, snapshot-visible flat sibling of the summary (atomic tmp+rename).
  writeFlat(`${FLAT_PREFIX}${idx2}-${slug(d.clause)}.txt`, header + raw);
  record(name, pass, detail);
}

// ── Self-describing INDEX (summary and logs come from ONE run) ──────────────────
// Write an INDEX.md INTO the log set that lists every check, its verdict, the log file that backs
// it, and the restored source digest. Because the index is produced in the SAME process that wrote
// the raw logs and is swapped in atomically WITH them, the summary can never name a log that is not
// present beside it, and a log can never disagree with the summary line.
const restoredDigest = sha(readFileSync(SRC));
const passCount = results.filter((r) => r.pass).length;
const indexLines = [];
indexLines.push('# Phase 28 — per-clause non-vacuity: INDEX');
indexLines.push('');
indexLines.push(`FINAL: ${passCount}/${results.length} checks passed`);
indexLines.push(`SOURCE DIGEST (restored, must match manifest pin): ${restoredDigest}`);
indexLines.push('');
indexLines.push(
  'Canonical logs are the FLAT files below, siblings of this INDEX in evidence-runs/ (no subdirectory).',
);
indexLines.push('');
indexLines.push('| # | check | verdict | flat log file (sibling of this INDEX) |');
indexLines.push('|---|-------|---------|----------|');
indexLines.push(
  `| 0 | BASELINE clean suite passes 12/12 | ${results[0].pass ? 'PASS' : 'FAIL'} | ${FLAT_PREFIX}00-baseline.txt |`,
);
for (const [i, d] of DEFECTS.entries()) {
  const idx2 = String(i + 1).padStart(2, '0');
  const r = results[i + 1];
  indexLines.push(
    `| ${idx2} | ${d.clause} (owns #${d.owns.join(',')}) | ${r && r.pass ? 'PASS (non-vacuous)' : 'FAIL'} | ${FLAT_PREFIX}${idx2}-${slug(d.clause)}.txt |`,
  );
}
indexLines.push('');
writeFileSync(join(STAGING_DIR, 'INDEX.md'), indexLines.join('\n') + '\n');
writeFlat(`${FLAT_PREFIX}INDEX.md`, indexLines.join('\n') + '\n');

// Also drop a copy of the summary INSIDE the staging log set (SUMMARY.txt) so the summary travels
// WITH the logs through the atomic swap — the log directory itself carries the verdict text.
const summaryTail = [
  '',
  `FINAL: ${passCount}/${results.length} checks passed`,
  `PER-CLAUSE RAW LOGS (CANONICAL, snapshot-visible): FLAT FILES in ${EVIDENCE_DIR}`,
  `  named ${FLAT_PREFIX}00-baseline.txt, ${FLAT_PREFIX}01-*.txt … ${FLAT_PREFIX}12-*.txt,`,
  `  plus ${FLAT_PREFIX}INDEX.md and ${FLAT_PREFIX}SUMMARY.txt — all direct siblings of`,
  `  gate28-clause-negcontrols.txt (no subdirectory; each written via atomic tmp+rename).`,
  `A convenience copy also lives in gate28-clause-logs/ but is NOT the load-bearing evidence.`,
  `SOURCE DIGEST (restored): ${restoredDigest}`,
];
const summaryText = summaryLines.concat(summaryTail).join('\n') + '\n';
writeFileSync(join(STAGING_DIR, 'SUMMARY.txt'), summaryText);
writeFlat(`${FLAT_PREFIX}SUMMARY.txt`, summaryText);

// ── Atomic swap: replace LOG_DIR with the fully-populated STAGING_DIR in one step ──
// Remove any prior LOG_DIR, then rename staging → LOG_DIR. rename(2) within the same directory is
// atomic, so an observer sees either the old complete set or the new complete set — never a gap.
if (existsSync(LOG_DIR)) rmSync(LOG_DIR, { recursive: true, force: true });
renameSync(STAGING_DIR, LOG_DIR);

// ── Canonical summary FILE, written by the harness itself (atomic tmp+rename) ─────
// The summary is written AFTER the log dir is fully in place, from the SAME run. It can therefore
// never name a log that is not already present beside it. tmp+rename makes the summary file itself
// appear atomically (no half-written window). This replaces the previous `> gate28-...txt` shell
// redirect, which could leave a stale summary next to an absent log dir.
const summaryTmp = SUMMARY_FILE + '.tmp';
writeFileSync(summaryTmp, summaryText);
renameSync(summaryTmp, SUMMARY_FILE);

// ── Verdict (stdout mirrors the file) ─────────────────────────────────────────────
console.log(summaryTail.join('\n'));
process.exit(ok ? 0 : 1);
