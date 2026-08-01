// Audit-ledger migration suite — Phase 29 (task T029 / GAR-002).
//
// Verifies db/migrations/0005_audit_ledger.sql: the APPEND-ONLY, HASH-CHAINED tenant audit
// ledger (audit_event) and the SIGNED CHECKPOINT metadata (audit_checkpoint), from
// specs/001-governance-control-plane/data-model.md §"AuditEvent" and §"AuditCheckpoint".
//
// Phase acceptance criterion (VO-d76c5d1293b91d26e094, contract / positive):
//   "Every decision and automated action MUST capture actor or principal, accountable owner,
//    reason, source and target state, policy and control versions, evidence, scope, time,
//    correlation, and outcome before it can be reported as complete."
//
// This suite maps EACH clause of that criterion to an independently observable durable effect:
//   * a byte-level witness that the governed SQL contract itself declares the mandatory
//     accountability column (NOT NULL) or CHECK, AND
//   * a data-plane effect witness: an INSERT that omits that accountability field (or violates
//     the completed-governed CHECK) is REJECTED by the emulated constraint — so an action that
//     is missing the field cannot be recorded and therefore cannot be reported complete — while
//     a fully-populated action IS recorded and read back through an independent SELECT path.
// Every property has a negative control (the rejecting insert) so the oracle is non-vacuous.
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses a
// deterministic in-memory SqlDriver so it runs under `npm ci` with NO live PostgreSQL. The
// effect is NOT the runner's success response (effect-witness discipline) — it is the durable
// catalog + the immutable, hash-linked rows observed via SELECT.
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

import { createAuditLedgerRecordingDriver } from './audit-ledger-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0005_audit_ledger.sql';
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const SQL = readFileSync(SQL_PATH, 'utf8');

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDbWithCatalog() {
  const driver = createAuditLedgerRecordingDriver();
  const db = new Database(driver as unknown as SqlDriver, { clock: makeClock() });
  return { db, driver };
}
async function applyAll(db: Database) {
  return runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
}

// The accountability columns the AC requires the ledger row to carry, mapped to the AC clause.
const ACCOUNTABILITY_COLUMNS: Array<{ clause: string; columns: string[]; notNull?: boolean }> = [
  {
    clause: 'actor or principal',
    columns: ['actor_principal_id', 'actor_is_system', 'automation_id'],
  },
  { clause: 'accountable owner', columns: ['accountable_owner_principal_id'], notNull: true },
  { clause: 'reason', columns: ['reason_code', 'reason_text'] },
  {
    clause: 'source and target state',
    columns: ['source_state_digest', 'target_state_digest', 'actual_state_digest'],
  },
  {
    clause: 'policy and control versions',
    columns: ['policy_version_ids', 'control_version_ids'],
    notNull: true,
  },
  { clause: 'evidence', columns: ['evidence_manifest_id'] },
  { clause: 'scope', columns: ['requested_scope', 'actual_scope'], notNull: true },
  { clause: 'time', columns: ['occurred_at', 'recorded_at'], notNull: true },
  { clause: 'correlation', columns: ['correlation_id', 'causation_id', 'trace_id'] },
  { clause: 'outcome', columns: ['outcome'], notNull: true },
];

// A fully-populated, spec-complete governed audit event (positive control). Values are the
// positional params in the driver's EVENT_COLS order.
function completeEvent(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    audit_event_id: 'ae-1',
    tenant_id: 'tenant-a',
    ledger_id: 'ledger-a',
    sequence: 1,
    event_type: 'decision.approved',
    schema_version: '1.0.0',
    actor_principal_id: 'principal-approver',
    actor_role_assignment_id: 'ra-1',
    actor_is_system: false,
    automation_id: null,
    accountable_owner_principal_id: 'principal-owner',
    reason_code: 'APPROVED_WITHIN_POLICY',
    reason_text: 'Reviewed decision package; within current policy bounds.',
    entity_type: 'decision_request',
    entity_id: 'dr-9',
    entity_version: '3',
    source_state_digest: 'sha256:source',
    target_state_digest: 'sha256:target',
    actual_state_digest: null,
    policy_version_ids: ['pol-v1'],
    control_version_ids: ['ctl-v1'],
    evidence_manifest_id: 'em-1',
    requested_scope: JSON.stringify({ tenants: ['tenant-a'] }),
    actual_scope: JSON.stringify({ tenants: ['tenant-a'] }),
    outcome: 'succeeded',
    occurred_at: 1700,
    recorded_at: 1700,
    correlation_id: 'corr-1',
    causation_id: 'cause-1',
    trace_id: 'trace-1',
    previous_digest: 'GENESIS',
    integrity_digest: 'digest-seq-1',
    ...overrides,
  };
  return base;
}

const EVENT_COLS = [
  'audit_event_id',
  'tenant_id',
  'ledger_id',
  'sequence',
  'event_type',
  'schema_version',
  'actor_principal_id',
  'actor_role_assignment_id',
  'actor_is_system',
  'automation_id',
  'accountable_owner_principal_id',
  'reason_code',
  'reason_text',
  'entity_type',
  'entity_id',
  'entity_version',
  'source_state_digest',
  'target_state_digest',
  'actual_state_digest',
  'policy_version_ids',
  'control_version_ids',
  'evidence_manifest_id',
  'requested_scope',
  'actual_scope',
  'outcome',
  'occurred_at',
  'recorded_at',
  'correlation_id',
  'causation_id',
  'trace_id',
  'previous_digest',
  'integrity_digest',
];
const EVENT_PLACEHOLDERS = EVENT_COLS.map((_, i) => `$${i + 1}`).join(',');
const INSERT_EVENT = `INSERT INTO audit_event (${EVENT_COLS.join(',')}) VALUES (${EVENT_PLACEHOLDERS})`;
function eventParams(row: Record<string, unknown>) {
  return EVENT_COLS.map((c) => row[c]);
}

describe('0005_audit_ledger migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename at ordinal 0005', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0005');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('audit_ledger');
    expect(mine!.kind).toBe('expand');
    expect(mine!.up).toContain('audit_event');
    expect(mine!.up).toContain('audit_checkpoint');
  });

  it('parses the authored filename form — negative control', () => {
    expect(parseMigrationFilename('0005_audit_ledger.sql')).toEqual({
      id: '0005',
      name: 'audit_ledger',
      kind: 'expand',
    });
    expect(parseMigrationFilename('README.md')).toBeNull();
  });

  it('the whole migration set still has unique, ascending ids after the 0005/0006 renumber', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const ids = migrations.map((m) => m.id);
    expect([...ids]).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ordinal
    expect(ids).toContain('0005'); // audit_ledger
    expect(ids).toContain('0007'); // renumbered outbox_claim
    expect(ids).toContain('0008'); // renumbered inbox_payload
  });
});

describe('0005_audit_ledger migration — schema effect (independent read path)', () => {
  it('creates audit_event and audit_checkpoint tables', async () => {
    const { db, driver } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0005');
    expect(driver.__catalog.tables.has('audit_event')).toBe(true);
    expect(driver.__catalog.tables.has('audit_checkpoint')).toBe(true);
  });

  it('audit_event carries every accountability column the AC requires', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cols = driver.__catalog.tables.get('audit_event')!.columns;
    for (const { clause, columns } of ACCOUNTABILITY_COLUMNS) {
      for (const c of columns) {
        expect(cols.has(c), `AC clause "${clause}" needs audit_event.${c}`).toBe(true);
      }
    }
    // hash-chain columns (tamper-evidence).
    expect(cols.has('previous_digest')).toBe(true);
    expect(cols.has('integrity_digest')).toBe(true);
  });

  it('the mandatory accountability columns are declared NOT NULL in the governed SQL', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const notNull = driver.__catalog.tables.get('audit_event')!.notNull;
    for (const { clause, columns, notNull: mustBeNotNull } of ACCOUNTABILITY_COLUMNS) {
      if (!mustBeNotNull) continue;
      for (const c of columns) {
        expect(notNull.has(c), `AC clause "${clause}": audit_event.${c} must be NOT NULL`).toBe(
          true,
        );
      }
    }
    // Correlation + reason machine code + state digests + entity are also NOT NULL.
    for (const c of [
      'reason_code',
      'source_state_digest',
      'target_state_digest',
      'correlation_id',
      'previous_digest',
      'integrity_digest',
    ]) {
      expect(notNull.has(c), `${c} must be NOT NULL`).toBe(true);
    }
  });

  it('declares the append-only UPDATE and DELETE guards on both ledger tables (byte-level witness)', () => {
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+audit_event_append_only_update\s+BEFORE\s+UPDATE\s+ON\s+audit_event[\s\S]*?EXECUTE\s+FUNCTION\s+audit_event_reject_update/i,
    );
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+audit_event_append_only_delete\s+BEFORE\s+DELETE\s+ON\s+audit_event[\s\S]*?EXECUTE\s+FUNCTION\s+audit_event_reject_delete/i,
    );
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+audit_checkpoint_append_only_update\s+BEFORE\s+UPDATE\s+ON\s+audit_checkpoint/i,
    );
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+audit_checkpoint_append_only_delete\s+BEFORE\s+DELETE\s+ON\s+audit_checkpoint/i,
    );
    expect(SQL).toMatch(/RAISE\s+EXCEPTION[\s\S]*?append-only/i);
  });

  it('audit_checkpoint carries the SIGNED checkpoint metadata (root digest + key + signature)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cols = driver.__catalog.tables.get('audit_checkpoint')!.columns;
    for (const c of [
      'ledger_id',
      'first_sequence',
      'last_sequence',
      'event_count',
      'root_digest',
      'signing_key_id',
      'signature_algorithm',
      'signature',
      'evidence_item_id',
      'generated_at',
      'status',
      'external_anchor_ref',
    ]) {
      expect(cols.has(c), `audit_checkpoint.${c} must exist`).toBe(true);
    }
    const nn = driver.__catalog.tables.get('audit_checkpoint')!.notNull;
    for (const c of ['root_digest', 'signing_key_id', 'signature', 'signature_algorithm']) {
      expect(nn.has(c), `audit_checkpoint.${c} must be NOT NULL (signed)`).toBe(true);
    }
  });

  it('creates the read-path indexes for ordered/correlated ledger reads', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes;
    expect(idx.has('audit_event_ledger_order_idx')).toBe(true);
    expect(idx.has('audit_event_correlation_idx')).toBe(true);
    expect(idx.has('audit_checkpoint_ledger_idx')).toBe(true);
  });
});

describe('0005_audit_ledger migration — accountability contract (data-plane effect witness)', () => {
  it('records a fully-populated governed action and reads it back through an independent SELECT', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_EVENT, eventParams(completeEvent()));

    const read = await db.query('SELECT * FROM audit_event', ['tenant-a', 'ledger-a']);
    expect(read.rowCount).toBe(1);
    const row = read.rows[0] as Record<string, unknown>;
    expect(row.accountable_owner_principal_id).toBe('principal-owner');
    expect(row.outcome).toBe('succeeded');
    expect(row.correlation_id).toBe('corr-1');
    expect(row.integrity_digest).toBe('digest-seq-1');
  });

  // One rejection test per AC clause whose column is a mandatory NOT NULL: omit exactly that
  // field and prove the INSERT is refused (the action cannot be recorded/completed).
  for (const nullable of [
    { clause: 'accountable owner', col: 'accountable_owner_principal_id' },
    { clause: 'reason (machine code)', col: 'reason_code' },
    { clause: 'source state', col: 'source_state_digest' },
    { clause: 'target state', col: 'target_state_digest' },
    { clause: 'time (occurred)', col: 'occurred_at' },
    { clause: 'time (recorded)', col: 'recorded_at' },
    { clause: 'correlation', col: 'correlation_id' },
    { clause: 'outcome', col: 'outcome' },
    { clause: 'hash-chain link', col: 'previous_digest' },
    { clause: 'integrity digest', col: 'integrity_digest' },
  ]) {
    it(`REJECTS an action missing "${nullable.clause}" (${nullable.col}) — negative control`, async () => {
      const { db } = newDbWithCatalog();
      await applyAll(db);
      await expect(
        db.query(INSERT_EVENT, eventParams(completeEvent({ [nullable.col]: null }))),
      ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
      // Independent read path: nothing was recorded.
      const read = await db.query('SELECT * FROM audit_event', ['tenant-a', 'ledger-a']);
      expect(read.rowCount).toBe(0);
    });
  }

  it('REJECTS a COMPLETED governed action missing policy/control versions or evidence — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    // succeeded governed action but empty policy versions.
    await expect(
      db.query(INSERT_EVENT, eventParams(completeEvent({ policy_version_ids: [] }))),
    ).rejects.toMatchObject({ code: '23514' });
    // succeeded governed action but no evidence manifest.
    await expect(
      db.query(INSERT_EVENT, eventParams(completeEvent({ evidence_manifest_id: null }))),
    ).rejects.toMatchObject({ code: '23514' });
    const read = await db.query('SELECT * FROM audit_event', ['tenant-a', 'ledger-a']);
    expect(read.rowCount).toBe(0);
  });

  it('REJECTS a human action with no reason_text (AC: reason) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_EVENT,
        eventParams(completeEvent({ actor_is_system: false, reason_text: null })),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REJECTS an action with no actor and no system automation id (AC: actor/principal) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(
        INSERT_EVENT,
        eventParams(
          completeEvent({ actor_principal_id: null, actor_is_system: false, automation_id: null }),
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ACCEPTS a system/automated action (actor_is_system + automation_id, no reason_text)', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    // A system action is exempt from reason_text AND from the governed-completion evidence CHECK,
    // but still must carry accountable owner, state, scope, time, correlation, outcome, chain.
    await db.query(
      INSERT_EVENT,
      eventParams(
        completeEvent({
          actor_principal_id: null,
          actor_role_assignment_id: null,
          actor_is_system: true,
          automation_id: 'integrity-detector',
          reason_text: null,
          policy_version_ids: [],
          control_version_ids: [],
          evidence_manifest_id: null,
          outcome: 'succeeded',
        }),
      ),
    );
    const read = await db.query('SELECT * FROM audit_event', ['tenant-a', 'ledger-a']);
    expect(read.rowCount).toBe(1);
    expect((read.rows[0] as Record<string, unknown>).actor_is_system).toBe(true);
  });

  it('REJECTS recorded_at before occurred_at (AC: time is coherent) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await expect(
      db.query(INSERT_EVENT, eventParams(completeEvent({ occurred_at: 2000, recorded_at: 1000 }))),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('0005_audit_ledger migration — append-only + hash chain (tamper-evidence)', () => {
  it('rejects UPDATE and DELETE of a recorded ledger row; the row is unchanged via SELECT', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    await db.query(INSERT_EVENT, eventParams(completeEvent()));

    await expect(
      db.query('UPDATE audit_event SET outcome=$1 WHERE audit_event_id=$2', ['failed', 'ae-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
    await expect(
      db.query('DELETE FROM audit_event WHERE audit_event_id=$1', ['ae-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });

    const read = await db.query('SELECT * FROM audit_event', ['tenant-a', 'ledger-a']);
    expect(read.rowCount).toBe(1);
    expect((read.rows[0] as Record<string, unknown>).outcome).toBe('succeeded'); // survived
  });

  it('links rows into a hash chain and rejects a forked (duplicate integrity_digest) row', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    // seq 1 (genesis) then seq 2 chained to seq 1's integrity_digest.
    await db.query(
      INSERT_EVENT,
      eventParams(
        completeEvent({
          sequence: 1,
          audit_event_id: 'ae-1',
          integrity_digest: 'd1',
          previous_digest: 'GENESIS',
        }),
      ),
    );
    await db.query(
      INSERT_EVENT,
      eventParams(
        completeEvent({
          sequence: 2,
          audit_event_id: 'ae-2',
          integrity_digest: 'd2',
          previous_digest: 'd1',
        }),
      ),
    );

    const read = await db.query('SELECT * FROM audit_event', ['tenant-a', 'ledger-a']);
    expect(read.rows.map((r) => (r as Record<string, unknown>).previous_digest)).toEqual([
      'GENESIS',
      'd1',
    ]); // chain observed in order via independent read path

    // A second row re-using an existing integrity_digest would fork the chain — rejected.
    await expect(
      db.query(
        INSERT_EVENT,
        eventParams(
          completeEvent({
            sequence: 3,
            audit_event_id: 'ae-3',
            integrity_digest: 'd1',
            previous_digest: 'd2',
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('records and reads back a SIGNED checkpoint; rejects a range whose count mismatches', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    const CP_COLS = [
      'checkpoint_id',
      'tenant_id',
      'ledger_id',
      'first_sequence',
      'last_sequence',
      'event_count',
      'root_digest',
      'head_integrity_digest',
      'previous_root_digest',
      'generated_at',
      'signing_key_id',
      'signature_algorithm',
      'signature',
      'evidence_item_id',
      'status',
      'verification_history',
      'external_anchor_ref',
    ];
    const ph = CP_COLS.map((_, i) => `$${i + 1}`).join(',');
    const INSERT_CP = `INSERT INTO audit_checkpoint (${CP_COLS.join(',')}) VALUES (${ph})`;
    const good = {
      checkpoint_id: 'cp-1',
      tenant_id: 'tenant-a',
      ledger_id: 'ledger-a',
      first_sequence: 1,
      last_sequence: 3,
      event_count: 3,
      root_digest: 'root-abc',
      head_integrity_digest: 'd3',
      previous_root_digest: null,
      generated_at: 1800,
      signing_key_id: 'kid-ed25519-1',
      signature_algorithm: 'ed25519',
      signature: 'sig-xyz',
      evidence_item_id: 'ev-cp-1',
      status: 'signed',
      verification_history: JSON.stringify([]),
      external_anchor_ref: null,
    } as Record<string, unknown>;
    await db.query(
      INSERT_CP,
      CP_COLS.map((c) => good[c]),
    );
    const read = await db.query('SELECT * FROM audit_checkpoint', ['cp-1']);
    expect(read.rowCount).toBe(1);
    expect((read.rows[0] as Record<string, unknown>).signature).toBe('sig-xyz');
    expect((read.rows[0] as Record<string, unknown>).root_digest).toBe('root-abc');

    // Negative control: event_count that doesn't match the range is rejected.
    await expect(
      db.query(
        INSERT_CP,
        CP_COLS.map((c) => ({ ...good, checkpoint_id: 'cp-2', event_count: 99 })[c]),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Negative control: a signed checkpoint cannot be mutated or deleted (append-only).
    await expect(
      db.query('UPDATE audit_checkpoint SET signature=$1 WHERE checkpoint_id=$2', ['x', 'cp-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
    await expect(
      db.query('DELETE FROM audit_checkpoint WHERE checkpoint_id=$1', ['cp-1']),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });
});

describe('0005_audit_ledger migration — expand-only / dedup / immutability (GAR-010)', () => {
  it('is expand-only: never drops or narrows a supported object', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    // The only DROP TRIGGER present must be the idempotent reinstall idiom (IF EXISTS then CREATE).
    const bareDropTrigger = /\bDROP\s+TRIGGER\s+(?!IF\s+EXISTS)/i;
    expect(SQL).not.toMatch(bareDropTrigger);
  });

  it('re-applying is deduplicated: applied once, then skipped with no duplicate effect', async () => {
    const { db, driver } = newDbWithCatalog();
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toContain('0005');
    const trigCountAfterFirst = driver.__catalog.triggers.size;
    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0005');
    expect(driver.__catalog.triggers.size).toBe(trigCountAfterFirst);
  });

  it('records checksum-pinned history readable through an independent read path', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    const history = await readMigrationHistory(db);
    const row = history.find((h) => h.id === '0005');
    expect(row).toBeDefined();
    expect(row!.name).toBe('audit_ledger');
    expect(row!.kind).toBe('expand');
    expect(row!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects editing the applied migration in place — negative control (immutability)', async () => {
    const { db } = newDbWithCatalog();
    const loaded = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, loaded);
    const tampered: Migration[] = loaded.map((m) =>
      m.id === '0005' ? { ...m, up: m.up + '\n-- unauthorized in-place edit\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('migration checksum is content-sensitive (durable witness of change)', () => {
    const base: Migration = { id: '0005', name: 'audit_ledger', kind: 'expand', up: SQL };
    const changed: Migration = { ...base, up: SQL + '\n-- changed\n' };
    expect(checksumMigration(base)).toEqual(checksumMigration({ ...base }));
    expect(checksumMigration(base)).not.toEqual(checksumMigration(changed));
  });
});
