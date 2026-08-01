// Idempotency migration suite — Phase 23.
//
// Verifies db/migrations/0003_idempotency.sql: the scoped idempotency ledger and its
// same-key/different-digest CONFLICT ENFORCEMENT, from
// specs/001-governance-control-plane/data-model.md §"IdempotencyRecord":
//   "Unique (tenant_id, operation_scope, idempotency_key) with request digest, canonical
//    operation ID, first/last seen, result status, response digest/reference, and expiry.
//    Reusing a key with a different request digest is a conflict."
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses a
// deterministic idempotency-recording in-memory SqlDriver so it runs under `npm ci` with NO
// live PostgreSQL, yet still produces an *independently readable durable effect*:
//   (a) the physical-schema catalog (table + scoped unique key + expiry index + the conflict
//       guard trigger/function) — the DDL effect witness, and
//   (b) the ledger DATA-PLANE — inserting a record then attempting a same-key/different-digest
//       overwrite is REJECTED by the emulated BEFORE-UPDATE guard, and the recorded request
//       digest is observed UNCHANGED through an independent SELECT read path.
// Neither is the runner's success response (effect-witness discipline). Every property has a
// negative control so the oracle is non-vacuous.
//
// Obligation mapping:
//   * VO-3cc80819915c2d5e64ba (phase AC / integration / effect-witness) + VO-52d0780c11bcc6fd7583:
//     every onboarded source contract MUST be versioned and validated; mutating operations MUST
//     be correlated, deduplicated, reconcilable, retry-bounded, and safe under
//     duplicate/delayed/partial/conflicting/uncertain outcomes. The migration is applied under
//     the checksum-pinned runner (versioned + validated by the filename ordinal + content
//     checksum); a duplicate re-apply is deduplicated (skipped, no duplicate DDL effect); an
//     in-place edit is rejected. The ledger it creates DEDUPLICATES (scope unique key),
//     CORRELATES (correlation_id column), makes history reconstructable (first/last seen +
//     attempts), and is SAFE UNDER CONFLICTING outcomes (same-key/different-digest is refused,
//     recorded request unchanged).
//   * VO-ec575c4ce42b548bfb4d / GAR-010 — expand-only, applied-once, checksum-pinned migration
//     composes with the runner's bootstrapped ledger without narrowing a supported column.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  Database,
  runMigrations,
  runMutation,
  readMigrationHistory,
  loadMigrationsFromDisk,
  parseMigrationFilename,
  checksumMigration,
  MigrationChecksumError,
  IdempotencyConflictError,
  type Migration,
  type SqlDriver,
} from '../../packages/persistence/src/database.ts';

import { createIdempotencyRecordingDriver } from './idempotency-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0003_idempotency.sql';
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const SQL = readFileSync(SQL_PATH, 'utf8');

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDbWithCatalog() {
  const driver = createIdempotencyRecordingDriver();
  const db = new Database(driver as unknown as SqlDriver, { clock: makeClock() });
  return { db, driver };
}
async function applyAll(db: Database) {
  return runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
}

/** Columns the data-model IdempotencyRecord requires the ledger to carry. */
const REQUIRED_COLUMNS = [
  'tenant_id',
  'operation_scope',
  'idempotency_key',
  'correlation_id',
  'request_digest',
  'contract_version',
  'status',
  'response_digest',
  'response_json',
  'first_seen_at',
  'last_seen_at',
  'attempts',
  'canonical_operation_id',
  'expires_at',
];

describe('0003_idempotency migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0003');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('idempotency');
    expect(mine!.kind).toBe('expand'); // expand-only (GAR-010 compatibility)
    expect(mine!.up).toContain('idempotency_ledger');
  });

  it('parses the authored filename form — negative control', () => {
    expect(parseMigrationFilename('0003_idempotency.sql')).toEqual({
      id: '0003',
      name: 'idempotency',
      kind: 'expand',
    });
    expect(parseMigrationFilename('README.md')).toBeNull();
  });
});

describe('0003_idempotency migration — applied effect (independent read path)', () => {
  it('creates the scoped idempotency_ledger with all required data-model columns', async () => {
    const { db, driver } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0003');

    const cat = driver.__catalog;
    expect(cat.tables.has('idempotency_ledger'), 'idempotency_ledger must exist').toBe(true);
    const cols = cat.tables.get('idempotency_ledger')!.columns;
    for (const col of REQUIRED_COLUMNS) {
      expect(cols.has(col), `idempotency_ledger.${col} must exist`).toBe(true);
    }
  });

  it('creates the scope-unique key + expiry/status indexes (the deduplication contract)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes;
    expect(idx.has('idempotency_ledger_scope_key_unique')).toBe(true);
    expect(idx.has('idempotency_ledger_expiring_idx')).toBe(true);
    expect(idx.has('idempotency_ledger_status_idx')).toBe(true);
    // The scope tuple is also the PRIMARY KEY of the table body.
    const body = driver.__catalog.tables.get('idempotency_ledger')!.body;
    expect(body).toMatch(
      /PRIMARY KEY\s*\(\s*tenant_id\s*,\s*operation_scope\s*,\s*idempotency_key\s*\)/i,
    );
  });

  it('creates the same-key/different-digest conflict guard (trigger + function)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cat = driver.__catalog;
    expect(cat.functions.has('idempotency_ledger_reject_digest_change')).toBe(true);
    const trig = cat.triggers.get('idempotency_ledger_conflict_guard');
    expect(trig, 'conflict-guard trigger must exist').toBeDefined();
    expect(trig!.table).toBe('idempotency_ledger');
    expect(trig!.timing).toBe('BEFORE');
    expect(trig!.event).toBe('UPDATE');
    expect(trig!.fn).toBe('idempotency_ledger_reject_digest_change');
  });

  // Byte-level structural witness — read the ACTUAL migration bytes and prove the
  // conflict-guard DDL is present in the governed source contract itself, NOT merely in
  // the in-memory driver's catalog. This anchors the effect-witness to the SQL the real
  // PostgreSQL runner would execute: the trigger raises ERRCODE 'unique_violation'
  // (SQLSTATE 23505) BEFORE UPDATE, only when the digest genuinely changes to a
  // different non-null value. Independent of the test double's behavior.
  it('the source SQL itself declares the BEFORE-UPDATE conflict guard (byte-level witness)', () => {
    // The guarding plpgsql function exists and raises a unique_violation on digest change.
    expect(SQL).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+idempotency_ledger_reject_digest_change\s*\(/i,
    );
    expect(SQL).toMatch(/RAISE\s+EXCEPTION/i);
    expect(SQL).toMatch(/USING\s+ERRCODE\s*=\s*'unique_violation'/i);
    // The guard fires only on a genuine change to a recorded non-null digest.
    expect(SQL).toMatch(/NEW\.request_digest\s*<>\s*OLD\.request_digest/i);
    // The trigger binds the function BEFORE UPDATE, FOR EACH ROW, on the ledger table.
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+idempotency_ledger_conflict_guard\s+BEFORE\s+UPDATE\s+ON\s+idempotency_ledger[\s\S]*?FOR\s+EACH\s+ROW[\s\S]*?EXECUTE\s+FUNCTION\s+idempotency_ledger_reject_digest_change/i,
    );
  });

  it('records the retention CHECK (expiry cannot precede first-seen)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cons = driver.__catalog.tables.get('idempotency_ledger')!.constraints;
    expect(cons.has('idempotency_ledger_expiry_after_first_seen')).toBe(true);
  });

  it('is expand-only: never drops or narrows a supported object (GAR-010 compatibility)', () => {
    // Single property: no destructive/narrowing DDL. (The presence of the table/guard
    // is asserted by the dedicated schema and byte-level-witness tests above, so a
    // trigger-only regression does not spuriously trip THIS expand-only assertion.)
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    // The one DROP TRIGGER present must be the idempotent reinstall idiom (IF EXISTS,
    // immediately followed by a CREATE TRIGGER of the same name) — never a bare drop.
    const bareDropTrigger = /\bDROP\s+TRIGGER\s+(?!IF\s+EXISTS)/i;
    expect(SQL).not.toMatch(bareDropTrigger);
  });
});

describe('0003_idempotency migration — scoped dedup + same-key/different-digest conflict (data-plane effect witness)', () => {
  const CONTRACT = {
    sourceId: 'controller.repair',
    version: '1.0.0',
    contractDigest: 'contract-digest-abc',
    validated: true,
  } as const;

  it('a duplicate replay is deduplicated — recorded result returned, NO re-execution', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    let effectRuns = 0;
    const req = {
      tenantId: 'tenant-a',
      operationScope: 'controller.repair',
      idempotencyKey: 'key-1',
      correlationId: 'corr-1',
      contract: CONTRACT,
      expectedContractVersion: '1.0.0',
      request: { target: 'ctrl-9', action: 'repair' },
      async effect() {
        effectRuns++;
        return { applied: true };
      },
    };

    const first = await runMutation(db, req);
    expect(first.status).toBe('succeeded');
    expect(first.deduplicated).toBe(false);

    const second = await runMutation(db, req); // same key, same request
    expect(second.status).toBe('succeeded');
    expect(second.deduplicated).toBe(true);

    // Independent read path: exactly ONE effect ran; the ledger row is the durable witness.
    expect(effectRuns).toBe(1);
    const rec = await db.readIdempotencyRecord('tenant-a', 'controller.repair', 'key-1');
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe('succeeded');
    expect(rec!.attempts).toBeGreaterThanOrEqual(1);
  });

  it('reusing a key with a DIFFERENT request digest is a conflict — refused, no new effect', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    let effectRuns = 0;
    const base = {
      tenantId: 'tenant-a',
      operationScope: 'controller.repair',
      idempotencyKey: 'key-2',
      correlationId: 'corr-2',
      contract: CONTRACT,
      expectedContractVersion: '1.0.0',
      async effect() {
        effectRuns++;
        return { applied: true };
      },
    };

    await runMutation(db, { ...base, request: { target: 'ctrl-1' } });
    const before = await db.readIdempotencyRecord('tenant-a', 'controller.repair', 'key-2');
    expect(before).not.toBeNull();
    const recordedDigest = before!.requestDigest;

    // Same key, materially different request body ⇒ conflict.
    await expect(
      runMutation(db, { ...base, request: { target: 'ctrl-2-DIFFERENT' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    // Effect-witness: no second effect ran; the recorded request digest is UNCHANGED
    // (observed via an independent SELECT read path — not the mutation response).
    expect(effectRuns).toBe(1);
    const after = await db.readIdempotencyRecord('tenant-a', 'controller.repair', 'key-2');
    expect(after!.requestDigest).toBe(recordedDigest);
  });

  it('the database-level guard itself rejects a digest-changing UPDATE (defense in depth)', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    // Seed a record directly through the driver's INSERT path.
    const now = db.now();
    await db.query(
      `INSERT INTO idempotency_ledger
         (tenant_id, operation_scope, idempotency_key, correlation_id, request_digest,
          contract_version, status, response_digest, response_json, first_seen_at, last_seen_at, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
      ['t', 's', 'k', 'c', 'DIGEST-ORIGINAL', '1.0.0', 'succeeded', null, null, now, 1],
    );

    // A same-key upsert carrying a DIFFERENT digest fires the BEFORE-UPDATE guard.
    await expect(
      db.query(
        `INSERT INTO idempotency_ledger
           (tenant_id, operation_scope, idempotency_key, correlation_id, request_digest,
            contract_version, status, response_digest, response_json, first_seen_at, last_seen_at, attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
        ['t', 's', 'k', 'c', 'DIGEST-DIFFERENT', '1.0.0', 'succeeded', null, null, db.now(), 2],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Independent read path: the original digest survived the rejected update.
    const row = await db.query<{ request_digest: string }>(
      'SELECT * FROM idempotency_ledger WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3',
      ['t', 's', 'k'],
    );
    expect(row.rows[0]!.request_digest).toBe('DIGEST-ORIGINAL');
  });

  it('deduplication is TENANT-SCOPED: the same key under a different tenant is a distinct record', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    let effectRuns = 0;
    const mk = (tenant: string) => ({
      tenantId: tenant,
      operationScope: 'controller.repair',
      idempotencyKey: 'shared-key',
      correlationId: `corr-${tenant}`,
      contract: CONTRACT,
      expectedContractVersion: '1.0.0',
      request: { target: 'ctrl-x' },
      async effect() {
        effectRuns++;
        return { applied: true };
      },
    });

    await runMutation(db, mk('tenant-a'));
    await runMutation(db, mk('tenant-b')); // same key, different tenant ⇒ not a duplicate

    expect(effectRuns).toBe(2);
    const a = await db.readIdempotencyRecord('tenant-a', 'controller.repair', 'shared-key');
    const b = await db.readIdempotencyRecord('tenant-b', 'controller.repair', 'shared-key');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.correlationId).toBe('corr-tenant-a');
    expect(b!.correlationId).toBe('corr-tenant-b');
  });
});

describe('0003_idempotency migration — dedup / immutability of the migration itself', () => {
  it('re-applying is deduplicated: applied once, then skipped with no duplicate effect', async () => {
    const { db, driver } = newDbWithCatalog();
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);

    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toContain('0003');
    const trigCountAfterFirst = driver.__catalog.triggers.size;

    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]); // no duplicate governance action
    expect(second.skipped).toContain('0003');
    expect(driver.__catalog.triggers.size).toBe(trigCountAfterFirst);
  });

  it('records checksum-pinned history readable through an independent read path', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    const history = await readMigrationHistory(db);
    const row = history.find((h) => h.id === '0003');
    expect(row).toBeDefined();
    expect(row!.name).toBe('idempotency');
    expect(row!.kind).toBe('expand');
    expect(row!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects editing the applied migration in place — negative control (immutability)', async () => {
    const { db } = newDbWithCatalog();
    const loaded = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, loaded);
    const tampered: Migration[] = loaded.map((m) =>
      m.id === '0003' ? { ...m, up: m.up + '\n-- unauthorized in-place edit\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('migration checksum is content-sensitive (durable witness of change)', () => {
    const base: Migration = { id: '0003', name: 'idempotency', kind: 'expand', up: SQL };
    const same: Migration = { ...base };
    const changed: Migration = { ...base, up: SQL + '\n-- changed\n' };
    expect(checksumMigration(base)).toEqual(checksumMigration(same));
    expect(checksumMigration(base)).not.toEqual(checksumMigration(changed));
  });
});
