// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — ADAPTER PROTOCOL CONTRACT (T152 · FR-026 · FR-027 · FR-028 · NS-005 · SC-011).
//
// CONTRACT oracle for the version-pinned, idempotency-keyed adapter dispatch/observe protocol
// (`AdapterClient`, packages/adapter-sdk/src/client.ts) driven over the deterministic stub adapter
// (tests/fixtures/adapters/stub-adapter.ts). The protocol's whole reason for existing is to REFUSE the
// dangerous lie that an acknowledgement is a confirmed effect. This suite pins the contract at every
// dangerous branch:
//
//   * A plain 2xx acknowledgement is `dispatched_unconfirmed` + mustReconcile — NEVER confirmed (FR-027).
//   * A DIRECT remote-effect observation is the ONLY path to `confirmed` (FR-028).
//   * A timeout / severed connection is `uncertain`/`timed_out`, retryable under the SAME key (FR-026).
//   * A drifted version echo is a hard `failed` — a drifted adapter never confirms (NS-005).
//   * `observe` reporting >1 effect for one identity is a duplicate divergence (SC-011).
//   * dispatch REQUIRES an idempotency key ≥ 8 chars (FR-026 one identity).
//
// Every assertion pins the client's own DispatchResult / ObserveResult verdicts — never a raw echo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import { AdapterClient, type AdapterClientConfig } from '@trustcircle/adapter-sdk';

import { StubControllerAdapter } from '../fixtures/adapters/stub-adapter.ts';

const PIN = {
  adapterProtocolVersion: 1,
  adapterVersionId: 'adapter-v1',
  sourceRevision: 'rev-1000',
} as const;

function clientOver(adapter: StubControllerAdapter): AdapterClient {
  const config: AdapterClientConfig = {
    baseUrl: 'https://adapter.internal/v1',
    credentials: { tenantId: 'tenant-1', token: 'secret-token' },
    pin: PIN,
    timeoutMs: 5_000,
  };
  return new AdapterClient(adapter.transport, config);
}

const DISPATCH = {
  operationId: 'op-0001',
  operationKind: 'execute' as const,
  idempotencyKey: 'idem-key-0001',
  desiredState: { ruleset: 'baseline', deny_all: false },
};

describe('adapter dispatch — an acknowledgement is NOT a confirmation (FR-027/FR-028)', () => {
  it('a plain 2xx ack is dispatched_unconfirmed and MUST reconcile — never confirmed', async () => {
    const adapter = new StubControllerAdapter({ applyEffectOnDispatch: false, reportEffectObservedOnDispatch: false });
    const res = await clientOver(adapter).dispatch(DISPATCH);
    expect(res.outcome).toBe('dispatched_unconfirmed');
    expect(res.remoteEffectObserved).toBe(false);
    expect(res.mustReconcile).toBe(true);
  });

  it('a DIRECT remote-effect observation is the ONLY path to confirmed', async () => {
    const adapter = new StubControllerAdapter({ reportEffectObservedOnDispatch: true, applyEffectOnDispatch: true });
    const res = await clientOver(adapter).dispatch(DISPATCH);
    expect(res.outcome).toBe('confirmed');
    expect(res.remoteEffectObserved).toBe(true);
  });

  it('a timeout is timed_out, uncertain, retryable under the SAME key, must reconcile (FR-026)', async () => {
    const adapter = new StubControllerAdapter({ timeoutDispatch: true });
    const res = await clientOver(adapter).dispatch(DISPATCH);
    expect(res.outcome).toBe('timed_out');
    expect(res.retryableUnderSameKey).toBe(true);
    expect(res.mustReconcile).toBe(true);
  });

  it('a severed connection is uncertain and must reconcile', async () => {
    const adapter = new StubControllerAdapter({ severDispatch: true });
    const res = await clientOver(adapter).dispatch(DISPATCH);
    expect(res.outcome).toBe('uncertain');
    expect(res.mustReconcile).toBe(true);
  });

  it('a drifted version echo is a hard failed — a drifted adapter never confirms (NS-005)', async () => {
    const adapter = new StubControllerAdapter({ driftEcho: true, reportEffectObservedOnDispatch: true });
    const res = await clientOver(adapter).dispatch(DISPATCH);
    expect(res.outcome).toBe('failed');
    expect(res.remoteEffectObserved).toBe(false);
    expect(res.mustReconcile).toBe(true);
  });

  it('dispatch refuses an idempotency key shorter than 8 chars (FR-026 one identity)', async () => {
    const adapter = new StubControllerAdapter();
    await expect(clientOver(adapter).dispatch({ ...DISPATCH, idempotencyKey: 'short' })).rejects.toThrow(/idempotency/i);
  });
});

describe('adapter observe — reconciliation reads authoritative state (FR-028/SC-011)', () => {
  it('after an unconfirmed dispatch whose effect DID land, observe sees exactly one effect', async () => {
    const adapter = new StubControllerAdapter({ applyEffectOnDispatch: true, observedRevision: 'rev-1000' });
    const client = clientOver(adapter);
    await client.dispatch(DISPATCH);
    const obs = await client.observe(DISPATCH.operationId, DISPATCH.idempotencyKey);
    expect(obs.reachable).toBe(true);
    expect(obs.observedEffectCount).toBe(1);
    expect(obs.remoteEffectObserved).toBe(true);
  });

  it('observe reporting >1 effect for one identity is a duplicate divergence (SC-011)', async () => {
    const adapter = new StubControllerAdapter({ applyEffectOnDispatch: true, duplicateEffect: true });
    const client = clientOver(adapter);
    await client.dispatch(DISPATCH);
    const obs = await client.observe(DISPATCH.operationId, DISPATCH.idempotencyKey);
    expect(obs.observedEffectCount).toBeGreaterThan(1);
  });

  it('an unreachable observe is not a false "no effect" — it reports unreachable', async () => {
    const adapter = new StubControllerAdapter({ observeUnreachable: true });
    const client = clientOver(adapter);
    const obs = await client.observe(DISPATCH.operationId, DISPATCH.idempotencyKey);
    expect(obs.reachable).toBe(false);
  });

  it('a retry under the SAME idempotency key still resolves to exactly one effect (FR-026/SC-011)', async () => {
    // First dispatch times out (uncertain). The effect actually landed. A retry under the same key
    // must not create a second effect — observe still sees exactly one.
    const adapter = new StubControllerAdapter({ timeoutDispatch: true });
    const client = clientOver(adapter);
    const first = await client.dispatch(DISPATCH);
    expect(first.outcome).toBe('timed_out');
    // The effect landed despite the lost ack (out-of-band).
    adapter.applyEffect(DISPATCH.idempotencyKey, { revision: 'rev-1000' });
    // Retry under the SAME key.
    const retry = await client.dispatch(DISPATCH);
    expect(retry.outcome).not.toBe('timed_out');
    const obs = await client.observe(DISPATCH.operationId, DISPATCH.idempotencyKey);
    expect(obs.observedEffectCount).toBe(1);
  });
});
