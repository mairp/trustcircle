// TrustCircleAI — Phase 77 current-state DERIVATION for the application shell.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The Phase-77 shell (apps/web/src/app/layout.tsx) is a PURE PRESENTER: `renderAppShell(props)`
// renders whatever `CurrentStateModel` it is handed. This module is where that model is *earned*
// — it is DERIVED by running the REAL Phase-70 current-inventory assembly service
// (`packages/application/src/inventory-service.ts`), which itself composes the Phase-64
// correlation engine over the Phase-63 domain value model, against an explicit, deterministic
// input scenario. The rendered numbers are therefore a FUNCTION of genuine reconciliation logic,
// not literals typed into the view:
//
//   • AC1 "each item once" holds because `InventoryService` keys assets by id and emits one
//     `InventoryRow` per asset — feed a duplicate observation and you still get ONE row.
//   • AC2/AC6 gaps stay visible because the service never deletes a gap (`componentGaps()` /
//     `governedSourceGaps()` retain every still-visible gap with reason/age/impact/action).
//   • AC3 drill-down returns the DISTINCT `SourceRecord`s + dependency/authoritative edges the
//     service correlated — not a hand-written summary string.
//   • AC4 `reportedHealth` is `'unknown'` (never the observed health) the moment any contributing
//     record is stale — the service REFUSES to infer current health from stale data.
//   • AC5 the catalog view carries the discovery evidence / classification / access / sensitivity
//     / ownership / onboarding facets the service read back from the ingested catalog entry.
//
// The accessibility spec (app-shell.spec.ts) builds a scenario here, mutates its INPUT for each
// RED negative control (a stale record, a duplicate id, a dropped review deadline, …), re-derives
// the model through the real service, and asserts the SHELL's rendered DOM reflects the service's
// independently-computed output. Expectations come from the service, not from the view — so the
// oracle cannot be satisfied by a static template.
//
// DETERMINISM. No wall clock, no randomness: a monotonic UUIDv7 factory with a fixed random
// filler, explicit epoch-millis, and an explicit read instant `at`. Same scenario ⇒ byte-stable
// model ⇒ byte-stable render.

import {
  uuidV7,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
  type TenantId,
} from '../../../packages/domain/src/primitives.ts';
import {
  makeGovernedAsset,
  makeSourceRecord,
  makeCoverageGap,
  makeSourceCatalogEntry,
  makeInventoryRelationship,
  gapAgeMillis,
  gapHasReviewOrExpiry,
  UNKNOWN_SOURCE_CLASS,
  type GovernedAsset,
  type SourceRecord,
  type CoverageGap,
  type SourceCatalogEntry,
  type GapReason,
  type FreshnessState,
} from '../../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  type SourceAuthorityPolicy,
} from '../../../packages/domain/src/correlation.ts';
import {
  InventoryService,
  type InventoryRow,
  type InventoryDrillDown,
} from '../../../packages/application/src/inventory-service.ts';
import type { IdFactory } from '../../../packages/application/src/source-registry.ts';

import type {
  CurrentStateModel,
  InventoryRowVM,
  CoverageGapVM,
  SourceGapVM,
  DiscoveredSourceVM,
  DrillDownRecordVM,
  DrillDownVM,
} from '../../../apps/web/src/app/layout.tsx';

// ── Deterministic identity + time helpers ───────────────────────────────────────────────────

const FIXED_RANDOM = (): Uint8Array => new Uint8Array(16).fill(0x77);

/** A monotonic UUIDv7 factory (no wall clock) — the SAME kind the service unit tests use. */
export function idFactory(seed = 1): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}

/** A stable id derived from a small integer stamp (distinct integers → distinct ids). */
export function idOf(stamp: number): Uuid {
  return uuidV7(stamp as EpochMillis, FIXED_RANDOM);
}

export const T0 = 1_700_000_000_000 as EpochMillis;
const MIN = 60_000;
export const HORIZON_MILLIS = 15 * MIN;
/** Read/observe instant helpers, relative to T0. */
export const at = (millisFromT0: number): EpochMillis => (T0 + millisFromT0) as EpochMillis;

// Authority policy: platform_kanban outranks the other classes for `owner`, so a status
// difference resolves to a single authoritative value (a tie stays unresolved).
const POLICY: SourceAuthorityPolicy = makeSourceAuthorityPolicy({
  id: 'shell-current-state-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'owner',
      byClass: { platform_kanban: 10, agentctl: 5, workflows_orchestration: 5 },
      defaultAuthority: 1,
    }),
    makeFieldAuthorityRule({
      field: 'status',
      byClass: { platform_kanban: 10, agentctl: 6, workflows_orchestration: 4 },
      defaultAuthority: 1,
    }),
  ],
  confidenceFloor: 0.5,
});

// ── The authored scenario (the INPUT the RED controls mutate) ────────────────────────────────

/** Every knob a RED control needs to break exactly one AC invariant at the INPUT level. */
export interface ScenarioOverrides {
  /** AC1: emit a second observation for the SAME healthy asset id (must still yield ONE row). */
  readonly duplicateHealthyAsset?: boolean;
  /** AC2: drop the component coverage gap from the scenario (gap must otherwise stay visible). */
  readonly dropComponentGap?: boolean;
  /** AC3: collapse the drill-down to a single source (must otherwise be 3 distinct sources). */
  readonly singleSourceOnly?: boolean;
  /** AC4: force the stale asset's records FRESH (health must otherwise be withheld as unknown). */
  readonly forceStaleRecordFresh?: boolean;
  /** AC5: strip the discovery-evidence reference from the catalogued source. */
  readonly dropDiscoveryEvidence?: boolean;
  /** AC6: drop the review/expiry deadline from the governed-source gap (must otherwise carry it). */
  readonly dropGovernedGapReview?: boolean;
}

/** The stable ids the scenario pins, so tests can address specific assets/gaps/sources. */
export const SCENARIO_IDS = {
  tenant: PLATFORM_SCOPE as TenantId,
  healthyAsset: idOf(1001),
  staleAsset: idOf(1002),
  gappedAsset: idOf(1003),
  componentGap: idOf(2001),
  governedSourceGap: idOf(3001),
  discoveredCatalog: idOf(4001),
  discoveryEvidence: idOf(4090),
  owner: idOf(5001),
} as const;

/**
 * Build a REAL `InventoryService` populated from the authored scenario. The service is the Phase-70
 * aggregate; nothing here is a fixture the view reads directly — the tests read the service back.
 */
export function buildService(overrides: ScenarioOverrides = {}): InventoryService {
  const tenantId = SCENARIO_IDS.tenant;
  const svc = new InventoryService({
    tenantId,
    newId: idFactory(9000),
    policy: POLICY,
    stalenessHorizonMillis: HORIZON_MILLIS,
  });

  // ── AC1 — a healthy, connected, fully-covered asset with three distinct source records. ──
  const healthy: GovernedAsset = makeGovernedAsset({
    id: SCENARIO_IDS.healthyAsset,
    tenantId,
    assetType: 'model',
    name: 'fraud-scoring-model',
    ownerPrincipalId: SCENARIO_IDS.owner,
    lifecycleState: 'operating',
    riskTier: 'high',
    health: 'healthy',
    coverage: 'covered',
    lastObservedAt: at(0),
    version: 3,
    updatedAt: at(0),
  });
  svc.ingestAsset({ asset: healthy, fields: ['owner', 'status'] });

  // Three DISTINCT source records across the three registered sources (AC3). Fresh at `at(0)`.
  const kanbanCatalog = ingestCatalog(svc, tenantId, 'platform_kanban', 'connected');
  const agentctlCatalog = ingestCatalog(svc, tenantId, 'agentctl', 'connected');
  const wfCatalog = ingestCatalog(svc, tenantId, 'workflows_orchestration', 'connected');

  const kanbanRec = makeSourceRecord({
    id: svc.mintId(),
    tenantId,
    catalogId: kanbanCatalog.id,
    assetId: healthy.id,
    sourceClass: 'platform_kanban',
    externalKey: 'kb-card-77',
    observedState: { status: 'in-review', owner: 'Ada Governance' },
    status: 'active',
    freshness: 'fresh',
    confidence: 1,
    lastKnownAt: at(-1 * MIN),
    observedAt: at(-1 * MIN),
  });
  svc.ingestSourceRecord(kanbanRec);

  if (!overrides.singleSourceOnly) {
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: svc.mintId(),
        tenantId,
        catalogId: agentctlCatalog.id,
        assetId: healthy.id,
        sourceClass: 'agentctl',
        externalKey: 'agc-task-91',
        observedState: { status: 'running', owner: 'Ada Governance' },
        status: 'active',
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: at(-2 * MIN),
        observedAt: at(-2 * MIN),
      }),
    );
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: svc.mintId(),
        tenantId,
        catalogId: wfCatalog.id,
        assetId: healthy.id,
        sourceClass: 'workflows_orchestration',
        externalKey: 'wf-run-12',
        observedState: { status: 'blocked', owner: 'Ada Governance' },
        status: 'active',
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: at(-3 * MIN),
        observedAt: at(-3 * MIN),
      }),
    );
    // AC3 dependency + authoritative-field edges: agentctl depends on the Kanban card; the Kanban
    // source is authoritative for `owner`.
    svc.ingestRelationship(
      makeInventoryRelationship({
        id: svc.mintId(),
        tenantId,
        fromKind: 'source_record',
        fromId: agentctlCatalog.id,
        toKind: 'source_record',
        toId: kanbanCatalog.id,
        relationship: 'depends_on',
        fieldName: 'status',
        createdAt: at(0),
      }),
      healthy.id,
    );
    svc.ingestRelationship(
      makeInventoryRelationship({
        id: svc.mintId(),
        tenantId,
        fromKind: 'source_record',
        fromId: kanbanCatalog.id,
        toKind: 'governed_asset',
        toId: healthy.id,
        relationship: 'authoritative_for',
        fieldName: 'owner',
        authoritative: true,
        createdAt: at(0),
      }),
      healthy.id,
    );
  }

  // AC1 idempotency probe: a duplicate observation of the SAME asset id must NOT fork a row.
  if (overrides.duplicateHealthyAsset) {
    svc.ingestAsset({
      asset: makeGovernedAsset({ ...healthyInputOf(healthy), version: 4, updatedAt: at(1 * MIN) }),
      fields: ['owner', 'status'],
    });
  }

  // ── AC4 — a STALE source drives the row's reportedHealth to `unknown` (no inference). ──
  const staleFreshness: FreshnessState = overrides.forceStaleRecordFresh ? 'fresh' : 'stale';
  const staleAsset: GovernedAsset = makeGovernedAsset({
    id: SCENARIO_IDS.staleAsset,
    tenantId,
    assetType: 'dataset',
    name: 'feature-store-snapshot',
    ownerPrincipalId: SCENARIO_IDS.owner,
    lifecycleState: 'operating',
    riskTier: 'moderate',
    health: 'healthy', // OBSERVED healthy — but stale evidence must withhold this as current.
    coverage: 'covered',
    lastObservedAt: at(-3 * 24 * 60 * MIN),
    version: 1,
    updatedAt: at(-3 * 24 * 60 * MIN),
  });
  svc.ingestAsset({ asset: staleAsset, fields: ['status'] });
  const staleCatalog = ingestCatalog(svc, tenantId, 'wiggum_feature_store', 'degraded');
  svc.ingestSourceRecord(
    makeSourceRecord({
      id: svc.mintId(),
      tenantId,
      catalogId: staleCatalog.id,
      assetId: staleAsset.id,
      sourceClass: 'wiggum_feature_store',
      externalKey: 'fs-snap-3',
      observedState: { status: 'active' },
      status: overrides.forceStaleRecordFresh ? 'active' : 'inactive',
      freshness: staleFreshness,
      confidence: overrides.forceStaleRecordFresh ? 1 : 0.4,
      // Last known 3 days ago — far beyond the 15-minute horizon → stale/unavailable.
      lastKnownAt: overrides.forceStaleRecordFresh ? at(-1 * MIN) : at(-3 * 24 * 60 * MIN),
      observedAt: overrides.forceStaleRecordFresh ? at(-1 * MIN) : at(-3 * 24 * 60 * MIN),
    }),
  );

  // ── AC2 — a discovered COMPONENT that is not healthy stays a visible coverage gap. ──
  const gappedAsset: GovernedAsset = makeGovernedAsset({
    id: SCENARIO_IDS.gappedAsset,
    tenantId,
    assetType: 'service',
    name: 'shadow-inference-svc',
    lifecycleState: 'unknown',
    riskTier: 'high',
    health: 'unmanaged',
    coverage: 'gap',
    version: 1,
    updatedAt: at(-12 * 24 * 60 * MIN),
  });
  svc.ingestAsset({ asset: gappedAsset, fields: [] });
  if (!overrides.dropComponentGap) {
    svc.ingestCoverageGap(
      makeCoverageGap({
        id: SCENARIO_IDS.componentGap,
        tenantId,
        subjectKind: 'component',
        subjectId: gappedAsset.id,
        gapClass: 'component',
        reason: 'unmanaged',
        impact: 'high',
        requiredAction: 'Assign an owner and onboard the source, or file an exclusion review.',
        requiredOwner: SCENARIO_IDS.owner,
        status: 'open',
        firstSeenAt: at(-12 * 24 * 60 * MIN),
      }),
    );
  }

  // ── AC5 — an unregistered, governance-relevant DISCOVERED source is catalogued. ──
  svc.ingestCatalogEntry(
    makeSourceCatalogEntry({
      id: SCENARIO_IDS.discoveredCatalog,
      tenantId,
      sourceClass: UNKNOWN_SOURCE_CLASS,
      observedLocations: ['vpc-a/10.2.3.4:8443'],
      onboardingState: 'discovered',
      accessState: 'reachable',
      healthState: 'unknown',
      sensitivity: 'normal',
      discoveryEvidence: overrides.dropDiscoveryEvidence
        ? undefined
        : SCENARIO_IDS.discoveryEvidence,
      firstSeenAt: at(-1 * 24 * 60 * MIN),
      lastSeenAt: at(0),
    }),
  );

  // ── AC6 — a discovered source that is unsupported/sensitive stays a governed-source gap. ──
  svc.ingestCoverageGap(
    makeCoverageGap({
      id: SCENARIO_IDS.governedSourceGap,
      tenantId,
      subjectKind: 'source_catalog_entry',
      subjectId: SCENARIO_IDS.discoveredCatalog,
      gapClass: 'governed_source',
      reason: 'sensitive',
      impact: 'high',
      requiredAction: 'Complete DPIA and grant scoped read access.',
      requiredOwner: SCENARIO_IDS.owner,
      status: 'open',
      firstSeenAt: at(-2 * 24 * 60 * MIN),
      // AC6 review-or-expiry deadline — dropped by the RED control.
      reviewAt: overrides.dropGovernedGapReview ? undefined : at(30 * 24 * 60 * MIN),
    }),
  );

  return svc;
}

/** Reconstruct the healthy asset's factory input for the duplicate-observation probe. */
function healthyInputOf(a: GovernedAsset): Parameters<typeof makeGovernedAsset>[0] {
  return {
    id: a.id,
    tenantId: a.tenantId,
    assetType: a.assetType,
    name: a.name,
    ownerPrincipalId: a.ownerPrincipalId,
    lifecycleState: a.lifecycleState,
    riskTier: a.riskTier,
    health: a.health,
    coverage: a.coverage,
    lastObservedAt: a.lastObservedAt,
    version: a.version,
    updatedAt: a.updatedAt,
  };
}

/** Ingest a connected catalog entry for a source class; returns the created entry.
 *
 * DETERMINISM: the observed location suffix is derived from the entry's own minted id (stable across
 * builds under the seeded id factory), NOT a mutable module counter — so two `buildService()` calls
 * for the same scenario yield byte-identical catalog entries (and thus an identical `snapshotDigest`,
 * the effect-witness the shell renders). A shared counter would drift the location across builds. */
function ingestCatalog(
  svc: InventoryService,
  tenantId: TenantId,
  sourceClass: string,
  access: 'connected' | 'reachable' | 'degraded',
): SourceCatalogEntry {
  const id = svc.mintId();
  const entry = makeSourceCatalogEntry({
    id,
    tenantId,
    sourceClass,
    observedLocations: [`svc/${sourceClass}/${id.slice(0, 8)}`],
    onboardingState: access === 'degraded' ? 'onboarded' : 'onboarded',
    accessState: access,
    healthState: access === 'degraded' ? 'degraded' : 'healthy',
    sensitivity: 'normal',
    firstSeenAt: at(-5 * MIN),
    lastSeenAt: at(0),
  });
  svc.ingestCatalogEntry(entry);
  return entry;
}

// ── Map the REAL service outputs → the shell's render-ready view model ───────────────────────

function isoOf(ms: EpochMillis | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return new Date(ms).toISOString();
}

/** Human control-coverage label, derived from the row's coverage facet + visible-gap flag. */
function coverageLabel(row: InventoryRow): string {
  if (row.hasVisibleComponentGap) return 'gap (open component gap)';
  switch (row.coverage) {
    case 'covered':
      return 'covered';
    case 'partial':
      return 'partial';
    default:
      return 'gap';
  }
}

/** Evidence-state label, derived from the correlated evidence state. */
function evidenceLabel(row: InventoryRow): string {
  return row.evidenceState;
}

function rowToVM(row: InventoryRow, svc: InventoryService): InventoryRowVM {
  return {
    id: String(row.assetId),
    assetType: row.assetType,
    name: row.name,
    sourceIdentity: `svc/${row.assetType}/${row.name}`,
    owner: row.ownershipGap ? 'unowned (ownership gap)' : String(row.ownerPrincipalId ?? 'unowned'),
    lifecycleState: row.lifecycleState,
    riskTier: row.riskTier,
    controlCoverage: coverageLabel(row),
    evidenceState: evidenceLabel(row),
    // AC4: the health SAFE to report — the service withholds observed health when evidence is stale.
    reportedHealth: row.reportedHealth,
    observedHealth: row.observedHealth,
    confidence: row.confidence,
    lastObservedAt:
      isoOf(row.lastObservationAt) ?? isoOf(svc.rowFor(row.assetId, T0).lastObservationAt) ?? '—',
    unresolvedIssues: row.unresolvedIssueCount,
    sourceRecordCount: row.sourceRecordCount,
  };
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

function componentGapToVM(gap: CoverageGap, now: EpochMillis): CoverageGapVM {
  return {
    id: String(gap.id),
    component: componentNameFor(gap),
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    ageDays: Math.floor(gapAgeMillis(gap, now) / (24 * 60 * 60_000)),
    impact: gap.impact,
    requiredOwnerAction: gap.requiredAction,
  };
}

function sourceGapToVM(gap: CoverageGap): SourceGapVM {
  const review = isoOf(gap.reviewAt);
  const expiry = isoOf(gap.expiresAt);
  return {
    id: String(gap.id),
    source: `source/${String(gap.subjectId ?? gap.id)}`,
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    impact: gap.impact,
    ownerAction: gap.requiredAction,
    // AC6: the review-or-expiry deadline is present iff the gap carries one (the RED control drops it).
    reviewOrExpiry: review
      ? `review by ${review}`
      : expiry
        ? `expires ${expiry}`
        : 'no review or expiry recorded',
    hasReviewOrExpiry: gapHasReviewOrExpiry(gap),
  };
}

// The scenario names the gapped component in the asset name; map by subject id for a stable label.
function componentNameFor(gap: CoverageGap): string {
  if (String(gap.subjectId) === String(SCENARIO_IDS.gappedAsset)) return 'shadow-inference-svc';
  return `component/${String(gap.subjectId ?? gap.id)}`;
}

function drillDownToVM(dd: InventoryDrillDown): DrillDownVM {
  const records: DrillDownRecordVM[] = dd.sourceRecords.map((r: SourceRecord) => ({
    source: r.sourceClass,
    recordId: r.externalKey,
    status: String((r.observedState as Record<string, unknown>)['status'] ?? r.status),
    authoritativeFields: authoritativeFieldsFor(dd, r),
    dependsOn: dependsOnFor(dd, r),
    lastObservedAt: isoOf(r.lastKnownAt) ?? '—',
  }));
  return {
    assetId: String(dd.assetId),
    assetName: dd.asset?.name ?? String(dd.assetId),
    records,
    distinctSourceCount: new Set(dd.sourceRecords.map((r) => r.sourceClass)).size,
    dependencyCount: dd.dependencies.length,
    authoritativeFieldCount: dd.authoritativeFields.length,
  };
}

function authoritativeFieldsFor(dd: InventoryDrillDown, r: SourceRecord): string {
  const fields = dd.authoritativeFields
    .filter((a) => String(a.authoritativeSourceId) === String(r.catalogId))
    .map((a) => a.field);
  return fields.length ? fields.join(', ') : '—';
}

function dependsOnFor(dd: InventoryDrillDown, r: SourceRecord): string {
  const dep = dd.dependencies.find((d) => String(d.fromId) === String(r.catalogId));
  if (dep === undefined) return '—';
  const target = dd.sourceRecords.find((x) => String(x.catalogId) === String(dep.toId));
  return target ? target.externalKey : String(dep.toId);
}

function catalogToVM(svc: InventoryService): readonly DiscoveredSourceVM[] {
  return svc.catalogView().map((c) => ({
    id: String(c.catalogId),
    classification: c.classifiedUnknown ? 'unknown' : c.sourceClass,
    location: c.observedLocations.join(', '),
    accessStatus: c.accessState,
    sensitivity: c.sensitivity,
    ownershipStatus: c.ownershipGap ? 'unowned (ownership gap)' : String(c.ownerPrincipalId),
    onboardingState: c.onboardingState,
    // AC5: the discovery-evidence reference (undefined when the RED control strips it).
    discoveryEvidenceRef: c.discoveryEvidence ? String(c.discoveryEvidence) : undefined,
  }));
}

/**
 * DERIVE the shell's current-state model from the REAL service at instant `at`. Every field is a
 * projection of a value the service COMPUTED (reconciliation, correlation, freshness), never a
 * literal. This is the function the spec calls to obtain its independent expectations AND the props
 * it feeds the shell.
 */
export function deriveModel(svc: InventoryService, now: EpochMillis = T0): CurrentStateModel {
  const rows = svc.currentStateView(now);
  // AC1 "healthy connected sources" list: rows whose reported health is safe-to-report healthy.
  const healthyRows = rows.filter(
    (r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap,
  );
  // AC4 stale panel: any row whose evidence is not current (health withheld).
  const staleRow = rows.find(
    (r) => r.evidenceState !== 'current' && r.reportedHealth === 'unknown',
  );
  const staleVM = staleRow ? rowToVM(staleRow, svc) : undefined;

  const componentGaps = svc.componentGaps().map((g) => componentGapToVM(g, now));
  const sourceGaps = svc.governedSourceGaps().map((g) => sourceGapToVM(g));
  const discovered = catalogToVM(svc);
  const drill = drillDownToVM(svc.drillDown(SCENARIO_IDS.healthyAsset, now));

  return {
    generatedAtIso: new Date(now).toISOString(),
    inventory: healthyRows.map((r) => rowToVM(r, svc)),
    coverageGaps: componentGaps,
    drilldown: drill,
    stale: staleVM,
    discoveredSources: discovered,
    sourceGaps,
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Convenience: build the default (no-override) scenario and derive its model. */
export function defaultDerivedModel(now: EpochMillis = T0): CurrentStateModel {
  return deriveModel(buildService(), now);
}
