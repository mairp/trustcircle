// Evidence migration suite — Phase 33 (task T033 / GAR-006).
//
// Verifies db/migrations/0006_evidence.sql: the content-addressed, immutable/tamper-evident
// EVIDENCE substrate — evidence_item, the acyclic append-only provenance graph (evidence_relation),
// the signed evidence_manifest, the append-only access history (evidence_access_log) and custody
// chain (chain_of_custody), the retention_policy / legal_hold tables, and the signed, gated
// disposition_record. Grounded in specs/001-governance-control-plane/data-model.md §"Evidence and
// audit".
//
// Phase acceptance criterion (VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 /
// VO-4aeb030a32c9deebdb3b, contract / positive):
//   "Originals MUST remain immutable or tamper-evident; derived repairs, exports, redactions, and
//    dispositions MUST retain provenance, integrity, authorization, retention, and access history."
//
// This suite maps EACH clause of that criterion to an independently observable durable effect:
//   * a byte-level witness that the governed SQL contract itself declares the guard/constraint, AND
//   * a data-plane effect witness: a mutation that would violate the clause (mutate a committed
//     original's content, add a derived item with no parent, dispose before retention elapses or
//     while a hold is active, rewrite the access/custody history) is REJECTED by the emulated
//     constraint/guard — while the lawful positive path IS recorded and read back through an
//     independent SELECT.
// Every property has a negative control (the rejecting mutation) so the oracle is non-vacuous.
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses a
// deterministic in-memory SqlDriver so it runs under `npm ci` with NO live PostgreSQL. The effect
// is NOT the runner's success response (effect-witness discipline) — it is the durable catalog +
// the immutable, guarded rows observed via SELECT.
//
// Also carries the migration-hygiene legs shared by every migration suite (GAR-010 /
// VO-ec575c4ce42b548bfb4d): expand-only, applied-once/deduplicated, checksum-pinned immutability.

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

import { createEvidenceRecordingDriver } from './evidence-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0006_evidence.sql';
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const SQL = readFileSync(SQL_PATH, 'utf8');

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDbWithCatalog() {
  const driver = createEvidenceRecordingDriver();
  const db = new Database(driver as unknown as SqlDriver, { clock: makeClock() });
  return { db, driver };
}
async function applyAll(db: Database) {
  return runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
}

// ---- INSERT helpers (positional params in the driver's per-table COLS order) ----------
function insertStmt(table: string, cols: string[]) {
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  return `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`;
}

const EVIDENCE_ITEM_COLS = [
  'evidence_item_id',
  'tenant_id',
  'kind',
  'content_uri',
  'content_sha256',
  'size_bytes',
  'media_type',
  'parent_evidence_id',
  'source_catalog_entry_id',
  'source_record_id',
  'produced_by_principal_id',
  'produced_at',
  'observed_at',
  'classification',
  'access_policy_id',
  'retention_policy_id',
  'retain_until',
  'legal_hold_count',
  'integrity_status',
  'encryption_key_ref',
  'storage_version_id',
  'status',
  'created_at',
];
function originalItem(overrides: Record<string, unknown> = {}) {
  return {
    evidence_item_id: 'ev-orig-1',
    tenant_id: 'tenant-a',
    kind: 'original',
    content_uri: 'blob://immutable/ev-orig-1',
    content_sha256: 'sha256:orig',
    size_bytes: 1024,
    media_type: 'application/json',
    parent_evidence_id: null,
    source_catalog_entry_id: 'cat-1',
    source_record_id: 'rec-1',
    produced_by_principal_id: 'principal-capture',
    produced_at: 1700,
    observed_at: 1699,
    classification: 'confidential',
    access_policy_id: 'ap-1',
    retention_policy_id: 'rp-1',
    retain_until: 5000,
    legal_hold_count: 0,
    integrity_status: 'intact',
    encryption_key_ref: 'kms:key-1',
    storage_version_id: 'sv-1',
    status: 'committed',
    created_at: 1700,
    ...overrides,
  } as Record<string, unknown>;
}
function derivedItem(overrides: Record<string, unknown> = {}) {
  return originalItem({
    evidence_item_id: 'ev-deriv-1',
    kind: 'redaction',
    content_uri: 'blob://immutable/ev-deriv-1',
    content_sha256: 'sha256:deriv',
    parent_evidence_id: 'ev-orig-1',
    ...overrides,
  });
}
function params(cols: string[], row: Record<string, unknown>) {
  return cols.map((c) => row[c]);
}
const INSERT_ITEM = insertStmt('evidence_item', EVIDENCE_ITEM_COLS);

const RELATION_COLS = [
  'evidence_relation_id',
  'tenant_id',
  'parent_evidence_id',
  'child_evidence_id',
  'relationship',
  'method',
  'transformation_digest',
  'tool_adapter_version',
  'actor_principal_id',
  'reason',
  'created_at',
  'authorization_principal_id',
  'authorization_grant_id',
];
function relationRow(overrides: Record<string, unknown> = {}) {
  return {
    evidence_relation_id: 'rel-1',
    tenant_id: 'tenant-a',
    parent_evidence_id: 'ev-orig-1',
    child_evidence_id: 'ev-deriv-1',
    relationship: 'redacted_from',
    method: 'pii-redactor',
    transformation_digest: 'sha256:transform',
    tool_adapter_version: 'redactor@1.2.0',
    actor_principal_id: 'principal-redactor',
    reason: 'GDPR subject request',
    created_at: 1800,
    authorization_principal_id: 'principal-approver',
    authorization_grant_id: 'grant-1',
    ...overrides,
  } as Record<string, unknown>;
}
const INSERT_RELATION = insertStmt('evidence_relation', RELATION_COLS);

const ACCESS_COLS = [
  'access_log_id',
  'tenant_id',
  'evidence_item_id',
  'principal_id',
  'action',
  'purpose',
  'decision',
  'access_policy_id',
  'correlation_id',
  'accessed_at',
];
function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    access_log_id: 'acc-1',
    tenant_id: 'tenant-a',
    evidence_item_id: 'ev-orig-1',
    principal_id: 'principal-reader',
    action: 'read',
    purpose: 'audit-review',
    decision: 'granted',
    access_policy_id: 'ap-1',
    correlation_id: 'corr-1',
    accessed_at: 1900,
    ...overrides,
  } as Record<string, unknown>;
}
const INSERT_ACCESS = insertStmt('evidence_access_log', ACCESS_COLS);

const CUSTODY_COLS = [
  'custody_id',
  'tenant_id',
  'evidence_item_id',
  'sequence',
  'event_type',
  'from_principal_id',
  'to_principal_id',
  'reason',
  'content_sha256',
  'occurred_at',
];
function custodyRow(overrides: Record<string, unknown> = {}) {
  return {
    custody_id: 'cust-1',
    tenant_id: 'tenant-a',
    evidence_item_id: 'ev-orig-1',
    sequence: 1,
    event_type: 'captured',
    from_principal_id: null,
    to_principal_id: 'principal-capture',
    reason: 'initial capture',
    content_sha256: 'sha256:orig',
    occurred_at: 1700,
    ...overrides,
  } as Record<string, unknown>;
}
const INSERT_CUSTODY = insertStmt('chain_of_custody', CUSTODY_COLS);

const RETENTION_COLS = [
  'retention_policy_id',
  'tenant_id',
  'name',
  'applies_to_classifications',
  'duration_millis',
  'disposition_action',
  'owner_principal_id',
  'approved',
  'approved_by_principal_id',
  'version',
  'effective_from',
  'effective_until',
  'review_at',
  'created_at',
];
function retentionRow(overrides: Record<string, unknown> = {}) {
  return {
    retention_policy_id: 'rp-1',
    tenant_id: 'tenant-a',
    name: 'confidential-7y',
    applies_to_classifications: ['confidential'],
    duration_millis: 3300,
    disposition_action: 'crypto_shred',
    owner_principal_id: 'principal-dpo',
    approved: true,
    approved_by_principal_id: 'principal-legal',
    version: '1',
    effective_from: 1000,
    effective_until: null,
    review_at: 9000,
    created_at: 1000,
    ...overrides,
  } as Record<string, unknown>;
}
const INSERT_RETENTION = insertStmt('retention_policy', RETENTION_COLS);

const HOLD_COLS = [
  'legal_hold_id',
  'tenant_id',
  'reason',
  'authority_principal_id',
  'scope_evidence_ids',
  'status',
  'placed_at',
  'released_at',
  'released_by_principal_id',
];
function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    legal_hold_id: 'lh-1',
    tenant_id: 'tenant-a',
    reason: 'litigation X',
    authority_principal_id: 'principal-counsel',
    scope_evidence_ids: ['ev-orig-1'],
    status: 'active',
    placed_at: 1500,
    released_at: null,
    released_by_principal_id: null,
    ...overrides,
  } as Record<string, unknown>;
}
const INSERT_HOLD = insertStmt('legal_hold', HOLD_COLS);

const DISPOSITION_COLS = [
  'disposition_id',
  'tenant_id',
  'evidence_item_id',
  'method',
  'resolved_policy_ids',
  'cleared_hold_ids',
  'resolved_retain_until',
  'active_hold_count_at_exec',
  'authorization_principal_id',
  'authorization_grant_id',
  'executed_by_principal_id',
  'executed_at',
  'content_sha256',
  'access_history',
  'verification_status',
  'signing_key_id',
  'signature_algorithm',
  'signature',
];
function dispositionRow(overrides: Record<string, unknown> = {}) {
  return {
    disposition_id: 'disp-1',
    tenant_id: 'tenant-a',
    evidence_item_id: 'ev-orig-1',
    method: 'crypto_shred',
    resolved_policy_ids: ['rp-1'],
    cleared_hold_ids: [],
    resolved_retain_until: 5000,
    active_hold_count_at_exec: 0,
    authorization_principal_id: 'principal-dpo',
    authorization_grant_id: 'grant-disp-1',
    executed_by_principal_id: 'principal-operator',
    executed_at: 6000, // >= resolved_retain_until (retention elapsed)
    content_sha256: 'sha256:orig',
    access_history: JSON.stringify([{ principal: 'principal-reader', at: 1900 }]),
    verification_status: 'verified',
    signing_key_id: 'kid-ed25519-1',
    signature_algorithm: 'ed25519',
    signature: 'sig-disp',
    ...overrides,
  } as Record<string, unknown>;
}
const INSERT_DISPOSITION = insertStmt('disposition_record', DISPOSITION_COLS);

// The eight tables the phase creates.
const EXPECTED_TABLES = [
  'retention_policy',
  'legal_hold',
  'evidence_item',
  'evidence_relation',
  'evidence_manifest',
  'evidence_access_log',
  'chain_of_custody',
  'disposition_record',
];

describe('0006_evidence migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename at ordinal 0006', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0006');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('evidence');
    expect(mine!.kind).toBe('expand');
    expect(mine!.up).toContain('evidence_item');
    expect(mine!.up).toContain('disposition_record');
  });

  it('parses the authored filename form — negative control', () => {
    expect(parseMigrationFilename('0006_evidence.sql')).toEqual({
      id: '0006',
      name: 'evidence',
      kind: 'expand',
    });
    expect(parseMigrationFilename('README.md')).toBeNull();
  });

  it('the whole migration set still has unique, ascending ids', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const ids = migrations.map((m) => m.id);
    expect([...ids]).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('0006');
  });
});

describe('0006_evidence migration — schema effect (independent read path)', () => {
  it('creates all eight evidence/provenance/manifest/access/retention/hold/custody/disposition tables', async () => {
    const { db, driver } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0006');
    for (const t of EXPECTED_TABLES) {
      expect(driver.__catalog.tables.has(t), `table ${t} must be created`).toBe(true);
    }
  });

  it('evidence_item is content-addressed with retention + integrity + provenance columns', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const t = driver.__catalog.tables.get('evidence_item')!;
    for (const c of [
      'content_sha256',
      'content_uri',
      'kind',
      'parent_evidence_id',
      'retention_policy_id',
      'retain_until',
      'integrity_status',
      'classification',
      'access_policy_id',
      'status',
    ]) {
      expect(t.columns.has(c), `evidence_item.${c} must exist`).toBe(true);
    }
    // Integrity + content identity are NOT NULL (tamper-evidence anchors).
    for (const c of ['content_sha256', 'content_uri', 'kind', 'integrity_status']) {
      expect(t.notNull.has(c), `evidence_item.${c} must be NOT NULL`).toBe(true);
    }
  });

  it('declares the evidence_item immutable-core UPDATE guard and no-DELETE guard (byte-level)', () => {
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+evidence_item_immutable_core\s+BEFORE\s+UPDATE\s+ON\s+evidence_item[\s\S]*?EXECUTE\s+FUNCTION\s+evidence_item_reject_content_mutation/i,
    );
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+evidence_item_no_delete\s+BEFORE\s+DELETE\s+ON\s+evidence_item[\s\S]*?EXECUTE\s+FUNCTION\s+evidence_item_reject_delete/i,
    );
    // The immutable-core function body references the content digest (content-sensitive guard).
    expect(SQL).toMatch(/content_sha256\s+IS\s+DISTINCT\s+FROM\s+OLD\.content_sha256/i);
  });

  it('declares append-only UPDATE+DELETE guards on relation/manifest/access/custody/disposition (byte-level)', () => {
    for (const [table, upFn, delFn] of [
      ['evidence_relation', 'evidence_relation_reject_update', 'evidence_relation_reject_delete'],
      ['evidence_manifest', 'evidence_manifest_reject_update', 'evidence_manifest_reject_delete'],
      [
        'evidence_access_log',
        'evidence_access_log_reject_update',
        'evidence_access_log_reject_delete',
      ],
      ['chain_of_custody', 'chain_of_custody_reject_update', 'chain_of_custody_reject_delete'],
      [
        'disposition_record',
        'disposition_record_reject_update',
        'disposition_record_reject_delete',
      ],
    ] as const) {
      expect(SQL).toMatch(
        new RegExp(
          `BEFORE\\s+UPDATE\\s+ON\\s+${table}[\\s\\S]*?EXECUTE\\s+FUNCTION\\s+${upFn}`,
          'i',
        ),
      );
      expect(SQL).toMatch(
        new RegExp(
          `BEFORE\\s+DELETE\\s+ON\\s+${table}[\\s\\S]*?EXECUTE\\s+FUNCTION\\s+${delFn}`,
          'i',
        ),
      );
    }
    expect(SQL).toMatch(/RAISE\s+EXCEPTION[\s\S]*?append-only/i);
  });

  it('evidence_manifest carries the signed manifest metadata; disposition_record carries retention+auth+signature', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const man = driver.__catalog.tables.get('evidence_manifest')!;
    for (const c of ['canonical_digest', 'evidence_item_ids', 'signing_key_id', 'signature']) {
      expect(man.columns.has(c), `evidence_manifest.${c} must exist`).toBe(true);
    }
    const disp = driver.__catalog.tables.get('disposition_record')!;
    for (const c of [
      'resolved_retain_until',
      'active_hold_count_at_exec',
      'authorization_principal_id',
      'authorization_grant_id',
      'access_history',
      'signature',
    ]) {
      expect(disp.columns.has(c), `disposition_record.${c} must exist`).toBe(true);
    }
  });

  it('creates the read-path indexes (provenance children, retention sweep, access/custody by item)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes;
    expect(idx.has('evidence_item_parent_idx')).toBe(true);
    expect(idx.has('evidence_item_retention_idx')).toBe(true);
    expect(idx.has('evidence_relation_parent_idx')).toBe(true);
    expect(idx.has('evidence_access_log_item_idx')).toBe(true);
    expect(idx.has('chain_of_custody_item_idx')).toBe(true);
  });
});

describe('0006_evidence — originals immutable / tamper-evident (data-plane effect witness)', () => {
  it('records a committed original and reads it back through an independent SELECT', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    const read = await db.query('SELECT * FROM evidence_item', ['ev-orig-1']);
    expect(read.rowCount).toBe(1);
    const row = read.rows[0] as Record<string, unknown>;
    expect(row.content_sha256).toBe('sha256:orig');
    expect(row.kind).toBe('original');
    expect(row.status).toBe('committed');
  });

  it('REJECTS mutating a committed original’s content digest (tamper-evident) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await expect(
      db.query('UPDATE evidence_item SET content_sha256=$1 WHERE evidence_item_id=$2', [
        'sha256:forged',
        'ev-orig-1',
      ]),
    ).rejects.toMatchObject({ code: expect.any(String) });
    // Independent read: the digest survived unchanged.
    const read = await db.query('SELECT * FROM evidence_item', ['ev-orig-1']);
    expect((read.rows[0] as Record<string, unknown>).content_sha256).toBe('sha256:orig');
  });

  it('REJECTS mutating a committed original’s provenance parent, and hard-DELETE — negative controls', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await expect(
      db.query('UPDATE evidence_item SET parent_evidence_id=$1 WHERE evidence_item_id=$2', [
        'ev-x',
        'ev-orig-1',
      ]),
    ).rejects.toMatchObject({ code: expect.any(String) });
    await expect(
      db.query('DELETE FROM evidence_item WHERE evidence_item_id=$1', ['ev-orig-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
    const read = await db.query('SELECT * FROM evidence_item', ['ev-orig-1']);
    expect(read.rowCount).toBe(1); // still there, undeleted
  });

  it('ALLOWS a lawful lifecycle-only update (integrity_status advance) on a committed original', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(
      INSERT_ITEM,
      params(EVIDENCE_ITEM_COLS, originalItem({ integrity_status: 'unverified' })),
    );
    await db.query('UPDATE evidence_item SET integrity_status=$1 WHERE evidence_item_id=$2', [
      'tampered',
      'ev-orig-1',
    ]);
    const read = await db.query('SELECT * FROM evidence_item', ['ev-orig-1']);
    expect((read.rows[0] as Record<string, unknown>).integrity_status).toBe('tampered');
    // ...but the content identity is still frozen.
    await expect(
      db.query('UPDATE evidence_item SET content_uri=$1 WHERE evidence_item_id=$2', [
        'blob://swapped',
        'ev-orig-1',
      ]),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });
});

describe('0006_evidence — derived items retain provenance + integrity + authorization', () => {
  it('records a derived item with a parent and a provenance edge; reads them back', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, derivedItem()));
    await db.query(INSERT_RELATION, params(RELATION_COLS, relationRow()));

    const child = await db.query('SELECT * FROM evidence_item', ['ev-deriv-1']);
    expect((child.rows[0] as Record<string, unknown>).parent_evidence_id).toBe('ev-orig-1');
    const rel = await db.query('SELECT * FROM evidence_relation', ['rel-1']);
    expect((rel.rows[0] as Record<string, unknown>).relationship).toBe('redacted_from');
    expect((rel.rows[0] as Record<string, unknown>).transformation_digest).toBe('sha256:transform');
  });

  it('REJECTS a derived item with NO parent (provenance retained) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, derivedItem({ parent_evidence_id: null }))),
    ).rejects.toMatchObject({ code: '23514' });
    const read = await db.query('SELECT * FROM evidence_item', ['ev-deriv-1']);
    expect(read.rowCount).toBe(0);
  });

  it('REJECTS an original that claims a parent — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_ITEM,
        params(EVIDENCE_ITEM_COLS, originalItem({ parent_evidence_id: 'ev-x' })),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REJECTS a provenance edge missing its transformation digest (integrity) or authorization', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, derivedItem()));
    // Missing transformation_digest (NOT NULL) → integrity not retained.
    await expect(
      db.query(
        INSERT_RELATION,
        params(RELATION_COLS, relationRow({ transformation_digest: null })),
      ),
    ).rejects.toMatchObject({ code: '23502' });
    // Missing authorization grant → authorization not retained.
    await expect(
      db.query(
        INSERT_RELATION,
        params(RELATION_COLS, relationRow({ authorization_grant_id: null })),
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('REJECTS a self-referential provenance edge (acyclicity base case) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_RELATION,
        params(
          RELATION_COLS,
          relationRow({ parent_evidence_id: 'ev-x', child_evidence_id: 'ev-x' }),
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is append-only: a recorded provenance edge cannot be updated or deleted — negative controls', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, derivedItem()));
    await db.query(INSERT_RELATION, params(RELATION_COLS, relationRow()));
    await expect(
      db.query('UPDATE evidence_relation SET reason=$1 WHERE evidence_relation_id=$2', [
        'x',
        'rel-1',
      ]),
    ).rejects.toMatchObject({ code: expect.any(String) });
    await expect(
      db.query('DELETE FROM evidence_relation WHERE evidence_relation_id=$1', ['rel-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
    const rel = await db.query('SELECT * FROM evidence_relation', ['rel-1']);
    expect(rel.rowCount).toBe(1);
  });
});

describe('0006_evidence — access history + custody are retained (append-only)', () => {
  it('records access-history rows and reads them back; UPDATE/DELETE rejected — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_ACCESS, params(ACCESS_COLS, accessRow()));
    await db.query(
      INSERT_ACCESS,
      params(ACCESS_COLS, accessRow({ access_log_id: 'acc-2', decision: 'denied' })),
    );
    const read = await db.query('SELECT * FROM evidence_access_log', ['tenant-a']);
    expect(read.rowCount).toBe(2);

    await expect(
      db.query('UPDATE evidence_access_log SET decision=$1 WHERE access_log_id=$2', [
        'granted',
        'acc-2',
      ]),
    ).rejects.toMatchObject({ code: expect.any(String) });
    await expect(
      db.query('DELETE FROM evidence_access_log WHERE access_log_id=$1', ['acc-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
    const after = await db.query('SELECT * FROM evidence_access_log', ['tenant-a']);
    expect(after.rowCount).toBe(2); // history complete + unrewritten
  });

  it('records custody transfers in order; a forked sequence is rejected; UPDATE/DELETE rejected', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(
      INSERT_CUSTODY,
      params(CUSTODY_COLS, custodyRow({ custody_id: 'cust-1', sequence: 1 })),
    );
    await db.query(
      INSERT_CUSTODY,
      params(
        CUSTODY_COLS,
        custodyRow({
          custody_id: 'cust-2',
          sequence: 2,
          event_type: 'transferred',
          from_principal_id: 'principal-capture',
          to_principal_id: 'principal-analyst',
        }),
      ),
    );
    const read = await db.query('SELECT * FROM chain_of_custody', ['ev-orig-1']);
    expect(read.rows.map((r) => (r as Record<string, unknown>).sequence)).toEqual([1, 2]);

    // Forked sequence (reuse seq 1) rejected — the chain cannot fork.
    await expect(
      db.query(
        INSERT_CUSTODY,
        params(CUSTODY_COLS, custodyRow({ custody_id: 'cust-3', sequence: 1 })),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // Append-only.
    await expect(
      db.query('DELETE FROM chain_of_custody WHERE custody_id=$1', ['cust-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('REJECTS a custody record with no content digest (integrity at handoff) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(INSERT_CUSTODY, params(CUSTODY_COLS, custodyRow({ content_sha256: null }))),
    ).rejects.toMatchObject({ code: '23502' });
  });
});

describe('0006_evidence — disposition retains retention + authorization + is gated & signed', () => {
  it('records a lawful disposition (retention elapsed, no hold, authorized, signed) and reads it back', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_RETENTION, params(RETENTION_COLS, retentionRow()));
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await db.query(INSERT_DISPOSITION, params(DISPOSITION_COLS, dispositionRow()));
    const read = await db.query('SELECT * FROM disposition_record', ['disp-1']);
    expect(read.rowCount).toBe(1);
    const row = read.rows[0] as Record<string, unknown>;
    expect(row.signature).toBe('sig-disp');
    expect(row.authorization_grant_id).toBe('grant-disp-1');
    expect(row.resolved_retain_until).toBe(5000);
  });

  it('REJECTS a disposition executed BEFORE retention elapses — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_DISPOSITION,
        params(
          DISPOSITION_COLS,
          dispositionRow({ resolved_retain_until: 5000, executed_at: 4000 }),
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const read = await db.query('SELECT * FROM disposition_record', ['disp-1']);
    expect(read.rowCount).toBe(0);
  });

  it('REJECTS a disposition executed WHILE a hold is active — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_DISPOSITION,
        params(DISPOSITION_COLS, dispositionRow({ active_hold_count_at_exec: 1 })),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REJECTS an unauthorized disposition, and an unsigned disposition — negative controls', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_DISPOSITION,
        params(DISPOSITION_COLS, dispositionRow({ authorization_grant_id: null })),
      ),
    ).rejects.toMatchObject({ code: '23502' }); // NOT NULL first
    await expect(
      db.query(INSERT_DISPOSITION, params(DISPOSITION_COLS, dispositionRow({ signature: '' }))),
    ).rejects.toMatchObject({ code: '23514' }); // signed CHECK
  });

  it('a signed disposition record is itself immutable: UPDATE/DELETE rejected — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_RETENTION, params(RETENTION_COLS, retentionRow()));
    await db.query(INSERT_ITEM, params(EVIDENCE_ITEM_COLS, originalItem()));
    await db.query(INSERT_DISPOSITION, params(DISPOSITION_COLS, dispositionRow()));
    await expect(
      db.query('UPDATE disposition_record SET signature=$1 WHERE disposition_id=$2', [
        'x',
        'disp-1',
      ]),
    ).rejects.toMatchObject({ code: expect.any(String) });
    await expect(
      db.query('DELETE FROM disposition_record WHERE disposition_id=$1', ['disp-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('records retention_policy + legal_hold rows and reads them back (retention/hold substrate)', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_RETENTION, params(RETENTION_COLS, retentionRow()));
    await db.query(INSERT_HOLD, params(HOLD_COLS, holdRow()));
    const rp = await db.query('SELECT * FROM retention_policy', ['rp-1']);
    expect((rp.rows[0] as Record<string, unknown>).approved).toBe(true);
    const lh = await db.query('SELECT * FROM legal_hold', ['lh-1']);
    expect((lh.rows[0] as Record<string, unknown>).status).toBe('active');
  });
});

describe('0006_evidence migration — expand-only / dedup / immutability (GAR-010)', () => {
  it('is expand-only: never drops or narrows a supported object', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    const bareDropTrigger = /\bDROP\s+TRIGGER\s+(?!IF\s+EXISTS)/i;
    expect(SQL).not.toMatch(bareDropTrigger);
  });

  it('re-applying is deduplicated: applied once, then skipped with no duplicate effect', async () => {
    const { db, driver } = newDbWithCatalog();
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toContain('0006');
    const trigCountAfterFirst = driver.__catalog.triggers.size;
    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0006');
    expect(driver.__catalog.triggers.size).toBe(trigCountAfterFirst);
  });

  it('records checksum-pinned history readable through an independent read path', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    const history = await readMigrationHistory(db);
    const row = history.find((h) => h.id === '0006');
    expect(row).toBeDefined();
    expect(row!.name).toBe('evidence');
    expect(row!.kind).toBe('expand');
    expect(row!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects editing the applied migration in place — negative control (immutability)', async () => {
    const { db } = newDbWithCatalog();
    const loaded = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, loaded);
    const tampered: Migration[] = loaded.map((m) =>
      m.id === '0006' ? { ...m, up: m.up + '\n-- unauthorized in-place edit\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('migration checksum is content-sensitive (durable witness of change)', () => {
    const base: Migration = { id: '0006', name: 'evidence', kind: 'expand', up: SQL };
    const changed: Migration = { ...base, up: SQL + '\n-- changed\n' };
    expect(checksumMigration(base)).toEqual(checksumMigration({ ...base }));
    expect(checksumMigration(base)).not.toEqual(checksumMigration(changed));
  });
});
