import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as health } from '../../apps/web/src/app/healthz/route.ts';
import { GET as readiness } from '../../apps/web/src/app/readiness/route.ts';

afterEach(() => vi.unstubAllGlobals());

describe('web runtime probes', () => {
  it('reports independent liveness and no authority', async () => {
    const response = health();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'web',
      authority: 'none',
      status: 'alive',
    });
  });

  it('preserves API non-readiness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { apiVersion: 1, ready: false, lifecycle: 'ready', degradedFacets: ['ownership'] },
          { status: 503 },
        ),
      ),
    );
    const response = await readiness();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'degraded', authority: 'none' });
  });

  it('rejects malformed or incompatible readiness as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
    );
    expect((await readiness()).status).toBe(503);
  });
});
