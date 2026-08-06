// TrustCircleAI — CENTRALIZED, ACCESSIBLE COMPLIANCE CLAIM LABELS + EXPLANATORY TEXT (Phase 7 /
// User Story 5 — Demonstrate Compliance and Audit Readiness / T215 /
// apps/web/src/features/compliance/claim-labels.ts / FR-032, FR-052, FR-055, SC-012).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The SINGLE source of truth for how the four compliance presenters (CoverageView,
// ApplicabilityReview, EvidenceExplorer, AuditExplorer) SPELL every requirement/guidance/draft
// material type, every duty class, every readiness/assessment/certification claim boundary, and
// every applicability result/state — in WORDS a screen-reader user reads, never a color or an
// abbreviation. Centralizing the vocabulary here means all four views say the SAME truthful thing
// about the same concept, and there is exactly ONE place to audit the cardinal anti-lie:
//
//   INTERNAL READINESS IS NEVER LABELED AS EXTERNAL CERTIFICATION (FR-055 / SC-012).
//
// A claim boundary of design/implemented/operating/ready is INTERNAL readiness — its label and its
// explanatory sentence state, in words, that it is NOT an external assessment, accreditation, or
// certification. Only `certified` (reached solely when a verifiable external certification is
// displayable) is labeled as external certification. `isExternalAssuranceBoundary` and
// `assertNoInternalCertificationMislabel` make that invariant machine-checkable, so a presenter
// (or its accessibility oracle) can PROVE it never promotes readiness to certification.
//
// PURE + DEPENDENCY-FREE. This is a leaf label table: it imports only TYPES from @trustcircle/domain
// (erased at runtime) so it drags no domain runtime into apps/web, and every export is a pure
// function or a frozen literal. No JSX, no DOM, no wall clock, no randomness, no module-level mutable
// state — same input ⇒ byte-identical label. The label VALUES here mirror the domain vocabularies
// (MATERIAL_TYPES / DUTY_CLASSES / CLAIM_BOUNDARIES / APPLICABILITY_RESULTS / APPLICABILITY_STATES /
// ASSESSMENT_KINDS / ASSESSMENT_RESULTS / CERTIFICATION_STATUSES / RESPONSIBILITY_PARTIES); a
// compile-time `satisfies Record<...>` binds each table to its domain union so a new vocabulary
// member cannot be added without a label here.

import type {
  MaterialType,
  DutyClass,
  ClaimBoundary,
  ApplicabilityResult,
  ApplicabilityState,
  ApplicabilityAction,
  AssessmentKind,
  AssessmentResult,
  CertificationStatus,
  ResponsibilityParty,
} from '@trustcircle/domain';

// ───────────────────────────────────────────────────────────────────────────────────────────
// 0. A label entry: the short accessible NAME + a one-sentence explanation a lay reader understands.
// ───────────────────────────────────────────────────────────────────────────────────────────

export interface ClaimLabel {
  /** The short, accessible display name — always words, never a color or a code. */
  readonly label: string;
  /** A one-sentence, plain-language explanation of what this value means (and does NOT mean). */
  readonly explanation: string;
}

/** Freeze a label table so no consumer can mutate the shared vocabulary. */
function table<K extends string>(t: Record<K, ClaimLabel>): Readonly<Record<K, ClaimLabel>> {
  return Object.freeze(t);
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 1. Material type — what KIND of published document a standard is (FR-051).
// ───────────────────────────────────────────────────────────────────────────────────────────

export const MATERIAL_TYPE_LABELS = table<MaterialType>({
  requirements: {
    label: 'Requirements',
    explanation:
      'Normative "shall" clauses. When a scope declares these applicable, they become an organizational duty to satisfy.',
  },
  guidance: {
    label: 'Guidance',
    explanation:
      'Informative recommendations ("should"). Guidance is never itself a conformity obligation — it advises, it does not oblige.',
  },
  certification_body_criteria: {
    label: 'Certification-body criteria',
    explanation:
      'Criteria a certification BODY must meet to be accredited (e.g. ISO/IEC 42006). These are not a duty your organization must satisfy.',
  },
  impact_assessment_guidance: {
    label: 'Impact-assessment guidance',
    explanation:
      'Guidance for conducting an AI-system impact assessment (e.g. ISO/IEC 42005). It informs how you assess impact; it is not a pass/fail obligation.',
  },
  draft: {
    label: 'Draft',
    explanation:
      'A draft or work-item publication that is not yet in force. A draft imposes no obligation and confers no assurance.',
  },
  amendment: {
    label: 'Amendment',
    explanation: 'An amendment that adds to or changes an existing edition of a standard.',
  },
  corrigendum: {
    label: 'Corrigendum',
    explanation: 'A technical correction to a published edition of a standard.',
  },
}) satisfies Readonly<Record<MaterialType, ClaimLabel>>;

/** Label a material type (falls back to a titled-cased raw value for forward compatibility). */
export function materialTypeLabel(t: MaterialType): ClaimLabel {
  return MATERIAL_TYPE_LABELS[t] ?? fallback(t);
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 2. Duty class — how a publication's obligation is classified for a scope (FR-032 / FR-055).
// ───────────────────────────────────────────────────────────────────────────────────────────

export const DUTY_CLASS_LABELS = table<DutyClass>({
  organizational_obligation: {
    label: 'Organizational obligation',
    explanation:
      'A duty your organization must satisfy for the requirements it has declared applicable in this scope.',
  },
  platform_capability: {
    label: 'Platform capability',
    explanation:
      'A capability the platform provides on your behalf. It is not an obligation you personally discharge.',
  },
  internal_readiness: {
    label: 'Internal readiness',
    explanation:
      'Your own internal readiness or self-assessment. It is NOT an external assessment, accreditation, or certification.',
  },
  external_assessment: {
    label: 'External assessment',
    explanation:
      'An assessment performed by another party. It is an external audit result, not a certification issued by an accredited body.',
  },
  certification: {
    label: 'External certification',
    explanation:
      'A certification issued by an accredited certification body. This is the only class that represents external certification.',
  },
  certification_body_criteria: {
    label: 'Certification-body criteria',
    explanation:
      'Criteria that a certification body itself must meet (e.g. ISO/IEC 42006). These are not a duty your organization must satisfy.',
  },
  guidance: {
    label: 'Guidance',
    explanation:
      'Informative guidance. It advises how to proceed and imposes no conformity obligation.',
  },
}) satisfies Readonly<Record<DutyClass, ClaimLabel>>;

export function dutyClassLabel(d: DutyClass): ClaimLabel {
  return DUTY_CLASS_LABELS[d] ?? fallback(d);
}

/** Duty classes that represent EXTERNAL assurance (assessment or certification) — never internal. */
export const EXTERNAL_ASSURANCE_DUTY_CLASSES: readonly DutyClass[] = Object.freeze([
  'external_assessment',
  'certification',
]);

/** True iff a duty class represents external assurance (an audit or an accredited certification). */
export function isExternalAssuranceDutyClass(d: DutyClass): boolean {
  return EXTERNAL_ASSURANCE_DUTY_CLASSES.includes(d);
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3. Claim boundary — the readiness/assessment/certification level a coverage view may report
//    (FR-032 / SC-012). The CARDINAL anti-lie lives here: internal readiness ≠ certification.
// ───────────────────────────────────────────────────────────────────────────────────────────

export const CLAIM_BOUNDARY_LABELS = table<ClaimBoundary>({
  design: {
    label: 'Designed (internal readiness)',
    explanation:
      'Controls are designed. This is internal readiness only — it is NOT an external assessment, accreditation, or certification.',
  },
  implemented: {
    label: 'Implemented (internal readiness)',
    explanation:
      'Controls are implemented. This is internal readiness only — it is NOT an external assessment, accreditation, or certification.',
  },
  operating: {
    label: 'Operating (internal readiness)',
    explanation:
      'Controls are operating with current evidence. This is internal readiness only — it is NOT an external assessment or certification.',
  },
  ready: {
    label: 'Ready for assessment (internal readiness)',
    explanation:
      'All obligations are covered by operating controls with current evidence. This is internal readiness for assessment — it is NOT itself an external assessment, accreditation, or certification.',
  },
  assessed: {
    label: 'Externally assessed',
    explanation:
      'An external party has assessed this scope. This reflects an external audit result — it is not, by itself, an accredited certification.',
  },
  certified: {
    label: 'Externally certified',
    explanation:
      'An accredited certification body has issued a currently-valid certification for this scope. This is the only boundary that represents external certification.',
  },
  incomplete: {
    label: 'Incomplete coverage',
    explanation:
      'The coverage picture is partial — one or more obligations are unmapped, unevidenced, or stale. No readiness or certification claim can be made until the gaps are closed.',
  },
}) satisfies Readonly<Record<ClaimBoundary, ClaimLabel>>;

export function claimBoundaryLabel(b: ClaimBoundary): ClaimLabel {
  return CLAIM_BOUNDARY_LABELS[b] ?? fallback(b);
}

/** The INTERNAL-readiness claim boundaries — those that MUST NOT be shown as external certification. */
export const INTERNAL_READINESS_BOUNDARIES: readonly ClaimBoundary[] = Object.freeze([
  'design',
  'implemented',
  'operating',
  'ready',
]);

/** The EXTERNAL-assurance claim boundaries (an external party's assessment or an accredited cert). */
export const EXTERNAL_ASSURANCE_BOUNDARIES: readonly ClaimBoundary[] = Object.freeze([
  'assessed',
  'certified',
]);

/** True iff a claim boundary is internal readiness (design/implemented/operating/ready). */
export function isInternalReadinessBoundary(b: ClaimBoundary): boolean {
  return INTERNAL_READINESS_BOUNDARIES.includes(b);
}

/** True iff a claim boundary represents external assurance (assessed or certified). */
export function isExternalAssuranceBoundary(b: ClaimBoundary): boolean {
  return EXTERNAL_ASSURANCE_BOUNDARIES.includes(b);
}

/** True iff a claim boundary represents external CERTIFICATION specifically (only `certified`). */
export function isExternalCertificationBoundary(b: ClaimBoundary): boolean {
  return b === 'certified';
}

/**
 * The load-bearing guard (FR-055 / SC-012). Given a boundary and the label a presenter intends to
 * render for it, return a finding string iff the label would MISREPRESENT internal readiness as an
 * external assessment/accreditation/certification (or vice-versa). Returns null when the label is
 * truthful. A presenter/oracle calls this to PROVE it never promotes readiness to certification.
 */
export function assertNoInternalCertificationMislabel(
  boundary: ClaimBoundary,
  renderedLabelText: string,
): string | null {
  const lower = renderedLabelText.toLowerCase();
  const claimsCertification = /certif/.test(lower);
  const claimsAccreditation = /accredit/.test(lower);
  const claimsExternalAssessment = /extern/.test(lower) && /assess/.test(lower);
  if (isInternalReadinessBoundary(boundary)) {
    if (claimsCertification && !/not\b[^.]*certif|internal readiness/.test(lower)) {
      return `internal readiness boundary "${boundary}" must not be labeled as certification: "${renderedLabelText}"`;
    }
    if (claimsAccreditation) {
      return `internal readiness boundary "${boundary}" must not claim accreditation: "${renderedLabelText}"`;
    }
    if (claimsExternalAssessment) {
      return `internal readiness boundary "${boundary}" must not claim an external assessment: "${renderedLabelText}"`;
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 4. Applicability result + state + action — the tenant-owner decision lifecycle (FR-052 / FR-053).
// ───────────────────────────────────────────────────────────────────────────────────────────

export const APPLICABILITY_RESULT_LABELS = table<ApplicabilityResult>({
  applicable: {
    label: 'Applicable',
    explanation:
      'This publication applies in full to this scope; its requirements are organizational duties.',
  },
  partially_applicable: {
    label: 'Partially applicable',
    explanation:
      'Some clauses of this publication apply to this scope; the applicable subset is recorded.',
  },
  not_applicable: {
    label: 'Not applicable',
    explanation:
      'This publication does not apply to this scope. The decision stays visible and reopens as a gap if it goes stale — it never silently suppresses coverage.',
  },
  uncertain: {
    label: 'Applicability uncertain',
    explanation:
      'Applicability has not yet been resolved. Uncertain is not "not applicable" — it is an open question.',
  },
}) satisfies Readonly<Record<ApplicabilityResult, ClaimLabel>>;

export function applicabilityResultLabel(r: ApplicabilityResult): ClaimLabel {
  return APPLICABILITY_RESULT_LABELS[r] ?? fallback(r);
}

export const APPLICABILITY_STATE_LABELS = table<ApplicabilityState>({
  proposed: {
    label: 'Proposed',
    explanation:
      'A compliance owner proposed this decision. It is not active until an independent reviewer approves it.',
  },
  active: {
    label: 'Active',
    explanation:
      'An independent reviewer approved this decision and it is currently in force for this scope.',
  },
  rejected: {
    label: 'Rejected',
    explanation: 'An independent reviewer rejected this proposal; it is not in force.',
  },
  changes_requested: {
    label: 'Changes requested',
    explanation:
      'An independent reviewer requested changes; the proposer must revise and re-submit.',
  },
  expired: {
    label: 'Expired',
    explanation:
      'This decision passed its review-by instant. If it was a non-applicability, its gap reopens.',
  },
  superseded: {
    label: 'Superseded',
    explanation:
      'A newer version of this decision replaced it. The superseded version is retained for the audit trail.',
  },
}) satisfies Readonly<Record<ApplicabilityState, ClaimLabel>>;

export function applicabilityStateLabel(s: ApplicabilityState): ClaimLabel {
  return APPLICABILITY_STATE_LABELS[s] ?? fallback(s);
}

export const APPLICABILITY_ACTION_LABELS = table<ApplicabilityAction>({
  approve: {
    label: 'Approve',
    explanation: 'An independent reviewer (not the proposer) approves the decision, activating it.',
  },
  reject: { label: 'Reject', explanation: 'An independent reviewer rejects the proposal.' },
  request_changes: {
    label: 'Request changes',
    explanation: 'An independent reviewer asks the proposer to revise the proposal.',
  },
  expire: {
    label: 'Expire',
    explanation:
      'The decision is expired at its review-by instant; a non-applicability gap reopens.',
  },
}) satisfies Readonly<Record<ApplicabilityAction, ClaimLabel>>;

export function applicabilityActionLabel(a: ApplicabilityAction): ClaimLabel {
  return APPLICABILITY_ACTION_LABELS[a] ?? fallback(a);
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 5. Assessment kind + result, certification status, responsibility party.
// ───────────────────────────────────────────────────────────────────────────────────────────

export const ASSESSMENT_KIND_LABELS = table<AssessmentKind>({
  internal_readiness: {
    label: 'Internal readiness assessment',
    explanation:
      'An internal, self-conducted readiness check. It is NOT an external assessment, accreditation, or certification.',
  },
  internal_audit: {
    label: 'Internal audit',
    explanation:
      'An audit conducted by your organization’s own internal audit function. It is internal assurance — NOT an external assessment or certification.',
  },
  external_assessment: {
    label: 'External assessment',
    explanation:
      'An assessment conducted by an external party — an external audit result, not a certification.',
  },
}) satisfies Readonly<Record<AssessmentKind, ClaimLabel>>;

export function assessmentKindLabel(k: AssessmentKind): ClaimLabel {
  return ASSESSMENT_KIND_LABELS[k] ?? fallback(k);
}

export const ASSESSMENT_RESULT_LABELS = table<AssessmentResult>({
  ready: {
    label: 'Ready',
    explanation:
      'The assessed scope is ready. For an internal assessment this is internal readiness only, not certification.',
  },
  not_ready: {
    label: 'Not ready',
    explanation: 'The assessed scope is not yet ready; gaps remain.',
  },
  conforming: {
    label: 'Conforming',
    explanation:
      'An external assessor found the scope conforming. This is an assessment result, not by itself a certification.',
  },
  nonconforming: {
    label: 'Nonconforming',
    explanation: 'An external assessor found nonconformities that must be remediated.',
  },
  inconclusive: {
    label: 'Inconclusive',
    explanation: 'The assessment could not reach a conclusion; more evidence is required.',
  },
}) satisfies Readonly<Record<AssessmentResult, ClaimLabel>>;

export function assessmentResultLabel(r: AssessmentResult): ClaimLabel {
  return ASSESSMENT_RESULT_LABELS[r] ?? fallback(r);
}

export const CERTIFICATION_STATUS_LABELS = table<CertificationStatus>({
  valid: {
    label: 'Valid certification',
    explanation:
      'An accredited body issued this certification and it is within its validity window.',
  },
  suspended: {
    label: 'Suspended certification',
    explanation: 'The certification is suspended; it is not currently displayable as valid.',
  },
  withdrawn: {
    label: 'Withdrawn certification',
    explanation: 'The certification was withdrawn; it no longer confers external certification.',
  },
  expired: {
    label: 'Expired certification',
    explanation:
      'The certification passed its validity window and is no longer displayable as current.',
  },
}) satisfies Readonly<Record<CertificationStatus, ClaimLabel>>;

export function certificationStatusLabel(s: CertificationStatus): ClaimLabel {
  return CERTIFICATION_STATUS_LABELS[s] ?? fallback(s);
}

export const RESPONSIBILITY_PARTY_LABELS = table<ResponsibilityParty>({
  organization: {
    label: 'Your organization',
    explanation: 'Your organization is responsible for this obligation or control.',
  },
  platform: {
    label: 'Platform',
    explanation: 'The platform is responsible for this obligation or control on your behalf.',
  },
  shared: {
    label: 'Shared responsibility',
    explanation: 'Responsibility is shared between your organization and the platform.',
  },
  external: {
    label: 'External party',
    explanation: 'An external party (e.g. a sub-processor or assessor) is responsible for this.',
  },
}) satisfies Readonly<Record<ResponsibilityParty, ClaimLabel>>;

export function responsibilityPartyLabel(p: ResponsibilityParty): ClaimLabel {
  return RESPONSIBILITY_PARTY_LABELS[p] ?? fallback(p);
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 6. Coverage-gap kinds — the reasons an obligation is not covered (mirrors CoverageGapKind).
// ───────────────────────────────────────────────────────────────────────────────────────────

export type CoverageGapKindKey =
  | 'unmapped_obligation'
  | 'no_evidence'
  | 'stale_evidence'
  | 'deficient_control'
  | 'reopened_non_applicability'
  | 'expired_applicability';

export const COVERAGE_GAP_LABELS = table<CoverageGapKindKey>({
  unmapped_obligation: {
    label: 'Unmapped obligation',
    explanation:
      'An applicable obligation has no control mapped to it. It stays a visible gap until a control is mapped.',
  },
  no_evidence: {
    label: 'No evidence',
    explanation:
      'A mapped control has no evidence of operation. It cannot be reported as operating.',
  },
  stale_evidence: {
    label: 'Stale evidence',
    explanation:
      'The control’s evidence is older than its evidence window. Current operation is NOT inferred from stale evidence — this surfaces as a gap.',
  },
  deficient_control: {
    label: 'Deficient control',
    explanation:
      'The control was evaluated as deficient. The obligation is not covered until it is remediated.',
  },
  reopened_non_applicability: {
    label: 'Reopened non-applicability',
    explanation:
      'A previously not-applicable decision went stale and reopened as a gap. Non-applicability never silently suppresses coverage.',
  },
  expired_applicability: {
    label: 'Expired applicability',
    explanation:
      'The applicability decision expired at its review-by instant and must be re-reviewed.',
  },
}) satisfies Readonly<Record<CoverageGapKindKey, ClaimLabel>>;

export function coverageGapLabel(k: CoverageGapKindKey): ClaimLabel {
  return COVERAGE_GAP_LABELS[k] ?? fallback(k);
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 7. A universal, non-color status caption a presenter can attach to any claim boundary so the
//    meaning is always in the TEXT (WCAG 1.4.1). This is the sentence every view shows next to a
//    boundary badge, and it NEVER reads as certification for an internal-readiness boundary.
// ───────────────────────────────────────────────────────────────────────────────────────────

export function claimBoundaryCaption(b: ClaimBoundary): string {
  if (isExternalCertificationBoundary(b)) {
    return 'This scope holds a currently-valid external certification from an accredited body.';
  }
  if (isExternalAssuranceBoundary(b)) {
    return 'This scope has an external assessment result. It is not, by itself, an accredited certification.';
  }
  if (b === 'incomplete') {
    return 'Coverage is incomplete; no readiness or certification claim can be made until the gaps are closed.';
  }
  return 'This is internal readiness only — it is NOT an external assessment, accreditation, or certification.';
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// 8. Fallback for a forward-compatible (not-yet-labeled) vocabulary value.
// ───────────────────────────────────────────────────────────────────────────────────────────

function fallback(raw: string): ClaimLabel {
  const label = raw
    .split(/[_-]/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
  return { label, explanation: `${label}.` };
}
