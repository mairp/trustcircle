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
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ accepted: false, code: 'unknown_field' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('rejects an oversized body by actual UTF-8 bytes when Content-Length is absent', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body: JSON.stringify({
          event: 'page_view',
          route: '/inventory',
          padding: 'é'.repeat(1100),
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      accepted: false,
      code: 'payload_too_large',
    });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('does not trust a false short Content-Length header', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body: JSON.stringify({
          event: 'page_view',
          route: '/inventory',
          padding: 'x'.repeat(2100),
        }),
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
        },
      }),
    );
    expect(response.status).toBe(413);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('requires the JSON media type before parsing or logging', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body: JSON.stringify({ event: 'page_view', route: '/inventory' }),
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      accepted: false,
      code: 'unsupported_media_type',
    });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('rejects a false short Content-Length even when the actual body stays under the limit', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const body = JSON.stringify({ event: 'page_view', route: '/inventory' });
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'content-length': '2',
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      accepted: false,
      code: 'content_length_mismatch',
    });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('honors the explicit analytics disable header before reading or logging content', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await POST(
      new Request('http://localhost/api/product-analytics', {
        method: 'POST',
        body: 'not-json',
        headers: {
          'content-type': 'text/plain',
          'x-trustcircle-product-analytics': 'disabled',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
