// @trustcircle/application — REMEDIATION PLANNER: versioned remediation recommendations with risk,
// scope, preconditions, policy authority, evidence, verification, stop, rollback, expiry, and owner
// (Phase 5 / User Story 3 / FR-020).
//
// The planner turns a classified `IntegrityCase` into an IMMUTABLE, versioned `RemediationPlan`
// RECOMMENDATION. A plan states WHAT to change, WHY, the EXPECTED result, its risk class, whether it
// is destructive, its affected scope, its preconditions, its authorization mode (human vs.
// pre-authorized low-risk), execution bounds, an evidence plan, a verification plan, stop
// conditions, a rollback plan, an expiry, and an owner. A "change" to a recommendation is a NEW
// version (append-only); the prior version is superseded, not overwritten, so the recommendation
// history stays reconstructable.
//
// Crucially the planner NEVER produces a `pre_authorized_low_risk` plan that is destructive or
// non-low-risk or policy-unbound — the domain factory (GAR-004) makes that unrepresentable, and the
// planner surfaces such an attempt as an explained rejection rather than throwing. The planner does
// not EXECUTE anything and grants no authority; it recommends. It is pure and clock-free.

import { type Uuid, type EpochMillis, type TenantId } from '@trustcircle/domain';
import {
  makeRemediationPlan,
  remediationPlanDigest,
  isAutomaticEligible,
  type RemediationPlan,
  type RemediationRiskClass,
  type AuthorizationMode,
  type RemediationStatus,
} from '@trustcircle/domain';

export type PlannerRejectionCode =
  | 'UNKNOWN_PLAN'
  | 'TERMINAL_PLAN'
  | 'NOT_APPROVABLE'
  | 'DESTRUCTIVE_AUTO_PROHIBITED'
  | 'INVARIANT_VIOLATION';

export interface PlannerOutcome {
  readonly accepted: boolean;
  readonly plan: RemediationPlan | null;
  readonly rejectionCode: PlannerRejectionCode | null;
}

function accept(p: RemediationPlan): PlannerOutcome {
  return { accepted: true, plan: p, rejectionCode: null };
}
function reject(code: PlannerRejectionCode): PlannerOutcome {
  return { accepted: false, plan: null, rejectionCode: code };
}

export class RemediationPlanner {
  readonly #tenantId: TenantId;
  readonly #byId = new Map<Uuid, RemediationPlan>();
  readonly #byCase = new Map<Uuid, RemediationPlan[]>();

  constructor(tenantId: TenantId) {
    this.#tenantId = tenantId;
  }

  /** Draft a new immutable remediation version for a case. Version is derived (max + 1). */
  propose(input: {
    id: Uuid;
    integrityCaseId: Uuid;
    rationale: string;
    ownerPrincipalId: Uuid;
    expiresAt: EpochMillis;
    createdAt: EpochMillis;
    riskClass?: RemediationRiskClass;
    destructive?: boolean;
    authorizationMode?: AuthorizationMode;
    policyVersionId?: Uuid;
    proposedChange?: Record<string, unknown>;
    expectedResult?: Record<string, unknown>;
    affectedScope?: Record<string, unknown>;
    preconditions?: readonly Record<string, unknown>[];
    bounds?: Record<string, unknown>;
    evidencePlan?: Record<string, unknown>;
    verificationPlan?: Record<string, unknown>;
    stopConditions?: readonly Record<string, unknown>[];
    rollbackPlan?: Record<string, unknown>;
  }): PlannerOutcome {
    const existing = this.#byCase.get(input.integrityCaseId) ?? [];
    const nextVersion = existing.reduce((max, p) => Math.max(max, p.version), 0) + 1;
    // Guard the destructive-automatic combination BEFORE constructing, so the refusal is explained
    // rather than surfaced only as an INVARIANT_VIOLATION from the factory.
    if (
      input.authorizationMode === 'pre_authorized_low_risk' &&
      (input.destructive === true || (input.riskClass !== undefined && input.riskClass !== 'low'))
    ) {
      return reject('DESTRUCTIVE_AUTO_PROHIBITED');
    }
    let p: RemediationPlan;
    try {
      p = makeRemediationPlan({
        id: input.id,
        tenantId: this.#tenantId,
        integrityCaseId: input.integrityCaseId,
        version: nextVersion,
        rationale: input.rationale,
        ownerPrincipalId: input.ownerPrincipalId,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
        ...(input.riskClass !== undefined ? { riskClass: input.riskClass } : {}),
        ...(input.destructive !== undefined ? { destructive: input.destructive } : {}),
        ...(input.authorizationMode !== undefined ? { authorizationMode: input.authorizationMode } : {}),
        ...(input.policyVersionId !== undefined ? { policyVersionId: input.policyVersionId } : {}),
        ...(input.proposedChange !== undefined ? { proposedChange: input.proposedChange } : {}),
        ...(input.expectedResult !== undefined ? { expectedResult: input.expectedResult } : {}),
        ...(input.affectedScope !== undefined ? { affectedScope: input.affectedScope } : {}),
        ...(input.preconditions !== undefined ? { preconditions: input.preconditions } : {}),
        ...(input.bounds !== undefined ? { bounds: input.bounds } : {}),
        ...(input.evidencePlan !== undefined ? { evidencePlan: input.evidencePlan } : {}),
        ...(input.verificationPlan !== undefined ? { verificationPlan: input.verificationPlan } : {}),
        ...(input.stopConditions !== undefined ? { stopConditions: input.stopConditions } : {}),
        ...(input.rollbackPlan !== undefined ? { rollbackPlan: input.rollbackPlan } : {}),
        status: 'draft',
      });
    } catch {
      return reject('INVARIANT_VIOLATION');
    }
    // Supersede prior non-terminal versions for the case.
    for (const prior of existing) {
      if (prior.status !== 'superseded' && prior.status !== 'expired') {
        const s = this.#rebuild(prior, { status: 'superseded' });
        if (s !== null) this.#store(s);
      }
    }
    this.#store(p);
    return accept(p);
  }

  /** Record a simulation result against a plan (moves draft → simulated). */
  recordSimulation(input: { planId: Uuid; simulationId: Uuid }): PlannerOutcome {
    const current = this.#byId.get(input.planId);
    if (current === undefined) return reject('UNKNOWN_PLAN');
    if (current.status === 'expired' || current.status === 'superseded') return reject('TERMINAL_PLAN');
    const next = this.#rebuild(current, { status: 'simulated', simulationId: input.simulationId });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  /** Submit a plan for approval (→ pending_approval). */
  submitForApproval(input: { planId: Uuid }): PlannerOutcome {
    const current = this.#byId.get(input.planId);
    if (current === undefined) return reject('UNKNOWN_PLAN');
    if (current.status === 'expired' || current.status === 'superseded') return reject('TERMINAL_PLAN');
    const next = this.#rebuild(current, { status: 'pending_approval' });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  /** Record an approval decision (→ approved). Only pending/simulated/draft may be approved. */
  approve(input: { planId: Uuid; approvalDecisionId: Uuid }): PlannerOutcome {
    const current = this.#byId.get(input.planId);
    if (current === undefined) return reject('UNKNOWN_PLAN');
    if (current.status === 'expired' || current.status === 'superseded') return reject('TERMINAL_PLAN');
    if (current.status === 'approved') return reject('NOT_APPROVABLE');
    const next = this.#rebuild(current, {
      status: 'approved',
      approvalDecisionId: input.approvalDecisionId,
    });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  // ---- queries -----------------------------------------------------------

  get(id: Uuid): RemediationPlan | undefined {
    return this.#byId.get(id);
  }

  plansFor(caseId: Uuid): readonly RemediationPlan[] {
    return Object.freeze([...(this.#byCase.get(caseId) ?? [])]);
  }

  /** The single active (non-superseded/expired) plan for a case, if any. */
  activePlanFor(caseId: Uuid): RemediationPlan | undefined {
    const list = this.#byCase.get(caseId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      if (p.status !== 'superseded' && p.status !== 'expired') return p;
    }
    return undefined;
  }

  /** True iff the plan is shape-eligible for automatic execution (GAR-004 shape gate). */
  automaticEligible(id: Uuid): boolean {
    const p = this.#byId.get(id);
    return p !== undefined && isAutomaticEligible(p);
  }

  digest(id: Uuid): string | undefined {
    const p = this.#byId.get(id);
    return p ? remediationPlanDigest(p) : undefined;
  }

  // ---- internals ---------------------------------------------------------

  #store(p: RemediationPlan): void {
    this.#byId.set(p.id, p);
    const list = this.#byCase.get(p.integrityCaseId) ?? [];
    const idx = list.findIndex((x) => x.id === p.id);
    if (idx >= 0) list[idx] = p;
    else list.push(p);
    list.sort((a, b) => a.version - b.version);
    this.#byCase.set(p.integrityCaseId, list);
  }

  #rebuild(
    current: RemediationPlan,
    patch: { status?: RemediationStatus; simulationId?: Uuid; approvalDecisionId?: Uuid },
  ): RemediationPlan | null {
    try {
      return makeRemediationPlan({
        id: current.id,
        tenantId: current.tenantId,
        integrityCaseId: current.integrityCaseId,
        version: current.version,
        proposedChange: current.proposedChange as Record<string, unknown>,
        rationale: current.rationale,
        expectedResult: current.expectedResult as Record<string, unknown>,
        riskClass: current.riskClass,
        destructive: current.destructive,
        affectedScope: current.affectedScope as Record<string, unknown>,
        preconditions: current.preconditions as readonly Record<string, unknown>[],
        ...(current.policyVersionId !== undefined ? { policyVersionId: current.policyVersionId } : {}),
        authorizationMode: current.authorizationMode,
        bounds: current.bounds as Record<string, unknown>,
        evidencePlan: current.evidencePlan as Record<string, unknown>,
        verificationPlan: current.verificationPlan as Record<string, unknown>,
        stopConditions: current.stopConditions as readonly Record<string, unknown>[],
        rollbackPlan: current.rollbackPlan as Record<string, unknown>,
        ...(patch.simulationId !== undefined
          ? { simulationId: patch.simulationId }
          : current.simulationId !== undefined
            ? { simulationId: current.simulationId }
            : {}),
        ...(patch.approvalDecisionId !== undefined
          ? { approvalDecisionId: patch.approvalDecisionId }
          : current.approvalDecisionId !== undefined
            ? { approvalDecisionId: current.approvalDecisionId }
            : {}),
        ownerPrincipalId: current.ownerPrincipalId,
        expiresAt: current.expiresAt,
        status: patch.status ?? current.status,
        createdAt: current.createdAt,
      });
    } catch {
      return null;
    }
  }
}
