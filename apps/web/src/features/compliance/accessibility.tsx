// TrustCircleAI — COMPLIANCE presenter ACCESSIBILITY + CLAIM-HONESTY ORACLE (Phase 7 /
// User Story 5 — Demonstrate Compliance and Audit Readiness / T211 companion /
// apps/web/src/features/compliance/accessibility.tsx / FR-031..035, FR-055, SC-012).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free ACCESSIBILITY + CLAIM-HONESTY oracle over the compliance presenters. The host
// has no Chromium, so the browser-driven axe-core scan in the e2e spec cannot run here; this oracle
// is the logic half that runs everywhere — it takes the SAME HTML strings the presenters emit and
// asserts, WITHOUT a browser, the structural WCAG/ARIA obligations a screen-reader user depends on
// AND the load-bearing CLAIM-HONESTY invariants that make the compliance UI truthful:
//
//   * WCAG 2.4.1 / 4.1.2 / 1.3.1 (structure). A full document, <html lang>, exactly one <h1>, a skip
//     link to #main, a labelled <main id=main tabindex=-1>, a role=status live region, a tenant-scope
//     banner, overflow-wrap:anywhere reflow, and a :focus-visible outline.
//   * FR-055 / SC-012 (the CARDINAL anti-lie). Internal readiness is NEVER labeled as external
//     certification. For the model's claim boundary the oracle calls
//     `assertNoInternalCertificationMislabel` over the RENDERED label text; an internal-readiness
//     boundary must carry `data-is-external-certification="false"` and must NOT read as certified.
//   * FR-031..034 (honest coverage). Every UNCOVERED obligation row must surface a coverage-gap; a
//     null certification must be stated as absent, never rendered as certified.
//
// This module OWNS the audit of CoverageView. It also EXPORTS the shared finding types + probe helpers
// (`count`, `has`, `attrOfTestId`, `hasTestId`, `structuralFindings`) so the peer oracles for
// ApplicabilityReview / EvidenceExplorer / AuditExplorer reuse the identical structural checks.
//
// It is a PURE oracle: string in, findings out. No JSX (apps/web ships no React runtime — these `.tsx`
// files are string builders), no DOM, no network, no wall clock, no module-level mutable state. A
// violation is a returned finding, NEVER a throw, so a caller can report ALL problems at once.

import { assertNoInternalCertificationMislabel } from './claim-labels.ts';

import type { TenantScope } from '../../app/layout.tsx';

import {
  renderCoverageView,
  type CoverageViewModel,
  EMPTY_COVERAGE_VIEW,
} from './CoverageView.tsx';

export type { TenantScope };

// ── Findings ───────────────────────────────────────────────────────────────────────────────────

export interface AccessibilityFinding {
  /** The compliance presenter under audit. */
  readonly presenter:
    'coverage-view' | 'applicability-review' | 'evidence-explorer' | 'audit-explorer';
  /** A short kebab-case rule id. */
  readonly rule: string;
  /** The WCAG success criterion or governance rule reference. */
  readonly ref: string;
  /** A one-sentence description of the violation. */
  readonly detail: string;
}

export interface AccessibilityReport {
  readonly presenter: AccessibilityFinding['presenter'];
  readonly findings: readonly AccessibilityFinding[];
  readonly ok: boolean;
}

// ── Tiny dependency-free HTML probes (regex over the emitted string) — SHARED, reused by peers ────

export function count(html: string, re: RegExp): number {
  const m = html.match(re);
  return m ? m.length : 0;
}

export function has(html: string, needle: string): boolean {
  return html.includes(needle);
}

/** Read the value of a data-attribute on the element carrying `data-testid="id"` (first match). */
export function attrOfTestId(html: string, testid: string, attr: string): string | undefined {
  const tagRe = new RegExp(`<[^>]*\\bdata-testid="${testid}"[^>]*>`, 'g');
  const tag = tagRe.exec(html)?.[0];
  if (!tag) return undefined;
  const attrRe = new RegExp(`\\b${attr}="([^"]*)"`);
  const m = attrRe.exec(tag);
  return m ? m[1] : undefined;
}

export function hasTestId(html: string, testid: string): boolean {
  return has(html, `data-testid="${testid}"`);
}

// ── Shared structural (WCAG) checks every compliance presenter must satisfy ─────────────────────

export function structuralFindings(
  presenter: AccessibilityFinding['presenter'],
  html: string,
): AccessibilityFinding[] {
  const out: AccessibilityFinding[] = [];
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter, rule, ref, detail });
  };

  if (!/^<!doctype html>/i.test(html))
    push('doctype', 'html', 'Output must be a full HTML document.');
  if (!/<html lang="en"/.test(html)) push('html-lang', 'WCAG 3.1.1', '<html> must declare lang.');

  const h1s = count(html, /<h1\b/g);
  if (h1s !== 1) push('single-h1', 'WCAG 2.4.6', `Exactly one <h1> required; found ${h1s}.`);

  if (!/class="skip-link"[^>]*href="#main"|href="#main"[^>]*class="skip-link"/.test(html)) {
    push('skip-link', 'WCAG 2.4.1', 'A skip link targeting #main is required.');
  }
  if (!/<main id="main"[^>]*tabindex="-1"/.test(html)) {
    push('main-landmark', 'WCAG 1.3.1', '<main id="main" tabindex="-1"> landmark is required.');
  }
  if (!/role="status"/.test(html))
    push('live-status', 'WCAG 4.1.3', 'A role=status live region is required.');
  if (!hasTestId(html, 'tenant-scope'))
    push('tenant-scope', 'scope', 'A tenant-scope banner is required.');

  if (!/overflow-wrap:\s*anywhere/.test(html)) {
    push(
      'reflow-wrap',
      'WCAG 1.4.10',
      'overflow-wrap:anywhere is required so content reflows at 400%.',
    );
  }
  if (!/:focus-visible/.test(html)) {
    push('focus-visible', 'WCAG 2.4.7', 'A :focus-visible outline is required.');
  }
  return out;
}

// ── CoverageView-specific claim-honesty checks (FR-031..035, FR-055, SC-012) ─────────────────────

function coverageFindings(html: string, model: CoverageViewModel): AccessibilityFinding[] {
  const out = structuralFindings('coverage-view', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'coverage-view', rule, ref, detail });
  };

  if (!hasTestId(html, 'claim-boundary'))
    push('claim-boundary-region', 'FR-032', 'A claim-boundary banner is required.');
  if (!hasTestId(html, 'obligations'))
    push('obligations-region', 'FR-031', 'An obligations region is required.');
  if (!hasTestId(html, 'assessments'))
    push('assessments-region', 'FR-033', 'An assessments region is required.');
  if (!hasTestId(html, 'coverage-metadata'))
    push('metadata-region', 'FR-035', 'A coverage-metadata region is required.');
  if (!hasTestId(html, 'coverage-summary'))
    push('coverage-summary', 'FR-031', 'A coverage summary is required.');

  // The claim-boundary element must reflect the model's boundary EXACTLY.
  const boundaryAttr = attrOfTestId(html, 'claim-boundary', 'data-claim-boundary');
  if (boundaryAttr !== model.claimBoundary) {
    push(
      'claim-boundary-honesty',
      'FR-032',
      'The claim-boundary banner must reflect model.claimBoundary.',
    );
  }

  // The CARDINAL anti-lie (FR-055 / SC-012): the RENDERED label must not misrepresent the boundary.
  const renderedLabel =
    attrOfTestId(html, 'claim-boundary-label', 'data-boundary') !== undefined
      ? extractLabelText(html)
      : (boundaryAttr ?? model.claimBoundary);
  const mislabel = assertNoInternalCertificationMislabel(model.claimBoundary, renderedLabel);
  if (mislabel !== null) {
    push('claim-boundary-mislabel', 'FR-055', mislabel);
  }

  // An internal-readiness boundary must NOT read as external certification.
  const isExternalCertAttr = attrOfTestId(html, 'claim-boundary', 'data-is-external-certification');
  if (INTERNAL_READINESS.includes(model.claimBoundary) && isExternalCertAttr !== 'false') {
    push(
      'internal-readiness-not-cert',
      'SC-012',
      'An internal-readiness boundary must carry data-is-external-certification="false".',
    );
  }
  // When the boundary is not `certified`, an explicit not-certified note must be present.
  if (model.claimBoundary !== 'certified' && !hasTestId(html, 'not-certified-note')) {
    push(
      'not-certified-note',
      'SC-012',
      'A non-certified boundary must state that internal readiness is not external certification.',
    );
  }

  // Certification honesty: a null certification must be stated as absent, never rendered as certified.
  if (model.certification === null) {
    if (!hasTestId(html, 'no-certification')) {
      push(
        'no-certification-stated',
        'FR-034',
        'A null certification must be stated as no external certification.',
      );
    }
    if (hasTestId(html, 'certification') && !hasTestId(html, 'no-certification')) {
      push(
        'null-cert-not-rendered',
        'FR-034',
        'A null certification must not render a certification block.',
      );
    }
  } else if (!hasTestId(html, 'certification')) {
    push(
      'certification-block',
      'FR-034',
      'A non-null certification must render a certification block.',
    );
  } else {
    const displayableAttr = attrOfTestId(html, 'certification', 'data-displayable');
    if (displayableAttr !== (model.certification.displayable ? 'true' : 'false')) {
      push(
        'certification-displayable-honesty',
        'FR-034',
        'The certification block must reflect certification.displayable.',
      );
    }
  }

  // FR-031: every UNCOVERED obligation row must surface a coverage-gap.
  for (const r of model.obligations) {
    if (r.covered) continue;
    const rowRe = new RegExp(
      `<tr[^>]*\\bdata-obligation-id="${escapeRe(r.obligationId)}"[^>]*>([\\s\\S]*?)</tr>`,
    );
    const rowHtml = rowRe.exec(html)?.[1];
    if (rowHtml === undefined) {
      push(
        'uncovered-row-rendered',
        'FR-031',
        `Uncovered obligation ${r.obligationId} must be rendered.`,
      );
      continue;
    }
    if (!/data-testid="coverage-gap"/.test(rowHtml)) {
      push(
        'uncovered-surfaces-gap',
        'FR-031',
        `Uncovered obligation ${r.obligationId} must surface a coverage-gap.`,
      );
    }
  }

  return out;
}

// ── Small local helpers (not exported) ──────────────────────────────────────────────────────────

const INTERNAL_READINESS: readonly CoverageViewModel['claimBoundary'][] = [
  'design',
  'implemented',
  'operating',
  'ready',
];

/** Extract the human label text inside the `claim-boundary-label` element (tags stripped). */
function extractLabelText(html: string): string {
  const re = /<[^>]*\bdata-testid="claim-boundary-label"[^>]*>([\s\S]*?)<\/p>/;
  const inner = re.exec(html)?.[1] ?? '';
  return inner
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/** Audit a rendered CoverageView HTML string against the model it was rendered from. */
export function auditCoverageView(html: string, model: CoverageViewModel): AccessibilityReport {
  const findings = coverageFindings(html, model);
  return { presenter: 'coverage-view', findings, ok: findings.length === 0 };
}

export interface ComplianceAccessibilityInput {
  readonly tenant: TenantScope;
  readonly coverage: CoverageViewModel;
}

/** Render the compliance presenters end-to-end and audit each (only CoverageView ships here today). */
export function auditComplianceAccessibility(
  input: ComplianceAccessibilityInput,
): readonly AccessibilityReport[] {
  const coverageHtml = renderCoverageView({ tenant: input.tenant, model: input.coverage });
  return [auditCoverageView(coverageHtml, input.coverage)];
}

/**
 * The EMPTY-model regression: prove that an un-fed compliance view is HONEST — the empty coverage
 * view reports the claim boundary as INCOMPLETE (never certified), states that internal readiness is
 * not external certification, and states that no external certification exists. This is the
 * anti-masquerade guarantee: a view given nothing can never look certified.
 */
export function auditEmptyComplianceModelsAreHonest(
  tenant: TenantScope,
): readonly AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];
  const html = renderCoverageView({ tenant, model: EMPTY_COVERAGE_VIEW });

  if (attrOfTestId(html, 'claim-boundary', 'data-claim-boundary') !== 'incomplete') {
    findings.push({
      presenter: 'coverage-view',
      rule: 'empty-not-certified',
      ref: 'SC-012',
      detail:
        'An empty coverage view must report the claim boundary as incomplete (never certified).',
    });
  }
  if (attrOfTestId(html, 'claim-boundary', 'data-is-external-certification') !== 'false') {
    findings.push({
      presenter: 'coverage-view',
      rule: 'empty-not-external-cert',
      ref: 'SC-012',
      detail: 'An empty coverage view must carry data-is-external-certification="false".',
    });
  }
  if (!hasTestId(html, 'not-certified-note')) {
    findings.push({
      presenter: 'coverage-view',
      rule: 'empty-not-certified-note',
      ref: 'SC-012',
      detail:
        'An empty coverage view must state that internal readiness is not external certification.',
    });
  }
  if (!hasTestId(html, 'no-certification')) {
    findings.push({
      presenter: 'coverage-view',
      rule: 'empty-no-certification',
      ref: 'FR-034',
      detail: 'An empty coverage view must state that no external certification exists.',
    });
  }
  return findings;
}

export default auditComplianceAccessibility;
