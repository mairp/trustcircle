// @trustcircle/application — COVERAGE ENGINE: reconstruct 100% compliance coverage for an EXACT scope
// and instant, with the readiness-vs-certification claim boundary and an honest gap set (Phase 7 /
// User Story 5 — Demonstrate Compliance and Audit Readiness / FR-031..035, FR-051..056, SC-012,
// SC-013, SC-022).
//
// The engine is a PURE, DETERMINISTIC fold over injected facts — publications, active applicability
// decisions, obligations, control mappings + their evaluations, assessments, and any external
// certification — at an injected `at` instant. It answers the SC-012 question: for every applicable
// obligation in scope, which control(s) cover it, in what evidence state, and where are the GAPS; and
// the SC-013 question: can a scoped coverage picture be RECONSTRUCTED for an exact (scope, time)
// without inference. It never infers current state from stale evidence, and it NEVER reports internal
// readiness as external certification: the `claimBoundary` reaches `certified` ONLY when a verifiable
// external certification is displayable at `at` (certificationIsDisplayable), otherwise it caps at the
// highest INTERNAL readiness boundary the evidence supports.

import {
  applicabilityIsActive,
  nonApplicabilityReopensGap,
  certificationIsDisplayable,
  isInternalClaim,
  type ApplicabilityDecision,
  type Obligation,
  type ControlMapping,
  type ExternalCertification,
  type ClaimBoundary,
  type Uuid,
  type EpochMillis,
} from '@trustcircle/domain';

/** A control's design/implementation/operating evaluation at an instant (mirrors control_evaluation). */
export interface ControlEvaluationFact {
  readonly controlMappingId: Uuid;
  readonly designState: 'designed' | 'deficient' | 'unknown';
  readonly implementationState: 'implemented' | 'partial' | 'not_implemented' | 'unknown';
  readonly operatingState: 'operating' | 'ineffective' | 'not_operating' | 'unknown';
  readonly evidenceSufficiency: 'sufficient' | 'stale' | 'insufficient';
  readonly latestEvidenceId?: Uuid;
  readonly latestEvidenceAt?: EpochMillis;
  readonly evaluatedAt: EpochMillis;
}

/** The exact scope a coverage picture is reconstructed for (SC-013). */
export interface CoverageScope {
  readonly tenantId: Uuid;
  readonly systemId?: Uuid;
  readonly publicationId?: Uuid;
}

export interface CoverageInputs {
  readonly scope: CoverageScope;
  readonly decisions: readonly ApplicabilityDecision[];
  readonly obligations: readonly Obligation[];
  readonly mappings: readonly ControlMapping[];
  readonly evaluations: readonly ControlEvaluationFact[];
  readonly certifications: readonly ExternalCertification[];
  /** The instant the coverage is reconstructed AS-OF (SC-013). */
  readonly at: EpochMillis;
}

export type CoverageGapKind =
  | 'unmapped_obligation' // an applicable obligation with no control mapping
  | 'no_evidence' // a mapped control with insufficient evidence
  | 'stale_evidence' // a mapped control whose evidence is stale (never inferred as current)
  | 'deficient_control' // a control that is deficient / not operating
  | 'reopened_non_applicability' // a stale not_applicable decision whose gap has reopened (FR-054)
  | 'expired_applicability'; // an applicability decision past its review instant

export interface CoverageGap {
  readonly kind: CoverageGapKind;
  readonly obligationId?: Uuid;
  readonly clauseVersionId?: Uuid;
  readonly controlMappingId?: Uuid;
  readonly decisionId?: Uuid;
  readonly detail: string;
}

export interface ObligationCoverage {
  readonly obligationId: Uuid;
  readonly clauseVersionId: Uuid;
  readonly mappingIds: readonly Uuid[];
  readonly covered: boolean;
  readonly boundary: ClaimBoundary;
}

export interface CoverageResult {
  readonly scope: CoverageScope;
  readonly at: EpochMillis;
  readonly obligationCount: number;
  readonly coveredCount: number;
  readonly obligations: readonly ObligationCoverage[];
  readonly gaps: readonly CoverageGap[];
  /** The single overall claim boundary — capped at readiness unless a certification is displayable. */
  readonly claimBoundary: ClaimBoundary;
  /** True iff EVERY applicable obligation in scope is covered with sufficient, non-stale evidence. */
  readonly complete: boolean;
}

function inScope(scope: CoverageScope, d: ApplicabilityDecision): boolean {
  if (d.tenantId !== scope.tenantId) return false;
  if (scope.systemId !== undefined && d.systemId !== scope.systemId) return false;
  return true;
}

/** The best claim boundary the control evaluations support (internal readiness ladder). */
function readinessBoundary(evals: readonly ControlEvaluationFact[]): ClaimBoundary {
  if (evals.length === 0) return 'incomplete';
  const allDesigned = evals.every((e) => e.designState === 'designed');
  const allImplemented = evals.every((e) => e.implementationState === 'implemented');
  const allOperating = evals.every((e) => e.operatingState === 'operating');
  const allSufficient = evals.every((e) => e.evidenceSufficiency === 'sufficient');
  if (allOperating && allImplemented && allDesigned && allSufficient) return 'ready';
  if (allOperating && allImplemented && allDesigned) return 'operating';
  if (allImplemented && allDesigned) return 'implemented';
  if (allDesigned) return 'design';
  return 'incomplete';
}

/** The ordinal of a claim boundary along the assurance ladder (lower = weaker). */
const BOUNDARY_ORDER: Readonly<Record<ClaimBoundary, number>> = Object.freeze({
  incomplete: 0,
  design: 1,
  implemented: 2,
  operating: 3,
  ready: 4,
  assessed: 5,
  certified: 6,
});

function minBoundary(a: ClaimBoundary, b: ClaimBoundary): ClaimBoundary {
  return BOUNDARY_ORDER[a] <= BOUNDARY_ORDER[b] ? a : b;
}

/**
 * Reconstruct the coverage picture for the exact (scope, at). Deterministic and inference-free: a
 * stale evaluation is reported as a `stale_evidence` gap, NOT silently treated as current; a stale
 * not_applicable decision REOPENS its gap (FR-054); and the overall `claimBoundary` is only
 * `certified` when a verifiable external certification is displayable at `at` — otherwise it is capped
 * at the internal readiness the evidence supports (readiness ≠ certification, FR-032/SC-012).
 */
export function reconstructCoverage(inputs: CoverageInputs): CoverageResult {
  const { scope, at } = inputs;
  const gaps: CoverageGap[] = [];

  // 1. Non-applicability that has gone stale reopens its gap (FR-054, SC-022).
  for (const d of inputs.decisions) {
    if (!inScope(scope, d)) continue;
    if (nonApplicabilityReopensGap(d, at)) {
      gaps.push({
        kind: 'reopened_non_applicability',
        decisionId: d.id,
        clauseVersionId: d.clauseVersionId,
        detail: `not_applicable decision expired at ${d.reviewAt}; gap reopened as of ${at}`,
      });
    }
    // An ACTIVE, applicable decision past its review instant is an expired-applicability gap.
    if (applicabilityIsActive(d) && d.proposedResult !== 'not_applicable' && at >= d.reviewAt) {
      gaps.push({
        kind: 'expired_applicability',
        decisionId: d.id,
        clauseVersionId: d.clauseVersionId,
        detail: `active applicability decision past its review instant ${d.reviewAt}`,
      });
    }
  }

  // 2. Per-obligation coverage.
  const obligations = inputs.obligations.filter((o) => o.tenantId === scope.tenantId);
  const evalByMapping = new Map<string, ControlEvaluationFact>();
  for (const e of inputs.evaluations) evalByMapping.set(e.controlMappingId, e);

  const obligationCoverage: ObligationCoverage[] = [];
  let coveredCount = 0;
  let overall: ClaimBoundary = obligations.length === 0 ? 'incomplete' : 'ready';

  for (const o of obligations) {
    const mappings = inputs.mappings.filter((m) => m.obligationId === o.id);
    if (mappings.length === 0) {
      gaps.push({
        kind: 'unmapped_obligation',
        obligationId: o.id,
        clauseVersionId: o.clauseVersionId,
        detail: 'applicable obligation has no control mapping',
      });
      obligationCoverage.push({
        obligationId: o.id,
        clauseVersionId: o.clauseVersionId,
        mappingIds: [],
        covered: false,
        boundary: 'incomplete',
      });
      overall = minBoundary(overall, 'incomplete');
      continue;
    }

    const evals: ControlEvaluationFact[] = [];
    for (const m of mappings) {
      const e = evalByMapping.get(m.id);
      if (e === undefined || e.evidenceSufficiency === 'insufficient') {
        gaps.push({
          kind: 'no_evidence',
          obligationId: o.id,
          controlMappingId: m.id,
          detail: 'mapped control has insufficient evidence',
        });
        continue;
      }
      if (e.evidenceSufficiency === 'stale') {
        gaps.push({
          kind: 'stale_evidence',
          obligationId: o.id,
          controlMappingId: m.id,
          detail: `evidence stale as of ${at}; current state not inferred`,
        });
      }
      if (
        e.designState === 'deficient' ||
        e.operatingState === 'not_operating' ||
        e.operatingState === 'ineffective'
      ) {
        gaps.push({
          kind: 'deficient_control',
          obligationId: o.id,
          controlMappingId: m.id,
          detail: `control deficient/not-operating (design=${e.designState}, operating=${e.operatingState})`,
        });
      }
      evals.push(e);
    }

    const boundary = readinessBoundary(evals);
    const covered =
      evals.length === mappings.length &&
      evals.every((e) => e.evidenceSufficiency === 'sufficient') &&
      boundary === 'ready';
    if (covered) coveredCount += 1;
    obligationCoverage.push({
      obligationId: o.id,
      clauseVersionId: o.clauseVersionId,
      mappingIds: mappings.map((m) => m.id),
      covered,
      boundary,
    });
    overall = minBoundary(overall, boundary);
  }

  // 3. External certification lifts the boundary to `certified` ONLY when displayable at `at`.
  let claimBoundary: ClaimBoundary = overall;
  const displayableCert = inputs.certifications.find(
    (c) =>
      c.tenantId === scope.tenantId &&
      (scope.publicationId === undefined || c.publicationId === scope.publicationId) &&
      certificationIsDisplayable(c, at),
  );
  if (displayableCert !== undefined && overall === 'ready' && gaps.length === 0) {
    claimBoundary = 'certified';
  } else if (isInternalClaim(overall)) {
    // Cap at the internal readiness boundary; never masquerade readiness as certification.
    claimBoundary = overall;
  }

  const complete =
    obligations.length > 0 && coveredCount === obligations.length && gaps.length === 0;

  return Object.freeze({
    scope,
    at,
    obligationCount: obligations.length,
    coveredCount,
    obligations: Object.freeze(obligationCoverage),
    gaps: Object.freeze(gaps),
    claimBoundary,
    complete,
  });
}

/** The count of distinct references a scoped coverage reconstruction touches (SC-013 ≤ 100,000). */
export function coverageReferenceCount(inputs: CoverageInputs): number {
  return (
    inputs.decisions.length +
    inputs.obligations.length +
    inputs.mappings.length +
    inputs.evaluations.length +
    inputs.certifications.length
  );
}
