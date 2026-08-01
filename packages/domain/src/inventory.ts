// @trustcircle/domain — inventory & open-ended source-catalog aggregates (Phase 63 /
// VO-6acaf6470d0810df4c93 open-ended catalog + reconciled inventory current & fail-visible /
// VO-53a014009bdfebd7af13 stale-state signaling).
//
// This module is the value-level, dependency-free (node:crypto only) form of the durable
// inventory substrate authored in `db/migrations/0010_inventory.sql`. It is aligned
// column-for-column with that migration and with the governance-api `SourceCatalogEntry` /
// `GovernedAsset` contract, so a projection over the physical rows and an in-memory aggregate
// share ONE vocabulary and ONE set of invariants. Each of the five aggregates
// (inventory-boundary, source-catalog [catalog entry + source contract], source-record,
// governed-asset, coverage-gap), plus the supporting inventory-relationship and correlation-case
// edges, is constructed through an ASSERTING factory that refuses a write violating a
// fail-visible CHECK, and exposes a `*Digest` sha256 content-hash as an independently-observable
// durable-effect witness (the mutation response is never the proof; the re-readable digest is).
//
// Acceptance-criterion map (each backed by an asserting invariant here + a test in
// tests/unit/inventory-aggregates.unit.test.ts):
//   AC1 healthy connected source renders ONCE with the full governed facet set →
//       makeGovernedAsset (type/owner/lifecycle/risk/coverage/health/last-observation/version).
//   AC2 discovered-but-unmanaged/unreachable/stale/orphaned/excluded component stays a VISIBLE
//       coverage gap (reason/age/impact/owner action) → makeCoverageGap + gapAgeMillis.
//   AC3 related work across Kanban/agentctl/workflows_orchestration → DISTINCT source records
//       (sourceRecordIdentity), correlation + dependency + authoritative-field attribution
//       (makeInventoryRelationship), status differences held for a human (makeCorrelationCase).
//   AC4 stale/unavailable source → makeSourceRecord marks freshness + last_known_at + confidence;
//       the `stale` mirror cannot disagree with the enum; health/status is read from the observed
//       field, never inferred from a stale row.
//   AC5 unregistered governance-relevant source in a declared boundary → makeSourceCatalogEntry
//       with discovery evidence, type-or-'unknown' class, observed locations, access/sensitivity/
//       ownership/onboarding state.
//   AC6 unsupported/inaccessible/sensitive/unowned/excluded discovered source → stays a VISIBLE
//       governed-source gap (gapClass='governed_source') with reason/impact/owner action +
//       review-or-expiry → makeCoverageGap.
//
// Fail-visible invariants mirrored from 0010_inventory.sql (rejected at construction, never
// silently stored):
//   * source_catalog_entry_unonboarded_not_healthy — a source not 'onboarded' may not be 'healthy'.
//   * source_catalog_entry_seen_ordered           — last_seen_at ≥ first_seen_at.
//   * source_record_stale_agrees                  — stale ⇔ freshness = 'stale'.
//   * source_record_confidence_range              — confidence ∈ [0,1].
//   * governed_asset_covered_is_managed           — coverage='covered' ⇒ not unmanaged/orphaned.
//   * inventory_relationship_field_when_authoritative — authoritative_for edge names its field.
//   * correlation_case_resolution_when_terminal   — terminal case ⇔ (resolution ∧ resolved time).
//   * coverage_gap_action_present                 — a gap always names a non-empty owner action.
//   * coverage_gap_resolution_when_resolved       — resolved gap ⇔ (resolution ∧ resolved time).

import { createHash } from 'node:crypto';
import {
  isUuid,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
} from './primitives.ts';

// ===========================================================================
// 0. Shared helpers
// ===========================================================================
// `EpochMillis` (BIGINT epoch millis in the SQL) is re-used from primitives.ts so the whole
// domain package shares one timestamp type; it is NOT re-declared here to avoid a barrel
// duplicate-export ambiguity.

function assertEpoch(ms: unknown, label: string): asserts ms is EpochMillis {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${String(ms)}`);
  }
}

function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertTenant(t: unknown, label: string): asserts t is TenantId {
  if (t !== PLATFORM_SCOPE && !isUuid(t)) {
    throw new TypeError(`${label} must be a tenant UUID or the platform scope`);
  }
}

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}

function assertOptionalUuid(id: unknown, label: string): asserts id is Uuid | undefined {
  if (id !== undefined && id !== null && !isUuid(id)) {
    throw new TypeError(`${label}, when present, must be a UUID`);
  }
}

function assertMember<T extends string>(
  v: unknown,
  allowed: readonly T[],
  label: string,
): asserts v is T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new TypeError(`${label} must be one of ${allowed.join('|')}, got ${String(v)}`);
  }
}

function assertStringArray(xs: unknown, label: string): asserts xs is readonly string[] {
  if (!Array.isArray(xs)) throw new TypeError(`${label} must be an array of strings`);
  for (const x of xs) {
    if (typeof x !== 'string' || x.trim().length === 0) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Drop keys whose value is `undefined`, so a constructed aggregate never carries an EXPLICIT
 * `undefined` for an optional field. Required under `exactOptionalPropertyTypes: true`
 * (tsconfig.base.json): with that flag on, `{ optionalKey?: T }` rejects an explicit `undefined`
 * value, so an absent optional field must be OMITTED, not set to `undefined`. Returning the
 * frozen result keeps each aggregate immutable.
 */
function compact<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.freeze(out) as T;
}

// ===========================================================================
// 1. inventory_boundary — the governed discovery SCOPE.
//    Mirrors table `inventory_boundary` (status draft/active/retired, version ≥ 1).
// ===========================================================================

export const BOUNDARY_STATUSES = ['draft', 'active', 'retired'] as const;
export type BoundaryStatus = (typeof BOUNDARY_STATUSES)[number];

export interface InventoryBoundary {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly version: number;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly status: BoundaryStatus;
  readonly createdAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export function makeInventoryBoundary(input: {
  id: Uuid;
  tenantId: TenantId;
  name: string;
  version?: number;
  scope?: Record<string, unknown>;
  status?: BoundaryStatus;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}): InventoryBoundary {
  assertUuid(input.id, 'boundary.id');
  assertTenant(input.tenantId, 'boundary.tenantId');
  assertNonEmpty(input.name, 'boundary.name');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError('boundary.version must be ≥ 1'); // inventory_boundary_version_positive
  }
  const status = input.status ?? 'active';
  assertMember(status, BOUNDARY_STATUSES, 'boundary.status'); // inventory_boundary_status_valid
  assertEpoch(input.createdAt, 'boundary.createdAt');
  assertEpoch(input.updatedAt, 'boundary.updatedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    name: input.name.trim(),
    version,
    scope: Object.freeze({ ...(input.scope ?? {}) }),
    status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

export function inventoryBoundaryDigest(b: InventoryBoundary): string {
  return sha256(
    JSON.stringify({
      id: b.id,
      tenantId: b.tenantId,
      name: b.name,
      version: b.version,
      scope: b.scope,
      status: b.status,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }),
  );
}

// ===========================================================================
// 2a. source_contract — the declared CONTRACT for a class of source (support level,
//     authoritative fields, sensitivity). Mirrors table `source_contract`.
//     support_level='unsupported' backs the AC6 unsupported-source gap.
// ===========================================================================

export const SUPPORT_LEVELS = ['supported', 'deprecated', 'unsupported'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export const CONTRACT_SENSITIVITIES = ['normal', 'sensitive', 'restricted'] as const;
export type ContractSensitivity = (typeof CONTRACT_SENSITIVITIES)[number];

export interface SourceContract {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly sourceClass: string;
  readonly version: number;
  readonly supportLevel: SupportLevel;
  readonly authoritativeFields: readonly string[];
  readonly accessMethod?: string;
  readonly sensitivity: ContractSensitivity;
  readonly createdAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export function makeSourceContract(input: {
  id: Uuid;
  tenantId: TenantId;
  sourceClass: string;
  version?: number;
  supportLevel?: SupportLevel;
  authoritativeFields?: readonly string[];
  accessMethod?: string;
  sensitivity?: ContractSensitivity;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
}): SourceContract {
  assertUuid(input.id, 'contract.id');
  assertTenant(input.tenantId, 'contract.tenantId');
  assertNonEmpty(input.sourceClass, 'contract.sourceClass');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError('contract.version must be ≥ 1'); // source_contract_version_positive
  }
  const supportLevel = input.supportLevel ?? 'supported';
  assertMember(supportLevel, SUPPORT_LEVELS, 'contract.supportLevel'); // source_contract_support_valid
  const sensitivity = input.sensitivity ?? 'normal';
  assertMember(sensitivity, CONTRACT_SENSITIVITIES, 'contract.sensitivity'); // source_contract_sensitivity_valid
  const authoritativeFields = input.authoritativeFields ?? [];
  if (!Array.isArray(authoritativeFields)) {
    throw new TypeError('contract.authoritativeFields must be an array');
  }
  for (const f of authoritativeFields) assertNonEmpty(f, 'contract.authoritativeFields entry');
  if (input.accessMethod !== undefined) assertNonEmpty(input.accessMethod, 'contract.accessMethod');
  assertEpoch(input.createdAt, 'contract.createdAt');
  assertEpoch(input.updatedAt, 'contract.updatedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    sourceClass: input.sourceClass,
    version,
    supportLevel,
    authoritativeFields: Object.freeze([...authoritativeFields]),
    accessMethod: input.accessMethod,
    sensitivity,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

export function sourceContractDigest(c: SourceContract): string {
  return sha256(
    JSON.stringify({
      id: c.id,
      tenantId: c.tenantId,
      sourceClass: c.sourceClass,
      version: c.version,
      supportLevel: c.supportLevel,
      authoritativeFields: [...c.authoritativeFields].sort(),
      accessMethod: c.accessMethod ?? null,
      sensitivity: c.sensitivity,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }),
  );
}

// ===========================================================================
// 2b. source_catalog_entry — the OPEN-ENDED SOURCE CATALOG row (AC5), aligned 1:1
//     with the governance-api SourceCatalogEntry schema. Mirrors table
//     `source_catalog_entry`. source_class is FREE TEXT (type-or-'unknown'); the
//     governed lifecycle vocabularies ARE pinned.
// ===========================================================================

export const UNKNOWN_SOURCE_CLASS = 'unknown' as const;

export const ONBOARDING_STATES = [
  'discovered',
  'pending',
  'onboarded',
  'excluded',
  'retired',
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

export const ACCESS_STATES = [
  'connected',
  'reachable',
  'degraded',
  'unreachable',
  'inaccessible',
  'unknown',
] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export const CATALOG_HEALTH_STATES = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export type CatalogHealthState = (typeof CATALOG_HEALTH_STATES)[number];

export const CATALOG_SENSITIVITIES = ['normal', 'sensitive', 'restricted'] as const;
export type CatalogSensitivity = (typeof CATALOG_SENSITIVITIES)[number];

export interface SourceCatalogEntry {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  /** Type-or-'unknown' classification. Free text (a discovered source may be an unknown class). */
  readonly sourceClass: string;
  readonly boundaryId?: Uuid;
  readonly observedLocations: readonly string[];
  readonly ownerPrincipalId?: Uuid;
  readonly onboardingState: OnboardingState;
  readonly accessState: AccessState;
  readonly healthState: CatalogHealthState;
  readonly sensitivity: CatalogSensitivity;
  readonly discoveryEvidence?: Uuid;
  readonly coverageGapIds: readonly Uuid[];
  readonly firstSeenAt: EpochMillis;
  readonly lastSeenAt: EpochMillis;
}

export function makeSourceCatalogEntry(input: {
  id: Uuid;
  tenantId: TenantId;
  sourceClass: string;
  boundaryId?: Uuid;
  observedLocations?: readonly string[];
  ownerPrincipalId?: Uuid;
  onboardingState?: OnboardingState;
  accessState?: AccessState;
  healthState?: CatalogHealthState;
  sensitivity?: CatalogSensitivity;
  discoveryEvidence?: Uuid;
  coverageGapIds?: readonly Uuid[];
  firstSeenAt: EpochMillis;
  lastSeenAt: EpochMillis;
}): SourceCatalogEntry {
  assertUuid(input.id, 'catalog.id');
  assertTenant(input.tenantId, 'catalog.tenantId');
  assertNonEmpty(input.sourceClass, 'catalog.sourceClass');
  assertOptionalUuid(input.boundaryId, 'catalog.boundaryId');
  const observedLocations = input.observedLocations ?? [];
  assertStringArray(observedLocations, 'catalog.observedLocations');
  assertOptionalUuid(input.ownerPrincipalId, 'catalog.ownerPrincipalId');
  const onboardingState = input.onboardingState ?? 'discovered';
  assertMember(onboardingState, ONBOARDING_STATES, 'catalog.onboardingState');
  const accessState = input.accessState ?? 'unknown';
  assertMember(accessState, ACCESS_STATES, 'catalog.accessState');
  const healthState = input.healthState ?? 'unknown';
  assertMember(healthState, CATALOG_HEALTH_STATES, 'catalog.healthState');
  const sensitivity = input.sensitivity ?? 'normal';
  assertMember(sensitivity, CATALOG_SENSITIVITIES, 'catalog.sensitivity');
  assertOptionalUuid(input.discoveryEvidence, 'catalog.discoveryEvidence');
  const coverageGapIds = input.coverageGapIds ?? [];
  if (!Array.isArray(coverageGapIds))
    throw new TypeError('catalog.coverageGapIds must be an array');
  for (const g of coverageGapIds) assertUuid(g, 'catalog.coverageGapIds entry');
  assertEpoch(input.firstSeenAt, 'catalog.firstSeenAt');
  assertEpoch(input.lastSeenAt, 'catalog.lastSeenAt');

  // source_catalog_entry_seen_ordered
  if (input.lastSeenAt < input.firstSeenAt) {
    throw new RangeError('catalog.lastSeenAt must be ≥ catalog.firstSeenAt');
  }
  // source_catalog_entry_unonboarded_not_healthy — a source not yet onboarded (still
  // discovered/pending/excluded/retired) may NOT be recorded as 'healthy'; it must stay a
  // visible gap rather than masquerade as a healthy managed source (AC5/AC6).
  if (onboardingState !== 'onboarded' && healthState === 'healthy') {
    throw new RangeError(
      "catalog invariant violated: a not-yet-onboarded source cannot be 'healthy' " +
        '(source_catalog_entry_unonboarded_not_healthy)',
    );
  }

  return compact({
    id: input.id,
    tenantId: input.tenantId,
    sourceClass: input.sourceClass,
    boundaryId: input.boundaryId,
    observedLocations: Object.freeze([...observedLocations]),
    ownerPrincipalId: input.ownerPrincipalId,
    onboardingState,
    accessState,
    healthState,
    sensitivity,
    discoveryEvidence: input.discoveryEvidence,
    coverageGapIds: Object.freeze([...coverageGapIds]),
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
  });
}

/** True iff this catalog entry has an unresolved OWNERSHIP gap (null owner ⇒ gap; AC5/AC6). */
export function catalogEntryHasOwnershipGap(e: SourceCatalogEntry): boolean {
  return e.ownerPrincipalId === undefined;
}

/** True iff this entry is NOT cleanly onboarded+connected+healthy — i.e. it must stay visible
 * as an attention item (the fail-visible operator-scan predicate, AC5/AC6). */
export function catalogEntryNeedsAttention(e: SourceCatalogEntry): boolean {
  return !(
    e.onboardingState === 'onboarded' &&
    e.accessState === 'connected' &&
    e.healthState === 'healthy'
  );
}

export function sourceCatalogEntryDigest(e: SourceCatalogEntry): string {
  return sha256(
    JSON.stringify({
      id: e.id,
      tenantId: e.tenantId,
      sourceClass: e.sourceClass,
      boundaryId: e.boundaryId ?? null,
      observedLocations: [...e.observedLocations].sort(),
      ownerPrincipalId: e.ownerPrincipalId ?? null,
      onboardingState: e.onboardingState,
      accessState: e.accessState,
      healthState: e.healthState,
      sensitivity: e.sensitivity,
      discoveryEvidence: e.discoveryEvidence ?? null,
      coverageGapIds: [...e.coverageGapIds].sort(),
      firstSeenAt: e.firstSeenAt,
      lastSeenAt: e.lastSeenAt,
    }),
  );
}

// ===========================================================================
// 3. source_record — the per-source RAW OBSERVATION of a component (AC3/AC4).
//    Mirrors table `source_record`. Distinct (catalog, external key) ⇒ distinct
//    row; STALE-STATE signaling: freshness ∈ {fresh,stale,unknown} + last_known_at
//    + confidence ∈ [0,1]; `stale` MIRRORS the enum so a stale row can never look
//    fresh and health/status is read from the observed field, never inferred.
// ===========================================================================

export const FRESHNESS_STATES = ['fresh', 'stale', 'unknown'] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export const SOURCE_RECORD_STATUSES = ['active', 'inactive', 'unknown', 'conflicting'] as const;
export type SourceRecordStatus = (typeof SOURCE_RECORD_STATUSES)[number];

export interface SourceRecord {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly catalogId: Uuid;
  readonly assetId?: Uuid;
  readonly sourceClass: string;
  readonly externalKey: string;
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly status: SourceRecordStatus;
  readonly freshness: FreshnessState;
  readonly stale: boolean;
  readonly confidence: number;
  readonly lastKnownAt: EpochMillis;
  readonly observedAt: EpochMillis;
}

export function makeSourceRecord(input: {
  id: Uuid;
  tenantId: TenantId;
  catalogId: Uuid;
  assetId?: Uuid;
  sourceClass: string;
  externalKey: string;
  observedState?: Record<string, unknown>;
  status?: SourceRecordStatus;
  freshness?: FreshnessState;
  /** Optional explicit mirror; when omitted it is DERIVED from freshness. When supplied it must
   * agree with freshness (source_record_stale_agrees) — a disagreement is rejected. */
  stale?: boolean;
  confidence?: number;
  lastKnownAt: EpochMillis;
  observedAt: EpochMillis;
}): SourceRecord {
  assertUuid(input.id, 'record.id');
  assertTenant(input.tenantId, 'record.tenantId');
  assertUuid(input.catalogId, 'record.catalogId');
  assertOptionalUuid(input.assetId, 'record.assetId');
  assertNonEmpty(input.sourceClass, 'record.sourceClass');
  assertNonEmpty(input.externalKey, 'record.externalKey');
  const status = input.status ?? 'unknown';
  assertMember(status, SOURCE_RECORD_STATUSES, 'record.status'); // source_record_status_valid
  const freshness = input.freshness ?? 'unknown';
  assertMember(freshness, FRESHNESS_STATES, 'record.freshness'); // source_record_freshness_valid

  // source_record_stale_agrees — the boolean mirror cannot disagree with the enum.
  const derivedStale = freshness === 'stale';
  if (input.stale !== undefined && input.stale !== derivedStale) {
    throw new RangeError(
      `record.stale (${input.stale}) must agree with freshness='${freshness}' ` +
        '(source_record_stale_agrees)',
    );
  }
  const stale = derivedStale;

  const confidence = input.confidence ?? 1.0;
  if (
    typeof confidence !== 'number' ||
    Number.isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new RangeError('record.confidence must be in [0,1] (source_record_confidence_range)');
  }
  assertEpoch(input.lastKnownAt, 'record.lastKnownAt');
  assertEpoch(input.observedAt, 'record.observedAt');

  return compact({
    id: input.id,
    tenantId: input.tenantId,
    catalogId: input.catalogId,
    assetId: input.assetId,
    sourceClass: input.sourceClass,
    externalKey: input.externalKey,
    observedState: Object.freeze({ ...(input.observedState ?? {}) }),
    status,
    freshness,
    stale,
    confidence,
    lastKnownAt: input.lastKnownAt,
    observedAt: input.observedAt,
  });
}

/** The DISTINCT identity of a source record: `(tenantId, catalogId, externalKey)` — the unique
 * index `source_record_identity_idx`. Related work across sources keeps distinct identities so
 * distinct records never collapse (AC3). */
export function sourceRecordIdentity(r: SourceRecord): string {
  return `${r.tenantId}|${r.catalogId}|${r.externalKey}`;
}

/** True iff this observation is stale/unknown and its health MUST NOT be treated as current
 * (AC4 — never infer current health from stale data). */
export function sourceRecordFreshnessSuspect(r: SourceRecord): boolean {
  return r.freshness !== 'fresh';
}

export function sourceRecordDigest(r: SourceRecord): string {
  return sha256(
    JSON.stringify({
      id: r.id,
      tenantId: r.tenantId,
      catalogId: r.catalogId,
      assetId: r.assetId ?? null,
      sourceClass: r.sourceClass,
      externalKey: r.externalKey,
      observedState: r.observedState,
      status: r.status,
      freshness: r.freshness,
      stale: r.stale,
      confidence: r.confidence,
      lastKnownAt: r.lastKnownAt,
      observedAt: r.observedAt,
    }),
  );
}

// ===========================================================================
// 4. governed_asset — the RECONCILED inventory row (AC1/AC2), aligned 1:1 with the
//    governance-api GovernedAsset schema. Mirrors table `governed_asset`. A
//    fully-covered asset cannot simultaneously be unmanaged/orphaned
//    (governed_asset_covered_is_managed) — so a gap can never masquerade as
//    covered+healthy.
// ===========================================================================

export const ASSET_LIFECYCLE_STATES = [
  'planned',
  'provisioning',
  'operating',
  'degraded',
  'orphaned',
  'retired',
  'unknown',
] as const;
export type AssetLifecycleState = (typeof ASSET_LIFECYCLE_STATES)[number];

export const ASSET_HEALTH_STATES = [
  'healthy',
  'degraded',
  'unhealthy',
  'unmanaged',
  'unknown',
] as const;
export type AssetHealthState = (typeof ASSET_HEALTH_STATES)[number];

export const COVERAGE_STATES = ['covered', 'partial', 'gap'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export const RISK_TIERS = ['critical', 'high', 'moderate', 'low', 'unassessed'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export interface GovernedAsset {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly assetType: string;
  readonly name: string;
  readonly ownerPrincipalId?: Uuid;
  readonly lifecycleState: AssetLifecycleState;
  readonly riskTier: RiskTier;
  readonly health: AssetHealthState;
  readonly coverage: CoverageState;
  readonly lastObservedAt?: EpochMillis;
  readonly version: number;
  readonly updatedAt: EpochMillis;
}

export function makeGovernedAsset(input: {
  id: Uuid;
  tenantId: TenantId;
  assetType: string;
  name: string;
  ownerPrincipalId?: Uuid;
  lifecycleState?: AssetLifecycleState;
  riskTier?: RiskTier;
  health?: AssetHealthState;
  coverage?: CoverageState;
  lastObservedAt?: EpochMillis;
  version?: number;
  updatedAt: EpochMillis;
}): GovernedAsset {
  assertUuid(input.id, 'asset.id');
  assertTenant(input.tenantId, 'asset.tenantId');
  assertNonEmpty(input.assetType, 'asset.assetType');
  assertNonEmpty(input.name, 'asset.name');
  assertOptionalUuid(input.ownerPrincipalId, 'asset.ownerPrincipalId');
  const lifecycleState = input.lifecycleState ?? 'unknown';
  assertMember(lifecycleState, ASSET_LIFECYCLE_STATES, 'asset.lifecycleState');
  const riskTier = input.riskTier ?? 'unassessed';
  assertMember(riskTier, RISK_TIERS, 'asset.riskTier');
  const health = input.health ?? 'unknown';
  assertMember(health, ASSET_HEALTH_STATES, 'asset.health');
  const coverage = input.coverage ?? 'gap';
  assertMember(coverage, COVERAGE_STATES, 'asset.coverage');
  if (input.lastObservedAt !== undefined) assertEpoch(input.lastObservedAt, 'asset.lastObservedAt');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError('asset.version must be ≥ 1'); // governed_asset_version_positive
  }
  assertEpoch(input.updatedAt, 'asset.updatedAt');

  // governed_asset_covered_is_managed — a fully-covered asset cannot be unmanaged or orphaned.
  if (coverage === 'covered' && (health === 'unmanaged' || lifecycleState === 'orphaned')) {
    throw new RangeError(
      "asset invariant violated: coverage='covered' cannot be unmanaged/orphaned " +
        '(governed_asset_covered_is_managed)',
    );
  }

  return compact({
    id: input.id,
    tenantId: input.tenantId,
    assetType: input.assetType,
    name: input.name.trim(),
    ownerPrincipalId: input.ownerPrincipalId,
    lifecycleState,
    riskTier,
    health,
    coverage,
    lastObservedAt: input.lastObservedAt,
    version,
    updatedAt: input.updatedAt,
  });
}

/** True iff the asset is NOT covered+healthy — i.e. it belongs on the coverage-gap surface and
 * must stay VISIBLE rather than disappear (AC2). */
export function assetNeedsAttention(a: GovernedAsset): boolean {
  return !(a.coverage === 'covered' && a.health === 'healthy');
}

/** True iff the asset has an unresolved OWNERSHIP gap (missing owner; AC1 facet / AC2 gap). */
export function assetHasOwnershipGap(a: GovernedAsset): boolean {
  return a.ownerPrincipalId === undefined;
}

export function governedAssetDigest(a: GovernedAsset): string {
  return sha256(
    JSON.stringify({
      id: a.id,
      tenantId: a.tenantId,
      assetType: a.assetType,
      name: a.name,
      ownerPrincipalId: a.ownerPrincipalId ?? null,
      lifecycleState: a.lifecycleState,
      riskTier: a.riskTier,
      health: a.health,
      coverage: a.coverage,
      lastObservedAt: a.lastObservedAt ?? null,
      version: a.version,
      updatedAt: a.updatedAt,
    }),
  );
}

// ===========================================================================
// 5. inventory_relationship — the correlation/dependency/authoritative-field EDGE
//    between two inventory objects (AC3). Mirrors table `inventory_relationship`.
//    An authoritative_for edge MUST name its field
//    (inventory_relationship_field_when_authoritative).
// ===========================================================================

export const RELATIONSHIP_ENDPOINT_KINDS = [
  'source_record',
  'source_catalog_entry',
  'governed_asset',
] as const;
export type RelationshipEndpointKind = (typeof RELATIONSHIP_ENDPOINT_KINDS)[number];

export const RELATIONSHIP_KINDS = [
  'correlates',
  'depends_on',
  'authoritative_for',
  'duplicate_of',
  'derived_from',
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export interface InventoryRelationship {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly fromKind: RelationshipEndpointKind;
  readonly fromId: Uuid;
  readonly toKind: RelationshipEndpointKind;
  readonly toId: Uuid;
  readonly relationship: RelationshipKind;
  readonly fieldName: string;
  readonly authoritative: boolean;
  readonly createdAt: EpochMillis;
}

export function makeInventoryRelationship(input: {
  id: Uuid;
  tenantId: TenantId;
  fromKind: RelationshipEndpointKind;
  fromId: Uuid;
  toKind: RelationshipEndpointKind;
  toId: Uuid;
  relationship: RelationshipKind;
  fieldName?: string;
  authoritative?: boolean;
  createdAt: EpochMillis;
}): InventoryRelationship {
  assertUuid(input.id, 'relationship.id');
  assertTenant(input.tenantId, 'relationship.tenantId');
  assertMember(input.fromKind, RELATIONSHIP_ENDPOINT_KINDS, 'relationship.fromKind');
  assertUuid(input.fromId, 'relationship.fromId');
  assertMember(input.toKind, RELATIONSHIP_ENDPOINT_KINDS, 'relationship.toKind');
  assertUuid(input.toId, 'relationship.toId');
  assertMember(input.relationship, RELATIONSHIP_KINDS, 'relationship.relationship');
  const fieldName = input.fieldName ?? '';
  if (typeof fieldName !== 'string') throw new TypeError('relationship.fieldName must be a string');
  const authoritative = input.authoritative ?? input.relationship === 'authoritative_for';
  if (typeof authoritative !== 'boolean') {
    throw new TypeError('relationship.authoritative must be a boolean');
  }
  // inventory_relationship_field_when_authoritative — an authoritative-field attribution must
  // name the field it is authoritative for.
  if (input.relationship === 'authoritative_for' && fieldName.trim() === '') {
    throw new RangeError(
      "relationship invariant violated: an 'authoritative_for' edge must name its field " +
        '(inventory_relationship_field_when_authoritative)',
    );
  }
  assertEpoch(input.createdAt, 'relationship.createdAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    fromKind: input.fromKind,
    fromId: input.fromId,
    toKind: input.toKind,
    toId: input.toId,
    relationship: input.relationship,
    fieldName,
    authoritative,
    createdAt: input.createdAt,
  });
}

/** The unique EDGE identity (`inventory_relationship_edge_idx`) — an edge is asserted once. */
export function relationshipEdgeIdentity(r: InventoryRelationship): string {
  return [r.tenantId, r.fromKind, r.fromId, r.toKind, r.toId, r.relationship, r.fieldName].join(
    '|',
  );
}

export function inventoryRelationshipDigest(r: InventoryRelationship): string {
  return sha256(
    JSON.stringify({
      id: r.id,
      tenantId: r.tenantId,
      fromKind: r.fromKind,
      fromId: r.fromId,
      toKind: r.toKind,
      toId: r.toId,
      relationship: r.relationship,
      fieldName: r.fieldName,
      authoritative: r.authoritative,
      createdAt: r.createdAt,
    }),
  );
}

// ===========================================================================
// 6. correlation_case — an UNRESOLVED correlation/conflict held for a human (AC3).
//    Mirrors table `correlation_case`. A terminal case ⇔ (resolution ∧ resolved
//    time) (correlation_case_resolution_when_terminal): a conflict can never look
//    resolved without a durable human resolution.
// ===========================================================================

export const CORRELATION_CASE_TYPES = [
  'field_conflict',
  'ambiguous_match',
  'duplicate',
  'unlinked',
] as const;
export type CorrelationCaseType = (typeof CORRELATION_CASE_TYPES)[number];

export const CORRELATION_CASE_STATUSES = [
  'open',
  'investigating',
  'resolved',
  'dismissed',
] as const;
export type CorrelationCaseStatus = (typeof CORRELATION_CASE_STATUSES)[number];

const CORRELATION_TERMINAL_STATUSES: readonly CorrelationCaseStatus[] = ['resolved', 'dismissed'];

export interface CorrelationCase {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly assetId?: Uuid;
  readonly caseType: CorrelationCaseType;
  readonly status: CorrelationCaseStatus;
  readonly conflicting: readonly Readonly<Record<string, unknown>>[];
  readonly requiredAction?: string;
  readonly resolution?: string;
  readonly openedAt: EpochMillis;
  readonly resolvedAt?: EpochMillis;
}

export function makeCorrelationCase(input: {
  id: Uuid;
  tenantId: TenantId;
  assetId?: Uuid;
  caseType?: CorrelationCaseType;
  status?: CorrelationCaseStatus;
  conflicting?: readonly Record<string, unknown>[];
  requiredAction?: string;
  resolution?: string;
  openedAt: EpochMillis;
  resolvedAt?: EpochMillis;
}): CorrelationCase {
  assertUuid(input.id, 'case.id');
  assertTenant(input.tenantId, 'case.tenantId');
  assertOptionalUuid(input.assetId, 'case.assetId');
  const caseType = input.caseType ?? 'field_conflict';
  assertMember(caseType, CORRELATION_CASE_TYPES, 'case.caseType');
  const status = input.status ?? 'open';
  assertMember(status, CORRELATION_CASE_STATUSES, 'case.status');
  const conflicting = input.conflicting ?? [];
  if (!Array.isArray(conflicting)) throw new TypeError('case.conflicting must be an array');
  if (input.requiredAction !== undefined)
    assertNonEmpty(input.requiredAction, 'case.requiredAction');
  if (input.resolution !== undefined) assertNonEmpty(input.resolution, 'case.resolution');
  assertEpoch(input.openedAt, 'case.openedAt');
  if (input.resolvedAt !== undefined) assertEpoch(input.resolvedAt, 'case.resolvedAt');

  // correlation_case_resolution_when_terminal — terminal ⇔ (resolution present ∧ resolvedAt present).
  const isTerminal = CORRELATION_TERMINAL_STATUSES.includes(status);
  const hasResolution = input.resolution !== undefined && input.resolvedAt !== undefined;
  if (isTerminal !== hasResolution) {
    throw new RangeError(
      "correlation case invariant violated: a terminal ('resolved'/'dismissed') case must name " +
        'a resolution + resolved time, and a non-terminal case must not ' +
        '(correlation_case_resolution_when_terminal)',
    );
  }

  return compact({
    id: input.id,
    tenantId: input.tenantId,
    assetId: input.assetId,
    caseType,
    status,
    conflicting: Object.freeze(conflicting.map((c) => Object.freeze({ ...c }))),
    requiredAction: input.requiredAction,
    resolution: input.resolution,
    openedAt: input.openedAt,
    resolvedAt: input.resolvedAt,
  });
}

/** True iff the case is still OPEN/INVESTIGATING and must stay on the unresolved-work surface (AC3). */
export function correlationCaseIsOpen(c: CorrelationCase): boolean {
  return c.status === 'open' || c.status === 'investigating';
}

export function correlationCaseDigest(c: CorrelationCase): string {
  return sha256(
    JSON.stringify({
      id: c.id,
      tenantId: c.tenantId,
      assetId: c.assetId ?? null,
      caseType: c.caseType,
      status: c.status,
      conflicting: c.conflicting,
      requiredAction: c.requiredAction ?? null,
      resolution: c.resolution ?? null,
      openedAt: c.openedAt,
      resolvedAt: c.resolvedAt ?? null,
    }),
  );
}

// ===========================================================================
// 7. coverage_gap — a DISCOVERED-BUT-NOT-FULLY-GOVERNED component or source held as
//    a VISIBLE gap (AC2 + AC6). Mirrors table `coverage_gap`. Every gap names its
//    WHY (reason) + required owner action; a gap always names a non-empty action
//    (coverage_gap_action_present); a resolved gap ⇔ (resolution ∧ resolved time)
//    (coverage_gap_resolution_when_resolved).
// ===========================================================================

export const GAP_SUBJECT_KINDS = [
  'governed_asset',
  'source_catalog_entry',
  'source_record',
  'component',
] as const;
export type GapSubjectKind = (typeof GAP_SUBJECT_KINDS)[number];

export const GAP_CLASSES = ['component', 'governed_source'] as const;
export type GapClass = (typeof GAP_CLASSES)[number];

/** The pinned gap-reason vocabulary: AC2 component reasons (unmanaged/unreachable/stale/orphaned)
 * and AC6 governed-source reasons (excluded/unsupported/inaccessible/sensitive/unowned). */
export const GAP_REASONS = [
  'unmanaged',
  'unreachable',
  'stale',
  'orphaned',
  'excluded',
  'unsupported',
  'inaccessible',
  'sensitive',
  'unowned',
] as const;
export type GapReason = (typeof GAP_REASONS)[number];

export const GAP_IMPACTS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type GapImpact = (typeof GAP_IMPACTS)[number];

export const GAP_STATUSES = ['open', 'acknowledged', 'resolved', 'accepted_risk'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export interface CoverageGap {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly subjectKind: GapSubjectKind;
  readonly subjectId?: Uuid;
  readonly gapClass: GapClass;
  readonly reason: GapReason;
  readonly impact: GapImpact;
  readonly requiredAction: string;
  readonly requiredOwner?: Uuid;
  readonly status: GapStatus;
  readonly resolution?: string;
  readonly firstSeenAt: EpochMillis;
  readonly reviewAt?: EpochMillis;
  readonly expiresAt?: EpochMillis;
  readonly resolvedAt?: EpochMillis;
}

export function makeCoverageGap(input: {
  id: Uuid;
  tenantId: TenantId;
  subjectKind: GapSubjectKind;
  subjectId?: Uuid;
  gapClass?: GapClass;
  reason: GapReason;
  impact?: GapImpact;
  requiredAction: string;
  requiredOwner?: Uuid;
  status?: GapStatus;
  resolution?: string;
  firstSeenAt: EpochMillis;
  reviewAt?: EpochMillis;
  expiresAt?: EpochMillis;
  resolvedAt?: EpochMillis;
}): CoverageGap {
  assertUuid(input.id, 'gap.id');
  assertTenant(input.tenantId, 'gap.tenantId');
  assertMember(input.subjectKind, GAP_SUBJECT_KINDS, 'gap.subjectKind');
  assertOptionalUuid(input.subjectId, 'gap.subjectId');
  const gapClass = input.gapClass ?? 'component';
  assertMember(gapClass, GAP_CLASSES, 'gap.gapClass');
  assertMember(input.reason, GAP_REASONS, 'gap.reason'); // coverage_gap_reason_valid
  const impact = input.impact ?? 'unknown';
  assertMember(impact, GAP_IMPACTS, 'gap.impact');
  // coverage_gap_action_present — a gap must always name a non-empty required owner action.
  assertNonEmpty(input.requiredAction, 'gap.requiredAction');
  assertOptionalUuid(input.requiredOwner, 'gap.requiredOwner');
  const status = input.status ?? 'open';
  assertMember(status, GAP_STATUSES, 'gap.status');
  if (input.resolution !== undefined) assertNonEmpty(input.resolution, 'gap.resolution');
  assertEpoch(input.firstSeenAt, 'gap.firstSeenAt');
  if (input.reviewAt !== undefined) assertEpoch(input.reviewAt, 'gap.reviewAt');
  if (input.expiresAt !== undefined) assertEpoch(input.expiresAt, 'gap.expiresAt');
  if (input.resolvedAt !== undefined) assertEpoch(input.resolvedAt, 'gap.resolvedAt');

  // coverage_gap_resolution_when_resolved — resolved ⇔ (resolution present ∧ resolvedAt present).
  const isResolved = status === 'resolved';
  const hasResolution = input.resolution !== undefined && input.resolvedAt !== undefined;
  if (isResolved !== hasResolution) {
    throw new RangeError(
      "coverage gap invariant violated: a 'resolved' gap must name a resolution + resolved time, " +
        'and a non-resolved gap must not (coverage_gap_resolution_when_resolved)',
    );
  }

  return compact({
    id: input.id,
    tenantId: input.tenantId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    gapClass,
    reason: input.reason,
    impact,
    requiredAction: input.requiredAction.trim(),
    requiredOwner: input.requiredOwner,
    status,
    resolution: input.resolution,
    firstSeenAt: input.firstSeenAt,
    reviewAt: input.reviewAt,
    expiresAt: input.expiresAt,
    resolvedAt: input.resolvedAt,
  });
}

/** Gap AGE in milliseconds relative to `now` (AC2 "age"). Derived from firstSeenAt; never
 * negative when `now ≥ firstSeenAt`. */
export function gapAgeMillis(g: CoverageGap, now: EpochMillis): number {
  assertEpoch(now, 'now');
  return Math.max(0, now - g.firstSeenAt);
}

/** True iff the gap is still OPEN/ACKNOWLEDGED and must stay VISIBLE on the gap surface
 * (AC2/AC6 — never healthy/disappearing). */
export function gapIsVisible(g: CoverageGap): boolean {
  return g.status === 'open' || g.status === 'acknowledged';
}

/** True iff this is an AC6 governed-source gap carrying a review-or-expiry deadline. */
export function gapHasReviewOrExpiry(g: CoverageGap): boolean {
  return (
    g.gapClass === 'governed_source' && (g.reviewAt !== undefined || g.expiresAt !== undefined)
  );
}

export function coverageGapDigest(g: CoverageGap): string {
  return sha256(
    JSON.stringify({
      id: g.id,
      tenantId: g.tenantId,
      subjectKind: g.subjectKind,
      subjectId: g.subjectId ?? null,
      gapClass: g.gapClass,
      reason: g.reason,
      impact: g.impact,
      requiredAction: g.requiredAction,
      requiredOwner: g.requiredOwner ?? null,
      status: g.status,
      resolution: g.resolution ?? null,
      firstSeenAt: g.firstSeenAt,
      reviewAt: g.reviewAt ?? null,
      expiresAt: g.expiresAt ?? null,
      resolvedAt: g.resolvedAt ?? null,
    }),
  );
}
