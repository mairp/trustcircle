// Inventory-substrate migration suite — Phase 62.
//
// Verifies db/migrations/0010_inventory.sql: the durable, tenant-scoped INVENTORY & OPEN-ENDED
// SOURCE-CATALOG substrate — inventory boundaries, source contracts, source catalog entries,
// per-source raw source records, reconciled governed assets, relationships (correlation /
// dependency / authoritative-field attribution), correlation cases (unresolved conflicts held for
// a human), and coverage gaps — that a projection reads and writes so that the OPEN-ENDED source
// catalog, the RECONCILED inventory, related work across sources, coverage gaps, ownership, health,
// and safe owner actions are CURRENT and FAIL-VISIBLE from durable rows — never from an in-memory
// flag and never silently dropped.
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses the shared
// deterministic DDL-recording in-memory SqlDriver (ddl-recording-driver.mjs), so it runs under
// `npm ci` with NO live PostgreSQL yet still produces an *independently readable durable effect* —
// the physical-schema catalog (the eight inventory tables + their governance columns + their
// operator-scan indexes) — observed through an independent read path, never the runner's success
// response (effect-witness discipline). Every property has a NEGATIVE control so the oracle is
// non-vacuous.
//
// Obligation mapping (phase VOs + AC set, identical AC set to the Phase 57 inventory contract):
//   * VO-6acaf6470d0810df4c93 (phase-primary): the OPEN-ENDED source catalog, RECONCILED inventory,
//     coverage gaps, related work across sources, ownership, health, and safe next actions MUST be
//     current and FAIL-VISIBLE. This migration creates the durable substrate that makes them so.
//   * VO-53a014009bdfebd7af13 (stale-state signaling): source_record.freshness ∈ {fresh,stale,
//     unknown} + the stale boolean mirror + last_known_at + confidence make "this observation is
//     behind / unknown" a durable, queryable fact; CHECKs reject a stale-looking-fresh write.
//   * VO-ec575c4ce42b548bfb4d / GAR-010 — expand-only, applied-once, checksum-pinned.
//   AC1 governed_asset carries the full healthy facet set (type/owner/lifecycle/risk/coverage/
//       health/last-observation/version) → renders once.
//   AC2 coverage_gap keeps a discovered-but-unmanaged component visible (reason/impact/owner action/
//       age), never healthy, never dropped.
//   AC3 distinct source_record rows correlate via inventory_relationship + correlation_case, with
//       authoritative-field attribution and status differences.
//   AC4 source_record.freshness/last_known_at/confidence mark staleness; the stale mirror can't lie.
//   AC5 source_catalog_entry catalogs an unregistered discovered source with class/location/access/
//       ownership/onboarding + discovery evidence.
//   AC6 coverage_gap (gap_class='governed_source') keeps an unsupported/inaccessible/excluded source
//       a visible gap with reason/impact/owner action + review-or-expiry.

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
const MIGRATION_FILE = '0010_inventory.sql';
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

/**
 * The eight inventory tables the phase must create + their required governance columns. Column
 * names are aligned with the governance-api SourceCatalogEntry / GovernedAsset contract so a
 * projection can render those shapes directly.
 */
const REQUIRED_TABLES: Record<string, string[]> = {
  inventory_boundary: [
    'id',
    'tenant_id',
    'name',
    'version',
    'scope',
    'status',
    'created_at',
    'updated_at',
  ],
  source_contract: [
    'id',
    'tenant_id',
    'source_class',
    'version',
    'support_level',
    'authoritative_fields',
    'sensitivity',
  ],
  source_catalog_entry: [
    'id',
    'tenant_id',
    'source_class',
    'boundary_id',
    'observed_locations',
    'owner_principal_id',
    'onboarding_state',
    'access_state',
    'health_state',
    'sensitivity',
    'discovery_evidence',
    'coverage_gap_ids',
    'first_seen_at',
    'last_seen_at',
  ],
  source_record: [
    'id',
    'tenant_id',
    'catalog_id',
    'asset_id',
    'source_class',
    'external_key',
    'observed_state',
    'status',
    'freshness',
    'stale',
    'confidence',
    'last_known_at',
    'observed_at',
  ],
  governed_asset: [
    'id',
    'tenant_id',
    'asset_type',
    'name',
    'owner_principal_id',
    'lifecycle_state',
    'risk_tier',
    'health',
    'coverage',
    'last_observed_at',
    'version',
    'updated_at',
  ],
  inventory_relationship: [
    'id',
    'tenant_id',
    'from_kind',
    'from_id',
    'to_kind',
    'to_id',
    'relationship',
    'field_name',
    'authoritative',
    'created_at',
  ],
  correlation_case: [
    'id',
    'tenant_id',
    'asset_id',
    'case_type',
    'status',
    'conflicting',
    'required_action',
    'resolution',
    'opened_at',
    'resolved_at',
  ],
  coverage_gap: [
    'id',
    'tenant_id',
    'subject_kind',
    'subject_id',
    'gap_class',
    'reason',
    'impact',
    'required_action',
    'required_owner',
    'status',
    'resolution',
    'first_seen_at',
    'review_at',
    'expires_at',
    'resolved_at',
  ],
};

/** Operator-scan indexes that make the fail-visible attention set directly queryable. */
const REQUIRED_INDEXES = [
  'inventory_boundary_tenant_idx',
  'source_contract_class_idx',
  'source_catalog_entry_attention_idx',
  'source_record_identity_idx',
  'source_record_asset_idx',
  'governed_asset_attention_idx',
  'inventory_relationship_edge_idx',
  'inventory_relationship_to_idx',
  'correlation_case_open_idx',
  'coverage_gap_open_idx',
  'coverage_gap_review_idx',
];

// ───────────────────────────────────────────────────────────────────────────
// File & loader
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0010');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('inventory');
    expect(mine!.kind).toBe('expand'); // expand-only (GAR-010 compatibility)
    for (const table of Object.keys(REQUIRED_TABLES)) {
      expect(mine!.up).toContain(table);
    }
  });

  it('parses the authored filename form — negative control', () => {
    expect(parseMigrationFilename('0010_inventory.sql')).toEqual({
      id: '0010',
      name: 'inventory',
      kind: 'expand',
    });
    // Negative control: a non-migration filename is not a migration.
    expect(parseMigrationFilename('NOTES.md')).toBeNull();
  });

  it('does not collide with 0011_projector_state (the migration ids are distinct)', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const ids = migrations.map((m) => m.id);
    // 0010 is inventory, 0011 is projector_state — the rename made room for this phase.
    expect(ids.filter((id) => id === '0010')).toHaveLength(1);
    expect(migrations.find((m) => m.id === '0010')!.name).toBe('inventory');
    expect(migrations.find((m) => m.id === '0011')!.name).toBe('projector_state');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Applied effect (independent read path = the physical-schema catalog)
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory migration — applied effect (independent read path)', () => {
  it('is applied by the checksum-pinned runner as part of the full disk chain', async () => {
    const { db } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0010');
    // Independent read path: the runner history records 0010 as applied.
    const history = await readMigrationHistory(db);
    expect(history.map((h) => h.id)).toContain('0010');
  });

  it('creates all eight inventory tables with their required governance columns', async () => {
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
      (driver.__catalog.tables.get('governed_asset')!.columns as Set<string>).has(
        'not_a_real_column',
      ),
    ).toBe(false);
  });

  it('creates the operator scan indexes (fail-visible attention views)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes as Set<string>;
    for (const name of REQUIRED_INDEXES) {
      expect(idx.has(name), `index ${name} must exist`).toBe(true);
    }
    // Negative control.
    expect(idx.has('inventory_not_a_real_index')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC1 — governed_asset renders the full healthy facet set (once).
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory — AC1 · governed_asset carries the full governed facet set', () => {
  it('has every governance-api GovernedAsset facet column', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cols = driver.__catalog.tables.get('governed_asset')!.columns as Set<string>;
    for (const facet of [
      'asset_type',
      'owner_principal_id',
      'lifecycle_state',
      'risk_tier',
      'health',
      'coverage',
      'last_observed_at',
      'version',
    ]) {
      expect(cols.has(facet), `governed_asset.${facet} (AC1 facet)`).toBe(true);
    }
  });

  it('pins the lifecycle / health / coverage vocabularies and a version floor', () => {
    expect(SQL).toMatch(/governed_asset_lifecycle_valid/i);
    expect(SQL).toMatch(/lifecycle_state IN \([^)]*'operating'[^)]*'orphaned'[^)]*\)/i);
    expect(SQL).toMatch(/governed_asset_health_valid/i);
    expect(SQL).toMatch(/health IN \([^)]*'healthy'[^)]*'unmanaged'[^)]*\)/i);
    expect(SQL).toMatch(/governed_asset_coverage_valid/i);
    expect(SQL).toMatch(/coverage IN \('covered','partial','gap'\)/i);
    expect(SQL).toMatch(/governed_asset_version_positive/i);
    expect(SQL).toMatch(/version >= 1/i);
    // Negative control: a fabricated constraint name is NOT the migration's contract.
    expect(SQL).not.toMatch(/governed_asset_not_a_real_constraint/i);
  });

  it('forbids a covered asset from also being unmanaged/orphaned (no gap masquerading as covered)', () => {
    // AC1/AC2 fail-visible: coverage and management must agree.
    expect(SQL).toMatch(/governed_asset_covered_is_managed/i);
    expect(SQL).toMatch(/coverage <> 'covered' OR/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC2 / AC6 — coverage_gap keeps a discovered-but-ungoverned thing VISIBLE.
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory — AC2/AC6 · coverage_gap keeps a gap visible + actionable', () => {
  it('carries reason / impact / required owner action / age + review-or-expiry columns', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cols = driver.__catalog.tables.get('coverage_gap')!.columns as Set<string>;
    for (const col of [
      'reason', // WHY (AC2/AC6)
      'impact', // impact (AC2/AC6)
      'required_action', // owner action (AC2/AC6)
      'required_owner', // required owner (AC6)
      'first_seen_at', // age derives from this (AC2)
      'review_at', // review (AC6)
      'expires_at', // expiry (AC6)
      'gap_class', // component vs governed_source
    ]) {
      expect(cols.has(col), `coverage_gap.${col}`).toBe(true);
    }
  });

  it('pins the gap reason vocabulary covering both AC2 and AC6 conditions', () => {
    expect(SQL).toMatch(/coverage_gap_reason_valid/i);
    for (const reason of [
      'unmanaged',
      'unreachable',
      'stale',
      'orphaned', // AC2
      'excluded',
      'unsupported',
      'inaccessible',
      'sensitive',
      'unowned', // AC6
    ]) {
      expect(SQL).toContain(`'${reason}'`);
    }
    expect(SQL).toMatch(/coverage_gap_class_valid/i);
    expect(SQL).toMatch(/gap_class IN \('component','governed_source'\)/i);
  });

  it('requires a non-empty owner action — a gap can never be a silent hole', () => {
    expect(SQL).toMatch(/coverage_gap_action_present/i);
    expect(SQL).toMatch(/length\(required_action\) > 0/i);
  });

  it('requires a resolution + resolved time for a resolved gap (no silent closure)', () => {
    expect(SQL).toMatch(/coverage_gap_resolution_when_resolved/i);
    expect(SQL).toMatch(/status = 'resolved'/i);
  });

  it('surfaces the open gap set + the governed-source review/expiry set via partial indexes', () => {
    expect(SQL).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+coverage_gap_open_idx/i);
    expect(SQL).toMatch(/WHERE status IN \('open','acknowledged'\)/i);
    expect(SQL).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+coverage_gap_review_idx/i);
    expect(SQL).toMatch(/WHERE gap_class = 'governed_source'/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC3 — distinct source records correlate; authoritative-field attribution.
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory — AC3 · distinct source records correlate w/ authoritative fields', () => {
  it('keeps distinct source_record rows per (source, external key) and correlates them to an asset', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes as Set<string>;
    // A (catalog, external key) identity → distinct rows per source; an asset_idx correlates them.
    expect(idx.has('source_record_identity_idx')).toBe(true);
    expect(idx.has('source_record_asset_idx')).toBe(true);
    expect(SQL).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+source_record_identity_idx/i,
    );
  });

  it('models correlation / dependency / authoritative-field edges with a pinned vocabulary', () => {
    expect(SQL).toMatch(/inventory_relationship_kind_valid/i);
    expect(SQL).toMatch(
      /relationship IN \([^)]*'correlates'[^)]*'depends_on'[^)]*'authoritative_for'[^)]*\)/i,
    );
    // An authoritative-field attribution MUST name the field it is authoritative for.
    expect(SQL).toMatch(/inventory_relationship_field_when_authoritative/i);
    expect(SQL).toMatch(/relationship <> 'authoritative_for' OR field_name <> ''/i);
  });

  it('holds an unresolved conflict as a correlation_case with a required human resolution', () => {
    expect(SQL).toMatch(/correlation_case_status_valid/i);
    expect(SQL).toMatch(/status IN \('open','investigating','resolved','dismissed'\)/i);
    expect(SQL).toMatch(/correlation_case_resolution_when_terminal/i);
    // Open cases are directly queryable (unresolved work surface).
    expect(SQL).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+correlation_case_open_idx/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC4 — stale-state signaling: staleness is marked, health not inferred from it.
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory — AC4 · stale source is marked; the stale mirror cannot lie', () => {
  it('carries a last-known time + freshness + confidence on every source_record', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cols = driver.__catalog.tables.get('source_record')!.columns as Set<string>;
    for (const col of ['freshness', 'stale', 'confidence', 'last_known_at', 'observed_state']) {
      expect(cols.has(col), `source_record.${col} (AC4)`).toBe(true);
    }
  });

  it('pins the freshness vocabulary and forces the stale boolean to agree with it', () => {
    expect(SQL).toMatch(/source_record_freshness_valid/i);
    expect(SQL).toMatch(/freshness IN \('fresh','stale','unknown'\)/i);
    // The boolean mirror cannot disagree with the freshness enum: a stale row can't look fresh.
    expect(SQL).toMatch(/source_record_stale_agrees/i);
    expect(SQL).toMatch(/stale\s*=\s*\(freshness\s*=\s*'stale'\)/i);
  });

  it('bounds confidence to [0,1] so a stale observation carries a real confidence, not a lie', () => {
    expect(SQL).toMatch(/source_record_confidence_range/i);
    expect(SQL).toMatch(/confidence >= 0\.0 AND confidence <= 1\.0/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC5 — source_catalog_entry catalogs an unregistered discovered source.
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory — AC5 · source_catalog_entry catalogs a discovered source', () => {
  it('carries class / location / access / ownership / onboarding + discovery evidence', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cols = driver.__catalog.tables.get('source_catalog_entry')!.columns as Set<string>;
    for (const col of [
      'source_class', // type-or-unknown classification
      'observed_locations', // location
      'access_state', // access status
      'owner_principal_id', // ownership status
      'onboarding_state', // onboarding state
      'sensitivity', // sensitivity
      'discovery_evidence', // discovery evidence handle
    ]) {
      expect(cols.has(col), `source_catalog_entry.${col} (AC5)`).toBe(true);
    }
  });

  it('pins the onboarding / access / health vocabularies (governed lifecycle is fail-visible)', () => {
    expect(SQL).toMatch(/source_catalog_entry_onboarding_valid/i);
    expect(SQL).toMatch(
      /onboarding_state IN \([^)]*'discovered'[^)]*'onboarded'[^)]*'excluded'[^)]*\)/i,
    );
    expect(SQL).toMatch(/source_catalog_entry_access_valid/i);
    expect(SQL).toMatch(
      /access_state IN \([^)]*'connected'[^)]*'unreachable'[^)]*'inaccessible'[^)]*\)/i,
    );
    expect(SQL).toMatch(/source_catalog_entry_health_valid/i);
  });

  it('forbids a not-yet-onboarded source from being recorded as healthy (stays a visible gap)', () => {
    // AC5/AC6: a discovered/excluded source can never look 'healthy' before onboarding.
    expect(SQL).toMatch(/source_catalog_entry_unonboarded_not_healthy/i);
    expect(SQL).toMatch(/onboarding_state = 'onboarded' OR health_state <> 'healthy'/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tenant isolation — forced restrictive RLS on every inventory table.
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory — tenant isolation (forced restrictive RLS)', () => {
  it('enables + forces RLS and installs a restrictive current_tenant() policy on every table', () => {
    for (const table of Object.keys(REQUIRED_TABLES)) {
      expect(SQL).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(SQL).toMatch(new RegExp(`ALTER TABLE ${table}\\s+FORCE\\s+ROW LEVEL SECURITY`, 'i'));
      expect(SQL).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
    }
    // Fail-closed on missing tenant context: keyed on current_tenant() with an explicit WITH CHECK.
    expect(SQL).toMatch(/AS RESTRICTIVE FOR ALL\s+USING \(tenant_id = current_tenant\(\)\)/i);
    expect(SQL).toMatch(/WITH CHECK \(tenant_id = current_tenant\(\)\)/i);
    // Negative control: no permissive (non-restrictive) inventory policy sneaks in.
    expect(SQL).not.toMatch(/CREATE POLICY tenant_isolation ON \w+ AS PERMISSIVE/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Expand-only + checksum discipline (GAR-010)
// ───────────────────────────────────────────────────────────────────────────
describe('0010_inventory migration — expand-only + checksum discipline', () => {
  it('is expand-only — no destructive DDL on existing objects', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    // Only a policy may be dropped-if-exists then recreated (idempotent RLS re-apply).
    expect(SQL).not.toMatch(/\bDROP\s+(?!POLICY\s+IF\s+EXISTS)\w+/i);
    // All table/index creation is IF NOT EXISTS (idempotent re-apply).
    for (const table of Object.keys(REQUIRED_TABLES)) {
      expect(SQL).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}`, 'i'));
    }
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
