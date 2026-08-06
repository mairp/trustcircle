// @trustcircle/application — OFFLINE DISPATCH: bounded, visible disposition of work targeting an
// intentionally-inactive component (Phase 8 / User Story 6 / T240 / NFR-010, FR-036).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE decision function. When work targets a component that is intentionally inactive / unavailable,
// we must choose a BOUNDED, HONEST disposition — never an unbounded retry, never a false failure, never
// a silent success. Given the component's runtime state (mirror of migration 0060
// `component_activation.runtime_state`), the component availability class, the work item, an explicit
// `now`, and an explicit expiry deadline, `dispatch` returns one of five dispositions:
//   * expire            — the work is past its expiry deadline: it is EXPIRED (bounded, visible), never
//                         silently retried forever.
//   * request_activation— the component is on-demand and inactive: the correct move is to ask for an
//                         owner-approved activation, not to fail the work.
//   * queue             — the component is temporarily impaired (maintenance / degraded / returning /
//                         stale) but the work is deferrable and still fresh: hold it to drain later.
//   * defer             — the component is intentionally-inactive, the work is deferrable and fresh:
//                         hold it (a lighter hold than an active-drain queue).
//   * reject            — the component is hard-unavailable / failed AND the work is non-deferrable:
//                         a VISIBLE governed rejection (never a silent success, never a fake failure).
//
// Pure, dependency-free: no wall-clock reads (an explicit `now` + `expiresAt`), no I/O, no Math.random.

// ===========================================================================
// 0. Guards (fail-visible).
// ===========================================================================

function assertEpoch(ms: unknown, label: string): asserts ms is number {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${String(ms)}`);
  }
}
function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

// ===========================================================================
// 1. Vocabulary — runtime state (mirror migration `component_runtime_valid`) + availability class.
// ===========================================================================

/** Component runtime state (migration 0060 `component_runtime_valid`). */
export const COMPONENT_RUNTIME_STATES = [
  'active',
  'intentionally_inactive',
  'maintenance',
  'unavailable',
  'degraded',
  'stale',
  'failed',
  'returning',
] as const;
export type ComponentRuntimeState = (typeof COMPONENT_RUNTIME_STATES)[number];

export function isComponentRuntimeState(s: unknown): s is ComponentRuntimeState {
  return typeof s === 'string' && (COMPONENT_RUNTIME_STATES as readonly string[]).includes(s);
}

/** Component availability class (migration `component_availability_valid`). */
export const COMPONENT_AVAILABILITY_CLASSES = ['core', 'optional', 'on-demand'] as const;
export type ComponentAvailabilityClass = (typeof COMPONENT_AVAILABILITY_CLASSES)[number];

export function isComponentAvailabilityClass(s: unknown): s is ComponentAvailabilityClass {
  return typeof s === 'string' && (COMPONENT_AVAILABILITY_CLASSES as readonly string[]).includes(s);
}

/** The dispositions — the closed set of bounded, honest outcomes. */
export const DISPATCH_DISPOSITIONS = ['defer', 'reject', 'queue', 'expire', 'request_activation'] as const;
export type DispatchDisposition = (typeof DISPATCH_DISPOSITIONS)[number];

// ===========================================================================
// 2. Inputs + result.
// ===========================================================================

/** A unit of work targeting a (possibly offline) component. */
export interface WorkItem {
  readonly workId: string;
  /** True iff the work can safely wait (deferrable). False = it must be dispatched now or rejected. */
  readonly deferrable: boolean;
}

export interface DispatchInput {
  readonly runtimeState: ComponentRuntimeState;
  readonly availabilityClass: ComponentAvailabilityClass;
  readonly work: WorkItem;
  /** The current instant (epoch-ms). Explicit — no wall-clock read. */
  readonly now: number;
  /** The hard expiry deadline (epoch-ms) after which the work is bounded-expired. */
  readonly expiresAt: number;
}

export interface DispatchDecision {
  readonly disposition: DispatchDisposition;
  /** A stable, human-readable rationale for the disposition (audit-friendly). */
  readonly reason: string;
  /** True iff the work is past its expiry deadline (bounded — no unbounded retry). */
  readonly expired: boolean;
}

// ===========================================================================
// 3. dispatch — the bounded disposition decision.
// ===========================================================================

/** Runtime states in which a component can serve work right now. */
const SERVING_STATES: ReadonlySet<ComponentRuntimeState> = new Set<ComponentRuntimeState>([
  'active',
  'degraded',
]);
/** Runtime states that are temporarily impaired but expected to drain (queue candidates). */
const TRANSIENT_STATES: ReadonlySet<ComponentRuntimeState> = new Set<ComponentRuntimeState>([
  'maintenance',
  'returning',
  'stale',
]);
/** Runtime states that are hard-unavailable (no near-term serving). */
const HARD_UNAVAILABLE_STATES: ReadonlySet<ComponentRuntimeState> = new Set<ComponentRuntimeState>([
  'unavailable',
  'failed',
]);

/**
 * Decide a BOUNDED, HONEST disposition for `work` against an offline component. Order of decision:
 *   1. Past the expiry deadline ⇒ `expire` (bounded; never retried forever).
 *   2. On-demand + intentionally-inactive ⇒ `request_activation` (ask for activation, don't fail).
 *   3. Transient impairment (maintenance/returning/stale) + deferrable ⇒ `queue` (drain later).
 *   4. Intentionally-inactive + deferrable ⇒ `defer` (hold).
 *   5. Hard-unavailable/failed + non-deferrable ⇒ `reject` (a VISIBLE governed rejection).
 *   6. Any remaining non-deferrable case against a non-serving component ⇒ `reject`.
 * A serving component (active/degraded) is not an offline dispatch — this function still returns a
 * `queue` (for deferrable) or `reject` guard, but callers should dispatch normally when serving.
 */
export function dispatch(input: DispatchInput): DispatchDecision {
  assertEpoch(input.now, 'dispatch.now');
  assertEpoch(input.expiresAt, 'dispatch.expiresAt');
  assertNonEmpty(input.work.workId, 'dispatch.work.workId');
  if (!isComponentRuntimeState(input.runtimeState)) {
    throw new TypeError(`dispatch.runtimeState must be one of ${COMPONENT_RUNTIME_STATES.join('|')}`);
  }
  if (!isComponentAvailabilityClass(input.availabilityClass)) {
    throw new TypeError(`dispatch.availabilityClass must be one of ${COMPONENT_AVAILABILITY_CLASSES.join('|')}`);
  }

  const { runtimeState, availabilityClass, work, now, expiresAt } = input;
  const expired = now > expiresAt;

  // 1. BOUNDED: past the deadline ⇒ expire (never an unbounded retry).
  if (expired) {
    return decision('expire', `work ${work.workId} passed its expiry deadline (${now} > ${expiresAt})`, true);
  }

  // A serving component can take the work now — deferrable work queues to drain in order, non-
  // deferrable work is dispatched by the caller (we do not reject a serving component here).
  if (SERVING_STATES.has(runtimeState)) {
    return work.deferrable
      ? decision('queue', `component is ${runtimeState} (serving); deferrable work queued to drain in order`, false)
      : decision('queue', `component is ${runtimeState} (serving); dispatch immediately then drain`, false);
  }

  // 2. ON-DEMAND + inactive ⇒ request activation (the honest move; not a failure).
  if (availabilityClass === 'on-demand' && runtimeState === 'intentionally_inactive') {
    return decision(
      'request_activation',
      `component is on-demand and intentionally inactive; request an owner-approved activation`,
      false,
    );
  }

  // 3. TRANSIENT impairment + deferrable ⇒ queue (drain when it recovers).
  if (TRANSIENT_STATES.has(runtimeState) && work.deferrable) {
    return decision('queue', `component is transiently ${runtimeState}; deferrable work queued to drain on recovery`, false);
  }

  // 4. INTENTIONALLY-INACTIVE + deferrable ⇒ defer (hold; no retry storm).
  if (runtimeState === 'intentionally_inactive' && work.deferrable) {
    return decision('defer', `component is intentionally inactive; deferrable work held`, false);
  }

  // 5. HARD-UNAVAILABLE / failed + non-deferrable ⇒ visible governed rejection.
  if (HARD_UNAVAILABLE_STATES.has(runtimeState) && !work.deferrable) {
    return decision('reject', `component is ${runtimeState} and work is non-deferrable; visible governed rejection`, false);
  }

  // 6. Any remaining non-deferrable work against a non-serving component ⇒ reject (never fake success).
  if (!work.deferrable) {
    return decision('reject', `component is ${runtimeState} (not serving) and work is non-deferrable; rejected`, false);
  }

  // Remaining: deferrable work against a hard-unavailable component — queue for when it returns.
  return decision('queue', `component is ${runtimeState}; deferrable work queued pending return to service`, false);
}

function decision(disposition: DispatchDisposition, reason: string, expired: boolean): DispatchDecision {
  return Object.freeze({ disposition, reason, expired });
}
