// Phase 76 — OPERATIONAL and EXECUTIVE current-state query services.
//
// A PURE, deterministic query-service layer over the Phase-75 `InventoryProjector`
// (./inventory-projector.ts). It reshapes the projector's already-folded read model into two
// audience-specific views, each carrying EXPLICIT freshness (last-known time + a staleness flag)
// and confidence ∈ [0,1]:
//
//   • operationalView(at)  — one row per governed asset for a responder: what it is, who owns it,
//     its lifecycle/risk/coverage, its OBSERVED vs SAFE-TO-REPORT health (AC4: current health is
//     never inferred from stale evidence), last-known observation time, whether it is stale at the
//     query instant, its confidence, whether it stays on-screen as a visible coverage gap (AC2),
//     its related-source cardinality and unresolved-issue count (AC3), and the SAFE NEXT ACTION a
//     responder may take. The full source-level drill-down remains on the projector
//     (`drillDown(assetId, at)`); the operational item surfaces the counts a responder scans.
//
//   • executiveView(at)  — a single aggregate posture roll-up for a leader: population counts by
//     lifecycle / risk / coverage / reported-health, ownership-gap and stale-item totals, the
//     component- and governed-source-gap inventories (AC2/AC6), the source-catalog onboarding
//     posture (AC5), and an aggregate freshness+confidence summary whose worst-case confidence and
//     stale-item count make any reliance on stale data VISIBLE rather than silently averaged away.
//
// Every field is DERIVED from the projector's independent read surface (currentStateView / rowFor /
// drillDown / coverageGaps / catalog / snapshotDigest). This module performs NO ingest, holds NO
// mutable state, reads NO wall clock, and does NO I/O — the only cross-package dependencies are the
// projector itself and the `@trustcircle/domain` value types it re-surfaces.
//
// The one governance rule this layer must not break is AC4: a stale item's health is reported as
// `'unknown'` (mirroring the projector's `reportedHealth`), its `stale` flag is set, its
// `confidence` is < 1, and it never contributes its OBSERVED health to any executive roll-up. The
// aggregate posture is therefore computed from `reportedHealth`, so stale/incomplete evidence can
// never inflate the "healthy" count.

import {
  type Uuid,
  type EpochMillis,
  type AssetLifecycleState,
  type RiskTier,
  type CoverageState,
  type AssetHealthState,
  type EvidenceState,
  type GapReason,
  type GapImpact,
  type OnboardingState,
  type AccessState,
  type CatalogSensitivity,
  type CoverageGap,
  type SourceCatalogEntry,
  ASSET_LIFECYCLE_STATES,
  RISK_TIERS,
  COVERAGE_STATES,
  ASSET_HEALTH_STATES,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  catalogEntryHasOwnershipGap,
  catalogEntryNeedsAttention,
} from '@trustcircle/domain';

import { InventoryProjector, type InventoryRow } from './inventory-projector.ts';

// ===========================================================================
// 0. Freshness — the shared currency block both views carry.
// ===========================================================================

/** Explicit currency for a single item or an aggregate: the newest known observation time, whether
 * that observation is STALE at the query instant, the confidence ∈ [0,1] in its currency, and the
 * horizon used to decide staleness. The `stale` flag and sub-1 `confidence` are the AC4 witnesses
 * that a consumer is NOT being handed stale data as if it were current. */
export interface Freshness {
  /** The newest last-known observation time contributing to this item, or `undefined` when the
   * subject was never observed. */
  readonly lastKnownAt?: EpochMillis;
  /** Age in millis of `lastKnownAt` relative to the query instant (0 when never observed). */
  readonly ageMillis: number;
  /** The staleness horizon (millis) this judgement used — mirrors the projector's horizon. */
  readonly horizonMillis: number;
  /** True iff the newest observation is older than the horizon OR confidence has decayed below 1 —
   * i.e. the item must NOT be treated as currently observed. */
  readonly stale: boolean;
  /** Confidence ∈ [0,1] in this item's currency at the query instant (0 when never observed). */
  readonly confidence: number;
}

// ===========================================================================
// 1. Operational view — the responder's per-item current state.
// ===========================================================================

/** The safe next action a responder may take on an item WITHOUT trusting possibly-stale data.
 *  - `investigate_stale`   — evidence is stale/incomplete; re-observe before acting (AC4).
 *  - `assign_owner`        — an ownership gap must be closed (AC2).
 *  - `close_coverage_gap`  — a visible component gap needs the named owner action (AC2).
 *  - `reconcile_sources`   — sources disagree on a governed field; correlation is unresolved (AC3).
 *  - `remediate_health`    — health is currently observed as non-healthy on fresh evidence.
 *  - `none`                — healthy, owned, covered, fresh; no action required. */
export const OPERATIONAL_ACTIONS = [
  'investigate_stale',
  'assign_owner',
  'close_coverage_gap',
  'reconcile_sources',
  'remediate_health',
  'none',
] as const;
export type OperationalAction = (typeof OPERATIONAL_ACTIONS)[number];

/** One operational row: an asset's current state for a responder, with freshness + the safe action. */
export interface OperationalItem {
  readonly assetId: Uuid;
  readonly assetType: string;
  readonly name: string;
  readonly ownerPrincipalId?: Uuid;
  readonly ownershipGap: boolean;
  readonly lifecycleState: AssetLifecycleState;
  readonly riskTier: RiskTier;
  readonly coverage: CoverageState;
  /** The health the asset RECORDED — always shown, but see `reportedHealth`. */
  readonly observedHealth: AssetHealthState;
  /** AC4: the health SAFE to report as CURRENT — `'unknown'` unless evidence is current AND
   * confidence is 1. Mirrors the projector's `reportedHealth`; NEVER inferred from stale data. */
  readonly reportedHealth: AssetHealthState;
  readonly evidenceState: EvidenceState;
  /** The number of open correlation issues (disagreeing/unresolved fields) on this item (AC3). */
  readonly unresolvedIssueCount: number;
  /** True iff this item still carries at least one VISIBLE component gap (AC2). */
  readonly hasVisibleComponentGap: boolean;
  /** The distinct source records that contributed to this item (AC3 "related work" cardinality). */
  readonly sourceRecordCount: number;
  /** Explicit freshness for THIS item. */
  readonly freshness: Freshness;
  /** The safe next action a responder may take (see {@link OperationalAction}). */
  readonly safeNextAction: OperationalAction;
}

// ===========================================================================
// 2. Executive view — the leader's aggregate posture roll-up.
// ===========================================================================

/** A count table keyed by a closed enum; every enumerated key is present (0 when unseen) so a
 * consumer never has to distinguish "absent" from "zero". */
export type CountsBy<K extends string> = Readonly<Record<K, number>>;

/** The AC2 component-gap / AC6 governed-source-gap inventory line — a still-visible gap summarised
 * with its reason, impact, age, required owner action, and (for governed-source gaps) deadline. */
export interface GapLine {
  readonly gapId: Uuid;
  readonly gapClass: CoverageGap['gapClass'];
  readonly subjectId?: Uuid;
  readonly reason: GapReason;
  readonly impact: GapImpact;
  readonly ageMillis: number;
  readonly requiredAction: string;
  readonly requiredOwner?: Uuid;
  readonly hasDeadline: boolean;
  readonly reviewAt?: EpochMillis;
  readonly expiresAt?: EpochMillis;
}

/** The AC5 catalog posture line — a discovered source's onboarding/access/sensitivity/ownership
 * classification, kept visible until it is cleanly onboarded+connected+healthy. */
export interface CatalogLine {
  readonly catalogId: Uuid;
  readonly sourceClass: string;
  readonly classifiedUnknown: boolean;
  readonly onboardingState: OnboardingState;
  readonly accessState: AccessState;
  readonly sensitivity: CatalogSensitivity;
  readonly ownershipGap: boolean;
  readonly observedLocations: readonly string[];
  readonly discoveryEvidence?: Uuid;
  /** True iff this entry still needs operator attention (not onboarded+connected+healthy). */
  readonly needsAttention: boolean;
}

/** Aggregate freshness for the whole population: worst-case confidence, the count of stale items,
 * and the oldest last-known time — the executive-level AC4 witnesses that reliance on stale data is
 * SURFACED, never averaged away into a falsely-confident single number. */
export interface AggregateFreshness {
  readonly itemCount: number;
  /** The number of items whose evidence is stale at the query instant. */
  readonly staleItemCount: number;
  /** The number of items with an ownership gap. */
  readonly ownershipGapCount: number;
  /** The minimum per-item confidence across the population (1 for an empty population). */
  readonly minConfidence: number;
  /** The oldest last-known observation time across observed items, or `undefined` when none. */
  readonly oldestObservationAt?: EpochMillis;
  /** True iff ANY item is stale — a single boolean a dashboard can gate a "current" badge on. */
  readonly anyStale: boolean;
}

/** The executive posture roll-up: population counts, gap inventories, catalog posture, and the
 * aggregate freshness block. Computed from `reportedHealth` so stale evidence can never inflate the
 * healthy count (AC4). */
export interface ExecutivePosture {
  readonly assetCount: number;
  readonly byLifecycle: CountsBy<AssetLifecycleState>;
  readonly byRisk: CountsBy<RiskTier>;
  readonly byCoverage: CountsBy<CoverageState>;
  /** Population counts keyed by the SAFE-TO-REPORT health — stale items land in `'unknown'`. */
  readonly byReportedHealth: CountsBy<AssetHealthState>;
  /** The still-visible component gaps (AC2) — assets that stay on-screen as coverage gaps. */
  readonly componentGaps: readonly GapLine[];
  /** The still-visible governed-source gaps (AC6) — discovered sources that stay on-screen as gaps. */
  readonly governedSourceGaps: readonly GapLine[];
  /** The source-catalog onboarding posture (AC5). */
  readonly catalog: readonly CatalogLine[];
  /** The number of catalog entries that still need attention (AC5/AC6). */
  readonly catalogNeedingAttention: number;
  readonly freshness: AggregateFreshness;
  /** The projector's content digest at `at` — the durable-effect witness this roll-up was derived
   * from (identical input ⇒ identical digest ⇒ identical posture). */
  readonly snapshotDigest: string;
}

// ===========================================================================
// 3. The enumerated key sets (so every count table is total).
// ===========================================================================

// The canonical, closed enum member lists — imported from the domain so a count table can never
// drift from the value model it aggregates.
const LIFECYCLE_KEYS: readonly AssetLifecycleState[] = ASSET_LIFECYCLE_STATES;
const RISK_KEYS: readonly RiskTier[] = RISK_TIERS;
const COVERAGE_KEYS: readonly CoverageState[] = COVERAGE_STATES;
const HEALTH_KEYS: readonly AssetHealthState[] = ASSET_HEALTH_STATES;

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

// ===========================================================================
// 4. The query service.
// ===========================================================================

/**
 * A pure query service over an {@link InventoryProjector}. Holds only a reference to the projector
 * and the staleness horizon it reports with; every method DERIVES its answer from the projector's
 * independent read surface at the query instant `at`. No ingest, no mutation, no clock, no I/O.
 */
export class CurrentStateQueryService {
  private readonly projector: InventoryProjector;
  private readonly horizon: number;

  /**
   * @param projector the folded read model to query (never mutated by this service).
   * @param stalenessHorizonMillis the horizon used for the `stale` flag; MUST match the horizon the
   *   projector was constructed with so the two agree on what counts as stale. Defaults to 15 min.
   */
  constructor(projector: InventoryProjector, stalenessHorizonMillis = 15 * 60_000) {
    if (!(projector instanceof InventoryProjector)) {
      throw new TypeError('CurrentStateQueryService requires an InventoryProjector');
    }
    if (
      !Number.isInteger(stalenessHorizonMillis) ||
      stalenessHorizonMillis <= 0
    ) {
      throw new RangeError('stalenessHorizonMillis must be a positive integer');
    }
    this.projector = projector;
    this.horizon = stalenessHorizonMillis;
  }

  // ---- Freshness derivation (shared by both views). ----------------------

  /** Derive the per-item freshness block from an already-built projector row at `at`. The `stale`
   * flag is true when the newest observation is older than the horizon OR confidence < 1 — the two
   * conditions the projector uses to withhold current health (AC4). */
  private freshnessOf(row: InventoryRow, at: EpochMillis): Freshness {
    const lastKnownAt = row.lastObservationAt;
    const ageMillis = lastKnownAt === undefined ? 0 : Math.max(0, at - lastKnownAt);
    const stale = row.confidence < 1 || ageMillis > this.horizon || lastKnownAt === undefined;
    return {
      ...(lastKnownAt !== undefined ? { lastKnownAt } : {}),
      ageMillis,
      horizonMillis: this.horizon,
      stale,
      confidence: row.confidence,
    };
  }

  /** The safe next action for one row — a deterministic priority ladder that NEVER recommends
   * acting on health that is not safe to report as current (AC4 first). */
  private safeActionOf(row: InventoryRow, fresh: Freshness): OperationalAction {
    // AC4: stale/incomplete evidence ⇒ investigate before trusting anything downstream.
    if (fresh.stale || row.evidenceState !== 'current') return 'investigate_stale';
    // AC2: ownership gap outranks health remediation (an unowned item has no responder).
    if (row.ownershipGap) return 'assign_owner';
    if (row.hasVisibleComponentGap) return 'close_coverage_gap';
    // AC3: sources disagree on a governed field — pause and reconcile before acting.
    if (row.unresolvedIssueCount > 0) return 'reconcile_sources';
    // Only now is the reported health SAFE to act on.
    if (row.reportedHealth !== 'healthy') return 'remediate_health';
    return 'none';
  }

  // ---- Operational view (per-item). --------------------------------------

  /** One operational row per governed asset at `at`, ordered by assetId. Each row carries freshness
   * and the safe next action; a stale row reports `'unknown'` health and a `stale` freshness flag. */
  operationalView(at: EpochMillis): readonly OperationalItem[] {
    return this.projector
      .currentStateView(at)
      .map((row) => this.toOperationalItem(row, at))
      .sort((a, b) => a.assetId.localeCompare(b.assetId));
  }

  /** The operational row for a single asset at `at`. Throws if the asset is unknown. */
  operationalItem(assetId: Uuid, at: EpochMillis): OperationalItem {
    return this.toOperationalItem(this.projector.rowFor(assetId, at), at);
  }

  private toOperationalItem(row: InventoryRow, at: EpochMillis): OperationalItem {
    const freshness = this.freshnessOf(row, at);
    return {
      assetId: row.assetId,
      assetType: row.assetType,
      name: row.name,
      ...(row.ownerPrincipalId !== undefined ? { ownerPrincipalId: row.ownerPrincipalId } : {}),
      ownershipGap: row.ownershipGap,
      lifecycleState: row.lifecycleState,
      riskTier: row.riskTier,
      coverage: row.coverage,
      observedHealth: row.observedHealth,
      reportedHealth: row.reportedHealth,
      evidenceState: row.evidenceState,
      unresolvedIssueCount: row.unresolvedIssueCount,
      hasVisibleComponentGap: row.hasVisibleComponentGap,
      sourceRecordCount: row.sourceRecordCount,
      freshness,
      safeNextAction: this.safeActionOf(row, freshness),
    };
  }

  // ---- Executive view (aggregate). ---------------------------------------

  /** The aggregate posture roll-up at `at`. Population counts are computed from `reportedHealth`,
   * so a stale item is counted as `'unknown'` health and never inflates the healthy total (AC4). */
  executiveView(at: EpochMillis): ExecutivePosture {
    const rows = this.projector.currentStateView(at);

    const byLifecycle = zeroCounts(LIFECYCLE_KEYS);
    const byRisk = zeroCounts(RISK_KEYS);
    const byCoverage = zeroCounts(COVERAGE_KEYS);
    const byReportedHealth = zeroCounts(HEALTH_KEYS);

    let staleItemCount = 0;
    let ownershipGapCount = 0;
    let minConfidence = rows.length === 0 ? 1 : Number.POSITIVE_INFINITY;
    let oldestObservationAt: EpochMillis | undefined;

    for (const row of rows) {
      byLifecycle[row.lifecycleState] += 1;
      byRisk[row.riskTier] += 1;
      byCoverage[row.coverage] += 1;
      // AC4: aggregate from the SAFE-TO-REPORT health, not the raw observed health.
      byReportedHealth[row.reportedHealth] += 1;

      const fresh = this.freshnessOf(row, at);
      if (fresh.stale) staleItemCount += 1;
      if (row.ownershipGap) ownershipGapCount += 1;
      if (row.confidence < minConfidence) minConfidence = row.confidence;
      if (row.lastObservationAt !== undefined) {
        oldestObservationAt =
          oldestObservationAt === undefined
            ? row.lastObservationAt
            : Math.min(oldestObservationAt, row.lastObservationAt);
      }
    }
    if (!Number.isFinite(minConfidence)) minConfidence = 1;

    const componentGaps = this.projector
      .componentGaps()
      .filter(gapIsVisible)
      .map((g) => this.toGapLine(g, at))
      .sort((a, b) => a.gapId.localeCompare(b.gapId));

    const governedSourceGaps = this.projector
      .governedSourceGaps()
      .filter(gapIsVisible)
      .map((g) => this.toGapLine(g, at))
      .sort((a, b) => a.gapId.localeCompare(b.gapId));

    const catalog = this.projector
      .catalog()
      .map(toCatalogLine)
      .sort((a, b) => a.catalogId.localeCompare(b.catalogId));

    const freshness: AggregateFreshness = {
      itemCount: rows.length,
      staleItemCount,
      ownershipGapCount,
      minConfidence,
      ...(oldestObservationAt !== undefined ? { oldestObservationAt } : {}),
      anyStale: staleItemCount > 0,
    };

    return {
      assetCount: rows.length,
      byLifecycle,
      byRisk,
      byCoverage,
      byReportedHealth,
      componentGaps,
      governedSourceGaps,
      catalog,
      catalogNeedingAttention: catalog.filter((c) => c.needsAttention).length,
      freshness,
      snapshotDigest: this.projector.snapshotDigest(at),
    };
  }

  private toGapLine(g: CoverageGap, at: EpochMillis): GapLine {
    return {
      gapId: g.id,
      gapClass: g.gapClass,
      ...(g.subjectId !== undefined ? { subjectId: g.subjectId } : {}),
      reason: g.reason,
      impact: g.impact,
      ageMillis: gapAgeMillis(g, at),
      requiredAction: g.requiredAction,
      ...(g.requiredOwner !== undefined ? { requiredOwner: g.requiredOwner } : {}),
      hasDeadline: gapHasReviewOrExpiry(g),
      ...(g.reviewAt !== undefined ? { reviewAt: g.reviewAt } : {}),
      ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}),
    };
  }
}

/** Build a catalog posture line from a raw catalog entry (AC5). */
function toCatalogLine(e: SourceCatalogEntry): CatalogLine {
  return {
    catalogId: e.id,
    sourceClass: e.sourceClass,
    classifiedUnknown: e.sourceClass === 'unknown',
    onboardingState: e.onboardingState,
    accessState: e.accessState,
    sensitivity: e.sensitivity,
    ownershipGap: catalogEntryHasOwnershipGap(e),
    observedLocations: e.observedLocations,
    ...(e.discoveryEvidence !== undefined ? { discoveryEvidence: e.discoveryEvidence } : {}),
    needsAttention: catalogEntryNeedsAttention(e),
  };
}
