import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const webPort = 18123;
const tenantId = '00000000-0000-4000-8000-000000000001';
const requests: Array<{ method: string; path: string }> = [];
let api: Server;
let web: ChildProcess;

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

beforeAll(async () => {
  api = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push({ method: request.method ?? '', path });
    const domain = path.includes('governance-officer')
      ? 'posture'
      : path.includes('inventory/assets')
        ? 'inventory'
        : path.includes('inventory/sources')
          ? 'gaps'
          : path.includes('decisions')
            ? 'decisions'
            : path.includes('integrity-cases')
              ? 'integrity'
              : path.includes('controllers')
                ? 'controllers'
                : path.includes('compliance')
                  ? 'compliance'
                  : path.includes('auditor')
                    ? 'evidence'
                    : path.includes('connectors')
                      ? 'integrations'
                      : 'operations';
    const records =
      domain === 'posture'
        ? [{ domain: 'inventory', record_count: 1 }]
        : domain === 'inventory'
          ? [
              {
                assetId: 'ASSET-CANARY-A',
                name: 'Governed payments model',
                assetType: 'ai_service',
                ownerPrincipalId: 'control-owner-7',
                lifecycleState: 'active',
                riskTier: 'high',
                coverage: 'governed',
                reportedHealth: 'healthy',
                evidenceState: 'current',
                credential_ref: 'secret-token-must-not-render',
              },
            ]
          : [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        apiVersion: 1,
        contractVersion: '1.0',
        tenant_id: tenantId,
        tenantId,
        domain,
        observed_at: '2026-08-04T04:00:00.000Z',
        observedAt: '2026-08-04T04:00:00.000Z',
        source: `postgresql-read-model:${domain}`,
        quality: 'current',
        items: records,
        records,
      }),
    );
  });
  await new Promise<void>((resolve) => api.listen(18124, '127.0.0.1', resolve));
  web = spawn('npm', ['run', 'start', '--workspace', '@trustcircle/web'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOSTNAME: '127.0.0.1',
      PORT: String(webPort),
      TRUST_IDENTITY_HEADERS: 'true',
      API_BASE_URL: 'http://127.0.0.1:18124',
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

describe('production operator console root', () => {
  it('renders permitted live versioned reads as semantic tenant-scoped HTML with governed details', async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/`, {
      headers: {
        'x-trustcircle-principal': 'integration-operator',
        'x-trustcircle-tenant-id': tenantId,
        'x-trustcircle-tenant-name': 'Integration tenant',
        'x-trustcircle-roles': 'operator',
      },
    });
    const html = await response.text();
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<main');
    expect(html).toContain('Integration tenant');
    expect(html).toContain('Current governed scope');
    expect(html).toContain('Governed payments model');
    expect(html).toContain('ASSET-CANARY-A');
    expect(html).toContain('Control owner 7');
    expect(html).toContain('Posture by governed domain');
    expect(html).toContain('No human decision packages are currently registered');
    expect(html).toContain('postgresql-read-model:inventory');
    expect(html).not.toContain('secret-token-must-not-render');
    expect(html).not.toContain('credential_ref');
    expect(html).not.toContain('<form');
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) => request.method === 'GET' && request.path.startsWith('/v1/')),
    ).toBe(true);
  });

  it('fails closed without a verified session', async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Authentication required');
    expect(html).not.toContain('Integration tenant');
  });

  it('does not proxy arbitrary API paths from the web origin', async () => {
    const response = await fetch(`http://127.0.0.1:${webPort}/v1/readiness`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});
