// Verification-obligation test for VO-173f7afb7801f4ab3e29 (T040 / GAR-003), the
// workload (service→service) leg of the Separation-of-Duties contract.
//
// Oracle: Request, review, approval, execution, evidence administration, control ownership,
// and assurance MUST be separated where conflicts exist; platform administration alone MUST
// NOT grant decision authority, and the independent central reviewer for a cross-tenant
// action MUST NOT hold an incompatible action role.
//
// Why a workload-identity test proves this oracle: separation of duties is only meaningful
// over AUTHENTIC principals, and a workload (adapter/projector/command-worker/policy-evaluator
// /api) is a MACHINE principal. packages/authz/src/workload-identity.ts is the service→service
// authentication + authorization gate (plan.md §Security boundaries "Service → service:
// distinct workload identity, mTLS, exact capability allowlist"). If a workload identity could
// be forged, if a workload could quietly acquire a capability it was never granted, or if a
// workload could be treated as carrying human DECISION authority (approval/review/assurance/
// control-ownership) or act as the independent central reviewer, then "platform administration
// alone grants no decision authority" and "the central reviewer holds no incompatible role"
// both collapse — automation would launder itself into a decision. These tests exercise the
// REAL workload-identity.ts TOGETHER with the REAL separation-of-duties.ts (evaluateSeparation
// OfDuties / checkRoles PLATFORM_ADMIN_NO_AUTHORITY / evaluateCentralReviewerDistinctness),
// using only Node built-ins (loaded via --experimental-strip-types), so they run
// deterministically under `npm ci`. Each test pairs a positive control (clean case admitted)
// with a negative control (the specific defect rejected), so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wl = await import(join(ROOT, 'packages/authz/src/workload-identity.ts'));
const sod = await import(join(ROOT, 'packages/authz/src/separation-of-duties.ts'));

const {
  parseWorkloadIdentity,
  sameWorkload,
  isHumanSubject,
  constantTimeEqual,
  verifyWorkloadBinding,
  validateCapabilityGrant,
  authorizeCapability,
  workloadToDutyAssignment,
  assertNotWorkloadReviewer,
  admitWorkloadRequest,
  DECISION_CAPABILITIES,
  WORKLOAD_ALLOWED_DUTIES,
  ALL_SERVICE_CLASSES,
} = wl;

const { evaluateSeparationOfDuties, evaluateCentralReviewerDistinctness } = sod;

// --- fixtures --------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed injected clock (epoch ms)

const ADAPTER_SPIFFE = 'spiffe://trust.trustcircle/ns/tenant-a/svc/adapter/kanban/src/src-123';
const CENTRAL_WORKER_SPIFFE = 'spiffe://trust.trustcircle/ns/central/svc/command_worker/outbox';

/** A verified mTLS peer credential for the tenant-scoped adapter, valid at NOW. */
function adapterCredential(overrides = {}) {
  return {
    mode: 'mtls',
    chainVerified: true,
    presentedSpiffeId: ADAPTER_SPIFFE,
    notBeforeMs: NOW - 60_000,
    notAfterMs: NOW + 60_000,
    trustDomain: 'trust.trustcircle',
    ...overrides,
  };
}

const adapterScope = { tenantId: 'tenant-a', sourceId: 'src-123' };

/** An exact capability allowlist for the adapter (no decision capabilities). */
const adapterGrant = {
  spiffeId: ADAPTER_SPIFFE,
  serviceClass: 'adapter',
  capabilities: ['source.read', 'evidence.write'],
};

function verifiedAdapter() {
  const b = verifyWorkloadBinding(adapterCredential(), adapterScope, NOW);
  assert.equal(b.ok, true, 'fixture adapter must bind cleanly');
  return b.workload;
}

// ===========================================================================
// (1) Distinct workload identities.
// ===========================================================================

test('distinct identities — parses a well-formed SPIFFE workload id and rejects malformed / human-looking ids', () => {
  // positive
  const id = parseWorkloadIdentity(ADAPTER_SPIFFE);
  assert.ok(id, 'well-formed workload id parses');
  assert.equal(id.serviceClass, 'adapter');
  assert.equal(id.serviceName, 'kanban');
  assert.equal(id.tenantId, 'tenant-a');
  assert.equal(id.sourceId, 'src-123');

  // negatives — each a distinct malformation, all fail closed to null.
  assert.equal(
    parseWorkloadIdentity('auth0|human-subject-42'),
    null,
    'human OIDC subject is not a workload id',
  );
  assert.equal(
    parseWorkloadIdentity('spiffe://trust/ns/tenant-a/svc/unknownclass/x'),
    null,
    'unknown service class rejected',
  );
  assert.equal(
    parseWorkloadIdentity('spiffe://trust/ns/tenant-a/svc/adapter'),
    null,
    'missing service name rejected',
  );
  assert.equal(
    parseWorkloadIdentity('https://trust/ns/tenant-a/svc/adapter/x'),
    null,
    'wrong scheme rejected',
  );
  assert.equal(parseWorkloadIdentity(''), null, 'empty rejected');
  assert.equal(parseWorkloadIdentity(42), null, 'non-string rejected');

  // Human vs workload subject distinction is total.
  assert.equal(isHumanSubject('auth0|human'), true);
  assert.equal(
    isHumanSubject(ADAPTER_SPIFFE),
    false,
    'a workload spiffe id is NOT a human subject',
  );
});

test('distinct identities — distinctness is exact; different tenant/source/name are different workloads', () => {
  const a = parseWorkloadIdentity(ADAPTER_SPIFFE);
  const aAgain = parseWorkloadIdentity(ADAPTER_SPIFFE);
  assert.equal(sameWorkload(a, aAgain), true, 'same spiffe id ⇒ same workload'); // positive

  // negative: a different-tenant adapter of the same service name is a DISTINCT workload.
  const otherTenant = parseWorkloadIdentity(
    'spiffe://trust.trustcircle/ns/tenant-b/svc/adapter/kanban/src/src-123',
  );
  assert.equal(sameWorkload(a, otherTenant), false, 'different tenant ⇒ distinct workload');

  // constant-time equality underpins identity compares.
  assert.equal(constantTimeEqual('x', 'x'), true);
  assert.equal(constantTimeEqual('x', 'y'), false);
  assert.equal(constantTimeEqual('x', 'xx'), false, 'length mismatch ⇒ not equal');
  assert.equal(constantTimeEqual(undefined, 'x'), false, 'non-string fails closed');
});

// ===========================================================================
// (2) mTLS binding.
// ===========================================================================

test('mTLS binding — a verified peer credential binds to its claimed identity within scope', () => {
  const b = verifyWorkloadBinding(adapterCredential(), adapterScope, NOW); // positive
  assert.equal(b.ok, true);
  assert.equal(b.workload.identity.spiffeId, ADAPTER_SPIFFE);
  assert.equal(b.workload.principalId, ADAPTER_SPIFFE, 'principal id is the distinct workload id');
  assert.equal(b.workload.mode, 'mtls');
});

test('mTLS binding — an UNVERIFIED chain is refused (fails closed)', () => {
  const good = verifyWorkloadBinding(adapterCredential(), adapterScope, NOW);
  assert.equal(good.ok, true); // positive control

  const bad = verifyWorkloadBinding(adapterCredential({ chainVerified: false }), adapterScope, NOW);
  assert.equal(bad.ok, false, 'unverified chain must be refused');
  assert.ok(bad.rejections.some((r) => r.code === 'CHAIN_UNVERIFIED'));
});

test('mTLS binding — expired / not-yet-valid credentials are refused (clock-injected)', () => {
  // positive: valid window
  assert.equal(verifyWorkloadBinding(adapterCredential(), adapterScope, NOW).ok, true);

  // negatives
  const expired = verifyWorkloadBinding(
    adapterCredential({ notAfterMs: NOW - 1 }),
    adapterScope,
    NOW,
  );
  assert.equal(expired.ok, false);
  assert.ok(expired.rejections.some((r) => r.code === 'CREDENTIAL_EXPIRED'));

  const future = verifyWorkloadBinding(
    adapterCredential({ notBeforeMs: NOW + 1 }),
    adapterScope,
    NOW,
  );
  assert.equal(future.ok, false);
  assert.ok(future.rejections.some((r) => r.code === 'CREDENTIAL_NOT_YET_VALID'));
});

test('mTLS binding — identity/scope mismatch is refused (cannot cross tenant or source, cannot forge trust domain)', () => {
  // positive control already covered; here every mismatch fails closed.

  // Presented identity is for tenant-a but the request is scoped to tenant-b.
  const crossTenant = verifyWorkloadBinding(
    adapterCredential(),
    { tenantId: 'tenant-b', sourceId: 'src-123' },
    NOW,
  );
  assert.equal(crossTenant.ok, false);
  assert.ok(crossTenant.rejections.some((r) => r.code === 'TENANT_SCOPE_MISMATCH'));

  // Source adapter bound to src-123 cannot act on src-999.
  const crossSource = verifyWorkloadBinding(
    adapterCredential(),
    { tenantId: 'tenant-a', sourceId: 'src-999' },
    NOW,
  );
  assert.equal(crossSource.ok, false);
  assert.ok(crossSource.rejections.some((r) => r.code === 'SOURCE_SCOPE_MISMATCH'));

  // Trust domain in the credential must match the identity's trust domain.
  const wrongTD = verifyWorkloadBinding(
    adapterCredential({ trustDomain: 'evil.example' }),
    adapterScope,
    NOW,
  );
  assert.equal(wrongTD.ok, false);
  assert.ok(wrongTD.rejections.some((r) => r.code === 'TRUST_DOMAIN_MISMATCH'));

  // A malformed presented SAN cannot bind at all.
  const malformed = verifyWorkloadBinding(
    adapterCredential({ presentedSpiffeId: 'auth0|not-a-workload' }),
    adapterScope,
    NOW,
  );
  assert.equal(malformed.ok, false);
  assert.ok(malformed.rejections.some((r) => r.code === 'MALFORMED_IDENTITY'));
});

// ===========================================================================
// (3) Exact service capabilities.
// ===========================================================================

test('exact capabilities — a granted capability is authorized; an un-granted one is refused', () => {
  const w = verifiedAdapter();

  const ok = authorizeCapability(w, adapterGrant, 'source.read'); // positive
  assert.equal(ok.permitted, true);

  const missing = authorizeCapability(w, adapterGrant, 'outbox.publish'); // negative
  assert.equal(missing.permitted, false);
  assert.ok(missing.rejections.some((r) => r.code === 'CAPABILITY_NOT_GRANTED'));
});

test('exact capabilities — matching is EXACT: no prefix / wildcard / substring escalation', () => {
  const w = verifiedAdapter();
  // positive: exact token
  assert.equal(authorizeCapability(w, adapterGrant, 'source.read').permitted, true);

  // negatives: near-miss tokens must NOT be authorized by a prefix/substring of a granted one.
  for (const near of ['source.read.all', 'source', 'source.read ', 'ource.read', 'source.readx']) {
    const d = authorizeCapability(w, adapterGrant, near);
    assert.equal(d.permitted, false, `'${near}' must not be authorized by exact allowlist`);
    assert.ok(
      d.rejections.some(
        (r) => r.code === 'CAPABILITY_NOT_GRANTED' || r.code === 'EMPTY_CAPABILITY',
      ),
    );
  }
});

test('exact capabilities — a grant for a different workload cannot authorize this workload', () => {
  const w = verifiedAdapter();
  const foreignGrant = { ...adapterGrant, spiffeId: CENTRAL_WORKER_SPIFFE };
  // positive: correct grant works
  assert.equal(authorizeCapability(w, adapterGrant, 'source.read').permitted, true);
  // negative: foreign grant refused
  const d = authorizeCapability(w, foreignGrant, 'source.read');
  assert.equal(d.permitted, false);
  assert.ok(d.rejections.some((r) => r.code === 'GRANT_IDENTITY_MISMATCH'));
});

// ===========================================================================
// (4) SoD binding — platform administration / automation alone grants NO decision authority.
// This is the CORE of the oracle for a workload principal.
// ===========================================================================

test('SoD — a workload may fill only NON-DECISION duties; decision duties are refused', () => {
  const w = verifiedAdapter();

  // positive: execution / request / evidence_administration are allowed.
  for (const duty of ['request', 'execution', 'evidence_administration']) {
    assert.ok(WORKLOAD_ALLOWED_DUTIES.has(duty));
    const r = workloadToDutyAssignment(w, duty);
    assert.equal(r.ok, true, `${duty} must be allowed`);
    assert.equal(r.assignment.roles.length, 1);
    assert.equal(
      r.assignment.roles[0],
      'automation_principal',
      'workload role is always the non-decision automation principal',
    );
  }

  // negative: EVERY decision / ownership duty is refused.
  for (const duty of ['approval', 'review', 'assurance', 'control_ownership']) {
    const r = workloadToDutyAssignment(w, duty);
    assert.equal(r.ok, false, `${duty} must be refused for a workload`);
    assert.ok(r.rejections.some((x) => x.code === 'DECISION_DUTY_FORBIDDEN'));
  }
});

test('SoD — the workload duty assignment flows through the REAL SoD guard as PLATFORM_ADMIN_NO_AUTHORITY when forced into a decision duty', () => {
  const w = verifiedAdapter();
  const constraint = {
    sodConstraintId: 'sod-wl',
    tenantId: 'tenant-a',
    actionClass: 'consequential-change',
    incompatibleRoles: [],
    incompatibleRelationships: [],
    minimumDistinctPrincipals: 1,
    status: 'active',
  };

  // Bridge the SANCTIONED way: execution duty is admitted and the REAL SoD guard permits it
  // (positive control) — an automation_principal executing is fine.
  const exec = workloadToDutyAssignment(w, 'execution');
  assert.equal(exec.ok, true);
  const okEval = evaluateSeparationOfDuties([exec.assignment], constraint);
  assert.equal(okEval.permitted, true, 'automation executing within scope is permitted');

  // Now CONSTRUCT (bypassing the bridge, as an attacker would try) a duty assignment where the
  // automation principal fills a DECISION duty, and prove the REAL SoD guard rejects it with
  // PLATFORM_ADMIN_NO_AUTHORITY — automation/platform admin alone grants no decision authority.
  const forgedDecision = {
    principalId: w.principalId,
    duty: 'approval',
    roles: ['automation_principal'],
    relationships: ['approver'],
    tenantId: 'tenant-a',
  };
  const badEval = evaluateSeparationOfDuties([forgedDecision], constraint);
  assert.equal(badEval.permitted, false, 'automation cannot fill an approval duty');
  assert.ok(
    badEval.violations.some((v) => v.code === 'PLATFORM_ADMIN_NO_AUTHORITY'),
    'REAL SoD guard flags automation-only decision authority',
  );
});

test('SoD — a workload can NEVER be the independent central reviewer for a cross-tenant action', () => {
  // positive control: a human reviewer with the reviewer role, distinct from every action role,
  // is accepted by the REAL SoD central-reviewer guard.
  const action = {
    requesterPrincipalId: 'auth0|req',
    operatorPrincipalId: 'auth0|op',
    controlOwnerPrincipalId: 'auth0|owner',
    tenantApproverPrincipalIds: ['auth0|ta', 'auth0|tb'],
  };
  const humanReviewer = { principalId: 'auth0|central', roles: ['central_governance_reviewer'] };
  assert.equal(
    evaluateCentralReviewerDistinctness(action, humanReviewer).permitted,
    true,
    'distinct human reviewer accepted',
  );
  // The workload-identity guard agrees the human is not a workload.
  assert.equal(assertNotWorkloadReviewer('auth0|central').permitted, true);

  // negative: a WORKLOAD principal proposed as the central reviewer is refused.
  const wlReview = assertNotWorkloadReviewer(CENTRAL_WORKER_SPIFFE);
  assert.equal(wlReview.permitted, false, 'a workload cannot be the central reviewer');
  assert.ok(
    wlReview.violations.some((v) => v.code === 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE'),
    'flagged as incompatible',
  );
  // And even if the REAL guard were handed a workload with the reviewer role, our up-front
  // machine-reviewer refusal blocks it before role checks matter.
  assert.equal(
    assertNotWorkloadReviewer(undefined).permitted,
    false,
    'missing reviewer fails closed',
  );
});

// ===========================================================================
// Capability-grant admission: a decision capability can never even be granted to a workload.
// ===========================================================================

test('grant admission — a grant that hands a workload a DECISION capability is rejected', () => {
  // positive: a non-decision grant validates.
  assert.equal(validateCapabilityGrant(adapterGrant).permitted, true);

  // negative: a grant listing any decision capability is refused (defense at admission time).
  for (const cap of DECISION_CAPABILITIES) {
    const g = {
      spiffeId: ADAPTER_SPIFFE,
      serviceClass: 'adapter',
      capabilities: ['source.read', cap],
    };
    const d = validateCapabilityGrant(g);
    assert.equal(d.permitted, false, `granting '${cap}' to a workload must be refused`);
    assert.ok(d.rejections.some((r) => r.code === 'DECISION_CAPABILITY_FORBIDDEN'));
  }

  // Even a direct authorize request for a decision capability is refused regardless of allowlist.
  const w = verifiedAdapter();
  const d = authorizeCapability(
    w,
    { ...adapterGrant, capabilities: ['decision.approve'] },
    'decision.approve',
  );
  assert.equal(d.permitted, false);
  assert.ok(d.rejections.some((r) => r.code === 'DECISION_CAPABILITY_FORBIDDEN'));
});

// ===========================================================================
// End-to-end admission — one fail-closed entry point across all three legs + SoD.
// ===========================================================================

test('admission — end-to-end: clean workload request is admitted with a NON-DECISION SoD duty', () => {
  const req = {
    credential: adapterCredential(),
    scope: adapterScope,
    grant: adapterGrant,
    requestedCapability: 'evidence.write',
    duty: 'evidence_administration',
  };
  const res = admitWorkloadRequest(req, NOW); // positive
  assert.equal(res.ok, true);
  assert.equal(res.workload.identity.spiffeId, ADAPTER_SPIFFE);
  assert.equal(res.assignment.duty, 'evidence_administration');
  assert.equal(res.assignment.roles[0], 'automation_principal');
});

test('admission — end-to-end fails closed at the FIRST failing stage (binding, capability, or duty)', () => {
  // binding stage: unverified chain
  const b = admitWorkloadRequest(
    {
      credential: adapterCredential({ chainVerified: false }),
      scope: adapterScope,
      grant: adapterGrant,
      requestedCapability: 'source.read',
      duty: 'execution',
    },
    NOW,
  );
  assert.equal(b.ok, false);
  assert.equal(b.stage, 'binding');

  // capability stage: valid binding but un-granted capability
  const c = admitWorkloadRequest(
    {
      credential: adapterCredential(),
      scope: adapterScope,
      grant: adapterGrant,
      requestedCapability: 'outbox.publish',
      duty: 'execution',
    },
    NOW,
  );
  assert.equal(c.ok, false);
  assert.equal(c.stage, 'capability');

  // duty stage: valid binding + granted capability but a forbidden DECISION duty
  const d = admitWorkloadRequest(
    {
      credential: adapterCredential(),
      scope: adapterScope,
      grant: adapterGrant,
      requestedCapability: 'source.read',
      duty: 'approval',
    },
    NOW,
  );
  assert.equal(d.ok, false);
  assert.equal(d.stage, 'duty');
});

test('sanity — service-class vocabulary and allowed-duty set are the expected non-decision surface', () => {
  assert.deepEqual([...ALL_SERVICE_CLASSES].sort(), [
    'adapter',
    'api',
    'command_worker',
    'policy_evaluator',
    'projector',
  ]);
  assert.deepEqual([...WORKLOAD_ALLOWED_DUTIES].sort(), [
    'evidence_administration',
    'execution',
    'request',
  ]);
  // No decision duty leaks into the allowed set.
  for (const d of ['approval', 'review', 'assurance', 'control_ownership']) {
    assert.equal(WORKLOAD_ALLOWED_DUTIES.has(d), false);
  }
});
