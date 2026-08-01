-- 0005_audit_ledger — Append-only, hash-chained TENANT AUDIT LEDGER and signed
-- checkpoint metadata (Phase 29 / task T029 / GAR-002 / VO-d76c5d1293b91d26e094).
--
-- Design authority (specs/001-governance-control-plane/data-model.md):
--   * §"AuditEvent": every decision and automated action appends ONE immutable, ordered
--     ledger row that captures actor/principal, accountable owner, reason, source/target/actual
--     state, policy AND control versions, evidence, requested/actual scope, occurred/recorded
--     time, correlation/causation/trace, and outcome — plus a previous_digest/integrity_digest
--     HASH CHAIN. "Database roles cannot update/delete AuditEvent rows."
--   * §"AuditCheckpoint": records ledger range, first/last sequence, root digest, event count,
--     generated time, signing-key ID, SIGNATURE, immutable EvidenceItem reference, verification
--     history, and external anchor reference — the SIGNED CHECKPOINT metadata that makes ledger
--     truncation/replacement tamper-EVIDENT.
--
-- Phase-29 acceptance criterion (GAR-002 / VO-d76c5d1293b91d26e094):
--   "Every decision and automated action MUST capture actor or principal, accountable owner,
--    reason, source and target state, policy and control versions, evidence, scope, time,
--    correlation, and outcome before it can be reported as complete."
--   This migration is the physical enforcement of that obligation: the audit_event row is
--   NOT NULL on exactly those accountability columns (or CHECK-guarded where the value is
--   conditionally required), so an action CANNOT be recorded — and therefore cannot be
--   reported complete — with any mandatory accountability field missing.
--
-- WHY a NEW migration (never an edit to an applied one): every migration is CHECKSUM-PINNED
-- once applied (packages/persistence/src/database.ts `runMigrations` records its checksum in
-- schema_migrations and rejects an in-place edit with MigrationChecksumError). This is a new,
-- EXPAND-ONLY migration whose statements are additive and idempotent
-- (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
-- the `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` reinstall idiom) so re-applying is a safe
-- no-op and it composes with 0001–0004 without narrowing a supported column.
--
-- Effect-witness (VO-d76c5d1293b91d26e094, contract/positive; anchored to the byte-level SQL):
--   Applying this migration yields an INDEPENDENTLY READABLE durable effect — the audit_event
--   ledger table (with its accountability NOT NULL/CHECK contract, hash-chain columns, and the
--   append-only UPDATE/DELETE guards) and the audit_checkpoint table (root digest + signing key
--   + signature) — that could not exist before the migration ran. No writer's success response
--   is the proof; the durable catalog and the immutable, hash-linked rows are.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d): EXPAND only.
-- No destructive or narrowing DDL — nothing is dropped or narrowed. The only trigger-reinstall
-- uses the idempotent idiom (DROP TRIGGER IF EXISTS immediately followed by a CREATE TRIGGER of
-- the same name), so re-applying is a safe no-op.

-- ===========================================================================
-- 0. Enumerated types — the outcome vocabulary and the checkpoint verification state.
--    Guarded so re-apply is a no-op (CREATE TYPE has no IF NOT EXISTS in PostgreSQL).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_outcome') THEN
    CREATE TYPE audit_outcome AS ENUM (
      'succeeded',      -- the action completed within its authorized bounds
      'failed',         -- the action was attempted and did not complete
      'denied',         -- authority/precondition rejected the action before effect
      'rejected',       -- input/validation rejected the action before effect
      'partial',        -- the action completed some but not all of its scope
      'uncertain'       -- the remote outcome could not be confirmed (needs reconciliation)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_checkpoint_status') THEN
    CREATE TYPE audit_checkpoint_status AS ENUM (
      'signed',         -- checkpoint generated and signed over the ledger range
      'verified',       -- signature + chain re-verified against the ledger
      'anchored',       -- also anchored to an external immutable reference
      'tampered'        -- verification FAILED — ledger range does not match the signed root
    );
  END IF;
END
$$;

-- ===========================================================================
-- 1. audit_event — the APPEND-ONLY, HASH-CHAINED tenant audit ledger.
--
--    Accountability contract (Phase-29 AC / VO-d76c5d1293b91d26e094): the columns below are
--    NOT NULL (or CHECK-guarded where the requirement is conditional) so a decision/automated
--    action CANNOT be recorded with a mandatory accountability field missing. The mapping from
--    the AC clause to the column is spelled out inline.

CREATE TABLE IF NOT EXISTS audit_event (
  -- Identity + ledger position (unique ordered position within a tenant's ledger).
  audit_event_id              UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  ledger_id                   UUID NOT NULL,
  sequence                    BIGINT NOT NULL,          -- monotonic per (tenant, ledger)

  event_type                  TEXT NOT NULL,
  schema_version              TEXT NOT NULL,

  -- ACTOR / PRINCIPAL (AC: "actor or principal"). actor_principal_id is required unless the
  -- action is a system/automated action, in which case actor_is_system MUST be true and an
  -- automation identifier is supplied — the actor is never simply absent.
  actor_principal_id          UUID,
  actor_role_assignment_id    UUID,
  actor_is_system             BOOLEAN NOT NULL DEFAULT false,
  automation_id               TEXT,

  -- ACCOUNTABLE OWNER (AC: "accountable owner"). Always required — a human/role that owns the
  -- consequences of the action, even when the actor is an automation.
  accountable_owner_principal_id UUID NOT NULL,

  -- REASON (AC: "reason"). A machine reason_code is always required; reason_text is required
  -- for a human (non-system) action (enforced by the CHECK below).
  reason_code                 TEXT NOT NULL,
  reason_text                 TEXT,

  -- BOUND TARGET entity (part of scope + state binding).
  entity_type                 TEXT NOT NULL,
  entity_id                   TEXT NOT NULL,
  entity_version              TEXT,

  -- SOURCE AND TARGET STATE (AC: "source and target state"). Digests let the before/after (and
  -- the actually-observed) state be reconstructed and compared. actual_state_digest is filled
  -- in on reconciliation of an uncertain/partial outcome.
  source_state_digest         TEXT NOT NULL,
  target_state_digest         TEXT NOT NULL,
  actual_state_digest         TEXT,

  -- POLICY AND CONTROL VERSIONS (AC: "policy and control versions"). Arrays of the exact
  -- policy/control version ids the decision was evaluated against. NOT NULL (default empty) and
  -- CHECK-required non-empty for a governed (non-system-observation) action.
  policy_version_ids          UUID[] NOT NULL DEFAULT '{}',
  control_version_ids         UUID[] NOT NULL DEFAULT '{}',

  -- EVIDENCE (AC: "evidence"). The immutable evidence manifest that backs the decision. Required
  -- for a completed governed action (CHECK below); an evidence-administration action may point
  -- at the manifest it produced.
  evidence_manifest_id        UUID,

  -- SCOPE (AC: "scope"). Requested vs actual scope objects (tenant set, resource selectors …).
  requested_scope             JSONB NOT NULL DEFAULT '{}'::jsonb,
  actual_scope                JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- OUTCOME (AC: "outcome"). The terminal disposition — required before the action is complete.
  outcome                     audit_outcome NOT NULL,

  -- TIME (AC: "time"). Both the domain occurrence time and the ledger recording time.
  occurred_at                 BIGINT NOT NULL,
  recorded_at                 BIGINT NOT NULL,

  -- CORRELATION (AC: "correlation"). correlation_id ties the action to its request/operation;
  -- causation_id/trace_id reconstruct the causal chain and distributed trace.
  correlation_id              UUID NOT NULL,
  causation_id                UUID,
  trace_id                    TEXT,

  -- HASH CHAIN — tamper-evidence. previous_digest links to the prior row's integrity_digest;
  -- integrity_digest is the digest over THIS row's canonical content + previous_digest.
  previous_digest             TEXT NOT NULL,
  integrity_digest            TEXT NOT NULL,

  -- Ledger position is the primary key: one row per (tenant, ledger, sequence).
  CONSTRAINT audit_event_pk PRIMARY KEY (tenant_id, ledger_id, sequence),

  -- The global opaque id is unique across the whole ledger surface.
  CONSTRAINT audit_event_id_unique UNIQUE (audit_event_id),

  -- The hash-chain link is unique per ledger (no two rows share an integrity_digest), so the
  -- chain is a strict total order that cannot fork.
  CONSTRAINT audit_event_integrity_digest_unique UNIQUE (tenant_id, ledger_id, integrity_digest),

  -- Sequence is a positive, gap-checked monotonic counter.
  CONSTRAINT audit_event_sequence_positive CHECK (sequence >= 1),

  -- recorded_at cannot precede occurred_at (you cannot record before it happened).
  CONSTRAINT audit_event_recorded_after_occurred CHECK (recorded_at >= occurred_at),

  -- ACTOR completeness: either a known principal actor OR an explicit system action carrying an
  -- automation identifier — the actor is never simply unknown.
  CONSTRAINT audit_event_actor_present CHECK (
    actor_principal_id IS NOT NULL
    OR (actor_is_system = true AND automation_id IS NOT NULL)
  ),

  -- REASON completeness: a human (non-system) action MUST carry human-readable reason_text.
  CONSTRAINT audit_event_reason_text_for_human CHECK (
    actor_is_system = true OR reason_text IS NOT NULL
  ),

  -- POLICY/CONTROL + EVIDENCE completeness for a COMPLETED GOVERNED action: when the outcome is
  -- 'succeeded' or 'partial' AND this is not a pure system observation, the action must have been
  -- evaluated against at least one policy version, at least one control version, and must
  -- reference the evidence manifest that backs it. A denied/rejected/failed attempt is exempt
  -- (it never reached completion), and a system observation (actor_is_system) is exempt.
  CONSTRAINT audit_event_governed_completion_requires_versions_and_evidence CHECK (
    actor_is_system = true
    OR outcome NOT IN ('succeeded', 'partial')
    OR (
      array_length(policy_version_ids, 1) >= 1
      AND array_length(control_version_ids, 1) >= 1
      AND evidence_manifest_id IS NOT NULL
    )
  )
);

-- Read paths: reconstruct a tenant's ledger in order; look up by correlation; find the chain head.
CREATE INDEX IF NOT EXISTS audit_event_ledger_order_idx
  ON audit_event (tenant_id, ledger_id, sequence);
CREATE INDEX IF NOT EXISTS audit_event_correlation_idx
  ON audit_event (tenant_id, correlation_id);
CREATE INDEX IF NOT EXISTS audit_event_entity_idx
  ON audit_event (tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_event_recorded_at_idx
  ON audit_event (tenant_id, recorded_at);

-- ---------------------------------------------------------------------------
-- APPEND-ONLY enforcement (data-model: "Database roles cannot update/delete AuditEvent rows").
-- Two guards — one for UPDATE, one for DELETE — so each is an independently parseable
-- BEFORE-<event> trigger and neither can be silently dropped without the test noticing.

CREATE OR REPLACE FUNCTION audit_event_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event is append-only: ledger row (%, %, seq %) cannot be updated once recorded',
    OLD.tenant_id, OLD.ledger_id, OLD.sequence
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_event_append_only_update ON audit_event;
CREATE TRIGGER audit_event_append_only_update
  BEFORE UPDATE ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION audit_event_reject_update();

CREATE OR REPLACE FUNCTION audit_event_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_event is append-only: ledger row (%, %, seq %) cannot be deleted once recorded',
    OLD.tenant_id, OLD.ledger_id, OLD.sequence
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_event_append_only_delete ON audit_event;
CREATE TRIGGER audit_event_append_only_delete
  BEFORE DELETE ON audit_event
  FOR EACH ROW
  EXECUTE FUNCTION audit_event_reject_delete();

-- ===========================================================================
-- 2. audit_checkpoint — SIGNED CHECKPOINT METADATA over a contiguous ledger range.
--
--    A checkpoint pins first/last sequence, the Merkle/rolling ROOT DIGEST over that range, the
--    event count, the generated time, the SIGNING-KEY ID and SIGNATURE, an immutable evidence
--    reference, verification history, and an external anchor. Signed checkpoints make ledger
--    truncation or replacement tamper-EVIDENT: re-computing the root over the stored range and
--    verifying the signature detects any missing/altered/reordered row.

CREATE TABLE IF NOT EXISTS audit_checkpoint (
  checkpoint_id               UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  ledger_id                   UUID NOT NULL,

  -- Contiguous, non-empty ledger RANGE this checkpoint covers.
  first_sequence              BIGINT NOT NULL,
  last_sequence               BIGINT NOT NULL,
  event_count                 BIGINT NOT NULL,

  -- ROOT DIGEST over the covered range, and the head integrity_digest it chains to.
  root_digest                 TEXT NOT NULL,
  head_integrity_digest       TEXT NOT NULL,
  -- Chain the checkpoints themselves so a whole checkpoint cannot be dropped undetected.
  previous_root_digest        TEXT,

  generated_at                BIGINT NOT NULL,

  -- SIGNATURE metadata — the signed part of "signed checkpoint metadata".
  signing_key_id              TEXT NOT NULL,
  signature_algorithm         TEXT NOT NULL,
  signature                   TEXT NOT NULL,

  -- Immutable EvidenceItem reference (the checkpoint manifest persisted to immutable storage).
  evidence_item_id            UUID,

  -- Verification lifecycle + append-only history, and the optional external immutable anchor.
  status                      audit_checkpoint_status NOT NULL DEFAULT 'signed',
  verification_history        JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_anchor_ref         TEXT,

  CONSTRAINT audit_checkpoint_pk PRIMARY KEY (checkpoint_id),

  -- One checkpoint per (tenant, ledger, last_sequence): a range end is checkpointed once.
  CONSTRAINT audit_checkpoint_range_end_unique UNIQUE (tenant_id, ledger_id, last_sequence),

  -- The covered range is well-formed and its length matches the recorded event count.
  CONSTRAINT audit_checkpoint_range_ordered CHECK (last_sequence >= first_sequence),
  CONSTRAINT audit_checkpoint_first_positive CHECK (first_sequence >= 1),
  CONSTRAINT audit_checkpoint_count_matches_range
    CHECK (event_count = last_sequence - first_sequence + 1)
);

CREATE INDEX IF NOT EXISTS audit_checkpoint_ledger_idx
  ON audit_checkpoint (tenant_id, ledger_id, last_sequence);
CREATE INDEX IF NOT EXISTS audit_checkpoint_status_idx
  ON audit_checkpoint (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Checkpoints are IMMUTABLE evidence too: the signed range/root/signature cannot be rewritten.
-- Verification results are appended to verification_history via a NEW checkpoint row or an
-- out-of-band verification ledger, never by mutating the signed row.

CREATE OR REPLACE FUNCTION audit_checkpoint_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_checkpoint is append-only: checkpoint % (tenant %, ledger %) cannot be mutated once signed',
    OLD.checkpoint_id, OLD.tenant_id, OLD.ledger_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_checkpoint_append_only_update ON audit_checkpoint;
CREATE TRIGGER audit_checkpoint_append_only_update
  BEFORE UPDATE ON audit_checkpoint
  FOR EACH ROW
  EXECUTE FUNCTION audit_checkpoint_reject_update();

CREATE OR REPLACE FUNCTION audit_checkpoint_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_checkpoint is append-only: checkpoint % (tenant %, ledger %) cannot be deleted once signed',
    OLD.checkpoint_id, OLD.tenant_id, OLD.ledger_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_checkpoint_append_only_delete ON audit_checkpoint;
CREATE TRIGGER audit_checkpoint_append_only_delete
  BEFORE DELETE ON audit_checkpoint
  FOR EACH ROW
  EXECUTE FUNCTION audit_checkpoint_reject_delete();
