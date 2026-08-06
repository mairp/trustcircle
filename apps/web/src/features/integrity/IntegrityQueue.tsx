// TrustCircleAI — accessible DAMAGED-WORK REMEDIATION QUEUE (Phase 5 / User Story 3 / T144 /
// apps/web/src/features/integrity/IntegrityQueue.tsx / FR-016, FR-018, FR-022, SC-006, SC-009).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The remediation-reviewer-facing INTEGRITY QUEUE: the prioritized list of DAMAGED governance work
// items a reviewer triages. It answers the reviewer's first question — "of everything damaged, what
// is most severe/unsafe, what is quarantined and what does that block, what is owned (or has an
// ownership gap), and — crucially — what is genuinely VERIFIED-CLOSED versus merely un-verified?" —
// as a PURE PRESENTER over an already-prioritized queue model.
//
// THE PRIORITIZATION + CLOSURE VERDICT ARE NOT COMPUTED HERE. Every row's `priority`, `verified`,
// and `closureBlocked` come from the REAL @trustcircle/projections `IntegrityQueueProjector`
// (packages/projections/src/integrity-projector.ts), whose LOAD-BEARING rule (FR-022) is that a
// source-reported `done` or a repair's own success NEVER becomes verified closure — closure is an
// injected independent-verification verdict. This view renders the projector's ordered rows verbatim;
// it re-derives no priority and, above all, INVENTS NO POSITIVE CLOSURE VERDICT.
//
// FILTERS NEVER DELETE A CASE. Each filter (problem class, severity, safety impact, quarantine,
// ownership gap, verified/unverified, human-attention) is a declarative `[aria-pressed]` toggle. A
// row a filter hides stays in the DOM as a `hidden` row carrying `data-filtered-out-reason`, so
// filtering a queue never makes an unsafe, contained, unverified case silently vanish.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every row states its severity, safety impact,
// quarantine status, and — most importantly — whether it is verified-closed or blocked, with a
// machine-readable `data-verified` + `data-closure-blocked`, and unverified/unsafe rows carry an
// explicit textual warning. A live `role=status` region reports visible/attention/closed counts.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — they are pure string-builder presenters (tsconfig `jsx:preserve`
// only satisfies the extension resolver). The output is a self-contained HTML string the e2e spec
// mounts via `page.setContent(renderIntegrityQueue(props))` and asserts through axe-core + the live
// accessibility tree, with NO web server, NO React, NO tenant-auth.
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

/** One prioritized integrity-queue row (a projected `IntegrityQueueRow`). */
export interface IntegrityQueueRowVM {
  readonly caseId: string;
  readonly workItemId: string;
  readonly problemClass: string;
  /** The full defect class set (combined cases carry ≥2). */
  readonly problemClasses: readonly string[];
  readonly severity: string;
  readonly safetyImpact: string;
  readonly state: string;
  /** The resolved owner, or empty when there is an explicit ownership gap (FR-018). */
  readonly ownerPrincipalId: string;
  readonly ownershipGap: boolean;
  readonly quarantineActive: boolean;
  /** The capabilities the quarantine currently blocks (empty when not quarantined). */
  readonly blockedCapabilities: readonly string[];
  /** Count of dependent work items (propagation). */
  readonly dependentCount: number;
  /** The AUTHORITATIVE verified-closure flag — TRUE only via an independent passing verdict (FR-022). */
  readonly verified: boolean;
  /** True iff the case may be shown as closed (verified AND a closing state). */
  readonly closureRealized: boolean;
  /** Why closure is not (yet) realized (empty ⇒ verified-closed). The honest, visible reasons. */
  readonly closureBlocked: readonly string[];
  /** True iff human attention is required (escalated / unowned / unsafe-unverified). */
  readonly needsHumanAttention: boolean;
  readonly priority: number;
  /** The lower-cased searchable text index for this row. */
  readonly searchIndex: string;
  /** Whether this row survived the ACTIVE query + filters (true ⇒ shown; false ⇒ hidden+reason). */
  readonly matches: boolean;
  /** When `!matches`, the machine-readable reason it was filtered out (empty when it matches). */
  readonly filteredOutReason: string;
}

/** One selectable facet filter chip (a declarative, machine-readable toggle). */
export interface IntegrityFilterChipVM {
  readonly facet:
    'problem_class' | 'severity' | 'safety' | 'quarantine' | 'ownership' | 'closure' | 'attention';
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
}

/** The active search/filter query state, echoed into the controls so it is independently observable. */
export interface IntegrityQueryStateVM {
  readonly text: string;
  readonly activeFilters: readonly string[];
  readonly visible: number;
  readonly total: number;
  readonly attentionVisible: number;
  readonly verifiedClosedVisible: number;
  /** A non-color-only sentence describing the current result set (WCAG 1.4.1). */
  readonly resultSummary: string;
}

/** Queue freshness posture from the projection metadata (never falsely 'current'). */
export interface IntegrityMetadataVM {
  readonly generatedAtIso: string;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  /** The projector snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
  /** Fail-visible safe next action when the queue is not current/complete (empty when current). */
  readonly safeNextAction: string;
}

/** The whole queue model: the prioritized rows + the filters + the query + the metadata. */
export interface IntegrityQueueModel {
  readonly rows: readonly IntegrityQueueRowVM[];
  readonly filters: readonly IntegrityFilterChipVM[];
  readonly query: IntegrityQueryStateVM;
  readonly metadata: IntegrityMetadataVM;
}

/** An EMPTY-but-valid model — an un-fed queue CANNOT masquerade as a satisfied (all-clean) queue. */
export const EMPTY_INTEGRITY_QUEUE: IntegrityQueueModel = {
  rows: [],
  filters: [],
  query: {
    text: '',
    activeFilters: [],
    visible: 0,
    total: 0,
    attentionVisible: 0,
    verifiedClosedVisible: 0,
    resultSummary: 'No damaged-work cases are in this queue.',
  },
  metadata: {
    generatedAtIso: '1970-01-01T00:00:00.000Z',
    // No queue read ⇒ freshness is UNKNOWN, never falsely 'current'.
    freshness: 'unknown',
    partialCoverage: false,
    snapshotDigest: 'empty',
    safeNextAction: '',
  },
} as const;

export interface IntegrityQueueProps {
  readonly tenant: TenantScope;
  readonly model: IntegrityQueueModel;
}

// ── Controls ────────────────────────────────────────────────────────────────────────────────────

function searchAndFilterControls(m: IntegrityQueueModel): string {
  const q = m.query;
  const chips = m.filters
    .map(
      (f) => `
          <button
            type="button"
            class="chip"
            data-testid="integrity-filter-chip"
            data-facet="${esc(f.facet)}"
            data-value="${esc(f.value)}"
            aria-pressed="${f.active ? 'true' : 'false'}"
          >${esc(f.label)}</button>`,
    )
    .join('');
  return `
      <section
        id="region-integrity-search"
        aria-labelledby="integrity-search-h"
        data-testid="integrity-search"
        data-query-text="${esc(q.text)}"
        data-active-filters="${esc(q.activeFilters.join('|'))}"
        tabindex="-1"
      >
        <h2 id="integrity-search-h">Search &amp; filter the damaged-work queue</h2>
        <div class="search-row">
          <label for="integrity-search-input" data-testid="integrity-search-label">Search damaged-work cases</label>
          <input
            id="integrity-search-input"
            type="search"
            role="searchbox"
            data-testid="integrity-search-input"
            value="${esc(q.text)}"
            aria-describedby="integrity-status"
            placeholder="Search by case, work item, problem class, severity, owner…"
          />
        </div>
        <div class="chip-toolbar" role="group" aria-label="Case filters (problem class, severity, safety, quarantine, ownership, closure, attention)" data-testid="integrity-filter-toolbar">${chips}
        </div>
        <p
          id="integrity-status"
          role="status"
          aria-live="polite"
          data-testid="integrity-result-status"
          data-visible="${q.visible}"
          data-total="${q.total}"
          data-attention-visible="${q.attentionVisible}"
          data-verified-closed-visible="${q.verifiedClosedVisible}"
        >${esc(q.resultSummary)}</p>
      </section>`;
}

// ── One queue row ────────────────────────────────────────────────────────────────────────────────

function classesCell(classes: readonly string[]): string {
  if (classes.length === 0) return '<span data-testid="row-no-classes">unknown</span>';
  const items = classes
    .map((c) => `<li data-testid="row-problem-class" data-class="${esc(c)}">${esc(c)}</li>`)
    .join('');
  return `<ul class="class-list" data-testid="row-problem-classes" data-count="${classes.length}">${items}</ul>`;
}

function quarantineCell(r: IntegrityQueueRowVM): string {
  if (!r.quarantineActive) {
    return '<span data-testid="row-not-quarantined">not quarantined</span>';
  }
  const blocked =
    r.blockedCapabilities.length > 0 ? esc(r.blockedCapabilities.join(', ')) : 'all governed use';
  return `<span data-testid="row-quarantined" data-blocked="${esc(r.blockedCapabilities.join(' '))}">quarantined — blocks ${blocked}</span>`;
}

function ownerCell(r: IntegrityQueueRowVM): string {
  if (r.ownershipGap) {
    return '<strong class="warn" data-testid="row-ownership-gap" data-severity="ownership_gap">OWNERSHIP GAP — no owner to accept resolution (routed for assignment).</strong>';
  }
  return `<span data-testid="row-owner">${esc(r.ownerPrincipalId)}</span>`;
}

/** The AUTHORITATIVE closure cell — verified-closed OR the honest blockers (FR-022). Never color-only. */
function closureCell(r: IntegrityQueueRowVM): string {
  if (r.closureRealized) {
    return '<strong data-testid="row-verified-closed" data-verified="true">VERIFIED-CLOSED — independent nine-gate verification passed.</strong>';
  }
  const blockers =
    r.closureBlocked.length > 0 ? esc(r.closureBlocked.join(', ')) : 'not yet verified';
  return `<strong class="warn" data-testid="row-not-closed" data-verified="false" data-closure-blocked="${esc(
    r.closureBlocked.join(' '),
  )}">NOT verified-closed — ${blockers}.</strong>`;
}

/** Explicit textual warning for unsafe/attention rows (never color-only). */
function attentionWarning(r: IntegrityQueueRowVM): string {
  if (!r.needsHumanAttention) return '';
  return '<strong class="warn" data-testid="row-attention-warning" data-severity="attention">Needs human attention — cannot be resolved automatically.</strong>';
}

function integrityRow(r: IntegrityQueueRowVM): string {
  const hidden = r.matches ? '' : ' hidden';
  const reason = r.matches ? '' : ` data-filtered-out-reason="${esc(r.filteredOutReason)}"`;
  return `
        <tr
          data-testid="integrity-row"
          data-case-id="${esc(r.caseId)}"
          data-priority="${r.priority}"
          data-problem-class="${esc(r.problemClass)}"
          data-severity="${esc(r.severity)}"
          data-safety-impact="${esc(r.safetyImpact)}"
          data-state="${esc(r.state)}"
          data-quarantine-active="${r.quarantineActive ? 'true' : 'false'}"
          data-ownership-gap="${r.ownershipGap ? 'true' : 'false'}"
          data-verified="${r.verified ? 'true' : 'false'}"
          data-closure-realized="${r.closureRealized ? 'true' : 'false'}"
          data-needs-attention="${r.needsHumanAttention ? 'true' : 'false'}"
          data-dependents="${r.dependentCount}"
          data-search-index="${esc(r.searchIndex)}"
          data-matches="${r.matches ? 'true' : 'false'}"${reason}${hidden}
        >
          <th scope="row"><a href="#case-${esc(r.caseId)}" data-testid="row-case-link">${esc(
            r.caseId,
          )}</a></th>
          <td data-testid="row-priority">${r.priority}</td>
          <td data-testid="row-classes">${classesCell(r.problemClasses)}</td>
          <td data-testid="row-severity">${esc(r.severity)}</td>
          <td data-testid="row-safety">${esc(r.safetyImpact)}</td>
          <td data-testid="row-state">${esc(r.state)}</td>
          <td data-testid="row-owner-cell">${ownerCell(r)}</td>
          <td data-testid="row-quarantine">${quarantineCell(r)}</td>
          <td data-testid="row-dependents">${r.dependentCount}</td>
          <td data-testid="row-closure">${closureCell(r)} ${attentionWarning(r)}</td>
        </tr>`;
}

function queueRegion(m: IntegrityQueueModel): string {
  const rows = m.rows.map(integrityRow).join('');
  const visible = m.rows.filter((r) => r.matches).length;
  const attention = m.rows.filter((r) => r.matches && r.needsHumanAttention).length;
  const closed = m.rows.filter((r) => r.matches && r.closureRealized).length;
  return `
      <section id="region-integrity-queue" aria-labelledby="queue-h" data-testid="integrity-queue" tabindex="-1">
        <h2 id="queue-h">Prioritized damaged-work queue</h2>
        <p id="queue-summary" data-testid="queue-summary" data-visible="${visible}" data-total="${m.rows.length}" data-attention="${attention}" data-verified-closed="${closed}">
          ${visible} of ${m.rows.length} damaged-work case(s) match the active search and filters
          (${attention} need human attention; ${closed} are verified-closed). Rows are ordered by
          priority (severity × safety impact × containment × propagation). Filtering never removes a
          case: a hidden row stays as a record with its filter reason. A source-reported "done" or a
          repair's own success is NEVER shown as closure — only an independent, passing nine-gate
          verification is verified-closed.
        </p>
        <table aria-describedby="queue-summary">
          <caption>Damaged-work cases in priority order (priority, problem classes, severity, safety impact, state, owner, quarantine, dependents, verified closure)</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Priority</th>
              <th scope="col">Problem class(es)</th>
              <th scope="col">Severity</th>
              <th scope="col">Safety impact</th>
              <th scope="col">State</th>
              <th scope="col">Owner</th>
              <th scope="col">Quarantine</th>
              <th scope="col">Dependents</th>
              <th scope="col">Verified closure</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function metadataRegion(md: IntegrityMetadataVM): string {
  const notCurrent = md.freshness !== 'current' || md.partialCoverage;
  return `
      <section id="region-integrity-metadata" aria-labelledby="integrity-md-h" data-testid="integrity-metadata" tabindex="-1"
        data-freshness="${esc(md.freshness)}" data-partial-coverage="${md.partialCoverage ? 'true' : 'false'}"
        data-snapshot-digest="${esc(md.snapshotDigest)}">
        <h2 id="integrity-md-h" class="visually-hidden">Queue freshness</h2>
        <p data-testid="integrity-freshness">
          Queue generated <time datetime="${esc(md.generatedAtIso)}">${esc(md.generatedAtIso)}</time>.
          Freshness: <strong data-testid="integrity-freshness-value">${esc(md.freshness)}</strong>.
          ${md.partialCoverage ? 'Coverage is <strong data-testid="integrity-partial">partial</strong>.' : 'Coverage is complete.'}
        </p>
        ${
          notCurrent && md.safeNextAction
            ? `<p role="alert" data-testid="integrity-safe-next-action">${esc(md.safeNextAction)}</p>`
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
        data-role="remediation-reviewer"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">remediation reviewer</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const QUEUE_STYLE = `
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
    ul.class-list { margin: 0; padding-left: 1rem; }
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
 * Render the complete accessible INTEGRITY QUEUE as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderIntegrityQueue(props))`.
 * Single-column and wrapping, with a visible focus indicator.
 */
export function renderIntegrityQueue(props: IntegrityQueueProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} damaged-work queue</title>
  <style>${QUEUE_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="integrity-title">${esc(tenant.tenantName)} — damaged-work remediation queue</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(m.query.resultSummary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="integrity-main" data-role="remediation-reviewer" data-snapshot-digest="${esc(m.metadata.snapshotDigest)}">
    ${searchAndFilterControls(m)}
    ${queueRegion(m)}
    ${metadataRegion(m.metadata)}
  </main>
  <footer>
    <p data-testid="integrity-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · prioritized damaged-work queue.</p>
  </footer>
</body>
</html>`;
}

export default renderIntegrityQueue;
