// TrustCircleAI — Phase 82 RELATIONSHIP-VIEW derivation.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item ZD8RKQSG80ZQH9YWWBYFGHKS76.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The Phase-82 view (apps/web/src/features/inventory/RelationshipView.tsx) is a PURE PRESENTER:
// `renderRelationshipView(props)` renders whatever `RelationshipViewModel` it is handed. This module is
// where that model is EARNED — it is DERIVED by running the REAL Phase-70 current-inventory assembly
// service (packages/application/src/inventory-service.ts) over a deterministic scenario, then projecting
// the service's OWN outputs into the relationship GRAPH, its NAVIGABLE TABLE alternative, and its MATERIAL
// TEXT SUMMARY — the three presentations VO-057645e173b20b45c7cc requires to carry the same information:
//
//   • NODES  — the central `GovernedAsset` (AC1 facets from `currentStateView()` / `rowFor()`) plus each
//     DISTINCT `SourceRecord` the service correlated (`drillDown().sourceRecords`, AC3), plus a `gap`
//     node for any still-visible component gap bound to the item (AC2). Health is the service's
//     `reportedHealth` — WITHHELD as `unknown` when evidence is stale (AC4); observed health retained.
//   • EDGES  — the service's `drillDown().dependencies` (`depends_on`) and `.authoritativeFields`
//     (`authoritative_for`), mapped onto the node ids (AC3).
//   • FIELDS — the service's `drillDown().correlation.fields` (`FieldResolution`): each field's
//     authoritative value + source, whether it is `contested` (a status difference), and its
//     `differingSources` (AC3).
//   • RELATED SOURCES — the service's `catalogView()` discovered-source facets (AC5).
//   • RELATED GAPS — the service's `componentGaps()` (AC2) and `governedSourceGaps()` (AC6), each kept
//     visible with reason / age / impact / owner action (and, for governed sources, review-or-expiry).
//
// The scenario is the SHARED Phase-77 scenario (support/current-state-model.ts#buildService): the healthy
// multi-source asset (three distinct sources; a contested `status` field drives the status-difference
// display), the stale asset (drives the withheld-health path), the gapped component (AC2), the discovered
// source (AC5), and the sensitive governed-source gap (AC6). Nothing is a fixture the view reads directly
// — the tests read the service back.
//
// The accessibility spec builds this scenario, mutates its INPUT for each RED negative control (collapse
// to a single source, force the stale record fresh, drop the component gap, strip discovery evidence,
// drop the governed-gap review), re-derives through the real service, and asserts the VIEW's rendered
// DOM — graph, tables, AND summary — reflects the service's independently-computed output. Expectations
// come from the service, not from view literals — the oracle cannot be satisfied by a static template.
//
// DETERMINISM. No wall clock, no randomness: the scenario reuses the seeded UUIDv7 factory and explicit
// epoch-millis; the read instant is explicit. Same scenario ⇒ byte-stable model ⇒ byte-stable render.

import type { EpochMillis, Uuid } from '../../../packages/domain/src/primitives.ts';
import {
  gapAgeMillis,
  gapHasReviewOrExpiry,
  type CoverageGap,
  type GapReason,
} from '../../../packages/domain/src/inventory.ts';
import {
  InventoryService,
  type InventoryRow,
  type InventoryDrillDown,
} from '../../../packages/application/src/inventory-service.ts';

import {
  buildService,
  deriveModel,
  SCENARIO_IDS,
  idOf,
  T0,
  at,
  HORIZON_MILLIS,
  type ScenarioOverrides,
} from './current-state-model.ts';

import type {
  RelationshipViewModel,
  RelationshipNodeVM,
  RelationshipEdgeVM,
  FieldCorrelationVM,
  RelatedSourceVM,
  RelatedGapVM,
} from '../../../apps/web/src/features/inventory/RelationshipView.tsx';

// ── Re-export the shared scenario knobs so specs drive shared RED controls through one import ─────
export { buildService, SCENARIO_IDS, idOf, T0, at, HORIZON_MILLIS };
export type { ScenarioOverrides };

const DAY_MS = 24 * 60 * 60_000;

/**
 * The Phase-82 RED knobs are exactly the SHARED current-state overrides — each already breaks the
 * relationship-view drill-down at the INPUT: `singleSourceOnly` collapses AC3 (one source ⇒ no depends_on
 * edge, no contested field), `forceStaleRecordFresh` un-withholds AC4 health, `dropComponentGap` removes
 * the AC2 gap node, `dropDiscoveryEvidence` strips the AC5 evidence link, `dropGovernedGapReview` removes
 * the AC6 governed-source gap. No new knobs are needed; the relationship view reads the same service.
 */
export type RelationshipScenarioOverrides = ScenarioOverrides;

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

function isoOf(ms: EpochMillis | undefined): string {
  return ms === undefined ? '—' : new Date(ms).toISOString();
}

function valueText(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function gapReasonText(reason: GapReason): string {
  const map: Readonly<Record<GapReason, string>> = {
    unmanaged: 'Discovered but never onboarded to a governed source contract.',
    unreachable: 'The connector has missed consecutive health probes.',
    stale: 'The source has not been observed within the freshness horizon.',
    orphaned: 'Evidence exists but the owning asset was removed upstream.',
    excluded: 'Explicitly excluded by an approved scope decision.',
    unsupported: 'No adapter supports this source type yet.',
    inaccessible: 'Access is withheld; the source cannot be reached.',
    sensitive: 'Contains restricted data; access is withheld pending review.',
    unowned: 'No accountable owner has been assigned.',
  };
  return map[reason];
}

/** A stable, human label for a source-record node (source class + external key). */
function sourceRecordLabel(sourceClass: string, externalKey: string): string {
  return `${sourceClass} · ${externalKey}`;
}

// ── Node projections ──────────────────────────────────────────────────────────────────────────────

/** The central governed-asset node (AC1 facets, AC4 withheld health) from the service's row. */
function assetNode(row: InventoryRow, svc: InventoryService, now: EpochMillis): RelationshipNodeVM {
  const lastIso =
    isoOf(row.lastObservationAt) === '—'
      ? isoOf(svc.rowFor(row.assetId, now).lastObservationAt)
      : isoOf(row.lastObservationAt);
  return {
    id: String(row.assetId),
    kind: 'asset',
    label: row.name,
    classification: row.assetType,
    owner: row.ownershipGap ? 'unowned (ownership gap)' : String(row.ownerPrincipalId ?? 'unowned'),
    state: row.lifecycleState,
    risk: row.riskTier,
    coverage: row.hasVisibleComponentGap ? 'gap (open component gap)' : row.coverage,
    evidenceState: row.evidenceState,
    reportedHealth: row.reportedHealth,
    observedHealth: row.observedHealth,
    healthWithheld: row.reportedHealth === 'unknown' && row.observedHealth !== 'unknown',
    lastObservedAtIso: lastIso,
    confidence: row.confidence,
    unresolvedIssues: row.unresolvedIssueCount,
  };
}

/** One distinct source-record node (AC3) keyed by its catalogId (the edge endpoint identity). */
function sourceRecordNode(
  dd: InventoryDrillDown,
  r: InventoryDrillDown['sourceRecords'][number],
): RelationshipNodeVM {
  const state = String((r.observedState as Record<string, unknown>)['status'] ?? r.status);
  const isStale = r.freshness !== 'fresh';
  return {
    id: String(r.catalogId),
    kind: 'source_record',
    label: sourceRecordLabel(r.sourceClass, r.externalKey),
    classification: r.sourceClass,
    owner: valueText((r.observedState as Record<string, unknown>)['owner']),
    state,
    risk: '—',
    coverage: '—',
    evidenceState: isStale ? 'stale' : 'current',
    // A source record does not carry an asset-health facet; report its freshness honestly and withhold a
    // "current" reading when the record is stale (AC4) — never infer health from a stale record.
    reportedHealth: isStale ? 'unknown' : 'reported',
    observedHealth: isStale ? 'reported' : 'reported',
    healthWithheld: isStale,
    lastObservedAtIso: isoOf(r.lastKnownAt),
    confidence: r.confidence,
    unresolvedIssues: 0,
  };
}

/** A still-visible component-gap node (AC2) — a related component that is not healthy. */
function gapNode(gap: CoverageGap): RelationshipNodeVM {
  return {
    id: String(gap.id),
    kind: 'gap',
    label: componentSubject(gap),
    classification: `coverage gap (${gap.reason})`,
    owner: gap.requiredOwner ? String(gap.requiredOwner) : 'unowned (ownership gap)',
    state: gap.status,
    risk: '—',
    coverage: 'gap',
    evidenceState: 'incomplete',
    reportedHealth: 'unknown',
    observedHealth: 'unmanaged',
    healthWithheld: false,
    lastObservedAtIso: isoOf(gap.firstSeenAt),
    confidence: 0,
    unresolvedIssues: 0,
  };
}

function componentSubject(gap: CoverageGap): string {
  if (String(gap.subjectId) === String(SCENARIO_IDS.gappedAsset)) return 'shadow-inference-svc';
  return `component/${String(gap.subjectId ?? gap.id)}`;
}

// ── Edge projections (AC3) ──────────────────────────────────────────────────────────────────────

function edges(dd: InventoryDrillDown, labelOf: (id: string) => string): RelationshipEdgeVM[] {
  const out: RelationshipEdgeVM[] = [];
  for (const d of dd.dependencies) {
    out.push({
      id: String(d.relationshipId),
      kind: 'depends_on',
      fromId: String(d.fromId),
      toId: String(d.toId),
      fromLabel: labelOf(String(d.fromId)),
      toLabel: labelOf(String(d.toId)),
      field: d.fieldName,
    });
  }
  for (const a of dd.authoritativeFields) {
    out.push({
      id: String(a.relationshipId),
      kind: 'authoritative_for',
      fromId: String(a.authoritativeSourceId),
      toId: String(dd.assetId),
      fromLabel: labelOf(String(a.authoritativeSourceId)),
      toLabel: labelOf(String(dd.assetId)),
      field: a.field,
    });
  }
  return out;
}

// ── Field-correlation projections (AC3 status differences) ─────────────────────────────────────────

function fieldCorrelations(dd: InventoryDrillDown): FieldCorrelationVM[] {
  return dd.correlation.fields.map((f): FieldCorrelationVM => {
    const unresolved = f.resolution !== 'resolved';
    return {
      field: f.field,
      authoritativeValue: unresolved ? 'unresolved' : valueText(f.value),
      authoritativeSourceClass: f.authoritativeSourceClass ?? '—',
      contested: f.contested,
      unresolved,
      contributingSources: f.contributingSources.map((c) => ({
        sourceClass: c.sourceClass,
        value: valueText(c.value),
      })),
      differingSources: f.differingSources.map((c) => ({
        sourceClass: c.sourceClass,
        value: valueText(c.value),
      })),
    };
  });
}

// ── Related-source projections (AC5) ────────────────────────────────────────────────────────────

function relatedSources(svc: InventoryService): RelatedSourceVM[] {
  return svc.catalogView().map((c) => ({
    id: String(c.catalogId),
    classification: c.classifiedUnknown ? 'unknown' : c.sourceClass,
    location: c.observedLocations.join(', '),
    accessStatus: c.accessState,
    sensitivity: c.sensitivity,
    ownershipStatus: c.ownershipGap ? 'unowned (ownership gap)' : String(c.ownerPrincipalId),
    onboardingState: c.onboardingState,
    discoveryEvidenceRef: c.discoveryEvidence ? String(c.discoveryEvidence) : undefined,
  }));
}

// ── Related-gap projections (AC2 component + AC6 governed source) ──────────────────────────────────

function relatedGapVM(gap: CoverageGap, now: EpochMillis): RelatedGapVM {
  const review = isoOf(gap.reviewAt);
  const expiry = isoOf(gap.expiresAt);
  const reviewOrExpiry =
    review !== '—'
      ? `review by ${review}`
      : expiry !== '—'
        ? `expires ${expiry}`
        : gap.gapClass === 'governed_source'
          ? 'no review or expiry recorded'
          : '—';
  const subject =
    gap.gapClass === 'component'
      ? componentSubject(gap)
      : `source/${String(gap.subjectId ?? gap.id)}`;
  return {
    id: String(gap.id),
    gapClass: gap.gapClass,
    subject,
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    impact: gap.impact,
    ageDays: Math.floor(gapAgeMillis(gap, now) / DAY_MS),
    ownerAction: gap.requiredAction,
    reviewOrExpiry,
    hasReviewOrExpiry: gapHasReviewOrExpiry(gap),
  };
}

function relatedGaps(svc: InventoryService, now: EpochMillis): RelatedGapVM[] {
  const component = svc.componentGaps().map((g) => relatedGapVM(g, now));
  const governed = svc.governedSourceGaps().map((g) => relatedGapVM(g, now));
  return [...component, ...governed];
}

/** The still-VISIBLE component coverage gaps whose subject is `assetId` (AC2 gap nodes). */
function visibleComponentGapsFor(svc: InventoryService, assetId: Uuid): readonly CoverageGap[] {
  return svc.componentGaps().filter((g) => String(g.subjectId) === String(assetId));
}

// ── The public derivation ────────────────────────────────────────────────────────────────────────

/**
 * DERIVE the relationship-view model for the central healthy multi-source asset from the REAL service at
 * instant `now`. Every field is a projection of a value the service COMPUTED via `drillDown()` /
 * `currentStateView()` / `rowFor()` / `catalogView()` / `componentGaps()` / `governedSourceGaps()`.
 */
export function deriveRelationship(
  overrides: RelationshipScenarioOverrides = {},
  now: EpochMillis = T0,
): RelationshipViewModel {
  const svc = buildService(overrides);
  // Force a full derivation of the shell model too, so the digest/scenario matches sibling views.
  deriveModel(svc, now);

  const assetId = SCENARIO_IDS.healthyAsset;
  const dd = svc.drillDown(assetId, now);
  const row = svc.rowFor(assetId, now);

  // Node label lookup: asset id → name; source-record catalogId → source-record label.
  const labelById = new Map<string, string>();
  labelById.set(String(assetId), dd.asset?.name ?? String(assetId));
  for (const r of dd.sourceRecords) {
    labelById.set(String(r.catalogId), sourceRecordLabel(r.sourceClass, r.externalKey));
  }
  const labelOf = (id: string): string => labelById.get(id) ?? id;

  const nodes: RelationshipNodeVM[] = [assetNode(row, svc, now)];
  for (const r of dd.sourceRecords) nodes.push(sourceRecordNode(dd, r));
  // AC2: a component gap bound to this drilled item stays a visible gap node.
  for (const g of visibleComponentGapsFor(svc, assetId)) nodes.push(gapNode(g));

  const edgeVMs = edges(dd, labelOf);
  const fields = fieldCorrelations(dd);
  const sources = relatedSources(svc);
  const gaps = relatedGaps(svc, now);

  const distinctSourceCount = new Set(dd.sourceRecords.map((r) => r.sourceClass)).size;
  const contestedFieldCount = fields.filter((f) => f.contested).length;
  const assetHealthWithheld = nodes.some((n) => n.kind === 'asset' && n.healthWithheld);

  return {
    assetId: String(assetId),
    assetName: dd.asset?.name ?? String(assetId),
    nodes,
    edges: edgeVMs,
    fields,
    relatedSources: sources,
    relatedGaps: gaps,
    distinctSourceCount,
    dependencyCount: dd.dependencies.length,
    authoritativeFieldCount: dd.authoritativeFields.length,
    contestedFieldCount,
    healthWithheld: assetHealthWithheld,
    generatedAtIso: new Date(now).toISOString(),
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Convenience: the default (no-override) relationship view at T0. */
export function defaultRelationship(now: EpochMillis = T0): RelationshipViewModel {
  return deriveRelationship({}, now);
}

/**
 * DERIVE the relationship view for the STALE asset instead — the AC4 witness. Its contributing record is
 * stale, so the asset node's reported health is WITHHELD as unknown (health not inferred from stale data).
 */
export function deriveStaleRelationship(
  overrides: RelationshipScenarioOverrides = {},
  now: EpochMillis = T0,
): RelationshipViewModel {
  const base = deriveRelationship(overrides, now);
  const svc = buildService(overrides);
  deriveModel(svc, now);
  const assetId = SCENARIO_IDS.staleAsset;
  const dd = svc.drillDown(assetId, now);
  const row = svc.rowFor(assetId, now);

  const labelById = new Map<string, string>();
  labelById.set(String(assetId), dd.asset?.name ?? String(assetId));
  for (const r of dd.sourceRecords) {
    labelById.set(String(r.catalogId), sourceRecordLabel(r.sourceClass, r.externalKey));
  }
  const labelOf = (id: string): string => labelById.get(id) ?? id;

  const nodes: RelationshipNodeVM[] = [assetNode(row, svc, now)];
  for (const r of dd.sourceRecords) nodes.push(sourceRecordNode(dd, r));
  for (const g of visibleComponentGapsFor(svc, assetId)) nodes.push(gapNode(g));

  const fields = fieldCorrelations(dd);
  return {
    ...base,
    assetId: String(assetId),
    assetName: dd.asset?.name ?? String(assetId),
    nodes,
    edges: edges(dd, labelOf),
    fields,
    distinctSourceCount: new Set(dd.sourceRecords.map((r) => r.sourceClass)).size,
    dependencyCount: dd.dependencies.length,
    authoritativeFieldCount: dd.authoritativeFields.length,
    contestedFieldCount: fields.filter((f) => f.contested).length,
    healthWithheld: nodes.some((n) => n.kind === 'asset' && n.healthWithheld),
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Re-export the row type for specs that read the service directly. */
export type { InventoryRow };
