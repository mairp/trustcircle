// TrustCircleAI — accessible DECISION ACTION FORMS (Phase 4 / User Story 2 / T111 /
// apps/web/src/features/decisions/DecisionActions.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The reviewer's ACTION surface: the accessible forms that submit a decision — approve, deny,
// request changes, escalate, expire, or cancel — each with a MANDATORY structured reason
// (FR-012, SC-004), each binding the submission to the CURRENT package ETag (If-Match, AC2/AC4),
// and each RETAINING the reviewer's input when validation fails (Acceptance Scenario, no lost work).
//
// MANDATORY REASON (FR-012 / SC-004). Every form carries a required `reason.code` + `reason.text`.
// When the injected model reports a validation failure (a missing/blank reason, an invalid code),
// the form renders the failure as a `role=alert` error tied to the field via `aria-describedby` +
// `aria-invalid`, AND re-populates the fields with the reviewer's previously-entered values (the
// model carries `retainedCode`/`retainedText`) so a rejected submission never discards their reason.
//
// ONLY PERMITTED VERBS ARE OFFERED. The form set is the reviewer's `allowedActions` (already
// authority/SoD-filtered by the projector). A verb the reviewer may not take is NOT rendered as a
// disabled control that leaks intent — it is absent, and a textual note explains view-only state.
// This is the boundary discipline the inbox/detail views established.
//
// STALE-PACKAGE GUARD (AC4). Each form submits to the action endpoint with the CURRENT `If-Match`
// ETag as a hidden field, and when the package changed since review began the model marks the form
// group `data-rereview-required="true"` and renders a blocking `role=alert` — a reviewer cannot
// submit against a package they did not actually see.
//
// WHY A DEPENDENCY-FREE STRING RENDERER. See DecisionInbox.tsx. Mounted via
// `page.setContent(renderDecisionActions(props))`; forms are real accessible `<form>`s a shipped
// client wires to the POST /decisions/{id}/actions endpoint.
//
// DETERMINISM. Pure string builders over the injected model. Same props ⇒ byte-identical output.

import type { TenantScope } from '../../app/layout.tsx';

export type { TenantScope };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The six reviewer verbs these forms can submit (subset of the domain alphabet; `delegate` has its
 *  own dialog — see DelegationDialog.tsx). */
export const DECISION_ACTION_VERBS = [
  'approve',
  'deny',
  'request_changes',
  'escalate',
  'expire',
  'cancel',
] as const;
export type DecisionActionVerb = (typeof DECISION_ACTION_VERBS)[number];

/** A human label + short guidance for each verb. */
const VERB_META: Readonly<Record<DecisionActionVerb, { label: string; hint: string }>> = {
  approve: { label: 'Approve', hint: 'Permit the requested action to proceed.' },
  deny: { label: 'Deny', hint: 'Refuse the requested action.' },
  request_changes: { label: 'Request changes', hint: 'Return the request to the requester for revision.' },
  escalate: { label: 'Escalate', hint: 'Raise the decision to a higher authority.' },
  expire: { label: 'Expire', hint: 'Close a lapsed decision without approving it.' },
  cancel: { label: 'Cancel', hint: 'Withdraw the decision request.' },
};

/** A reason-validation failure the model reports so the form re-renders it accessibly (FR-012). */
export interface ReasonValidationVM {
  /** The verb whose submission failed. */
  readonly verb: DecisionActionVerb;
  /** The field the error is anchored to. */
  readonly field: 'code' | 'text';
  /** The human, non-color error message. */
  readonly message: string;
}

export interface DecisionActionsModel {
  readonly decisionId: string;
  readonly version: number;
  /** The CURRENT package ETag every action must carry as If-Match (AC2/AC4). */
  readonly etag: string;
  readonly status: string;
  /** The verbs the reviewer may currently take (subset of DECISION_ACTION_VERBS). Empty ⇒ view-only. */
  readonly allowedVerbs: readonly DecisionActionVerb[];
  /** true ⇒ the package changed since review began; every form is blocked until re-review (AC4). */
  readonly reReviewRequired: boolean;
  /** The reason value to RETAIN in the code field after a failed submit (empty ⇒ none). */
  readonly retainedCode: string;
  /** The reason value to RETAIN in the text field after a failed submit (empty ⇒ none). */
  readonly retainedText: string;
  /** The verb whose form the retained input + validation error belong to (undefined ⇒ none). */
  readonly retainedVerb?: DecisionActionVerb;
  /** The active validation failures to render (empty ⇒ none). */
  readonly validation: readonly ReasonValidationVM[];
  /** The action endpoint the forms POST to (a shipped client wires the real fetch). */
  readonly actionEndpoint: string;
  readonly snapshotDigest: string;
}

export interface DecisionActionsProps {
  readonly tenant: TenantScope;
  readonly model: DecisionActionsModel;
}

// ── Form rendering ────────────────────────────────────────────────────────────────────────────────

function fieldError(
  m: DecisionActionsModel,
  verb: DecisionActionVerb,
  field: 'code' | 'text',
): { errId: string; message: string } | null {
  const v = m.validation.find((x) => x.verb === verb && x.field === field);
  if (v === undefined) return null;
  return { errId: `err-${verb}-${field}`, message: v.message };
}

function actionForm(m: DecisionActionsModel, verb: DecisionActionVerb): string {
  const meta = VERB_META[verb];
  const isRetained = m.retainedVerb === verb;
  const codeVal = isRetained ? m.retainedCode : '';
  const textVal = isRetained ? m.retainedText : '';
  const codeErr = fieldError(m, verb, 'code');
  const textErr = fieldError(m, verb, 'text');
  const codeDescribed = `hint-${verb}-code${codeErr ? ` ${codeErr.errId}` : ''}`;
  const textDescribed = `hint-${verb}-text${textErr ? ` ${textErr.errId}` : ''}`;
  const blocked = m.reReviewRequired;
  return `
        <form
          class="action-form"
          data-testid="action-form"
          data-action="${esc(verb)}"
          data-rereview-required="${blocked ? 'true' : 'false'}"
          method="post"
          action="${esc(m.actionEndpoint)}"
          aria-labelledby="form-${esc(verb)}-h"
        >
          <h3 id="form-${esc(verb)}-h">${esc(meta.label)}</h3>
          <p id="hint-${esc(verb)}" data-testid="action-hint">${esc(meta.hint)}</p>
          <input type="hidden" name="action" value="${esc(verb)}" />
          <input type="hidden" name="if_match" value="${esc(m.etag)}" data-testid="if-match-${esc(verb)}" />
          ${
            blocked
              ? `<p role="alert" data-testid="rereview-block-${esc(verb)}">The decision package changed since you began review. Re-review the current package before submitting a ${esc(meta.label.toLowerCase())}.</p>`
              : ''
          }
          <div class="field">
            <label for="${esc(verb)}-code">Reason code (required)</label>
            <input
              id="${esc(verb)}-code"
              name="reason_code"
              type="text"
              required
              aria-required="true"
              value="${esc(codeVal)}"
              aria-describedby="${codeDescribed}"
              ${codeErr ? 'aria-invalid="true"' : ''}
              data-testid="reason-code-${esc(verb)}"
              placeholder="e.g. controls_verified"
            />
            <span id="hint-${esc(verb)}-code" class="hint">Lower-case identifier, 2–64 chars.</span>
            ${codeErr ? `<span id="${esc(codeErr.errId)}" role="alert" class="error" data-testid="reason-code-error-${esc(verb)}">${esc(codeErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="${esc(verb)}-text">Reason (required)</label>
            <textarea
              id="${esc(verb)}-text"
              name="reason_text"
              required
              aria-required="true"
              rows="3"
              aria-describedby="${textDescribed}"
              ${textErr ? 'aria-invalid="true"' : ''}
              data-testid="reason-text-${esc(verb)}"
              placeholder="State the attributable basis for this ${esc(meta.label.toLowerCase())}."
            >${esc(textVal)}</textarea>
            <span id="hint-${esc(verb)}-text" class="hint">3–4000 characters; this is the attributable, audited reason.</span>
            ${textErr ? `<span id="${esc(textErr.errId)}" role="alert" class="error" data-testid="reason-text-error-${esc(verb)}">${esc(textErr.message)}</span>` : ''}
          </div>
          <button type="submit" data-testid="submit-${esc(verb)}" ${blocked ? 'aria-disabled="true"' : ''}>${esc(meta.label)}</button>
        </form>`;
}

function formsRegion(m: DecisionActionsModel): string {
  if (m.allowedVerbs.length === 0) {
    return `
      <section id="region-actions" aria-labelledby="actions-h" data-testid="decision-actions" tabindex="-1" data-view-only="true">
        <h2 id="actions-h">Actions</h2>
        <p data-testid="view-only-note">You have no actions available on this decision — it is view-only for you. This may be because you lack authority, have a separation-of-duties conflict, or the package is in a terminal state.</p>
      </section>`;
  }
  const forms = m.allowedVerbs.map((v) => actionForm(m, v)).join('');
  return `
      <section id="region-actions" aria-labelledby="actions-h" data-testid="decision-actions" tabindex="-1"
        data-allowed-actions="${esc(m.allowedVerbs.join(' '))}" data-rereview-required="${m.reReviewRequired ? 'true' : 'false'}">
        <h2 id="actions-h">Actions</h2>
        <p data-testid="actions-note">
          Every action requires a structured reason (it is recorded as the attributable, audited basis).
          If a submission is rejected, your reason is kept so you can correct and resubmit. Each action
          binds to the current package version (${m.version}); if the package changed, you must re-review first.
        </p>
        ${forms}
      </section>`;
}

function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section aria-labelledby="scope-h" data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}" data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}" data-work-item-id="${esc(tenant.workItemId)}" data-role="approver">
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
        </dl>
      </section>`;
}

const ACTIONS_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div, form { max-width: 100%; }
    main { display: block; } section { margin: 0 0 1.5rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; } dt { font-weight: 600; } dd { margin: 0; }
    .action-form { border: 1px solid #999; border-radius: .35rem; padding: .75rem; margin: 0 0 1rem; }
    .field { display: flex; flex-direction: column; gap: .25rem; margin: 0 0 .75rem; }
    .field input, .field textarea { font: inherit; padding: .35rem .5rem; max-width: 100%; }
    .field input[aria-invalid="true"], .field textarea[aria-invalid="true"] { outline: 2px solid #b3261e; }
    .hint { color: #444; font-size: .875rem; }
    .error { color: #b3261e; font-weight: 700; }
    button { font: inherit; padding: .4rem .9rem; border: 1px solid #0b57d0; border-radius: .25rem; background: #0b57d0; color: #fff; cursor: pointer; }
    button[aria-disabled="true"] { background: #999; border-color: #999; cursor: not-allowed; }
    a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the accessible DECISION ACTION FORMS as a standalone HTML document, PRESENTING the injected
 * `props.model`. Mounted via `page.setContent(renderDecisionActions(props))`.
 */
export function renderDecisionActions(props: DecisionActionsProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — act on decision ${esc(m.decisionId)}</title>
  <style>${ACTIONS_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="actions-title">Act on decision ${esc(m.decisionId)}</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">Package version ${m.version}; status ${esc(m.status)}.</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="actions-main" data-role="approver"
    data-decision-id="${esc(m.decisionId)}" data-version="${m.version}" data-etag="${esc(m.etag)}"
    data-rereview-required="${m.reReviewRequired ? 'true' : 'false'}"
    data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${formsRegion(m)}
  </main>
  <footer>
    <p data-testid="actions-footer">Scoped to ${esc(tenant.tenantName)} · decision <code>${esc(m.decisionId)}</code>.</p>
  </footer>
</body>
</html>`;
}

export default renderDecisionActions;
