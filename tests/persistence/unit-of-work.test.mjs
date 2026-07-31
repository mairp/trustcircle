// Verification-obligation suite for the UNIT-OF-WORK that atomically commits canonical state,
// AuditEvent, and OutboxMessage (Phase 21 / packages/persistence/src/unit-of-work.ts).
//
// Phase oracle (GAR-008 / VO-52d0780c11bcc6fd7583 + transactional-outbox VO-7a0dbcc527946b539bf6):
//   "Every onboarded source contract MUST be versioned and validated; mutating operations MUST be
//    correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate, delayed,
//    partial, conflicting, and uncertain outcomes."
// Plus VO-d76c5d1293b91d26e094 (audit completeness before an action can be reported complete).
//
// Every property is proven by a positive control paired with a negative control (non-vacuous),
// exercising the REAL unit-of-work.ts against an in-memory SqlDriver — no live PostgreSQL —
// under Node 22 --experimental-strip-types. Effects, audit, and outbox are ALWAYS observed via
// the INDEPENDENT read path (readCanonicalState/readAuditEvent/readOutboxMessage), never the
// mutation response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createUowDriver } from './uow-in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uow = await import(join(ROOT, 'packages/persistence/src/unit-of-work.ts'));
const dbmod = await import(join(ROOT, 'packages/persistence/src/database.ts'));

const {
  commitUnitOfWork,
  reconcileUnitOfWork,
  assertAuditComplete,
  readCanonicalState,
  readAuditEvent,
  readOutboxMessage,
  IncompleteAuditError,
  UNIT_OF_WORK_SQL,
} = uow;
const { Database, ContractDriftError, IdempotencyConflictError } = dbmod;

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDb(retry) {
  const driver = createUowDriver();
  const database = new Database(driver, { clock: makeClock(), ...(retry ? { retry } : {}) });
  return { driver, database };
}

const goodContract = {
  sourceId: 'jira',
  version: '1.4.0',
  contractDigest: 'abc123',
  validated: true,
};

function completeAudit(overrides = {}) {
  return {
    actor: 'user:alice',
    owner: 'team:governance',
    reason: { code: 'repair.low_risk', text: 'auto-repair malformed field' },
    sourceStateDigest: null,
    targetStateDigest: 'will-be-overwritten',
    scope: 'tenant:acme/controller:c-1',
    policyVersion: 'pol-1.0.0',
    controlVersion: 'ctrl-2.1.0',
    evidenceRefs: ['ev:preservation-1'],
    ...overrides,
  };
}

function uowReq(overrides = {}) {
  return {
    tenantId: 't1',
    operationScope: 'controller.repair',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    contract: goodContract,
    expectedContractVersion: '1.4.0',
    request: { action: 'repair', target: 'x' },
    canonical: {
      entityKind: 'controller',
      entityId: 'c-1',
      expectedVersion: 0,
      state: { status: 'repaired' },
    },
    action: 'controller.repair',
    audit: completeAudit(),
    outbox: {
      topic: 'governance.controller.repaired',
      payload: { entityId: 'c-1', status: 'repaired' },
    },
    ...overrides,
  };
}

// Assert NO row exists in ANY of the three tables (used to prove all-or-nothing rollback).
function assertNoDurableEffect(driver, msg) {
  assert.equal(driver.__committed.canonical_state.size, 0, `${msg}: canonical_state must be empty`);
  assert.equal(driver.__committed.audit_event.size, 0, `${msg}: audit_event must be empty`);
  assert.equal(driver.__committed.outbox_message.size, 0, `${msg}: outbox_message must be empty`);
}

// ── 0. UNIT_OF_WORK_SQL creates the three tables the publisher & audit consume ──
test('UNIT_OF_WORK_SQL declares canonical_state, audit_event, and outbox_message', () => {
  assert.match(UNIT_OF_WORK_SQL, /CREATE TABLE IF NOT EXISTS canonical_state/);
  assert.match(UNIT_OF_WORK_SQL, /CREATE TABLE IF NOT EXISTS audit_event/);
  assert.match(UNIT_OF_WORK_SQL, /CREATE TABLE IF NOT EXISTS outbox_message/);
  assert.match(UNIT_OF_WORK_SQL, /CREATE INDEX IF NOT EXISTS outbox_message_claim_idx/); // publisher claim path
});

// ── 1. ATOMIC all-three-or-none — the core unit-of-work invariant ──────────────
test('ATOMIC: a successful commit writes canonical + audit + outbox, all observable independently', async () => {
  const { database, driver } = newDb();
  const out = await commitUnitOfWork(database, uowReq());
  assert.equal(out.status, 'succeeded');
  assert.ok(out.committed, 'success exposes committed identities');

  // Independent read path — NOT the mutation response.
  const canonical = await readCanonicalState(database, 't1', 'controller', 'c-1');
  const audit = await readAuditEvent(database, out.committed.auditId);
  const outbox = await readOutboxMessage(database, out.committed.outboxMessageId);
  assert.ok(canonical && audit && outbox, 'all three durable rows exist');
  assert.equal(canonical.version, 1, 'canonical version advanced 0 -> 1');
  assert.equal(
    canonical.stateDigest,
    out.committed.canonical.stateDigest,
    'durable content witness matches',
  );
  assert.equal(outbox.status, 'pending', 'outbox row awaits the publisher');
  // Correlated across ALL surfaces.
  assert.equal(canonical.correlationId, 'corr-1');
  assert.equal(audit.correlationId, 'corr-1');
  assert.equal(outbox.correlationId, 'corr-1');
  // sanity on committed store size
  assert.equal(driver.__committed.canonical_state.size, 1);
  assert.equal(driver.__committed.audit_event.size, 1);
  assert.equal(driver.__committed.outbox_message.size, 1);
});

// NOTE: an in-effect failure is caught by runMutation and recorded as a non-success terminal
// outcome (status 'failed'/'uncertain') rather than rethrown — the caller then sees a safe next
// action, and CRITICALLY the whole transaction has rolled back, so NO partial durable row exists.
test('ATOMIC negative: a fault at the OUTBOX write rolls back canonical + audit (no partial effect)', async () => {
  const { database, driver } = newDb({ maxAttempts: 1, baseBackoffMs: 1 });
  driver.faultAt('outbox_message', { sticky: true }); // fails AFTER canonical + audit are written in-tx
  const out = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-fault-outbox' }));
  assert.notEqual(out.status, 'succeeded');
  assert.equal(out.committed, undefined);
  driver.clearFault();
  assertNoDurableEffect(driver, 'outbox fault'); // canonical + audit rolled back with the outbox
});

test('ATOMIC negative: a fault at the AUDIT write rolls back the canonical write too', async () => {
  const { database, driver } = newDb({ maxAttempts: 1, baseBackoffMs: 1 });
  driver.faultAt('audit_event', { sticky: true });
  const out = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-fault-audit' }));
  assert.notEqual(out.status, 'succeeded');
  driver.clearFault();
  assertNoDurableEffect(driver, 'audit fault'); // canonical rolled back with the audit
});

test('ATOMIC negative: a fault at the CANONICAL write leaves nothing durable', async () => {
  const { database, driver } = newDb({ maxAttempts: 1, baseBackoffMs: 1 });
  driver.faultAt('canonical_state', { sticky: true });
  const out = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-fault-canon' }));
  assert.notEqual(out.status, 'succeeded');
  driver.clearFault();
  assertNoDurableEffect(driver, 'canonical fault');
});

// ── 2. Versioned & validated contract + source drift ⇒ no effect ───────────────
test('CONTRACT: source drift between authoring and execution invalidates the unit (no effect)', async () => {
  const { database, driver } = newDb();
  await assert.rejects(
    commitUnitOfWork(database, uowReq({ expectedContractVersion: '1.3.0' })),
    ContractDriftError,
  );
  assertNoDurableEffect(driver, 'contract drift'); // negative control: nothing written
});

test('CONTRACT: an unvalidated/unversioned contract cannot commit a unit', async () => {
  const { database, driver } = newDb();
  await assert.rejects(
    commitUnitOfWork(database, uowReq({ contract: { ...goodContract, validated: false } })),
    /not validated/,
  );
  await assert.rejects(
    commitUnitOfWork(database, uowReq({ contract: { ...goodContract, version: 'v1' } })),
    /semantic version/,
  );
  assertNoDurableEffect(driver, 'bad contract');
});

// ── 3. Audit completeness gate — cannot report complete without full audit ─────
test('AUDIT: assertAuditComplete accepts a complete record and rejects each missing facet', () => {
  assert.doesNotThrow(() => assertAuditComplete(completeAudit()));
  for (const field of [
    'actor',
    'owner',
    'scope',
    'policyVersion',
    'controlVersion',
    'targetStateDigest',
  ]) {
    assert.throws(
      () => assertAuditComplete(completeAudit({ [field]: '' })),
      IncompleteAuditError,
      `missing ${field}`,
    );
  }
  assert.throws(
    () => assertAuditComplete(completeAudit({ reason: { code: '', text: '' } })),
    IncompleteAuditError,
  );
  assert.throws(
    () => assertAuditComplete(completeAudit({ evidenceRefs: [] })),
    IncompleteAuditError,
  );
});

test('AUDIT negative: an incomplete audit blocks the whole unit BEFORE any durable effect', async () => {
  const { database, driver } = newDb();
  await assert.rejects(
    commitUnitOfWork(database, uowReq({ audit: completeAudit({ evidenceRefs: [] }) })),
    IncompleteAuditError,
  );
  assertNoDurableEffect(driver, 'incomplete audit');
});

test('AUDIT: the committed audit row captures every accountability facet + outcome', async () => {
  const { database } = newDb();
  const out = await commitUnitOfWork(database, uowReq());
  const a = await readAuditEvent(database, out.committed.auditId);
  assert.equal(a.actor, 'user:alice');
  assert.equal(a.owner, 'team:governance');
  assert.equal(a.reason.code, 'repair.low_risk');
  assert.equal(a.scope, 'tenant:acme/controller:c-1');
  assert.equal(a.policyVersion, 'pol-1.0.0');
  assert.equal(a.controlVersion, 'ctrl-2.1.0');
  assert.equal(a.outcome, 'succeeded');
  assert.equal(
    a.targetStateDigest,
    out.committed.canonical.stateDigest,
    'audit binds to the canonical target digest',
  );
  assert.deepEqual(a.evidenceRefs, ['ev:preservation-1']);
});

// ── 4. Deduplicated — duplicate replay executes the three writes EXACTLY ONCE ───
test('DEDUP: replaying the same unit runs the three writes exactly once (no duplicate rows)', async () => {
  const { database, driver } = newDb();
  const r = uowReq();
  const first = await commitUnitOfWork(database, r);
  const second = await commitUnitOfWork(database, r);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true, 'second call is a dedup hit');
  assert.equal(first.committed.auditId, second.committed.auditId, 'same durable audit identity');
  assert.equal(
    first.committed.outboxMessageId,
    second.committed.outboxMessageId,
    'same durable outbox identity',
  );

  // Exactly one row per table — no double canonical/audit/outbox.
  assert.equal(driver.__committed.canonical_state.size, 1);
  assert.equal(driver.__committed.audit_event.size, 1);
  assert.equal(driver.__committed.outbox_message.size, 1);
});

test('CONFLICT: reusing the idempotency key with a DIFFERENT body is a conflict, not an overwrite', async () => {
  const { database, driver } = newDb();
  await commitUnitOfWork(database, uowReq());
  await assert.rejects(
    commitUnitOfWork(database, uowReq({ request: { action: 'repair', target: 'DIFFERENT' } })),
    IdempotencyConflictError,
  );
  // The original single outbox message is untouched (no silent overwrite / duplicate).
  assert.equal(driver.__committed.outbox_message.size, 1);
});

// ── 5. Conflicting outcomes — optimistic-concurrency guard on canonical state ──
test('CONFLICT: a stale expectedVersion is rejected and leaves the existing row unchanged', async () => {
  const { database } = newDb();
  await commitUnitOfWork(database, uowReq()); // canonical now at version 1
  // A second, DIFFERENT logical write that still expects version 0 hits the optimistic-concurrency
  // guard; the CanonicalVersionConflictError is caught by the runner and surfaced as a non-success
  // outcome, and the existing canonical row is left byte-for-byte unchanged (no partial overwrite).
  const conflict = await commitUnitOfWork(
    database,
    uowReq({
      idempotencyKey: 'idem-2',
      request: { action: 'repair', v: 2 },
      canonical: {
        entityKind: 'controller',
        entityId: 'c-1',
        expectedVersion: 0,
        state: { status: 'other' },
      },
    }),
  );
  assert.notEqual(conflict.status, 'succeeded', 'a stale-version write must not succeed');
  assert.equal(conflict.committed, undefined);
  const canonical = await readCanonicalState(database, 't1', 'controller', 'c-1');
  assert.equal(canonical.version, 1, 'stale conflicting write did not advance the canonical row');
  assert.deepEqual(
    canonical.state,
    { status: 'repaired' },
    'canonical state unchanged by the rejected write',
  );
});

// ── 6. Retry-bounded — transient failures retried; budget never exceeded ────────
test('RETRY: a transient serialization failure is retried and then succeeds atomically', async () => {
  const { database, driver } = newDb({ maxAttempts: 3, baseBackoffMs: 1 });
  driver.faultAt('canonical_state', { code: '40001' }); // one-shot retryable fault
  const out = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-retry' }));
  assert.equal(out.status, 'succeeded');
  assert.ok(out.attempts >= 2, 'took more than one attempt');
  // After recovery all three rows are durable and consistent.
  assert.ok(await readCanonicalState(database, 't1', 'controller', 'c-1'));
  assert.ok(await readAuditEvent(database, out.committed.auditId));
  assert.ok(await readOutboxMessage(database, out.committed.outboxMessageId));
});

test('RETRY negative: retries are bounded — persistent transient failure exhausts the budget, no partial effect', async () => {
  const { database, driver } = newDb({ maxAttempts: 2, baseBackoffMs: 1 });
  driver.faultAt('canonical_state', { code: '40001', sticky: true }); // never clears
  const out = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-retry-exhaust' }));
  assert.equal(out.status, 'failed', 'exhausted budget ⇒ failed, not succeeded');
  assert.equal(out.nextAction, 'retry');
  assert.ok(out.attempts <= 2, 'never exceeds the bounded attempt budget');
  driver.clearFault();
  // No partial durable canonical/audit/outbox effect from the failed attempts.
  assert.equal(driver.__committed.canonical_state.size, 0);
  assert.equal(driver.__committed.audit_event.size, 0);
  assert.equal(driver.__committed.outbox_message.size, 0);
});

// ── 7. Uncertain outcome ⇒ reconcile, never unconfirmed success ─────────────────
test('UNCERTAIN: a non-retryable failure is recorded non-success (never reported succeeded)', async () => {
  const { database, driver } = newDb({ maxAttempts: 2, baseBackoffMs: 1 });
  driver.faultAt('audit_event', { sticky: true }); // generic (non-retryable) failure
  const out = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-uncertain' }));
  assert.notEqual(out.status, 'succeeded', 'a failed unit is NEVER reported as success');
  assert.ok(out.nextAction !== 'none', 'a non-success outcome always surfaces a safe next action');
  assert.equal(out.committed, undefined, 'no committed identities on a non-success outcome');
  driver.clearFault();
  assertNoDurableEffect(driver, 'uncertain/failed'); // no partial effect
});

test('RECONCILE: reconcile confirms a genuinely-committed unit via the independent read path', async () => {
  const { database } = newDb();
  const committed = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-rec-ok' }));
  assert.equal(committed.status, 'succeeded');
  const rec = await reconcileUnitOfWork(database, {
    tenantId: 't1',
    operationScope: 'controller.repair',
    idempotencyKey: 'k-rec-ok',
    canonical: { entityKind: 'controller', entityId: 'c-1', expectedVersion: 0, state: {} },
  });
  assert.equal(rec.resolved, true);
  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.nextAction, 'none');
});

test('RECONCILE negative: reconcile NEVER claims success when no durable canonical effect exists', async () => {
  const { database, driver } = newDb({ maxAttempts: 1, baseBackoffMs: 1 });
  // Simulate an uncertain outcome: the effect ran but nothing durable landed (rolled back).
  driver.faultAt('outbox_message', { sticky: true });
  const failed = await commitUnitOfWork(database, uowReq({ idempotencyKey: 'k-rec-uncertain' }));
  assert.notEqual(failed.status, 'succeeded');
  driver.clearFault();
  const rec = await reconcileUnitOfWork(database, {
    tenantId: 't1',
    operationScope: 'controller.repair',
    idempotencyKey: 'k-rec-uncertain',
    canonical: { entityKind: 'controller', entityId: 'c-1', expectedVersion: 0, state: {} },
  });
  assert.equal(rec.resolved, false, 'no durable effect ⇒ NOT resolved as success');
  assert.notEqual(rec.status, 'succeeded');
  assert.ok(rec.nextAction === 'escalate' || rec.nextAction === 'reconcile');
});

// ── 8. Bundle-identity binding — evidence pinned to THIS bundle ─────────────────
test('IDENTITY: the persistence surface is the one governed by this bundle (sanity anchor)', () => {
  // A cheap, deterministic anchor so evidence cannot be confused with another artifact's:
  // the module exports exactly the unit-of-work surface Phase 21 declares.
  const names = Object.keys(uow).sort();
  for (const n of [
    'commitUnitOfWork',
    'reconcileUnitOfWork',
    'readCanonicalState',
    'readAuditEvent',
    'readOutboxMessage',
    'assertAuditComplete',
    'UNIT_OF_WORK_SQL',
  ]) {
    assert.ok(names.includes(n), `missing export ${n}`);
  }
});
