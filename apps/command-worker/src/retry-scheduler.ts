// @trustcircle/command-worker — the RETRY SCHEDULER (Phase 8 / User Story 6 / T234 /
// FR-061, FR-062, FR-063, FR-064, SC-025).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// A PURE decision function that answers ONE question for a failed dispatch: retry or stop, and if
// retry, WHEN. It classifies the failure (retryable vs terminal), honours a server `Retry-After` hint,
// otherwise computes exponential backoff with DETERMINISTIC jitter, and enforces attempt + deadline
// limits. Every retry is scheduled under the SAME idempotency key (FR-062) — a retry is never a new
// operation. Terminal failure classes, exhausted attempts, and a passed deadline all STOP.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — CLASS-SPECIFIC, DETERMINISTIC, SAME-KEY, BOUNDED, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * FAILURE-CLASS-SPECIFIC (FR-061). Retryable classes (rate_limited | transient |
//   dependency_unavailable | timeout_before_dispatch) may retry; terminal classes (unauthenticated |
//   unauthorized | invalid_request | unsupported_contract | precondition_failed | policy_denied) STOP.
// * SERVER HINT FIRST (FR-063). A non-negative `retryAfterMs` server hint overrides computed backoff,
//   clamped to `maxBackoffMs`.
// * EXPONENTIAL BACKOFF + DETERMINISTIC JITTER (FR-064/SC-025). Backoff = initial * 2^(attempt-1),
//   clamped to max. Jitter is derived from an injected `jitterSeed` + attempt via sha-256 — NEVER
//   Math.random — so the same inputs always produce the same schedule (provable in tests).
// * SAME IDEMPOTENCY KEY (FR-062). Retry ALWAYS reuses the operation's idempotency key; the decision
//   echoes it so the caller cannot substitute a fresh one.
// * BOUNDED (FR-062). Attempts >= maxAttempts, or a nextAttemptAt past the deadline, STOP.
// * LEAF-CLEAN. No domain/application dependency; `node:crypto` only for the jitter digest. `now` is
//   passed explicitly — no wall-clock read.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Failure-class vocabulary (leaf-clean copy of the adapter-sdk classes).
// ===========================================================================

/** Retryable failure classes — same-key retry is permitted. */
export const RETRY_SCHEDULER_RETRYABLE = [
  'rate_limited',
  'transient',
  'dependency_unavailable',
  'timeout_before_dispatch',
] as const;
export type RetrySchedulerRetryable = (typeof RETRY_SCHEDULER_RETRYABLE)[number];

/** Terminal failure classes — retrying can never succeed, so the scheduler STOPS. */
export const RETRY_SCHEDULER_TERMINAL = [
  'unauthenticated',
  'unauthorized',
  'invalid_request',
  'unsupported_contract',
  'precondition_failed',
  'policy_denied',
] as const;
export type RetrySchedulerTerminal = (typeof RETRY_SCHEDULER_TERMINAL)[number];

export type RetryFailureClass = RetrySchedulerRetryable | RetrySchedulerTerminal;

const RETRYABLE_SET: ReadonlySet<string> = new Set<string>(RETRY_SCHEDULER_RETRYABLE);
const TERMINAL_SET: ReadonlySet<string> = new Set<string>(RETRY_SCHEDULER_TERMINAL);

/** True iff the failure class admits a same-key retry. */
export function isRetryableClass(failureClass: string): failureClass is RetrySchedulerRetryable {
  return RETRYABLE_SET.has(failureClass);
}

/** True iff the failure class is terminal (never retried). */
export function isTerminalClass(failureClass: string): failureClass is RetrySchedulerTerminal {
  return TERMINAL_SET.has(failureClass);
}

// ===========================================================================
// 1. Input + decision shapes.
// ===========================================================================

export interface RetryScheduleInput {
  /** The failed dispatch's idempotency key — retry reuses it verbatim (FR-062). */
  readonly idempotencyKey: string;
  /** The classified failure. Unknown classes are treated conservatively as terminal. */
  readonly failureClass: string;
  /** Attempts already made (>= 1 after the first failure). */
  readonly attempt: number;
  /** Hard cap on attempts; attempt >= maxAttempts STOPS as exhausted. */
  readonly maxAttempts: number;
  /** Base backoff for attempt 1 (ms, >= 0). */
  readonly initialBackoffMs: number;
  /** Upper clamp on any backoff / server hint (ms, >= initialBackoffMs). */
  readonly maxBackoffMs: number;
  /** A non-negative server `Retry-After` hint (ms) overrides computed backoff, or undefined. */
  readonly retryAfterMs?: number;
  /** The absolute deadline (epoch-ms); a nextAttemptAt past it STOPS. */
  readonly deadline: number;
  /** Deterministic jitter seed (e.g. the operation id). Combined with attempt via sha-256. */
  readonly jitterSeed: string;
  /** The scheduling instant (epoch-ms). Passed explicitly — no wall-clock read. */
  readonly now: number;
}

export const RETRY_DECISION_ACTIONS = ['retry', 'stop'] as const;
export type RetryDecisionAction = (typeof RETRY_DECISION_ACTIONS)[number];

export interface RetryDecision {
  readonly action: RetryDecisionAction;
  /** The idempotency key the retry MUST reuse (echoed; never mutated). */
  readonly idempotencyKey: string;
  /** When to retry (epoch-ms), or null when stopping. */
  readonly nextAttemptAt: number | null;
  /** The chosen backoff (ms) including jitter, or 0 when stopping. */
  readonly backoffMs: number;
  /** Whether the backoff came from the server hint (vs computed). */
  readonly usedServerHint: boolean;
  /** Human-legible reason for the decision. */
  readonly reason: string;
}

// ===========================================================================
// 2. scheduleRetry — the decision.
// ===========================================================================

export function scheduleRetry(input: RetryScheduleInput): RetryDecision {
  if (!Number.isFinite(input.now)) throw new RangeError('now must be a finite epoch-ms instant');
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new RangeError('attempt must be a positive integer');
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(input.initialBackoffMs) || input.initialBackoffMs < 0) {
    throw new RangeError('initialBackoffMs must be a non-negative finite number');
  }
  if (!Number.isFinite(input.maxBackoffMs) || input.maxBackoffMs < input.initialBackoffMs) {
    throw new RangeError('maxBackoffMs must be a finite number >= initialBackoffMs');
  }

  const stop = (reason: string): RetryDecision =>
    Object.freeze({
      action: 'stop',
      idempotencyKey: input.idempotencyKey,
      nextAttemptAt: null,
      backoffMs: 0,
      usedServerHint: false,
      reason,
    });

  // Terminal (or unknown) classes never retry.
  if (!isRetryableClass(input.failureClass)) {
    return stop(
      isTerminalClass(input.failureClass)
        ? `terminal failure class '${input.failureClass}' — retry can never succeed`
        : `unknown failure class '${input.failureClass}' — treated as terminal (fail-closed)`,
    );
  }

  // Attempt budget exhausted.
  if (input.attempt >= input.maxAttempts) {
    return stop(`attempts exhausted (${input.attempt}/${input.maxAttempts})`);
  }

  // Choose the delay: a non-negative server hint overrides computed backoff (both clamped to max).
  const hint = input.retryAfterMs;
  const usedServerHint = hint !== undefined && Number.isFinite(hint) && hint >= 0;
  const backoffMs = usedServerHint
    ? Math.min(hint as number, input.maxBackoffMs)
    : computeBackoffWithJitter(input.attempt, input.initialBackoffMs, input.maxBackoffMs, input.jitterSeed);

  const nextAttemptAt = input.now + backoffMs;

  // A retry scheduled past the deadline STOPS.
  if (nextAttemptAt > input.deadline) {
    return stop(
      `next attempt at ${nextAttemptAt} would exceed deadline ${input.deadline} (backoff ${backoffMs}ms)`,
    );
  }

  return Object.freeze({
    action: 'retry',
    idempotencyKey: input.idempotencyKey,
    nextAttemptAt,
    backoffMs,
    usedServerHint,
    reason: usedServerHint
      ? `retryable '${input.failureClass}' — honouring server hint ${backoffMs}ms (attempt ${input.attempt + 1}/${input.maxAttempts})`
      : `retryable '${input.failureClass}' — exponential backoff ${backoffMs}ms (attempt ${input.attempt + 1}/${input.maxAttempts})`,
  });
}

// ===========================================================================
// 3. Deterministic backoff + jitter.
// ===========================================================================

/**
 * Exponential backoff base * 2^(attempt-1) clamped to max, with DETERMINISTIC jitter in [0, base) added
 * then re-clamped to max. Jitter is derived from `jitterSeed` + attempt via sha-256 — never Math.random —
 * so identical inputs always yield an identical delay.
 */
export function computeBackoffWithJitter(
  attempt: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  jitterSeed: string,
): number {
  const exponent = attempt - 1;
  // Guard the shift from overflow — cap the multiplier well before Number precision loss.
  const multiplier = exponent >= 52 ? Number.MAX_SAFE_INTEGER : 2 ** exponent;
  const base = Math.min(initialBackoffMs * multiplier, maxBackoffMs);
  const jitter = base > 0 ? Math.floor(deterministicUnitFraction(jitterSeed, attempt) * base) : 0;
  return Math.min(base + jitter, maxBackoffMs);
}

/**
 * A deterministic fraction in [0, 1) derived from a seed + attempt via sha-256 (node:crypto). Uses the
 * first 6 hex digits (24 bits) so the fraction is stable and platform-independent.
 */
export function deterministicUnitFraction(jitterSeed: string, attempt: number): number {
  const hex = createHash('sha256').update(`${jitterSeed}:${attempt}`).digest('hex').slice(0, 6);
  return parseInt(hex, 16) / 0x1000000;
}
