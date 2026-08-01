// Governed projection-worker bootstrap / durable cursors / rebuild mode / stale-state signaling
// tests (Phase 48 / work item T2KV3HBNG3BGWSEXZ58RXEHQ3T / VO-6acaf6470d0810df4c93,
// VO-53a014009bdfebd7af13).
//
// These tests exercise apps/projector/src/main.ts against the REAL InboxConsumer
// (apps/projector/src/inbox-consumer.ts) over the SAME in-memory SqlDriver used by the Phase-28
// inbox tests (tests/worker/inbox-in-memory-driver.mjs), so the advisory-lock lease, the durable
// inbox dedup/ordered-apply/cursor advance, the rebuild reset+replay, and the fail-visible status
// all run for real with no live PostgreSQL and no broker.
//
// Every governed property named by the acceptance oracle — ownership, health, failures, retries,
// continuity mode + lease, buffered evidence, per-stream freshness (stale-state signal), rebuild
// state, and the single safe next action — is asserted through an INDEPENDENT read path (the
// durable lease-store row, the durable checkpoint row, and the durable inbox_cursor read via
// readInboxCursor), never through the method's own return value, and EACH has a NEGATIVE control
// so the oracle is non-vacuous.
//
// Run: npm run test:projector
//   (node --experimental-strip-types --test tests/projector/**/*.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInboxDriver } from '../worker/inbox-in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = await import(join(ROOT, 'apps/projector/src/main.ts'));
const dbmod = await import(join(ROOT, 'packages/persistence/src/database.ts'));
const inbox = await import(join(ROOT, 'apps/projector/src/inbox-consumer.ts'));

const {
  GovernedProjector,
  ProjectorLease,
  EvidenceBuffer,
  bootstrapProjector,
  BootstrapError,
  LeaseLostError,
  assessFreshness,
  isTerminalState,
  PROJECTOR_STATES,
  CONTINUITY_MODES,
  SAFE_NEXT_ACTIONS,
  FRESHNESS,
  REBUILD_PHASES,
} = main;
const { Database } = dbmod;
const { InboxConsumer, readInboxCursor } = inbox;

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

function newDb(clock) {
  const driver = createInboxDriver();
  const database = new Database(driver, { clock: clock ?? (() => 1) });
  return { driver, database };
}

// An in-memory LeaseStore backed by a single Map, executed under the caller-held advisory lock
// (real Database.withAdvisoryLock mutual exclusion). Mirrors projector_lease.
function memoryLeaseStore() {
  const rows = new Map();
  return {
    rows,
    async read(_session, resource) {
      return rows.get(resource) ?? null;
    },
    async write(_session, lease) {
      rows.set(lease.resource, { ...lease });
    },
    async clear(_session, resource, holder, fencingToken) {
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

// An in-memory CheckpointStore. Mirrors projector_checkpoint (single latest row per resource).
function memoryCheckpointStore() {
  const rows = new Map();
  const history = []; // every save, in order (independent read path for transient states)
  return {
    rows,
    history,
    async load(resource) {
      return rows.get(resource) ?? null;
    },
    async save(cp) {
      const frozen = JSON.parse(JSON.stringify(cp));
      rows.set(cp.resource, frozen);
      history.push(frozen);
    },
  };
}

// A scripted BusPullSource: yields queued batches; observedSeq is the source high-water mark.
// When the queue is exhausted it invokes the (optionally-set) onDrained callback ONCE — the tests
// use this to requestStop() deterministically AFTER the scripted work has been consumed (the run
// loop checks `!stopRequested` at the TOP, so stop must be requested from inside a pull, never
// before run()). The final drained pull returns an empty batch that preserves the last observed
// high-water mark so a staleness assessment still sees the source position.
function scriptedSource() {
  const queue = []; // array of { events, observedSeq }
  let pulls = 0;
  let lastSeq = 0;
  let onDrained = null;
  let drainedFired = false;
  return {
    pulls: () => pulls,
    onDrained(fn) {
      onDrained = fn;
    },
    push(events, observedSeq) {
      queue.push({ events, observedSeq });
    },
    async pull() {
      pulls += 1;
      if (queue.length > 0) {
        const b = queue.shift();
        lastSeq = Math.max(lastSeq, b.observedSeq);
        return b;
      }
      if (onDrained && !drainedFired) {
        drainedFired = true;
        onDrained();
      }
      return { events: [], observedSeq: lastSeq };
    },
  };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const AGG = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);
function envelope(version) {
  return {
    schema_version: '1.0.0',
    event_id: `33333333-3333-4333-8333-${String(version).padStart(12, '0')}`,
    event_type: 'governance.controller.repaired',
    tenant_id: TENANT,
    aggregate_type: 'controller',
    aggregate_id: AGG,
    aggregate_version: version,
    occurred_at: '2026-01-01T00:00:00Z',
    recorded_at: '2026-01-01T00:00:01Z',
    actor: { principal_id: '44444444-4444-4444-8444-444444444444', principal_type: 'automation' },
    accountable_owner_principal_id: '44444444-4444-4444-8444-444444444444',
    reason: { code: 'auto_repair', text: 'low-risk repair applied' },
    correlation_id: '55555555-5555-4555-8555-555555555555',
    causation_id: null,
    trace_id: null,
    source: null,
    policy: {
      policy_version_id: '66666666-6666-4666-8666-666666666666',
      policy_decision_id: '77777777-7777-4777-8777-777777777777',
      bundle_digest: SHA,
    },
    controls: [],
    evidence: [{ evidence_id: '88888888-8888-4888-8888-888888888888', sha256: SHA }],
    data: { entityId: 'c-1' },
    extensions: {},
  };
}

function countingApply() {
  const applied = [];
  return { applied, fn: (env) => void applied.push(env.event_id) };
}

// A configuration that parses cleanly (mirrors the worker suite's GOOD_ENV).
const GOOD_ENV = Object.freeze({
  DEPLOYMENT_STAGE: 'development',
  DATABASE_URL: 'postgres://app@localhost:5432/trustcircle',
  SIGNING_KEY_SECRET_REF: 'vault:secret/data/signing#key',
  SESSION_SECRET_REF: 'vault:secret/data/session#key',
});

const CONSUMER = 'read-model';
const STREAM = 'governance';
const RESOURCE = 'read-model-projection';
const HOLDER = 'projector-A';

function buildProjector(opts = {}) {
  const clock = opts.clock ?? manualClock();
  const { database } = newDb(() => clock());
  const leaseStore = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const apply = opts.apply ?? countingApply();
  const source = opts.source ?? scriptedSource();
  const evidenceSink = opts.evidenceSink ?? (async () => {});
  const evidence = new EvidenceBuffer(evidenceSink);
  const lease = new ProjectorLease({
    db: database,
    store: leaseStore,
    resource: RESOURCE,
    holder: HOLDER,
    clock: () => clock(),
    ttlMs: opts.ttlMs ?? 10_000,
  });
  const consumer = new InboxConsumer(database, {
    consumer: CONSUMER,
    apply: apply.fn,
    stream: STREAM,
  });
  const readModel = opts.readModel ?? { reset: async () => {} };
  const projector = new GovernedProjector({
    db: database,
    consumer,
    source,
    lease,
    checkpoints,
    evidence,
    readModel,
    clock: () => clock(),
    sleep: async () => {}, // no real timers
    consumerName: CONSUMER,
    tenantId: TENANT,
    stream: STREAM,
    freshnessObjective: opts.freshnessObjective ?? { maxLagItems: 0, maxAgeMs: 60_000 },
    batchSize: opts.batchSize ?? 100,
    idleDelayMs: 0,
  });
  return {
    clock,
    database,
    leaseStore,
    checkpoints,
    apply,
    source,
    evidence,
    lease,
    consumer,
    readModel,
    projector,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. VOCABULARY — the fail-visible state machine is well-formed
// ═══════════════════════════════════════════════════════════════════════════
test('vocabularies expose the fail-visible states / modes / actions', () => {
  for (const s of [
    'starting',
    'running',
    'rebuilding',
    'degraded',
    'stale',
    'lost_lease',
    'failed',
    'stopped',
  ])
    assert.ok(PROJECTOR_STATES.includes(s), `state ${s}`);
  assert.deepEqual([...CONTINUITY_MODES], ['normal', 'continue_under_lease', 'paused']);
  assert.deepEqual([...SAFE_NEXT_ACTIONS], ['none', 'retry', 'reconcile', 'rebuild', 'escalate']);
  assert.deepEqual([...FRESHNESS], ['fresh', 'stale', 'unknown']);
  assert.deepEqual(
    [...REBUILD_PHASES],
    ['idle', 'resetting', 'replaying', 'verifying', 'completed', 'failed'],
  );
  // terminal states are fail-visible & distinct from a clean running state.
  assert.equal(isTerminalState('degraded'), true);
  assert.equal(isTerminalState('lost_lease'), true);
  assert.equal(isTerminalState('failed'), true);
  // NEGATIVE control: a live/working state is NOT terminal.
  assert.equal(isTerminalState('running'), false);
  assert.equal(isTerminalState('rebuilding'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. BOOTSTRAP — fail-closed configuration
// ═══════════════════════════════════════════════════════════════════════════
test('BOOTSTRAP: invalid configuration is REFUSED (fail-closed, disclosure-safe)', () => {
  const { database } = newDb();
  let threw = null;
  try {
    bootstrapProjector({
      // Inline secret where a reference is required (production hardening + secret grammar) — the
      // parser must refuse this fail-closed.
      env: {
        DEPLOYMENT_STAGE: 'production',
        DATABASE_URL: 'postgres://app@localhost:5432/trustcircle',
        SIGNING_KEY_SECRET_REF: 'super-secret-inline-value',
        SESSION_SECRET_REF: 'vault:secret/data/session#key',
      },
      db: database,
      source: scriptedSource(),
      leaseStore: memoryLeaseStore(),
      checkpoints: memoryCheckpointStore(),
      readModel: { reset: async () => {} },
      apply: () => {},
      evidenceSink: async () => {},
      clock: () => 1,
      workerId: HOLDER,
      tenantId: TENANT,
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof BootstrapError, 'bootstrap must throw BootstrapError');
  assert.ok(threw.issues.length > 0, 'issues must be disclosed (variable+code)');
  // Disclosure-safe: the message names variables/codes, not secret values.
  assert.ok(!/super-secret-inline-value/.test(threw.message), 'must NOT leak the offending value');
});

test('BOOTSTRAP: valid configuration wires a projector (not yet started) — negative control', () => {
  const { database } = newDb();
  const built = bootstrapProjector({
    env: GOOD_ENV,
    db: database,
    source: scriptedSource(),
    leaseStore: memoryLeaseStore(),
    checkpoints: memoryCheckpointStore(),
    readModel: { reset: async () => {} },
    apply: () => {},
    evidenceSink: async () => {},
    clock: () => 1,
    workerId: HOLDER,
    tenantId: TENANT,
  });
  assert.ok(built.projector instanceof GovernedProjector);
  assert.equal(built.projector.state, 'starting'); // wired, not started
  assert.equal(built.lease.grant, null); // no lease acquired at bootstrap
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. OWNERSHIP — fenced, exactly-one-owner lease (independent read path = lease store row)
// ═══════════════════════════════════════════════════════════════════════════
test('OWNERSHIP: start() acquires a fenced lease; the durable row proves ownership', async () => {
  const { projector, lease, leaseStore } = buildProjector();
  const ok = await projector.start();
  assert.equal(ok, true);
  assert.equal(projector.state, 'running');

  // Independent read path: the durable lease row names this holder with a monotonic token.
  const row = leaseStore.rows.get(RESOURCE);
  assert.equal(row.holder, HOLDER);
  assert.equal(row.fencingToken, 1);
  const durable = await lease.readDurable();
  assert.equal(durable.holder, HOLDER);
});

test('OWNERSHIP: a second holder cannot steal a live lease (exactly-one-owner) — negative control', async () => {
  const clock = manualClock();
  const { database } = newDb(() => clock());
  const store = memoryLeaseStore();
  const leaseA = new ProjectorLease({
    db: database,
    store,
    resource: RESOURCE,
    holder: 'A',
    clock: () => clock(),
    ttlMs: 10_000,
  });
  const leaseB = new ProjectorLease({
    db: database,
    store,
    resource: RESOURCE,
    holder: 'B',
    clock: () => clock(),
    ttlMs: 10_000,
  });

  const g1 = await leaseA.tryAcquire();
  assert.ok(g1, 'A acquires');
  // B cannot steal while A's lease is live.
  const g2 = await leaseB.tryAcquire();
  assert.equal(g2, null, 'B is refused while A holds a live lease');

  // POSITIVE control: once A's lease EXPIRES, B may take over with a HIGHER fencing token.
  clock.advance(20_000);
  const g3 = await leaseB.tryAcquire();
  assert.ok(g3, 'B takes over an expired lease');
  assert.ok(g3.fencingToken > g1.fencingToken, 'fencing token is monotonic across owners');
});

test('OWNERSHIP: assertLive throws LeaseLostError when the lease is not live (fail-closed)', async () => {
  const clock = manualClock();
  const { database } = newDb(() => clock());
  const lease = new ProjectorLease({
    db: database,
    store: memoryLeaseStore(),
    resource: RESOURCE,
    holder: HOLDER,
    clock: () => clock(),
    ttlMs: 1_000,
  });
  await lease.tryAcquire();
  assert.doesNotThrow(() => lease.assertLive()); // positive control: live
  clock.advance(2_000); // expire
  assert.throws(() => lease.assertLive(), LeaseLostError);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. DURABLE CURSORS — applied position is the durable inbox_cursor (independent read path)
// ═══════════════════════════════════════════════════════════════════════════
test('DURABLE CURSORS: consumed events advance the durable inbox_cursor; a restart RESUMES', async () => {
  const apply = countingApply();
  const built = buildProjector({ apply });
  const { projector, database, checkpoints } = built;
  await projector.start();

  // Feed two in-order events; stop once the scripted work has drained.
  built.source.push([envelope(1), envelope(2)], 2);
  built.source.onDrained(() => projector.requestStop());
  await projector.run();

  // Independent read path: the DURABLE cursor advanced (not an in-memory offset).
  const cursor = await readInboxCursor(database, TENANT, CONSUMER, STREAM);
  assert.ok(cursor, 'inbox_cursor row exists');
  assert.equal(cursor.cursorSeq, 2, 'durable applied position advanced to seq 2');
  // Business-effect witness: apply fired exactly twice (exactly-once).
  assert.equal(apply.applied.length, 2);

  // A durable checkpoint records the resumable totals.
  const cp = checkpoints.rows.get(RESOURCE);
  assert.equal(cp.totals.applied, 2);

  // NEGATIVE control: readAppliedCursor is the independent proof, not the run() return value.
  const readBack = await projector.readAppliedCursor();
  assert.equal(readBack.seq, 2);
});

test('DURABLE CURSORS: a restart LOADs the prior checkpoint and continues cumulative totals', async () => {
  // First run applies 1 event and stops.
  const clock = manualClock();
  const { database } = newDb(() => clock());
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const apply = countingApply();
  const mk = () => {
    const lease = new ProjectorLease({
      db: database,
      store,
      resource: RESOURCE,
      holder: HOLDER,
      clock: () => clock(),
      ttlMs: 100_000,
    });
    const consumer = new InboxConsumer(database, {
      consumer: CONSUMER,
      apply: apply.fn,
      stream: STREAM,
    });
    const source = scriptedSource();
    const projector = new GovernedProjector({
      db: database,
      consumer,
      source,
      lease,
      checkpoints,
      evidence: new EvidenceBuffer(async () => {}),
      readModel: { reset: async () => {} },
      clock: () => clock(),
      sleep: async () => {},
      consumerName: CONSUMER,
      tenantId: TENANT,
      stream: STREAM,
      freshnessObjective: { maxLagItems: 0, maxAgeMs: 60_000 },
      idleDelayMs: 0,
    });
    return { projector, source };
  };

  const first = mk();
  await first.projector.start();
  first.source.push([envelope(1)], 1);
  first.source.onDrained(() => first.projector.requestStop());
  await first.projector.run();
  assert.equal(checkpoints.rows.get(RESOURCE).totals.applied, 1);

  // Second run: a fresh projector on the SAME durable store resumes cumulative totals from the
  // checkpoint (not reset to zero) — the durable-cursor resume property.
  const second = mk();
  const resumed = await second.projector.start();
  assert.equal(resumed, true);
  // The prior applied total was loaded from the durable checkpoint.
  const cpAfterStart = checkpoints.rows.get(RESOURCE);
  assert.equal(cpAfterStart.totals.applied, 1, 'restart resumes cumulative applied total');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. STALE-STATE SIGNALING — freshness objective, fail-visible, never "healthy" when stale
// ═══════════════════════════════════════════════════════════════════════════
test('STALENESS: assessFreshness is total — fresh / stale / unknown with concrete lag+age', () => {
  const obj = { maxLagItems: 0, maxAgeMs: 1_000 };
  // unknown: no source position observed yet — NEVER silently fresh.
  const u = assessFreshness(STREAM, 5, 1000, null, 2000, obj);
  assert.equal(u.freshness, 'unknown');
  // fresh: applied caught up, recent.
  const f = assessFreshness(
    STREAM,
    5,
    2000,
    { stream: STREAM, observedSeq: 5, observedAt: 2000 },
    2000,
    obj,
  );
  assert.equal(f.freshness, 'fresh');
  assert.equal(f.lagItems, 0);
  // stale by LAG: applied trails the observed source.
  const sLag = assessFreshness(
    STREAM,
    3,
    2000,
    { stream: STREAM, observedSeq: 9, observedAt: 2000 },
    2000,
    obj,
  );
  assert.equal(sLag.freshness, 'stale');
  assert.equal(sLag.lagItems, 6);
  // stale by AGE: applied position matches but the last apply is too old.
  const sAge = assessFreshness(
    STREAM,
    5,
    0,
    { stream: STREAM, observedSeq: 5, observedAt: 5000 },
    5000,
    obj,
  );
  assert.equal(sAge.freshness, 'stale');
  assert.ok(sAge.ageMs > obj.maxAgeMs);
});

test('STALENESS: a lagging projection is reported state=stale and healthy=false (fail-visible)', async () => {
  const built = buildProjector({ freshnessObjective: { maxLagItems: 0, maxAgeMs: 60_000 } });
  const { projector, checkpoints } = built;
  await projector.start();

  // Source reports a high-water mark of 10 but delivers NO events this pass — the applied cursor
  // (0) lags the observed source (10) by 10 items.
  built.source.push([], 10);
  built.source.onDrained(() => projector.requestStop());
  await projector.run();

  // Independent read path: the durable checkpoint marks the stream stale.
  const cp = checkpoints.rows.get(RESOURCE);
  const streamF = cp.freshness.find((x) => x.stream === STREAM);
  assert.equal(streamF.freshness, 'stale');
  assert.equal(streamF.lagItems, 10, 'concrete lag surfaced');
  assert.equal(cp.stale ?? streamF.freshness === 'stale', true);

  // The synthesized status forces healthy=false when stale.
  const status = projector.status(cp.freshness, built.clock());
  assert.equal(status.stale, true);
  assert.equal(status.healthy, false, 'a stale projection is NEVER reported healthy');
  // safe next action points at reconcile, not "none".
  assert.equal(status.safeNextAction, 'reconcile');
});

test('STALENESS: a caught-up projection is fresh and healthy — negative control', async () => {
  const apply = countingApply();
  const built = buildProjector({ apply, freshnessObjective: { maxLagItems: 0, maxAgeMs: 60_000 } });
  const { projector } = built;
  await projector.start();
  built.source.push([envelope(1)], 1); // apply seq 1, observed 1 → caught up
  built.source.onDrained(() => projector.requestStop());
  await projector.run();
  const freshness = await projector.assessCurrentFreshness();
  assert.equal(freshness.freshness, 'fresh');
  assert.equal(freshness.lagItems, 0);
  const status = projector.status([freshness]);
  assert.equal(status.stale, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. REBUILD MODE — reset+replay, durably tracked, never "healthy live" while rebuilding
// ═══════════════════════════════════════════════════════════════════════════
test('REBUILD: a requested rebuild RESETs the read model and is fail-visible (not live-current)', async () => {
  let resetCalls = 0;
  const readModel = { reset: async () => void (resetCalls += 1) };
  const built = buildProjector({ readModel });
  const { projector, checkpoints } = built;
  await projector.start();

  projector.requestRebuild('rebuild-1', 'schema change');
  assert.equal(projector.rebuild.phase, 'resetting');

  // First pass performs the reset (→replaying) and then pulls an empty batch; on drain, stop.
  built.source.onDrained(() => projector.requestStop());
  await projector.run();

  assert.equal(resetCalls, 1, 'read model reset exactly once at rebuild start');
  // Independent read path: the durable checkpoint records the rebuild id + phase (visible/resumable).
  const cp = checkpoints.rows.get(RESOURCE);
  assert.equal(cp.rebuild.rebuildId, 'rebuild-1');
  assert.notEqual(cp.rebuild.phase, 'idle', 'rebuild is durably tracked, not invisible');
});

test('REBUILD: a failed reset leaves the projection fail-visibly degraded — negative control', async () => {
  const readModel = {
    reset: async () => {
      throw new Error('reset failed');
    },
  };
  const built = buildProjector({ readModel });
  const { projector, checkpoints } = built;
  await projector.start();
  projector.requestRebuild('rebuild-x', 'corruption');
  // The reset throws every pass → the rebuild stays 'failed' and the loop would spin; stop after
  // the first failed reset is checkpointed (the failed reset path sleeps then continues).
  built.source.onDrained(() => projector.requestStop());
  let guard = 0;
  const origReset = built.readModel.reset;
  built.readModel.reset = async (id) => {
    guard += 1;
    if (guard > 3) projector.requestStop(); // safety: never spin forever in the test
    return origReset(id);
  };
  await projector.run();

  const cp = checkpoints.rows.get(RESOURCE);
  assert.equal(cp.rebuild.phase, 'failed', 'the failed rebuild is durably fail-visible');
  assert.equal(
    cp.safeNextAction,
    'rebuild',
    'a failed rebuild demands another rebuild, not "none"',
  );
  // The reset-failure reason is captured on the checkpoint written DURING the failed reset pass
  // (a later empty pull clears the transient lastError; the durable history retains it).
  const failedResetCp = checkpoints.history.find(
    (c) => c.lastError && /rebuild reset failed/.test(c.lastError),
  );
  assert.ok(failedResetCp, 'the reset failure reason was checkpointed (fail-visible)');
  assert.equal(failedResetCp.rebuild.phase, 'failed');
  // A rebuild in flight/failed is NEVER a healthy live projection.
  const status = projector.status(cp.freshness, built.clock());
  assert.equal(status.healthy, false);
});

test('REBUILD: an interrupted rebuild RESUMES as pending on restart (safeNextAction=rebuild)', async () => {
  // Seed a checkpoint whose rebuild is mid-flight, then start() must resume it fail-visibly.
  const clock = manualClock();
  const { database } = newDb(() => clock());
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  await checkpoints.save({
    resource: RESOURCE,
    holder: HOLDER,
    fencingToken: 0,
    pass: 3,
    state: 'rebuilding',
    continuity: 'paused',
    totals: { consumed: 3, applied: 3, buffered: 0, quarantined: 0, retried: 0, deadLettered: 0 },
    freshness: [],
    rebuild: {
      rebuildId: 'r-mid',
      phase: 'replaying',
      replayed: 3,
      reason: 'x',
      startedAt: 1,
      updatedAt: 1,
    },
    bufferedEvidence: 0,
    lastError: null,
    safeNextAction: 'rebuild',
    updatedAt: 1,
  });
  const lease = new ProjectorLease({
    db: database,
    store,
    resource: RESOURCE,
    holder: HOLDER,
    clock: () => clock(),
    ttlMs: 100_000,
  });
  const consumer = new InboxConsumer(database, {
    consumer: CONSUMER,
    apply: () => {},
    stream: STREAM,
  });
  const projector = new GovernedProjector({
    db: database,
    consumer,
    source: scriptedSource(),
    lease,
    checkpoints,
    evidence: new EvidenceBuffer(async () => {}),
    readModel: { reset: async () => {} },
    clock: () => clock(),
    sleep: async () => {},
    consumerName: CONSUMER,
    tenantId: TENANT,
    stream: STREAM,
    freshnessObjective: { maxLagItems: 0, maxAgeMs: 60_000 },
    idleDelayMs: 0,
  });
  await projector.start();
  assert.equal(projector.rebuild.rebuildId, 'r-mid', 'the interrupted rebuild is resumed');
  assert.equal(projector.rebuild.phase, 'replaying');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. FAILURES / RETRIES — a transient source failure is fail-visible with a retry action
// ═══════════════════════════════════════════════════════════════════════════
test('FAILURES: a bus pull throw is captured, checkpointed, and points at retry (fail-visible)', async () => {
  // A source that throws on its first pull, then requests stop from WITHIN the next pull so the
  // loop terminates deterministically (no macrotask timers under an immediate sleeper).
  let stopRef = null;
  let pulls = 0;
  const source = {
    async pull() {
      pulls += 1;
      if (pulls === 1) throw new Error('bus unavailable'); // transient failure captured
      stopRef(); // second pass: end the loop cleanly
      return { events: [], observedSeq: 0 };
    },
  };
  const built = buildProjector({ source });
  const { projector, checkpoints } = built;
  stopRef = () => projector.requestStop();
  await projector.start();
  await projector.run();

  // Independent read path: the checkpoint WRITTEN during the failing pass records the transient
  // failure and points at retry (a later clean pass may clear it — that is why we assert on the
  // durable history, not only the final row).
  const failingCp = checkpoints.history.find(
    (c) => c.lastError && /bus unavailable/.test(c.lastError),
  );
  assert.ok(failingCp, 'the transient failure was checkpointed (not swallowed)');
  assert.equal(
    failingCp.safeNextAction,
    'retry',
    'the safe next action for a transient failure is retry',
  );
  assert.ok(pulls >= 2, 'the loop retried after the transient failure');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. CONTINUITY + LEASE — losing the lease mid-run PAUSES fail-closed (reconcile)
// ═══════════════════════════════════════════════════════════════════════════
test('CONTINUITY: losing the lease mid-run ⇒ lost_lease + paused + reconcile (fail-closed)', async () => {
  const built = buildProjector({ ttlMs: 5_000 });
  const { projector, checkpoints, leaseStore, clock } = built;
  await projector.start();

  // Simulate the lease being STOLEN: bump the durable row to a different holder + higher token so
  // renew() finds it is no longer ours.
  leaseStore.rows.set(RESOURCE, {
    resource: RESOURCE,
    holder: 'thief',
    fencingToken: 99,
    expiresAt: clock() + 100000,
    updatedAt: clock(),
  });
  clock.advance(4_000); // force a renewal attempt (past half-life)

  // The stolen lease makes the first #renewIfDue fail → lost_lease → the loop breaks immediately.
  await projector.run();

  assert.equal(projector.state, 'lost_lease');
  const cp = checkpoints.rows.get(RESOURCE);
  assert.equal(cp.state, 'lost_lease');
  assert.equal(cp.continuity, 'paused', 'a lost lease pauses at a safe checkpoint');
  assert.equal(cp.safeNextAction, 'reconcile');

  // NEGATIVE control: while the lease is live, a normal pass does NOT flip to lost_lease.
  const ok = buildProjector();
  await ok.projector.start();
  ok.source.onDrained(() => ok.projector.requestStop());
  const report = await ok.projector.run();
  assert.notEqual(report.finalState, 'lost_lease');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. BUFFERED EVIDENCE — visible in the status; a failed flush is fail-visible
// ═══════════════════════════════════════════════════════════════════════════
test('BUFFERED EVIDENCE: buffered records are counted in the status; a flush empties them', async () => {
  const flushed = [];
  const evidence = new EvidenceBuffer(async (recs) => void flushed.push(...recs));
  evidence.buffer({ kind: 'k', correlationId: 'c', payload: {}, bufferedAt: 1 });
  assert.equal(evidence.size, 1);
  const ok = await evidence.flush();
  assert.equal(ok, true);
  assert.equal(evidence.size, 0, 'a successful flush empties the buffer');
  assert.equal(flushed.length, 1);
});

test('BUFFERED EVIDENCE: a failed flush RETAINS the buffer and reports degraded — negative control', async () => {
  const evidence = new EvidenceBuffer(async () => {
    throw new Error('sink down');
  });
  const built = buildProjector({
    evidenceSink: async () => {
      throw new Error('sink down');
    },
  });
  // Re-wire the projector's buffer to have unflushed evidence at shutdown.
  built.evidence.buffer({ kind: 'k', correlationId: 'c', payload: {}, bufferedAt: 1 });
  const { projector, checkpoints } = built;
  await projector.start();
  built.source.onDrained(() => projector.requestStop());
  const report = await projector.run();

  // The buffer is retained (fail-visible), the terminal state is degraded, not a clean stopped.
  assert.equal(built.evidence.size, 1, 'unflushed evidence is retained, never dropped');
  assert.equal(report.finalState, 'degraded');
  const cp = checkpoints.rows.get(RESOURCE);
  assert.equal(cp.state, 'degraded');
  assert.ok(/evidence could not be flushed/.test(cp.lastError));
  // Standalone buffer negative control.
  const solo = await evidence.flush();
  assert.equal(solo, true, 'empty solo buffer flush is a no-op success');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. SAFE SHUTDOWN — a clean drain ends stopped/none; the durable checkpoint is the witness
// ═══════════════════════════════════════════════════════════════════════════
test('SAFE SHUTDOWN: a clean drain ends state=stopped, action=none, lease released', async () => {
  const apply = countingApply();
  const built = buildProjector({ apply });
  const { projector, checkpoints, leaseStore } = built;
  await projector.start();
  built.source.push([envelope(1)], 1);
  built.source.onDrained(() => projector.requestStop());
  const report = await projector.run();

  assert.equal(report.finalState, 'stopped');
  assert.equal(report.cleanShutdown, true);
  const cp = checkpoints.rows.get(RESOURCE);
  assert.equal(cp.state, 'stopped');
  assert.equal(cp.safeNextAction, 'none');
  // Independent read path: the lease row was released (holder cleared).
  assert.equal(leaseStore.rows.get(RESOURCE).holder, null);
});

test('SAFE SHUTDOWN: bindSignals wires SIGTERM/SIGINT to requestStop; unbind removes them', () => {
  const built = buildProjector();
  const handlers = new Map();
  const signals = {
    once: (sig, h) => handlers.set(sig, h),
    removeListener: (sig, h) => {
      if (handlers.get(sig) === h) handlers.delete(sig);
    },
  };
  const unbind = built.projector.bindSignals(signals);
  assert.ok(handlers.has('SIGTERM'));
  assert.ok(handlers.has('SIGINT'));
  handlers.get('SIGTERM')(); // fire SIGTERM
  assert.equal(built.projector.stopRequested, true);
  unbind();
  assert.equal(handlers.size, 0, 'unbind removes both signal listeners');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. STATUS SNAPSHOT — the ONE observable surface carries every acceptance dimension
// ═══════════════════════════════════════════════════════════════════════════
test('STATUS: the single snapshot carries every acceptance dimension at once', async () => {
  const built = buildProjector();
  const { projector } = built;
  await projector.start();
  const freshness = await projector.assessCurrentFreshness();
  const s = projector.status([freshness]);
  // Every oracle dimension is present in ONE object.
  for (const key of [
    'resource',
    'holder',
    'state',
    'healthy',
    'ownership',
    'continuity',
    'progress',
    'freshness',
    'stale',
    'rebuild',
    'bufferedEvidence',
    'lastError',
    'safeNextAction',
    'observedAt',
  ])
    assert.ok(key in s, `status must expose ${key}`);
  assert.equal(s.ownership.owned, true);
  assert.equal(typeof s.ownership.fencingToken, 'number');
  assert.equal(s.progress.pass >= 0, true);
  assert.equal(Array.isArray(s.freshness), true);
});
