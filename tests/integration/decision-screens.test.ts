import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Live decision screens (/decisions, /decisions/[decisionId]) rendered by the production web build
// against a stub decision API: queue ordering, separation-of-duties explanations, role-gated action
// forms bound to the package ETag, and fail-visible states for unknown and unversioned decisions.

const webPort = 18127;
const apiPort = 18128;
const tenantId = '00000000-0000-4000-8000-000000000001';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const OPEN_ID = '11111111-1111-4111-8111-111111111111';
const CLOSED_ID = '11111111-1111-4111-8111-222222222222';
const UNVERSIONED_ID = '11111111-1111-4111-8111-333333333333';
const requests: string[] = [];
let api: Server;
let web: ChildProcess;

const decision = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  tenant_id: tenantId,
  work_item_id: '44444444-4444-4444-8444-444444444444',
  requester_principal_id: REQUESTER,
  requested_action: 'Promote fraud model v7 to production',
  action_class: 'deployment',
  risk_tier: 'high',
  scope: { asset: 'fraud-model' },
  business_impact: { customers: 'all card payments' },
  risks: [{ risk: 'false declines rise for new merchants' }],
  alternatives: [{ option: 'shadow mode for two weeks' }],
  expected_result: { metric: 'fraud loss -12%' },
  status: 'pending',
  version: 3,
  created_at: '2026-10-14T09:00:00Z',
  expires_at: '2099-01-01T00:00:00Z',
  requirements: [
    {
      id: 'r1',
      gate_type: 'risk_acceptance',
      tenant_id: null,
      status: 'pending',
      minimum_distinct_principals: 2,
    },
  ],
  ...overrides,
});

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // The disposable production server has not bound yet; retry within the fixed budget.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become ready: ${url}`);
}

const as = (principal: string, roles: string) => ({
  'x-trustcircle-principal': principal,
  'x-trustcircle-tenant-id': tenantId,
  'x-trustcircle-tenant-name': 'Integration tenant',
  'x-trustcircle-roles': roles,
});

async function page(path: string, principal: string, roles: string) {
  const response = await fetch(`http://127.0.0.1:${webPort}${path}`, {
    headers: as(principal, roles),
  });
  return { status: response.status, html: await response.text() };
}

beforeAll(async () => {
  api = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    };
    if (path.startsWith('/v1/decisions?')) {
      return json(200, {
        items: [
          decision(CLOSED_ID, {
            status: 'approved',
            requested_action: 'Retire legacy scoring rules',
          }),
          decision(OPEN_ID),
          { id: 'broken-row' },
        ],
        metadata: {
          generated_at: '2026-10-15T00:00:00Z',
          source_cursor: 'c1',
          freshness: 'current',
          partial_coverage: false,
          next_cursor: null,
        },
      });
    }
    if (path === `/v1/decisions/${OPEN_ID}`) return json(200, decision(OPEN_ID), { etag: '"v3"' });
    if (path === `/v1/decisions/${UNVERSIONED_ID}`) return json(200, decision(UNVERSIONED_ID));
    if (path.startsWith('/v1/decisions/')) {
      return json(404, { type: 'about:blank', title: 'Not Found', status: 404 });
    }
    return json(200, { items: [], records: [], quality: 'current', tenant_id: tenantId });
  });
  await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
  web = spawn('npm', ['run', 'start', '--workspace', '@trustcircle/web'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(webPort),
      TRUST_IDENTITY_HEADERS: 'true',
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    },
    stdio: 'ignore',
    // Own process group: `npm start` forks the Next server, and killing only npm would orphan it
    // on the port, so a later run would silently test a stale build.
    detached: true,
  });
  await waitFor(`http://127.0.0.1:${webPort}/healthz`);
}, 30_000);

afterAll(async () => {
  if (web.pid !== undefined) process.kill(-web.pid, 'SIGTERM');
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe('decision inbox (/decisions)', () => {
  it('lists open decisions before closed ones, links each to its package, and flags unreadable rows', async () => {
    const { status, html } = await page(
      '/decisions?status=pending&assigned=me',
      'approver-1',
      'authorized_approver',
    );
    expect(status).toBe(200);
    expect(requests).toContain('/v1/decisions?limit=100&status=pending&assigned_to_me=true');
    expect(html).toContain('Decision inbox');
    expect(html).toContain(`href="/decisions/${OPEN_ID}"`);
    expect(html.indexOf('Promote fraud model v7')).toBeLessThan(
      html.indexOf('Retire legacy scoring rules'),
    );
    expect(html).toContain('Awaiting your decision');
    expect(html).toContain('1 decision could not be read');
  });

  it('is not offered to a role without decision visibility', async () => {
    const { status } = await page('/decisions', 'admin-1', 'platform_admin');
    expect(status).toBe(404);
  });
});

describe('decision package (/decisions/[id])', () => {
  it('offers reasoned action forms bound to the package ETag to an authorized reviewer', async () => {
    const { status, html } = await page(
      `/decisions/${OPEN_ID}`,
      'approver-1',
      'authorized_approver',
    );
    expect(status).toBe(200);
    expect(html).toContain('Needs 2 different approvers');
    expect(html).toContain('false declines rise for new merchants');
    expect(html).toContain('Approve decision');
    expect(html).toContain('Deny decision');
    expect(html).toContain('Delegate decision');
    expect(html).toMatch(
      /name="etag"[^>]*value="&quot;v3&quot;"|value="&quot;v3&quot;"[^>]*name="etag"/,
    );
    expect(html).toContain('<a href="/decisions">Decisions</a>');
  });

  it('refuses self-approval with an explanation, offering only withdrawal', async () => {
    const { html } = await page(`/decisions/${OPEN_ID}`, REQUESTER, 'authorized_approver');
    expect(html).toContain('Separation of duties requires a different person');
    expect(html).not.toContain('Approve decision');
    expect(html).toContain('Withdraw request');
  });

  it('shows auditors the package read-only', async () => {
    const { html } = await page(`/decisions/${OPEN_ID}`, 'auditor-1', 'auditor');
    expect(html).toContain('holds no decision authority');
    expect(html).not.toContain('<form');
  });

  it('shows the recorded outcome or the refusal returned by the action', async () => {
    const ok = await page(
      `/decisions/${OPEN_ID}?outcome=approve`,
      'approver-1',
      'authorized_approver',
    );
    expect(ok.html).toContain('Approved.');
    const refused = await page(
      `/decisions/${OPEN_ID}?error=${encodeURIComponent('Someone acted on this decision after you opened it.')}`,
      'approver-1',
      'authorized_approver',
    );
    expect(refused.html).toContain('Not recorded.');
    expect(refused.html).toContain('Someone acted on this decision after you opened it.');
  });

  it('offers no action when the decision cannot be read with a version, and 404s unknown ids', async () => {
    const unversioned = await page(
      `/decisions/${UNVERSIONED_ID}`,
      'approver-1',
      'authorized_approver',
    );
    expect(unversioned.html).toContain('The decision could not be read.');
    expect(unversioned.html).not.toContain('Approve decision');
    const missing = await page(
      '/decisions/99999999-9999-4999-8999-999999999999',
      'approver-1',
      'authorized_approver',
    );
    expect(missing.status).toBe(404);
    expect((await page('/decisions/not-a-uuid', 'approver-1', 'authorized_approver')).status).toBe(
      404,
    );
  });
});
