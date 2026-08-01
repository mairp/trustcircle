// @trustcircle/projector — governed projection-worker bootstrap, durable cursors, rebuild mode,
// and stale-state signaling (Phase 48 / work item T2KV3HBNG3BGWSEXZ58RXEHQ3T /
// VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// This is the *entry point* that turns the durable INBOX CONSUMER (./inbox-consumer.ts, Phase 28)
// into a governed long-running PROJECTION worker. The command-worker (Phase 47) governs the
// PRODUCER side of the outbox; this is the CONSUMER/READ-MODEL side. Where the command-worker
// drains the outbox onto the bus, the projector drains the bus (through the durable inbox) INTO
// the read model that the governance current-state views (inventory, decision queue, controllers)
// are served from.
//
// The phase-primary acceptance oracle (VO-6acaf6470d0810df4c93 / VO-53a014009bdfebd7af13 / the
// phase spec) requires that the platform's
//
//   * open-ended source catalog + reconciled inventory + coverage gaps  (what the read model holds)
//   * workflow and controller state,
//   * ownership (who holds the projection run),
//   * health,
//   * failures,
//   * retries,
//   * continuity mode and lease,
//   * buffered evidence, and
//   * safe next actions
//
// MUST be *current* and *fail-visible*. For a read model served asynchronously, "current" has a
// concrete meaning the command-worker did not have to face: the projection can silently LAG the
// authoritative source. A governance officer looking at a stale board must NOT be told it is
// healthy. So this worker adds, on top of the Phase-47 governed-worker skeleton, the two things a
// projection worker specifically owns:
//
//   A. DURABLE CURSORS. The applied position is not an in-memory offset — it is the durable
//      inbox_cursor (per tenant/consumer/stream) that the InboxConsumer advances monotonically,
//      PLUS a durable projector_checkpoint that resumes the run. A restart RESUMES from the
//      durable cursor/checkpoint rather than re-applying or losing its place. `readInboxCursor`
//      is the independent read path that proves the applied position (never the return value).
//
//   B. REBUILD MODE. A read model can be corrupted, schema-migrated, or need a fresh backfill.
//      Rebuild mode drains the read model to a known reset point and REPLAYS from the source,
//      tracked durably (rebuild id + phase + progress) and always fail-visible — a rebuild in
//      flight is NEVER reported as a healthy live projection, and a rebuild that cannot complete
//      leaves the projection visibly degraded rather than half-applied-looking-current.
//
//   C. STALE-STATE SIGNALING. The worker tracks, per source stream, the last time an authoritative
//      change was applied and how far the applied cursor lags the highest observed source
//      position. When the lag exceeds the freshness objective (in items or in time) the affected
//      projection is flagged STALE with its last-known time — the fail-visible signal that
//      "current compliance or health is not inferred from stale data".
//
// It reuses the Phase-47 governed skeleton (bootstrap fail-closed, fenced time-bounded lease,
// resumable checkpoint, safe shutdown, evidence buffer) — re-expressed here self-contained so the
// projector package depends only on @trustcircle/persistence + @trustcircle/application + its own
// inbox-consumer, never on the command-worker package.
//
// ---------------------------------------------------------------------------
// DESIGN CONSTRAINTS
// ---------------------------------------------------------------------------
// * Dependency-free at runtime except Node built-ins + the already-in-workspace persistence /
//   application / inbox-consumer surfaces. Runs under Node 22 `--experimental-strip-types`.
// * Deterministic and injectable: clock, sleeper, environment, process-signal surface, the bus
//   pull-source, and the read-model sink are ALL injected, so the whole lifecycle is unit-testable
//   with no wall clock, no real signals, and no live PostgreSQL or broker.
// * Fail-closed / fail-visible: every ambiguous state (config error, lost lease, unflushed
//   evidence, apply throw, rebuild abort, stale projection) resolves to *stop governed action +
//   surface a safe next action + mark the durable status*, never to an optimistic "current".

import { Database, type Clock, type EpochMillis } from '@trustcircle/persistence';
import {
  parseEnvironment,
  type AppEnvironment,
  type EnvironmentIssue,
  type RawEnvironment,
} from '@trustcircle/application';
import {
  InboxConsumer,
  readInboxCursor,
  type ConsumeResult,
  type ConsumeDisposition,
  type ApplyProjection,
  type UnsafeActionGuard,
} from './inbox-consumer.ts';

// ===========================================================================
// 0. Small injected primitives (deterministic testability)
// ===========================================================================

/** A cancellable sleeper. Injected so tests advance time without a real timer. */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The minimal process-signal surface the worker binds to (injected in tests). */
export interface SignalSource {
  once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  removeListener(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
}

/** Default real sleeper — resolves after `ms`, or early if the signal aborts. */
export const realSleeper: Sleeper = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

// ===========================================================================
// 1. Governed projector states (fail-visible vocabulary)
// ===========================================================================

/**
 * The projector's controller/workflow lifecycle state. Every value is a state an operator can SEE
 * in the status snapshot; there is no hidden state. `degraded`, `stale`, and `lost_lease` are
 * fail-visible non-clean states distinct from a clean `stopped`.
 */
export const PROJECTOR_STATES = [
  'starting', // bootstrapping — config parsed, lease not yet held
  'acquiring_lease', // contending for ownership
  'running', // owns the lease, projecting live
  'rebuilding', // owns the lease, replaying the read model from a reset point (not live-current)
  'draining', // shutdown requested; finishing the in-flight pass safely
  'stopped', // clean, fully-reconciled exit
  'degraded', // exited/parked with an unresolved condition (fail-visible)
  'stale', // projection lags the freshness objective (fail-visible; not "healthy")
  'lost_lease', // ownership lost mid-run (fail-closed; must reconcile)
  'failed', // bootstrap or fatal error before/while running (fail-visible)
] as const;
export type ProjectorState = (typeof PROJECTOR_STATES)[number];

/**
 * Continuity mode mirrors the platform continuity contract (FR-046..FR-050): while a valid lease
 * covers the current step the worker may `continue` and buffer evidence; otherwise it must `pause`
 * at a safe checkpoint and require reconciliation.
 */
export const CONTINUITY_MODES = ['normal', 'continue_under_lease', 'paused'] as const;
export type ContinuityMode = (typeof CONTINUITY_MODES)[number];

/** The single safe next action an operator/automation should take given the current state. */
export const SAFE_NEXT_ACTIONS = ['none', 'retry', 'reconcile', 'rebuild', 'escalate'] as const;
export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

/**
 * Freshness classification of the projection relative to the authoritative source, per the
 * freshness objective. `fresh` — applied position is within the objective; `stale` — the applied
 * position lags the source beyond the objective (by items or by time); `unknown` — no source
 * position has been observed yet (cannot claim fresh, must not claim healthy either).
 */
export const FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type Freshness = (typeof FRESHNESS)[number];

/** Terminal states — no further governed action happens after these. */
const TERMINAL_STATES: ReadonlySet<ProjectorState> = new Set<ProjectorState>([
  'stopped',
  'degraded',
  'lost_lease',
  'failed',
]);
export function isTerminalState(s: ProjectorState): boolean {
  return TERMINAL_STATES.has(s);
}

// ===========================================================================
// 2. Lease ownership — exactly-one-owner, fenced, time-bounded
// ===========================================================================
//
// Mirrors the command-worker lease exactly (a fenced, time-bounded row serialized by a Postgres
// session advisory lock), namespaced under "projector-lease:<resource>" so a projector lease can
// never collide with the command-worker "worker-lease:<resource>" lock or the per-aggregate inbox
// lock. Exactly one projector instance may apply to the read model at a time — split-brain would
// double-apply the same event stream.

/** An acquired ownership lease. Immutable once granted; renewal produces a new snapshot. */
export interface LeaseGrant {
  readonly resource: string;
  readonly holder: string;
  /** Monotonic fencing token — strictly increases across acquisitions of the same resource. */
  readonly fencingToken: number;
  readonly acquiredAt: EpochMillis;
  readonly expiresAt: EpochMillis;
}

/** Thrown when a worker attempts a governed action without a live lease (fail-closed). */
export class LeaseLostError extends Error {
  readonly resource: string;
  constructor(resource: string, detail: string) {
    super(`projector lease for "${resource}" is not live: ${detail}`);
    this.name = 'LeaseLostError';
    this.resource = resource;
  }
}

/** The durable lease row shape (mirrors db/migrations projector_lease). */
export interface StoredLease {
  readonly resource: string;
  readonly holder: string | null;
  readonly fencingToken: number;
  readonly expiresAt: EpochMillis | null;
  readonly updatedAt: EpochMillis;
}

/** The minimal session a LeaseStore executes against (satisfied by SqlSession). */
export interface LeaseSession {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

/**
 * The durable lease persistence seam. Implementations MUST be linearizable under the caller-held
 * advisory lock (production: SQL against projector_lease; tests: an in-memory Map).
 */
export interface LeaseStore {
  read(session: LeaseSession, resource: string): Promise<StoredLease | null>;
  write(session: LeaseSession, lease: StoredLease): Promise<void>;
  clear(
    session: LeaseSession,
    resource: string,
    holder: string,
    fencingToken: number,
  ): Promise<boolean>;
}

export interface ProjectorLeaseOptions {
  readonly db: Database;
  readonly store: LeaseStore;
  readonly resource: string;
  readonly holder: string;
  readonly clock: Clock;
  /** Lease TTL in ms — ownership expires this long after each acquire/renew. */
  readonly ttlMs: number;
}

export class ProjectorLease {
  readonly #db: Database;
  readonly #store: LeaseStore;
  readonly #resource: string;
  readonly #holder: string;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #grant: LeaseGrant | null = null;

  constructor(opts: ProjectorLeaseOptions) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new RangeError('lease ttlMs must be a positive finite number');
    }
    if (!opts.resource) throw new Error('lease resource is required');
    if (!opts.holder) throw new Error('lease holder is required');
    this.#db = opts.db;
    this.#store = opts.store;
    this.#resource = opts.resource;
    this.#holder = opts.holder;
    this.#clock = opts.clock;
    this.#ttlMs = opts.ttlMs;
  }

  get holder(): string {
    return this.#holder;
  }
  get resource(): string {
    return this.#resource;
  }
  get grant(): LeaseGrant | null {
    return this.#grant;
  }

  /** Pure: is the current grant live at `now`? False when unheld or expired. */
  isLive(now: EpochMillis = this.#clock()): boolean {
    return this.#grant != null && this.#grant.expiresAt > now;
  }

  /** Contend for ownership. Returns the grant, or null if another holder owns a still-live lease. */
  async tryAcquire(): Promise<LeaseGrant | null> {
    return this.#db.withAdvisoryLock(this.#leaseLockKey(), async (session) => {
      const now = this.#clock();
      const existing = await this.#store.read(session, this.#resource);
      const someoneElseLive =
        existing != null &&
        existing.holder != null &&
        existing.holder !== this.#holder &&
        existing.expiresAt != null &&
        existing.expiresAt > now;
      if (someoneElseLive) return null; // another projector owns a live lease — do not steal

      const nextToken = (existing?.fencingToken ?? 0) + 1;
      const grant: LeaseGrant = {
        resource: this.#resource,
        holder: this.#holder,
        fencingToken: nextToken,
        acquiredAt: now,
        expiresAt: now + this.#ttlMs,
      };
      await this.#store.write(session, {
        resource: this.#resource,
        holder: this.#holder,
        fencingToken: nextToken,
        expiresAt: grant.expiresAt,
        updatedAt: now,
      });
      this.#grant = grant;
      return grant;
    });
  }

  /**
   * Extend the lease. Succeeds ONLY if this holder + fencing token still own the durable row. On
   * any mismatch (stolen lease, cleared row) the in-memory grant is dropped and false returned —
   * the caller MUST then treat ownership as lost (fail-closed).
   */
  async renew(): Promise<boolean> {
    if (this.#grant == null) return false;
    return this.#db.withAdvisoryLock(this.#leaseLockKey(), async (session) => {
      const now = this.#clock();
      const existing = await this.#store.read(session, this.#resource);
      const stillOurs =
        existing != null &&
        existing.holder === this.#holder &&
        existing.fencingToken === this.#grant!.fencingToken;
      if (!stillOurs) {
        this.#grant = null;
        return false;
      }
      const renewed: LeaseGrant = { ...this.#grant!, expiresAt: now + this.#ttlMs };
      await this.#store.write(session, {
        resource: this.#resource,
        holder: this.#holder,
        fencingToken: this.#grant!.fencingToken,
        expiresAt: renewed.expiresAt,
        updatedAt: now,
      });
      this.#grant = renewed;
      return true;
    });
  }

  /** Release ownership (best-effort, fenced). Safe to call when not held. */
  async release(): Promise<void> {
    const grant = this.#grant;
    this.#grant = null;
    if (grant == null) return;
    await this.#db.withAdvisoryLock(this.#leaseLockKey(), async (session) => {
      await this.#store.clear(session, this.#resource, this.#holder, grant.fencingToken);
    });
  }

  /** Read the durable lease row via the INDEPENDENT read path (no in-memory trust). */
  async readDurable(): Promise<StoredLease | null> {
    return this.#db.withAdvisoryLock(this.#leaseLockKey(), (session) =>
      this.#store.read(session, this.#resource),
    );
  }

  /** Assert a live lease or throw LeaseLostError — the fail-closed guard for governed actions. */
  assertLive(now: EpochMillis = this.#clock()): LeaseGrant {
    if (!this.isLive(now)) {
      throw new LeaseLostError(this.#resource, this.#grant == null ? 'not held' : 'expired');
    }
    return this.#grant!;
  }

  #leaseLockKey(): string {
    return `projector-lease:${this.#resource}`;
  }
}

// ===========================================================================
// 3. Source-position tracking + stale-state signaling (freshness objective)
// ===========================================================================

/**
 * The highest source position the worker has OBSERVED for a stream (e.g. the bus sequence /
 * high-water mark reported by the pull source), and the time it was observed. This is the
 * denominator of the freshness comparison — how far ahead the authoritative source is.
 */
export interface SourcePosition {
  readonly stream: string;
  /** Highest source sequence observed (monotonic; 0 when unknown). */
  readonly observedSeq: number;
  readonly observedAt: EpochMillis;
}

/** How the freshness objective is expressed. Either bound (or both) triggers `stale`. */
export interface FreshnessObjective {
  /** Max items the applied cursor may lag the observed source before `stale`. Default 0. */
  readonly maxLagItems: number;
  /** Max ms since the last applied change before `stale` (staleness by time). Default 60_000. */
  readonly maxAgeMs: number;
}

export const DEFAULT_FRESHNESS_OBJECTIVE: FreshnessObjective = {
  maxLagItems: 0,
  maxAgeMs: 60_000,
};

/** The per-stream freshness assessment surfaced in the status (fail-visible staleness). */
export interface StreamFreshness {
  readonly stream: string;
  readonly freshness: Freshness;
  /** Applied cursor sequence (durable inbox_cursor.cursor_seq), null if never advanced. */
  readonly appliedSeq: number | null;
  /** Highest observed source sequence, null if never observed. */
  readonly observedSeq: number | null;
  /** observedSeq - appliedSeq, clamped at 0; null if either side unknown. */
  readonly lagItems: number | null;
  /** Wall-clock ms since the last applied change; null if nothing applied yet. */
  readonly ageMs: number | null;
  /** Time of the last applied change (last-known time), null if nothing applied. */
  readonly lastAppliedAt: EpochMillis | null;
}

/**
 * The pure staleness decision. It is TOTAL and non-throwing: given the applied position, the
 * observed source position, the last-apply time, and the objective, it returns `fresh` / `stale`
 * / `unknown` with the concrete lag + age. `unknown` (no source observed yet) is NEVER silently
 * treated as fresh — the caller must not infer health from it.
 */
export function assessFreshness(
  stream: string,
  appliedSeq: number | null,
  lastAppliedAt: EpochMillis | null,
  source: SourcePosition | null,
  now: EpochMillis,
  objective: FreshnessObjective,
): StreamFreshness {
  const observedSeq = source ? source.observedSeq : null;
  const ageMs = lastAppliedAt == null ? null : Math.max(0, now - lastAppliedAt);
  const lagItems = observedSeq == null ? null : Math.max(0, observedSeq - (appliedSeq ?? 0));

  let freshness: Freshness;
  if (observedSeq == null) {
    // No authoritative source position observed → cannot claim freshness.
    freshness = 'unknown';
  } else {
    const lagStale = lagItems != null && lagItems > objective.maxLagItems;
    const ageStale = ageMs != null && ageMs > objective.maxAgeMs;
    freshness = lagStale || ageStale ? 'stale' : 'fresh';
  }
  return { stream, freshness, appliedSeq, observedSeq, lagItems, ageMs, lastAppliedAt };
}

// ===========================================================================
// 4. Rebuild mode — reset-to-checkpoint + replay, durably tracked & fail-visible
// ===========================================================================

export const REBUILD_PHASES = [
  'idle',
  'resetting',
  'replaying',
  'verifying',
  'completed',
  'failed',
] as const;
export type RebuildPhase = (typeof REBUILD_PHASES)[number];

/**
 * A durable rebuild request/progress record. A rebuild drains the read model to a reset point and
 * REPLAYS the source stream, tracked here so a rebuild in flight is visible and RESUMABLE and is
 * never mistaken for a healthy live projection.
 */
export interface RebuildState {
  /** Stable rebuild identity (a run id), null when no rebuild is active/requested. */
  readonly rebuildId: string | null;
  readonly phase: RebuildPhase;
  /** Events replayed so far in this rebuild. */
  readonly replayed: number;
  /** Reason/trigger the rebuild was requested (retained for audit). */
  readonly reason: string | null;
  readonly startedAt: EpochMillis | null;
  readonly updatedAt: EpochMillis | null;
}

export const IDLE_REBUILD: RebuildState = {
  rebuildId: null,
  phase: 'idle',
  replayed: 0,
  reason: null,
  startedAt: null,
  updatedAt: null,
};

/**
 * The read-model sink the projector applies against. Production wires the real read-model writer;
 * `reset` truncates/rewinds the projections to the rebuild reset point. Both are injected so
 * rebuild is testable with no live database. `reset` is ONLY ever called inside a rebuild while
 * the lease is held.
 */
export interface ReadModelSink {
  /** Drop/rewind the read model to the rebuild reset point. Returns after the reset is durable. */
  reset(rebuildId: string): Promise<void>;
}

// ===========================================================================
// 5. Buffered evidence — held during continuity, flushed on a safe boundary
// ===========================================================================

/** One piece of evidence buffered while a connector/step is degraded (FR-050 continuity). */
export interface BufferedEvidenceRecord {
  readonly kind: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly bufferedAt: EpochMillis;
}

/**
 * An append-only buffer that holds evidence in memory while continuity mode defers durable writes,
 * and flushes it to a durable sink at a safe boundary. `size` is surfaced in the status so
 * unflushed evidence is NEVER invisible; a failed flush leaves the buffer intact and marks the
 * worker degraded (fail-visible).
 */
export class EvidenceBuffer {
  readonly #records: BufferedEvidenceRecord[] = [];
  readonly #sink: (records: readonly BufferedEvidenceRecord[]) => Promise<void>;

  constructor(sink: (records: readonly BufferedEvidenceRecord[]) => Promise<void>) {
    this.#sink = sink;
  }

  get size(): number {
    return this.#records.length;
  }

  buffer(record: BufferedEvidenceRecord): void {
    this.#records.push(record);
  }

  snapshot(): readonly BufferedEvidenceRecord[] {
    return this.#records.map((r) => ({ ...r }));
  }

  async flush(): Promise<boolean> {
    if (this.#records.length === 0) return true;
    const pending = this.#records.slice();
    try {
      await this.#sink(pending);
      this.#records.length = 0;
      return true;
    } catch {
      return false; // retained — fail-visible
    }
  }
}

// ===========================================================================
// 6. Durable checkpoint — resumable, fail-visible projection progress
// ===========================================================================

/**
 * A durable checkpoint of the projector's progress. Written after every pass so a crash resumes
 * from here. It is the reconstructable history AND the fail-visible status source: it carries the
 * cumulative apply/retry/quarantine/dead-letter counters, the last error, the continuity mode, the
 * rebuild state, the per-stream freshness, and the single safe next action.
 */
export interface ProjectorCheckpoint {
  readonly resource: string;
  readonly holder: string;
  readonly fencingToken: number;
  readonly pass: number;
  readonly state: ProjectorState;
  readonly continuity: ContinuityMode;
  readonly totals: {
    readonly consumed: number;
    readonly applied: number;
    readonly buffered: number;
    readonly quarantined: number;
    readonly retried: number;
    readonly deadLettered: number;
  };
  /** Per-stream freshness snapshot (the durable stale-state signal). */
  readonly freshness: readonly StreamFreshness[];
  readonly rebuild: RebuildState;
  readonly bufferedEvidence: number;
  readonly lastError: string | null;
  readonly safeNextAction: SafeNextAction;
  readonly updatedAt: EpochMillis;
}

/** Durable store for the single latest checkpoint per resource. */
export interface CheckpointStore {
  load(resource: string): Promise<ProjectorCheckpoint | null>;
  save(cp: ProjectorCheckpoint): Promise<void>;
}

// ===========================================================================
// 7. The fail-visible status snapshot — the ONE observable surface
// ===========================================================================

/**
 * The complete, current, fail-visible projector status. This single object satisfies the
 * acceptance oracle: workflow/controller state, ownership, health, failures, retries, continuity
 * mode + lease, buffered evidence, per-stream freshness (the stale-state signal), rebuild state,
 * and the safe next action are ALL visible at once. `healthy` is true only when running live with
 * a live lease, no unresolved error, no stale stream, and no active rebuild.
 */
export interface ProjectorStatus {
  readonly resource: string;
  readonly holder: string;
  readonly state: ProjectorState;
  readonly healthy: boolean;
  readonly ownership: {
    readonly owned: boolean;
    readonly fencingToken: number | null;
    readonly leaseExpiresAt: EpochMillis | null;
    readonly leaseLive: boolean;
  };
  readonly continuity: ContinuityMode;
  readonly progress: {
    readonly pass: number;
    readonly consumed: number;
    readonly applied: number;
    readonly buffered: number;
    readonly quarantined: number;
    readonly retried: number;
    readonly deadLettered: number;
  };
  /** Per-stream freshness — the stale-state signal. `stale` here forces healthy=false. */
  readonly freshness: readonly StreamFreshness[];
  /** True iff any tracked stream is stale (or unknown) — the top-level fail-visible flag. */
  readonly stale: boolean;
  readonly rebuild: RebuildState;
  readonly bufferedEvidence: number;
  readonly lastError: string | null;
  readonly safeNextAction: SafeNextAction;
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 8. GovernedProjector — the runtime that ties it all together
// ===========================================================================

/** A single delivered raw event pulled from the bus (opaque to the worker — the consumer validates). */
export type PulledEvent = unknown;

/**
 * The bus pull-source. `pull(max)` returns up to `max` raw events plus the highest source
 * sequence observed (the freshness denominator). Production wires a JetStream pull consumer; tests
 * wire a scripted in-memory source. When the source is unavailable the pull throws — a transient
 * failure the worker handles fail-closed (never claims fresh from a failed pull).
 */
export interface BusPullSource {
  pull(
    max: number,
    signal?: AbortSignal,
  ): Promise<{ events: readonly PulledEvent[]; observedSeq: number }>;
}

export interface GovernedProjectorOptions {
  readonly db: Database;
  readonly consumer: InboxConsumer;
  readonly source: BusPullSource;
  readonly lease: ProjectorLease;
  readonly checkpoints: CheckpointStore;
  readonly evidence: EvidenceBuffer;
  readonly readModel: ReadModelSink;
  readonly clock: Clock;
  readonly sleep?: Sleeper;
  /** The consumer name the durable cursor is keyed under (must match the InboxConsumer). */
  readonly consumerName: string;
  /** The tenant + stream whose freshness is tracked. */
  readonly tenantId: string;
  readonly stream?: string;
  readonly freshnessObjective?: FreshnessObjective;
  /** Rows to pull per drain pass. Default 100. */
  readonly batchSize?: number;
  /** Idle sleep (ms) between passes when a pass consumed nothing. Default 250. */
  readonly idleDelayMs?: number;
  /** Fraction of the lease TTL after which a renewal is attempted before each pass. Default 0.5. */
  readonly renewAtFraction?: number;
}

/** The result of a fully-run projector (until shutdown). Terminal + fail-visible. */
export interface ProjectorRunReport {
  readonly finalState: ProjectorState;
  readonly passes: number;
  readonly status: ProjectorStatus;
  readonly cleanShutdown: boolean;
}

const DEFAULT_STREAM = 'governance';

export class GovernedProjector {
  readonly #db: Database;
  readonly #consumer: InboxConsumer;
  readonly #source: BusPullSource;
  readonly #lease: ProjectorLease;
  readonly #checkpoints: CheckpointStore;
  readonly #evidence: EvidenceBuffer;
  readonly #readModel: ReadModelSink;
  readonly #clock: Clock;
  readonly #sleep: Sleeper;
  readonly #consumerName: string;
  readonly #tenantId: string;
  readonly #stream: string;
  readonly #objective: FreshnessObjective;
  readonly #batchSize: number;
  readonly #idleDelayMs: number;
  readonly #renewAtFraction: number;

  #state: ProjectorState = 'starting';
  #continuity: ContinuityMode = 'normal';
  #pass = 0;
  #totals = { consumed: 0, applied: 0, buffered: 0, quarantined: 0, retried: 0, deadLettered: 0 };
  #lastError: string | null = null;
  #safeNextAction: SafeNextAction = 'none';
  #rebuild: RebuildState = IDLE_REBUILD;
  #lastAppliedAt: EpochMillis | null = null;
  #source_pos: SourcePosition | null = null;
  #stopRequested = false;
  #stopController = new AbortController();

  constructor(opts: GovernedProjectorOptions) {
    this.#db = opts.db;
    this.#consumer = opts.consumer;
    this.#source = opts.source;
    this.#lease = opts.lease;
    this.#checkpoints = opts.checkpoints;
    this.#evidence = opts.evidence;
    this.#readModel = opts.readModel;
    this.#clock = opts.clock;
    this.#sleep = opts.sleep ?? realSleeper;
    this.#consumerName = opts.consumerName;
    this.#tenantId = opts.tenantId;
    this.#stream = opts.stream ?? DEFAULT_STREAM;
    this.#objective = opts.freshnessObjective ?? DEFAULT_FRESHNESS_OBJECTIVE;
    this.#batchSize = opts.batchSize ?? 100;
    this.#idleDelayMs = opts.idleDelayMs ?? 250;
    const f = opts.renewAtFraction ?? 0.5;
    if (!(f > 0 && f < 1)) throw new RangeError('renewAtFraction must be in (0,1)');
    this.#renewAtFraction = f;
  }

  get state(): ProjectorState {
    return this.#state;
  }
  get stopRequested(): boolean {
    return this.#stopRequested;
  }
  get rebuild(): RebuildState {
    return this.#rebuild;
  }

  /**
   * Read the DURABLE applied cursor via the independent read path (readInboxCursor). This is the
   * proof of the applied position — never an in-memory offset.
   */
  async readAppliedCursor(): Promise<{ seq: number | null; value: string | null }> {
    const cur = await readInboxCursor(this.#db, this.#tenantId, this.#consumerName, this.#stream);
    return cur ? { seq: cur.cursorSeq, value: cur.cursorValue } : { seq: null, value: null };
  }

  /**
   * Assess the CURRENT freshness of the tracked stream against the durable applied cursor and the
   * last-observed source position. Reads the cursor through the independent read path so the
   * freshness signal is grounded in the durable state, not an in-memory count.
   */
  async assessCurrentFreshness(now: EpochMillis = this.#clock()): Promise<StreamFreshness> {
    const cursor = await this.readAppliedCursor();
    return assessFreshness(
      this.#stream,
      cursor.seq,
      this.#lastAppliedAt,
      this.#source_pos,
      now,
      this.#objective,
    );
  }

  /**
   * Build the CURRENT fail-visible status. `stale` (any stream stale/unknown) forces healthy=false
   * even when the lease is live — a lagging projection is never reported healthy. A rebuild in
   * flight is likewise not "healthy" (it is not live-current).
   */
  status(freshness: readonly StreamFreshness[], now: EpochMillis = this.#clock()): ProjectorStatus {
    const grant = this.#lease.grant;
    const leaseLive = this.#lease.isLive(now);
    const stale = freshness.some((f) => f.freshness !== 'fresh');
    const rebuilding = this.#rebuild.phase !== 'idle' && this.#rebuild.phase !== 'completed';
    const healthy =
      !TERMINAL_STATES.has(this.#state) &&
      this.#state !== 'lost_lease' &&
      this.#state !== 'stale' &&
      this.#lastError == null &&
      !stale &&
      !rebuilding &&
      (this.#state === 'starting' || this.#state === 'acquiring_lease' || leaseLive);
    return {
      resource: this.#lease.resource,
      holder: this.#lease.holder,
      state: this.#state,
      healthy,
      ownership: {
        owned: grant != null,
        fencingToken: grant?.fencingToken ?? null,
        leaseExpiresAt: grant?.expiresAt ?? null,
        leaseLive,
      },
      continuity: this.#continuity,
      progress: { pass: this.#pass, ...this.#totals },
      freshness,
      stale,
      rebuild: this.#rebuild,
      bufferedEvidence: this.#evidence.size,
      lastError: this.#lastError,
      safeNextAction: this.#safeNextAction,
      observedAt: now,
    };
  }

  /**
   * Acquire ownership (bounded contention). Resumes cumulative counters, rebuild state, and the
   * last-applied time from any prior checkpoint so a restart CONTINUES the reconstructable history
   * (durable cursors) rather than resetting it. Returns true on success; on failure the state
   * becomes `degraded` with a safe next action.
   */
  async start(): Promise<boolean> {
    this.#state = 'acquiring_lease';
    const grant = await this.#lease.tryAcquire();
    if (grant == null) {
      this.#state = 'degraded';
      this.#safeNextAction = 'none';
      this.#lastError = 'lease held by another projector';
      await this.#writeCheckpoint(await this.#freshnessSnapshot());
      return false;
    }
    const prior = await this.#checkpoints.load(this.#lease.resource);
    if (prior != null) {
      this.#pass = prior.pass;
      this.#totals = { ...prior.totals };
      this.#rebuild = prior.rebuild;
      if (prior.safeNextAction !== 'none') this.#safeNextAction = prior.safeNextAction;
      const priorStream = prior.freshness.find((f) => f.stream === this.#stream);
      if (priorStream?.lastAppliedAt != null) this.#lastAppliedAt = priorStream.lastAppliedAt;
      // A prior interrupted rebuild resumes as a pending rebuild, fail-visibly.
      if (prior.rebuild.phase !== 'idle' && prior.rebuild.phase !== 'completed') {
        this.#safeNextAction = 'rebuild';
      }
    }
    this.#state = 'running';
    this.#lastError = null;
    await this.#writeCheckpoint(await this.#freshnessSnapshot());
    return true;
  }

  /**
   * Request a rebuild. Records the durable rebuild intent (id + reason) so it is visible and
   * resumable. The actual reset+replay runs inside the drain loop under the lease. Idempotent while
   * a rebuild with the same id is in flight.
   */
  requestRebuild(rebuildId: string, reason: string): void {
    if (this.#rebuild.rebuildId === rebuildId && this.#rebuild.phase !== 'idle') return;
    const now = this.#clock();
    this.#rebuild = {
      rebuildId,
      phase: 'resetting',
      replayed: 0,
      reason,
      startedAt: now,
      updatedAt: now,
    };
    this.#safeNextAction = 'rebuild';
  }

  /**
   * Run drain passes until shutdown is requested or ownership is lost. Each pass:
   *   1. renews the lease at half-life; a failed renew ⇒ lost_lease (fail-closed), stop.
   *   2. asserts a live lease (fail-closed) before consuming any work.
   *   3. if a rebuild is pending, RESETS the read model (once) then continues in `rebuilding`
   *      state — replayed events count toward the rebuild, and the projector is NOT reported
   *      live-current until the rebuild completes.
   *   4. pulls one bounded batch from the source, records the observed source position, and
   *      CONSUMES each event through the durable inbox consumer (dedup / ordered apply / quarantine
   *      / retry-bounded dead-letter). A pull/consume throw is captured, checkpointed, retried.
   *   5. reassesses freshness against the durable applied cursor and writes a durable checkpoint
   *      (the resumable, fail-visible record). A stale stream flips the state to `stale`.
   * Returns a terminal, fail-visible report.
   */
  async run(): Promise<ProjectorRunReport> {
    if (this.#state !== 'running') {
      throw new Error(`run() requires state "running" (call start() first); state=${this.#state}`);
    }
    while (!this.#stopRequested) {
      // (1) Keep ownership current.
      const renewed = await this.#renewIfDue();
      if (!renewed) {
        this.#onLeaseLost();
        break;
      }
      // (2) Fail-closed guard.
      try {
        this.#lease.assertLive(this.#clock());
      } catch {
        this.#onLeaseLost();
        break;
      }
      // (3) Rebuild reset (once, at the start of a rebuild).
      if (this.#rebuild.phase === 'resetting') {
        const reset = await this.#performRebuildReset();
        if (!reset) {
          // reset failed → fail-visible degraded, keep the rebuild id for a retry.
          await this.#writeCheckpoint(await this.#freshnessSnapshot());
          await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
          continue;
        }
      }

      // (4) Pull + consume one bounded batch.
      let batch: { events: readonly PulledEvent[]; observedSeq: number };
      try {
        batch = await this.#source.pull(this.#batchSize, this.#stopController.signal);
        this.#lastError = null;
        if (this.#safeNextAction === 'retry') this.#safeNextAction = 'none';
      } catch (err) {
        this.#lastError = describeError(err);
        this.#safeNextAction = 'retry';
        await this.#writeCheckpoint(await this.#freshnessSnapshot());
        await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
        continue;
      }
      // Record the observed source high-water mark (the freshness denominator).
      const now0 = this.#clock();
      if (this.#source_pos == null || batch.observedSeq >= this.#source_pos.observedSeq) {
        this.#source_pos = {
          stream: this.#stream,
          observedSeq: batch.observedSeq,
          observedAt: now0,
        };
      }

      let appliedThisPass = 0;
      let consumeThrew = false;
      for (const raw of batch.events) {
        let result: ConsumeResult;
        try {
          result = await this.#consumer.consume(raw);
        } catch (err) {
          this.#lastError = describeError(err);
          this.#safeNextAction = 'retry';
          consumeThrew = true;
          break;
        }
        this.#foldConsume(result);
        if (result.applied) {
          appliedThisPass += 1;
          this.#lastAppliedAt = this.#clock();
          if (this.#rebuild.phase === 'replaying') {
            this.#rebuild = {
              ...this.#rebuild,
              replayed: this.#rebuild.replayed + 1,
              updatedAt: this.#clock(),
            };
          }
        }
      }

      if (consumeThrew) {
        await this.#writeCheckpoint(await this.#freshnessSnapshot());
        await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
        continue;
      }

      this.#pass += 1;

      // (5) Reassess freshness against the DURABLE applied cursor; checkpoint.
      const freshness = await this.#freshnessSnapshot();
      this.#reconcileStateFromFreshness(freshness, batch.events.length, appliedThisPass);
      await this.#writeCheckpoint(freshness);

      if (batch.events.length === 0) {
        await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
      }
    }
    // Read through the accessor so TS does not narrow #state to the loop-entry literal: the loop
    // body mutates #state via #onLeaseLost() (a method call TS cannot flow-track).
    const finalState: ProjectorState = this.state;
    if (finalState === 'lost_lease') {
      await this.#writeCheckpoint(await this.#freshnessSnapshot());
      await this.#evidence.flush();
      await this.#writeCheckpoint(await this.#freshnessSnapshot());
      return this.#terminalReport('lost_lease', false);
    }
    return this.#completeShutdown();
  }

  /**
   * Request a safe shutdown. Idempotent. Signals abortable sleeps to wake immediately. Does NOT
   * interrupt an in-flight pass — the whole point of a SAFE shutdown (no mid-message loss, no
   * half-applied event).
   */
  requestStop(reason = 'shutdown requested'): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#state === 'running' || this.#state === 'rebuilding' || this.#state === 'stale') {
      this.#state = 'draining';
    }
    this.#stopController.abort(reason);
  }

  /** Bind SIGTERM/SIGINT to requestStop, returning an unbind function. */
  bindSignals(signals: SignalSource): () => void {
    const onTerm = (): void => this.requestStop('SIGTERM');
    const onInt = (): void => this.requestStop('SIGINT');
    signals.once('SIGTERM', onTerm);
    signals.once('SIGINT', onInt);
    return () => {
      signals.removeListener('SIGTERM', onTerm);
      signals.removeListener('SIGINT', onInt);
    };
  }

  // --- internal lifecycle helpers ----------------------------------------

  #foldConsume(result: ConsumeResult): void {
    this.#totals = {
      ...this.#totals,
      consumed: this.#totals.consumed + 1,
      applied: this.#totals.applied + (result.applied ? 1 : 0),
    };
    const d: ConsumeDisposition = result.disposition;
    if (d === 'buffered') this.#totals = { ...this.#totals, buffered: this.#totals.buffered + 1 };
    if (d === 'quarantined')
      this.#totals = { ...this.#totals, quarantined: this.#totals.quarantined + 1 };
    if (d === 'retry') this.#totals = { ...this.#totals, retried: this.#totals.retried + 1 };
    if (d === 'dead_letter') {
      this.#totals = { ...this.#totals, deadLettered: this.#totals.deadLettered + 1 };
      // A dead-letter is a fail-visible escalation signal.
      this.#safeNextAction = 'escalate';
    }
  }

  /** Reset the read model once at the start of a rebuild; transition to `rebuilding`/`replaying`. */
  async #performRebuildReset(): Promise<boolean> {
    const id = this.#rebuild.rebuildId;
    if (id == null) return true;
    this.#state = 'rebuilding';
    try {
      await this.#readModel.reset(id);
    } catch (err) {
      this.#rebuild = { ...this.#rebuild, phase: 'failed', updatedAt: this.#clock() };
      this.#lastError = `rebuild reset failed: ${describeError(err)}`;
      this.#safeNextAction = 'rebuild';
      this.#continuity = 'paused';
      return false;
    }
    this.#rebuild = { ...this.#rebuild, phase: 'replaying', updatedAt: this.#clock() };
    return true;
  }

  /** Read the durable cursor and compute the current per-stream freshness snapshot. */
  async #freshnessSnapshot(): Promise<readonly StreamFreshness[]> {
    const now = this.#clock();
    const cursor = await this.readAppliedCursor();
    const f = assessFreshness(
      this.#stream,
      cursor.seq,
      this.#lastAppliedAt,
      this.#source_pos,
      now,
      this.#objective,
    );
    return [f];
  }

  /**
   * Fold freshness + rebuild + drain results back into the fail-visible state. A rebuild that has
   * caught up to the source COMPLETES; a stale stream (only while live-running) surfaces `stale`.
   */
  #reconcileStateFromFreshness(
    freshness: readonly StreamFreshness[],
    pulled: number,
    _applied: number,
  ): void {
    const streamF = freshness.find((f) => f.stream === this.#stream);
    // Rebuild completion: replaying and no lag remaining and nothing left to pull this pass.
    if (this.#rebuild.phase === 'replaying') {
      const caughtUp = streamF != null && streamF.freshness === 'fresh' && pulled === 0;
      if (caughtUp) {
        this.#rebuild = { ...this.#rebuild, phase: 'completed', updatedAt: this.#clock() };
        this.#state = 'running';
        if (this.#safeNextAction === 'rebuild') this.#safeNextAction = 'none';
      }
      // While still replaying, remain `rebuilding` (not live-current) — do not flip to stale.
      return;
    }
    // Live running: reflect staleness fail-visibly.
    if (streamF != null && streamF.freshness === 'stale') {
      this.#state = 'stale';
      if (this.#safeNextAction === 'none') this.#safeNextAction = 'reconcile';
    } else if (this.#state === 'stale' && streamF?.freshness === 'fresh') {
      // Caught back up → return to healthy running, clear the reconcile hint if it was ours.
      this.#state = 'running';
      if (this.#safeNextAction === 'reconcile') this.#safeNextAction = 'none';
    }
  }

  async #renewIfDue(): Promise<boolean> {
    const grant = this.#lease.grant;
    if (grant == null) return false;
    const now = this.#clock();
    const ttl = grant.expiresAt - grant.acquiredAt;
    const renewAt = grant.acquiredAt + ttl * this.#renewAtFraction;
    if (now < renewAt && this.#lease.isLive(now)) return true;
    return this.#lease.renew();
  }

  #onLeaseLost(): void {
    this.#state = 'lost_lease';
    this.#continuity = 'paused';
    this.#lastError = 'lease ownership lost — paused at safe checkpoint';
    this.#safeNextAction = 'reconcile';
  }

  /** Finish a clean/degraded shutdown: flush evidence, release lease, close DB, checkpoint. */
  async #completeShutdown(): Promise<ProjectorRunReport> {
    this.#state = 'draining';
    const freshness = await this.#freshnessSnapshot();
    const flushed = await this.#evidence.flush();
    let clean = true;
    if (!flushed) {
      clean = false;
      this.#state = 'degraded';
      this.#continuity = 'paused';
      this.#lastError = 'buffered evidence could not be flushed on shutdown';
      this.#safeNextAction = 'reconcile';
    }
    // An outstanding escalation (dead-letter), an incomplete rebuild, or a stale stream is NOT a
    // clean exit — it is a degraded terminal so an operator reads the condition from the durable
    // checkpoint rather than a benign `stopped`.
    const rebuildIncomplete = this.#rebuild.phase !== 'idle' && this.#rebuild.phase !== 'completed';
    const anyStale = freshness.some((f) => f.freshness !== 'fresh');
    if (clean && (this.#safeNextAction === 'escalate' || rebuildIncomplete || anyStale)) {
      clean = false;
      this.#state = 'degraded';
      this.#continuity = 'paused';
      if (this.#safeNextAction === 'none') {
        this.#safeNextAction = rebuildIncomplete ? 'rebuild' : 'reconcile';
      }
    } else if (clean) {
      this.#state = 'stopped';
      this.#continuity = 'normal';
      this.#safeNextAction = 'none';
    }
    await this.#writeCheckpoint(freshness);
    await this.#lease.release();
    try {
      await this.#db.close();
    } catch {
      /* best-effort; the checkpoint already captured our final state */
    }
    return this.#terminalReport(this.#state, clean && this.#state === 'stopped');
  }

  #terminalReport(state: ProjectorState, cleanShutdown: boolean): ProjectorRunReport {
    // The report status uses the last freshness we can compute synchronously from memory; the
    // authoritative durable freshness is already in the final checkpoint.
    const grant = this.#lease.grant;
    const now = this.#clock();
    const fallback = assessFreshness(
      this.#stream,
      null,
      this.#lastAppliedAt,
      this.#source_pos,
      now,
      this.#objective,
    );
    void grant;
    return {
      finalState: state,
      passes: this.#pass,
      status: this.status([fallback], now),
      cleanShutdown,
    };
  }

  async #writeCheckpoint(freshness: readonly StreamFreshness[]): Promise<void> {
    const grant = this.#lease.grant;
    const cp: ProjectorCheckpoint = {
      resource: this.#lease.resource,
      holder: this.#lease.holder,
      fencingToken: grant?.fencingToken ?? 0,
      pass: this.#pass,
      state: this.#state,
      continuity: this.#continuity,
      totals: { ...this.#totals },
      freshness: freshness.map((f) => ({ ...f })),
      rebuild: { ...this.#rebuild },
      bufferedEvidence: this.#evidence.size,
      lastError: this.#lastError,
      safeNextAction: this.#safeNextAction,
      updatedAt: this.#clock(),
    };
    await this.#checkpoints.save(cp);
  }
}

// ===========================================================================
// 9. Bootstrap — fail-closed configuration + wiring
// ===========================================================================

export class BootstrapError extends Error {
  readonly issues: readonly EnvironmentIssue[];
  constructor(issues: readonly EnvironmentIssue[]) {
    const summary = issues.map((i) => `${i.variable}:${i.code}`).join(', ');
    super(`projector bootstrap refused: invalid configuration [${summary}]`);
    this.name = 'BootstrapError';
    this.issues = issues;
  }
}

export interface BootstrapInputs {
  readonly env: RawEnvironment;
  readonly db: Database;
  readonly source: BusPullSource;
  readonly leaseStore: LeaseStore;
  readonly checkpoints: CheckpointStore;
  readonly readModel: ReadModelSink;
  readonly apply: ApplyProjection;
  readonly unsafeGuard?: UnsafeActionGuard;
  readonly evidenceSink: (records: readonly BufferedEvidenceRecord[]) => Promise<void>;
  readonly clock: Clock;
  readonly sleep?: Sleeper;
  /** Stable projector identity (the lease holder). */
  readonly workerId: string;
  /** The tenant whose stream this projector applies. */
  readonly tenantId: string;
  /** The durable consumer name (dedup + cursor key). Default 'read-model'. */
  readonly consumerName?: string;
  /** Governed projection resource name (the lease + checkpoint key). Default 'read-model-projection'. */
  readonly resource?: string;
  readonly stream?: string;
  readonly freshnessObjective?: FreshnessObjective;
  /** Lease TTL ms. Default 15_000. */
  readonly leaseTtlMs?: number;
  readonly batchSize?: number;
  readonly idleDelayMs?: number;
  /** Retry bound for a transient apply failure before dead-lettering (passed to the consumer). */
  readonly maxAttempts?: number;
}

export interface BootstrappedProjector {
  readonly projector: GovernedProjector;
  readonly lease: ProjectorLease;
  readonly consumer: InboxConsumer;
  readonly config: AppEnvironment;
}

/**
 * Parse configuration FAIL-CLOSED and wire the governed projector. A configuration error throws
 * `BootstrapError` (disclosure-safe: variable + code only, never values) and NO projector is
 * produced — a misconfigured projector never starts touching the read model. On success the
 * projector is fully wired but not yet started.
 */
export function bootstrapProjector(inputs: BootstrapInputs): BootstrappedProjector {
  const parsed = parseEnvironment(inputs.env);
  if (!parsed.ok) {
    throw new BootstrapError(parsed.issues);
  }
  const resource = inputs.resource ?? 'read-model-projection';
  const consumerName = inputs.consumerName ?? 'read-model';
  const stream = inputs.stream ?? DEFAULT_STREAM;
  const lease = new ProjectorLease({
    db: inputs.db,
    store: inputs.leaseStore,
    resource,
    holder: inputs.workerId,
    clock: inputs.clock,
    ttlMs: inputs.leaseTtlMs ?? 15_000,
  });
  const evidence = new EvidenceBuffer(inputs.evidenceSink);
  const consumer = new InboxConsumer(inputs.db, {
    consumer: consumerName,
    apply: inputs.apply,
    stream,
    // Only forward optional properties when actually provided — the workspace compiles under
    // exactOptionalPropertyTypes, so an explicit `undefined` is NOT the same as "absent".
    ...(inputs.unsafeGuard !== undefined ? { unsafeGuard: inputs.unsafeGuard } : {}),
    ...(inputs.maxAttempts !== undefined ? { maxAttempts: inputs.maxAttempts } : {}),
  });
  const projector = new GovernedProjector({
    db: inputs.db,
    consumer,
    source: inputs.source,
    lease,
    checkpoints: inputs.checkpoints,
    evidence,
    readModel: inputs.readModel,
    clock: inputs.clock,
    consumerName,
    tenantId: inputs.tenantId,
    stream,
    ...(inputs.sleep !== undefined ? { sleep: inputs.sleep } : {}),
    ...(inputs.freshnessObjective !== undefined
      ? { freshnessObjective: inputs.freshnessObjective }
      : {}),
    ...(inputs.batchSize !== undefined ? { batchSize: inputs.batchSize } : {}),
    ...(inputs.idleDelayMs !== undefined ? { idleDelayMs: inputs.idleDelayMs } : {}),
  });
  return { projector, lease, consumer, config: parsed.env };
}

// ===========================================================================
// 10. Utilities
// ===========================================================================

/** Disclosure-safe error description: the error's message class, never internal detail dumps. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
