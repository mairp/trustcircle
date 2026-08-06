import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function migration(name: string): string {
  return readFileSync(`${repositoryRoot}db/migrations/${name}`, 'utf8');
}

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/^CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gim)].map(
    (match) => match[1] ?? '',
  );
}

describe('controller and connector reconciliation migration ownership', () => {
  it('uses distinct physical tables for controller operations and connector state', () => {
    const controller = migration('0040_controller_operations.sql');
    const integrations = migration('0060_integrations.sql');

    expect(createdTables(controller)).toContain('reconciliation_run');
    expect(createdTables(integrations)).toContain('connector_reconciliation_run');
    expect(createdTables(integrations)).not.toContain('reconciliation_run');
  });

  it('binds the connector index and RLS policy to the connector-owned table', () => {
    const integrations = migration('0060_integrations.sql');

    expect(integrations).toMatch(
      /CREATE INDEX IF NOT EXISTS connector_reconciliation_run_connector_idx\s+ON connector_reconciliation_run\s*\(tenant_id, connector_id, started_at\)/i,
    );
    expect(integrations).toMatch(
      /ALTER TABLE connector_reconciliation_run ENABLE ROW LEVEL SECURITY/i,
    );
    expect(integrations).toMatch(
      /CREATE POLICY tenant_isolation ON connector_reconciliation_run/i,
    );
  });

  it('detects the original incompatible-name regression', () => {
    const controllerTables = createdTables(
      'CREATE TABLE IF NOT EXISTS reconciliation_run (id uuid);',
    );
    const brokenIntegrationTables = createdTables(
      'CREATE TABLE IF NOT EXISTS reconciliation_run (connector_id uuid);',
    );

    expect(controllerTables.filter((table) => brokenIntegrationTables.includes(table))).toEqual([
      'reconciliation_run',
    ]);
  });
});
