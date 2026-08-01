-- 0005_outbox_claim — Transactional-outbox CLAIM LEASE columns and the terminal
-- `dead_letter` publish state for the command-worker publisher (Phase 27 / task T027 /
-- VO-7a0dbcc527946b539bf6, VO-52d0780c11bcc6fd7583).
--
-- Design authority (specs/001-governance-control-plane):
--   * data-model.md §"OutboxMessage": publish state, attempts, next-attempt time, JetStream
--     acknowledgement, and terminal error — plus, for a CLAIMED transactional outbox, the
--     lease that lets exactly one worker own a row while it publishes.
--   * plan.md / spec.md CHK016 (VO-52d0780c11bcc6fd7583): mutating operations MUST be
--     correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
--     delayed, partial, conflicting, and uncertain outcomes.
--
-- WHY a NEW migration (not an edit to 0004): db/migrations/0004_delivery.sql is CHECKSUM-PINNED
-- once applied (packages/persistence/src/database.ts `runMigrations` records its checksum in
-- schema_migrations and rejects an in-place edit with MigrationChecksumError — an applied
-- migration is immutable). So the claim-lease columns the Phase-27 publisher needs are added
-- here as a SEPARATE, later, EXPAND-ONLY migration. Every statement is additive and idempotent
-- (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) so re-applying is a safe no-op and
-- it composes with the 0004 outbox_message table without narrowing a supported column.
--
-- Effect-witness (VO-7a0dbcc527946b539bf6, integration, effect-witness):
--   Applying this migration yields an INDEPENDENTLY READABLE durable effect — the
--   outbox_message.claimed_by / claimed_at lease columns and the claim-lease index — that
--   could not exist before the migration ran. The publisher's success response is NOT the
--   proof; the durable catalog and the claimed/published/acknowledged rows are.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d): EXPAND only.

-- ===========================================================================
-- 1. Claim-lease columns — exactly one worker owns a row while it publishes.
--    * claimed_by — the worker id (OutboxPublisher.workerId) that owns the in-flight publish.
--    * claimed_at — when the lease was taken (for stale-lease reclamation by an operator scan).
--    A claim flips status 'pending'|'failed' -> 'publishing' and stamps these together, so a
--    concurrent worker's claim UPDATE (guarded by the same status predicate) matches 0 rows and
--    never double-publishes (deduplicated). The lease is CLEARED on the terminal transition
--    (published | failed-for-retry | dead_letter) so the row can be re-claimed if applicable.
-- ===========================================================================
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE outbox_message ADD COLUMN IF NOT EXISTS claimed_at BIGINT;

-- ===========================================================================
-- 2. Claim-scan index — find the leases a given worker holds (stale-lease reconciliation) and
--    scan in-flight `publishing` rows for an operator health view.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS outbox_message_claim_lease_idx
  ON outbox_message (status, claimed_by)
  WHERE claimed_by IS NOT NULL;

-- ===========================================================================
-- 3. delivery_attempt gains an ack reference so a SUCCESSFUL publish attempt records the durable
--    acknowledgement in the append-only history too (the ack is the ONLY proof of delivery).
--    Additive, idempotent; NULL for a non-acknowledged (retryable/uncertain/failed) attempt.
-- ===========================================================================
ALTER TABLE delivery_attempt ADD COLUMN IF NOT EXISTS ack_ref TEXT;
