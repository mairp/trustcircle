// @trustcircle/application — FEDERATED JOINT DECISIONS (Phase 4 / User Story 2 / FR-013, AC6).
//
// A cross-tenant governed action cannot be approved by one tenant alone. When an action affects
// N tenants, EVERY affected tenant must contribute a current, first-party approval, AND a central
// guardrail set must hold, AND an INDEPENDENT central reviewer — distinct from every requester,
// operator, control owner, and tenant approver, and holding no incompatible action role — must
// approve. Only when all three hold does the joint package advance to `approved`; otherwise it
// stays `collecting`/`central_review` and the action is refused. This is the executable form of
// "tenant approval + central guardrails" from the checkpoint.
//
// This is a THIN coordinator over @trustcircle/authz and @trustcircle/domain. The reviewer
// distinctness/role verdict comes from `evaluateCentralReviewerAuthority` (the SoD source of truth);
// the central guardrail requirements (non-waivable, tenantId === null) come from the domain package;
// this module only assembles the per-tenant tally, checks completeness, and computes the next
// central_state. It NEVER re-implements the distinctness rule. Fail-closed: a missing tenant
// approval, an unsatisfied central guardrail, or a non-independent reviewer keeps the package short
// of `approved`. Determinism: the transition instant is injected.

import {
  isCentralGuardrail,
  type DecisionPackage,
  type DecisionRequirement,
  type JointDecisionPackage,
  type JointCentralState,
} from '@trustcircle/domain';
import { type Uuid, type EpochMillis } from '@trustcircle/domain';
import {
  evaluateCentralReviewerAuthority,
  type CrossTenantAction,
  type EffectiveAuthority,
  type SoDEvaluation,
} from '@trustcircle/authz';

/** One affected tenant's first-party approval contribution. */
export interface TenantApproval {
  readonly tenantId: Uuid;
  readonly approverPrincipalId: Uuid;
  /** The package digest this tenant approved against (must equal the current joint digest). */
  readonly packageDigest: string;
  readonly approvedAt: EpochMillis;
}

export type JointBlockReason =
  | 'MISSING_TENANT_APPROVAL'
  | 'STALE_TENANT_APPROVAL'
  | 'CENTRAL_GUARDRAIL_UNSATISFIED'
  | 'REVIEWER_NOT_INDEPENDENT'
  | 'NO_REVIEWER';

export interface JointAssessment {
  /** True iff every gate holds: all tenants approved (current), guardrails satisfied, reviewer OK. */
  readonly complete: boolean;
  readonly nextState: JointCentralState;
  readonly blockingReasons: readonly JointBlockReason[];
  /** Affected tenants still missing a current approval. */
  readonly missingTenantIds: readonly Uuid[];
  /** The central reviewer SoD verdict (null if no reviewer was supplied). */
  readonly reviewerEvaluation: SoDEvaluation | null;
}

/** The non-waivable central guardrail requirements on a package (tenantId === null). */
export function centralGuardrails(pkg: DecisionPackage): readonly DecisionRequirement[] {
  return pkg.requirements.filter(isCentralGuardrail);
}

/** True iff every central guardrail requirement is satisfied (fail-closed on any non-satisfied). */
export function centralGuardrailsSatisfied(pkg: DecisionPackage): boolean {
  const gs = centralGuardrails(pkg);
  return gs.length > 0 ? gs.every((g) => g.status === 'satisfied') : true;
}

/**
 * Assess a joint decision at `now`. Every affected tenant must have an approval whose digest matches
 * the current joint package digest; every central guardrail must be satisfied; and the central
 * reviewer must pass the independence/role SoD check. The result is fail-closed: any single failing
 * gate blocks advancement and names why.
 */
export function assessJointDecision(input: {
  readonly pkg: DecisionPackage;
  readonly joint: JointDecisionPackage;
  readonly tenantApprovals: readonly TenantApproval[];
  readonly crossTenantAction: CrossTenantAction;
  /** The central reviewer's resolved authority; null ⇒ no reviewer supplied yet. */
  readonly reviewerAuthority: EffectiveAuthority | null;
}): JointAssessment {
  const { pkg, joint, tenantApprovals, crossTenantAction, reviewerAuthority } = input;
  const blockingReasons: JointBlockReason[] = [];

  // 1. Every affected tenant must contribute a CURRENT approval (digest matches the joint digest).
  const currentApprovalTenantIds = new Set(
    tenantApprovals.filter((a) => a.packageDigest === joint.packageDigest).map((a) => a.tenantId),
  );
  const staleTenants = tenantApprovals.filter((a) => a.packageDigest !== joint.packageDigest);
  const missingTenantIds = joint.affectedTenantIds.filter((t) => !currentApprovalTenantIds.has(t));
  if (missingTenantIds.length > 0) blockingReasons.push('MISSING_TENANT_APPROVAL');
  if (
    staleTenants.some(
      (a) =>
        joint.affectedTenantIds.includes(a.tenantId) && !currentApprovalTenantIds.has(a.tenantId),
    )
  ) {
    blockingReasons.push('STALE_TENANT_APPROVAL');
  }

  // 2. Central guardrails (non-waivable) must all be satisfied.
  if (!centralGuardrailsSatisfied(pkg)) blockingReasons.push('CENTRAL_GUARDRAIL_UNSATISFIED');

  // 3. An INDEPENDENT central reviewer must approve (SoD source of truth).
  let reviewerEvaluation: SoDEvaluation | null = null;
  if (reviewerAuthority === null) {
    blockingReasons.push('NO_REVIEWER');
  } else {
    reviewerEvaluation = evaluateCentralReviewerAuthority(crossTenantAction, reviewerAuthority);
    if (!reviewerEvaluation.permitted) blockingReasons.push('REVIEWER_NOT_INDEPENDENT');
  }

  const complete = blockingReasons.length === 0;
  const nextState = computeNextState(joint.centralState, complete, missingTenantIds.length === 0);
  return {
    complete,
    nextState,
    blockingReasons: Object.freeze(blockingReasons),
    missingTenantIds: Object.freeze(missingTenantIds),
    reviewerEvaluation,
  };
}

/**
 * Deterministic joint central_state transition. Terminal states (`approved`, `revoked`, `denied`)
 * are absorbing. Otherwise: all gates hold ⇒ `approved`; all tenant approvals in but a gate short
 * ⇒ `central_review`; still gathering ⇒ `collecting`.
 */
export function computeNextState(
  current: JointCentralState,
  allGatesHold: boolean,
  allTenantsApproved: boolean,
): JointCentralState {
  if (current === 'approved' || current === 'revoked' || current === 'denied') return current;
  if (allGatesHold) return 'approved';
  if (allTenantsApproved) return 'central_review';
  return 'collecting';
}
