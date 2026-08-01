// @trustcircle/command-worker — governed bootstrap, lease ownership, checkpointing, and
// safe shutdown (Phase 47 / work item BSBXP2PH36TG5Y8FTTMWJD16WG /
// VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// This is the *entry point* that turns the async side of the transactional outbox
// (./outbox-publisher.ts, Phase 27) into a governed long-running worker. A governed worker
// is not merely a `while (true) { drain() }` loop; the acceptance oracle
// (VO-6acaf6470d0810df4c93 / the phase spec) requires that the worker's
//
//   * workflow and controller state,
//   * ownership (who holds the run),
//   * health,
//   * failures,
//   * retries,
//   * continuity mode and lease,
//   * buffered evidence, and
//   * safe next actions
//
// MUST be *current* and *fail-visible* at all times. So the runtime here does four governed
// things and exposes ALL of them through a single, independently observable status snapshot:
//
//   1. BOOTSTRAP (`bootstrapWorker`) — parse the injected environment fail-closed (a bad
//      config NEVER yields a half-configured worker; it refuses to start and the reason is
//      visible), derive a stable worker identity, and wire the Database facade + publisher.
//
//   2. LEASE OWNERSHIP (`WorkerLease`) — exactly one worker instance may own the drain at a
//      time. Ownership is a time-bounded lease with a monotonic fencing token, renewed by
//      heartbeat. A worker that cannot renew before expiry MUST stop touching governed state
//      (fail-closed) and surface `LOST` ownership. This defeats the split-brain hazard where
//      two workers publish the same outbox row twice.
//
//   3. CHECKPOINTING (`Checkpoint`) — after every drain pass the worker records a durable,
//      resumable checkpoint (last pass number, cumulative counters, last error, the safe next
//      action, and continuity mode). A crash/restart RESUMES from the checkpoint rather than
//      silently double-acting; the checkpoint is the reconstructable history.
//
//   4. SAFE SHUTDOWN (`GovernedWorker.shutdown` + signal wiring) — on SIGTERM/SIGINT the
//      worker stops CLAIMING new work, lets the in-flight pass finish at a safe boundary
//      (never mid-message), writes a final checkpoint, releases the lease, and closes the DB.
//      Buffered evidence is flushed before exit; if it cannot be flushed the exit is marked
//      degraded and the safe next action becomes `reconcile` (fail-visible, never a silent
//      "clean" exit).
//
// ---------------------------------------------------------------------------
// DESIGN CONSTRAINTS
// ---------------------------------------------------------------------------
// * Dependency-free at runtime except Node built-ins and the already-in-workspace persistence
//   / application surfaces. Runs under Node 22 `--experimental-strip-types`.
// * Deterministic and injectable: the clock, the sleeper, the environment, the process-signal
//   surface, and the publisher are ALL injected, so the whole lifecycle is unit-testable with
//   no wall clock, no real process signals, and no live PostgreSQL.
// * Fail-closed: every ambiguous state (config error, lost lease, unflushed evidence, drain
//   throw) resolves to *stop governed action + surface a safe next action*, never to an
//   optimistic "success".

import { Database, advisoryLockId, type Clock, type EpochMillis } from '@trustcircle/persistence';
import {
  parseEnvironment,
  type AppEnvironment,
  type EnvironmentIssue,
  type RawEnvironment,
} from '@trustcircle/application';
import {
  OutboxPublisher,
  type DrainResult,
  type OutboxPublisherOptions,
} from './outbox-publisher.ts';

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
// 1. Governed worker states (fail-visible vocabulary)
// ===========================================================================

/**
 * The worker's controller/workflow lifecycle state. Every value is a state an operator can
 * SEE in the status snapshot; there is no hidden state. `degraded` and `lost_lease` are
 * fail-visible terminals distinct from a clean `stopped`.
 */
export const WORKER_STATES = [
  'starting', // bootstrapping — config parsed, lease not yet held
  'acquiring_lease', // contending for ownership
  'running', // owns the lease, draining
  'draining', // shutdown requested; finishing the in-flight pass safely
  'stopped', // clean, fully-reconciled exit
  'degraded', // exited/parked with an unresolved condition (fail-visible)
  'lost_lease', // ownership lost mid-run (fail-closed; must reconcile)
  'failed', // bootstrap or fatal error before/while running (fail-visible)
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/**
 * Continuity mode mirrors the platform continuity contract (FR-046..FR-050): while a valid
 * lease covers the current step the worker may `continue` and buffer evidence; otherwise it
 * must `pause` at a safe checkpoint and require reconciliation.
 */
export const CONTINUITY_MODES = ['normal', 'continue_under_lease', 'paused'] as const;
export type ContinuityMode = (typeof CONTINUITY_MODES)[number];

/** The single safe next action an operator/automation should take given the current state. */
export const SAFE_NEXT_ACTIONS = ['none', 'retry', 'reconcile', 'escalate'] as const;
export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

/** Terminal states — no further governed action happens after these. */
const TERMINAL_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  'stopped',
  'degraded',
  'lost_lease',
  'failed',
]);

export function isTerminalState(s: WorkerState): boolean {
  return TERMINAL_STATES.has(s);
}

// ===========================================================================
// 2. Lease ownership — exactly-one-owner, fenced, time-bounded
// ===========================================================================

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
    super(`worker lease for "${resource}" is not live: ${detail}`);
    this.name = 'LeaseLostError';
    this.resource = resource;
  }
}

/**
 * A cooperative, fenced, time-bounded lease serialized by a Postgres *session* advisory lock.
 *
 * Ownership model:
 *   * `tryAcquire` takes the advisory lock (mutual exclusion across processes — see
 *     Database.withAdvisoryLock) and, holding it, reads/writes the durable `worker_lease` row
 *     to bump the fencing token and stamp holder + expiry. Only one worker can be inside the
 *     lock, so only one can win. The advisory lock is RELEASED immediately (it guards the
 *     token bump, not the whole run) — the *time-bounded row lease* is what confers ownership.
 *   * `renew` re-enters the lock and extends expiry IFF this holder + fencing token still own
 *     the row. If another worker has since stolen the lease (higher token), renew fails and
 *     the caller must treat ownership as LOST (fail-closed).
 *   * `isLive(now)` is a pure check the drain loop consults before every claim.
 *
 * The durable row is the independent read path: `readLease` observes ownership without trusting
 * any in-memory flag, satisfying the effect-witness obligation (ownership is a durable identity
 * + lifecycle state that could not exist before acquisition).
 */
export interface LeaseStore {
  /**
   * Atomically (within the caller-held advisory lock) read the current lease row for
   * `resource`, or null if none. Implementations MUST be linearizable under the advisory lock.
   */
  read(session: LeaseSession, resource: string): Promise<StoredLease | null>;
  /** Upsert the lease row. Called only while the advisory lock is held. */
  write(session: LeaseSession, lease: StoredLease): Promise<void>;
  /** Clear ownership (release) IFF holder+token still match. Returns true if cleared. */
  clear(
    session: LeaseSession,
    resource: string,
    holder: string,
    fencingToken: number,
  ): Promise<boolean>;
}

/** The durable lease row shape (mirrors db/migrations worker_lease). */
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

export interface WorkerLeaseOptions {
  readonly db: Database;
  readonly store: LeaseStore;
  readonly resource: string;
  readonly holder: string;
  readonly clock: Clock;
  /** Lease TTL in ms — ownership expires this long after each acquire/renew. */
  readonly ttlMs: number;
}

export class WorkerLease {
  readonly #db: Database;
  readonly #store: LeaseStore;
  readonly #resource: string;
  readonly #holder: string;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #grant: LeaseGrant | null = null;

  constructor(opts: WorkerLeaseOptions) {
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

  /**
   * Contend for ownership. Returns the grant on success, or null if another holder owns a
   * still-live lease. Serialized by the advisory lock so the token bump is race-free.
   */
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
      if (someoneElseLive) return null; // another worker owns a live lease — do not steal

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
   * Extend the lease. Succeeds ONLY if this holder + fencing token still own the durable row.
   * On any mismatch (stolen lease, cleared row) the in-memory grant is dropped and false is
   * returned — the caller MUST then treat ownership as lost (fail-closed).
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
        this.#grant = null; // lost — surface it
        return false;
      }
      const renewed: LeaseGrant = {
        ...this.#grant!,
        expiresAt: now + this.#ttlMs,
      };
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
    // Namespaced so it never collides with the per-message publish lock ("outbox:<id>").
    return `worker-lease:${this.#resource}`;
  }
}

/** Derive the advisory lock id for a lease resource (exported for operator tooling/tests). */
export function leaseLockId(resource: string): bigint {
  return advisoryLockId(`worker-lease:${resource}`);
}

// ===========================================================================
// 3. Checkpointing — durable, resumable, fail-visible drain progress
// ===========================================================================

/**
 * A durable checkpoint of the worker's progress. Written after every pass so a crash resumes
 * from here. It is the reconstructable history AND the fail-visible status source: it carries
 * the cumulative retry/failure counters, the last error, the continuity mode, and the single
 * safe next action.
 */
export interface WorkerCheckpoint {
  readonly resource: string;
  readonly holder: string;
  readonly fencingToken: number;
  readonly pass: number;
  readonly state: WorkerState;
  readonly continuity: ContinuityMode;
  readonly totals: {
    readonly claimed: number;
    readonly published: number;
    readonly retried: number;
    readonly deadLettered: number;
  };
  /** Count of evidence records buffered but not yet flushed to durable storage. */
  readonly bufferedEvidence: number;
  readonly lastError: string | null;
  readonly safeNextAction: SafeNextAction;
  readonly updatedAt: EpochMillis;
}

/** Durable store for the single latest checkpoint per resource. */
export interface CheckpointStore {
  load(resource: string): Promise<WorkerCheckpoint | null>;
  save(cp: WorkerCheckpoint): Promise<void>;
}

// ===========================================================================
// 4. Buffered evidence — held during continuity, flushed on a safe boundary
// ===========================================================================

/** One piece of evidence buffered while a connector/step is degraded (FR-050 continuity). */
export interface BufferedEvidenceRecord {
  readonly kind: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly bufferedAt: EpochMillis;
}

/**
 * An append-only buffer that holds evidence in memory while continuity mode defers durable
 * writes, and flushes it to a durable sink at a safe boundary. `size` is surfaced in the
 * status so unflushed evidence is NEVER invisible; a failed flush leaves the buffer intact and
 * marks the worker degraded (fail-visible).
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

  /** Snapshot (defensive copy) of buffered evidence for inspection. */
  snapshot(): readonly BufferedEvidenceRecord[] {
    return this.#records.map((r) => ({ ...r }));
  }

  /**
   * Flush everything to the durable sink. On success the buffer is emptied and `true` returned.
   * On sink failure the records are RETAINED (nothing is lost) and `false` returned so the
   * caller can surface a degraded exit — buffered evidence is never dropped silently.
   */
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
// 5. The fail-visible status snapshot — the ONE observable surface
// ===========================================================================

/**
 * The complete, current, fail-visible worker status. This single object satisfies the
 * acceptance oracle: it makes workflow/controller state, ownership, health, failures, retries,
 * continuity mode + lease, buffered evidence, and the safe next action all visible at once.
 */
export interface WorkerStatus {
  readonly resource: string;
  readonly holder: string;
  readonly state: WorkerState;
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
    readonly claimed: number;
    readonly published: number;
    readonly retried: number;
    readonly deadLettered: number;
  };
  readonly bufferedEvidence: number;
  readonly lastError: string | null;
  readonly safeNextAction: SafeNextAction;
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 6. GovernedWorker — the runtime that ties it all together
// ===========================================================================

export interface GovernedWorkerOptions {
  readonly db: Database;
  readonly publisher: OutboxPublisher;
  readonly lease: WorkerLease;
  readonly checkpoints: CheckpointStore;
  readonly evidence: EvidenceBuffer;
  readonly clock: Clock;
  readonly sleep?: Sleeper;
  /** Rows to claim per drain pass. Default 100. */
  readonly batchSize?: number;
  /** Idle sleep (ms) between drain passes when a pass drained nothing. Default 250. */
  readonly idleDelayMs?: number;
  /**
   * Fraction of the lease TTL after which a renewal is attempted before each pass. Default 0.5.
   * Renewing at half-life leaves margin so a slow renew still lands before expiry.
   */
  readonly renewAtFraction?: number;
}

/**
 * The result of a fully-run worker (until shutdown). Terminal + fail-visible.
 */
export interface WorkerRunReport {
  readonly finalState: WorkerState;
  readonly passes: number;
  readonly status: WorkerStatus;
  readonly cleanShutdown: boolean;
}

export class GovernedWorker {
  readonly #db: Database;
  readonly #publisher: OutboxPublisher;
  readonly #lease: WorkerLease;
  readonly #checkpoints: CheckpointStore;
  readonly #evidence: EvidenceBuffer;
  readonly #clock: Clock;
  readonly #sleep: Sleeper;
  readonly #batchSize: number;
  readonly #idleDelayMs: number;
  readonly #renewAtFraction: number;

  #state: WorkerState = 'starting';
  #continuity: ContinuityMode = 'normal';
  #pass = 0;
  #totals = { claimed: 0, published: 0, retried: 0, deadLettered: 0 };
  #lastError: string | null = null;
  #safeNextAction: SafeNextAction = 'none';
  #stopRequested = false;
  #stopController = new AbortController();

  constructor(opts: GovernedWorkerOptions) {
    this.#db = opts.db;
    this.#publisher = opts.publisher;
    this.#lease = opts.lease;
    this.#checkpoints = opts.checkpoints;
    this.#evidence = opts.evidence;
    this.#clock = opts.clock;
    this.#sleep = opts.sleep ?? realSleeper;
    this.#batchSize = opts.batchSize ?? 100;
    this.#idleDelayMs = opts.idleDelayMs ?? 250;
    const f = opts.renewAtFraction ?? 0.5;
    if (!(f > 0 && f < 1)) throw new RangeError('renewAtFraction must be in (0,1)');
    this.#renewAtFraction = f;
  }

  get state(): WorkerState {
    return this.#state;
  }

  /** Whether a stop has been requested (idempotent externally). */
  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  /**
   * Build the CURRENT fail-visible status. Pure read of in-memory state + the lease grant.
   * `healthy` is true only when running/starting with a live lease and no unresolved error.
   */
  status(now: EpochMillis = this.#clock()): WorkerStatus {
    const grant = this.#lease.grant;
    const leaseLive = this.#lease.isLive(now);
    const healthy =
      !TERMINAL_STATES.has(this.#state) &&
      this.#state !== 'lost_lease' &&
      this.#lastError == null &&
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
      bufferedEvidence: this.#evidence.size,
      lastError: this.#lastError,
      safeNextAction: this.#safeNextAction,
      observedAt: now,
    };
  }

  /**
   * Acquire ownership (bounded contention). Resumes cumulative counters from any prior
   * checkpoint so a restart continues the reconstructable history rather than resetting it.
   * Returns true on success; on failure the state becomes `degraded` with a safe next action.
   */
  async start(): Promise<boolean> {
    this.#state = 'acquiring_lease';
    const grant = await this.#lease.tryAcquire();
    if (grant == null) {
      // Another worker owns a live lease — this instance is a standby, not a failure.
      this.#state = 'degraded';
      this.#safeNextAction = 'none';
      this.#lastError = 'lease held by another worker';
      await this.#writeCheckpoint();
      return false;
    }
    // Resume from checkpoint if the prior run left one for this resource.
    const prior = await this.#checkpoints.load(this.#lease.resource);
    if (prior != null) {
      this.#pass = prior.pass;
      this.#totals = { ...prior.totals };
      // A prior degraded/lost checkpoint carries forward its safe next action until cleared.
      if (prior.safeNextAction !== 'none') {
        this.#safeNextAction = prior.safeNextAction;
      }
    }
    this.#state = 'running';
    this.#lastError = null;
    await this.#writeCheckpoint();
    return true;
  }

  /**
   * Run drain passes until shutdown is requested or ownership is lost. Each pass:
   *   1. renews the lease at half-life; a failed renew => lost_lease (fail-closed), stop.
   *   2. asserts a live lease (fail-closed) before claiming any work.
   *   3. drains one bounded batch; a throw is captured, checkpointed, and retried under backoff.
   *   4. writes a durable checkpoint (the resumable, fail-visible record).
   * Returns a terminal, fail-visible report.
   */
  async run(): Promise<WorkerRunReport> {
    if (this.#state !== 'running') {
      throw new Error(`run() requires state "running" (call start() first); state=${this.#state}`);
    }
    while (!this.#stopRequested) {
      // (1) Keep ownership current — renew before it can expire.
      const renewed = await this.#renewIfDue();
      if (!renewed) {
        this.#onLeaseLost();
        break;
      }
      // (2) Fail-closed guard: never claim without a live lease.
      try {
        this.#lease.assertLive(this.#clock());
      } catch {
        this.#onLeaseLost();
        break;
      }
      // (3) Drain one bounded batch.
      let drained: DrainResult | null = null;
      try {
        drained = await this.#publisher.runOnce(this.#batchSize);
        this.#lastError = null;
        if (this.#safeNextAction === 'retry') this.#safeNextAction = 'none';
      } catch (err) {
        this.#lastError = describeError(err);
        this.#safeNextAction = 'retry';
        await this.#writeCheckpoint();
        // bounded idle before retrying the pass; abortable by shutdown.
        await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
        continue;
      }
      // (4) Fold results into cumulative totals; checkpoint.
      this.#pass += 1;
      this.#totals = {
        claimed: this.#totals.claimed + drained.claimed,
        published: this.#totals.published + drained.published,
        retried: this.#totals.retried + drained.retried,
        deadLettered: this.#totals.deadLettered + drained.deadLettered,
      };
      // A dead-letter is a fail-visible escalation signal.
      if (drained.deadLettered > 0) this.#safeNextAction = 'escalate';
      await this.#writeCheckpoint();

      if (drained.claimed === 0) {
        // Idle — wait a bounded, abortable interval before the next pass.
        await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
      }
    }
    // Loop exited: either a clean stop (draining) or a lost lease.
    if (this.#state === 'lost_lease') {
      // Persist the lost-lease state DURABLY so an operator (or a restart) reads the fail-visible
      // condition from the checkpoint row rather than a stale `running`. The lease is already gone,
      // so we do NOT release/renew — we only record where we paused and the safe next action.
      await this.#writeCheckpoint();
      // Attempt a best-effort flush of any buffered evidence so it is not stranded; a failure
      // only tightens the (already fail-visible) state and never masks the lost lease.
      await this.#evidence.flush();
      await this.#writeCheckpoint();
      return this.#terminalReport('lost_lease', false);
    }
    return this.#completeShutdown();
  }

  /**
   * Request a safe shutdown. Idempotent. Signals the abortable sleeps to wake immediately so
   * the loop reaches its safe boundary quickly. Does NOT interrupt an in-flight pass — that is
   * the whole point of a SAFE shutdown (no mid-message loss).
   */
  requestStop(reason = 'shutdown requested'): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#state === 'running') this.#state = 'draining';
    this.#stopController.abort(reason);
  }

  /**
   * Bind SIGTERM/SIGINT to `requestStop`, returning an unbind function. The handlers are
   * `once` so a second signal does not double-fire; the returned disposer removes them (used
   * after shutdown completes so a test/host process isn't left with dangling listeners).
   */
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

  /** Renew the lease if it is within the renew window; returns false only on a LOST lease. */
  async #renewIfDue(): Promise<boolean> {
    const grant = this.#lease.grant;
    if (grant == null) return false;
    const now = this.#clock();
    const ttl = grant.expiresAt - grant.acquiredAt;
    const renewAt = grant.acquiredAt + ttl * this.#renewAtFraction;
    if (now < renewAt && this.#lease.isLive(now)) return true; // not due yet, still live
    return this.#lease.renew();
  }

  #onLeaseLost(): void {
    this.#state = 'lost_lease';
    this.#continuity = 'paused';
    this.#lastError = 'lease ownership lost — paused at safe checkpoint';
    this.#safeNextAction = 'reconcile';
  }

  /** Finish a clean/degraded shutdown: flush evidence, release lease, close DB, checkpoint. */
  async #completeShutdown(): Promise<WorkerRunReport> {
    this.#state = 'draining';
    // Flush buffered evidence at the safe boundary. A failure is fail-visible (degraded).
    const flushed = await this.#evidence.flush();
    let clean = true;
    if (!flushed) {
      clean = false;
      this.#state = 'degraded';
      this.#continuity = 'paused';
      this.#lastError = 'buffered evidence could not be flushed on shutdown';
      this.#safeNextAction = 'reconcile';
    }
    // Resolve the terminal state fail-visibly. A clean drain with nothing outstanding stops
    // cleanly; an outstanding `escalate` (e.g. a dead-letter this run) is NOT a clean exit — it
    // is a degraded terminal so an operator sees the escalation in the durable checkpoint rather
    // than a benign `draining`/`stopped`.
    if (clean && this.#safeNextAction === 'escalate') {
      clean = false;
      this.#state = 'degraded';
    } else if (clean) {
      this.#state = 'stopped';
      this.#continuity = 'normal';
      this.#safeNextAction = 'none';
    }
    // Persist the final checkpoint BEFORE releasing the lease so the durable record of where we
    // stopped exists even if release/close races a crash.
    await this.#writeCheckpoint();
    await this.#lease.release();
    try {
      await this.#db.close();
    } catch {
      /* close is best-effort; the checkpoint already captured our final state */
    }
    return this.#terminalReport(this.#state, clean && this.#state === 'stopped');
  }

  #terminalReport(state: WorkerState, cleanShutdown: boolean): WorkerRunReport {
    return {
      finalState: state,
      passes: this.#pass,
      status: this.status(),
      cleanShutdown,
    };
  }

  async #writeCheckpoint(): Promise<void> {
    const grant = this.#lease.grant;
    const cp: WorkerCheckpoint = {
      resource: this.#lease.resource,
      holder: this.#lease.holder,
      fencingToken: grant?.fencingToken ?? 0,
      pass: this.#pass,
      state: this.#state,
      continuity: this.#continuity,
      totals: { ...this.#totals },
      bufferedEvidence: this.#evidence.size,
      lastError: this.#lastError,
      safeNextAction: this.#safeNextAction,
      updatedAt: this.#clock(),
    };
    await this.#checkpoints.save(cp);
  }
}

// ===========================================================================
// 7. Bootstrap — fail-closed configuration + wiring
// ===========================================================================

export class BootstrapError extends Error {
  readonly issues: readonly EnvironmentIssue[];
  constructor(issues: readonly EnvironmentIssue[]) {
    // Disclosure-safe: report variable + code only, never values.
    const summary = issues.map((i) => `${i.variable}:${i.code}`).join(', ');
    super(`command-worker bootstrap refused: invalid configuration [${summary}]`);
    this.name = 'BootstrapError';
    this.issues = issues;
  }
}

export interface BootstrapInputs {
  readonly env: RawEnvironment;
  readonly db: Database;
  readonly publisherBus: OutboxPublisherOptions['bus'];
  readonly leaseStore: LeaseStore;
  readonly checkpoints: CheckpointStore;
  readonly evidenceSink: (records: readonly BufferedEvidenceRecord[]) => Promise<void>;
  readonly clock: Clock;
  readonly sleep?: Sleeper;
  /** Stable worker identity. Defaults to a host+pid form supplied by the caller. */
  readonly workerId: string;
  /** Governed drain resource name (the lease + checkpoint key). Default 'outbox-drain'. */
  readonly resource?: string;
  /** Lease TTL ms. Default 15_000. */
  readonly leaseTtlMs?: number;
  readonly batchSize?: number;
  readonly idleDelayMs?: number;
}

export interface BootstrappedWorker {
  readonly worker: GovernedWorker;
  readonly lease: WorkerLease;
  readonly config: AppEnvironment;
}

/**
 * Parse configuration FAIL-CLOSED and wire the governed worker. A configuration error throws
 * `BootstrapError` (disclosure-safe) and NO worker is produced — a misconfigured worker never
 * starts touching governed state. On success the worker is fully wired but not yet started.
 */
export function bootstrapWorker(inputs: BootstrapInputs): BootstrappedWorker {
  const parsed = parseEnvironment(inputs.env);
  if (!parsed.ok) {
    throw new BootstrapError(parsed.issues);
  }
  const resource = inputs.resource ?? 'outbox-drain';
  const lease = new WorkerLease({
    db: inputs.db,
    store: inputs.leaseStore,
    resource,
    holder: inputs.workerId,
    clock: inputs.clock,
    ttlMs: inputs.leaseTtlMs ?? 15_000,
  });
  const evidence = new EvidenceBuffer(inputs.evidenceSink);
  const publisher = new OutboxPublisher(inputs.db, {
    bus: inputs.publisherBus,
    workerId: inputs.workerId,
  });
  const worker = new GovernedWorker({
    db: inputs.db,
    publisher,
    lease,
    checkpoints: inputs.checkpoints,
    evidence,
    clock: inputs.clock,
    sleep: inputs.sleep,
    batchSize: inputs.batchSize,
    idleDelayMs: inputs.idleDelayMs,
  });
  return { worker, lease, config: parsed.env };
}

// ===========================================================================
// 8. Utilities
// ===========================================================================

/** Disclosure-safe error description: the error's message class, never internal detail dumps. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
