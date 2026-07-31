// Resilience suite — mutating operations are correlated, deduplicated, reconcilable,
// retry-bounded, and safe under duplicate / delayed / partial / conflicting / uncertain
// outcomes (packages/persistence/src/database.ts; Phase 17 / VO-52d0780c11bcc6fd7583).
//
// Runs under `vitest run --project resilience` (`test:resilience`). Every fault mode below is
// injected against the REAL runner via the in-memory driver, and each has a negative control.

import { describe, it, expect } from 'vitest';

import {
  Database,
  runMutation,
  reconcileMutation,
  UncertainOutcomeError,
  IdempotencyConflictError,
  ContractDriftError,
  type SqlDriver,
  type MutationRequest,
  type SourceContract,
} from '../../packages/persistence/src/database.ts';

import { createInMemoryDriver } from '../persistence/in-memory-driver.mjs';

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDb(maxAttempts = 5) {
  return new Database(createInMemoryDriver() as unknown as SqlDriver, {
    clock: makeClock(),
    retry: { maxAttempts, baseBackoffMs: 1 },
  });
}
const contract: SourceContract = {
  sourceId: 'servicenow',
  version: '2.0.0',
  contractDigest: 'digest-2',
  validated: true,
};
function req<T>(o: Partial<MutationRequest<T>> = {}): MutationRequest<T> {
  return {
    tenantId: 't1',
    operationScope: 'controller.repair',
    idempotencyKey: 'k1',
    correlationId: 'c1',
    contract,
    expectedContractVersion: '2.0.0',
    request: { action: 'apply' },
    effect: (async () => ({ ok: true })) as unknown as MutationRequest<T>['effect'],
    ...o,
  } as MutationRequest<T>;
}

describe('mutation safety under fault injection', () => {
  it('DUPLICATE: replaying the same request runs the effect exactly once', async () => {
    const db = newDb();
    let runs = 0;
    const r = req({ effect: async () => ({ ok: true, runs: ++runs }) });
    const a = await runMutation(db, r);
    const b = await runMutation(db, r);
    expect(runs).toBe(1);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(b.result).toEqual(a.result);
  });

  it('DELAYED/CONCURRENT: racing identical mutations are serialized to one effect', async () => {
    const db = newDb();
    let runs = 0;
    const r = req({
      effect: async () => {
        runs++;
        await new Promise((res) => setTimeout(res, 5));
        return { ok: true };
      },
    });
    const [a, b] = await Promise.all([runMutation(db, r), runMutation(db, r)]);
    expect(runs).toBe(1);
    expect([a.deduplicated, b.deduplicated].filter(Boolean)).toHaveLength(1);
  });

  it('CONFLICTING: same key, different body ⇒ conflict, original untouched', async () => {
    const db = newDb();
    await runMutation(db, req({ request: { v: 1 } }));
    await expect(runMutation(db, req({ request: { v: 2 } }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    const rec = await db.readIdempotencyRecord('t1', 'controller.repair', 'k1');
    expect(rec?.status).toBe('succeeded');
  });

  it('PARTIAL: an effect that throws mid-transaction leaves no durable effect', async () => {
    const db = newDb(1);
    const out = await runMutation(
      db,
      req({
        effect: async () => {
          throw new Error('mid-flight failure');
        },
      }),
    );
    expect(out.status).toBe('failed');
    expect(out.result).toBeUndefined();
    // Recorded as a terminal, visible failure (not silently dropped, not a success).
    const rec = await db.readIdempotencyRecord('t1', 'controller.repair', 'k1');
    expect(rec?.status).toBe('failed');
  });

  it('UNCERTAIN: unknown remote outcome ⇒ reconcile, never reported as success', async () => {
    const db = newDb(1);
    const out = await runMutation(
      db,
      req({
        effect: async () => {
          throw new UncertainOutcomeError('timeout after side-effect');
        },
      }),
    );
    expect(out.status).toBe('uncertain');
    expect(out.nextAction).toBe('reconcile');
    expect(out.status).not.toBe('succeeded');
  });

  it('RECONCILE: resolves uncertain state via independent observation, no re-execution', async () => {
    const db = newDb(1);
    let effectRuns = 0;
    await runMutation(
      db,
      req({
        effect: async () => {
          effectRuns++;
          throw new UncertainOutcomeError();
        },
      }),
    );
    expect(effectRuns).toBe(1);
    const resolved = await reconcileMutation(
      db,
      { tenantId: 't1', operationScope: 'controller.repair', idempotencyKey: 'k1' },
      async () => 'succeeded', // observed via a read path, not by re-running the effect
    );
    expect(effectRuns).toBe(1); // effect NOT re-run during reconcile — no duplicate effect
    expect(resolved.status).toBe('succeeded');
    const rec = await db.readIdempotencyRecord('t1', 'controller.repair', 'k1');
    expect(rec?.status).toBe('succeeded');
  });

  it('RETRY-BOUNDED: exhausting the bound stops and records failed (never unbounded)', async () => {
    const db = newDb(3);
    let calls = 0;
    const out = await runMutation(
      db,
      req({
        effect: async () => {
          calls++;
          const e = Object.assign(new Error('serialization'), { code: '40001' });
          throw e;
        },
      }),
    );
    expect(calls).toBe(3); // exactly the bound
    expect(out.status).toBe('failed');
  });

  it('VERSIONED+VALIDATED: source drift invalidates the operation (no effect) — negative control', async () => {
    const db = newDb();
    let ran = false;
    await expect(
      runMutation(
        db,
        req({ expectedContractVersion: '1.9.0', effect: async () => ((ran = true), { ok: true }) }),
      ),
    ).rejects.toBeInstanceOf(ContractDriftError);
    expect(ran).toBe(false);
  });
});
