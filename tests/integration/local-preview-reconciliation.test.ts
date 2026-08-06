import { describe, expect, it } from 'vitest';

import {
  localPreviewUuid,
  reconcileLocalPreviewData,
} from '../../apps/api/src/local-preview-reconciliation.ts';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

describe('local preview governed-data reconciliation', () => {
  it('uses stable identifiers and materializes declarations without inferring live health', async () => {
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const client = {
      async query(sql: string, values: readonly unknown[] = []) {
        statements.push({ sql, values });
        return { rows: [] };
      },
    };

    const result = await reconcileLocalPreviewData(client, {
      tenantId: TENANT_ID,
      observedAtMs: 1_785_824_000_000,
      componentProfile: {
        components: [
          {
            id: 'api',
            role: 'control-plane',
            runtimeSet: 'core-required',
            owner: 'platform/governance',
          },
        ],
      },
      adapterManifests: [
        {
          path: 'adapters/example/manifest.json',
          manifest: {
            adapter_id: 'example',
            name: 'Example adapter',
            adapter_version: '1.0.0',
            contract_range: { minimum: '1.0.0', maximum: '1.0.0' },
            source_classes: ['example'],
            capabilities: ['inspect'],
            lifecycle: { status: 'supported', released_at: '2026-08-01T00:00:00Z' },
          },
        },
      ],
      standardsRegistry: {
        publications: [
          {
            id: 'standard-1',
            publisher: 'Standards body',
            identifier: 'STD 1',
            exactTitle: 'Test standard',
            edition: 'First',
            publicationDate: '2026-01-01',
            status: 'published',
            materialType: 'requirements',
            sourceUri: 'https://example.test/std-1',
            registryVersion: 1,
            clauses: [
              {
                clauseRef: '1',
                title: 'Scope',
                materialType: 'requirements',
                version: 1,
              },
            ],
          },
        ],
      },
    });

    expect(result).toMatchObject({
      tenantId: TENANT_ID,
      principals: 1,
      assets: 1,
      sources: 1,
      coverageGaps: 1,
      connectors: 1,
      componentActivations: 1,
      publications: 1,
      clauses: 1,
    });
    expect(localPreviewUuid('component-asset:api')).toBe(localPreviewUuid('component-asset:api'));
    expect(localPreviewUuid('component-asset:api')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql).toContain('INSERT INTO tenant');
    expect(sql).toContain('INSERT INTO governed_asset');
    expect(sql).toContain('INSERT INTO source_catalog_entry');
    expect(sql).toContain('INSERT INTO coverage_gap');
    expect(sql).toContain('INSERT INTO connector_instance');
    expect(sql).toContain('INSERT INTO standard_publication');
    expect(sql).toContain("'unknown', 'partial'");
    expect(sql).toContain("'inactive'");
    expect(sql).not.toContain("'healthy'");
    expect(sql).not.toContain("'active', TRUE");
  });
});
