// TrustCircleAI — accessible EMERGENCY INTERVENTION (break-glass) UI (Phase 4 / User Story 2 / T114 /
// apps/web/src/features/operations/EmergencyIntervention.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The operator's EMERGENCY-STOP surface: an accessible break-glass control to halt an in-flight
// governed operation when something is going wrong, with (1) an explicit CONSEQUENCE WARNING before
// the stop, (2) a deliberate two-step STOP CONFIRMATION that cannot be triggered by a single stray
// activation, and (3) a mandatory POST-EVENT REVIEW record after any break-glass use.
//
// BREAK-GLASS NEVER CONFERS DECISION AUTHORITY (the phase invariant). Emergency intervention can
// STOP or CONTAIN — it can never APPROVE, and it never grants the operator decision authority they
// did not already hold. This view states that in text and marks the surface
// `data-confers-decision-authority="false"`; the stop form submits an intervention (halt), never a
// decision. The consequence warning names what the stop will and will NOT do.
//
// MANDATORY POST-EVENT REVIEW (accountability). Every break-glass activation requires a follow-up
// review: who invoked it, why (a mandatory reason), what was stopped, and the accountable sign-off.
// When the model reports an intervention occurred whose post-event review is still OPEN, the view
// renders a blocking `role=alert` that the review is outstanding — a break-glass use is never left
// unaccounted for.
//
// TWO-STEP CONFIRMATION (safety). The stop is a real accessible `<form>` requiring an explicit typed
// confirmation phrase + a mandatory reason; the submit is `aria-disabled` until the confirmation
// state is armed (the model carries `armed`). A validation failure retains the operator's input and
// is surfaced as a `role=alert` tied to the field — the operator never silently loses their reason.
//
// WHY A DEPENDENCY-FREE STRING RENDERER. See ../decisions/DecisionInbox.tsx. Mounted via
// `page.setContent(renderEmergencyIntervention(props))`.
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

/** The in-flight operation the break-glass control targets. */
export interface TargetOperationVM {
  readonly operationId: string;
  readonly workItemId: string;
  readonly summary: string;
  /** running | paused | completing. */
  readonly status: string;
  readonly startedAtIso: string;
}

/** One consequence the stop will (or will not) have — stated in text before the operator confirms. */
export interface ConsequenceVM {
  readonly summary: string;
  /** 'will' ⇒ the stop causes this; 'will_not' ⇒ the stop explicitly does NOT do this. */
  readonly effect: 'will' | 'will_not';
}

/** A validation failure the model reports so the confirmation form re-renders it accessibly. */
export interface InterventionValidationVM {
  readonly field: 'confirmation' | 'reason_code' | 'reason_text';
  readonly message: string;
}

/** A prior break-glass event whose post-event review may still be open (accountability). */
export interface BreakGlassEventVM {
  readonly id: string;
  readonly invokerPrincipalId: string;
  readonly reasonText: string;
  readonly stoppedOperationId: string;
  readonly occurredAtIso: string;
  /** true iff the mandatory post-event review has been completed. */
  readonly reviewComplete: boolean;
  /** The accountable reviewer (empty ⇒ review still open). */
  readonly reviewerPrincipalId: string;
}

export interface EmergencyInterventionModel {
  readonly target: TargetOperationVM;
  readonly consequences: readonly ConsequenceVM[];
  /** true ⇒ the two-step confirmation is armed (submit enabled). */
  readonly armed: boolean;
  /** The exact phrase the operator must type to confirm (shown so it is legible + typeable). */
  readonly confirmationPhrase: string;
  /** Retained operator input after a failed submit (empty ⇒ none). */
  readonly retainedConfirmation: string;
  readonly retainedReasonCode: string;
  readonly retainedReasonText: string;
  readonly validation: readonly InterventionValidationVM[];
  /** Prior break-glass events (their post-event reviews may be open). */
  readonly priorEvents: readonly BreakGlassEventVM[];
  /** The intervention (stop) endpoint a shipped client wires. */
  readonly stopEndpoint: string;
  readonly snapshotDigest: string;
}

export interface EmergencyInterventionProps {
  readonly tenant: TenantScope;
  readonly model: EmergencyInterventionModel;
}

// ── Derived ───────────────────────────────────────────────────────────────────────────────────────

function openReviews(m: EmergencyInterventionModel): readonly BreakGlassEventVM[] {
  return m.priorEvents.filter((e) => !e.reviewComplete);
}

// ── Regions ───────────────────────────────────────────────────────────────────────────────────────

function authorityNotice(): string {
  return `
      <section id="region-authority-notice" aria-labelledby="notice-h" data-testid="authority-notice" tabindex="-1"
        data-confers-decision-authority="false">
        <h2 id="notice-h">Emergency authority is limited</h2>
        <p data-testid="no-decision-authority">
          <strong>Break-glass emergency intervention can STOP or CONTAIN an operation. It can never
          APPROVE a decision, and it does not grant you any decision authority you do not already hold.</strong>
          Every use is recorded and requires a post-event review.
        </p>
      </section>`;
}

function targetRegion(m: EmergencyInterventionModel): string {
  const t = m.target;
  return `
      <section id="region-target" aria-labelledby="target-h" data-testid="target-operation" tabindex="-1"
        data-operation-id="${esc(t.operationId)}" data-status="${esc(t.status)}">
        <h2 id="target-h">Operation to stop</h2>
        <dl>
          <div class="scope-row"><dt>Operation</dt><dd data-testid="target-operation-id"><code>${esc(t.operationId)}</code></dd></div>
          <div class="scope-row"><dt>Work item</dt><dd data-testid="target-work-item"><code>${esc(t.workItemId)}</code></dd></div>
          <div class="scope-row"><dt>Summary</dt><dd data-testid="target-summary">${esc(t.summary)}</dd></div>
          <div class="scope-row"><dt>Status</dt><dd data-testid="target-status">${esc(t.status)}</dd></div>
          <div class="scope-row"><dt>Started</dt><dd><time datetime="${esc(t.startedAtIso)}" data-testid="target-started">${esc(t.startedAtIso)}</time></dd></div>
        </dl>
      </section>`;
}

function consequenceRegion(m: EmergencyInterventionModel): string {
  const will = m.consequences.filter((c) => c.effect === 'will');
  const willNot = m.consequences.filter((c) => c.effect === 'will_not');
  const willItems = will
    .map((c) => `<li data-testid="consequence-will">${esc(c.summary)}</li>`)
    .join('');
  const willNotItems = willNot
    .map((c) => `<li data-testid="consequence-will-not">${esc(c.summary)}</li>`)
    .join('');
  return `
      <section id="region-consequences" aria-labelledby="cons-h" data-testid="consequence-warning" tabindex="-1">
        <h2 id="cons-h">Consequence warning</h2>
        <p role="alert" data-testid="consequence-alert"><strong>Read before you stop.</strong> Stopping this operation has consequences. Confirm you understand what it will and will not do.</p>
        <h3>Stopping WILL:</h3>
        <ul data-testid="consequences-will">${willItems || '<li>halt the in-flight operation at its current step</li>'}</ul>
        <h3>Stopping WILL NOT:</h3>
        <ul data-testid="consequences-will-not">${willNotItems || '<li data-testid="default-will-not">approve any decision or grant you decision authority</li>'}</ul>
      </section>`;
}

function fieldError(
  m: EmergencyInterventionModel,
  field: InterventionValidationVM['field'],
): { errId: string; message: string } | null {
  const v = m.validation.find((x) => x.field === field);
  if (v === undefined) return null;
  return { errId: `err-intervention-${field}`, message: v.message };
}

function stopFormRegion(m: EmergencyInterventionModel): string {
  const confErr = fieldError(m, 'confirmation');
  const codeErr = fieldError(m, 'reason_code');
  const textErr = fieldError(m, 'reason_text');
  return `
      <section id="region-stop" aria-labelledby="stop-h" data-testid="stop-confirmation" tabindex="-1"
        data-armed="${m.armed ? 'true' : 'false'}">
        <h2 id="stop-h">Confirm emergency stop</h2>
        <p data-testid="stop-note">This is a deliberate two-step action. Type the confirmation phrase exactly and give a mandatory reason. Your input is retained if the stop is rejected.</p>
        <form method="post" action="${esc(m.stopEndpoint)}" data-testid="stop-form" aria-labelledby="stop-h">
          <input type="hidden" name="operation_id" value="${esc(m.target.operationId)}" />
          <input type="hidden" name="intervention" value="emergency_stop" />
          <div class="field">
            <label for="stop-confirmation">Type <code data-testid="confirmation-phrase">${esc(m.confirmationPhrase)}</code> to confirm (required)</label>
            <input id="stop-confirmation" name="confirmation" type="text" required aria-required="true"
              value="${esc(m.retainedConfirmation)}" data-testid="stop-confirmation-input"
              aria-describedby="hint-stop-confirmation${confErr ? ` ${confErr.errId}` : ''}" ${confErr ? 'aria-invalid="true"' : ''} />
            <span id="hint-stop-confirmation" class="hint">Exact match required — this prevents accidental activation.</span>
            ${confErr ? `<span id="${esc(confErr.errId)}" role="alert" class="error" data-testid="confirmation-error">${esc(confErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="stop-reason-code">Reason code (required)</label>
            <input id="stop-reason-code" name="reason_code" type="text" required aria-required="true"
              value="${esc(m.retainedReasonCode)}" data-testid="stop-reason-code"
              aria-describedby="hint-stop-code${codeErr ? ` ${codeErr.errId}` : ''}" ${codeErr ? 'aria-invalid="true"' : ''} />
            <span id="hint-stop-code" class="hint">Lower-case identifier, 2–64 chars.</span>
            ${codeErr ? `<span id="${esc(codeErr.errId)}" role="alert" class="error" data-testid="reason-code-error">${esc(codeErr.message)}</span>` : ''}
          </div>
          <div class="field">
            <label for="stop-reason-text">Reason (required)</label>
            <textarea id="stop-reason-text" name="reason_text" required aria-required="true" rows="3"
              data-testid="stop-reason-text"
              aria-describedby="hint-stop-text${textErr ? ` ${textErr.errId}` : ''}" ${textErr ? 'aria-invalid="true"' : ''}>${esc(m.retainedReasonText)}</textarea>
            <span id="hint-stop-text" class="hint">The attributable, audited reason for the emergency stop.</span>
            ${textErr ? `<span id="${esc(textErr.errId)}" role="alert" class="error" data-testid="reason-text-error">${esc(textErr.message)}</span>` : ''}
          </div>
          <button type="submit" class="danger" data-testid="stop-submit" ${m.armed ? '' : 'aria-disabled="true"'}>Stop operation now</button>
          ${m.armed ? '' : '<p data-testid="not-armed-note">Confirmation not armed — type the exact phrase to enable the stop.</p>'}
        </form>
      </section>`;
}

function postEventReviewRegion(m: EmergencyInterventionModel): string {
  const open = openReviews(m);
  const rows = m.priorEvents
    .map(
      (e) => `
        <tr data-testid="break-glass-row" data-event-id="${esc(e.id)}" data-review-complete="${e.reviewComplete ? 'true' : 'false'}">
          <th scope="row"><time datetime="${esc(e.occurredAtIso)}">${esc(e.occurredAtIso)}</time></th>
          <td data-testid="bg-invoker">${esc(e.invokerPrincipalId)}</td>
          <td data-testid="bg-stopped">${esc(e.stoppedOperationId)}</td>
          <td data-testid="bg-reason">${esc(e.reasonText)}</td>
          <td data-testid="bg-review-status">${
            e.reviewComplete
              ? `reviewed by ${esc(e.reviewerPrincipalId)}`
              : '<strong class="error" data-testid="bg-review-open">post-event review OUTSTANDING</strong>'
          }</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-post-event" aria-labelledby="pe-h" data-testid="post-event-review" tabindex="-1"
        data-open-reviews="${open.length}">
        <h2 id="pe-h">Post-event review</h2>
        ${
          open.length > 0
            ? `<p role="alert" data-testid="open-reviews-alert"><strong>${open.length} break-glass use(s) await a mandatory post-event review.</strong> A break-glass activation is never left unaccounted for — complete the outstanding review(s).</p>`
            : '<p data-testid="no-open-reviews">All prior break-glass uses have a completed post-event review.</p>'
        }
        <table>
          <caption>Break-glass activations and their mandatory post-event reviews (when, invoker, stopped operation, reason, review status)</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Invoker</th><th scope="col">Stopped operation</th><th scope="col">Reason</th><th scope="col">Review status</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" data-testid="no-prior-events">no prior break-glass activations</td></tr>'}</tbody>
        </table>
      </section>`;
}

function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section aria-labelledby="scope-h" data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}" data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}" data-work-item-id="${esc(tenant.workItemId)}" data-role="operator">
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
        </dl>
      </section>`;
}

const EMERGENCY_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div, form { max-width: 100%; }
    main { display: block; } section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; } dt { font-weight: 600; } dd { margin: 0; }
    ul { margin: .25rem 0; padding-left: 1.25rem; }
    .field { display: flex; flex-direction: column; gap: .25rem; margin: 0 0 .75rem; }
    .field input, .field textarea { font: inherit; padding: .35rem .5rem; max-width: 100%; }
    .field input[aria-invalid="true"], .field textarea[aria-invalid="true"] { outline: 2px solid #b3261e; }
    .hint { color: #444; font-size: .875rem; } .error { color: #b3261e; font-weight: 700; }
    [role="alert"] { font-weight: 700; }
    button { font: inherit; padding: .4rem .9rem; border: 1px solid #0b57d0; border-radius: .25rem; background: #0b57d0; color: #fff; cursor: pointer; }
    button.danger { background: #b3261e; border-color: #b3261e; }
    button[aria-disabled="true"] { background: #999; border-color: #999; cursor: not-allowed; }
    a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the accessible EMERGENCY INTERVENTION (break-glass) surface as a standalone HTML document,
 * PRESENTING the injected `props.model`. Mounted via `page.setContent(renderEmergencyIntervention(props))`.
 */
export function renderEmergencyIntervention(props: EmergencyInterventionProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — emergency intervention</title>
  <style>${EMERGENCY_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="emergency-title">Emergency intervention — break glass</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">Break-glass can stop, never approve. ${openReviews(m).length} post-event review(s) outstanding.</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="emergency-main" data-role="operator"
    data-operation-id="${esc(m.target.operationId)}" data-armed="${m.armed ? 'true' : 'false'}"
    data-confers-decision-authority="false" data-open-reviews="${openReviews(m).length}"
    data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${authorityNotice()}
    ${targetRegion(m)}
    ${consequenceRegion(m)}
    ${stopFormRegion(m)}
    ${postEventReviewRegion(m)}
  </main>
  <footer>
    <p data-testid="emergency-footer">Scoped to ${esc(tenant.tenantName)} · break-glass never confers decision authority · every use is reviewed.</p>
  </footer>
</body>
</html>`;
}

export default renderEmergencyIntervention;
