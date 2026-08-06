// Test fixtures — a deterministic, multi-scenario COMPLIANCE-COVERAGE projection for Phase 7 /
// User Story 5 (Demonstrate Compliance and Audit Readiness). Seeds every compliance shape the
// coverage engine, the compliance projector, the standards / applicability / compliance API routes,
// the audit-export worker, and the accessible web surfaces (CoverageView / ApplicabilityReview /
// EvidenceExplorer / AuditExplorer) consume — so a scenario can assert a genuine facet, never a
// mutation echo.
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FIXTURE EXISTS  (T216 — FR-031..035, FR-051..056, SC-012, SC-013, SC-022)
// ───────────────────────────────────────────────────────────────────────────────────────────────
// The unit / contract / integration / performance / e2e suites (T184..T189) and the
// standards-applicability scenario runner (T217) all mount the REAL domain factories + the REAL
// application coverage engine over this ONE fixed set of rows and assert the SC-012 coverage picture,
// the readiness-vs-certification claim boundary (FR-032 / FR-055), the reconstruct-at-instant property
// (SC-013), and the honest gap set (FR-054). Every scenario carries a `witness` + `observedVia`
// naming the exact durable read path an assertion pins, so no assertion is vacuous.
//
// The SEVEN seeded coverage scenarios:
//   1. READY        — an active, independently-reviewed applicability + a fully-covered obligation
//                     whose single control is designed/implemented/operating with SUFFICIENT evidence
//                     → claimBoundary === 'ready', complete === true, zero gaps (SC-012).
//   2. CERTIFIED    — the READY scope PLUS a verifiable, in-window external certification
//                     → claimBoundary === 'certified' (only a displayable certification reaches it).
//   3. READINESS≠CERT — the same readiness picture but with an EXPIRED certification
//                     → claimBoundary caps at 'ready'; internal readiness NEVER shows as certified.
//   4. STALE        — a mapped control whose evidence is stale → a `stale_evidence` gap; current state
//                     is NOT inferred (SC-012 / FR-054); boundary drops below 'ready'.
//   5. UNMAPPED     — an applicable obligation with no control mapping → an `unmapped_obligation` gap.
//   6. REOPENED-NA  — a not_applicable decision whose review instant has PASSED → its gap REOPENS
//                     (`reopened_non_applicability`), so a stale non-applicability cannot silence a gap.
//   7. CROSS-TENANT — an identical obligation owned by ANOTHER tenant; it must NEVER appear in this
//                     tenant's reconstructed coverage (tenant isolation).
//
// DETERMINISM. No wall clock, no I/O, no crypto RNG. The clock is the fixed `NOW`; ids are derived
// from readable slugs via `uuidFromSlug` (sha256 of the slug, laid out as a valid v7-shaped UUID), so
// the whole projection — including id tails — is byte-identical every call. Same input ⇒ same output.

import { createHash } from 'node:crypto';

import {
  toUuid,
  makeReason,
  PLATFORM_SCOPE,
  makeStandardPublication,
  makeClauseVersion,
  makeApplicabilityDecision,
  makeObligation,
  makeControlMapping,
  makeAssessment,
  makeExternalCertification,
  publicationDutyClass,
  type Uuid,
  type EpochMillis,
  type TenantId,
  type Reason,
  type StandardPublication,
  type ClauseVersion,
  type ApplicabilityDecision,
  type Obligation,
  type ControlMapping,
  type Assessment,
  type ExternalCertification,
} from '@trustcircle/domain';

import {
  reconstructCoverage,
  coverageReferenceCount,
  type ControlEvaluationFact,
  type CoverageScope,
  type CoverageInputs,
  type CoverageResult,
} from '@trustcircle/application';

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Fixed clock + spans.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** The single fixed evaluation instant every scenario is reconstructed AT (SC-013). */
export const NOW: EpochMillis = 1_772_050_000_000 as EpochMillis;

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_YEAR = 365 * ONE_DAY;

/**
 * A deterministic, legible-in-source UUID derived from a readable slug. The slug is sha256'd and the
 * digest is laid out as a canonical, version-7-shaped UUID (version nibble '7', variant nibble in
 * 8–b). Pure — no clock, no crypto RNG — so the whole projection is byte-identical every run while
 * every id remains a syntactically valid UUID the domain factories accept.
 */
function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`compliance-fixture:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const canonical = `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return toUuid(canonical);
}

/** Deterministic ISO string — no wall-clock read; constructed from the fixed epoch. */
export function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Stable tenants + principals (legible slugs).
// ───────────────────────────────────────────────────────────────────────────────────────────────

export const TENANT: TenantId = uuidFromSlug('tenant-home-compliance') as unknown as TenantId;
export const OTHER_TENANT: TenantId = uuidFromSlug('tenant-other-compliance') as unknown as TenantId;

export const COMPLIANCE_OWNER: Uuid = uuidFromSlug('principal-compliance-owner-quinn');
export const INDEPENDENT_REVIEWER: Uuid = uuidFromSlug('principal-independent-reviewer-avery');
export const CONTROL_OWNER: Uuid = uuidFromSlug('principal-control-owner-devon');
export const AUDITOR: Uuid = uuidFromSlug('principal-auditor-morgan');
export const ASSESSOR: Uuid = uuidFromSlug('principal-external-assessor-blake');

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The scenario catalogue (each maps to an acceptance criterion + its durable witness).
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type CoverageScenarioName =
  | 'ready'
  | 'certified'
  | 'readiness-not-certification'
  | 'stale'
  | 'unmapped'
  | 'reopened-non-applicability'
  | 'cross-tenant';

export interface CoverageScenarioSpec {
  readonly scenario: CoverageScenarioName;
  /** The seeded fact an assertion pins. */
  readonly witness: string;
  /** The durable read path the fact is observed through (never a mutation response). */
  readonly observedVia: string;
}

export const SEVEN_COVERAGE_SCENARIOS: readonly CoverageScenarioSpec[] = [
  {
    scenario: 'ready',
    witness: 'active reviewed applicability + a fully-covered obligation with sufficient evidence',
    observedVia: "reconstructCoverage(readyScope).claimBoundary === 'ready' && complete === true && gaps.length === 0",
  },
  {
    scenario: 'certified',
    witness: 'the ready picture PLUS a verifiable, in-window external certification',
    observedVia: "reconstructCoverage(certifiedScope).claimBoundary === 'certified'",
  },
  {
    scenario: 'readiness-not-certification',
    witness: 'the same readiness picture but the certification is EXPIRED at NOW',
    observedVia: "reconstructCoverage(expiredCertScope).claimBoundary === 'ready' (never 'certified')",
  },
  {
    scenario: 'stale',
    witness: 'a mapped control whose evidence is stale; current state is not inferred',
    observedVia: "reconstructCoverage(staleScope).gaps includes kind==='stale_evidence' && boundary < 'ready'",
  },
  {
    scenario: 'unmapped',
    witness: 'an applicable obligation with no control mapping',
    observedVia: "reconstructCoverage(unmappedScope).gaps includes kind==='unmapped_obligation'",
  },
  {
    scenario: 'reopened-non-applicability',
    witness: 'a not_applicable decision whose review instant has passed → gap reopens (FR-054)',
    observedVia: "reconstructCoverage(reopenedScope).gaps includes kind==='reopened_non_applicability'",
  },
  {
    scenario: 'cross-tenant',
    witness: 'an identical obligation owned by OTHER_TENANT never appears in TENANT coverage',
    observedVia: 'reconstructCoverage over TENANT rows excludes every OTHER_TENANT row (tenant isolation)',
  },
];

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. Global publication FACTS (PLATFORM_SCOPE) — ISO/IEC 4200x, immutable + versioned (FR-051).
// ───────────────────────────────────────────────────────────────────────────────────────────────

const PUB_42001_ID = uuidFromSlug('publication-iso-42001-2023');
const PUB_42001_V2_ID = uuidFromSlug('publication-iso-42001-2023-v2');
const PUB_42006_ID = uuidFromSlug('publication-iso-42006-2025');

/** ISO/IEC 42001:2023 — requirements (the applicable management-system standard). */
export const PUBLICATION_42001: StandardPublication = makeStandardPublication({
  id: PUB_42001_ID,
  publisher: 'ISO/IEC',
  identifier: 'ISO/IEC 42001:2023',
  exactTitle: 'Information technology — Artificial intelligence — Management system',
  edition: '1',
  publicationDate: '2023-12-01',
  status: 'published',
  materialType: 'requirements',
  sourceUri: 'https://www.iso.org/standard/81230.html',
  registryVersion: 1,
  createdAt: (NOW - 2 * ONE_YEAR) as EpochMillis,
});

/** A superseding version-2 registration of the SAME identifier — proves append-only supersession. */
export const PUBLICATION_42001_V2: StandardPublication = makeStandardPublication({
  id: PUB_42001_V2_ID,
  publisher: 'ISO/IEC',
  identifier: 'ISO/IEC 42001:2023',
  exactTitle: 'Information technology — Artificial intelligence — Management system',
  edition: '1',
  publicationDate: '2024-06-01',
  status: 'published',
  materialType: 'requirements',
  sourceUri: 'https://www.iso.org/standard/81230.html',
  registryVersion: 2,
  supersedesId: PUB_42001_ID,
  createdAt: (NOW - ONE_YEAR) as EpochMillis,
});

/**
 * ISO/IEC 42006:2025 — certification-body criteria. NOT an organizational conformity obligation
 * (FR-055): publicationDutyClass classifies it as `certification_body_criteria` unless the tenant is
 * itself an approved certification body for the scope.
 */
export const PUBLICATION_42006: StandardPublication = makeStandardPublication({
  id: PUB_42006_ID,
  publisher: 'ISO/IEC',
  identifier: 'ISO/IEC 42006:2025',
  exactTitle:
    'Information technology — Artificial intelligence — Requirements for bodies providing audit and certification of AI management systems',
  edition: '1',
  publicationDate: '2025-02-01',
  status: 'published',
  materialType: 'certification_body_criteria',
  sourceUri: 'https://www.iso.org/standard/44546.html',
  registryVersion: 1,
  createdAt: (NOW - ONE_YEAR) as EpochMillis,
});

export const PUBLICATIONS: readonly StandardPublication[] = Object.freeze([
  PUBLICATION_42001,
  PUBLICATION_42001_V2,
  PUBLICATION_42006,
]);

/** The duty class 42006 carries for a non-certification-body tenant (audit-readiness, not a duty). */
export const DUTY_CLASS_42006 = publicationDutyClass(PUBLICATION_42006, false);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. Clause versions (PLATFORM_SCOPE) — one per obligation the scenarios exercise.
// ───────────────────────────────────────────────────────────────────────────────────────────────

function clause(slug: string, clauseRef: string, title: string): ClauseVersion {
  return makeClauseVersion({
    id: uuidFromSlug(`clause-${slug}`),
    publicationId: PUB_42001_ID,
    clauseRef,
    title,
    materialType: 'requirements',
    version: 1,
    createdAt: (NOW - 2 * ONE_YEAR) as EpochMillis,
  });
}

export const CLAUSE_READY = clause('ready', '6.1.2', 'AI risk assessment');
export const CLAUSE_STALE = clause('stale', '8.2', 'AI system impact assessment');
export const CLAUSE_UNMAPPED = clause('unmapped', '9.2', 'Internal audit');
export const CLAUSE_REOPENED = clause('reopened', '7.5', 'Documented information');

export const CLAUSES: readonly ClauseVersion[] = Object.freeze([
  CLAUSE_READY,
  CLAUSE_STALE,
  CLAUSE_UNMAPPED,
  CLAUSE_REOPENED,
]);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. Applicability decisions (tenant-scoped, versioned, independently reviewed) (FR-052..056).
// ───────────────────────────────────────────────────────────────────────────────────────────────

const SYSTEM_ID = uuidFromSlug('system-underwriting-ai');
const EVIDENCE_APPLICABILITY = uuidFromSlug('evidence-applicability-basis');

const APPROVE_REASON: Reason = makeReason('independent_review_approved', 'Independent reviewer approved applicability.');

/** An ACTIVE, independently-reviewed 'applicable' decision (reviewer distinct from proposer) (FR-053). */
export const DECISION_READY: ApplicabilityDecision = makeApplicabilityDecision({
  id: uuidFromSlug('decision-ready'),
  tenantId: TENANT as unknown as Uuid,
  clauseVersionId: CLAUSE_READY.id,
  systemId: SYSTEM_ID,
  jurisdiction: 'EU',
  useCase: { domain: 'credit-underwriting', riskTier: 'high' },
  proposedResult: 'applicable',
  rationale: 'The clause applies: the system makes consequential automated decisions in the EU.',
  evidenceIds: [EVIDENCE_APPLICABILITY],
  obligationOwnerPrincipalId: CONTROL_OWNER,
  proposerPrincipalId: COMPLIANCE_OWNER,
  reviewerPrincipalId: INDEPENDENT_REVIEWER,
  reviewDecision: 'approve',
  reviewReason: APPROVE_REASON,
  state: 'active',
  effectiveFrom: (NOW - 90 * ONE_DAY) as EpochMillis,
  // Review well in the future ⇒ NOT expired at NOW.
  reviewAt: (NOW + 180 * ONE_DAY) as EpochMillis,
  version: 1,
  createdAt: (NOW - 90 * ONE_DAY) as EpochMillis,
});

/** A still-'proposed' decision — NEVER active (no independent review yet). */
export const DECISION_PROPOSED: ApplicabilityDecision = makeApplicabilityDecision({
  id: uuidFromSlug('decision-proposed'),
  tenantId: TENANT as unknown as Uuid,
  clauseVersionId: CLAUSE_STALE.id,
  systemId: SYSTEM_ID,
  jurisdiction: 'EU',
  useCase: { domain: 'credit-underwriting' },
  proposedResult: 'applicable',
  rationale: 'Proposed as applicable; awaiting independent review before activation.',
  evidenceIds: [EVIDENCE_APPLICABILITY],
  proposerPrincipalId: COMPLIANCE_OWNER,
  state: 'proposed',
  reviewAt: (NOW + 30 * ONE_DAY) as EpochMillis,
  version: 1,
  createdAt: (NOW - 7 * ONE_DAY) as EpochMillis,
});

/** An ACTIVE stale-covered decision (drives the STALE-evidence scenario). */
export const DECISION_STALE: ApplicabilityDecision = makeApplicabilityDecision({
  id: uuidFromSlug('decision-stale'),
  tenantId: TENANT as unknown as Uuid,
  clauseVersionId: CLAUSE_STALE.id,
  systemId: SYSTEM_ID,
  jurisdiction: 'EU',
  useCase: { domain: 'credit-underwriting' },
  proposedResult: 'applicable',
  rationale: 'Applicable; its single control has stale evidence at NOW.',
  evidenceIds: [EVIDENCE_APPLICABILITY],
  obligationOwnerPrincipalId: CONTROL_OWNER,
  proposerPrincipalId: COMPLIANCE_OWNER,
  reviewerPrincipalId: INDEPENDENT_REVIEWER,
  reviewDecision: 'approve',
  reviewReason: APPROVE_REASON,
  state: 'active',
  effectiveFrom: (NOW - 200 * ONE_DAY) as EpochMillis,
  reviewAt: (NOW + 60 * ONE_DAY) as EpochMillis,
  version: 1,
  createdAt: (NOW - 200 * ONE_DAY) as EpochMillis,
});

/** An ACTIVE applicable decision for the unmapped obligation. */
export const DECISION_UNMAPPED: ApplicabilityDecision = makeApplicabilityDecision({
  id: uuidFromSlug('decision-unmapped'),
  tenantId: TENANT as unknown as Uuid,
  clauseVersionId: CLAUSE_UNMAPPED.id,
  systemId: SYSTEM_ID,
  jurisdiction: 'EU',
  useCase: { domain: 'credit-underwriting' },
  proposedResult: 'applicable',
  rationale: 'Applicable; deliberately has no control mapping to surface an unmapped-obligation gap.',
  evidenceIds: [EVIDENCE_APPLICABILITY],
  obligationOwnerPrincipalId: CONTROL_OWNER,
  proposerPrincipalId: COMPLIANCE_OWNER,
  reviewerPrincipalId: INDEPENDENT_REVIEWER,
  reviewDecision: 'approve',
  reviewReason: APPROVE_REASON,
  state: 'active',
  effectiveFrom: (NOW - 30 * ONE_DAY) as EpochMillis,
  reviewAt: (NOW + 120 * ONE_DAY) as EpochMillis,
  version: 1,
  createdAt: (NOW - 30 * ONE_DAY) as EpochMillis,
});

/**
 * A not_applicable decision whose review instant has ALREADY PASSED at NOW → its gap must REOPEN
 * (FR-054): a stale non-applicability cannot keep silencing the obligation it deferred.
 */
export const DECISION_REOPENED_NA: ApplicabilityDecision = makeApplicabilityDecision({
  id: uuidFromSlug('decision-reopened-na'),
  tenantId: TENANT as unknown as Uuid,
  clauseVersionId: CLAUSE_REOPENED.id,
  systemId: SYSTEM_ID,
  jurisdiction: 'EU',
  useCase: { domain: 'credit-underwriting' },
  proposedResult: 'not_applicable',
  rationale: 'Judged not applicable a year ago; its review window has since lapsed.',
  evidenceIds: [EVIDENCE_APPLICABILITY],
  obligationOwnerPrincipalId: CONTROL_OWNER,
  proposerPrincipalId: COMPLIANCE_OWNER,
  reviewerPrincipalId: INDEPENDENT_REVIEWER,
  reviewDecision: 'approve',
  reviewReason: APPROVE_REASON,
  state: 'active',
  effectiveFrom: (NOW - ONE_YEAR) as EpochMillis,
  // Review instant is in the PAST ⇒ nonApplicabilityReopensGap === true at NOW.
  reviewAt: (NOW - 10 * ONE_DAY) as EpochMillis,
  version: 1,
  createdAt: (NOW - ONE_YEAR) as EpochMillis,
});

/** The same 'ready' applicability, but owned by OTHER_TENANT (must never appear in TENANT coverage). */
export const DECISION_CROSS_TENANT: ApplicabilityDecision = makeApplicabilityDecision({
  id: uuidFromSlug('decision-cross-tenant'),
  tenantId: OTHER_TENANT as unknown as Uuid,
  clauseVersionId: CLAUSE_READY.id,
  systemId: uuidFromSlug('system-other-tenant'),
  jurisdiction: 'EU',
  useCase: { domain: 'credit-underwriting' },
  proposedResult: 'applicable',
  rationale: "Another tenant's applicable decision — must be isolated from TENANT coverage.",
  evidenceIds: [uuidFromSlug('evidence-other-tenant')],
  obligationOwnerPrincipalId: uuidFromSlug('principal-other-owner'),
  proposerPrincipalId: uuidFromSlug('principal-other-proposer'),
  reviewerPrincipalId: uuidFromSlug('principal-other-reviewer'),
  reviewDecision: 'approve',
  reviewReason: APPROVE_REASON,
  state: 'active',
  effectiveFrom: (NOW - 30 * ONE_DAY) as EpochMillis,
  reviewAt: (NOW + 120 * ONE_DAY) as EpochMillis,
  version: 1,
  createdAt: (NOW - 30 * ONE_DAY) as EpochMillis,
});

export const DECISIONS: readonly ApplicabilityDecision[] = Object.freeze([
  DECISION_READY,
  DECISION_PROPOSED,
  DECISION_STALE,
  DECISION_UNMAPPED,
  DECISION_REOPENED_NA,
]);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. Obligations + control mappings + evaluations.
// ───────────────────────────────────────────────────────────────────────────────────────────────

function obligation(slug: string, clauseVersionId: Uuid, decisionId: Uuid, tenantId: Uuid = TENANT as unknown as Uuid): Obligation {
  return makeObligation({
    id: uuidFromSlug(`obligation-${slug}`),
    tenantId,
    clauseVersionId,
    applicabilityDecisionId: decisionId,
    dutyClass: 'organizational_obligation',
    ownerPrincipalId: CONTROL_OWNER,
    reviewAt: (NOW + 180 * ONE_DAY) as EpochMillis,
    version: 1,
    createdAt: (NOW - 90 * ONE_DAY) as EpochMillis,
  });
}

export const OBLIGATION_READY: Obligation = obligation('ready', CLAUSE_READY.id, DECISION_READY.id);
export const OBLIGATION_STALE: Obligation = obligation('stale', CLAUSE_STALE.id, DECISION_STALE.id);
export const OBLIGATION_UNMAPPED: Obligation = obligation('unmapped', CLAUSE_UNMAPPED.id, DECISION_UNMAPPED.id);
export const OBLIGATION_CROSS_TENANT: Obligation = obligation(
  'cross-tenant',
  CLAUSE_READY.id,
  DECISION_CROSS_TENANT.id,
  OTHER_TENANT as unknown as Uuid,
);

export const OBLIGATIONS: readonly Obligation[] = Object.freeze([
  OBLIGATION_READY,
  OBLIGATION_STALE,
  OBLIGATION_UNMAPPED,
]);

function mapping(slug: string, obligationId: Uuid, tenantId: Uuid = TENANT as unknown as Uuid): ControlMapping {
  return makeControlMapping({
    id: uuidFromSlug(`mapping-${slug}`),
    tenantId,
    obligationId,
    controlId: uuidFromSlug(`control-${slug}`),
    responsibility: 'organization',
    evidenceExpectations: ['a signed control-operation attestation', 'the most recent evidence envelope'],
    evidenceWindowMillis: 90 * ONE_DAY,
    reviewAt: (NOW + 180 * ONE_DAY) as EpochMillis,
    version: 1,
    createdAt: (NOW - 90 * ONE_DAY) as EpochMillis,
  });
}

export const MAPPING_READY: ControlMapping = mapping('ready', OBLIGATION_READY.id);
export const MAPPING_STALE: ControlMapping = mapping('stale', OBLIGATION_STALE.id);
// NOTE: OBLIGATION_UNMAPPED deliberately has NO mapping (its gap is the point).
export const MAPPING_CROSS_TENANT: ControlMapping = mapping(
  'cross-tenant',
  OBLIGATION_CROSS_TENANT.id,
  OTHER_TENANT as unknown as Uuid,
);

export const MAPPINGS: readonly ControlMapping[] = Object.freeze([MAPPING_READY, MAPPING_STALE]);

const EVIDENCE_READY = uuidFromSlug('evidence-ready-attestation');
const EVIDENCE_STALE = uuidFromSlug('evidence-stale-attestation');

/** A designed/implemented/operating control with SUFFICIENT, current evidence → 'ready'. */
export const EVAL_READY: ControlEvaluationFact = Object.freeze({
  controlMappingId: MAPPING_READY.id,
  designState: 'designed',
  implementationState: 'implemented',
  operatingState: 'operating',
  evidenceSufficiency: 'sufficient',
  latestEvidenceId: EVIDENCE_READY,
  latestEvidenceAt: (NOW - 10 * ONE_DAY) as EpochMillis,
  evaluatedAt: (NOW - 10 * ONE_DAY) as EpochMillis,
});

/** An operating control whose evidence has gone STALE → surfaces as a stale_evidence gap. */
export const EVAL_STALE: ControlEvaluationFact = Object.freeze({
  controlMappingId: MAPPING_STALE.id,
  designState: 'designed',
  implementationState: 'implemented',
  operatingState: 'operating',
  evidenceSufficiency: 'stale',
  latestEvidenceId: EVIDENCE_STALE,
  latestEvidenceAt: (NOW - 200 * ONE_DAY) as EpochMillis,
  evaluatedAt: (NOW - 200 * ONE_DAY) as EpochMillis,
});

export const EVALUATIONS: readonly ControlEvaluationFact[] = Object.freeze([EVAL_READY, EVAL_STALE]);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 5. Assessments (internal readiness / external) — the assurance ladder below certification.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export const ASSESSMENT_INTERNAL_READY: Assessment = makeAssessment({
  id: uuidFromSlug('assessment-internal-ready'),
  tenantId: TENANT as unknown as Uuid,
  obligationId: OBLIGATION_READY.id,
  kind: 'internal_readiness',
  result: 'ready',
  assessorPrincipalId: AUDITOR,
  evidenceIds: [EVIDENCE_READY],
  assessedAt: (NOW - 10 * ONE_DAY) as EpochMillis,
  version: 1,
});

export const ASSESSMENT_EXTERNAL: Assessment = makeAssessment({
  id: uuidFromSlug('assessment-external'),
  tenantId: TENANT as unknown as Uuid,
  obligationId: OBLIGATION_READY.id,
  kind: 'external_assessment',
  result: 'conforming',
  assessorPrincipalId: ASSESSOR,
  evidenceIds: [EVIDENCE_READY],
  assessedAt: (NOW - 20 * ONE_DAY) as EpochMillis,
  version: 1,
});

export const ASSESSMENTS: readonly Assessment[] = Object.freeze([ASSESSMENT_INTERNAL_READY, ASSESSMENT_EXTERNAL]);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 6. External certifications — one DISPLAYABLE (in-window, valid), one EXPIRED (never 'certified').
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** A verifiable, in-window, valid certification → lifts a complete/ready scope to 'certified'. */
export const CERTIFICATION_VALID: ExternalCertification = makeExternalCertification({
  id: uuidFromSlug('certification-valid'),
  tenantId: TENANT as unknown as Uuid,
  publicationId: PUB_42001_ID,
  issuer: 'Accredited AI Certification Body Ltd',
  certificateId: 'AIMS-2025-000123',
  scope: { system: 'underwriting-ai', standard: 'ISO/IEC 42001:2023' },
  validFrom: (NOW - 90 * ONE_DAY) as EpochMillis,
  validUntil: (NOW + 275 * ONE_DAY) as EpochMillis,
  status: 'valid',
  verificationUri: 'https://registry.example-accreditation.org/certificates/AIMS-2025-000123',
  version: 1,
  createdAt: (NOW - 90 * ONE_DAY) as EpochMillis,
});

/** An EXPIRED certification (validUntil in the past) → never displayable as 'certified' at NOW. */
export const CERTIFICATION_EXPIRED: ExternalCertification = makeExternalCertification({
  id: uuidFromSlug('certification-expired'),
  tenantId: TENANT as unknown as Uuid,
  publicationId: PUB_42001_ID,
  issuer: 'Accredited AI Certification Body Ltd',
  certificateId: 'AIMS-2023-000045',
  scope: { system: 'underwriting-ai', standard: 'ISO/IEC 42001:2023' },
  validFrom: (NOW - 2 * ONE_YEAR) as EpochMillis,
  validUntil: (NOW - 30 * ONE_DAY) as EpochMillis,
  status: 'valid',
  verificationUri: 'https://registry.example-accreditation.org/certificates/AIMS-2023-000045',
  version: 1,
  createdAt: (NOW - 2 * ONE_YEAR) as EpochMillis,
});

export const CERTIFICATIONS: readonly ExternalCertification[] = Object.freeze([
  CERTIFICATION_VALID,
  CERTIFICATION_EXPIRED,
]);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 7. Ready-made coverage input builders — one per scenario, all reconstructed AT `NOW`.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const READY_SCOPE: CoverageScope = Object.freeze({
  tenantId: TENANT as unknown as Uuid,
  systemId: SYSTEM_ID,
  publicationId: PUB_42001_ID,
});

function baseInputs(
  overrides: Partial<Pick<CoverageInputs, 'decisions' | 'obligations' | 'mappings' | 'evaluations' | 'certifications' | 'scope' | 'at'>>,
): CoverageInputs {
  return {
    scope: overrides.scope ?? READY_SCOPE,
    decisions: overrides.decisions ?? [DECISION_READY],
    obligations: overrides.obligations ?? [OBLIGATION_READY],
    mappings: overrides.mappings ?? [MAPPING_READY],
    evaluations: overrides.evaluations ?? [EVAL_READY],
    certifications: overrides.certifications ?? [],
    at: overrides.at ?? NOW,
  };
}

/** READY: a single fully-covered obligation, no certification → claimBoundary 'ready', complete. */
export const READY_INPUTS: CoverageInputs = Object.freeze(baseInputs({}));

/** CERTIFIED: the ready picture PLUS the valid, in-window certification → 'certified'. */
export const CERTIFIED_INPUTS: CoverageInputs = Object.freeze(
  baseInputs({ certifications: [CERTIFICATION_VALID] }),
);

/** READINESS≠CERT: the ready picture with only the EXPIRED certification → caps at 'ready'. */
export const EXPIRED_CERT_INPUTS: CoverageInputs = Object.freeze(
  baseInputs({ certifications: [CERTIFICATION_EXPIRED] }),
);

/** STALE: a single obligation whose control evidence is stale → stale_evidence gap. */
export const STALE_INPUTS: CoverageInputs = Object.freeze(
  baseInputs({
    decisions: [DECISION_STALE],
    obligations: [OBLIGATION_STALE],
    mappings: [MAPPING_STALE],
    evaluations: [EVAL_STALE],
  }),
);

/** UNMAPPED: an applicable obligation with no control mapping → unmapped_obligation gap. */
export const UNMAPPED_INPUTS: CoverageInputs = Object.freeze(
  baseInputs({
    decisions: [DECISION_UNMAPPED],
    obligations: [OBLIGATION_UNMAPPED],
    mappings: [],
    evaluations: [],
  }),
);

/** REOPENED-NA: a not_applicable decision whose review has lapsed → reopened_non_applicability gap. */
export const REOPENED_INPUTS: CoverageInputs = Object.freeze(
  baseInputs({
    decisions: [DECISION_REOPENED_NA],
    obligations: [],
    mappings: [],
    evaluations: [],
  }),
);

/**
 * CROSS-TENANT: TENANT's ready rows are fed together with OTHER_TENANT's identical rows, but the
 * scope is TENANT — the engine must exclude every OTHER_TENANT decision/obligation.
 */
export const CROSS_TENANT_INPUTS: CoverageInputs = Object.freeze(
  baseInputs({
    decisions: [DECISION_READY, DECISION_CROSS_TENANT],
    obligations: [OBLIGATION_READY, OBLIGATION_CROSS_TENANT],
    mappings: [MAPPING_READY, MAPPING_CROSS_TENANT],
    evaluations: [EVAL_READY],
  }),
);

/**
 * The FULL tenant coverage input — every TENANT scenario at once (used by the projector + audit
 * export + web-surface fixtures). System scope is omitted so all obligations are in scope; the
 * publication filter is omitted so the certification lift depends only on displayability.
 */
export const FULL_TENANT_INPUTS: CoverageInputs = Object.freeze({
  scope: Object.freeze({ tenantId: TENANT as unknown as Uuid }),
  decisions: DECISIONS,
  obligations: OBLIGATIONS,
  mappings: MAPPINGS,
  evaluations: EVALUATIONS,
  certifications: CERTIFICATIONS,
  at: NOW,
});

/** A convenience map from scenario name → its coverage inputs. */
export const COVERAGE_INPUTS_BY_SCENARIO: Readonly<Record<CoverageScenarioName, CoverageInputs>> = Object.freeze({
  ready: READY_INPUTS,
  certified: CERTIFIED_INPUTS,
  'readiness-not-certification': EXPIRED_CERT_INPUTS,
  stale: STALE_INPUTS,
  unmapped: UNMAPPED_INPUTS,
  'reopened-non-applicability': REOPENED_INPUTS,
  'cross-tenant': CROSS_TENANT_INPUTS,
});

/** Reconstruct the coverage for a named scenario at `NOW` (composes the REAL engine). */
export function coverageForScenario(name: CoverageScenarioName): CoverageResult {
  return reconstructCoverage(COVERAGE_INPUTS_BY_SCENARIO[name]);
}

/** The reference count a scenario's reconstruction touches (SC-013 bound witness). */
export function referenceCountForScenario(name: CoverageScenarioName): number {
  return coverageReferenceCount(COVERAGE_INPUTS_BY_SCENARIO[name]);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 8. An audit-export request fixture (FR-056 / SC-022) — a valid scope/period/reason command body.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AuditExportRequestFixture {
  readonly scope: Readonly<Record<string, unknown>>;
  readonly period: { readonly from: string; readonly to: string };
  readonly reason: { readonly code: string; readonly text: string };
}

export const AUDIT_EXPORT_REQUEST: AuditExportRequestFixture = Object.freeze({
  scope: Object.freeze({ system_id: String(SYSTEM_ID), publication_id: String(PUB_42001_ID) }),
  period: Object.freeze({ from: iso((NOW - ONE_YEAR) as EpochMillis), to: iso(NOW) }),
  reason: Object.freeze({ code: 'external_audit', text: 'Prepare evidence pack for the annual ISO/IEC 42001 audit.' }),
});

// Re-export the shared scope + ids downstream fixtures/tests pin without recomputing a slug.
export const IDS = Object.freeze({
  SYSTEM_ID,
  PUB_42001_ID,
  PUB_42001_V2_ID,
  PUB_42006_ID,
  READY_SCOPE,
  EVIDENCE_READY,
  EVIDENCE_STALE,
  EVIDENCE_APPLICABILITY,
  PLATFORM_SCOPE,
});
