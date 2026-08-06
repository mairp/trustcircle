import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConsole } from '../../apps/web/src/lib/console-loader.ts';
import type { DomainPlan } from '../../apps/web/src/lib/permissions.ts';

afterEach(() => vi.unstubAllGlobals());

describe('partial multi-read composition', () => {
  it('preserves successful siblings and never converts failure to verified empty', async () => {
    const plans: readonly DomainPlan[] = [
      { id: 'inventory', label: 'Inventory', path: '/v1/inventory/assets', roles: ['operator'] },
      { id: 'decisions', label: 'Decisions', path: '/v1/decisions', roles: ['operator'] },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/v1/inventory/assets')) {
          return Response.json({
            tenant_id: 'tenant-a',
            observed_at: new Date().toISOString(),
            quality: 'current',
            items: [],
          });
        }
        return Response.json(
          { error: 'UPSTREAM_UNAVAILABLE', correlationId: 'corr-safe-123' },
          { status: 503 },
        );
      }),
    );
    const sections = await loadConsole(plans, {
      authenticated: true,
      principalId: 'principal-a',
      tenantId: 'tenant-a',
      roles: ['operator'],
    });
    expect(sections[0]).toMatchObject({ quality: 'current', verifiedEmpty: true });
    expect(sections[1]).toMatchObject({ quality: 'unavailable', verifiedEmpty: false });
    expect(sections[1]?.summary).toContain(
      'No empty, healthy, complete, or compliant state is inferred.',
    );
    expect(sections[1]?.summary).not.toContain('Verified empty:');
  });

  it('does not convert an unregistered-tenant response into verified empty', async () => {
    const plans: readonly DomainPlan[] = [
      { id: 'inventory', label: 'Inventory', path: '/v1/inventory/assets', roles: ['operator'] },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          tenantId: 'tenant-a',
          observedAt: new Date().toISOString(),
          quality: 'unknown',
          records: [],
          partialFailures: ['tenant_not_registered'],
          safeNextAction: 'Register and reconcile this tenant.',
        }),
      ),
    );

    const [section] = await loadConsole(plans, {
      authenticated: true,
      principalId: 'principal-a',
      tenantId: 'tenant-a',
      roles: ['operator'],
    });

    expect(section).toMatchObject({
      quality: 'unknown',
      verifiedEmpty: false,
      diagnostic: 'tenant_not_registered',
      safeNextAction: 'Register and reconcile this tenant.',
    });
    expect(section?.summary).toContain('not treated as an authoritative empty state');
  });
});
