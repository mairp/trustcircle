// TrustCircleAI — Phase 63 unit tests for the inventory & open-ended source-catalog AGGREGATES.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// These tests are the executable evidence for Phase 63: the five aggregates
// (inventory-boundary, source-catalog [catalog entry + source contract], source-record,
// governed-asset, coverage-gap) plus the supporting inventory-relationship / correlation-case
// edges, implemented in `packages/domain/src/inventory.ts`, satisfy acceptance criteria AC1–AC6.
//
// Each aggregate is built by a REAL, dependency-free asserting factory whose constructed value is
// an independently-observable durable-effect witness: a stable `*Digest` sha256 content-hash that
// (a) could not exist before the value was constructed and (b) changes iff a governed facet
// changes. Every fail-visible invariant mirrored from `db/migrations/0010_inventory.sql` is proven
// NON-VACUOUS by a paired NEGATIVE CONTROL — a bad write that the factory REJECTS (the invariant
// actually bites), so a green run is not a permissive fake.
//
// AC → describe-block map:
//   AC1 healthy connected source renders ONCE with full facet set ... describe('AC1 …')
//   AC2 discovered-but-unmanaged component stays a VISIBLE gap ...... describe('AC2 …')
//   AC3 related work → distinct records + correlation + authority ... describe('AC3 …')
//   AC4 stale/unavailable source marked; health not inferred ........ describe('AC4 …')
//   AC5 unregistered source added to catalog w/ discovery evidence .. describe('AC5 …')
//   AC6 discovered source stays a VISIBLE governed-source gap ....... describe('AC6 …')
//
// Import path mirrors tests/unit/inventory-state-machines.test.ts: relative, `.ts` extension.

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import {
  // boundary
  makeInventoryBoundary,
  inventoryBoundaryDigest,
  BOUNDARY_STATUSES,
  // source contract
  makeSourceContract,
  sourceContractDigest,
  SUPPORT_LEVELS,
  // catalog entry
  makeSourceCatalogEntry,
  sourceCatalogEntryDigest,
  catalogEntryHasOwnershipGap,
  catalogEntryNeedsAttention,
  UNKNOWN_SOURCE_CLASS,
  ONBOARDING_STATES,
  ACCESS_STATES,
  CATALOG_HEALTH_STATES,
  // source record
  makeSourceRecord,
  sourceRecordIdentity,
  sourceRecordFreshnessSuspect,
  sourceRecordDigest,
  FRESHNESS_STATES,
  // governed asset
  makeGovernedAsset,
  governedAssetDigest,
  assetNeedsAttention,
  assetHasOwnershipGap,
  ASSET_HEALTH_STATES,
  COVERAGE_STATES,
  // relationship
  makeInventoryRelationship,
  relationshipEdgeIdentity,
  inventoryRelationshipDigest,
  RELATIONSHIP_KINDS,
  // correlation case
  makeCorrelationCase,
  correlationCaseIsOpen,
  correlationCaseDigest,
  // coverage gap
  makeCoverageGap,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  coverageGapDigest,
  GAP_REASONS,
} from '../../packages/domain/src/inventory.ts';

// Deterministic, injectable id/time helpers (never the wall clock).
const T0 = 1_700_000_000_000 as EpochMillis;
let seq = 0;
function nextId(): Uuid {
  seq += 1;
  // Distinct, monotonic UUIDv7 per call; deterministic entropy so runs reproduce.
  return uuidV7((T0 + seq) as EpochMillis, () => new Uint8Array(10).fill(seq & 0xff));
}
const TENANT = nextId();

describe('AC1 — healthy connected source renders ONCE with the full governed facet set', () => {
  it('constructs a covered+healthy governed asset carrying type, owner, lifecycle, risk, health, coverage, last observation, version', () => {
    const owner = nextId();
    const asset = makeGovernedAsset({
      id: nextId(),
      tenantId: TENANT,
      assetType: 'workflow',
      name: 'nightly-reconciler',
      ownerPrincipalId: owner,
      lifecycleState: 'operating',
      riskTier: 'high',
      health: 'healthy',
      coverage: 'covered',
      lastObservedAt: (T0 + 5_000) as EpochMillis,
      version: 3,
      updatedAt: (T0 + 6_000) as EpochMillis,
    });
    // Every AC1 facet is present and readable.
    expect(asset.assetType).toBe('workflow');
    expect(asset.ownerPrincipalId).toBe(owner);
    expect(asset.lifecycleState).toBe('operating');
    expect(asset.riskTier).toBe('high');
    expect(asset.health).toBe('healthy');
    expect(asset.coverage).toBe('covered');
    expect(asset.lastObservedAt).toBe(T0 + 5_000);
    expect(asset.version).toBe(3);
    expect(assetHasOwnershipGap(asset)).toBe(false);
    // A covered+healthy asset is NOT on the attention/gap surface — it renders once, cleanly.
    expect(assetNeedsAttention(asset)).toBe(false);
  });

  it('digest is a stable, order-independent durable-effect witness', () => {
    const owner = nextId();
    const id = nextId();
    const build = () =>
      makeGovernedAsset({
        id,
        tenantId: TENANT,
        assetType: 'model',
        name: 'risk-scorer',
        ownerPrincipalId: owner,
        lifecycleState: 'operating',
        riskTier: 'critical',
        health: 'healthy',
        coverage: 'covered',
        version: 1,
        updatedAt: T0,
      });
    expect(governedAssetDigest(build())).toBe(governedAssetDigest(build()));
    // A changed facet changes the digest (it witnesses content, not identity alone).
    const degraded = makeGovernedAsset({
      id,
      tenantId: TENANT,
      assetType: 'model',
      name: 'risk-scorer',
      ownerPrincipalId: owner,
      lifecycleState: 'degraded',
      riskTier: 'critical',
      health: 'degraded',
      coverage: 'partial',
      version: 1,
      updatedAt: T0,
    });
    expect(governedAssetDigest(degraded)).not.toBe(governedAssetDigest(build()));
  });

  // NEGATIVE CONTROL: governed_asset_covered_is_managed — a gap can NEVER masquerade as
  // covered+healthy; the factory rejects covered+unmanaged and covered+orphaned.
  it('rejects a covered asset that is simultaneously unmanaged or orphaned (covered_is_managed)', () => {
    expect(() =>
      makeGovernedAsset({
        id: nextId(),
        tenantId: TENANT,
        assetType: 'agent',
        name: 'x',
        coverage: 'covered',
        health: 'unmanaged',
        updatedAt: T0,
      }),
    ).toThrow(/covered_is_managed/);
    expect(() =>
      makeGovernedAsset({
        id: nextId(),
        tenantId: TENANT,
        assetType: 'agent',
        name: 'x',
        coverage: 'covered',
        lifecycleState: 'orphaned',
        updatedAt: T0,
      }),
    ).toThrow(/covered_is_managed/);
  });

  it('rejects version < 1 and an unknown health vocabulary value', () => {
    expect(() =>
      makeGovernedAsset({
        id: nextId(),
        tenantId: TENANT,
        assetType: 'a',
        name: 'n',
        version: 0,
        updatedAt: T0,
      }),
    ).toThrow(/version/);
    expect(() =>
      makeGovernedAsset({
        id: nextId(),
        tenantId: TENANT,
        assetType: 'a',
        name: 'n',
        // @ts-expect-error not a member of ASSET_HEALTH_STATES
        health: 'sparkling',
        updatedAt: T0,
      }),
    ).toThrow(/health/);
    // Positive control: every pinned health value IS accepted.
    for (const h of ASSET_HEALTH_STATES) {
      const coverage = h === 'unmanaged' ? 'gap' : 'partial';
      expect(() =>
        makeGovernedAsset({
          id: nextId(),
          tenantId: TENANT,
          assetType: 'a',
          name: 'n',
          health: h,
          coverage,
          updatedAt: T0,
        }),
      ).not.toThrow();
    }
    expect(COVERAGE_STATES).toContain('covered');
  });
});

describe('AC2 — discovered-but-unmanaged/unreachable/stale/orphaned component stays a VISIBLE coverage gap', () => {
  it('keeps a component gap with reason, age, impact, and a required owner action', () => {
    const gap = makeCoverageGap({
      id: nextId(),
      tenantId: TENANT,
      subjectKind: 'governed_asset',
      subjectId: nextId(),
      gapClass: 'component',
      reason: 'unmanaged',
      impact: 'high',
      requiredAction: 'assign an owner and onboard the component to management',
      firstSeenAt: T0,
      status: 'open',
    });
    expect(gap.reason).toBe('unmanaged');
    expect(gap.impact).toBe('high');
    expect(gap.requiredAction.length).toBeGreaterThan(0);
    // Age is derived from first_seen_at and never negative.
    expect(gapAgeMillis(gap, (T0 + 90_000) as EpochMillis)).toBe(90_000);
    expect(gapAgeMillis(gap, T0)).toBe(0);
    // It stays VISIBLE — it does not become healthy or disappear.
    expect(gapIsVisible(gap)).toBe(true);
  });

  it('covers every AC2 component reason (unmanaged/unreachable/stale/orphaned)', () => {
    for (const reason of ['unmanaged', 'unreachable', 'stale', 'orphaned'] as const) {
      const gap = makeCoverageGap({
        id: nextId(),
        tenantId: TENANT,
        subjectKind: 'component',
        reason,
        requiredAction: `remediate ${reason}`,
        firstSeenAt: T0,
      });
      expect(GAP_REASONS).toContain(gap.reason);
      expect(gapIsVisible(gap)).toBe(true);
    }
  });

  // NEGATIVE CONTROL: coverage_gap_action_present — a gap can never be a silent hole.
  it('rejects a gap with an empty required owner action (action_present)', () => {
    expect(() =>
      makeCoverageGap({
        id: nextId(),
        tenantId: TENANT,
        subjectKind: 'component',
        reason: 'unmanaged',
        requiredAction: '   ',
        firstSeenAt: T0,
      }),
    ).toThrow(/requiredAction/);
  });

  // NEGATIVE CONTROL: coverage_gap_resolution_when_resolved — a still-open gap can never look
  // closed, and a resolved gap must name a durable resolution + resolved time.
  it('enforces resolution-when-resolved in both directions', () => {
    // resolved status WITHOUT a resolution/time is rejected.
    expect(() =>
      makeCoverageGap({
        id: nextId(),
        tenantId: TENANT,
        subjectKind: 'component',
        reason: 'orphaned',
        requiredAction: 'reassign',
        firstSeenAt: T0,
        status: 'resolved',
      }),
    ).toThrow(/resolution_when_resolved/);
    // open status WITH a resolution is rejected (a still-open gap cannot look closed).
    expect(() =>
      makeCoverageGap({
        id: nextId(),
        tenantId: TENANT,
        subjectKind: 'component',
        reason: 'orphaned',
        requiredAction: 'reassign',
        firstSeenAt: T0,
        status: 'open',
        resolution: 'done',
        resolvedAt: (T0 + 1) as EpochMillis,
      }),
    ).toThrow(/resolution_when_resolved/);
    // The valid resolved form is accepted and is no longer on the visible surface.
    const resolved = makeCoverageGap({
      id: nextId(),
      tenantId: TENANT,
      subjectKind: 'component',
      reason: 'orphaned',
      requiredAction: 'reassign',
      firstSeenAt: T0,
      status: 'resolved',
      resolution: 'reassigned to platform-ops',
      resolvedAt: (T0 + 10_000) as EpochMillis,
    });
    expect(gapIsVisible(resolved)).toBe(false);
    expect(resolved.resolution).toMatch(/reassigned/);
  });

  it('coverage-gap digest witnesses the gap content', () => {
    const mk = () =>
      makeCoverageGap({
        id: TENANT, // reuse a stable id for determinism
        tenantId: TENANT,
        subjectKind: 'component',
        reason: 'stale',
        requiredAction: 're-observe the source',
        firstSeenAt: T0,
      });
    expect(coverageGapDigest(mk())).toBe(coverageGapDigest(mk()));
  });
});

describe('AC3 — related work across sources → distinct records, correlation, status differences, authoritative fields', () => {
  it('keeps related work from Kanban / agentctl / workflows_orchestration as DISTINCT source records', () => {
    const catalog = nextId();
    const kanban = makeSourceRecord({
      id: nextId(),
      tenantId: TENANT,
      catalogId: catalog,
      sourceClass: 'kanban',
      externalKey: 'CARD-42',
      status: 'active',
      freshness: 'fresh',
      lastKnownAt: T0,
      observedAt: T0,
    });
    const agentctl = makeSourceRecord({
      id: nextId(),
      tenantId: TENANT,
      catalogId: catalog,
      sourceClass: 'agentctl',
      externalKey: 'RUN-42',
      status: 'inactive',
      freshness: 'fresh',
      lastKnownAt: T0,
      observedAt: T0,
    });
    // Distinct external keys ⇒ distinct identities (never collapsed).
    expect(sourceRecordIdentity(kanban)).not.toBe(sourceRecordIdentity(agentctl));
    // Status differences are preserved on each record.
    expect(kanban.status).toBe('active');
    expect(agentctl.status).toBe('inactive');
  });

  it('records a correlation edge, a dependency, and an authoritative-field attribution', () => {
    const recA = nextId();
    const recB = nextId();
    const asset = nextId();
    const correlate = makeInventoryRelationship({
      id: nextId(),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: recA,
      toKind: 'governed_asset',
      toId: asset,
      relationship: 'correlates',
      createdAt: T0,
    });
    expect(correlate.relationship).toBe('correlates');
    const depends = makeInventoryRelationship({
      id: nextId(),
      tenantId: TENANT,
      fromKind: 'governed_asset',
      fromId: asset,
      toKind: 'governed_asset',
      toId: nextId(),
      relationship: 'depends_on',
      createdAt: T0,
    });
    expect(depends.relationship).toBe('depends_on');
    // Authoritative-field attribution names the field and defaults authoritative=true.
    const authority = makeInventoryRelationship({
      id: nextId(),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: recB,
      toKind: 'governed_asset',
      toId: asset,
      relationship: 'authoritative_for',
      fieldName: 'lifecycle_state',
      createdAt: T0,
    });
    expect(authority.authoritative).toBe(true);
    expect(authority.fieldName).toBe('lifecycle_state');
    // Distinct edges keep distinct identities.
    expect(relationshipEdgeIdentity(correlate)).not.toBe(relationshipEdgeIdentity(authority));
    expect(RELATIONSHIP_KINDS).toContain('authoritative_for');
    inventoryRelationshipDigest(authority); // constructs a witness without throwing
  });

  // NEGATIVE CONTROL: inventory_relationship_field_when_authoritative — an authoritative_for
  // edge must name the field it is authoritative for.
  it('rejects an authoritative_for edge that names no field (field_when_authoritative)', () => {
    expect(() =>
      makeInventoryRelationship({
        id: nextId(),
        tenantId: TENANT,
        fromKind: 'source_record',
        fromId: nextId(),
        toKind: 'governed_asset',
        toId: nextId(),
        relationship: 'authoritative_for',
        fieldName: '',
        createdAt: T0,
      }),
    ).toThrow(/field_when_authoritative/);
  });

  it('holds a field conflict as an OPEN correlation case and enforces resolution-when-terminal', () => {
    const open = makeCorrelationCase({
      id: nextId(),
      tenantId: TENANT,
      assetId: nextId(),
      caseType: 'field_conflict',
      status: 'open',
      conflicting: [
        { source: 'kanban', lifecycle_state: 'operating' },
        { source: 'agentctl', lifecycle_state: 'degraded' },
      ],
      requiredAction: 'a steward must choose the authoritative lifecycle_state',
      openedAt: T0,
    });
    expect(correlationCaseIsOpen(open)).toBe(true);
    expect(open.conflicting).toHaveLength(2);
    correlationCaseDigest(open);
    // NEGATIVE CONTROL: a terminal case WITHOUT a resolution is rejected.
    expect(() =>
      makeCorrelationCase({
        id: nextId(),
        tenantId: TENANT,
        caseType: 'field_conflict',
        status: 'resolved',
        openedAt: T0,
      }),
    ).toThrow(/resolution_when_terminal/);
    // NEGATIVE CONTROL: an OPEN case WITH a resolution is rejected.
    expect(() =>
      makeCorrelationCase({
        id: nextId(),
        tenantId: TENANT,
        status: 'open',
        openedAt: T0,
        resolution: 'x',
        resolvedAt: (T0 + 1) as EpochMillis,
      }),
    ).toThrow(/resolution_when_terminal/);
    // The valid resolved form is accepted and off the open surface.
    const resolved = makeCorrelationCase({
      id: nextId(),
      tenantId: TENANT,
      status: 'resolved',
      openedAt: T0,
      resolution: 'kanban is authoritative for lifecycle_state',
      resolvedAt: (T0 + 5_000) as EpochMillis,
    });
    expect(correlationCaseIsOpen(resolved)).toBe(false);
  });
});

describe('AC4 — stale/unavailable source marked with last-known time + confidence; health not inferred from stale data', () => {
  it('marks a stale observation with freshness, last_known_at, and a confidence, and the stale mirror agrees', () => {
    const record = makeSourceRecord({
      id: nextId(),
      tenantId: TENANT,
      catalogId: nextId(),
      sourceClass: 'agentctl',
      externalKey: 'RUN-7',
      observedState: { lastStatus: 'operating' },
      status: 'unknown', // status is READ from the observed field, not inferred as healthy
      freshness: 'stale',
      confidence: 0.4,
      lastKnownAt: (T0 - 3_600_000) as EpochMillis, // an hour ago
      observedAt: T0,
    });
    expect(record.freshness).toBe('stale');
    expect(record.stale).toBe(true);
    expect(record.confidence).toBeCloseTo(0.4);
    expect(record.lastKnownAt).toBe(T0 - 3_600_000);
    // Current health is NOT inferred from the stale row — it stays 'unknown'.
    expect(record.status).toBe('unknown');
    expect(sourceRecordFreshnessSuspect(record)).toBe(true);
    // A fresh record is not suspect.
    const fresh = makeSourceRecord({
      id: nextId(),
      tenantId: TENANT,
      catalogId: nextId(),
      sourceClass: 'kanban',
      externalKey: 'CARD-1',
      status: 'active',
      freshness: 'fresh',
      lastKnownAt: T0,
      observedAt: T0,
    });
    expect(fresh.stale).toBe(false);
    expect(sourceRecordFreshnessSuspect(fresh)).toBe(false);
    expect(FRESHNESS_STATES).toEqual(['fresh', 'stale', 'unknown']);
  });

  // NEGATIVE CONTROL: source_record_stale_agrees — the boolean mirror cannot disagree with the enum.
  it('rejects a stale boolean that disagrees with the freshness enum (stale_agrees)', () => {
    expect(() =>
      makeSourceRecord({
        id: nextId(),
        tenantId: TENANT,
        catalogId: nextId(),
        sourceClass: 'x',
        externalKey: 'k',
        freshness: 'stale',
        stale: false, // lies: says fresh while freshness=stale
        lastKnownAt: T0,
        observedAt: T0,
      }),
    ).toThrow(/stale_agrees/);
    expect(() =>
      makeSourceRecord({
        id: nextId(),
        tenantId: TENANT,
        catalogId: nextId(),
        sourceClass: 'x',
        externalKey: 'k',
        freshness: 'fresh',
        stale: true, // lies: says stale while freshness=fresh
        lastKnownAt: T0,
        observedAt: T0,
      }),
    ).toThrow(/stale_agrees/);
  });

  // NEGATIVE CONTROL: source_record_confidence_range — confidence ∈ [0,1].
  it('rejects a confidence outside [0,1] (confidence_range)', () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      expect(() =>
        makeSourceRecord({
          id: nextId(),
          tenantId: TENANT,
          catalogId: nextId(),
          sourceClass: 'x',
          externalKey: 'k',
          confidence: bad,
          lastKnownAt: T0,
          observedAt: T0,
        }),
      ).toThrow(/confidence_range/);
    }
  });

  it('source-record digest witnesses freshness so a stale row is content-distinct from a fresh one', () => {
    const base = {
      id: TENANT,
      tenantId: TENANT,
      catalogId: TENANT,
      sourceClass: 'x',
      externalKey: 'k',
      lastKnownAt: T0,
      observedAt: T0,
    } as const;
    const fresh = makeSourceRecord({ ...base, freshness: 'fresh' });
    const stale = makeSourceRecord({ ...base, freshness: 'stale' });
    expect(sourceRecordDigest(fresh)).not.toBe(sourceRecordDigest(stale));
  });
});

describe('AC5 — unregistered governance-relevant source added to the catalog with discovery evidence + classification', () => {
  it('adds a discovered source with discovery evidence, type-or-unknown class, location, access/sensitivity/ownership/onboarding state', () => {
    const entry = makeSourceCatalogEntry({
      id: nextId(),
      tenantId: TENANT,
      sourceClass: UNKNOWN_SOURCE_CLASS, // classification is type-or-'unknown'
      boundaryId: nextId(),
      observedLocations: ['nats://cluster/subject.x', 'https://vendor.example/api'],
      discoveryEvidence: nextId(),
      onboardingState: 'discovered',
      accessState: 'reachable',
      healthState: 'unknown',
      sensitivity: 'sensitive',
      firstSeenAt: T0,
      lastSeenAt: (T0 + 1_000) as EpochMillis,
    });
    expect(entry.sourceClass).toBe('unknown');
    expect(entry.discoveryEvidence).toBeDefined();
    expect(entry.observedLocations).toHaveLength(2);
    expect(entry.accessState).toBe('reachable');
    expect(entry.sensitivity).toBe('sensitive');
    expect(entry.onboardingState).toBe('discovered');
    // A null owner is an OWNERSHIP gap surfaced by the catalog, not silently accepted as owned.
    expect(catalogEntryHasOwnershipGap(entry)).toBe(true);
    // A newly-discovered source is NOT cleanly onboarded+connected+healthy → stays visible.
    expect(catalogEntryNeedsAttention(entry)).toBe(true);
    expect(ONBOARDING_STATES).toContain('discovered');
    expect(ACCESS_STATES).toContain('reachable');
    sourceCatalogEntryDigest(entry);
  });

  it('accepts an arbitrary vendor class (open-ended) and a fully-onboarded healthy entry', () => {
    const owner = nextId();
    const onboarded = makeSourceCatalogEntry({
      id: nextId(),
      tenantId: TENANT,
      sourceClass: 'acme.customvendor.v3', // arbitrary, not enum-bounded
      ownerPrincipalId: owner,
      onboardingState: 'onboarded',
      accessState: 'connected',
      healthState: 'healthy',
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    expect(onboarded.sourceClass).toBe('acme.customvendor.v3');
    expect(catalogEntryHasOwnershipGap(onboarded)).toBe(false);
    expect(catalogEntryNeedsAttention(onboarded)).toBe(false);
  });

  // NEGATIVE CONTROL: source_catalog_entry_unonboarded_not_healthy — a not-yet-onboarded source
  // may never be recorded as 'healthy'.
  it('rejects a not-yet-onboarded source that claims to be healthy (unonboarded_not_healthy)', () => {
    for (const onboarding of ['discovered', 'pending', 'excluded', 'retired'] as const) {
      expect(() =>
        makeSourceCatalogEntry({
          id: nextId(),
          tenantId: TENANT,
          sourceClass: 'x',
          onboardingState: onboarding,
          healthState: 'healthy',
          firstSeenAt: T0,
          lastSeenAt: T0,
        }),
      ).toThrow(/unonboarded_not_healthy/);
    }
    expect(CATALOG_HEALTH_STATES).toContain('healthy');
  });

  // NEGATIVE CONTROL: source_catalog_entry_seen_ordered — last_seen_at ≥ first_seen_at.
  it('rejects last_seen_at before first_seen_at (seen_ordered)', () => {
    expect(() =>
      makeSourceCatalogEntry({
        id: nextId(),
        tenantId: TENANT,
        sourceClass: 'x',
        firstSeenAt: (T0 + 10) as EpochMillis,
        lastSeenAt: T0,
      }),
    ).toThrow(/must be ≥/);
  });
});

describe('AC6 — unsupported/inaccessible/sensitive/unowned/excluded discovered source stays a VISIBLE governed-source gap', () => {
  it('keeps a governed-source gap with reason, impact, owner action, and a review-or-expiry deadline', () => {
    const gap = makeCoverageGap({
      id: nextId(),
      tenantId: TENANT,
      subjectKind: 'source_catalog_entry',
      subjectId: nextId(),
      gapClass: 'governed_source',
      reason: 'unsupported',
      impact: 'critical',
      requiredAction:
        'engage vendor to build a supported connector or formally exclude with sign-off',
      firstSeenAt: T0,
      reviewAt: (T0 + 30 * 86_400_000) as EpochMillis,
      expiresAt: (T0 + 90 * 86_400_000) as EpochMillis,
    });
    expect(gap.gapClass).toBe('governed_source');
    expect(gap.reason).toBe('unsupported');
    expect(gap.impact).toBe('critical');
    expect(gap.requiredAction.length).toBeGreaterThan(0);
    expect(gapHasReviewOrExpiry(gap)).toBe(true);
    expect(gapIsVisible(gap)).toBe(true);
  });

  it('covers every AC6 governed-source reason (excluded/unsupported/inaccessible/sensitive/unowned)', () => {
    for (const reason of [
      'excluded',
      'unsupported',
      'inaccessible',
      'sensitive',
      'unowned',
    ] as const) {
      const gap = makeCoverageGap({
        id: nextId(),
        tenantId: TENANT,
        subjectKind: 'source_catalog_entry',
        gapClass: 'governed_source',
        reason,
        requiredAction: `resolve ${reason} for this governed source`,
        firstSeenAt: T0,
        reviewAt: (T0 + 86_400_000) as EpochMillis,
      });
      expect(GAP_REASONS).toContain(gap.reason);
      expect(gapIsVisible(gap)).toBe(true);
      expect(gapHasReviewOrExpiry(gap)).toBe(true);
    }
  });

  it('an unsupported source contract backs the AC6 unsupported-source gap', () => {
    const contract = makeSourceContract({
      id: nextId(),
      tenantId: TENANT,
      sourceClass: 'legacy.mainframe',
      supportLevel: 'unsupported',
      authoritativeFields: ['external_id'],
      sensitivity: 'restricted',
      createdAt: T0,
      updatedAt: T0,
    });
    expect(contract.supportLevel).toBe('unsupported');
    expect(SUPPORT_LEVELS).toContain('unsupported');
    sourceContractDigest(contract);
  });

  // NEGATIVE CONTROL: an unknown gap reason is rejected (the vocabulary is pinned, not free text).
  it('rejects an unknown gap reason (reason vocabulary is pinned)', () => {
    expect(() =>
      makeCoverageGap({
        id: nextId(),
        tenantId: TENANT,
        subjectKind: 'source_catalog_entry',
        gapClass: 'governed_source',
        // @ts-expect-error not a member of GAP_REASONS
        reason: 'vibes',
        requiredAction: 'x',
        firstSeenAt: T0,
      }),
    ).toThrow(/reason/);
  });
});

describe('inventory-boundary — the governed discovery scope', () => {
  it('constructs a versioned, tenant-scoped boundary and rejects a bad status / version', () => {
    const boundary = makeInventoryBoundary({
      id: nextId(),
      tenantId: TENANT,
      name: 'production-ai-estate',
      version: 2,
      scope: { includedLocations: ['nats://*'], exclusions: [{ reason: 'sandbox' }] },
      status: 'active',
      createdAt: T0,
      updatedAt: (T0 + 1) as EpochMillis,
    });
    expect(boundary.version).toBe(2);
    expect(boundary.status).toBe('active');
    expect(BOUNDARY_STATUSES).toContain('active');
    inventoryBoundaryDigest(boundary);
    expect(() =>
      makeInventoryBoundary({
        id: nextId(),
        tenantId: TENANT,
        name: 'n',
        version: 0,
        createdAt: T0,
        updatedAt: T0,
      }),
    ).toThrow(/version/);
    expect(() =>
      // @ts-expect-error not a member of BOUNDARY_STATUSES
      makeInventoryBoundary({
        id: nextId(),
        tenantId: TENANT,
        name: 'n',
        status: 'paused',
        createdAt: T0,
        updatedAt: T0,
      }),
    ).toThrow(/status/);
  });

  it('supports the platform scope as a tenant and rejects a non-UUID tenant', () => {
    const b = makeInventoryBoundary({
      id: nextId(),
      tenantId: PLATFORM_SCOPE,
      name: 'global',
      createdAt: T0,
      updatedAt: T0,
    });
    expect(b.tenantId).toBe(PLATFORM_SCOPE);
    expect(() =>
      // @ts-expect-error tenantId must be a UUID or the platform scope
      makeInventoryBoundary({
        id: nextId(),
        tenantId: 'not-a-tenant',
        name: 'n',
        createdAt: T0,
        updatedAt: T0,
      }),
    ).toThrow(/tenant/);
  });
});
