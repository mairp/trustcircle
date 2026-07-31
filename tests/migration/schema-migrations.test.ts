// Migration suite — ordered, applied-once, checksum-pinned expand→migrate→contract runner
// (packages/persistence/src/database.ts; Phase 17 / VO-ec575c4ce42b548bfb4d compatibility leg,
// VO-52d0780c11bcc6fd7583 mutating-operation safety).
//
// Runs under `vitest run --project migration` (wired by `test:migrations` / `ci:migrations`).
// Uses the deterministic in-memory SqlDriver so it runs with no live PostgreSQL. Every property
// has a negative control so the oracle is non-vacuous.

import { describe, it, expect } from 'vitest';

import {
  Database,
  runMigrations,
  readMigrationHistory,
  assertMigrationOrder,
  checksumMigration,
  MigrationChecksumError,
  type Migration,
  type SqlDriver,
} from '../../packages/persistence/src/database.ts';

import { createInMemoryDriver } from '../persistence/in-memory-driver.mjs';

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}
function newDb() {
  return new Database(createInMemoryDriver() as unknown as SqlDriver, { clock: makeClock() });
}
const M = (id: string, name: string, kind: Migration['kind'], up: string): Migration => ({
  id,
  name,
  kind,
  up,
});

describe('migration runner (expand→migrate→contract)', () => {
  it('applies each migration exactly once and skips already-applied on re-run', async () => {
    const db = newDb();
    const migrations = [
      M('0001', 'init', 'expand', 'CREATE TABLE canonical_state (id uuid PRIMARY KEY)'),
      M('0002', 'outbox', 'expand', 'CREATE TABLE outbox_message (id uuid PRIMARY KEY)'),
      M('0003', 'drop_legacy', 'contract', 'DROP TABLE IF EXISTS legacy_state'),
    ];
    const first = await runMigrations(db, migrations);
    expect(first.applied.map((a) => a.id)).toEqual(['0001', '0002', '0003']);
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]); // idempotent re-run
    expect(second.skipped).toEqual(['0001', '0002', '0003']);
  });

  it('records history that is readable in order through an independent read path', async () => {
    const db = newDb();
    await runMigrations(db, [
      M('0001', 'init', 'expand', 'CREATE TABLE a (id int)'),
      M('0002', 'grow', 'migrate', 'ALTER TABLE a ADD COLUMN b int'),
    ]);
    const history = await readMigrationHistory(db);
    expect(history.map((h) => `${h.id}:${h.kind}`)).toEqual(['0001:expand', '0002:migrate']);
    for (const h of history) expect(h.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects editing an already-applied migration (checksum drift) — negative control', async () => {
    const db = newDb();
    await runMigrations(db, [M('0001', 'init', 'expand', 'CREATE TABLE a (id int)')]);
    await expect(
      runMigrations(db, [M('0001', 'init', 'expand', 'CREATE TABLE a (id bigint)')]),
    ).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('validates ordering: out-of-order and duplicate ids are rejected — negative controls', () => {
    expect(() =>
      assertMigrationOrder([M('0001', 'a', 'expand', 'x'), M('0002', 'b', 'migrate', 'y')]),
    ).not.toThrow();
    expect(() =>
      assertMigrationOrder([M('0002', 'b', 'migrate', 'y'), M('0001', 'a', 'expand', 'x')]),
    ).toThrow(/ascending id order/);
    expect(() =>
      assertMigrationOrder([M('0001', 'a', 'expand', 'x'), M('0001', 'b', 'migrate', 'y')]),
    ).toThrow(/duplicate migration id/);
  });

  it('migration checksum is content-sensitive (durable witness of change)', () => {
    const a = checksumMigration(M('0001', 'init', 'expand', 'CREATE TABLE a (id int)'));
    const b = checksumMigration(M('0001', 'init', 'expand', 'CREATE TABLE a (id int)'));
    const c = checksumMigration(M('0001', 'init', 'expand', 'CREATE TABLE a (id bigint)'));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
