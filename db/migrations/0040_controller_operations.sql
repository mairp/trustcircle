-- 0040_controller_operations — Durable, tenant-scoped CONTROLLER / OPERATION / SIMULATION /
-- CONTINUITY / RECONCILIATION / ATTEMPT substrate for the governed control plane: controller
-- definitions and their IMMUTABLE versions (manifest-declared capabilities are the ONLY governable
-- actions), controller instances (visible desired-vs-observed drift), simulations (version-pinned,
-- expiring, source-drift-invalidated), controller operations (one idempotency identity +
-- simulate/approve-before-execute), operation attempts (acknowledgement is not confirmation),
-- continuity leases (≤15-min nonrenewable, in-progress-only), and reconciliation runs (never infer
-- success from an ack) (Phase 6 / User Story 4 — Operate Governance Controllers Safely /
-- FR-023..028, FR-046..050, SC-010, SC-011, SC-021, NFR-012, NS-005, NS-011).
--
-- Design authority (specs/001-governance-control-plane):
--   * data-model.md "Controllers, operations, simulation, and bounded continuity" — the CANONICAL
--     field vocabulary. This physical schema is aligned with those entities so a projection over
--     these rows can render the ControllerVersion, ControllerInstance, Simulation, ControllerOperation,
--     OperationAttempt, ControllerContinuityLease, and ReconciliationRun shapes and the API contract
--     without inventing fields. The column names match packages/domain/src/controllers.ts.
--   * spec.md FR-023..028 / FR-046..050:
--       FR-023 discover/inspect declared controllers → controller_definition +
--            controller_definition_version (IMMUTABLE versions declaring capabilities/adapters).
--       FR-024 a controller acts ONLY through MANIFEST-DECLARED capabilities → the declared
--            capabilities live on the version row (declared_capabilities JSONB); an operation binds a
--            capability_key that must be declared (enforced by the service + the operation CHECK that
--            a state-changing operation names a capability).
--       FR-025 simulate before execute; a simulation is VERSION-PINNED and EXPIRES; SOURCE DRIFT
--            invalidates it (NS-005) → simulation binds bound_controller_version_id/adapter_version_id/
--            policy_version_id/source_revision + expires_at; a superseding source revision marks it
--            invalidated.
--       FR-026 ONE idempotency identity per operation (idempotency_key UNIQUE per tenant): a replayed
--            dispatch never produces a second governed effect (FR-027).
--       FR-027 acknowledgement is NOT confirmation → operation_attempt.remote_effect_observed gates
--            the 'confirmed' outcome (a 'dispatched_unconfirmed'/'uncertain' attempt is NOT confirmed).
--       FR-028 an uncertain remote outcome RECONCILES before any new mutation; rollback PROTECTS newer
--            legitimate state (NS-011) → reconciliation_run establishes actual remote state;
--            operation.rollback_result distinguishes a verified rolled_back from conflict (newer state).
--       FR-046..050 / NFR-012 continuity: a bounded, NONRENEWABLE ≤15-minute continuity lease that
--            applies ONLY to an operation approved AND started before the failure, pins a policy
--            snapshot, and never grants new authority → continuity_lease (operation_started_before_
--            failure, ≤15-min ceiling CHECK, renewable=FALSE).
--   * data-model.md "Simulate/approve-before-execute gate" — a state-changing operation may reach
--     'executing' ONLY with a current simulation AND an approval decision (enforced by the operation
--     CHECK). An acknowledgement never becomes confirmation.
--
-- Effect-witness: applying this migration yields an INDEPENDENTLY READABLE durable effect — the seven
-- controller/operation tables, their governance columns, their fail-visible CHECK vocabularies, and
-- their operator/queue indexes — that could not exist before the migration ran.
--
-- Change discipline (db/migrations/README.md): EXPAND only. Every statement is additive and
-- idempotent (CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS then CREATE), so re-applying is a safe
-- no-op. Timestamps are BIGINT epoch millis; every table is tenant-scoped by a UUID tenant_id and
-- isolated by a forced, restrictive RLS policy on current_tenant() (fail-closed on missing tenant
-- context), mirroring 0002_tenant_rls.sql / 0020_decisions.sql / 0030_integrity_remediation.sql.
-- Immutable version rows (controller versions) and append-only outcome rows (simulations, operations,
-- continuity leases, reconciliation runs, operation attempts) are protected by BEFORE UPDATE
-- immutability triggers; controller_instance is MUTABLE (it carries live desired/observed state).

-- ===========================================================================
-- 1. controller_definition / controller_definition_version — a STABLE controller
--    plus its IMMUTABLE versions (FR-023/FR-024). A version pins the MANIFEST-DECLARED
--    capabilities (the ONLY governable actions), the adapter it binds, the policy
--    mappings, its tests + health probe, owner, effective window, and lifecycle. An
--    ACTIVE version is FAIL-CLOSED: it MUST carry tests, a health probe, an
--    effective_from, and an approval decision — a controller cannot govern production
--    without a verification obligation, an activation instant, and an approval.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS controller_definition (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  controller_key     TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'governance_controller',
  owner_principal_id UUID NOT NULL,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT controller_definition_key_present CHECK (length(btrim(controller_key)) > 0)
);

CREATE TABLE IF NOT EXISTS controller_definition_version (
  id                     UUID NOT NULL,
  tenant_id              UUID NOT NULL,
  controller_id          UUID NOT NULL,
  version                BIGINT NOT NULL,
  manifest_digest        TEXT NOT NULL,
  adapter_version_id     UUID NOT NULL,
  adapter_protocol       TEXT NOT NULL DEFAULT 'controller-adapter/1',
  declared_capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_control_mappings JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_class             TEXT NOT NULL DEFAULT 'medium',
  tests                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  health_probe           JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_principal_id     UUID NOT NULL,
  approval_decision_id   UUID,
  lifecycle_state        TEXT NOT NULL DEFAULT 'draft',
  effective_from         BIGINT,
  effective_to           BIGINT,
  content_digest         TEXT NOT NULL,
  created_at             BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT controller_version_positive CHECK (version >= 1),
  CONSTRAINT controller_version_risk_valid
    CHECK (risk_class IN ('low','medium','high','critical')),
  CONSTRAINT controller_version_lifecycle_valid
    CHECK (lifecycle_state IN ('draft','proposed','active','deprecated','retired')),
  -- FR-024: manifest-declared capabilities are the ONLY governable actions — an ACTIVE version must
  -- declare at least one capability (a controller that declares nothing can govern nothing).
  CONSTRAINT controller_version_active_declares_capability
    CHECK (lifecycle_state <> 'active' OR jsonb_array_length(declared_capabilities) >= 1),
  -- Fail-closed activation: an ACTIVE version MUST carry tests, a health probe, an effective_from,
  -- and an approval decision (it cannot govern production without a verification obligation, a live
  -- health signal, an activation instant, and an approval).
  CONSTRAINT controller_version_active_governed
    CHECK (lifecycle_state <> 'active'
           OR (effective_from IS NOT NULL
               AND approval_decision_id IS NOT NULL
               AND jsonb_array_length(tests) >= 1
               AND health_probe <> '{}'::jsonb)),
  UNIQUE (tenant_id, controller_id, version)
);

CREATE INDEX IF NOT EXISTS controller_version_ctrl_idx
  ON controller_definition_version (tenant_id, controller_id, version);
CREATE INDEX IF NOT EXISTS controller_version_active_idx
  ON controller_definition_version (tenant_id, lifecycle_state, effective_from);

-- ===========================================================================
-- 2. controller_instance — a RUNNING controller bound to a specific version, with its
--    DESIRED vs OBSERVED state and health/connectivity (FR-023/FR-028). drift is a
--    durable, queryable fact (desired_digest <> observed_digest) so a projection can
--    surface reconcile-before-mutation. MUTABLE (carries live observed state).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS controller_instance (
  id                    UUID NOT NULL,
  tenant_id             UUID NOT NULL,
  controller_id         UUID NOT NULL,
  bound_version_id      UUID NOT NULL,
  bound_version         BIGINT NOT NULL,
  desired_state         JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_state        JSONB NOT NULL DEFAULT '{}'::jsonb,
  desired_digest        TEXT NOT NULL,
  observed_digest       TEXT NOT NULL,
  has_drift             BOOLEAN NOT NULL DEFAULT FALSE,
  health_state          TEXT NOT NULL DEFAULT 'unknown',
  connectivity_state    TEXT NOT NULL DEFAULT 'unknown',
  source_revision       TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'active',
  last_observed_at      BIGINT NOT NULL,
  version               BIGINT NOT NULL DEFAULT 1,
  updated_at            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT controller_instance_version_positive CHECK (version >= 1),
  CONSTRAINT controller_instance_bound_version_positive CHECK (bound_version >= 1),
  CONSTRAINT controller_instance_health_valid
    CHECK (health_state IN ('healthy','degraded','unhealthy','unknown')),
  CONSTRAINT controller_instance_connectivity_valid
    CHECK (connectivity_state IN ('connected','degraded','disconnected','unknown')),
  CONSTRAINT controller_instance_state_valid
    CHECK (state IN ('active','paused','draining','stopped','continuity')),
  -- The drift boolean cannot lie: it is exactly the digest disagreement (fail-visible).
  CONSTRAINT controller_instance_drift_agrees
    CHECK (has_drift = (desired_digest <> observed_digest))
);

CREATE INDEX IF NOT EXISTS controller_instance_ctrl_idx
  ON controller_instance (tenant_id, controller_id, state);
CREATE INDEX IF NOT EXISTS controller_instance_drift_idx
  ON controller_instance (tenant_id, has_drift, health_state);

-- ===========================================================================
-- 3. controller_simulation — a VERSION-PINNED, EXPIRING dry-run of an operation
--    (FR-025 / NS-005). It binds the controller version + adapter version + policy
--    version + the source_revision it was computed against; the predicted effect, the
--    diff, and its status. A superseding source revision INVALIDATES it (status
--    'invalidated' + invalidated_by_revision), so a stale simulation can never authorize
--    execution. Append-only (immutability trigger); a new simulation is a new row.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS controller_simulation (
  id                       UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  instance_id              UUID NOT NULL,
  operation_kind           TEXT NOT NULL,
  capability_key           TEXT NOT NULL,
  bound_controller_version_id UUID NOT NULL,
  bound_adapter_version_id UUID NOT NULL,
  bound_policy_version_id  UUID NOT NULL,
  source_revision          TEXT NOT NULL,
  requested_change         JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_effect         JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_diff           JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'current',
  invalidated_by_revision  TEXT,
  content_digest           TEXT NOT NULL,
  simulated_at             BIGINT NOT NULL,
  expires_at               BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT controller_simulation_kind_valid
    CHECK (operation_kind IN ('discover','inspect','simulate','approve','execute','pause','resume',
                              'reconcile','rollback','collect_evidence','emergency_stop')),
  CONSTRAINT controller_simulation_capability_present
    CHECK (length(btrim(capability_key)) > 0),
  CONSTRAINT controller_simulation_source_present CHECK (length(btrim(source_revision)) > 0),
  CONSTRAINT controller_simulation_status_valid
    CHECK (status IN ('current','expired','invalidated','consumed')),
  -- A simulation MUST expire strictly after it was computed (a non-expiring simulation could
  -- authorize execution forever — forbidden by FR-025).
  CONSTRAINT controller_simulation_expires_after
    CHECK (expires_at > simulated_at),
  -- NS-005: an INVALIDATED simulation must name the superseding source revision (why it is stale).
  CONSTRAINT controller_simulation_invalidation_reason
    CHECK (status <> 'invalidated' OR length(btrim(coalesce(invalidated_by_revision,''))) > 0)
);

CREATE INDEX IF NOT EXISTS controller_simulation_instance_idx
  ON controller_simulation (tenant_id, instance_id, simulated_at);
CREATE INDEX IF NOT EXISTS controller_simulation_status_idx
  ON controller_simulation (tenant_id, status, expires_at);

-- ===========================================================================
-- 4. controller_operation — a governed action against a controller instance
--    (FR-024..028). ONE idempotency identity per operation (idempotency_key UNIQUE per
--    tenant): a replayed request never produces a second governed effect (FR-026/027).
--    A STATE-CHANGING operation binds a declared capability_key AND — to reach an
--    executing/execute state — a CURRENT simulation AND an approval decision
--    (simulate/approve-before-execute gate). A CONTINUITY-state operation must carry a
--    continuity_lease_id (FR-046). Append-only (immutability trigger); state advances via
--    the projector, outcomes are append-only attempts/reconciliations.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS controller_operation (
  id                     UUID NOT NULL,
  tenant_id              UUID NOT NULL,
  instance_id            UUID NOT NULL,
  controller_id          UUID NOT NULL,
  operation_kind         TEXT NOT NULL,
  capability_key         TEXT,
  idempotency_key        TEXT NOT NULL,
  requested_change       JSONB NOT NULL DEFAULT '{}'::jsonb,
  bound_controller_version_id UUID NOT NULL,
  bound_adapter_version_id UUID NOT NULL,
  bound_policy_version_id  UUID NOT NULL,
  source_revision        TEXT NOT NULL,
  simulation_id          UUID,
  approval_decision_id   UUID,
  continuity_lease_id    UUID,
  requested_by           UUID NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'requested',
  rollback_result        TEXT,
  content_digest         TEXT NOT NULL,
  requested_at           BIGINT NOT NULL,
  updated_at             BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT controller_operation_kind_valid
    CHECK (operation_kind IN ('discover','inspect','simulate','approve','execute','pause','resume',
                              'reconcile','rollback','collect_evidence','emergency_stop')),
  CONSTRAINT controller_operation_idempotency_present
    CHECK (length(btrim(idempotency_key)) >= 8),
  CONSTRAINT controller_operation_source_present CHECK (length(btrim(source_revision)) > 0),
  CONSTRAINT controller_operation_state_valid
    CHECK (state IN ('requested','inspected','simulated','simulation_expired','pending_approval',
                     'approved','rejected','dispatched','executing','uncertain','reconciling',
                     'reconciled','succeeded','rolling_back','rolled_back','failed','continuity')),
  CONSTRAINT controller_operation_rollback_result_valid
    CHECK (rollback_result IS NULL
           OR rollback_result IN ('rolled_back','partial','conflict','unavailable','failed')),
  -- FR-024: a state-changing operation names the MANIFEST-DECLARED capability it exercises. A
  -- read-only operation (discover/inspect/simulate/collect_evidence) needs no capability binding.
  CONSTRAINT controller_operation_state_changing_has_capability
    CHECK (operation_kind IN ('discover','inspect','simulate','collect_evidence')
           OR length(btrim(coalesce(capability_key,''))) > 0),
  -- Simulate/approve-before-execute gate: an operation may reach 'executing'/'dispatched' ONLY with
  -- both a current simulation AND an approval decision bound. Acknowledgement never becomes execution.
  CONSTRAINT controller_operation_execute_gated
    CHECK (state NOT IN ('dispatched','executing')
           OR (simulation_id IS NOT NULL AND approval_decision_id IS NOT NULL)),
  -- FR-046: a CONTINUITY-state operation must carry a continuity lease (continuity never runs
  -- ungoverned).
  CONSTRAINT controller_operation_continuity_leased
    CHECK (state <> 'continuity' OR continuity_lease_id IS NOT NULL),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS controller_operation_instance_idx
  ON controller_operation (tenant_id, instance_id, requested_at);
CREATE INDEX IF NOT EXISTS controller_operation_state_idx
  ON controller_operation (tenant_id, state, operation_kind);

-- ===========================================================================
-- 5. operation_attempt — a dispatch attempt of an operation against the remote source
--    (FR-027). ONE idempotency identity per attempt. outcome is a pinned vocabulary
--    that keeps uncertainty visible: a 'confirmed' outcome REQUIRES remote_effect_observed
--    = TRUE (an acknowledgement — 'dispatched_unconfirmed' — is NOT confirmation). A
--    'no_effect' outcome is the idempotent-replay observation. Append-only.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS operation_attempt (
  id                       UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  operation_id             UUID NOT NULL,
  attempt_no               BIGINT NOT NULL DEFAULT 1,
  idempotency_key          TEXT NOT NULL,
  dispatched_at            BIGINT NOT NULL,
  adapter_acknowledged     BOOLEAN NOT NULL DEFAULT FALSE,
  remote_effect_observed   BOOLEAN NOT NULL DEFAULT FALSE,
  observed_effect_ref      JSONB NOT NULL DEFAULT '{}'::jsonb,
  adapter_response         JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome                  TEXT NOT NULL DEFAULT 'pending',
  reason_text              TEXT NOT NULL DEFAULT '',
  completed_at             BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT operation_attempt_no_positive CHECK (attempt_no >= 1),
  CONSTRAINT operation_attempt_idempotency_present CHECK (length(btrim(idempotency_key)) >= 8),
  CONSTRAINT operation_attempt_outcome_valid
    CHECK (outcome IN ('pending','dispatched_unconfirmed','confirmed','no_effect','failed',
                       'uncertain','timed_out')),
  -- FR-027: acknowledgement is NOT confirmation. A 'confirmed' outcome REQUIRES an INDEPENDENTLY
  -- OBSERVED remote effect — the adapter's ack alone can never mark an attempt confirmed.
  CONSTRAINT operation_attempt_confirmed_requires_observation
    CHECK (outcome <> 'confirmed' OR remote_effect_observed = TRUE),
  UNIQUE (tenant_id, operation_id, attempt_no),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS operation_attempt_op_idx
  ON operation_attempt (tenant_id, operation_id, attempt_no);
CREATE INDEX IF NOT EXISTS operation_attempt_uncertain_idx
  ON operation_attempt (tenant_id, outcome, dispatched_at);

-- ===========================================================================
-- 6. continuity_lease — a BOUNDED, NONRENEWABLE ≤15-minute continuity grant
--    (FR-046..050 / NFR-012 / SC-021). It applies ONLY to an operation approved AND
--    started BEFORE the health/connectivity failure (operation_started_before_failure =
--    TRUE), pins a policy snapshot (the ONLY policy it may act under), bounds the
--    eligible operation classes / action limit / resource limits, and carries the
--    required local observations + stop conditions. renewable is FALSE — renewal
--    requires restored health + reconciliation, never a self-extension. Append-only.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS continuity_lease (
  id                          UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  operation_id                UUID NOT NULL,
  continuity_policy_version_id UUID NOT NULL,
  policy_snapshot             JSONB NOT NULL DEFAULT '{}'::jsonb,
  eligible_operation_classes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_limit                BIGINT NOT NULL DEFAULT 1,
  resource_limits             JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_local_observations JSONB NOT NULL DEFAULT '[]'::jsonb,
  stop_conditions             JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_principal_id          UUID NOT NULL,
  operation_started_before_failure BOOLEAN NOT NULL DEFAULT FALSE,
  granted_at                  BIGINT NOT NULL,
  expires_at                  BIGINT NOT NULL,
  state                       TEXT NOT NULL DEFAULT 'active',
  renewable                   BOOLEAN NOT NULL DEFAULT FALSE,
  content_digest              TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT continuity_lease_action_limit_positive CHECK (action_limit >= 1),
  CONSTRAINT continuity_lease_state_valid
    CHECK (state IN ('active','expired','stopped','reconciled')),
  -- FR-047: continuity applies ONLY to an operation approved AND started before the failure. A lease
  -- whose operation had not started is a NEW-authority grant and is forbidden.
  CONSTRAINT continuity_lease_pre_failure_only
    CHECK (operation_started_before_failure = TRUE),
  -- NFR-012: a lease is NONRENEWABLE in place.
  CONSTRAINT continuity_lease_nonrenewable
    CHECK (renewable = FALSE),
  -- A lease must expire strictly after it was granted…
  CONSTRAINT continuity_lease_expires_after CHECK (expires_at > granted_at),
  -- …and NFR-012: it may not exceed the hard 15-minute (900000 ms) ceiling.
  CONSTRAINT continuity_lease_ceiling CHECK (expires_at - granted_at <= 900000)
);

CREATE INDEX IF NOT EXISTS continuity_lease_operation_idx
  ON continuity_lease (tenant_id, operation_id);
CREATE INDEX IF NOT EXISTS continuity_lease_active_idx
  ON continuity_lease (tenant_id, state, expires_at);

-- ===========================================================================
-- 7. reconciliation_run — the reconciliation of an operation's EXPECTED effect against
--    the AUTHORITATIVE CURRENT remote state (FR-028). It records the expected vs observed
--    state, the residual differences, whether an independent REMOTE OBSERVATION was used,
--    the count of observed effects (a duplicate — count > 1 — is a divergence, never a
--    success), and the result. A 'reconciled_effect_present' result REQUIRES
--    used_remote_observation = TRUE (never infer success from an ack). Append-only.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS reconciliation_run (
  id                       UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  operation_id             UUID NOT NULL,
  instance_id              UUID NOT NULL,
  expected_state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  differences              JSONB NOT NULL DEFAULT '[]'::jsonb,
  used_remote_observation  BOOLEAN NOT NULL DEFAULT FALSE,
  observed_effect_count    BIGINT NOT NULL DEFAULT 0,
  result                   TEXT NOT NULL DEFAULT 'indeterminate',
  established_state        TEXT,
  reason_text              TEXT NOT NULL DEFAULT '',
  reconciled_at            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT reconciliation_run_effect_count_nonneg CHECK (observed_effect_count >= 0),
  CONSTRAINT reconciliation_run_result_valid
    CHECK (result IN ('reconciled_effect_present','reconciled_no_effect','divergent',
                      'duplicate_effect','indeterminate','unreachable')),
  -- FR-028: an effect-present reconciliation REQUIRES an independent remote observation (never infer
  -- success from an acknowledgement) AND exactly one observed effect (a duplicate is a divergence).
  CONSTRAINT reconciliation_run_effect_present_observed
    CHECK (result <> 'reconciled_effect_present'
           OR (used_remote_observation = TRUE AND observed_effect_count = 1)),
  -- A duplicate_effect result is precisely more-than-one observed effect (fail-visible).
  CONSTRAINT reconciliation_run_duplicate_agrees
    CHECK (result <> 'duplicate_effect' OR observed_effect_count > 1)
);

CREATE INDEX IF NOT EXISTS reconciliation_run_operation_idx
  ON reconciliation_run (tenant_id, operation_id, reconciled_at);
CREATE INDEX IF NOT EXISTS reconciliation_run_result_idx
  ON reconciliation_run (tenant_id, result, reconciled_at);

-- ===========================================================================
-- 8. Row-Level Security — forced, restrictive tenant isolation on every table,
--    fail-closed on missing tenant context (mirrors 0002_tenant_rls.sql /
--    0020_decisions.sql / 0030_integrity_remediation.sql).
-- ===========================================================================
ALTER TABLE controller_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON controller_definition;
CREATE POLICY tenant_isolation ON controller_definition AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE controller_definition_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller_definition_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON controller_definition_version;
CREATE POLICY tenant_isolation ON controller_definition_version AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE controller_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller_instance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON controller_instance;
CREATE POLICY tenant_isolation ON controller_instance AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE controller_simulation ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller_simulation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON controller_simulation;
CREATE POLICY tenant_isolation ON controller_simulation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE controller_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller_operation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON controller_operation;
CREATE POLICY tenant_isolation ON controller_operation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE operation_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operation_attempt;
CREATE POLICY tenant_isolation ON operation_attempt AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE continuity_lease ENABLE ROW LEVEL SECURITY;
ALTER TABLE continuity_lease FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON continuity_lease;
CREATE POLICY tenant_isolation ON continuity_lease AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE reconciliation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reconciliation_run;
CREATE POLICY tenant_isolation ON reconciliation_run AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ===========================================================================
-- 9. Immutability — IMMUTABLE version rows and APPEND-ONLY outcome rows must never be
--    silently rewritten (FR-024 versioned controllers; FR-025 simulations;
--    FR-027/028 attempts + reconciliations; FR-046 continuity leases; non-repudiation).
--    BEFORE UPDATE triggers reject UPDATE on these tables, mirroring the audit-ledger /
--    decision-record / integrity guards. controller_instance is MUTABLE (it carries the
--    live desired/observed state), so it is intentionally NOT frozen.
-- ===========================================================================
CREATE OR REPLACE FUNCTION controller_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only/immutable; row (%,%) may not be updated',
    TG_TABLE_NAME, OLD.tenant_id, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS controller_definition_version_no_update ON controller_definition_version;
CREATE TRIGGER controller_definition_version_no_update
  BEFORE UPDATE ON controller_definition_version
  FOR EACH ROW EXECUTE FUNCTION controller_append_only();

DROP TRIGGER IF EXISTS controller_simulation_no_update ON controller_simulation;
CREATE TRIGGER controller_simulation_no_update
  BEFORE UPDATE ON controller_simulation
  FOR EACH ROW EXECUTE FUNCTION controller_append_only();

DROP TRIGGER IF EXISTS controller_operation_no_update ON controller_operation;
CREATE TRIGGER controller_operation_no_update
  BEFORE UPDATE ON controller_operation
  FOR EACH ROW EXECUTE FUNCTION controller_append_only();

DROP TRIGGER IF EXISTS operation_attempt_no_update ON operation_attempt;
CREATE TRIGGER operation_attempt_no_update
  BEFORE UPDATE ON operation_attempt
  FOR EACH ROW EXECUTE FUNCTION controller_append_only();

DROP TRIGGER IF EXISTS continuity_lease_no_update ON continuity_lease;
CREATE TRIGGER continuity_lease_no_update
  BEFORE UPDATE ON continuity_lease
  FOR EACH ROW EXECUTE FUNCTION controller_append_only();

DROP TRIGGER IF EXISTS reconciliation_run_no_update ON reconciliation_run;
CREATE TRIGGER reconciliation_run_no_update
  BEFORE UPDATE ON reconciliation_run
  FOR EACH ROW EXECUTE FUNCTION controller_append_only();
