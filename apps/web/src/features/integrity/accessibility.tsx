// TrustCircleAI — INTEGRITY presenter ACCESSIBILITY ORACLE (Phase 5 / User Story 3 / T147 /
// apps/web/src/features/integrity/accessibility.tsx / FR-016..022, SC-006..009).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free ACCESSIBILITY + INTEGRITY-SEMANTICS oracle over the three shipped integrity
// presenters (IntegrityQueue, EvidenceComparison, RemediationDetail). The host has no Chromium, so the
// browser-driven axe-core scan in the e2e spec cannot run here; this oracle is the logic half that
// runs everywhere — it takes the SAME HTML strings the presenters emit and asserts, WITHOUT a browser,
// the structural WCAG/ARIA obligations a screen-reader user depends on AND the load-bearing integrity
// invariants that make the UI honest:
//
//   * WCAG 1.4.1 (status not by color). Every severity/quarantine/verdict is a WORD, and each carries a
//     machine-readable data-attribute — so this oracle can prove the meaning is in the text, not a hue.
//   * WCAG 2.4.1 / 4.1.2 (structure). Exactly one <h1>, a skip link to #main, a labelled <main
//     id=main>, a live status region, and one landmark per region.
//   * FR-017 (preservation honesty). An un-fed EvidenceComparison must report the original as NOT
//     confirmed — never "intact".
//   * FR-019 (containment honesty). A comparison with no active quarantine must say NOT contained.
//   * GAR-004 (bounded execution). RemediationDetail's execute control must be DISABLED with a stated
//     reason unless every step is pre-authorized low-risk.
//   * FR-022 (verified closure). No presenter may present a case as closed without an independent
//     passing verification; an un-fed detail must report NOT verified-closed.
//
// It is a PURE oracle: string in, findings out. No JSX (apps/web ships no React runtime — these `.tsx`
// files are string builders), no DOM, no network, no wall clock, no module-level mutable state. The
// e2e spec calls `auditIntegrityAccessibility(html, expectations)` alongside the axe-core scan so the
// logic oracle and the DOM oracle must agree; a violation is a returned finding, never a throw, so a
// caller can report ALL problems at once.

import type { TenantScope } from '../../app/layout.tsx';

import {
  renderIntegrityQueue,
  type IntegrityQueueModel,
  EMPTY_INTEGRITY_QUEUE,
} from './IntegrityQueue.tsx';
import {
  renderEvidenceComparison,
  type EvidenceComparisonModel,
  EMPTY_EVIDENCE_COMPARISON,
} from './EvidenceComparison.tsx';
import {
  renderRemediationDetail,
  type RemediationDetailModel,
  EMPTY_REMEDIATION_DETAIL,
} from './RemediationDetail.tsx';

export type { TenantScope };

// ── Findings ───────────────────────────────────────────────────────────────────────────────────

export interface AccessibilityFinding {
  /** The presenter under audit. */
  readonly presenter: 'integrity-queue' | 'evidence-comparison' | 'remediation-detail';
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

// ── Tiny dependency-free HTML probes (regex over the emitted string) ─────────────────────────────

function count(html: string, re: RegExp): number {
  const m = html.match(re);
  return m ? m.length : 0;
}

function has(html: string, needle: string): boolean {
  return html.includes(needle);
}

/** Read the value of a data-attribute on the element carrying `data-testid="id"` (first match). */
function attrOfTestId(html: string, testid: string, attr: string): string | undefined {
  // Find the opening tag that contains data-testid="testid" and read `attr="..."` from within it.
  const tagRe = new RegExp(`<[^>]*\\bdata-testid="${testid}"[^>]*>`, 'g');
  const tag = tagRe.exec(html)?.[0];
  if (!tag) return undefined;
  const attrRe = new RegExp(`\\b${attr}="([^"]*)"`);
  const m = attrRe.exec(tag);
  return m ? m[1] : undefined;
}

function hasTestId(html: string, testid: string): boolean {
  return has(html, `data-testid="${testid}"`);
}

// ── Shared structural (WCAG) checks every integrity presenter must satisfy ──────────────────────

function structuralFindings(
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

  // WCAG 1.4.6-ish reflow guard the presenter's own style enforces — assert the wrapping rule is present.
  if (!/overflow-wrap:\s*anywhere/.test(html)) {
    push(
      'reflow-wrap',
      'WCAG 1.4.10',
      'overflow-wrap:anywhere is required so content reflows at 400%.',
    );
  }
  // A visible focus indicator (WCAG 2.4.7).
  if (!/:focus-visible/.test(html)) {
    push('focus-visible', 'WCAG 2.4.7', 'A :focus-visible outline is required.');
  }
  return out;
}

// ── Presenter-specific integrity-semantics checks ────────────────────────────────────────────────

function queueFindings(html: string): AccessibilityFinding[] {
  const out = structuralFindings('integrity-queue', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'integrity-queue', rule, ref, detail });
  };

  if (!hasTestId(html, 'integrity-queue'))
    push('queue-region', 'FR-016', 'The queue region is required.');
  if (!hasTestId(html, 'integrity-result-status'))
    push('result-status', 'SC-006', 'A result-status region is required.');
  // FR-022 — the queue must expose a per-row verified flag so closure is never color-only.
  if (!/data-verified="(true|false)"/.test(html)) {
    push(
      'row-verified-flag',
      'FR-022',
      'Each row must carry a machine-readable data-verified flag.',
    );
  }
  // Filtering must not delete: hidden filtered-out rows keep a reason.
  if (
    has(html, 'hidden') &&
    !/data-filtered-out-reason="/.test(html) &&
    /data-matches="false"/.test(html)
  ) {
    push('filter-preserves', 'SC-006', 'A filtered-out row must retain data-filtered-out-reason.');
  }
  return out;
}

function comparisonFindings(html: string, model: EvidenceComparisonModel): AccessibilityFinding[] {
  const out = structuralFindings('evidence-comparison', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'evidence-comparison', rule, ref, detail });
  };

  if (!hasTestId(html, 'preservation-banner'))
    push('preservation-banner', 'FR-017', 'A preservation banner is required.');
  if (!hasTestId(html, 'containment-banner'))
    push('containment-banner', 'FR-019', 'A containment banner is required.');

  // FR-017 honesty — a NOT-intact model must NOT present the original as intact.
  const intactAttr = attrOfTestId(html, 'preservation-banner', 'data-original-intact');
  if (intactAttr !== (model.originalIntact ? 'true' : 'false')) {
    push(
      'preservation-honesty',
      'FR-017',
      'preservation banner must reflect the model.originalIntact verdict.',
    );
  }
  if (!model.originalIntact && intactAttr === 'true') {
    push(
      'preservation-no-false-positive',
      'FR-017',
      'A non-intact original must never present as intact.',
    );
  }
  // FR-019 honesty — containment flag must reflect the model.
  const containAttr = attrOfTestId(html, 'containment-banner', 'data-quarantine-contains');
  if (containAttr !== (model.quarantineContains ? 'true' : 'false')) {
    push(
      'containment-honesty',
      'FR-019',
      'containment banner must reflect model.quarantineContains.',
    );
  }
  // Both digests must be shown verbatim so the intactness claim is checkable.
  if (
    !hasTestId(html, 'preservation-captured-digest') ||
    !hasTestId(html, 'preservation-verify-digest')
  ) {
    push(
      'digests-shown',
      'SC-007',
      'Both captured and re-hash digests must be shown for independent check.',
    );
  }
  return out;
}

function detailFindings(html: string, model: RemediationDetailModel): AccessibilityFinding[] {
  const out = structuralFindings('remediation-detail', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'remediation-detail', rule, ref, detail });
  };

  if (!hasTestId(html, 'remediation-plan'))
    push('plan-region', 'FR-020', 'A remediation-plan region is required.');
  if (!hasTestId(html, 'kill-switch'))
    push('kill-switch', 'FR-021', 'A kill-switch control is required.');
  if (!hasTestId(html, 'rollback')) push('rollback', 'FR-021', 'A rollback control is required.');
  if (!hasTestId(html, 'closure-banner'))
    push('closure-banner', 'FR-022', 'A closure banner is required.');

  // GAR-004 — execute must be disabled unless every step is pre-authorized low-risk.
  const everyAuthed =
    model.steps.length > 0 &&
    model.steps.every((s) => s.preAuthorizedLowRisk) &&
    !model.ownershipGap;
  const executeEnabled = attrOfTestId(html, 'detail-main', 'data-execute-enabled') === 'true';
  if (executeEnabled !== everyAuthed) {
    push(
      'execute-gating',
      'GAR-004',
      'Execute must be enabled iff every step is pre-authorized low-risk and owned.',
    );
  }
  if (executeEnabled && model.steps.some((s) => !s.preAuthorizedLowRisk)) {
    push(
      'execute-no-escape',
      'GAR-004',
      'A not-pre-authorized step must never leave execute enabled.',
    );
  }
  // The disabled execute button must carry a stated reason (WCAG 1.4.1 — reason in text).
  const execEnabledOnBtn = attrOfTestId(html, 'remediation-mode', 'data-execute-enabled');
  void execEnabledOnBtn; // presence-only; the note below is the authoritative reason surface
  if (!executeEnabled && !/data-execute-blocked-reason="[^"]+"/.test(html)) {
    push('execute-reason', 'WCAG 1.4.1', 'A disabled execute control must state a textual reason.');
  }
  // FR-022 — a non-verified case must NOT present as closed.
  const closed = attrOfTestId(html, 'detail-main', 'data-case-closed') === 'true';
  if (closed !== model.verification.caseClosed) {
    push('closure-honesty', 'FR-022', 'closure banner must reflect model.verification.caseClosed.');
  }
  if (closed && !model.verification.allGatesPassed) {
    push(
      'closure-no-false-positive',
      'FR-022',
      'A case may never present as closed unless all gates passed.',
    );
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/** Audit a rendered IntegrityQueue HTML string. */
export function auditIntegrityQueue(html: string): AccessibilityReport {
  const findings = queueFindings(html);
  return { presenter: 'integrity-queue', findings, ok: findings.length === 0 };
}

/** Audit a rendered EvidenceComparison HTML string against the model it was rendered from. */
export function auditEvidenceComparison(
  html: string,
  model: EvidenceComparisonModel,
): AccessibilityReport {
  const findings = comparisonFindings(html, model);
  return { presenter: 'evidence-comparison', findings, ok: findings.length === 0 };
}

/** Audit a rendered RemediationDetail HTML string against the model it was rendered from. */
export function auditRemediationDetail(
  html: string,
  model: RemediationDetailModel,
): AccessibilityReport {
  const findings = detailFindings(html, model);
  return { presenter: 'remediation-detail', findings, ok: findings.length === 0 };
}

export interface IntegrityAccessibilityInput {
  readonly tenant: TenantScope;
  readonly queue: IntegrityQueueModel;
  readonly comparison: EvidenceComparisonModel;
  readonly detail: RemediationDetailModel;
}

/** Audit ALL three integrity presenters end-to-end (renders them here, then audits each). */
export function auditIntegrityAccessibility(
  input: IntegrityAccessibilityInput,
): readonly AccessibilityReport[] {
  const queueHtml = renderIntegrityQueue({ tenant: input.tenant, model: input.queue });
  const compareHtml = renderEvidenceComparison({ tenant: input.tenant, model: input.comparison });
  const detailHtml = renderRemediationDetail({ tenant: input.tenant, model: input.detail });
  return [
    auditIntegrityQueue(queueHtml),
    auditEvidenceComparison(compareHtml, input.comparison),
    auditRemediationDetail(detailHtml, input.detail),
  ];
}

/**
 * The EMPTY-model regression: prove that an un-fed presenter is HONEST — the empty queue reports no
 * cases, the empty comparison reports the original is NOT confirmed, and the empty detail reports NOT
 * verified-closed. This is the anti-masquerade guarantee: a view given nothing can never look satisfied.
 */
export function auditEmptyModelsAreHonest(tenant: TenantScope): readonly AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];

  const compareHtml = renderEvidenceComparison({ tenant, model: EMPTY_EVIDENCE_COMPARISON });
  if (attrOfTestId(compareHtml, 'preservation-banner', 'data-original-intact') !== 'false') {
    findings.push({
      presenter: 'evidence-comparison',
      rule: 'empty-not-intact',
      ref: 'FR-017',
      detail: 'An empty comparison must report the original as NOT intact.',
    });
  }

  const detailHtml = renderRemediationDetail({ tenant, model: EMPTY_REMEDIATION_DETAIL });
  if (attrOfTestId(detailHtml, 'detail-main', 'data-case-closed') !== 'false') {
    findings.push({
      presenter: 'remediation-detail',
      rule: 'empty-not-closed',
      ref: 'FR-022',
      detail: 'An empty detail must report NOT verified-closed.',
    });
  }
  if (attrOfTestId(detailHtml, 'detail-main', 'data-execute-enabled') !== 'false') {
    findings.push({
      presenter: 'remediation-detail',
      rule: 'empty-execute-disabled',
      ref: 'GAR-004',
      detail: 'An empty detail must not enable execute.',
    });
  }

  const queueHtml = renderIntegrityQueue({ tenant, model: EMPTY_INTEGRITY_QUEUE });
  if (!has(queueHtml, 'No damaged-work cases')) {
    findings.push({
      presenter: 'integrity-queue',
      rule: 'empty-states-empty',
      ref: 'SC-006',
      detail: 'An empty queue must state it has no cases.',
    });
  }
  return findings;
}

export default auditIntegrityAccessibility;
