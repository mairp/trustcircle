-- 0009_worker_lease — Durable worker OWNERSHIP LEASE and resumable drain CHECKPOINT for the
-- governed command-worker bootstrap (Phase 47 / work item BSBXP2PH36TG5Y8FTTMWJD16WG /
-- VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13).
--
-- Design authority (specs/001-governance-control-plane):
--   * spec.md / plan.md (VO-6acaf6470d0810df4c93): the workflow and controller state, OWNERSHIP,
--     health, failures, retries, CONTINUITY MODE and LEASE, buffered evidence, and safe next
--     actions MUST be CURRENT and FAIL-VISIBLE. A long-running worker therefore needs (a) a
--     durable, fenced, time-bounded ownership lease so exactly one instance drains the outbox at
--     a time (no split-brain double-publish), and (b) a durable checkpoint that carries the
--     current state / continuity mode / cumulative retry+failure counters / buffered-evidence
--     count / safe next action so an operator reads the worker's health from a durable row, not
--     from a transient process, and a restart RESUMES rather than silently re-acts.
--   * FR-046..FR-050 (continuity): while a valid lease covers the current step the worker may
--     continue and buffer evidence; otherwise it PAUSES at a safe checkpoint and requires
--     reconciliation. `worker_checkpoint.continuity` + `safe_next_action` encode exactly that.
--
-- WHY a NEW migration (not an edit to an earlier one): every applied migration is CHECKSUM-PINNED
-- (packages/persistence/src/database.ts `runMigrations` records its checksum in schema_migrations
-- and rejects an in-place edit with MigrationChecksumError). So the worker-governance tables are
-- added here as a SEPARATE, later, EXPAND-ONLY migration, exactly as 0007/0008 added columns to
-- the delivery/inbox tables.
--
-- Effect-witness (VO-6acaf6470d0810df4c93):
--   Applying this migration yields an INDEPENDENTLY READABLE durable effect — the worker_lease
--   and worker_checkpoint tables — that could not exist before the migration ran. The worker's
--   in-memory "I own the drain" flag is NOT the proof; the durable worker_lease row (holder +
--   monotonically increasing fencing_token + expires_at) and the worker_checkpoint row (state +
--   continuity + counters + safe_next_action) are the observable witnesses that an operator or a
--   second worker reads to confirm ownership, health, and where the last run stopped.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d): EXPAND only.
-- Every statement is additive and idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`) so re-applying
-- is a safe no-op.

-- ===========================================================================
-- 1. worker_lease — the durable, fenced, time-bounded OWNERSHIP row.
--    * resource       — the governed drain resource (one lease per resource; PK).
--    * holder         — the worker id that currently owns the lease (NULL when released).
--    * fencing_token  — MONOTONIC token, bumped on every acquisition. A stale worker holding an
--                       older token can be detected and fenced out (it can never renew).
--    * expires_at     — epoch-millis lease expiry. Ownership is only valid while now < expires_at,
--                       so a crashed owner's lease self-heals: a new worker may acquire once it
--                       expires. This is the TIME-BOUNDED, self-reclaiming property.
--    * updated_at     — last mutation time (acquire / renew / release) for the operator view.
--    The command-worker serializes the token bump under a Postgres SESSION advisory lock
--    (packages/persistence Database.withAdvisoryLock, key "worker-lease:<resource>") so exactly
--    one worker wins each acquisition and the fencing_token strictly increases.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS worker_lease (
  resource       TEXT PRIMARY KEY,
  holder         TEXT,
  fencing_token  BIGINT NOT NULL DEFAULT 0,
  expires_at     BIGINT,
  updated_at     BIGINT NOT NULL,
  -- Fencing token is monotonic and non-negative; a live lease must name a holder + expiry.
  CONSTRAINT worker_lease_token_nonneg CHECK (fencing_token >= 0),
  CONSTRAINT worker_lease_live_has_holder
    CHECK ((holder IS NULL) = (expires_at IS NULL))
);

-- Find live leases (health/ownership view) and expired ones (reclaimable) without a full scan.
CREATE INDEX IF NOT EXISTS worker_lease_expiry_idx
  ON worker_lease (expires_at)
  WHERE holder IS NOT NULL;

-- ===========================================================================
-- 2. worker_checkpoint — the durable, resumable, FAIL-VISIBLE drain progress row.
--    Exactly one latest checkpoint per resource (PK = resource). Rewritten after every drain
--    pass and on every lifecycle transition, so an operator reads the worker's CURRENT health,
--    continuity mode, retry/failure totals, buffered-evidence count, and safe next action from
--    a durable row. A restart LOADs this row and resumes cumulative counters (reconstructable
--    history) instead of resetting to zero.
--
--    * state             — the worker lifecycle state (starting|acquiring_lease|running|
--                          draining|stopped|degraded|lost_lease|failed). Fail-visible: degraded
--                          / lost_lease / failed are distinct from a clean `stopped`.
--    * continuity        — normal | continue_under_lease | paused (FR-046..FR-050).
--    * fencing_token     — the lease token this checkpoint was written under (ties the checkpoint
--                          to the ownership generation that produced it).
--    * pass              — cumulative drain pass count (resumed on restart).
--    * claimed/published/retried/dead_lettered — cumulative outbox delivery counters.
--    * buffered_evidence — count of evidence records held in the continuity buffer but not yet
--                          durably flushed (never invisible).
--    * last_error        — disclosure-safe last error (NULL when healthy).
--    * safe_next_action  — none | retry | reconcile | escalate — the single safe action.
--    * updated_at        — checkpoint write time.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS worker_checkpoint (
  resource          TEXT PRIMARY KEY,
  holder            TEXT NOT NULL,
  fencing_token     BIGINT NOT NULL DEFAULT 0,
  pass              BIGINT NOT NULL DEFAULT 0,
  state             TEXT NOT NULL,
  continuity        TEXT NOT NULL DEFAULT 'normal',
  claimed           BIGINT NOT NULL DEFAULT 0,
  published         BIGINT NOT NULL DEFAULT 0,
  retried           BIGINT NOT NULL DEFAULT 0,
  dead_lettered     BIGINT NOT NULL DEFAULT 0,
  buffered_evidence BIGINT NOT NULL DEFAULT 0,
  last_error        TEXT,
  safe_next_action  TEXT NOT NULL DEFAULT 'none',
  updated_at        BIGINT NOT NULL,
  -- Guard the fail-visible vocabularies so a bad write is rejected, not silently stored.
  CONSTRAINT worker_checkpoint_state_valid
    CHECK (state IN ('starting','acquiring_lease','running','draining','stopped','degraded','lost_lease','failed')),
  CONSTRAINT worker_checkpoint_continuity_valid
    CHECK (continuity IN ('normal','continue_under_lease','paused')),
  CONSTRAINT worker_checkpoint_action_valid
    CHECK (safe_next_action IN ('none','retry','reconcile','escalate')),
  CONSTRAINT worker_checkpoint_counters_nonneg
    CHECK (pass >= 0 AND claimed >= 0 AND published >= 0 AND retried >= 0
           AND dead_lettered >= 0 AND buffered_evidence >= 0)
);

-- Operator health scan: surface any checkpoint that is NOT cleanly `stopped`/`none` — i.e. every
-- worker that is degraded, lost, escalating, or paused is directly queryable (fail-visible).
CREATE INDEX IF NOT EXISTS worker_checkpoint_attention_idx
  ON worker_checkpoint (state, safe_next_action);
