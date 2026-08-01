// @trustcircle/projector — the durable INBOX CONSUMER (Phase 28 / task T028 / GAR-008).
//
// ─────────────────────────────────────────────────────────────────────────────
// Phase-primary oracle (GAR-008 / VO-52d0780c11bcc6fd7583, the SOLE acceptance criterion):
//
//   "Every onboarded source contract MUST be versioned and validated; mutating operations
//    MUST be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
//    delayed, partial, conflicting, and uncertain outcomes."
//
// The transactional-outbox PUBLISHER (apps/command-worker/src/outbox-publisher.ts, Phase 27)
// is at-least-once: an uncertain publish outcome is retried and can therefore be DELIVERED
// MORE THAN ONCE. This module is the consumer-side counterpart that makes the end-to-end
// pipeline exactly-once-in-effect. It CONSUMES governance events off the bus, RECOGNISES
// duplicates durably, APPLIES them to the read model IN AGGREGATE ORDER, QUARANTINES the
// unsafe/ambiguous ones from execution while keeping them visible, and records the consume
// ACKNOWLEDGEMENT — all with BOUNDED retries and safe behavior under duplicate, delayed,
// partial, conflicting, and uncertain outcomes. The durable substrate it operates on is
// db/migrations/0004_delivery.sql (inbox_message + delivery_attempt + inbox_cursor +
// inbox_cursor_history + dead_letter_record).
//
// The runtime source contract it enforces is packages/contracts/src/events.ts: every event
// is VERSIONED + VALIDATED (validateEnvelope) before it can touch the read model, and its
// position in the per-aggregate stream is classified with the pure, total, non-throwing
// ordering decision (classifyDelivery / applyDelivery) over the (tenant, aggregate_type,
// aggregate_id) correlation key.
//
// The invariants this consumer makes independently observable:
//
//   1. DURABLE DEDUP (deduplicated). Each event is recorded in inbox_message keyed on the
//      dedup identity (tenant_id, consumer, event_id). A re-delivery of an event that was
//      already applied is recognised as a `duplicate` and its business effect (the read-model
//      apply) is NOT run a second time — the projector callback fires at most once per event.
//      The recognition survives a process restart because it is read from the durable row, not
//      an in-memory set.
//
//   2. ORDERED APPLY (correlated + safe under delayed/out-of-order). An event is applied to the
//      read model ONLY when it is the expected next aggregate_version (classifyDelivery ⇒
//      `apply`). A later version that arrives before its predecessor (`out_of_order`/`gap`) is
//      BUFFERED in inbox_message as `buffered` and NEVER applied out of order — the aggregate
//      cursor never regresses. When the missing predecessor later arrives and applies, buffered
//      successors are drained in order.
//
//   3. QUARANTINE (safe under conflicting / uncertain). An event that would trigger an unsafe or
//      ambiguous action — a `conflict` (a different event already occupies this aggregate slot)
//      or an envelope the caller's guard flags as unsafe — is moved to `quarantined`. A
//      quarantined event is BLOCKED from execution (its apply callback is never run) yet remains
//      VISIBLE and inspectable through the independent read path (readInboxMessage /
//      listQuarantined), and the original payload evidence is retained. It never silently
//      advances the cursor.
//
//   4. ACKNOWLEDGEMENT rules (retry-bounded). A message is ACKed to the bus (removed from
//      redelivery) ONLY on a terminal consume outcome: `applied`, `duplicate`, `quarantined`,
//      or `dead_letter`. A `buffered` (awaiting predecessor) or a `retryable` transient failure
//      is NACKed so the bus redelivers it. Each attempt increments `attempts`; a retryable
//      failure is retried UP TO max_attempts, after which the message is dead-lettered (the
//      ORIGINAL evidence retained) — the consumer NEVER retries unboundedly.
//
//   5. RECONSTRUCTABLE (reconcilable). Every consume attempt appends an immutable
//      delivery_attempt row carrying the correlation id and attempt ordinal, and every applied
//      event advances the monotonic inbox_cursor with an append-only inbox_cursor_history entry.
//      The full ingest history (last applied, buffered, quarantined, dead-lettered, retry state)
//      is reconstructable through the independent read path — the consume() return value is never
//      trusted as the proof of effect.
//
// The module reuses the transactional core in @trustcircle/persistence through its PUBLIC seam
// (Database.withKeyLock / query) and the runtime contract in @trustcircle/contracts, adding no
// new infrastructure: production wires the real `pg` Pool and a JetStream pull consumer; tests
// wire a deterministic in-memory driver, so every invariant above is provable under `npm ci`
// with no live database or broker, under Node 22 `--experimental-strip-types` / tsx.

import { type Database, type SqlExecutor, digest, canonicalJson } from '@trustcircle/persistence';
import {
  type AggregateState,
  type DeliveryClassification,
  type DeliveryDecision,
  aggregateKey,
  applyDelivery,
  emptyAggregateState,
  validateEnvelope,
  SUPPORTED_SCHEMA_VERSION,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. The projector apply seam + the unsafe-action guard
// ===========================================================================

/** The minimal envelope shape the consumer keys ordering / dedup on. */
export interface InboxEnvelope {
  readonly schema_version: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly correlation_id: string;
  readonly [k: string]: unknown;
}

/**
 * The read-model apply callback. Invoked AT MOST ONCE per (tenant, consumer, event_id) and only
 * for an in-order, validated, non-quarantined event. Its return value is advisory; the durable
 * effect is the inbox_message row + cursor advance the consumer writes transactionally. A throw
 * is treated as a transient failure (retried within the bound), unless it is a `FatalApplyError`.
 */
export type ApplyProjection = (env: InboxEnvelope) => Promise<void> | void;

/**
 * A caller-supplied guard that classifies an event as UNSAFE/AMBIGUOUS to execute. Returning a
 * non-null reason quarantines the event (blocked from execution, still visible). Returning null
 * lets it proceed to ordered apply. This is how a domain flags "may trigger unsafe or ambiguous
 * action" beyond the structural `conflict` the ordering tracker already quarantines.
 */
export type UnsafeActionGuard = (env: InboxEnvelope) => string | null;

/** A projector may throw this to signal a NON-retryable apply failure (immediate dead-letter). */
export class FatalApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalApplyError';
  }
}

// ===========================================================================
// 1. Consumer configuration
// ===========================================================================

export interface InboxConsumerOptions {
  /** The durable consumer name — half of the (tenant, consumer, event_id) dedup identity. */
  readonly consumer: string;
  /** The read-model apply callback (fired at most once per event, only when in-order + safe). */
  readonly apply: ApplyProjection;
  /** Optional unsafe/ambiguous-action guard; quarantines on a non-null reason. */
  readonly unsafeGuard?: UnsafeActionGuard;
  /** The source stream/subject the cursor is tracked against. Default 'governance'. */
  readonly stream?: string;
  /** Retry bound for a transient apply failure before dead-lettering. Default 8. */
  readonly maxAttempts?: number;
  /** Accountable owner recorded on a dead-letter record. Default 'team:platform-delivery'. */
  readonly deadLetterOwner?: string;
}

const DEFAULT_STREAM = 'governance';
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_DEAD_LETTER_OWNER = 'team:platform-delivery';

// ===========================================================================
// 2. Consume outcomes (the bus acknowledgement contract) + row views
// ===========================================================================

/**
 * The terminal-or-not consume disposition. The bus ACK rule is a pure function of this:
 *   applied | duplicate | quarantined | dead_letter  → ACK  (terminal; stop redelivery)
 *   buffered | retry                                 → NACK (redeliver later)
 */
export type ConsumeDisposition =
  'applied' | 'duplicate' | 'buffered' | 'quarantined' | 'retry' | 'dead_letter' | 'rejected';

/** The durable processing state stored on an inbox_message row. */
export type InboxProcessingState =
  'applied' | 'buffered' | 'quarantined' | 'failed' | 'dead_letter';

/** Bus acknowledgement instruction — the ONLY thing the consumer tells the transport. */
export type BusAck = 'ack' | 'nack';

/** Whether a given disposition ACKs (terminal, stop redelivery) or NACKs (redeliver). */
export function ackFor(disposition: ConsumeDisposition): BusAck {
  switch (disposition) {
    case 'applied':
    case 'duplicate':
    case 'quarantined':
    case 'dead_letter':
    case 'rejected':
      return 'ack';
    case 'buffered':
    case 'retry':
      return 'nack';
  }
}

/** The per-event result of one consume() call. */
export interface ConsumeResult {
  readonly eventId: string;
  readonly disposition: ConsumeDisposition;
  /** The bus acknowledgement instruction derived from the disposition. */
  readonly ack: BusAck;
  /** True iff the read-model apply callback fired on THIS call (exactly-once effect witness). */
  readonly applied: boolean;
  /** The ordering decision the contract tracker produced (for observability). */
  readonly decision: DeliveryDecision | 'skipped';
  /** Attempt ordinal recorded for this consume. */
  readonly attempt: number;
  /** Set when the message exhausted retries / hit a fatal failure and was dead-lettered. */
  readonly deadLetterId: string | null;
  /** Human-readable rationale. */
  readonly reason: string;
}

/** The durable inbox_message row as read back (independent read path). */
export interface InboxRowView {
  readonly tenantId: string;
  readonly consumer: string;
  readonly eventId: string;
  readonly schemaVersion: string;
  readonly payloadDigest: string;
  readonly correlationId: string;
  readonly receivedAt: number;
  readonly processingState: InboxProcessingState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly resultCursor: string | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

/** An append-only delivery_attempt (inbox origin) history row. */
export interface InboxAttemptView {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly attemptNo: number;
  readonly correlationId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly outcome: string;
  readonly errorDetail: string | null;
}

/** The durable per-aggregate cursor (independent read path for the applied position). */
export interface InboxCursorView {
  readonly tenantId: string;
  readonly consumer: string;
  readonly stream: string;
  readonly cursorValue: string;
  readonly cursorSeq: number;
  readonly correlationId: string;
  readonly updatedAt: number;
}

// ===========================================================================
// 3. SQL — dedup insert / state transitions / attempt + cursor history
// ===========================================================================
//
// These target db/migrations/0004_delivery.sql. The dedup INSERT is guarded by the
// (tenant_id, consumer, event_id) primary key: a redelivery cannot insert twice. The cursor
// advance UPDATE is guarded at the DB by the inbox_cursor_no_regress trigger, so an
// out-of-order/duplicate can never move the applied position backward.

interface InboxDbRow {
  readonly tenant_id: string;
  readonly consumer: string;
  readonly event_id: string;
  readonly schema_version: string;
  readonly payload_digest: string;
  readonly evidence_ref: string | null;
  readonly correlation_id: string;
  readonly received_at: number;
  readonly processing_state: InboxProcessingState;
  readonly attempts: number;
  readonly max_attempts: number | null;
  readonly result_cursor: string | null;
  readonly last_error: string | null;
  readonly updated_at: number;
  readonly payload_json?: string | null;
}

function mapInboxRow(r: InboxDbRow): InboxRowView {
  return {
    tenantId: r.tenant_id,
    consumer: r.consumer,
    eventId: r.event_id,
    schemaVersion: r.schema_version,
    payloadDigest: r.payload_digest,
    correlationId: r.correlation_id,
    receivedAt: r.received_at,
    processingState: r.processing_state,
    attempts: r.attempts,
    maxAttempts: r.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
    resultCursor: r.result_cursor ?? null,
    lastError: r.last_error ?? null,
    updatedAt: r.updated_at,
  };
}

async function readInboxRow(
  tx: SqlExecutor,
  tenantId: string,
  consumer: string,
  eventId: string,
): Promise<(InboxRowView & { payloadJson: string | null }) | null> {
  const res = await tx.query<InboxDbRow>(
    `SELECT * FROM inbox_message
      WHERE tenant_id = $1 AND consumer = $2 AND event_id = $3`,
    [tenantId, consumer, eventId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { ...mapInboxRow(r), payloadJson: r.payload_json ?? null };
}

/**
 * Insert-or-select the inbox_message row under its dedup key. Returns the EXISTING row when the
 * event was already recorded (a durable duplicate), else inserts a fresh `buffered` row and
 * returns null (first sight). The ON CONFLICT DO NOTHING makes concurrent first-sights safe:
 * exactly one insert wins; the loser reads the existing row.
 */
async function insertInboxIfAbsent(
  tx: SqlExecutor,
  row: {
    tenantId: string;
    consumer: string;
    eventId: string;
    schemaVersion: string;
    payloadDigest: string;
    payloadJson: string;
    correlationId: string;
    maxAttempts: number;
    now: number;
  },
): Promise<{ inserted: boolean }> {
  const res = await tx.query(
    `INSERT INTO inbox_message
       (tenant_id, consumer, event_id, schema_version, payload_digest, payload_json,
        correlation_id, received_at, processing_state, attempts, max_attempts,
        result_cursor, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'buffered',0,$9,NULL,NULL,$8)
     ON CONFLICT (tenant_id, consumer, event_id) DO NOTHING`,
    [
      row.tenantId,
      row.consumer,
      row.eventId,
      row.schemaVersion,
      row.payloadDigest,
      row.payloadJson,
      row.correlationId,
      row.now,
      row.maxAttempts,
    ],
  );
  return { inserted: (res.rowCount ?? 0) === 1 };
}

/** Move an inbox row to a terminal/non-terminal processing state, stamping attempts + error. */
async function setInboxState(
  tx: SqlExecutor,
  tenantId: string,
  consumer: string,
  eventId: string,
  state: InboxProcessingState,
  attempts: number,
  resultCursor: string | null,
  lastError: string | null,
  now: number,
): Promise<void> {
  await tx.query(
    `UPDATE inbox_message
        SET processing_state = $4, attempts = $5, result_cursor = $6,
            last_error = $7, updated_at = $8
      WHERE tenant_id = $1 AND consumer = $2 AND event_id = $3`,
    [tenantId, consumer, eventId, state, attempts, resultCursor, lastError, now],
  );
}

/** Append one immutable delivery_attempt row (inbox origin) — the reconstructable trail. */
async function insertAttempt(
  tx: SqlExecutor,
  row: {
    attemptId: string;
    tenantId: string;
    eventId: string;
    attemptNo: number;
    correlationId: string;
    startedAt: number;
    endedAt: number;
    outcome: string;
    errorDetail: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO delivery_attempt
       (attempt_id, tenant_id, origin, message_id, attempt_no, correlation_id,
        started_at, ended_at, outcome, ack_ref, error_detail)
     VALUES ($1,$2,'inbox',$3,$4,$5,$6,$7,$8,NULL,$9)
     ON CONFLICT (tenant_id, origin, message_id, attempt_no) DO NOTHING`,
    [
      row.attemptId,
      row.tenantId,
      row.eventId,
      row.attemptNo,
      row.correlationId,
      row.startedAt,
      row.endedAt,
      row.outcome,
      row.errorDetail,
    ],
  );
}

/** Advance the monotonic inbox_cursor for an aggregate + append the history row. */
async function advanceCursor(
  tx: SqlExecutor,
  row: {
    tenantId: string;
    consumer: string;
    stream: string;
    cursorValue: string;
    cursorSeq: number;
    correlationId: string;
    now: number;
  },
): Promise<void> {
  // Upsert the cursor. The DB inbox_cursor_no_regress BEFORE-UPDATE trigger rejects a backward
  // seq, so an out-of-order/duplicate can never move the applied position backward.
  await tx.query(
    `INSERT INTO inbox_cursor
       (tenant_id, consumer, stream, cursor_value, cursor_seq, correlation_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, consumer, stream)
       DO UPDATE SET cursor_value = EXCLUDED.cursor_value,
                     cursor_seq   = EXCLUDED.cursor_seq,
                     correlation_id = EXCLUDED.correlation_id,
                     updated_at   = EXCLUDED.updated_at`,
    [
      row.tenantId,
      row.consumer,
      row.stream,
      row.cursorValue,
      row.cursorSeq,
      row.correlationId,
      row.now,
    ],
  );
  // Append-only history row (guarded against mutation by inbox_cursor_history_append_only).
  await tx.query(
    `INSERT INTO inbox_cursor_history
       (history_id, tenant_id, consumer, stream, cursor_value, cursor_seq, correlation_id, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, consumer, stream, cursor_seq) DO NOTHING`,
    [
      deriveCursorHistoryId(row.tenantId, row.consumer, row.stream, row.cursorSeq),
      row.tenantId,
      row.consumer,
      row.stream,
      row.cursorValue,
      row.cursorSeq,
      row.correlationId,
      row.now,
    ],
  );
}

/** Write the terminal DeadLetterRecord (inbox origin) — original evidence retained. */
async function insertDeadLetter(
  tx: SqlExecutor,
  row: {
    deadLetterId: string;
    tenantId: string;
    eventId: string;
    correlationId: string;
    schemaVersion: string;
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
     VALUES ($1,$2,'inbox',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open',$14,$14)
     ON CONFLICT (tenant_id, origin, origin_message_id) DO NOTHING`,
    [
      row.deadLetterId,
      row.tenantId,
      row.eventId,
      row.correlationId,
      row.schemaVersion,
      row.schemaVersion,
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
// 4. Independent read paths — the durable witnesses
// ===========================================================================

/** Public independent read path: the current durable state of an inbox message. */
export async function readInboxMessage(
  db: Database,
  tenantId: string,
  consumer: string,
  eventId: string,
): Promise<InboxRowView | null> {
  const r = await readInboxRow(db, tenantId, consumer, eventId);
  if (!r) return null;
  const { payloadJson: _drop, ...view } = r;
  return view;
}

/** Public independent read path: the append-only consume-attempt history for an event. */
export async function readInboxAttempts(
  db: Database,
  tenantId: string,
  eventId: string,
): Promise<InboxAttemptView[]> {
  const res = await db.query<{
    attempt_id: string;
    tenant_id: string;
    message_id: string;
    attempt_no: number;
    correlation_id: string;
    started_at: number;
    ended_at: number | null;
    outcome: string;
    error_detail: string | null;
  }>(
    `SELECT * FROM delivery_attempt
      WHERE tenant_id = $1 AND origin = 'inbox' AND message_id = $2
      ORDER BY attempt_no ASC`,
    [tenantId, eventId],
  );
  return res.rows.map((r) => ({
    attemptId: r.attempt_id,
    tenantId: r.tenant_id,
    eventId: r.message_id,
    attemptNo: r.attempt_no,
    correlationId: r.correlation_id,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    outcome: r.outcome,
    errorDetail: r.error_detail ?? null,
  }));
}

/** Public independent read path: the durable applied cursor for a consumer's stream. */
export async function readInboxCursor(
  db: Database,
  tenantId: string,
  consumer: string,
  stream: string,
): Promise<InboxCursorView | null> {
  const res = await db.query<{
    tenant_id: string;
    consumer: string;
    stream: string;
    cursor_value: string;
    cursor_seq: number;
    correlation_id: string;
    updated_at: number;
  }>(`SELECT * FROM inbox_cursor WHERE tenant_id = $1 AND consumer = $2 AND stream = $3`, [
    tenantId,
    consumer,
    stream,
  ]);
  const r = res.rows[0];
  return r
    ? {
        tenantId: r.tenant_id,
        consumer: r.consumer,
        stream: r.stream,
        cursorValue: r.cursor_value,
        cursorSeq: r.cursor_seq,
        correlationId: r.correlation_id,
        updatedAt: r.updated_at,
      }
    : null;
}

/** Public independent read path: quarantined events for a consumer (visible + inspectable). */
export async function listQuarantined(
  db: Database,
  tenantId: string,
  consumer: string,
): Promise<InboxRowView[]> {
  const res = await db.query<InboxDbRow>(
    `SELECT * FROM inbox_message
      WHERE tenant_id = $1 AND consumer = $2 AND processing_state = 'quarantined'
      ORDER BY received_at ASC`,
    [tenantId, consumer],
  );
  return res.rows.map(mapInboxRow);
}

/** Public independent read path: the dead-letter record for a failed inbox event, if any. */
export async function readInboxDeadLetter(
  db: Database,
  tenantId: string,
  eventId: string,
): Promise<{
  deadLetterId: string;
  failureClass: string;
  attempts: number;
  outcome: string;
} | null> {
  const res = await db.query<{
    dead_letter_id: string;
    failure_class: string;
    attempts: number;
    outcome: string;
  }>(
    `SELECT dead_letter_id, failure_class, attempts, outcome
       FROM dead_letter_record
      WHERE tenant_id = $1 AND origin = 'inbox' AND origin_message_id = $2`,
    [tenantId, eventId],
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
// 5. Deterministic identity derivation (no wall clock, no randomness)
// ===========================================================================

function deriveAttemptId(eventId: string, attemptNo: number): string {
  return 'iatt-' + digest({ eventId, attemptNo, kind: 'inbox_attempt' }).slice(0, 32);
}

function deriveDeadLetterId(tenantId: string, consumer: string, eventId: string): string {
  return 'idlq-' + digest({ tenantId, consumer, eventId, kind: 'inbox_dead_letter' }).slice(0, 32);
}

function deriveCursorHistoryId(
  tenantId: string,
  consumer: string,
  stream: string,
  seq: number,
): string {
  return (
    'icur-' + digest({ tenantId, consumer, stream, seq, kind: 'inbox_cursor_hist' }).slice(0, 32)
  );
}

// ===========================================================================
// 6. In-memory per-aggregate ordering rebuild (reconstructable from the durable inbox)
// ===========================================================================
//
// The ordering tracker in @trustcircle/contracts is a pure function of the applied history. The
// consumer rebuilds the AggregateState for an aggregate from the durable inbox_message rows on
// each consume, so the ordering decision survives a restart and is fully reconstructable — the
// authoritative position lives in inbox_message + inbox_cursor, not process memory.

async function rebuildAggregateState(
  tx: SqlExecutor,
  tenantId: string,
  consumer: string,
  aggregateType: string,
  aggregateId: string,
): Promise<AggregateState> {
  const res = await tx.query<{
    event_id: string;
    payload_json: string | null;
    processing_state: InboxProcessingState;
  }>(
    `SELECT event_id, payload_json, processing_state FROM inbox_message
      WHERE tenant_id = $1 AND consumer = $2
      ORDER BY received_at ASC`,
    [tenantId, consumer],
  );
  let state = emptyAggregateState();
  for (const r of res.rows) {
    if (r.processing_state !== 'applied') continue;
    if (!r.payload_json) continue;
    let env: unknown;
    try {
      env = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    const e = env as Partial<InboxEnvelope>;
    if (e.aggregate_type !== aggregateType || e.aggregate_id !== aggregateId) continue;
    // Fold applied events back through the tracker to reconstruct lastAppliedVersion + seen ids.
    state = applyDelivery(state, env).state;
  }
  return state;
}

// ===========================================================================
// 7. The consumer
// ===========================================================================

export class InboxConsumer {
  readonly #db: Database;
  readonly #consumer: string;
  readonly #apply: ApplyProjection;
  readonly #unsafeGuard: UnsafeActionGuard | null;
  readonly #stream: string;
  readonly #maxAttempts: number;
  readonly #deadLetterOwner: string;

  constructor(db: Database, opts: InboxConsumerOptions) {
    if (!opts.consumer || opts.consumer.trim().length === 0) {
      throw new Error('InboxConsumer requires a non-empty consumer name');
    }
    if (typeof opts.apply !== 'function') {
      throw new Error('InboxConsumer requires an apply callback');
    }
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('InboxConsumer maxAttempts must be a positive integer');
    }
    this.#db = db;
    this.#consumer = opts.consumer;
    this.#apply = opts.apply;
    this.#unsafeGuard = opts.unsafeGuard ?? null;
    this.#stream = opts.stream ?? DEFAULT_STREAM;
    this.#maxAttempts = maxAttempts;
    this.#deadLetterOwner = opts.deadLetterOwner ?? DEFAULT_DEAD_LETTER_OWNER;
  }

  /**
   * Consume a single delivered event. Deduplicates durably, validates the versioned contract,
   * classifies its aggregate-stream position, and either APPLIES it (in order), BUFFERS it
   * (out-of-order), QUARANTINES it (conflict/unsafe), or DEAD-LETTERS it (retry-exhausted /
   * fatal / permanently malformed). Returns the disposition + the derived bus ACK instruction.
   *
   * The whole consume runs under the per-aggregate advisory lock so two workers delivering the
   * same aggregate stream never interleave (ordered apply is serialized per aggregate).
   */
  async consume(raw: unknown): Promise<ConsumeResult> {
    // --- (0) VERSIONED + VALIDATED gate (before anything touches the durable inbox) ---
    const validation = validateEnvelope(raw);
    if (!validation.valid) {
      // A structurally invalid / partial message cannot be ordered or keyed. It is rejected and
      // ACKed off the bus (a redelivery of the same bytes will not become valid) — but we still
      // record the ORIGINAL evidence in a dead-letter so it is retained + visible, never lost.
      return this.#rejectMalformed(
        raw,
        validation.problems.map((p) => `${p.path}:${p.code}`).join(','),
      );
    }

    const env = raw as InboxEnvelope;
    const lockKey = `inbox:${this.#consumer}:${aggregateKey(env)}`;

    return this.#db.withKeyLock(lockKey, async (tx) => {
      const now = this.#db.now();

      // --- (1) DURABLE DEDUP: first sight inserts a buffered row; a re-delivery reads it back.
      const payloadJson = canonicalJson(env);
      const payloadDigest = digest(env);
      const insert = await insertInboxIfAbsent(tx, {
        tenantId: env.tenant_id,
        consumer: this.#consumer,
        eventId: env.event_id,
        schemaVersion: env.schema_version,
        payloadDigest,
        payloadJson,
        correlationId: env.correlation_id,
        maxAttempts: this.#maxAttempts,
        now,
      });

      const existing = await readInboxRow(tx, env.tenant_id, this.#consumer, env.event_id);
      if (!existing) {
        // Should be unreachable: we just inserted-or-found it under the lock.
        throw new Error('inbox row vanished after insert-if-absent');
      }

      // A re-delivery of an already-TERMINAL event (applied/quarantined/dead_letter) is a
      // DUPLICATE: the business effect already happened (or was blocked). Do NOT run apply again.
      if (!insert.inserted && isTerminalState(existing.processingState)) {
        return this.#result(
          env,
          'duplicate',
          existing.attempts,
          null,
          `already ${existing.processingState}; no second effect`,
          'duplicate',
          false,
        );
      }

      const attemptNo = existing.attempts + 1;
      const startedAt = now;

      // --- (2) UNSAFE-ACTION GUARD → QUARANTINE (blocked from execution, still visible) ---
      const unsafeReason = this.#unsafeGuard ? this.#unsafeGuard(env) : null;
      if (unsafeReason) {
        await setInboxState(
          tx,
          env.tenant_id,
          this.#consumer,
          env.event_id,
          'quarantined',
          attemptNo,
          null,
          `quarantined: ${unsafeReason}`,
          now,
        );
        await insertAttempt(
          tx,
          this.#attemptRow(env, attemptNo, startedAt, this.#db.now(), 'quarantined', unsafeReason),
        );
        return this.#result(
          env,
          'quarantined',
          attemptNo,
          null,
          `quarantined: ${unsafeReason}`,
          'skipped',
          false,
        );
      }

      // --- (3) ORDERED CLASSIFY over the (tenant, aggregate_type, aggregate_id) stream ---
      const state = await rebuildAggregateState(
        tx,
        env.tenant_id,
        this.#consumer,
        env.aggregate_type,
        env.aggregate_id,
      );
      const step = applyDelivery(state, env);
      const cls: DeliveryClassification = step.classification;

      switch (cls.decision) {
        case 'apply':
          return this.#doApply(tx, env, attemptNo, startedAt, step.state);

        case 'duplicate':
          // The contract tracker recognises a replayed version even before we mark the row
          // terminal — treat as duplicate, no apply.
          await setInboxState(
            tx,
            env.tenant_id,
            this.#consumer,
            env.event_id,
            'applied',
            attemptNo,
            existing.resultCursor,
            'duplicate (replayed version); no second effect',
            now,
          );
          await insertAttempt(
            tx,
            this.#attemptRow(env, attemptNo, startedAt, this.#db.now(), 'succeeded', 'duplicate'),
          );
          return this.#result(
            env,
            'duplicate',
            attemptNo,
            existing.resultCursor,
            cls.reason,
            'duplicate',
            false,
          );

        case 'conflict':
          // A different event already occupies this aggregate slot: QUARANTINE for human
          // resolution. Visible, never silently overwritten, never advances the cursor.
          await setInboxState(
            tx,
            env.tenant_id,
            this.#consumer,
            env.event_id,
            'quarantined',
            attemptNo,
            null,
            `conflict: ${cls.reason}`,
            now,
          );
          await insertAttempt(
            tx,
            this.#attemptRow(env, attemptNo, startedAt, this.#db.now(), 'conflict', cls.reason),
          );
          return this.#result(env, 'quarantined', attemptNo, null, cls.reason, 'conflict', false);

        case 'out_of_order':
        case 'gap':
          // Delayed / out-of-order (or source-ordering-uncertain gap): BUFFER, do NOT apply, do
          // NOT advance the cursor. NACK so the bus redelivers after the predecessor lands.
          return this.#doBuffer(tx, env, attemptNo, startedAt, cls);

        case 'reject':
          // Validation passed at (0), so a reject here is defensive; dead-letter the evidence.
          return this.#doDeadLetter(tx, env, attemptNo, startedAt, 'non_retryable', cls.reason);
      }
    });
  }

  /** Apply in order: run the projector callback, mark applied, advance the monotonic cursor. */
  async #doApply(
    tx: SqlExecutor,
    env: InboxEnvelope,
    attemptNo: number,
    startedAt: number,
    _nextState: AggregateState,
  ): Promise<ConsumeResult> {
    try {
      await this.#apply(env);
    } catch (err) {
      const fatal = err instanceof FatalApplyError;
      const detail = err instanceof Error ? err.message : String(err);
      if (fatal) {
        return this.#doDeadLetter(
          tx,
          env,
          attemptNo,
          startedAt,
          'non_retryable',
          `fatal apply: ${detail}`,
        );
      }
      return this.#doRetryOrDeadLetter(tx, env, attemptNo, startedAt, detail);
    }

    const endedAt = this.#db.now();
    const cursorSeq = env.aggregate_version;
    const cursorValue = `${env.aggregate_type}/${env.aggregate_id}@${env.aggregate_version}`;
    await setInboxState(
      tx,
      env.tenant_id,
      this.#consumer,
      env.event_id,
      'applied',
      attemptNo,
      cursorValue,
      null,
      endedAt,
    );
    await advanceCursor(tx, {
      tenantId: env.tenant_id,
      consumer: this.#consumer,
      stream: this.#stream,
      cursorValue,
      cursorSeq,
      correlationId: env.correlation_id,
      now: endedAt,
    });
    await insertAttempt(
      tx,
      this.#attemptRow(env, attemptNo, startedAt, endedAt, 'succeeded', null),
    );
    return this.#result(
      env,
      'applied',
      attemptNo,
      cursorValue,
      `applied version ${cursorSeq}`,
      'apply',
      true,
    );
  }

  /** Buffer an out-of-order event: recorded (dedup + visible), not applied, NACKed for redelivery. */
  async #doBuffer(
    tx: SqlExecutor,
    env: InboxEnvelope,
    attemptNo: number,
    startedAt: number,
    cls: DeliveryClassification,
  ): Promise<ConsumeResult> {
    // Buffered attempts DO NOT count against the retry bound (they are correctly waiting), so the
    // attempts counter is not incremented here — a genuinely missing predecessor is a
    // reconciliation concern surfaced via readInboxCursor / missing-version views, not a poison.
    await setInboxState(
      tx,
      env.tenant_id,
      this.#consumer,
      env.event_id,
      'buffered',
      0,
      null,
      cls.reason,
      this.#db.now(),
    );
    await insertAttempt(
      tx,
      this.#attemptRow(env, attemptNo, startedAt, this.#db.now(), 'retryable', cls.reason),
    );
    return this.#result(env, 'buffered', attemptNo, null, cls.reason, cls.decision, false);
  }

  /** Bounded retry for a transient apply failure: retry until max_attempts, then dead-letter. */
  async #doRetryOrDeadLetter(
    tx: SqlExecutor,
    env: InboxEnvelope,
    attemptNo: number,
    startedAt: number,
    detail: string,
  ): Promise<ConsumeResult> {
    if (attemptNo >= this.#maxAttempts) {
      return this.#doDeadLetter(tx, env, attemptNo, startedAt, 'retry_exhausted', detail);
    }
    await setInboxState(
      tx,
      env.tenant_id,
      this.#consumer,
      env.event_id,
      'failed',
      attemptNo,
      null,
      detail,
      this.#db.now(),
    );
    await insertAttempt(
      tx,
      this.#attemptRow(env, attemptNo, startedAt, this.#db.now(), 'retryable', detail),
    );
    return this.#result(
      env,
      'retry',
      attemptNo,
      null,
      `transient apply failure (attempt ${attemptNo}/${this.#maxAttempts})`,
      'apply',
      false,
    );
  }

  /** Terminal dead-letter: retain the ORIGINAL evidence, mark the row, ACK off the bus. */
  async #doDeadLetter(
    tx: SqlExecutor,
    env: InboxEnvelope,
    attemptNo: number,
    startedAt: number,
    failureClass: string,
    detail: string,
  ): Promise<ConsumeResult> {
    const endedAt = this.#db.now();
    await setInboxState(
      tx,
      env.tenant_id,
      this.#consumer,
      env.event_id,
      'dead_letter',
      attemptNo,
      null,
      detail,
      endedAt,
    );
    await insertAttempt(tx, this.#attemptRow(env, attemptNo, startedAt, endedAt, 'failed', detail));
    const deadLetterId = deriveDeadLetterId(env.tenant_id, this.#consumer, env.event_id);
    await insertDeadLetter(tx, {
      deadLetterId,
      tenantId: env.tenant_id,
      eventId: env.event_id,
      correlationId: env.correlation_id,
      schemaVersion: env.schema_version,
      failureClass,
      attempts: attemptNo,
      originalPayload: canonicalJson(env),
      originalDigest: digest(env),
      owner: this.#deadLetterOwner,
      affectedScope: `tenant:${env.tenant_id}/aggregate:${env.aggregate_type}/${env.aggregate_id}`,
      businessImpact: `undelivered governance projection for ${env.event_type}`,
      now: endedAt,
    });
    return this.#result(
      env,
      'dead_letter',
      attemptNo,
      null,
      `dead-lettered (${failureClass}): ${detail}`,
      'apply',
      false,
      deadLetterId,
    );
  }

  /**
   * A structurally-invalid message that could not be keyed/ordered: retain its ORIGINAL bytes in
   * a dead-letter (evidence preserved, never lost) and ACK it off the bus. The dead-letter id is
   * derived from the raw content so a redelivery of the same malformed bytes is idempotent.
   */
  async #rejectMalformed(raw: unknown, problems: string): Promise<ConsumeResult> {
    const tenantId = extractString(raw, 'tenant_id') ?? 'unknown';
    const eventId = extractString(raw, 'event_id') ?? 'malformed-' + digest(raw).slice(0, 24);
    const correlationId = extractString(raw, 'correlation_id') ?? 'unknown';
    const now = this.#db.now();
    const deadLetterId = deriveDeadLetterId(tenantId, this.#consumer, eventId);
    await this.#db.withKeyLock(`inbox:reject:${this.#consumer}:${eventId}`, async (tx) => {
      await insertDeadLetter(tx, {
        deadLetterId,
        tenantId,
        eventId,
        correlationId,
        schemaVersion: extractString(raw, 'schema_version') ?? SUPPORTED_SCHEMA_VERSION,
        failureClass: 'malformed',
        attempts: 1,
        originalPayload: canonicalJson(raw),
        originalDigest: digest(raw),
        owner: this.#deadLetterOwner,
        affectedScope: `consumer:${this.#consumer}`,
        businessImpact: 'malformed governance event could not be projected',
        now,
      });
      await insertAttempt(tx, {
        attemptId: deriveAttemptId(eventId, 1),
        tenantId,
        eventId,
        attemptNo: 1,
        correlationId,
        startedAt: now,
        endedAt: this.#db.now(),
        outcome: 'failed',
        errorDetail: `malformed: ${problems}`,
      });
    });
    return {
      eventId,
      disposition: 'rejected',
      ack: 'ack',
      applied: false,
      decision: 'reject',
      attempt: 1,
      deadLetterId,
      reason: `malformed envelope rejected: ${problems}`,
    };
  }

  #attemptRow(
    env: InboxEnvelope,
    attemptNo: number,
    startedAt: number,
    endedAt: number,
    outcome: string,
    errorDetail: string | null,
  ) {
    return {
      attemptId: deriveAttemptId(env.event_id, attemptNo),
      tenantId: env.tenant_id,
      eventId: env.event_id,
      attemptNo,
      correlationId: env.correlation_id,
      startedAt,
      endedAt,
      outcome,
      errorDetail,
    };
  }

  #result(
    env: InboxEnvelope,
    disposition: ConsumeDisposition,
    attempt: number,
    _cursor: string | null,
    reason: string,
    decision: DeliveryDecision | 'skipped',
    applied: boolean,
    deadLetterId: string | null = null,
  ): ConsumeResult {
    return {
      eventId: env.event_id,
      disposition,
      ack: ackFor(disposition),
      applied,
      decision,
      attempt,
      deadLetterId,
      reason,
    };
  }
}

// ===========================================================================
// 8. Helpers
// ===========================================================================

function isTerminalState(state: InboxProcessingState): boolean {
  return state === 'applied' || state === 'quarantined' || state === 'dead_letter';
}

function extractString(raw: unknown, key: string): string | null {
  if (typeof raw === 'object' && raw !== null && key in (raw as Record<string, unknown>)) {
    const v = (raw as Record<string, unknown>)[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  return null;
}
