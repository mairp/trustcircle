import {
  GOVERNED_REGISTER_KINDS,
  assertDistinctGovernedAuthority,
  assertExpectedGovernedVersion,
  assertGovernedRegisterTransition,
  assertGovernedTenant,
  governedDigest,
  type GovernedRegisterKind,
  type GovernedRegisterStatus,
} from '@trustcircle/domain';

export interface GovernedRegisterHistoryEntry {
  readonly sequence: number;
  readonly action: 'created' | 'transitioned' | 'expired';
  readonly fromStatus?: GovernedRegisterStatus;
  readonly toStatus: GovernedRegisterStatus;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId?: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly occurredAt: number;
  readonly recordDigest: string;
}

export interface GovernedRegisterRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: GovernedRegisterKind;
  readonly title: string;
  readonly description: string;
  readonly ownerPrincipalId: string;
  readonly createdByPrincipalId: string;
  readonly status: GovernedRegisterStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly reviewAt?: number;
  readonly compensatingControlRefs: readonly string[];
  readonly history: readonly GovernedRegisterHistoryEntry[];
}

export interface CreateGovernedRegisterRecordInput {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: GovernedRegisterKind;
  readonly title: string;
  readonly description: string;
  readonly ownerPrincipalId: string;
  readonly createdByPrincipalId: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly now: number;
  readonly expiresAt?: number;
  readonly reviewAt?: number;
  readonly compensatingControlRefs?: readonly string[];
}

export interface TransitionGovernedRegisterRecordInput {
  readonly record: GovernedRegisterRecord;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly toStatus: GovernedRegisterStatus;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId?: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly now: number;
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(field + ' is required.');
  }
  return value.trim();
}

function reason(value: { readonly code: string; readonly text: string }): {
  readonly code: string;
  readonly text: string;
} {
  const code = required(value?.code, 'reason.code');
  const text = required(value?.text, 'reason.text');
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(code) || text.length < 3 || text.length > 4000) {
    throw new TypeError('A governed structured reason is required.');
  }
  return Object.freeze({ code, text });
}

function epoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(field + ' must be a non-negative epoch integer.');
  }
  return value;
}

function recordContent(
  record: Omit<GovernedRegisterRecord, 'history'>,
): Readonly<Record<string, unknown>> {
  return {
    id: record.id,
    tenantId: record.tenantId,
    kind: record.kind,
    title: record.title,
    description: record.description,
    ownerPrincipalId: record.ownerPrincipalId,
    createdByPrincipalId: record.createdByPrincipalId,
    status: record.status,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.reviewAt === undefined ? {} : { reviewAt: record.reviewAt }),
    compensatingControlRefs: record.compensatingControlRefs,
  };
}

function freezeRecord(record: GovernedRegisterRecord): GovernedRegisterRecord {
  return Object.freeze({
    ...record,
    compensatingControlRefs: Object.freeze([...record.compensatingControlRefs]),
    history: Object.freeze([...record.history]),
  });
}

export function createGovernedRegisterRecord(
  input: CreateGovernedRegisterRecordInput,
): GovernedRegisterRecord {
  required(input.id, 'id');
  required(input.tenantId, 'tenantId');
  if (!GOVERNED_REGISTER_KINDS.includes(input.kind)) {
    throw new TypeError('kind is outside the governed register allowlist.');
  }
  const title = required(input.title, 'title');
  const description = required(input.description, 'description');
  const ownerPrincipalId = required(input.ownerPrincipalId, 'ownerPrincipalId');
  const createdByPrincipalId = required(input.createdByPrincipalId, 'createdByPrincipalId');
  const governedReason = reason(input.reason);
  const now = epoch(input.now, 'now');
  if (input.kind === 'exception') {
    if (input.expiresAt === undefined || epoch(input.expiresAt, 'expiresAt') <= now) {
      throw new RangeError('An exception expiry must be in the future.');
    }
    if (input.reviewAt === undefined || epoch(input.reviewAt, 'reviewAt') > input.expiresAt) {
      throw new RangeError('An exception review must be no later than expiry.');
    }
  }
  const base = {
    id: input.id,
    tenantId: input.tenantId,
    kind: input.kind,
    title,
    description,
    ownerPrincipalId,
    createdByPrincipalId,
    status: 'draft' as const,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.reviewAt === undefined ? {} : { reviewAt: input.reviewAt }),
    compensatingControlRefs: Object.freeze([...(input.compensatingControlRefs ?? [])]),
  };
  const history: GovernedRegisterHistoryEntry = Object.freeze({
    sequence: 1,
    action: 'created',
    toStatus: 'draft',
    actorPrincipalId: createdByPrincipalId,
    reason: governedReason,
    occurredAt: now,
    recordDigest: governedDigest(base),
  });
  return freezeRecord({ ...base, history: [history] });
}

function authorityRequired(toStatus: GovernedRegisterStatus): boolean {
  return toStatus === 'accepted' || toStatus === 'approved' || toStatus === 'verified';
}

export function transitionGovernedRegisterRecord(
  input: TransitionGovernedRegisterRecordInput,
): GovernedRegisterRecord {
  assertGovernedTenant(input.record.tenantId, input.tenantId);
  assertExpectedGovernedVersion(input.record.version, input.expectedVersion);
  assertGovernedRegisterTransition(input.record.kind, input.record.status, input.toStatus);
  const actor = required(input.actorPrincipalId, 'actorPrincipalId');
  const governedReason = reason(input.reason);
  const now = epoch(input.now, 'now');
  if (now < input.record.updatedAt) throw new RangeError('transition time cannot move backwards.');
  if (authorityRequired(input.toStatus)) {
    required(input.authorityDecisionId ?? '', 'authorityDecisionId');
    const conflictedPrincipal =
      input.toStatus === 'verified'
        ? input.record.ownerPrincipalId
        : input.record.createdByPrincipalId;
    assertDistinctGovernedAuthority(conflictedPrincipal, actor);
  }
  if (
    input.record.kind === 'exception' &&
    input.toStatus === 'approved' &&
    (input.record.expiresAt === undefined || now >= input.record.expiresAt)
  ) {
    throw new RangeError('An expired exception cannot be approved.');
  }
  const nextVersion = input.record.version + 1;
  const nextBase = {
    ...input.record,
    status: input.toStatus,
    version: nextVersion,
    updatedAt: now,
  };
  const history: GovernedRegisterHistoryEntry = Object.freeze({
    sequence: nextVersion,
    action: 'transitioned',
    fromStatus: input.record.status,
    toStatus: input.toStatus,
    actorPrincipalId: actor,
    ...(input.authorityDecisionId === undefined
      ? {}
      : { authorityDecisionId: input.authorityDecisionId }),
    reason: governedReason,
    occurredAt: now,
    recordDigest: governedDigest(recordContent(nextBase)),
  });
  return freezeRecord({ ...nextBase, history: [...input.record.history, history] });
}

export function expireGovernedRegisterRecord(
  record: GovernedRegisterRecord,
  nowInput: number,
): GovernedRegisterRecord {
  const now = epoch(nowInput, 'now');
  if (
    record.kind !== 'exception' ||
    record.status !== 'approved' ||
    record.expiresAt === undefined ||
    now < record.expiresAt
  ) {
    return record;
  }
  const nextBase = {
    ...record,
    status: 'expired' as const,
    version: record.version + 1,
    updatedAt: now,
  };
  const history: GovernedRegisterHistoryEntry = Object.freeze({
    sequence: nextBase.version,
    action: 'expired',
    fromStatus: record.status,
    toStatus: 'expired',
    actorPrincipalId: 'system:expiry',
    reason: Object.freeze({
      code: 'exception.expired',
      text: 'The governed exception reached its declared expiry.',
    }),
    occurredAt: now,
    recordDigest: governedDigest(recordContent(nextBase)),
  });
  return freezeRecord({ ...nextBase, history: [...record.history, history] });
}
