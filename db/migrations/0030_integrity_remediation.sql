-- 0030_integrity_remediation — Durable, tenant-scoped INTEGRITY / QUARANTINE / REMEDIATION /
-- VERIFIED-CLOSURE substrate for the governed control plane: versioned integrity-rule versions,
-- integrity cases, quarantines, remediation plans (immutable versions), repair attempts, repair
-- reconciliation links, and verification records (Phase 5 / User Story 3 — Contain and Repair
-- Damaged Work Safely / FR-016..022, SC-006..009).
--
-- Design authority (specs/001-governance-control-plane):
--   * data-model.md "Integrity, quarantine, remediation, and verified closure" — the CANONICAL
--     field vocabulary. This physical schema is aligned with those entities so a projection over
--     these rows can render the IntegrityCase, Quarantine, RemediationPlan, RepairAttempt, and
--     VerificationRecord shapes and the API `IntegrityCase` / `VerificationRecord` schemas without
--     inventing fields.
--   * governance-api.openapi.yaml — IntegrityCase (id, tenant_id, problem_class, severity,
--     original_evidence_id, quarantine_id, remediation_plan_id, verification_id, state, version);
--     VerificationRecord (id, verifier_principal_id, result, gate_results[], evidence_manifest_id,
--     verified_at).
--   * spec.md FR-016..022:
--       FR-016 detect malformed/corrupted/duplicated/stale/conflicting/orphaned via VERSIONED rules
--            → integrity_rule + integrity_rule_version (immutable versions).
--       FR-017 ORIGINAL preserved BEFORE any transformation → integrity_case.original_evidence_id
--            is NOT NULL and is set at case creation (preservation precedes classification); the
--            preservation-precedence CHECK forbids a case row without an original.
--       FR-018 classification: type, severity, confidence, scope, safety impact, evidence status,
--            source, owner → integrity_case columns (+ explicit ownership-gap flag).
--       FR-019 quarantine unsafe/ambiguous while remaining visible/reviewable/linked → quarantine
--            (blocked capabilities, visibility policy, release preconditions/decision).
--       FR-020 remediation recommendation states change/rationale/expected/risk/scope/precond/
--            policy authority/evidence/verification/stop/rollback → remediation_plan (immutable
--            versions; authorization_mode human | pre_authorized_low_risk).
--       FR-021 automatic repair limited to CURRENT pre-authorized low-risk cases whose policy /
--            preconditions / evidence preservation / scope / rollback checks pass → repair_attempt
--            binds the applied policy_version + expected_source_revision; destructive automatic
--            repair is PROHIBITED by CHECK (authorization_mode='pre_authorized_low_risk' ⇒ NOT
--            destructive).
--       FR-022 repair produces a DERIVED item with provenance and MUST verify; failure/uncertainty
--            retains quarantine and escalates → repair_attempt.outcome vocabulary + verification.
--   * data-model.md "Verified Closure Gate" — nine conditions; integrity_case may reach 'closed'
--     ONLY with a resolution_verification_id whose verification_record.result='passed' (enforced by
--     the closure-pairing CHECK). A source-reported `done` never becomes verified closure.
--
-- Effect-witness: applying this migration yields an INDEPENDENTLY READABLE durable effect — the
-- eight integrity/remediation tables, their governance columns, their fail-visible CHECK
-- vocabularies, and their operator/queue indexes — that could not exist before the migration ran.
--
-- Change discipline (db/migrations/README.md): EXPAND only. Every statement is additive and
-- idempotent (CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS then CREATE), so re-applying is a
-- safe no-op. Timestamps are BIGINT epoch millis; every table is tenant-scoped by a UUID tenant_id
-- and isolated by a forced, restrictive RLS policy on current_tenant() (fail-closed on missing
-- tenant context), mirroring 0002_tenant_rls.sql and 0020_decisions.sql. Immutable version rows
-- (rule versions, remediation plan versions) and append-only outcome rows (repair attempts,
-- verification records, reconciliation links) are protected by BEFORE UPDATE immutability triggers.

-- ===========================================================================
-- 1. integrity_rule / integrity_rule_version — a STABLE integrity rule plus its
--    IMMUTABLE versions (FR-016 "explicit, VERSIONED integrity rules"). A version
--    pins the defect class it detects, its applicability (source/item schema),
--    detection query, confidence model, quarantine condition, low-risk repair
--    eligibility, tests, monitoring, owner, and effective window + lifecycle. A
--    detection cites the EXACT rule_version_id that fired, so a re-classification
--    under a new rule version is distinguishable from the original.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS integrity_rule (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  rule_key           TEXT NOT NULL,
  owner_principal_id UUID NOT NULL,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT integrity_rule_key_present CHECK (length(btrim(rule_key)) > 0)
);

CREATE TABLE IF NOT EXISTS integrity_rule_version (
  id                       UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  rule_id                  UUID NOT NULL,
  version                  BIGINT NOT NULL,
  problem_class            TEXT NOT NULL,
  applicability            JSONB NOT NULL DEFAULT '{}'::jsonb,
  detection_query          JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity                 TEXT NOT NULL DEFAULT 'medium',
  confidence_model         JSONB NOT NULL DEFAULT '{}'::jsonb,
  quarantine_condition     JSONB NOT NULL DEFAULT '{}'::jsonb,
  low_risk_repair_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  tests                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  monitoring               JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_control_mappings   JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_principal_id       UUID NOT NULL,
  approval_decision_id     UUID,
  lifecycle_state          TEXT NOT NULL DEFAULT 'draft',
  effective_from           BIGINT,
  effective_to             BIGINT,
  content_digest           TEXT NOT NULL,
  created_at               BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT integrity_rule_version_positive CHECK (version >= 1),
  CONSTRAINT integrity_rule_version_class_valid
    CHECK (problem_class IN ('malformed','corrupted','duplicated','stale','conflicting',
                             'orphaned','combined','unknown')),
  CONSTRAINT integrity_rule_version_severity_valid
    CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT integrity_rule_version_lifecycle_valid
    CHECK (lifecycle_state IN ('draft','proposed','active','deprecated','retired')),
  -- An ACTIVE version must carry tests and an effective_from (it cannot monitor production
  -- without a verification obligation and an activation instant) — fail-closed activation.
  CONSTRAINT integrity_rule_version_active_governed
    CHECK (lifecycle_state <> 'active'
           OR (effective_from IS NOT NULL AND jsonb_array_length(tests) >= 1)),
  UNIQUE (tenant_id, rule_id, version)
);

CREATE INDEX IF NOT EXISTS integrity_rule_version_rule_idx
  ON integrity_rule_version (tenant_id, rule_id, version);
CREATE INDEX IF NOT EXISTS integrity_rule_version_active_idx
  ON integrity_rule_version (tenant_id, problem_class, lifecycle_state);

-- ===========================================================================
-- 2. integrity_case — one detected integrity problem AGAINST a work item (FR-018).
--    original_evidence_id is NOT NULL: the ORIGINAL raw content + metadata is
--    committed BEFORE the case is classified (FR-017 preservation precedes
--    classification). The classification facets (type, severity, confidence,
--    safety impact, affected scope, dependents, source, owner) are columns; an
--    unownable corrupted item sets ownership_gap=TRUE rather than fabricating an
--    owner. state is a pinned lifecycle vocabulary; 'closed' requires a passing
--    resolution verification (Verified Closure Gate).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS integrity_case (
  id                        UUID NOT NULL,
  tenant_id                 UUID NOT NULL,
  work_item_id              UUID NOT NULL,
  rule_version_id           UUID NOT NULL,
  source_record_id          UUID NOT NULL,
  original_evidence_id      UUID NOT NULL,
  problem_class             TEXT NOT NULL,
  problem_classes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  severity                  TEXT NOT NULL DEFAULT 'medium',
  confidence                DOUBLE PRECISION NOT NULL DEFAULT 0,
  disposition               TEXT NOT NULL DEFAULT 'confirmed',
  safety_impact             TEXT NOT NULL DEFAULT 'none',
  business_impact           JSONB NOT NULL DEFAULT '{}'::jsonb,
  affected_scope            JSONB NOT NULL DEFAULT '{}'::jsonb,
  dependent_work_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_status           TEXT NOT NULL DEFAULT 'preserved',
  source_ref                JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_principal_id        UUID,
  ownership_gap             BOOLEAN NOT NULL DEFAULT FALSE,
  quarantine_id             UUID,
  active_remediation_plan_id UUID,
  resolution_verification_id UUID,
  state                     TEXT NOT NULL DEFAULT 'detected',
  version                   BIGINT NOT NULL DEFAULT 1,
  detected_at               BIGINT NOT NULL,
  updated_at                BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT integrity_case_version_positive CHECK (version >= 1),
  CONSTRAINT integrity_case_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT integrity_case_class_valid
    CHECK (problem_class IN ('malformed','corrupted','duplicated','stale','conflicting',
                             'orphaned','combined','unknown')),
  CONSTRAINT integrity_case_severity_valid
    CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT integrity_case_disposition_valid
    CHECK (disposition IN ('confirmed','suspected','false_positive')),
  CONSTRAINT integrity_case_safety_valid
    CHECK (safety_impact IN ('none','low','moderate','high','catastrophic')),
  CONSTRAINT integrity_case_evidence_status_valid
    CHECK (evidence_status IN ('preserved','partial','unverifiable','tampered')),
  CONSTRAINT integrity_case_state_valid
    CHECK (state IN ('detected','preserved','classified','quarantined','remediation_proposed',
                     'repairing','verifying','repaired','closed','unresolved','escalated')),
  -- FR-017: an ambiguous/unownable item is an explicit ownership GAP, never a fabricated owner.
  CONSTRAINT integrity_case_ownership_paired
    CHECK ((ownership_gap = TRUE AND owner_principal_id IS NULL)
           OR (ownership_gap = FALSE AND owner_principal_id IS NOT NULL)),
  -- Verified Closure Gate: 'closed'/'repaired' MUST carry a resolution verification; a
  -- source-reported done can never satisfy this on its own.
  CONSTRAINT integrity_case_closure_verified
    CHECK (state NOT IN ('repaired','closed') OR resolution_verification_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS integrity_case_queue_idx
  ON integrity_case (tenant_id, state, problem_class, severity);
CREATE INDEX IF NOT EXISTS integrity_case_workitem_idx
  ON integrity_case (tenant_id, work_item_id);
CREATE INDEX IF NOT EXISTS integrity_case_owner_idx
  ON integrity_case (tenant_id, owner_principal_id, ownership_gap);

-- ===========================================================================
-- 3. quarantine — blocks UNSAFE execution dependencies of a case while keeping the
--    item VISIBLE, INSPECTABLE, and LINKED to dependent work (FR-019). It records
--    the blocked capabilities, reason/authority, review cadence, visibility/access
--    policy, the original evidence pointer, release preconditions, and the release
--    decision. blocked_capabilities is non-empty for an active quarantine (a
--    quarantine that blocks nothing is not a quarantine).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS quarantine (
  id                     UUID NOT NULL,
  tenant_id              UUID NOT NULL,
  integrity_case_id      UUID NOT NULL,
  blocked_capabilities   JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocked_dependency_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_code            TEXT NOT NULL,
  reason_text            TEXT NOT NULL,
  authority_ref          JSONB NOT NULL DEFAULT '{}'::jsonb,
  visibility_policy      TEXT NOT NULL DEFAULT 'visible_inspectable',
  original_evidence_id   UUID NOT NULL,
  release_preconditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  release_decision_id    UUID,
  review_cadence_ms      BIGINT NOT NULL DEFAULT 86400000,
  review_due_at          BIGINT NOT NULL,
  started_at             BIGINT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  released_at            BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT quarantine_reason_present
    CHECK (length(btrim(reason_code)) > 0 AND length(btrim(reason_text)) >= 3),
  CONSTRAINT quarantine_visibility_valid
    CHECK (visibility_policy IN ('visible_inspectable','visible_restricted')),
  CONSTRAINT quarantine_status_valid
    CHECK (status IN ('active','under_review','release_proposed','released','expired')),
  -- An ACTIVE quarantine must block at least one capability (it must actually contain effects).
  CONSTRAINT quarantine_blocks_something
    CHECK (status <> 'active' OR jsonb_array_length(blocked_capabilities) >= 1),
  -- A release must name the release decision (authority boundary — a release is a decision).
  CONSTRAINT quarantine_release_decided
    CHECK (status <> 'released' OR release_decision_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS quarantine_case_idx
  ON quarantine (tenant_id, integrity_case_id, status);
CREATE INDEX IF NOT EXISTS quarantine_review_idx
  ON quarantine (tenant_id, status, review_due_at);

-- ===========================================================================
-- 4. remediation_plan — an IMMUTABLE-per-version remediation recommendation
--    (FR-020). Each version states the proposed change, rationale, expected result,
--    risk class, affected scope, preconditions, policy authority (authorization_mode
--    human | pre_authorized_low_risk), evidence plan, verification plan, stop
--    conditions, rollback plan, and expiry. destructive=TRUE is INCOMPATIBLE with
--    pre_authorized_low_risk (GAR-004 — destructive automatic remediation prohibited).
--    Rows are append-only (immutability trigger); a "change" is a new version.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS remediation_plan (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  integrity_case_id    UUID NOT NULL,
  version              BIGINT NOT NULL,
  proposed_change      JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale            TEXT NOT NULL,
  expected_result      JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_class           TEXT NOT NULL DEFAULT 'medium',
  destructive          BOOLEAN NOT NULL DEFAULT FALSE,
  affected_scope       JSONB NOT NULL DEFAULT '{}'::jsonb,
  preconditions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_version_id    UUID,
  authorization_mode   TEXT NOT NULL DEFAULT 'human',
  bounds               JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_plan        JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_plan    JSONB NOT NULL DEFAULT '{}'::jsonb,
  stop_conditions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollback_plan        JSONB NOT NULL DEFAULT '{}'::jsonb,
  simulation_id        UUID,
  approval_decision_id UUID,
  owner_principal_id   UUID NOT NULL,
  expires_at           BIGINT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft',
  content_digest       TEXT NOT NULL,
  created_at           BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT remediation_plan_version_positive CHECK (version >= 1),
  CONSTRAINT remediation_plan_rationale_present CHECK (length(btrim(rationale)) >= 3),
  CONSTRAINT remediation_plan_risk_valid
    CHECK (risk_class IN ('low','medium','high','critical')),
  CONSTRAINT remediation_plan_authz_valid
    CHECK (authorization_mode IN ('human','pre_authorized_low_risk')),
  CONSTRAINT remediation_plan_status_valid
    CHECK (status IN ('draft','simulated','pending_approval','approved','expired','superseded')),
  -- GAR-004 / FR-021: pre-authorized automatic repair MUST be low-risk and NON-destructive, and
  -- must bind a policy version. Destructive or non-low-risk remediation is HUMAN-authorized only.
  CONSTRAINT remediation_plan_low_risk_non_destructive
    CHECK (authorization_mode <> 'pre_authorized_low_risk'
           OR (destructive = FALSE AND risk_class = 'low' AND policy_version_id IS NOT NULL)),
  UNIQUE (tenant_id, integrity_case_id, version)
);

CREATE INDEX IF NOT EXISTS remediation_plan_case_idx
  ON remediation_plan (tenant_id, integrity_case_id, version);

-- ===========================================================================
-- 5. repair_attempt — the execution of an approved remediation plan version
--    (FR-021/022). ONE idempotency identity per attempt (idempotency_key UNIQUE per
--    tenant): a replayed request never produces a second governed effect. It binds
--    the plan version, the PRESERVED original, the EXPECTED source revision (drift
--    invalidates it), the applied policy version + decision, the per-step outcomes,
--    the DERIVED evidence produced, the source response + ACTUAL revision, the
--    rollback attempt, and the final outcome. outcome is a pinned vocabulary that
--    keeps uncertainty visible (succeeded_unverified / uncertain are NOT success).
--    Append-only (immutability trigger).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS repair_attempt (
  id                       UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  integrity_case_id        UUID NOT NULL,
  remediation_plan_id      UUID NOT NULL,
  plan_version             BIGINT NOT NULL,
  idempotency_key          TEXT NOT NULL,
  preserved_original_evidence_id UUID NOT NULL,
  expected_source_revision TEXT NOT NULL,
  actual_source_revision   TEXT,
  applied_policy_version_id UUID,
  decision_id              UUID,
  executor_principal_id    UUID NOT NULL,
  step_outcomes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  derived_evidence_id      UUID,
  source_response          JSONB NOT NULL DEFAULT '{}'::jsonb,
  kill_switch_engaged      BOOLEAN NOT NULL DEFAULT FALSE,
  rollback_attempted       BOOLEAN NOT NULL DEFAULT FALSE,
  rollback_outcome         TEXT,
  outcome                  TEXT NOT NULL DEFAULT 'pending',
  started_at               BIGINT NOT NULL,
  completed_at             BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT repair_attempt_plan_version_positive CHECK (plan_version >= 1),
  CONSTRAINT repair_attempt_idempotency_present CHECK (length(btrim(idempotency_key)) >= 8),
  CONSTRAINT repair_attempt_expected_revision_present
    CHECK (length(btrim(expected_source_revision)) > 0),
  CONSTRAINT repair_attempt_outcome_valid
    CHECK (outcome IN ('pending','succeeded_unverified','verified','failed','uncertain',
                       'rolled_back','rollback_failed')),
  CONSTRAINT repair_attempt_rollback_outcome_valid
    CHECK (rollback_outcome IS NULL
           OR rollback_outcome IN ('rolled_back','partial','conflict','failed')),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS repair_attempt_case_idx
  ON repair_attempt (tenant_id, integrity_case_id, started_at);

-- ===========================================================================
-- 6. repair_reconciliation — the reconciliation of the EXPECTED repair outcome
--    against the AUTHORITATIVE CURRENT source (FR-022/FR-028). It retains EVERY
--    difference (the differences JSONB is the durable record), so an unconfirmed or
--    divergent outcome cannot be silently reported resolved. reconciled=FALSE keeps
--    the case out of verified closure.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS repair_reconciliation (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  integrity_case_id  UUID NOT NULL,
  repair_attempt_id  UUID NOT NULL,
  expected_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_state     JSONB NOT NULL DEFAULT '{}'::jsonb,
  differences        JSONB NOT NULL DEFAULT '[]'::jsonb,
  reconciled         BOOLEAN NOT NULL DEFAULT FALSE,
  uncertain          BOOLEAN NOT NULL DEFAULT FALSE,
  reconciled_at      BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- A reconciliation that is 'reconciled' must have NO residual differences and NO uncertainty.
  CONSTRAINT repair_reconciliation_clean
    CHECK (reconciled = FALSE
           OR (uncertain = FALSE AND jsonb_array_length(differences) = 0))
);

CREATE INDEX IF NOT EXISTS repair_reconciliation_case_idx
  ON repair_reconciliation (tenant_id, integrity_case_id);

-- ===========================================================================
-- 7. verification_record — the INDEPENDENT verification that decides the Verified
--    Closure Gate (FR-022, data-model "Verified Closure Gate"). It records the
--    subject, the verifier + independence check, the rule/control versions checked,
--    the evidence manifest, the expected vs observed state + reconciliation, the
--    dependency + residual-risk checks, the nine gate results (as JSONB), and the
--    result. result='passed' requires the independence check to pass and every gate
--    to pass. Append-only.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS verification_record (
  id                    UUID NOT NULL,
  tenant_id             UUID NOT NULL,
  subject_type          TEXT NOT NULL,
  subject_id            UUID NOT NULL,
  subject_version       BIGINT NOT NULL,
  verification_type     TEXT NOT NULL DEFAULT 'closure',
  verifier_principal_id UUID NOT NULL,
  independence_check_id UUID NOT NULL,
  verifier_independent  BOOLEAN NOT NULL DEFAULT FALSE,
  rule_control_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_manifest_id  UUID NOT NULL,
  expected_state        JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_state        JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_id     UUID,
  dependency_check      JSONB NOT NULL DEFAULT '{}'::jsonb,
  residual_risk_check   JSONB NOT NULL DEFAULT '{}'::jsonb,
  gate_results          JSONB NOT NULL DEFAULT '[]'::jsonb,
  result                TEXT NOT NULL DEFAULT 'indeterminate',
  reason_text           TEXT NOT NULL,
  verified_at           BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT verification_record_subject_valid
    CHECK (subject_type IN ('work_item','coverage_gap','integrity_case','finding','incident',
                            'exception','repair','rollback')),
  CONSTRAINT verification_record_type_valid
    CHECK (verification_type IN ('repair','closure','rollback','migration','control','evidence')),
  CONSTRAINT verification_record_result_valid
    CHECK (result IN ('passed','failed','indeterminate')),
  CONSTRAINT verification_record_reason_present CHECK (length(btrim(reason_text)) >= 3),
  -- A PASSED verification requires an INDEPENDENT verifier and all nine gate results present+passed.
  CONSTRAINT verification_record_passed_independent
    CHECK (result <> 'passed'
           OR (verifier_independent = TRUE AND jsonb_array_length(gate_results) >= 9))
);

CREATE INDEX IF NOT EXISTS verification_record_subject_idx
  ON verification_record (tenant_id, subject_type, subject_id, verified_at);

-- ===========================================================================
-- 8. integrity_escalation — an UNRESOLVED case escalated for human resolution
--    (FR-022): destructive, consequential, unowned, repeated, expanding,
--    evidence-tampered, rollback-failed, or verification-failed. An escalation keeps
--    the case VISIBLE and OWNED-for-triage; it is never a silent close.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS integrity_escalation (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  integrity_case_id  UUID NOT NULL,
  trigger            TEXT NOT NULL,
  reason_code        TEXT NOT NULL,
  reason_text        TEXT NOT NULL,
  escalated_to       JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_event_id     UUID NOT NULL,
  escalated_at       BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT integrity_escalation_trigger_valid
    CHECK (trigger IN ('destructive','consequential','unowned','repeated','expanding',
                       'evidence_tampered','rollback_failed','verification_failed')),
  CONSTRAINT integrity_escalation_reason_present
    CHECK (length(btrim(reason_code)) > 0 AND length(btrim(reason_text)) >= 3),
  CONSTRAINT integrity_escalation_status_valid
    CHECK (status IN ('open','acknowledged','resolved'))
);

CREATE INDEX IF NOT EXISTS integrity_escalation_case_idx
  ON integrity_escalation (tenant_id, integrity_case_id, status);

-- ===========================================================================
-- 9. Row-Level Security — forced, restrictive tenant isolation on every table,
--    fail-closed on missing tenant context (mirrors 0002_tenant_rls.sql /
--    0020_decisions.sql).
-- ===========================================================================
ALTER TABLE integrity_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_rule FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integrity_rule;
CREATE POLICY tenant_isolation ON integrity_rule AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE integrity_rule_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_rule_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integrity_rule_version;
CREATE POLICY tenant_isolation ON integrity_rule_version AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE integrity_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_case FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integrity_case;
CREATE POLICY tenant_isolation ON integrity_case AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON quarantine;
CREATE POLICY tenant_isolation ON quarantine AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE remediation_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE remediation_plan FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON remediation_plan;
CREATE POLICY tenant_isolation ON remediation_plan AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE repair_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON repair_attempt;
CREATE POLICY tenant_isolation ON repair_attempt AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE repair_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_reconciliation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON repair_reconciliation;
CREATE POLICY tenant_isolation ON repair_reconciliation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE verification_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_record FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON verification_record;
CREATE POLICY tenant_isolation ON verification_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE integrity_escalation ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_escalation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integrity_escalation;
CREATE POLICY tenant_isolation ON integrity_escalation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ===========================================================================
-- 10. Immutability — IMMUTABLE version rows and APPEND-ONLY outcome rows must never
--     be silently rewritten (FR-016 versioned rules; FR-020 immutable plan versions;
--     FR-017/022 originals + outcomes; non-repudiation). BEFORE UPDATE triggers reject
--     UPDATE on these tables, mirroring the audit-ledger / decision-record guards.
--     integrity_case and quarantine are MUTABLE (they carry lifecycle state), so they
--     are intentionally NOT frozen.
-- ===========================================================================
CREATE OR REPLACE FUNCTION integrity_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only/immutable; row (%,%) may not be updated',
    TG_TABLE_NAME, OLD.tenant_id, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS integrity_rule_version_no_update ON integrity_rule_version;
CREATE TRIGGER integrity_rule_version_no_update
  BEFORE UPDATE ON integrity_rule_version
  FOR EACH ROW EXECUTE FUNCTION integrity_append_only();

DROP TRIGGER IF EXISTS remediation_plan_no_update ON remediation_plan;
CREATE TRIGGER remediation_plan_no_update
  BEFORE UPDATE ON remediation_plan
  FOR EACH ROW EXECUTE FUNCTION integrity_append_only();

DROP TRIGGER IF EXISTS repair_attempt_no_update ON repair_attempt;
CREATE TRIGGER repair_attempt_no_update
  BEFORE UPDATE ON repair_attempt
  FOR EACH ROW EXECUTE FUNCTION integrity_append_only();

DROP TRIGGER IF EXISTS repair_reconciliation_no_update ON repair_reconciliation;
CREATE TRIGGER repair_reconciliation_no_update
  BEFORE UPDATE ON repair_reconciliation
  FOR EACH ROW EXECUTE FUNCTION integrity_append_only();

DROP TRIGGER IF EXISTS verification_record_no_update ON verification_record;
CREATE TRIGGER verification_record_no_update
  BEFORE UPDATE ON verification_record
  FOR EACH ROW EXECUTE FUNCTION integrity_append_only();
