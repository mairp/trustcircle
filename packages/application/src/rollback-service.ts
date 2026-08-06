// @trustcircle/application — ROLLBACK SERVICE: protect newer legitimate state and handle
// compensation, partial rollback, verification, failure, and escalation
// (Phase 5 / User Story 3 / FR-022).
//
// Rollback undoes a repair by restoring the PRESERVED original — but it is NOT a blind overwrite.
// Between the repair and the rollback, a legitimate newer change may have landed on the source. The
// service's first duty is to PROTECT that newer legitimate state: if the observed source revision no
// longer matches the revision the repair produced, a straight restore would destroy real work, so
// the rollback is refused as a CONFLICT and escalated for human compensation. When the revision
// still matches, the service computes a compensation and reports the outcome honestly:
//
//   * `rolled_back` — the original was fully restored and the restoration verified;
//   * `partial`     — some but not all steps compensated (residual difference retained + escalated);
//   * `conflict`    — a newer legitimate revision blocks automatic rollback (escalated);
//   * `failed`      — the compensation itself failed (escalated, quarantine retained).
//
// Only a fully `rolled_back` outcome that also VERIFIES clears the case; every other outcome keeps
// the quarantine and raises an escalation. The service is pure and clock-free; it decides, it does
// not itself mutate the remote source.

import { type Uuid, type EpochMillis } from '@trustcircle/domain';
import { type RollbackOutcome, type RepairAttempt } from '@trustcircle/domain';

export interface RollbackContext {
  readonly attempt: RepairAttempt;
  /** The revision the repair produced (what the original should be restored FROM). */
  readonly repairProducedRevision: string;
  /** The revision observed on the source NOW, at rollback time. */
  readonly observedRevision: string;
  /** How many of the repair's steps were successfully compensated. */
  readonly compensatedSteps: number;
  readonly totalSteps: number;
  /** True iff the post-rollback state was verified equal to the preserved original. */
  readonly restorationVerified: boolean;
  /** True iff the compensation execution itself succeeded end-to-end. */
  readonly compensationSucceeded: boolean;
  readonly now: EpochMillis;
}

export interface RollbackDecision {
  readonly outcome: RollbackOutcome;
  /** True iff the case may be cleared (only a fully verified restore). */
  readonly caseCleared: boolean;
  /** True iff the newer legitimate state was protected (a straight restore was refused). */
  readonly protectedNewerState: boolean;
  /** True iff this outcome must escalate for human attention. */
  readonly mustEscalate: boolean;
  /** Residual differences count retained for the reconciliation record. */
  readonly residualDifferences: number;
  readonly preservedOriginalEvidenceId: Uuid;
}

/**
 * Decide the rollback outcome. Ordering is fail-closed and newer-state-protective: a revision drift
 * (newer legitimate change) is a CONFLICT before anything else, then execution failure, then partial
 * compensation, then a fully verified restore. Only the last clears the case.
 */
export function decideRollback(ctx: RollbackContext): RollbackDecision {
  const preservedOriginalEvidenceId = ctx.attempt.preservedOriginalEvidenceId;

  // Protect newer legitimate state: if the source moved past what the repair produced, a straight
  // restore would destroy real work — refuse and escalate for human compensation.
  if (ctx.observedRevision !== ctx.repairProducedRevision) {
    return {
      outcome: 'conflict',
      caseCleared: false,
      protectedNewerState: true,
      mustEscalate: true,
      residualDifferences: Math.max(0, ctx.totalSteps - ctx.compensatedSteps),
      preservedOriginalEvidenceId,
    };
  }

  // The compensation execution itself failed.
  if (!ctx.compensationSucceeded) {
    return {
      outcome: 'failed',
      caseCleared: false,
      protectedNewerState: false,
      mustEscalate: true,
      residualDifferences: Math.max(0, ctx.totalSteps - ctx.compensatedSteps),
      preservedOriginalEvidenceId,
    };
  }

  // Partial compensation — some steps could not be undone; residual difference is retained.
  if (ctx.compensatedSteps < ctx.totalSteps) {
    return {
      outcome: 'partial',
      caseCleared: false,
      protectedNewerState: false,
      mustEscalate: true,
      residualDifferences: ctx.totalSteps - ctx.compensatedSteps,
      preservedOriginalEvidenceId,
    };
  }

  // Full compensation — but a rollback is only complete when the restoration is VERIFIED.
  if (!ctx.restorationVerified) {
    return {
      outcome: 'partial',
      caseCleared: false,
      protectedNewerState: false,
      mustEscalate: true,
      residualDifferences: 0,
      preservedOriginalEvidenceId,
    };
  }

  return {
    outcome: 'rolled_back',
    caseCleared: true,
    protectedNewerState: false,
    mustEscalate: false,
    residualDifferences: 0,
    preservedOriginalEvidenceId,
  };
}
