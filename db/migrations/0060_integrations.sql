-- 0060_integrations — Durable INTEGRATION / SOURCE-AND-WORKFLOW-HEALTH substrate for the governance
-- control plane (Phase 8 / User Story 6 — Maintain Source and Workflow Health / FR-029, FR-030 and the
-- broader FR-036..FR-050 continuity family; NFR-010 component-profile oracle; SC-014..SC-016).
--
-- This migration gives the health / reconciliation loops of US6 a physical home. It is aligned
-- column-for-column with packages/adapter-sdk/src/index.ts (manifest / envelope types), with the
-- packages/application integration services (adapter-registry, connector-service, alert-routing,
-- source-ingestion, cursor-recovery, return-to-service, offline-dispatch), and with the
-- apps/command-worker health/retry/reconciler/dead-letter loops, so a projection over these physical
-- rows, the in-memory application aggregates, and an integrations API response share ONE vocabulary
-- and ONE set of invariants.
--
-- The load-bearing US6 discipline, encoded as fail-visible CHECK / trigger constraints:
--   * VERSIONED, SIGNED, IMMUTABLE ADAPTER DEFINITIONS (T228/T230). adapter_definition +
--     adapter_version are platform-scoped and APPEND-ONLY (a BEFORE UPDATE immutability trigger blocks
--     any rewrite of a published version); a new adapter build is a NEW version row with a new
--     content_digest and manifest_signature. A version's lifecycle (registered→tested→approved→
--     activated→suspended→deprecated→superseded→retired) is recorded as append-only transitions.
--   * AT-LEAST-ONCE, DEDUPLICATED, ORDERED DELIVERY (T221). connector_inbox / connector_outbox key
--     every message by (connector_id, dedup_key); a UNIQUE constraint makes a duplicate delivery a
--     no-op at the storage layer, and an explicit sequence column preserves aggregate ordering so a
--     missing sequence is detectable (FR-029).
--   * TERMINAL PAYLOADS ARE PRESERVED (T236 / FR-030). dead_letter retains the ORIGINAL payload,
--     every attempt, the terminal error, business impact, accountable owner, replay authority, and
--     evidence — a poisoned message is never silently dropped, and replay requires explicit authority.
--   * HEALTH IS OBSERVED, NEVER INFERRED FROM ABSENCE (T232). health_observation records an explicit
--     readiness/liveness/freshness/lag reading with the observation time and the owner; the absence of
--     an observation is itself a stale/unknown state (freshness_state), never silently "healthy".
--   * ALERTS ROUTE TO ACCOUNTABLE OWNERS (T233 / SC of 60s visibility / 5m owner-notify). alert_record
--     binds every threshold breach to an owner principal, the breach class, the first-observed and
--     owner-notified timestamps, and recovery.
--   * COMPONENT AVAILABILITY IS SEPARATE FROM DESIGN AUTHORITY (NFR-010 / T223/T247/T248).
--     component_activation records the live availability class + runtime state + activation lifecycle
--     of a governed component WITHOUT granting it authority; only the core profile runs continuously,
--     everything else is intentionally-inactive / on-demand until an owner-approved activation path
--     proves identity, contract, authority, backlog, and reconciliation.
--
-- CONVENTIONS (identical to 0030 / 0040 / 0050): EXPAND-only + idempotent (CREATE ... IF NOT EXISTS /
-- DROP POLICY IF EXISTS then CREATE), so re-applying is a safe no-op. Timestamps are BIGINT epoch
-- millis; every table is tenant-scoped by a UUID tenant_id (platform / central adapter-catalog facts
-- use a NULL tenant_id, readable by every tenant but never tenant-forgeable) and isolated by a forced,
-- RESTRICTIVE RLS policy on current_tenant() (fail-closed on missing tenant). Immutable / append-only
-- rows are protected by BEFORE UPDATE immutability triggers.

-- ===========================================================================
-- Shared append-only immutability trigger function (idempotent create-or-replace).
-- ===========================================================================
CREATE OR REPLACE FUNCTION integrations_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'row is append-only (immutable integration fact); write a new version instead';
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 1. adapter_definition — the STABLE identity of an adapter kind (kanban, workflow_orchestration,
--    agentctl, lisa, wiggum, …). Platform-scoped (tenant_id IS NULL): a central catalog fact readable
--    by every tenant, never tenant-forgeable. A named adapter has exactly ONE definition; its builds
--    are adapter_version rows. An adapter is a CONNECTOR — it observes/drives an external source and is
--    NEVER granted governance authority (authority_grantable is fixed FALSE).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS adapter_definition (
  id                 UUID NOT NULL,
  tenant_id          UUID,             -- NULL = central/platform catalog scope
  adapter_key        TEXT NOT NULL,    -- stable machine key, e.g. 'kanban', 'lisa', 'wiggum'
  display_name       TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'connector',
  authority_grantable BOOLEAN NOT NULL DEFAULT FALSE,
  owner_principal_id UUID NOT NULL,
  content_digest     TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT adapter_definition_category_valid
    CHECK (category IN ('connector','workflow','cli','governance-observer','infrastructure')),
  -- A connector NEVER holds governance authority (US6 checkpoint): the catalog fact forbids it.
  CONSTRAINT adapter_definition_no_authority CHECK (authority_grantable = FALSE),
  CONSTRAINT adapter_definition_key_present CHECK (length(btrim(adapter_key)) > 0),
  UNIQUE (adapter_key)
);
CREATE INDEX IF NOT EXISTS adapter_definition_key_idx ON adapter_definition (adapter_key);

-- ===========================================================================
-- 2. adapter_version — an IMMUTABLE, SIGNED, VERSIONED build of an adapter with its manifest, protocol
--    contract range, declared capabilities, and lifecycle. Append-only; a new build is a new row.
--    (T228 manifest/signature, T230 registry lifecycle.)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS adapter_version (
  id                     UUID NOT NULL,
  tenant_id              UUID,
  definition_id          UUID NOT NULL,
  semantic_version       TEXT NOT NULL,          -- e.g. '1.4.0'
  protocol_min           BIGINT NOT NULL,        -- inclusive lowest supported protocol major
  protocol_max           BIGINT NOT NULL,        -- inclusive highest supported protocol major
  capabilities           JSONB NOT NULL DEFAULT '[]'::jsonb,
  manifest               JSONB NOT NULL,
  manifest_signature     TEXT NOT NULL,          -- detached signature over the canonical manifest
  signing_key_id         TEXT NOT NULL,
  conformance_result_id  UUID,                   -- FK-ish to conformance_run.id when tested
  lifecycle_state        TEXT NOT NULL DEFAULT 'registered',
  content_digest         TEXT NOT NULL,
  created_at             BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT adapter_version_protocol_ordered CHECK (protocol_min <= protocol_max),
  CONSTRAINT adapter_version_protocol_positive CHECK (protocol_min >= 1),
  CONSTRAINT adapter_version_lifecycle_valid
    CHECK (lifecycle_state IN ('registered','tested','approved','activated','suspended',
                               'deprecated','superseded','retired')),
  CONSTRAINT adapter_version_signed
    CHECK (length(btrim(manifest_signature)) > 0 AND length(btrim(signing_key_id)) > 0),
  CONSTRAINT adapter_version_semver_present CHECK (length(btrim(semantic_version)) > 0),
  -- No adapter may be activated without passing conformance first (T230/T254).
  CONSTRAINT adapter_version_activation_requires_conformance
    CHECK (lifecycle_state NOT IN ('activated') OR conformance_result_id IS NOT NULL),
  UNIQUE (definition_id, semantic_version)
);
CREATE INDEX IF NOT EXISTS adapter_version_definition_idx
  ON adapter_version (definition_id, semantic_version);
CREATE INDEX IF NOT EXISTS adapter_version_lifecycle_idx
  ON adapter_version (lifecycle_state);

-- adapter_version_transition — the APPEND-ONLY lifecycle ledger for an adapter version, preserving the
-- evidence and actor for each register/test/approve/activate/suspend/deprecate/supersede/retire step.
CREATE TABLE IF NOT EXISTS adapter_version_transition (
  id             UUID NOT NULL,
  tenant_id      UUID,
  version_id     UUID NOT NULL,
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  actor_principal_id UUID NOT NULL,
  reason         JSONB NOT NULL,
  evidence_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  transitioned_at BIGINT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT adapter_transition_to_valid
    CHECK (to_state IN ('registered','tested','approved','activated','suspended',
                        'deprecated','superseded','retired'))
);
CREATE INDEX IF NOT EXISTS adapter_transition_version_idx
  ON adapter_version_transition (version_id, transitioned_at);

-- conformance_run — a SIGNED language-neutral conformance result manifest for an adapter version
-- (T229). Append-only. Its passing is the gate for activation.
CREATE TABLE IF NOT EXISTS conformance_run (
  id              UUID NOT NULL,
  tenant_id       UUID,
  version_id      UUID NOT NULL,
  suite_version   TEXT NOT NULL,
  passed          BOOLEAN NOT NULL,
  cases_total     BIGINT NOT NULL DEFAULT 0,
  cases_passed    BIGINT NOT NULL DEFAULT 0,
  result_manifest JSONB NOT NULL,
  manifest_signature TEXT NOT NULL,
  signing_key_id  TEXT NOT NULL,
  content_digest  TEXT NOT NULL,
  ran_at          BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT conformance_cases_consistent CHECK (cases_passed <= cases_total),
  CONSTRAINT conformance_pass_requires_all
    CHECK (passed = FALSE OR cases_passed = cases_total),
  CONSTRAINT conformance_signed
    CHECK (length(btrim(manifest_signature)) > 0 AND length(btrim(signing_key_id)) > 0)
);
CREATE INDEX IF NOT EXISTS conformance_run_version_idx ON conformance_run (version_id, ran_at);

-- ===========================================================================
-- 3. connector_instance — a TENANT-SCOPED live connection using a specific adapter version against a
--    specific source, with its enabled capability subset, scopes, cursor, and lifecycle (T231). The
--    enabled capabilities are a SUBSET of the version's declared capabilities; credentials are NEVER
--    stored here (only a credential_ref to the secret store).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS connector_instance (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  definition_id        UUID NOT NULL,
  version_id           UUID NOT NULL,
  source_ref           TEXT NOT NULL,      -- the external source identity this connector observes
  credential_ref       TEXT,               -- opaque handle into the secret store (never a secret)
  enabled_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  scopes               JSONB NOT NULL DEFAULT '[]'::jsonb,
  cursor               JSONB,              -- last durable ingestion cursor (NULL = never ingested)
  cursor_sequence      BIGINT NOT NULL DEFAULT 0,
  availability_class   TEXT NOT NULL DEFAULT 'optional',
  lifecycle_state      TEXT NOT NULL DEFAULT 'inactive',
  owner_principal_id   UUID NOT NULL,
  content_digest       TEXT NOT NULL,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT connector_availability_valid
    CHECK (availability_class IN ('core','optional','on-demand')),
  CONSTRAINT connector_lifecycle_valid
    CHECK (lifecycle_state IN ('inactive','activating','active','maintenance','degraded',
                               'suspended','failed','returning','retired')),
  CONSTRAINT connector_cursor_seq_nonneg CHECK (cursor_sequence >= 0),
  CONSTRAINT connector_source_present CHECK (length(btrim(source_ref)) > 0),
  UNIQUE (tenant_id, definition_id, source_ref)
);
CREATE INDEX IF NOT EXISTS connector_instance_def_idx
  ON connector_instance (tenant_id, definition_id, lifecycle_state);

-- ===========================================================================
-- 4. health_observation — an EXPLICIT owner/version/readiness/liveness/freshness/lag/retry/failure/
--    impact/evidence reading for a connector (T232). Append-only. Health is never inferred from the
--    ABSENCE of a row — an absent/old observation is a stale/unknown freshness_state, surfaced as such.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS health_observation (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  connector_id       UUID NOT NULL,
  observed_version   TEXT,
  owner_principal_id UUID NOT NULL,
  readiness_state    TEXT NOT NULL DEFAULT 'unknown',
  liveness_state     TEXT NOT NULL DEFAULT 'unknown',
  freshness_state    TEXT NOT NULL DEFAULT 'unknown',
  freshness_age_ms   BIGINT,             -- age of the newest source datum (NULL = no data seen)
  lag_ms             BIGINT,             -- ingestion lag behind the source
  retry_depth        BIGINT NOT NULL DEFAULT 0,
  failure_count      BIGINT NOT NULL DEFAULT 0,
  business_impact    TEXT NOT NULL DEFAULT 'none',
  affected_scope     JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  inferred_from_absence BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at        BIGINT NOT NULL,
  content_digest     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT health_readiness_valid CHECK (readiness_state IN ('ready','not_ready','unknown')),
  CONSTRAINT health_liveness_valid CHECK (liveness_state IN ('live','dead','unknown')),
  CONSTRAINT health_freshness_valid CHECK (freshness_state IN ('fresh','stale','unknown')),
  CONSTRAINT health_impact_valid
    CHECK (business_impact IN ('none','low','medium','high','critical')),
  -- T232: a POSITIVE health reading may NEVER be inferred from the absence of telemetry — an
  -- absence-derived observation can only report unknown/stale, never ready/live/fresh.
  CONSTRAINT health_no_positive_from_absence
    CHECK (inferred_from_absence = FALSE
           OR (readiness_state <> 'ready' AND liveness_state <> 'live' AND freshness_state <> 'fresh'))
);
CREATE INDEX IF NOT EXISTS health_observation_connector_idx
  ON health_observation (tenant_id, connector_id, observed_at);

-- ===========================================================================
-- 5. connector_reconciliation_run — a scheduled or on-demand reconciliation of desired vs current
--    connector state, cursors, versions, and mappings, with the unresolved drift it found (T235).
--    The connector-specific name is intentionally distinct from the controller operation
--    reconciliation_run introduced by 0040_controller_operations.sql.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS connector_reconciliation_run (
  id                UUID NOT NULL,
  tenant_id         UUID NOT NULL,
  connector_id      UUID NOT NULL,
  cadence           TEXT NOT NULL DEFAULT 'scheduled',
  desired_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
  drift_items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolved          BOOLEAN NOT NULL DEFAULT FALSE,
  cursor_before     JSONB,
  cursor_after      JSONB,
  owner_principal_id UUID NOT NULL,
  started_at        BIGINT NOT NULL,
  finished_at       BIGINT,
  content_digest    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT reconciliation_cadence_valid CHECK (cadence IN ('scheduled','on_demand','return_to_service')),
  CONSTRAINT reconciliation_time_ordered CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS connector_reconciliation_run_connector_idx
  ON connector_reconciliation_run (tenant_id, connector_id, started_at);

-- ===========================================================================
-- 6. connector_inbox — durable AT-LEAST-ONCE, DEDUPLICATED, ORDERED ingestion (T221 / FR-029). A
--    duplicate delivery under the same (connector_id, dedup_key) is a UNIQUE no-op; the sequence
--    column preserves aggregate ordering so a missing sequence is detectable.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS connector_inbox (
  id               UUID NOT NULL,
  tenant_id        UUID NOT NULL,
  connector_id     UUID NOT NULL,
  dedup_key        TEXT NOT NULL,
  aggregate_ref    TEXT NOT NULL,
  sequence_no      BIGINT NOT NULL,
  schema_major     BIGINT NOT NULL,
  payload          JSONB NOT NULL,
  payload_digest   TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'received',
  attempts         BIGINT NOT NULL DEFAULT 0,
  received_at      BIGINT NOT NULL,
  error            JSONB,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT inbox_processing_valid
    CHECK (processing_state IN ('received','processing','processed','deferred','dead_lettered')),
  CONSTRAINT inbox_sequence_nonneg CHECK (sequence_no >= 0),
  CONSTRAINT inbox_schema_major_positive CHECK (schema_major >= 1),
  -- FR-029 deduplication: a re-delivery under the same dedup key is a storage-level no-op.
  UNIQUE (tenant_id, connector_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS connector_inbox_seq_idx
  ON connector_inbox (tenant_id, connector_id, aggregate_ref, sequence_no);

-- ===========================================================================
-- 7. connector_outbox — durable at-least-once EGRESS with attempt/next-attempt/ack state (T221/T234).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS connector_outbox (
  id               UUID NOT NULL,
  tenant_id        UUID NOT NULL,
  connector_id     UUID NOT NULL,
  dedup_key        TEXT NOT NULL,
  sequence_no      BIGINT NOT NULL,
  operation_id     UUID NOT NULL,
  idempotency_key  TEXT NOT NULL,
  payload          JSONB NOT NULL,
  payload_digest   TEXT NOT NULL,
  publish_state    TEXT NOT NULL DEFAULT 'pending',
  attempts         BIGINT NOT NULL DEFAULT 0,
  next_attempt_at  BIGINT,
  ack_ref          TEXT,
  terminal_error   JSONB,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outbox_publish_valid
    CHECK (publish_state IN ('pending','in_flight','published','failed','dead_lettered')),
  CONSTRAINT outbox_idem_present CHECK (length(btrim(idempotency_key)) >= 8),
  CONSTRAINT outbox_sequence_nonneg CHECK (sequence_no >= 0),
  UNIQUE (tenant_id, connector_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS connector_outbox_pub_idx
  ON connector_outbox (tenant_id, connector_id, publish_state, next_attempt_at);

-- ===========================================================================
-- 8. dead_letter — TERMINAL messages preserved with original payload, attempts, error, impact, owner,
--    replay authority, and evidence (T236 / FR-030). Append-only; nothing is silently dropped.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS dead_letter (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  connector_id       UUID NOT NULL,
  origin             TEXT NOT NULL DEFAULT 'inbox',
  dedup_key          TEXT NOT NULL,
  failure_class      TEXT NOT NULL,
  original_payload   JSONB NOT NULL,
  original_digest    TEXT NOT NULL,
  attempts           JSONB NOT NULL DEFAULT '[]'::jsonb,
  terminal_error     JSONB NOT NULL,
  business_impact    TEXT NOT NULL DEFAULT 'none',
  owner_principal_id UUID NOT NULL,
  replay_authorized_by UUID,
  replay_state       TEXT NOT NULL DEFAULT 'held',
  evidence_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         BIGINT NOT NULL,
  content_digest     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT dead_letter_origin_valid CHECK (origin IN ('inbox','outbox')),
  CONSTRAINT dead_letter_impact_valid
    CHECK (business_impact IN ('none','low','medium','high','critical')),
  CONSTRAINT dead_letter_replay_valid CHECK (replay_state IN ('held','authorized','replayed','discarded')),
  -- FR-030: replay is impossible without an explicit replay authority (never silent).
  CONSTRAINT dead_letter_replay_requires_authority
    CHECK (replay_state IN ('held','discarded') OR replay_authorized_by IS NOT NULL),
  CONSTRAINT dead_letter_payload_present CHECK (length(btrim(original_digest)) > 0)
);
CREATE INDEX IF NOT EXISTS dead_letter_connector_idx
  ON dead_letter (tenant_id, connector_id, replay_state, created_at);

-- ===========================================================================
-- 9. component_activation — the LIVE availability class + runtime state + activation lifecycle of a
--    governed component, SEPARATE from its owner-approved architecture authority (NFR-010 /
--    T223/T247/T248). Only 'core' components run continuously; everything else is intentionally-
--    inactive / on-demand until an owner-approved activation path proves its prerequisites.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS component_activation (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  component_key        TEXT NOT NULL,
  availability_class   TEXT NOT NULL DEFAULT 'optional',
  runtime_state        TEXT NOT NULL DEFAULT 'intentionally_inactive',
  activation_state     TEXT NOT NULL DEFAULT 'inactive',
  identity_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  contract_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  authority_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  backlog_reconciled   BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_principal_id   UUID NOT NULL,
  activated_at         BIGINT,
  updated_at           BIGINT NOT NULL,
  content_digest       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT component_availability_valid
    CHECK (availability_class IN ('core','optional','on-demand')),
  CONSTRAINT component_runtime_valid
    CHECK (runtime_state IN ('active','intentionally_inactive','maintenance','unavailable',
                             'degraded','stale','failed','returning')),
  CONSTRAINT component_activation_state_valid
    CHECK (activation_state IN ('inactive','preflight','activating','active','deactivating','failed')),
  -- US6 checkpoint: activation to 'active' requires every prerequisite proven first (identity,
  -- contract, authority, backlog reconciliation) — no mutation before proof.
  CONSTRAINT component_active_requires_preflight
    CHECK (activation_state <> 'active'
           OR (identity_verified AND contract_verified AND authority_verified AND backlog_reconciled)),
  UNIQUE (tenant_id, component_key)
);
CREATE INDEX IF NOT EXISTS component_activation_class_idx
  ON component_activation (tenant_id, availability_class, runtime_state);

-- ===========================================================================
-- 10. alert_record — a threshold-based health/freshness/reconciliation/evidence/contract/
--     control-effectiveness alert routed to an accountable owner, with 60s-visibility and
--     5m-owner-notify timestamps and recovery (T233).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS alert_record (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  connector_id       UUID,
  component_key      TEXT,
  alert_class        TEXT NOT NULL,
  severity           TEXT NOT NULL DEFAULT 'medium',
  owner_principal_id UUID NOT NULL,
  threshold          JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_value     JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at  BIGINT NOT NULL,
  owner_notified_at  BIGINT,
  recovered_at       BIGINT,
  state              TEXT NOT NULL DEFAULT 'open',
  evidence_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_digest     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT alert_class_valid
    CHECK (alert_class IN ('health','freshness','reconciliation','evidence','contract',
                           'control_effectiveness')),
  CONSTRAINT alert_severity_valid CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT alert_state_valid CHECK (state IN ('open','notified','acknowledged','recovered')),
  -- An alert bound to neither a connector nor a component is meaningless.
  CONSTRAINT alert_has_subject CHECK (connector_id IS NOT NULL OR component_key IS NOT NULL),
  CONSTRAINT alert_recovery_ordered CHECK (recovered_at IS NULL OR recovered_at >= first_observed_at)
);
CREATE INDEX IF NOT EXISTS alert_record_owner_idx
  ON alert_record (tenant_id, owner_principal_id, state, first_observed_at);

-- ===========================================================================
-- Append-only immutability triggers on the IMMUTABLE catalog / evidence facts.
-- ===========================================================================
DROP TRIGGER IF EXISTS adapter_definition_immutable ON adapter_definition;
CREATE TRIGGER adapter_definition_immutable BEFORE UPDATE ON adapter_definition
  FOR EACH ROW EXECUTE FUNCTION integrations_block_update();
DROP TRIGGER IF EXISTS adapter_version_immutable ON adapter_version;
CREATE TRIGGER adapter_version_immutable BEFORE UPDATE ON adapter_version
  FOR EACH ROW EXECUTE FUNCTION integrations_block_update();
DROP TRIGGER IF EXISTS adapter_version_transition_immutable ON adapter_version_transition;
CREATE TRIGGER adapter_version_transition_immutable BEFORE UPDATE ON adapter_version_transition
  FOR EACH ROW EXECUTE FUNCTION integrations_block_update();
DROP TRIGGER IF EXISTS conformance_run_immutable ON conformance_run;
CREATE TRIGGER conformance_run_immutable BEFORE UPDATE ON conformance_run
  FOR EACH ROW EXECUTE FUNCTION integrations_block_update();
DROP TRIGGER IF EXISTS health_observation_immutable ON health_observation;
CREATE TRIGGER health_observation_immutable BEFORE UPDATE ON health_observation
  FOR EACH ROW EXECUTE FUNCTION integrations_block_update();
DROP TRIGGER IF EXISTS dead_letter_original_immutable ON dead_letter;
CREATE TRIGGER dead_letter_original_immutable BEFORE UPDATE ON dead_letter
  FOR EACH ROW EXECUTE FUNCTION integrations_block_update();

-- ===========================================================================
-- Forced, RESTRICTIVE tenant-isolation RLS on every integrations table (fail-closed).
-- Central catalog facts (adapter_definition / adapter_version / adapter_version_transition /
-- conformance_run, tenant_id IS NULL) are readable by every tenant but writable only under the
-- current tenant, exactly like the 0050 publication facts.
-- ===========================================================================
ALTER TABLE adapter_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_definition FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON adapter_definition;
CREATE POLICY tenant_isolation ON adapter_definition AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE adapter_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_version FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON adapter_version;
CREATE POLICY tenant_isolation ON adapter_version AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE adapter_version_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_version_transition FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON adapter_version_transition;
CREATE POLICY tenant_isolation ON adapter_version_transition AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE conformance_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE conformance_run FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conformance_run;
CREATE POLICY tenant_isolation ON conformance_run AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE connector_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_instance FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON connector_instance;
CREATE POLICY tenant_isolation ON connector_instance AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE health_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_observation FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON health_observation;
CREATE POLICY tenant_isolation ON health_observation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE connector_reconciliation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_reconciliation_run FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON connector_reconciliation_run;
CREATE POLICY tenant_isolation ON connector_reconciliation_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE connector_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_inbox FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON connector_inbox;
CREATE POLICY tenant_isolation ON connector_inbox AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE connector_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_outbox FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON connector_outbox;
CREATE POLICY tenant_isolation ON connector_outbox AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dead_letter;
CREATE POLICY tenant_isolation ON dead_letter AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE component_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_activation FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON component_activation;
CREATE POLICY tenant_isolation ON component_activation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE alert_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_record FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON alert_record;
CREATE POLICY tenant_isolation ON alert_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
