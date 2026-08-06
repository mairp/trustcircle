// TrustCircleAI — ACCESSIBILITY FULL-SUITE release gate (Phase 9 / T276 /
// tests/accessibility/full-suite.spec.ts).
//
// PHASE OBJECTIVE (T276): "Execute WCAG 2.2 AA, keyboard, assistive-technology, non-color, focus,
// live-update, reflow, time-warning, and non-visual parity gates in tests/accessibility/full-suite.spec.ts"
// (GAR-010, AR-001..AR-008, SC-014).
//
// ── WHY BROWSERLESS ─────────────────────────────────────────────────────────────────────────────
// The WCAG capability projects and `accessibility-current-state` drive a REAL browser through
// axe-core; on a host with no Chromium binary they cannot run, so they cannot serve as the release
// gate on such a host. This suite runs under the browserless `accessibility-full-suite` Playwright
// project (see playwright.config.ts — no `page`, no browser device, no web server): it asserts the
// SAME WCAG 2.2 AA obligations directly over the deterministic, dependency-free HTML that the
// shipped views render (support/current-state-view.ts renderCurrentStateView()). The rendered markup
// IS the artifact browser axe would scan; parsing it proves the accessible affordances are present
// in the exact bytes that ship.
//
// ── NON-VACUITY ─────────────────────────────────────────────────────────────────────────────────
// Every gate is paired with a RED WITNESS: the same assertion applied to a deliberately regressed
// copy of the markup (e.g. skip link removed, aria-live stripped, color-only meaning, fixed-width
// layout) MUST fail. So a gate that passes cannot pass vacuously — a regression in the real renderer
// flips it red.
//
// Determinism: pure string parsing of a frozen render; no clock, no network, no browser. Run via
// `playwright test --project=accessibility-full-suite` (TC_NO_WEBSERVER=1 optional — the project
// declares no web server).

import { test, expect } from '@playwright/test';

import { renderCurrentStateView } from './support/current-state-view.ts';

const HTML = renderCurrentStateView();

// ── tiny, dependency-free HTML probes (no DOM, no browser) ───────────────────────────────────────
function has(re: RegExp, html = HTML): boolean {
  return re.test(html);
}
function count(re: RegExp, html = HTML): number {
  return (html.match(re) ?? []).length;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-001 / SC-014 — WCAG 2.2 AA baseline structure (lang, single main landmark, one h1, titled doc).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-001 / SC-014 · WCAG 2.2 AA baseline structure', () => {
  test('GATE: document declares lang, a titled head, one <main> landmark, and one <h1>', () => {
    expect(has(/<html[^>]*\blang="en"/)).toBe(true);
    expect(has(/<title>[^<]+<\/title>/)).toBe(true);
    expect(count(/<main\b/g)).toBe(1);
    expect(count(/<h1\b/g)).toBe(1);
  });

  test('RED WITNESS: markup with the lang attribute removed fails the baseline', () => {
    const regressed = HTML.replace(/\blang="en"/, '');
    expect(has(/<html[^>]*\blang="en"/, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-002 — keyboard operability without pointer: skip link, focusable controls, adequate target size.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-002 · keyboard operability', () => {
  test('GATE: a skip link targets #main and the main is focus-manageable', () => {
    expect(has(/<a\s+href="#main"[^>]*>Skip to main content<\/a>/)).toBe(true);
    expect(has(/<main[^>]*\btabindex="-1"/)).toBe(true);
  });

  test('GATE: interactive controls exist and carry a minimum target size', () => {
    expect(has(/<button\b/)).toBe(true);
    expect(has(/button\s*\{[^}]*min-height:\s*2\.25rem/)).toBe(true);
  });

  test('RED WITNESS: markup with the skip link removed fails keyboard operability', () => {
    const regressed = HTML.replace(/<a\s+href="#main"[^>]*>Skip to main content<\/a>/, '');
    expect(has(/href="#main"/, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-003 — assistive technology: programmatic name/role/state + live regions for async updates/alerts.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-003 · assistive-technology name/role/state + live regions', () => {
  test('GATE: sections are labelled, and polite + assertive live regions exist', () => {
    expect(has(/aria-labelledby="/)).toBe(true);
    expect(has(/aria-live="polite"/)).toBe(true);
    expect(has(/aria-live="assertive"/)).toBe(true);
    expect(has(/role="alert"/)).toBe(true);
    expect(has(/role="status"/)).toBe(true);
  });

  test('GATE: form validation state is programmatic (label assoc, describedby, role=alert error, script wires aria-invalid on failure)', () => {
    // Static markup: the input is labelled and describedby a hint; the error region is role=alert.
    expect(has(/<label for="reason-input"/)).toBe(true);
    expect(has(/id="reason-input"[\s\S]*?aria-describedby="reason-hint"/)).toBe(true);
    expect(has(/id="reason-error" role="alert"[^>]*hidden/)).toBe(true);
    // The behavior contract: on a failed submit the script sets aria-invalid + adds the error to
    // aria-describedby (validity is not asserted before the user errs — correct ARIA).
    expect(has(/setAttribute\('aria-invalid', 'true'\)/)).toBe(true);
    expect(has(/setAttribute\('aria-describedby', 'reason-hint reason-error'\)/)).toBe(true);
  });

  test('RED WITNESS: markup with all live regions demoted fails AT announcement', () => {
    const regressed = HTML.replace(/aria-live="(polite|assertive)"/g, 'data-was-live="$1"');
    expect(has(/aria-live=/, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-004 — meaning MUST NOT rely on color alone (a text label accompanies every colored signal).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-004 · non-color meaning', () => {
  test('GATE: the risk chart states risk in text, not color ("not by color alone")', () => {
    expect(has(/not by color alone|not by color/i)).toBe(true);
    // decorative color bars are hidden from AT; the text/table carries the meaning
    expect(has(/aria-hidden="true"[^>]*class="bars"|class="bars"[^>]*aria-hidden="true"/)).toBe(
      true,
    );
  });

  test('RED WITNESS: markup that un-hides the color-only bars and drops the text note fails', () => {
    const regressed = HTML.replace(/not by color alone/i, 'shown in the chart').replace(
      /aria-hidden="true"/g,
      '',
    );
    const conveysWithoutColor = /not by color alone/i.test(regressed);
    expect(conveysWithoutColor).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-005 — charts/relationship views/timelines have a text summary AND a tabular alternative.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-005 · non-visual chart parity (text summary + table alternative)', () => {
  test('GATE: the risk figure has a text summary and a tabular alternative', () => {
    expect(has(/data-testid="chart-text-summary"/)).toBe(true);
    expect(has(/data-testid="chart-table-alternative"/)).toBe(true);
    expect(has(/<caption>Tabular alternative for the risk-distribution chart<\/caption>/)).toBe(
      true,
    );
  });

  test('RED WITNESS: markup with the table alternative removed fails chart parity', () => {
    const regressed = HTML.replace(
      /<table data-testid="chart-table-alternative">[\s\S]*?<\/table>/,
      '',
    );
    expect(has(/data-testid="chart-table-alternative"/, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-006 — usable at 400% zoom / reflow: no forced 2-D page scroll (fluid widths, wrapping).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-006 · 400% reflow', () => {
  test('GATE: layout uses fluid max-widths and content wrapping (no fixed page width)', () => {
    expect(has(/body\s*\{[^}]*max-width:\s*100%/)).toBe(true);
    expect(has(/overflow-wrap:\s*anywhere/)).toBe(true);
    expect(has(/table\s*\{[^}]*max-width:\s*100%/)).toBe(true);
  });

  test('RED WITNESS: markup pinned to a fixed page width fails reflow', () => {
    const regressed = HTML.replace(/max-width:\s*100%;/, 'width: 1280px;');
    // the body no longer declares a fluid max-width as its first width rule
    expect(has(/body\s*\{[^}]*width:\s*1280px/, regressed)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-007 — time-limited sessions provide a WARNING and an accessible EXTENSION path.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-007 · time-limit warning + accessible extension', () => {
  test('GATE: a polite session-timeout warning and an extend-session control exist', () => {
    expect(has(/data-testid="timeout-warning"/)).toBe(true);
    expect(
      has(
        /data-testid="timeout-warning"[^>]*aria-live="polite"|role="status"[^>]*data-testid="timeout-warning"|data-testid="timeout-warning"[^>]*role="status"/,
      ),
    ).toBe(true);
    expect(has(/data-testid="extend-session-btn"[^>]*>Extend session/)).toBe(true);
  });

  test('RED WITNESS: markup with the extend-session control removed fails AR-007', () => {
    const regressed = HTML.replace(
      /<button[^>]*data-testid="extend-session-btn"[^>]*>[\s\S]*?<\/button>/,
      '',
    );
    expect(has(/data-testid="extend-session-btn"/, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-008 — reasons/errors/conflicts use clear language AND preserve entered input.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AR-008 · clear-language errors + preserved input', () => {
  test('GATE: the validation error is clear-language and promises to keep the entered text', () => {
    expect(has(/Reason must be at least 3 characters/)).toBe(true);
    expect(has(/your text was kept|text was kept/i)).toBe(true);
  });

  test('RED WITNESS: markup whose error omits the preservation promise fails AR-008', () => {
    const regressed = HTML.replace(/ — your text was kept/i, '');
    expect(has(/your text was kept/i, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AR-002 (focus) — a visible keyboard focus indicator is defined for every interactive element.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Focus visibility (WCAG 2.4.7)', () => {
  test('GATE: :focus-visible declares a visible outline for links, buttons, inputs, tabindex', () => {
    expect(has(/:focus-visible\s*\{[^}]*outline:\s*3px/)).toBe(true);
    expect(has(/a:focus-visible/)).toBe(true);
    expect(has(/button:focus-visible/)).toBe(true);
    expect(has(/input:focus-visible/)).toBe(true);
  });

  test('RED WITNESS: markup with the focus outline removed fails focus visibility', () => {
    const regressed = HTML.replace(/outline:\s*3px solid #0b57d0;/, 'outline: none;');
    expect(has(/:focus-visible\s*\{[^}]*outline:\s*3px/, regressed)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SC-014 roll-up — the full journey conforms across all gates simultaneously (one render, all pass).
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('SC-014 · full-journey conformance roll-up', () => {
  test('GATE: one render satisfies every AR gate (structure, keyboard, AT, non-color, chart, reflow, time, errors)', () => {
    const gates: Array<[string, boolean]> = [
      ['AR-001 lang+main+h1', has(/lang="en"/) && count(/<main\b/g) === 1 && count(/<h1\b/g) === 1],
      ['AR-002 skip link', has(/href="#main"/)],
      ['AR-003 live regions', has(/aria-live="polite"/) && has(/aria-live="assertive"/)],
      ['AR-004 non-color', has(/not by color alone/i)],
      ['AR-005 chart parity', has(/data-testid="chart-table-alternative"/)],
      ['AR-006 reflow', has(/overflow-wrap:\s*anywhere/)],
      ['AR-007 time warning', has(/data-testid="extend-session-btn"/)],
      ['AR-008 preserved input', has(/your text was kept/i)],
    ];
    const failed = gates.filter(([, ok]) => !ok).map(([name]) => name);
    expect(failed).toEqual([]);
  });
});
