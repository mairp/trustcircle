// TrustCircleAI — Phase 66 unit tests for the DISCOVERY PORTS.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// Executable evidence that `packages/application/src/discovery-ports.ts` — the SCAN / CANDIDATE /
// METADATA / ACCESS-LIMIT / SCAN-GAP hexagonal boundary plus its in-memory reference
// implementation (`InMemoryDiscovery`) composing the domain inventory model — satisfies
// acceptance criteria AC1–AC6.
//
// The ports are pure and deterministic: every scan / ingest / read call takes an explicit `at`
// epoch and draws identity from an injected deterministic UUIDv7 mint (no wall clock). The
// durable-effect witness for every mutation is NOT its return value but the INDEPENDENTLY
// re-readable state (`catalog()`, `recordsFor()`, `componentGaps()`, `governedSourceGaps()`,
// `currentState()`) and its content digest (`snapshotDigest()`), which changes iff a governed
// fact changes.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a scenario in which the rule
// must NOT fire, so a green run is not a permissive fake.
//
// AC → describe-block map:
//   AC1 healthy connected sources render ONCE with the full facet set ....... describe('AC1 …')
//   AC2 non-healthy component stays a VISIBLE coverage gap w/ reason/age .... describe('AC2 …')
//   AC3 related work across sources → distinct source records .............. describe('AC3 …')
//   AC4 stale source marked w/ last-known+confidence; health not inferred .. describe('AC4 …')
//   AC5 unregistered source ADDED to catalog with discovery evidence ....... describe('AC5 …')
//   AC6 discovered source stays a VISIBLE governed-source gap w/ review .... describe('AC6 …')

import { describe, it, expect } from 'vitest';
import { uuidV7, PLATFORM_SCOPE, type EpochMillis } from '../../packages/domain/src/primitives.ts';
import {
  gapIsVisible,
  gapHasReviewOrExpiry,
  gapAgeMillis,
  sourceRecordIdentity,
  UNKNOWN_SOURCE_CLASS,
} from '../../packages/domain/src/inventory.ts';
import {
  InMemoryDiscovery,
  makeDiscoveryCandidate,
  makeSourceMetadata,
  candidateHasOwnershipGap,
  candidateNeedsGovernance,
  discoveryCandidateDigest,
  concernGapClass,
  accessVerdictConcern,
  metadataHealthIsCurrent,
  metadataSuspect,
  allGovernedGapsHaveDeadline,
  ACCESS_LIMIT_VERDICTS,
  type IdMint,
  type AccessLimitPort,
  type AccessDecision,
  type AccessLimitVerdict,
} from '../../packages/application/src/discovery-ports.ts';

// ---------------------------------------------------------------------------
// Deterministic helpers — a monotonic UUIDv7 mint + a fixed random filler, so
// identities are reproducible and time-ordered without any wall-clock read.
// ---------------------------------------------------------------------------

const FIXED_RANDOM = () => new Uint8Array(16).fill(0x7a);

function mintFactory(seed = 1): IdMint {
  let n = seed;
  return () => uuidV7((n += 1) as EpochMillis, FIXED_RANDOM);
}

const T0 = 1_700_000_000_000 as EpochMillis;
const MIN = 60_000;
const HORIZON = 15 * MIN;

/** A configurable access-limit port: a policy map from location → verdict, default `admit`. */
function accessPort(
  policy: Record<
    string,
    { verdict: AccessLimitVerdict; inBoundary?: boolean; reviewAt?: EpochMillis }
  > = {},
): AccessLimitPort {
  return {
    decide({ location }): AccessDecision {
      const p = policy[location] ?? { verdict: 'admit' as AccessLimitVerdict };
      const verdict = p.verdict;
      const inBoundary = p.inBoundary ?? verdict !== 'out_of_boundary';
      const concern = accessVerdictConcern(verdict);
      return Object.freeze({
        verdict,
        inBoundary,
        ...(concern !== undefined ? { concern } : {}),
        ...(p.reviewAt !== undefined ? { reviewAt: p.reviewAt } : {}),
      });
    },
  };
}

function makeDiscovery(
  policy: Record<
    string,
    { verdict: AccessLimitVerdict; inBoundary?: boolean; reviewAt?: EpochMillis }
  > = {},
  seed = 1,
): InMemoryDiscovery {
  return new InMemoryDiscovery({
    tenantId: PLATFORM_SCOPE,
    mint: mintFactory(seed),
    access: accessPort(policy),
    freshnessHorizonMs: HORIZON,
  });
}

const OWNER = uuidV7(T0 as EpochMillis, FIXED_RANDOM);

// ===========================================================================
// AC1 — Healthy connected sources render ONCE with the full facet set.
// ===========================================================================

describe('AC1 — connected sources render once with the full facet set', () => {
  it('a scanned+ingested source appears EXACTLY once with every facet', () => {
    const d = makeDiscovery({ 'svc://kanban': { verdict: 'admit' } });
    const { candidates } = d.scan({
      tenantId: PLATFORM_SCOPE,
      locations: ['svc://kanban'],
      at: T0,
    });
    expect(candidates).toHaveLength(1);
    const cand = makeDiscoveryCandidate({
      ...candidates[0]!,
      sourceClass: 'kanban',
      ownerPrincipalId: OWNER,
    });
    d.ingest({ externalKey: 'kanban:main', candidate: cand, at: T0 });

    const rows = d.currentState();
    // Exactly one row (no duplication across read paths).
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Full facet set present.
    expect(row.sourceClass).toBe('kanban');
    expect(row.ownerPrincipalId).toBe(OWNER);
    expect(row.ownershipGap).toBe(false);
    expect(row.onboardingState).toBe('discovered');
    expect(row.accessState).toBe('reachable');
    expect(row.sensitivity).toBe('normal');
    expect(row.lastObservationAt).toBe(T0);
    expect(typeof row.unresolvedIssues).toBe('number');
    // Independent witness: exactly one catalog identity.
    expect(d.catalog()).toHaveLength(1);
  });

  it('re-ingesting the SAME external key updates in place — still ONE row (idempotent identity)', () => {
    const d = makeDiscovery({ 'svc://kanban': { verdict: 'admit' } });
    const scan1 = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['svc://kanban'], at: T0 });
    const c1 = makeDiscoveryCandidate({
      ...scan1.candidates[0]!,
      sourceClass: 'kanban',
      ownerPrincipalId: OWNER,
    });
    const r1 = d.ingest({ externalKey: 'kanban:main', candidate: c1, at: T0 });

    const scan2 = d.scan({
      tenantId: PLATFORM_SCOPE,
      locations: ['svc://kanban'],
      at: (T0 + MIN) as EpochMillis,
    });
    const c2 = makeDiscoveryCandidate({
      ...scan2.candidates[0]!,
      sourceClass: 'kanban',
      ownerPrincipalId: OWNER,
    });
    const r2 = d.ingest({
      externalKey: 'kanban:main',
      candidate: c2,
      at: (T0 + MIN) as EpochMillis,
    });

    expect(r2.catalog.id).toBe(r1.catalog.id); // same catalog identity
    expect(r2.catalog.firstSeenAt).toBe(T0); // firstSeen preserved
    expect(r2.catalog.lastSeenAt).toBe(T0 + MIN); // lastSeen advanced
    expect(d.currentState()).toHaveLength(1); // still exactly ONE row
  });

  it('NEGATIVE CONTROL — two DISTINCT external keys yield two rows (no false collapse)', () => {
    const d = makeDiscovery({ 'svc://a': { verdict: 'admit' }, 'svc://b': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['svc://a', 'svc://b'], at: T0 });
    d.ingest({
      externalKey: 'a',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]!, ownerPrincipalId: OWNER }),
      at: T0,
    });
    d.ingest({
      externalKey: 'b',
      candidate: makeDiscoveryCandidate({ ...s.candidates[1]!, ownerPrincipalId: OWNER }),
      at: T0,
    });
    expect(d.currentState()).toHaveLength(2); // rule is non-vacuous: distinct keys DON'T collapse
  });
});

// ===========================================================================
// AC2 — A non-healthy component stays a VISIBLE coverage gap with reason, age,
//        impact, required owner action.
// ===========================================================================

describe('AC2 — non-healthy component stays a VISIBLE coverage gap', () => {
  it('an unreachable component stays visible as a component gap with reason/age/impact/action', () => {
    const d = makeDiscovery();
    const cand = makeDiscoveryCandidate({
      id: mintFactory(90)(),
      tenantId: PLATFORM_SCOPE,
      sourceClass: 'component',
      observedLocations: ['host://db'],
      accessState: 'unreachable',
      ownerPrincipalId: OWNER,
      discoveryEvidence: mintFactory(91)(),
      concerns: ['unreachable'],
      observedAt: T0,
    });
    d.ingest({ externalKey: 'db', candidate: cand, at: T0 });

    const gaps = d.componentGaps();
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    const gap = gaps.find((g) => g.reason === 'unreachable')!;
    expect(gap.gapClass).toBe('component');
    expect(gapIsVisible(gap)).toBe(true); // never disappearing
    expect(gap.requiredAction.length).toBeGreaterThan(0); // owner action present
    expect(gap.impact).toBe('high');
    // Age is derivable and non-negative.
    expect(gapAgeMillis(gap, (T0 + 5 * MIN) as EpochMillis)).toBe(5 * MIN);
  });

  it('the component source NEVER reports as healthy while a gap is open', () => {
    const d = makeDiscovery();
    const cand = makeDiscoveryCandidate({
      id: mintFactory(92)(),
      tenantId: PLATFORM_SCOPE,
      sourceClass: 'component',
      observedLocations: ['host://db'],
      accessState: 'unreachable',
      ownerPrincipalId: OWNER,
      discoveryEvidence: mintFactory(93)(),
      concerns: ['unreachable'],
      observedAt: T0,
    });
    d.ingest({ externalKey: 'db', candidate: cand, at: T0 });
    const row = d.currentState()[0]!;
    expect(row.healthState).not.toBe('healthy'); // never masquerades as healthy
    expect(row.unresolvedIssues).toBeGreaterThanOrEqual(1);
    expect(row.needsAttention).toBe(true);
  });

  it('NEGATIVE CONTROL — a cleanly-admitted owned source opens NO component gap', () => {
    const d = makeDiscovery({ 'svc://ok': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['svc://ok'], at: T0 });
    d.ingest({
      externalKey: 'ok',
      candidate: makeDiscoveryCandidate({
        ...s.candidates[0]!,
        sourceClass: 'kanban',
        ownerPrincipalId: OWNER,
      }),
      at: T0,
    });
    expect(d.componentGaps()).toHaveLength(0); // rule non-vacuous: no gap when clean
  });
});

// ===========================================================================
// AC3 — Related work across registered sources keeps DISTINCT source records.
// ===========================================================================

describe('AC3 — related work keeps distinct source records', () => {
  it('two related sources produce two DISTINCT source records with distinct identities', () => {
    const d = makeDiscovery({
      'svc://kanban': { verdict: 'admit' },
      'svc://agentctl': { verdict: 'admit' },
    });
    const s = d.scan({
      tenantId: PLATFORM_SCOPE,
      locations: ['svc://kanban', 'svc://agentctl'],
      at: T0,
    });
    const r1 = d.ingest({
      externalKey: 'kanban:1',
      candidate: makeDiscoveryCandidate({
        ...s.candidates[0]!,
        sourceClass: 'kanban',
        ownerPrincipalId: OWNER,
      }),
      at: T0,
    });
    const r2 = d.ingest({
      externalKey: 'agentctl:1',
      candidate: makeDiscoveryCandidate({
        ...s.candidates[1]!,
        sourceClass: 'agentctl',
        ownerPrincipalId: OWNER,
      }),
      at: T0,
    });

    expect(sourceRecordIdentity(r1.record)).not.toBe(sourceRecordIdentity(r2.record));
    expect(d.allRecords()).toHaveLength(2);
    // Each catalog identity carries its own distinct record set.
    expect(d.recordsFor(r1.catalog.id)).toHaveLength(1);
    expect(d.recordsFor(r2.catalog.id)).toHaveLength(1);
    expect(r1.record.sourceClass).toBe('kanban');
    expect(r2.record.sourceClass).toBe('agentctl');
  });

  it('NEGATIVE CONTROL — the same identity does NOT create a second record set for another catalog', () => {
    const d = makeDiscovery({ 'svc://k': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['svc://k'], at: T0 });
    const r = d.ingest({
      externalKey: 'k:1',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]!, ownerPrincipalId: OWNER }),
      at: T0,
    });
    const otherCatalog = mintFactory(500)();
    expect(d.recordsFor(otherCatalog)).toHaveLength(0); // records are catalog-scoped, non-vacuous
    expect(d.recordsFor(r.catalog.id)).toHaveLength(1);
  });
});

// ===========================================================================
// AC4 — Stale source marked with last-known time + confidence; current health
//        NOT inferred from stale data.
// ===========================================================================

describe('AC4 — stale source marked; health not inferred from stale data', () => {
  it('a metadata read within the horizon is FRESH and health may be treated as current', () => {
    const d = makeDiscovery({ 'svc://k': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['svc://k'], at: T0 });
    const r = d.ingest({
      externalKey: 'k',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]!, ownerPrincipalId: OWNER }),
      at: T0,
    });
    const meta = d.read({
      tenantId: PLATFORM_SCOPE,
      catalogId: r.catalog.id,
      at: (T0 + MIN) as EpochMillis,
    })!;
    expect(meta.freshness).toBe('fresh');
    expect(meta.staleMarked).toBe(false);
    expect(meta.confidence).toBe(1.0);
    expect(meta.lastKnownAt).toBe(T0);
    expect(metadataHealthIsCurrent(meta)).toBe(true);
    expect(metadataSuspect(meta)).toBe(false);
  });

  it('a metadata read PAST the horizon is STALE, marked, low-confidence, and health→unknown', () => {
    const d = makeDiscovery({ 'svc://k': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['svc://k'], at: T0 });
    const r = d.ingest({
      externalKey: 'k',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]!, ownerPrincipalId: OWNER }),
      at: T0,
    });
    const at = (T0 + HORIZON + MIN) as EpochMillis;
    const meta = d.read({ tenantId: PLATFORM_SCOPE, catalogId: r.catalog.id, at })!;
    expect(meta.freshness).toBe('stale');
    expect(meta.staleMarked).toBe(true); // MARKED, not silently dropped
    expect(meta.confidence).toBeLessThan(1.0);
    expect(meta.lastKnownAt).toBe(T0); // last-known time retained
    expect(meta.reportedHealth).toBe('unknown'); // NOT inferred from stale data
    expect(metadataHealthIsCurrent(meta)).toBe(false);
    expect(metadataSuspect(meta)).toBe(true);
  });

  it('makeSourceMetadata collapses observed health to unknown when not fresh (unit-level)', () => {
    const catalogId = mintFactory(600)();
    const stale = makeSourceMetadata({
      catalogId,
      tenantId: PLATFORM_SCOPE,
      sourceClass: 'kanban',
      freshness: 'stale',
      confidence: 0.3,
      lastKnownAt: T0,
      observedHealth: 'healthy', // even if the LAST observation said healthy...
    });
    expect(stale.reportedHealth).toBe('unknown'); // ...it is NOT reported as current
    // NEGATIVE CONTROL — a fresh read preserves the observed health.
    const fresh = makeSourceMetadata({
      catalogId,
      tenantId: PLATFORM_SCOPE,
      sourceClass: 'kanban',
      freshness: 'fresh',
      confidence: 1.0,
      lastKnownAt: T0,
      observedHealth: 'degraded',
    });
    expect(fresh.reportedHealth).toBe('degraded'); // rule non-vacuous
  });
});

// ===========================================================================
// AC5 — An unregistered governance-relevant source in the boundary is ADDED to
//        the catalog with discovery evidence / type-or-unknown / location /
//        access / sensitivity / ownership status / onboarding state.
// ===========================================================================

describe('AC5 — unregistered source ADDED to catalog with discovery evidence', () => {
  it('an in-boundary unknown-class source is added with full discovery facets', () => {
    const d = makeDiscovery({ 'host://mystery': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://mystery'], at: T0 });
    const cand = makeDiscoveryCandidate({ ...s.candidates[0]! }); // no class ⇒ unknown, no owner
    expect(cand.classifiedUnknown).toBe(true);
    const res = d.ingest({ externalKey: 'mystery', candidate: cand, at: T0 });

    const entry = res.catalog;
    expect(entry.sourceClass).toBe(UNKNOWN_SOURCE_CLASS); // type-or-unknown
    expect(entry.discoveryEvidence).toBeDefined(); // discovery evidence
    expect(entry.observedLocations).toContain('host://mystery'); // location
    expect(entry.accessState).toBeDefined(); // access status
    expect(entry.sensitivity).toBeDefined(); // sensitivity
    expect(entry.onboardingState).toBe('discovered'); // onboarding state — NOT onboarded
    expect(entry.healthState).not.toBe('healthy'); // never a healthy masquerade
    // Independently re-readable in the catalog.
    expect(d.catalog().some((e) => e.id === entry.id)).toBe(true);
  });

  it('the ingest is durably witnessed — snapshotDigest CHANGES', () => {
    const d = makeDiscovery({ 'host://x': { verdict: 'admit' } });
    const before = d.snapshotDigest();
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://x'], at: T0 });
    d.ingest({
      externalKey: 'x',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]! }),
      at: T0,
    });
    expect(d.snapshotDigest()).not.toBe(before);
  });

  it('NEGATIVE CONTROL — an OUT-OF-BOUNDARY location is NOT added to the catalog', () => {
    const d = makeDiscovery({
      'host://outside': { verdict: 'out_of_boundary', inBoundary: false },
    });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://outside'], at: T0 });
    expect(s.candidates).toHaveLength(0); // dropped from ingestion
    expect(s.report.outOfBoundary).toBe(1);
    expect(d.catalog()).toHaveLength(0); // rule non-vacuous: boundary is enforced
  });
});

// ===========================================================================
// AC6 — A discovered source that is unsupported / inaccessible / sensitive /
//        unowned / excluded stays a VISIBLE governed-source gap with reason,
//        impact, owner action, and review-or-expiry.
// ===========================================================================

describe('AC6 — discovered source stays a VISIBLE governed-source gap w/ review', () => {
  it('an inaccessible source is a visible governed-source gap with a review deadline', () => {
    const d = makeDiscovery({ 'host://locked': { verdict: 'inaccessible' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://locked'], at: T0 });
    d.ingest({
      externalKey: 'locked',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]!, ownerPrincipalId: OWNER }),
      at: T0,
    });

    const gaps = d.governedSourceGaps();
    const gap = gaps.find((g) => g.reason === 'inaccessible')!;
    expect(gap.gapClass).toBe('governed_source');
    expect(gapIsVisible(gap)).toBe(true);
    expect(gap.requiredAction.length).toBeGreaterThan(0); // owner action
    expect(gapHasReviewOrExpiry(gap)).toBe(true); // review-or-expiry deadline
    expect(allGovernedGapsHaveDeadline(gaps)).toBe(true);
  });

  it('an UNOWNED discovered source raises an unowned governed-source gap', () => {
    const d = makeDiscovery({ 'host://orphan': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://orphan'], at: T0 });
    const cand = makeDiscoveryCandidate({ ...s.candidates[0]! }); // no owner
    expect(candidateHasOwnershipGap(cand)).toBe(true);
    d.ingest({ externalKey: 'orphan', candidate: cand, at: T0 });
    const gaps = d.governedSourceGaps();
    expect(gaps.some((g) => g.reason === 'unowned')).toBe(true);
    expect(allGovernedGapsHaveDeadline(gaps)).toBe(true);
  });

  it('an EXCLUDED source is catalogued as excluded and stays a visible gap', () => {
    const d = makeDiscovery({ 'host://ex': { verdict: 'excluded' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://ex'], at: T0 });
    const res = d.ingest({
      externalKey: 'ex',
      candidate: makeDiscoveryCandidate({ ...s.candidates[0]!, ownerPrincipalId: OWNER }),
      at: T0,
    });
    expect(res.catalog.onboardingState).toBe('excluded');
    expect(d.governedSourceGaps().some((g) => g.reason === 'excluded')).toBe(true);
  });

  it('NEGATIVE CONTROL — a cleanly-admitted OWNED source raises NO governed-source gap', () => {
    const d = makeDiscovery({ 'host://ok': { verdict: 'admit' } });
    const s = d.scan({ tenantId: PLATFORM_SCOPE, locations: ['host://ok'], at: T0 });
    d.ingest({
      externalKey: 'ok',
      candidate: makeDiscoveryCandidate({
        ...s.candidates[0]!,
        sourceClass: 'kanban',
        ownerPrincipalId: OWNER,
      }),
      at: T0,
    });
    expect(d.governedSourceGaps()).toHaveLength(0); // rule non-vacuous
  });
});

// ===========================================================================
// Pure helper / constructor units (fail-fast guards, classification, mapping).
// ===========================================================================

describe('pure constructors + guards', () => {
  it('makeDiscoveryCandidate rejects an empty observed-locations list', () => {
    expect(() =>
      makeDiscoveryCandidate({
        id: mintFactory(700)(),
        tenantId: PLATFORM_SCOPE,
        observedLocations: [],
        discoveryEvidence: mintFactory(701)(),
        observedAt: T0,
      }),
    ).toThrow();
  });

  it('candidateNeedsGovernance is true for unknown/unowned and false for a clean owned candidate', () => {
    const dirty = makeDiscoveryCandidate({
      id: mintFactory(710)(),
      tenantId: PLATFORM_SCOPE,
      observedLocations: ['x'],
      discoveryEvidence: mintFactory(711)(),
      observedAt: T0,
    });
    expect(candidateNeedsGovernance(dirty)).toBe(true);
    const clean = makeDiscoveryCandidate({
      id: mintFactory(712)(),
      tenantId: PLATFORM_SCOPE,
      sourceClass: 'kanban',
      observedLocations: ['x'],
      accessState: 'connected',
      ownerPrincipalId: OWNER,
      discoveryEvidence: mintFactory(713)(),
      observedAt: T0,
    });
    expect(candidateNeedsGovernance(clean)).toBe(false); // non-vacuous
  });

  it('concernGapClass partitions component vs governed-source concerns', () => {
    expect(concernGapClass('unreachable')).toBe('component');
    expect(concernGapClass('orphaned')).toBe('component');
    expect(concernGapClass('inaccessible')).toBe('governed_source');
    expect(concernGapClass('unowned')).toBe('governed_source');
  });

  it('accessVerdictConcern maps every non-admit boundary verdict and admit→undefined', () => {
    for (const v of ACCESS_LIMIT_VERDICTS) {
      const c = accessVerdictConcern(v);
      if (v === 'admit' || v === 'out_of_boundary') expect(c).toBeUndefined();
      else expect(c).toBeDefined();
    }
  });

  it('discoveryCandidateDigest is stable and changes with content', () => {
    const base = {
      id: mintFactory(720)(),
      tenantId: PLATFORM_SCOPE,
      observedLocations: ['x'],
      discoveryEvidence: mintFactory(721)(),
      observedAt: T0,
    };
    const a = makeDiscoveryCandidate(base);
    const b = makeDiscoveryCandidate(base);
    expect(discoveryCandidateDigest(a)).toBe(discoveryCandidateDigest(b)); // deterministic
    const c = makeDiscoveryCandidate({ ...base, sensitivity: 'sensitive' });
    expect(discoveryCandidateDigest(c)).not.toBe(discoveryCandidateDigest(a)); // content-sensitive
  });
});
