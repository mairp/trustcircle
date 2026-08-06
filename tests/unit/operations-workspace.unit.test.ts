import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadOperationsWorkspace,
  parseOperationsWorkspaceFilters,
} from '../../apps/web/src/lib/operations-loader.ts';
import { operationsWorkspaceCapabilities } from '../../apps/web/src/lib/permissions.ts';
import type { OperatorSessionContext } from '../../apps/web/src/lib/session-context.ts';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';

function session(
  roles: OperatorSessionContext['roles'],
  tenantId = TENANT_A,
): OperatorSessionContext {
  return { authenticated: true, tenantId, principalId: 'operator-a', roles };
}

function attentionBody(tenantId = TENANT_A) {
  return {
    tenant_id: tenantId,
    evaluated_at: '2027-01-15T08:00:00.000Z',
    quality: 'current',
    summary: { total: 1, critical: 0, overdue: 0, unowned: 0, stale: 0, assigned_to_me: 1 },
    coverage: [{ domain: 'decision', quality: 'current', candidate_count: 1 }],
    items: [
      {
        id: 'attention-1',
        title: 'Production release requires a governed decision',
        domain: 'decision',
        severity: 'high',
        impact: 'material',
        time_posture: 'due',
        owner_posture: 'assigned_to_me',
        freshness: 'current',
        observed_at: '2027-01-15T07:00:00.000Z',
        safe_next_action: { label: 'Review decision', href: '/v1/decisions/decision-1' },
        ranking: { factors: [{ label: 'Impact', value: 'material' }] },
        sources: [
          {
            domain: 'decision',
            record_type: 'decision_request',
            record_id: 'decision-1',
            record_version: '4',
            href: '/v1/decisions/decision-1',
            observed_at: '2027-01-15T07:00:00.000Z',
            source_owner_id: 'owner-a',
            resolved: false,
          },
        ],
      },
    ],
  };
}

function casesBody(tenantId = TENANT_A) {
  return { tenant_id: tenantId, observed_at: '2027-01-15T08:00:00.000Z', items: [] };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('role-scoped command-center loading', () => {
  it('issues no command-center request for platform-admin-only scope', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const user = session(['platform_admin']);
    const state = await loadOperationsWorkspace(user, operationsWorkspaceCapabilities(user));
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.attention.available).toBe(false);
  });

  it('loads both tenant-scoped resources with no-store and preserves the urgent summary', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.cache).toBe('no-store');
      return url.includes('/attention') ? json(attentionBody()) : json(casesBody());
    });
    vi.stubGlobal('fetch', fetcher);
    const user = session(['operator']);
    const state = await loadOperationsWorkspace(user, operationsWorkspaceCapabilities(user));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.attention.summary.assignedToMe).toBe(1);
    expect(state.attention.items[0]?.rankingFactors).toEqual([
      { label: 'Impact', value: 'material' },
    ]);
    expect(state.cases.available).toBe(true);
  });

  it('serializes only allowlisted queue filters and keeps the urgent summary unfiltered', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.includes('/attention') ? json(attentionBody()) : json(casesBody()),
    );
    vi.stubGlobal('fetch', fetcher);
    const user = session(['operator']);
    const filters = parseOperationsWorkspaceFilters({
      domain: 'decision',
      severity: 'critical',
      ownership: 'assigned_to_me',
      time_posture: 'breached',
      freshness: 'stale',
      assignment: 'mine',
      cursor: 'must-not-cross-the-boundary',
    });
    const state = await loadOperationsWorkspace(
      user,
      operationsWorkspaceCapabilities(user),
      filters,
    );
    const attentionUrl = String(
      fetcher.mock.calls.find(([url]) => String(url).includes('/attention'))?.[0],
    );
    expect(attentionUrl).toContain('domain=decision');
    expect(attentionUrl).toContain('severity=critical');
    expect(attentionUrl).toContain('assignment=mine');
    expect(attentionUrl).not.toContain('cursor=');
    expect(state.attention.summary.total).toBe(1);
    expect(
      parseOperationsWorkspaceFilters({ severity: 'root', assignment: ['mine', 'any'] }),
    ).toEqual({ assignment: 'mine' });
  });

  it('invalidates a prior-tenant response instead of displaying it under a new session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/attention') ? json(attentionBody(TENANT_A)) : json(casesBody(TENANT_A)),
      ),
    );
    const user = session(['operator'], TENANT_B);
    const state = await loadOperationsWorkspace(user, operationsWorkspaceCapabilities(user));
    expect(state.attention.available).toBe(false);
    expect(state.cases.available).toBe(false);
    expect(state.attention.diagnostic).toBe('invalid_attention_response');
  });

  it('keeps auditor presentation read-only while granting evidence-aware reads', () => {
    const user = session(['auditor']);
    expect(operationsWorkspaceCapabilities(user)).toMatchObject({
      canRead: true,
      canCreateCases: false,
      canTransitionCases: false,
      canVerifyCases: false,
      readOnly: true,
    });
  });
});
