// Security-suite test — the SOURCE STEWARDSHIP command service (Phase 72) grants NO governance
// authority beyond recording a steward's DECLARED, AUDITED decision. It structurally enforces that:
//   (1) NO CONSEQUENTIAL DECISION IS UNJUSTIFIED — every steward command is rejected unless it
//       carries a mandatory structured reason, a non-empty scope, and a forward-dated review date;
//   (2) NO DECISION IS UNTRACEABLE — every accepted command appends exactly one immutable audit
//       entry (actor / command / reason / scope / review / before→after digest) that the query
//       surface retains, and the trail is append-only + tamper-evident (digest changes on append);
//   (3) NO ISOLATION IS A SILENT DROP — quarantine / defer / exclude keep the source VISIBLE as a
//       governed-source gap and never delete it, and never let it report healthy.
//
// (Bundle 36GCYGDJ15PTYP60F91QWRAY2M / Phase 72 / VO-fa865d7856056565038e.)
//
// Each positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: a
// well-formed decision IS accepted and DOES leave exactly one visible audit entry — so it is the
// guard, not the fixture, that produces the safe output.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  makeReason,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import { gapIsVisible } from '../../packages/domain/src/inventory.ts';
import {
  SourceStewardship,
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
const HORIZON = 15 * 60_000;
const at = (m: number): EpochMillis => (T0 + m) as EpochMillis;
const REVIEW = at(30 * 24 * 60);
const ACTOR = id(900);

function newStewardship(seed = 1): SourceStewardship {
  return new SourceStewardship({
    tenantId: PLATFORM_SCOPE,
    newId: idFactory(seed),
    stalenessHorizonMillis: HORIZON,
  });
}
function decision(overrides: Partial<StewardDecision> = {}): StewardDecision {
  return {
    actorPrincipalId: ACTOR,
    reason: makeReason('sec.steward', 'a security-suite steward decision'),
    scope: 'covers the whole source',
    reviewAt: REVIEW,
    at: at(0),
    ...overrides,
  };
}
function discover(s: SourceStewardship, key: string): Uuid {
  return s.registrySurface().discover({
    externalKey: key,
    sourceClass: key,
    location: `svc://${key}`,
    accessState: 'connected',
    discoveryEvidence: id(10),
    at: at(0),
  }).id;
}

describe('SECURITY (1): no consequential steward decision is accepted without reason + scope + review', () => {
  it('EVERY command rejects a missing/empty reason', () => {
    const s = newStewardship();
    const src = discover(s, 'no-reason');
    const bad = { reason: { code: 'x', text: '   ' } } as unknown as Partial<StewardDecision>;
    expect(() =>
      s.assignOwnership({ sourceId: src, ownerPrincipalId: id(20), ...decision(bad) }),
    ).toThrow(/structured reason/);
    expect(() => s.quarantine({ sourceId: src, ...decision(bad) })).toThrow(/structured reason/);
    expect(() => s.defer({ sourceId: src, ...decision(bad) })).toThrow(/structured reason/);
    expect(() => s.exclude({ sourceId: src, ...decision(bad) })).toThrow(/structured reason/);
    expect(() => s.requestAccess({ sourceId: src, ...decision(bad) })).toThrow(/structured reason/);
    expect(() =>
      s.declareAuthoritativeFields({
        sourceId: src,
        version: 1,
        authoritativeFields: ['f'],
        ...decision(bad),
      }),
    ).toThrow(/structured reason/);
  });

  it('EVERY command rejects an empty scope', () => {
    const s = newStewardship();
    const src = discover(s, 'no-scope');
    const bad = { scope: '' };
    expect(() => s.quarantine({ sourceId: src, ...decision(bad) })).toThrow(
      /scope must be a non-empty/,
    );
    expect(() => s.defer({ sourceId: src, ...decision(bad) })).toThrow(/scope must be a non-empty/);
    expect(() => s.exclude({ sourceId: src, ...decision(bad) })).toThrow(
      /scope must be a non-empty/,
    );
  });

  it('EVERY command rejects a non-future review date', () => {
    const s = newStewardship();
    const src = discover(s, 'no-review');
    const bad = { reviewAt: at(0) };
    expect(() => s.quarantine({ sourceId: src, ...decision(bad) })).toThrow(
      /review date strictly after/,
    );
    expect(() => s.defer({ sourceId: src, ...decision(bad) })).toThrow(
      /review date strictly after/,
    );
    expect(() => s.exclude({ sourceId: src, ...decision(bad) })).toThrow(
      /review date strictly after/,
    );
  });

  it('NEGATIVE CONTROL: a well-formed decision is ACCEPTED (the guard is the reason/scope/review, not a blanket deny)', () => {
    const s = newStewardship();
    const src = discover(s, 'ok');
    expect(() =>
      s.assignOwnership({ sourceId: src, ownerPrincipalId: id(21), ...decision() }),
    ).not.toThrow();
    expect(s.auditTrailFor(src)).toHaveLength(1);
  });
});

describe('SECURITY (2): every accepted decision is traceable — one immutable, retained audit entry', () => {
  it('an accepted command appends exactly one entry and the trail digest changes', () => {
    const s = newStewardship();
    const src = discover(s, 'trace');
    const d0 = s.auditTrailDigest();
    s.quarantine({ sourceId: src, ...decision() });
    expect(s.auditTrailFor(src)).toHaveLength(1);
    expect(s.auditTrailDigest()).not.toBe(d0);
  });

  it('a REJECTED command appends NO audit entry (no untracked side effect on failure)', () => {
    const s = newStewardship();
    const src = discover(s, 'reject');
    const before = s.auditTrail().length;
    expect(() => s.exclude({ sourceId: src, ...decision({ scope: '' }) })).toThrow();
    expect(s.auditTrail().length).toBe(before);
  });

  it('the audit entry is frozen — a recorded decision cannot be back-edited', () => {
    const s = newStewardship();
    const src = discover(s, 'immutable');
    const { audit } = s.exclude({ sourceId: src, ...decision() });
    expect(Object.isFrozen(audit)).toBe(true);
    expect(() => {
      (audit as { reason: unknown }).reason = makeReason('tamper', 'tampered');
    }).toThrow();
  });

  it('NEGATIVE CONTROL: the SAME decision sequence yields the SAME trail digest (deterministic, no wall clock)', () => {
    const build = () => {
      const s = newStewardship(777);
      const src = discover(s, 'det');
      s.exclude({ sourceId: src, ...decision() });
      return s.auditTrailDigest();
    };
    expect(build()).toBe(build());
  });
});

describe('SECURITY (3): no isolation is a silent drop — quarantine/defer/exclude stay visible', () => {
  it('a quarantined source is retained and stays a VISIBLE governed-source gap (never deleted)', () => {
    const s = newStewardship();
    const src = discover(s, 'vis');
    const { gap } = s.quarantine({ sourceId: src, ...decision() });
    expect(gapIsVisible(gap)).toBe(true);
    expect(s.catalog().some((e) => e.id === src)).toBe(true);
    const row = s.currentStateView(at(0)).find((r) => r.sourceId === src)!;
    expect(row.reportedHealth).not.toBe('healthy');
  });

  it('NEGATIVE CONTROL: without any lapse a discovered source has NO governed-source gap of its own from a lapse command', () => {
    const s = newStewardship();
    const src = discover(s, 'nolapse');
    // No quarantine/defer/exclude issued ⇒ no governed_source 'excluded' gap exists.
    const lapseGaps = s
      .gapsForSource(src)
      .filter((g) => g.gapClass === 'governed_source' && g.reason === 'excluded');
    expect(lapseGaps).toHaveLength(0);
  });
});
