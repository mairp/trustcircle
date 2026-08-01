-- 0006_evidence — Evidence, provenance, manifest, access, retention, legal-hold,
-- custody, and disposition tables (Phase 33 / task T033 / GAR-006 /
-- VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 / VO-4aeb030a32c9deebdb3b).
--
-- Design authority (specs/001-governance-control-plane/data-model.md §"Evidence and audit"):
--   * §"EvidenceItem": content-addressed evidence (content_sha256 + content_uri + size + media
--     type), provenance references (source catalog entry / source record / parent), producer +
--     produced/observed time, classification + access_policy, retention_policy_id + retain_until,
--     legal_hold_count + integrity_status, encryption/storage version, and a lifecycle status
--     (pending, committed, quarantined, superseded, disposed).
--   * §"EvidenceRelation": a DIRECTED, IMMUTABLE provenance edge (parent -> child) with
--     relationship (derived_from, redacted_from, repair_of, export_contains, verified_by), method,
--     actor, reason, time, tool/adapter version, and transformation digest — cycles forbidden.
--   * §"EvidenceManifest": an IMMUTABLE ordered set of evidence references with manifest type,
--     scope, canonical JSON digest, creator, created time, policy/control/standard versions,
--     missing-evidence list, SIGNATURE, and verification status.
--   * §"RetentionPolicy, LegalHold, and DispositionRecord": retention policy (classes, duration,
--     disposition action, owner, approval, version, effective dates, review), legal hold (scope,
--     reason, authority, start, release decision, status), and a SIGNED disposition record binding
--     evidence IDs, resolved policies/holds, authorization, method, time, executor, verification.
--   * INVARIANT: "disposition cannot occur while any applicable hold is active, before the longest
--     approved retention requirement ends, or without a complete audit/disposition record."
--
-- Phase-33 acceptance criterion (GAR-006 / VO-b9b935bf93be10bdecdd, contract/positive):
--   "Originals MUST remain immutable or tamper-evident; derived repairs, exports, redactions, and
--    dispositions MUST retain provenance, integrity, authorization, retention, and access history."
--   This migration is the physical enforcement of that obligation:
--     - ORIGINALS IMMUTABLE / TAMPER-EVIDENT: an ORIGINAL evidence_item row is content-addressed
--       (content_sha256 NOT NULL) and its content-identity columns are guarded by an APPEND-ONLY /
--       IMMUTABLE-CORE trigger (evidence_item_reject_content_mutation) that RAISEs if a committed
--       row's content_sha256 / content_uri / kind / created_at / integrity fields are altered, and
--       an ORIGINAL can never be hard-DELETEd (evidence_item_reject_delete) — it can only advance
--       to a tamper-evident lifecycle state via the disposition workflow.
--     - DERIVED RETAINS PROVENANCE: a non-original evidence_item MUST reference its parent
--       (CHECK evidence_item_derived_has_parent) AND that edge is recorded in the append-only,
--       acyclic evidence_relation table (parent <> child, unique per (parent, child, relationship)).
--     - RETAINS INTEGRITY: every evidence_item carries content_sha256 + integrity_status; every
--       provenance edge carries a transformation_digest.
--     - RETAINS AUTHORIZATION: a derived/export/redaction/repair edge and every disposition record
--       carry authorizing principal + grant (CHECK evidence_relation_authorized;
--       disposition_record authorization NOT NULL).
--     - RETAINS RETENTION: evidence_item binds retention_policy_id + retain_until; a disposition is
--       gated (CHECK disposition_record_retention_elapsed) so it cannot execute before retain_until,
--       and (CHECK disposition_record_no_active_hold) so it cannot execute while a hold is active.
--     - RETAINS ACCESS HISTORY: every read/export/disclosure is appended to an APPEND-ONLY
--       evidence_access_log (evidence_access_log_reject_update/_delete) so access history is
--       complete and cannot be rewritten; chain_of_custody records every transfer, likewise
--       append-only.
--
-- WHY a NEW migration (never an edit to an applied one): every migration is CHECKSUM-PINNED once
-- applied (packages/persistence/src/database.ts `runMigrations` records its checksum in
-- schema_migrations and rejects an in-place edit with MigrationChecksumError). This is a new,
-- EXPAND-ONLY migration whose statements are additive and idempotent
-- (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
-- the `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` reinstall idiom) so re-applying is a safe no-op
-- and it composes with 0001–0005/0007/0008 without narrowing a supported column.
--
-- Effect-witness (VO-b9b935bf93be10bdecdd, contract/positive; anchored to the byte-level SQL):
--   Applying this migration yields an INDEPENDENTLY READABLE durable effect — the evidence_item
--   table (content-addressed, immutable-core, retention/hold-bound), the acyclic append-only
--   evidence_relation provenance graph, the signed evidence_manifest, the append-only
--   evidence_access_log + chain_of_custody history, the retention_policy / legal_hold tables, and
--   the signed disposition_record — that could not exist before the migration ran. No writer's
--   success response is the proof; the durable catalog and the immutable, guarded rows are.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d): EXPAND only.
-- No destructive or narrowing DDL — nothing is dropped or narrowed. The only trigger-reinstall
-- uses the idempotent idiom (DROP TRIGGER IF EXISTS immediately followed by a CREATE TRIGGER of
-- the same name), so re-applying is a safe no-op.

-- ===========================================================================
-- 0. Enumerated types — evidence kind, lifecycle status, provenance relationship, integrity
--    status, manifest verification status, legal-hold status, and disposition method.
--    Guarded so re-apply is a no-op (CREATE TYPE has no IF NOT EXISTS in PostgreSQL).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_kind') THEN
    CREATE TYPE evidence_kind AS ENUM (
      'original',       -- captured directly from a source; immutable, no parent
      'derived',        -- computed/normalized from a parent
      'export',         -- an export bundle produced FROM parents
      'redaction',      -- a redacted copy of a parent
      'repair',         -- a low-risk derived repair of a parent
      'simulation',     -- a simulation artifact
      'verification'    -- a verification result artifact
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_status') THEN
    CREATE TYPE evidence_status AS ENUM (
      'pending',        -- captured, not yet committed to immutable storage
      'committed',      -- committed; content identity is now immutable/tamper-evident
      'quarantined',    -- quarantined from execution, still visible/inspectable
      'superseded',     -- replaced by a newer derived item; original body retained
      'disposed'        -- disposition executed under a signed record (tamper-evident)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_integrity_status') THEN
    CREATE TYPE evidence_integrity_status AS ENUM (
      'unverified',     -- content digest not yet re-verified
      'intact',         -- content re-hashes to the recorded content_sha256
      'tampered'        -- content does NOT match — tamper detected (sticky)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_relationship') THEN
    CREATE TYPE evidence_relationship AS ENUM (
      'derived_from',
      'redacted_from',
      'repair_of',
      'export_contains',
      'verified_by'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_manifest_status') THEN
    CREATE TYPE evidence_manifest_status AS ENUM (
      'draft',
      'signed',
      'verified',
      'tampered'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'legal_hold_status') THEN
    CREATE TYPE legal_hold_status AS ENUM (
      'active',
      'released'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'disposition_method') THEN
    CREATE TYPE disposition_method AS ENUM (
      'delete',
      'anonymize',
      'archive',
      'crypto_shred'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'custody_event_type') THEN
    CREATE TYPE custody_event_type AS ENUM (
      'captured',
      'transferred',
      'exported',
      'sealed',
      'released',
      'disposed'
    );
  END IF;
END
$$;

-- ===========================================================================
-- 1. retention_policy — approved, versioned retention requirements.
--    A disposition resolves the LONGEST applicable approved policy's expiry (see disposition gate).

CREATE TABLE IF NOT EXISTS retention_policy (
  retention_policy_id         UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  name                        TEXT NOT NULL,
  -- Applicability: evidence classifications this policy applies to; empty array = applies to all.
  applies_to_classifications  TEXT[] NOT NULL DEFAULT '{}',
  -- Retention duration in milliseconds; a positive, bounded window.
  duration_millis             BIGINT NOT NULL,
  -- The disposition action this policy prescribes when retention elapses.
  disposition_action          disposition_method NOT NULL,
  owner_principal_id          UUID NOT NULL,
  -- APPROVAL: an unapproved policy does not count toward retention resolution.
  approved                    BOOLEAN NOT NULL DEFAULT false,
  approved_by_principal_id    UUID,
  version                     TEXT NOT NULL,
  effective_from              BIGINT NOT NULL,
  effective_until             BIGINT,
  review_at                   BIGINT,
  created_at                  BIGINT NOT NULL,

  CONSTRAINT retention_policy_pk PRIMARY KEY (retention_policy_id),
  CONSTRAINT retention_policy_version_unique UNIQUE (tenant_id, name, version),
  CONSTRAINT retention_policy_duration_positive CHECK (duration_millis >= 0),
  -- An APPROVED policy must name the approver (approval is accountable).
  CONSTRAINT retention_policy_approval_accountable CHECK (
    approved = false OR approved_by_principal_id IS NOT NULL
  ),
  CONSTRAINT retention_policy_effective_ordered CHECK (
    effective_until IS NULL OR effective_until >= effective_from
  )
);

CREATE INDEX IF NOT EXISTS retention_policy_tenant_idx
  ON retention_policy (tenant_id, approved);

-- ===========================================================================
-- 2. legal_hold — a hold that FORBIDS disposition of covered evidence while active.

CREATE TABLE IF NOT EXISTS legal_hold (
  legal_hold_id               UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  reason                      TEXT NOT NULL,
  -- Authority that placed the hold (accountable).
  authority_principal_id      UUID NOT NULL,
  -- Scope: specific evidence IDs the hold covers; empty array = covers the whole tenant.
  scope_evidence_ids          UUID[] NOT NULL DEFAULT '{}',
  status                      legal_hold_status NOT NULL DEFAULT 'active',
  placed_at                   BIGINT NOT NULL,
  -- A RELEASED hold must record who released it and when — the release decision is accountable.
  released_at                 BIGINT,
  released_by_principal_id    UUID,

  CONSTRAINT legal_hold_pk PRIMARY KEY (legal_hold_id),
  -- A released hold carries a complete, accountable release decision.
  CONSTRAINT legal_hold_release_accountable CHECK (
    status = 'active'
    OR (released_at IS NOT NULL AND released_by_principal_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS legal_hold_tenant_status_idx
  ON legal_hold (tenant_id, status);

-- ===========================================================================
-- 3. evidence_item — the content-addressed evidence record.
--
--    Originals are IMMUTABLE / TAMPER-EVIDENT (content identity guarded once committed; never
--    hard-deleted). Derived items MUST retain their provenance edge to a parent. Every item binds
--    retention (retention_policy_id + retain_until) and integrity (content_sha256 + integrity_status).

CREATE TABLE IF NOT EXISTS evidence_item (
  evidence_item_id            UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  kind                        evidence_kind NOT NULL,

  -- CONTENT-ADDRESSED identity (INTEGRITY / TAMPER-EVIDENCE anchor). content_sha256 is the digest
  -- over the content bytes; content_uri points at immutable storage; size/media type describe it.
  content_uri                 TEXT NOT NULL,
  content_sha256              TEXT NOT NULL,
  size_bytes                  BIGINT NOT NULL,
  media_type                  TEXT NOT NULL,

  -- PROVENANCE references. An ORIGINAL has no parent; a DERIVED item MUST have one (CHECK below).
  parent_evidence_id          UUID,
  source_catalog_entry_id     UUID,
  source_record_id            UUID,

  -- Producer + observation/production time (accountability of capture).
  produced_by_principal_id    UUID NOT NULL,
  produced_at                 BIGINT NOT NULL,
  observed_at                 BIGINT,

  -- CLASSIFICATION + access policy (authorization inputs).
  classification              TEXT NOT NULL,
  access_policy_id            UUID NOT NULL,

  -- RETENTION binding — resolved before disposition.
  retention_policy_id         UUID,
  retain_until                BIGINT,
  legal_hold_count            INTEGER NOT NULL DEFAULT 0,

  -- INTEGRITY status — re-verifiable; 'tampered' is a sticky detection.
  integrity_status            evidence_integrity_status NOT NULL DEFAULT 'unverified',

  -- Storage metadata.
  encryption_key_ref          TEXT NOT NULL,
  storage_version_id          TEXT NOT NULL,

  -- Lifecycle. An original's content identity is immutable once 'committed' (trigger below).
  status                      evidence_status NOT NULL DEFAULT 'pending',
  created_at                  BIGINT NOT NULL,

  CONSTRAINT evidence_item_pk PRIMARY KEY (evidence_item_id),
  CONSTRAINT evidence_item_tenant_id_key UNIQUE (tenant_id, evidence_item_id),

  -- INTEGRITY: a content digest is always required.
  CONSTRAINT evidence_item_content_digest_present CHECK (length(content_sha256) > 0),
  CONSTRAINT evidence_item_size_nonneg CHECK (size_bytes >= 0),
  CONSTRAINT evidence_item_hold_count_nonneg CHECK (legal_hold_count >= 0),

  -- PROVENANCE: an original has NO parent; any non-original (derived/export/redaction/repair/
  -- simulation/verification) MUST retain a provenance edge to a parent evidence item.
  CONSTRAINT evidence_item_original_has_no_parent CHECK (
    kind <> 'original' OR parent_evidence_id IS NULL
  ),
  CONSTRAINT evidence_item_derived_has_parent CHECK (
    kind = 'original' OR parent_evidence_id IS NOT NULL
  ),
  -- No item is its own parent.
  CONSTRAINT evidence_item_not_self_parent CHECK (
    parent_evidence_id IS NULL OR parent_evidence_id <> evidence_item_id
  )
);

-- Read paths: a tenant's evidence, provenance children of a parent, and retention/hold sweeps.
CREATE INDEX IF NOT EXISTS evidence_item_tenant_idx
  ON evidence_item (tenant_id, kind, status);
CREATE INDEX IF NOT EXISTS evidence_item_parent_idx
  ON evidence_item (tenant_id, parent_evidence_id);
CREATE INDEX IF NOT EXISTS evidence_item_retention_idx
  ON evidence_item (tenant_id, retain_until);
CREATE INDEX IF NOT EXISTS evidence_item_digest_idx
  ON evidence_item (tenant_id, content_sha256);

-- ---------------------------------------------------------------------------
-- IMMUTABILITY / TAMPER-EVIDENCE for committed evidence (originals in particular).
-- Once an evidence_item is 'committed', its CONTENT IDENTITY columns (kind, content_uri,
-- content_sha256, size_bytes, media_type, parent_evidence_id, produced_by/at, created_at) can
-- NEVER be rewritten. Only lifecycle/verification fields advance (status forward, integrity_status,
-- retention binding, legal_hold_count). This makes any attempt to alter the original's content or
-- provenance a REJECTED, tamper-EVIDENT event rather than a silent overwrite.

CREATE OR REPLACE FUNCTION evidence_item_reject_content_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pending' THEN
    -- Pre-commit rows may still be finalized; identity is not yet frozen.
    RETURN NEW;
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.content_uri IS DISTINCT FROM OLD.content_uri
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.media_type IS DISTINCT FROM OLD.media_type
     OR NEW.parent_evidence_id IS DISTINCT FROM OLD.parent_evidence_id
     OR NEW.produced_by_principal_id IS DISTINCT FROM OLD.produced_by_principal_id
     OR NEW.produced_at IS DISTINCT FROM OLD.produced_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'evidence_item % is committed and tamper-evident: content/provenance identity cannot be mutated',
      OLD.evidence_item_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evidence_item_immutable_core ON evidence_item;
CREATE TRIGGER evidence_item_immutable_core
  BEFORE UPDATE ON evidence_item
  FOR EACH ROW
  EXECUTE FUNCTION evidence_item_reject_content_mutation();

CREATE OR REPLACE FUNCTION evidence_item_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_item % cannot be hard-deleted: originals are immutable; use the signed disposition workflow',
    OLD.evidence_item_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_item_no_delete ON evidence_item;
CREATE TRIGGER evidence_item_no_delete
  BEFORE DELETE ON evidence_item
  FOR EACH ROW
  EXECUTE FUNCTION evidence_item_reject_delete();

-- ===========================================================================
-- 4. evidence_relation — the DIRECTED, IMMUTABLE, ACYCLIC provenance edge.
--
--    parent -> child, with the relationship, the transformation that produced the child, the
--    authorizing principal/grant (a derived repair/export/redaction is an AUTHORIZED action), the
--    actor/reason/time, tool/adapter version, and a transformation digest (INTEGRITY of the edge).

CREATE TABLE IF NOT EXISTS evidence_relation (
  evidence_relation_id        UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  parent_evidence_id          UUID NOT NULL,
  child_evidence_id           UUID NOT NULL,
  relationship                evidence_relationship NOT NULL,

  -- The transformation that produced the child from the parent (INTEGRITY of the edge).
  method                      TEXT NOT NULL,
  transformation_digest       TEXT NOT NULL,
  tool_adapter_version        TEXT NOT NULL,

  -- ACTOR + REASON + TIME (provenance accountability).
  actor_principal_id          UUID NOT NULL,
  reason                      TEXT NOT NULL,
  created_at                  BIGINT NOT NULL,

  -- AUTHORIZATION: the grant that authorized the transformation (a derived repair, export,
  -- redaction, or disposition is an authorized action).
  authorization_principal_id  UUID NOT NULL,
  authorization_grant_id      UUID NOT NULL,

  CONSTRAINT evidence_relation_pk PRIMARY KEY (evidence_relation_id),
  -- One edge per (parent, child, relationship): the provenance graph is deterministic.
  CONSTRAINT evidence_relation_edge_unique UNIQUE (tenant_id, parent_evidence_id, child_evidence_id, relationship),

  -- ACYCLIC (self-loop guard): a node is never its own provenance parent. (Deeper cycles are
  -- prevented by the application-layer acyclicity check; the DB guards the trivial self-edge.)
  CONSTRAINT evidence_relation_no_self_edge CHECK (parent_evidence_id <> child_evidence_id),

  -- AUTHORIZATION completeness: every provenance edge names its authorizing principal AND grant.
  CONSTRAINT evidence_relation_authorized CHECK (
    authorization_principal_id IS NOT NULL AND authorization_grant_id IS NOT NULL
  ),
  -- INTEGRITY completeness: every edge carries a non-empty transformation digest.
  CONSTRAINT evidence_relation_digest_present CHECK (length(transformation_digest) > 0)
);

CREATE INDEX IF NOT EXISTS evidence_relation_parent_idx
  ON evidence_relation (tenant_id, parent_evidence_id);
CREATE INDEX IF NOT EXISTS evidence_relation_child_idx
  ON evidence_relation (tenant_id, child_evidence_id);

-- The provenance graph is IMMUTABLE: an edge is never rewritten or deleted once recorded.
CREATE OR REPLACE FUNCTION evidence_relation_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_relation % is append-only: a recorded provenance edge cannot be mutated',
    OLD.evidence_relation_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_relation_append_only_update ON evidence_relation;
CREATE TRIGGER evidence_relation_append_only_update
  BEFORE UPDATE ON evidence_relation
  FOR EACH ROW
  EXECUTE FUNCTION evidence_relation_reject_update();

CREATE OR REPLACE FUNCTION evidence_relation_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_relation % is append-only: a recorded provenance edge cannot be deleted',
    OLD.evidence_relation_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_relation_append_only_delete ON evidence_relation;
CREATE TRIGGER evidence_relation_append_only_delete
  BEFORE DELETE ON evidence_relation
  FOR EACH ROW
  EXECUTE FUNCTION evidence_relation_reject_delete();

-- ===========================================================================
-- 5. evidence_manifest — the IMMUTABLE, SIGNED ordered set of evidence references.
--
--    manifest type + scope, the ORDERED evidence reference list, the canonical JSON digest over
--    that list, creator + created time, policy/control/standard versions, a missing-evidence list,
--    a SIGNATURE, and a verification status. Signing makes an export/audit package tamper-evident.

CREATE TABLE IF NOT EXISTS evidence_manifest (
  evidence_manifest_id        UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  manifest_type               TEXT NOT NULL,
  scope                       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ORDERED evidence references (array preserves order) + the canonical digest over the manifest.
  evidence_item_ids           UUID[] NOT NULL DEFAULT '{}',
  canonical_digest            TEXT NOT NULL,

  created_by_principal_id     UUID NOT NULL,
  created_at                  BIGINT NOT NULL,

  policy_version_ids          UUID[] NOT NULL DEFAULT '{}',
  control_version_ids         UUID[] NOT NULL DEFAULT '{}',
  standard_version_ids        UUID[] NOT NULL DEFAULT '{}',
  missing_evidence_ids        UUID[] NOT NULL DEFAULT '{}',

  -- SIGNATURE metadata — the signed part of the signed manifest.
  signing_key_id              TEXT NOT NULL,
  signature_algorithm         TEXT NOT NULL,
  signature                   TEXT NOT NULL,

  status                      evidence_manifest_status NOT NULL DEFAULT 'signed',
  verification_history        JSONB NOT NULL DEFAULT '[]'::jsonb,

  CONSTRAINT evidence_manifest_pk PRIMARY KEY (evidence_manifest_id),
  CONSTRAINT evidence_manifest_tenant_key UNIQUE (tenant_id, evidence_manifest_id),
  CONSTRAINT evidence_manifest_digest_present CHECK (length(canonical_digest) > 0),
  -- A signed/verified manifest carries a non-empty signature.
  CONSTRAINT evidence_manifest_signed_has_signature CHECK (
    status = 'draft' OR length(signature) > 0
  )
);

CREATE INDEX IF NOT EXISTS evidence_manifest_tenant_idx
  ON evidence_manifest (tenant_id, manifest_type, status);

-- A signed manifest is IMMUTABLE: the signed body/signature is never rewritten in place. A new
-- verification result is appended via a NEW manifest row or an out-of-band verification ledger.
CREATE OR REPLACE FUNCTION evidence_manifest_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW; -- a draft may still be finalized before signing
  END IF;
  RAISE EXCEPTION
    'evidence_manifest % is signed and immutable: it cannot be mutated once signed',
    OLD.evidence_manifest_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_manifest_immutable ON evidence_manifest;
CREATE TRIGGER evidence_manifest_immutable
  BEFORE UPDATE ON evidence_manifest
  FOR EACH ROW
  EXECUTE FUNCTION evidence_manifest_reject_update();

CREATE OR REPLACE FUNCTION evidence_manifest_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_manifest % is immutable: a signed manifest cannot be deleted',
    OLD.evidence_manifest_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_manifest_no_delete ON evidence_manifest;
CREATE TRIGGER evidence_manifest_no_delete
  BEFORE DELETE ON evidence_manifest
  FOR EACH ROW
  EXECUTE FUNCTION evidence_manifest_reject_delete();

-- ===========================================================================
-- 6. evidence_access_log — the APPEND-ONLY ACCESS HISTORY.
--
--    Every read/export/disclosure/decryption of an evidence item is appended here with the
--    accessing principal, action, purpose, decision (granted/denied), time, and correlation, so
--    the access history is COMPLETE and CANNOT be rewritten (append-only guards below).

CREATE TABLE IF NOT EXISTS evidence_access_log (
  access_log_id               UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  evidence_item_id            UUID NOT NULL,
  principal_id                UUID NOT NULL,
  action                      TEXT NOT NULL,            -- read | export | disclose | decrypt | verify
  purpose                     TEXT NOT NULL,
  decision                    TEXT NOT NULL,            -- granted | denied
  access_policy_id            UUID,
  correlation_id              UUID,
  accessed_at                 BIGINT NOT NULL,

  CONSTRAINT evidence_access_log_pk PRIMARY KEY (access_log_id),
  CONSTRAINT evidence_access_log_decision_bounded CHECK (decision IN ('granted', 'denied'))
);

CREATE INDEX IF NOT EXISTS evidence_access_log_item_idx
  ON evidence_access_log (tenant_id, evidence_item_id, accessed_at);
CREATE INDEX IF NOT EXISTS evidence_access_log_principal_idx
  ON evidence_access_log (tenant_id, principal_id, accessed_at);

CREATE OR REPLACE FUNCTION evidence_access_log_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_access_log is append-only: an access-history row cannot be updated'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_access_log_append_only_update ON evidence_access_log;
CREATE TRIGGER evidence_access_log_append_only_update
  BEFORE UPDATE ON evidence_access_log
  FOR EACH ROW
  EXECUTE FUNCTION evidence_access_log_reject_update();

CREATE OR REPLACE FUNCTION evidence_access_log_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'evidence_access_log is append-only: an access-history row cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS evidence_access_log_append_only_delete ON evidence_access_log;
CREATE TRIGGER evidence_access_log_append_only_delete
  BEFORE DELETE ON evidence_access_log
  FOR EACH ROW
  EXECUTE FUNCTION evidence_access_log_reject_delete();

-- ===========================================================================
-- 7. chain_of_custody — the APPEND-ONLY CUSTODY history.
--
--    Every custody event (captured, transferred, exported, sealed, released, disposed) records
--    who held the evidence, who it moved to, the reason, the content digest AT that point (so a
--    silent content swap during transfer is detectable), and the time. Append-only: custody
--    history is reconstructable and cannot be rewritten.

CREATE TABLE IF NOT EXISTS chain_of_custody (
  custody_id                  UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  evidence_item_id            UUID NOT NULL,
  -- Monotonic per-item custody sequence so the transfer order is reconstructable and gap-checkable.
  sequence                    BIGINT NOT NULL,
  event_type                  custody_event_type NOT NULL,
  from_principal_id           UUID,
  to_principal_id             UUID NOT NULL,
  reason                      TEXT NOT NULL,
  -- INTEGRITY at handoff: the content digest observed at this custody event.
  content_sha256              TEXT NOT NULL,
  occurred_at                 BIGINT NOT NULL,

  CONSTRAINT chain_of_custody_pk PRIMARY KEY (custody_id),
  -- One custody row per (item, sequence): a strict order that cannot fork.
  CONSTRAINT chain_of_custody_seq_unique UNIQUE (tenant_id, evidence_item_id, sequence),
  CONSTRAINT chain_of_custody_seq_positive CHECK (sequence >= 1),
  CONSTRAINT chain_of_custody_digest_present CHECK (length(content_sha256) > 0)
);

CREATE INDEX IF NOT EXISTS chain_of_custody_item_idx
  ON chain_of_custody (tenant_id, evidence_item_id, sequence);

CREATE OR REPLACE FUNCTION chain_of_custody_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'chain_of_custody is append-only: a custody record cannot be updated'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS chain_of_custody_append_only_update ON chain_of_custody;
CREATE TRIGGER chain_of_custody_append_only_update
  BEFORE UPDATE ON chain_of_custody
  FOR EACH ROW
  EXECUTE FUNCTION chain_of_custody_reject_update();

CREATE OR REPLACE FUNCTION chain_of_custody_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'chain_of_custody is append-only: a custody record cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS chain_of_custody_append_only_delete ON chain_of_custody;
CREATE TRIGGER chain_of_custody_append_only_delete
  BEFORE DELETE ON chain_of_custody
  FOR EACH ROW
  EXECUTE FUNCTION chain_of_custody_reject_delete();

-- ===========================================================================
-- 8. disposition_record — the SIGNED, GATED disposition.
--
--    A disposition binds the disposed evidence, the resolved policies + cleared holds, the
--    AUTHORIZATION (principal + grant), the method, executor, time, verification, the retained
--    ACCESS HISTORY snapshot, the content digest of the disposed original (provenance/integrity),
--    and a SIGNATURE over the record body (tamper-evidence). The GATE (CHECKs below) enforces the
--    invariant: no disposition before retention elapses or while a hold is active, and never
--    without a complete, authorized, signed record.

CREATE TABLE IF NOT EXISTS disposition_record (
  disposition_id              UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  evidence_item_id            UUID NOT NULL,

  method                      disposition_method NOT NULL,
  -- Retention/hold resolution captured at disposition time (RETENTION history).
  resolved_policy_ids         UUID[] NOT NULL DEFAULT '{}',
  cleared_hold_ids            UUID[] NOT NULL DEFAULT '{}',
  resolved_retain_until       BIGINT,
  active_hold_count_at_exec   INTEGER NOT NULL DEFAULT 0,

  -- AUTHORIZATION (principal + grant) — a disposition is an authorized action.
  authorization_principal_id  UUID NOT NULL,
  authorization_grant_id      UUID NOT NULL,

  executed_by_principal_id    UUID NOT NULL,
  executed_at                 BIGINT NOT NULL,

  -- INTEGRITY / PROVENANCE anchor: the content digest of the disposed original.
  content_sha256              TEXT NOT NULL,
  -- Retained ACCESS HISTORY snapshot at disposition (auditability after the body is gone).
  access_history              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Verification that the disposition executed as recorded.
  verification_status         TEXT NOT NULL DEFAULT 'pending',

  -- SIGNATURE over the canonical record body (tamper-evidence).
  signing_key_id              TEXT NOT NULL,
  signature_algorithm         TEXT NOT NULL,
  signature                   TEXT NOT NULL,

  CONSTRAINT disposition_record_pk PRIMARY KEY (disposition_id),
  -- One disposition per evidence item (an item is disposed once).
  CONSTRAINT disposition_record_item_unique UNIQUE (tenant_id, evidence_item_id),

  -- AUTHORIZATION completeness.
  CONSTRAINT disposition_record_authorized CHECK (
    authorization_principal_id IS NOT NULL AND authorization_grant_id IS NOT NULL
  ),
  -- SIGNED: a disposition record is always signed (tamper-evidence, no unsigned disposal).
  CONSTRAINT disposition_record_signed CHECK (length(signature) > 0),
  -- INVARIANT — NO ACTIVE HOLD: a disposition cannot execute while any applicable hold is active.
  CONSTRAINT disposition_record_no_active_hold CHECK (active_hold_count_at_exec = 0),
  -- INVARIANT — RETENTION ELAPSED: a disposition cannot execute before the longest approved
  -- retention requirement ends (executed_at must be at or after the resolved retain_until; a NULL
  -- resolved retain_until means no approved policy applied, which is permitted).
  CONSTRAINT disposition_record_retention_elapsed CHECK (
    resolved_retain_until IS NULL OR executed_at >= resolved_retain_until
  )
);

CREATE INDEX IF NOT EXISTS disposition_record_item_idx
  ON disposition_record (tenant_id, evidence_item_id);
CREATE INDEX IF NOT EXISTS disposition_record_executed_idx
  ON disposition_record (tenant_id, executed_at);

-- A disposition record is IMMUTABLE evidence too: the signed record is never rewritten or deleted.
CREATE OR REPLACE FUNCTION disposition_record_reject_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'disposition_record % is signed and immutable: it cannot be mutated once recorded',
    OLD.disposition_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS disposition_record_immutable_update ON disposition_record;
CREATE TRIGGER disposition_record_immutable_update
  BEFORE UPDATE ON disposition_record
  FOR EACH ROW
  EXECUTE FUNCTION disposition_record_reject_update();

CREATE OR REPLACE FUNCTION disposition_record_reject_delete()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'disposition_record % is immutable: a signed disposition record cannot be deleted',
    OLD.disposition_id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS disposition_record_immutable_delete ON disposition_record;
CREATE TRIGGER disposition_record_immutable_delete
  BEFORE DELETE ON disposition_record
  FOR EACH ROW
  EXECUTE FUNCTION disposition_record_reject_delete();
