// Test fixtures — a deterministic, ordered GOVERNANCE-EVENT STREAM for the Phase-75 inventory
// projector (packages/projections/src/inventory-projector.ts).
//
// The builder emits a fully-formed, contract-valid `governance.*` event envelope per fact, in
// AGGREGATE ORDER, seeding one tenant's inventory / source-catalog / correlation / provenance /
// coverage-gap read models with the six acceptance-criterion scenarios:
//
//   - AC1  a HEALTHY, fully-owned, fully-covered governed asset, freshly observed.
//   - AC2  an ORPHANED, unowned, uncovered asset bound to a VISIBLE component gap.
//   - AC3  two DISTINCT source records (kanban + agentctl) for one asset that DISAGREE on a
//          governed field, plus a declared `depends_on` + `authoritative_for` edge.
//   - AC4  a STALE source record whose last-known time is far in the past — health must NOT be
//          inferred as current.
//   - AC5  a freshly DISCOVERED, unknown-class, unowned source catalogued with discovery evidence.
//   - AC6  an UNSUPPORTED / INACCESSIBLE / unowned / EXCLUDED discovered source carrying a
//          governed-source gap with a review deadline.
//
// Every envelope carries the required identity / correlation / actor / policy / evidence blocks so
// `validateEnvelope` (packages/contracts/src/events.ts) accepts it. Nothing reads the wall clock;
// ids are fixed, timestamps are derived from a fixed base.

import { createHash } from 'node:crypto';

// --- Fixed clock (ms) --------------------------------------------------------
export const NOW = 1_772_000_000_000; // deterministic base instant.
export const MINUTE = 60_000;
export const HORIZON = 15 * MINUTE; // matches the projector default staleness horizon.

// --- Fixed identities --------------------------------------------------------
export const TENANT = '018f0000-0000-7000-8000-000000000001';
export const OTHER_TENANT = '018f0000-0000-7000-8000-0000000000ff';
export const OWNER = '018f0000-0000-7000-8000-0000000000aa';
export const ACTOR = '018f0000-0000-7000-8000-0000000000a0';
export const POLICY_VERSION = '018f0000-0000-7000-8000-0000000000b0';
export const POLICY_DECISION = '018f0000-0000-7000-8000-0000000000b1';
export const DISCOVERY_EVIDENCE = '018f0000-0000-7000-8000-0000000000ac';

export const HEALTHY_ASSET_ID = '018f0000-0000-7000-8000-000000000010';
export const GAP_ASSET_ID = '018f0000-0000-7000-8000-000000000011';
export const CORR_ASSET_ID = '018f0000-0000-7000-8000-000000000012';
export const STALE_ASSET_ID = '018f0000-0000-7000-8000-000000000013';

export const KANBAN_CATALOG = '018f0000-0000-7000-8000-000000000101';
export const AGENTCTL_CATALOG = '018f0000-0000-7000-8000-000000000102';
export const STALE_CATALOG = '018f0000-0000-7000-8000-000000000103';
export const DISCOVERED_CATALOG = '018f0000-0000-7000-8000-000000000104';
export const EXCLUDED_CATALOG = '018f0000-0000-7000-8000-000000000105';

export const HEALTHY_RECORD = '018f0000-0000-7000-8000-000000000201';
export const KANBAN_RECORD = '018f0000-0000-7000-8000-000000000202';
export const AGENTCTL_RECORD = '018f0000-0000-7000-8000-000000000203';
export const STALE_RECORD = '018f0000-0000-7000-8000-000000000204';

export const COMPONENT_GAP = '018f0000-0000-7000-8000-0000000000f1';
export const GOVERNED_GAP = '018f0000-0000-7000-8000-0000000000f2';

export const DEP_REL = '018f0000-0000-7000-8000-000000000301';
export const AUTH_REL = '018f0000-0000-7000-8000-000000000302';

const BUNDLE_DIGEST = createHash('sha256').update('phase75-bundle', 'utf8').digest('hex');
const EVIDENCE_SHA = createHash('sha256').update('phase75-evidence', 'utf8').digest('hex');

function iso(ms) {
  return new Date(ms).toISOString();
}

/** A stable event id derived from a label so the same fixture always mints the same ids. */
export function eventId(label) {
  const h = createHash('sha256').update(`phase75-event|${label}`, 'utf8').digest('hex');
  const s = h.slice(0, 32);
  return (
    `${s.slice(0, 8)}-${s.slice(8, 12)}-7${s.slice(13, 16)}-` +
    `8${s.slice(17, 20)}-${s.slice(20, 32)}`
  );
}

/**
 * Build a contract-valid governance event envelope. `aggregateType` + `aggregateId` +
 * `aggregateVersion` place it in a per-aggregate stream; `data` is the fold payload.
 */
export function envelope(opts) {
  const occurredMs = opts.occurredAt ?? NOW;
  const env = {
    schema_version: '1.0.0',
    event_id:
      opts.eventId ?? eventId(`${opts.eventType}|${opts.aggregateId}|${opts.aggregateVersion}`),
    event_type: opts.eventType,
    tenant_id: opts.tenantId ?? TENANT,
    aggregate_type: opts.aggregateType,
    aggregate_id: opts.aggregateId,
    aggregate_version: opts.aggregateVersion,
    occurred_at: iso(occurredMs),
    recorded_at: iso(opts.recordedAt ?? occurredMs),
    correlation_id: opts.correlationId ?? eventId(`corr|${opts.aggregateId}`),
    actor: { principal_id: ACTOR, principal_type: 'automation' },
    policy: {
      policy_version_id: POLICY_VERSION,
      policy_decision_id: POLICY_DECISION,
      bundle_digest: BUNDLE_DIGEST,
    },
    evidence: opts.evidence ?? [{ evidence_id: DISCOVERY_EVIDENCE, sha256: EVIDENCE_SHA }],
    data: opts.data ?? {},
  };
  if (opts.source) env.source = opts.source;
  return env;
}

// --- The ordered event stream ------------------------------------------------

/**
 * The canonical ordered event stream (in arrival order) that seeds all six AC scenarios. Each
 * aggregate advances its own version from 1. Returned as plain envelopes; the projector folds them
 * via `ingestBatch`.
 */
export function inventoryEventStream(now = NOW) {
  const events = [];

  // ---- AC1: a healthy, fully-owned, fully-covered asset + a fresh record. ----
  events.push(
    envelope({
      eventType: 'governance.inventory.asset.observed',
      aggregateType: 'governed_asset',
      aggregateId: HEALTHY_ASSET_ID,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: HEALTHY_ASSET_ID,
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
        fields: [],
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.source_record.observed',
      aggregateType: 'source_record',
      aggregateId: HEALTHY_RECORD,
      aggregateVersion: 1,
      occurredAt: now,
      source: {
        source_instance_id: KANBAN_CATALOG,
        external_id: 'orders-api@kanban',
        source_revision: 'r1',
        observed_at: iso(now),
      },
      data: {
        id: HEALTHY_RECORD,
        catalogId: KANBAN_CATALOG,
        assetId: HEALTHY_ASSET_ID,
        sourceClass: 'kanban',
        externalKey: 'orders-api@kanban',
        status: 'active',
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: now,
        observedAt: now,
      },
    }),
  );

  // ---- AC2: an orphaned, unowned, uncovered asset + a VISIBLE component gap. ----
  events.push(
    envelope({
      eventType: 'governance.inventory.asset.observed',
      aggregateType: 'governed_asset',
      aggregateId: GAP_ASSET_ID,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: GAP_ASSET_ID,
        assetType: 'batch-job',
        name: 'legacy-batch-job',
        lifecycleState: 'orphaned',
        riskTier: 'high',
        health: 'unmanaged',
        coverage: 'gap',
        lastObservedAt: now - 6 * 60 * MINUTE,
        version: 1,
        updatedAt: now,
        fields: ['owner'],
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.coverage_gap.raised',
      aggregateType: 'coverage_gap',
      aggregateId: COMPONENT_GAP,
      aggregateVersion: 1,
      occurredAt: now - 3 * 60 * MINUTE,
      data: {
        id: COMPONENT_GAP,
        subjectKind: 'component',
        subjectId: GAP_ASSET_ID,
        gapClass: 'component',
        reason: 'orphaned',
        impact: 'high',
        requiredAction: 'assign an owner and onboard the batch job under a control',
        status: 'open',
        firstSeenAt: now - 3 * 60 * MINUTE,
      },
    }),
  );

  // ---- AC3: an asset with two DISTINCT disagreeing records + dependency/authority edges. ----
  events.push(
    envelope({
      eventType: 'governance.inventory.asset.observed',
      aggregateType: 'governed_asset',
      aggregateId: CORR_ASSET_ID,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: CORR_ASSET_ID,
        assetType: 'pipeline',
        name: 'delivery-pipeline',
        ownerPrincipalId: OWNER,
        lifecycleState: 'operating',
        riskTier: 'high',
        health: 'degraded',
        coverage: 'partial',
        lastObservedAt: now,
        version: 2,
        updatedAt: now,
        fields: ['pipeline_state'],
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.source_record.observed',
      aggregateType: 'source_record',
      aggregateId: KANBAN_RECORD,
      aggregateVersion: 1,
      occurredAt: now,
      source: {
        source_instance_id: KANBAN_CATALOG,
        external_id: 'board/eng#card-1',
        source_revision: 'r7',
        observed_at: iso(now),
      },
      data: {
        id: KANBAN_RECORD,
        catalogId: KANBAN_CATALOG,
        assetId: CORR_ASSET_ID,
        sourceClass: 'kanban',
        externalKey: 'board/eng#card-1',
        status: 'active',
        observedState: { pipeline_state: 'running' },
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: now,
        observedAt: now,
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.source_record.observed',
      aggregateType: 'source_record',
      aggregateId: AGENTCTL_RECORD,
      aggregateVersion: 1,
      occurredAt: now,
      source: {
        source_instance_id: AGENTCTL_CATALOG,
        external_id: 'cluster/prod#card-1',
        source_revision: 'r3',
        observed_at: iso(now),
      },
      data: {
        id: AGENTCTL_RECORD,
        catalogId: AGENTCTL_CATALOG,
        assetId: CORR_ASSET_ID,
        sourceClass: 'agentctl',
        externalKey: 'cluster/prod#card-1',
        status: 'inactive', // DIFFERS from the kanban record's 'active'
        observedState: { pipeline_state: 'paused' }, // DIFFERS from 'running'
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: now,
        observedAt: now,
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.relationship.asserted',
      aggregateType: 'inventory_relationship',
      aggregateId: DEP_REL,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: DEP_REL,
        assetId: CORR_ASSET_ID,
        fromKind: 'source_catalog_entry',
        fromId: KANBAN_CATALOG,
        toKind: 'source_catalog_entry',
        toId: AGENTCTL_CATALOG,
        relationship: 'depends_on',
        fieldName: 'deployment_target',
        createdAt: now,
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.relationship.asserted',
      aggregateType: 'inventory_relationship',
      aggregateId: AUTH_REL,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: AUTH_REL,
        assetId: CORR_ASSET_ID,
        fromKind: 'source_catalog_entry',
        fromId: KANBAN_CATALOG,
        toKind: 'governed_asset',
        toId: CORR_ASSET_ID,
        relationship: 'authoritative_for',
        fieldName: 'pipeline_state',
        createdAt: now,
      },
    }),
  );

  // ---- AC4: a stale-source asset — last-known time far in the past. ----
  const staleObservedAt = now - 5 * 60 * MINUTE; // >> 2× horizon → unavailable
  events.push(
    envelope({
      eventType: 'governance.inventory.asset.observed',
      aggregateType: 'governed_asset',
      aggregateId: STALE_ASSET_ID,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: STALE_ASSET_ID,
        assetType: 'warehouse',
        name: 'etl-warehouse',
        ownerPrincipalId: OWNER,
        lifecycleState: 'operating',
        riskTier: 'moderate',
        // The asset's OWN recorded health is 'healthy' — but the contributing record is STALE, so
        // the projector must WITHHOLD reporting it as current (AC4).
        health: 'healthy',
        coverage: 'covered',
        lastObservedAt: staleObservedAt,
        version: 1,
        updatedAt: now,
        fields: [],
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.source_record.observed',
      aggregateType: 'source_record',
      aggregateId: STALE_RECORD,
      aggregateVersion: 1,
      occurredAt: staleObservedAt,
      source: {
        source_instance_id: STALE_CATALOG,
        external_id: 'warehouse/etl',
        source_revision: 'r0',
        observed_at: iso(staleObservedAt),
      },
      data: {
        id: STALE_RECORD,
        catalogId: STALE_CATALOG,
        assetId: STALE_ASSET_ID,
        sourceClass: 'warehouse',
        externalKey: 'warehouse/etl',
        status: 'unknown',
        freshness: 'stale',
        confidence: 0.4,
        lastKnownAt: staleObservedAt,
        observedAt: staleObservedAt,
      },
    }),
  );

  // ---- AC5: a freshly discovered, unknown-class, unowned source (metadata-only). ----
  events.push(
    envelope({
      eventType: 'governance.inventory.source.discovered',
      aggregateType: 'source_catalog_entry',
      aggregateId: DISCOVERED_CATALOG,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: DISCOVERED_CATALOG,
        // sourceClass omitted → pinned to UNKNOWN_SOURCE_CLASS ('unknown')
        observedLocations: ['s3://acme-unmapped-bucket'],
        accessState: 'reachable',
        sensitivity: 'restricted',
        onboardingState: 'discovered',
        discoveryEvidence: DISCOVERY_EVIDENCE,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    }),
  );

  // ---- AC6: an unsupported/inaccessible/unowned/excluded source + a governed-source gap. ----
  events.push(
    envelope({
      eventType: 'governance.inventory.source.discovered',
      aggregateType: 'source_catalog_entry',
      aggregateId: EXCLUDED_CATALOG,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: EXCLUDED_CATALOG,
        sourceClass: 'unsupported-vendor-x',
        observedLocations: ['vendorx://tenant/acme'],
        accessState: 'inaccessible',
        onboardingState: 'excluded',
        sensitivity: 'sensitive',
        discoveryEvidence: DISCOVERY_EVIDENCE,
        coverageGapIds: [GOVERNED_GAP],
        firstSeenAt: now,
        lastSeenAt: now,
      },
    }),
  );
  events.push(
    envelope({
      eventType: 'governance.inventory.coverage_gap.raised',
      aggregateType: 'coverage_gap',
      aggregateId: GOVERNED_GAP,
      aggregateVersion: 1,
      occurredAt: now,
      data: {
        id: GOVERNED_GAP,
        subjectKind: 'source_catalog_entry',
        subjectId: EXCLUDED_CATALOG,
        gapClass: 'governed_source',
        reason: 'excluded',
        impact: 'high',
        requiredAction: 'document the exclusion and schedule a governance review',
        status: 'open',
        firstSeenAt: now,
        reviewAt: now + 30 * 24 * 60 * MINUTE,
      },
    }),
  );

  return events;
}
