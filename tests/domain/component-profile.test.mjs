// Verification-obligation test for VO-713cc2a06e03c63484b4
// (Phase 52 / packages/domain/src/component-profile.ts / NFR-010).
//
// Oracle (NFR-010): Loss of required authority, policy, evidence, ownership, or reconciliation
// MUST block affected execution immediately. Health or connectivity loss MUST block new
// execution immediately; an in-progress operation may continue only under FR-046 through FR-050
// while read-only visibility and escalation remain available.
//
// This suite exercises the REAL packages/domain/src/component-profile.ts using only Node
// built-ins (loaded via --experimental-strip-types), so it runs deterministically under
// `npm ci` with no adjacent infrastructure. Every property is proven by a POSITIVE control
// paired with a NEGATIVE control, so the assertions are non-vacuous:
//
//   * Separation: the owner-approved ARCHITECTURE ROLE and the runtime AVAILABILITY class are
//     two distinct, independently-validated facts; neither is inferred from the other.
//   * Owner approval / review date: an architecture role cannot be defined without a named
//     approver, a structured reason, and a MANDATORY review date after its effective date.
//   * NFR-010 sentence 1: loss of ANY governance prerequisite (authority/policy/evidence/
//     ownership/reconciliation) blocks BOTH new and in-progress execution immediately, and
//     continuity mode cannot rescue it.
//   * NFR-010 sentence 2a: health/connectivity loss blocks NEW execution immediately.
//   * NFR-010 sentence 2b: an in-progress operation continues ONLY under a valid, unexpired
//     FR-046–FR-050 continuity lease whose step is locally verifiable; otherwise it pauses and
//     requires reconciliation.
//   * NFR-010 invariant: read-only visibility and escalation ALWAYS remain available.
//   * Durable-effect witness: the profile digest is re-derivable and changes iff a governed
//     facet / role / dependency / authority / activation / approval changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cp = await import(join(ROOT, 'packages/domain/src/component-profile.ts'));
const prim = await import(join(ROOT, 'packages/domain/src/primitives.ts'));

const {
  ARCHITECTURE_ROLES,
  isArchitectureRole,
  AVAILABILITY_CLASSES,
  isAvailabilityClass,
  RUNTIME_STATES,
  isRuntimeState,
  PREREQUISITES,
  isPrerequisite,
  isValidContinuityLease,
  assertArchitectureRoleProfile,
  isArchitectureRoleProfile,
  assertRuntimeAvailability,
  defineArchitectureRoleProfile,
  architectureRoleProfileDigest,
  unmetPrerequisites,
  evaluateExecutionGate,
  isReviewDue,
} = cp;

const { uuidV7, makeReason, PLATFORM_SCOPE } = prim;

// --- Deterministic fixtures ------------------------------------------------------------------
const T0 = 1_700_000_000_000;
const idA = uuidV7(T0, () => new Uint8Array(16).fill(0x11));
const idDep = uuidV7(T0 + 1, () => new Uint8Array(16).fill(0x22));
const leaseId = uuidV7(T0 + 2, () => new Uint8Array(16).fill(0x33));
const opId = uuidV7(T0 + 3, () => new Uint8Array(16).fill(0x44));

const owner = { ownerId: 'sre-platform', kind: 'team' };

const contract = {
  tests: ['VO-713cc2a06e03c63484b4'],
  monitoring: ['component.health', 'component.connectivity'],
  failureBehavior: 'fail-closed',
  exceptions: [],
  evidenceExpectations: ['component-profile-digest'],
};

const approval = {
  approvedBy: owner,
  reason: makeReason('owner_approved', 'controller role approved for control-plane'),
  effectiveFrom: T0,
  reviewDate: T0 + 90 * 86_400_000, // +90 days
};

// A component that MAY execute consequential actions ⇒ must require all 5 prerequisites.
function makeExecProfile(overrides = {}) {
  return defineArchitectureRoleProfile({
    id: idA,
    tenantId: PLATFORM_SCOPE,
    version: 1,
    owner,
    lifecycleState: 'active',
    contract,
    role: 'controller',
    dependencies: [{ componentId: idDep, role: 'policy-engine', required: true }],
    authority: {
      mayExecute: true,
      consequentialActions: ['reconcile', 'rollback'],
      crossTenant: false,
    },
    activation: { requires: [...PREREQUISITES], manualApprovalRequired: true },
    approval,
    ...overrides,
  });
}

const allSat = {
  authority: true,
  policy: true,
  evidence: true,
  ownership: true,
  reconciliation: true,
};

function availability(overrides = {}) {
  return {
    availabilityClass: 'core',
    state: 'available',
    prerequisites: { ...allSat },
    healthy: true,
    connected: true,
    lastObservedAt: T0,
    ...overrides,
  };
}

function validLease(overrides = {}) {
  return {
    leaseId,
    policyVersion: 1,
    operationId: opId,
    startedBeforeFailure: true,
    expiresAt: T0 + 10 * 60_000, // within 15-min NFR-012 ceiling
    stepLocallyVerifiable: true,
    evidenceBuffered: true,
    ...overrides,
  };
}

// =============================================================================================
// A. Closed vocabularies — availability class and architecture role are DISTINCT sets
// =============================================================================================
test('A1 architecture roles and availability classes are separate closed vocabularies', () => {
  assert.ok(ARCHITECTURE_ROLES.includes('controller'));
  assert.ok(AVAILABILITY_CLASSES.includes('core'));
  assert.ok(AVAILABILITY_CLASSES.includes('optional'));
  assert.ok(AVAILABILITY_CLASSES.includes('on-demand'));
  // They are DIFFERENT vocabularies (the phase requires SEPARATE roles vs availability classes).
  for (const c of AVAILABILITY_CLASSES) assert.ok(!ARCHITECTURE_ROLES.includes(c));
  // Guards are total + reject junk (negative control).
  assert.ok(isArchitectureRole('controller') && !isArchitectureRole('core'));
  assert.ok(isAvailabilityClass('on-demand') && !isAvailabilityClass('controller'));
  assert.ok(isRuntimeState('paused') && !isRuntimeState('nope'));
  assert.ok(isPrerequisite('reconciliation') && !isPrerequisite('health'));
  assert.deepEqual(
    [...PREREQUISITES],
    ['authority', 'policy', 'evidence', 'ownership', 'reconciliation'],
  );
  assert.deepEqual([...RUNTIME_STATES].sort(), [
    'activating',
    'available',
    'degraded',
    'inactive',
    'paused',
    'unavailable',
  ]);
});

// =============================================================================================
// B. Owner-approved architecture role — complete governed fact with a MANDATORY review date
// =============================================================================================
test('B1 a well-formed architecture role profile validates (positive control)', () => {
  const p = makeExecProfile();
  assert.doesNotThrow(() => assertArchitectureRoleProfile(p));
  assert.ok(isArchitectureRoleProfile(p));
  assert.equal(p.role, 'controller');
  assert.equal(p.approval.reviewDate, T0 + 90 * 86_400_000);
});

test('B2 owner approval requires a named approver, structured reason, and mandatory review date', () => {
  // No approver (negative control).
  assert.throws(() =>
    makeExecProfile({ approval: { ...approval, approvedBy: { ownerId: '', kind: 'team' } } }),
  );
  // Empty reason (negative control).
  assert.throws(() =>
    makeExecProfile({ approval: { ...approval, reason: { code: '', text: '' } } }),
  );
  // Review date not after effective date (negative control) — a review date is MANDATORY and must be future.
  assert.throws(() =>
    makeExecProfile({ approval: { ...approval, reviewDate: approval.effectiveFrom } }),
  );
  assert.throws(() => makeExecProfile({ approval: { ...approval, reviewDate: undefined } }));
});

test('B3 an executing component must require ALL five prerequisites as activation conditions', () => {
  // Positive: full set already validated in B1. Negative: drop one prerequisite.
  for (const drop of PREREQUISITES) {
    const requires = PREREQUISITES.filter((r) => r !== drop);
    assert.throws(
      () => makeExecProfile({ activation: { requires, manualApprovalRequired: true } }),
      new RegExp(drop),
      `dropping "${drop}" from an executing component's activation must be rejected`,
    );
  }
});

test('B4 a read-only component may not enumerate consequential actions', () => {
  // Positive: read-only with no actions and no mandatory prerequisites is valid.
  assert.doesNotThrow(() =>
    makeExecProfile({
      authority: { mayExecute: false, consequentialActions: [], crossTenant: false },
      activation: { requires: [], manualApprovalRequired: false },
    }),
  );
  // Negative: mayExecute:false but claims a consequential action.
  assert.throws(() =>
    makeExecProfile({
      authority: { mayExecute: false, consequentialActions: ['rollback'], crossTenant: false },
      activation: { requires: [], manualApprovalRequired: false },
    }),
  );
});

test('B5 review-due is computed from the review date (durable governance gap, not silent staleness)', () => {
  const p = makeExecProfile();
  assert.equal(isReviewDue(p, p.approval.reviewDate - 1), false); // before ⇒ not due
  assert.equal(isReviewDue(p, p.approval.reviewDate), true); // on ⇒ due
  assert.equal(isReviewDue(p, p.approval.reviewDate + 1), true); // after ⇒ due
});

// =============================================================================================
// C. Runtime availability is a SEPARATE, independently-validated fact
// =============================================================================================
test('C1 runtime availability validates independently of the architecture role', () => {
  assert.doesNotThrow(() => assertRuntimeAvailability(availability()));
  // Negative controls.
  assert.throws(() => assertRuntimeAvailability(availability({ availabilityClass: 'controller' })));
  assert.throws(() => assertRuntimeAvailability(availability({ state: 'nope' })));
  assert.throws(() =>
    assertRuntimeAvailability(availability({ prerequisites: { authority: 'yes' } })),
  );
  assert.throws(() => assertRuntimeAvailability(availability({ prerequisites: { health: true } })));
  assert.throws(() => assertRuntimeAvailability(availability({ healthy: 'true' })));
});

test('C2 continuity lease structural validity enforces FR-047 (pre-failure operation)', () => {
  assert.ok(isValidContinuityLease(validLease()));
  // Negative: not started before the failure ⇒ not a valid continuity lease.
  assert.ok(!isValidContinuityLease(validLease({ startedBeforeFailure: false })));
  assert.ok(!isValidContinuityLease({}));
  assert.ok(!isValidContinuityLease(validLease({ policyVersion: 0 })));
});

// =============================================================================================
// D. NFR-010 sentence 1 — prerequisite loss blocks BOTH new and in-progress, immediately
// =============================================================================================
test('D1 losing ANY prerequisite blocks new execution immediately', () => {
  const p = makeExecProfile();
  for (const req of PREREQUISITES) {
    const av = availability({ prerequisites: { ...allSat, [req]: false } });
    assert.deepEqual(unmetPrerequisites(p, av), [req]);
    const r = evaluateExecutionGate({ profile: p, availability: av, execution: 'new', now: T0 });
    assert.equal(r.allowed, false);
    assert.ok(r.blocked.includes('prerequisite-lost'));
    assert.equal(r.continuity, false);
    assert.equal(r.readOnlyVisibility, true);
    assert.equal(r.escalation, true);
  }
});

test('D2 continuity mode CANNOT rescue a lost prerequisite for an in-progress operation', () => {
  const p = makeExecProfile();
  // Health is fine, a perfectly valid lease is present, but a prerequisite is lost.
  const av = availability({
    prerequisites: { ...allSat, evidence: false },
    continuityLease: validLease(),
  });
  const r = evaluateExecutionGate({
    profile: p,
    availability: av,
    execution: 'in-progress',
    now: T0,
  });
  assert.equal(r.allowed, false, 'a lost prerequisite blocks even a valid-lease in-progress step');
  assert.ok(r.blocked.includes('prerequisite-lost'));
  assert.equal(r.continuity, false);
});

test('D3 positive control — with all prerequisites satisfied, execution is permitted', () => {
  const p = makeExecProfile();
  const r = evaluateExecutionGate({
    profile: p,
    availability: availability(),
    execution: 'new',
    now: T0,
  });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.blocked, []);
  assert.equal(r.safeAction, 'proceed');
});

// =============================================================================================
// E. NFR-010 sentence 2 — health/connectivity loss
// =============================================================================================
test('E1 health or connectivity loss blocks NEW execution immediately', () => {
  const p = makeExecProfile();
  for (const av of [
    availability({ healthy: false, state: 'unavailable' }),
    availability({ connected: false, state: 'unavailable' }),
  ]) {
    const r = evaluateExecutionGate({ profile: p, availability: av, execution: 'new', now: T0 });
    assert.equal(r.allowed, false);
    assert.ok(r.blocked.includes('health-or-connectivity-lost'));
    assert.equal(r.safeAction, 'block');
    assert.equal(r.readOnlyVisibility, true);
    assert.equal(r.escalation, true);
  }
});

test('E2 in-progress WITH a valid unexpired lease + verifiable step continues under continuity', () => {
  const p = makeExecProfile();
  const av = availability({ healthy: false, state: 'degraded', continuityLease: validLease() });
  const r = evaluateExecutionGate({
    profile: p,
    availability: av,
    execution: 'in-progress',
    now: T0,
  });
  assert.equal(r.allowed, true, 'FR-046–FR-050 continuity permits the in-progress step');
  assert.equal(r.continuity, true);
  assert.equal(r.safeAction, 'continue-under-continuity');
  assert.equal(r.readOnlyVisibility, true);
  assert.equal(r.escalation, true);
});

test('E3 in-progress WITHOUT a valid lease pauses and requires reconciliation (negative control)', () => {
  const p = makeExecProfile();
  const av = availability({ healthy: false, state: 'unavailable' }); // no lease
  const r = evaluateExecutionGate({
    profile: p,
    availability: av,
    execution: 'in-progress',
    now: T0,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.continuity, false);
  assert.ok(r.blocked.includes('continuity-lease-invalid'));
  assert.equal(r.safeAction, 'pause-and-reconcile');
});

test('E4 an EXPIRED lease pauses (FR-050/NFR-012) — no automatic extension', () => {
  const p = makeExecProfile();
  const lease = validLease({ expiresAt: T0 }); // expires exactly at now
  const av = availability({ healthy: false, state: 'degraded', continuityLease: lease });
  const r = evaluateExecutionGate({
    profile: p,
    availability: av,
    execution: 'in-progress',
    now: T0,
  });
  assert.equal(r.allowed, false);
  assert.ok(r.blocked.includes('continuity-lease-expired'));
  assert.equal(r.safeAction, 'pause-and-reconcile');
  // Just before expiry, the same lease is still valid ⇒ proves the boundary is real.
  const before = evaluateExecutionGate({
    profile: p,
    availability: av,
    execution: 'in-progress',
    now: T0 - 1,
  });
  assert.equal(before.allowed, true);
  assert.equal(before.continuity, true);
});

test('E5 a step that is NOT locally verifiable pauses (FR-048)', () => {
  const p = makeExecProfile();
  const av = availability({
    healthy: false,
    state: 'degraded',
    continuityLease: validLease({ stepLocallyVerifiable: false }),
  });
  const r = evaluateExecutionGate({
    profile: p,
    availability: av,
    execution: 'in-progress',
    now: T0,
  });
  assert.equal(r.allowed, false);
  assert.ok(r.blocked.includes('step-not-locally-verifiable'));
  assert.equal(r.safeAction, 'pause-and-reconcile');
});

test('E6 a NEW operation never enters continuity even with a valid lease present', () => {
  const p = makeExecProfile();
  const av = availability({ healthy: false, state: 'degraded', continuityLease: validLease() });
  const r = evaluateExecutionGate({ profile: p, availability: av, execution: 'new', now: T0 });
  assert.equal(
    r.allowed,
    false,
    'FR-047: continuity applies ONLY to pre-failure in-progress operations',
  );
  assert.equal(r.continuity, false);
  assert.ok(r.blocked.includes('health-or-connectivity-lost'));
});

// =============================================================================================
// F. NFR-010 invariant — read-only visibility and escalation ALWAYS remain
// =============================================================================================
test('F1 read-only visibility and escalation are available in EVERY gate outcome', () => {
  const p = makeExecProfile();
  const cases = [
    availability(), // permitted
    availability({ prerequisites: { ...allSat, policy: false } }), // prereq lost
    availability({ healthy: false, state: 'unavailable' }), // health lost, no lease
    availability({ healthy: false, state: 'degraded', continuityLease: validLease() }), // continuity
    availability({ state: 'inactive' }), // not activated
  ];
  for (const execution of ['new', 'in-progress']) {
    for (const av of cases) {
      const r = evaluateExecutionGate({ profile: p, availability: av, execution, now: T0 });
      assert.equal(r.readOnlyVisibility, true);
      assert.equal(r.escalation, true);
    }
  }
});

test('F2 healthy+connected but not-activated blocks NEW execution (activation condition)', () => {
  const p = makeExecProfile();
  const r = evaluateExecutionGate({
    profile: p,
    availability: availability({ state: 'inactive' }),
    execution: 'new',
    now: T0,
  });
  assert.equal(r.allowed, false);
  assert.ok(r.blocked.includes('not-activated'));
});

// =============================================================================================
// G. Durable-effect witness — digest is re-derivable and change-sensitive
// =============================================================================================
test('G1 architecture-role digest is stable, re-derivable, and changes iff a governed facet changes', () => {
  const p = makeExecProfile();
  const d1 = architectureRoleProfileDigest(p);
  // Re-derivable from an independent reconstruction of the same profile.
  const d2 = architectureRoleProfileDigest(makeExecProfile());
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
  // Changing the role changes the digest.
  assert.notEqual(d1, architectureRoleProfileDigest(makeExecProfile({ role: 'worker' })));
  // Changing the review date changes the digest (a governed approval facet).
  assert.notEqual(
    d1,
    architectureRoleProfileDigest(
      makeExecProfile({ approval: { ...approval, reviewDate: approval.reviewDate + 1 } }),
    ),
  );
  // Changing authority changes the digest.
  assert.notEqual(
    d1,
    architectureRoleProfileDigest(
      makeExecProfile({
        authority: { mayExecute: true, consequentialActions: ['reconcile'], crossTenant: true },
      }),
    ),
  );
});
