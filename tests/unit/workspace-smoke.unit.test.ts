// Unit-suite smoke test — proves the Vitest `unit` project discovers and executes .test.ts
// files (task T004 / GAR-010). This keeps the `unit` project non-vacuous so
// `vitest run --project unit` is genuinely observable rather than an empty pass.

import { describe, it, expect } from 'vitest';

describe('vitest unit project', () => {
  it('discovers and runs TypeScript tests under tests/unit', () => {
    expect(1 + 1).toBe(2);
  });

  it('runs with node environment globals available', () => {
    expect(typeof process.versions.node).toBe('string');
  });
});
