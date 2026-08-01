// @trustcircle/application — SNAPSHOT / OBSERVATION RECONCILIATION (Phase 71).
//
// Reconciles successive discovery/observation CYCLES of a tenant's sources against the prior
// known-source set and classifies every deviation into a named SOURCE-ANOMALY class, keeping each
// anomaly VISIBLE and OWNED rather than silently collapsing, repairing, or dropping it.
//
// A "source" is identified by `(tenantId, catalogId, externalKey)` (`sourceRecordIdentity`), and a
// source's CONTENT is fingerprinted by a stable digest of its governed observation (its
// `observedState`, sourceClass, and bound asset). Reconciling one cycle against the last-known set
// therefore yields, per identity/fingerprint, one of ten anomaly classes:
//
//   missing      — a previously-known identity is ABSENT from this cycle (transient: still within
//                  the disappearance horizon). Held as an unreachable coverage gap; never healthy.
//   duplicate    — two DISTINCT raw observations in one cycle collapse to the SAME identity. Both
//                  raw records are retained; a duplicate correlation issue is opened.
//   stale        — the freshest observation for a known identity is older than the staleness
//                  horizon. Marked with last-known time + confidence; current health is NOT
//                  inferred from it.
//   conflicting  — two active observations for the SAME identity report differing governed state.
//                  Held verbatim; the field conflict pauses affected automation (via correlation).
//   orphaned     — an observation names an `assetId` that no governed asset in scope claims. Held
//                  as an orphaned coverage gap against the source record.
//   changed      — a known identity's CONTENT fingerprint differs from the last cycle (same
//                  identity, new observed state). Recorded as a change delta.
//   moved        — a known content fingerprint reappears under a NEW identity while its OLD
//                  identity disappears (1→1 rekey). The lineage is preserved as a `moved` delta.
//   split        — one prior identity's fingerprint now maps to MULTIPLE new identities (1→N).
//   merged       — MULTIPLE prior identities' fingerprints now map to ONE new identity (N→1).
//   disappeared  — a `missing` identity that has stayed absent BEYOND the disappearance horizon.
//                  Escalated from transient-missing to a durable disappeared gap.
//
// Governing oracles (acceptance criteria, verified in
// tests/unit/inventory-reconciliation.unit.test.ts):
//   AC1 Each healthy reconciled source renders ONCE with type / source identity / owner / lifecycle
//       / risk / control coverage / evidence state / health / last-observation time / unresolved
//       issues → `currentInventory()` (an `InventoryService` view) yields one row per asset carrying
//       every facet; a source with no anomaly contributes no gap.
//   AC2 A discovered-but-unmanaged / unreachable / stale / orphaned / excluded source stays VISIBLE
//       as a coverage gap with reason / age / impact / required owner action — never healthy, never
//       disappearing → `openGaps()` retains every such gap; `deltas()` retains the classification.
//   AC3 Related work across sources (Kanban / agentctl / workflows_orchestration) shows DISTINCT
//       source records, correlation, status differences, dependencies, authoritative fields →
//       `currentInventory().drillDown()` + `conflicts()`.
//   AC4 A stale / unavailable source is marked with last-known time + confidence and current health
//       is NOT inferred from stale data → `sourceStatus()` reports `lastKnownAt` + `confidence` +
//       `stale`, and the composed row withholds `reportedHealth` (`unknown`) for stale evidence.
//   AC5 An unregistered governance-relevant source is ADDED to the catalog with discovery evidence
//       / type-or-unknown classification / location / access status / sensitivity / ownership
//       status / onboarding state → `catalog()` + newly-onboarded entries from `reconcile()`.
//   AC6 A discovered source that is unsupported / inaccessible / sensitive / unowned / excluded
//       stays VISIBLE as a GOVERNED-SOURCE gap with reason / impact / owner action /
//       review-or-expiry → `governedSourceGaps()` retains each with its deadline.
//
// The reconciler is a pure, dependency-free (transitively node:crypto only) in-memory aggregate. It
// NEVER touches the wall clock: every `reconcile()` cycle carries an explicit `at: EpochMillis` and
// mints ids from an injected factory (`newId`); every read takes an explicit `at`. Identity,
// fingerprints, ages, staleness, and disappearance are therefore deterministic and independently
// reproducible.
//
// Every mutation is INDEPENDENTLY READABLE afterwards (`deltas()`, `openGaps()`, `conflicts()`,
// `catalog()`, `currentInventory()`, `snapshotDigest()`): the mutation's return value is never the
// proof — the re-readable state + its content digest are. The reconciler grants NO authority: it
// records, classifies, and keeps visible; it never silently repairs and NEVER deletes.

import {
  isUuid,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
} from '@trustcircle/domain';
import {
  // source records — the observed unit of reconciliation
  type SourceRecord,
  sourceRecordIdentity,
  sourceRecordFreshnessSuspect,
  // coverage gaps — the VISIBLE anomaly surface (AC2/AC6)
  type CoverageGap,
  makeCoverageGap,
  type GapReason,
  type GapImpact,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  // governed assets — orphan detection needs the claimed-asset set
  type GovernedAsset,
  // catalog (AC5)
  type SourceCatalogEntry,
  // authority policy for the composed inventory correlation (AC3)
  type SourceAuthorityPolicy,
  makeSourceAuthorityPolicy,
} from '@trustcircle/domain';
import { createHash } from 'node:crypto';
import { InventoryService, type InventoryRow } from './inventory-service.ts';
import type { IdFactory } from './source-registry.ts';

// ===========================================================================
// 0. Shared guards + helpers (mirror the domain factory guards so a bad ingest
//    fails fast and fail-visibly, exactly like the aggregates it holds).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
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

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** Drop `undefined`-valued keys (required under exactOptionalPropertyTypes) and freeze. */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.freeze(out) as T;
}

// ===========================================================================
// 1. Anomaly model — the ten source-anomaly classes and the delta records the
//    reconciler emits. Every deviation across cycles becomes ONE typed delta;
//    deltas are append-only and never removed (inventory history stays whole).
// ===========================================================================

/** The ten source-anomaly classes this phase reconciles. */
export const SOURCE_ANOMALY_CLASSES = [
  'missing',
  'duplicate',
  'stale',
  'conflicting',
  'orphaned',
  'changed',
  'moved',
  'split',
  'merged',
  'disappeared',
] as const;
export type SourceAnomalyClass = (typeof SOURCE_ANOMALY_CLASSES)[number];

export function isSourceAnomalyClass(s: unknown): s is SourceAnomalyClass {
  return typeof s === 'string' && (SOURCE_ANOMALY_CLASSES as readonly string[]).includes(s);
}

/**
 * A single reconciliation finding for one cycle. Immutable once emitted; kept forever so the
 * reconciliation history of a source is fully reconstructable. `identity` is the affected source
 * identity (or, for moved/split/merged, the primary prior identity); `relatedIdentities` names the
 * other identities involved in a lineage change; `fingerprint` is the content digest at the cycle.
 */
export interface ReconciliationDelta {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly anomaly: SourceAnomalyClass;
  readonly identity: string;
  readonly relatedIdentities: readonly string[];
  readonly fingerprint?: string;
  readonly priorFingerprint?: string;
  /** The gap this delta opened, when the anomaly is a coverage/governed-source gap (AC2/AC6). */
  readonly gapId?: Uuid;
  readonly detail: string;
  readonly cycle: number;
  readonly detectedAt: EpochMillis;
}

/** A per-identity source-status view (AC4): last-known observation + confidence + staleness. */
export interface SourceStatus {
  readonly identity: string;
  readonly tenantId: TenantId;
  readonly catalogId: Uuid;
  readonly externalKey: string;
  readonly sourceClass: string;
  readonly present: boolean;
  readonly stale: boolean;
  readonly disappeared: boolean;
  /** Last cycle in which this identity was observed. */
  readonly lastObservedCycle: number;
  /** The freshest observation's own recorded time (AC4 last-known time). */
  readonly lastKnownAt: EpochMillis;
  /** [0,1] confidence in the current view of this source — decays for stale/absent evidence. */
  readonly confidence: number;
  readonly anomalies: readonly SourceAnomalyClass[];
}

/** A conflict view (AC3): distinct active observations for one identity that disagree. */
export interface SourceConflict {
  readonly identity: string;
  readonly recordIds: readonly Uuid[];
  readonly differingStatuses: readonly string[];
  readonly detail: string;
}

const DEFAULT_STALENESS_HORIZON_MILLIS = 15 * 60 * 1000;
// After this many consecutive absent cycles a `missing` source escalates to `disappeared`.
const DEFAULT_DISAPPEARANCE_CYCLES = 2;

export interface SourceReconcilerInput {
  readonly tenantId: TenantId;
  readonly newId: IdFactory;
  readonly policy?: SourceAuthorityPolicy;
  readonly stalenessHorizonMillis?: number;
  readonly disappearanceCycles?: number;
}

/** Per-identity tracking state carried between cycles (never exposed raw). */
interface KnownSource {
  readonly catalogId: Uuid;
  readonly externalKey: string;
  sourceClass: string;
  fingerprint: string;
  lastObservedCycle: number;
  lastKnownAt: EpochMillis;
  /** Consecutive cycles this identity has been absent (0 while present). */
  absentCycles: number;
  present: boolean;
  disappeared: boolean;
  /** True iff the freshest observation last cycle was itself flagged stale (freshness !== fresh). */
  staleObservation: boolean;
  /** Anomaly classes ever attributed to this identity. */
  readonly anomalies: Set<SourceAnomalyClass>;
}

// ===========================================================================
// 2. The reconciler.
// ===========================================================================

/**
 * Ingests successive observation cycles and reconciles each against the known-source set. The
 * composed `InventoryService` renders the CURRENT healthy inventory (AC1/AC3/AC4); the reconciler
 * layers anomaly detection, coverage/governed-source gaps (AC2/AC6), and the source catalog (AC5)
 * on top. A single tenant per instance; cross-tenant observations are rejected.
 */
export class SourceReconciler {
  readonly #tenantId: TenantId;
  readonly #newId: IdFactory;
  readonly #policy: SourceAuthorityPolicy;
  readonly #stalenessHorizonMillis: number;
  readonly #disappearanceCycles: number;

  readonly #inventory: InventoryService;

  /** Known sources keyed by `sourceRecordIdentity`. Never deleted — a vanished source flips to
   *  `present=false`/`disappeared`, so its history stays queryable. */
  readonly #known = new Map<string, KnownSource>();
  /** Content fingerprint → set of identities that carried it in the PRIOR cycle (lineage index). */
  #priorFingerprints = new Map<string, Set<string>>();
  /** Append-only anomaly findings. */
  readonly #deltas: ReconciliationDelta[] = [];
  /** All coverage / governed-source gaps ever opened, keyed by gap id. Never deleted. */
  readonly #gaps = new Map<Uuid, CoverageGap>();
  /** Catalog entries onboarded through reconciliation, keyed by identity. */
  readonly #catalog = new Map<string, SourceCatalogEntry>();
  /** Open conflicts keyed by identity (recomputed each cycle from the raw records). */
  readonly #conflicts = new Map<string, SourceConflict>();

  #cycle = 0;

  constructor(input: SourceReconcilerInput) {
    assertTenant(input.tenantId, 'SourceReconciler.tenantId');
    if (typeof input.newId !== 'function') {
      throw new TypeError('SourceReconciler.newId must be an IdFactory');
    }
    this.#tenantId = input.tenantId;
    this.#newId = input.newId;
    this.#policy =
      input.policy ?? makeSourceAuthorityPolicy({ id: 'inventory-reconciliation-default-policy' });
    this.#stalenessHorizonMillis = input.stalenessHorizonMillis ?? DEFAULT_STALENESS_HORIZON_MILLIS;
    if (!Number.isInteger(this.#stalenessHorizonMillis) || this.#stalenessHorizonMillis <= 0) {
      throw new RangeError('stalenessHorizonMillis must be a positive integer');
    }
    this.#disappearanceCycles = input.disappearanceCycles ?? DEFAULT_DISAPPEARANCE_CYCLES;
    if (!Number.isInteger(this.#disappearanceCycles) || this.#disappearanceCycles < 1) {
      throw new RangeError('disappearanceCycles must be a positive integer');
    }
    this.#inventory = new InventoryService(
      compact({
        tenantId: this.#tenantId,
        newId: this.#newId,
        policy: this.#policy,
        stalenessHorizonMillis: this.#stalenessHorizonMillis,
      }),
    );
  }

  /** Mint a fresh id from the injected factory (asserted UUID). */
  #mintId(): Uuid {
    const id = this.#newId();
    assertUuid(id, 'SourceReconciler.newId() output');
    return id;
  }

  #assertScope(t: TenantId, label: string): void {
    assertTenant(t, label);
    if (t !== this.#tenantId) {
      throw new RangeError(
        `${label} tenant ${String(t)} does not match reconciler scope ${String(this.#tenantId)}`,
      );
    }
  }

  /**
   * The CONTENT fingerprint of a source observation: a stable digest of the governed observation
   * that identity-independent lineage (moved/split/merged) is tracked by. Deliberately EXCLUDES the
   * externalKey/catalogId (which ARE the identity) so a re-keyed but content-equal source shares a
   * fingerprint with its predecessor. Includes sourceClass, bound asset, and observed state.
   */
  static fingerprintOf(record: SourceRecord): string {
    const canonical = JSON.stringify({
      sourceClass: record.sourceClass,
      assetId: record.assetId ?? null,
      observedState: record.observedState,
    });
    return sha256(canonical);
  }

  // -------------------------------------------------------------------------
  // Ingest surfaces (delegated to the composed inventory for the healthy view).
  // -------------------------------------------------------------------------

  /** Register a governed asset so orphan detection knows the claimed-asset set (AC1). */
  ingestAsset(input: { asset: GovernedAsset; fields: readonly string[] }): GovernedAsset {
    this.#assertScope(input.asset.tenantId, 'ingestAsset.asset.tenantId');
    return this.#inventory.ingestAsset(input);
  }

  /** The composed current-inventory service — the healthy AC1/AC3/AC4 render surface. */
  currentInventory(): InventoryService {
    return this.#inventory;
  }

  // -------------------------------------------------------------------------
  // The reconciliation cycle.
  // -------------------------------------------------------------------------

  /**
   * Reconcile ONE observation cycle: the full set of source records observed in this cycle, plus
   * (optionally) the catalog entries and governed assets those sources belong to. Returns the
   * deltas emitted THIS cycle (also appended to `deltas()`). The durable proof is the re-readable
   * state, not this return value.
   */
  reconcile(input: {
    observations: readonly SourceRecord[];
    catalogEntries?: readonly SourceCatalogEntry[];
    assets?: readonly { asset: GovernedAsset; fields: readonly string[] }[];
    at: EpochMillis;
  }): readonly ReconciliationDelta[] {
    assertEpoch(input.at, 'reconcile.at');
    if (!Array.isArray(input.observations)) {
      throw new TypeError('reconcile.observations must be an array');
    }
    const at = input.at;
    const cycle = ++this.#cycle;
    const emitted: ReconciliationDelta[] = [];

    // (0) Register any governed assets first so orphan detection sees the claimed-asset set.
    for (const a of input.assets ?? []) this.ingestAsset(a);
    const claimedAssetIds = new Set(this.#inventory.assets().map((a) => a.id));

    // (1) Onboard catalog entries (AC5): every observed source's catalog membership is recorded
    //     with discovery evidence / classification / location / access / sensitivity / ownership.
    for (const entry of input.catalogEntries ?? []) {
      this.#assertScope(entry.tenantId, 'reconcile.catalogEntries.tenantId');
      const key = `${entry.tenantId}|${entry.id}`;
      this.#catalog.set(key, entry);
      this.#inventory.ingestCatalogEntry(entry);
    }

    // (2) Group this cycle's raw observations by source identity. Two DISTINCT records under one
    //     identity is a `duplicate`; retain BOTH raw records verbatim.
    const byIdentity = new Map<string, SourceRecord[]>();
    for (const rec of input.observations) {
      this.#assertScope(rec.tenantId, 'reconcile.observations.tenantId');
      const identity = sourceRecordIdentity(rec);
      const bucket = byIdentity.get(identity);
      if (bucket) bucket.push(rec);
      else byIdentity.set(identity, [rec]);
    }

    // (3) Build this cycle's fingerprint index (content → identities) for lineage detection.
    const cycleFingerprints = new Map<string, Set<string>>();
    const observedIdentities = new Set<string>();

    for (const [identity, records] of byIdentity) {
      observedIdentities.add(identity);
      const primary = pickFreshest(records);
      const fingerprint = SourceReconciler.fingerprintOf(primary);
      addToIndex(cycleFingerprints, fingerprint, identity);

      // Feed every distinct raw record into the inventory (dedup by identity happens there; a
      // duplicate REPLACES, so we ingest all so the freshest wins and the raw set is complete).
      for (const rec of records) {
        if (rec.assetId !== undefined) this.#inventory.ingestSourceRecord(rec);
      }

      const prior = this.#known.get(identity);
      const priorFingerprint = prior?.fingerprint;

      // (3a) duplicate — two distinct raw records collapsed to one identity this cycle.
      if (records.length > 1) {
        emitted.push(
          this.#emit({
            anomaly: 'duplicate',
            identity,
            relatedIdentities: [],
            fingerprint,
            detail:
              `${records.length} distinct observations collapsed to a single source identity; ` +
              'all raw records retained for human de-duplication',
            cycle,
            at,
          }),
        );
        this.#conflicts.set(
          identity,
          compact({
            identity,
            recordIds: records.map((r) => r.id),
            differingStatuses: unique(records.map((r) => r.status)),
            detail: 'duplicate identity — multiple distinct records observed in one cycle',
          }),
        );
      }

      // (3b) conflicting — ≥2 active records for one identity report differing governed status.
      const active = records.filter((r) => r.status === 'active' || r.status === 'conflicting');
      const statuses = unique(active.map((r) => r.status));
      // Compare GOVERNED CONTENT (identity-independent fingerprint), not the raw record digest —
      // the raw digest includes the record id, so two records that agree on state would otherwise
      // always look distinct. Two active records disagree only when their content fingerprints do.
      const distinctStates = unique(active.map((r) => SourceReconciler.fingerprintOf(r)));
      if (active.length > 1 && distinctStates.length > 1) {
        emitted.push(
          this.#emit({
            anomaly: 'conflicting',
            identity,
            relatedIdentities: [],
            fingerprint,
            detail:
              'multiple active observations for one identity report differing governed state; ' +
              'affected automation pauses until an owner resolves the conflict',
            cycle,
            at,
          }),
        );
        this.#conflicts.set(
          identity,
          compact({
            identity,
            recordIds: active.map((r) => r.id),
            differingStatuses: statuses,
            detail: 'conflicting observations — differing governed state for one identity',
          }),
        );
      } else if (records.length <= 1) {
        // No longer conflicting/duplicate this cycle — clear any prior conflict for this identity.
        this.#conflicts.delete(identity);
      }

      // (3c) orphaned — the observation names an asset no governed asset in scope claims.
      for (const rec of records) {
        if (rec.assetId !== undefined && !claimedAssetIds.has(rec.assetId)) {
          const gap = this.#openGap({
            subjectKind: 'source_record',
            subjectId: rec.id,
            gapClass: 'component',
            reason: 'orphaned',
            impact: 'high',
            requiredAction:
              'Orphaned source observation references an asset absent from the governed ' +
              'inventory; an owner must (re)link or retire the source.',
            at,
          });
          emitted.push(
            this.#emit({
              anomaly: 'orphaned',
              identity,
              relatedIdentities: [],
              fingerprint,
              gapId: gap.id,
              detail: `observation references unclaimed asset ${String(rec.assetId)}`,
              cycle,
              at,
            }),
          );
        }
      }

      // (3d) stale — the freshest observation for this identity is not fresh / beyond the horizon.
      const staleByFreshness = sourceRecordFreshnessSuspect(primary);
      const staleByAge = at - primary.observedAt > this.#stalenessHorizonMillis;
      if (staleByFreshness || staleByAge) {
        const gap = this.#openGap({
          subjectKind: 'source_record',
          subjectId: primary.id,
          gapClass: 'component',
          reason: 'stale',
          impact: 'medium',
          requiredAction:
            'Source observation is stale; current health must NOT be inferred from it. An owner ' +
            'must re-observe the source or confirm its last-known state.',
          at,
        });
        emitted.push(
          this.#emit({
            anomaly: 'stale',
            identity,
            relatedIdentities: [],
            fingerprint,
            gapId: gap.id,
            detail: `freshest observation stale (freshness=${primary.freshness}); last known at ${String(primary.observedAt)}`,
            cycle,
            at,
          }),
        );
      }

      // (3e) changed — a KNOWN identity's content fingerprint differs from the prior cycle.
      if (prior && priorFingerprint !== undefined && priorFingerprint !== fingerprint) {
        emitted.push(
          this.#emit({
            anomaly: 'changed',
            identity,
            relatedIdentities: [],
            fingerprint,
            priorFingerprint,
            detail: 'source content changed since the last cycle (same identity, new observation)',
            cycle,
            at,
          }),
        );
      }

      // Advance / create the known-source tracking state for this identity.
      const tracked: KnownSource = prior ?? {
        catalogId: primary.catalogId,
        externalKey: primary.externalKey,
        sourceClass: primary.sourceClass,
        fingerprint,
        lastObservedCycle: cycle,
        lastKnownAt: primary.observedAt,
        absentCycles: 0,
        present: true,
        disappeared: false,
        staleObservation: staleByFreshness,
        anomalies: new Set<SourceAnomalyClass>(),
      };
      tracked.sourceClass = primary.sourceClass;
      tracked.fingerprint = fingerprint;
      tracked.lastObservedCycle = cycle;
      tracked.lastKnownAt = primary.observedAt;
      tracked.absentCycles = 0;
      tracked.present = true;
      tracked.disappeared = false;
      tracked.staleObservation = staleByFreshness;
      this.#known.set(identity, tracked);
    }

    // (4) Lineage detection (moved / split / merged): compare this cycle's fingerprint index
    //     against the prior cycle's. A fingerprint present in BOTH but under different identities is
    //     a re-key; count the cardinality of the change to classify it.
    for (const [fingerprint, nowIds] of cycleFingerprints) {
      const thenIds = this.#priorFingerprints.get(fingerprint);
      if (!thenIds || thenIds.size === 0) continue;
      const appeared = [...nowIds].filter((i) => !thenIds.has(i));
      const vanished = [...thenIds].filter((i) => !nowIds.has(i));
      if (appeared.length === 0 && vanished.length === 0) continue; // stable identity, no lineage change.

      if (vanished.length >= 1 && appeared.length >= 1) {
        // Distinguish 1→1 (moved), 1→N (split), N→1 (merged).
        let anomaly: SourceAnomalyClass;
        if (vanished.length === 1 && appeared.length === 1) anomaly = 'moved';
        else if (vanished.length === 1 && appeared.length > 1) anomaly = 'split';
        else if (vanished.length > 1 && appeared.length === 1) anomaly = 'merged';
        else anomaly = 'split'; // N→M (rare): treat as a split for owner review.

        const primaryPrior = vanished[0]!;
        emitted.push(
          this.#emit({
            anomaly,
            identity: primaryPrior,
            relatedIdentities: [...vanished.slice(1), ...appeared].sort(),
            fingerprint,
            detail:
              `${anomaly}: content fingerprint re-keyed from [${vanished.sort().join(', ')}] ` +
              `to [${appeared.sort().join(', ')}]`,
            cycle,
            at,
          }),
        );
        // Mark the vanished identities as accounted-for by lineage (they will still register as
        // `missing`/`disappeared` below unless present, but the moved/split/merged delta records
        // the lineage so the disappearance is not mysterious).
        for (const v of vanished) {
          const k = this.#known.get(v);
          if (k) k.anomalies.add(anomaly);
        }
      }
    }

    // (5) Absence handling (missing / disappeared): every known identity NOT observed this cycle.
    for (const [identity, tracked] of this.#known) {
      if (observedIdentities.has(identity)) continue;
      tracked.present = false;
      tracked.absentCycles += 1;
      const disappeared = tracked.absentCycles >= this.#disappearanceCycles;
      const anomaly: SourceAnomalyClass = disappeared ? 'disappeared' : 'missing';
      tracked.disappeared = disappeared;
      const gap = this.#openGap({
        subjectKind: 'source_record',
        subjectId: undefined,
        gapClass: 'component',
        reason: disappeared ? 'unmanaged' : 'unreachable',
        impact: disappeared ? 'high' : 'medium',
        requiredAction: disappeared
          ? `Source '${identity}' has disappeared for ${tracked.absentCycles} consecutive cycles; ` +
            'an owner must confirm retirement or restore observation.'
          : `Source '${identity}' was not observed this cycle; an owner must confirm reachability.`,
        at,
        identityKey: identity,
      });
      emitted.push(
        this.#emit({
          anomaly,
          identity,
          relatedIdentities: [],
          fingerprint: tracked.fingerprint,
          gapId: gap.id,
          detail: disappeared
            ? `absent for ${tracked.absentCycles} consecutive cycles (beyond horizon ${this.#disappearanceCycles})`
            : `absent this cycle (${tracked.absentCycles}/${this.#disappearanceCycles} before disappearance)`,
          cycle,
          at,
        }),
      );
    }

    // (6) Roll the fingerprint index forward for the next cycle.
    this.#priorFingerprints = cycleFingerprints;

    // (7) Record every emitted anomaly on the affected identity's tracked state.
    for (const d of emitted) {
      const k = this.#known.get(d.identity);
      if (k) k.anomalies.add(d.anomaly);
    }

    return Object.freeze(emitted);
  }

  // -------------------------------------------------------------------------
  // Internal emit / gap helpers.
  // -------------------------------------------------------------------------

  #emit(input: {
    anomaly: SourceAnomalyClass;
    identity: string;
    relatedIdentities: readonly string[];
    fingerprint?: string;
    priorFingerprint?: string;
    gapId?: Uuid;
    detail: string;
    cycle: number;
    at: EpochMillis;
  }): ReconciliationDelta {
    const delta = compact({
      id: this.#mintId(),
      tenantId: this.#tenantId,
      anomaly: input.anomaly,
      identity: input.identity,
      relatedIdentities: Object.freeze([...input.relatedIdentities]),
      fingerprint: input.fingerprint,
      priorFingerprint: input.priorFingerprint,
      gapId: input.gapId,
      detail: input.detail,
      cycle: input.cycle,
      detectedAt: input.at,
    }) as ReconciliationDelta;
    this.#deltas.push(delta);
    return delta;
  }

  #openGap(input: {
    subjectKind: 'source_record' | 'source_catalog_entry' | 'component';
    subjectId?: Uuid | undefined;
    gapClass: 'component' | 'governed_source';
    reason: GapReason;
    impact: GapImpact;
    requiredAction: string;
    requiredOwner?: Uuid | undefined;
    reviewAt?: EpochMillis | undefined;
    expiresAt?: EpochMillis | undefined;
    at: EpochMillis;
    /** Identity key for absence gaps whose subject record id is not available. */
    identityKey?: string | undefined;
  }): CoverageGap {
    const gap = makeCoverageGap(
      compact({
        id: this.#mintId(),
        tenantId: this.#tenantId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        gapClass: input.gapClass,
        reason: input.reason,
        impact: input.impact,
        requiredAction: input.requiredAction,
        requiredOwner: input.requiredOwner,
        status: 'open' as const,
        firstSeenAt: input.at,
        reviewAt: input.reviewAt,
        expiresAt: input.expiresAt,
      }) as Parameters<typeof makeCoverageGap>[0],
    );
    this.#gaps.set(gap.id, gap);
    return gap;
  }

  /**
   * Open a GOVERNED-SOURCE gap (AC6) for a discovered source that is unsupported / inaccessible /
   * sensitive / unowned / excluded. Requires a review-or-expiry deadline so the gap stays owned.
   */
  openGovernedSourceGap(input: {
    subjectId: Uuid;
    reason: Extract<
      GapReason,
      'unsupported' | 'inaccessible' | 'sensitive' | 'unowned' | 'excluded'
    >;
    impact?: GapImpact;
    requiredAction: string;
    requiredOwner?: Uuid;
    reviewAt?: EpochMillis;
    expiresAt?: EpochMillis;
    at: EpochMillis;
  }): CoverageGap {
    assertUuid(input.subjectId, 'openGovernedSourceGap.subjectId');
    assertEpoch(input.at, 'openGovernedSourceGap.at');
    if (input.reviewAt === undefined && input.expiresAt === undefined) {
      throw new RangeError(
        'a governed-source gap requires a review-or-expiry deadline (reviewAt or expiresAt)',
      );
    }
    return this.#openGap(
      compact({
        subjectKind: 'source_catalog_entry' as const,
        subjectId: input.subjectId,
        gapClass: 'governed_source' as const,
        reason: input.reason,
        impact: input.impact ?? 'high',
        requiredAction: input.requiredAction,
        requiredOwner: input.requiredOwner,
        reviewAt: input.reviewAt,
        expiresAt: input.expiresAt,
        at: input.at,
      }),
    );
  }

  /**
   * Add an unregistered governance-relevant source to the catalog (AC5). Convenience over the
   * domain factory; records discovery evidence, type-or-unknown classification, location, access,
   * sensitivity, ownership status, and onboarding state.
   */
  catalogSource(entry: SourceCatalogEntry): SourceCatalogEntry {
    this.#assertScope(entry.tenantId, 'catalogSource.tenantId');
    const key = `${entry.tenantId}|${entry.id}`;
    this.#catalog.set(key, entry);
    this.#inventory.ingestCatalogEntry(entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Read surfaces — the independent, re-readable witnesses.
  // -------------------------------------------------------------------------

  /** Current cycle count (number of `reconcile()` calls). */
  cycle(): number {
    return this.#cycle;
  }

  /** Every anomaly finding ever emitted, in detection order (append-only). */
  deltas(): readonly ReconciliationDelta[] {
    return Object.freeze([...this.#deltas]);
  }

  /** Anomaly findings for one class. */
  deltasOfClass(anomaly: SourceAnomalyClass): readonly ReconciliationDelta[] {
    return Object.freeze(this.#deltas.filter((d) => d.anomaly === anomaly));
  }

  /** Anomaly findings affecting one source identity (as primary or related). */
  deltasForIdentity(identity: string): readonly ReconciliationDelta[] {
    return Object.freeze(
      this.#deltas.filter((d) => d.identity === identity || d.relatedIdentities.includes(identity)),
    );
  }

  /** Every gap ever opened (including any later resolved), sorted by id (AC2/AC6 history). */
  gaps(): readonly CoverageGap[] {
    return Object.freeze([...this.#gaps.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }

  /** Currently-VISIBLE gaps (open|acknowledged) — never disappearing (AC2). */
  openGaps(): readonly CoverageGap[] {
    return Object.freeze(this.gaps().filter((g) => gapIsVisible(g)));
  }

  /** Visible GOVERNED-SOURCE gaps, each carrying a review-or-expiry deadline (AC6). */
  governedSourceGaps(): readonly CoverageGap[] {
    return Object.freeze(
      this.gaps().filter(
        (g) => g.gapClass === 'governed_source' && gapIsVisible(g) && gapHasReviewOrExpiry(g),
      ),
    );
  }

  /** Age (ms) of one gap at `now`. */
  gapAge(gapId: Uuid, now: EpochMillis): number {
    assertUuid(gapId, 'gapAge.gapId');
    assertEpoch(now, 'gapAge.now');
    const gap = this.#gaps.get(gapId);
    if (!gap) throw new RangeError(`no gap ${String(gapId)}`);
    return gapAgeMillis(gap, now);
  }

  /** Open conflicts (AC3): identities with differing/duplicate active observations. */
  conflicts(): readonly SourceConflict[] {
    return Object.freeze(
      [...this.#conflicts.values()].sort((a, b) => a.identity.localeCompare(b.identity)),
    );
  }

  /** Catalog entries added through reconciliation (AC5), sorted by id. */
  catalog(): readonly SourceCatalogEntry[] {
    return Object.freeze([...this.#catalog.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }

  /**
   * Per-identity status view (AC4): for a known source, its last-known observation time,
   * confidence, staleness, presence, and disappearance — with current health NEVER inferred from
   * stale/absent evidence (confidence decays, presence flips, the composed row withholds health).
   */
  sourceStatus(identity: string, at: EpochMillis): SourceStatus {
    assertEpoch(at, 'sourceStatus.at');
    const tracked = this.#known.get(identity);
    if (!tracked) throw new RangeError(`no known source ${identity}`);
    const ageMillis = at - tracked.lastKnownAt;
    const staleByAge = ageMillis > this.#stalenessHorizonMillis;
    // Stale iff: the last observation was itself flagged stale, OR it is now beyond the age horizon,
    // OR the source is currently absent. Current health is never inferred from any of these.
    const stale = tracked.staleObservation || staleByAge || !tracked.present;
    const confidence = this.#confidenceFor(tracked, at);
    const [scopeTenant, cat, ext] = identity.split('|');
    return compact({
      identity,
      tenantId: (scopeTenant as TenantId) ?? this.#tenantId,
      catalogId: (cat as Uuid) ?? tracked.catalogId,
      externalKey: ext ?? tracked.externalKey,
      sourceClass: tracked.sourceClass,
      present: tracked.present,
      stale,
      disappeared: tracked.disappeared,
      lastObservedCycle: tracked.lastObservedCycle,
      lastKnownAt: tracked.lastKnownAt,
      confidence,
      anomalies: Object.freeze([...tracked.anomalies].sort()),
    }) as SourceStatus;
  }

  /** Every known source identity's status (AC4), sorted by identity. */
  sourceStatuses(at: EpochMillis): readonly SourceStatus[] {
    assertEpoch(at, 'sourceStatuses.at');
    return Object.freeze(
      [...this.#known.keys()].sort().map((identity) => this.sourceStatus(identity, at)),
    );
  }

  /**
   * Confidence [0,1] in a known source's current view. Fresh + present within the horizon → 1;
   * decays LINEARLY across a second horizon-width for staleness/absence; 0 beyond 2×horizon or once
   * disappeared. NEVER promotes stale/absent evidence to full confidence.
   */
  #confidenceFor(tracked: KnownSource, at: EpochMillis): number {
    if (tracked.disappeared) return 0;
    const age = Math.max(0, at - tracked.lastKnownAt);
    const h = this.#stalenessHorizonMillis;
    let base: number;
    if (age <= h) base = 1;
    else if (age >= 2 * h) base = 0;
    else base = 1 - (age - h) / h;
    // A stale-flagged or absent observation caps confidence strictly below 1 regardless of recency —
    // stale evidence is never promoted to full confidence.
    if (tracked.staleObservation || !tracked.present) base = Math.min(base, 0.99);
    return base;
  }

  /** The composed current-inventory rows (AC1/AC3/AC4). */
  currentStateView(at: EpochMillis): readonly InventoryRow[] {
    return this.#inventory.currentStateView(at);
  }

  /**
   * A content witness over the whole reconciliation state at `at`: known sources, deltas, gaps,
   * conflicts, catalog, and the composed inventory digest. Stable ⇔ identical governed state;
   * changes iff ANY reconciliation fact changes. The proof of every mutation, independent of any
   * return value.
   */
  snapshotDigest(at: EpochMillis): string {
    assertEpoch(at, 'snapshotDigest.at');
    const parts: string[] = [];
    for (const [identity, k] of this.#known) {
      parts.push(
        `known|${identity}|${k.fingerprint}|${k.present ? 1 : 0}|${k.disappeared ? 1 : 0}|` +
          `${k.absentCycles}|${k.lastObservedCycle}|${k.lastKnownAt}|${[...k.anomalies].sort().join(',')}`,
      );
    }
    for (const d of this.#deltas) {
      parts.push(
        `delta|${d.anomaly}|${d.identity}|${[...d.relatedIdentities].sort().join(',')}|` +
          `${d.fingerprint ?? ''}|${d.priorFingerprint ?? ''}|${d.gapId ?? ''}|${d.cycle}`,
      );
    }
    for (const g of this.#gaps.values()) {
      parts.push(
        `gap|${g.id}|${g.gapClass}|${g.reason}|${g.impact}|${g.status}|${g.subjectId ?? ''}|` +
          `${g.reviewAt ?? ''}|${g.expiresAt ?? ''}`,
      );
    }
    for (const c of this.#conflicts.values()) {
      parts.push(`conflict|${c.identity}|${[...c.recordIds].sort().join(',')}`);
    }
    for (const e of this.#catalog.values()) {
      parts.push(`catalog|${e.id}|${e.sourceClass}|${e.onboardingState}|${e.accessState}`);
    }
    parts.push(`inventory|${this.#inventory.snapshotDigest(at)}`);
    return sha256(JSON.stringify(parts.sort()));
  }
}

// ===========================================================================
// 3. Free helpers.
// ===========================================================================

function pickFreshest(records: readonly SourceRecord[]): SourceRecord {
  // Prefer fresh over non-fresh, then the latest observedAt, then the lexically-greatest id (a
  // total, deterministic order with no wall-clock tiebreak).
  return [...records].sort((a, b) => {
    const af = a.freshness === 'fresh' ? 1 : 0;
    const bf = b.freshness === 'fresh' ? 1 : 0;
    if (af !== bf) return bf - af;
    if (a.observedAt !== b.observedAt) return b.observedAt - a.observedAt;
    return b.id.localeCompare(a.id);
  })[0]!;
}

function addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const set = index.get(key);
  if (set) set.add(value);
  else index.set(key, new Set([value]));
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

// NOTE: the domain gap/staleness helpers (gapIsVisible / gapHasReviewOrExpiry / gapAgeMillis /
// sourceRecordIdentity / sourceRecordFreshnessSuspect / UNKNOWN_SOURCE_CLASS) are already re-exported
// by the sibling application modules; they are intentionally NOT re-exported here to avoid an
// ambiguous `export *` collision at the package boundary. Import them from '@trustcircle/domain'.
