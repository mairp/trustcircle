// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — OPERATION IDEMPOTENCY (T154 · FR-026 · FR-027 · FR-028 · SC-011).
//
// INTEGRATION oracle for ONE-IDENTITY → ONE-EFFECT: a single logical dispatch carries ONE idempotency
// key across every retry, so an uncertain/timed-out first attempt can be safely retried under the SAME
// key and still resolve to EXACTLY ONE governed effect — never a duplicate. This suite drives the REAL
// `AdapterClient` (packages/adapter-sdk) over the deterministic `StubControllerAdapter` transport AND
// the REAL `reconcileOperation` + `mayMutateAfterReconciliation` application service (packages/
// application/operation-reconciliation.ts), end to end:
//
//   * A first dispatch TIMES OUT (uncertain). The effect actually landed out-of-band. A retry under the
//     SAME idempotency key does NOT create a second effect — a direct `observe` sees exactly ONE.
//   * That single observed effect reconciles to `reconciled_effect_present` — the ONLY success path,
//     established by a DIRECT observation, never inferred from an acknowledgement (FR-028).
//   * Reconciliation GATES the next mutation: only after state is established may a new mutation proceed
//     (FR-028 reconcile-before-mutation); an unreconciled uncertain outcome blocks it.
//   * A DUPLICATE effect (>1 for one identity) reconciles to a `conflict`, surfaced as duplicateEffect,
//     never as a success (SC-011).
//   * A never-landed dispatch reconciles to `reconciled_no_effect` — a redispatch under the same key is
//     then safe (idempotent).
//
// Every assertion pins a client/service verdict — never a raw adapter echo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import { AdapterClient, type AdapterClientConfig } from '@trustcircle/adapter-sdk';
import { reconcileOperation, mayMutateAfterReconciliation } from '@trustcircle/application';

import { StubControllerAdapter } from '../fixtures/adapters/stub-adapter.ts';
import { NOW, TENANT, uuidFromSlug } from '../fixtures/controllers.ts';

import type { EpochMillis, Uuid } from '@trustcircle/domain';

const PIN = {
  adapterProtocolVersion: 1,
  adapterVersionId: 'adapter-v1',
  sourceRevision: 'rev-1000',
} as const;

const IDEM = 'idem-op-one-identity';
const OP = 'op-idem-0001';

function clientOver(adapter: StubControllerAdapter): AdapterClient {
  const config: AdapterClientConfig = {
    baseUrl: 'https://adapter.internal/v1',
    credentials: { tenantId: 'tenant-1', token: 'secret-token' },
    pin: PIN,
  };
  return new AdapterClient(adapter.transport, config);
}

const DISPATCH = {
  operationId: OP,
  operationKind: 'execute' as const,
  idempotencyKey: IDEM,
  desiredState: { ruleset: 'baseline', deny_all: false },
};

const OP_UUID: Uuid = uuidFromSlug('operation-idem');

describe('one identity → one effect across a retry (FR-026/SC-011)', () => {
  it('a timed-out dispatch retried under the SAME key resolves to exactly one observed effect', async () => {
    const adapter = new StubControllerAdapter({ timeoutDispatch: true });
    const client = clientOver(adapter);

    const first = await client.dispatch(DISPATCH);
    expect(first.outcome).toBe('timed_out');
    expect(first.retryableUnderSameKey).toBe(true);
    expect(first.mustReconcile).toBe(true);

    // The effect actually landed despite the lost acknowledgement.
    adapter.applyEffect(IDEM, { revision: 'rev-1000' });

    // A retry under the SAME idempotency key must not create a second effect.
    const retry = await client.dispatch(DISPATCH);
    expect(retry.outcome).not.toBe('timed_out');

    const obs = await client.observe(OP, IDEM);
    expect(obs.reachable).toBe(true);
    expect(obs.observedEffectCount).toBe(1);
    expect(adapter.effectCount(IDEM)).toBe(1);
  });
});

describe('reconciliation is the ONLY success path and it gates the next mutation (FR-028)', () => {
  it('a single directly-observed effect reconciles to reconciled_effect_present and unblocks mutation', async () => {
    const adapter = new StubControllerAdapter({
      applyEffectOnDispatch: true,
      observedRevision: 'rev-1000',
    });
    const client = clientOver(adapter);
    await client.dispatch(DISPATCH);
    const obs = await client.observe(OP, IDEM);

    const outcome = reconcileOperation({
      id: uuidFromSlug('recon-present'),
      tenantId: TENANT,
      operationId: OP_UUID,
      desiredState: DISPATCH.desiredState,
      remoteObservedState: { ruleset: 'baseline', deny_all: false },
      observedEffectCount: obs.observedEffectCount,
      usedRemoteObservation: obs.reachable,
      remoteMatchesDesired: true,
      ranAt: NOW as EpochMillis,
    });

    expect(outcome.run.result).toBe('reconciled_effect_present');
    expect(outcome.establishedState).toBe(true);
    expect(outcome.duplicateEffect).toBe(false);

    // FR-028 — only now, with state established, may a new mutation proceed.
    const gate = mayMutateAfterReconciliation(outcome.run);
    expect(gate.permitted).toBe(true);
  });

  it('an unreconciled uncertain outcome BLOCKS the next mutation (reconcile-before-mutation)', () => {
    // No reconciliation run at all → mutation refused.
    const gate = mayMutateAfterReconciliation(undefined);
    expect(gate.permitted).toBe(false);
    expect(gate.reason).toBe('no_reconciliation_run_yet');
  });

  it('a still-uncertain reconciliation (remote unreadable) does NOT establish state and BLOCKS mutation', async () => {
    const adapter = new StubControllerAdapter({ observeUnreachable: true });
    const client = clientOver(adapter);
    const obs = await client.observe(OP, IDEM);
    expect(obs.reachable).toBe(false);

    const outcome = reconcileOperation({
      id: uuidFromSlug('recon-uncertain'),
      tenantId: TENANT,
      operationId: OP_UUID,
      observedEffectCount: obs.observedEffectCount,
      usedRemoteObservation: obs.reachable, // false → cannot establish
      remoteMatchesDesired: false,
      ranAt: NOW as EpochMillis,
    });
    expect(outcome.run.result).toBe('still_uncertain');
    expect(outcome.establishedState).toBe(false);
    expect(mayMutateAfterReconciliation(outcome.run).permitted).toBe(false);
  });
});

describe('a duplicate effect is surfaced as a conflict, never a success (SC-011)', () => {
  it('observe reporting >1 effect reconciles to conflict + duplicateEffect', async () => {
    const adapter = new StubControllerAdapter({
      applyEffectOnDispatch: true,
      duplicateEffect: true,
    });
    const client = clientOver(adapter);
    await client.dispatch(DISPATCH);
    const obs = await client.observe(OP, IDEM);
    expect(obs.observedEffectCount).toBeGreaterThan(1);

    const outcome = reconcileOperation({
      id: uuidFromSlug('recon-dup'),
      tenantId: TENANT,
      operationId: OP_UUID,
      remoteObservedState: { ruleset: 'baseline', deny_all: false },
      observedEffectCount: obs.observedEffectCount,
      usedRemoteObservation: true,
      remoteMatchesDesired: true,
      ranAt: NOW as EpochMillis,
    });
    expect(outcome.run.result).toBe('conflict');
    expect(outcome.duplicateEffect).toBe(true);
    expect(outcome.establishedState).toBe(false);
  });
});

describe('a never-landed dispatch reconciles to no-effect, so a redispatch is safe (idempotent)', () => {
  it('observe seeing zero effects reconciles to reconciled_no_effect', async () => {
    const adapter = new StubControllerAdapter({ applyEffectOnDispatch: false });
    const client = clientOver(adapter);
    const ack = await client.dispatch(DISPATCH);
    expect(ack.outcome).toBe('dispatched_unconfirmed'); // acknowledged, not confirmed
    const obs = await client.observe(OP, IDEM);
    expect(obs.observedEffectCount).toBe(0);

    const outcome = reconcileOperation({
      id: uuidFromSlug('recon-none'),
      tenantId: TENANT,
      operationId: OP_UUID,
      remoteObservedState: { ruleset: 'unchanged' },
      observedEffectCount: 0,
      usedRemoteObservation: true,
      remoteMatchesDesired: false,
      ranAt: NOW as EpochMillis,
    });
    expect(outcome.run.result).toBe('reconciled_no_effect');
    // no-effect ESTABLISHES state (the dispatch definitively did not land) → redispatch safe.
    expect(outcome.establishedState).toBe(true);
  });
});
