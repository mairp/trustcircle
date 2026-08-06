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
  governedDigest,
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
    return {
      derived: false,
      obligation: null,
      dutyClass,
      digest: null,
      rejectionCode: 'NOT_ACTIVE',
    };
  }
  if (input.decision.proposedResult === 'not_applicable') {
    return {
      derived: false,
      obligation: null,
      dutyClass,
      digest: null,
      rejectionCode: 'NOT_APPLICABLE',
    };
  }
  if (dutyClass !== 'organizational_obligation') {
    return {
      derived: false,
      obligation: null,
      dutyClass,
      digest: null,
      rejectionCode: 'NOT_AN_OBLIGATION',
    };
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

export const FRAMEWORK_MAPPING_TYPES = [
  'equivalent',
  'supports',
  'partially_supports',
  'conditional',
  'conflicts',
  'supersedes',
  'related',
  'not_applicable',
] as const;
export type FrameworkMappingType = (typeof FRAMEWORK_MAPPING_TYPES)[number];

export const FRAMEWORK_SOURCE_MATERIAL_TYPES = [
  'requirement',
  'guidance',
  'draft',
  'organizational_duty',
  'external_certification',
] as const;
export type FrameworkSourceMaterialType = (typeof FRAMEWORK_SOURCE_MATERIAL_TYPES)[number];

export type FrameworkMappingTargetType =
  'control' | 'obligation' | 'framework_clause' | 'evidence_expectation';
export type FrameworkCoverageExtent = 'full' | 'partial' | 'conditional' | 'disputed' | 'none';
export type FrameworkApplicabilityState =
  'applicable' | 'conditional' | 'not_applicable' | 'undetermined';
export type FrameworkMappingStatus = 'proposed' | 'active' | 'disputed' | 'superseded' | 'retired';
export type FrameworkMappingConfidenceBand = 'low' | 'medium' | 'high';

export interface FrameworkMappingHistoryEntry {
  readonly sequence: number;
  readonly action: 'proposed' | 'reviewed' | 'superseded';
  readonly status: FrameworkMappingStatus;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId?: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly occurredAt: number;
  readonly recordDigest: string;
}

export interface FrameworkMappingRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly sourcePublicationId: string;
  readonly sourceClauseRef: string;
  readonly sourceMaterialType: FrameworkSourceMaterialType;
  readonly targetType: FrameworkMappingTargetType;
  readonly targetRef: string;
  readonly mappingType: FrameworkMappingType;
  readonly coverageExtent: FrameworkCoverageExtent;
  readonly conditions: readonly string[];
  readonly applicabilityState: FrameworkApplicabilityState;
  readonly obligationOwnerPrincipalId?: string;
  readonly mappingOwnerPrincipalId: string;
  readonly evidenceRefs: readonly string[];
  readonly rationale: string;
  readonly confidenceBand: FrameworkMappingConfidenceBand;
  readonly status: FrameworkMappingStatus;
  readonly version: number;
  readonly supersedesMappingId?: string;
  readonly supersededByMappingId?: string;
  readonly reviewedByPrincipalId?: string;
  readonly reviewedAt?: number;
  readonly authorityDecisionId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly history: readonly FrameworkMappingHistoryEntry[];
}

export interface CreateFrameworkMappingInput {
  readonly id: string;
  readonly tenantId: string;
  readonly sourcePublicationId: string;
  readonly sourceClauseRef: string;
  readonly sourceMaterialType: FrameworkSourceMaterialType;
  readonly targetType: FrameworkMappingTargetType;
  readonly targetRef: string;
  readonly mappingType: FrameworkMappingType;
  readonly coverageExtent: FrameworkCoverageExtent;
  readonly conditions: readonly string[];
  readonly applicabilityState: FrameworkApplicabilityState;
  readonly obligationOwnerPrincipalId?: string;
  readonly mappingOwnerPrincipalId: string;
  readonly evidenceRefs: readonly string[];
  readonly rationale: string;
  readonly confidenceBand: FrameworkMappingConfidenceBand;
  readonly supersedesMappingId?: string;
  readonly now: number;
}

export interface ReviewFrameworkMappingInput {
  readonly mapping: FrameworkMappingRecord;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly reviewerPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly verdict: 'active' | 'disputed';
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

export interface SupersedeFrameworkMappingInput {
  readonly mapping: FrameworkMappingRecord;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly successorMappingId: string;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

const FRAMEWORK_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function frameworkText(value: unknown, label: string, max = 2_000): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(label + ' must be bounded non-empty text');
  }
}

function frameworkUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !FRAMEWORK_UUID_RE.test(value)) {
    throw new TypeError(label + ' must be a UUID');
  }
}

function frameworkEpoch(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(label + ' must be a non-negative epoch-ms');
  }
}

function frameworkList(
  value: readonly string[],
  label: string,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(label + ' must be ' + (allowEmpty ? 'a list' : 'a non-empty list'));
  }
  for (const item of value) frameworkText(item, label + ' item', 512);
  const unique = [...new Set(value.map((item) => item.trim()))].sort();
  if (unique.length !== value.length) throw new TypeError(label + ' must not contain duplicates');
  return Object.freeze(unique);
}

function frameworkReason(
  value: Readonly<{ code: string; text: string }>,
): Readonly<{ code: string; text: string }> {
  frameworkText(value?.code, 'reason code', 128);
  frameworkText(value?.text, 'reason text', 2_000);
  return Object.freeze({ code: value.code.trim(), text: value.text.trim() });
}

function mappingDigest(item: Omit<FrameworkMappingRecord, 'history'>): string {
  return governedDigest({
    id: item.id,
    tenantId: item.tenantId,
    sourcePublicationId: item.sourcePublicationId,
    sourceClauseRef: item.sourceClauseRef,
    sourceMaterialType: item.sourceMaterialType,
    targetType: item.targetType,
    targetRef: item.targetRef,
    mappingType: item.mappingType,
    coverageExtent: item.coverageExtent,
    conditions: item.conditions,
    applicabilityState: item.applicabilityState,
    mappingOwnerPrincipalId: item.mappingOwnerPrincipalId,
    evidenceRefs: item.evidenceRefs,
    rationale: item.rationale,
    confidenceBand: item.confidenceBand,
    status: item.status,
    version: item.version,
    supersedesMappingId: item.supersedesMappingId ?? null,
    supersededByMappingId: item.supersededByMappingId ?? null,
  });
}

function frameworkHistory(
  item: Omit<FrameworkMappingRecord, 'history'>,
  action: FrameworkMappingHistoryEntry['action'],
  actorPrincipalId: string,
  authorityDecisionId: string | undefined,
  why: Readonly<{ code: string; text: string }>,
  occurredAt: number,
): FrameworkMappingHistoryEntry {
  return Object.freeze({
    sequence: item.version,
    action,
    status: item.status,
    actorPrincipalId,
    ...(authorityDecisionId === undefined ? {} : { authorityDecisionId }),
    reason: why,
    occurredAt,
    recordDigest: mappingDigest(item),
  });
}

function freezeFrameworkMapping(
  item: Omit<FrameworkMappingRecord, 'history'>,
  history: readonly FrameworkMappingHistoryEntry[],
): FrameworkMappingRecord {
  return Object.freeze({
    ...item,
    conditions: Object.freeze([...item.conditions]),
    evidenceRefs: Object.freeze([...item.evidenceRefs]),
    history: Object.freeze([...history]),
  });
}

function guardFrameworkMapping(
  mapping: FrameworkMappingRecord,
  tenantId: string,
  expectedVersion: number,
): void {
  if (mapping.tenantId !== tenantId) throw new RangeError('framework mapping tenant mismatch');
  if (mapping.version !== expectedVersion) {
    throw new RangeError('framework mapping changed; reload its current version');
  }
}

export function createFrameworkMapping(input: CreateFrameworkMappingInput): FrameworkMappingRecord {
  frameworkUuid(input.id, 'framework mapping id');
  frameworkUuid(input.tenantId, 'tenant id');
  frameworkUuid(input.sourcePublicationId, 'source publication id');
  frameworkUuid(input.mappingOwnerPrincipalId, 'mapping owner principal id');
  if (input.obligationOwnerPrincipalId !== undefined) {
    frameworkUuid(input.obligationOwnerPrincipalId, 'obligation owner principal id');
  }
  if (input.supersedesMappingId !== undefined) {
    frameworkUuid(input.supersedesMappingId, 'superseded mapping id');
  }
  frameworkText(input.sourceClauseRef, 'source clause ref', 256);
  frameworkText(input.targetRef, 'target ref', 512);
  frameworkText(input.rationale, 'mapping rationale', 2_000);
  frameworkEpoch(input.now, 'mapping creation time');
  if (!FRAMEWORK_SOURCE_MATERIAL_TYPES.includes(input.sourceMaterialType)) {
    throw new TypeError('framework source material type is unsupported');
  }
  if (
    !['control', 'obligation', 'framework_clause', 'evidence_expectation'].includes(
      input.targetType,
    )
  ) {
    throw new TypeError('framework mapping target type is unsupported');
  }
  if (!FRAMEWORK_MAPPING_TYPES.includes(input.mappingType)) {
    throw new TypeError('framework mapping type is unsupported');
  }
  if (!['full', 'partial', 'conditional', 'disputed', 'none'].includes(input.coverageExtent)) {
    throw new TypeError('framework coverage extent is unsupported');
  }
  if (
    !['applicable', 'conditional', 'not_applicable', 'undetermined'].includes(
      input.applicabilityState,
    )
  ) {
    throw new TypeError('framework applicability state is unsupported');
  }
  if (!['low', 'medium', 'high'].includes(input.confidenceBand)) {
    throw new TypeError('framework mapping confidence band is unsupported');
  }
  const conditions = frameworkList(input.conditions, 'mapping conditions', true);
  if (
    (input.mappingType === 'conditional' ||
      input.coverageExtent === 'conditional' ||
      input.applicabilityState === 'conditional') &&
    conditions.length === 0
  ) {
    throw new RangeError('conditional framework mappings require explicit conditions');
  }
  if (
    input.mappingType === 'not_applicable' &&
    (input.applicabilityState !== 'not_applicable' || input.coverageExtent !== 'none')
  ) {
    throw new RangeError('not-applicable mappings must keep applicability and coverage explicit');
  }
  const evidenceRefs = frameworkList(input.evidenceRefs, 'mapping evidence refs', true);
  const why = Object.freeze({
    code: 'mapping.proposed',
    text: 'A mapping owner proposed the exact typed framework relationship.',
  });
  const base: Omit<FrameworkMappingRecord, 'history'> = {
    id: input.id,
    tenantId: input.tenantId,
    sourcePublicationId: input.sourcePublicationId,
    sourceClauseRef: input.sourceClauseRef.trim(),
    sourceMaterialType: input.sourceMaterialType,
    targetType: input.targetType,
    targetRef: input.targetRef.trim(),
    mappingType: input.mappingType,
    coverageExtent: input.coverageExtent,
    conditions,
    applicabilityState: input.applicabilityState,
    ...(input.obligationOwnerPrincipalId === undefined
      ? {}
      : { obligationOwnerPrincipalId: input.obligationOwnerPrincipalId }),
    mappingOwnerPrincipalId: input.mappingOwnerPrincipalId,
    evidenceRefs,
    rationale: input.rationale.trim(),
    confidenceBand: input.confidenceBand,
    status: 'proposed',
    version: 1,
    ...(input.supersedesMappingId === undefined
      ? {}
      : { supersedesMappingId: input.supersedesMappingId }),
    createdAt: input.now,
    updatedAt: input.now,
  };
  return freezeFrameworkMapping(base, [
    frameworkHistory(base, 'proposed', input.mappingOwnerPrincipalId, undefined, why, input.now),
  ]);
}

export function reviewFrameworkMapping(input: ReviewFrameworkMappingInput): FrameworkMappingRecord {
  guardFrameworkMapping(input.mapping, input.tenantId, input.expectedVersion);
  if (input.mapping.status !== 'proposed') {
    throw new RangeError('only a proposed framework mapping can be reviewed');
  }
  frameworkUuid(input.reviewerPrincipalId, 'mapping reviewer principal id');
  frameworkText(input.authorityDecisionId, 'mapping authority decision id', 256);
  frameworkEpoch(input.now, 'mapping review time');
  if (input.reviewerPrincipalId === input.mapping.mappingOwnerPrincipalId) {
    throw new RangeError('framework mapping review must be distinct; self-review is denied');
  }
  const why = frameworkReason(input.reason);
  const next: Omit<FrameworkMappingRecord, 'history'> = {
    ...input.mapping,
    status: input.verdict,
    version: input.mapping.version + 1,
    reviewedByPrincipalId: input.reviewerPrincipalId,
    reviewedAt: input.now,
    authorityDecisionId: input.authorityDecisionId,
    updatedAt: input.now,
  };
  return freezeFrameworkMapping(next, [
    ...input.mapping.history,
    frameworkHistory(
      next,
      'reviewed',
      input.reviewerPrincipalId,
      input.authorityDecisionId,
      why,
      input.now,
    ),
  ]);
}

export function supersedeFrameworkMapping(
  input: SupersedeFrameworkMappingInput,
): FrameworkMappingRecord {
  guardFrameworkMapping(input.mapping, input.tenantId, input.expectedVersion);
  if (!['active', 'disputed'].includes(input.mapping.status)) {
    throw new RangeError('only a reviewed framework mapping can be superseded');
  }
  frameworkUuid(input.successorMappingId, 'successor mapping id');
  frameworkUuid(input.actorPrincipalId, 'superseding actor principal id');
  frameworkText(input.authorityDecisionId, 'superseding authority decision id', 256);
  frameworkEpoch(input.now, 'superseding time');
  if (input.successorMappingId === input.mapping.id) {
    throw new RangeError('a framework mapping cannot supersede itself');
  }
  const why = frameworkReason(input.reason);
  const next: Omit<FrameworkMappingRecord, 'history'> = {
    ...input.mapping,
    status: 'superseded',
    version: input.mapping.version + 1,
    supersededByMappingId: input.successorMappingId,
    authorityDecisionId: input.authorityDecisionId,
    updatedAt: input.now,
  };
  return freezeFrameworkMapping(next, [
    ...input.mapping.history,
    frameworkHistory(
      next,
      'superseded',
      input.actorPrincipalId,
      input.authorityDecisionId,
      why,
      input.now,
    ),
  ]);
}
