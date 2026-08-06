// @trustcircle/application — ALERT ROUTING: threshold-breach alerts routed to accountable owners
// (Phase 8 / User Story 6 / T233 / FR-029, FR-030, SC-014, SC-015 — 60s visibility, 5m owner-notify).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE set of functions over a single `Alert` value, aligned column-for-column with migration 0060
// `alert_record`. An alert binds a threshold breach of one of six classes — health | freshness |
// reconciliation | evidence | contract | control_effectiveness — to an ACCOUNTABLE owner principal,
// and models its life as a guarded progression:
//
//   open → notified → acknowledged → recovered
//
// with three load-bearing timestamps: `firstObservedAt` (when the breach was first seen),
// `ownerNotifiedAt` (when the accountable owner was notified), and `recoveredAt` (when the underlying
// condition cleared). Its invariants (mirroring the migration CHECKs):
//   * RECOVERY IS ORDERED: `recoveredAt >= firstObservedAt` (a recovery cannot predate first
//     observation — `alert_recovery_ordered`).
//   * NOTIFICATION IS ORDERED: `ownerNotifiedAt >= firstObservedAt` (an owner is notified no earlier
//     than the breach was observed).
//   * A guarded state machine: `raiseAlert` → open; `notifyOwner` → notified; an explicit acknowledge
//     → acknowledged; `recoverAlert` → recovered (from any non-recovered state — a breach can clear
//     before it was acknowledged, which is honest, never silently dropped).
//   * SERVICE OBJECTIVES are computed EXPLICITLY, never assumed: `meetsVisibilityObjective` proves the
//     breach became visible within 60s; `meetsOwnerNotifyObjective` proves the owner was notified
//     within 5 minutes. Both take the compared instants explicitly.
//
// Pure, dependency-free (Node built-in `node:crypto` only): no wall-clock reads (every transition takes
// an explicit `at: EpochMillis`), no I/O, no Math.random.

import { createHash } from 'node:crypto';

import { isUuid, type Uuid, type EpochMillis } from '@trustcircle/domain';

// ===========================================================================
// 0. Shared guards + hashing (fail-visible).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}
function assertEpoch(ms: unknown, label: string): asserts ms is EpochMillis {
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
// 1. Vocabulary (mirror migration 0060 `alert_record` CHECKs).
// ===========================================================================

/** Alert classes (migration `alert_class_valid`). */
export const ALERT_CLASSES = [
  'health',
  'freshness',
  'reconciliation',
  'evidence',
  'contract',
  'control_effectiveness',
] as const;
export type AlertClass = (typeof ALERT_CLASSES)[number];

export function isAlertClass(s: unknown): s is AlertClass {
  return typeof s === 'string' && (ALERT_CLASSES as readonly string[]).includes(s);
}

/** Alert severities (migration `alert_severity_valid`). */
export const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export function isAlertSeverity(s: unknown): s is AlertSeverity {
  return typeof s === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(s);
}

/** Alert lifecycle states (migration `alert_state_valid`). */
export const ALERT_STATES = ['open', 'notified', 'acknowledged', 'recovered'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export function isAlertState(s: unknown): s is AlertState {
  return typeof s === 'string' && (ALERT_STATES as readonly string[]).includes(s);
}

/** The 60-second visibility objective (SC-014), in ms. */
export const VISIBILITY_OBJECTIVE_MS = 60_000;
/** The 5-minute owner-notification objective (SC-015), in ms. */
export const OWNER_NOTIFY_OBJECTIVE_MS = 5 * 60_000;

// ===========================================================================
// 2. The durable alert value (mirror migration 0060 `alert_record`).
// ===========================================================================

export interface Alert {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  /** The connector this alert is about (undefined iff `componentKey` is set — `alert_has_subject`). */
  readonly connectorId?: Uuid;
  /** The component this alert is about (undefined iff `connectorId` is set). */
  readonly componentKey?: string;
  readonly alertClass: AlertClass;
  readonly severity: AlertSeverity;
  readonly ownerPrincipalId: Uuid;
  /** The breached threshold (opaque descriptor; not interpreted here). */
  readonly threshold: Readonly<Record<string, unknown>>;
  /** The observed value that breached the threshold (opaque descriptor). */
  readonly observedValue: Readonly<Record<string, unknown>>;
  readonly firstObservedAt: EpochMillis;
  readonly ownerNotifiedAt?: EpochMillis;
  readonly recoveredAt?: EpochMillis;
  readonly state: AlertState;
  readonly evidenceIds: readonly Uuid[];
}

// ===========================================================================
// 3. raiseAlert — first observation of a threshold breach (state: open).
// ===========================================================================

export interface RaiseAlertInput {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly connectorId?: Uuid;
  readonly componentKey?: string;
  readonly alertClass: AlertClass;
  readonly severity?: AlertSeverity;
  readonly ownerPrincipalId: Uuid;
  readonly threshold?: Readonly<Record<string, unknown>>;
  readonly observedValue?: Readonly<Record<string, unknown>>;
  readonly evidenceIds?: readonly Uuid[];
  /** The instant the breach was first observed (epoch-ms). */
  readonly at: EpochMillis;
}

/** Raise an alert for a first-observed threshold breach. State begins `open`. Pure. */
export function raiseAlert(input: RaiseAlertInput): Alert {
  assertUuid(input.id, 'raiseAlert.id');
  assertUuid(input.tenantId, 'raiseAlert.tenantId');
  assertUuid(input.ownerPrincipalId, 'raiseAlert.ownerPrincipalId');
  assertEpoch(input.at, 'raiseAlert.firstObservedAt');
  if (!isAlertClass(input.alertClass)) {
    throw new TypeError(`raiseAlert.alertClass must be one of ${ALERT_CLASSES.join('|')}`);
  }
  // `alert_has_subject`: an alert bound to neither a connector nor a component is meaningless.
  if (input.connectorId === undefined && input.componentKey === undefined) {
    throw new TypeError('raiseAlert: an alert must name a connector or a component subject');
  }
  if (input.connectorId !== undefined) assertUuid(input.connectorId, 'raiseAlert.connectorId');
  if (input.componentKey !== undefined)
    assertNonEmpty(input.componentKey, 'raiseAlert.componentKey');
  const severity = input.severity ?? 'medium';
  if (!isAlertSeverity(severity)) {
    throw new TypeError(`raiseAlert.severity must be one of ${ALERT_SEVERITIES.join('|')}`);
  }
  const evidenceIds = Object.freeze([...(input.evidenceIds ?? [])]);
  for (const e of evidenceIds) assertUuid(e, 'raiseAlert.evidenceId');

  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
    ...(input.componentKey !== undefined ? { componentKey: input.componentKey } : {}),
    alertClass: input.alertClass,
    severity,
    ownerPrincipalId: input.ownerPrincipalId,
    threshold: Object.freeze({ ...(input.threshold ?? {}) }),
    observedValue: Object.freeze({ ...(input.observedValue ?? {}) }),
    firstObservedAt: input.at,
    state: 'open' as const,
    evidenceIds,
  });
}

// ===========================================================================
// 4. notifyOwner — record that the accountable owner was notified (state: notified).
// ===========================================================================

/**
 * Mark the accountable owner as notified at `at`. Refuses a notify that predates first observation, and
 * refuses to notify an already-recovered alert. Idempotent shape: the earliest notification wins if
 * called again (a second notify never moves the notified instant backwards or forwards spuriously).
 */
export function notifyOwner(alert: Alert, at: EpochMillis): Alert {
  assertEpoch(at, 'notifyOwner.at');
  if (at < alert.firstObservedAt) {
    throw new RangeError('notifyOwner: ownerNotifiedAt must be >= firstObservedAt');
  }
  if (alert.state === 'recovered') {
    throw new RangeError('notifyOwner: cannot notify an already-recovered alert');
  }
  if (alert.ownerNotifiedAt !== undefined) {
    // Already notified — preserve the first notification instant; only advance state if still open.
    return alert.state === 'open' ? Object.freeze({ ...alert, state: 'notified' as const }) : alert;
  }
  return Object.freeze({ ...alert, ownerNotifiedAt: at, state: 'notified' as const });
}

/** Acknowledge an alert (owner has seen it). Only a notified alert may be acknowledged. */
export function acknowledgeAlert(alert: Alert): Alert {
  if (alert.state !== 'notified') {
    throw new RangeError(
      `acknowledgeAlert: only a notified alert may be acknowledged (was ${alert.state})`,
    );
  }
  return Object.freeze({ ...alert, state: 'acknowledged' as const });
}

// ===========================================================================
// 5. recoverAlert — the underlying condition cleared (state: recovered).
// ===========================================================================

/**
 * Record recovery of an alert at `at`. RECOVERY IS ORDERED: `recoveredAt >= firstObservedAt`
 * (`alert_recovery_ordered`). A breach can recover from ANY non-recovered state (open / notified /
 * acknowledged) — a clear before acknowledgement is honest, never silently dropped. Recovering an
 * already-recovered alert is refused (recovery is a one-way terminal fact).
 */
export function recoverAlert(alert: Alert, at: EpochMillis): Alert {
  assertEpoch(at, 'recoverAlert.at');
  if (alert.state === 'recovered') {
    throw new RangeError('recoverAlert: alert is already recovered');
  }
  if (at < alert.firstObservedAt) {
    throw new RangeError('recoverAlert: recoveredAt must be >= firstObservedAt (recovery-ordered)');
  }
  return Object.freeze({ ...alert, recoveredAt: at, state: 'recovered' as const });
}

// ===========================================================================
// 6. Service-objective checks (computed EXPLICITLY from timestamps).
// ===========================================================================

/**
 * True iff the breach became VISIBLE within the 60s objective: `visibleAt - firstObservedAt <= 60s`.
 * A `visibleAt` earlier than first observation is nonsensical and returns false.
 */
export function meetsVisibilityObjective(alert: Alert, visibleAt: EpochMillis): boolean {
  assertEpoch(visibleAt, 'meetsVisibilityObjective.visibleAt');
  const delta = visibleAt - alert.firstObservedAt;
  return delta >= 0 && delta <= VISIBILITY_OBJECTIVE_MS;
}

/**
 * True iff the accountable owner was NOTIFIED within the 5-minute objective. Requires the alert to
 * carry an `ownerNotifiedAt`; an un-notified alert has NOT met the objective (never assumed).
 */
export function meetsOwnerNotifyObjective(alert: Alert): boolean {
  if (alert.ownerNotifiedAt === undefined) return false;
  const delta = alert.ownerNotifiedAt - alert.firstObservedAt;
  return delta >= 0 && delta <= OWNER_NOTIFY_OBJECTIVE_MS;
}

// ===========================================================================
// 7. Content digest (the durable-effect witness for a single alert).
// ===========================================================================

export function alertDigest(alert: Alert): string {
  return sha256(
    canonicalJson({
      id: alert.id,
      tenant: alert.tenantId,
      connector: alert.connectorId ?? null,
      component: alert.componentKey ?? null,
      class: alert.alertClass,
      severity: alert.severity,
      owner: alert.ownerPrincipalId,
      threshold: alert.threshold,
      observed: alert.observedValue,
      firstObservedAt: alert.firstObservedAt,
      ownerNotifiedAt: alert.ownerNotifiedAt ?? null,
      recoveredAt: alert.recoveredAt ?? null,
      state: alert.state,
      evidence: [...alert.evidenceIds].sort(),
    }),
  );
}
