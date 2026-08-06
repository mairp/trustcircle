import { describe, expect, it, vi } from 'vitest';

import { POST } from '../../apps/web/src/app/api/product-analytics/route.ts';

describe('product analytics route', () => {
  it('accepts only aggregate allowlisted metadata', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body: JSON.stringify({ event: 'page_view', route: '/inventory' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(log).toHaveBeenCalledWith('trustcircle_product_analytics', {
      event: 'page_view',
      route: '/inventory',
    });
    log.mockRestore();
  });

  it('rejects query text or governed content before logging', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body: JSON.stringify({
          event: 'search_outcome',
          route: '/search',
          resultCount: 1,
          query: 'protected evidence',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ accepted: false, code: 'unknown_field' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
