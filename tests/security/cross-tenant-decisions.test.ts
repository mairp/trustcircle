// Security-suite test — FEDERATED CROSS-TENANT DECISIONS (Phase 4 / User Story 2 / T091 / AC6).
//
// PHASE OBJECTIVE (T091): "Test every affected-tenant approval, central guardrails, independent
// central review, revocation, and evidence isolation in tests/security/cross-tenant-decisions.test.ts".
//
// A cross-tenant governed action must not advance to `approved` until (1) EVERY affected tenant has
// contributed a CURRENT first-party approval, (2) EVERY non-waivable central guardrail is satisfied,
// and (3) an INDEPENDENT central reviewer — distinct from every requester/operator/owner/tenant
// approver and holding no incompatible action role — has approved. This suite proves each of those
// gates fails CLOSED in isolation (one defect at a time, each paired with a positive control that
// SHOULD pass), that a revoked joint package cannot re-advance, and that the assessment never routes
// or leaks one tenant's approval into another tenant's scope (evidence isolation).
//
// It exercises the REAL application coordinator (assessJointDecision) over the REAL authz SoD source
// of truth (evaluateCentralReviewerAuthority) — no guard is re-implemented. Determinism: one fixed
// injected instant (NOW); no Math.random / argless Date. Run via `vitest run --project security`.

import { describe, it, expect } from 'vitest';

import {
  assessJointDecision,
  centralGuardrails,
  centralGuardrailsSatisfied,
  type TenantApproval,
} from '../../packages/application/src/joint-decisions.ts';

import {
  makeDecisionPackage,
  makeDecisionRequirement,
  makeJointDecisionPackage,
  decisionPackageDigest,
  type DecisionPackage,
  type DecisionRequirement,
  type JointDecisionPackage,
} from '../../packages/domain/src/decisions.ts';

import {
  resolveEffectiveAuthority,
  type AuthorityInputs,
  type RoleAssignment,
  type EffectiveAuthority,
} from '../../packages/authz/src/authority.ts';
import { type CrossTenantAction } from '../../packages/authz/src/separation-of-duties.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Fixed UUIDs (deterministic, no id generation at module scope).
const DEC_TENANT = '00000000-0000-4000-8000-0000000000a0';
const TENANT_X = '00000000-0000-4000-8000-0000000000b1';
const TENANT_Y = '00000000-0000-4000-8000-0000000000b2';
const WORK_ITEM = '00000000-0000-4000-8000-0000000000c0';
const REQUESTER = '00000000-0000-4000-8000-0000000000d0';
const APPROVER_X = '00000000-0000-4000-8000-0000000000d1';
const APPROVER_Y = '00000000-0000-4000-8000-0000000000d2';
const REVIEWER = '00000000-0000-4000-8000-0000000000e0';
const GUARDRAIL_ID = '00000000-0000-4000-8000-0000000000f0';
const JOINT_ID = '00000000-0000-4000-8000-000000000f01';
const DEC_ID = '00000000-0000-4000-8000-000000000f02';

function centralGuardrailReq(status: DecisionRequirement['status']): DecisionRequirement {
  return makeDecisionRequirement({
    id: GUARDRAIL_ID,
    gateType: 'central_guardrail',
    tenantId: null, // non-waivable central guardrail
    status,
    minimumDistinctPrincipals: 1,
  });
}

function pkg(over: { requirements?: readonly DecisionRequirement[] } = {}): DecisionPackage {
  return makeDecisionPackage({
    id: DEC_ID,
    tenantId: DEC_TENANT,
    workItemId: WORK_ITEM,
    requesterPrincipalId: REQUESTER,
    requestedAction: 'promote_release',
    actionClass: 'cross-tenant-change',
    riskTier: 'high',
    scope: { environment: 'prod' },
    businessImpact: { revenue: 'material' },
    risks: [{ kind: 'availability', severity: 'high' }],
    alternatives: [{ kind: 'defer' }],
    expectedResult: { outcome: 'released' },
    affectedTenantIds: [TENANT_X, TENANT_Y],
    requirements: over.requirements ?? [centralGuardrailReq('satisfied')],
    createdAt: NOW - DAY,
    expiresAt: NOW + DAY,
  });
}

function joint(digest: string): JointDecisionPackage {
  return makeJointDecisionPackage({
    id: JOINT_ID,
    tenantId: DEC_TENANT,
    decisionId: DEC_ID,
    affectedTenantIds: [TENANT_X, TENANT_Y],
    packageDigest: digest,
    centralState: 'collecting',
    createdAt: NOW - DAY,
    updatedAt: NOW - HOUR,
  });
}

function approval(tenantId: string, approver: string, digest: string): TenantApproval {
  return {
    tenantId: tenantId as TenantApproval['tenantId'],
    approverPrincipalId: approver as TenantApproval['approverPrincipalId'],
    packageDigest: digest,
    approvedAt: NOW - HOUR,
  };
}

/** Resolve a principal's effective authority from a single active assignment carrying `roles`. */
function authorityWith(principalId: string, role: RoleAssignment['role']): EffectiveAuthority {
  const ra: RoleAssignment = {
    roleAssignmentId: `ra-${principalId}`,
    tenantId: DEC_TENANT,
    principalId,
    role,
    scope: { scopeType: 'organization', scopeId: 'org-1', allowedActions: ['approve'] },
    validFrom: NOW - DAY,
    expiresAt: NOW + DAY,
    status: 'active',
    nextRecertificationAt: NOW + 30 * DAY,
    lastRecertifiedAt: NOW - DAY,
  };
  const inputs: AuthorityInputs = {
    principalId,
    tenantId: DEC_TENANT,
    assignments: [ra],
    delegations: [],
    breakGlassGrants: [],
    allDelegationsById: new Map(),
    sourceOf: () => null,
  };
  return resolveEffectiveAuthority(inputs, NOW);
}

function crossTenantAction(over: Partial<CrossTenantAction> = {}): CrossTenantAction {
  return {
    requesterPrincipalId: REQUESTER,
    operatorPrincipalId: null,
    controlOwnerPrincipalId: null,
    tenantApproverPrincipalIds: [APPROVER_X, APPROVER_Y],
    ...over,
  };
}

describe('T091 — federated cross-tenant decision (AC6): all gates fail closed', () => {
  it('POSITIVE control: all tenants approved + guardrail satisfied + independent reviewer ⇒ approved', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const digest = j.packageDigest;
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, digest),
        approval(TENANT_Y, APPROVER_Y, digest),
      ],
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: authorityWith(REVIEWER, 'central_governance_reviewer'),
    });
    expect(result.complete).toBe(true);
    expect(result.nextState).toBe('approved');
    expect(result.blockingReasons).toEqual([]);
    expect(result.missingTenantIds).toEqual([]);
  });

  it('a MISSING affected-tenant approval blocks advancement (not approved)', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [approval(TENANT_X, APPROVER_X, j.packageDigest)], // Y missing
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: authorityWith(REVIEWER, 'central_governance_reviewer'),
    });
    expect(result.complete).toBe(false);
    expect(result.nextState).not.toBe('approved');
    expect(result.blockingReasons).toContain('MISSING_TENANT_APPROVAL');
    expect(result.missingTenantIds).toContain(TENANT_Y);
  });

  it('a STALE tenant approval (wrong digest) does not count as current', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, j.packageDigest),
        approval(TENANT_Y, APPROVER_Y, 'STALE-DIGEST'),
      ],
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: authorityWith(REVIEWER, 'central_governance_reviewer'),
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReasons).toContain('STALE_TENANT_APPROVAL');
    expect(result.missingTenantIds).toContain(TENANT_Y);
  });

  it('an UNSATISFIED central guardrail blocks advancement even with all tenant approvals', () => {
    const p = pkg({ requirements: [centralGuardrailReq('pending')] });
    const j = joint(digestOf(p));
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, j.packageDigest),
        approval(TENANT_Y, APPROVER_Y, j.packageDigest),
      ],
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: authorityWith(REVIEWER, 'central_governance_reviewer'),
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReasons).toContain('CENTRAL_GUARDRAIL_UNSATISFIED');
  });

  it('a NON-INDEPENDENT reviewer (also a tenant approver) is rejected by the SoD source of truth', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, j.packageDigest),
        approval(TENANT_Y, APPROVER_Y, j.packageDigest),
      ],
      // reviewer principal is APPROVER_X — also a tenant approver ⇒ not distinct.
      crossTenantAction: crossTenantAction({ tenantApproverPrincipalIds: [APPROVER_X, APPROVER_Y] }),
      reviewerAuthority: authorityWith(APPROVER_X, 'central_governance_reviewer'),
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReasons).toContain('REVIEWER_NOT_INDEPENDENT');
    expect(result.reviewerEvaluation?.permitted).toBe(false);
  });

  it('a reviewer holding an INCOMPATIBLE action role is rejected even under a distinct principal', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, j.packageDigest),
        approval(TENANT_Y, APPROVER_Y, j.packageDigest),
      ],
      crossTenantAction: crossTenantAction(),
      // Distinct principal, but carries the approver role — incompatible with central review.
      reviewerAuthority: authorityWith(REVIEWER, 'authorized_approver'),
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReasons).toContain('REVIEWER_NOT_INDEPENDENT');
  });

  it('NO reviewer supplied blocks advancement (emergency access can never stand in)', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, j.packageDigest),
        approval(TENANT_Y, APPROVER_Y, j.packageDigest),
      ],
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: null,
    });
    expect(result.complete).toBe(false);
    expect(result.blockingReasons).toContain('NO_REVIEWER');
  });

  it('a REVOKED joint package is absorbing — it cannot re-advance to approved', () => {
    const p = pkg();
    const revoked = makeJointDecisionPackage({
      id: JOINT_ID,
      tenantId: DEC_TENANT,
      decisionId: DEC_ID,
      affectedTenantIds: [TENANT_X, TENANT_Y],
      packageDigest: digestOf(p),
      centralState: 'revoked',
      createdAt: NOW - DAY,
      updatedAt: NOW - HOUR,
      revokedAt: NOW - HOUR,
    });
    const result = assessJointDecision({
      pkg: p,
      joint: revoked,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, revoked.packageDigest),
        approval(TENANT_Y, APPROVER_Y, revoked.packageDigest),
      ],
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: authorityWith(REVIEWER, 'central_governance_reviewer'),
    });
    expect(result.nextState).toBe('revoked');
  });

  it('EVIDENCE ISOLATION: an approval from an UNRELATED tenant is never counted for an affected tenant', () => {
    const p = pkg();
    const j = joint(digestOf(p));
    const UNRELATED = '00000000-0000-4000-8000-000000000bbb';
    const result = assessJointDecision({
      pkg: p,
      joint: j,
      tenantApprovals: [
        approval(TENANT_X, APPROVER_X, j.packageDigest),
        // An approval scoped to an unrelated tenant must not satisfy TENANT_Y.
        approval(UNRELATED, APPROVER_Y, j.packageDigest),
      ],
      crossTenantAction: crossTenantAction(),
      reviewerAuthority: authorityWith(REVIEWER, 'central_governance_reviewer'),
    });
    expect(result.missingTenantIds).toContain(TENANT_Y);
    expect(result.complete).toBe(false);
  });

  it('central-guardrail helpers surface the non-waivable requirement set', () => {
    const p = pkg({ requirements: [centralGuardrailReq('pending')] });
    expect(centralGuardrails(p)).toHaveLength(1);
    expect(centralGuardrailsSatisfied(p)).toBe(false);
    const p2 = pkg({ requirements: [centralGuardrailReq('satisfied')] });
    expect(centralGuardrailsSatisfied(p2)).toBe(true);
  });
});

// digest helper — the joint package binds to the CURRENT decision-package digest.
function digestOf(p: DecisionPackage): string {
  return decisionPackageDigest(p);
}
