// @trustcircle/application — source-contract registration, onboarding lifecycle, stewardship
// actions, exclusion reviews, and ownership gaps (Phase 65).
//
// Governing oracles (acceptance criteria, verified in tests/unit/source-registry.unit.test.ts):
//   AC1 (VO-8be294d6…) Healthy connected sources render ONCE with type / source identity / owner /
//       lifecycle / risk / control coverage / evidence state / health / last-observation time /
//       unresolved issues → `currentStateView()` produces one `SourceStateRow` per catalog entry.
//   AC2 (VO-a3a4e376…) A discovered-but-unmanaged / unreachable / stale / orphaned / excluded
//       component stays VISIBLE as a coverage gap with reason / age / impact / required owner
//       action — never healthy, never disappearing → `coverageGaps()` + reconcile keeps the gap.
//   AC3 (VO-e51f49c4…) Related work across registered sources (Kanban, agentctl,
//       workflows_orchestration) → the registry keeps each source's DISTINCT records + contract +
//       correlation + per-field STATUS DIFFERENCES across those records + DEPENDENCY edges +
//       authoritative fields, exposed by `sourceRecordsFor()` / `statusDifferencesFor()` /
//       `dependenciesFor()` / `drillDown()`.
//   AC4 (VO-d0485160…) A stale/unavailable source is marked with last-known time + confidence and
//       current health/compliance is NOT inferred from stale data → `currentStateView()` folds a
//       `staleness` verdict and refuses to report `healthy` when the source is stale/unavailable.
//   AC5 (VO-aba3812f…) An unregistered governance-relevant source appearing in the boundary is
//       ADDED to the source catalog with discovery evidence / type-or-unknown / location / access /
//       sensitivity / ownership status / onboarding state → `discover()`.
//   AC6 (VO-8aa32290…) A discovered source that is unsupported / inaccessible / sensitive /
//       unowned / intentionally excluded stays VISIBLE as a governed-source gap with reason /
//       impact / owner action / review-or-expiry → `assessCoverage()` synthesises + retains a
//       `governed_source` gap for every such condition.
//
// The registry is a pure, dependency-free (transitively node:crypto only) in-memory aggregate over
// the Phase-63 domain inventory value model. It never touches the wall clock: every mutating call
// takes an explicit `at: EpochMillis` and an injected id (`newId`) so identity + timing are
// deterministic and independently reproducible. Every mutation returns the durable value it wrote,
// and — critically — is INDEPENDENTLY READABLE afterwards through the query surface
// (`catalog()`, `contracts()`, `coverageGaps()`, `currentStateView()`, `snapshotDigest()`): the
// mutation response is never the proof; the re-readable state + its content digest are.
//
// The registry grants NO governance authority. It records, validates, and keeps visible; it does
// not infer compliance, does not silently repair, and never deletes — terminal states
// (`retired`, `resolved`) remain queryable so source history stays reconstructable.

import {
  isUuid,
  isUuidV7,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
  makeReason,
  type Reason,
} from '@trustcircle/domain';
import {
  makeSourceContract,
  sourceContractDigest,
  type SourceContract,
  type SupportLevel,
  type ContractSensitivity,
  makeSourceCatalogEntry,
  sourceCatalogEntryDigest,
  catalogEntryHasOwnershipGap,
  catalogEntryNeedsAttention,
  type SourceCatalogEntry,
  type OnboardingState,
  type AccessState,
  type CatalogHealthState,
  type CatalogSensitivity,
  UNKNOWN_SOURCE_CLASS,
  makeCoverageGap,
  coverageGapDigest,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  type CoverageGap,
  type GapReason,
  type GapImpact,
  type SourceRecord,
  sourceRecordIdentity,
  sourceRecordFreshnessSuspect,
  sourceRecordDigest,
  makeInventoryRelationship,
  relationshipEdgeIdentity,
  inventoryRelationshipDigest,
  type InventoryRelationship,
  type RelationshipKind,
  type RelationshipEndpointKind,
} from '@trustcircle/domain';
import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Shared guards (mirror the domain factory guards so the registry fails
//    fast and fail-visibly on a bad write, exactly like the aggregates it holds).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}
function assertUuidV7(id: unknown, label: string): asserts id is Uuid {
  if (!isUuidV7(id)) throw new TypeError(`${label} must be a stable UUIDv7 identifier`);
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
function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** Drop `undefined`-valued keys (required under exactOptionalPropertyTypes). */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.freeze(out) as T;
}

/** Injected identity factory: the caller supplies fresh UUIDv7s so the registry never
 * generates identity from the wall clock (deterministic + reproducible in tests). */
export type IdFactory = () => Uuid;

// ===========================================================================
// 1. Onboarding lifecycle — the guarded state machine over OnboardingState.
//    discovered → pending → onboarded ⇄ excluded ; any non-terminal → retired.
//    `retired` is a terminal sink (history preserved, never deleted).
// ===========================================================================

const ONBOARDING_TRANSITIONS: Readonly<Record<OnboardingState, readonly OnboardingState[]>> = {
  discovered: ['pending', 'excluded', 'retired'],
  pending: ['onboarded', 'excluded', 'retired'],
  onboarded: ['excluded', 'retired'],
  excluded: ['pending', 'retired'],
  retired: [],
};

/** True iff `to` is a permitted onboarding transition from `from`. */
export function canOnboardingTransition(from: OnboardingState, to: OnboardingState): boolean {
  return ONBOARDING_TRANSITIONS[from].includes(to);
}

export function assertOnboardingTransition(from: OnboardingState, to: OnboardingState): void {
  if (!canOnboardingTransition(from, to)) {
    throw new RangeError(`illegal onboarding transition: ${from} → ${to}`);
  }
}

// ===========================================================================
// 2. The current-state VIEW row (AC1) + staleness verdict (AC4).
// ===========================================================================

/** How fresh the registry's knowledge of a source is, derived from `lastSeenAt` vs `now` and the
 * staleness horizon. `stale`/`unavailable` are FAIL-VISIBLE: current health is never inferred as
 * healthy while a source is stale/unavailable (AC4). */
export const STALENESS_VERDICTS = ['fresh', 'stale', 'unavailable'] as const;
export type StalenessVerdict = (typeof STALENESS_VERDICTS)[number];

/** One row of the officer's current-state view (AC1). Renders a catalog entry ONCE with every
 * enumerated facet, plus the AC4 staleness overlay (last-known time + confidence). */
export interface SourceStateRow {
  readonly sourceId: Uuid;
  readonly sourceClass: string;
  /** True when the class is the reserved 'unknown' classification (AC5). */
  readonly classifiedUnknown: boolean;
  readonly ownerPrincipalId?: Uuid;
  /** AC1 ownership facet: an unowned source is flagged rather than hidden. */
  readonly ownershipGap: boolean;
  readonly onboardingState: OnboardingState;
  readonly accessState: AccessState;
  /** AC1 health facet — but see `reportedHealth`: NEVER 'healthy' while stale/unavailable (AC4). */
  readonly observedHealth: CatalogHealthState;
  /** AC4: the health the officer is allowed to rely on. Downgraded to 'unknown' when the source's
   * knowledge is stale/unavailable, so current health is not inferred from stale data. */
  readonly reportedHealth: CatalogHealthState;
  readonly sensitivity: CatalogSensitivity;
  /** AC1 evidence-state facet, derived from support level + onboarding + staleness. */
  readonly evidenceState: 'current' | 'stale' | 'absent';
  readonly staleness: StalenessVerdict;
  /** AC4 last-known observation time. */
  readonly lastKnownAt: EpochMillis;
  /** AC4 confidence ∈ [0,1]: 1 when fresh, decaying to 0 as the source goes stale/unavailable. */
  readonly confidence: number;
  /** AC1: control-coverage summary — whether the source has unresolved coverage gaps. */
  readonly hasControlCoverage: boolean;
  /** AC1 unresolved-issues facet: count of visible coverage gaps for this source. */
  readonly unresolvedIssueCount: number;
  readonly discoveryEvidence?: Uuid;
  readonly version: number;
}

// ===========================================================================
// 3. The registry aggregate.
// ===========================================================================

/** A registered source: its open-ended catalog entry, its versioned+validated contract history
 * (newest last), and the distinct source records it has been correlated with (AC3). */
export interface RegisteredSource {
  readonly entry: SourceCatalogEntry;
  /** Full contract version history — append-only; a superseding version never overwrites the
   * prior one, so the source-contract lineage stays reconstructable (VO-52d0780c). */
  readonly contractHistory: readonly SourceContract[];
  /** Distinct source records observed for this source, keyed by `sourceRecordIdentity` (AC3). */
  readonly records: readonly SourceRecord[];
}

/** One AC3 STATUS DIFFERENCE: a single field on which the DISTINCT records correlated to a source
 * disagree, naming each distinct observed value and the record ids that reported it. */
export interface StatusDifference {
  readonly field: string;
  readonly values: readonly {
    readonly value: unknown;
    readonly recordIds: readonly Uuid[];
  }[];
}

export interface RegistryInput {
  readonly tenantId: TenantId;
  readonly newId: IdFactory;
  /** Staleness horizon in millis: a source not seen within this window is `stale`; twice the
   * window (or an unreachable/inaccessible access state) makes it `unavailable`. */
  readonly stalenessHorizonMillis: number;
}

const DEFAULT_STALENESS_HORIZON = 15 * 60 * 1000; // 15 minutes (freshness objective, ops.md).

/**
 * In-memory source registry. All state is held in maps keyed by catalog-entry id; every mutating
 * method returns the durable value written AND leaves it independently readable via the query
 * surface. Pure + deterministic: no wall-clock reads, no I/O.
 */
export class SourceRegistry {
  private readonly tenantId: TenantId;
  private readonly newId: IdFactory;
  private readonly horizon: number;

  private readonly entries = new Map<string, SourceCatalogEntry>();
  private readonly contractsBySource = new Map<string, SourceContract[]>();
  private readonly recordsBySource = new Map<string, Map<string, SourceRecord>>();
  /** Correlation / dependency / authoritative-field EDGES anchored on a source (AC3), keyed by
   * `relationshipEdgeIdentity` so a given edge is asserted exactly once (no duplicate edges). */
  private readonly relationshipsBySource = new Map<string, Map<string, InventoryRelationship>>();
  private readonly gaps = new Map<string, CoverageGap>();
  /** Which coverage gaps belong to which source, for the read path + reconcile. */
  private readonly gapIdsBySource = new Map<string, Set<string>>();

  constructor(input: RegistryInput) {
    assertTenant(input.tenantId, 'registry.tenantId');
    if (typeof input.newId !== 'function') throw new TypeError('registry.newId must be a factory');
    const horizon = input.stalenessHorizonMillis ?? DEFAULT_STALENESS_HORIZON;
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new RangeError('registry.stalenessHorizonMillis must be a positive integer');
    }
    this.tenantId = input.tenantId;
    this.newId = input.newId;
    this.horizon = horizon;
  }

  // -------------------------------------------------------------------------
  // AC5 — DISCOVERY: add an unregistered governance-relevant source to the catalog.
  // -------------------------------------------------------------------------

  /**
   * Discover a source appearing within the declared boundary and ADD it to the catalog with
   * discovery evidence, a type-or-'unknown' classification, observed location(s), access status,
   * sensitivity, ownership status, and onboarding state (`discovered`). Idempotent per external
   * key: re-discovering an already-catalogued source updates its `lastSeenAt` and merges any new
   * observed location rather than creating a duplicate row (AC5 / no duplicate governance action).
   */
  discover(input: {
    externalKey: string;
    sourceClass?: string;
    location: string;
    accessState?: AccessState;
    sensitivity?: CatalogSensitivity;
    ownerPrincipalId?: Uuid;
    discoveryEvidence: Uuid;
    boundaryId?: Uuid;
    at: EpochMillis;
  }): SourceCatalogEntry {
    assertNonEmpty(input.externalKey, 'discover.externalKey');
    assertNonEmpty(input.location, 'discover.location');
    assertUuid(input.discoveryEvidence, 'discover.discoveryEvidence');
    assertEpoch(input.at, 'discover.at');

    const existing = this.findEntryByExternalKey(input.externalKey);
    if (existing) {
      // Idempotent re-discovery: refresh last-seen, merge location — no duplicate row.
      const locations = existing.observedLocations.includes(input.location)
        ? existing.observedLocations
        : [...existing.observedLocations, input.location];
      const updated = makeSourceCatalogEntry({
        id: existing.id,
        tenantId: existing.tenantId,
        sourceClass: existing.sourceClass,
        ...(existing.boundaryId !== undefined ? { boundaryId: existing.boundaryId } : {}),
        observedLocations: locations,
        ...(existing.ownerPrincipalId !== undefined
          ? { ownerPrincipalId: existing.ownerPrincipalId }
          : {}),
        onboardingState: existing.onboardingState,
        accessState: input.accessState ?? existing.accessState,
        healthState: existing.healthState,
        sensitivity: existing.sensitivity,
        ...(existing.discoveryEvidence !== undefined
          ? { discoveryEvidence: existing.discoveryEvidence }
          : {}),
        coverageGapIds: existing.coverageGapIds,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: input.at,
      });
      this.entries.set(this.key(existing.id), updated);
      this.externalKeys.set(input.externalKey, existing.id);
      return updated;
    }

    const id = this.mintId('discover.id');
    const entry = makeSourceCatalogEntry({
      id,
      tenantId: this.tenantId,
      sourceClass: input.sourceClass ?? UNKNOWN_SOURCE_CLASS,
      ...(input.boundaryId !== undefined ? { boundaryId: input.boundaryId } : {}),
      observedLocations: [input.location],
      ...(input.ownerPrincipalId !== undefined ? { ownerPrincipalId: input.ownerPrincipalId } : {}),
      onboardingState: 'discovered',
      accessState: input.accessState ?? 'unknown',
      healthState: 'unknown', // never 'healthy' while un-onboarded (domain invariant).
      sensitivity: input.sensitivity ?? 'normal',
      discoveryEvidence: input.discoveryEvidence,
      coverageGapIds: [],
      firstSeenAt: input.at,
      lastSeenAt: input.at,
    });
    this.entries.set(this.key(id), entry);
    this.externalKeys.set(input.externalKey, id);
    this.contractsBySource.set(this.key(id), []);
    this.recordsBySource.set(this.key(id), new Map());
    this.relationshipsBySource.set(this.key(id), new Map());
    this.gapIdsBySource.set(this.key(id), new Set());
    return entry;
  }

  // -------------------------------------------------------------------------
  // Source-CONTRACT registration — versioned + validated (VO-52d0780c).
  // -------------------------------------------------------------------------

  /**
   * Register (or supersede) the VERSIONED, VALIDATED source contract for a catalogued source. The
   * first contract is version 1; each subsequent registration MUST carry a strictly greater
   * version and is APPENDED to the contract history rather than overwriting the prior one, so the
   * lineage stays reconstructable. Re-registering an existing version with a DIFFERENT digest is a
   * conflict (rejected); re-registering an identical (version, digest) is idempotent (returns the
   * already-stored contract). The contract is validated by the domain factory (`makeSourceContract`)
   * — a malformed contract never enters the registry.
   */
  registerContract(input: {
    sourceId: Uuid;
    version: number;
    supportLevel?: SupportLevel;
    authoritativeFields?: readonly string[];
    accessMethod?: string;
    sensitivity?: ContractSensitivity;
    at: EpochMillis;
  }): SourceContract {
    const entry = this.requireEntry(input.sourceId, 'registerContract.sourceId');
    assertEpoch(input.at, 'registerContract.at');
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new RangeError('registerContract.version must be an integer ≥ 1');
    }
    const history = this.contractsBySource.get(this.key(entry.id))!;
    const latest = history[history.length - 1];
    const candidate = makeSourceContract({
      id: this.mintId('contract.id'),
      tenantId: entry.tenantId,
      sourceClass: entry.sourceClass,
      version: input.version,
      ...(input.supportLevel !== undefined ? { supportLevel: input.supportLevel } : {}),
      ...(input.authoritativeFields !== undefined
        ? { authoritativeFields: input.authoritativeFields }
        : {}),
      ...(input.accessMethod !== undefined ? { accessMethod: input.accessMethod } : {}),
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      createdAt: input.at,
      updatedAt: input.at,
    });

    const sameVersion = history.find((c) => c.version === input.version);
    if (sameVersion) {
      // Idempotent iff the payload digest matches; otherwise a versioned-contract conflict.
      if (this.contractPayloadDigest(sameVersion) === this.contractPayloadDigest(candidate)) {
        return sameVersion;
      }
      throw new RangeError(
        `source-contract conflict: version ${input.version} already registered with a different ` +
          'payload (a contract version is immutable once registered; bump the version)',
      );
    }
    if (latest && input.version <= latest.version) {
      throw new RangeError(
        `source-contract version must strictly increase: latest is ${latest.version}, got ${input.version}`,
      );
    }
    history.push(candidate);
    return candidate;
  }

  // -------------------------------------------------------------------------
  // ONBOARDING LIFECYCLE — guarded transitions over OnboardingState.
  // -------------------------------------------------------------------------

  /**
   * Advance a source's onboarding state through the guarded lifecycle machine. Onboarding to
   * `onboarded` REQUIRES a registered contract and a named owner (a source with no steward or no
   * validated contract cannot be reported as fully governed). Illegal transitions throw. The
   * updated catalog entry is written and independently readable.
   */
  transitionOnboarding(input: {
    sourceId: Uuid;
    to: OnboardingState;
    at: EpochMillis;
  }): SourceCatalogEntry {
    const entry = this.requireEntry(input.sourceId, 'transitionOnboarding.sourceId');
    assertEpoch(input.at, 'transitionOnboarding.at');
    assertOnboardingTransition(entry.onboardingState, input.to);

    if (input.to === 'onboarded') {
      if ((this.contractsBySource.get(this.key(entry.id))?.length ?? 0) === 0) {
        throw new RangeError('cannot onboard a source with no registered contract');
      }
      if (entry.ownerPrincipalId === undefined) {
        throw new RangeError('cannot onboard an unowned source (assign a steward first)');
      }
    }

    // Onboarding does NOT imply health; health is set separately by a stewardship observation.
    // (A source going non-onboarded keeps its recorded health; the current-state view will still
    // refuse to *report* 'healthy' for a stale/unavailable source — see currentStateView / AC4.)
    return this.rewriteEntry(entry, {
      onboardingState: input.to,
      lastSeenAt: input.at,
    });
  }

  // -------------------------------------------------------------------------
  // STEWARDSHIP actions — assign owner, record an observation (access/health/last-seen).
  // -------------------------------------------------------------------------

  /** Assign (or reassign) the accountable steward/owner of a source. Closes the ownership gap. */
  assignOwner(input: {
    sourceId: Uuid;
    ownerPrincipalId: Uuid;
    at: EpochMillis;
  }): SourceCatalogEntry {
    const entry = this.requireEntry(input.sourceId, 'assignOwner.sourceId');
    assertUuid(input.ownerPrincipalId, 'assignOwner.ownerPrincipalId');
    assertEpoch(input.at, 'assignOwner.at');
    return this.rewriteEntry(entry, {
      ownerPrincipalId: input.ownerPrincipalId,
      lastSeenAt: input.at,
    });
  }

  /**
   * Record a stewardship observation of a source's access + health at `at`. Enforces the domain
   * invariant that a not-yet-onboarded source can never be `healthy` (the factory rejects it), so
   * a healthy claim is only ever accepted for a genuinely onboarded source.
   */
  recordObservation(input: {
    sourceId: Uuid;
    accessState: AccessState;
    healthState: CatalogHealthState;
    at: EpochMillis;
  }): SourceCatalogEntry {
    const entry = this.requireEntry(input.sourceId, 'recordObservation.sourceId');
    assertEpoch(input.at, 'recordObservation.at');
    return this.rewriteEntry(entry, {
      accessState: input.accessState,
      healthState: input.healthState,
      lastSeenAt: input.at,
    });
  }

  /** Attach a distinct source record (raw per-source observation) to a source, keyed by its
   * identity so duplicates collapse and history stays reconstructable (AC3). */
  attachRecord(record: SourceRecord): SourceRecord {
    const sourceId = record.catalogId;
    const entry = this.requireEntry(sourceId, 'attachRecord.record.catalogId');
    const bucket = this.recordsBySource.get(this.key(entry.id))!;
    bucket.set(sourceRecordIdentity(record), record);
    return record;
  }

  /**
   * Assert a correlation / dependency / authoritative-field EDGE anchored on `sourceId` (AC3).
   * The edge is stored keyed by `relationshipEdgeIdentity`, so re-asserting the same edge is
   * idempotent (a given `depends_on`/`correlates`/… edge is recorded once). The source is treated
   * as the `from` endpoint (a `source_catalog_entry`); the `to` endpoint names the related object.
   * Health/authority is NEVER inferred from an edge — an edge only records a declared relationship.
   */
  attachRelationship(input: {
    sourceId: Uuid;
    toId: Uuid;
    relationship: RelationshipKind;
    toKind?: RelationshipEndpointKind;
    fieldName?: string;
    at: EpochMillis;
  }): InventoryRelationship {
    const entry = this.requireEntry(input.sourceId, 'attachRelationship.sourceId');
    assertUuid(input.toId, 'attachRelationship.toId');
    assertEpoch(input.at, 'attachRelationship.at');
    const edge = makeInventoryRelationship({
      id: this.newId(),
      tenantId: entry.tenantId,
      fromKind: 'source_catalog_entry',
      fromId: entry.id,
      toKind: input.toKind ?? 'source_catalog_entry',
      toId: input.toId,
      relationship: input.relationship,
      ...(input.fieldName !== undefined ? { fieldName: input.fieldName } : {}),
      createdAt: input.at,
    });
    const bucket = this.relationshipsBySource.get(this.key(entry.id))!;
    bucket.set(relationshipEdgeIdentity(edge), edge);
    return edge;
  }

  /** Every relationship EDGE anchored on a source (AC3), sorted by edge identity. */
  relationshipsFor(sourceId: Uuid): readonly InventoryRelationship[] {
    const entry = this.requireEntry(sourceId, 'relationshipsFor.sourceId');
    return [...(this.relationshipsBySource.get(this.key(entry.id))?.values() ?? [])].sort((a, b) =>
      relationshipEdgeIdentity(a).localeCompare(relationshipEdgeIdentity(b)),
    );
  }

  /** The DEPENDENCY edges of a source (AC3 dependencies) — the `depends_on` relationships only. */
  dependenciesFor(sourceId: Uuid): readonly InventoryRelationship[] {
    return this.relationshipsFor(sourceId).filter((r) => r.relationship === 'depends_on');
  }

  /**
   * AC3 STATUS DIFFERENCES: the per-field status disagreements ACROSS the distinct records
   * correlated to one source. Two records for the same source can report the same field with
   * DIFFERENT values (e.g. Kanban says a work-item is `active` while agentctl says `inactive`) —
   * a difference a human must reconcile, NOT one the registry silently collapses. Each returned
   * entry names the field and the DISTINCT observed values with the records that hold them. Fields
   * on which every record agrees (or that only one record reports) are NOT differences and are
   * omitted. `status` (the record status enum) is always considered; observed-state keys are
   * folded in too so differences on any correlated field surface.
   */
  statusDifferencesFor(sourceId: Uuid): readonly StatusDifference[] {
    const records = this.sourceRecordsFor(sourceId);
    if (records.length < 2) return [];
    // Field → (stringified value → record ids reporting it).
    const byField = new Map<string, Map<string, Uuid[]>>();
    const note = (field: string, value: unknown, recordId: Uuid): void => {
      const canonical = JSON.stringify(value ?? null);
      const values = byField.get(field) ?? new Map<string, Uuid[]>();
      const ids = values.get(canonical) ?? [];
      ids.push(recordId);
      values.set(canonical, ids);
      byField.set(field, values);
    };
    for (const r of records) {
      note('status', r.status, r.id);
      for (const [k, v] of Object.entries(r.observedState)) note(`observedState.${k}`, v, r.id);
    }
    const differences: StatusDifference[] = [];
    for (const [field, values] of byField) {
      // A DIFFERENCE requires the SAME field reported by ≥2 records with ≥2 DISTINCT values.
      const reportingCount = [...values.values()].reduce((n, ids) => n + ids.length, 0);
      if (values.size < 2 || reportingCount < 2) continue;
      differences.push({
        field,
        values: [...values.entries()]
          .map(([canonical, recordIds]) => ({
            value: JSON.parse(canonical) as unknown,
            recordIds: [...recordIds].sort((a, b) => a.localeCompare(b)),
          }))
          .sort((a, b) => JSON.stringify(a.value).localeCompare(JSON.stringify(b.value))),
      });
    }
    return differences.sort((a, b) => a.field.localeCompare(b.field));
  }

  // -------------------------------------------------------------------------
  // EXCLUSION REVIEWS (AC6) + OWNERSHIP GAPS.
  // -------------------------------------------------------------------------

  /**
   * Intentionally EXCLUDE a source from governance. The source is NOT deleted: it transitions to
   * `excluded` AND a `governed_source` coverage gap is opened carrying the exclusion reason,
   * impact, required owner action, and a mandatory review-or-expiry deadline — so an excluded
   * source stays VISIBLE as a governed-source gap with a scheduled review, never silently dropped
   * (AC6). A review date OR an expiry (at least one) is required.
   */
  exclude(input: {
    sourceId: Uuid;
    reason: Reason;
    impact?: GapImpact;
    requiredAction: string;
    requiredOwner?: Uuid;
    reviewAt?: EpochMillis;
    expiresAt?: EpochMillis;
    at: EpochMillis;
  }): { entry: SourceCatalogEntry; gap: CoverageGap } {
    const entry = this.requireEntry(input.sourceId, 'exclude.sourceId');
    assertEpoch(input.at, 'exclude.at');
    if (!input.reason || typeof input.reason.code !== 'string') {
      throw new TypeError('exclude.reason must be a structured reason');
    }
    assertNonEmpty(input.requiredAction, 'exclude.requiredAction');
    if (input.reviewAt === undefined && input.expiresAt === undefined) {
      throw new RangeError('an exclusion review MUST carry a review date or an expiry (AC6)');
    }

    const transitioned = canOnboardingTransition(entry.onboardingState, 'excluded')
      ? this.rewriteEntry(entry, { onboardingState: 'excluded', lastSeenAt: input.at })
      : entry;

    const gap = this.openGap({
      sourceId: entry.id,
      gapClass: 'governed_source',
      reason: 'excluded',
      impact: input.impact ?? 'medium',
      requiredAction: input.requiredAction,
      ...(input.requiredOwner !== undefined ? { requiredOwner: input.requiredOwner } : {}),
      ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      at: input.at,
    });
    return { entry: transitioned, gap };
  }

  /**
   * Assess coverage of every catalogued source and synthesise the governed-source gaps AC6
   * requires: a discovered source that is UNSUPPORTED / INACCESSIBLE / SENSITIVE / UNOWNED /
   * EXCLUDED must be a VISIBLE `governed_source` gap with reason, impact, owner action, and a
   * review-or-expiry. Idempotent: an equivalent open gap for the same (source, reason) is not
   * duplicated. Returns every gap that is currently VISIBLE (the fail-visible coverage surface).
   */
  assessCoverage(input: { at: EpochMillis; reviewWindowMillis?: number }): readonly CoverageGap[] {
    assertEpoch(input.at, 'assessCoverage.at');
    const reviewWindow = input.reviewWindowMillis ?? 30 * 24 * 60 * 60 * 1000; // 30 days.
    for (const entry of this.entries.values()) {
      for (const reason of this.governedSourceGapReasons(entry)) {
        this.ensureGovernedSourceGap(entry, reason, input.at, input.at + reviewWindow);
      }
    }
    return this.coverageGaps().filter((g) => gapIsVisible(g));
  }

  /** The set of AC6 governed-source gap reasons a source currently exhibits. */
  private governedSourceGapReasons(entry: SourceCatalogEntry): GapReason[] {
    const reasons: GapReason[] = [];
    const history = this.contractsBySource.get(this.key(entry.id)) ?? [];
    const latest = history[history.length - 1];
    if (entry.onboardingState === 'excluded') reasons.push('excluded');
    if (latest && latest.supportLevel === 'unsupported') reasons.push('unsupported');
    if (entry.accessState === 'inaccessible' || entry.accessState === 'unreachable') {
      reasons.push('inaccessible');
    }
    if (entry.sensitivity === 'restricted' || entry.sensitivity === 'sensitive') {
      // Only a governance concern while not yet safely onboarded.
      if (entry.onboardingState !== 'onboarded') reasons.push('sensitive');
    }
    if (catalogEntryHasOwnershipGap(entry)) reasons.push('unowned');
    return reasons;
  }

  private ensureGovernedSourceGap(
    entry: SourceCatalogEntry,
    reason: GapReason,
    at: EpochMillis,
    reviewAt: EpochMillis,
  ): void {
    // Idempotency: skip if an open governed_source gap for this (source, reason) already exists.
    const existing = this.gapsForSource(entry.id).find(
      (g) => g.reason === reason && g.gapClass === 'governed_source' && gapIsVisible(g),
    );
    if (existing) return;
    this.openGap({
      sourceId: entry.id,
      gapClass: 'governed_source',
      reason,
      impact: reason === 'unsupported' || reason === 'inaccessible' ? 'high' : 'medium',
      requiredAction: this.ownerActionFor(reason),
      ...(entry.ownerPrincipalId !== undefined ? { requiredOwner: entry.ownerPrincipalId } : {}),
      reviewAt,
      at,
    });
  }

  private ownerActionFor(reason: GapReason): string {
    switch (reason) {
      case 'excluded':
        return 'Review the exclusion at the scheduled date and re-onboard or confirm exclusion.';
      case 'unsupported':
        return 'Provide a supported adapter/contract or formally accept the coverage gap.';
      case 'inaccessible':
        return 'Restore connectivity/credentials so the source can be observed.';
      case 'sensitive':
        return 'Complete a sensitivity/data-classification review before onboarding.';
      case 'unowned':
        return 'Assign an accountable steward/owner for this source.';
      default:
        return 'Assign an owner and remediate the coverage gap.';
    }
  }

  // -------------------------------------------------------------------------
  // RECONCILE (AC2) — keep every non-healthy source visible as a coverage gap.
  // -------------------------------------------------------------------------

  /**
   * Reconcile inventory: any catalogued source that is not cleanly onboarded+connected+healthy —
   * i.e. unmanaged / unreachable / stale / orphaned / excluded — MUST remain VISIBLE as a coverage
   * gap with reason, age, impact, and required owner action, rather than appear healthy or
   * disappear (AC2). Idempotent per (source, reason). Returns the currently-visible gaps.
   */
  reconcile(input: { at: EpochMillis }): readonly CoverageGap[] {
    assertEpoch(input.at, 'reconcile.at');
    for (const entry of this.entries.values()) {
      const staleness = this.stalenessOf(entry, input.at);
      const reason = this.componentGapReason(entry, staleness);
      if (reason) {
        const existing = this.gapsForSource(entry.id).find(
          (g) => g.reason === reason && g.gapClass === 'component' && gapIsVisible(g),
        );
        if (!existing) {
          this.openGap({
            sourceId: entry.id,
            gapClass: 'component',
            reason,
            impact: reason === 'orphaned' ? 'high' : 'medium',
            requiredAction: this.componentActionFor(reason),
            ...(entry.ownerPrincipalId !== undefined
              ? { requiredOwner: entry.ownerPrincipalId }
              : {}),
            at: input.at,
          });
        }
      }
    }
    return this.coverageGaps().filter((g) => gapIsVisible(g));
  }

  private componentGapReason(
    entry: SourceCatalogEntry,
    staleness: StalenessVerdict,
  ): GapReason | undefined {
    if (staleness === 'stale') return 'stale';
    if (entry.accessState === 'unreachable' || entry.accessState === 'inaccessible') {
      return 'unreachable';
    }
    if (entry.healthState === 'unknown' && entry.onboardingState === 'onboarded')
      return 'unmanaged';
    if (entry.onboardingState === 'discovered' || entry.onboardingState === 'pending') {
      return 'unmanaged';
    }
    return undefined;
  }

  private componentActionFor(reason: GapReason): string {
    switch (reason) {
      case 'stale':
        return 'Re-establish a fresh observation; do not rely on last-known state.';
      case 'unreachable':
        return 'Restore connectivity to the source and re-observe.';
      case 'unmanaged':
        return 'Complete onboarding so the source is governed, or exclude it with a review.';
      case 'orphaned':
        return 'Re-attach the orphaned component to an owner and boundary.';
      default:
        return 'Assign an owner and remediate the coverage gap.';
    }
  }

  // -------------------------------------------------------------------------
  // READ PATH — independently observable state (the mutation response is never the proof).
  // -------------------------------------------------------------------------

  /** All catalog entries (AC1/AC5), sorted by id for a stable read order. */
  catalog(): readonly SourceCatalogEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The full versioned contract history for a source (VO-52d0780c lineage; AC3 authoritative). */
  contracts(sourceId: Uuid): readonly SourceContract[] {
    const entry = this.requireEntry(sourceId, 'contracts.sourceId');
    return [...(this.contractsBySource.get(this.key(entry.id)) ?? [])];
  }

  /** The currently-effective (latest) contract for a source, if any. */
  latestContract(sourceId: Uuid): SourceContract | undefined {
    const h = this.contracts(sourceId);
    return h[h.length - 1];
  }

  /** The distinct source records observed for a source (AC3). */
  sourceRecordsFor(sourceId: Uuid): readonly SourceRecord[] {
    const entry = this.requireEntry(sourceId, 'sourceRecordsFor.sourceId');
    return [...(this.recordsBySource.get(this.key(entry.id))?.values() ?? [])].sort((a, b) =>
      sourceRecordIdentity(a).localeCompare(sourceRecordIdentity(b)),
    );
  }

  /** All coverage gaps (AC2/AC6), including resolved/terminal ones (history preserved). */
  coverageGaps(): readonly CoverageGap[] {
    return [...this.gaps.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The coverage gaps belonging to one source. */
  gapsForSource(sourceId: Uuid): readonly CoverageGap[] {
    const ids = this.gapIdsBySource.get(this.key(sourceId)) ?? new Set<string>();
    return [...ids].map((k) => this.gaps.get(k)!).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Age of a gap at `now` (AC2 age facet). */
  gapAge(gapId: Uuid, now: EpochMillis): number {
    const g = this.gaps.get(this.key(gapId));
    if (!g) throw new RangeError(`unknown gap: ${gapId}`);
    return gapAgeMillis(g, now);
  }

  /**
   * AC3 drill-down: a source's DISTINCT records, its contract lineage, its coverage gaps, the
   * per-field STATUS DIFFERENCES across those distinct records, and its DEPENDENCY edges — the
   * correlated-but-distinct view the officer sees when drilling into an item. Distinct records are
   * correlated (never merged); status differences surface where the records disagree; dependencies
   * name the sources this one depends on; the authoritative fields live on the contracts.
   */
  drillDown(sourceId: Uuid): {
    entry: SourceCatalogEntry;
    contracts: readonly SourceContract[];
    records: readonly SourceRecord[];
    gaps: readonly CoverageGap[];
    statusDifferences: readonly StatusDifference[];
    dependencies: readonly InventoryRelationship[];
    relationships: readonly InventoryRelationship[];
  } {
    const entry = this.requireEntry(sourceId, 'drillDown.sourceId');
    return {
      entry,
      contracts: this.contracts(entry.id),
      records: this.sourceRecordsFor(entry.id),
      gaps: this.gapsForSource(entry.id),
      statusDifferences: this.statusDifferencesFor(entry.id),
      dependencies: this.dependenciesFor(entry.id),
      relationships: this.relationshipsFor(entry.id),
    };
  }

  /**
   * AC1 + AC4: the officer's current-state view. Each source renders ONCE with its type, identity,
   * owner, onboarding lifecycle, access, health, sensitivity, evidence state, last-observation
   * time, and unresolved-issue count — and, when stale/unavailable, a fail-visible staleness
   * overlay (last-known time + confidence) with `reportedHealth` downgraded so current health is
   * NEVER inferred from stale data.
   */
  currentStateView(at: EpochMillis): readonly SourceStateRow[] {
    assertEpoch(at, 'currentStateView.at');
    return this.catalog().map((entry) => this.stateRow(entry, at));
  }

  private stateRow(entry: SourceCatalogEntry, at: EpochMillis): SourceStateRow {
    const staleness = this.stalenessOf(entry, at);
    const visibleGaps = this.gapsForSource(entry.id).filter((g) => gapIsVisible(g));
    const latest = this.latestContract(entry.id);
    const confidence = this.confidenceOf(entry, at, staleness);
    // AC4: never surface a positive current-health claim from stale/unavailable knowledge.
    const reportedHealth: CatalogHealthState =
      staleness === 'fresh' ? entry.healthState : 'unknown';
    const evidenceState: 'current' | 'stale' | 'absent' =
      latest === undefined
        ? 'absent'
        : staleness === 'fresh' && entry.onboardingState === 'onboarded'
          ? 'current'
          : 'stale';
    return compact({
      sourceId: entry.id,
      sourceClass: entry.sourceClass,
      classifiedUnknown: entry.sourceClass === UNKNOWN_SOURCE_CLASS,
      ...(entry.ownerPrincipalId !== undefined ? { ownerPrincipalId: entry.ownerPrincipalId } : {}),
      ownershipGap: catalogEntryHasOwnershipGap(entry),
      onboardingState: entry.onboardingState,
      accessState: entry.accessState,
      observedHealth: entry.healthState,
      reportedHealth,
      sensitivity: entry.sensitivity,
      evidenceState,
      staleness,
      lastKnownAt: entry.lastSeenAt,
      confidence,
      hasControlCoverage: visibleGaps.length === 0,
      unresolvedIssueCount: visibleGaps.length,
      ...(entry.discoveryEvidence !== undefined
        ? { discoveryEvidence: entry.discoveryEvidence }
        : {}),
      version: 1,
    }) as SourceStateRow;
  }

  /** AC4 staleness verdict for a source at `at`. */
  stalenessOf(entry: SourceCatalogEntry, at: EpochMillis): StalenessVerdict {
    assertEpoch(at, 'stalenessOf.at');
    if (entry.accessState === 'unreachable' || entry.accessState === 'inaccessible') {
      return 'unavailable';
    }
    const age = Math.max(0, at - entry.lastSeenAt);
    if (age >= this.horizon * 2) return 'unavailable';
    if (age >= this.horizon) return 'stale';
    return 'fresh';
  }

  /**
   * AC4 confidence ∈ [0,1]. FULL (1.0) while the source is fresh (within the horizon), then decays
   * linearly to 0 across the second horizon-width, and 0 once unavailable. Full confidence is only
   * ever reported for genuinely fresh knowledge; the moment a source is stale/unavailable the
   * confidence drops below 1, so the officer is never told stale data is fully trustworthy.
   */
  private confidenceOf(entry: SourceCatalogEntry, at: EpochMillis, s: StalenessVerdict): number {
    if (s === 'unavailable') return 0;
    if (s === 'fresh') return 1;
    // Stale: age ∈ [horizon, 2·horizon) ⇒ confidence ∈ (1, 0], decaying linearly.
    const age = Math.max(0, at - entry.lastSeenAt);
    const c = 1 - (age - this.horizon) / this.horizon;
    return Math.min(1, Math.max(0, Number(c.toFixed(6))));
  }

  // -------------------------------------------------------------------------
  // Digests — independently-observable durable-effect witnesses.
  // -------------------------------------------------------------------------

  /** A stable content digest over the WHOLE registry state (entries + contracts + records +
   * gaps). Changes iff any governed fact changes; identical iff the state is identical. This is
   * the durable-effect witness the tests read INSTEAD of trusting a mutation's return value. */
  snapshotDigest(): string {
    const parts: string[] = [];
    for (const entry of this.catalog()) {
      parts.push(sourceCatalogEntryDigest(entry));
      for (const c of this.contracts(entry.id)) parts.push(sourceContractDigest(c));
      for (const r of this.sourceRecordsFor(entry.id)) parts.push(sourceRecordDigest(r));
      for (const e of this.relationshipsFor(entry.id)) parts.push(inventoryRelationshipDigest(e));
    }
    for (const g of this.coverageGaps()) parts.push(coverageGapDigest(g));
    return sha256(JSON.stringify(parts.sort()));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private readonly externalKeys = new Map<string, Uuid>();

  private key(id: Uuid): string {
    return id;
  }

  private mintId(label: string): Uuid {
    const id = this.newId();
    assertUuidV7(id, label);
    return id;
  }

  private findEntryByExternalKey(externalKey: string): SourceCatalogEntry | undefined {
    const id = this.externalKeys.get(externalKey);
    return id ? this.entries.get(this.key(id)) : undefined;
  }

  private requireEntry(sourceId: Uuid, label: string): SourceCatalogEntry {
    assertUuid(sourceId, label);
    const entry = this.entries.get(this.key(sourceId));
    if (!entry) throw new RangeError(`unknown source: ${sourceId}`);
    return entry;
  }

  /** Rewrite a catalog entry through the domain factory (so every invariant is re-checked) and
   * store it, preserving identity + first-seen + gap links. */
  private rewriteEntry(
    entry: SourceCatalogEntry,
    patch: Partial<{
      onboardingState: OnboardingState;
      accessState: AccessState;
      healthState: CatalogHealthState;
      sensitivity: CatalogSensitivity;
      ownerPrincipalId: Uuid;
      lastSeenAt: EpochMillis;
    }>,
  ): SourceCatalogEntry {
    const ownerId = patch.ownerPrincipalId ?? entry.ownerPrincipalId;
    const nextOnboarding = patch.onboardingState ?? entry.onboardingState;
    let nextHealth = patch.healthState ?? entry.healthState;
    // Preserve the domain invariant `source_catalog_entry_unonboarded_not_healthy`: a source that
    // is (or is becoming) non-onboarded can never carry a 'healthy' claim. Leaving 'onboarded'
    // (e.g. exclusion) downgrades a stale 'healthy' to 'unknown' rather than throwing — the source
    // stays visible as a governed gap instead of masquerading as healthy.
    if (nextOnboarding !== 'onboarded' && nextHealth === 'healthy') nextHealth = 'unknown';
    const updated = makeSourceCatalogEntry({
      id: entry.id,
      tenantId: entry.tenantId,
      sourceClass: entry.sourceClass,
      ...(entry.boundaryId !== undefined ? { boundaryId: entry.boundaryId } : {}),
      observedLocations: entry.observedLocations,
      ...(ownerId !== undefined ? { ownerPrincipalId: ownerId } : {}),
      onboardingState: nextOnboarding,
      accessState: patch.accessState ?? entry.accessState,
      healthState: nextHealth,
      sensitivity: patch.sensitivity ?? entry.sensitivity,
      ...(entry.discoveryEvidence !== undefined
        ? { discoveryEvidence: entry.discoveryEvidence }
        : {}),
      coverageGapIds: entry.coverageGapIds,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: patch.lastSeenAt ?? entry.lastSeenAt,
    });
    this.entries.set(this.key(entry.id), updated);
    return updated;
  }

  /** Open a coverage gap through the domain factory and link it to its source + gap index. */
  private openGap(input: {
    sourceId: Uuid;
    gapClass: 'component' | 'governed_source';
    reason: GapReason;
    impact: GapImpact;
    requiredAction: string;
    requiredOwner?: Uuid;
    reviewAt?: EpochMillis;
    expiresAt?: EpochMillis;
    at: EpochMillis;
  }): CoverageGap {
    const id = this.mintId('gap.id');
    const gap = makeCoverageGap({
      id,
      tenantId: this.tenantId,
      subjectKind: 'source_catalog_entry',
      subjectId: input.sourceId,
      gapClass: input.gapClass,
      reason: input.reason,
      impact: input.impact,
      requiredAction: input.requiredAction,
      ...(input.requiredOwner !== undefined ? { requiredOwner: input.requiredOwner } : {}),
      status: 'open',
      firstSeenAt: input.at,
      ...(input.reviewAt !== undefined ? { reviewAt: input.reviewAt } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
    this.gaps.set(this.key(id), gap);
    let set = this.gapIdsBySource.get(this.key(input.sourceId));
    if (!set) {
      set = new Set();
      this.gapIdsBySource.set(this.key(input.sourceId), set);
    }
    set.add(this.key(id));
    return gap;
  }

  private contractPayloadDigest(c: SourceContract): string {
    // Digest of the contract's SEMANTIC payload (excludes id/timestamps) so idempotency + conflict
    // detection compare on meaning, not on the freshly-minted id.
    return sha256(
      JSON.stringify({
        sourceClass: c.sourceClass,
        version: c.version,
        supportLevel: c.supportLevel,
        authoritativeFields: [...c.authoritativeFields].sort(),
        accessMethod: c.accessMethod ?? null,
        sensitivity: c.sensitivity,
      }),
    );
  }
}

// ===========================================================================
// Free helpers re-exported for the read path / tests.
// ===========================================================================

export {
  catalogEntryHasOwnershipGap,
  catalogEntryNeedsAttention,
  gapIsVisible,
  gapHasReviewOrExpiry,
  sourceRecordFreshnessSuspect,
  makeReason,
};
