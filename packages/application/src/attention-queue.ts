import { createHash } from 'node:crypto';

import {
  rankAttentionCandidates,
  type AttentionCandidate,
  type AttentionCoverage,
  type AttentionDomain,
  type AttentionFreshness,
  type AttentionItem,
  type AttentionOwnerPosture,
  type AttentionReadQuality,
  type AttentionSeverity,
  type AttentionTimePosture,
} from '@trustcircle/domain';

import { operationsAuthorityPlan, type OperationsRole } from './operations-authority.ts';

export interface AttentionSourceRead {
  readonly candidates: readonly AttentionCandidate[];
  readonly coverage: AttentionCoverage;
}

export interface AttentionSourceAdapter {
  readonly domain: AttentionDomain;
  read(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly evaluatedAt: number;
  }): AttentionSourceRead | Promise<AttentionSourceRead>;
}

export interface AttentionFilters {
  readonly domain?: AttentionDomain;
  readonly severity?: AttentionSeverity;
  readonly ownership?: AttentionOwnerPosture;
  readonly timePosture?: AttentionTimePosture;
  readonly freshness?: AttentionFreshness;
  readonly assignment?: 'mine' | 'any';
}

export interface AttentionSummary {
  readonly total: number;
  readonly critical: number;
  readonly overdue: number;
  readonly unowned: number;
  readonly stale: number;
  readonly assignedToMe: number;
}

export interface AttentionPage {
  readonly items: readonly AttentionItem[];
  readonly coverage: readonly AttentionCoverage[];
  readonly summary: AttentionSummary;
  readonly quality: AttentionReadQuality;
  readonly snapshotCursor: string;
  readonly nextCursor: string | null;
  readonly rankingVersion: 'attention-ranking/v1';
  readonly filters: AttentionFilters;
  readonly safeNextAction?: string;
}

interface DecodedCursor {
  readonly snapshot: string;
  readonly offset: number;
  readonly evaluatedAt: number;
}

const qualityRank: Readonly<Record<AttentionReadQuality, number>> = {
  current: 0,
  verified_empty: 0,
  stale: 1,
  partial: 2,
  degraded: 3,
  unknown: 4,
  unavailable: 5,
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): DecodedCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AttentionCursorError('invalid_cursor');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    typeof (decoded as Record<string, unknown>)['snapshot'] !== 'string' ||
    !Number.isInteger((decoded as Record<string, unknown>)['offset']) ||
    typeof (decoded as Record<string, unknown>)['evaluatedAt'] !== 'number'
  ) {
    throw new AttentionCursorError('invalid_cursor');
  }
  const record = decoded as { snapshot: string; offset: number; evaluatedAt: number };
  if (record.offset < 0 || record.evaluatedAt < 0) throw new AttentionCursorError('invalid_cursor');
  return record;
}

function summarize(items: readonly AttentionItem[]): AttentionSummary {
  return {
    total: items.length,
    critical: items.filter((item) => item.severity === 'critical').length,
    overdue: items.filter((item) => item.timePosture === 'breached').length,
    unowned: items.filter((item) => item.ownerPosture === 'unowned').length,
    stale: items.filter((item) => item.freshness !== 'current').length,
    assignedToMe: items.filter((item) => item.ownerPosture === 'assigned_to_me').length,
  };
}

function applyFilters(
  items: readonly AttentionItem[],
  filters: AttentionFilters,
): readonly AttentionItem[] {
  return items.filter((item) => {
    if (filters.domain !== undefined && item.domain !== filters.domain) return false;
    if (filters.severity !== undefined && item.severity !== filters.severity) return false;
    if (filters.ownership !== undefined && item.ownerPosture !== filters.ownership) return false;
    if (filters.timePosture !== undefined && item.timePosture !== filters.timePosture) return false;
    if (filters.freshness !== undefined && item.freshness !== filters.freshness) return false;
    if (filters.assignment === 'mine' && item.ownerPosture !== 'assigned_to_me') return false;
    return true;
  });
}

function aggregateQuality(coverage: readonly AttentionCoverage[]): AttentionReadQuality {
  if (coverage.length === 0) return 'unknown';
  return coverage.reduce<AttentionReadQuality>(
    (worst, item) => (qualityRank[item.quality] > qualityRank[worst] ? item.quality : worst),
    'current',
  );
}

function failedCoverage(domain: AttentionDomain): AttentionCoverage {
  return {
    domain,
    quality: 'unavailable',
    failureCode: 'source_read_failed',
    safeNextAction: `Restore the ${domain} source and restart this queue traversal; do not infer that no urgent work exists.`,
  };
}

export class AttentionCursorError extends Error {
  readonly code: 'invalid_cursor' | 'snapshot_changed';
  constructor(code: 'invalid_cursor' | 'snapshot_changed') {
    super(code);
    this.name = 'AttentionCursorError';
    this.code = code;
  }
}

export class AttentionQueueService {
  readonly #adapters: ReadonlyMap<AttentionDomain, AttentionSourceAdapter>;

  constructor(adapters: readonly AttentionSourceAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.domain, adapter]));
  }

  async page(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly roles: readonly OperationsRole[];
    readonly evaluatedAt: number;
    readonly limit?: number;
    readonly cursor?: string;
    readonly filters?: AttentionFilters;
  }): Promise<AttentionPage> {
    const plan = operationsAuthorityPlan(input.roles);
    if (plan.domains.length === 0) throw new OperationsReadForbiddenError();
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError('limit must be in [1, 500]');
    const decoded = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const evaluatedAt = decoded?.evaluatedAt ?? input.evaluatedAt;
    const reads = await Promise.all(
      plan.domains.map(async (domain): Promise<AttentionSourceRead> => {
        const adapter = this.#adapters.get(domain);
        if (!adapter) return { candidates: [], coverage: failedCoverage(domain) };
        try {
          const read = await adapter.read({
            tenantId: input.tenantId,
            principalId: input.principalId,
            evaluatedAt,
          });
          if (read.coverage.domain !== domain)
            return { candidates: [], coverage: failedCoverage(domain) };
          if (read.candidates.some((candidate) => candidate.tenantId !== input.tenantId)) {
            return { candidates: [], coverage: failedCoverage(domain) };
          }
          return read;
        } catch {
          return { candidates: [], coverage: failedCoverage(domain) };
        }
      }),
    );
    const coverage = reads.map((read) => read.coverage);
    const ranked = rankAttentionCandidates(
      reads.flatMap((read) => read.candidates),
      evaluatedAt,
    );
    const snapshot = digest({
      tenantId: input.tenantId,
      roles: [...input.roles].sort(),
      domains: plan.domains,
      evaluatedAt,
      coverage,
      ids: ranked.map((item) => [item.id, item.ranking.vector]),
      rankingVersion: 'attention-ranking/v1',
    });
    if (decoded !== undefined && decoded.snapshot !== snapshot)
      throw new AttentionCursorError('snapshot_changed');
    const filters = input.filters ?? {};
    const filtered = applyFilters(ranked, filters);
    const offset = decoded?.offset ?? 0;
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const nextCursor =
      nextOffset < filtered.length
        ? encodeCursor({ snapshot, offset: nextOffset, evaluatedAt })
        : null;
    const quality = aggregateQuality(coverage);
    const base = {
      items,
      coverage,
      summary: summarize(ranked),
      quality,
      snapshotCursor: encodeCursor({ snapshot, offset: 0, evaluatedAt }),
      nextCursor,
      rankingVersion: 'attention-ranking/v1' as const,
      filters,
    };
    return quality === 'current' || quality === 'verified_empty'
      ? base
      : {
          ...base,
          safeNextAction:
            'Treat this queue as incomplete, inspect per-domain coverage, and restore or refresh affected sources before relying on absence or ordering.',
        };
  }
}

export class OperationsReadForbiddenError extends Error {
  constructor() {
    super('no operations domains are permitted for this verified role set');
    this.name = 'OperationsReadForbiddenError';
  }
}
