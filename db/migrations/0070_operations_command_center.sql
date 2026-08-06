-- 0070_operations_command_center — additive operational prioritization and governed case substrate.
-- Existing domain/evidence records remain authoritative; these tables retain only immutable references,
-- derived operational state, transitions, and exactly-once escalation witnesses.

CREATE OR REPLACE FUNCTION operations_history_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'operational history is append-only; write a new transition instead';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS operational_case (
  id                           UUID NOT NULL,
  tenant_id                    UUID NOT NULL,
  attention_item_id            TEXT,
  title                        TEXT NOT NULL,
  priority                     TEXT NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'open',
  creator_principal_id         TEXT NOT NULL,
  owner_principal_id           TEXT,
  source_owner_ids             JSONB NOT NULL DEFAULT '[]'::jsonb,
  rationale                    TEXT NOT NULL,
  opened_at                    BIGINT NOT NULL,
  acknowledged_at              BIGINT,
  acknowledgement_target_at    BIGINT NOT NULL,
  resolution_target_at         BIGINT NOT NULL,
  verification_target_at       BIGINT,
  service_level_policy_id      TEXT NOT NULL,
  service_level_policy_version TEXT NOT NULL,
  escalation_level             BIGINT NOT NULL DEFAULT 0,
  breach_types                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification                 JSONB,
  payload                      JSONB NOT NULL,
  version                      BIGINT NOT NULL DEFAULT 1,
  created_at                   BIGINT NOT NULL,
  updated_at                   BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT operational_case_priority_valid CHECK (priority IN ('critical','high','medium','low')),
  CONSTRAINT operational_case_status_valid CHECK (status IN ('open','acknowledged','in_progress','awaiting_verification','escalated','resolved','closed')),
  CONSTRAINT operational_case_version_positive CHECK (version >= 1),
  CONSTRAINT operational_case_escalation_nonnegative CHECK (escalation_level >= 0),
  CONSTRAINT operational_case_targets_ordered CHECK (acknowledgement_target_at <= resolution_target_at),
  CONSTRAINT operational_case_reason_present CHECK (length(btrim(rationale)) >= 8),
  CONSTRAINT operational_case_closed_verified CHECK (status <> 'closed' OR verification IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS operational_case_queue_idx
  ON operational_case (tenant_id, status, priority, resolution_target_at, updated_at, id);
CREATE INDEX IF NOT EXISTS operational_case_owner_idx
  ON operational_case (tenant_id, owner_principal_id, status, updated_at);

CREATE TABLE IF NOT EXISTS operational_case_source (
  id                UUID NOT NULL,
  tenant_id         UUID NOT NULL,
  case_id           UUID NOT NULL,
  source_order      BIGINT NOT NULL,
  domain            TEXT NOT NULL,
  record_type       TEXT NOT NULL,
  record_id         TEXT NOT NULL,
  record_version    TEXT,
  governed_problem_key TEXT,
  href              TEXT NOT NULL,
  observed_at       BIGINT NOT NULL,
  source_owner_id   TEXT,
  resolution_state  TEXT NOT NULL DEFAULT 'unknown',
  payload           JSONB NOT NULL,
  created_at        BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT operational_case_source_order_nonnegative CHECK (source_order >= 0),
  CONSTRAINT operational_case_source_domain_valid CHECK (domain IN ('decision','integrity','inventory','source','controller','compliance','evidence','connector','runtime','coverage')),
  CONSTRAINT operational_case_source_resolution_valid CHECK (resolution_state IN ('resolved','unresolved','unknown')),
  CONSTRAINT operational_case_source_href_versioned CHECK (href LIKE '/v1/%'),
  UNIQUE (tenant_id, case_id, domain, record_type, record_id)
);
CREATE INDEX IF NOT EXISTS operational_case_source_case_idx
  ON operational_case_source (tenant_id, case_id, source_order);

CREATE TABLE IF NOT EXISTS operational_case_evidence (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  case_id            UUID NOT NULL,
  evidence_reference TEXT NOT NULL,
  added_by_principal_id TEXT NOT NULL,
  added_at           BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, case_id, evidence_reference)
);

CREATE TABLE IF NOT EXISTS operational_case_transition (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  case_id            UUID NOT NULL,
  command            TEXT NOT NULL,
  from_status        TEXT,
  to_status          TEXT,
  outcome            TEXT NOT NULL,
  expected_version   BIGINT,
  actual_version     BIGINT,
  actor_principal_id TEXT NOT NULL,
  actor_roles        JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  correlation_id     TEXT NOT NULL,
  causation_id       TEXT NOT NULL,
  rejection_code     TEXT,
  safe_next_action   TEXT,
  occurred_at        BIGINT NOT NULL,
  payload            JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT operational_case_transition_command_valid CHECK (command IN ('create','assign','acknowledge','progress','submit_verification','verify','close','evaluate_sla')),
  CONSTRAINT operational_case_transition_outcome_valid CHECK (outcome IN ('accepted','rejected','duplicate','conflict','uncertain')),
  CONSTRAINT operational_case_transition_reason_present CHECK (length(btrim(reason)) >= 8),
  CONSTRAINT operational_case_transition_rejection_paired CHECK (outcome <> 'rejected' OR rejection_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS operational_case_transition_case_idx
  ON operational_case_transition (tenant_id, case_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS operational_case_escalation (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  case_id              UUID NOT NULL,
  policy_version       TEXT NOT NULL,
  level                BIGINT NOT NULL,
  breach_type          TEXT NOT NULL,
  target_role          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  idempotency_identity TEXT NOT NULL,
  opened_at            BIGINT NOT NULL,
  payload              JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT operational_case_escalation_level_positive CHECK (level >= 1),
  CONSTRAINT operational_case_escalation_breach_valid CHECK (breach_type IN ('unowned','acknowledgement','resolution','verification')),
  CONSTRAINT operational_case_escalation_status_valid CHECK (status IN ('open','acknowledged','resolved')),
  UNIQUE (tenant_id, idempotency_identity)
);
CREATE INDEX IF NOT EXISTS operational_case_escalation_case_idx
  ON operational_case_escalation (tenant_id, case_id, status, level);

CREATE TABLE IF NOT EXISTS operational_case_idempotency (
  tenant_id       UUID NOT NULL,
  command_scope   TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest  TEXT NOT NULL,
  result_payload  JSONB NOT NULL,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, command_scope, idempotency_key),
  CONSTRAINT operational_case_idempotency_key_present CHECK (length(btrim(idempotency_key)) >= 8)
);

DROP TRIGGER IF EXISTS operational_case_source_immutable ON operational_case_source;
CREATE TRIGGER operational_case_source_immutable BEFORE UPDATE ON operational_case_source
  FOR EACH ROW EXECUTE FUNCTION operations_history_block_update();
DROP TRIGGER IF EXISTS operational_case_evidence_immutable ON operational_case_evidence;
CREATE TRIGGER operational_case_evidence_immutable BEFORE UPDATE ON operational_case_evidence
  FOR EACH ROW EXECUTE FUNCTION operations_history_block_update();
DROP TRIGGER IF EXISTS operational_case_transition_immutable ON operational_case_transition;
CREATE TRIGGER operational_case_transition_immutable BEFORE UPDATE ON operational_case_transition
  FOR EACH ROW EXECUTE FUNCTION operations_history_block_update();
DROP TRIGGER IF EXISTS operational_case_escalation_immutable ON operational_case_escalation;
CREATE TRIGGER operational_case_escalation_immutable BEFORE UPDATE ON operational_case_escalation
  FOR EACH ROW EXECUTE FUNCTION operations_history_block_update();
DROP TRIGGER IF EXISTS operational_case_idempotency_immutable ON operational_case_idempotency;
CREATE TRIGGER operational_case_idempotency_immutable BEFORE UPDATE ON operational_case_idempotency
  FOR EACH ROW EXECUTE FUNCTION operations_history_block_update();

ALTER TABLE operational_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_case FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operational_case;
CREATE POLICY tenant_isolation ON operational_case AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE operational_case_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_case_source FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operational_case_source;
CREATE POLICY tenant_isolation ON operational_case_source AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE operational_case_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_case_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operational_case_evidence;
CREATE POLICY tenant_isolation ON operational_case_evidence AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE operational_case_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_case_transition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operational_case_transition;
CREATE POLICY tenant_isolation ON operational_case_transition AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE operational_case_escalation ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_case_escalation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operational_case_escalation;
CREATE POLICY tenant_isolation ON operational_case_escalation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE operational_case_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_case_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON operational_case_idempotency;
CREATE POLICY tenant_isolation ON operational_case_idempotency AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
