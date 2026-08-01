// @trustcircle/application — CURRENT-INVENTORY ASSEMBLY (Phase 70).
//
// Assembles the officer's CURRENT INVENTORY: a fleet-level, tenant-scoped, in-memory aggregate that
// ingests governed assets, their distinct source records, coverage gaps, discovered source-catalog
// entries, and inventory relationships, then composes the domain's single-item `correlateAsset()`
// into a collection where EACH asset renders exactly ONCE with its full governance facet set.
//
// Governing oracles (acceptance criteria, verified in tests/unit/inventory-service.unit.test.ts):
//   AC1 Healthy connected sources with AI assets/governance records → each item appears ONCE with
//       type / source identity / owner / lifecycle state / risk / control coverage / evidence state
//       / health / last-observation time / unresolved issues → `currentStateView()` yields one
//       `InventoryRow` per asset, carrying every enumerated facet as a NAMED field.
//   AC2 A discovered-but-unmanaged / unreachable / stale / orphaned / excluded COMPONENT stays
//       VISIBLE as a coverage gap with reason / age / impact / required owner action — never
//       healthy, never disappearing → `coverageGaps()` / `componentGaps()` retain every open gap
//       with those facets; a row bound to a component gap can never report covered+healthy.
//   AC3 Related work across registered sources (Kanban, agentctl, workflows_orchestration) →
//       drill-down shows DISTINCT source records, their correlation, status differences,
//       dependencies, and authoritative fields → `drillDown(assetId)`.
//   AC4 A stale/unavailable source → affected data is marked with last-known time + confidence and
//       current compliance/health is NOT inferred from stale data → the row's `evidenceState` is
//       non-`current`, `reportedHealth` is withheld (`unknown`), and a `confidence` < 1 is folded
//       in for every non-fresh contributing record.
//   AC5 An unregistered governance-relevant source inside the boundary → ADDED to the source
//       catalog with discovery evidence / type-or-unknown classification / location / access status
//       / sensitivity / ownership status / onboarding state → `catalog()` + `catalogView()`.
//   AC6 A discovered source that is unsupported / inaccessible / sensitive / unowned / excluded →
//       stays VISIBLE as a GOVERNED-SOURCE gap with reason / impact / owner action /
//       review-or-expiry → `governedSourceGaps()` retains each with its deadline.
//
// The service is a pure, dependency-free (transitively node:crypto only) in-memory aggregate over
// the Phase-63 domain inventory + Phase-64 correlation value model. It NEVER touches the wall
// clock: every ingest carries explicit epoch-millis and an injected id factory (`newId`), and every
// read takes an explicit `at: EpochMillis`, so identity, timing, age, and staleness are
// deterministic and independently reproducible.
//
// Every mutation is INDEPENDENTLY READABLE afterwards through the query surface (`assets()`,
// `sourceRecordsFor()`, `coverageGaps()`, `catalog()`, `relationshipsFor()`, `currentStateView()`,
// `drillDown()`, `snapshotDigest()`): the mutation's return value is never the proof; the
// re-readable state + its content digest are.
//
// The service grants NO governance authority. It records, validates, correlates, and keeps visible;
// it does not infer compliance, does not silently repair, and NEVER deletes — terminal gap states
// stay queryable so inventory history stays reconstructable.

import {
  isUuid,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
} from '@trustcircle/domain';
import {
  // asset value model (AC1)
  type GovernedAsset,
  governedAssetDigest,
  assetHasOwnershipGap,
  type AssetHealthState,
  // source records (AC3)
  type SourceRecord,
  sourceRecordIdentity,
  sourceRecordDigest,
  sourceRecordFreshnessSuspect,
  // coverage gaps (AC2/AC6)
  type CoverageGap,
  coverageGapDigest,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  // catalog (AC5)
  type SourceCatalogEntry,
  sourceCatalogEntryDigest,
  catalogEntryHasOwnershipGap,
  UNKNOWN_SOURCE_CLASS,
  // relationships (AC3)
  type InventoryRelationship,
  inventoryRelationshipDigest,
  // correlation (composition core)
  type SourceAuthorityPolicy,
  makeSourceAuthorityPolicy,
  correlateAsset,
  type CorrelatedItem,
  type CorrelatedItemFacets,
  type CoverageGapView,
  type DependencyView,
  type AuthoritativeFieldView,
  type CatalogEntryView,
  type EvidenceState,
  correlatedItemDigest,
} from '@trustcircle/domain';
import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Shared guards (mirror the domain factory guards so the service fails fast
//    and fail-visibly on a bad ingest, exactly like the aggregates it holds).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}
function assertTenant(t: unknown, label: string): asserts t is TenantId {
  if (t !== PLATFORM_SCOPE && !isUuid(t)) {
    throw new TypeError(`${label} must be a tenant UUID or the platform scope`);
  }
}
function assertEpoch(ms: unknown, label: string): asserts ms is EpochMillis {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${String(ms)}`);
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** Drop `undefined`-valued keys (required under exactOptionalPropertyTypes) and freeze. */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.freeze(out) as T;
}

/** Injected identity factory: the caller supplies fresh UUIDv7s so the service never generates
 * identity from the wall clock (deterministic + reproducible in tests). Re-uses the same shape as
 * the source-registry's factory; not re-exported here to avoid an `export *` name collision. */
type IdFactory = () => Uuid;

const DEFAULT_STALENESS_HORIZON = 15 * 60 * 1000; // 15 minutes (freshness objective, ops.md).

// ===========================================================================
// 1. Read-side view types — the officer-facing shapes the query surface renders.
// ===========================================================================

/**
 * The AC1 CURRENT-INVENTORY row: one governed asset rendered ONCE with every enumerated facet as a
 * NAMED field (never a status blob). Composed from the correlated item's `facets`, overlaid with an
 * AC4 staleness verdict so a non-current row's health is withheld rather than inferred.
 */
export interface InventoryRow {
  /** AC1 "source identity" — the stable governed-asset identity this row renders once. */
  readonly assetId: Uuid;
  /** AC1 "type". */
  readonly assetType: string;
  readonly name: string;
  /** AC1 "owner" — the accountable principal, or absent when ownership is itself a gap. */
  readonly ownerPrincipalId?: Uuid;
  readonly ownershipGap: boolean;
  /** AC1 "lifecycle state". */
  readonly lifecycleState: CorrelatedItemFacets['lifecycleState'];
  /** AC1 "risk". */
  readonly riskTier: CorrelatedItemFacets['riskTier'];
  /** AC1 "control coverage". */
  readonly coverage: CorrelatedItemFacets['coverage'];
  /** The health the asset RECORDED — always shown, but see `reportedHealth` for the AC4 gate. */
  readonly observedHealth: AssetHealthState;
  /** AC4: the health SAFE to report as current. Equal to `observedHealth` only when evidence is
   * `current`; otherwise `'unknown'` — current health is NEVER inferred from stale/incomplete
   * evidence. */
  readonly reportedHealth: AssetHealthState;
  /** AC1 "evidence state" — current / stale / incomplete. */
  readonly evidenceState: EvidenceState;
  /** AC1 "last observation time" — newest last-known across contributing records / asset. */
  readonly lastObservationAt?: EpochMillis;
  /** AC1 "unresolved issues" — open correlation cases for this asset. */
  readonly unresolvedIssueCount: number;
  /** AC4 confidence ∈ [0,1] in this row's currency: 1 only when every contributing record is fresh
   * at `at`; decays as records age; forced < 1 the moment any is stale/suspect. */
  readonly confidence: number;
  /** True iff this row is bound to at least one still-VISIBLE component coverage gap (AC2) — such a
   * row can never be presented as covered+healthy. */
  readonly hasVisibleComponentGap: boolean;
  /** The distinct source records contributing to this row (AC3 identity list). */
  readonly sourceRecordCount: number;
  readonly version: number;
}

/** The AC3 drill-down: an asset's DISTINCT source records, its per-field correlation (status
 * differences), its dependency + authoritative-field edges, and its still-visible gaps. */
export interface InventoryDrillDown {
  readonly assetId: Uuid;
  readonly asset?: GovernedAsset;
  /** Every DISTINCT source record (Kanban / agentctl / workflows_orchestration …), retained. */
  readonly sourceRecords: readonly SourceRecord[];
  /** The correlated item — carries `fields` (with `contested` + `differingSources`), `openCases`,
   * `automationPaused`, and the AC1 facet block. */
  readonly correlation: CorrelatedItem;
  /** AC3 dependency edges (`depends_on`). */
  readonly dependencies: readonly DependencyView[];
  /** AC3 authoritative-field attributions (`authoritative_for`). */
  readonly authoritativeFields: readonly AuthoritativeFieldView[];
  /** The catalog membership views for this asset's contributing sources (AC5). */
  readonly catalogEntries: readonly CatalogEntryView[];
  /** The still-visible coverage gaps bound to this asset (AC2). */
  readonly visibleGaps: readonly CoverageGapView[];
}

interface AssetInput {
  readonly asset: GovernedAsset;
  /** The governed fields correlated for this asset (drives status-difference detection). */
  readonly fields: readonly string[];
}

export interface InventoryServiceInput {
  readonly tenantId: TenantId;
  readonly newId: IdFactory;
  /** Optional shared authority policy for field resolution. A default (empty-rule) policy is used
   * when omitted; unknown/unregistered classes always resolve to a concrete rank (AC5). */
  readonly policy?: SourceAuthorityPolicy;
  /** Staleness horizon in millis: a record not seen within this window contributes staleness and
   * drops row confidence below 1 (AC4). */
  readonly stalenessHorizonMillis?: number;
}

// ===========================================================================
// 2. The aggregate.
// ===========================================================================

/**
 * In-memory current-inventory assembly. State is held keyed by asset id; every ingest returns the
 * durable value written AND leaves it independently readable via the query surface. Pure +
 * deterministic: no wall-clock reads, no I/O.
 */
export class InventoryService {
  private readonly tenantId: TenantId;
  private readonly newId: IdFactory;
  private readonly policy: SourceAuthorityPolicy;
  private readonly horizon: number;

  /** Governed assets keyed by id — each renders ONCE (AC1). */
  private readonly assetsById = new Map<string, GovernedAsset>();
  /** Correlated fields per asset. */
  private readonly fieldsByAsset = new Map<string, string[]>();
  /** Distinct source records per asset, keyed by `sourceRecordIdentity` (AC3). */
  private readonly recordsByAsset = new Map<string, Map<string, SourceRecord>>();
  /** All coverage gaps keyed by gap id (AC2/AC6) — never deleted. */
  private readonly gaps = new Map<string, CoverageGap>();
  /** Component gap ids bound to an asset (AC2), keyed by asset id. */
  private readonly componentGapsByAsset = new Map<string, Set<string>>();
  /** Catalog entries keyed by id (AC5). */
  private readonly catalogById = new Map<string, SourceCatalogEntry>();
  /** Catalog entries associated with an asset, for drill-down (AC5). */
  private readonly catalogByAsset = new Map<string, Set<string>>();
  /** Inventory relationships keyed by id (AC3). */
  private readonly relationships = new Map<string, InventoryRelationship>();
  /** Relationship ids bound to an asset (AC3), keyed by asset id. */
  private readonly relationshipsByAsset = new Map<string, Set<string>>();

  constructor(input: InventoryServiceInput) {
    assertTenant(input.tenantId, 'inventory.tenantId');
    if (typeof input.newId !== 'function') throw new TypeError('inventory.newId must be a factory');
    if (input.policy !== undefined && typeof input.policy !== 'object') {
      throw new TypeError('inventory.policy must be a SourceAuthorityPolicy');
    }
    const horizon = input.stalenessHorizonMillis ?? DEFAULT_STALENESS_HORIZON;
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new RangeError('inventory.stalenessHorizonMillis must be a positive integer');
    }
    this.tenantId = input.tenantId;
    this.newId = input.newId;
    this.policy = input.policy ?? makeSourceAuthorityPolicy({ id: 'inventory-default-policy' });
    this.horizon = horizon;
  }

  private key(id: Uuid): string {
    return String(id);
  }

  /** Mint a fresh identity from the injected factory (never from the wall clock). Exposed so a
   * caller assembling gaps/records for ingest can source deterministic ids from the SAME factory
   * the service was constructed with, keeping identity generation reproducible. */
  mintId(): Uuid {
    const id = this.newId();
    assertUuid(id, 'inventory.newId() result');
    return id;
  }

  private assertTenantScope(t: TenantId, label: string): void {
    if (t !== this.tenantId) {
      throw new RangeError(`${label} belongs to a different tenant than the inventory scope`);
    }
  }

  // -------------------------------------------------------------------------
  // AC1 — INGEST an asset (renders once). Idempotent per asset id: re-ingesting
  // the same id REPLACES the row's asset value (a superseding observation) but
  // never forks a second row.
  // -------------------------------------------------------------------------

  ingestAsset(input: AssetInput): GovernedAsset {
    const a = input.asset;
    assertUuid(a.id, 'ingestAsset.asset.id');
    this.assertTenantScope(a.tenantId, 'ingestAsset.asset');
    if (!Array.isArray(input.fields)) throw new TypeError('ingestAsset.fields must be an array');
    const k = this.key(a.id);
    this.assetsById.set(k, a);
    this.fieldsByAsset.set(k, [...input.fields]);
    if (!this.recordsByAsset.has(k)) this.recordsByAsset.set(k, new Map());
    return a;
  }

  // -------------------------------------------------------------------------
  // AC3 — INGEST a distinct source record for an asset. Distinct records are
  // retained by `sourceRecordIdentity`; re-observing the same identity replaces
  // its latest snapshot (never forks a duplicate).
  // -------------------------------------------------------------------------

  ingestSourceRecord(record: SourceRecord): SourceRecord {
    assertUuid(record.id, 'ingestSourceRecord.record.id');
    this.assertTenantScope(record.tenantId, 'ingestSourceRecord.record');
    if (record.assetId === undefined) {
      throw new RangeError('ingestSourceRecord.record must be linked to an asset (assetId)');
    }
    const k = this.key(record.assetId);
    let m = this.recordsByAsset.get(k);
    if (m === undefined) {
      m = new Map();
      this.recordsByAsset.set(k, m);
    }
    m.set(sourceRecordIdentity(record), record);
    return record;
  }

  // -------------------------------------------------------------------------
  // AC2/AC6 — INGEST a coverage gap. Component gaps (AC2) may bind to an asset
  // via `subjectId`; governed-source gaps (AC6) stand on their own. Gaps are
  // NEVER deleted — terminal states stay queryable.
  // -------------------------------------------------------------------------

  ingestCoverageGap(gap: CoverageGap): CoverageGap {
    assertUuid(gap.id, 'ingestCoverageGap.gap.id');
    this.assertTenantScope(gap.tenantId, 'ingestCoverageGap.gap');
    const gk = this.key(gap.id);
    this.gaps.set(gk, gap);
    if (gap.gapClass === 'component' && gap.subjectId !== undefined) {
      const ak = this.key(gap.subjectId);
      let s = this.componentGapsByAsset.get(ak);
      if (s === undefined) {
        s = new Set();
        this.componentGapsByAsset.set(ak, s);
      }
      s.add(gk);
    }
    return gap;
  }

  // -------------------------------------------------------------------------
  // AC5 — CATALOG a discovered source. Optionally associate it with an asset so
  // it surfaces in that asset's drill-down.
  // -------------------------------------------------------------------------

  ingestCatalogEntry(entry: SourceCatalogEntry, assetId?: Uuid): SourceCatalogEntry {
    assertUuid(entry.id, 'ingestCatalogEntry.entry.id');
    this.assertTenantScope(entry.tenantId, 'ingestCatalogEntry.entry');
    this.catalogById.set(this.key(entry.id), entry);
    if (assetId !== undefined) {
      assertUuid(assetId, 'ingestCatalogEntry.assetId');
      const ak = this.key(assetId);
      let s = this.catalogByAsset.get(ak);
      if (s === undefined) {
        s = new Set();
        this.catalogByAsset.set(ak, s);
      }
      s.add(this.key(entry.id));
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // AC3 — INGEST an inventory relationship (depends_on / authoritative_for),
  // bound to an asset for drill-down.
  // -------------------------------------------------------------------------

  ingestRelationship(rel: InventoryRelationship, assetId: Uuid): InventoryRelationship {
    assertUuid(rel.id, 'ingestRelationship.rel.id');
    this.assertTenantScope(rel.tenantId, 'ingestRelationship.rel');
    assertUuid(assetId, 'ingestRelationship.assetId');
    const rk = this.key(rel.id);
    this.relationships.set(rk, rel);
    const ak = this.key(assetId);
    let s = this.relationshipsByAsset.get(ak);
    if (s === undefined) {
      s = new Set();
      this.relationshipsByAsset.set(ak, s);
    }
    s.add(rk);
    return rel;
  }

  // =========================================================================
  // Query surface — every read is independent of any mutation's return value.
  // =========================================================================

  /** All governed assets (each once), stable-sorted by id (AC1). */
  assets(): readonly GovernedAsset[] {
    return [...this.assetsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The distinct source records observed for an asset (AC3). */
  sourceRecordsFor(assetId: Uuid): readonly SourceRecord[] {
    assertUuid(assetId, 'sourceRecordsFor.assetId');
    return [...(this.recordsByAsset.get(this.key(assetId))?.values() ?? [])].sort((a, b) =>
      sourceRecordIdentity(a).localeCompare(sourceRecordIdentity(b)),
    );
  }

  /** All coverage gaps (AC2/AC6), including resolved/terminal ones (history preserved). */
  coverageGaps(): readonly CoverageGap[] {
    return [...this.gaps.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The still-VISIBLE component coverage gaps (AC2). */
  componentGaps(): readonly CoverageGap[] {
    return this.coverageGaps().filter((g) => g.gapClass === 'component' && gapIsVisible(g));
  }

  /** The still-VISIBLE governed-source gaps that carry a review-or-expiry deadline (AC6). */
  governedSourceGaps(): readonly CoverageGap[] {
    return this.coverageGaps().filter(
      (g) => g.gapClass === 'governed_source' && gapIsVisible(g) && gapHasReviewOrExpiry(g),
    );
  }

  /** The component gaps bound to one asset (AC2). */
  gapsForAsset(assetId: Uuid): readonly CoverageGap[] {
    assertUuid(assetId, 'gapsForAsset.assetId');
    const ids = this.componentGapsByAsset.get(this.key(assetId)) ?? new Set<string>();
    return [...ids].map((k) => this.gaps.get(k)!).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Age of a gap at `now` (AC2/AC6 age facet). */
  gapAge(gapId: Uuid, now: EpochMillis): number {
    assertUuid(gapId, 'gapAge.gapId');
    assertEpoch(now, 'gapAge.now');
    const g = this.gaps.get(this.key(gapId));
    if (g === undefined) throw new RangeError(`unknown gap: ${gapId}`);
    return gapAgeMillis(g, now);
  }

  /** The full source catalog (AC5), stable-sorted by id. */
  catalog(): readonly SourceCatalogEntry[] {
    return [...this.catalogById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The AC5 catalog VIEW: each discovered source with type-or-unknown classification, location,
   * access status, sensitivity, ownership status, onboarding state, and discovery evidence. */
  catalogView(): readonly CatalogEntryView[] {
    return this.catalog().map((e) =>
      compact({
        catalogId: e.id,
        sourceClass: e.sourceClass,
        classifiedUnknown: e.sourceClass === UNKNOWN_SOURCE_CLASS,
        observedLocations: e.observedLocations,
        accessState: e.accessState,
        sensitivity: e.sensitivity,
        ownerPrincipalId: e.ownerPrincipalId,
        ownershipGap: catalogEntryHasOwnershipGap(e),
        onboardingState: e.onboardingState,
        discoveryEvidence: e.discoveryEvidence,
        entry: e,
      }),
    ) as CatalogEntryView[];
  }

  /** The inventory relationships bound to an asset (AC3). */
  relationshipsFor(assetId: Uuid): readonly InventoryRelationship[] {
    assertUuid(assetId, 'relationshipsFor.assetId');
    const ids = this.relationshipsByAsset.get(this.key(assetId)) ?? new Set<string>();
    return [...ids].map((k) => this.relationships.get(k)!).sort((a, b) => a.id.localeCompare(b.id));
  }

  // -------------------------------------------------------------------------
  // Composition — build the correlated item for one asset from its ingested
  // records / gaps / catalog / relationships (AC1/AC2/AC3/AC5/AC6 in one call).
  // -------------------------------------------------------------------------

  private correlate(assetId: Uuid, at: EpochMillis): CorrelatedItem {
    const k = this.key(assetId);
    const asset = this.assetsById.get(k);
    if (asset === undefined) throw new RangeError(`unknown asset: ${assetId}`);
    const fields = this.fieldsByAsset.get(k) ?? [];
    const records = this.sourceRecordsFor(assetId);
    const gaps = this.gapsForAsset(assetId);
    const rels = this.relationshipsFor(assetId);
    const catalogIds = this.catalogByAsset.get(k) ?? new Set<string>();
    const catalogEntries = [...catalogIds]
      .map((cid) => this.catalogById.get(cid)!)
      .sort((a, b) => a.id.localeCompare(b.id));
    return correlateAsset({
      tenantId: this.tenantId,
      assetId,
      policy: this.policy,
      fields,
      records,
      correlatedAt: at,
      asset,
      coverageGaps: gaps,
      relationships: rels,
      catalogEntries,
    });
  }

  /** The correlated item for one asset at `at` (composition entry point; also used by drill-down). */
  correlatedItem(assetId: Uuid, at: EpochMillis): CorrelatedItem {
    assertUuid(assetId, 'correlatedItem.assetId');
    assertEpoch(at, 'correlatedItem.at');
    return this.correlate(assetId, at);
  }

  // -------------------------------------------------------------------------
  // AC4 — staleness + confidence. A row is only fully confident when EVERY
  // contributing record is fresh at `at`; confidence decays with age and is
  // forced < 1 the moment any record is stale/suspect.
  // -------------------------------------------------------------------------

  private confidenceOf(records: readonly SourceRecord[], at: EpochMillis): number {
    if (records.length === 0) return 0;
    let min = 1;
    for (const r of records) {
      // A record already flagged non-fresh (freshness !== 'fresh') is never fully trusted.
      const suspect = sourceRecordFreshnessSuspect(r);
      const age = Math.max(0, at - r.lastKnownAt);
      let c: number;
      if (suspect) {
        c = Math.min(0.99, r.confidence);
      } else if (age < this.horizon) {
        c = r.confidence; // fresh: carry the record's own confidence.
      } else if (age < this.horizon * 2) {
        // decaying: linear across the second horizon-width, scaled by the record's confidence.
        c = r.confidence * (1 - (age - this.horizon) / this.horizon);
      } else {
        c = 0; // unavailable.
      }
      if (c < min) min = c;
    }
    return Math.min(1, Math.max(0, Number(min.toFixed(6))));
  }

  // -------------------------------------------------------------------------
  // AC1 + AC4 — the current-state view: one row per asset with the full facet
  // set, an AC4 staleness overlay (reportedHealth withheld unless current), and
  // AC2 component-gap binding.
  // -------------------------------------------------------------------------

  currentStateView(at: EpochMillis): readonly InventoryRow[] {
    assertEpoch(at, 'currentStateView.at');
    return this.assets().map((a) => this.inventoryRow(a, at));
  }

  /** The single row for one asset (AC1/AC2/AC4). */
  rowFor(assetId: Uuid, at: EpochMillis): InventoryRow {
    assertUuid(assetId, 'rowFor.assetId');
    assertEpoch(at, 'rowFor.at');
    const a = this.assetsById.get(this.key(assetId));
    if (a === undefined) throw new RangeError(`unknown asset: ${assetId}`);
    return this.inventoryRow(a, at);
  }

  private inventoryRow(a: GovernedAsset, at: EpochMillis): InventoryRow {
    const item = this.correlate(a.id, at);
    const facets = item.facets!; // always present — we always correlate WITH the governing asset.
    const records = item.sourceRecords;
    const confidence = this.confidenceOf(records, at);

    // AC2: a still-visible component gap keeps the row off the covered+healthy path.
    const visibleComponentGaps = this.gapsForAsset(a.id).filter(
      (g) => g.gapClass === 'component' && gapIsVisible(g),
    );
    const hasVisibleComponentGap = visibleComponentGaps.length > 0;

    // AC4: current health is only reported when evidence is current AND nothing is stale/suspect.
    const evidenceCurrent = facets.evidenceState === 'current' && confidence >= 1;
    const reportedHealth: AssetHealthState = evidenceCurrent ? facets.health : 'unknown';

    return compact({
      assetId: a.id,
      assetType: facets.assetType,
      name: facets.name,
      ownerPrincipalId: facets.ownerPrincipalId,
      ownershipGap: facets.ownershipGap || assetHasOwnershipGap(a),
      lifecycleState: facets.lifecycleState,
      riskTier: facets.riskTier,
      coverage: facets.coverage,
      observedHealth: facets.health,
      reportedHealth,
      evidenceState: facets.evidenceState,
      lastObservationAt: facets.lastObservationAt,
      unresolvedIssueCount: facets.unresolvedIssueCount,
      confidence,
      hasVisibleComponentGap,
      sourceRecordCount: records.length,
      version: a.version,
    }) as InventoryRow;
  }

  // -------------------------------------------------------------------------
  // AC3 — drill-down: distinct records, correlation (status differences),
  // dependencies, authoritative fields, catalog membership, visible gaps.
  // -------------------------------------------------------------------------

  drillDown(assetId: Uuid, at: EpochMillis): InventoryDrillDown {
    assertUuid(assetId, 'drillDown.assetId');
    assertEpoch(at, 'drillDown.at');
    const asset = this.assetsById.get(this.key(assetId));
    if (asset === undefined) throw new RangeError(`unknown asset: ${assetId}`);
    const item = this.correlate(assetId, at);
    return {
      assetId,
      asset,
      sourceRecords: item.sourceRecords,
      correlation: item,
      dependencies: item.dependencies,
      authoritativeFields: item.authoritativeFields,
      catalogEntries: item.catalogEntries,
      visibleGaps: item.coverageGaps.filter((g) => gapIsVisible(g.gap)),
    };
  }

  // -------------------------------------------------------------------------
  // Digest — the independently-observable durable-effect witness.
  // -------------------------------------------------------------------------

  /**
   * A stable content digest over the WHOLE inventory state (assets + records + gaps + catalog +
   * relationships) plus each asset's correlated-item digest at `at`. Changes iff any governed fact
   * changes; identical iff the state is identical. This is the durable-effect witness the tests
   * read INSTEAD of trusting a mutation's return value.
   */
  snapshotDigest(at: EpochMillis): string {
    assertEpoch(at, 'snapshotDigest.at');
    const parts: string[] = [];
    for (const a of this.assets()) {
      parts.push(governedAssetDigest(a));
      for (const r of this.sourceRecordsFor(a.id)) parts.push(sourceRecordDigest(r));
      // Fold the correlated view (facets/evidence/cases) into the witness at this instant.
      parts.push(correlatedItemDigest(this.correlate(a.id, at)));
    }
    for (const g of this.coverageGaps()) parts.push(coverageGapDigest(g));
    for (const e of this.catalog()) parts.push(sourceCatalogEntryDigest(e));
    for (const rel of this.relationships.values()) parts.push(inventoryRelationshipDigest(rel));
    return sha256(JSON.stringify(parts.sort()));
  }
}
