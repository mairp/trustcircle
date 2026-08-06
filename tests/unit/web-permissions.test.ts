import { describe, expect, it } from 'vitest';

import { hasGovernanceAuthority, permittedDomains } from '../../apps/web/src/lib/permissions.ts';

describe('server-authorized console planning', () => {
  it('does not grant platform administrators governance authority', () => {
    const session = {
      authenticated: true,
      principalId: 'p',
      tenantId: 'a',
      tenantName: 'A',
      roles: ['platform_admin'] as const,
    };
    expect(hasGovernanceAuthority(session)).toBe(false);
    expect(permittedDomains(session)).toEqual([]);
  });

  it('plans only explicit versioned reads for a permitted role', () => {
    const session = {
      authenticated: true,
      principalId: 'p',
      tenantId: 'a',
      tenantName: 'A',
      roles: ['operator'] as const,
    };
    const plans = permittedDomains(session);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => plan.path.startsWith('/v1/'))).toBe(true);
  });
});
