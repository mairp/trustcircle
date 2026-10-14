import { apiRead } from './api-client.ts';
import { parseDecision, type DecisionView } from './decision-view.ts';
import type { OperatorSessionContext } from './session-context.ts';

export interface DecisionQueueFilters {
  readonly status?: string;
  readonly assignedToMe: boolean;
}

export interface DecisionQueueState {
  readonly available: boolean;
  readonly items: readonly DecisionView[];
  /** Rows the API returned that could not be parsed; shown, never silently dropped. */
  readonly unreadable: number;
  readonly freshness: string;
  readonly partialCoverage: boolean;
  readonly generatedAt?: string;
  readonly hasMore: boolean;
  readonly safeNextAction?: string;
  readonly diagnostic?: string;
}

export interface DecisionDetailState {
  readonly status: 'ok' | 'not_found' | 'unavailable';
  readonly decision?: DecisionView;
  readonly etag?: string;
  readonly safeNextAction?: string;
  readonly diagnostic?: string;
}

const STATUS_RE = /^[a-z_]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDecisionQueueFilters(
  params: Record<string, string | string[] | undefined>,
): DecisionQueueFilters {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const status = first(params['status']);
  return {
    ...(status && STATUS_RE.test(status) ? { status } : {}),
    assignedToMe: first(params['assigned']) === 'me',
  };
}

export async function loadDecisionQueue(
  session: OperatorSessionContext,
  filters: DecisionQueueFilters,
): Promise<DecisionQueueState> {
  const query = new URLSearchParams({ limit: '100' });
  if (filters.status) query.set('status', filters.status);
  if (filters.assignedToMe) query.set('assigned_to_me', 'true');
  const result = await apiRead(`/v1/decisions?${query.toString()}`, session);
  const empty = {
    items: [],
    unreadable: 0,
    freshness: 'unknown',
    partialCoverage: false,
    hasMore: false,
  };
  if (!result.ok) {
    return {
      available: false,
      ...empty,
      ...(result.safeNextAction ? { safeNextAction: result.safeNextAction } : {}),
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    };
  }
  const body = (result.body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body['items']) ? body['items'] : [];
  const items = raw.map(parseDecision).filter((d): d is DecisionView => d !== undefined);
  const metadata = (body['metadata'] ?? {}) as Record<string, unknown>;
  return {
    available: true,
    items,
    unreadable: raw.length - items.length,
    freshness: typeof metadata['freshness'] === 'string' ? metadata['freshness'] : 'unknown',
    partialCoverage: metadata['partial_coverage'] === true,
    ...(typeof metadata['generated_at'] === 'string'
      ? { generatedAt: metadata['generated_at'] }
      : {}),
    hasMore: typeof metadata['next_cursor'] === 'string',
  };
}

export async function loadDecision(
  session: OperatorSessionContext,
  decisionId: string,
): Promise<DecisionDetailState> {
  if (!UUID_RE.test(decisionId)) return { status: 'not_found' };
  const result = await apiRead(`/v1/decisions/${decisionId}`, session);
  if (result.status === 404) return { status: 'not_found' };
  const decision = result.ok ? parseDecision(result.body) : undefined;
  if (!decision || !result.etag) {
    return {
      status: 'unavailable',
      safeNextAction:
        result.safeNextAction ??
        'The decision could not be read with a version to act against. Retry; no action was offered.',
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    };
  }
  return { status: 'ok', decision, etag: result.etag };
}
