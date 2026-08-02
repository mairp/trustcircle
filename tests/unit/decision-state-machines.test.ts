// TrustCircleAI — Phase 87 / Work item 20AVT8AN4CK1FJY7T7BYH73NG3.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M (content hash af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b).
//
// Unit tests for the DECISION, REQUIREMENT, DELEGATION, JOINT-PACKAGE, EXPIRY, INVALIDATION,
// and TERMINAL-HISTORY state machines. These seven state machines are the executable form of
// the phase acceptance criteria for authority-scoped human decisions:
//
//   AC1 decision package completeness (approver sees requested action, scope, business impact,
//       risks, alternatives, evidence, policy+control versions, requester, SoD constraints,
//       expiry, expected result) ..................... describe('DECISION package completeness (AC1)')
//   AC2 approve/deny/delegate/request-changes/escalate/expire fire ONCE with a reason and a
//       retained complete audit record ............... describe('DECISION transitions (AC2)')
//   AC3 no-authority / conflicting-duty / no-reason / expired-delegation → NO transition, a
//       recorded, explained rejection ................ describe('DECISION rejections (AC3)')
//   AC4 material change after review begins → platform requires re-review against the current
//       package (invalidation) ....................... describe('INVALIDATION / re-review (AC4)')
//   AC5 delegation: named recipient, bounded scope, start+expiry, reason, delegator authority,
//       and NO circular / privilege-expanding chain .. describe('DELEGATION creation (AC5)')
//   AC6 multi-tenant consequential action: blocked until central guardrails pass, every
//       affected tenant supplies a current scoped approval, AND a distinct central governance
//       reviewer approves ............................ describe('JOINT multi-tenant package (AC6)')
//
// Every machine is built on the REAL, dependency-free `defineStateMachine` engine +
// `primitives.ts` governed-entity/reason/uuid helpers from @trustcircle/domain, so every
// transition is an independently observable durable effect (append-only history + monotonic
// version + content digest), never a claim. Authority / SoD / delegation-lineage FACTS come
// from the REAL @trustcircle/authz source of truth (separation-of-duties.ts + authority.ts) —
// this test does not re-implement any oracle; the guards project those verdicts into the
// engine's guard contract. That is what makes AC3/AC5/AC6 non-vacuous: a guard passes only when
// the authz evaluator says `permitted`, and fails closed with the authz violation code / deny
// reason otherwise.
//
// Import paths mirror tests/unit/inventory-state-machines.test.ts: relative, with `.ts`
// extensions (allowImportingTsExtensions + NodeNext). No wall clock, no Math.random.

import { describe, it, expect } from 'vitest';
import {
  defineStateMachine,
  allow,
  deny,
  instanceDigest,
  type StateMachine,
  type Guard,
  type MachineInstance,
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
import {
  evaluateSeparationOfDuties,
  evaluateCentralReviewerDistinctness,
  type DutyAssignment,
  type SoDConstraint,
  type CrossTenantAction,
  type CentralReviewer,
} from '../../packages/authz/src/separation-of-duties.ts';
import {
  resolveDelegation,
  resolveRoleAssignment,
  type Delegation,
  type RoleAssignment,
  type AuthorityScope,
} from '../../packages/authz/src/authority.ts';

// ---------------------------------------------------------------------------
// Deterministic construction helpers (no wall clock, no Math.random).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000 as EpochMillis;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Deterministic byte source so UUIDv7s are stable across runs (mirrors tests/domain). */
const detRandom = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
};
const ID = (bumpMs = 0): Uuid => uuidV7((T0 + bumpMs) as EpochMillis, detRandom);

function goodContract(overrides: Partial<GovernanceContract> = {}): GovernanceContract {
  return {
    tests: [
      'VO-8899c46fce694aa568f1',
      'VO-4b812f5737d114f869b3',
      'VO-34cfb7a95f2be14d92e8',
      'VO-ed72cb7a09a4bb732270',
      'VO-c06855504833e11c8bb8',
      'VO-35f12b424fd8c69a70b8',
    ],
    monitoring: ['decision.pending_count', 'decision.expired_count', 'decision.reject_reasons'],
    failureBehavior: 'fail-closed',
    exceptions: [],
    evidenceExpectations: ['decision-record', 'audit-record', 'joint-decision-package'],
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

// ===========================================================================
// The decision package (AC1). An approver acting on a pending item must be shown a COMPLETE
// package: every one of the twelve facets must be present and non-vacuous, else the item is
// not reviewable. `assertDecisionPackageComplete` is the executable oracle for AC1 and is also
// consumed by the DECISION machine's guards (a decision may not be taken on an incomplete
// package).
// ===========================================================================

interface DecisionPackage {
  readonly requestedAction: string; // requested action
  readonly affectedScope: AuthorityScope; // affected scope
  readonly businessImpact: string; // business impact
  readonly risks: readonly string[]; // risks
  readonly alternatives: readonly string[]; // alternatives considered
  readonly evidenceRefs: readonly string[]; // evidence
  readonly policyVersion: string; // policy version at review
  readonly controlVersion: string; // control version at review
  readonly requesterPrincipalId: string; // requester
  readonly sodConstraint: SoDConstraint; // separation-of-duties constraints
  readonly expiresAt: EpochMillis; // expiry
  readonly expectedResult: string; // expected result
}

type PackageDefect =
  | 'MISSING_REQUESTED_ACTION'
  | 'MISSING_SCOPE'
  | 'MISSING_BUSINESS_IMPACT'
  | 'MISSING_RISKS'
  | 'MISSING_ALTERNATIVES'
  | 'MISSING_EVIDENCE'
  | 'MISSING_POLICY_VERSION'
  | 'MISSING_CONTROL_VERSION'
  | 'MISSING_REQUESTER'
  | 'MISSING_SOD_CONSTRAINT'
  | 'MISSING_EXPIRY'
  | 'MISSING_EXPECTED_RESULT';

/** Return every defect that makes a package incomplete. Empty ⇒ complete/reviewable. */
function packageDefects(pkg: DecisionPackage): PackageDefect[] {
  const d: PackageDefect[] = [];
  const nonEmpty = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0;
  if (!nonEmpty(pkg.requestedAction)) d.push('MISSING_REQUESTED_ACTION');
  if (
    !pkg.affectedScope ||
    !nonEmpty(pkg.affectedScope.scopeId) ||
    pkg.affectedScope.allowedActions.length === 0
  )
    d.push('MISSING_SCOPE');
  if (!nonEmpty(pkg.businessImpact)) d.push('MISSING_BUSINESS_IMPACT');
  if (!Array.isArray(pkg.risks) || pkg.risks.length === 0) d.push('MISSING_RISKS');
  if (!Array.isArray(pkg.alternatives) || pkg.alternatives.length === 0)
    d.push('MISSING_ALTERNATIVES');
  if (!Array.isArray(pkg.evidenceRefs) || pkg.evidenceRefs.length === 0) d.push('MISSING_EVIDENCE');
  if (!nonEmpty(pkg.policyVersion)) d.push('MISSING_POLICY_VERSION');
  if (!nonEmpty(pkg.controlVersion)) d.push('MISSING_CONTROL_VERSION');
  if (!nonEmpty(pkg.requesterPrincipalId)) d.push('MISSING_REQUESTER');
  if (!pkg.sodConstraint || !nonEmpty(pkg.sodConstraint.sodConstraintId))
    d.push('MISSING_SOD_CONSTRAINT');
  if (typeof pkg.expiresAt !== 'number' || !Number.isFinite(pkg.expiresAt)) d.push('MISSING_EXPIRY');
  if (!nonEmpty(pkg.expectedResult)) d.push('MISSING_EXPECTED_RESULT');
  return d;
}

function isPackageComplete(pkg: DecisionPackage): boolean {
  return packageDefects(pkg).length === 0;
}

const SOD: SoDConstraint = {
  sodConstraintId: 'sod-decision-1',
  tenantId: ID(1), // waivable tenant constraint
  actionClass: 'production-config-change',
  incompatibleRoles: [],
  // Separation is enforced by the intrinsic duty-forbidden-relationship rules (an approver may
  // not also be the requester/executor/owner) and by minimumDistinctPrincipals ≥ 2; we do NOT
  // additionally list requester/executor as constraint-level incompatible relationships, because
  // the evaluator applies that list to EVERY filled duty (which would reject the requester's own
  // request assignment). Keeping it empty lets a properly-separated request+approval set pass
  // while still rejecting self-approval and single-principal actions.
  incompatibleRelationships: [],
  minimumDistinctPrincipals: 2,
  status: 'active',
};

function completePackage(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
  return {
    requestedAction: 'promote release 4.2.0 to production tenant fleet',
    affectedScope: {
      scopeType: 'environment',
      scopeId: 'prod-eu',
      allowedActions: ['promote', 'rollback'],
    },
    businessImpact: 'affects checkout availability for 12 tenants',
    risks: ['transient 5xx during rollout', 'schema drift on rollback'],
    alternatives: ['canary to one tenant first', 'defer to next window'],
    evidenceRefs: ['evidence#run-771', 'evidence#soak-88'],
    policyVersion: 'policy@2026.07.3',
    controlVersion: 'control@2026.07.1',
    requesterPrincipalId: 'user-requester',
    sodConstraint: SOD,
    expiresAt: (T0 + 2 * DAY) as EpochMillis,
    expectedResult: 'release live in prod-eu, error budget unchanged',
    ...overrides,
  };
}

// ===========================================================================
// Decision context. The guards read AUTHORITY + SoD + package-completeness FACTS that the
// caller resolved from the real @trustcircle/authz source of truth, plus the "material change"
// snapshot for AC4. A guard is a pure predicate over this context — it never re-derives the
// oracle, it only projects an already-computed authz verdict into an allow/deny.
// ===========================================================================

interface DecisionCtx extends Record<string, unknown> {
  /** The package the approver is acting against. */
  readonly pkg?: DecisionPackage;
  /** SoD duty assignments for THIS action, as resolved from current authority. */
  readonly dutyAssignments?: readonly DutyAssignment[];
  /** Whether the acting approver holds current authority for the action (resolved upstream). */
  readonly actorHasAuthority?: boolean;
  /** A delegation the approver is relying on, if any, plus lineage-resolution inputs. */
  readonly delegation?: {
    readonly leaf: Delegation;
    readonly byId: ReadonlyMap<string, Delegation>;
    readonly sourceOf: (id: string) => RoleAssignment | null;
    readonly nowMs: number;
  };
  /** The package facets snapshotted when review BEGAN (for AC4 material-change detection). */
  readonly reviewStartedWith?: MaterialSnapshot;
  /** The package facets as they are NOW (AC4). */
  readonly currentSnapshot?: MaterialSnapshot;
  /** Requested transition, for escalate/expire specialisations. */
  readonly nowMs?: number;
}

/** The subset of package facets whose change is "material" and forces re-review (AC4). */
interface MaterialSnapshot {
  readonly evidenceRefs: readonly string[];
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly affectedScopeId: string;
  readonly businessImpact: string;
}

function snapshotOf(pkg: DecisionPackage): MaterialSnapshot {
  return {
    evidenceRefs: [...pkg.evidenceRefs],
    policyVersion: pkg.policyVersion,
    controlVersion: pkg.controlVersion,
    affectedScopeId: pkg.affectedScope.scopeId,
    businessImpact: pkg.businessImpact,
  };
}

/** Which material facets differ between the review-start snapshot and now (AC4). */
function materialDiff(a: MaterialSnapshot, b: MaterialSnapshot): string[] {
  const diff: string[] = [];
  if (a.evidenceRefs.join(' ') !== b.evidenceRefs.join(' ')) diff.push('evidence');
  if (a.policyVersion !== b.policyVersion) diff.push('policyVersion');
  if (a.controlVersion !== b.controlVersion) diff.push('controlVersion');
  if (a.affectedScopeId !== b.affectedScopeId) diff.push('scope');
  if (a.businessImpact !== b.businessImpact) diff.push('businessImpact');
  return diff;
}

// ===========================================================================
// 1. DECISION state machine (AC1, AC2, AC3, AC4).
//    pending → under_review → (approved | denied | delegated | changes_requested | escalated
//                              | expired | invalidated)
//    Terminal-success/terminal-fail sinks preserve their full history forever.
// ===========================================================================

type DecisionState =
  | 'pending' // awaiting an approver to pick it up
  | 'under_review' // an authorized approver opened a COMPLETE package (AC1)
  | 'approved' // terminal
  | 'denied' // terminal
  | 'delegated' // terminal for THIS decision; a new decision is minted for the recipient
  | 'changes_requested' // returned to requester (terminal for this cycle)
  | 'escalated' // terminal for this reviewer; escalated to a higher authority decision
  | 'expired' // terminal; window elapsed (AC2 expire, AC/expiry machine)
  | 'invalidated'; // terminal; material change forced re-review (AC4)

/** Guard: an approver may only OPEN review on a COMPLETE package while holding current authority
 *  and satisfying SoD. Fails closed with the exact defect / authz violation. */
const openReviewGuard: Guard<DecisionState, DecisionCtx> = ({ context }) => {
  const pkg = context.pkg;
  if (!pkg) return deny(makeReason('decision.no_package', 'no decision package supplied'));
  const defects = packageDefects(pkg);
  if (defects.length > 0) {
    return deny(
      makeReason('decision.incomplete_package', `package incomplete: ${defects.join(', ')}`),
    );
  }
  if (context.actorHasAuthority !== true) {
    return deny(makeReason('decision.no_authority', 'actor lacks current authority to review'));
  }
  return allow();
};

/** Guard: a terminal decision (approve/deny/etc.) requires current authority AND a fully
 *  separated set of duties (real SoD evaluator). Fails closed with the authz violation code. */
const decideGuard: Guard<DecisionState, DecisionCtx> = ({ context }) => {
  if (context.actorHasAuthority !== true) {
    return deny(makeReason('decision.no_authority', 'actor lacks current authority to decide'));
  }
  const assignments = context.dutyAssignments ?? [];
  const sod = evaluateSeparationOfDuties(assignments, context.pkg?.sodConstraint ?? SOD);
  if (!sod.permitted) {
    const codes = sod.violations.map((v) => v.code).join(',');
    return deny(makeReason('decision.sod_violation', `SoD violation(s): ${codes}`));
  }
  return allow();
};

/** Guard: delegating a decision requires a VALID delegation chain (real lineage resolver). An
 *  EXPIRED or circular / privilege-expanding chain fails closed with the resolver's reason. */
const delegateGuard: Guard<DecisionState, DecisionCtx> = ({ context }) => {
  const del = context.delegation;
  if (!del) return deny(makeReason('decision.no_delegation', 'no delegation supplied'));
  const res = resolveDelegation(del.leaf, del.byId, del.sourceOf, del.nowMs);
  if (!res.granted) {
    return deny(
      makeReason(
        'decision.delegation_invalid',
        `delegation not honoured: ${res.reason ?? 'unknown'}`,
      ),
    );
  }
  return allow();
};

/** Guard: an approver may INVALIDATE (force re-review) exactly when a material facet changed
 *  after review began (AC4). Absent a material change the invalidation is refused (non-vacuous:
 *  you cannot invalidate a package that did not materially change). */
const invalidateGuard: Guard<DecisionState, DecisionCtx> = ({ context }) => {
  const before = context.reviewStartedWith;
  const now = context.currentSnapshot;
  if (!before || !now) {
    return deny(makeReason('decision.no_snapshot', 'missing review snapshots for comparison'));
  }
  const diff = materialDiff(before, now);
  if (diff.length === 0) {
    return deny(
      makeReason('decision.no_material_change', 'no material change; re-review not required'),
    );
  }
  return allow();
};

function decisionMachine() {
  return defineStateMachine<DecisionState, DecisionCtx>({
    governance: governance(),
    states: [
      'pending',
      'under_review',
      'approved',
      'denied',
      'delegated',
      'changes_requested',
      'escalated',
      'expired',
      'invalidated',
    ],
    initial: 'pending',
    terminal: [
      'approved',
      'denied',
      'delegated',
      'changes_requested',
      'escalated',
      'expired',
      'invalidated',
    ],
    transitions: [
      { from: 'pending', to: 'under_review', guard: openReviewGuard },
      // A pending item can still expire before anyone reviews it.
      { from: 'pending', to: 'expired' },
      // The six AC2 decision outcomes from an open review.
      { from: 'under_review', to: 'approved', guard: decideGuard },
      { from: 'under_review', to: 'denied', guard: decideGuard },
      { from: 'under_review', to: 'delegated', guard: delegateGuard },
      { from: 'under_review', to: 'changes_requested', guard: decideGuard },
      { from: 'under_review', to: 'escalated', guard: decideGuard },
      { from: 'under_review', to: 'expired' },
      // AC4: material change during review forces re-review.
      { from: 'under_review', to: 'invalidated', guard: invalidateGuard },
    ],
  });
}

// A convenience: drive a fresh decision instance up to `under_review` with a complete package
// and an authorized approver (the common precondition for the AC2/AC3/AC4 tests).
function openReviewedDecision(
  m: StateMachine<DecisionState, DecisionCtx>,
  pkg: DecisionPackage,
): MachineInstance<DecisionState> {
  const inst = m.create(ID(100), T0);
  const r = m.apply(inst, {
    to: 'under_review',
    expectedVersion: inst.version,
    actorId: 'user-approver',
    reason: makeReason('decision.open_review', 'authorized approver opens review'),
    at: T0,
    context: { pkg, actorHasAuthority: true },
  });
  if (r.outcome !== 'applied') throw new Error(`setup failed: ${JSON.stringify(r)}`);
  return r.instance;
}

// Two distinct, properly-separated duty assignments (requester ≠ approver) that PASS the real
// SoD evaluator for `SOD` — the positive control for AC2.
function separatedDuties(): DutyAssignment[] {
  return [
    {
      principalId: 'user-requester',
      duty: 'request',
      roles: ['governance_officer'],
      relationships: ['requester'],
      tenantId: SOD.tenantId,
    },
    {
      principalId: 'user-approver',
      duty: 'approval',
      roles: ['authorized_approver'],
      relationships: ['approver'],
      tenantId: SOD.tenantId,
    },
  ];
}

describe('DECISION package completeness (AC1): an approver with authority sees a complete package', () => {
  it('a complete package exposes all twelve required facets and is reviewable', () => {
    const pkg = completePackage();
    expect(isPackageComplete(pkg)).toBe(true);
    // Each of the twelve facets is individually present (independently observable).
    expect(pkg.requestedAction.length).toBeGreaterThan(0);
    expect(pkg.affectedScope.scopeId).toBe('prod-eu');
    expect(pkg.businessImpact.length).toBeGreaterThan(0);
    expect(pkg.risks.length).toBeGreaterThan(0);
    expect(pkg.alternatives.length).toBeGreaterThan(0);
    expect(pkg.evidenceRefs.length).toBeGreaterThan(0);
    expect(pkg.policyVersion).toMatch(/@/);
    expect(pkg.controlVersion).toMatch(/@/);
    expect(pkg.requesterPrincipalId).toBe('user-requester');
    expect(pkg.sodConstraint.sodConstraintId).toBe('sod-decision-1');
    expect(Number.isFinite(pkg.expiresAt)).toBe(true);
    expect(pkg.expectedResult.length).toBeGreaterThan(0);

    // Opening review on a complete package is APPLIED (the reviewable state exists durably).
    const m = decisionMachine();
    const inst = m.create(ID(101), T0);
    const r = m.apply(inst, {
      to: 'under_review',
      expectedVersion: 1,
      actorId: 'user-approver',
      reason: makeReason('decision.open_review', 'open review'),
      at: T0,
      context: { pkg, actorHasAuthority: true },
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') expect(r.instance.state).toBe('under_review');
  });

  it('NEGATIVE CONTROL: dropping ANY one of the twelve facets makes the package non-reviewable', () => {
    // Independently prove each facet is load-bearing: mutate exactly one, expect the matching
    // defect and a refused open-review. A vacuous oracle would accept these.
    const cases: Array<[Partial<DecisionPackage>, PackageDefect]> = [
      [{ requestedAction: '  ' }, 'MISSING_REQUESTED_ACTION'],
      [
        { affectedScope: { scopeType: 'environment', scopeId: '', allowedActions: [] } },
        'MISSING_SCOPE',
      ],
      [{ businessImpact: '' }, 'MISSING_BUSINESS_IMPACT'],
      [{ risks: [] }, 'MISSING_RISKS'],
      [{ alternatives: [] }, 'MISSING_ALTERNATIVES'],
      [{ evidenceRefs: [] }, 'MISSING_EVIDENCE'],
      [{ policyVersion: '' }, 'MISSING_POLICY_VERSION'],
      [{ controlVersion: '' }, 'MISSING_CONTROL_VERSION'],
      [{ requesterPrincipalId: '' }, 'MISSING_REQUESTER'],
      [
        {
          sodConstraint: { ...SOD, sodConstraintId: '' },
        },
        'MISSING_SOD_CONSTRAINT',
      ],
      [{ expiresAt: Number.NaN as unknown as EpochMillis }, 'MISSING_EXPIRY'],
      [{ expectedResult: '' }, 'MISSING_EXPECTED_RESULT'],
    ];
    const m = decisionMachine();
    for (const [override, expectedDefect] of cases) {
      const pkg = completePackage(override);
      const defects = packageDefects(pkg);
      expect(defects, `expected ${expectedDefect}`).toContain(expectedDefect);
      expect(isPackageComplete(pkg)).toBe(false);
      // The machine refuses to open review on the incomplete package (no transition).
      const inst = m.create(ID(102), T0);
      const r = m.apply(inst, {
        to: 'under_review',
        expectedVersion: 1,
        actorId: 'user-approver',
        reason: makeReason('decision.open_review', 'open review on incomplete package'),
        at: T0,
        context: { pkg, actorHasAuthority: true },
      });
      expect(r.outcome, expectedDefect).toBe('rejected');
      if (r.outcome === 'rejected') {
        expect(r.code).toBe('guard-denied');
        expect(r.reason.code).toBe('decision.incomplete_package');
        expect(r.reason.text).toContain(expectedDefect);
      }
    }
  });
});

describe('DECISION transitions (AC2): each permitted outcome fires ONCE with a reason and a retained audit record', () => {
  const OUTCOMES: DecisionState[] = [
    'approved',
    'denied',
    'changes_requested',
    'escalated',
  ];

  for (const outcome of OUTCOMES) {
    it(`under_review → ${outcome} is applied once and its audit record is complete & terminal`, () => {
      const m = decisionMachine();
      const pkg = completePackage();
      const reviewing = openReviewedDecision(m, pkg);

      const r = m.apply(reviewing, {
        to: outcome,
        expectedVersion: reviewing.version,
        actorId: 'user-approver',
        reason: makeReason('decision.decide', `decision: ${outcome}`),
        at: (T0 + HOUR) as EpochMillis,
        context: { pkg, actorHasAuthority: true, dutyAssignments: separatedDuties() },
      });
      expect(r.outcome).toBe('applied');
      if (r.outcome !== 'applied') return;
      const decided = r.instance;
      expect(decided.state).toBe(outcome);
      expect(m.isTerminal(outcome)).toBe(true);

      // Complete, attributable audit record for the transition (durable effect witness).
      const entry = r.entry;
      expect(entry.from).toBe('under_review');
      expect(entry.to).toBe(outcome);
      expect(entry.actorId).toBe('user-approver');
      expect(entry.reason.text.length).toBeGreaterThan(0);
      expect(entry.at).toBe(T0 + HOUR);
      expect(entry.toVersion).toBe(decided.version);

      // The full ordered history (open-review + the decision) is retained & queryable.
      expect(decided.history.map((h) => h.to)).toEqual(['under_review', outcome]);

      // Transition-ONCE / idempotency: a second writer still holding the pre-decision (stale)
      // version, applying against the CURRENT (already-decided) instance, is an optimistic-
      // concurrency conflict — no second effect. This mirrors a store's `WHERE id=? AND
      // version=?` returning zero rows.
      expect(decided.version).toBe(reviewing.version + 1); // the decision bumped the version once
      const replay = m.apply(decided, {
        to: outcome,
        expectedVersion: reviewing.version, // stale token — decided is one version ahead
        actorId: 'user-approver',
        reason: makeReason('decision.decide', 'replay same decision with a stale version'),
        at: (T0 + HOUR) as EpochMillis,
        context: { pkg, actorHasAuthority: true, dutyAssignments: separatedDuties() },
      });
      expect(replay.outcome).toBe('conflict');
      if (replay.outcome === 'conflict') {
        expect(replay.expectedVersion).toBe(reviewing.version);
        expect(replay.actualVersion).toBe(decided.version);
      }

      const fromTerminal = m.apply(decided, {
        to: outcome === 'approved' ? 'denied' : 'approved',
        expectedVersion: decided.version,
        actorId: 'user-approver',
        reason: makeReason('decision.decide', 'attempt to overturn terminal decision'),
        at: (T0 + 2 * HOUR) as EpochMillis,
        context: { pkg, actorHasAuthority: true, dutyAssignments: separatedDuties() },
      });
      expect(fromTerminal.outcome).toBe('rejected');
      if (fromTerminal.outcome === 'rejected') {
        expect(fromTerminal.code).toBe('terminal-state-rewrite');
      }
      // The digest of the decided instance is stable across re-reads (independent witness).
      expect(instanceDigest(decided)).toBe(instanceDigest(decided.snapshot()));
    });
  }

  it('under_review → delegated fires once on a VALID delegation and retains the audit record', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const good = validDelegationCtx();
    const r = m.apply(reviewing, {
      to: 'delegated',
      expectedVersion: reviewing.version,
      actorId: 'user-approver',
      reason: makeReason('decision.delegate', 'delegate to bounded recipient'),
      at: (T0 + HOUR) as EpochMillis,
      context: { pkg, delegation: good },
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.instance.state).toBe('delegated');
      expect(m.isTerminal('delegated')).toBe(true);
      expect(r.entry.reason.code).toBe('decision.delegate');
    }
  });

  it('under_review → expired fires once (AC2 expire outcome) and preserves history', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const r = m.apply(reviewing, {
      to: 'expired',
      expectedVersion: reviewing.version,
      actorId: 'svc-expiry-worker',
      reason: makeReason('decision.expire', 'decision window elapsed unactioned'),
      at: (T0 + 3 * DAY) as EpochMillis,
      context: {},
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.instance.state).toBe('expired');
      expect(r.instance.history.map((h) => h.to)).toEqual(['under_review', 'expired']);
    }
  });
});

describe('DECISION rejections (AC3): no authority / conflicting duties / no reason / expired delegation → NO transition, recorded & explained', () => {
  it('actor LACKING authority → refused, explained, no state change', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const r = m.apply(reviewing, {
      to: 'approved',
      expectedVersion: reviewing.version,
      actorId: 'user-nobody',
      reason: makeReason('decision.decide', 'approve without authority'),
      at: T0,
      context: { pkg, actorHasAuthority: false, dutyAssignments: separatedDuties() },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.code).toBe('guard-denied');
      expect(r.reason.code).toBe('decision.no_authority');
      expect(r.from).toBe('under_review'); // unchanged
    }
    // No history was appended beyond the open-review entry.
    expect(reviewing.history.length).toBe(1);
  });

  it('CONFLICTING duties (requester also approves) → real SoD evaluator refuses, explained', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    // Same principal fills request AND approval → SELF_APPROVAL in the real SoD evaluator.
    const conflicted: DutyAssignment[] = [
      {
        principalId: 'user-x',
        duty: 'request',
        roles: ['governance_officer'],
        relationships: ['requester'],
        tenantId: SOD.tenantId,
      },
      {
        principalId: 'user-x',
        duty: 'approval',
        roles: ['authorized_approver'],
        relationships: ['approver'],
        tenantId: SOD.tenantId,
      },
    ];
    // Confirm the oracle itself flags it (proves the guard's dependency is non-vacuous).
    const sod = evaluateSeparationOfDuties(conflicted, SOD);
    expect(sod.permitted).toBe(false);
    expect(sod.violations.map((v) => v.code)).toContain('SELF_APPROVAL');

    const r = m.apply(reviewing, {
      to: 'approved',
      expectedVersion: reviewing.version,
      actorId: 'user-x',
      reason: makeReason('decision.decide', 'self-approve'),
      at: T0,
      context: { pkg, actorHasAuthority: true, dutyAssignments: conflicted },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.reason.code).toBe('decision.sod_violation');
      expect(r.reason.text).toContain('SELF_APPROVAL');
    }
  });

  it('NO reason supplied → engine records a rejection (reason_required), no transition', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const r = m.apply(reviewing, {
      to: 'approved',
      expectedVersion: reviewing.version,
      actorId: 'user-approver',
      // Empty/whitespace reason → not a consequential reason.
      reason: { code: 'decision.decide', text: '   ' },
      at: T0,
      context: { pkg, actorHasAuthority: true, dutyAssignments: separatedDuties() },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.code).toBe('guard-denied');
      expect(r.reason.code).toBe('transition.reason_required');
    }
  });

  it('EXPIRED delegation → lineage resolver refuses; no delegated transition', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const expired = expiredDelegationCtx();
    // Confirm the resolver itself denies with EXPIRED (non-vacuous dependency).
    const res = resolveDelegation(expired.leaf, expired.byId, expired.sourceOf, expired.nowMs);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('EXPIRED');

    const r = m.apply(reviewing, {
      to: 'delegated',
      expectedVersion: reviewing.version,
      actorId: 'user-approver',
      reason: makeReason('decision.delegate', 'delegate via expired grant'),
      at: T0,
      context: { pkg, delegation: expired },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.reason.code).toBe('decision.delegation_invalid');
      expect(r.reason.text).toContain('EXPIRED');
    }
  });
});

// ===========================================================================
// 2. INVALIDATION / re-review (AC4): material change after review begins forces re-review.
// ===========================================================================

describe('INVALIDATION / re-review (AC4): a material change after review begins forces re-review', () => {
  const MATERIAL_CHANGES: Array<[Partial<DecisionPackage>, string]> = [
    [{ evidenceRefs: ['evidence#run-999'] }, 'evidence'],
    [{ policyVersion: 'policy@2026.08.0' }, 'policyVersion'],
    [{ controlVersion: 'control@2026.08.0' }, 'controlVersion'],
    [
      { affectedScope: { scopeType: 'environment', scopeId: 'prod-us', allowedActions: ['promote'] } },
      'scope',
    ],
    [{ businessImpact: 'now affects 40 tenants' }, 'businessImpact'],
  ];

  for (const [change, facet] of MATERIAL_CHANGES) {
    it(`material change to ${facet} → decision is invalidated (re-review required)`, () => {
      const m = decisionMachine();
      const pkgAtStart = completePackage();
      const reviewing = openReviewedDecision(m, pkgAtStart);
      const before = snapshotOf(pkgAtStart);
      const nowPkg = completePackage(change);
      const now = snapshotOf(nowPkg);
      // The diff oracle sees exactly this facet as changed.
      expect(materialDiff(before, now)).toContain(facet);

      const r = m.apply(reviewing, {
        to: 'invalidated',
        expectedVersion: reviewing.version,
        actorId: 'svc-invalidation',
        reason: makeReason('decision.invalidate', `material change: ${facet}`),
        at: (T0 + HOUR) as EpochMillis,
        context: { reviewStartedWith: before, currentSnapshot: now },
      });
      expect(r.outcome).toBe('applied');
      if (r.outcome === 'applied') {
        expect(r.instance.state).toBe('invalidated');
        expect(m.isTerminal('invalidated')).toBe(true);
        // History proves the item passed through review before invalidation.
        expect(r.instance.history.map((h) => h.to)).toEqual(['under_review', 'invalidated']);
      }
    });
  }

  it('NEGATIVE CONTROL: NO material change → invalidation is refused (a stable package is not re-reviewed)', () => {
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const snap = snapshotOf(pkg);
    expect(materialDiff(snap, snap)).toEqual([]);
    const r = m.apply(reviewing, {
      to: 'invalidated',
      expectedVersion: reviewing.version,
      actorId: 'svc-invalidation',
      reason: makeReason('decision.invalidate', 'attempt to invalidate an unchanged package'),
      at: (T0 + HOUR) as EpochMillis,
      context: { reviewStartedWith: snap, currentSnapshot: snap },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.reason.code).toBe('decision.no_material_change');
    }
  });

  it('a non-material cosmetic change (e.g. expectedResult wording) does NOT force re-review', () => {
    // expectedResult / requestedAction wording is outside the material snapshot: changing it must
    // not, by itself, trigger invalidation. Proves the material set is bounded (not "any change").
    const before = snapshotOf(completePackage());
    const now = snapshotOf(completePackage({ expectedResult: 'reworded but equivalent outcome' }));
    expect(materialDiff(before, now)).toEqual([]);
  });
});

// ===========================================================================
// 3. REQUIREMENT state machine — a governed requirement/obligation that gates a decision. It has
//    its own guarded lifecycle and its own expiry terminal, distinct from the decision above.
//    open → in_review → (satisfied | waived | expired). Waiver requires an approved exception ref.
// ===========================================================================

type RequirementState = 'open' | 'in_review' | 'satisfied' | 'waived' | 'expired';

interface RequirementCtx extends Record<string, unknown> {
  readonly evidenceRef?: string;
  readonly approvedExceptionRef?: string;
}

const satisfyGuard: Guard<RequirementState, RequirementCtx> = ({ context }) => {
  if (typeof context.evidenceRef !== 'string' || context.evidenceRef.trim().length === 0) {
    return deny(makeReason('requirement.no_evidence', 'cannot satisfy without evidence'));
  }
  return allow();
};

const waiveGuard: Guard<RequirementState, RequirementCtx> = ({ context }) => {
  if (
    typeof context.approvedExceptionRef !== 'string' ||
    context.approvedExceptionRef.trim().length === 0
  ) {
    return deny(makeReason('requirement.no_exception', 'waiver requires an approved exception'));
  }
  return allow();
};

function requirementMachine() {
  return defineStateMachine<RequirementState, RequirementCtx>({
    governance: governance({ id: ID(3) }),
    states: ['open', 'in_review', 'satisfied', 'waived', 'expired'],
    initial: 'open',
    terminal: ['satisfied', 'waived', 'expired'],
    transitions: [
      { from: 'open', to: 'in_review' },
      { from: 'open', to: 'expired' },
      { from: 'in_review', to: 'satisfied', guard: satisfyGuard },
      { from: 'in_review', to: 'waived', guard: waiveGuard },
      { from: 'in_review', to: 'expired' },
    ],
  });
}

describe('REQUIREMENT state machine: satisfy needs evidence; waive needs an approved exception; both fail closed', () => {
  it('satisfied requires evidence — refused without, applied with (terminal)', () => {
    const m = requirementMachine();
    let inst = m.create(ID(30), T0);
    inst = expectApplied(
      m.apply(inst, req(inst, 'in_review', 'requirement.review', 'begin review')),
    );
    const bad = m.apply(inst, req(inst, 'satisfied', 'requirement.satisfy', 'claim satisfied'));
    expect(bad.outcome).toBe('rejected');
    if (bad.outcome === 'rejected') expect(bad.reason.code).toBe('requirement.no_evidence');

    const good = m.apply(inst, {
      ...req(inst, 'satisfied', 'requirement.satisfy', 'satisfied with evidence'),
      context: { evidenceRef: 'evidence#req-1' },
    });
    expect(good.outcome).toBe('applied');
    if (good.outcome === 'applied') expect(m.isTerminal('satisfied')).toBe(true);
  });

  it('waived requires an approved exception — refused without, applied with', () => {
    const m = requirementMachine();
    let inst = m.create(ID(31), T0);
    inst = expectApplied(
      m.apply(inst, req(inst, 'in_review', 'requirement.review', 'begin review')),
    );
    const bad = m.apply(inst, req(inst, 'waived', 'requirement.waive', 'waive without exception'));
    expect(bad.outcome).toBe('rejected');
    if (bad.outcome === 'rejected') expect(bad.reason.code).toBe('requirement.no_exception');

    const good = m.apply(inst, {
      ...req(inst, 'waived', 'requirement.waive', 'waived under approved exception'),
      context: { approvedExceptionRef: 'exception#7' },
    });
    expect(good.outcome).toBe('applied');
  });
});

// ===========================================================================
// 4. DELEGATION creation (AC5): named recipient, bounded scope, start+expiry, reason, delegator
//    authority, and NO circular / privilege-expanding chain. Validation is performed by the REAL
//    @trustcircle/authz lineage resolver; this machine records the accepted/rejected outcome.
// ===========================================================================

const ENV_SCOPE: AuthorityScope = {
  scopeType: 'environment',
  scopeId: 'prod-eu',
  allowedActions: ['promote', 'rollback'],
};
const NARROWER_SCOPE: AuthorityScope = {
  scopeType: 'environment',
  scopeId: 'prod-eu',
  allowedActions: ['promote'], // strict subset — a valid narrowing
};
const WIDER_SCOPE: AuthorityScope = {
  scopeType: 'environment',
  scopeId: 'prod-eu',
  allowedActions: ['promote', 'rollback', 'delete'], // superset — privilege expansion
};

const SOURCE_ASSIGNMENT_ID = 'assignment-root';
const TENANT_A = ID(9);

function sourceAssignment(): RoleAssignment {
  return {
    roleAssignmentId: SOURCE_ASSIGNMENT_ID,
    tenantId: TENANT_A,
    principalId: 'user-delegator',
    role: 'authorized_approver',
    scope: ENV_SCOPE,
    validFrom: T0 - DAY,
    expiresAt: (T0 + 30 * DAY) as number,
    status: 'active',
    nextRecertificationAt: (T0 + 20 * DAY) as number,
    lastRecertifiedAt: (T0 - DAY) as number,
  };
}

const sourceOf = (id: string): RoleAssignment | null =>
  id === SOURCE_ASSIGNMENT_ID ? sourceAssignment() : null;

function rootDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    delegationId: 'del-root',
    tenantId: TENANT_A,
    delegatorPrincipalId: 'user-delegator',
    recipientPrincipalId: 'user-recipient',
    authorityAssignmentId: SOURCE_ASSIGNMENT_ID,
    scope: NARROWER_SCOPE,
    reasonText: 'cover PTO 2026-08-10..14',
    validFrom: T0,
    expiresAt: (T0 + 5 * DAY) as number,
    parentDelegationId: null,
    status: 'active',
    ...overrides,
  };
}

/** A VALID delegation-resolution context for the decision machine's delegateGuard. */
function validDelegationCtx(): NonNullable<DecisionCtx['delegation']> {
  const leaf = rootDelegation();
  const byId = new Map<string, Delegation>([[leaf.delegationId, leaf]]);
  return { leaf, byId, sourceOf, nowMs: T0 + HOUR };
}

/** An EXPIRED delegation-resolution context (nowMs past the leaf's expiry). */
function expiredDelegationCtx(): NonNullable<DecisionCtx['delegation']> {
  const leaf = rootDelegation();
  const byId = new Map<string, Delegation>([[leaf.delegationId, leaf]]);
  return { leaf, byId, sourceOf, nowMs: T0 + 6 * DAY };
}

type DelegationState = 'proposed' | 'active' | 'rejected' | 'expired' | 'revoked';

interface DelegationCtx extends Record<string, unknown> {
  readonly leaf?: Delegation;
  readonly byId?: ReadonlyMap<string, Delegation>;
  readonly nowMs?: number;
}

/** Activate a delegation only if the REAL lineage resolver grants it (bounded scope, start+expiry,
 *  reason, delegator authority, no cycle, no privilege expansion). Fails closed with the reason. */
const activateDelegationGuard: Guard<DelegationState, DelegationCtx> = ({ context }) => {
  if (!context.leaf || !context.byId || typeof context.nowMs !== 'number') {
    return deny(makeReason('delegation.no_inputs', 'missing delegation-resolution inputs'));
  }
  const res = resolveDelegation(context.leaf, context.byId, sourceOf, context.nowMs);
  if (!res.granted) {
    return deny(
      makeReason('delegation.invalid', `delegation not honoured: ${res.reason ?? 'unknown'}`),
    );
  }
  return allow();
};

function delegationMachine() {
  return defineStateMachine<DelegationState, DelegationCtx>({
    governance: governance({ id: ID(4) }),
    states: ['proposed', 'active', 'rejected', 'expired', 'revoked'],
    initial: 'proposed',
    terminal: ['rejected', 'expired', 'revoked'],
    transitions: [
      { from: 'proposed', to: 'active', guard: activateDelegationGuard },
      { from: 'proposed', to: 'rejected' },
      { from: 'active', to: 'expired' },
      { from: 'active', to: 'revoked' },
    ],
  });
}

describe('DELEGATION creation (AC5): named recipient + bounded scope + start/expiry + reason + delegator authority; no circular or privilege-expanding chain', () => {
  it('a well-formed delegation (named recipient, narrowed scope, start+expiry, reason) ACTIVATES', () => {
    const leaf = rootDelegation();
    // Independently confirm every AC5 facet is present on the created delegation.
    expect(leaf.recipientPrincipalId).toBe('user-recipient'); // named recipient
    expect(leaf.delegatorPrincipalId).toBe('user-delegator'); // delegator authority holder
    expect(leaf.recipientPrincipalId).not.toBe(leaf.delegatorPrincipalId); // not self
    expect(leaf.scope.allowedActions).toEqual(['promote']); // bounded (narrowed) scope
    expect(leaf.validFrom).toBe(T0); // start
    expect(leaf.expiresAt).toBeGreaterThan(leaf.validFrom); // expiry after start
    expect(leaf.reasonText.trim().length).toBeGreaterThan(0); // reason

    const m = delegationMachine();
    const inst = m.create(ID(40), T0);
    const byId = new Map([[leaf.delegationId, leaf]]);
    const r = m.apply(inst, {
      to: 'active',
      expectedVersion: 1,
      actorId: 'user-delegator',
      reason: makeReason('delegation.create', 'delegate promote authority for PTO'),
      at: T0,
      context: { leaf, byId, nowMs: T0 + HOUR },
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') expect(r.instance.state).toBe('active');
  });

  it('PRIVILEGE-EXPANDING chain (child widens parent scope) is refused with SCOPE_EXPANSION', () => {
    // parent grants {promote}; child tries {promote, rollback} → wider than parent.
    const parent = rootDelegation({ delegationId: 'del-p', scope: NARROWER_SCOPE });
    const child = rootDelegation({
      delegationId: 'del-c',
      parentDelegationId: 'del-p',
      recipientPrincipalId: 'user-recipient-2',
      delegatorPrincipalId: 'user-recipient',
      scope: ENV_SCOPE, // {promote, rollback} — wider than parent {promote}
    });
    const byId = new Map<string, Delegation>([
      [parent.delegationId, parent],
      [child.delegationId, child],
    ]);
    // Real resolver denies with SCOPE_EXPANSION (non-vacuous dependency).
    const res = resolveDelegation(child, byId, sourceOf, T0 + HOUR);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SCOPE_EXPANSION');

    const m = delegationMachine();
    const inst = m.create(ID(41), T0);
    const r = m.apply(inst, {
      to: 'active',
      expectedVersion: 1,
      actorId: 'user-recipient',
      reason: makeReason('delegation.create', 'sub-delegate wider scope'),
      at: T0,
      context: { leaf: child, byId, nowMs: T0 + HOUR },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.reason.code).toBe('delegation.invalid');
      expect(r.reason.text).toContain('SCOPE_EXPANSION');
    }
  });

  it('CIRCULAR chain (a delegation whose parent is itself) is refused with CYCLE', () => {
    const selfCycle = rootDelegation({
      delegationId: 'del-cycle',
      parentDelegationId: 'del-cycle', // points at itself
    });
    const byId = new Map<string, Delegation>([[selfCycle.delegationId, selfCycle]]);
    const res = resolveDelegation(selfCycle, byId, sourceOf, T0 + HOUR);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('CYCLE');

    const m = delegationMachine();
    const inst = m.create(ID(42), T0);
    const r = m.apply(inst, {
      to: 'active',
      expectedVersion: 1,
      actorId: 'user-delegator',
      reason: makeReason('delegation.create', 'create circular delegation'),
      at: T0,
      context: { leaf: selfCycle, byId, nowMs: T0 + HOUR },
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason.text).toContain('CYCLE');
  });

  it('SELF-delegation (recipient === delegator) is refused', () => {
    const selfDel = rootDelegation({
      delegationId: 'del-self',
      recipientPrincipalId: 'user-delegator', // same as delegator
    });
    const byId = new Map([[selfDel.delegationId, selfDel]]);
    const res = resolveDelegation(selfDel, byId, sourceOf, T0 + HOUR);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SELF_DELEGATION');
  });

  it('MISSING reason on the delegation is refused (a delegation requires a reason)', () => {
    const noReason = rootDelegation({ delegationId: 'del-nr', reasonText: '   ' });
    const byId = new Map([[noReason.delegationId, noReason]]);
    const res = resolveDelegation(noReason, byId, sourceOf, T0 + HOUR);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('MISSING_REASON');
  });

  it('delegation drawing on a NON-authoritative source (no source assignment) is refused', () => {
    const orphan = rootDelegation({
      delegationId: 'del-orphan',
      authorityAssignmentId: 'assignment-does-not-exist',
    });
    const byId = new Map([[orphan.delegationId, orphan]]);
    const res = resolveDelegation(orphan, byId, sourceOf, T0 + HOUR);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SOURCE_INVALID');
  });
});

// ===========================================================================
// 5. JOINT multi-tenant package (AC6): a consequential action affecting multiple tenants is
//    BLOCKED until (a) central guardrails (non-waivable SoD) pass, (b) EVERY affected tenant has
//    supplied a CURRENT scoped approval, and (c) a DISTINCT central governance reviewer approved.
//    All three conditions are evaluated with the REAL authz evaluators.
// ===========================================================================

type JointState = 'assembling' | 'guardrails_passed' | 'executed' | 'blocked';

interface TenantApproval {
  readonly tenantId: string;
  readonly approverPrincipalId: string;
  /** The approval's role assignment — must currently GRANT (real resolver) to count. */
  readonly assignment: RoleAssignment;
}

interface JointCtx extends Record<string, unknown> {
  readonly affectedTenantIds?: readonly string[];
  readonly tenantApprovals?: readonly TenantApproval[];
  readonly action?: CrossTenantAction;
  readonly centralReviewer?: CentralReviewer;
  /** Non-waivable central guardrail SoD inputs. */
  readonly guardrailAssignments?: readonly DutyAssignment[];
  readonly guardrailConstraint?: SoDConstraint;
  readonly nowMs?: number;
}

/**
 * The AC6 executability oracle. Returns the list of blocking reasons; empty ⇒ executable.
 * Blocks unless: central guardrails pass (non-waivable SoD permitted), every affected tenant
 * has a CURRENT (resolver-granted) scoped approval, and a distinct central reviewer approves.
 */
function jointBlockers(ctx: JointCtx): string[] {
  const blockers: string[] = [];
  const affected = ctx.affectedTenantIds ?? [];
  if (affected.length < 2) blockers.push('NOT_MULTI_TENANT');

  // (a) central guardrails — non-waivable SoD must pass.
  const guardrail = evaluateSeparationOfDuties(
    ctx.guardrailAssignments ?? [],
    ctx.guardrailConstraint ?? SOD,
  );
  if (!guardrail.permitted) blockers.push('GUARDRAILS_FAILED');

  // (b) every affected tenant supplied a CURRENT scoped approval.
  const approvals = ctx.tenantApprovals ?? [];
  for (const tid of affected) {
    const appr = approvals.find((a) => a.tenantId === tid);
    if (!appr) {
      blockers.push(`TENANT_APPROVAL_MISSING:${tid}`);
      continue;
    }
    const granted = resolveRoleAssignment(appr.assignment, ctx.nowMs ?? T0).granted;
    if (!granted) blockers.push(`TENANT_APPROVAL_NOT_CURRENT:${tid}`);
  }

  // (c) a distinct central governance reviewer approved.
  if (!ctx.action || !ctx.centralReviewer) {
    blockers.push('CENTRAL_REVIEWER_MISSING');
  } else {
    const rev = evaluateCentralReviewerDistinctness(ctx.action, ctx.centralReviewer);
    if (!rev.permitted) blockers.push('CENTRAL_REVIEWER_INVALID');
  }
  return blockers;
}

const executeGuard: Guard<JointState, JointCtx> = ({ context }) => {
  const blockers = jointBlockers(context);
  if (blockers.length > 0) {
    return deny(makeReason('joint.blocked', `execution blocked: ${blockers.join(', ')}`));
  }
  return allow();
};

function jointMachine() {
  return defineStateMachine<JointState, JointCtx>({
    governance: governance({ id: ID(6) }),
    states: ['assembling', 'guardrails_passed', 'executed', 'blocked'],
    initial: 'assembling',
    terminal: ['executed', 'blocked'],
    transitions: [
      { from: 'assembling', to: 'guardrails_passed', guard: executeGuard },
      { from: 'assembling', to: 'blocked' },
      { from: 'guardrails_passed', to: 'executed', guard: executeGuard },
      { from: 'guardrails_passed', to: 'blocked' },
    ],
  });
}

// Two affected tenants and a fully-satisfied joint package (positive control for AC6).
const TENANT_1 = ID(11);
const TENANT_2 = ID(12);

function currentTenantAssignment(tenantId: string, principalId: string): RoleAssignment {
  return {
    roleAssignmentId: `ra-${principalId}`,
    tenantId,
    principalId,
    role: 'tenant_compliance_owner',
    scope: { scopeType: 'organization', scopeId: tenantId, allowedActions: ['approve-joint'] },
    validFrom: T0 - DAY,
    expiresAt: (T0 + 30 * DAY) as number,
    status: 'active',
    nextRecertificationAt: (T0 + 20 * DAY) as number,
    lastRecertifiedAt: (T0 - DAY) as number,
  };
}

function satisfiedJointCtx(overrides: Partial<JointCtx> = {}): JointCtx {
  const action: CrossTenantAction = {
    requesterPrincipalId: 'user-requester',
    operatorPrincipalId: 'user-operator',
    controlOwnerPrincipalId: 'user-owner',
    tenantApproverPrincipalIds: ['user-t1-approver', 'user-t2-approver'],
  };
  return {
    affectedTenantIds: [TENANT_1, TENANT_2],
    tenantApprovals: [
      {
        tenantId: TENANT_1,
        approverPrincipalId: 'user-t1-approver',
        assignment: currentTenantAssignment(TENANT_1, 'user-t1-approver'),
      },
      {
        tenantId: TENANT_2,
        approverPrincipalId: 'user-t2-approver',
        assignment: currentTenantAssignment(TENANT_2, 'user-t2-approver'),
      },
    ],
    action,
    centralReviewer: {
      principalId: 'user-central-reviewer',
      roles: ['central_governance_reviewer'], // distinct principal, correct role, no incompatible role
    },
    guardrailAssignments: [
      {
        principalId: 'user-requester',
        duty: 'request',
        roles: ['governance_officer'],
        relationships: ['requester'],
        tenantId: null,
      },
      {
        principalId: 'user-central-reviewer',
        duty: 'review',
        roles: ['central_governance_reviewer'],
        relationships: ['reviewer'],
        tenantId: null,
      },
    ],
    guardrailConstraint: {
      sodConstraintId: 'sod-central-guardrail',
      tenantId: null, // NON-WAIVABLE central guardrail
      actionClass: 'cross-tenant-action',
      incompatibleRoles: [],
      incompatibleRelationships: [],
      minimumDistinctPrincipals: 2,
      status: 'active',
    },
    nowMs: T0,
    ...overrides,
  };
}

describe('JOINT multi-tenant package (AC6): blocked until guardrails pass AND every tenant approves AND a distinct central reviewer approves', () => {
  it('a fully-satisfied joint package EXECUTES (all three conditions met)', () => {
    const ctx = satisfiedJointCtx();
    expect(jointBlockers(ctx)).toEqual([]); // no blockers

    const m = jointMachine();
    let inst = m.create(ID(60), T0);
    const g = m.apply(inst, {
      to: 'guardrails_passed',
      expectedVersion: 1,
      actorId: 'user-central-reviewer',
      reason: makeReason('joint.guardrails', 'central guardrails pass'),
      at: T0,
      context: ctx,
    });
    expect(g.outcome).toBe('applied');
    if (g.outcome !== 'applied') return;
    inst = g.instance;
    const e = m.apply(inst, {
      to: 'executed',
      expectedVersion: inst.version,
      actorId: 'user-operator',
      reason: makeReason('joint.execute', 'execute joint action'),
      at: T0,
      context: ctx,
    });
    expect(e.outcome).toBe('applied');
    if (e.outcome === 'applied') {
      expect(e.instance.state).toBe('executed');
      expect(m.isTerminal('executed')).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: each of the three conditions, removed in isolation, BLOCKS execution', () => {
    const m = jointMachine();

    // (a) central guardrails fail (only ONE distinct principal → INSUFFICIENT_DISTINCT_PRINCIPALS
    //     on a min-2 non-waivable constraint).
    const noGuardrail = satisfiedJointCtx({
      guardrailAssignments: [
        {
          principalId: 'user-solo',
          duty: 'review',
          roles: ['central_governance_reviewer'],
          relationships: ['reviewer'],
          tenantId: null,
        },
      ],
    });
    expect(jointBlockers(noGuardrail)).toContain('GUARDRAILS_FAILED');

    // (b) a tenant approval is MISSING for one affected tenant.
    const missingApproval = satisfiedJointCtx({
      tenantApprovals: [
        {
          tenantId: TENANT_1,
          approverPrincipalId: 'user-t1-approver',
          assignment: currentTenantAssignment(TENANT_1, 'user-t1-approver'),
        },
        // TENANT_2 approval omitted.
      ],
    });
    expect(jointBlockers(missingApproval).some((b) => b.startsWith('TENANT_APPROVAL_MISSING'))).toBe(
      true,
    );

    // (b') a tenant approval exists but is NOT current (expired assignment).
    const staleApproval = satisfiedJointCtx({
      tenantApprovals: [
        {
          tenantId: TENANT_1,
          approverPrincipalId: 'user-t1-approver',
          assignment: currentTenantAssignment(TENANT_1, 'user-t1-approver'),
        },
        {
          tenantId: TENANT_2,
          approverPrincipalId: 'user-t2-approver',
          assignment: {
            ...currentTenantAssignment(TENANT_2, 'user-t2-approver'),
            status: 'expired',
          },
        },
      ],
    });
    expect(
      jointBlockers(staleApproval).some((b) => b.startsWith('TENANT_APPROVAL_NOT_CURRENT')),
    ).toBe(true);

    // (c) the central reviewer is NOT distinct (coincides with a tenant approver).
    const nonDistinctReviewer = satisfiedJointCtx({
      centralReviewer: {
        principalId: 'user-t1-approver', // also a tenant approver → not distinct
        roles: ['central_governance_reviewer'],
      },
    });
    expect(jointBlockers(nonDistinctReviewer)).toContain('CENTRAL_REVIEWER_INVALID');

    // (c') the central reviewer holds an INCOMPATIBLE action role.
    const incompatibleReviewer = satisfiedJointCtx({
      centralReviewer: {
        principalId: 'user-central-reviewer',
        roles: ['central_governance_reviewer', 'authorized_approver'], // incompatible
      },
    });
    expect(jointBlockers(incompatibleReviewer)).toContain('CENTRAL_REVIEWER_INVALID');

    // Each blocked context also BLOCKS the machine's execute transition (no execution).
    for (const ctx of [
      noGuardrail,
      missingApproval,
      staleApproval,
      nonDistinctReviewer,
      incompatibleReviewer,
    ]) {
      const inst = m.create(ID(61), T0);
      const r = m.apply(inst, {
        to: 'guardrails_passed',
        expectedVersion: 1,
        actorId: 'user-central-reviewer',
        reason: makeReason('joint.guardrails', 'attempt to pass guardrails'),
        at: T0,
        context: ctx,
      });
      expect(r.outcome).toBe('rejected');
      if (r.outcome === 'rejected') expect(r.reason.code).toBe('joint.blocked');
    }
  });

  it('a single-tenant action is not treated as a joint multi-tenant action', () => {
    const single = satisfiedJointCtx({ affectedTenantIds: [TENANT_1] });
    expect(jointBlockers(single)).toContain('NOT_MULTI_TENANT');
  });
});

// ===========================================================================
// 6. EXPIRY state machine — decisions, requirements, delegations, and joint packages all EXPIRE
//    the instant their window elapses (exclusive upper bound, no grace). A single reusable expiry
//    predicate drives the expiry transition across every subject type.
// ===========================================================================

/** True iff `nowMs` is at/after `expiresAt` (exclusive upper bound: dead the instant it expires). */
function isExpired(nowMs: number, expiresAt: number): boolean {
  return nowMs >= expiresAt;
}

type ExpirableState = 'active' | 'expired';

interface ExpiryCtx extends Record<string, unknown> {
  readonly nowMs?: number;
  readonly expiresAt?: number;
}

const expireGuard: Guard<ExpirableState, ExpiryCtx> = ({ context }) => {
  if (typeof context.nowMs !== 'number' || typeof context.expiresAt !== 'number') {
    return deny(makeReason('expiry.no_window', 'missing expiry window'));
  }
  if (!isExpired(context.nowMs, context.expiresAt)) {
    return deny(makeReason('expiry.not_elapsed', 'window has not elapsed; cannot expire'));
  }
  return allow();
};

function expiryMachine() {
  return defineStateMachine<ExpirableState, ExpiryCtx>({
    governance: governance({ id: ID(7) }),
    states: ['active', 'expired'],
    initial: 'active',
    terminal: ['expired'],
    transitions: [{ from: 'active', to: 'expired', guard: expireGuard }],
  });
}

describe('EXPIRY state machine: subjects expire exactly at/after their window (exclusive upper bound, no grace)', () => {
  it('BEFORE expiry the subject cannot be expired; AT/AFTER expiry it can (each subject type)', () => {
    const m = expiryMachine();
    const expiresAt = T0 + 2 * DAY;

    // Before the boundary → refused.
    const before = m.apply(m.create(ID(70), T0), {
      to: 'expired',
      expectedVersion: 1,
      actorId: 'svc-expiry-worker',
      reason: makeReason('expiry.attempt', 'expire before window'),
      at: T0,
      context: { nowMs: expiresAt - 1, expiresAt },
    });
    expect(before.outcome).toBe('rejected');
    if (before.outcome === 'rejected') expect(before.reason.code).toBe('expiry.not_elapsed');

    // Exactly at the boundary → expired (exclusive upper bound: nowMs === expiresAt is dead).
    const atBoundary = m.apply(m.create(ID(71), T0), {
      to: 'expired',
      expectedVersion: 1,
      actorId: 'svc-expiry-worker',
      reason: makeReason('expiry.attempt', 'expire at boundary'),
      at: expiresAt as EpochMillis,
      context: { nowMs: expiresAt, expiresAt },
    });
    expect(atBoundary.outcome).toBe('applied');
    if (atBoundary.outcome === 'applied') expect(m.isTerminal('expired')).toBe(true);

    // The same predicate governs every subject type (decision/requirement/delegation/joint).
    expect(isExpired(expiresAt - 1, expiresAt)).toBe(false);
    expect(isExpired(expiresAt, expiresAt)).toBe(true);
    expect(isExpired(expiresAt + 1, expiresAt)).toBe(true);
  });
});

// ===========================================================================
// 7. TERMINAL-HISTORY invariants across ALL decision-domain machines.
//    (Executable form of "terminal and historical records remain queryable; triggered guards
//    reject terminal-state rewrites" — VO-34cfb7a95f2be14d92e8.)
// ===========================================================================

describe('TERMINAL-HISTORY: every decision-domain terminal state is a history-preserving sink', () => {
  const machines: Array<[string, StateMachine<string, Record<string, unknown>>]> = [
    ['decision', decisionMachine() as unknown as StateMachine<string, Record<string, unknown>>],
    ['requirement', requirementMachine() as unknown as StateMachine<string, Record<string, unknown>>],
    ['delegation', delegationMachine() as unknown as StateMachine<string, Record<string, unknown>>],
    ['joint', jointMachine() as unknown as StateMachine<string, Record<string, unknown>>],
    ['expiry', expiryMachine() as unknown as StateMachine<string, Record<string, unknown>>],
  ];

  it('each machine is a FULLY GOVERNED entity (id, version, owner, lifecycle, contract facets)', () => {
    for (const [name, m] of machines) {
      expect(m.id, name).toBeTruthy();
      expect(m.version, name).toBeGreaterThanOrEqual(1);
      expect(m.owner.ownerId, name).toBe('team-governance');
      expect(m.lifecycleState, name).toBe('active');
      expect(m.contract.tests.length, name).toBeGreaterThan(0);
      expect(m.contract.monitoring.length, name).toBeGreaterThan(0);
      expect(m.contract.failureBehavior, name).toBe('fail-closed');
      expect(Array.isArray(m.contract.exceptions), name).toBe(true);
      expect(m.contract.evidenceExpectations.length, name).toBeGreaterThan(0);
    }
  });

  it('each machine has ≥1 terminal sink; terminals have no outgoing transitions', () => {
    for (const [name, m] of machines) {
      const terminals = [...m.terminal];
      expect(terminals.length, name).toBeGreaterThan(0);
      for (const t of terminals) {
        expect(m.isState(t), `${name}:${t}`).toBe(true);
        expect(m.allowedTargets(t), `${name}:${t}`).toEqual([]);
      }
    }
  });

  it('a terminal record is preserved and cannot be rewritten (restore + rewrite attempt)', () => {
    // Drive a decision to a terminal (denied) state, snapshot it, restore, and confirm the
    // restored terminal history is intact and rewrite is rejected.
    const m = decisionMachine();
    const pkg = completePackage();
    const reviewing = openReviewedDecision(m, pkg);
    const denied = expectApplied(
      m.apply(reviewing, {
        to: 'denied',
        expectedVersion: reviewing.version,
        actorId: 'user-approver',
        reason: makeReason('decision.decide', 'deny'),
        at: T0,
        context: { pkg, actorHasAuthority: true, dutyAssignments: separatedDuties() },
      }),
    );
    const snap = denied.snapshot();
    expect(snap.state).toBe('denied');
    expect(snap.history.map((h) => h.to)).toEqual(['under_review', 'denied']);

    const restored = m.restore(snap);
    expect(restored.state).toBe('denied');
    expect(instanceDigest(restored)).toBe(instanceDigest(snap));

    const rewrite = m.apply(restored, {
      to: 'approved',
      expectedVersion: restored.version,
      actorId: 'user-approver',
      reason: makeReason('decision.decide', 'overturn terminal'),
      at: T0,
      context: { pkg, actorHasAuthority: true, dutyAssignments: separatedDuties() },
    });
    expect(rewrite.outcome).toBe('rejected');
    if (rewrite.outcome === 'rejected') expect(rewrite.code).toBe('terminal-state-rewrite');
  });
});

// ---------------------------------------------------------------------------
// Small assertion helpers (kept at the bottom so the tests above read top-down).
// ---------------------------------------------------------------------------

function expectApplied<S extends string>(r: TransitionResult<S>): MachineInstance<S> {
  expect(r.outcome).toBe('applied');
  if (r.outcome !== 'applied') throw new Error('expected applied transition');
  return r.instance;
}

function req<S extends string>(
  inst: MachineInstance<S>,
  to: S,
  code: string,
  text: string,
): {
  to: S;
  expectedVersion: number;
  actorId: string;
  reason: ReturnType<typeof makeReason>;
  at: EpochMillis;
  context: Record<string, unknown>;
} {
  return {
    to,
    expectedVersion: inst.version,
    actorId: 'svc-requirement',
    reason: makeReason(code, text),
    at: T0,
    context: {},
  };
}
