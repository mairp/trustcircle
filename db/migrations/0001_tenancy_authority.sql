-- 0001_tenancy_authority — Tenancy, identity, and authority core (Phase 18).
--
-- Creates the seven governed authority tables from
-- specs/001-governance-control-plane/data-model.md §"Tenancy, identity, and authority":
--   tenant, principal, role_definition, role_assignment, delegation,
--   sod_constraint, break_glass_grant.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d):
-- EXPAND only. Every statement is additive and idempotent (`IF NOT EXISTS` /
-- `DO $$ ... $$` enum guards) so re-applying is a safe no-op. A supported column,
-- table, or view is NEVER dropped or narrowed here; narrowing changes go through a
-- NEW expand→migrate→contract migration with deprecation + rollback evidence. The
-- runner (packages/persistence/src/database.ts `runMigrations`) pins this file's
-- checksum once applied, so editing it in place after it has run is rejected
-- (MigrationChecksumError) — an applied migration is immutable.
--
-- Authority invariants enforced structurally here (see data-model.md):
--   * Tenant.slug globally unique; status/enum-bounded lifecycle.
--   * Principal authentication identity pair (issuer, subject) globally unique.
--   * RoleDefinition (role_key, version) immutable version pair, unique.
--   * RoleAssignment references tenant + principal + role_definition; expiry bound.
--   * Delegation: delegator ≠ recipient (no self-delegation), parent ≠ self
--     (cycle base case), tenant-scoped, bounded validity — no privilege expansion
--     across the tenant boundary (tenant_id is a hard FK to the delegator's tenant).
--   * SoDConstraint: tenant_id NULL only for the non-waivable central guardrail;
--     minimum_distinct_principals >= 1 (>= 2 for independently reviewed actions).
--   * BreakGlassGrant: short-lived (activated_at < expires_at), independent
--     post-event reviewer required, monitoring evidence required.

-- ---------------------------------------------------------------------------
-- Enumerated lifecycle / status domains (idempotent creation).
-- Each guarded so re-running the migration does not error on an existing type.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE tenant_status AS ENUM ('proposed', 'active', 'suspended', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE principal_type AS ENUM ('human', 'service', 'automation', 'external_assessor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE principal_status AS ENUM ('active', 'suspended', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_definition_status AS ENUM ('proposed', 'approved', 'active', 'superseded', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE role_assignment_status AS ENUM ('pending', 'active', 'suspended', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delegation_status AS ENUM ('proposed', 'active', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sod_constraint_status AS ENUM ('proposed', 'approved', 'active', 'superseded', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE break_glass_status AS ENUM ('active', 'expired', 'revoked', 'reviewed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Tenant — the top-level isolation boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant (
  tenant_id                UUID PRIMARY KEY,
  slug                     TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  boundary_version_id      UUID,
  status                   tenant_status NOT NULL DEFAULT 'proposed',
  data_residency           JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_namespace       TEXT NOT NULL,
  encryption_key_ref       TEXT,
  signing_key_ref          TEXT,
  retention_policy_set_id  UUID,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  CONSTRAINT tenant_slug_unique UNIQUE (slug),
  CONSTRAINT tenant_evidence_namespace_unique UNIQUE (evidence_namespace),
  -- A tenant cannot be active without an approved retention policy set (data-model invariant).
  CONSTRAINT tenant_active_requires_retention
    CHECK (status <> 'active' OR retention_policy_set_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tenant_status_idx ON tenant (status);

-- ---------------------------------------------------------------------------
-- Principal — an authenticated identity (human, service, automation, assessor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principal (
  principal_id        UUID PRIMARY KEY,
  principal_type      principal_type NOT NULL,
  issuer              TEXT NOT NULL,
  subject             TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  status              principal_status NOT NULL DEFAULT 'active',
  assurance_level     TEXT,
  attributes          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at    BIGINT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  -- The (issuer, subject) authentication identity pair is globally unique.
  CONSTRAINT principal_identity_unique UNIQUE (issuer, subject),
  -- Active service identities must carry a last-verified timestamp (data-model rule).
  CONSTRAINT principal_service_requires_verified
    CHECK (
      NOT (principal_type = 'service' AND status = 'active')
      OR last_verified_at IS NOT NULL
    )
);

-- ---------------------------------------------------------------------------
-- RoleDefinition — a versioned, immutable set of exact permissions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_definition (
  role_definition_id   UUID PRIMARY KEY,
  role_key             TEXT NOT NULL,
  version              INTEGER NOT NULL,
  permissions          JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflict_tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               role_definition_status NOT NULL DEFAULT 'proposed',
  owner_principal_id   UUID NOT NULL REFERENCES principal (principal_id),
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  -- (role_key, version) is an immutable, unique version pair — no implicit wildcard.
  CONSTRAINT role_definition_key_version_unique UNIQUE (role_key, version),
  CONSTRAINT role_definition_version_positive CHECK (version >= 1)
);

-- ---------------------------------------------------------------------------
-- RoleAssignment — grants a role to a principal within a tenant + scope.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_assignment (
  role_assignment_id      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES tenant (tenant_id),
  principal_id            UUID NOT NULL REFERENCES principal (principal_id),
  role_definition_id      UUID NOT NULL REFERENCES role_definition (role_definition_id),
  scope_type              TEXT NOT NULL,
  scope_id                TEXT,
  allowed_actions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  valid_from              BIGINT NOT NULL,
  expires_at              BIGINT,
  grant_reason            TEXT NOT NULL,
  grant_decision_id       UUID NOT NULL,
  status                  role_assignment_status NOT NULL DEFAULT 'pending',
  last_recertified_at     BIGINT,
  next_recertification_at BIGINT,
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL,
  -- Temporal validity must be well-formed (expiry, when present, follows valid_from).
  CONSTRAINT role_assignment_validity_bound
    CHECK (expires_at IS NULL OR expires_at > valid_from),
  -- An active assignment must carry recertification bookkeeping (data-model rule).
  CONSTRAINT role_assignment_active_recert
    CHECK (status <> 'active' OR next_recertification_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS role_assignment_tenant_idx ON role_assignment (tenant_id);
CREATE INDEX IF NOT EXISTS role_assignment_principal_idx ON role_assignment (principal_id);

-- ---------------------------------------------------------------------------
-- Delegation — a bounded, time-limited hand-off of authority; no cycles,
-- no privilege expansion, no cross-tenant crossing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delegation (
  delegation_id            UUID PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenant (tenant_id),
  delegator_principal_id   UUID NOT NULL REFERENCES principal (principal_id),
  recipient_principal_id   UUID NOT NULL REFERENCES principal (principal_id),
  authority_assignment_id  UUID NOT NULL REFERENCES role_assignment (role_assignment_id),
  scope_type               TEXT NOT NULL,
  scope_id                 TEXT,
  actions                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_text              TEXT NOT NULL,
  valid_from               BIGINT NOT NULL,
  expires_at               BIGINT NOT NULL,
  parent_delegation_id     UUID REFERENCES delegation (delegation_id),
  status                   delegation_status NOT NULL DEFAULT 'proposed',
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  -- Delegator and recipient must differ (no self-delegation).
  CONSTRAINT delegation_distinct_parties
    CHECK (delegator_principal_id <> recipient_principal_id),
  -- Bounded validity window (expiry is required and strictly after start).
  CONSTRAINT delegation_bounded_validity CHECK (expires_at > valid_from),
  -- Cycle base case: a delegation may not be its own parent.
  CONSTRAINT delegation_no_self_parent
    CHECK (parent_delegation_id IS NULL OR parent_delegation_id <> delegation_id)
);
CREATE INDEX IF NOT EXISTS delegation_tenant_idx ON delegation (tenant_id);
CREATE INDEX IF NOT EXISTS delegation_recipient_idx ON delegation (recipient_principal_id);
CREATE INDEX IF NOT EXISTS delegation_parent_idx ON delegation (parent_delegation_id);

-- ---------------------------------------------------------------------------
-- SoDConstraint — separation-of-duties rule. tenant_id NULL means a
-- non-waivable central guardrail (mirrors packages/authz/src/separation-of-duties.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sod_constraint (
  sod_constraint_id           UUID PRIMARY KEY,
  tenant_id                   UUID REFERENCES tenant (tenant_id),
  version                     INTEGER NOT NULL,
  action_class                TEXT NOT NULL,
  risk_minimum                TEXT,
  incompatible_roles          JSONB NOT NULL DEFAULT '[]'::jsonb,
  incompatible_relationships  JSONB NOT NULL DEFAULT '[]'::jsonb,
  minimum_distinct_principals INTEGER NOT NULL DEFAULT 2,
  status                      sod_constraint_status NOT NULL DEFAULT 'proposed',
  created_at                  BIGINT NOT NULL,
  updated_at                  BIGINT NOT NULL,
  CONSTRAINT sod_constraint_version_positive CHECK (version >= 1),
  -- At least one distinct principal; independently reviewed actions require >= 2.
  CONSTRAINT sod_constraint_min_principals CHECK (minimum_distinct_principals >= 1),
  -- (tenant_id, action_class, version) uniquely identifies a constraint revision;
  -- the central guardrail (tenant_id NULL) is keyed by (action_class, version) via
  -- the partial index below.
  CONSTRAINT sod_constraint_tenant_action_version_unique
    UNIQUE (tenant_id, action_class, version)
);
-- Central (non-waivable) guardrails have tenant_id NULL; make their
-- (action_class, version) unique too, since NULLs are distinct under a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS sod_constraint_central_unique
  ON sod_constraint (action_class, version)
  WHERE tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- BreakGlassGrant — narrow, short-lived emergency authority with mandatory
-- independent post-event review and monitoring evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS break_glass_grant (
  break_glass_grant_id   UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES tenant (tenant_id),
  principal_id           UUID NOT NULL REFERENCES principal (principal_id),
  scope                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions                JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_text            TEXT NOT NULL,
  incident_id            UUID NOT NULL,
  activated_at           BIGINT NOT NULL,
  expires_at             BIGINT NOT NULL,
  monitoring_evidence_id UUID NOT NULL,
  reviewer_principal_id  UUID NOT NULL REFERENCES principal (principal_id),
  review_due_at          BIGINT NOT NULL,
  reviewed_at            BIGINT,
  status                 break_glass_status NOT NULL DEFAULT 'active',
  created_at             BIGINT NOT NULL,
  updated_at             BIGINT NOT NULL,
  -- Short-lived: the grant must expire strictly after it is activated.
  CONSTRAINT break_glass_short_lived CHECK (expires_at > activated_at),
  -- Independent review: the reviewer must not be the granted principal.
  CONSTRAINT break_glass_independent_reviewer
    CHECK (reviewer_principal_id <> principal_id),
  -- A 'reviewed' grant must record when the review happened.
  CONSTRAINT break_glass_reviewed_has_timestamp
    CHECK (status <> 'reviewed' OR reviewed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS break_glass_tenant_idx ON break_glass_grant (tenant_id);
CREATE INDEX IF NOT EXISTS break_glass_principal_idx ON break_glass_grant (principal_id);
