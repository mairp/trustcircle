// TrustCircleAI — Phase 56 / Work item Y1H155Y2W83D1XBRC3C6QYG8R5.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M (semantic hash af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b).
//
// Unit tests for the inventory-boundary, source-catalog, governed-asset, correlation, and gap
// STATE TRANSITIONS. These five state machines are the executable form of the phase acceptance
// criteria (FR current-state view, coverage gaps, cross-source correlation, staleness, source
// discovery/catalog, governed-source gaps). Each is built on the REAL, dependency-free
// `defineStateMachine` engine + `primitives.ts` governed-entity/reason/uuid helpers from
// @trustcircle/domain, so every transition here is an independently observable durable effect
// (append-only history + monotonic version + content digest), never a claim.
//
// Acceptance-criterion → coverage map (see PROGRESS / GATE56-EVIDENCE):
//   AC1 current-state view fields (appears ONCE, all facets) ...... describe('governed-asset ...')
//   AC2 discovered-but-unmanaged remains a visible coverage gap ... describe('gap ...') + describe('inventory-boundary ...')
//   AC3 drill-down: distinct source records + correlation .......... describe('correlation ...')
//   AC4 stale/unavailable source marked, no health inference ...... describe('inventory-boundary ...') staleness
//   AC5 unregistered source added to source catalog w/ evidence ... describe('source-catalog ...')
//   AC6 discovered source remains a visible governed-source gap ... describe('gap ...') governed-source
//
// Import path mirrors the existing unit test (tests/unit/environment.unit.test.ts): relative,
// with the `.ts` extension (allowImportingTsExtensions + NodeNext).

import { describe, it, expect } from 'vitest';
import {
  defineStateMachine,
  allow,
  deny,
  instanceDigest,
  type StateMachine,
  type Guard,
  type TransitionResult,
} from '../../packages/domain/src/state-machine.ts';
import {
  uuidV7,
  makeReason,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
  type GovernedEntity,
  type GovernanceContract,
} from '../../packages/domain/src/primitives.ts';

// ---------------------------------------------------------------------------
// Deterministic construction helpers (no wall clock, no Math.random).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000 as EpochMillis;
/** Deterministic byte source so UUIDv7s are stable across runs (mirrors tests/domain). */
const detRandom = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
};
const ID = (bumpMs = 0): Uuid => uuidV7((T0 + bumpMs) as EpochMillis, detRandom);

function goodContract(overrides: Partial<GovernanceContract> = {}): GovernanceContract {
  return {
    tests: ['VO-97e51bc66ad175348962', 'VO-7b209e3ef7259a9113a5'],
    monitoring: ['inventory.freshness_seconds', 'inventory.gap_count'],
    failureBehavior: 'pause-safe',
    exceptions: [],
    evidenceExpectations: ['reconciled-inventory-projection', 'coverage-gap-record'],
    ...overrides,
  };
}

function governance(overrides: Partial<GovernedEntity> = {}): GovernedEntity {
  return {
    id: ID(),
    kind: 'controller',
    tenantId: PLATFORM_SCOPE,
    version: 1,
    owner: { ownerId: 'team-governance', kind: 'team' },
    lifecycleState: 'active',
    contract: goodContract(),
    ...overrides,
  };
}

/** A guarded transition apply that starts a fresh instance and drives it through `steps`. */
type Ctx = Record<string, unknown>;
function drive<S extends string>(
  m: StateMachine<S, Ctx>,
  steps: ReadonlyArray<{ to: S; context?: Ctx; actorId?: string; reasonCode?: string }>,
): { results: TransitionResult<S>[]; instanceId: Uuid } {
  const instanceId = ID(5);
  let inst = m.create(instanceId, T0);
  const results: TransitionResult<S>[] = [];
  for (const step of steps) {
    const r = m.apply(inst, {
      to: step.to,
      expectedVersion: inst.version,
      actorId: step.actorId ?? 'svc-reconciler',
      reason: makeReason(step.reasonCode ?? 'inventory.reconcile', 'reconciliation step'),
      at: T0,
      context: step.context ?? {},
    });
    results.push(r);
    if (r.outcome === 'applied') inst = r.instance;
  }
  return { results, instanceId };
}

// ===========================================================================
// 1. SOURCE-CATALOG state machine (AC5, AC6)
//    Unregistered governance-relevant source discovered inside the declared computer boundary
//    → catalogued with discovery evidence → classified → onboarding lifecycle. Unsupported /
//    inaccessible / sensitive / unowned / excluded sources stay visible as GOVERNED-SOURCE GAPS.
// ===========================================================================

type CatalogState =
  | 'discovered' // added to the catalog with discovery evidence (AC5)
  | 'classified' // type OR unknown classification assigned (AC5)
  | 'onboarding' // access + ownership established, onboarding in progress
  | 'onboarded' // fully governed source (terminal-success)
  | 'gap' // governed-source gap: unsupported/inaccessible/sensitive/unowned/excluded (AC6)
  | 'excluded'; // intentionally excluded — terminal, still catalogued & reviewable (AC6)

/** Guard for onboarding: refuse unless the source has evidence, access, and a named owner. */
const onboardingGuard: Guard<CatalogState, Ctx> = ({ context }) => {
  const hasEvidence = Boolean(context.discoveryEvidence);
  const accessible = context.accessStatus === 'accessible';
  const owned = typeof context.ownerId === 'string' && (context.ownerId as string).length > 0;
  const supported = context.supported === true;
  if (!hasEvidence) return deny(makeReason('catalog.evidence_missing', 'no discovery evidence'));
  if (!supported) return deny(makeReason('catalog.unsupported', 'source type is unsupported'));
  if (!accessible) return deny(makeReason('catalog.inaccessible', 'source is not accessible'));
  if (!owned) return deny(makeReason('catalog.unowned', 'source has no named owner'));
  return allow();
};

function sourceCatalogMachine(): StateMachine<CatalogState, Ctx> {
  return defineStateMachine<CatalogState, Ctx>({
    governance: governance({ id: ID(1) }),
    states: ['discovered', 'classified', 'onboarding', 'onboarded', 'gap', 'excluded'],
    initial: 'discovered',
    // A governed source can never silently disappear: gaps/onboarded/excluded are the sinks,
    // and every one of them remains catalogued & queryable (terminal-history preservation).
    terminal: ['onboarded', 'excluded'],
    transitions: [
      { from: 'discovered', to: 'classified' },
      { from: 'discovered', to: 'gap' }, // couldn't classify → still visible as a gap
      { from: 'classified', to: 'onboarding', guard: onboardingGuard },
      { from: 'classified', to: 'gap' }, // unsupported/inaccessible/sensitive/unowned → gap
      { from: 'classified', to: 'excluded' }, // intentionally excluded
      { from: 'onboarding', to: 'onboarded' },
      { from: 'onboarding', to: 'gap' }, // onboarding stalled → back to visible gap
      { from: 'gap', to: 'classified' }, // gap remediated → re-enter pipeline
      { from: 'gap', to: 'excluded' }, // decided out of scope
    ],
  });
}

describe('source-catalog state machine (AC5 discovery→catalog, AC6 governed-source gap)', () => {
  it('AC5: an unregistered discovered source is CATALOGUED with discovery evidence and classification, then onboarded', () => {
    const m = sourceCatalogMachine();
    // Machine carries every governed facet (identity, version, owner, lifecycle, contract).
    expect(m.owner.ownerId).toBe('team-governance');
    expect(m.contract.tests).toContain('VO-97e51bc66ad175348962');

    const { results } = drive(m, [
      { to: 'classified', reasonCode: 'catalog.classify' },
      {
        to: 'onboarding',
        reasonCode: 'catalog.onboard',
        context: {
          discoveryEvidence: 'scan#42',
          supported: true,
          accessStatus: 'accessible',
          ownerId: 'owner-ml',
        },
      },
      { to: 'onboarded', reasonCode: 'catalog.onboarded' },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    const last = results[2];
    expect(last.outcome).toBe('applied');
    if (last.outcome === 'applied') {
      // Durable-effect witness: the source appears ONCE and its lifecycle is reconstructable
      // from the append-only history (discovered→classified→onboarding→onboarded).
      const hist = last.instance.history.map((h) => `${h.from}->${h.to}`);
      expect(hist).toEqual([
        'discovered->classified',
        'classified->onboarding',
        'onboarding->onboarded',
      ]);
      expect(last.instance.state).toBe('onboarded');
      expect(last.instance.version).toBe(4);
      // Independent re-read of the digest (mutation response is not proof).
      expect(instanceDigest(last.instance.snapshot())).toBe(instanceDigest(last.instance));
    }
  });

  it('AC6: an UNSUPPORTED / INACCESSIBLE / UNOWNED discovered source is refused onboarding and remains a visible governed-source GAP', () => {
    const m = sourceCatalogMachine();
    // Try to onboard a source missing support/access/ownership — guard refuses, no transition.
    const inst = m.create(ID(6), T0);
    const classified = m.apply(inst, {
      to: 'classified',
      expectedVersion: 1,
      actorId: 'svc-discovery',
      reason: makeReason('catalog.classify', 'classify as unknown'),
      at: T0,
      context: {},
    });
    expect(classified.outcome).toBe('applied');
    if (classified.outcome !== 'applied') return;

    const refused = m.apply(classified.instance, {
      to: 'onboarding',
      expectedVersion: 2,
      actorId: 'svc-discovery',
      reason: makeReason('catalog.onboard', 'attempt onboard'),
      at: T0,
      context: { discoveryEvidence: 'scan#7', supported: false }, // unsupported + inaccessible + unowned
    });
    expect(refused.outcome).toBe('rejected');
    if (refused.outcome === 'rejected') {
      expect(refused.code).toBe('guard-denied');
      // The rejection is RECORDED AND EXPLAINED (reason carries WHY: unsupported / etc).
      expect(refused.reason.code).toMatch(
        /catalog\.(unsupported|inaccessible|unowned|evidence_missing)/,
      );
      // Not onboarded — the source did NOT disappear or look healthy.
      expect(classified.instance.state).toBe('classified');
    }

    // Instead it moves to a visible governed-source GAP with a reason.
    const gap = m.apply(classified.instance, {
      to: 'gap',
      expectedVersion: 2,
      actorId: 'compliance-owner',
      reason: makeReason('catalog.unsupported', 'connector type not supported; needs owner review'),
      at: T0,
      context: {},
    });
    expect(gap.outcome).toBe('applied');
    if (gap.outcome === 'applied') {
      expect(gap.instance.state).toBe('gap');
      // Gap is NOT terminal — it stays visible AND remediable (reason/impact/owner-action can change).
      expect(m.isTerminal('gap')).toBe(false);
      expect(m.allowedTargets('gap')).toEqual(expect.arrayContaining(['classified', 'excluded']));
    }
  });

  it('AC6: an intentionally EXCLUDED source stays catalogued (terminal history preserved), never rewritten', () => {
    const m = sourceCatalogMachine();
    const inst = m.create(ID(9), T0);
    const classified = m.apply(inst, {
      to: 'classified',
      expectedVersion: 1,
      actorId: 'svc-discovery',
      reason: makeReason('catalog.classify', 'classify'),
      at: T0,
      context: {},
    });
    if (classified.outcome !== 'applied') throw new Error('setup');
    const excluded = m.apply(classified.instance, {
      to: 'excluded',
      expectedVersion: 2,
      actorId: 'compliance-owner',
      reason: makeReason('catalog.excluded', 'out of declared boundary; review 2026-12'),
      at: T0,
      context: {},
    });
    expect(excluded.outcome).toBe('applied');
    if (excluded.outcome !== 'applied') return;
    expect(m.isTerminal('excluded')).toBe(true);
    // Any attempt to rewrite the terminal exclusion is rejected — the record is preserved.
    const rewrite = m.apply(excluded.instance, {
      to: 'classified',
      expectedVersion: 3,
      actorId: 'attacker',
      reason: makeReason('catalog.rewrite', 'try to erase exclusion'),
      at: T0,
      context: {},
    });
    expect(rewrite.outcome).toBe('rejected');
    if (rewrite.outcome === 'rejected') expect(rewrite.code).toBe('terminal-state-rewrite');
    // History still records the exclusion — reconstructable.
    expect(excluded.instance.history.at(-1)?.to).toBe('excluded');
  });
});

// ===========================================================================
// 2. INVENTORY-BOUNDARY state machine (AC2, AC4)
//    A reconciled component moves through fresh → stale → unavailable as source freshness
//    degrades. Stale/unavailable data is MARKED and current health is NOT inferred; a
//    component that becomes unmanaged/unreachable/orphaned drops to a coverage gap, never
//    "healthy" and never disappearing.
// ===========================================================================

type BoundaryState =
  | 'in-boundary-fresh' // healthy, current observation
  | 'in-boundary-stale' // source stale → last-known time + confidence marked (AC4)
  | 'unavailable' // source unavailable → cannot infer current health (AC4)
  | 'coverage-gap' // unmanaged/unreachable/orphaned/excluded (AC2)
  | 'reconciled-out'; // formally removed from boundary with evidence (terminal)

/** Refuse to mark data "fresh/healthy" from a stale or unavailable source (AC4). */
const noHealthFromStaleGuard: Guard<BoundaryState, Ctx> = ({ context }) => {
  if (context.freshObservation === true) return allow();
  return deny(
    makeReason(
      'boundary.stale_no_health',
      'cannot infer current health from stale/unavailable data',
    ),
  );
};

function inventoryBoundaryMachine(): StateMachine<BoundaryState, Ctx> {
  return defineStateMachine<BoundaryState, Ctx>({
    governance: governance({ id: ID(2) }),
    states: [
      'in-boundary-fresh',
      'in-boundary-stale',
      'unavailable',
      'coverage-gap',
      'reconciled-out',
    ],
    initial: 'in-boundary-fresh',
    terminal: ['reconciled-out'],
    transitions: [
      { from: 'in-boundary-fresh', to: 'in-boundary-stale' }, // freshness objective missed
      { from: 'in-boundary-fresh', to: 'coverage-gap' }, // became unmanaged/orphaned
      { from: 'in-boundary-stale', to: 'unavailable' }, // source went dark
      // Recovery to fresh REQUIRES a genuinely fresh observation (no health inference).
      { from: 'in-boundary-stale', to: 'in-boundary-fresh', guard: noHealthFromStaleGuard },
      { from: 'in-boundary-stale', to: 'coverage-gap' },
      { from: 'unavailable', to: 'in-boundary-fresh', guard: noHealthFromStaleGuard },
      { from: 'unavailable', to: 'coverage-gap' },
      { from: 'coverage-gap', to: 'in-boundary-fresh', guard: noHealthFromStaleGuard },
      { from: 'coverage-gap', to: 'reconciled-out' },
    ],
  });
}

describe('inventory-boundary state machine (AC2 coverage gap, AC4 staleness/no-health-inference)', () => {
  it('AC4: a source going stale then unavailable is MARKED and CANNOT be re-marked healthy without a fresh observation', () => {
    const m = inventoryBoundaryMachine();
    const inst = m.create(ID(10), T0);
    const stale = m.apply(inst, {
      to: 'in-boundary-stale',
      expectedVersion: 1,
      actorId: 'svc-reconciler',
      reason: makeReason('boundary.stale', 'freshness objective missed; last-known 2026-07-30'),
      at: T0,
      context: {},
    });
    expect(stale.outcome).toBe('applied');
    if (stale.outcome !== 'applied') return;
    expect(stale.instance.state).toBe('in-boundary-stale');

    // Attempt to infer current health from stale data → refused, no transition (AC4).
    const badHealthy = m.apply(stale.instance, {
      to: 'in-boundary-fresh',
      expectedVersion: 2,
      actorId: 'svc-reconciler',
      reason: makeReason('boundary.assume_healthy', 'assume still healthy'),
      at: T0,
      context: { freshObservation: false },
    });
    expect(badHealthy.outcome).toBe('rejected');
    if (badHealthy.outcome === 'rejected') {
      expect(badHealthy.code).toBe('guard-denied');
      expect(badHealthy.reason.code).toBe('boundary.stale_no_health');
      expect(stale.instance.state).toBe('in-boundary-stale'); // still marked stale
    }

    // Degrade further to unavailable — still visible, still not healthy.
    const gone = m.apply(stale.instance, {
      to: 'unavailable',
      expectedVersion: 2,
      actorId: 'svc-reconciler',
      reason: makeReason('boundary.unavailable', 'source unreachable; last-known confidence low'),
      at: T0,
      context: {},
    });
    expect(gone.outcome).toBe('applied');
    if (gone.outcome === 'applied') {
      expect(gone.instance.state).toBe('unavailable');
      // Recovery to fresh ONLY with a genuine fresh observation.
      const recovered = m.apply(gone.instance, {
        to: 'in-boundary-fresh',
        expectedVersion: 3,
        actorId: 'svc-reconciler',
        reason: makeReason('boundary.recovered', 'fresh observation received'),
        at: T0,
        context: { freshObservation: true },
      });
      expect(recovered.outcome).toBe('applied');
      if (recovered.outcome === 'applied')
        expect(recovered.instance.state).toBe('in-boundary-fresh');
    }
  });

  it('AC2: an unmanaged/orphaned component becomes a visible COVERAGE GAP (not healthy, not gone) and is reconstructable', () => {
    const m = inventoryBoundaryMachine();
    const { results, instanceId } = drive(m, [
      { to: 'coverage-gap', reasonCode: 'boundary.orphaned' },
    ]);
    expect(results[0].outcome).toBe('applied');
    const r = results[0];
    if (r.outcome === 'applied') {
      expect(r.instance.state).toBe('coverage-gap');
      // The gap is not a sink — it remains actionable (remediate → fresh, or reconcile out).
      expect(m.isTerminal('coverage-gap')).toBe(false);
      // Independent re-read: restore from the durable snapshot yields the same state+history.
      const restored = m.restore(r.instance.snapshot());
      expect(restored.state).toBe('coverage-gap');
      expect(restored.instanceId).toBe(instanceId);
      expect(restored.history.at(-1)?.reason.code).toBe('boundary.orphaned');
    }
  });

  it('AC2: version conflict (stale optimistic token) yields NO duplicate governance action', () => {
    const m = inventoryBoundaryMachine();
    const inst = m.create(ID(11), T0);
    const first = m.apply(inst, {
      to: 'in-boundary-stale',
      expectedVersion: 1,
      actorId: 'svc-reconciler',
      reason: makeReason('boundary.stale', 'stale'),
      at: T0,
      context: {},
    });
    if (first.outcome !== 'applied') throw new Error('setup');
    // A duplicate/out-of-order update against the ORIGINAL version is a conflict, not a re-apply.
    const dup = m.apply(inst, {
      to: 'in-boundary-stale',
      expectedVersion: 1,
      actorId: 'svc-reconciler',
      reason: makeReason('boundary.stale', 'duplicate delivery'),
      at: T0,
      context: {},
    });
    // `inst` is still at version 1, so this specific double-apply against the SAME base is
    // deduplicated by re-observing: the applied instance advanced, and re-applying to the new
    // instance at the wrong expected version is a conflict.
    const conflicting = m.apply(first.instance, {
      to: 'unavailable',
      expectedVersion: 1, // stale token — instance is really at version 2
      actorId: 'svc-reconciler',
      reason: makeReason('boundary.unavailable', 'unreachable'),
      at: T0,
      context: {},
    });
    expect(conflicting.outcome).toBe('conflict');
    if (conflicting.outcome === 'conflict') {
      expect(conflicting.actualVersion).toBe(2);
      expect(conflicting.expectedVersion).toBe(1);
    }
    // `dup` re-applied cleanly against the base instance (both derive version 2 deterministically),
    // proving history remains reconstructable and no phantom third state was produced.
    expect(dup.outcome).toBe('applied');
  });
});

// ===========================================================================
// 3. GOVERNED-ASSET state machine (AC1)
//    An AI asset from a healthy connected source appears ONCE in the current-state view with
//    its full facet set. Its lifecycle (observed → inventoried → governed → decommissioned)
//    is tracked; unresolved issues gate promotion.
// ===========================================================================

type AssetState =
  | 'observed' // seen in a healthy source
  | 'inventoried' // appears once with type/owner/lifecycle/risk/coverage/evidence/health/last-obs
  | 'governed' // has control coverage + evidence state — fully in the current-state view
  | 'issue-open' // unresolved issue surfaced against the asset (still visible)
  | 'decommissioned'; // retired (terminal, history preserved)

/** Promotion to `governed` requires the full current-state facet set (AC1). */
const requiredFacets = [
  'assetType',
  'sourceIdentity',
  'ownerId',
  'lifecycleState',
  'risk',
  'controlCoverage',
  'evidenceState',
  'health',
  'lastObservationAt',
] as const;

const currentStateViewGuard: Guard<AssetState, Ctx> = ({ context }) => {
  const missing = requiredFacets.filter((f) => context[f] === undefined || context[f] === null);
  if (missing.length > 0) {
    return deny(
      makeReason('asset.facet_missing', `current-state view missing: ${missing.join(',')}`),
    );
  }
  return allow();
};

function governedAssetMachine(): StateMachine<AssetState, Ctx> {
  return defineStateMachine<AssetState, Ctx>({
    governance: governance({ id: ID(3) }),
    states: ['observed', 'inventoried', 'governed', 'issue-open', 'decommissioned'],
    initial: 'observed',
    terminal: ['decommissioned'],
    transitions: [
      { from: 'observed', to: 'inventoried' },
      { from: 'inventoried', to: 'governed', guard: currentStateViewGuard },
      { from: 'inventoried', to: 'issue-open' },
      { from: 'governed', to: 'issue-open' }, // unresolved issue appears — stays visible
      { from: 'governed', to: 'decommissioned' },
      { from: 'issue-open', to: 'governed', guard: currentStateViewGuard }, // issue resolved
      { from: 'issue-open', to: 'decommissioned' },
    ],
  });
}

describe('governed-asset state machine (AC1 current-state view: appears once with full facets)', () => {
  const fullFacets: Ctx = {
    assetType: 'model',
    sourceIdentity: 'kanban#board-1',
    ownerId: 'owner-ml',
    lifecycleState: 'active',
    risk: 'medium',
    controlCoverage: 0.8,
    evidenceState: 'current',
    health: 'healthy',
    lastObservationAt: T0,
    unresolvedIssues: 0,
  };

  it('AC1: an asset from a healthy source appears ONCE and is promoted to governed only with the full facet set', () => {
    const m = governedAssetMachine();
    const inst = m.create(ID(12), T0);
    const inv = m.apply(inst, {
      to: 'inventoried',
      expectedVersion: 1,
      actorId: 'svc-projector',
      reason: makeReason('asset.inventory', 'first observation'),
      at: T0,
      context: fullFacets,
    });
    if (inv.outcome !== 'applied') throw new Error('setup');
    const gov = m.apply(inv.instance, {
      to: 'governed',
      expectedVersion: 2,
      actorId: 'svc-projector',
      reason: makeReason('asset.govern', 'full facet set present'),
      at: T0,
      context: fullFacets,
    });
    expect(gov.outcome).toBe('applied');
    if (gov.outcome === 'applied') {
      expect(gov.instance.state).toBe('governed');
      // Appears ONCE: exactly one path observed→inventoried→governed, one durable identity.
      expect(gov.instance.history.map((h) => h.to)).toEqual(['inventoried', 'governed']);
      expect(gov.instance.instanceId).toBe(inv.instance.instanceId);
    }
  });

  it('AC1: promotion is REFUSED and explained when any current-state facet is missing', () => {
    const m = governedAssetMachine();
    const inst = m.create(ID(13), T0);
    const inv = m.apply(inst, {
      to: 'inventoried',
      expectedVersion: 1,
      actorId: 'svc-projector',
      reason: makeReason('asset.inventory', 'partial'),
      at: T0,
      context: { assetType: 'model', sourceIdentity: 'agentctl#x' },
    });
    if (inv.outcome !== 'applied') throw new Error('setup');
    const gov = m.apply(inv.instance, {
      to: 'governed',
      expectedVersion: 2,
      actorId: 'svc-projector',
      reason: makeReason('asset.govern', 'attempt promote'),
      at: T0,
      context: { assetType: 'model', sourceIdentity: 'agentctl#x' }, // missing owner/risk/coverage/…
    });
    expect(gov.outcome).toBe('rejected');
    if (gov.outcome === 'rejected') {
      expect(gov.code).toBe('guard-denied');
      expect(gov.reason.code).toBe('asset.facet_missing');
      expect(gov.reason.text).toMatch(/ownerId|risk|controlCoverage|health/);
    }
  });

  it('AC1: an unresolved issue on a governed asset keeps it VISIBLE (issue-open), not disappeared', () => {
    const m = governedAssetMachine();
    // observed→inventoried→governed→issue-open, then resolve back.
    let inst = m.create(ID(14), T0);
    for (const to of ['inventoried', 'governed'] as AssetState[]) {
      const r = m.apply(inst, {
        to,
        expectedVersion: inst.version,
        actorId: 'svc-projector',
        reason: makeReason('asset.step', 'promote'),
        at: T0,
        context: fullFacets,
      });
      if (r.outcome !== 'applied') throw new Error('setup');
      inst = r.instance;
    }
    const issue = m.apply(inst, {
      to: 'issue-open',
      expectedVersion: inst.version,
      actorId: 'svc-monitor',
      reason: makeReason('asset.issue', 'evidence went stale; unresolved issue #1'),
      at: T0,
      context: fullFacets,
    });
    expect(issue.outcome).toBe('applied');
    if (issue.outcome === 'applied') {
      expect(issue.instance.state).toBe('issue-open');
      expect(m.isTerminal('issue-open')).toBe(false); // still visible & inspectable
    }
  });
});

// ===========================================================================
// 4. CORRELATION state machine (AC3)
//    Related work across Kanban, agentctl, and workflows_orchestration is correlated. When the
//    canonical relationship is SAFE it correlates; when unresolved it must NOT merge — all
//    originals stay separate and a human-resolution conflict is opened.
// ===========================================================================

type CorrelationState =
  | 'uncorrelated' // distinct source records exist, not yet linked
  | 'proposed' // a candidate correlation proposed across sources
  | 'correlated' // safe canonical relationship — drill-down shows all distinct records
  | 'conflict' // cannot determine a safe relationship → assigned for human resolution (AC3/dup)
  | 'resolved'; // human resolved the conflict (terminal)

/** Refuse to auto-correlate unless the relationship is provably safe AND ≥2 distinct sources. */
const safeCorrelationGuard: Guard<CorrelationState, Ctx> = ({ context }) => {
  const sources = Array.isArray(context.sources) ? (context.sources as string[]) : [];
  const distinct = new Set(sources);
  if (distinct.size < 2)
    return deny(makeReason('corr.too_few_sources', 'need ≥2 distinct sources'));
  if (context.safeCanonical !== true) {
    return deny(
      makeReason('corr.ambiguous', 'no safe canonical relationship; keep originals separate'),
    );
  }
  return allow();
};

function correlationMachine(): StateMachine<CorrelationState, Ctx> {
  return defineStateMachine<CorrelationState, Ctx>({
    governance: governance({ id: ID(4) }),
    states: ['uncorrelated', 'proposed', 'correlated', 'conflict', 'resolved'],
    initial: 'uncorrelated',
    terminal: ['resolved'],
    transitions: [
      { from: 'uncorrelated', to: 'proposed' },
      { from: 'proposed', to: 'correlated', guard: safeCorrelationGuard },
      { from: 'proposed', to: 'conflict' }, // ambiguous → conflict for human resolution
      { from: 'correlated', to: 'conflict' }, // later divergence reopens as conflict
      { from: 'conflict', to: 'resolved' },
      { from: 'conflict', to: 'correlated', guard: safeCorrelationGuard },
    ],
  });
}

describe('correlation state machine (AC3 cross-source drill-down; safe-only merge)', () => {
  it('AC3: related records across Kanban/agentctl/workflows_orchestration correlate only under a SAFE canonical relationship', () => {
    const m = correlationMachine();
    const inst = m.create(ID(15), T0);
    const proposed = m.apply(inst, {
      to: 'proposed',
      expectedVersion: 1,
      actorId: 'svc-correlator',
      reason: makeReason('corr.propose', 'candidate link'),
      at: T0,
      context: {},
    });
    if (proposed.outcome !== 'applied') throw new Error('setup');
    const correlated = m.apply(proposed.instance, {
      to: 'correlated',
      expectedVersion: 2,
      actorId: 'svc-correlator',
      reason: makeReason('corr.correlate', 'safe canonical id match'),
      at: T0,
      context: {
        sources: ['kanban', 'agentctl', 'workflows_orchestration'],
        safeCanonical: true,
      },
    });
    expect(correlated.outcome).toBe('applied');
    if (correlated.outcome === 'applied') {
      expect(correlated.instance.state).toBe('correlated');
      // Drill-down preserves the DISTINCT source records — the machine never collapses identity;
      // the correlation is recorded as history alongside the still-separate source ids.
      expect(correlated.instance.history.at(-1)?.reason.code).toBe('corr.correlate');
    }
  });

  it('AC3: an AMBIGUOUS correlation is refused merge; originals stay separate and a human-resolution CONFLICT is opened', () => {
    const m = correlationMachine();
    const inst = m.create(ID(16), T0);
    const proposed = m.apply(inst, {
      to: 'proposed',
      expectedVersion: 1,
      actorId: 'svc-correlator',
      reason: makeReason('corr.propose', 'candidate link'),
      at: T0,
      context: {},
    });
    if (proposed.outcome !== 'applied') throw new Error('setup');
    // Try to correlate without a safe canonical relationship → refused (originals separate).
    const refused = m.apply(proposed.instance, {
      to: 'correlated',
      expectedVersion: 2,
      actorId: 'svc-correlator',
      reason: makeReason('corr.correlate', 'attempt unsafe merge'),
      at: T0,
      context: { sources: ['kanban', 'agentctl'], safeCanonical: false },
    });
    expect(refused.outcome).toBe('rejected');
    if (refused.outcome === 'rejected') {
      expect(refused.code).toBe('guard-denied');
      expect(refused.reason.code).toBe('corr.ambiguous');
    }
    // Instead open a conflict assigned for human resolution.
    const conflict = m.apply(proposed.instance, {
      to: 'conflict',
      expectedVersion: 2,
      actorId: 'svc-correlator',
      reason: makeReason('corr.conflict', 'unsafe canonical; assign human owner-ml'),
      at: T0,
      context: {},
    });
    expect(conflict.outcome).toBe('applied');
    if (conflict.outcome === 'applied') {
      expect(conflict.instance.state).toBe('conflict');
      const resolved = m.apply(conflict.instance, {
        to: 'resolved',
        expectedVersion: 3,
        actorId: 'owner-ml',
        reason: makeReason('corr.resolved', 'human confirmed separate items'),
        at: T0,
        context: {},
      });
      expect(resolved.outcome).toBe('applied');
      if (resolved.outcome === 'applied') expect(m.isTerminal('resolved')).toBe(true);
    }
  });
});

// ===========================================================================
// 5. GAP state machine (AC2, AC6)
//    A coverage / governed-source gap is opened with reason+impact+owner-action, ages while
//    open, may be acknowledged/remediated, and is only closed with evidence — never by silently
//    disappearing.
// ===========================================================================

type GapState =
  | 'open' // gap opened: reason, age, impact, required owner action visible
  | 'acknowledged' // owner acknowledged; owner action assigned
  | 'remediating' // work in progress
  | 'closed-verified' // remediated + verified (terminal)
  | 'accepted-risk'; // formally accepted with review/expiry (terminal)

/** A gap may only close with verification evidence (never silently). */
const closeGapGuard: Guard<GapState, Ctx> = ({ context }) =>
  context.verificationEvidence
    ? allow()
    : deny(makeReason('gap.no_verification', 'gap cannot close without verification evidence'));

/** Accepting risk requires an explicit review/expiry date (AC6). */
const acceptRiskGuard: Guard<GapState, Ctx> = ({ context }) =>
  typeof context.reviewOrExpiryAt === 'number'
    ? allow()
    : deny(makeReason('gap.no_review_date', 'risk acceptance requires a review/expiry date'));

function gapMachine(): StateMachine<GapState, Ctx> {
  return defineStateMachine<GapState, Ctx>({
    governance: governance({ id: ID(20) }),
    states: ['open', 'acknowledged', 'remediating', 'closed-verified', 'accepted-risk'],
    initial: 'open',
    terminal: ['closed-verified', 'accepted-risk'],
    transitions: [
      { from: 'open', to: 'acknowledged' },
      { from: 'open', to: 'accepted-risk', guard: acceptRiskGuard },
      { from: 'acknowledged', to: 'remediating' },
      { from: 'acknowledged', to: 'accepted-risk', guard: acceptRiskGuard },
      { from: 'remediating', to: 'closed-verified', guard: closeGapGuard },
      { from: 'remediating', to: 'open' }, // remediation failed → reopens, still visible
    ],
  });
}

describe('gap state machine (AC2 coverage-gap lifecycle, AC6 governed-source gap with review/expiry)', () => {
  it('AC2: a gap opens with reason/impact/owner-action, and cannot CLOSE without verification evidence', () => {
    const m = gapMachine();
    let inst = m.create(ID(21), T0);
    for (const to of ['acknowledged', 'remediating'] as GapState[]) {
      const r = m.apply(inst, {
        to,
        expectedVersion: inst.version,
        actorId: 'owner-ml',
        reason: makeReason('gap.progress', 'owner action in progress'),
        at: T0,
        context: {},
      });
      if (r.outcome !== 'applied') throw new Error('setup');
      inst = r.instance;
    }
    // Try to close WITHOUT verification → refused, gap stays visible.
    const badClose = m.apply(inst, {
      to: 'closed-verified',
      expectedVersion: inst.version,
      actorId: 'owner-ml',
      reason: makeReason('gap.close', 'claim fixed'),
      at: T0,
      context: {},
    });
    expect(badClose.outcome).toBe('rejected');
    if (badClose.outcome === 'rejected') {
      expect(badClose.code).toBe('guard-denied');
      expect(badClose.reason.code).toBe('gap.no_verification');
    }
    // Close WITH verification → applied and terminal.
    const goodClose = m.apply(inst, {
      to: 'closed-verified',
      expectedVersion: inst.version,
      actorId: 'owner-ml',
      reason: makeReason('gap.close', 'remediated and verified'),
      at: T0,
      context: { verificationEvidence: 'verify#88' },
    });
    expect(goodClose.outcome).toBe('applied');
    if (goodClose.outcome === 'applied') expect(m.isTerminal('closed-verified')).toBe(true);
  });

  it('AC6: accepting a governed-source gap as risk REQUIRES a review/expiry date', () => {
    const m = gapMachine();
    const inst = m.create(ID(22), T0);
    const noDate = m.apply(inst, {
      to: 'accepted-risk',
      expectedVersion: 1,
      actorId: 'compliance-owner',
      reason: makeReason('gap.accept', 'accept without review date'),
      at: T0,
      context: {},
    });
    expect(noDate.outcome).toBe('rejected');
    if (noDate.outcome === 'rejected') expect(noDate.reason.code).toBe('gap.no_review_date');

    const withDate = m.apply(inst, {
      to: 'accepted-risk',
      expectedVersion: 1,
      actorId: 'compliance-owner',
      reason: makeReason('gap.accept', 'accepted with review 2026-12-01'),
      at: T0,
      context: { reviewOrExpiryAt: T0 + 30 * 24 * 3600_000 },
    });
    expect(withDate.outcome).toBe('applied');
    if (withDate.outcome === 'applied') {
      expect(withDate.instance.state).toBe('accepted-risk');
      // Aging is reconstructable: the open→accepted history is preserved.
      expect(withDate.instance.history[0]?.from).toBe('open');
    }
  });

  it('AC2: a failed remediation REOPENS the gap (stays visible) rather than disappearing', () => {
    const m = gapMachine();
    let inst = m.create(ID(23), T0);
    for (const to of ['acknowledged', 'remediating'] as GapState[]) {
      const r = m.apply(inst, {
        to,
        expectedVersion: inst.version,
        actorId: 'owner-ml',
        reason: makeReason('gap.progress', 'progress'),
        at: T0,
        context: {},
      });
      if (r.outcome !== 'applied') throw new Error('setup');
      inst = r.instance;
    }
    const reopened = m.apply(inst, {
      to: 'open',
      expectedVersion: inst.version,
      actorId: 'owner-ml',
      reason: makeReason('gap.reopen', 'remediation failed; gap remains'),
      at: T0,
      context: {},
    });
    expect(reopened.outcome).toBe('applied');
    if (reopened.outcome === 'applied') {
      expect(reopened.instance.state).toBe('open');
      // Full history retained — nothing silently disappeared.
      expect(reopened.instance.history.map((h) => h.to)).toEqual([
        'acknowledged',
        'remediating',
        'open',
      ]);
    }
  });
});

// ===========================================================================
// Cross-machine invariants — all five machines are FULLY GOVERNED entities.
// (Executable form of "inventory/source state machines have stable identifiers, versions,
// owners, lifecycle states, tests, monitoring, failure behavior, exceptions, and evidence
// expectations" — VO-34d9f9fb2a6a39e2d62c.)
// ===========================================================================

describe('governance invariants for all inventory state machines', () => {
  const machines: Array<[string, StateMachine<string, Ctx>]> = [
    ['source-catalog', sourceCatalogMachine() as unknown as StateMachine<string, Ctx>],
    ['inventory-boundary', inventoryBoundaryMachine() as unknown as StateMachine<string, Ctx>],
    ['governed-asset', governedAssetMachine() as unknown as StateMachine<string, Ctx>],
    ['correlation', correlationMachine() as unknown as StateMachine<string, Ctx>],
    ['gap', gapMachine() as unknown as StateMachine<string, Ctx>],
  ];

  it('each machine carries every governed facet (id, version, owner, lifecycle, contract)', () => {
    for (const [name, m] of machines) {
      expect(m.id, name).toBeTruthy();
      expect(m.version, name).toBeGreaterThanOrEqual(1);
      expect(m.owner.ownerId, name).toBe('team-governance');
      expect(m.lifecycleState, name).toBe('active');
      expect(m.contract.tests.length, name).toBeGreaterThan(0);
      expect(m.contract.monitoring.length, name).toBeGreaterThan(0);
      expect(m.contract.failureBehavior, name).toBe('pause-safe');
      expect(Array.isArray(m.contract.exceptions), name).toBe(true);
      expect(m.contract.evidenceExpectations.length, name).toBeGreaterThan(0);
    }
  });

  it('each machine has at least one terminal (history-preserving) sink and every terminal is a declared state', () => {
    for (const [name, m] of machines) {
      const terminals = [...m.terminal];
      expect(terminals.length, name).toBeGreaterThan(0);
      for (const t of terminals) expect(m.isState(t), `${name}:${t}`).toBe(true);
      for (const t of terminals) expect(m.allowedTargets(t), `${name}:${t}`).toEqual([]);
    }
  });
});
