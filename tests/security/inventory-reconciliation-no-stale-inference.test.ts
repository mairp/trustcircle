// Security-suite test — the SNAPSHOT / OBSERVATION RECONCILIATION service (Phase 71) grants NO
// governance authority: it records, classifies, and keeps anomalies VISIBLE, but it NEVER
//   (a) infers current health / confidence from stale, absent, or disappeared evidence, nor
//   (b) silently drops a source deviation (missing / conflicting / orphaned / disappeared) — every
//       deviation stays a VISIBLE, OWNED gap or delta rather than being repaired away.
// (Bundle 36GCYGDJ15PTYP60F91QWRAY2M / Phase 71.)
//
// The property is proven structurally on the durable read paths:
//   (1) NO STALE-CONFIDENCE INFERENCE — a stale source's `sourceStatus.confidence` is < 1 and the
//       composed row withholds `reportedHealth` (`unknown`); a DISAPPEARED source's confidence is
//       exactly 0. Confidence is never promoted for evidence the reconciler has not freshly seen.
//   (2) NO SILENT REPAIR — an anomaly (here: disappearance) always leaves a VISIBLE gap that the
//       query surface retains; the reconciler never deletes a known source or its gap.
//
// Each positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: a fresh
// re-observed source DOES carry confidence 1 and a current row — so it is the guard, not the
// fixture, that produces the safe output.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import {
  makeGovernedAsset,
  makeSourceRecord,
  sourceRecordIdentity,
  type SourceRecord,
  type GovernedAsset,
} from '../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  type SourceAuthorityPolicy,
} from '../../packages/domain/src/correlation.ts';
import { SourceReconciler } from '../../packages/application/src/inventory-reconciliation.ts';
import type { IdFactory } from '../../packages/application/src/source-registry.ts';

const FIXED_RANDOM = () => new Uint8Array(16).fill(0x7a);
function idFactory(seed = 1): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}
function id(stamp: number): Uuid {
  return uuidV7(stamp as EpochMillis, FIXED_RANDOM);
}
const T0 = 1_700_000_000_000 as EpochMillis;
const MIN = 60_000;
const HORIZON = 15 * MIN;
const at = (m: number): EpochMillis => (T0 + m) as EpochMillis;
const TENANT = PLATFORM_SCOPE;
const CATALOG = id(4001);

const POLICY: SourceAuthorityPolicy = makeSourceAuthorityPolicy({
  id: 'sec-reconciliation-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'status',
      byClass: { platform_kanban: 10 },
      defaultAuthority: 1,
    }),
  ],
});

function reconciler(seed = 1): SourceReconciler {
  return new SourceReconciler({
    tenantId: TENANT,
    newId: idFactory(seed),
    policy: POLICY,
    stalenessHorizonMillis: HORIZON,
    disappearanceCycles: 2,
  });
}

let seq = 5000;
function rec(
  externalKey: string,
  assetId: Uuid,
  freshness: SourceRecord['freshness'] = 'fresh',
): SourceRecord {
  return makeSourceRecord({
    id: id((seq += 1)),
    tenantId: TENANT,
    catalogId: CATALOG,
    assetId,
    sourceClass: 'platform_kanban',
    externalKey,
    observedState: { status: 'operating' },
    status: 'active',
    freshness,
    lastKnownAt: at(0),
    observedAt: at(0),
  });
}
function asset(assetId: Uuid): { asset: GovernedAsset; fields: readonly string[] } {
  return {
    asset: makeGovernedAsset({
      id: assetId,
      tenantId: TENANT,
      assetType: 'ai_workload',
      name: 'sec',
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: at(0),
      updatedAt: at(0),
    }),
    fields: ['status'],
  };
}

describe('SECURITY (1): no current-health/confidence inferred from stale or disappeared evidence', () => {
  it('a stale source has confidence < 1 and its row withholds reportedHealth', () => {
    const r = reconciler();
    const a = id(1);
    const identity = sourceRecordIdentity(rec('k:stale', a));
    r.reconcile({ observations: [rec('k:stale', a, 'stale')], assets: [asset(a)], at: at(0) });
    const status = r.sourceStatus(identity, at(1));
    expect(status.confidence).toBeLessThan(1);
    const row = r.currentStateView(at(1)).find((x) => x.assetId === a)!;
    expect(row.reportedHealth).toBe('unknown');
    expect(row.evidenceState).not.toBe('current');
  });

  it('a DISAPPEARED source has confidence exactly 0 (never inferred healthy)', () => {
    const r = reconciler(100);
    const a = id(2);
    const identity = sourceRecordIdentity(rec('k:gone', a));
    r.reconcile({ observations: [rec('k:gone', a)], assets: [asset(a)], at: at(0) });
    r.reconcile({ observations: [], at: at(1) }); // missing
    r.reconcile({ observations: [], at: at(2) }); // disappeared
    const status = r.sourceStatus(identity, at(3));
    expect(status.disappeared).toBe(true);
    expect(status.confidence).toBe(0);
  });

  it('NEGATIVE CONTROL: a freshly re-observed source keeps confidence 1 and a current row', () => {
    const r = reconciler(200);
    const a = id(3);
    const identity = sourceRecordIdentity(rec('k:fresh', a));
    r.reconcile({ observations: [rec('k:fresh', a, 'fresh')], assets: [asset(a)], at: at(0) });
    const status = r.sourceStatus(identity, at(1));
    expect(status.confidence).toBe(1);
    const row = r.currentStateView(at(1)).find((x) => x.assetId === a)!;
    expect(row.reportedHealth).toBe('healthy');
    expect(row.evidenceState).toBe('current');
  });
});

describe('SECURITY (2): no silent repair — a disappearance is always a VISIBLE, retained gap', () => {
  it('the disappearance gap stays queryable and the known source is never deleted', () => {
    const r = reconciler(300);
    const a = id(4);
    const identity = sourceRecordIdentity(rec('k:vis', a));
    r.reconcile({ observations: [rec('k:vis', a)], assets: [asset(a)], at: at(0) });
    r.reconcile({ observations: [], at: at(1) });
    r.reconcile({ observations: [], at: at(2) });
    // Gap remains visible.
    expect(r.openGaps().length).toBeGreaterThanOrEqual(1);
    // Known source is retained (queryable), just marked absent — never deleted.
    expect(() => r.sourceStatus(identity, at(3))).not.toThrow();
    expect(r.sourceStatus(identity, at(3)).present).toBe(false);
  });

  it('NEGATIVE CONTROL: a steadily re-observed source opens no gap (guard, not fixture)', () => {
    const r = reconciler(400);
    const a = id(5);
    r.reconcile({ observations: [rec('k:ok', a)], assets: [asset(a)], at: at(0) });
    r.reconcile({ observations: [rec('k:ok', a)], assets: [asset(a)], at: at(1) });
    expect(r.openGaps()).toHaveLength(0);
  });
});
