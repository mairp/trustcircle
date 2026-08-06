import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('operator console action boundary', () => {
  it('root composition contains no mutation or server action', () => {
    const source = readFileSync('apps/web/src/app/page.tsx', 'utf8');
    expect(source).not.toMatch(/\bPOST\b|use server|server action|<form/i);
  });
});
