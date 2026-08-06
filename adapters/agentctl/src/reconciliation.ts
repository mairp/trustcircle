// @trustcircle/adapter-agentctl — dispatch reconciliation after possible dispatch (T257 / US6 / SC-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// PURE reconciliation for agentctl dispatches. It captures the command/exit/stdout/stderr digests and
// reconciles CLI TIMEOUTS — which happen AFTER A POSSIBLE DISPATCH — by looking the operation up by
// OPERATION ID / IDEMPOTENCY KEY. A timeout is UNCERTAIN, not a failure: the adapter MUST reconcile the
// actual state (the command may well have been dispatched), never assume failure and never re-dispatch
// blindly (SC-011: a retry under one key yields exactly one effect).
//
// Dependency-free (Node built-in `crypto` only): pure, no I/O, no wall clock. Runs under Node 22
// `--experimental-strip-types`.

import { createHash } from 'node:crypto';

import type { AgentctlDispatchObservation } from './client.ts';

// ---------------------------------------------------------------------------
// Evidence capture — deterministic digests over the invocation.
// ---------------------------------------------------------------------------

/** The captured evidence digests for one dispatch. Chain-of-custody anchors. */
export interface DispatchEvidence {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly commandDigest: string;
  readonly exitCode: number | null;
  readonly stdoutDigest: string | null;
  readonly stderrDigest: string | null;
  readonly timedOut: boolean;
  /** A single content digest binding all of the above (the durable capture witness). */
  readonly evidenceDigest: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Capture the command/exit/stdout/stderr digests of a dispatch observation as durable evidence. */
export function captureDispatchEvidence(obs: AgentctlDispatchObservation): DispatchEvidence {
  const body = {
    operationId: obs.operationId,
    idempotencyKey: obs.idempotencyKey,
    commandDigest: obs.commandDigest,
    exitCode: obs.exitCode,
    stdoutDigest: obs.stdoutDigest,
    stderrDigest: obs.stderrDigest,
    timedOut: obs.timedOut,
  };
  return Object.freeze({
    ...body,
    evidenceDigest: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex'),
  });
}

// ---------------------------------------------------------------------------
// Operation-lookup port — reconcile actual state by operation id / idempotency key.
// ---------------------------------------------------------------------------

/** The authoritative state the owning API reports for an operation id. */
export interface OperationLookupResult {
  readonly operationId: string;
  /** Whether the owning source has a record of this operation (i.e. it WAS dispatched). */
  readonly found: boolean;
  /** The raw status the source reports for the operation, if found. */
  readonly status?: string;
  readonly runId?: string;
  readonly revision?: string;
}

/**
 * The injected read-only lookup seam onto the owning API's operation-lookup surface. Given an
 * operation id / idempotency key, it reports the actual state — the anchor for reconciling a timeout.
 */
export type OperationLookupPort = (
  operationId: string,
  idempotencyKey: string,
) => Promise<OperationLookupResult>;

// ---------------------------------------------------------------------------
// Reconciliation result — named, deterministic.
// ---------------------------------------------------------------------------

export type ReconciliationResolution =
  | 'confirmed_dispatched'
  | 'confirmed_not_dispatched'
  | 'still_uncertain'
  | 'not_required';

export interface AgentctlReconciliation {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly resolution: ReconciliationResolution;
  readonly evidence: DispatchEvidence;
  /** The raw status the lookup reported, when found. */
  readonly reconciledStatus: string | null;
  readonly runId: string | null;
  readonly reason: string;
}

/**
 * Reconcile a dispatch observation. When the observation is a CLI TIMEOUT (uncertain), look the
 * operation up by operation id / idempotency key to determine whether it was ACTUALLY dispatched —
 * a timeout is UNCERTAIN, never a failure. Non-timeout observations need no reconciliation. PURE over
 * the injected lookup port; the observation is never mutated.
 */
export async function reconcileDispatch(
  lookup: OperationLookupPort,
  obs: AgentctlDispatchObservation,
): Promise<AgentctlReconciliation> {
  const evidence = captureDispatchEvidence(obs);

  // Only a timeout (uncertain) requires reconciliation against actual source state.
  if (!obs.timedOut && obs.outcome !== 'uncertain') {
    return Object.freeze({
      operationId: obs.operationId,
      idempotencyKey: obs.idempotencyKey,
      resolution: 'not_required',
      evidence,
      reconciledStatus: null,
      runId: null,
      reason: 'Dispatch outcome was definite; no timeout reconciliation is required.',
    });
  }

  const result = await lookup(obs.operationId, obs.idempotencyKey);

  if (!result.found) {
    return Object.freeze({
      operationId: obs.operationId,
      idempotencyKey: obs.idempotencyKey,
      resolution: 'confirmed_not_dispatched',
      evidence,
      reconciledStatus: null,
      runId: null,
      reason:
        'Timeout reconciled by operation id: the owning source has no record of the operation, ' +
        'so it was not dispatched. A retry under the same idempotency key remains safe (SC-011).',
    });
  }

  return Object.freeze({
    operationId: obs.operationId,
    idempotencyKey: obs.idempotencyKey,
    resolution: 'confirmed_dispatched',
    evidence,
    reconciledStatus: result.status ?? null,
    runId: result.runId ?? null,
    reason:
      'Timeout reconciled by operation id: the owning source DID record the operation, so the ' +
      'dispatch took effect. The timeout was uncertainty, not failure; no re-dispatch is performed.',
  });
}
