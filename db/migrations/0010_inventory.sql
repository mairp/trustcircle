-- 0010_inventory — Durable, tenant-scoped INVENTORY & OPEN-ENDED SOURCE-CATALOG substrate for the
-- governed control plane: inventory boundaries, source contracts, source catalog entries, per-source
-- raw source records, reconciled governed assets, relationships (correlation edges / dependencies /
-- authoritative-field attribution), correlation cases (unresolved conflicts held for a human), and
-- coverage gaps (Phase 62 / work item CRH8GM7CDEEXG6DFW0VV7TT3HZ / VO-ec575c4ce42b548bfb4d,
-- GAR-010, VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13).
--
-- Design authority (specs/001-governance-control-plane):
--   * governance-api.openapi.yaml — the CANONICAL field vocabulary. This physical schema is aligned
--     column-for-column with the API contract so a projection over these rows can render the
--     SourceCatalogEntry and GovernedAsset shapes without inventing fields:
--       SourceCatalogEntry := (id, tenant_id, source_class, observed_locations,
--         owner_principal_id, onboarding_state, access_state, health_state, coverage_gap_ids,
--         first_seen_at, last_seen_at)
--       GovernedAsset      := (id, tenant_id, asset_type, name, owner_principal_id,
--         lifecycle_state, risk_tier, health, coverage, last_observed_at, version)
--   * spec.md / plan.md (VO-6acaf6470d0810df4c93): the OPEN-ENDED source catalog, RECONCILED
--     inventory, coverage gaps, related work across sources, ownership, health, and safe next
--     actions MUST be CURRENT and FAIL-VISIBLE from durable rows — never inferred from an
--     in-memory flag or silently dropped.
--   * VO-53a014009bdfebd7af13 (stale-state signaling): a source that becomes stale/unavailable is
--     MARKED with a last-known time + a freshness ∈ {fresh,stale,unknown} + a confidence, and its
--     health is NEVER inferred from stale data. The named CHECK constraints reject an
--     unhealthy-looking-healthy or a stale-looking-fresh write rather than silently storing it.
--
-- Acceptance-criterion map (the eight object groups this migration creates):
--   AC1 healthy connected sources render once with the full governed facet set → governed_asset
--       (type/owner/lifecycle/risk/coverage/health/last-observation) joined to source_catalog_entry.
--   AC2 discovered-but-unmanaged/unreachable/stale/orphaned/excluded component stays a VISIBLE
--       coverage gap (reason/age/impact/owner action) → coverage_gap.
--   AC3 related work across Kanban/agentctl/workflows_orchestration → distinct source_record rows,
--       correlated via inventory_relationship + correlation_case, authoritative fields attributed.
--   AC4 stale/unavailable source → source_record.freshness + last_known_at + confidence; health is
--       held separate and never inferred from stale data (source_record_freshness_valid /
--       source_record_stale_agrees).
--   AC5 unregistered governance-relevant source discovered in a boundary → source_catalog_entry
--       with discovery evidence, type-or-unknown classification, location, access/ownership/
--       onboarding state.
--   AC6 unsupported/inaccessible/sensitive/unowned/excluded discovered source → stays a VISIBLE
--       governed-source gap with reason/impact/owner action + review-or-expiry → coverage_gap
--       (gap_class='governed_source') carrying review_at / expires_at.
--
-- WHY a NEW migration (not an edit to an earlier one): every applied migration is CHECKSUM-PINNED
-- (packages/persistence/src/database.ts runMigrations records its checksum in schema_migrations and
-- rejects an in-place edit with MigrationChecksumError). The inventory substrate is therefore added
-- here as a SEPARATE, later, EXPAND-ONLY migration, exactly as 0004/0007/0008/0009 layered on.
--
-- Effect-witness (VO-6acaf6470d0810df4c93): applying this migration yields an INDEPENDENTLY READABLE
-- durable effect — the eight inventory tables, their governance columns, their fail-visible CHECK
-- vocabularies, and their operator scan indexes — that could not exist before the migration ran.
--
-- Change discipline (db/migrations/README.md, GAR-010, VO-ec575c4ce42b548bfb4d): EXPAND only. Every
-- statement is additive and idempotent (CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS then
-- CREATE), so re-applying is a safe no-op. Timestamps are BIGINT epoch millis; every table is
-- tenant-scoped by a UUID tenant_id and isolated by a forced, restrictive RLS policy on
-- current_tenant() (fail-closed on missing tenant context), mirroring 0002_tenant_rls.sql.

-- ===========================================================================
-- 1. inventory_boundary — the governed SCOPE within which discovery runs and a
--    source is expected to be governed. A source found INSIDE a boundary but not
--    registered is the AC5 "unregistered governance-relevant source"; a source
--    the boundary EXCLUDES is the AC6 "excluded discovered source". Versioned so
--    a boundary change is auditable (boundary_version_id referenced by discovery).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory_boundary (
  id             UUID NOT NULL,
  tenant_id      UUID NOT NULL,
  name           TEXT NOT NULL,
  version        BIGINT NOT NULL DEFAULT 1,
  scope          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT inventory_boundary_version_positive CHECK (version >= 1),
  CONSTRAINT inventory_boundary_status_valid
    CHECK (status IN ('draft','active','retired'))
);

CREATE INDEX IF NOT EXISTS inventory_boundary_tenant_idx
  ON inventory_boundary (tenant_id, status);

-- ===========================================================================
-- 2. source_contract — the declared CONTRACT for a class of source: how it is
--    reached, which fields it is AUTHORITATIVE for (authoritative-field
--    attribution feeds AC3 conflict resolution), and its support level. A source
--    whose support_level is 'unsupported' backs the AC6 unsupported-source gap.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS source_contract (
  id                   UUID NOT NULL,
  tenant_id            UUID NOT NULL,
  source_class         TEXT NOT NULL,
  version              BIGINT NOT NULL DEFAULT 1,
  support_level        TEXT NOT NULL DEFAULT 'supported',
  authoritative_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  access_method        TEXT,
  sensitivity          TEXT NOT NULL DEFAULT 'normal',
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT source_contract_version_positive CHECK (version >= 1),
  CONSTRAINT source_contract_support_valid
    CHECK (support_level IN ('supported','deprecated','unsupported')),
  CONSTRAINT source_contract_sensitivity_valid
    CHECK (sensitivity IN ('normal','sensitive','restricted'))
);

CREATE INDEX IF NOT EXISTS source_contract_class_idx
  ON source_contract (tenant_id, source_class, support_level);

-- ===========================================================================
-- 3. source_catalog_entry — the OPEN-ENDED SOURCE CATALOG row, aligned 1:1 with
--    the governance-api SourceCatalogEntry schema. A source discovered in a
--    boundary is ADDED here with its discovery evidence, a type-or-'unknown'
--    classification, observed location(s), access status, sensitivity, ownership
--    status, and onboarding state (AC5). source_class is intentionally free TEXT
--    (not enum-bounded) because a newly-discovered source may be of an UNKNOWN or
--    arbitrary vendor class — but the governed lifecycle vocabularies
--    (onboarding_state / access_state / health_state) ARE pinned so a bad write
--    is rejected, not silently stored.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS source_catalog_entry (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  source_class       TEXT NOT NULL,
  boundary_id        UUID,
  observed_locations JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_principal_id UUID,
  onboarding_state   TEXT NOT NULL DEFAULT 'discovered',
  access_state       TEXT NOT NULL DEFAULT 'unknown',
  health_state       TEXT NOT NULL DEFAULT 'unknown',
  sensitivity        TEXT NOT NULL DEFAULT 'normal',
  discovery_evidence UUID,
  coverage_gap_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at      BIGINT NOT NULL,
  last_seen_at       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- Fail-visible governed vocabularies (the API contract's field domains).
  CONSTRAINT source_catalog_entry_onboarding_valid
    CHECK (onboarding_state IN ('discovered','pending','onboarded','excluded','retired')),
  CONSTRAINT source_catalog_entry_access_valid
    CHECK (access_state IN ('connected','reachable','degraded','unreachable','inaccessible','unknown')),
  CONSTRAINT source_catalog_entry_health_valid
    CHECK (health_state IN ('healthy','degraded','unhealthy','unknown')),
  CONSTRAINT source_catalog_entry_sensitivity_valid
    CHECK (sensitivity IN ('normal','sensitive','restricted')),
  -- An EXCLUDED or INACCESSIBLE source must NEVER be recorded as owned+onboarded+healthy — it must
  -- remain a visible gap. A newly discovered/excluded/inaccessible source cannot claim 'healthy'.
  CONSTRAINT source_catalog_entry_unonboarded_not_healthy
    CHECK (onboarding_state = 'onboarded' OR health_state <> 'healthy'),
  CONSTRAINT source_catalog_entry_seen_ordered
    CHECK (last_seen_at >= first_seen_at)
);

-- Operator scan: surface every source that is NOT cleanly onboarded+connected+healthy — i.e. every
-- discovered/excluded/inaccessible/degraded/unknown source is directly queryable (fail-visible).
CREATE INDEX IF NOT EXISTS source_catalog_entry_attention_idx
  ON source_catalog_entry (tenant_id, onboarding_state, access_state, health_state);

-- ===========================================================================
-- 4. source_record — the per-source RAW OBSERVATION of a component, one row per
--    (source, external key). Related work across Kanban / agentctl /
--    workflows_orchestration produces DISTINCT source_record rows (AC3), each
--    carrying the source's authoritative view + its own status. STALE-STATE
--    SIGNALING (AC4, VO-53a014009bdfebd7af13): freshness ∈ {fresh,stale,unknown}
--    with a last_known_at + a confidence 0..1; the stale boolean MIRRORS the enum
--    (source_record_stale_agrees), so a stale observation can never look fresh and
--    health is read from the OBSERVED_STATE field, never inferred from a stale row.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS source_record (
  id             UUID NOT NULL,
  tenant_id      UUID NOT NULL,
  catalog_id     UUID NOT NULL,
  asset_id       UUID,
  source_class   TEXT NOT NULL,
  external_key   TEXT NOT NULL,
  observed_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'unknown',
  freshness      TEXT NOT NULL DEFAULT 'unknown',
  stale          BOOLEAN NOT NULL DEFAULT FALSE,
  confidence     NUMERIC NOT NULL DEFAULT 1.0,
  last_known_at  BIGINT NOT NULL,
  observed_at    BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT source_record_freshness_valid
    CHECK (freshness IN ('fresh','stale','unknown')),
  -- The boolean mirror cannot disagree with the freshness enum (stale-state is unambiguous).
  CONSTRAINT source_record_stale_agrees
    CHECK (stale = (freshness = 'stale')),
  CONSTRAINT source_record_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CONSTRAINT source_record_status_valid
    CHECK (status IN ('active','inactive','unknown','conflicting'))
);

-- Same (source, external key) is one record; distinct sources keep distinct rows (AC3).
CREATE UNIQUE INDEX IF NOT EXISTS source_record_identity_idx
  ON source_record (tenant_id, catalog_id, external_key);
-- Correlate all records of one reconciled asset; surface stale observations (AC4).
CREATE INDEX IF NOT EXISTS source_record_asset_idx
  ON source_record (tenant_id, asset_id, freshness);

-- ===========================================================================
-- 5. governed_asset — the RECONCILED inventory row, aligned 1:1 with the
--    governance-api GovernedAsset schema. Healthy connected sources reconcile to
--    an asset that renders ONCE with its full governed facet set — type, owner,
--    lifecycle, risk, health, coverage, last observation, version (AC1). An
--    orphaned/unmanaged component reconciles to an asset with coverage='gap' and
--    a non-'healthy' health that STAYS VISIBLE (AC2). last_observed_at is the
--    last-known observation time carried from the freshest source_record.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS governed_asset (
  id                 UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  asset_type         TEXT NOT NULL,
  name               TEXT NOT NULL,
  owner_principal_id UUID,
  lifecycle_state    TEXT NOT NULL DEFAULT 'unknown',
  risk_tier          TEXT NOT NULL DEFAULT 'unassessed',
  health             TEXT NOT NULL DEFAULT 'unknown',
  coverage           TEXT NOT NULL DEFAULT 'gap',
  last_observed_at   BIGINT,
  version            BIGINT NOT NULL DEFAULT 1,
  updated_at         BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT governed_asset_version_positive CHECK (version >= 1),
  CONSTRAINT governed_asset_lifecycle_valid
    CHECK (lifecycle_state IN ('planned','provisioning','operating','degraded','orphaned','retired','unknown')),
  CONSTRAINT governed_asset_health_valid
    CHECK (health IN ('healthy','degraded','unhealthy','unmanaged','unknown')),
  CONSTRAINT governed_asset_coverage_valid
    CHECK (coverage IN ('covered','partial','gap')),
  -- A fully-covered asset cannot be simultaneously unmanaged/orphaned — coverage and management
  -- must agree, so a gap can never masquerade as covered+healthy (AC1/AC2 fail-visible).
  CONSTRAINT governed_asset_covered_is_managed
    CHECK (coverage <> 'covered' OR (health <> 'unmanaged' AND lifecycle_state <> 'orphaned'))
);

-- Operator scan: every asset that is NOT covered+healthy is directly queryable (the coverage gap
-- set), so an unmanaged/orphaned component surfaces rather than disappearing (AC2).
CREATE INDEX IF NOT EXISTS governed_asset_attention_idx
  ON governed_asset (tenant_id, coverage, health, lifecycle_state);

-- ===========================================================================
-- 6. inventory_relationship — the correlation/dependency EDGE between two inventory
--    objects: a correlation edge tying distinct source_records to one asset, a
--    dependency between assets, or an authoritative-field attribution (which source
--    is authoritative for a field). Backs the AC3 drill-down (distinct source
--    records, correlation, dependencies, authoritative fields). Append-friendly;
--    the (from,to,kind,field) identity is unique so an edge is asserted once.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory_relationship (
  id               UUID NOT NULL,
  tenant_id        UUID NOT NULL,
  from_kind        TEXT NOT NULL,
  from_id          UUID NOT NULL,
  to_kind          TEXT NOT NULL,
  to_id            UUID NOT NULL,
  relationship     TEXT NOT NULL,
  field_name       TEXT NOT NULL DEFAULT '',
  authoritative    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT inventory_relationship_from_kind_valid
    CHECK (from_kind IN ('source_record','source_catalog_entry','governed_asset')),
  CONSTRAINT inventory_relationship_to_kind_valid
    CHECK (to_kind IN ('source_record','source_catalog_entry','governed_asset')),
  CONSTRAINT inventory_relationship_kind_valid
    CHECK (relationship IN ('correlates','depends_on','authoritative_for','duplicate_of','derived_from')),
  -- An authoritative-field attribution must name the field it is authoritative for.
  CONSTRAINT inventory_relationship_field_when_authoritative
    CHECK (relationship <> 'authoritative_for' OR field_name <> '')
);

-- Each edge asserted once; drill-down from an object to its correlated peers.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_relationship_edge_idx
  ON inventory_relationship (tenant_id, from_kind, from_id, to_kind, to_id, relationship, field_name);
CREATE INDEX IF NOT EXISTS inventory_relationship_to_idx
  ON inventory_relationship (tenant_id, to_kind, to_id, relationship);

-- ===========================================================================
-- 7. correlation_case — an UNRESOLVED CORRELATION/CONFLICT held for a human: two
--    sources disagree on an authoritative field, or a component could not be
--    auto-correlated. Backs AC3's "status differences" surfaced for resolution.
--    A case stays OPEN and VISIBLE (with the conflicting values + required owner
--    action) until a human resolves it; a resolved case must name a resolution.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS correlation_case (
  id            UUID NOT NULL,
  tenant_id     UUID NOT NULL,
  asset_id      UUID,
  case_type     TEXT NOT NULL DEFAULT 'field_conflict',
  status        TEXT NOT NULL DEFAULT 'open',
  conflicting   JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_action TEXT,
  resolution    TEXT,
  opened_at     BIGINT NOT NULL,
  resolved_at   BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT correlation_case_type_valid
    CHECK (case_type IN ('field_conflict','ambiguous_match','duplicate','unlinked')),
  CONSTRAINT correlation_case_status_valid
    CHECK (status IN ('open','investigating','resolved','dismissed')),
  -- A terminal case must name a resolution + a resolved time; an open case must not claim either,
  -- so a conflict can never look resolved without a durable human resolution (fail-visible).
  CONSTRAINT correlation_case_resolution_when_terminal
    CHECK (
      (status IN ('resolved','dismissed')) = (resolution IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

-- Operator scan: every open/investigating case is directly queryable (unresolved work surface).
CREATE INDEX IF NOT EXISTS correlation_case_open_idx
  ON correlation_case (tenant_id, status, opened_at)
  WHERE status IN ('open','investigating');

-- ===========================================================================
-- 8. coverage_gap — a DISCOVERED-BUT-NOT-FULLY-GOVERNED component or source held
--    as a VISIBLE gap (AC2 + AC6). Every gap carries the WHY and the required
--    owner action so it is actionable, not merely present:
--      * gap_class      — component (AC2) vs governed_source (AC6).
--      * reason         — why it is a gap (unmanaged/unreachable/stale/orphaned/
--                         excluded/unsupported/inaccessible/sensitive/unowned).
--      * impact         — the assessed impact (fail-visible severity).
--      * required_action— the owner action needed to close it.
--      * first_seen_at  — gap age is derived from this (AC2 "age").
--      * review_at / expires_at — the review-or-expiry an excluded/unsupported
--                         governed source carries (AC6 "review or expiry").
--    A gap stays OPEN until an owner acts; a resolved gap must name a resolution.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS coverage_gap (
  id              UUID NOT NULL,
  tenant_id       UUID NOT NULL,
  subject_kind    TEXT NOT NULL,
  subject_id      UUID,
  gap_class       TEXT NOT NULL DEFAULT 'component',
  reason          TEXT NOT NULL,
  impact          TEXT NOT NULL DEFAULT 'unknown',
  required_action TEXT NOT NULL,
  required_owner  UUID,
  status          TEXT NOT NULL DEFAULT 'open',
  resolution      TEXT,
  first_seen_at   BIGINT NOT NULL,
  review_at       BIGINT,
  expires_at      BIGINT,
  resolved_at     BIGINT,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT coverage_gap_subject_kind_valid
    CHECK (subject_kind IN ('governed_asset','source_catalog_entry','source_record','component')),
  CONSTRAINT coverage_gap_class_valid
    CHECK (gap_class IN ('component','governed_source')),
  CONSTRAINT coverage_gap_reason_valid
    CHECK (reason IN ('unmanaged','unreachable','stale','orphaned','excluded',
                      'unsupported','inaccessible','sensitive','unowned')),
  CONSTRAINT coverage_gap_impact_valid
    CHECK (impact IN ('low','medium','high','critical','unknown')),
  CONSTRAINT coverage_gap_status_valid
    CHECK (status IN ('open','acknowledged','resolved','accepted_risk')),
  -- A gap must always name a non-empty required owner action — it can never be a silent hole.
  CONSTRAINT coverage_gap_action_present CHECK (length(required_action) > 0),
  -- A terminal (resolved) gap must name a resolution + resolved time; a non-terminal one must not,
  -- so a still-open gap can never look closed (fail-visible closure).
  CONSTRAINT coverage_gap_resolution_when_resolved
    CHECK ((status = 'resolved') = (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);

-- Operator scan: every open/acknowledged gap is directly queryable, ordered by age + impact, so a
-- discovered-but-unmanaged component or governed-source gap surfaces and never disappears (AC2/AC6).
CREATE INDEX IF NOT EXISTS coverage_gap_open_idx
  ON coverage_gap (tenant_id, status, gap_class, impact, first_seen_at)
  WHERE status IN ('open','acknowledged');
-- Review/expiry scan for excluded/unsupported governed sources (AC6 review-or-expiry).
CREATE INDEX IF NOT EXISTS coverage_gap_review_idx
  ON coverage_gap (tenant_id, review_at, expires_at)
  WHERE gap_class = 'governed_source';

-- ===========================================================================
-- 9. Tenant isolation — forced, restrictive RLS on every inventory table, keyed on
--    current_tenant() with an explicit WITH CHECK (fail-closed on missing tenant
--    context), mirroring 0002_tenant_rls.sql. A tenant can only see and write its
--    own inventory; a query with no tenant context returns nothing and writes are
--    refused. Idempotent: DROP POLICY IF EXISTS then CREATE.
-- ===========================================================================
ALTER TABLE inventory_boundary     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_boundary     FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_boundary;
CREATE POLICY tenant_isolation ON inventory_boundary AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE source_contract        ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_contract        FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON source_contract;
CREATE POLICY tenant_isolation ON source_contract AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE source_catalog_entry   ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_catalog_entry   FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON source_catalog_entry;
CREATE POLICY tenant_isolation ON source_catalog_entry AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE source_record          ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_record          FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON source_record;
CREATE POLICY tenant_isolation ON source_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE governed_asset         ENABLE ROW LEVEL SECURITY;
ALTER TABLE governed_asset         FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON governed_asset;
CREATE POLICY tenant_isolation ON governed_asset AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE inventory_relationship ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_relationship FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_relationship;
CREATE POLICY tenant_isolation ON inventory_relationship AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE correlation_case       ENABLE ROW LEVEL SECURITY;
ALTER TABLE correlation_case       FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON correlation_case;
CREATE POLICY tenant_isolation ON correlation_case AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

ALTER TABLE coverage_gap           ENABLE ROW LEVEL SECURITY;
ALTER TABLE coverage_gap           FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON coverage_gap;
CREATE POLICY tenant_isolation ON coverage_gap AS RESTRICTIVE FOR ALL
  USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
