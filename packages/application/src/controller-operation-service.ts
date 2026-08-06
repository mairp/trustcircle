// @trustcircle/application — CONTROLLER OPERATION SERVICE: create governed operations with pinned
// desired/observed version tuples, ONE idempotency identity, and valid-next-action checks
// (Phase 6 / User Story 4 / FR-024, FR-026, FR-027).
//
// A controller operation is the governed unit of work against a controller instance. This service is
// the thin coordinator that CREATES an operation (delegating the one-idempotency-identity + simulate/
// approve-before-execute invariants to `makeControllerOperation`), DEDUPLICATES a replayed request to
// the SAME operation (FR-026/027 — a replay never creates a second governed effect), and reports the
// VALID NEXT ACTIONS an operator may take from the operation's current state (FR-024 —
// `allowedNextOperations`). It also gates a requested transition through the domain transition graph.
//
// One idempotency identity (FR-027): the caller passes the durable set of existing (idempotencyKey →
// operationId) bindings for the tenant; `createOrGetOperation` returns the existing operation on a
// replay and constructs a new one only for a novel key. Pure and clock-free.

import {
  type Uuid,
  type TenantId,
  type EpochMillis,
  type OperationKind,
  type RiskClass,
  type BoundVersions,
  type ControllerOperation,
  type OperationState,
  makeControllerOperation,
  controllerOperationDigest,
  allowedNextOperations,
  canOperationTransition,
  assertOperationTransition,
  isReadOnlyOperation,
} from '@trustcircle/domain';

export interface CreateOperationInput {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerInstanceId: Uuid;
  readonly operationKind: OperationKind;
  readonly requestedByPrincipalId: Uuid;
  readonly ownerPrincipalId: Uuid;
  readonly idempotencyKey: string;
  readonly riskClass?: RiskClass;
  readonly desiredVersions: BoundVersions;
  readonly observedVersions?: BoundVersions;
  readonly simulationId?: Uuid;
  readonly approvalDecisionId?: Uuid;
  readonly steps?: readonly Record<string, unknown>[];
  readonly bounds?: Record<string, unknown>;
  readonly evidencePlan?: Record<string, unknown>;
  readonly continuityLeaseId?: Uuid;
  readonly state?: OperationState;
  readonly requestedAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export interface OperationCreation {
  readonly operation: ControllerOperation;
  readonly digest: string;
  /** True iff this returned an EXISTING operation for a replayed idempotency key (no new effect). */
  readonly deduplicated: boolean;
  /** The valid next operation kinds from the created/looked-up operation's state (FR-024). */
  readonly allowedNext: readonly OperationKind[];
}

/** A minimal read port: resolve a prior operation by (tenant, idempotency key) for replay dedup. */
export interface OperationLookupPort {
  readonly findByIdempotencyKey: (
    tenantId: TenantId,
    idempotencyKey: string,
  ) => ControllerOperation | undefined;
}

/**
 * Create a new governed operation, or return the EXISTING one for a replayed idempotency key (FR-026/
 * FR-027 — one idempotency identity; a replay never produces a second governed effect). The domain
 * factory enforces the simulate/approve-before-execute and continuity-lease invariants.
 */
export function createOrGetOperation(
  input: CreateOperationInput,
  lookup: OperationLookupPort,
): OperationCreation {
  const existing = lookup.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
  if (existing !== undefined) {
    return {
      operation: existing,
      digest: controllerOperationDigest(existing),
      deduplicated: true,
      allowedNext: allowedNextOperations(existing.state),
    };
  }

  const operation = makeControllerOperation({
    id: input.id,
    tenantId: input.tenantId,
    controllerInstanceId: input.controllerInstanceId,
    operationKind: input.operationKind,
    requestedByPrincipalId: input.requestedByPrincipalId,
    ownerPrincipalId: input.ownerPrincipalId,
    idempotencyKey: input.idempotencyKey,
    desiredVersions: input.desiredVersions,
    requestedAt: input.requestedAt,
    updatedAt: input.updatedAt,
    // exactOptionalPropertyTypes: forward each optional only when present, never as explicit undefined.
    ...(input.riskClass !== undefined ? { riskClass: input.riskClass } : {}),
    ...(input.observedVersions !== undefined ? { observedVersions: input.observedVersions } : {}),
    ...(input.simulationId !== undefined ? { simulationId: input.simulationId } : {}),
    ...(input.approvalDecisionId !== undefined ? { approvalDecisionId: input.approvalDecisionId } : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(input.bounds !== undefined ? { bounds: input.bounds } : {}),
    ...(input.evidencePlan !== undefined ? { evidencePlan: input.evidencePlan } : {}),
    ...(input.continuityLeaseId !== undefined ? { continuityLeaseId: input.continuityLeaseId } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
  });

  return {
    operation,
    digest: controllerOperationDigest(operation),
    deduplicated: false,
    allowedNext: allowedNextOperations(operation.state),
  };
}

export interface NextActionVerdict {
  readonly permitted: boolean;
  readonly allowedNext: readonly OperationKind[];
  readonly reason: string;
}

/**
 * Decide whether an operator may request `requestedKind` given the operation's current state (FR-024).
 * Only kinds in the state's `allowedNextOperations` set are permitted — everything else is refused so
 * an operator can never drive an operation off its governed lifecycle.
 */
export function checkNextAction(
  operation: ControllerOperation,
  requestedKind: OperationKind,
): NextActionVerdict {
  const allowedNext = allowedNextOperations(operation.state);
  const permitted = allowedNext.includes(requestedKind);
  return {
    permitted,
    allowedNext,
    reason: permitted
      ? 'action_permitted_for_current_state'
      : `action_${requestedKind}_not_valid_from_state_${operation.state}`,
  };
}

export interface OperationTransitionVerdict {
  readonly permitted: boolean;
  readonly reason: string;
}

/** Decide whether the operation may transition to `to` (domain transition graph). Non-throwing. */
export function checkOperationTransition(
  operation: ControllerOperation,
  to: OperationState,
): OperationTransitionVerdict {
  const permitted = canOperationTransition(operation.state, to);
  return {
    permitted,
    reason: permitted ? 'transition_permitted' : `illegal_transition_${operation.state}_to_${to}`,
  };
}

/** Throwing form of the transition gate (mirrors the domain assert), for callers that fail hard. */
export function assertOperationTransitionAllowed(
  operation: ControllerOperation,
  to: OperationState,
): void {
  assertOperationTransition(operation.state, to);
}

/** True iff the operation is read-only (never mutates the remote source; needs no execution gate). */
export function operationIsReadOnly(operation: ControllerOperation): boolean {
  return isReadOnlyOperation(operation.operationKind);
}
