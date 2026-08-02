// TrustCircleAI — Phase 81 COVERAGE / GOVERNED-SOURCE GAP derivation.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item JK8KW3GR9WQHKGEAHJ53X75MC3.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The Phase-81 view (apps/web/src/features/gaps/CoverageGaps.tsx) is a PURE PRESENTER:
// `renderCoverageGaps(props)` renders whatever `CoverageGapsModel` it is handed. This module is where
// that model is EARNED — it is DERIVED by running the REAL Phase-70 current-inventory assembly service
// (packages/application/src/inventory-service.ts) against a deterministic scenario, then projecting the
// service's OWN `componentGaps()` / `governedSourceGaps()` / `catalogView()` / `drillDown()` /
// `currentStateView()` outputs into the SEVEN operator gap views:
//
//   • OWNERSHIP / ACCESS / UNSUPPORTED / EXCLUSION / SCAN-GAP — each governed-source gap is the
//     SERVICE's `governedSourceGaps()` entry (kept visible ONLY while it carries a review-or-expiry
//     deadline), enriched with the discovered source's `catalogView()` facets (classification,
//     location, access, sensitivity, ownership, onboarding, discovery evidence — AC5). Component gaps
//     are the SERVICE's `componentGaps()` entries (AC2), partitioned to their view by reason.
//   • CONFLICT — derived from the SERVICE's `drillDown().correlation.fields` (`FieldResolution`): a
//     field with `contested === true` lists its `differingSources` (the status differences, AC3) and
//     names the `authoritativeSourceClass`. Automation is PAUSED iff the correlation could not settle
//     a single value.
//   • FRESHNESS — the SERVICE's `currentStateView()` rows whose evidence is not current: the
//     `reportedHealth` is `unknown` because the service REFUSES to infer it (AC4), shown with the
//     record's last-known time and confidence.
//
// The scenario STARTS from the shared Phase-77 scenario (support/current-state-model.ts#buildService)
// — the healthy multi-source asset (its contested `status` field drives the CONFLICT view), the stale
// asset (drives the FRESHNESS view), the gapped component (AC2), and the sensitive discovered source —
// and ENRICHES it with one discovered source + governed-source gap per remaining category (ownership /
// access / unsupported / exclusion / scan-gap), each carrying a review deadline so the service keeps it
// visible. Every enrichment is ingested through the REAL service; nothing is a fixture the view reads
// directly — the tests read the service back.
//
// The accessibility spec builds this scenario, mutates its INPUT for each RED negative control (drop a
// category's gap, drop a review deadline, force the stale record fresh, collapse the conflict to a
// single source, strip discovery evidence), re-derives through the real service, and asserts the VIEW's
// rendered DOM reflects the service's independently-computed output. Expectations come from the
// service, not from view literals — the oracle cannot be satisfied by a static template.
//
// DETERMINISM. No wall clock, no randomness: the scenario reuses the seeded UUIDv7 factory and explicit
// epoch-millis; the read instant is explicit. Same scenario ⇒ byte-stable model ⇒ byte-stable render.

import type { EpochMillis, Uuid } from '../../../packages/domain/src/primitives.ts';
import {
  makeSourceCatalogEntry,
  makeCoverageGap,
  gapAgeMillis,
  gapHasReviewOrExpiry,
  UNKNOWN_SOURCE_CLASS,
  type CoverageGap,
  type GapReason,
} from '../../../packages/domain/src/inventory.ts';
import {
  InventoryService,
  type InventoryRow,
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
  CoverageGapsModel,
  SourceGapEntryVM,
  ComponentGapEntryVM,
  ConflictEntryVM,
  FreshnessEntryVM,
} from '../../../apps/web/src/features/gaps/CoverageGaps.tsx';
import type {
  CoverageGapVM,
  SourceGapVM,
  DiscoveredSourceVM,
} from '../../../apps/web/src/app/layout.tsx';

// ── Re-export the shared scenario knobs so specs drive shared RED controls through one import ─────
export { buildService, SCENARIO_IDS, idOf, T0, at, HORIZON_MILLIS };
export type { ScenarioOverrides };

const DAY_MS = 24 * 60 * 60_000;

// ── Phase-81 RED override knobs (extend the shared overrides) ─────────────────────────────────────

/** Every knob a Phase-81 RED control needs to break exactly one gap-view invariant at the INPUT. */
export interface GapScenarioOverrides extends ScenarioOverrides {
  /** Drop the OWNERSHIP-category governed-source gap (must otherwise stay visible). */
  readonly dropOwnershipGap?: boolean;
  /** Drop the ACCESS-category governed-source gap. */
  readonly dropAccessGap?: boolean;
  /** Drop the UNSUPPORTED-category governed-source gap. */
  readonly dropUnsupportedGap?: boolean;
  /** Drop the EXCLUSION-category governed-source gap. */
  readonly dropExclusionGap?: boolean;
  /** Drop the SCAN-GAP-category governed-source gap. */
  readonly dropScanGap?: boolean;
  /** Strip the review/expiry deadline from the UNSUPPORTED gap (⇒ service withholds it). */
  readonly dropUnsupportedReview?: boolean;
  /** Strip the discovery-evidence ref from the UNSUPPORTED discovered source. */
  readonly dropUnsupportedEvidence?: boolean;
}

/** The stable ids the Phase-81 enrichment pins (distinct from the shared scenario ids). */
export const GAP_IDS = {
  // discovered sources (catalog entries), one per enriched category
  ownershipSource: idOf(8001),
  accessSource: idOf(8002),
  unsupportedSource: idOf(8003),
  exclusionSource: idOf(8004),
  scanGapSource: idOf(8005),
  // governed-source gaps, one per enriched category
  ownershipGap: idOf(8101),
  accessGap: idOf(8102),
  unsupportedGap: idOf(8103),
  exclusionGap: idOf(8104),
  scanGap: idOf(8105),
  // shared discovery evidence
  unsupportedEvidence: idOf(8190),
  owner: idOf(5001),
} as const;

// ── One enriched (source, gap) category descriptor ────────────────────────────────────────────────

interface CategorySpec {
  readonly sourceId: Uuid;
  readonly gapId: Uuid;
  readonly sourceClass: string;
  readonly location: string;
  readonly accessState: 'connected' | 'reachable' | 'degraded' | 'unreachable' | 'inaccessible';
  readonly sensitivity: 'normal' | 'sensitive' | 'restricted';
  readonly onboardingState: 'discovered' | 'pending' | 'onboarded' | 'excluded' | 'retired';
  readonly withOwner: boolean;
  readonly withEvidence: boolean;
  readonly reason: GapReason;
  readonly impact: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  readonly requiredAction: string;
  readonly firstSeenDaysAgo: number;
  readonly withReview: boolean;
}

function categorySpecs(o: GapScenarioOverrides): readonly CategorySpec[] {
  return [
    {
      sourceId: GAP_IDS.ownershipSource,
      gapId: GAP_IDS.ownershipGap,
      sourceClass: 'agentctl',
      location: 'vpc-b/10.4.0.9:9443',
      accessState: 'reachable',
      sensitivity: 'normal',
      onboardingState: 'pending',
      withOwner: false, // ownership gap: no owner recorded
      withEvidence: true,
      reason: 'unowned',
      impact: 'medium',
      requiredAction: 'Assign an accountable owner and complete onboarding.',
      firstSeenDaysAgo: 5,
      withReview: true,
    },
    {
      sourceId: GAP_IDS.accessSource,
      gapId: GAP_IDS.accessGap,
      sourceClass: 'workflows_orchestration',
      location: 'vpc-c/10.6.1.2:7443',
      accessState: 'inaccessible',
      sensitivity: 'restricted',
      onboardingState: 'discovered',
      withOwner: true,
      withEvidence: true,
      reason: 'inaccessible',
      impact: 'high',
      requiredAction: 'Request scoped read access; do not assume the source is compliant.',
      firstSeenDaysAgo: 4,
      withReview: true,
    },
    {
      sourceId: GAP_IDS.unsupportedSource,
      gapId: GAP_IDS.unsupportedGap,
      sourceClass: UNKNOWN_SOURCE_CLASS,
      location: 'vpc-a/10.2.9.7:6443',
      accessState: 'reachable',
      sensitivity: 'normal',
      onboardingState: 'discovered',
      withOwner: true,
      withEvidence: !o.dropUnsupportedEvidence,
      reason: 'unsupported',
      impact: 'medium',
      requiredAction: 'File an adapter request or record a manual attestation.',
      firstSeenDaysAgo: 6,
      withReview: !o.dropUnsupportedReview,
    },
    {
      sourceId: GAP_IDS.exclusionSource,
      gapId: GAP_IDS.exclusionGap,
      sourceClass: 'legacy_batch',
      location: 'vpc-d/10.8.4.5:5443',
      accessState: 'reachable',
      sensitivity: 'normal',
      onboardingState: 'excluded',
      withOwner: true,
      withEvidence: true,
      reason: 'excluded',
      impact: 'low',
      requiredAction: 'Confirm the approved exclusion still holds at the next review.',
      firstSeenDaysAgo: 20,
      withReview: true,
    },
    {
      sourceId: GAP_IDS.scanGapSource,
      gapId: GAP_IDS.scanGap,
      sourceClass: 'platform_kanban',
      location: 'vpc-e/10.9.2.1:4443',
      accessState: 'unreachable',
      sensitivity: 'normal',
      onboardingState: 'onboarded',
      withOwner: true,
      withEvidence: true,
      reason: 'unreachable',
      impact: 'high',
      requiredAction: 'Restore the connector; the source stays a gap until it scans again.',
      firstSeenDaysAgo: 3,
      withReview: true,
    },
  ];
}

/** True iff this enriched category's gap should be dropped by a RED control. */
function categoryDropped(spec: CategorySpec, o: GapScenarioOverrides): boolean {
  if (spec.gapId === GAP_IDS.ownershipGap) return o.dropOwnershipGap === true;
  if (spec.gapId === GAP_IDS.accessGap) return o.dropAccessGap === true;
  if (spec.gapId === GAP_IDS.unsupportedGap) return o.dropUnsupportedGap === true;
  if (spec.gapId === GAP_IDS.exclusionGap) return o.dropExclusionGap === true;
  if (spec.gapId === GAP_IDS.scanGap) return o.dropScanGap === true;
  return false;
}

// ── Build the REAL service for the Phase-81 scenario (shared scenario + per-category enrichment) ──

export function buildGapService(overrides: GapScenarioOverrides = {}): InventoryService {
  const svc = buildService(overrides);
  const tenantId = SCENARIO_IDS.tenant;

  for (const spec of categorySpecs(overrides)) {
    // The discovered source (AC5 catalog facets). A not-yet-onboarded source may not be 'healthy'.
    svc.ingestCatalogEntry(
      makeSourceCatalogEntry({
        id: spec.sourceId,
        tenantId,
        sourceClass: spec.sourceClass,
        observedLocations: [spec.location],
        onboardingState: spec.onboardingState,
        accessState: spec.accessState,
        healthState: spec.onboardingState === 'onboarded' ? 'degraded' : 'unknown',
        sensitivity: spec.sensitivity,
        ownerPrincipalId: spec.withOwner ? GAP_IDS.owner : undefined,
        discoveryEvidence: spec.withEvidence ? GAP_IDS.unsupportedEvidence : undefined,
        firstSeenAt: at(-spec.firstSeenDaysAgo * DAY_MS),
        lastSeenAt: at(0),
      }),
    );
    // The governed-source gap (AC6). governedSourceGaps() keeps it only while it carries a
    // review-or-expiry deadline, so a dropped review makes the gap disappear from the view.
    if (!categoryDropped(spec, overrides)) {
      svc.ingestCoverageGap(
        makeCoverageGap({
          id: spec.gapId,
          tenantId,
          subjectKind: 'source_catalog_entry',
          subjectId: spec.sourceId,
          gapClass: 'governed_source',
          reason: spec.reason,
          impact: spec.impact,
          requiredAction: spec.requiredAction,
          requiredOwner: GAP_IDS.owner,
          status: 'open',
          firstSeenAt: at(-spec.firstSeenDaysAgo * DAY_MS),
          reviewAt: spec.withReview ? at(30 * DAY_MS) : undefined,
        }),
      );
    }
  }

  return svc;
}

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

/** The SAFE next action for a governed-source gap, by reason (never "assume compliant"). */
function safeSourceAction(reason: GapReason, ownerAction: string): string {
  const map: Readonly<Record<GapReason, string>> = {
    unowned: 'Assign an accountable owner before any control is credited to this source.',
    inaccessible: 'Request scoped read access — treat the source as ungoverned until reachable.',
    sensitive: 'Complete the DPIA / access review before reading restricted data.',
    unsupported: 'File an adapter request or record a manual attestation — do not skip the source.',
    excluded: 'Confirm the exclusion decision still holds at review; re-scope if it has lapsed.',
    stale: 'Re-probe the source; keep treating the last-known reading as last-known, not current.',
    unreachable: 'Restore the connector; the source stays a gap until it scans successfully again.',
    unmanaged: 'Onboard the source to a governed contract or file an exclusion review.',
    orphaned: 'Re-attach the evidence to a live owning asset, or retire it with a record.',
  };
  return map[reason] ?? ownerAction;
}

/** The SAFE next action for a component coverage gap (AC2). */
function safeComponentAction(reason: GapReason, requiredAction: string): string {
  return safeSourceAction(reason, requiredAction);
}

// ── Projections ────────────────────────────────────────────────────────────────────────────────

function sourceGapVM(gap: CoverageGap): SourceGapVM {
  const review = isoOf(gap.reviewAt);
  const expiry = isoOf(gap.expiresAt);
  return {
    id: String(gap.id),
    source: `source/${String(gap.subjectId ?? gap.id)}`,
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    impact: gap.impact,
    ownerAction: gap.requiredAction,
    reviewOrExpiry:
      review !== '—'
        ? `review by ${review}`
        : expiry !== '—'
          ? `expires ${expiry}`
          : 'no review or expiry recorded',
    hasReviewOrExpiry: gapHasReviewOrExpiry(gap),
  };
}

function discoveredSourceVM(
  svc: InventoryService,
  catalogId: string,
): DiscoveredSourceVM | undefined {
  const c = svc.catalogView().find((e) => String(e.catalogId) === catalogId);
  if (c === undefined) return undefined;
  return {
    id: String(c.catalogId),
    classification: c.classifiedUnknown ? 'unknown' : c.sourceClass,
    location: c.observedLocations.join(', '),
    accessStatus: c.accessState,
    sensitivity: c.sensitivity,
    ownershipStatus: c.ownershipGap ? 'unowned (ownership gap)' : String(c.ownerPrincipalId),
    onboardingState: c.onboardingState,
    discoveryEvidenceRef: c.discoveryEvidence ? String(c.discoveryEvidence) : undefined,
  };
}

function sourceGapEntries(svc: InventoryService, now: EpochMillis): readonly SourceGapEntryVM[] {
  const entries: SourceGapEntryVM[] = [];
  for (const gap of svc.governedSourceGaps()) {
    const source = discoveredSourceVM(svc, String(gap.subjectId));
    if (source === undefined) continue;
    const gapVM = sourceGapVM(gap);
    entries.push({
      gap: gapVM,
      source,
      ageDays: Math.floor(gapAgeMillis(gap, now) / DAY_MS),
      safeAction: safeSourceAction(gap.reason, gapVM.ownerAction),
      classified: source.classification !== 'unknown',
      ownershipGap: source.ownershipStatus.startsWith('unowned'),
    });
  }
  return entries;
}

function componentGapVM(gap: CoverageGap, now: EpochMillis): CoverageGapVM {
  return {
    id: String(gap.id),
    component:
      String(gap.subjectId) === String(SCENARIO_IDS.gappedAsset)
        ? 'shadow-inference-svc'
        : `component/${String(gap.subjectId ?? gap.id)}`,
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    ageDays: Math.floor(gapAgeMillis(gap, now) / DAY_MS),
    impact: gap.impact,
    requiredOwnerAction: gap.requiredAction,
  };
}

function componentGapEntries(
  svc: InventoryService,
  now: EpochMillis,
): readonly ComponentGapEntryVM[] {
  return svc.componentGaps().map((gap): ComponentGapEntryVM => {
    const vm = componentGapVM(gap, now);
    return { gap: vm, safeAction: safeComponentAction(gap.reason, vm.requiredOwnerAction) };
  });
}

/** CONFLICT view: the contested/unresolved fields the correlation surfaced across the drilled item. */
function conflictEntries(svc: InventoryService, now: EpochMillis): readonly ConflictEntryVM[] {
  const entries: ConflictEntryVM[] = [];
  for (const asset of svc.assets()) {
    const dd = svc.drillDown(asset.id, now);
    const name = dd.asset?.name ?? String(asset.id);
    for (const f of dd.correlation.fields) {
      if (!f.contested) continue;
      const unresolved = f.resolution !== 'resolved';
      entries.push({
        assetId: String(asset.id),
        assetName: name,
        field: f.field,
        authoritativeValue: unresolved ? 'unresolved' : valueText(f.value),
        authoritativeSourceClass: f.authoritativeSourceClass ?? '—',
        unresolved,
        differingSources: f.differingSources.map((c) => ({
          sourceClass: c.sourceClass,
          value: valueText(c.value),
        })),
        safeAction: unresolved
          ? 'Reconcile the authoritative value by hand; automation stays PAUSED until resolved.'
          : 'Confirm the authoritative value; automation stays paused for the contested field.',
      });
    }
  }
  return entries;
}

/**
 * FRESHNESS view: rows whose observation is STALE / unavailable (AC4) — the source "became stale or
 * unavailable". We include a row ONLY when it has an actual STALE contributing source record (the true
 * freshness case), not merely because its health is unknown for another reason (e.g. an unmanaged
 * component with no records — that is a coverage gap, surfaced elsewhere). For each such row the health
 * is shown as the service's `reportedHealth` (WITHHELD as `unknown` when evidence is not current), with
 * the stale record's last-known time and confidence — current health is NEVER inferred from it.
 */
function freshnessEntries(svc: InventoryService, now: EpochMillis): readonly FreshnessEntryVM[] {
  const entries: FreshnessEntryVM[] = [];
  for (const row of svc.currentStateView(now)) {
    // The stalest contributing record (the last-known witness). No stale record ⇒ not a freshness gap.
    const stalest = svc
      .sourceRecordsFor(row.assetId)
      .filter((r) => r.stale)
      .sort((a, b) => (a.lastKnownAt ?? 0) - (b.lastKnownAt ?? 0))[0];
    if (stalest === undefined) continue;
    entries.push({
      subjectId: String(row.assetId),
      subjectName: row.name,
      reportedHealth: row.reportedHealth,
      observedHealth: row.observedHealth,
      healthWithheld: row.reportedHealth === 'unknown' && row.observedHealth !== 'unknown',
      lastKnownAtIso: isoOf(stalest.lastKnownAt),
      confidence: stalest.confidence,
      safeAction:
        'Re-probe the source; show the last-known reading as last-known — do not infer current health.',
    });
  }
  return entries;
}

// ── The public derivation ────────────────────────────────────────────────────────────────────────

/**
 * DERIVE the coverage-gap command model from the REAL service at instant `now`. Every field is a
 * projection of a value the service COMPUTED via `componentGaps()` / `governedSourceGaps()` /
 * `catalogView()` / `drillDown()` / `currentStateView()`.
 */
export function deriveCoverageGaps(
  overrides: GapScenarioOverrides = {},
  now: EpochMillis = T0,
): CoverageGapsModel {
  const svc = buildGapService(overrides);
  // Force a full derivation of the shell model too, so the digest/scenario matches sibling views.
  deriveModel(svc, now);

  const componentGaps = componentGapEntries(svc, now);
  const sourceGaps = sourceGapEntries(svc, now);
  const conflicts = conflictEntries(svc, now);
  const freshness = freshnessEntries(svc, now);

  return {
    componentGaps,
    sourceGaps,
    conflicts,
    freshness,
    totalGapCount: componentGaps.length + sourceGaps.length + conflicts.length + freshness.length,
    generatedAtIso: new Date(now).toISOString(),
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Convenience: the default (no-override) gap backlog at T0. */
export function defaultCoverageGaps(now: EpochMillis = T0): CoverageGapsModel {
  return deriveCoverageGaps({}, now);
}

/** Re-export the row type for specs that read the service directly. */
export type { InventoryRow };
