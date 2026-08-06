import { assertGovernedTenant, canonicalGovernedJson, governedDigest } from '@trustcircle/domain';

export const GOVERNED_VIEW_FIELDS = [
  'id',
  'kind',
  'title',
  'description',
  'status',
  'ownerPrincipalId',
  'expiresAt',
  'reviewAt',
  'version',
  'updatedAt',
] as const;
export type GovernedViewField = (typeof GOVERNED_VIEW_FIELDS)[number];

export type GovernedViewFilter =
  | {
      readonly op: 'eq';
      readonly field: GovernedViewField;
      readonly value: string | number | boolean | null;
    }
  | {
      readonly op: 'in';
      readonly field: GovernedViewField;
      readonly values: readonly (string | number | boolean | null)[];
    }
  | { readonly op: 'and' | 'or'; readonly clauses: readonly GovernedViewFilter[] };

export interface GovernedView {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly name: string;
  readonly resourceKind: 'register_record';
  readonly filter: GovernedViewFilter;
  readonly fields: readonly GovernedViewField[];
  readonly sharedWithPrincipalIds: readonly string[];
  readonly queryDigest: string;
  readonly version: number;
  readonly createdAt: number;
}

export interface CreateGovernedViewInput {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly name: string;
  readonly resourceKind: 'register_record';
  readonly filter: GovernedViewFilter;
  readonly fields: readonly GovernedViewField[];
  readonly sharedWithPrincipalIds: readonly string[];
  readonly now: number;
}

export type GovernedDeliveryChannel = 'in_app' | 'email' | 'chat' | 'webhook';

export interface GovernedSubscription {
  readonly id: string;
  readonly tenantId: string;
  readonly viewId: string;
  readonly viewDigest: string;
  readonly recipientPrincipalId: string;
  readonly channels: readonly GovernedDeliveryChannel[];
  readonly cadenceMinutes: number;
  readonly quietPeriod?: {
    readonly startMinuteUtc: number;
    readonly endMinuteUtc: number;
  };
  readonly escalationAfterMinutes: number;
  readonly createdAt: number;
  readonly lastDeliveredAt?: number;
}

export interface CreateGovernedSubscriptionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly view: GovernedView;
  readonly recipientPrincipalId: string;
  readonly channels: readonly GovernedDeliveryChannel[];
  readonly cadenceMinutes: number;
  readonly quietPeriod?: {
    readonly startMinuteUtc: number;
    readonly endMinuteUtc: number;
  };
  readonly escalationAfterMinutes: number;
  readonly createdAt: number;
  readonly lastDeliveredAt?: number;
}

const FIELD_SET = new Set<string>(GOVERNED_VIEW_FIELDS);
const CHANNELS = new Set<GovernedDeliveryChannel>(['in_app', 'email', 'chat', 'webhook']);

function required(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(field + ' is required.');
  }
  return value.trim();
}

function epoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(field + ' must be a non-negative epoch integer.');
  }
  return value;
}

function validateFilter(filter: GovernedViewFilter, depth = 0): void {
  if (depth > 8 || filter === null || typeof filter !== 'object') {
    throw new TypeError('View filter exceeds the governed AST boundary.');
  }
  if (filter.op === 'and' || filter.op === 'or') {
    if (!Array.isArray(filter.clauses) || filter.clauses.length < 1 || filter.clauses.length > 20) {
      throw new TypeError('A logical view filter requires 1 to 20 clauses.');
    }
    for (const clause of filter.clauses) validateFilter(clause, depth + 1);
    return;
  }
  if ((filter.op !== 'eq' && filter.op !== 'in') || !FIELD_SET.has(filter.field)) {
    throw new TypeError('The view filter field/operator is outside the allowlist.');
  }
  if (filter.op === 'in' && (!Array.isArray(filter.values) || filter.values.length > 50)) {
    throw new TypeError('The view IN filter must contain at most 50 values.');
  }
}

function evaluate(filter: GovernedViewFilter, record: Readonly<Record<string, unknown>>): boolean {
  if (filter.op === 'and') return filter.clauses.every((clause) => evaluate(clause, record));
  if (filter.op === 'or') return filter.clauses.some((clause) => evaluate(clause, record));
  if (filter.op === 'eq') return record[filter.field] === filter.value;
  if (filter.op === 'in') {
    return filter.values.some((value) => record[filter.field] === value);
  }
  return false;
}

export function createGovernedView(input: CreateGovernedViewInput): GovernedView {
  required(input.id, 'id');
  required(input.tenantId, 'tenantId');
  required(input.ownerPrincipalId, 'ownerPrincipalId');
  const name = required(input.name, 'name');
  if (input.resourceKind !== 'register_record') {
    throw new TypeError('resourceKind is outside the governed view allowlist.');
  }
  validateFilter(input.filter);
  if (
    !Array.isArray(input.fields) ||
    input.fields.length === 0 ||
    input.fields.some((field) => !FIELD_SET.has(field))
  ) {
    throw new TypeError('Every selected view field must be allowlisted.');
  }
  const fields = Object.freeze([...new Set(input.fields)]);
  const shared = Object.freeze(
    [...new Set(input.sharedWithPrincipalIds)].filter(
      (principalId) => principalId !== input.ownerPrincipalId,
    ),
  );
  const createdAt = epoch(input.now, 'now');
  const canonical = {
    tenantId: input.tenantId,
    resourceKind: input.resourceKind,
    filter: input.filter,
    fields,
  };
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    ownerPrincipalId: input.ownerPrincipalId,
    name,
    resourceKind: input.resourceKind,
    filter: JSON.parse(canonicalGovernedJson(input.filter)) as GovernedViewFilter,
    fields,
    sharedWithPrincipalIds: shared,
    queryDigest: governedDigest(canonical),
    version: 1,
    createdAt,
  });
}

export interface ExecuteGovernedViewInput {
  readonly view: GovernedView;
  readonly tenantId: string;
  readonly principalId: string;
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly authorizeField: (
    principalId: string,
    record: Readonly<Record<string, unknown>>,
    field: GovernedViewField,
  ) => boolean;
}

export function executeGovernedView(
  input: ExecuteGovernedViewInput,
): readonly Readonly<Record<string, unknown>>[] {
  assertGovernedTenant(input.view.tenantId, input.tenantId);
  if (
    input.principalId !== input.view.ownerPrincipalId &&
    !input.view.sharedWithPrincipalIds.includes(input.principalId)
  ) {
    throw new TypeError('The recipient is no longer authorized for this shared view.');
  }
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const record of input.records) {
    if (record['tenantId'] !== input.tenantId || !evaluate(input.view.filter, record)) continue;
    const visible: Record<string, unknown> = {};
    for (const field of input.view.fields) {
      if (field in record && input.authorizeField(input.principalId, record, field)) {
        visible[field] = record[field];
      }
    }
    if (Object.keys(visible).length > 0) rows.push(Object.freeze(visible));
  }
  return Object.freeze(rows);
}

export function createGovernedSubscription(
  input: CreateGovernedSubscriptionInput,
): GovernedSubscription {
  required(input.id, 'id');
  required(input.tenantId, 'tenantId');
  required(input.recipientPrincipalId, 'recipientPrincipalId');
  if (!Number.isSafeInteger(input.cadenceMinutes) || input.cadenceMinutes < 1) {
    throw new RangeError('cadenceMinutes must be a positive integer.');
  }
  if (
    !Number.isSafeInteger(input.escalationAfterMinutes) ||
    input.escalationAfterMinutes < input.cadenceMinutes
  ) {
    throw new RangeError('escalationAfterMinutes must be at least the cadence.');
  }
  if (input.view === undefined) throw new TypeError('A governed view is required.');
  assertGovernedTenant(input.view.tenantId, input.tenantId);
  if (
    input.recipientPrincipalId !== input.view.ownerPrincipalId &&
    !input.view.sharedWithPrincipalIds.includes(input.recipientPrincipalId)
  ) {
    throw new TypeError('The recipient is not authorized for the governed view.');
  }
  if (input.channels.length === 0 || input.channels.some((channel) => !CHANNELS.has(channel))) {
    throw new TypeError('At least one allowlisted delivery channel is required.');
  }
  const createdAt = epoch(input.createdAt, 'createdAt');
  let quietPeriod: GovernedSubscription['quietPeriod'];
  if (input.quietPeriod !== undefined) {
    const { startMinuteUtc, endMinuteUtc } = input.quietPeriod;
    if (
      !Number.isSafeInteger(startMinuteUtc) ||
      !Number.isSafeInteger(endMinuteUtc) ||
      startMinuteUtc < 0 ||
      startMinuteUtc > 1439 ||
      endMinuteUtc < 0 ||
      endMinuteUtc > 1439
    ) {
      throw new RangeError('Quiet-period minutes must be within the UTC day.');
    }
    quietPeriod = Object.freeze({ startMinuteUtc, endMinuteUtc });
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    viewId: input.view.id,
    viewDigest: input.view.queryDigest,
    recipientPrincipalId: input.recipientPrincipalId,
    channels: Object.freeze([...new Set(input.channels)]),
    cadenceMinutes: input.cadenceMinutes,
    ...(quietPeriod === undefined ? {} : { quietPeriod }),
    escalationAfterMinutes: input.escalationAfterMinutes,
    createdAt,
    ...(input.lastDeliveredAt === undefined
      ? {}
      : { lastDeliveredAt: epoch(input.lastDeliveredAt, 'lastDeliveredAt') }),
  });
}

export function isGovernedSubscriptionDue(
  subscription: GovernedSubscription,
  nowInput: number,
): boolean {
  const now = epoch(nowInput, 'now');
  const baseline = subscription.lastDeliveredAt ?? subscription.createdAt;
  return now >= baseline + subscription.cadenceMinutes * 60_000;
}

export function isGovernedSubscriptionQuiet(
  subscription: GovernedSubscription,
  nowInput: number,
): boolean {
  const now = epoch(nowInput, 'now');
  if (subscription.quietPeriod === undefined) return false;
  const minute = Math.floor((now % 86_400_000) / 60_000);
  const { startMinuteUtc, endMinuteUtc } = subscription.quietPeriod;
  return startMinuteUtc <= endMinuteUtc
    ? minute >= startMinuteUtc && minute < endMinuteUtc
    : minute >= startMinuteUtc || minute < endMinuteUtc;
}
