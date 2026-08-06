// TrustCircleAI — accessible APPLICABILITY PROPOSAL & INDEPENDENT REVIEW presenter (Phase 7 /
// User Story 5 / T212 / apps/web/src/features/compliance/ApplicabilityReview.tsx /
// FR-052, FR-053, FR-054).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The compliance-owner surface for the APPLICABILITY DECISION lifecycle: a proposed applicability
// result becomes IN FORCE only when an INDEPENDENT reviewer (someone other than the proposer, who
// holds the reviewer role) approves it. This presenter renders, per decision: the proposed
// result + lifecycle state IN WORDS (via the shared claim-label helpers), whether the review was
// INDEPENDENT (FR-053), the supporting evidence, the non-applicability / expiry posture (FR-054 —
// a stale non-applicability reopens as a coverage gap; it never silently suppresses the
// obligation), the EXACT permitted next actions the state allows (never widened by the view), and
// the append-only decision HISTORY (versioning + supersession trail).
//
// THE VERDICTS ARE NOT COMPUTED HERE. `independentReview`, `expired`, `reopensGap`, and
// `permittedActions` are computed upstream by the real domain/application services over the
// applicability decision aggregate. This module PRESENTS those fields verbatim: it re-derives no
// independence verdict, masks no expiry, and INVENTS NO EXTRA PERMITTED ACTION. If it is fed an
// impossible state (e.g. an `active` decision whose review was NOT independent — FR-053), it is
// HONEST about it and surfaces it prominently as a `role="alert"` violation rather than hiding it.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every decision states its result and state in
// words with machine-readable `data-state` / `data-result` / `data-independent-review` /
// `data-expired` / `data-reopens-gap`. A `proposed` decision is explicitly flagged as NOT in force.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — they are pure string-builder presenters. The output is a
// self-contained HTML string an e2e spec mounts via
// `page.setContent(renderApplicabilityReview(props))` and asserts through axe-core + the live
// accessibility tree, with NO web server, NO React, NO tenant-auth.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no
// network, no module-level mutable state — same props ⇒ byte-identical output.

import type { TenantScope } from '../../app/layout.tsx';
import type {
  ApplicabilityResult,
  ApplicabilityState,
  ApplicabilityAction,
} from '@trustcircle/domain';
import {
  applicabilityResultLabel,
  applicabilityStateLabel,
  applicabilityActionLabel,
} from './claim-labels.ts';

export type { TenantScope };

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── The applicability-review view model — the render-ready reduction of the decision aggregate ───

/** One append-only history entry (a version of a decision in the supersession trail). */
export interface ApplicabilityHistoryEntryVM {
  readonly version: number;
  readonly state: ApplicabilityState;
  readonly result: ApplicabilityResult;
  readonly actorPrincipalId: string;
  readonly atIso: string;
  readonly note: string;
}

/** One applicability decision — its proposal, its (independent) review, and its lifecycle posture. */
export interface ApplicabilityDecisionVM {
  readonly applicabilityId: string;
  readonly clauseRef: string;
  readonly clauseTitle: string;
  readonly proposedResult: ApplicabilityResult;
  readonly state: ApplicabilityState;
  readonly rationale: string;
  readonly proposerPrincipalId: string;
  /** '' when not yet reviewed. */
  readonly reviewerPrincipalId: string;
  /** Reviewer distinct from proposer AND holds the reviewer role (FR-053). */
  readonly independentReview: boolean;
  readonly evidenceIds: readonly string[];
  /** The review-by / review-at instant. */
  readonly reviewByIso: string;
  /** `reviewByIso` has passed at the view instant. */
  readonly expired: boolean;
  /** not_applicable AND active AND expired → the coverage gap reopens (FR-054). */
  readonly reopensGap: boolean;
  /** EXACTLY what the state permits; never widened by the view. */
  readonly permittedActions: readonly ApplicabilityAction[];
  readonly history: readonly ApplicabilityHistoryEntryVM[];
}

/** The whole applicability-review model: the decisions + freshness metadata. */
export interface ApplicabilityReviewModel {
  readonly decisions: readonly ApplicabilityDecisionVM[];
  readonly generatedAtIso: string;
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed review CANNOT masquerade as an all-approved one. */
export const EMPTY_APPLICABILITY_REVIEW: ApplicabilityReviewModel = {
  decisions: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface ApplicabilityReviewProps {
  readonly tenant: TenantScope;
  readonly model: ApplicabilityReviewModel;
}

// ── Independent-review posture (FR-053) ──────────────────────────────────────────────────────────

function independentReviewBlock(d: ApplicabilityDecisionVM): string {
  const reviewed = d.reviewerPrincipalId !== '';
  const violation = d.state === 'active' && !d.independentReview;
  const independentText = d.independentReview
    ? `Reviewed independently by ${esc(d.reviewerPrincipalId)} — the reviewer is a distinct principal who holds the reviewer role, separate from the proposer ${esc(
        d.proposerPrincipalId,
      )}.`
    : reviewed
      ? `The review by ${esc(d.reviewerPrincipalId)} was NOT independent of the proposer ${esc(
          d.proposerPrincipalId,
        )}.`
      : `Not yet independently reviewed. This decision is proposed by ${esc(
          d.proposerPrincipalId,
        )} and awaits a distinct reviewer.`;
  const violationAlert = violation
    ? `
          <p role="alert" data-testid="independent-review-violation" data-severity="violation">
            INTEGRITY VIOLATION — this decision is marked active but its review was NOT independent
            of the proposer. An active applicability decision requires approval by an independent
            reviewer (FR-053). This should never occur; it is shown, not hidden.
          </p>`
    : '';
  const notActiveNote =
    d.state === 'proposed'
      ? `
          <p data-testid="not-active-note" data-state="proposed">
            This proposed decision is NOT in force. It does not take effect until an INDEPENDENT
            reviewer (someone other than the proposer, holding the reviewer role) approves it.
          </p>`
      : '';
  return `
        <div
          class="review"
          data-testid="independent-review"
          data-independent-review="${d.independentReview ? 'true' : 'false'}"
          data-reviewed="${reviewed ? 'true' : 'false'}"
          data-reviewer="${esc(d.reviewerPrincipalId)}"
          data-proposer="${esc(d.proposerPrincipalId)}"
        >
          <h4>Independent review</h4>
          <p data-testid="independent-review-text">${independentText}</p>${violationAlert}${notActiveNote}
        </div>`;
}

// ── Non-applicability / expiry posture (FR-054) ──────────────────────────────────────────────────

function applicabilityPostureBlock(d: ApplicabilityDecisionVM): string {
  const notApplicableNote =
    d.proposedResult === 'not_applicable'
      ? `
          <p data-testid="not-applicable-visible" data-result="not_applicable">
            This decision records that the publication is NOT applicable to this scope. The
            decision STAYS VISIBLE — a not-applicable determination is never removed; it remains an
            auditable record of a deliberate scoping choice.
          </p>`
      : '';
  const expiryNote = d.expired
    ? `
          <p data-testid="applicability-expired" data-expired="true">
            This decision has passed its review-by instant
            (<time datetime="${esc(d.reviewByIso)}">${esc(d.reviewByIso)}</time>) and is EXPIRED.
            It must be re-reviewed.
          </p>`
    : `
          <p data-testid="applicability-review-by" data-expired="false">
            Review-by instant:
            <time datetime="${esc(d.reviewByIso)}">${esc(d.reviewByIso)}</time>.
          </p>`;
  const reopenedGapAlert = d.reopensGap
    ? `
          <p role="alert" data-testid="reopened-gap" data-reopens-gap="true">
            A stale non-applicability reopens as a coverage gap — it does not silently suppress the
            obligation.
          </p>`
    : '';
  return `
        <div class="posture" data-testid="applicability-posture">
          <h4>Applicability &amp; expiry</h4>${notApplicableNote}${expiryNote}${reopenedGapAlert}
        </div>`;
}

// ── Evidence (each supporting artifact) ──────────────────────────────────────────────────────────

function evidenceBlock(d: ApplicabilityDecisionVM): string {
  const needsEvidence =
    d.proposedResult === 'applicable' && d.state === 'active' && d.evidenceIds.length === 0;
  if (d.evidenceIds.length === 0) {
    return `
        <div class="evidence" data-testid="applicability-evidence-block" data-evidence-count="0">
          <h4>Supporting evidence</h4>
          <p data-testid="applicability-no-evidence" data-evidence-count="0">
            No supporting evidence is attached to this decision.${
              needsEvidence
                ? ' <strong class="warn">An active, applicable decision should carry at least one piece of evidence.</strong>'
                : ''
            }
          </p>
        </div>`;
  }
  const items = d.evidenceIds
    .map(
      (id) =>
        `<li data-testid="applicability-evidence" data-evidence-id="${esc(id)}"><code>${esc(
          id,
        )}</code></li>`,
    )
    .join('');
  return `
        <div class="evidence" data-testid="applicability-evidence-block" data-evidence-count="${d.evidenceIds.length}">
          <h4>Supporting evidence</h4>
          <ul class="evidence-list">${items}</ul>
        </div>`;
}

// ── Permitted actions — EXACTLY what the state permits; never widened (FR-052) ────────────────────

function permittedActionsBlock(d: ApplicabilityDecisionVM): string {
  if (d.permittedActions.length === 0) {
    return `
        <div class="actions" data-testid="applicability-actions" data-actions="" data-count="0">
          <h4>Permitted next actions</h4>
          <p data-testid="applicability-no-actions">
            No further review action is permitted from the current state.
          </p>
        </div>`;
  }
  const items = d.permittedActions
    .map((a) => {
      const l = applicabilityActionLabel(a);
      return `<li data-testid="applicability-action" data-action="${esc(a)}"><strong>${esc(
        l.label,
      )}</strong> — ${esc(l.explanation)}</li>`;
    })
    .join('');
  return `
        <div class="actions" data-testid="applicability-actions" data-actions="${esc(
          d.permittedActions.join(' '),
        )}" data-count="${d.permittedActions.length}">
          <h4>Permitted next actions</h4>
          <ul class="action-list">${items}</ul>
        </div>`;
}

// ── History — the append-only versioning + supersession trail ─────────────────────────────────────

function historyBlock(d: ApplicabilityDecisionVM): string {
  const captionId = `history-cap-${esc(d.applicabilityId)}`;
  if (d.history.length === 0) {
    return `
        <div class="history" data-testid="applicability-history-block" data-count="0">
          <h4>Decision history</h4>
          <p data-testid="applicability-no-history">No prior versions are recorded for this decision.</p>
        </div>`;
  }
  const rows = d.history
    .map((h) => {
      const state = applicabilityStateLabel(h.state);
      const result = applicabilityResultLabel(h.result);
      return `
              <tr
                data-testid="applicability-history-row"
                data-version="${h.version}"
                data-state="${esc(h.state)}"
                data-result="${esc(h.result)}"
              >
                <td data-testid="history-version">${h.version}</td>
                <td data-testid="history-state">${esc(state.label)}</td>
                <td data-testid="history-result">${esc(result.label)}</td>
                <td data-testid="history-actor">${esc(h.actorPrincipalId)}</td>
                <td data-testid="history-at"><time datetime="${esc(h.atIso)}">${esc(h.atIso)}</time></td>
                <td data-testid="history-note">${esc(h.note)}</td>
              </tr>`;
    })
    .join('');
  return `
        <div class="history" data-testid="applicability-history-block" data-count="${d.history.length}">
          <h4>Decision history</h4>
          <table data-testid="applicability-history" aria-describedby="${captionId}">
            <caption id="${captionId}">Append-only version trail (each version retained for the audit record)</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">State</th>
                <th scope="col">Result</th>
                <th scope="col">Actor</th>
                <th scope="col">At</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
}

// ── One decision section ─────────────────────────────────────────────────────────────────────────

function decisionSection(d: ApplicabilityDecisionVM): string {
  const result = applicabilityResultLabel(d.proposedResult);
  const state = applicabilityStateLabel(d.state);
  return `
      <section
        class="decision"
        data-testid="applicability-decision"
        data-applicability-id="${esc(d.applicabilityId)}"
        data-state="${esc(d.state)}"
        data-result="${esc(d.proposedResult)}"
        data-independent-review="${d.independentReview ? 'true' : 'false'}"
        data-expired="${d.expired ? 'true' : 'false'}"
        data-reopens-gap="${d.reopensGap ? 'true' : 'false'}"
        aria-labelledby="decision-h-${esc(d.applicabilityId)}"
        tabindex="-1"
      >
        <h3 id="decision-h-${esc(d.applicabilityId)}" data-testid="decision-heading">
          <code>${esc(d.clauseRef)}</code> — ${esc(d.clauseTitle)}
        </h3>
        <p data-testid="decision-result" data-result="${esc(d.proposedResult)}">
          Proposed result: <strong>${esc(result.label)}</strong> — ${esc(result.explanation)}
        </p>
        <p data-testid="decision-state" data-state="${esc(d.state)}">
          Lifecycle state: <strong>${esc(state.label)}</strong> — ${esc(state.explanation)}
        </p>
        <p data-testid="decision-rationale">Rationale: ${esc(d.rationale)}</p>
        ${independentReviewBlock(d)}
        ${applicabilityPostureBlock(d)}
        ${evidenceBlock(d)}
        ${permittedActionsBlock(d)}
        ${historyBlock(d)}
      </section>`;
}

// ── Summary (live region) ────────────────────────────────────────────────────────────────────────

function reviewSummary(m: ApplicabilityReviewModel): string {
  const total = m.decisions.length;
  const reopened = m.decisions.filter((d) => d.reopensGap).length;
  const proposed = m.decisions.filter((d) => d.state === 'proposed').length;
  const summary =
    total === 0
      ? 'No applicability decisions are in this review.'
      : `${total} applicability decision(s) in this review — ${proposed} awaiting independent review; ${reopened} have reopened as a coverage gap.`;
  return `
      <p
        id="applicability-status"
        role="status"
        aria-live="polite"
        data-testid="applicability-summary"
        data-total="${total}"
        data-proposed="${proposed}"
        data-reopened-gaps="${reopened}"
      >${esc(summary)}</p>`;
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
        data-role="compliance-owner"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(
            tenant.tenantId,
          )})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">compliance owner</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(
            tenant.bundleId,
          )}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(
            tenant.semanticHash,
          )}</code></dd></div>
        </dl>
      </section>`;
}

const REVIEW_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    section.decision { border: 1px solid #999; border-radius: .5rem; padding: 1rem; }
    h3, h4 { margin: .5rem 0 .35rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; } dd { margin: 0; }
    ul.action-list, ul.evidence-list { margin: .25rem 0; padding-left: 1.2rem; }
    .warn { display: inline-block; }
    [role="alert"] { border-left: 4px solid #b3261e; padding-left: .6rem; font-weight: 600; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible APPLICABILITY PROPOSAL & INDEPENDENT REVIEW surface as a standalone
 * HTML document, PRESENTING the injected `props.model`. Mounted in-browser via
 * `page.setContent(renderApplicabilityReview(props))`. Single-column and wrapping, with a visible
 * focus indicator.
 */
export function renderApplicabilityReview(props: ApplicabilityReviewProps): string {
  const { tenant } = props;
  const m = props.model;
  const sections = m.decisions.map(decisionSection).join('');
  const decisionsRegion =
    m.decisions.length === 0
      ? `
        <p data-testid="applicability-empty">No applicability decisions are in this review.</p>`
      : sections;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} applicability review</title>
  <style>${REVIEW_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="applicability-title">${esc(tenant.tenantName)} — applicability review</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">Applicability decisions become in force only after independent review.</span>
    </div>
  </header>
  <main
    id="main"
    tabindex="-1"
    data-testid="applicability-main"
    data-role="compliance-owner"
    data-snapshot-digest="${esc(m.snapshotDigest)}"
    data-generated-at="${esc(m.generatedAtIso)}"
  >
    ${reviewSummary(m)}
    <section id="region-applicability" aria-labelledby="applicability-region-h" data-testid="applicability-region" tabindex="-1">
      <h2 id="applicability-region-h">Applicability proposals &amp; independent review</h2>
      <p data-testid="applicability-region-intro">
        Each applicability decision is a proposal that becomes IN FORCE only when an INDEPENDENT
        reviewer approves it (FR-053). A not-applicable determination stays visible, and a stale
        non-applicability reopens as a coverage gap rather than silently suppressing the obligation
        (FR-054). The permitted next actions shown are EXACTLY those the current state allows.
      </p>
      ${decisionsRegion}
    </section>
  </main>
  <footer>
    <p data-testid="applicability-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(
      tenant.bundleId,
    )}</code> · applicability review.</p>
  </footer>
</body>
</html>`;
}

export default renderApplicabilityReview;
