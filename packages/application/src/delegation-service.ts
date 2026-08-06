// @trustcircle/application — DELEGATION USE CASES (Phase 4 / User Story 2 / FR-014, AC5).
//
// A delegation is a BOUNDED, non-expanding grant of decision authority from a delegator to a named
// recipient. This service implements the four delegation use cases — CREATE, REVOKE, EXPIRE, and
// LINEAGE-CHECK — WITHOUT ever expanding authority. Every question of whether a delegation is
// valid (self-delegation, cross-tenant, scope expansion, time expansion, cycle, broken chain,
// source-assignment validity) is answered by the @trustcircle/authz `resolveDelegation` source of
// truth; this service NEVER re-implements that lineage logic. It only orchestrates the create /
// revoke / expire transitions and surfaces the authz verdict.
//
// Fail-closed: a create whose resulting chain would not resolve is REFUSED (returned as a data
// rejection, not a thrown error), so an invalid delegation is never persisted. A revoke is
// idempotent. Expiry is deterministic against an injected instant (no wall clock).

import {
  resolveDelegation,
  resolveRoleAssignment,
  scopeContains,
  type Delegation,
  type DelegationResolution,
  type RoleAssignment,
  type AuthorityScope,
} from '@trustcircle/authz';

export type DelegationRejectionCode =
  | 'SELF_DELEGATION'
  | 'CROSS_TENANT'
  | 'SCOPE_EXPANSION'
  | 'TIME_EXPANSION'
  | 'CYCLE'
  | 'BROKEN_CHAIN'
  | 'SOURCE_INVALID'
  | 'MISSING_REASON'
  | 'WINDOW_INVALID'
  | 'SOURCE_NOT_GRANTING';

export interface CreateDelegationCommand {
  readonly delegation: Delegation;
  /** The full delegation graph the new delegation joins (for lineage resolution). */
  readonly existingById: ReadonlyMap<string, Delegation>;
  readonly sourceOf: (assignmentId: string) => RoleAssignment | null;
  readonly now: number;
}

export interface DelegationResult {
  readonly ok: boolean;
  readonly delegation?: Delegation;
  readonly rejection?: DelegationRejectionCode;
  readonly resolution: DelegationResolution;
}

/** Map an authz delegation deny reason onto this service's rejection vocabulary. */
function mapDenyReason(resolution: DelegationResolution): DelegationRejectionCode {
  switch (resolution.reason) {
    case 'SELF_DELEGATION':
      return 'SELF_DELEGATION';
    case 'CROSS_TENANT':
      return 'CROSS_TENANT';
    case 'SCOPE_EXPANSION':
      return 'SCOPE_EXPANSION';
    case 'TIME_EXPANSION':
      return 'TIME_EXPANSION';
    case 'CYCLE':
      return 'CYCLE';
    case 'BROKEN_CHAIN':
      return 'BROKEN_CHAIN';
    case 'SOURCE_INVALID':
      return 'SOURCE_INVALID';
    case 'MISSING_REASON':
      return 'MISSING_REASON';
    case 'NOT_YET_VALID':
    case 'EXPIRED':
    case 'STATUS_NOT_ACTIVE':
      return 'WINDOW_INVALID';
    default:
      return 'BROKEN_CHAIN';
  }
}

/**
 * CREATE a delegation. The candidate is placed into the graph and resolved end-to-end; only a
 * fully-granting chain (no expansion, cycle, or broken link, and a currently-granting root
 * assignment) is accepted. Otherwise the candidate is REFUSED with the authz reason. The candidate
 * is never persisted on rejection.
 */
export function createDelegation(cmd: CreateDelegationCommand): DelegationResult {
  const { delegation } = cmd;

  // Guard the window shape up front (the migration's delegation_window_ordered).
  if (!(delegation.expiresAt > delegation.validFrom)) {
    return {
      ok: false,
      rejection: 'WINDOW_INVALID',
      resolution: { granted: false, reason: 'MALFORMED', lineage: [] },
    };
  }
  if (delegation.reasonText.trim().length === 0) {
    return {
      ok: false,
      rejection: 'MISSING_REASON',
      resolution: { granted: false, reason: 'MISSING_REASON', lineage: [] },
    };
  }

  // Build the graph the resolver sees, INCLUDING the candidate (so a cycle it introduces is caught).
  const byId = new Map(cmd.existingById);
  byId.set(delegation.delegationId, delegation);

  const resolution = resolveDelegation(delegation, byId, cmd.sourceOf, cmd.now);
  if (!resolution.granted) {
    return { ok: false, rejection: mapDenyReason(resolution), resolution };
  }

  // Defence in depth: the root source assignment must currently grant (never expand past it).
  const source = cmd.sourceOf(delegation.authorityAssignmentId);
  if (source === null || !resolveRoleAssignment(source, cmd.now).granted) {
    return {
      ok: false,
      rejection: 'SOURCE_NOT_GRANTING',
      resolution: { granted: false, reason: 'SOURCE_INVALID', lineage: resolution.lineage },
    };
  }

  return { ok: true, delegation: { ...delegation, status: 'active' }, resolution };
}

/**
 * REVOKE a delegation. Idempotent: revoking an already-revoked delegation returns it unchanged.
 * A revoked delegation is stamped with the instant and set `revoked`; the lineage resolution then
 * fails closed for any child that draws from it (BROKEN_CHAIN), so revocation cascades by
 * resolution, not by mutation.
 */
export function revokeDelegation(delegation: Delegation, now: number): Delegation {
  if (delegation.status === 'revoked') return delegation;
  return { ...delegation, status: 'revoked', expiresAt: Math.min(delegation.expiresAt, now) };
}

/** EXPIRE a delegation whose window has closed at `now` (deterministic). No-op if already terminal. */
export function expireDelegation(delegation: Delegation, now: number): Delegation {
  if (delegation.status === 'revoked' || delegation.status === 'expired') return delegation;
  if (now >= delegation.expiresAt) return { ...delegation, status: 'expired' };
  return delegation;
}

/**
 * LINEAGE-CHECK: resolve a delegation's full ancestry at `now`, returning the authz resolution
 * (granted + reason + leaf→root lineage). This is the read-only revalidation used before an
 * effect: a delegate acting must have a delegation that STILL resolves at effect time.
 */
export function checkDelegationLineage(
  delegation: Delegation,
  byId: ReadonlyMap<string, Delegation>,
  sourceOf: (assignmentId: string) => RoleAssignment | null,
  now: number,
): DelegationResolution {
  return resolveDelegation(delegation, byId, sourceOf, now);
}

/**
 * NON-EXPANSION oracle: true iff `child` scope is contained by `parent` scope (same type+id, and
 * every child action ∈ parent actions). A delegation may only narrow authority, never widen it.
 * Delegates to the authz `scopeContains` source of truth.
 */
export function delegationDoesNotExpand(parent: AuthorityScope, child: AuthorityScope): boolean {
  return scopeContains(parent, child);
}
