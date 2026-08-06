import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('web presentation security', () => {
  it('ships strict browser headers without unsafe CSP concessions', () => {
    const config = readFileSync('apps/web/next.config.mjs', 'utf8');
    const proxy = readFileSync('apps/web/src/proxy.ts', 'utf8');
    expect(config).toContain('X-Frame-Options');
    expect(proxy).toContain('Content-Security-Policy');
    expect(proxy).toContain("frame-ancestors 'none'");
    expect(proxy).toContain("'strict-dynamic'");
    expect(proxy).toContain("'nonce-${nonce}'");
    expect(proxy).not.toContain("'unsafe-inline'");
    expect(proxy).not.toContain("'unsafe-eval'");
  });

  it('does not serialize credential values from session context', () => {
    const page = readFileSync('apps/web/src/app/page.tsx', 'utf8');
    expect(page).not.toMatch(/authorization|cookie|token/i);
  });
});
