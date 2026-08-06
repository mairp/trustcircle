// @trustcircle/application — EXTERNAL ASSURANCE: record and DISPLAY external certifications truthfully
// (Phase 7 / User Story 5 — Demonstrate Compliance and Audit Readiness / FR-032, FR-055, SC-012).
//
// This service is the guardian of the readiness ≠ certification boundary. An external certification is
// only ever DISPLAYED as `certified` when it is verifiable and displayable at the query instant
// (a real issuer, certificate id, verifiable external-evidence reference, `valid` status, within its
// validity window — certificationIsDisplayable). An internal readiness or external ASSESSMENT result
// is NEVER promoted to `certified`. Pure functions over injected facts; every instant injected.

import {
  makeExternalCertification,
  externalCertificationDigest,
  certificationIsDisplayable,
  type ExternalCertification,
  type CertificationStatus,
  type ClaimBoundary,
  type Assessment,
  type Uuid,
  type EpochMillis,
} from '@trustcircle/domain';

export interface RecordCertificationCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly publicationId: Uuid;
  readonly issuer: string;
  readonly certificateId: string;
  readonly scope?: Record<string, unknown>;
  readonly validFrom: EpochMillis;
  readonly validUntil: EpochMillis;
  readonly status?: CertificationStatus;
  readonly verificationUri: string;
  readonly now: EpochMillis;
}

export interface CertificationOutcome {
  readonly certification: ExternalCertification;
  readonly digest: string;
}

/**
 * Record an external certification. Throws (via the domain factory) unless it carries a verifiable
 * issuer, certificate id, verification URI, and an ordered validity window — a certification without
 * verifiable external evidence is never recorded (FR-055).
 */
export function recordCertification(cmd: RecordCertificationCommand): CertificationOutcome {
  const certification = makeExternalCertification({
    id: cmd.id,
    tenantId: cmd.tenantId,
    publicationId: cmd.publicationId,
    issuer: cmd.issuer,
    certificateId: cmd.certificateId,
    ...(cmd.scope ? { scope: cmd.scope } : {}),
    validFrom: cmd.validFrom,
    validUntil: cmd.validUntil,
    status: cmd.status ?? 'valid',
    verificationUri: cmd.verificationUri,
    version: 1,
    createdAt: cmd.now,
  });
  return { certification, digest: externalCertificationDigest(certification) };
}

/**
 * The claim boundary that may be DISPLAYED for a publication at `now`, given the best internal
 * readiness boundary, any external assessment, and any external certification. The result is
 * `certified` ONLY when a certification is displayable; otherwise it caps at `assessed` (a real
 * external assessment) or the internal readiness boundary — NEVER promoting readiness to certification.
 */
export function displayableClaimBoundary(input: {
  readonly readiness: ClaimBoundary;
  readonly assessments: readonly Assessment[];
  readonly certifications: readonly ExternalCertification[];
  readonly publicationId?: Uuid;
  readonly now: EpochMillis;
}): ClaimBoundary {
  const displayableCert = input.certifications.find(
    (c) =>
      (input.publicationId === undefined || c.publicationId === input.publicationId) &&
      certificationIsDisplayable(c, input.now),
  );
  if (displayableCert !== undefined) return 'certified';

  const hasExternalAssessment = input.assessments.some(
    (a) => a.kind === 'external_assessment' && (a.result === 'conforming' || a.result === 'ready'),
  );
  if (hasExternalAssessment) return 'assessed';

  // No external assurance — the boundary is exactly the internal readiness (never higher).
  return input.readiness;
}

/** True iff `c` may be displayed as an external certification at `now` (delegates to the domain oracle). */
export function certificationDisplayable(c: ExternalCertification, now: EpochMillis): boolean {
  return certificationIsDisplayable(c, now);
}
