// @trustcircle/application — IMPACT ASSESSMENT: ISO/IEC 42005 AI-system impact assessments (Phase 7 /
// User Story 5 — Demonstrate Compliance and Audit Readiness / FR-034).
//
// An impact assessment identifies affected parties, potential harms/benefits, uncertainty, mitigations,
// and residual impacts for an AI system, is APPROVED by an authority, carries an access class, and has
// a reassessment date. Pure functions over injected facts; every instant injected. A blank
// affected-parties set is refused (an impact assessment with no affected parties is vacuous). A stale
// assessment is surfaced for reassessment (never inferred as still-current).

import type { Uuid, EpochMillis } from '@trustcircle/domain';

export type Uncertainty = 'low' | 'medium' | 'high';
export type AccessClass = 'public' | 'restricted' | 'confidential';

export interface ImpactAssessment {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly systemId: Uuid;
  readonly affectedParties: readonly string[];
  readonly uncertainty: Uncertainty;
  readonly mitigations: readonly string[];
  readonly residualImpacts: readonly string[];
  readonly approvedBy?: Uuid;
  readonly approvedAt?: EpochMillis;
  readonly accessClass: AccessClass;
  readonly reassessAt: EpochMillis;
  readonly version: number;
}

export interface AssessImpactCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly systemId: Uuid;
  readonly affectedParties: readonly string[];
  readonly uncertainty: Uncertainty;
  readonly mitigations?: readonly string[];
  readonly residualImpacts?: readonly string[];
  readonly accessClass?: AccessClass;
  readonly reassessAt: EpochMillis;
  readonly version?: number;
}

/** Draft an impact assessment (unapproved). Throws on an empty affected-parties set (fail-visible). */
export function assessImpact(cmd: AssessImpactCommand): ImpactAssessment {
  if (!Array.isArray(cmd.affectedParties) || cmd.affectedParties.length < 1) {
    throw new TypeError('impact.affectedParties must be a non-empty array (ISO/IEC 42005)');
  }
  return Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    systemId: cmd.systemId,
    affectedParties: Object.freeze([...cmd.affectedParties]),
    uncertainty: cmd.uncertainty,
    mitigations: Object.freeze([...(cmd.mitigations ?? [])]),
    residualImpacts: Object.freeze([...(cmd.residualImpacts ?? [])]),
    accessClass: cmd.accessClass ?? 'restricted',
    reassessAt: cmd.reassessAt,
    version: cmd.version ?? 1,
  });
}

export type ImpactRejectionCode = 'NO_APPROVING_AUTHORITY';

export interface ApproveImpactOutcome {
  readonly accepted: boolean;
  readonly assessment: ImpactAssessment;
  readonly rejectionCode: ImpactRejectionCode | null;
}

/** Approve an impact assessment — REQUIRES an approving authority. */
export function approveImpact(
  a: ImpactAssessment,
  approvedBy: Uuid | null,
  now: EpochMillis,
): ApproveImpactOutcome {
  if (typeof approvedBy !== 'string' || approvedBy.length === 0) {
    return { accepted: false, assessment: a, rejectionCode: 'NO_APPROVING_AUTHORITY' };
  }
  return {
    accepted: true,
    assessment: Object.freeze({ ...a, approvedBy, approvedAt: now }),
    rejectionCode: null,
  };
}

/** True iff the assessment is past its reassessment instant (must be re-run, never inferred current). */
export function impactNeedsReassessment(a: ImpactAssessment, now: EpochMillis): boolean {
  return now >= a.reassessAt;
}

/** True iff the assessment is APPROVED (has an approving authority + instant). */
export function impactIsApproved(a: ImpactAssessment): boolean {
  return typeof a.approvedBy === 'string' && a.approvedBy.length > 0 && a.approvedAt !== undefined;
}
