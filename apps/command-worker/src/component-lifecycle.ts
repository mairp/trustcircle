// @trustcircle/command-worker — the COMPONENT LIFECYCLE governor (Phase 8 / User Story 6 / T247 /
// NFR-010 component-profile oracle; T223/T248).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// A PURE set of governed commands — `inspect`, `activate`, `deactivate`, `reconcile` — over a
// component's LIVE availability. Availability is SEPARATE from design authority: only a `core`
// component runs continuously; everything else is intentionally-inactive / on-demand until an
// owner-approved activation path PROVES its prerequisites. Its single load-bearing invariant is
// PROOF-BEFORE-ACTIVE: a transition to `activation_state` `active` is REFUSED unless
// `identityVerified && contractVerified && authorityVerified && backlogReconciled` are ALL true —
// mirroring the DB CHECK `component_active_requires_preflight`. No mutation happens before proof.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — PROOF-GATED, AVAILABILITY-SEPARATE, INJECTED CLOCK, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * PROOF BEFORE ACTIVE (NFR-010 / DB CHECK component_active_requires_preflight). `activate` computes
//   a preflight over the four prerequisites and REFUSES (fail-visible) to reach `active` unless ALL
//   are proven — no state is mutated toward active before proof.
// * AVAILABILITY ≠ AUTHORITY. `availabilityClass` ∈ core | optional | on-demand. `inspect` reports the
//   continuously-expected runtime for the class: only `core` is expected `active`; everything else is
//   `intentionally_inactive` until an owner-approved activation proves prerequisites.
// * EXPLICIT LIFECYCLE. `runtimeState` and `activationState` are aligned column-for-column with the
//   `component_activation` table.
// * NO WALL-CLOCK. The command instant `at` is passed explicitly (epoch-ms) — no clock read.
// * LEAF-CLEAN. Depends on NO domain/application package: minimal structural input shape + injected
//   `at`. `node:crypto` is used only to digest the resulting record body.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Vocabulary (leaf-clean string constants; aligned with component_activation).
// ===========================================================================

/** Availability class — aligned with `component_activation.availability_class`. */
export const COMPONENT_AVAILABILITY_CLASSES = ['core', 'optional', 'on-demand'] as const;
export type ComponentAvailabilityClass = (typeof COMPONENT_AVAILABILITY_CLASSES)[number];

/** Runtime state — aligned with `component_activation.runtime_state`. */
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

/** Activation lifecycle state — aligned with `component_activation.activation_state`. */
export const COMPONENT_ACTIVATION_STATES = [
  'inactive',
  'preflight',
  'activating',
  'active',
  'deactivating',
  'failed',
] as const;
export type ComponentActivationState = (typeof COMPONENT_ACTIVATION_STATES)[number];

/** The actor attributed to every lifecycle command (deterministic, non-human). */
export const COMPONENT_LIFECYCLE_ACTOR = 'system:component-lifecycle';

// ===========================================================================
// 1. Prerequisite proof + input shapes.
// ===========================================================================

/**
 * The four activation prerequisites. ALL must be true before a component may reach `active` — this is
 * the physical mirror of the DB CHECK `component_active_requires_preflight`.
 */
export interface ActivationPrerequisites {
  readonly identityVerified: boolean;
  readonly contractVerified: boolean;
  readonly authorityVerified: boolean;
  readonly backlogReconciled: boolean;
}

/** The governed context of the component the command targets. */
export interface ComponentInput {
  readonly componentKey: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly availabilityClass: ComponentAvailabilityClass;
  /** The prerequisite proof as currently observed. */
  readonly prerequisites: ActivationPrerequisites;
  /** Evidence references collected alongside the command. */
  readonly evidenceRefs?: readonly string[];
  /** The command instant (epoch-ms). Passed explicitly — no wall-clock read. */
  readonly at: number;
}

// ===========================================================================
// 2. Component-activation witness (aligned column-for-column with component_activation).
// ===========================================================================

export interface ComponentActivation {
  readonly componentKey: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly availabilityClass: ComponentAvailabilityClass;
  readonly runtimeState: ComponentRuntimeState;
  readonly activationState: ComponentActivationState;
  readonly identityVerified: boolean;
  readonly contractVerified: boolean;
  readonly authorityVerified: boolean;
  readonly backlogReconciled: boolean;
  /** TRUE iff all four prerequisites are proven (the preflight gate). */
  readonly preflightPassed: boolean;
  readonly evidenceRefs: readonly string[];
  /** The instant the component reached `active` (epoch-ms), or null. */
  readonly activatedAt: number | null;
  readonly updatedAt: number;
  /** A stable digest of the record body (content digest; node:crypto). */
  readonly contentDigest: string;
}

// ===========================================================================
// 3. Preflight proof.
// ===========================================================================

/** True iff EVERY activation prerequisite is proven (mirror the DB CHECK). */
export function preflightPassed(prerequisites: ActivationPrerequisites): boolean {
  return (
    prerequisites.identityVerified === true &&
    prerequisites.contractVerified === true &&
    prerequisites.authorityVerified === true &&
    prerequisites.backlogReconciled === true
  );
}

// ===========================================================================
// 4. Commands — inspect / activate / deactivate / reconcile.
// ===========================================================================

/**
 * INSPECT the component WITHOUT mutating it toward active. Reports the continuously-expected runtime
 * for the availability class: `core` is expected `active` ONLY once preflight passes; everything else
 * is `intentionally_inactive` until an owner-approved activation proves prerequisites. Activation
 * state stays `inactive` — inspect never activates.
 */
export function inspect(input: ComponentInput): ComponentActivation {
  guardAt(input.at);
  const passed = preflightPassed(input.prerequisites);
  // Only 'core' runs continuously — and only once proven; everything else is intentionally inactive.
  const runtimeState: ComponentRuntimeState =
    input.availabilityClass === 'core' && passed ? 'active' : 'intentionally_inactive';
  return build(input, {
    runtimeState,
    activationState: 'inactive',
    preflight: passed,
    activatedAt: null,
  });
}

/**
 * ACTIVATE the component through a guarded preflight. REFUSES (fail-visible TypeError) to reach
 * `active` unless ALL four prerequisites are proven — no mutation toward active before proof, mirroring
 * the DB CHECK `component_active_requires_preflight`. On success the component is `active` /
 * runtime `active` with `activatedAt` stamped.
 */
export function activate(input: ComponentInput): ComponentActivation {
  guardAt(input.at);
  if (!preflightPassed(input.prerequisites)) {
    const p = input.prerequisites;
    const unmet = [
      p.identityVerified ? null : 'identity',
      p.contractVerified ? null : 'contract',
      p.authorityVerified ? null : 'authority',
      p.backlogReconciled ? null : 'backlog',
    ].filter((x): x is string => x !== null);
    throw new TypeError(
      `activation to 'active' refused: unmet prerequisites [${unmet.join(', ')}] — no mutation before proof`,
    );
  }
  return build(input, {
    runtimeState: 'active',
    activationState: 'active',
    preflight: true,
    activatedAt: input.at,
  });
}

/**
 * DEACTIVATE the component to an intentionally-inactive runtime. Availability is separate from
 * authority — deactivation is always permitted and needs no preflight. Activation state returns to
 * `inactive`.
 */
export function deactivate(input: ComponentInput): ComponentActivation {
  guardAt(input.at);
  return build(input, {
    runtimeState: 'intentionally_inactive',
    activationState: 'inactive',
    preflight: preflightPassed(input.prerequisites),
    activatedAt: null,
  });
}

/**
 * RECONCILE the component's live availability against its class + proven prerequisites WITHOUT forcing
 * activation. A `core` component whose preflight has lapsed is surfaced `stale` (drift-visible), never
 * silently held `active`; everything else settles to `intentionally_inactive`. Activation state is
 * `inactive` — reconcile observes and reports, it does not activate.
 */
export function reconcile(input: ComponentInput): ComponentActivation {
  guardAt(input.at);
  const passed = preflightPassed(input.prerequisites);
  let runtimeState: ComponentRuntimeState;
  if (input.availabilityClass === 'core') {
    // A core component that no longer proves its prerequisites is STALE, not silently active.
    runtimeState = passed ? 'active' : 'stale';
  } else {
    runtimeState = 'intentionally_inactive';
  }
  return build(input, {
    runtimeState,
    activationState: 'inactive',
    preflight: passed,
    activatedAt: null,
  });
}

// ===========================================================================
// 5. Internals.
// ===========================================================================

function guardAt(at: number): void {
  if (!Number.isFinite(at)) throw new RangeError('at must be a finite epoch-ms instant');
}

function build(
  input: ComponentInput,
  resolved: {
    readonly runtimeState: ComponentRuntimeState;
    readonly activationState: ComponentActivationState;
    readonly preflight: boolean;
    readonly activatedAt: number | null;
  },
): ComponentActivation {
  // Defensive mirror of the DB CHECK: an 'active' activation_state is IMPOSSIBLE without full proof.
  if (resolved.activationState === 'active' && !resolved.preflight) {
    throw new TypeError('invariant violation: activation_state active without a passed preflight');
  }
  const base = {
    componentKey: input.componentKey,
    tenantId: input.tenantId,
    owner: input.owner,
    availabilityClass: input.availabilityClass,
    runtimeState: resolved.runtimeState,
    activationState: resolved.activationState,
    identityVerified: input.prerequisites.identityVerified,
    contractVerified: input.prerequisites.contractVerified,
    authorityVerified: input.prerequisites.authorityVerified,
    backlogReconciled: input.prerequisites.backlogReconciled,
    preflightPassed: resolved.preflight,
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
    activatedAt: resolved.activatedAt,
    updatedAt: input.at,
  };
  return Object.freeze({ ...base, contentDigest: digestRecord(base) });
}

/** Stable sha-256 digest of the record body (node:crypto; deterministic). */
function digestRecord(body: Omit<ComponentActivation, 'contentDigest'>): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Canonical, key-sorted JSON so a digest is stable across key insertion order. */
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
