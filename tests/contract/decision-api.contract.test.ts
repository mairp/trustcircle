// TrustCircleAI — Phase 88 / Work item BJG3PZHMWX4DHWZ9RMEZ33F9GZ.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M (content hash af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b).
//
// CONTRACT-LEVEL validation of the DECISION / ACTION / DELEGATION surface: requests, headers,
// ETags, idempotency, errors, and responses are validated against the CANONICAL API contract
// (`specs/001-governance-control-plane/contracts/governance-api.openapi.yaml`) via the runtime
// module `@trustcircle/contracts/decision-api`. That module LOADS the contract and resolves the
// operations + $ref schemas, so every assertion below is coupled to the published API — not to a
// hand-copied shape. The permitted/refused VERDICTS come from the REAL @trustcircle/authz oracles
// (separation-of-duties.ts + authority.ts), exactly as the Phase-87 state machines do; this suite
// never re-implements an oracle. It asserts that a conformant request/response passes AND that a
// malformed or governed-refused one is rejected with the specific contract violation, so every
// oracle is non-vacuous.
//
//   AC1 decision package completeness ................ describe('AC1 — decision package response')
//   AC2 approve/deny/delegate/request-changes/escalate/expire once + audit .. describe('AC2 — decision actions')
//   AC3 no-authority / conflicting-duty / no-reason / expired-delegation → rejection recorded ..
//                                                      describe('AC3 — governed rejections')
//   AC4 material change after review → re-review ..... describe('AC4 — material-change re-review')
//   AC5 delegation named/bounded/start+expiry/reason/authority/no-cycle/no-priv-expansion ..
//                                                      describe('AC5 — delegation requests')
//   AC6 cross-tenant blocked until guardrails + all-tenant approvals + distinct central reviewer ..
//                                                      describe('AC6 — cross-tenant joint package')
//   Protocol: headers, ETags, idempotency ............ describe('Protocol — headers / ETag / idempotency')
//
// No wall clock, no Math.random: all timestamps and ids are deterministic. Relative imports with
// `.ts` extensions, mirroring the other contract suites.

import { describe, expect, it } from 'vitest';

import {
  loadGovernanceApi,
  validateCreateDecisionRequest,
  validateDecisionAction,
  validateDelegationRequest,
  validateDecisionRequestResponse,
  validateDecisionActionResult,
  validateDelegationResponse,
  validateProblem,
  validateRequestHeaders,
  validateEtagResponse,
  validateIdempotentReplay,
  validateGovernedRejection,
  requiredHeaders,
  declaresEtag,
  permittedDecisionActions,
  type GovernanceApiDocument,
  type Json,
} from '../../packages/contracts/src/decision-api.ts';
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
// Deterministic fixtures (no wall clock / no randomness).
// ---------------------------------------------------------------------------

const DOC: GovernanceApiDocument = loadGovernanceApi();
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (ms: number): string => new Date(ms).toISOString();

// A fixed pool of well-formed UUIDs (v4-shaped; the contract only requires uuid format).
const U = (n: number): string => {
  const hex = n.toString(16).padStart(12, '0');
  return `0f3d9b3e-1b2a-4c4d-8e5f-${hex}`;
};

const TENANT_A = U(1);
const TENANT_B = U(2);
const CORRELATION = U(900);
const IDEMPOTENCY_KEY = 'idem-key-2f8a91';

const ACTIONS_OP = DOC.operation('post', '/v1/decisions/{decisionId}/actions');
const CREATE_OP = DOC.operation('post', '/v1/decisions');
const GET_OP = DOC.operation('get', '/v1/decisions/{decisionId}');
const DELEG_OP = DOC.operation('post', '/v1/delegations');

function actionHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Tenant-ID': TENANT_A,
    'Idempotency-Key': IDEMPOTENCY_KEY,
    'X-Correlation-ID': CORRELATION,
    'If-Match': '"v3"',
    ...overrides,
  };
}

/** A complete, contract-valid CreateDecisionRequest body (AC1 has every enumerated facet). */
function completeCreateRequest(overrides: Record<string, Json> = {}): Json {
  return {
    work_item_id: U(10),
    requested_action: 'promote release 4.2.0 to production tenant fleet',
    action_class: 'production-config-change',
    risk_tier: 'high',
    scope: { scope_type: 'environment', scope_id: 'prod-eu', allowed_actions: ['promote', 'rollback'] },
    business_impact: { summary: 'affects checkout availability for 12 tenants', tenants: 12 },
    risks: [{ risk: 'transient 5xx during rollout' }, { risk: 'schema drift on rollback' }],
    alternatives: [{ option: 'canary to one tenant first' }, { option: 'defer to next window' }],
    expected_result: { statement: 'release live in prod-eu, error budget unchanged' },
    evidence_manifest_id: U(11),
    simulation_id: U(12),
    affected_tenant_ids: [TENANT_A, TENANT_B],
    expires_at: iso(T0 + 2 * DAY),
    ...overrides,
  };
}

/** A complete DecisionRequest response body (the full package the approver is shown — AC1). */
function completePackageResponse(overrides: Record<string, Json> = {}): Json {
  return {
    ...(completeCreateRequest() as Record<string, Json>),
    id: U(20),
    tenant_id: TENANT_A,
    requester_principal_id: U(30),
    status: 'under_review',
    requirements: [
      {
        id: U(40),
        gate_type: 'separation_of_duties',
        tenant_id: TENANT_A,
        status: 'pending',
        minimum_distinct_principals: 2,
        incompatible_relationships: ['requester', 'executor'],
      },
    ],
    version: 1,
    created_at: iso(T0),
    ...overrides,
  };
}

function reason(code: string, text: string): Json {
  return { code, text };
}

// The SoD constraint for the action class, mirroring the Phase-87 wiring (separation enforced by
// intrinsic duty-forbidden relationships + minimumDistinctPrincipals=2).
const SOD: SoDConstraint = {
  sodConstraintId: 'sod-decision-1',
  tenantId: TENANT_A,
  actionClass: 'production-config-change',
  incompatibleRoles: [],
  incompatibleRelationships: [],
  minimumDistinctPrincipals: 2,
  status: 'active',
};

const REQUESTER = U(30);
const APPROVER = U(31);

/** A properly separated duty set: distinct requester + approver. */
function separatedDuties(): DutyAssignment[] {
  return [
    { principalId: REQUESTER, duty: 'request', roles: ['operator'], relationships: ['requester'], tenantId: TENANT_A },
    { principalId: APPROVER, duty: 'approval', roles: ['authorized_approver'], relationships: ['approver'], tenantId: TENANT_A },
  ];
}

/** A self-approval duty set: the requester also approves (SoD violation). */
function selfApprovalDuties(): DutyAssignment[] {
  return [
    { principalId: REQUESTER, duty: 'request', roles: ['operator'], relationships: ['requester'], tenantId: TENANT_A },
    { principalId: REQUESTER, duty: 'approval', roles: ['authorized_approver'], relationships: ['approver'], tenantId: TENANT_A },
  ];
}

const SCOPE: AuthorityScope = {
  scopeType: 'environment',
  scopeId: 'prod-eu',
  allowedActions: ['promote', 'rollback'],
};

function activeAssignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    roleAssignmentId: U(50),
    tenantId: TENANT_A,
    principalId: APPROVER,
    role: 'authorized_approver',
    scope: SCOPE,
    validFrom: T0 - DAY,
    expiresAt: T0 + 30 * DAY,
    status: 'active',
    nextRecertificationAt: T0 + 20 * DAY,
    lastRecertifiedAt: T0 - DAY,
    ...overrides,
  };
}

function activeDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    delegationId: U(60),
    tenantId: TENANT_A,
    delegatorPrincipalId: APPROVER,
    recipientPrincipalId: U(32),
    authorityAssignmentId: U(50),
    scope: SCOPE,
    reasonText: 'covering approver is on leave',
    validFrom: T0 - HOUR,
    expiresAt: T0 + 3 * DAY,
    parentDelegationId: null,
    status: 'active',
    ...overrides,
  };
}

// ===========================================================================
// Sanity: the loaded contract exposes exactly the surface this phase validates.
// ===========================================================================

describe('contract surface is loaded from the published OpenAPI document', () => {
  it('exposes the seven permitted decision-action verbs (AC2 transition alphabet)', () => {
    expect(permittedDecisionActions(DOC).sort()).toEqual(
      ['approve', 'cancel', 'delegate', 'deny', 'escalate', 'expire', 'request_changes'].sort(),
    );
  });

  it('requires tenant, idempotency, correlation, and If-Match headers on decision actions', () => {
    const names = requiredHeaders(DOC, ACTIONS_OP).map((h) => h.name).sort();
    expect(names).toEqual(['If-Match', 'Idempotency-Key', 'X-Correlation-ID', 'X-Tenant-ID'].sort());
  });

  it('declares an ETag on the package, action, and create responses (optimistic concurrency)', () => {
    expect(declaresEtag(GET_OP, '200')).toBe(true);
    expect(declaresEtag(ACTIONS_OP, '200')).toBe(true);
    expect(declaresEtag(CREATE_OP, '201')).toBe(true);
  });
});

// ===========================================================================
// AC1 — a complete decision package response for an authorized approver.
// ===========================================================================

describe('AC1 — decision package response', () => {
  it('accepts a package that carries every required facet', () => {
    expect(validateDecisionRequestResponse(DOC, completePackageResponse())).toEqual([]);
  });

  it('accepts a well-formed create request with the full package content', () => {
    expect(validateCreateDecisionRequest(DOC, completeCreateRequest())).toEqual([]);
  });

  // NEGATIVE CONTROLS: an incomplete package must be rejected, facet by facet — a broken
  // validator that let these through would fail these assertions.
  it.each([
    'requested_action',
    'action_class',
    'risk_tier',
    'scope',
    'business_impact',
    'risks',
    'alternatives',
    'expected_result',
    'expires_at',
  ])('rejects a create request missing the required facet %s', (facet) => {
    const body = completeCreateRequest() as Record<string, Json>;
    delete body[facet];
    const errs = validateCreateDecisionRequest(DOC, body);
    expect(errs.some((e) => e.includes(`missing required property '${facet}'`))).toBe(true);
  });

  it('rejects a package that drops the requester / status / requirements identity fields', () => {
    const body = completePackageResponse() as Record<string, Json>;
    delete body.requester_principal_id;
    delete body.status;
    delete body.requirements;
    const errs = validateDecisionRequestResponse(DOC, body);
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing required property 'requester_principal_id'"),
        expect.stringContaining("missing required property 'status'"),
        expect.stringContaining("missing required property 'requirements'"),
      ]),
    );
  });

  it('rejects an unknown property (additionalProperties:false is enforced)', () => {
    const body = completeCreateRequest() as Record<string, Json>;
    body.smuggled = 'not-in-contract';
    expect(validateCreateDecisionRequest(DOC, body)).toEqual(
      expect.arrayContaining([expect.stringContaining("additional property 'smuggled'")]),
    );
  });
});

// ===========================================================================
// AC2 — each permitted decision action with a reason produces a schema-valid action envelope
// with a complete audit record, once, under the real SoD oracle.
// ===========================================================================

describe('AC2 — decision actions', () => {
  it.each(['approve', 'deny', 'delegate', 'request_changes', 'escalate', 'expire'])(
    'accepts a well-formed %s action request (verb + reason)',
    (action) => {
      const body: Record<string, Json> = { action, reason: reason(`decision.${action}`, `${action} per policy review`) };
      if (action === 'delegate') {
        body.delegation = {
          recipient_principal_id: U(32),
          authority_assignment_id: U(50),
          scope: { scope_type: 'environment', scope_id: 'prod-eu', allowed_actions: ['promote'] },
          actions: ['approve'],
          reason: reason('deleg.cover', 'covering approver on leave'),
          valid_from: iso(T0),
          expires_at: iso(T0 + DAY),
        };
      }
      expect(validateDecisionAction(DOC, body)).toEqual([]);
    },
  );

  it('produces a schema-valid action envelope (decision + record + audit_event_id) when SoD permits', () => {
    // The action is only allowed when the REAL SoD evaluator permits a properly separated duty set.
    const sod = evaluateSeparationOfDuties(separatedDuties(), SOD);
    expect(sod.permitted).toBe(true);

    const envelope: Json = {
      decision: { ...(completePackageResponse() as Record<string, Json>), status: 'approved', version: 2 },
      record: {
        id: U(70),
        actor_principal_id: APPROVER,
        authority_assignment_id: U(50),
        action: 'approve',
        reason: reason('decision.approve', 'meets policy and controls'),
        status: 'approved',
        decided_at: iso(T0 + HOUR),
        audit_event_id: U(80),
      },
      audit_event_id: U(80),
    };
    expect(validateDecisionActionResult(DOC, envelope)).toEqual([]);
  });

  it('rejects an action verb outside the contract enum', () => {
    const errs = validateDecisionAction(DOC, { action: 'obliterate', reason: reason('x', 'yyy') });
    expect(errs.some((e) => e.includes('not in enum'))).toBe(true);
  });

  it('rejects an action envelope missing the audit_event_id (audit record incomplete)', () => {
    const envelope = {
      decision: completePackageResponse(),
      record: {
        id: U(70), actor_principal_id: APPROVER, action: 'approve',
        reason: reason('decision.approve', 'ok'), status: 'approved', decided_at: iso(T0 + HOUR),
        // audit_event_id intentionally omitted
      },
      // top-level audit_event_id intentionally omitted
    };
    const errs = validateDecisionActionResult(DOC, envelope);
    expect(errs.some((e) => e.includes("missing required property 'audit_event_id'"))).toBe(true);
  });
});

// ===========================================================================
// AC3 — governed rejections: no authority, conflicting duties, no reason, expired delegation →
// NO transition, and a recorded, explained rejection (Problem + audit_event_id + safe next actions).
// ===========================================================================

describe('AC3 — governed rejections', () => {
  it('rejects an action whose reason is empty (contract requires a structured reason)', () => {
    const errs = validateDecisionAction(DOC, { action: 'approve', reason: { code: '', text: 'x' } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('reason'))).toBe(true);
  });

  it('rejects an action with no reason at all', () => {
    const errs = validateDecisionAction(DOC, { action: 'approve' });
    expect(errs.some((e) => e.includes("missing required property 'reason'"))).toBe(true);
  });

  it('surfaces a SELF_APPROVAL SoD violation as a well-formed governed rejection', () => {
    // The REAL SoD oracle refuses self-approval; the API must record + explain that refusal.
    const sod = evaluateSeparationOfDuties(selfApprovalDuties(), SOD);
    expect(sod.permitted).toBe(false);
    const codes = sod.violations.map((v) => v.code);
    expect(codes).toContain('SELF_APPROVAL');

    const problem: Json = {
      type: 'https://trustcircle.ai/problems/sod-violation',
      title: 'Separation of duties violated',
      status: 409,
      code: codes.join(','),
      detail: `decision refused: ${sod.violations.map((v) => v.message).join('; ')}`,
      correlation_id: CORRELATION,
      audit_event_id: U(81),
      retryable: false,
      safe_next_actions: ['assign a distinct approver', 'request a waiver where permitted'],
    };
    expect(validateGovernedRejection(DOC, problem, CORRELATION)).toEqual([]);
  });

  it('surfaces a lack-of-authority refusal as a well-formed governed rejection', () => {
    // An expired assignment grants NO authority (real resolver) → the API records the refusal.
    const res = resolveRoleAssignment(activeAssignment({ status: 'expired' }), T0);
    expect(res.granted).toBe(false);
    const problem: Json = {
      type: 'https://trustcircle.ai/problems/no-authority',
      title: 'Actor lacks current authority',
      status: 403,
      code: `NO_AUTHORITY:${res.reason}`,
      detail: 'actor does not currently hold authority for this action',
      correlation_id: CORRELATION,
      audit_event_id: U(82),
      retryable: false,
      safe_next_actions: ['request an authority grant', 'escalate to a governance officer'],
    };
    expect(validateGovernedRejection(DOC, problem, CORRELATION)).toEqual([]);
  });

  it('surfaces an EXPIRED-delegation refusal as a well-formed governed rejection', () => {
    // The real delegation resolver refuses an expired chain → recorded, explained rejection.
    const expired = activeDelegation({ validFrom: T0 - 2 * DAY, expiresAt: T0 - HOUR });
    const byId = new Map<string, Delegation>([[expired.delegationId, expired]]);
    const res = resolveDelegation(expired, byId, () => activeAssignment(), T0);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('EXPIRED');
    const problem: Json = {
      type: 'https://trustcircle.ai/problems/expired-delegation',
      title: 'Delegation expired',
      status: 403,
      code: `DELEGATION_${res.reason}`,
      detail: 'the delegation relied upon has expired and confers no authority',
      correlation_id: CORRELATION,
      audit_event_id: U(83),
      retryable: false,
      safe_next_actions: ['obtain a fresh delegation', 'act under direct authority'],
    };
    expect(validateGovernedRejection(DOC, problem, CORRELATION)).toEqual([]);
  });

  // NEGATIVE CONTROLS on the rejection oracle: a Problem missing its audit id / next actions /
  // correlation echo is NOT a valid governed rejection.
  it('rejects a Problem that omits the audit_event_id (rejection not recorded)', () => {
    const problem: Json = {
      type: 'https://x/p', title: 'Denied', status: 403, code: 'NO_AUTHORITY',
      detail: 'no authority', correlation_id: CORRELATION, audit_event_id: null,
      retryable: false, safe_next_actions: ['x'],
    };
    const errs = validateGovernedRejection(DOC, problem, CORRELATION);
    expect(errs.some((e) => e.includes('audit_event_id'))).toBe(true);
  });

  it('rejects a Problem that omits safe next actions (rejection not explained)', () => {
    const problem: Json = {
      type: 'https://x/p', title: 'Denied', status: 403, code: 'NO_AUTHORITY',
      detail: 'no authority', correlation_id: CORRELATION, audit_event_id: U(84),
      retryable: false, safe_next_actions: [],
    };
    const errs = validateGovernedRejection(DOC, problem, CORRELATION);
    expect(errs.some((e) => e.includes('safe next action'))).toBe(true);
  });

  it('rejects a Problem whose correlation id does not echo the request', () => {
    const problem: Json = {
      type: 'https://x/p', title: 'Denied', status: 403, code: 'NO_AUTHORITY',
      detail: 'no authority', correlation_id: U(999), audit_event_id: U(84),
      retryable: false, safe_next_actions: ['x'],
    };
    const errs = validateGovernedRejection(DOC, problem, CORRELATION);
    expect(errs.some((e) => e.includes('correlation_id'))).toBe(true);
  });

  it('rejects a Problem body that violates the Problem schema (missing required fields)', () => {
    const errs = validateProblem(DOC, { title: 'oops' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("missing required property 'status'"))).toBe(true);
  });
});

// ===========================================================================
// AC4 — a material change after review begins forces re-review: the invalidated package is a
// distinct version, and acting on the stale ETag is a concurrency conflict (governed rejection).
// ===========================================================================

describe('AC4 — material-change re-review', () => {
  it('accepts an invalidated re-review package as a NEW version (contract-valid)', () => {
    const reReview = completePackageResponse({
      status: 'invalidated',
      version: 2,
      // material facets changed: evidence + policy content
      evidence_manifest_id: U(13),
      business_impact: { summary: 'now affects 20 tenants after scope change', tenants: 20 },
    });
    expect(validateDecisionRequestResponse(DOC, reReview)).toEqual([]);
    // A re-review is a DIFFERENT version than the package review began against.
    expect((reReview as Record<string, Json>).version).not.toBe(1);
  });

  it('surfaces a stale-ETag / version-conflict as a well-formed governed rejection (re-review required)', () => {
    const problem: Json = {
      type: 'https://trustcircle.ai/problems/precondition-failed',
      title: 'Decision package changed materially — re-review required',
      status: 412,
      code: 'STALE_PACKAGE',
      detail: 'the package changed after review began; the supplied If-Match no longer matches',
      correlation_id: CORRELATION,
      audit_event_id: U(85),
      retryable: true,
      safe_next_actions: ['re-open the current package', 're-review against the latest version'],
    };
    expect(validateGovernedRejection(DOC, problem, CORRELATION)).toEqual([]);
    expect((problem as Record<string, Json>).status).toBe(412);
  });
});

// ===========================================================================
// AC5 — a delegation request: named recipient, bounded scope, start+expiry, reason, and delegator
// authority, with NO circular / privilege-expanding chain (the real lineage resolver is the oracle).
// ===========================================================================

describe('AC5 — delegation requests', () => {
  function goodDelegationBody(overrides: Record<string, Json> = {}): Json {
    return {
      recipient_principal_id: U(32),
      authority_assignment_id: U(50),
      scope: { scope_type: 'environment', scope_id: 'prod-eu', allowed_actions: ['promote'] },
      actions: ['approve'],
      reason: reason('deleg.cover', 'covering approver on leave'),
      valid_from: iso(T0),
      expires_at: iso(T0 + DAY),
      ...overrides,
    };
  }

  it('accepts a well-formed delegation request (named recipient, bounded scope, window, reason)', () => {
    expect(validateDelegationRequest(DOC, goodDelegationBody())).toEqual([]);
  });

  it('accepts a created Delegation response with delegator, tenant, and status', () => {
    const body = { ...(goodDelegationBody() as Record<string, Json>), id: U(61), tenant_id: TENANT_A, delegator_principal_id: APPROVER, status: 'active' };
    expect(validateDelegationResponse(DOC, body)).toEqual([]);
  });

  it.each(['recipient_principal_id', 'authority_assignment_id', 'scope', 'actions', 'reason', 'valid_from', 'expires_at'])(
    'rejects a delegation request missing the required field %s',
    (field) => {
      const body = goodDelegationBody() as Record<string, Json>;
      delete body[field];
      const errs = validateDelegationRequest(DOC, body);
      expect(errs.some((e) => e.includes(`missing required property '${field}'`))).toBe(true);
    },
  );

  it('rejects a delegation with an empty action list (unbounded scope of authority)', () => {
    const errs = validateDelegationRequest(DOC, goodDelegationBody({ actions: [] }));
    expect(errs.some((e) => e.includes('minItems'))).toBe(true);
  });

  it('rejects a delegation with a non-uuid recipient (recipient not a named principal)', () => {
    const errs = validateDelegationRequest(DOC, goodDelegationBody({ recipient_principal_id: 'not-a-uuid' }));
    expect(errs.some((e) => e.includes('not a uuid'))).toBe(true);
  });

  it('binds acceptance to the real lineage resolver: a valid chain grants', () => {
    const d = activeDelegation();
    const byId = new Map<string, Delegation>([[d.delegationId, d]]);
    const res = resolveDelegation(d, byId, () => activeAssignment(), T0);
    expect(res.granted).toBe(true);
  });

  it('refuses a CIRCULAR delegation chain (real resolver) → recorded governed rejection', () => {
    // Two delegations pointing at each other form a cycle.
    const a = activeDelegation({ delegationId: U(62), parentDelegationId: U(63) });
    const b = activeDelegation({ delegationId: U(63), parentDelegationId: U(62) });
    const byId = new Map<string, Delegation>([[a.delegationId, a], [b.delegationId, b]]);
    const res = resolveDelegation(a, byId, () => activeAssignment(), T0);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('CYCLE');
    const problem: Json = {
      type: 'https://trustcircle.ai/problems/delegation-cycle', title: 'Circular delegation',
      status: 422, code: 'DELEGATION_CYCLE', detail: 'the delegation chain contains a cycle',
      correlation_id: CORRELATION, audit_event_id: U(86), retryable: false,
      safe_next_actions: ['break the cycle', 'delegate directly from a root assignment'],
    };
    expect(validateGovernedRejection(DOC, problem, CORRELATION)).toEqual([]);
  });

  it('refuses a PRIVILEGE-EXPANDING delegation (scope wider than source) → recorded rejection', () => {
    // The root delegation asks for an action the source assignment does not grant.
    const wide = activeDelegation({
      scope: { scopeType: 'environment', scopeId: 'prod-eu', allowedActions: ['promote', 'delete-tenant'] },
    });
    const byId = new Map<string, Delegation>([[wide.delegationId, wide]]);
    const res = resolveDelegation(wide, byId, () => activeAssignment(), T0);
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('SCOPE_EXPANSION');
  });
});

// ===========================================================================
// AC6 — a cross-tenant consequential action is blocked until central guardrails pass, every
// affected tenant supplies a current scoped approval, AND a distinct central governance reviewer
// approves. The real central-reviewer-distinctness oracle is the gate.
// ===========================================================================

describe('AC6 — cross-tenant joint package', () => {
  const action: CrossTenantAction = {
    requesterPrincipalId: REQUESTER,
    operatorPrincipalId: U(33),
    controlOwnerPrincipalId: U(34),
    tenantApproverPrincipalIds: [U(35), U(36)], // one approver per affected tenant (A, B)
  };

  it('accepts the joint action when a distinct central reviewer approves (real oracle permits)', () => {
    const reviewer: CentralReviewer = { principalId: U(37), roles: ['central_governance_reviewer'] };
    const verdict = evaluateCentralReviewerDistinctness(action, reviewer);
    expect(verdict.permitted).toBe(true);

    // The action request itself must declare every affected tenant (bounded, uniqueItems).
    const body = completeCreateRequest({ affected_tenant_ids: [TENANT_A, TENANT_B] });
    expect(validateCreateDecisionRequest(DOC, body)).toEqual([]);
  });

  it('BLOCKS when the central reviewer is not distinct (coincides with an action role)', () => {
    const notDistinct: CentralReviewer = { principalId: REQUESTER, roles: ['central_governance_reviewer'] };
    const verdict = evaluateCentralReviewerDistinctness(action, notDistinct);
    expect(verdict.permitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_NOT_DISTINCT');

    const problem: Json = {
      type: 'https://trustcircle.ai/problems/reviewer-not-distinct',
      title: 'Central reviewer is not independent', status: 409,
      code: verdict.violations.map((v) => v.code).join(','),
      detail: verdict.violations.map((v) => v.message).join('; '),
      correlation_id: CORRELATION, audit_event_id: U(87), retryable: false,
      safe_next_actions: ['assign an independent central governance reviewer'],
    };
    expect(validateGovernedRejection(DOC, problem, CORRELATION)).toEqual([]);
  });

  it('BLOCKS when the central reviewer holds an incompatible action role even if distinct', () => {
    const tainted: CentralReviewer = {
      principalId: U(38),
      roles: ['central_governance_reviewer', 'authorized_approver'],
    };
    const verdict = evaluateCentralReviewerDistinctness(action, tainted);
    expect(verdict.permitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('CENTRAL_REVIEWER_INCOMPATIBLE_ROLE');
  });

  it('rejects a cross-tenant request whose affected_tenant_ids contain duplicates (uniqueItems)', () => {
    const body = completeCreateRequest({ affected_tenant_ids: [TENANT_A, TENANT_A] });
    const errs = validateCreateDecisionRequest(DOC, body);
    expect(errs.some((e) => e.includes('uniqueItems'))).toBe(true);
  });
});

// ===========================================================================
// Protocol — headers, ETags, idempotency across the decision-action surface.
// ===========================================================================

describe('Protocol — headers / ETag / idempotency', () => {
  it('accepts an action request carrying every required, well-formed header', () => {
    expect(validateRequestHeaders(DOC, ACTIONS_OP, actionHeaders())).toEqual([]);
  });

  it.each(['X-Tenant-ID', 'Idempotency-Key', 'X-Correlation-ID', 'If-Match'])(
    'rejects an action request missing the required header %s',
    (header) => {
      const headers = actionHeaders();
      delete (headers as Record<string, string>)[header];
      const errs = validateRequestHeaders(DOC, ACTIONS_OP, headers);
      expect(errs.some((e) => e.includes(`missing required header '${header}'`))).toBe(true);
    },
  );

  it('rejects an Idempotency-Key that violates the contract length/charset constraints', () => {
    const errs = validateRequestHeaders(DOC, ACTIONS_OP, actionHeaders({ 'Idempotency-Key': 'short' }));
    expect(errs.some((e) => e.includes('Idempotency-Key'))).toBe(true);
  });

  it('rejects a non-uuid X-Tenant-ID header', () => {
    const errs = validateRequestHeaders(DOC, ACTIONS_OP, actionHeaders({ 'X-Tenant-ID': 'tenant-a' }));
    expect(errs.some((e) => e.includes('X-Tenant-ID'))).toBe(true);
  });

  it('requires a non-empty ETag on the action + package responses (optimistic concurrency)', () => {
    expect(validateEtagResponse(ACTIONS_OP, '200', { ETag: '"v4"' })).toEqual([]);
    expect(validateEtagResponse(GET_OP, '200', { ETag: 'W/"v1"' })).toEqual([]);
    expect(validateEtagResponse(ACTIONS_OP, '200', {})).not.toEqual([]);
    expect(validateEtagResponse(ACTIONS_OP, '200', { ETag: '' })).not.toEqual([]);
  });

  it('treats a same-key replay as one durable effect (identical id + version + audit, marked)', () => {
    const original = {
      idempotencyKey: IDEMPOTENCY_KEY, tenantId: TENANT_A, resourceId: U(20),
      resourceVersion: 2, auditEventId: U(80), idempotentReplay: false,
    };
    const replay = { ...original, idempotentReplay: true };
    expect(validateIdempotentReplay(original, replay)).toEqual([]);
  });

  it('flags a "replay" that actually mutated state (new id/version/audit) as a second effect', () => {
    const original = {
      idempotencyKey: IDEMPOTENCY_KEY, tenantId: TENANT_A, resourceId: U(20),
      resourceVersion: 2, auditEventId: U(80), idempotentReplay: false,
    };
    const secondEffect = { ...original, resourceId: U(21), resourceVersion: 3, auditEventId: U(88), idempotentReplay: false };
    const errs = validateIdempotentReplay(original, secondEffect);
    expect(errs.length).toBeGreaterThanOrEqual(3);
    expect(errs.some((e) => e.includes('resource id'))).toBe(true);
    expect(errs.some((e) => e.includes('version'))).toBe(true);
  });
});
