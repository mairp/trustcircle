import { describe, expect, it } from 'vitest';

import {
  DOMAIN_PRESENTATION,
  presentConsoleRecords,
  presentSectionFacts,
} from '../../apps/web/src/lib/console-presenter.ts';

describe('operator console record presenters', () => {
  it('turns governed inventory records into meaningful allowlisted details', () => {
    const records = presentConsoleRecords('inventory', [
      {
        assetId: 'asset-42',
        name: 'Payments decision service',
        assetType: 'ai_service',
        ownerPrincipalId: 'control-owner-7',
        lifecycleState: 'active',
        riskTier: 'high',
        coverage: 'governed',
        reportedHealth: 'healthy',
        evidenceState: 'current',
        lastObservationAt: Date.parse('2026-08-04T07:00:00.000Z'),
        credential_ref: 'must-never-render',
        arbitrary_private_payload: { secret: 'must-never-render' },
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]?.title).toBe('Payments decision service');
    expect(records[0]?.subtitle).toBe('AI service');
    const serialized = JSON.stringify(records);
    expect(serialized).toContain('High');
    expect(serialized).toContain('Control owner 7');
    expect(serialized).toContain('2026-08-04T07:00:00.000Z');
    expect(serialized).not.toContain('must-never-render');
    expect(serialized).not.toContain('credential_ref');
  });

  it('presents posture records as domain counts instead of opaque records', () => {
    const records = presentConsoleRecords('posture', [
      { domain: 'inventory', record_count: 3 },
      { domain: 'decisions', record_count: 1 },
    ]);

    expect(records.map((record) => record.title)).toEqual([
      'Governed inventory',
      'Human decisions',
    ]);
    expect(records.map((record) => record.subtitle)).toEqual([
      '3 governed records',
      '1 governed record',
    ]);
  });

  it('exposes truthful domain copy and selected section-level facts', () => {
    expect(DOMAIN_PRESENTATION.inventory.description).toContain('assets');
    expect(DOMAIN_PRESENTATION.inventory.emptyMessage).toContain('registered');
    expect(
      presentSectionFacts('operations', {
        aggregate: 'degraded',
        openAlerts: [{ id: 'alert-1' }],
        staleConnectorIds: ['connector-1', 'connector-2'],
        rawSecret: 'must-never-render',
      }),
    ).toEqual([
      { label: 'Platform state', value: 'Degraded', emphasis: 'status' },
      { label: 'Open alerts', value: '1' },
      { label: 'Stale connectors', value: '2' },
    ]);
  });
});
