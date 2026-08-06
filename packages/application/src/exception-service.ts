// @trustcircle/application — EXCEPTION SERVICE: grant, review, and close EXPIRING compliance
// exceptions with a mandatory risk authority and compensating controls (Phase 7 / User Story 5 —
// Demonstrate Compliance and Audit Readiness / FR-034, SC-022).
//
// An exception temporarily accepts an un-met obligation. It MUST carry a structured reason, a risk
// authority (who accepted the residual risk), compensating controls, and an EXPIRY — there is NO
// silent renewal, and closure MUST be verified. A lapsed exception REOPENS the obligation's gap (the
// coverage engine surfaces it). Pure functions over injected facts; every instant injected.

import type { Uuid, EpochMillis, Reason } from '@trustcircle/domain';

export type ExceptionStatus = 'active' | 'expired' | 'closed' | 'revoked';

export interface ComplianceException {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly obligationId: Uuid;
  readonly reason: Reason;
  readonly riskAuthorityId: Uuid;
  readonly compensatingControls: readonly Uuid[];
  readonly grantedAt: EpochMillis;
  readonly expiresAt: EpochMillis;
  readonly reviewAt: EpochMillis;
  readonly status: ExceptionStatus;
  readonly closureVerifiedBy?: Uuid;
}

export type ExceptionRejectionCode =
  | 'MISSING_REASON'
  | 'MISSING_RISK_AUTHORITY'
  | 'NON_EXPIRING'
  | 'CLOSURE_NOT_VERIFIED'
  | 'ALREADY_TERMINAL';

export interface GrantExceptionCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly obligationId: Uuid;
  readonly reason: Reason;
  readonly riskAuthorityId: Uuid;
  readonly compensatingControls: readonly Uuid[];
  readonly expiresAt: EpochMillis;
  readonly reviewAt: EpochMillis;
  readonly now: EpochMillis;
}

export interface ExceptionOutcome {
  readonly accepted: boolean;
  readonly exception: ComplianceException | null;
  readonly rejectionCode: ExceptionRejectionCode | null;
}

function reasonOk(r: Reason | undefined | null): boolean {
  return !!r && typeof r.code === 'string' && r.code.trim().length > 0 && typeof r.text === 'string' && r.text.trim().length >= 3;
}

/** Grant an expiring exception. Refuses a missing reason, a missing risk authority, or a non-expiring window. */
export function grantException(cmd: GrantExceptionCommand): ExceptionOutcome {
  if (!reasonOk(cmd.reason)) return { accepted: false, exception: null, rejectionCode: 'MISSING_REASON' };
  if (typeof cmd.riskAuthorityId !== 'string' || cmd.riskAuthorityId.length === 0) {
    return { accepted: false, exception: null, rejectionCode: 'MISSING_RISK_AUTHORITY' };
  }
  if (!(cmd.now < cmd.expiresAt)) {
    return { accepted: false, exception: null, rejectionCode: 'NON_EXPIRING' };
  }
  const exception: ComplianceException = Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    obligationId: cmd.obligationId,
    reason: cmd.reason,
    riskAuthorityId: cmd.riskAuthorityId,
    compensatingControls: Object.freeze([...cmd.compensatingControls]),
    grantedAt: cmd.now,
    expiresAt: cmd.expiresAt,
    reviewAt: cmd.reviewAt,
    status: 'active',
  });
  return { accepted: true, exception, rejectionCode: null };
}

/** True iff the exception has lapsed at `now` (its expiry passed) and must reopen the gap — no renewal. */
export function exceptionHasLapsed(e: ComplianceException, now: EpochMillis): boolean {
  return e.status === 'active' && now >= e.expiresAt;
}

/** Close an exception — REQUIRES a verifier (no silent closure). Refuses a terminal exception. */
export function closeException(
  e: ComplianceException,
  closureVerifiedBy: Uuid | null,
): ExceptionOutcome {
  if (e.status !== 'active') return { accepted: false, exception: e, rejectionCode: 'ALREADY_TERMINAL' };
  if (typeof closureVerifiedBy !== 'string' || closureVerifiedBy.length === 0) {
    return { accepted: false, exception: e, rejectionCode: 'CLOSURE_NOT_VERIFIED' };
  }
  return {
    accepted: true,
    exception: Object.freeze({ ...e, status: 'closed', closureVerifiedBy }),
    rejectionCode: null,
  };
}

/** Mark a lapsed exception expired (system housekeeping). Idempotent on non-active exceptions. */
export function expireException(e: ComplianceException, now: EpochMillis): ComplianceException {
  if (e.status === 'active' && now >= e.expiresAt) return Object.freeze({ ...e, status: 'expired' });
  return e;
}
