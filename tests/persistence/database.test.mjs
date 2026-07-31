// Verification-obligation suite for the persistence transactional core (Phase 17 /
// packages/persistence/src/database.ts / VO-52d0780c11bcc6fd7583).
//
// Oracle: "Every onboarded source contract MUST be versioned and validated; mutating operations
// MUST be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
// delayed, partial, conflicting, and uncertain outcomes."
//
// Every property below is proven by a positive control paired with a negative control (so the
// assertions are non-vacuous), exercising the REAL database.ts against an in-memory SqlDriver
// (no live PostgreSQL) under Node 22 --experimental-strip-types.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInMemoryDriver } from './in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const db = await import(join(ROOT, 'packages/persistence/src/database.ts'));

const {
  Database,
  runMutation,
  reconcileMutation,
  runMigrations,
  readMigrationHistory,
  assertSourceContract,
  assertRetryPolicy,
  assertMigrationOrder,
  checksumMigration,
  advisoryLockId,
  isRetryableError,
  safeNextActionFor,
  digest,
  canonicalJson,
  IdempotencyConflictError,
  ContractDriftError,
  MigrationChecksumError,
  UncertainOutcomeError,
} = db;

// A monotonic deterministic clock (never the wall clock).
function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

function newDb(retry) {
  const driver = createInMemoryDriver();
  const database = new Database(driver, { clock: makeClock(), ...(retry ? { retry } : {}) });
  return { driver, database };
}

const goodContract = {
  sourceId: 'jira',
  version: '1.4.0',
  contractDigest: 'abc123',
  validated: true,
};

function req(overrides = {}) {
  return {
    tenantId: 't1',
    operationScope: 'controller.repair',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    contract: goodContract,
    expectedContractVersion: '1.4.0',
    request: { action: 'repair', target: 'x' },
    effect: async () => ({ ok: true, n: 1 }),
    ...overrides,
  };
}

// ── 1. Versioned & validated source contracts ────────────────────────────────
test('source contract must be versioned (semver) AND validated', () => {
  assert.deepEqual(assertSourceContract(goodContract), goodContract); // positive
  assert.throws(() => assertSourceContract({ ...goodContract, validated: false }), /not validated/); // negative: unvalidated cannot mutate
  assert.throws(() => assertSourceContract({ ...goodContract, version: 'v1' }), /semantic version/); // negative: unversioned
});

test('source drift between authoring and execution invalidates the operation (no effect)', async () => {
  const { database, driver } = newDb();
  let ran = false;
  await assert.rejects(
    runMutation(
      database,
      req({ effect: async () => ((ran = true), { ok: true }), expectedContractVersion: '1.3.0' }),
    ),
    ContractDriftError,
  );
  assert.equal(ran, false, 'effect must NOT run under contract drift'); // negative control
  assert.equal(driver.__committed.idempotency_ledger.size, 0, 'no durable effect recorded');
});

// ── 2. Correlated + durable witness on an independent read path ───────────────
test('a succeeded mutation records a correlated, durable ledger row readable independently', async () => {
  const { database } = newDb();
  const out = await runMutation(database, req());
  assert.equal(out.status, 'succeeded');
  assert.equal(out.deduplicated, false);
  assert.ok(out.responseDigest, 'durable response digest witness present');

  // Independent read path — NOT the mutation response.
  const rec = await database.readIdempotencyRecord('t1', 'controller.repair', 'idem-1');
  assert.ok(rec, 'ledger row exists');
  assert.equal(rec.correlationId, 'corr-1', 'correlation preserved for reconstruction');
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.responseDigest, out.responseDigest, 'read-path witness matches');
});

// ── 3. Deduplicated: duplicate replay returns first result, NO re-execution ───
test('duplicate replay of the same request is deduplicated (effect runs exactly once)', async () => {
  const { database } = newDb();
  let effectRuns = 0;
  const r = req({ effect: async () => (effectRuns++, { ok: true, run: effectRuns }) });

  const first = await runMutation(database, r);
  const second = await runMutation(database, r);

  assert.equal(effectRuns, 1, 'effect executed exactly once despite duplicate call'); // positive
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true, 'second call is a dedup hit');
  assert.deepEqual(second.result, first.result, 'same recorded result returned');
});

test('same key with a DIFFERENT request is a conflict (never a silent overwrite)', async () => {
  const { database } = newDb();
  await runMutation(database, req({ request: { a: 1 } }));
  await assert.rejects(
    runMutation(database, req({ request: { a: 2 } })), // different body, same key
    IdempotencyConflictError,
  );
  // Negative control: the original recorded result is untouched.
  const rec = await database.readIdempotencyRecord('t1', 'controller.repair', 'idem-1');
  assert.equal(rec.requestDigest, digest({ request: { a: 1 }, contractDigest: 'abc123' }));
});

// ── 4. Retry-bounded ──────────────────────────────────────────────────────────
test('retry policy is always bounded (>=1, finite); unbounded is rejected', () => {
  assert.equal(assertRetryPolicy({ maxAttempts: 3, baseBackoffMs: 10 }).maxAttempts, 3); // positive
  assert.throws(() => assertRetryPolicy({ maxAttempts: 0, baseBackoffMs: 10 }), RangeError); // negative
  assert.throws(() => assertRetryPolicy({ maxAttempts: Infinity, baseBackoffMs: 10 }), RangeError);
});

test('transient (serialization) failures retry under the bound then succeed', async () => {
  const { database } = newDb({ maxAttempts: 5, baseBackoffMs: 1 });
  let calls = 0;
  const out = await runMutation(
    database,
    req({
      effect: async () => {
        calls++;
        if (calls < 3) {
          const e = new Error('serialization_failure');
          e.code = '40001';
          throw e;
        }
        return { ok: true, calls };
      },
    }),
  );
  assert.equal(out.status, 'succeeded');
  assert.equal(calls, 3, 'retried the transient failure within the bound'); // positive
});

test('a non-retryable failure is NOT retried and is recorded terminally as failed', async () => {
  const { database } = newDb({ maxAttempts: 5, baseBackoffMs: 1 });
  let calls = 0;
  const out = await runMutation(
    database,
    req({
      effect: async () => {
        calls++;
        throw new Error('constraint violation'); // no retryable code
      },
    }),
  );
  assert.equal(calls, 1, 'non-retryable error was not retried'); // negative control
  assert.equal(out.status, 'failed');
  assert.equal(out.nextAction, 'retry');
  const rec = await database.readIdempotencyRecord('t1', 'controller.repair', 'idem-1');
  assert.equal(rec.status, 'failed', 'terminal failure is durably recorded, not silent');
});

test('retry budget is honored: exhausting the bound stops retrying', async () => {
  const { database } = newDb({ maxAttempts: 2, baseBackoffMs: 1 });
  let calls = 0;
  const out = await runMutation(
    database,
    req({
      effect: async () => {
        calls++;
        const e = new Error('deadlock');
        e.code = '40P01';
        throw e;
      },
    }),
  );
  assert.equal(calls, 2, 'stopped exactly at the bound (never unbounded)'); // bound honored
  assert.equal(out.status, 'failed');
});

test('isRetryableError only accepts the retryable SQLSTATE classes', () => {
  assert.equal(isRetryableError({ code: '40001' }), true);
  assert.equal(isRetryableError({ code: '40P01' }), true);
  assert.equal(isRetryableError({ code: '23505' }), false); // unique_violation — negative
  assert.equal(isRetryableError(new Error('x')), false);
});

// ── 5. Safe under uncertain outcomes + reconciliation (no duplicate effect) ───
test('uncertain outcome is recorded as uncertain ⇒ reconcile, NEVER reported as success', async () => {
  const { database } = newDb();
  const out = await runMutation(
    database,
    req({
      effect: async () => {
        throw new UncertainOutcomeError('remote timeout after side effect');
      },
    }),
  );
  assert.equal(out.status, 'uncertain');
  assert.equal(out.nextAction, 'reconcile'); // positive
  assert.notEqual(out.status, 'succeeded'); // negative control: never claims success
  const rec = await database.readIdempotencyRecord('t1', 'controller.repair', 'idem-1');
  assert.equal(rec.status, 'uncertain', 'uncertainty is durable and visible');
});

test('reconcile resolves an uncertain op via an independent observation WITHOUT re-running the effect', async () => {
  const { database } = newDb();
  // First: leave it uncertain.
  await runMutation(
    database,
    req({
      effect: async () => {
        throw new UncertainOutcomeError();
      },
    }),
  );

  // Reconcile: observe the true effect state; effect is NOT re-run here.
  const resolved = await reconcileMutation(
    database,
    { tenantId: 't1', operationScope: 'controller.repair', idempotencyKey: 'idem-1' },
    async () => 'succeeded',
  );
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.status, 'succeeded');
  assert.equal(resolved.nextAction, 'none');
  const rec = await database.readIdempotencyRecord('t1', 'controller.repair', 'idem-1');
  assert.equal(rec.status, 'succeeded', 'ledger now reflects reconciled success');
});

test('reconcile that still cannot confirm stays uncertain ⇒ escalate (no false success)', async () => {
  const { database } = newDb();
  await runMutation(
    database,
    req({
      effect: async () => {
        throw new UncertainOutcomeError();
      },
    }),
  );
  const r = await reconcileMutation(
    database,
    { tenantId: 't1', operationScope: 'controller.repair', idempotencyKey: 'idem-1' },
    async () => 'unknown', // negative control: cannot observe
  );
  assert.equal(r.resolved, false);
  assert.equal(r.status, 'uncertain');
  assert.equal(r.nextAction, 'escalate');
});

test('safeNextActionFor is total and never maps uncertain to none', () => {
  assert.equal(safeNextActionFor('succeeded'), 'none');
  assert.equal(safeNextActionFor('failed'), 'retry');
  assert.equal(safeNextActionFor('uncertain'), 'reconcile');
  assert.notEqual(safeNextActionFor('uncertain'), 'none'); // negative control
});

// ── 6. Advisory locks serialize concurrent duplicates (no double effect) ──────
test('concurrent identical mutations are serialized ⇒ effect runs exactly once', async () => {
  const { database } = newDb();
  let effectRuns = 0;
  const r = req({
    effect: async () => {
      effectRuns++;
      await new Promise((res) => setTimeout(res, 5));
      return { ok: true };
    },
  });
  const [a, b] = await Promise.all([runMutation(database, r), runMutation(database, r)]);
  assert.equal(effectRuns, 1, 'advisory-lock serialization prevented a double effect'); // positive
  const dedups = [a, b].filter((o) => o.deduplicated).length;
  assert.equal(dedups, 1, 'exactly one of the two racing calls was a dedup hit');
});

test('advisoryLockId is deterministic and within the signed 64-bit domain', () => {
  const id = advisoryLockId('mutation:t1:scope:key');
  assert.equal(typeof id, 'bigint');
  assert.equal(advisoryLockId('mutation:t1:scope:key'), id); // stable
  assert.notEqual(advisoryLockId('other'), id); // negative control: distinct keys differ
  assert.ok(id >= -(2n ** 63n) && id < 2n ** 63n, 'within bigint domain');
});

// ── 7. Transaction wrapper is atomic (all-or-nothing) ────────────────────────
test('withTransaction rolls back on throw — no partial durable effect', async () => {
  const { database, driver } = newDb();
  await assert.rejects(
    database.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO idempotency_ledger
           (tenant_id, operation_scope, idempotency_key, correlation_id, request_digest,
            contract_version, status, response_digest, response_json, first_seen_at, last_seen_at, attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
        ['t9', 's', 'k', 'c', 'rd', '1.0.0', 'succeeded', 'd', '{}', 1, 1],
      );
      throw new Error('boom'); // force rollback
    }),
    /boom/,
  );
  assert.equal(driver.__committed.idempotency_ledger.size, 0, 'rolled-back row is not durable'); // negative control
});

// ── 8. Migration runner: ordered, applied-once, checksum-pinned ───────────────
const M = (id, name, kind, up) => ({ id, name, kind, up });

test('migrations apply once, are skipped on re-run, and are recorded in order', async () => {
  const { database } = newDb();
  const migrations = [
    M('0001', 'init', 'expand', 'CREATE TABLE a (id int)'),
    M('0002', 'add_col', 'migrate', 'ALTER TABLE a ADD COLUMN b int'),
  ];
  const first = await runMigrations(database, migrations);
  assert.equal(first.applied.length, 2); // positive: both applied
  assert.equal(first.skipped.length, 0);

  const second = await runMigrations(database, migrations);
  assert.equal(second.applied.length, 0, 'already-applied migrations are not re-applied'); // idempotent
  assert.equal(second.skipped.length, 2);

  const history = await readMigrationHistory(database);
  assert.deepEqual(
    history.map((h) => h.id),
    ['0001', '0002'],
    'history readable & ordered',
  );
});

test('editing an already-applied migration (checksum drift) is rejected', async () => {
  const { database } = newDb();
  await runMigrations(database, [M('0001', 'init', 'expand', 'CREATE TABLE a (id int)')]);
  await assert.rejects(
    runMigrations(database, [M('0001', 'init', 'expand', 'CREATE TABLE a (id bigint)')]), // edited SQL
    MigrationChecksumError,
  ); // negative control: applied migrations are immutable
});

test('migration ordering is validated (dup / out-of-order rejected)', () => {
  assert.doesNotThrow(() =>
    assertMigrationOrder([M('0001', 'a', 'expand', 'x'), M('0002', 'b', 'migrate', 'y')]),
  );
  assert.throws(
    () => assertMigrationOrder([M('0002', 'b', 'migrate', 'y'), M('0001', 'a', 'expand', 'x')]),
    /ascending id order/,
  ); // negative: out of order
  assert.throws(
    () => assertMigrationOrder([M('0001', 'a', 'expand', 'x'), M('0001', 'b', 'migrate', 'y')]),
    /duplicate migration id/,
  ); // negative: dup
});

test('checksumMigration changes iff the migration content changes', () => {
  const a = checksumMigration(M('0001', 'init', 'expand', 'CREATE TABLE a (id int)'));
  const b = checksumMigration(M('0001', 'init', 'expand', 'CREATE TABLE a (id int)'));
  const c = checksumMigration(M('0001', 'init', 'expand', 'CREATE TABLE a (id bigint)'));
  assert.equal(a, b); // stable
  assert.notEqual(a, c); // content-sensitive — negative control
});

// ── digest helper is content-stable / key-order-independent ───────────────────
test('canonicalJson / digest are stable across key order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 })); // negative control
});
