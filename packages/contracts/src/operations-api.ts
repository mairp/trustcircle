import { createHash } from 'node:crypto';

export const OPERATIONS_ATTENTION_DOMAINS = [
  'decision',
  'integrity',
  'inventory',
  'source',
  'controller',
  'compliance',
  'evidence',
  'connector',
  'runtime',
  'coverage',
] as const;
export type OperationsAttentionDomain = (typeof OPERATIONS_ATTENTION_DOMAINS)[number];

export const OPERATIONS_CASE_STATUSES = [
  'open',
  'acknowledged',
  'in_progress',
  'awaiting_verification',
  'escalated',
  'resolved',
  'closed',
] as const;
export type OperationsCaseStatus = (typeof OPERATIONS_CASE_STATUSES)[number];
export type OperationsCasePriority = 'critical' | 'high' | 'medium' | 'low';
const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const TRANSITION_COMMANDS = [
  'assign',
  'acknowledge',
  'progress',
  'submit_verification',
  'verify',
  'close',
] as const;

export interface OperationsSourceReferenceWire {
  readonly domain: OperationsAttentionDomain;
  readonly record_type: string;
  readonly record_id: string;
  readonly record_version?: string;
  readonly governed_problem_key?: string;
  readonly href: `/v1/${string}`;
  readonly observed_at: string;
  readonly source_owner_id?: string;
  readonly resolved: boolean | 'unknown';
}

export interface OperationsProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly correlation_id: string;
  readonly retryable: boolean;
  readonly safe_next_actions: readonly string[];
}

export interface CreateOperationalCaseRequest {
  readonly attention_item_id?: string;
  readonly source_references: readonly OperationsSourceReferenceWire[];
  readonly title: string;
  readonly priority: OperationsCasePriority;
  readonly owner_id?: string;
  readonly rationale: string;
  readonly service_level_policy_id: string;
  readonly service_level_policy_version: string;
}

export interface TransitionOperationalCaseRequest {
  readonly command: (typeof TRANSITION_COMMANDS)[number];
  readonly reason: string;
  readonly expected_version: number;
  readonly owner_id?: string;
  readonly evidence_references?: readonly string[];
  readonly source_versions?: readonly OperationsSourceReferenceWire[];
}

export interface SlaEvaluationRequest {
  readonly expected_version: number;
  readonly evaluated_at: string;
  readonly reason: string;
}

export interface OperationsPageCursor {
  readonly snapshot: string;
  readonly offset: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function meaningful(value: unknown, minimum = 1, maximum = 2_000): value is string {
  return typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum;
}

function stringArray(value: unknown, maxItems = 100): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => meaningful(item, 1, 256))
  );
}

function parseSourceReference(value: unknown): OperationsSourceReferenceWire | undefined {
  const record = object(value);
  if (
    !record ||
    !exactKeys(record, [
      'domain',
      'record_type',
      'record_id',
      'record_version',
      'governed_problem_key',
      'href',
      'observed_at',
      'source_owner_id',
      'resolved',
    ])
  )
    return undefined;
  if (
    !OPERATIONS_ATTENTION_DOMAINS.includes(record['domain'] as OperationsAttentionDomain) ||
    !meaningful(record['record_type'], 1, 96) ||
    !meaningful(record['record_id'], 1, 256) ||
    !meaningful(record['href'], 4, 512) ||
    !(record['href'] as string).startsWith('/v1/') ||
    typeof record['observed_at'] !== 'string' ||
    !Number.isFinite(Date.parse(record['observed_at'])) ||
    !(
      record['resolved'] === true ||
      record['resolved'] === false ||
      record['resolved'] === 'unknown'
    ) ||
    (record['record_version'] !== undefined && !meaningful(record['record_version'], 1, 160)) ||
    (record['governed_problem_key'] !== undefined &&
      !meaningful(record['governed_problem_key'], 1, 256)) ||
    (record['source_owner_id'] !== undefined && !meaningful(record['source_owner_id'], 1, 160))
  )
    return undefined;
  return {
    domain: record['domain'] as OperationsAttentionDomain,
    record_type: record['record_type'],
    record_id: record['record_id'],
    ...(record['record_version'] === undefined
      ? {}
      : { record_version: record['record_version'] as string }),
    ...(record['governed_problem_key'] === undefined
      ? {}
      : { governed_problem_key: record['governed_problem_key'] as string }),
    href: record['href'] as `/v1/${string}`,
    observed_at: record['observed_at'],
    ...(record['source_owner_id'] === undefined
      ? {}
      : { source_owner_id: record['source_owner_id'] as string }),
    resolved: record['resolved'] as boolean | 'unknown',
  };
}

function parseSources(
  value: unknown,
  allowEmpty = false,
): readonly OperationsSourceReferenceWire[] | undefined {
  if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && value.length === 0))
    return undefined;
  const parsed = value.map(parseSourceReference);
  return parsed.every((item): item is OperationsSourceReferenceWire => item !== undefined)
    ? parsed
    : undefined;
}

export function parseCreateOperationalCaseRequest(value: unknown): CreateOperationalCaseRequest {
  const record = object(value);
  if (
    !record ||
    !exactKeys(record, [
      'attention_item_id',
      'source_references',
      'title',
      'priority',
      'owner_id',
      'rationale',
      'service_level_policy_id',
      'service_level_policy_version',
    ])
  )
    throw new OperationsContractError('invalid_create_case_request');
  const sources = parseSources(record['source_references']);
  if (!sources) throw new OperationsContractError('invalid_source_references');
  if (!meaningful(record['title'], 1, 320) || !meaningful(record['rationale'], 8, 2_000))
    throw new OperationsContractError('invalid_case_reason');
  if (!PRIORITIES.includes(record['priority'] as OperationsCasePriority))
    throw new OperationsContractError('invalid_case_priority');
  if (
    !meaningful(record['service_level_policy_id'], 1, 120) ||
    !meaningful(record['service_level_policy_version'], 1, 64)
  )
    throw new OperationsContractError('invalid_service_level_policy');
  return {
    ...(record['attention_item_id'] === undefined
      ? {}
      : { attention_item_id: String(record['attention_item_id']) }),
    source_references: sources,
    title: record['title'],
    priority: record['priority'] as OperationsCasePriority,
    ...(record['owner_id'] === undefined ? {} : { owner_id: String(record['owner_id']) }),
    rationale: record['rationale'],
    service_level_policy_id: record['service_level_policy_id'],
    service_level_policy_version: record['service_level_policy_version'],
  };
}

export function parseTransitionOperationalCaseRequest(
  value: unknown,
): TransitionOperationalCaseRequest {
  const record = object(value);
  if (
    !record ||
    !exactKeys(record, [
      'command',
      'reason',
      'expected_version',
      'owner_id',
      'evidence_references',
      'source_versions',
    ])
  )
    throw new OperationsContractError('invalid_transition_request');
  if (!TRANSITION_COMMANDS.includes(record['command'] as (typeof TRANSITION_COMMANDS)[number]))
    throw new OperationsContractError('invalid_transition_command');
  if (
    !meaningful(record['reason'], 8, 2_000) ||
    !Number.isInteger(record['expected_version']) ||
    Number(record['expected_version']) < 1
  )
    throw new OperationsContractError('invalid_transition_reason_or_version');
  const evidence = record['evidence_references'];
  if (evidence !== undefined && !stringArray(evidence))
    throw new OperationsContractError('invalid_evidence_references');
  const sources =
    record['source_versions'] === undefined
      ? undefined
      : parseSources(record['source_versions'], true);
  if (record['source_versions'] !== undefined && !sources)
    throw new OperationsContractError('invalid_source_versions');
  return {
    command: record['command'] as TransitionOperationalCaseRequest['command'],
    reason: record['reason'],
    expected_version: Number(record['expected_version']),
    ...(record['owner_id'] === undefined ? {} : { owner_id: String(record['owner_id']) }),
    ...(evidence === undefined ? {} : { evidence_references: evidence }),
    ...(sources === undefined ? {} : { source_versions: sources }),
  };
}

export function parseSlaEvaluationRequest(value: unknown): SlaEvaluationRequest {
  const record = object(value);
  if (!record || !exactKeys(record, ['expected_version', 'evaluated_at', 'reason']))
    throw new OperationsContractError('invalid_sla_evaluation_request');
  if (!Number.isInteger(record['expected_version']) || Number(record['expected_version']) < 1)
    throw new OperationsContractError('invalid_expected_version');
  if (
    !meaningful(record['reason'], 8, 2_000) ||
    typeof record['evaluated_at'] !== 'string' ||
    !Number.isFinite(Date.parse(record['evaluated_at']))
  )
    throw new OperationsContractError('invalid_sla_evaluation');
  return {
    expected_version: Number(record['expected_version']),
    evaluated_at: record['evaluated_at'],
    reason: record['reason'],
  };
}

export function parseOperationsLimit(value: string | null, fallback = 100): number {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new OperationsContractError('invalid_limit');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)
    throw new OperationsContractError('invalid_limit');
  return parsed;
}

export function encodeOperationsPageCursor(value: OperationsPageCursor): string {
  if (!value.snapshot || !Number.isInteger(value.offset) || value.offset < 0)
    throw new OperationsContractError('invalid_cursor');
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function parseOperationsPageCursor(value: string): OperationsPageCursor {
  if (!value || value.length > 4_096) throw new OperationsContractError('invalid_cursor');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new OperationsContractError('invalid_cursor');
  }
  const record = object(decoded);
  if (
    !record ||
    !exactKeys(record, ['snapshot', 'offset']) ||
    !meaningful(record['snapshot'], 16, 128) ||
    !Number.isInteger(record['offset']) ||
    Number(record['offset']) < 0
  )
    throw new OperationsContractError('invalid_cursor');
  return { snapshot: record['snapshot'], offset: Number(record['offset']) };
}

export function requireOperationsIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._-]{8,128}$/.test(value))
    throw new OperationsContractError('invalid_idempotency_key');
  return value;
}

export function operationalCaseEtag(value: { readonly version: number }): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `"oc-${value.version}-${digest}"`;
}

export function requireOperationalCaseIfMatch(
  value: string | undefined,
  current: { readonly version: number },
): void {
  if (!value || value !== operationalCaseEtag(current))
    throw new OperationsContractError('etag_mismatch');
}

export function isOperationsCaseStatus(value: string | null): value is OperationsCaseStatus {
  return value !== null && OPERATIONS_CASE_STATUSES.includes(value as OperationsCaseStatus);
}

export class OperationsContractError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'OperationsContractError';
    this.code = code;
  }
}
