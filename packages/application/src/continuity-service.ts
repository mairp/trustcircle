// @trustcircle/application — CONTINUITY SERVICE: enter and enforce BOUNDED continuity ONLY for an
// operation approved AND started before the failure, with locally-verifiable conditions
// (Phase 6 / User Story 4 / FR-046, FR-047, FR-048, FR-049, FR-050, NFR-012, SC-021).
//
// When a controller loses health or connectivity to the platform mid-operation, it may — under strict
// bounds — CONTINUE the already-approved, already-started operation for a short, NONRENEWABLE window
// so an in-flight governed change is not abandoned half-done. Continuity NEVER creates new authority:
//
//   * IN-PROGRESS ONLY (FR-047): a lease may be granted ONLY for an operation that was approved AND
//     had already started before the failure. An operation that had not started gets NO lease — a
//     lease for it would be a new-authority grant.
//   * BOUNDED + NONRENEWABLE (NFR-012): a lease may not exceed 15 minutes and cannot renew itself;
//     renewal requires restored health + reconciliation.
//   * PINNED POLICY (FR-046): the lease acts ONLY under the policy snapshot captured at grant time.
//   * LOCALLY VERIFIABLE (FR-048): each step may execute only while its authority/scope/precondition/
//     safety conditions are LOCALLY revalidatable; a new consequential/destructive step that cannot be
//     locally revalidated PAUSES.
//   * EVIDENCE BUFFERED (FR-049): evidence is buffered locally and flushed on reconciliation.
//   * RECONCILE ON RETURN (FR-050): on restored health the buffered effects reconcile before any new
//     mutation.
//
// This service delegates the ceiling + pre-failure + step-gate invariants to the domain
// (`makeControllerContinuityLease`, `continuityMayExecuteStep`); it is the thin coordinator that
// decides ELIGIBILITY to enter continuity and constructs the lease. Pure and clock-free.

import {
  type Uuid,
  type TenantId,
  type EpochMillis,
  type OperationKind,
  type ControllerOperation,
  type ControllerContinuityLease,
  type ControllerContinuityLeaseState,
  CONTINUITY_LEASE_CEILING_MS,
  makeControllerContinuityLease,
  controllerContinuityLeaseDigest,
  controllerContinuityLeaseActiveAt,
  continuityMayExecuteStep,
} from '@trustcircle/domain';

export interface ContinuityEligibilityInput {
  readonly operation: ControllerOperation;
  /** True iff the operation had ALREADY STARTED executing before the failure (FR-047). */
  readonly operationStartedBeforeFailure: boolean;
  /** True iff the operation was approved (carries an approval decision). */
  readonly operationApproved: boolean;
}

export interface ContinuityEligibilityVerdict {
  readonly eligible: boolean;
  readonly reason: string;
}

/**
 * Decide whether an operation may ENTER bounded continuity. Eligible ONLY when it was approved AND had
 * already started before the failure (FR-047 in-progress-only). Everything else is refused — continuity
 * can never start a new operation.
 */
export function evaluateContinuityEligibility(
  input: ContinuityEligibilityInput,
): ContinuityEligibilityVerdict {
  if (!input.operationApproved || input.operation.approvalDecisionId === undefined) {
    return { eligible: false, reason: 'operation_not_approved' };
  }
  if (!input.operationStartedBeforeFailure) {
    return { eligible: false, reason: 'operation_not_started_before_failure' };
  }
  const startable = (['executing', 'continuity', 'paused', 'reconciling'] as const).includes(
    input.operation.state as 'executing' | 'continuity' | 'paused' | 'reconciling',
  );
  if (!startable) {
    return { eligible: false, reason: `operation_state_${input.operation.state}_not_in_progress` };
  }
  return { eligible: true, reason: 'approved_and_in_progress' };
}

export interface GrantContinuityLeaseInput {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly operation: ControllerOperation;
  readonly continuityPolicyVersionId: Uuid;
  readonly policySnapshot?: Record<string, unknown>;
  readonly eligibleOperationClasses?: readonly OperationKind[];
  readonly actionLimit?: number;
  readonly resourceLimits?: Record<string, unknown>;
  readonly requiredLocalObservations?: readonly string[];
  readonly stopConditions?: readonly Record<string, unknown>[];
  readonly ownerPrincipalId: Uuid;
  readonly operationStartedBeforeFailure: boolean;
  readonly operationApproved: boolean;
  readonly grantedAt: EpochMillis;
  /** Requested expiry; clamped to the 15-minute ceiling. */
  readonly expiresAt?: EpochMillis;
  readonly requestedDurationMs?: number;
  readonly state?: ControllerContinuityLeaseState;
}

export interface GrantedContinuityLease {
  readonly lease: ControllerContinuityLease;
  readonly digest: string;
}

/**
 * Grant a bounded continuity lease for an eligible operation. Refuses (throws) an ineligible operation
 * BEFORE constructing the lease. The requested duration is clamped to the 15-minute ceiling; the
 * domain factory then enforces the ceiling and the pre-failure invariant.
 */
export function grantContinuityLease(input: GrantContinuityLeaseInput): GrantedContinuityLease {
  const eligibility = evaluateContinuityEligibility({
    operation: input.operation,
    operationStartedBeforeFailure: input.operationStartedBeforeFailure,
    operationApproved: input.operationApproved,
  });
  if (!eligibility.eligible) {
    throw new TypeError(`continuity lease refused: ${eligibility.reason} (continuity never grants new authority, FR-047)`);
  }

  const requested = input.requestedDurationMs ?? CONTINUITY_LEASE_CEILING_MS;
  const clamped = Math.min(requested, CONTINUITY_LEASE_CEILING_MS);
  const expiresAt = input.expiresAt ?? input.grantedAt + clamped;

  const lease = makeControllerContinuityLease({
    id: input.id,
    tenantId: input.tenantId,
    operationId: input.operation.id,
    continuityPolicyVersionId: input.continuityPolicyVersionId,
    // exactOptionalPropertyTypes: forward each optional only when present, never as explicit undefined.
    ...(input.policySnapshot !== undefined ? { policySnapshot: input.policySnapshot } : {}),
    ...(input.eligibleOperationClasses !== undefined ? { eligibleOperationClasses: input.eligibleOperationClasses } : {}),
    ...(input.actionLimit !== undefined ? { actionLimit: input.actionLimit } : {}),
    ...(input.resourceLimits !== undefined ? { resourceLimits: input.resourceLimits } : {}),
    ...(input.requiredLocalObservations !== undefined ? { requiredLocalObservations: input.requiredLocalObservations } : {}),
    ...(input.stopConditions !== undefined ? { stopConditions: input.stopConditions } : {}),
    ownerPrincipalId: input.ownerPrincipalId,
    operationStartedBeforeFailure: input.operationStartedBeforeFailure,
    grantedAt: input.grantedAt,
    expiresAt,
    ...(input.state !== undefined ? { state: input.state } : {}),
  });

  return { lease, digest: controllerContinuityLeaseDigest(lease) };
}

export interface ContinuityStepInput {
  readonly lease: ControllerContinuityLease;
  readonly operationKind: OperationKind;
  readonly now: EpochMillis;
  readonly localObservationsSatisfied: boolean;
  readonly stepIsNewConsequential: boolean;
  readonly liveSafetyLocallyVerifiable: boolean;
  readonly actionsAlreadyTaken: number;
}

/**
 * The CONTINUITY STEP GATE (FR-048 / SC-021): may this controller execute this step under the lease
 * NOW? Delegates to the domain gate (lease active + unexpired; kind eligible; action limit; local
 * observations; new consequential step locally verifiable). Returns a structured verdict.
 */
export function mayExecuteContinuityStep(input: ContinuityStepInput): {
  readonly permitted: boolean;
  readonly reason: string;
} {
  return continuityMayExecuteStep({
    lease: input.lease,
    operationKind: input.operationKind,
    now: input.now,
    localObservationsSatisfied: input.localObservationsSatisfied,
    stepIsNewConsequential: input.stepIsNewConsequential,
    liveSafetyLocallyVerifiable: input.liveSafetyLocallyVerifiable,
    actionsAlreadyTaken: input.actionsAlreadyTaken,
  });
}

/** True iff the lease is still active (unexpired) at `now`; beyond it the controller MUST pause. */
export function continuityLeaseActive(lease: ControllerContinuityLease, now: EpochMillis): boolean {
  return controllerContinuityLeaseActiveAt(lease, now);
}

/**
 * On restored health, decide whether continuity must reconcile before any new mutation (FR-050). The
 * answer is always YES when any effect was buffered under the lease — the buffered effects reconcile
 * FIRST. Returns the reconciliation obligation.
 */
export function continuityReturnObligation(input: {
  readonly bufferedEffectCount: number;
}): { readonly mustReconcileBeforeMutation: boolean; readonly reason: string } {
  if (input.bufferedEffectCount > 0) {
    return { mustReconcileBeforeMutation: true, reason: 'buffered_continuity_effects_must_reconcile_first' };
  }
  return { mustReconcileBeforeMutation: false, reason: 'no_buffered_effects' };
}
