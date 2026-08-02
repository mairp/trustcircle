// Test fixtures — a deterministic AUTHORIZED PROJECTION-CHANGE FEED for the Phase-83 SSE
// events route (apps/api/src/routes/events.ts; work item / bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// The builder assembles a `TenantChangeFeed` — the read surface the route consumes — from a
// sequence of contract-valid governance event envelopes (reusing the `envelope()` builder in
// tests/fixtures/inventory-events.ts, so every envelope passes `validateEnvelope`). Each change
// carries a stream-global `sequence` (1-based, strictly increasing) that the route's resume
// cursor encodes.
//
// Scenarios seeded (each maps to a behaviour the SSE route must render):
//   - a CONTIGUOUS aggregate stream (v1..v3) for one governed asset            (apply/resume)
//   - a DUPLICATE re-delivery of an already-applied version                     (safe-under-dup)
//   - an OUT-OF-ORDER change whose predecessor is missing                       (visible gap)
//   - a MALFORMED envelope in the middle of the window                          (visible skip)
//   - a retained WINDOW FLOOR > 1 (older changes evicted)                        (expired-cursor)
//   - a projection FRESHNESS / PARTIAL snapshot knob                             (stale/partial)
//
// Nothing here reads the wall clock or performs I/O; ids/timestamps come from the shared fixture.

import {
  envelope,
  NOW,
  TENANT,
  OTHER_TENANT,
  HEALTHY_ASSET_ID,
  GAP_ASSET_ID,
} from './inventory-events.ts';

import { toUuid, type EpochMillis, type TenantId } from '@trustcircle/domain';

import type {
  ChangeRecord,
  TenantChangeFeed,
  ChangeFeedProvider,
  ProjectionFreshness,
} from '../../apps/api/src/routes/events.ts';

import { buildProjection } from './inventory-projection.ts';

export { NOW, TENANT, OTHER_TENANT, HEALTHY_ASSET_ID, GAP_ASSET_ID };

/** The tenant scope, typed for the route's `TenantId`. */
export const TENANT_ID = toUuid(TENANT) as TenantId;
export const OTHER_TENANT_ID = toUuid(OTHER_TENANT) as TenantId;

/** A distinct second aggregate for the gap scenario (so it never collides with the healthy one). */
const SECOND_AGGREGATE = GAP_ASSET_ID;

/** Build one authorized change record at `sequence` carrying a healthy-asset observation at
 *  aggregate `version`. */
function assetChange(sequence: number, aggregateId: string, version: number): ChangeRecord {
  return {
    sequence,
    envelope: envelope({
      eventType: 'governance.inventory.asset.observed',
      aggregateType: 'governed_asset',
      aggregateId,
      aggregateVersion: version,
      occurredAt: NOW + sequence * 1000,
      data: { id: aggregateId, version },
    }),
  };
}

export interface FeedOverrides {
  /** Override the projection freshness snapshot (default `current`). */
  readonly freshness?: ProjectionFreshness;
  /** Override partial-coverage (default false). */
  readonly partialCoverage?: boolean;
  /** Override the retained window floor (default 1 — nothing evicted). */
  readonly windowFloorSequence?: number;
  /** Inject an out-of-order change (a v3 for the second aggregate with NO v2) at this sequence. */
  readonly includeOutOfOrder?: boolean;
  /** Inject a duplicate re-delivery of the healthy v1 at the tail. */
  readonly includeDuplicate?: boolean;
  /** Inject a malformed envelope at this sequence. */
  readonly includeMalformed?: boolean;
  /** Replace the records entirely (empty stream, custom ordering). */
  readonly records?: readonly ChangeRecord[];
  /**
   * Attach the tenant's real INVENTORY read model (an `InventoryService` seeded with all six AC
   * scenarios) so the route projects the current-state governance view onto the wire after the
   * change slice. When true, the SSE body carries `item` / `correlation` / `gap` / `catalog`
   * records observing AC1..AC6 directly. Default false (a pure change-transport subscription).
   */
  readonly withProjection?: boolean;
}

/**
 * Build the default authorized feed: a contiguous v1..v3 stream for the healthy aggregate
 * (sequences 1..3), optionally extended with a duplicate / out-of-order / malformed change.
 * `windowFloorSequence` lets a test simulate eviction (an expired resume cursor).
 */
export function buildFeed(over: FeedOverrides = {}): TenantChangeFeed {
  let records: ChangeRecord[];
  if (over.records) {
    records = [...over.records];
  } else {
    records = [
      assetChange(1, HEALTHY_ASSET_ID, 1),
      assetChange(2, HEALTHY_ASSET_ID, 2),
      assetChange(3, HEALTHY_ASSET_ID, 3),
    ];
    let next = 4;
    if (over.includeDuplicate) {
      // Exact re-delivery of v1 (same event id) at a later stream position.
      records.push({ sequence: next++, envelope: assetChange(1, HEALTHY_ASSET_ID, 1).envelope });
    }
    if (over.includeMalformed) {
      records.push({
        sequence: next++,
        // A structurally invalid envelope (bad event_id) — must be skipped VISIBLY.
        envelope: { schema_version: '1.0.0', event_id: 'not-a-uuid', data: {} },
      });
    }
    if (over.includeOutOfOrder) {
      // A v3 for the SECOND aggregate with no v1/v2 seen in this stream ⇒ out_of_order gap.
      records.push(assetChange(next++, SECOND_AGGREGATE, 3));
    }
  }

  const windowFloorSequence = over.windowFloorSequence ?? 1;
  // Model real eviction: records below the retained floor are no longer in the window. This makes
  // an expired-cursor resume genuinely unable to replay the missed span (not merely flagged).
  const retained = records.filter((r) => r.sequence >= windowFloorSequence);
  const latestSequence = retained.reduce((m, r) => Math.max(m, r.sequence), 0);
  return {
    records: retained,
    windowFloorSequence,
    latestSequence,
    freshness: over.freshness ?? 'current',
    partialCoverage: over.partialCoverage ?? false,
    now: NOW as EpochMillis,
    // The tenant's real inventory read model (all six AC scenarios) — attached only when requested,
    // scoped to the SAME tenant the provider serves so the service's per-ingest tenant assertion
    // holds. When present the route projects the current-state view onto the SSE wire.
    ...(over.withProjection ? { projection: buildProjection(TENANT_ID, NOW as EpochMillis) } : {}),
  };
}

/** A provider that serves `feed` only for `TENANT_ID`; every other tenant has no stream. */
export function providerFor(feed: TenantChangeFeed): ChangeFeedProvider {
  return (tenantId) => (String(tenantId) === String(TENANT_ID) ? feed : undefined);
}
