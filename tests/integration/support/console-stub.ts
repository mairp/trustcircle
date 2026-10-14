import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// A stub of the governance API with one plausible record per domain, decisions with ETags, an
// evidence request, and evidence-package endpoints, plus a launcher for the production web build
// pointed at it. Shared by the browser-free route tests and the live accessibility suite so both
// exercise the same pages with the same data.

export const STUB_TENANT = '00000000-0000-4000-8000-000000000001';
export const STUB_DECISION = '11111111-1111-4111-8111-111111111111';
export const STUB_PACKAGE = '33333333-3333-4333-8333-333333333333';
export const STUB_EVIDENCE_REQUEST = '44444444-4444-4444-8444-444444444444';

const FUTURE = '2099-01-01T00:00:00.000Z';
const OBSERVED = '2026-10-15T08:00:00.000Z';

export const STUB_RECORDS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  posture: [{ domain: 'inventory', record_count: 1 }],
  inventory: [
    {
      assetId: 'ASSET-PAY-1',
      name: 'Payments fraud model',
      assetType: 'ai_service',
      ownerPrincipalId: 'owner-7',
      lifecycleState: 'active',
      riskTier: 'high',
      coverage: 'governed',
      reportedHealth: 'healthy',
      evidenceState: 'current',
    },
  ],
  gaps: [{ sourceId: 'src-kanban', sourceClass: 'work_tracking', onboardingState: 'partial' }],
  integrity: [{ id: 'case-17', problemClass: 'stale_evidence', status: 'open' }],
  controllers: [{ id: 'ctl-3', name: 'Model drift guard', status: 'active' }],
  compliance: [{ id: 'iso42001-a6', exact_title: 'AI system life cycle', record_type: 'control' }],
  evidence: [{ evidence_item_id: 'ev-9', title: 'Model card v7', quality_status: 'current' }],
  integrations: [{ id: 'conn-1', adapterKey: 'kanban', health: 'healthy' }],
  operations: [{ component_key: 'api', health: 'healthy' }],
};

const decision = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  tenant_id: STUB_TENANT,
  work_item_id: '55555555-5555-4555-8555-555555555555',
  requester_principal_id: '22222222-2222-4222-8222-222222222222',
  requested_action: 'Promote fraud model v7 to production',
  requestedAction: 'Promote fraud model v7 to production',
  action_class: 'deployment',
  risk_tier: 'high',
  scope: { asset: 'fraud-model' },
  business_impact: { customers: 'all card payments' },
  risks: [{ risk: 'false declines' }],
  alternatives: [{ option: 'shadow mode' }],
  expected_result: { metric: 'fraud loss -12%' },
  status: 'pending',
  version: 3,
  created_at: OBSERVED,
  expires_at: FUTURE,
  requirements: [
    { id: 'r1', gate_type: 'risk_acceptance', status: 'pending', minimum_distinct_principals: 2 },
  ],
  ...overrides,
});

function domainFor(path: string): string {
  if (path.includes('governance-officer')) return 'posture';
  if (path.includes('inventory/assets')) return 'inventory';
  if (path.includes('inventory/sources')) return 'gaps';
  if (path.includes('integrity-cases')) return 'integrity';
  if (path.includes('controllers')) return 'controllers';
  if (path.includes('compliance')) return 'compliance';
  if (path.includes('dashboards/auditor')) return 'evidence';
  if (path.includes('connectors')) return 'integrations';
  return 'operations';
}

export interface ConsoleStub {
  readonly requests: { method: string; path: string }[];
  close(): Promise<void>;
}

export async function startConsoleStub(port: number): Promise<ConsoleStub> {
  const requests: { method: string; path: string }[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '';
    const method = request.method ?? 'GET';
    requests.push({ method, path });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    if (method === 'POST' && /^\/v1\/evidence-packages\/[0-9a-f-]{36}\/verify$/.test(path)) {
      return json(200, {
        package_id: path.split('/')[3],
        valid: true,
        reason: null,
        verified_at: OBSERVED,
        canonical_digest: 'a'.repeat(64),
      });
    }
    if (method === 'POST' && path === '/v1/evidence-packages') {
      return json(202, {
        operation_id: '66666666-6666-4666-8666-666666666666',
        status: 'accepted',
      });
    }
    if (path === '/v1/decisions' || path.startsWith('/v1/decisions?')) {
      const items = [decision(STUB_DECISION)];
      return json(200, {
        items,
        records: items,
        metadata: {
          generated_at: OBSERVED,
          freshness: 'current',
          partial_coverage: false,
          next_cursor: null,
        },
        quality: 'current',
        tenant_id: STUB_TENANT,
        observed_at: OBSERVED,
      });
    }
    if (path === `/v1/decisions/${STUB_DECISION}`) {
      return json(200, decision(STUB_DECISION), { etag: '"v3"' });
    }
    if (path.startsWith('/v1/decisions/')) return json(404, { status: 404, title: 'Not Found' });
    if (path === '/v1/evidence-requests') {
      return json(200, {
        items: [
          {
            id: STUB_EVIDENCE_REQUEST,
            tenant_id: STUB_TENANT,
            status: 'open',
            version: 2,
            owner_principal_id: 'owner-7',
            due_at: FUTURE,
            expires_at: FUTURE,
            requested_evidence_types: ['model_card', 'test_report'],
            scope: { asset_id: 'ASSET-PAY-1' },
          },
        ],
        metadata: { generated_at: OBSERVED, source_cursor: 'evidence-c1', freshness: 'current' },
        quality: 'current',
      });
    }
    const domain = domainFor(path);
    const records = STUB_RECORDS[domain] ?? [];
    return json(200, {
      apiVersion: 1,
      contractVersion: '1.0',
      tenant_id: STUB_TENANT,
      tenantId: STUB_TENANT,
      domain,
      observed_at: OBSERVED,
      observedAt: OBSERVED,
      source: `postgresql-read-model:${domain}`,
      quality: 'current',
      items: records,
      records,
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Start the production web build against the stub; the server gets its own process group. */
export async function startWeb(webPort: number, apiPort: number): Promise<ChildProcess> {
  const web = spawn('npm', ['run', 'start', '--workspace', '@trustcircle/web'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(webPort),
      TRUST_IDENTITY_HEADERS: 'true',
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    },
    stdio: 'ignore',
    detached: true,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${webPort}/healthz`)).status < 500) return web;
    } catch {
      // Not bound yet; retry within the budget.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stopWeb(web);
  throw new Error(`web server did not become ready on ${webPort}`);
}

export function stopWeb(web: ChildProcess | undefined): void {
  if (web?.pid !== undefined) {
    try {
      process.kill(-web.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

export function identityHeaders(principal: string, roles: string): Record<string, string> {
  return {
    'x-trustcircle-principal': principal,
    'x-trustcircle-tenant-id': STUB_TENANT,
    'x-trustcircle-tenant-name': 'Stub tenant',
    'x-trustcircle-roles': roles,
  };
}
