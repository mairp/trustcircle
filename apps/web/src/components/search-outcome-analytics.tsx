'use client';

import { useEffect } from 'react';

export function SearchOutcomeAnalytics({ resultCount }: { readonly resultCount: number }) {
  useEffect(() => {
    const payload = JSON.stringify({
      event: 'search_outcome',
      route: '/search',
      resultCount,
      durationBucket: 'under-10s',
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        '/api/product-analytics',
        new Blob([payload], { type: 'application/json' }),
      );
    } else {
      void fetch('/api/product-analytics', {
        method: 'POST',
        body: payload,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
      });
    }
  }, [resultCount]);
  return null;
}
