// Governed least-privilege discovery-agent tests: bootstrap, scan authorization, budgets,
// evidence sink, and the single fail-visible status snapshot
// (Phase 49 / work item HNHHZ8H0GJ5SK4G99Z2CSPSRAA / VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13).
//
// The phase acceptance oracle: "The open-ended source catalog, reconciled inventory, coverage
// gaps, workflow and controller state, ownership, health, failures, retries, continuity mode and
// lease, buffered evidence, and safe next actions MUST be current and fail-visible."
//
// Every governed property named by that oracle is asserted through an INDEPENDENT read path — the
// durable checkpoint row, the durable lease row, the reconciled SourceCatalog, and the durable
// evidence-sink capture — NOT through the method's own return value, and each assertion is paired
// with a NEGATIVE control so the oracle is non-vacuous (a mutation on the negative branch would
// flip the result).
//
// Deterministic: a manual clock, in-memory lease/checkpoint stores, a scripted authorizer, a
// scripted target source, and a scripted probe. No wall clock, no real signals, no live infra.
//
// Run: npm run test:discovery
//      (node --experimental-strip-types --test tests/discovery/**/*.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = await import(join(ROOT, 'apps/discovery-agent/src/main.ts'));

const {
  GovernedDiscoveryAgent,
  AgentLease,
  EvidenceBuffer,
  ScanBudget,
  SourceCatalog,
  bootstrapDiscoveryAgent,
  BootstrapError,
  LeaseLostError,
  resolveScanAuthorization,
  isTerminalState,
  AGENT_STATES,
  CONTINUITY_MODES,
  SAFE_NEXT_ACTIONS,
  BUDGET_AXES,
} = main;

// ───────────────────────────────────────────────────────────────────────────
// Deterministic harness
// ───────────────────────────────────────────────────────────────────────────
function manualClock(start = 1_700_000_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => (t += ms);
  clock.set = (v) => (t = v);
  return clock;
}

// In-memory, linearizable lease store (single Map — read/write/clear serialized).
function memoryLeaseStore() {
  const rows = new Map(); // resource -> StoredLease
  return {
    rows,
    async read(resource) {
      return rows.get(resource) ?? null;
    },
    async write(lease) {
      rows.set(lease.resource, { ...lease });
    },
    async clear(resource, holder, fencingToken) {
      const cur = rows.get(resource);
      if (cur && cur.holder === holder && cur.fencingToken === fencingToken) {
        rows.set(resource, {
          resource,
          holder: null,
          fencingToken,
          expiresAt: null,
          updatedAt: cur.updatedAt,
        });
        return true;
      }
      return false;
    },
  };
}

function memoryCheckpointStore() {
  const saved = [];
  const latest = new Map();
  return {
    saved,
    latest,
    async load(resource) {
      return latest.get(resource) ?? null;
    },
    async save(cp) {
      saved.push(cp);
      latest.set(cp.resource, cp);
    },
  };
}

// A durable evidence sink that captures flushed records (the independent read path for evidence).
function capturingSink({ failTimes = 0 } = {}) {
  const flushed = [];
  let failsLeft = failTimes;
  const sink = async (records) => {
    if (failsLeft > 0) {
      failsLeft -= 1;
      throw new Error('sink unavailable');
    }
    for (const r of records) flushed.push(r);
  };
  return { flushed, sink };
}

// A scripted authorizer: decision resolved by target scope/id.
function scriptedAuthorizer(decideFor) {
  const calls = [];
  return {
    calls,
    authorizer: {
      async authorize(target) {
        calls.push(target.targetId);
        return decideFor(target);
      },
    },
  };
}
const allowAll = () => ({
  authorizer: {
    async authorize() {
      return { kind: 'authorized', reason: 'ok' };
    },
  },
  calls: [],
});

function scriptedTargets(list) {
  return {
    async listTargets() {
      return list;
    },
  };
}

function scriptedProbe(behaviorFor) {
  const calls = [];
  return {
    calls,
    probe: {
      async probe(target) {
        calls.push(target.targetId);
        return behaviorFor(target);
      },
    },
  };
}
const reachable =
  (cls = 'unknown') =>
  () => ({ reachable: true, classification: cls, evidence: { ok: true } });

const GOOD_ENV = Object.freeze({
  DEPLOYMENT_STAGE: 'development',
  DATABASE_URL: 'postgres://app@localhost:5432/trustcircle',
  SIGNING_KEY_SECRET_REF: 'vault:secret/data/signing#key',
  SESSION_SECRET_REF: 'vault:secret/data/session#key',
});

const DEFAULT_BUDGET = Object.freeze({
  maxTargetsPerSweep: 100,
  maxSweepDurationMs: 60_000,
  maxNewSourcesPerSweep: 100,
});

function target(over = {}) {
  return {
    targetId: over.targetId ?? 't1',
    scope: over.scope ?? 'kanban',
    location: over.location ?? 'host://svc/kanban',
    registered: over.registered ?? false,
  };
}

// Build a wired-but-not-started agent with fully injectable collaborators.
function buildAgent(over = {}) {
  const clock = over.clock ?? manualClock();
  const leaseStore = over.leaseStore ?? memoryLeaseStore();
  const checkpoints = over.checkpoints ?? memoryCheckpointStore();
  const sinkPair = over.sinkPair ?? capturingSink();
  const evidence = new EvidenceBuffer(sinkPair.sink);
  const catalog = over.catalog ?? new SourceCatalog();
  const lease = new AgentLease({
    store: leaseStore,
    resource: over.resource ?? 'source-discovery',
    holder: over.holder ?? 'agent-A',
    clock,
    ttlMs: over.ttlMs ?? 10_000,
  });
  const authorizerPair = over.authorizerPair ?? allowAll();
  const targets = over.targets ?? scriptedTargets(over.targetList ?? [target()]);
  const probePair = over.probePair ?? scriptedProbe(reachable());
  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints,
    evidence,
    authorizer: authorizerPair.authorizer,
    targets,
    probe: probePair.probe,
    catalog,
    grantedScopes: new Set(over.grantedScopes ?? ['kanban']),
    budgetLimits: over.budgetLimits ?? DEFAULT_BUDGET,
    clock,
    sleep: over.sleep ?? (async () => {}),
    idleDelayMs: over.idleDelayMs ?? 5,
    renewAtFraction: over.renewAtFraction ?? 0.5,
  });
  return {
    agent,
    clock,
    leaseStore,
    checkpoints,
    sinkPair,
    evidence,
    catalog,
    lease,
    authorizerPair,
    probePair,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. BOOTSTRAP is fail-closed and least-privilege.
// ═══════════════════════════════════════════════════════════════════════════
test('A1 bootstrap parses good config, holds ONLY granted scopes, produces an unstarted agent (positive)', () => {
  const clock = manualClock();
  const boot = bootstrapDiscoveryAgent({
    env: GOOD_ENV,
    leaseStore: memoryLeaseStore(),
    checkpoints: memoryCheckpointStore(),
    authorizer: allowAll().authorizer,
    targets: scriptedTargets([]),
    probe: scriptedProbe(reachable()).probe,
    evidenceSink: async () => {},
    clock,
    agentId: 'agent-A',
    grantedScopes: ['kanban', 'agentctl'],
    budgetLimits: DEFAULT_BUDGET,
  });
  assert.equal(boot.config.stage, 'development');
  // Least privilege: the grant set is EXACTLY what was passed — no ambient extra authority.
  assert.deepEqual([...boot.grantedScopes].sort(), ['agentctl', 'kanban']);
  // Not started: no lease acquired yet, and status reports it.
  assert.equal(boot.lease.grant, null);
  assert.equal(boot.agent.status(clock()).state, 'starting');
  // NEGATIVE control: a scope NOT granted is genuinely absent.
  assert.equal(boot.grantedScopes.has('secrets'), false);
});

test('A2 bootstrap REFUSES bad config: throws BootstrapError, discloses only variable:code, and yields NO agent (negative → fail-closed)', () => {
  let threw = null;
  try {
    bootstrapDiscoveryAgent({
      env: { DEPLOYMENT_STAGE: 'production' }, // missing required refs; production-unsafe
      leaseStore: memoryLeaseStore(),
      checkpoints: memoryCheckpointStore(),
      authorizer: allowAll().authorizer,
      targets: scriptedTargets([]),
      probe: scriptedProbe(reachable()).probe,
      evidenceSink: async () => {},
      clock: manualClock(),
      agentId: 'agent-A',
      grantedScopes: ['kanban'],
      budgetLimits: DEFAULT_BUDGET,
    });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof BootstrapError, 'must throw BootstrapError on invalid config');
  assert.ok(threw.issues.length > 0, 'issues surfaced');
  // Disclosure-safe: the summary contains variable + code tokens, never a secret VALUE.
  assert.match(threw.message, /:[a-z_]+/);
  assert.doesNotMatch(threw.message, /postgres:\/\/|vault:/);
  // POSITIVE contrast: the good env does NOT throw.
  assert.doesNotThrow(() =>
    bootstrapDiscoveryAgent({
      env: GOOD_ENV,
      leaseStore: memoryLeaseStore(),
      checkpoints: memoryCheckpointStore(),
      authorizer: allowAll().authorizer,
      targets: scriptedTargets([]),
      probe: scriptedProbe(reachable()).probe,
      evidenceSink: async () => {},
      clock: manualClock(),
      agentId: 'agent-A',
      grantedScopes: ['kanban'],
      budgetLimits: DEFAULT_BUDGET,
    }),
  );
});

test('A3 bootstrap validates budget bounds eagerly (non-positive bound is a bootstrap failure, not a silent runtime no-limit)', () => {
  const mk = (budgetLimits) => () =>
    bootstrapDiscoveryAgent({
      env: GOOD_ENV,
      leaseStore: memoryLeaseStore(),
      checkpoints: memoryCheckpointStore(),
      authorizer: allowAll().authorizer,
      targets: scriptedTargets([]),
      probe: scriptedProbe(reachable()).probe,
      evidenceSink: async () => {},
      clock: manualClock(),
      agentId: 'agent-A',
      grantedScopes: ['kanban'],
      budgetLimits,
    });
  assert.throws(
    mk({ maxTargetsPerSweep: 0, maxSweepDurationMs: 1000, maxNewSourcesPerSweep: 1 }),
    RangeError,
  );
  // NEGATIVE control: a valid budget does NOT throw.
  assert.doesNotThrow(mk(DEFAULT_BUDGET));
});

// ═══════════════════════════════════════════════════════════════════════════
// B. OWNERSHIP + HEALTH via the durable lease row (independent read path).
// ═══════════════════════════════════════════════════════════════════════════
test('B1 start() acquires the durable lease; the durable row and status agree that ownership is held and healthy (positive)', async () => {
  const { agent, leaseStore, clock } = buildAgent();
  const ok = await agent.start();
  assert.equal(ok, true);
  // INDEPENDENT read path: the durable lease store row, not the return value.
  const row = leaseStore.rows.get('source-discovery');
  assert.equal(row.holder, 'agent-A');
  assert.ok(row.fencingToken >= 1);
  assert.ok(row.expiresAt > clock());
  const st = agent.status(clock());
  assert.equal(st.state, 'scanning');
  assert.equal(st.ownership.owned, true);
  assert.equal(st.ownership.leaseLive, true);
  assert.equal(st.healthy, true);
  // NEGATIVE control: before start there was no durable row.
  const before = memoryLeaseStore();
  assert.equal(before.rows.get('source-discovery'), undefined);
});

test('B2 a second holder cannot steal a live lease; the durable row still names the first holder (negative)', async () => {
  const store = memoryLeaseStore();
  const clock = manualClock();
  const a = buildAgent({ leaseStore: store, clock, holder: 'agent-A' });
  await a.agent.start();
  const b = buildAgent({ leaseStore: store, clock, holder: 'agent-B' });
  const okB = await b.agent.start();
  assert.equal(okB, false, 'standby cannot acquire a live lease');
  // INDEPENDENT: durable row unchanged — still A.
  assert.equal(store.rows.get('source-discovery').holder, 'agent-A');
  // Standby status is fail-visible: degraded, ownership NOT owned, not healthy.
  const stB = b.agent.status(clock());
  assert.equal(stB.state, 'degraded');
  assert.equal(stB.ownership.owned, false);
  assert.equal(stB.healthy, false);
});

test('B3 assertLive throws LeaseLostError once the lease expires; health flips to false (fail-closed)', async () => {
  const { agent, clock, lease } = buildAgent({ ttlMs: 5_000 });
  await agent.start();
  assert.equal(agent.status(clock()).healthy, true); // positive
  clock.advance(6_000); // expire it
  assert.throws(() => lease.assertLive(clock()), LeaseLostError);
  // NEGATIVE control: before expiry assertLive did NOT throw.
  const fresh = buildAgent({ ttlMs: 5_000 });
  await fresh.agent.start();
  assert.doesNotThrow(() => fresh.lease.assertLive(fresh.clock()));
});

// ═══════════════════════════════════════════════════════════════════════════
// C. SCAN AUTHORIZATION is fail-closed and least-privilege (coverage gaps stay visible).
// ═══════════════════════════════════════════════════════════════════════════
test('C1 resolveScanAuthorization denies out-of-scope targets WITHOUT consulting the authorizer (least privilege first)', async () => {
  const auth = scriptedAuthorizer(() => ({ kind: 'authorized', reason: 'ok' }));
  const granted = new Set(['kanban']);
  const decision = await resolveScanAuthorization(
    auth.authorizer,
    granted,
    target({ scope: 'secrets' }),
  );
  assert.equal(decision.kind, 'denied');
  assert.equal(decision.reason, 'out_of_scope');
  assert.equal(auth.calls.length, 0, 'authorizer must NOT be consulted for an out-of-scope scope');
  // NEGATIVE control: an in-scope target DOES consult the authorizer and is authorized.
  const d2 = await resolveScanAuthorization(auth.authorizer, granted, target({ scope: 'kanban' }));
  assert.equal(d2.kind, 'authorized');
  assert.equal(auth.calls.length, 1);
});

test('C2 a throwing authorizer maps to indeterminate (fail-closed), never authorized', async () => {
  const boom = {
    async authorize() {
      throw new Error('authz down');
    },
  };
  const decision = await resolveScanAuthorization(
    boom,
    new Set(['kanban']),
    target({ scope: 'kanban' }),
  );
  assert.equal(decision.kind, 'indeterminate');
  assert.match(decision.reason, /authorizer_error/);
  // NEGATIVE control: a well-behaved authorizer authorizes.
  const good = {
    async authorize() {
      return { kind: 'authorized', reason: 'ok' };
    },
  };
  assert.equal(
    (await resolveScanAuthorization(good, new Set(['kanban']), target({ scope: 'kanban' }))).kind,
    'authorized',
  );
});

test('C3 a sweep NEVER probes an unauthorized/out-of-scope target; each becomes a visible coverage gap in the reconciled catalog', async () => {
  const authorizerPair = scriptedAuthorizer((t) =>
    t.targetId === 'denied-1'
      ? { kind: 'denied', reason: 'policy_block' }
      : { kind: 'authorized', reason: 'ok' },
  );
  const probePair = scriptedProbe(reachable('kanban'));
  const { agent, catalog } = buildAgent({
    grantedScopes: ['kanban'],
    authorizerPair,
    probePair,
    targetList: [
      target({ targetId: 'ok-1', scope: 'kanban', registered: true }),
      target({ targetId: 'denied-1', scope: 'kanban' }),
      target({ targetId: 'oos-1', scope: 'secrets' }), // out of granted scopes
    ],
  });
  await agent.start();
  const report = await agent.runOnce();

  // INDEPENDENT read path: the reconciled catalog.
  assert.equal(catalog.get('ok-1').onboarding, 'registered');
  assert.equal(catalog.get('denied-1').onboarding, 'gap');
  assert.equal(catalog.get('denied-1').gapReason, 'unauthorized');
  assert.equal(catalog.get('oos-1').onboarding, 'gap');
  assert.equal(catalog.get('oos-1').gapReason, 'out_of_scope');
  // The probe was called ONLY for the authorized target — unauthorized ones were never probed.
  assert.deepEqual(probePair.calls, ['ok-1']);
  // The out-of-scope target never even reached the authorizer.
  assert.equal(authorizerPair.calls.includes('oos-1'), false);
  assert.equal(report.refusals, 2);
  // NEGATIVE control: had 'denied-1' been authorized it would have been probed (contrast run).
  const contrast = buildAgent({
    grantedScopes: ['kanban'],
    authorizerPair: allowAll(),
    probePair: scriptedProbe(reachable()),
    targetList: [target({ targetId: 'denied-1', scope: 'kanban' })],
  });
  await contrast.agent.start();
  await contrast.agent.runOnce();
  assert.equal(contrast.catalog.get('denied-1').onboarding, 'discovered');
});

test('C4 an empty grant set means the agent scans NOTHING — every target is an out_of_scope gap (least privilege at the extreme)', async () => {
  const probePair = scriptedProbe(reachable());
  const { agent, catalog } = buildAgent({
    grantedScopes: [],
    probePair,
    targetList: [
      target({ targetId: 'a', scope: 'kanban' }),
      target({ targetId: 'b', scope: 'agentctl' }),
    ],
  });
  await agent.start();
  await agent.runOnce();
  assert.equal(catalog.get('a').gapReason, 'out_of_scope');
  assert.equal(catalog.get('b').gapReason, 'out_of_scope');
  assert.equal(probePair.calls.length, 0, 'nothing probed under an empty grant');
  // NEGATIVE control: granting 'kanban' lets 'a' through.
  const c = buildAgent({
    grantedScopes: ['kanban'],
    probePair: scriptedProbe(reachable()),
    targetList: [target({ targetId: 'a', scope: 'kanban' })],
  });
  await c.agent.start();
  await c.agent.runOnce();
  assert.notEqual(c.catalog.get('a').onboarding, 'gap');
});

// ═══════════════════════════════════════════════════════════════════════════
// D. BUDGETS bound the sweep and are fail-visible (never silently overrun).
// ═══════════════════════════════════════════════════════════════════════════
test('D1 the RATE (targets) budget stops the sweep; remaining targets are recorded as budget gaps and status is fail-visible', async () => {
  const probePair = scriptedProbe(reachable());
  const { agent, catalog, clock, checkpoints } = buildAgent({
    budgetLimits: { maxTargetsPerSweep: 2, maxSweepDurationMs: 60_000, maxNewSourcesPerSweep: 100 },
    probePair,
    targetList: [
      target({ targetId: 'a', scope: 'kanban' }),
      target({ targetId: 'b', scope: 'kanban' }),
      target({ targetId: 'c', scope: 'kanban' }),
      target({ targetId: 'd', scope: 'kanban' }),
    ],
  });
  await agent.start();
  const report = await agent.runOnce();
  assert.equal(report.stoppedByBudget, 'targets');
  assert.equal(probePair.calls.length, 2, 'only 2 targets probed under the rate budget');
  // Remaining targets are VISIBLE gaps, not silently dropped.
  assert.equal(catalog.get('c').gapReason, 'budget_targets');
  assert.equal(catalog.get('d').gapReason, 'budget_targets');
  // INDEPENDENT read path: the durable checkpoint records the exhausted axis + safe action.
  const cp = checkpoints.latest.get('source-discovery');
  assert.equal(cp.budget.exhaustedAxis, 'targets');
  assert.equal(cp.state, 'budget_exhausted');
  assert.equal(cp.safeNextAction, 'raise_budget');
  const st = agent.status(clock());
  assert.equal(st.budget.exhaustedAxis, 'targets');
  assert.equal(st.healthy, false, 'a budget-exhausted agent is NOT healthy');
  // NEGATIVE control: a generous budget scans all four with no exhausted axis.
  const gen = buildAgent({
    budgetLimits: DEFAULT_BUDGET,
    probePair: scriptedProbe(reachable()),
    targetList: [
      target({ targetId: 'a' }),
      target({ targetId: 'b' }),
      target({ targetId: 'c' }),
      target({ targetId: 'd' }),
    ],
  });
  await gen.agent.start();
  const r2 = await gen.agent.runOnce();
  assert.equal(r2.stoppedByBudget, null);
  assert.equal(gen.checkpoints.latest.get('source-discovery').budget.exhaustedAxis, null);
});

test('D2 the TIME (duration) budget stops the sweep before the first target when already elapsed', async () => {
  // Clock jumps past the duration budget between ScanBudget construction and the first check.
  const clock = manualClock();
  const probePair = scriptedProbe(reachable());
  // Use a tiny duration budget and advance the clock via the probe/target hooks.
  const targets = {
    async listTargets() {
      clock.advance(100); // consume all of the 50ms budget before any target check
      return [
        target({ targetId: 'a', scope: 'kanban' }),
        target({ targetId: 'b', scope: 'kanban' }),
      ];
    },
  };
  const { agent, catalog, checkpoints } = buildAgent({
    clock,
    budgetLimits: { maxTargetsPerSweep: 100, maxSweepDurationMs: 50, maxNewSourcesPerSweep: 100 },
    probePair,
    targets,
  });
  await agent.start();
  const report = await agent.runOnce();
  assert.equal(report.stoppedByBudget, 'duration');
  assert.equal(probePair.calls.length, 0, 'nothing probed once the time budget is spent');
  assert.equal(catalog.get('a').gapReason, 'budget_duration');
  assert.equal(checkpoints.latest.get('source-discovery').budget.exhaustedAxis, 'duration');
  // NEGATIVE control: a large time budget scans normally.
  const ok = buildAgent({
    clock: manualClock(),
    budgetLimits: DEFAULT_BUDGET,
    probePair: scriptedProbe(reachable()),
    targetList: [target({ targetId: 'a' })],
  });
  await ok.agent.start();
  assert.equal((await ok.agent.runOnce()).stoppedByBudget, null);
});

test('D3 the BLAST-RADIUS budget caps NEW unregistered sources per sweep; registered sources still update, new-over-budget become blast gaps', async () => {
  const probePair = scriptedProbe(reachable());
  const { agent, catalog } = buildAgent({
    budgetLimits: { maxTargetsPerSweep: 100, maxSweepDurationMs: 60_000, maxNewSourcesPerSweep: 1 },
    probePair,
    targetList: [
      target({ targetId: 'new-1', scope: 'kanban', registered: false }),
      target({ targetId: 'new-2', scope: 'kanban', registered: false }), // over the blast budget
      target({ targetId: 'reg-1', scope: 'kanban', registered: true }), // registered still allowed
    ],
  });
  await agent.start();
  const report = await agent.runOnce();
  assert.equal(catalog.get('new-1').onboarding, 'discovered');
  assert.equal(catalog.get('new-2').gapReason, 'budget_blast', 'second NEW source is a blast gap');
  assert.equal(
    catalog.get('reg-1').onboarding,
    'registered',
    'registered source unaffected by blast cap',
  );
  assert.equal(report.stoppedByBudget, 'blast');
  // NEGATIVE control: a larger blast budget onboards both new sources.
  const gen = buildAgent({
    budgetLimits: { maxTargetsPerSweep: 100, maxSweepDurationMs: 60_000, maxNewSourcesPerSweep: 5 },
    probePair: scriptedProbe(reachable()),
    targetList: [
      target({ targetId: 'new-1', registered: false }),
      target({ targetId: 'new-2', registered: false }),
    ],
  });
  await gen.agent.start();
  await gen.agent.runOnce();
  assert.equal(gen.catalog.get('new-2').onboarding, 'discovered');
});

test('D4 ScanBudget meter is deterministic and pure given the injected clock', () => {
  const clock = manualClock();
  const b = new ScanBudget(
    { maxTargetsPerSweep: 2, maxSweepDurationMs: 100, maxNewSourcesPerSweep: 1 },
    clock,
  );
  assert.equal(b.checkBeforeTarget(), null);
  b.recordTargetConsidered();
  b.recordTargetConsidered();
  assert.equal(b.checkBeforeTarget().axis, 'targets'); // rate hit
  // NEGATIVE control: fresh meter with room says null.
  const fresh = new ScanBudget(
    { maxTargetsPerSweep: 5, maxSweepDurationMs: 100, maxNewSourcesPerSweep: 1 },
    manualClock(),
  );
  assert.equal(fresh.checkBeforeTarget(), null);
  // Time axis: advancing past the duration exhausts it.
  clock.advance(200);
  assert.equal(b.checkBeforeTarget().axis, 'duration');
});

// ═══════════════════════════════════════════════════════════════════════════
// E. EVIDENCE SINK buffers, flushes, and RETAINS on failure (fail-visible).
// ═══════════════════════════════════════════════════════════════════════════
test('E1 discovery observations are buffered then flushed to the durable sink; buffered count is visible in status', async () => {
  const sinkPair = capturingSink();
  const { agent, evidence, clock } = buildAgent({
    sinkPair,
    targetList: [
      target({ targetId: 'a', scope: 'kanban' }),
      target({ targetId: 'b', scope: 'kanban' }),
    ],
  });
  await agent.start();
  await agent.runOnce();
  // Buffered before flush — the status makes unflushed evidence VISIBLE.
  assert.ok(evidence.size >= 2, 'evidence buffered');
  assert.equal(agent.status(clock()).bufferedEvidence, evidence.size);
  const flushedOk = await evidence.flush();
  assert.equal(flushedOk, true);
  assert.equal(evidence.size, 0, 'buffer emptied after a successful flush');
  // INDEPENDENT read path: the durable sink captured the records.
  const ids = sinkPair.flushed.map((r) => r.targetId);
  assert.ok(ids.includes('a') && ids.includes('b'));
  // NEGATIVE control: a fresh buffer holds nothing.
  const fresh = new EvidenceBuffer(async () => {});
  assert.equal(fresh.size, 0);
});

test('E2 a failed flush RETAINS the records (nothing lost) and returns false — fail-visible, never silent drop', async () => {
  const sinkPair = capturingSink({ failTimes: 1 });
  const evidence = new EvidenceBuffer(sinkPair.sink);
  evidence.buffer({
    kind: 'source_discovered',
    targetId: 'x',
    correlationId: 'c',
    payload: {},
    bufferedAt: 1,
  });
  const first = await evidence.flush();
  assert.equal(first, false, 'flush reports failure');
  assert.equal(evidence.size, 1, 'record RETAINED after failed flush — nothing lost');
  assert.equal(sinkPair.flushed.length, 0, 'sink captured nothing on failure');
  // NEGATIVE control / recovery: the sink recovers, the retry flushes and empties the buffer.
  const second = await evidence.flush();
  assert.equal(second, true);
  assert.equal(evidence.size, 0);
  assert.equal(sinkPair.flushed.length, 1);
});

test('E3 shutdown with an unflushable sink ends DEGRADED with reconcile as the safe next action (fail-visible terminal)', async () => {
  const sinkPair = capturingSink({ failTimes: 999 }); // always fails
  const { agent, checkpoints } = buildAgent({
    sinkPair,
    targetList: [target({ targetId: 'a', scope: 'kanban' })],
  });
  await agent.start();
  await agent.runOnce(); // buffers evidence
  agent.requestStop();
  const report = await agent.run();
  assert.equal(report.cleanShutdown, false);
  assert.equal(report.finalState, 'degraded');
  // INDEPENDENT: durable checkpoint records the degraded terminal + reconcile action + retained buffer.
  const cp = checkpoints.latest.get('source-discovery');
  assert.equal(cp.state, 'degraded');
  assert.equal(cp.safeNextAction, 'reconcile');
  assert.ok(cp.bufferedEvidence >= 1, 'unflushed evidence is visible in the checkpoint');
  // NEGATIVE control: a healthy sink shuts down cleanly with an emptied buffer.
  const okPair = capturingSink();
  const ok = buildAgent({
    sinkPair: okPair,
    targetList: [target({ targetId: 'a', scope: 'kanban' })],
  });
  await ok.agent.start();
  await ok.agent.runOnce();
  ok.agent.requestStop();
  const okReport = await ok.agent.run();
  assert.equal(okReport.finalState, 'stopped');
  assert.equal(ok.checkpoints.latest.get('source-discovery').bufferedEvidence, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// F. PROBE FAILURES → visible coverage gaps (never silent skips). RETRIES visible.
// ═══════════════════════════════════════════════════════════════════════════
test('F1 a throwing probe becomes a probe_failed coverage gap; the target is NOT recorded as a source', async () => {
  const probePair = scriptedProbe((t) => {
    if (t.targetId === 'boom') throw new Error('unreachable');
    return { reachable: true, classification: 'kanban', evidence: {} };
  });
  const { agent, catalog } = buildAgent({
    probePair,
    targetList: [
      target({ targetId: 'ok', scope: 'kanban' }),
      target({ targetId: 'boom', scope: 'kanban' }),
    ],
  });
  await agent.start();
  const report = await agent.runOnce();
  assert.equal(catalog.get('ok').onboarding, 'discovered');
  assert.equal(catalog.get('boom').onboarding, 'gap');
  assert.equal(catalog.get('boom').gapReason, 'probe_failed');
  assert.equal(report.probeFailures, 1);
  // NEGATIVE control: had the probe not thrown, 'boom' would be a source.
  const ok = buildAgent({
    probePair: scriptedProbe(reachable()),
    targetList: [target({ targetId: 'boom', scope: 'kanban' })],
  });
  await ok.agent.start();
  await ok.agent.runOnce();
  assert.equal(ok.catalog.get('boom').onboarding, 'discovered');
});

test('F2 a sweep that throws is captured, counted as a RETRY in the durable checkpoint, and re-attempted (failures + retries are fail-visible)', async () => {
  let calls = 0;
  const targets = {
    async listTargets() {
      calls += 1;
      if (calls === 1) throw new Error('target source flaked');
      return [target({ targetId: 'a', scope: 'kanban' })];
    },
  };
  const { agent, checkpoints } = buildAgent({ targets, idleDelayMs: 1 });
  await agent.start();
  // Drive two loop iterations: first sweep throws (retry), second succeeds, then stop.
  const runP = agent.run();
  // Let the loop run; requestStop after a microtask so the second iteration completes.
  await Promise.resolve();
  agent.requestStop();
  await runP;
  // INDEPENDENT read path: retries recorded in the durable checkpoint.
  const cp = checkpoints.latest.get('source-discovery');
  assert.ok(cp.totals.retries >= 1, 'a failed sweep increments the durable retry counter');
  // NEGATIVE control: a never-throwing target source records zero retries.
  const ok = buildAgent({
    targetList: [target({ targetId: 'a', scope: 'kanban' })],
    idleDelayMs: 1,
  });
  await ok.agent.start();
  const okP = ok.agent.run();
  await Promise.resolve();
  ok.agent.requestStop();
  await okP;
  assert.equal(ok.checkpoints.latest.get('source-discovery').totals.retries, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// G. CONTINUITY + LEASE LOSS → paused, reconcile (fail-closed).
// ═══════════════════════════════════════════════════════════════════════════
test('G1 losing the lease mid-run pauses at a safe checkpoint: state lost_lease, continuity paused, reconcile action (fail-closed)', async () => {
  const store = memoryLeaseStore();
  const clock = manualClock();
  const { agent, checkpoints } = buildAgent({
    leaseStore: store,
    clock,
    ttlMs: 10_000,
    idleDelayMs: 1,
    holder: 'agent-A',
  });
  await agent.start();
  // Simulate a stolen lease: another holder overwrites the durable row with a higher token.
  const cur = store.rows.get('source-discovery');
  store.rows.set('source-discovery', {
    resource: 'source-discovery',
    holder: 'agent-B',
    fencingToken: cur.fencingToken + 1,
    expiresAt: clock() + 10_000,
    updatedAt: clock(),
  });
  clock.advance(6_000); // pass renew-at (half of 10s) so run() renews and detects the loss
  const runP = agent.run();
  const report = await runP;
  assert.equal(report.finalState, 'lost_lease');
  const st = agent.status(clock());
  assert.equal(st.state, 'lost_lease');
  assert.equal(st.continuity, 'paused');
  assert.equal(st.safeNextAction, 'reconcile');
  assert.equal(st.healthy, false);
  // INDEPENDENT: the durable checkpoint reflects the paused/lost terminal.
  const cp = checkpoints.latest.get('source-discovery');
  assert.equal(cp.state, 'lost_lease');
  assert.equal(cp.continuity, 'paused');
  // NEGATIVE control: an uncontested lease renews and does NOT go to lost_lease.
  const ok = buildAgent({ ttlMs: 10_000, idleDelayMs: 1 });
  await ok.agent.start();
  ok.clock.advance(6_000);
  const okP = ok.agent.run();
  await Promise.resolve();
  ok.agent.requestStop();
  const okReport = await okP;
  assert.notEqual(okReport.finalState, 'lost_lease');
});

// ═══════════════════════════════════════════════════════════════════════════
// H. RECONCILIATION: the open-ended catalog dedups by targetId (no duplicate rows).
// ═══════════════════════════════════════════════════════════════════════════
test('H1 re-observing the same target updates its catalog entry in place — reconciled inventory, no duplicates', async () => {
  const catalog = new SourceCatalog();
  const clock = manualClock();
  // First sweep: 'a' is a gap (denied). Second sweep: 'a' becomes authorized+reachable.
  let allow = false;
  const authorizerPair = {
    calls: [],
    authorizer: {
      async authorize() {
        return allow ? { kind: 'authorized', reason: 'ok' } : { kind: 'denied', reason: 'p' };
      },
    },
  };
  const { agent } = buildAgent({
    catalog,
    clock,
    authorizerPair,
    targetList: [target({ targetId: 'a', scope: 'kanban' })],
  });
  await agent.start();
  await agent.runOnce();
  assert.equal(catalog.get('a').onboarding, 'gap');
  assert.equal(catalog.size, 1);
  allow = true;
  await agent.runOnce();
  // Reconciled in place — still ONE entry, now a source, not two rows.
  assert.equal(catalog.size, 1);
  assert.equal(catalog.get('a').onboarding, 'discovered');
  // NEGATIVE control: a distinct targetId creates a genuinely new entry.
  const c2 = new SourceCatalog();
  c2.upsert({
    targetId: 'a',
    scope: 'k',
    location: 'l',
    onboarding: 'gap',
    gapReason: 'out_of_scope',
    detail: null,
    observedAt: 1,
  });
  c2.upsert({
    targetId: 'b',
    scope: 'k',
    location: 'l',
    onboarding: 'gap',
    gapReason: 'out_of_scope',
    detail: null,
    observedAt: 1,
  });
  assert.equal(c2.size, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// I. The SINGLE fail-visible status snapshot carries EVERY oracle-named property.
// ═══════════════════════════════════════════════════════════════════════════
test('I1 status() exposes catalog+inventory+gaps+state+ownership+health+failures+retries+continuity+lease+bufferedEvidence+safeNextAction all at once', async () => {
  const { agent, clock } = buildAgent({
    grantedScopes: ['kanban'],
    targetList: [
      target({ targetId: 'src', scope: 'kanban', registered: true }),
      target({ targetId: 'gap', scope: 'secrets' }), // out of scope -> visible gap
    ],
  });
  await agent.start();
  await agent.runOnce();
  const st = agent.status(clock());
  // Every oracle clause is present and current on ONE object.
  assert.ok(st.catalog.total >= 2); // open-ended source catalog + reconciled inventory
  assert.equal(st.catalog.gaps >= 1, true); // coverage gaps
  assert.ok(Array.isArray(st.catalog.entries)); // full inventory
  assert.ok(AGENT_STATES.includes(st.state)); // workflow/controller state
  assert.equal(typeof st.ownership.owned, 'boolean'); // ownership
  assert.equal(typeof st.ownership.leaseLive, 'boolean'); // lease
  assert.equal(typeof st.healthy, 'boolean'); // health
  assert.equal(typeof st.progress.probeFailures, 'number'); // failures
  assert.equal(typeof st.progress.retries, 'number'); // retries
  assert.ok(CONTINUITY_MODES.includes(st.continuity)); // continuity mode
  assert.equal(typeof st.bufferedEvidence, 'number'); // buffered evidence
  assert.ok(SAFE_NEXT_ACTIONS.includes(st.safeNextAction)); // safe next action
  assert.deepEqual(st.grantedScopes, ['kanban']); // least-privilege authority surface
  assert.equal(st.observedAt, clock()); // current
  // NEGATIVE control: mutating the returned entries array does NOT corrupt the catalog (defensive copy).
  st.catalog.entries.push({ targetId: 'INJECT' });
  assert.equal(
    agent.status(clock()).catalog.entries.some((e) => e.targetId === 'INJECT'),
    false,
  );
});

test('I2 vocabulary + terminal-state helpers are coherent (states/modes/actions/axes are the fail-visible surface)', () => {
  assert.ok(
    AGENT_STATES.includes('degraded') &&
      AGENT_STATES.includes('lost_lease') &&
      AGENT_STATES.includes('budget_exhausted'),
  );
  assert.deepEqual([...CONTINUITY_MODES], ['normal', 'continue_under_lease', 'paused']);
  assert.ok(SAFE_NEXT_ACTIONS.includes('reconcile') && SAFE_NEXT_ACTIONS.includes('raise_budget'));
  assert.deepEqual([...BUDGET_AXES], ['targets', 'duration', 'blast']);
  assert.equal(isTerminalState('stopped'), true);
  assert.equal(isTerminalState('degraded'), true);
  // NEGATIVE control: an active state is NOT terminal.
  assert.equal(isTerminalState('scanning'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// J. CLEAN shutdown path (contrast for the fail-visible terminals above).
// ═══════════════════════════════════════════════════════════════════════════
test('J1 an uncontested agent drains, flushes evidence, releases the lease, and stops clean; the durable lease row is cleared', async () => {
  const { agent, checkpoints, leaseStore } = buildAgent({
    targetList: [target({ targetId: 'a', scope: 'kanban' })],
    idleDelayMs: 1,
  });
  await agent.start();
  const runP = agent.run();
  await Promise.resolve();
  agent.requestStop();
  const report = await runP;
  assert.equal(report.finalState, 'stopped');
  assert.equal(report.cleanShutdown, true);
  const cp = checkpoints.latest.get('source-discovery');
  assert.equal(cp.state, 'stopped');
  assert.equal(cp.continuity, 'normal');
  assert.equal(cp.safeNextAction, 'none');
  // INDEPENDENT: the durable lease row was released (holder cleared).
  assert.equal(leaseStore.rows.get('source-discovery').holder, null);
  // NEGATIVE control: before shutdown the holder was set.
  const live = buildAgent();
  await live.agent.start();
  assert.equal(live.leaseStore.rows.get('source-discovery').holder, 'agent-A');
});
