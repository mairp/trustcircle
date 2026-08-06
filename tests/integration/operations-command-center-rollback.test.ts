import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createRuntimeOperationsCommandCenter } from '../../apps/api/src/operations-runtime.ts';
import {
  createEmptyRuntimeSnapshot,
  createProductionApiRuntime,
  type RuntimeReadModelRepository,
  type RuntimeReadModelSnapshot,
} from '../../apps/api/src/production-runtime.ts';
import { InMemoryOperationalCaseRepository } from '../../packages/persistence/src/operational-case-repository.ts';
import {
  OPERATIONS_NOW,
  OPERATIONS_TENANT,
  caseContext,
  source,
} from '../fixtures/operations-command-center.ts';

class MemoryReadModels implements RuntimeReadModelRepository {
  constructor(private readonly value: RuntimeReadModelSnapshot) {}
  async refreshTenant(): Promise<RuntimeReadModelSnapshot> {
    return this.value;
  }
  snapshot(tenantId: string): RuntimeReadModelSnapshot | undefined {
    return tenantId === OPERATIONS_TENANT ? this.value : undefined;
  }
}

function center(repository: InMemoryOperationalCaseRepository) {
  const snapshot = createEmptyRuntimeSnapshot(OPERATIONS_TENANT, OPERATIONS_NOW);
  return createRuntimeOperationsCommandCenter({
    snapshotFor: (tenantId) => (tenantId === OPERATIONS_TENANT ? snapshot : undefined),
    now: () => OPERATIONS_NOW,
    repository,
  });
}

describe('operations command-center non-destructive rollback', () => {
  it('retains cases and append-only history when the surface is withdrawn and recomposed', async () => {
    const repository = new InMemoryOperationalCaseRepository();
    const first = center(repository);
    const created = await first.cases.create(caseContext(), {
      sourceReferences: [source()],
      title: 'Retained operational history',
      priority: 'high',
      ownerId: 'owner-a',
      policyId: 'governance-high',
      policyVersion: '1.0.0',
    });
    const before = await first.cases.read(OPERATIONS_TENANT, created.mutation.case.id, ['auditor']);

    const afterReenable = await center(repository).cases.read(
      OPERATIONS_TENANT,
      created.mutation.case.id,
      ['auditor'],
    );
    expect(afterReenable).toEqual(before);
    expect(afterReenable?.transitions.map((event) => event.command)).toEqual(['create']);
  });

  it('keeps prior domain reads available and uses no destructive down migration', async () => {
    const repository = new InMemoryOperationalCaseRepository();
    await center(repository).cases.create(caseContext(), {
      sourceReferences: [source()],
      title: 'Compatibility witness',
      priority: 'high',
      policyId: 'governance-high',
      policyVersion: '1.0.0',
    });
    const api = createProductionApiRuntime({
      repository: new MemoryReadModels(
        createEmptyRuntimeSnapshot(OPERATIONS_TENANT, OPERATIONS_NOW),
      ),
      preview: {
        enabled: true,
        tenantId: OPERATIONS_TENANT,
        principalId: 'rollback-auditor',
        roles: ['auditor'],
      },
      readiness: () => ({ facets: [], freshnessObjectiveMs: 15_000 }),
      operationsRepository: repository,
      now: () => OPERATIONS_NOW,
    });
    const inventory = await api.fetch(new Request('http://api/v1/inventory/assets'), {
      trustedPreviewTransport: true,
    });
    const cases = await api.fetch(new Request('http://api/v1/operations/cases'), {
      trustedPreviewTransport: true,
    });
    expect(inventory.status).toBe(200);
    expect(cases.status).toBe(200);
    expect(((await cases.json()) as { items: unknown[] }).items).toHaveLength(1);

    const migration = readFileSync(
      new URL('../../db/migrations/0070_operations_command_center.sql', import.meta.url),
      'utf8',
    );
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|SCHEMA|COLUMN)\b/i);
    expect(migration).toContain('operational_case_transition');
    expect(migration).toContain('operational_case_evidence');
  });

  it('pages cases deterministically and rejects a cursor after the case snapshot changes', async () => {
    const repository = new InMemoryOperationalCaseRepository();
    const operations = center(repository);
    for (const [index, title] of ['First governed case', 'Second governed case'].entries()) {
      await operations.cases.create(
        caseContext({
          idempotencyKey: `pagination-create-${index + 1}`,
          at: OPERATIONS_NOW + index,
        }),
        {
          sourceReferences: [source({ recordId: `pagination-source-${index + 1}` })],
          title,
          priority: 'high',
          policyId: 'governance-high',
          policyVersion: '1.0.0',
        },
      );
    }
    const api = createProductionApiRuntime({
      repository: new MemoryReadModels(
        createEmptyRuntimeSnapshot(OPERATIONS_TENANT, OPERATIONS_NOW),
      ),
      preview: {
        enabled: true,
        tenantId: OPERATIONS_TENANT,
        principalId: 'pagination-auditor',
        roles: ['auditor'],
      },
      readiness: () => ({ facets: [], freshnessObjectiveMs: 15_000 }),
      operationsRepository: repository,
      now: () => OPERATIONS_NOW,
    });

    const firstResponse = await api.fetch(new Request('http://api/v1/operations/cases?limit=1'), {
      trustedPreviewTransport: true,
    });
    expect(firstResponse.status).toBe(200);
    const firstPage = (await firstResponse.json()) as {
      items: { id: string }[];
      snapshot_cursor: string;
      next_cursor: string;
    };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.snapshot_cursor).toEqual(expect.any(String));
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const secondResponse = await api.fetch(
      new Request(
        `http://api/v1/operations/cases?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
      ),
      { trustedPreviewTransport: true },
    );
    expect(secondResponse.status).toBe(200);
    const secondPage = (await secondResponse.json()) as {
      items: { id: string }[];
      next_cursor: null;
    };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.next_cursor).toBeNull();

    await operations.cases.create(
      caseContext({ idempotencyKey: 'pagination-create-3', at: OPERATIONS_NOW + 2 }),
      {
        sourceReferences: [source({ recordId: 'pagination-source-3' })],
        title: 'Third governed case',
        priority: 'high',
        policyId: 'governance-high',
        policyVersion: '1.0.0',
      },
    );
    const staleResponse = await api.fetch(
      new Request(
        `http://api/v1/operations/cases?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
      ),
      { trustedPreviewTransport: true },
    );
    expect(staleResponse.status).toBe(409);
    expect((await staleResponse.json()) as Record<string, unknown>).toMatchObject({
      code: 'snapshot_changed',
      retryable: false,
      safe_next_actions: ['Restart the queue traversal from the first page.'],
    });
  });
});
