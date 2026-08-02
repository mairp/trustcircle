// TrustCircleAI — SEARCHABLE / FILTERABLE INVENTORY TABLES view (Phase 79 /
// apps/web/src/features/inventory/InventoryTable.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The operator-facing GOVERNED-ASSET and SOURCE-CATALOG tables. It answers the officer's day-to-day
// question — "let me find and compare exactly the governed items / discovered sources I care about,
// and tell me, per row, HOW OLD the observation is and WHO is authoritative for it" — on top of the
// six current-state acceptance criteria (AC1–AC6) the whole officer surface must satisfy:
//   • a SEARCH box (a labelled text query) and a set of FILTER controls (facet chips: risk, coverage,
//     health, evidence, access, sensitivity, onboarding, ownership) that together narrow BOTH tables
//     to the rows an officer asked for — and EVERY row that a filter hides stays in the DOM as a
//     `hidden` row carrying a machine-readable `data-filtered-out-reason`, so filtering never DELETES
//     a governed item or source (a hidden coverage gap is still a coverage gap — AC2/AC6 discipline
//     at the table level);
//   • an explicit AGE column on both tables — for a governed-asset row, the age of its last
//     observation (how stale the newest evidence is); for a source-catalog row, the age since the
//     source was first discovered AND since it was last seen — so an officer never mistakes an old
//     reading for a current one;
//   • an explicit AUTHORITY column on both tables — for a governed-asset row, WHICH source is the
//     system-of-record for which field (and whether any field's authority is CONTESTED / unresolved,
//     so automation stays paused); for a source-catalog row, the source's ownership authority
//     (owned vs. ownership-gap) and whether its class is AUTHORITATIVELY classified or still `unknown`.
//
// THIS VIEW IS A PURE PRESENTER — it does NOT compute the tables. `renderInventoryTable(props)`
// renders whatever `InventoryTableModel` it is handed. That model is DERIVED elsewhere
// (tests/accessibility/support/inventory-table-model.ts) by running the REAL Phase-70 current-
// inventory assembly service (packages/application/src/inventory-service.ts) — the same aggregate
// proven in tests/unit/inventory-service.unit.test.ts — over an explicit deterministic scenario, and
// by applying the officer's search query + active filters to the SERVICE's own rows. Every value this
// view shows is therefore a projection of a value the service COMPUTED:
//   • AC1 asset rows appear ONCE because the SERVICE keys assets by id (one InventoryRow per asset);
//   • AC2/AC6 gapped rows/sources stay VISIBLE (never healthy, never removed) because the SERVICE
//     retains them, and because a FILTER only sets `hidden` + a reason — it never drops the row;
//   • AC3 the AUTHORITY column carries the DISTINCT authoritative-field attributions the SERVICE
//     correlated (`drillDown().authoritativeFields`) and flags CONTESTED fields the service left open;
//   • AC4 a stale asset row reports health `unknown` and an AGE past the freshness horizon because the
//     SERVICE refuses to infer current health from stale data, and the AGE is the real observation age;
//   • AC5 catalog rows carry the discovery facets (classification/location/access/sensitivity/
//     ownership/onboarding/evidence) the SERVICE read back;
//   • the SEARCH/FILTER match set is computed against the SERVICE's rows — matching rows are visible,
//     non-matching rows are `hidden` with a reason; the presenter invents no membership.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React runtime
// yet, and the repo's TypeScript base sets no `jsx` runtime. A JSX element would not compile. The
// accessible *contract* of this view, however, is specifiable now: this module expresses it as a pure,
// deterministic renderer returning the exact accessible markup the shipped React view must reproduce.
// Because the output is a self-contained HTML string, the Phase-79 accessibility spec mounts it in a
// REAL browser via `page.setContent(renderInventoryTable(props))` and asserts — through axe-core and
// the live accessibility tree — every obligation, with NO web server, NO React, and NO tenant-auth.
//
// "SEARCHABLE/FILTERABLE" WITHOUT A CLIENT RUNTIME. The filtering SEMANTICS are a pure function of the
// query + active filters over the service rows, computed in the derivation. The rendered markup makes
// that function INDEPENDENTLY OBSERVABLE: a labelled `role=searchbox` input echoes the active query;
// each filter is a `[aria-pressed]` toggle whose state is machine-readable; a live `role=status` region
// reports the visible/hidden counts; and every row carries `data-search-index` (its searchable text),
// `data-matches` (whether it survived the active query+filters), and — when hidden — `hidden` +
// `data-filtered-out-reason`. The shipped React view will wire the same controls to live state; the
// contract (what MATCHES, what stays visible-but-hidden, what the counts are) is asserted here.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no network,
// no module-level mutable state — same props ⇒ byte-identical output.

import type {
  CurrentStateModel,
  InventoryRowVM,
  CoverageGapVM,
  SourceGapVM,
  DrillDownVM,
  DiscoveredSourceVM,
  TenantScope,
} from '../../app/layout.tsx';

export type {
  CurrentStateModel,
  InventoryRowVM,
  CoverageGapVM,
  SourceGapVM,
  DrillDownVM,
  DiscoveredSourceVM,
  TenantScope,
};

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Pinned execution identity (tenant scope) ───────────────────────────────────────────────────
//
// The inventory-table view is bound to exactly one governance bundle. Rendering the bundle id +
// semantic hash + work item as machine-readable, independently-readable DOM (a `<dl>` with data
// attributes, not a mutation-response echo) is the DURABLE IDENTITY witness the phase's effect-witness
// obligations require: a value observable through an independent read path, and REJECTABLE when it
// differs from the pinned input.

/** The one tenant scope this view is pinned to (work item TRRGYA7N0K97QZ8JAMD077BRWP). */
export const INVENTORY_TENANT: TenantScope = {
  tenantId: 'tnt-acme-governance',
  tenantName: 'Acme Governance',
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: 'TRRGYA7N0K97QZ8JAMD077BRWP',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── Table-specific view model — the render-ready reductions of the REAL service outputs ─────────
//
// These shapes are produced by tests/accessibility/support/inventory-table-model.ts#deriveInventoryTable(),
// which runs the Phase-70 `InventoryService`, folds `currentStateView()` / `componentGaps()` /
// `governedSourceGaps()` / `catalogView()` / `drillDown()` into per-row AGE + AUTHORITY facets, and
// applies the officer's SEARCH query + active FILTERS to the service's own rows. Every field is a
// projection of a value the service COMPUTED — the presenter invents nothing.

/** How authority resolved for a governed-asset row (AC1/AC3). */
export interface AssetAuthorityVM {
  /** The count of fields this row has an authoritative system-of-record for. */
  readonly authoritativeFieldCount: number;
  /** "field ← source" attributions, most-authoritative source named per field (may be empty). */
  readonly attributions: readonly string[];
  /** True iff ANY governed field's authority is CONTESTED / unresolved (automation must PAUSE). */
  readonly contested: boolean;
  /** The names of the contested fields (empty when nothing is contested). */
  readonly contestedFields: readonly string[];
  /** A non-color-only one-line summary of the authority state. */
  readonly summary: string;
}

/** The explicit AGE facet for a governed-asset row (AC4 freshness discipline). */
export interface AssetAgeVM {
  /** Whole days since the newest contributing observation (−1 when never observed). */
  readonly observationAgeDays: number;
  /** True iff the newest observation is older than the freshness horizon (evidence not current). */
  readonly stale: boolean;
  /** A human, non-color label ("2h ago", "3 days ago", "never observed"). */
  readonly label: string;
}

/** One governed-asset table row: the AC1 authoritative fields PLUS explicit AGE + AUTHORITY, PLUS the
 *  search/filter membership the derivation computed against the service rows. */
export interface AssetTableRowVM {
  readonly base: InventoryRowVM;
  readonly age: AssetAgeVM;
  readonly authority: AssetAuthorityVM;
  /** Whether this row still has an OPEN component coverage gap (stays visible even when filtered). */
  readonly hasVisibleGap: boolean;
  /** The lower-cased searchable text index for this row (name/type/owner/source/health/…). */
  readonly searchIndex: string;
  /** Whether this row survived the ACTIVE query + filters (true ⇒ shown; false ⇒ hidden+reason). */
  readonly matches: boolean;
  /** When `!matches`, the machine-readable reason it was filtered out (empty when it matches). */
  readonly filteredOutReason: string;
}

/** The explicit AGE facet for a source-catalog row (AC5/AC6). */
export interface SourceAgeVM {
  /** Whole days since the source was FIRST discovered. */
  readonly discoveredAgeDays: number;
  /** Whole days since the source was LAST seen. */
  readonly lastSeenAgeDays: number;
  /** A human, non-color label describing both ages. */
  readonly label: string;
}

/** The explicit AUTHORITY facet for a source-catalog row (AC5). */
export interface SourceAuthorityVM {
  /** True iff the source's class is authoritatively classified (false ⇒ still `unknown`). */
  readonly classified: boolean;
  /** Ownership authority: an owner principal, or the fact that ownership is an open gap. */
  readonly ownershipStatus: string;
  /** True iff no accountable owner is recorded (ownership gap). */
  readonly ownershipGap: boolean;
  /** A non-color-only one-line summary of the source's authority state. */
  readonly summary: string;
}

/** One source-catalog table row: the AC5 discovery facets PLUS explicit AGE + AUTHORITY, PLUS its
 *  search/filter membership. When a governed-source gap (AC6) is bound to this source, it is carried
 *  so a hidden/filtered source still surfaces its gap reason/impact/action/review. */
export interface SourceTableRowVM {
  readonly base: DiscoveredSourceVM;
  readonly age: SourceAgeVM;
  readonly authority: SourceAuthorityVM;
  /** The AC6 governed-source gap bound to this source, if any (kept even when the row is filtered). */
  readonly gap?: SourceGapVM;
  readonly searchIndex: string;
  readonly matches: boolean;
  readonly filteredOutReason: string;
}

/** One selectable facet filter chip (a declarative, machine-readable toggle). */
export interface FilterChipVM {
  /** The facet family this chip belongs to (e.g. 'risk', 'coverage', 'access'). */
  readonly facet: string;
  /** The concrete facet value this chip selects (e.g. 'high', 'gap', 'reachable'). */
  readonly value: string;
  /** A human label for the chip. */
  readonly label: string;
  /** Whether this chip is currently ACTIVE (pressed) in the officer's query. */
  readonly active: boolean;
  /** Which table(s) this chip narrows: 'asset', 'source', or 'both'. */
  readonly appliesTo: 'asset' | 'source' | 'both';
}

/** The active search/filter query state, echoed into the controls so it is independently observable. */
export interface QueryStateVM {
  /** The free-text query (may be empty). */
  readonly text: string;
  /** The active filter chips (facet=value) currently narrowing the tables. */
  readonly activeFilters: readonly string[];
  /** Count of asset rows that match (are shown) vs. total asset rows. */
  readonly assetVisible: number;
  readonly assetTotal: number;
  /** Count of source rows that match (are shown) vs. total source rows. */
  readonly sourceVisible: number;
  readonly sourceTotal: number;
  /** A non-color-only sentence describing the current result set (WCAG 1.4.1 — meaning in text). */
  readonly resultSummary: string;
}

/** The whole inventory-table model: the current state + the two enriched tables + the query state. */
export interface InventoryTableModel {
  /** The underlying current-state model (AC1–AC6), derived from the real service at `now`. */
  readonly currentState: CurrentStateModel;
  /** The governed-asset table rows (every reconciled row — healthy, gapped, stale — each once). */
  readonly assetRows: readonly AssetTableRowVM[];
  /** The source-catalog table rows (every discovered source, each once). */
  readonly sourceRows: readonly SourceTableRowVM[];
  /** The selectable filter chips (with their active state). */
  readonly filters: readonly FilterChipVM[];
  /** The active search/filter query + result counts. */
  readonly query: QueryStateVM;
  /** The ISO instant this table was derived at. */
  readonly generatedAtIso: string;
  /** The service's content digest at the current instant — an independent effect witness. */
  readonly snapshotDigest: string;
}

/**
 * An EMPTY-but-valid model. The view renders this only when none is injected; the tables frame their
 * headers/captions but carry no rows, so an un-fed view CANNOT masquerade as a satisfied inventory
 * (every row-count / match assertion fails against it).
 */
export const EMPTY_INVENTORY_TABLE: InventoryTableModel = {
  currentState: {
    generatedAtIso: INVENTORY_TENANT.generatedAt,
    inventory: [],
    coverageGaps: [],
    discoveredSources: [],
    sourceGaps: [],
    snapshotDigest: 'empty',
  },
  assetRows: [],
  sourceRows: [],
  filters: [],
  query: {
    text: '',
    activeFilters: [],
    assetVisible: 0,
    assetTotal: 0,
    sourceVisible: 0,
    sourceTotal: 0,
    resultSummary: 'No inventory has been derived yet.',
  },
  generatedAtIso: INVENTORY_TENANT.generatedAt,
  snapshotDigest: 'empty',
} as const;

// ── Props ──────────────────────────────────────────────────────────────────────────────────────

export interface InventoryTableProps {
  readonly tenant: TenantScope;
  readonly model: InventoryTableModel;
}

export const DEFAULT_INVENTORY_TABLE_PROPS: InventoryTableProps = {
  tenant: INVENTORY_TENANT,
  model: EMPTY_INVENTORY_TABLE,
} as const;

// ── Search + filter controls (declarative, machine-readable) ────────────────────────────────────

/** Render the SEARCH box + FILTER chip toolbar + live result-count status. */
function searchAndFilterControls(m: InventoryTableModel): string {
  const q = m.query;
  const chips = m.filters
    .map(
      (f) => `
          <button
            type="button"
            role="button"
            class="chip"
            data-testid="filter-chip"
            data-facet="${esc(f.facet)}"
            data-value="${esc(f.value)}"
            data-applies-to="${esc(f.appliesTo)}"
            aria-pressed="${f.active ? 'true' : 'false'}"
          >${esc(f.label)}</button>`,
    )
    .join('');
  return `
      <section
        id="region-search"
        aria-labelledby="search-h"
        data-testid="inventory-search"
        data-query-text="${esc(q.text)}"
        data-active-filters="${esc(q.activeFilters.join('|'))}"
        tabindex="-1"
      >
        <h2 id="search-h">Search &amp; filter inventory</h2>
        <div class="search-row">
          <label for="inv-search-input" data-testid="search-label">Search governed items and sources</label>
          <input
            id="inv-search-input"
            type="search"
            role="searchbox"
            data-testid="search-input"
            value="${esc(q.text)}"
            aria-describedby="search-status"
            placeholder="Search by name, type, owner, source, reason…"
          />
        </div>
        <div
          class="chip-toolbar"
          role="group"
          aria-label="Facet filters"
          data-testid="filter-toolbar"
        >${chips}
        </div>
        <p
          id="search-status"
          role="status"
          aria-live="polite"
          data-testid="result-status"
          data-asset-visible="${q.assetVisible}"
          data-asset-total="${q.assetTotal}"
          data-source-visible="${q.sourceVisible}"
          data-source-total="${q.sourceTotal}"
        >${esc(q.resultSummary)}</p>
      </section>`;
}

// ── Governed-asset table (AC1/AC2/AC3/AC4 + AGE + AUTHORITY + search/filter) ─────────────────────

function assetAuthorityCell(a: AssetAuthorityVM): string {
  const attributions = a.attributions.length
    ? a.attributions.map((s) => esc(s)).join('; ')
    : 'no authoritative source recorded';
  return `
          <span
            class="badge badge--authority"
            data-authority-contested="${a.contested ? 'true' : 'false'}"
            aria-hidden="true"
          ></span>
          <span data-testid="asset-authority-summary">${esc(a.summary)}</span>
          <span class="visually-hidden" data-testid="asset-authority-detail">${attributions}${
            a.contested
              ? ` — CONTESTED: ${a.contestedFields.map((f) => esc(f)).join(', ')} (automation paused)`
              : ''
          }</span>`;
}

function assetRow(r: AssetTableRowVM): string {
  const b = r.base;
  const hidden = r.matches ? '' : ' hidden';
  const reason = r.matches ? '' : ` data-filtered-out-reason="${esc(r.filteredOutReason)}"`;
  return `
        <tr
          data-testid="asset-row"
          data-asset-id="${esc(b.id)}"
          data-search-index="${esc(r.searchIndex)}"
          data-matches="${r.matches ? 'true' : 'false'}"
          data-has-gap="${r.hasVisibleGap ? 'true' : 'false'}"
          data-authority-contested="${r.authority.contested ? 'true' : 'false'}"
          data-age-stale="${r.age.stale ? 'true' : 'false'}"${reason}${hidden}
        >
          <th scope="row">${esc(b.name)}</th>
          <td>${esc(b.assetType)}</td>
          <td>${esc(b.sourceIdentity)}</td>
          <td>${esc(b.owner)}</td>
          <td>${esc(b.lifecycleState)}</td>
          <td data-testid="asset-risk">${esc(b.riskTier)}</td>
          <td data-testid="asset-coverage">${esc(b.controlCoverage)}</td>
          <td data-testid="asset-evidence">${esc(b.evidenceState)}</td>
          <td data-testid="asset-health">${esc(b.reportedHealth)}</td>
          <td data-testid="asset-age" data-age-days="${r.age.observationAgeDays}" data-age-stale="${r.age.stale ? 'true' : 'false'}">
            <time datetime="${esc(b.lastObservedAt)}">${esc(r.age.label)}</time>
          </td>
          <td data-testid="asset-authority" data-authoritative-fields="${r.authority.authoritativeFieldCount}">${assetAuthorityCell(
            r.authority,
          )}</td>
          <td data-testid="asset-confidence">${b.confidence.toFixed(2)}</td>
          <td>${b.unresolvedIssues === 0 ? 'none' : `${b.unresolvedIssues} unresolved`}</td>
        </tr>`;
}

function assetTableRegion(m: InventoryTableModel): string {
  const rows = m.assetRows.map(assetRow).join('');
  const visible = m.assetRows.filter((r) => r.matches).length;
  return `
      <section id="region-asset-table" aria-labelledby="assets-h" data-testid="governed-asset-table" tabindex="-1">
        <h2 id="assets-h">Governed assets</h2>
        <p id="assets-summary" data-testid="asset-table-summary" data-asset-visible="${visible}" data-asset-total="${m.assetRows.length}">
          ${visible} of ${m.assetRows.length} governed asset(s) match the active search and filters.
          Each governed item appears once. Filtering never removes an item: a hidden row stays in the
          table as a coverage record with its filter reason. AGE is the observation age; AUTHORITY names
          the system-of-record per field and flags any contested authority.
        </p>
        <table aria-describedby="assets-summary">
          <caption>Governed assets — searchable and filterable, with explicit observation AGE and per-field AUTHORITY (type, source identity, owner, lifecycle, risk, control coverage, evidence, health, age, authority, confidence, unresolved issues)</caption>
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
              <th scope="col">Age</th>
              <th scope="col">Authority</th>
              <th scope="col">Confidence</th>
              <th scope="col">Unresolved issues</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── Source-catalog table (AC5/AC6 + AGE + AUTHORITY + search/filter) ─────────────────────────────

function sourceAuthorityCell(a: SourceAuthorityVM): string {
  return `
          <span
            class="badge badge--authority"
            data-classified="${a.classified ? 'true' : 'false'}"
            data-ownership-gap="${a.ownershipGap ? 'true' : 'false'}"
            aria-hidden="true"
          ></span>
          <span data-testid="source-authority-summary">${esc(a.summary)}</span>`;
}

function sourceRow(r: SourceTableRowVM): string {
  const b = r.base;
  const hidden = r.matches ? '' : ' hidden';
  const reason = r.matches ? '' : ` data-filtered-out-reason="${esc(r.filteredOutReason)}"`;
  const gapCell = r.gap
    ? `<span data-testid="source-gap-inline" data-gap-reason="${esc(r.gap.reasonClass)}" data-gap-impact="${esc(r.gap.impact)}" data-has-review="${r.gap.hasReviewOrExpiry ? 'true' : 'false'}">${esc(
        r.gap.reasonClass,
      )}: ${esc(r.gap.reasonText)} — ${esc(r.gap.impact)} impact — ${esc(r.gap.ownerAction)} (${esc(r.gap.reviewOrExpiry)})</span>`
    : '<span data-testid="source-no-gap">governed (no open source gap)</span>';
  return `
        <tr
          data-testid="source-row"
          data-source-id="${esc(b.id)}"
          data-search-index="${esc(r.searchIndex)}"
          data-matches="${r.matches ? 'true' : 'false'}"
          data-has-gap="${r.gap ? 'true' : 'false'}"
          data-classified="${r.authority.classified ? 'true' : 'false'}"
          data-ownership-gap="${r.authority.ownershipGap ? 'true' : 'false'}"${reason}${hidden}
        >
          <th scope="row">${esc(b.id)}</th>
          <td data-testid="source-classification">${esc(b.classification)}</td>
          <td>${esc(b.location)}</td>
          <td data-testid="source-access">${esc(b.accessStatus)}</td>
          <td data-testid="source-sensitivity">${esc(b.sensitivity)}</td>
          <td data-testid="source-onboarding">${esc(b.onboardingState)}</td>
          <td data-testid="source-age" data-discovered-age-days="${r.age.discoveredAgeDays}" data-last-seen-age-days="${r.age.lastSeenAgeDays}">
            ${esc(r.age.label)}
          </td>
          <td data-testid="source-authority" data-classified="${r.authority.classified ? 'true' : 'false'}" data-ownership-gap="${r.authority.ownershipGap ? 'true' : 'false'}">${sourceAuthorityCell(
            r.authority,
          )}</td>
          <td data-testid="source-discovery-evidence">${
            b.discoveryEvidenceRef
              ? `<a href="#${esc(b.discoveryEvidenceRef)}">${esc(b.discoveryEvidenceRef)}</a>`
              : '<span data-testid="no-discovery-evidence">no discovery evidence</span>'
          }</td>
          <td data-testid="source-gap-cell">${gapCell}</td>
        </tr>`;
}

function sourceTableRegion(m: InventoryTableModel): string {
  const rows = m.sourceRows.map(sourceRow).join('');
  const visible = m.sourceRows.filter((r) => r.matches).length;
  return `
      <section id="region-source-table" aria-labelledby="sources-h" data-testid="source-catalog-table" tabindex="-1">
        <h2 id="sources-h">Source catalog</h2>
        <p id="sources-summary" data-testid="source-table-summary" data-source-visible="${visible}" data-source-total="${m.sourceRows.length}">
          ${visible} of ${m.sourceRows.length} discovered source(s) match the active search and filters.
          Each source appears once. Filtering never removes a source: a hidden row stays a governed-source
          record with its filter reason and, if applicable, its open source-gap. AGE shows how long since
          discovery and last observation; AUTHORITY shows classification and ownership authority.
        </p>
        <table aria-describedby="sources-summary">
          <caption>Source catalog — searchable and filterable, with explicit discovery/last-seen AGE and classification/ownership AUTHORITY (classification, location, access, sensitivity, onboarding, age, authority, discovery evidence, open source gap)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Classification</th>
              <th scope="col">Location</th>
              <th scope="col">Access status</th>
              <th scope="col">Sensitivity</th>
              <th scope="col">Onboarding state</th>
              <th scope="col">Age</th>
              <th scope="col">Authority</th>
              <th scope="col">Discovery evidence</th>
              <th scope="col">Open source gap</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── Current-state region renderers (AC1–AC6 corroboration) — pure projections ────────────────────
//
// The two enriched tables above ARE the AC1/AC5 surfaces. These compact regions carry the remaining
// obligations verbatim from the current-state model so a single mounted document exercises AC2/AC3/AC4/
// AC6 alongside the tables (each gap/source stays visible with reason/age/impact/action; the stale
// panel withholds inferred health; the drill-down carries distinct records + authoritative fields).

function coverageGapsRegion(m: CurrentStateModel): string {
  const rows = m.coverageGaps
    .map(
      (g: CoverageGapVM) => `
        <tr data-testid="coverage-gap-row" data-reason="${esc(g.reasonClass)}" data-impact="${esc(g.impact)}" data-age-days="${g.ageDays}">
          <th scope="row">${esc(g.component)}</th>
          <td data-testid="gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td>${g.ageDays} day(s)</td>
          <td>${esc(g.impact)}</td>
          <td data-testid="gap-action">${esc(g.requiredOwnerAction)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-coverage-gaps" aria-labelledby="cg-h" data-testid="coverage-gaps" tabindex="-1">
        <h2 id="cg-h">Component coverage gaps</h2>
        <p data-testid="coverage-gaps-note">${m.coverageGaps.length} discovered component(s) not healthy — kept visible as coverage gaps with reason, age, impact, and required owner action (never healthy, never removed).</p>
        <table>
          <caption>Component coverage gaps (reason, age, impact, required owner action)</caption>
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

function drilldownRegion(m: CurrentStateModel): string {
  const dd: DrillDownVM | undefined = m.drilldown;
  const rows = (dd?.records ?? [])
    .map(
      (r) => `
        <tr data-testid="drilldown-row">
          <th scope="row">${esc(r.source)}</th>
          <td>${esc(r.recordId)}</td>
          <td>${esc(r.status)}</td>
          <td data-testid="drilldown-authoritative">${esc(r.authoritativeFields)}</td>
          <td>${esc(r.dependsOn)}</td>
          <td><time datetime="${esc(r.lastObservedAt)}">${esc(r.lastObservedAt)}</time></td>
        </tr>`,
    )
    .join('');
  const statuses = (dd?.records ?? []).map((r) => `${r.source}=${r.status}`).join(', ');
  return `
      <section id="region-drilldown" aria-labelledby="drill-h" data-testid="cross-source-drilldown" tabindex="-1">
        <h2 id="drill-h">Cross-source drill-down — ${esc(dd?.assetName ?? '—')}</h2>
        <p id="drill-summary" data-testid="drilldown-text-summary" data-distinct-sources="${dd?.distinctSourceCount ?? 0}" data-dependencies="${dd?.dependencyCount ?? 0}" data-authoritative-fields="${dd?.authoritativeFieldCount ?? 0}">
          Correlated across ${dd?.distinctSourceCount ?? 0} distinct registered source(s). Statuses: ${esc(statuses)}.
          ${dd?.dependencyCount ?? 0} dependency edge(s) and ${dd?.authoritativeFieldCount ?? 0} authoritative-field attribution(s).
          Each source keeps its DISTINCT record; authoritative fields are attributed per source.
        </p>
        <table aria-describedby="drill-summary">
          <caption>Distinct source records with correlation, status differences, dependencies, and authoritative fields</caption>
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

function freshnessRegion(m: CurrentStateModel): string {
  const s = m.stale;
  if (s === undefined) {
    return `
      <section id="region-freshness" aria-labelledby="stale-h" data-testid="stale-source-panel" tabindex="-1">
        <h2 id="stale-h">Source freshness</h2>
        <p data-testid="no-stale-inference" data-freshness="current">
          All contributing sources are current. Current compliance and health are NOT inferred from stale data.
        </p>
      </section>`;
  }
  return `
      <section id="region-freshness" aria-labelledby="stale-h" data-testid="stale-source-panel" tabindex="-1">
        <h2 id="stale-h">Source freshness — ${esc(s.name)}</h2>
        <p data-testid="stale-marker" data-freshness="${esc(s.evidenceState)}" data-reported-health="${esc(s.reportedHealth)}" data-observed-health="${esc(s.observedHealth)}">
          <strong>Evidence state: ${esc(s.evidenceState)}.</strong>
          Showing last-known data from
          <time datetime="${esc(s.lastObservedAt)}" data-testid="last-known-time">${esc(s.lastObservedAt)}</time>.
          Confidence: <span data-testid="confidence">${esc(s.confidence.toFixed(2))}</span>.
        </p>
        <p data-testid="no-stale-inference">
          Current compliance and health are NOT inferred from stale data: the reported health is
          <strong data-testid="stale-reported-health">${esc(s.reportedHealth)}</strong> (withheld as
          <em>unknown</em>), even though the last observation recorded
          <span data-testid="stale-observed-health">${esc(s.observedHealth)}</span>.
        </p>
      </section>`;
}

function sourceGapsRegion(m: CurrentStateModel): string {
  const rows = m.sourceGaps
    .map(
      (g: SourceGapVM) => `
        <tr data-testid="source-gap-row" data-reason="${esc(g.reasonClass)}" data-impact="${esc(g.impact)}" data-has-review="${g.hasReviewOrExpiry ? 'true' : 'false'}">
          <th scope="row">${esc(g.source)}</th>
          <td data-testid="source-gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td>${esc(g.impact)}</td>
          <td data-testid="source-gap-action">${esc(g.ownerAction)}</td>
          <td data-testid="source-gap-review">${esc(g.reviewOrExpiry)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-source-gaps" aria-labelledby="sg-h" data-testid="governed-source-gaps" tabindex="-1">
        <h2 id="sg-h">Governed-source gaps</h2>
        <p data-testid="source-gaps-note">${m.sourceGaps.length} discovered source(s) not fully governable — kept visible as governed-source gaps with reason, impact, owner action, and a review or expiry.</p>
        <table>
          <caption>Governed-source gaps (reason, impact, required owner action, review or expiry)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Reason</th>
              <th scope="col">Impact</th>
              <th scope="col">Required owner action</th>
              <th scope="col">Review / expiry</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── Chrome ───────────────────────────────────────────────────────────────────────────────────────

/** The tenant-scope banner: a machine-readable identity binding + human tenant label. */
function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section
        aria-labelledby="scope-h"
        data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}"
        data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}"
        data-work-item-id="${esc(tenant.workItemId)}"
        data-role="operator"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">operator</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
          <div class="scope-row"><dt>Work item</dt><dd data-testid="scope-work-item"><code>${esc(tenant.workItemId)}</code></dd></div>
          <div class="scope-row"><dt>Scope generated</dt><dd><time datetime="${esc(tenant.generatedAt)}" data-testid="scope-generated-at">${esc(tenant.generatedAt)}</time></dd></div>
        </dl>
      </section>`;
}

// ── The view ───────────────────────────────────────────────────────────────────────────────────

/**
 * Render the complete accessible INVENTORY-TABLE view as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderInventoryTable(props))`.
 * Single-column and wrapping (no fixed pixel widths that force horizontal scroll at 400% zoom), with a
 * visible focus indicator so keyboard focus is never invisible.
 *
 * Order: skip link → tenant-scope banner → global status → `<main>` framing the SEARCH/FILTER controls,
 * the governed-asset table, and the source-catalog table (both with AGE + AUTHORITY), then the AC2/AC3/
 * AC4/AC6 current-state corroboration regions.
 */
export function renderInventoryTable(
  props: InventoryTableProps = DEFAULT_INVENTORY_TABLE_PROPS,
): string {
  const { tenant } = props;
  const m = props.model;
  const cs = m.currentState;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} inventory tables</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 1rem;
      font: 16px/1.5 system-ui, sans-serif;
      color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word;
    }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    .search-row { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .5rem; }
    .search-row input { font: inherit; padding: .35rem .5rem; max-width: 100%; }
    .chip-toolbar { display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: .5rem; }
    .chip { font: inherit; padding: .25rem .6rem; border: 1px solid #666; border-radius: 1rem;
            background: #f3f3f3; cursor: pointer; }
    .chip[aria-pressed="true"] { background: #0b57d0; color: #fff; border-color: #0b57d0; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 3px solid #0b57d0; outline-offset: 2px;
    }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    .badge { display: inline-block; width: .75rem; height: .75rem; border-radius: 50%;
             vertical-align: middle; margin-right: .25rem; background: #444; }
    .badge--authority[data-authority-contested="true"] { background: #b3261e; }
    .badge--authority[data-ownership-gap="true"] { background: #a15c00; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="inventory-title">${esc(tenant.tenantName)} — governed inventory tables</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(m.query.resultSummary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="inventory-main" data-role="operator" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${searchAndFilterControls(m)}
    ${assetTableRegion(m)}
    ${sourceTableRegion(m)}
    ${coverageGapsRegion(cs)}
    ${drilldownRegion(cs)}
    ${freshnessRegion(cs)}
    ${sourceGapsRegion(cs)}
  </main>
  <footer>
    <p data-testid="inventory-footer">
      Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · governed inventory tables.
    </p>
  </footer>
</body>
</html>`;
}

/**
 * Default export: the inventory-table renderer. The accessible contract is `renderInventoryTable`; a
 * framework adopter wraps it and injects a derived `model` (and wires the search box + filter chips to
 * live client state).
 */
export default renderInventoryTable;
