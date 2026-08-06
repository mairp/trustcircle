// @trustcircle/application — OPERATION CONTROL: idempotent PAUSE / RESUME with safe checkpoints and
// restored authority/precondition checks (Phase 6 / User Story 4 / FR-024).
//
// An operator may pause a running operation at a SAFE CHECKPOINT and later resume it. Both are
// governed transitions that must be:
//
//   * IDEMPOTENT — pausing an already-paused operation (or resuming an already-running one) is a
//     no-op that returns the same state, never a second effect or an error;
//   * CHECKPOINT-SAFE — a pause is only permitted at a safe checkpoint (no half-applied step); the
//     operation records the checkpoint it paused at so resume restarts from a known-good point;
//   * AUTHORITY-REVALIDATED ON RESUME — resume is NOT a free continuation: authority, policy, and
//     preconditions are re-checked at resume time (the world may have moved while paused), and a
//     source drift forces re-simulation before any further mutation.
//
// Pure decision functions returning structured verdicts over the domain transition graph; they never
// mutate the operation themselves.

import {
  type ControllerOperation,
  type OperationState,
  canOperationTransition,
} from '@trustcircle/domain';

export interface PauseInput {
  readonly operation: ControllerOperation;
  /** True iff the operation is currently at a SAFE checkpoint (no half-applied step). */
  readonly atSafeCheckpoint: boolean;
  /** The checkpoint identifier to record (opaque; e.g. a step id or attempt digest). */
  readonly checkpointId: string;
}

export interface ControlVerdict {
  /** The resulting operation state to persist (unchanged for an idempotent no-op). */
  readonly nextState: OperationState;
  /** True iff this was an idempotent no-op (already in the target state). */
  readonly noop: boolean;
  /** True iff the requested control action is permitted. */
  readonly permitted: boolean;
  readonly reason: string;
}

/**
 * Decide a PAUSE. Idempotent: pausing an already-paused operation is a no-op. Only permitted from a
 * running/continuity state AND at a safe checkpoint. Everything else is refused.
 */
export function decidePause(input: PauseInput): ControlVerdict {
  const { operation } = input;
  if (operation.state === 'paused') {
    return { nextState: 'paused', noop: true, permitted: true, reason: 'already_paused' };
  }
  if (!canOperationTransition(operation.state, 'paused')) {
    return { nextState: operation.state, noop: false, permitted: false, reason: `cannot_pause_from_${operation.state}` };
  }
  if (!input.atSafeCheckpoint) {
    return { nextState: operation.state, noop: false, permitted: false, reason: 'pause_requires_safe_checkpoint' };
  }
  return { nextState: 'paused', noop: false, permitted: true, reason: 'paused_at_safe_checkpoint' };
}

export interface ResumeInput {
  readonly operation: ControllerOperation;
  /** True iff the requester STILL holds authority (re-resolved at resume). */
  readonly authorityStillValid: boolean;
  /** True iff policy STILL authorizes the action (re-resolved at resume). */
  readonly policyStillAuthorizes: boolean;
  /** True iff live preconditions are satisfied at resume. */
  readonly preconditionsSatisfied: boolean;
  /** True iff the source revision is UNCHANGED since the operation was authorized. */
  readonly sourceRevisionUnchanged: boolean;
  /** The state to resume INTO (default 'executing'). */
  readonly resumeInto?: OperationState;
}

export interface ResumeVerdict extends ControlVerdict {
  /** True iff a source drift means the operation must RE-SIMULATE before further mutation (NS-005). */
  readonly requiresResimulation: boolean;
  readonly failedChecks: readonly string[];
}

/**
 * Decide a RESUME. Idempotent: resuming a non-paused (already-running) operation is a no-op. From a
 * paused state, resume REVALIDATES authority + policy + preconditions and refuses on any failure. A
 * source drift does not hard-fail resume but flags that re-simulation is required before further
 * mutation (the execution guard then blocks the mutation until re-simulated).
 */
export function decideResume(input: ResumeInput): ResumeVerdict {
  const { operation } = input;
  const resumeInto = input.resumeInto ?? 'executing';

  if (operation.state !== 'paused') {
    // Idempotent: an already-running operation resumes to itself.
    return {
      nextState: operation.state,
      noop: true,
      permitted: true,
      reason: 'not_paused_resume_is_noop',
      requiresResimulation: false,
      failedChecks: [],
    };
  }

  if (!canOperationTransition('paused', resumeInto)) {
    return {
      nextState: 'paused',
      noop: false,
      permitted: false,
      reason: `cannot_resume_into_${resumeInto}`,
      requiresResimulation: false,
      failedChecks: ['transition'],
    };
  }

  const failedChecks: string[] = [];
  if (!input.authorityStillValid) failedChecks.push('authority');
  if (!input.policyStillAuthorizes) failedChecks.push('policy');
  if (!input.preconditionsSatisfied) failedChecks.push('preconditions');

  if (failedChecks.length > 0) {
    return {
      nextState: 'paused',
      noop: false,
      permitted: false,
      reason: `resume_refused:${failedChecks.join(',')}`,
      requiresResimulation: !input.sourceRevisionUnchanged,
      failedChecks: Object.freeze(failedChecks),
    };
  }

  return {
    nextState: resumeInto,
    noop: false,
    permitted: true,
    reason: input.sourceRevisionUnchanged ? 'resumed' : 'resumed_pending_resimulation',
    requiresResimulation: !input.sourceRevisionUnchanged,
    failedChecks: [],
  };
}
