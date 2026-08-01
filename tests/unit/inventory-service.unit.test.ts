// TrustCircleAI — Phase 70 unit tests for the CURRENT-INVENTORY ASSEMBLY service.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// Executable evidence that `packages/application/src/inventory-service.ts` — a fleet-level aggregate
// that composes the domain's single-item correlation into a collection where each governed asset
// renders ONCE with its full facet set — satisfies acceptance criteria AC1–AC6.
//
// The service is a pure, deterministic aggregate: every ingest carries explicit epoch-millis and an
// injected deterministic UUIDv7 factory (no wall clock); every read takes an explicit `at`. The
// durable-effect witness for every mutation is NOT its return value but the INDEPENDENTLY
// re-readable state (`currentStateView()`, `coverageGaps()`, `catalog()`, `drillDown()`) and its
// content digest (`snapshotDigest(at)`), which changes iff a governed fact changes.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a healthy/covered scenario in
// which the rule must NOT fire, so a green run is not a permissive fake.
//
// AC → describe-block map:
//   AC1 healthy connected asset renders ONCE with the full facet set ........ describe('AC1 …')
//   AC2 non-healthy component stays a VISIBLE coverage gap .................. describe('AC2 …')
//   AC3 related work → distinct source records + correlation drilldown ...... describe('AC3 …')
//   AC4 stale/unavailable source marked; health not inferred from stale data  describe('AC4 …')
//   AC5 unregistered source ADDED to the catalog with discovery evidence .... describe('AC5 …')
//   AC6 discovered source stays a VISIBLE governed-source gap w/ review ..... describe('AC6 …')
//   witness snapshotDigest is an independent, sensitive content witness ..... describe('witness …')

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
  makeCoverageGap,
  makeSourceCatalogEntry,
  makeInventoryRelationship,
  UNKNOWN_SOURCE_CLASS,
} from '../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  type SourceAuthorityPolicy,
} from '../../packages/domain/src/correlation.ts';
import { InventoryService } from '../../packages/application/src/inventory-service.ts';
import type { IdFactory } from '../../packages/application/src/source-registry.ts';

// ---------------------------------------------------------------------------
// Deterministic helpers — a monotonic UUIDv7 factory + a fixed random filler,
// so identities are reproducible and time-ordered without any wall-clock read.
// ---------------------------------------------------------------------------

const FIXED_RANDOM = () => new Uint8Array(16).fill(0x7a);

function idFactory(seed = 1): IdFactory {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}

/** A stable id derived from a small integer stamp (distinct integers → distinct ids). */
function id(stamp: number): Uuid {
  return uuidV7(stamp as EpochMillis, FIXED_RANDOM);
}

const T0 = 1_700_000_000_000 as EpochMillis;
const MIN = 60_000;
const HORIZON = 15 * MIN;
const at = (m: number): EpochMillis => (T0 + m) as EpochMillis;

// A policy where `platform_kanban` outranks other classes for the `owner` field, so a status
// difference resolves to a single authoritative value (and a tie stays unresolved).
const POLICY: SourceAuthorityPolicy = makeSourceAuthorityPolicy({
  id: 'test-policy',
  rules: [
    makeFieldAuthorityRule({
      field: 'owner',
      byClass: { platform_kanban: 10, agentctl: 5, workflows_orchestration: 5 },
      defaultAuthority: 1,
    }),
  ],
  confidenceFloor: 0.5,
});

function newService(policy: SourceAuthorityPolicy = POLICY): InventoryService {
  return new InventoryService({
    tenantId: PLATFORM_SCOPE,
    newId: idFactory(),
    policy,
    stalenessHorizonMillis: HORIZON,
  });
}

const OWNER = id(9001);

/** Ingest a fully healthy, covered, owned asset with one fresh source record. Returns its id. */
function ingestHealthy(svc: InventoryService, assetId: Uuid, whenMs: number): Uuid {
  svc.ingestAsset({
    asset: makeGovernedAsset({
      id: assetId,
      tenantId: PLATFORM_SCOPE,
      assetType: 'ai-agent',
      name: 'assistant',
      ownerPrincipalId: OWNER,
      lifecycleState: 'operating',
      riskTier: 'moderate',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: at(whenMs),
      updatedAt: at(whenMs),
    }),
    fields: ['owner'],
  });
  svc.ingestSourceRecord(
    makeSourceRecord({
      id: id(whenMs + 1),
      tenantId: PLATFORM_SCOPE,
      catalogId: id(whenMs + 2),
      assetId,
      sourceClass: 'platform_kanban',
      externalKey: `kanban:${assetId}`,
      observedState: { owner: OWNER },
      status: 'active',
      freshness: 'fresh',
      confidence: 1,
      lastKnownAt: at(whenMs),
      observedAt: at(whenMs),
    }),
  );
  return assetId;
}

// ===========================================================================
describe('AC1 — healthy connected asset renders ONCE with the full facet set', () => {
  it('yields exactly one row per asset with every enumerated facet named', () => {
    const svc = newService();
    const a = ingestHealthy(svc, id(1001), 0);

    const rows = svc.currentStateView(at(1));
    const mine = rows.filter((r) => r.assetId === a);
    expect(mine).toHaveLength(1); // renders ONCE

    const row = mine[0]!;
    expect(row.assetType).toBe('ai-agent'); // type
    expect(row.assetId).toBe(a); // source identity
    expect(row.ownerPrincipalId).toBe(OWNER); // owner
    expect(row.ownershipGap).toBe(false);
    expect(row.lifecycleState).toBe('operating'); // lifecycle state
    expect(row.riskTier).toBe('moderate'); // risk
    expect(row.coverage).toBe('covered'); // control coverage
    expect(row.evidenceState).toBe('current'); // evidence state
    expect(row.observedHealth).toBe('healthy'); // health
    expect(row.reportedHealth).toBe('healthy'); // fresh ⇒ safe to report current health
    expect(row.lastObservationAt).toBe(at(0)); // last observation time
    expect(row.unresolvedIssueCount).toBe(0); // unresolved issues
    expect(row.confidence).toBe(1);
    expect(row.hasVisibleComponentGap).toBe(false);
  });

  it('re-ingesting the same asset id REPLACES the row (never forks a duplicate)', () => {
    const svc = newService();
    const a = ingestHealthy(svc, id(1002), 0);
    // Supersede with a degraded observation under the SAME id.
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'assistant',
        ownerPrincipalId: OWNER,
        lifecycleState: 'degraded',
        health: 'degraded',
        coverage: 'partial',
        updatedAt: at(10),
      }),
      fields: ['owner'],
    });
    const mine = svc.currentStateView(at(11)).filter((r) => r.assetId === a);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.lifecycleState).toBe('degraded');
  });

  // NEGATIVE CONTROL: an UNOWNED asset must flip the ownershipGap facet — proves the facet is
  // genuinely derived, not hard-coded false.
  it('negative control: an unowned asset reports ownershipGap=true', () => {
    const svc = newService();
    const a = id(1003);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'orphan',
        lifecycleState: 'operating',
        health: 'degraded',
        coverage: 'partial',
        updatedAt: at(0),
      }),
      fields: [],
    });
    const row = svc.rowFor(a, at(1));
    expect(row.ownershipGap).toBe(true);
    expect(row.ownerPrincipalId).toBeUndefined();
  });
});

// ===========================================================================
describe('AC2 — non-healthy component stays a VISIBLE coverage gap', () => {
  it('keeps an unmanaged/orphaned component visible with reason, age, impact, action, owner', () => {
    const svc = newService();
    const a = id(2001);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'ungoverned',
        lifecycleState: 'orphaned',
        health: 'unmanaged',
        coverage: 'gap',
        updatedAt: at(0),
      }),
      fields: [],
    });
    const gapId = id(2002);
    svc.ingestCoverageGap(
      makeCoverageGap({
        id: gapId,
        tenantId: PLATFORM_SCOPE,
        subjectKind: 'governed_asset',
        subjectId: a,
        gapClass: 'component',
        reason: 'orphaned',
        impact: 'high',
        requiredAction: 'Assign an owner and bring under governance',
        requiredOwner: OWNER,
        firstSeenAt: at(0),
      }),
    );

    // Stays VISIBLE on the component-gap surface.
    const comp = svc.componentGaps();
    expect(comp.map((g) => g.id)).toContain(gapId);
    const g = comp.find((x) => x.id === gapId)!;
    expect(g.reason).toBe('orphaned'); // reason
    expect(g.impact).toBe('high'); // impact
    expect(g.requiredAction).toMatch(/owner/i); // required owner action
    expect(g.requiredOwner).toBe(OWNER);
    expect(svc.gapAge(gapId, at(5 * MIN))).toBe(5 * MIN); // age

    // The row is bound to the gap and can NEVER be presented as covered+healthy.
    const row = svc.rowFor(a, at(1));
    expect(row.hasVisibleComponentGap).toBe(true);
    expect(row.coverage).toBe('gap');
    expect(row.observedHealth).toBe('unmanaged');
  });

  it('a resolved gap disappears from the visible surface but stays in the full history', () => {
    const svc = newService();
    const gapId = id(2003);
    svc.ingestCoverageGap(
      makeCoverageGap({
        id: gapId,
        tenantId: PLATFORM_SCOPE,
        subjectKind: 'component',
        gapClass: 'component',
        reason: 'unmanaged',
        requiredAction: 'onboard',
        status: 'resolved',
        resolution: 'onboarded under governance',
        firstSeenAt: at(0),
        resolvedAt: at(MIN),
      }),
    );
    expect(svc.componentGaps().map((g) => g.id)).not.toContain(gapId); // not visible
    expect(svc.coverageGaps().map((g) => g.id)).toContain(gapId); // never deleted (history)
  });

  // NEGATIVE CONTROL: a covered+healthy asset with NO gap must NOT appear on the gap surface and
  // its row must report hasVisibleComponentGap=false.
  it('negative control: a covered+healthy asset produces no visible component gap', () => {
    const svc = newService();
    const a = ingestHealthy(svc, id(2004), 0);
    expect(svc.componentGaps()).toHaveLength(0);
    expect(svc.rowFor(a, at(1)).hasVisibleComponentGap).toBe(false);
  });
});

// ===========================================================================
describe('AC3 — related work → distinct source records + correlation drilldown', () => {
  it('drill-down shows distinct records, status differences, dependencies, authoritative fields', () => {
    const svc = newService();
    const a = id(3001);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'workflow',
        name: 'release-flow',
        ownerPrincipalId: OWNER,
        lifecycleState: 'operating',
        health: 'healthy',
        coverage: 'covered',
        updatedAt: at(0),
      }),
      fields: ['owner'],
    });

    const kOwner = id(3101);
    const aOwner = id(3102);
    const recKanban = makeSourceRecord({
      id: id(3011),
      tenantId: PLATFORM_SCOPE,
      catalogId: id(3111),
      assetId: a,
      sourceClass: 'platform_kanban',
      externalKey: 'kanban:release-flow',
      observedState: { owner: kOwner },
      status: 'active',
      freshness: 'fresh',
      lastKnownAt: at(0),
      observedAt: at(0),
    });
    const recAgentctl = makeSourceRecord({
      id: id(3012),
      tenantId: PLATFORM_SCOPE,
      catalogId: id(3112),
      assetId: a,
      sourceClass: 'agentctl',
      externalKey: 'agentctl:release-flow',
      observedState: { owner: aOwner }, // DIFFERENT owner → status difference
      status: 'active',
      freshness: 'fresh',
      lastKnownAt: at(0),
      observedAt: at(0),
    });
    const recWorkflows = makeSourceRecord({
      id: id(3013),
      tenantId: PLATFORM_SCOPE,
      catalogId: id(3113),
      assetId: a,
      sourceClass: 'workflows_orchestration',
      externalKey: 'wf:release-flow',
      observedState: {},
      status: 'active',
      freshness: 'fresh',
      lastKnownAt: at(0),
      observedAt: at(0),
    });
    svc.ingestSourceRecord(recKanban);
    svc.ingestSourceRecord(recAgentctl);
    svc.ingestSourceRecord(recWorkflows);

    // AC3 dependency + authoritative-field edges.
    svc.ingestRelationship(
      makeInventoryRelationship({
        id: id(3021),
        tenantId: PLATFORM_SCOPE,
        fromKind: 'source_record',
        fromId: recWorkflows.id,
        toKind: 'source_record',
        toId: recAgentctl.id,
        relationship: 'depends_on',
        fieldName: 'triggers',
        createdAt: at(0),
      }),
      a,
    );
    svc.ingestRelationship(
      makeInventoryRelationship({
        id: id(3022),
        tenantId: PLATFORM_SCOPE,
        fromKind: 'source_record',
        fromId: recKanban.id,
        toKind: 'governed_asset',
        toId: a,
        relationship: 'authoritative_for',
        fieldName: 'owner',
        createdAt: at(0),
      }),
      a,
    );

    const dd = svc.drillDown(a, at(1));
    // Distinct records — three sources, none collapsed.
    expect(dd.sourceRecords).toHaveLength(3);
    // Correlation carries the per-field status difference.
    const ownerField = dd.correlation.fields.find((f) => f.field === 'owner')!;
    expect(ownerField.contested).toBe(true); // status difference detected
    expect(ownerField.differingSources.length).toBeGreaterThan(0);
    // platform_kanban outranks agentctl → its value wins authoritatively.
    expect(ownerField.resolution).toBe('resolved');
    expect(ownerField.value).toBe(kOwner);
    // Dependencies + authoritative fields surface.
    expect(dd.dependencies.map((d) => d.relationshipId)).toContain(id(3021));
    expect(dd.authoritativeFields.map((f) => f.field)).toContain('owner');
  });

  it('distinct records with the SAME identity collapse; distinct identities stay', () => {
    const svc = newService();
    const a = id(3002);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'workflow',
        name: 'x',
        ownerPrincipalId: OWNER,
        updatedAt: at(0),
      }),
      fields: [],
    });
    const base = {
      tenantId: PLATFORM_SCOPE,
      catalogId: id(3211),
      assetId: a,
      sourceClass: 'platform_kanban',
      externalKey: 'kanban:x', // same identity tuple
      status: 'active' as const,
      freshness: 'fresh' as const,
      lastKnownAt: at(0),
      observedAt: at(0),
    };
    svc.ingestSourceRecord(makeSourceRecord({ ...base, id: id(3311), confidence: 1 }));
    svc.ingestSourceRecord(makeSourceRecord({ ...base, id: id(3312), confidence: 1 }));
    expect(svc.sourceRecordsFor(a)).toHaveLength(1); // same identity → one record
  });

  // NEGATIVE CONTROL: agreeing sources are NOT contested — proves `contested` is real difference
  // detection, not always-true.
  it('negative control: agreeing sources report contested=false', () => {
    const svc = newService();
    const a = id(3003);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'workflow',
        name: 'y',
        ownerPrincipalId: OWNER,
        updatedAt: at(0),
      }),
      fields: ['owner'],
    });
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(3411),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(3511),
        assetId: a,
        sourceClass: 'platform_kanban',
        externalKey: 'k1',
        observedState: { owner: OWNER },
        status: 'active',
        freshness: 'fresh',
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(3412),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(3512),
        assetId: a,
        sourceClass: 'agentctl',
        externalKey: 'a1',
        observedState: { owner: OWNER }, // SAME value
        status: 'active',
        freshness: 'fresh',
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    const dd = svc.drillDown(a, at(1));
    const f = dd.correlation.fields.find((x) => x.field === 'owner')!;
    expect(f.contested).toBe(false);
  });
});

// ===========================================================================
describe('AC4 — stale/unavailable source marked; health not inferred from stale data', () => {
  it('a stale record drops confidence below 1 and withholds current health', () => {
    const svc = newService();
    const a = id(4001);
    svc.ingestAsset({
      asset: makeGovernedAsset({
        id: a,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'stale-agent',
        ownerPrincipalId: OWNER,
        lifecycleState: 'operating',
        health: 'healthy',
        coverage: 'covered',
        updatedAt: at(0),
      }),
      fields: ['owner'],
    });
    svc.ingestSourceRecord(
      makeSourceRecord({
        id: id(4011),
        tenantId: PLATFORM_SCOPE,
        catalogId: id(4111),
        assetId: a,
        sourceClass: 'platform_kanban',
        externalKey: 'kanban:stale-agent',
        observedState: { owner: OWNER },
        status: 'active',
        freshness: 'stale', // marked stale at source
        confidence: 0.9,
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    const row = svc.rowFor(a, at(30 * MIN)); // observed long ago relative to `at`
    expect(row.confidence).toBeLessThan(1); // marked with confidence
    expect(row.lastObservationAt).toBe(at(0)); // last-known time preserved
    expect(row.evidenceState).not.toBe('current');
    expect(row.observedHealth).toBe('healthy'); // asset's recorded health still shown verbatim
    expect(row.reportedHealth).toBe('unknown'); // but current health NOT inferred from stale data
  });

  // NEGATIVE CONTROL: a FRESH record within the horizon keeps full confidence and reports current
  // health — proves the withholding is specific to staleness, not a blanket 'unknown'.
  it('negative control: a fresh record within horizon reports current health at full confidence', () => {
    const svc = newService();
    const a = ingestHealthy(svc, id(4002), 0);
    const row = svc.rowFor(a, at(MIN)); // well within HORIZON
    expect(row.confidence).toBe(1);
    expect(row.evidenceState).toBe('current');
    expect(row.reportedHealth).toBe('healthy');
  });
});

// ===========================================================================
describe('AC5 — unregistered source ADDED to the catalog with discovery evidence', () => {
  it('catalogs a discovered source with type-or-unknown/location/access/sensitivity/ownership/onboarding', () => {
    const svc = newService();
    const catId = id(5001);
    const evidence = id(5002);
    svc.ingestCatalogEntry(
      makeSourceCatalogEntry({
        id: catId,
        tenantId: PLATFORM_SCOPE,
        sourceClass: UNKNOWN_SOURCE_CLASS, // type-or-unknown classification
        observedLocations: ['svc://mystery-source'], // location
        accessState: 'reachable', // access status
        sensitivity: 'sensitive', // sensitivity
        onboardingState: 'discovered', // onboarding state
        discoveryEvidence: evidence, // discovery evidence
        firstSeenAt: at(0),
        lastSeenAt: at(0),
      }),
    );
    const view = svc.catalogView().find((v) => v.catalogId === catId)!;
    expect(view.classifiedUnknown).toBe(true);
    expect(view.observedLocations).toContain('svc://mystery-source');
    expect(view.accessState).toBe('reachable');
    expect(view.sensitivity).toBe('sensitive');
    expect(view.onboardingState).toBe('discovered');
    expect(view.discoveryEvidence).toBe(evidence);
    expect(view.ownershipGap).toBe(true); // ownership status — no owner
  });

  // NEGATIVE CONTROL: a KNOWN, owned class must NOT be flagged unknown/ownership-gap.
  it('negative control: a known owned source is not classifiedUnknown and has no ownership gap', () => {
    const svc = newService();
    const catId = id(5003);
    svc.ingestCatalogEntry(
      makeSourceCatalogEntry({
        id: catId,
        tenantId: PLATFORM_SCOPE,
        sourceClass: 'platform_kanban',
        observedLocations: ['svc://kanban'],
        accessState: 'connected',
        ownerPrincipalId: OWNER,
        onboardingState: 'onboarded',
        healthState: 'healthy',
        firstSeenAt: at(0),
        lastSeenAt: at(0),
      }),
    );
    const view = svc.catalogView().find((v) => v.catalogId === catId)!;
    expect(view.classifiedUnknown).toBe(false);
    expect(view.ownershipGap).toBe(false);
  });
});

// ===========================================================================
describe('AC6 — discovered source stays a VISIBLE governed-source gap w/ review-or-expiry', () => {
  it('keeps an unsupported/inaccessible/sensitive/unowned source visible with reason/impact/action/review', () => {
    const svc = newService();
    const gapId = id(6001);
    svc.ingestCoverageGap(
      makeCoverageGap({
        id: gapId,
        tenantId: PLATFORM_SCOPE,
        subjectKind: 'source_catalog_entry',
        gapClass: 'governed_source',
        reason: 'unsupported',
        impact: 'critical',
        requiredAction: 'Owner must evaluate or formally exclude the source',
        requiredOwner: OWNER,
        firstSeenAt: at(0),
        reviewAt: at(60 * MIN), // review-or-expiry deadline
      }),
    );
    const gsg = svc.governedSourceGaps();
    expect(gsg.map((g) => g.id)).toContain(gapId); // stays VISIBLE
    const g = gsg.find((x) => x.id === gapId)!;
    expect(g.reason).toBe('unsupported'); // reason
    expect(g.impact).toBe('critical'); // impact
    expect(g.requiredAction).toMatch(/owner/i); // owner action
    expect(g.reviewAt).toBe(at(60 * MIN)); // review-or-expiry
  });

  // NEGATIVE CONTROL: a governed-source gap WITHOUT a review/expiry deadline must NOT appear in the
  // review-bearing surface — proves the review-or-expiry filter is real.
  it('negative control: a governed-source gap without review/expiry is excluded from that surface', () => {
    const svc = newService();
    const gapId = id(6002);
    svc.ingestCoverageGap(
      makeCoverageGap({
        id: gapId,
        tenantId: PLATFORM_SCOPE,
        subjectKind: 'source_catalog_entry',
        gapClass: 'governed_source',
        reason: 'inaccessible',
        impact: 'high',
        requiredAction: 'restore access',
        firstSeenAt: at(0),
        // no reviewAt / expiresAt
      }),
    );
    expect(svc.governedSourceGaps().map((g) => g.id)).not.toContain(gapId);
    // …but it is still recorded in the full gap history (never deleted).
    expect(svc.coverageGaps().map((g) => g.id)).toContain(gapId);
  });
});

// ===========================================================================
describe('witness — snapshotDigest is an independent, sensitive content witness', () => {
  it('is stable for identical state and changes when a governed fact changes', () => {
    const svcA = newService();
    const svcB = newService();
    const idA = id(7001);
    ingestHealthy(svcA, idA, 0);
    ingestHealthy(svcB, idA, 0);
    // Identical ingested state → identical digest at the same instant.
    expect(svcA.snapshotDigest(at(1))).toBe(svcB.snapshotDigest(at(1)));

    // Mutate a governed fact on B (supersede the asset with degraded health).
    svcB.ingestAsset({
      asset: makeGovernedAsset({
        id: idA,
        tenantId: PLATFORM_SCOPE,
        assetType: 'ai-agent',
        name: 'assistant',
        ownerPrincipalId: OWNER,
        lifecycleState: 'degraded',
        health: 'degraded',
        coverage: 'partial',
        updatedAt: at(10),
      }),
      fields: ['owner'],
    });
    expect(svcA.snapshotDigest(at(1))).not.toBe(svcB.snapshotDigest(at(1)));
  });

  // NEGATIVE CONTROL (harness sanity): a re-read of the SAME service returns the same digest — the
  // witness is a pure function of state, not of call order.
  it('negative control: re-reading the same state returns the same digest', () => {
    const svc = newService();
    ingestHealthy(svc, id(7002), 0);
    expect(svc.snapshotDigest(at(5))).toBe(svc.snapshotDigest(at(5)));
  });
});
