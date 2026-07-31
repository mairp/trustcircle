// Verification-obligation test for VO-173f7afb7801f4ab3e29 (T043 / GAR-003).
//
// Oracle: Request, review, approval, execution, evidence administration, control ownership,
// and assurance MUST be separated where conflicts exist; platform administration alone MUST
// NOT grant decision authority, and the independent central reviewer for a cross-tenant
// action MUST NOT hold an incompatible action role.
//
// Independently observable: exercises the REAL packages/authz/src/separation-of-duties.ts
// implementation using only Node built-ins (loaded via --experimental-strip-types), so it
// runs deterministically under `npm ci` with no adjacent infrastructure. Each test maps to a
// clause of the oracle and pairs a positive control (clean case permitted) with a negative
// control (violation rejected), so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'packages/authz/src/separation-of-duties.ts'));
const {
  evaluateSeparationOfDuties,
  evaluateWithWaiver,
  evaluateCentralReviewerDistinctness,
  dutiesConflict,
  isNonWaivable,
} = mod;

// --- fixtures --------------------------------------------------------------

/** A waivable, tenant-scoped constraint requiring 2 distinct principals. */
const tenantConstraint = {
  sodConstraintId: 'sod-1',
  tenantId: 'tenant-a',
  actionClass: 'consequential-change',
  incompatibleRoles: [],
  incompatibleRelationships: [],
  minimumDistinctPrincipals: 2,
  status: 'active',
};

/** A non-waivable central guardrail (tenantId === null). */
const centralGuardrail = {
  ...tenantConstraint,
  sodConstraintId: 'sod-central',
  tenantId: null,
};

const requester = {
  principalId: 'p-req',
  duty: 'request',
  roles: ['governance_officer'],
  relationships: ['requester'],
  tenantId: 'tenant-a',
};
const approver = {
  principalId: 'p-app',
  duty: 'approval',
  roles: ['authorized_approver'],
  relationships: ['approver'],
  tenantId: 'tenant-a',
};

// --- Clause: duties separated where conflicts exist (self-approval guard) ---

test('conflicting duty pairs are recognized; identical duties never conflict', () => {
  assert.equal(dutiesConflict('request', 'approval'), true);
  assert.equal(dutiesConflict('approval', 'request'), true, 'symmetric');
  assert.equal(dutiesConflict('execution', 'approval'), true);
  // positive control: same duty is not a self-conflict
  assert.equal(dutiesConflict('approval', 'approval'), false);
});

test('POSITIVE: distinct requester and approver is permitted', () => {
  const res = evaluateSeparationOfDuties([requester, approver], tenantConstraint);
  assert.equal(res.permitted, true, JSON.stringify(res.violations));
});

test('NEGATIVE: one principal holding request + approval is a self-approval violation', () => {
  const selfApprover = { ...approver, principalId: 'p-req' }; // same principal as requester
  const res = evaluateSeparationOfDuties([requester, selfApprover], tenantConstraint);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'SELF_APPROVAL'));
});

// --- Clause: incompatible relationships must be separated ---

test('NEGATIVE: approver who is also the requester (relationship) is rejected', () => {
  const conflicted = {
    ...approver,
    principalId: 'p-app',
    relationships: ['requester'], // approver bears requester relationship
  };
  const res = evaluateSeparationOfDuties([requester, conflicted], tenantConstraint);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'INCOMPATIBLE_RELATIONSHIP'));
});

test('NEGATIVE: constraint-declared incompatible relationship is enforced', () => {
  const c = { ...tenantConstraint, incompatibleRelationships: ['custodian'] };
  const custodianApprover = { ...approver, relationships: ['approver', 'custodian'] };
  const res = evaluateSeparationOfDuties([requester, custodianApprover], c);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'INCOMPATIBLE_RELATIONSHIP'));
});

// --- Clause: platform administration alone MUST NOT grant decision authority ---

test('NEGATIVE: approval duty backed only by platform_admin has no authority', () => {
  const adminApprover = {
    ...approver,
    principalId: 'p-admin',
    roles: ['platform_admin'], // administration alone
    relationships: ['approver'],
  };
  const res = evaluateSeparationOfDuties([requester, adminApprover], tenantConstraint);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'PLATFORM_ADMIN_NO_AUTHORITY'));
});

test('POSITIVE: platform_admin PLUS a decision role does grant authority', () => {
  const adminPlusApprover = {
    ...approver,
    principalId: 'p-admin2',
    roles: ['platform_admin', 'authorized_approver'],
  };
  const res = evaluateSeparationOfDuties([requester, adminPlusApprover], tenantConstraint);
  assert.equal(res.permitted, true, JSON.stringify(res.violations));
});

// --- Clause: incompatible roles forbidden for the action ---

test('NEGATIVE: role explicitly forbidden by the constraint is rejected', () => {
  const c = { ...tenantConstraint, incompatibleRoles: ['operator'] };
  const operatorApprover = { ...approver, roles: ['authorized_approver', 'operator'] };
  const res = evaluateSeparationOfDuties([requester, operatorApprover], c);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'INCOMPATIBLE_ROLE'));
});

// --- Clause: minimum distinct principals ---

test('NEGATIVE: fewer than the required distinct principals is rejected', () => {
  // Both duties held by the same principal -> only 1 distinct, requires 2.
  const solo1 = { ...requester, principalId: 'solo' };
  const solo2 = { ...approver, principalId: 'solo', duty: 'review', relationships: [] };
  const res = evaluateSeparationOfDuties([solo1, solo2], tenantConstraint);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'INSUFFICIENT_DISTINCT_PRINCIPALS'));
});

test('fail-closed: empty assignment set is never permitted', () => {
  const res = evaluateSeparationOfDuties([], tenantConstraint);
  assert.equal(res.permitted, false);
});

// --- Clause: non-waivable central guardrail cannot be waived ---

test('isNonWaivable distinguishes central guardrails from tenant constraints', () => {
  assert.equal(isNonWaivable(centralGuardrail), true);
  assert.equal(isNonWaivable(tenantConstraint), false);
});

test('NEGATIVE: waiving a non-waivable central guardrail is forbidden', () => {
  // A clean set that WOULD pass, but a waiver is requested against a non-waivable guardrail.
  const res = evaluateWithWaiver([requester, approver], centralGuardrail, {
    requested: true,
    byTenantId: 'tenant-a',
  });
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'WAIVER_FORBIDDEN'));
});

test('POSITIVE: waiver on a waivable tenant constraint clears violations', () => {
  // A self-approval that would normally fail, waived on a waivable constraint.
  const selfApprover = { ...approver, principalId: 'p-req' };
  const res = evaluateWithWaiver([requester, selfApprover], tenantConstraint, {
    requested: true,
    byTenantId: 'tenant-a',
  });
  assert.equal(res.permitted, true);
});

// --- Clause: cross-tenant central reviewer distinct + no incompatible role ---

const crossTenantAction = {
  requesterPrincipalId: 'p-req',
  operatorPrincipalId: 'p-op',
  controlOwnerPrincipalId: 'p-owner',
  tenantApproverPrincipalIds: ['p-tenant1', 'p-tenant2'],
};

test('POSITIVE: a distinct central reviewer with only the reviewer role is permitted', () => {
  const res = evaluateCentralReviewerDistinctness(crossTenantAction, {
    principalId: 'p-central',
    roles: ['central_governance_reviewer'],
  });
  assert.equal(res.permitted, true, JSON.stringify(res.violations));
});

test('NEGATIVE: central reviewer coinciding with a tenant approver is rejected', () => {
  const res = evaluateCentralReviewerDistinctness(crossTenantAction, {
    principalId: 'p-tenant1', // same principal as an affected-tenant approver
    roles: ['central_governance_reviewer'],
  });
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'CENTRAL_REVIEWER_NOT_DISTINCT'));
});

test('NEGATIVE: central reviewer holding an incompatible action role is rejected', () => {
  const res = evaluateCentralReviewerDistinctness(crossTenantAction, {
    principalId: 'p-central',
    roles: ['central_governance_reviewer', 'authorized_approver'], // incompatible
  });
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE'));
});

test('fail-closed: a reviewer without the central_governance_reviewer role is rejected', () => {
  const res = evaluateCentralReviewerDistinctness(crossTenantAction, {
    principalId: 'p-other',
    roles: ['governance_officer'],
  });
  assert.equal(res.permitted, false);
});
