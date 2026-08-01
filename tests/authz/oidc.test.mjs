// Verification-obligation test for VO-173f7afb7801f4ab3e29 (T044 / GAR-003), the OIDC
// human-session leg of the Separation-of-Duties contract.
//
// Oracle: Request, review, approval, execution, evidence administration, control ownership,
// and assurance MUST be separated where conflicts exist; platform administration alone MUST
// NOT grant decision authority, and the independent central reviewer for a cross-tenant
// action MUST NOT hold an incompatible action role.
//
// Why an OIDC test proves this oracle: separation of duties is only meaningful over an
// AUTHENTIC principal identity. packages/authz/src/oidc.ts is the authentication gate that
// establishes the trustworthy VerifiedHumanSession (verified issuer/audience/subject/expiry/
// assurance) that the SoD guards in separation-of-duties.ts consume. If issuer/audience/
// subject/expiry could be forged or replayed, "two distinct principals", "platform admin
// alone grants no decision authority", and "the central reviewer is distinct and holds no
// incompatible role" all collapse. These tests exercise the REAL oidc.ts + the REAL
// separation-of-duties.ts together, using only Node built-ins (loaded via
// --experimental-strip-types), so they run deterministically under `npm ci`. Each test pairs
// a positive control (clean case admitted) with a negative control (the specific defect
// rejected), so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const oidc = await import(join(ROOT, 'packages/authz/src/oidc.ts'));
const sod = await import(join(ROOT, 'packages/authz/src/separation-of-duties.ts'));

const {
  validateHumanSession,
  sessionToDutyAssignment,
  assertDecisionAuthority,
  assertCrossTenantReviewerSession,
  assuranceFromClaims,
  assuranceMeets,
  requiredAssuranceForDuty,
  hasDecisionRole,
  CROSS_TENANT_REVIEWER_ASSURANCE,
} = oidc;
const { evaluateSeparationOfDuties, evaluateCentralReviewerDistinctness } = sod;

// --- fixtures --------------------------------------------------------------

const NOW = 1_700_000_000; // fixed epoch-seconds "now" (injected — no hidden clock)

const POLICY = {
  trustedIssuers: ['https://idp.trustcircle.example/'],
  audience: ['trustcircle-governance-rp'],
  clockSkewSeconds: 30,
  maxSessionAgeSeconds: 3600,
  requireNonce: true,
  assignableRoles: [
    'authorized_approver',
    'central_governance_reviewer',
    'operator',
    'control_owner',
    'governance_officer',
    'platform_admin',
    'auditor',
    'automation_principal',
  ],
};

/** A well-formed, MFA (aal2), unexpired, correctly-scoped human session for `sub`. */
function goodClaims(overrides = {}) {
  return {
    __signatureVerified: true,
    iss: 'https://idp.trustcircle.example/',
    aud: 'trustcircle-governance-rp',
    sub: 'user-alice',
    exp: NOW + 600,
    iat: NOW - 60,
    nbf: NOW - 60,
    auth_time: NOW - 120,
    acr: 'aal2',
    amr: ['pwd', 'otp'],
    nonce: 'n-abc123',
    tid: 'tenant-a',
    roles: ['authorized_approver'],
    ...overrides,
  };
}

function ok(claims, min) {
  const v = validateHumanSession(claims, POLICY, NOW, min);
  assert.equal(v.ok, true, 'expected session to validate: ' + JSON.stringify(v.rejections ?? []));
  return v.session;
}

function rejectedWith(claims, code, min) {
  const v = validateHumanSession(claims, POLICY, NOW, min);
  assert.equal(v.ok, false, `expected rejection ${code} but session validated`);
  assert.ok(
    v.rejections.some((r) => r.code === code),
    `expected rejection code ${code}, got ${v.rejections.map((r) => r.code).join(',')}`,
  );
}

// ===========================================================================
// Clause: subject — a present, stable verified subject becomes the SoD principalId.
// Without an authentic subject, "distinct principals" is meaningless.
// ===========================================================================

test('subject: verified sub becomes principalId (positive) and missing sub is rejected (negative)', () => {
  const s = ok(goodClaims({ sub: 'user-alice' }));
  assert.equal(s.principalId, 'user-alice');
  // A DutyAssignment produced from the session carries exactly the verified subject.
  const da = sessionToDutyAssignment(s, 'approval');
  assert.equal(da.principalId, 'user-alice');

  // Negative: no subject -> no principal identity -> refused.
  rejectedWith(goodClaims({ sub: '' }), 'SUBJECT_MISSING');
  rejectedWith(goodClaims({ sub: undefined }), 'SUBJECT_MISSING');
});

test('subject authenticity underpins the SoD distinct-principal guard', () => {
  // Two DISTINCT verified subjects fill request + approval => SoD permits.
  const requester = ok(goodClaims({ sub: 'user-bob', roles: ['governance_officer'] }));
  const approver = ok(goodClaims({ sub: 'user-alice', roles: ['authorized_approver'] }));
  const constraint = {
    sodConstraintId: 'sod-oidc-1',
    tenantId: 'tenant-a',
    actionClass: 'consequential-change',
    incompatibleRoles: [],
    incompatibleRelationships: [],
    minimumDistinctPrincipals: 2,
    status: 'active',
  };
  const clean = evaluateSeparationOfDuties(
    [
      sessionToDutyAssignment(requester, 'request', ['requester']),
      sessionToDutyAssignment(approver, 'approval'),
    ],
    constraint,
  );
  assert.equal(clean.permitted, true);

  // Negative: the SAME verified subject fills both conflicting duties => SoD rejects
  // (self-approval). If the subject were forgeable, this guard could be evaded.
  const self = evaluateSeparationOfDuties(
    [
      sessionToDutyAssignment(requester, 'request', ['requester']),
      sessionToDutyAssignment(requester, 'approval'),
    ],
    constraint,
  );
  assert.equal(self.permitted, false);
  assert.ok(self.violations.some((v) => v.code === 'SELF_APPROVAL'));
});

// ===========================================================================
// Clause: issuer — only a trusted IdP may authenticate a governance principal.
// ===========================================================================

test('issuer: trusted issuer admitted (positive), untrusted / substring issuer rejected (negative)', () => {
  ok(goodClaims({ iss: 'https://idp.trustcircle.example/' }));
  rejectedWith(goodClaims({ iss: 'https://evil.example/' }), 'UNTRUSTED_ISSUER');
  // No suffix/substring trust: a look-alike issuer is rejected.
  rejectedWith(
    goodClaims({ iss: 'https://idp.trustcircle.example.attacker.test/' }),
    'UNTRUSTED_ISSUER',
  );
  rejectedWith(goodClaims({ iss: '' }), 'MALFORMED_CLAIM');
});

// ===========================================================================
// Clause: audience — the token must be minted for THIS relying party.
// ===========================================================================

test('audience: RP-scoped token admitted (positive), foreign-audience token rejected (negative)', () => {
  ok(goodClaims({ aud: 'trustcircle-governance-rp' }));
  ok(goodClaims({ aud: ['trustcircle-governance-rp', 'other'], azp: 'trustcircle-governance-rp' }));
  // Negative: token for a different RP.
  rejectedWith(goodClaims({ aud: 'some-other-app' }), 'AUDIENCE_MISMATCH');
  // Negative: multi-audience token whose azp does not identify this RP.
  rejectedWith(
    goodClaims({ aud: ['trustcircle-governance-rp', 'other'], azp: 'other' }),
    'AZP_MISMATCH',
  );
  rejectedWith(goodClaims({ aud: undefined }), 'MALFORMED_CLAIM');
});

// ===========================================================================
// Clause: expiry — a stale / expired / not-yet-valid session cannot act.
// ===========================================================================

test('expiry: fresh session admitted (positive); expired / stale / future rejected (negative)', () => {
  ok(goodClaims());
  // Expired token (beyond skew).
  rejectedWith(goodClaims({ exp: NOW - 31 }), 'EXPIRED');
  // Not yet valid.
  rejectedWith(goodClaims({ nbf: NOW + 31 }), 'NOT_YET_VALID');
  // Issued in the future.
  rejectedWith(goodClaims({ iat: NOW + 31, nbf: NOW + 31 }), 'ISSUED_IN_FUTURE');
  // Stale session: authenticated long ago beyond maxSessionAgeSeconds.
  rejectedWith(goodClaims({ auth_time: NOW - (3600 + 60) }), 'SESSION_STALE');
  // Missing exp is malformed (fail-closed).
  rejectedWith(goodClaims({ exp: undefined }), 'MALFORMED_CLAIM');
});

test('expiry: skew is bounded and honoured within tolerance', () => {
  // Just within skew of expiry -> still valid.
  ok(goodClaims({ exp: NOW - 20 }));
});

// ===========================================================================
// Clause: assurance MUST be separated / step-up — decision duties require aal2, and
// platform administration alone MUST NOT grant decision authority.
// ===========================================================================

test('assurance mapping from acr/amr fails closed and is ordered', () => {
  assert.equal(assuranceFromClaims('aal2', ['pwd', 'otp']), 'aal2');
  assert.equal(assuranceFromClaims('aal3', []), 'aal3');
  assert.equal(assuranceFromClaims(undefined, ['pwd']), 'aal1');
  assert.equal(assuranceFromClaims(undefined, []), 'unknown'); // fail-closed floor
  assert.equal(assuranceFromClaims('bogus', ['pwd', 'otp']), 'aal2'); // derived from amr
  assert.equal(assuranceMeets('aal3', 'aal2'), true);
  assert.equal(assuranceMeets('aal1', 'aal2'), false);
  assert.equal(requiredAssuranceForDuty('approval'), 'aal2');
  assert.equal(requiredAssuranceForDuty('execution'), 'aal1');
});

test('assurance: decision duty requires step-up (positive aal2 admitted, negative aal1 rejected)', () => {
  // Positive: aal2 session admitted for a decision-duty assurance floor.
  ok(goodClaims({ acr: 'aal2', amr: ['pwd', 'otp'] }), 'aal2');
  // Negative: single-factor (aal1) session rejected when aal2 is required.
  rejectedWith(goodClaims({ acr: 'aal1', amr: ['pwd'] }), 'ASSURANCE_INSUFFICIENT', 'aal2');
  // Negative: unknown assurance always rejected even at the baseline floor.
  rejectedWith(goodClaims({ acr: 'aal0', amr: [] }), 'ASSURANCE_INSUFFICIENT', 'aal1');
});

test('platform administration alone MUST NOT grant decision authority (session layer)', () => {
  // A high-assurance session whose ONLY role is platform_admin.
  const admin = ok(
    goodClaims({ sub: 'user-admin', roles: ['platform_admin'], acr: 'aal2' }),
    'aal2',
  );
  assert.equal(hasDecisionRole(admin), false);

  // Positive: a genuine approver session may fill an approval duty.
  const approver = ok(
    goodClaims({ sub: 'user-alice', roles: ['authorized_approver'], acr: 'aal2' }),
    'aal2',
  );
  assert.equal(assertDecisionAuthority(approver, 'approval').permitted, true);

  // Negative: the platform_admin-only session is REFUSED decision authority.
  const denied = assertDecisionAuthority(admin, 'approval');
  assert.equal(denied.permitted, false);
  assert.ok(denied.rejections.some((r) => r.code === 'NO_DECISION_ROLE'));

  // And the SoD layer agrees when the admin session is (mis)used to fill an approval duty:
  // sessionToDutyAssignment yields roles=[platform_admin], which the SoD guard flags.
  const constraint = {
    sodConstraintId: 'sod-oidc-admin',
    tenantId: 'tenant-a',
    actionClass: 'consequential-change',
    incompatibleRoles: [],
    incompatibleRelationships: [],
    minimumDistinctPrincipals: 1,
    status: 'active',
  };
  const evalRes = evaluateSeparationOfDuties(
    [sessionToDutyAssignment(admin, 'approval')],
    constraint,
  );
  assert.equal(evalRes.permitted, false);
  assert.ok(evalRes.violations.some((v) => v.code === 'PLATFORM_ADMIN_NO_AUTHORITY'));
});

test('sessionToDutyAssignment refuses to fill a decision duty from an under-assured session', () => {
  const weak = ok(
    goodClaims({ roles: ['authorized_approver'], acr: 'aal1', amr: ['pwd'] }),
    'aal1',
  );
  // Non-decision duty is fine at aal1.
  assert.doesNotThrow(() => sessionToDutyAssignment(weak, 'execution'));
  // A decision duty requires aal2 -> throws, so an under-assured session can never be bridged
  // into an approval/review/assurance DutyAssignment.
  assert.throws(() => sessionToDutyAssignment(weak, 'approval'), /assurance/);
});

// ===========================================================================
// Clause: the independent central reviewer for a cross-tenant action MUST be distinct and
// MUST NOT hold an incompatible action role — at the SESSION layer.
// ===========================================================================

test('cross-tenant reviewer session: distinct high-assurance reviewer admitted (positive)', () => {
  const reviewer = ok(
    goodClaims({
      sub: 'user-carol',
      roles: ['central_governance_reviewer'],
      acr: 'aal3',
      amr: ['pwd', 'fido'],
    }),
    'aal2',
  );
  assert.equal(reviewer.assurance, 'aal3');
  const res = assertCrossTenantReviewerSession(reviewer, ['user-alice', 'user-bob', 'user-dan']);
  assert.equal(res.permitted, true);

  // Cross-check against the SoD-layer distinctness guard over the same identities.
  const sodRes = evaluateCentralReviewerDistinctness(
    {
      requesterPrincipalId: 'user-alice',
      operatorPrincipalId: 'user-bob',
      controlOwnerPrincipalId: null,
      tenantApproverPrincipalIds: ['user-dan'],
    },
    { principalId: 'user-carol', roles: ['central_governance_reviewer'] },
  );
  assert.equal(sodRes.permitted, true);
});

test('cross-tenant reviewer session: not-distinct reviewer rejected (negative)', () => {
  const reviewer = ok(
    goodClaims({
      sub: 'user-alice',
      roles: ['central_governance_reviewer'],
      acr: 'aal3',
      amr: ['fido'],
    }),
    'aal2',
  );
  const res = assertCrossTenantReviewerSession(reviewer, ['user-alice', 'user-bob']);
  assert.equal(res.permitted, false);
  assert.ok(res.rejections.some((r) => r.code === 'REVIEWER_NOT_DISTINCT'));
});

test('cross-tenant reviewer session: reviewer holding an incompatible action role rejected (negative)', () => {
  const reviewer = ok(
    goodClaims({
      sub: 'user-carol',
      roles: ['central_governance_reviewer', 'authorized_approver'],
      acr: 'aal3',
      amr: ['fido'],
    }),
    'aal2',
  );
  const res = assertCrossTenantReviewerSession(reviewer, ['user-alice', 'user-bob']);
  assert.equal(res.permitted, false);
  assert.ok(res.rejections.some((r) => r.code === 'REVIEWER_INCOMPATIBLE_ROLE'));
});

test('cross-tenant reviewer session: low-assurance or non-reviewer session rejected (negative)', () => {
  // aal2 is below the aal3 cross-tenant floor.
  const lowAssurance = ok(
    goodClaims({
      sub: 'user-carol',
      roles: ['central_governance_reviewer'],
      acr: 'aal2',
      amr: ['pwd', 'otp'],
    }),
    'aal2',
  );
  const r1 = assertCrossTenantReviewerSession(lowAssurance, ['user-alice']);
  assert.equal(r1.permitted, false);
  assert.ok(r1.rejections.some((r) => r.code === 'ASSURANCE_INSUFFICIENT'));
  assert.equal(CROSS_TENANT_REVIEWER_ASSURANCE, 'aal3');

  // A session that is not actually assigned the reviewer role is rejected.
  const notReviewer = ok(
    goodClaims({ sub: 'user-dan', roles: ['governance_officer'], acr: 'aal3', amr: ['fido'] }),
    'aal2',
  );
  const r2 = assertCrossTenantReviewerSession(notReviewer, ['user-alice']);
  assert.equal(r2.permitted, false);
  assert.ok(r2.rejections.some((r) => r.code === 'NOT_A_CENTRAL_REVIEWER'));
});

// ===========================================================================
// Fail-closed foundations — an unverified signature or nonce-less session is refused, so a
// forged/replayed token can never seed an authentic principal identity.
// ===========================================================================

test('fail-closed: unverified signature and missing nonce are refused', () => {
  rejectedWith(goodClaims({ __signatureVerified: false }), 'SIGNATURE_UNVERIFIED');
  rejectedWith(goodClaims({ __signatureVerified: undefined }), 'SIGNATURE_UNVERIFIED');
  rejectedWith(goodClaims({ nonce: '' }), 'NONCE_MISSING');
});

test('roles asserted by a session are narrowed to the policy assignable set', () => {
  // A role not in assignableRoles is dropped (cannot self-assert an unlisted role).
  const restrictivePolicy = { ...POLICY, assignableRoles: ['governance_officer'] };
  const v = validateHumanSession(
    goodClaims({ roles: ['authorized_approver', 'governance_officer'] }),
    restrictivePolicy,
    NOW,
  );
  assert.equal(v.ok, true);
  assert.deepEqual(v.session.roles, ['governance_officer']);
});
