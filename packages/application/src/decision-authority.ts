// @trustcircle/application — DECISION AUTHORITY RESOLUTION (Phase 4 / User Story 2 / FR-010,
// FR-014, SC-020).
//
// This module resolves whether a principal MAY take a decision on a governed action, AT a specific
// instant, over a specific resource/tenant/environment/risk. It resolves authority TWICE — at
// SUBMISSION time (to build the queue's allowed-actions) and again at EFFECT time (the instant the
// decision is applied) — because authority can lapse between the two (an assignment expires, a
// delegation is revoked, recertification lapses). A decision applied against stale authority is a
// bypass; resolving at effect time closes it (spec: "no consequential action can bypass CURRENT
// authority").
//
// It is a THIN application-layer coordinator over the @trustcircle/authz source of truth: it
// resolves the principal's EFFECTIVE authority (`resolveEffectiveAuthority`), projects it onto the
// duty model, and asks the SoD evaluator (`evaluateActionAuthority`) — it NEVER re-implements a
// guard. Everything is fail-closed: an unresolved authority, an expired assignment, or a missing
// duty yields `permitted: false` with the authz deny reason, never optimistic success.

import {
  resolveEffectiveAuthority,
  resolveRoleAssignment,
  evaluateActionAuthority,
  type AuthorityInputs,
  type EffectiveAuthority,
  type RoleAssignment,
  type Delegation,
  type BreakGlassGrant,
  type Duty,
  type Relationship,
  type SoDConstraint,
  type SoDEvaluation,
} from '@trustcircle/authz';

/** The action context a decision is taken over — the dimensions authority is resolved against. */
export interface DecisionActionContext {
  readonly action: string;
  readonly actionClass: string;
  readonly resourceId: string;
  readonly tenantId: string;
  readonly environment: string;
  readonly riskTier: string;
  /** The instant authority is resolved AT (submission time or effect time). */
  readonly at: number;
}

/** One participant in the decision (the actor, plus any other duty-holders for SoD). */
export interface DecisionParticipant {
  readonly principalId: string;
  readonly duty: Duty;
  readonly relationships: readonly Relationship[];
  readonly assignments: readonly RoleAssignment[];
  readonly delegations: readonly Delegation[];
  readonly breakGlassGrants: readonly BreakGlassGrant[];
}

/** All delegations in scope, for lineage resolution, plus the assignment lookup. */
export interface AuthorityGraph {
  readonly allDelegationsById: ReadonlyMap<string, Delegation>;
  readonly sourceOf: (assignmentId: string) => RoleAssignment | null;
}

export type AuthorityDenyReason =
  | 'NO_GRANTING_ASSIGNMENT'
  | 'EXPIRED_ASSIGNMENT'
  | 'SOD_VIOLATION'
  | 'ADMIN_ONLY_NO_AUTHORITY'
  | 'NO_PARTICIPANTS';

export interface AuthorityResolution {
  readonly permitted: boolean;
  readonly denyReason: AuthorityDenyReason | null;
  /** The authz SoD evaluation (the machine-readable verdict + violations). */
  readonly evaluation: SoDEvaluation | null;
  /** The actor's resolved effective authority at `context.at` (for disclosure). */
  readonly actorAuthority: EffectiveAuthority | null;
  /** The assignment id the actor's authority derives from (bound onto the decision record). */
  readonly authorityAssignmentId: string | null;
}

function effectiveAuthorityFor(
  participant: DecisionParticipant,
  tenantId: string,
  graph: AuthorityGraph,
  at: number,
): EffectiveAuthority {
  const inputs: AuthorityInputs = {
    principalId: participant.principalId,
    tenantId,
    assignments: participant.assignments,
    delegations: participant.delegations,
    breakGlassGrants: participant.breakGlassGrants,
    allDelegationsById: graph.allDelegationsById,
    sourceOf: graph.sourceOf,
  };
  return resolveEffectiveAuthority(inputs, at);
}

/**
 * The assignment id the actor's authority derives from at `at`, or null if none currently grants.
 * Used to bind the decision record to the exact authority that permitted it (auditability).
 */
export function resolveActorAuthorityAssignmentId(
  actor: DecisionParticipant,
  at: number,
): string | null {
  for (const a of actor.assignments) {
    if (resolveRoleAssignment(a, at).granted) return a.roleAssignmentId;
  }
  return null;
}

/**
 * Resolve decision authority at `context.at`. Fails closed: an actor with no currently-granting
 * assignment, an expired assignment, an admin-only principal (no decision authority), or an SoD
 * violation is denied with a machine-readable reason. Only a clean SoD evaluation permits.
 */
export function resolveDecisionAuthority(
  context: DecisionActionContext,
  actor: DecisionParticipant,
  otherParticipants: readonly DecisionParticipant[],
  constraint: SoDConstraint,
  graph: AuthorityGraph,
): AuthorityResolution {
  const actorAuthority = effectiveAuthorityFor(actor, context.tenantId, graph, context.at);

  // An admin-only principal (break-glass only or non-decision roles) never carries decision authority.
  if (actorAuthority.breakGlassOnly || actorAuthority.roles.length === 0) {
    return {
      permitted: false,
      denyReason: actorAuthority.roles.length === 0 ? 'NO_GRANTING_ASSIGNMENT' : 'ADMIN_ONLY_NO_AUTHORITY',
      evaluation: null,
      actorAuthority,
      authorityAssignmentId: null,
    };
  }

  const assignmentId = resolveActorAuthorityAssignmentId(actor, context.at);
  if (assignmentId === null) {
    // No assignment currently grants at effect time — expired/suspended/not-yet-valid.
    const hadAny = actor.assignments.length > 0;
    return {
      permitted: false,
      denyReason: hadAny ? 'EXPIRED_ASSIGNMENT' : 'NO_GRANTING_ASSIGNMENT',
      evaluation: null,
      actorAuthority,
      authorityAssignmentId: null,
    };
  }

  const participants = [actor, ...otherParticipants].map((p) => ({
    authority: effectiveAuthorityFor(p, context.tenantId, graph, context.at),
    duty: p.duty,
    relationships: p.relationships,
  }));

  const evaluation = evaluateActionAuthority(participants, constraint);
  if (!evaluation.permitted) {
    return {
      permitted: false,
      denyReason: 'SOD_VIOLATION',
      evaluation,
      actorAuthority,
      authorityAssignmentId: assignmentId,
    };
  }

  return {
    permitted: true,
    denyReason: null,
    evaluation,
    actorAuthority,
    authorityAssignmentId: assignmentId,
  };
}
