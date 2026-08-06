// @trustcircle/application — EXECUTION GUARD: revalidate authority, policy, ownership, evidence,
// source revision, preconditions, scope, rate/time bounds, rollback, and reconcile-before-mutation
// IMMEDIATELY BEFORE any governed effect (Phase 6 / User Story 4 / FR-024, FR-025, FR-028, NS-005).
//
// This is the last gate before a controller mutates a real source. Between approval and the actual
// dispatch, the world may have moved — the source may have drifted (invalidating the simulation,
// NS-005), authority may have lapsed, an unreconciled uncertain outcome may be outstanding, ownership
// may have changed, or a rate/time bound may be exhausted. The guard re-checks EVERY precondition at
// the instant of effect and fails CLOSED on any failure. Crucially, it enforces
// RECONCILE-BEFORE-MUTATION (FR-028): if a prior attempt left an UNCERTAIN outcome, no new mutation
// may dispatch until reconciliation has ESTABLISHED the actual remote state.
//
// It is a pure decision function returning a structured verdict (permitted + the list of failed
// checks + a machine reason). It never dispatches; the caller acts only on a fully-permitted verdict.

import {
  type EpochMillis,
  type ControllerOperation,
  type Simulation,
  type BoundVersions,
  type OperationAttempt,
  type ReconciliationRun,
  simulationIsCurrent,
  sourceDriftInvalidates,
  isReadOnlyOperation,
  attemptIsUncertain,
  reconciliationEstablishedState,
} from '@trustcircle/domain';

export interface ExecutionGuardInput {
  readonly operation: ControllerOperation;
  /** The simulation the operation was authorized on (required for a state-changing op). */
  readonly simulation?: Simulation;
  /** The version tuple OBSERVED on the source at the instant of effect. */
  readonly observedVersions: BoundVersions;
  /** True iff the requesting principal STILL holds the required authority (re-resolved now). */
  readonly authorityStillValid: boolean;
  /** True iff the applicable policy version STILL authorizes this action (re-resolved now). */
  readonly policyStillAuthorizes: boolean;
  /** True iff the operation owner is unchanged / still valid. */
  readonly ownershipStillValid: boolean;
  /** True iff the required evidence plan can still be satisfied (evidence writable). */
  readonly evidenceReady: boolean;
  /** True iff every live precondition is currently satisfied. */
  readonly preconditionsSatisfied: boolean;
  /** True iff the effect stays within the approved scope. */
  readonly withinScope: boolean;
  /** True iff the rate/time bounds are NOT exhausted. */
  readonly withinRateTimeBounds: boolean;
  /** True iff a rollback/compensation path is available for a reversible effect (or the effect is
   *  reversible without one). A destructive-irreversible step with no rollback fails closed. */
  readonly rollbackAvailable: boolean;
  /** The most recent attempt for this operation, if any (to detect an unreconciled uncertain state). */
  readonly lastAttempt?: OperationAttempt;
  /** The most recent reconciliation run for this operation, if any. */
  readonly lastReconciliation?: ReconciliationRun;
  readonly now: EpochMillis;
}

export interface ExecutionGuardCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ExecutionGuardVerdict {
  readonly permitted: boolean;
  readonly checks: readonly ExecutionGuardCheck[];
  readonly failed: readonly string[];
  /** True iff execution is blocked pending reconciliation of a prior uncertain outcome (FR-028). */
  readonly blockedPendingReconciliation: boolean;
  readonly reason: string;
}

/**
 * Revalidate every precondition immediately before effect. Read-only operations skip the mutation
 * gates (they cannot change the source). For a state-changing operation, EVERY gate must pass and any
 * unreconciled uncertain prior outcome blocks the dispatch (reconcile-before-mutation).
 */
export function guardExecution(input: ExecutionGuardInput): ExecutionGuardVerdict {
  const { operation } = input;
  const checks: ExecutionGuardCheck[] = [];
  const add = (check: string, passed: boolean, detail: string): void => {
    checks.push({ check, passed, detail });
  };

  const readOnly = isReadOnlyOperation(operation.operationKind);

  // Authority / policy / ownership are re-resolved at the instant of effect for ALL operations.
  add(
    'authority',
    input.authorityStillValid,
    input.authorityStillValid
      ? 'requester still holds required authority'
      : 'authority lapsed since approval',
  );
  add(
    'policy',
    input.policyStillAuthorizes,
    input.policyStillAuthorizes
      ? 'policy still authorizes this action'
      : 'policy no longer authorizes this action',
  );
  add(
    'ownership',
    input.ownershipStillValid,
    input.ownershipStillValid
      ? 'operation ownership unchanged'
      : 'operation ownership changed/invalid',
  );
  add(
    'evidence',
    input.evidenceReady,
    input.evidenceReady ? 'evidence plan satisfiable' : 'required evidence cannot be recorded',
  );
  add(
    'preconditions',
    input.preconditionsSatisfied,
    input.preconditionsSatisfied
      ? 'live preconditions satisfied'
      : 'a live precondition is unsatisfied',
  );

  let blockedPendingReconciliation = false;

  if (!readOnly) {
    // Simulate-before-execute + source-drift (NS-005): a current, still-binding simulation is required.
    if (input.simulation === undefined) {
      add('simulation-binding', false, 'no simulation bound to a state-changing operation');
    } else {
      const current = simulationIsCurrent(input.simulation, input.now);
      const invalidated = sourceDriftInvalidates(
        input.simulation,
        input.observedVersions,
        input.now,
      );
      add(
        'simulation-binding',
        current && !invalidated,
        invalidated
          ? 'simulation invalidated by expiry or source/version drift (NS-005)'
          : 'simulation current and binding',
      );
    }

    // Source revision must match what the operation was authorized on (defence in depth beyond the
    // simulation binding — the operation's own desired tuple must equal the observed tuple).
    const sourceMatches =
      operation.desiredVersions.sourceRevision === input.observedVersions.sourceRevision;
    add(
      'source-revision',
      sourceMatches,
      sourceMatches
        ? 'observed source revision matches authorized revision'
        : 'source revision drifted since authorization',
    );

    add(
      'scope',
      input.withinScope,
      input.withinScope ? 'effect within approved scope' : 'effect exceeds approved scope',
    );
    add(
      'rate-time-bounds',
      input.withinRateTimeBounds,
      input.withinRateTimeBounds ? 'within rate/time bounds' : 'rate/time bounds exhausted',
    );
    add(
      'rollback',
      input.rollbackAvailable,
      input.rollbackAvailable
        ? 'rollback/compensation available'
        : 'no rollback path for a reversible effect',
    );

    // RECONCILE-BEFORE-MUTATION (FR-028): an outstanding uncertain outcome must be reconciled to an
    // established state before any NEW mutation dispatches.
    const uncertainOutstanding =
      input.lastAttempt !== undefined &&
      attemptIsUncertain(input.lastAttempt) &&
      !(
        input.lastReconciliation !== undefined &&
        reconciliationEstablishedState(input.lastReconciliation)
      );
    blockedPendingReconciliation = uncertainOutstanding;
    add(
      'reconcile-before-mutation',
      !uncertainOutstanding,
      uncertainOutstanding
        ? 'a prior uncertain outcome must be reconciled before a new mutation (FR-028)'
        : 'no unreconciled uncertain outcome outstanding',
    );
  }

  const failed = checks.filter((c) => !c.passed).map((c) => c.check);
  const permitted = failed.length === 0;
  let reason: string;
  if (permitted) reason = readOnly ? 'read_only_permitted' : 'all_execution_gates_passed';
  else if (blockedPendingReconciliation) reason = 'blocked_pending_reconciliation';
  else reason = `execution_refused:${failed.join(',')}`;

  return {
    permitted,
    checks: Object.freeze(checks),
    failed: Object.freeze(failed),
    blockedPendingReconciliation,
    reason,
  };
}
