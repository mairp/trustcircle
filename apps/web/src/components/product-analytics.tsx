'use client';

import { useEffect, useRef, useState } from 'react';

import {
  durationBucket,
  routeFamily,
  type ProductAnalyticsEvent,
} from '../lib/product-analytics.ts';

function emit(event: ProductAnalyticsEvent): void {
  const payload = JSON.stringify(event);
  if (navigator.sendBeacon) {
    navigator.sendBeacon(
      '/api/product-analytics',
      new Blob([payload], { type: 'application/json' }),
    );
    return;
  }
  void fetch('/api/product-analytics', {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    keepalive: true,
  });
}

export function ProductAnalytics({
  route,
  resultCount,
}: {
  readonly route: string;
  readonly resultCount?: number;
}) {
  const startedAt = useRef(Date.now());
  const [message, setMessage] = useState('');
  const family = routeFamily(route);
  useEffect(() => {
    emit({ event: 'page_view', route: family });
    if (resultCount !== undefined) {
      emit({
        event: 'search_outcome',
        route: family,
        resultCount,
        durationBucket: durationBucket(Date.now() - startedAt.current),
      });
    }
  }, [family, resultCount]);
  function feedback(value: 'helpful' | 'not_helpful') {
    emit({
      event: 'workflow_feedback',
      route: family,
      feedback: value,
      durationBucket: durationBucket(Date.now() - startedAt.current),
    });
    setMessage('Feedback recorded without governed record content.');
  }
  return (
    <aside className="workflow-feedback" aria-labelledby="workflow-feedback-title">
      <div>
        <strong id="workflow-feedback-title">Was this workspace useful?</strong>
        <span>
          TrustCircle records only aggregate workflow feedback—never evidence or query text.
        </span>
      </div>
      <div>
        <button type="button" onClick={() => feedback('helpful')}>
          Helpful
        </button>
        <button type="button" onClick={() => feedback('not_helpful')}>
          Needs improvement
        </button>
      </div>
      {message ? <span role="status">{message}</span> : null}
    </aside>
  );
}
