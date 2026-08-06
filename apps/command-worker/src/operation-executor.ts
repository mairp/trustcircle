// @trustcircle/command-worker — the CONTROLLER OPERATION EXECUTOR (Phase 6 / User Story 4 / T165 /
// FR-024, FR-025, FR-026, FR-027, FR-028, NS-005, SC-011).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// This worker CLAIMS approved, simulated, execution-gated controller operations and dispatches their
// steps through an out-of-process adapter — safely. Only a MANIFEST-DECLARED, POLICY-AUTHORIZED,
// SIMULATED, APPROVED, and last-second EXECUTION-GUARDED operation ever runs (the injected `guard`
// oracle, production-wired to the application `guardExecution`, is consulted immediately before every
// effect and a deny short-circuits — no mutation runs on a stale world). Each dispatch carries the ONE
// idempotency identity of the operation (FR-026), so a retried or resumed pass resolves to EXACTLY ONE
// effect (SC-011). A CHECKPOINT is taken before and after the steps; a CANCELLATION signal and the
// operation's own STOP CONDITIONS are checked before start and between steps, stopping safely and
// leaving a resumable outcome. Every attempt writes ATTEMPT EVIDENCE. Crucially, an UNCERTAIN adapter
// outcome (timeout / severed / acknowledged-but-unconfirmed) is NEVER reported as success: the executor
// records it as `uncertain` and routes the operation to RECONCILE before any further mutation (FR-028).
//
// Every effect commits through the SAME transactional-outbox unit-of-work every governed effect uses:
// an operation-attempt state transition + attempt evidence ref + an audit event + an outbox
// notification, atomic or not at all. A crash mid-dispatch resumes safely: the idempotency identity is
// derived from the operation id + step id + bound source revision, so re-running the pass deduplicates.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — GATED, IDEMPOTENT, CHECKPOINTED, CANCELLABLE, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * EXECUTION-GUARDED (FR-024/NS-005). The injected `guard` oracle (production wires the application
//   `guardExecution`) is consulted immediately before each step; a deny verdict short-circuits to a
//   `blocked` outcome naming the failed checks. A read-only operation skips the mutation gates upstream
//   but is still dispatched through the same evidenced path.
// * ONE IDEMPOTENCY IDENTITY (FR-026). The attempt id, idempotency key, correlation id are DERIVED
//   (sha-256) from operation id + step id + bound source revision — never from `now`. Re-running the
//   pass over the same durable state deduplicates; a NEW source revision derives a fresh identity.
// * CONFIRMATION ≠ ACKNOWLEDGEMENT (FR-027). The injected `dispatch` port returns a tagged outcome; the
//   executor treats only a DIRECTLY-OBSERVED effect as `confirmed`. An acknowledged-but-unconfirmed,
//   timed-out, or severed dispatch is `uncertain` → route to reconcile, NEVER success.
// * CHECKPOINTED + CANCELLABLE (FR-021 pattern). A checkpoint is taken before and after the steps; a
//   cancellation predicate + the operation's stop conditions are checked before start and between steps,
//   yielding a resumable `stopped` outcome.
// * UNCERTAIN ⇒ RECONCILE, not success (FR-028/SC-011). An uncertain step stops the pass and routes to
//   reconciliation; the executor never dispatches a NEW step past an unreconciled uncertain outcome.
// * INJECTABLE / LEAF-CLEAN. Like repair-executor.ts, depends on NO domain/application package at the
//   type level: minimal STRUCTURAL port shapes + injected oracles/ports. Production wires the real
//   guard/dispatch/checkpoint functions; tests wire pure in-memory fakes, so every branch is provable
//   with no live DB or adapter under Node 22 `--experimental-strip-types`.

import {
  commitUnitOfWork,
  readCanonicalState,
  type Database,
  type SourceContract,
  type AuditEventInput,
  type CommitUnitOfWorkResult,
  digest,
} from '@trustcircle/persistence';

// ===========================================================================
// 0. Outcome vocabulary (leaf-clean; mirrors the attempt-outcome subset the executor can emit).
// ===========================================================================

/**
 * The disposition the executor records for one operation-step attempt. NOTE the executor never emits a
 * final `verified` or `rolled_back`: verification and rollback are separate governed effects. It emits
 * at most `confirmed` (a DIRECTLY observed effect) and routes everything unconfirmed to reconcile.
 */
export const OPERATION_EXECUTOR_OUTCOMES = [
  'confirmed',
  'dispatched_unconfirmed',
  'no_effect',
  'uncertain',
  'failed',
  'stopped',
  'blocked',
] as const;
export type OperationExecutorOutcome = (typeof OPERATION_EXECUTOR_OUTCOMES)[number];

/** The canonical `entity_kind` an operation attempt is stored under. */
export const OPERATION_ATTEMPT_ENTITY_KIND = 'controller_operation_attempt';

/** The canonical outbox topic a controller operation effect publishes on. */
export const OPERATION_DISPATCHED_TOPIC = 'governance.controller.operation_dispatched';

/** The system principal attributed as the actor on every operation dispatch (deterministic). */
export const OPERATION_EXECUTOR_ACTOR = 'system:operation-executor';

// ===========================================================================
// 1. Minimal STRUCTURAL port shapes (leaf-clean — no domain dependency)
// ===========================================================================

/** One operation step to dispatch (opaque to the worker — the injected `dispatch` port interprets it). */
export interface OperationStep {
  readonly stepId: string;
  readonly operationKind: string;
  readonly desiredState: Readonly<Record<string, unknown>>;
}

/** An approved, simulated, execution-gated controller operation ready to execute. */
export interface ExecutableOperation {
  readonly operationId: string;
  readonly tenantId: string;
  readonly controllerVersionId: string;
  readonly simulationId: string;
  readonly approvalDecisionId: string;
  /** The source revision the operation was authorized on (the idempotency identity basis). */
  readonly boundSourceRevision: string;
  readonly idempotencyKey: string;
  /** The ordered steps (dispatched under one idempotency identity). */
  readonly steps: readonly OperationStep[];
  readonly ownerPrincipalId: string;
}

/** The execution-guard verdict (injected `guard` oracle; production wires `guardExecution`). FR-024. */
export interface OperationGuardVerdict {
  readonly permitted: boolean;
  readonly failed: readonly string[];
  /** True iff blocked specifically pending reconciliation of a prior uncertain outcome (FR-028). */
  readonly blockedPendingReconciliation: boolean;
  readonly reason: string;
}

/**
 * The dispatch result from the out-of-process adapter (injected `dispatch` port; production wires the
 * adapter-sdk `AdapterClient.dispatch`). `confirmed` REQUIRES a directly observed effect (FR-027).
 */
export interface StepDispatchResult {
  /** confirmed | dispatched_unconfirmed | no_effect | uncertain | timed_out | failed. */
  readonly outcome: string;
  readonly remoteEffectObserved: boolean;
  readonly observedRevision: string | null;
  /** True iff the caller must reconcile before any new mutation. */
  readonly mustReconcile: boolean;
  readonly detail: string;
}

// ===========================================================================
// 2. Injected oracles + ports
// ===========================================================================

export interface OperationExecutorOracles {
  /** FR-024 execution guard — a deny short-circuits to `blocked` (never dispatches). */
  readonly guard: (
    operation: ExecutableOperation,
    step: OperationStep,
    now: number,
  ) => OperationGuardVerdict;
  /** Cancellation signal — checked before start and between steps; true ⇒ stop safely (`stopped`). */
  readonly cancelled: (operation: ExecutableOperation) => boolean;
  /** The operation's own stop conditions — true ⇒ stop safely (`stopped`) at a checkpoint. */
  readonly stopConditionMet: (operation: ExecutableOperation, step: OperationStep) => boolean;
}

export interface OperationExecutorPorts {
  /** The bounded batch of ready-to-execute operations at `now` (repository query). */
  readonly dueOperations: (now: number, limit: number) => Promise<readonly ExecutableOperation[]>;
  /** Dispatch one step through the out-of-process adapter under the operation's idempotency identity. */
  readonly dispatch: (
    operation: ExecutableOperation,
    step: OperationStep,
    idempotencyKey: string,
  ) => Promise<StepDispatchResult>;
  /** Persist a resumable checkpoint before/after the steps. Idempotent by (operation, phase). */
  readonly checkpoint: (
    operation: ExecutableOperation,
    phase: 'before' | 'after',
    now: number,
  ) => Promise<void>;
}

// ===========================================================================
// 3. Worker configuration
// ===========================================================================

export interface OperationExecutorOptions {
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly owner?: string;
  /** Max operations executed per pass (bounds the pass). Default 25. */
  readonly batchSize?: number;
}

const DEFAULT_OWNER = 'team:governance-runtime';
const DEFAULT_BATCH_SIZE = 25;

// ===========================================================================
// 4. Per-operation + per-pass result shapes (fail-visible witnesses)
// ===========================================================================

export interface OperationItemResult {
  readonly operationId: string;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly outcome: OperationExecutorOutcome;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** The step at which the pass stopped/failed/blocked (null when all steps confirmed). */
  readonly stoppedAtStepId: string | null;
  readonly remoteEffectObserved: boolean;
  readonly deduplicated: boolean;
  /** The failed guard checks when `blocked`, else empty. */
  readonly failedChecks: readonly string[];
  /** The safe next action: reconcile (uncertain), verify (confirmed), escalate (blocked/failed), resume. */
  readonly safeNextAction: 'reconcile' | 'verify' | 'escalate' | 'resume' | 'none';
  readonly error: string | null;
}

export interface OperationPassResult {
  readonly scannedAt: number;
  readonly scanned: number;
  readonly confirmed: number;
  readonly unconfirmed: number;
  readonly uncertain: number;
  readonly failed: number;
  readonly stopped: number;
  readonly blocked: number;
  readonly deduplicated: number;
  readonly results: readonly OperationItemResult[];
}

// ===========================================================================
// 5. Deterministic identity derivation (ONE idempotency identity — FR-026)
// ===========================================================================
//
// Every id is derived from operation id + step id + bound source revision — NOT from `now` or the
// dispatch result. So a step already dispatched for (operation, step, revision) re-derives the SAME
// attempt id / idempotency key on a later pass and the unit-of-work deduplicates it: a step is
// dispatched at most once per identity, whatever the scan cadence. A NEW bound revision derives fresh.

/** The ONE stable idempotency identity basis for an operation-step attempt. */
export function operationStepIdentityBasis(
  operation: ExecutableOperation,
  step: OperationStep,
): {
  operationId: string;
  stepId: string;
  revision: string;
} {
  return {
    operationId: operation.operationId,
    stepId: step.stepId,
    revision: operation.boundSourceRevision,
  };
}

export function operationStepIdempotencyKey(
  operation: ExecutableOperation,
  step: OperationStep,
): string {
  return (
    'op-' +
    digest({
      ...operationStepIdentityBasis(operation, step),
      purpose: 'operation_idempotency',
    }).slice(0, 40)
  );
}

export function operationStepCorrelationId(
  operation: ExecutableOperation,
  step: OperationStep,
): string {
  return (
    'corr-op-' +
    digest({
      ...operationStepIdentityBasis(operation, step),
      purpose: 'operation_correlation',
    }).slice(0, 32)
  );
}

export function operationStepAttemptId(
  operation: ExecutableOperation,
  step: OperationStep,
): string {
  return (
    'op-attempt-' +
    digest({ ...operationStepIdentityBasis(operation, step), purpose: 'operation_attempt' }).slice(
      0,
      32,
    )
  );
}

// ===========================================================================
// 6. The operation executor worker
// ===========================================================================

export class OperationExecutor {
  readonly #db: Database;
  readonly #ports: OperationExecutorPorts;
  readonly #oracles: OperationExecutorOracles;
  readonly #contract: SourceContract;
  readonly #expectedContractVersion: string;
  readonly #policyVersion: string;
  readonly #controlVersion: string;
  readonly #owner: string;
  readonly #batchSize: number;

  constructor(
    db: Database,
    ports: OperationExecutorPorts,
    oracles: OperationExecutorOracles,
    opts: OperationExecutorOptions,
  ) {
    this.#db = db;
    this.#ports = ports;
    this.#oracles = oracles;
    this.#contract = opts.contract;
    this.#expectedContractVersion = opts.expectedContractVersion;
    this.#policyVersion = opts.policyVersion;
    this.#controlVersion = opts.controlVersion;
    this.#owner = opts.owner ?? DEFAULT_OWNER;
    const b = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(b) || b <= 0)
      throw new RangeError('batchSize must be a positive integer');
    this.#batchSize = b;
  }

  /**
   * Run ONE deterministic execution pass at the injected instant `now`. Each ready operation is
   * checkpointed, then its steps are dispatched one at a time — each preceded by the execution guard
   * (deny ⇒ `blocked`), the cancellation signal + stop conditions (⇒ `stopped`). A directly-observed
   * effect is `confirmed`; anything unconfirmed/timed-out/severed is `uncertain` and routes to
   * reconcile. Re-running the pass over the same durable state is a no-op (dedup on the identity).
   */
  async runExecutionPass(now: number): Promise<OperationPassResult> {
    if (!Number.isFinite(now)) throw new RangeError('now must be a finite epoch-ms instant');
    const results: OperationItemResult[] = [];

    for (const operation of await this.#ports.dueOperations(now, this.#batchSize)) {
      results.push(await this.#executeOne(operation, now));
    }

    const count = (o: OperationExecutorOutcome): number =>
      results.filter((r) => r.outcome === o && !r.deduplicated).length;
    return {
      scannedAt: now,
      scanned: results.length,
      confirmed: count('confirmed'),
      unconfirmed: count('dispatched_unconfirmed') + count('no_effect'),
      uncertain: count('uncertain'),
      failed: count('failed'),
      stopped: count('stopped'),
      blocked: count('blocked'),
      deduplicated: results.filter((r) => r.deduplicated).length,
      results,
    };
  }

  async #executeOne(operation: ExecutableOperation, now: number): Promise<OperationItemResult> {
    // Identity is per-step; the operation-level base uses the FIRST step for the resumable receipt.
    const firstStep = operation.steps[0];
    const opBase = {
      operationId: operation.operationId,
      tenantId: operation.tenantId,
    };

    if (firstStep === undefined) {
      // Nothing to do — a no-op operation is not an error, but produces no effect.
      return {
        ...opBase,
        attemptId: `op-attempt-${operation.operationId}`,
        outcome: 'no_effect',
        idempotencyKey: operation.idempotencyKey,
        correlationId: `corr-op-${operation.operationId}`,
        stoppedAtStepId: null,
        remoteEffectObserved: false,
        deduplicated: false,
        failedChecks: [],
        safeNextAction: 'none',
        error: null,
      };
    }

    // Cancellation checked BEFORE start.
    if (this.#oracles.cancelled(operation)) {
      return this.#stopped(operation, firstStep, 'cancelled before start');
    }

    // Checkpoint BEFORE the steps (resumable).
    try {
      await this.#ports.checkpoint(operation, 'before', now);
    } catch (err) {
      return this.#commit(operation, firstStep, now, {
        outcome: 'failed',
        remoteEffectObserved: false,
        stoppedAtStepId: firstStep.stepId,
        failedChecks: [],
        detail: `pre-checkpoint failed: ${describeExecutorError(err)}`,
        safeNextAction: 'escalate',
      });
    }

    // Dispatch the steps under one idempotency identity, honouring cancellation + stop conditions and
    // stopping on the FIRST uncertain/failed/blocked step (never dispatch past an uncertain outcome).
    let lastResult: OperationItemResult | null = null;
    for (const step of operation.steps) {
      if (this.#oracles.cancelled(operation)) {
        return this.#stopped(operation, step, `cancelled before step ${step.stepId}`);
      }
      if (this.#oracles.stopConditionMet(operation, step)) {
        return this.#stopped(operation, step, `stop condition met before step ${step.stepId}`);
      }

      // FR-024 — execution guard IMMEDIATELY before the effect. A deny never dispatches.
      const verdict = this.#oracles.guard(operation, step, now);
      if (!verdict.permitted) {
        return this.#commit(operation, step, now, {
          outcome: 'blocked',
          remoteEffectObserved: false,
          stoppedAtStepId: step.stepId,
          failedChecks: verdict.failed,
          detail: `execution guard denied step ${step.stepId}: ${verdict.reason}`,
          safeNextAction: verdict.blockedPendingReconciliation ? 'reconcile' : 'escalate',
        });
      }

      const idempotencyKey = operationStepIdempotencyKey(operation, step);
      let dr: StepDispatchResult;
      try {
        dr = await this.#ports.dispatch(operation, step, idempotencyKey);
      } catch (err) {
        // A THROWN dispatch is an unknown outcome — treat as UNCERTAIN, never a definite failure.
        return this.#commit(operation, step, now, {
          outcome: 'uncertain',
          remoteEffectObserved: false,
          stoppedAtStepId: step.stepId,
          failedChecks: [],
          detail: `dispatch threw (outcome unknown): ${describeExecutorError(err)}`,
          safeNextAction: 'reconcile',
        });
      }

      const mapped = mapDispatchOutcome(dr);
      if (mapped === 'uncertain') {
        // FR-028 — stop; route to reconcile; NEVER dispatch a new step past an uncertain outcome.
        return this.#commit(operation, step, now, {
          outcome: 'uncertain',
          remoteEffectObserved: false,
          stoppedAtStepId: step.stepId,
          failedChecks: [],
          detail: `step ${step.stepId} outcome uncertain — must reconcile before any new mutation: ${dr.detail}`,
          safeNextAction: 'reconcile',
        });
      }
      if (mapped === 'failed') {
        return this.#commit(operation, step, now, {
          outcome: 'failed',
          remoteEffectObserved: false,
          stoppedAtStepId: step.stepId,
          failedChecks: [],
          detail: `step ${step.stepId} failed with no effect: ${dr.detail}`,
          safeNextAction: 'escalate',
        });
      }
      if (mapped === 'dispatched_unconfirmed' || mapped === 'no_effect') {
        // Acknowledged but not directly observed — record + route to reconcile (not success, FR-027).
        return this.#commit(operation, step, now, {
          outcome: mapped,
          remoteEffectObserved: false,
          stoppedAtStepId: step.stepId,
          failedChecks: [],
          detail: `step ${step.stepId} ${mapped} (effect not directly observed): ${dr.detail}`,
          safeNextAction: 'reconcile',
        });
      }

      // mapped === 'confirmed' — a DIRECTLY observed effect. Record it and continue to the next step.
      lastResult = await this.#commit(operation, step, now, {
        outcome: 'confirmed',
        remoteEffectObserved: true,
        stoppedAtStepId: null,
        failedChecks: [],
        detail: `step ${step.stepId} confirmed by direct remote observation (rev ${dr.observedRevision ?? 'n/a'})`,
        safeNextAction: 'verify',
      });
      if (lastResult.deduplicated) {
        // Already dispatched on a prior pass — keep going (idempotent), but surface the dedup.
        continue;
      }
    }

    // Checkpoint AFTER the steps (best-effort; non-fatal on failure — surfaced, not silently dropped).
    try {
      await this.#ports.checkpoint(operation, 'after', now);
    } catch {
      /* non-fatal: effects are recorded; the attempt commits above stand. */
    }

    return (
      lastResult ?? {
        ...opBase,
        attemptId: operationStepAttemptId(operation, firstStep),
        outcome: 'confirmed',
        idempotencyKey: operationStepIdempotencyKey(operation, firstStep),
        correlationId: operationStepCorrelationId(operation, firstStep),
        stoppedAtStepId: null,
        remoteEffectObserved: true,
        deduplicated: false,
        failedChecks: [],
        safeNextAction: 'verify',
        error: null,
      }
    );
  }

  #stopped(
    operation: ExecutableOperation,
    step: OperationStep,
    detail: string,
  ): OperationItemResult {
    return {
      operationId: operation.operationId,
      tenantId: operation.tenantId,
      attemptId: operationStepAttemptId(operation, step),
      outcome: 'stopped',
      idempotencyKey: operationStepIdempotencyKey(operation, step),
      correlationId: operationStepCorrelationId(operation, step),
      stoppedAtStepId: step.stepId,
      remoteEffectObserved: false,
      deduplicated: false,
      failedChecks: [],
      safeNextAction: 'resume',
      error: detail,
    };
  }

  // --- the single atomic commit path -----------------------------------------

  async #commit(
    operation: ExecutableOperation,
    step: OperationStep,
    now: number,
    detailed: {
      outcome: OperationExecutorOutcome;
      remoteEffectObserved: boolean;
      stoppedAtStepId: string | null;
      failedChecks: readonly string[];
      detail: string;
      safeNextAction: OperationItemResult['safeNextAction'];
    },
  ): Promise<OperationItemResult> {
    const attemptId = operationStepAttemptId(operation, step);
    const idempotencyKey = operationStepIdempotencyKey(operation, step);
    const correlationId = operationStepCorrelationId(operation, step);
    const idBasis = operationStepIdentityBasis(operation, step);

    const reason = { code: `operation_${detailed.outcome}`, text: detailed.detail };
    const state = {
      id: attemptId,
      tenantId: operation.tenantId,
      controllerOperationId: operation.operationId,
      controllerVersionId: operation.controllerVersionId,
      simulationId: operation.simulationId,
      approvalDecisionId: operation.approvalDecisionId,
      stepId: step.stepId,
      boundSourceRevision: operation.boundSourceRevision,
      idempotencyKey,
      outcome: detailed.outcome,
      // FR-027 — confirmation is only ever true on a directly observed effect.
      remoteEffectObserved: detailed.remoteEffectObserved,
      failedChecks: [...detailed.failedChecks],
      executedBy: OPERATION_EXECUTOR_ACTOR,
      executedAt: now,
    };
    const evidenceRefs = [
      `operation:${operation.operationId}`,
      `simulation:${operation.simulationId}`,
      `approval:${operation.approvalDecisionId}`,
      `revision:${operation.boundSourceRevision}`,
      `step:${step.stepId}`,
    ];
    const audit: AuditEventInput = {
      actor: OPERATION_EXECUTOR_ACTOR,
      owner: this.#owner,
      reason,
      sourceStateDigest: digest({ ...idBasis, phase: 'pre_dispatch' }),
      targetStateDigest: digest(state),
      scope: `tenant:${operation.tenantId}/controller_operation:${operation.operationId}/attempt:${attemptId}`,
      policyVersion: this.#policyVersion,
      controlVersion: this.#controlVersion,
      evidenceRefs,
    };

    const baseResult = {
      operationId: operation.operationId,
      tenantId: operation.tenantId,
      attemptId,
      idempotencyKey,
      correlationId,
      stoppedAtStepId: detailed.stoppedAtStepId,
      remoteEffectObserved: detailed.remoteEffectObserved,
      failedChecks: detailed.failedChecks,
    };

    try {
      const result: CommitUnitOfWorkResult = await commitUnitOfWork(this.#db, {
        tenantId: operation.tenantId,
        operationScope: 'controller.operation',
        idempotencyKey,
        correlationId,
        contract: this.#contract,
        expectedContractVersion: this.#expectedContractVersion,
        request: { kind: 'controller_operation_attempt', entityId: attemptId, expectedVersion: 0 },
        canonical: {
          entityKind: OPERATION_ATTEMPT_ENTITY_KIND,
          entityId: attemptId,
          expectedVersion: 0,
          state,
        },
        action: 'controller_operation',
        audit,
        outbox: {
          topic: OPERATION_DISPATCHED_TOPIC,
          payload: {
            eventType: 'operation_dispatched',
            operationId: operation.operationId,
            tenantId: operation.tenantId,
            attemptId,
            outcome: detailed.outcome,
            remoteEffectObserved: detailed.remoteEffectObserved,
            executedAt: now,
          },
        },
      });
      if (result.deduplicated) {
        return {
          ...baseResult,
          outcome: detailed.outcome,
          deduplicated: true,
          safeNextAction: 'none',
          error: null,
        };
      }
      if (result.status !== 'succeeded') {
        return {
          ...baseResult,
          outcome: 'failed',
          deduplicated: false,
          safeNextAction: 'reconcile',
          error: `commit did not succeed: status=${result.status} nextAction=${result.nextAction}`,
        };
      }
      return {
        ...baseResult,
        outcome: detailed.outcome,
        deduplicated: false,
        safeNextAction: detailed.safeNextAction,
        error: null,
      };
    } catch (err) {
      return {
        ...baseResult,
        outcome: 'failed',
        deduplicated: false,
        safeNextAction: 'reconcile',
        error: describeExecutorError(err),
      };
    }
  }

  /**
   * Independent read path: the current canonical state of a committed operation attempt (the durable
   * witness — never the commit return value). Returns null if no canonical row exists.
   */
  async readAttempt(
    tenantId: string,
    attemptId: string,
  ): Promise<{ version: number; stateDigest: string; state: unknown } | null> {
    const row = await readCanonicalState(
      this.#db,
      tenantId,
      OPERATION_ATTEMPT_ENTITY_KIND,
      attemptId,
    );
    if (!row) return null;
    return { version: row.version, stateDigest: row.stateDigest, state: row.state };
  }
}

// ===========================================================================
// 7. Utilities
// ===========================================================================

/**
 * Map an adapter dispatch outcome onto the executor's disposition. Fail-closed and observation-first: a
 * timeout / severed / unknown outcome is `uncertain` (never a definite success or failure); `confirmed`
 * requires a directly observed effect (FR-027).
 */
export function mapDispatchOutcome(dr: StepDispatchResult): OperationExecutorOutcome {
  switch (dr.outcome) {
    case 'confirmed':
      // Defence in depth: only trust `confirmed` when the effect was actually observed.
      return dr.remoteEffectObserved === true ? 'confirmed' : 'uncertain';
    case 'no_effect':
      return 'no_effect';
    case 'dispatched_unconfirmed':
      return 'dispatched_unconfirmed';
    case 'failed':
      // A clean failure with no effect and no reconcile obligation is `failed`; otherwise uncertain.
      return dr.mustReconcile ? 'uncertain' : 'failed';
    case 'timed_out':
    case 'uncertain':
    default:
      return 'uncertain';
  }
}

/** Disclosure-safe error description (error class + message, never internal detail dumps). */
export function describeExecutorError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
