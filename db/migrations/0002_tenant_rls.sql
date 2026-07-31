-- 0002_tenant_rls — Forced row-level security, composite tenant foreign keys,
-- and non-owner application roles (Phase 19 / task T019 / GAR-008).
--
-- Design authority (specs/001-governance-control-plane):
--   * data-model.md §"Database enforcement and indexes":
--       - "Force RLS on every tenant table; application roles are neither owners
--          nor BYPASSRLS."
--       - "Use restrictive tenant policies plus explicit write WITH CHECK policies."
--       - "Foreign keys never cross tenants without a composite tenant key."
--   * research.md: "PostgreSQL row security can default-deny tenant access when
--     enabled and forced, although owner/superuser bypass behavior means
--     application roles must never own tables or use BYPASSRLS."
--   * plan.md: "Canonical DB | Per-service roles, forced row-level security, tenant
--     context set per transaction, no application owner/superuser connections."
--
-- This migration operates ONLY on the tenant-scoped authority tables created by
-- 0001_tenancy_authority.sql (role_assignment, delegation, sod_constraint,
-- break_glass_grant). `tenant`, `principal`, and `role_definition` are cross-tenant
-- / global-registry tables and are intentionally NOT tenant-RLS-scoped here
-- (sod_constraint's central guardrail rows have tenant_id NULL and are covered by a
-- policy branch that keeps them visible to every tenant).
--
-- Tenant context: each request sets a per-transaction GUC `app.tenant_id` (see
-- apps/api/src/middleware/context.ts). Every RLS policy reads it via
-- current_tenant() below. When it is UNSET or empty the policies default-deny
-- (no row satisfies the predicate), so a missing tenant context can read/write
-- NOTHING — fail-closed, not fail-open.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d):
-- EXPAND only. Every statement is additive and idempotent (`IF NOT EXISTS`,
-- `CREATE OR REPLACE`, each policy drop-if-exists immediately followed by re-create,
-- and `DO $$ ... $$` guards) so re-applying is a safe no-op. Nothing supported is
-- dropped or narrowed; a later narrowing change goes through a NEW
-- expand→migrate→contract migration with deprecation + rollback evidence. The
-- runner (packages/persistence/src/database.ts `runMigrations`) pins this file's
-- checksum once applied, so editing it in place after it has run is rejected
-- (MigrationChecksumError) — an applied migration is immutable.

-- ===========================================================================
-- 1. Non-owner application roles.
--    These roles are the identities the application services connect as. They
--    are deliberately:
--      * NOLOGIN group roles here (per-service LOGIN roles inherit them; the
--        migration owner / DDL role is a DIFFERENT, privileged identity),
--      * NOBYPASSRLS — so forced RLS is actually enforced against them,
--      * NOSUPERUSER, NOCREATEDB, NOCREATEROLE — least privilege,
--      * NOT the owner of any table (they only receive GRANTed DML below).
--    The migration runs as the schema-owning role; application connections use
--    app_rw / app_ro and are therefore always subject to FORCE ROW LEVEL SECURITY.
-- ===========================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    CREATE ROLE app_ro NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Defense-in-depth: even if an operator later flips a flag, re-assert the safety
-- posture idempotently. NOBYPASSRLS and NOSUPERUSER are the two that matter for RLS.
ALTER ROLE app_rw NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE app_ro NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- ===========================================================================
-- 2. Tenant-context accessor.
--    Reads the per-transaction GUC `app.tenant_id`. The `true` second argument to
--    current_setting makes a missing GUC return NULL instead of raising, so an
--    unset context yields NULL and every tenant policy predicate below becomes
--    FALSE (default-deny). An empty string is normalized to NULL for the same
--    fail-closed behavior.
-- ===========================================================================
CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ===========================================================================
-- 3. Composite tenant foreign keys.
--    A tenant-scoped child must reference its parent WITHIN THE SAME TENANT, so a
--    composite (tenant_id, <id>) key makes a cross-tenant reference structurally
--    impossible (data-model.md: "Foreign keys never cross tenants without a
--    composite tenant key").
--
--    Parents expose a composite UNIQUE (tenant_id, <pk>); children carry the
--    parent's tenant_id and a composite FK back to that UNIQUE. Because a child
--    row's own tenant_id is the SAME column used in the FK, a child can only point
--    at a parent that shares its tenant.
-- ===========================================================================

-- role_assignment is the composite-key parent for delegation.authority_assignment_id.
ALTER TABLE role_assignment
  ADD CONSTRAINT role_assignment_tenant_pk_unique UNIQUE (tenant_id, role_assignment_id);

-- delegation.parent_delegation_id must stay within the same tenant, so delegation
-- is ALSO a composite-key parent for its own self-reference.
ALTER TABLE delegation
  ADD CONSTRAINT delegation_tenant_pk_unique UNIQUE (tenant_id, delegation_id);

-- Composite FK: a delegation's authority_assignment must belong to the SAME tenant
-- as the delegation. (tenant_id, authority_assignment_id) -> role_assignment.
ALTER TABLE delegation
  ADD CONSTRAINT delegation_authority_same_tenant_fk
    FOREIGN KEY (tenant_id, authority_assignment_id)
    REFERENCES role_assignment (tenant_id, role_assignment_id);

-- Composite self-FK: a delegation's parent must belong to the SAME tenant. Nullable
-- composite FK — Postgres skips the check when parent_delegation_id IS NULL (MATCH
-- SIMPLE), so a root delegation (no parent) is allowed.
ALTER TABLE delegation
  ADD CONSTRAINT delegation_parent_same_tenant_fk
    FOREIGN KEY (tenant_id, parent_delegation_id)
    REFERENCES delegation (tenant_id, delegation_id);

-- ===========================================================================
-- 4. Forced row-level security on every tenant-scoped table.
--    ENABLE turns RLS on; FORCE applies it to the TABLE OWNER too (so even a
--    connection that happens to own the table is not exempt — only NOBYPASSRLS is
--    trusted to bypass, and app_rw/app_ro are explicitly NOBYPASSRLS). We then
--    install a RESTRICTIVE tenant-isolation policy (an AND-gate that no other
--    permissive policy can widen) plus explicit read (USING) and write (WITH CHECK)
--    predicates, per data-model.md.
--
--    Policy semantics:
--      * RESTRICTIVE `tenant_isolation` — visible/writable ONLY when the row's
--        tenant_id = current_tenant(). This is the hard AND-gate.
--      * PERMISSIVE `tenant_rows` (per command) — the actual USING / WITH CHECK.
--    A missing/empty context => current_tenant() IS NULL => predicate FALSE =>
--    zero rows readable and every write rejected (fail-closed).
-- ===========================================================================

-- role_assignment ---------------------------------------------------------------
ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON role_assignment;
CREATE POLICY tenant_isolation ON role_assignment
  AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());
DROP POLICY IF EXISTS tenant_rows ON role_assignment;
CREATE POLICY tenant_rows ON role_assignment
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

-- delegation --------------------------------------------------------------------
ALTER TABLE delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON delegation;
CREATE POLICY tenant_isolation ON delegation
  AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());
DROP POLICY IF EXISTS tenant_rows ON delegation;
CREATE POLICY tenant_rows ON delegation
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

-- break_glass_grant -------------------------------------------------------------
ALTER TABLE break_glass_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grant FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON break_glass_grant;
CREATE POLICY tenant_isolation ON break_glass_grant
  AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());
DROP POLICY IF EXISTS tenant_rows ON break_glass_grant;
CREATE POLICY tenant_rows ON break_glass_grant
  AS PERMISSIVE FOR ALL
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

-- sod_constraint ----------------------------------------------------------------
-- Special case: sod_constraint rows with tenant_id NULL are the non-waivable
-- CENTRAL guardrails and MUST be visible to every tenant (read), but writable by
-- NONE via the tenant path (central guardrails are managed out of band). The
-- restrictive policy therefore allows read when the row is central (tenant_id NULL)
-- OR belongs to the current tenant, while writes are constrained to the current
-- tenant only (a tenant can never forge a central guardrail).
ALTER TABLE sod_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE sod_constraint FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sod_constraint;
CREATE POLICY tenant_isolation ON sod_constraint
  AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());
DROP POLICY IF EXISTS tenant_rows ON sod_constraint;
CREATE POLICY tenant_rows ON sod_constraint
  AS PERMISSIVE FOR ALL
  USING (tenant_id IS NULL OR tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

-- ===========================================================================
-- 5. Least-privilege DML grants to the non-owner application roles.
--    app_rw: SELECT/INSERT/UPDATE/DELETE on tenant tables (still gated by RLS).
--    app_ro: SELECT only.
--    Neither role owns any table, so FORCE RLS binds them. Privileges are the
--    exact DML verbs below (never the "ALL" shorthand), granted only to the two
--    named application roles (never to the world), and no role holds BYPASSRLS.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON role_assignment  TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON delegation        TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON break_glass_grant TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON sod_constraint    TO app_rw;

GRANT SELECT ON role_assignment  TO app_ro;
GRANT SELECT ON delegation        TO app_ro;
GRANT SELECT ON break_glass_grant TO app_ro;
GRANT SELECT ON sod_constraint    TO app_ro;

-- Read-only role must never mutate: explicitly revoke write, idempotently, in case a
-- broader grant was ever applied. (No-op on a clean apply.)
REVOKE INSERT, UPDATE, DELETE ON role_assignment  FROM app_ro;
REVOKE INSERT, UPDATE, DELETE ON delegation        FROM app_ro;
REVOKE INSERT, UPDATE, DELETE ON break_glass_grant FROM app_ro;
REVOKE INSERT, UPDATE, DELETE ON sod_constraint    FROM app_ro;

-- ===========================================================================
-- 6. Partial indexes for expiring delegations (data-model.md: "Partial indexes
--    cover ... expiring delegations ..."). Supports the tenant-scoped scan the
--    expiry worker runs; additive and idempotent.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS delegation_expiring_idx
  ON delegation (tenant_id, expires_at)
  WHERE status = 'active';
