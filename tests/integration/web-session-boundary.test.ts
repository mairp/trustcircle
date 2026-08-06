import { describe, expect, it } from 'vitest';

import {
  protectedCacheKey,
  PROTECTED_RESPONSE_HEADERS,
} from '../../apps/web/src/lib/cache-policy.ts';
import {
  resolveLocalPreviewSession,
  validateSessionClaims,
} from '../../apps/web/src/lib/session-context.ts';

describe('operator session boundary', () => {
  it('fails closed when identity headers are not from a trusted boundary', () => {
    expect(
      validateSessionClaims({ trusted: false, principalId: 'p', tenantId: 'a', roles: 'operator' }),
    ).toEqual({ authenticated: false, roles: [] });
  });

  it('uses a fixed auditor-only identity when local preview is explicitly enabled', () => {
    expect(resolveLocalPreviewSession(false)).toBeUndefined();
    expect(resolveLocalPreviewSession(true)).toEqual({
      authenticated: true,
      principalId: 'local-preview-operator',
      tenantId: '00000000-0000-4000-8000-000000000001',
      tenantName: 'Local read-only preview',
      roles: ['auditor'],
    });
  });

  it('filters unknown roles and keys protected state by principal, tenant, roles and contract', () => {
    const session = validateSessionClaims({
      trusted: true,
      principalId: 'p',
      tenantId: 'a',
      roles: 'operator,root,platform_admin',
    });
    expect(session.roles).toEqual(['operator', 'platform_admin']);
    const a = protectedCacheKey({
      principalId: 'p',
      tenantId: 'a',
      roles: session.roles,
      contract: 'v1',
    });
    const b = protectedCacheKey({
      principalId: 'p',
      tenantId: 'b',
      roles: session.roles,
      contract: 'v1',
    });
    expect(a).not.toBe(b);
    expect(PROTECTED_RESPONSE_HEADERS['cache-control']).toContain('no-store');
  });
});
