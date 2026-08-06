export const PRODUCT_ANALYTICS_EVENTS = [
  'page_view',
  'search_outcome',
  'saved_view_created',
  'workflow_feedback',
  'time_to_find',
  'time_to_acknowledge',
  'time_to_resolve',
  'workflow_abandoned',
  'workspace_adoption',
] as const;

export type ProductAnalyticsEventName = (typeof PRODUCT_ANALYTICS_EVENTS)[number];
export type DurationBucket = 'under-10s' | '10s-60s' | '1m-5m' | 'over-5m';

const ROUTE_FAMILIES = new Set([
  '/',
  '/posture',
  '/operations',
  '/inventory',
  '/assets',
  '/gaps',
  '/decisions',
  '/integrity',
  '/registers',
  '/controllers',
  '/runtime',
  '/integrations',
  '/compliance',
  '/evidence',
  '/trends',
  '/automation',
  '/ai-governance',
  '/copilot',
  '/search',
]);

export interface ProductAnalyticsEvent {
  readonly event: ProductAnalyticsEventName;
  readonly route: string;
  readonly resultCount?: number;
  readonly durationBucket?: DurationBucket;
  readonly feedback?: 'helpful' | 'not_helpful';
}

export type ProductAnalyticsValidation =
  | { readonly ok: true; readonly event: ProductAnalyticsEvent }
  | { readonly ok: false; readonly reason: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function routeFamily(path: string): string {
  return path.startsWith('/assets/') ? '/assets' : path;
}

export function durationBucket(milliseconds: number): DurationBucket {
  if (milliseconds < 10_000) return 'under-10s';
  if (milliseconds < 60_000) return '10s-60s';
  if (milliseconds < 300_000) return '1m-5m';
  return 'over-5m';
}

export function validateProductAnalyticsEvent(value: unknown): ProductAnalyticsValidation {
  const candidate = object(value);
  if (!candidate) return { ok: false, reason: 'invalid_body' };
  const allowedKeys = new Set(['event', 'route', 'resultCount', 'durationBucket', 'feedback']);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return { ok: false, reason: 'unknown_field' };
  }
  if (!PRODUCT_ANALYTICS_EVENTS.includes(candidate['event'] as ProductAnalyticsEventName)) {
    return { ok: false, reason: 'invalid_event' };
  }
  if (typeof candidate['route'] !== 'string' || !ROUTE_FAMILIES.has(candidate['route'])) {
    return { ok: false, reason: 'invalid_route_family' };
  }
  const resultCount = candidate['resultCount'];
  if (
    resultCount !== undefined &&
    (!Number.isInteger(resultCount) ||
      (resultCount as number) < 0 ||
      (resultCount as number) > 1_000_000)
  ) {
    return { ok: false, reason: 'invalid_result_count' };
  }
  const bucket = candidate['durationBucket'];
  if (
    bucket !== undefined &&
    !['under-10s', '10s-60s', '1m-5m', 'over-5m'].includes(bucket as string)
  ) {
    return { ok: false, reason: 'invalid_duration_bucket' };
  }
  const feedback = candidate['feedback'];
  if (feedback !== undefined && feedback !== 'helpful' && feedback !== 'not_helpful') {
    return { ok: false, reason: 'invalid_feedback' };
  }
  const event = candidate['event'] as ProductAnalyticsEventName;
  const timedEvents = new Set<ProductAnalyticsEventName>([
    'time_to_find',
    'time_to_acknowledge',
    'time_to_resolve',
    'workflow_abandoned',
    'workspace_adoption',
  ]);
  if (event === 'search_outcome' && (resultCount === undefined || bucket === undefined)) {
    return { ok: false, reason: 'missing_search_measure' };
  }
  if (timedEvents.has(event) && bucket === undefined) {
    return { ok: false, reason: 'missing_duration_bucket' };
  }
  if (event === 'workflow_feedback' && (feedback === undefined || bucket === undefined)) {
    return { ok: false, reason: 'missing_feedback_measure' };
  }
  if (timedEvents.has(event) && (resultCount !== undefined || feedback !== undefined)) {
    return { ok: false, reason: 'invalid_measure_dimension' };
  }
  if (
    (event === 'page_view' || event === 'saved_view_created') &&
    (resultCount !== undefined || bucket !== undefined || feedback !== undefined)
  ) {
    return { ok: false, reason: 'invalid_measure_dimension' };
  }
  return {
    ok: true,
    event: {
      event,
      route: candidate['route'],
      ...(resultCount !== undefined ? { resultCount: resultCount as number } : {}),
      ...(bucket !== undefined ? { durationBucket: bucket as DurationBucket } : {}),
      ...(feedback !== undefined ? { feedback } : {}),
    },
  };
}
