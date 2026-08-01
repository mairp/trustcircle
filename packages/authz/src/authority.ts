// @trustcircle/authz — current role-assignment resolution, delegation lineage,
// recertification, expiry, and break-glass resolution
// (T042 / GAR-003 / VO-173f7afb7801f4ab3e29).
//
// Oracle (VO-173f7afb7801f4ab3e29): Request, review, approval, execution, evidence
// administration, control ownership, and assurance MUST be separated where conflicts exist;
// platform administration alone MUST NOT grant decision authority, and the independent
// central reviewer for a cross-tenant action MUST NOT hold an incompatible action role.
//
// Where the sibling separation-of-duties.ts answers "given these filled duties, is the action
// separated?", this module answers the prior question: "what authority does a principal
// ACTUALLY hold RIGHT NOW?" It resolves the *effective* set of role assignments and delegated
// authority a principal may exercise at an injected instant, honouring:
//
//   1. CURRENT ROLE ASSIGNMENT — an assignment grants authority only while it is `active`,
//      inside its [valid_from, expires_at) window, and not overdue for recertification. A
//      `pending`, `suspended`, `expired`, or `revoked` assignment grants nothing.
//   2. DELEGATION LINEAGE — a delegation grants authority only when its whole ancestry chain
//      is valid: it cannot cross tenants, expand scope/actions/time beyond its source, form a
//      cycle, or outlive the source assignment it descends from.
//   3. RECERTIFICATION — an active assignment past `next_recertification_at` is treated as
//      lapsed (grants nothing) until recertified.
//   4. EXPIRY — time-boxed assignments, delegations, and break-glass grants stop granting
//      authority the instant they expire (exclusive upper bound), with no grace.
//   5. BREAK-GLASS RESOLUTION — an emergency grant confers narrow, explicit authority only
//      while `active` and unexpired, and NEVER decision authority; it always requires an
//      independent post-event reviewer distinct from the grantee.
//
// The module is dependency-free apart from the sibling SoD source of truth: any "now" is
// injected (no hidden clock), and there is no filesystem or network. It therefore runs
// deterministically under `npm ci` and is independently observable via tests/authz. Every
// resolver fails CLOSED — unknown, missing, malformed, or ambiguous input grants NO authority.
//
// Crucially, this module does NOT re-implement separation of duties. It projects resolved
// authority into the canonical types of ./separation-of-duties.ts and defers every SoD
// question to `evaluateSeparationOfDuties` / `evaluateCentralReviewerDistinctness`, so the
// oracle above is enforced by a single source of truth.

import {
  type Duty,
  type DutyAssignment,
  type Relationship,
  type RoleKey,
  type SoDConstraint,
  type SoDEvaluation,
  type CrossTenantAction,
  type CentralReviewer,
  NON_DECISION_ROLES,
  evaluateSeparationOfDuties,
  evaluateCentralReviewerDistinctness,
} from './separation-of-duties.ts';

// NOTE: the imported SoD types (Duty, DutyAssignment, RoleKey, SoDConstraint, …) are NOT
// re-exported here — they remain owned and exported by ./separation-of-duties.ts, so the
// package barrel (index.ts) has a single, unambiguous export for each. This module only adds
// the authority-resolution surface below.

// ---------------------------------------------------------------------------
// Time. All instants are epoch milliseconds and INJECTED — there is no hidden clock, so the
// resolvers are pure with respect to their inputs and deterministic under test.
// ---------------------------------------------------------------------------

/** A finite epoch-millisecond instant, or null for "open / unbounded". */
export type EpochMs = number | null;

function isFiniteMs(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * True iff `now` lies within the half-open window [from, until): inclusive lower bound,
 * EXCLUSIVE upper bound (a grant is dead the instant it expires). A null `until` means the
 * window has no upper bound. A non-finite `now` or `from` fails closed (not within).
 */
export function withinWindow(now: number, from: number, until: EpochMs): boolean {
  if (!isFiniteMs(now) || !isFiniteMs(from)) return false;
  if (now < from) return false;
  if (until === null) return true;
  if (!isFiniteMs(until)) return false;
  return now < until;
}

// ---------------------------------------------------------------------------
// Scope. A resolved authority is always scoped: a scope type, a scope id, and the exact set
// of allowed actions. Delegation may only NARROW a scope, never widen it.
// ---------------------------------------------------------------------------

export type ScopeType = 'organization' | 'environment' | 'resource' | 'source' | 'action';

export interface AuthorityScope {
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  /** Exact allowed-action tokens. Authorization is exact-match; never prefix/wildcard. */
  readonly allowedActions: readonly string[];
}

/**
 * Scope containment for delegation lineage: `child` is contained by `parent` iff they share
 * the same scope type and id and every child action is an EXACT member of the parent's
 * actions. Empty child actions are treated as no authority (contained but useless). Fails
 * closed on any structural mismatch.
 */
export function scopeContains(parent: AuthorityScope, child: AuthorityScope): boolean {
  if (parent.scopeType !== child.scopeType) return false;
  if (parent.scopeId !== child.scopeId) return false;
  const parentActions = new Set(parent.allowedActions);
  return child.allowedActions.every((a) => parentActions.has(a));
}

// ---------------------------------------------------------------------------
// Role assignment (data-model.md §RoleAssignment / 0001_tenancy_authority.sql).
// ---------------------------------------------------------------------------

export type RoleAssignmentStatus = 'pending' | 'active' | 'suspended' | 'expired' | 'revoked';

export interface RoleAssignment {
  readonly roleAssignmentId: string;
  readonly tenantId: string;
  readonly principalId: string;
  /** The governance role this assignment grants (maps to SoD RoleKey). */
  readonly role: RoleKey;
  readonly scope: AuthorityScope;
  readonly validFrom: number;
  readonly expiresAt: EpochMs;
  readonly status: RoleAssignmentStatus;
  /** Required while active (data-model rule). Assignment lapses once `now >= next`. */
  readonly nextRecertificationAt: EpochMs;
  readonly lastRecertifiedAt: EpochMs;
}

/** Why a role assignment does or does not currently grant authority. */
export type AssignmentDenyReason =
  | 'STATUS_NOT_ACTIVE'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'RECERTIFICATION_LAPSED'
  | 'RECERTIFICATION_MISSING'
  | 'MALFORMED';

export interface AssignmentResolution {
  readonly granted: boolean;
  readonly reason: AssignmentDenyReason | null;
}

/**
 * Resolve whether a role assignment grants authority at `nowMs`. Fails closed: a non-active
 * status, a window miss, a missing recertification bookkeeping on an active assignment, or a
 * lapsed recertification all deny. Only an active, in-window, recertified assignment grants.
 */
export function resolveRoleAssignment(
  assignment: RoleAssignment,
  nowMs: number,
): AssignmentResolution {
  if (!isFiniteMs(nowMs) || !isFiniteMs(assignment.validFrom)) {
    return { granted: false, reason: 'MALFORMED' };
  }
  if (assignment.status !== 'active') {
    return { granted: false, reason: 'STATUS_NOT_ACTIVE' };
  }
  if (nowMs < assignment.validFrom) {
    return { granted: false, reason: 'NOT_YET_VALID' };
  }
  if (assignment.expiresAt !== null) {
    if (!isFiniteMs(assignment.expiresAt) || nowMs >= assignment.expiresAt) {
      return { granted: false, reason: 'EXPIRED' };
    }
  }
  // Active assignments MUST carry recertification bookkeeping (data-model rule + SQL CHECK).
  if (assignment.nextRecertificationAt === null || !isFiniteMs(assignment.nextRecertificationAt)) {
    return { granted: false, reason: 'RECERTIFICATION_MISSING' };
  }
  if (nowMs >= assignment.nextRecertificationAt) {
    return { granted: false, reason: 'RECERTIFICATION_LAPSED' };
  }
  return { granted: true, reason: null };
}

/** True iff an active assignment is at/over its recertification horizon at `nowMs`. */
export function isRecertificationLapsed(assignment: RoleAssignment, nowMs: number): boolean {
  if (assignment.status !== 'active') return false;
  if (assignment.nextRecertificationAt === null) return true;
  if (!isFiniteMs(assignment.nextRecertificationAt) || !isFiniteMs(nowMs)) return true;
  return nowMs >= assignment.nextRecertificationAt;
}

/**
 * Apply a recertification event to an assignment, producing a new immutable assignment whose
 * recertification horizon is advanced. Fails closed by returning `null` (no new authority) if
 * the assignment is not active, the reviewer coincides with the assignee (self-recertification
 * is forbidden), or the new horizon is not strictly after `nowMs`.
 */
export function recertify(
  assignment: RoleAssignment,
  event: {
    readonly reviewerPrincipalId: string;
    readonly atMs: number;
    readonly nextRecertificationAt: number;
    readonly reason: string;
  },
): RoleAssignment | null {
  if (assignment.status !== 'active') return null;
  if (!isFiniteMs(event.atMs) || !isFiniteMs(event.nextRecertificationAt)) return null;
  if (event.nextRecertificationAt <= event.atMs) return null;
  if (event.reviewerPrincipalId === assignment.principalId) return null; // no self-recert
  if (typeof event.reason !== 'string' || event.reason.trim().length === 0) return null;
  return {
    ...assignment,
    lastRecertifiedAt: event.atMs,
    nextRecertificationAt: event.nextRecertificationAt,
  };
}

// ---------------------------------------------------------------------------
// Delegation lineage (data-model.md §Delegation / 0001_tenancy_authority.sql).
// ---------------------------------------------------------------------------

export type DelegationStatus = 'proposed' | 'active' | 'expired' | 'revoked';

export interface Delegation {
  readonly delegationId: string;
  readonly tenantId: string;
  readonly delegatorPrincipalId: string;
  readonly recipientPrincipalId: string;
  /** The role assignment this delegation draws authority from. */
  readonly authorityAssignmentId: string;
  readonly scope: AuthorityScope;
  readonly reasonText: string;
  readonly validFrom: number;
  readonly expiresAt: number;
  /** Parent link for lineage; null at the root. Cycles are forbidden. */
  readonly parentDelegationId: string | null;
  readonly status: DelegationStatus;
}

export type DelegationDenyReason =
  | 'STATUS_NOT_ACTIVE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'SELF_DELEGATION'
  | 'MISSING_REASON'
  | 'CROSS_TENANT'
  | 'SCOPE_EXPANSION'
  | 'TIME_EXPANSION'
  | 'CYCLE'
  | 'BROKEN_CHAIN'
  | 'SOURCE_INVALID'
  | 'MALFORMED';

export interface DelegationResolution {
  readonly granted: boolean;
  readonly reason: DelegationDenyReason | null;
  /** The chain from the delegation up to (and including) its root, when resolvable. */
  readonly lineage: readonly string[];
}

/**
 * Resolve a delegation to the authority it currently confers, walking its whole ancestry.
 *
 * A delegation grants authority at `nowMs` iff EVERY link is valid: active, in its own
 * [valid_from, expires_at) window, distinct parties, a non-empty reason, same tenant as its
 * parent/source, a scope that is a strict-or-equal SUBSET of its parent's (never wider), a
 * validity window that does not outlive its parent or the root source assignment, no cycle in
 * the parent chain, and a root source assignment that itself currently grants authority
 * (resolveRoleAssignment). Fails CLOSED on any broken or unknown link.
 *
 * @param delegation   the leaf delegation being exercised
 * @param byId         a lookup of every delegation by id (for the parent chain)
 * @param sourceOf     resolves the root's `authorityAssignmentId` to its RoleAssignment (or null)
 * @param nowMs        injected instant
 */
export function resolveDelegation(
  delegation: Delegation,
  byId: ReadonlyMap<string, Delegation>,
  sourceOf: (assignmentId: string) => RoleAssignment | null,
  nowMs: number,
): DelegationResolution {
  const lineage: string[] = [];
  const seen = new Set<string>();
  let current: Delegation = delegation;
  let root: Delegation = delegation;

  // Walk from the leaf up to the root, validating each link and each parent relationship.
  for (;;) {
    if (seen.has(current.delegationId)) {
      return { granted: false, reason: 'CYCLE', lineage };
    }
    seen.add(current.delegationId);
    lineage.push(current.delegationId);
    root = current;

    const linkOk = validateDelegationLink(current, nowMs);
    if (linkOk !== null) {
      return { granted: false, reason: linkOk, lineage };
    }

    if (current.parentDelegationId === null) break;

    const parent = byId.get(current.parentDelegationId);
    if (!parent) {
      return { granted: false, reason: 'BROKEN_CHAIN', lineage };
    }
    const relationOk = validateParentRelation(current, parent);
    if (relationOk !== null) {
      return { granted: false, reason: relationOk, lineage };
    }
    current = parent;
  }

  // `root` is now the root delegation. Its authority derives from a source assignment that
  // must itself currently grant, in the same tenant, with a scope covering the root and a
  // validity window the root does not outlive.
  const source = sourceOf(root.authorityAssignmentId);
  if (!source) {
    return { granted: false, reason: 'SOURCE_INVALID', lineage };
  }
  if (source.tenantId !== root.tenantId) {
    return { granted: false, reason: 'CROSS_TENANT', lineage };
  }
  if (!scopeContains(source.scope, root.scope)) {
    return { granted: false, reason: 'SCOPE_EXPANSION', lineage };
  }
  if (
    source.expiresAt !== null &&
    isFiniteMs(source.expiresAt) &&
    root.expiresAt > source.expiresAt
  ) {
    return { granted: false, reason: 'TIME_EXPANSION', lineage };
  }
  if (!resolveRoleAssignment(source, nowMs).granted) {
    return { granted: false, reason: 'SOURCE_INVALID', lineage };
  }

  return { granted: true, reason: null, lineage };
}

/** Validate a single delegation link's intrinsic rules. Returns null when valid. */
function validateDelegationLink(d: Delegation, nowMs: number): DelegationDenyReason | null {
  if (!isFiniteMs(nowMs) || !isFiniteMs(d.validFrom) || !isFiniteMs(d.expiresAt))
    return 'MALFORMED';
  if (d.status !== 'active') return 'STATUS_NOT_ACTIVE';
  if (d.delegatorPrincipalId === d.recipientPrincipalId) return 'SELF_DELEGATION';
  if (typeof d.reasonText !== 'string' || d.reasonText.trim().length === 0) return 'MISSING_REASON';
  if (d.expiresAt <= d.validFrom) return 'MALFORMED';
  if (nowMs < d.validFrom) return 'NOT_YET_VALID';
  if (nowMs >= d.expiresAt) return 'EXPIRED';
  return null;
}

/** Validate a child→parent relationship: no privilege/scope/time/tenant expansion. Null when OK. */
function validateParentRelation(
  child: Delegation,
  parent: Delegation,
): DelegationDenyReason | null {
  if (child.tenantId !== parent.tenantId) return 'CROSS_TENANT';
  // A child must draw from the same source assignment as its parent (no lateral privilege jump).
  if (child.authorityAssignmentId !== parent.authorityAssignmentId) return 'SCOPE_EXPANSION';
  if (!scopeContains(parent.scope, child.scope)) return 'SCOPE_EXPANSION';
  if (child.expiresAt > parent.expiresAt) return 'TIME_EXPANSION';
  if (child.validFrom < parent.validFrom) return 'TIME_EXPANSION';
  return null;
}

// ---------------------------------------------------------------------------
// Break-glass resolution (data-model.md §BreakGlassGrant / 0001_tenancy_authority.sql).
// ---------------------------------------------------------------------------

export type BreakGlassStatus = 'active' | 'expired' | 'revoked' | 'reviewed';

export interface BreakGlassGrant {
  readonly breakGlassGrantId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly scope: AuthorityScope;
  readonly reasonText: string;
  readonly incidentId: string;
  readonly activatedAt: number;
  readonly expiresAt: number;
  readonly monitoringEvidenceId: string;
  /** Independent post-event reviewer, MUST differ from the grantee. */
  readonly reviewerPrincipalId: string;
  readonly reviewDueAt: number;
  readonly reviewedAt: EpochMs;
  readonly status: BreakGlassStatus;
}

export type BreakGlassDenyReason =
  | 'STATUS_NOT_ACTIVE'
  | 'EXPIRED'
  | 'NOT_YET_ACTIVE'
  | 'MISSING_REASON'
  | 'MISSING_INCIDENT'
  | 'MISSING_MONITORING'
  | 'NON_INDEPENDENT_REVIEWER'
  | 'MALFORMED';

export interface BreakGlassResolution {
  readonly granted: boolean;
  readonly reason: BreakGlassDenyReason | null;
}

/**
 * Resolve whether a break-glass grant currently confers its narrow authority at `nowMs`.
 * Emergency authority is short-lived and heavily conditioned: it must be `active`, inside its
 * [activated_at, expires_at) window, carry a reason, incident, and monitoring evidence, and be
 * subject to an independent reviewer distinct from the grantee. Fails CLOSED otherwise.
 *
 * Break-glass NEVER confers governance decision authority — see {@link breakGlassToDutyAssignment}.
 */
export function resolveBreakGlass(grant: BreakGlassGrant, nowMs: number): BreakGlassResolution {
  if (!isFiniteMs(nowMs) || !isFiniteMs(grant.activatedAt) || !isFiniteMs(grant.expiresAt)) {
    return { granted: false, reason: 'MALFORMED' };
  }
  if (grant.expiresAt <= grant.activatedAt) return { granted: false, reason: 'MALFORMED' };
  if (grant.status !== 'active') return { granted: false, reason: 'STATUS_NOT_ACTIVE' };
  if (grant.reviewerPrincipalId === grant.principalId) {
    return { granted: false, reason: 'NON_INDEPENDENT_REVIEWER' };
  }
  if (typeof grant.reasonText !== 'string' || grant.reasonText.trim().length === 0) {
    return { granted: false, reason: 'MISSING_REASON' };
  }
  if (typeof grant.incidentId !== 'string' || grant.incidentId.trim().length === 0) {
    return { granted: false, reason: 'MISSING_INCIDENT' };
  }
  if (
    typeof grant.monitoringEvidenceId !== 'string' ||
    grant.monitoringEvidenceId.trim().length === 0
  ) {
    return { granted: false, reason: 'MISSING_MONITORING' };
  }
  if (nowMs < grant.activatedAt) return { granted: false, reason: 'NOT_YET_ACTIVE' };
  if (nowMs >= grant.expiresAt) return { granted: false, reason: 'EXPIRED' };
  return { granted: true, reason: null };
}

// ---------------------------------------------------------------------------
// Effective authority — the union of what a principal may exercise at `nowMs`.
// ---------------------------------------------------------------------------

export interface EffectiveAuthority {
  readonly principalId: string;
  readonly tenantId: string;
  /** Roles currently granted by ACTIVE, in-window, recertified assignments. */
  readonly roles: readonly RoleKey[];
  /** Distinct scopes currently exercisable (from assignments, delegations, break-glass). */
  readonly scopes: readonly AuthorityScope[];
  /** Ids of the delegations currently conferring authority. */
  readonly activeDelegationIds: readonly string[];
  /** Ids of break-glass grants currently conferring (non-decision) authority. */
  readonly activeBreakGlassIds: readonly string[];
  /** True iff any currently-granted authority derives ONLY from break-glass. */
  readonly breakGlassOnly: boolean;
}

export interface AuthorityInputs {
  readonly principalId: string;
  readonly tenantId: string;
  readonly assignments: readonly RoleAssignment[];
  readonly delegations: readonly Delegation[];
  readonly breakGlassGrants: readonly BreakGlassGrant[];
  /** Every delegation known, for parent-chain resolution. */
  readonly allDelegationsById: ReadonlyMap<string, Delegation>;
  readonly sourceOf: (assignmentId: string) => RoleAssignment | null;
}

/**
 * Compute the effective authority a principal holds at `nowMs` from the union of its
 * currently-granting role assignments, valid delegation chains, and active break-glass
 * grants. Only inputs that belong to the principal and its tenant, and that pass their
 * respective fail-closed resolvers, contribute. Nothing is inferred.
 */
export function resolveEffectiveAuthority(
  input: AuthorityInputs,
  nowMs: number,
): EffectiveAuthority {
  const roles = new Set<RoleKey>();
  const scopes: AuthorityScope[] = [];
  const activeDelegationIds: string[] = [];
  const activeBreakGlassIds: string[] = [];
  let hasNonBreakGlass = false;
  let hasAny = false;

  for (const a of input.assignments) {
    if (a.principalId !== input.principalId || a.tenantId !== input.tenantId) continue;
    if (!resolveRoleAssignment(a, nowMs).granted) continue;
    roles.add(a.role);
    scopes.push(a.scope);
    hasNonBreakGlass = true;
    hasAny = true;
  }

  for (const d of input.delegations) {
    if (d.recipientPrincipalId !== input.principalId || d.tenantId !== input.tenantId) continue;
    const res = resolveDelegation(d, input.allDelegationsById, input.sourceOf, nowMs);
    if (!res.granted) continue;
    activeDelegationIds.push(d.delegationId);
    scopes.push(d.scope);
    hasNonBreakGlass = true;
    hasAny = true;
  }

  for (const g of input.breakGlassGrants) {
    if (g.principalId !== input.principalId || g.tenantId !== input.tenantId) continue;
    if (!resolveBreakGlass(g, nowMs).granted) continue;
    activeBreakGlassIds.push(g.breakGlassGrantId);
    scopes.push(g.scope);
    hasAny = true;
  }

  return {
    principalId: input.principalId,
    tenantId: input.tenantId,
    roles: [...roles],
    scopes,
    activeDelegationIds,
    activeBreakGlassIds,
    breakGlassOnly: hasAny && !hasNonBreakGlass,
  };
}

// ---------------------------------------------------------------------------
// Bridges into the SoD source of truth. These are the ONLY sanctioned way to turn resolved
// authority into a SoD DutyAssignment / CentralReviewer, so the oracle is enforced by
// separation-of-duties.ts and never re-derived here.
// ---------------------------------------------------------------------------

/**
 * Project a principal's resolved authority onto a SoD {@link DutyAssignment} for a given duty
 * and relationships. Returns `null` (no assignment, hence no authority) when the principal
 * currently holds NO granting role for the tenant. Break-glass-only authority never yields a
 * DECISION duty — it is stripped to the single non-decision role, mirroring the SoD
 * PLATFORM_ADMIN_NO_AUTHORITY guard, so break-glass can never smuggle in decision authority.
 */
export function authorityToDutyAssignment(
  authority: EffectiveAuthority,
  duty: Duty,
  relationships: readonly Relationship[],
): DutyAssignment | null {
  const DECISION_DUTIES = new Set<Duty>(['approval', 'review', 'assurance']);

  // Break-glass-only principals may act on non-decision duties, but never carry a decision
  // role: emit exactly the non-decision automation-style role so the SoD guard rejects any
  // attempt to use emergency access for approval/review/assurance.
  if (authority.breakGlassOnly) {
    if (DECISION_DUTIES.has(duty)) {
      // Emit an assignment with NO decision role so evaluateSeparationOfDuties fails it closed
      // via PLATFORM_ADMIN_NO_AUTHORITY rather than silently permitting it.
      return {
        principalId: authority.principalId,
        duty,
        roles: [],
        relationships,
        tenantId: authority.tenantId,
      };
    }
    return {
      principalId: authority.principalId,
      duty,
      roles: [...authority.roles.filter((r) => NON_DECISION_ROLES.has(r))],
      relationships,
      tenantId: authority.tenantId,
    };
  }

  if (authority.roles.length === 0) return null;

  return {
    principalId: authority.principalId,
    duty,
    roles: [...authority.roles],
    relationships,
    tenantId: authority.tenantId,
  };
}

/**
 * Evaluate an action's separated-duties constraint from RESOLVED authority. Each participant
 * supplies its principal's effective authority, the duty it fills, and its relationships; the
 * bridge projects them onto DutyAssignments and defers wholly to the SoD source of truth.
 * A participant whose principal currently holds no authority contributes no assignment, which
 * makes the action fail closed (fewer distinct principals / missing duty) rather than pass.
 */
export function evaluateActionAuthority(
  participants: ReadonlyArray<{
    readonly authority: EffectiveAuthority;
    readonly duty: Duty;
    readonly relationships: readonly Relationship[];
  }>,
  constraint: SoDConstraint,
): SoDEvaluation {
  const assignments: DutyAssignment[] = [];
  for (const p of participants) {
    const a = authorityToDutyAssignment(p.authority, p.duty, p.relationships);
    if (a) assignments.push(a);
  }
  return evaluateSeparationOfDuties(assignments, constraint);
}

/**
 * Project a principal's resolved authority onto a SoD {@link CentralReviewer} for a
 * cross-tenant action, and defer to `evaluateCentralReviewerDistinctness`. Break-glass-only or
 * unauthorized principals produce a reviewer that carries no reviewer role, so the SoD guard
 * fails closed: emergency access can never stand in for the independent central reviewer.
 */
export function evaluateCentralReviewerAuthority(
  action: CrossTenantAction,
  reviewerAuthority: EffectiveAuthority,
): SoDEvaluation {
  const reviewer: CentralReviewer = {
    principalId: reviewerAuthority.principalId,
    roles: reviewerAuthority.breakGlassOnly ? [] : [...reviewerAuthority.roles],
  };
  return evaluateCentralReviewerDistinctness(action, reviewer);
}
