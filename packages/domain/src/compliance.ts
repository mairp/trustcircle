// @trustcircle/domain — STANDARD-PUBLICATION, CLAUSE-VERSION, APPLICABILITY-DECISION, OBLIGATION,
// CONTROL-MAPPING, ASSESSMENT, and EXTERNAL-CERTIFICATION aggregates (Phase 7 / User Story 5 —
// Demonstrate Compliance and Audit Readiness / FR-031..035, FR-051..056, SC-012, SC-013, SC-022).
//
// This module is the value-level, dependency-free (node:crypto only) form of the durable compliance
// substrate authored in `db/migrations/0050_compliance.sql`. It is aligned column-for-column with
// that migration and with the governance-api `StandardPublication`, `ApplicabilityProposal`,
// `ApplicabilityDecision`, and `ComplianceCoverage` schemas, so a projection over the physical rows,
// an in-memory aggregate, and an API response share ONE vocabulary and ONE set of invariants.
//
// The load-bearing invariants this module makes enforceable at the value level:
//
//   * IMMUTABLE CENTRAL PUBLICATION FACTS (FR-051). A `StandardPublication` lives at the reserved
//     `PLATFORM_SCOPE` (never a tenant), carries the common facts (identifier, exact title,
//     publisher, edition, publication status, material type) and a monotonic `registryVersion`.
//     A tenant-scoped decision CANNOT rewrite those facts — the factory forbids a tenant-scoped
//     publication, and every change is a NEW version (append-only).
//   * INDEPENDENT REVIEW GATES ACTIVATION (FR-053). An `ApplicabilityDecision` starts `proposed`
//     and MUST NOT become `active` until an independent reviewer (distinct from proposer and the
//     affected control owner) approves it. `applicabilityIsActive` returns true only for an
//     `active` decision whose reviewer is set and distinct from the proposer.
//   * NON-APPLICABILITY DOES NOT SUPPRESS A STALE GAP (FR-054). A `not_applicable` decision retains
//     its justification/evidence/owner/review date; `nonApplicabilityReopensGap` returns true once
//     its review/expiry instant passes (its basis is stale), so an expired non-applicability reopens
//     the coverage gap it was silencing.
//   * EVERY CHANGE IS A NEW VERSION (FR-056). `applicabilityVersionSupersedes` enforces a strictly
//     increasing version chain; prior decisions are preserved, never mutated.
//   * 42006 IS AUDIT-READINESS, NOT A CONFORMITY OBLIGATION (FR-055). `publicationDutyClass`
//     classifies ISO/IEC 42006 as `certification_body_criteria` unless the tenant is itself an
//     approved certification body for that scope.
//   * READINESS ≠ CERTIFICATION (FR-032 / SC-012). The `CLAIM_BOUNDARIES` vocabulary keeps
//     `design`/`implemented`/`operating`/`ready`/`assessed` distinct from `certified`; only a
//     verifiable external certification (issuer + certificate id + validity + status) reaches
//     `certified` (enforced by external-assurance.ts at the application layer over `ExternalCertification`).
//
// Authority, independence, and policy currency are NOT decided here — those verdicts come from the
// application services (@trustcircle/authz compliance-review, applicability-service) and are threaded
// in. This module owns the SHAPE and the fail-visible field vocabularies.

import { createHash } from 'node:crypto';
import { isUuid, PLATFORM_SCOPE, type Uuid, type EpochMillis, type Reason } from './primitives.ts';

// ---------------------------------------------------------------------------
// Shared assert helpers (mirror integrity.ts / decisions.ts: fail-visible, throw on violation).
// ---------------------------------------------------------------------------

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}

function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertEpoch(n: unknown, label: string): asserts n is EpochMillis {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms`);
  }
}

function assertMember<T extends string>(
  v: string,
  members: readonly T[],
  label: string,
): asserts v is T {
  if (!members.includes(v as T)) {
    throw new TypeError(`${label} must be one of ${members.join('|')}, got '${v}'`);
  }
}

function assertVersion(n: unknown, label: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new RangeError(`${label} must be an integer ≥ 1`);
  }
}

function assertReasonValue(r: unknown, label: string): asserts r is Reason {
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof (r as Reason).code !== 'string' ||
    (r as Reason).code.length === 0 ||
    typeof (r as Reason).text !== 'string' ||
    (r as Reason).text.trim().length === 0
  ) {
    throw new TypeError(`${label} must be a structured non-empty reason {code,text}`);
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** Drop keys whose value is `undefined` (exactOptionalPropertyTypes) and freeze. */
function compact<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.freeze(out) as T;
}

function frozenObj(o: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...(o ?? {}) });
}

// ===========================================================================
// 1. Shared compliance vocabularies (mirror the migration CHECK domains exactly).
// ===========================================================================

/** A standard's material type — how the platform must present it (FR-032, FR-051). */
export const MATERIAL_TYPES = [
  'requirements', // normative "shall" clauses (an organizational duty when applicable)
  'guidance', // informative recommendations ("should") — never a conformity obligation
  'certification_body_criteria', // ISO/IEC 42006-style audit-readiness / accreditation criteria
  'impact_assessment_guidance', // ISO/IEC 42005-style AI-system impact-assessment guidance
  'draft', // a draft / work-item publication (not yet in force)
  'amendment', // an amendment to an existing edition
  'corrigendum', // a corrigendum (technical correction)
] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];

/** A publication's lifecycle status in the registry (FR-051). */
export const PUBLICATION_STATUSES = [
  'published',
  'under_development',
  'draft',
  'withdrawn',
  'superseded',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** How a publication's duty is classified for a scope (FR-032 / FR-055). */
export const DUTY_CLASSES = [
  'organizational_obligation', // a duty the org must satisfy (requirements it declares applicable)
  'platform_capability', // a capability the platform provides (not an org duty)
  'internal_readiness', // internal readiness / self-assessment (NOT external assurance)
  'external_assessment', // an external assessment (an audit performed by another party)
  'certification', // an external certification (issued by an accredited body)
  'certification_body_criteria', // 42006: criteria a certification BODY must meet (not an org duty)
  'guidance', // informative guidance
] as const;
export type DutyClass = (typeof DUTY_CLASSES)[number];

/**
 * The applicability decision result — the four values a tenant compliance owner may propose (FR-052).
 * `not_applicable` is retained and visible; it does NOT silently suppress a gap once stale (FR-054).
 */
export const APPLICABILITY_RESULTS = [
  'applicable',
  'partially_applicable',
  'not_applicable',
  'uncertain',
] as const;
export type ApplicabilityResult = (typeof APPLICABILITY_RESULTS)[number];

/** The applicability decision lifecycle (FR-053). `proposed` → active/rejected/changes/expired. */
export const APPLICABILITY_STATES = [
  'proposed',
  'active',
  'rejected',
  'changes_requested',
  'expired',
  'superseded',
] as const;
export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];

/** Independent-review action verbs (FR-053). */
export const APPLICABILITY_ACTIONS = ['approve', 'reject', 'request_changes', 'expire'] as const;
export type ApplicabilityAction = (typeof APPLICABILITY_ACTIONS)[number];

/**
 * The claim boundary a coverage view may report (FR-032 / SC-012). These are ORDERED by increasing
 * assurance: internal readiness states (`design`..`ready`) are strictly below external
 * `assessed`/`certified`. `incomplete` means the picture itself is partial. Only a verifiable
 * external certification reaches `certified` — internal readiness NEVER masquerades as certification.
 */
export const CLAIM_BOUNDARIES = [
  'design',
  'implemented',
  'operating',
  'ready',
  'assessed',
  'certified',
  'incomplete',
] as const;
export type ClaimBoundary = (typeof CLAIM_BOUNDARIES)[number];

/** The internal-readiness claim boundaries — those that MUST NOT be shown as external certification. */
export const INTERNAL_CLAIM_BOUNDARIES: readonly ClaimBoundary[] = [
  'design',
  'implemented',
  'operating',
  'ready',
];

/** True iff `b` is an internal-readiness boundary (never external assurance). */
export function isInternalClaim(b: ClaimBoundary): boolean {
  return INTERNAL_CLAIM_BOUNDARIES.includes(b);
}

// ===========================================================================
// 2. standard_publication — an IMMUTABLE version of a global publication fact (FR-051).
//    Lives at PLATFORM_SCOPE; tenant-scoped decisions MUST NOT rewrite these facts.
// ===========================================================================

export interface StandardPublication {
  readonly id: Uuid;
  /** ALWAYS the platform scope — a publication fact is global, never tenant-owned. */
  readonly tenantId: typeof PLATFORM_SCOPE;
  readonly publisher: string;
  /** The public identifier, e.g. "ISO/IEC 42001:2023". */
  readonly identifier: string;
  readonly exactTitle: string;
  readonly edition: string;
  /** Publication date as an ISO `YYYY-MM-DD` date string (matches the contract `format: date`). */
  readonly publicationDate: string;
  readonly status: PublicationStatus;
  readonly materialType: MaterialType;
  readonly sourceUri: string;
  /** Monotonic registry version; a new version is a new row (append-only). */
  readonly registryVersion: number;
  /** The prior publication this supersedes (FR-051 supersession history), if any. */
  readonly supersedesId?: Uuid;
  readonly createdAt: EpochMillis;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function makeStandardPublication(input: {
  id: Uuid;
  publisher: string;
  identifier: string;
  exactTitle: string;
  edition: string;
  publicationDate: string;
  status?: PublicationStatus;
  materialType: MaterialType;
  sourceUri: string;
  registryVersion?: number;
  supersedesId?: Uuid;
  createdAt: EpochMillis;
}): StandardPublication {
  assertUuid(input.id, 'publication.id');
  assertNonEmpty(input.publisher, 'publication.publisher');
  assertNonEmpty(input.identifier, 'publication.identifier');
  assertNonEmpty(input.exactTitle, 'publication.exactTitle');
  assertNonEmpty(input.edition, 'publication.edition');
  if (typeof input.publicationDate !== 'string' || !ISO_DATE_RE.test(input.publicationDate)) {
    throw new TypeError('publication.publicationDate must be an ISO YYYY-MM-DD date');
  }
  const status = input.status ?? 'published';
  assertMember(status, PUBLICATION_STATUSES, 'publication.status');
  assertMember(input.materialType, MATERIAL_TYPES, 'publication.materialType');
  assertNonEmpty(input.sourceUri, 'publication.sourceUri');
  const registryVersion = input.registryVersion ?? 1;
  assertVersion(registryVersion, 'publication.registryVersion');
  if (input.supersedesId !== undefined) assertUuid(input.supersedesId, 'publication.supersedesId');
  assertEpoch(input.createdAt, 'publication.createdAt');
  return compact<StandardPublication>({
    id: input.id,
    tenantId: PLATFORM_SCOPE,
    publisher: input.publisher,
    identifier: input.identifier,
    exactTitle: input.exactTitle,
    edition: input.edition,
    publicationDate: input.publicationDate,
    status,
    materialType: input.materialType,
    sourceUri: input.sourceUri,
    registryVersion,
    supersedesId: input.supersedesId,
    createdAt: input.createdAt,
  });
}

export function standardPublicationDigest(p: StandardPublication): string {
  return sha256(
    JSON.stringify({
      id: p.id,
      tenantId: p.tenantId,
      publisher: p.publisher,
      identifier: p.identifier,
      exactTitle: p.exactTitle,
      edition: p.edition,
      publicationDate: p.publicationDate,
      status: p.status,
      materialType: p.materialType,
      sourceUri: p.sourceUri,
      registryVersion: p.registryVersion,
      supersedesId: p.supersedesId ?? null,
      createdAt: p.createdAt,
    }),
  );
}

/**
 * The duty class ISO/IEC 42006 (or any certification-body publication) is classified as (FR-055).
 * 42006 is `certification_body_criteria` — audit-readiness / accreditation criteria — UNLESS the
 * tenant itself acts as a certification body AND applicability for that scope is independently
 * approved (`actsAsCertificationBody === true`), in which case it becomes an organizational duty.
 */
export function publicationDutyClass(
  p: StandardPublication,
  actsAsCertificationBody = false,
): DutyClass {
  if (p.materialType === 'certification_body_criteria') {
    return actsAsCertificationBody ? 'organizational_obligation' : 'certification_body_criteria';
  }
  if (p.materialType === 'guidance' || p.materialType === 'impact_assessment_guidance') {
    return 'guidance';
  }
  return 'organizational_obligation';
}

/** True iff `next` is a well-formed supersession of `prior` (strictly newer registry version). */
export function publicationSupersedes(
  prior: StandardPublication,
  next: StandardPublication,
): boolean {
  return (
    next.identifier === prior.identifier &&
    next.registryVersion > prior.registryVersion &&
    next.supersedesId === prior.id
  );
}

// ===========================================================================
// 3. clause_version — an IMMUTABLE version of one clause within a publication (FR-051, FR-056).
// ===========================================================================

export interface ClauseVersion {
  readonly id: Uuid;
  readonly tenantId: typeof PLATFORM_SCOPE;
  readonly publicationId: Uuid;
  /** The clause number, e.g. "6.1.2". */
  readonly clauseRef: string;
  readonly title: string;
  readonly materialType: MaterialType;
  readonly version: number;
  readonly supersedesId?: Uuid;
  readonly createdAt: EpochMillis;
}

export function makeClauseVersion(input: {
  id: Uuid;
  publicationId: Uuid;
  clauseRef: string;
  title: string;
  materialType?: MaterialType;
  version?: number;
  supersedesId?: Uuid;
  createdAt: EpochMillis;
}): ClauseVersion {
  assertUuid(input.id, 'clause.id');
  assertUuid(input.publicationId, 'clause.publicationId');
  assertNonEmpty(input.clauseRef, 'clause.clauseRef');
  assertNonEmpty(input.title, 'clause.title');
  const materialType = input.materialType ?? 'requirements';
  assertMember(materialType, MATERIAL_TYPES, 'clause.materialType');
  const version = input.version ?? 1;
  assertVersion(version, 'clause.version');
  if (input.supersedesId !== undefined) assertUuid(input.supersedesId, 'clause.supersedesId');
  assertEpoch(input.createdAt, 'clause.createdAt');
  return compact<ClauseVersion>({
    id: input.id,
    tenantId: PLATFORM_SCOPE,
    publicationId: input.publicationId,
    clauseRef: input.clauseRef,
    title: input.title,
    materialType,
    version,
    supersedesId: input.supersedesId,
    createdAt: input.createdAt,
  });
}

export function clauseVersionDigest(c: ClauseVersion): string {
  return sha256(
    JSON.stringify({
      id: c.id,
      publicationId: c.publicationId,
      clauseRef: c.clauseRef,
      title: c.title,
      materialType: c.materialType,
      version: c.version,
      supersedesId: c.supersedesId ?? null,
      createdAt: c.createdAt,
    }),
  );
}

// ===========================================================================
// 4. applicability_decision — a tenant-scoped, versioned applicability decision (FR-052..056).
//    Independent review gates activation; every change is a new version.
// ===========================================================================

export interface ApplicabilityDecision {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly clauseVersionId: Uuid;
  readonly systemId: Uuid;
  readonly jurisdiction: string;
  readonly useCase: Readonly<Record<string, unknown>>;
  readonly proposedResult: ApplicabilityResult;
  readonly rationale: string;
  readonly evidenceIds: readonly Uuid[];
  readonly obligationOwnerPrincipalId?: Uuid;
  readonly proposerPrincipalId: Uuid;
  readonly reviewerPrincipalId?: Uuid;
  readonly reviewDecision?: ApplicabilityAction;
  readonly reviewReason?: Reason;
  readonly state: ApplicabilityState;
  readonly effectiveFrom?: EpochMillis;
  /** The review-or-expiry instant. After it passes, a non-applicability's basis is stale (FR-054). */
  readonly reviewAt: EpochMillis;
  readonly version: number;
  readonly supersedesId?: Uuid;
  readonly createdAt: EpochMillis;
}

export function makeApplicabilityDecision(input: {
  id: Uuid;
  tenantId: Uuid;
  clauseVersionId: Uuid;
  systemId: Uuid;
  jurisdiction: string;
  useCase?: Record<string, unknown>;
  proposedResult: ApplicabilityResult;
  rationale: string;
  evidenceIds: readonly Uuid[];
  obligationOwnerPrincipalId?: Uuid;
  proposerPrincipalId: Uuid;
  reviewerPrincipalId?: Uuid;
  reviewDecision?: ApplicabilityAction;
  reviewReason?: Reason;
  state?: ApplicabilityState;
  effectiveFrom?: EpochMillis;
  reviewAt: EpochMillis;
  version?: number;
  supersedesId?: Uuid;
  createdAt: EpochMillis;
}): ApplicabilityDecision {
  assertUuid(input.id, 'applicability.id');
  assertUuid(input.tenantId, 'applicability.tenantId');
  assertUuid(input.clauseVersionId, 'applicability.clauseVersionId');
  assertUuid(input.systemId, 'applicability.systemId');
  assertNonEmpty(input.jurisdiction, 'applicability.jurisdiction');
  assertMember(input.proposedResult, APPLICABILITY_RESULTS, 'applicability.proposedResult');
  assertNonEmpty(input.rationale, 'applicability.rationale');
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length < 1) {
    throw new TypeError('applicability.evidenceIds must carry ≥ 1 supporting-evidence id (FR-052)');
  }
  for (const e of input.evidenceIds) assertUuid(e, 'applicability.evidenceIds[]');
  if (input.obligationOwnerPrincipalId !== undefined) {
    assertUuid(input.obligationOwnerPrincipalId, 'applicability.obligationOwnerPrincipalId');
  }
  assertUuid(input.proposerPrincipalId, 'applicability.proposerPrincipalId');
  const state = input.state ?? 'proposed';
  assertMember(state, APPLICABILITY_STATES, 'applicability.state');
  if (input.reviewerPrincipalId !== undefined) {
    assertUuid(input.reviewerPrincipalId, 'applicability.reviewerPrincipalId');
  }
  if (input.reviewDecision !== undefined) {
    assertMember(input.reviewDecision, APPLICABILITY_ACTIONS, 'applicability.reviewDecision');
  }
  if (input.reviewReason !== undefined)
    assertReasonValue(input.reviewReason, 'applicability.reviewReason');
  if (input.effectiveFrom !== undefined)
    assertEpoch(input.effectiveFrom, 'applicability.effectiveFrom');
  assertEpoch(input.reviewAt, 'applicability.reviewAt');
  const version = input.version ?? 1;
  assertVersion(version, 'applicability.version');
  if (input.supersedesId !== undefined)
    assertUuid(input.supersedesId, 'applicability.supersedesId');
  assertEpoch(input.createdAt, 'applicability.createdAt');

  // FR-053: an ACTIVE decision MUST carry an independent reviewer who approved it, and that reviewer
  // MUST be distinct from the proposer — activation without independent review is impossible.
  if (state === 'active') {
    if (input.reviewerPrincipalId === undefined) {
      throw new TypeError(
        'an active applicability decision requires an independent reviewer (FR-053)',
      );
    }
    if (input.reviewerPrincipalId === input.proposerPrincipalId) {
      throw new TypeError('the reviewer must be distinct from the proposer (FR-053)');
    }
    if (input.reviewDecision !== 'approve') {
      throw new TypeError(
        'an active applicability decision requires an approve review decision (FR-053)',
      );
    }
  }

  return compact<ApplicabilityDecision>({
    id: input.id,
    tenantId: input.tenantId,
    clauseVersionId: input.clauseVersionId,
    systemId: input.systemId,
    jurisdiction: input.jurisdiction,
    useCase: frozenObj(input.useCase),
    proposedResult: input.proposedResult,
    rationale: input.rationale,
    evidenceIds: Object.freeze([...input.evidenceIds]),
    obligationOwnerPrincipalId: input.obligationOwnerPrincipalId,
    proposerPrincipalId: input.proposerPrincipalId,
    reviewerPrincipalId: input.reviewerPrincipalId,
    reviewDecision: input.reviewDecision,
    reviewReason: input.reviewReason,
    state,
    effectiveFrom: input.effectiveFrom,
    reviewAt: input.reviewAt,
    version,
    supersedesId: input.supersedesId,
    createdAt: input.createdAt,
  });
}

export function applicabilityDecisionDigest(d: ApplicabilityDecision): string {
  return sha256(
    JSON.stringify({
      id: d.id,
      tenantId: d.tenantId,
      clauseVersionId: d.clauseVersionId,
      systemId: d.systemId,
      jurisdiction: d.jurisdiction,
      useCase: d.useCase,
      proposedResult: d.proposedResult,
      rationale: d.rationale,
      evidenceIds: [...d.evidenceIds],
      obligationOwnerPrincipalId: d.obligationOwnerPrincipalId ?? null,
      proposerPrincipalId: d.proposerPrincipalId,
      reviewerPrincipalId: d.reviewerPrincipalId ?? null,
      reviewDecision: d.reviewDecision ?? null,
      reviewReason: d.reviewReason ?? null,
      state: d.state,
      effectiveFrom: d.effectiveFrom ?? null,
      reviewAt: d.reviewAt,
      version: d.version,
      supersedesId: d.supersedesId ?? null,
      createdAt: d.createdAt,
    }),
  );
}

/**
 * True iff `d` is an ACTIVE applicability decision that has passed independent review (FR-053):
 * state is `active`, an independent reviewer approved it, and the reviewer is distinct from the
 * proposer. An un-reviewed / proposed decision is NEVER active.
 */
export function applicabilityIsActive(d: ApplicabilityDecision): boolean {
  return (
    d.state === 'active' &&
    d.reviewDecision === 'approve' &&
    d.reviewerPrincipalId !== undefined &&
    d.reviewerPrincipalId !== d.proposerPrincipalId
  );
}

/**
 * True iff a `not_applicable` decision's basis has become stale at `now` and its coverage gap must
 * REOPEN (FR-054): the decision claims non-applicability but its review/expiry instant has passed,
 * so it MUST NOT keep suppressing the gap. Applicable/other decisions never "reopen a gap" this way.
 */
export function nonApplicabilityReopensGap(d: ApplicabilityDecision, now: EpochMillis): boolean {
  assertEpoch(now, 'now');
  if (d.proposedResult !== 'not_applicable') return false;
  if (!applicabilityIsActive(d) && d.state !== 'active') return false;
  return now >= d.reviewAt;
}

/** True iff `next` is a valid supersession of `prior` (FR-056: strictly newer version chain). */
export function applicabilityVersionSupersedes(
  prior: ApplicabilityDecision,
  next: ApplicabilityDecision,
): boolean {
  return (
    next.tenantId === prior.tenantId &&
    next.clauseVersionId === prior.clauseVersionId &&
    next.systemId === prior.systemId &&
    next.version > prior.version &&
    next.supersedesId === prior.id
  );
}

// ===========================================================================
// 5. obligation + control_mapping — a duty derived from an applicable clause, and its many-to-many
//    control mappings with shared responsibility + evidence expectations (FR-031, FR-034).
// ===========================================================================

/** Who is accountable for a shared-responsibility control (FR-031). */
export const RESPONSIBILITY_PARTIES = ['organization', 'platform', 'shared', 'external'] as const;
export type ResponsibilityParty = (typeof RESPONSIBILITY_PARTIES)[number];

export interface Obligation {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly clauseVersionId: Uuid;
  readonly applicabilityDecisionId: Uuid;
  readonly dutyClass: DutyClass;
  readonly ownerPrincipalId: Uuid;
  readonly reviewAt: EpochMillis;
  readonly version: number;
  readonly createdAt: EpochMillis;
}

export function makeObligation(input: {
  id: Uuid;
  tenantId: Uuid;
  clauseVersionId: Uuid;
  applicabilityDecisionId: Uuid;
  dutyClass: DutyClass;
  ownerPrincipalId: Uuid;
  reviewAt: EpochMillis;
  version?: number;
  createdAt: EpochMillis;
}): Obligation {
  assertUuid(input.id, 'obligation.id');
  assertUuid(input.tenantId, 'obligation.tenantId');
  assertUuid(input.clauseVersionId, 'obligation.clauseVersionId');
  assertUuid(input.applicabilityDecisionId, 'obligation.applicabilityDecisionId');
  assertMember(input.dutyClass, DUTY_CLASSES, 'obligation.dutyClass');
  assertUuid(input.ownerPrincipalId, 'obligation.ownerPrincipalId');
  assertEpoch(input.reviewAt, 'obligation.reviewAt');
  const version = input.version ?? 1;
  assertVersion(version, 'obligation.version');
  assertEpoch(input.createdAt, 'obligation.createdAt');
  return compact<Obligation>({
    id: input.id,
    tenantId: input.tenantId,
    clauseVersionId: input.clauseVersionId,
    applicabilityDecisionId: input.applicabilityDecisionId,
    dutyClass: input.dutyClass,
    ownerPrincipalId: input.ownerPrincipalId,
    reviewAt: input.reviewAt,
    version,
    createdAt: input.createdAt,
  });
}

export function obligationDigest(o: Obligation): string {
  return sha256(
    JSON.stringify({
      id: o.id,
      tenantId: o.tenantId,
      clauseVersionId: o.clauseVersionId,
      applicabilityDecisionId: o.applicabilityDecisionId,
      dutyClass: o.dutyClass,
      ownerPrincipalId: o.ownerPrincipalId,
      reviewAt: o.reviewAt,
      version: o.version,
      createdAt: o.createdAt,
    }),
  );
}

export interface ControlMapping {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly obligationId: Uuid;
  readonly controlId: Uuid;
  readonly responsibility: ResponsibilityParty;
  /** The evidence expectation this control must produce to be reported operating (FR-031/FR-034). */
  readonly evidenceExpectations: readonly string[];
  readonly evidenceWindowMillis: number;
  readonly reviewAt: EpochMillis;
  readonly version: number;
  readonly createdAt: EpochMillis;
}

export function makeControlMapping(input: {
  id: Uuid;
  tenantId: Uuid;
  obligationId: Uuid;
  controlId: Uuid;
  responsibility: ResponsibilityParty;
  evidenceExpectations: readonly string[];
  evidenceWindowMillis: number;
  reviewAt: EpochMillis;
  version?: number;
  createdAt: EpochMillis;
}): ControlMapping {
  assertUuid(input.id, 'mapping.id');
  assertUuid(input.tenantId, 'mapping.tenantId');
  assertUuid(input.obligationId, 'mapping.obligationId');
  assertUuid(input.controlId, 'mapping.controlId');
  assertMember(input.responsibility, RESPONSIBILITY_PARTIES, 'mapping.responsibility');
  if (!Array.isArray(input.evidenceExpectations) || input.evidenceExpectations.length < 1) {
    throw new TypeError('mapping.evidenceExpectations must be a non-empty array (FR-031)');
  }
  for (const x of input.evidenceExpectations) assertNonEmpty(x, 'mapping.evidenceExpectations[]');
  if (!Number.isInteger(input.evidenceWindowMillis) || input.evidenceWindowMillis <= 0) {
    throw new RangeError('mapping.evidenceWindowMillis must be a positive integer');
  }
  assertEpoch(input.reviewAt, 'mapping.reviewAt');
  const version = input.version ?? 1;
  assertVersion(version, 'mapping.version');
  assertEpoch(input.createdAt, 'mapping.createdAt');
  return compact<ControlMapping>({
    id: input.id,
    tenantId: input.tenantId,
    obligationId: input.obligationId,
    controlId: input.controlId,
    responsibility: input.responsibility,
    evidenceExpectations: Object.freeze([...input.evidenceExpectations]),
    evidenceWindowMillis: input.evidenceWindowMillis,
    reviewAt: input.reviewAt,
    version,
    createdAt: input.createdAt,
  });
}

export function controlMappingDigest(m: ControlMapping): string {
  return sha256(
    JSON.stringify({
      id: m.id,
      tenantId: m.tenantId,
      obligationId: m.obligationId,
      controlId: m.controlId,
      responsibility: m.responsibility,
      evidenceExpectations: [...m.evidenceExpectations],
      evidenceWindowMillis: m.evidenceWindowMillis,
      reviewAt: m.reviewAt,
      version: m.version,
      createdAt: m.createdAt,
    }),
  );
}

// ===========================================================================
// 6. assessment — an internal readiness / external assessment record (FR-032, FR-034).
// ===========================================================================

export const ASSESSMENT_KINDS = [
  'internal_readiness',
  'internal_audit',
  'external_assessment',
] as const;
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];

export const ASSESSMENT_RESULTS = [
  'ready',
  'not_ready',
  'conforming',
  'nonconforming',
  'inconclusive',
] as const;
export type AssessmentResult = (typeof ASSESSMENT_RESULTS)[number];

export interface Assessment {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly obligationId: Uuid;
  readonly kind: AssessmentKind;
  readonly result: AssessmentResult;
  readonly assessorPrincipalId: Uuid;
  readonly evidenceIds: readonly Uuid[];
  readonly assessedAt: EpochMillis;
  readonly version: number;
}

export function makeAssessment(input: {
  id: Uuid;
  tenantId: Uuid;
  obligationId: Uuid;
  kind: AssessmentKind;
  result: AssessmentResult;
  assessorPrincipalId: Uuid;
  evidenceIds?: readonly Uuid[];
  assessedAt: EpochMillis;
  version?: number;
}): Assessment {
  assertUuid(input.id, 'assessment.id');
  assertUuid(input.tenantId, 'assessment.tenantId');
  assertUuid(input.obligationId, 'assessment.obligationId');
  assertMember(input.kind, ASSESSMENT_KINDS, 'assessment.kind');
  assertMember(input.result, ASSESSMENT_RESULTS, 'assessment.result');
  assertUuid(input.assessorPrincipalId, 'assessment.assessorPrincipalId');
  const evidenceIds = input.evidenceIds ?? [];
  for (const e of evidenceIds) assertUuid(e, 'assessment.evidenceIds[]');
  assertEpoch(input.assessedAt, 'assessment.assessedAt');
  const version = input.version ?? 1;
  assertVersion(version, 'assessment.version');
  return compact<Assessment>({
    id: input.id,
    tenantId: input.tenantId,
    obligationId: input.obligationId,
    kind: input.kind,
    result: input.result,
    assessorPrincipalId: input.assessorPrincipalId,
    evidenceIds: Object.freeze([...evidenceIds]),
    assessedAt: input.assessedAt,
    version,
  });
}

export function assessmentDigest(a: Assessment): string {
  return sha256(
    JSON.stringify({
      id: a.id,
      tenantId: a.tenantId,
      obligationId: a.obligationId,
      kind: a.kind,
      result: a.result,
      assessorPrincipalId: a.assessorPrincipalId,
      evidenceIds: [...a.evidenceIds],
      assessedAt: a.assessedAt,
      version: a.version,
    }),
  );
}

// ===========================================================================
// 7. external_certification — a VERIFIABLE external certification (FR-032 / FR-055 / SC-012).
//    A certification MUST carry issuer, certificate id, scope, validity, status, and verifiable
//    external evidence before it may be DISPLAYED — internal readiness is never certification.
// ===========================================================================

export const CERTIFICATION_STATUSES = ['valid', 'suspended', 'withdrawn', 'expired'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

export interface ExternalCertification {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly publicationId: Uuid;
  readonly issuer: string;
  readonly certificateId: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly validFrom: EpochMillis;
  readonly validUntil: EpochMillis;
  readonly status: CertificationStatus;
  /** A verifiable external-evidence reference (a signed URL / accreditation-registry pointer). */
  readonly verificationUri: string;
  readonly version: number;
  readonly createdAt: EpochMillis;
}

export function makeExternalCertification(input: {
  id: Uuid;
  tenantId: Uuid;
  publicationId: Uuid;
  issuer: string;
  certificateId: string;
  scope?: Record<string, unknown>;
  validFrom: EpochMillis;
  validUntil: EpochMillis;
  status?: CertificationStatus;
  verificationUri: string;
  version?: number;
  createdAt: EpochMillis;
}): ExternalCertification {
  assertUuid(input.id, 'certification.id');
  assertUuid(input.tenantId, 'certification.tenantId');
  assertUuid(input.publicationId, 'certification.publicationId');
  assertNonEmpty(input.issuer, 'certification.issuer');
  assertNonEmpty(input.certificateId, 'certification.certificateId');
  assertEpoch(input.validFrom, 'certification.validFrom');
  assertEpoch(input.validUntil, 'certification.validUntil');
  if (!(input.validFrom < input.validUntil)) {
    throw new RangeError('certification.validFrom must be before validUntil');
  }
  const status = input.status ?? 'valid';
  assertMember(status, CERTIFICATION_STATUSES, 'certification.status');
  assertNonEmpty(input.verificationUri, 'certification.verificationUri');
  const version = input.version ?? 1;
  assertVersion(version, 'certification.version');
  assertEpoch(input.createdAt, 'certification.createdAt');
  return compact<ExternalCertification>({
    id: input.id,
    tenantId: input.tenantId,
    publicationId: input.publicationId,
    issuer: input.issuer,
    certificateId: input.certificateId,
    scope: frozenObj(input.scope),
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    status,
    verificationUri: input.verificationUri,
    version,
    createdAt: input.createdAt,
  });
}

export function externalCertificationDigest(c: ExternalCertification): string {
  return sha256(
    JSON.stringify({
      id: c.id,
      tenantId: c.tenantId,
      publicationId: c.publicationId,
      issuer: c.issuer,
      certificateId: c.certificateId,
      scope: c.scope,
      validFrom: c.validFrom,
      validUntil: c.validUntil,
      status: c.status,
      verificationUri: c.verificationUri,
      version: c.version,
      createdAt: c.createdAt,
    }),
  );
}

/**
 * True iff `c` is currently DISPLAYABLE as an external certification at `now` (FR-055 / SC-012):
 * it carries issuer, certificate id, a verifiable external-evidence reference, its status is `valid`,
 * and `now` is within its validity window. An expired/withdrawn/suspended certification is NEVER
 * displayed as `certified` — the coverage view falls back to a readiness claim.
 */
export function certificationIsDisplayable(c: ExternalCertification, now: EpochMillis): boolean {
  assertEpoch(now, 'now');
  return (
    c.status === 'valid' &&
    c.issuer.trim().length > 0 &&
    c.certificateId.trim().length > 0 &&
    c.verificationUri.trim().length > 0 &&
    now >= c.validFrom &&
    now < c.validUntil
  );
}
