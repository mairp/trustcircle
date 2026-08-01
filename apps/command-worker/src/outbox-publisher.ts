// @trustcircle/command-worker — the transactional-outbox PUBLISHER (Phase 27 / T027).
//
// ─────────────────────────────────────────────────────────────────────────────
// Phase-primary oracle (GAR-008 / VO-52d0780c11bcc6fd7583, and the transactional-outbox
// effect-witness VO-7a0dbcc527946b539bf6):
//
//   "Every onboarded source contract MUST be versioned and validated; mutating operations
//    MUST be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
//    delayed, partial, conflicting, and uncertain outcomes."
//
// The unit-of-work (packages/persistence/src/unit-of-work.ts, Phase 21) writes an
// OutboxMessage row in the SAME transaction as the canonical state change, so a governed
// change and its downstream notification are atomically consistent. This module is the
// asynchronous SECOND HALF of the transactional-outbox pattern: it CLAIMS those `pending`
// rows, PUBLISHES them to the message bus, and records the PUBLISH ACKNOWLEDGEMENT — all with
// BOUNDED retries and safe behavior under duplicate, delayed, partial, and uncertain
// publish outcomes. The durable delivery substrate it operates on is defined by
// db/migrations/0004_delivery.sql (outbox_message + delivery_attempt + dead_letter_record).
//
// The invariants this publisher makes independently observable:
//
//   1. Transactional CLAIM (no double-publish across concurrent workers). A worker claims a
//      due row by atomically flipping its status `pending|failed` -> `publishing` and stamping
//      a lease (claimed_by / claimed_at) inside ONE transaction guarded by a per-message
//      advisory lock. A row already `publishing` or `published` is NOT re-claimed, so two
//      workers running concurrently never publish the same message twice (deduplicated).
//
//   2. Publish acknowledgement is the ONLY proof of success. A message is marked `published`
//      ONLY after the injected publisher returns an acknowledgement (ack_ref). The bus
//      response alone is not trusted as durable success — the ack_ref is written to the row
//      and to an append-only delivery_attempt row, so success is witnessed through an
//      INDEPENDENT read path (readOutboxMessage / readAttempts), never the publish() return.
//
//   3. Bounded retries. Each attempt increments `attempts`; a retryable failure schedules the
//      next attempt (exponential backoff on next_attempt_at) UP TO `max_attempts`. Once
//      attempts reach max_attempts the message is moved to `dead_letter` and a
//      DeadLetterRecord is written — the publisher NEVER retries unboundedly.
//
//   4. Safe under UNCERTAIN outcomes. If publish() throws an *uncertain* error (the bus may or
//      may not have accepted the message), the row is returned to `failed` for a later retry
//      and is NEVER marked `published` — an uncertain outcome is never reported as success. A
//      duplicate delivery that results from a retry after an uncertain outcome is the
//      consumer's inbox-dedup responsibility (inbox_message in 0004_delivery.sql); the
//      publisher's contract is "at least once, never falsely acknowledged".
//
//   5. Correlated + reconstructable. Every attempt writes an append-only delivery_attempt row
//      carrying the message's correlation_id and the attempt ordinal, so the full publish
//      history (last success, last failure, retry state) is reconstructable through the
//      independent read path.
//
// The module reuses the transactional core in @trustcircle/persistence through its PUBLIC seam
// (Database.withTransaction / withKeyLock / query) and adds no new infrastructure: production
// wires the real `pg` Pool and a real JetStream publisher; tests wire a deterministic in-memory
// driver + a scriptable publisher, so every invariant above is provable under `npm ci` with no
// live database or broker, under Node 22 `--experimental-strip-types` / tsx.

import {
  type Database,
  type SqlExecutor,
  digest,
  canonicalJson,
} from '@trustcircle/persistence';

// ===========================================================================
// 0. Publish port — the injected message-bus seam
// ===========================================================================

/** The publish outcome classes the publisher must handle safely. */
export type PublishOutcome = 'acknowledged' | 'retryable' | 'uncertain' | 'fatal';

/** A durable publish acknowledgement returned by the bus (e.g. JetStream PubAck). */
export interface PublishAck {
  /** Opaque acknowledgement reference (e.g. `${stream}:${seq}`) — durable proof of delivery. */
  readonly ackRef: string;
}

/**
 * The message handed to the bus publisher. Carries the durable identity and content witness so
 * the publisher can key delivery and the consumer can dedup.
 */
export interface OutboundMessage {
  readonly messageId: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadDigest: string;
  readonly correlationId: string;
  /** 1-based ordinal of this publish attempt (for at-least-once dedup keying on the bus). */
  readonly attempt: number;
}

/**
 * A publish attempt to the message bus. A well-behaved publisher returns an ack on success and
 * signals the *class* of failure otherwise, so the outbox can distinguish a bounded-retry
 * transient (`retryable`), an ambiguous outcome (`uncertain` — never reported as success), and
 * a permanent rejection (`fatal` — dead-letter immediately). Implementations may either return
 * a `{ outcome, ack? }` result or throw a `PublishError`.
 */
export interface OutboxBusPublisher {
  publish(msg: OutboundMessage): Promise<PublishResult>;
}

export interface PublishResult {
  readonly outcome: PublishOutcome;
  /** Present iff outcome === 'acknowledged'. */
  readonly ack?: PublishAck;
  /** Human-readable failure detail for the attempt/dead-letter record. */
  readonly detail?: string;
}

/** A publisher may also throw this to signal a failure class instead of returning it. */
export class PublishError extends Error {
  readonly outcome: Exclude<PublishOutcome, 'acknowledged'>;
  constructor(outcome: Exclude<PublishOutcome, 'acknowledged'>, message: string) {
    super(message);
    this.name = 'PublishError';
    this.outcome = outcome;
  }
}

// ===========================================================================
// 1. Publisher configuration
// ===========================================================================

export interface OutboxPublisherOptions {
  readonly bus: OutboxBusPublisher;
  /** This worker's identity — stamped as the claim lease holder (claimed_by). */
  readonly workerId: string;
  /** Base backoff (ms) for the exponential next-attempt schedule. Default 1000. */
  readonly baseBackoffMs?: number;
  /** Cap (ms) on a single backoff interval. Default 300_000 (5 min). */
  readonly maxBackoffMs?: number;
  /** Accountable owner recorded on a dead-letter record. Default 'team:platform-delivery'. */
  readonly deadLetterOwner?: string;
}

const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const DEFAULT_DEAD_LETTER_OWNER = 'team:platform-delivery';

// ===========================================================================
// 2. Row / result shapes (independent read-path witnesses)
// ===========================================================================

/** Publish lifecycle of an outbox row (superset of the unit-of-work's `OutboxStatus`). */
export type OutboxPublishStatus =
  | 'pending'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'dead_letter';

/** The delivery outcome recorded per attempt in the append-only delivery_attempt history. */
export type AttemptOutcome = 'succeeded' | 'retryable' | 'failed' | 'uncertain';

/** The durable outbox row as read back from the delivery substrate (independent read path). */
export interface OutboxRowView {
  readonly messageId: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadDigest: string;
  readonly correlationId: string;
  readonly status: OutboxPublishStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: number | null;
  readonly ackRef: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: number | null;
  readonly terminalError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number | null;
}

/** An append-only delivery_attempt history row (the reconstructable retry trail). */
export interface AttemptView {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly attemptNo: number;
  readonly correlationId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: AttemptOutcome;
  readonly ackRef: string | null;
  readonly errorDetail: string | null;
}

/** The per-message result of a publish pass. */
export interface PublishMessageResult {
  readonly messageId: string;
  readonly status: OutboxPublishStatus;
  readonly attempt: number;
  readonly ackRef: string | null;
  /** Set when the message exhausted retries and was dead-lettered. */
  readonly deadLetterId: string | null;
  /** True iff the row was already terminal / not claimable (no publish performed). */
  readonly skipped: boolean;
}

/** The aggregate result of a single `runOnce` drain pass. */
export interface DrainResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly results: readonly PublishMessageResult[];
}

// ===========================================================================
// 3. Backoff (deterministic — no wall clock, no randomness in this module)
// ===========================================================================

/**
 * Bounded exponential backoff for the NEXT attempt given the attempt number just completed.
 * Deterministic (no jitter) so retry-bounding is provable; capped at maxBackoffMs.
 */
export function nextBackoffMs(attemptJustCompleted: number, baseMs: number, capMs: number): number {
  const exp = Math.min(attemptJustCompleted - 1, 30); // guard against overflow
  const raw = baseMs * 2 ** Math.max(0, exp);
  return Math.min(raw, capMs);
}

// ===========================================================================
// 4. SQL — the claim / acknowledge / retry / dead-letter statements
// ===========================================================================
//
// These target db/migrations/0004_delivery.sql. The claim is a guarded UPDATE with a status
// predicate, so it is atomic under the row's advisory lock: two workers racing to claim the
// same row — only one UPDATE matches the `status IN ('pending','failed')` predicate.

/** Read the batch of due, claimable rows (pending, or failed with next_attempt_at reached). */
async function selectDue(
  tx: SqlExecutor,
  now: number,
  limit: number,
): Promise<OutboxRowView[]> {
  const res = await tx.query<OutboxDbRow>(
    `SELECT * FROM outbox_message
      WHERE status = 'pending'
         OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
      ORDER BY created_at ASC
      LIMIT $2`,
    [now, limit],
  );
  return res.rows.map(mapOutboxRow);
}

/**
 * Atomically CLAIM one row: flip `pending|failed` -> `publishing`, stamp the lease. The status
 * predicate makes this a compare-and-set — it affects 0 rows if another worker already claimed
 * or the row is terminal. Returns the claimed row (independent re-read) or null if not claimed.
 */
async function claimRow(
  tx: SqlExecutor,
  messageId: string,
  workerId: string,
  now: number,
): Promise<OutboxRowView | null> {
  const upd = await tx.query(
    `UPDATE outbox_message
        SET status = 'publishing', claimed_by = $2, claimed_at = $3, updated_at = $3
      WHERE message_id = $1
        AND status IN ('pending', 'failed')`,
    [messageId, workerId, now],
  );
  if ((upd.rowCount ?? 0) === 0) return null;
  return readOutboxRow(tx, messageId);
}

/** Mark a claimed row PUBLISHED with its durable acknowledgement (the only success path). */
async function markPublished(
  tx: SqlExecutor,
  messageId: string,
  attempts: number,
  ackRef: string,
  now: number,
): Promise<void> {
  await tx.query(
    `UPDATE outbox_message
        SET status = 'published', attempts = $2, ack_ref = $3,
            next_attempt_at = NULL, terminal_error = NULL, claimed_by = NULL, updated_at = $4
      WHERE message_id = $1`,
    [messageId, attempts, ackRef, now],
  );
}

/** Return a row to `failed` and schedule a bounded next attempt (retryable/uncertain). */
async function markFailedForRetry(
  tx: SqlExecutor,
  messageId: string,
  attempts: number,
  nextAttemptAt: number,
  detail: string,
  now: number,
): Promise<void> {
  await tx.query(
    `UPDATE outbox_message
        SET status = 'failed', attempts = $2, next_attempt_at = $3,
            terminal_error = $4, claimed_by = NULL, updated_at = $5
      WHERE message_id = $1`,
    [messageId, attempts, nextAttemptAt, detail, now],
  );
}

/** Move a row to terminal `dead_letter` (retry bound exhausted or fatal rejection). */
async function markDeadLetter(
  tx: SqlExecutor,
  messageId: string,
  attempts: number,
  detail: string,
  now: number,
): Promise<void> {
  await tx.query(
    `UPDATE outbox_message
        SET status = 'dead_letter', attempts = $2, next_attempt_at = NULL,
            terminal_error = $3, claimed_by = NULL, updated_at = $4
      WHERE message_id = $1`,
    [messageId, attempts, detail, now],
  );
}

/** Append one immutable delivery_attempt row (the reconstructable retry trail). */
async function insertAttempt(
  tx: SqlExecutor,
  row: {
    attemptId: string;
    tenantId: string;
    messageId: string;
    attemptNo: number;
    correlationId: string;
    startedAt: number;
    endedAt: number;
    outcome: AttemptOutcome;
    ackRef: string | null;
    errorDetail: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO delivery_attempt
       (attempt_id, tenant_id, origin, message_id, attempt_no, correlation_id,
        started_at, ended_at, outcome, ack_ref, error_detail)
     VALUES ($1,$2,'outbox',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      row.attemptId,
      row.tenantId,
      row.messageId,
      row.attemptNo,
      row.correlationId,
      row.startedAt,
      row.endedAt,
      row.outcome,
      row.ackRef,
      row.errorDetail,
    ],
  );
}

/** Write the terminal DeadLetterRecord (original evidence retained, owner + scope recorded). */
async function insertDeadLetter(
  tx: SqlExecutor,
  row: {
    deadLetterId: string;
    tenantId: string;
    originMessageId: string;
    correlationId: string;
    failureClass: string;
    attempts: number;
    originalPayload: string;
    originalDigest: string;
    owner: string;
    affectedScope: string;
    businessImpact: string;
    now: number;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO dead_letter_record
       (dead_letter_id, tenant_id, origin, origin_message_id, correlation_id,
        contract_version, schema_version, failure_class, attempts,
        original_payload, original_digest, owner, affected_scope, business_impact,
        outcome, first_seen_at, updated_at)
     VALUES ($1,$2,'outbox',$3,$4,'n/a','n/a',$5,$6,$7,$8,$9,$10,$11,'open',$12,$12)
     ON CONFLICT (tenant_id, origin, origin_message_id) DO NOTHING`,
    [
      row.deadLetterId,
      row.tenantId,
      row.originMessageId,
      row.correlationId,
      row.failureClass,
      row.attempts,
      row.originalPayload,
      row.originalDigest,
      row.owner,
      row.affectedScope,
      row.businessImpact,
      row.now,
    ],
  );
}

// ===========================================================================
// 5. Independent read paths — the durable witnesses
// ===========================================================================

interface OutboxDbRow {
  readonly message_id: string;
  readonly tenant_id: string;
  readonly topic: string;
  readonly payload_json: string;
  readonly payload_digest: string;
  readonly correlation_id: string;
  readonly status: OutboxPublishStatus;
  readonly attempts: number;
  readonly max_attempts: number | null;
  readonly next_attempt_at: number | null;
  readonly ack_ref: string | null;
  readonly claimed_by: string | null;
  readonly claimed_at: number | null;
  readonly terminal_error: string | null;
  readonly created_at: number;
  readonly updated_at: number | null;
}

function mapOutboxRow(r: OutboxDbRow): OutboxRowView {
  return {
    messageId: r.message_id,
    tenantId: r.tenant_id,
    topic: r.topic,
    payload: JSON.parse(r.payload_json),
    payloadDigest: r.payload_digest,
    correlationId: r.correlation_id,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts ?? 8,
    nextAttemptAt: r.next_attempt_at ?? null,
    ackRef: r.ack_ref ?? null,
    claimedBy: r.claimed_by ?? null,
    claimedAt: r.claimed_at ?? null,
    terminalError: r.terminal_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

async function readOutboxRow(tx: SqlExecutor, messageId: string): Promise<OutboxRowView | null> {
  const res = await tx.query<OutboxDbRow>(
    'SELECT * FROM outbox_message WHERE message_id = $1',
    [messageId],
  );
  const r = res.rows[0];
  return r ? mapOutboxRow(r) : null;
}

/** Public independent read path: the current durable state of an outbox message. */
export function readOutboxMessage(
  db: Database,
  messageId: string,
): Promise<OutboxRowView | null> {
  return readOutboxRow(db, messageId);
}

/** Public independent read path: the append-only publish-attempt history for a message. */
export async function readAttempts(
  db: Database,
  tenantId: string,
  messageId: string,
): Promise<AttemptView[]> {
  const res = await db.query<{
    attempt_id: string;
    tenant_id: string;
    message_id: string;
    attempt_no: number;
    correlation_id: string;
    started_at: number;
    ended_at: number | null;
    outcome: AttemptOutcome;
    ack_ref: string | null;
    error_detail: string | null;
  }>(
    `SELECT * FROM delivery_attempt
      WHERE tenant_id = $1 AND origin = 'outbox' AND message_id = $2
      ORDER BY attempt_no ASC`,
    [tenantId, messageId],
  );
  return res.rows.map((r) => ({
    attemptId: r.attempt_id,
    tenantId: r.tenant_id,
    messageId: r.message_id,
    attemptNo: r.attempt_no,
    correlationId: r.correlation_id,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    outcome: r.outcome,
    ackRef: r.ack_ref ?? null,
    errorDetail: r.error_detail ?? null,
  }));
}

/** Public independent read path: the dead-letter record for a failed outbox message, if any. */
export async function readDeadLetter(
  db: Database,
  tenantId: string,
  messageId: string,
): Promise<{ deadLetterId: string; failureClass: string; attempts: number; outcome: string } | null> {
  const res = await db.query<{
    dead_letter_id: string;
    failure_class: string;
    attempts: number;
    outcome: string;
  }>(
    `SELECT dead_letter_id, failure_class, attempts, outcome
       FROM dead_letter_record
      WHERE tenant_id = $1 AND origin = 'outbox' AND origin_message_id = $2`,
    [tenantId, messageId],
  );
  const r = res.rows[0];
  return r
    ? {
        deadLetterId: r.dead_letter_id,
        failureClass: r.failure_class,
        attempts: r.attempts,
        outcome: r.outcome,
      }
    : null;
}

// ===========================================================================
// 6. Deterministic identity derivation
// ===========================================================================

function deriveAttemptId(messageId: string, attemptNo: number): string {
  return 'att-' + digest({ messageId, attemptNo, kind: 'outbox_attempt' }).slice(0, 32);
}

function deriveDeadLetterId(messageId: string): string {
  return 'dlq-' + digest({ messageId, kind: 'outbox_dead_letter' }).slice(0, 32);
}

function normalizeOutcome(err: unknown): { outcome: Exclude<PublishOutcome, 'acknowledged'>; detail: string } {
  if (err instanceof PublishError) return { outcome: err.outcome, detail: err.message };
  // An unclassified throw is treated as UNCERTAIN — the safest class: it is retried within the
  // bound and NEVER reported as a successful publish.
  const detail = err instanceof Error ? err.message : String(err);
  return { outcome: 'uncertain', detail };
}

// ===========================================================================
// 7. The publisher
// ===========================================================================

export class OutboxPublisher {
  readonly #db: Database;
  readonly #bus: OutboxBusPublisher;
  readonly #workerId: string;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #deadLetterOwner: string;

  constructor(db: Database, opts: OutboxPublisherOptions) {
    if (!opts.workerId || opts.workerId.trim().length === 0) {
      throw new Error('OutboxPublisher requires a non-empty workerId');
    }
    this.#db = db;
    this.#bus = opts.bus;
    this.#workerId = opts.workerId;
    this.#baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.#maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#deadLetterOwner = opts.deadLetterOwner ?? DEFAULT_DEAD_LETTER_OWNER;
  }

  /**
   * Drain up to `limit` due outbox messages in one pass. Each message is CLAIMED, PUBLISHED, and
   * ACKNOWLEDGED (or retried / dead-lettered) independently. Returns a per-message summary.
   */
  async runOnce(limit = 100): Promise<DrainResult> {
    const now0 = this.#db.now();
    // Snapshot the due batch on the pool (a claim will re-check the status predicate atomically).
    const due = await this.#db.query<OutboxDbRow>(
      `SELECT message_id FROM outbox_message
        WHERE status = 'pending'
           OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
        ORDER BY created_at ASC
        LIMIT $2`,
      [now0, limit],
    );

    const results: PublishMessageResult[] = [];
    let claimed = 0;
    let published = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const { message_id } of due.rows) {
      const r = await this.publishOne(message_id);
      results.push(r);
      if (!r.skipped) claimed++;
      if (r.status === 'published') published++;
      else if (r.status === 'failed') retried++;
      else if (r.status === 'dead_letter') deadLettered++;
    }

    return { claimed, published, retried, deadLettered, results };
  }

  /**
   * Claim, publish, and acknowledge (or retry / dead-letter) a SINGLE outbox message. The claim
   * and the terminal state transition each run in their own advisory-locked transaction so two
   * workers never publish the same message twice, and the publish() call itself runs OUTSIDE the
   * transaction (a slow/hung broker never holds a DB transaction open).
   */
  async publishOne(messageId: string): Promise<PublishMessageResult> {
    // --- (1) Transactional CLAIM under the per-message advisory lock ---
    const claimNow = this.#db.now();
    const claimed = await this.#db.withKeyLock(`outbox:${messageId}`, async (tx) => {
      const row = await readOutboxRow(tx, messageId);
      if (!row) return null;
      if (row.status !== 'pending' && row.status !== 'failed') return null; // already terminal / in-flight
      if (row.status === 'failed' && row.nextAttemptAt !== null && row.nextAttemptAt > claimNow) {
        return null; // not yet due
      }
      return claimRow(tx, messageId, this.#workerId, claimNow);
    });

    if (!claimed) {
      return {
        messageId,
        status: 'skipped-terminal' as unknown as OutboxPublishStatus,
        attempt: 0,
        ackRef: null,
        deadLetterId: null,
        skipped: true,
      };
    }

    const attemptNo = claimed.attempts + 1;
    const startedAt = this.#db.now();

    // --- (2) PUBLISH outside the transaction (bounded by the broker, not the DB) ---
    let result: PublishResult;
    try {
      result = await this.#bus.publish({
        messageId: claimed.messageId,
        tenantId: claimed.tenantId,
        topic: claimed.topic,
        payload: claimed.payload,
        payloadDigest: claimed.payloadDigest,
        correlationId: claimed.correlationId,
        attempt: attemptNo,
      });
    } catch (err) {
      const { outcome, detail } = normalizeOutcome(err);
      result = { outcome, detail };
    }

    const endedAt = this.#db.now();

    // --- (3) Record the terminal state transition + append the attempt row atomically ---
    if (result.outcome === 'acknowledged') {
      const ackRef = result.ack?.ackRef;
      if (!ackRef || ackRef.trim().length === 0) {
        // A publisher that claims success without a durable ack is NOT trusted — treat as
        // uncertain so the message is retried and never falsely reported published.
        return this.#recordRetryOrDeadLetter(
          claimed,
          attemptNo,
          startedAt,
          endedAt,
          'uncertain',
          'publisher returned acknowledged without an ack reference',
        );
      }
      await this.#db.withKeyLock(`outbox:${messageId}`, async (tx) => {
        await markPublished(tx, messageId, attemptNo, ackRef, endedAt);
        await insertAttempt(tx, {
          attemptId: deriveAttemptId(messageId, attemptNo),
          tenantId: claimed.tenantId,
          messageId,
          attemptNo,
          correlationId: claimed.correlationId,
          startedAt,
          endedAt,
          outcome: 'succeeded',
          ackRef,
          errorDetail: null,
        });
      });
      return {
        messageId,
        status: 'published',
        attempt: attemptNo,
        ackRef,
        deadLetterId: null,
        skipped: false,
      };
    }

    return this.#recordRetryOrDeadLetter(
      claimed,
      attemptNo,
      startedAt,
      endedAt,
      result.outcome,
      result.detail ?? `publish ${result.outcome}`,
    );
  }

  /**
   * Apply the bounded-retry / dead-letter policy for a non-acknowledged attempt and append the
   * attempt row — all in ONE advisory-locked transaction so the state and its history are
   * consistent.
   */
  async #recordRetryOrDeadLetter(
    claimed: OutboxRowView,
    attemptNo: number,
    startedAt: number,
    endedAt: number,
    outcome: Exclude<PublishOutcome, 'acknowledged'>,
    detail: string,
  ): Promise<PublishMessageResult> {
    const messageId = claimed.messageId;
    const attemptOutcome: AttemptOutcome =
      outcome === 'uncertain' ? 'uncertain' : outcome === 'retryable' ? 'retryable' : 'failed';

    // A `fatal` rejection dead-letters immediately; retryable/uncertain dead-letter only when the
    // bound is reached. Retries are ALWAYS bounded by max_attempts.
    const exhausted = attemptNo >= claimed.maxAttempts;
    const deadLetter = outcome === 'fatal' || exhausted;

    return this.#db.withKeyLock(`outbox:${messageId}`, async (tx) => {
      await insertAttempt(tx, {
        attemptId: deriveAttemptId(messageId, attemptNo),
        tenantId: claimed.tenantId,
        messageId,
        attemptNo,
        correlationId: claimed.correlationId,
        startedAt,
        endedAt,
        outcome: attemptOutcome,
        ackRef: null,
        errorDetail: detail,
      });

      if (deadLetter) {
        const failureClass = outcome === 'fatal' ? 'non_retryable' : 'retry_exhausted';
        await markDeadLetter(tx, messageId, attemptNo, detail, endedAt);
        const deadLetterId = deriveDeadLetterId(messageId);
        await insertDeadLetter(tx, {
          deadLetterId,
          tenantId: claimed.tenantId,
          originMessageId: messageId,
          correlationId: claimed.correlationId,
          failureClass,
          attempts: attemptNo,
          originalPayload: canonicalJson(claimed.payload),
          originalDigest: claimed.payloadDigest,
          owner: this.#deadLetterOwner,
          affectedScope: `tenant:${claimed.tenantId}/topic:${claimed.topic}`,
          businessImpact: `undelivered governance notification on ${claimed.topic}`,
          now: endedAt,
        });
        return {
          messageId,
          status: 'dead_letter' as OutboxPublishStatus,
          attempt: attemptNo,
          ackRef: null,
          deadLetterId,
          skipped: false,
        };
      }

      const backoff = nextBackoffMs(attemptNo, this.#baseBackoffMs, this.#maxBackoffMs);
      const nextAttemptAt = endedAt + backoff;
      await markFailedForRetry(tx, messageId, attemptNo, nextAttemptAt, detail, endedAt);
      return {
        messageId,
        status: 'failed' as OutboxPublishStatus,
        attempt: attemptNo,
        ackRef: null,
        deadLetterId: null,
        skipped: false,
      };
    });
  }
}

// Re-export the due-selection helper for callers that want to inspect the claimable backlog.
export { selectDue };
