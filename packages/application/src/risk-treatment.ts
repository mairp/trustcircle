// @trustcircle/application — RISK TREATMENT: assess a compliance risk, choose a treatment option,
// own it, plan milestones, and record residual-risk acceptance with authority (Phase 7 / User Story 5
// — Demonstrate Compliance and Audit Readiness / FR-034).
//
// Pure functions over injected facts; every instant injected. Residual-risk ACCEPTANCE requires an
// explicit accepting authority — a risk is never silently accepted. A risk retains its reassessment
// date; a risk past reassessment is surfaced (never inferred as still-current).

import type { Uuid, EpochMillis, Reason } from '@trustcircle/domain';

export type Likelihood = 'low' | 'medium' | 'high';
export type Impact = 'low' | 'medium' | 'high' | 'critical';
export type TreatmentOption = 'accept' | 'mitigate' | 'transfer' | 'avoid';
export type RiskStatus = 'open' | 'treated' | 'accepted' | 'closed';

export interface ComplianceRisk {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly obligationId?: Uuid;
  readonly title: string;
  readonly likelihood: Likelihood;
  readonly impact: Impact;
  readonly ownerPrincipalId: Uuid;
  readonly treatmentOption: TreatmentOption;
  readonly residualAccepted: boolean;
  readonly acceptedBy?: Uuid;
  readonly reassessAt: EpochMillis;
  readonly status: RiskStatus;
}

export interface AssessRiskCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly obligationId?: Uuid;
  readonly title: string;
  readonly likelihood: Likelihood;
  readonly impact: Impact;
  readonly ownerPrincipalId: Uuid;
  readonly treatmentOption: TreatmentOption;
  readonly reassessAt: EpochMillis;
}

/** Assess and open a risk with a chosen treatment. Throws on a blank title (fail-visible). */
export function assessRisk(cmd: AssessRiskCommand): ComplianceRisk {
  if (typeof cmd.title !== 'string' || cmd.title.trim().length === 0) {
    throw new TypeError('risk.title must be a non-empty string');
  }
  return Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    ...(cmd.obligationId ? { obligationId: cmd.obligationId } : {}),
    title: cmd.title,
    likelihood: cmd.likelihood,
    impact: cmd.impact,
    ownerPrincipalId: cmd.ownerPrincipalId,
    treatmentOption: cmd.treatmentOption,
    residualAccepted: false,
    reassessAt: cmd.reassessAt,
    status: cmd.treatmentOption === 'accept' ? 'open' : 'treated',
  });
}

export type RiskTreatmentRejectionCode = 'NO_ACCEPTING_AUTHORITY' | 'MISSING_REASON';

export interface AcceptResidualOutcome {
  readonly accepted: boolean;
  readonly risk: ComplianceRisk;
  readonly rejectionCode: RiskTreatmentRejectionCode | null;
}

/** Accept the residual risk — REQUIRES an accepting authority AND a structured reason. */
export function acceptResidualRisk(
  risk: ComplianceRisk,
  acceptedBy: Uuid | null,
  reason: Reason,
): AcceptResidualOutcome {
  if (typeof acceptedBy !== 'string' || acceptedBy.length === 0) {
    return { accepted: false, risk, rejectionCode: 'NO_ACCEPTING_AUTHORITY' };
  }
  if (!reason || typeof reason.text !== 'string' || reason.text.trim().length < 3) {
    return { accepted: false, risk, rejectionCode: 'MISSING_REASON' };
  }
  return {
    accepted: true,
    risk: Object.freeze({ ...risk, residualAccepted: true, acceptedBy, status: 'accepted' }),
    rejectionCode: null,
  };
}

export interface TreatmentMilestone {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly riskId: Uuid;
  readonly description: string;
  readonly dueAt: EpochMillis;
  readonly status: 'planned' | 'in_progress' | 'done' | 'overdue';
}

/** A milestone's status AS-OF `now`: a planned/in-progress milestone past due is `overdue` (not inferred done). */
export function milestoneStatusAsOf(m: TreatmentMilestone, now: EpochMillis): TreatmentMilestone['status'] {
  if (m.status === 'done') return 'done';
  return now >= m.dueAt ? 'overdue' : m.status;
}

/** True iff a risk is past its reassessment instant and must be re-evaluated (never inferred current). */
export function riskNeedsReassessment(r: ComplianceRisk, now: EpochMillis): boolean {
  return r.status !== 'closed' && now >= r.reassessAt;
}
