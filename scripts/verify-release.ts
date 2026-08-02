// TrustCircleAI — COMPLETE RELEASE GATE (Phase 9 / T283 / GAR-010).
//
// PHASE OBJECTIVE (T283): "Implement the complete contract, unit, integration, security,
// accessibility, resilience, migration, recovery, performance, E2E, and evidence release gate in
// scripts/verify-release.ts".
//
// This is the single command a release runs to prove EVERY assurance dimension. It declares the
// ordered gate set and executes each runnable gate as a subprocess, collecting pass/fail.
//
// HONESTY / DETERMINACY MODEL (this is what makes the checkpoint enforceable, without lying about
// what ran). Every required dimension declares BOTH:
//   • a HOST-RUNNABLE gate — needs no live infra and no browser, so it runs anywhere including this
//     headless host, and
//   • (for the dimensions whose canonical proof is a live/browser run) a FULL-FIDELITY gate that
//     needs Postgres/NATS (Testcontainers) or a real Chromium (marked requiresInfra/requiresBrowser).
//
// A gate that could not run here is reported `deferred`. `deferred` is NOT a synonym for "proven" and
// NOT silently dropped: it is an explicit, honest INDETERMINATE result — the full-fidelity WCAG-axe /
// live-Postgres / full-browser-E2E verification did not execute on this host and its outcome is
// therefore UNKNOWN until a CI host with that infra runs it. We do NOT relabel it `covered`; the
// host-runnable gate that DID pass is reported truthfully as `passed`, and the full-fidelity gate is
// reported truthfully as `deferred`. The two are distinct facts, not merged.
//
// The top-level verdict is three-way, matching the phase Checkpoint's four blocking conditions
// ("missing, stale, indeterminate, or failing"):
//   PASS  — every declared gate ran and passed (nothing failed, nothing deferred). Only reachable on
//           a host that actually has the infra + browser. Release may proceed.
//   FAIL  — at least one gate that RAN exited non-zero. Release blocked (a real failure).
//   HELD  — nothing that ran failed, but at least one required full-fidelity gate is `deferred`
//           (indeterminate). Release is BLOCKED pending CI execution of those gates. This is the
//           CORRECT, honest state on an infra-less/browser-less host: the checkpoint holds the
//           release because an accessibility / e2e / integration result is genuinely indeterminate.
// A HELD verdict exits non-zero — the gate never green-lights a release whose full-fidelity
// verification has not been performed. Implementing that block IS the T283 deliverable.
//
// Modes:
//   node --experimental-strip-types scripts/verify-release.ts            run every gate → PASS/FAIL/HELD
//   node --experimental-strip-types scripts/verify-release.ts --list     print the gate set, run none
//   node --experimental-strip-types scripts/verify-release.ts --only <dimension[,dimension...]>
//   node --experimental-strip-types scripts/verify-release.ts --self-test
//        assert the gate set covers all 11 required dimensions + a host-runnable gate per dimension

import { spawnSync } from 'node:child_process';

export type Dimension =
  | 'contract'
  | 'unit'
  | 'integration'
  | 'security'
  | 'accessibility'
  | 'resilience'
  | 'migration'
  | 'recovery'
  | 'performance'
  | 'e2e'
  | 'evidence';

export const REQUIRED_DIMENSIONS: readonly Dimension[] = [
  'contract',
  'unit',
  'integration',
  'security',
  'accessibility',
  'resilience',
  'migration',
  'recovery',
  'performance',
  'e2e',
  'evidence',
];

export interface Gate {
  readonly dimension: Dimension;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly requiresInfra?: boolean;
  readonly requiresBrowser?: boolean;
}

// The complete ordered gate set. Each dimension has at least one host-runnable gate.
export const GATES: readonly Gate[] = [
  // contract
  { dimension: 'contract', name: 'contract-suite', command: 'npm', args: ['run', 'test:contract'] },
  // unit
  { dimension: 'unit', name: 'unit-suite', command: 'npm', args: ['run', 'test:unit'] },
  // integration — the integration project (tests/integration/**) composes the REAL adapters,
  // application, projector and event pipeline entirely in-process against deterministic fixtures;
  // it does NOT connect to Postgres/NATS (those are modelled as data), so it runs anywhere and is
  // the host-runnable integration gate. A CI host with a live stack ALSO runs the Testcontainers
  // integration profile as a supplementary full-fidelity gate (see integration-live below).
  {
    dimension: 'integration',
    name: 'integration-suite (in-process)',
    command: 'npm',
    args: ['run', 'test:integration'],
  },
  {
    dimension: 'integration',
    name: 'integration-live (Testcontainers)',
    command: 'npm',
    args: ['run', 'test:integration'],
    env: { TC_HAS_INFRA: '1' },
    requiresInfra: true,
  },
  // security
  { dimension: 'security', name: 'security-suite', command: 'npm', args: ['run', 'test:security'] },
  // accessibility — browserless full-suite gate (runs anywhere) + browser axe run (CI).
  {
    dimension: 'accessibility',
    name: 'accessibility-full-suite (browserless)',
    command: 'npx',
    args: ['playwright', 'test', '--project=accessibility-full-suite'],
    env: { TC_NO_WEBSERVER: '1' },
  },
  {
    dimension: 'accessibility',
    name: 'accessibility (browser axe)',
    command: 'npm',
    args: ['run', 'test:accessibility'],
    requiresBrowser: true,
  },
  // resilience
  {
    dimension: 'resilience',
    name: 'resilience-suite',
    command: 'npm',
    args: ['run', 'test:resilience'],
  },
  // migration
  {
    dimension: 'migration',
    name: 'migration-suite',
    command: 'npm',
    args: ['run', 'test:migrations'],
  },
  // recovery
  { dimension: 'recovery', name: 'recovery-suite', command: 'npm', args: ['run', 'test:recovery'] },
  // performance — host-runnable acceptance harness (config self-check + acceptance measurements).
  {
    dimension: 'performance',
    name: 'performance-config',
    command: 'npm',
    args: ['run', 'test:performance'],
  },
  {
    dimension: 'performance',
    name: 'performance-acceptance',
    command: 'npm',
    args: ['run', 'test:performance:acceptance'],
  },
  // e2e — browserless gates (audit-tamper, evidence-retention) run anywhere; the full browser E2E runs in CI.
  {
    dimension: 'e2e',
    name: 'e2e audit-tamper (browserless)',
    command: 'npx',
    args: ['playwright', 'test', '--project=audit-tamper'],
    env: { TC_NO_WEBSERVER: '1' },
  },
  {
    dimension: 'e2e',
    name: 'e2e evidence-retention (browserless)',
    command: 'npx',
    args: ['playwright', 'test', '--project=evidence-retention'],
    env: { TC_NO_WEBSERVER: '1' },
  },
  {
    dimension: 'e2e',
    name: 'e2e (full browser)',
    command: 'npm',
    args: ['run', 'test:e2e'],
    requiresBrowser: true,
  },
  // evidence — signed evidence-manifest verification + the validation-manifest verifier self-check.
  {
    dimension: 'evidence',
    name: 'evidence-manifest verify',
    command: 'npm',
    args: ['run', 'evidence:verify'],
  },
  {
    dimension: 'evidence',
    name: 'validation-manifest verifier',
    command: 'node',
    args: ['--experimental-strip-types', 'tests/evidence/verify-manifests.ts'],
  },
];

// A gate result is one of:
//   passed   — the gate ran and its subprocess exited 0.
//   failed   — the gate ran and its subprocess exited non-zero.
//   deferred — the gate needs infra/browser this host lacks, so it DID NOT RUN. Its outcome is
//              UNKNOWN / INDETERMINATE until a CI host with that infra runs it. This is reported
//              honestly and is release-BLOCKING (it makes the top-level verdict HELD). It is NOT a
//              claim that the dimension is proven — the host-runnable gate for the same dimension is
//              reported separately as `passed`; the two facts are kept distinct.
export interface GateResult {
  readonly gate: Gate;
  readonly status: 'passed' | 'failed' | 'deferred';
  readonly code: number | null;
  readonly note: string;
}

interface RunOptions {
  readonly only?: ReadonlySet<Dimension>;
  readonly hasInfra: boolean;
  readonly hasBrowser: boolean;
}

export function selectGates(only?: ReadonlySet<Dimension>): readonly Gate[] {
  if (!only) return GATES;
  return GATES.filter((g) => only.has(g.dimension));
}

/** True if this gate needs infra/browser the host lacks (so it cannot run here). */
function isUnavailable(gate: Gate, opts: RunOptions): boolean {
  return (
    (gate.requiresInfra === true && !opts.hasInfra) ||
    (gate.requiresBrowser === true && !opts.hasBrowser)
  );
}

/** Run a gate's subprocess (only called for gates that CAN run on this host). */
function executeGate(gate: Gate): GateResult {
  const res = spawnSync(gate.command, [...gate.args], {
    stdio: 'inherit',
    env: { ...process.env, ...(gate.env ?? {}) },
  });
  const code = res.status;
  return {
    gate,
    status: code === 0 ? 'passed' : 'failed',
    code,
    note: code === 0 ? 'ok' : `exit ${code ?? 'signal'}`,
  };
}

export type Verdict = 'PASS' | 'FAIL' | 'HELD';

export function runRelease(opts: RunOptions): {
  results: GateResult[];
  verdict: Verdict;
  /** Dimensions whose host-runnable gate passed (exercised for real on this host). */
  proven: Dimension[];
  /** Dimensions with a full-fidelity gate that did NOT run here (indeterminate → release HELD). */
  deferredDimensions: Dimension[];
} {
  const gates = selectGates(opts.only);

  // Pass 1 — run every gate that CAN run on this host (host-runnable + any infra/browser the host
  // actually has). Record pass/fail honestly.
  const runnable = gates.filter((g) => !isUnavailable(g, opts));
  const unavailable = gates.filter((g) => isUnavailable(g, opts));
  const ran: GateResult[] = runnable.map(executeGate);
  const proven = new Set(ran.filter((r) => r.status === 'passed').map((r) => r.gate.dimension));

  // Pass 2 — every gate the host could not run is `deferred`: it DID NOT run, so its outcome is
  // UNKNOWN. We do NOT infer "covered/proven" from a sibling host-runnable gate — that would conflate
  // two distinct facts. The full-fidelity result is genuinely indeterminate and blocks the release.
  const deferred: GateResult[] = unavailable.map((gate) => {
    const why = gate.requiresInfra ? 'live infra (Postgres/NATS via Testcontainers)' : 'a real Chromium browser';
    return {
      gate,
      status: 'deferred' as const,
      code: null,
      note: `requires ${why}, absent on this host — DID NOT RUN; outcome INDETERMINATE until executed in CI (release-blocking)`,
    };
  });

  // Re-assemble results in the original declared gate order for a stable, readable summary.
  const byGate = new Map<Gate, GateResult>();
  for (const r of [...ran, ...deferred]) byGate.set(r.gate, r);
  const results = gates.map((g) => byGate.get(g)!);

  // Three-way verdict (Checkpoint: release blocked if any test is missing, stale, indeterminate, or
  // failing):
  //   FAIL — a gate that ran exited non-zero (real failure).
  //   HELD — nothing failed, but a required full-fidelity gate is deferred (indeterminate) → BLOCKED.
  //   PASS — every gate ran and passed (only on a host that has infra + browser).
  const failed = results.some((r) => r.status === 'failed');
  const deferredResults = results.filter((r) => r.status === 'deferred');
  const deferredDimensions = [...new Set(deferredResults.map((r) => r.gate.dimension))];
  const verdict: Verdict = failed ? 'FAIL' : deferredResults.length > 0 ? 'HELD' : 'PASS';
  return { results, verdict, proven: [...proven], deferredDimensions };
}

/** Assert the gate set is complete (every required dimension declared). Used by --self-test and CI. */
export function selfTest(): { ok: true } {
  const declared = new Set(GATES.map((g) => g.dimension));
  const missing = REQUIRED_DIMENSIONS.filter((d) => !declared.has(d));
  if (missing.length > 0) {
    throw new Error(`release gate set is INCOMPLETE — missing dimensions: ${missing.join(', ')}`);
  }
  // CRITICAL INVARIANT: EVERY required dimension must expose at least one host-runnable gate (no
  // infra, no browser) so it is proven for real on a headless host and a full run can reach PASS.
  // This is what guarantees the checkpoint can be satisfied here rather than perpetually blocked.
  const noHostRunnable = REQUIRED_DIMENSIONS.filter(
    (d) => !GATES.some((g) => g.dimension === d && !g.requiresBrowser && !g.requiresInfra),
  );
  if (noHostRunnable.length > 0) {
    throw new Error(
      `these dimensions have NO host-runnable gate (would be perpetually indeterminate): ${noHostRunnable.join(', ')}`,
    );
  }
  return { ok: true };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
const isEntry =
  // @ts-expect-error import.meta.main is Node 22+, not yet in lib.dom typings
  (typeof import.meta !== 'undefined' && import.meta.main) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
    console.log(
      `release gate set OK — ${GATES.length} gates across ${REQUIRED_DIMENSIONS.length} required dimensions.`,
    );
    process.exit(0);
  }
  if (argv.includes('--list')) {
    selfTest();
    for (const g of GATES) {
      const tags = [g.requiresInfra ? 'infra' : '', g.requiresBrowser ? 'browser' : '']
        .filter(Boolean)
        .join(',');
      console.log(`${g.dimension.padEnd(14)} ${g.name}${tags ? `  [${tags}]` : ''}`);
    }
    process.exit(0);
  }

  const onlyArgIdx = argv.indexOf('--only');
  const only =
    onlyArgIdx >= 0 && argv[onlyArgIdx + 1]
      ? new Set(argv[onlyArgIdx + 1]!.split(',') as Dimension[])
      : undefined;

  const hasInfra = process.env.TC_HAS_INFRA === '1';
  const hasBrowser = process.env.TC_HAS_BROWSER === '1';

  selfTest();
  const { results, verdict, proven, deferredDimensions } = runRelease({ only, hasInfra, hasBrowser });
  console.log('\n─── release gate summary ───');
  for (const r of results) {
    console.log(
      `${r.status.toUpperCase().padEnd(8)} ${r.gate.dimension.padEnd(14)} ${r.gate.name} — ${r.note}`,
    );
  }
  const dims = only ? [...only] : REQUIRED_DIMENSIONS;
  console.log(
    `\ndimensions exercised by a host-runnable gate that PASSED: ${dims.filter((d) => proven.includes(d)).length}/${dims.length}`,
  );
  if (deferredDimensions.length > 0) {
    console.log(
      `INDETERMINATE (full-fidelity gate deferred, DID NOT run — release-blocking): ${deferredDimensions.join(', ')}`,
    );
  } else {
    console.log('no deferred gates — every declared gate ran on this host.');
  }
  const banner =
    verdict === 'PASS'
      ? '\nRELEASE GATE: PASS — every gate ran and passed.'
      : verdict === 'FAIL'
        ? '\nRELEASE GATE: FAIL — a gate that ran exited non-zero.'
        : '\nRELEASE GATE: HELD — release BLOCKED: full-fidelity infra/browser gates did not run and their outcome is indeterminate. Re-run in CI with TC_HAS_INFRA=1 TC_HAS_BROWSER=1 to reach PASS.';
  console.log(banner);
  // PASS exits 0; FAIL and HELD both exit non-zero — the gate never green-lights a release whose
  // full-fidelity verification has not been performed. HELD uses a distinct code (3) so CI can tell
  // "indeterminate, needs infra" apart from "something actually failed" (1).
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}
