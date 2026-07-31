// @trustcircle/authz — non-waivable Separation-of-Duties (SoD) guards
// (T043 / GAR-003 / VO-173f7afb7801f4ab3e29).
//
// Oracle (VO-173f7afb7801f4ab3e29): Request, review, approval, execution, evidence
// administration, control ownership, and assurance MUST be separated where conflicts
// exist; platform administration alone MUST NOT grant decision authority, and the
// independent central reviewer for a cross-tenant action MUST NOT hold an incompatible
// action role.
//
// This module is dependency-free (no runtime imports) so it is independently observable
// and testable under `npm ci` with no adjacent infrastructure. It compiles under the
// strict shared base (tsconfig.base.json) as a `composite` project. It implements the
// four guards named in T043 and mirrors specs/001-governance-control-plane/data-model.md
// §SoDConstraint / §DecisionRecord / §JointDecisionPackage and spec.md §"Roles and
// Authority Boundaries":
//
//   1. Duty separation — a single principal may not hold two conflicting duties for the
//      same action (self-approval and incompatible-relationship guards).
//   2. Non-waivable central guardrails — a constraint with `tenantId === null` cannot be
//      waived by any tenant-level override.
//   3. Minimum-distinct-principals — an independently reviewed action needs at least the
//      configured number of DISTINCT human principals across its filled duties.
//   4. Platform administration alone grants no decision authority; and the cross-tenant
//      independent central reviewer must be distinct from — and hold no incompatible role
//      with — the requester, operator, control owner, and tenant approvers.
//
// Every guard fails CLOSED: unknown, missing, or ambiguous input yields a violation, never
// a silent pass.

// ---------------------------------------------------------------------------
// Duties, roles, and relationships (structural — downstream packages widen freely).
// ---------------------------------------------------------------------------

/**
 * The seven conflictable duties from GAR-003. A principal filling one of these for a given
 * action must be separated from the conflicting others "where conflicts exist".
 */
export type Duty =
  | 'request'
  | 'review'
  | 'approval'
  | 'execution'
  | 'evidence_administration'
  | 'control_ownership'
  | 'assurance';

export const ALL_DUTIES: readonly Duty[] = [
  'request',
  'review',
  'approval',
  'execution',
  'evidence_administration',
  'control_ownership',
  'assurance',
] as const;

/**
 * Pairs of duties that conflict and therefore MUST be held by distinct principals when both
 * are present for the same action. Symmetric closure is applied by {@link dutiesConflict}.
 * This encodes GAR-003's "separated where conflicts exist": e.g. you cannot both request and
 * approve, execute and approve, or administer the evidence you rely on to approve.
 */
const CONFLICTING_DUTY_PAIRS: ReadonlyArray<readonly [Duty, Duty]> = [
  ['request', 'approval'],
  ['request', 'review'],
  ['execution', 'approval'],
  ['execution', 'review'],
  ['approval', 'assurance'],
  ['review', 'assurance'],
  ['control_ownership', 'assurance'],
  ['control_ownership', 'review'],
  ['evidence_administration', 'approval'],
  ['evidence_administration', 'review'],
  ['evidence_administration', 'assurance'],
];

/** True iff the two duties conflict (order-independent). A duty never conflicts with itself. */
export function dutiesConflict(a: Duty, b: Duty): boolean {
  if (a === b) return false;
  return CONFLICTING_DUTY_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/** Relationships a principal can bear to an action (data-model.md SoDConstraint.incompatible_relationships). */
export type Relationship =
  'requester' | 'owner' | 'executor' | 'custodian' | 'reviewer' | 'approver';

/**
 * A role a principal is currently assigned. `PLATFORM_ADMIN` is called out explicitly because
 * of GAR-003's rule that platform administration alone grants NO decision authority.
 */
export type RoleKey =
  | 'governance_officer'
  | 'control_owner'
  | 'auditor'
  | 'operator'
  | 'authorized_approver'
  | 'central_governance_reviewer'
  | 'tenant_compliance_owner'
  | 'independent_compliance_reviewer'
  | 'source_steward'
  | 'platform_admin'
  | 'automation_principal';

/** Roles that carry NO governance decision authority on their own (GAR-003, spec.md role table). */
export const NON_DECISION_ROLES: ReadonlySet<RoleKey> = new Set<RoleKey>([
  'platform_admin',
  'auditor', // read-only
  'automation_principal', // cannot approve its own work / grant itself authority
]);

/**
 * A duty assignment: principal `principalId` fills `duty` for the action, arriving with the
 * given `roles` and `relationships`. `tenantId` scopes tenant approvers.
 */
export interface DutyAssignment {
  readonly principalId: string;
  readonly duty: Duty;
  readonly roles: readonly RoleKey[];
  readonly relationships: readonly Relationship[];
  readonly tenantId: string | null;
}

/**
 * The SoD constraint applicable to an action (data-model.md §SoDConstraint).
 * `tenantId === null` marks a NON-WAIVABLE central guardrail.
 */
export interface SoDConstraint {
  readonly sodConstraintId: string;
  /** Null ONLY for a non-waivable central guardrail. */
  readonly tenantId: string | null;
  readonly actionClass: string;
  readonly incompatibleRoles: readonly RoleKey[];
  readonly incompatibleRelationships: readonly Relationship[];
  /** At least 2 for independently reviewed actions. */
  readonly minimumDistinctPrincipals: number;
  readonly status: 'active' | 'draft' | 'retired';
}

/** True iff this constraint is a non-waivable central guardrail (tenantId === null). */
export function isNonWaivable(constraint: SoDConstraint): boolean {
  return constraint.tenantId === null;
}

// ---------------------------------------------------------------------------
// Violations & result. Fail-closed: any problem is a typed violation.
// ---------------------------------------------------------------------------

export type ViolationCode =
  | 'SELF_APPROVAL' // one principal holds two conflicting duties
  | 'INCOMPATIBLE_RELATIONSHIP' // principal bears a forbidden relationship for their duty
  | 'INCOMPATIBLE_ROLE' // principal holds a role the constraint forbids for the action
  | 'INSUFFICIENT_DISTINCT_PRINCIPALS' // fewer distinct principals than required
  | 'PLATFORM_ADMIN_NO_AUTHORITY' // decision duty backed only by non-decision role(s)
  | 'CENTRAL_REVIEWER_NOT_DISTINCT' // cross-tenant central reviewer coincides with an action role
  | 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE' // cross-tenant central reviewer holds an incompatible action role
  | 'WAIVER_FORBIDDEN'; // attempt to waive a non-waivable central guardrail

export interface Violation {
  readonly code: ViolationCode;
  readonly message: string;
  /** Principals implicated (for audit / rejected-attempt records). */
  readonly principals: readonly string[];
}

export interface SoDEvaluation {
  readonly permitted: boolean;
  readonly violations: readonly Violation[];
}

/** The duties considered "decision authority" for the platform-admin-alone rule. */
const DECISION_DUTIES: ReadonlySet<Duty> = new Set<Duty>(['approval', 'review', 'assurance']);

// ---------------------------------------------------------------------------
// Guard 1 — self-approval / incompatible-duty: no principal holds two conflicting duties.
// ---------------------------------------------------------------------------

function checkSelfApproval(assignments: readonly DutyAssignment[]): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const a = assignments[i]!;
      const b = assignments[j]!;
      if (a.principalId === b.principalId && dutiesConflict(a.duty, b.duty)) {
        violations.push({
          code: 'SELF_APPROVAL',
          message: `principal '${a.principalId}' holds conflicting duties '${a.duty}' and '${b.duty}' for the same action`,
          principals: [a.principalId],
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Guard 2 — incompatible-relationship: a principal's relationships must not be forbidden
// for the duty they fill.
// ---------------------------------------------------------------------------

/** Relationships that are incompatible with holding a review/approval/assurance duty. */
const DUTY_FORBIDDEN_RELATIONSHIPS: Partial<Record<Duty, readonly Relationship[]>> = {
  approval: ['requester', 'executor', 'owner'],
  review: ['requester', 'executor', 'owner'],
  assurance: ['requester', 'executor', 'owner', 'custodian'],
};

function checkIncompatibleRelationships(
  assignments: readonly DutyAssignment[],
  constraint: SoDConstraint,
): Violation[] {
  const violations: Violation[] = [];
  for (const a of assignments) {
    // Constraint-declared incompatible relationships apply to every filled duty.
    for (const rel of a.relationships) {
      if (constraint.incompatibleRelationships.includes(rel)) {
        violations.push({
          code: 'INCOMPATIBLE_RELATIONSHIP',
          message: `principal '${a.principalId}' bears relationship '${rel}' forbidden by constraint '${constraint.sodConstraintId}'`,
          principals: [a.principalId],
        });
      }
    }
    // Duty-intrinsic forbidden relationships (a reviewer cannot also be the requester, etc.).
    const forbidden = DUTY_FORBIDDEN_RELATIONSHIPS[a.duty] ?? [];
    for (const rel of a.relationships) {
      if (forbidden.includes(rel)) {
        violations.push({
          code: 'INCOMPATIBLE_RELATIONSHIP',
          message: `principal '${a.principalId}' fills '${a.duty}' while holding incompatible relationship '${rel}'`,
          principals: [a.principalId],
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Guard 3 — incompatible-role: constraint-forbidden roles, and platform-admin-alone.
// ---------------------------------------------------------------------------

function checkRoles(
  assignments: readonly DutyAssignment[],
  constraint: SoDConstraint,
): Violation[] {
  const violations: Violation[] = [];
  for (const a of assignments) {
    for (const role of a.roles) {
      if (constraint.incompatibleRoles.includes(role)) {
        violations.push({
          code: 'INCOMPATIBLE_ROLE',
          message: `principal '${a.principalId}' holds role '${role}' forbidden for action class '${constraint.actionClass}'`,
          principals: [a.principalId],
        });
      }
    }
    // Platform administration alone MUST NOT grant decision authority (GAR-003).
    if (DECISION_DUTIES.has(a.duty)) {
      const hasDecisionRole = a.roles.some((r) => !NON_DECISION_ROLES.has(r));
      if (a.roles.length === 0 || !hasDecisionRole) {
        violations.push({
          code: 'PLATFORM_ADMIN_NO_AUTHORITY',
          message: `principal '${a.principalId}' fills decision duty '${a.duty}' backed only by non-decision role(s) [${a.roles.join(', ') || 'none'}]`,
          principals: [a.principalId],
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Guard 4 — minimum distinct principals.
// ---------------------------------------------------------------------------

function checkDistinctPrincipals(
  assignments: readonly DutyAssignment[],
  constraint: SoDConstraint,
): Violation[] {
  const required = Math.max(1, Math.trunc(constraint.minimumDistinctPrincipals));
  const distinct = new Set(assignments.map((a) => a.principalId));
  if (distinct.size < required) {
    return [
      {
        code: 'INSUFFICIENT_DISTINCT_PRINCIPALS',
        message: `action requires at least ${required} distinct principals but only ${distinct.size} present`,
        principals: [...distinct],
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API — evaluate the full SoD constraint over an action's duty assignments.
// ---------------------------------------------------------------------------

/**
 * Evaluate every SoD guard for one action. Returns `permitted: false` with the accumulated
 * violations when ANY guard fails. Fails closed on empty input (no assignments => cannot be
 * independently reviewed).
 */
export function evaluateSeparationOfDuties(
  assignments: readonly DutyAssignment[],
  constraint: SoDConstraint,
): SoDEvaluation {
  const violations: Violation[] = [];
  if (assignments.length === 0) {
    violations.push({
      code: 'INSUFFICIENT_DISTINCT_PRINCIPALS',
      message: 'no duty assignments supplied; action cannot be independently reviewed',
      principals: [],
    });
    return { permitted: false, violations };
  }
  violations.push(...checkSelfApproval(assignments));
  violations.push(...checkIncompatibleRelationships(assignments, constraint));
  violations.push(...checkRoles(assignments, constraint));
  violations.push(...checkDistinctPrincipals(assignments, constraint));
  return { permitted: violations.length === 0, violations };
}

/**
 * A tenant-scoped override is only honoured when the constraint is waivable. Attempting to
 * waive a non-waivable central guardrail (tenantId === null) is itself a violation — the
 * result is NEVER permitted regardless of the underlying evaluation.
 */
export function evaluateWithWaiver(
  assignments: readonly DutyAssignment[],
  constraint: SoDConstraint,
  waiver: { readonly requested: boolean; readonly byTenantId: string | null },
): SoDEvaluation {
  const base = evaluateSeparationOfDuties(assignments, constraint);
  if (!waiver.requested) return base;
  if (isNonWaivable(constraint)) {
    return {
      permitted: false,
      violations: [
        ...base.violations,
        {
          code: 'WAIVER_FORBIDDEN',
          message: `constraint '${constraint.sodConstraintId}' is a non-waivable central guardrail and cannot be waived by tenant '${waiver.byTenantId ?? 'unknown'}'`,
          principals: [],
        },
      ],
    };
  }
  // Waivable constraint: a granted waiver clears violations for this tenant scope.
  return { permitted: true, violations: [] };
}

// ---------------------------------------------------------------------------
// Cross-tenant independent central reviewer distinctness (GAR-003 / spec.md role table /
// data-model.md JointDecisionPackage.central_reviewer_decision_id).
// ---------------------------------------------------------------------------

export interface CrossTenantAction {
  readonly requesterPrincipalId: string;
  readonly operatorPrincipalId: string | null;
  readonly controlOwnerPrincipalId: string | null;
  /** One approver principal per affected tenant. */
  readonly tenantApproverPrincipalIds: readonly string[];
}

export interface CentralReviewer {
  readonly principalId: string;
  readonly roles: readonly RoleKey[];
}

/**
 * The independent central reviewer for a cross-tenant action MUST be distinct from the
 * requester, operator, control owner, and every tenant approver, and MUST NOT hold an
 * incompatible action role (approver/operator/owner). Fails closed.
 */
export function evaluateCentralReviewerDistinctness(
  action: CrossTenantAction,
  reviewer: CentralReviewer,
): SoDEvaluation {
  const violations: Violation[] = [];
  const actionPrincipals = new Set<string>(
    [
      action.requesterPrincipalId,
      action.operatorPrincipalId,
      action.controlOwnerPrincipalId,
      ...action.tenantApproverPrincipalIds,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0),
  );

  if (actionPrincipals.has(reviewer.principalId)) {
    violations.push({
      code: 'CENTRAL_REVIEWER_NOT_DISTINCT',
      message: `central reviewer '${reviewer.principalId}' also holds an action role (requester/operator/owner/tenant approver) for the cross-tenant action`,
      principals: [reviewer.principalId],
    });
  }

  // The reviewer must not hold an incompatible action role even under a different principal id.
  const INCOMPATIBLE_REVIEWER_ROLES: ReadonlySet<RoleKey> = new Set<RoleKey>([
    'authorized_approver',
    'operator',
    'control_owner',
    'automation_principal',
  ]);
  for (const role of reviewer.roles) {
    if (INCOMPATIBLE_REVIEWER_ROLES.has(role)) {
      violations.push({
        code: 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE',
        message: `central reviewer '${reviewer.principalId}' holds incompatible action role '${role}'`,
        principals: [reviewer.principalId],
      });
    }
  }

  // A valid central reviewer must actually carry the reviewer role — fail closed otherwise.
  if (!reviewer.roles.includes('central_governance_reviewer')) {
    violations.push({
      code: 'INCOMPATIBLE_ROLE',
      message: `principal '${reviewer.principalId}' is not assigned the central_governance_reviewer role`,
      principals: [reviewer.principalId],
    });
  }

  return { permitted: violations.length === 0, violations };
}
