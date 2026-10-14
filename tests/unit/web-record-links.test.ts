import { describe, expect, it } from 'vitest';

import { presentConsoleRecords } from '../../apps/web/src/lib/console-presenter.ts';
import {
  operationsSourceHref,
  recordDetailHref,
} from '../../apps/web/src/lib/platform-workspaces.ts';

const DECISION = '11111111-1111-4111-8111-111111111111';

describe('recordDetailHref', () => {
  it('opens decisions on the live decision page, from presenter ids or bare ids', () => {
    const [record] = presentConsoleRecords('decisions', [{ id: DECISION, status: 'pending' }]);
    expect(record?.id).toBe(`decisions-${DECISION}`);
    expect(recordDetailHref('decisions', record!)).toBe(`/decisions/${DECISION}`);
    expect(recordDetailHref('decisions', { id: DECISION, title: 'x', fields: [] })).toBe(
      `/decisions/${DECISION}`,
    );
  });

  it('opens inventory assets in Asset 360 and other records on their workspace detail route', () => {
    expect(
      recordDetailHref('inventory', {
        id: 'inventory-a',
        title: 'a',
        fields: [{ label: 'Asset ID', value: 'ASSET 7' }],
      }),
    ).toBe('/assets/ASSET%207');
    expect(recordDetailHref('integrity', { id: 'integrity-case/1', title: 'c', fields: [] })).toBe(
      '/integrity/integrity-case%2F1',
    );
    expect(recordDetailHref('operations', { id: 'operations-api', title: 'api', fields: [] })).toBe(
      '/runtime/operations-api',
    );
  });

  it('never links a decision whose id is not a uuid to the decision page', () => {
    expect(recordDetailHref('decisions', { id: 'decisions-3', title: 'x', fields: [] })).toBe(
      '/decisions/decisions-3',
    );
  });
});

describe('operationsSourceHref', () => {
  it('maps attention domains to console pages using the presenter id scheme', () => {
    expect(operationsSourceHref('decision', DECISION)).toBe(`/decisions/${DECISION}`);
    expect(operationsSourceHref('inventory', 'ASSET-1')).toBe('/assets/ASSET-1');
    expect(operationsSourceHref('integrity', 'case-9')).toBe('/integrity/integrity-case-9');
    expect(operationsSourceHref('connector', 'c1')).toBe('/integrations/integrations-c1');
    expect(operationsSourceHref('runtime', 'api')).toBe('/runtime/operations-api');
    expect(operationsSourceHref('coverage', 'g1')).toBe('/gaps/gaps-g1');
  });

  it('returns no link for an unknown domain instead of a raw API URL', () => {
    expect(operationsSourceHref('mystery', 'x')).toBeUndefined();
  });
});
