// TrustCircleAI — Phase 72 unit tests for the SOURCE STEWARDSHIP command service.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// Executable evidence that `packages/application/src/source-stewardship.ts` — the governed steward
// commands (approve onboarding, assign ownership, declare authoritative fields, request access,
// quarantine, defer, exclude) over a discovered source — enforces a MANDATORY reason, scope, and
// review date and records an immutable, independently-readable AUDIT TRAIL for every decision
// (VO-fa865d7856056565038e), while preserving AC1–AC6 through the wrapped registry.
//
// The service is pure + deterministic: every command takes an explicit `at` epoch and mints audit
// identity from an injected deterministic UUIDv7 factory (no wall clock). The durable-effect witness
// for every command is NOT its return value but the INDEPENDENTLY re-readable audit trail
// (`auditTrail()` / `auditTrailFor()` / `auditTrailDigest()`) and the registry read paths
// (`currentStateView()`, `coverageGaps()`).
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a scenario in which the rule must
// NOT fire (a valid decision is accepted; a legal transition succeeds), so a green run is not a
// permissive fake.

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  makeReason,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import {
  gapIsVisible,
  gapHasReviewOrExpiry,
  gapAgeMillis,
  makeSourceRecord,
  GAP_IMPACTS,
} from '../../packages/domain/src/inventory.ts';
import {
  SourceStewardship,
  STEWARD_COMMANDS,
  stewardAuditEntryDigest,
  type StewardDecision,
} from '../../packages/application/src/source-stewardship.ts';
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
const REVIEW = at(30 * 24 * 60); // +30 days.
const ACTOR = id(900);

function newStewardship(seed = 1): SourceStewardship {
  return new SourceStewardship({
    tenantId: PLATFORM_SCOPE,
    newId: idFactory(seed),
    stalenessHorizonMillis: HORIZON,
  });
}

/** A well-formed decision envelope (actor / reason / scope / review / at). */
function decision(overrides: Partial<StewardDecision> = {}): StewardDecision {
  return {
    actorPrincipalId: ACTOR,
    reason: makeReason('steward.decision', 'a governed steward decision'),
    scope: 'covers the whole source',
    reviewAt: REVIEW,
    at: at(0),
    ...overrides,
  };
}

/** Discover a source and register a contract + owner so it is onboardable. Returns the source id. */
function discoverOnboardable(s: SourceStewardship, key: string): Uuid {
  const reg = s.registrySurface();
  const entry = reg.discover({
    externalKey: key,
    sourceClass: key,
    location: `svc://${key}`,
    accessState: 'connected',
    discoveryEvidence: id(10),
    at: at(0),
  });
  reg.registerContract({ sourceId: entry.id, version: 1, supportLevel: 'supported', at: at(0) });
  reg.assignOwner({ sourceId: entry.id, ownerPrincipalId: id(11), at: at(0) });
  return entry.id;
}

/** Discover a bare source with no owner/contract. */
function discoverBare(
  s: SourceStewardship,
  key: string,
  accessState: 'connected' | 'unreachable' = 'connected',
): Uuid {
  return s.registrySurface().discover({
    externalKey: key,
    sourceClass: key,
    location: `svc://${key}`,
    accessState,
    discoveryEvidence: id(12),
    at: at(0),
  }).id;
}

// ===========================================================================
// VO-fa865d78 — every steward command REQUIRES reason + scope + review date + audit trail.
// ===========================================================================

describe('VO-fa865d78: mandatory reason + scope + review date on every steward command', () => {
  it('the command vocabulary is exactly the seven governed steward commands', () => {
    expect([...STEWARD_COMMANDS].sort()).toEqual(
      [
        'approve_onboarding',
        'assign_ownership',
        'declare_authoritative_fields',
        'request_access',
        'quarantine',
        'defer',
        'exclude',
      ].sort(),
    );
  });

  it('REJECTS a decision with an empty reason text (makeReason guards it)', () => {
    expect(() => makeReason('x.y', '   ')).toThrow(/reason text is mandatory/);
  });

  it('REJECTS a decision with an empty scope', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'no-scope');
    expect(() =>
      s.assignOwnership({ sourceId: src, ownerPrincipalId: id(20), ...decision({ scope: '   ' }) }),
    ).toThrow(/scope must be a non-empty string/);
  });

  it('REJECTS a review date that is not strictly after the decision time', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'past-review');
    expect(() =>
      s.assignOwnership({
        sourceId: src,
        ownerPrincipalId: id(20),
        ...decision({ reviewAt: at(0) }),
      }),
    ).toThrow(/review date strictly after/);
  });

  it('REJECTS an expiry that is not strictly after the decision time', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'past-expiry');
    expect(() => s.exclude({ sourceId: src, ...decision({ expiresAt: at(0) }) })).toThrow(
      /expiresAt must be strictly after/,
    );
  });

  it('REJECTS a non-UUID actor', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'bad-actor');
    expect(() =>
      s.assignOwnership({
        sourceId: src,
        ownerPrincipalId: id(20),
        ...decision({ actorPrincipalId: 'not-a-uuid' as Uuid }),
      }),
    ).toThrow(/actorPrincipalId must be a UUID/);
  });

  it('NEGATIVE CONTROL: a well-formed decision is ACCEPTED and appends one audit entry', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'ok');
    const before = s.auditTrail().length;
    const { audit } = s.assignOwnership({ sourceId: src, ownerPrincipalId: id(20), ...decision() });
    expect(s.auditTrail().length).toBe(before + 1);
    // The trail is the proof, not the return value: re-read it independently.
    const trail = s.auditTrailFor(src);
    expect(trail).toHaveLength(1);
    expect(trail[0]!.id).toBe(audit.id);
    expect(trail[0]!.command).toBe('assign_ownership');
    expect(trail[0]!.reason.text.length).toBeGreaterThan(0);
    expect(trail[0]!.scope.length).toBeGreaterThan(0);
    expect(trail[0]!.reviewAt).toBe(REVIEW);
    expect(trail[0]!.actorPrincipalId).toBe(ACTOR);
  });
});

// ===========================================================================
// The AUDIT TRAIL is append-only, immutable, and independently digest-witnessed.
// ===========================================================================

describe('audit trail is append-only, immutable, and digest-witnessed', () => {
  it('records every command in order with a before→after digest per entry', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'ordered');
    s.assignOwnership({ sourceId: src, ownerPrincipalId: id(30), ...decision() });
    s.approveOnboarding({ sourceId: src, ...decision() });
    const trail = s.auditTrailFor(src);
    expect(trail.map((e) => e.command)).toEqual(['assign_ownership', 'approve_onboarding']);
    for (const e of trail) {
      expect(e.beforeDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(e.afterDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // approve_onboarding changes the catalog entry ⇒ before ≠ after digest.
    const approve = trail.find((e) => e.command === 'approve_onboarding')!;
    expect(approve.beforeDigest).not.toBe(approve.afterDigest);
  });

  it('a recorded entry is frozen (cannot be back-edited)', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'frozen');
    const { audit } = s.assignOwnership({ sourceId: src, ownerPrincipalId: id(31), ...decision() });
    expect(Object.isFrozen(audit)).toBe(true);
    expect(() => {
      (audit as { scope: string }).scope = 'tampered';
    }).toThrow();
  });

  it('the trail digest CHANGES when a new decision is appended (durable-effect witness)', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'digest');
    const d0 = s.auditTrailDigest();
    s.assignOwnership({ sourceId: src, ownerPrincipalId: id(32), ...decision() });
    const d1 = s.auditTrailDigest();
    expect(d1).not.toBe(d0);
  });

  it('NEGATIVE CONTROL: two identical trails produce identical entry + trail digests', () => {
    const build = () => {
      const s = newStewardship(500);
      const src = discoverBare(s, 'same');
      s.assignOwnership({ sourceId: src, ownerPrincipalId: id(33), ...decision() });
      return s;
    };
    const a = build();
    const b = build();
    expect(a.auditTrailDigest()).toBe(b.auditTrailDigest());
    expect(stewardAuditEntryDigest(a.auditTrail()[0]!)).toBe(
      stewardAuditEntryDigest(b.auditTrail()[0]!),
    );
  });
});

// ===========================================================================
// COMMAND 1 — APPROVE ONBOARDING.
// ===========================================================================

describe('approveOnboarding advances the guarded lifecycle to onboarded', () => {
  it('drives discovered → pending → onboarded and records the approval', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'approve');
    const { entry } = s.approveOnboarding({ sourceId: src, ...decision() });
    expect(entry.onboardingState).toBe('onboarded');
    expect(s.auditTrailFor(src).some((e) => e.command === 'approve_onboarding')).toBe(true);
  });

  it('REJECTS approval of an unowned source (registry invariant — cannot onboard unowned)', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'unowned-approve');
    s.registrySurface().registerContract({ sourceId: src, version: 1, at: at(0) });
    expect(() => s.approveOnboarding({ sourceId: src, ...decision() })).toThrow(/unowned/);
  });

  it('NEGATIVE CONTROL: an owned + contracted source onboards without error', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'clean-approve');
    expect(() => s.approveOnboarding({ sourceId: src, ...decision() })).not.toThrow();
  });
});

// ===========================================================================
// COMMAND 2 — ASSIGN OWNERSHIP (closes the ownership gap).
// ===========================================================================

describe('assignOwnership names the accountable steward and closes the ownership gap', () => {
  it('sets the owner and clears the current-state ownership gap', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'assign');
    const rowBefore = s.currentStateView(at(0)).find((r) => r.sourceId === src)!;
    expect(rowBefore.ownershipGap).toBe(true);
    s.assignOwnership({ sourceId: src, ownerPrincipalId: id(40), ...decision() });
    const rowAfter = s.currentStateView(at(0)).find((r) => r.sourceId === src)!;
    expect(rowAfter.ownershipGap).toBe(false);
    expect(rowAfter.ownerPrincipalId).toBe(id(40));
  });

  it('NEGATIVE CONTROL: an already-owned source keeps a false ownership gap after reassignment', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'reassign');
    s.assignOwnership({ sourceId: src, ownerPrincipalId: id(41), ...decision() });
    s.assignOwnership({ sourceId: src, ownerPrincipalId: id(42), ...decision({ at: at(1) }) });
    const row = s.currentStateView(at(1)).find((r) => r.sourceId === src)!;
    expect(row.ownershipGap).toBe(false);
    expect(row.ownerPrincipalId).toBe(id(42));
  });
});

// ===========================================================================
// COMMAND 3 — DECLARE AUTHORITATIVE FIELDS (versioned contract).
// ===========================================================================

describe('declareAuthoritativeFields registers the versioned authoritative-field contract', () => {
  it('declares the authoritative fields and they are independently readable on the contract', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'declare');
    const { contract } = s.declareAuthoritativeFields({
      sourceId: src,
      version: 1,
      authoritativeFields: ['status', 'owner'],
      ...decision(),
    });
    expect([...contract.authoritativeFields].sort()).toEqual(['owner', 'status']);
    const latest = s.registrySurface().latestContract(src)!;
    expect([...latest.authoritativeFields].sort()).toEqual(['owner', 'status']);
  });

  it('REJECTS an empty authoritative-field list', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'declare-empty');
    expect(() =>
      s.declareAuthoritativeFields({
        sourceId: src,
        version: 1,
        authoritativeFields: [],
        ...decision(),
      }),
    ).toThrow(/non-empty list/);
  });

  it('NEGATIVE CONTROL: a non-empty field list is accepted and appended to contract history', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'declare-ok');
    s.declareAuthoritativeFields({
      sourceId: src,
      version: 1,
      authoritativeFields: ['a'],
      ...decision(),
    });
    s.declareAuthoritativeFields({
      sourceId: src,
      version: 2,
      authoritativeFields: ['a', 'b'],
      ...decision({ at: at(1) }),
    });
    expect(s.registrySurface().contracts(src)).toHaveLength(2);
  });
});

// ===========================================================================
// COMMAND 4 — REQUEST ACCESS (records intent, never fabricates connectivity).
// ===========================================================================

describe('requestAccess records the request without inferring connectivity or health', () => {
  it('does NOT mark the source connected and does NOT report healthy from a mere request', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'request', 'unreachable');
    const { entry } = s.requestAccess({ sourceId: src, ...decision() });
    expect(entry.accessState).not.toBe('connected');
    const row = s.currentStateView(at(0)).find((r) => r.sourceId === src)!;
    expect(row.reportedHealth).not.toBe('healthy');
    expect(s.auditTrailFor(src).some((e) => e.command === 'request_access')).toBe(true);
  });

  it('NEGATIVE CONTROL: a genuine connected+healthy observation DOES report healthy', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'genuine');
    s.approveOnboarding({ sourceId: src, ...decision() });
    s.registrySurface().recordObservation({
      sourceId: src,
      accessState: 'connected',
      healthState: 'healthy',
      at: at(0),
    });
    const row = s.currentStateView(at(0)).find((r) => r.sourceId === src)!;
    expect(row.reportedHealth).toBe('healthy');
  });
});

// ===========================================================================
// COMMANDS 5–7 — QUARANTINE / DEFER / EXCLUDE keep the source VISIBLE as a governed-source gap.
// ===========================================================================

describe('quarantine / defer / exclude keep the source VISIBLE as a governed-source gap (AC6)', () => {
  for (const cmd of ['quarantine', 'defer', 'exclude'] as const) {
    it(`${cmd} opens a visible governed_source gap with a review-or-expiry and records the command`, () => {
      const s = newStewardship();
      const src = discoverBare(s, `${cmd}-src`);
      const result = s[cmd]({ sourceId: src, ...decision() });
      // The gap is a VISIBLE governed-source gap carrying the review date, its business IMPACT,
      // and the required owner action — the full AC6 disposition, not a bare flag.
      expect(result.gap.gapClass).toBe('governed_source');
      expect(gapIsVisible(result.gap)).toBe(true);
      expect(gapHasReviewOrExpiry(result.gap)).toBe(true);
      expect(result.gap.reviewAt).toBe(REVIEW);
      expect(result.gap.subjectId).toBe(src);
      expect(GAP_IMPACTS).toContain(result.gap.impact);
      expect(result.gap.requiredAction.length).toBeGreaterThan(0);
      // The source is NOT deleted — it stays in the catalog and is queryable.
      expect(s.catalog().some((e) => e.id === src)).toBe(true);
      // The DISTINCT command survives in the audit trail even though all three share 'excluded'.
      expect(s.auditTrailFor(src).map((e) => e.command)).toContain(cmd);
      // The source never reports healthy after a lapse.
      const row = s.currentStateView(at(0)).find((r) => r.sourceId === src)!;
      expect(row.reportedHealth).not.toBe('healthy');
    });
  }

  // EXPLICIT per-command invocations (not the bracket-indexed loop above) so each of the three
  // governed disposition commands is exercised by NAME with its own dedicated assertions.
  it('s.quarantine opens a visible governed_source gap carrying the mandatory review date', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'quarantine-direct');
    const result = s.quarantine({ sourceId: src, ...decision() });
    expect(result.gap.gapClass).toBe('governed_source');
    expect(gapIsVisible(result.gap)).toBe(true);
    expect(result.gap.reviewAt).toBe(REVIEW);
    expect(s.auditTrailFor(src).map((e) => e.command)).toContain('quarantine');
  });

  it('s.defer opens a visible governed_source gap carrying the mandatory review date', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'defer-direct');
    const result = s.defer({ sourceId: src, ...decision() });
    expect(result.gap.gapClass).toBe('governed_source');
    expect(gapIsVisible(result.gap)).toBe(true);
    expect(result.gap.reviewAt).toBe(REVIEW);
    expect(s.auditTrailFor(src).map((e) => e.command)).toContain('defer');
  });

  it('s.exclude opens a visible governed_source gap carrying the mandatory review date', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'exclude-direct');
    const result = s.exclude({ sourceId: src, ...decision() });
    expect(result.gap.gapClass).toBe('governed_source');
    expect(gapIsVisible(result.gap)).toBe(true);
    expect(result.gap.reviewAt).toBe(REVIEW);
    expect(s.auditTrailFor(src).map((e) => e.command)).toContain('exclude');
  });

  it('an excluded/deferred/quarantined source is retained by assessCoverage as a visible gap', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'retained');
    s.quarantine({ sourceId: src, ...decision() });
    const gaps = s.assessCoverage({ at: at(1) });
    expect(gaps.some((g) => g.subjectId === src && g.gapClass === 'governed_source')).toBe(true);
  });

  it('NEGATIVE CONTROL: a clean onboarded+connected+healthy source has NO governed-source gap', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'clean');
    s.approveOnboarding({ sourceId: src, ...decision() });
    s.registrySurface().recordObservation({
      sourceId: src,
      accessState: 'connected',
      healthState: 'healthy',
      at: at(0),
    });
    const gaps = s.gapsForSource(src).filter((g) => gapIsVisible(g));
    expect(gaps).toHaveLength(0);
  });
});

// ===========================================================================
// AC1–AC5 pass-through: the stewardship service preserves the registry contract.
// ===========================================================================

describe('AC1–AC5 pass-through through the wrapped registry', () => {
  it('AC1: an approved+owned+observed source renders ONCE with the FULL officer facet set', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'ac1');
    const owner = id(11); // discoverOnboardable assigns id(11) as owner.
    s.approveOnboarding({ sourceId: src, ...decision() });
    s.registrySurface().recordObservation({
      sourceId: src,
      accessState: 'connected',
      healthState: 'healthy',
      at: at(0),
    });
    const rows = s.currentStateView(at(0)).filter((r) => r.sourceId === src);
    // Appears exactly ONCE (no duplicate rows): the single-appearance invariant asserts
    // rows.toHaveLength(1) — one, and only one, current-state row for this source.
    expect(rows).toHaveLength(1);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // TYPE / classification facet.
    expect(row.sourceClass).toBe('ac1');
    expect(row.classifiedUnknown).toBe(false);
    // SOURCE IDENTITY facet.
    expect(row.sourceId).toBe(src);
    // OWNER facet — the assigned owner is surfaced and no ownership gap is flagged.
    expect(row.ownerPrincipalId).toBe(owner);
    expect(row.ownershipGap).toBe(false);
    // LIFECYCLE (onboarding) facet.
    expect(row.onboardingState).toBe('onboarded');
    expect(row.accessState).toBe('connected');
    // RISK (sensitivity) facet is present and typed.
    expect(typeof row.sensitivity).toBe('string');
    expect(row.sensitivity.length).toBeGreaterThan(0);
    // CONTROL-COVERAGE facet — a clean source has coverage and no unresolved issues.
    expect(row.hasControlCoverage).toBe(true);
    expect(row.unresolvedIssueCount).toBe(0);
    // EVIDENCE-STATE facet.
    expect(row.evidenceState).toBe('current');
    // HEALTH facet — fresh knowledge, so the reported (rely-on) health is the observed 'healthy'.
    expect(row.observedHealth).toBe('healthy');
    expect(row.reportedHealth).toBe('healthy');
    // LAST-OBSERVATION-TIME facet — the officer sees when this was last known, and it is fresh.
    expect(row.lastKnownAt).toBe(at(0));
    expect(row.staleness).toBe('fresh');
    expect(row.confidence).toBe(1);
  });

  it('AC2: an unmanaged source is a VISIBLE component gap with reason + age + impact + owner action', () => {
    const s = newStewardship();
    const src = discoverBare(s, 'ac2');
    const gaps = s.reconcile({ at: at(0) });
    const gap = gaps.find((g) => g.subjectId === src && g.reason === 'unmanaged');
    expect(gap).toBeDefined();
    // REASON facet.
    expect(gap!.reason).toBe('unmanaged');
    // VISIBLE — it stays on the gap surface, never silently healthy.
    expect(gapIsVisible(gap!)).toBe(true);
    // IMPACT facet is present and a valid impact grade.
    expect(GAP_IMPACTS).toContain(gap!.impact);
    // OWNER ACTION facet — a concrete required action is named.
    expect(gap!.requiredAction.length).toBeGreaterThan(0);
    // AGE facet — derivable from firstSeenAt; grows as time advances past discovery.
    expect(gapAgeMillis(gap!, at(0))).toBe(0);
    expect(gapAgeMillis(gap!, at(5))).toBe(5);
  });

  it('AC3: drill-down shows DISTINCT records, correlation, STATUS DIFFERENCES, DEPENDENCIES, and authoritative fields', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'ac3');
    const dep = discoverBare(s, 'ac3-dependency'); // a second catalog source this one depends on.
    const reg = s.registrySurface();
    // Declare the AUTHORITATIVE FIELDS this source is the system of record for (contract lineage).
    // discoverOnboardable already registered contract v1; declare authoritative fields as v2.
    s.declareAuthoritativeFields({
      sourceId: src,
      version: 2,
      authoritativeFields: ['status'],
      ...decision(),
    });
    // Two DISTINCT raw records correlated to the same catalog source (different external keys) that
    // DISAGREE on `status` (Kanban says active, agentctl says conflicting) and on an observed field.
    reg.attachRecord(
      makeSourceRecord({
        id: id(70),
        tenantId: PLATFORM_SCOPE,
        catalogId: src,
        sourceClass: 'ac3',
        externalKey: 'ac3/kanban',
        observedState: { phase: 'in_progress' },
        status: 'active',
        freshness: 'fresh',
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    reg.attachRecord(
      makeSourceRecord({
        id: id(71),
        tenantId: PLATFORM_SCOPE,
        catalogId: src,
        sourceClass: 'ac3',
        externalKey: 'ac3/agentctl',
        observedState: { phase: 'blocked' },
        status: 'conflicting',
        freshness: 'fresh',
        lastKnownAt: at(0),
        observedAt: at(0),
      }),
    );
    // Assert a DEPENDENCY edge from this source onto the second source.
    const edge = s.attachRelationship({
      sourceId: src,
      toId: dep,
      relationship: 'depends_on',
      at: at(0),
    });

    const view = reg.drillDown(src);
    // The drill-down correlates the two distinct records under ONE catalog entry.
    expect(view.entry.id).toBe(src);
    expect(view.records).toHaveLength(2);
    expect(new Set(view.records.map((r) => r.externalKey))).toEqual(
      new Set(['ac3/kanban', 'ac3/agentctl']),
    );
    // Every drilled record is attributed back to the SAME source (correlation, not merge).
    expect(view.records.every((r) => r.catalogId === src)).toBe(true);

    // STATUS DIFFERENCES — the records DISAGREE, and the drill-down surfaces the disagreement
    // (field + distinct values + which records hold them) rather than silently collapsing it.
    const statusDiff = view.statusDifferences.find((d) => d.field === 'status')!;
    expect(statusDiff).toBeDefined();
    expect(new Set(statusDiff.values.map((v) => v.value))).toEqual(
      new Set(['active', 'conflicting']),
    );
    // Each distinct value is attributed to the record that reported it.
    const activeVal = statusDiff.values.find((v) => v.value === 'active')!;
    expect(activeVal.recordIds).toEqual([id(70)]);
    const conflictingVal = statusDiff.values.find((v) => v.value === 'conflicting')!;
    expect(conflictingVal.recordIds).toEqual([id(71)]);
    // The observed-field disagreement (phase) is surfaced too.
    expect(view.statusDifferences.some((d) => d.field === 'observedState.phase')).toBe(true);
    // Fields the records AGREE on (sourceClass is identical) are NOT reported as differences.
    expect(view.statusDifferences.some((d) => d.field === 'sourceClass')).toBe(false);
    // The same disagreements are readable via the dedicated pass-through.
    expect(s.statusDifferencesFor(src)).toEqual(view.statusDifferences);

    // DEPENDENCIES — the drill-down names the source this one depends on.
    expect(view.dependencies).toHaveLength(1);
    expect(view.dependencies[0]!.relationship).toBe('depends_on');
    expect(view.dependencies[0]!.fromId).toBe(src);
    expect(view.dependencies[0]!.toId).toBe(dep);
    expect(view.dependencies[0]!.id).toBe(edge.id);
    expect(s.dependenciesFor(src)).toEqual(view.dependencies);

    // AUTHORITATIVE FIELDS — the source's system-of-record fields live on the drilled contract.
    expect(view.contracts.length).toBeGreaterThan(0);
    const latest = view.contracts[view.contracts.length - 1]!;
    expect([...latest.authoritativeFields]).toContain('status');
  });

  it('AC4: a stale source carries confidence < 1, last-known time, and NON-inferred health', () => {
    const s = newStewardship();
    const src = discoverOnboardable(s, 'ac4');
    s.approveOnboarding({ sourceId: src, ...decision() });
    s.registrySurface().recordObservation({
      sourceId: src,
      accessState: 'connected',
      healthState: 'healthy',
      at: at(0),
    });
    const staleAt = at(HORIZON + 1);
    const row = s.currentStateView(staleAt).find((r) => r.sourceId === src)!;
    expect(row.staleness).not.toBe('fresh');
    expect(row.confidence).toBeLessThan(1);
    // LAST-KNOWN time is pinned to the last observation, NOT advanced to the (stale) query time.
    expect(row.lastKnownAt).toBe(at(0));
    // Health is NOT inferred from stale knowledge: even though the last observation was 'healthy',
    // the rely-on health is downgraded to 'unknown'.
    expect(row.observedHealth).toBe('healthy');
    expect(row.reportedHealth).toBe('unknown');
  });

  it('AC5: an unregistered source is ADDED to the catalog with the FULL discovery facet set', () => {
    const s = newStewardship();
    // A source discovered WITH a known type/sensitivity/access, but no owner (ownership gap).
    const classified = s.discover({
      externalKey: 'ac5-typed',
      sourceClass: 'kanban',
      location: 'svc://ac5-typed',
      accessState: 'connected',
      sensitivity: 'restricted',
      discoveryEvidence: id(60),
      at: at(0),
    });
    // ONBOARDING STATE facet — a freshly discovered source is in the 'discovered' state.
    expect(classified.onboardingState).toBe('discovered');
    // DISCOVERY EVIDENCE facet — the evidence that surfaced it is retained.
    expect(classified.discoveryEvidence).toBe(id(60));
    // TYPE / classification facet — the declared type is kept (and it is NOT the unknown class).
    expect(classified.sourceClass).toBe('kanban');
    // LOCATION facet — the observed location is recorded.
    expect(classified.observedLocations).toContain('svc://ac5-typed');
    // ACCESS-STATUS facet.
    expect(classified.accessState).toBe('connected');
    // SENSITIVITY facet.
    expect(classified.sensitivity).toBe('restricted');
    // OWNERSHIP-STATUS facet — no owner given, so the entry carries an ownership gap.
    expect(classified.ownerPrincipalId).toBeUndefined();
    // It is genuinely in the catalog (added, not merely returned).
    expect(s.catalog().some((e) => e.id === classified.id)).toBe(true);
    // The current-state view exposes the same facets, including the ownership-status flag and the
    // 'unknown' classification bit resolved to false for a typed source.
    const row = s.currentStateView(at(0)).find((r) => r.sourceId === classified.id)!;
    expect(row.classifiedUnknown).toBe(false);
    expect(row.ownershipGap).toBe(true);
    expect(row.accessState).toBe('connected');
    expect(row.sensitivity).toBe('restricted');
    expect(row.onboardingState).toBe('discovered');

    // A source discovered WITHOUT a type is classified as the explicit UNKNOWN class (type-or-unknown).
    const untyped = s.discover({
      externalKey: 'ac5-untyped',
      location: 'svc://ac5-untyped',
      discoveryEvidence: id(61),
      at: at(0),
    });
    const untypedRow = s.currentStateView(at(0)).find((r) => r.sourceId === untyped.id)!;
    // TYPE-OR-UNKNOWN facet — an unclassified source is flagged, never silently dropped.
    expect(untypedRow.classifiedUnknown).toBe(true);
    expect(untypedRow.onboardingState).toBe('discovered');
  });
});
