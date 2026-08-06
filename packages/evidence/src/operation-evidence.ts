// @trustcircle/evidence — OPERATION EVIDENCE: collect the complete, ordered, tamper-evident evidence
// bundle for a controller operation — plan, attempts, buffered continuity effects, remote
// observations, rollback/compensation, reconciliation, and independent verification
// (Phase 6 / User Story 4 / FR-025, FR-027, FR-028, FR-049, FR-050, NS-011, SC-011).
//
// Every governed controller effect must leave an INDEPENDENTLY REPLAYABLE trail: what was planned,
// each dispatch attempt and its outcome (including uncertain / no-effect), any effects BUFFERED while a
// continuity lease was in force, the direct REMOTE OBSERVATIONS that established actual state (never an
// acknowledgement), any rollback/compensation performed against the preserved preimage, the
// reconciliation runs that resolved uncertainty, and the independent VERIFICATION that closed the loop.
//
// This module is a pure, dependency-free COLLECTOR. It does not itself talk to a controller or a
// database; it accumulates the facts the application/worker layers produce and emits a single
// canonical, sha256-witnessed `OperationEvidenceBundle`. The bundle is content-addressed: the same
// facts in the same order always yield the same `bundleDigest`, so any tampering (dropping an attempt,
// reordering, editing an outcome) is detectable. Ordering is preserved as recorded; entries are frozen.
//
// The collector enforces a few load-bearing evidence invariants so a malformed bundle is refused rather
// than silently accepted:
//   * a `confirmed` remote observation MUST carry `remoteEffectObserved: true` (FR-027 — confirmation is
//     an OBSERVATION, never an acknowledgement);
//   * a reconciliation asserting `reconciled_effect_present` MUST cite at least one remote observation
//     in the bundle (SC-011 / FR-028 — presence is established by observation);
//   * a `rolled_back` (cleared) rollback entry MUST cite the preserved-preimage evidence id it restored
//     to (NS-011 — a restore without a preimage is not a restore).
// A violation throws `OperationEvidenceError`; nothing is partially recorded.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Errors — every refusal is first-class.
// ---------------------------------------------------------------------------

export type OperationEvidenceRejectionReason =
  | 'missing-operation-id'
  | 'missing-tenant-id'
  | 'confirmation-without-observation'
  | 'effect-present-without-observation'
  | 'rolled-back-without-preimage'
  | 'empty-entry';

export class OperationEvidenceError extends Error {
  readonly reason: OperationEvidenceRejectionReason;
  constructor(reason: OperationEvidenceRejectionReason, detail?: string) {
    super(`operation evidence rejected [${reason}]${detail ? `: ${detail}` : ''}`);
    this.name = 'OperationEvidenceError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Entry shapes — one per governed fact in the operation lifecycle.
// ---------------------------------------------------------------------------

/** The immutable plan the operation was authorized to perform (the "what was intended"). */
export interface OperationPlanEvidence {
  readonly operationId: string;
  readonly controllerVersionId: string;
  readonly operationKind: string;
  readonly idempotencyKey: string;
  readonly simulationId: string | null;
  readonly approvalDecisionId: string | null;
  readonly desiredSourceRevision: string;
  readonly recordedAt: number;
}

/** One dispatch attempt and its outcome (including uncertain / dispatched_unconfirmed / no_effect). */
export interface OperationAttemptEvidence {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  /** e.g. pending | dispatched_unconfirmed | confirmed | no_effect | failed | uncertain | timed_out. */
  readonly outcome: string;
  /** True iff a remote effect was DIRECTLY observed for this attempt (required for `confirmed`). */
  readonly remoteEffectObserved: boolean;
  readonly recordedAt: number;
  readonly detail?: string;
}

/** An effect BUFFERED locally while a continuity lease was in force (FR-049), flushed on reconcile. */
export interface BufferedContinuityEffectEvidence {
  readonly leaseId: string;
  readonly sequence: number;
  readonly operationKind: string;
  readonly localObservationDigest: string;
  readonly recordedAt: number;
}

/** A DIRECT remote observation of authoritative state (never an acknowledgement) — FR-027. */
export interface RemoteObservationEvidence {
  readonly observationId: string;
  /** True iff the remote effect was present per this direct read. */
  readonly remoteEffectObserved: boolean;
  readonly observedRevision: string;
  readonly observedStateDigest: string;
  readonly recordedAt: number;
}

/** A rollback / compensation performed against the preserved preimage (NS-011). */
export interface RollbackEvidence {
  /** e.g. rolled_back | partial | conflict | unavailable | failed. */
  readonly result: string;
  /** The preserved preimage the rollback restored TO (null if none was available). */
  readonly preimageEvidenceId: string | null;
  readonly compensatedSteps: number;
  readonly totalSteps: number;
  readonly restorationVerified: boolean;
  readonly recordedAt: number;
}

/** A reconciliation run that resolved (or failed to resolve) an uncertain outcome — FR-028 / SC-011. */
export interface ReconciliationEvidence {
  readonly runId: string;
  /** e.g. reconciled_effect_present | reconciled_no_effect | still_uncertain | conflict | failed. */
  readonly result: string;
  readonly usedRemoteObservation: boolean;
  readonly observedEffectCount: number;
  /** The remote observation ids this run relied on (must be non-empty for effect_present). */
  readonly citedObservationIds: readonly string[];
  readonly recordedAt: number;
}

/** The independent verification that closed the loop (distinct from the effect itself — FR-025). */
export interface VerificationEvidence {
  readonly verificationId: string;
  readonly verifiedByPrincipalId: string;
  readonly verifiedStateDigest: string;
  readonly passed: boolean;
  readonly recordedAt: number;
}

// ---------------------------------------------------------------------------
// The assembled, content-addressed bundle.
// ---------------------------------------------------------------------------

export interface OperationEvidenceBundle {
  readonly operationId: string;
  readonly tenantId: string;
  readonly plan: OperationPlanEvidence | null;
  readonly attempts: readonly OperationAttemptEvidence[];
  readonly bufferedContinuityEffects: readonly BufferedContinuityEffectEvidence[];
  readonly remoteObservations: readonly RemoteObservationEvidence[];
  readonly rollbacks: readonly RollbackEvidence[];
  readonly reconciliations: readonly ReconciliationEvidence[];
  readonly verifications: readonly VerificationEvidence[];
  /** True iff any recorded attempt outcome was uncertain (dispatched_unconfirmed/uncertain/timed_out). */
  readonly hasUncertainOutcome: boolean;
  /** True iff at least one reconciliation established actual state (present/no_effect). */
  readonly reconciledToEstablishedState: boolean;
  /** sha256 over the canonical bundle — the durable, independently-re-derivable witness. */
  readonly bundleDigest: string;
}

// ---------------------------------------------------------------------------
// Canonical hashing (sorted-key, undefined-dropped) — matches the evidence idiom.
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const UNCERTAIN_ATTEMPT_OUTCOMES = new Set(['dispatched_unconfirmed', 'uncertain', 'timed_out']);
const ESTABLISHED_RECONCILIATION_RESULTS = new Set(['reconciled_effect_present', 'reconciled_no_effect']);

// ---------------------------------------------------------------------------
// The collector.
// ---------------------------------------------------------------------------

/**
 * Accumulates the ordered evidence for ONE controller operation and emits a canonical, sha256-witnessed
 * bundle. Pure and dependency-free (node:crypto only). Order of recording is preserved; each `record*`
 * validates the load-bearing evidence invariants and throws `OperationEvidenceError` on a violation.
 */
export class OperationEvidenceCollector {
  readonly #operationId: string;
  readonly #tenantId: string;
  #plan: OperationPlanEvidence | null = null;
  readonly #attempts: OperationAttemptEvidence[] = [];
  readonly #buffered: BufferedContinuityEffectEvidence[] = [];
  readonly #observations: RemoteObservationEvidence[] = [];
  readonly #rollbacks: RollbackEvidence[] = [];
  readonly #reconciliations: ReconciliationEvidence[] = [];
  readonly #verifications: VerificationEvidence[] = [];
  readonly #observationIds = new Set<string>();

  constructor(operationId: string, tenantId: string) {
    if (typeof operationId !== 'string' || operationId.trim().length === 0) {
      throw new OperationEvidenceError('missing-operation-id');
    }
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new OperationEvidenceError('missing-tenant-id');
    }
    this.#operationId = operationId;
    this.#tenantId = tenantId;
  }

  recordPlan(plan: OperationPlanEvidence): this {
    if (plan.operationId !== this.#operationId) {
      throw new OperationEvidenceError('empty-entry', 'plan operationId does not match the bundle');
    }
    this.#plan = Object.freeze({ ...plan });
    return this;
  }

  recordAttempt(attempt: OperationAttemptEvidence): this {
    if (typeof attempt.attemptId !== 'string' || attempt.attemptId.trim().length === 0) {
      throw new OperationEvidenceError('empty-entry', 'attempt requires an attemptId');
    }
    // FR-027 — a `confirmed` outcome is a CONFIRMATION, which requires a direct observation.
    if (attempt.outcome === 'confirmed' && attempt.remoteEffectObserved !== true) {
      throw new OperationEvidenceError('confirmation-without-observation', `attempt ${attempt.attemptId}`);
    }
    this.#attempts.push(Object.freeze({ ...attempt }));
    return this;
  }

  recordBufferedContinuityEffect(effect: BufferedContinuityEffectEvidence): this {
    if (typeof effect.leaseId !== 'string' || effect.leaseId.trim().length === 0) {
      throw new OperationEvidenceError('empty-entry', 'buffered continuity effect requires a leaseId');
    }
    this.#buffered.push(Object.freeze({ ...effect }));
    return this;
  }

  recordRemoteObservation(observation: RemoteObservationEvidence): this {
    if (typeof observation.observationId !== 'string' || observation.observationId.trim().length === 0) {
      throw new OperationEvidenceError('empty-entry', 'remote observation requires an observationId');
    }
    this.#observations.push(Object.freeze({ ...observation }));
    this.#observationIds.add(observation.observationId);
    return this;
  }

  recordRollback(rollback: RollbackEvidence): this {
    // NS-011 — a cleared (`rolled_back`) restore must cite the preserved preimage it restored to.
    if (rollback.result === 'rolled_back' && (rollback.preimageEvidenceId === null || rollback.preimageEvidenceId === undefined)) {
      throw new OperationEvidenceError('rolled-back-without-preimage');
    }
    this.#rollbacks.push(Object.freeze({ ...rollback }));
    return this;
  }

  recordReconciliation(run: ReconciliationEvidence): this {
    if (typeof run.runId !== 'string' || run.runId.trim().length === 0) {
      throw new OperationEvidenceError('empty-entry', 'reconciliation requires a runId');
    }
    // SC-011 / FR-028 — `reconciled_effect_present` is established by OBSERVATION: it must cite at least
    // one remote observation, and every cited observation must already be recorded in this bundle.
    if (run.result === 'reconciled_effect_present') {
      if (!run.usedRemoteObservation || run.citedObservationIds.length === 0) {
        throw new OperationEvidenceError('effect-present-without-observation', `run ${run.runId}`);
      }
      for (const oid of run.citedObservationIds) {
        if (!this.#observationIds.has(oid)) {
          throw new OperationEvidenceError('effect-present-without-observation', `run ${run.runId} cites unknown observation ${oid}`);
        }
      }
    }
    this.#reconciliations.push(Object.freeze({ ...run, citedObservationIds: Object.freeze([...run.citedObservationIds]) }));
    return this;
  }

  recordVerification(verification: VerificationEvidence): this {
    if (typeof verification.verificationId !== 'string' || verification.verificationId.trim().length === 0) {
      throw new OperationEvidenceError('empty-entry', 'verification requires a verificationId');
    }
    this.#verifications.push(Object.freeze({ ...verification }));
    return this;
  }

  /** Emit the immutable, content-addressed bundle. Idempotent — repeated calls yield an equal digest. */
  seal(): OperationEvidenceBundle {
    const hasUncertainOutcome = this.#attempts.some((a) => UNCERTAIN_ATTEMPT_OUTCOMES.has(a.outcome));
    const reconciledToEstablishedState = this.#reconciliations.some((r) =>
      ESTABLISHED_RECONCILIATION_RESULTS.has(r.result),
    );

    const body = {
      operationId: this.#operationId,
      tenantId: this.#tenantId,
      plan: this.#plan,
      attempts: this.#attempts,
      bufferedContinuityEffects: this.#buffered,
      remoteObservations: this.#observations,
      rollbacks: this.#rollbacks,
      reconciliations: this.#reconciliations,
      verifications: this.#verifications,
      hasUncertainOutcome,
      reconciledToEstablishedState,
    };

    return Object.freeze({
      operationId: this.#operationId,
      tenantId: this.#tenantId,
      plan: this.#plan,
      attempts: Object.freeze([...this.#attempts]),
      bufferedContinuityEffects: Object.freeze([...this.#buffered]),
      remoteObservations: Object.freeze([...this.#observations]),
      rollbacks: Object.freeze([...this.#rollbacks]),
      reconciliations: Object.freeze([...this.#reconciliations]),
      verifications: Object.freeze([...this.#verifications]),
      hasUncertainOutcome,
      reconciledToEstablishedState,
      bundleDigest: canonicalHash(body),
    });
  }
}

/**
 * A pure verifier: re-derive the digest of a bundle and confirm it matches the recorded witness, so a
 * downstream reader can detect tampering (a dropped attempt, an edited outcome, a reordered trail).
 * Returns true iff the bundle's `bundleDigest` re-derives from its own contents.
 */
export function operationEvidenceBundleIsIntact(bundle: OperationEvidenceBundle): boolean {
  const body = {
    operationId: bundle.operationId,
    tenantId: bundle.tenantId,
    plan: bundle.plan,
    attempts: bundle.attempts,
    bufferedContinuityEffects: bundle.bufferedContinuityEffects,
    remoteObservations: bundle.remoteObservations,
    rollbacks: bundle.rollbacks,
    reconciliations: bundle.reconciliations,
    verifications: bundle.verifications,
    hasUncertainOutcome: bundle.hasUncertainOutcome,
    reconciledToEstablishedState: bundle.reconciledToEstablishedState,
  };
  return canonicalHash(body) === bundle.bundleDigest;
}
