// @trustcircle/policy — NORMALIZED PDP INPUT BUILDER (Phase 4 / User Story 2 / FR-010, FR-013,
// FR-014, FR-015, VO-173f7afb7801f4ab3e29).
//
// The Policy Decision Point (`./pdp.ts`) speaks exactly two policies — `separation_of_duties` and
// `central_reviewer_distinctness` — each expecting a precise, typed `input`. Five DIFFERENT
// governed operations must be checked against those two policies before they take effect:
//
//   * a plain DECISION action (approve / deny / …)           → separation_of_duties
//   * a DELEGATION grant (delegator + recipient distinctness)→ separation_of_duties
//   * a federated JOINT REVIEW (cross-tenant reviewer)       → central_reviewer_distinctness
//   * an EXCEPTION / waiver request                          → separation_of_duties (non-waivable aware)
//   * an EMERGENCY (break-glass) authorization               → separation_of_duties
//
// Each operation carries its facts in its own shape (an actor with duties, a delegation lineage, a
// cross-tenant action + reviewer). This module is the NORMALIZER: it turns each operation's native
// facts into the exact `PolicyQuery` (and, at the caller's option, a full pinned `DecisionRequest`)
// the PDP expects — WITHOUT the caller reaching around the port into `@trustcircle/authz` internals.
//
// It re-implements NO policy logic. It only threads the caller's already-resolved authority
// (`EffectiveAuthority`) through the canonical authz bridges (`authorityToDutyAssignment`) into the
// `DutyAssignment[]` / `CrossTenantAction` / `CentralReviewer` the two policies consume. Every
// builder is a PURE function of its inputs (the decision instant is injected on the request); a fact
// that cannot be normalized into a valid query is REFUSED fail-closed (thrown `DecisionInputError`),
// never silently defaulted to a permit-shaped query.

import {
  authorityToDutyAssignment,
  type EffectiveAuthority,
  type DutyAssignment,
  type SoDConstraint,
  type CrossTenantAction,
  type CentralReviewer,
  type Duty,
  type Relationship,
} from '@trustcircle/authz';

import { type PolicyQuery, type DecisionRequest, type EpochMillis } from './pdp.ts';

// Re-export the canonical authz vocabularies so a PDP caller constructs decision inputs against a
// single import surface (the policy package) rather than reaching into @trustcircle/authz directly.
export type { DutyAssignment, SoDConstraint, CrossTenantAction, CentralReviewer, Duty, Relationship };

/** Fail-closed error: a decision fact could not be normalized into a valid PDP query. */
export class DecisionInputError extends Error {
  readonly kind = 'decision_input' as const;
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DecisionInputError';
    this.detail = detail;
  }
}

/** The five governed operation kinds a decision input can normalize. */
export const DECISION_INPUT_KINDS = [
  'decision',
  'delegation',
  'joint_review',
  'exception',
  'emergency',
] as const;
export type DecisionInputKind = (typeof DECISION_INPUT_KINDS)[number];

// ---------------------------------------------------------------------------
// One participant in a separation-of-duties evaluation: an already-resolved
// effective authority plus the duty + relationships it is acting under.
// ---------------------------------------------------------------------------

/** A duty-holder: their resolved authority and the duty/relationships they hold for THIS action. */
export interface DecisionActor {
  readonly authority: EffectiveAuthority;
  readonly duty: Duty;
  readonly relationships: readonly Relationship[];
}

/**
 * Project a set of decision actors onto the `DutyAssignment[]` the SoD policy consumes, using the
 * canonical authz bridge. An actor whose authority cannot be projected onto its declared duty (the
 * bridge returns null — e.g. no scope grants the duty) is REFUSED fail-closed: the operation cannot
 * be evaluated with a missing duty-holder, so it must not proceed.
 */
function toDutyAssignments(actors: readonly DecisionActor[]): readonly DutyAssignment[] {
  if (actors.length === 0) {
    throw new DecisionInputError('at least one decision actor is required', { actors: 0 });
  }
  const assignments: DutyAssignment[] = [];
  for (const a of actors) {
    const assignment = authorityToDutyAssignment(a.authority, a.duty, a.relationships);
    if (assignment === null) {
      throw new DecisionInputError('actor authority does not grant its declared duty', {
        principalId: a.authority.principalId,
        duty: a.duty,
      });
    }
    assignments.push(assignment);
  }
  return Object.freeze(assignments);
}

function assertActiveConstraint(constraint: SoDConstraint, context: DecisionInputKind): SoDConstraint {
  if (constraint.status !== 'active') {
    throw new DecisionInputError('separation-of-duties constraint is not active', {
      context,
      status: constraint.status,
    });
  }
  return constraint;
}

// ---------------------------------------------------------------------------
// 1. DECISION action — separation_of_duties over the actor + co-duty-holders.
// ---------------------------------------------------------------------------

export interface DecisionQueryInput {
  readonly actors: readonly DecisionActor[];
  readonly constraint: SoDConstraint;
}

/**
 * Build the `separation_of_duties` query for a plain decision action. The actor and every other
 * duty-holder (owner, executor, custodian, reviewer …) are projected onto duty assignments so the
 * policy can enforce that conflicting duties are separated and that platform-admin alone grants no
 * decision authority (VO-173f7afb7801f4ab3e29). Fail-closed on an inactive constraint or an
 * unprojectable actor.
 */
export function buildDecisionQuery(input: DecisionQueryInput): PolicyQuery {
  const constraint = assertActiveConstraint(input.constraint, 'decision');
  const assignments = toDutyAssignments(input.actors);
  return {
    policy: 'separation_of_duties',
    input: { assignments, constraint },
  };
}

// ---------------------------------------------------------------------------
// 2. DELEGATION grant — separation_of_duties over delegator + recipient.
//    A delegation must not let a principal grant themselves an incompatible
//    duty; the constraint's incompatible-relationship set enforces it.
// ---------------------------------------------------------------------------

export interface DelegationQueryInput {
  readonly delegator: DecisionActor;
  readonly recipient: DecisionActor;
  readonly constraint: SoDConstraint;
}

/**
 * Build the `separation_of_duties` query for a delegation grant. Both the delegator and the
 * recipient are projected onto duty assignments so the policy can enforce that the delegation does
 * not create an incompatible duty pairing (e.g. requester delegating approval to the same principal).
 */
export function buildDelegationQuery(input: DelegationQueryInput): PolicyQuery {
  const constraint = assertActiveConstraint(input.constraint, 'delegation');
  const assignments = toDutyAssignments([input.delegator, input.recipient]);
  return {
    policy: 'separation_of_duties',
    input: { assignments, constraint },
  };
}

// ---------------------------------------------------------------------------
// 3. JOINT REVIEW — central_reviewer_distinctness over the cross-tenant action.
// ---------------------------------------------------------------------------

export interface JointReviewQueryInput {
  readonly action: CrossTenantAction;
  readonly reviewer: CentralReviewer;
}

/**
 * Build the `central_reviewer_distinctness` query for a federated joint review. The central
 * reviewer must be distinct from every requester/operator/control-owner/tenant-approver in the
 * cross-tenant action and must hold no incompatible action role (VO-173f7afb7801f4ab3e29 second
 * clause). Fail-closed on an empty reviewer principal.
 */
export function buildJointReviewQuery(input: JointReviewQueryInput): PolicyQuery {
  if (typeof input.reviewer.principalId !== 'string' || input.reviewer.principalId.trim().length === 0) {
    throw new DecisionInputError('joint review requires a central reviewer principal', {});
  }
  return {
    policy: 'central_reviewer_distinctness',
    input: { action: input.action, reviewer: input.reviewer },
  };
}

// ---------------------------------------------------------------------------
// 4. EXCEPTION / waiver — separation_of_duties, but a NON-WAIVABLE constraint
//    (minimumDistinctPrincipals bound, tenantId === null central guardrail)
//    can never be satisfied by a waiver, so the query is built unchanged and
//    the policy renders the deny — this builder refuses to strip the guardrail.
// ---------------------------------------------------------------------------

export interface ExceptionQueryInput {
  readonly actors: readonly DecisionActor[];
  readonly constraint: SoDConstraint;
  /** Whether a waiver was requested (recorded for evidence; never weakens a central guardrail). */
  readonly waiverRequested: boolean;
}

/**
 * Build the `separation_of_duties` query for an exception/waiver request. A waiver NEVER rewrites
 * the constraint here — the query is built against the constraint as-authored, so a non-waivable
 * central guardrail (a null-tenant, minimum-distinct-principals constraint) is still evaluated and
 * the policy renders the deny. The waiver intent is carried by the caller into evidence, not into
 * the policy input, so an exception can never silently soften a guardrail.
 */
export function buildExceptionQuery(input: ExceptionQueryInput): PolicyQuery {
  // Deliberately do NOT gate on constraint.status here: an exception request may be evaluated
  // against a draft/retired constraint to explain WHY it is (not) applicable, but a non-active
  // constraint still must not silently permit — so we only accept an active constraint.
  const constraint = assertActiveConstraint(input.constraint, 'exception');
  const assignments = toDutyAssignments(input.actors);
  return {
    policy: 'separation_of_duties',
    input: { assignments, constraint },
  };
}

// ---------------------------------------------------------------------------
// 5. EMERGENCY (break-glass) — separation_of_duties. Break-glass grants narrow
//    emergency access but NEVER decision authority, so an emergency actor is
//    still evaluated by the SoD policy; the constraint separates the incident
//    operator from any decision duty they must not also hold.
// ---------------------------------------------------------------------------

export interface EmergencyQueryInput {
  readonly actors: readonly DecisionActor[];
  readonly constraint: SoDConstraint;
}

/**
 * Build the `separation_of_duties` query for an emergency (break-glass) authorization. The emergency
 * operator is projected onto its duty alongside any co-duty-holders, so the policy enforces that the
 * emergency path does not let one principal both trigger and approve the governed effect (the
 * emergency fast path must not become an SoD bypass, FR-015).
 */
export function buildEmergencyQuery(input: EmergencyQueryInput): PolicyQuery {
  const constraint = assertActiveConstraint(input.constraint, 'emergency');
  const assignments = toDutyAssignments(input.actors);
  return {
    policy: 'separation_of_duties',
    input: { assignments, constraint },
  };
}

// ---------------------------------------------------------------------------
// 6. Unified builder + request wrapper.
// ---------------------------------------------------------------------------

/** A tagged, kind-discriminated decision input the unified builder normalizes. */
export type DecisionInput =
  | ({ readonly kind: 'decision' } & DecisionQueryInput)
  | ({ readonly kind: 'delegation' } & DelegationQueryInput)
  | ({ readonly kind: 'joint_review' } & JointReviewQueryInput)
  | ({ readonly kind: 'exception' } & ExceptionQueryInput)
  | ({ readonly kind: 'emergency' } & EmergencyQueryInput);

/**
 * Normalize any of the five governed operations into the exact `PolicyQuery` its policy consumes.
 * Fail-closed: an unknown kind is an exhaustiveness error at the boundary (never a default permit).
 */
export function buildPolicyQuery(input: DecisionInput): PolicyQuery {
  switch (input.kind) {
    case 'decision':
      return buildDecisionQuery(input);
    case 'delegation':
      return buildDelegationQuery(input);
    case 'joint_review':
      return buildJointReviewQuery(input);
    case 'exception':
      return buildExceptionQuery(input);
    case 'emergency':
      return buildEmergencyQuery(input);
    default: {
      const _never: never = input;
      throw new DecisionInputError('unknown decision input kind', { input: _never });
    }
  }
}

export interface DecisionRequestEnvelope {
  readonly input: DecisionInput;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  /** The bundle revision the CALLER pins — threaded verbatim into the PDP request. */
  readonly pinnedRevision: string;
  readonly now: EpochMillis;
}

/**
 * Build a full, revision-pinned `DecisionRequest` for the PDP from a normalized decision input. The
 * caller supplies the pinned bundle revision, the accountable actor, the correlation id, and the
 * decision instant; this wrapper only assembles them around the normalized query. Fail-closed on a
 * missing actor or an empty pinned revision (a decision must be attributable and revision-bound).
 */
export function buildDecisionRequest(envelope: DecisionRequestEnvelope): DecisionRequest {
  if (typeof envelope.actorPrincipalId !== 'string' || envelope.actorPrincipalId.trim().length === 0) {
    throw new DecisionInputError('a decision request requires an accountable actor', {});
  }
  if (typeof envelope.pinnedRevision !== 'string' || envelope.pinnedRevision.trim().length === 0) {
    throw new DecisionInputError('a decision request must pin a bundle revision', {});
  }
  if (typeof envelope.correlationId !== 'string' || envelope.correlationId.trim().length === 0) {
    throw new DecisionInputError('a decision request requires a correlation id', {});
  }
  return {
    query: buildPolicyQuery(envelope.input),
    actorPrincipalId: envelope.actorPrincipalId,
    correlationId: envelope.correlationId,
    pinnedRevision: envelope.pinnedRevision,
    now: envelope.now,
  };
}
