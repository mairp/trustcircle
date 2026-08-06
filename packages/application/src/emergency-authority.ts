// @trustcircle/application — EMERGENCY (BREAK-GLASS) AUTHORITY (Phase 4 / User Story 2 / FR-015,
// AC5 emergency path).
//
// Emergencies need a fast path, but a fast path is exactly where governance is most often bypassed.
// Break-glass here is deliberately NARROW and heavily conditioned: it is time-boxed, scoped to a
// declared incident, backed by monitoring evidence, subject to an INDEPENDENT post-event reviewer
// distinct from the grantee, and — critically — it NEVER confers governance DECISION authority. A
// break-glass grant lets an operator act under emergency access with full attribution; it does not
// let them approve their own governed decision. That separation is what keeps the emergency path
// from becoming a bypass of separation-of-duties / tenant approval / central guardrails.
//
// This module is a THIN coordinator over the @trustcircle/authz `resolveBreakGlass` source of truth.
// It (1) VALIDATES an activation request fail-closed before the grant is written, (2) resolves
// whether a grant currently confers its narrow authority, (3) computes the EMERGENCY-STOP transition
// (revocation), and (4) drives the mandatory POST-EVENT review — an active grant that has passed its
// review-due instant without a distinct reviewer sign-off is flagged as REVIEW-OVERDUE, never
// silently allowed to lapse. Determinism: every instant is injected; no wall clock.

import {
  resolveBreakGlass,
  type BreakGlassGrant,
  type BreakGlassResolution,
} from '@trustcircle/authz';

export type BreakGlassActivationRejection =
  | 'MISSING_REASON'
  | 'MISSING_INCIDENT'
  | 'MISSING_MONITORING'
  | 'NON_INDEPENDENT_REVIEWER'
  | 'MISSING_REVIEW_DUE'
  | 'WINDOW_INVALID';

export interface ActivationValidation {
  readonly ok: boolean;
  readonly rejection?: BreakGlassActivationRejection;
  readonly detail?: string;
}

/**
 * Validate a break-glass ACTIVATION request BEFORE the grant is persisted. Every emergency
 * precondition is checked fail-closed: a reason, an incident id, monitoring evidence, an independent
 * reviewer distinct from the grantee, a forward review-due instant, and a well-ordered activation
 * window. A request failing any check is REFUSED (returned as data, never thrown) so an unconditioned
 * emergency grant is never written.
 */
export function validateBreakGlassActivation(input: {
  readonly principalId: string;
  readonly reviewerPrincipalId: string;
  readonly reasonText: string;
  readonly incidentId: string;
  readonly monitoringEvidenceId: string;
  readonly activatedAt: number;
  readonly expiresAt: number;
  readonly reviewDueAt: number;
}): ActivationValidation {
  if (input.reasonText.trim().length === 0) {
    return { ok: false, rejection: 'MISSING_REASON', detail: 'a break-glass reason is required' };
  }
  if (input.incidentId.trim().length === 0) {
    return { ok: false, rejection: 'MISSING_INCIDENT', detail: 'a declared incident id is required' };
  }
  if (input.monitoringEvidenceId.trim().length === 0) {
    return { ok: false, rejection: 'MISSING_MONITORING', detail: 'monitoring evidence is required' };
  }
  if (input.reviewerPrincipalId === input.principalId || input.reviewerPrincipalId.trim().length === 0) {
    return {
      ok: false,
      rejection: 'NON_INDEPENDENT_REVIEWER',
      detail: 'the post-event reviewer must be a distinct principal',
    };
  }
  if (!(input.expiresAt > input.activatedAt)) {
    return { ok: false, rejection: 'WINDOW_INVALID', detail: 'expiresAt must be after activatedAt' };
  }
  if (!(input.reviewDueAt >= input.activatedAt)) {
    return { ok: false, rejection: 'MISSING_REVIEW_DUE', detail: 'reviewDueAt must be on/after activation' };
  }
  return { ok: true };
}

/**
 * Resolve whether a break-glass grant currently confers its narrow emergency authority at `now`.
 * Delegates to the authz `resolveBreakGlass` source of truth (active status, in-window, reason /
 * incident / monitoring present, independent reviewer). Fails closed.
 */
export function resolveEmergencyAuthority(grant: BreakGlassGrant, now: number): BreakGlassResolution {
  return resolveBreakGlass(grant, now);
}

/**
 * EMERGENCY STOP: revoke an active break-glass grant at `now`. Idempotent — a grant already revoked
 * or expired is returned unchanged. Revocation clamps the window so any subsequent resolution fails
 * closed. This is the operator-initiated kill switch for emergency access.
 */
export function emergencyStop(grant: BreakGlassGrant, now: number): BreakGlassGrant {
  if (grant.status === 'revoked' || grant.status === 'expired' || grant.status === 'reviewed') {
    return grant;
  }
  return { ...grant, status: 'revoked', expiresAt: Math.min(grant.expiresAt, now) };
}

export type BreakGlassMonitorState =
  | 'active'
  | 'expired_pending_review'
  | 'review_overdue'
  | 'reviewed'
  | 'revoked';

export interface BreakGlassMonitor {
  readonly state: BreakGlassMonitorState;
  /** True iff a mandatory post-event review is still owed (grant used, not yet reviewed). */
  readonly reviewOwed: boolean;
  /** True iff the review-due instant has passed without sign-off (escalate). */
  readonly reviewOverdue: boolean;
  readonly resolution: BreakGlassResolution;
}

/**
 * MONITORING + POST-EVENT REVIEW state of a grant at `now`. An active grant is monitored; an expired
 * or revoked grant that was never reviewed still OWES a post-event review; once past `reviewDueAt`
 * without a distinct reviewer sign-off it is REVIEW-OVERDUE and must be escalated (never silently
 * closed). A grant with status `reviewed` is complete. Determinism: `now` injected.
 */
export function monitorBreakGlass(grant: BreakGlassGrant, now: number): BreakGlassMonitor {
  const resolution = resolveBreakGlass(grant, now);
  if (grant.status === 'reviewed') {
    return { state: 'reviewed', reviewOwed: false, reviewOverdue: false, resolution };
  }
  if (grant.status === 'revoked') {
    const overdue = now >= grant.reviewDueAt;
    return { state: 'revoked', reviewOwed: true, reviewOverdue: overdue, resolution };
  }
  if (resolution.granted) {
    return { state: 'active', reviewOwed: false, reviewOverdue: false, resolution };
  }
  // Expired (or otherwise no-longer-granting) but not yet reviewed: review is owed.
  const overdue = now >= grant.reviewDueAt;
  return {
    state: overdue ? 'review_overdue' : 'expired_pending_review',
    reviewOwed: true,
    reviewOverdue: overdue,
    resolution,
  };
}

/**
 * Record the mandatory POST-EVENT review sign-off by the independent reviewer at `now`. Fails closed
 * if the signer is NOT the pre-declared independent reviewer (the grantee can never sign off their
 * own emergency access). Returns the grant advanced to `reviewed`, or null if refused.
 */
export function recordPostEventReview(
  grant: BreakGlassGrant,
  signerPrincipalId: string,
  now: number,
): BreakGlassGrant | null {
  if (signerPrincipalId !== grant.reviewerPrincipalId) return null;
  if (signerPrincipalId === grant.principalId) return null;
  return { ...grant, status: 'reviewed', reviewedAt: now };
}
