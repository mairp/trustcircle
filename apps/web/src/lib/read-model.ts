export const READ_QUALITIES = [
  'current',
  'stale',
  'partial',
  'degraded',
  'unavailable',
  'unknown',
] as const;

export type ReadQuality = (typeof READ_QUALITIES)[number];

export interface GovernedReadEnvelope<T> {
  readonly apiVersion: 1;
  readonly contractVersion: '1.0';
  readonly tenantId: string;
  readonly domain: string;
  readonly data: T;
  readonly source: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly freshnessObjectiveMs: number;
  readonly quality: ReadQuality;
  readonly partialFailures: readonly string[];
  readonly correlationId?: string;
  readonly safeNextAction?: string;
}

export interface EnvelopeValidation<T> {
  readonly ok: boolean;
  readonly envelope?: GovernedReadEnvelope<T>;
  readonly quality: ReadQuality;
  readonly diagnostic?: string;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEnvelope<T>(
  value: unknown,
  expected: { readonly tenantId: string; readonly domain: string; readonly nowMs?: number },
): EnvelopeValidation<T> {
  if (!isObject(value)) return { ok: false, quality: 'unknown', diagnostic: 'malformed_response' };
  if (value['apiVersion'] !== 1 || value['contractVersion'] !== '1.0') {
    return { ok: false, quality: 'unknown', diagnostic: 'incompatible_version' };
  }
  if (value['tenantId'] !== expected.tenantId || value['domain'] !== expected.domain) {
    return { ok: false, quality: 'unknown', diagnostic: 'scope_mismatch' };
  }
  if (typeof value['observedAt'] !== 'string' || !ISO_INSTANT.test(value['observedAt'])) {
    return { ok: false, quality: 'unknown', diagnostic: 'missing_observation_metadata' };
  }
  if (typeof value['source'] !== 'string' || value['source'].length === 0) {
    return { ok: false, quality: 'unknown', diagnostic: 'missing_provenance' };
  }
  if (
    typeof value['freshnessObjectiveMs'] !== 'number' ||
    !Number.isFinite(value['freshnessObjectiveMs']) ||
    value['freshnessObjectiveMs'] < 0
  ) {
    return { ok: false, quality: 'unknown', diagnostic: 'invalid_freshness_objective' };
  }
  if (!READ_QUALITIES.includes(value['quality'] as ReadQuality)) {
    return { ok: false, quality: 'unknown', diagnostic: 'invalid_quality' };
  }
  const partialFailures = value['partialFailures'];
  if (!Array.isArray(partialFailures) || partialFailures.some((item) => typeof item !== 'string')) {
    return { ok: false, quality: 'unknown', diagnostic: 'invalid_partial_metadata' };
  }
  const now = expected.nowMs ?? Date.now();
  const age = Math.max(0, now - Date.parse(value['observedAt']));
  const declared = value['quality'] as ReadQuality;
  const quality: ReadQuality =
    declared === 'current' && age > value['freshnessObjectiveMs'] ? 'stale' : declared;
  const envelope = {
    ...value,
    quality,
    partialFailures,
  } as unknown as GovernedReadEnvelope<T>;
  return { ok: true, envelope, quality };
}

export function isVerifiedEmpty<T>(envelope: GovernedReadEnvelope<T>): boolean {
  if (envelope.quality !== 'current' || envelope.partialFailures.length > 0) return false;
  if (Array.isArray(envelope.data)) return envelope.data.length === 0;
  if (!isObject(envelope.data)) return false;
  const data = envelope.data;
  const candidates = ['items', 'records', 'results', 'data'];
  const collection = candidates.map((key) => data[key]).find(Array.isArray);
  return Array.isArray(collection) && collection.length === 0;
}

export function safeDiagnostic(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const code = value['error'];
  const correlation = value['correlationId'] ?? value['correlation_id'];
  const safeCode = typeof code === 'string' && /^[A-Z0-9_-]{2,64}$/i.test(code) ? code : undefined;
  const safeCorrelation =
    typeof correlation === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(correlation)
      ? correlation
      : undefined;
  return [safeCode, safeCorrelation].filter(Boolean).join(' · ') || undefined;
}
