// TrustCircleAI — accessible CONTROLLER-OPERATION DETAIL (Phase 6 / User Story 4 / T175 /
// apps/web/src/features/controllers/OperationDetail.tsx / FR-025, FR-027, FR-028, FR-046..050,
// SC-010, SC-011, NS-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The operator-facing DETAIL of one governed controller operation: its lifecycle state, its pinned
// desired/observed version tuple, its simulation binding, its approval, its dispatch attempts, its
// reconciliation posture, its continuity lease, its rollback result, its evidence, and — verbatim from
// the projector — the EXACT next actions permitted. It answers the operator's cardinal question after
// dispatch — "did the effect actually happen, and what may I safely do next?" — and its whole reason
// for existing is to REFUSE the dangerous lie that an acknowledgement is a success.
//
// THE VERDICTS ARE NOT COMPUTED HERE. `latestOutcomeUncertain`, `awaitingReconciliation`,
// `continuityLeaseActive`, `terminal`, and `nextPermittedActions` all come from the REAL
// @trustcircle/projections `ControllerProjector`. This presenter renders them verbatim. Its
// load-bearing honesty rules:
//
//   * UNCERTAINTY IS NOT SUCCESS (FR-028 / SC-010). An attempt whose outcome is dispatched_unconfirmed,
//     uncertain, or timed_out is NEVER shown as confirmed. The confirmation banner reads CONFIRMED only
//     when the projector reports a direct remote observation established the effect; otherwise it reads
//     NOT CONFIRMED with the reason, and the operation is shown as AWAITING RECONCILIATION.
//   * ONE EFFECT (SC-011). A duplicate effect (>1 observed for one logical dispatch) is surfaced
//     explicitly as a divergence — never hidden and never counted as a second success.
//   * CONTINUITY NEVER CREATES AUTHORITY (FR-046..050). A continuity lease is shown with its bounded,
//     NONRENEWABLE expiry; once expired it is shown INACTIVE with the pause-and-reconcile obligation.
//   * ROLLBACK PROTECTS NEWER STATE (NS-011). A rollback result is shown verbatim, including a
//     conflict/refusal that protected a newer legitimate state.
//   * EXACT PERMITTED ACTIONS (FR-024). The action set is exactly `allowedNextOperations(state)`.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web ships no React runtime; these `.tsx`
// files are pure string builders. The output is a self-contained HTML string the e2e spec mounts via
// `page.setContent(renderOperationDetail(props))` and asserts through axe-core + the accessibility tree.
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

// ── The operation-detail view model ──────────────────────────────────────────────────────────────

/** One dispatch attempt, as the operator sees it (a projected `OperationAttempt` summary). */
export interface OperationAttemptVM {
  readonly attemptId: string;
  readonly ordinal: number;
  /** pending | dispatched_unconfirmed | confirmed | no_effect | failed | uncertain | timed_out. */
  readonly outcome: string;
  /** True iff this outcome's remote effect is UNKNOWN (dispatched_unconfirmed/uncertain/timed_out). */
  readonly uncertain: boolean;
  readonly detail: string;
}

/** The simulation-binding posture (FR-025 / NS-005) — whether the pinned prediction still binds. */
export interface SimulationBindingVM {
  readonly simulationId: string;
  readonly binds: boolean;
  readonly invalidatedByDrift: boolean;
  readonly invalidatedByExpiry: boolean;
  readonly driftedMembers: readonly string[];
  readonly reason: string;
}

/** The reconciliation posture — success is established ONLY by a direct remote observation (FR-028). */
export interface ReconciliationVM {
  readonly runId: string;
  /** none | reconciled_effect_present | reconciled_no_effect | still_uncertain | conflict | failed. */
  readonly result: string;
  /** True iff the reconciliation used a DIRECT remote observation (never an acknowledgement). */
  readonly usedRemoteObservation: boolean;
  /** Number of effects observed for one logical dispatch; >1 ⇒ duplicate divergence (SC-011). */
  readonly observedEffectCount: number;
  /** True iff a duplicate effect was surfaced (SC-011). */
  readonly duplicateEffect: boolean;
  /** True iff this reconciliation ESTABLISHED actual state (a new mutation is now permitted). */
  readonly establishedState: boolean;
  readonly reason: string;
}

/** The bounded, NONRENEWABLE continuity lease posture (FR-046..050 / NFR-012). */
export interface ContinuityLeaseVM {
  readonly leaseId: string;
  /** True iff the operation is in continuity mode AND the lease is unexpired at generation time. */
  readonly active: boolean;
  readonly expiresAtIso: string;
  /** The remaining budget, in milliseconds (0 when expired). */
  readonly remainingMs: number;
  /** True iff buffered continuity effects must reconcile before any new mutation (FR-050). */
  readonly mustReconcileOnReturn: boolean;
}

/** The rollback posture (NS-011) — a rollback that would clobber newer legitimate state is refused. */
export interface RollbackVM {
  /** none | rolled_back | rollback_refused_newer_state | rollback_failed. */
  readonly result: string;
  readonly reason: string;
}

/** The whole operation-detail model. */
export interface OperationDetailModel {
  readonly operationId: string;
  readonly controllerInstanceId: string;
  readonly operationKind: string;
  readonly state: string;
  readonly ownerPrincipalId: string;
  readonly requestedByPrincipalId: string;
  readonly desiredVersionTuple: string;
  readonly observedVersionTuple: string;
  /** True iff the observed tuple drifted from the authorized (desired) tuple. */
  readonly authorizedRevisionDrift: boolean;
  readonly simulation: SimulationBindingVM | null;
  readonly approvalDecisionId: string;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly progress: number;
  readonly attempts: readonly OperationAttemptVM[];
  /** The most recent attempt outcome, or empty when none has run. */
  readonly latestAttemptOutcome: string;
  /** The AUTHORITATIVE uncertainty flag — true ⇒ the latest attempt's effect is UNKNOWN (FR-028). */
  readonly latestOutcomeUncertain: boolean;
  /** The AUTHORITATIVE confirmation flag — true ONLY when a direct observation established the effect. */
  readonly effectConfirmed: boolean;
  /** The AUTHORITATIVE awaiting-reconciliation flag (uncertain AND not yet established). */
  readonly awaitingReconciliation: boolean;
  readonly reconciliation: ReconciliationVM | null;
  readonly continuityLease: ContinuityLeaseVM | null;
  readonly rollback: RollbackVM;
  readonly evidenceBundleId: string;
  readonly failed: boolean;
  readonly failureDetail: string;
  readonly terminal: boolean;
  /** The EXACT next operation kinds permitted from this state (FR-024) — never widened. */
  readonly nextPermittedActions: readonly string[];
  readonly generatedAtIso: string;
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed detail CANNOT masquerade as a confirmed success. */
export const EMPTY_OPERATION_DETAIL: OperationDetailModel = {
  operationId: '',
  controllerInstanceId: '',
  operationKind: 'inspect',
  state: 'requested',
  ownerPrincipalId: '',
  requestedByPrincipalId: '',
  desiredVersionTuple: '',
  observedVersionTuple: '',
  authorizedRevisionDrift: false,
  simulation: null,
  approvalDecisionId: '',
  totalSteps: 0,
  completedSteps: 0,
  progress: 0,
  attempts: [],
  latestAttemptOutcome: '',
  latestOutcomeUncertain: false,
  // No attempt ⇒ NOT confirmed. An un-fed detail never claims the effect happened.
  effectConfirmed: false,
  awaitingReconciliation: false,
  reconciliation: null,
  continuityLease: null,
  rollback: { result: 'none', reason: '' },
  evidenceBundleId: '',
  failed: false,
  failureDetail: '',
  terminal: false,
  nextPermittedActions: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface OperationDetailProps {
  readonly tenant: TenantScope;
  readonly model: OperationDetailModel;
}

// ── Banners ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The CONFIRMATION banner — the load-bearing anti-lie surface. It reads CONFIRMED only when the
 * projector reports the effect was established by a direct remote observation; an uncertain/timed-out
 * dispatch is NEVER shown as confirmed (FR-028 / SC-010).
 */
function confirmationBanner(m: OperationDetailModel): string {
  if (m.effectConfirmed) {
    return `
        <section id="region-confirmation" aria-labelledby="confirm-h" data-testid="confirmation-banner"
          data-effect-confirmed="true" data-awaiting-reconciliation="false" tabindex="-1">
          <h2 id="confirm-h">Effect confirmation</h2>
          <p role="status" data-testid="confirmation-text">
            <strong data-testid="confirmation-verdict" data-confirmed="true">CONFIRMED</strong> — a direct
            remote observation established the effect. Success is confirmed by observation, never by an
            acknowledgement.
          </p>
        </section>`;
  }
  const uncertainNote = m.latestOutcomeUncertain
    ? `The latest attempt outcome is <strong data-testid="confirmation-latest-outcome">${esc(
        m.latestAttemptOutcome || 'none',
      )}</strong>, whose remote effect is UNKNOWN — an acknowledgement is not a success.`
    : 'No direct remote observation has yet established the effect.';
  return `
        <section id="region-confirmation" aria-labelledby="confirm-h" data-testid="confirmation-banner"
          data-effect-confirmed="false" data-awaiting-reconciliation="${m.awaitingReconciliation ? 'true' : 'false'}" tabindex="-1">
          <h2 id="confirm-h">Effect confirmation</h2>
          <p role="alert" data-testid="confirmation-text">
            <strong class="warn" data-testid="confirmation-verdict" data-confirmed="false">NOT CONFIRMED</strong> — ${uncertainNote}
            ${m.awaitingReconciliation ? 'This operation is <strong data-testid="awaiting-reconciliation">AWAITING RECONCILIATION</strong>: it must reconcile against the authoritative remote state before any new mutation.' : ''}
          </p>
        </section>`;
}

function attemptsRegion(m: OperationDetailModel): string {
  const rows = m.attempts
    .map(
      (a) => `
        <tr data-testid="attempt-row" data-attempt-id="${esc(a.attemptId)}" data-outcome="${esc(a.outcome)}" data-uncertain="${a.uncertain ? 'true' : 'false'}">
          <th scope="row">${a.ordinal}</th>
          <td data-testid="attempt-outcome">${esc(a.outcome)}</td>
          <td data-testid="attempt-uncertain">${a.uncertain ? 'effect UNKNOWN (must reconcile)' : 'effect known'}</td>
          <td data-testid="attempt-detail">${esc(a.detail)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-attempts" aria-labelledby="attempts-h" data-testid="attempts-region" tabindex="-1"
        data-attempt-count="${m.attempts.length}" data-latest-outcome="${esc(m.latestAttemptOutcome)}">
        <h2 id="attempts-h">Dispatch attempts</h2>
        <p data-testid="attempts-summary">
          ${m.attempts.length} dispatch attempt(s). A single logical dispatch, even if retried, must
          resolve to EXACTLY ONE effect (SC-011). An uncertain or timed-out attempt leaves the effect
          UNKNOWN — it is never counted as a success.
        </p>
        <table aria-describedby="attempts-summary">
          <caption>Dispatch attempts (ordinal, outcome, certainty, detail)</caption>
          <thead>
            <tr><th scope="col">#</th><th scope="col">Outcome</th><th scope="col">Certainty</th><th scope="col">Detail</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function reconciliationRegion(m: OperationDetailModel): string {
  const r = m.reconciliation;
  if (r === null) {
    return `
      <section id="region-reconciliation" aria-labelledby="recon-h" data-testid="reconciliation-region" tabindex="-1"
        data-reconciliation-result="none" data-established="false" data-duplicate-effect="false">
        <h2 id="recon-h">Reconciliation</h2>
        <p data-testid="reconciliation-text">No reconciliation has run. Actual remote state is not established.</p>
      </section>`;
  }
  const dup = r.duplicateEffect
    ? '<p role="alert" data-testid="duplicate-effect-warning" data-duplicate="true"><strong class="warn">DUPLICATE EFFECT</strong> — more than one effect was observed for a single logical dispatch (SC-011 one-effect rule violated); surfaced as a conflict for compensation.</p>'
    : '';
  return `
      <section id="region-reconciliation" aria-labelledby="recon-h" data-testid="reconciliation-region" tabindex="-1"
        data-reconciliation-result="${esc(r.result)}" data-used-remote-observation="${r.usedRemoteObservation ? 'true' : 'false'}"
        data-observed-effect-count="${r.observedEffectCount}" data-established="${r.establishedState ? 'true' : 'false'}"
        data-duplicate-effect="${r.duplicateEffect ? 'true' : 'false'}">
        <h2 id="recon-h">Reconciliation</h2>
        <p data-testid="reconciliation-text">
          Result: <strong data-testid="reconciliation-result">${esc(r.result)}</strong>.
          ${r.usedRemoteObservation ? 'Established by a DIRECT remote observation.' : 'No direct remote observation was available — the effect remains unknown.'}
          Observed <strong data-testid="reconciliation-effect-count">${r.observedEffectCount}</strong> effect(s) for this dispatch.
          ${r.establishedState ? 'Actual state is established; a new mutation may proceed.' : 'Actual state is NOT established; no new mutation may proceed.'}
          <span data-testid="reconciliation-reason">${esc(r.reason)}</span>
        </p>
        ${dup}
      </section>`;
}

function continuityRegion(m: OperationDetailModel): string {
  const l = m.continuityLease;
  if (l === null) {
    return `
      <section id="region-continuity" aria-labelledby="continuity-h" data-testid="continuity-region" tabindex="-1"
        data-continuity-active="false">
        <h2 id="continuity-h">Continuity lease</h2>
        <p data-testid="continuity-text">No continuity lease. This operation is not operating in bounded continuity.</p>
      </section>`;
  }
  return `
      <section id="region-continuity" aria-labelledby="continuity-h" data-testid="continuity-region" tabindex="-1"
        data-continuity-active="${l.active ? 'true' : 'false'}" data-lease-id="${esc(l.leaseId)}"
        data-remaining-ms="${l.remainingMs}" data-must-reconcile-on-return="${l.mustReconcileOnReturn ? 'true' : 'false'}">
        <h2 id="continuity-h">Continuity lease</h2>
        <p data-testid="continuity-text" role="${l.active ? 'status' : 'alert'}">
          ${
            l.active
              ? `<strong data-testid="continuity-verdict" data-active="true">ACTIVE (bounded, NONRENEWABLE)</strong> — expires <time datetime="${esc(l.expiresAtIso)}" data-testid="continuity-expiry">${esc(l.expiresAtIso)}</time> (${l.remainingMs} ms remaining). The lease grants NO new authority: it may only continue the already-approved, already-started operation, and cannot renew itself.`
              : `<strong class="warn" data-testid="continuity-verdict" data-active="false">EXPIRED / INACTIVE</strong> — the bounded lease has lapsed. The controller MUST pause; buffered effects must reconcile before any new mutation.`
          }
          ${l.mustReconcileOnReturn ? ' <span data-testid="continuity-reconcile-obligation">Buffered continuity effects must reconcile on return (FR-050).</span>' : ''}
        </p>
      </section>`;
}

function simulationRegion(m: OperationDetailModel): string {
  const s = m.simulation;
  if (s === null) {
    return `
      <section id="region-simulation" aria-labelledby="sim-h" data-testid="simulation-region" tabindex="-1"
        data-simulation-binds="false">
        <h2 id="sim-h">Simulation binding</h2>
        <p data-testid="simulation-text">No simulation is bound. A state-changing operation must be simulated before it can execute.</p>
      </section>`;
  }
  return `
      <section id="region-simulation" aria-labelledby="sim-h" data-testid="simulation-region" tabindex="-1"
        data-simulation-id="${esc(s.simulationId)}" data-simulation-binds="${s.binds ? 'true' : 'false'}"
        data-invalidated-by-drift="${s.invalidatedByDrift ? 'true' : 'false'}" data-invalidated-by-expiry="${s.invalidatedByExpiry ? 'true' : 'false'}">
        <h2 id="sim-h">Simulation binding</h2>
        <p data-testid="simulation-text" role="${s.binds ? 'status' : 'alert'}">
          ${
            s.binds
              ? '<strong data-testid="simulation-verdict" data-binds="true">BINDS</strong> — the pinned prediction still matches the observed version tuple; execution may rely on it.'
              : `<strong class="warn" data-testid="simulation-verdict" data-binds="false">DOES NOT BIND</strong> — ${s.invalidatedByExpiry ? 'the simulation expired' : ''}${s.invalidatedByDrift ? `${s.invalidatedByExpiry ? ' and ' : ''}the source/version tuple drifted (${esc(s.driftedMembers.join(', '))})` : ''}. The operation MUST be re-simulated before execution (NS-005).`
          }
          <span data-testid="simulation-reason">${esc(s.reason)}</span>
        </p>
      </section>`;
}

function rollbackRegion(m: OperationDetailModel): string {
  const r = m.rollback;
  const protectedNewer = r.result === 'rollback_refused_newer_state';
  return `
      <section id="region-rollback" aria-labelledby="rollback-h" data-testid="rollback-region" tabindex="-1"
        data-rollback-result="${esc(r.result)}" data-protected-newer-state="${protectedNewer ? 'true' : 'false'}">
        <h2 id="rollback-h">Rollback</h2>
        <p data-testid="rollback-text">
          Result: <strong data-testid="rollback-result">${esc(r.result)}</strong>.
          ${protectedNewer ? '<strong class="warn" data-testid="rollback-protected">Rollback was REFUSED to protect newer legitimate state (NS-011).</strong>' : ''}
          <span data-testid="rollback-reason">${esc(r.reason)}</span>
        </p>
      </section>`;
}

/** The EXACT permitted-action set (FR-024) — rendered verbatim; the view widens nothing. */
function permittedActionsRegion(m: OperationDetailModel): string {
  const items = m.nextPermittedActions
    .map((a) => `<li data-testid="detail-permitted-action" data-action="${esc(a)}">${esc(a)}</li>`)
    .join('');
  const body =
    m.nextPermittedActions.length > 0
      ? `<ul class="action-list" data-testid="detail-permitted-actions" data-actions="${esc(m.nextPermittedActions.join(' '))}" data-count="${m.nextPermittedActions.length}">${items}</ul>`
      : '<p data-testid="detail-no-actions">No further actions are permitted from the current state.</p>';
  return `
      <section id="region-permitted-actions" aria-labelledby="actions-h" data-testid="permitted-actions-region" tabindex="-1"
        data-permitted-actions="${esc(m.nextPermittedActions.join(' '))}" data-terminal="${m.terminal ? 'true' : 'false'}">
        <h2 id="actions-h">Permitted next actions</h2>
        <p data-testid="permitted-actions-summary">
          These are EXACTLY the actions the current operation state allows (FR-024). ${m.terminal ? 'This operation is TERMINAL; it is queryable but never re-driven.' : ''}
        </p>
        ${body}
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

function summaryRegion(m: OperationDetailModel): string {
  return `
      <section id="region-operation-summary" aria-labelledby="summary-h" data-testid="operation-summary" tabindex="-1"
        data-operation-id="${esc(m.operationId)}" data-operation-kind="${esc(m.operationKind)}" data-state="${esc(m.state)}"
        data-failed="${m.failed ? 'true' : 'false'}" data-terminal="${m.terminal ? 'true' : 'false'}"
        data-authorized-revision-drift="${m.authorizedRevisionDrift ? 'true' : 'false'}">
        <h2 id="summary-h">Operation summary</h2>
        <dl>
          <div class="scope-row"><dt>Operation</dt><dd data-testid="summary-operation-id"><code>${esc(m.operationId)}</code></dd></div>
          <div class="scope-row"><dt>Kind</dt><dd data-testid="summary-kind">${esc(m.operationKind)}</dd></div>
          <div class="scope-row"><dt>State</dt><dd data-testid="summary-state">${esc(m.state)}</dd></div>
          <div class="scope-row"><dt>Owner</dt><dd data-testid="summary-owner">${esc(m.ownerPrincipalId)}</dd></div>
          <div class="scope-row"><dt>Desired tuple</dt><dd data-testid="summary-desired-tuple"><code>${esc(m.desiredVersionTuple)}</code></dd></div>
          <div class="scope-row"><dt>Observed tuple</dt><dd data-testid="summary-observed-tuple"><code>${esc(m.observedVersionTuple)}</code></dd></div>
          <div class="scope-row"><dt>Progress</dt><dd data-testid="summary-progress">${m.completedSteps}/${m.totalSteps} step(s)</dd></div>
          <div class="scope-row"><dt>Approval</dt><dd data-testid="summary-approval">${m.approvalDecisionId ? `<code>${esc(m.approvalDecisionId)}</code>` : 'not approved'}</dd></div>
          <div class="scope-row"><dt>Evidence</dt><dd data-testid="summary-evidence">${m.evidenceBundleId ? `<code>${esc(m.evidenceBundleId)}</code>` : 'none collected'}</dd></div>
        </dl>
        ${m.failed ? `<p role="alert" data-testid="operation-failure"><strong class="warn">FAILED</strong> — ${esc(m.failureDetail || 'the operation failed')}.</p>` : ''}
      </section>`;
}

const DETAIL_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; } dd { margin: 0; }
    ul.action-list { margin: 0; padding-left: 1rem; }
    .warn { display: inline-block; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible CONTROLLER-OPERATION DETAIL as a standalone HTML document,
 * PRESENTING the injected `props.model`. Mounted in-browser via
 * `page.setContent(renderOperationDetail(props))`.
 */
export function renderOperationDetail(props: OperationDetailProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} operation ${esc(m.operationId)}</title>
  <style>${DETAIL_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="operation-title">${esc(tenant.tenantName)} — controller operation detail</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">Operation ${esc(m.operationId || '—')} is ${esc(m.state)}; effect ${m.effectConfirmed ? 'confirmed' : 'NOT confirmed'}.</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="operation-main" data-role="controller-operator"
    data-effect-confirmed="${m.effectConfirmed ? 'true' : 'false'}"
    data-awaiting-reconciliation="${m.awaitingReconciliation ? 'true' : 'false'}"
    data-latest-outcome-uncertain="${m.latestOutcomeUncertain ? 'true' : 'false'}"
    data-terminal="${m.terminal ? 'true' : 'false'}"
    data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${summaryRegion(m)}
    ${confirmationBanner(m)}
    ${simulationRegion(m)}
    ${attemptsRegion(m)}
    ${reconciliationRegion(m)}
    ${continuityRegion(m)}
    ${rollbackRegion(m)}
    ${permittedActionsRegion(m)}
  </main>
  <footer>
    <p data-testid="operation-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>.</p>
  </footer>
</body>
</html>`;
}

export default renderOperationDetail;
