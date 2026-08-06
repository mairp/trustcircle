// @trustcircle/application — READINESS SERVICE: evaluate MINIMUM CORE health SEPARATELY from optional
// availability, with an explicit unavailable-feature inventory (Phase 8 / User Story 6 / T248 /
// NFR-010, FR-036 / SC-016).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE readiness oracle. The system's MINIMUM CORE profile must be healthy on its own; whether an
// OPTIONAL / ON-DEMAND feature happens to be inactive MUST NOT drag core readiness down (NFR-010: only
// the core profile runs continuously; everything else is intentionally-inactive/on-demand). Given the
// set of component activations — each with an availability class (core|optional|on-demand) and a
// runtime state (mirror of migration 0060 `component_activation.runtime_state`) — the service computes:
//   * coreHealthy         — TRUE only if EVERY core component is active (healthy). One unhealthy core
//                           component makes the system not-ready; NO optional component can affect this.
//   * optionalUnavailable — the EXPLICIT inventory of intentionally-inactive / unavailable optional and
//                           on-demand features, each with its activation condition (so the gap is
//                           visible and actionable, never hidden as "everything is fine").
//   * verdict             — an overall readiness verdict: `ready` (core healthy) with the optional
//                           inventory attached, or `not_ready` (a core component is unhealthy).
//
// Pure, dependency-free (`node:crypto` only for the witness digest): no wall-clock reads (an explicit
// `at`), no I/O, no Math.random. The core-healthy computation is INDEPENDENT of optional availability.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Guards + hashing (fail-visible).
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
function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// ===========================================================================
// 1. Vocabulary (mirror migration 0060 component_activation CHECKs).
// ===========================================================================

export const READINESS_AVAILABILITY_CLASSES = ['core', 'optional', 'on-demand'] as const;
export type ReadinessAvailabilityClass = (typeof READINESS_AVAILABILITY_CLASSES)[number];

export function isReadinessAvailabilityClass(s: unknown): s is ReadinessAvailabilityClass {
  return typeof s === 'string' && (READINESS_AVAILABILITY_CLASSES as readonly string[]).includes(s);
}

export const READINESS_RUNTIME_STATES = [
  'active',
  'intentionally_inactive',
  'maintenance',
  'unavailable',
  'degraded',
  'stale',
  'failed',
  'returning',
] as const;
export type ReadinessRuntimeState = (typeof READINESS_RUNTIME_STATES)[number];

export function isReadinessRuntimeState(s: unknown): s is ReadinessRuntimeState {
  return typeof s === 'string' && (READINESS_RUNTIME_STATES as readonly string[]).includes(s);
}

/** The runtime states that count as HEALTHY (serving) for a core component. */
const HEALTHY_STATES: ReadonlySet<ReadinessRuntimeState> = new Set<ReadinessRuntimeState>(['active']);

// ===========================================================================
// 2. Inputs.
// ===========================================================================

/** One component activation — its availability class, runtime state, and (optional) activation path. */
export interface ComponentActivation {
  readonly componentKey: string;
  readonly availabilityClass: ReadinessAvailabilityClass;
  readonly runtimeState: ReadinessRuntimeState;
  /** The condition under which this component becomes available (for the unavailable inventory). */
  readonly activationCondition?: string;
}

export interface ReadinessInput {
  readonly activations: readonly ComponentActivation[];
  /** The instant the readiness was evaluated (epoch-ms). Explicit — no wall-clock read. */
  readonly at: number;
}

// ===========================================================================
// 3. The verdict.
// ===========================================================================

/** One entry in the explicit unavailable-feature inventory. */
export interface UnavailableFeature {
  readonly componentKey: string;
  readonly availabilityClass: ReadinessAvailabilityClass;
  readonly runtimeState: ReadinessRuntimeState;
  /** Why/how it becomes available (empty string when the caller supplied none). */
  readonly activationCondition: string;
}

/** One entry describing an unhealthy CORE component (the reason core is not ready). */
export interface UnhealthyCore {
  readonly componentKey: string;
  readonly runtimeState: ReadinessRuntimeState;
}

export const READINESS_VERDICTS = ['ready', 'not_ready'] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

export interface ReadinessResult {
  /** TRUE iff every core component is active — INDEPENDENT of optional availability. */
  readonly coreHealthy: boolean;
  /** The core components that are NOT healthy (empty iff coreHealthy). */
  readonly unhealthyCore: readonly UnhealthyCore[];
  /** The explicit inventory of intentionally-inactive / unavailable optional + on-demand features. */
  readonly optionalUnavailable: readonly UnavailableFeature[];
  /** The overall verdict: `ready` iff core is healthy (optional gaps do not block readiness). */
  readonly verdict: ReadinessVerdict;
  readonly coreComponentCount: number;
  readonly evaluatedAt: number;
  /** The durable-effect witness — identical activations + `at` ⇒ identical digest. */
  readonly digest: string;
}

// ===========================================================================
// 4. evaluateReadiness — core health SEPARATE from optional availability.
// ===========================================================================

/**
 * Evaluate readiness. `coreHealthy` is TRUE iff EVERY core component is active — the optional inventory
 * is computed independently and CANNOT change it. The verdict is `ready` iff core is healthy, with the
 * optional-unavailable inventory attached so intentionally-inactive features stay visible. Pure.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  assertEpoch(input.at, 'readiness.at');

  const unhealthyCore: UnhealthyCore[] = [];
  const optionalUnavailable: UnavailableFeature[] = [];
  let coreComponentCount = 0;

  for (const a of input.activations) {
    assertNonEmpty(a.componentKey, 'activation.componentKey');
    if (!isReadinessAvailabilityClass(a.availabilityClass)) {
      throw new TypeError(`activation.availabilityClass must be one of ${READINESS_AVAILABILITY_CLASSES.join('|')}`);
    }
    if (!isReadinessRuntimeState(a.runtimeState)) {
      throw new TypeError(`activation.runtimeState must be one of ${READINESS_RUNTIME_STATES.join('|')}`);
    }

    if (a.availabilityClass === 'core') {
      coreComponentCount += 1;
      // CORE HEALTH is computed ONLY from core components — never influenced by optional availability.
      if (!HEALTHY_STATES.has(a.runtimeState)) {
        unhealthyCore.push(Object.freeze({ componentKey: a.componentKey, runtimeState: a.runtimeState }));
      }
    } else if (!HEALTHY_STATES.has(a.runtimeState)) {
      // OPTIONAL / ON-DEMAND that is not active ⇒ an explicit, visible unavailable-feature entry.
      optionalUnavailable.push(
        Object.freeze({
          componentKey: a.componentKey,
          availabilityClass: a.availabilityClass,
          runtimeState: a.runtimeState,
          activationCondition: a.activationCondition ?? '',
        }),
      );
    }
  }

  // Stable, deterministic ordering by componentKey.
  unhealthyCore.sort((x, y) => (x.componentKey < y.componentKey ? -1 : x.componentKey > y.componentKey ? 1 : 0));
  optionalUnavailable.sort((x, y) => (x.componentKey < y.componentKey ? -1 : x.componentKey > y.componentKey ? 1 : 0));

  const coreHealthy = unhealthyCore.length === 0;
  const verdict: ReadinessVerdict = coreHealthy ? 'ready' : 'not_ready';

  const evaluatedAt = input.at;
  const digest = sha256(
    canonicalJson({
      coreHealthy,
      verdict,
      unhealthyCore,
      optionalUnavailable,
      coreComponentCount,
      evaluatedAt,
    }),
  );

  return Object.freeze({
    coreHealthy,
    unhealthyCore: Object.freeze(unhealthyCore),
    optionalUnavailable: Object.freeze(optionalUnavailable),
    verdict,
    coreComponentCount,
    evaluatedAt,
    digest,
  });
}
