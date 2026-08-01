// @trustcircle/application — discovery SCAN / CANDIDATE / METADATA / ACCESS-LIMIT / SCAN-GAP ports
// (Phase 66). Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// This module DEFINES the five discovery ports — the hexagonal-architecture boundary between the
// governance core and whatever concrete discovery mechanism (an agent probing a computer boundary,
// a registry crawl, a metadata-only reader) sits behind them — as:
//
//   1. `DiscoveryScanPort`  — run a bounded scan over a declared boundary; return raw CANDIDATES
//                              plus the SCAN REPORT (what was reached, what was access-limited).
//   2. Candidate model      — a `DiscoveryCandidate` value: the raw evidence of ONE observed
//                              source, classified (type-or-`unknown`) but NOT yet onboarded, plus
//                              the constructors/guards that keep it well-formed.
//   3. `MetadataPort`       — a metadata-ONLY read of a known source: last-known observation time +
//                              confidence + staleness, so current health is never inferred from
//                              stale data (AC4). Read-only: it grants no authority and mutates
//                              nothing.
//   4. `AccessLimitPort`    — the declared access-limit / boundary policy: is a location in the
//                              declared computer boundary, and may it be scanned (supported /
//                              accessible / not-excluded)? Its verdict feeds candidate access-state
//                              and the scan-gap reasons (AC5/AC6).
//   5. `ScanGapPort`        — synthesise the visible COVERAGE / GOVERNED-SOURCE gaps from a scan:
//                              every unsupported / inaccessible / sensitive / unowned / excluded /
//                              unmanaged / unreachable / stale / orphaned candidate becomes a
//                              visible gap with reason, impact, owner action, and review-or-expiry
//                              (AC2/AC6) rather than disappearing or masquerading as healthy.
//
// The ports are pure, dependency-free (transitively `node:crypto` only) and NEVER read the wall
// clock: every scan/read call takes an explicit `at: EpochMillis` and draws identity from an
// injected `IdMint`. This module ALSO ships an in-memory reference implementation
// (`InMemoryDiscovery`) that composes the Phase-63 domain inventory value model
// (`SourceCatalogEntry`, `SourceRecord`, `CoverageGap`) so the port contracts are proven against
// independently-readable durable state — the scan RESPONSE is never the proof; the re-readable
// catalog / records / gaps and their content digests are.
//
// Governing oracles (acceptance criteria, witnessed in tests/unit/discovery-ports.unit.test.ts):
//   AC1 (VO-97e51bc6…) Healthy connected sources render ONCE with the full facet set →
//       `InMemoryDiscovery.currentState()` returns exactly one row per catalog identity with type /
//       source identity / owner / lifecycle-ish onboarding / access / health / sensitivity /
//       last-observation time / unresolved-issue (gap) count.
//   AC2 (VO-ddfe8765…) A discovered-but-unmanaged / unreachable / stale / orphaned / excluded
//       component stays a VISIBLE coverage gap with reason / age / impact / required owner action →
//       `ScanGapPort.componentGaps()` + `gapAgeMillis` keep it visible; never healthy, never gone.
//   AC3 (VO-00ce81eb…) Related work across registered sources keeps DISTINCT source records with
//       correlation / authoritative fields → each candidate is stored as its own `SourceRecord`
//       keyed by `sourceRecordIdentity`, re-readable via `recordsFor()`.
//   AC4 (VO-7e451be7…) A stale/unavailable source is marked with last-known time + confidence and
//       current health is NOT inferred from stale data → `MetadataPort.read()` returns a
//       `SourceMetadata` whose `freshness`/`confidence` gate a `reportedHealth` that collapses to
//       `unknown` unless the observation is fresh.
//   AC5 (VO-990d198a…) An unregistered governance-relevant source appearing in the boundary is
//       ADDED to the catalog with discovery evidence / type-or-unknown / location / access /
//       sensitivity / ownership status / onboarding state → `DiscoveryScanPort.scan()` +
//       `ingest()`.
//   AC6 (VO-01258a77…) A discovered source that is unsupported / inaccessible / sensitive /
//       unowned / excluded stays a VISIBLE governed-source gap with reason / impact / owner action /
//       review-or-expiry → `ScanGapPort.governedSourceGaps()`.

import {
  isUuid,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
} from '@trustcircle/domain';
import {
  makeSourceCatalogEntry,
  sourceCatalogEntryDigest,
  catalogEntryHasOwnershipGap,
  catalogEntryNeedsAttention,
  type SourceCatalogEntry,
  type OnboardingState,
  type AccessState,
  ACCESS_STATES,
  type CatalogHealthState,
  type CatalogSensitivity,
  CATALOG_SENSITIVITIES,
  UNKNOWN_SOURCE_CLASS,
  makeSourceRecord,
  sourceRecordIdentity,
  sourceRecordDigest,
  sourceRecordFreshnessSuspect,
  type SourceRecord,
  type FreshnessState,
  FRESHNESS_STATES,
  makeCoverageGap,
  coverageGapDigest,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  type CoverageGap,
  type GapReason,
  type GapImpact,
  type GapClass,
} from '@trustcircle/domain';
import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Shared guards + helpers (fail-fast, fail-visible — mirror the domain guards).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}
function assertTenant(t: unknown, label: string): asserts t is TenantId {
  if (t !== PLATFORM_SCOPE && !isUuid(t)) {
    throw new TypeError(`${label} must be a TenantId (UUID or the platform scope)`);
  }
}
function assertEpoch(ms: unknown, label: string): asserts ms is EpochMillis {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative epoch-millis number`);
  }
}
function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** An injected identity mint — the ports never read the wall clock or `crypto.randomUUID`
 * directly, so scans are deterministic and independently reproducible. */
export type IdMint = () => Uuid;

// ===========================================================================
// 1. CANDIDATE port — the raw evidence of ONE observed, not-yet-onboarded source.
//    A candidate is deliberately DISTINCT from a `SourceCatalogEntry`: it is the
//    unclassified/unmanaged observation the scan emits BEFORE the catalog decides
//    to onboard, exclude, or open a gap. It always carries type-or-`unknown`
//    classification, its observed location, an access verdict, sensitivity, an
//    ownership signal, and the discovery-evidence reference (AC5).
// ===========================================================================

/** Why a candidate cannot be treated as a healthy, governed source — the union of the AC2
 * component reasons and the AC6 governed-source reasons, aligned with the domain `GapReason`. */
export const CANDIDATE_CONCERNS = [
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
export type CandidateConcern = (typeof CANDIDATE_CONCERNS)[number];

export interface DiscoveryCandidate {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  /** Type classification or `unknown` — a discovered source may be of an unknown class (AC5). */
  readonly sourceClass: string;
  /** True iff `sourceClass === 'unknown'` — the explicit unknown-classification flag. */
  readonly classifiedUnknown: boolean;
  /** The declared boundary the scan attributed this observation to. */
  readonly boundaryId?: Uuid;
  /** Where the source was observed (host / URL / path) — always at least one location. */
  readonly observedLocations: readonly string[];
  readonly accessState: AccessState;
  readonly sensitivity: CatalogSensitivity;
  /** The owning principal, or absent ⇒ an OWNERSHIP GAP (AC5/AC6). */
  readonly ownerPrincipalId?: Uuid;
  /** Reference to the durable discovery-evidence record proving the source was seen (AC5). */
  readonly discoveryEvidence: Uuid;
  /** The concerns that keep this candidate from being onboarded silently (AC6). */
  readonly concerns: readonly CandidateConcern[];
  readonly observedAt: EpochMillis;
}

export function makeDiscoveryCandidate(input: {
  id: Uuid;
  tenantId: TenantId;
  sourceClass?: string;
  boundaryId?: Uuid;
  observedLocations: readonly string[];
  accessState?: AccessState;
  sensitivity?: CatalogSensitivity;
  ownerPrincipalId?: Uuid;
  discoveryEvidence: Uuid;
  concerns?: readonly CandidateConcern[];
  observedAt: EpochMillis;
}): DiscoveryCandidate {
  assertUuid(input.id, 'candidate.id');
  assertTenant(input.tenantId, 'candidate.tenantId');
  const sourceClass = input.sourceClass ?? UNKNOWN_SOURCE_CLASS;
  assertNonEmpty(sourceClass, 'candidate.sourceClass');
  if (input.boundaryId !== undefined) assertUuid(input.boundaryId, 'candidate.boundaryId');
  if (!Array.isArray(input.observedLocations) || input.observedLocations.length === 0) {
    throw new TypeError('candidate.observedLocations must be a non-empty array');
  }
  for (const loc of input.observedLocations) assertNonEmpty(loc, 'candidate.observedLocations[]');
  const accessState = input.accessState ?? 'unknown';
  if (!ACCESS_STATES.includes(accessState)) {
    throw new RangeError(`candidate.accessState invalid: ${String(accessState)}`);
  }
  const sensitivity = input.sensitivity ?? 'normal';
  if (!CATALOG_SENSITIVITIES.includes(sensitivity)) {
    throw new RangeError(`candidate.sensitivity invalid: ${String(sensitivity)}`);
  }
  if (input.ownerPrincipalId !== undefined) {
    assertUuid(input.ownerPrincipalId, 'candidate.ownerPrincipalId');
  }
  assertUuid(input.discoveryEvidence, 'candidate.discoveryEvidence');
  const concerns = input.concerns ?? [];
  for (const c of concerns) {
    if (!CANDIDATE_CONCERNS.includes(c)) {
      throw new RangeError(`candidate.concerns invalid entry: ${String(c)}`);
    }
  }
  assertEpoch(input.observedAt, 'candidate.observedAt');

  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    sourceClass,
    classifiedUnknown: sourceClass === UNKNOWN_SOURCE_CLASS,
    ...(input.boundaryId !== undefined ? { boundaryId: input.boundaryId } : {}),
    observedLocations: Object.freeze([...input.observedLocations]),
    accessState,
    sensitivity,
    ...(input.ownerPrincipalId !== undefined ? { ownerPrincipalId: input.ownerPrincipalId } : {}),
    discoveryEvidence: input.discoveryEvidence,
    concerns: Object.freeze([...new Set(concerns)]),
    observedAt: input.observedAt,
  });
}

/** True iff the candidate has no owning principal ⇒ an ownership gap (AC5/AC6). */
export function candidateHasOwnershipGap(c: DiscoveryCandidate): boolean {
  return c.ownerPrincipalId === undefined;
}

/** True iff this candidate must stay a VISIBLE gap rather than be onboarded silently — i.e. it
 * carries at least one concern, is unowned, or is not cleanly connected (AC5/AC6). */
export function candidateNeedsGovernance(c: DiscoveryCandidate): boolean {
  return (
    c.concerns.length > 0 ||
    candidateHasOwnershipGap(c) ||
    c.accessState !== 'connected' ||
    c.classifiedUnknown
  );
}

export function discoveryCandidateDigest(c: DiscoveryCandidate): string {
  return sha256(
    JSON.stringify({
      id: c.id,
      tenantId: c.tenantId,
      sourceClass: c.sourceClass,
      classifiedUnknown: c.classifiedUnknown,
      boundaryId: c.boundaryId ?? null,
      observedLocations: [...c.observedLocations].sort(),
      accessState: c.accessState,
      sensitivity: c.sensitivity,
      ownerPrincipalId: c.ownerPrincipalId ?? null,
      discoveryEvidence: c.discoveryEvidence,
      concerns: [...c.concerns].sort(),
      observedAt: c.observedAt,
    }),
  );
}

// ===========================================================================
// 2. ACCESS-LIMIT port — the declared boundary + scan policy. It answers, for a
//    location, whether it is IN the declared computer boundary and whether it may
//    be scanned (supported / accessible / not-excluded). Its verdict drives the
//    candidate access-state and the scan-gap reasons (AC5/AC6). Read-only.
// ===========================================================================

/** The disposition of a location against the access-limit policy. `admit` ⇒ scan it; every other
 * verdict maps to a candidate concern / gap reason and keeps the source VISIBLE, not dropped. */
export const ACCESS_LIMIT_VERDICTS = [
  'admit',
  'out_of_boundary',
  'unsupported',
  'inaccessible',
  'sensitive',
  'excluded',
] as const;
export type AccessLimitVerdict = (typeof ACCESS_LIMIT_VERDICTS)[number];

export interface AccessDecision {
  readonly verdict: AccessLimitVerdict;
  /** True iff the location is inside the declared computer boundary (AC5 precondition). */
  readonly inBoundary: boolean;
  /** The concern this decision implies, if the location is not cleanly admitted. */
  readonly concern?: CandidateConcern;
  /** When a review/expiry is required for a governed-source exclusion (AC6). */
  readonly reviewAt?: EpochMillis;
}

/** Map a non-`admit` access verdict to the candidate concern / gap reason it implies. `admit`
 * and `out_of_boundary` imply no in-catalog concern (out-of-boundary is simply not ingested). */
export function accessVerdictConcern(v: AccessLimitVerdict): CandidateConcern | undefined {
  switch (v) {
    case 'unsupported':
      return 'unsupported';
    case 'inaccessible':
      return 'inaccessible';
    case 'sensitive':
      return 'sensitive';
    case 'excluded':
      return 'excluded';
    case 'admit':
    case 'out_of_boundary':
      return undefined;
  }
}

/** The ACCESS-LIMIT PORT: decide whether a location may be scanned. Read-only, deterministic. */
export interface AccessLimitPort {
  /** Decide a single observed location against the declared boundary + scan policy. */
  decide(input: { tenantId: TenantId; location: string; at: EpochMillis }): AccessDecision;
}

// ===========================================================================
// 3. METADATA port — a metadata-ONLY read of a known source. It NEVER infers
//    current health from stale data (AC4): the returned `reportedHealth` collapses
//    to `unknown` unless the observation is fresh, and always carries the
//    last-known time + confidence so the UI can mark stale data explicitly.
// ===========================================================================

export interface SourceMetadata {
  readonly catalogId: Uuid;
  readonly tenantId: TenantId;
  readonly sourceClass: string;
  readonly freshness: FreshnessState;
  /** [0,1] confidence in the last-known observation. */
  readonly confidence: number;
  readonly lastKnownAt: EpochMillis;
  /** The observed health — or `unknown` when the observation is NOT fresh (AC4). */
  readonly reportedHealth: CatalogHealthState;
  /** True iff `freshness !== 'fresh'` — this metadata must be marked stale, not read as current. */
  readonly staleMarked: boolean;
}

export function makeSourceMetadata(input: {
  catalogId: Uuid;
  tenantId: TenantId;
  sourceClass: string;
  freshness: FreshnessState;
  confidence: number;
  lastKnownAt: EpochMillis;
  /** The RAW observed health. It is only surfaced as-is when fresh; otherwise → `unknown`. */
  observedHealth: CatalogHealthState;
}): SourceMetadata {
  assertUuid(input.catalogId, 'metadata.catalogId');
  assertTenant(input.tenantId, 'metadata.tenantId');
  assertNonEmpty(input.sourceClass, 'metadata.sourceClass');
  if (!FRESHNESS_STATES.includes(input.freshness)) {
    throw new RangeError(`metadata.freshness invalid: ${String(input.freshness)}`);
  }
  if (
    typeof input.confidence !== 'number' ||
    Number.isNaN(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new RangeError('metadata.confidence must be in [0,1]');
  }
  assertEpoch(input.lastKnownAt, 'metadata.lastKnownAt');

  const fresh = input.freshness === 'fresh';
  // AC4 — current health is NEVER inferred from stale/unknown data.
  const reportedHealth: CatalogHealthState = fresh ? input.observedHealth : 'unknown';

  return Object.freeze({
    catalogId: input.catalogId,
    tenantId: input.tenantId,
    sourceClass: input.sourceClass,
    freshness: input.freshness,
    confidence: input.confidence,
    lastKnownAt: input.lastKnownAt,
    reportedHealth,
    staleMarked: !fresh,
  });
}

/** True iff this metadata's health may be treated as CURRENT (fresh only) (AC4). */
export function metadataHealthIsCurrent(m: SourceMetadata): boolean {
  return m.freshness === 'fresh' && !m.staleMarked;
}

/** The METADATA PORT: read the metadata-only view of one known source. Read-only. */
export interface MetadataPort {
  read(input: { tenantId: TenantId; catalogId: Uuid; at: EpochMillis }): SourceMetadata | undefined;
}

// ===========================================================================
// 4. SCAN-GAP port — synthesise the VISIBLE coverage / governed-source gaps from a
//    scan. Every candidate that is unmanaged / unreachable / stale / orphaned
//    (component, AC2) or unsupported / inaccessible / sensitive / unowned / excluded
//    (governed source, AC6) becomes a visible gap with reason, impact, owner action
//    and — for governed-source gaps — a review-or-expiry deadline.
// ===========================================================================

/** Which gap class a concern belongs to: component concerns (AC2) vs governed-source concerns
 * (AC6). Ownership (`unowned`) is a governed-source concern. */
const COMPONENT_CONCERNS: ReadonlySet<CandidateConcern> = new Set([
  'unmanaged',
  'unreachable',
  'stale',
  'orphaned',
]);

export function concernGapClass(concern: CandidateConcern): GapClass {
  return COMPONENT_CONCERNS.has(concern) ? 'component' : 'governed_source';
}

/** The SCAN-GAP PORT: turn a scan's candidates into VISIBLE, re-readable gaps (AC2/AC6). */
export interface ScanGapPort {
  /** All currently-visible COMPONENT coverage gaps (AC2). */
  componentGaps(): readonly CoverageGap[];
  /** All currently-visible GOVERNED-SOURCE gaps (AC6). Each carries a review-or-expiry. */
  governedSourceGaps(): readonly CoverageGap[];
}

// ===========================================================================
// 5. DISCOVERY-SCAN port — run a bounded scan over a declared boundary and return
//    the raw CANDIDATES plus a SCAN REPORT (reached / access-limited / out-of-
//    boundary counts) so degradation is visible and alertable.
// ===========================================================================

export interface ScanReport {
  readonly boundaryId?: Uuid;
  readonly scannedAt: EpochMillis;
  readonly reached: number;
  readonly admitted: number;
  readonly accessLimited: number;
  readonly outOfBoundary: number;
}

export interface ScanResult {
  readonly candidates: readonly DiscoveryCandidate[];
  readonly report: ScanReport;
}

/** The DISCOVERY-SCAN PORT: run a scan; return candidates + report. */
export interface DiscoveryScanPort {
  scan(input: {
    tenantId: TenantId;
    boundaryId?: Uuid;
    /** Raw observed locations to evaluate against the access-limit policy. */
    locations: readonly string[];
    at: EpochMillis;
  }): ScanResult;
}

// ===========================================================================
// 6. Reference implementation — an in-memory composition over the domain model.
//    Every mutation is proven through an INDEPENDENTLY re-readable surface
//    (`catalog()`, `recordsFor()`, `componentGaps()`, `governedSourceGaps()`,
//    `currentState()`, `snapshotDigest()`); the scan response is never the proof.
// ===========================================================================

export interface DiscoveryConfig {
  readonly tenantId: TenantId;
  readonly mint: IdMint;
  readonly access: AccessLimitPort;
  /** Freshness horizon (ms): an observation older than this is `stale` for metadata reads (AC4). */
  readonly freshnessHorizonMs: number;
}

/** One row of the current-state view (AC1): each catalog identity appears EXACTLY once. */
export interface DiscoveryStateRow {
  readonly catalogId: Uuid;
  readonly sourceClass: string;
  readonly classifiedUnknown: boolean;
  readonly ownerPrincipalId?: Uuid;
  readonly ownershipGap: boolean;
  readonly onboardingState: OnboardingState;
  readonly accessState: AccessState;
  readonly healthState: CatalogHealthState;
  readonly sensitivity: CatalogSensitivity;
  readonly lastObservationAt: EpochMillis;
  readonly unresolvedIssues: number;
  readonly needsAttention: boolean;
}

export class InMemoryDiscovery implements DiscoveryScanPort, MetadataPort, ScanGapPort {
  private readonly tenantId: TenantId;
  private readonly mint: IdMint;
  private readonly access: AccessLimitPort;
  private readonly horizon: number;

  /** Keyed by catalog identity (`tenantId|externalKey`) so a source appears ONCE (AC1). */
  private readonly catalogByKey = new Map<string, SourceCatalogEntry>();
  private readonly keyByCatalogId = new Map<Uuid, string>();
  /** Keyed by `sourceRecordIdentity` so DISTINCT records never collapse (AC3). */
  private readonly recordByIdentity = new Map<string, SourceRecord>();
  private readonly gapById = new Map<Uuid, CoverageGap>();

  constructor(cfg: DiscoveryConfig) {
    assertTenant(cfg.tenantId, 'config.tenantId');
    if (typeof cfg.mint !== 'function') throw new TypeError('config.mint must be a function');
    if (typeof cfg.access?.decide !== 'function') {
      throw new TypeError('config.access must be an AccessLimitPort');
    }
    if (typeof cfg.freshnessHorizonMs !== 'number' || cfg.freshnessHorizonMs <= 0) {
      throw new RangeError('config.freshnessHorizonMs must be a positive number');
    }
    this.tenantId = cfg.tenantId;
    this.mint = cfg.mint;
    this.access = cfg.access;
    this.horizon = cfg.freshnessHorizonMs;
  }

  private assertOwnTenant(t: TenantId, label: string): void {
    if (t !== this.tenantId) throw new RangeError(`${label} tenant escapes this discovery scope`);
  }

  // --- DiscoveryScanPort ---------------------------------------------------

  scan(input: {
    tenantId: TenantId;
    boundaryId?: Uuid;
    locations: readonly string[];
    at: EpochMillis;
  }): ScanResult {
    assertTenant(input.tenantId, 'scan.tenantId');
    this.assertOwnTenant(input.tenantId, 'scan');
    if (input.boundaryId !== undefined) assertUuid(input.boundaryId, 'scan.boundaryId');
    if (!Array.isArray(input.locations)) throw new TypeError('scan.locations must be an array');
    assertEpoch(input.at, 'scan.at');

    const candidates: DiscoveryCandidate[] = [];
    let admitted = 0;
    let accessLimited = 0;
    let outOfBoundary = 0;

    for (const location of input.locations) {
      assertNonEmpty(location, 'scan.locations[]');
      const decision = this.access.decide({ tenantId: input.tenantId, location, at: input.at });
      if (!decision.inBoundary || decision.verdict === 'out_of_boundary') {
        outOfBoundary += 1;
        continue; // out-of-boundary sources are not ingested into the governed catalog.
      }
      const concern = decision.concern ?? accessVerdictConcern(decision.verdict);
      const accessState: AccessState =
        decision.verdict === 'inaccessible'
          ? 'inaccessible'
          : decision.verdict === 'admit'
            ? 'reachable'
            : 'degraded';
      const candidate = makeDiscoveryCandidate({
        id: this.mint(),
        tenantId: input.tenantId,
        ...(input.boundaryId !== undefined ? { boundaryId: input.boundaryId } : {}),
        observedLocations: [location],
        accessState,
        sensitivity: decision.verdict === 'sensitive' ? 'sensitive' : 'normal',
        discoveryEvidence: this.mint(),
        ...(concern !== undefined ? { concerns: [concern] } : {}),
        observedAt: input.at,
      });
      candidates.push(candidate);
      if (decision.verdict === 'admit') admitted += 1;
      else accessLimited += 1;
    }

    return Object.freeze({
      candidates: Object.freeze(candidates),
      report: Object.freeze({
        ...(input.boundaryId !== undefined ? { boundaryId: input.boundaryId } : {}),
        scannedAt: input.at,
        reached: candidates.length,
        admitted,
        accessLimited,
        outOfBoundary,
      }),
    });
  }

  /** INGEST a candidate (AC5): add it to the source catalog with discovery evidence, type-or-
   * unknown classification, location, access, sensitivity, ownership status and onboarding state,
   * store its distinct source record (AC3), and open the visible gaps its concerns imply
   * (AC2/AC6). Idempotent per external key: a re-ingest updates the same catalog identity. */
  ingest(input: {
    externalKey: string;
    candidate: DiscoveryCandidate;
    at: EpochMillis;
    /** Optional review/expiry for governed-source exclusions (AC6). */
    reviewAt?: EpochMillis;
  }): { catalog: SourceCatalogEntry; record: SourceRecord; gaps: readonly CoverageGap[] } {
    assertNonEmpty(input.externalKey, 'ingest.externalKey');
    this.assertOwnTenant(input.candidate.tenantId, 'ingest.candidate');
    assertEpoch(input.at, 'ingest.at');
    if (input.reviewAt !== undefined) assertEpoch(input.reviewAt, 'ingest.reviewAt');

    const c = input.candidate;
    const key = `${c.tenantId}|${input.externalKey}`;
    const prior = this.catalogByKey.get(key);
    const catalogId = prior?.id ?? this.mint();

    // A candidate with concerns / no owner / not connected stays a visible gap: onboardingState
    // MUST NOT be `onboarded` (the domain rejects a not-onboarded 'healthy' entry), and its
    // health is `unknown` until governance onboards it (AC5/AC6 — never masquerade as healthy).
    const excluded = c.concerns.includes('excluded');
    const onboardingState: OnboardingState = excluded ? 'excluded' : 'discovered';

    const entry = makeSourceCatalogEntry({
      id: catalogId,
      tenantId: c.tenantId,
      sourceClass: c.sourceClass,
      ...(c.boundaryId !== undefined ? { boundaryId: c.boundaryId } : {}),
      observedLocations: c.observedLocations,
      ...(c.ownerPrincipalId !== undefined ? { ownerPrincipalId: c.ownerPrincipalId } : {}),
      onboardingState,
      accessState: c.accessState,
      healthState: 'unknown',
      sensitivity: c.sensitivity,
      discoveryEvidence: c.discoveryEvidence,
      firstSeenAt: prior?.firstSeenAt ?? input.at,
      lastSeenAt: input.at,
    });
    this.catalogByKey.set(key, entry);
    this.keyByCatalogId.set(catalogId, key);

    // AC3 — distinct raw source record keyed by (tenant, catalog, externalKey).
    const record = makeSourceRecord({
      id: this.mint(),
      tenantId: c.tenantId,
      catalogId,
      sourceClass: c.sourceClass,
      externalKey: input.externalKey,
      observedState: { accessState: c.accessState, locations: [...c.observedLocations] },
      status: 'unknown',
      freshness: 'fresh',
      confidence: 1.0,
      lastKnownAt: input.at,
      observedAt: c.observedAt,
    });
    this.recordByIdentity.set(sourceRecordIdentity(record), record);

    // AC2/AC6 — open a visible gap for each concern; ownership gap ⇒ an `unowned` governed gap.
    const concerns = new Set<CandidateConcern>(c.concerns);
    if (candidateHasOwnershipGap(c)) concerns.add('unowned');
    const gaps: CoverageGap[] = [];
    for (const concern of concerns) {
      const gapClass = concernGapClass(concern);
      const impact: GapImpact = impactForConcern(concern);
      const needsDeadline = gapClass === 'governed_source';
      const reviewAt = input.reviewAt ?? (needsDeadline ? input.at + this.horizon : undefined);
      const gap = makeCoverageGap({
        id: this.mint(),
        tenantId: c.tenantId,
        subjectKind: 'source_catalog_entry',
        subjectId: catalogId,
        gapClass,
        reason: concern as GapReason,
        impact,
        requiredAction: requiredActionForConcern(concern),
        ...(c.ownerPrincipalId !== undefined ? { requiredOwner: c.ownerPrincipalId } : {}),
        status: 'open',
        firstSeenAt: input.at,
        ...(needsDeadline && reviewAt !== undefined ? { reviewAt } : {}),
      });
      this.gapById.set(gap.id, gap);
      gaps.push(gap);
    }

    return { catalog: entry, record, gaps: Object.freeze(gaps) };
  }

  // --- MetadataPort --------------------------------------------------------

  read(input: {
    tenantId: TenantId;
    catalogId: Uuid;
    at: EpochMillis;
  }): SourceMetadata | undefined {
    assertTenant(input.tenantId, 'read.tenantId');
    this.assertOwnTenant(input.tenantId, 'read');
    assertUuid(input.catalogId, 'read.catalogId');
    assertEpoch(input.at, 'read.at');

    const key = this.keyByCatalogId.get(input.catalogId);
    if (key === undefined) return undefined;
    const entry = this.catalogByKey.get(key);
    if (entry === undefined) return undefined;

    const ageMs = input.at - entry.lastSeenAt;
    const fresh = ageMs >= 0 && ageMs <= this.horizon;
    const freshness: FreshnessState = fresh ? 'fresh' : 'stale';
    // Confidence full while fresh, decays to a floor once stale (AC4 — mark, don't infer current).
    const confidence = fresh ? 1.0 : 0.3;

    return makeSourceMetadata({
      catalogId: entry.id,
      tenantId: entry.tenantId,
      sourceClass: entry.sourceClass,
      freshness,
      confidence,
      lastKnownAt: entry.lastSeenAt,
      observedHealth: entry.healthState,
    });
  }

  // --- ScanGapPort ---------------------------------------------------------

  componentGaps(): readonly CoverageGap[] {
    return Object.freeze(
      [...this.gapById.values()].filter((g) => g.gapClass === 'component' && gapIsVisible(g)),
    );
  }

  governedSourceGaps(): readonly CoverageGap[] {
    return Object.freeze(
      [...this.gapById.values()].filter((g) => g.gapClass === 'governed_source' && gapIsVisible(g)),
    );
  }

  // --- Read surfaces (independent witnesses) -------------------------------

  catalog(): readonly SourceCatalogEntry[] {
    return Object.freeze([...this.catalogByKey.values()]);
  }

  recordsFor(catalogId: Uuid): readonly SourceRecord[] {
    assertUuid(catalogId, 'recordsFor.catalogId');
    return Object.freeze(
      [...this.recordByIdentity.values()].filter((r) => r.catalogId === catalogId),
    );
  }

  allRecords(): readonly SourceRecord[] {
    return Object.freeze([...this.recordByIdentity.values()]);
  }

  gaps(): readonly CoverageGap[] {
    return Object.freeze([...this.gapById.values()]);
  }

  /** AC1 — the current-state view: exactly ONE row per catalog identity, full facet set. */
  currentState(): readonly DiscoveryStateRow[] {
    const rows: DiscoveryStateRow[] = [];
    for (const entry of this.catalogByKey.values()) {
      const unresolved = [...this.gapById.values()].filter(
        (g) => g.subjectId === entry.id && gapIsVisible(g),
      ).length;
      rows.push(
        Object.freeze({
          catalogId: entry.id,
          sourceClass: entry.sourceClass,
          classifiedUnknown: entry.sourceClass === UNKNOWN_SOURCE_CLASS,
          ...(entry.ownerPrincipalId !== undefined
            ? { ownerPrincipalId: entry.ownerPrincipalId }
            : {}),
          ownershipGap: catalogEntryHasOwnershipGap(entry),
          onboardingState: entry.onboardingState,
          accessState: entry.accessState,
          healthState: entry.healthState,
          sensitivity: entry.sensitivity,
          lastObservationAt: entry.lastSeenAt,
          unresolvedIssues: unresolved,
          needsAttention: catalogEntryNeedsAttention(entry),
        }),
      );
    }
    return Object.freeze(rows);
  }

  /** A durable content digest over the whole discovery state — changes iff a governed fact
   * changes. The independent witness that a scan/ingest produced a real durable effect. */
  snapshotDigest(): string {
    const catalog = [...this.catalogByKey.values()].map(sourceCatalogEntryDigest).sort();
    const records = [...this.recordByIdentity.values()].map(sourceRecordDigest).sort();
    const gaps = [...this.gapById.values()].map(coverageGapDigest).sort();
    return sha256(JSON.stringify({ catalog, records, gaps }));
  }
}

// --- concern → (impact, action) mapping (visible, non-empty owner action; AC2/AC6) ----------

function impactForConcern(concern: CandidateConcern): GapImpact {
  switch (concern) {
    case 'inaccessible':
    case 'unreachable':
      return 'high';
    case 'sensitive':
    case 'unsupported':
      return 'medium';
    case 'unowned':
    case 'orphaned':
      return 'medium';
    case 'stale':
    case 'unmanaged':
      return 'low';
    case 'excluded':
      return 'low';
  }
}

function requiredActionForConcern(concern: CandidateConcern): string {
  switch (concern) {
    case 'unmanaged':
      return 'Onboard the source under a versioned source contract.';
    case 'unreachable':
      return 'Restore connectivity or record the outage owner and next action.';
    case 'stale':
      return 'Refresh the observation; do not treat stale data as current.';
    case 'orphaned':
      return 'Re-parent the orphaned component to an owning source.';
    case 'excluded':
      return 'Record exclusion rationale and schedule a review before expiry.';
    case 'unsupported':
      return 'Assess connector support or mark the gap as accepted risk with review.';
    case 'inaccessible':
      return 'Grant scan access under policy or document the inaccessible-source gap.';
    case 'sensitive':
      return 'Apply sensitivity handling and confirm authorization before onboarding.';
    case 'unowned':
      return 'Assign an accountable owner to the discovered source.';
  }
}

/** True iff every visible governed-source gap carries a review-or-expiry deadline (AC6). A
 * cheap invariant callers can assert over `governedSourceGaps()`. */
export function allGovernedGapsHaveDeadline(gaps: readonly CoverageGap[]): boolean {
  return gaps.every((g) => gapHasReviewOrExpiry(g));
}

/** True iff a metadata read is safe to treat as authoritative current health (AC4). */
export function metadataSuspect(m: SourceMetadata): boolean {
  return m.staleMarked;
}

/** Re-export the domain freshness-suspect predicate so consumers of the discovery ports can gate
 * on record freshness without importing the domain package directly (AC4). */
export { sourceRecordFreshnessSuspect, gapAgeMillis };
