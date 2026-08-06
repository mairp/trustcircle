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

  it('accepts only bounded aggregate experience measures needed by the roadmap', () => {
    for (const event of [
      'time_to_find',
      'time_to_acknowledge',
      'time_to_resolve',
      'workflow_abandoned',
      'workspace_adoption',
    ] as const) {
      expect(
        validateProductAnalyticsEvent({
          event,
          route: '/operations',
          durationBucket: '1m-5m',
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it('rejects direct identifiers, arbitrary content, evidence bodies, and secret-shaped fields', () => {
    for (const prohibited of [
      { principalId: 'person-1' },
      { query: 'find the production incident' },
      { evidenceBody: 'raw evidence' },
      { secret: 'token-value' },
      { recordId: '018f0000-0000-7000-8000-000000000020' },
    ]) {
      expect(
        validateProductAnalyticsEvent({
          event: 'time_to_find',
          route: '/operations',
          durationBucket: '10s-60s',
          ...prohibited,
        }),
      ).toMatchObject({ ok: false });
    }
  });

  it('requires the right aggregate dimension for timed, abandonment, and search measures', () => {
    expect(
      validateProductAnalyticsEvent({ event: 'time_to_acknowledge', route: '/operations' }),
    ).toMatchObject({ ok: false });
    expect(
      validateProductAnalyticsEvent({
        event: 'workflow_abandoned',
        route: '/operations',
        resultCount: 2,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateProductAnalyticsEvent({
        event: 'search_outcome',
        route: '/search',
        resultCount: 0,
        durationBucket: 'under-10s',
      }),
    ).toMatchObject({ ok: true });
  });
});
