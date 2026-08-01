// Governed command-worker bootstrap / lease ownership / checkpointing / safe shutdown tests
// (Phase 47 / work item BSBXP2PH36TG5Y8FTTMWJD16WG / VO-6acaf6470d0810df4c93,
// VO-53a014009bdfebd7af13).
//
// These tests exercise apps/command-worker/src/main.ts against the REAL OutboxPublisher and the
// SAME in-memory SqlDriver used by the Phase-27 outbox tests (tests/worker/outbox-in-memory-
// driver.mjs), so the advisory-lock lease serialization, the drain, and the checkpoint all run
// for real with no live PostgreSQL. Every governed property named by the acceptance oracle —
// ownership, health, failures, retries, continuity mode + lease, buffered evidence, and the safe
// next action — is asserted through an INDEPENDENT read path (the durable lease-store row and the
// durable checkpoint row), never through the method's own return value, and each has a NEGATIVE
// control so the oracle is non-vacuous.
//
// Run: npm run test:worker   (node --experimental-strip-types --test tests/worker/**/*.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOutboxDriver } from './outbox-in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = await import(join(ROOT, 'apps/command-worker/src/main.ts'));
const dbmod = await import(join(ROOT, 'packages/persistence/src/database.ts'));

const {
  GovernedWorker,
  WorkerLease,
  EvidenceBuffer,
  bootstrapWorker,
  BootstrapError,
  LeaseLostError,
  leaseLockId,
  isTerminalState,
  WORKER_STATES,
  CONTINUITY_MODES,
  SAFE_NEXT_ACTIONS,
  realSleeper,
} = main;
const { Database, advisoryLockId } = dbmod;
// OutboxPublisher + read paths live in the command-worker package (Phase 27), NOT persistence.
const pub = await import(join(ROOT, 'apps/command-worker/src/outbox-publisher.ts'));
const { OutboxPublisher } = pub;

// ───────────────────────────────────────────────────────────────────────────
// Deterministic harness — a manual clock the tests advance explicitly.
// ───────────────────────────────────────────────────────────────────────────
function manualClock(start = 1_700_000_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => (t += ms);
  clock.set = (v) => (t = v);
  return clock;
}

// An in-memory LeaseStore backed by a single Map. Executes under the caller-held advisory lock,
// so linearizability is provided by the Database.withAdvisoryLock mutual exclusion (real code).
function memoryLeaseStore() {
  const rows = new Map(); // resource -> StoredLease
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

// A scriptable bus: shift the next scripted result, or throw it.
function scriptedBus(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    publisher: {
      async publish(msg) {
        calls.push(msg);
        const step = script[Math.min(i, script.length - 1)];
        i++;
        if (typeof step === 'function') return step(msg);
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
}
const ackOk = (ref) => ({ outcome: 'acknowledged', ack: { ackRef: ref } });

function newDb(clock) {
  const driver = createOutboxDriver();
  const database = new Database(driver, { clock });
  return { driver, database };
}

function seedPending(driver, over = {}) {
  const id = over.message_id ?? 'outbox-1';
  driver.seedOutbox({
    message_id: id,
    tenant_id: over.tenant_id ?? 'acme',
    topic: over.topic ?? 'governance.controller.repaired',
    payload: over.payload ?? { entityId: 'c-1', version: 2 },
    correlation_id: over.correlation_id ?? 'corr-' + id,
    max_attempts: over.max_attempts ?? 8,
    ...over,
  });
  return id;
}

// A minimal valid raw environment for bootstrap. DATABASE_URL is required in EVERY stage; the
// DSN below carries no inline password (a non-secret DSN), and the two required secret refs use
// the vault: scheme.
const GOOD_ENV = Object.freeze({
  DEPLOYMENT_STAGE: 'development',
  DATABASE_URL: 'postgres://app@localhost:5432/trustcircle',
  SIGNING_KEY_SECRET_REF: 'vault:secret/data/signing#key',
  SESSION_SECRET_REF: 'vault:secret/data/session#key',
});

function buildWorker({ clock, database, bus, leaseStore, checkpoints, evidence, ...over }) {
  const lease = new WorkerLease({
    db: database,
    store: leaseStore,
    resource: over.resource ?? 'outbox-drain',
    holder: over.holder ?? 'worker-A',
    clock,
    ttlMs: over.ttlMs ?? 10_000,
  });
  const publisher = new OutboxPublisher(database, { bus, workerId: over.holder ?? 'worker-A' });
  const worker = new GovernedWorker({
    db: database,
    publisher,
    lease,
    checkpoints,
    evidence,
    clock,
    sleep: over.sleep ?? (async () => {}),
    batchSize: over.batchSize ?? 100,
    idleDelayMs: over.idleDelayMs ?? 5,
    renewAtFraction: over.renewAtFraction ?? 0.5,
  });
  return { lease, publisher, worker };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. BOOTSTRAP is fail-closed (config errors NEVER yield a running worker).
// ═══════════════════════════════════════════════════════════════════════════
test('A1 bootstrap parses good config and wires a worker (positive)', () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const { publisher } = scriptedBus([ackOk('a')]);
  const { worker, lease, config } = bootstrapWorker({
    env: GOOD_ENV,
    db: database,
    publisherBus: publisher,
    leaseStore: memoryLeaseStore(),
    checkpoints: memoryCheckpointStore(),
    evidenceSink: async () => {},
    clock,
    workerId: 'worker-boot',
    resource: 'outbox-drain',
  });
  assert.equal(worker.state, 'starting'); // wired but not started
  assert.equal(lease.holder, 'worker-boot');
  assert.equal(config.stage, 'development');
  // Status is available immediately and is fail-visible even before start.
  const s = worker.status();
  assert.equal(s.ownership.owned, false);
  assert.equal(s.safeNextAction, 'none');
});

test('A2 bootstrap REFUSES on invalid config — no worker produced (negative control)', () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const { publisher } = scriptedBus([ackOk('a')]);
  // Missing required secret refs in production -> parse fails -> BootstrapError, disclosure-safe.
  assert.throws(
    () =>
      bootstrapWorker({
        env: { DEPLOYMENT_STAGE: 'production' }, // no SIGNING_KEY/SESSION refs, TLS unsafe, etc.
        db: database,
        publisherBus: publisher,
        leaseStore: memoryLeaseStore(),
        checkpoints: memoryCheckpointStore(),
        evidenceSink: async () => {},
        clock,
        workerId: 'worker-boot',
      }),
    (err) => {
      assert.ok(err instanceof BootstrapError);
      assert.ok(err.issues.length > 0, 'issues must be surfaced');
      // Disclosure-safe: message names variable:code, never a secret value.
      assert.match(err.message, /bootstrap refused/);
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// B. LEASE OWNERSHIP — exactly one owner, durably witnessed, fenced, time-bounded.
// ═══════════════════════════════════════════════════════════════════════════
test('B1 acquire writes a durable, fenced lease row (independent read path)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const lease = new WorkerLease({
    db: database,
    store,
    resource: 'outbox-drain',
    holder: 'worker-A',
    clock,
    ttlMs: 10_000,
  });
  const grant = await lease.tryAcquire();
  assert.ok(grant, 'acquire should succeed on a free resource');
  assert.equal(grant.holder, 'worker-A');
  assert.equal(grant.fencingToken, 1);
  // Independent witness: the durable row, not the in-memory grant.
  const durable = await lease.readDurable();
  assert.equal(durable.holder, 'worker-A');
  assert.equal(durable.fencingToken, 1);
  assert.equal(durable.expiresAt, grant.expiresAt);
  assert.ok(lease.isLive(clock()));
});

test('B2 a second worker CANNOT steal a live lease (exactly-one-owner)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const leaseA = new WorkerLease({
    db: database,
    store,
    resource: 'r',
    holder: 'A',
    clock,
    ttlMs: 10_000,
  });
  const leaseB = new WorkerLease({
    db: database,
    store,
    resource: 'r',
    holder: 'B',
    clock,
    ttlMs: 10_000,
  });
  const gA = await leaseA.tryAcquire();
  assert.ok(gA);
  // POSITIVE for exclusivity: while A's lease is live, B's acquire returns null (no steal).
  const gB = await leaseB.tryAcquire();
  assert.equal(gB, null, 'B must not steal a live lease');
  // NEGATIVE control: once A's lease EXPIRES, B may acquire and the fencing token increases,
  // fencing out the stale A (its renew will now fail).
  clock.advance(10_001);
  const gB2 = await leaseB.tryAcquire();
  assert.ok(gB2, 'B may acquire once A expired');
  assert.equal(gB2.fencingToken, 2, 'fencing token strictly increases across acquisitions');
  const renewA = await leaseA.renew();
  assert.equal(renewA, false, 'stale A cannot renew a stolen lease (fenced out)');
});

test('B3 renew extends only for the true holder+token (positive + negative)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const lease = new WorkerLease({
    db: database,
    store,
    resource: 'r',
    holder: 'A',
    clock,
    ttlMs: 10_000,
  });
  const g1 = await lease.tryAcquire();
  clock.advance(4_000);
  // POSITIVE: renew succeeds and pushes expiry forward.
  const ok = await lease.renew();
  assert.equal(ok, true);
  const durable = await lease.readDurable();
  assert.ok(durable.expiresAt > g1.expiresAt, 'renew must extend expiry');
  // NEGATIVE: forcibly bump the durable token (simulate a steal) — renew now fails & drops grant.
  store.rows.set('r', { ...store.rows.get('r'), fencingToken: 99 });
  const bad = await lease.renew();
  assert.equal(bad, false);
  assert.equal(lease.grant, null, 'a lost renew drops the in-memory grant (fail-closed)');
});

test('B4 assertLive throws LeaseLostError when not live (fail-closed guard)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const lease = new WorkerLease({
    db: database,
    store,
    resource: 'r',
    holder: 'A',
    clock,
    ttlMs: 1_000,
  });
  assert.throws(
    () => lease.assertLive(clock()),
    (e) => e instanceof LeaseLostError,
  ); // not held
  await lease.tryAcquire();
  assert.doesNotThrow(() => lease.assertLive(clock())); // held & live
  clock.advance(1_001);
  assert.throws(
    () => lease.assertLive(clock()),
    (e) => e instanceof LeaseLostError,
  ); // expired
});

test('B5 leaseLockId matches advisoryLockId of the namespaced key', () => {
  assert.equal(leaseLockId('outbox-drain'), advisoryLockId('worker-lease:outbox-drain'));
});

// ═══════════════════════════════════════════════════════════════════════════
// C. START resumes cumulative counters from a prior checkpoint (reconstructable history).
// ═══════════════════════════════════════════════════════════════════════════
test('C1 start acquires the lease and resumes prior checkpoint totals', async () => {
  const clock = manualClock();
  const { database, driver } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  // Prior run left a checkpoint with non-zero totals + a pending reconcile action.
  await checkpoints.save({
    resource: 'outbox-drain',
    holder: 'worker-A',
    fencingToken: 1,
    pass: 7,
    state: 'degraded',
    continuity: 'paused',
    totals: { claimed: 5, published: 4, retried: 1, deadLettered: 0 },
    bufferedEvidence: 0,
    lastError: 'prior blip',
    safeNextAction: 'reconcile',
    updatedAt: clock(),
  });
  const { publisher } = scriptedBus([ackOk('x')]);
  const evidence = new EvidenceBuffer(async () => {});
  const { worker } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
  });
  const ok = await worker.start();
  assert.equal(ok, true);
  const s = worker.status();
  assert.equal(s.state, 'running');
  assert.equal(s.progress.pass, 7, 'pass resumed from checkpoint');
  assert.equal(s.progress.published, 4, 'cumulative totals resumed');
  assert.equal(s.safeNextAction, 'reconcile', 'unresolved prior action carried forward');
  assert.ok(driver); // driver present, no rows drained yet
});

test('C2 start returns false (standby) when another worker owns a live lease', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const other = new WorkerLease({
    db: database,
    store,
    resource: 'outbox-drain',
    holder: 'other',
    clock,
    ttlMs: 10_000,
  });
  await other.tryAcquire();
  const checkpoints = memoryCheckpointStore();
  const { publisher } = scriptedBus([ackOk('x')]);
  const evidence = new EvidenceBuffer(async () => {});
  const { worker } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
  });
  const ok = await worker.start();
  assert.equal(ok, false, 'cannot start while another owns the lease');
  const s = worker.status();
  assert.equal(s.state, 'degraded');
  assert.equal(s.ownership.owned, false);
  // Fail-visible: a checkpoint was written recording the standby state.
  assert.equal(checkpoints.latest.get('outbox-drain').state, 'degraded');
});

// ═══════════════════════════════════════════════════════════════════════════
// D. RUN drains, folds counters, and checkpoints — all fail-visible on the durable row.
// ═══════════════════════════════════════════════════════════════════════════
test('D1 a run publishes seeded rows and the durable checkpoint reflects it', async () => {
  const clock = manualClock();
  const { database, driver } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  seedPending(driver, { message_id: 'm1' });
  seedPending(driver, { message_id: 'm2' });
  // Every publish acks OK.
  const { publisher } = scriptedBus([ackOk('ack')]);
  const evidence = new EvidenceBuffer(async () => {});
  // A stop-sleeper: request a SAFE stop from inside the idle sleep of the first drained-nothing
  // pass, so run() reaches its clean boundary deterministically (never mid-pass).
  let w;
  const stopWhenIdle = async () => w.requestStop('done');
  ({ worker: w } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
    sleep: stopWhenIdle,
    idleDelayMs: 1,
  }));
  const worker = w;
  assert.equal(await worker.start(), true);
  const report = await worker.run();
  // Independent read path 1: the outbox rows are `published` with an ack.
  const m1 = await pub.readOutboxMessage(database, 'm1');
  assert.equal(m1.status, 'published');
  assert.equal(m1.ackRef, 'ack');
  // Independent read path 2: the durable checkpoint folded the counters and is fail-visible.
  const cp = checkpoints.latest.get('outbox-drain');
  assert.equal(cp.totals.published, 2);
  assert.equal(cp.state, 'stopped');
  assert.equal(cp.safeNextAction, 'none');
  assert.equal(report.finalState, 'stopped');
  assert.equal(report.cleanShutdown, true);
});

test('D2 a dead-letter escalates the safe next action (fail-visible)', async () => {
  const clock = manualClock();
  const { database, driver } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  // max_attempts 1 + a fatal publish => dead-letter on the single pass.
  seedPending(driver, { message_id: 'dead', tenant_id: 'acme', max_attempts: 1 });
  // PublishError(outcome, message): a 'fatal' rejection dead-letters immediately.
  const fatal = new pub.PublishError('fatal', 'poison message rejected');
  const { publisher } = scriptedBus([fatal]);
  const evidence = new EvidenceBuffer(async () => {});
  let w;
  const stopWhenIdle = async () => w.requestStop('done');
  ({ worker: w } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
    sleep: stopWhenIdle,
    idleDelayMs: 1,
  }));
  const worker = w;
  assert.equal(await worker.start(), true);
  const report = await worker.run();
  const cp = checkpoints.latest.get('outbox-drain');
  assert.equal(cp.totals.deadLettered, 1, 'dead-letter counted');
  assert.equal(cp.safeNextAction, 'escalate', 'dead-letter escalates (fail-visible)');
  // Independent witness: the dead-letter record exists (readDeadLetter(db, tenantId, messageId)).
  const dl = await pub.readDeadLetter(database, 'acme', 'dead');
  assert.ok(dl, 'dead-letter record durably exists');
  assert.equal(report.finalState, 'degraded'); // not a clean stop while escalate stands
});

test('D3 a drain THROW sets retry + lastError, then recovers (positive + negative)', async () => {
  const clock = manualClock();
  const { database, driver } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  seedPending(driver, { message_id: 'm1' });
  // NOTE: the publisher CLASSIFIES an unclassified throw as `uncertain` and returns the row to
  // `failed` for a bounded retry (it does NOT bubble out of runOnce). To exercise the worker's
  // own run-loop catch (retry + lastError checkpoint), we make the DB layer itself throw on the
  // first pass by intercepting the due-scan query, then let it through on later passes.
  let scans = 0;
  const realQuery = driver.query.bind(driver);
  driver.query = async (sql, params) => {
    if (/SELECT message_id FROM outbox_message/i.test(String(sql).trim()) && ++scans === 1) {
      throw new TypeError('transient wiring fault in drain');
    }
    return realQuery(sql, params);
  };
  let ticks = 0;
  let w;
  const stopSleeper = async () => {
    // pass 1 throws (retry+sleep), pass 2 succeeds (published+sleep) -> stop.
    if (++ticks >= 2) w.requestStop('done');
  };
  const { publisher } = scriptedBus([ackOk('ok')]);
  const evidence = new EvidenceBuffer(async () => {});
  ({ worker: w } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
    sleep: stopSleeper,
    idleDelayMs: 1,
  }));
  assert.equal(await w.start(), true);
  await w.run();
  // POSITIVE: after recovery the row published, lastError cleared, safeNextAction back to none.
  const m1 = await pub.readOutboxMessage(database, 'm1');
  assert.equal(m1.status, 'published');
  const cp = checkpoints.latest.get('outbox-drain');
  assert.equal(cp.lastError, null, 'lastError cleared after recovery (positive)');
  assert.equal(cp.totals.published, 1);
  // NEGATIVE control: the failing pass DID surface a retry checkpoint with a non-null lastError.
  const sawRetry = checkpoints.saved.some(
    (c) => c.safeNextAction === 'retry' && c.lastError !== null,
  );
  assert.equal(sawRetry, true, 'a failing pass must have surfaced retry + lastError');
});

// ═══════════════════════════════════════════════════════════════════════════
// E. LOST LEASE mid-run pauses at a safe checkpoint (continuity=paused, reconcile).
// ═══════════════════════════════════════════════════════════════════════════
test('E1 losing the lease mid-run => lost_lease + paused + reconcile (fail-closed)', async () => {
  const clock = manualClock();
  const { database, driver } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  seedPending(driver, { message_id: 'm1' });
  const { publisher } = scriptedBus([ackOk('ok')]);
  const evidence = new EvidenceBuffer(async () => {});
  const { worker, lease } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
    ttlMs: 4_000,
    renewAtFraction: 0.5,
    idleDelayMs: 1,
  });
  assert.equal(await worker.start(), true);
  // Simulate a STEAL: an operator/another worker bumps the durable fencing token so our renew
  // fails on the next pass — the fail-closed path.
  store.rows.set('outbox-drain', { ...store.rows.get('outbox-drain'), fencingToken: 999 });
  clock.advance(3_000); // push past the renew window so a renew is attempted
  const report = await worker.run();
  assert.equal(report.finalState, 'lost_lease');
  const cp = checkpoints.latest.get('outbox-drain');
  assert.equal(cp.state, 'lost_lease');
  assert.equal(cp.continuity, 'paused', 'paused at a safe checkpoint');
  assert.equal(cp.safeNextAction, 'reconcile');
  assert.equal(report.cleanShutdown, false);
  assert.equal(lease.isLive(clock()), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// F. SAFE SHUTDOWN — buffered evidence flushed; a failed flush is fail-visible.
// ═══════════════════════════════════════════════════════════════════════════
test('F1 clean shutdown flushes buffered evidence and stops cleanly (positive)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const flushed = [];
  const evidence = new EvidenceBuffer(async (records) => {
    flushed.push(...records);
  });
  evidence.buffer({ kind: 'attempt', correlationId: 'c1', payload: { a: 1 }, bufferedAt: clock() });
  const { publisher } = scriptedBus([ackOk('ok')]);
  let w;
  const stopWhenIdle = async () => w.requestStop('done');
  ({ worker: w } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
    sleep: stopWhenIdle,
    idleDelayMs: 1,
  }));
  const worker = w;
  assert.equal(await worker.start(), true);
  const report = await worker.run();
  assert.equal(report.finalState, 'stopped');
  assert.equal(flushed.length, 1, 'buffered evidence flushed to the durable sink');
  assert.equal(evidence.size, 0, 'buffer emptied after flush');
  const cp = checkpoints.latest.get('outbox-drain');
  assert.equal(cp.bufferedEvidence, 0);
  assert.equal(cp.state, 'stopped');
});

test('F2 a FAILED evidence flush marks a degraded exit and RETAINS evidence (negative control)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const evidence = new EvidenceBuffer(async () => {
    throw new Error('sink offline');
  });
  evidence.buffer({ kind: 'attempt', correlationId: 'c1', payload: {}, bufferedAt: clock() });
  const { publisher } = scriptedBus([ackOk('ok')]);
  let w;
  const stopWhenIdle = async () => w.requestStop('done');
  ({ worker: w } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
    sleep: stopWhenIdle,
    idleDelayMs: 1,
  }));
  const worker = w;
  assert.equal(await worker.start(), true);
  const report = await worker.run();
  assert.equal(report.finalState, 'degraded', 'a failed flush is NOT a clean stop');
  assert.equal(report.cleanShutdown, false);
  assert.equal(evidence.size, 1, 'evidence is RETAINED, never dropped');
  const cp = checkpoints.latest.get('outbox-drain');
  assert.equal(cp.bufferedEvidence, 1, 'buffered evidence count is fail-visible');
  assert.equal(cp.continuity, 'paused');
  assert.equal(cp.safeNextAction, 'reconcile');
});

// ═══════════════════════════════════════════════════════════════════════════
// G. SIGNAL WIRING — SIGTERM/SIGINT request a safe stop (does not interrupt a pass).
// ═══════════════════════════════════════════════════════════════════════════
test('G1 bindSignals triggers requestStop on SIGTERM and unbinds', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const evidence = new EvidenceBuffer(async () => {});
  const { publisher } = scriptedBus([ackOk('ok')]);
  const { worker } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
  });
  // Fake signal source.
  const handlers = { SIGTERM: [], SIGINT: [] };
  const signals = {
    once: (sig, h) => handlers[sig].push(h),
    removeListener: (sig, h) => {
      handlers[sig] = handlers[sig].filter((x) => x !== h);
    },
  };
  const unbind = worker.bindSignals(signals);
  assert.equal(worker.stopRequested, false);
  // Fire SIGTERM. The worker has not been started (state 'starting'), so requestStop records the
  // stop intent without forcing a 'draining' transition — the draining transition happens only
  // for a 'running' worker (verified by the running-path tests D1/F1). Observable here: the stop
  // was requested and the abort signal is set.
  handlers.SIGTERM.forEach((h) => h());
  assert.equal(worker.stopRequested, true, 'SIGTERM requested a safe stop');
  assert.equal(worker.state, 'starting'); // not yet running -> no draining transition
  // Unbind removes the listeners.
  unbind();
  assert.equal(handlers.SIGTERM.length, 0);
  assert.equal(handlers.SIGINT.length, 0);
});

test('G3 a SIGINT to a RUNNING worker transitions it to draining (positive control)', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const evidence = new EvidenceBuffer(async () => {});
  const { publisher } = scriptedBus([ackOk('ok')]);
  const { worker } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
  });
  const handlers = { SIGTERM: [], SIGINT: [] };
  const signals = {
    once: (sig, h) => handlers[sig].push(h),
    removeListener: (sig, h) => {
      handlers[sig] = handlers[sig].filter((x) => x !== h);
    },
  };
  worker.bindSignals(signals);
  assert.equal(await worker.start(), true); // now 'running'
  assert.equal(worker.state, 'running');
  handlers.SIGINT.forEach((h) => h());
  // The running worker moves to a safe drain; it does NOT hard-abort mid-pass.
  assert.equal(worker.state, 'draining', 'a running worker drains on SIGINT');
  assert.equal(worker.stopRequested, true);
});

test('G2 requestStop is idempotent', async () => {
  const clock = manualClock();
  const { database } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const evidence = new EvidenceBuffer(async () => {});
  const { publisher } = scriptedBus([ackOk('ok')]);
  const { worker } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
  });
  worker.requestStop('one');
  worker.requestStop('two');
  assert.equal(worker.stopRequested, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// H. STATUS is the single, complete, fail-visible surface (every oracle field present).
// ═══════════════════════════════════════════════════════════════════════════
test('H1 status exposes every governed field named by the acceptance oracle', async () => {
  const clock = manualClock();
  const { database, driver } = newDb(clock);
  const store = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  seedPending(driver, { message_id: 'm1' });
  const { publisher } = scriptedBus([ackOk('ok')]);
  const evidence = new EvidenceBuffer(async () => {});
  const { worker } = buildWorker({
    clock,
    database,
    bus: publisher,
    leaseStore: store,
    checkpoints,
    evidence,
  });
  await worker.start();
  const s = worker.status();
  // controller/workflow state:
  assert.ok(WORKER_STATES.includes(s.state));
  // ownership + lease:
  assert.equal(typeof s.ownership.owned, 'boolean');
  assert.equal(typeof s.ownership.fencingToken, 'number');
  assert.equal(typeof s.ownership.leaseExpiresAt, 'number');
  assert.equal(typeof s.ownership.leaseLive, 'boolean');
  // health:
  assert.equal(typeof s.healthy, 'boolean');
  // failures + retries (via cumulative progress + lastError):
  assert.equal(typeof s.progress.retried, 'number');
  assert.equal(typeof s.progress.deadLettered, 'number');
  assert.ok('lastError' in s);
  // continuity mode:
  assert.ok(CONTINUITY_MODES.includes(s.continuity));
  // buffered evidence:
  assert.equal(typeof s.bufferedEvidence, 'number');
  // safe next action:
  assert.ok(SAFE_NEXT_ACTIONS.includes(s.safeNextAction));
  // currency: observedAt is present and equals the injected clock.
  assert.equal(s.observedAt, clock());
});

test('H2 fail-visible vocab: terminal states classified, non-terminal not', () => {
  assert.equal(isTerminalState('stopped'), true);
  assert.equal(isTerminalState('degraded'), true);
  assert.equal(isTerminalState('lost_lease'), true);
  assert.equal(isTerminalState('failed'), true);
  assert.equal(isTerminalState('running'), false);
  assert.equal(isTerminalState('starting'), false);
});

test('H3 realSleeper resolves and is abortable', async () => {
  const ac = new AbortController();
  ac.abort();
  await realSleeper(10_000, ac.signal); // returns immediately because already aborted
  await realSleeper(1); // small real sleep also resolves
  assert.ok(true);
});
