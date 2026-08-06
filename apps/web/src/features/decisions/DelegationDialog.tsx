// TrustCircleAI — accessible DELEGATION DIALOG (Phase 4 / User Story 2 / T112 / FR-013, FR-014, AC3,
// AC5 / apps/web/src/features/decisions/DelegationDialog.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The delegator's DELEGATION surface: create a NARROW, non-expanding, bounded-window grant of
// decision authority to a named recipient (AC5), COMPARE the requested grant against the delegator's
// own authority so a privilege-expanding request is visible BEFORE submission (FR-014), DISPLAY the
// existing delegation chain (with circular-chain detection, AC5), and REVOKE an active delegation.
//
// NON-EXPANDING GRANT IS SHOWN, NOT JUST ENFORCED (FR-014). The scope-comparison region renders,
// side by side, the delegator's OWN authority (the actions/scope they hold) and the REQUESTED grant,
// and flags each requested action that is NOT within the delegator's authority as `data-expanding="true"`
// with an explicit textual "expands beyond your authority — not permitted" note. The submit control is
// blocked (aria-disabled + role=alert) while any expansion or circular-chain condition holds. The final
// authority is still enforced server-side (the route + service reject expansion, FR-014) — this view
// makes the reason legible so the delegator does not submit a doomed request.
//
// NO AUTHORITY-GRAPH LEAKAGE (AC3). The dialog discloses ONLY the delegator's own authority and the
// grant being created — never other principals' assignments or authority the recipient will not
// receive. The chain shows delegation EDGES (delegator → recipient, actions, window, status) — the
// scoped disclosure the contract permits.
//
// CIRCULAR + PRIVILEGE-EXPANDING CHAINS (AC5). The chain model carries a `circular` flag and each
// link's status; a circular chain is rendered as a blocking `role=alert`, never a silent accept.
//
// WHY A DEPENDENCY-FREE STRING RENDERER. See DecisionInbox.tsx. Mounted via
// `page.setContent(renderDelegationDialog(props))`.
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

/** The delegator's own authority on the cited assignment — the ceiling a grant may not exceed. */
export interface DelegatorAuthorityVM {
  readonly authorityAssignmentId: string;
  /** The actions the delegator themselves holds (the grant must be a subset). */
  readonly heldActions: readonly string[];
  /** The delegator's own scope, as human key→value rows. */
  readonly scope: readonly { readonly key: string; readonly value: string }[];
}

/** One requested action in the grant, with whether it is within the delegator's authority. */
export interface RequestedActionVM {
  readonly action: string;
  /** true ⇒ this action EXPANDS beyond the delegator's authority (not permitted, FR-014). */
  readonly expanding: boolean;
}

/** The grant being created (recipient, requested actions/scope, window, reason). */
export interface DelegationGrantVM {
  readonly recipientPrincipalId: string;
  readonly requestedActions: readonly RequestedActionVM[];
  readonly requestedScope: readonly { readonly key: string; readonly value: string }[];
  readonly validFromIso: string;
  readonly expiresAtIso: string;
  readonly reasonCode: string;
  readonly reasonText: string;
}

/** One link in the existing delegation chain (a scoped edge; never a full authority graph, AC3). */
export interface DelegationChainLinkVM {
  readonly id: string;
  readonly delegatorPrincipalId: string;
  readonly recipientPrincipalId: string;
  readonly actions: readonly string[];
  readonly validFromIso: string;
  readonly expiresAtIso: string;
  /** active | expired | revoked. */
  readonly status: string;
  /** true ⇒ this link is revocable by the current delegator. */
  readonly revocable: boolean;
}

/** A validation failure the model reports so the dialog re-renders it accessibly. */
export interface DelegationValidationVM {
  readonly field: 'recipient' | 'actions' | 'window' | 'reason_code' | 'reason_text';
  readonly message: string;
}

export interface DelegationDialogModel {
  readonly authorityAssignmentId: string;
  readonly delegatorAuthority: DelegatorAuthorityVM;
  readonly grant: DelegationGrantVM;
  /** The existing delegation chain (scoped edges). */
  readonly chain: readonly DelegationChainLinkVM[];
  /** true ⇒ the chain (or the requested grant) forms a circular delegation (AC5) — blocking. */
  readonly circular: boolean;
  readonly validation: readonly DelegationValidationVM[];
  /** The create + revoke endpoints a shipped client wires. */
  readonly createEndpoint: string;
  readonly revokeEndpoint: string;
  readonly snapshotDigest: string;
}

export interface DelegationDialogProps {
  readonly tenant: TenantScope;
  readonly model: DelegationDialogModel;
}

// ── Derived guards ────────────────────────────────────────────────────────────────────────────────

function hasExpansion(m: DelegationDialogModel): boolean {
  return m.grant.requestedActions.some((a) => a.expanding);
}

function blocked(m: DelegationDialogModel): boolean {
  return hasExpansion(m) || m.circular;
}

// ── Regions ───────────────────────────────────────────────────────────────────────────────────────

function scopeComparisonRegion(m: DelegationDialogModel): string {
  const held = m.delegatorAuthority.heldActions;
  const requestedRows = m.grant.requestedActions
    .map(
      (a) => `
        <tr data-testid="requested-action-row" data-action="${esc(a.action)}" data-expanding="${a.expanding ? 'true' : 'false'}">
          <th scope="row">${esc(a.action)}</th>
          <td data-testid="requested-within-authority">${
            a.expanding
              ? '<strong class="error" data-testid="expanding-flag">expands beyond your authority — not permitted</strong>'
              : 'within your authority'
          }</td>
        </tr>`,
    )
    .join('');
  const heldItems = held.map((h) => `<li data-testid="held-action">${esc(h)}</li>`).join('');
  const heldScope = m.delegatorAuthority.scope
    .map((s) => `<div class="scope-row"><dt>${esc(s.key)}</dt><dd>${esc(s.value)}</dd></div>`)
    .join('');
  return `
      <section id="region-scope-comparison" aria-labelledby="cmp-h" data-testid="scope-comparison" tabindex="-1"
        data-has-expansion="${hasExpansion(m) ? 'true' : 'false'}">
        <h2 id="cmp-h">Scope comparison — your authority vs. the requested grant</h2>
        <p data-testid="comparison-note">A delegation can never grant more than you hold. Any requested action outside your authority is flagged and blocks the grant (it would be rejected).</p>
        <div class="cmp-grid">
          <div data-testid="delegator-authority">
            <h3>Your authority (assignment <code>${esc(m.delegatorAuthority.authorityAssignmentId)}</code>)</h3>
            <ul data-testid="held-actions">${heldItems || '<li data-testid="no-held-actions">no actions held</li>'}</ul>
            <dl>${heldScope || '<div class="scope-row"><dt>—</dt><dd>no scope</dd></div>'}</dl>
          </div>
          <div data-testid="requested-grant">
            <h3>Requested grant to <span data-testid="grant-recipient">${esc(m.grant.recipientPrincipalId)}</span></h3>
            <table>
              <caption>Requested actions and whether each is within your authority</caption>
              <thead><tr><th scope="col">Action</th><th scope="col">Within your authority?</th></tr></thead>
              <tbody>${requestedRows || '<tr><td colspan="2" data-testid="no-requested-actions">no actions requested</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </section>`;
}

function chainRegion(m: DelegationDialogModel): string {
  const rows = m.chain
    .map(
      (l) => `
        <tr data-testid="chain-link" data-delegation-id="${esc(l.id)}" data-status="${esc(l.status)}">
          <th scope="row">${esc(l.delegatorPrincipalId)} → ${esc(l.recipientPrincipalId)}</th>
          <td data-testid="chain-actions">${esc(l.actions.join(', '))}</td>
          <td><time datetime="${esc(l.validFromIso)}">${esc(l.validFromIso)}</time> – <time datetime="${esc(l.expiresAtIso)}">${esc(l.expiresAtIso)}</time></td>
          <td data-testid="chain-status">${esc(l.status)}</td>
          <td data-testid="chain-revoke">${
            l.revocable && l.status === 'active'
              ? `<form method="post" action="${esc(m.revokeEndpoint)}" data-testid="revoke-form" data-delegation-id="${esc(l.id)}">
                   <input type="hidden" name="delegation_id" value="${esc(l.id)}" />
                   <button type="submit" data-testid="revoke-${esc(l.id)}">Revoke</button>
                 </form>`
              : '<span data-testid="not-revocable">not revocable</span>'
          }</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-chain" aria-labelledby="chain-h" data-testid="delegation-chain" tabindex="-1"
        data-circular="${m.circular ? 'true' : 'false'}">
        <h2 id="chain-h">Delegation chain</h2>
        ${
          m.circular
            ? '<p role="alert" data-testid="circular-alert"><strong>Circular delegation detected.</strong> This grant would create a cycle in the delegation chain and is not permitted. Remove the cycle before delegating.</p>'
            : '<p data-testid="no-cycle">No circular delegation detected in this chain.</p>'
        }
        <table>
          <caption>Existing delegation edges (delegator → recipient, actions, window, status, revoke)</caption>
          <thead><tr><th scope="col">Delegator → recipient</th><th scope="col">Actions</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col">Revoke</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" data-testid="no-chain">no existing delegations</td></tr>'}</tbody>
        </table>
      </section>`;
}

function fieldError(
  m: DelegationDialogModel,
  field: DelegationValidationVM['field'],
): { errId: string; message: string } | null {
  const v = m.validation.find((x) => x.field === field);
  if (v === undefined) return null;
  return { errId: `err-delegation-${field}`, message: v.message };
}

function createFormRegion(m: DelegationDialogModel): string {
  const isBlocked = blocked(m);
  const recipientErr = fieldError(m, 'recipient');
  const actionsErr = fieldError(m, 'actions');
  const windowErr = fieldError(m, 'window');
  const codeErr = fieldError(m, 'reason_code');
  const textErr = fieldError(m, 'reason_text');
  const requestedActionsCsv = m.grant.requestedActions.map((a) => a.action).join(', ');
  return `
      <section id="region-create" aria-labelledby="create-h" data-testid="create-delegation" tabindex="-1"
        data-blocked="${isBlocked ? 'true' : 'false'}">
        <h2 id="create-h">Create delegation</h2>
        ${
          isBlocked
            ? `<p role="alert" data-testid="create-blocked">This grant cannot be submitted: ${
                hasExpansion(m) ? 'it requests authority you do not hold' : ''
              }${hasExpansion(m) && m.circular ? '; and ' : ''}${m.circular ? 'it would create a circular delegation' : ''}. Correct it above and retry.</p>`
            : ''
        }
        <form method="post" action="${esc(m.createEndpoint)}" data-testid="delegation-form" aria-labelledby="create-h">
          <input type="hidden" name="authority_assignment_id" value="${esc(m.authorityAssignmentId)}" />
          <div class="field">
            <label for="del-recipient">Recipient principal (required)</label>
            <input id="del-recipient" name="recipient_principal_id" type="text" required aria-required="true"
              value="${esc(m.grant.recipientPrincipalId)}" data-testid="delegation-recipient"
              aria-describedby="hint-del-recipient${recipientErr ? ` ${recipientErr.errId}` : ''}" ${recipientErr ? 'aria-invalid="true"' : ''} />
            <span id="hint-del-recipient" class="hint">The named recipient who receives the bounded grant.</span>
            ${recipientErr ? `<span id="${esc(recipientErr.errId)}" role="alert" class="error" data-testid="recipient-error">${esc(recipientErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="del-actions">Actions (required, comma-separated)</label>
            <input id="del-actions" name="actions" type="text" required aria-required="true"
              value="${esc(requestedActionsCsv)}" data-testid="delegation-actions"
              aria-describedby="hint-del-actions${actionsErr ? ` ${actionsErr.errId}` : ''}" ${actionsErr ? 'aria-invalid="true"' : ''} />
            <span id="hint-del-actions" class="hint">Must be a subset of the actions you hold (see the comparison above).</span>
            ${actionsErr ? `<span id="${esc(actionsErr.errId)}" role="alert" class="error" data-testid="actions-error">${esc(actionsErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="del-valid-from">Valid from (required)</label>
            <input id="del-valid-from" name="valid_from" type="text" required aria-required="true"
              value="${esc(m.grant.validFromIso)}" data-testid="delegation-valid-from" placeholder="RFC3339 date-time" />
          </div>
          <div class="field">
            <label for="del-expires-at">Expires at (required)</label>
            <input id="del-expires-at" name="expires_at" type="text" required aria-required="true"
              value="${esc(m.grant.expiresAtIso)}" data-testid="delegation-expires-at" placeholder="RFC3339 date-time"
              aria-describedby="hint-del-window${windowErr ? ` ${windowErr.errId}` : ''}" ${windowErr ? 'aria-invalid="true"' : ''} />
            <span id="hint-del-window" class="hint">Expiry must be strictly after valid-from; the grant lapses automatically at expiry.</span>
            ${windowErr ? `<span id="${esc(windowErr.errId)}" role="alert" class="error" data-testid="window-error">${esc(windowErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="del-reason-code">Reason code (required)</label>
            <input id="del-reason-code" name="reason_code" type="text" required aria-required="true"
              value="${esc(m.grant.reasonCode)}" data-testid="delegation-reason-code"
              aria-describedby="hint-del-code${codeErr ? ` ${codeErr.errId}` : ''}" ${codeErr ? 'aria-invalid="true"' : ''} />
            <span id="hint-del-code" class="hint">Lower-case identifier, 2–64 chars.</span>
            ${codeErr ? `<span id="${esc(codeErr.errId)}" role="alert" class="error" data-testid="reason-code-error">${esc(codeErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="del-reason-text">Reason (required)</label>
            <textarea id="del-reason-text" name="reason_text" required aria-required="true" rows="3"
              data-testid="delegation-reason-text"
              aria-describedby="hint-del-text${textErr ? ` ${textErr.errId}` : ''}" ${textErr ? 'aria-invalid="true"' : ''}>${esc(m.grant.reasonText)}</textarea>
            <span id="hint-del-text" class="hint">The attributable, audited reason for delegating.</span>
            ${textErr ? `<span id="${esc(textErr.errId)}" role="alert" class="error" data-testid="reason-text-error">${esc(textErr.message)}</span>` : ''}
          </div>
          <button type="submit" data-testid="delegation-submit" ${isBlocked ? 'aria-disabled="true"' : ''}>Create delegation</button>
        </form>
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

const DELEGATION_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div, form { max-width: 100%; }
    main { display: block; } section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; } .scope-row { display: flex; flex-direction: column; } dt { font-weight: 600; } dd { margin: 0; }
    .cmp-grid { display: flex; flex-wrap: wrap; gap: 1.5rem; }
    .cmp-grid > div { flex: 1 1 18rem; min-width: 0; }
    .field { display: flex; flex-direction: column; gap: .25rem; margin: 0 0 .75rem; }
    .field input, .field textarea { font: inherit; padding: .35rem .5rem; max-width: 100%; }
    .field input[aria-invalid="true"], .field textarea[aria-invalid="true"] { outline: 2px solid #b3261e; }
    .hint { color: #444; font-size: .875rem; } .error { color: #b3261e; font-weight: 700; }
    button { font: inherit; padding: .4rem .9rem; border: 1px solid #0b57d0; border-radius: .25rem; background: #0b57d0; color: #fff; cursor: pointer; }
    button[aria-disabled="true"] { background: #999; border-color: #999; cursor: not-allowed; }
    a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the accessible DELEGATION DIALOG as a standalone HTML document, PRESENTING the injected
 * `props.model`. Mounted via `page.setContent(renderDelegationDialog(props))`.
 */
export function renderDelegationDialog(props: DelegationDialogProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — delegate authority</title>
  <style>${DELEGATION_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="delegation-title">Delegate decision authority</h1>
    ${tenantScopeBanner(tenant)}
  </header>
  <main id="main" tabindex="-1" data-testid="delegation-main" data-role="approver"
    data-blocked="${blocked(m) ? 'true' : 'false'}" data-circular="${m.circular ? 'true' : 'false'}"
    data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${scopeComparisonRegion(m)}
    ${chainRegion(m)}
    ${createFormRegion(m)}
  </main>
  <footer>
    <p data-testid="delegation-footer">Scoped to ${esc(tenant.tenantName)} · a delegation grants only a subset of your authority for a bounded window.</p>
  </footer>
</body>
</html>`;
}

export default renderDelegationDialog;
