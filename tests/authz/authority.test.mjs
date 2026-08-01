// Verification-obligation test for VO-173f7afb7801f4ab3e29 (T042 / GAR-003), exercised through
// the CURRENT-AUTHORITY resolver packages/authz/src/authority.ts.
//
// Oracle: Request, review, approval, execution, evidence administration, control ownership,
// and assurance MUST be separated where conflicts exist; platform administration alone MUST
// NOT grant decision authority, and the independent central reviewer for a cross-tenant
// action MUST NOT hold an incompatible action role.
//
// authority.ts answers "what authority does a principal ACTUALLY hold right now?" (current role
// assignment, delegation lineage, recertification, expiry, break-glass). It never re-implements
// separation of duties: it projects resolved authority onto the canonical SoD types and defers
// to the REAL separation-of-duties.ts. These tests therefore drive BOTH modules together and
// pair every clause with a positive control (clean case permitted) and a negative control
// (violation rejected), so the assertions are non-vacuous. Node built-ins only, loaded via
// --experimental-strip-types, so the suite runs deterministically under `npm ci`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const authority = await import(join(ROOT, 'packages/authz/src/authority.ts'));
const sod = await import(join(ROOT, 'packages/authz/src/separation-of-duties.ts'));

const {
  withinWindow,
  scopeContains,
  resolveRoleAssignment,
  isRecertificationLapsed,
  recertify,
  resolveDelegation,
  resolveBreakGlass,
  resolveEffectiveAuthority,
  authorityToDutyAssignment,
  evaluateActionAuthority,
  evaluateCentralReviewerAuthority,
} = authority;

const { evaluateSeparationOfDuties } = sod;

// --- time fixtures ---------------------------------------------------------
const T0 = 1_700_000_000_000; // an arbitrary but fixed "epoch"
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = T0 + 10 * DAY;

// --- scope fixtures --------------------------------------------------------
const orgScope = {
  scopeType: 'organization',
  scopeId: 'org-1',
  allowedActions: ['approve', 'review', 'execute'],
};
const narrowScope = {
  scopeType: 'organization',
  scopeId: 'org-1',
  allowedActions: ['approve'],
};

// --- role-assignment factory ----------------------------------------------
function assignment(over = {}) {
  return {
    roleAssignmentId: 'ra-1',
    tenantId: 'tenant-a',
    principalId: 'p-1',
    role: 'authorized_approver',
    scope: orgScope,
    validFrom: T0,
    expiresAt: T0 + 30 * DAY,
    status: 'active',
    nextRecertificationAt: T0 + 20 * DAY,
    lastRecertifiedAt: T0,
    ...over,
  };
}

// ===========================================================================
// Clause A — CURRENT ROLE ASSIGNMENT: only an active, in-window, recertified
// assignment grants authority (expiry + status + recertification are gates).
// ===========================================================================

test('A1 positive: active, in-window, recertified assignment grants', () => {
  const r = resolveRoleAssignment(assignment(), NOW);
  assert.equal(r.granted, true);
  assert.equal(r.reason, null);
});

test('A2 negative: pending/suspended/expired/revoked status grants nothing', () => {
  for (const status of ['pending', 'suspended', 'expired', 'revoked']) {
    const r = resolveRoleAssignment(assignment({ status }), NOW);
    assert.equal(r.granted, false, status);
    assert.equal(r.reason, 'STATUS_NOT_ACTIVE', status);
  }
});

test('A3 negative: expiry is a hard, no-grace, exclusive bound', () => {
  const exp = T0 + 5 * DAY;
  // one ms before expiry: granted; at expiry: denied EXPIRED.
  assert.equal(resolveRoleAssignment(assignment({ expiresAt: exp }), exp - 1).granted, true);
  const atExpiry = resolveRoleAssignment(assignment({ expiresAt: exp }), exp);
  assert.equal(atExpiry.granted, false);
  assert.equal(atExpiry.reason, 'EXPIRED');
});

test('A4 negative: not-yet-valid assignment grants nothing', () => {
  const r = resolveRoleAssignment(assignment({ validFrom: NOW + DAY }), NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'NOT_YET_VALID');
});

test('withinWindow: inclusive lower / exclusive upper / open upper', () => {
  assert.equal(withinWindow(10, 10, 20), true);
  assert.equal(withinWindow(20, 10, 20), false);
  assert.equal(withinWindow(15, 10, null), true);
  assert.equal(withinWindow(Number.NaN, 10, 20), false);
});

// ===========================================================================
// Clause B — RECERTIFICATION: an active assignment past its horizon lapses and
// grants nothing until recertified by an INDEPENDENT reviewer.
// ===========================================================================

test('B1 positive: recertification advances the horizon and restores the grant', () => {
  const lapsedAt = T0 + 20 * DAY;
  const now = lapsedAt + HOUR;
  const a = assignment({ nextRecertificationAt: lapsedAt });
  assert.equal(resolveRoleAssignment(a, now).reason, 'RECERTIFICATION_LAPSED');
  assert.equal(isRecertificationLapsed(a, now), true);
  const re = recertify(a, {
    reviewerPrincipalId: 'p-reviewer',
    atMs: now,
    nextRecertificationAt: now + 20 * DAY,
    reason: 'periodic recertification',
  });
  assert.notEqual(re, null);
  assert.equal(resolveRoleAssignment(re, now).granted, true);
});

test('B2 negative: missing recert bookkeeping on an active assignment denies', () => {
  const r = resolveRoleAssignment(assignment({ nextRecertificationAt: null }), NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'RECERTIFICATION_MISSING');
});

test('B3 negative: self-recertification is refused (independence)', () => {
  const a = assignment();
  const re = recertify(a, {
    reviewerPrincipalId: a.principalId, // self
    atMs: NOW,
    nextRecertificationAt: NOW + 20 * DAY,
    reason: 'x',
  });
  assert.equal(re, null);
});

test('B4 negative: recert with empty reason or non-advancing horizon is refused', () => {
  const a = assignment();
  assert.equal(
    recertify(a, {
      reviewerPrincipalId: 'p-r',
      atMs: NOW,
      nextRecertificationAt: NOW + DAY,
      reason: '  ',
    }),
    null,
  );
  assert.equal(
    recertify(a, {
      reviewerPrincipalId: 'p-r',
      atMs: NOW,
      nextRecertificationAt: NOW - DAY,
      reason: 'ok',
    }),
    null,
  );
});

// ===========================================================================
// Clause C — DELEGATION LINEAGE: no tenant-crossing, scope/time expansion,
// cycle, broken chain, or survival past an invalid source.
// ===========================================================================

function delegation(over = {}) {
  return {
    delegationId: 'd-1',
    tenantId: 'tenant-a',
    delegatorPrincipalId: 'p-1',
    recipientPrincipalId: 'p-2',
    authorityAssignmentId: 'ra-1',
    scope: narrowScope,
    reasonText: 'covering leave',
    validFrom: T0,
    expiresAt: T0 + 15 * DAY,
    parentDelegationId: null,
    status: 'active',
    ...over,
  };
}
const sourceOf = (id) => (id === 'ra-1' ? assignment() : null);
const emptyMap = new Map();

test('C1 positive: a valid root delegation from a granting source resolves', () => {
  const r = resolveDelegation(delegation(), emptyMap, sourceOf, NOW);
  assert.equal(r.granted, true);
  assert.deepEqual(r.lineage, ['d-1']);
});

test('C2 negative: cross-tenant delegation is refused', () => {
  const r = resolveDelegation(delegation({ tenantId: 'tenant-b' }), emptyMap, sourceOf, NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'CROSS_TENANT');
});

test('C3 negative: scope expansion beyond the source is refused', () => {
  const wide = {
    scopeType: 'organization',
    scopeId: 'org-1',
    allowedActions: ['approve', 'delete-everything'],
  };
  const r = resolveDelegation(delegation({ scope: wide }), emptyMap, sourceOf, NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'SCOPE_EXPANSION');
});

test('C4 negative: time expansion beyond the source is refused', () => {
  const r = resolveDelegation(
    delegation({ expiresAt: T0 + 90 * DAY }), // source expires at T0+30d
    emptyMap,
    sourceOf,
    NOW,
  );
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'TIME_EXPANSION');
});

test('C5 negative: self-delegation (delegator === recipient) is refused', () => {
  const r = resolveDelegation(delegation({ recipientPrincipalId: 'p-1' }), emptyMap, sourceOf, NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'SELF_DELEGATION');
});

test('C6 negative: a cycle in the parent chain is refused', () => {
  const a = delegation({ delegationId: 'd-a', parentDelegationId: 'd-b' });
  const b = delegation({ delegationId: 'd-b', parentDelegationId: 'd-a' });
  const map = new Map([
    ['d-a', a],
    ['d-b', b],
  ]);
  const r = resolveDelegation(a, map, sourceOf, NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'CYCLE');
});

test('C7 negative: a delegation cannot outlive an expired/invalid source assignment', () => {
  const deadSource = () => assignment({ status: 'revoked' });
  const r = resolveDelegation(delegation(), emptyMap, deadSource, NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'SOURCE_INVALID');
});

test('C8 positive: a two-link chain that narrows scope and time resolves', () => {
  const parent = delegation({
    delegationId: 'd-parent',
    scope: narrowScope,
    expiresAt: T0 + 15 * DAY,
  });
  const child = delegation({
    delegationId: 'd-child',
    delegatorPrincipalId: 'p-2',
    recipientPrincipalId: 'p-3',
    parentDelegationId: 'd-parent',
    scope: narrowScope,
    expiresAt: T0 + 12 * DAY,
    validFrom: T0 + DAY,
  });
  const map = new Map([
    ['d-parent', parent],
    ['d-child', child],
  ]);
  const r = resolveDelegation(child, map, sourceOf, NOW);
  assert.equal(r.granted, true);
  assert.deepEqual(r.lineage, ['d-child', 'd-parent']);
});

test('C9 negative: a broken parent link (missing ancestor) is refused', () => {
  const child = delegation({ delegationId: 'd-child', parentDelegationId: 'd-missing' });
  const r = resolveDelegation(child, new Map([['d-child', child]]), sourceOf, NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'BROKEN_CHAIN');
});

test('scopeContains: exact-action subset only, never widening', () => {
  assert.equal(scopeContains(orgScope, narrowScope), true);
  assert.equal(scopeContains(narrowScope, orgScope), false);
  assert.equal(scopeContains(orgScope, { ...orgScope, scopeId: 'other' }), false);
});

// ===========================================================================
// Clause D — BREAK-GLASS RESOLUTION: short-lived, reason/incident/monitoring
// required, independent reviewer, and NEVER decision authority.
// ===========================================================================

function breakGlass(over = {}) {
  return {
    breakGlassGrantId: 'bg-1',
    tenantId: 'tenant-a',
    principalId: 'p-9',
    scope: narrowScope,
    reasonText: 'sev1 incident response',
    incidentId: 'inc-1',
    activatedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    monitoringEvidenceId: 'ev-1',
    reviewerPrincipalId: 'p-reviewer',
    reviewDueAt: NOW + DAY,
    reviewedAt: null,
    status: 'active',
    ...over,
  };
}

test('D1 positive: active, unexpired, well-formed break-glass grants (non-decision) authority', () => {
  const r = resolveBreakGlass(breakGlass(), NOW);
  assert.equal(r.granted, true);
  assert.equal(r.reason, null);
});

test('D2 negative: expired break-glass grants nothing (short-lived, exclusive bound)', () => {
  const r = resolveBreakGlass(breakGlass({ expiresAt: NOW }), NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'EXPIRED');
});

test('D3 negative: non-independent reviewer (== grantee) refused', () => {
  const r = resolveBreakGlass(breakGlass({ reviewerPrincipalId: 'p-9' }), NOW);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'NON_INDEPENDENT_REVIEWER');
});

test('D4 negative: missing reason / incident / monitoring evidence refused', () => {
  assert.equal(resolveBreakGlass(breakGlass({ reasonText: ' ' }), NOW).reason, 'MISSING_REASON');
  assert.equal(resolveBreakGlass(breakGlass({ incidentId: '' }), NOW).reason, 'MISSING_INCIDENT');
  assert.equal(
    resolveBreakGlass(breakGlass({ monitoringEvidenceId: '' }), NOW).reason,
    'MISSING_MONITORING',
  );
});

// ===========================================================================
// Clause E — THE SoD ORACLE, exercised end-to-end through resolved authority.
// authority.ts projects onto the REAL separation-of-duties.ts; the oracle is
// enforced by a single source of truth, never re-derived.
// ===========================================================================

const constraint = {
  sodConstraintId: 'sod-1',
  tenantId: 'tenant-a',
  actionClass: 'consequential-change',
  incompatibleRoles: [],
  incompatibleRelationships: [],
  minimumDistinctPrincipals: 2,
  status: 'active',
};

function effective(principalId, roles, scopes = [orgScope], breakGlassOnly = false) {
  return {
    principalId,
    tenantId: 'tenant-a',
    roles,
    scopes,
    activeDelegationIds: [],
    activeBreakGlassIds: [],
    breakGlassOnly,
  };
}

test('E1 positive: separated request + approval by distinct authorized principals is permitted', () => {
  const req = effective('p-req', ['governance_officer']);
  const app = effective('p-app', ['authorized_approver']);
  const res = evaluateActionAuthority(
    [
      { authority: req, duty: 'request', relationships: ['requester'] },
      { authority: app, duty: 'approval', relationships: ['approver'] },
    ],
    constraint,
  );
  assert.equal(res.permitted, true, JSON.stringify(res.violations));
});

test('E2 negative: one principal filling both request and approval (self-approval) is rejected', () => {
  const p = effective('p-solo', ['governance_officer', 'authorized_approver']);
  const res = evaluateActionAuthority(
    [
      { authority: p, duty: 'request', relationships: ['requester'] },
      { authority: p, duty: 'approval', relationships: ['approver'] },
    ],
    constraint,
  );
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'SELF_APPROVAL'));
});

test('E3 negative: platform administration ALONE grants no decision authority', () => {
  const req = effective('p-req', ['governance_officer']);
  const admin = effective('p-admin', ['platform_admin']); // non-decision role only
  const res = evaluateActionAuthority(
    [
      { authority: req, duty: 'request', relationships: ['requester'] },
      { authority: admin, duty: 'approval', relationships: ['approver'] },
    ],
    constraint,
  );
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'PLATFORM_ADMIN_NO_AUTHORITY'));
});

test('E4 negative: break-glass authority can never fill a DECISION duty', () => {
  const req = effective('p-req', ['governance_officer']);
  const emergency = effective('p-bg', ['authorized_approver'], [narrowScope], true); // breakGlassOnly
  // The bridge strips decision roles for break-glass-only principals -> PLATFORM_ADMIN_NO_AUTHORITY.
  const a = authorityToDutyAssignment(emergency, 'approval', ['approver']);
  assert.deepEqual(a.roles, []);
  const res = evaluateActionAuthority(
    [
      { authority: req, duty: 'request', relationships: ['requester'] },
      { authority: emergency, duty: 'approval', relationships: ['approver'] },
    ],
    constraint,
  );
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'PLATFORM_ADMIN_NO_AUTHORITY'));
});

test('E5 negative: a participant with NO current authority contributes nothing => fails closed', () => {
  const req = effective('p-req', ['governance_officer']);
  const noAuthority = effective('p-none', []); // no granting role
  assert.equal(authorityToDutyAssignment(noAuthority, 'approval', ['approver']), null);
  const res = evaluateActionAuthority(
    [
      { authority: req, duty: 'request', relationships: ['requester'] },
      { authority: noAuthority, duty: 'approval', relationships: ['approver'] },
    ],
    constraint,
  );
  // Only the requester's assignment survives -> below minimum distinct principals.
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'INSUFFICIENT_DISTINCT_PRINCIPALS'));
});

// ===========================================================================
// Clause F — cross-tenant independent central reviewer distinctness, from
// resolved authority, deferring to the SoD source of truth.
// ===========================================================================

const crossTenantAction = {
  requesterPrincipalId: 'p-req',
  operatorPrincipalId: 'p-op',
  controlOwnerPrincipalId: 'p-owner',
  tenantApproverPrincipalIds: ['p-approver-a', 'p-approver-b'],
};

test('F1 positive: a distinct central reviewer with the reviewer role is permitted', () => {
  const reviewer = effective('p-central', ['central_governance_reviewer']);
  const res = evaluateCentralReviewerAuthority(crossTenantAction, reviewer);
  assert.equal(res.permitted, true, JSON.stringify(res.violations));
});

test('F2 negative: reviewer coinciding with an action principal is rejected', () => {
  const reviewer = effective('p-req', ['central_governance_reviewer']); // == requester
  const res = evaluateCentralReviewerAuthority(crossTenantAction, reviewer);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'CENTRAL_REVIEWER_NOT_DISTINCT'));
});

test('F3 negative: reviewer holding an incompatible action role is rejected', () => {
  const reviewer = effective('p-central', ['central_governance_reviewer', 'authorized_approver']);
  const res = evaluateCentralReviewerAuthority(crossTenantAction, reviewer);
  assert.equal(res.permitted, false);
  assert.ok(res.violations.some((v) => v.code === 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE'));
});

test('F4 negative: break-glass-only reviewer carries no reviewer role => fails closed', () => {
  const reviewer = effective('p-central', ['central_governance_reviewer'], [narrowScope], true);
  const res = evaluateCentralReviewerAuthority(crossTenantAction, reviewer);
  assert.equal(res.permitted, false);
});

// ===========================================================================
// Clause G — the effective-authority union honours every gate above.
// ===========================================================================

test('G1: resolveEffectiveAuthority unions only currently-granting sources', () => {
  const active = assignment({ roleAssignmentId: 'ra-a', role: 'authorized_approver' });
  const expired = assignment({ roleAssignmentId: 'ra-x', role: 'operator', status: 'revoked' });
  const eff = resolveEffectiveAuthority(
    {
      principalId: 'p-1',
      tenantId: 'tenant-a',
      assignments: [active, expired],
      delegations: [],
      breakGlassGrants: [],
      allDelegationsById: emptyMap,
      sourceOf,
    },
    NOW,
  );
  assert.deepEqual(eff.roles, ['authorized_approver']); // revoked one excluded
  assert.equal(eff.breakGlassOnly, false);
});

test('G2: a principal whose ONLY authority is break-glass is flagged breakGlassOnly', () => {
  const eff = resolveEffectiveAuthority(
    {
      principalId: 'p-9',
      tenantId: 'tenant-a',
      assignments: [],
      delegations: [],
      breakGlassGrants: [breakGlass()],
      allDelegationsById: emptyMap,
      sourceOf,
    },
    NOW,
  );
  assert.equal(eff.breakGlassOnly, true);
  assert.deepEqual(eff.activeBreakGlassIds, ['bg-1']);
});

// A final direct cross-check: the bridge output is byte-for-byte a valid SoD input, so any
// future divergence between authority.ts and separation-of-duties.ts breaks this test.
test('bridge output is consumed unchanged by the SoD source of truth', () => {
  const req = authorityToDutyAssignment(effective('p-req', ['governance_officer']), 'request', [
    'requester',
  ]);
  const app = authorityToDutyAssignment(effective('p-app', ['authorized_approver']), 'approval', [
    'approver',
  ]);
  const direct = evaluateSeparationOfDuties([req, app], constraint);
  assert.equal(direct.permitted, true, JSON.stringify(direct.violations));
});
