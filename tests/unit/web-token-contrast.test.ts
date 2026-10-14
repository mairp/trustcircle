import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Token contrast matrix for the operator console. Reads the colour tokens straight from the shipped
// stylesheet, for both themes, and asserts the WCAG 2.2 ratios every pairing the UI uses must meet:
// 4.5:1 for text (1.4.3) and 3:1 for form-control borders (1.4.11). axe cannot check token pairs that
// are not on the page at scan time, so this catches a regression in any theme before it ships.

const css = readFileSync(join(process.cwd(), 'apps/web/public/console.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    tokens[match[1]!] = match[2]!.toLowerCase();
  }
  return tokens;
}

const light = block(':root');
const dark = { ...light, ...block("[data-theme='dark']") };

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ['bg', 'panel', 'panel-2', 'panel-3'] as const;
const TEXT_PAIRS: readonly [string, string][] = [
  ...(['text', 'muted', 'quiet', 'accent-strong'] as const).flatMap((fg) =>
    SURFACES.map((bg) => [fg, bg] as [string, string]),
  ),
  ['accent-strong', 'accent-soft'],
  ['attention', 'attention-soft'],
  ['danger', 'danger-soft'],
  ['on-accent', 'accent-strong'],
];
const BORDER_PAIRS: readonly [string, string][] = SURFACES.map((bg) => ['border-control', bg]);

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme token contrast', (_theme, tokens) => {
  it.each(TEXT_PAIRS)('text %s on %s is at least 4.5:1', (fg, bg) => {
    expect(tokens[fg], `--${fg} defined`).toMatch(/^#/);
    expect(tokens[bg], `--${bg} defined`).toMatch(/^#/);
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(BORDER_PAIRS)('control border %s on %s is at least 3:1', (fg, bg) => {
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(3);
  });
});
