// Verification-obligation test for VO-34d9f9fb2a6a39e2d62c
// (Phase 15 / packages/domain/src/state-machine.ts).
//
// Oracle: Integrity rules, policies, controllers, controls, and mappings MUST have stable
// identifiers, versions, owners, lifecycle states, tests, monitoring, failure behavior,
// exceptions, and evidence expectations.
//
// This suite exercises the REAL packages/domain/src/state-machine.ts using only Node built-ins
// (loaded via --experimental-strip-types), so it runs deterministically under `npm ci` with no
// adjacent infrastructure. Every property is proven by a positive control paired with a
// negative control, so the assertions are non-vacuous:
//
//   * Governance (oracle): a machine cannot be defined unless it is a fully governed entity —
//     all nine facets (stable id, version, owner, lifecycle, tests, monitoring, failure
//     behavior, exceptions, evidence expectations); dropping ANY facet is rejected.
//   * Guarded transitions: a declared, guard-permitted transition applies; a guard denial is a
//     recorded, explained REJECTION with no state change.
//   * Optimistic concurrency: a stale expected-version is a CONFLICT with no effect.
//   * Terminal-history preservation: terminal states are sinks — outgoing transitions cannot be
//     declared, transitioning out is rejected, and the entry-into-terminal history is retained.
//   * Append-only history + durable-effect witness: history grows monotonically; the instance
//     digest changes iff durable state changes and is re-derivable from an independent snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sm = await import(join(ROOT, 'packages/domain/src/state-machine.ts'));
const prim = await import(join(ROOT, 'packages/domain/src/primitives.ts'));

const { defineStateMachine, allow, deny, instanceDigest } = sm;
const { uuidV7, makeReason, PLATFORM_SCOPE } = prim;

const detRandom = (n) => new Uint8Array(n).fill(0xa7);
const T0 = 1_700_000_000_000;
const R = () => makeReason('transition.test', 'because the test says so');

/** A complete governance contract (all five contract facets, non-vacuous). */
function goodContract(overrides = {}) {
  return {
    tests: ['VO-34d9f9fb2a6a39e2d62c'],
    monitoring: ['alert.machine.stuck'],
    failureBehavior: 'pause-safe',
    exceptions: [],
    evidenceExpectations: ['audit-event', 'transition-history'],
    ...overrides,
  };
}

/** A fully-governed entity for a machine definition. */
function governance(overrides = {}) {
  return {
    id: uuidV7(T0, detRandom),
    kind: 'controller',
    tenantId: PLATFORM_SCOPE,
    version: 1,
    owner: { ownerId: 'team-governance', kind: 'team' },
    lifecycleState: 'active',
    contract: goodContract(),
    ...overrides,
  };
}

/**
 * A small work-item-style machine mirroring the data-model lifecycle:
 *   open → in_progress → resolved → closed(terminal) | cancelled(terminal)
 * A guard on resolved→closed requires context.evidenceComplete === true.
 */
function workMachine(govOverrides = {}) {
  return defineStateMachine({
    governance: governance(govOverrides),
    states: ['open', 'in_progress', 'resolved', 'closed', 'cancelled'],
    initial: 'open',
    terminal: ['closed', 'cancelled'],
    transitions: [
      { from: 'open', to: 'in_progress' },
      { from: 'open', to: 'cancelled' },
      { from: 'in_progress', to: 'resolved' },
      { from: 'in_progress', to: 'cancelled' },
      {
        from: 'resolved',
        to: 'closed',
        guard: ({ context }) =>
          context && context.evidenceComplete
            ? allow()
            : deny(makeReason('closure.evidence_missing', 'closure requires complete evidence')),
      },
    ],
  });
}

const ID = () => uuidV7(T0 + 1, detRandom);

// ===========================================================================
// ORACLE — a machine is a fully governed entity (all nine facets)
// ===========================================================================

test('governance POSITIVE: a fully-governed machine exposes all nine oracle facets', () => {
  const m = workMachine();
  assert.match(m.id, /^[0-9a-f-]{36}$/, 'stable identifier');
  assert.equal(m.version, 1, 'version');
  assert.equal(m.owner.ownerId, 'team-governance', 'owner');
  assert.equal(m.lifecycleState, 'active', 'lifecycle state');
  assert.deepEqual([...m.contract.tests], ['VO-34d9f9fb2a6a39e2d62c'], 'tests');
  assert.ok(m.contract.monitoring.length > 0, 'monitoring');
  assert.equal(m.contract.failureBehavior, 'pause-safe', 'failure behavior');
  assert.ok(Array.isArray(m.contract.exceptions), 'exceptions register present');
  assert.ok(m.contract.evidenceExpectations.length > 0, 'evidence expectations');
});

test('governance NEGATIVE: missing STABLE IDENTIFIER is rejected', () => {
  assert.throws(() => workMachine({ id: 'not-a-uuidv7' }), /identifier/i);
});

test('governance NEGATIVE: missing/invalid VERSION is rejected', () => {
  assert.throws(() => workMachine({ version: 0 }), /version/i);
});

test('governance NEGATIVE: missing OWNER is rejected', () => {
  assert.throws(() => workMachine({ owner: { ownerId: '', kind: 'team' } }), /owner/i);
});

test('governance NEGATIVE: missing LIFECYCLE STATE is rejected', () => {
  assert.throws(() => workMachine({ lifecycleState: 'bogus' }), /lifecycle/i);
});

test('governance NEGATIVE: each missing CONTRACT facet is rejected', () => {
  assert.throws(() => workMachine({ contract: goodContract({ tests: [] }) }), /tests/i);
  assert.throws(() => workMachine({ contract: goodContract({ monitoring: [] }) }), /monitoring/i);
  assert.throws(
    () => workMachine({ contract: goodContract({ failureBehavior: 'explode' }) }),
    /failureBehavior/i,
  );
  assert.throws(
    () => workMachine({ contract: goodContract({ exceptions: undefined }) }),
    /exceptions/i,
  );
  assert.throws(
    () => workMachine({ contract: goodContract({ evidenceExpectations: [] }) }),
    /evidenceExpectations/i,
  );
});

// ===========================================================================
// TOPOLOGY — well-formed machine
// ===========================================================================

test('topology NEGATIVE: transition endpoints and initial state must be declared states', () => {
  assert.throws(
    () =>
      defineStateMachine({
        governance: governance(),
        states: ['a', 'b'],
        initial: 'z',
        terminal: [],
        transitions: [],
      }),
    /initial/i,
  );
  assert.throws(
    () =>
      defineStateMachine({
        governance: governance(),
        states: ['a', 'b'],
        initial: 'a',
        terminal: [],
        transitions: [{ from: 'a', to: 'nowhere' }],
      }),
    /transition\.to/i,
  );
});

test('topology NEGATIVE: a terminal state may not declare an outgoing transition', () => {
  assert.throws(
    () =>
      defineStateMachine({
        governance: governance(),
        states: ['a', 'done'],
        initial: 'a',
        terminal: ['done'],
        transitions: [
          { from: 'a', to: 'done' },
          { from: 'done', to: 'a' }, // terminal rewrite at construction time
        ],
      }),
    /terminal/i,
  );
});

test('topology: introspection reports states/terminals/targets', () => {
  const m = workMachine();
  assert.ok(m.isState('open'));
  assert.equal(m.isState('bogus'), false);
  assert.ok(m.isTerminal('closed'));
  assert.equal(m.isTerminal('open'), false);
  assert.ok(m.hasTransition('open', 'in_progress'));
  assert.equal(m.hasTransition('open', 'resolved'), false);
  assert.deepEqual([...m.allowedTargets('open')].sort(), ['cancelled', 'in_progress']);
});

// ===========================================================================
// GUARDED TRANSITIONS
// ===========================================================================

test('transition POSITIVE: a declared, guard-permitted transition applies and bumps version', () => {
  const m = workMachine();
  let inst = m.create(ID(), T0);
  assert.equal(inst.state, 'open');
  assert.equal(inst.version, 1);

  const r1 = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'alice',
    reason: R(),
    at: T0 + 1,
    context: {},
  });
  assert.equal(r1.outcome, 'applied');
  inst = r1.instance;
  assert.equal(inst.state, 'in_progress');
  assert.equal(inst.version, 2, 'version bumped');
  assert.equal(r1.entry.from, 'open');
  assert.equal(r1.entry.to, 'in_progress');
  assert.equal(r1.entry.seq, 1);
  assert.equal(r1.entry.actorId, 'alice');
});

test('transition NEGATIVE: a guard denial is a recorded, explained rejection with NO change', () => {
  const m = workMachine();
  let inst = m.create(ID(), T0);
  inst = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  }).instance;
  inst = m.apply(inst, {
    to: 'resolved',
    expectedVersion: 2,
    actorId: 'a',
    reason: R(),
    at: 2,
    context: {},
  }).instance;
  assert.equal(inst.state, 'resolved');

  // Guard requires evidenceComplete — deny it.
  const denied = m.apply(inst, {
    to: 'closed',
    expectedVersion: 3,
    actorId: 'a',
    reason: R(),
    at: 3,
    context: { evidenceComplete: false },
  });
  assert.equal(denied.outcome, 'rejected');
  assert.equal(denied.code, 'guard-denied');
  assert.equal(denied.reason.code, 'closure.evidence_missing');
  assert.equal(inst.state, 'resolved', 'state unchanged by a rejected guard');
  assert.equal(inst.version, 3, 'version unchanged by a rejected guard');

  // Same transition, guard satisfied — now it applies.
  const ok = m.apply(inst, {
    to: 'closed',
    expectedVersion: 3,
    actorId: 'a',
    reason: R(),
    at: 4,
    context: { evidenceComplete: true },
  });
  assert.equal(ok.outcome, 'applied');
  assert.equal(ok.instance.state, 'closed');
});

test('transition NEGATIVE: undeclared transition and missing reason are recorded rejections', () => {
  const m = workMachine();
  const inst = m.create(ID(), T0);
  const noSuch = m.apply(inst, {
    to: 'resolved',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  });
  assert.equal(noSuch.outcome, 'rejected');
  assert.equal(noSuch.code, 'no-such-transition');

  const noReason = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'a',
    reason: { code: 'x.y', text: '   ' }, // whitespace-only reason
    at: 1,
    context: {},
  });
  assert.equal(noReason.outcome, 'rejected');
  assert.match(noReason.reason.code, /reason_required/);
  assert.equal(inst.state, 'open', 'no transition without a reason');

  assert.throws(() => deny(makeReason('ok', '')), TypeError, 'deny needs a real reason');
});

// ===========================================================================
// OPTIMISTIC CONCURRENCY
// ===========================================================================

test('concurrency NEGATIVE: a stale expected-version is a CONFLICT with no effect', () => {
  const m = workMachine();
  let inst = m.create(ID(), T0);
  inst = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  }).instance;
  assert.equal(inst.version, 2);

  // A second writer still believes version is 1 → conflict, zero rows.
  const conflict = m.apply(inst, {
    to: 'resolved',
    expectedVersion: 1,
    actorId: 'b',
    reason: R(),
    at: 2,
    context: {},
  });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.expectedVersion, 1);
  assert.equal(conflict.actualVersion, 2);
  assert.equal(inst.state, 'in_progress', 'no effect on conflict');
  assert.equal(inst.version, 2);
});

// ===========================================================================
// TERMINAL-HISTORY PRESERVATION
// ===========================================================================

test('terminal POSITIVE: entering a terminal state retains the FULL ordered history', () => {
  const m = workMachine();
  let inst = m.create(ID(), T0);
  inst = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  }).instance;
  inst = m.apply(inst, {
    to: 'resolved',
    expectedVersion: 2,
    actorId: 'a',
    reason: R(),
    at: 2,
    context: {},
  }).instance;
  inst = m.apply(inst, {
    to: 'closed',
    expectedVersion: 3,
    actorId: 'a',
    reason: R(),
    at: 3,
    context: { evidenceComplete: true },
  }).instance;

  assert.equal(inst.state, 'closed');
  assert.equal(inst.history.length, 3, 'every transition is retained');
  assert.deepEqual(
    inst.history.map((h) => `${h.from}->${h.to}`),
    ['open->in_progress', 'in_progress->resolved', 'resolved->closed'],
    'history is ordered and reconstructable, including entry into the terminal state',
  );
  assert.deepEqual(
    inst.history.map((h) => h.seq),
    [1, 2, 3],
    'sequence numbers are strictly increasing',
  );
});

test('terminal NEGATIVE: transitioning OUT of a terminal state is rejected (rewrite blocked)', () => {
  const m = workMachine();
  let inst = m.create(ID(), T0);
  inst = m.apply(inst, {
    to: 'cancelled',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  }).instance;
  assert.equal(inst.state, 'cancelled');
  const beforeDigest = instanceDigest(inst);

  const rewrite = m.apply(inst, {
    to: 'open',
    expectedVersion: 2,
    actorId: 'a',
    reason: R(),
    at: 2,
    context: {},
  });
  assert.equal(rewrite.outcome, 'rejected');
  assert.equal(rewrite.code, 'terminal-state-rewrite');
  assert.equal(inst.state, 'cancelled', 'terminal state preserved');
  assert.equal(instanceDigest(inst), beforeDigest, 'no durable change on a rejected rewrite');
});

// ===========================================================================
// APPEND-ONLY HISTORY + DURABLE-EFFECT WITNESS
// ===========================================================================

test('history: restore accepts a contiguous ledger and rejects a truncated/reordered one', () => {
  const m = workMachine();
  let inst = m.create(ID(), T0);
  inst = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  }).instance;
  const snap = inst.snapshot();

  // Round-trips through an independent read path.
  const restored = m.restore(snap);
  assert.equal(restored.state, 'in_progress');
  assert.equal(restored.version, 2);
  assert.equal(restored.history.length, 1);

  // A rewritten (reordered/truncated) history is rejected — history is append-only.
  const tampered = { ...snap, history: [{ ...snap.history[0], seq: 5 }] };
  assert.throws(() => m.restore(tampered), /contiguous|increasing/i);
});

test('witness: instance digest changes iff durable state changes and is re-derivable', () => {
  const m = workMachine();
  const id = ID();
  let inst = m.create(id, T0);
  const d0 = instanceDigest(inst);

  inst = m.apply(inst, {
    to: 'in_progress',
    expectedVersion: 1,
    actorId: 'a',
    reason: R(),
    at: 1,
    context: {},
  }).instance;
  const d1 = instanceDigest(inst);
  assert.notEqual(d0, d1, 'a durable transition changes the digest');
  assert.match(d1, /^[0-9a-f]{64}$/);

  // Independently re-derive the digest from a persisted snapshot (mutation response is NOT proof).
  const reread = m.restore(inst.snapshot());
  assert.equal(
    instanceDigest(reread.snapshot()),
    d1,
    'digest re-derivable from an independent read',
  );
});
