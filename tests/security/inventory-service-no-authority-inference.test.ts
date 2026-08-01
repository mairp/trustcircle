// Security-suite test — the CURRENT-INVENTORY ASSEMBLY service (Phase 70) grants NO governance
// authority: it records, correlates, and keeps visible, but it NEVER (a) infers current health /
// compliance from stale or unavailable evidence, nor (b) fabricates an authoritative field value
// when registered sources disagree — a conflict PAUSES automation and opens a case rather than
// silently guessing a winner. (Bundle 36GCYGDJ15PTYP60F91QWRAY2M / task T070.)
//
// The property is proven structurally on the durable read paths:
//   (1) NO STALE-HEALTH INFERENCE — a stale/unavailable contributing source forces the row's
//       `evidenceState` off `current`, drops `confidence` below 1, and withholds `reportedHealth`
//       (`unknown`) even though the asset RECORDED `healthy`. The service cannot present stale data
//       as current health.
//   (2) NO AUTHORITY FABRICATION — two authoritative-tied sources reporting DIFFERENT values leave
//       the field UNRESOLVED, `automationPaused = true`, an open case retained, and NO authoritative
//       value on the drill-down. The service refuses to pick a winner it cannot justify.
//
// Each positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: fresh
// evidence DOES report current health, and an authority-broken tie DOES resolve — so it is the
// guard, not the fixture, that produces the safe output.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import { makeGovernedAsset, makeSourceRecord } from '../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  type SourceAuthorityPolicy,
} from '../../packages/domain/src/correlation.ts';
import { InventoryService } from '../../packages/application/src/inventory-service.ts';
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
const OWNER_A = id(80001);
const OWNER_B = id(80002);

function svcWith(policy: SourceAuthorityPolicy): InventoryService {
  return new InventoryService({
    tenantId: PLATFORM_SCOPE,
    newId: idFactory(),
    policy,
    stalenessHorizonMillis: HORIZON,
  });
}

// Policy where two classes hold EQUAL authority for `owner` → a value disagreement is an authority
// TIE that cannot be resolved (used to prove no-fabrication).
const TIE_POLICY = makeSourceAuthorityPolicy({
  id: 'tie-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'owner',
      byClass: { platform_kanban: 5, agentctl: 5 },
      defaultAuthority: 0,
    }),
  ],
  confidenceFloor: 0.5,
});

// Policy where platform_kanban strictly outranks agentctl → a disagreement DOES resolve (control).
const RANKED_POLICY = makeSourceAuthorityPolicy({
  id: 'ranked-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'owner',
      byClass: { platform_kanban: 10, agentctl: 1 },
      defaultAuthority: 0,
    }),
  ],
  confidenceFloor: 0.5,
});

describe('security — no current-health inference from stale/unavailable evidence', () => {
  it('withholds current health and drops confidence when the contributing source is stale', () => {
    const svc = svcWith(RANKED_POLICY);
    const a = id(81001);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'agent',
        ownerPrincipalId: OWNER_A,
        lifecycleState: 'operating',
        health: 'healthy', // asset RECORDED healthy…
        coverage: 'covered',
        updatedAt: at(0),
      }),
      fields: ['owner'],
    });
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(81011),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(81111),
        assetId: a,
        sourceClass: 'platform_kanban',
        externalKey: 'k',
        observedState: { owner: OWNER_A },
        status: 'active',
        freshness: 'stale', // …but the evidence is STALE.
        confidence: 0.95,
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    const row = svc.rowFor(a, at(40 * MIN));
    expect(row.reportedHealth).toBe('unknown'); // NOT inferred as current 'healthy'
    expect(row.evidenceState).not.toBe('current');
    expect(row.confidence).toBeLessThan(1);
    expect(row.lastObservationAt).toBe(at(0)); // last-known time preserved
  });

  // NEGATIVE control: fresh evidence DOES report current health — the withholding is specific.
  it('negative control: fresh evidence reports current health at full confidence', () => {
    const svc = svcWith(RANKED_POLICY);
    const a = id(81002);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'agent',
        ownerPrincipalId: OWNER_A,
        lifecycleState: 'operating',
        health: 'healthy',
        coverage: 'covered',
        updatedAt: at(0),
      }),
      fields: ['owner'],
    });
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(81021),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(81121),
        assetId: a,
        sourceClass: 'platform_kanban',
        externalKey: 'k',
        observedState: { owner: OWNER_A },
        status: 'active',
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    const row = svc.rowFor(a, at(MIN));
    expect(row.reportedHealth).toBe('healthy');
    expect(row.evidenceState).toBe('current');
    expect(row.confidence).toBe(1);
  });
});

describe('security — no authoritative value fabricated when sources conflict', () => {
  function seedConflict(svc: InventoryService, a: Uuid): void {
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'workflow',
        name: 'flow',
        ownerPrincipalId: OWNER_A,
        updatedAt: at(0),
      }),
      fields: ['owner'],
    });
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(82011),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(82111),
        assetId: a,
        sourceClass: 'platform_kanban',
        externalKey: 'k',
        observedState: { owner: OWNER_A },
        status: 'active',
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(82012),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(82112),
        assetId: a,
        sourceClass: 'agentctl',
        externalKey: 'a',
        observedState: { owner: OWNER_B }, // DIFFERENT owner
        status: 'active',
        freshness: 'fresh',
        confidence: 1,
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
  }

  it('an authority TIE on conflicting values pauses automation and opens a case, never guesses', () => {
    const svc = svcWith(TIE_POLICY);
    const a = id(82001);
    seedConflict(svc, a);
    const dd = svc.drillDown(a, at(1));
    const owner = dd.correlation.fields.find((f) => f.field === 'owner')!;
    expect(owner.resolution).toBe('unresolved'); // no fabricated winner
    expect(owner.value).toBeUndefined();
    expect(dd.correlation.automationPaused).toBe(true); // safety: automation pauses
    expect(dd.correlation.openCases.length).toBeGreaterThan(0); // an owned case is retained
    // The row surfaces the unresolved issue as an incomplete-evidence, attention-needed item.
    const row = svc.rowFor(a, at(1));
    expect(row.unresolvedIssueCount).toBeGreaterThan(0);
    expect(row.evidenceState).toBe('incomplete');
  });

  // NEGATIVE control: with a strict authority RANKING the same disagreement DOES resolve — proving
  // the pause is caused by the unbreakable tie, not by any conflict at all.
  it('negative control: a ranked policy resolves the same disagreement to the higher-authority value', () => {
    const svc = svcWith(RANKED_POLICY);
    const a = id(82002);
    seedConflict(svc, a);
    const dd = svc.drillDown(a, at(1));
    const owner = dd.correlation.fields.find((f) => f.field === 'owner')!;
    expect(owner.resolution).toBe('resolved');
    expect(owner.value).toBe(OWNER_A); // platform_kanban wins
    expect(dd.correlation.automationPaused).toBe(false);
  });
});
