import { describe, expect, it } from 'vitest';

import { classifyFailure, safeNextAction } from '../../apps/web/src/lib/safe-error.ts';

describe('fail-visible classification', () => {
  it('keeps denial, timeout and upstream failure distinct', () => {
    expect(classifyFailure(undefined, 403)).toBe('forbidden');
    expect(classifyFailure(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(classifyFailure(undefined, 503)).toBe('upstream_unavailable');
    expect(safeNextAction('upstream_unavailable')).not.toMatch(/success|healthy|complete/i);
  });
});
