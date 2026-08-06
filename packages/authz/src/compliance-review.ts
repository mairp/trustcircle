// @trustcircle/authz — INDEPENDENT COMPLIANCE-REVIEW distinctness guard for applicability decisions
// (Phase 7 / User Story 5 — Demonstrate Compliance and Audit Readiness / FR-053, FR-055, SC-022).
//
// Oracle (FR-053): a tenant compliance owner PROPOSES an applicability decision; an INDEPENDENT
// reviewer — distinct from the proposer AND from the affected control owner — must approve it before
// it activates and starts (or stops) driving obligations. This module decides the independence
// verdict ONLY; the applicability lifecycle itself is decided by the application applicability-service,
// and the durable shape/version invariants live in @trustcircle/domain compliance.ts. Keeping this
// verdict here (not in the domain) mirrors decision-authority / separation-of-duties: the domain owns
// SHAPE, authz owns WHO-MAY.
//
// Every guard FAILS CLOSED: a missing/blank reviewer, a reviewer who coincides with the proposer or
// the control owner, a reviewer lacking the independent-reviewer role, or a review action that is not
// a recognised verb, all yield a non-permitted verdict with a typed violation — never a silent pass.
//
// This module is dependency-free (no runtime imports) so it is independently observable and testable
// under `npm ci` with no adjacent infrastructure, and compiles as a strict `composite` project.

// ---------------------------------------------------------------------------
// The review verbs an independent reviewer may take (mirror the domain APPLICABILITY_ACTIONS and the
// governance-api applicability action enum). `approve` is the ONLY verb that may activate a decision.
// ---------------------------------------------------------------------------

export type ComplianceReviewAction = 'approve' | 'reject' | 'request_changes' | 'expire';

export const COMPLIANCE_REVIEW_ACTIONS: readonly ComplianceReviewAction[] = [
  'approve',
  'reject',
  'request_changes',
  'expire',
] as const;

/** A role a principal is currently assigned, in the compliance-review vocabulary (subset of authz RoleKey). */
export type ComplianceRoleKey =
  | 'tenant_compliance_owner'
  | 'independent_compliance_reviewer'
  | 'control_owner'
  | 'auditor'
  | 'platform_admin';

/**
 * The proposer / control-owner / reviewer principals for one applicability decision under review.
 * `controlOwnerPrincipalId` is the owner of the control(s) the decision would activate obligations
 * over — the reviewer must be independent of them as well as of the proposer (FR-053).
 */
export interface ApplicabilityReviewContext {
  readonly proposerPrincipalId: string;
  /** The affected control owner, if any. The reviewer must be distinct from this principal too. */
  readonly controlOwnerPrincipalId: string | null;
  readonly reviewerPrincipalId: string;
  readonly reviewerRoles: readonly ComplianceRoleKey[];
  readonly action: ComplianceReviewAction;
}

export type ComplianceReviewViolationCode =
  | 'REVIEWER_MISSING' // no reviewer principal supplied
  | 'REVIEWER_IS_PROPOSER' // the reviewer coincides with the proposer (not independent)
  | 'REVIEWER_IS_CONTROL_OWNER' // the reviewer coincides with the affected control owner
  | 'REVIEWER_NOT_INDEPENDENT_ROLE' // the reviewer lacks the independent-reviewer role
  | 'REVIEWER_INCOMPATIBLE_ROLE' // the reviewer also holds proposer / control-owner authority
  | 'UNKNOWN_ACTION'; // the review action is not a recognised verb

export interface ComplianceReviewViolation {
  readonly code: ComplianceReviewViolationCode;
  readonly message: string;
  readonly principals: readonly string[];
}

export interface ComplianceReviewEvaluation {
  readonly permitted: boolean;
  /** True iff the (permitted) action is `approve` — the only verb that may ACTIVATE the decision. */
  readonly activates: boolean;
  readonly violations: readonly ComplianceReviewViolation[];
}

/** Roles that are INCOMPATIBLE with acting as the independent applicability reviewer (FR-053). */
export const INCOMPATIBLE_REVIEWER_ROLES: ReadonlySet<ComplianceRoleKey> =
  new Set<ComplianceRoleKey>([
    'tenant_compliance_owner', // the proposing role — cannot independently review its own proposal
    'control_owner', // owns the affected control — not independent of it
  ]);

function blank(s: string | null | undefined): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

/**
 * Decide whether `ctx.reviewerPrincipalId` may independently review the applicability decision, and
 * whether that review ACTIVATES it. Fails closed: any distinctness/role/verb problem is a typed
 * violation and `permitted` is false. Only an `approve` by a permitted, independent reviewer sets
 * `activates: true` — matching the domain `makeApplicabilityDecision` activation invariant so the two
 * layers agree.
 */
export function evaluateApplicabilityReview(
  ctx: ApplicabilityReviewContext,
): ComplianceReviewEvaluation {
  const violations: ComplianceReviewViolation[] = [];

  if (!COMPLIANCE_REVIEW_ACTIONS.includes(ctx.action)) {
    violations.push({
      code: 'UNKNOWN_ACTION',
      message: `review action '${String(ctx.action)}' is not one of ${COMPLIANCE_REVIEW_ACTIONS.join('|')}`,
      principals: [],
    });
  }

  if (blank(ctx.reviewerPrincipalId)) {
    violations.push({
      code: 'REVIEWER_MISSING',
      message:
        'no independent reviewer principal supplied; applicability cannot be activated (FR-053)',
      principals: [],
    });
    // Without a reviewer, no further distinctness check is meaningful.
    return { permitted: false, activates: false, violations };
  }

  if (!blank(ctx.proposerPrincipalId) && ctx.reviewerPrincipalId === ctx.proposerPrincipalId) {
    violations.push({
      code: 'REVIEWER_IS_PROPOSER',
      message: `reviewer '${ctx.reviewerPrincipalId}' is the proposer; an applicability decision cannot be self-reviewed (FR-053)`,
      principals: [ctx.reviewerPrincipalId],
    });
  }

  if (
    !blank(ctx.controlOwnerPrincipalId) &&
    ctx.reviewerPrincipalId === ctx.controlOwnerPrincipalId
  ) {
    violations.push({
      code: 'REVIEWER_IS_CONTROL_OWNER',
      message: `reviewer '${ctx.reviewerPrincipalId}' owns the affected control; reviewer must be independent of the control owner (FR-053)`,
      principals: [ctx.reviewerPrincipalId],
    });
  }

  if (!ctx.reviewerRoles.includes('independent_compliance_reviewer')) {
    violations.push({
      code: 'REVIEWER_NOT_INDEPENDENT_ROLE',
      message: `reviewer '${ctx.reviewerPrincipalId}' is not assigned the independent_compliance_reviewer role`,
      principals: [ctx.reviewerPrincipalId],
    });
  }

  for (const role of ctx.reviewerRoles) {
    if (INCOMPATIBLE_REVIEWER_ROLES.has(role)) {
      violations.push({
        code: 'REVIEWER_INCOMPATIBLE_ROLE',
        message: `reviewer '${ctx.reviewerPrincipalId}' also holds incompatible role '${role}' (proposer/control-owner authority)`,
        principals: [ctx.reviewerPrincipalId],
      });
    }
  }

  const permitted = violations.length === 0;
  return { permitted, activates: permitted && ctx.action === 'approve', violations };
}
