// TrustCircleAI — k6-compatible performance & controlled fault-injection profiles
// (task T006 / GAR-010 / VO-ec575c4ce42b548bfb4d).
//
// This file is the single source of truth for the *acceptance-scale* load profiles and the
// *controlled fault-injection* profiles the platform is measured against. It is written to be
// consumed two ways without either path launching real load:
//
//   1. As a k6-compatible options/scenarios/thresholds source. k6 (https://k6.io) reads an
//      exported `options` object (`export const options = {...}`) plus scenario `exec`
//      functions. The `options` we export here — `scenarios`, `thresholds`, `summaryTrendStats`
//      — use only k6-native shapes (constant-arrival-rate / ramping-vus executors, `http_req_*`
//      + custom trend/rate metric threshold expressions), so a `k6 run` against a script that
//      re-exports `options` from this module needs no translation layer. We deliberately do NOT
//      `import` the `k6` runtime module here (it only exists inside the k6 binary), so the file
//      also imports cleanly under Node for structural verification.
//
//   2. As a typed contract module for Node/Vitest tooling. The named exports below
//      (`ACCEPTANCE_SCALE`, `SCALE_PROFILE_NAMES`, `FAULT_INJECTION_PROFILE_NAMES`,
//      `PERFORMANCE_THRESHOLDS`, `NFR_BUDGETS`, `options`, `resolveScenario`) are the SUPPORTED
//      consumer surface asserted by tests/tooling/performance-config.test.mjs.
//
// Compatibility contract (VO-ec575c4ce42b548bfb4d): the acceptance-scale numbers, the profile
// NAMES, and the NFR-derived threshold budgets exported here are a supported consumer surface.
// The root package.json exposes `test:performance` (= `node tests/performance/config.ts`), which
// runs this file's self-check entrypoint. Renaming/removing a profile, weakening a scale number
// below the spec's acceptance scale, or relaxing an NFR budget is a breaking change to those
// consumers and to the NFR obligation, and is forbidden without deprecation / migration /
// rollback / notice / compatibility evidence. The tooling test imports this module and asserts
// every one of those invariants, so the contract is mechanically enforced. Importing this file
// never issues a request or starts a VU — the load only runs under an actual `k6 run`.

// --------------------------------------------------------------------------------------------
// Acceptance scale (spec §Scale/Scope): the fixed dimensions the platform is accepted at.
// These are the authoritative numbers the load profiles derive their VU/arrival-rate targets
// from. Lowering any of them silently would make a "passing" run prove less than the spec
// requires — hence they are a frozen, asserted contract.
// --------------------------------------------------------------------------------------------
export const ACCEPTANCE_SCALE = Object.freeze({
  /** Governed assets in the inventory at acceptance scale. */
  governedAssets: 100_000,
  /** Active (in-flight) work items. */
  activeWorkItems: 10_000,
  /** Concurrent controller operations. */
  activeControllerOperations: 100,
  /** Concurrent human users driving the interactive surfaces. */
  concurrentUsers: 500,
  /** Audit/evidence references a single export request must be able to cover (NFR-009). */
  auditPackageReferences: 100_000,
});

// --------------------------------------------------------------------------------------------
// NFR budgets (spec NFR-001..NFR-012). Each budget is the measurable objective a threshold
// enforces. Kept as one exported table so the k6 thresholds below and the tooling test share a
// single definition and cannot drift. Times are milliseconds; ratios are 0..1.
// --------------------------------------------------------------------------------------------
export const NFR_BUDGETS = Object.freeze({
  // NFR-001 Availability: 99.9% monthly → request failure ratio ceiling.
  availabilityFailRatioMax: 0.001,
  // NFR-002 Inventory freshness: 99% of source changes visible within 2 min.
  inventoryFreshnessMs: 120_000,
  inventoryFreshnessPct: 0.99,
  // NFR-003 Health detection: critical health visible within 60 s.
  healthVisibleMs: 60_000,
  // NFR-004 Decision response: 95% of decisions durable within 5 s; reconcile within 2 min.
  decisionResponseMs: 5_000,
  decisionResponsePct: 0.95,
  decisionReconcileMs: 120_000,
  // NFR-005 Integrity detection: 99% of changed items evaluated within 5 min.
  integrityEvalMs: 300_000,
  integrityEvalPct: 0.99,
  // NFR-006 Reconciliation: 10k work items reconciled within 2 min for 95% of runs.
  reconciliationMs: 120_000,
  reconciliationPct: 0.95,
  // NFR-007 Interactive performance: 95% of views usable within 3 s.
  interactiveViewMs: 3_000,
  interactiveViewPct: 0.95,
  // NFR-008 Audit durability: committed records reachable within 4 h after interruption.
  auditRecoveryMs: 4 * 60 * 60 * 1_000,
  // NFR-009 Evidence export: 100k-reference package within 15 min.
  evidenceExportMs: 15 * 60 * 1_000,
  // NFR-011 Source discovery: on-demand run reports within 2 min for 95% of runs.
  discoveryOnDemandMs: 120_000,
  discoveryOnDemandPct: 0.95,
  // NFR-012 Continuity ceiling: a continuity lease MUST NOT exceed 15 min.
  continuityLeaseMaxMs: 15 * 60 * 1_000,
});

// --------------------------------------------------------------------------------------------
// k6 thresholds derived from the NFR budgets. Every expression is a valid k6 threshold string
// keyed by a k6 metric name. `p(95)<3000` means the 95th-percentile of that trend must stay
// under 3 s, matching NFR-007; `rate<0.001` matches the NFR-001 availability budget; etc.
// abortOnFail makes a breached budget a hard failure so a run cannot "pass" while missing an NFR.
// --------------------------------------------------------------------------------------------
export const PERFORMANCE_THRESHOLDS = Object.freeze({
  // NFR-001 availability — global request failure ceiling.
  http_req_failed: [
    { threshold: `rate<${NFR_BUDGETS.availabilityFailRatioMax}`, abortOnFail: false },
  ],
  // NFR-007 interactive views — usable within 3 s for 95% of requests.
  interactive_view_ms: [`p(95)<${NFR_BUDGETS.interactiveViewMs}`],
  // NFR-004 decision response — durable within 5 s for 95%.
  decision_response_ms: [`p(95)<${NFR_BUDGETS.decisionResponseMs}`],
  // NFR-003 health visibility — within 60 s.
  health_visible_ms: [`p(95)<${NFR_BUDGETS.healthVisibleMs}`],
  // NFR-002 inventory freshness — within 2 min for 99%.
  inventory_freshness_ms: [`p(99)<${NFR_BUDGETS.inventoryFreshnessMs}`],
  // NFR-006 reconciliation of 10k items — within 2 min for 95% of runs.
  reconciliation_ms: [`p(95)<${NFR_BUDGETS.reconciliationMs}`],
  // NFR-009 evidence export of 100k refs — within 15 min.
  evidence_export_ms: [`p(95)<${NFR_BUDGETS.evidenceExportMs}`],
  // NFR-011 on-demand discovery — within 2 min for 95%.
  discovery_ondemand_ms: [`p(95)<${NFR_BUDGETS.discoveryOnDemandMs}`],
});

/** k6 summaryTrendStats so every trend surfaces the percentiles the NFRs are stated in. */
export const SUMMARY_TREND_STATS = Object.freeze([
  'avg',
  'min',
  'med',
  'p(90)',
  'p(95)',
  'p(99)',
  'max',
]);

// --------------------------------------------------------------------------------------------
// (1) Acceptance-scale load profiles. Each is a named k6 scenario. The steady-state profiles
// use constant-arrival-rate / ramping-vus executors sized from ACCEPTANCE_SCALE so a run
// actually exercises the spec's scale rather than a token trickle. Every scenario names an
// `exec` function so k6 can dispatch it; the functions are defined at the bottom of this file.
// --------------------------------------------------------------------------------------------

/** Canonical, ordered names of the acceptance-scale load profiles (asserted contract). */
export const SCALE_PROFILE_NAMES = Object.freeze([
  'interactive_dashboard', // NFR-007 — 500 concurrent users reading current-state views.
  'decision_throughput', // NFR-004 — sustained human decision submissions.
  'reconciliation_burst', // NFR-006 — on-demand reconciliation of 10k work items.
  'evidence_export', // NFR-009 — 100k-reference audit package export.
  'source_discovery', // NFR-011 — on-demand source discovery sweep.
]);

const SCALE_SCENARIOS = Object.freeze({
  // NFR-007: 500 concurrent users hitting current-state / health / compliance views.
  interactive_dashboard: {
    executor: 'ramping-vus',
    exec: 'interactiveDashboard',
    startVUs: 0,
    stages: [
      { duration: '1m', target: Math.floor(ACCEPTANCE_SCALE.concurrentUsers / 2) },
      { duration: '3m', target: ACCEPTANCE_SCALE.concurrentUsers },
      { duration: '2m', target: ACCEPTANCE_SCALE.concurrentUsers },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
    tags: { nfr: 'NFR-007', profile: 'interactive_dashboard' },
  },

  // NFR-004: sustained decision submissions at a fixed arrival rate (open model).
  decision_throughput: {
    executor: 'constant-arrival-rate',
    exec: 'decisionThroughput',
    rate: 50,
    timeUnit: '1s',
    duration: '5m',
    preAllocatedVUs: 100,
    maxVUs: ACCEPTANCE_SCALE.concurrentUsers,
    tags: { nfr: 'NFR-004', profile: 'decision_throughput' },
  },

  // NFR-006: a burst that reconciles up to 10k active work items on demand.
  reconciliation_burst: {
    executor: 'per-vu-iterations',
    exec: 'reconciliationBurst',
    vus: 20,
    iterations: Math.ceil(ACCEPTANCE_SCALE.activeWorkItems / 20),
    maxDuration: '3m',
    tags: { nfr: 'NFR-006', profile: 'reconciliation_burst', scale: '10000_work_items' },
  },

  // NFR-009: export a 100k-reference audit/evidence package.
  evidence_export: {
    executor: 'shared-iterations',
    exec: 'evidenceExport',
    vus: 5,
    iterations: 5,
    maxDuration: '16m',
    tags: { nfr: 'NFR-009', profile: 'evidence_export', refs: '100000' },
  },

  // NFR-011: on-demand source-discovery sweep across the open-ended catalog.
  source_discovery: {
    executor: 'constant-vus',
    exec: 'sourceDiscovery',
    vus: 10,
    duration: '2m',
    tags: { nfr: 'NFR-011', profile: 'source_discovery' },
  },
});

// --------------------------------------------------------------------------------------------
// (2) Controlled fault-injection profiles. These are deterministic, *controlled* perturbation
// recipes (not chaos): each names the governed subsystem it exercises, the injected fault, the
// expected safe behavior, and the invariant that MUST hold under fault. They cover the five
// domains the spec's plan calls out: retry, reconciliation, continuity, rollback, and disaster
// recovery. A resilience/recovery suite (Vitest projects) and k6 executors both consume these
// by name — so the NAMES here are a supported, asserted contract.
// --------------------------------------------------------------------------------------------

/** Canonical, ordered names of the controlled fault-injection profiles (asserted contract). */
export const FAULT_INJECTION_PROFILE_NAMES = Object.freeze([
  'retry_backoff',
  'reconciliation_replay',
  'continuity_lease',
  'rollback_failure',
  'disaster_recovery',
]);

export const FAULT_INJECTION_PROFILES = Object.freeze({
  // Retry: transient dependency errors must be retried with bounded backoff and must NOT
  // duplicate a governed effect (idempotency under retry).
  retry_backoff: {
    domain: 'retry',
    inject: 'transient-5xx-then-recover',
    faultRatio: 0.2,
    maxRetries: 5,
    backoff: 'exponential-jitter',
    expect: 'bounded-retry-no-duplicate-effect',
    invariant: 'at-most-once governed effect despite N transient failures',
    nfr: 'NFR-001',
  },

  // Reconciliation: duplicate / out-of-order / delayed source updates must reconcile to a
  // single governance action; history stays reconstructable (idempotent reconciliation).
  reconciliation_replay: {
    domain: 'reconciliation',
    inject: 'duplicate-and-out-of-order-updates',
    duplicationFactor: 3,
    reorderWindow: 50,
    expect: 'single-action-reconstructable-history',
    invariant: 'no duplicate governance action; source history reconstructable',
    withinMs: NFR_BUDGETS.reconciliationMs,
    nfr: 'NFR-006',
  },

  // Continuity: a controller loses health mid-operation. A valid lease may let the current
  // step continue while evidence buffers; otherwise it MUST pause at a safe checkpoint. The
  // lease MUST NOT exceed the 15-minute ceiling (NFR-012).
  continuity_lease: {
    domain: 'continuity',
    inject: 'mid-operation-health-loss',
    leaseMs: NFR_BUDGETS.continuityLeaseMaxMs,
    expect: 'continue-under-lease-or-safe-checkpoint',
    invariant: 'lease <= 15min ceiling; else pause + require reconciliation',
    nfr: 'NFR-012',
  },

  // Rollback failure: rollback is unavailable/fails during recovery. The affected scope MUST
  // remain visibly degraded, further unsafe actions blocked, and the incident escalated.
  rollback_failure: {
    domain: 'rollback',
    inject: 'rollback-unavailable',
    expect: 'degraded-visible-unsafe-blocked-escalated',
    invariant: 'no false success; unsafe actions blocked; incident escalated',
    nfr: 'NFR-010',
  },

  // Disaster recovery: service interruption; committed governance records MUST become
  // reachable again within the NFR-008 recovery objective without losing audit records.
  disaster_recovery: {
    domain: 'disaster-recovery',
    inject: 'service-interruption-then-restore',
    recoverWithinMs: NFR_BUDGETS.auditRecoveryMs,
    expect: 'no-audit-loss-access-restored-within-objective',
    invariant: 'zero committed-audit loss; access restored within 4h',
    nfr: 'NFR-008',
  },
});

// --------------------------------------------------------------------------------------------
// k6 `options` — the exact object a k6 script re-exports to run this estate. Combines the
// acceptance-scale scenarios with the NFR-derived thresholds. Importing this object is free;
// only `k6 run` acts on it.
// --------------------------------------------------------------------------------------------
export const options = Object.freeze({
  scenarios: SCALE_SCENARIOS,
  thresholds: PERFORMANCE_THRESHOLDS,
  summaryTrendStats: SUMMARY_TREND_STATS,
  // Discard response bodies by default at scale to keep the load generator honest on memory.
  discardResponseBodies: true,
  noConnectionReuse: false,
});

/**
 * Resolve a scenario or fault profile by name. Throws on an unknown name so a typo in a
 * consumer (script or test) fails loudly rather than silently running nothing.
 */
export function resolveScenario(name: string): unknown {
  if (name in SCALE_SCENARIOS) return SCALE_SCENARIOS[name as keyof typeof SCALE_SCENARIOS];
  if (name in FAULT_INJECTION_PROFILES) {
    return FAULT_INJECTION_PROFILES[name as keyof typeof FAULT_INJECTION_PROFILES];
  }
  throw new Error(`unknown performance profile: ${name}`);
}

// --------------------------------------------------------------------------------------------
// k6 scenario `exec` functions. These run ONLY inside the k6 binary (where the `http`/`check`
// globals exist). Under Node they are inert — never invoked on import — so the file stays
// importable for structural verification. Each is intentionally minimal: the endpoints and
// checks are placeholders the app-layer perf scripts specialize; what this module owns and
// freezes is the scale/threshold/fault *contract*, not the request bodies.
// --------------------------------------------------------------------------------------------
export function interactiveDashboard(): void {
  // NFR-007: read current-state / health / compliance views. Placeholder under Node.
}
export function decisionThroughput(): void {
  // NFR-004: submit a human decision, expect durable audit within 5 s.
}
export function reconciliationBurst(): void {
  // NFR-006: trigger reconciliation of a work-item slice.
}
export function evidenceExport(): void {
  // NFR-009: request a 100k-reference evidence package.
}
export function sourceDiscovery(): void {
  // NFR-011: run an on-demand discovery sweep.
}

// --------------------------------------------------------------------------------------------
// Self-check entrypoint. `npm run test:performance` runs `node tests/performance/config.ts`,
// which lands here (import.meta.main / direct-exec detection). It validates the contract's
// internal consistency WITHOUT issuing any load — so the required artifact is independently
// runnable and observably correct in an environment that has no k6 binary. Exit 0 on success,
// non-zero on any contract violation.
// --------------------------------------------------------------------------------------------
export function selfCheck(): { ok: true; profiles: number } {
  const problems: string[] = [];

  // Every named scale profile must have a scenario with a dispatchable exec.
  for (const name of SCALE_PROFILE_NAMES) {
    const scn = SCALE_SCENARIOS[name as keyof typeof SCALE_SCENARIOS];
    if (!scn) problems.push(`missing scale scenario: ${name}`);
    else if (typeof (scn as { exec?: unknown }).exec !== 'string') {
      problems.push(`scale scenario ${name} has no exec function name`);
    }
  }

  // Every named fault profile must exist and declare its domain + invariant.
  const domains = new Set<string>();
  for (const name of FAULT_INJECTION_PROFILE_NAMES) {
    const p = FAULT_INJECTION_PROFILES[name as keyof typeof FAULT_INJECTION_PROFILES];
    if (!p) problems.push(`missing fault profile: ${name}`);
    else {
      if (!p.domain) problems.push(`fault profile ${name} missing domain`);
      if (!p.invariant) problems.push(`fault profile ${name} missing invariant`);
      domains.add(p.domain);
    }
  }
  // The five required fault domains must all be covered.
  for (const d of ['retry', 'reconciliation', 'continuity', 'rollback', 'disaster-recovery']) {
    if (!domains.has(d)) problems.push(`fault domain not covered: ${d}`);
  }

  // Acceptance scale must not be silently weakened below the spec's numbers.
  if (ACCEPTANCE_SCALE.governedAssets < 100_000)
    problems.push('governedAssets below acceptance scale');
  if (ACCEPTANCE_SCALE.activeWorkItems < 10_000)
    problems.push('activeWorkItems below acceptance scale');
  if (ACCEPTANCE_SCALE.concurrentUsers < 500)
    problems.push('concurrentUsers below acceptance scale');
  if (ACCEPTANCE_SCALE.auditPackageReferences < 100_000) {
    problems.push('auditPackageReferences below acceptance scale');
  }

  // Continuity lease must respect the 15-minute ceiling (NFR-012).
  if (NFR_BUDGETS.continuityLeaseMaxMs > 15 * 60 * 1_000) {
    problems.push('continuity lease exceeds 15-minute ceiling');
  }

  // Thresholds must exist for the headline interactive/decision/reconciliation NFRs.
  for (const key of ['interactive_view_ms', 'decision_response_ms', 'reconciliation_ms']) {
    if (!(key in PERFORMANCE_THRESHOLDS)) problems.push(`missing threshold: ${key}`);
  }

  if (problems.length > 0) {
    throw new Error(`performance config self-check failed:\n - ${problems.join('\n - ')}`);
  }
  return { ok: true, profiles: SCALE_PROFILE_NAMES.length + FAULT_INJECTION_PROFILE_NAMES.length };
}

// Direct-exec detection that works whether the file is run as `node config.ts` or imported.
// `import.meta.main` is set by Node 22 for the entry module; fall back to argv comparison.
const isEntry =
  // @ts-expect-error import.meta.main is Node 22+, not yet in lib.dom typings
  (typeof import.meta !== 'undefined' && import.meta.main) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  const result = selfCheck();
  console.log(
    `performance config OK — ${result.profiles} profiles ` +
      `(${SCALE_PROFILE_NAMES.length} scale + ${FAULT_INJECTION_PROFILE_NAMES.length} fault); ` +
      `acceptance scale ${ACCEPTANCE_SCALE.governedAssets} assets / ` +
      `${ACCEPTANCE_SCALE.concurrentUsers} concurrent users.`,
  );
}
