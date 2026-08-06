-- 0020_decisions — Durable, tenant-scoped HUMAN-DECISION & GOVERNANCE control substrate for the
-- governed control plane: governance work items, decision requests, decision requirements (SoD /
-- joint gates), decision records (accepted AND rejected attempts), delegations, joint-decision
-- packages, decision notifications, and expiring break-glass grants (Phase 4 / User Story 2 —
-- Make and Govern Human Decisions / FR-010..015, FR-043..045, SC-003/004/005/020).
--
-- Design authority (specs/001-governance-control-plane):
--   * governance-api.openapi.yaml — the CANONICAL field vocabulary. This physical schema is aligned
--     column-for-column with the API contract so a projection over these rows can render the
--     DecisionRequest, DecisionRequirement, DecisionRecord, and Delegation shapes without inventing
--     fields:
--       CreateDecisionRequest := (work_item_id, requested_action, action_class, risk_tier, scope,
--         business_impact, risks[], alternatives[], expected_result, evidence_manifest_id,
--         simulation_id, affected_tenant_ids[], expires_at)
--       DecisionRequest       := CreateDecisionRequest + (id, tenant_id, requester_principal_id,
--         status, requirements[], version, created_at)
--       DecisionRequirement   := (id, gate_type, tenant_id, status, minimum_distinct_principals,
--         incompatible_relationships[])
--       DecisionRecord        := (id, actor_principal_id, authority_assignment_id, action, reason,
--         status, decided_at, audit_event_id)
--       Delegation            := DelegationRequest + (id, tenant_id, delegator_principal_id, status)
--   * spec.md / plan.md: NO consequential action may bypass CURRENT authority, REASON capture,
--     SEPARATION OF DUTIES, tenant approval, central guardrails, or a durable AUDIT. Every one of
--     those obligations is either a column domain here or a row that must exist before an outcome
--     row is committed.
--
-- Acceptance-criterion map (the eight object groups this migration creates):
--   AC1 decision package completeness → decision_request carries the twelve facets (requested
--       action, scope, business impact, risks, alternatives, evidence, versions, requester, SoD
--       requirements via decision_requirement, expiry, expected result).
--   AC2 approve/deny/delegate/request_changes/escalate/expire/cancel fire ONCE with a reason and a
--       retained audit record → decision_record (accepted status) + decision_request.status.
--   AC3 no-authority / conflicting-duty / no-reason / stale-version / expired-assignment →
--       NO state change AND a recorded, explained rejection → decision_record (rejected status,
--       rejection_code, audit_event_id) — the rejection is itself durable and attributable.
--   AC4 material change after review begins → open decision INVALIDATED and re-review required →
--       decision_request.status='invalidated' + invalidation_reason + invalidated_at.
--   AC5 delegation: named recipient, bounded scope, window, reason, delegator authority, NO cycle /
--       privilege expansion → delegation (parent_delegation_id lineage; CHECKs on window/status).
--   AC6 multi-tenant consequential action: blocked until central guardrails pass, every affected
--       tenant supplies a CURRENT scoped approval, AND a distinct central reviewer approves →
--       joint_decision_package + per-tenant decision_requirement rows + central reviewer binding.
--   FR-043..045 emergency intervention → break_glass_grant (expiring, monitored, independently
--       reviewed; never confers decision authority).
--   FR-013 routing → decision_notification (assignment/change/expiry/overdue/blocked/rejection/
--       escalation), routed by approved policy.
--
-- WHY a NEW migration (not an edit to an earlier one): every applied migration is CHECKSUM-PINNED
-- (packages/persistence/src/database.ts runMigrations records its checksum in schema_migrations and
-- rejects an in-place edit with MigrationChecksumError). The decision substrate is therefore added
-- here as a SEPARATE, later, EXPAND-ONLY migration, exactly as 0004/0007/0008/0009/0010 layered on.
--
-- Effect-witness: applying this migration yields an INDEPENDENTLY READABLE durable effect — the
-- eight decision tables, their governance columns, their fail-visible CHECK vocabularies, and their
-- operator/queue indexes — that could not exist before the migration ran.
--
-- Change discipline (db/migrations/README.md): EXPAND only. Every statement is additive and
-- idempotent (CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS then CREATE), so re-applying is a
-- safe no-op. Timestamps are BIGINT epoch millis; every table is tenant-scoped by a UUID tenant_id
-- and isolated by a forced, restrictive RLS policy on current_tenant() (fail-closed on missing
-- tenant context), mirroring 0002_tenant_rls.sql. Outcome rows are append-only, enforced by a
-- BEFORE UPDATE immutability trigger — a decision, once recorded, cannot be silently rewritten.

-- ===========================================================================
-- 1. governance_work_item — the unit of governed work an authorized human must
--    decide on. A decision request is raised AGAINST a work item; the work item
--    carries the requested consequential action, its class, and risk tier so the
--    queue can prioritize by impact/risk (SC-003).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS governance_work_item (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  title              TEXT NOT NULL,
  action_class       TEXT NOT NULL,
  risk_tier          TEXT NOT NULL DEFAULT 'medium',
  status             TEXT NOT NULL DEFAULT 'open',
  business_impact    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT governance_work_item_risk_valid
    CHECK (risk_tier IN ('low','medium','high','critical')),
  CONSTRAINT governance_work_item_status_valid
    CHECK (status IN ('open','decided','withdrawn','superseded'))
);

CREATE INDEX IF NOT EXISTS governance_work_item_queue_idx
  ON governance_work_item (tenant_id, status, risk_tier);

-- ===========================================================================
-- 2. decision_request — the DECISION PACKAGE an authorized human acts on. Aligned
--    1:1 with the API DecisionRequest schema: it carries every facet the approver
--    must see (AC1), an optimistic-concurrency version (so a stale-version action
--    is rejected — AC3), and the invalidation columns (AC4). status is a pinned
--    vocabulary; a bad write is rejected, not silently stored.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS decision_request (
  id                    UUID NOT NULL,
  tenant_id             UUID NOT NULL,
  work_item_id          UUID NOT NULL,
  requester_principal_id UUID NOT NULL,
  requested_action      TEXT NOT NULL,
  action_class          TEXT NOT NULL,
  risk_tier             TEXT NOT NULL DEFAULT 'medium',
  scope                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_impact       JSONB NOT NULL DEFAULT '{}'::jsonb,
  risks                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  alternatives          JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_result       JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_manifest_id  UUID,
  simulation_id         UUID,
  policy_revision       TEXT,
  control_version       TEXT,
  affected_tenant_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                TEXT NOT NULL DEFAULT 'pending',
  version               BIGINT NOT NULL DEFAULT 1,
  invalidation_reason   TEXT,
  invalidated_at        BIGINT,
  created_at            BIGINT NOT NULL,
  expires_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT decision_request_version_positive CHECK (version >= 1),
  CONSTRAINT decision_request_risk_valid
    CHECK (risk_tier IN ('low','medium','high','critical')),
  CONSTRAINT decision_request_status_valid
    CHECK (status IN ('pending','in_review','approved','denied','changes_requested',
                      'escalated','delegated','expired','cancelled','invalidated')),
  -- AC4: an invalidated package MUST carry both the reason and the instant.
  CONSTRAINT decision_request_invalidation_paired
    CHECK ((status <> 'invalidated')
           OR (invalidation_reason IS NOT NULL AND invalidated_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS decision_request_queue_idx
  ON decision_request (tenant_id, status, risk_tier, expires_at);
CREATE INDEX IF NOT EXISTS decision_request_workitem_idx
  ON decision_request (tenant_id, work_item_id);

-- ===========================================================================
-- 3. decision_requirement — a GATE that must be satisfied before a decision can
--    be finally accepted: a separation-of-duties constraint, a per-tenant scoped
--    approval (AC6), a central guardrail, or a joint central review. gate_type and
--    status are pinned; minimum_distinct_principals >= 1 (fail-closed). tenant_id
--    is nullable: a NULL tenant is a NON-WAIVABLE central guardrail.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS decision_requirement (
  id                          UUID NOT NULL,
  owner_tenant_id             UUID NOT NULL,
  decision_id                 UUID NOT NULL,
  gate_type                   TEXT NOT NULL,
  tenant_id                   UUID,
  status                      TEXT NOT NULL DEFAULT 'pending',
  minimum_distinct_principals BIGINT NOT NULL DEFAULT 1,
  incompatible_relationships  JSONB NOT NULL DEFAULT '[]'::jsonb,
  satisfied_by_principal_id   UUID,
  satisfied_at                BIGINT,
  created_at                  BIGINT NOT NULL,
  PRIMARY KEY (owner_tenant_id, id),
  CONSTRAINT decision_requirement_min_principals CHECK (minimum_distinct_principals >= 1),
  CONSTRAINT decision_requirement_gate_valid
    CHECK (gate_type IN ('separation_of_duties','tenant_approval','central_guardrail',
                         'central_review','admin_authority')),
  CONSTRAINT decision_requirement_status_valid
    CHECK (status IN ('pending','satisfied','failed','waived_forbidden'))
);

CREATE INDEX IF NOT EXISTS decision_requirement_decision_idx
  ON decision_requirement (owner_tenant_id, decision_id, status);

-- ===========================================================================
-- 4. decision_record — the ATTRIBUTABLE outcome of a decision attempt. This table
--    holds BOTH accepted transitions (AC2) AND recorded, explained rejections
--    (AC3): a rejected attempt carries a rejection_code + audit_event_id so the
--    refusal is durable and non-repudiable. APPEND-ONLY (immutability trigger) —
--    an outcome, once recorded, is never rewritten.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS decision_record (
  id                      UUID NOT NULL,
  tenant_id               UUID NOT NULL,
  decision_id             UUID NOT NULL,
  actor_principal_id      UUID NOT NULL,
  authority_assignment_id UUID,
  action                  TEXT NOT NULL,
  reason_code             TEXT NOT NULL,
  reason_text             TEXT NOT NULL,
  status                  TEXT NOT NULL,
  rejection_code          TEXT,
  package_digest          TEXT NOT NULL,
  decided_at              BIGINT NOT NULL,
  audit_event_id          UUID NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT decision_record_action_valid
    CHECK (action IN ('approve','deny','delegate','request_changes','escalate','expire','cancel')),
  CONSTRAINT decision_record_status_valid
    CHECK (status IN ('accepted','rejected')),
  -- AC3: a rejected outcome MUST name why it was refused.
  CONSTRAINT decision_record_rejection_paired
    CHECK ((status <> 'rejected') OR (rejection_code IS NOT NULL)),
  -- Reason capture is mandatory for EVERY attempt (accepted or rejected).
  CONSTRAINT decision_record_reason_present
    CHECK (length(btrim(reason_code)) > 0 AND length(btrim(reason_text)) >= 3)
);

CREATE INDEX IF NOT EXISTS decision_record_decision_idx
  ON decision_record (tenant_id, decision_id, decided_at);
CREATE INDEX IF NOT EXISTS decision_record_audit_idx
  ON decision_record (tenant_id, audit_event_id);

-- ===========================================================================
-- 5. delegation — a BOUNDED, non-expanding grant of decision authority from a
--    delegator to a named recipient (AC5). parent_delegation_id records the chain
--    so a cycle / privilege-expansion is detectable by the resolver; the window
--    (valid_from, expires_at) is bounded and status is pinned. Scope is aligned
--    with the API DelegationRequest.scope and actions[].
-- ===========================================================================
CREATE TABLE IF NOT EXISTS delegation (
  id                      UUID NOT NULL,
  tenant_id               UUID NOT NULL,
  delegator_principal_id  UUID NOT NULL,
  recipient_principal_id  UUID NOT NULL,
  authority_assignment_id UUID NOT NULL,
  parent_delegation_id    UUID,
  scope                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_code             TEXT NOT NULL,
  reason_text             TEXT NOT NULL,
  valid_from              BIGINT NOT NULL,
  expires_at              BIGINT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active',
  revoked_at              BIGINT,
  created_at              BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT delegation_window_ordered CHECK (expires_at > valid_from),
  CONSTRAINT delegation_status_valid
    CHECK (status IN ('proposed','active','expired','revoked')),
  CONSTRAINT delegation_not_self CHECK (recipient_principal_id <> delegator_principal_id),
  CONSTRAINT delegation_reason_present
    CHECK (length(btrim(reason_code)) > 0 AND length(btrim(reason_text)) >= 3)
);

CREATE INDEX IF NOT EXISTS delegation_recipient_idx
  ON delegation (tenant_id, recipient_principal_id, status, expires_at);
CREATE INDEX IF NOT EXISTS delegation_chain_idx
  ON delegation (tenant_id, parent_delegation_id);

-- ===========================================================================
-- 6. joint_decision_package — a FEDERATED cross-tenant approval envelope (AC6).
--    It aggregates the per-affected-tenant scoped approvals, the non-waivable
--    central guardrails, and the single distinct central reviewer. central_state
--    advances only when EVERY affected tenant has a current approval AND the
--    central reviewer (distinct from all action principals) has approved.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS joint_decision_package (
  id                          UUID NOT NULL,
  tenant_id                   UUID NOT NULL,
  decision_id                 UUID NOT NULL,
  affected_tenant_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  central_reviewer_principal_id UUID,
  package_digest              TEXT NOT NULL,
  central_state               TEXT NOT NULL DEFAULT 'collecting',
  created_at                  BIGINT NOT NULL,
  updated_at                  BIGINT NOT NULL,
  revoked_at                  BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT joint_decision_package_state_valid
    CHECK (central_state IN ('collecting','central_review','approved','revoked','denied'))
);

CREATE INDEX IF NOT EXISTS joint_decision_package_decision_idx
  ON joint_decision_package (tenant_id, decision_id);

-- ===========================================================================
-- 7. decision_notification — an assignment/change/expiry/overdue/blocked/
--    rejection/escalation notification routed by APPROVED policy (FR-013). It is
--    the durable, auditable delivery intent; the outbox publisher fans it out. A
--    pinned kind vocabulary keeps routing decisions machine-checkable.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS decision_notification (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  decision_id        UUID NOT NULL,
  kind               TEXT NOT NULL,
  recipient_principal_id UUID NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'inbox',
  policy_revision    TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT decision_notification_kind_valid
    CHECK (kind IN ('assignment','change','expiry','overdue','blocked','rejection','escalation')),
  CONSTRAINT decision_notification_channel_valid
    CHECK (channel IN ('inbox','email','webhook','pager'))
);

CREATE INDEX IF NOT EXISTS decision_notification_decision_idx
  ON decision_notification (tenant_id, decision_id, kind);

-- ===========================================================================
-- 8. break_glass_grant — an EXPIRING emergency-authority grant (FR-043..045). It
--    is narrowly scoped, incident-bound, monitored, and independently reviewed;
--    it NEVER confers standing decision authority. reviewer_principal_id MUST
--    differ from the grantee (independent post-event review). The window is
--    bounded and status is pinned; the resolver fails closed on any lapse.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS break_glass_grant (
  id                     UUID NOT NULL,
  tenant_id              UUID NOT NULL,
  principal_id           UUID NOT NULL,
  scope                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason_code            TEXT NOT NULL,
  reason_text            TEXT NOT NULL,
  incident_id            TEXT NOT NULL,
  monitoring_evidence_id UUID NOT NULL,
  reviewer_principal_id  UUID NOT NULL,
  activated_at           BIGINT NOT NULL,
  expires_at             BIGINT NOT NULL,
  review_due_at          BIGINT NOT NULL,
  reviewed_at            BIGINT,
  status                 TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT break_glass_window_ordered CHECK (expires_at > activated_at),
  CONSTRAINT break_glass_reviewer_independent CHECK (reviewer_principal_id <> principal_id),
  CONSTRAINT break_glass_status_valid
    CHECK (status IN ('active','expired','revoked','reviewed')),
  CONSTRAINT break_glass_reason_present
    CHECK (length(btrim(reason_code)) > 0 AND length(btrim(reason_text)) >= 3),
  CONSTRAINT break_glass_incident_present CHECK (length(btrim(incident_id)) > 0)
);

CREATE INDEX IF NOT EXISTS break_glass_grant_principal_idx
  ON break_glass_grant (tenant_id, principal_id, status, expires_at);

-- ===========================================================================
-- 9. Row-Level Security — forced, restrictive tenant isolation on every table,
--    fail-closed on missing tenant context (mirrors 0002_tenant_rls.sql). A
--    decision_requirement may reference a foreign tenant (AC6) but is OWNED and
--    isolated by owner_tenant_id, so a tenant can never read another tenant's
--    requirement rows.
-- ===========================================================================

ALTER TABLE governance_work_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_work_item FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON governance_work_item;
CREATE POLICY tenant_isolation ON governance_work_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE decision_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_request FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON decision_request;
CREATE POLICY tenant_isolation ON decision_request AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE decision_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_requirement FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON decision_requirement;
CREATE POLICY tenant_isolation ON decision_requirement AS RESTRICTIVE FOR ALL
  USING (owner_tenant_id = current_tenant()) WITH CHECK (owner_tenant_id = current_tenant());

ALTER TABLE decision_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_record FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON decision_record;
CREATE POLICY tenant_isolation ON decision_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON delegation;
CREATE POLICY tenant_isolation ON delegation AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE joint_decision_package ENABLE ROW LEVEL SECURITY;
ALTER TABLE joint_decision_package FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON joint_decision_package;
CREATE POLICY tenant_isolation ON joint_decision_package AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE decision_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_notification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON decision_notification;
CREATE POLICY tenant_isolation ON decision_notification AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE break_glass_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON break_glass_grant;
CREATE POLICY tenant_isolation ON break_glass_grant AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- ===========================================================================
-- 10. Append-only immutability — an outcome record and a decision notification,
--     once committed, must never be silently mutated (non-repudiation, FR-012).
--     A BEFORE UPDATE trigger rejects any UPDATE, mirroring the audit-ledger
--     immutability guard in 0005_audit_ledger.sql.
-- ===========================================================================
CREATE OR REPLACE FUNCTION decision_record_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decision_record is append-only; row (%,%) may not be updated',
    OLD.tenant_id, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_record_no_update ON decision_record;
CREATE TRIGGER decision_record_no_update
  BEFORE UPDATE ON decision_record
  FOR EACH ROW EXECUTE FUNCTION decision_record_immutable();

CREATE OR REPLACE FUNCTION decision_notification_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decision_notification is append-only; row (%,%) may not be updated',
    OLD.tenant_id, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_notification_no_update ON decision_notification;
CREATE TRIGGER decision_notification_no_update
  BEFORE UPDATE ON decision_notification
  FOR EACH ROW EXECUTE FUNCTION decision_notification_immutable();
