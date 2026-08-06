import { randomUUID } from 'node:crypto';

import {
  AttentionQueueService,
  OperationalCaseService,
  type OperationalCaseRepository,
  type AttentionSourceAdapter,
  type OperationsAuditRecord,
} from '@trustcircle/application';
import type {
  AttentionCandidate,
  AttentionDomain,
  AttentionImpact,
  AttentionSeverity,
  AttentionTimePosture,
  ServiceLevelPolicy,
} from '@trustcircle/domain';
import { InMemoryOperationalCaseRepository } from '@trustcircle/persistence';

import type { OperationsCommandCenterRouteDeps } from './routes/operations-command-center.ts';
import type { RuntimeReadModelSnapshot, RuntimeRow } from './production-runtime.ts';

const FINAL_STATES = new Set([
  'approved',
  'denied',
  'expired',
  'cancelled',
  'closed',
  'resolved',
  'verified',
  'retired',
  'healthy',
  'active',
  'effective',
  'satisfied',
  'confirmed',
  'completed',
]);

function text(row: RuntimeRow, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function number(row: RuntimeRow, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function severity(row: RuntimeRow): AttentionSeverity {
  const value = text(row, 'severity', 'risk_tier', 'business_impact', 'impact')?.toLowerCase();
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low')
    return value;
  return 'unknown';
}

function impact(value: AttentionSeverity): AttentionImpact {
  if (value === 'critical') return 'blocking';
  if (value === 'high') return 'material';
  if (value === 'medium' || value === 'low') return 'limited';
  return 'unknown';
}

function timePosture(
  row: RuntimeRow,
  evaluatedAt: number,
): { posture: AttentionTimePosture; dueAt?: number } {
  const dueAt = number(row, 'expires_at', 'due_at', 'resolution_target_at', 'review_at');
  if (dueAt === undefined) return { posture: 'unknown' };
  if (dueAt < evaluatedAt) return { posture: 'breached', dueAt };
  if (dueAt - evaluatedAt <= 3_600_000) return { posture: 'imminent', dueAt };
  return { posture: 'due', dueAt };
}

function observedAt(row: RuntimeRow, snapshot: RuntimeReadModelSnapshot): number {
  return (
    number(row, 'observed_at', 'last_observed_at', 'last_seen_at', 'updated_at', 'created_at') ??
    snapshot.observedAtMs
  );
}

function rowId(row: RuntimeRow, index: number): string {
  return text(row, 'id', 'evidence_item_id', 'component_key', 'source_ref') ?? `row-${index}`;
}

function owner(row: RuntimeRow): string | undefined {
  return text(
    row,
    'owner_principal_id',
    'owner_id',
    'assignee_principal_id',
    'requester_principal_id',
  );
}

function status(row: RuntimeRow): string {
  return (
    text(row, 'status', 'state', 'lifecycle_state', 'health', 'health_state', 'readiness_state') ??
    'unknown'
  ).toLowerCase();
}

function unresolved(row: RuntimeRow): boolean {
  return !FINAL_STATES.has(status(row));
}

function href(domain: AttentionDomain, id: string): `/v1/${string}` {
  const paths: Readonly<Record<AttentionDomain, string>> = {
    decision: `/v1/decisions/${id}`,
    integrity: `/v1/integrity-cases/${id}`,
    inventory: `/v1/inventory/assets/${id}`,
    source: `/v1/inventory/sources/${id}`,
    controller: `/v1/controllers/${id}`,
    compliance: '/v1/compliance/coverage',
    evidence: '/v1/dashboards/auditor',
    connector: `/v1/connectors/${id}`,
    runtime: '/v1/platform/health',
    coverage: '/v1/inventory/sources',
  };
  return paths[domain] as `/v1/${string}`;
}

function title(domain: AttentionDomain, row: RuntimeRow, id: string): string {
  return (
    text(row, 'title', 'name', 'exact_title', 'problem_class', 'alert_type', 'component_key') ??
    `${domain} ${id} requires attention`
  );
}

function rowsFor(
  domain: AttentionDomain,
  snapshot: RuntimeReadModelSnapshot,
): readonly RuntimeRow[] {
  if (domain === 'decision') return snapshot.decisions;
  if (domain === 'integrity') return snapshot.integrityCases;
  if (domain === 'inventory') return snapshot.assets;
  if (domain === 'source') return snapshot.sources;
  if (domain === 'controller')
    return [...snapshot.controllerDefinitions, ...snapshot.controllerOperations];
  if (domain === 'compliance')
    return [...snapshot.controlMappings, ...snapshot.controlEvaluations, ...snapshot.obligations];
  if (domain === 'evidence') return snapshot.evidence;
  if (domain === 'connector') return [...snapshot.connectors, ...snapshot.healthObservations];
  if (domain === 'runtime') return [...snapshot.runtimeComponents, ...snapshot.alerts];
  return snapshot.coverageGaps;
}

function qualifies(domain: AttentionDomain, row: RuntimeRow): boolean {
  if (domain === 'inventory')
    return !owner(row) || status(row) !== 'healthy' || text(row, 'coverage') !== 'complete';
  if (domain === 'source')
    return !owner(row) || status(row) !== 'healthy' || text(row, 'access_state') !== 'available';
  if (domain === 'evidence')
    return text(row, 'integrity_status') !== 'verified' || status(row) !== 'active';
  return unresolved(row);
}

function candidatesFor(
  domain: AttentionDomain,
  snapshot: RuntimeReadModelSnapshot,
  principalId: string,
  evaluatedAt: number,
): readonly AttentionCandidate[] {
  return rowsFor(domain, snapshot).flatMap((row, index) => {
    if (!qualifies(domain, row)) return [];
    const id = rowId(row, index);
    const itemSeverity = severity(row);
    const itemOwner = owner(row);
    const observation = observedAt(row, snapshot);
    const stale = evaluatedAt - observation > 15_000;
    const timing = timePosture(row, evaluatedAt);
    const candidate: AttentionCandidate = {
      tenantId: snapshot.tenantId,
      source: {
        tenantId: snapshot.tenantId,
        domain,
        recordType: text(row, 'record_type', 'asset_type', 'problem_class') ?? `${domain}_record`,
        recordId: id,
        ...(text(row, 'version', 'content_digest', 'case_digest') === undefined
          ? {}
          : { recordVersion: text(row, 'version', 'content_digest', 'case_digest') as string }),
        ...(text(row, 'governed_problem_key', 'work_item_id', 'source_record_id') === undefined
          ? {}
          : {
              governedProblemKey: text(
                row,
                'governed_problem_key',
                'work_item_id',
                'source_record_id',
              ) as string,
            }),
        href: href(domain, id),
        observedAt: observation,
        ...(itemOwner === undefined ? {} : { sourceOwnerId: itemOwner }),
        resolved: false,
      },
      title: title(domain, row, id),
      severity: itemSeverity,
      impact: impact(itemSeverity),
      timePosture: timing.posture,
      ownerPosture:
        itemOwner === undefined
          ? 'unowned'
          : itemOwner === principalId
            ? 'assigned_to_me'
            : 'assigned',
      freshness: stale ? 'stale' : 'current',
      confidence: stale ? 0.5 : itemSeverity === 'unknown' ? 0.65 : 1,
      dependencyCount:
        number(row, 'dependency_count', 'affected_count', 'unresolved_issue_count') ?? 0,
      actionable: true,
      safeNextAction: {
        label: `Inspect the authoritative ${domain} record`,
        href: href(domain, id),
      },
      ...(timing.dueAt === undefined ? {} : { dueAt: timing.dueAt }),
      rankingFacts: [`status:${status(row)}`, `domain:${domain}`],
    };
    return [candidate];
  });
}

function adapters(
  snapshotFor: (tenantId: string) => RuntimeReadModelSnapshot | undefined,
): readonly AttentionSourceAdapter[] {
  return (
    [
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
    ] as const
  ).map((domain) => ({
    domain,
    read: ({ tenantId, principalId, evaluatedAt }) => {
      const snapshot = snapshotFor(tenantId);
      if (!snapshot) throw new Error('runtime snapshot unavailable');
      const candidates = candidatesFor(domain, snapshot, principalId, evaluatedAt);
      return {
        candidates,
        coverage: snapshot.tenantRegistered
          ? {
              domain,
              quality: candidates.length === 0 ? 'verified_empty' : 'current',
              observedAt: snapshot.observedAtMs,
              candidateCount: candidates.length,
              sourceCursor: `${snapshot.observedAtMs}:${domain}:${rowsFor(domain, snapshot).length}`,
            }
          : {
              domain,
              quality: 'unknown',
              observedAt: snapshot.observedAtMs,
              failureCode: 'tenant_not_registered',
              safeNextAction: 'Register and reconcile the tenant before treating absence as empty.',
            },
      };
    },
  }));
}

function policy(
  priority: ServiceLevelPolicy['priority'],
  id: string,
  version: string,
): ServiceLevelPolicy | undefined {
  if (id !== `governance-${priority}` || version !== '1.0.0') return undefined;
  const targets: Readonly<
    Record<ServiceLevelPolicy['priority'], readonly [number, number, number]>
  > = {
    critical: [15 * 60_000, 4 * 3_600_000, 60 * 60_000],
    high: [60 * 60_000, 24 * 3_600_000, 4 * 3_600_000],
    medium: [4 * 3_600_000, 72 * 3_600_000, 24 * 3_600_000],
    low: [24 * 3_600_000, 7 * 24 * 3_600_000, 48 * 3_600_000],
  };
  const target = targets[priority];
  return {
    id,
    version,
    priority,
    acknowledgementMs: target[0],
    resolutionMs: target[1],
    verificationMs: target[2],
    escalationTargetRoles: ['governance_officer', 'control_owner', 'authorized_approver'],
    ownerId: 'governance-operations-owner',
  };
}

export interface RuntimeOperationsCommandCenter extends OperationsCommandCenterRouteDeps {
  readonly auditRecords: readonly OperationsAuditRecord[];
}

export function createRuntimeOperationsCommandCenter(input: {
  readonly snapshotFor: (tenantId: string) => RuntimeReadModelSnapshot | undefined;
  readonly now: () => number;
  readonly repository?: OperationalCaseRepository;
}): RuntimeOperationsCommandCenter {
  const repository = input.repository ?? new InMemoryOperationalCaseRepository();
  const auditRecords: OperationsAuditRecord[] = [];
  const cases = new OperationalCaseService({
    repository,
    audit: { record: (event) => void auditRecords.push(structuredClone(event)) },
    policy,
    newId: randomUUID,
  });
  return {
    attention: new AttentionQueueService(adapters(input.snapshotFor)),
    cases,
    now: input.now,
    auditRecords,
  };
}
