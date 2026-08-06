import { describe, expect, it } from 'vitest';

import { presentConsoleRecords } from '../../apps/web/src/lib/console-presenter.ts';

describe('bounded discovery presentation', () => {
  it('retains up to 500 allowlisted records for route pagination without exposing raw fields', () => {
    const values = Array.from({ length: 501 }, (_, index) => ({
      assetId: `asset-${String(index).padStart(4, '0')}`,
      name: `Asset ${index}`,
      ownerPrincipalId: `owner-${index % 5}`,
      reportedHealth: 'healthy',
      secret: `must-not-render-${index}`,
    }));
    const records = presentConsoleRecords('inventory', values);
    expect(records).toHaveLength(500);
    expect(records[499]?.title).toBe('Asset 499');
    expect(
      records.flatMap((record) => record.fields).some((field) => field.label === 'secret'),
    ).toBe(false);
  });
});
