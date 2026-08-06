// TrustCircleAI — accessible REMEDIATION DETAIL / control panel (Phase 5 / User Story 3 / T146 /
// apps/web/src/features/integrity/RemediationDetail.tsx / FR-018, FR-020, FR-021, FR-022, GAR-004,
// SC-007, SC-008).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The reviewer-facing REMEDIATION DETAIL for one integrity case: the recommended remediation plan,
// each step's risk classification and pre-authorization status, the four available action MODES
// (recommend-only / simulate / request-approval / execute-if-pre-authorized), the kill-switch/rollback
// controls, the running attempt's fail-visible outcome, and — decisively — the INDEPENDENT nine-gate
// verification result that alone can close the case. It answers "what does the system recommend, what
// may be executed automatically, what happened, and is it VERIFIED-closed?" as a PURE PRESENTER.
//
// THE AUTHORIZATION + THE CLOSURE VERDICT ARE NOT COMPUTED HERE. Whether a step is pre-authorized
// low-risk (GAR-004), whether the attempt succeeded/failed/uncertain/stopped/blocked, and whether the
// case is verified-closed all come from the REAL @trustcircle/authz + @trustcircle/application +
// @trustcircle/domain surfaces. This view renders the injected model verbatim. It NEVER re-derives
// authorization and — the load-bearing rule (FR-022) — NEVER converts a repair's own reported success,
// or a source-reported `done`, into closure: closure is shown ONLY when an independent verification
// verdict says every gate passed. An un-fed panel reports "NOT verified-closed", never "closed".
//
// EXECUTE IS GATED IN THE TEXT, NOT BY COLOR (WCAG 1.4.1). The "execute if pre-authorized" control is
// disabled unless EVERY step is pre-authorized low-risk, and the reason is a sentence with a
// machine-readable `data-execute-enabled` + `data-execute-blocked-reason`. A high-risk / destructive
// step is labelled with the word "requires approval", never a bare color.
//
// KILL SWITCH + ROLLBACK ARE ALWAYS PRESENT. The stop control and the rollback control are rendered
// whenever an attempt is in flight or applied, with explicit textual state — so a reviewer can always
// halt or reverse, and a running attempt can never hide its stop affordance.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — pure string-builder presenters. The output is a self-contained
// HTML string the e2e spec mounts via `page.setContent(renderRemediationDetail(props))` and asserts
// through axe-core + the live accessibility tree, with no web server, no React, no tenant-auth.
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

// ── The remediation detail view model ──────────────────────────────────────────────────────────

/** The four contract-defined action modes (mirrors REMEDIATION_MODES in the API route). */
export type RemediationMode =
  | 'recommend_only'
  | 'simulate'
  | 'request_approval'
  | 'execute_if_pre_authorized';

export const REMEDIATION_MODE_LABELS: Readonly<Record<RemediationMode, string>> = {
  recommend_only: 'Recommend only (no change)',
  simulate: 'Simulate (dry run, no change)',
  request_approval: 'Request human approval',
  execute_if_pre_authorized: 'Execute if pre-authorized (low-risk only)',
} as const;

/** One recommended remediation step with its risk + pre-authorization status (GAR-004). */
export interface RemediationStepVM {
  readonly stepId: string;
  readonly ordinal: number;
  readonly description: string;
  readonly riskClass: 'low' | 'medium' | 'high' | 'destructive' | string;
  /** AUTHORITATIVE — this step is pre-authorized low-risk and MAY execute automatically. */
  readonly preAuthorizedLowRisk: boolean;
  /** True iff this step is reversible (has a defined rollback). */
  readonly reversible: boolean;
  /** Why it is not auto-executable (empty ⇒ auto-executable). */
  readonly gateReason: string;
}

/** The running/last remediation attempt's fail-visible outcome. */
export interface RemediationAttemptVM {
  readonly attemptId: string;
  /** succeeded_unverified is NOT closure — verification is independent (FR-022). */
  readonly outcome:
    | 'none'
    | 'in_progress'
    | 'succeeded_unverified'
    | 'failed'
    | 'uncertain'
    | 'stopped'
    | 'blocked';
  readonly startedAtIso: string;
  readonly stepsAttempted: number;
  readonly stepsTotal: number;
  /** The safe next action for this outcome (never empty for a terminal non-success). */
  readonly safeNextAction: string;
  /** True iff a kill switch is currently engaged. */
  readonly killEngaged: boolean;
  /** True iff applied effects can still be rolled back. */
  readonly rollbackAvailable: boolean;
  /** The attempt's audit event id witness (empty when no attempt). */
  readonly auditEventId: string;
}

/** The INDEPENDENT verification result — the only thing that closes the case (FR-022). */
export interface VerificationResultVM {
  readonly verificationId: string;
  /** True iff EVERY one of the nine gates passed (the closure condition). */
  readonly allGatesPassed: boolean;
  /** Per-gate pass/fail (shown as words). */
  readonly gates: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  /** True iff the case is verified-closed (allGatesPassed AND recorded closure). */
  readonly caseClosed: boolean;
  /** Why closure is not realized (empty ⇒ closed). */
  readonly closureBlocked: readonly string[];
}

export interface RemediationDetailModel {
  readonly caseId: string;
  readonly workItemId: string;
  readonly problemClass: string;
  readonly severity: string;
  readonly ownerPrincipalId: string;
  readonly ownershipGap: boolean;
  readonly planId: string;
  readonly planVersion: number;
  readonly recommendation: string;
  readonly steps: readonly RemediationStepVM[];
  readonly availableModes: readonly RemediationMode[];
  readonly attempt: RemediationAttemptVM;
  readonly verification: VerificationResultVM;
  /** A non-color-only one-sentence summary of the case posture (WCAG 1.4.1). */
  readonly summary: string;
}

/** An EMPTY-but-valid model — an un-fed detail CANNOT masquerade as a closed/executed one. */
export const EMPTY_REMEDIATION_DETAIL: RemediationDetailModel = {
  caseId: '',
  workItemId: '',
  problemClass: 'unknown',
  severity: 'unknown',
  ownerPrincipalId: '',
  ownershipGap: true,
  planId: '',
  planVersion: 0,
  recommendation: 'No remediation plan has been loaded for this case.',
  steps: [],
  // No plan ⇒ no mode is auto-executable; only the safe read-only modes are offered.
  availableModes: ['recommend_only', 'simulate'],
  attempt: {
    attemptId: '',
    outcome: 'none',
    startedAtIso: '1970-01-01T00:00:00.000Z',
    stepsAttempted: 0,
    stepsTotal: 0,
    safeNextAction: 'Load a remediation plan.',
    killEngaged: false,
    rollbackAvailable: false,
    auditEventId: '',
  },
  verification: {
    verificationId: '',
    allGatesPassed: false,
    gates: [],
    caseClosed: false,
    closureBlocked: ['no verification has been run'],
  },
  summary: 'No remediation plan is loaded; the case is NOT verified-closed.',
} as const;

export interface RemediationDetailProps {
  readonly tenant: TenantScope;
  readonly model: RemediationDetailModel;
}

// ── Execute-gating — computed ONLY from the injected step authorizations ────────────────────────

interface ExecuteGate {
  readonly enabled: boolean;
  readonly reason: string;
}

/** The execute-if-pre-authorized control is enabled ONLY when every step is pre-authorized low-risk. */
function executeGate(m: RemediationDetailModel): ExecuteGate {
  if (m.steps.length === 0) {
    return { enabled: false, reason: 'No steps to execute; load a plan first.' };
  }
  if (!m.availableModes.includes('execute_if_pre_authorized')) {
    return { enabled: false, reason: 'Automatic execution is not offered for this case.' };
  }
  const notAuthed = m.steps.filter((s) => !s.preAuthorizedLowRisk);
  if (notAuthed.length > 0) {
    const names = notAuthed.map((s) => `step ${s.ordinal} (${s.riskClass})`).join(', ');
    return {
      enabled: false,
      reason: `Requires human approval: ${names} is not pre-authorized low-risk.`,
    };
  }
  if (m.ownershipGap) {
    return { enabled: false, reason: 'Ownership gap — no owner to accept resolution; routed for assignment.' };
  }
  return { enabled: true, reason: 'All steps are pre-authorized low-risk and reversible.' };
}

// ── Plan + steps region ─────────────────────────────────────────────────────────────────────────

function stepRow(s: RemediationStepVM): string {
  const auth = s.preAuthorizedLowRisk
    ? '<span data-testid="step-auth" data-pre-authorized="true">pre-authorized low-risk</span>'
    : `<strong class="warn" data-testid="step-auth" data-pre-authorized="false">requires approval — ${esc(
        s.gateReason || 'not pre-authorized low-risk',
      )}</strong>`;
  return `
          <tr data-testid="remediation-step" data-step-id="${esc(s.stepId)}" data-ordinal="${s.ordinal}"
            data-risk-class="${esc(s.riskClass)}" data-pre-authorized="${s.preAuthorizedLowRisk ? 'true' : 'false'}"
            data-reversible="${s.reversible ? 'true' : 'false'}">
            <th scope="row" data-testid="step-ordinal">${s.ordinal}</th>
            <td data-testid="step-desc">${esc(s.description)}</td>
            <td data-testid="step-risk">${esc(s.riskClass)}</td>
            <td data-testid="step-reversible">${s.reversible ? 'reversible' : 'NOT reversible'}</td>
            <td data-testid="step-auth-cell">${auth}</td>
          </tr>`;
}

function planRegion(m: RemediationDetailModel): string {
  const rows =
    m.steps.length > 0
      ? m.steps.map(stepRow).join('')
      : `<tr data-testid="step-empty-row"><td colspan="5">No remediation steps are loaded.</td></tr>`;
  const authed = m.steps.filter((s) => s.preAuthorizedLowRisk).length;
  return `
      <section id="region-plan" aria-labelledby="plan-h" data-testid="remediation-plan" tabindex="-1"
        data-plan-id="${esc(m.planId)}" data-plan-version="${m.planVersion}"
        data-authorized-steps="${authed}" data-total-steps="${m.steps.length}">
        <h2 id="plan-h">Recommended remediation plan</h2>
        <p data-testid="plan-recommendation">${esc(m.recommendation)}</p>
        <p id="plan-summary" data-testid="plan-summary">
          ${authed} of ${m.steps.length} step(s) are pre-authorized low-risk. Automatic execution
          applies ONLY to pre-authorized low-risk steps; any other step requires human approval
          (stated in the row, not by color).
        </p>
        <table aria-describedby="plan-summary">
          <caption>Remediation steps (ordinal, description, risk class, reversibility, authorization)</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Step</th>
              <th scope="col">Risk</th>
              <th scope="col">Reversible</th>
              <th scope="col">Authorization</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── Action modes + controls region ──────────────────────────────────────────────────────────────

function modeControls(m: RemediationDetailModel, gate: ExecuteGate): string {
  const buttons = (['recommend_only', 'simulate', 'request_approval', 'execute_if_pre_authorized'] as const)
    .map((mode) => {
      const offered = m.availableModes.includes(mode);
      const isExecute = mode === 'execute_if_pre_authorized';
      const enabled = offered && (!isExecute || gate.enabled);
      const disabledAttr = enabled ? '' : ' disabled aria-disabled="true"';
      const reason = isExecute && !enabled ? ` data-execute-blocked-reason="${esc(gate.reason)}"` : '';
      const extra = isExecute ? ` data-execute-enabled="${enabled ? 'true' : 'false'}"${reason}` : '';
      return `
            <li>
              <button type="button" class="mode-btn" data-testid="remediation-mode"
                data-mode="${esc(mode)}" data-offered="${offered ? 'true' : 'false'}"${disabledAttr}${extra}>
                ${esc(REMEDIATION_MODE_LABELS[mode])}
              </button>
            </li>`;
    })
    .join('');
  return `
      <section id="region-actions" aria-labelledby="actions-h" data-testid="remediation-actions" tabindex="-1">
        <h2 id="actions-h">Remediation actions</h2>
        <ul class="mode-list" role="group" aria-label="Remediation modes" data-testid="remediation-mode-list">${buttons}
        </ul>
        <p data-testid="execute-gate-note" data-execute-enabled="${gate.enabled ? 'true' : 'false'}">
          Execute-if-pre-authorized is <strong>${gate.enabled ? 'ENABLED' : 'DISABLED'}</strong>: ${esc(gate.reason)}
        </p>
      </section>`;
}

// ── Attempt + kill-switch + rollback region ─────────────────────────────────────────────────────

function attemptRegion(a: RemediationAttemptVM): string {
  const inFlightOrApplied =
    a.outcome === 'in_progress' ||
    a.outcome === 'succeeded_unverified' ||
    a.outcome === 'stopped' ||
    a.outcome === 'failed' ||
    a.outcome === 'uncertain';
  const killDisabled = a.outcome === 'in_progress' ? '' : ' disabled aria-disabled="true"';
  const rollbackDisabled = a.rollbackAvailable ? '' : ' disabled aria-disabled="true"';
  return `
      <section id="region-attempt" aria-labelledby="attempt-h" data-testid="remediation-attempt" tabindex="-1"
        data-attempt-id="${esc(a.attemptId)}" data-outcome="${esc(a.outcome)}"
        data-kill-engaged="${a.killEngaged ? 'true' : 'false'}"
        data-rollback-available="${a.rollbackAvailable ? 'true' : 'false'}">
        <h2 id="attempt-h">Attempt status</h2>
        <p data-testid="attempt-status">
          Outcome: <strong data-testid="attempt-outcome">${esc(a.outcome)}</strong>.
          ${a.stepsAttempted} of ${a.stepsTotal} step(s) attempted.
          ${
            a.outcome === 'succeeded_unverified'
              ? '<strong class="warn" data-testid="attempt-unverified">Succeeded but NOT verified — independent verification is still required before closure.</strong>'
              : ''
          }
        </p>
        ${
          a.safeNextAction
            ? `<p role="status" data-testid="attempt-safe-next-action">Safe next action: ${esc(a.safeNextAction)}</p>`
            : ''
        }
        <div class="controls" role="group" aria-label="Attempt controls">
          <button type="button" class="ctl" data-testid="kill-switch" data-kill-engaged="${a.killEngaged ? 'true' : 'false'}"${killDisabled}>
            ${a.killEngaged ? 'Kill switch ENGAGED — stopped' : 'Stop now (kill switch)'}
          </button>
          <button type="button" class="ctl" data-testid="rollback"${rollbackDisabled}>
            ${a.rollbackAvailable ? 'Roll back applied steps' : 'Roll back (nothing to reverse)'}
          </button>
        </div>
        ${
          inFlightOrApplied
            ? ''
            : '<p data-testid="attempt-none">No remediation attempt is in flight for this case.</p>'
        }
      </section>`;
}

// ── Verification / closure region (the authoritative verdict) ───────────────────────────────────

function gateItem(g: { name: string; passed: boolean; detail: string }): string {
  return `
          <li data-testid="verification-gate" data-gate="${esc(g.name)}" data-passed="${g.passed ? 'true' : 'false'}">
            <strong>${esc(g.name)}:</strong> ${g.passed ? 'passed' : 'FAILED'} — ${esc(g.detail)}
          </li>`;
}

function verificationRegion(v: VerificationResultVM): string {
  const banner = v.caseClosed
    ? `<p data-testid="closure-banner" data-case-closed="true" role="status"><strong>VERIFIED-CLOSED.</strong> All nine gates passed under independent verification (${esc(v.verificationId)}).</p>`
    : `<p data-testid="closure-banner" data-case-closed="false" role="alert"><strong>NOT verified-closed.</strong> ${esc(
        v.closureBlocked.length > 0 ? v.closureBlocked.join(', ') : 'verification has not passed',
      )}. A repair's own success is never closure — only an independent passing verification closes the case.</p>`;
  const gates =
    v.gates.length > 0
      ? `<ul class="gate-list" data-testid="verification-gates">${v.gates.map(gateItem).join('')}</ul>`
      : '<p data-testid="verification-none">No verification has been run for this case.</p>';
  return `
      <section id="region-verification" aria-labelledby="verification-h" data-testid="remediation-verification" tabindex="-1"
        data-all-gates-passed="${v.allGatesPassed ? 'true' : 'false'}"
        data-case-closed="${v.caseClosed ? 'true' : 'false'}">
        <h2 id="verification-h">Independent verification &amp; closure</h2>
        ${banner}
        ${gates}
      </section>`;
}

// ── Chrome ───────────────────────────────────────────────────────────────────────────────────────

function caseHeaderBanner(m: RemediationDetailModel): string {
  const owner = m.ownershipGap
    ? '<strong class="warn" data-testid="detail-ownership-gap">OWNERSHIP GAP — no owner to accept resolution (routed for assignment).</strong>'
    : `<span data-testid="detail-owner">${esc(m.ownerPrincipalId)}</span>`;
  return `
      <section aria-labelledby="case-h" data-testid="case-header"
        data-case-id="${esc(m.caseId)}" data-problem-class="${esc(m.problemClass)}"
        data-severity="${esc(m.severity)}" data-ownership-gap="${m.ownershipGap ? 'true' : 'false'}">
        <h2 id="case-h" class="visually-hidden">Case header</h2>
        <dl>
          <div class="kv"><dt>Case</dt><dd data-testid="detail-case-id"><code>${esc(m.caseId)}</code></dd></div>
          <div class="kv"><dt>Work item</dt><dd data-testid="detail-work-item"><code>${esc(m.workItemId)}</code></dd></div>
          <div class="kv"><dt>Problem class</dt><dd data-testid="detail-problem-class">${esc(m.problemClass)}</dd></div>
          <div class="kv"><dt>Severity</dt><dd data-testid="detail-severity">${esc(m.severity)}</dd></div>
          <div class="kv"><dt>Owner</dt><dd data-testid="detail-owner-cell">${owner}</dd></div>
        </dl>
      </section>`;
}

function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section aria-labelledby="scope-h" data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}" data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}" data-work-item-id="${esc(tenant.workItemId)}">
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="kv"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="kv"><dt>Bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="kv"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const DETAIL_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; } .kv { display: flex; flex-direction: column; margin-bottom: .35rem; }
    dt { font-weight: 600; } dd { margin: 0; }
    ul.mode-list, ul.gate-list { margin: 0; padding-left: 1rem; }
    ul.mode-list { list-style: none; padding-left: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
    .mode-btn, .ctl { font: inherit; padding: .35rem .7rem; border: 1px solid #666; background: #f3f3f3; cursor: pointer; }
    .mode-btn[disabled], .ctl[disabled] { opacity: .6; cursor: not-allowed; }
    .controls { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
    .warn { display: inline-block; }
    a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [disabled] { pointer-events: none; }`;

/**
 * Render the complete accessible REMEDIATION DETAIL as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderRemediationDetail(props))`.
 */
export function renderRemediationDetail(props: RemediationDetailProps): string {
  const { tenant } = props;
  const m = props.model;
  const gate = executeGate(m);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — remediation detail for case ${esc(m.caseId)}</title>
  <style>${DETAIL_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="detail-title">Remediation — case ${esc(m.caseId)}</h1>
    ${tenantScopeBanner(tenant)}
    ${caseHeaderBanner(m)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(m.summary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="detail-main"
        data-execute-enabled="${gate.enabled ? 'true' : 'false'}"
        data-case-closed="${m.verification.caseClosed ? 'true' : 'false'}"
        data-attempt-outcome="${esc(m.attempt.outcome)}">
    ${planRegion(m)}
    ${modeControls(m, gate)}
    ${attemptRegion(m.attempt)}
    ${verificationRegion(m.verification)}
  </main>
  <footer>
    <p data-testid="detail-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · only an independent verification closes a case.</p>
  </footer>
</body>
</html>`;
}

export default renderRemediationDetail;
