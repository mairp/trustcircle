// @trustcircle/application — OPERATION RECONCILIATION: reconcile desired, dispatched, remote,
// observed, and canonical states WITHOUT inferring success from acknowledgements
// (Phase 6 / User Story 4 / FR-027, FR-028, SC-010, SC-011).
//
// After a dispatch — especially a dispatch whose acknowledgement was lost, timed out, or arrived
// without a confirmed effect — the platform does NOT know whether the remote change happened. It must
// RECONCILE: read the AUTHORITATIVE CURRENT remote state and compare it to the desired/dispatched
// state. The cardinal rule (FR-028) is that success is NEVER inferred from an acknowledgement — a
// `reconciled_effect_present` verdict REQUIRES a direct remote OBSERVATION. The one-effect rule
// (SC-011) is that a single logical dispatch, even if retried, must resolve to EXACTLY ONE effect;
// observing more than one is a duplicate-effect divergence, not a success.
//
// This service builds the reconciliation verdict from the observed facts and constructs the domain
// `ReconciliationRun` (which enforces both invariants). It classifies the outcome:
//
//   * reconciled_effect_present — exactly one effect observed via a direct remote read;
//   * reconciled_no_effect      — a direct remote read shows the dispatch did NOT take effect
//                                 (the retry/redispatch is now safe — idempotent);
//   * still_uncertain           — the remote could not be read authoritatively (stay blocked);
//   * conflict                  — the remote holds a DIFFERENT, newer state than desired;
//   * failed                    — reconciliation itself failed.
//
// Pure and clock-free (the caller supplies `ranAt`).

import {
  type Uuid,
  type TenantId,
  type EpochMillis,
  type Reason,
  type ReconciliationRun,
  type ReconciliationResult,
  makeReason,
  makeReconciliationRun,
  reconciliationRunDigest,
  reconciliationEstablishedState,
} from '@trustcircle/domain';

export interface ReconcileInput {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly operationId: Uuid;
  readonly desiredState?: Record<string, unknown>;
  readonly dispatchedState?: Record<string, unknown>;
  /** The AUTHORITATIVE current remote state read directly (undefined ⇒ could not read). */
  readonly remoteObservedState?: Record<string, unknown>;
  readonly canonicalState?: Record<string, unknown>;
  readonly reconciledAttemptIds?: readonly Uuid[];
  /** Number of effects observed on the remote for this single logical dispatch (SC-011). */
  readonly observedEffectCount: number;
  /** True iff the remote could be read DIRECTLY (never an acknowledgement). */
  readonly usedRemoteObservation: boolean;
  /** True iff the observed remote state MATCHES the desired end state. */
  readonly remoteMatchesDesired: boolean;
  /** True iff the remote holds a different, NEWER legitimate state (conflict). */
  readonly remoteHoldsNewerState?: boolean;
  readonly ranAt: EpochMillis;
}

export interface ReconciliationOutcome {
  readonly run: ReconciliationRun;
  readonly digest: string;
  /** True iff this reconciliation ESTABLISHED actual state (a new mutation is now permitted). */
  readonly establishedState: boolean;
  /** True iff a duplicate effect was observed (SC-011 violation surfaced, never hidden). */
  readonly duplicateEffect: boolean;
}

/**
 * Classify + construct the reconciliation. Fail-closed and observation-first: without a direct remote
 * observation the result is `still_uncertain` (never inferred present). A duplicate effect (>1) is a
 * `conflict` divergence surfaced explicitly.
 */
export function reconcileOperation(input: ReconcileInput): ReconciliationOutcome {
  const duplicateEffect = input.observedEffectCount > 1;

  let result: ReconciliationResult;
  let reason: Reason;

  if (!input.usedRemoteObservation || input.remoteObservedState === undefined) {
    // Could not read the authoritative remote — the effect is still unknown; stay blocked.
    result = 'still_uncertain';
    reason = makeReason(
      'remote_unobservable',
      'the authoritative remote state could not be read; the effect remains unknown and no new mutation may proceed',
    );
  } else if (duplicateEffect) {
    // A single logical dispatch produced more than one observed effect — a duplicate governed effect.
    result = 'conflict';
    reason = makeReason(
      'duplicate_effect',
      `observed ${input.observedEffectCount} effects for a single logical dispatch (SC-011 one-effect rule violated); surfaced as a conflict for compensation`,
    );
  } else if (input.remoteHoldsNewerState === true && !input.remoteMatchesDesired) {
    result = 'conflict';
    reason = makeReason(
      'newer_remote_state',
      'the remote holds a different, newer legitimate state than desired; reconciled as a conflict (protect newer state)',
    );
  } else if (input.remoteMatchesDesired && input.observedEffectCount === 1) {
    // Exactly one effect, directly observed — the change is present and confirmed.
    result = 'reconciled_effect_present';
    reason = makeReason(
      'effect_present',
      'a single remote effect was directly observed; the desired change is present (confirmed by observation, not acknowledgement)',
    );
  } else if (input.observedEffectCount === 0) {
    // Directly observed that the dispatch did NOT take effect — a redispatch is safe (idempotent).
    result = 'reconciled_no_effect';
    reason = makeReason(
      'no_effect',
      'a direct remote read shows the dispatch did not take effect; a redispatch under the same idempotency identity is safe',
    );
  } else {
    result = 'still_uncertain';
    reason = makeReason(
      'inconclusive',
      'the remote observation did not conclusively establish presence or absence of the effect',
    );
  }

  const run = makeReconciliationRun({
    id: input.id,
    tenantId: input.tenantId,
    operationId: input.operationId,
    observedEffectCount: input.observedEffectCount,
    usedRemoteObservation: input.usedRemoteObservation,
    result,
    reason,
    ranAt: input.ranAt,
    // exactOptionalPropertyTypes: forward each optional only when present, never as explicit undefined.
    ...(input.desiredState !== undefined ? { desiredState: input.desiredState } : {}),
    ...(input.dispatchedState !== undefined ? { dispatchedState: input.dispatchedState } : {}),
    ...(input.remoteObservedState !== undefined
      ? { remoteObservedState: input.remoteObservedState }
      : {}),
    ...(input.canonicalState !== undefined ? { canonicalState: input.canonicalState } : {}),
    ...(input.reconciledAttemptIds !== undefined
      ? { reconciledAttemptIds: input.reconciledAttemptIds }
      : {}),
  });

  return {
    run,
    digest: reconciliationRunDigest(run),
    establishedState: reconciliationEstablishedState(run),
    duplicateEffect,
  };
}

/**
 * Gate a NEW mutation on reconciliation (FR-028 reconcile-before-mutation). A new mutation is
 * permitted only when the latest reconciliation ESTABLISHED actual state. Returns a structured verdict.
 */
export function mayMutateAfterReconciliation(latest: ReconciliationRun | undefined): {
  readonly permitted: boolean;
  readonly reason: string;
} {
  if (latest === undefined) {
    return { permitted: false, reason: 'no_reconciliation_run_yet' };
  }
  if (!reconciliationEstablishedState(latest)) {
    return {
      permitted: false,
      reason: `reconciliation_result_${latest.result}_did_not_establish_state`,
    };
  }
  return { permitted: true, reason: 'state_established_mutation_permitted' };
}
