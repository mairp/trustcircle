// Test fixtures — a deterministic, real INVENTORY READ MODEL (`@trustcircle/application`'s
// `InventoryService`) seeded with all six Phase-83 acceptance-criterion scenarios, for the SSE
// events route (apps/api/src/routes/events.ts; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// The route projects this current-state view onto the wire AFTER the change slice, so every
// acceptance criterion is observable directly off the SSE body (in `item` / `correlation` / `gap`
// / `catalog` records) rather than inferred from an opaque envelope. This fixture builds the SAME
// aggregate the composition root would hand the route in production, via the domain value-object
// factories (never the wall clock, never I/O). It is scoped to a caller-supplied tenant so the
// service's per-ingest tenant assertion holds against the feed's tenant.
//
// Scenarios seeded (each maps 1:1 to an acceptance criterion the SSE snapshot must render):
//   AC1  a HEALTHY, fully-owned, fully-covered asset renders ONCE with its full facet set.
//   AC2  an ORPHANED, unowned, uncovered asset bound to a VISIBLE component gap
//        (reason / age / impact / required owner action).
//   AC3  an asset with two DISTINCT disagreeing source records (kanban vs agentctl) across
//        registered sources + a depends_on and an authoritative_for edge → drill-down shows the
//        distinct records, the status difference, the dependency, and the authoritative field.
//   AC4  a STALE-source asset: last-known time far in the past ⇒ confidence < 1 and current health
//        WITHHELD (reportedHealth = 'unknown'); observed health still shown verbatim.
//   AC5  a freshly DISCOVERED, unknown-class, unowned source ADDED to the catalog with discovery
//        evidence / classification / location / access / sensitivity / ownership / onboarding.
//   AC6  an UNSUPPORTED / INACCESSIBLE / EXCLUDED discovered source + a governed-source gap that
//        carries a review deadline (reason / impact / owner action / review-or-expiry).

import { uuidV7, type Uuid, type EpochMillis, type TenantId } from '@trustcircle/domain';
import {
  makeGovernedAsset,
  makeSourceRecord,
  makeCoverageGap,
  makeSourceCatalogEntry,
  makeInventoryRelationship,
  UNKNOWN_SOURCE_CLASS,
} from '@trustcircle/domain';
import { makeSourceAuthorityPolicy, makeFieldAuthorityRule } from '@trustcircle/domain';
import { InventoryService, type IdFactory } from '@trustcircle/application';

import { NOW } from './inventory-events.ts';

// --- Deterministic identity + clock (no wall-clock read) ---------------------

const FIXED_RANDOM = (): Uint8Array => new Uint8Array(16).fill(0x5c);

/** A monotonic UUIDv7 factory seeded from a fixed base — reproducible, time-ordered ids. */
function idFactory(seed = 100): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}

/** A stable id derived from a small integer stamp (distinct integers ⇒ distinct ids). */
export function pid(stamp: number): Uuid {
  return uuidV7(stamp as EpochMillis, FIXED_RANDOM);
}

const MINUTE = 60_000;
export const PROJECTION_HORIZON = 15 * MINUTE;

// --- Fixed inventory identities (distinct from the change-feed ids) ----------

export const P_HEALTHY_ASSET = pid(810_010);
export const P_GAP_ASSET = pid(810_011);
export const P_CORR_ASSET = pid(810_012);
export const P_STALE_ASSET = pid(810_013);

export const P_OWNER = pid(810_900);

export const P_COMPONENT_GAP = pid(810_701);
export const P_GOVERNED_GAP = pid(810_702);

export const P_DISCOVERED_CATALOG = pid(810_104);
export const P_EXCLUDED_CATALOG = pid(810_105);
export const P_DISCOVERY_EVIDENCE = pid(810_806);

export const P_KANBAN_RECORD = pid(810_202);
export const P_AGENTCTL_RECORD = pid(810_203);
export const P_DEP_REL = pid(810_301);
export const P_AUTH_REL = pid(810_302);

/** The governed field the AC3 sources disagree on (drives status-difference detection). */
export const CORR_FIELD = 'pipeline_state';

// A policy where platform_kanban outranks agentctl on the correlated field so the status difference
// resolves to a single authoritative value (and the conflict is still surfaced as `contested`).
const POLICY = makeSourceAuthorityPolicy({
  id: 'events-projection-policy',
  rules: [
    makeFieldAuthorityRule({
      field: CORR_FIELD,
      byClass: { platform_kanban: 10, agentctl: 5 },
      defaultAuthority: 1,
    }),
  ],
  confidenceFloor: 0.5,
});

/**
 * Build a real `InventoryService` for `tenantId`, folded with all six AC scenarios at `now`.
 * The returned service is the exact read surface the SSE route projects onto the wire.
 */
export function buildProjection(
  tenantId: TenantId,
  now: EpochMillis = NOW as EpochMillis,
): InventoryService {
  const svc = new InventoryService({
    tenantId,
    newId: idFactory(),
    policy: POLICY,
    stalenessHorizonMillis: PROJECTION_HORIZON,
  });

  // ---- AC1: a healthy, fully-owned, fully-covered asset + a fresh record. ----
  svc.ingestAsset({
    asset: makeGovernedAsset({
      id: P_HEALTHY_ASSET,
      tenantId,
      assetType: 'service',
      name: 'orders-api',
      ownerPrincipalId: P_OWNER,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: now,
      updatedAt: now,
    }),
    fields: [],
  });
  svc.ingestSourceRecord(
    makeSourceRecord({
      id: pid(810_201),
      tenantId,
      catalogId: pid(810_101),
      assetId: P_HEALTHY_ASSET,
      sourceClass: 'platform_kanban',
      externalKey: 'orders-api@kanban',
      status: 'active',
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: now,
      observedAt: now,
    }),
  );

  // ---- AC2: an orphaned, unowned, uncovered asset + a VISIBLE component gap. ----
  svc.ingestAsset({
    asset: makeGovernedAsset({
      id: P_GAP_ASSET,
      tenantId,
      assetType: 'batch-job',
      name: 'legacy-batch-job',
      lifecycleState: 'orphaned',
      riskTier: 'high',
      health: 'unmanaged',
      coverage: 'gap',
      lastObservedAt: (now - 6 * 60 * MINUTE) as EpochMillis,
      updatedAt: now,
    }),
    fields: [],
  });
  svc.ingestCoverageGap(
    makeCoverageGap({
      id: P_COMPONENT_GAP,
      tenantId,
      subjectKind: 'governed_asset',
      subjectId: P_GAP_ASSET,
      gapClass: 'component',
      reason: 'orphaned',
      impact: 'high',
      requiredAction: 'assign an owner and onboard the batch job under a control',
      requiredOwner: P_OWNER,
      firstSeenAt: (now - 3 * 60 * MINUTE) as EpochMillis,
    }),
  );

  // ---- AC3: an asset with two DISTINCT disagreeing records + dependency/authority edges. ----
  svc.ingestAsset({
    asset: makeGovernedAsset({
      id: P_CORR_ASSET,
      tenantId,
      assetType: 'pipeline',
      name: 'delivery-pipeline',
      ownerPrincipalId: P_OWNER,
      lifecycleState: 'operating',
      riskTier: 'high',
      health: 'degraded',
      coverage: 'partial',
      lastObservedAt: now,
      updatedAt: now,
    }),
    fields: [CORR_FIELD],
  });
  svc.ingestSourceRecord(
    makeSourceRecord({
      id: P_KANBAN_RECORD,
      tenantId,
      catalogId: pid(810_101),
      assetId: P_CORR_ASSET,
      sourceClass: 'platform_kanban',
      externalKey: 'board/eng#card-1',
      observedState: { [CORR_FIELD]: 'running' },
      status: 'active',
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: now,
      observedAt: now,
    }),
  );
  svc.ingestSourceRecord(
    makeSourceRecord({
      id: P_AGENTCTL_RECORD,
      tenantId,
      catalogId: pid(810_102),
      assetId: P_CORR_ASSET,
      sourceClass: 'agentctl',
      externalKey: 'cluster/prod#card-1',
      observedState: { [CORR_FIELD]: 'paused' }, // DIFFERS from 'running' → status difference
      status: 'inactive',
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: now,
      observedAt: now,
    }),
  );
  svc.ingestRelationship(
    makeInventoryRelationship({
      id: P_DEP_REL,
      tenantId,
      fromKind: 'source_record',
      fromId: P_KANBAN_RECORD,
      toKind: 'source_record',
      toId: P_AGENTCTL_RECORD,
      relationship: 'depends_on',
      fieldName: 'deployment_target',
      createdAt: now,
    }),
    P_CORR_ASSET,
  );
  svc.ingestRelationship(
    makeInventoryRelationship({
      id: P_AUTH_REL,
      tenantId,
      fromKind: 'source_record',
      fromId: P_KANBAN_RECORD,
      toKind: 'governed_asset',
      toId: P_CORR_ASSET,
      relationship: 'authoritative_for',
      fieldName: CORR_FIELD,
      createdAt: now,
    }),
    P_CORR_ASSET,
  );

  // ---- AC4: a stale-source asset — last-known time far in the past. ----
  const staleObservedAt = (now - 5 * 60 * MINUTE) as EpochMillis; // >> 2× horizon → unavailable
  svc.ingestAsset({
    asset: makeGovernedAsset({
      id: P_STALE_ASSET,
      tenantId,
      assetType: 'warehouse',
      name: 'etl-warehouse',
      ownerPrincipalId: P_OWNER,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      // The asset's OWN recorded health is 'healthy' — but its only evidence is STALE, so current
      // health must be WITHHELD (reportedHealth = 'unknown') while observedHealth stays verbatim,
      // and evidenceState downgrades to non-current (AC4).
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: staleObservedAt,
      updatedAt: now,
    }),
    // Correlate a field whose ONLY observation is the stale record, so the resolved winner is stale
    // and the derived evidence-state is non-current (not merely a lowered confidence).
    fields: ['load_state'],
  });
  svc.ingestSourceRecord(
    makeSourceRecord({
      id: pid(810_204),
      tenantId,
      catalogId: pid(810_103),
      assetId: P_STALE_ASSET,
      sourceClass: 'warehouse',
      externalKey: 'warehouse/etl',
      observedState: { load_state: 'ok' },
      status: 'unknown',
      freshness: 'stale', // the winning (only) observation is stale ⇒ evidenceState 'stale'
      confidence: 0.4,
      lastKnownAt: staleObservedAt,
      observedAt: staleObservedAt,
    }),
  );

  // ---- AC5: a freshly discovered, unknown-class, unowned source (metadata only). ----
  svc.ingestCatalogEntry(
    makeSourceCatalogEntry({
      id: P_DISCOVERED_CATALOG,
      tenantId,
      sourceClass: UNKNOWN_SOURCE_CLASS, // type-or-unknown classification
      observedLocations: ['s3://acme-unmapped-bucket'], // location
      accessState: 'reachable', // access status
      sensitivity: 'restricted', // sensitivity
      onboardingState: 'discovered', // onboarding state
      discoveryEvidence: P_DISCOVERY_EVIDENCE, // discovery evidence
      firstSeenAt: now,
      lastSeenAt: now,
    }),
  );

  // ---- AC6: an unsupported/inaccessible/excluded source + a governed-source gap w/ review. ----
  svc.ingestCatalogEntry(
    makeSourceCatalogEntry({
      id: P_EXCLUDED_CATALOG,
      tenantId,
      sourceClass: 'unsupported-vendor-x',
      observedLocations: ['vendorx://tenant/acme'],
      accessState: 'inaccessible',
      onboardingState: 'excluded',
      sensitivity: 'sensitive',
      discoveryEvidence: P_DISCOVERY_EVIDENCE,
      coverageGapIds: [P_GOVERNED_GAP],
      firstSeenAt: now,
      lastSeenAt: now,
    }),
  );
  svc.ingestCoverageGap(
    makeCoverageGap({
      id: P_GOVERNED_GAP,
      tenantId,
      subjectKind: 'source_catalog_entry',
      subjectId: P_EXCLUDED_CATALOG,
      gapClass: 'governed_source',
      reason: 'excluded',
      impact: 'high',
      requiredAction: 'document the exclusion and schedule a governance review',
      requiredOwner: P_OWNER,
      firstSeenAt: now,
      reviewAt: (now + 30 * 24 * 60 * MINUTE) as EpochMillis, // review-or-expiry deadline
    }),
  );

  return svc;
}
