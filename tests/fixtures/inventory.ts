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
import { InventoryService, SourceRegistry, SourceReconciler } from '@trustcircle/application';

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

// --- Phase 84: the pinned SEVEN source-state taxonomy -----------------------
//
// The governance inventory fixture must seed a source in each of these seven states so every
// downstream test can observe it INDEPENDENTLY (through a durable read path — the registry
// projection, the latest source contract, or the reconciler's append-only delta log — never a
// mutation echo). `observedVia` names the exact read path that witnesses each state, so an
// assertion for a state can never be vacuous (it reads a concrete, seeded value, not a constant).
export type SourceState =
  'supported' | 'metadata-only' | 'unsupported' | 'unowned' | 'unreachable' | 'renamed' | 'unknown';

export interface SourceStateSpec {
  readonly state: SourceState;
  /** The seeded source's distinguishing facet an assertion pins. */
  readonly witness: string;
  /** The durable read path the state is observed through (never a mutation response). */
  readonly observedVia: string;
}

/** The seven seeded source states and the durable evidence each is observed through. */
export const SEVEN_SOURCE_STATES: readonly SourceStateSpec[] = [
  {
    state: 'supported',
    witness: "kanban source's latest contract carries supportLevel='supported'",
    observedVia: 'SourceRegistry.latestContract(kanbanSourceId).supportLevel',
  },
  {
    state: 'metadata-only',
    witness: 'discovered unknown source was catalogued from metadata only (no content ingested)',
    observedVia: 'SourceRegistry.catalog() entry: onboardingState=discovered, no observedState',
  },
  {
    state: 'unsupported',
    witness: "excluded vendor-x source's latest contract carries supportLevel='unsupported'",
    observedVia: 'SourceRegistry.latestContract(excludedSourceId).supportLevel',
  },
  {
    state: 'unowned',
    witness: 'discovered unknown + excluded sources have no ownerPrincipalId',
    observedVia: 'SourceRegistry.catalog() entry: ownerPrincipalId === undefined',
  },
  {
    state: 'unreachable',
    witness: "stale warehouse source's accessState='unreachable'",
    observedVia: 'SourceRegistry.catalog() entry: accessState',
  },
  {
    state: 'renamed',
    witness: 'a 1→1 re-key of one content fingerprint across two reconcile cycles',
    observedVia: "SourceReconciler.deltasOfClass('moved') (append-only lineage delta)",
  },
  {
    state: 'unknown',
    witness: "discovered source's class was never asserted → pinned to the 'unknown' sentinel",
    observedVia: 'SourceRegistry.catalog() entry: sourceClass === UNKNOWN_SOURCE_CLASS',
  },
];

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
  // SEVEN-STATE 'supported': register a validated, SUPPORTED source contract on the kanban source.
  // `supportLevel='supported'` is the durable facet an assertion reads via `latestContract(...)`.
  sources.registerContract({
    sourceId: kanbanSourceId,
    version: 1,
    supportLevel: 'supported',
    authoritativeFields: ['status', 'pipeline_state'],
    at: now,
  });
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
  // SEVEN-STATE 'unsupported': register a validated contract declaring this source UNSUPPORTED.
  // `supportLevel='unsupported'` is the durable facet an assertion reads via `latestContract(...)`
  // — the unsupported governed-source gap (AC6) is BACKED by this contract, not merely by class name.
  sources.registerContract({
    sourceId: excludedSourceId,
    version: 1,
    supportLevel: 'unsupported',
    at: now,
  });
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

// --- Phase 84: the 'renamed' source state (reconciler `moved` lineage delta) -
//
// A source is RENAMED when its stable content reappears under a NEW external key while its OLD key
// disappears — a 1→1 re-key. The `SourceReconciler` classifies this as a `moved` lineage delta and
// records it in an APPEND-ONLY log, so the rename is durably observable through an independent read
// (`deltasOfClass('moved')`) rather than any mutation echo. This models the seventh seeded state
// without touching the 5-entry `SourceRegistry` catalog the routes page over.

/** The fixed external keys the renamed source is observed under, before and after the re-key. */
export const RENAMED_OLD_KEY = 'kanban://board/eng#card-legacy';
export const RENAMED_NEW_KEY = 'kanban://board/eng#card-renamed';

export interface SeededRename {
  readonly reconciler: SourceReconciler;
  /** The single `moved` delta the re-key produced (append-only; independently re-readable). */
  readonly movedDelta: import('@trustcircle/application').ReconciliationDelta;
  readonly oldIdentity: string;
  readonly newIdentity: string;
}

/**
 * Seed a {@link SourceReconciler} with a two-cycle 1→1 re-key so the seventh source state —
 * RENAMED — is observable as a durable `moved` lineage delta. Deterministic: fixed ids + clock, no
 * I/O. The SAME governed content (a fixed fingerprint) is observed under {@link RENAMED_OLD_KEY} in
 * cycle 1 and under {@link RENAMED_NEW_KEY} (old key absent) in cycle 2 — the exact 1→1 shape the
 * reconciler classifies as `moved`.
 */
export function seedRenamedReconciliation(now: EpochMillis = NOW): SeededRename {
  const idf = createIdFactory();
  const reconciler = new SourceReconciler({
    tenantId: TENANT,
    // The reconciler's IdFactory is nullary; mint monotonic ids off the fixed clock.
    newId: () => idf.next(now),
    stalenessHorizonMillis: HORIZON,
    disappearanceCycles: 2,
  });

  const catalogId = toUuid('018f0000-0000-7000-8000-000000000401');
  const renamedAssetId = toUuid('018f0000-0000-7000-8000-000000000012');
  // The SAME governed content across both cycles → one stable content fingerprint that re-keys.
  const content = { pipeline_state: 'running', payload: 'stable-renamed-content' };

  const asset = {
    asset: makeGovernedAsset({
      id: renamedAssetId,
      tenantId: TENANT,
      assetType: 'service',
      name: 'renamed-card',
      ownerPrincipalId: OWNER,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: now,
      updatedAt: now,
    }),
    fields: ['status'] as const,
  };

  // Cycle 1: content observed under the OLD external key.
  reconciler.reconcile({
    observations: [
      makeSourceRecord({
        id: toUuid('018f0000-0000-7000-8000-000000000411'),
        tenantId: TENANT,
        catalogId,
        assetId: renamedAssetId,
        sourceClass: 'kanban',
        externalKey: RENAMED_OLD_KEY,
        observedState: content,
        status: 'active',
        freshness: 'fresh',
        lastKnownAt: now,
        observedAt: now,
      }),
    ],
    assets: [asset],
    at: now,
  });

  // Cycle 2: SAME content under a NEW external key; the OLD key is absent → a 1→1 re-key.
  reconciler.reconcile({
    observations: [
      makeSourceRecord({
        id: toUuid('018f0000-0000-7000-8000-000000000412'),
        tenantId: TENANT,
        catalogId,
        assetId: renamedAssetId,
        sourceClass: 'kanban',
        externalKey: RENAMED_NEW_KEY,
        observedState: content,
        status: 'active',
        freshness: 'fresh',
        lastKnownAt: now + MINUTE,
        observedAt: now + MINUTE,
      }),
    ],
    assets: [asset],
    at: now + MINUTE,
  });

  const moved = reconciler.deltasOfClass('moved');
  if (moved.length !== 1) {
    throw new Error(
      `seedRenamedReconciliation: expected exactly one 'moved' delta, got ${moved.length}`,
    );
  }
  const movedDelta = moved[0]!;
  const oldIdentity = `${TENANT}|${catalogId}|${RENAMED_OLD_KEY}`;
  const newIdentity = `${TENANT}|${catalogId}|${RENAMED_NEW_KEY}`;
  return { reconciler, movedDelta, oldIdentity, newIdentity };
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
