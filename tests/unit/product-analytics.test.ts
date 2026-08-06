import { describe, expect, it } from 'vitest';

import {
  validateProductAnalyticsEvent,
  type ProductAnalyticsEvent,
} from '../../apps/web/src/lib/product-analytics.ts';

describe('privacy-preserving product analytics', () => {
  it('accepts allowlisted aggregate workflow metrics', () => {
    expect(
      validateProductAnalyticsEvent({
        event: 'search_outcome',
        route: '/search',
        resultCount: 12,
        durationBucket: '10s-60s',
      }),
    ).toEqual({
      ok: true,
      event: {
        event: 'search_outcome',
        route: '/search',
        resultCount: 12,
        durationBucket: '10s-60s',
      } satisfies ProductAnalyticsEvent,
    });
  });

  it('rejects free text, record identifiers, evidence, and unknown fields', () => {
    expect(
      validateProductAnalyticsEvent({
        event: 'search_outcome',
        route: '/search',
        resultCount: 1,
        query: 'sensitive evidence body',
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateProductAnalyticsEvent({ event: 'page_view', route: '/assets/secret-record-id' }),
    ).toMatchObject({ ok: false });
    expect(
      validateProductAnalyticsEvent({ event: 'evidence_opened', route: '/evidence' }),
    ).toMatchObject({ ok: false });
  });

  it('bounds counts and accepts only disclosure-safe route families', () => {
    expect(
      validateProductAnalyticsEvent({ event: 'search_outcome', route: '/search', resultCount: -1 }),
    ).toMatchObject({ ok: false });
    expect(
      validateProductAnalyticsEvent({ event: 'page_view', route: '/inventory' }),
    ).toMatchObject({ ok: true });
  });
});
