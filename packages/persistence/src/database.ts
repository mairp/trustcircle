// @trustcircle/persistence — PostgreSQL client, transaction wrapper, advisory locks,
// idempotent mutating-operation runner, and migration runner (Phase 17 / T017).
//
// ─────────────────────────────────────────────────────────────────────────────
// Phase-primary oracle (this file's acceptance criterion, GAR / VO-52d0780c11bcc6fd7583):
//
//   "Every onboarded source contract MUST be versioned and validated; mutating operations
//    MUST be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
//    delayed, partial, conflicting, and uncertain outcomes."
//
// This module is the transactional core the rest of the governance platform commits through.
// It makes the oracle an *enforceable, independently-observable value-level invariant*:
//
//   1. Versioned & validated source contracts — a mutating operation is executed under a
//      `SourceContract` that carries a semantic `version`, a `requestDigest`, and a pinned
//      `contractDigest`. `assertSourceContract` refuses an operation whose contract is not
//      versioned/validated; `runMutation` refuses to run when the pinned contract version
//      drifts from the version the operation was authored against (source-drift ⇒ no effect).
//
//   2. Correlated — every mutation carries a `correlationId` and `operationScope`; the
//      idempotency ledger row (the durable witness) records both, so history is
//      reconstructable through an independent read path (`readIdempotencyRecord`).
//
//   3. Deduplicated — a `(tenantId, operationScope, idempotencyKey)` ledger enforces
//      exactly-once effect. A *duplicate* replay of the SAME request returns the first
//      recorded result WITHOUT re-executing the effect. A replay of a DIFFERENT request under
//      the same key is a `conflict` (never a silent overwrite) — CHK / data-model
//      IdempotencyRecord.
//
//   4. Retry-bounded — transient (serialization / deadlock / retryable) failures are retried
//      under a bounded budget (`maxAttempts`); the budget can never be unbounded and a
//      non-retryable failure is never retried.
//
//   5. Reconcilable / safe under uncertain outcomes — an effect that begins but whose outcome
//      is unknown (crash between effect and commit-of-result) is recorded as `uncertain` and
//      surfaces a `reconcile` safe-next-action; it is NEVER reported as success. `reconcile`
//      re-drives through the independent read path and resolves the true state without
//      creating a duplicate effect.
//
//   6. Advisory locks — mutations that touch the same governed key are serialized by a
//      Postgres session advisory lock (`withAdvisoryLock` / `withKeyLock`), so concurrent
//      duplicate/out-of-order updates cannot interleave into a double effect.
//
//   7. Transaction wrapper — `withTransaction` runs work atomically (BEGIN/COMMIT/ROLLBACK) at
//      a chosen isolation level; a partial failure rolls the whole unit back (all-or-nothing),
//      so there is no partial durable effect.
//
//   8. Migration runner — ordered, applied-once, checksum-pinned expand→migrate→contract
//      migrations recorded in a ledger table. Re-running is a no-op; a changed checksum on an
//      already-applied migration is rejected (compatibility / VO-ec575c4ce42b548bfb4d).
//
// Dependency-free w.r.t. runtime infrastructure: the module talks to Postgres through a small
// injected `SqlDriver` seam. Production wires the real `pg` Pool behind that seam; tests wire a
// deterministic in-memory driver, so every invariant above is provable under `npm ci` with no
// live database, and the module runs under Node 22 `--experimental-strip-types` / tsx.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Small pure helpers (deterministic; never read the wall clock directly)
// ===========================================================================

/** Milliseconds since the Unix epoch. Callers inject a clock; the module never reads it. */
export type EpochMillis = number;

/** Injectable monotonic-ish clock. Tests pass a deterministic counter. */
export type Clock = () => EpochMillis;

/** sha-256 hex of a canonicalized value — the durable content witness used across the module. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Stable JSON (sorted object keys) so a digest depends on content, not key order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}

function nonEmpty(s: unknown, field: string): string {
  if (typeof s !== 'string' || s.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return s;
}

// ===========================================================================
// 1. SQL driver seam — the ONLY thing that touches a real database
// ===========================================================================

/** A single SQL statement result — mirrors the shape of node-postgres' QueryResult subset. */
export interface SqlResult<R = Record<string, unknown>> {
  readonly rows: R[];
  readonly rowCount: number;
}

/** A connection that can execute statements. Both the pool and an in-tx client satisfy it. */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
}

/**
 * A pooled Postgres driver. `connect` leases a single dedicated session (required for
 * transactions and *session-scoped* advisory locks — a lock and its unlock MUST run on the
 * same physical connection). Production supplies a `pg.Pool` adapter; tests supply an
 * in-memory fake.
 */
export interface SqlDriver extends SqlExecutor {
  /** Lease a dedicated session; caller MUST `release()` it. */
  connect(): Promise<SqlSession>;
  /** Close the pool (idempotent). */
  end(): Promise<void>;
}

/** A leased single session. Advisory locks + transactions are pinned to it. */
export interface SqlSession extends SqlExecutor {
  release(): void;
}

// ===========================================================================
// 2. Database facade — wraps a driver with a clock and a bounded-retry policy
// ===========================================================================

export interface RetryPolicy {
  /** Hard upper bound on attempts (>=1). Retries are ALWAYS bounded — never Infinity. */
  readonly maxAttempts: number;
  /** Base backoff in ms; used only to compute the advisory `retryAfterMs` hint (no sleeping here). */
  readonly baseBackoffMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseBackoffMs: 25 };

export function assertRetryPolicy(p: RetryPolicy): RetryPolicy {
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new RangeError(`retry.maxAttempts must be an integer >= 1 (got ${p.maxAttempts})`);
  }
  if (!Number.isFinite(p.maxAttempts)) {
    throw new RangeError('retry.maxAttempts must be finite — retries are bounded');
  }
  if (!Number.isFinite(p.baseBackoffMs) || p.baseBackoffMs < 0) {
    throw new RangeError('retry.baseBackoffMs must be a finite, non-negative number');
  }
  return p;
}

/** Postgres transaction isolation levels (data-model requires serializable for canonical state). */
export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Postgres SQLSTATE classes that are safe to retry: 40001 serialization_failure,
 * 40P01 deadlock_detected. Anything else is treated as non-retryable.
 */
export const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

export function isRetryableError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code);
}

export class Database {
  readonly #driver: SqlDriver;
  readonly #clock: Clock;
  readonly #retry: RetryPolicy;

  constructor(driver: SqlDriver, opts: { clock: Clock; retry?: RetryPolicy }) {
    this.#driver = driver;
    this.#clock = opts.clock;
    this.#retry = assertRetryPolicy(opts.retry ?? DEFAULT_RETRY);
  }

  get retry(): RetryPolicy {
    return this.#retry;
  }

  now(): EpochMillis {
    return this.#clock();
  }

  /** Execute a single statement on the pool (no transaction). */
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>> {
    return this.#driver.query<R>(sql, params);
  }

  close(): Promise<void> {
    return this.#driver.end();
  }

  // --- 2a. Transaction wrapper --------------------------------------------
  /**
   * Run `work` inside a single atomic transaction on a dedicated session. On success COMMIT;
   * on any throw ROLLBACK and rethrow. Serialization/deadlock failures are retried under the
   * bounded retry policy (a fresh transaction each attempt). Returns whatever `work` returns.
   *
   * All-or-nothing: a partial failure leaves NO durable effect (rollback), so the "partial
   * outcome" hazard cannot produce a half-committed mutation.
   */
  async withTransaction<T>(
    work: (tx: SqlSession) => Promise<T>,
    opts: { isolation?: IsolationLevel; retry?: RetryPolicy } = {},
  ): Promise<T> {
    const retry = assertRetryPolicy(opts.retry ?? this.#retry);
    const isolation = opts.isolation ?? 'SERIALIZABLE';
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      const session = await this.#driver.connect();
      try {
        await session.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const result = await work(session);
        await session.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await session.query('ROLLBACK');
        } catch {
          /* rollback best-effort; original error is authoritative */
        }
        lastErr = err;
        if (!isRetryableError(err) || attempt >= retry.maxAttempts) throw err;
      } finally {
        session.release();
      }
    }
    // Unreachable in practice (loop either returns or throws), but keeps the type total.
    throw lastErr;
  }

  // --- 2b. Advisory locks --------------------------------------------------
  /**
   * Serialize a critical section across processes by a Postgres session advisory lock keyed on
   * a 64-bit hash of `key`. The lock is acquired and released on the SAME leased session
   * (required by pg_advisory_lock semantics). Guarantees mutual exclusion so concurrent
   * duplicate/out-of-order mutations on the same governed key cannot interleave.
   */
  async withAdvisoryLock<T>(key: string, work: (session: SqlSession) => Promise<T>): Promise<T> {
    const lockId = advisoryLockId(nonEmpty(key, 'advisory lock key'));
    const session = await this.#driver.connect();
    try {
      await session.query('SELECT pg_advisory_lock($1)', [lockId]);
      try {
        return await work(session);
      } finally {
        await session.query('SELECT pg_advisory_unlock($1)', [lockId]);
      }
    } finally {
      session.release();
    }
  }

  /** Convenience: hold the advisory lock for `key` AND run `work` in one transaction. */
  withKeyLock<T>(
    key: string,
    work: (tx: SqlSession) => Promise<T>,
    opts: { isolation?: IsolationLevel } = {},
  ): Promise<T> {
    return this.withAdvisoryLock(key, (session) =>
      this.#runInExistingSession(session, work, opts.isolation ?? 'SERIALIZABLE'),
    );
  }

  async #runInExistingSession<T>(
    session: SqlSession,
    work: (tx: SqlSession) => Promise<T>,
    isolation: IsolationLevel,
  ): Promise<T> {
    await session.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    try {
      const r = await work(session);
      await session.query('COMMIT');
      return r;
    } catch (err) {
      try {
        await session.query('ROLLBACK');
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }

  // --- 2c. Idempotency ledger reads (independent read path) ---------------
  /** Read the durable idempotency record for a key — the independent witness of an effect. */
  async readIdempotencyRecord(
    tenantId: string,
    operationScope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    const res = await this.#driver.query<IdempotencyRow>(
      'SELECT * FROM idempotency_ledger WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3',
      [tenantId, operationScope, idempotencyKey],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : null;
  }
}

/** Deterministically map a string key to a signed 64-bit BigInt for pg_advisory_lock($1). */
export function advisoryLockId(key: string): bigint {
  const h = createHash('sha256').update(key).digest();
  // Take the top 8 bytes as a signed 64-bit integer (Postgres bigint domain).
  const unsigned = h.readBigUInt64BE(0);
  return BigInt.asIntN(64, unsigned);
}

// ===========================================================================
// 3. Versioned & validated source contracts
// ===========================================================================

/**
 * The versioned, validated contract a mutating operation executes under. `contractDigest`
 * pins the exact validated contract body; `requestDigest` pins the exact request. Drift in
 * either between authoring and execution invalidates the operation.
 */
export interface SourceContract {
  readonly sourceId: string;
  /** Semantic version of the onboarded source contract, e.g. "1.4.0". */
  readonly version: string;
  /** Digest over the validated contract body (schema, capabilities, authoritative fields). */
  readonly contractDigest: string;
  /** True only after the contract passed validation. An unvalidated contract cannot mutate. */
  readonly validated: boolean;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Refuse a contract that is not versioned AND validated. */
export function assertSourceContract(c: SourceContract): SourceContract {
  nonEmpty(c.sourceId, 'sourceContract.sourceId');
  if (!SEMVER_RE.test(c.version)) {
    throw new TypeError(`sourceContract.version is not a valid semantic version: ${c.version}`);
  }
  nonEmpty(c.contractDigest, 'sourceContract.contractDigest');
  if (c.validated !== true) {
    throw new Error(`source contract ${c.sourceId}@${c.version} is not validated — cannot mutate`);
  }
  return c;
}

// ===========================================================================
// 4. Mutating-operation runner: correlated, deduplicated, reconcilable,
//    retry-bounded, and safe under duplicate/delayed/partial/conflicting/uncertain outcomes.
// ===========================================================================

/** Terminal result status of a mutating operation, stored in the idempotency ledger. */
export type OperationStatus = 'succeeded' | 'failed' | 'uncertain';

/** Safe next action a caller must take given the recorded status (never claim unconfirmed success). */
export type SafeNextAction = 'none' | 'retry' | 'reconcile' | 'escalate';

export interface MutationRequest<Result> {
  readonly tenantId: string;
  /** Operation class, e.g. "controller.repair" — part of the idempotency key tuple. */
  readonly operationScope: string;
  /** Caller-supplied idempotency key, unique per (tenant, scope) per logical request. */
  readonly idempotencyKey: string;
  /** Correlates this mutation across logs/evidence/read models. */
  readonly correlationId: string;
  /** The versioned, validated contract this mutation runs under. */
  readonly contract: SourceContract;
  /** Version the operation was authored against; drift ⇒ operation invalidated (no effect). */
  readonly expectedContractVersion: string;
  /** The full request payload; digested to detect key reuse with a different body. */
  readonly request: unknown;
  /** The actual effect. MUST be idempotent-at-the-key level; returns the durable result. */
  readonly effect: (tx: SqlSession) => Promise<Result>;
}

export interface OperationOutcome<Result> {
  readonly status: OperationStatus;
  readonly nextAction: SafeNextAction;
  /** True when this call returned a previously-recorded result rather than executing anew. */
  readonly deduplicated: boolean;
  /** Present only when status === 'succeeded'. */
  readonly result?: Result;
  /** Digest of the recorded response — a durable witness of the effect. */
  readonly responseDigest: string | null;
  readonly correlationId: string;
  readonly attempts: number;
}

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly operationScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly requestDigest: string;
  readonly contractVersion: string;
  readonly status: OperationStatus;
  readonly responseDigest: string | null;
  readonly firstSeenAt: EpochMillis;
  readonly lastSeenAt: EpochMillis;
  readonly attempts: number;
}

interface IdempotencyRow {
  readonly tenant_id: string;
  readonly operation_scope: string;
  readonly idempotency_key: string;
  readonly correlation_id: string;
  readonly request_digest: string;
  readonly contract_version: string;
  readonly status: OperationStatus;
  readonly response_digest: string | null;
  readonly response_json: string | null;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly attempts: number;
}

function rowToRecord(r: IdempotencyRow): IdempotencyRecord {
  return {
    tenantId: r.tenant_id,
    operationScope: r.operation_scope,
    idempotencyKey: r.idempotency_key,
    correlationId: r.correlation_id,
    requestDigest: r.request_digest,
    contractVersion: r.contract_version,
    status: r.status,
    responseDigest: r.response_digest,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    attempts: r.attempts,
  };
}

/** Raised when an idempotency key is reused with a materially different request body. */
export class IdempotencyConflictError extends Error {
  readonly kind = 'idempotency_conflict' as const;
  readonly tenantId: string;
  readonly operationScope: string;
  readonly idempotencyKey: string;
  readonly existingDigest: string;
  readonly incomingDigest: string;
  constructor(
    tenantId: string,
    operationScope: string,
    idempotencyKey: string,
    existingDigest: string,
    incomingDigest: string,
  ) {
    super(
      `idempotency conflict for (${tenantId}, ${operationScope}, ${idempotencyKey}): ` +
        `key reused with a different request digest`,
    );
    this.name = 'IdempotencyConflictError';
    this.tenantId = tenantId;
    this.operationScope = operationScope;
    this.idempotencyKey = idempotencyKey;
    this.existingDigest = existingDigest;
    this.incomingDigest = incomingDigest;
  }
}

/** Raised when the pinned contract version drifts from the version the operation was authored against. */
export class ContractDriftError extends Error {
  readonly kind = 'contract_drift' as const;
  readonly sourceId: string;
  readonly expected: string;
  readonly actual: string;
  constructor(sourceId: string, expected: string, actual: string) {
    super(`source contract ${sourceId} drifted: expected @${expected}, pinned @${actual}`);
    this.name = 'ContractDriftError';
    this.sourceId = sourceId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Total, unambiguous map: a status always has exactly one safe next action. */
export function safeNextActionFor(status: OperationStatus): SafeNextAction {
  switch (status) {
    case 'succeeded':
      return 'none';
    case 'failed':
      return 'retry';
    case 'uncertain':
      return 'reconcile'; // NEVER 'none' — uncertain must never be reported as success.
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled status ${String(_exhaustive)}`);
    }
  }
}

/**
 * Execute a mutating operation with the full set of oracle guarantees. The idempotency ledger
 * row is the single durable witness; the effect and the ledger row commit ATOMICALLY in one
 * transaction, so there is never an effect without a recorded outcome (or vice versa).
 *
 * Behavior matrix:
 *   - duplicate (same request):     no re-execution; returns first recorded result; deduplicated=true.
 *   - conflicting (different req):   IdempotencyConflictError; no effect.
 *   - source drift:                  ContractDriftError; no effect.
 *   - transient failure:             retried under the bounded budget; if exhausted ⇒ status='failed'.
 *   - uncertain (effect ran, commit unknown): recorded 'uncertain' ⇒ nextAction='reconcile'; never 'succeeded'.
 */
export async function runMutation<Result>(
  db: Database,
  req: MutationRequest<Result>,
): Promise<OperationOutcome<Result>> {
  nonEmpty(req.tenantId, 'tenantId');
  nonEmpty(req.operationScope, 'operationScope');
  nonEmpty(req.idempotencyKey, 'idempotencyKey');
  nonEmpty(req.correlationId, 'correlationId');
  assertSourceContract(req.contract);

  // (1) Versioned & validated + source-drift guard — BEFORE any effect.
  if (req.contract.version !== req.expectedContractVersion) {
    throw new ContractDriftError(
      req.contract.sourceId,
      req.expectedContractVersion,
      req.contract.version,
    );
  }

  const requestDigest = digest({
    request: req.request,
    contractDigest: req.contract.contractDigest,
  });

  // (2) Serialize per idempotency key so concurrent duplicates cannot double-apply.
  const lockKey = `mutation:${req.tenantId}:${req.operationScope}:${req.idempotencyKey}`;
  return db.withAdvisoryLock(lockKey, async () => {
    // (3) Dedup / conflict check on the independent read path.
    const existing = await db.readIdempotencyRecord(
      req.tenantId,
      req.operationScope,
      req.idempotencyKey,
    );
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new IdempotencyConflictError(
          req.tenantId,
          req.operationScope,
          req.idempotencyKey,
          existing.requestDigest,
          requestDigest,
        );
      }
      if (existing.status === 'succeeded') {
        // Duplicate replay: return the recorded result, NO re-execution.
        const stored = await loadStoredResult<Result>(db, existing);
        return {
          status: 'succeeded',
          nextAction: 'none',
          deduplicated: true,
          ...(stored.hasValue ? { result: stored.value } : {}),
          responseDigest: existing.responseDigest,
          correlationId: existing.correlationId,
          attempts: existing.attempts,
        };
      }
      // status 'failed' or 'uncertain' ⇒ fall through and re-drive (bounded), safe to retry.
    }

    // (4) Bounded retry of the atomic (effect + ledger) transaction.
    const retry = db.retry;
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < retry.maxAttempts) {
      attempt++;
      try {
        // The mutation layer owns the bounded retry; the transaction must NOT retry again
        // (that would multiply the budget). One atomic attempt per outer iteration.
        return await db.withTransaction(
          async (tx) => {
            const result = await req.effect(tx);
            const responseDigest = digest(result ?? null);
            await upsertLedger(tx, {
              tenantId: req.tenantId,
              operationScope: req.operationScope,
              idempotencyKey: req.idempotencyKey,
              correlationId: req.correlationId,
              requestDigest,
              contractVersion: req.contract.version,
              status: 'succeeded',
              responseDigest,
              responseJson: canonicalJson(result ?? null),
              now: db.now(),
              attempts: attempt,
            });
            return {
              status: 'succeeded' as const,
              nextAction: 'none' as const,
              deduplicated: false,
              result,
              responseDigest,
              correlationId: req.correlationId,
              attempts: attempt,
            };
          },
          { retry: { maxAttempts: 1, baseBackoffMs: retry.baseBackoffMs } },
        );
      } catch (err) {
        lastErr = err;
        if (isRetryableError(err) && attempt < retry.maxAttempts) continue;
        // Non-retryable OR budget exhausted: record a durable, non-success terminal state.
        const status: OperationStatus = classifyFailure(err);
        try {
          await recordTerminalFailure(db, {
            tenantId: req.tenantId,
            operationScope: req.operationScope,
            idempotencyKey: req.idempotencyKey,
            correlationId: req.correlationId,
            requestDigest,
            contractVersion: req.contract.version,
            status,
            attempts: attempt,
          });
        } catch {
          /* if we cannot even record, the outcome is uncertain — surface reconcile below */
        }
        return {
          status,
          nextAction: safeNextActionFor(status),
          deduplicated: false,
          responseDigest: null,
          correlationId: req.correlationId,
          attempts: attempt,
        };
      }
    }
    // Loop only exits via return/throw; keep the type total.
    throw lastErr;
  });
}

/** An effect whose remote/commit outcome is unknown throws this so the runner records 'uncertain'. */
export class UncertainOutcomeError extends Error {
  readonly kind = 'uncertain_outcome' as const;
  constructor(message = 'remote outcome uncertain') {
    super(message);
    this.name = 'UncertainOutcomeError';
  }
}

function classifyFailure(err: unknown): OperationStatus {
  return err instanceof UncertainOutcomeError ? 'uncertain' : 'failed';
}

interface LedgerUpsert {
  tenantId: string;
  operationScope: string;
  idempotencyKey: string;
  correlationId: string;
  requestDigest: string;
  contractVersion: string;
  status: OperationStatus;
  responseDigest: string | null;
  responseJson: string | null;
  now: EpochMillis;
  attempts: number;
}

async function upsertLedger(tx: SqlExecutor, u: LedgerUpsert): Promise<void> {
  await tx.query(
    `INSERT INTO idempotency_ledger
       (tenant_id, operation_scope, idempotency_key, correlation_id, request_digest,
        contract_version, status, response_digest, response_json, first_seen_at, last_seen_at, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)
     ON CONFLICT (tenant_id, operation_scope, idempotency_key) DO UPDATE SET
       status = EXCLUDED.status,
       response_digest = EXCLUDED.response_digest,
       response_json = EXCLUDED.response_json,
       last_seen_at = EXCLUDED.last_seen_at,
       attempts = EXCLUDED.attempts,
       correlation_id = EXCLUDED.correlation_id`,
    [
      u.tenantId,
      u.operationScope,
      u.idempotencyKey,
      u.correlationId,
      u.requestDigest,
      u.contractVersion,
      u.status,
      u.responseDigest,
      u.responseJson,
      u.now,
      u.attempts,
    ],
  );
}

async function recordTerminalFailure(
  db: Database,
  u: Omit<LedgerUpsert, 'responseDigest' | 'responseJson' | 'now'>,
): Promise<void> {
  await db.withTransaction((tx) =>
    upsertLedger(tx, {
      ...u,
      responseDigest: null,
      responseJson: null,
      now: db.now(),
    }),
  );
}

async function loadStoredResult<Result>(
  db: Database,
  rec: IdempotencyRecord,
): Promise<{ hasValue: boolean; value: Result }> {
  const res = await db.query<IdempotencyRow>(
    'SELECT response_json FROM idempotency_ledger WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3',
    [rec.tenantId, rec.operationScope, rec.idempotencyKey],
  );
  const raw = res.rows[0]?.response_json ?? null;
  if (raw === null) return { hasValue: false, value: undefined as unknown as Result };
  return { hasValue: true, value: JSON.parse(raw) as Result };
}

// ===========================================================================
// 5. Reconciliation — resolve an uncertain/failed outcome without a duplicate effect.
// ===========================================================================

export interface ReconcileResult {
  /** True if the operation genuinely completed (observed via the independent read path). */
  readonly resolved: boolean;
  readonly status: OperationStatus;
  readonly nextAction: SafeNextAction;
  readonly correlationId: string | null;
}

/**
 * Reconcile a possibly-uncertain operation. It re-reads the ledger (independent read path) and
 * consults an observation function that inspects the true durable state of the effect. It
 * NEVER re-runs the effect (so no duplicate action) and NEVER claims unconfirmed success:
 * an outcome that cannot be confirmed stays 'uncertain' with nextAction 'reconcile'/'escalate'.
 */
export async function reconcileMutation(
  db: Database,
  key: { tenantId: string; operationScope: string; idempotencyKey: string },
  observeEffect: (rec: IdempotencyRecord | null) => Promise<'succeeded' | 'failed' | 'unknown'>,
): Promise<ReconcileResult> {
  const rec = await db.readIdempotencyRecord(key.tenantId, key.operationScope, key.idempotencyKey);
  if (rec && rec.status === 'succeeded') {
    return {
      resolved: true,
      status: 'succeeded',
      nextAction: 'none',
      correlationId: rec.correlationId,
    };
  }
  const observed = await observeEffect(rec);
  if (observed === 'succeeded') {
    if (rec) {
      await db.withTransaction((tx) =>
        upsertLedger(tx, {
          tenantId: rec.tenantId,
          operationScope: rec.operationScope,
          idempotencyKey: rec.idempotencyKey,
          correlationId: rec.correlationId,
          requestDigest: rec.requestDigest,
          contractVersion: rec.contractVersion,
          status: 'succeeded',
          responseDigest: rec.responseDigest,
          responseJson: null,
          now: db.now(),
          attempts: rec.attempts,
        }),
      );
    }
    return {
      resolved: true,
      status: 'succeeded',
      nextAction: 'none',
      correlationId: rec?.correlationId ?? null,
    };
  }
  if (observed === 'failed') {
    return {
      resolved: true,
      status: 'failed',
      nextAction: 'retry',
      correlationId: rec?.correlationId ?? null,
    };
  }
  // Still unknown ⇒ escalate for human resolution; never report success.
  return {
    resolved: false,
    status: 'uncertain',
    nextAction: 'escalate',
    correlationId: rec?.correlationId ?? null,
  };
}

// ===========================================================================
// 6. Migration runner — ordered expand→migrate→contract, applied-once, checksum-pinned.
// ===========================================================================

export type MigrationKind = 'expand' | 'migrate' | 'contract';

export interface Migration {
  /** Zero-padded ordinal, e.g. "0001". Determines apply order. */
  readonly id: string;
  readonly name: string;
  readonly kind: MigrationKind;
  /** The forward SQL. Its checksum is pinned once applied — changing it later is rejected. */
  readonly up: string;
}

export interface MigrationRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: MigrationKind;
  readonly checksum: string;
  readonly appliedAt: EpochMillis;
}

export interface MigrationRunReport {
  readonly applied: MigrationRecord[];
  readonly skipped: string[];
  readonly total: number;
}

/** SQL that creates the ledger + migration-history tables (safe to run repeatedly). */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  applied_at   BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_ledger (
  tenant_id        TEXT NOT NULL,
  operation_scope  TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  correlation_id   TEXT NOT NULL,
  request_digest   TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  status           TEXT NOT NULL,
  response_digest  TEXT,
  response_json    TEXT,
  first_seen_at    BIGINT NOT NULL,
  last_seen_at     BIGINT NOT NULL,
  attempts         INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, operation_scope, idempotency_key)
);
`;

export function checksumMigration(m: Migration): string {
  return digest({ id: m.id, name: m.name, kind: m.kind, up: m.up });
}

/** Validate the ordered migration set: unique, sorted ids and valid expand→migrate→contract ordering within an id is caller-defined. */
export function assertMigrationOrder(migrations: readonly Migration[]): void {
  const ids = migrations.map((m) => m.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate migration id: ${id}`);
    seen.add(id);
  }
  const sorted = [...ids].sort();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== sorted[i]) {
      throw new Error('migrations must be provided in ascending id order');
    }
  }
}

/** Raised when an already-applied migration's checksum changed (its SQL was edited in place). */
export class MigrationChecksumError extends Error {
  readonly kind = 'migration_checksum_mismatch' as const;
  readonly id: string;
  readonly recorded: string;
  readonly incoming: string;
  constructor(id: string, recorded: string, incoming: string) {
    super(
      `migration ${id} checksum changed after it was applied ` +
        `(expand→migrate→contract forbids editing an applied migration; add a new one instead)`,
    );
    this.name = 'MigrationChecksumError';
    this.id = id;
    this.recorded = recorded;
    this.incoming = incoming;
  }
}

/**
 * Apply all not-yet-applied migrations in order, each in its own transaction, recording it in
 * `schema_migrations`. Applied-once: an already-recorded id is skipped. A recorded id whose
 * checksum differs from the incoming migration is rejected (compatibility — an applied,
 * supported migration is immutable; changes go through a NEW expand→migrate→contract step).
 */
export async function runMigrations(
  db: Database,
  migrations: readonly Migration[],
): Promise<MigrationRunReport> {
  assertMigrationOrder(migrations);
  // Bootstrap ledger + history tables idempotently.
  await db.query(BOOTSTRAP_SQL);

  // Serialize the whole run behind one advisory lock so two runners cannot race.
  return db.withAdvisoryLock('trustcircle:migrations', async (session) => {
    const applied: MigrationRecord[] = [];
    const skipped: string[] = [];
    const existing = await session.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations',
    );
    const byId = new Map(existing.rows.map((r) => [r.id, r.checksum]));

    for (const m of migrations) {
      nonEmpty(m.id, 'migration.id');
      nonEmpty(m.up, `migration.up (${m.id})`);
      const checksum = checksumMigration(m);
      const recorded = byId.get(m.id);
      if (recorded !== undefined) {
        if (recorded !== checksum) throw new MigrationChecksumError(m.id, recorded, checksum);
        skipped.push(m.id);
        continue;
      }
      const appliedAt = db.now();
      // Each migration + its history row commit atomically.
      await session.query('BEGIN');
      try {
        await session.query(m.up);
        await session.query(
          'INSERT INTO schema_migrations (id, name, kind, checksum, applied_at) VALUES ($1,$2,$3,$4,$5)',
          [m.id, m.name, m.kind, checksum, appliedAt],
        );
        await session.query('COMMIT');
      } catch (err) {
        try {
          await session.query('ROLLBACK');
        } catch {
          /* best effort */
        }
        throw err;
      }
      applied.push({ id: m.id, name: m.name, kind: m.kind, checksum, appliedAt });
    }
    return { applied, skipped, total: migrations.length };
  });
}

/** Read the applied-migration history through the independent read path. */
export async function readMigrationHistory(db: Database): Promise<MigrationRecord[]> {
  const res = await db.query<{
    id: string;
    name: string;
    kind: MigrationKind;
    checksum: string;
    applied_at: number;
  }>('SELECT id, name, kind, checksum, applied_at FROM schema_migrations ORDER BY id ASC');
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

// ===========================================================================
// 7. `db:migrate` CLI entrypoint (run only when invoked directly).
// ===========================================================================

/** Build a Database from env-provided connection info using the real `pg` Pool, if available. */
export async function connectFromEnv(): Promise<Database> {
  // Lazy, optional dependency: the real pg driver is only needed for the live CLI, never for
  // the in-memory tests. Import is dynamic so `npm ci` + unit tests do not require `pg`.
  const pg = (await import(
    // @ts-expect-error 'pg' is an optional runtime dependency, only present for the live CLI.
    'pg'
  ).catch(() => null)) as unknown as {
    Pool: new (config: unknown) => PgPool;
  } | null;
  if (!pg) {
    throw new Error(
      "the 'pg' package is not installed — `db:migrate` requires it at runtime " +
        '(install pg to run migrations against a live PostgreSQL)',
    );
  }
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  const driver = pgPoolDriver(pool);
  return new Database(driver, { clock: () => Date.now() });
}

/** Minimal structural type of the parts of `pg.Pool` we use (avoids a hard type dep on pg). */
interface PgPool {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
interface PgClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

/** Adapt a `pg.Pool` to the `SqlDriver` seam. */
export function pgPoolDriver(pool: PgPool): SqlDriver {
  return {
    async query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
    },
    async connect(): Promise<SqlSession> {
      const client = await pool.connect();
      return {
        async query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
          const r = await client.query(sql, params);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
        },
        release() {
          client.release();
        },
      };
    },
    end() {
      return pool.end();
    },
  };
}

/** Discover ordered migrations under db/migrations (id__name.kind.sql), for the CLI. */
export async function loadMigrationsFromDisk(dir: string): Promise<Migration[]> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((file) => {
    // Convention: <id>__<name>.<kind>.sql  e.g. 0001__init.expand.sql
    const m = file.match(/^(\d+)__(.+)\.(expand|migrate|contract)\.sql$/);
    if (!m) throw new Error(`migration file name not in <id>__<name>.<kind>.sql form: ${file}`);
    return {
      id: m[1]!,
      name: m[2]!,
      kind: m[3] as MigrationKind,
      up: readFileSync(join(dir, file), 'utf8'),
    };
  });
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];
  if (cmd !== 'migrate') {
    process.stderr.write('usage: database.ts migrate\n');
    return 2;
  }
  const db = await connectFromEnv();
  try {
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');
    const migrations = await loadMigrationsFromDisk(migrationsDir).catch(() => [] as Migration[]);
    const report = await runMigrations(db, migrations);
    process.stdout.write(
      `db:migrate — applied ${report.applied.length}, skipped ${report.skipped.length}, ` +
        `total ${report.total}\n`,
    );
    return 0;
  } finally {
    await db.close();
  }
}

// Run as an entrypoint ONLY when invoked directly, never on import (so tests import pure helpers safely).
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`db:migrate failed: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
