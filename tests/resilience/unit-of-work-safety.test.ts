// Resilience suite — the unit-of-work atomically commits canonical state + AuditEvent +
// OutboxMessage, and is correlated, deduplicated, reconcilable, retry-bounded, and safe under
// duplicate / partial / conflicting / uncertain outcomes (Phase 21 /
// packages/persistence/src/unit-of-work.ts; VO-52d0780c11bcc6fd7583 + VO-7a0dbcc527946b539bf6 +
// VO-d76c5d1293b91d26e094).
//
// Runs under `vitest run --project resilience` (`test:resilience`). Each fault mode is injected
// against the REAL unit-of-work via the in-memory driver, and each has a negative control. All
// effects are observed through the INDEPENDENT read path — never the mutation response.

import { describe, it, expect } from 'vitest';

import {
  Database,
  commitUnitOfWork,
  reconcileUnitOfWork,
  readCanonicalState,
  readAuditEvent,
  readOutboxMessage,
  IncompleteAuditError,
  type SqlDriver,
  type CommitUnitOfWorkRequest,
  type SourceContract,
} from '../../packages/persistence/src/index.ts';

// The UoW-aware in-memory driver (models canonical_state / audit_event / outbox_message).
import { createUowDriver } from '../persistence/uow-in-memory-driver.mjs';

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDb(maxAttempts = 5) {
  const driver = createUowDriver();
  const database = new Database(driver as unknown as SqlDriver, {
    clock: makeClock(),
    retry: { maxAttempts, baseBackoffMs: 1 },
  });
  return { driver, database };
}

const contract: SourceContract = {
  sourceId: 'servicenow',
  version: '2.0.0',
  contractDigest: 'digest-2',
  validated: true,
};

function req(o: Partial<CommitUnitOfWorkRequest> = {}): CommitUnitOfWorkRequest {
  return {
    tenantId: 't1',
    operationScope: 'controller.repair',
    idempotencyKey: 'k1',
    correlationId: 'c1',
    contract,
    expectedContractVersion: '2.0.0',
    request: { action: 'apply' },
    canonical: {
      entityKind: 'controller',
      entityId: 'c-1',
      expectedVersion: 0,
      state: { status: 'ok' },
    },
    action: 'controller.repair',
    audit: {
      actor: 'user:alice',
      owner: 'team:governance',
      reason: { code: 'repair.low_risk', text: 'apply' },
      sourceStateDigest: null,
      targetStateDigest: 'derived',
      scope: 'tenant:acme/controller:c-1',
      policyVersion: 'pol-1',
      controlVersion: 'ctrl-1',
      evidenceRefs: ['ev-1'],
    },
    outbox: { topic: 'governance.controller.repaired', payload: { id: 'c-1' } },
    ...o,
  };
}

describe('unit-of-work atomicity & safety under fault injection', () => {
  it('ATOMIC: success writes canonical + audit + outbox, all observable independently', async () => {
    const { database } = newDb();
    const out = await commitUnitOfWork(database, req());
    expect(out.status).toBe('succeeded');
    const canonical = await readCanonicalState(database, 't1', 'controller', 'c-1');
    const audit = await readAuditEvent(database, out.committed!.auditId);
    const outbox = await readOutboxMessage(database, out.committed!.outboxMessageId);
    expect(canonical).not.toBeNull();
    expect(audit).not.toBeNull();
    expect(outbox).not.toBeNull();
    expect(canonical!.version).toBe(1);
    expect(outbox!.status).toBe('pending');
    // correlated across all three durable surfaces
    expect(canonical!.correlationId).toBe('c1');
    expect(audit!.correlationId).toBe('c1');
    expect(outbox!.correlationId).toBe('c1');
  });

  it('PARTIAL: a fault at the outbox write rolls back canonical + audit (all-or-none)', async () => {
    const { database, driver } = newDb(1);
    driver.faultAt('outbox_message', { sticky: true });
    const out = await commitUnitOfWork(database, req({ idempotencyKey: 'k-partial' }));
    expect(out.status).not.toBe('succeeded');
    driver.clearFault();
    // No partial durable row in ANY table — the negative control of atomicity.
    expect(driver.__committed.canonical_state.size).toBe(0);
    expect(driver.__committed.audit_event.size).toBe(0);
    expect(driver.__committed.outbox_message.size).toBe(0);
  });

  it('DUPLICATE: replaying the same unit runs the three writes exactly once', async () => {
    const { database, driver } = newDb();
    const r = req();
    const a = await commitUnitOfWork(database, r);
    const b = await commitUnitOfWork(database, r);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(driver.__committed.canonical_state.size).toBe(1);
    expect(driver.__committed.audit_event.size).toBe(1);
    expect(driver.__committed.outbox_message.size).toBe(1);
  });

  it('AUDIT: an incomplete audit blocks the whole unit before any durable effect', async () => {
    const { database, driver } = newDb();
    await expect(
      commitUnitOfWork(database, req({ audit: { ...req().audit, evidenceRefs: [] } })),
    ).rejects.toBeInstanceOf(IncompleteAuditError);
    expect(driver.__committed.canonical_state.size).toBe(0); // negative control
    expect(driver.__committed.audit_event.size).toBe(0);
    expect(driver.__committed.outbox_message.size).toBe(0);
  });

  it('CONFLICT: a stale expectedVersion does not succeed and leaves the row unchanged', async () => {
    const { database } = newDb();
    await commitUnitOfWork(database, req()); // version -> 1
    const conflict = await commitUnitOfWork(
      database,
      req({
        idempotencyKey: 'k2',
        request: { action: 'again' },
        canonical: {
          entityKind: 'controller',
          entityId: 'c-1',
          expectedVersion: 0,
          state: { status: 'stomp' },
        },
      }),
    );
    expect(conflict.status).not.toBe('succeeded');
    const canonical = await readCanonicalState(database, 't1', 'controller', 'c-1');
    expect(canonical!.version).toBe(1);
    expect(canonical!.state).toEqual({ status: 'ok' }); // not overwritten
  });

  it('RETRY-BOUNDED: a persistent transient fault exhausts the budget without partial effect', async () => {
    const { database, driver } = newDb(2);
    driver.faultAt('canonical_state', { code: '40001', sticky: true });
    const out = await commitUnitOfWork(database, req({ idempotencyKey: 'k-exhaust' }));
    expect(out.status).toBe('failed');
    expect(out.attempts).toBeLessThanOrEqual(2);
    driver.clearFault();
    expect(driver.__committed.canonical_state.size).toBe(0);
  });

  it('RECONCILE: confirms a genuinely-committed unit; NEVER claims success without a durable effect', async () => {
    // positive: real commit reconciles to succeeded
    const { database } = newDb();
    await commitUnitOfWork(database, req({ idempotencyKey: 'k-ok' }));
    const ok = await reconcileUnitOfWork(database, {
      tenantId: 't1',
      operationScope: 'controller.repair',
      idempotencyKey: 'k-ok',
      canonical: { entityKind: 'controller', entityId: 'c-1', expectedVersion: 0, state: {} },
    });
    expect(ok.resolved).toBe(true);
    expect(ok.status).toBe('succeeded');

    // negative: nothing durable ⇒ not resolved as success
    const { database: db2, driver } = newDb(1);
    driver.faultAt('outbox_message', { sticky: true });
    const failed = await commitUnitOfWork(db2, req({ idempotencyKey: 'k-none' }));
    expect(failed.status).not.toBe('succeeded');
    driver.clearFault();
    const rec = await reconcileUnitOfWork(db2, {
      tenantId: 't1',
      operationScope: 'controller.repair',
      idempotencyKey: 'k-none',
      canonical: { entityKind: 'controller', entityId: 'c-1', expectedVersion: 0, state: {} },
    });
    expect(rec.resolved).toBe(false);
    expect(rec.status).not.toBe('succeeded');
  });
});
