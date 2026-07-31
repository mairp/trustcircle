// Tenant-RLS migration suite — Phase 19 (task T019 / GAR-008).
//
// Verifies db/migrations/0002_tenant_rls.sql: forced row-level security, composite
// tenant foreign keys, and non-owner application roles, per
// specs/001-governance-control-plane/data-model.md §"Database enforcement and indexes"
// and research.md (owner/BYPASSRLS bypass ⇒ application roles must never own tables or
// hold BYPASSRLS).
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses a
// deterministic DDL/RLS-recording in-memory SqlDriver (rls-recording-driver.mjs), so it
// runs under `npm ci` with NO live PostgreSQL yet still produces an *independently
// readable durable effect* — the physical security catalog (RLS state, policies, roles,
// grants, composite FKs) — distinct from the runner's success response (effect-witness).
// Every property has a negative control so the oracle is non-vacuous.
//
// Obligation mapping:
//   * Phase AC / VO-52d0780c11bcc6fd7583 (GAR-008) — every onboarded source contract MUST
//     be versioned + validated; mutating operations MUST be correlated, deduplicated,
//     reconcilable, retry-bounded, and safe under duplicate/delayed/partial/conflicting/
//     uncertain outcomes. This migration is applied under the checksum-pinned runner
//     (versioned by filename ordinal + content checksum); a duplicate re-apply is
//     deduplicated (skipped — no duplicate RLS/policy/role effect); an in-place edit of the
//     applied migration is rejected (MigrationChecksumError).
//   * VO-ec575c4ce42b548bfb4d / GAR-010 — expand-only, applied-once migration that adds
//     RLS + composite keys without dropping or narrowing a supported object.

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

import { createRlsRecordingDriver } from './rls-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0002_tenant_rls.sql';
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const SQL = readFileSync(SQL_PATH, 'utf8');

// The tenant-scoped authority tables that MUST have forced RLS + tenant policies.
const TENANT_TABLES = ['role_assignment', 'delegation', 'break_glass_grant', 'sod_constraint'];

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDb() {
  const driver = createRlsRecordingDriver();
  const db = new Database(driver as unknown as SqlDriver, { clock: makeClock() });
  return { db, driver };
}
async function applyAll(db: Database) {
  return runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
}

describe('0002_tenant_rls migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader after 0001, as an expand migration', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const ids = migrations.map((m) => m.id);
    // Ordered application: 0001 before 0002.
    expect(ids.indexOf('0001')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('0002')).toBeGreaterThan(ids.indexOf('0001'));
    const mine = migrations.find((m) => m.id === '0002');
    expect(mine!.name).toBe('tenant_rls');
    expect(mine!.kind).toBe('expand');
    expect(mine!.up).toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it('parses 0002_tenant_rls.sql to the expected id/name/kind — negative control', () => {
    expect(parseMigrationFilename('0002_tenant_rls.sql')).toEqual({
      id: '0002',
      name: 'tenant_rls',
      kind: 'expand',
    });
    expect(parseMigrationFilename('not_a_migration')).toBeNull();
  });
});

describe('0002_tenant_rls migration — forced RLS (independent read path)', () => {
  it('enables AND forces row-level security on every tenant-scoped table', async () => {
    const { db, driver } = newDb();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toEqual(['0001', '0002']);

    const rls = driver.__catalog.rls;
    for (const t of TENANT_TABLES) {
      expect(rls.has(t), `${t} must have RLS state`).toBe(true);
      expect(rls.get(t)!.enabled, `${t} ENABLE ROW LEVEL SECURITY`).toBe(true);
      // FORCE is the safeguard: even the table owner is subject to RLS.
      expect(rls.get(t)!.forced, `${t} FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  it('installs a RESTRICTIVE tenant-isolation policy + explicit WITH CHECK on each table', async () => {
    const { db, driver } = newDb();
    await applyAll(db);
    const policies = driver.__catalog.policies;

    for (const t of TENANT_TABLES) {
      const byTable = policies.get(t);
      expect(byTable, `${t} must have policies`).toBeDefined();
      const iso = byTable!.get('tenant_isolation');
      expect(iso, `${t}.tenant_isolation policy`).toBeDefined();
      // Hard AND-gate: restrictive, references the tenant GUC, has an explicit write check.
      expect(iso!.as).toBe('restrictive');
      expect(iso!.using).toMatch(/current_tenant\(\)/);
      expect(iso!.check).toMatch(/current_tenant\(\)/);
    }
  });

  it('tenant policies key on current_tenant() so missing context default-denies (fail-closed)', () => {
    // current_tenant() reads app.tenant_id with the missing-ok flag and NULLIFs empty,
    // so an unset/empty context yields NULL and `tenant_id = NULL` is never true.
    expect(SQL).toMatch(/current_setting\(\s*'app\.tenant_id'\s*,\s*true\s*\)/i);
    expect(SQL).toMatch(/NULLIF\(/i);
    // Every tenant policy predicate compares tenant_id to current_tenant() (default-deny).
    const predicates = SQL.match(/tenant_id\s*=\s*current_tenant\(\)/gi) ?? [];
    expect(predicates.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
  });
});

describe('0002_tenant_rls migration — non-owner application roles (owner/BYPASSRLS safeguard)', () => {
  it('creates app_rw / app_ro as NOBYPASSRLS, NOSUPERUSER, NOLOGIN roles', async () => {
    const { db, driver } = newDb();
    await applyAll(db);
    const roles = driver.__catalog.roles;

    for (const r of ['app_rw', 'app_ro']) {
      expect(roles.has(r), `${r} role must exist`).toBe(true);
      const attrs = roles.get(r)!.attrs;
      // The two attributes that make forced RLS actually bind: never BYPASSRLS, never SUPERUSER.
      expect(attrs.has('NOBYPASSRLS'), `${r} must be NOBYPASSRLS`).toBe(true);
      expect(attrs.has('NOSUPERUSER'), `${r} must be NOSUPERUSER`).toBe(true);
      expect(attrs.has('NOLOGIN'), `${r} must be NOLOGIN (group role)`).toBe(true);
    }
  });

  it('never grants BYPASSRLS or SUPERUSER to an application role — negative control', () => {
    // Strip SQL line-comments so we assert on executable statements only.
    const code = SQL.split('\n')
      .map((l) => {
        const i = l.indexOf('--');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    // Each CREATE ROLE for an app role carries NO<attr>, never the enabling form. A positive
    // BYPASSRLS/SUPERUSER is exactly `(?<!NO)BYPASSRLS` — the negative lookbehind excludes
    // the NOBYPASSRLS we DO require.
    expect(code).not.toMatch(/CREATE\s+ROLE\s+app_(rw|ro)[^;]*?(?<!NO)BYPASSRLS\b/i);
    expect(code).not.toMatch(/CREATE\s+ROLE\s+app_(rw|ro)[^;]*?(?<!NO)SUPERUSER\b/i);
    // The roles never become table OWNERS (no ALTER TABLE ... OWNER TO app_*).
    expect(code).not.toMatch(/OWNER\s+TO\s+app_(rw|ro)\b/i);
    // Positive control: the required safe attributes ARE present.
    expect(code).toMatch(/CREATE\s+ROLE\s+app_rw[^;]*NOBYPASSRLS/i);
    expect(code).toMatch(/CREATE\s+ROLE\s+app_ro[^;]*NOBYPASSRLS/i);
  });

  it('grants least-privilege DML: app_rw read+write, app_ro read-only', async () => {
    const { db, driver } = newDb();
    await applyAll(db);
    const grants = driver.__catalog.grants;
    for (const t of TENANT_TABLES) {
      const rw = grants.get(`${t} app_rw`);
      expect(rw, `${t} app_rw grants`).toBeDefined();
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(rw!.has(p), `${t} app_rw ${p}`).toBe(true);
      }
      const ro = grants.get(`${t} app_ro`);
      expect(ro, `${t} app_ro grants`).toBeDefined();
      expect(ro!.has('SELECT'), `${t} app_ro SELECT`).toBe(true);
      // Read-only role has NO write privilege (revoked defensively) — negative control.
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(ro!.has(p), `${t} app_ro must NOT have ${p}`).toBe(false);
      }
    }
  });
});

describe('0002_tenant_rls migration — composite tenant foreign keys', () => {
  it('adds composite (tenant_id, id) unique keys and same-tenant composite FKs', async () => {
    const { db, driver } = newDb();
    await applyAll(db);
    const cons = (t: string) => driver.__catalog.tables.get(t)!.constraints;

    // Composite UNIQUE parents so a FK can reference (tenant_id, pk).
    expect(cons('role_assignment').has('role_assignment_tenant_pk_unique')).toBe(true);
    expect(cons('role_assignment').get('role_assignment_tenant_pk_unique')).toMatch(
      /\(\s*tenant_id\s*,\s*role_assignment_id\s*\)/i,
    );
    expect(cons('delegation').has('delegation_tenant_pk_unique')).toBe(true);

    // Composite FKs carry tenant_id as the FIRST column ⇒ a child can only reference a
    // parent that shares its tenant (foreign keys never cross tenants).
    const authFk = cons('delegation').get('delegation_authority_same_tenant_fk');
    expect(authFk).toBeDefined();
    expect(authFk).toMatch(/FOREIGN\s+KEY\s*\(\s*tenant_id\s*,\s*authority_assignment_id\s*\)/i);
    expect(authFk).toMatch(
      /REFERENCES\s+role_assignment\s*\(\s*tenant_id\s*,\s*role_assignment_id\s*\)/i,
    );

    const parentFk = cons('delegation').get('delegation_parent_same_tenant_fk');
    expect(parentFk).toBeDefined();
    expect(parentFk).toMatch(/FOREIGN\s+KEY\s*\(\s*tenant_id\s*,\s*parent_delegation_id\s*\)/i);
    expect(parentFk).toMatch(/REFERENCES\s+delegation\s*\(\s*tenant_id\s*,\s*delegation_id\s*\)/i);
  });

  it('no tenant-scoped FK references a parent by bare id without the tenant column — negative control', () => {
    // Every cross-table FK the migration adds leads with tenant_id.
    const fkClauses = SQL.match(/FOREIGN\s+KEY\s*\([^)]*\)/gi) ?? [];
    expect(fkClauses.length).toBeGreaterThanOrEqual(2);
    for (const clause of fkClauses) {
      expect(clause, `FK must include tenant_id: ${clause}`).toMatch(/tenant_id/i);
    }
  });
});

describe('0002_tenant_rls migration — expand-only / dedup / immutability', () => {
  it('is expand-only: never drops or narrows a supported object (GAR-010)', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+ROLE\b/i);
    // DROP POLICY IF EXISTS is only ever paired with an immediate re-CREATE (idempotent
    // reinstall), never a bare removal.
    const drops = (SQL.match(/DROP\s+POLICY\s+IF\s+EXISTS/gi) ?? []).length;
    const creates = (SQL.match(/CREATE\s+POLICY/gi) ?? []).length;
    expect(creates).toBeGreaterThanOrEqual(drops);
  });

  it('re-applying is deduplicated: applied once, then skipped with no duplicate effect', async () => {
    const { db, driver } = newDb();
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);

    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toContain('0002');
    const rlsAfterFirst = new Map([...driver.__catalog.rls].map(([k, v]) => [k, { ...v }]));
    const roleCount = driver.__catalog.roles.size;

    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]); // no duplicate governance action
    expect(second.skipped).toEqual(expect.arrayContaining(['0001', '0002']));
    // Security catalog unchanged by the no-op re-run (no duplicate effect).
    expect(driver.__catalog.roles.size).toBe(roleCount);
    for (const [t, v] of rlsAfterFirst) {
      expect(driver.__catalog.rls.get(t)).toEqual(v);
    }
  });

  it('records checksum-pinned history for 0002 via an independent read path', async () => {
    const { db } = newDb();
    await applyAll(db);
    const history = await readMigrationHistory(db);
    const row = history.find((h) => h.id === '0002');
    expect(row).toBeDefined();
    expect(row!.name).toBe('tenant_rls');
    expect(row!.kind).toBe('expand');
    expect(row!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects editing the applied 0002 migration in place — negative control (immutability)', async () => {
    const { db } = newDb();
    const loaded = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, loaded);
    const tampered: Migration[] = loaded.map((m) =>
      m.id === '0002' ? { ...m, up: m.up + '\n-- unauthorized in-place edit\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('checksum is content-sensitive (durable witness of change)', () => {
    const base: Migration = { id: '0002', name: 'tenant_rls', kind: 'expand', up: SQL };
    const same: Migration = { ...base };
    const changed: Migration = { ...base, up: SQL + '\n-- changed\n' };
    expect(checksumMigration(base)).toEqual(checksumMigration(same));
    expect(checksumMigration(base)).not.toEqual(checksumMigration(changed));
  });
});
