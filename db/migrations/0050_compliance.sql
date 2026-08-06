-- 0050_compliance — Durable COMPLIANCE / AUDIT-READINESS substrate for the governance control plane:
-- immutable global standards publications and their per-clause versions (FR-051), tenant-scoped
-- versioned applicability decisions gated by independent review (FR-052..056), obligations and their
-- many-to-many control mappings with shared responsibility + evidence expectations (FR-031), control
-- operations / evaluations, assessments and external certifications (FR-032, FR-055), risks and their
-- treatments (FR-034), ISO/IEC 42005 impact assessments, internal-audit programmes, management
-- reviews, findings, and corrective actions (FR-034, FR-035) (Phase 7 / User Story 5 — Demonstrate
-- Compliance and Audit Readiness / FR-031..035, FR-051..056, SC-012, SC-013, SC-022).
--
-- This migration is aligned column-for-column with packages/domain/src/compliance.ts and with the
-- governance-api StandardPublication / ApplicabilityProposal / ApplicabilityDecision /
-- ComplianceCoverage schemas, so a projection over these physical rows, the in-memory domain
-- aggregates, and an API response share ONE vocabulary and ONE set of invariants.
--
-- Load-bearing invariants encoded as fail-visible CHECK / trigger constraints:
--   * IMMUTABLE CENTRAL PUBLICATION FACTS (FR-051). standard_publication / clause_version live at the
--     reserved platform scope ('platform') — NOT a tenant — and are append-only (a BEFORE UPDATE
--     immutability trigger blocks any rewrite). A new edition/amendment/corrigendum is a NEW version.
--   * INDEPENDENT REVIEW GATES ACTIVATION (FR-053). applicability_decision cannot be 'active' without
--     a reviewer_principal_id distinct from proposer_principal_id and review_decision='approve'.
--   * NON-APPLICABILITY DOES NOT SUPPRESS A STALE GAP (FR-054). A not_applicable decision retains its
--     justification/evidence/owner/review_at; the coverage projector reopens the gap once review_at
--     passes.
--   * EVERY CHANGE IS A NEW VERSION (FR-056). applicability_decision is append-only (immutability
--     trigger); a change writes a new row with version+1 and supersedes_id pointing at the prior.
--   * READINESS ≠ CERTIFICATION (FR-032 / FR-055 / SC-012). external_certification requires a verifiable
--     issuer + certificate id + validity window + status + verification_uri before it may be displayed.
--
-- CONVENTIONS (identical to 0030 / 0040): EXPAND-only + idempotent (CREATE ... IF NOT EXISTS /
-- DROP POLICY IF EXISTS then CREATE), so re-applying is a safe no-op. Timestamps are BIGINT epoch
-- millis; every table is tenant-scoped by a UUID tenant_id (platform facts use the all-zero
-- platform-scope UUID sentinel) and isolated by a forced, RESTRICTIVE RLS policy on current_tenant()
-- (fail-closed on missing tenant). Immutable/append-only rows are protected by BEFORE UPDATE
-- immutability triggers.

-- ===========================================================================
-- Shared append-only immutability trigger function (idempotent create-or-replace).
-- ===========================================================================
CREATE OR REPLACE FUNCTION compliance_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'row is append-only (immutable compliance fact); write a new version instead';
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 1. standard_publication — an IMMUTABLE version of a GLOBAL publication fact (FR-051).
--    Platform-scoped (never a tenant); append-only; a new edition is a new version row.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS standard_publication (
  id                 UUID NOT NULL,
  -- tenant_id IS NULL is the CENTRAL / platform scope (the domain's PLATFORM_SCOPE sentinel): a
  -- global publication fact readable by EVERY tenant but writable only out of band (never forgeable
  -- by a tenant path). Mirrors the sod_constraint central-guardrail convention in 0002_tenant_rls.
  tenant_id          UUID,
  publisher          TEXT NOT NULL,
  identifier         TEXT NOT NULL,
  exact_title        TEXT NOT NULL,
  edition            TEXT NOT NULL,
  publication_date   DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'published',
  material_type      TEXT NOT NULL,
  source_uri         TEXT NOT NULL,
  registry_version   BIGINT NOT NULL DEFAULT 1,
  supersedes_id      UUID,
  content_digest     TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  -- Central rows are keyed by id alone (tenant_id is NULL for platform facts).
  PRIMARY KEY (id),
  CONSTRAINT standard_publication_version_positive CHECK (registry_version >= 1),
  CONSTRAINT standard_publication_status_valid
    CHECK (status IN ('published','under_development','draft','withdrawn','superseded')),
  CONSTRAINT standard_publication_material_valid
    CHECK (material_type IN ('requirements','guidance','certification_body_criteria',
                             'impact_assessment_guidance','draft','amendment','corrigendum')),
  CONSTRAINT standard_publication_facts_present
    CHECK (length(btrim(publisher)) > 0 AND length(btrim(identifier)) > 0
           AND length(btrim(exact_title)) > 0 AND length(btrim(edition)) > 0),
  UNIQUE (identifier, registry_version)
);
CREATE INDEX IF NOT EXISTS standard_publication_identifier_idx
  ON standard_publication (identifier, registry_version);

CREATE TABLE IF NOT EXISTS clause_version (
  id              UUID NOT NULL,
  tenant_id       UUID,             -- NULL = central/platform scope (see standard_publication)
  publication_id  UUID NOT NULL,
  clause_ref      TEXT NOT NULL,
  title           TEXT NOT NULL,
  material_type   TEXT NOT NULL DEFAULT 'requirements',
  version         BIGINT NOT NULL DEFAULT 1,
  supersedes_id   UUID,
  content_digest  TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT clause_version_positive CHECK (version >= 1),
  CONSTRAINT clause_version_material_valid
    CHECK (material_type IN ('requirements','guidance','certification_body_criteria',
                             'impact_assessment_guidance','draft','amendment','corrigendum')),
  UNIQUE (publication_id, clause_ref, version)
);
CREATE INDEX IF NOT EXISTS clause_version_pub_idx
  ON clause_version (publication_id, clause_ref, version);

-- ===========================================================================
-- 2. applicability_decision — a tenant-scoped, VERSIONED applicability decision (FR-052..056).
--    Independent review gates activation; append-only; every change is a new version.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS applicability_decision (
  id                            UUID NOT NULL,
  tenant_id                     UUID NOT NULL,
  clause_version_id             UUID NOT NULL,
  system_id                     UUID NOT NULL,
  jurisdiction                  TEXT NOT NULL,
  use_case                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_result               TEXT NOT NULL,
  rationale                     TEXT NOT NULL,
  evidence_ids                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  obligation_owner_principal_id UUID,
  proposer_principal_id         UUID NOT NULL,
  reviewer_principal_id         UUID,
  review_decision               TEXT,
  review_reason                 JSONB,
  state                         TEXT NOT NULL DEFAULT 'proposed',
  effective_from                BIGINT,
  review_at                     BIGINT NOT NULL,
  version                       BIGINT NOT NULL DEFAULT 1,
  supersedes_id                 UUID,
  content_digest                TEXT NOT NULL,
  created_at                    BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT applicability_version_positive CHECK (version >= 1),
  CONSTRAINT applicability_result_valid
    CHECK (proposed_result IN ('applicable','partially_applicable','not_applicable','uncertain')),
  CONSTRAINT applicability_state_valid
    CHECK (state IN ('proposed','active','rejected','changes_requested','expired','superseded')),
  CONSTRAINT applicability_action_valid
    CHECK (review_decision IS NULL OR review_decision IN ('approve','reject','request_changes','expire')),
  CONSTRAINT applicability_rationale_present CHECK (length(btrim(rationale)) > 0),
  CONSTRAINT applicability_has_evidence CHECK (jsonb_array_length(evidence_ids) >= 1),
  -- FR-053: an ACTIVE decision MUST carry an independent reviewer distinct from the proposer who
  -- approved it — activation without independent review is impossible.
  CONSTRAINT applicability_active_independently_reviewed
    CHECK (state <> 'active'
           OR (reviewer_principal_id IS NOT NULL
               AND reviewer_principal_id <> proposer_principal_id
               AND review_decision = 'approve')),
  UNIQUE (tenant_id, clause_version_id, system_id, version)
);
CREATE INDEX IF NOT EXISTS applicability_scope_idx
  ON applicability_decision (tenant_id, system_id, clause_version_id, version);
CREATE INDEX IF NOT EXISTS applicability_state_idx
  ON applicability_decision (tenant_id, state, review_at);

-- ===========================================================================
-- 3. obligation + control_mapping — a duty from an applicable clause and its many-to-many control
--    mappings with shared responsibility + evidence expectations (FR-031, FR-034).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS compliance_obligation (
  id                       UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  clause_version_id        UUID NOT NULL,
  applicability_decision_id UUID NOT NULL,
  duty_class               TEXT NOT NULL,
  owner_principal_id       UUID NOT NULL,
  review_at                BIGINT NOT NULL,
  version                  BIGINT NOT NULL DEFAULT 1,
  content_digest           TEXT NOT NULL,
  created_at               BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT obligation_version_positive CHECK (version >= 1),
  CONSTRAINT obligation_duty_valid
    CHECK (duty_class IN ('organizational_obligation','platform_capability','internal_readiness',
                          'external_assessment','certification','certification_body_criteria','guidance'))
);
CREATE INDEX IF NOT EXISTS obligation_clause_idx
  ON compliance_obligation (tenant_id, clause_version_id, version);

CREATE TABLE IF NOT EXISTS control_mapping (
  id                    UUID NOT NULL,
  tenant_id             UUID NOT NULL,
  obligation_id         UUID NOT NULL,
  control_id            UUID NOT NULL,
  responsibility        TEXT NOT NULL,
  evidence_expectations JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_window_ms    BIGINT NOT NULL,
  review_at             BIGINT NOT NULL,
  version               BIGINT NOT NULL DEFAULT 1,
  content_digest        TEXT NOT NULL,
  created_at            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT mapping_version_positive CHECK (version >= 1),
  CONSTRAINT mapping_responsibility_valid
    CHECK (responsibility IN ('organization','platform','shared','external')),
  CONSTRAINT mapping_evidence_window_positive CHECK (evidence_window_ms > 0),
  CONSTRAINT mapping_has_expectations CHECK (jsonb_array_length(evidence_expectations) >= 1)
);
CREATE INDEX IF NOT EXISTS control_mapping_obligation_idx
  ON control_mapping (tenant_id, obligation_id, control_id, version);

-- ===========================================================================
-- 4. control_evaluation — the design/implementation/operating-effectiveness state of a mapped
--    control at a point in time, with evidence sufficiency (FR-031, SC-012).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS control_evaluation (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  control_mapping_id   UUID NOT NULL,
  design_state         TEXT NOT NULL DEFAULT 'unknown',
  implementation_state TEXT NOT NULL DEFAULT 'unknown',
  operating_state      TEXT NOT NULL DEFAULT 'unknown',
  evidence_sufficiency TEXT NOT NULL DEFAULT 'insufficient',
  latest_evidence_id   UUID,
  latest_evidence_at   BIGINT,
  evaluated_at         BIGINT NOT NULL,
  content_digest       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT control_eval_states_valid
    CHECK (design_state IN ('designed','deficient','unknown')
           AND implementation_state IN ('implemented','partial','not_implemented','unknown')
           AND operating_state IN ('operating','ineffective','not_operating','unknown')
           AND evidence_sufficiency IN ('sufficient','stale','insufficient'))
);
CREATE INDEX IF NOT EXISTS control_eval_mapping_idx
  ON control_evaluation (tenant_id, control_mapping_id, evaluated_at);

-- ===========================================================================
-- 5. assessment + external_certification (FR-032, FR-034, FR-055).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS compliance_assessment (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  obligation_id        UUID NOT NULL,
  kind                 TEXT NOT NULL,
  result               TEXT NOT NULL,
  assessor_principal_id UUID NOT NULL,
  evidence_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  assessed_at          BIGINT NOT NULL,
  version              BIGINT NOT NULL DEFAULT 1,
  content_digest       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT assessment_kind_valid
    CHECK (kind IN ('internal_readiness','internal_audit','external_assessment')),
  CONSTRAINT assessment_result_valid
    CHECK (result IN ('ready','not_ready','conforming','nonconforming','inconclusive'))
);
CREATE INDEX IF NOT EXISTS assessment_obligation_idx
  ON compliance_assessment (tenant_id, obligation_id, assessed_at);

CREATE TABLE IF NOT EXISTS external_certification (
  id               UUID NOT NULL,
  tenant_id        UUID NOT NULL,
  publication_id   UUID NOT NULL,
  issuer           TEXT NOT NULL,
  certificate_id   TEXT NOT NULL,
  scope            JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_from       BIGINT NOT NULL,
  valid_until      BIGINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'valid',
  verification_uri TEXT NOT NULL,
  version          BIGINT NOT NULL DEFAULT 1,
  content_digest   TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT certification_status_valid CHECK (status IN ('valid','suspended','withdrawn','expired')),
  CONSTRAINT certification_validity_ordered CHECK (valid_from < valid_until),
  -- FR-055 / SC-012: an external certification cannot be recorded without a verifiable external
  -- evidence reference, an issuer, and a certificate id — internal readiness is never certification.
  CONSTRAINT certification_verifiable
    CHECK (length(btrim(issuer)) > 0 AND length(btrim(certificate_id)) > 0
           AND length(btrim(verification_uri)) > 0)
);
CREATE INDEX IF NOT EXISTS certification_pub_idx
  ON external_certification (tenant_id, publication_id, status);

-- ===========================================================================
-- 6. risk + risk_treatment (FR-034) — assessment, treatment options, owner, milestones, approval,
--    residual-risk acceptance, and reassessment.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS compliance_risk (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  obligation_id      UUID,
  title              TEXT NOT NULL,
  likelihood         TEXT NOT NULL DEFAULT 'medium',
  impact             TEXT NOT NULL DEFAULT 'medium',
  owner_principal_id UUID NOT NULL,
  treatment_option   TEXT NOT NULL DEFAULT 'mitigate',
  residual_accepted  BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_by        UUID,
  reassess_at        BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  content_digest     TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT risk_levels_valid
    CHECK (likelihood IN ('low','medium','high') AND impact IN ('low','medium','high','critical')),
  CONSTRAINT risk_treatment_valid
    CHECK (treatment_option IN ('accept','mitigate','transfer','avoid')),
  CONSTRAINT risk_status_valid CHECK (status IN ('open','treated','accepted','closed')),
  CONSTRAINT risk_residual_accepted_by CHECK (residual_accepted = FALSE OR accepted_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS risk_obligation_idx ON compliance_risk (tenant_id, obligation_id, status);

CREATE TABLE IF NOT EXISTS risk_treatment_milestone (
  id            UUID NOT NULL,
  tenant_id     UUID NOT NULL,
  risk_id       UUID NOT NULL,
  description   TEXT NOT NULL,
  due_at        BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'planned',
  content_digest TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT milestone_status_valid CHECK (status IN ('planned','in_progress','done','overdue'))
);

-- ===========================================================================
-- 7. impact_assessment — ISO/IEC 42005 AI-system impact assessments (FR-034).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS impact_assessment (
  id                UUID NOT NULL,
  tenant_id         UUID NOT NULL,
  system_id         UUID NOT NULL,
  affected_parties  JSONB NOT NULL DEFAULT '[]'::jsonb,
  uncertainty       TEXT NOT NULL DEFAULT 'medium',
  mitigations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  residual_impacts  JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by       UUID,
  approved_at       BIGINT,
  access_class      TEXT NOT NULL DEFAULT 'restricted',
  reassess_at       BIGINT NOT NULL,
  version           BIGINT NOT NULL DEFAULT 1,
  content_digest    TEXT NOT NULL,
  created_at        BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT impact_uncertainty_valid CHECK (uncertainty IN ('low','medium','high')),
  CONSTRAINT impact_access_valid CHECK (access_class IN ('public','restricted','confidential')),
  CONSTRAINT impact_has_parties CHECK (jsonb_array_length(affected_parties) >= 1)
);
CREATE INDEX IF NOT EXISTS impact_system_idx ON impact_assessment (tenant_id, system_id, version);

-- ===========================================================================
-- 8. internal_audit + management_review (FR-034, FR-035).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS internal_audit (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  programme          TEXT NOT NULL,
  auditor_principal_id UUID NOT NULL,
  independent        BOOLEAN NOT NULL DEFAULT TRUE,
  scope              JSONB NOT NULL DEFAULT '{}'::jsonb,
  criteria           JSONB NOT NULL DEFAULT '[]'::jsonb,
  sampling           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'planned',
  reported_at        BIGINT,
  content_digest     TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_status_valid CHECK (status IN ('planned','in_progress','reported','followed_up','closed'))
);

CREATE TABLE IF NOT EXISTS management_review (
  id             UUID NOT NULL,
  tenant_id      UUID NOT NULL,
  cadence        TEXT NOT NULL DEFAULT 'quarterly',
  participants   JSONB NOT NULL DEFAULT '[]'::jsonb,
  inputs         JSONB NOT NULL DEFAULT '[]'::jsonb,
  decisions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs        JSONB NOT NULL DEFAULT '[]'::jsonb,
  held_at        BIGINT NOT NULL,
  next_due_at    BIGINT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT review_cadence_valid CHECK (cadence IN ('monthly','quarterly','biannual','annual'))
);

-- ===========================================================================
-- 9. compliance_finding + corrective_action (FR-034) — nonconformity → correction → root cause →
--    corrective action → effectiveness review → closure/reopening.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS compliance_finding (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  audit_id           UUID,
  obligation_id      UUID,
  severity           TEXT NOT NULL DEFAULT 'medium',
  owner_principal_id UUID NOT NULL,
  due_at             BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  evidence_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_result TEXT,
  residual_risk_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  content_digest     TEXT NOT NULL,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT finding_severity_valid CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT finding_status_valid
    CHECK (status IN ('open','in_progress','remediated','verified','closed','reopened'))
);
CREATE INDEX IF NOT EXISTS finding_status_idx ON compliance_finding (tenant_id, status, due_at);

CREATE TABLE IF NOT EXISTS corrective_action (
  id                  UUID NOT NULL,
  tenant_id           UUID NOT NULL,
  finding_id          UUID NOT NULL,
  correction          TEXT NOT NULL,
  root_cause          TEXT NOT NULL,
  action              TEXT NOT NULL,
  owner_principal_id  UUID NOT NULL,
  due_at              BIGINT NOT NULL,
  effectiveness_result TEXT,
  recurrence_observed BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'open',
  content_digest      TEXT NOT NULL,
  created_at          BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT corrective_status_valid
    CHECK (status IN ('open','in_progress','implemented','verified','closed','reopened')),
  CONSTRAINT corrective_root_cause_present CHECK (length(btrim(root_cause)) > 0)
);
CREATE INDEX IF NOT EXISTS corrective_finding_idx ON corrective_action (tenant_id, finding_id, status);

-- ===========================================================================
-- 10. compliance_exception — an EXPIRING exception with risk authority + compensating controls
--     (FR-034) — no silent renewal; verified closure.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS compliance_exception (
  id                    UUID NOT NULL,
  tenant_id             UUID NOT NULL,
  obligation_id         UUID NOT NULL,
  reason                JSONB NOT NULL,
  risk_authority_id     UUID NOT NULL,
  compensating_controls JSONB NOT NULL DEFAULT '[]'::jsonb,
  granted_at            BIGINT NOT NULL,
  expires_at            BIGINT NOT NULL,
  review_at             BIGINT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  closure_verified_by   UUID,
  content_digest        TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT exception_status_valid CHECK (status IN ('active','expired','closed','revoked')),
  CONSTRAINT exception_window_ordered CHECK (granted_at < expires_at),
  -- No silent renewal: a closed exception MUST record who verified its closure.
  CONSTRAINT exception_closure_verified CHECK (status <> 'closed' OR closure_verified_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS exception_obligation_idx
  ON compliance_exception (tenant_id, obligation_id, status, expires_at);

-- ===========================================================================
-- Append-only immutability triggers on the IMMUTABLE facts (FR-051 / FR-056).
-- ===========================================================================
DROP TRIGGER IF EXISTS standard_publication_immutable ON standard_publication;
CREATE TRIGGER standard_publication_immutable BEFORE UPDATE ON standard_publication
  FOR EACH ROW EXECUTE FUNCTION compliance_block_update();
DROP TRIGGER IF EXISTS clause_version_immutable ON clause_version;
CREATE TRIGGER clause_version_immutable BEFORE UPDATE ON clause_version
  FOR EACH ROW EXECUTE FUNCTION compliance_block_update();
DROP TRIGGER IF EXISTS applicability_decision_immutable ON applicability_decision;
CREATE TRIGGER applicability_decision_immutable BEFORE UPDATE ON applicability_decision
  FOR EACH ROW EXECUTE FUNCTION compliance_block_update();

-- ===========================================================================
-- Forced, RESTRICTIVE tenant-isolation RLS on every compliance table (fail-closed).
-- Platform-scoped publication facts use the platform-scope tenant sentinel; current_tenant() is set
-- to that sentinel for the registry reader.
-- ===========================================================================
-- CENTRAL publication facts: readable by every tenant (tenant_id IS NULL) OR the current tenant;
-- writes constrained to the current tenant only (a tenant can never forge a central publication).
ALTER TABLE standard_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE standard_publication FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON standard_publication;
CREATE POLICY tenant_isolation ON standard_publication AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE clause_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE clause_version FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON clause_version;
CREATE POLICY tenant_isolation ON clause_version AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE applicability_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE applicability_decision FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON applicability_decision;
CREATE POLICY tenant_isolation ON applicability_decision AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE compliance_obligation ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_obligation FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON compliance_obligation;
CREATE POLICY tenant_isolation ON compliance_obligation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE control_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_mapping FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_mapping;
CREATE POLICY tenant_isolation ON control_mapping AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE control_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_evaluation FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON control_evaluation;
CREATE POLICY tenant_isolation ON control_evaluation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE compliance_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_assessment FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON compliance_assessment;
CREATE POLICY tenant_isolation ON compliance_assessment AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE external_certification ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_certification FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON external_certification;
CREATE POLICY tenant_isolation ON external_certification AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE compliance_risk ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_risk FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON compliance_risk;
CREATE POLICY tenant_isolation ON compliance_risk AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE risk_treatment_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_treatment_milestone FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON risk_treatment_milestone;
CREATE POLICY tenant_isolation ON risk_treatment_milestone AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE impact_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE impact_assessment FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON impact_assessment;
CREATE POLICY tenant_isolation ON impact_assessment AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE internal_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_audit FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON internal_audit;
CREATE POLICY tenant_isolation ON internal_audit AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE management_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE management_review FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON management_review;
CREATE POLICY tenant_isolation ON management_review AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE compliance_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_finding FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON compliance_finding;
CREATE POLICY tenant_isolation ON compliance_finding AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE corrective_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrective_action FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON corrective_action;
CREATE POLICY tenant_isolation ON corrective_action AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE compliance_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_exception FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON compliance_exception;
CREATE POLICY tenant_isolation ON compliance_exception AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
