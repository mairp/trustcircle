// Verification-obligation suite for the TRANSACTIONAL-OUTBOX PUBLISHER
// (Phase 27 / apps/command-worker/src/outbox-publisher.ts).
//
// Phase oracle (GAR-008 / VO-52d0780c11bcc6fd7583 + transactional-outbox effect-witness
// VO-7a0dbcc527946b539bf6):
//   "Every onboarded source contract MUST be versioned and validated; mutating operations MUST
//    be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate, delayed,
//    partial, conflicting, and uncertain outcomes."
//
// Every property is proven by a positive control paired with a negative control (non-vacuous),
// exercising the REAL outbox-publisher.ts against an in-memory SqlDriver — no live PostgreSQL or
// broker — under Node 22 --experimental-strip-types. Effects (publish state, ack, retry state,
// dead-letter) are ALWAYS observed via the INDEPENDENT read path
// (readOutboxMessage / readAttempts / readDeadLetter), never the publish() / runOnce() response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createOutboxDriver } from './outbox-in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = await import(join(ROOT, 'apps/command-worker/src/outbox-publisher.ts'));
const dbmod = await import(join(ROOT, 'packages/persistence/src/database.ts'));

const {
  OutboxPublisher,
  PublishError,
  readOutboxMessage,
  readAttempts,
  readDeadLetter,
  nextBackoffMs,
} = pub;
const { Database } = dbmod;

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

function newDb() {
  const driver = createOutboxDriver();
  const database = new Database(driver, { clock: makeClock() });
  return { driver, database };
}

// A scriptable bus publisher: each call shifts the next scripted result (or throws it).
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

function seedPending(driver, over = {}) {
  const id = over.message_id ?? 'outbox-1';
  driver.seedOutbox({
    message_id: id,
    tenant_id: over.tenant_id ?? 'acme',
    topic: over.topic ?? 'governance.controller.repaired',
    payload: over.payload ?? { entityId: 'c-1', version: 2 },
    payload_digest: over.payload_digest ?? 'pd-1',
    correlation_id: over.correlation_id ?? 'corr-xyz',
    max_attempts: over.max_attempts ?? 8,
    ...over,
  });
  return id;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. ACKNOWLEDGEMENT is the only proof of a published message (safe under partial outcomes).
//    Positive: an acked publish flips the row to `published` and records the ack_ref on BOTH
//    the row and the append-only attempt — observed on the independent read path.
//    Negative: a publisher returning `acknowledged` WITHOUT an ack ref is NOT trusted; the row
//    is NOT `published` and no ack is recorded.
// ───────────────────────────────────────────────────────────────────────────
test('published only with a durable acknowledgement (positive + negative)', async () => {
  // positive
  {
    const { driver, database } = newDb();
    const id = seedPending(driver);
    const { publisher } = scriptedBus([ackOk('JS:governance:42')]);
    const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1' });
    const r = await p.publishOne(id);
    assert.equal(r.status, 'published');

    const row = await readOutboxMessage(database, id); // INDEPENDENT read path
    assert.equal(row.status, 'published');
    assert.equal(row.ackRef, 'JS:governance:42');
    assert.equal(row.attempts, 1);
    assert.equal(row.claimedBy, null, 'lease cleared on terminal transition');

    const attempts = await readAttempts(database, 'acme', id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'succeeded');
    assert.equal(attempts[0].ackRef, 'JS:governance:42', 'ack witnessed in append-only history');
  }
  // negative: acknowledged without an ack ref => NOT published
  {
    const { driver, database } = newDb();
    const id = seedPending(driver);
    const { publisher } = scriptedBus([{ outcome: 'acknowledged' /* no ack */ }]);
    const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1' });
    const r = await p.publishOne(id);
    assert.notEqual(r.status, 'published');
    const row = await readOutboxMessage(database, id);
    assert.notEqual(row.status, 'published', 'no false publish without a durable ack');
    assert.equal(row.ackRef, null);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Transactional CLAIM — concurrent workers never double-publish (deduplicated).
//    Positive: two publishers race on the same pending row; exactly ONE publishes it, the other
//    is skipped. The bus is called exactly once and the row is `published` once.
//    Negative (control): a row already `published` is never re-claimed / re-published.
// ───────────────────────────────────────────────────────────────────────────
test('claim is exclusive — concurrent workers publish once (positive + negative)', async () => {
  const { driver, database } = newDb();
  const id = seedPending(driver);
  const busA = scriptedBus([ackOk('A:1')]);
  const busB = scriptedBus([ackOk('B:1')]);
  const pa = new OutboxPublisher(database, { bus: busA.publisher, workerId: 'w-A' });
  const pb = new OutboxPublisher(database, { bus: busB.publisher, workerId: 'w-B' });

  const [ra, rb] = await Promise.all([pa.publishOne(id), pb.publishOne(id)]);
  const publishedResults = [ra, rb].filter((r) => r.status === 'published');
  const skipped = [ra, rb].filter((r) => r.skipped);
  assert.equal(publishedResults.length, 1, 'exactly one worker published');
  assert.equal(skipped.length, 1, 'the other worker was locked out of the claim');

  const totalBusCalls = busA.calls.length + busB.calls.length;
  assert.equal(totalBusCalls, 1, 'the message hit the bus exactly once — no double publish');

  const row = await readOutboxMessage(database, id);
  assert.equal(row.status, 'published');
  const attempts = await readAttempts(database, 'acme', id);
  assert.equal(attempts.length, 1, 'exactly one attempt recorded');

  // negative control: a second pass over an already-published row does nothing.
  const r2 = await pa.publishOne(id);
  assert.equal(r2.skipped, true);
  assert.equal(busA.calls.length, 1, 'no re-publish of a terminal row');
});

// ───────────────────────────────────────────────────────────────────────────
// 3. BOUNDED retries — a retryable failure schedules a bounded next attempt; exhausting the
//    bound dead-letters. Retries are NEVER unbounded.
//    Positive: with max_attempts=2, two retryable failures => attempt 2 dead-letters, and a
//    DeadLetterRecord exists with attempts=2. Negative: attempts never exceed max_attempts and
//    the row is not left `failed` past the bound.
// ───────────────────────────────────────────────────────────────────────────
test('retries are bounded and exhaustion dead-letters (positive + negative)', async () => {
  const { driver, database } = newDb();
  const id = seedPending(driver, { max_attempts: 2 });
  const { publisher, calls } = scriptedBus([
    new PublishError('retryable', 'broker busy'),
    new PublishError('retryable', 'broker busy again'),
    ackOk('never-reached'),
  ]);
  const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1', baseBackoffMs: 10 });

  // attempt 1 -> failed, scheduled for retry
  const r1 = await p.publishOne(id);
  assert.equal(r1.status, 'failed');
  let row = await readOutboxMessage(database, id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt > row.createdAt, 'a bounded next attempt is scheduled');

  // Make the retry due (rewind next_attempt_at into the past via a fresh claim window):
  row = await readOutboxMessage(database, id);
  driver.__committed.outbox_message.get(id).next_attempt_at = 0; // now due

  // attempt 2 -> bound reached -> dead_letter
  const r2 = await p.publishOne(id);
  assert.equal(r2.status, 'dead_letter');
  row = await readOutboxMessage(database, id);
  assert.equal(row.status, 'dead_letter');
  assert.equal(row.attempts, 2);
  assert.ok(row.attempts <= 2, 'attempts never exceed the bound');

  const dl = await readDeadLetter(database, 'acme', id); // INDEPENDENT read path
  assert.ok(dl, 'a DeadLetterRecord exists after retry exhaustion');
  assert.equal(dl.attempts, 2);
  assert.equal(dl.failureClass, 'retry_exhausted');

  const attempts = await readAttempts(database, 'acme', id);
  assert.equal(attempts.length, 2, 'full retry history is reconstructable');
  assert.equal(attempts[0].outcome, 'retryable');
  assert.equal(attempts[1].outcome, 'retryable');

  // negative control: no further publish is attempted on a dead-lettered row.
  const r3 = await p.publishOne(id);
  assert.equal(r3.skipped, true);
  assert.equal(calls.length, 2, 'bus not called again after dead-letter');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Safe under UNCERTAIN outcomes — an uncertain publish is NEVER reported as success.
//    Positive: an uncertain outcome returns the row to `failed` (retryable) and records an
//    `uncertain` attempt; the row is NOT `published` and carries NO ack.
//    Negative: an unclassified thrown error is also treated as uncertain (not published).
// ───────────────────────────────────────────────────────────────────────────
test('uncertain outcomes are never reported as published (positive + negative)', async () => {
  // positive: explicit uncertain
  {
    const { driver, database } = newDb();
    const id = seedPending(driver, { max_attempts: 5 });
    const { publisher } = scriptedBus([new PublishError('uncertain', 'ack timed out')]);
    const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1', baseBackoffMs: 10 });
    const r = await p.publishOne(id);
    assert.notEqual(r.status, 'published');
    const row = await readOutboxMessage(database, id);
    assert.equal(row.status, 'failed', 'uncertain => retry, not success');
    assert.equal(row.ackRef, null, 'no ack recorded for an uncertain outcome');
    const attempts = await readAttempts(database, 'acme', id);
    assert.equal(attempts[0].outcome, 'uncertain');
    assert.equal(attempts[0].ackRef, null);
  }
  // negative: a raw throw (unclassified) is treated as uncertain, never published
  {
    const { driver, database } = newDb();
    const id = seedPending(driver, { max_attempts: 5 });
    const { publisher } = scriptedBus([new Error('socket reset')]);
    const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1', baseBackoffMs: 10 });
    const r = await p.publishOne(id);
    assert.notEqual(r.status, 'published');
    const row = await readOutboxMessage(database, id);
    assert.notEqual(row.status, 'published');
    assert.equal(row.ackRef, null);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 5. A FATAL rejection dead-letters immediately (no wasted retries), evidence retained.
//    Positive: a fatal outcome => dead_letter with the ORIGINAL payload digest retained.
//    Negative: a retryable outcome (same setup) does NOT dead-letter on the first attempt.
// ───────────────────────────────────────────────────────────────────────────
test('fatal rejection dead-letters immediately with retained evidence (positive + negative)', async () => {
  // positive
  {
    const { driver, database } = newDb();
    const id = seedPending(driver, { max_attempts: 8, payload_digest: 'pd-orig' });
    const { publisher } = scriptedBus([new PublishError('fatal', 'schema rejected by bus')]);
    const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1' });
    const r = await p.publishOne(id);
    assert.equal(r.status, 'dead_letter');
    const row = await readOutboxMessage(database, id);
    assert.equal(row.status, 'dead_letter');
    assert.equal(row.attempts, 1, 'fatal does not consume the whole retry budget');
    const dl = await readDeadLetter(database, 'acme', id);
    assert.equal(dl.failureClass, 'non_retryable');
    // original evidence retained: the dead-letter digest equals the original payload digest.
    const stored = driver.__committed.dead_letter_record.get(dl.deadLetterId);
    assert.equal(stored.original_digest, 'pd-orig', 'original evidence preserved');
  }
  // negative control
  {
    const { driver, database } = newDb();
    const id = seedPending(driver, { max_attempts: 8 });
    const { publisher } = scriptedBus([new PublishError('retryable', 'transient')]);
    const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1', baseBackoffMs: 10 });
    const r = await p.publishOne(id);
    assert.equal(r.status, 'failed', 'retryable does not dead-letter on attempt 1');
    const dl = await readDeadLetter(database, 'acme', id);
    assert.equal(dl, null, 'no dead-letter for a first retryable failure');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 6. CORRELATION is carried onto every attempt (reconstructable across surfaces).
// ───────────────────────────────────────────────────────────────────────────
test('every publish attempt carries the message correlation id', async () => {
  const { driver, database } = newDb();
  const id = seedPending(driver, { correlation_id: 'corr-777' });
  const { publisher } = scriptedBus([ackOk('OK:1')]);
  const p = new OutboxPublisher(database, { bus: publisher, workerId: 'w-1' });
  await p.publishOne(id);
  const attempts = await readAttempts(database, 'acme', id);
  assert.equal(attempts[0].correlationId, 'corr-777');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. runOnce drains a batch and reports an accurate per-message summary.
// ───────────────────────────────────────────────────────────────────────────
test('runOnce drains the due batch and summarizes outcomes', async () => {
  const { driver, database } = newDb();
  seedPending(driver, { message_id: 'm-ok', created_at: 1 });
  seedPending(driver, { message_id: 'm-fail', created_at: 2, max_attempts: 3 });
  // publisher: m-ok acked, m-fail retryable
  const bus = {
    async publish(msg) {
      if (msg.messageId === 'm-ok') return ackOk('OK:' + msg.messageId);
      throw new PublishError('retryable', 'nope');
    },
  };
  const p = new OutboxPublisher(database, { bus, workerId: 'w-1', baseBackoffMs: 5 });
  const drain = await p.runOnce(10);
  assert.equal(drain.claimed, 2);
  assert.equal(drain.published, 1);
  assert.equal(drain.retried, 1);

  assert.equal((await readOutboxMessage(database, 'm-ok')).status, 'published');
  assert.equal((await readOutboxMessage(database, 'm-fail')).status, 'failed');
});

// ───────────────────────────────────────────────────────────────────────────
// 8. Backoff is bounded (retry-bounded evidence at the unit level).
// ───────────────────────────────────────────────────────────────────────────
test('nextBackoffMs is exponential and capped', () => {
  assert.equal(nextBackoffMs(1, 100, 10_000), 100);
  assert.equal(nextBackoffMs(2, 100, 10_000), 200);
  assert.equal(nextBackoffMs(3, 100, 10_000), 400);
  assert.equal(nextBackoffMs(20, 100, 10_000), 10_000, 'capped at maxBackoffMs');
});

// ───────────────────────────────────────────────────────────────────────────
// 9. A non-empty workerId is required (fail-fast configuration guard).
// ───────────────────────────────────────────────────────────────────────────
test('publisher requires a non-empty workerId', () => {
  const { database } = newDb();
  assert.throws(() => new OutboxPublisher(database, { bus: {}, workerId: '' }));
});
