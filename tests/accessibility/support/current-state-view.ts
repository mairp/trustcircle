// TrustCircleAI — current-state view accessibility fixture (Phase 61 /
// tests/accessibility/current-state.spec.ts).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A deterministic, dependency-free renderer that produces the accessible HTML the officer's
// *current-state* views MUST expose: the reconciled inventory, coverage gaps, cross-source
// drill-down, staleness/last-known markers, the open-ended source catalog, and governed-source
// gaps. The Phase-61 spec (../current-state.spec.ts) mounts this HTML in a real browser via
// `page.setContent(renderCurrentStateView())` and asserts — through axe-core and the DOM/
// accessibility tree — the keyboard, screen-reader, non-color, table-alternative, and 400%
// reflow behavior WCAG 2.2 AA requires.
//
// WHY A LOCAL FIXTURE (and not apps/web). apps/web has not shipped its React current-state
// pages yet; the accessible *contract* those pages must satisfy, however, is specifiable now.
// This module is that contract expressed as markup: every field the inventory OpenAPI schemas
// (GovernedAsset, SourceCatalogEntry, ProjectionMetadata) name is rendered with the correct
// name/role/state, a NON-COLOR text equivalent, a structured-table alternative for every chart/
// timeline, keyboard-operable controls, live regions for async updates/alerts/decision
// outcomes, a session time-limit warning with an accessible extension path, and a layout that
// reflows into the 320-CSS-px column at 400% zoom. When apps/web renders these views, this
// fixture is the acceptance target its DOM must match.
//
// DETERMINISM. Pure string builders. No wall clock, no randomness, no network. Timestamps are
// fixed ISO literals so the "last observation time" / "last-known time" / freshness assertions
// are stable. The field values mirror the pinned inventory fixture taxonomy (supported,
// metadata-only, unsupported, unowned, unreachable, renamed, unknown).

/** Escape text for safe insertion into HTML (defence-in-depth; all inputs here are literals). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Deterministic domain data ────────────────────────────────────────────────────────────────

/** A healthy reconciled inventory item (AC1) — every authoritative field is present. */
export interface HealthyItem {
  id: string;
  assetType: string;
  sourceIdentity: string;
  owner: string;
  lifecycleState: string;
  riskTier: string;
  controlCoverage: string;
  evidenceState: string;
  health: string;
  lastObservedAt: string;
  unresolvedIssues: number;
}

/** A coverage gap (AC2) — a discovered-but-not-healthy component that must stay visible. */
export interface CoverageGap {
  id: string;
  component: string;
  reasonClass: 'unmanaged' | 'unreachable' | 'stale' | 'orphaned' | 'excluded';
  reasonText: string;
  ageDays: number;
  impact: string;
  requiredOwnerAction: string;
}

/** A governed-source gap (AC6) — a discovered source that stays a visible governance gap. */
export interface SourceGap {
  id: string;
  source: string;
  reasonClass: 'unsupported' | 'inaccessible' | 'sensitive' | 'unowned' | 'excluded';
  reasonText: string;
  impact: string;
  ownerAction: string;
  reviewOrExpiry: string;
}

/** A newly discovered, unregistered source added to the catalog (AC5). */
export interface DiscoveredSource {
  id: string;
  classification: string; // type OR 'unknown'
  location: string;
  accessStatus: string;
  sensitivity: string;
  ownershipStatus: string;
  onboardingState: string;
  discoveryEvidenceRef: string;
}

/** One source's record for the cross-source drill-down (AC3). */
export interface SourceRecord {
  source: 'Kanban' | 'agentctl' | 'workflows_orchestration';
  recordId: string;
  status: string;
  authoritativeFields: string; // which fields THIS source is authoritative for
  dependsOn: string;
  lastObservedAt: string;
}

export const HEALTHY_ITEMS: readonly HealthyItem[] = [
  {
    id: 'ast-1001',
    assetType: 'model',
    sourceIdentity: 'LISA / model-registry',
    owner: 'Ada Governance',
    lifecycleState: 'in-production',
    riskTier: 'high',
    controlCoverage: 'covered (8/8 controls)',
    evidenceState: 'current',
    health: 'healthy',
    lastObservedAt: '2026-07-31T09:15:00Z',
    unresolvedIssues: 0,
  },
  {
    id: 'ast-1002',
    assetType: 'dataset',
    sourceIdentity: 'Wiggum / feature-store',
    owner: 'Grace Data',
    lifecycleState: 'staged',
    riskTier: 'medium',
    controlCoverage: 'partial (5/8 controls)',
    evidenceState: 'aging',
    health: 'healthy',
    lastObservedAt: '2026-07-31T08:40:00Z',
    unresolvedIssues: 2,
  },
];

export const COVERAGE_GAPS: readonly CoverageGap[] = [
  {
    id: 'gap-2001',
    component: 'shadow-inference-svc',
    reasonClass: 'unmanaged',
    reasonText: 'Discovered but never onboarded to a governed source contract.',
    ageDays: 12,
    impact: 'Ungoverned inference path; decisions cannot be attributed.',
    requiredOwnerAction: 'Assign an owner and onboard the source, or file an exclusion review.',
  },
  {
    id: 'gap-2002',
    component: 'legacy-batch-node',
    reasonClass: 'unreachable',
    reasonText: 'Connector has missed 6 consecutive health probes.',
    ageDays: 3,
    impact: 'Inventory for this node is going stale; health is unknown.',
    requiredOwnerAction: 'Restore connectivity or mark the node retired with evidence.',
  },
  {
    id: 'gap-2003',
    component: 'orphaned-eval-run',
    reasonClass: 'orphaned',
    reasonText: 'Evidence exists but the owning asset was deleted upstream.',
    ageDays: 21,
    impact: 'Dangling evidence cannot be tied to a lifecycle state.',
    requiredOwnerAction: 'Re-associate the evidence or dispose of it under retention policy.',
  },
  {
    id: 'gap-2004',
    component: 'excluded-sandbox-model',
    reasonClass: 'excluded',
    reasonText: 'Explicitly excluded by an approved scope decision.',
    ageDays: 45,
    impact: 'Intentionally out of governance scope; visible so exclusion is auditable.',
    requiredOwnerAction: 'Review the exclusion before its 2026-09-01 expiry.',
  },
];

export const SOURCE_GAPS: readonly SourceGap[] = [
  {
    id: 'sgap-3001',
    source: 'NetBox / dcim',
    reasonClass: 'unsupported',
    reasonText: 'No adapter supports this source type yet.',
    impact: 'Assets behind it are invisible to governance.',
    ownerAction: 'Request adapter support or accept the coverage gap with justification.',
    reviewOrExpiry: 'review by 2026-08-15',
  },
  {
    id: 'sgap-3002',
    source: 'sensitive-hr-store',
    reasonClass: 'sensitive',
    reasonText: 'Contains restricted PII; access is withheld pending DPIA.',
    impact: 'Cannot reconcile without a lawful basis.',
    ownerAction: 'Complete DPIA and grant scoped read access.',
    reviewOrExpiry: 'expires 2026-10-01',
  },
];

export const DISCOVERED_SOURCES: readonly DiscoveredSource[] = [
  {
    id: 'disc-4001',
    classification: 'unknown',
    location: 'vpc-a/10.2.3.4:8443',
    accessStatus: 'reachable, unauthenticated',
    sensitivity: 'unclassified',
    ownershipStatus: 'unowned',
    onboardingState: 'discovered (not onboarded)',
    discoveryEvidenceRef: 'evi-disc-4001',
  },
];

export const SOURCE_RECORDS: readonly SourceRecord[] = [
  {
    source: 'Kanban',
    recordId: 'kb-card-77',
    status: 'in-review',
    authoritativeFields: 'board column, WIP status',
    dependsOn: 'wf-run-12',
    lastObservedAt: '2026-07-31T09:10:00Z',
  },
  {
    source: 'agentctl',
    recordId: 'agc-task-91',
    status: 'running',
    authoritativeFields: 'execution attempt, retry count',
    dependsOn: 'kb-card-77',
    lastObservedAt: '2026-07-31T09:12:00Z',
  },
  {
    source: 'workflows_orchestration',
    recordId: 'wf-run-12',
    status: 'blocked',
    authoritativeFields: 'workflow phase, dependency graph',
    dependsOn: '—',
    lastObservedAt: '2026-07-31T09:05:00Z',
  },
];

/** Freshness/last-known projection metadata for the stale-source panel (AC4). */
export const STALE_PROJECTION = {
  source: 'Wiggum / feature-store',
  freshness: 'stale' as const, // enum: current | aging | stale | unknown
  lastKnownAt: '2026-07-28T22:00:00Z',
  confidence: 'low',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── Renderers ────────────────────────────────────────────────────────────────────────────────

function healthyTable(): string {
  const rows = HEALTHY_ITEMS.map(
    (i) => `
        <tr>
          <th scope="row">${esc(i.id)}</th>
          <td>${esc(i.assetType)}</td>
          <td>${esc(i.sourceIdentity)}</td>
          <td>${esc(i.owner)}</td>
          <td>${esc(i.lifecycleState)}</td>
          <td>${esc(i.riskTier)}</td>
          <td>${esc(i.controlCoverage)}</td>
          <td>${esc(i.evidenceState)}</td>
          <td>${esc(i.health)}</td>
          <td><time datetime="${esc(i.lastObservedAt)}">${esc(i.lastObservedAt)}</time></td>
          <td>${i.unresolvedIssues === 0 ? 'none' : `${i.unresolvedIssues} unresolved`}</td>
        </tr>`,
  ).join('');
  return `
    <section aria-labelledby="inv-h" data-testid="reconciled-inventory">
      <h2 id="inv-h">Reconciled inventory — healthy items</h2>
      <p id="inv-summary">
        ${HEALTHY_ITEMS.length} governed item(s), each shown once with its authoritative fields.
      </p>
      <table aria-describedby="inv-summary">
        <caption>Healthy governed inventory (type, source identity, owner, lifecycle, risk,
          control coverage, evidence state, health, last observation, unresolved issues)</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Type</th>
            <th scope="col">Source identity</th>
            <th scope="col">Owner</th>
            <th scope="col">Lifecycle state</th>
            <th scope="col">Risk</th>
            <th scope="col">Control coverage</th>
            <th scope="col">Evidence state</th>
            <th scope="col">Health</th>
            <th scope="col">Last observation time</th>
            <th scope="col">Unresolved issues</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function coverageGapTable(): string {
  const rows = COVERAGE_GAPS.map(
    (g) => `
        <tr>
          <th scope="row">${esc(g.component)}</th>
          <td>
            <span class="badge badge--gap" data-reason="${esc(g.reasonClass)}"></span>
            <span data-testid="gap-reason-text">${esc(g.reasonClass)}: ${esc(g.reasonText)}</span>
          </td>
          <td>${g.ageDays} day(s)</td>
          <td>${esc(g.impact)}</td>
          <td>${esc(g.requiredOwnerAction)}</td>
        </tr>`,
  ).join('');
  return `
    <section aria-labelledby="gap-h" data-testid="coverage-gaps">
      <h2 id="gap-h">Coverage gaps</h2>
      <p>Discovered components that are NOT healthy remain visible here — they never appear
        healthy and never disappear.</p>
      <table>
        <caption>Coverage gaps (reason, age, impact, required owner action)</caption>
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">Reason</th>
            <th scope="col">Age</th>
            <th scope="col">Impact</th>
            <th scope="col">Required owner action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function drilldownTable(): string {
  const rows = SOURCE_RECORDS.map(
    (r) => `
        <tr>
          <th scope="row">${esc(r.source)}</th>
          <td>${esc(r.recordId)}</td>
          <td>${esc(r.status)}</td>
          <td>${esc(r.authoritativeFields)}</td>
          <td>${esc(r.dependsOn)}</td>
          <td><time datetime="${esc(r.lastObservedAt)}">${esc(r.lastObservedAt)}</time></td>
        </tr>`,
  ).join('');
  return `
    <section aria-labelledby="drill-h" data-testid="cross-source-drilldown">
      <h2 id="drill-h">Cross-source drill-down — item ast-1001</h2>
      <p id="drill-summary" data-testid="drilldown-text-summary">
        Correlated across 3 registered sources. Statuses differ:
        Kanban=in-review, agentctl=running, workflows_orchestration=blocked. agentctl depends on
        the Kanban card, which depends on the workflow run. Each source keeps its DISTINCT record;
        authoritative fields are attributed per source (no source overrides another's authority).
      </p>
      <table aria-describedby="drill-summary">
        <caption>Distinct source records with correlation, status differences, dependencies,
          and authoritative fields</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Source record ID</th>
            <th scope="col">Status</th>
            <th scope="col">Authoritative fields</th>
            <th scope="col">Depends on</th>
            <th scope="col">Last observed</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function stalePanel(): string {
  return `
    <section aria-labelledby="stale-h" data-testid="stale-source-panel">
      <h2 id="stale-h">Source freshness — ${esc(STALE_PROJECTION.source)}</h2>
      <p data-testid="stale-marker" data-freshness="${esc(STALE_PROJECTION.freshness)}">
        <strong>Freshness: ${esc(STALE_PROJECTION.freshness)}.</strong>
        Showing last-known data from
        <time datetime="${esc(STALE_PROJECTION.lastKnownAt)}" data-testid="last-known-time"
          >${esc(STALE_PROJECTION.lastKnownAt)}</time>.
        Confidence: <span data-testid="confidence">${esc(STALE_PROJECTION.confidence)}</span>.
      </p>
      <p data-testid="no-stale-inference">
        Current compliance and health are NOT inferred from stale data — this panel is marked
        <em>last-known only</em> until the source recovers.
      </p>
    </section>`;
}

function catalogTable(): string {
  const rows = DISCOVERED_SOURCES.map(
    (d) => `
        <tr>
          <th scope="row">${esc(d.id)}</th>
          <td>${esc(d.classification)}</td>
          <td>${esc(d.location)}</td>
          <td>${esc(d.accessStatus)}</td>
          <td>${esc(d.sensitivity)}</td>
          <td>${esc(d.ownershipStatus)}</td>
          <td>${esc(d.onboardingState)}</td>
          <td><a href="#${esc(d.discoveryEvidenceRef)}">${esc(d.discoveryEvidenceRef)}</a></td>
        </tr>`,
  ).join('');
  const gapRows = SOURCE_GAPS.map(
    (g) => `
        <tr>
          <th scope="row">${esc(g.source)}</th>
          <td>${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td>${esc(g.impact)}</td>
          <td>${esc(g.ownerAction)}</td>
          <td>${esc(g.reviewOrExpiry)}</td>
        </tr>`,
  ).join('');
  return `
    <section aria-labelledby="cat-h" data-testid="source-catalog">
      <h2 id="cat-h">Open-ended source catalog</h2>
      <table data-testid="discovered-sources">
        <caption>Newly discovered sources within the declared boundary (discovery evidence,
          type or unknown classification, location, access status, sensitivity, ownership
          status, onboarding state)</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Classification</th>
            <th scope="col">Location</th>
            <th scope="col">Access status</th>
            <th scope="col">Sensitivity</th>
            <th scope="col">Ownership status</th>
            <th scope="col">Onboarding state</th>
            <th scope="col">Discovery evidence</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <h3 id="sgap-h">Governed source gaps</h3>
      <table aria-labelledby="sgap-h" data-testid="governed-source-gaps">
        <caption>Discovered sources that remain governance gaps (reason, impact, owner action,
          review or expiry)</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Reason</th>
            <th scope="col">Impact</th>
            <th scope="col">Owner action</th>
            <th scope="col">Review / expiry</th>
          </tr>
        </thead>
        <tbody>${gapRows}</tbody>
      </table>
    </section>`;
}

/**
 * Risk-distribution "chart" rendered as an accessible figure: a text summary PLUS a navigable
 * tabular alternative preserving the same material information (WCAG — charts/timelines must
 * have text summaries and tabular alternatives; meaning must not rely on color alone).
 */
function riskChartWithTableAlternative(): string {
  return `
    <section aria-labelledby="risk-h" data-testid="risk-chart">
      <h2 id="risk-h">Risk distribution</h2>
      <figure role="figure" aria-labelledby="risk-fig-cap">
        <figcaption id="risk-fig-cap" data-testid="chart-text-summary">
          Text summary: 1 high-risk item, 1 medium-risk item, 0 low-risk items. Risk is conveyed
          by the labelled value in each row below, not by color alone.
        </figcaption>
        <!-- Decorative visual bars: hidden from assistive tech; the table is the real content. -->
        <div aria-hidden="true" class="bars">
          <span class="bar bar--high" style="width:80px"></span>
          <span class="bar bar--medium" style="width:40px"></span>
          <span class="bar bar--low" style="width:0px"></span>
        </div>
        <table data-testid="chart-table-alternative">
          <caption>Tabular alternative for the risk-distribution chart</caption>
          <thead>
            <tr><th scope="col">Risk tier</th><th scope="col">Item count</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">high</th><td>1</td></tr>
            <tr><th scope="row">medium</th><td>1</td></tr>
            <tr><th scope="row">low</th><td>0</td></tr>
          </tbody>
        </table>
      </figure>
    </section>`;
}

/**
 * A reconcile/refresh action panel with:
 *  - a keyboard-operable <button> (screen-reader name/role),
 *  - an aria-live=polite region for async status updates,
 *  - an aria-live=assertive role=alert region for alerts and decision outcomes,
 *  - a reason <form> whose validation error is programmatically associated (aria-invalid +
 *    aria-describedby + role=alert) and which preserves entered input after a failure.
 */
function actionPanel(): string {
  return `
    <section aria-labelledby="act-h" data-testid="action-panel">
      <h2 id="act-h">Owner actions</h2>

      <button type="button" id="reconcile-btn" data-testid="reconcile-btn">Reconcile inventory</button>

      <div id="async-status" role="status" aria-live="polite" data-testid="async-status"></div>
      <div id="alert-region" role="alert" aria-live="assertive" data-testid="alert-region"></div>
      <div id="decision-outcome" role="status" aria-live="polite" data-testid="decision-outcome"></div>

      <form id="reason-form" data-testid="reason-form" novalidate>
        <label for="reason-input" id="reason-label">Reason for owner action</label>
        <input
          id="reason-input"
          name="reason"
          type="text"
          data-testid="reason-input"
          aria-labelledby="reason-label"
          aria-describedby="reason-hint"
        />
        <p id="reason-hint" data-testid="reason-hint">
          Enter a clear reason (at least 3 characters). Your text is preserved if validation fails.
        </p>
        <p id="reason-error" role="alert" data-testid="reason-error" hidden></p>
        <button type="submit" data-testid="reason-submit">Submit reason</button>
      </form>
    </section>`;
}

/**
 * A time-limited session banner with a warning and an accessible extension control
 * (WCAG 2.2.1 Timing Adjustable / the phase's time-limit + extension requirement).
 */
function sessionTimeoutBanner(): string {
  return `
    <aside aria-labelledby="to-h" role="region" data-testid="session-timeout">
      <h2 id="to-h">Session timing</h2>
      <p role="status" aria-live="polite" data-testid="timeout-warning">
        Your governance session expires in 2 minutes. Extend it to keep reviewing.
      </p>
      <button type="button" data-testid="extend-session-btn">Extend session by 15 minutes</button>
    </aside>`;
}

/**
 * Render the complete current-state view as a standalone HTML document. Mounted in-browser via
 * `page.setContent(...)`. Includes a reflow-friendly stylesheet: a single-column, wrapping
 * layout with no fixed pixel widths that would force horizontal scrolling at 400% zoom, and a
 * visible focus indicator so keyboard focus is never invisible.
 */
export function renderCurrentStateView(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — Current-state view</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 1rem;
      font: 16px/1.5 system-ui, sans-serif;
      color: #111; background: #fff;
      /* Reflow: never exceed the viewport; wrap long content. */
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word;
    }
    main { display: block; max-width: 100%; }
    section, aside { margin: 0 0 1.5rem; max-width: 100%; }
    /* Tables must wrap/scroll WITHIN their own block, never force the PAGE to scroll in 2D. */
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left;
             overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    /* AAA-friendly visible focus indicator: keyboard focus is always visible. */
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 3px solid #0b57d0; outline-offset: 2px;
    }
    .badge { display: inline-block; width: .75rem; height: .75rem; border-radius: 50%;
             vertical-align: middle; margin-right: .25rem; }
    .badge--gap { background: #b3261e; }
    .bars { display: flex; gap: .25rem; align-items: flex-end; height: 1rem; }
    .bar { display: inline-block; height: 100%; background: #444; }
    [hidden] { display: none !important; }
    button { min-height: 2.25rem; padding: .25rem .75rem; cursor: pointer; }
    input { min-height: 2.25rem; padding: .25rem .5rem; max-width: 100%; }
  </style>
</head>
<body>
  <a href="#main" class="skip-link">Skip to main content</a>
  <header>
    <h1>Current-state view</h1>
  </header>
  <main id="main" tabindex="-1">
    ${healthyTable()}
    ${coverageGapTable()}
    ${drilldownTable()}
    ${stalePanel()}
    ${catalogTable()}
    ${riskChartWithTableAlternative()}
    ${actionPanel()}
    ${sessionTimeoutBanner()}
  </main>

  <script>
    // Minimal, deterministic behavior so keyboard + live-region + validation journeys are real
    // (no framework needed). These handlers are the accessible behavior the shipped app must
    // reproduce; the spec drives them with the keyboard only.
    (function () {
      var reconcile = document.getElementById('reconcile-btn');
      var asyncStatus = document.getElementById('async-status');
      var alertRegion = document.getElementById('alert-region');
      var decisionOutcome = document.getElementById('decision-outcome');
      if (reconcile) {
        reconcile.addEventListener('click', function () {
          // Async update announced via a polite live region (name/role/state → AT).
          asyncStatus.textContent = 'Reconciliation started…';
          alertRegion.textContent = 'Alert: 4 coverage gaps require owner action.';
          decisionOutcome.textContent = 'Decision outcome: reconcile queued (idempotent).';
        });
      }

      var form = document.getElementById('reason-form');
      var input = document.getElementById('reason-input');
      var error = document.getElementById('reason-error');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var value = (input.value || '').trim();
          if (value.length < 3) {
            // Clear-language error; programmatically associated; entered text PRESERVED.
            error.hidden = false;
            error.textContent =
              'Reason must be at least 3 characters. Please add more detail — your text was kept.';
            input.setAttribute('aria-invalid', 'true');
            input.setAttribute('aria-describedby', 'reason-hint reason-error');
            input.focus();
          } else {
            error.hidden = true;
            error.textContent = '';
            input.removeAttribute('aria-invalid');
            input.setAttribute('aria-describedby', 'reason-hint');
            decisionOutcome.textContent = 'Decision outcome: reason accepted.';
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}
