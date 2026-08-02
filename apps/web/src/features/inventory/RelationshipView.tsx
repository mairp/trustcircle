// TrustCircleAI — RELATIONSHIP VIEW with an EQUIVALENT NAVIGABLE TABLE and a MATERIAL TEXT SUMMARY
// (Phase 82 / apps/web/src/features/inventory/RelationshipView.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer's RELATIONSHIP surface for ONE governed item: it draws the relationship GRAPH that ties an
// asset to the distinct source records that reported it (Kanban / agentctl / workflows_orchestration),
// the `depends_on` edges between those records, and the `authoritative_for` edges that name each field's
// system-of-record. A relationship graph is a visual artefact; WCAG 2.2 and the phase's most specific
// verification obligation (VO-057645e173b20b45c7cc) require that EVERY chart / relationship view /
// timeline ALSO carry a text summary AND a navigable tabular alternative that preserve the SAME MATERIAL
// INFORMATION. This module renders all three from ONE model, so the three presentations cannot drift:
//
//   • THE GRAPH  — an accessible node/edge diagram (an SVG-free, DOM-native graph: a `<figure>` with
//     labelled node groups and an edge list), `aria-describedby` the text summary. Presentational only.
//   • THE TABLE  — the NAVIGABLE ALTERNATIVE: three real HTML `<table>`s (nodes, edges, field
//     correlations) with row/column headers, captions, and machine-readable cells. Everything the graph
//     conveys (every node, every edge, every contested field + its differing source values + its
//     authoritative source) is present as a table row — no information is graph-only.
//   • THE SUMMARY — the MATERIAL TEXT SUMMARY: prose stating the item's identity, how many distinct
//     sources reported it, how many depend on which, which fields are authoritative and which are
//     contested, whether any contributing evidence is stale (health withheld), and what governance gaps
//     remain. Every quantity in the summary is the SAME projected value the table rows carry.
//
// FAIL-VISIBLE across the six current-state acceptance criteria (each projected from the REAL service):
//   • AC1 — the governed item appears ONCE as the graph's central node, carrying its type / source
//     identity / owner / lifecycle / risk / control coverage / evidence state / health / last-observation
//     time / unresolved-issue count.
//   • AC2 — a discovered-but-unmanaged component related to this item stays a VISIBLE coverage gap (a gap
//     node + a gap-table row with reason / age / impact / required owner action) — never healthy, never
//     dropped from the graph.
//   • AC3 — the graph + edge/field tables show the DISTINCT source records, their correlation, their
//     STATUS DIFFERENCES (differing source values), their dependencies, and the authoritative field.
//   • AC4 — when a contributing source is STALE the node + summary mark it with its last-known time and
//     confidence, and the reported health is WITHHELD as `unknown` (current health is NOT inferred).
//   • AC5 — a related discovered source is listed in a source-catalog table with its classification
//     (type or `unknown`), location, access status, sensitivity, ownership status, and onboarding state.
//   • AC6 — a related discovered source that stays a governed-source gap is shown with reason, impact,
//     owner action, and its review-or-expiry deadline.
//
// THIS VIEW IS A PURE PRESENTER — it computes no relationships. `renderRelationshipView(props)` renders
// whatever `RelationshipViewModel` it is handed. That model is DERIVED elsewhere
// (tests/accessibility/support/relationship-view-model.ts) by running the REAL Phase-70 InventoryService
// (packages/application/src/inventory-service.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — and projecting its OWN `drillDown()` (source records,
// correlation fields, dependencies, authoritative fields), `currentStateView()` (row facets + withheld
// health), `catalogView()` (discovered-source facets), `componentGaps()` and `governedSourceGaps()`
// outputs into the graph/table/summary. Every value this view shows is a projection of a value the
// service COMPUTED — the presenter invents nothing.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React runtime yet
// and the repo's TypeScript base sets no `jsx` runtime — a JSX element would not compile. The accessible
// CONTRACT of this view is specifiable now: this module expresses it as a pure, deterministic renderer
// returning the exact accessible markup the shipped React view must reproduce. Because the output is a
// self-contained HTML string, the Phase-82 accessibility spec mounts it in a REAL browser via
// `page.setContent(renderRelationshipView(props))` and asserts — through axe-core and the live
// accessibility tree — every obligation, with NO web server, NO React, and NO tenant-auth.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no network,
// no module-level mutable state — same props ⇒ byte-identical output.

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

// ── Pinned execution identity (tenant scope) ───────────────────────────────────────────────────
//
// The relationship view is bound to exactly one governance bundle. Rendering the bundle id + semantic
// hash + work item as machine-readable, independently-readable DOM (a `<dl>` with data attributes, not a
// mutation-response echo) is the DURABLE IDENTITY witness the phase's effect-witness obligations require:
// a value observable through an independent read path, and REJECTABLE when it differs from the pinned
// input.

/** The one tenant scope this view is pinned to (work item ZD8RKQSG80ZQH9YWWBYFGHKS76). */
export const RELATIONSHIP_TENANT: TenantScope = {
  tenantId: 'tnt-acme-governance',
  tenantName: 'Acme Governance',
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: 'ZD8RKQSG80ZQH9YWWBYFGHKS76',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── The stable ids of the panels/regions (also DOM region ids) ──────────────────────────────────

export const RELATIONSHIP_VIEW_IDS = [
  'summary', // the material text summary (VO-057645e173b20b45c7cc)
  'graph', // the relationship graph (visual)
  'nodes', // the navigable node table (alternative)
  'edges', // the navigable edge table (alternative)
  'fields', // the navigable field-correlation table (status differences, AC3)
  'catalog', // related discovered-source catalog (AC5)
  'gaps', // related coverage / governed-source gaps (AC2/AC6)
] as const;
export type RelationshipViewId = (typeof RELATIONSHIP_VIEW_IDS)[number];

// ── Relationship-graph view models (render-ready reductions of the REAL service outputs) ─────────
//
// These shapes are produced by tests/accessibility/support/relationship-view-model.ts#deriveRelationship(),
// which runs the Phase-70 `InventoryService` and projects its `drillDown()` / `currentStateView()` /
// `catalogView()` / `componentGaps()` / `governedSourceGaps()` outputs into the panels below. Every field
// is a projection of a value the service COMPUTED — the presenter invents nothing.

/** The kind of a relationship-graph node. */
export type NodeKind = 'asset' | 'source_record' | 'gap';

/**
 * One node in the relationship graph. The central `asset` node carries the AC1 identity facets; each
 * `source_record` node is one distinct reporting source (AC3); a `gap` node is a still-visible coverage
 * gap related to the item (AC2). A node is NEVER dropped — a stale/unmanaged/gapped node stays visible.
 */
export interface RelationshipNodeVM {
  readonly id: string;
  readonly kind: NodeKind;
  /** Human label (asset name / source class + external key / gap subject). */
  readonly label: string;
  /** AC1 (asset) / AC5 (source) type or classification (`unknown` kept, never hidden). */
  readonly classification: string;
  /** AC1 owner (asset) or the source's role; "unowned (ownership gap)" when ownership is itself a gap. */
  readonly owner: string;
  /** AC1 lifecycle / onboarding state. */
  readonly state: string;
  /** AC1 risk tier (asset) or "—". */
  readonly risk: string;
  /** AC1 control coverage (asset) or "—". */
  readonly coverage: string;
  /** AC1 evidence state (current / stale / incomplete). */
  readonly evidenceState: string;
  /**
   * AC1/AC4 the health SAFE to report — WITHHELD as `unknown` when this node's evidence is stale. Current
   * health is never inferred from stale data.
   */
  readonly reportedHealth: string;
  /** The health last observed (retained for audit even when reported health is withheld). */
  readonly observedHealth: string;
  /** True iff this node's reported health was withheld because its evidence is not current (AC4). */
  readonly healthWithheld: boolean;
  /** AC1/AC4 last-observation ISO time for this node (the last-known witness). */
  readonly lastObservedAtIso: string;
  /** AC4 confidence ∈ [0,1] in this node's currency. */
  readonly confidence: number;
  /** AC1 unresolved-issue (open correlation case) count for the asset node; 0 for others. */
  readonly unresolvedIssues: number;
}

/** The kind of a relationship-graph edge. */
export type EdgeKind = 'depends_on' | 'authoritative_for';

/** One directed edge in the relationship graph (AC3 dependency / authoritative-field attribution). */
export interface RelationshipEdgeVM {
  readonly id: string;
  readonly kind: EdgeKind;
  /** The source node id this edge starts at. */
  readonly fromId: string;
  /** The target node id this edge ends at. */
  readonly toId: string;
  /** Human labels for the endpoints (so the edge table is readable without cross-referencing). */
  readonly fromLabel: string;
  readonly toLabel: string;
  /** The governed field this edge is about (e.g. `status`, `owner`). */
  readonly field: string;
}

/** One governed field's correlation across the item's sources (AC3 status differences). */
export interface FieldCorrelationVM {
  readonly field: string;
  /** The authoritative value the correlation resolved (or "unresolved"). */
  readonly authoritativeValue: string;
  /** The authoritative source class (system-of-record), or "—". */
  readonly authoritativeSourceClass: string;
  /** True iff two+ sources reported DIFFERENT values (a status difference). */
  readonly contested: boolean;
  /** True iff the field could not be resolved to a single safe value → automation paused. */
  readonly unresolved: boolean;
  /** Every source that reported this field (source class + value) — distinct records stay visible. */
  readonly contributingSources: readonly { readonly sourceClass: string; readonly value: string }[];
  /** The subset whose value DIFFERS from the resolved value (drives the "status differences" display). */
  readonly differingSources: readonly { readonly sourceClass: string; readonly value: string }[];
}

/** One related discovered source's catalog facets (AC5). */
export interface RelatedSourceVM {
  readonly id: string;
  readonly classification: string;
  readonly location: string;
  readonly accessStatus: string;
  readonly sensitivity: string;
  readonly ownershipStatus: string;
  readonly onboardingState: string;
  readonly discoveryEvidenceRef?: string;
}

/** One related coverage / governed-source gap that stays visible (AC2 component / AC6 governed source). */
export interface RelatedGapVM {
  readonly id: string;
  /** 'component' (AC2) or 'governed_source' (AC6). */
  readonly gapClass: string;
  readonly subject: string;
  readonly reasonClass: string;
  readonly reasonText: string;
  readonly impact: string;
  readonly ageDays: number;
  readonly ownerAction: string;
  /** AC6 review-or-expiry deadline text (governed-source gaps); "—" for component gaps. */
  readonly reviewOrExpiry: string;
  readonly hasReviewOrExpiry: boolean;
}

/** The whole relationship-view model — graph + table alternative + text-summary inputs + witness. */
export interface RelationshipViewModel {
  /** The central governed item's stable id + name (AC1). */
  readonly assetId: string;
  readonly assetName: string;
  /** Graph/table NODES: the asset + each distinct source record + any related gap node. */
  readonly nodes: readonly RelationshipNodeVM[];
  /** Graph/table EDGES: dependency + authoritative-field edges (AC3). */
  readonly edges: readonly RelationshipEdgeVM[];
  /** FIELD correlations (AC3 status differences). */
  readonly fields: readonly FieldCorrelationVM[];
  /** Related discovered sources (AC5). */
  readonly relatedSources: readonly RelatedSourceVM[];
  /** Related still-visible gaps (AC2 component / AC6 governed source). */
  readonly relatedGaps: readonly RelatedGapVM[];
  /** Count of distinct reporting source classes (AC3). */
  readonly distinctSourceCount: number;
  /** Count of dependency edges (AC3). */
  readonly dependencyCount: number;
  /** Count of authoritative-field attributions (AC3). */
  readonly authoritativeFieldCount: number;
  /** Count of contested fields (status differences; AC3). */
  readonly contestedFieldCount: number;
  /** True iff any contributing evidence for the central item is stale ⇒ health withheld (AC4). */
  readonly healthWithheld: boolean;
  /** The ISO instant this projection was derived at. */
  readonly generatedAtIso: string;
  /** The service's content digest at the current instant — an independent effect witness. */
  readonly snapshotDigest: string;
}

/**
 * An EMPTY-but-valid model. The view renders this only when none is injected; the graph/tables frame
 * their headers/captions but carry no rows, so an un-fed view CANNOT masquerade as a populated
 * relationship graph (every node/edge/field assertion fails against it).
 */
export const EMPTY_RELATIONSHIP: RelationshipViewModel = {
  assetId: '—',
  assetName: '—',
  nodes: [],
  edges: [],
  fields: [],
  relatedSources: [],
  relatedGaps: [],
  distinctSourceCount: 0,
  dependencyCount: 0,
  authoritativeFieldCount: 0,
  contestedFieldCount: 0,
  healthWithheld: false,
  generatedAtIso: RELATIONSHIP_TENANT.generatedAt,
  snapshotDigest: 'empty',
} as const;

// ── Props ──────────────────────────────────────────────────────────────────────────────────────

export interface RelationshipViewProps {
  readonly tenant: TenantScope;
  readonly model: RelationshipViewModel;
}

export const DEFAULT_RELATIONSHIP_PROPS: RelationshipViewProps = {
  tenant: RELATIONSHIP_TENANT,
  model: EMPTY_RELATIONSHIP,
} as const;

// ── The MATERIAL TEXT SUMMARY (VO-057645e173b20b45c7cc) ──────────────────────────────────────────
//
// A prose summary carrying the SAME MATERIAL INFORMATION as the graph: the item identity, the count of
// distinct reporting sources, the dependency + authoritative-field counts, the contested fields with
// their differing source values, whether any evidence is stale (health withheld), and the related gaps.
// The `aria-describedby` on the graph figure points here, so a screen reader hears the material facts
// before the (presentational) graph. Every quantity below is a field of the SAME model the tables read.

/** Build one human sentence naming a contested field and its differing source values (AC3). */
function contestedSentence(f: FieldCorrelationVM): string {
  const diffs = f.differingSources.map((d) => `${d.sourceClass}=${d.value}`).join(', ');
  const authority =
    f.authoritativeSourceClass === '—'
      ? 'no authoritative source'
      : `authoritative source ${f.authoritativeSourceClass} → ${f.authoritativeValue}`;
  return `Field “${f.field}” is contested (${authority}; differing: ${diffs || 'none'})${
    f.unresolved ? ' — UNRESOLVED, automation paused' : ''
  }.`;
}

function textSummary(m: RelationshipViewModel): string {
  const sourceNodes = m.nodes.filter((n) => n.kind === 'source_record');
  const contested = m.fields.filter((f) => f.contested);
  const parts: string[] = [];
  parts.push(
    `Item ${m.assetName} (id ${m.assetId}) is reported by ${m.distinctSourceCount} distinct source(s): ${
      sourceNodes.map((n) => n.label).join(', ') || 'none'
    }.`,
  );
  parts.push(
    `The relationship graph has ${m.nodes.length} node(s) and ${m.edges.length} edge(s): ${m.dependencyCount} dependency edge(s) and ${m.authoritativeFieldCount} authoritative-field attribution(s).`,
  );
  if (contested.length > 0) {
    parts.push(
      `${contested.length} governed field(s) show status differences across sources. ${contested
        .map(contestedSentence)
        .join(' ')}`,
    );
  } else {
    parts.push('No governed field shows a status difference across sources.');
  }
  if (m.healthWithheld) {
    const stale = m.nodes.find((n) => n.healthWithheld);
    parts.push(
      `At least one contributing source is STALE, so the item’s current health is WITHHELD as unknown (not inferred from stale data)${
        stale
          ? `; last known ${stale.lastObservedAtIso} at confidence ${stale.confidence.toFixed(2)}`
          : ''
      }.`,
    );
  } else {
    parts.push('All contributing evidence is current; health is not withheld for staleness.');
  }
  parts.push(
    `${m.relatedSources.length} related discovered source(s) and ${m.relatedGaps.length} still-visible coverage/governed-source gap(s) remain in scope; none is shown healthy or hidden.`,
  );
  return parts.join(' ');
}

// ── The relationship GRAPH (presentational; described by the text summary) ────────────────────────

function nodeGroup(n: RelationshipNodeVM): string {
  return `
        <li class="graph-node" data-testid="graph-node" data-node-id="${esc(n.id)}" data-node-kind="${esc(n.kind)}"
          data-health-withheld="${n.healthWithheld ? 'true' : 'false'}">
          <span class="graph-node-kind" data-testid="graph-node-kind">${esc(n.kind)}</span>
          <span class="graph-node-label" data-testid="graph-node-label">${esc(n.label)}</span>
          <span class="visually-hidden" data-testid="graph-node-detail">${esc(n.classification)}, state ${esc(
            n.state,
          )}, reported health ${esc(n.reportedHealth)}${
            n.healthWithheld ? ' (withheld as unknown — not read as current)' : ''
          }</span>
        </li>`;
}

function edgeItem(e: RelationshipEdgeVM): string {
  const verb = e.kind === 'depends_on' ? 'depends on' : 'is authoritative for';
  return `
        <li class="graph-edge" data-testid="graph-edge" data-edge-id="${esc(e.id)}" data-edge-kind="${esc(e.kind)}"
          data-from-id="${esc(e.fromId)}" data-to-id="${esc(e.toId)}" data-field="${esc(e.field)}">
          <span data-testid="graph-edge-text"><strong>${esc(e.fromLabel)}</strong> ${verb} <strong>${esc(
            e.toLabel,
          )}</strong> for field <code>${esc(e.field)}</code></span>
        </li>`;
}

function graphFigure(m: RelationshipViewModel): string {
  const body =
    m.nodes.length === 0
      ? `<p data-testid="graph-empty">No related nodes: this item has no reporting sources or edges yet.</p>`
      : `
        <ul class="graph-nodes" data-testid="graph-nodes" aria-label="Nodes">${m.nodes.map(nodeGroup).join('')}</ul>
        ${
          m.edges.length
            ? `<ul class="graph-edges" data-testid="graph-edges" aria-label="Edges">${m.edges.map(edgeItem).join('')}</ul>`
            : `<p data-testid="graph-no-edges">No edges: no dependency or authoritative-field relationship recorded.</p>`
        }`;
  return `
      <section id="region-graph" aria-labelledby="graph-h" data-testid="relationship-graph" tabindex="-1">
        <h2 id="graph-h">Relationship graph</h2>
        <figure role="group" aria-labelledby="graph-fig-h" aria-describedby="relationship-summary-text"
          data-testid="graph-figure">
          <figcaption id="graph-fig-h">
            Relationship graph for ${esc(m.assetName)} — a visual view. Its full material information is
            also available as the text summary above and the node / edge / field tables below.
          </figcaption>
          ${body}
        </figure>
      </section>`;
}

// ── The NAVIGABLE TABLES (the alternative that preserves the same material information) ────────────

function nodesTable(m: RelationshipViewModel): string {
  const rows = m.nodes
    .map(
      (n) => `
        <tr data-testid="node-row" data-node-id="${esc(n.id)}" data-node-kind="${esc(n.kind)}"
          data-reported-health="${esc(n.reportedHealth)}" data-observed-health="${esc(n.observedHealth)}"
          data-health-withheld="${n.healthWithheld ? 'true' : 'false'}">
          <th scope="row" data-testid="node-label">${esc(n.label)}</th>
          <td data-testid="node-kind">${esc(n.kind)}</td>
          <td data-testid="node-classification">${esc(n.classification)}</td>
          <td data-testid="node-owner">${esc(n.owner)}</td>
          <td data-testid="node-state">${esc(n.state)}</td>
          <td data-testid="node-risk">${esc(n.risk)}</td>
          <td data-testid="node-coverage">${esc(n.coverage)}</td>
          <td data-testid="node-evidence-state">${esc(n.evidenceState)}</td>
          <td data-testid="node-reported-health" data-reported-health="${esc(n.reportedHealth)}">${esc(
            n.reportedHealth,
          )}${
            n.healthWithheld
              ? ` <span class="visually-hidden" data-testid="node-withheld-note">(withheld as unknown; last observed health ${esc(
                  n.observedHealth,
                )} — not read as current)</span>`
              : ''
          }</td>
          <td><time datetime="${esc(n.lastObservedAtIso)}" data-testid="node-last-observed">${esc(
            n.lastObservedAtIso,
          )}</time></td>
          <td data-testid="node-confidence">${n.confidence.toFixed(2)}</td>
          <td data-testid="node-unresolved">${n.unresolvedIssues}</td>
        </tr>`,
    )
    .join('');
  const body =
    m.nodes.length === 0
      ? `<p data-testid="nodes-empty">No nodes.</p>`
      : `<table aria-describedby="nodes-summary" data-testid="nodes-table">
          <caption>Relationship nodes — the same nodes shown in the graph (label, kind, type/classification, owner, state, risk, coverage, evidence, reported health, last observed, confidence, unresolved issues)</caption>
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">Kind</th>
              <th scope="col">Type / classification</th>
              <th scope="col">Owner</th>
              <th scope="col">State</th>
              <th scope="col">Risk</th>
              <th scope="col">Coverage</th>
              <th scope="col">Evidence state</th>
              <th scope="col">Reported health</th>
              <th scope="col">Last observed</th>
              <th scope="col">Confidence</th>
              <th scope="col">Unresolved issues</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-nodes" aria-labelledby="nodes-h" data-testid="relationship-nodes" tabindex="-1">
        <h2 id="nodes-h">Nodes (navigable table)</h2>
        <p id="nodes-summary" data-testid="nodes-summary" data-node-count="${m.nodes.length}">
          ${m.nodes.length} node(s) — the tabular alternative to the relationship graph; every graph node is a row here.
        </p>
        ${body}
      </section>`;
}

function edgesTable(m: RelationshipViewModel): string {
  const rows = m.edges
    .map(
      (e) => `
        <tr data-testid="edge-row" data-edge-id="${esc(e.id)}" data-edge-kind="${esc(e.kind)}"
          data-from-id="${esc(e.fromId)}" data-to-id="${esc(e.toId)}" data-field="${esc(e.field)}">
          <th scope="row" data-testid="edge-from">${esc(e.fromLabel)}</th>
          <td data-testid="edge-kind">${esc(e.kind)}</td>
          <td data-testid="edge-to">${esc(e.toLabel)}</td>
          <td data-testid="edge-field"><code>${esc(e.field)}</code></td>
        </tr>`,
    )
    .join('');
  const body =
    m.edges.length === 0
      ? `<p data-testid="edges-empty">No dependency or authoritative-field edges recorded for this item.</p>`
      : `<table aria-describedby="edges-summary" data-testid="edges-table">
          <caption>Relationship edges — the same edges drawn in the graph (from, relationship, to, field)</caption>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">Relationship</th>
              <th scope="col">To</th>
              <th scope="col">Field</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-edges" aria-labelledby="edges-h" data-testid="relationship-edges" tabindex="-1">
        <h2 id="edges-h">Edges (navigable table)</h2>
        <p id="edges-summary" data-testid="edges-summary" data-edge-count="${m.edges.length}"
          data-dependency-count="${m.dependencyCount}" data-authoritative-count="${m.authoritativeFieldCount}">
          ${m.edges.length} edge(s): ${m.dependencyCount} dependency, ${m.authoritativeFieldCount} authoritative-field — the tabular alternative to the graph's edges.
        </p>
        ${body}
      </section>`;
}

function fieldsTable(m: RelationshipViewModel): string {
  const rows = m.fields
    .map(
      (f) => `
        <tr data-testid="field-row" data-field="${esc(f.field)}" data-contested="${f.contested ? 'true' : 'false'}"
          data-unresolved="${f.unresolved ? 'true' : 'false'}" data-differing-count="${f.differingSources.length}">
          <th scope="row" data-testid="field-name"><code>${esc(f.field)}</code></th>
          <td data-testid="field-authoritative-value">${esc(f.authoritativeValue)}</td>
          <td data-testid="field-authoritative-source">${esc(f.authoritativeSourceClass)}</td>
          <td data-testid="field-contested">${
            f.contested
              ? `<strong data-testid="field-contested-flag">status difference</strong>`
              : 'agreed'
          }</td>
          <td data-testid="field-differing">
            <ul class="differing" data-testid="field-differing-list">${f.differingSources
              .map(
                (d) => `
              <li data-testid="field-differing-source" data-source-class="${esc(d.sourceClass)}">
                <span data-testid="field-differing-class">${esc(d.sourceClass)}</span> reported
                <strong data-testid="field-differing-value">${esc(d.value)}</strong>
              </li>`,
              )
              .join('')}
            </ul>
          </td>
          <td data-testid="field-automation" data-unresolved="${f.unresolved ? 'true' : 'false'}">${
            f.unresolved
              ? 'PAUSED — unresolved'
              : f.contested
                ? 'contested — awaiting reconcile'
                : 'ok'
          }</td>
        </tr>`,
    )
    .join('');
  const body =
    m.fields.length === 0
      ? `<p data-testid="fields-empty">No governed fields correlated for this item.</p>`
      : `<table aria-describedby="fields-summary" data-testid="fields-table">
          <caption>Governed-field correlation — the status differences across sources (field, authoritative value, authoritative source, contested, differing sources, automation)</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Authoritative value</th>
              <th scope="col">Authoritative source</th>
              <th scope="col">Contested</th>
              <th scope="col">Differing sources (status differences)</th>
              <th scope="col">Automation</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-fields" aria-labelledby="fields-h" data-testid="relationship-fields" tabindex="-1">
        <h2 id="fields-h">Field correlation &amp; status differences (navigable table)</h2>
        <p id="fields-summary" data-testid="fields-summary" data-field-count="${m.fields.length}"
          data-contested-count="${m.contestedFieldCount}">
          ${m.fields.length} governed field(s); ${m.contestedFieldCount} contested (status differences across sources).
        </p>
        ${body}
      </section>`;
}

// ── AC5 — related discovered sources (catalog facets) ─────────────────────────────────────────────

function catalogSection(m: RelationshipViewModel): string {
  const rows = m.relatedSources
    .map(
      (s) => `
        <tr data-testid="related-source-row" data-source-id="${esc(s.id)}">
          <th scope="row" data-testid="related-source-id">${esc(s.id)}</th>
          <td data-testid="related-source-classification">${esc(s.classification)}</td>
          <td data-testid="related-source-location">${esc(s.location)}</td>
          <td data-testid="related-source-access">${esc(s.accessStatus)}</td>
          <td data-testid="related-source-sensitivity">${esc(s.sensitivity)}</td>
          <td data-testid="related-source-ownership">${esc(s.ownershipStatus)}</td>
          <td data-testid="related-source-onboarding">${esc(s.onboardingState)}</td>
          <td data-testid="related-source-evidence">${
            s.discoveryEvidenceRef
              ? `<a href="#${esc(s.discoveryEvidenceRef)}">${esc(s.discoveryEvidenceRef)}</a>`
              : '<span data-testid="related-source-no-evidence">no discovery evidence</span>'
          }</td>
        </tr>`,
    )
    .join('');
  const body =
    m.relatedSources.length === 0
      ? `<p data-testid="catalog-empty">No related discovered sources in scope.</p>`
      : `<table aria-describedby="catalog-summary" data-testid="related-sources-table">
          <caption>Related discovered sources in the catalog (id, classification, location, access, sensitivity, ownership, onboarding, discovery evidence)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Classification</th>
              <th scope="col">Location</th>
              <th scope="col">Access</th>
              <th scope="col">Sensitivity</th>
              <th scope="col">Ownership</th>
              <th scope="col">Onboarding</th>
              <th scope="col">Discovery evidence</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-catalog" aria-labelledby="catalog-h" data-testid="relationship-catalog" tabindex="-1">
        <h2 id="catalog-h">Related discovered sources (catalog)</h2>
        <p id="catalog-summary" data-testid="catalog-summary" data-source-count="${m.relatedSources.length}">
          ${m.relatedSources.length} related discovered source(s) with their catalog facets.
        </p>
        ${body}
      </section>`;
}

// ── AC2 / AC6 — related gaps that stay visible ────────────────────────────────────────────────────

function gapsSection(m: RelationshipViewModel): string {
  const rows = m.relatedGaps
    .map(
      (g) => `
        <tr data-testid="related-gap-row" data-gap-id="${esc(g.id)}" data-gap-class="${esc(g.gapClass)}"
          data-reason="${esc(g.reasonClass)}" data-impact="${esc(g.impact)}" data-age-days="${g.ageDays}"
          data-has-review="${g.hasReviewOrExpiry ? 'true' : 'false'}">
          <th scope="row" data-testid="related-gap-subject">${esc(g.subject)}</th>
          <td data-testid="related-gap-class">${esc(g.gapClass)}</td>
          <td data-testid="related-gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td data-testid="related-gap-impact">${esc(g.impact)}</td>
          <td>${g.ageDays} day(s)</td>
          <td data-testid="related-gap-owner-action">${esc(g.ownerAction)}</td>
          <td data-testid="related-gap-review">${esc(g.reviewOrExpiry)}</td>
        </tr>`,
    )
    .join('');
  const body =
    m.relatedGaps.length === 0
      ? `<p data-testid="gaps-empty">No related coverage or governed-source gaps outstanding for this item.</p>`
      : `<table aria-describedby="gaps-summary" data-testid="related-gaps-table">
          <caption>Related coverage / governed-source gaps that stay visible (subject, class, reason, impact, age, required owner action, review/expiry)</caption>
          <thead>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">Class</th>
              <th scope="col">Reason</th>
              <th scope="col">Impact</th>
              <th scope="col">Age</th>
              <th scope="col">Required owner action</th>
              <th scope="col">Review / expiry</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-gaps" aria-labelledby="gaps-h" data-testid="relationship-gaps" tabindex="-1">
        <h2 id="gaps-h">Related gaps (stay visible)</h2>
        <p id="gaps-summary" data-testid="gaps-summary" data-gap-count="${m.relatedGaps.length}">
          ${m.relatedGaps.length} related gap(s) — each stays visible with its reason, age, impact, owner action and (for governed sources) review/expiry.
        </p>
        ${body}
      </section>`;
}

// ── The text-summary region ───────────────────────────────────────────────────────────────────────

function summarySection(m: RelationshipViewModel): string {
  return `
      <section id="region-summary" aria-labelledby="summary-h" data-testid="relationship-summary" tabindex="-1">
        <h2 id="summary-h">Relationship summary</h2>
        <p id="relationship-summary-text" data-testid="relationship-summary-text"
          data-distinct-sources="${m.distinctSourceCount}" data-dependency-count="${m.dependencyCount}"
          data-authoritative-count="${m.authoritativeFieldCount}" data-contested-count="${m.contestedFieldCount}"
          data-health-withheld="${m.healthWithheld ? 'true' : 'false'}">
          ${esc(textSummary(m))}
        </p>
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

/** The in-page navigation across the panels (each an anchor to its region). */
function viewNav(): string {
  const labels: Readonly<Record<RelationshipViewId, string>> = {
    summary: 'Summary',
    graph: 'Graph',
    nodes: 'Nodes table',
    edges: 'Edges table',
    fields: 'Field correlation',
    catalog: 'Related sources',
    gaps: 'Related gaps',
  };
  const items = RELATIONSHIP_VIEW_IDS.map(
    (v) => `<li><a href="#region-${v}" data-testid="rel-nav-${v}">${esc(labels[v])}</a></li>`,
  ).join('');
  return `
      <nav aria-labelledby="rel-nav-h" data-testid="rel-nav">
        <h2 id="rel-nav-h" class="visually-hidden">Relationship view panels</h2>
        <ul>${items}</ul>
      </nav>`;
}

// ── The view ───────────────────────────────────────────────────────────────────────────────────

/**
 * Render the complete accessible RELATIONSHIP VIEW as a standalone HTML document, PRESENTING the injected
 * `props.model` as THREE equivalent presentations of the same material information — a graph, a set of
 * navigable tables, and a text summary. Mounted in-browser via `page.setContent(renderRelationshipView(props))`.
 * Single-column and wrapping (no fixed pixel widths that force horizontal scroll at 400% zoom), with a
 * visible focus indicator so keyboard focus is never invisible.
 *
 * Order: skip link → tenant-scope banner → global status → in-page nav → `<main>` framing the text
 * summary, the graph, the nodes / edges / field-correlation tables, the related-sources catalog, and the
 * related gaps.
 */
export function renderRelationshipView(
  props: RelationshipViewProps = DEFAULT_RELATIONSHIP_PROPS,
): string {
  const { tenant } = props;
  const m = props.model;
  const statusText = `Relationship view for ${m.assetName}: ${m.distinctSourceCount} distinct source(s), ${m.edges.length} edge(s), ${m.contestedFieldCount} contested field(s), ${m.relatedGaps.length} related gap(s). ${
    m.healthWithheld
      ? 'Current health is withheld as unknown for at least one stale source; stale data is not read as current.'
      : 'All contributing evidence is current.'
  } The graph, tables, and summary carry the same material information.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} relationship view</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 1rem;
      font: 16px/1.5 system-ui, sans-serif;
      color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word;
    }
    header, nav, main, footer, section, div, figure { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    figure { margin: 0; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; margin: .5rem 0 1rem; }
    th, td { border: 1px solid #767676; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; vertical-align: top; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .row, .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
    ul.graph-nodes, ul.graph-edges { list-style: none; margin: .5rem 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    ul.graph-nodes li, ul.graph-edges li { border: 1px solid #767676; padding: .35rem .5rem; }
    .graph-node-kind { font-weight: 600; margin-right: .5rem; }
    ul.differing { margin: 0; padding-left: 1.1rem; }
    ul.differing li { margin: .15rem 0; }
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
    <h1 data-testid="relationship-title">${esc(tenant.tenantName)} — relationship view: ${esc(m.assetName)}</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(statusText)}</span>
    </div>
    ${viewNav()}
  </header>
  <main id="main" tabindex="-1" data-testid="relationship-main" data-role="operator"
    data-asset-id="${esc(m.assetId)}" data-node-count="${m.nodes.length}" data-edge-count="${m.edges.length}"
    data-distinct-sources="${m.distinctSourceCount}" data-contested-count="${m.contestedFieldCount}"
    data-health-withheld="${m.healthWithheld ? 'true' : 'false'}" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${summarySection(m)}
    ${graphFigure(m)}
    ${nodesTable(m)}
    ${edgesTable(m)}
    ${fieldsTable(m)}
    ${catalogSection(m)}
    ${gapsSection(m)}
  </main>
  <footer>
    <p data-testid="relationship-footer">
      Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · relationship graph, navigable tables, and text summary of the same material information.
    </p>
  </footer>
</body>
</html>`;
}

/**
 * Default export: the relationship-view renderer. The accessible contract is `renderRelationshipView`; a
 * framework adopter wraps it and injects a derived `model` (the relationship graph for one item).
 */
export default renderRelationshipView;
