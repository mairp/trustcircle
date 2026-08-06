-- Spec 004 governed platform continuation.
-- Expand-only canonical records, immutable facts, tenant RLS, and rebuildable projections.

CREATE OR REPLACE FUNCTION governed_immutable_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governed immutable fact % cannot be changed', TG_TABLE_NAME;
END;
$$;

CREATE TABLE IF NOT EXISTS review_snapshot (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  review_id UUID NOT NULL,
  review_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  scope JSONB NOT NULL,
  source_versions JSONB NOT NULL,
  payload JSONB NOT NULL,
  canonical_digest TEXT NOT NULL,
  signer_principal_id UUID NOT NULL,
  authority_decision_id UUID NOT NULL,
  signed_at BIGINT NOT NULL,
  signature JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT review_snapshot_review_fk FOREIGN KEY (tenant_id, review_id)
    REFERENCES management_review (tenant_id, id),
  CONSTRAINT review_snapshot_digest_unique UNIQUE (tenant_id, canonical_digest),
  CONSTRAINT review_snapshot_version_positive CHECK (review_version > 0 AND schema_version > 0)
);

CREATE TABLE IF NOT EXISTS register_record (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_principal_id UUID NOT NULL,
  requester_principal_id UUID NOT NULL,
  due_at BIGINT,
  review_at BIGINT,
  expires_at BIGINT,
  scope JSONB NOT NULL,
  details JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT register_kind_valid CHECK (kind IN ('risk','gap','exception','improvement')),
  CONSTRAINT register_version_positive CHECK (resource_version > 0)
);

CREATE TABLE IF NOT EXISTS governed_view (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  owner_principal_id UUID NOT NULL,
  resource_type TEXT NOT NULL,
  name TEXT NOT NULL,
  query_schema_version INTEGER NOT NULL,
  filter_ast JSONB NOT NULL,
  field_ids JSONB NOT NULL,
  sort_keys JSONB NOT NULL,
  visibility TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT governed_view_version_positive CHECK (query_schema_version > 0 AND resource_version > 0)
);

CREATE TABLE IF NOT EXISTS governed_subscription (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  owner_principal_id UUID NOT NULL,
  governed_view_id UUID,
  event_type TEXT,
  channel TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  policy JSONB NOT NULL,
  status TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT governed_subscription_view_fk FOREIGN KEY (tenant_id, governed_view_id)
    REFERENCES governed_view (tenant_id, id),
  CONSTRAINT governed_subscription_target CHECK (governed_view_id IS NOT NULL OR event_type IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS delivery_attempt (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  notification_intent_id UUID NOT NULL,
  channel TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT,
  status TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  next_attempt_at BIGINT,
  remote_reference TEXT,
  failure_class TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT delivery_attempt_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES governed_subscription (tenant_id, id),
  CONSTRAINT delivery_attempt_idempotency_unique
    UNIQUE (tenant_id, subscription_id, notification_intent_id, channel, recipient_ref, idempotency_key),
  CONSTRAINT delivery_attempt_number_positive CHECK (attempt_number > 0)
);

CREATE TABLE IF NOT EXISTS evidence_request (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  requester_principal_id UUID NOT NULL,
  recipient_principal_id UUID NOT NULL,
  status TEXT NOT NULL,
  scope JSONB NOT NULL,
  claims JSONB NOT NULL,
  acceptable_criteria JSONB NOT NULL,
  due_at BIGINT NOT NULL,
  policy JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS evidence_attestation (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  evidence_request_id UUID NOT NULL,
  attestor_principal_id UUID NOT NULL,
  claims JSONB NOT NULL,
  evidence_refs JSONB NOT NULL,
  limitations JSONB NOT NULL,
  canonical_digest TEXT NOT NULL,
  signature JSONB NOT NULL,
  attested_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT evidence_attestation_request_fk FOREIGN KEY (tenant_id, evidence_request_id)
    REFERENCES evidence_request (tenant_id, id),
  CONSTRAINT evidence_attestation_digest_unique UNIQUE (tenant_id, canonical_digest)
);

CREATE TABLE IF NOT EXISTS evidence_sufficiency_decision (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  evidence_request_id UUID NOT NULL,
  reviewer_principal_id UUID NOT NULL,
  verdict TEXT NOT NULL,
  rationale TEXT NOT NULL,
  bound_versions JSONB NOT NULL,
  policy_version_id UUID NOT NULL,
  canonical_digest TEXT NOT NULL,
  decided_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT evidence_sufficiency_request_fk FOREIGN KEY (tenant_id, evidence_request_id)
    REFERENCES evidence_request (tenant_id, id),
  CONSTRAINT evidence_sufficiency_verdict CHECK (verdict IN ('accepted','rejected','more_evidence_required'))
);

CREATE TABLE IF NOT EXISTS evidence_derivative (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  original_evidence_id UUID NOT NULL,
  derived_evidence_id UUID NOT NULL,
  transformation_type TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  authority_decision_id UUID NOT NULL,
  actor_principal_id UUID NOT NULL,
  reason_text TEXT NOT NULL,
  original_digest TEXT NOT NULL,
  derived_digest TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  produced_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT evidence_derivative_original_fk FOREIGN KEY (tenant_id, original_evidence_id)
    REFERENCES evidence_item (tenant_id, evidence_item_id),
  CONSTRAINT evidence_derivative_derived_fk FOREIGN KEY (tenant_id, derived_evidence_id)
    REFERENCES evidence_item (tenant_id, evidence_item_id),
  CONSTRAINT evidence_derivative_distinct CHECK (original_evidence_id <> derived_evidence_id)
);

CREATE TABLE IF NOT EXISTS evidence_package (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  scope JSONB NOT NULL,
  audience JSONB NOT NULL,
  member_manifest JSONB NOT NULL,
  manifest_digest TEXT NOT NULL,
  requested_by UUID NOT NULL,
  approved_by UUID,
  generated_at BIGINT,
  signed_at BIGINT,
  signature JSONB,
  resource_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT evidence_package_manifest_digest_unique UNIQUE (tenant_id, manifest_digest)
);

CREATE TABLE IF NOT EXISTS control_observation (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  source_event_id TEXT NOT NULL,
  source_contract_version TEXT NOT NULL,
  asset_id UUID NOT NULL,
  control_id UUID NOT NULL,
  condition_id TEXT NOT NULL,
  status TEXT NOT NULL,
  freshness TEXT NOT NULL,
  completeness TEXT NOT NULL,
  source_health TEXT NOT NULL,
  evidence_ref UUID,
  observed_at BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  canonical_digest TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT control_observation_source_event_unique UNIQUE (tenant_id, source_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS monitoring_case (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  correlation_policy_id UUID NOT NULL,
  correlation_policy_version INTEGER NOT NULL,
  case_key TEXT NOT NULL,
  control_id UUID NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  owner_principal_id UUID,
  state JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT monitoring_case_key_unique UNIQUE (tenant_id, correlation_policy_id, correlation_policy_version, case_key)
);

CREATE TABLE IF NOT EXISTS impact_preview (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  proposal_type TEXT NOT NULL,
  proposal_ref TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  source_versions JSONB NOT NULL,
  impact JSONB NOT NULL,
  status TEXT NOT NULL,
  requested_by UUID NOT NULL,
  generated_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT impact_preview_expiry CHECK (expires_at > generated_at)
);

CREATE TABLE IF NOT EXISTS change_publication (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  impact_preview_id UUID NOT NULL,
  proposal_digest TEXT NOT NULL,
  approved_by UUID NOT NULL,
  authority_decision_id UUID NOT NULL,
  target_version TEXT NOT NULL,
  rebuild_status TEXT NOT NULL,
  rollback_plan_ref TEXT NOT NULL,
  state JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  published_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT change_publication_preview_fk FOREIGN KEY (tenant_id, impact_preview_id)
    REFERENCES impact_preview (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_use_case (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  owner_principal_id UUID NOT NULL,
  risk_class TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  governance JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_component_version (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  use_case_id UUID NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  component_digest TEXT NOT NULL,
  approved_scope JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_component_use_case_fk FOREIGN KEY (tenant_id, use_case_id)
    REFERENCES ai_use_case (tenant_id, id),
  CONSTRAINT ai_component_version_unique UNIQUE (tenant_id, use_case_id, kind, version)
);

CREATE TABLE IF NOT EXISTS ai_evaluation (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  use_case_id UUID NOT NULL,
  plan_version TEXT NOT NULL,
  component_refs JSONB NOT NULL,
  results JSONB NOT NULL,
  limitations JSONB NOT NULL,
  evaluator_principal_id UUID NOT NULL,
  reviewer_principal_id UUID,
  verdict TEXT NOT NULL,
  canonical_digest TEXT NOT NULL,
  evaluated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_evaluation_use_case_fk FOREIGN KEY (tenant_id, use_case_id)
    REFERENCES ai_use_case (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_incident (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  use_case_id UUID NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_principal_id UUID NOT NULL,
  state JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  detected_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_incident_use_case_fk FOREIGN KEY (tenant_id, use_case_id)
    REFERENCES ai_use_case (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS copilot_exchange (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  principal_id UUID NOT NULL,
  purpose TEXT NOT NULL,
  policy_decision_id UUID NOT NULL,
  source_refs JSONB NOT NULL,
  response_digest TEXT NOT NULL,
  citation_refs JSONB NOT NULL,
  limitation_codes JSONB NOT NULL,
  abstention_code TEXT,
  retention_class TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS connector_certification (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  connector_id TEXT NOT NULL,
  exact_version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  certifier_principal_id UUID NOT NULL,
  authority_decision_id UUID NOT NULL,
  bounds JSONB NOT NULL,
  status TEXT NOT NULL,
  valid_from BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT connector_certification_version_unique UNIQUE (tenant_id, connector_id, exact_version, manifest_digest),
  CONSTRAINT connector_certification_validity CHECK (expires_at > valid_from)
);

CREATE TABLE IF NOT EXISTS improvement_hypothesis (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  analytics_schema_version INTEGER NOT NULL,
  aggregate_measure_refs JSONB NOT NULL,
  hypothesis TEXT NOT NULL,
  owner_principal_id UUID NOT NULL,
  status TEXT NOT NULL,
  state JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS entity_resolution_case (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  source_identity_refs JSONB NOT NULL,
  proposal_type TEXT NOT NULL,
  confidence_band TEXT NOT NULL,
  status TEXT NOT NULL,
  proposed_by UUID NOT NULL,
  reviewed_by UUID,
  decision_reason TEXT,
  state JSONB NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT entity_resolution_proposal CHECK (proposal_type IN ('link','merge','split','reject_link'))
);

CREATE TABLE IF NOT EXISTS framework_mapping (
  id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  source_publication_id UUID NOT NULL,
  source_clause_ref TEXT NOT NULL,
  source_material_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  mapping_type TEXT NOT NULL,
  applicability_state TEXT NOT NULL,
  obligation_owner UUID,
  mapping_owner UUID NOT NULL,
  state JSONB NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_mapping_id UUID,
  reviewed_by UUID,
  reviewed_at BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT framework_mapping_version_unique UNIQUE (tenant_id, source_publication_id, source_clause_ref, target_type, target_ref, version)
);

CREATE INDEX IF NOT EXISTS review_snapshot_tenant_idx ON review_snapshot (tenant_id, review_id, signed_at);
CREATE INDEX IF NOT EXISTS register_record_tenant_idx ON register_record (tenant_id, kind, status, updated_at);
CREATE INDEX IF NOT EXISTS governed_view_tenant_idx ON governed_view (tenant_id, owner_principal_id, status);
CREATE INDEX IF NOT EXISTS governed_subscription_tenant_idx ON governed_subscription (tenant_id, owner_principal_id, status);
CREATE INDEX IF NOT EXISTS delivery_attempt_tenant_idx ON delivery_attempt (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS evidence_request_tenant_idx ON evidence_request (tenant_id, recipient_principal_id, status);
CREATE INDEX IF NOT EXISTS evidence_attestation_tenant_idx ON evidence_attestation (tenant_id, evidence_request_id, attested_at);
CREATE INDEX IF NOT EXISTS evidence_sufficiency_decision_tenant_idx ON evidence_sufficiency_decision (tenant_id, evidence_request_id, decided_at);
CREATE INDEX IF NOT EXISTS evidence_derivative_tenant_idx ON evidence_derivative (tenant_id, original_evidence_id, produced_at);
CREATE INDEX IF NOT EXISTS evidence_package_tenant_idx ON evidence_package (tenant_id, status, signed_at);
CREATE INDEX IF NOT EXISTS control_observation_tenant_idx ON control_observation (tenant_id, control_id, observed_at);
CREATE INDEX IF NOT EXISTS monitoring_case_tenant_idx ON monitoring_case (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS impact_preview_tenant_idx ON impact_preview (tenant_id, proposal_type, expires_at);
CREATE INDEX IF NOT EXISTS change_publication_tenant_idx ON change_publication (tenant_id, rebuild_status, published_at);
CREATE INDEX IF NOT EXISTS ai_use_case_tenant_idx ON ai_use_case (tenant_id, lifecycle_state, updated_at);
CREATE INDEX IF NOT EXISTS ai_component_version_tenant_idx ON ai_component_version (tenant_id, use_case_id, kind);
CREATE INDEX IF NOT EXISTS ai_evaluation_tenant_idx ON ai_evaluation (tenant_id, use_case_id, evaluated_at);
CREATE INDEX IF NOT EXISTS ai_incident_tenant_idx ON ai_incident (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS copilot_exchange_tenant_idx ON copilot_exchange (tenant_id, principal_id, created_at);
CREATE INDEX IF NOT EXISTS connector_certification_tenant_idx ON connector_certification (tenant_id, connector_id, status);
CREATE INDEX IF NOT EXISTS improvement_hypothesis_tenant_idx ON improvement_hypothesis (tenant_id, owner_principal_id, status);
CREATE INDEX IF NOT EXISTS entity_resolution_case_tenant_idx ON entity_resolution_case (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS framework_mapping_tenant_idx ON framework_mapping (tenant_id, source_publication_id, status);

ALTER TABLE review_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE register_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_record FORCE ROW LEVEL SECURITY;
ALTER TABLE governed_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_view FORCE ROW LEVEL SECURITY;
ALTER TABLE governed_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_subscription FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempt FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_request FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_attestation ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_attestation FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_sufficiency_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_sufficiency_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_derivative ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_derivative FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_package FORCE ROW LEVEL SECURITY;
ALTER TABLE control_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE monitoring_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_case FORCE ROW LEVEL SECURITY;
ALTER TABLE impact_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE impact_preview FORCE ROW LEVEL SECURITY;
ALTER TABLE change_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_publication FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_use_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_use_case FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_component_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_component_version FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_evaluation FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_incident FORCE ROW LEVEL SECURITY;
ALTER TABLE copilot_exchange ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_exchange FORCE ROW LEVEL SECURITY;
ALTER TABLE connector_certification ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_certification FORCE ROW LEVEL SECURITY;
ALTER TABLE improvement_hypothesis ENABLE ROW LEVEL SECURITY;
ALTER TABLE improvement_hypothesis FORCE ROW LEVEL SECURITY;
ALTER TABLE entity_resolution_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_resolution_case FORCE ROW LEVEL SECURITY;
ALTER TABLE framework_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE framework_mapping FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'review_snapshot','register_record','governed_view','governed_subscription',
    'delivery_attempt','evidence_request','evidence_attestation',
    'evidence_sufficiency_decision','evidence_derivative','evidence_package',
    'control_observation','monitoring_case','impact_preview','change_publication',
    'ai_use_case','ai_component_version','ai_evaluation','ai_incident',
    'copilot_exchange','connector_certification','improvement_hypothesis',
    'entity_resolution_case','framework_mapping'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE FOR ALL USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END;
$$;

CREATE TRIGGER review_snapshot_immutable
BEFORE UPDATE OR DELETE ON review_snapshot
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();
CREATE TRIGGER evidence_attestation_immutable
BEFORE UPDATE OR DELETE ON evidence_attestation
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();
CREATE TRIGGER evidence_sufficiency_decision_immutable
BEFORE UPDATE OR DELETE ON evidence_sufficiency_decision
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();
CREATE TRIGGER evidence_derivative_immutable
BEFORE UPDATE OR DELETE ON evidence_derivative
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();
CREATE TRIGGER control_observation_immutable
BEFORE UPDATE OR DELETE ON control_observation
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();
CREATE TRIGGER ai_evaluation_immutable
BEFORE UPDATE OR DELETE ON ai_evaluation
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();
CREATE TRIGGER copilot_exchange_immutable
BEFORE UPDATE OR DELETE ON copilot_exchange
FOR EACH ROW EXECUTE FUNCTION governed_immutable_fact();