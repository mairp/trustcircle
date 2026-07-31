// Verification-obligation test for VO-34d9f9fb2a6a39e2d62c / VO-3e0ee6687f6754efc03c
// (Phase 14 / packages/domain/src/primitives.ts).
//
// Oracle: Integrity rules, policies, controllers, controls, and mappings MUST have stable
// identifiers, versions, owners, lifecycle states, tests, monitoring, failure behavior,
// exceptions, and evidence expectations.
//
// Independently observable: exercises the REAL packages/domain/src/primitives.ts using only
// Node built-ins (loaded via --experimental-strip-types), so it runs deterministically under
// `npm ci` with no adjacent infrastructure. Every oracle facet is proven by a positive
// control (a complete value is accepted) paired with a negative control (a value missing that
// exact facet is rejected), so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'packages/domain/src/primitives.ts'));
const {
  uuidV7,
  isUuidV7,
  isUuid,
  toUuid,
  uuidV7Timestamp,
  createIdFactory,
  makeSourceTiming,
  occurredAt,
  observedAt,
  recordedAt,
  makeReason,
  isConsequentialReason,
  canTransition,
  assertTransition,
  isLifecycleState,
  PLATFORM_SCOPE,
  GOVERNED_ENTITY_KINDS,
  assertGovernanceContract,
  assertGovernedEntity,
  isGovernedEntity,
  governedEntityDigest,
} = mod;

// Deterministic entropy: identity generation never touches the wall clock.
const detRandom = (n) => new Uint8Array(n).fill(0xa7);
const T0 = 1_700_000_000_000;

/** A fully-governed entity used as the positive fixture for every governed entity. */
function goodEntity(overrides = {}) {
  return {
    id: uuidV7(T0, detRandom),
    kind: 'policy',
    tenantId: PLATFORM_SCOPE,
    version: 3,
    owner: { ownerId: 'team-governance', kind: 'team' },
    lifecycleState: 'active',
    contract: {
      tests: ['VO-34d9f9fb2a6a39e2d62c'],
      monitoring: ['alert.policy.stale'],
      failureBehavior: 'fail-closed',
      exceptions: [],
      evidenceExpectations: ['audit-event', 'decision-package'],
    },
    ...overrides,
  };
}

// ===========================================================================
// Facet 1 — STABLE IDENTIFIERS (UUIDv7)
// ===========================================================================

test('identifiers: uuidV7 produces a valid, version-7, time-ordered identifier', () => {
  const id = uuidV7(T0, detRandom);
  assert.ok(isUuid(id), 'must be a canonical UUID');
  assert.ok(isUuidV7(id), 'version nibble must be 7');
  assert.equal(uuidV7Timestamp(id), T0, 'embedded timestamp must round-trip');
  assert.equal(toUuid(id), id, 'toUuid accepts a valid UUID');
});

test('identifiers: ids minted in the same millisecond are strictly ordered (stable total order)', () => {
  const f = createIdFactory(detRandom);
  const a = f.next(T0);
  const b = f.next(T0); // same ms — factory must bump so b > a
  const c = f.next(T0 - 5); // stale clock — must still advance
  assert.ok(b > a, 'second id in same ms must sort after the first');
  assert.ok(c > b, 'monotonic even when the supplied clock goes backwards');
});

test('identifiers NEGATIVE: malformed / non-v7 strings are rejected', () => {
  assert.equal(isUuidV7('not-a-uuid'), false);
  assert.equal(isUuidV7('00000000-0000-4000-8000-000000000000'), false, 'v4 is not v7');
  assert.throws(() => toUuid('nope'), TypeError);
  assert.throws(() => uuidV7(-1, detRandom), RangeError, 'negative timestamp rejected');
});

// ===========================================================================
// Source / observation / recorded time are distinct and causally ordered
// ===========================================================================

test('time: occurred/observed/recorded are distinct and causally ordered', () => {
  const t = makeSourceTiming({
    occurredAt: 10,
    observedAt: 20,
    recordedAt: 30,
    orderingUncertain: true,
  });
  assert.equal(t.occurredAt, 10);
  assert.equal(t.observedAt, 20);
  assert.equal(t.recordedAt, 30);
  assert.equal(t.orderingUncertain, true);
  assert.equal(occurredAt(1), 1);
  assert.equal(observedAt(2), 2);
  assert.equal(recordedAt(3), 3);
});

test('time NEGATIVE: observed-before-occurred or recorded-before-observed is rejected', () => {
  assert.throws(
    () => makeSourceTiming({ occurredAt: 20, observedAt: 10, recordedAt: 30 }),
    RangeError,
  );
  assert.throws(
    () => makeSourceTiming({ occurredAt: 10, observedAt: 30, recordedAt: 20 }),
    RangeError,
  );
  assert.throws(() => occurredAt(-1), RangeError);
});

// ===========================================================================
// Structured reasons
// ===========================================================================

test('reasons: structured code + mandatory human text', () => {
  const r = makeReason('policy.violation', '  detected drift ');
  assert.equal(r.code, 'policy.violation');
  assert.equal(r.text, 'detected drift', 'text is trimmed');
  assert.ok(isConsequentialReason(r));
});

test('reasons NEGATIVE: empty/whitespace text or bad code is rejected', () => {
  assert.throws(
    () => makeReason('policy.violation', '   '),
    TypeError,
    'whitespace-only text rejected',
  );
  assert.throws(() => makeReason('policy.violation', ''), TypeError, 'empty text rejected');
  assert.throws(() => makeReason('Bad Code!', 'x'), TypeError, 'invalid code rejected');
  assert.equal(isConsequentialReason({ code: 'x.y', text: '   ' }), false);
});

// ===========================================================================
// LIFECYCLE STATES
// ===========================================================================

test('lifecycle: legal transitions permitted, terminal state is a sink', () => {
  assert.ok(isLifecycleState('active'));
  assert.ok(canTransition('draft', 'proposed'));
  assert.ok(canTransition('active', 'deprecated'));
  assert.ok(canTransition('active', 'retired'));
  assert.equal(canTransition('retired', 'active'), false, 'retired is terminal');
});

test('lifecycle NEGATIVE: illegal transition and unknown state rejected', () => {
  assert.throws(
    () => assertTransition('draft', 'active'),
    RangeError,
    'draft cannot jump to active',
  );
  assert.throws(() => assertTransition('retired', 'draft'), RangeError);
  assert.equal(isLifecycleState('bogus'), false);
});

// ===========================================================================
// GOVERNANCE CONTRACT — tests, monitoring, failure behavior, exceptions, evidence
// Each facet has its own negative control.
// ===========================================================================

test('governed entity: a complete entity carries all nine oracle facets', () => {
  const e = goodEntity();
  assert.doesNotThrow(() => assertGovernedEntity(e));
  assert.ok(isGovernedEntity(e));
  // Digest is a stable content hash that could not exist before construction.
  const d1 = governedEntityDigest(e);
  assert.match(d1, /^[0-9a-f]{64}$/);
  // Changing any governed facet changes the digest (tamper-evidence for higher layers).
  const d2 = governedEntityDigest(goodEntity({ version: 4 }));
  assert.notEqual(d1, d2);
});

test('governed entity applies to every oracle-named kind', () => {
  for (const kind of GOVERNED_ENTITY_KINDS) {
    assert.doesNotThrow(
      () => assertGovernedEntity(goodEntity({ kind })),
      `kind ${kind} must be governable`,
    );
  }
  assert.deepEqual(
    [...GOVERNED_ENTITY_KINDS].sort(),
    ['control', 'controller', 'integrity-rule', 'mapping', 'policy'],
    'oracle enumerates rules/policies/controllers/controls/mappings',
  );
});

test('governed entity NEGATIVE: missing STABLE IDENTIFIER rejected', () => {
  assert.throws(() => assertGovernedEntity(goodEntity({ id: 'not-a-uuidv7' })), /identifier/i);
  assert.equal(isGovernedEntity(goodEntity({ id: undefined })), false);
});

test('governed entity NEGATIVE: missing/invalid VERSION rejected', () => {
  assert.throws(() => assertGovernedEntity(goodEntity({ version: 0 })), /version/i);
  assert.throws(() => assertGovernedEntity(goodEntity({ version: 1.5 })), /version/i);
});

test('governed entity NEGATIVE: missing OWNER rejected', () => {
  assert.throws(
    () => assertGovernedEntity(goodEntity({ owner: { ownerId: '', kind: 'team' } })),
    /owner/i,
  );
  assert.throws(
    () => assertGovernedEntity(goodEntity({ owner: { ownerId: 'x', kind: 'robot' } })),
    /owner/i,
  );
});

test('governed entity NEGATIVE: missing LIFECYCLE STATE rejected', () => {
  assert.throws(() => assertGovernedEntity(goodEntity({ lifecycleState: 'bogus' })), /lifecycle/i);
});

test('governed entity NEGATIVE: not tenant-scoped rejected', () => {
  assert.throws(() => assertGovernedEntity(goodEntity({ tenantId: 'tenant' })), /tenant-scoped/i);
});

test('contract NEGATIVE: missing TESTS rejected', () => {
  assert.throws(() => assertGovernanceContract({ ...goodEntity().contract, tests: [] }), /tests/i);
});

test('contract NEGATIVE: missing MONITORING rejected', () => {
  assert.throws(
    () => assertGovernanceContract({ ...goodEntity().contract, monitoring: [] }),
    /monitoring/i,
  );
});

test('contract NEGATIVE: invalid FAILURE BEHAVIOR rejected', () => {
  assert.throws(
    () => assertGovernanceContract({ ...goodEntity().contract, failureBehavior: 'explode' }),
    /failureBehavior/i,
  );
});

test('contract NEGATIVE: absent EXCEPTIONS register rejected; malformed exception rejected', () => {
  assert.throws(
    () => assertGovernanceContract({ ...goodEntity().contract, exceptions: undefined }),
    /exceptions/i,
  );
  const badExc = {
    ...goodEntity().contract,
    exceptions: [
      {
        exceptionId: 'bad',
        reason: { code: 'x.y', text: '' },
        approvedBy: { ownerId: '', kind: 'user' },
        expiresAt: -1,
      },
    ],
  };
  assert.throws(() => assertGovernanceContract(badExc));
});

test('contract POSITIVE: a well-formed EXCEPTION is accepted', () => {
  const exc = {
    exceptionId: uuidV7(T0, detRandom),
    reason: makeReason('exception.granted', 'temporary waiver approved by risk owner'),
    approvedBy: { ownerId: 'risk-owner', kind: 'user' },
    expiresAt: T0 + 86_400_000,
  };
  assert.doesNotThrow(() =>
    assertGovernedEntity(goodEntity({ contract: { ...goodEntity().contract, exceptions: [exc] } })),
  );
});

test('contract NEGATIVE: missing EVIDENCE EXPECTATIONS rejected', () => {
  assert.throws(
    () => assertGovernanceContract({ ...goodEntity().contract, evidenceExpectations: [] }),
    /evidenceExpectations/i,
  );
});
