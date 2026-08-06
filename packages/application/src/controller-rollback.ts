// @trustcircle/application — CONTROLLER ROLLBACK: execute policy-approved rollback/compensation
// against the PRESERVED preimage and VERIFY actual remote state, protecting newer legitimate state
// (Phase 6 / User Story 4 / FR-028, NS-011).
//
// Rolling back a controller operation restores the preserved preimage — but never blindly. Between the
// operation and the rollback, a legitimate newer change may have landed on the source. The service's
// first duty is to PROTECT that newer legitimate state: if the observed source revision no longer
// matches what the operation produced, a straight restore would destroy real work, so the rollback is
// refused as a CONFLICT and escalated. It also fails closed when there is no preserved preimage
// (nothing to restore to) or no available compensation path (an irreversible step). Only a FULLY
// compensated rollback whose restoration is VERIFIED via a direct remote read clears the operation;
// every other result keeps the affected scope visibly DEGRADED and escalates (NS-011).
//
// This service is the thin coordinator over the domain `decideRollback` oracle. The names here are
// prefixed `Controller`/`controller` to avoid colliding with the integrity (US3) rollback-service
// symbols re-exported from the same package boundary. Pure and side-effect-free — it decides, it does
// not itself mutate the remote source.

import {
  type Uuid,
  type RollbackResult,
  type RollbackContext as DomainRollbackContext,
  type RollbackDecision as DomainRollbackDecision,
  decideRollback as domainDecideRollback,
} from '@trustcircle/domain';

export interface ControllerRollbackContext {
  readonly operationId: Uuid;
  /** The preserved preimage the rollback restores TO. Rollback is impossible without it. */
  readonly preimageEvidenceId: Uuid | null;
  /** The revision the operation produced (what the source should currently be). */
  readonly producedRevision: string;
  /** The revision OBSERVED on the source now (drift ⇒ newer legitimate state). */
  readonly observedRevision: string;
  readonly compensatedSteps: number;
  readonly totalSteps: number;
  /** True iff compensation is AVAILABLE (an irreversible step has no compensation). */
  readonly compensationAvailable: boolean;
  readonly compensationSucceeded: boolean;
  /** True iff post-rollback state was verified equal to the preimage via a DIRECT remote read. */
  readonly restorationVerified: boolean;
  /** True iff the policy authorizes this rollback/compensation (a rollback is itself a governed act). */
  readonly policyAuthorizesRollback: boolean;
}

export interface ControllerRollbackDecision {
  readonly result: RollbackResult;
  /** True iff the operation may be cleared (only a fully verified restore). */
  readonly operationCleared: boolean;
  /** True iff newer legitimate state was protected (a straight restore refused). */
  readonly protectedNewerState: boolean;
  /** True iff the affected scope must remain visibly degraded + block further unsafe actions. */
  readonly remainsDegraded: boolean;
  readonly mustEscalate: boolean;
  readonly residualDifferences: number;
  readonly reason: string;
}

/**
 * Decide a controller rollback. Policy authorization is checked first (a rollback is a governed act,
 * not a free undo); an unauthorized rollback fails closed as `failed` + escalate. Otherwise delegates
 * to the domain oracle, which orders the checks fail-closed and newer-state-protective.
 */
export function decideControllerRollback(ctx: ControllerRollbackContext): ControllerRollbackDecision {
  if (!ctx.policyAuthorizesRollback) {
    const residual = Math.max(0, ctx.totalSteps - ctx.compensatedSteps);
    return {
      result: 'failed',
      operationCleared: false,
      protectedNewerState: false,
      remainsDegraded: true,
      mustEscalate: true,
      residualDifferences: residual,
      reason: 'rollback_not_policy_authorized',
    };
  }

  const domainCtx: DomainRollbackContext = {
    operationId: ctx.operationId,
    preimageEvidenceId: ctx.preimageEvidenceId,
    producedRevision: ctx.producedRevision,
    observedRevision: ctx.observedRevision,
    compensatedSteps: ctx.compensatedSteps,
    totalSteps: ctx.totalSteps,
    compensationAvailable: ctx.compensationAvailable,
    compensationSucceeded: ctx.compensationSucceeded,
    restorationVerified: ctx.restorationVerified,
  };
  const decision: DomainRollbackDecision = domainDecideRollback(domainCtx);

  const reasonByResult: Record<RollbackResult, string> = {
    rolled_back: 'verified_full_restore_operation_cleared',
    partial: 'partial_compensation_residual_retained_escalated',
    conflict: 'newer_legitimate_state_protected_escalated',
    unavailable: ctx.preimageEvidenceId === null ? 'no_preserved_preimage_to_restore' : 'no_compensation_path_available',
    failed: 'compensation_execution_failed_escalated',
  };

  return {
    result: decision.result,
    operationCleared: decision.operationCleared,
    protectedNewerState: decision.protectedNewerState,
    remainsDegraded: decision.remainsDegraded,
    mustEscalate: decision.mustEscalate,
    residualDifferences: decision.residualDifferences,
    reason: reasonByResult[decision.result],
  };
}
