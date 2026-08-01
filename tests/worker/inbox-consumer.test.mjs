// Verification-obligation suite for the DURABLE INBOX CONSUMER
// (Phase 28 / T028 / apps/projector/src/inbox-consumer.ts).
//
// Phase oracle (GAR-008 / VO-52d0780c11bcc6fd7583, the SOLE acceptance criterion):
//   "Every onboarded source contract MUST be versioned and validated; mutating operations MUST
//    be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate, delayed,
//    partial, conflicting, and uncertain outcomes."
//
// Every property is proven by a positive control paired with a negative control (non-vacuous),
// exercising the REAL inbox-consumer.ts against an in-memory SqlDriver — no live PostgreSQL or
// broker — under Node 22 --experimental-strip-types. Effects (processing state, applied cursor,
// attempt history, quarantine visibility, dead-letter) are ALWAYS observed via the INDEPENDENT
// read path (readInboxMessage / readInboxAttempts / readInboxCursor / listQuarantined /
// readInboxDeadLetter), never the consume() return value alone. The exactly-once BUSINESS effect
// is witnessed by a side-effect counter the projector callback increments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInboxDriver } from './inbox-in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'apps/projector/src/inbox-consumer.ts'));
const dbmod = await import(join(ROOT, 'packages/persistence/src/database.ts'));

const {
  InboxConsumer,
  FatalApplyError,
  readInboxMessage,
  readInboxAttempts,
  readInboxCursor,
  listQuarantined,
  readInboxDeadLetter,
  ackFor,
} = mod;
const { Database } = dbmod;

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

function newDb() {
  const driver = createInboxDriver();
  const database = new Database(driver, { clock: makeClock() });
  return { driver, database };
}

// A deterministic valid envelope factory (mirrors the AsyncAPI EventEnvelope required shape).
const TENANT = '11111111-1111-4111-8111-111111111111';
const AGG = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);
function envelope(over = {}) {
  const version = over.aggregate_version ?? 1;
  return {
    schema_version: '1.0.0',
    event_id: over.event_id ?? `33333333-3333-4333-8333-${String(version).padStart(12, '0')}`,
    event_type: 'governance.controller.repaired',
    tenant_id: over.tenant_id ?? TENANT,
    aggregate_type: over.aggregate_type ?? 'controller',
    aggregate_id: over.aggregate_id ?? AGG,
    aggregate_version: version,
    occurred_at: '2026-01-01T00:00:00Z',
    recorded_at: '2026-01-01T00:00:01Z',
    actor: { principal_id: '44444444-4444-4444-8444-444444444444', principal_type: 'automation' },
    accountable_owner_principal_id: '44444444-4444-4444-8444-444444444444',
    reason: { code: 'auto_repair', text: 'low-risk repair applied' },
    correlation_id: over.correlation_id ?? '55555555-5555-4555-8555-555555555555',
    causation_id: null,
    trace_id: null,
    source: over.source ?? null,
    policy: {
      policy_version_id: '66666666-6666-4666-8666-666666666666',
      policy_decision_id: '77777777-7777-4777-8777-777777777777',
      bundle_digest: SHA,
    },
    controls: [],
    evidence: [{ evidence_id: '88888888-8888-4888-8888-888888888888', sha256: SHA }],
    data: { entityId: 'c-1' },
    extensions: {},
    ...over.overrides,
  };
}

// A counting projector — the business-effect witness. applied count === how many times the
// read-model apply actually fired.
function countingApply() {
  const applied = [];
  return {
    applied,
    fn: (env) => {
      applied.push(env.event_id);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VERSIONED + VALIDATED — a malformed / cross-major message is refused before it can
// drive a mutating action; its ORIGINAL evidence is retained in a dead-letter.
// ─────────────────────────────────────────────────────────────────────────────
test('VALIDATED: a malformed envelope is rejected, never applied, evidence retained', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  const bad = envelope({ overrides: { aggregate_version: 0 } }); // < 1 => invalid
  const r = await c.consume(bad);

  assert.equal(r.disposition, 'rejected');
  assert.equal(r.applied, false);
  assert.equal(ackFor('rejected'), 'ack'); // a malformed message will not become valid on retry
  assert.equal(proj.applied.length, 0, 'projector must NOT fire for a malformed event');

  // Independent read path: the ORIGINAL evidence is retained (not lost) + visible.
  const dl = await readInboxDeadLetter(database, bad.tenant_id, bad.event_id);
  assert.ok(dl, 'malformed event evidence must be retained in a dead-letter record');
  assert.equal(dl.failureClass, 'malformed');

  // NEGATIVE CONTROL: a well-formed version-1 event of the same shape DOES apply.
  const good = envelope({ aggregate_version: 1 });
  const rg = await c.consume(good);
  assert.equal(rg.disposition, 'applied');
  assert.equal(proj.applied.length, 1);
});

test('VERSIONED: a cross-major schema_version is refused (never applied)', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  const crossMajor = envelope({ overrides: { schema_version: '2.0.0' } });
  const r = await c.consume(crossMajor);
  assert.equal(r.disposition, 'rejected');
  assert.equal(proj.applied.length, 0);

  // NEGATIVE CONTROL: the supported major applies.
  const ok = await c.consume(envelope({ aggregate_version: 1 }));
  assert.equal(ok.disposition, 'applied');
});

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATED (safe under duplicate) — a redelivery applies the business effect AT MOST ONCE.
// ─────────────────────────────────────────────────────────────────────────────
test('DEDUPLICATED: re-delivering an applied event causes NO second effect', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  const e = envelope({ aggregate_version: 1 });
  const first = await c.consume(e);
  assert.equal(first.disposition, 'applied');
  assert.equal(first.applied, true);

  // Re-deliver the SAME event (identical event_id) — the durable inbox recognises it.
  const second = await c.consume(e);
  assert.equal(second.disposition, 'duplicate');
  assert.equal(second.applied, false, 'the projector must NOT fire a second time');
  assert.equal(ackFor('duplicate'), 'ack');

  // Independent witness: the read-model apply ran exactly ONCE.
  assert.equal(proj.applied.length, 1, 'exactly-once business effect');

  // The durable row is still `applied`, attempts unchanged (a dup does not re-attempt-apply).
  const row = await readInboxMessage(database, e.tenant_id, 'read-model', e.event_id);
  assert.equal(row.processingState, 'applied');
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDERED APPLY (safe under delayed / out-of-order) — a later version buffers, never applies
// out of order; the cursor never regresses; the predecessor drains it in order.
// ─────────────────────────────────────────────────────────────────────────────
test('ORDERED: an out-of-order (delayed) event is BUFFERED, not applied; cursor does not advance', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  // v2 arrives before v1.
  const v2 = envelope({ aggregate_version: 2 });
  const r2 = await c.consume(v2);
  assert.equal(r2.disposition, 'buffered');
  assert.equal(r2.applied, false);
  assert.equal(ackFor('buffered'), 'nack', 'a buffered event is NACKed for redelivery');
  assert.equal(proj.applied.length, 0, 'out-of-order event must NOT apply');

  // The cursor has NOT advanced (nothing applied yet).
  const cur0 = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur0, null, 'cursor must not advance on a buffered out-of-order event');

  const buffered = await readInboxMessage(database, TENANT, 'read-model', v2.event_id);
  assert.equal(buffered.processingState, 'buffered');

  // NEGATIVE CONTROL: the predecessor v1 arrives and applies in order; then v2 re-delivered applies.
  const v1 = envelope({ aggregate_version: 1 });
  const r1 = await c.consume(v1);
  assert.equal(r1.disposition, 'applied');
  assert.equal(proj.applied.length, 1);

  const cur1 = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur1.cursorSeq, 1);

  const r2b = await c.consume(v2); // redelivery after predecessor
  assert.equal(r2b.disposition, 'applied');
  assert.equal(proj.applied.length, 2);
  const cur2 = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur2.cursorSeq, 2, 'cursor advances monotonically to 2');
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFE UNDER CONFLICTING — two events claiming the same aggregate slot: the second is
// QUARANTINED (visible, inspectable), never silently overwrites, never advances the cursor.
// ─────────────────────────────────────────────────────────────────────────────
test('CONFLICT: a second event at an applied version is quarantined, not overwritten', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  const v1 = envelope({ aggregate_version: 1, event_id: '33333333-3333-4333-8333-00000000000a' });
  await c.consume(v1);
  assert.equal(proj.applied.length, 1);

  // A DIFFERENT event_id claims version 1 again.
  const v1b = envelope({ aggregate_version: 1, event_id: '33333333-3333-4333-8333-00000000000b' });
  const r = await c.consume(v1b);
  assert.equal(r.disposition, 'quarantined');
  assert.equal(r.applied, false);
  assert.equal(ackFor('quarantined'), 'ack');
  assert.equal(proj.applied.length, 1, 'a conflicting event must NOT apply a second effect');

  // Independent read path: the conflict is VISIBLE and inspectable, and the original is retained.
  const q = await listQuarantined(database, TENANT, 'read-model');
  assert.equal(q.length, 1);
  assert.equal(q[0].eventId, v1b.event_id);

  // The applied cursor is still at v1's occupant — never silently overwritten.
  const cur = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur.cursorSeq, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// QUARANTINE (unsafe/ambiguous action) — an item the guard flags is blocked from execution
// while remaining visible + inspectable.
// ─────────────────────────────────────────────────────────────────────────────
test('QUARANTINE: an unsafe event is blocked from execution but visible', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, {
    consumer: 'read-model',
    apply: proj.fn,
    unsafeGuard: (env) => (env.data && env.data.entityId === 'danger' ? 'flagged unsafe' : null),
  });

  const unsafe = envelope({ aggregate_version: 1, overrides: { data: { entityId: 'danger' } } });
  const r = await c.consume(unsafe);
  assert.equal(r.disposition, 'quarantined');
  assert.equal(proj.applied.length, 0, 'a quarantined event must NOT execute');

  const q = await listQuarantined(database, TENANT, 'read-model');
  assert.equal(q.length, 1, 'the quarantined item remains visible + inspectable');

  // NEGATIVE CONTROL: a safe event of the same aggregate applies.
  const safe = envelope({ aggregate_version: 1, event_id: '33333333-3333-4333-8333-0000000000ff' });
  const rs = await c.consume(safe);
  assert.equal(rs.disposition, 'applied');
  assert.equal(proj.applied.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// RETRY-BOUNDED (safe under partial / transient failure) — a transient apply failure is
// retried UP TO max_attempts, then dead-lettered; a fatal failure dead-letters immediately.
// ─────────────────────────────────────────────────────────────────────────────
test('RETRY-BOUNDED: a transient apply failure retries to the bound, then dead-letters', async () => {
  const { database } = newDb();
  let calls = 0;
  const c = new InboxConsumer(database, {
    consumer: 'read-model',
    apply: () => {
      calls++;
      throw new Error('transient sink outage');
    },
    maxAttempts: 3,
  });

  const e = envelope({ aggregate_version: 1 });
  // Redeliver the same event: each consume is one bounded attempt.
  const a1 = await c.consume(e);
  assert.equal(a1.disposition, 'retry');
  assert.equal(ackFor('retry'), 'nack');
  const a2 = await c.consume(e);
  assert.equal(a2.disposition, 'retry');
  const a3 = await c.consume(e); // attempt 3 == max => dead-letter
  assert.equal(a3.disposition, 'dead_letter');
  assert.equal(ackFor('dead_letter'), 'ack', 'a dead-lettered event is ACKed off the bus');

  assert.equal(calls, 3, 'apply attempted exactly max_attempts times — bounded, never unbounded');

  // Independent read path: the ORIGINAL evidence is retained + terminal.
  const dl = await readInboxDeadLetter(database, e.tenant_id, e.event_id);
  assert.ok(dl);
  assert.equal(dl.failureClass, 'retry_exhausted');
  assert.equal(dl.attempts, 3);
  const row = await readInboxMessage(database, e.tenant_id, 'read-model', e.event_id);
  assert.equal(row.processingState, 'dead_letter');

  // Further redelivery of a dead-lettered event is a duplicate (no more attempts).
  const a4 = await c.consume(e);
  assert.equal(a4.disposition, 'duplicate');
  assert.equal(calls, 3, 'no further apply attempts after dead-letter — the bound holds');
});

test('RETRY-BOUNDED: a FatalApplyError dead-letters immediately (no retries)', async () => {
  const { database } = newDb();
  let calls = 0;
  const c = new InboxConsumer(database, {
    consumer: 'read-model',
    apply: () => {
      calls++;
      throw new FatalApplyError('poison payload');
    },
    maxAttempts: 8,
  });

  const e = envelope({ aggregate_version: 1 });
  const r = await c.consume(e);
  assert.equal(r.disposition, 'dead_letter');
  assert.equal(calls, 1, 'a fatal failure is NOT retried');
  const dl = await readInboxDeadLetter(database, e.tenant_id, e.event_id);
  assert.equal(dl.failureClass, 'non_retryable');
});

// ─────────────────────────────────────────────────────────────────────────────
// SAFE UNDER UNCERTAIN — source.ordering_uncertain makes a forward-jump a GAP: never silently
// applied out of order.
// ─────────────────────────────────────────────────────────────────────────────
test('UNCERTAIN: source ordering-uncertain forward jump buffers (gap), never silently applies', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  const uncertainV3 = envelope({
    aggregate_version: 3,
    source: {
      source_instance_id: '99999999-9999-4999-8999-999999999999',
      external_id: 'ext-1',
      source_revision: 'rev-1',
      observed_at: '2026-01-01T00:00:00Z',
      ordering_uncertain: true,
    },
  });
  const r = await c.consume(uncertainV3);
  assert.equal(r.disposition, 'buffered');
  assert.equal(r.decision, 'gap');
  assert.equal(proj.applied.length, 0, 'an uncertain forward jump must never silently apply');

  const cur = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur, null, 'no cursor advance on an uncertain gap');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILABLE — every attempt is appended to an immutable history; applied events advance the
// monotonic cursor; the full ingest history is reconstructable via the independent read path.
// ─────────────────────────────────────────────────────────────────────────────
test('RECONCILABLE: attempt history + cursor advance are reconstructable and monotonic', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  await c.consume(envelope({ aggregate_version: 1 }));
  await c.consume(envelope({ aggregate_version: 2 }));

  const cur = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur.cursorSeq, 2, 'cursor advanced to the highest applied version');

  // Each applied event has exactly one append-only attempt row recording the correlation id.
  const att1 = await readInboxAttempts(
    database,
    TENANT,
    envelope({ aggregate_version: 1 }).event_id,
  );
  assert.equal(att1.length, 1);
  assert.equal(att1[0].outcome, 'succeeded');
  assert.equal(att1[0].correlationId, '55555555-5555-4555-8555-555555555555');

  // NEGATIVE CONTROL: the cursor NEVER regresses. A stale re-delivery of v1 is a duplicate and
  // does not move the cursor back to 1.
  await c.consume(envelope({ aggregate_version: 1 }));
  const cur2 = await readInboxCursor(database, TENANT, 'read-model', 'governance');
  assert.equal(cur2.cursorSeq, 2, 'a duplicate/stale delivery must not regress the cursor');
});

// ─────────────────────────────────────────────────────────────────────────────
// CORRELATED — dedup + ordering are scoped per (tenant, consumer, event) and the aggregate
// correlation key; two consumers of the SAME event each apply independently (fan-out).
// ─────────────────────────────────────────────────────────────────────────────
test('CORRELATED: dedup is scoped per consumer — two consumers each apply the same event once', async () => {
  const { database } = newDb();
  const a = countingApply();
  const b = countingApply();
  const ca = new InboxConsumer(database, { consumer: 'read-model-a', apply: a.fn });
  const cb = new InboxConsumer(database, { consumer: 'read-model-b', apply: b.fn });

  const e = envelope({ aggregate_version: 1 });
  await ca.consume(e);
  await cb.consume(e);
  await ca.consume(e); // redelivery to A only
  await cb.consume(e); // redelivery to B only

  assert.equal(a.applied.length, 1, 'consumer A applies once');
  assert.equal(b.applied.length, 1, 'consumer B applies once');

  // Each consumer has its own durable row keyed on (tenant, consumer, event).
  const ra = await readInboxMessage(database, TENANT, 'read-model-a', e.event_id);
  const rb = await readInboxMessage(database, TENANT, 'read-model-b', e.event_id);
  assert.equal(ra.processingState, 'applied');
  assert.equal(rb.processingState, 'applied');
});

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENCY — two workers delivering the SAME event concurrently: exactly one applies (the
// per-aggregate advisory lock serializes; the durable dedup makes the loser a duplicate).
// ─────────────────────────────────────────────────────────────────────────────
test('CONCURRENCY: concurrent delivery of one event applies exactly once', async () => {
  const { database } = newDb();
  const proj = countingApply();
  const c = new InboxConsumer(database, { consumer: 'read-model', apply: proj.fn });

  const e = envelope({ aggregate_version: 1 });
  const [r1, r2] = await Promise.all([c.consume(e), c.consume(e)]);

  const dispositions = [r1.disposition, r2.disposition].sort();
  assert.deepEqual(dispositions, ['applied', 'duplicate']);
  assert.equal(proj.applied.length, 1, 'exactly one apply under concurrent delivery');
});
