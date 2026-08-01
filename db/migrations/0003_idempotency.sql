-- 0003_idempotency — Scoped idempotency records and same-key/different-digest
-- conflict enforcement (Phase 23 / task T023 / VO-3cc80819915c2d5e64ba,
-- VO-52d0780c11bcc6fd7583).
--
-- Design authority (specs/001-governance-control-plane):
--   * data-model.md §"IdempotencyRecord":
--       "Unique (tenant_id, operation_scope, idempotency_key) with request digest,
--        canonical operation ID, first/last seen, result status, response
--        digest/reference, and expiry. Reusing a key with a different request
--        digest is a conflict."
--   * data-model.md §"Database enforcement and indexes":
--       "Unique constraints cover external source versions, idempotency keys,
--        ledger sequence, ..."
--   * plan.md / spec.md CHK016: mutating operations MUST be correlated,
--     deduplicated, reconcilable, retry-bounded, and safe under duplicate,
--     delayed, partial, conflicting, and uncertain outcomes.
--
-- This migration is the DURABLE, GOVERNED definition of the idempotency ledger.
-- The Phase-17 runner bootstraps a minimal `idempotency_ledger` shape for its own
-- bookkeeping (packages/persistence/src/database.ts BOOTSTRAP_SQL, `IF NOT EXISTS`);
-- this migration formalizes that same table as a supported source contract, adds
-- the SCOPED-identity uniqueness key, the canonical-operation / expiry columns from
-- the data model, and — most importantly — the SAME-KEY / DIFFERENT-DIGEST CONFLICT
-- ENFORCEMENT as a database-level guard (a trigger) so a reused key carrying a
-- materially different request can never silently overwrite the recorded request.
-- Because both definitions are `IF NOT EXISTS`/idempotent and column-compatible,
-- applying this migration on top of the bootstrapped table is a safe no-op-or-extend.
--
-- Effect-witness (VO-3cc80819915c2d5e64ba, integration, effect-witness):
--   Applying the migration yields an INDEPENDENTLY READABLE durable effect — the
--   physical `idempotency_ledger` table, its scoped unique key, its expiry index,
--   and the `idempotency_ledger_conflict_guard` trigger + function — that could not
--   exist before the migration ran. The mutation runner's success response is NOT
--   the proof; the durable catalog is.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d):
-- EXPAND only. Every statement is additive and idempotent (`IF NOT EXISTS`,
-- `CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`, `DO $$ ... $$` guards) so
-- re-applying is a safe no-op and it composes with the runner's bootstrapped table
-- without narrowing a supported column. A later narrowing change goes through a NEW
-- expand→migrate→contract migration with deprecation + rollback evidence. The runner
-- (packages/persistence/src/database.ts `runMigrations`) pins this file's checksum
-- once applied, so editing it in place after it has run is rejected
-- (MigrationChecksumError) — an applied migration is immutable.

-- ===========================================================================
-- 1. Idempotency ledger — the scoped deduplication record.
--    Scope identity is the tuple (tenant_id, operation_scope, idempotency_key):
--      * tenant_id       — the isolation boundary (deduplication never crosses tenants).
--      * operation_scope — the operation class, e.g. "controller.repair".
--      * idempotency_key — the caller-supplied key, unique per (tenant, scope) per
--                          logical request.
--    request_digest is the canonical hash of the request body; reusing a key with a
--    DIFFERENT request_digest is a conflict (enforced by the trigger in §3).
--    status is the terminal result class; response_digest/response_json are the
--    recorded result so a duplicate replay returns it WITHOUT re-executing the effect.
--    first_seen_at / last_seen_at / attempts make history reconstructable; expires_at
--    bounds ledger retention (data-model.md: "... first/last seen, result status,
--    response digest/reference, and expiry").
-- ===========================================================================
CREATE TABLE IF NOT EXISTS idempotency_ledger (
  tenant_id             TEXT NOT NULL,
  operation_scope       TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  correlation_id        TEXT NOT NULL,
  request_digest        TEXT NOT NULL,
  contract_version      TEXT NOT NULL,
  status                TEXT NOT NULL,
  response_digest       TEXT,
  response_json         TEXT,
  first_seen_at         BIGINT NOT NULL,
  last_seen_at          BIGINT NOT NULL,
  attempts              INTEGER NOT NULL,
  -- The scope tuple (tenant_id, operation_scope, idempotency_key) is the primary key.
  PRIMARY KEY (tenant_id, operation_scope, idempotency_key)
);

-- Canonical operation id + expiry are part of the data-model IdempotencyRecord but
-- are NOT in the runner's minimal bootstrap shape. Add them idempotently so this
-- migration extends (never narrows) the bootstrapped table when it is already present.
ALTER TABLE idempotency_ledger
  ADD COLUMN IF NOT EXISTS canonical_operation_id TEXT;
ALTER TABLE idempotency_ledger
  ADD COLUMN IF NOT EXISTS expires_at BIGINT;

-- ===========================================================================
-- 2. Scoped uniqueness + retention/replay indexes.
--    The PRIMARY KEY already makes the scope tuple unique; we add an explicit named
--    UNIQUE index too so the scoped-identity contract is discoverable by name and can
--    be referenced by tooling. Plus a partial index over expiring records for the
--    ledger-reaper scan, and a status index for the reconciliation scan.
-- ===========================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_ledger_scope_key_unique
  ON idempotency_ledger (tenant_id, operation_scope, idempotency_key);

CREATE INDEX IF NOT EXISTS idempotency_ledger_expiring_idx
  ON idempotency_ledger (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idempotency_ledger_status_idx
  ON idempotency_ledger (tenant_id, operation_scope, status);

-- ===========================================================================
-- 3. Same-key / different-digest CONFLICT ENFORCEMENT (the phase's core guard).
--    The scope tuple is unique, so an INSERT with an already-seen key raises a
--    unique-violation (the caller upserts via ON CONFLICT). But an UPSERT
--    (INSERT ... ON CONFLICT DO UPDATE) could otherwise silently OVERWRITE the
--    stored request_digest with a different one — turning a genuine conflict into a
--    lost-update. This BEFORE-UPDATE trigger makes that structurally impossible:
--    once a scope tuple has recorded a request_digest, any UPDATE that tries to
--    change it to a different non-null digest is REJECTED with a raised exception.
--    A same-digest replay (the legitimate dedup/retry path) is allowed to refresh
--    last_seen_at / attempts / status / response.
--
--    This mirrors packages/persistence/src/database.ts `runMutation`, which reads the
--    ledger on the independent path and throws IdempotencyConflictError when the
--    incoming request_digest differs from the recorded one — the database is the
--    defense-in-depth backstop so the invariant holds even if an application path
--    forgets the check (data-model.md: "Reusing a key with a different request digest
--    is a conflict").
-- ===========================================================================
CREATE OR REPLACE FUNCTION idempotency_ledger_reject_digest_change()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Only guard a genuine change to a non-null recorded digest. A same-digest
  -- update (the dedup/retry refresh) and the (impossible under this schema) case of
  -- a previously-null digest are allowed through.
  IF OLD.request_digest IS NOT NULL
     AND NEW.request_digest IS NOT NULL
     AND NEW.request_digest <> OLD.request_digest THEN
    RAISE EXCEPTION
      'idempotency conflict for (%, %, %): key reused with a different request digest (recorded=%, incoming=%)',
      OLD.tenant_id, OLD.operation_scope, OLD.idempotency_key,
      OLD.request_digest, NEW.request_digest
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS idempotency_ledger_conflict_guard ON idempotency_ledger;
CREATE TRIGGER idempotency_ledger_conflict_guard
  BEFORE UPDATE ON idempotency_ledger
  FOR EACH ROW
  EXECUTE FUNCTION idempotency_ledger_reject_digest_change();

-- ===========================================================================
-- 4. Retention bound sanity: when an expiry is recorded, it must be at or after the
--    record's first-seen time (a record cannot expire before it existed). Additive
--    named CHECK; NULL expires_at (no expiry set) is allowed.
-- ===========================================================================
DO $$ BEGIN
  ALTER TABLE idempotency_ledger
    ADD CONSTRAINT idempotency_ledger_expiry_after_first_seen
    CHECK (expires_at IS NULL OR expires_at >= first_seen_at);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
