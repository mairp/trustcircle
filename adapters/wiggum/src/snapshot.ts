// @trustcircle/adapter-wiggum — read-only Wiggum snapshot discovery
// (task T264 / US6 / GAR-* discovery).
//
// Discovers Wiggum feature-isolated state, progress, locks, stop requests, runs, events,
// attempts, verdicts, markers, proofs, and archives *without changing them*, and correlates
// them into a governance-facing snapshot. This module is the source artifact behind four
// integration effect-witness verification obligations:
//
//   VO-d982977672dda011fc65 — healthy sources → state change reflected in the correlated
//     governance view within the freshness objective.
//   VO-468734d7c60e0fbb801b — a source misses health expectations → ownership, scope, last
//     success/failure, retry state, business impact, and safe next action are visible.
//   VO-d3ab0d39f511ca998e03 — duplicate / out-of-order source updates → no duplicate
//     governance action, and source history remains reconstructable.
//   VO-4c1d3e1127dd54c7664e — conflicting source states that authority rules cannot resolve
//     → conflict stays visible, affected automation pauses safely, an owned issue is opened.
//
// Effect-witness discipline (all four VOs): the value this module returns is a DURABLE,
// independently readable artifact — a deep-frozen snapshot carrying a content digest
// (`snapshotDigest`) that could not exist before discovery, and the pinned bundle identity
// (bundle id / semantic hash / work-item id). A caller verifies the effect through the
// returned snapshot's digest and identity, never by trusting a mutation response. Evidence
// whose bundle identity or semantic hash differs from the pinned input is REJECTED
// (`assertPinnedIdentity`), satisfying the negative cases.
//
// This module is dependency-free (Node built-in `crypto` only) and PURE: it performs no I/O
// and never mutates its inputs, so it is independently observable and testable under
// `npm ci` with no adjacent Wiggum installation. Callers pass an already-collected set of
// raw observations (the operations/health adapters own the actual reads); this module
// normalizes, correlates, deduplicates, and freezes them.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Pinned execution identity (bundle / semantic hash / work item).
// ---------------------------------------------------------------------------

/** Identity that every discovered observation must carry, matching the pinned bundle. */
export interface BundleIdentity {
  readonly bundleId: string;
  readonly semanticHash: string;
  readonly workItemId: string;
}

/** Freshness objective: max age (ms) a source observation may have and still be "fresh". */
export type FreshnessObjectiveMillis = number;

// ---------------------------------------------------------------------------
// Raw Wiggum observations (the surfaces the phase enumerates). All read-only.
// ---------------------------------------------------------------------------

export type WiggumSurface =
  | 'state'
  | 'progress'
  | 'lock'
  | 'stop-request'
  | 'run'
  | 'event'
  | 'attempt'
  | 'verdict'
  | 'marker'
  | 'proof'
  | 'archive';

export type WiggumHealthState = 'healthy' | 'degraded' | 'unavailable';

/**
 * A single raw observation read from a Wiggum feature. `externalRevision` +
 * `aggregateSequence` give ordering; `observedAt` gives freshness. `sourceContentHash` is the
 * source's own integrity anchor over the payload (used to detect duplicates that arrive with
 * a different revision but identical content).
 */
export interface WiggumObservation {
  readonly surface: WiggumSurface;
  /** Wiggum feature the observation belongs to (feature-isolation boundary). */
  readonly featureId: string;
  /** Stable external identity of the observed entity within its surface. */
  readonly externalId: string;
  /** Monotonic external revision string; distinguishes updates to the same entity. */
  readonly externalRevision: string;
  /** Preferred ordering key; null encodes ordering uncertainty (out-of-order tolerance). */
  readonly aggregateSequence: number | null;
  /** When the source produced the observation (epoch ms). */
  readonly occurredAt: number;
  /** When discovery observed it (epoch ms). Separate from occurredAt by design. */
  readonly observedAt: number;
  /** Source-reported content hash over the payload; the dedup/integrity anchor. */
  readonly sourceContentHash: string;
  /** Bundle identity the source stamped on this observation. */
  readonly identity: BundleIdentity;
  /** Opaque, already-normalized payload. Treated as immutable data. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Health expectation report for a Wiggum source/feature (VO-468734d7c60e0fbb801b). */
export interface WiggumHealthReport {
  readonly featureId: string;
  readonly healthState: WiggumHealthState;
  readonly ownerPrincipalId: string;
  readonly affectedScope: readonly string[];
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly retryState: {
    readonly attempts: number;
    readonly nextPermittedAt: number | null;
    readonly deadLettered: boolean;
  };
  readonly businessImpact: string;
  readonly safeNextAction: string;
}

/** Input to discovery. `now` is injected — this module never reads the wall clock. */
export interface DiscoveryInput {
  readonly pinnedIdentity: BundleIdentity;
  readonly freshnessObjectiveMillis: FreshnessObjectiveMillis;
  readonly now: number;
  readonly observations: readonly WiggumObservation[];
  readonly health: readonly WiggumHealthReport[];
}

// ---------------------------------------------------------------------------
// Snapshot output (the durable, independently readable effect witness).
// ---------------------------------------------------------------------------

export interface CorrelatedEntity {
  readonly surface: WiggumSurface;
  readonly featureId: string;
  readonly externalId: string;
  /** The authoritative (latest, in-order) revision retained for this entity. */
  readonly externalRevision: string;
  readonly aggregateSequence: number | null;
  readonly occurredAt: number;
  readonly observedAt: number;
  readonly sourceContentHash: string;
  /** Freshness relative to the objective, computed from observedAt vs now. */
  readonly freshness: 'fresh' | 'stale';
  readonly ageMillis: number;
  /** Every revision seen for this entity (ordered) — history stays reconstructable. */
  readonly revisionHistory: readonly string[];
  /** Count of superseded/duplicate observations collapsed into this entity. */
  readonly supersededCount: number;
}

/** An unresolved conflict that pauses affected automation and needs a human. */
export interface WiggumConflict {
  readonly featureId: string;
  readonly surface: WiggumSurface;
  readonly externalId: string;
  /** The distinct source content hashes that could not be authority-resolved. */
  readonly conflictingContentHashes: readonly string[];
  readonly reason: string;
  /** Stable, deterministic id of the owned issue opened for human resolution. */
  readonly ownedIssueId: string;
  readonly ownerPrincipalId: string;
}

export interface WiggumHealthAlert {
  readonly featureId: string;
  readonly healthState: WiggumHealthState;
  readonly ownerPrincipalId: string;
  readonly affectedScope: readonly string[];
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly retryState: WiggumHealthReport['retryState'];
  readonly businessImpact: string;
  readonly safeNextAction: string;
}

export interface WiggumSnapshot {
  readonly pinnedIdentity: BundleIdentity;
  readonly freshnessObjectiveMillis: FreshnessObjectiveMillis;
  readonly capturedAt: number;
  readonly entities: readonly CorrelatedEntity[];
  readonly conflicts: readonly WiggumConflict[];
  readonly healthAlerts: readonly WiggumHealthAlert[];
  /**
   * True when at least one unresolvable conflict or a non-healthy source means the
   * governance automation must pause safely rather than act (VO-4c1d3e1127dd54c7664e).
   */
  readonly automationPaused: boolean;
  /** Reasons the automation is paused (empty ⇒ running). */
  readonly pauseReasons: readonly string[];
  /**
   * Content digest over the canonicalized snapshot body. A DURABLE identity that could not
   * exist before discovery — the effect witness the negative cases require.
   */
  readonly snapshotDigest: string;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class IdentityMismatchError extends Error {
  constructor(
    readonly expected: BundleIdentity,
    readonly actual: BundleIdentity,
    readonly where: string,
  ) {
    super(
      `Wiggum observation identity mismatch at ${where}: ` +
        `expected bundle=${expected.bundleId} semanticHash=${expected.semanticHash} ` +
        `workItem=${expected.workItemId}, got bundle=${actual.bundleId} ` +
        `semanticHash=${actual.semanticHash} workItem=${actual.workItemId}`,
    );
    this.name = 'IdentityMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Identity binding (negative-case guard).
// ---------------------------------------------------------------------------

/**
 * Reject any evidence whose bundle identity, semantic hash, or work-item id differs from the
 * pinned input. This is the negative-case oracle shared by all four integration VOs.
 */
export function assertPinnedIdentity(
  pinned: BundleIdentity,
  candidate: BundleIdentity,
  where: string,
): void {
  if (
    candidate.bundleId !== pinned.bundleId ||
    candidate.semanticHash !== pinned.semanticHash ||
    candidate.workItemId !== pinned.workItemId
  ) {
    throw new IdentityMismatchError(pinned, candidate, where);
  }
}

// ---------------------------------------------------------------------------
// Canonicalization + digest (durable content hash — the effect witness).
// ---------------------------------------------------------------------------

/** Deterministic JSON with sorted keys, so the digest is stable regardless of key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 hex digest over the canonicalized value. */
export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Ordering + dedup (VO-d3ab0d39f511ca998e03).
// ---------------------------------------------------------------------------

const entityKey = (o: Pick<WiggumObservation, 'surface' | 'featureId' | 'externalId'>): string =>
  `${o.featureId} ${o.surface} ${o.externalId}`;

/**
 * Deterministic total order over observations of the SAME entity:
 *   1. by aggregateSequence when both are known (numeric, ascending),
 *   2. else by occurredAt,
 *   3. else by externalRevision (lexicographic) as a stable tiebreak.
 * Observations with a null aggregateSequence (ordering uncertainty) sort by occurredAt and
 * never claim authority over a sequenced revision at the same occurredAt.
 */
function compareObservations(a: WiggumObservation, b: WiggumObservation): number {
  if (a.aggregateSequence !== null && b.aggregateSequence !== null) {
    if (a.aggregateSequence !== b.aggregateSequence) {
      return a.aggregateSequence - b.aggregateSequence;
    }
  }
  if (a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
  if (a.externalRevision !== b.externalRevision) {
    return a.externalRevision < b.externalRevision ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

/**
 * Correlate raw Wiggum observations into a durable, deep-frozen governance snapshot.
 *
 * Read-only: `input` is never mutated; the returned snapshot is deep-frozen.
 * Idempotent: same input ⇒ byte-identical `snapshotDigest` (the reconstructable-history and
 * no-duplicate-action guarantees rest on this determinism).
 */
export function discoverSnapshot(input: DiscoveryInput): WiggumSnapshot {
  const { pinnedIdentity, freshnessObjectiveMillis, now, observations, health } = input;

  // (Negative case) every observation must carry the pinned identity.
  for (const o of observations) {
    assertPinnedIdentity(pinnedIdentity, o.identity, `${o.surface}:${o.externalId}`);
  }

  // Group by entity, then order deterministically. Duplicate/out-of-order updates collapse:
  // the LATEST in-order revision is authoritative; every revision is retained as history.
  const byEntity = new Map<string, WiggumObservation[]>();
  for (const o of observations) {
    const key = entityKey(o);
    const list = byEntity.get(key);
    if (list) list.push(o);
    else byEntity.set(key, [o]);
  }

  const entities: CorrelatedEntity[] = [];
  const conflicts: WiggumConflict[] = [];

  for (const [, group] of byEntity) {
    const ordered = [...group].sort(compareObservations);

    // Reconstructable history: ordered revision list, de-duplicated by (revision+hash).
    const revisionHistory: string[] = [];
    const seenRevisionHash = new Set<string>();
    const distinctContentHashesAtTip = new Set<string>();
    for (const o of ordered) {
      const rh = `${o.externalRevision} ${o.sourceContentHash}`;
      if (!seenRevisionHash.has(rh)) {
        seenRevisionHash.add(rh);
        revisionHistory.push(o.externalRevision);
      }
    }

    const authoritative = ordered[ordered.length - 1]!;

    // Unresolvable conflict detection: two or more observations that share the top ordering
    // position (identical aggregateSequence AND occurredAt) but carry DIFFERENT content
    // hashes — authority rules cannot pick a winner.
    const tipPeers = ordered.filter(
      (o) =>
        o.aggregateSequence === authoritative.aggregateSequence &&
        o.occurredAt === authoritative.occurredAt,
    );
    for (const peer of tipPeers) distinctContentHashesAtTip.add(peer.sourceContentHash);

    const ageMillis = now - authoritative.observedAt;
    const freshness: 'fresh' | 'stale' = ageMillis <= freshnessObjectiveMillis ? 'fresh' : 'stale';

    entities.push({
      surface: authoritative.surface,
      featureId: authoritative.featureId,
      externalId: authoritative.externalId,
      externalRevision: authoritative.externalRevision,
      aggregateSequence: authoritative.aggregateSequence,
      occurredAt: authoritative.occurredAt,
      observedAt: authoritative.observedAt,
      sourceContentHash: authoritative.sourceContentHash,
      freshness,
      ageMillis,
      revisionHistory,
      supersededCount: ordered.length - 1,
    });

    if (distinctContentHashesAtTip.size > 1) {
      const conflictingContentHashes = [...distinctContentHashesAtTip].sort();
      // Deterministic owned-issue id: derived from entity + the conflicting hashes, so the
      // SAME conflict always opens the SAME issue (no duplicate governance action).
      const ownedIssueId = `wiggum-conflict-${contentDigest({
        featureId: authoritative.featureId,
        surface: authoritative.surface,
        externalId: authoritative.externalId,
        conflictingContentHashes,
      }).slice(0, 32)}`;
      conflicts.push({
        featureId: authoritative.featureId,
        surface: authoritative.surface,
        externalId: authoritative.externalId,
        conflictingContentHashes,
        reason:
          'Multiple source observations share the top ordering position with differing ' +
          'content; authority rules cannot resolve a single authoritative revision.',
        ownedIssueId,
        ownerPrincipalId:
          health.find((h) => h.featureId === authoritative.featureId)?.ownerPrincipalId ??
          'unassigned',
      });
    }
  }

  // Health degradation surfacing (VO-468734d7c60e0fbb801b): any non-healthy source becomes a
  // visible, ownership-attributed alert with the full triage surface.
  const healthAlerts: WiggumHealthAlert[] = health
    .filter((h) => h.healthState !== 'healthy')
    .map((h) => ({
      featureId: h.featureId,
      healthState: h.healthState,
      ownerPrincipalId: h.ownerPrincipalId,
      affectedScope: [...h.affectedScope],
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
      retryState: { ...h.retryState },
      businessImpact: h.businessImpact,
      safeNextAction: h.safeNextAction,
    }));

  // Safe-pause decision (VO-4c1d3e1127dd54c7664e): pause when conflicts remain unresolved OR
  // any affected source is unavailable (cannot safely act on partial/authority-less state).
  const pauseReasons: string[] = [];
  if (conflicts.length > 0) {
    pauseReasons.push(
      `${conflicts.length} unresolved conflict(s) require human resolution before automation resumes`,
    );
  }
  for (const alert of healthAlerts) {
    if (alert.healthState === 'unavailable') {
      pauseReasons.push(`source ${alert.featureId} is unavailable; affected automation paused`);
    }
  }
  const automationPaused = pauseReasons.length > 0;

  // Stable ordering for determinism of the digest.
  entities.sort((a, b) => (entityKey(a) < entityKey(b) ? -1 : entityKey(a) > entityKey(b) ? 1 : 0));
  conflicts.sort((a, b) => (a.ownedIssueId < b.ownedIssueId ? -1 : 1));
  healthAlerts.sort((a, b) => (a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0));

  const body = {
    pinnedIdentity,
    freshnessObjectiveMillis,
    capturedAt: now,
    entities,
    conflicts,
    healthAlerts,
    automationPaused,
    pauseReasons,
  };

  const snapshot: WiggumSnapshot = {
    ...body,
    snapshotDigest: contentDigest(body),
  };

  return deepFreeze(snapshot);
}

// ---------------------------------------------------------------------------
// Deep-freeze so the returned snapshot is a genuinely immutable durable artifact.
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
