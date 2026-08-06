// TrustCircleAI — accessible CONTROLLER-OPERATION ACTION CONTROLS (Phase 6 / User Story 4 / T176 /
// apps/web/src/features/controllers/OperationActions.tsx / FR-024, FR-025, FR-026, GAR-005, SC-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The operator-facing ACTION SURFACE for one controller operation: the buttons an operator uses to
// request the next governed action (inspect, simulate, execute, pause, resume, reconcile, rollback,
// collect evidence, emergency stop). Its whole reason for existing is to make the platform's authority
// model VISIBLE and UNBYPASSABLE at the point of action:
//
//   * ONLY PERMITTED ACTIONS ARE ENABLED (FR-024). An action button is ENABLED iff its kind is in the
//     projector's EXACT `nextPermittedActions` set for the current state. Every other governable kind
//     is still RENDERED (so the operator sees the full surface) but DISABLED, carrying a stated textual
//     reason (WCAG 1.4.1) — an operator can never drive an operation off its governed lifecycle.
//   * DESTRUCTIVE ACTIONS ARE GATED (FR-025 / GAR-005). A state-changing action additionally requires a
//     bound, still-binding simulation AND an approval decision; if either is missing the button is
//     DISABLED with the reason, even when the lifecycle state would otherwise allow the kind.
//   * IDEMPOTENCY IS MANDATORY (FR-026). The request form carries a required Idempotency-Key field, so
//     one logical request maps to exactly one governed effect (a replay never creates a second effect).
//
// The buttons here are DECLARATIVE (they carry the action kind, enabled state, and reason as machine-
// readable attributes); wiring them to POST /v1/controllers/:id/operations is the framework adopter's
// job. This module proves the accessible CONTRACT: the right buttons, enabled iff permitted-and-gated,
// each disabled one stating why, and a required idempotency key.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web ships no React runtime; these `.tsx`
// files are pure string builders. The output is a self-contained HTML string the e2e spec mounts via
// `page.setContent(renderOperationActions(props))` and asserts through axe-core + the accessibility tree.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no
// network, no module-level mutable state — same props ⇒ byte-identical output.

import type { TenantScope } from '../../app/layout.tsx';

export type { TenantScope };

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── The action-controls view model ───────────────────────────────────────────────────────────────

/** One governable action button (a projected candidate over `nextPermittedActions`). */
export interface OperationActionVM {
  /** The operation kind this button requests (discover/inspect/simulate/execute/pause/…). */
  readonly kind: string;
  readonly label: string;
  /** True iff the kind changes governed state (needs simulation + approval before it can enable). */
  readonly stateChanging: boolean;
  /** True iff the kind is destructive/irreversible (surfaced with an explicit confirm requirement). */
  readonly destructive: boolean;
  /** The AUTHORITATIVE permitted flag — true iff kind ∈ projector `nextPermittedActions` (FR-024). */
  readonly permittedByState: boolean;
  /** True iff a still-binding simulation is present (required for a state-changing action, FR-025). */
  readonly simulationSatisfied: boolean;
  /** True iff an approval decision is present (required for a state-changing action, GAR-005). */
  readonly approvalSatisfied: boolean;
  /** The final ENABLED verdict — permittedByState AND (read-only OR (simulation AND approval)). */
  readonly enabled: boolean;
  /** When !enabled, the stated textual reason (WCAG 1.4.1). Empty when enabled. */
  readonly disabledReason: string;
}

/** The whole action-controls model. */
export interface OperationActionsModel {
  readonly operationId: string;
  readonly controllerId: string;
  readonly state: string;
  /** The EXACT permitted-action set from the projector (FR-024) — the source of `permittedByState`. */
  readonly permittedActions: readonly string[];
  readonly actions: readonly OperationActionVM[];
  /** True iff the operation is terminal (queryable; no action may be requested). */
  readonly terminal: boolean;
  /** The current idempotency key echoed into the required field (empty ⇒ operator must supply one). */
  readonly idempotencyKey: string;
  readonly generatedAtIso: string;
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed action surface enables NOTHING (fail-closed). */
export const EMPTY_OPERATION_ACTIONS: OperationActionsModel = {
  operationId: '',
  controllerId: '',
  state: 'requested',
  permittedActions: [],
  actions: [],
  terminal: false,
  idempotencyKey: '',
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface OperationActionsProps {
  readonly tenant: TenantScope;
  readonly model: OperationActionsModel;
}

/**
 * The AUTHORITATIVE enabled verdict — recomputed here as a defensive oracle so a mislabelled `enabled`
 * can never leak an action past its gate. An action is enabled ONLY when the state permits it AND
 * (it is read-only OR both simulation and approval are satisfied) AND the operation is not terminal.
 */
export function actionIsEnabled(a: OperationActionVM, terminal: boolean): boolean {
  if (terminal) return false;
  if (!a.permittedByState) return false;
  if (a.stateChanging && !(a.simulationSatisfied && a.approvalSatisfied)) return false;
  return true;
}

/** The stated textual reason an action is disabled (empty when enabled). */
export function disabledReasonFor(a: OperationActionVM, terminal: boolean): string {
  if (terminal) return 'the operation is terminal; no action may be requested';
  if (!a.permittedByState)
    return `not permitted from the current state (${a.kind} is not in the allowed next actions)`;
  if (a.stateChanging && !a.simulationSatisfied)
    return 'a state-changing action requires a still-binding simulation (FR-025)';
  if (a.stateChanging && !a.approvalSatisfied)
    return 'a state-changing action requires an approval decision (GAR-005)';
  return '';
}

// ── Controls ─────────────────────────────────────────────────────────────────────────────────────

function actionButton(a: OperationActionVM, terminal: boolean): string {
  const enabled = actionIsEnabled(a, terminal);
  const reason = enabled ? '' : a.disabledReason || disabledReasonFor(a, terminal);
  const disabledAttrs = enabled
    ? ''
    : ` disabled aria-disabled="true" data-disabled-reason="${esc(reason)}"`;
  const reasonNote = enabled
    ? ''
    : `<span class="disabled-reason" data-testid="action-disabled-reason" data-kind="${esc(a.kind)}">${esc(reason)}</span>`;
  const confirmNote = a.destructive
    ? '<span class="confirm-note" data-testid="action-destructive-note" data-destructive="true">Destructive / irreversible — requires explicit confirmation.</span>'
    : '';
  return `
          <li class="action-item">
            <button
              type="submit"
              class="action-btn"
              data-testid="operation-action"
              data-kind="${esc(a.kind)}"
              data-state-changing="${a.stateChanging ? 'true' : 'false'}"
              data-destructive="${a.destructive ? 'true' : 'false'}"
              data-permitted-by-state="${a.permittedByState ? 'true' : 'false'}"
              data-simulation-satisfied="${a.simulationSatisfied ? 'true' : 'false'}"
              data-approval-satisfied="${a.approvalSatisfied ? 'true' : 'false'}"
              data-enabled="${enabled ? 'true' : 'false'}"
              name="operation_type"
              value="${esc(a.kind)}"${disabledAttrs}
            >${esc(a.label)}</button>
            ${confirmNote}
            ${reasonNote}
          </li>`;
}

function actionsForm(m: OperationActionsModel): string {
  const buttons = m.actions.map((a) => actionButton(a, m.terminal)).join('');
  return `
      <section id="region-operation-actions" aria-labelledby="actions-h" data-testid="operation-actions" tabindex="-1"
        data-operation-id="${esc(m.operationId)}" data-controller-id="${esc(m.controllerId)}" data-state="${esc(m.state)}"
        data-permitted-actions="${esc(m.permittedActions.join(' '))}" data-terminal="${m.terminal ? 'true' : 'false'}">
        <h2 id="actions-h">Request a governed action</h2>
        <p id="actions-summary" data-testid="actions-summary">
          An action is enabled ONLY when the current operation state permits it (FR-024) and — for a
          state-changing action — a still-binding simulation (FR-025) and an approval decision (GAR-005)
          are both present. Every other action is shown but DISABLED with the reason. Requesting an
          action requires an idempotency key so one logical request maps to exactly one governed effect
          (FR-026).
        </p>
        <form
          method="post"
          action="/v1/controllers/${esc(m.controllerId)}/operations/${esc(m.operationId)}/actions"
          data-testid="operation-actions-form"
          aria-describedby="actions-summary"
        >
          <div class="idem-row">
            <label for="idempotency-key" data-testid="idempotency-label">Idempotency key (required)</label>
            <input
              id="idempotency-key"
              name="idempotency_key"
              type="text"
              required
              aria-required="true"
              minlength="8"
              data-testid="idempotency-key-input"
              value="${esc(m.idempotencyKey)}"
              aria-describedby="idempotency-help"
            />
            <span id="idempotency-help" class="help" data-testid="idempotency-help">
              One logical request → exactly one governed effect. A replay under the same key returns the
              existing operation and never creates a second effect (FR-026).
            </span>
          </div>
          <ul class="action-list" role="list" data-testid="action-list" data-count="${m.actions.length}">${buttons}
          </ul>
        </form>
      </section>`;
}

// ── Chrome ───────────────────────────────────────────────────────────────────────────────────────

function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section
        aria-labelledby="scope-h"
        data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}"
        data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}"
        data-work-item-id="${esc(tenant.workItemId)}"
        data-role="controller-operator"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">controller operator</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const ACTIONS_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; } dd { margin: 0; }
    .idem-row { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .idem-row input { font: inherit; padding: .35rem .5rem; max-width: 100%; }
    .help { color: #333; font-size: .9rem; }
    ul.action-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .action-item { display: flex; flex-direction: column; gap: .2rem; }
    .action-btn { font: inherit; padding: .4rem .8rem; border: 1px solid #0b57d0; border-radius: .25rem; background: #0b57d0; color: #fff; cursor: pointer; align-self: flex-start; }
    .action-btn[disabled] { background: #e6e6e6; color: #555; border-color: #999; cursor: not-allowed; }
    .disabled-reason { color: #7a1f12; }
    .confirm-note { color: #7a1f12; font-weight: 600; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible CONTROLLER-OPERATION ACTION CONTROLS as a standalone HTML document,
 * PRESENTING the injected `props.model`. Mounted in-browser via
 * `page.setContent(renderOperationActions(props))`.
 */
export function renderOperationActions(props: OperationActionsProps): string {
  const { tenant } = props;
  const m = props.model;
  const enabledCount = m.actions.filter((a) => actionIsEnabled(a, m.terminal)).length;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} operation actions</title>
  <style>${ACTIONS_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="actions-title">${esc(tenant.tenantName)} — controller operation actions</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${enabledCount} of ${m.actions.length} action(s) are permitted from state ${esc(m.state)}.</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="actions-main" data-role="controller-operator"
    data-state="${esc(m.state)}" data-terminal="${m.terminal ? 'true' : 'false'}"
    data-enabled-count="${enabledCount}" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${actionsForm(m)}
  </main>
  <footer>
    <p data-testid="actions-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · operation <code>${esc(m.operationId)}</code>.</p>
  </footer>
</body>
</html>`;
}

export default renderOperationActions;
