// @trustcircle/projections — CONTROLLER + OPERATION PROJECTIONS
// (Phase 6 / User Story 4 / FR-023, FR-024, FR-027, FR-028, FR-050, SC-010, SC-011).
//
// An operator's controller view is only trustworthy if every controller shows, at a glance and WITHOUT
// trusting a mutation echo: its declared version and owner, its DESIRED versus OBSERVED state (and the
// visible DRIFT between them), its health, its dependencies, and its active operation. And every
// operation must show its lifecycle state, the continuity lease bounding it (if any), its progress and
// attempts, its failures and retry posture, its collected evidence, and — critically — the EXACT set of
// next actions permitted from its current state (FR-024). This module is the pure, deterministic fold
// that produces those two read models.
//
// THE LOAD-BEARING RULES this projector encodes (never inferring more than the facts support):
//   * DRIFT IS VISIBLE (FR-024). A controller row's `drift` is derived from desired ≠ observed state; it
//     is never hidden by a healthy status. An operation row's `authorizedRevisionDrift` is derived from
//     desired ≠ observed version tuple.
//   * NEXT ACTIONS ARE GOVERNED (FR-024). `nextPermittedActions` for an operation comes from the domain
//     `allowedNextOperations(state)` — the projector never widens the set, so the UI can only offer what
//     the lifecycle permits.
//   * UNCERTAINTY IS NOT SUCCESS (FR-028 / SC-011). An operation whose latest attempt is uncertain is
//     projected `awaitingReconciliation: true` and is NEVER shown as succeeded until a reconciliation
//     established actual state; the projector reads `latestAttemptOutcome` + `reconciliationEstablished`
//     as INPUTS and refuses to synthesize a positive outcome.
//   * CONTINUITY IS BOUNDED + VISIBLE (FR-050). A continuity lease's expiry is projected verbatim so an
//     expired lease reads as expired, and a continuity-mode operation always carries its lease id.
//
// It is a pure fold: it holds only the ingested rows, derives everything at an INJECTED instant `at`
// (never a wall-clock read), and exposes a `snapshotDigest(at)` as the independently-observable
// durable-effect witness. It mirrors the integrity-projector idiom exactly.

import { createHash } from 'node:crypto';
import {
  type Uuid,
  type EpochMillis,
  type OperationKind,
  type OperationState,
  type HealthState,
  type AttemptOutcome,
  OPERATION_KINDS,
  OPERATION_STATES,
  HEALTH_STATES,
  ATTEMPT_OUTCOMES,
  UNCERTAIN_ATTEMPT_OUTCOMES,
  TERMINAL_OPERATION_STATES,
  allowedNextOperations,
} from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// Module-private guards + hashing (fail-visible; not exported).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(v: unknown): v is Uuid {
  return typeof v === 'string' && UUID_RE.test(v);
}
function reqUuid(v: unknown, label: string): Uuid {
  if (!isUuidLike(v)) throw new TypeError(`${label} must be a UUID`);
  return v;
}
function reqEpoch(v: unknown, label: string): EpochMillis {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms`);
  }
  return v;
}
function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}
function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ===========================================================================
// 1. CONTROLLER REGISTRY ROW — one running controller instance as the operator
//    sees it: version, owner, health, desired-vs-observed state + drift, deps,
//    active operation (FR-024, FR-029).
// ===========================================================================

export interface ControllerRegistryInput {
  readonly instanceId: Uuid;
  readonly tenantId: Uuid;
  readonly controllerId: Uuid;
  readonly controllerVersionId: Uuid;
  readonly controllerVersion: number;
  readonly name: string;
  readonly ownerPrincipalId: Uuid;
  readonly adapterVersionId: Uuid;
  readonly health: HealthState;
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly sourceRevision: string;
  readonly dependencies: readonly Readonly<Record<string, unknown>>[];
  readonly activeOperationId: Uuid | null;
  readonly lastObservationAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export interface ControllerRegistryRow {
  readonly instanceId: Uuid;
  readonly tenantId: Uuid;
  readonly controllerId: Uuid;
  readonly controllerVersionId: Uuid;
  readonly controllerVersion: number;
  readonly name: string;
  readonly ownerPrincipalId: Uuid;
  readonly adapterVersionId: Uuid;
  readonly health: HealthState;
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly sourceRevision: string;
  readonly dependencies: readonly Readonly<Record<string, unknown>>[];
  readonly activeOperationId: Uuid | null;
  /** True iff desired ≠ observed state — the visible drift (FR-024). Never masked by health. */
  readonly drift: boolean;
  /** True iff a dependency is declared unhealthy (any dependency `healthy:false`). */
  readonly dependencyDegraded: boolean;
  /** True iff the controller needs operator attention (unhealthy OR drifted OR dependency degraded). */
  readonly needsAttention: boolean;
  readonly ageMillis: number;
  readonly priority: number;
}

const HEALTH_WEIGHT: Readonly<Record<HealthState, number>> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  stale: 3,
  unavailable: 4,
};

function dependencyDegradedOf(deps: readonly Readonly<Record<string, unknown>>[]): boolean {
  return deps.some((d) => d['healthy'] === false || d['health'] === 'unavailable' || d['health'] === 'degraded');
}

/** Priority a controller row sorts by (higher = more urgent). Health + drift + dependency posture. */
export function controllerPriorityOf(row: {
  readonly health: HealthState;
  readonly drift: boolean;
  readonly dependencyDegraded: boolean;
}): number {
  let p = HEALTH_WEIGHT[row.health] * 100;
  if (row.drift) p += 50;
  if (row.dependencyDegraded) p += 30;
  return p;
}

// ===========================================================================
// 2. OPERATION ROW — one governed operation as the operator sees it: lifecycle
//    state, lease, progress, attempts, failures, retries, evidence, and the
//    EXACT permitted next actions (FR-024, FR-027, FR-028, FR-050).
// ===========================================================================

export interface OperationProjectionInput {
  readonly operationId: Uuid;
  readonly tenantId: Uuid;
  readonly controllerInstanceId: Uuid;
  readonly operationKind: OperationKind;
  readonly state: OperationState;
  readonly ownerPrincipalId: Uuid;
  readonly requestedByPrincipalId: Uuid;
  /** True iff the operation's observed version tuple drifted from the authorized (desired) tuple. */
  readonly authorizedRevisionDrift: boolean;
  readonly simulationId: Uuid | null;
  readonly approvalDecisionId: Uuid | null;
  readonly continuityLeaseId: Uuid | null;
  /** Absolute expiry instant of the active continuity lease, or null when none. */
  readonly continuityLeaseExpiresAt: EpochMillis | null;
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly attemptCount: number;
  /** The outcome of the most recent dispatch attempt, or null when none has run. */
  readonly latestAttemptOutcome: AttemptOutcome | null;
  /** True iff the latest reconciliation established actual state (present/no_effect). */
  readonly reconciliationEstablished: boolean;
  readonly reconciliationRunId: Uuid | null;
  readonly rollbackResult: string | null;
  readonly evidenceBundleId: Uuid | null;
  readonly failureDetail: string | null;
  readonly requestedAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export interface OperationRow {
  readonly operationId: Uuid;
  readonly tenantId: Uuid;
  readonly controllerInstanceId: Uuid;
  readonly operationKind: OperationKind;
  readonly state: OperationState;
  readonly ownerPrincipalId: Uuid;
  readonly requestedByPrincipalId: Uuid;
  readonly authorizedRevisionDrift: boolean;
  readonly simulationId: Uuid | null;
  readonly approvalDecisionId: Uuid | null;
  readonly continuityLeaseId: Uuid | null;
  readonly continuityLeaseExpiresAt: EpochMillis | null;
  /** True iff the operation is in continuity mode AND the lease has not yet expired at `at`. */
  readonly continuityLeaseActive: boolean;
  readonly totalSteps: number;
  readonly completedSteps: number;
  /** Fraction 0..1 of steps completed (0 when no steps declared). */
  readonly progress: number;
  readonly attemptCount: number;
  readonly latestAttemptOutcome: AttemptOutcome | null;
  /** True iff the latest attempt outcome is uncertain (dispatched_unconfirmed/uncertain/timed_out). */
  readonly latestOutcomeUncertain: boolean;
  /** True iff the operation must reconcile before any new mutation (uncertain AND not yet established). */
  readonly awaitingReconciliation: boolean;
  readonly reconciliationRunId: Uuid | null;
  readonly rollbackResult: string | null;
  readonly evidenceBundleId: Uuid | null;
  readonly failed: boolean;
  readonly failureDetail: string | null;
  readonly terminal: boolean;
  /** The EXACT next operation kinds permitted from this state (FR-024) — never widened. */
  readonly nextPermittedActions: readonly OperationKind[];
  readonly ageMillis: number;
  readonly priority: number;
}

const UNCERTAIN_SET: ReadonlySet<AttemptOutcome> = new Set(UNCERTAIN_ATTEMPT_OUTCOMES);
const TERMINAL_SET: ReadonlySet<OperationState> = new Set(TERMINAL_OPERATION_STATES);
const FAILED_STATES: ReadonlySet<OperationState> = new Set(['failed', 'escalated']);

/** The priority an operation row sorts by (higher = more urgent). */
export function operationPriorityOf(row: {
  readonly awaitingReconciliation: boolean;
  readonly failed: boolean;
  readonly continuityLeaseActive: boolean;
  readonly authorizedRevisionDrift: boolean;
  readonly terminal: boolean;
}): number {
  let p = 0;
  if (row.awaitingReconciliation) p += 120; // an unresolved uncertain outcome blocks progress.
  if (row.failed) p += 100;
  if (row.continuityLeaseActive) p += 80; // a running continuity lease is time-bounded — attend now.
  if (row.authorizedRevisionDrift) p += 40;
  if (row.terminal) p -= 200; // terminal operations sink to the bottom.
  return p;
}

// ---------------------------------------------------------------------------
// The projector.
// ---------------------------------------------------------------------------

export interface ControllerProjectorInput {
  readonly tenantId: Uuid;
}

export class ControllerProjector {
  readonly #tenantId: Uuid;
  readonly #controllers = new Map<string, ControllerRegistryInput>();
  readonly #operations = new Map<string, OperationProjectionInput>();

  constructor(input: ControllerProjectorInput) {
    this.#tenantId = reqUuid(input.tenantId, 'projector.tenantId');
  }

  get tenantId(): Uuid {
    return this.#tenantId;
  }

  /** Ingest one controller-instance input. Validated fail-visibly + tenant-guarded. Last write wins. */
  ingestController(input: ControllerRegistryInput): void {
    const instanceId = reqUuid(input.instanceId, 'input.instanceId');
    if (reqUuid(input.tenantId, 'input.tenantId') !== this.#tenantId) {
      throw new TypeError(`controller ${instanceId} belongs to another tenant — refused`);
    }
    reqUuid(input.controllerId, 'input.controllerId');
    reqUuid(input.controllerVersionId, 'input.controllerVersionId');
    reqUuid(input.ownerPrincipalId, 'input.ownerPrincipalId');
    reqUuid(input.adapterVersionId, 'input.adapterVersionId');
    if (!HEALTH_STATES.includes(input.health)) throw new TypeError(`input.health invalid: ${input.health}`);
    if (typeof input.sourceRevision !== 'string' || input.sourceRevision.length === 0) {
      throw new TypeError('input.sourceRevision must be a non-empty string');
    }
    if (input.activeOperationId !== null) reqUuid(input.activeOperationId, 'input.activeOperationId');
    reqEpoch(input.lastObservationAt, 'input.lastObservationAt');
    reqEpoch(input.updatedAt, 'input.updatedAt');
    this.#controllers.set(instanceId, input);
  }

  /** Ingest one operation input. Validated fail-visibly + tenant-guarded. Last write wins. */
  ingestOperation(input: OperationProjectionInput): void {
    const operationId = reqUuid(input.operationId, 'input.operationId');
    if (reqUuid(input.tenantId, 'input.tenantId') !== this.#tenantId) {
      throw new TypeError(`operation ${operationId} belongs to another tenant — refused`);
    }
    reqUuid(input.controllerInstanceId, 'input.controllerInstanceId');
    if (!OPERATION_KINDS.includes(input.operationKind)) {
      throw new TypeError(`input.operationKind invalid: ${input.operationKind}`);
    }
    if (!OPERATION_STATES.includes(input.state)) throw new TypeError(`input.state invalid: ${input.state}`);
    if (input.latestAttemptOutcome !== null && !ATTEMPT_OUTCOMES.includes(input.latestAttemptOutcome)) {
      throw new TypeError(`input.latestAttemptOutcome invalid: ${input.latestAttemptOutcome}`);
    }
    if (!Number.isInteger(input.totalSteps) || input.totalSteps < 0) {
      throw new RangeError('input.totalSteps must be a non-negative integer');
    }
    if (!Number.isInteger(input.completedSteps) || input.completedSteps < 0 || input.completedSteps > input.totalSteps) {
      throw new RangeError('input.completedSteps must be in [0, totalSteps]');
    }
    if (input.continuityLeaseExpiresAt !== null) reqEpoch(input.continuityLeaseExpiresAt, 'input.continuityLeaseExpiresAt');
    reqEpoch(input.requestedAt, 'input.requestedAt');
    reqEpoch(input.updatedAt, 'input.updatedAt');
    this.#operations.set(operationId, input);
  }

  /** Project ONE controller input into a registry row at `at`. Pure — no state mutation. */
  toControllerRow(input: ControllerRegistryInput, at: EpochMillis): ControllerRegistryRow {
    const drift = !jsonEq(input.desiredState, input.observedState);
    const dependencyDegraded = dependencyDegradedOf(input.dependencies);
    const needsAttention = input.health !== 'healthy' || drift || dependencyDegraded;
    const priority = controllerPriorityOf({ health: input.health, drift, dependencyDegraded });
    return {
      instanceId: input.instanceId,
      tenantId: input.tenantId,
      controllerId: input.controllerId,
      controllerVersionId: input.controllerVersionId,
      controllerVersion: input.controllerVersion,
      name: input.name,
      ownerPrincipalId: input.ownerPrincipalId,
      adapterVersionId: input.adapterVersionId,
      health: input.health,
      desiredState: input.desiredState,
      observedState: input.observedState,
      sourceRevision: input.sourceRevision,
      dependencies: Object.freeze([...input.dependencies]),
      activeOperationId: input.activeOperationId,
      drift,
      dependencyDegraded,
      needsAttention,
      ageMillis: Math.max(0, at - input.lastObservationAt),
      priority,
    };
  }

  /** Project ONE operation input into an operation row at `at`. Pure — no state mutation. */
  toOperationRow(input: OperationProjectionInput, at: EpochMillis): OperationRow {
    const latestOutcomeUncertain =
      input.latestAttemptOutcome !== null && UNCERTAIN_SET.has(input.latestAttemptOutcome);
    // FR-028 — an uncertain latest attempt keeps the operation blocked until reconciliation established
    // actual state. The projector NEVER treats an acknowledgement as success.
    const awaitingReconciliation = latestOutcomeUncertain && !input.reconciliationEstablished;
    const continuityLeaseActive =
      input.state === 'continuity' &&
      input.continuityLeaseId !== null &&
      input.continuityLeaseExpiresAt !== null &&
      at < input.continuityLeaseExpiresAt;
    const terminal = TERMINAL_SET.has(input.state);
    const failed = FAILED_STATES.has(input.state);
    const progress = input.totalSteps > 0 ? input.completedSteps / input.totalSteps : 0;
    const priority = operationPriorityOf({
      awaitingReconciliation,
      failed,
      continuityLeaseActive,
      authorizedRevisionDrift: input.authorizedRevisionDrift,
      terminal,
    });
    return {
      operationId: input.operationId,
      tenantId: input.tenantId,
      controllerInstanceId: input.controllerInstanceId,
      operationKind: input.operationKind,
      state: input.state,
      ownerPrincipalId: input.ownerPrincipalId,
      requestedByPrincipalId: input.requestedByPrincipalId,
      authorizedRevisionDrift: input.authorizedRevisionDrift,
      simulationId: input.simulationId,
      approvalDecisionId: input.approvalDecisionId,
      continuityLeaseId: input.continuityLeaseId,
      continuityLeaseExpiresAt: input.continuityLeaseExpiresAt,
      continuityLeaseActive,
      totalSteps: input.totalSteps,
      completedSteps: input.completedSteps,
      progress,
      attemptCount: input.attemptCount,
      latestAttemptOutcome: input.latestAttemptOutcome,
      latestOutcomeUncertain,
      awaitingReconciliation,
      reconciliationRunId: input.reconciliationRunId,
      rollbackResult: input.rollbackResult,
      evidenceBundleId: input.evidenceBundleId,
      failed,
      failureDetail: input.failureDetail,
      terminal,
      // FR-024 — the permitted next actions come straight from the domain lifecycle graph; the
      // projector never widens what the operator may do.
      nextPermittedActions: allowedNextOperations(input.state),
      ageMillis: Math.max(0, at - input.requestedAt),
      priority,
    };
  }

  /** The full controller registry at `at`, ordered by descending priority then instanceId (stable). */
  controllers(at: EpochMillis): readonly ControllerRegistryRow[] {
    return [...this.#controllers.values()]
      .map((c) => this.toControllerRow(c, at))
      .sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.instanceId.localeCompare(b.instanceId)));
  }

  /** The full operation queue at `at`, ordered by descending priority then operationId (stable). */
  operations(at: EpochMillis): readonly OperationRow[] {
    return [...this.#operations.values()]
      .map((o) => this.toOperationRow(o, at))
      .sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.operationId.localeCompare(b.operationId)));
  }

  /** Only controllers needing operator attention (unhealthy / drifted / dependency degraded). */
  attentionControllers(at: EpochMillis): readonly ControllerRegistryRow[] {
    return this.controllers(at).filter((r) => r.needsAttention);
  }

  /** Only operations awaiting reconciliation of an uncertain outcome (FR-028). */
  awaitingReconciliation(at: EpochMillis): readonly OperationRow[] {
    return this.operations(at).filter((r) => r.awaitingReconciliation);
  }

  controllerRowFor(instanceId: Uuid, at: EpochMillis): ControllerRegistryRow | null {
    const input = this.#controllers.get(instanceId);
    return input ? this.toControllerRow(input, at) : null;
  }

  operationRowFor(operationId: Uuid, at: EpochMillis): OperationRow | null {
    const input = this.#operations.get(operationId);
    return input ? this.toOperationRow(input, at) : null;
  }

  controllerCount(): number {
    return this.#controllers.size;
  }

  operationCount(): number {
    return this.#operations.size;
  }

  /** The content digest of the whole projected read model at `at` — the durable-effect witness. */
  snapshotDigest(at: EpochMillis): string {
    const controllers = this.controllers(at).map((r) => ({
      instanceId: r.instanceId,
      health: r.health,
      drift: r.drift,
      dependencyDegraded: r.dependencyDegraded,
      needsAttention: r.needsAttention,
      activeOperationId: r.activeOperationId,
      priority: r.priority,
    }));
    const operations = this.operations(at).map((r) => ({
      operationId: r.operationId,
      state: r.state,
      awaitingReconciliation: r.awaitingReconciliation,
      continuityLeaseActive: r.continuityLeaseActive,
      failed: r.failed,
      terminal: r.terminal,
      nextPermittedActions: [...r.nextPermittedActions],
      priority: r.priority,
    }));
    return sha256(JSON.stringify({ tenantId: this.#tenantId, at, controllers, operations }));
  }
}
