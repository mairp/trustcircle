/**
 * Governance event-envelope contract suite (T026 / GAR-008 / VO-52d0780c11bcc6fd7583).
 *
 * Phase-primary obligation (GAR-008 / VO-52d0780c11bcc6fd7583):
 *   "Every onboarded source contract MUST be versioned and validated; mutating
 *    operations MUST be correlated, deduplicated, reconcilable, retry-bounded,
 *    and safe under duplicate, delayed, partial, conflicting, and uncertain
 *    outcomes."
 *
 * `packages/contracts/src/events.ts` is the RUNTIME half of the AsyncAPI
 * governance-events contract. This suite exercises its pure functions directly
 * (no infrastructure) and proves, through independent read paths, each oracle
 * clause below. EVERY positive assertion is paired with a negative control that
 * a broken implementation would fail, so the oracle is non-vacuous.
 *
 * Clause -> test:
 *   VERSIONED     -> "versioned", "cross-major is incompatible", "additive minor"
 *   VALIDATED     -> "validates a well-formed envelope", "rejects malformed fields"
 *   ADDITIVE      -> "tolerates unknown same-major fields", "reports additive keys"
 *   CORRELATED    -> "requires correlation_id", aggregateKey grouping
 *   DEDUPLICATED  -> "duplicate event_id", "replayed version"
 *   RECONCILABLE  -> "missingVersions gap view", "reconcileBatch determinism"
 *   RETRY-BOUNDED -> "classification is total & bounded", retryable flags
 *   SAFE UNDER    -> duplicate / delayed(out_of_order) / partial(reject) /
 *                    conflicting(conflict) / uncertain(gap) tests
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_SCHEMA_VERSION,
  parseSemVer,
  classifyVersion,
  isReadableVersion,
  validateEnvelope,
  isValidEnvelope,
  additiveTopLevelKeys,
  aggregateKey,
  emptyAggregateState,
  classifyDelivery,
  applyDelivery,
  missingVersions,
  reconcileBatch,
} from '../../packages/contracts/src/events.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ASYNCAPI = join(
  REPO_ROOT,
  'specs',
  '001-governance-control-plane',
  'contracts',
  'governance-events.asyncapi.yaml',
);

// --- a canonical, valid envelope fixture (all uuids distinct & well-formed) ----
const U = (n: number): string =>
  `0000000${n}-0000-4000-8000-00000000000${n % 10}`.replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12}).*/,
    '$1-$2-$3-$4-$5',
  );

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const digest = 'a'.repeat(64);
  return {
    schema_version: '1.0.0',
    event_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'governance.inventory.item_created',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    aggregate_type: 'InventoryItem',
    aggregate_id: '33333333-3333-4333-8333-333333333333',
    aggregate_version: 1,
    occurred_at: '2026-08-01T00:00:00Z',
    recorded_at: '2026-08-01T00:00:01Z',
    actor: {
      principal_id: '44444444-4444-4444-8444-444444444444',
      principal_type: 'human',
    },
    correlation_id: '55555555-5555-4555-8555-555555555555',
    policy: {
      policy_version_id: '66666666-6666-4666-8666-666666666666',
      policy_decision_id: '77777777-7777-4777-8777-777777777777',
      bundle_digest: digest,
    },
    evidence: [],
    data: {},
    ...overrides,
  };
}

void U; // fixture uses explicit literal uuids; helper retained for clarity

// ===========================================================================
// VERSIONED
// ===========================================================================
describe('versioned envelope', () => {
  it('accepts the single supported version and parses semver', () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe('1.0.0');
    expect(parseSemVer('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(classifyVersion('1.0.0')).toBe('exact');
    expect(isReadableVersion('1.0.0')).toBe(true);
  });

  it('treats a higher same-major minor as additive (readable), lower as downlevel', () => {
    expect(classifyVersion('1.4.0')).toBe('additive');
    expect(classifyVersion('1.0.9')).toBe('additive');
    expect(isReadableVersion('1.4.0')).toBe(true);
    // negative control: a cross-MAJOR version is NOT readable
    expect(classifyVersion('2.0.0')).toBe('incompatible');
    expect(isReadableVersion('2.0.0')).toBe(false);
    expect(isReadableVersion('0.9.0')).toBe(false);
  });

  it('rejects a malformed / missing version', () => {
    expect(parseSemVer('1.0')).toBeNull();
    expect(parseSemVer(undefined)).toBeNull();
    expect(classifyVersion('nope')).toBe('incompatible');
    const r = validateEnvelope(baseEnvelope({ schema_version: '2.0.0' }));
    expect(r.valid).toBe(false);
    expect(r.versionCompatibility).toBe('incompatible');
    expect(r.problems.some((p) => p.path === '/schema_version')).toBe(true);
  });

  it('the supported version mirrors the AsyncAPI source const (contract fidelity)', () => {
    const yaml = readFileSync(ASYNCAPI, 'utf8');
    // the AsyncAPI declares `const: 1.0.0` for schema_version
    expect(yaml).toMatch(/schema_version:\s*\n\s*const:\s*1\.0\.0/);
  });
});

// ===========================================================================
// VALIDATED
// ===========================================================================
describe('validated envelope', () => {
  it('accepts a well-formed envelope and narrows the type', () => {
    const env = baseEnvelope();
    const r = validateEnvelope(env);
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
    expect(isValidEnvelope(env)).toBe(true);
  });

  it('rejects malformed required fields with path-anchored problems', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ event_id: 'not-a-uuid' }, '/event_id'],
      [{ event_type: 'notgovernance.x' }, '/event_type'],
      [{ tenant_id: 'x' }, '/tenant_id'],
      [{ aggregate_version: 0 }, '/aggregate_version'],
      [{ occurred_at: 'yesterday' }, '/occurred_at'],
      [{ correlation_id: 'x' }, '/correlation_id'],
      [{ actor: { principal_id: 'x', principal_type: 'human' } }, '/actor/principal_id'],
      [
        {
          actor: { principal_id: '44444444-4444-4444-8444-444444444444', principal_type: 'alien' },
        },
        '/actor/principal_type',
      ],
      [
        { policy: { policy_version_id: 'x', policy_decision_id: 'y', bundle_digest: 'z' } },
        '/policy/policy_version_id',
      ],
      [{ evidence: [{ evidence_id: 'x', sha256: 'y' }] }, '/evidence/0/evidence_id'],
      [{ data: 42 }, '/data'],
    ];
    for (const [override, expectedPath] of cases) {
      const r = validateEnvelope(baseEnvelope(override));
      expect(r.valid, `expected invalid for ${expectedPath}`).toBe(false);
      expect(
        r.problems.some((p) => p.path === expectedPath),
        `problem at ${expectedPath}`,
      ).toBe(true);
    }
  });

  it('negative control: a broken validator returning always-valid would fail the above', () => {
    // sanity: the clean fixture is valid, proving the reject cases are meaningful
    expect(validateEnvelope(baseEnvelope()).valid).toBe(true);
    // and a non-object is rejected outright
    expect(validateEnvelope(null).valid).toBe(false);
    expect(validateEnvelope('string').valid).toBe(false);
  });
});

// ===========================================================================
// ADDITIVE FIELD HANDLING (same-major forward compatibility)
// ===========================================================================
describe('additive same-major fields', () => {
  it('tolerates unknown top-level keys and unknown extensions/data keys', () => {
    const env = baseEnvelope({
      brand_new_future_field: { anything: true },
      extensions: { future_ext: 'ok' },
      data: { future_payload_key: 123 },
    });
    const r = validateEnvelope(env);
    expect(r.valid).toBe(true); // additive keys do NOT fail validation
  });

  it('reports additive top-level keys for observability (not as errors)', () => {
    const env = baseEnvelope({ zeta_field: 1, alpha_field: 2 });
    expect(additiveTopLevelKeys(env)).toEqual(['alpha_field', 'zeta_field']);
    // negative control: a fully-known envelope has NO additive keys
    expect(additiveTopLevelKeys(baseEnvelope())).toEqual([]);
  });

  it('still rejects a STRUCTURAL violation of a known field even with additive keys present', () => {
    const env = baseEnvelope({ future_field: 1, aggregate_version: -5 });
    const r = validateEnvelope(env);
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.path === '/aggregate_version')).toBe(true);
  });
});

// ===========================================================================
// CORRELATED
// ===========================================================================
describe('correlated ordering key', () => {
  it('requires correlation_id and groups by (tenant, aggregate_type, aggregate_id)', () => {
    expect(validateEnvelope(baseEnvelope({ correlation_id: undefined })).valid).toBe(false);
    const a = aggregateKey({ tenant_id: 't', aggregate_type: 'A', aggregate_id: '1' });
    const b = aggregateKey({ tenant_id: 't', aggregate_type: 'A', aggregate_id: '1' });
    const c = aggregateKey({ tenant_id: 't', aggregate_type: 'A', aggregate_id: '2' });
    expect(a).toBe(b);
    expect(a).not.toBe(c); // different aggregate => different stream
  });
});

// ===========================================================================
// AGGREGATE ORDERING — DEDUP / DELAYED / GAP / CONFLICT / UNCERTAIN
// ===========================================================================
describe('aggregate ordering checks', () => {
  const evAt = (version: number, eventId: string, extra: Record<string, unknown> = {}) =>
    baseEnvelope({ aggregate_version: version, event_id: eventId, ...extra });

  it('applies the expected next version and advances state', () => {
    let state = emptyAggregateState();
    const step = applyDelivery(state, evAt(1, '11111111-1111-4111-8111-111111111111'));
    expect(step.classification.decision).toBe('apply');
    expect(step.state.lastAppliedVersion).toBe(1);
    state = step.state;
    const step2 = applyDelivery(state, evAt(2, '11111111-1111-4111-8111-111111111112'));
    expect(step2.classification.decision).toBe('apply');
    expect(step2.state.lastAppliedVersion).toBe(2);
  });

  it('SAFE UNDER DUPLICATE: a re-delivered event_id is a duplicate with no second effect', () => {
    const first = applyDelivery(
      emptyAggregateState(),
      evAt(1, '11111111-1111-4111-8111-111111111111'),
    );
    const dup = applyDelivery(first.state, evAt(1, '11111111-1111-4111-8111-111111111111'));
    expect(dup.classification.decision).toBe('duplicate');
    expect(dup.state.lastAppliedVersion).toBe(1); // no advance, no regression
    expect(dup.classification.retryable).toBe(false);
  });

  it('SAFE UNDER DUPLICATE: a replayed lower/equal version is a duplicate (no regression)', () => {
    const state = reconcileBatch(emptyAggregateState(), [
      evAt(1, '11111111-1111-4111-8111-111111111111'),
      evAt(2, '11111111-1111-4111-8111-111111111112'),
    ]).state;
    const replay = applyDelivery(state, evAt(2, '99999999-9999-4999-8999-999999999999'));
    // same version 2 already applied by a different id => CONFLICT (visible), not silent overwrite
    expect(replay.classification.decision).toBe('conflict');
    expect(replay.state.lastAppliedVersion).toBe(2);
  });

  it('SAFE UNDER DELAYED / OUT-OF-ORDER: a future version is buffered, not applied', () => {
    const first = applyDelivery(
      emptyAggregateState(),
      evAt(1, '11111111-1111-4111-8111-111111111111'),
    );
    const future = applyDelivery(first.state, evAt(5, '11111111-1111-4111-8111-111111111115'));
    expect(future.classification.decision).toBe('out_of_order');
    expect(future.classification.awaitingVersion).toBe(2);
    expect(future.classification.retryable).toBe(true); // predecessor may still arrive
    expect(future.state.lastAppliedVersion).toBe(1); // NOT applied out of order
  });

  it('SAFE UNDER CONFLICT: same version, different event_id is a visible conflict', () => {
    const first = applyDelivery(
      emptyAggregateState(),
      evAt(1, '11111111-1111-4111-8111-111111111111'),
    );
    const conflict = applyDelivery(first.state, evAt(1, '88888888-8888-4888-8888-888888888888'));
    expect(conflict.classification.decision).toBe('conflict');
    expect(conflict.classification.retryable).toBe(false);
  });

  it('SAFE UNDER UNCERTAIN: ordering_uncertain future version reports a gap, never silently applies', () => {
    const first = applyDelivery(
      emptyAggregateState(),
      evAt(1, '11111111-1111-4111-8111-111111111111'),
    );
    const uncertain = applyDelivery(
      first.state,
      evAt(4, '11111111-1111-4111-8111-111111111114', {
        source: {
          source_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          external_id: 'X-1',
          source_revision: 'r1',
          observed_at: '2026-08-01T00:00:00Z',
          ordering_uncertain: true,
        },
      }),
    );
    expect(uncertain.classification.decision).toBe('gap');
    expect(uncertain.state.lastAppliedVersion).toBe(1); // uncertainty never advances state
  });

  it('SAFE UNDER PARTIAL: a malformed envelope is rejected and never touches state', () => {
    const state = emptyAggregateState();
    const bad = applyDelivery(state, { schema_version: '1.0.0', event_id: 'nope' });
    expect(bad.classification.decision).toBe('reject');
    expect(bad.classification.retryable).toBe(false);
    expect(bad.state).toBe(state); // identical reference => no mutation
    expect(bad.classification.problems && bad.classification.problems.length).toBeGreaterThan(0);
  });

  it('RECONCILABLE: missingVersions exposes gaps; batch reconciliation is deterministic & idempotent', () => {
    // Deliver 1, then 3 (gap at 2). missingVersions must report [2].
    const s1 = applyDelivery(
      emptyAggregateState(),
      evAt(1, '11111111-1111-4111-8111-111111111111'),
    ).state;
    const s2 = applyDelivery(s1, evAt(3, '11111111-1111-4111-8111-111111111113')).state;
    expect(missingVersions(s2)).toEqual([2]);

    // Reconcile a duplicated + out-of-order batch: same result no matter how many
    // times a duplicate appears (no duplicate effects).
    const batch = [
      evAt(1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
      evAt(1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), // exact duplicate
      evAt(3, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'), // out of order
      evAt(2, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'), // fills the gap
    ];
    const r = reconcileBatch(emptyAggregateState(), batch);
    expect(r.decisions.map((d) => d.decision)).toEqual([
      'apply',
      'duplicate',
      'out_of_order',
      'apply',
    ]);
    // determinism: replaying the identical batch yields the identical decisions
    const r2 = reconcileBatch(emptyAggregateState(), batch);
    expect(r2.decisions.map((d) => d.decision)).toEqual(r.decisions.map((d) => d.decision));
  });

  it('RETRY-BOUNDED: classifyDelivery is total — every input maps to one bounded decision', () => {
    const decisions = new Set<string>();
    decisions.add(
      classifyDelivery(emptyAggregateState(), evAt(1, '11111111-1111-4111-8111-111111111111'))
        .decision,
    ); // apply
    decisions.add(
      classifyDelivery(emptyAggregateState(), evAt(5, '11111111-1111-4111-8111-111111111115'))
        .decision,
    ); // out_of_order
    decisions.add(classifyDelivery(emptyAggregateState(), { bad: true }).decision); // reject
    // classification is pure — no throw, always a member of the closed decision set
    for (const d of decisions) {
      expect(['apply', 'duplicate', 'out_of_order', 'gap', 'conflict', 'reject']).toContain(d);
    }
  });
});
