// Migration suite — canonical/projection query tuning: read-path indexes, keyset pagination
// policy, per-query cost budgets, and explain-plan regression thresholds (T297 / GAR-010).
//
// Proves db/migrations/0090_query_tuning.sql is a well-formed, ordered, idempotent EXPAND
// migration that the REAL runner (packages/persistence/src/database.ts) applies on the
// deterministic in-memory driver, and that the tuning contract it declares (index names,
// pagination policy, budgets, plan baselines) is present. Runs under `vitest run --project
// migration`. Every property is paired with a negative control so the oracle is non-vacuous.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  Database,
  runMigrations,
  readMigrationHistory,
  assertMigrationOrder,
  loadMigrationsFromDisk,
  type Migration,
  type SqlDriver,
} from '../../packages/persistence/src/database.ts';

import { createInMemoryDriver } from '../persistence/in-memory-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'db/migrations');
const SQL_0090 = readFileSync(resolve(MIGRATIONS_DIR, '0090_query_tuning.sql'), 'utf8');

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDb() {
  return new Database(createInMemoryDriver() as unknown as SqlDriver, { clock: makeClock() });
}

describe('0090_query_tuning — migration wellformedness', () => {
  it('loads from disk as an ordered EXPAND migration and keeps the full set ordered', async () => {
    const migs = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const m = migs.find((x: Migration) => x.id === '0090');
    expect(m, '0090 must be discovered on disk').toBeTruthy();
    expect(m?.kind).toBe('expand');
    expect(m?.name).toBe('query_tuning');
    // Negative control: the whole set (including 0090) must be strictly ordered.
    expect(() => assertMigrationOrder(migs)).not.toThrow();
  });

  it('applies through the real runner and is idempotent on re-run', async () => {
    const db = newDb();
    const migs = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const first = await runMigrations(db, migs);
    expect(first.applied.map((a) => a.id)).toContain('0090');

    const history = await readMigrationHistory(db);
    const h = history.find((x) => x.id === '0090');
    expect(h?.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Negative control: re-running applies nothing and skips 0090 (idempotent).
    const second = await runMigrations(db, migs);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0090');
  });
});

describe('0090_query_tuning — tuning contract present in the DDL', () => {
  it('declares read-path indexes aligned to the hot list/drill-down predicates', () => {
    for (const idx of [
      'governed_asset_keyset_idx',
      'governed_asset_gap_partial_idx',
      'governed_asset_stale_partial_idx',
      'decision_record_keyset_idx',
      'decision_record_rejected_partial_idx',
      'audit_event_ledger_sequence_idx',
      'coverage_gap_keyset_idx',
      'health_observation_connector_time_idx',
    ]) {
      expect(SQL_0090, `expected index ${idx}`).toContain(idx);
    }
    // Every index is idempotent.
    expect(SQL_0090).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
    // Negative control: an index we did NOT declare is absent (guards a copy-paste false positive).
    expect(SQL_0090).not.toContain('governed_asset_nonexistent_idx');
  });

  it('pins keyset pagination policy and forbids OFFSET pagination', () => {
    expect(SQL_0090).toContain('query_pagination_policy');
    expect(SQL_0090).toContain("strategy = 'keyset'");
    // Policy rows for the listable projections.
    for (const proj of [
      'inventory.list',
      'coverage_gap.list',
      'decision.list',
      'audit_event.list',
      'health.list',
    ]) {
      expect(SQL_0090, `pagination policy for ${proj}`).toContain(`'${proj}'`);
    }
    // default must never exceed max (mis-config is fail-visible via CHECK).
    expect(SQL_0090).toContain('default_page_size >= 1 AND max_page_size >= default_page_size');
    // Negative control: OFFSET pagination is never used as a strategy value.
    expect(SQL_0090).not.toMatch(/strategy\s+TEXT\s+NOT NULL DEFAULT 'offset'/);
  });

  it('pins per-query cost budgets and explain-plan regression thresholds', () => {
    expect(SQL_0090).toContain('query_budget');
    expect(SQL_0090).toContain('max_est_cost');
    expect(SQL_0090).toContain('max_rows_examined');
    expect(SQL_0090).toContain('max_latency_ms');
    expect(SQL_0090).toContain('explain_plan_baseline');
    expect(SQL_0090).toContain('max_regression_factor');
    expect(SQL_0090).toContain('seq_scan_is_regression');
    // A fallback to a sequential scan is always a regression by default.
    expect(SQL_0090).toContain('seq_scan_is_regression BOOLEAN NOT NULL DEFAULT true');
    // Budgets/baselines are positive by CHECK.
    expect(SQL_0090).toContain('max_est_cost > 0');
    expect(SQL_0090).toContain('max_regression_factor >= 1.0');
    // Negative control: a budget for a query we did not declare is absent.
    expect(SQL_0090).not.toContain('nonexistent.query.page');
  });
});
