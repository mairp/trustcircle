// TrustCircleAI — accessible JOINT (CROSS-TENANT) DECISION STATUS (Phase 4 / User Story 2 / T113 /
// FR-043, FR-044, FR-045, AC6 / apps/web/src/features/decisions/JointDecisionStatus.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The federated-approval surface for a consequential action that affects MULTIPLE tenants. It shows,
// for one joint decision, the three gates that must ALL pass before execution (AC6, FR-043/044/045):
//   1. NON-WAIVABLE CENTRAL GUARDRAILS pass (FR-044);
//   2. EVERY affected tenant has supplied a CURRENT scoped approval (FR-043, tenant-scoped authority);
//   3. A DISTINCT CENTRAL governance reviewer has approved the joint action (FR-045, independent review).
// Execution stays BLOCKED until all three are satisfied; the view states, in text, exactly which gate
// is still open — never a color-only "not ready".
//
// NO CROSS-TENANT EVIDENCE LEAKAGE (AC6 / least-privilege disclosure). Each affected tenant's row
// discloses ONLY that tenant's approval STATUS + reviewer + timestamp — NOT its evidence, its private
// scope detail, or another tenant's package. The model carries per-tenant rows already scoped by the
// composition root; this presenter renders only the disclosed fields and NEVER a raw evidence blob.
// A row is marked `data-evidence-disclosed="false"` to make the non-leak an observable contract.
//
// SEPARATION OF THE CENTRAL REVIEWER (FR-045). The central-review gate names the reviewer and asserts
// they are DISTINCT from every tenant approver and from the requester; when the model reports the
// central reviewer is not yet distinct/assigned, the gate is open with a textual reason.
//
// WHY A DEPENDENCY-FREE STRING RENDERER. See DecisionInbox.tsx. Mounted via
// `page.setContent(renderJointDecisionStatus(props))`.
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

/** One non-waivable central guardrail and whether it has passed (FR-044). */
export interface CentralGuardrailVM {
  readonly id: string;
  readonly gateType: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** One affected tenant's scoped approval status. Discloses ONLY status/reviewer/time — no evidence (AC6). */
export interface TenantApprovalVM {
  readonly tenantId: string;
  readonly tenantName: string;
  /** approved | pending | rejected | expired. */
  readonly status: string;
  /** true iff this tenant's scoped approval is CURRENT (a stale approval does not count, FR-043). */
  readonly current: boolean;
  /** The tenant's approving reviewer (disclosed) — never their evidence. */
  readonly reviewerPrincipalId: string;
  readonly decidedAtIso: string;
  /** Always false — this view NEVER discloses another tenant's evidence (AC6 observable contract). */
  readonly evidenceDisclosed: false;
}

/** The distinct central reviewer gate (FR-045). */
export interface CentralReviewVM {
  /** true iff a DISTINCT central governance reviewer has approved the joint action. */
  readonly approved: boolean;
  /** The central reviewer principal (empty ⇒ not yet assigned). */
  readonly reviewerPrincipalId: string;
  /** true iff the central reviewer is distinct from every tenant approver and the requester. */
  readonly distinct: boolean;
  readonly decidedAtIso: string;
  /** A non-color explanation of the gate state. */
  readonly detail: string;
}

export interface JointDecisionStatusModel {
  readonly decisionId: string;
  readonly workItemId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAction: string;
  /** true iff execution is currently BLOCKED (any of the three gates is open). */
  readonly executionBlocked: boolean;
  readonly centralGuardrails: readonly CentralGuardrailVM[];
  readonly tenantApprovals: readonly TenantApprovalVM[];
  readonly centralReview: CentralReviewVM;
  readonly snapshotDigest: string;
}

export interface JointDecisionStatusProps {
  readonly tenant: TenantScope;
  readonly model: JointDecisionStatusModel;
}

// ── Derived gate states (for the summary) ─────────────────────────────────────────────────────────

function guardrailsPassed(m: JointDecisionStatusModel): boolean {
  return m.centralGuardrails.every((g) => g.passed);
}
function allTenantsApproved(m: JointDecisionStatusModel): boolean {
  return (
    m.tenantApprovals.length > 0 &&
    m.tenantApprovals.every((t) => t.status === 'approved' && t.current)
  );
}
function centralApproved(m: JointDecisionStatusModel): boolean {
  return m.centralReview.approved && m.centralReview.distinct;
}

// ── Regions ───────────────────────────────────────────────────────────────────────────────────────

function summaryRegion(m: JointDecisionStatusModel): string {
  const g = guardrailsPassed(m);
  const t = allTenantsApproved(m);
  const c = centralApproved(m);
  const openGates: string[] = [];
  if (!g) openGates.push('non-waivable central guardrails have not all passed');
  if (!t) openGates.push('not every affected tenant has supplied a current scoped approval');
  if (!c) openGates.push('a distinct central governance reviewer has not approved');
  return `
      <section id="region-joint-summary" aria-labelledby="joint-sum-h" data-testid="joint-summary" tabindex="-1"
        data-execution-blocked="${m.executionBlocked ? 'true' : 'false'}"
        data-guardrails-passed="${g ? 'true' : 'false'}"
        data-all-tenants-approved="${t ? 'true' : 'false'}"
        data-central-approved="${c ? 'true' : 'false'}">
        <h2 id="joint-sum-h">Joint approval status</h2>
        <p data-testid="joint-summary-text">
          ${
            m.executionBlocked
              ? `<strong>Execution is blocked.</strong> All three gates must pass first. Open: ${esc(openGates.join('; '))}.`
              : '<strong>All three gates have passed.</strong> The joint action may execute.'
          }
        </p>
      </section>`;
}

function guardrailsRegion(m: JointDecisionStatusModel): string {
  const rows = m.centralGuardrails
    .map(
      (gr) => `
        <tr data-testid="guardrail-row" data-passed="${gr.passed ? 'true' : 'false'}">
          <th scope="row">${esc(gr.gateType)}</th>
          <td data-testid="guardrail-status">${gr.passed ? 'passed' : 'not passed — blocking'}</td>
          <td>${esc(gr.detail)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-guardrails" aria-labelledby="gr-h" data-testid="central-guardrails" tabindex="-1"
        data-passed="${guardrailsPassed(m) ? 'true' : 'false'}">
        <h2 id="gr-h">Non-waivable central guardrails</h2>
        <p data-testid="guardrails-note">These guardrails cannot be waived by any tenant. Every one must pass before the joint action can execute (FR-044).</p>
        <table>
          <caption>Central guardrails (gate, status, detail)</caption>
          <thead><tr><th scope="col">Guardrail</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" data-testid="no-guardrails">no central guardrails recorded</td></tr>'}</tbody>
        </table>
      </section>`;
}

function tenantApprovalsRegion(m: JointDecisionStatusModel): string {
  const rows = m.tenantApprovals
    .map(
      (t) => `
        <tr data-testid="tenant-approval-row" data-tenant-id="${esc(t.tenantId)}" data-status="${esc(t.status)}"
          data-current="${t.current ? 'true' : 'false'}" data-evidence-disclosed="${t.evidenceDisclosed ? 'true' : 'false'}">
          <th scope="row">${esc(t.tenantName)}</th>
          <td data-testid="tenant-approval-status">${esc(t.status)}${
            t.status === 'approved' && !t.current ? ' (stale — does not count)' : ''
          }</td>
          <td data-testid="tenant-reviewer">${esc(t.reviewerPrincipalId)}</td>
          <td>${t.decidedAtIso ? `<time datetime="${esc(t.decidedAtIso)}">${esc(t.decidedAtIso)}</time>` : 'not yet decided'}</td>
          <td data-testid="tenant-evidence-disclosure">evidence not disclosed cross-tenant</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-tenant-approvals" aria-labelledby="ta-h" data-testid="tenant-approvals" tabindex="-1"
        data-all-approved="${allTenantsApproved(m) ? 'true' : 'false'}">
        <h2 id="ta-h">Per-tenant scoped approvals</h2>
        <p data-testid="tenant-approvals-note">
          Each affected tenant must supply a CURRENT scoped approval (FR-043). Only each tenant's
          approval status, reviewer, and time are shown — no tenant's evidence or private scope is
          disclosed to another tenant (AC6).
        </p>
        <table>
          <caption>Affected tenants and their scoped approvals (tenant, status, reviewer, decided-at, evidence disclosure)</caption>
          <thead><tr><th scope="col">Tenant</th><th scope="col">Approval status</th><th scope="col">Reviewer</th><th scope="col">Decided at</th><th scope="col">Evidence</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" data-testid="no-tenants">no affected tenants recorded</td></tr>'}</tbody>
        </table>
      </section>`;
}

function centralReviewRegion(m: JointDecisionStatusModel): string {
  const cr = m.centralReview;
  return `
      <section id="region-central-review" aria-labelledby="cr-h" data-testid="central-review" tabindex="-1"
        data-approved="${cr.approved ? 'true' : 'false'}" data-distinct="${cr.distinct ? 'true' : 'false'}">
        <h2 id="cr-h">Distinct central governance review</h2>
        <p data-testid="central-review-note">A distinct central governance reviewer — separate from every tenant approver and the requester — must approve the joint action (FR-045).</p>
        <dl>
          <div class="scope-row"><dt>Central reviewer</dt><dd data-testid="central-reviewer">${
            cr.reviewerPrincipalId ? esc(cr.reviewerPrincipalId) : 'not yet assigned'
          }</dd></div>
          <div class="scope-row"><dt>Distinct from tenant approvers &amp; requester</dt><dd data-testid="central-distinct">${
            cr.distinct ? 'yes' : 'no — not independent'
          }</dd></div>
          <div class="scope-row"><dt>Approved</dt><dd data-testid="central-approved">${cr.approved ? 'yes' : 'no'}</dd></div>
          <div class="scope-row"><dt>Decided at</dt><dd>${
            cr.decidedAtIso
              ? `<time datetime="${esc(cr.decidedAtIso)}">${esc(cr.decidedAtIso)}</time>`
              : 'not yet decided'
          }</dd></div>
          <div class="scope-row"><dt>Detail</dt><dd data-testid="central-detail">${esc(cr.detail)}</dd></div>
        </dl>
        ${
          !centralApproved(m)
            ? '<p role="alert" data-testid="central-open">The central-review gate is open — execution remains blocked.</p>'
            : ''
        }
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

const JOINT_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; } section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; } dt { font-weight: 600; } dd { margin: 0; }
    [role="alert"] { font-weight: 700; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the accessible JOINT DECISION STATUS as a standalone HTML document, PRESENTING the injected
 * `props.model`. Mounted via `page.setContent(renderJointDecisionStatus(props))`.
 */
export function renderJointDecisionStatus(props: JointDecisionStatusProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — joint decision ${esc(m.decisionId)}</title>
  <style>${JOINT_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="joint-title">Joint (cross-tenant) decision — ${esc(m.requestedAction)}</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${
        m.executionBlocked
          ? 'Execution is blocked pending joint approval.'
          : 'All joint gates passed.'
      }</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="joint-main" data-role="approver"
    data-decision-id="${esc(m.decisionId)}" data-execution-blocked="${m.executionBlocked ? 'true' : 'false'}"
    data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${summaryRegion(m)}
    ${guardrailsRegion(m)}
    ${tenantApprovalsRegion(m)}
    ${centralReviewRegion(m)}
  </main>
  <footer>
    <p data-testid="joint-footer">Scoped to ${esc(tenant.tenantName)} · joint action <code>${esc(m.decisionId)}</code> · no cross-tenant evidence disclosed.</p>
  </footer>
</body>
</html>`;
}

export default renderJointDecisionStatus;
