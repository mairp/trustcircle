import { governedDigest } from '@trustcircle/domain';

export const ENTITY_RESOLUTION_PROPOSAL_TYPES = ['link', 'merge', 'split', 'reject_link'] as const;
export type EntityResolutionProposalType = (typeof ENTITY_RESOLUTION_PROPOSAL_TYPES)[number];

export const ENTITY_RESOLUTION_STATUSES = [
  'proposed',
  'under_review',
  'accepted',
  'rejected',
  'applied',
  'rollback_pending',
  'rolled_back',
  'failed',
] as const;
export type EntityResolutionStatus = (typeof ENTITY_RESOLUTION_STATUSES)[number];
export type EntityResolutionConfidenceBand = 'low' | 'medium' | 'high';
export type EntityResolutionTransition =
  'start_review' | 'accept' | 'reject' | 'apply' | 'fail' | 'request_rollback' | 'rollback';

export interface ImmutableSourceIdentity {
  readonly tenantId: string;
  readonly sourceSystemId: string;
  readonly sourceRecordId: string;
  readonly sourceDigest: string;
}

export interface ProjectionInvalidation {
  readonly projectionRef: string;
  readonly reason: 'resolution_accepted' | 'resolution_rollback';
  readonly caseId: string;
  readonly caseVersion: number;
}

export interface EntityResolutionHistoryEntry {
  readonly sequence: number;
  readonly transition: 'propose' | EntityResolutionTransition;
  readonly fromStatus?: EntityResolutionStatus;
  readonly toStatus: EntityResolutionStatus;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId?: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly occurredAt: number;
  readonly recordDigest: string;
}

export interface EntityResolutionCase {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceIdentities: readonly ImmutableSourceIdentity[];
  readonly candidateCanonicalEntityId: string;
  readonly proposalType: EntityResolutionProposalType;
  readonly confidenceBand: EntityResolutionConfidenceBand;
  readonly matchReasons: readonly string[];
  readonly conflictReasons: readonly string[];
  readonly affectedProjectionRefs: readonly string[];
  readonly proposedByPrincipalId: string;
  readonly status: EntityResolutionStatus;
  readonly reviewedByPrincipalId?: string;
  readonly decidedByPrincipalId?: string;
  readonly authorityDecisionId?: string;
  readonly decisionReason?: Readonly<{ code: string; text: string }>;
  readonly decidedAt?: number;
  readonly rollbackOfCaseId?: string;
  readonly appliedProjectionRefs: readonly string[];
  readonly failedProjectionRefs: readonly string[];
  readonly projectionInvalidations: readonly ProjectionInvalidation[];
  readonly reconciliationAvailable: boolean;
  readonly resourceVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly history: readonly EntityResolutionHistoryEntry[];
}

export interface CreateEntityResolutionCaseInput {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceIdentities: readonly ImmutableSourceIdentity[];
  readonly candidateCanonicalEntityId: string;
  readonly proposalType: EntityResolutionProposalType;
  readonly confidenceBand: EntityResolutionConfidenceBand;
  readonly matchReasons: readonly string[];
  readonly conflictReasons: readonly string[];
  readonly affectedProjectionRefs: readonly string[];
  readonly proposedByPrincipalId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

export interface TransitionEntityResolutionCaseInput {
  readonly caseRecord: EntityResolutionCase;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly transition: EntityResolutionTransition;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId?: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly appliedProjectionRefs?: readonly string[];
  readonly failedProjectionRefs?: readonly string[];
  readonly now: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SOURCE_FIELDS = new Set(['tenantId', 'sourceSystemId', 'sourceRecordId', 'sourceDigest']);

function text(value: unknown, label: string, max = 2_000): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(label + ' must be bounded non-empty text');
  }
}

function uuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TypeError(label + ' must be a UUID');
  }
}

function epoch(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(label + ' must be a non-negative epoch-ms');
  }
}

function reason(
  value: Readonly<{ code: string; text: string }>,
): Readonly<{ code: string; text: string }> {
  text(value?.code, 'reason code', 128);
  text(value?.text, 'reason text', 2_000);
  return Object.freeze({ code: value.code.trim(), text: value.text.trim() });
}

function stringList(
  value: readonly string[],
  label: string,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(label + ' must be ' + (allowEmpty ? 'a list' : 'a non-empty list'));
  }
  for (const item of value) text(item, label + ' item', 256);
  const unique = [...new Set(value.map((item) => item.trim()))].sort();
  if (unique.length !== value.length) throw new TypeError(label + ' must not contain duplicates');
  return Object.freeze(unique);
}

function sourceIdentities(
  values: readonly ImmutableSourceIdentity[],
  tenantId: string,
  proposalType: EntityResolutionProposalType,
): readonly ImmutableSourceIdentity[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('at least one immutable source identity is required');
  }
  const identities = values.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('source identity must be an object');
    }
    if (Object.keys(value).some((field) => !SOURCE_FIELDS.has(field))) {
      throw new TypeError('source identity contains an unsupported field');
    }
    uuid(value.tenantId, 'source identity tenant id');
    if (value.tenantId !== tenantId) {
      throw new RangeError('source identity belongs to another tenant');
    }
    text(value.sourceSystemId, 'source system id', 256);
    text(value.sourceRecordId, 'source record id', 256);
    if (!DIGEST_RE.test(value.sourceDigest)) {
      throw new TypeError('source identity digest must be a sha256 digest');
    }
    return Object.freeze({ ...value });
  });
  if ((proposalType === 'merge' || proposalType === 'link') && identities.length < 2) {
    throw new TypeError(proposalType + ' requires at least two source identities');
  }
  const keys = identities.map(
    (item) => item.sourceSystemId + '\u0000' + item.sourceRecordId + '\u0000' + item.sourceDigest,
  );
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('source identities must be unique');
  }
  return Object.freeze(identities);
}

function historyEntry(
  item: Omit<EntityResolutionCase, 'history'>,
  transition: EntityResolutionHistoryEntry['transition'],
  fromStatus: EntityResolutionStatus | undefined,
  actorPrincipalId: string,
  authorityDecisionId: string | undefined,
  why: Readonly<{ code: string; text: string }>,
  occurredAt: number,
): EntityResolutionHistoryEntry {
  return Object.freeze({
    sequence: item.resourceVersion,
    transition,
    ...(fromStatus === undefined ? {} : { fromStatus }),
    toStatus: item.status,
    actorPrincipalId,
    ...(authorityDecisionId === undefined ? {} : { authorityDecisionId }),
    reason: why,
    occurredAt,
    recordDigest: governedDigest({
      id: item.id,
      tenantId: item.tenantId,
      proposalType: item.proposalType,
      status: item.status,
      sourceIdentities: item.sourceIdentities,
      appliedProjectionRefs: item.appliedProjectionRefs,
      failedProjectionRefs: item.failedProjectionRefs,
      projectionInvalidations: item.projectionInvalidations,
      resourceVersion: item.resourceVersion,
    }),
  });
}

function freezeCase(
  item: Omit<EntityResolutionCase, 'history'>,
  history: readonly EntityResolutionHistoryEntry[],
): EntityResolutionCase {
  return Object.freeze({
    ...item,
    sourceIdentities: Object.freeze([...item.sourceIdentities]),
    matchReasons: Object.freeze([...item.matchReasons]),
    conflictReasons: Object.freeze([...item.conflictReasons]),
    affectedProjectionRefs: Object.freeze([...item.affectedProjectionRefs]),
    appliedProjectionRefs: Object.freeze([...item.appliedProjectionRefs]),
    failedProjectionRefs: Object.freeze([...item.failedProjectionRefs]),
    projectionInvalidations: Object.freeze([...item.projectionInvalidations]),
    history: Object.freeze([...history]),
  });
}

export function createEntityResolutionCase(
  input: CreateEntityResolutionCaseInput,
): EntityResolutionCase {
  uuid(input.id, 'entity resolution case id');
  uuid(input.tenantId, 'tenant id');
  uuid(input.proposedByPrincipalId, 'proposer principal id');
  text(input.candidateCanonicalEntityId, 'candidate canonical entity id', 256);
  epoch(input.now, 'proposal time');
  if (!ENTITY_RESOLUTION_PROPOSAL_TYPES.includes(input.proposalType)) {
    throw new TypeError('entity resolution proposal type is unsupported');
  }
  if (!['low', 'medium', 'high'].includes(input.confidenceBand)) {
    throw new TypeError('entity resolution confidence band is unsupported');
  }
  const sources = sourceIdentities(input.sourceIdentities, input.tenantId, input.proposalType);
  const matchReasons = stringList(input.matchReasons, 'match reasons', true);
  const conflictReasons = stringList(input.conflictReasons, 'conflict reasons', true);
  if (matchReasons.length === 0 && conflictReasons.length === 0) {
    throw new TypeError('entity resolution requires a match or conflict reason');
  }
  const affectedProjectionRefs = stringList(
    input.affectedProjectionRefs,
    'affected projection refs',
  );
  const why = reason(input.reason);
  const base: Omit<EntityResolutionCase, 'history'> = {
    id: input.id,
    tenantId: input.tenantId,
    sourceIdentities: sources,
    candidateCanonicalEntityId: input.candidateCanonicalEntityId.trim(),
    proposalType: input.proposalType,
    confidenceBand: input.confidenceBand,
    matchReasons,
    conflictReasons,
    affectedProjectionRefs,
    proposedByPrincipalId: input.proposedByPrincipalId,
    status: 'proposed',
    appliedProjectionRefs: Object.freeze([]),
    failedProjectionRefs: Object.freeze([]),
    projectionInvalidations: Object.freeze([]),
    reconciliationAvailable: false,
    resourceVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return freezeCase(base, [
    historyEntry(
      base,
      'propose',
      undefined,
      input.proposedByPrincipalId,
      undefined,
      why,
      input.now,
    ),
  ]);
}

const NEXT_STATUS: Readonly<Record<EntityResolutionTransition, EntityResolutionStatus>> = {
  start_review: 'under_review',
  accept: 'accepted',
  reject: 'rejected',
  apply: 'applied',
  fail: 'failed',
  request_rollback: 'rollback_pending',
  rollback: 'rolled_back',
};

function assertTransition(
  item: EntityResolutionCase,
  transition: EntityResolutionTransition,
): void {
  const allowed: Readonly<Record<EntityResolutionTransition, readonly EntityResolutionStatus[]>> = {
    start_review: ['proposed'],
    accept: ['under_review'],
    reject: ['under_review'],
    apply: ['accepted'],
    fail: ['accepted'],
    request_rollback: ['applied', 'failed'],
    rollback: ['rollback_pending'],
  };
  if (!allowed[transition].includes(item.status)) {
    throw new RangeError(
      'entity resolution transition ' + transition + ' is not allowed from ' + item.status,
    );
  }
}

function subset(
  refs: readonly string[] | undefined,
  affected: readonly string[],
  label: string,
  allowEmpty: boolean,
): readonly string[] {
  const values = stringList(refs ?? [], label, allowEmpty);
  if (values.some((ref) => !affected.includes(ref))) {
    throw new RangeError(label + ' must be a subset of affected projections');
  }
  return values;
}

function invalidations(
  item: EntityResolutionCase,
  reasonCode: ProjectionInvalidation['reason'],
  caseVersion: number,
): readonly ProjectionInvalidation[] {
  return Object.freeze(
    item.affectedProjectionRefs.map((projectionRef) =>
      Object.freeze({
        projectionRef,
        reason: reasonCode,
        caseId: item.id,
        caseVersion,
      }),
    ),
  );
}

export function transitionEntityResolutionCase(
  input: TransitionEntityResolutionCaseInput,
): EntityResolutionCase {
  const item = input.caseRecord;
  if (item.tenantId !== input.tenantId) {
    throw new RangeError('entity resolution case tenant mismatch');
  }
  if (item.resourceVersion !== input.expectedVersion) {
    throw new RangeError('entity resolution case changed; reload its current version');
  }
  if (!Object.prototype.hasOwnProperty.call(NEXT_STATUS, input.transition)) {
    throw new TypeError('entity resolution transition is unsupported');
  }
  assertTransition(item, input.transition);
  uuid(input.actorPrincipalId, 'transition actor principal id');
  epoch(input.now, 'transition time');
  const why = reason(input.reason);
  const decisionTransition = [
    'accept',
    'reject',
    'apply',
    'fail',
    'request_rollback',
    'rollback',
  ].includes(input.transition);
  if (decisionTransition) text(input.authorityDecisionId, 'authority decision id', 256);
  if (
    (input.transition === 'start_review' ||
      input.transition === 'accept' ||
      input.transition === 'reject') &&
    input.actorPrincipalId === item.proposedByPrincipalId
  ) {
    throw new RangeError('independent review is required; proposer self-review is denied');
  }
  if (
    (input.transition === 'accept' || input.transition === 'reject') &&
    item.reviewedByPrincipalId === undefined
  ) {
    throw new RangeError('entity resolution requires an independent review before decision');
  }

  const nextVersion = item.resourceVersion + 1;
  let appliedProjectionRefs = item.appliedProjectionRefs;
  let failedProjectionRefs = item.failedProjectionRefs;
  let projectionInvalidations = item.projectionInvalidations;
  let reconciliationAvailable = item.reconciliationAvailable;

  if (input.transition === 'accept') {
    projectionInvalidations =
      item.proposalType === 'merge' || item.proposalType === 'split' || item.proposalType === 'link'
        ? invalidations(item, 'resolution_accepted', nextVersion)
        : item.projectionInvalidations;
  }
  if (input.transition === 'apply') {
    appliedProjectionRefs = subset(
      input.appliedProjectionRefs,
      item.affectedProjectionRefs,
      'applied projection refs',
      false,
    );
    failedProjectionRefs = Object.freeze(
      item.affectedProjectionRefs.filter((ref) => !appliedProjectionRefs.includes(ref)),
    );
    if (failedProjectionRefs.length > 0) {
      throw new RangeError(
        'apply requires every affected projection; use fail for partial outcome',
      );
    }
  }
  if (input.transition === 'fail') {
    appliedProjectionRefs = subset(
      input.appliedProjectionRefs,
      item.affectedProjectionRefs,
      'applied projection refs',
      true,
    );
    failedProjectionRefs = subset(
      input.failedProjectionRefs,
      item.affectedProjectionRefs,
      'failed projection refs',
      false,
    );
    const accounted = new Set([...appliedProjectionRefs, ...failedProjectionRefs]);
    if (accounted.size !== item.affectedProjectionRefs.length) {
      throw new RangeError('partial failure must account for every affected projection');
    }
    reconciliationAvailable = true;
  }
  if (input.transition === 'request_rollback' || input.transition === 'rollback') {
    reconciliationAvailable = true;
  }
  if (input.transition === 'rollback') {
    projectionInvalidations = invalidations(item, 'resolution_rollback', nextVersion);
  }

  const nextStatus = NEXT_STATUS[input.transition];
  const next: Omit<EntityResolutionCase, 'history'> = {
    ...item,
    status: nextStatus,
    ...(input.transition === 'start_review'
      ? { reviewedByPrincipalId: input.actorPrincipalId }
      : {}),
    ...(input.transition === 'accept' || input.transition === 'reject'
      ? {
          decidedByPrincipalId: input.actorPrincipalId,
          authorityDecisionId: input.authorityDecisionId,
          decisionReason: why,
          decidedAt: input.now,
        }
      : {}),
    ...(input.transition === 'request_rollback' || input.transition === 'rollback'
      ? { rollbackOfCaseId: item.id }
      : {}),
    appliedProjectionRefs,
    failedProjectionRefs,
    projectionInvalidations,
    reconciliationAvailable,
    resourceVersion: nextVersion,
    updatedAt: input.now,
  };
  return freezeCase(next, [
    ...item.history,
    historyEntry(
      next,
      input.transition,
      item.status,
      input.actorPrincipalId,
      input.authorityDecisionId,
      why,
      input.now,
    ),
  ]);
}
