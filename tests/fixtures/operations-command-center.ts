import type {
  AttentionCandidate,
  AttentionSourceReference,
  ServiceLevelPolicy,
} from '../../packages/domain/src/operations.ts';
import { InMemoryOperationalCaseRepository } from '../../packages/persistence/src/operational-case-repository.ts';
import {
  OperationalCaseService,
  type OperationsAuditRecord,
} from '../../packages/application/src/operational-case-service.ts';

export const OPERATIONS_NOW = 1_800_000_000_000;
export const OPERATIONS_TENANT = '00000000-0000-4000-8000-000000000001';
export const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';

export const OPERATIONS_POLICY: ServiceLevelPolicy = {
  id: 'ops-standard',
  version: '2026.1',
  priority: 'high',
  acknowledgementMs: 60_000,
  resolutionMs: 300_000,
  verificationMs: 60_000,
  escalationTargetRoles: ['operator', 'governance_officer'],
  ownerId: 'governance-operations',
};

export function source(
  overrides: Partial<AttentionSourceReference> = {},
): AttentionSourceReference {
  return {
    tenantId: OPERATIONS_TENANT,
    domain: 'decision',
    recordType: 'decision_request',
    recordId: 'decision-1',
    recordVersion: '4',
    governedProblemKey: 'release-42-governance',
    href: '/v1/decisions/decision-1',
    observedAt: OPERATIONS_NOW - 3_600_000,
    sourceOwnerId: 'owner-a',
    resolved: false,
    ...overrides,
  };
}

export function candidate(overrides: Partial<AttentionCandidate> = {}): AttentionCandidate {
  const reference = overrides.source ?? source();
  return {
    tenantId: reference.tenantId,
    source: reference,
    title: 'Production release requires a governed decision',
    severity: 'high',
    impact: 'material',
    timePosture: 'due',
    ownerPosture: 'assigned',
    freshness: 'current',
    confidence: 0.95,
    dependencyCount: 3,
    actionable: true,
    safeNextAction: { label: 'Review decision', href: reference.href },
    dueAt: OPERATIONS_NOW + 60_000,
    rankingFacts: ['high risk release', 'three dependent services'],
    ...overrides,
  };
}

export function caseContext(
  overrides: Partial<{
    tenantId: string;
    principalId: string;
    roles: readonly (
      'operator' | 'governance_officer' | 'auditor' | 'platform_admin' | 'automation_principal'
    )[];
    idempotencyKey: string;
    reason: string;
    at: number;
  }> = {},
) {
  const principalId = overrides.principalId ?? 'operator-a';
  return {
    tenantId: overrides.tenantId ?? OPERATIONS_TENANT,
    actor: {
      principalId,
      roles: overrides.roles ?? ['operator'],
      correlationId: `correlation-${principalId}`,
      causationId: `causation-${principalId}`,
    },
    idempotencyKey: overrides.idempotencyKey ?? 'operation-key-0001',
    reason: overrides.reason ?? 'Operator confirmed the governed operational response.',
    at: overrides.at ?? OPERATIONS_NOW,
  } as const;
}

export function createCaseService() {
  const repository = new InMemoryOperationalCaseRepository();
  const audit: OperationsAuditRecord[] = [];
  let sequence = 0;
  const service = new OperationalCaseService({
    repository,
    audit: { record: (event) => void audit.push(event) },
    policy: (priority, id, version) =>
      priority === OPERATIONS_POLICY.priority &&
      id === OPERATIONS_POLICY.id &&
      version === OPERATIONS_POLICY.version
        ? OPERATIONS_POLICY
        : undefined,
    newId: () => `operations-record-${String(++sequence).padStart(4, '0')}`,
  });
  return { service, repository, audit };
}

export const createCaseInput = {
  sourceReferences: [source()],
  title: 'Governed production release response',
  priority: 'high' as const,
  ownerId: 'owner-a',
  policyId: OPERATIONS_POLICY.id,
  policyVersion: OPERATIONS_POLICY.version,
};
