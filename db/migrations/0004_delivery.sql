-- 0004_delivery — Durable inbox, outbox, and dead-letter tables with attempt and
-- cursor history (Phase 24 / task T024 / VO-52d0780c11bcc6fd7583, and the
-- transactional-outbox effect-witness VO-7a0dbcc527946b539bf6).
--
-- Design authority (specs/001-governance-control-plane):
--   * data-model.md §"InboxMessage, OutboxMessage, and DeadLetterRecord":
--       - InboxMessage : consumer, event ID, schema version, payload digest/evidence
--                        reference, received time, processing state, attempts, result
--                        cursor, and error.
--       - OutboxMessage: aggregate/entity version, event envelope, publish state,
--                        attempts, next-attempt time, JetStream acknowledgement, and
--                        terminal error.
--       - DeadLetterRecord: original message evidence, contract/schema version, failure
--                        class, attempts, owner, affected scope, business impact, replay
--                        authorization, and outcome.
--       "Original incompatible/malformed messages are retained before transformation or
--        replay."
--   * data-model.md §Partitioning: "Partition high-volume AuditEvent, HealthObservation,
--     InboxMessage, and OutboxMessage ..." — high-volume delivery tables.
--   * data-model.md §"Database enforcement and indexes": "Unique constraints cover
--     external source versions, idempotency keys, ledger sequence, ..."
--   * plan.md / spec.md CHK016 (VO-52d0780c11bcc6fd7583): mutating operations MUST be
--     correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
--     delayed, partial, conflicting, and uncertain outcomes.
--
-- This migration is the DURABLE, GOVERNED definition of the delivery substrate. The
-- Phase-21 unit-of-work bootstraps a minimal `outbox_message` shape for its own
-- transactional-outbox write (packages/persistence/src/unit-of-work.ts UNIT_OF_WORK_SQL,
-- `IF NOT EXISTS`). This migration formalizes that same table as a supported source
-- contract, ADDS the delivery lifecycle columns the data model requires (next-attempt
-- time, ordering key, entity version, ack reference, terminal error, dedup key), and
-- creates the INBOX, DEAD-LETTER, plus the ATTEMPT-HISTORY and CURSOR-HISTORY tables so
-- every delivery is retry-bounded, reconstructable, and reconcilable. Because every
-- statement is `IF NOT EXISTS`/idempotent and column-compatible, applying this migration
-- on top of the bootstrapped outbox is a safe no-op-or-extend.
--
-- Effect-witness (VO-7a0dbcc527946b539bf6 / VO-52d0780c11bcc6fd7583, effect-witness):
--   Applying the migration yields an INDEPENDENTLY READABLE durable effect — the physical
--   inbox_message / outbox_message / dead_letter_record tables, the delivery_attempt and
--   inbox_cursor history tables, their dedup unique keys, the claim/expiry indexes, and
--   the append-only attempt/cursor guard triggers — that could not exist before the
--   migration ran. The mutation runner's success response is NOT the proof; the durable
--   catalog and the data-plane read path are.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d):
-- EXPAND only. Every statement is additive and idempotent (`IF NOT EXISTS`,
-- `CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` + re-`CREATE`,
-- `DO $$ ... $$` guards) so re-applying is a safe no-op and it composes with the
-- bootstrapped outbox without narrowing a supported column. A later narrowing change
-- goes through a NEW expand→migrate→contract migration with deprecation + rollback
-- evidence. The runner (packages/persistence/src/database.ts `runMigrations`) pins this
-- file's checksum once applied, so editing it in place after it has run is rejected
-- (MigrationChecksumError) — an applied migration is immutable.

-- ===========================================================================
-- 1. OutboxMessage — the transactional-outbox publication record.
--    Formalizes the Phase-21 bootstrapped `outbox_message` and ADDS the delivery
--    lifecycle columns from data-model.md §OutboxMessage:
--      * entity_version   — aggregate/entity version the event envelope reflects.
--      * dedup_key        — the deterministic per-effect key (unit-of-work derives a
--                           stable outbox id); a duplicate replay never enqueues twice.
--      * ordering_key     — preserves per-aggregate publish order (JetStream subject).
--      * next_attempt_at  — bounded-retry next-attempt time (the publisher claim clock).
--      * max_attempts     — the retry bound (retry-bounded; NOT NULL, >= 1).
--      * ack_ref          — JetStream acknowledgement reference on successful publish.
--      * terminal_error   — the terminal error when the message is dead-lettered.
--    request/response payload is retained (payload_json/payload_digest) so a replay is
--    reconstructable. status is the publish lifecycle (pending -> published | failed |
--    dead_letter). The scope of dedup is (tenant_id, dedup_key).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS outbox_message (
  message_id     TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  topic          TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempts       INTEGER NOT NULL,
  created_at     BIGINT NOT NULL
);

-- Delivery lifecycle columns the data model requires but the bootstrap shape omits.
-- Added idempotently so this migration EXTENDS (never narrows) the bootstrapped table.
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS entity_version  BIGINT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS dedup_key       TEXT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS ordering_key    TEXT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS max_attempts    INTEGER NOT NULL DEFAULT 8;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS ack_ref         TEXT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS terminal_error  TEXT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS updated_at      BIGINT;

-- Deduplication contract: a deterministic dedup_key enqueues at most once per tenant, so
-- a duplicate transactional-outbox write cannot publish the same effect twice. Partial
-- (WHERE dedup_key IS NOT NULL) so legacy rows without a dedup_key are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_message_dedup_key_unique
  ON outbox_message (tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Publisher claim scan: pending/failed work due for a next attempt, ordered by created_at.
CREATE INDEX IF NOT EXISTS outbox_message_claim_idx
  ON outbox_message (status, created_at);
CREATE INDEX IF NOT EXISTS outbox_message_due_idx
  ON outbox_message (status, next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

-- Retry bound sanity: the publisher must never exceed max_attempts (retry-bounded).
DO $$ BEGIN
  ALTER TABLE outbox_message
    ADD CONSTRAINT outbox_message_attempts_bounded
    CHECK (max_attempts >= 1 AND attempts >= 0 AND attempts <= max_attempts);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- 2. InboxMessage — the consumer-side deduplication record (data-model.md §InboxMessage).
--    A consumer records each event it receives keyed by (tenant_id, consumer, event_id):
--    a redelivery of the same event is deduplicated (processed exactly once), and an
--    out-of-order/duplicate arrival is safe. Carries schema_version, payload digest +
--    evidence reference (original retained), received time, processing state, attempts,
--    the result cursor (advanced only after successful processing), and the last error.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inbox_message (
  tenant_id       TEXT NOT NULL,
  consumer        TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  evidence_ref    TEXT,
  correlation_id  TEXT NOT NULL,
  received_at     BIGINT NOT NULL,
  processing_state TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  max_attempts    INTEGER NOT NULL DEFAULT 8,
  result_cursor   TEXT,
  last_error      TEXT,
  updated_at      BIGINT NOT NULL,
  -- (tenant, consumer, event_id) is the dedup identity — each event processed once per
  -- consumer per tenant.
  PRIMARY KEY (tenant_id, consumer, event_id)
);

-- Explicit named UNIQUE key over the dedup identity (discoverable by name / tooling).
CREATE UNIQUE INDEX IF NOT EXISTS inbox_message_dedup_unique
  ON inbox_message (tenant_id, consumer, event_id);

-- Reconciliation scan: unprocessed / retryable messages per consumer.
CREATE INDEX IF NOT EXISTS inbox_message_state_idx
  ON inbox_message (tenant_id, consumer, processing_state);

DO $$ BEGIN
  ALTER TABLE inbox_message
    ADD CONSTRAINT inbox_message_attempts_bounded
    CHECK (max_attempts >= 1 AND attempts >= 0 AND attempts <= max_attempts);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- 3. DeadLetterRecord — the terminal delivery-failure record (data-model.md §DeadLetterRecord).
--    When an inbox or outbox message exhausts its retry bound or hits a non-retryable
--    failure, the ORIGINAL message evidence is retained here before any transformation or
--    replay. Carries the origin (inbox|outbox) + original message id, contract/schema
--    version, failure class, attempts, owner, affected scope, business impact, replay
--    authorization (who authorized a replay, if any), and the final outcome. A replay is
--    gated on replay_authorized_by being set (no self-service replay of a dead letter).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS dead_letter_record (
  dead_letter_id      TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  origin              TEXT NOT NULL,          -- 'inbox' | 'outbox'
  origin_message_id   TEXT NOT NULL,          -- the message_id / event_id that failed
  correlation_id      TEXT NOT NULL,
  contract_version    TEXT NOT NULL,
  schema_version      TEXT NOT NULL,
  failure_class       TEXT NOT NULL,          -- retryable | non_retryable | poison | ...
  attempts            INTEGER NOT NULL,
  original_payload    TEXT NOT NULL,          -- original evidence retained (never mutated)
  original_digest     TEXT NOT NULL,
  owner               TEXT NOT NULL,          -- accountable owner
  affected_scope      TEXT NOT NULL,
  business_impact     TEXT NOT NULL,
  replay_authorized_by TEXT,                  -- NULL until an authorized replay is granted
  replay_authorized_at BIGINT,
  outcome             TEXT NOT NULL,          -- open | replayed | discarded | ...
  first_seen_at       BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  -- A given failed origin message is dead-lettered at most once per tenant.
  UNIQUE (tenant_id, origin, origin_message_id)
);

CREATE INDEX IF NOT EXISTS dead_letter_record_outcome_idx
  ON dead_letter_record (tenant_id, outcome);
CREATE INDEX IF NOT EXISTS dead_letter_record_owner_idx
  ON dead_letter_record (tenant_id, owner);

-- Replay authorization sanity: an authorized replay records BOTH who and when together
-- (no half-authorization), and the authorizing timestamp cannot precede first-seen.
DO $$ BEGIN
  ALTER TABLE dead_letter_record
    ADD CONSTRAINT dead_letter_replay_auth_paired
    CHECK (
      (replay_authorized_by IS NULL AND replay_authorized_at IS NULL)
      OR (replay_authorized_by IS NOT NULL AND replay_authorized_at IS NOT NULL
          AND replay_authorized_at >= first_seen_at)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- 4. DeliveryAttempt — the APPEND-ONLY attempt history (retry-bounded + reconstructable).
--    Every delivery attempt (inbox process or outbox publish) appends one immutable row:
--    which message, the attempt ordinal, when it started/ended, the outcome, the error (if
--    any), and the correlation id. This makes retry history fully reconstructable (a
--    connector/controller's last success/failure and retry state are readable) and is the
--    durable witness that mutating delivery is retry-bounded — attempt_no is capped by the
--    message's max_attempts at the application layer, and the history proves how many ran.
--    History is APPEND-ONLY: a BEFORE-UPDATE guard rejects any mutation of a recorded
--    attempt row (an attempt, once written, is immutable evidence).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS delivery_attempt (
  attempt_id     TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  origin         TEXT NOT NULL,               -- 'inbox' | 'outbox'
  message_id     TEXT NOT NULL,               -- the delivering message / event id
  attempt_no     INTEGER NOT NULL,            -- 1-based ordinal within the message
  correlation_id TEXT NOT NULL,
  started_at     BIGINT NOT NULL,
  ended_at       BIGINT,
  outcome        TEXT NOT NULL,               -- succeeded | retryable | failed | uncertain
  error_detail   TEXT,
  -- Exactly one row per (message, attempt ordinal) — no duplicate attempt records.
  UNIQUE (tenant_id, origin, message_id, attempt_no)
);

-- Attempt-history scan for a message (ordered by attempt ordinal).
CREATE INDEX IF NOT EXISTS delivery_attempt_message_idx
  ON delivery_attempt (tenant_id, origin, message_id, attempt_no);

DO $$ BEGIN
  ALTER TABLE delivery_attempt
    ADD CONSTRAINT delivery_attempt_ordinal_positive
    CHECK (attempt_no >= 1 AND (ended_at IS NULL OR ended_at >= started_at));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Append-only guard: once an attempt row exists it is immutable evidence — reject UPDATE.
CREATE OR REPLACE FUNCTION delivery_attempt_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'delivery_attempt is append-only: attempt %/%/% cannot be mutated once recorded',
    OLD.tenant_id, OLD.message_id, OLD.attempt_no
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS delivery_attempt_append_only ON delivery_attempt;
CREATE TRIGGER delivery_attempt_append_only
  BEFORE UPDATE ON delivery_attempt
  FOR EACH ROW
  EXECUTE FUNCTION delivery_attempt_reject_mutation();

-- ===========================================================================
-- 5. InboxCursor — the durable CURSOR HISTORY (reconcilable + out-of-order safe).
--    Each consumer's ingest position per source stream is recorded with a MONOTONIC
--    sequence, so cursor advances are reconstructable and never regress. A stale/duplicate
--    or out-of-order source update that would MOVE the cursor BACKWARD is rejected by a
--    BEFORE-UPDATE guard (the cursor only ever advances), which is what makes reconciliation
--    of duplicate/out-of-order deliveries safe and history reconstructable. The append-only
--    `inbox_cursor_history` records every advance so the full cursor trail is auditable.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inbox_cursor (
  tenant_id      TEXT NOT NULL,
  consumer       TEXT NOT NULL,
  stream         TEXT NOT NULL,               -- the source stream / subject
  cursor_value   TEXT NOT NULL,               -- opaque source cursor (e.g. sequence token)
  cursor_seq     BIGINT NOT NULL,             -- monotonic sequence; MUST NOT regress
  correlation_id TEXT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, consumer, stream)
);

CREATE INDEX IF NOT EXISTS inbox_cursor_updated_idx
  ON inbox_cursor (tenant_id, consumer, updated_at);

-- Monotonic-advance guard: a cursor may only move FORWARD. An out-of-order / stale / dup
-- update that would move cursor_seq backward (or keep it equal with a changed value) is
-- rejected — reconciliation of duplicate/out-of-order deliveries causes NO cursor
-- regression, and history remains reconstructable.
CREATE OR REPLACE FUNCTION inbox_cursor_reject_regress()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cursor_seq < OLD.cursor_seq THEN
    RAISE EXCEPTION
      'inbox cursor regression for (%, %, %): recorded seq %, incoming seq %',
      OLD.tenant_id, OLD.consumer, OLD.stream, OLD.cursor_seq, NEW.cursor_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inbox_cursor_no_regress ON inbox_cursor;
CREATE TRIGGER inbox_cursor_no_regress
  BEFORE UPDATE ON inbox_cursor
  FOR EACH ROW
  EXECUTE FUNCTION inbox_cursor_reject_regress();

-- Append-only cursor trail: every advance is recorded so the full history is auditable
-- and a lost-cursor / backlog-gap recovery can replay from any recorded position.
CREATE TABLE IF NOT EXISTS inbox_cursor_history (
  history_id     TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  consumer       TEXT NOT NULL,
  stream         TEXT NOT NULL,
  cursor_value   TEXT NOT NULL,
  cursor_seq     BIGINT NOT NULL,
  correlation_id TEXT NOT NULL,
  recorded_at    BIGINT NOT NULL,
  -- Exactly one history row per (stream, monotonic seq) — a reconstructable trail.
  UNIQUE (tenant_id, consumer, stream, cursor_seq)
);

CREATE INDEX IF NOT EXISTS inbox_cursor_history_scan_idx
  ON inbox_cursor_history (tenant_id, consumer, stream, cursor_seq);

-- The cursor-history trail is append-only evidence — reject UPDATE of a recorded row.
CREATE OR REPLACE FUNCTION inbox_cursor_history_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'inbox_cursor_history is append-only: (%, %, %, seq %) cannot be mutated once recorded',
    OLD.tenant_id, OLD.consumer, OLD.stream, OLD.cursor_seq
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS inbox_cursor_history_append_only ON inbox_cursor_history;
CREATE TRIGGER inbox_cursor_history_append_only
  BEFORE UPDATE ON inbox_cursor_history
  FOR EACH ROW
  EXECUTE FUNCTION inbox_cursor_history_reject_mutation();
