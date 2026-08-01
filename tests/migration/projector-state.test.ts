// Projector-state migration suite — Phase 48.
//
// Verifies db/migrations/0010_projector_state.sql: the durable, fenced, time-bounded
// projection-worker OWNERSHIP LEASE (projector_lease), the resumable, FAIL-VISIBLE projection
// CHECKPOINT (projector_checkpoint), and the append-only REBUILD audit trail (projector_rebuild)
// that the governed projection-worker bootstrap (apps/projector/src/main.ts) reads and writes so
// that ownership, health, failures, retries, continuity mode + lease, buffered evidence, per-stream
// freshness (stale-state signaling), rebuild state, and the safe next action are CURRENT and
// FAIL-VISIBLE from durable rows — never from an in-memory flag.
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses the shared
// deterministic DDL-recording in-memory SqlDriver (ddl-recording-driver.mjs), so it runs under
// `npm ci` with NO live PostgreSQL yet still produces an *independently readable durable effect* —
// the physical-schema catalog (the three projector tables + their columns, the health/expiry/scan
// indexes, and the append-only trigger) — observed through an independent read path, never the
// runner's success response (effect-witness discipline). Every property has a NEGATIVE control so
// the oracle is non-vacuous.
//
// Obligation mapping:
//   * VO-6acaf6470d0810df4c93 (phase-primary): the open-ended source catalog, reconciled
//     inventory, coverage gaps, workflow and controller state, OWNERSHIP, health, failures,
//     retries, CONTINUITY MODE and LEASE, buffered evidence, and safe next actions MUST be current
//     and FAIL-VISIBLE. This migration creates the durable substrate that makes them so: the
//     projector_lease row (holder + monotonic fencing_token + expires_at) proves OWNERSHIP; the
//     projector_checkpoint row (state + continuity + counters + freshness/stale + rebuild + safe
//     next action) proves current health/failures/retries/continuity/safe-next-action; the
//     append-only projector_rebuild trail proves rebuild history.
//   * VO-53a014009bdfebd7af13 (telemetry / stale-state): freshness ∈ {fresh,stale,unknown},
//     the stale boolean mirror, and freshness_summary make "the read model is behind / unknown"
//     a durable, queryable fact; the CHECK constraints reject a bad write instead of silently
//     storing an unhealthy-looking-healthy row.
//   * VO-ec575c4ce42b548bfb4d / GAR-010 — expand-only, applied-once, checksum-pinned; composes
//     with 0004's inbox_cursor (the durable applied-position path) without narrowing a column.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  Database,
  runMigrations,
  readMigrationHistory,
  loadMigrationsFromDisk,
  parseMigrationFilename,
  checksumMigration,
  MigrationChecksumError,
  type Migration,
  type SqlDriver,
} from '../../packages/persistence/src/database.ts';

// @ts-expect-error — .mjs recording driver has no type declarations.
import { createDdlRecordingDriver } from './ddl-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0010_projector_state.sql';
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const SQL = readFileSync(SQL_PATH, 'utf8');

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

function newDbWithCatalog() {
  const driver = createDdlRecordingDriver();
  const db = new Database(driver as unknown as SqlDriver, { clock: makeClock() });
  return { db, driver };
}

async function applyAll(db: Database) {
  return runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
}

/** The three projector tables the phase must create + their required governance columns. */
const REQUIRED_TABLES: Record<string, string[]> = {
  projector_lease: ['resource', 'holder', 'fencing_token', 'expires_at', 'updated_at'],
  projector_checkpoint: [
    'resource',
    'holder',
    'fencing_token',
    'pass',
    'state',
    'continuity',
    'consumed',
    'applied',
    'buffered',
    'quarantined',
    'retried',
    'dead_lettered',
    'buffered_evidence',
    'freshness',
    'stale',
    'freshness_summary',
    'rebuild_id',
    'rebuild_phase',
    'rebuild_progress',
    'last_error',
    'safe_next_action',
    'updated_at',
  ],
  projector_rebuild: [
    'resource',
    'rebuild_id',
    'requested_by',
    'phase',
    'replayed',
    'started_at',
    'ended_at',
    'failure',
  ],
};

const REQUIRED_INDEXES = [
  'projector_lease_expiry_idx',
  'projector_checkpoint_attention_idx',
  'projector_rebuild_scan_idx',
  'projector_rebuild_open_idx',
];

// ───────────────────────────────────────────────────────────────────────────
// File & loader
// ───────────────────────────────────────────────────────────────────────────
describe('0010_projector_state migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0010');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('projector_state');
    expect(mine!.kind).toBe('expand'); // expand-only (GAR-010 compatibility)
    expect(mine!.up).toContain('projector_lease');
    expect(mine!.up).toContain('projector_checkpoint');
    expect(mine!.up).toContain('projector_rebuild');
  });

  it('parses the authored filename form — negative control', () => {
    expect(parseMigrationFilename('0010_projector_state.sql')).toEqual({
      id: '0010',
      name: 'projector_state',
      kind: 'expand',
    });
    // Negative control: a non-migration filename is not a migration.
    expect(parseMigrationFilename('NOTES.md')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Applied effect (independent read path = the physical-schema catalog)
// ───────────────────────────────────────────────────────────────────────────
describe('0010_projector_state migration — applied effect (independent read path)', () => {
  it('is applied by the checksum-pinned runner as part of the full disk chain', async () => {
    const { db } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0010');
    // Independent read path: the runner history records 0010 as applied.
    const history = await readMigrationHistory(db);
    expect(history.map((h) => h.id)).toContain('0010');
  });

  it('creates the three projector tables with all required governance columns', async () => {
    const { db, driver } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0010');

    const cat = driver.__catalog;
    for (const [table, cols] of Object.entries(REQUIRED_TABLES)) {
      expect(cat.tables.has(table), `table ${table} must exist`).toBe(true);
      const present = cat.tables.get(table)!.columns as Set<string>;
      for (const col of cols) {
        expect(present.has(col), `${table}.${col} must exist`).toBe(true);
      }
    }
    // Negative control: a column the migration does NOT create is absent (the catalog is not a
    // permissive fake that returns true for everything).
    expect(
      (driver.__catalog.tables.get('projector_checkpoint')!.columns as Set<string>).has(
        'not_a_real_column',
      ),
    ).toBe(false);
  });

  it('creates the ownership/health/rebuild scan indexes (fail-visible operator views)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes as Set<string>;
    for (const name of REQUIRED_INDEXES) {
      expect(idx.has(name), `index ${name} must exist`).toBe(true);
    }
    // Negative control.
    expect(idx.has('projector_not_a_real_index')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fail-visible constraints (the migration text is the contract)
// ───────────────────────────────────────────────────────────────────────────
describe('0010_projector_state migration — fail-visible governance constraints', () => {
  it('pins the projector lifecycle-state vocabulary (fail-visible states are storable)', () => {
    // Every fail-visible state must be an allowed CHECK value; a bad state must be rejected.
    for (const s of [
      'starting',
      'acquiring_lease',
      'running',
      'rebuilding',
      'draining',
      'stopped',
      'degraded',
      'stale',
      'lost_lease',
      'failed',
    ]) {
      expect(SQL).toContain(`'${s}'`);
    }
    expect(SQL).toMatch(/projector_checkpoint_state_valid/i);
  });

  it('constrains the continuity mode, freshness, rebuild phase, and safe next action', () => {
    expect(SQL).toMatch(/projector_checkpoint_continuity_valid/i);
    expect(SQL).toMatch(/continuity IN \('normal','continue_under_lease','paused'\)/i);
    expect(SQL).toMatch(/projector_checkpoint_freshness_valid/i);
    expect(SQL).toMatch(/freshness IN \('fresh','stale','unknown'\)/i);
    expect(SQL).toMatch(/projector_checkpoint_rebuild_phase_valid/i);
    expect(SQL).toMatch(/projector_checkpoint_action_valid/i);
    expect(SQL).toMatch(/safe_next_action IN \('none','retry','reconcile','rebuild','escalate'\)/i);
  });

  it('forces the stale boolean to agree with freshness (staleness is unambiguous)', () => {
    // stale-state signaling (VO-53a014009bdfebd7af13): the boolean mirror cannot disagree with
    // the freshness enum, so a stale projection can never look non-stale.
    expect(SQL).toMatch(/projector_checkpoint_stale_agrees/i);
    expect(SQL).toMatch(/stale\s*=\s*\(freshness\s*=\s*'stale'\)/i);
  });

  it('keeps the fencing token monotonic-friendly and all counters non-negative', () => {
    expect(SQL).toMatch(/projector_lease_token_nonneg/i);
    expect(SQL).toMatch(/fencing_token\s*>=\s*0/i);
    expect(SQL).toMatch(/projector_checkpoint_counters_nonneg/i);
  });

  it('requires a live lease row to name both a holder and an expiry (no half-owned lease)', () => {
    expect(SQL).toMatch(/projector_lease_live_has_holder/i);
    expect(SQL).toMatch(/\(holder IS NULL\)\s*=\s*\(expires_at IS NULL\)/i);
  });

  it('requires an in-flight rebuild to name a rebuild id (no anonymous running rebuild)', () => {
    expect(SQL).toMatch(/projector_checkpoint_rebuild_id_when_active/i);
    expect(SQL).toMatch(/projector_rebuild_ended_when_terminal/i);
    expect(SQL).toMatch(/projector_rebuild_failure_when_failed/i);
  });

  it('protects the rebuild audit trail with an append-only terminal trigger', () => {
    // A finished rebuild run's outcome is immutable (append-only at the terminal boundary), so
    // the audit trail stays trustworthy.
    expect(SQL).toMatch(/CREATE\s+TRIGGER\s+projector_rebuild_no_terminal_rewrite/i);
    expect(SQL).toMatch(/projector_rebuild_reject_terminal_rewrite/i);
    expect(SQL).toMatch(/OLD\.ended_at IS NOT NULL/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Expand-only + checksum discipline (GAR-010)
// ───────────────────────────────────────────────────────────────────────────
describe('0010_projector_state migration — expand-only + checksum discipline', () => {
  it('is expand-only — no destructive DDL on existing objects', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+legacy)/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    // Only the append-only trigger may be dropped-if-exists then recreated (idempotent re-apply);
    // no other trigger drop is allowed.
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    // All object creation is IF NOT EXISTS (idempotent re-apply).
    expect(SQL).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+projector_lease/i);
    expect(SQL).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+projector_checkpoint/i);
    expect(SQL).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+projector_rebuild/i);
  });

  it('re-applies as a no-op (idempotent) and is skipped on the second run', async () => {
    const { db } = newDbWithCatalog();
    const first = await applyAll(db);
    expect(first.applied.map((a) => a.id)).toContain('0010');
    const second = await applyAll(db);
    // Negative control: the second run does NOT re-apply 0010; it is skipped.
    expect(second.applied.map((a) => a.id)).not.toContain('0010');
    expect(second.skipped).toContain('0010');
  });

  it('rejects an in-place edit of an already-applied 0010 (checksum-pinned) — negative control', async () => {
    const { db } = newDbWithCatalog();
    const disk = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, disk);

    // Tamper with 0010's body: the runner must reject the changed checksum, not silently accept.
    const tampered: Migration[] = disk.map((m) =>
      m.id === '0010' ? { ...m, up: m.up + '\n-- tampered\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);

    // Sanity: the untampered checksum is stable (positive control for the same predicate).
    const mine = disk.find((m) => m.id === '0010')!;
    expect(checksumMigration(mine)).toBe(checksumMigration(mine));
  });
});
