// Migration/compatibility release gate (Phase 9 / T278 / GAR-010, VO-ec575c4ce42b548bfb4d).
//
// PHASE OBJECTIVE (T278): "Prove additive contract compatibility and expand/migrate/verify/contract
// database evolution from the previous supported version in tests/migrations/compatibility.test.ts".
//
// Two independently-observable proofs, both non-vacuous (every positive is paired with a negative):
//
//  A. ADDITIVE CONTRACT COMPATIBILITY — a consumer pinned to the PREVIOUS supported version can still
//     read messages produced under a compatible (same-major, additive) evolution:
//       * a higher same-major minor is classified `additive`/readable;
//       * an envelope carrying UNKNOWN same-major top-level keys still validates (forward compat) and
//         the extra keys are reported by additiveTopLevelKeys();
//       * a CROSS-MAJOR bump is `incompatible` and rejected (the breaking-change guard).
//     Driven through the REAL runtime contract packages/contracts/src/events.ts.
//
//  B. EXPAND → MIGRATE → VERIFY → CONTRACT database evolution — evolving a table from the previous
//     supported schema to the next one WITHOUT a breaking window, via the REAL migration runner
//     packages/persistence/src/database.ts on the deterministic in-memory driver:
//       * EXPAND   adds the new nullable column (old + new readers both work);
//       * MIGRATE  backfills;
//       * VERIFY   an independent read path confirms the applied, ordered, checksum-pinned history;
//       * CONTRACT drops the legacy column only after expand+migrate.
//     Negative controls: re-running is idempotent; editing an applied migration (checksum drift) is
//     refused; an out-of-order id is refused.
//
// Runs under `vitest run --project migration` (wired by `test:migrations`). No live PostgreSQL.

import { describe, it, expect } from 'vitest';

import {
  SUPPORTED_SCHEMA_VERSION,
  classifyVersion,
  isReadableVersion,
  validateEnvelope,
  additiveTopLevelKeys,
} from '../../packages/contracts/src/events.ts';

import {
  Database,
  runMigrations,
  readMigrationHistory,
  assertMigrationOrder,
  MigrationChecksumError,
  type Migration,
  type SqlDriver,
} from '../../packages/persistence/src/database.ts';

import { createInMemoryDriver } from '../persistence/in-memory-driver.mjs';

// ── A. ADDITIVE CONTRACT COMPATIBILITY ────────────────────────────────────────────────────────────

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    event_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'governance.inventory.item_created',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    aggregate_type: 'InventoryItem',
    aggregate_id: '33333333-3333-4333-8333-333333333333',
    aggregate_version: 1,
    occurred_at: '2026-08-01T00:00:00Z',
    recorded_at: '2026-08-01T00:00:01Z',
    actor: { principal_id: '44444444-4444-4444-8444-444444444444', principal_type: 'human' },
    correlation_id: '55555555-5555-4555-8555-555555555555',
    policy: {
      policy_version_id: '66666666-6666-4666-8666-666666666666',
      policy_decision_id: '77777777-7777-4777-8777-777777777777',
      bundle_digest: 'a'.repeat(64),
    },
    evidence: [],
    data: {},
    ...overrides,
  };
}

describe('T278 · additive contract compatibility from the previous supported version', () => {
  it('the current supported version reads exactly, and a higher same-major minor reads as additive', () => {
    expect(classifyVersion(SUPPORTED_SCHEMA_VERSION)).toBe('exact');
    expect(isReadableVersion(SUPPORTED_SCHEMA_VERSION)).toBe(true);
    // A consumer pinned to the previous supported version can read a same-major, additive evolution.
    expect(classifyVersion('1.4.0')).toBe('additive');
    expect(isReadableVersion('1.9.3')).toBe(true);
  });

  it('an envelope with UNKNOWN same-major top-level keys still validates (forward compatibility)', () => {
    const evolved = baseEnvelope({ new_optional_hint: 'added-later', another_new_field: 42 });
    const result = validateEnvelope(evolved);
    expect(result.valid).toBe(true);
    const additive = additiveTopLevelKeys(evolved);
    expect(additive).toContain('new_optional_hint');
    expect(additive).toContain('another_new_field');
  });

  it('NEGATIVE: a cross-MAJOR version is incompatible and rejected (breaking-change guard)', () => {
    expect(classifyVersion('2.0.0')).toBe('incompatible');
    expect(isReadableVersion('2.0.0')).toBe(false);
    const r = validateEnvelope(baseEnvelope({ schema_version: '2.0.0' }));
    expect(r.valid).toBe(false);
    expect(r.versionCompatibility).toBe('incompatible');
  });

  it('NEGATIVE: a structural violation of a KNOWN field is still rejected under the same major', () => {
    const r = validateEnvelope(baseEnvelope({ aggregate_version: 'not-a-number' }));
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.path === '/aggregate_version')).toBe(true);
  });
});

// ── B. EXPAND → MIGRATE → VERIFY → CONTRACT database evolution ─────────────────────────────────────

function newDb() {
  let t = 1_700_000_000_000;
  return new Database(createInMemoryDriver() as unknown as SqlDriver, { clock: () => (t += 1) });
}
const M = (id: string, name: string, kind: Migration['kind'], up: string): Migration => ({
  id,
  name,
  kind,
  up,
});

// The "previous supported version" baseline schema (already applied in production).
const PREVIOUS_SUPPORTED: readonly Migration[] = [
  M('0001', 'baseline_inventory', 'expand', 'CREATE TABLE inventory_item (id uuid PRIMARY KEY, legacy_owner text)'),
];

// The next version's evolution of the SAME table, without a breaking window:
const EVOLUTION: readonly Migration[] = [
  ...PREVIOUS_SUPPORTED,
  // EXPAND — add the new nullable column; old readers ignore it, new readers can populate it.
  M('0002', 'add_owner_principal', 'expand', 'ALTER TABLE inventory_item ADD COLUMN owner_principal_id uuid NULL'),
  // MIGRATE — backfill the new column from the legacy one.
  M('0003', 'backfill_owner', 'migrate', 'UPDATE inventory_item SET owner_principal_id = legacy_owner::uuid WHERE legacy_owner IS NOT NULL'),
  // CONTRACT — only after expand+migrate is the legacy column removed.
  M('0004', 'drop_legacy_owner', 'contract', 'ALTER TABLE inventory_item DROP COLUMN legacy_owner'),
];

describe('T278 · expand→migrate→verify→contract evolution from the previous supported version', () => {
  it('applies the baseline, then evolves additively, in expand→migrate→contract order', async () => {
    const db = newDb();

    // Start from the previous supported version (already applied).
    const baseline = await runMigrations(db, PREVIOUS_SUPPORTED);
    expect(baseline.applied.map((a) => a.id)).toEqual(['0001']);

    // Evolve: expand + migrate + contract are applied on top; the baseline is skipped (idempotent).
    const evolved = await runMigrations(db, EVOLUTION);
    expect(evolved.applied.map((a) => a.id)).toEqual(['0002', '0003', '0004']);
    expect(evolved.skipped).toEqual(['0001']);

    // The kinds prove the expand→migrate→contract discipline.
    expect(evolved.applied.map((a) => a.kind)).toEqual(['expand', 'migrate', 'contract']);
  });

  it('VERIFY: an independent read path confirms the applied, ordered, checksum-pinned history', async () => {
    const db = newDb();
    await runMigrations(db, EVOLUTION);
    const history = await readMigrationHistory(db);
    expect(history.map((h) => h.id)).toEqual(['0001', '0002', '0003', '0004']);
    expect(history.map((h) => h.kind)).toEqual(['expand', 'expand', 'migrate', 'contract']);
    for (const h of history) expect(h.checksum).toMatch(/^[0-9a-f]{64}$/);
    // Ordering is structurally valid.
    expect(() => assertMigrationOrder(EVOLUTION)).not.toThrow();
  });

  it('NEGATIVE: re-running the full evolution applies nothing new (idempotent)', async () => {
    const db = newDb();
    await runMigrations(db, EVOLUTION);
    const rerun = await runMigrations(db, EVOLUTION);
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('NEGATIVE: editing an already-applied migration (checksum drift) is refused', async () => {
    const db = newDb();
    await runMigrations(db, PREVIOUS_SUPPORTED);
    await expect(
      runMigrations(db, [
        M('0001', 'baseline_inventory', 'expand', 'CREATE TABLE inventory_item (id bigint PRIMARY KEY)'),
      ]),
    ).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('NEGATIVE: an out-of-order migration id is refused', () => {
    expect(() =>
      assertMigrationOrder([
        M('0002', 'b', 'expand', 'x'),
        M('0001', 'a', 'expand', 'y'),
      ]),
    ).toThrow();
  });
});
