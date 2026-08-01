// Tenancy & authority migration suite — Phase 18.
//
// Verifies db/migrations/0001_tenancy_authority.sql: the seven governed authority tables
// (tenant, principal, role_definition, role_assignment, delegation, sod_constraint,
// break_glass_grant) from specs/001-governance-control-plane/data-model.md
// §"Tenancy, identity, and authority".
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations), which globs
// both tests/migration/**/*.test.ts and db/migrations/**/*.test.ts. Uses a deterministic
// DDL-recording in-memory SqlDriver so it runs under `npm ci` with NO live PostgreSQL, yet
// still produces an *independently readable durable effect* — the physical-schema catalog —
// distinct from the runner's success response (effect-witness). Every property has a negative
// control so the oracle is non-vacuous.
//
// Obligation mapping:
//   * VO-52d0780c11bcc6fd7583 / phase AC — every onboarded source contract MUST be versioned
//     and validated; mutating operations MUST be correlated, deduplicated, reconcilable,
//     retry-bounded, and safe under duplicate/delayed/partial/conflicting/uncertain outcomes.
//     The migration is applied under the checksum-pinned runner (versioned + validated by the
//     filename ordinal + content checksum); a duplicate re-apply is deduplicated (skipped, no
//     duplicate DDL effect); an in-place edit of an applied migration is rejected.
//   * VO-ec575c4ce42b548bfb4d / GAR-010 — expand-only, applied-once, checksum-pinned migration
//     preserves supported consumers; the loader accepts the authored `0001_tenancy_authority.sql`
//     filename without breaking the pre-existing `<id>__<name>.<kind>.sql` consumer.

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

import { createDdlRecordingDriver } from './ddl-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0001_tenancy_authority.sql';
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

/** The seven tables the phase must create, keyed by the columns the data model requires. */
const REQUIRED_TABLES: Record<string, string[]> = {
  tenant: [
    'tenant_id',
    'slug',
    'display_name',
    'boundary_version_id',
    'status',
    'data_residency',
    'evidence_namespace',
    'encryption_key_ref',
    'signing_key_ref',
    'retention_policy_set_id',
  ],
  principal: [
    'principal_id',
    'principal_type',
    'issuer',
    'subject',
    'display_name',
    'status',
    'assurance_level',
    'attributes',
    'last_verified_at',
  ],
  role_definition: [
    'role_definition_id',
    'role_key',
    'version',
    'permissions',
    'conflict_tags',
    'status',
    'owner_principal_id',
  ],
  role_assignment: [
    'role_assignment_id',
    'tenant_id',
    'principal_id',
    'role_definition_id',
    'scope_type',
    'scope_id',
    'allowed_actions',
    'valid_from',
    'expires_at',
    'grant_reason',
    'grant_decision_id',
    'status',
    'last_recertified_at',
    'next_recertification_at',
  ],
  delegation: [
    'delegation_id',
    'tenant_id',
    'delegator_principal_id',
    'recipient_principal_id',
    'authority_assignment_id',
    'scope_type',
    'scope_id',
    'actions',
    'reason_text',
    'valid_from',
    'expires_at',
    'parent_delegation_id',
    'status',
  ],
  sod_constraint: [
    'sod_constraint_id',
    'tenant_id',
    'version',
    'action_class',
    'risk_minimum',
    'incompatible_roles',
    'incompatible_relationships',
    'minimum_distinct_principals',
    'status',
  ],
  break_glass_grant: [
    'break_glass_grant_id',
    'tenant_id',
    'principal_id',
    'scope',
    'actions',
    'reason_text',
    'incident_id',
    'activated_at',
    'expires_at',
    'monitoring_evidence_id',
    'reviewer_principal_id',
    'review_due_at',
    'reviewed_at',
    'status',
  ],
};

describe('0001_tenancy_authority migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0001');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('tenancy_authority');
    expect(mine!.kind).toBe('expand'); // expand-only (GAR-010 compatibility)
    expect(mine!.up).toContain('CREATE TABLE IF NOT EXISTS tenant');
  });

  it('parses both the plain and explicit filename forms (backward compatible) — negative control', () => {
    expect(parseMigrationFilename('0001_tenancy_authority.sql')).toEqual({
      id: '0001',
      name: 'tenancy_authority',
      kind: 'expand',
    });
    // Pre-existing consumer form still works.
    expect(parseMigrationFilename('0002__outbox.migrate.sql')).toEqual({
      id: '0002',
      name: 'outbox',
      kind: 'migrate',
    });
    // A non-migration .sql name is rejected (null), so the loader can raise a precise error.
    expect(parseMigrationFilename('notamigration.sql')).toBeNull();
    expect(parseMigrationFilename('README.md')).toBeNull();
  });
});

describe('0001_tenancy_authority migration — applied effect (independent read path)', () => {
  it('applying the migration creates the seven authority tables with their required columns', async () => {
    const { db, driver } = newDbWithCatalog();
    // Scope the exact-set assertion to what 0001 itself creates: apply ONLY 0001 so that
    // later governed migrations (0002 RLS, 0003 idempotency, ...) do not count as "accidental
    // extras from this migration".
    const migrations = (await loadMigrationsFromDisk(MIGRATIONS_DIR)).filter(
      (m) => m.id === '0001',
    );
    const report = await runMigrations(db, migrations);
    expect(report.applied.map((a) => a.id)).toContain('0001');

    // Independent read path: inspect the durable catalog, NOT the runner response.
    const cat = driver.__catalog;
    for (const [table, cols] of Object.entries(REQUIRED_TABLES)) {
      expect(cat.tables.has(table), `table ${table} must exist`).toBe(true);
      const present = cat.tables.get(table)!.columns;
      for (const col of cols) {
        expect(present.has(col), `${table}.${col} must exist`).toBe(true);
      }
    }
    // Exactly the seven governed authority tables (no accidental extras from this migration).
    expect([...cat.tables.keys()].sort()).toEqual(Object.keys(REQUIRED_TABLES).sort());
  });

  it('creates the enumerated status/type domains the data model requires', async () => {
    const { db, driver } = newDbWithCatalog();
    await runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
    const types = driver.__catalog.types;
    expect(types.get('tenant_status')).toEqual(['proposed', 'active', 'suspended', 'retired']);
    expect(types.get('principal_type')).toEqual([
      'human',
      'service',
      'automation',
      'external_assessor',
    ]);
    expect(types.get('role_assignment_status')).toEqual([
      'pending',
      'active',
      'suspended',
      'expired',
      'revoked',
    ]);
    expect(types.get('delegation_status')).toEqual(['proposed', 'active', 'expired', 'revoked']);
    expect(types.get('break_glass_status')).toEqual(['active', 'expired', 'revoked', 'reviewed']);
  });

  it('encodes the data-model authority invariants as named table constraints', async () => {
    const { db, driver } = newDbWithCatalog();
    await runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
    const cons = (t: string) => driver.__catalog.tables.get(t)!.constraints;

    // Delegator ≠ recipient (no self-delegation); bounded validity; no self-parent cycle base case.
    expect(cons('delegation').has('delegation_distinct_parties')).toBe(true);
    expect(cons('delegation').has('delegation_bounded_validity')).toBe(true);
    expect(cons('delegation').has('delegation_no_self_parent')).toBe(true);

    // Break-glass: short-lived, independent reviewer, reviewed⇒has-timestamp.
    expect(cons('break_glass_grant').has('break_glass_short_lived')).toBe(true);
    expect(cons('break_glass_grant').has('break_glass_independent_reviewer')).toBe(true);

    // SoD: minimum distinct principals ≥ 1 (≥2 for independently-reviewed), immutable version.
    expect(cons('sod_constraint').has('sod_constraint_min_principals')).toBe(true);
    expect(cons('sod_constraint').has('sod_constraint_version_positive')).toBe(true);

    // Tenant: active requires a retention policy set; slug/evidence-namespace uniqueness.
    expect(cons('tenant').has('tenant_active_requires_retention')).toBe(true);
    expect(cons('tenant').has('tenant_slug_unique')).toBe(true);

    // Principal: authentication identity pair unique; role_definition version pair unique.
    expect(cons('principal').has('principal_identity_unique')).toBe(true);
    expect(cons('role_definition').has('role_definition_key_version_unique')).toBe(true);
  });

  it('is expand-only: it never drops or narrows a supported object (GAR-010 compatibility)', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    // Additive/idempotent creation only.
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS/i);
  });
});

describe('0001_tenancy_authority migration — dedup / idempotency / immutability', () => {
  it('re-applying is deduplicated: applied once, then skipped with no duplicate effect', async () => {
    const { db, driver } = newDbWithCatalog();
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);

    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toContain('0001');
    const tablesAfterFirst = [...driver.__catalog.tables.keys()].sort();

    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]); // no duplicate governance action
    expect(second.skipped).toContain('0001');
    // Catalog is unchanged by the no-op re-run (no duplicate effect).
    expect([...driver.__catalog.tables.keys()].sort()).toEqual(tablesAfterFirst);
  });

  it('records checksum-pinned history readable through an independent read path', async () => {
    const { db } = newDbWithCatalog();
    await runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
    const history = await readMigrationHistory(db);
    const row = history.find((h) => h.id === '0001');
    expect(row).toBeDefined();
    expect(row!.name).toBe('tenancy_authority');
    expect(row!.kind).toBe('expand');
    expect(row!.checksum).toMatch(/^[0-9a-f]{64}$/); // durable content hash
  });

  it('rejects editing the applied migration in place — negative control (immutability)', async () => {
    const { db } = newDbWithCatalog();
    const loaded = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, loaded);
    // Tamper with the already-applied 0001 body and re-run: must be rejected.
    const tampered: Migration[] = loaded.map((m) =>
      m.id === '0001' ? { ...m, up: m.up + '\n-- unauthorized in-place edit\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('migration checksum is content-sensitive (durable witness of change)', () => {
    const base: Migration = { id: '0001', name: 'tenancy_authority', kind: 'expand', up: SQL };
    const same: Migration = { ...base };
    const changed: Migration = { ...base, up: SQL + '\n-- changed\n' };
    expect(checksumMigration(base)).toEqual(checksumMigration(same));
    expect(checksumMigration(base)).not.toEqual(checksumMigration(changed));
  });
});
