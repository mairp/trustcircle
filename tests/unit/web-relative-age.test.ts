import { describe, expect, it } from 'vitest';

import { relativeAge } from '../../apps/web/src/lib/relative-age.ts';

describe('relativeAge', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');

  it('renders coarse, honest ages', () => {
    expect(relativeAge('2026-10-14T11:59:30Z', now)).toBe('just now');
    expect(relativeAge('2026-10-14T11:57:00Z', now)).toBe('3 min ago');
    expect(relativeAge('2026-10-14T06:00:00Z', now)).toBe('6 h ago');
    expect(relativeAge('2026-10-11T12:00:00Z', now)).toBe('3 d ago');
  });

  it('never invents an age for missing, invalid or future timestamps', () => {
    expect(relativeAge(undefined, now)).toBeUndefined();
    expect(relativeAge('not-a-date', now)).toBeUndefined();
    expect(relativeAge('2026-10-15T12:00:00Z', now)).toBe('in the future');
  });
});
