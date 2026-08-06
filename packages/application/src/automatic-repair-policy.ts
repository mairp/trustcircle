// @trustcircle/application — AUTOMATIC-REPAIR POLICY: enforce current low-risk policy, source
// version, preservation, scope/rate/time/blast bounds, cancellation, rollback, and evidence gates
// (Phase 5 / User Story 3 / FR-021, GAR-004).
//
// This is the FAIL-CLOSED gate that decides whether an approved `RemediationPlan` may execute
// WITHOUT a human in the loop. Automatic repair is a narrow privilege: it is granted only when EVERY
// one of the following holds, and the FIRST failing condition is the returned refusal reason —
// never a silent allow:
//
//   1. the plan is shape-eligible (pre_authorized_low_risk ⇒ non-destructive + low-risk + policy-
//      bound) — the domain's GAR-004 invariant, re-checked here;
//   2. the plan is APPROVED and not expired at the effect instant;
//   3. the bound policy version is the CURRENT effective automatic-repair policy (a superseded
//      policy cannot authorize execution — policy currency, fail-closed if unavailable);
//   4. the PRESERVED original evidence exists (FR-017) — no repair over an unpreserved original;
//   5. the observed source revision MATCHES the revision the plan was built against (drift
//      invalidates the plan — a stale plan may not touch a changed source);
//   6. the plan carries a rollback plan, stop conditions, an evidence plan, and a verification plan
//      (you may not automatically change production without a way back and a way to prove it);
//   7. the requested effect is WITHIN the plan's scope / rate / time-window / blast-radius bounds;
//   8. the kill switch is NOT engaged and the case is not already cancelled.
//
// The gate is pure and clock-free (the effect instant is injected). It grants no authority itself —
// it is the deterministic policy function the repair-executor consults before acting. A `permitted`
// verdict is necessary, never sufficient: the executor still records evidence and the outcome is
// only ever verified by an independent VerificationRecord.

import { type Uuid, type EpochMillis } from '@trustcircle/domain';
import { isAutomaticEligible, type RemediationPlan } from '@trustcircle/domain';

export type AutoRepairDenyReason =
  | 'NOT_SHAPE_ELIGIBLE'
  | 'NOT_APPROVED'
  | 'PLAN_EXPIRED'
  | 'POLICY_UNAVAILABLE'
  | 'POLICY_SUPERSEDED'
  | 'ORIGINAL_NOT_PRESERVED'
  | 'SOURCE_REVISION_DRIFT'
  | 'MISSING_ROLLBACK_PLAN'
  | 'MISSING_STOP_CONDITIONS'
  | 'MISSING_EVIDENCE_PLAN'
  | 'MISSING_VERIFICATION_PLAN'
  | 'OUT_OF_SCOPE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'OUTSIDE_TIME_WINDOW'
  | 'BLAST_RADIUS_EXCEEDED'
  | 'KILL_SWITCH_ENGAGED'
  | 'CASE_CANCELLED';

export interface AutoRepairVerdict {
  readonly permitted: boolean;
  readonly denyReason: AutoRepairDenyReason | null;
  /** The policy version that authorized the effect (only when permitted). */
  readonly appliedPolicyVersionId: Uuid | null;
}

/** The bounds a low-risk plan declares, extracted from `plan.bounds` (all optional, fail-open only
 *  when ABSENT — a declared bound that is violated fails closed). */
export interface RepairBounds {
  readonly maxAffectedItems?: number;
  readonly maxAttemptsPerWindow?: number;
  readonly windowStart?: EpochMillis;
  readonly windowEnd?: EpochMillis;
  readonly maxBlastRadius?: number;
}

export interface AutoRepairContext {
  readonly plan: RemediationPlan;
  /** The current effective automatic-repair policy version, or null if the PDP is unavailable. */
  readonly currentPolicyVersionId: Uuid | null;
  /** True iff the preserved-original evidence for the case exists and is integrity-verified. */
  readonly originalPreserved: boolean;
  /** The revision the plan was built against, and the revision observed at effect time. */
  readonly planSourceRevision: string;
  readonly observedSourceRevision: string;
  /** Effect-time facts. */
  readonly killSwitchEngaged: boolean;
  readonly caseCancelled: boolean;
  readonly requestedAffectedItems: number;
  readonly requestedBlastRadius: number;
  readonly attemptsInWindow: number;
  readonly now: EpochMillis;
}

function deny(reason: AutoRepairDenyReason): AutoRepairVerdict {
  return { permitted: false, denyReason: reason, appliedPolicyVersionId: null };
}

/** Read a numeric bound from an untyped plan.bounds record (undefined when absent/non-numeric). */
function numBound(bounds: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = bounds[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function objNonEmpty(o: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(o).length > 0;
}
function arrNonEmpty(a: readonly unknown[]): boolean {
  return a.length > 0;
}

/**
 * Decide whether the approved plan may execute automatically at `now`. Returns the FIRST failing
 * gate as the deny reason (fail-closed ordering), or a permitted verdict binding the current policy
 * version. This function NEVER throws — an unrepresentable plan is denied, not crashed.
 */
export function evaluateAutomaticRepair(ctx: AutoRepairContext): AutoRepairVerdict {
  const p = ctx.plan;

  // 1. Shape eligibility (GAR-004): destructive / non-low-risk / policy-unbound is human-only.
  if (!isAutomaticEligible(p)) return deny('NOT_SHAPE_ELIGIBLE');

  // 2. Approved + not expired.
  if (p.status !== 'approved') return deny('NOT_APPROVED');
  if (ctx.now >= p.expiresAt) return deny('PLAN_EXPIRED');

  // 3. Policy currency (fail-closed if the PDP is unavailable; superseded policy cannot authorize).
  if (ctx.currentPolicyVersionId === null) return deny('POLICY_UNAVAILABLE');
  if (p.policyVersionId !== ctx.currentPolicyVersionId) return deny('POLICY_SUPERSEDED');

  // 4. Preservation precedes repair (FR-017).
  if (!ctx.originalPreserved) return deny('ORIGINAL_NOT_PRESERVED');

  // 5. Source-revision binding — drift invalidates the plan.
  if (ctx.planSourceRevision !== ctx.observedSourceRevision) return deny('SOURCE_REVISION_DRIFT');

  // 6. Way-back + way-to-prove gates.
  if (!objNonEmpty(p.rollbackPlan)) return deny('MISSING_ROLLBACK_PLAN');
  if (!arrNonEmpty(p.stopConditions)) return deny('MISSING_STOP_CONDITIONS');
  if (!objNonEmpty(p.evidencePlan)) return deny('MISSING_EVIDENCE_PLAN');
  if (!objNonEmpty(p.verificationPlan)) return deny('MISSING_VERIFICATION_PLAN');

  // 7. Bounds — scope / rate / time-window / blast-radius (a declared bound, if violated, fails closed).
  const bounds = p.bounds;
  const maxItems = numBound(bounds, 'maxAffectedItems');
  if (maxItems !== undefined && ctx.requestedAffectedItems > maxItems) return deny('OUT_OF_SCOPE');
  const maxAttempts = numBound(bounds, 'maxAttemptsPerWindow');
  if (maxAttempts !== undefined && ctx.attemptsInWindow >= maxAttempts)
    return deny('RATE_LIMIT_EXCEEDED');
  const windowStart = numBound(bounds, 'windowStart');
  const windowEnd = numBound(bounds, 'windowEnd');
  if (windowStart !== undefined && ctx.now < windowStart) return deny('OUTSIDE_TIME_WINDOW');
  if (windowEnd !== undefined && ctx.now >= windowEnd) return deny('OUTSIDE_TIME_WINDOW');
  const maxBlast = numBound(bounds, 'maxBlastRadius');
  if (maxBlast !== undefined && ctx.requestedBlastRadius > maxBlast)
    return deny('BLAST_RADIUS_EXCEEDED');

  // 8. Kill switch / cancellation.
  if (ctx.killSwitchEngaged) return deny('KILL_SWITCH_ENGAGED');
  if (ctx.caseCancelled) return deny('CASE_CANCELLED');

  return {
    permitted: true,
    denyReason: null,
    appliedPolicyVersionId: ctx.currentPolicyVersionId,
  };
}
