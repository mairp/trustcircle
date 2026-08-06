import { describe, expect, it } from 'vitest';

import {
  INTERNAL_PREVIEW_IDENTITY_HEADER,
  createEmptyRuntimeSnapshot,
  createProductionApiRuntime,
  type RuntimeReadModelRepository,
  type RuntimeReadModelSnapshot,
} from '../../apps/api/src/production-runtime.ts';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';
const DECISION_A = '10000000-0000-4000-8000-000000000001';
const DECISION_B = '10000000-0000-4000-8000-000000000002';
const WORK_ITEM = '20000000-0000-4000-8000-000000000001';
const PRINCIPAL = '30000000-0000-4000-8000-000000000001';

const UI_ROUTES = [
  '/v1/dashboards/governance-officer',
  '/v1/inventory/assets',
  '/v1/inventory/sources',
  '/v1/decisions',
  '/v1/integrity-cases',
  '/v1/controllers',
  '/v1/compliance/coverage',
  '/v1/dashboards/auditor',
  '/v1/connectors',
  '/v1/platform/health',
] as const;

class MemoryReadModels implements RuntimeReadModelRepository {
  readonly refreshed: string[] = [];

  constructor(
    private readonly snapshots: ReadonlyMap<string, RuntimeReadModelSnapshot>,
    private readonly failure?: Error,
  ) {}

  async refreshTenant(tenantId: string): Promise<RuntimeReadModelSnapshot> {
    this.refreshed.push(tenantId);
    if (this.failure) throw this.failure;
    const snapshot = this.snapshots.get(tenantId);
    if (!snapshot) throw new Error('tenant snapshot missing');
    return snapshot;
  }

  snapshot(tenantId: string): RuntimeReadModelSnapshot | undefined {
    return this.snapshots.get(tenantId);
  }
}

function decision(id: string, tenantId: string) {
  return {
    id,
    tenant_id: tenantId,
    work_item_id: WORK_ITEM,
    requester_principal_id: PRINCIPAL,
    requested_action: 'review',
    action_class: 'read_only_preview',
    risk_tier: 'low',
    scope: {},
    business_impact: {},
    risks: [],
    alternatives: [],
    expected_result: {},
    affected_tenant_ids: [],
    status: 'pending',
    version: '1',
    created_at: '1785824000000',
    expires_at: '1788416000000',
    updated_at: '1785824000000',
  };
}

function runtimeWith(repository: RuntimeReadModelRepository) {
  return createProductionApiRuntime({
    repository,
    preview: {
      enabled: true,
      tenantId: TENANT_A,
      principalId: 'local-preview-operator',
      roles: ['auditor'],
    },
    now: () => 1_785_824_010_000,
    readiness: () => ({ facets: [], freshnessObjectiveMs: 15_000 }),
  });
}

describe('production API runtime console wiring', () => {
  it('mounts every UI read route and returns current tenant-scoped envelopes', async () => {
    const repository = new MemoryReadModels(
      new Map([[TENANT_A, createEmptyRuntimeSnapshot(TENANT_A, 1_785_824_000_000)]]),
    );
    const runtime = runtimeWith(repository);

    for (const path of UI_ROUTES) {
      const response = await runtime.fetch(new Request(`http://api${path}`), {
        trustedPreviewTransport: true,
      });
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['apiVersion'], path).toBe(1);
      expect(body['contractVersion'], path).toBe('1.0');
      expect(body['tenantId'], path).toBe(TENANT_A);
      expect(body['observedAt'], path).toBe('2026-08-04T06:13:20.000Z');
      expect(body['quality'], path).toBe('current');
      if (path === '/v1/platform/health') {
        expect(body['source'], path).toBe('runtime-reconciliation:component-profile+live-probes');
      } else {
        expect(body['source'], path).toMatch(/^postgresql-read-model:/);
      }
      expect(Array.isArray(body['records']), path).toBe(true);
    }

    expect(repository.refreshed).toEqual(Array(UI_ROUTES.length).fill(TENANT_A));
  });

  it('surfaces declared runtime components and preserves degraded workload truth', async () => {
    const component = {
      component_key: 'projector',
      profile_version: '1.0.0',
      role: 'projector',
      runtime_set: 'core-required',
      availability_class: 'core',
      owner: 'platform/governance',
      purpose: 'Builds read-model projections.',
      dependencies: ['postgres', 'nats'],
      may_execute: false,
      runtime_state: 'dependency-supervisor',
      health: 'degraded',
      freshness: 'fresh',
      observation_source: 'live-probe',
      observation_detail: 'projector module loaded; governed workload loop not started',
      observed_at: 1_785_824_000_000,
      safe_next_action: 'Start the governed projector workload.',
    };
    const snapshot = {
      ...createEmptyRuntimeSnapshot(TENANT_A, 1_785_824_000_000),
      runtimeComponents: [component],
    };
    const runtime = runtimeWith(new MemoryReadModels(new Map([[TENANT_A, snapshot]])));

    const healthResponse = await runtime.fetch(new Request('http://api/v1/platform/health'), {
      trustedPreviewTransport: true,
    });
    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      aggregate: 'degraded',
      quality: 'current',
      source: 'runtime-reconciliation:component-profile+live-probes',
      records: [component],
    });

    const postureResponse = await runtime.fetch(
      new Request('http://api/v1/dashboards/governance-officer'),
      { trustedPreviewTransport: true },
    );
    const posture = (await postureResponse.json()) as { records: Record<string, unknown>[] };
    expect(posture.records).toContainEqual({ domain: 'runtime-components', record_count: 1 });
  });

  it('ignores forged browser identity headers and never grants the preview identity to writes', async () => {
    const repository = new MemoryReadModels(
      new Map([[TENANT_A, createEmptyRuntimeSnapshot(TENANT_A, 1_785_824_000_000)]]),
    );
    const runtime = runtimeWith(repository);
    const forgedHeaders = {
      [INTERNAL_PREVIEW_IDENTITY_HEADER]: 'forged',
      'x-trustcircle-tenant-id': TENANT_A,
      'x-trustcircle-roles': 'governance_officer',
    };

    const directRead = await runtime.fetch(
      new Request('http://api/v1/decisions', { headers: forgedHeaders }),
    );
    expect(directRead.status).toBe(401);

    const write = await runtime.fetch(
      new Request('http://api/v1/decisions', {
        method: 'POST',
        headers: { ...forgedHeaders, 'content-type': 'application/json' },
        body: '{}',
      }),
      { trustedPreviewTransport: true },
    );
    expect(write.status).toBe(401);
  });

  it('keeps tenant reads isolated even when a caller spoofs another tenant header', async () => {
    const snapshotA = {
      ...createEmptyRuntimeSnapshot(TENANT_A, 1_785_824_000_000),
      decisions: [decision(DECISION_A, TENANT_A)],
    };
    const snapshotB = {
      ...createEmptyRuntimeSnapshot(TENANT_B, 1_785_824_000_000),
      decisions: [decision(DECISION_B, TENANT_B)],
    };
    const repository = new MemoryReadModels(
      new Map([
        [TENANT_A, snapshotA],
        [TENANT_B, snapshotB],
      ]),
    );
    const runtime = runtimeWith(repository);

    const response = await runtime.fetch(
      new Request('http://api/v1/decisions', {
        headers: { 'x-trustcircle-tenant-id': TENANT_B },
      }),
      { trustedPreviewTransport: true },
    );
    const body = (await response.json()) as {
      tenantId: string;
      records: { id: string; tenant_id: string }[];
    };
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ id: DECISION_A, tenant_id: TENANT_A });
    expect(JSON.stringify(body)).not.toContain(DECISION_B);
    expect(JSON.stringify(body)).not.toContain(TENANT_B);
  });

  it('does not report an unregistered tenant as a verified current empty state', async () => {
    const unregistered = createEmptyRuntimeSnapshot(TENANT_A, 1_785_824_000_000, false);
    const runtime = runtimeWith(new MemoryReadModels(new Map([[TENANT_A, unregistered]])));

    const response = await runtime.fetch(new Request('http://api/v1/inventory/assets'), {
      trustedPreviewTransport: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      tenantId: TENANT_A,
      quality: 'unknown',
      records: [],
      partialFailures: ['tenant_not_registered'],
    });
    expect(body['safeNextAction']).toContain('Register and reconcile this tenant');
  });

  it('returns a fail-visible unavailable envelope when the repository has no last-known state', async () => {
    const runtime = runtimeWith(new MemoryReadModels(new Map(), new Error('postgres down')));
    const response = await runtime.fetch(new Request('http://api/v1/controllers'), {
      trustedPreviewTransport: true,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      tenantId: TENANT_A,
      quality: 'unavailable',
      records: [],
      partialFailures: ['postgresql_read_failed'],
    });
    expect(JSON.stringify(body)).not.toContain('postgres down');
  });

  it('serves last-known tenant data as degraded when refresh fails', async () => {
    const lastKnown = {
      ...createEmptyRuntimeSnapshot(TENANT_A, 1_785_824_000_000),
      decisions: [decision(DECISION_A, TENANT_A)],
    };
    const runtime = runtimeWith(
      new MemoryReadModels(new Map([[TENANT_A, lastKnown]]), new Error('postgres down')),
    );
    const response = await runtime.fetch(new Request('http://api/v1/decisions'), {
      trustedPreviewTransport: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['quality']).toBe('degraded');
    expect(body['partialFailures']).toEqual(['postgresql_read_failed']);
    expect(body['observedAt']).toBe('2026-08-04T06:13:20.000Z');
  });
});
