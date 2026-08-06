import { operationalCaseEtag } from '@trustcircle/contracts';

import { apiRead } from './api-client.ts';
import type { OperationsWorkspaceCapabilities } from './permissions.ts';
import type { OperatorSessionContext } from './session-context.ts';

export interface OperationsSourceView {
  readonly domain: string;
  readonly recordType: string;
  readonly recordId: string;
  readonly recordVersion?: string;
  readonly href: string;
  readonly observedAt: string;
  readonly sourceOwnerId?: string;
  readonly resolved: boolean | 'unknown';
  readonly wire: Readonly<Record<string, unknown>>;
}

export interface OperationsAttentionItemView {
  readonly id: string;
  readonly title: string;
  readonly domain: string;
  readonly severity: string;
  readonly impact: string;
  readonly timePosture: string;
  readonly ownerPosture: string;
  readonly freshness: string;
  readonly observedAt: string;
  readonly dueAt?: string;
  readonly safeNextAction: { readonly label: string; readonly href?: string };
  readonly sources: readonly OperationsSourceView[];
  readonly rankingFactors: readonly { readonly label: string; readonly value: string }[];
}

export interface OperationsCoverageView {
  readonly domain: string;
  readonly quality: string;
  readonly candidateCount?: number;
  readonly failureCode?: string;
  readonly safeNextAction?: string;
}

export interface OperationsAttentionState {
  readonly available: boolean;
  readonly quality: string;
  readonly observedAt?: string;
  readonly summary: {
    readonly total: number;
    readonly critical: number;
    readonly overdue: number;
    readonly unowned: number;
    readonly stale: number;
    readonly assignedToMe: number;
  };
  readonly items: readonly OperationsAttentionItemView[];
  readonly coverage: readonly OperationsCoverageView[];
  readonly safeNextAction?: string;
  readonly diagnostic?: string;
}

export interface OperationalCaseView {
  readonly id: string;
  readonly title: string;
  readonly priority: string;
  readonly status: string;
  readonly ownerId?: string;
  readonly creatorId: string;
  readonly version: number;
  readonly etag: string;
  readonly acknowledgementTargetAt: string;
  readonly resolutionTargetAt: string;
  readonly verificationTargetAt?: string;
  readonly escalationLevel: number;
  readonly breachTypes: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly sources: readonly OperationsSourceView[];
  readonly updatedAt: string;
}

export interface OperationsCasesState {
  readonly available: boolean;
  readonly observedAt?: string;
  readonly items: readonly OperationalCaseView[];
  readonly safeNextAction?: string;
  readonly diagnostic?: string;
}

export interface OperationsWorkspaceState {
  readonly attention: OperationsAttentionState;
  readonly cases: OperationsCasesState;
}

export const OPERATIONS_FILTER_OPTIONS = {
  domain: [
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
  ],
  severity: ['critical', 'high', 'medium', 'low', 'unknown'],
  ownership: ['assigned_to_me', 'assigned', 'unowned', 'unknown'],
  timePosture: ['breached', 'imminent', 'due', 'none', 'unknown'],
  freshness: ['current', 'stale', 'degraded', 'unknown'],
  assignment: ['mine', 'any'],
} as const;

export interface OperationsWorkspaceFilters {
  readonly domain?: (typeof OPERATIONS_FILTER_OPTIONS.domain)[number];
  readonly severity?: (typeof OPERATIONS_FILTER_OPTIONS.severity)[number];
  readonly ownership?: (typeof OPERATIONS_FILTER_OPTIONS.ownership)[number];
  readonly timePosture?: (typeof OPERATIONS_FILTER_OPTIONS.timePosture)[number];
  readonly freshness?: (typeof OPERATIONS_FILTER_OPTIONS.freshness)[number];
  readonly assignment?: (typeof OPERATIONS_FILTER_OPTIONS.assignment)[number];
}

type SearchValues = Readonly<Record<string, string | readonly string[] | undefined>>;

function allowed<T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === 'string' && values.includes(scalar) ? (scalar as T[number]) : undefined;
}

export function parseOperationsWorkspaceFilters(input: SearchValues): OperationsWorkspaceFilters {
  const domain = allowed(input['domain'], OPERATIONS_FILTER_OPTIONS.domain);
  const severity = allowed(input['severity'], OPERATIONS_FILTER_OPTIONS.severity);
  const ownership = allowed(input['ownership'], OPERATIONS_FILTER_OPTIONS.ownership);
  const timePosture = allowed(input['time_posture'], OPERATIONS_FILTER_OPTIONS.timePosture);
  const freshness = allowed(input['freshness'], OPERATIONS_FILTER_OPTIONS.freshness);
  const assignment = allowed(input['assignment'], OPERATIONS_FILTER_OPTIONS.assignment);
  return {
    ...(domain ? { domain } : {}),
    ...(severity ? { severity } : {}),
    ...(ownership ? { ownership } : {}),
    ...(timePosture ? { timePosture } : {}),
    ...(freshness ? { freshness } : {}),
    ...(assignment ? { assignment } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sourceView(value: unknown): OperationsSourceView | undefined {
  const row = object(value);
  if (!row) return undefined;
  const domain = string(row['domain']);
  const recordType = string(row['record_type']);
  const recordId = string(row['record_id']);
  const href = string(row['href']);
  const observedAt = string(row['observed_at']);
  const resolved = row['resolved'];
  if (!domain || !recordType || !recordId || !href || !href.startsWith('/v1/') || !observedAt)
    return undefined;
  if (!(resolved === true || resolved === false || resolved === 'unknown')) return undefined;
  return {
    domain,
    recordType,
    recordId,
    ...(string(row['record_version'])
      ? { recordVersion: string(row['record_version']) as string }
      : {}),
    href,
    observedAt,
    ...(string(row['source_owner_id'])
      ? { sourceOwnerId: string(row['source_owner_id']) as string }
      : {}),
    resolved,
    wire: row,
  };
}

function unavailableAttention(
  safeNextAction?: string,
  diagnostic?: string,
): OperationsAttentionState {
  return {
    available: false,
    quality: 'unavailable',
    summary: { total: 0, critical: 0, overdue: 0, unowned: 0, stale: 0, assignedToMe: 0 },
    items: [],
    coverage: [],
    ...(safeNextAction ? { safeNextAction } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function unavailableCases(safeNextAction?: string, diagnostic?: string): OperationsCasesState {
  return {
    available: false,
    items: [],
    ...(safeNextAction ? { safeNextAction } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function parseAttention(body: unknown, tenantId: string): OperationsAttentionState | undefined {
  const value = object(body);
  if (
    !value ||
    value['tenant_id'] !== tenantId ||
    !Array.isArray(value['items']) ||
    !Array.isArray(value['coverage'])
  )
    return undefined;
  const summary = object(value['summary']);
  if (!summary) return undefined;
  const items = value['items'].flatMap((entry): OperationsAttentionItemView[] => {
    const row = object(entry);
    if (!row || !Array.isArray(row['sources'])) return [];
    const sources = row['sources']
      .map(sourceView)
      .filter((item): item is OperationsSourceView => item !== undefined);
    const action = object(row['safe_next_action']);
    const ranking = object(row['ranking']);
    const factors = Array.isArray(ranking?.['factors'])
      ? ranking['factors'].flatMap((factor): { label: string; value: string }[] => {
          const parsed = object(factor);
          const label = string(parsed?.['label']);
          const factorValue = parsed?.['value'];
          return label &&
            (typeof factorValue === 'string' ||
              typeof factorValue === 'number' ||
              typeof factorValue === 'boolean')
            ? [{ label, value: String(factorValue) }]
            : [];
        })
      : [];
    const required = {
      id: string(row['id']),
      title: string(row['title']),
      domain: string(row['domain']),
      severity: string(row['severity']),
      impact: string(row['impact']),
      timePosture: string(row['time_posture']),
      ownerPosture: string(row['owner_posture']),
      freshness: string(row['freshness']),
      observedAt: string(row['observed_at']),
      actionLabel: string(action?.['label']),
    };
    if (Object.values(required).some((field) => !field) || sources.length === 0) return [];
    return [
      {
        id: required.id as string,
        title: required.title as string,
        domain: required.domain as string,
        severity: required.severity as string,
        impact: required.impact as string,
        timePosture: required.timePosture as string,
        ownerPosture: required.ownerPosture as string,
        freshness: required.freshness as string,
        observedAt: required.observedAt as string,
        ...(string(row['due_at']) ? { dueAt: string(row['due_at']) as string } : {}),
        safeNextAction: {
          label: required.actionLabel as string,
          ...(string(action?.['href']) ? { href: string(action?.['href']) as string } : {}),
        },
        sources,
        rankingFactors: factors,
      },
    ];
  });
  const coverage = value['coverage'].flatMap((entry): OperationsCoverageView[] => {
    const row = object(entry);
    const domain = string(row?.['domain']);
    const quality = string(row?.['quality']);
    if (!domain || !quality) return [];
    return [
      {
        domain,
        quality,
        ...(typeof row?.['candidate_count'] === 'number'
          ? { candidateCount: row['candidate_count'] }
          : {}),
        ...(string(row?.['failure_code'])
          ? { failureCode: string(row?.['failure_code']) as string }
          : {}),
        ...(string(row?.['safe_next_action'])
          ? { safeNextAction: string(row?.['safe_next_action']) as string }
          : {}),
      },
    ];
  });
  return {
    available: true,
    quality: string(value['quality']) ?? 'unknown',
    ...(string(value['evaluated_at'])
      ? { observedAt: string(value['evaluated_at']) as string }
      : {}),
    summary: {
      total: number(summary['total']),
      critical: number(summary['critical']),
      overdue: number(summary['overdue']),
      unowned: number(summary['unowned']),
      stale: number(summary['stale']),
      assignedToMe: number(summary['assigned_to_me']),
    },
    items,
    coverage,
    ...(string(value['safe_next_action'])
      ? { safeNextAction: string(value['safe_next_action']) as string }
      : {}),
  };
}

function parseCases(body: unknown, tenantId: string): OperationsCasesState | undefined {
  const value = object(body);
  if (!value || value['tenant_id'] !== tenantId || !Array.isArray(value['items'])) return undefined;
  const items = value['items'].flatMap((entry): OperationalCaseView[] => {
    const row = object(entry);
    if (!row || row['tenant_id'] !== tenantId || !Array.isArray(row['source_references']))
      return [];
    const version = number(row['version']);
    const sources = row['source_references']
      .map(sourceView)
      .filter((item): item is OperationsSourceView => item !== undefined);
    const required = [
      string(row['id']),
      string(row['title']),
      string(row['priority']),
      string(row['status']),
      string(row['creator_id']),
      string(row['acknowledgement_target_at']),
      string(row['resolution_target_at']),
      string(row['updated_at']),
    ];
    if (required.some((field) => !field) || version < 1 || sources.length === 0) return [];
    return [
      {
        id: required[0] as string,
        title: required[1] as string,
        priority: required[2] as string,
        status: required[3] as string,
        creatorId: required[4] as string,
        version,
        etag: operationalCaseEtag({ version }),
        ...(string(row['owner_id']) ? { ownerId: string(row['owner_id']) as string } : {}),
        acknowledgementTargetAt: required[5] as string,
        resolutionTargetAt: required[6] as string,
        ...(string(row['verification_target_at'])
          ? { verificationTargetAt: string(row['verification_target_at']) as string }
          : {}),
        escalationLevel: number(row['escalation_level']),
        breachTypes: Array.isArray(row['breach_types'])
          ? row['breach_types'].filter((item): item is string => typeof item === 'string')
          : [],
        evidenceReferences: Array.isArray(row['evidence_references'])
          ? row['evidence_references'].filter((item): item is string => typeof item === 'string')
          : [],
        sources,
        updatedAt: required[7] as string,
      },
    ];
  });
  return {
    available: true,
    ...(string(value['observed_at']) ? { observedAt: string(value['observed_at']) as string } : {}),
    items,
  };
}

export async function loadOperationsWorkspace(
  session: OperatorSessionContext,
  capabilities: OperationsWorkspaceCapabilities,
  filters: OperationsWorkspaceFilters = {},
): Promise<OperationsWorkspaceState> {
  if (!capabilities.canRead || !session.tenantId) {
    return { attention: unavailableAttention(), cases: unavailableCases() };
  }
  const attentionQuery = new URLSearchParams({ limit: '100' });
  if (filters.domain) attentionQuery.set('domain', filters.domain);
  if (filters.severity) attentionQuery.set('severity', filters.severity);
  if (filters.ownership) attentionQuery.set('ownership', filters.ownership);
  if (filters.timePosture) attentionQuery.set('time_posture', filters.timePosture);
  if (filters.freshness) attentionQuery.set('freshness', filters.freshness);
  if (filters.assignment) attentionQuery.set('assignment', filters.assignment);
  const [attentionResult, casesResult] = await Promise.all([
    apiRead(`/v1/operations/attention?${attentionQuery.toString()}`, session),
    apiRead('/v1/operations/cases?limit=100', session),
  ]);
  const attention = attentionResult.ok
    ? parseAttention(attentionResult.body, session.tenantId)
    : undefined;
  const cases = casesResult.ok ? parseCases(casesResult.body, session.tenantId) : undefined;
  return {
    attention:
      attention ??
      unavailableAttention(
        attentionResult.safeNextAction,
        attentionResult.diagnostic ?? 'invalid_attention_response',
      ),
    cases:
      cases ??
      unavailableCases(
        casesResult.safeNextAction,
        casesResult.diagnostic ?? 'invalid_case_response',
      ),
  };
}
