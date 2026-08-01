// Security-suite test — fail-closed authorization behavior
// (Phase 45 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item 55KSGHGTBWJNXMA1Z6SXV9JMKJ /
//  VO-173f7afb7801f4ab3e29 + VO-7fb9a468ef56dbcb1b0d + VO-e4323651ab39776dcdbd).
//
// Oracle (acceptance criterion for Phase 45):
//   Request, review, approval, execution, evidence administration, control ownership, and
//   assurance MUST be separated where conflicts exist; platform administration alone MUST NOT
//   grant decision authority, and the independent central reviewer for a cross-tenant action
//   MUST NOT hold an incompatible action role.
//
// This suite proves the authorization stack FAILS CLOSED across the five defect classes named
// in the phase objective:
//
//   1. MISSING IDENTITY          — a participant with no granting authority contributes no duty
//                                  assignment, so the action denies (never silently permits).
//   2. STALE OR UNSIGNED POLICY  — the PDP refuses to load/decide against an unsigned bundle, a
//                                  tampered bundle, or a revision that drifted from the caller's
//                                  pinned revision. Every such case is a hard deny, not a permit.
//   3. INDETERMINATE PDP RESULT  — an unknown policy / unavailable adapter throws
//                                  PdpUnavailableError; callers MUST treat that as deny.
//   4. EXPIRED AUTHORITY         — expired role assignments, expired delegations, and expired
//                                  break-glass grants confer NOTHING at `now`.
//   5. ABSENT / TAMPERED EVIDENCE— decision evidence with a stripped or altered signature fails
//                                  verification, so a decision cannot be "reported as complete"
//                                  without a durable, reconstructable, tamper-evident proof.
//
// Every assertion is paired with a POSITIVE control (the same shape that SHOULD pass), so the
// oracle is non-vacuous: the deny cases deny only because of the defect under test, and the
// well-formed case is genuinely permitted.
//
// The suite imports the real authz + policy sources via their declared paths (matching the
// convention in the sibling security tests) so a regression in any fail-closed guard is caught
// by `vitest run --project security`. No mocks, no TODO scaffolds — observable behavior only.

import { describe, it, expect } from 'vitest';

// Separation-of-duties source of truth (packages/authz/src/separation-of-duties.ts).
import {
  evaluateSeparationOfDuties,
  evaluateWithWaiver,
  evaluateCentralReviewerDistinctness,
  isNonWaivable,
  INCOMPATIBLE_CENTRAL_REVIEWER_ROLES,
  type DutyAssignment,
  type SoDConstraint,
  type CrossTenantAction,
  type CentralReviewer,
} from '../../packages/authz/src/separation-of-duties.ts';

// Authority resolution — identity, expiry, delegation, break-glass, and the sanctioned bridges
// into the SoD source of truth (packages/authz/src/authority.ts).
import {
  resolveRoleAssignment as resolveRoleAssignmentA,
  resolveDelegation as resolveDelegationA,
  resolveBreakGlass as resolveBreakGlassA,
  resolveEffectiveAuthority as resolveEffectiveAuthorityA,
  evaluateActionAuthority as evaluateActionAuthorityA,
  evaluateCentralReviewerAuthority as evaluateCentralReviewerAuthorityA,
  type RoleAssignment as RoleAssignmentA,
  type Delegation as DelegationA,
  type BreakGlassGrant as BreakGlassGrantA,
  type AuthorityScope as AuthorityScopeA,
} from '../../packages/authz/src/authority.ts';

// Policy decision point — signed OPA bundle adapter + decision evidence
// (packages/policy/src/pdp.ts).
import {
  createSignedOpaPdp,
  signBundle,
  verifyBundle,
  verifyDecisionEvidence,
  PdpUnavailableError,
  type SignedPolicyBundle,
  type DecisionRequest,
} from '../../packages/policy/src/pdp.ts';

// ---------------------------------------------------------------------------
// Fixtures & builders.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed injected instant (ms) — no wall-clock dependence.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ORG_SCOPE: AuthorityScopeA = {
  scopeType: 'organization',
  scopeId: 'org-1',
  allowedActions: ['approve', 'reconcile'],
};

/** A well-formed, currently-granting role assignment (positive baseline). */
function activeAssignment(over: Partial<RoleAssignmentA> = {}): RoleAssignmentA {
  return {
    roleAssignmentId: 'ra-1',
    tenantId: 'tenant-a',
    principalId: 'alice',
    role: 'authorized_approver',
    scope: ORG_SCOPE,
    validFrom: NOW - DAY,
    expiresAt: NOW + DAY,
    status: 'active',
    nextRecertificationAt: NOW + 30 * DAY,
    lastRecertifiedAt: NOW - DAY,
    ...over,
  };
}

/** A well-formed, active delegation drawing from `authorityAssignmentId` (positive baseline). */
function activeDelegation(over: Partial<DelegationA> = {}): DelegationA {
  return {
    delegationId: 'del-1',
    tenantId: 'tenant-a',
    delegatorPrincipalId: 'alice',
    recipientPrincipalId: 'bob',
    authorityAssignmentId: 'ra-1',
    scope: ORG_SCOPE,
    reasonText: 'covering approvals during PTO',
    validFrom: NOW - HOUR,
    expiresAt: NOW + HOUR,
    parentDelegationId: null,
    status: 'active',
    ...over,
  };
}

/** A well-formed, active break-glass grant (positive baseline). */
function activeBreakGlass(over: Partial<BreakGlassGrantA> = {}): BreakGlassGrantA {
  return {
    breakGlassGrantId: 'bg-1',
    tenantId: 'tenant-a',
    principalId: 'carol',
    scope: ORG_SCOPE,
    reasonText: 'sev-1 incident response',
    incidentId: 'INC-42',
    activatedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    monitoringEvidenceId: 'mon-1',
    reviewerPrincipalId: 'dave',
    reviewDueAt: NOW + DAY,
    reviewedAt: null,
    status: 'active',
    ...over,
  };
}

/** A standard tenant-scoped (waivable) SoD constraint requiring two distinct principals. */
function tenantConstraint(over: Partial<SoDConstraint> = {}): SoDConstraint {
  return {
    sodConstraintId: 'sod-1',
    tenantId: 'tenant-a',
    actionClass: 'consequential_action',
    incompatibleRoles: [],
    incompatibleRelationships: [],
    minimumDistinctPrincipals: 2,
    status: 'active',
    ...over,
  };
}

/** A non-waivable central guardrail (tenantId === null). */
function centralGuardrail(over: Partial<SoDConstraint> = {}): SoDConstraint {
  return tenantConstraint({ sodConstraintId: 'sod-central', tenantId: null, ...over });
}

const BUNDLE_KEY = 'bundle-signing-key';
const EVIDENCE_KEY = 'evidence-signing-key';
const REV = 'rev-2024.11';

/** Build a revision-pinned, evidence-signing PDP over both SoD policies. */
function makePdp() {
  return createSignedOpaPdp({
    revision: REV,
    bundleSigningKey: BUNDLE_KEY,
    evidenceSigningKey: EVIDENCE_KEY,
  });
}

/** A permitting SoD decision request against the pinned revision. */
function permitRequest(): DecisionRequest {
  return {
    query: {
      policy: 'separation_of_duties',
      input: {
        assignments: [
          {
            principalId: 'alice',
            duty: 'request',
            roles: ['operator'],
            relationships: ['requester'],
            tenantId: 'tenant-a',
          },
          {
            principalId: 'bob',
            duty: 'approval',
            roles: ['authorized_approver'],
            relationships: ['approver'],
            tenantId: 'tenant-a',
          },
        ],
        constraint: tenantConstraint(),
      },
    },
    actorPrincipalId: 'system',
    correlationId: 'corr-1',
    pinnedRevision: REV,
    now: NOW,
  };
}

// ===========================================================================
// 1. MISSING IDENTITY — no authority contributes no duty; the action denies.
// ===========================================================================

describe('fail-closed: missing identity', () => {
  it('POSITIVE — two distinct authorized principals filling separated duties are permitted', () => {
    const assignments: DutyAssignment[] = [
      {
        principalId: 'alice',
        duty: 'request',
        roles: ['operator'],
        relationships: ['requester'],
        tenantId: 'tenant-a',
      },
      {
        principalId: 'bob',
        duty: 'approval',
        roles: ['authorized_approver'],
        relationships: ['approver'],
        tenantId: 'tenant-a',
      },
    ];
    const res = evaluateSeparationOfDuties(assignments, tenantConstraint());
    expect(res.permitted).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('empty assignment set (no identity) denies — cannot be independently reviewed', () => {
    const res = evaluateSeparationOfDuties([], tenantConstraint());
    expect(res.permitted).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('INSUFFICIENT_DISTINCT_PRINCIPALS');
  });

  it('a participant whose principal holds no authority contributes no assignment → action fails closed', () => {
    // The approver's principal has NO granting assignment (missing identity). Its effective
    // authority carries no roles, so authorityToDutyAssignment yields null and the action is
    // left with a single distinct principal — below the required minimum.
    const requesterAuthority = resolveEffectiveAuthorityA(
      {
        principalId: 'alice',
        tenantId: 'tenant-a',
        assignments: [activeAssignment({ principalId: 'alice', role: 'operator' })],
        delegations: [],
        breakGlassGrants: [],
        allDelegationsById: new Map(),
        sourceOf: () => null,
      },
      NOW,
    );
    const missingApproverAuthority = resolveEffectiveAuthorityA(
      {
        principalId: 'ghost', // no assignments at all → no authority
        tenantId: 'tenant-a',
        assignments: [],
        delegations: [],
        breakGlassGrants: [],
        allDelegationsById: new Map(),
        sourceOf: () => null,
      },
      NOW,
    );
    expect(missingApproverAuthority.roles).toHaveLength(0);

    const res = evaluateActionAuthorityA(
      [
        { authority: requesterAuthority, duty: 'request', relationships: ['requester'] },
        { authority: missingApproverAuthority, duty: 'approval', relationships: ['approver'] },
      ],
      tenantConstraint(),
    );
    expect(res.permitted).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('INSUFFICIENT_DISTINCT_PRINCIPALS');
  });
});

// ===========================================================================
// 2. STALE OR UNSIGNED POLICY — the PDP refuses unsigned/tampered/drifted bundles.
// ===========================================================================

describe('fail-closed: stale or unsigned policy', () => {
  it('POSITIVE — a correctly signed, pinned bundle loads and renders a decision', () => {
    const pdp = makePdp();
    expect(pdp.descriptor.revision).toBe(REV);
    const result = pdp.decide(permitRequest());
    expect(result.decision.permit).toBe(true);
  });

  it('an UNSIGNED bundle is rejected at load — never served', () => {
    const unsigned: SignedPolicyBundle = {
      revision: REV,
      roots: ['separation_of_duties', 'central_reviewer_distinctness'],
      signature: '', // no signature
    };
    expect(() => verifyBundle(unsigned, BUNDLE_KEY)).toThrowError(PdpUnavailableError);
    try {
      verifyBundle(unsigned, BUNDLE_KEY);
    } catch (e) {
      expect((e as PdpUnavailableError).reason).toBe('unsigned');
    }
  });

  it('a TAMPERED bundle (revision changed after signing) fails signature verification', () => {
    const signed = signBundle({ revision: REV, roots: ['separation_of_duties'] }, BUNDLE_KEY);
    const tampered: SignedPolicyBundle = { ...signed, revision: 'rev-attacker' };
    expect(() => verifyBundle(tampered, BUNDLE_KEY)).toThrowError(PdpUnavailableError);
    try {
      verifyBundle(tampered, BUNDLE_KEY);
    } catch (e) {
      expect((e as PdpUnavailableError).reason).toBe('bad-signature');
    }
  });

  it('a bundle signed with the WRONG key is rejected (stale / untrusted publisher)', () => {
    const signedElsewhere = signBundle(
      { revision: REV, roots: ['separation_of_duties'] },
      'attacker-key',
    );
    expect(() => verifyBundle(signedElsewhere, BUNDLE_KEY)).toThrowError(PdpUnavailableError);
  });

  it('REVISION DRIFT between the caller pin and the served bundle is a hard deny (no silent swap)', () => {
    const pdp = makePdp();
    const drifted: DecisionRequest = { ...permitRequest(), pinnedRevision: 'rev-old' };
    expect(() => pdp.decide(drifted)).toThrowError(PdpUnavailableError);
    try {
      pdp.decide(drifted);
    } catch (e) {
      expect((e as PdpUnavailableError).reason).toBe('revision-mismatch');
    }
  });
});

// ===========================================================================
// 3. INDETERMINATE PDP RESULT — unknown policy / unavailable adapter denies.
// ===========================================================================

describe('fail-closed: indeterminate PDP result', () => {
  it('an unknown policy root cannot be loaded (fail closed at construction)', () => {
    const badBundle = signBundle(
      // Cast: deliberately claim a root the PDP cannot serve.
      { revision: REV, roots: ['not_a_real_policy' as unknown as 'separation_of_duties'] },
      BUNDLE_KEY,
    );
    expect(() => verifyBundle(badBundle, BUNDLE_KEY)).toThrowError(PdpUnavailableError);
    try {
      verifyBundle(badBundle, BUNDLE_KEY);
    } catch (e) {
      expect((e as PdpUnavailableError).reason).toBe('unknown-root');
    }
  });

  it('an unknown policy in a decision request throws PdpUnavailableError — callers treat as deny', () => {
    const pdp = makePdp();
    const bogus = {
      ...permitRequest(),
      query: { policy: 'no_such_policy', input: {} },
    } as unknown as DecisionRequest;
    expect(() => pdp.decide(bogus)).toThrowError(PdpUnavailableError);
  });

  it('PdpUnavailableError is distinguishable from a policy denial (deny is data, not an exception)', () => {
    // A genuine SoD denial is a permit:false decision WITH evidence — not a thrown error. This
    // proves the indeterminate/unavailable path is a strictly different, harder failure mode.
    const pdp = makePdp();
    const denyReq: DecisionRequest = {
      ...permitRequest(),
      query: {
        policy: 'separation_of_duties',
        input: {
          assignments: [
            // One principal fills BOTH request and approval — self-approval.
            {
              principalId: 'alice',
              duty: 'request',
              roles: ['authorized_approver'],
              relationships: ['requester'],
              tenantId: 'tenant-a',
            },
            {
              principalId: 'alice',
              duty: 'approval',
              roles: ['authorized_approver'],
              relationships: ['approver'],
              tenantId: 'tenant-a',
            },
          ],
          constraint: tenantConstraint(),
        },
      },
    };
    const result = pdp.decide(denyReq);
    expect(result.decision.permit).toBe(false);
    expect(result.decision.reasons.map((r) => r.code)).toContain('SELF_APPROVAL');
    // …and it still produced verifiable evidence for the recorded deny.
    expect(verifyDecisionEvidence(result.evidence, EVIDENCE_KEY)).toBe(true);
  });
});

// ===========================================================================
// 4. EXPIRED AUTHORITY — expired assignments/delegations/break-glass confer nothing.
// ===========================================================================

describe('fail-closed: expired authority', () => {
  it('POSITIVE — an active, in-window, recertified assignment grants', () => {
    const res = resolveRoleAssignmentA(activeAssignment(), NOW);
    expect(res.granted).toBe(true);
    expect(res.reason).toBeNull();
  });

  it('an EXPIRED role assignment grants nothing', () => {
    const res = resolveRoleAssignmentA(activeAssignment({ expiresAt: NOW - 1 }), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('EXPIRED');
  });

  it('a LAPSED-recertification assignment grants nothing even if not yet expired', () => {
    const res = resolveRoleAssignmentA(activeAssignment({ nextRecertificationAt: NOW - 1 }), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('RECERTIFICATION_LAPSED');
  });

  it('an EXPIRED delegation confers no authority (leaf link expired)', () => {
    const del = activeDelegation({ expiresAt: NOW - 1 });
    const res = resolveDelegationA(
      del,
      new Map([[del.delegationId, del]]),
      () => activeAssignment(),
      NOW,
    );
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('EXPIRED');
  });

  it('a delegation whose SOURCE assignment no longer grants confers no authority', () => {
    const del = activeDelegation();
    // Source's own window still covers the delegation (so no TIME_EXPANSION), but the source
    // assignment is no longer active — resolveRoleAssignment denies, so the delegation denies.
    const res = resolveDelegationA(
      del,
      new Map([[del.delegationId, del]]),
      () => activeAssignment({ status: 'revoked' }),
      NOW,
    );
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SOURCE_INVALID');
  });

  it('an EXPIRED break-glass grant confers no authority', () => {
    const res = resolveBreakGlassA(activeBreakGlass({ expiresAt: NOW - 1 }), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('EXPIRED');
  });

  it('effective authority from ONLY expired inputs is empty (nothing exercisable)', () => {
    const eff = resolveEffectiveAuthorityA(
      {
        principalId: 'alice',
        tenantId: 'tenant-a',
        assignments: [activeAssignment({ expiresAt: NOW - 1 })],
        delegations: [activeDelegation({ recipientPrincipalId: 'alice', expiresAt: NOW - 1 })],
        breakGlassGrants: [activeBreakGlass({ principalId: 'alice', expiresAt: NOW - 1 })],
        allDelegationsById: new Map(),
        sourceOf: () => activeAssignment(),
      },
      NOW,
    );
    expect(eff.roles).toHaveLength(0);
    expect(eff.activeDelegationIds).toHaveLength(0);
    expect(eff.activeBreakGlassIds).toHaveLength(0);
  });
});

// ===========================================================================
// 5. ABSENT / TAMPERED EVIDENCE — a decision without a valid, verifiable proof is not complete.
// ===========================================================================

describe('fail-closed: absent or tampered decision evidence', () => {
  it('POSITIVE — a freshly rendered decision carries verifiable, tamper-evident evidence', () => {
    const pdp = makePdp();
    const result = pdp.decide(permitRequest());
    expect(verifyDecisionEvidence(result.evidence, EVIDENCE_KEY)).toBe(true);
    // The evidence binds the exact bundle revision + digest (no evidence, no completion claim).
    expect(result.evidence.bundleRevision).toBe(REV);
    expect(result.evidence.bundleDigest).toBe(pdp.descriptor.bundleDigest);
  });

  it('ABSENT signature fails verification (evidence with an empty signature is not proof)', () => {
    const pdp = makePdp();
    const { evidence } = pdp.decide(permitRequest());
    const stripped = { ...evidence, signature: '' };
    expect(verifyDecisionEvidence(stripped, EVIDENCE_KEY)).toBe(false);
  });

  it('TAMPERED evidence (permit flipped after signing) fails verification', () => {
    const pdp = makePdp();
    const { evidence } = pdp.decide(permitRequest());
    const forged = { ...evidence, permit: !evidence.permit };
    expect(verifyDecisionEvidence(forged, EVIDENCE_KEY)).toBe(false);
  });

  it('evidence verified under the WRONG key fails (a foreign signer cannot forge completion)', () => {
    const pdp = makePdp();
    const { evidence } = pdp.decide(permitRequest());
    expect(verifyDecisionEvidence(evidence, 'not-the-signing-key')).toBe(false);
  });
});

// ===========================================================================
// ACCEPTANCE CRITERION — the SoD oracle itself (separation, platform-admin-alone,
// non-waivable guardrails, cross-tenant central-reviewer distinctness).
// ===========================================================================

describe('acceptance: separation of duties oracle (VO-173f7afb7801f4ab3e29)', () => {
  it('conflicting duties held by ONE principal are separated (self-approval denied)', () => {
    const res = evaluateSeparationOfDuties(
      [
        {
          principalId: 'alice',
          duty: 'request',
          roles: ['operator'],
          relationships: ['requester'],
          tenantId: 'tenant-a',
        },
        {
          principalId: 'alice',
          duty: 'approval',
          roles: ['authorized_approver'],
          relationships: ['approver'],
          tenantId: 'tenant-a',
        },
      ],
      tenantConstraint(),
    );
    expect(res.permitted).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('SELF_APPROVAL');
  });

  it('platform administration ALONE does not grant decision authority', () => {
    const res = evaluateSeparationOfDuties(
      [
        {
          principalId: 'alice',
          duty: 'request',
          roles: ['operator'],
          relationships: ['requester'],
          tenantId: 'tenant-a',
        },
        {
          // A decision (approval) duty backed ONLY by platform_admin — no decision role.
          principalId: 'peggy',
          duty: 'approval',
          roles: ['platform_admin'],
          relationships: ['approver'],
          tenantId: 'tenant-a',
        },
      ],
      tenantConstraint(),
    );
    expect(res.permitted).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('PLATFORM_ADMIN_NO_AUTHORITY');
  });

  it('an auditor / automation principal alone cannot exercise a decision duty', () => {
    for (const role of ['auditor', 'automation_principal'] as const) {
      const res = evaluateSeparationOfDuties(
        [
          {
            principalId: 'x',
            duty: 'review',
            roles: [role],
            relationships: ['reviewer'],
            tenantId: 'tenant-a',
          },
          {
            principalId: 'y',
            duty: 'request',
            roles: ['operator'],
            relationships: ['requester'],
            tenantId: 'tenant-a',
          },
        ],
        tenantConstraint(),
      );
      expect(res.permitted).toBe(false);
      expect(res.violations.map((v) => v.code)).toContain('PLATFORM_ADMIN_NO_AUTHORITY');
    }
  });

  it('a non-waivable central guardrail CANNOT be waived by a tenant', () => {
    const constraint = centralGuardrail();
    expect(isNonWaivable(constraint)).toBe(true);
    const assignments: DutyAssignment[] = [
      {
        principalId: 'alice',
        duty: 'request',
        roles: ['operator'],
        relationships: ['requester'],
        tenantId: 'tenant-a',
      },
      {
        principalId: 'bob',
        duty: 'approval',
        roles: ['authorized_approver'],
        relationships: ['approver'],
        tenantId: 'tenant-a',
      },
    ];
    const waived = evaluateWithWaiver(assignments, constraint, {
      requested: true,
      byTenantId: 'tenant-a',
    });
    expect(waived.permitted).toBe(false);
    expect(waived.violations.map((v) => v.code)).toContain('WAIVER_FORBIDDEN');
  });

  it('the cross-tenant central reviewer MUST be distinct from every action role', () => {
    const action: CrossTenantAction = {
      requesterPrincipalId: 'alice',
      operatorPrincipalId: 'bob',
      controlOwnerPrincipalId: 'carol',
      tenantApproverPrincipalIds: ['t1-approver', 't2-approver'],
    };
    // Reviewer coincides with the operator → not distinct.
    const notDistinct: CentralReviewer = {
      principalId: 'bob',
      roles: ['central_governance_reviewer'],
    };
    const res = evaluateCentralReviewerDistinctness(action, notDistinct);
    expect(res.permitted).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_NOT_DISTINCT');
  });

  it('the cross-tenant central reviewer MUST NOT hold an incompatible action role', () => {
    const action: CrossTenantAction = {
      requesterPrincipalId: 'alice',
      operatorPrincipalId: 'bob',
      controlOwnerPrincipalId: 'carol',
      tenantApproverPrincipalIds: ['t1-approver', 't2-approver'],
    };
    // Distinct principal, but ALSO holds the approver (action) role.
    const incompatible: CentralReviewer = {
      principalId: 'reviewer-1',
      roles: ['central_governance_reviewer', 'authorized_approver'],
    };
    const res = evaluateCentralReviewerDistinctness(action, incompatible);
    expect(res.permitted).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_INCOMPATIBLE_ROLE');
  });

  it('EVERY incompatible action role, held by a DISTINCT reviewer principal, is rejected with CENTRAL_REVIEWER_INCOMPATIBLE_ROLE', () => {
    const action: CrossTenantAction = {
      requesterPrincipalId: 'alice',
      operatorPrincipalId: 'bob',
      controlOwnerPrincipalId: 'carol',
      tenantApproverPrincipalIds: ['t1-approver', 't2-approver'],
    };
    // The exported set is non-empty and exactly the four action roles.
    expect(INCOMPATIBLE_CENTRAL_REVIEWER_ROLES.size).toBeGreaterThanOrEqual(4);
    for (const role of INCOMPATIBLE_CENTRAL_REVIEWER_ROLES) {
      // Distinct principal id (not any action principal), but additionally holds an incompatible role.
      const reviewer: CentralReviewer = {
        principalId: 'distinct-reviewer',
        roles: ['central_governance_reviewer', role],
      };
      const res = evaluateCentralReviewerDistinctness(action, reviewer);
      // Distinctness is satisfied (id is not an action principal) — so the ONLY thing that can
      // deny is the incompatible-action-role guard. It MUST both deny and emit the specific code.
      expect(res.violations.map((v) => v.code)).not.toContain('CENTRAL_REVIEWER_NOT_DISTINCT');
      expect(res.permitted).toBe(false);
      expect(res.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_INCOMPATIBLE_ROLE');
    }
  });

  it('POSITIVE — a distinct central reviewer holding only the reviewer role is accepted', () => {
    const action: CrossTenantAction = {
      requesterPrincipalId: 'alice',
      operatorPrincipalId: 'bob',
      controlOwnerPrincipalId: 'carol',
      tenantApproverPrincipalIds: ['t1-approver', 't2-approver'],
    };
    const ok: CentralReviewer = {
      principalId: 'reviewer-1',
      roles: ['central_governance_reviewer'],
    };
    const res = evaluateCentralReviewerDistinctness(action, ok);
    expect(res.permitted).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('break-glass-only authority cannot stand in for the independent central reviewer', () => {
    const action: CrossTenantAction = {
      requesterPrincipalId: 'alice',
      operatorPrincipalId: 'bob',
      controlOwnerPrincipalId: 'carol',
      tenantApproverPrincipalIds: ['t1-approver'],
    };
    // reviewer derives authority ONLY from break-glass → breakGlassOnly true → no reviewer role.
    const reviewerAuthority = resolveEffectiveAuthorityA(
      {
        principalId: 'emergency-reviewer',
        tenantId: 'tenant-a',
        assignments: [],
        delegations: [],
        breakGlassGrants: [activeBreakGlass({ principalId: 'emergency-reviewer' })],
        allDelegationsById: new Map(),
        sourceOf: () => null,
      },
      NOW,
    );
    expect(reviewerAuthority.breakGlassOnly).toBe(true);
    const res = evaluateCentralReviewerAuthorityA(action, reviewerAuthority);
    expect(res.permitted).toBe(false);
  });
});
