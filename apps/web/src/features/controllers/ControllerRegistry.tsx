// TrustCircleAI — accessible GOVERNANCE-CONTROLLER REGISTRY (Phase 6 / User Story 4 / T174 /
// apps/web/src/features/controllers/ControllerRegistry.tsx / FR-023, FR-024, SC-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The operator-facing GOVERNANCE-CONTROLLER REGISTRY: the prioritized list of discovered controller
// instances an operator inspects before acting. It answers the operator's first question — "of every
// controller, which needs attention (unhealthy, drifted, or dependency-degraded), what is its DESIRED
// vs OBSERVED state (the drift is never masked by health), what version+adapter is pinned, and —
// crucially — what EXACT next actions am I permitted to take?" — as a PURE PRESENTER over an
// already-prioritized registry model.
//
// THE PRIORITY, DRIFT, ATTENTION, AND PERMITTED-ACTION VERDICTS ARE NOT COMPUTED HERE. Every row's
// `priority`, `drift`, `needsAttention`, and `nextPermittedActions` come from the REAL
// @trustcircle/projections `ControllerProjector`
// (packages/projections/src/controller-projector.ts), whose LOAD-BEARING rules are that drift
// (`desired ≠ observed`) is NEVER masked by a healthy status (FR-024) and the permitted-action set is
// EXACTLY `allowedNextOperations(state)` — never widened by the view. This presenter renders those
// ordered rows verbatim; it re-derives no priority, masks no drift, and INVENTS NO EXTRA PERMITTED
// ACTION.
//
// FILTERS NEVER DELETE A CONTROLLER. Each filter (health, drift, attention, continuity) is a
// declarative `[aria-pressed]` toggle. A row a filter hides stays in the DOM as a `hidden` row carrying
// `data-filtered-out-reason`, so filtering a registry never makes an unhealthy, drifted controller
// silently vanish.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every row states its health, drift status,
// and attention need in words, with a machine-readable `data-health` + `data-drift` +
// `data-needs-attention`, and drifted/attention rows carry an explicit textual warning. A live
// `role=status` region reports visible/attention counts.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — they are pure string-builder presenters (tsconfig `jsx:preserve`
// only satisfies the extension resolver). The output is a self-contained HTML string the e2e spec
// mounts via `page.setContent(renderControllerRegistry(props))` and asserts through axe-core + the
// live accessibility tree, with NO web server, NO React, NO tenant-auth.
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

/** Canonical, sorted-key JSON so DESIRED vs OBSERVED render deterministically for the drift check. */
function canonicalJson(v: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(v).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`);
  return `{${parts.join(',')}}`;
}

// ── The registry view model — the render-ready reduction of the projector's rows ────────────────

/** One prioritized controller-registry row (a projected `ControllerRegistryRow`). */
export interface ControllerRegistryRowVM {
  readonly instanceId: string;
  readonly controllerId: string;
  readonly name: string;
  readonly controllerVersion: number;
  readonly controllerVersionId: string;
  readonly adapterVersionId: string;
  readonly ownerPrincipalId: string;
  readonly sourceRevision: string;
  readonly health: string;
  /** The DESIRED end state (canonical map). */
  readonly desiredState: Readonly<Record<string, unknown>>;
  /** The OBSERVED current state (canonical map). Drift = desired ≠ observed — NEVER masked (FR-024). */
  readonly observedState: Readonly<Record<string, unknown>>;
  /** The AUTHORITATIVE drift flag from the projector (desired ≠ observed). */
  readonly drift: boolean;
  /** True iff any declared dependency is degraded/unavailable. */
  readonly dependencyDegraded: boolean;
  /** True iff the controller needs operator attention (unhealthy OR drifted OR dependency-degraded). */
  readonly needsAttention: boolean;
  /** The active operation id, or empty when the controller is idle. */
  readonly activeOperationId: string;
  /** The EXACT next operation kinds permitted from the controller's current posture (FR-024). */
  readonly nextPermittedActions: readonly string[];
  readonly priority: number;
  /** The lower-cased searchable text index for this row. */
  readonly searchIndex: string;
  /** Whether this row survived the ACTIVE query + filters (true ⇒ shown; false ⇒ hidden+reason). */
  readonly matches: boolean;
  /** When `!matches`, the machine-readable reason it was filtered out (empty when it matches). */
  readonly filteredOutReason: string;
}

/** One selectable facet filter chip (a declarative, machine-readable toggle). */
export interface ControllerFilterChipVM {
  readonly facet: 'health' | 'drift' | 'attention' | 'continuity';
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
}

/** The active search/filter query state, echoed into the controls so it is independently observable. */
export interface ControllerQueryStateVM {
  readonly text: string;
  readonly activeFilters: readonly string[];
  readonly visible: number;
  readonly total: number;
  readonly attentionVisible: number;
  readonly driftedVisible: number;
  /** A non-color-only sentence describing the current result set (WCAG 1.4.1). */
  readonly resultSummary: string;
}

/** Registry freshness posture from the projection metadata (never falsely 'current'). */
export interface ControllerMetadataVM {
  readonly generatedAtIso: string;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  /** The projector snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
  /** Fail-visible safe next action when the registry is not current/complete (empty when current). */
  readonly safeNextAction: string;
}

/** The whole registry model: the prioritized rows + the filters + the query + the metadata. */
export interface ControllerRegistryModel {
  readonly rows: readonly ControllerRegistryRowVM[];
  readonly filters: readonly ControllerFilterChipVM[];
  readonly query: ControllerQueryStateVM;
  readonly metadata: ControllerMetadataVM;
}

/** An EMPTY-but-valid model — an un-fed registry CANNOT masquerade as a satisfied (all-healthy) one. */
export const EMPTY_CONTROLLER_REGISTRY: ControllerRegistryModel = {
  rows: [],
  filters: [],
  query: {
    text: '',
    activeFilters: [],
    visible: 0,
    total: 0,
    attentionVisible: 0,
    driftedVisible: 0,
    resultSummary: 'No governance controllers are in this registry.',
  },
  metadata: {
    generatedAtIso: '1970-01-01T00:00:00.000Z',
    // No registry read ⇒ freshness is UNKNOWN, never falsely 'current'.
    freshness: 'unknown',
    partialCoverage: false,
    snapshotDigest: 'empty',
    safeNextAction: '',
  },
} as const;

export interface ControllerRegistryProps {
  readonly tenant: TenantScope;
  readonly model: ControllerRegistryModel;
}

// ── Controls ────────────────────────────────────────────────────────────────────────────────────

function searchAndFilterControls(m: ControllerRegistryModel): string {
  const q = m.query;
  const chips = m.filters
    .map(
      (f) => `
          <button
            type="button"
            class="chip"
            data-testid="controller-filter-chip"
            data-facet="${esc(f.facet)}"
            data-value="${esc(f.value)}"
            aria-pressed="${f.active ? 'true' : 'false'}"
          >${esc(f.label)}</button>`,
    )
    .join('');
  return `
      <section
        id="region-controller-search"
        aria-labelledby="controller-search-h"
        data-testid="controller-search"
        data-query-text="${esc(q.text)}"
        data-active-filters="${esc(q.activeFilters.join('|'))}"
        tabindex="-1"
      >
        <h2 id="controller-search-h">Search &amp; filter the controller registry</h2>
        <div class="search-row">
          <label for="controller-search-input" data-testid="controller-search-label">Search controllers</label>
          <input
            id="controller-search-input"
            type="search"
            role="searchbox"
            data-testid="controller-search-input"
            value="${esc(q.text)}"
            aria-describedby="controller-status"
            placeholder="Search by controller, instance, owner, health, source revision…"
          />
        </div>
        <div class="chip-toolbar" role="group" aria-label="Controller filters (health, drift, attention, continuity)" data-testid="controller-filter-toolbar">${chips}
        </div>
        <p
          id="controller-status"
          role="status"
          aria-live="polite"
          data-testid="controller-result-status"
          data-visible="${q.visible}"
          data-total="${q.total}"
          data-attention-visible="${q.attentionVisible}"
          data-drifted-visible="${q.driftedVisible}"
        >${esc(q.resultSummary)}</p>
      </section>`;
}

// ── One registry row ─────────────────────────────────────────────────────────────────────────────

function driftCell(r: ControllerRegistryRowVM): string {
  const desired = canonicalJson(r.desiredState);
  const observed = canonicalJson(r.observedState);
  if (!r.drift) {
    return `<span data-testid="row-no-drift" data-drift="false">no drift — desired state matches observed state</span>
            <span class="visually-hidden" data-testid="row-desired-state">${esc(desired)}</span>
            <span class="visually-hidden" data-testid="row-observed-state">${esc(observed)}</span>`;
  }
  // Drift is NEVER masked by health — surface desired vs observed explicitly (FR-024).
  return `<strong class="warn" data-testid="row-drift" data-drift="true">DRIFT — observed state differs from desired state (not masked by health).</strong>
          <span class="drift-detail" data-testid="row-desired-state">desired: <code>${esc(desired)}</code></span>
          <span class="drift-detail" data-testid="row-observed-state">observed: <code>${esc(observed)}</code></span>`;
}

/** The EXACT permitted-action set (FR-024) — rendered verbatim from the projector; never widened. */
function permittedActionsCell(actions: readonly string[]): string {
  if (actions.length === 0) {
    return '<span data-testid="row-no-actions" data-actions="">no further actions permitted from the current state</span>';
  }
  const items = actions
    .map((a) => `<li data-testid="row-permitted-action" data-action="${esc(a)}">${esc(a)}</li>`)
    .join('');
  return `<ul class="action-list" data-testid="row-permitted-actions" data-actions="${esc(actions.join(' '))}" data-count="${actions.length}">${items}</ul>`;
}

function attentionWarning(r: ControllerRegistryRowVM): string {
  if (!r.needsAttention) return '';
  return '<strong class="warn" data-testid="row-attention-warning" data-severity="attention">Needs operator attention — inspect before acting.</strong>';
}

function controllerRow(r: ControllerRegistryRowVM): string {
  const hidden = r.matches ? '' : ' hidden';
  const reason = r.matches ? '' : ` data-filtered-out-reason="${esc(r.filteredOutReason)}"`;
  return `
        <tr
          data-testid="controller-row"
          data-instance-id="${esc(r.instanceId)}"
          data-controller-id="${esc(r.controllerId)}"
          data-priority="${r.priority}"
          data-health="${esc(r.health)}"
          data-drift="${r.drift ? 'true' : 'false'}"
          data-dependency-degraded="${r.dependencyDegraded ? 'true' : 'false'}"
          data-needs-attention="${r.needsAttention ? 'true' : 'false'}"
          data-source-revision="${esc(r.sourceRevision)}"
          data-controller-version="${r.controllerVersion}"
          data-adapter-version-id="${esc(r.adapterVersionId)}"
          data-permitted-actions="${esc(r.nextPermittedActions.join(' '))}"
          data-search-index="${esc(r.searchIndex)}"
          data-matches="${r.matches ? 'true' : 'false'}"${reason}${hidden}
        >
          <th scope="row"><a href="#controller-${esc(r.instanceId)}" data-testid="row-controller-link">${esc(
            r.name,
          )}</a></th>
          <td data-testid="row-priority">${r.priority}</td>
          <td data-testid="row-version">v${r.controllerVersion} · adapter <code>${esc(r.adapterVersionId)}</code></td>
          <td data-testid="row-source-revision"><code>${esc(r.sourceRevision)}</code></td>
          <td data-testid="row-owner">${esc(r.ownerPrincipalId)}</td>
          <td data-testid="row-health">${esc(r.health)}</td>
          <td data-testid="row-drift-cell">${driftCell(r)}</td>
          <td data-testid="row-actions-cell">${permittedActionsCell(r.nextPermittedActions)}</td>
          <td data-testid="row-attention">${attentionWarning(r) || '<span data-testid="row-no-attention">no attention needed</span>'}</td>
        </tr>`;
}

function registryRegion(m: ControllerRegistryModel): string {
  const rows = m.rows.map(controllerRow).join('');
  const visible = m.rows.filter((r) => r.matches).length;
  const attention = m.rows.filter((r) => r.matches && r.needsAttention).length;
  const drifted = m.rows.filter((r) => r.matches && r.drift).length;
  return `
      <section id="region-controller-registry" aria-labelledby="registry-h" data-testid="controller-registry" tabindex="-1">
        <h2 id="registry-h">Prioritized governance-controller registry</h2>
        <p id="registry-summary" data-testid="registry-summary" data-visible="${visible}" data-total="${m.rows.length}" data-attention="${attention}" data-drifted="${drifted}">
          ${visible} of ${m.rows.length} controller(s) match the active search and filters
          (${attention} need attention; ${drifted} have drifted). Rows are ordered by priority
          (health × drift × dependency posture). Filtering never removes a controller: a hidden row
          stays as a record with its filter reason. Drift (observed ≠ desired) is NEVER masked by a
          healthy status, and each row's permitted actions are EXACTLY those the operation state
          allows — the view widens nothing.
        </p>
        <table aria-describedby="registry-summary">
          <caption>Controllers in priority order (priority, version/adapter, source revision, owner, health, drift, permitted actions, attention)</caption>
          <thead>
            <tr>
              <th scope="col">Controller</th>
              <th scope="col">Priority</th>
              <th scope="col">Version / adapter</th>
              <th scope="col">Source revision</th>
              <th scope="col">Owner</th>
              <th scope="col">Health</th>
              <th scope="col">Desired vs observed (drift)</th>
              <th scope="col">Permitted next actions</th>
              <th scope="col">Attention</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function metadataRegion(md: ControllerMetadataVM): string {
  const notCurrent = md.freshness !== 'current' || md.partialCoverage;
  return `
      <section id="region-controller-metadata" aria-labelledby="controller-md-h" data-testid="controller-metadata" tabindex="-1"
        data-freshness="${esc(md.freshness)}" data-partial-coverage="${md.partialCoverage ? 'true' : 'false'}"
        data-snapshot-digest="${esc(md.snapshotDigest)}">
        <h2 id="controller-md-h" class="visually-hidden">Registry freshness</h2>
        <p data-testid="controller-freshness">
          Registry generated <time datetime="${esc(md.generatedAtIso)}">${esc(md.generatedAtIso)}</time>.
          Freshness: <strong data-testid="controller-freshness-value">${esc(md.freshness)}</strong>.
          ${md.partialCoverage ? 'Coverage is <strong data-testid="controller-partial">partial</strong>.' : 'Coverage is complete.'}
        </p>
        ${
          notCurrent && md.safeNextAction
            ? `<p role="alert" data-testid="controller-safe-next-action">${esc(md.safeNextAction)}</p>`
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

const REGISTRY_STYLE = `
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
    .drift-detail { display: block; }
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
 * Render the complete accessible GOVERNANCE-CONTROLLER REGISTRY as a standalone HTML document,
 * PRESENTING the injected `props.model`. Mounted in-browser via
 * `page.setContent(renderControllerRegistry(props))`. Single-column and wrapping, with a visible
 * focus indicator.
 */
export function renderControllerRegistry(props: ControllerRegistryProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} controller registry</title>
  <style>${REGISTRY_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="controller-title">${esc(tenant.tenantName)} — governance-controller registry</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(m.query.resultSummary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="controller-main" data-role="controller-operator" data-snapshot-digest="${esc(m.metadata.snapshotDigest)}">
    ${searchAndFilterControls(m)}
    ${registryRegion(m)}
    ${metadataRegion(m.metadata)}
  </main>
  <footer>
    <p data-testid="controller-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · prioritized controller registry.</p>
  </footer>
</body>
</html>`;
}

export default renderControllerRegistry;
