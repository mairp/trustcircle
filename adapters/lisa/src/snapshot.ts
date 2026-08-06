// @trustcircle/adapter-lisa — read-only LISA governance-state snapshot discovery
// (task T259 / US6 / GAR-* discovery).
//
// Discovers LISA jobs, phases, attempts, plan revisions, verdicts, budgets, schedules,
// checkpoints, locks, and outcomes *without changing them*, and correlates them — WITH source
// provenance — into a governance-facing snapshot. LISA is an on-demand component: this module
// makes no assumption that LISA is running; it normalizes whatever raw observations a caller
// has already collected.
//
// Effect-witness discipline (mirroring the Wiggum snapshot exemplar): the value this module
// returns is a DURABLE, independently readable artifact — a deep-frozen snapshot carrying a
// content digest (`snapshotDigest`) that could not exist before discovery, plus the pinned
// deployment identity. A caller verifies the effect through the returned snapshot's digest and
// identity, never by trusting a mutation response. Evidence whose deployment identity differs
// from the pinned input is REJECTED (`assertPinnedIdentity`).
//
// Dependency-free (Node built-in `crypto` only) and PURE: no I/O, no wall clock (`now` is
// injected), no randomness. Callers pass an already-collected set of raw observations (the
// operations/health surfaces own the actual reads); this module normalizes, correlates,
// deduplicates, and freezes them. CONNECTOR NEVER HOLDS GOVERNANCE AUTHORITY — this module only
// observes.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Pinned deployment identity (repository / deployment / workspace scope).
// ---------------------------------------------------------------------------

/** Identity that every discovered observation must carry, matching the pinned LISA deployment. */
export interface LisaDeploymentIdentity {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly workspaceId: string;
}

/** Freshness objective: max age (ms) a source observation may have and still be "fresh". */
export type FreshnessObjectiveMillis = number;

// ---------------------------------------------------------------------------
// Raw LISA observations (the surfaces the phase enumerates). All read-only.
// ---------------------------------------------------------------------------

export type LisaSurface =
  | 'job'
  | 'phase'
  | 'attempt'
  | 'plan-revision'
  | 'verdict'
  | 'budget'
  | 'schedule'
  | 'checkpoint'
  | 'lock'
  | 'outcome';

export type LisaHealthState = 'healthy' | 'degraded' | 'unavailable' | 'inactive';

/**
 * A single raw observation read from a LISA surface. `externalRevision` + `aggregateSequence`
 * give ordering; `observedAt` gives freshness. `sourceContentHash` is the source's own integrity
 * anchor over the payload (used to detect duplicates that arrive with a different revision but
 * identical content). `sourceProvenance` records where the observation was read from so the
 * governance view keeps source provenance for every correlated entity.
 */
export interface LisaObservation {
  readonly surface: LisaSurface;
  /** LISA job the observation belongs to (job-isolation boundary). */
  readonly jobId: string;
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
  /** Where this observation was read from (persistence surface, cursor, or feed). */
  readonly sourceProvenance: string;
  /** Deployment identity the source stamped on this observation. */
  readonly identity: LisaDeploymentIdentity;
  /** Opaque, already-normalized payload. Treated as immutable data. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Health expectation report for a LISA surface/job. */
export interface LisaHealthReport {
  readonly jobId: string;
  readonly healthState: LisaHealthState;
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
  readonly pinnedIdentity: LisaDeploymentIdentity;
  readonly freshnessObjectiveMillis: FreshnessObjectiveMillis;
  readonly now: number;
  readonly observations: readonly LisaObservation[];
  readonly health: readonly LisaHealthReport[];
}

// ---------------------------------------------------------------------------
// Snapshot output (the durable, independently readable effect witness).
// ---------------------------------------------------------------------------

export interface CorrelatedEntity {
  readonly surface: LisaSurface;
  readonly jobId: string;
  readonly externalId: string;
  /** The authoritative (latest, in-order) revision retained for this entity. */
  readonly externalRevision: string;
  readonly aggregateSequence: number | null;
  readonly occurredAt: number;
  readonly observedAt: number;
  readonly sourceContentHash: string;
  /** Where the authoritative revision was read from (source provenance preserved). */
  readonly sourceProvenance: string;
  /** Freshness relative to the objective, computed from observedAt vs now. */
  readonly freshness: 'fresh' | 'stale';
  readonly ageMillis: number;
  /** Every revision seen for this entity (ordered) — history stays reconstructable. */
  readonly revisionHistory: readonly string[];
  /** Count of superseded/duplicate observations collapsed into this entity. */
  readonly supersededCount: number;
}

/** An unresolved conflict that pauses affected automation and needs a human. */
export interface LisaConflict {
  readonly jobId: string;
  readonly surface: LisaSurface;
  readonly externalId: string;
  /** The distinct source content hashes that could not be authority-resolved. */
  readonly conflictingContentHashes: readonly string[];
  readonly reason: string;
  /** Stable, deterministic id of the owned issue opened for human resolution. */
  readonly ownedIssueId: string;
  readonly ownerPrincipalId: string;
}

export interface LisaHealthAlert {
  readonly jobId: string;
  readonly healthState: LisaHealthState;
  readonly ownerPrincipalId: string;
  readonly affectedScope: readonly string[];
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly retryState: LisaHealthReport['retryState'];
  readonly businessImpact: string;
  readonly safeNextAction: string;
}

export interface LisaSnapshot {
  readonly pinnedIdentity: LisaDeploymentIdentity;
  readonly freshnessObjectiveMillis: FreshnessObjectiveMillis;
  readonly capturedAt: number;
  readonly entities: readonly CorrelatedEntity[];
  readonly conflicts: readonly LisaConflict[];
  readonly healthAlerts: readonly LisaHealthAlert[];
  /**
   * True when at least one unresolvable conflict or a non-healthy source means the governance
   * automation must pause safely rather than act. `inactive` alone never pauses — LISA is an
   * on-demand component and being intentionally inactive is expected, not a fault.
   */
  readonly automationPaused: boolean;
  /** Reasons the automation is paused (empty ⇒ running). */
  readonly pauseReasons: readonly string[];
  /**
   * Content digest over the canonicalized snapshot body. A DURABLE identity that could not exist
   * before discovery — the effect witness the negative cases require.
   */
  readonly snapshotDigest: string;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class IdentityMismatchError extends Error {
  constructor(
    readonly expected: LisaDeploymentIdentity,
    readonly actual: LisaDeploymentIdentity,
    readonly where: string,
  ) {
    super(
      `LISA observation identity mismatch at ${where}: ` +
        `expected repository=${expected.repositoryId} deployment=${expected.deploymentId} ` +
        `workspace=${expected.workspaceId}, got repository=${actual.repositoryId} ` +
        `deployment=${actual.deploymentId} workspace=${actual.workspaceId}`,
    );
    this.name = 'IdentityMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Identity binding (negative-case guard).
// ---------------------------------------------------------------------------

/**
 * Reject any evidence whose repository, deployment, or workspace id differs from the pinned
 * input. Fail-visible: a mismatched observation never enters the correlated view.
 */
export function assertPinnedIdentity(
  pinned: LisaDeploymentIdentity,
  candidate: LisaDeploymentIdentity,
  where: string,
): void {
  if (
    candidate.repositoryId !== pinned.repositoryId ||
    candidate.deploymentId !== pinned.deploymentId ||
    candidate.workspaceId !== pinned.workspaceId
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
// Ordering + dedup.
// ---------------------------------------------------------------------------

const entityKey = (o: Pick<LisaObservation, 'surface' | 'jobId' | 'externalId'>): string =>
  `${o.jobId} ${o.surface} ${o.externalId}`;

/**
 * Deterministic total order over observations of the SAME entity:
 *   1. by aggregateSequence when both are known (numeric, ascending),
 *   2. else by occurredAt,
 *   3. else by externalRevision (lexicographic) as a stable tiebreak.
 * Observations with a null aggregateSequence (ordering uncertainty) sort by occurredAt and never
 * claim authority over a sequenced revision at the same occurredAt.
 */
function compareObservations(a: LisaObservation, b: LisaObservation): number {
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
 * Correlate raw LISA observations into a durable, deep-frozen governance snapshot.
 *
 * Read-only: `input` is never mutated; the returned snapshot is deep-frozen.
 * Idempotent: same input ⇒ byte-identical `snapshotDigest`.
 */
export function discoverSnapshot(input: DiscoveryInput): LisaSnapshot {
  const { pinnedIdentity, freshnessObjectiveMillis, now, observations, health } = input;

  // (Negative case) every observation must carry the pinned identity.
  for (const o of observations) {
    assertPinnedIdentity(pinnedIdentity, o.identity, `${o.surface}:${o.externalId}`);
  }

  // Group by entity, then order deterministically. Duplicate/out-of-order updates collapse: the
  // LATEST in-order revision is authoritative; every revision is retained as history.
  const byEntity = new Map<string, LisaObservation[]>();
  for (const o of observations) {
    const key = entityKey(o);
    const list = byEntity.get(key);
    if (list) list.push(o);
    else byEntity.set(key, [o]);
  }

  const entities: CorrelatedEntity[] = [];
  const conflicts: LisaConflict[] = [];

  for (const [, group] of byEntity) {
    const ordered = [...group].sort(compareObservations);

    // Reconstructable history: ordered revision list, de-duplicated by (revision+hash).
    const revisionHistory: string[] = [];
    const seenRevisionHash = new Set<string>();
    const distinctContentHashesAtTip = new Set<string>();
    for (const o of ordered) {
      const rh = `${o.externalRevision} ${o.sourceContentHash}`;
      if (!seenRevisionHash.has(rh)) {
        seenRevisionHash.add(rh);
        revisionHistory.push(o.externalRevision);
      }
    }

    const authoritative = ordered[ordered.length - 1]!;

    // Unresolvable conflict detection: two or more observations that share the top ordering
    // position (identical aggregateSequence AND occurredAt) but carry DIFFERENT content hashes.
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
      jobId: authoritative.jobId,
      externalId: authoritative.externalId,
      externalRevision: authoritative.externalRevision,
      aggregateSequence: authoritative.aggregateSequence,
      occurredAt: authoritative.occurredAt,
      observedAt: authoritative.observedAt,
      sourceContentHash: authoritative.sourceContentHash,
      sourceProvenance: authoritative.sourceProvenance,
      freshness,
      ageMillis,
      revisionHistory,
      supersededCount: ordered.length - 1,
    });

    if (distinctContentHashesAtTip.size > 1) {
      const conflictingContentHashes = [...distinctContentHashesAtTip].sort();
      // Deterministic owned-issue id: derived from entity + the conflicting hashes, so the SAME
      // conflict always opens the SAME issue (no duplicate governance action).
      const ownedIssueId = `lisa-conflict-${contentDigest({
        jobId: authoritative.jobId,
        surface: authoritative.surface,
        externalId: authoritative.externalId,
        conflictingContentHashes,
      }).slice(0, 32)}`;
      conflicts.push({
        jobId: authoritative.jobId,
        surface: authoritative.surface,
        externalId: authoritative.externalId,
        conflictingContentHashes,
        reason:
          'Multiple source observations share the top ordering position with differing content; ' +
          'authority rules cannot resolve a single authoritative revision.',
        ownedIssueId,
        ownerPrincipalId:
          health.find((h) => h.jobId === authoritative.jobId)?.ownerPrincipalId ?? 'unassigned',
      });
    }
  }

  // Health degradation surfacing: any non-healthy, non-inactive source becomes a visible,
  // ownership-attributed alert. `inactive` is reported (LISA is on-demand) but never pauses.
  const healthAlerts: LisaHealthAlert[] = health
    .filter((h) => h.healthState !== 'healthy')
    .map((h) => ({
      jobId: h.jobId,
      healthState: h.healthState,
      ownerPrincipalId: h.ownerPrincipalId,
      affectedScope: [...h.affectedScope],
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
      retryState: { ...h.retryState },
      businessImpact: h.businessImpact,
      safeNextAction: h.safeNextAction,
    }));

  // Safe-pause decision: pause when conflicts remain unresolved OR any affected source is
  // unavailable. `degraded` and `inactive` do not pause on their own.
  const pauseReasons: string[] = [];
  if (conflicts.length > 0) {
    pauseReasons.push(
      `${conflicts.length} unresolved conflict(s) require human resolution before automation resumes`,
    );
  }
  for (const alert of healthAlerts) {
    if (alert.healthState === 'unavailable') {
      pauseReasons.push(`source ${alert.jobId} is unavailable; affected automation paused`);
    }
  }
  const automationPaused = pauseReasons.length > 0;

  // Stable ordering for determinism of the digest.
  entities.sort((a, b) => (entityKey(a) < entityKey(b) ? -1 : entityKey(a) > entityKey(b) ? 1 : 0));
  conflicts.sort((a, b) => (a.ownedIssueId < b.ownedIssueId ? -1 : 1));
  healthAlerts.sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));

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

  const snapshot: LisaSnapshot = {
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
