// @trustcircle/application — CORRECTIVE ACTION: turn a nonconformity FINDING into a correction, a root
// cause, a corrective action, an effectiveness review, and a verified closure (Phase 7 / User Story 5
// — Demonstrate Compliance and Audit Readiness / FR-034).
//
// A finding retains its severity, owner, due date, and evidence (FR-031). Its corrective action MUST
// declare a root cause (a corrective action without a root cause is refused), and CLOSURE requires a
// VERIFIED-effective result — a finding is never silently closed, and observed recurrence REOPENS it.
// Pure functions over injected facts; every instant injected.

import type { Uuid, EpochMillis } from '@trustcircle/domain';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FindingStatus =
  'open' | 'in_progress' | 'remediated' | 'verified' | 'closed' | 'reopened';

export interface ComplianceFinding {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly auditId?: Uuid;
  readonly obligationId?: Uuid;
  readonly severity: FindingSeverity;
  readonly ownerPrincipalId: Uuid;
  readonly dueAt: EpochMillis;
  readonly status: FindingStatus;
  readonly evidenceIds: readonly Uuid[];
  readonly verificationResult?: 'effective' | 'ineffective';
  readonly residualRiskAccepted: boolean;
}

export type CorrectiveStatus =
  'open' | 'in_progress' | 'implemented' | 'verified' | 'closed' | 'reopened';

export interface CorrectiveAction {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly findingId: Uuid;
  readonly correction: string;
  readonly rootCause: string;
  readonly action: string;
  readonly ownerPrincipalId: Uuid;
  readonly dueAt: EpochMillis;
  readonly effectivenessResult?: 'effective' | 'ineffective';
  readonly recurrenceObserved: boolean;
  readonly status: CorrectiveStatus;
}

export interface RaiseFindingCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly auditId?: Uuid;
  readonly obligationId?: Uuid;
  readonly severity: FindingSeverity;
  readonly ownerPrincipalId: Uuid;
  readonly dueAt: EpochMillis;
  readonly evidenceIds?: readonly Uuid[];
}

/** Raise a nonconformity finding (open), retaining its severity/owner/due/evidence (FR-031). */
export function raiseFinding(cmd: RaiseFindingCommand): ComplianceFinding {
  return Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    ...(cmd.auditId ? { auditId: cmd.auditId } : {}),
    ...(cmd.obligationId ? { obligationId: cmd.obligationId } : {}),
    severity: cmd.severity,
    ownerPrincipalId: cmd.ownerPrincipalId,
    dueAt: cmd.dueAt,
    status: 'open',
    evidenceIds: Object.freeze([...(cmd.evidenceIds ?? [])]),
    residualRiskAccepted: false,
  });
}

export type CorrectiveRejectionCode =
  'MISSING_ROOT_CAUSE' | 'MISSING_CORRECTION' | 'MISSING_ACTION';

export interface OpenCorrectiveCommand {
  readonly id: Uuid;
  readonly finding: ComplianceFinding;
  readonly correction: string;
  readonly rootCause: string;
  readonly action: string;
  readonly ownerPrincipalId: Uuid;
  readonly dueAt: EpochMillis;
}

export interface CorrectiveOutcome {
  readonly accepted: boolean;
  readonly correctiveAction: CorrectiveAction | null;
  readonly rejectionCode: CorrectiveRejectionCode | null;
}

function blank(s: string): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

/** Open a corrective action — REQUIRES a non-empty correction, root cause, and action. */
export function openCorrectiveAction(cmd: OpenCorrectiveCommand): CorrectiveOutcome {
  if (blank(cmd.correction))
    return { accepted: false, correctiveAction: null, rejectionCode: 'MISSING_CORRECTION' };
  if (blank(cmd.rootCause))
    return { accepted: false, correctiveAction: null, rejectionCode: 'MISSING_ROOT_CAUSE' };
  if (blank(cmd.action))
    return { accepted: false, correctiveAction: null, rejectionCode: 'MISSING_ACTION' };
  const ca: CorrectiveAction = Object.freeze({
    id: cmd.id,
    tenantId: cmd.finding.tenantId,
    findingId: cmd.finding.id,
    correction: cmd.correction,
    rootCause: cmd.rootCause,
    action: cmd.action,
    ownerPrincipalId: cmd.ownerPrincipalId,
    dueAt: cmd.dueAt,
    recurrenceObserved: false,
    status: 'open',
  });
  return { accepted: true, correctiveAction: ca, rejectionCode: null };
}

export type CloseRejectionCode = 'NOT_VERIFIED_EFFECTIVE' | 'RECURRENCE_OBSERVED';

export interface CloseCorrectiveOutcome {
  readonly accepted: boolean;
  readonly correctiveAction: CorrectiveAction;
  readonly rejectionCode: CloseRejectionCode | null;
}

/** Record the effectiveness review result of a corrective action. */
export function reviewEffectiveness(
  ca: CorrectiveAction,
  result: 'effective' | 'ineffective',
  recurrenceObserved: boolean,
): CorrectiveAction {
  return Object.freeze({
    ...ca,
    effectivenessResult: result,
    recurrenceObserved,
    status: recurrenceObserved ? 'reopened' : result === 'effective' ? 'verified' : 'in_progress',
  });
}

/** Close a corrective action — REQUIRES a verified-effective review and NO observed recurrence. */
export function closeCorrectiveAction(ca: CorrectiveAction): CloseCorrectiveOutcome {
  if (ca.recurrenceObserved)
    return { accepted: false, correctiveAction: ca, rejectionCode: 'RECURRENCE_OBSERVED' };
  if (ca.effectivenessResult !== 'effective' || ca.status !== 'verified') {
    return { accepted: false, correctiveAction: ca, rejectionCode: 'NOT_VERIFIED_EFFECTIVE' };
  }
  return {
    accepted: true,
    correctiveAction: Object.freeze({ ...ca, status: 'closed' }),
    rejectionCode: null,
  };
}

/** True iff a finding is overdue at `now` (open/in-progress past its due instant). */
export function findingOverdue(f: ComplianceFinding, now: EpochMillis): boolean {
  return (
    (f.status === 'open' || f.status === 'in_progress' || f.status === 'reopened') && now >= f.dueAt
  );
}
