// @trustcircle/application — CONTROL-MAPPING SERVICE: derive obligations from ACTIVE applicability
// decisions and map them many-to-many to controls with shared responsibility + evidence expectations
// (Phase 7 / User Story 5 — Demonstrate Compliance and Audit Readiness / FR-031, FR-034, SC-012).
//
// PURE functions over injected facts: an ACTIVE applicability decision yields an Obligation only when
// its clause carries organizational duties (a guidance/certification-body clause never becomes a
// tenant obligation for an ordinary tenant); an Obligation may be mapped to MANY controls, each with a
// declared responsibility (organization/platform/shared/external) and the evidence it must produce.
// No wall clock, no randomness (createdAt/reviewAt injected).

import {
  makeObligation,
  makeControlMapping,
  obligationDigest,
  controlMappingDigest,
  applicabilityIsActive,
  publicationDutyClass,
  type ApplicabilityDecision,
  type StandardPublication,
  type Obligation,
  type ControlMapping,
  type ResponsibilityParty,
  type DutyClass,
  type Uuid,
  type EpochMillis,
} from '@trustcircle/domain';

export type ObligationDerivationCode =
  | 'NOT_ACTIVE' // the applicability decision has not passed independent review
  | 'NOT_APPLICABLE' // the decision is not_applicable — no obligation is derived
  | 'NOT_AN_OBLIGATION'; // the clause is guidance / certification-body criteria — no tenant duty

export interface ObligationDerivationInput {
  readonly id: Uuid;
  readonly decision: ApplicabilityDecision;
  readonly publication: StandardPublication;
  /** True iff the tenant is itself an accredited certification body for this scope (FR-055). */
  readonly actsAsCertificationBody?: boolean;
  readonly ownerPrincipalId: Uuid;
  readonly reviewAt: EpochMillis;
  readonly now: EpochMillis;
}

export interface ObligationDerivationOutcome {
  readonly derived: boolean;
  readonly obligation: Obligation | null;
  readonly dutyClass: DutyClass;
  readonly digest: string | null;
  readonly rejectionCode: ObligationDerivationCode | null;
}

/**
 * Derive the Obligation an ACTIVE, APPLICABLE decision creates for a control owner. Returns
 * `derived: false` (with a code) when the decision is not active, is not_applicable, or the clause
 * carries no organizational duty for the scope — so a non-obligation is never silently minted.
 */
export function deriveObligation(input: ObligationDerivationInput): ObligationDerivationOutcome {
  const dutyClass = publicationDutyClass(input.publication, input.actsAsCertificationBody ?? false);

  if (!applicabilityIsActive(input.decision)) {
    return { derived: false, obligation: null, dutyClass, digest: null, rejectionCode: 'NOT_ACTIVE' };
  }
  if (input.decision.proposedResult === 'not_applicable') {
    return { derived: false, obligation: null, dutyClass, digest: null, rejectionCode: 'NOT_APPLICABLE' };
  }
  if (dutyClass !== 'organizational_obligation') {
    return { derived: false, obligation: null, dutyClass, digest: null, rejectionCode: 'NOT_AN_OBLIGATION' };
  }

  const obligation = makeObligation({
    id: input.id,
    tenantId: input.decision.tenantId,
    clauseVersionId: input.decision.clauseVersionId,
    applicabilityDecisionId: input.decision.id,
    dutyClass,
    ownerPrincipalId: input.ownerPrincipalId,
    reviewAt: input.reviewAt,
    version: 1,
    createdAt: input.now,
  });
  return {
    derived: true,
    obligation,
    dutyClass,
    digest: obligationDigest(obligation),
    rejectionCode: null,
  };
}

export interface ControlMappingInput {
  readonly id: Uuid;
  readonly obligation: Obligation;
  readonly controlId: Uuid;
  readonly responsibility: ResponsibilityParty;
  readonly evidenceExpectations: readonly string[];
  readonly evidenceWindowMillis: number;
  readonly reviewAt: EpochMillis;
  readonly now: EpochMillis;
}

export interface ControlMappingOutcome {
  readonly mapping: ControlMapping;
  readonly digest: string;
}

/**
 * Map an obligation to a control with a declared responsibility and evidence expectations. Throws
 * (via the domain factory) on an empty evidence-expectation set or non-positive evidence window — a
 * mapping with no verifiable evidence expectation is never created (FR-031).
 */
export function mapObligationToControl(input: ControlMappingInput): ControlMappingOutcome {
  const mapping = makeControlMapping({
    id: input.id,
    tenantId: input.obligation.tenantId,
    obligationId: input.obligation.id,
    controlId: input.controlId,
    responsibility: input.responsibility,
    evidenceExpectations: input.evidenceExpectations,
    evidenceWindowMillis: input.evidenceWindowMillis,
    reviewAt: input.reviewAt,
    version: 1,
    createdAt: input.now,
  });
  return { mapping, digest: controlMappingDigest(mapping) };
}

/** True iff a control is fully covered by the ORGANIZATION (no external/shared dependency it owns). */
export function isOrganizationOwned(m: ControlMapping): boolean {
  return m.responsibility === 'organization';
}
