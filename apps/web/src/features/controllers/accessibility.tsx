// TrustCircleAI — CONTROLLER presenter ACCESSIBILITY ORACLE (Phase 6 / User Story 4 / T177 /
// apps/web/src/features/controllers/accessibility.tsx / FR-023..028, FR-046..050, SC-010, SC-011, NS-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free ACCESSIBILITY + CONTROL-SAFETY-SEMANTICS oracle over the three shipped controller
// presenters (ControllerRegistry, OperationDetail, OperationActions). The host has no Chromium, so the
// browser-driven axe-core scan in the e2e spec cannot run here; this oracle is the logic half that
// runs everywhere — it takes the SAME HTML strings the presenters emit and asserts, WITHOUT a browser,
// the structural WCAG/ARIA obligations a screen-reader user depends on AND the load-bearing control-
// safety invariants that make the UI honest and unbypassable:
//
//   * WCAG 1.4.1 (status not by color). Every health/drift/confirmation/lease verdict is a WORD, and
//     each carries a machine-readable data-attribute — so this oracle can prove the meaning is in the
//     text, not a hue.
//   * WCAG 2.4.1 / 4.1.2 (structure). Exactly one <h1>, a skip link to #main, a labelled <main
//     id=main>, a live status region, and a tenant-scope banner.
//   * FR-024 (drift never masked; exact actions). The registry must expose a per-row data-drift flag
//     AND a per-row permitted-action set — the honesty half of manifest-only control.
//   * FR-028 / SC-010 (uncertainty ≠ success). The OperationDetail confirmation banner must NOT read
//     confirmed unless the model says the effect was established by a direct observation; an uncertain
//     latest outcome must surface AWAITING RECONCILIATION.
//   * SC-011 (one effect). A duplicate effect must be surfaced, never hidden.
//   * FR-024 / FR-025 / GAR-005 (gated actions). An OperationActions button must be enabled iff the
//     state permits it AND — for a state-changing kind — simulation + approval are both satisfied.
//   * FR-026 (idempotency). The action form must carry a required idempotency-key field.
//
// It is a PURE oracle: string in, findings out. No JSX (apps/web ships no React runtime — these `.tsx`
// files are string builders), no DOM, no network, no wall clock, no module-level mutable state. The
// e2e spec calls `auditControllerAccessibility(input)` alongside the axe-core scan so the logic oracle
// and the DOM oracle must agree; a violation is a returned finding, never a throw, so a caller can
// report ALL problems at once.

import type { TenantScope } from '../../app/layout.tsx';

import {
  renderControllerRegistry,
  type ControllerRegistryModel,
  EMPTY_CONTROLLER_REGISTRY,
} from './ControllerRegistry.tsx';
import {
  renderOperationDetail,
  type OperationDetailModel,
  EMPTY_OPERATION_DETAIL,
} from './OperationDetail.tsx';
import {
  renderOperationActions,
  type OperationActionsModel,
  actionIsEnabled,
  EMPTY_OPERATION_ACTIONS,
} from './OperationActions.tsx';

export type { TenantScope };

// ── Findings ───────────────────────────────────────────────────────────────────────────────────

export interface AccessibilityFinding {
  /** The presenter under audit. */
  readonly presenter: 'controller-registry' | 'operation-detail' | 'operation-actions';
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

// ── Shared structural (WCAG) checks every controller presenter must satisfy ─────────────────────

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

// ── Presenter-specific control-safety-semantics checks ───────────────────────────────────────────

function registryFindings(html: string): AccessibilityFinding[] {
  const out = structuralFindings('controller-registry', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'controller-registry', rule, ref, detail });
  };

  if (!hasTestId(html, 'controller-registry'))
    push('registry-region', 'FR-023', 'The registry region is required.');
  if (!hasTestId(html, 'controller-result-status'))
    push('result-status', 'SC-010', 'A result-status region is required.');
  // FR-024 — drift must never be masked: each row must carry a machine-readable data-drift flag.
  if (!/data-drift="(true|false)"/.test(html)) {
    push(
      'row-drift-flag',
      'FR-024',
      'Each row must carry a machine-readable data-drift flag (drift is never masked by health).',
    );
  }
  // FR-024 — the EXACT permitted-action set must be exposed per row.
  if (!/data-permitted-actions="/.test(html)) {
    push('row-permitted-actions', 'FR-024', 'Each row must expose its exact permitted-action set.');
  }
  // Filtering must not delete: hidden filtered-out rows keep a reason.
  if (
    has(html, 'hidden') &&
    /data-matches="false"/.test(html) &&
    !/data-filtered-out-reason="/.test(html)
  ) {
    push('filter-preserves', 'SC-010', 'A filtered-out row must retain data-filtered-out-reason.');
  }
  return out;
}

function detailFindings(html: string, model: OperationDetailModel): AccessibilityFinding[] {
  const out = structuralFindings('operation-detail', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'operation-detail', rule, ref, detail });
  };

  if (!hasTestId(html, 'confirmation-banner'))
    push('confirmation-banner', 'FR-028', 'A confirmation banner is required.');
  if (!hasTestId(html, 'reconciliation-region'))
    push('reconciliation-region', 'FR-028', 'A reconciliation region is required.');
  if (!hasTestId(html, 'continuity-region'))
    push('continuity-region', 'FR-046', 'A continuity region is required.');
  if (!hasTestId(html, 'rollback-region'))
    push('rollback-region', 'NS-011', 'A rollback region is required.');
  if (!hasTestId(html, 'permitted-actions-region'))
    push('permitted-actions', 'FR-024', 'A permitted-actions region is required.');

  // FR-028 / SC-010 — the confirmation banner must reflect model.effectConfirmed EXACTLY.
  const confirmedAttr = attrOfTestId(html, 'confirmation-banner', 'data-effect-confirmed');
  if (confirmedAttr !== (model.effectConfirmed ? 'true' : 'false')) {
    push(
      'confirmation-honesty',
      'FR-028',
      'The confirmation banner must reflect model.effectConfirmed.',
    );
  }
  // The cardinal anti-lie: an uncertain latest outcome may NEVER present as confirmed.
  if (model.latestOutcomeUncertain && confirmedAttr === 'true') {
    push(
      'uncertainty-not-success',
      'FR-028',
      'An uncertain latest outcome must never present as confirmed (an acknowledgement is not a success).',
    );
  }
  // An awaiting-reconciliation operation must surface that state.
  const awaitingAttr = attrOfTestId(html, 'confirmation-banner', 'data-awaiting-reconciliation');
  if (awaitingAttr !== (model.awaitingReconciliation ? 'true' : 'false')) {
    push(
      'awaiting-reconciliation-honesty',
      'FR-028',
      'The confirmation banner must reflect model.awaitingReconciliation.',
    );
  }
  // SC-011 — a duplicate effect (>1) must be surfaced, never hidden.
  const dup = model.reconciliation !== null && model.reconciliation.duplicateEffect;
  if (dup && !hasTestId(html, 'duplicate-effect-warning')) {
    push('duplicate-effect-surfaced', 'SC-011', 'A duplicate effect must be surfaced explicitly.');
  }
  // FR-046..050 — a continuity lease must expose its active/inactive verdict (bounded, nonrenewable).
  if (model.continuityLease !== null) {
    const active = attrOfTestId(html, 'continuity-region', 'data-continuity-active');
    if (active !== (model.continuityLease.active ? 'true' : 'false')) {
      push(
        'continuity-honesty',
        'FR-046',
        'The continuity region must reflect model.continuityLease.active.',
      );
    }
  }
  // NS-011 — a rollback that protected newer state must be surfaced, not shown as a plain success.
  if (
    model.rollback.result === 'rollback_refused_newer_state' &&
    attrOfTestId(html, 'rollback-region', 'data-protected-newer-state') !== 'true'
  ) {
    push(
      'rollback-protects-newer',
      'NS-011',
      'A rollback refused to protect newer state must be surfaced as such.',
    );
  }
  return out;
}

function actionsFindings(html: string, model: OperationActionsModel): AccessibilityFinding[] {
  const out = structuralFindings('operation-actions', html);
  const push = (rule: string, ref: string, detail: string): void => {
    out.push({ presenter: 'operation-actions', rule, ref, detail });
  };

  if (!hasTestId(html, 'operation-actions'))
    push('actions-region', 'FR-024', 'An operation-actions region is required.');
  if (!hasTestId(html, 'operation-actions-form'))
    push('actions-form', 'FR-024', 'An action request form is required.');
  // FR-026 — a required idempotency-key field must be present.
  if (!hasTestId(html, 'idempotency-key-input')) {
    push('idempotency-field', 'FR-026', 'A required idempotency-key field is required.');
  } else if (
    !/data-testid="idempotency-key-input"[^>]*required|<input[^>]*required[^>]*data-testid="idempotency-key-input"/.test(
      html,
    ) &&
    !/id="idempotency-key"[^>]*required/.test(html)
  ) {
    // The field must actually be required (aria-required + required).
    if (!/required/.test(html)) {
      push('idempotency-required', 'FR-026', 'The idempotency-key field must be required.');
    }
  }

  // FR-024 / FR-025 / GAR-005 — each button must be enabled iff the oracle says so.
  for (const a of model.actions) {
    const expected = actionIsEnabled(a, model.terminal);
    // Find this button's data-enabled by locating its data-kind tag.
    const tagRe = new RegExp(`<button[^>]*\\bdata-kind="${a.kind}"[^>]*>`, 'g');
    const tag = tagRe.exec(html)?.[0];
    if (!tag) {
      push(
        'action-rendered',
        'FR-024',
        `Action ${a.kind} must be rendered (the full surface is shown).`,
      );
      continue;
    }
    const enabledAttr = /\bdata-enabled="([^"]*)"/.exec(tag)?.[1];
    if (enabledAttr !== (expected ? 'true' : 'false')) {
      push(
        'action-gating',
        'FR-024',
        `Action ${a.kind} must be enabled iff the state permits it and (read-only or simulation+approval).`,
      );
    }
    // A state-changing action missing simulation/approval must NEVER be enabled.
    if (expected === false && /\bdisabled\b/.test(tag) === false) {
      push(
        'action-disabled-attr',
        'GAR-005',
        `Disabled action ${a.kind} must carry the disabled attribute.`,
      );
    }
    if (
      a.stateChanging &&
      enabledAttr === 'true' &&
      !(a.simulationSatisfied && a.approvalSatisfied)
    ) {
      push(
        'destructive-no-escape',
        'GAR-005',
        `A state-changing action (${a.kind}) must never be enabled without simulation AND approval.`,
      );
    }
    // A disabled action must state a textual reason (WCAG 1.4.1).
    if (enabledAttr === 'false' && !/\bdata-disabled-reason="[^"]+"/.test(tag)) {
      push(
        'disabled-reason',
        'WCAG 1.4.1',
        `Disabled action ${a.kind} must state a textual reason.`,
      );
    }
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/** Audit a rendered ControllerRegistry HTML string. */
export function auditControllerRegistry(html: string): AccessibilityReport {
  const findings = registryFindings(html);
  return { presenter: 'controller-registry', findings, ok: findings.length === 0 };
}

/** Audit a rendered OperationDetail HTML string against the model it was rendered from. */
export function auditOperationDetail(
  html: string,
  model: OperationDetailModel,
): AccessibilityReport {
  const findings = detailFindings(html, model);
  return { presenter: 'operation-detail', findings, ok: findings.length === 0 };
}

/** Audit a rendered OperationActions HTML string against the model it was rendered from. */
export function auditOperationActions(
  html: string,
  model: OperationActionsModel,
): AccessibilityReport {
  const findings = actionsFindings(html, model);
  return { presenter: 'operation-actions', findings, ok: findings.length === 0 };
}

export interface ControllerAccessibilityInput {
  readonly tenant: TenantScope;
  readonly registry: ControllerRegistryModel;
  readonly detail: OperationDetailModel;
  readonly actions: OperationActionsModel;
}

/** Audit ALL three controller presenters end-to-end (renders them here, then audits each). */
export function auditControllerAccessibility(
  input: ControllerAccessibilityInput,
): readonly AccessibilityReport[] {
  const registryHtml = renderControllerRegistry({ tenant: input.tenant, model: input.registry });
  const detailHtml = renderOperationDetail({ tenant: input.tenant, model: input.detail });
  const actionsHtml = renderOperationActions({ tenant: input.tenant, model: input.actions });
  return [
    auditControllerRegistry(registryHtml),
    auditOperationDetail(detailHtml, input.detail),
    auditOperationActions(actionsHtml, input.actions),
  ];
}

/**
 * The EMPTY-model regression: prove that an un-fed presenter is HONEST — the empty registry reports no
 * controllers, the empty detail reports the effect is NOT confirmed and NOT awaiting-reconciliation
 * (nothing has happened), and the empty action surface ENABLES NOTHING. This is the anti-masquerade
 * guarantee: a view given nothing can never look satisfied nor grant unbounded power.
 */
export function auditEmptyModelsAreHonest(tenant: TenantScope): readonly AccessibilityFinding[] {
  const findings: AccessibilityFinding[] = [];

  const registryHtml = renderControllerRegistry({ tenant, model: EMPTY_CONTROLLER_REGISTRY });
  if (!has(registryHtml, 'No governance controllers')) {
    findings.push({
      presenter: 'controller-registry',
      rule: 'empty-states-empty',
      ref: 'SC-010',
      detail: 'An empty registry must state it has no controllers.',
    });
  }

  const detailHtml = renderOperationDetail({ tenant, model: EMPTY_OPERATION_DETAIL });
  if (attrOfTestId(detailHtml, 'confirmation-banner', 'data-effect-confirmed') !== 'false') {
    findings.push({
      presenter: 'operation-detail',
      rule: 'empty-not-confirmed',
      ref: 'FR-028',
      detail: 'An empty detail must report the effect as NOT confirmed.',
    });
  }

  const actionsHtml = renderOperationActions({ tenant, model: EMPTY_OPERATION_ACTIONS });
  if (attrOfTestId(actionsHtml, 'actions-main', 'data-enabled-count') !== '0') {
    findings.push({
      presenter: 'operation-actions',
      rule: 'empty-enables-nothing',
      ref: 'FR-024',
      detail: 'An empty action surface must enable no actions.',
    });
  }
  if (!has(actionsHtml, 'data-testid="idempotency-key-input"')) {
    findings.push({
      presenter: 'operation-actions',
      rule: 'empty-idempotency-field',
      ref: 'FR-026',
      detail: 'Even an empty action surface must present the required idempotency-key field.',
    });
  }
  return findings;
}

export default auditControllerAccessibility;
