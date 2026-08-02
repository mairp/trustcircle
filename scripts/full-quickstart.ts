// TrustCircleAI — FULL QUICKSTART VALIDATION RUNNER (Phase 9 / T294 / GAR-010).
//
// PHASE OBJECTIVE (T294): "Run every command and scenario in the validation guide and retain the
// aggregate signed result in artifacts/validation/full-quickstart/manifest.json."
//
// This runner enumerates EVERY command and scenario declared in
// specs/001-governance-control-plane/quickstart.md — the bootstrap/contract gates, all 15 scenarios,
// and the full release gate — and executes each one, recording a truthful per-step result. It then
// writes a SINGLE aggregate manifest, HMAC-signed over its canonical body, to
// artifacts/validation/full-quickstart/manifest.json.
//
// HONESTY MODEL (critical — this is what distinguishes a truthful manifest from a green-washed one).
// The guide's canonical realization of scenarios 1–11 and the role-dashboard slice of 15 is a
// full-browser E2E run against a live Docker Compose stack (Postgres/NATS/OPA/MinIO). This headless
// host has neither Docker nor a browser, so those canonical commands CANNOT run here. The manifest
// records this truthfully with THREE distinct facts, never conflated:
//   • Each canonical guide command that needs infra/browser is a step in its own right, executed when
//     the host has that infra and otherwise reported `deferred` — meaning it DID NOT RUN and its
//     outcome is UNKNOWN until CI runs it. It is NEVER reported `passed` and NEVER silently dropped.
//   • Alongside it, a HOST-RUNNABLE step exercises the SAME scenario's behavior in-process against the
//     real adapters/application/projector/worker/policy/authz/event pipeline (the integration/
//     discovery/worker/projector/authz/domain/policy/resilience/recovery suites + browserless
//     Playwright projects). That step runs for REAL and is reported `passed` on its own merits.
//   • The two are kept SEPARATE: the passing host-runnable step does NOT cause the canonical
//     browser/infra step to be reported as covered/proven. A deferred canonical step stays deferred.
//
// Aggregate `status` is three-way, matching the phase Checkpoint:
//   passed — every step ran and passed (only on a host with infra + browser).
//   failed — a step that ran exited non-zero.
//   held   — nothing failed, but at least one canonical guide command is `deferred` (did not run).
//            The validation is INCOMPLETE and release is BLOCKED until CI runs the deferred commands.
// A `held` aggregate exits non-zero: the runner never reports the quickstart as fully validated when
// canonical commands were not executed.
//
// Determinism: the manifest is canonical (sorted keys) and signed with a fixed key; the only inputs
// that vary run-to-run (timestamps, per-step stdout) are excluded from the signed body. Pass a fixed
// `--generated-at <iso>` to make the emitted file byte-identical across runs.
//
// Modes:
//   node --experimental-strip-types scripts/full-quickstart.ts            run + write manifest
//   node --experimental-strip-types scripts/full-quickstart.ts --list     print the step plan, run none
//   node --experimental-strip-types scripts/full-quickstart.ts --self-test  validate the plan covers the guide
//   node --experimental-strip-types scripts/full-quickstart.ts --dry-run   plan + write manifest w/o running

import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'validation', 'full-quickstart');
const OUT_FILE = join(OUT_DIR, 'manifest.json');
const SIGNING_KEY = 'full-quickstart-manifest-key-v1';

export type StepKind = 'bootstrap' | 'stack' | 'scenario' | 'release';

export interface Step {
  /** Stable id used in the manifest and self-test. */
  readonly id: string;
  readonly kind: StepKind;
  /** The guide section this step corresponds to (traceability into quickstart.md). */
  readonly guideSection: string;
  /** The command actually executed (or the proxy that exercises the scenario on this host). */
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly requiresInfra?: boolean;
  readonly requiresBrowser?: boolean;
  /** This step is the host-runnable PROXY for a guide command whose live realization needs infra. */
  readonly proxyForLive?: boolean;
  /** This step is the CI-only supplementary live/full-fidelity realization; `covered` when host lacks infra. */
  readonly supplementary?: boolean;
  /** For scenarios: the literal guide command this proxy stands in for on infra-less hosts. */
  readonly guideCommand?: string;
  /** This step invokes a sub-gate that exits 3 to mean HELD/indeterminate (not a failure); map 3→deferred. */
  readonly heldOnExit3?: boolean;
}

// Every scenario in quickstart.md is mapped to a HOST-RUNNABLE PROXY that exercises its behavior in
// process, plus (for scenarios 1–11 / stack / 15-dashboards) a supplementary CI-only live-stack or
// full-browser step that carries the literal guide command. A supplementary step whose infra/browser
// the host lacks is classified `covered` (its scenario is already proven by the host-runnable proxy),
// never a blocking `skipped`.
export const STEPS: readonly Step[] = [
  // ── Bootstrap and contract gates ──────────────────────────────────────────────────────────────
  {
    id: 'bootstrap.contracts.validate',
    kind: 'bootstrap',
    guideSection: 'Bootstrap and contract gates',
    command: 'npm',
    args: ['run', 'contracts:validate'],
  },
  {
    id: 'bootstrap.contracts.check',
    kind: 'bootstrap',
    guideSection: 'Bootstrap and contract gates',
    command: 'npm',
    args: ['run', 'contracts:check'],
  },
  {
    id: 'bootstrap.typecheck',
    kind: 'bootstrap',
    guideSection: 'Bootstrap and contract gates',
    command: 'npm',
    args: ['run', 'typecheck'],
  },
  {
    id: 'bootstrap.unit',
    kind: 'bootstrap',
    guideSection: 'Bootstrap and contract gates',
    command: 'npm',
    args: ['run', 'test:unit'],
  },

  // ── Start the isolated stack. Guide uses Docker Compose; the host-runnable proxies validate the
  // stack CONFIG + schema + health-check + component-profile behavior in-process for REAL, and the
  // literal Compose/migrate/seed/health commands are retained as CI-only supplementary steps. ─────
  {
    id: 'stack.up.config',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand:
      'docker compose -f deploy/compose/control-plane.yml --profile e2e up -d --build --wait',
    // Proxy: the core-only-profile integration test validates the component set, minimum-service
    // health, connectivity, and safe-degradation the stack brings up — in-process, no Docker.
    command: 'npx',
    args: ['vitest', 'run', '--project', 'integration', 'core-only-profile'],
    proxyForLive: true,
  },
  {
    id: 'stack.up.live',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand:
      'docker compose -f deploy/compose/control-plane.yml --profile e2e up -d --build --wait',
    command: 'docker',
    args: [
      'compose',
      '-f',
      'deploy/compose/control-plane.yml',
      '--profile',
      'e2e',
      'up',
      '-d',
      '--build',
      '--wait',
    ],
    requiresInfra: true,
    supplementary: true,
  },
  {
    id: 'stack.migrate.proxy',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand: 'npm run db:migrate',
    command: 'npm',
    args: ['run', 'test:migrations'],
    proxyForLive: true,
  },
  {
    id: 'stack.migrate.live',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand: 'npm run db:migrate',
    command: 'npm',
    args: ['run', 'db:migrate'],
    requiresInfra: true,
    supplementary: true,
  },
  {
    id: 'stack.seed.proxy',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand: 'npm run fixtures:seed -- --profile e2e',
    command: 'npm',
    args: ['run', 'test:persistence'],
    proxyForLive: true,
  },
  {
    id: 'stack.seed.live',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand: 'npm run fixtures:seed -- --profile e2e',
    command: 'npm',
    args: ['run', 'fixtures:seed', '--', '--profile', 'e2e'],
    requiresInfra: true,
    supplementary: true,
  },
  {
    id: 'stack.health.proxy',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand: 'npm run health',
    command: 'npm',
    args: ['run', 'test:application'],
    proxyForLive: true,
  },
  {
    id: 'stack.health.live',
    kind: 'stack',
    guideSection: 'Start the isolated stack',
    guideCommand: 'npm run health',
    command: 'npm',
    args: ['run', 'health'],
    requiresInfra: true,
    supplementary: true,
  },

  // ── Scenarios 1–11. Each has a HOST-RUNNABLE PROXY that exercises the scenario's behavior in
  // process for REAL, plus a CI-only supplementary live-stack + full-browser E2E step carrying the
  // literal guide command. ──────────────────────────────────────────────────────────────────────
  // Scenario 1 — open-ended discovery + visible gaps → discovery suite (result manifest + runner).
  {
    id: 'scenario.01.discovery',
    kind: 'scenario',
    guideSection: 'Scenario 1',
    guideCommand: 'npm run test:e2e -- --scenario discovery-open-boundary',
    command: 'npm',
    args: ['run', 'test:discovery'],
    proxyForLive: true,
  },
  {
    id: 'scenario.01.discovery.live',
    kind: 'scenario',
    guideSection: 'Scenario 1',
    guideCommand: 'npm run test:e2e -- --scenario discovery-open-boundary',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'discovery-open-boundary'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 2 — human decision actions + separation of duties → authz SoD + decision-audit integration.
  {
    id: 'scenario.02.human-decisions',
    kind: 'scenario',
    guideSection: 'Scenario 2',
    guideCommand: 'npm run test:e2e -- --scenario human-decisions',
    command: 'npm',
    args: ['run', 'test:sod'],
    proxyForLive: true,
  },
  {
    id: 'scenario.02.human-decisions.live',
    kind: 'scenario',
    guideSection: 'Scenario 2',
    guideCommand: 'npm run test:e2e -- --scenario human-decisions',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'human-decisions'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 3 — federated cross-tenant joint approval → authz authority suite.
  {
    id: 'scenario.03.cross-tenant-joint',
    kind: 'scenario',
    guideSection: 'Scenario 3',
    guideCommand: 'npm run test:e2e -- --scenario cross-tenant-joint-approval',
    command: 'npm',
    args: ['run', 'test:sod'],
    proxyForLive: true,
  },
  {
    id: 'scenario.03.cross-tenant-joint.live',
    kind: 'scenario',
    guideSection: 'Scenario 3',
    guideCommand: 'npm run test:e2e -- --scenario cross-tenant-joint-approval',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'cross-tenant-joint-approval'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 4 — standards applicability + truthful compliance → integration compliance-coverage.
  {
    id: 'scenario.04.standards',
    kind: 'scenario',
    guideSection: 'Scenario 4',
    guideCommand: 'npm run test:e2e -- --scenario standards-applicability',
    command: 'npm',
    args: ['run', 'test:integration'],
    proxyForLive: true,
  },
  {
    id: 'scenario.04.standards.live',
    kind: 'scenario',
    guideSection: 'Scenario 4',
    guideCommand: 'npm run test:e2e -- --scenario standards-applicability',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'standards-applicability'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 5 — corrupted-item preservation, quarantine, repair, verified closure → domain suite.
  {
    id: 'scenario.05.integrity',
    kind: 'scenario',
    guideSection: 'Scenario 5',
    guideCommand: 'npm run test:e2e -- --scenario integrity-remediation',
    command: 'npm',
    args: ['run', 'test:domain'],
    proxyForLive: true,
  },
  {
    id: 'scenario.05.integrity.live',
    kind: 'scenario',
    guideSection: 'Scenario 5',
    guideCommand: 'npm run test:e2e -- --scenario integrity-remediation',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'integrity-remediation'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 6 — destructive automation + rollback boundaries → policy PDP suite.
  {
    id: 'scenario.06.destructive',
    kind: 'scenario',
    guideSection: 'Scenario 6',
    guideCommand: 'npm run test:e2e -- --scenario destructive-remediation-boundaries',
    command: 'npm',
    args: ['run', 'test:policy'],
    proxyForLive: true,
  },
  {
    id: 'scenario.06.destructive.live',
    kind: 'scenario',
    guideSection: 'Scenario 6',
    guideCommand: 'npm run test:e2e -- --scenario destructive-remediation-boundaries',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'destructive-remediation-boundaries'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 7 — lost acknowledgement + idempotent reconciliation → worker outbox/inbox suite.
  {
    id: 'scenario.07.lost-ack',
    kind: 'scenario',
    guideSection: 'Scenario 7',
    guideCommand: 'npm run test:e2e -- --scenario uncertain-remote-outcome',
    command: 'npm',
    args: ['run', 'test:worker'],
    proxyForLive: true,
  },
  {
    id: 'scenario.07.lost-ack.live',
    kind: 'scenario',
    guideSection: 'Scenario 7',
    guideCommand: 'npm run test:e2e -- --scenario uncertain-remote-outcome',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'uncertain-remote-outcome'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 8 — continuity-first bounded operation → resilience suite (continuity_lease profile).
  {
    id: 'scenario.08.continuity',
    kind: 'scenario',
    guideSection: 'Scenario 8',
    guideCommand: 'npm run test:e2e -- --scenario bounded-continuity',
    command: 'npm',
    args: ['run', 'test:resilience'],
    proxyForLive: true,
  },
  {
    id: 'scenario.08.continuity.live',
    kind: 'scenario',
    guideSection: 'Scenario 8',
    guideCommand: 'npm run test:e2e -- --scenario bounded-continuity',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'bounded-continuity'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 9 — Kanban projection boundary → projector suite.
  {
    id: 'scenario.09.kanban',
    kind: 'scenario',
    guideSection: 'Scenario 9',
    guideCommand: 'npm run test:e2e -- --scenario adapter-kanban',
    command: 'npm',
    args: ['run', 'test:projector'],
    proxyForLive: true,
  },
  {
    id: 'scenario.09.kanban.live',
    kind: 'scenario',
    guideSection: 'Scenario 9',
    guideCommand: 'npm run test:e2e -- --scenario adapter-kanban',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'adapter-kanban'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 10 — workflow_orchestration + agentctl compatibility → integration idempotency + worker.
  {
    id: 'scenario.10.workflow-agentctl',
    kind: 'scenario',
    guideSection: 'Scenario 10',
    guideCommand: 'npm run test:e2e -- --scenario adapter-workflow-orchestration',
    command: 'npm',
    args: ['run', 'test:integration'],
    proxyForLive: true,
  },
  {
    id: 'scenario.10.workflow-agentctl.live',
    kind: 'scenario',
    guideSection: 'Scenario 10',
    guideCommand: 'npm run test:e2e -- --scenario adapter-workflow-orchestration',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'adapter-workflow-orchestration'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  // Scenario 11 — connector outage, replay, projection rebuild → resilience + recovery suites.
  {
    id: 'scenario.11.connector-resilience',
    kind: 'scenario',
    guideSection: 'Scenario 11',
    guideCommand: 'npm run test:e2e -- --scenario connector-resilience',
    command: 'npm',
    args: ['run', 'test:recovery'],
    proxyForLive: true,
  },
  {
    id: 'scenario.11.connector-resilience.live',
    kind: 'scenario',
    guideSection: 'Scenario 11',
    guideCommand: 'npm run test:e2e -- --scenario connector-resilience',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'connector-resilience'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },

  // ── Scenario 12 — tenant isolation, retention, tamper: RUN via browserless proxies. ───────────
  {
    id: 'scenario.12.evidence-retention',
    kind: 'scenario',
    guideSection: 'Scenario 12',
    guideCommand: 'npm run test:e2e -- --scenario evidence-retention',
    command: 'npx',
    args: ['playwright', 'test', '--project=evidence-retention'],
    env: { TC_NO_WEBSERVER: '1' },
  },
  {
    id: 'scenario.12.audit-tamper',
    kind: 'scenario',
    guideSection: 'Scenario 12',
    guideCommand: 'npm run test:e2e -- --scenario audit-tamper',
    command: 'npx',
    args: ['playwright', 'test', '--project=audit-tamper'],
    env: { TC_NO_WEBSERVER: '1' },
  },
  {
    id: 'scenario.12.tenant-rls',
    kind: 'scenario',
    guideSection: 'Scenario 12',
    guideCommand: 'npm run test:security -- --scenario tenant-rls',
    command: 'npm',
    args: ['run', 'test:security'],
  },

  // ── Scenario 13 — contract & DB evolution: migration + contract suites (contract host-runnable). ─
  {
    id: 'scenario.13.contract-matrix',
    kind: 'scenario',
    guideSection: 'Scenario 13',
    guideCommand: 'npm run test:contract -- --matrix previous-supported,current',
    command: 'npm',
    args: ['run', 'test:contract'],
  },
  {
    id: 'scenario.13.migrations',
    kind: 'scenario',
    guideSection: 'Scenario 13',
    guideCommand: 'npm run test:migrations -- --from previous-supported --to current',
    command: 'npm',
    args: ['run', 'test:migrations'],
  },

  // ── Scenario 14 — disaster recovery: RUN the recovery suite for real. ─────────────────────────
  {
    id: 'scenario.14.canonical-restore',
    kind: 'scenario',
    guideSection: 'Scenario 14',
    guideCommand: 'npm run test:recovery -- --scenario canonical-restore',
    command: 'npm',
    args: ['run', 'test:recovery'],
  },

  // ── Scenario 15 — dashboards, accessibility, scale, export. ───────────────────────────────────
  // Scenario 15 role dashboards — current-state / role views → projector current-state queries proxy.
  {
    id: 'scenario.15.role-dashboards',
    kind: 'scenario',
    guideSection: 'Scenario 15',
    guideCommand: 'npm run test:e2e -- --scenario role-dashboards',
    command: 'npm',
    args: ['run', 'test:projector'],
    proxyForLive: true,
  },
  {
    id: 'scenario.15.role-dashboards.live',
    kind: 'scenario',
    guideSection: 'Scenario 15',
    guideCommand: 'npm run test:e2e -- --scenario role-dashboards',
    command: 'npm',
    args: ['run', 'test:e2e', '--', '--scenario', 'role-dashboards'],
    requiresInfra: true,
    requiresBrowser: true,
    supplementary: true,
  },
  {
    id: 'scenario.15.accessibility',
    kind: 'scenario',
    guideSection: 'Scenario 15',
    guideCommand: 'npm run test:accessibility',
    command: 'npx',
    args: ['playwright', 'test', '--project=accessibility-full-suite'],
    env: { TC_NO_WEBSERVER: '1' },
  },
  {
    id: 'scenario.15.performance',
    kind: 'scenario',
    guideSection: 'Scenario 15',
    guideCommand: 'npm run test:performance -- --profile acceptance',
    command: 'npm',
    args: ['run', 'test:performance:acceptance'],
  },

  // ── Full release gate. ────────────────────────────────────────────────────────────────────────
  {
    id: 'release.gate',
    kind: 'release',
    guideSection: 'Full release gate',
    guideCommand: 'npm run verify:release',
    // The complete release gate across ALL 11 required dimensions. On this host it exits 3 (HELD):
    // every host-runnable gate passes, but the full-fidelity infra/browser gates are DEFERRED, so the
    // gate correctly BLOCKS release. Exit 3 is the honest "held/indeterminate" signal — map it to
    // `deferred` here (NOT `failed`): a held release gate is the expected, correct state, not a defect.
    command: 'node',
    args: ['--experimental-strip-types', 'scripts/verify-release.ts'],
    heldOnExit3: true,
  },
];

export interface StepResult {
  readonly step: Step;
  // passed   — ran, exit 0. failed — ran, exit non-zero.
  // deferred — needs infra/browser the host lacks, so it DID NOT RUN; outcome UNKNOWN until CI runs
  //            it. Release-blocking (makes the aggregate `held`). Reported truthfully, never merged
  //            with the passing host-runnable proxy for the same scenario.
  readonly status: 'passed' | 'failed' | 'deferred';
  readonly code: number | null;
  readonly note: string;
}

interface RunOptions {
  readonly hasInfra: boolean;
  readonly hasBrowser: boolean;
  readonly dryRun: boolean;
}

function canRun(step: Step, opts: RunOptions): boolean {
  if (step.requiresInfra === true && !opts.hasInfra) return false;
  if (step.requiresBrowser === true && !opts.hasBrowser) return false;
  return true;
}

function executeStep(step: Step): StepResult {
  const res = spawnSync(step.command, [...step.args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(step.env ?? {}) },
  });
  const code = res.status;
  // A sub-gate that exits 3 signals HELD/indeterminate (not a failure): record it as `deferred`.
  if (step.heldOnExit3 === true && code === 3) {
    return {
      step,
      status: 'deferred',
      code,
      note: 'sub-gate HELD (exit 3): host-runnable gates passed, full-fidelity infra/browser gates deferred to CI — release-blocking',
    };
  }
  return {
    step,
    status: code === 0 ? 'passed' : 'failed',
    code,
    note: code === 0 ? 'ok' : `exit ${code ?? 'signal'}`,
  };
}

export type Aggregate = 'passed' | 'failed' | 'held';

export function runAll(opts: RunOptions): {
  results: StepResult[];
  aggregate: Aggregate;
  /** Canonical guide commands that DID NOT run (need infra/browser) — release-blocking. */
  deferred: string[];
} {
  // Pass 1 — run every step the host CAN run (host-runnable proxies + bootstrap + browserless
  // scenarios). Reported truthfully on their own merits.
  const runnable = STEPS.filter((s) => canRun(s, opts));
  const unavailable = STEPS.filter((s) => !canRun(s, opts));
  const ran: StepResult[] = runnable.map((s) =>
    opts.dryRun
      ? { step: s, status: 'deferred' as const, code: null, note: 'dry-run (not executed)' }
      : executeStep(s),
  );

  // Pass 2 — every step the host could not run is `deferred`: it DID NOT run, its outcome is UNKNOWN.
  // We do NOT infer coverage from a sibling host-runnable proxy — the canonical guide command is a
  // distinct obligation, recorded honestly as not-yet-run (release-blocking) until CI executes it.
  const deferredResults: StepResult[] = unavailable.map((step) => {
    const why = step.requiresInfra ? 'a live stack (Postgres/NATS/OPA/MinIO)' : 'a real Chromium browser';
    return {
      step,
      status: 'deferred' as const,
      code: null,
      note: `canonical guide command requires ${why}, absent on this host — DID NOT RUN; outcome INDETERMINATE until executed in CI (release-blocking)`,
    };
  });

  // Reassemble in declared order.
  const byStep = new Map<Step, StepResult>();
  for (const r of [...ran, ...deferredResults]) byStep.set(r.step, r);
  const results = STEPS.map((s) => byStep.get(s)!);

  // Three-way aggregate: failed if anything that ran failed; held if any canonical command is
  // deferred (validation incomplete → release blocked); passed only if every step ran and passed.
  const failed = results.some((r) => r.status === 'failed');
  const deferred = [
    ...new Set(
      results.filter((r) => r.status === 'deferred' && !opts.dryRun).map((r) => r.step.guideCommand ?? r.step.id),
    ),
  ];
  const aggregate: Aggregate = failed ? 'failed' : deferred.length > 0 ? 'held' : 'passed';
  return { results, aggregate, deferred };
}

// ── Canonical JSON + signing (matches the repo's evidence-manifest conventions) ──────────────────
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');
const hmac = (t: string): string => createHmac('sha256', SIGNING_KEY).update(t).digest('hex');

export interface Manifest {
  readonly kind: 'full-quickstart-validation';
  readonly guide: string;
  readonly generatedAt: string;
  readonly host: { readonly hasInfra: boolean; readonly hasBrowser: boolean };
  readonly status: 'passed' | 'failed' | 'held';
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly deferred: number;
  };
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly kind: StepKind;
    readonly guideSection: string;
    readonly guideCommand: string;
    readonly executed: string;
    readonly requiresInfra: boolean;
    readonly requiresBrowser: boolean;
    readonly supplementary: boolean;
    readonly status: 'passed' | 'failed' | 'deferred';
    readonly note: string;
  }>;
  readonly bodyDigest?: string;
  readonly signature?: string;
}

export function buildManifest(
  results: StepResult[],
  opts: RunOptions,
  generatedAt: string,
): Manifest {
  const steps = results.map((r) => ({
    id: r.step.id,
    kind: r.step.kind,
    guideSection: r.step.guideSection,
    guideCommand: r.step.guideCommand ?? `${r.step.command} ${r.step.args.join(' ')}`,
    executed: `${r.step.command} ${r.step.args.join(' ')}`,
    requiresInfra: r.step.requiresInfra === true,
    requiresBrowser: r.step.requiresBrowser === true,
    supplementary: r.step.supplementary === true,
    status: r.status,
    note: r.note,
  }));
  const counts = {
    total: steps.length,
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status === 'failed').length,
    deferred: steps.filter((s) => s.status === 'deferred').length,
  };
  const status: 'passed' | 'failed' | 'held' =
    counts.failed > 0 ? 'failed' : counts.deferred > 0 ? 'held' : 'passed';
  const body = {
    kind: 'full-quickstart-validation' as const,
    guide: 'specs/001-governance-control-plane/quickstart.md',
    generatedAt,
    host: { hasInfra: opts.hasInfra, hasBrowser: opts.hasBrowser },
    status,
    counts,
    steps,
  };
  const bodyDigest = sha256(canonical(body));
  return { ...body, bodyDigest, signature: hmac(bodyDigest) };
}

export function verifyManifest(m: Manifest): boolean {
  const { bodyDigest, signature, ...body } = m;
  const recomputed = sha256(canonical(body));
  return recomputed === bodyDigest && hmac(recomputed) === signature;
}

/** Self-test: the plan must cover every guide section, all 15 scenarios, and the release gate. */
export function selfTest(): { ok: true } {
  const sections = new Set(STEPS.map((s) => s.guideSection));
  for (let i = 1; i <= 15; i++) {
    if (!sections.has(`Scenario ${i}`)) throw new Error(`quickstart plan missing Scenario ${i}`);
  }
  for (const req of [
    'Bootstrap and contract gates',
    'Start the isolated stack',
    'Full release gate',
  ]) {
    if (!sections.has(req)) throw new Error(`quickstart plan missing section: ${req}`);
  }
  // CRITICAL INVARIANT: every scenario section AND every stack section must have at least one
  // host-runnable step (no infra, no browser) so it is proven for real on this headless host and
  // no section is ever left indeterminate. This is what lets the aggregate reach `passed` here.
  const sectionsNeedingProxy = new Set(
    STEPS.filter((s) => s.kind === 'scenario' || s.kind === 'stack').map((s) => s.guideSection),
  );
  for (const section of sectionsNeedingProxy) {
    const hostRunnable = STEPS.some(
      (s) => s.guideSection === section && !s.requiresInfra && !s.requiresBrowser,
    );
    if (!hostRunnable) {
      throw new Error(
        `section "${section}" has NO host-runnable proxy — it would be perpetually indeterminate`,
      );
    }
  }
  // ids must be unique
  const ids = STEPS.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate step id in quickstart plan');
  return { ok: true };
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const isEntry =
  // @ts-expect-error import.meta.main is Node 22+
  (typeof import.meta !== 'undefined' && import.meta.main) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  const argv = process.argv.slice(2);
  selfTest();

  if (argv.includes('--self-test')) {
    console.log(
      `full-quickstart plan OK — ${STEPS.length} steps cover bootstrap, 15 scenarios, and the release gate.`,
    );
    process.exit(0);
  }
  if (argv.includes('--list')) {
    for (const s of STEPS) {
      const tags = [s.requiresInfra ? 'infra' : '', s.requiresBrowser ? 'browser' : '']
        .filter(Boolean)
        .join(',');
      console.log(`${s.id.padEnd(34)} ${s.guideSection}${tags ? `  [${tags}]` : ''}`);
    }
    process.exit(0);
  }

  const hasInfra = process.env.TC_HAS_INFRA === '1';
  const hasBrowser = process.env.TC_HAS_BROWSER === '1';
  const dryRun = argv.includes('--dry-run');
  const generatedAt = argValue(argv, '--generated-at') ?? '1970-01-01T00:00:00.000Z';

  const { results, deferred } = runAll({ hasInfra, hasBrowser, dryRun });
  const manifest = buildManifest(results, { hasInfra, hasBrowser, dryRun }, generatedAt);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log('\n─── full quickstart validation summary ───');
  for (const r of results) {
    console.log(
      `${r.status.toUpperCase().padEnd(8)} ${r.step.id.padEnd(38)} ${r.step.guideSection} — ${r.note}`,
    );
  }
  console.log(`\nmanifest: ${OUT_FILE}`);
  if (deferred.length > 0) {
    console.log(
      `DEFERRED canonical guide commands (did NOT run — release-blocking):\n  - ${deferred.join('\n  - ')}`,
    );
  } else {
    console.log('no deferred commands — every guide command ran on this host.');
  }
  console.log(
    `aggregate: ${manifest.status.toUpperCase()} (passed=${manifest.counts.passed} failed=${manifest.counts.failed} deferred=${manifest.counts.deferred})`,
  );
  if (!verifyManifest(manifest)) {
    console.error('FATAL: manifest failed self-verification');
    process.exit(2);
  }
  // passed → 0; failed → 1; held (canonical commands deferred, validation incomplete) → 3.
  process.exit(manifest.status === 'passed' ? 0 : manifest.status === 'failed' ? 1 : 3);
}
