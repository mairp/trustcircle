import { describe, expect, it } from 'vitest';

import {
  createEmptyRuntimeSnapshot,
  createProductionApiRuntime,
  type RuntimeReadModelRepository,
  type RuntimeReadModelSnapshot,
} from '../../apps/api/src/production-runtime.ts';

const TENANT = '00000000-0000-4000-8000-000000000001';

class MemoryReadModels implements RuntimeReadModelRepository {
  constructor(private readonly value: RuntimeReadModelSnapshot) {}
  async refreshTenant(): Promise<RuntimeReadModelSnapshot> {
    return this.value;
  }
  snapshot(tenantId: string): RuntimeReadModelSnapshot | undefined {
    return tenantId === TENANT ? this.value : undefined;
  }
}

function runtime() {
  return createProductionApiRuntime({
    repository: new MemoryReadModels(createEmptyRuntimeSnapshot(TENANT, 1_800_000_000_000)),
    preview: {
      enabled: true,
      tenantId: TENANT,
      principalId: 'local-preview-operator',
      roles: ['auditor'],
    },
    readiness: () => ({ facets: [], freshnessObjectiveMs: 15_000 }),
    now: () => 1_800_000_001_000,
  });
}

describe('production command-center composition', () => {
  it('mounts tenant-scoped attention and case reads for the verified preview role', async () => {
    const api = runtime();
    const attention = await api.fetch(new Request('http://api/v1/operations/attention'), {
      trustedPreviewTransport: true,
    });
    expect(attention.status).toBe(200);
    const attentionBody = (await attention.json()) as Record<string, unknown>;
    expect(attentionBody['tenant_id']).toBe(TENANT);
    expect(attentionBody['ranking_version']).toBe('attention-ranking/v1');
    expect(Array.isArray(attentionBody['coverage'])).toBe(true);

    const cases = await api.fetch(new Request('http://api/v1/operations/cases'), {
      trustedPreviewTransport: true,
    });
    expect(cases.status).toBe(200);
    const caseBody = (await cases.json()) as Record<string, unknown>;
    expect(caseBody['tenant_id']).toBe(TENANT);
    expect(caseBody['items']).toEqual([]);
  });

  it('does not grant the trusted read-only preview a mutation transport', async () => {
    const api = runtime();
    const response = await api.fetch(
      new Request('http://api/v1/operations/cases', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'preview-attempt-01' },
        body: JSON.stringify({}),
      }),
      { trustedPreviewTransport: true },
    );
    expect(response.status).toBe(401);
  });
});
