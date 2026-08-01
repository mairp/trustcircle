-- 0010_projector_state — Durable projection-worker OWNERSHIP LEASE, resumable projection
-- CHECKPOINT, and REBUILD audit trail for the governed projection-worker bootstrap
-- (Phase 48 / work item T2KV3HBNG3BGWSEXZ58RXEHQ3T / VO-6acaf6470d0810df4c93,
-- VO-53a014009bdfebd7af13).
--
-- Design authority (specs/001-governance-control-plane):
--   * spec.md / plan.md (VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13): the open-ended source
--     catalog, reconciled inventory, coverage gaps, workflow and controller state, OWNERSHIP,
--     health, failures, retries, CONTINUITY MODE and LEASE, buffered evidence, and safe next
--     actions MUST be CURRENT and FAIL-VISIBLE. The read-model PROJECTOR is a long-running worker,
--     so — exactly like the command-worker (0009) — it needs (a) a durable, fenced, time-bounded
--     ownership lease so exactly one projector applies events to a read model at a time (no
--     split-brain double-apply), and (b) a durable checkpoint carrying the current state /
--     continuity mode / cumulative consume+retry+dead-letter counters / buffered-evidence count /
--     safe next action so an operator reads the projector's health from a durable row and a
--     restart RESUMES rather than silently re-projecting.
--   * Projection-specific fail-visibility (this migration adds beyond 0009):
--       - DURABLE CURSORS already exist as inbox_cursor / inbox_cursor_history (0004): the
--         projector reads its applied position through that independent path (readInboxCursor).
--         This migration does NOT duplicate them.
--       - REBUILD MODE: a reset-and-replay of the read model is a governed, durable operation —
--         projector_checkpoint.rebuild_* records the in-flight rebuild (id / phase / progress) so
--         "a rebuild is running / stalled / failed" is never invisible, and projector_rebuild is
--         an append-only audit trail of every rebuild run.
--       - STALE-STATE SIGNALING: freshness is assessed against an objective (max lag items / max
--         age ms). projector_checkpoint.freshness + stale + freshness_summary make "the read model
--         is behind / unknown" a durable, queryable fact, and `stale` forces health=false.
--
-- WHY a NEW migration (not an edit to an earlier one): every applied migration is CHECKSUM-PINNED
-- (packages/persistence/src/database.ts `runMigrations` records its checksum in schema_migrations
-- and rejects an in-place edit with MigrationChecksumError). So the projector-governance tables
-- are added here as a SEPARATE, later, EXPAND-ONLY migration, exactly as 0009 added the
-- worker-governance tables.
--
-- Effect-witness (VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13):
--   Applying this migration yields INDEPENDENTLY READABLE durable effects — the projector_lease,
--   projector_checkpoint, and projector_rebuild tables — that could not exist before it ran. The
--   projector's in-memory "I own the read model / I am fresh / I am rebuilding" flags are NOT the
--   proof; the durable projector_lease row (holder + monotonic fencing_token + expires_at), the
--   projector_checkpoint row (state + continuity + counters + freshness/stale + rebuild + safe
--   next action), and the append-only projector_rebuild trail are the observable witnesses an
--   operator or a second projector reads to confirm ownership, health, freshness, and rebuild.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d): EXPAND only.
-- Every statement is additive and idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`) so re-applying
-- is a safe no-op.

-- ===========================================================================
-- 1. projector_lease — the durable, fenced, time-bounded OWNERSHIP row.
--    One lease per projected resource (PK). Mirrors worker_lease (0009): the projector serializes
--    the token bump under a Postgres SESSION advisory lock (Database.withAdvisoryLock, key
--    "projector-lease:<resource>") so exactly one projector wins each acquisition and
--    fencing_token strictly increases. A crashed owner's lease self-heals once expires_at passes.
--      * resource       — the governed read-model resource (one lease per resource; PK).
--      * holder         — the projector id that currently owns the lease (NULL when released).
--      * fencing_token  — MONOTONIC token, bumped on every acquisition; a stale projector holding
--                         an older token can be fenced out (it can never renew).
--      * expires_at     — epoch-millis lease expiry; ownership valid only while now < expires_at.
--      * updated_at     — last mutation time (acquire / renew / release) for the operator view.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS projector_lease (
  resource       TEXT PRIMARY KEY,
  holder         TEXT,
  fencing_token  BIGINT NOT NULL DEFAULT 0,
  expires_at     BIGINT,
  updated_at     BIGINT NOT NULL,
  -- Fencing token is monotonic and non-negative; a live lease must name a holder + expiry.
  CONSTRAINT projector_lease_token_nonneg CHECK (fencing_token >= 0),
  CONSTRAINT projector_lease_live_has_holder
    CHECK ((holder IS NULL) = (expires_at IS NULL))
);

-- Find live leases (health/ownership view) and expired ones (reclaimable) without a full scan.
CREATE INDEX IF NOT EXISTS projector_lease_expiry_idx
  ON projector_lease (expires_at)
  WHERE holder IS NOT NULL;

-- ===========================================================================
-- 2. projector_checkpoint — the durable, resumable, FAIL-VISIBLE projection progress row.
--    Exactly one latest checkpoint per resource (PK = resource). Rewritten after every projection
--    pass and on every lifecycle transition, so an operator reads the projector's CURRENT health,
--    continuity mode, retry/failure totals, buffered-evidence count, freshness/staleness, rebuild
--    state, and safe next action from a durable row. A restart LOADs this row and resumes
--    cumulative counters instead of resetting to zero.
--
--    Projection-specific columns beyond worker_checkpoint (0009):
--      * consumed / applied / buffered / quarantined — cumulative inbox-consume outcome counters
--        (dedup/ordered-apply/quarantine), distinct from retried / dead_lettered.
--      * freshness           — 'fresh' | 'stale' | 'unknown'. 'unknown' is NEVER treated as fresh.
--      * stale               — BOOLEAN mirror; TRUE forces health=false (fail-visible staleness).
--      * freshness_summary   — disclosure-safe per-stream freshness snapshot (JSON text) for the
--                              operator view (lag items / age ms per stream). NULL when unassessed.
--      * rebuild_id          — id of the in-flight rebuild, NULL when none is running.
--      * rebuild_phase       — idle | resetting | replaying | verifying | completed | failed.
--      * rebuild_progress    — count of events replayed so far in the current/last rebuild.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS projector_checkpoint (
  resource          TEXT PRIMARY KEY,
  holder            TEXT NOT NULL,
  fencing_token     BIGINT NOT NULL DEFAULT 0,
  pass              BIGINT NOT NULL DEFAULT 0,
  state             TEXT NOT NULL,
  continuity        TEXT NOT NULL DEFAULT 'normal',
  consumed          BIGINT NOT NULL DEFAULT 0,
  applied           BIGINT NOT NULL DEFAULT 0,
  buffered          BIGINT NOT NULL DEFAULT 0,
  quarantined       BIGINT NOT NULL DEFAULT 0,
  retried           BIGINT NOT NULL DEFAULT 0,
  dead_lettered     BIGINT NOT NULL DEFAULT 0,
  buffered_evidence BIGINT NOT NULL DEFAULT 0,
  freshness         TEXT NOT NULL DEFAULT 'unknown',
  stale             BOOLEAN NOT NULL DEFAULT FALSE,
  freshness_summary TEXT,
  rebuild_id        TEXT,
  rebuild_phase     TEXT NOT NULL DEFAULT 'idle',
  rebuild_progress  BIGINT NOT NULL DEFAULT 0,
  last_error        TEXT,
  safe_next_action  TEXT NOT NULL DEFAULT 'none',
  updated_at        BIGINT NOT NULL,
  -- Guard the fail-visible vocabularies so a bad write is rejected, not silently stored.
  CONSTRAINT projector_checkpoint_state_valid
    CHECK (state IN ('starting','acquiring_lease','running','rebuilding','draining','stopped',
                     'degraded','stale','lost_lease','failed')),
  CONSTRAINT projector_checkpoint_continuity_valid
    CHECK (continuity IN ('normal','continue_under_lease','paused')),
  CONSTRAINT projector_checkpoint_freshness_valid
    CHECK (freshness IN ('fresh','stale','unknown')),
  CONSTRAINT projector_checkpoint_rebuild_phase_valid
    CHECK (rebuild_phase IN ('idle','resetting','replaying','verifying','completed','failed')),
  CONSTRAINT projector_checkpoint_action_valid
    CHECK (safe_next_action IN ('none','retry','reconcile','rebuild','escalate')),
  -- A running rebuild MUST name a rebuild id; idle/completed/failed-at-rest may be anonymous.
  CONSTRAINT projector_checkpoint_rebuild_id_when_active
    CHECK (rebuild_phase NOT IN ('resetting','replaying','verifying') OR rebuild_id IS NOT NULL),
  -- 'stale' freshness and the boolean mirror must agree, so staleness is unambiguous.
  CONSTRAINT projector_checkpoint_stale_agrees
    CHECK (stale = (freshness = 'stale')),
  CONSTRAINT projector_checkpoint_counters_nonneg
    CHECK (pass >= 0 AND consumed >= 0 AND applied >= 0 AND buffered >= 0 AND quarantined >= 0
           AND retried >= 0 AND dead_lettered >= 0 AND buffered_evidence >= 0
           AND rebuild_progress >= 0)
);

-- Operator health scan: surface any checkpoint that is NOT cleanly fresh + stopped/none — i.e.
-- every projector that is degraded, lost, stale, rebuilding, escalating, or paused is directly
-- queryable (fail-visible).
CREATE INDEX IF NOT EXISTS projector_checkpoint_attention_idx
  ON projector_checkpoint (state, freshness, safe_next_action);

-- ===========================================================================
-- 3. projector_rebuild — the append-only AUDIT TRAIL of every read-model rebuild run.
--    A rebuild is a governed reset-and-replay; recording each run durably (started / phase
--    transitions / completion or failure) makes "who rebuilt what, when, and how it ended" an
--    independently readable fact rather than a lost in-memory event. One row per (resource,
--    rebuild_id); phase/progress/ended_at are advanced in place while the run proceeds, but a
--    finished run's terminal outcome is never rewritten (append-only trigger below).
--      * rebuild_id   — unique id of the rebuild run (PK component with resource).
--      * requested_by — the holder/operator that requested the rebuild.
--      * phase        — resetting | replaying | verifying | completed | failed.
--      * replayed     — count of events replayed.
--      * started_at   — epoch-millis when the rebuild began.
--      * ended_at     — epoch-millis when it reached a terminal phase (NULL while in flight).
--      * failure      — disclosure-safe terminal failure reason (NULL unless phase='failed').
-- ===========================================================================
CREATE TABLE IF NOT EXISTS projector_rebuild (
  resource      TEXT NOT NULL,
  rebuild_id    TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  phase         TEXT NOT NULL DEFAULT 'resetting',
  replayed      BIGINT NOT NULL DEFAULT 0,
  started_at    BIGINT NOT NULL,
  ended_at      BIGINT,
  failure       TEXT,
  PRIMARY KEY (resource, rebuild_id),
  CONSTRAINT projector_rebuild_phase_valid
    CHECK (phase IN ('resetting','replaying','verifying','completed','failed')),
  CONSTRAINT projector_rebuild_replayed_nonneg CHECK (replayed >= 0),
  -- A terminal phase must be timestamped; an in-flight phase must not be.
  CONSTRAINT projector_rebuild_ended_when_terminal
    CHECK ((phase IN ('completed','failed')) = (ended_at IS NOT NULL)),
  -- A failure reason is present exactly when the run failed.
  CONSTRAINT projector_rebuild_failure_when_failed
    CHECK ((failure IS NULL) OR (phase = 'failed'))
);

-- Scan the rebuild history for a resource newest-first, and surface unfinished rebuilds.
CREATE INDEX IF NOT EXISTS projector_rebuild_scan_idx
  ON projector_rebuild (resource, started_at);
CREATE INDEX IF NOT EXISTS projector_rebuild_open_idx
  ON projector_rebuild (resource)
  WHERE ended_at IS NULL;

-- A rebuild run's TERMINAL outcome is immutable: once ended_at is set (completed/failed), the row
-- cannot be re-opened or its outcome rewritten. In-flight rows (ended_at IS NULL) may still be
-- advanced. This keeps the audit trail trustworthy (append-only at the terminal boundary).
CREATE OR REPLACE FUNCTION projector_rebuild_reject_terminal_rewrite()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION
      'projector_rebuild is terminal-immutable: rebuild (%, %) already ended and cannot be rewritten',
      OLD.resource, OLD.rebuild_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projector_rebuild_no_terminal_rewrite ON projector_rebuild;
CREATE TRIGGER projector_rebuild_no_terminal_rewrite
  BEFORE UPDATE ON projector_rebuild
  FOR EACH ROW
  EXECUTE FUNCTION projector_rebuild_reject_terminal_rewrite();
