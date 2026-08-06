// TrustCircleAI — accessible PRIORITIZED DECISION INBOX (Phase 4 / User Story 2 / T109 /
// apps/web/src/features/decisions/DecisionInbox.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The approver-facing DECISION QUEUE: the prioritized list of pending decisions an authorized
// reviewer triages. It answers the reviewer's first question — "of everything waiting on me, what
// is most urgent, what can I actually act on, and what is about to expire or has been escalated?" —
// and it does so as a PURE PRESENTER over an already-prioritized queue model.
//
// THE PRIORITIZATION IS NOT COMPUTED HERE. Every row's `priority`, `timePosture`, `conflicts`, and
// `allowedActions` are produced by the REAL @trustcircle/projections `DecisionQueueProjector`
// (packages/projections/src/decision-projector.ts) — impact × risk × time-pressure × actionability
// (SC-003) — folded by the composition root at an injected instant. The e2e/accessibility spec
// derives the model from that projector and injects it here, so every ordering/actionability
// assertion observes GENUINELY prioritized state. This view renders the projector's ordered rows
// verbatim; it re-derives no priority and invents no authority.
//
// FILTERS NEVER DELETE A DECISION (queue-integrity discipline, mirrored from the Phase-79 inventory
// tables). Each filter — dependency (open requirements), impact, expiry posture, escalation, and
// actionability — is a declarative `[aria-pressed]` toggle. A row a filter hides stays in the DOM as
// a `hidden` row carrying a machine-readable `data-filtered-out-reason`, so filtering a queue never
// makes an urgent, unactioned decision silently vanish (a hidden expiring decision is still expiring).
//
// TIME PRESSURE IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every row states its time posture
// (fresh / aging / expiring soon / expired) and a machine-readable `data-time-posture` +
// `data-time-to-expiry-ms`, and expiring/expired rows carry an explicit textual warning — never a
// color-only cue. A live `role=status` region reports the visible/actionable/hidden counts.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React runtime
// yet, and the repo's TypeScript base sets no `jsx` emit (the `.tsx` files here contain NO JSX — they
// are pure string-builder presenters; tsconfig `jsx:preserve` only satisfies the extension resolver).
// Because the output is a self-contained HTML string, the spec mounts it in a REAL browser via
// `page.setContent(renderDecisionInbox(props))` and asserts — through axe-core and the live
// accessibility tree — every obligation, with NO web server, NO React, and NO tenant-auth.
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

// ── The queue view model — the render-ready reduction of the projector's rows ───────────────────
//
// Produced by the e2e/accessibility support derivation, which runs the real DecisionQueueProjector
// over a deterministic scenario and maps each `DecisionQueueRow` into these display fields. Every
// value is a projection of a value the projector COMPUTED — the presenter invents nothing.

/** One open requirement gate on a decision (a still-unsatisfied dependency). */
export interface InboxRequirementVM {
  readonly id: string;
  readonly gateType: string;
  /** true ⇒ a non-waivable CENTRAL guardrail (tenant-independent); false ⇒ a tenant-scoped gate. */
  readonly central: boolean;
}

/** One prioritized decision-queue row (a projected `DecisionQueueRow`). */
export interface DecisionInboxRowVM {
  readonly decisionId: string;
  readonly workItemId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: string;
  readonly impact: string;
  readonly status: string;
  /** Human, non-color age label ("2h ago", "3 days ago"). */
  readonly ageLabel: string;
  /** Machine-readable time-to-expiry in ms (negative once expired). */
  readonly timeToExpiryMillis: number;
  /** fresh | aging | expiring_soon | expired. */
  readonly timePosture: string;
  /** Human, non-color expiry label ("expires in 45m", "EXPIRED 2h ago"). */
  readonly expiryLabel: string;
  readonly evidenceCurrency: string;
  /** The still-open requirement gates (central guardrails first), kept even when the row is filtered. */
  readonly openRequirements: readonly InboxRequirementVM[];
  readonly isCrossTenant: boolean;
  /** true iff this decision has been escalated (surfaced as an explicit filter + row flag). */
  readonly escalated: boolean;
  /** The conflicts blocking the actor (empty ⇒ no authority/state conflict). */
  readonly conflicts: readonly string[];
  /** The verbs the actor may currently take (empty ⇒ view-only). */
  readonly allowedActions: readonly string[];
  readonly actionable: boolean;
  readonly priority: number;
  /** The lower-cased searchable text index for this row. */
  readonly searchIndex: string;
  /** Whether this row survived the ACTIVE query + filters (true ⇒ shown; false ⇒ hidden+reason). */
  readonly matches: boolean;
  /** When `!matches`, the machine-readable reason it was filtered out (empty when it matches). */
  readonly filteredOutReason: string;
}

/** One selectable facet filter chip (a declarative, machine-readable toggle). */
export interface InboxFilterChipVM {
  readonly facet: 'dependency' | 'impact' | 'expiry' | 'escalation' | 'actionability';
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
}

/** The active search/filter query state, echoed into the controls so it is independently observable. */
export interface InboxQueryStateVM {
  readonly text: string;
  readonly activeFilters: readonly string[];
  readonly visible: number;
  readonly total: number;
  readonly actionableVisible: number;
  /** A non-color-only sentence describing the current result set (WCAG 1.4.1). */
  readonly resultSummary: string;
}

/** Queue freshness posture from the projection metadata (never falsely 'current'). */
export interface InboxMetadataVM {
  readonly generatedAtIso: string;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  /** The projector snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
  /** Fail-visible safe next action when the queue is not current/complete (empty when current). */
  readonly safeNextAction: string;
}

/** The whole inbox model: the prioritized rows + the filters + the query + the metadata. */
export interface DecisionInboxModel {
  readonly rows: readonly DecisionInboxRowVM[];
  readonly filters: readonly InboxFilterChipVM[];
  readonly query: InboxQueryStateVM;
  readonly metadata: InboxMetadataVM;
}

/** An EMPTY-but-valid model — an un-fed inbox CANNOT masquerade as a satisfied queue. */
export const EMPTY_DECISION_INBOX: DecisionInboxModel = {
  rows: [],
  filters: [],
  query: {
    text: '',
    activeFilters: [],
    visible: 0,
    total: 0,
    actionableVisible: 0,
    resultSummary: 'No decisions are waiting in this queue.',
  },
  metadata: {
    generatedAtIso: '1970-01-01T00:00:00.000Z',
    // No queue read ⇒ freshness is UNKNOWN, never falsely 'current' (SC-004).
    freshness: 'unknown',
    partialCoverage: false,
    snapshotDigest: 'empty',
    safeNextAction: '',
  },
} as const;

export interface DecisionInboxProps {
  readonly tenant: TenantScope;
  readonly model: DecisionInboxModel;
}

// ── Controls ────────────────────────────────────────────────────────────────────────────────────

function searchAndFilterControls(m: DecisionInboxModel): string {
  const q = m.query;
  const chips = m.filters
    .map(
      (f) => `
          <button
            type="button"
            class="chip"
            data-testid="inbox-filter-chip"
            data-facet="${esc(f.facet)}"
            data-value="${esc(f.value)}"
            aria-pressed="${f.active ? 'true' : 'false'}"
          >${esc(f.label)}</button>`,
    )
    .join('');
  return `
      <section
        id="region-inbox-search"
        aria-labelledby="inbox-search-h"
        data-testid="inbox-search"
        data-query-text="${esc(q.text)}"
        data-active-filters="${esc(q.activeFilters.join('|'))}"
        tabindex="-1"
      >
        <h2 id="inbox-search-h">Search &amp; filter the decision queue</h2>
        <div class="search-row">
          <label for="inbox-search-input" data-testid="inbox-search-label">Search pending decisions</label>
          <input
            id="inbox-search-input"
            type="search"
            role="searchbox"
            data-testid="inbox-search-input"
            value="${esc(q.text)}"
            aria-describedby="inbox-status"
            placeholder="Search by decision, work item, requester, action, risk…"
          />
        </div>
        <div class="chip-toolbar" role="group" aria-label="Decision filters (dependency, impact, expiry, escalation, actionability)" data-testid="inbox-filter-toolbar">${chips}
        </div>
        <p
          id="inbox-status"
          role="status"
          aria-live="polite"
          data-testid="inbox-result-status"
          data-visible="${q.visible}"
          data-total="${q.total}"
          data-actionable-visible="${q.actionableVisible}"
        >${esc(q.resultSummary)}</p>
      </section>`;
}

// ── One queue row ────────────────────────────────────────────────────────────────────────────────

function requirementsCell(reqs: readonly InboxRequirementVM[]): string {
  if (reqs.length === 0) return '<span data-testid="row-no-open-requirements">no open requirements</span>';
  const items = reqs
    .map(
      (r) =>
        `<li data-testid="row-open-requirement" data-gate-type="${esc(r.gateType)}" data-central="${
          r.central ? 'true' : 'false'
        }">${esc(r.gateType)}${r.central ? ' (central guardrail)' : ''}</li>`,
    )
    .join('');
  return `<ul class="req-list" data-testid="row-open-requirements" data-open-count="${reqs.length}">${items}</ul>`;
}

function conflictsCell(conflicts: readonly string[]): string {
  if (conflicts.length === 0) return '<span data-testid="row-no-conflicts">none</span>';
  return `<span data-testid="row-conflicts" data-conflicts="${esc(conflicts.join(' '))}">${esc(
    conflicts.join(', '),
  )}</span>`;
}

function actionsCell(actions: readonly string[]): string {
  if (actions.length === 0) {
    return '<span data-testid="row-view-only">view only — no actions available to you</span>';
  }
  return `<span data-testid="row-allowed-actions" data-actions="${esc(actions.join(' '))}">${esc(
    actions.join(', '),
  )}</span>`;
}

/** The explicit textual time warning for expiring/expired rows (never color-only). */
function timeWarning(r: DecisionInboxRowVM): string {
  if (r.timePosture === 'expired') {
    return `<strong class="warn" data-testid="row-time-warning" data-severity="expired">Expired — dispose of this decision (expire or cancel).</strong>`;
  }
  if (r.timePosture === 'expiring_soon') {
    return `<strong class="warn" data-testid="row-time-warning" data-severity="expiring_soon">Expiring soon — act before it lapses.</strong>`;
  }
  return '';
}

function inboxRow(r: DecisionInboxRowVM): string {
  const hidden = r.matches ? '' : ' hidden';
  const reason = r.matches ? '' : ` data-filtered-out-reason="${esc(r.filteredOutReason)}"`;
  return `
        <tr
          data-testid="inbox-row"
          data-decision-id="${esc(r.decisionId)}"
          data-priority="${r.priority}"
          data-time-posture="${esc(r.timePosture)}"
          data-time-to-expiry-ms="${r.timeToExpiryMillis}"
          data-impact="${esc(r.impact)}"
          data-risk="${esc(r.riskTier)}"
          data-actionable="${r.actionable ? 'true' : 'false'}"
          data-escalated="${r.escalated ? 'true' : 'false'}"
          data-cross-tenant="${r.isCrossTenant ? 'true' : 'false'}"
          data-open-requirements="${r.openRequirements.length}"
          data-evidence-currency="${esc(r.evidenceCurrency)}"
          data-search-index="${esc(r.searchIndex)}"
          data-matches="${r.matches ? 'true' : 'false'}"${reason}${hidden}
        >
          <th scope="row"><a href="#decision-${esc(r.decisionId)}" data-testid="row-decision-link">${esc(
            r.decisionId,
          )}</a></th>
          <td data-testid="row-priority">${r.priority}</td>
          <td data-testid="row-requested-action">${esc(r.requestedAction)}</td>
          <td data-testid="row-action-class">${esc(r.actionClass)}</td>
          <td data-testid="row-requester">${esc(r.requesterPrincipalId)}</td>
          <td data-testid="row-impact">${esc(r.impact)}</td>
          <td data-testid="row-risk">${esc(r.riskTier)}</td>
          <td data-testid="row-status">${esc(r.status)}</td>
          <td data-testid="row-age">${esc(r.ageLabel)}</td>
          <td data-testid="row-expiry" data-time-posture="${esc(r.timePosture)}">
            ${esc(r.expiryLabel)} ${timeWarning(r)}
          </td>
          <td data-testid="row-evidence">${esc(r.evidenceCurrency)}</td>
          <td data-testid="row-requirements">${requirementsCell(r.openRequirements)}</td>
          <td data-testid="row-cross-tenant">${
            r.isCrossTenant
              ? '<span data-testid="row-cross-tenant-flag">cross-tenant / joint</span>'
              : 'single tenant'
          }</td>
          <td data-testid="row-escalated">${r.escalated ? 'escalated' : 'not escalated'}</td>
          <td data-testid="row-conflicts-cell">${conflictsCell(r.conflicts)}</td>
          <td data-testid="row-actions-cell">${actionsCell(r.allowedActions)}</td>
        </tr>`;
}

function queueRegion(m: DecisionInboxModel): string {
  const rows = m.rows.map(inboxRow).join('');
  const visible = m.rows.filter((r) => r.matches).length;
  const actionable = m.rows.filter((r) => r.matches && r.actionable).length;
  return `
      <section id="region-inbox-queue" aria-labelledby="queue-h" data-testid="decision-queue" tabindex="-1">
        <h2 id="queue-h">Prioritized decision queue</h2>
        <p id="queue-summary" data-testid="queue-summary" data-visible="${visible}" data-total="${m.rows.length}" data-actionable="${actionable}">
          ${visible} of ${m.rows.length} pending decision(s) match the active search and filters
          (${actionable} you can act on now). Rows are ordered by priority (impact × risk × time
          pressure × actionability). Filtering never removes a decision: a hidden row stays in the
          queue as a record with its filter reason. Time pressure and escalation are stated in text.
        </p>
        <table aria-describedby="queue-summary">
          <caption>Pending decisions in priority order (priority, requested action, action class, requester, impact, risk, status, age, expiry, evidence currency, open requirements, cross-tenant, escalation, conflicts, available actions)</caption>
          <thead>
            <tr>
              <th scope="col">Decision</th>
              <th scope="col">Priority</th>
              <th scope="col">Requested action</th>
              <th scope="col">Action class</th>
              <th scope="col">Requester</th>
              <th scope="col">Impact</th>
              <th scope="col">Risk</th>
              <th scope="col">Status</th>
              <th scope="col">Age</th>
              <th scope="col">Expiry</th>
              <th scope="col">Evidence</th>
              <th scope="col">Open requirements</th>
              <th scope="col">Scope</th>
              <th scope="col">Escalation</th>
              <th scope="col">Conflicts</th>
              <th scope="col">Available actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function metadataRegion(md: InboxMetadataVM): string {
  const notCurrent = md.freshness !== 'current' || md.partialCoverage;
  return `
      <section id="region-inbox-metadata" aria-labelledby="inbox-md-h" data-testid="inbox-metadata" tabindex="-1"
        data-freshness="${esc(md.freshness)}" data-partial-coverage="${md.partialCoverage ? 'true' : 'false'}"
        data-snapshot-digest="${esc(md.snapshotDigest)}">
        <h2 id="inbox-md-h" class="visually-hidden">Queue freshness</h2>
        <p data-testid="inbox-freshness">
          Queue generated <time datetime="${esc(md.generatedAtIso)}">${esc(md.generatedAtIso)}</time>.
          Freshness: <strong data-testid="inbox-freshness-value">${esc(md.freshness)}</strong>.
          ${md.partialCoverage ? 'Coverage is <strong data-testid="inbox-partial">partial</strong>.' : 'Coverage is complete.'}
        </p>
        ${
          notCurrent && md.safeNextAction
            ? `<p role="alert" data-testid="inbox-safe-next-action">${esc(md.safeNextAction)}</p>`
            : ''
        }
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
        data-role="approver"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">approver</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const INBOX_STYLE = `
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
    ul.req-list { margin: 0; padding-left: 1rem; }
    .search-row { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .5rem; }
    .search-row input { font: inherit; padding: .35rem .5rem; max-width: 100%; }
    .chip-toolbar { display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: .5rem; }
    .chip { font: inherit; padding: .25rem .6rem; border: 1px solid #666; border-radius: 1rem; background: #f3f3f3; cursor: pointer; }
    .chip[aria-pressed="true"] { background: #0b57d0; color: #fff; border-color: #0b57d0; }
    .warn { display: inline-block; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible DECISION INBOX as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderDecisionInbox(props))`.
 * Single-column and wrapping, with a visible focus indicator.
 */
export function renderDecisionInbox(props: DecisionInboxProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} decision queue</title>
  <style>${INBOX_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="inbox-title">${esc(tenant.tenantName)} — decision queue</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(m.query.resultSummary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="inbox-main" data-role="approver" data-snapshot-digest="${esc(m.metadata.snapshotDigest)}">
    ${searchAndFilterControls(m)}
    ${queueRegion(m)}
    ${metadataRegion(m.metadata)}
  </main>
  <footer>
    <p data-testid="inbox-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · prioritized decision queue.</p>
  </footer>
</body>
</html>`;
}

export default renderDecisionInbox;
