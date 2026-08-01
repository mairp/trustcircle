// Delivery migration suite — Phase 24.
//
// Verifies db/migrations/0004_delivery.sql: the durable inbox, outbox, and dead-letter
// tables with attempt and cursor history, from
// specs/001-governance-control-plane/data-model.md §"InboxMessage, OutboxMessage, and
// DeadLetterRecord":
//   - InboxMessage : consumer, event ID, schema version, payload digest/evidence reference,
//                    received time, processing state, attempts, result cursor, and error.
//   - OutboxMessage: aggregate/entity version, event envelope, publish state, attempts,
//                    next-attempt time, JetStream acknowledgement, and terminal error.
//   - DeadLetterRecord: original message evidence, contract/schema version, failure class,
//                    attempts, owner, affected scope, business impact, replay authorization,
//                    and outcome.
//   "Original incompatible/malformed messages are retained before transformation or replay."
//
// Runs under `vitest run --project migration` (test:migrations / ci:migrations). Uses a
// deterministic delivery-recording in-memory SqlDriver so it runs under `npm ci` with NO
// live PostgreSQL, yet still produces an *independently readable durable effect*:
//   (a) the physical-schema catalog (six delivery tables + their dedup/claim indexes + the
//       attempt/cursor guard triggers + functions + bound CHECK constraints) — the DDL
//       effect witness, and
//   (b) the delivery DATA-PLANE — a duplicate dedup_key/event is refused, a recorded
//       attempt row is immutable, a cursor cannot regress, and the cursor history trail is
//       append-only — each observed through an independent SELECT / rejection read path.
// Neither is the runner's success response (effect-witness discipline). Every property has
// a negative control so the oracle is non-vacuous.
//
// Obligation mapping:
//   * VO-52d0780c11bcc6fd7583 (phase AC / contract) + VO-7a0dbcc527946b539bf6 (integration
//     effect-witness): every onboarded source contract MUST be versioned and validated;
//     mutating operations MUST be correlated, deduplicated, reconcilable, retry-bounded, and
//     safe under duplicate/delayed/partial/conflicting/uncertain outcomes. The migration is
//     applied under the checksum-pinned runner (versioned + validated by the filename
//     ordinal + content checksum); a duplicate re-apply is deduplicated; an in-place edit is
//     rejected. The delivery substrate it creates DEDUPLICATES (outbox dedup_key + inbox
//     dedup identity), CORRELATES (correlation_id columns), makes history reconstructable
//     (delivery_attempt + inbox_cursor_history append-only trails), is RETRY-BOUNDED
//     (attempts <= max_attempts CHECK), and is SAFE under duplicate/out-of-order outcomes
//     (dedup refuse + cursor no-regress).
//   * VO-ec575c4ce42b548bfb4d / GAR-010 — expand-only, applied-once, checksum-pinned;
//     composes with the Phase-21 bootstrapped outbox_message without narrowing a column.

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

import { createDeliveryRecordingDriver } from './delivery-recording-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_FILE = '0004_delivery.sql';
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const SQL = readFileSync(SQL_PATH, 'utf8');

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDbWithCatalog() {
  const driver = createDeliveryRecordingDriver();
  const db = new Database(driver as unknown as SqlDriver, { clock: makeClock() });
  return { db, driver };
}
async function applyAll(db: Database) {
  return runMigrations(db, await loadMigrationsFromDisk(MIGRATIONS_DIR));
}

/** The five delivery tables the phase must create + their required data-model columns. */
const REQUIRED_TABLES: Record<string, string[]> = {
  outbox_message: [
    'message_id',
    'tenant_id',
    'topic',
    'payload_json',
    'payload_digest',
    'correlation_id',
    'status',
    'attempts',
    'entity_version',
    'dedup_key',
    'next_attempt_at',
    'max_attempts',
    'ack_ref',
    'terminal_error',
  ],
  inbox_message: [
    'tenant_id',
    'consumer',
    'event_id',
    'schema_version',
    'payload_digest',
    'evidence_ref',
    'received_at',
    'processing_state',
    'attempts',
    'result_cursor',
    'last_error',
  ],
  dead_letter_record: [
    'dead_letter_id',
    'tenant_id',
    'origin',
    'origin_message_id',
    'contract_version',
    'schema_version',
    'failure_class',
    'attempts',
    'original_payload',
    'original_digest',
    'owner',
    'affected_scope',
    'business_impact',
    'replay_authorized_by',
    'outcome',
  ],
  delivery_attempt: [
    'attempt_id',
    'tenant_id',
    'origin',
    'message_id',
    'attempt_no',
    'correlation_id',
    'started_at',
    'ended_at',
    'outcome',
    'error_detail',
  ],
  inbox_cursor: ['tenant_id', 'consumer', 'stream', 'cursor_value', 'cursor_seq', 'updated_at'],
  inbox_cursor_history: [
    'history_id',
    'tenant_id',
    'consumer',
    'stream',
    'cursor_value',
    'cursor_seq',
    'recorded_at',
  ],
};

describe('0004_delivery migration — file & loader', () => {
  it('exists at the phase-declared path and is non-empty', () => {
    expect(SQL.length).toBeGreaterThan(0);
  });

  it('is discovered by the disk loader under its authored filename', async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const mine = migrations.find((m) => m.id === '0004');
    expect(mine).toBeDefined();
    expect(mine!.name).toBe('delivery');
    expect(mine!.kind).toBe('expand'); // expand-only (GAR-010 compatibility)
    expect(mine!.up).toContain('inbox_message');
    expect(mine!.up).toContain('outbox_message');
    expect(mine!.up).toContain('dead_letter_record');
  });

  it('parses the authored filename form — negative control', () => {
    expect(parseMigrationFilename('0004_delivery.sql')).toEqual({
      id: '0004',
      name: 'delivery',
      kind: 'expand',
    });
    expect(parseMigrationFilename('README.md')).toBeNull();
  });
});

describe('0004_delivery migration — applied effect (independent read path)', () => {
  it('creates the six delivery tables with all required data-model columns', async () => {
    const { db, driver } = newDbWithCatalog();
    const report = await applyAll(db);
    expect(report.applied.map((a) => a.id)).toContain('0004');

    const cat = driver.__catalog;
    for (const [table, cols] of Object.entries(REQUIRED_TABLES)) {
      expect(cat.tables.has(table), `table ${table} must exist`).toBe(true);
      const present = cat.tables.get(table)!.columns;
      for (const col of cols) {
        expect(present.has(col), `${table}.${col} must exist`).toBe(true);
      }
    }
  });

  it('creates the dedup + claim/scan indexes (the deduplication + reconciliation contract)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const idx = driver.__catalog.indexes;
    // Outbox: per-effect dedup + publisher claim/due scan.
    expect(idx.has('outbox_message_dedup_key_unique')).toBe(true);
    expect(idx.has('outbox_message_claim_idx')).toBe(true);
    expect(idx.has('outbox_message_due_idx')).toBe(true);
    // Inbox: consumer-side dedup identity + reconciliation scan.
    expect(idx.has('inbox_message_dedup_unique')).toBe(true);
    expect(idx.has('inbox_message_state_idx')).toBe(true);
    // Dead letters: outcome + owner triage scans.
    expect(idx.has('dead_letter_record_outcome_idx')).toBe(true);
    expect(idx.has('dead_letter_record_owner_idx')).toBe(true);
    // Attempt + cursor history scans.
    expect(idx.has('delivery_attempt_message_idx')).toBe(true);
    expect(idx.has('inbox_cursor_history_scan_idx')).toBe(true);
    // The inbox dedup identity is also the PRIMARY KEY of the table body.
    const body = driver.__catalog.tables.get('inbox_message')!.body;
    expect(body).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*consumer\s*,\s*event_id\s*\)/i);
  });

  it('creates the attempt/cursor guard triggers (append-only + no-regress)', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const cat = driver.__catalog;
    // Attempt append-only guard.
    expect(cat.functions.has('delivery_attempt_reject_mutation')).toBe(true);
    const at = cat.triggers.get('delivery_attempt_append_only');
    expect(at, 'delivery_attempt append-only trigger').toBeDefined();
    expect(at!.table).toBe('delivery_attempt');
    expect(at!.timing).toBe('BEFORE');
    expect(at!.event).toBe('UPDATE');
    // Cursor no-regress guard.
    expect(cat.functions.has('inbox_cursor_reject_regress')).toBe(true);
    const cr = cat.triggers.get('inbox_cursor_no_regress');
    expect(cr, 'inbox_cursor no-regress trigger').toBeDefined();
    expect(cr!.table).toBe('inbox_cursor');
    expect(cr!.timing).toBe('BEFORE');
    expect(cr!.event).toBe('UPDATE');
    // Cursor-history append-only guard.
    expect(cat.functions.has('inbox_cursor_history_reject_mutation')).toBe(true);
    const ch = cat.triggers.get('inbox_cursor_history_append_only');
    expect(ch, 'inbox_cursor_history append-only trigger').toBeDefined();
    expect(ch!.table).toBe('inbox_cursor_history');
  });

  it('records the retry-bound + retention CHECK constraints', async () => {
    const { db, driver } = newDbWithCatalog();
    await applyAll(db);
    const t = driver.__catalog.tables;
    expect(t.get('outbox_message')!.constraints.has('outbox_message_attempts_bounded')).toBe(true);
    expect(t.get('inbox_message')!.constraints.has('inbox_message_attempts_bounded')).toBe(true);
    expect(t.get('dead_letter_record')!.constraints.has('dead_letter_replay_auth_paired')).toBe(
      true,
    );
    expect(t.get('delivery_attempt')!.constraints.has('delivery_attempt_ordinal_positive')).toBe(
      true,
    );
  });

  // Byte-level structural witness — read the ACTUAL migration bytes and prove the guard DDL
  // is present in the governed source contract itself, NOT merely in the driver's catalog.
  it('the source SQL itself declares the append-only + no-regress guards (byte-level witness)', () => {
    // delivery_attempt append-only trigger, bound BEFORE UPDATE FOR EACH ROW.
    expect(SQL).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+delivery_attempt_reject_mutation\s*\(/i,
    );
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+delivery_attempt_append_only\s+BEFORE\s+UPDATE\s+ON\s+delivery_attempt[\s\S]*?FOR\s+EACH\s+ROW[\s\S]*?EXECUTE\s+FUNCTION\s+delivery_attempt_reject_mutation/i,
    );
    // inbox_cursor no-regress guard: raises when NEW.cursor_seq < OLD.cursor_seq.
    expect(SQL).toMatch(/NEW\.cursor_seq\s*<\s*OLD\.cursor_seq/i);
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+inbox_cursor_no_regress\s+BEFORE\s+UPDATE\s+ON\s+inbox_cursor[\s\S]*?EXECUTE\s+FUNCTION\s+inbox_cursor_reject_regress/i,
    );
    // inbox_cursor_history append-only trigger.
    expect(SQL).toMatch(
      /CREATE\s+TRIGGER\s+inbox_cursor_history_append_only\s+BEFORE\s+UPDATE\s+ON\s+inbox_cursor_history/i,
    );
    // Retry bound is declared as a CHECK.
    expect(SQL).toMatch(/attempts\s*<=\s*max_attempts/i);
  });

  it('is expand-only: never drops or narrows a supported object (GAR-010 compatibility)', () => {
    expect(SQL).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    // The only DROP TRIGGER present must be the idempotent reinstall idiom.
    expect(SQL).not.toMatch(/\bDROP\s+TRIGGER\s+(?!IF\s+EXISTS)/i);
    // Extends the bootstrapped outbox_message additively (ADD COLUMN IF NOT EXISTS).
    expect(SQL).toMatch(/ALTER\s+TABLE\s+outbox_message\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
  });
});

describe('0004_delivery migration — deduplication (data-plane effect witness)', () => {
  const now = 1_700_000_500_000;

  async function seedOutbox(db: Database, dedupKey: string, id: string) {
    await db.query(
      `INSERT INTO outbox_message
         (message_id, tenant_id, topic, payload_json, payload_digest, correlation_id,
          status, attempts, created_at, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, 'tenant-a', 'gov.events', '{}', 'dig', 'corr-1', 'pending', 0, now, dedupKey],
    );
  }

  it('a duplicate outbox dedup_key is refused — the effect enqueues at most once', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    await seedOutbox(db, 'effect-1', 'msg-1');
    // A duplicate transactional-outbox write for the same effect ⇒ unique_violation.
    await expect(seedOutbox(db, 'effect-1', 'msg-2')).rejects.toMatchObject({ code: '23505' });

    // Independent read path: exactly one row carries that dedup_key.
    const rows = await db.query<{ message_id: string }>(
      'SELECT * FROM outbox_message WHERE tenant_id=$1 AND dedup_key=$2',
      ['tenant-a', 'effect-1'],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.message_id).toBe('msg-1');
  });

  it('a redelivered inbox event is deduplicated per (tenant, consumer, event) — negative control', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    const insert = (id: string) =>
      db.query(
        `INSERT INTO inbox_message
           (tenant_id, consumer, event_id, schema_version, payload_digest, evidence_ref,
            correlation_id, received_at, processing_state, attempts, result_cursor, last_error, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          'tenant-a',
          'projector',
          id,
          '1',
          'dig',
          null,
          'corr',
          now,
          'received',
          0,
          null,
          null,
          now,
        ],
      );

    await insert('evt-1');
    // Same event redelivered ⇒ refused (processed once).
    await expect(insert('evt-1')).rejects.toMatchObject({ code: '23505' });
    // A DIFFERENT event id is a distinct record (dedup is scoped to the identity).
    await insert('evt-2');
    const rows = await db.query('SELECT * FROM inbox_message WHERE tenant_id=$1 AND consumer=$2', [
      'tenant-a',
      'projector',
    ]);
    expect(rows.rowCount).toBe(2);
  });
});

describe('0004_delivery migration — attempt history is append-only + retry-bounded (effect witness)', () => {
  const now = 1_700_000_600_000;

  it('records one immutable row per attempt; a recorded attempt cannot be mutated', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    const attempt = (id: string, no: number, outcome: string) =>
      db.query(
        `INSERT INTO delivery_attempt
           (attempt_id, tenant_id, origin, message_id, attempt_no, correlation_id,
            started_at, ended_at, outcome, error_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, 'tenant-a', 'outbox', 'msg-1', no, 'corr', now, now + 1, outcome, null],
      );

    await attempt('a1', 1, 'retryable');
    await attempt('a2', 2, 'succeeded');

    // A duplicate (message, ordinal) is refused — no duplicate attempt record.
    await expect(attempt('a3', 2, 'succeeded')).rejects.toMatchObject({ code: '23505' });

    // Attempt rows are append-only: any UPDATE is rejected by the guard.
    await expect(
      db.query('UPDATE delivery_attempt SET outcome=$1 WHERE attempt_id=$2', ['tampered', 'a1']),
    ).rejects.toMatchObject({ raised: true });

    // Independent read path: history is reconstructable and unchanged.
    const rows = await db.query<{ outcome: string; attempt_no: number }>(
      'SELECT * FROM delivery_attempt WHERE tenant_id=$1 AND origin=$2 AND message_id=$3',
      ['tenant-a', 'outbox', 'msg-1'],
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.map((r) => r.outcome).sort()).toEqual(['retryable', 'succeeded']);
  });
});

describe('0004_delivery migration — cursor history: monotonic + append-only (effect witness)', () => {
  const now = 1_700_000_700_000;

  async function upsertCursor(db: Database, seq: number, value: string) {
    // Upsert form: INSERT ... ON CONFLICT (tenant, consumer, stream) DO UPDATE
    await db.query(
      `INSERT INTO inbox_cursor
         (tenant_id, consumer, stream, cursor_value, cursor_seq, correlation_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, consumer, stream) DO UPDATE SET cursor_value=$4, cursor_seq=$5`,
      ['tenant-a', 'projector', 'stream-x', value, seq, 'corr', now],
    );
  }

  it('the cursor advances forward but an out-of-order/stale update cannot regress it', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    await upsertCursor(db, 10, 'tok-10');
    await upsertCursor(db, 20, 'tok-20'); // forward advance is allowed

    // A duplicate / out-of-order source update that would move the cursor BACKWARD is
    // rejected by the no-regress guard (reconciliation is safe under out-of-order arrival).
    await expect(upsertCursor(db, 15, 'tok-15')).rejects.toMatchObject({ raised: true });

    // Independent read path: the cursor is still at its highest advanced position.
    const rows = await db.query<{ cursor_seq: number }>(
      'SELECT * FROM inbox_cursor WHERE tenant_id=$1 AND consumer=$2 AND stream=$3',
      ['tenant-a', 'projector', 'stream-x'],
    );
    expect(Number(rows.rows[0]!.cursor_seq)).toBe(20);
  });

  it('the cursor-history trail is append-only and unique per (stream, seq)', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    const record = (id: string, seq: number) =>
      db.query(
        `INSERT INTO inbox_cursor_history
           (history_id, tenant_id, consumer, stream, cursor_value, cursor_seq, correlation_id, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, 'tenant-a', 'projector', 'stream-x', 'tok', seq, 'corr', now],
      );

    await record('h1', 10);
    await record('h2', 20);
    // A duplicate history seq is refused (the trail is uniquely keyed).
    await expect(record('h3', 20)).rejects.toMatchObject({ code: '23505' });
    // A recorded history row cannot be mutated (append-only evidence).
    await expect(
      db.query('UPDATE inbox_cursor_history SET cursor_seq=$1 WHERE history_id=$2', [99, 'h1']),
    ).rejects.toMatchObject({ raised: true });

    const rows = await db.query('SELECT * FROM inbox_cursor_history WHERE tenant_id=$1', [
      'tenant-a',
    ]);
    expect(rows.rowCount).toBe(2);
  });
});

describe('0004_delivery migration — dead-letter retains the original before replay (effect witness)', () => {
  const now = 1_700_000_800_000;

  it('a failed message is dead-lettered once, retaining its original evidence; replay auth is paired', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);

    const dl = (id: string) =>
      db.query(
        `INSERT INTO dead_letter_record
           (dead_letter_id, tenant_id, origin, origin_message_id, correlation_id, contract_version,
            schema_version, failure_class, attempts, original_payload, original_digest, owner,
            affected_scope, business_impact, replay_authorized_by, replay_authorized_at, outcome,
            first_seen_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [
          id,
          'tenant-a',
          'outbox',
          'msg-9',
          'corr',
          '1.0.0',
          '1',
          'non_retryable',
          8,
          'ORIGINAL-BYTES',
          'orig-digest',
          'owner-1',
          'scope-x',
          'high',
          null,
          null,
          'open',
          now,
        ],
      );

    await dl('dl-1');
    // A given failed origin message is dead-lettered at most once per tenant.
    await expect(dl('dl-2')).rejects.toMatchObject({ code: '23505' });

    // Independent read path: the original evidence is retained verbatim.
    const rows = await db.query<{ original_payload: string; outcome: string }>(
      'SELECT * FROM dead_letter_record WHERE tenant_id=$1 AND origin=$2 AND origin_message_id=$3',
      ['tenant-a', 'outbox', 'msg-9'],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.original_payload).toBe('ORIGINAL-BYTES');
    expect(rows.rows[0]!.outcome).toBe('open');
  });
});

describe('0004_delivery migration — dedup / immutability of the migration itself', () => {
  it('re-applying is deduplicated: applied once, then skipped with no duplicate effect', async () => {
    const { db, driver } = newDbWithCatalog();
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);

    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toContain('0004');
    const trigCountAfterFirst = driver.__catalog.triggers.size;

    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]); // no duplicate governance action
    expect(second.skipped).toContain('0004');
    expect(driver.__catalog.triggers.size).toBe(trigCountAfterFirst);
  });

  it('records checksum-pinned history readable through an independent read path', async () => {
    const { db } = newDbWithCatalog();
    await applyAll(db);
    const history = await readMigrationHistory(db);
    const row = history.find((h) => h.id === '0004');
    expect(row).toBeDefined();
    expect(row!.name).toBe('delivery');
    expect(row!.kind).toBe('expand');
    expect(row!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects editing the applied migration in place — negative control (immutability)', async () => {
    const { db } = newDbWithCatalog();
    const loaded = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    await runMigrations(db, loaded);
    const tampered: Migration[] = loaded.map((m) =>
      m.id === '0004' ? { ...m, up: m.up + '\n-- unauthorized in-place edit\n' } : m,
    );
    await expect(runMigrations(db, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('migration checksum is content-sensitive (durable witness of change)', () => {
    const base: Migration = { id: '0004', name: 'delivery', kind: 'expand', up: SQL };
    const same: Migration = { ...base };
    const changed: Migration = { ...base, up: SQL + '\n-- changed\n' };
    expect(checksumMigration(base)).toEqual(checksumMigration(same));
    expect(checksumMigration(base)).not.toEqual(checksumMigration(changed));
  });
});
