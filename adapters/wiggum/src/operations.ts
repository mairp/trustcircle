// @trustcircle/adapter-wiggum — governed Wiggum operations & reconciliation (task T266 / US6).
//
// Governed inspect / stop / force-stop / resume / replay RECONCILIATION with timeout,
// maximum-rejection, ambiguity, arbitration, and evidence rules. PURE guarded operations: no I/O,
// no wall clock (`at` is injected on every call), no randomness, Node built-in `crypto` only.
//
// LOAD-BEARING RULES:
//   * A TIMEOUT IS UNCERTAIN. A timed-out operation never assumes success OR failure; it yields an
//     `uncertain` outcome that MUST be reconciled against the source (`reconcile`, don't assume).
//   * REPEATED REJECTIONS ESCALATE. When source rejections reach the maximum, the operation
//     escalates to a maximum-rejection stop rather than retrying blindly.
//   * AMBIGUITY → ARBITRATION. Conflicting/ambiguous source signals are never auto-resolved; they
//     route to human arbitration.
//   * EVERY OP EMITS EVIDENCE. Each governed operation returns a durable, digested evidence record
//     regardless of outcome. A CONNECTOR NEVER HOLDS GOVERNANCE AUTHORITY: these operations
//     reconcile and record; they never treat their own result as human approval.

import { createHash } from 'node:crypto';
import type { BundleIdentity } from './snapshot.ts';

// ---------------------------------------------------------------------------
// Operation kinds + outcomes.
// ---------------------------------------------------------------------------

export type WiggumOperationKind = 'inspect' | 'stop' | 'force_stop' | 'resume' | 'replay';

export type OperationOutcome =
  /** The source acknowledged and the effect is confirmed. */
  | 'confirmed'
  /** The source rejected the operation. */
  | 'rejected'
  /** Timed out: effect unknown — reconcile, do not assume. */
  | 'uncertain'
  /** Rejections reached the maximum; escalated to a maximum-rejection stop. */
  | 'escalated_max_rejection'
  /** Conflicting/ambiguous signals routed to human arbitration. */
  | 'arbitration_required';

/** A raw source signal observed while performing an operation. */
export interface SourceSignal {
  readonly signal: 'ack' | 'reject' | 'conflict';
  readonly detail: string;
}

export interface OperationInput {
  readonly kind: WiggumOperationKind;
  readonly featureId: string;
  readonly identity: BundleIdentity;
  /** The signals observed from the source for this attempt. */
  readonly signals: readonly SourceSignal[];
  /** True when the operation's response window elapsed with no terminal signal. */
  readonly timedOut: boolean;
  /** Count of prior rejections already recorded for this operation. */
  readonly priorRejectionCount: number;
  /** Escalation threshold: rejections reaching this count escalate to a max-rejection stop. */
  readonly maximumRejections: number;
  /** Injected time (epoch ms). */
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Evidence record (every op emits one).
// ---------------------------------------------------------------------------

export interface OperationEvidence {
  readonly kind: WiggumOperationKind;
  readonly featureId: string;
  readonly identity: BundleIdentity;
  readonly outcome: OperationOutcome;
  /** True only for `uncertain` — a reconciliation pass is required, no assumption is made. */
  readonly reconciliationRequired: boolean;
  /** True only for `arbitration_required` — a human must resolve the ambiguity. */
  readonly arbitrationRequired: boolean;
  readonly totalRejectionCount: number;
  readonly signals: readonly SourceSignal[];
  readonly at: number;
  /** Durable digest over the evidence body. */
  readonly evidenceDigest: string;
  readonly rationale: string;
}

/**
 * Perform a governed Wiggum operation, deriving an outcome under the reconciliation rules and
 * emitting a durable evidence record. Pure and deterministic.
 *
 * Precedence: ambiguity (conflict) → arbitration; else timeout → uncertain (reconcile); else
 * rejections reaching the maximum → escalated stop; else any rejection → rejected; else confirmed.
 */
export function performOperation(input: OperationInput): OperationEvidence {
  const conflicts = input.signals.filter((s) => s.signal === 'conflict');
  const rejections = input.signals.filter((s) => s.signal === 'reject');
  const totalRejectionCount = input.priorRejectionCount + rejections.length;

  let outcome: OperationOutcome;
  let rationale: string;

  if (conflicts.length > 0) {
    outcome = 'arbitration_required';
    rationale =
      `Ambiguous/conflicting source signals (${conflicts.length}) cannot be auto-resolved; ` +
      'routed to human arbitration.';
  } else if (input.timedOut) {
    outcome = 'uncertain';
    rationale =
      'Operation timed out; effect is unknown and must be reconciled against the source — no ' +
      'success or failure is assumed.';
  } else if (totalRejectionCount >= input.maximumRejections) {
    outcome = 'escalated_max_rejection';
    rationale =
      `Rejections reached the maximum (${totalRejectionCount} >= ${input.maximumRejections}); ` +
      'escalated to a maximum-rejection stop rather than retrying.';
  } else if (rejections.length > 0) {
    outcome = 'rejected';
    rationale = `Source rejected the ${input.kind} operation (${rejections.length} rejection(s)).`;
  } else {
    outcome = 'confirmed';
    rationale = `Source acknowledged the ${input.kind} operation; effect confirmed.`;
  }

  const reconciliationRequired = outcome === 'uncertain';
  const arbitrationRequired = outcome === 'arbitration_required';

  const signals = input.signals.map((s) => Object.freeze({ ...s }));

  const body = {
    kind: input.kind,
    featureId: input.featureId,
    identity: input.identity,
    outcome,
    reconciliationRequired,
    arbitrationRequired,
    totalRejectionCount,
    signals,
    at: input.at,
  };

  return Object.freeze({
    ...body,
    identity: Object.freeze({ ...input.identity }),
    signals: Object.freeze(signals),
    evidenceDigest: contentDigest(body),
    rationale,
  });
}

// ---------------------------------------------------------------------------
// Timeout reconciliation (resolve an `uncertain` outcome against a fresh observation).
// ---------------------------------------------------------------------------

export interface TimeoutReconciliationInput {
  readonly evidence: OperationEvidence;
  /** A fresh source observation of the effect after the timeout. */
  readonly observedEffectApplied: boolean | null;
  readonly at: number;
}

export interface TimeoutReconciliationResult {
  readonly kind: WiggumOperationKind;
  readonly featureId: string;
  /** The reconciled outcome; stays `uncertain` when the effect still cannot be observed. */
  readonly reconciledOutcome: OperationOutcome;
  readonly at: number;
  readonly reconciliationDigest: string;
  readonly rationale: string;
}

/**
 * Reconcile a timed-out (`uncertain`) operation against a fresh observation of the effect. Only an
 * unambiguous fresh observation resolves the uncertainty; otherwise the outcome stays uncertain
 * and further reconciliation is required. Never assumes an outcome.
 */
export function reconcileTimeout(input: TimeoutReconciliationInput): TimeoutReconciliationResult {
  if (input.evidence.outcome !== 'uncertain') {
    return Object.freeze({
      kind: input.evidence.kind,
      featureId: input.evidence.featureId,
      reconciledOutcome: input.evidence.outcome,
      at: input.at,
      reconciliationDigest: contentDigest({
        source: input.evidence.evidenceDigest,
        observedEffectApplied: input.evidence.outcome,
        at: input.at,
      }),
      rationale: 'Operation was not uncertain; nothing to reconcile.',
    });
  }

  let reconciledOutcome: OperationOutcome;
  let rationale: string;
  if (input.observedEffectApplied === true) {
    reconciledOutcome = 'confirmed';
    rationale = 'Fresh observation shows the effect applied; uncertainty resolved to confirmed.';
  } else if (input.observedEffectApplied === false) {
    reconciledOutcome = 'rejected';
    rationale = 'Fresh observation shows the effect did not apply; uncertainty resolved to rejected.';
  } else {
    reconciledOutcome = 'uncertain';
    rationale =
      'Effect still cannot be observed; outcome stays uncertain and further reconciliation is required.';
  }

  return Object.freeze({
    kind: input.evidence.kind,
    featureId: input.evidence.featureId,
    reconciledOutcome,
    at: input.at,
    reconciliationDigest: contentDigest({
      source: input.evidence.evidenceDigest,
      observedEffectApplied: input.observedEffectApplied,
      reconciledOutcome,
      at: input.at,
    }),
    rationale,
  });
}

// ---------------------------------------------------------------------------
// Local canonicalization + digest.
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
