import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('web-only rollback contract', () => {
  const plan = readFileSync('specs/c00a3659-463d-44fb-96c0-f5f3efab97d8/rollback.md', 'utf8');
  const fallback = readFileSync('deploy/compose/web-server.mjs', 'utf8');

  it('preserves API, stores, volumes, evidence and adjacent stacks', () => {
    expect(plan).toMatch(/API\s+routing/i);
    for (const invariant of ['volumes', 'evidence', 'adjacent stacks', 'unrelated worktree'])
      expect(plan).toContain(invariant);
  });

  it('retains the dependency-free fail-visible JSON fallback', () => {
    expect(fallback).toContain('/v1/readiness');
    expect(fallback).toContain('/healthz');
    expect(fallback).toContain("'content-type': 'application/json'");
  });
});
