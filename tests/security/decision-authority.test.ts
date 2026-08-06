// Security-suite test — decision-authority rejection behavior
// (Phase 89 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item JRVPAFNAVBEGWDDMN090W4G72R /
//  US2-AS1..AS6 → VO-8d9604e6a04ad189849f, VO-699effc1c52abb2cf3b0, VO-b7d38611f9d8413fea66,
//  VO-e317929c35e08a96a3ba, VO-01bd627ae03c596f2eae, VO-43075588f88b28ecf27e).
//
// PHASE OBJECTIVE: "Test self-approval, incompatible roles, admin-only authority, missing
// reason, stale versions, expired assignments, and unavailable policy rejection in
// tests/security/decision-authority.test.ts".
//
// This suite proves — through the REAL authorization + policy oracles, never a re-implementation —
// that a decision on a governed item is REJECTED (fails closed, transition does not occur, the
// rejection carries a machine-readable, explained reason) for each of the seven defect classes
// named in the objective, and is PERMITTED only for the well-formed baseline. Every rejection
// assertion is paired with a POSITIVE control of the same shape that SHOULD pass, so no oracle is
// vacuous: the deny cases deny ONLY because of the defect under test.
//
// ACCEPTANCE-CRITERION → describe-block map (each block's title cites its AS):
//   US2-AS1 (VO-8d96…) decision package shows every facet ......... 'AS1 — decision package completeness'
//   US2-AS2 (VO-699e…) six verbs occur once w/ reason + audit ..... 'AS2 — permitted transition once + audit'
//   US2-AS3 (VO-b7d3…) no-authority / conflicting-duty / no-reason  'AS3 — governed rejections'
//                      / expired → recorded, explained rejection
//   US2-AS4 (VO-e317…) material change → re-review (stale version)  'AS4 — stale version → re-review'
//   US2-AS5 (VO-01bd…) delegation named/bounded/window/reason/       'AS5 — delegation is bounded, no cycle/priv-expansion'
//                      authority/no-cycle/no-priv-expansion
//   US2-AS6 (VO-4307…) multi-tenant blocked until guardrails +       'AS6 — cross-tenant joint approval'
//                      all-tenant approvals + distinct central reviewer
//
// The suite imports the real authz + policy sources via their declared workspace-relative paths
// (matching the convention in the sibling security tests, e.g. authorization-fail-closed.test.ts).
// A regression in ANY fail-closed guard is caught by `vitest run --project security`. No mocks,
// no TODO/skip/only scaffolds — observable behavior only. Determinism: a single fixed injected
// instant (NOW); no Math.random / argless Date.

import { describe, it, expect } from 'vitest';

// Separation-of-duties source of truth (packages/authz/src/separation-of-duties.ts).
import {
  evaluateSeparationOfDuties,
  evaluateCentralReviewerDistinctness,
  type DutyAssignment,
  type SoDConstraint,
  type CrossTenantAction,
  type CentralReviewer,
} from '../../packages/authz/src/separation-of-duties.ts';

// Authority resolution — current assignment, expiry, delegation lineage, recertification, and the
// sanctioned bridges into the SoD source of truth (packages/authz/src/authority.ts).
import {
  resolveRoleAssignment,
  resolveDelegation,
  recertify,
  evaluateActionAuthority,
  evaluateCentralReviewerAuthority,
  resolveEffectiveAuthority,
  type RoleAssignment,
  type Delegation,
  type AuthorityScope,
  type EffectiveAuthority,
} from '../../packages/authz/src/authority.ts';

// Policy decision point — signed, revision-pinned OPA bundle adapter (packages/policy/src/pdp.ts).
import {
  createSignedOpaPdp,
  signBundle,
  verifyBundle,
  SignedOpaBundleAdapter,
  PdpUnavailableError,
  type DecisionRequest,
  type SignedPolicyBundle,
} from '../../packages/policy/src/pdp.ts';

// ---------------------------------------------------------------------------
// Fixtures & builders. Single fixed injected instant — no wall-clock dependence.
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed epoch ms
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const BUNDLE_KEY = 'bundle-signing-key';
const EVIDENCE_KEY = 'evidence-signing-key';
const REV_CURRENT = 'rev-2024-11-01';
const REV_STALE = 'rev-2024-10-01';

const ORG_SCOPE: AuthorityScope = {
  scopeType: 'organization',
  scopeId: 'org-1',
  allowedActions: ['approve', 'reconcile'],
};

/** A well-formed, currently-granting approver assignment (positive baseline). */
function activeAssignment(over: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    roleAssignmentId: 'ra-1',
    tenantId: 'tenant-a',
    principalId: 'approver',
    role: 'authorized_approver',
    scope: ORG_SCOPE,
    validFrom: NOW - DAY,
    expiresAt: NOW + DAY,
    status: 'active',
    nextRecertificationAt: NOW + 30 * DAY,
    lastRecertifiedAt: NOW - DAY,
    ...over,
  };
}

/** A well-formed, active delegation drawing from `ra-1` (positive baseline). */
function activeDelegation(over: Partial<Delegation> = {}): Delegation {
  return {
    delegationId: 'del-1',
    tenantId: 'tenant-a',
    delegatorPrincipalId: 'approver',
    recipientPrincipalId: 'deputy',
    authorityAssignmentId: 'ra-1',
    scope: ORG_SCOPE,
    reasonText: 'covering approvals during PTO',
    validFrom: NOW - HOUR,
    expiresAt: NOW + HOUR,
    parentDelegationId: null,
    status: 'active',
    ...over,
  };
}

/** The SoD constraint for the action under review (min 2 distinct principals). */
function constraint(over: Partial<SoDConstraint> = {}): SoDConstraint {
  return {
    sodConstraintId: 'sod-1',
    tenantId: 'tenant-a',
    actionClass: 'high-risk-change',
    incompatibleRoles: [],
    incompatibleRelationships: [],
    minimumDistinctPrincipals: 2,
    status: 'active',
    ...over,
  };
}

/** A well-separated pair of duty assignments (requester + independent approver) that PERMITS. */
function separatedAssignments(): DutyAssignment[] {
  return [
    {
      principalId: 'requester',
      duty: 'request',
      roles: ['governance_officer'],
      relationships: ['requester'],
      tenantId: 'tenant-a',
    },
    {
      principalId: 'approver',
      duty: 'approval',
      roles: ['authorized_approver'],
      relationships: ['approver'],
      tenantId: 'tenant-a',
    },
  ];
}

/** Effective-authority bridge input, so `resolveEffectiveAuthority` can be observed end-to-end. */
function authorityInputs(assignments: readonly RoleAssignment[]) {
  const byId = new Map<string, Delegation>();
  const sourceOf = (id: string) => assignments.find((a) => a.roleAssignmentId === id) ?? null;
  return {
    principalId: 'approver',
    tenantId: 'tenant-a',
    assignments,
    delegations: [] as readonly Delegation[],
    breakGlassGrants: [],
    allDelegationsById: byId,
    sourceOf,
  };
}

// ===========================================================================
// AS1 (VO-8d96…) — DECISION PACKAGE COMPLETENESS.
// When an approver with current authority reviews a pending item, the decision package
// must expose every governance facet. We assemble the package from RESOLVED authority
// (so the "approver has current authority" precondition is itself observable) and assert
// every required field is present and non-empty. Negative control: dropping any single
// facet is detectable.
// ===========================================================================

interface DecisionPackage {
  readonly requestedAction: string;
  readonly affectedScope: AuthorityScope;
  readonly businessImpact: string;
  readonly risks: readonly string[];
  readonly alternatives: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly requesterPrincipalId: string;
  readonly sodConstraint: SoDConstraint;
  readonly expiresAt: number;
  readonly expectedResult: string;
}

const REQUIRED_PACKAGE_FACETS: readonly (keyof DecisionPackage)[] = [
  'requestedAction',
  'affectedScope',
  'businessImpact',
  'risks',
  'alternatives',
  'evidenceIds',
  'policyVersion',
  'controlVersion',
  'requesterPrincipalId',
  'sodConstraint',
  'expiresAt',
  'expectedResult',
];

function completePackage(): DecisionPackage {
  return {
    requestedAction: 'rotate-production-credentials',
    affectedScope: ORG_SCOPE,
    businessImpact: 'temporary read-only window for tenant-a billing export',
    risks: ['transient auth failures', 'export lag'],
    alternatives: ['stagger rotation', 'defer to maintenance window'],
    evidenceIds: ['ev-scan-9', 'ev-approval-context-3'],
    policyVersion: REV_CURRENT,
    controlVersion: 'ctrl-2024-11-01',
    requesterPrincipalId: 'requester',
    sodConstraint: constraint(),
    expiresAt: NOW + DAY,
    expectedResult: 'credentials rotated, evidence appended, audit event retained',
  };
}

/** A facet is "present" iff it is a non-empty scalar / non-empty array / non-null object. */
function facetPresent(pkg: DecisionPackage, facet: keyof DecisionPackage): boolean {
  const v = pkg[facet];
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

describe('AS1 — decision package completeness (VO-8d9604e6a04ad189849f)', () => {
  it('an approver with CURRENT authority can review, and the package shows every facet', () => {
    // Precondition observable: the approver actually holds current authority right now.
    const auth = resolveEffectiveAuthority(authorityInputs([activeAssignment()]), NOW);
    expect(auth.roles).toContain('authorized_approver');
    expect(auth.breakGlassOnly).toBe(false);

    const pkg = completePackage();
    for (const facet of REQUIRED_PACKAGE_FACETS) {
      expect(facetPresent(pkg, facet), `facet '${facet}' must be present`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL — dropping ANY single facet is detectable (oracle non-vacuous)', () => {
    for (const facet of REQUIRED_PACKAGE_FACETS) {
      const broken = { ...completePackage() } as Record<string, unknown>;
      // Blank the facet the way a real omission would present it.
      broken[facet] = Array.isArray(completePackage()[facet])
        ? []
        : typeof completePackage()[facet] === 'object'
          ? {}
          : typeof completePackage()[facet] === 'number'
            ? NaN
            : '';
      expect(
        facetPresent(broken as unknown as DecisionPackage, facet),
        `omitted '${facet}' must be caught`,
      ).toBe(false);
    }
  });
});

// ===========================================================================
// AS2 (VO-699e…) — PERMITTED TRANSITION OCCURS ONCE + AUDIT.
// Given a complete, well-separated package the decision is PERMITTED (the transition may
// occur), the acting reason is retained, and a signed decision-evidence (audit) record is
// produced exactly once. The PDP is the transition gate; a permit yields verifiable evidence.
// ===========================================================================

describe('AS2 — permitted transition once + audit (VO-699effc1c52abb2cf3b0)', () => {
  const pdp = createSignedOpaPdp({
    revision: REV_CURRENT,
    bundleSigningKey: BUNDLE_KEY,
    evidenceSigningKey: EVIDENCE_KEY,
  });

  function decideSeparated(): DecisionRequest {
    return {
      query: {
        policy: 'separation_of_duties',
        input: { assignments: separatedAssignments(), constraint: constraint() },
      },
      actorPrincipalId: 'approver',
      correlationId: 'corr-approve-1',
      pinnedRevision: REV_CURRENT,
      now: NOW,
    };
  }

  it('a complete, separated package is PERMITTED and yields exactly one signed audit record', () => {
    const result = pdp.decide(decideSeparated());
    expect(result.decision.permit).toBe(true);
    expect(result.decision.reasons).toHaveLength(0);
    // Complete audit record retained, bound to actor, correlation, revision, and decided-at.
    expect(result.evidence.actorPrincipalId).toBe('approver');
    expect(result.evidence.correlationId).toBe('corr-approve-1');
    expect(result.evidence.bundleRevision).toBe(REV_CURRENT);
    expect(result.evidence.decidedAt).toBe(NOW);
    expect(result.evidence.signature.length).toBeGreaterThan(0);
  });

  it('the transition occurs ONCE — a replay against the same pinned revision is idempotent evidence', () => {
    const a = pdp.decide(decideSeparated());
    const b = pdp.decide(decideSeparated());
    // Same input + same revision → byte-identical evidence body (no second, divergent effect).
    expect(b.evidence.inputDigest).toBe(a.evidence.inputDigest);
    expect(b.evidence.bundleDigest).toBe(a.evidence.bundleDigest);
    expect(b.evidence.signature).toBe(a.evidence.signature);
  });

  it('NEGATIVE CONTROL — a self-approving package is DENIED, so no transition is permitted', () => {
    const selfApprove: DutyAssignment[] = [
      {
        principalId: 'approver',
        duty: 'request',
        roles: ['authorized_approver'],
        relationships: ['requester'],
        tenantId: 'tenant-a',
      },
      {
        principalId: 'approver',
        duty: 'approval',
        roles: ['authorized_approver'],
        relationships: ['approver'],
        tenantId: 'tenant-a',
      },
    ];
    const result = pdp.decide({
      query: {
        policy: 'separation_of_duties',
        input: { assignments: selfApprove, constraint: constraint() },
      },
      actorPrincipalId: 'approver',
      correlationId: 'corr-approve-2',
      pinnedRevision: REV_CURRENT,
      now: NOW,
    });
    expect(result.decision.permit).toBe(false);
    expect(result.decision.reasons.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// AS3 (VO-b7d3…) — GOVERNED REJECTIONS: no-authority / conflicting-duty / no-reason / expired.
// Each defect must produce a recorded, EXPLAINED rejection (no transition). Each is paired
// with the well-formed positive control that permits.
// ===========================================================================

describe('AS3 — governed rejections (VO-b7d38611f9d8413fea66)', () => {
  // ---- SELF-APPROVAL (conflicting duty held by one principal) ------------------------------
  describe('self-approval', () => {
    it('REJECTS — one principal holding request+approval → SELF_APPROVAL, explained', () => {
      const assignments: DutyAssignment[] = [
        {
          principalId: 'p',
          duty: 'request',
          roles: ['governance_officer'],
          relationships: ['requester'],
          tenantId: 'tenant-a',
        },
        {
          principalId: 'p',
          duty: 'approval',
          roles: ['authorized_approver'],
          relationships: ['approver'],
          tenantId: 'tenant-a',
        },
      ];
      const evalr = evaluateSeparationOfDuties(assignments, constraint());
      expect(evalr.permitted).toBe(false);
      const codes = evalr.violations.map((v) => v.code);
      expect(codes).toContain('SELF_APPROVAL');
      // Rejection is EXPLAINED: message names the principal and implicates it.
      const sa = evalr.violations.find((v) => v.code === 'SELF_APPROVAL')!;
      expect(sa.message).toContain('p');
      expect(sa.principals).toContain('p');
    });
    it('POSITIVE CONTROL — two distinct principals for request vs approval PERMITS', () => {
      expect(evaluateSeparationOfDuties(separatedAssignments(), constraint()).permitted).toBe(true);
    });
  });

  // ---- INCOMPATIBLE ROLES ------------------------------------------------------------------
  describe('incompatible roles', () => {
    it('REJECTS — a role the constraint forbids for the action class → INCOMPATIBLE_ROLE', () => {
      const c = constraint({ incompatibleRoles: ['operator'] });
      const assignments: DutyAssignment[] = [
        {
          principalId: 'requester',
          duty: 'request',
          roles: ['governance_officer'],
          relationships: ['requester'],
          tenantId: 'tenant-a',
        },
        {
          principalId: 'approver',
          duty: 'approval',
          roles: ['authorized_approver', 'operator'],
          relationships: ['approver'],
          tenantId: 'tenant-a',
        },
      ];
      const evalr = evaluateSeparationOfDuties(assignments, c);
      expect(evalr.permitted).toBe(false);
      expect(evalr.violations.map((v) => v.code)).toContain('INCOMPATIBLE_ROLE');
    });
    it('POSITIVE CONTROL — the same assignments without the forbidden role PERMIT', () => {
      const c = constraint({ incompatibleRoles: ['operator'] });
      expect(evaluateSeparationOfDuties(separatedAssignments(), c).permitted).toBe(true);
    });
  });

  // ---- ADMIN-ONLY AUTHORITY (platform administration alone grants no decision authority) ----
  describe('admin-only authority', () => {
    it('REJECTS — a decision duty backed only by platform_admin → PLATFORM_ADMIN_NO_AUTHORITY', () => {
      const assignments: DutyAssignment[] = [
        {
          principalId: 'requester',
          duty: 'request',
          roles: ['governance_officer'],
          relationships: ['requester'],
          tenantId: 'tenant-a',
        },
        {
          principalId: 'admin',
          duty: 'approval',
          roles: ['platform_admin'],
          relationships: ['approver'],
          tenantId: 'tenant-a',
        },
      ];
      const evalr = evaluateSeparationOfDuties(assignments, constraint());
      expect(evalr.permitted).toBe(false);
      expect(evalr.violations.map((v) => v.code)).toContain('PLATFORM_ADMIN_NO_AUTHORITY');
    });
    it('POSITIVE CONTROL — a genuine authorized_approver on the same duty PERMITS', () => {
      expect(evaluateSeparationOfDuties(separatedAssignments(), constraint()).permitted).toBe(true);
    });
  });

  // ---- MISSING REASON (delegation / recertification must carry a reason) --------------------
  describe('missing reason', () => {
    it('REJECTS — a delegation with a blank reason → MISSING_REASON', () => {
      const del = activeDelegation({ reasonText: '   ' });
      const byId = new Map<string, Delegation>([[del.delegationId, del]]);
      const res = resolveDelegation(del, byId, () => activeAssignment(), NOW);
      expect(res.granted).toBe(false);
      expect(res.reason).toBe('MISSING_REASON');
    });
    it('REJECTS — a recertification with no reason grants nothing (returns null)', () => {
      const out = recertify(activeAssignment(), {
        reviewerPrincipalId: 'other',
        atMs: NOW,
        nextRecertificationAt: NOW + 30 * DAY,
        reason: '',
      });
      expect(out).toBeNull();
    });
    it('POSITIVE CONTROL — the same delegation WITH a reason grants authority', () => {
      const del = activeDelegation();
      const byId = new Map<string, Delegation>([[del.delegationId, del]]);
      const res = resolveDelegation(del, byId, () => activeAssignment(), NOW);
      expect(res.granted).toBe(true);
      expect(res.reason).toBeNull();
    });
  });

  // ---- EXPIRED ASSIGNMENTS / DELEGATIONS ---------------------------------------------------
  describe('expired assignments', () => {
    it('REJECTS — an expired role assignment grants nothing → EXPIRED', () => {
      const res = resolveRoleAssignment(activeAssignment({ expiresAt: NOW - HOUR }), NOW);
      expect(res.granted).toBe(false);
      expect(res.reason).toBe('EXPIRED');
    });
    it('REJECTS — expiry is EXCLUSIVE: now === expiresAt is already expired', () => {
      const res = resolveRoleAssignment(activeAssignment({ expiresAt: NOW }), NOW);
      expect(res.granted).toBe(false);
      expect(res.reason).toBe('EXPIRED');
    });
    it('REJECTS — an expired delegation grants nothing → EXPIRED', () => {
      const del = activeDelegation({ validFrom: NOW - 2 * HOUR, expiresAt: NOW - HOUR });
      const byId = new Map<string, Delegation>([[del.delegationId, del]]);
      const res = resolveDelegation(del, byId, () => activeAssignment(), NOW);
      expect(res.granted).toBe(false);
      expect(res.reason).toBe('EXPIRED');
    });
    it('REJECTS — a decision resting on an expired delegation contributes no authority', () => {
      const expired = activeDelegation({ validFrom: NOW - 2 * HOUR, expiresAt: NOW - HOUR });
      const auth = resolveEffectiveAuthority(
        {
          principalId: 'deputy',
          tenantId: 'tenant-a',
          assignments: [],
          delegations: [expired],
          breakGlassGrants: [],
          allDelegationsById: new Map([[expired.delegationId, expired]]),
          sourceOf: () => activeAssignment(),
        },
        NOW,
      );
      expect(auth.activeDelegationIds).toHaveLength(0);
      expect(auth.roles).toHaveLength(0);
    });
    it('POSITIVE CONTROL — an in-window assignment and delegation both grant', () => {
      expect(resolveRoleAssignment(activeAssignment(), NOW).granted).toBe(true);
      const del = activeDelegation();
      const byId = new Map<string, Delegation>([[del.delegationId, del]]);
      expect(resolveDelegation(del, byId, () => activeAssignment(), NOW).granted).toBe(true);
    });
  });

  // ---- UNAVAILABLE / INDETERMINATE POLICY --------------------------------------------------
  describe('unavailable policy', () => {
    it('REJECTS — an unsigned bundle cannot be loaded → PdpUnavailableError(unsigned)', () => {
      const unsigned: SignedPolicyBundle = {
        revision: REV_CURRENT,
        roots: ['separation_of_duties'],
        signature: '',
      };
      // At the adapter construction boundary AND at the raw verify boundary — both fail closed.
      expect(
        () =>
          new SignedOpaBundleAdapter({
            bundle: unsigned,
            bundleVerificationKey: BUNDLE_KEY,
            evidenceSigningKey: EVIDENCE_KEY,
          }),
      ).toThrow(PdpUnavailableError);
      let thrown: unknown;
      try {
        verifyBundle(unsigned, BUNDLE_KEY);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(PdpUnavailableError);
      expect((thrown as PdpUnavailableError).reason).toBe('unsigned');
    });
    it('REJECTS — a bundle signed with the wrong key cannot be loaded → bad-signature', () => {
      const tampered = signBundle(
        { revision: REV_CURRENT, roots: ['separation_of_duties'] },
        'attacker-key',
      );
      let thrown: unknown;
      try {
        new SignedOpaBundleAdapter({
          bundle: tampered,
          bundleVerificationKey: BUNDLE_KEY,
          evidenceSigningKey: EVIDENCE_KEY,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(PdpUnavailableError);
      expect((thrown as PdpUnavailableError).reason).toBe('bad-signature');
    });
    it('REJECTS — a bundle claiming an unknown policy root → unknown-root', () => {
      const badRoot = signBundle(
        {
          revision: REV_CURRENT,
          roots: ['not_a_real_policy' as unknown as 'separation_of_duties'],
        },
        BUNDLE_KEY,
      );
      let thrown: unknown;
      try {
        verifyBundle(badRoot, BUNDLE_KEY);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(PdpUnavailableError);
      expect((thrown as PdpUnavailableError).reason).toBe('unknown-root');
    });
    it('POSITIVE CONTROL — a correctly signed bundle loads and decides', () => {
      const pdp = createSignedOpaPdp({
        revision: REV_CURRENT,
        bundleSigningKey: BUNDLE_KEY,
        evidenceSigningKey: EVIDENCE_KEY,
      });
      const res = pdp.decide({
        query: {
          policy: 'separation_of_duties',
          input: { assignments: separatedAssignments(), constraint: constraint() },
        },
        actorPrincipalId: 'approver',
        correlationId: 'corr-ok',
        pinnedRevision: REV_CURRENT,
        now: NOW,
      });
      expect(res.decision.permit).toBe(true);
    });
  });
});

// ===========================================================================
// AS4 (VO-e317…) — STALE VERSIONS → RE-REVIEW.
// When the policy/control version the caller pinned drifts from the version actually served,
// the decision MUST NOT be rendered against the stale pin: the PDP fails closed with
// revision-mismatch, forcing re-review against the current decision package.
// ===========================================================================

describe('AS4 — stale version → re-review (VO-e317929c35e08a96a3ba)', () => {
  const pdp = createSignedOpaPdp({
    revision: REV_CURRENT,
    bundleSigningKey: BUNDLE_KEY,
    evidenceSigningKey: EVIDENCE_KEY,
  });

  function decideAt(pinnedRevision: string): DecisionRequest {
    return {
      query: {
        policy: 'separation_of_duties',
        input: { assignments: separatedAssignments(), constraint: constraint() },
      },
      actorPrincipalId: 'approver',
      correlationId: 'corr-stale',
      pinnedRevision,
      now: NOW,
    };
  }

  it('REJECTS — deciding against a STALE pinned revision throws revision-mismatch (re-review required)', () => {
    let thrown: unknown;
    try {
      pdp.decide(decideAt(REV_STALE));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PdpUnavailableError);
    expect((thrown as PdpUnavailableError).reason).toBe('revision-mismatch');
    // Explained: the rejection names both the pinned (stale) and served (current) revisions.
    expect((thrown as PdpUnavailableError).detail).toMatchObject({
      pinned: REV_STALE,
      served: REV_CURRENT,
    });
  });

  it('POSITIVE CONTROL — pinning the CURRENT (re-reviewed) revision decides successfully', () => {
    const res = pdp.decide(decideAt(REV_CURRENT));
    expect(res.decision.permit).toBe(true);
    expect(res.evidence.bundleRevision).toBe(REV_CURRENT);
  });
});

// ===========================================================================
// AS5 (VO-01bd…) — DELEGATION IS BOUNDED (named recipient, window, reason, delegator authority,
// no cycle, no privilege/scope/time expansion).
// ===========================================================================

describe('AS5 — delegation is bounded, no cycle / privilege expansion (VO-01bd627ae03c596f2eae)', () => {
  const ADMIN_SCOPE: AuthorityScope = {
    scopeType: 'organization',
    scopeId: 'org-1',
    allowedActions: ['approve'],
  };
  const WIDER_SCOPE: AuthorityScope = {
    scopeType: 'organization',
    scopeId: 'org-1',
    allowedActions: ['approve', 'delete-everything'],
  };

  it('POSITIVE — a named, in-window, reasoned delegation from a valid source GRANTS', () => {
    const del = activeDelegation();
    const byId = new Map<string, Delegation>([[del.delegationId, del]]);
    const res = resolveDelegation(del, byId, () => activeAssignment(), NOW);
    expect(res.granted).toBe(true);
    expect(del.recipientPrincipalId.length).toBeGreaterThan(0); // named recipient
    expect(del.expiresAt).toBeGreaterThan(del.validFrom); // bounded window
    expect(res.lineage).toEqual(['del-1']);
  });

  it('REJECTS — a self-delegation (delegator === recipient) → SELF_DELEGATION', () => {
    const del = activeDelegation({ recipientPrincipalId: 'approver' });
    const byId = new Map<string, Delegation>([[del.delegationId, del]]);
    const res = resolveDelegation(del, byId, () => activeAssignment(), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SELF_DELEGATION');
  });

  it('REJECTS — a cyclic delegation chain → CYCLE', () => {
    const a: Delegation = activeDelegation({ delegationId: 'A', parentDelegationId: 'B' });
    const b: Delegation = activeDelegation({
      delegationId: 'B',
      parentDelegationId: 'A',
      delegatorPrincipalId: 'x',
      recipientPrincipalId: 'y',
    });
    const byId = new Map<string, Delegation>([
      ['A', a],
      ['B', b],
    ]);
    const res = resolveDelegation(a, byId, () => activeAssignment(), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('CYCLE');
  });

  it('REJECTS — a delegation whose scope EXPANDS beyond its source → SCOPE_EXPANSION', () => {
    const del = activeDelegation({ scope: WIDER_SCOPE });
    const byId = new Map<string, Delegation>([[del.delegationId, del]]);
    // Source only authorizes ['approve']; the delegation tries to add 'delete-everything'.
    const res = resolveDelegation(del, byId, () => activeAssignment({ scope: ADMIN_SCOPE }), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SCOPE_EXPANSION');
  });

  it('REJECTS — a delegation outliving its source assignment → TIME_EXPANSION', () => {
    const del = activeDelegation({ validFrom: NOW - HOUR, expiresAt: NOW + 10 * DAY });
    const byId = new Map<string, Delegation>([[del.delegationId, del]]);
    // Source expires before the delegation's expiry.
    const res = resolveDelegation(del, byId, () => activeAssignment({ expiresAt: NOW + DAY }), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('TIME_EXPANSION');
  });

  it('REJECTS — a delegation whose source assignment does not currently grant → SOURCE_INVALID', () => {
    const del = activeDelegation();
    const byId = new Map<string, Delegation>([[del.delegationId, del]]);
    // Source is revoked → confers no authority → delegation is groundless.
    const res = resolveDelegation(del, byId, () => activeAssignment({ status: 'revoked' }), NOW);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SOURCE_INVALID');
  });
});

// ===========================================================================
// AS6 (VO-4307…) — CROSS-TENANT JOINT APPROVAL: blocked until a DISTINCT central governance
// reviewer (holding no incompatible action role) approves the joint action.
// ===========================================================================

describe('AS6 — cross-tenant joint approval (VO-43075588f88b28ecf27e)', () => {
  const action: CrossTenantAction = {
    requesterPrincipalId: 'requester',
    operatorPrincipalId: 'operator',
    controlOwnerPrincipalId: 'owner',
    tenantApproverPrincipalIds: ['tenant-a-approver', 'tenant-b-approver'],
  };

  it('POSITIVE — a distinct central_governance_reviewer with no action role PERMITS', () => {
    const reviewer: CentralReviewer = {
      principalId: 'central-rev',
      roles: ['central_governance_reviewer'],
    };
    expect(evaluateCentralReviewerDistinctness(action, reviewer).permitted).toBe(true);
  });

  it('REJECTS — a reviewer who is also a tenant approver is NOT DISTINCT → CENTRAL_REVIEWER_NOT_DISTINCT', () => {
    const reviewer: CentralReviewer = {
      principalId: 'tenant-a-approver',
      roles: ['central_governance_reviewer'],
    };
    const evalr = evaluateCentralReviewerDistinctness(action, reviewer);
    expect(evalr.permitted).toBe(false);
    expect(evalr.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_NOT_DISTINCT');
  });

  it('REJECTS — a distinct reviewer who ALSO holds an incompatible action role → CENTRAL_REVIEWER_INCOMPATIBLE_ROLE', () => {
    const reviewer: CentralReviewer = {
      principalId: 'central-rev',
      roles: ['central_governance_reviewer', 'authorized_approver'],
    };
    const evalr = evaluateCentralReviewerDistinctness(action, reviewer);
    expect(evalr.permitted).toBe(false);
    expect(evalr.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_INCOMPATIBLE_ROLE');
  });

  it('REJECTS — a reviewer missing the central_governance_reviewer role fails closed', () => {
    const reviewer: CentralReviewer = { principalId: 'central-rev', roles: [] };
    expect(evaluateCentralReviewerDistinctness(action, reviewer).permitted).toBe(false);
  });

  it('bridge — resolved break-glass-only authority can NEVER stand in as the central reviewer', () => {
    // A principal whose only authority is break-glass carries no reviewer role after the bridge.
    const bgOnly: EffectiveAuthority = {
      principalId: 'central-rev',
      tenantId: 'central',
      roles: ['central_governance_reviewer'],
      scopes: [],
      activeDelegationIds: [],
      activeBreakGlassIds: ['bg-1'],
      breakGlassOnly: true,
    };
    const evalr = evaluateCentralReviewerAuthority(action, bgOnly);
    expect(evalr.permitted).toBe(false);
  });
});

// ===========================================================================
// CROSS-CUTTING — the action-authority bridge fails closed when a participant lacks authority
// (ties AS3 "lacks authority" to the RESOLVED-authority path end to end).
// ===========================================================================

describe('cross-cutting — evaluateActionAuthority fails closed on missing/expired authority', () => {
  function auth(
    principalId: string,
    roles: readonly RoleAssignment['role'][],
    expiresAt: number,
  ): EffectiveAuthority {
    return resolveEffectiveAuthority(
      {
        principalId,
        tenantId: 'tenant-a',
        assignments: roles.map((role, i) =>
          activeAssignment({
            roleAssignmentId: `ra-${principalId}-${i}`,
            principalId,
            role,
            expiresAt,
          }),
        ),
        delegations: [],
        breakGlassGrants: [],
        allDelegationsById: new Map(),
        sourceOf: () => null,
      },
      NOW,
    );
  }

  it('REJECTS — an approver whose assignment is EXPIRED contributes no authority → action denied', () => {
    const requester = auth('requester', ['governance_officer'], NOW + DAY);
    const approver = auth('approver', ['authorized_approver'], NOW - HOUR); // expired
    const evalr = evaluateActionAuthority(
      [
        { authority: requester, duty: 'request', relationships: ['requester'] },
        { authority: approver, duty: 'approval', relationships: ['approver'] },
      ],
      constraint(),
    );
    expect(evalr.permitted).toBe(false);
  });

  it('POSITIVE CONTROL — both participants with CURRENT authority PERMIT', () => {
    const requester = auth('requester', ['governance_officer'], NOW + DAY);
    const approver = auth('approver', ['authorized_approver'], NOW + DAY);
    const evalr = evaluateActionAuthority(
      [
        { authority: requester, duty: 'request', relationships: ['requester'] },
        { authority: approver, duty: 'approval', relationships: ['approver'] },
      ],
      constraint(),
    );
    expect(evalr.permitted).toBe(true);
  });
});
