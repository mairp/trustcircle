// TrustCircleAI — accessible DECISION-PACKAGE DETAIL (Phase 4 / User Story 2 / T110 /
// apps/web/src/features/decisions/DecisionDetail.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The reviewer's DECISION PACKAGE: the complete context an approver must see BEFORE any decision is
// accepted (SC-003, Acceptance Scenario 1). It presents — for one pending decision — the requested
// action, affected scope, business impact, risks, alternatives, evidence, POLICY and CONTROL
// versions, the requester, the separation-of-duties constraints, expiry, and the expected result.
// It is a PURE PRESENTER over an already-assembled package model; it computes no authority and
// invents no evidence.
//
// MATERIAL-CHANGE RE-REVIEW (Acceptance Scenario 4 / AC4 / FR-015). A decision package the reviewer
// began reviewing can be OVERTAKEN: evidence superseded, policy or control version bumped, scope or
// business impact changed since review began. When the injected model marks the package materially
// changed, this view renders a prominent, textual `role=alert` re-review banner and marks every
// changed facet with `data-materially-changed="true"` and a human "changed since you began review"
// note — and it BINDS the action affordance to the CURRENT package version/digest (the ETag the
// action must carry), so a reviewer can never submit a decision against a stale package without
// seeing that it changed. The warning is in the TEXT, not a color (WCAG 1.4.1).
//
// AUTHORITY + SoD ARE STATED (Acceptance Scenario 1/3). The package shows the reviewer's resolved
// authority (permitted or not, and why), the separation-of-duties constraints on the requirement
// gates (minimum distinct principals, incompatible relationships), and — when the reviewer is
// blocked — the explicit conflict, never a silent disabled control.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). See DecisionInbox.tsx — same rationale.
// The output is a self-contained HTML string mounted via `page.setContent(renderDecisionDetail(props))`.
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

// ── The package view model ───────────────────────────────────────────────────────────────────────

/** A single risk on the package. */
export interface DetailRiskVM {
  readonly id: string;
  readonly summary: string;
  readonly severity: string;
  readonly likelihood: string;
}

/** A single alternative considered (and why it was not chosen). */
export interface DetailAlternativeVM {
  readonly id: string;
  readonly summary: string;
  readonly tradeoff: string;
}

/** One evidence artifact backing the package, with its currency. */
export interface DetailEvidenceVM {
  readonly id: string;
  readonly kind: string;
  readonly reference: string;
  /** current | superseded | missing. */
  readonly currency: string;
  /** true iff this artifact was superseded since the reviewer began (AC4). */
  readonly changedSinceReview: boolean;
}

/** A policy or control version pin the package was assembled against (AC1: policy/control versions). */
export interface DetailVersionPinVM {
  readonly kind: 'policy' | 'control';
  readonly id: string;
  readonly version: string;
  /** true iff this version changed since the reviewer began (AC4 material change). */
  readonly changedSinceReview: boolean;
}

/** One separation-of-duties requirement gate on the package. */
export interface DetailRequirementVM {
  readonly id: string;
  readonly gateType: string;
  readonly status: string;
  readonly satisfied: boolean;
  /** true ⇒ a non-waivable CENTRAL guardrail (tenant-independent). */
  readonly central: boolean;
  readonly minimumDistinctPrincipals: number;
  readonly incompatibleRelationships: readonly string[];
}

/** The reviewer's resolved authority verdict for this package (computed by the application layer). */
export interface DetailAuthorityVM {
  readonly principalId: string;
  readonly permitted: boolean;
  /** The conflicts blocking the reviewer (empty ⇒ none). */
  readonly conflicts: readonly string[];
  /** The verbs the reviewer may currently take (empty ⇒ view-only). */
  readonly allowedActions: readonly string[];
  /** A non-color one-line summary of the authority state. */
  readonly summary: string;
}

/** Which package facets changed since review began, and the overall re-review requirement (AC4). */
export interface MaterialChangeVM {
  /** true ⇒ the reviewer must re-review against the CURRENT package before submitting. */
  readonly reReviewRequired: boolean;
  /** The changed facet names (e.g. 'evidence', 'policy_version', 'scope', 'business_impact'). */
  readonly changedFacets: readonly string[];
  /** A non-color explanation the reviewer reads. */
  readonly explanation: string;
}

export interface DecisionDetailModel {
  readonly decisionId: string;
  readonly workItemId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: string;
  readonly impact: string;
  readonly status: string;
  readonly version: number;
  /** The strong ETag the action must carry (the CURRENT package digest+version). */
  readonly etag: string;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
  /** fresh | aging | expiring_soon | expired. */
  readonly timePosture: string;
  readonly expiryLabel: string;
  /** The affected scope, rendered as human key→value rows. */
  readonly scope: readonly { readonly key: string; readonly value: string }[];
  /** The business impact, rendered as human key→value rows; may be marked changed (AC4). */
  readonly businessImpact: readonly { readonly key: string; readonly value: string }[];
  readonly businessImpactChanged: boolean;
  readonly scopeChanged: boolean;
  readonly expectedResult: readonly { readonly key: string; readonly value: string }[];
  readonly risks: readonly DetailRiskVM[];
  readonly alternatives: readonly DetailAlternativeVM[];
  readonly evidence: readonly DetailEvidenceVM[];
  readonly versionPins: readonly DetailVersionPinVM[];
  readonly requirements: readonly DetailRequirementVM[];
  readonly authority: DetailAuthorityVM;
  readonly affectedTenantIds: readonly string[];
  readonly materialChange: MaterialChangeVM;
  /** The projection snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
}

export interface DecisionDetailProps {
  readonly tenant: TenantScope;
  readonly model: DecisionDetailModel;
}

// ── Region renderers ─────────────────────────────────────────────────────────────────────────────

function kvRegion(
  id: string,
  heading: string,
  rows: readonly { readonly key: string; readonly value: string }[],
  changed: boolean,
): string {
  const items = rows
    .map(
      (r) =>
        `<div class="scope-row"><dt>${esc(r.key)}</dt><dd data-testid="${esc(id)}-value">${esc(r.value)}</dd></div>`,
    )
    .join('');
  return `
      <section id="region-${esc(id)}" aria-labelledby="${esc(id)}-h" data-testid="${esc(id)}" tabindex="-1" data-materially-changed="${
        changed ? 'true' : 'false'
      }">
        <h2 id="${esc(id)}-h">${esc(heading)}${changed ? ' — changed since you began review' : ''}</h2>
        ${changed ? `<p role="alert" data-testid="${esc(id)}-changed-note">This ${esc(heading.toLowerCase())} changed since you began reviewing. Re-review against the current package before deciding.</p>` : ''}
        <dl>${items || '<div class="scope-row"><dt>—</dt><dd>none recorded</dd></div>'}</dl>
      </section>`;
}

function materialChangeBanner(mc: MaterialChangeVM): string {
  if (!mc.reReviewRequired) {
    return `
      <section id="region-rereview" aria-labelledby="rereview-h" data-testid="material-change" tabindex="-1"
        data-rereview-required="false">
        <h2 id="rereview-h" class="visually-hidden">Package currency</h2>
        <p data-testid="no-material-change">The decision package is unchanged since you began reviewing.</p>
      </section>`;
  }
  return `
      <section id="region-rereview" aria-labelledby="rereview-h" data-testid="material-change" tabindex="-1"
        data-rereview-required="true" data-changed-facets="${esc(mc.changedFacets.join(' '))}">
        <h2 id="rereview-h">Re-review required</h2>
        <p role="alert" data-testid="rereview-alert">
          <strong>The decision package changed materially since you began review.</strong>
          ${esc(mc.explanation)} You must re-review against the CURRENT package before submitting a
          decision. The changed facets are: ${esc(mc.changedFacets.join(', '))}.
        </p>
      </section>`;
}

function risksRegion(m: DecisionDetailModel): string {
  const rows = m.risks
    .map(
      (r) => `
        <tr data-testid="risk-row" data-risk-id="${esc(r.id)}">
          <th scope="row">${esc(r.summary)}</th>
          <td data-testid="risk-severity">${esc(r.severity)}</td>
          <td data-testid="risk-likelihood">${esc(r.likelihood)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-risks" aria-labelledby="risks-h" data-testid="risks" tabindex="-1">
        <h2 id="risks-h">Risks</h2>
        <table>
          <caption>Risks the requested action carries (summary, severity, likelihood)</caption>
          <thead><tr><th scope="col">Risk</th><th scope="col">Severity</th><th scope="col">Likelihood</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" data-testid="no-risks">no risks recorded</td></tr>'}</tbody>
        </table>
      </section>`;
}

function alternativesRegion(m: DecisionDetailModel): string {
  const rows = m.alternatives
    .map(
      (a) => `
        <tr data-testid="alternative-row" data-alternative-id="${esc(a.id)}">
          <th scope="row">${esc(a.summary)}</th>
          <td data-testid="alternative-tradeoff">${esc(a.tradeoff)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-alternatives" aria-labelledby="alt-h" data-testid="alternatives" tabindex="-1">
        <h2 id="alt-h">Alternatives considered</h2>
        <table>
          <caption>Alternatives considered and their trade-offs</caption>
          <thead><tr><th scope="col">Alternative</th><th scope="col">Trade-off</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="2" data-testid="no-alternatives">no alternatives recorded</td></tr>'}</tbody>
        </table>
      </section>`;
}

function evidenceRegion(m: DecisionDetailModel): string {
  const rows = m.evidence
    .map(
      (e) => `
        <tr data-testid="evidence-row" data-evidence-id="${esc(e.id)}" data-currency="${esc(e.currency)}" data-materially-changed="${
          e.changedSinceReview ? 'true' : 'false'
        }">
          <th scope="row">${esc(e.kind)}</th>
          <td data-testid="evidence-ref"><a href="#${esc(e.reference)}">${esc(e.reference)}</a></td>
          <td data-testid="evidence-currency">${esc(e.currency)}${
            e.changedSinceReview ? ' — superseded since you began review' : ''
          }</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-evidence" aria-labelledby="ev-h" data-testid="evidence" tabindex="-1">
        <h2 id="ev-h">Evidence</h2>
        <table>
          <caption>Evidence backing the decision package (kind, reference, currency)</caption>
          <thead><tr><th scope="col">Kind</th><th scope="col">Reference</th><th scope="col">Currency</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" data-testid="no-evidence">no evidence recorded</td></tr>'}</tbody>
        </table>
      </section>`;
}

function versionsRegion(m: DecisionDetailModel): string {
  const rows = m.versionPins
    .map(
      (v) => `
        <tr data-testid="version-row" data-kind="${esc(v.kind)}" data-materially-changed="${
          v.changedSinceReview ? 'true' : 'false'
        }">
          <th scope="row">${esc(v.kind)}</th>
          <td>${esc(v.id)}</td>
          <td data-testid="version-value">${esc(v.version)}${
            v.changedSinceReview ? ' — changed since you began review' : ''
          }</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-versions" aria-labelledby="ver-h" data-testid="version-pins" tabindex="-1">
        <h2 id="ver-h">Policy &amp; control versions</h2>
        <p data-testid="versions-note">The policy and control versions this package was assembled against. A changed version requires re-review (AC4).</p>
        <table>
          <caption>Policy and control version pins (kind, id, version)</caption>
          <thead><tr><th scope="col">Kind</th><th scope="col">Id</th><th scope="col">Version</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" data-testid="no-versions">no version pins recorded</td></tr>'}</tbody>
        </table>
      </section>`;
}

function requirementsRegion(m: DecisionDetailModel): string {
  const rows = m.requirements
    .map(
      (r) => `
        <tr data-testid="requirement-row" data-gate-type="${esc(r.gateType)}" data-satisfied="${
          r.satisfied ? 'true' : 'false'
        }" data-central="${r.central ? 'true' : 'false'}">
          <th scope="row">${esc(r.gateType)}${r.central ? ' (central guardrail)' : ''}</th>
          <td data-testid="requirement-status">${esc(r.status)}${r.satisfied ? '' : ' — open'}</td>
          <td data-testid="requirement-min-principals">${r.minimumDistinctPrincipals} distinct principal(s)</td>
          <td data-testid="requirement-incompatible">${
            r.incompatibleRelationships.length > 0
              ? esc(r.incompatibleRelationships.join(', '))
              : 'no incompatible relationships'
          }</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-requirements" aria-labelledby="req-h" data-testid="requirements" tabindex="-1">
        <h2 id="req-h">Separation-of-duties requirements</h2>
        <table>
          <caption>Requirement gates and their separation-of-duties constraints (gate, status, minimum distinct principals, incompatible relationships)</caption>
          <thead><tr><th scope="col">Gate</th><th scope="col">Status</th><th scope="col">Minimum distinct principals</th><th scope="col">Incompatible relationships</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" data-testid="no-requirements">no requirement gates</td></tr>'}</tbody>
        </table>
      </section>`;
}

function authorityRegion(m: DecisionDetailModel): string {
  const a = m.authority;
  return `
      <section id="region-authority" aria-labelledby="auth-h" data-testid="authority" tabindex="-1"
        data-permitted="${a.permitted ? 'true' : 'false'}" data-conflicts="${esc(a.conflicts.join(' '))}">
        <h2 id="auth-h">Your authority</h2>
        <p data-testid="authority-summary">${esc(a.summary)}</p>
        <dl>
          <div class="scope-row"><dt>Reviewer</dt><dd data-testid="authority-principal">${esc(a.principalId)}</dd></div>
          <div class="scope-row"><dt>Permitted</dt><dd data-testid="authority-permitted">${a.permitted ? 'yes' : 'no'}</dd></div>
          <div class="scope-row"><dt>Conflicts</dt><dd data-testid="authority-conflicts">${
            a.conflicts.length > 0 ? esc(a.conflicts.join(', ')) : 'none'
          }</dd></div>
          <div class="scope-row"><dt>Actions available to you</dt><dd data-testid="authority-actions">${
            a.allowedActions.length > 0 ? esc(a.allowedActions.join(', ')) : 'view only'
          }</dd></div>
        </dl>
      </section>`;
}

function headerFacts(m: DecisionDetailModel): string {
  return `
      <section id="region-facts" aria-labelledby="facts-h" data-testid="package-facts" tabindex="-1"
        data-decision-id="${esc(m.decisionId)}" data-version="${m.version}" data-etag="${esc(m.etag)}"
        data-time-posture="${esc(m.timePosture)}" data-status="${esc(m.status)}">
        <h2 id="facts-h">Requested decision</h2>
        <dl>
          <div class="scope-row"><dt>Decision</dt><dd data-testid="fact-decision-id"><code>${esc(m.decisionId)}</code></dd></div>
          <div class="scope-row"><dt>Work item</dt><dd data-testid="fact-work-item"><code>${esc(m.workItemId)}</code></dd></div>
          <div class="scope-row"><dt>Requester</dt><dd data-testid="fact-requester">${esc(m.requesterPrincipalId)}</dd></div>
          <div class="scope-row"><dt>Requested action</dt><dd data-testid="fact-requested-action">${esc(m.requestedAction)}</dd></div>
          <div class="scope-row"><dt>Action class</dt><dd data-testid="fact-action-class">${esc(m.actionClass)}</dd></div>
          <div class="scope-row"><dt>Risk tier</dt><dd data-testid="fact-risk">${esc(m.riskTier)}</dd></div>
          <div class="scope-row"><dt>Business impact level</dt><dd data-testid="fact-impact">${esc(m.impact)}</dd></div>
          <div class="scope-row"><dt>Status</dt><dd data-testid="fact-status">${esc(m.status)}</dd></div>
          <div class="scope-row"><dt>Package version</dt><dd data-testid="fact-version">${m.version}</dd></div>
          <div class="scope-row"><dt>Current ETag</dt><dd data-testid="fact-etag"><code>${esc(m.etag)}</code></dd></div>
          <div class="scope-row"><dt>Created</dt><dd><time datetime="${esc(m.createdAtIso)}" data-testid="fact-created">${esc(m.createdAtIso)}</time></dd></div>
          <div class="scope-row"><dt>Expiry</dt><dd data-testid="fact-expiry" data-time-posture="${esc(m.timePosture)}">
            <time datetime="${esc(m.expiresAtIso)}">${esc(m.expiresAtIso)}</time> — ${esc(m.expiryLabel)}
            ${m.timePosture === 'expired' ? '<strong class="warn" data-testid="fact-expired-warning">Expired.</strong>' : ''}
            ${m.timePosture === 'expiring_soon' ? '<strong class="warn" data-testid="fact-expiring-warning">Expiring soon.</strong>' : ''}
          </dd></div>
          ${
            m.affectedTenantIds.length > 0
              ? `<div class="scope-row"><dt>Affected tenants</dt><dd data-testid="fact-affected-tenants" data-cross-tenant="true">${esc(
                  m.affectedTenantIds.join(', '),
                )} — cross-tenant / joint decision</dd></div>`
              : ''
          }
        </dl>
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

const DETAIL_STYLE = `
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
    .warn { display: inline-block; }
    [data-materially-changed="true"] > h2, [role="alert"] { font-weight: 700; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible DECISION-PACKAGE DETAIL as a standalone HTML document, PRESENTING
 * the injected `props.model`. Mounted via `page.setContent(renderDecisionDetail(props))`.
 */
export function renderDecisionDetail(props: DecisionDetailProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — decision ${esc(m.decisionId)}</title>
  <style>${DETAIL_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="detail-title">Decision package — ${esc(m.requestedAction)}</h1>
    ${tenantScopeBanner(tenant)}
  </header>
  <main id="main" tabindex="-1" data-testid="detail-main" data-role="approver"
    data-decision-id="${esc(m.decisionId)}" data-version="${m.version}" data-etag="${esc(m.etag)}"
    data-rereview-required="${m.materialChange.reReviewRequired ? 'true' : 'false'}"
    data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${materialChangeBanner(m.materialChange)}
    ${headerFacts(m)}
    ${authorityRegion(m)}
    ${kvRegion('scope', 'Affected scope', m.scope, m.scopeChanged)}
    ${kvRegion('business-impact', 'Business impact', m.businessImpact, m.businessImpactChanged)}
    ${risksRegion(m)}
    ${alternativesRegion(m)}
    ${evidenceRegion(m)}
    ${versionsRegion(m)}
    ${requirementsRegion(m)}
    ${kvRegion('expected-result', 'Expected result', m.expectedResult, false)}
  </main>
  <footer>
    <p data-testid="detail-footer">Scoped to ${esc(tenant.tenantName)} · decision <code>${esc(m.decisionId)}</code>.</p>
  </footer>
</body>
</html>`;
}

export default renderDecisionDetail;
