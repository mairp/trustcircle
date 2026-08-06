import { describe, expect, it } from 'vitest';

import type { ConsoleSectionState } from '../../apps/web/src/lib/console-loader.ts';
import {
  PLATFORM_WORKSPACES,
  ROLE_DASHBOARDS,
  SAVED_VIEWS,
  classifyRecordStatus,
  deploymentIdentity,
  parseDiscoveryQuery,
  searchConsoleSections,
  statusExplanation,
  workspaceForDomain,
} from '../../apps/web/src/lib/platform-workspaces.ts';

const inventory: ConsoleSectionState = {
  id: 'inventory',
  title: 'Governed inventory',
  path: '/v1/inventory/assets',
  quality: 'current',
  observedAt: '2026-08-06T08:00:00Z',
  source: 'inventory-projection/v1',
  recordCount: 3,
  verifiedEmpty: false,
  summary: '3 tenant-scoped records observed.',
  description: 'Governed assets.',
  emptyMessage: 'No assets.',
  detailsLabel: 'Governed assets',
  hiddenRecordCount: 0,
  facts: [],
  records: [
    {
      id: 'inventory-asset-critical',
      title: 'Payments model',
      subtitle: 'AI service',
      fields: [
        { label: 'Asset ID', value: 'asset-critical', emphasis: 'identifier' },
        { label: 'Owner', value: 'owner-a' },
        { label: 'Risk tier', value: 'Critical', emphasis: 'status' },
        { label: 'Evidence', value: 'Stale', emphasis: 'status' },
        { label: 'Confidence', value: '62%' },
        { label: 'Observed', value: '2026-08-06T08:00:00Z', emphasis: 'time' },
      ],
    },
    {
      id: 'inventory-asset-unknown',
      title: 'Unowned discovery',
      fields: [
        { label: 'Asset ID', value: 'asset-unknown', emphasis: 'identifier' },
        { label: 'Owner', value: 'Unknown' },
        { label: 'Health', value: 'Unknown', emphasis: 'status' },
        { label: 'Confidence', value: '0%' },
      ],
    },
    {
      id: 'inventory-asset-healthy',
      title: 'Support assistant',
      fields: [
        { label: 'Asset ID', value: 'asset-healthy', emphasis: 'identifier' },
        { label: 'Owner', value: 'owner-b' },
        { label: 'Health', value: 'Healthy', emphasis: 'status' },
        { label: 'Evidence', value: 'Current', emphasis: 'status' },
        { label: 'Confidence', value: '100%' },
      ],
    },
  ],
};

const runtime: ConsoleSectionState = {
  ...inventory,
  id: 'operations',
  title: 'Runtime components',
  path: '/v1/platform/health',
  quality: 'degraded',
  recordCount: 1,
  summary: '1 runtime component requires attention.',
  description: 'Runtime state.',
  detailsLabel: 'Runtime components',
  records: [
    {
      id: 'operations-command-worker',
      title: 'Command worker',
      fields: [
        { label: 'Component', value: 'command-worker', emphasis: 'identifier' },
        { label: 'Health', value: 'Failed', emphasis: 'status' },
        { label: 'Owner', value: 'platform-ops' },
        { label: 'Safe next action', value: 'Inspect retry and dead-letter diagnostics.' },
      ],
    },
  ],
};

describe('platform workspace catalog', () => {
  it('provides a unique route for every governed console domain and roadmap workspace', () => {
    const routes = PLATFORM_WORKSPACES.map((workspace) => workspace.href);
    expect(new Set(routes).size).toBe(routes.length);
    expect(
      PLATFORM_WORKSPACES.filter((workspace) => workspace.domain).map(
        (workspace) => workspace.domain,
      ),
    ).toEqual(
      expect.arrayContaining([
        'posture',
        'inventory',
        'gaps',
        'decisions',
        'integrity',
        'controllers',
        'compliance',
        'evidence',
        'integrations',
        'operations',
      ]),
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        '/search',
        '/operations',
        '/trends',
        '/registers',
        '/automation',
        '/ai-governance',
        '/copilot',
      ]),
    );
    expect(workspaceForDomain('inventory')?.href).toBe('/inventory');
    expect(workspaceForDomain('operations')?.href).toBe('/runtime');
  });

  it('defines distinct role entry points without granting authority', () => {
    expect(ROLE_DASHBOARDS.governance_officer.title).toMatch(/governance/i);
    expect(ROLE_DASHBOARDS.operator.primaryHref).toBe('/operations');
    expect(ROLE_DASHBOARDS.auditor.readOnly).toBe(true);
    expect(ROLE_DASHBOARDS.platform_admin.readOnly).toBe(true);
  });
});

describe('explainable status language', () => {
  it('groups failed, uncertain, stale, and healthy records conservatively', () => {
    expect(classifyRecordStatus(runtime.records[0]!).group).toBe('blocked');
    expect(classifyRecordStatus(inventory.records[0]!).group).toBe('needs_attention');
    expect(classifyRecordStatus(inventory.records[1]!).group).toBe('unknown');
    expect(classifyRecordStatus(inventory.records[2]!).group).toBe('healthy');
  });

  it('explains degraded sections and always supplies a safe next action', () => {
    const explanation = statusExplanation(runtime);
    expect(explanation.group).toBe('blocked');
    expect(explanation.why).toMatch(/degraded/i);
    expect(explanation.safeNextAction.length).toBeGreaterThan(10);
  });
});

describe('global discovery and governed URL views', () => {
  it('normalizes unknown parameters and expands saved view presets', () => {
    const query = parseDiscoveryQuery({
      view: 'unknown-records',
      page: '-9',
      page_size: '500',
      sort: 'nonsense',
    });
    expect(query.group).toBe('unknown');
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(100);
    expect(query.sort).toBe('priority');
    expect(SAVED_VIEWS.some((view) => view.id === 'unknown-records')).toBe(true);
  });

  it('searches allowlisted presentation fields, filters status, and paginates deterministically', () => {
    const stale = searchConsoleSections([inventory, runtime], {
      ...parseDiscoveryQuery({ q: 'evidence', group: 'needs_attention' }),
      pageSize: 1,
    });
    expect(stale.total).toBe(1);
    expect(stale.items[0]).toMatchObject({ title: 'Payments model', domain: 'inventory' });
    expect(stale.items[0]?.href).toBe('/assets/asset-critical');

    const all = searchConsoleSections(
      [inventory, runtime],
      parseDiscoveryQuery({ sort: 'title', page_size: '2' }),
    );
    expect(all.total).toBe(4);
    expect(all.pageCount).toBe(2);
    expect(all.items.map((item) => item.title)).toEqual(['Command worker', 'Payments model']);
  });
});

describe('deployment identity', () => {
  it('exposes disclosure-safe build, profile, schema, and drift metadata', () => {
    const identity = deploymentIdentity({
      TC_APP_VERSION: '2.4.1',
      TC_BUILD_COMMIT: 'abcdef1234567890',
      TC_DEPLOYMENT_PROFILE: 'staging',
      TC_SCHEMA_VERSION: '0090',
      TC_APPROVED_BUILD_COMMIT: 'abcdef1234567890',
    });
    expect(identity).toMatchObject({
      version: '2.4.1',
      commit: 'abcdef123456',
      profile: 'staging',
      schemaVersion: '0090',
      drift: 'matched',
    });
  });
});
