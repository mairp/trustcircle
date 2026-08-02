// TrustCircleAI — SOURCE / ASSET DRILL-DOWN DETAIL view (Phase 80 /
// apps/web/src/features/inventory/InventoryDetail.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer's DRILL-DOWN DETAIL surface for a SINGLE governed asset (and the single discovered
// source it correlates against). Where the Phase-79 InventoryTable answers "find and compare the
// governed items / sources I care about", THIS view answers the next question the officer asks after
// selecting one row: "show me EVERYTHING about this one item — every distinct source record that
// contributed, which source is authoritative for which field, the DIFFERENT values each source
// reported (status differences), the VERSIONS/HISTORY of each field across its contributing sources,
// the item's HEALTH and EVIDENCE state, its dependency edges, and — when a contributing source is
// stale — the last-known time + confidence with a hard refusal to infer current health from it."
//
// It is the drill-in target the six current-state acceptance criteria (AC1–AC6) demand at the
// single-item granularity:
//   • AC1 — the SELECTED asset's identity header renders the asset ONCE with its every authoritative
//     field (type, source identity, owner, lifecycle state, risk, control coverage, evidence state,
//     health, last observation time, unresolved issues) — the same enumerated facet set the table
//     row carries, expanded into a detail panel.
//   • AC2 — the component coverage gaps bound to THIS asset stay VISIBLE in the detail (reason, age,
//     impact, required owner action); a drilled-in item that has an open component gap is never shown
//     covered+healthy and never silently omitted.
//   • AC3 — the CORE of this view: a DISTINCT-SOURCE-RECORD table (one row per contributing source
//     record — Kanban / agentctl / workflows_orchestration / …, each retained), a per-field
//     AUTHORITY/CORRELATION table naming the system-of-record per field and flagging CONTESTED fields
//     with the DIFFERING source values (status differences), a DEPENDENCY list (`depends_on`), and a
//     FIELD-HISTORY panel showing each field's contributing-source VERSIONS (value + as-of + freshness
//     + confidence per source) so the officer can reconstruct how the current value was reached.
//   • AC4 — each contributing source record and each resolved field carries an explicit FRESHNESS
//     verdict; when the winning observation is stale the value is shown WITH its last-known time and
//     confidence and is explicitly marked "not current" — the reported health is withheld as
//     `unknown`, never inferred from the stale reading.
//   • AC5 — the correlated DISCOVERED SOURCE (the open-catalog entry in the same boundary) renders its
//     full discovery detail: discovery evidence, type-or-`unknown` classification, location, access
//     status, sensitivity, ownership status, onboarding state.
//   • AC6 — when that discovered source remains a governed-source gap, the detail surfaces the gap's
//     reason, impact, owner action, and review-or-expiry — visible, not healthy, not disappearing.
//
// THIS VIEW IS A PURE PRESENTER — it does NOT compute the drill-down. `renderInventoryDetail(props)`
// renders whatever `InventoryDetailModel` it is handed. That model is DERIVED elsewhere
// (tests/accessibility/support/inventory-detail-model.ts) by running the REAL Phase-70 current-
// inventory assembly service (packages/application/src/inventory-service.ts) — the same aggregate
// proven in tests/unit/inventory-service.unit.test.ts — over an explicit deterministic scenario, and
// projecting the service's OWN `drillDown()` / `currentStateView()` / `componentGaps()` /
// `governedSourceGaps()` / `catalogView()` outputs. Every value this view shows is therefore a
// projection of a value the service COMPUTED:
//   • AC1 the identity header is the SERVICE's `InventoryRow` for the selected asset (one row);
//   • AC3 the distinct-record rows ARE `drillDown().sourceRecords` (retained verbatim); the per-field
//     authority/contested/differing-sources come from `drillDown().correlation.fields`
//     (`FieldResolution`), the dependency edges from `drillDown().dependencies`, and the field history
//     from each resolution's `contributingSources` (value + freshness + confidence + as-of per source);
//   • AC4 a field/record whose winning observation is stale reports its `stale`/`freshness` verdict and
//     the item's `reportedHealth` is `unknown` because the SERVICE refuses to infer it;
//   • AC5 the discovered-source panel is the SERVICE's `catalogView()` entry;
//   • AC6 the governed-source gap is the SERVICE's `governedSourceGaps()` entry.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React runtime
// yet, and the repo's TypeScript base sets no `jsx` runtime. A JSX element would not compile. The
// accessible *contract* of this view, however, is specifiable now: this module expresses it as a pure,
// deterministic renderer returning the exact accessible markup the shipped React view must reproduce.
// Because the output is a self-contained HTML string, the Phase-80 accessibility spec mounts it in a
// REAL browser via `page.setContent(renderInventoryDetail(props))` and asserts — through axe-core and
// the live accessibility tree — every obligation, with NO web server, NO React, and NO tenant-auth.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no network,
// no module-level mutable state — same props ⇒ byte-identical output.

import type {
  InventoryRowVM,
  CoverageGapVM,
  SourceGapVM,
  DiscoveredSourceVM,
  TenantScope,
} from '../../app/layout.tsx';

export type { InventoryRowVM, CoverageGapVM, SourceGapVM, DiscoveredSourceVM, TenantScope };

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
// The drill-down detail view is bound to exactly one governance bundle. Rendering the bundle id +
// semantic hash + work item as machine-readable, independently-readable DOM (a `<dl>` with data
// attributes, not a mutation-response echo) is the DURABLE IDENTITY witness the phase's effect-witness
// obligations require: a value observable through an independent read path, and REJECTABLE when it
// differs from the pinned input.

/** The one tenant scope this view is pinned to (work item 384B1E4BN35A236DWJKY5MK8AE). */
export const DETAIL_TENANT: TenantScope = {
  tenantId: 'tnt-acme-governance',
  tenantName: 'Acme Governance',
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: '384B1E4BN35A236DWJKY5MK8AE',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── Detail-specific view model — the render-ready reductions of the REAL service outputs ─────────
//
// These shapes are produced by tests/accessibility/support/inventory-detail-model.ts#deriveInventoryDetail(),
// which runs the Phase-70 `InventoryService`, selects ONE asset, and projects its `drillDown()` +
// `rowFor()` outputs (plus the correlated discovered source + its governed-source gap) into the panels
// below. Every field is a projection of a value the service COMPUTED — the presenter invents nothing.

/** AC3/AC4: one DISTINCT source record contributing to the drilled-in asset (retained verbatim). */
export interface DetailSourceRecordVM {
  /** The source class (platform_kanban / agentctl / workflows_orchestration / …). */
  readonly sourceClass: string;
  /** The source-side external key (the record id in the originating source). */
  readonly externalKey: string;
  /** The record's own status enum (active/inactive/unknown). */
  readonly status: string;
  /** The status observed in the record's payload (may differ from `status`). */
  readonly observedStatus: string;
  /** AC4: the record's freshness verdict (fresh/stale/…). */
  readonly freshness: string;
  /** AC4: true iff the record is stale (past the freshness horizon / flagged suspect). */
  readonly stale: boolean;
  /** AC4: the record's confidence ∈ [0,1]. */
  readonly confidence: number;
  /** AC4: the record's last-known ISO time (an independent effect witness for staleness). */
  readonly lastKnownAtIso: string;
  /** The comma-joined named fields THIS source is authoritative for (or "—"). */
  readonly authoritativeFor: string;
  /** The external key this record `depends_on` (or "—"). */
  readonly dependsOn: string;
}

/** AC3: one contributing-source VERSION for a single field — the field's HISTORY across sources. */
export interface FieldSourceVersionVM {
  readonly sourceClass: string;
  readonly externalKey: string;
  /** The value this source reported for the field (rendered as text). */
  readonly value: string;
  readonly freshness: string;
  readonly confidence: number;
  readonly asOfIso: string;
  /** True iff this source's value differs from the resolved/authoritative value (status difference). */
  readonly differs: boolean;
}

/** AC3/AC4: one governed field's correlation across the asset's distinct source records. */
export interface DetailFieldVM {
  readonly field: string;
  /** 'resolved' | 'unresolved'. */
  readonly resolution: string;
  /** The authoritative value (text), or a note when unresolved. */
  readonly value: string;
  /** The authoritative source class (system-of-record), or "—" when unresolved. */
  readonly authoritativeSourceClass: string;
  /** True iff two+ sources reported DIFFERENT values (status difference; AC3). */
  readonly contested: boolean;
  /** AC4: true iff the winning observation is stale (value shown with as-of, not read as current). */
  readonly stale: boolean;
  /** Present when unresolved: the rule that fired (authority_tie/…); else "". */
  readonly unresolvedReason: string;
  /** The winning observation's confidence (or 0 when unresolved). */
  readonly confidence: number;
  /** The winning observation's as-of ISO time (or "—"). */
  readonly asOfIso: string;
  /** Every contributing source's VERSION of this field (the history/versions list). */
  readonly versions: readonly FieldSourceVersionVM[];
  /** A non-color-only one-line summary of the field's correlation state. */
  readonly summary: string;
}

/** AC1: the identity header for the drilled-in asset (the one InventoryRow, expanded). */
export interface DetailAssetHeaderVM {
  readonly base: InventoryRowVM;
  /** AC1 "version" — the governed asset's monotonic version (its own history counter). */
  readonly version: number;
  /** AC4: true iff the item's evidence is not `current` (health withheld as unknown). */
  readonly evidenceStale: boolean;
  /** AC4: the health SAFE to report vs. the health last observed (differ iff withheld). */
  readonly reportedHealth: string;
  readonly observedHealth: string;
  /** True iff any governed field is contested / unresolved → automation PAUSED. */
  readonly automationPaused: boolean;
}

/** AC5/AC6: the correlated DISCOVERED SOURCE detail + its governed-source gap (if any). */
export interface DetailDiscoveredSourceVM {
  readonly base: DiscoveredSourceVM;
  /** The AC6 governed-source gap bound to this source, if any (kept visible when present). */
  readonly gap?: SourceGapVM;
  /** True iff the source's class is authoritatively classified (false ⇒ still `unknown`). */
  readonly classified: boolean;
  /** True iff no accountable owner is recorded (ownership gap). */
  readonly ownershipGap: boolean;
}

/** The whole drill-down detail model for ONE asset. */
export interface InventoryDetailModel {
  /** AC1: the identity header (the selected asset, once, with every authoritative field). */
  readonly header: DetailAssetHeaderVM;
  /** AC3: the distinct source records that contributed (each retained once). */
  readonly sourceRecords: readonly DetailSourceRecordVM[];
  /** AC3/AC4: per-field authority/correlation with versions/history and status differences. */
  readonly fields: readonly DetailFieldVM[];
  /** AC3: dependency edges (`depends_on`) between the contributing sources, as text. */
  readonly dependencies: readonly string[];
  /** AC2: the still-visible component coverage gaps bound to this asset. */
  readonly componentGaps: readonly CoverageGapVM[];
  /** AC5/AC6: the correlated discovered source (open-catalog) detail + its gap. */
  readonly discoveredSource?: DetailDiscoveredSourceVM;
  /** AC3 correlated distinct-source count (one per source class). */
  readonly distinctSourceCount: number;
  /** AC3 dependency-edge count. */
  readonly dependencyCount: number;
  /** AC3 authoritative-field attribution count. */
  readonly authoritativeFieldCount: number;
  /** The ISO instant this detail was derived at. */
  readonly generatedAtIso: string;
  /** The service's content digest at the current instant — an independent effect witness. */
  readonly snapshotDigest: string;
}

/**
 * An EMPTY-but-valid model. The view renders this only when none is injected; the panels frame their
 * headers/captions but carry no records, so an un-fed view CANNOT masquerade as a satisfied drill-down
 * (every record-count / field assertion fails against it).
 */
export const EMPTY_INVENTORY_DETAIL: InventoryDetailModel = {
  header: {
    base: {
      id: 'none',
      assetType: '—',
      name: 'No asset selected',
      sourceIdentity: '—',
      owner: '—',
      lifecycleState: '—',
      riskTier: '—',
      controlCoverage: '—',
      evidenceState: '—',
      reportedHealth: 'unknown',
      observedHealth: 'unknown',
      confidence: 0,
      lastObservedAt: '—',
      unresolvedIssues: 0,
      sourceRecordCount: 0,
    },
    version: 0,
    evidenceStale: false,
    reportedHealth: 'unknown',
    observedHealth: 'unknown',
    automationPaused: false,
  },
  sourceRecords: [],
  fields: [],
  dependencies: [],
  componentGaps: [],
  distinctSourceCount: 0,
  dependencyCount: 0,
  authoritativeFieldCount: 0,
  generatedAtIso: DETAIL_TENANT.generatedAt,
  snapshotDigest: 'empty',
} as const;

// ── Props ──────────────────────────────────────────────────────────────────────────────────────

export interface InventoryDetailProps {
  readonly tenant: TenantScope;
  readonly model: InventoryDetailModel;
}

export const DEFAULT_INVENTORY_DETAIL_PROPS: InventoryDetailProps = {
  tenant: DETAIL_TENANT,
  model: EMPTY_INVENTORY_DETAIL,
} as const;

// ── AC1 — asset identity header (the one row, expanded into a detail panel) ───────────────────────

function identityHeaderRegion(m: InventoryDetailModel): string {
  const h = m.header;
  const b = h.base;
  return `
      <section id="region-identity" aria-labelledby="identity-h" data-testid="asset-identity" tabindex="-1"
        data-asset-id="${esc(b.id)}"
        data-evidence-stale="${h.evidenceStale ? 'true' : 'false'}"
        data-automation-paused="${h.automationPaused ? 'true' : 'false'}"
      >
        <h2 id="identity-h">Selected asset — ${esc(b.name)}</h2>
        <p id="identity-summary" data-testid="identity-summary">
          This drill-down shows the single governed item <strong>${esc(b.name)}</strong> (<code data-testid="identity-asset-id">${esc(
            b.id,
          )}</code>) ONCE, expanded into its every authoritative field, its distinct contributing
          source records, its per-field authority and history, its health and evidence, and its
          coverage. Each contributing source keeps its DISTINCT record; no source overrides another's
          authority.
        </p>
        <dl data-testid="identity-fields">
          <div class="row"><dt>Type</dt><dd data-testid="identity-type">${esc(b.assetType)}</dd></div>
          <div class="row"><dt>Source identity</dt><dd data-testid="identity-source-identity">${esc(b.sourceIdentity)}</dd></div>
          <div class="row"><dt>Owner</dt><dd data-testid="identity-owner">${esc(b.owner)}</dd></div>
          <div class="row"><dt>Lifecycle state</dt><dd data-testid="identity-lifecycle">${esc(b.lifecycleState)}</dd></div>
          <div class="row"><dt>Risk</dt><dd data-testid="identity-risk">${esc(b.riskTier)}</dd></div>
          <div class="row"><dt>Control coverage</dt><dd data-testid="identity-coverage">${esc(b.controlCoverage)}</dd></div>
          <div class="row"><dt>Evidence state</dt><dd data-testid="identity-evidence" data-evidence-stale="${h.evidenceStale ? 'true' : 'false'}">${esc(b.evidenceState)}</dd></div>
          <div class="row"><dt>Health</dt><dd data-testid="identity-health" data-reported-health="${esc(h.reportedHealth)}" data-observed-health="${esc(h.observedHealth)}">${esc(
            h.reportedHealth,
          )}${
            h.evidenceStale
              ? ` <span class="visually-hidden" data-testid="identity-health-note">(withheld as unknown; last observation recorded ${esc(
                  h.observedHealth,
                )} — not read as current)</span>`
              : ''
          }</dd></div>
          <div class="row"><dt>Last observation time</dt><dd><time datetime="${esc(b.lastObservedAt)}" data-testid="identity-last-observed">${esc(b.lastObservedAt)}</time></dd></div>
          <div class="row"><dt>Unresolved issues</dt><dd data-testid="identity-unresolved">${b.unresolvedIssues === 0 ? 'none' : `${b.unresolvedIssues} unresolved`}</dd></div>
          <div class="row"><dt>Version</dt><dd data-testid="identity-version">${h.version}</dd></div>
          <div class="row"><dt>Confidence</dt><dd data-testid="identity-confidence">${b.confidence.toFixed(2)}</dd></div>
          <div class="row"><dt>Distinct source records</dt><dd data-testid="identity-record-count">${b.sourceRecordCount}</dd></div>
        </dl>
        ${
          h.automationPaused
            ? `<p data-testid="automation-paused" data-automation-paused="true"><strong>Automation is PAUSED</strong> for this item: at least one governed field is contested or unresolved, so no value is auto-applied until a human resolves it.</p>`
            : `<p data-testid="automation-active" data-automation-paused="false">No field is contested; automation may proceed for resolved fields.</p>`
        }
      </section>`;
}

// ── AC3 — distinct source records (each contributing source kept once) ────────────────────────────

function sourceRecordsRegion(m: InventoryDetailModel): string {
  const rows = m.sourceRecords
    .map(
      (r) => `
        <tr data-testid="detail-record-row" data-source-class="${esc(r.sourceClass)}" data-stale="${r.stale ? 'true' : 'false'}">
          <th scope="row" data-testid="record-source-class">${esc(r.sourceClass)}</th>
          <td data-testid="record-external-key">${esc(r.externalKey)}</td>
          <td data-testid="record-status">${esc(r.observedStatus)}</td>
          <td data-testid="record-freshness" data-stale="${r.stale ? 'true' : 'false'}">${esc(r.freshness)}</td>
          <td data-testid="record-confidence">${r.confidence.toFixed(2)}</td>
          <td><time datetime="${esc(r.lastKnownAtIso)}" data-testid="record-last-known">${esc(r.lastKnownAtIso)}</time></td>
          <td data-testid="record-authoritative-for">${esc(r.authoritativeFor)}</td>
          <td data-testid="record-depends-on">${esc(r.dependsOn)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-records" aria-labelledby="records-h" data-testid="distinct-source-records" tabindex="-1">
        <h2 id="records-h">Distinct source records</h2>
        <p id="records-summary" data-testid="records-summary" data-distinct-sources="${m.distinctSourceCount}" data-record-count="${m.sourceRecords.length}">
          ${m.sourceRecords.length} distinct source record(s) across ${m.distinctSourceCount} registered
          source(s) contributed to this item. Every source keeps its OWN record — records are correlated,
          never merged away — so the officer can see each source's external key, status, freshness,
          confidence, last-known time, the fields it is authoritative for, and what it depends on.
        </p>
        <table aria-describedby="records-summary">
          <caption>Distinct contributing source records (source, external key, status, freshness, confidence, last known, authoritative fields, depends on)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">External key</th>
              <th scope="col">Status</th>
              <th scope="col">Freshness</th>
              <th scope="col">Confidence</th>
              <th scope="col">Last known</th>
              <th scope="col">Authoritative for</th>
              <th scope="col">Depends on</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── AC3/AC4 — per-field authority + correlation + versions/history (the drill-down core) ──────────

function fieldVersionsList(f: DetailFieldVM): string {
  const items = f.versions
    .map(
      (v) => `
            <li data-testid="field-version" data-source-class="${esc(v.sourceClass)}" data-differs="${v.differs ? 'true' : 'false'}" data-stale="${
              v.freshness !== 'fresh' ? 'true' : 'false'
            }">
              <span data-testid="version-source">${esc(v.sourceClass)}</span>
              (<span data-testid="version-key">${esc(v.externalKey)}</span>)
              reported <strong data-testid="version-value">${esc(v.value)}</strong>
              — ${esc(v.freshness)}, confidence ${v.confidence.toFixed(2)},
              as of <time datetime="${esc(v.asOfIso)}">${esc(v.asOfIso)}</time>${
                v.differs
                  ? ' <em data-testid="version-differs">(differs from the authoritative value)</em>'
                  : ''
              }
            </li>`,
    )
    .join('');
  return `
          <ul class="versions" data-testid="field-history" data-field="${esc(f.field)}" data-version-count="${f.versions.length}">${items}
          </ul>`;
}

function fieldsRegion(m: InventoryDetailModel): string {
  const rows = m.fields
    .map(
      (f) => `
        <tr data-testid="detail-field-row" data-field="${esc(f.field)}" data-resolution="${esc(f.resolution)}" data-contested="${
          f.contested ? 'true' : 'false'
        }" data-stale="${f.stale ? 'true' : 'false'}">
          <th scope="row" data-testid="field-name">${esc(f.field)}</th>
          <td data-testid="field-value">${esc(f.value)}</td>
          <td data-testid="field-authority">${esc(f.authoritativeSourceClass)}</td>
          <td data-testid="field-resolution" data-contested="${f.contested ? 'true' : 'false'}">${esc(f.resolution)}${
            f.unresolvedReason ? ` (${esc(f.unresolvedReason)})` : ''
          }${f.contested ? ' — CONTESTED' : ''}</td>
          <td data-testid="field-freshness" data-stale="${f.stale ? 'true' : 'false'}">${
            f.stale ? 'stale (shown with as-of; not read as current)' : 'current'
          }</td>
          <td><time datetime="${esc(f.asOfIso)}" data-testid="field-asof">${esc(f.asOfIso)}</time></td>
          <td data-testid="field-versions-cell">${fieldVersionsList(f)}</td>
        </tr>`,
    )
    .join('');
  const contestedCount = m.fields.filter((f) => f.contested).length;
  return `
      <section id="region-fields" aria-labelledby="fields-h" data-testid="field-correlation" tabindex="-1"
        data-authoritative-fields="${m.authoritativeFieldCount}" data-contested-count="${contestedCount}">
        <h2 id="fields-h">Field authority, correlation &amp; history</h2>
        <p id="fields-summary" data-testid="fields-summary" data-field-count="${m.fields.length}" data-contested-count="${contestedCount}">
          ${m.fields.length} governed field(s) correlated across the contributing sources.
          For each field this names the AUTHORITATIVE source (system-of-record), the resolved value,
          whether the field is CONTESTED (sources reported DIFFERENT values — a status difference),
          the freshness of the winning observation, and the full HISTORY of every source's version of
          the field (value, freshness, confidence, as-of). ${contestedCount} field(s) are contested and
          therefore stay unresolved for a human.
        </p>
        <table aria-describedby="fields-summary">
          <caption>Per-field authority, correlation, status differences, freshness, and contributing-source history/versions</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Authoritative value</th>
              <th scope="col">Authoritative source</th>
              <th scope="col">Resolution</th>
              <th scope="col">Freshness</th>
              <th scope="col">As of</th>
              <th scope="col">Contributing-source history</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── AC3 — dependency edges (depends_on) ───────────────────────────────────────────────────────────

function dependenciesRegion(m: InventoryDetailModel): string {
  const items = m.dependencies.length
    ? m.dependencies.map((d) => `<li data-testid="dependency-edge">${esc(d)}</li>`).join('')
    : '<li data-testid="no-dependency">no dependency edges recorded</li>';
  return `
      <section id="region-dependencies" aria-labelledby="deps-h" data-testid="dependencies" tabindex="-1">
        <h2 id="deps-h">Dependencies</h2>
        <p data-testid="deps-summary" data-dependency-count="${m.dependencyCount}">
          ${m.dependencyCount} dependency edge(s) (<code>depends_on</code>) correlated between the
          contributing sources.
        </p>
        <ul data-testid="dependency-list">${items}</ul>
      </section>`;
}

// ── AC2 — component coverage gaps bound to this asset (stay visible) ───────────────────────────────

function componentGapsRegion(m: InventoryDetailModel): string {
  const rows = m.componentGaps
    .map(
      (g) => `
        <tr data-testid="detail-component-gap-row" data-reason="${esc(g.reasonClass)}" data-impact="${esc(g.impact)}" data-age-days="${g.ageDays}">
          <th scope="row">${esc(g.component)}</th>
          <td data-testid="detail-gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td>${g.ageDays} day(s)</td>
          <td>${esc(g.impact)}</td>
          <td data-testid="detail-gap-action">${esc(g.requiredOwnerAction)}</td>
        </tr>`,
    )
    .join('');
  const note =
    m.componentGaps.length === 0
      ? `<p data-testid="no-component-gap" data-gap-count="0">This item has no open component coverage gap.</p>`
      : `<p data-testid="component-gaps-note" data-gap-count="${m.componentGaps.length}">${m.componentGaps.length} open component coverage gap(s) bound to this item remain VISIBLE with reason, age, impact, and required owner action — the item is never shown covered+healthy while a gap is open, and the gap never disappears.</p>`;
  return `
      <section id="region-component-gaps" aria-labelledby="cg-h" data-testid="detail-component-gaps" tabindex="-1">
        <h2 id="cg-h">Component coverage gaps for this item</h2>
        ${note}
        <table>
          <caption>Component coverage gaps bound to this item (reason, age, impact, required owner action)</caption>
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

// ── AC5/AC6 — the correlated discovered source detail + its governed-source gap ───────────────────

function discoveredSourceRegion(m: InventoryDetailModel): string {
  const d = m.discoveredSource;
  if (d === undefined) {
    return `
      <section id="region-discovered-source" aria-labelledby="ds-h" data-testid="discovered-source" tabindex="-1">
        <h2 id="ds-h">Correlated discovered source</h2>
        <p data-testid="no-discovered-source">No discovered open-catalog source is correlated with this item.</p>
      </section>`;
  }
  const b = d.base;
  const gap = d.gap;
  return `
      <section id="region-discovered-source" aria-labelledby="ds-h" data-testid="discovered-source" tabindex="-1"
        data-source-id="${esc(b.id)}"
        data-classified="${d.classified ? 'true' : 'false'}"
        data-ownership-gap="${d.ownershipGap ? 'true' : 'false'}"
        data-has-source-gap="${gap ? 'true' : 'false'}"
      >
        <h2 id="ds-h">Correlated discovered source — ${esc(b.id)}</h2>
        <p id="ds-summary" data-testid="discovered-source-summary">
          A governance-relevant source discovered inside the declared boundary and added to the source
          catalog. Its discovery detail is shown below with discovery evidence, type-or-unknown
          classification, location, access status, sensitivity, ownership status, and onboarding state.
        </p>
        <dl data-testid="discovered-source-fields">
          <div class="row"><dt>Classification</dt><dd data-testid="ds-classification" data-classified="${d.classified ? 'true' : 'false'}">${esc(b.classification)}</dd></div>
          <div class="row"><dt>Location</dt><dd data-testid="ds-location">${esc(b.location)}</dd></div>
          <div class="row"><dt>Access status</dt><dd data-testid="ds-access">${esc(b.accessStatus)}</dd></div>
          <div class="row"><dt>Sensitivity</dt><dd data-testid="ds-sensitivity">${esc(b.sensitivity)}</dd></div>
          <div class="row"><dt>Ownership status</dt><dd data-testid="ds-ownership" data-ownership-gap="${d.ownershipGap ? 'true' : 'false'}">${esc(b.ownershipStatus)}</dd></div>
          <div class="row"><dt>Onboarding state</dt><dd data-testid="ds-onboarding">${esc(b.onboardingState)}</dd></div>
          <div class="row"><dt>Discovery evidence</dt><dd data-testid="ds-discovery-evidence">${
            b.discoveryEvidenceRef
              ? `<a href="#${esc(b.discoveryEvidenceRef)}">${esc(b.discoveryEvidenceRef)}</a>`
              : '<span data-testid="ds-no-discovery-evidence">no discovery evidence</span>'
          }</dd></div>
        </dl>
        ${
          gap
            ? `<div data-testid="detail-source-gap" data-gap-reason="${esc(gap.reasonClass)}" data-gap-impact="${esc(gap.impact)}" data-has-review="${
                gap.hasReviewOrExpiry ? 'true' : 'false'
              }">
          <h3 data-testid="detail-source-gap-heading">Governed-source gap (stays visible)</h3>
          <p>
            This discovered source remains a GOVERNED-SOURCE gap — it is not healthy and does not
            disappear. <span data-testid="detail-source-gap-reason">${esc(gap.reasonClass)}: ${esc(gap.reasonText)}</span>.
            Impact: <span data-testid="detail-source-gap-impact">${esc(gap.impact)}</span>.
            Required owner action: <span data-testid="detail-source-gap-action">${esc(gap.ownerAction)}</span>.
            Review / expiry: <span data-testid="detail-source-gap-review">${esc(gap.reviewOrExpiry)}</span>.
          </p>
        </div>`
            : `<p data-testid="detail-source-no-gap">This discovered source has no open governed-source gap.</p>`
        }
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
 * Render the complete accessible DRILL-DOWN DETAIL view as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderInventoryDetail(props))`.
 * Single-column and wrapping (no fixed pixel widths that force horizontal scroll at 400% zoom), with a
 * visible focus indicator so keyboard focus is never invisible.
 *
 * Order: skip link → tenant-scope banner → global status → `<main>` framing the AC1 identity header,
 * the AC3 distinct-source records, the AC3/AC4 per-field authority/correlation/history, the AC3
 * dependencies, the AC2 component gaps, and the AC5/AC6 correlated discovered-source detail.
 */
export function renderInventoryDetail(
  props: InventoryDetailProps = DEFAULT_INVENTORY_DETAIL_PROPS,
): string {
  const { tenant } = props;
  const m = props.model;
  const statusText = `Drill-down for ${m.header.base.name}: ${m.sourceRecords.length} distinct source record(s), ${
    m.fields.filter((f) => f.contested).length
  } contested field(s), evidence ${m.header.base.evidenceState}.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} inventory drill-down</title>
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
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; vertical-align: top; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .row, .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    ul.versions { margin: 0; padding-left: 1.1rem; }
    ul.versions li { margin: .15rem 0; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 3px solid #0b57d0; outline-offset: 2px;
    }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="detail-title">${esc(tenant.tenantName)} — inventory drill-down</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(statusText)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="detail-main" data-role="operator" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${identityHeaderRegion(m)}
    ${sourceRecordsRegion(m)}
    ${fieldsRegion(m)}
    ${dependenciesRegion(m)}
    ${componentGapsRegion(m)}
    ${discoveredSourceRegion(m)}
  </main>
  <footer>
    <p data-testid="detail-footer">
      Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · inventory drill-down detail.
    </p>
  </footer>
</body>
</html>`;
}

/**
 * Default export: the inventory-detail renderer. The accessible contract is `renderInventoryDetail`; a
 * framework adopter wraps it and injects a derived `model` (the drill-down for the selected asset).
 */
export default renderInventoryDetail;
