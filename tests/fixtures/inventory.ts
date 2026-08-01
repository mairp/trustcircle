// Test fixtures — a deterministic, multi-scenario inventory + source projection for the
// Phase-73 inventory/discovery API routes (apps/api/src/routes/inventory.ts).
//
// The builder seeds a single tenant's `InventoryService` (governed assets + component gaps,
// AC1/AC2/AC3/AC4) and `SourceRegistry` (discovered/registered sources + governed-source gaps,
// AC3/AC4/AC5/AC6) with fixed ids and clock so every derived page is reproducible and clock-free.
//
// Scenarios seeded (each maps to an acceptance criterion the route must render):
//   - a HEALTHY, fully-owned, fully-covered governed asset          (AC1 positive)
//   - an ORPHANED, unowned, uncovered asset bound to a component gap (AC2 — stays visible)
//   - two DISTINCT source records (kanban + agentctl) with differing
//     access/health status for correlation drill-down                (AC3)
//   - a STALE source whose last-known time is old → reportedHealth
//     withheld, evidence 'stale', page freshness downgraded          (AC4 — no inference)
//   - a freshly DISCOVERED unknown-class source (metadata-only)       (AC5)
//   - an UNSUPPORTED/INACCESSIBLE, unowned, EXCLUDED source carrying
//     governed-source gap(s) with a review/expiry                     (AC6 — visible governed gap)
//
// Nothing here reads the wall clock or performs I/O; ids come from a fixed monotonic factory.

import {
  createIdFactory,
  toUuid,
  makeReason,
  type Uuid,
  type EpochMillis,
  type TenantId,
  type Reason,
} from '@trustcircle/domain';
import { makeGovernedAsset, makeSourceRecord, makeCoverageGap } from '@trustcircle/domain';
import { InventoryService, SourceRegistry } from '@trustcircle/application';

// A type-only import of the route's consumed shapes, so the fixtures stay in lock-step with the
// interface the route actually reads.
import type {
  TenantProjection,
  DiscoveryPort,
  DiscoveryAcceptance,
  DiscoveryCommand,
} from '../../apps/api/src/routes/inventory.ts';

// --- Fixed identities + clock ------------------------------------------------

/** The fixed projection clock (ms). All ages/staleness are measured relative to this. */
export const NOW: EpochMillis = 1_772_000_000_000; // deterministic, > any first-seen below.
const MINUTE = 60_000;
const HORIZON = 15 * MINUTE; // matches the registry/service default staleness horizon.

export const TENANT = toUuid('018f0000-0000-7000-8000-000000000001') as TenantId;
export const OTHER_TENANT = toUuid('018f0000-0000-7000-8000-0000000000ff') as TenantId;
export const OWNER = toUuid('018f0000-0000-7000-8000-0000000000aa');
export const STEWARD = toUuid('018f0000-0000-7000-8000-0000000000ab');
export const DISCOVERY_EVIDENCE = toUuid('018f0000-0000-7000-8000-0000000000ac');

// Stable asset ids (UUIDv7) — chosen so localeCompare ordering is deterministic.
export const HEALTHY_ASSET_ID = toUuid('018f0000-0000-7000-8000-000000000010');
export const GAP_ASSET_ID = toUuid('018f0000-0000-7000-8000-000000000011');

// --- The seeded per-tenant projection ---------------------------------------

export interface SeededProjection extends TenantProjection {
  readonly inventory: InventoryService;
  readonly sources: SourceRegistry;
  readonly now: EpochMillis;
  /** The ids assigned to the discovered/registered sources, for assertions. */
  readonly ids: {
    readonly kanbanSourceId: Uuid;
    readonly agentctlSourceId: Uuid;
    readonly staleSourceId: Uuid;
    readonly discoveredUnknownSourceId: Uuid;
    readonly excludedSourceId: Uuid;
    readonly componentGapId: Uuid;
    readonly excludedGapId: Uuid;
  };
}

/**
 * Build the full multi-scenario projection for {@link TENANT}. Deterministic: same output every
 * call (ids are minted from a fresh monotonic factory seeded at fixed timestamps).
 */
export function seedTenantProjection(now: EpochMillis = NOW): SeededProjection {
  const idf = createIdFactory();
  const newId = () => idf.next(now);

  const inventory = new InventoryService({
    tenantId: TENANT,
    newId,
    stalenessHorizonMillis: HORIZON,
  });
  const sources = new SourceRegistry({ tenantId: TENANT, newId, stalenessHorizonMillis: HORIZON });

  // -- AC1: a healthy, fully-owned, fully-covered governed asset. ------------
  inventory.ingestAsset({
    asset: makeGovernedAsset({
      id: HEALTHY_ASSET_ID,
      tenantId: TENANT,
      assetType: 'service',
      name: 'orders-api',
      ownerPrincipalId: OWNER,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: now,
      version: 3,
      updatedAt: now,
    }),
    // No governed fields to reconcile → the asset's own facets stand, evidence is 'current'
    // (nothing unresolved). This is the clean AC1 positive: healthy is reported as healthy.
    fields: [],
  });
  // A fresh source record for the healthy asset so its evidence is 'current' at `now`.
  const kanbanRecordCatalog = toUuid('018f0000-0000-7000-8000-000000000101');
  inventory.ingestSourceRecord(
    makeSourceRecord({
      id: toUuid('018f0000-0000-7000-8000-000000000201'),
      tenantId: TENANT,
      catalogId: kanbanRecordCatalog,
      assetId: HEALTHY_ASSET_ID,
      sourceClass: 'kanban',
      externalKey: 'orders-api@kanban',
      status: 'active',
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: now,
      observedAt: now,
    }),
  );

  // -- AC2: an orphaned, unowned, uncovered asset bound to a VISIBLE component gap. --
  inventory.ingestAsset({
    asset: makeGovernedAsset({
      id: GAP_ASSET_ID,
      tenantId: TENANT,
      assetType: 'batch-job',
      name: 'legacy-batch-job',
      // no owner → ownership gap
      lifecycleState: 'orphaned',
      riskTier: 'high',
      health: 'unmanaged',
      coverage: 'gap',
      lastObservedAt: now - 6 * 60 * MINUTE,
      version: 1,
      updatedAt: now,
    }),
    fields: ['owner'],
  });
  const componentGapId = toUuid('018f0000-0000-7000-8000-0000000000f1');
  inventory.ingestCoverageGap(
    makeCoverageGap({
      id: componentGapId,
      tenantId: TENANT,
      subjectKind: 'component',
      subjectId: GAP_ASSET_ID,
      gapClass: 'component',
      reason: 'orphaned',
      impact: 'high',
      requiredAction: 'assign an owner and onboard the batch job under a control',
      status: 'open',
      firstSeenAt: now - 3 * 60 * MINUTE,
    }),
  );

  // -- AC3: two DISTINCT registered sources with differing status. -----------
  const kanbanSourceId = sources.discover({
    externalKey: 'board/eng',
    sourceClass: 'kanban',
    location: 'kanban://board/eng',
    accessState: 'connected',
    ownerPrincipalId: OWNER,
    discoveryEvidence: DISCOVERY_EVIDENCE,
    at: now,
  }).id;
  const agentctlSourceId = sources.discover({
    externalKey: 'cluster/prod',
    sourceClass: 'agentctl',
    location: 'agentctl://cluster/prod',
    accessState: 'degraded', // status DIFFERS from the kanban source (AC3 correlation)
    ownerPrincipalId: OWNER,
    discoveryEvidence: DISCOVERY_EVIDENCE,
    at: now,
  }).id;
  // Observe differing health so the current-state view carries a status difference.
  sources.recordObservation({
    sourceId: kanbanSourceId,
    accessState: 'connected',
    healthState: 'degraded',
    at: now,
  });
  sources.recordObservation({
    sourceId: agentctlSourceId,
    accessState: 'degraded',
    healthState: 'degraded',
    at: now,
  });

  // AC3 CORRELATION: attach TWO DISTINCT source records to the SAME (kanban) source that DISAGREE on
  // a governed field (`observedState.pipeline_state`). `statusDifferencesFor` must surface this
  // disagreement verbatim — a difference a human reconciles, never one the registry collapses.
  sources.attachRecord(
    makeSourceRecord({
      id: toUuid('018f0000-0000-7000-8000-000000000301'),
      tenantId: TENANT,
      catalogId: kanbanSourceId,
      sourceClass: 'kanban',
      externalKey: 'board/eng#card-1',
      status: 'active',
      observedState: { pipeline_state: 'running' },
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: now,
      observedAt: now,
    }),
  );
  sources.attachRecord(
    makeSourceRecord({
      id: toUuid('018f0000-0000-7000-8000-000000000302'),
      tenantId: TENANT,
      catalogId: kanbanSourceId,
      sourceClass: 'agentctl',
      externalKey: 'cluster/prod#card-1',
      status: 'inactive', // DIFFERS from the kanban record's 'active' (a status difference)
      observedState: { pipeline_state: 'paused' }, // DIFFERS from 'running'
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: now,
      observedAt: now,
    }),
  );
  // AC3 DEPENDENCY: the kanban source `depends_on` the agentctl source (a declared edge; NEVER an
  // inferred one). `dependenciesFor(kanbanSourceId)` must surface exactly this edge.
  sources.attachRelationship({
    sourceId: kanbanSourceId,
    toId: agentctlSourceId,
    relationship: 'depends_on',
    fieldName: 'deployment_target',
    at: now,
  });

  // -- AC4: a STALE source — last-known time is old, health must NOT be inferred. --
  const staleSourceId = sources.discover({
    externalKey: 'warehouse/etl',
    sourceClass: 'warehouse',
    location: 'warehouse://etl',
    accessState: 'unreachable',
    ownerPrincipalId: OWNER,
    discoveryEvidence: DISCOVERY_EVIDENCE,
    at: now - 10 * 60 * MINUTE, // first seen long ago
  }).id;
  // Last observation is well beyond twice the staleness horizon → 'unavailable'/'stale'.
  sources.recordObservation({
    sourceId: staleSourceId,
    accessState: 'unreachable',
    healthState: 'unknown',
    at: now - 5 * 60 * MINUTE,
  });

  // -- AC5: a freshly DISCOVERED, unknown-class, unowned source (metadata-only). --
  const discoveredUnknownSourceId = sources.discover({
    externalKey: 'acme-unmapped-bucket',
    // sourceClass omitted → pinned to UNKNOWN_SOURCE_CLASS ('unknown')
    location: 's3://acme-unmapped-bucket',
    accessState: 'reachable',
    // AC5 sensitivity: a NON-default 'restricted' classification, so the wire renders a distinctive
    // sensitivity an operator would triage first (and so the assertion is non-vacuous vs. 'normal').
    sensitivity: 'restricted',
    // no owner → ownership gap
    discoveryEvidence: DISCOVERY_EVIDENCE,
    at: now,
  }).id;

  // -- AC6: an UNSUPPORTED/INACCESSIBLE, unowned, EXCLUDED source → governed-source gap. --
  const excludedSourceId = sources.discover({
    externalKey: 'vendorx/acme',
    sourceClass: 'unsupported-vendor-x',
    location: 'vendorx://tenant/acme',
    accessState: 'inaccessible',
    // no owner
    discoveryEvidence: DISCOVERY_EVIDENCE,
    at: now,
  }).id;
  const { gap: excludedGap } = sources.exclude({
    sourceId: excludedSourceId,
    reason: makeReason('vendor_unsupported', 'vendor x is not a supported governance source'),
    impact: 'high',
    requiredAction: 'document the exclusion and schedule a governance review',
    reviewAt: now + 30 * 24 * 60 * MINUTE,
    at: now,
  });
  // Synthesise every AC6 governed-source gap the catalog currently exhibits (inaccessible, unowned…).
  sources.assessCoverage({ at: now });

  return {
    inventory,
    sources,
    now,
    ids: {
      kanbanSourceId,
      agentctlSourceId,
      staleSourceId,
      discoveredUnknownSourceId,
      excludedSourceId,
      componentGapId,
      excludedGapId: excludedGap.id,
    },
  };
}

// --- A projection provider keyed by tenant (the route dep) -------------------

/** Build a `ProjectionProvider` that serves the seeded projection for {@link TENANT} only.
 *  Any other tenant resolves to `undefined` (the route then returns an empty page) — this proves
 *  strict tenant scoping. */
export function providerFor(
  seeded: SeededProjection,
): (tenantId: TenantId) => TenantProjection | undefined {
  return (tenantId) => (tenantId === TENANT ? seeded : undefined);
}

// --- A deterministic, least-privilege discovery port ------------------------

/** A recording discovery port: it captures the metadata-only command it was given and returns
 *  fixed, audited handles. It NEVER reads content — it only echoes the request into evidence. The
 *  `commands` array lets a test assert exactly what the route forwarded (and that it forwarded no
 *  content/credentials). */
export interface RecordingDiscoveryPort {
  readonly port: DiscoveryPort;
  readonly commands: DiscoveryCommand[];
}

export function recordingDiscoveryPort(
  over: Partial<DiscoveryAcceptance> = {},
): RecordingDiscoveryPort {
  const commands: DiscoveryCommand[] = [];
  const acceptance: DiscoveryAcceptance = {
    operationId: toUuid('018f0000-0000-7000-8000-0000000000c0'),
    correlationId: toUuid('018f0000-0000-7000-8000-0000000000c1'),
    auditEventId: toUuid('018f0000-0000-7000-8000-0000000000c2'),
    idempotentReplay: false,
    ...over,
  };
  const port: DiscoveryPort = (command) => {
    commands.push(command);
    return acceptance;
  };
  return { port, commands };
}

/** A structured audit reason usable in discovery-run request bodies. */
export function discoveryReason(): Reason {
  return makeReason('boundary_scan', 'scheduled boundary discovery sweep');
}
