-- 0090_query_tuning — CANONICAL / PROJECTION QUERY TUNING for the finished governance control
-- plane: read-path indexes, keyset (cursor) pagination support, per-query cost budgets, and
-- explain-plan regression thresholds (Phase 10 / T297 / GAR-010 — Polish and Continuous
-- Improvement; performance leg of NFR-001..NFR-004 and the VO-6acaf6470d0810df4c93 fail-visible
-- operating picture).
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Every earlier migration (0001..0060) created the canonical write model and its constraints.
-- With the increment feature-complete, Phase 10 hardens the READ path so the operating picture
-- (inventory, coverage gaps, decisions, audit ledger, health, projector state) stays fast and,
-- crucially, stays FAIL-VISIBLE under growth: a query that would silently degrade into a
-- sequential scan or an unbounded fetch is turned into a VISIBLE budget/threshold breach instead
-- of a slow-but-green response.
--
-- Four disciplines, all EXPAND-only and idempotent (CREATE ... IF NOT EXISTS / DROP ... IF EXISTS
-- then CREATE), so re-applying is a safe no-op and this migration never rewrites a prior object:
--
--   1. READ-PATH INDEXES. Composite / partial indexes aligned to the exact predicate + sort of the
--      hot list and drill-down queries (tenant-scoped, filtered by lifecycle/health/coverage/
--      status, ordered by the keyset sort key). Partial indexes narrow the hottest "unhealthy /
--      open / gap" working sets so the index the planner uses is small and hot.
--
--   2. KEYSET (CURSOR) PAGINATION. `query_pagination_policy` pins, per listable projection, the
--      canonical ORDER-BY key, the maximum page size, and the default page size, so every list
--      endpoint paginates by a stable keyset cursor (WHERE (sort_key) > (:cursor) ORDER BY sort_key
--      LIMIT :n) instead of OFFSET. OFFSET pagination is explicitly forbidden by policy because its
--      cost grows with the offset; keyset cost is constant. A CHECK makes an over-large page size
--      impossible to record.
--
--   3. QUERY BUDGETS. `query_budget` pins a per-named-query cost ceiling (max estimated cost, max
--      rows examined, max latency ms) that the planner-guard (packages/persistence explain-plan
--      check) compares an EXPLAIN estimate against. A query whose plan exceeds its budget is a
--      VISIBLE regression, never a silent slow path.
--
--   4. EXPLAIN-PLAN REGRESSION THRESHOLDS. `explain_plan_baseline` stores the approved plan shape
--      (scan type + estimated cost) captured for each hot query, plus the allowed regression factor.
--      A CI/ops check re-runs EXPLAIN and FAILS when the new plan's cost exceeds
--      baseline_cost * max_regression_factor, or when a plan that was index-backed regresses to a
--      sequential scan. This turns "the query got slower" into a gate, not a production surprise.
--
-- CONVENTIONS (identical to 0010/0020/0030/0040/0050/0060): EXPAND-only + idempotent; timestamps
-- are BIGINT epoch millis; tenant-scoped tables carry a UUID tenant_id and RLS is enabled/forced
-- with a RESTRICTIVE tenant_isolation policy. Platform-scoped tuning catalog tables
-- (query_pagination_policy / query_budget / explain_plan_baseline) are governance metadata, not
-- tenant data, so they are NOT tenant-scoped.

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1. READ-PATH INDEXES on the canonical / projection tables.
--    Each index is aligned to a real hot query's predicate + sort. IF NOT EXISTS → idempotent.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- Inventory list: tenant-scoped, ordered by the keyset sort key (updated_at, id).
CREATE INDEX IF NOT EXISTS governed_asset_keyset_idx
  ON governed_asset (tenant_id, updated_at DESC, id DESC);

-- Inventory filtered lists (by lifecycle / health / coverage) — the officer's most common facets.
CREATE INDEX IF NOT EXISTS governed_asset_lifecycle_idx
  ON governed_asset (tenant_id, lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS governed_asset_health_idx
  ON governed_asset (tenant_id, health, updated_at DESC);

-- Coverage-gap working set: the "NOT covered" partial index keeps the hottest gap query tiny.
CREATE INDEX IF NOT EXISTS governed_asset_gap_partial_idx
  ON governed_asset (tenant_id, updated_at DESC)
  WHERE coverage <> 'covered';

-- Stale-observation working set (last_observed_at NULL or old): fail-visible staleness scan.
CREATE INDEX IF NOT EXISTS governed_asset_stale_partial_idx
  ON governed_asset (tenant_id, last_observed_at)
  WHERE last_observed_at IS NULL OR health = 'unknown';

-- Decision ledger list: tenant-scoped, newest-first keyset on (decided_at, id).
CREATE INDEX IF NOT EXISTS decision_record_keyset_idx
  ON decision_record (tenant_id, decided_at DESC, id DESC);
-- Rejected-decision review working set.
CREATE INDEX IF NOT EXISTS decision_record_rejected_partial_idx
  ON decision_record (tenant_id, decided_at DESC)
  WHERE status = 'rejected';
-- Per-actor / per-decision drill-down.
CREATE INDEX IF NOT EXISTS decision_record_actor_idx
  ON decision_record (tenant_id, actor_principal_id, decided_at DESC);

-- Audit ledger: ordered scan by (tenant, ledger, sequence) is the verification read path.
CREATE INDEX IF NOT EXISTS audit_event_ledger_sequence_idx
  ON audit_event (tenant_id, ledger_id, sequence);
-- Audit event-type / time drill-down for the audit console.
CREATE INDEX IF NOT EXISTS audit_event_type_time_idx
  ON audit_event (tenant_id, event_type, sequence DESC);

-- Coverage gaps projection list. `first_seen_at` is the coverage_gap age/sort key.
CREATE INDEX IF NOT EXISTS coverage_gap_keyset_idx
  ON coverage_gap (tenant_id, first_seen_at DESC, id DESC);
-- Open-gap working set (open / acknowledged only) keeps the officer's hot list tiny.
CREATE INDEX IF NOT EXISTS coverage_gap_open_partial_idx
  ON coverage_gap (tenant_id, first_seen_at DESC)
  WHERE status IN ('open', 'acknowledged');

-- Health observations: freshness/lag lookups per connector, newest-first.
CREATE INDEX IF NOT EXISTS health_observation_connector_time_idx
  ON health_observation (tenant_id, connector_id, observed_at DESC);
-- Stale/degraded health working set — fail-visible surfacing of non-fresh sources.
CREATE INDEX IF NOT EXISTS health_observation_stale_partial_idx
  ON health_observation (tenant_id, observed_at DESC)
  WHERE freshness_state <> 'fresh' OR liveness_state <> 'live';

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 2. KEYSET (CURSOR) PAGINATION policy — one row per listable projection.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS query_pagination_policy (
  projection        TEXT PRIMARY KEY,       -- logical list name, e.g. 'inventory.list'
  sort_key          TEXT NOT NULL,          -- canonical keyset ORDER BY, e.g. '(updated_at DESC, id DESC)'
  strategy          TEXT NOT NULL DEFAULT 'keyset',
  default_page_size INTEGER NOT NULL,
  max_page_size     INTEGER NOT NULL,
  updated_at        BIGINT NOT NULL,
  -- OFFSET pagination is forbidden: its cost grows with the offset. Only keyset is permitted.
  CONSTRAINT query_pagination_strategy_keyset
    CHECK (strategy = 'keyset'),
  -- Page sizes must be sane and the default must never exceed the max (fail-visible mis-config).
  CONSTRAINT query_pagination_sizes_valid
    CHECK (default_page_size >= 1 AND max_page_size >= default_page_size AND max_page_size <= 1000)
);

INSERT INTO query_pagination_policy (projection, sort_key, strategy, default_page_size, max_page_size, updated_at) VALUES
  ('inventory.list',      '(updated_at DESC, id DESC)',           'keyset', 50,  200, 0),
  ('coverage_gap.list',   '(first_seen_at DESC, id DESC)',        'keyset', 50,  200, 0),
  ('decision.list',       '(decided_at DESC, id DESC)',           'keyset', 50,  200, 0),
  ('audit_event.list',    '(sequence ASC)',                       'keyset', 100, 500, 0),
  ('health.list',         '(observed_at DESC, connector_id ASC)', 'keyset', 50,  200, 0)
ON CONFLICT (projection) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 3. QUERY BUDGETS — a per-named-query cost/rows/latency ceiling the planner-guard enforces.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS query_budget (
  query_name        TEXT PRIMARY KEY,       -- e.g. 'inventory.list.page'
  max_est_cost      NUMERIC NOT NULL,       -- EXPLAIN total estimated cost ceiling
  max_rows_examined BIGINT  NOT NULL,       -- planner rows-estimate ceiling
  max_latency_ms    INTEGER NOT NULL,       -- p99 wall-latency objective
  updated_at        BIGINT  NOT NULL,
  CONSTRAINT query_budget_positive
    CHECK (max_est_cost > 0 AND max_rows_examined > 0 AND max_latency_ms > 0)
);

INSERT INTO query_budget (query_name, max_est_cost, max_rows_examined, max_latency_ms, updated_at) VALUES
  ('inventory.list.page',        250.0,  200,   150, 0),
  ('inventory.gap.page',         200.0,  200,   150, 0),
  ('decision.list.page',         250.0,  200,   150, 0),
  ('decision.rejected.page',     200.0,  200,   150, 0),
  ('audit_event.verify.scan',    500.0,  500,   300, 0),
  ('health.by_source.page',      150.0,  200,   120, 0)
ON CONFLICT (query_name) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 4. EXPLAIN-PLAN REGRESSION THRESHOLDS — approved plan shape + allowed regression factor.
--    A CI/ops check re-runs EXPLAIN and FAILS if the new cost exceeds baseline * factor, or if an
--    index-backed plan regresses to a sequential scan.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS explain_plan_baseline (
  query_name             TEXT PRIMARY KEY,   -- matches query_budget.query_name
  expected_scan          TEXT NOT NULL,      -- e.g. 'index-scan' | 'index-only-scan' | 'bitmap'
  baseline_cost          NUMERIC NOT NULL,   -- EXPLAIN total cost captured against the tuned schema
  max_regression_factor  NUMERIC NOT NULL,   -- fail if new_cost > baseline_cost * factor
  seq_scan_is_regression BOOLEAN NOT NULL DEFAULT true,  -- a fallback to seq scan is always a fail
  captured_at            BIGINT NOT NULL,
  CONSTRAINT explain_plan_baseline_positive
    CHECK (baseline_cost > 0 AND max_regression_factor >= 1.0),
  CONSTRAINT explain_plan_baseline_scan_valid
    CHECK (expected_scan IN ('index-scan','index-only-scan','bitmap-heap-scan','ordered-index-scan'))
);

INSERT INTO explain_plan_baseline (query_name, expected_scan, baseline_cost, max_regression_factor, seq_scan_is_regression, captured_at) VALUES
  ('inventory.list.page',     'index-scan',         42.0,  1.5, true, 0),
  ('inventory.gap.page',      'index-scan',         30.0,  1.5, true, 0),
  ('decision.list.page',      'index-scan',         44.0,  1.5, true, 0),
  ('decision.rejected.page',  'index-scan',         28.0,  1.5, true, 0),
  ('audit_event.verify.scan', 'ordered-index-scan', 90.0,  1.5, true, 0),
  ('health.by_source.page',   'index-scan',         26.0,  1.5, true, 0)
ON CONFLICT (query_name) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY. The tuning-catalog tables above are platform-scoped governance metadata
-- (no tenant_id), so no RLS applies to them. This migration adds NO tenant-scoped tables — it
-- only adds indexes to already-RLS-protected canonical tables — so there are no new tenant
-- isolation policies to declare. (Indexes inherit the base table's RLS.)
-- ────────────────────────────────────────────────────────────────────────────────────────────
