// @trustcircle/projections — the INVENTORY PROJECTOR (Phase 75 / work item F45MCD60YFGZ0WKBCE6565D3CZ).
//
// ─────────────────────────────────────────────────────────────────────────────
// Objective (the sole scoped deliverable):
//
//   "Project inventory, source catalog, correlation, provenance, and coverage gaps from ordered
//    events in packages/projections/src/inventory-projector.ts."
//
// This module is the PURE, DETERMINISTIC read-model FOLD. It sits ABOVE the durable transport
// (apps/projector's inbox consumer — Phase 28) and BELOW the API read routes (apps/api's inventory
// routes — Phase 73). The transport hands it governance-event envelopes IN AGGREGATE ORDER; this
// module folds them into the five read models the control plane serves:
//
//   1. INVENTORY      — one governed-asset row per asset (AC1), each carrying its full facet set.
//   2. SOURCE CATALOG — every discovered/registered source with class-or-unknown / location /
//                       access / sensitivity / ownership / onboarding state (AC5).
//   3. CORRELATION    — per-asset drill-down: distinct source records, field resolutions + status
//                       differences, dependency + authoritative-field edges (AC3).
//   4. PROVENANCE     — for every applied fact: the (event_id, aggregate_version, occurred_at,
//                       recorded_at, source_ref) that produced it; and for every NON-applied
//                       delivery (duplicate / out_of_order / gap / conflict / reject) an explicit,
//                       VISIBLE ledger entry — the ingest history is reconstructable, and an
//                       ambiguous/late/conflicting event is never silently applied.
//   5. COVERAGE GAPS  — component gaps (AC2) and governed-source gaps (AC6) that stay VISIBLE with
//                       reason / age / impact / required owner action (and review-or-expiry for
//                       governed-source gaps) — never healthy, never disappearing.
//
// The fold reuses (does NOT re-implement) two substrates:
//   • @trustcircle/contracts events.ts — VERSIONED + VALIDATED envelopes and the pure, total,
//     non-throwing per-aggregate ordering decision (applyDelivery / classifyDelivery). Only an
//     `apply` decision advances a read-model fact; every other decision is logged as provenance
//     and NEVER mutates the read model (safe under duplicate / delayed / partial / conflicting /
//     uncertain — GAR-008).
//   • @trustcircle/domain inventory.ts + correlation.ts — the asserting value factories
//     (makeGovernedAsset / makeSourceRecord / makeCoverageGap / makeSourceCatalogEntry /
//     makeInventoryRelationship) and the correlation engine (correlateAsset), which already encode
//     the AC1..AC6 invariants at the value level. A bad payload is rejected by the factory BEFORE
//     it can enter a read model — the projector never fabricates a fact the domain would refuse.
//
// AC4 (never infer current health/compliance from stale data) is enforced at the read surface: a
// row's reported health is WITHHELD (→ 'unknown') unless the evidence is `current` AND every
// contributing record is fresh at the query instant. Stale source data is surfaced WITH its
// last-known time and a confidence in [0,1] — the raw observation stays visible; only the
// INFERENCE is refused.
//
// Independently-observable durable-effect witness: every mutation returns the applied value, but
// the PROOF a test reads is the re-readable query surface + `snapshotDigest(at)` — a content hash
// over the whole read model that changes iff a governed fact changes and is identical iff the
// state is identical. The mutation response is never the proof; the re-readable digest is.
//
// Dependency-free beyond @trustcircle/domain, @trustcircle/contracts, and node:crypto. Pure: no
// wall-clock reads, no I/O. Runs under `npm ci` with no infrastructure, Node 22
// `--experimental-strip-types`.

import { createHash } from 'node:crypto';

import {
  type Uuid,
  type TenantId,
  type EpochMillis,
  type GovernedAsset,
  type SourceRecord,
  type CoverageGap,
  type SourceCatalogEntry,
  type InventoryRelationship,
  type CorrelatedItem,
  type CorrelatedItemFacets,
  type AssetHealthState,
  type EvidenceState,
  type CoverageGapView,
  type DependencyView,
  type AuthoritativeFieldView,
  type CatalogEntryView,
  type AssetLifecycleState,
  type RiskTier,
  type CoverageState,
  type OnboardingState,
  type AccessState,
  type CatalogHealthState,
  type CatalogSensitivity,
  type GapSubjectKind,
  type GapClass,
  type GapReason,
  type GapImpact,
  type GapStatus,
  type RelationshipKind,
  type RelationshipEndpointKind,
  makeGovernedAsset,
  makeSourceRecord,
  makeCoverageGap,
  makeSourceCatalogEntry,
  makeInventoryRelationship,
  correlateAsset,
  makeSourceAuthorityPolicy,
  type SourceAuthorityPolicy,
  sourceRecordIdentity,
  sourceRecordFreshnessSuspect,
  assetHasOwnershipGap,
  gapIsVisible,
  gapHasReviewOrExpiry,
  gapAgeMillis,
  governedAssetDigest,
  sourceRecordDigest,
  coverageGapDigest,
  sourceCatalogEntryDigest,
  inventoryRelationshipDigest,
  correlatedItemDigest,
  UNKNOWN_SOURCE_CLASS,
} from '@trustcircle/domain';

import {
  type AggregateState,
  type DeliveryClassification,
  type DeliveryDecision,
  emptyAggregateState,
  aggregateKey,
  applyDelivery,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Local guards + hashing (module-private, mirroring the domain's dependency-free style).
//    The domain does not export its assert/sha256 helpers, so the projector carries its own
//    tiny copies — every guard fails VISIBLY (a thrown, labelled error) rather than silently.
// ===========================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUuidLike(v: unknown): v is Uuid {
  return typeof v === 'string' && UUID_RE.test(v);
}

function reqUuid(v: unknown, label: string): Uuid {
  if (!isUuidLike(v)) throw new TypeError(`${label} must be a UUID`);
  return v;
}

function optUuid(v: unknown, label: string): Uuid | undefined {
  if (v === undefined || v === null) return undefined;
  return reqUuid(v, label);
}

function reqString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim() === '')
    throw new TypeError(`${label} must be a non-empty string`);
  return v;
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function reqEpoch(v: unknown, label: string): EpochMillis {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-millis`);
  }
  return v as EpochMillis;
}

function optEpoch(v: unknown, label: string): EpochMillis | undefined {
  if (v === undefined || v === null) return undefined;
  return reqEpoch(v, label);
}

/** RFC3339 → epoch millis (integer). Used to derive occurred/recorded times from the envelope. */
function rfc3339ToEpoch(v: unknown, label: string): EpochMillis {
  if (typeof v !== 'string') throw new TypeError(`${label} must be an RFC3339 timestamp`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new RangeError(`${label} is not a parseable RFC3339 timestamp`);
  return ms as EpochMillis;
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Strip `undefined`-valued keys so a factory's OPTIONAL fields stay absent (not explicitly
 * `undefined`) under `exactOptionalPropertyTypes`. Mirrors the domain's own `compact`. The return
 * type makes every property optional-and-defined so a `X | undefined` input satisfies a factory's
 * `X?` parameter (the runtime guarantees the key is absent when the value was `undefined`). */
function dropUndefined<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

// ===========================================================================
// 1. The projected event vocabulary.
//
// A governance event's `event_type` selects which read-model fold runs; its `data` block carries
// the value payload the corresponding domain factory validates. The projector is TOTAL over this
// vocabulary — an unknown `event_type` is folded as an explicit `ignored` provenance entry (never
// a throw, never a silent drop), so a forward-compatible producer cannot break the consumer.
// ===========================================================================

/** The inventory event types this projector folds. Each is a concrete `governance.*` event type
 * (the AsyncAPI envelope `event_type` pattern is `^governance\.[a-z0-9_.-]+$`, enforced by
 * `validateEnvelope`), so these literals are exactly what a producer stamps on the wire. */
export const INVENTORY_EVENT_TYPES = [
  'governance.inventory.asset.observed',
  'governance.inventory.source_record.observed',
  'governance.inventory.coverage_gap.raised',
  'governance.inventory.coverage_gap.resolved',
  'governance.inventory.source.discovered',
  'governance.inventory.relationship.asserted',
] as const;
export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];

function isInventoryEventType(t: string): t is InventoryEventType {
  return (INVENTORY_EVENT_TYPES as readonly string[]).includes(t);
}

// ===========================================================================
// 2. PROVENANCE — the reconstructable ingest ledger.
//
// Every delivery yields exactly one provenance entry. An `apply` entry records the fact it
// produced (kind + subject id) and its source attribution; a non-apply entry records WHY the
// event did not mutate the read model (duplicate / out_of_order / gap / conflict / reject /
// ignored). The ledger is append-only and independently readable — the ingest history (and any
// gap in it) is reconstructable without trusting a mutation's return value.
// ===========================================================================

/** The outcome recorded for one delivery, extending the contracts ordering decision with the
 * projector-specific `applied` / `ignored` outcomes. */
export type ProvenanceOutcome = DeliveryDecision | 'applied' | 'ignored';

/** The fact kinds an applied event can produce. */
export type ProjectedFactKind =
  'asset' | 'source_record' | 'coverage_gap' | 'catalog_entry' | 'relationship';

/** One append-only ingest-ledger entry. */
export interface ProvenanceEntry {
  readonly eventId: Uuid;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: Uuid;
  readonly aggregateVersion: number;
  readonly correlationId: Uuid;
  /** When the event OCCURRED at the source (from `occurred_at`). */
  readonly occurredAt: EpochMillis;
  /** When the event was RECORDED (from `recorded_at`). */
  readonly recordedAt: EpochMillis;
  /** The source reference (external system + revision + observed-at), when the envelope carries one. */
  readonly source?: {
    readonly sourceInstanceId: string;
    readonly externalId: string;
    readonly sourceRevision: string;
    readonly observedAt: EpochMillis;
    readonly orderingUncertain: boolean;
  };
  /** The ordering / fold outcome. `applied` ⇒ a fact was produced; everything else did NOT mutate. */
  readonly outcome: ProvenanceOutcome;
  /** For an applied entry: the fact kind + subject id produced. */
  readonly fact?: { readonly kind: ProjectedFactKind; readonly subjectId: Uuid };
  /** For an out_of_order / gap entry: the version the stream is waiting for. */
  readonly awaitingVersion?: number;
  /** Human-readable rationale (mirrors the contracts classification reason). */
  readonly reason: string;
}

// ===========================================================================
// 3. Read-model views.
// ===========================================================================

/** AC1 + AC4 — one inventory row per governed asset with the full facet set and the AC4 overlay. */
export interface InventoryRow {
  readonly assetId: Uuid;
  readonly assetType: string;
  readonly name: string;
  readonly ownerPrincipalId?: Uuid;
  readonly ownershipGap: boolean;
  readonly lifecycleState: AssetLifecycleState;
  readonly riskTier: RiskTier;
  readonly coverage: CoverageState;
  /** The health the asset RECORDED — always shown. */
  readonly observedHealth: AssetHealthState;
  /** AC4: the health SAFE to report as current — equal to `observedHealth` only when evidence is
   * `current` AND confidence is 1; otherwise `'unknown'`. Current health is NEVER inferred from
   * stale/incomplete evidence. */
  readonly reportedHealth: AssetHealthState;
  readonly evidenceState: EvidenceState;
  readonly lastObservationAt?: EpochMillis;
  readonly unresolvedIssueCount: number;
  /** AC4 confidence ∈ [0,1] in this row's currency at the query instant. */
  readonly confidence: number;
  /** True iff bound to at least one still-VISIBLE component gap (AC2) — never covered+healthy. */
  readonly hasVisibleComponentGap: boolean;
  readonly sourceRecordCount: number;
  readonly version: number;
  /** Provenance: the newest applied (event_id, version) that produced this asset fact. */
  readonly provenance?: { readonly eventId: Uuid; readonly aggregateVersion: number };
}

/** AC3 — the per-asset drill-down. */
export interface InventoryDrillDown {
  readonly assetId: Uuid;
  readonly asset: GovernedAsset;
  readonly sourceRecords: readonly SourceRecord[];
  readonly correlation: CorrelatedItem;
  readonly dependencies: readonly DependencyView[];
  readonly authoritativeFields: readonly AuthoritativeFieldView[];
  readonly catalogEntries: readonly CatalogEntryView[];
  readonly visibleGaps: readonly CoverageGapView[];
}

const DEFAULT_STALENESS_HORIZON = 15 * 60_000; // 15 minutes.

// ===========================================================================
// 4. Constructor input.
// ===========================================================================

export interface InventoryProjectorInput {
  readonly tenantId: TenantId;
  /** Optional shared authority policy for field resolution (AC3/AC5). A default empty-rule policy
   * is used when omitted; unknown/unregistered classes still resolve to a concrete rank. */
  readonly policy?: SourceAuthorityPolicy;
  /** Staleness horizon in millis (AC4): a record not seen within this window contributes staleness
   * and drops row confidence below 1. */
  readonly stalenessHorizonMillis?: number;
}

// ===========================================================================
// 5. The projector.
// ===========================================================================

/**
 * A tenant-scoped, in-memory inventory read model folded from ordered governance events. State is
 * keyed by subject id; every applied event returns the durable value AND leaves it independently
 * readable via the query surface. Pure + deterministic: no wall-clock reads, no I/O.
 */
export class InventoryProjector {
  private readonly tenantId: TenantId;
  private readonly policy: SourceAuthorityPolicy;
  private readonly horizon: number;

  /** Per-aggregate ordering state, keyed by the (tenant, aggregate_type, aggregate_id) key. */
  private readonly ordering = new Map<string, AggregateState>();

  /** Governed assets keyed by id — each renders ONCE (AC1). */
  private readonly assetsById = new Map<string, GovernedAsset>();
  /** Correlated fields per asset. */
  private readonly fieldsByAsset = new Map<string, string[]>();
  /** Distinct source records per asset, keyed by `sourceRecordIdentity` (AC3). */
  private readonly recordsByAsset = new Map<string, Map<string, SourceRecord>>();
  /** All coverage gaps keyed by gap id (AC2/AC6) — never deleted (history preserved). */
  private readonly gaps = new Map<string, CoverageGap>();
  /** Component gap ids bound to an asset (AC2), keyed by asset id. */
  private readonly componentGapsByAsset = new Map<string, Set<string>>();
  /** Catalog entries keyed by id (AC5). */
  private readonly catalogById = new Map<string, SourceCatalogEntry>();
  /** Catalog ids associated with an asset, for drill-down (AC5). */
  private readonly catalogByAsset = new Map<string, Set<string>>();
  /** Inventory relationships keyed by id (AC3). */
  private readonly relationships = new Map<string, InventoryRelationship>();
  /** Relationship ids bound to an asset (AC3), keyed by asset id. */
  private readonly relationshipsByAsset = new Map<string, Set<string>>();

  /** Provenance of the newest applied fact per subject id (for the row/catalog attribution). */
  private readonly factProvenance = new Map<string, { eventId: Uuid; aggregateVersion: number }>();
  /** The append-only ingest ledger (AC-agnostic provenance surface). */
  private readonly ledger: ProvenanceEntry[] = [];

  constructor(input: InventoryProjectorInput) {
    if (!(input.tenantId === 'platform' || isUuidLike(input.tenantId))) {
      throw new TypeError('projector.tenantId must be a TenantId');
    }
    const horizon = input.stalenessHorizonMillis ?? DEFAULT_STALENESS_HORIZON;
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new RangeError('projector.stalenessHorizonMillis must be a positive integer');
    }
    this.tenantId = input.tenantId;
    this.policy = input.policy ?? makeSourceAuthorityPolicy({ id: 'projector-default-policy' });
    this.horizon = horizon;
  }

  private key(id: Uuid): string {
    return String(id);
  }

  // =========================================================================
  // 5.1 Ingest — fold one ordered governance event.
  // =========================================================================

  /**
   * Fold ONE governance-event envelope into the read model, returning the provenance entry the fold
   * produced. The delivery is VERSIONED + VALIDATED and ORDERED via the contracts tracker
   * (applyDelivery) over the (tenant, aggregate_type, aggregate_id) key: ONLY an `apply` decision
   * mutates a read model. A duplicate / out_of_order / gap / conflict / reject delivery is recorded
   * as a visible provenance entry and leaves the read model untouched — safe under duplicate /
   * delayed / partial / conflicting / uncertain (GAR-008). The envelope's `tenant_id` must match
   * the projector scope; a cross-tenant envelope is rejected.
   *
   * Deterministic + idempotent: re-delivering the same envelope yields a `duplicate` (no second
   * effect); the same ordered batch always yields the same read model and the same digest.
   */
  ingestEvent(envelope: unknown): ProvenanceEntry {
    if (!isPlainObject(envelope)) {
      throw new TypeError('ingestEvent.envelope must be an object');
    }

    // Tenant scope: an envelope for another tenant never touches this projector.
    const tenant = envelope['tenant_id'];
    if (tenant !== undefined && tenant !== this.tenantId) {
      throw new RangeError('ingestEvent: envelope tenant_id is outside this projector scope');
    }

    // Order + validate through the contracts tracker.
    const akey = this.orderingKeyOf(envelope);
    const prior = this.ordering.get(akey) ?? emptyAggregateState();
    const { state, classification } = applyDelivery(prior, envelope);
    this.ordering.set(akey, state);

    // Only an `apply` decision folds a fact into a read model.
    if (classification.decision === 'apply') {
      return this.applyFact(envelope as Record<string, unknown>, classification);
    }

    // Every non-apply decision is a visible provenance entry (no read-model mutation).
    return this.record(
      envelope,
      this.mapDecision(classification.decision),
      classification,
      undefined,
    );
  }

  /**
   * Fold an ordered BATCH of envelopes (in arrival order), returning every per-event provenance
   * entry. Convenience over `ingestEvent`; the ordering tracker still classifies each delivery.
   */
  ingestBatch(envelopes: readonly unknown[]): readonly ProvenanceEntry[] {
    if (!Array.isArray(envelopes)) throw new TypeError('ingestBatch.envelopes must be an array');
    return envelopes.map((e) => this.ingestEvent(e));
  }

  private orderingKeyOf(env: Record<string, unknown>): string {
    return aggregateKey({
      tenant_id: String(env['tenant_id'] ?? this.tenantId),
      aggregate_type: String(env['aggregate_type'] ?? ''),
      aggregate_id: String(env['aggregate_id'] ?? ''),
    });
  }

  private mapDecision(d: DeliveryDecision): ProvenanceOutcome {
    return d;
  }

  /** Apply a validated, in-order event to the read model, dispatching on `event_type`. */
  private applyFact(
    env: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const eventType = String(env['event_type'] ?? '');
    if (!isInventoryEventType(eventType)) {
      // A validated, in-order event of an UNKNOWN type advances ordering but produces no fact —
      // recorded as `ignored` (forward-compatibility; never a throw, never a silent drop).
      return this.record(env, 'ignored', classification, undefined);
    }

    const data = isPlainObject(env['data']) ? env['data'] : {};
    switch (eventType) {
      case 'governance.inventory.asset.observed':
        return this.foldAsset(env, data, classification);
      case 'governance.inventory.source_record.observed':
        return this.foldSourceRecord(env, data, classification);
      case 'governance.inventory.coverage_gap.raised':
        return this.foldGapRaised(env, data, classification);
      case 'governance.inventory.coverage_gap.resolved':
        return this.foldGapResolved(env, data, classification);
      case 'governance.inventory.source.discovered':
        return this.foldCatalogEntry(env, data, classification);
      case 'governance.inventory.relationship.asserted':
        return this.foldRelationship(env, data, classification);
    }
  }

  // ---- AC1: an asset observation renders once, keyed by asset id. ----------
  private foldAsset(
    env: Record<string, unknown>,
    data: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const asset = makeGovernedAsset({
      id: reqUuid(data['id'], 'asset.id'),
      tenantId: this.tenantId,
      assetType: reqString(data['assetType'], 'asset.assetType'),
      name: reqString(data['name'], 'asset.name'),
      updatedAt: optEpoch(data['updatedAt'], 'asset.updatedAt') ?? this.occurredAtOf(env),
      ...dropUndefined({
        ownerPrincipalId: optUuid(data['ownerPrincipalId'], 'asset.ownerPrincipalId'),
        lifecycleState: data['lifecycleState'] as AssetLifecycleState | undefined,
        riskTier: data['riskTier'] as RiskTier | undefined,
        health: data['health'] as AssetHealthState | undefined,
        coverage: data['coverage'] as CoverageState | undefined,
        lastObservedAt: optEpoch(data['lastObservedAt'], 'asset.lastObservedAt'),
        version: typeof data['version'] === 'number' ? data['version'] : undefined,
      }),
    });
    const k = this.key(asset.id);
    this.assetsById.set(k, asset);
    const fields = Array.isArray(data['fields'])
      ? (data['fields'] as unknown[]).map((f, i) => reqString(f, `asset.fields[${i}]`))
      : [];
    this.fieldsByAsset.set(k, fields);
    if (!this.recordsByAsset.has(k)) this.recordsByAsset.set(k, new Map());
    return this.record(env, 'applied', classification, { kind: 'asset', subjectId: asset.id });
  }

  // ---- AC3: a distinct source record observation, retained by identity. ----
  private foldSourceRecord(
    env: Record<string, unknown>,
    data: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const record = makeSourceRecord({
      id: reqUuid(data['id'], 'record.id'),
      tenantId: this.tenantId,
      catalogId: reqUuid(data['catalogId'], 'record.catalogId'),
      sourceClass: reqString(data['sourceClass'], 'record.sourceClass'),
      externalKey: reqString(data['externalKey'], 'record.externalKey'),
      lastKnownAt: optEpoch(data['lastKnownAt'], 'record.lastKnownAt') ?? this.observedAtOf(env),
      observedAt: optEpoch(data['observedAt'], 'record.observedAt') ?? this.observedAtOf(env),
      ...dropUndefined({
        assetId: optUuid(data['assetId'], 'record.assetId'),
        observedState: isPlainObject(data['observedState']) ? data['observedState'] : undefined,
        status: data['status'] as SourceRecord['status'] | undefined,
        freshness: data['freshness'] as SourceRecord['freshness'] | undefined,
        confidence: typeof data['confidence'] === 'number' ? data['confidence'] : undefined,
      }),
    });
    if (record.assetId === undefined) {
      throw new RangeError('governance.inventory.source_record.observed requires data.assetId');
    }
    const k = this.key(record.assetId);
    let m = this.recordsByAsset.get(k);
    if (m === undefined) {
      m = new Map();
      this.recordsByAsset.set(k, m);
    }
    m.set(sourceRecordIdentity(record), record);
    return this.record(env, 'applied', classification, {
      kind: 'source_record',
      subjectId: record.id,
    });
  }

  // ---- AC2/AC6: a coverage gap is raised and stays visible (never deleted). -
  private foldGapRaised(
    env: Record<string, unknown>,
    data: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const gap = makeCoverageGap({
      id: reqUuid(data['id'], 'gap.id'),
      tenantId: this.tenantId,
      subjectKind: reqString(data['subjectKind'], 'gap.subjectKind') as GapSubjectKind,
      reason: reqString(data['reason'], 'gap.reason') as GapReason,
      requiredAction: reqString(data['requiredAction'], 'gap.requiredAction'),
      firstSeenAt: optEpoch(data['firstSeenAt'], 'gap.firstSeenAt') ?? this.occurredAtOf(env),
      ...dropUndefined({
        subjectId: optUuid(data['subjectId'], 'gap.subjectId'),
        gapClass: data['gapClass'] as GapClass | undefined,
        impact: data['impact'] as GapImpact | undefined,
        requiredOwner: optUuid(data['requiredOwner'], 'gap.requiredOwner'),
        status: data['status'] as GapStatus | undefined,
        reviewAt: optEpoch(data['reviewAt'], 'gap.reviewAt'),
        expiresAt: optEpoch(data['expiresAt'], 'gap.expiresAt'),
      }),
    });
    this.storeGap(gap);
    return this.record(env, 'applied', classification, {
      kind: 'coverage_gap',
      subjectId: gap.id,
    });
  }

  // ---- AC2/AC6: a coverage gap is resolved — the terminal state stays queryable. ----
  private foldGapResolved(
    env: Record<string, unknown>,
    data: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const gapId = reqUuid(data['id'], 'gap.id');
    const existing = this.gaps.get(this.key(gapId));
    if (existing === undefined) {
      throw new RangeError(`governance.inventory.coverage_gap.resolved: unknown gap ${gapId}`);
    }
    const resolvedAt = optEpoch(data['resolvedAt'], 'gap.resolvedAt') ?? this.occurredAtOf(env);
    const resolution = reqString(data['resolution'], 'gap.resolution');
    // Rebuild the gap value in its terminal `resolved` state (the factory enforces the
    // resolution-when-resolved invariant). It stays in the map — history is preserved.
    const resolved = makeCoverageGap({
      id: existing.id,
      tenantId: existing.tenantId,
      subjectKind: existing.subjectKind,
      gapClass: existing.gapClass,
      reason: existing.reason,
      impact: existing.impact,
      requiredAction: existing.requiredAction,
      status: 'resolved',
      resolution,
      firstSeenAt: existing.firstSeenAt,
      resolvedAt,
      ...dropUndefined({
        subjectId: existing.subjectId,
        requiredOwner: existing.requiredOwner,
        reviewAt: existing.reviewAt,
        expiresAt: existing.expiresAt,
      }),
    });
    this.storeGap(resolved);
    return this.record(env, 'applied', classification, {
      kind: 'coverage_gap',
      subjectId: resolved.id,
    });
  }

  private storeGap(gap: CoverageGap): void {
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
  }

  // ---- AC5: a discovered source is catalogued (optionally bound to an asset). ----
  private foldCatalogEntry(
    env: Record<string, unknown>,
    data: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const firstSeen =
      optEpoch(data['firstSeenAt'], 'catalog.firstSeenAt') ?? this.occurredAtOf(env);
    const entry = makeSourceCatalogEntry({
      id: reqUuid(data['id'], 'catalog.id'),
      tenantId: this.tenantId,
      // A discovered source with no declared class is pinned to the UNKNOWN sentinel (AC5).
      sourceClass: optString(data['sourceClass']) ?? UNKNOWN_SOURCE_CLASS,
      firstSeenAt: firstSeen,
      lastSeenAt: optEpoch(data['lastSeenAt'], 'catalog.lastSeenAt') ?? firstSeen,
      ...dropUndefined({
        boundaryId: optUuid(data['boundaryId'], 'catalog.boundaryId'),
        observedLocations: Array.isArray(data['observedLocations'])
          ? (data['observedLocations'] as unknown[]).map((l, i) =>
              reqString(l, `catalog.observedLocations[${i}]`),
            )
          : undefined,
        ownerPrincipalId: optUuid(data['ownerPrincipalId'], 'catalog.ownerPrincipalId'),
        onboardingState: data['onboardingState'] as OnboardingState | undefined,
        accessState: data['accessState'] as AccessState | undefined,
        healthState: data['healthState'] as CatalogHealthState | undefined,
        sensitivity: data['sensitivity'] as CatalogSensitivity | undefined,
        discoveryEvidence: optUuid(data['discoveryEvidence'], 'catalog.discoveryEvidence'),
        coverageGapIds: Array.isArray(data['coverageGapIds'])
          ? (data['coverageGapIds'] as unknown[]).map((g, i) =>
              reqUuid(g, `catalog.coverageGapIds[${i}]`),
            )
          : undefined,
      }),
    });
    this.catalogById.set(this.key(entry.id), entry);
    const assetId = optUuid(data['assetId'], 'catalog.assetId');
    if (assetId !== undefined) {
      const ak = this.key(assetId);
      let s = this.catalogByAsset.get(ak);
      if (s === undefined) {
        s = new Set();
        this.catalogByAsset.set(ak, s);
      }
      s.add(this.key(entry.id));
    }
    return this.record(env, 'applied', classification, {
      kind: 'catalog_entry',
      subjectId: entry.id,
    });
  }

  // ---- AC3: a relationship edge (depends_on / authoritative_for / correlates …). ----
  private foldRelationship(
    env: Record<string, unknown>,
    data: Record<string, unknown>,
    classification: DeliveryClassification,
  ): ProvenanceEntry {
    const rel = makeInventoryRelationship({
      id: reqUuid(data['id'], 'relationship.id'),
      tenantId: this.tenantId,
      fromKind: reqString(data['fromKind'], 'relationship.fromKind') as RelationshipEndpointKind,
      fromId: reqUuid(data['fromId'], 'relationship.fromId'),
      toKind: reqString(data['toKind'], 'relationship.toKind') as RelationshipEndpointKind,
      toId: reqUuid(data['toId'], 'relationship.toId'),
      relationship: reqString(
        data['relationship'],
        'relationship.relationship',
      ) as RelationshipKind,
      createdAt: optEpoch(data['createdAt'], 'relationship.createdAt') ?? this.occurredAtOf(env),
      ...dropUndefined({
        fieldName: optString(data['fieldName']),
        authoritative:
          typeof data['authoritative'] === 'boolean' ? data['authoritative'] : undefined,
      }),
    });
    const assetId = reqUuid(data['assetId'], 'relationship.assetId');
    this.relationships.set(this.key(rel.id), rel);
    const ak = this.key(assetId);
    let s = this.relationshipsByAsset.get(ak);
    if (s === undefined) {
      s = new Set();
      this.relationshipsByAsset.set(ak, s);
    }
    s.add(this.key(rel.id));
    return this.record(env, 'applied', classification, {
      kind: 'relationship',
      subjectId: rel.id,
    });
  }

  // ---- Provenance recording (append-only ledger + newest-fact attribution). ----
  private occurredAtOf(env: Record<string, unknown>): EpochMillis {
    return rfc3339ToEpoch(env['occurred_at'], 'envelope.occurred_at');
  }

  private observedAtOf(env: Record<string, unknown>): EpochMillis {
    const src = env['source'];
    if (isPlainObject(src) && typeof src['observed_at'] === 'string') {
      return rfc3339ToEpoch(src['observed_at'], 'envelope.source.observed_at');
    }
    return this.occurredAtOf(env);
  }

  private record(
    env: Record<string, unknown>,
    outcome: ProvenanceOutcome,
    classification: DeliveryClassification,
    fact: { kind: ProjectedFactKind; subjectId: Uuid } | undefined,
  ): ProvenanceEntry {
    const src = env['source'];
    const source =
      isPlainObject(src) && typeof src['source_instance_id'] === 'string'
        ? {
            sourceInstanceId: String(src['source_instance_id']),
            externalId: String(src['external_id'] ?? ''),
            sourceRevision: String(src['source_revision'] ?? ''),
            observedAt: rfc3339ToEpoch(src['observed_at'], 'source.observed_at'),
            orderingUncertain: src['ordering_uncertain'] === true,
          }
        : undefined;

    const entry: ProvenanceEntry = {
      eventId: reqUuid(env['event_id'], 'envelope.event_id'),
      eventType: String(env['event_type'] ?? ''),
      aggregateType: String(env['aggregate_type'] ?? ''),
      aggregateId: reqUuid(env['aggregate_id'], 'envelope.aggregate_id'),
      aggregateVersion:
        typeof env['aggregate_version'] === 'number' ? env['aggregate_version'] : -1,
      correlationId: reqUuid(env['correlation_id'], 'envelope.correlation_id'),
      occurredAt: this.occurredAtOf(env),
      recordedAt: rfc3339ToEpoch(env['recorded_at'], 'envelope.recorded_at'),
      ...(source ? { source } : {}),
      outcome,
      ...(fact ? { fact } : {}),
      ...(classification.awaitingVersion !== undefined
        ? { awaitingVersion: classification.awaitingVersion }
        : {}),
      reason: classification.reason,
    };
    this.ledger.push(entry);
    if (fact) {
      this.factProvenance.set(this.key(fact.subjectId), {
        eventId: entry.eventId,
        aggregateVersion: entry.aggregateVersion,
      });
    }
    return entry;
  }

  // =========================================================================
  // 5.2 PROVENANCE query surface.
  // =========================================================================

  /** The full append-only ingest ledger (every delivery, applied or not) in arrival order. */
  provenance(): readonly ProvenanceEntry[] {
    return [...this.ledger];
  }

  /** The ledger entries for one subject id (asset / record / gap / catalog / relationship). */
  provenanceFor(subjectId: Uuid): readonly ProvenanceEntry[] {
    const k = this.key(subjectId);
    return this.ledger.filter((e) => e.fact !== undefined && this.key(e.fact.subjectId) === k);
  }

  /** The deliveries that did NOT apply (duplicate / out_of_order / gap / conflict / reject /
   * ignored) — the fail-visible set an operator inspects to reconcile ingest. */
  unappliedDeliveries(): readonly ProvenanceEntry[] {
    return this.ledger.filter((e) => e.outcome !== 'applied');
  }

  /** The last contiguously-applied aggregate version for one aggregate (0 = nothing applied). */
  lastAppliedVersion(aggregateType: string, aggregateId: Uuid): number {
    const akey = aggregateKey({
      tenant_id: String(this.tenantId),
      aggregate_type: aggregateType,
      aggregate_id: String(aggregateId),
    });
    return this.ordering.get(akey)?.lastAppliedVersion ?? 0;
  }

  // =========================================================================
  // 5.3 Query surface — every read is independent of any mutation's return value.
  // =========================================================================

  /** All governed assets (each once), stable-sorted by id (AC1). */
  assets(): readonly GovernedAsset[] {
    return [...this.assetsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The distinct source records observed for an asset (AC3). */
  sourceRecordsFor(assetId: Uuid): readonly SourceRecord[] {
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

  /** The still-VISIBLE governed-source gaps carrying a review-or-expiry deadline (AC6). */
  governedSourceGaps(): readonly CoverageGap[] {
    return this.coverageGaps().filter(
      (g) => g.gapClass === 'governed_source' && gapIsVisible(g) && gapHasReviewOrExpiry(g),
    );
  }

  /** The component gaps bound to one asset (AC2). */
  gapsForAsset(assetId: Uuid): readonly CoverageGap[] {
    const ids = this.componentGapsByAsset.get(this.key(assetId)) ?? new Set<string>();
    return [...ids].map((k) => this.gaps.get(k)!).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Age of a gap at `now` (AC2/AC6 age facet). */
  gapAge(gapId: Uuid, now: EpochMillis): number {
    const g = this.gaps.get(this.key(gapId));
    if (g === undefined) throw new RangeError(`unknown gap: ${gapId}`);
    return gapAgeMillis(g, reqEpoch(now, 'gapAge.now'));
  }

  /** The full source catalog (AC5), stable-sorted by id. */
  catalog(): readonly SourceCatalogEntry[] {
    return [...this.catalogById.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The inventory relationships bound to an asset (AC3). */
  relationshipsFor(assetId: Uuid): readonly InventoryRelationship[] {
    const ids = this.relationshipsByAsset.get(this.key(assetId)) ?? new Set<string>();
    return [...ids].map((k) => this.relationships.get(k)!).sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---- Composition — correlate one asset from its ingested facts. ----------
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

  /** The correlated item for one asset at `at`. */
  correlatedItem(assetId: Uuid, at: EpochMillis): CorrelatedItem {
    return this.correlate(
      reqUuid(assetId, 'correlatedItem.assetId'),
      reqEpoch(at, 'correlatedItem.at'),
    );
  }

  // ---- AC4 — staleness + confidence. ----
  private confidenceOf(records: readonly SourceRecord[], at: EpochMillis): number {
    if (records.length === 0) return 0;
    let min = 1;
    for (const r of records) {
      const suspect = sourceRecordFreshnessSuspect(r);
      const age = Math.max(0, at - r.lastKnownAt);
      let c: number;
      if (suspect) {
        c = Math.min(0.99, r.confidence);
      } else if (age < this.horizon) {
        c = r.confidence;
      } else if (age < this.horizon * 2) {
        c = r.confidence * (1 - (age - this.horizon) / this.horizon);
      } else {
        c = 0;
      }
      if (c < min) min = c;
    }
    return Math.min(1, Math.max(0, Number(min.toFixed(6))));
  }

  // ---- AC1 + AC4 — the current-state view. ----
  currentStateView(at: EpochMillis): readonly InventoryRow[] {
    reqEpoch(at, 'currentStateView.at');
    return this.assets().map((a) => this.inventoryRow(a, at));
  }

  /** The single row for one asset (AC1/AC2/AC4). */
  rowFor(assetId: Uuid, at: EpochMillis): InventoryRow {
    const a = this.assetsById.get(this.key(reqUuid(assetId, 'rowFor.assetId')));
    if (a === undefined) throw new RangeError(`unknown asset: ${assetId}`);
    return this.inventoryRow(a, reqEpoch(at, 'rowFor.at'));
  }

  private inventoryRow(a: GovernedAsset, at: EpochMillis): InventoryRow {
    const item = this.correlate(a.id, at);
    const facets = item.facets as CorrelatedItemFacets; // always present — we correlate WITH the asset.
    const records = item.sourceRecords;
    const confidence = this.confidenceOf(records, at);

    const visibleComponentGaps = this.gapsForAsset(a.id).filter(
      (g) => g.gapClass === 'component' && gapIsVisible(g),
    );
    const hasVisibleComponentGap = visibleComponentGaps.length > 0;

    // AC4: current health only when evidence is current AND nothing is stale/suspect.
    const evidenceCurrent = facets.evidenceState === 'current' && confidence >= 1;
    const reportedHealth: AssetHealthState = evidenceCurrent ? facets.health : 'unknown';

    const prov = this.factProvenance.get(this.key(a.id));

    const row: InventoryRow = {
      assetId: a.id,
      assetType: facets.assetType,
      name: facets.name,
      ...(facets.ownerPrincipalId ? { ownerPrincipalId: facets.ownerPrincipalId } : {}),
      ownershipGap: facets.ownershipGap || assetHasOwnershipGap(a),
      lifecycleState: facets.lifecycleState,
      riskTier: facets.riskTier,
      coverage: facets.coverage,
      observedHealth: facets.health,
      reportedHealth,
      evidenceState: facets.evidenceState,
      ...(facets.lastObservationAt !== undefined
        ? { lastObservationAt: facets.lastObservationAt }
        : {}),
      unresolvedIssueCount: facets.unresolvedIssueCount,
      confidence,
      hasVisibleComponentGap,
      sourceRecordCount: records.length,
      version: a.version,
      ...(prov ? { provenance: prov } : {}),
    };
    return row;
  }

  // ---- AC3 — drill-down. ----
  drillDown(assetId: Uuid, at: EpochMillis): InventoryDrillDown {
    const id = reqUuid(assetId, 'drillDown.assetId');
    const asset = this.assetsById.get(this.key(id));
    if (asset === undefined) throw new RangeError(`unknown asset: ${assetId}`);
    const item = this.correlate(id, reqEpoch(at, 'drillDown.at'));
    return {
      assetId: id,
      asset,
      sourceRecords: item.sourceRecords,
      correlation: item,
      dependencies: item.dependencies,
      authoritativeFields: item.authoritativeFields,
      catalogEntries: item.catalogEntries,
      visibleGaps: item.coverageGaps.filter((g) => gapIsVisible(g.gap)),
    };
  }

  // =========================================================================
  // 5.4 Digest — the independently-observable durable-effect witness.
  // =========================================================================

  /**
   * A stable content digest over the WHOLE read model (assets + records + gaps + catalog +
   * relationships + each asset's correlated view at `at` + the provenance ledger). Changes iff a
   * governed fact or an ingest outcome changes; identical iff the state is identical. This is the
   * witness a test reads INSTEAD of trusting any mutation's return value.
   */
  snapshotDigest(at: EpochMillis): string {
    reqEpoch(at, 'snapshotDigest.at');
    const parts: string[] = [];
    for (const a of this.assets()) {
      parts.push(governedAssetDigest(a));
      for (const r of this.sourceRecordsFor(a.id)) parts.push(sourceRecordDigest(r));
      parts.push(correlatedItemDigest(this.correlate(a.id, at)));
    }
    for (const g of this.coverageGaps()) parts.push(coverageGapDigest(g));
    for (const e of this.catalog()) parts.push(sourceCatalogEntryDigest(e));
    for (const rel of [...this.relationships.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      parts.push(inventoryRelationshipDigest(rel));
    }
    // Fold the provenance ledger so ingest history is part of the witness.
    for (const p of this.ledger) {
      parts.push(
        sha256(
          JSON.stringify([
            p.eventId,
            p.aggregateType,
            p.aggregateId,
            p.aggregateVersion,
            p.outcome,
            p.fact?.kind ?? null,
            p.fact?.subjectId ?? null,
          ]),
        ),
      );
    }
    return sha256(JSON.stringify(parts));
  }
}
