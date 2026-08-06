// @trustcircle/domain — CONTROLLER-DEFINITION, CONTROLLER-INSTANCE, SIMULATION, CONTROLLER-OPERATION,
// CONTINUITY-LEASE, RECONCILIATION-RUN, and ROLLBACK aggregates (Phase 6 / User Story 4 — Operate
// Governance Controllers Safely / FR-023..028, FR-046..050, SC-010, SC-011, SC-021).
//
// This module is the value-level, dependency-free (node:crypto only) form of the durable controller
// operations substrate authored in `db/migrations/0040_controller_operations.sql`. It is aligned
// column-for-column with that migration, so a projection over the physical rows, an in-memory
// aggregate, and an API response share ONE vocabulary and ONE set of invariants.
//
// Each aggregate is constructed through an ASSERTING factory that refuses a write violating a
// fail-visible CHECK from the migration, and exposes a `*Digest` sha256 content-hash as an
// independently-observable durable-effect witness. The load-bearing invariants this module makes
// enforceable at the value level:
//
//   * VERSION PINNING + SOURCE BINDING (FR-024/FR-025 / NS-005). A `Simulation` and a
//     `ControllerOperation` pin the EXACT controller/adapter/policy versions AND the observed source
//     revision they were bound to. `sourceDriftInvalidates(sim, observed)` and the operation's
//     `boundRevisions` make a post-simulation source change detectable — a straight execution against
//     a drifted source is refused because authority + predicted effects no longer bind.
//   * ONE IDEMPOTENCY IDENTITY (FR-027 / SC-010). A `ControllerOperation` carries a single
//     `idempotencyKey`; a repeated request with the same key returns the prior operation, never a
//     duplicate governed effect. `OperationAttempt` records the per-dispatch idempotency identity so a
//     lost acknowledgement reconciles to ONE effect (FR-028 / SC-011).
//   * UNCERTAINTY IS NOT SUCCESS (FR-028 / NS-007). The `OperationAttempt` outcome vocabulary keeps
//     `dispatched_unconfirmed` and `uncertain` distinct from `confirmed`; only a `ReconciliationRun`
//     that establishes actual remote state may advance an operation past a mutating step.
//   * CONTINUITY NEVER CREATES AUTHORITY (FR-046..050 / SC-021). A `ControllerContinuityLease` is bounded
//     to ≤ 15 minutes (NFR-012), is nonrenewable in place, applies ONLY to an operation approved AND
//     started before the failure, pins a policy snapshot, and requires locally-verifiable conditions.
//     `controllerContinuityLeaseActiveAt` and `continuityMayExecuteStep` encode the ceiling + in-progress-only +
//     local-verifiability gates so continuity can never start a new operation or broaden scope.
//   * ROLLBACK PROTECTS NEWER STATE (FR-028 / NS-011). A `RollbackOutcome` distinguishes a verified
//     `rolled_back` from `partial` / `conflict` (newer legitimate state) / `unavailable` / `failed`;
//     only a verified full restore clears an operation, everything else escalates and stays degraded.
//
// Authority, policy currency, adapter health, and independence are NOT decided here — those verdicts
// come from the application services (execution-guard, adapter-activation, continuity-service) and are
// threaded in. This module owns the SHAPE and the fail-visible field vocabularies.

import { createHash } from 'node:crypto';
import { isUuid, type Uuid, type EpochMillis, type TenantId, type Reason } from './primitives.ts';

// ---------------------------------------------------------------------------
// Shared assert helpers (mirror integrity.ts / decisions.ts: fail-visible, throw on violation).
// ---------------------------------------------------------------------------

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}

function assertTenant(t: unknown, label: string): asserts t is TenantId {
  if (typeof t !== 'string' || t.length === 0) throw new TypeError(`${label} must be a tenant id`);
}

function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertEpoch(n: unknown, label: string): asserts n is EpochMillis {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms`);
  }
}

function assertMember<T extends string>(
  v: string,
  members: readonly T[],
  label: string,
): asserts v is T {
  if (!members.includes(v as T)) {
    throw new TypeError(`${label} must be one of ${members.join('|')}, got '${v}'`);
  }
}

function assertPositiveInt(n: unknown, label: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** Drop keys whose value is `undefined` (exactOptionalPropertyTypes) and freeze. */
function compact<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.freeze(out) as T;
}

function frozenObj(o: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...(o ?? {}) });
}

function frozenObjArray(
  xs: readonly Record<string, unknown>[] | undefined,
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze((xs ?? []).map((x) => frozenObj(x)));
}

// ===========================================================================
// 0. Shared operation vocabularies (mirror the migration CHECK domains exactly).
// ===========================================================================

/** The ten governed controller operation kinds (FR-023). `discover`/`inspect`/`collect_evidence`
 *  are read-only; the rest are state-changing and require simulation + approval per policy. */
export const OPERATION_KINDS = [
  'discover',
  'inspect',
  'simulate',
  'approve',
  'execute',
  'pause',
  'resume',
  'reconcile',
  'rollback',
  'collect_evidence',
  'emergency_stop',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** The read-only operation kinds — they never change governed state, so never require approval. */
export const READ_ONLY_OPERATION_KINDS: readonly OperationKind[] = [
  'discover',
  'inspect',
  'collect_evidence',
];

/** The state-changing operation kinds — subject to simulation + approval + execution guards. */
export const STATE_CHANGING_OPERATION_KINDS: readonly OperationKind[] = [
  'execute',
  'pause',
  'resume',
  'reconcile',
  'rollback',
  'emergency_stop',
];

export function isReadOnlyOperation(k: OperationKind): boolean {
  return READ_ONLY_OPERATION_KINDS.includes(k);
}

export const RISK_CLASSES = ['low', 'medium', 'high', 'critical'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const HEALTH_STATES = ['healthy', 'degraded', 'stale', 'unavailable', 'unknown'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

// ===========================================================================
// 1. controller_definition / controller_version — a STABLE controller plus its
//    IMMUTABLE versions (FR-024 / GAR-005). A version declares capabilities, risk,
//    required authority, preconditions, stop conditions, rollback, evidence plan,
//    health probe, tests, owner, and its approval-requirement policy. A controller
//    can ONLY be operated through its manifest-declared capabilities (the phase
//    checkpoint: "operators can control only manifest-declared, policy-authorized
//    actions").
// ===========================================================================

export const CONTROLLER_LIFECYCLE_STATES = [
  'draft',
  'proposed',
  'active',
  'deprecated',
  'retired',
] as const;
export type ControllerLifecycleState = (typeof CONTROLLER_LIFECYCLE_STATES)[number];

/** A single declared controller capability = one operation the controller may perform. */
export interface ControllerCapability {
  readonly name: string;
  readonly operationKind: OperationKind;
  readonly riskClass: RiskClass;
  readonly destructive: boolean;
  readonly requiresApproval: boolean;
  readonly requiresSimulation: boolean;
  readonly reversible: boolean;
}

export interface ControllerVersion {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerId: Uuid;
  readonly version: number;
  readonly name: string;
  readonly capabilities: readonly ControllerCapability[];
  readonly riskClass: RiskClass;
  readonly requiredAuthority: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly Readonly<Record<string, unknown>>[];
  readonly stopConditions: readonly Readonly<Record<string, unknown>>[];
  readonly rollbackPlan: Readonly<Record<string, unknown>>;
  readonly evidencePlan: Readonly<Record<string, unknown>>;
  readonly healthProbe: Readonly<Record<string, unknown>>;
  readonly tests: readonly Readonly<Record<string, unknown>>[];
  readonly ownerPrincipalId: Uuid;
  readonly approvalPolicy: Readonly<Record<string, unknown>>;
  readonly approvalDecisionId?: Uuid;
  readonly lifecycleState: ControllerLifecycleState;
  readonly effectiveFrom?: EpochMillis;
  readonly effectiveTo?: EpochMillis;
  readonly createdAt: EpochMillis;
}

function assertCapability(cap: unknown, label: string): asserts cap is ControllerCapability {
  if (typeof cap !== 'object' || cap === null) throw new TypeError(`${label} must be an object`);
  const c = cap as Record<string, unknown>;
  assertNonEmpty(c['name'], `${label}.name`);
  assertMember(String(c['operationKind']), OPERATION_KINDS, `${label}.operationKind`);
  assertMember(String(c['riskClass'] ?? 'medium'), RISK_CLASSES, `${label}.riskClass`);
}

export function makeControllerVersion(input: {
  id: Uuid;
  tenantId: TenantId;
  controllerId: Uuid;
  version: number;
  name: string;
  capabilities: readonly ControllerCapability[];
  riskClass?: RiskClass;
  requiredAuthority?: Record<string, unknown>;
  preconditions?: readonly Record<string, unknown>[];
  stopConditions?: readonly Record<string, unknown>[];
  rollbackPlan?: Record<string, unknown>;
  evidencePlan?: Record<string, unknown>;
  healthProbe?: Record<string, unknown>;
  tests?: readonly Record<string, unknown>[];
  ownerPrincipalId: Uuid;
  approvalPolicy?: Record<string, unknown>;
  approvalDecisionId?: Uuid;
  lifecycleState?: ControllerLifecycleState;
  effectiveFrom?: EpochMillis;
  effectiveTo?: EpochMillis;
  createdAt: EpochMillis;
}): ControllerVersion {
  assertUuid(input.id, 'controller.id');
  assertTenant(input.tenantId, 'controller.tenantId');
  assertUuid(input.controllerId, 'controller.controllerId');
  assertPositiveInt(input.version, 'controller.version');
  assertNonEmpty(input.name, 'controller.name');
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1) {
    throw new TypeError('controller.capabilities must be a non-empty array (a controller with no declared capability can operate nothing)');
  }
  const capabilities = input.capabilities.map((cap, i) => {
    assertCapability(cap, `controller.capabilities[${i}]`);
    return Object.freeze({
      name: cap.name,
      operationKind: cap.operationKind,
      riskClass: cap.riskClass,
      destructive: cap.destructive ?? false,
      requiresApproval: cap.requiresApproval ?? !isReadOnlyOperation(cap.operationKind),
      requiresSimulation: cap.requiresSimulation ?? !isReadOnlyOperation(cap.operationKind),
      reversible: cap.reversible ?? true,
    });
  });
  const riskClass = input.riskClass ?? 'medium';
  assertMember(riskClass, RISK_CLASSES, 'controller.riskClass');
  const lifecycleState = input.lifecycleState ?? 'draft';
  assertMember(lifecycleState, CONTROLLER_LIFECYCLE_STATES, 'controller.lifecycleState');
  assertUuid(input.ownerPrincipalId, 'controller.ownerPrincipalId');
  if (input.approvalDecisionId !== undefined) assertUuid(input.approvalDecisionId, 'controller.approvalDecisionId');
  const tests = frozenObjArray(input.tests);
  if (input.effectiveFrom !== undefined) assertEpoch(input.effectiveFrom, 'controller.effectiveFrom');
  if (input.effectiveTo !== undefined) assertEpoch(input.effectiveTo, 'controller.effectiveTo');
  // Fail-closed activation: an ACTIVE version must carry ≥1 test, a health probe, an activation
  // instant, and an approval-requirement policy — a controller cannot govern production without a
  // verification obligation, an observability probe, and a declared approval policy (GAR-005).
  if (lifecycleState === 'active') {
    if (input.effectiveFrom === undefined) {
      throw new TypeError('an active controller version requires an effectiveFrom instant (fail-closed activation)');
    }
    if (tests.length < 1) {
      throw new TypeError('an active controller version requires ≥ 1 test (fail-closed activation)');
    }
    if (input.approvalDecisionId === undefined) {
      throw new TypeError('an active controller version requires an approvalDecisionId (registration approval)');
    }
  }
  assertEpoch(input.createdAt, 'controller.createdAt');
  return compact<ControllerVersion>({
    id: input.id,
    tenantId: input.tenantId,
    controllerId: input.controllerId,
    version: input.version,
    name: input.name,
    capabilities: Object.freeze(capabilities),
    riskClass,
    requiredAuthority: frozenObj(input.requiredAuthority),
    preconditions: frozenObjArray(input.preconditions),
    stopConditions: frozenObjArray(input.stopConditions),
    rollbackPlan: frozenObj(input.rollbackPlan),
    evidencePlan: frozenObj(input.evidencePlan),
    healthProbe: frozenObj(input.healthProbe),
    tests,
    ownerPrincipalId: input.ownerPrincipalId,
    approvalPolicy: frozenObj(input.approvalPolicy),
    approvalDecisionId: input.approvalDecisionId,
    lifecycleState,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    createdAt: input.createdAt,
  });
}

/** The capability that declares `kind`, or undefined when the manifest does not declare it. An
 *  operation whose kind is not a declared capability MUST be refused (manifest-only control). */
export function capabilityFor(v: ControllerVersion, kind: OperationKind): ControllerCapability | undefined {
  return v.capabilities.find((c) => c.operationKind === kind);
}

/** True iff `kind` is a manifest-declared capability of this controller version. */
export function declaresCapability(v: ControllerVersion, kind: OperationKind): boolean {
  return capabilityFor(v, kind) !== undefined;
}

export function controllerVersionEffectiveAt(v: ControllerVersion, now: EpochMillis): boolean {
  if (v.lifecycleState !== 'active') return false;
  if (v.effectiveFrom === undefined || now < v.effectiveFrom) return false;
  if (v.effectiveTo !== undefined && now >= v.effectiveTo) return false;
  return true;
}

export function controllerVersionDigest(v: ControllerVersion): string {
  return sha256(
    JSON.stringify({
      id: v.id,
      tenantId: v.tenantId,
      controllerId: v.controllerId,
      version: v.version,
      name: v.name,
      capabilities: v.capabilities.map((c) => ({ ...c })),
      riskClass: v.riskClass,
      requiredAuthority: v.requiredAuthority,
      preconditions: v.preconditions,
      stopConditions: v.stopConditions,
      rollbackPlan: v.rollbackPlan,
      evidencePlan: v.evidencePlan,
      healthProbe: v.healthProbe,
      tests: v.tests,
      ownerPrincipalId: v.ownerPrincipalId,
      approvalPolicy: v.approvalPolicy,
      approvalDecisionId: v.approvalDecisionId ?? null,
      lifecycleState: v.lifecycleState,
      effectiveFrom: v.effectiveFrom ?? null,
      effectiveTo: v.effectiveTo ?? null,
      createdAt: v.createdAt,
    }),
  );
}

// ===========================================================================
// 2. controller_instance — a running controller bound to a version + adapter, with
//    observed health, current source revision, and the operator scope enabled on it
//    (FR-029). Desired-versus-observed drift is visible here (FR-024).
// ===========================================================================

export const INSTANCE_STATES = [
  'observed',
  'managed',
  'degraded',
  'stale',
  'unreachable',
  'retired',
] as const;
export type InstanceState = (typeof INSTANCE_STATES)[number];

export interface ControllerInstance {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerId: Uuid;
  readonly controllerVersionId: Uuid;
  readonly adapterId: Uuid;
  readonly adapterVersionId: Uuid;
  readonly ownerPrincipalId: Uuid;
  readonly enabledScope: Readonly<Record<string, unknown>>;
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly health: HealthState;
  readonly sourceRevision: string;
  readonly dependencies: readonly Readonly<Record<string, unknown>>[];
  readonly activeOperationId?: Uuid;
  readonly lastObservationAt: EpochMillis;
  readonly state: InstanceState;
  readonly version: number;
  readonly updatedAt: EpochMillis;
}

export function makeControllerInstance(input: {
  id: Uuid;
  tenantId: TenantId;
  controllerId: Uuid;
  controllerVersionId: Uuid;
  adapterId: Uuid;
  adapterVersionId: Uuid;
  ownerPrincipalId: Uuid;
  enabledScope?: Record<string, unknown>;
  desiredState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
  health?: HealthState;
  sourceRevision: string;
  dependencies?: readonly Record<string, unknown>[];
  activeOperationId?: Uuid;
  lastObservationAt: EpochMillis;
  state?: InstanceState;
  version?: number;
  updatedAt: EpochMillis;
}): ControllerInstance {
  assertUuid(input.id, 'instance.id');
  assertTenant(input.tenantId, 'instance.tenantId');
  assertUuid(input.controllerId, 'instance.controllerId');
  assertUuid(input.controllerVersionId, 'instance.controllerVersionId');
  assertUuid(input.adapterId, 'instance.adapterId');
  assertUuid(input.adapterVersionId, 'instance.adapterVersionId');
  assertUuid(input.ownerPrincipalId, 'instance.ownerPrincipalId');
  assertNonEmpty(input.sourceRevision, 'instance.sourceRevision');
  const health = input.health ?? 'unknown';
  assertMember(health, HEALTH_STATES, 'instance.health');
  const state = input.state ?? 'observed';
  assertMember(state, INSTANCE_STATES, 'instance.state');
  if (input.activeOperationId !== undefined) assertUuid(input.activeOperationId, 'instance.activeOperationId');
  const version = input.version ?? 1;
  assertPositiveInt(version, 'instance.version');
  assertEpoch(input.lastObservationAt, 'instance.lastObservationAt');
  assertEpoch(input.updatedAt, 'instance.updatedAt');
  return compact<ControllerInstance>({
    id: input.id,
    tenantId: input.tenantId,
    controllerId: input.controllerId,
    controllerVersionId: input.controllerVersionId,
    adapterId: input.adapterId,
    adapterVersionId: input.adapterVersionId,
    ownerPrincipalId: input.ownerPrincipalId,
    enabledScope: frozenObj(input.enabledScope),
    desiredState: frozenObj(input.desiredState),
    observedState: frozenObj(input.observedState),
    health,
    sourceRevision: input.sourceRevision,
    dependencies: frozenObjArray(input.dependencies),
    activeOperationId: input.activeOperationId,
    lastObservationAt: input.lastObservationAt,
    state,
    version,
    updatedAt: input.updatedAt,
  });
}

/** True iff the instance's observed state has drifted from its desired state (visible drift). */
export function instanceHasDrift(i: ControllerInstance): boolean {
  return JSON.stringify(i.desiredState) !== JSON.stringify(i.observedState);
}

export function controllerInstanceDigest(i: ControllerInstance): string {
  return sha256(
    JSON.stringify({
      id: i.id,
      tenantId: i.tenantId,
      controllerId: i.controllerId,
      controllerVersionId: i.controllerVersionId,
      adapterId: i.adapterId,
      adapterVersionId: i.adapterVersionId,
      ownerPrincipalId: i.ownerPrincipalId,
      enabledScope: i.enabledScope,
      desiredState: i.desiredState,
      observedState: i.observedState,
      health: i.health,
      sourceRevision: i.sourceRevision,
      dependencies: i.dependencies,
      activeOperationId: i.activeOperationId ?? null,
      lastObservationAt: i.lastObservationAt,
      state: i.state,
      version: i.version,
      updatedAt: i.updatedAt,
    }),
  );
}

// ===========================================================================
// 3. simulation — an EXPIRING predicted-effects record bound to the EXACT source /
//    controller / adapter / policy versions it was computed against (FR-025). A
//    source change after simulation (NS-005) invalidates the binding.
// ===========================================================================

/** The exact version tuple a simulation / operation binds to. A change in ANY member invalidates
 *  the prior authority + predicted effects. */
export interface BoundVersions {
  readonly controllerVersionId: Uuid;
  readonly adapterVersionId: Uuid;
  readonly policyVersionId: Uuid;
  readonly sourceRevision: string;
}

function assertBoundVersions(b: unknown, label: string): asserts b is BoundVersions {
  if (typeof b !== 'object' || b === null) throw new TypeError(`${label} required`);
  const v = b as Record<string, unknown>;
  assertUuid(v['controllerVersionId'], `${label}.controllerVersionId`);
  assertUuid(v['adapterVersionId'], `${label}.adapterVersionId`);
  assertUuid(v['policyVersionId'], `${label}.policyVersionId`);
  assertNonEmpty(v['sourceRevision'], `${label}.sourceRevision`);
}

function freezeBound(b: BoundVersions): BoundVersions {
  return Object.freeze({
    controllerVersionId: b.controllerVersionId,
    adapterVersionId: b.adapterVersionId,
    policyVersionId: b.policyVersionId,
    sourceRevision: b.sourceRevision,
  });
}

/** True iff two version tuples are identical member-for-member. */
export function boundVersionsEqual(a: BoundVersions, b: BoundVersions): boolean {
  return (
    a.controllerVersionId === b.controllerVersionId &&
    a.adapterVersionId === b.adapterVersionId &&
    a.policyVersionId === b.policyVersionId &&
    a.sourceRevision === b.sourceRevision
  );
}

export const SIMULATION_STATUSES = ['fresh', 'consumed', 'expired', 'invalidated'] as const;
export type SimulationStatus = (typeof SIMULATION_STATUSES)[number];

export interface Simulation {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerInstanceId: Uuid;
  readonly operationKind: OperationKind;
  readonly bound: BoundVersions;
  readonly predictedScope: Readonly<Record<string, unknown>>;
  readonly predictedImpact: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly Readonly<Record<string, unknown>>[];
  readonly conflicts: readonly Readonly<Record<string, unknown>>[];
  readonly evidencePlan: Readonly<Record<string, unknown>>;
  readonly stopConditions: readonly Readonly<Record<string, unknown>>[];
  readonly rollbackPlan: Readonly<Record<string, unknown>>;
  readonly riskClass: RiskClass;
  readonly status: SimulationStatus;
  readonly producedAt: EpochMillis;
  readonly expiresAt: EpochMillis;
}

export function makeSimulation(input: {
  id: Uuid;
  tenantId: TenantId;
  controllerInstanceId: Uuid;
  operationKind: OperationKind;
  bound: BoundVersions;
  predictedScope?: Record<string, unknown>;
  predictedImpact?: Record<string, unknown>;
  preconditions?: readonly Record<string, unknown>[];
  conflicts?: readonly Record<string, unknown>[];
  evidencePlan?: Record<string, unknown>;
  stopConditions?: readonly Record<string, unknown>[];
  rollbackPlan?: Record<string, unknown>;
  riskClass?: RiskClass;
  status?: SimulationStatus;
  producedAt: EpochMillis;
  expiresAt: EpochMillis;
}): Simulation {
  assertUuid(input.id, 'simulation.id');
  assertTenant(input.tenantId, 'simulation.tenantId');
  assertUuid(input.controllerInstanceId, 'simulation.controllerInstanceId');
  assertMember(input.operationKind, OPERATION_KINDS, 'simulation.operationKind');
  assertBoundVersions(input.bound, 'simulation.bound');
  const riskClass = input.riskClass ?? 'medium';
  assertMember(riskClass, RISK_CLASSES, 'simulation.riskClass');
  const status = input.status ?? 'fresh';
  assertMember(status, SIMULATION_STATUSES, 'simulation.status');
  assertEpoch(input.producedAt, 'simulation.producedAt');
  assertEpoch(input.expiresAt, 'simulation.expiresAt');
  if (input.expiresAt <= input.producedAt) {
    throw new RangeError('simulation.expiresAt must be strictly after producedAt (a simulation must expire)');
  }
  return compact<Simulation>({
    id: input.id,
    tenantId: input.tenantId,
    controllerInstanceId: input.controllerInstanceId,
    operationKind: input.operationKind,
    bound: freezeBound(input.bound),
    predictedScope: frozenObj(input.predictedScope),
    predictedImpact: frozenObj(input.predictedImpact),
    preconditions: frozenObjArray(input.preconditions),
    conflicts: frozenObjArray(input.conflicts),
    evidencePlan: frozenObj(input.evidencePlan),
    stopConditions: frozenObjArray(input.stopConditions),
    rollbackPlan: frozenObj(input.rollbackPlan),
    riskClass,
    status,
    producedAt: input.producedAt,
    expiresAt: input.expiresAt,
  });
}

/** True iff the simulation is still fresh AND unexpired at `now` — a stale simulation cannot bind. */
export function simulationIsCurrent(s: Simulation, now: EpochMillis): boolean {
  return s.status === 'fresh' && now < s.expiresAt;
}

/**
 * The SOURCE-DRIFT invalidation oracle (FR-025 / NS-005). A simulation binds to the exact version
 * tuple it was computed against. If the observed tuple at approval/execution time differs in ANY
 * member — most commonly a source revision change — the simulation no longer binds and the operation
 * MUST be re-simulated. Returns true when the simulation is INVALIDATED (drift detected or stale).
 */
export function sourceDriftInvalidates(s: Simulation, observed: BoundVersions, now: EpochMillis): boolean {
  if (!simulationIsCurrent(s, now)) return true;
  return !boundVersionsEqual(s.bound, observed);
}

export function simulationDigest(s: Simulation): string {
  return sha256(
    JSON.stringify({
      id: s.id,
      tenantId: s.tenantId,
      controllerInstanceId: s.controllerInstanceId,
      operationKind: s.operationKind,
      bound: s.bound,
      predictedScope: s.predictedScope,
      predictedImpact: s.predictedImpact,
      preconditions: s.preconditions,
      conflicts: s.conflicts,
      evidencePlan: s.evidencePlan,
      stopConditions: s.stopConditions,
      rollbackPlan: s.rollbackPlan,
      riskClass: s.riskClass,
      status: s.status,
      producedAt: s.producedAt,
      expiresAt: s.expiresAt,
    }),
  );
}

// ===========================================================================
// 4. controller_operation — a governed request through the lifecycle
//    requested → inspected → simulated → pending_approval → approved → executing →
//    (continuity|paused) → reconciling → verifying → succeeded|failed|cancelled|
//    rolled_back|escalated (FR-023/024). ONE idempotency identity (FR-027). Desired
//    and observed version tuples are pinned; a mutating step past `executing` requires
//    a current simulation binding.
// ===========================================================================

export const OPERATION_STATES = [
  'requested',
  'inspected',
  'simulated',
  'pending_approval',
  'approved',
  'executing',
  'continuity',
  'paused',
  'reconciling',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
  'rolled_back',
  'escalated',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** Terminal operation states (no further processing; queryable, never rewritten). */
export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'rolled_back',
  'escalated',
];

export function isTerminalOperationState(s: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(s);
}

/** The permitted next-state graph — an invalid/ambiguous transition MUST fail closed (data-model). */
const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  requested: ['inspected', 'cancelled'],
  inspected: ['simulated', 'cancelled'],
  simulated: ['pending_approval', 'simulated', 'cancelled'],
  pending_approval: ['approved', 'simulated', 'cancelled'],
  approved: ['executing', 'simulated', 'cancelled'],
  executing: ['continuity', 'paused', 'reconciling', 'verifying', 'failed', 'escalated'],
  continuity: ['paused', 'reconciling', 'executing', 'failed', 'escalated'],
  paused: ['executing', 'reconciling', 'cancelled', 'escalated'],
  reconciling: ['verifying', 'executing', 'paused', 'failed', 'rolled_back', 'escalated'],
  verifying: ['succeeded', 'failed', 'reconciling', 'rolled_back', 'escalated'],
  succeeded: [],
  failed: ['reconciling', 'rolled_back', 'escalated'],
  cancelled: [],
  rolled_back: [],
  escalated: ['reconciling', 'rolled_back'],
};

/** True iff `to` is a permitted operation transition from `from`. */
export function canOperationTransition(from: OperationState, to: OperationState): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

export function assertOperationTransition(from: OperationState, to: OperationState): void {
  if (!canOperationTransition(from, to)) {
    throw new RangeError(`illegal controller-operation transition: ${from} → ${to}`);
  }
}

/** The valid next OPERATION KINDS an operator may request, given the current state (FR-024). */
export function allowedNextOperations(state: OperationState): readonly OperationKind[] {
  switch (state) {
    case 'requested':
      return ['inspect', 'simulate', 'emergency_stop'];
    case 'inspected':
      return ['simulate', 'emergency_stop'];
    case 'simulated':
    case 'pending_approval':
      return ['approve', 'simulate', 'emergency_stop'];
    case 'approved':
      return ['execute', 'emergency_stop'];
    case 'executing':
    case 'continuity':
      return ['pause', 'reconcile', 'collect_evidence', 'emergency_stop'];
    case 'paused':
      return ['resume', 'reconcile', 'rollback', 'collect_evidence', 'emergency_stop'];
    case 'reconciling':
      return ['collect_evidence', 'rollback', 'emergency_stop'];
    case 'verifying':
      return ['reconcile', 'rollback', 'collect_evidence', 'emergency_stop'];
    case 'failed':
    case 'escalated':
      return ['reconcile', 'rollback', 'collect_evidence'];
    default:
      // terminal (succeeded/cancelled/rolled_back): read-only evidence only
      return ['collect_evidence'];
  }
}

export interface ControllerOperation {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerInstanceId: Uuid;
  readonly operationKind: OperationKind;
  readonly requestedByPrincipalId: Uuid;
  readonly ownerPrincipalId: Uuid;
  /** ONE idempotency identity — a replay with the same key returns THIS operation (FR-027). */
  readonly idempotencyKey: string;
  readonly riskClass: RiskClass;
  readonly desiredVersions: BoundVersions;
  readonly observedVersions: BoundVersions;
  readonly simulationId?: Uuid;
  readonly approvalDecisionId?: Uuid;
  readonly steps: readonly Readonly<Record<string, unknown>>[];
  readonly bounds: Readonly<Record<string, unknown>>;
  readonly evidencePlan: Readonly<Record<string, unknown>>;
  readonly continuityLeaseId?: Uuid;
  readonly state: OperationState;
  readonly version: number;
  readonly requestedAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export function makeControllerOperation(input: {
  id: Uuid;
  tenantId: TenantId;
  controllerInstanceId: Uuid;
  operationKind: OperationKind;
  requestedByPrincipalId: Uuid;
  ownerPrincipalId: Uuid;
  idempotencyKey: string;
  riskClass?: RiskClass;
  desiredVersions: BoundVersions;
  observedVersions?: BoundVersions;
  simulationId?: Uuid;
  approvalDecisionId?: Uuid;
  steps?: readonly Record<string, unknown>[];
  bounds?: Record<string, unknown>;
  evidencePlan?: Record<string, unknown>;
  continuityLeaseId?: Uuid;
  state?: OperationState;
  version?: number;
  requestedAt: EpochMillis;
  updatedAt: EpochMillis;
}): ControllerOperation {
  assertUuid(input.id, 'operation.id');
  assertTenant(input.tenantId, 'operation.tenantId');
  assertUuid(input.controllerInstanceId, 'operation.controllerInstanceId');
  assertMember(input.operationKind, OPERATION_KINDS, 'operation.operationKind');
  assertUuid(input.requestedByPrincipalId, 'operation.requestedByPrincipalId');
  assertUuid(input.ownerPrincipalId, 'operation.ownerPrincipalId');
  // ONE idempotency identity (FR-027 shape): a replay carries the SAME key ⇒ SAME governed effect.
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length < 8) {
    throw new TypeError('operation.idempotencyKey must be ≥ 8 chars (one idempotency identity)');
  }
  const riskClass = input.riskClass ?? 'medium';
  assertMember(riskClass, RISK_CLASSES, 'operation.riskClass');
  assertBoundVersions(input.desiredVersions, 'operation.desiredVersions');
  const observed = input.observedVersions ?? input.desiredVersions;
  assertBoundVersions(observed, 'operation.observedVersions');
  if (input.simulationId !== undefined) assertUuid(input.simulationId, 'operation.simulationId');
  if (input.approvalDecisionId !== undefined) assertUuid(input.approvalDecisionId, 'operation.approvalDecisionId');
  if (input.continuityLeaseId !== undefined) assertUuid(input.continuityLeaseId, 'operation.continuityLeaseId');
  const state = input.state ?? 'requested';
  assertMember(state, OPERATION_STATES, 'operation.state');
  // A state-changing operation may only reach approved/executing/onward with a simulation + approval.
  if (STATE_CHANGING_OPERATION_KINDS.includes(input.operationKind) && input.operationKind !== 'emergency_stop') {
    const needsGate = (['approved', 'executing', 'continuity', 'paused', 'reconciling', 'verifying', 'succeeded', 'rolled_back'] as OperationState[]).includes(state);
    if (needsGate) {
      if (input.simulationId === undefined) {
        throw new TypeError(`a state-changing operation at state=${state} requires a simulationId (simulate-before-execute)`);
      }
      if (input.approvalDecisionId === undefined) {
        throw new TypeError(`a state-changing operation at state=${state} requires an approvalDecisionId (approve-before-execute)`);
      }
    }
  }
  // A continuity-mode operation MUST carry a continuity lease (FR-046/047).
  if (state === 'continuity' && input.continuityLeaseId === undefined) {
    throw new TypeError('an operation in continuity state must carry a continuityLeaseId (FR-046)');
  }
  const version = input.version ?? 1;
  assertPositiveInt(version, 'operation.version');
  assertEpoch(input.requestedAt, 'operation.requestedAt');
  assertEpoch(input.updatedAt, 'operation.updatedAt');
  return compact<ControllerOperation>({
    id: input.id,
    tenantId: input.tenantId,
    controllerInstanceId: input.controllerInstanceId,
    operationKind: input.operationKind,
    requestedByPrincipalId: input.requestedByPrincipalId,
    ownerPrincipalId: input.ownerPrincipalId,
    idempotencyKey: input.idempotencyKey.trim(),
    riskClass,
    desiredVersions: freezeBound(input.desiredVersions),
    observedVersions: freezeBound(observed),
    simulationId: input.simulationId,
    approvalDecisionId: input.approvalDecisionId,
    steps: frozenObjArray(input.steps),
    bounds: frozenObj(input.bounds),
    evidencePlan: frozenObj(input.evidencePlan),
    continuityLeaseId: input.continuityLeaseId,
    state,
    version,
    requestedAt: input.requestedAt,
    updatedAt: input.updatedAt,
  });
}

/** True iff the operation's observed versions have drifted from the versions it was authorized on. */
export function operationHasDrift(op: ControllerOperation): boolean {
  return !boundVersionsEqual(op.desiredVersions, op.observedVersions);
}

export function controllerOperationDigest(op: ControllerOperation): string {
  return sha256(
    JSON.stringify({
      id: op.id,
      tenantId: op.tenantId,
      controllerInstanceId: op.controllerInstanceId,
      operationKind: op.operationKind,
      requestedByPrincipalId: op.requestedByPrincipalId,
      ownerPrincipalId: op.ownerPrincipalId,
      idempotencyKey: op.idempotencyKey,
      riskClass: op.riskClass,
      desiredVersions: op.desiredVersions,
      observedVersions: op.observedVersions,
      simulationId: op.simulationId ?? null,
      approvalDecisionId: op.approvalDecisionId ?? null,
      steps: op.steps,
      bounds: op.bounds,
      evidencePlan: op.evidencePlan,
      continuityLeaseId: op.continuityLeaseId ?? null,
      state: op.state,
      version: op.version,
      requestedAt: op.requestedAt,
      updatedAt: op.updatedAt,
    }),
  );
}

// ===========================================================================
// 5. operation_attempt — one DISPATCH of an operation step to the adapter (FR-027/028).
//    Carries its OWN idempotency identity and an outcome vocabulary where a lost
//    acknowledgement is `dispatched_unconfirmed` / `uncertain`, NEVER `confirmed`.
// ===========================================================================

export const ATTEMPT_OUTCOMES = [
  'pending',
  'dispatched_unconfirmed',
  'confirmed',
  'no_effect',
  'failed',
  'uncertain',
  'timed_out',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Outcomes whose actual remote effect is UNKNOWN — they must reconcile before any new mutation. */
export const UNCERTAIN_ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'dispatched_unconfirmed',
  'uncertain',
  'timed_out',
];

export function attemptIsUncertain(a: OperationAttempt): boolean {
  return UNCERTAIN_ATTEMPT_OUTCOMES.includes(a.outcome);
}

export interface OperationAttempt {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly operationId: Uuid;
  readonly stepId: string;
  readonly attemptNumber: number;
  /** The per-dispatch idempotency key sent to the adapter — a replay carries the SAME key. */
  readonly dispatchIdempotencyKey: string;
  readonly boundAdapterVersionId: Uuid;
  readonly requestDigest: string;
  readonly acknowledged: boolean;
  readonly remoteEffectObserved: boolean;
  readonly response: Readonly<Record<string, unknown>>;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly bufferedForContinuity: boolean;
  readonly outcome: AttemptOutcome;
  readonly startedAt: EpochMillis;
  readonly completedAt?: EpochMillis;
}

export function makeOperationAttempt(input: {
  id: Uuid;
  tenantId: TenantId;
  operationId: Uuid;
  stepId: string;
  attemptNumber: number;
  dispatchIdempotencyKey: string;
  boundAdapterVersionId: Uuid;
  requestDigest?: string;
  acknowledged?: boolean;
  remoteEffectObserved?: boolean;
  response?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  bufferedForContinuity?: boolean;
  outcome?: AttemptOutcome;
  startedAt: EpochMillis;
  completedAt?: EpochMillis;
}): OperationAttempt {
  assertUuid(input.id, 'attempt.id');
  assertTenant(input.tenantId, 'attempt.tenantId');
  assertUuid(input.operationId, 'attempt.operationId');
  assertNonEmpty(input.stepId, 'attempt.stepId');
  assertPositiveInt(input.attemptNumber, 'attempt.attemptNumber');
  if (typeof input.dispatchIdempotencyKey !== 'string' || input.dispatchIdempotencyKey.trim().length < 8) {
    throw new TypeError('attempt.dispatchIdempotencyKey must be ≥ 8 chars');
  }
  assertUuid(input.boundAdapterVersionId, 'attempt.boundAdapterVersionId');
  const outcome = input.outcome ?? 'pending';
  assertMember(outcome, ATTEMPT_OUTCOMES, 'attempt.outcome');
  const acknowledged = input.acknowledged ?? false;
  const remoteEffectObserved = input.remoteEffectObserved ?? false;
  // UNCERTAINTY IS NOT SUCCESS (FR-028): `confirmed` REQUIRES a directly observed remote effect —
  // a bare acknowledgement (which can be lost or arrive without the effect) is never confirmation.
  if (outcome === 'confirmed' && !remoteEffectObserved) {
    throw new TypeError('attempt.outcome=confirmed requires remoteEffectObserved=true (acknowledgement is not confirmation, FR-028)');
  }
  assertEpoch(input.startedAt, 'attempt.startedAt');
  if (input.completedAt !== undefined) assertEpoch(input.completedAt, 'attempt.completedAt');
  return compact<OperationAttempt>({
    id: input.id,
    tenantId: input.tenantId,
    operationId: input.operationId,
    stepId: input.stepId,
    attemptNumber: input.attemptNumber,
    dispatchIdempotencyKey: input.dispatchIdempotencyKey.trim(),
    boundAdapterVersionId: input.boundAdapterVersionId,
    requestDigest: input.requestDigest ?? sha256(`${input.operationId}:${input.stepId}:${input.attemptNumber}`),
    acknowledged,
    remoteEffectObserved,
    response: frozenObj(input.response),
    checkpoint: frozenObj(input.checkpoint),
    bufferedForContinuity: input.bufferedForContinuity ?? false,
    outcome,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

export function operationAttemptDigest(a: OperationAttempt): string {
  return sha256(
    JSON.stringify({
      id: a.id,
      tenantId: a.tenantId,
      operationId: a.operationId,
      stepId: a.stepId,
      attemptNumber: a.attemptNumber,
      dispatchIdempotencyKey: a.dispatchIdempotencyKey,
      boundAdapterVersionId: a.boundAdapterVersionId,
      requestDigest: a.requestDigest,
      acknowledged: a.acknowledged,
      remoteEffectObserved: a.remoteEffectObserved,
      response: a.response,
      checkpoint: a.checkpoint,
      bufferedForContinuity: a.bufferedForContinuity,
      outcome: a.outcome,
      startedAt: a.startedAt,
      completedAt: a.completedAt ?? null,
    }),
  );
}

// ===========================================================================
// 6. continuity_lease — a BOUNDED, NONRENEWABLE continuity authorization
//    (FR-046..050 / NFR-012 / SC-021). ≤ 15 minutes; pins a policy snapshot; applies
//    ONLY to an operation approved AND started before the failure; requires locally-
//    verifiable conditions; never grants authority or broadens scope.
// ===========================================================================

/** The hard continuity ceiling — a lease may not exceed 15 minutes (NFR-012). */
export const CONTINUITY_LEASE_CEILING_MS = 15 * 60 * 1000;

export const CONTINUITY_LEASE_STATES = ['active', 'expired', 'stopped', 'reconciled'] as const;
export type ControllerContinuityLeaseState = (typeof CONTINUITY_LEASE_STATES)[number];

export interface ControllerContinuityLease {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly operationId: Uuid;
  readonly continuityPolicyVersionId: Uuid;
  /** The pinned policy snapshot — the ONLY policy this lease may act under (FR-046). */
  readonly policySnapshot: Readonly<Record<string, unknown>>;
  readonly eligibleOperationClasses: readonly OperationKind[];
  readonly actionLimit: number;
  readonly resourceLimits: Readonly<Record<string, unknown>>;
  readonly requiredLocalObservations: readonly string[];
  readonly stopConditions: readonly Readonly<Record<string, unknown>>[];
  readonly ownerPrincipalId: Uuid;
  /** True iff the operation was approved AND started before the health/connectivity failure (FR-047). */
  readonly operationStartedBeforeFailure: boolean;
  readonly grantedAt: EpochMillis;
  readonly expiresAt: EpochMillis;
  readonly state: ControllerContinuityLeaseState;
  /** A lease is NONRENEWABLE in place: renewal requires restored health + reconciliation (NFR-012). */
  readonly renewable: false;
}

export function makeControllerContinuityLease(input: {
  id: Uuid;
  tenantId: TenantId;
  operationId: Uuid;
  continuityPolicyVersionId: Uuid;
  policySnapshot?: Record<string, unknown>;
  eligibleOperationClasses?: readonly OperationKind[];
  actionLimit?: number;
  resourceLimits?: Record<string, unknown>;
  requiredLocalObservations?: readonly string[];
  stopConditions?: readonly Record<string, unknown>[];
  ownerPrincipalId: Uuid;
  operationStartedBeforeFailure: boolean;
  grantedAt: EpochMillis;
  expiresAt: EpochMillis;
  state?: ControllerContinuityLeaseState;
}): ControllerContinuityLease {
  assertUuid(input.id, 'lease.id');
  assertTenant(input.tenantId, 'lease.tenantId');
  assertUuid(input.operationId, 'lease.operationId');
  assertUuid(input.continuityPolicyVersionId, 'lease.continuityPolicyVersionId');
  assertUuid(input.ownerPrincipalId, 'lease.ownerPrincipalId');
  assertEpoch(input.grantedAt, 'lease.grantedAt');
  assertEpoch(input.expiresAt, 'lease.expiresAt');
  // FR-047: continuity applies ONLY to an operation approved AND started before the failure. A lease
  // whose operation had not started is a NEW-authority grant and is forbidden.
  if (input.operationStartedBeforeFailure !== true) {
    throw new TypeError('a continuity lease requires operationStartedBeforeFailure=true (continuity never starts a new operation, FR-047)');
  }
  const durationMs = input.expiresAt - input.grantedAt;
  if (durationMs <= 0) {
    throw new RangeError('lease.expiresAt must be strictly after grantedAt');
  }
  // NFR-012: hard 15-minute ceiling — a lease may not exceed it.
  if (durationMs > CONTINUITY_LEASE_CEILING_MS) {
    throw new RangeError(`a continuity lease may not exceed ${CONTINUITY_LEASE_CEILING_MS}ms (15 minutes, NFR-012); got ${durationMs}ms`);
  }
  const state = input.state ?? 'active';
  assertMember(state, CONTINUITY_LEASE_STATES, 'lease.state');
  const eligible = input.eligibleOperationClasses ?? [];
  for (const k of eligible) assertMember(k, OPERATION_KINDS, 'lease.eligibleOperationClasses entry');
  const actionLimit = input.actionLimit ?? 1;
  assertPositiveInt(actionLimit, 'lease.actionLimit');
  const obs = input.requiredLocalObservations ?? [];
  for (const o of obs) assertNonEmpty(o, 'lease.requiredLocalObservations entry');
  return compact<ControllerContinuityLease>({
    id: input.id,
    tenantId: input.tenantId,
    operationId: input.operationId,
    continuityPolicyVersionId: input.continuityPolicyVersionId,
    policySnapshot: frozenObj(input.policySnapshot),
    eligibleOperationClasses: Object.freeze([...eligible]),
    actionLimit,
    resourceLimits: frozenObj(input.resourceLimits),
    requiredLocalObservations: Object.freeze([...obs]),
    stopConditions: frozenObjArray(input.stopConditions),
    ownerPrincipalId: input.ownerPrincipalId,
    operationStartedBeforeFailure: true,
    grantedAt: input.grantedAt,
    expiresAt: input.expiresAt,
    state,
    renewable: false,
  });
}

/** True iff the lease is active AND unexpired at `now`. Beyond expiry the controller MUST pause. */
export function controllerContinuityLeaseActiveAt(l: ControllerContinuityLease, now: EpochMillis): boolean {
  return l.state === 'active' && now < l.expiresAt;
}

/**
 * The CONTINUITY STEP GATE (FR-048 / SC-021). A controller in continuity mode may execute a step
 * ONLY when: the lease is active + unexpired; the step's operation kind is in the lease's eligible
 * classes; every required local observation is currently satisfiable; and — for a NEW consequential,
 * destructive, or irreversible step — its live safety conditions are locally verifiable. Returns a
 * structured verdict so a caller can act AND explain.
 */
export function continuityMayExecuteStep(input: {
  lease: ControllerContinuityLease;
  operationKind: OperationKind;
  now: EpochMillis;
  localObservationsSatisfied: boolean;
  stepIsNewConsequential: boolean;
  liveSafetyLocallyVerifiable: boolean;
  actionsAlreadyTaken: number;
}): { readonly permitted: boolean; readonly reason: string } {
  const { lease, operationKind, now } = input;
  if (!controllerContinuityLeaseActiveAt(lease, now)) {
    return { permitted: false, reason: 'lease_expired_or_inactive' };
  }
  if (lease.eligibleOperationClasses.length > 0 && !lease.eligibleOperationClasses.includes(operationKind)) {
    return { permitted: false, reason: 'operation_class_not_eligible' };
  }
  if (input.actionsAlreadyTaken >= lease.actionLimit) {
    return { permitted: false, reason: 'action_limit_exhausted' };
  }
  if (!input.localObservationsSatisfied) {
    return { permitted: false, reason: 'required_local_observations_unsatisfied' };
  }
  // FR-048: a new consequential/destructive/irreversible step MUST pause when live safety conditions
  // cannot be revalidated locally.
  if (input.stepIsNewConsequential && !input.liveSafetyLocallyVerifiable) {
    return { permitted: false, reason: 'new_consequential_step_not_locally_verifiable' };
  }
  return { permitted: true, reason: 'locally_verifiable' };
}

export function controllerContinuityLeaseDigest(l: ControllerContinuityLease): string {
  return sha256(
    JSON.stringify({
      id: l.id,
      tenantId: l.tenantId,
      operationId: l.operationId,
      continuityPolicyVersionId: l.continuityPolicyVersionId,
      policySnapshot: l.policySnapshot,
      eligibleOperationClasses: [...l.eligibleOperationClasses].sort(),
      actionLimit: l.actionLimit,
      resourceLimits: l.resourceLimits,
      requiredLocalObservations: [...l.requiredLocalObservations].sort(),
      stopConditions: l.stopConditions,
      ownerPrincipalId: l.ownerPrincipalId,
      operationStartedBeforeFailure: l.operationStartedBeforeFailure,
      grantedAt: l.grantedAt,
      expiresAt: l.expiresAt,
      state: l.state,
      renewable: l.renewable,
    }),
  );
}

// ===========================================================================
// 7. reconciliation_run — establish ACTUAL state across desired / dispatched / remote
//    / observed / canonical, WITHOUT inferring success from acknowledgements
//    (FR-028 / SC-011). One-effect reconciliation for a lost acknowledgement.
// ===========================================================================

export const RECONCILIATION_RESULTS = [
  'reconciled_effect_present',
  'reconciled_no_effect',
  'still_uncertain',
  'conflict',
  'failed',
] as const;
export type ReconciliationResult = (typeof RECONCILIATION_RESULTS)[number];

/** Results that ESTABLISH actual state (a subsequent mutation is permitted). */
export const RESOLVED_RECONCILIATION_RESULTS: readonly ReconciliationResult[] = [
  'reconciled_effect_present',
  'reconciled_no_effect',
];

export function reconciliationEstablishedState(r: ReconciliationRun): boolean {
  return RESOLVED_RECONCILIATION_RESULTS.includes(r.result);
}

export interface ReconciliationRun {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly operationId: Uuid;
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly dispatchedState: Readonly<Record<string, unknown>>;
  readonly remoteObservedState: Readonly<Record<string, unknown>>;
  readonly canonicalState: Readonly<Record<string, unknown>>;
  /** The attempts reconciled — a lost-ack attempt reconciles to a SINGLE effect. */
  readonly reconciledAttemptIds: readonly Uuid[];
  /** Count of effects actually observed on the remote (used to prove no duplicate effect). */
  readonly observedEffectCount: number;
  /** True iff reconciliation established state from a DIRECT remote observation, not an ack. */
  readonly usedRemoteObservation: boolean;
  readonly result: ReconciliationResult;
  readonly reason: Reason;
  readonly ranAt: EpochMillis;
}

export function makeReconciliationRun(input: {
  id: Uuid;
  tenantId: TenantId;
  operationId: Uuid;
  desiredState?: Record<string, unknown>;
  dispatchedState?: Record<string, unknown>;
  remoteObservedState?: Record<string, unknown>;
  canonicalState?: Record<string, unknown>;
  reconciledAttemptIds?: readonly Uuid[];
  observedEffectCount?: number;
  usedRemoteObservation?: boolean;
  result: ReconciliationResult;
  reason: Reason;
  ranAt: EpochMillis;
}): ReconciliationRun {
  assertUuid(input.id, 'reconciliation.id');
  assertTenant(input.tenantId, 'reconciliation.tenantId');
  assertUuid(input.operationId, 'reconciliation.operationId');
  const ids = input.reconciledAttemptIds ?? [];
  for (const a of ids) assertUuid(a, 'reconciliation.reconciledAttemptIds entry');
  const result = input.result;
  assertMember(result, RECONCILIATION_RESULTS, 'reconciliation.result');
  assertNonEmpty(input.reason.code, 'reconciliation.reason.code');
  assertNonEmpty(input.reason.text, 'reconciliation.reason.text');
  const observedEffectCount = input.observedEffectCount ?? 0;
  if (!Number.isInteger(observedEffectCount) || observedEffectCount < 0) {
    throw new RangeError('reconciliation.observedEffectCount must be a non-negative integer');
  }
  const usedRemoteObservation = input.usedRemoteObservation ?? false;
  // NEVER infer success from an acknowledgement (FR-028): a `reconciled_effect_present` verdict
  // REQUIRES a direct remote observation, not a returned ack.
  if (result === 'reconciled_effect_present' && !usedRemoteObservation) {
    throw new TypeError('reconciled_effect_present requires usedRemoteObservation=true (never infer success from an acknowledgement, FR-028)');
  }
  // A duplicate effect is a defect: reconciliation of a single logical dispatch must not observe > 1.
  if (result === 'reconciled_effect_present' && observedEffectCount > 1) {
    throw new TypeError('reconciled_effect_present with observedEffectCount>1 is a duplicate governed effect (SC-011)');
  }
  assertEpoch(input.ranAt, 'reconciliation.ranAt');
  return compact<ReconciliationRun>({
    id: input.id,
    tenantId: input.tenantId,
    operationId: input.operationId,
    desiredState: frozenObj(input.desiredState),
    dispatchedState: frozenObj(input.dispatchedState),
    remoteObservedState: frozenObj(input.remoteObservedState),
    canonicalState: frozenObj(input.canonicalState),
    reconciledAttemptIds: Object.freeze([...ids]),
    observedEffectCount,
    usedRemoteObservation,
    result,
    reason: { code: input.reason.code, text: input.reason.text },
    ranAt: input.ranAt,
  });
}

export function reconciliationRunDigest(r: ReconciliationRun): string {
  return sha256(
    JSON.stringify({
      id: r.id,
      tenantId: r.tenantId,
      operationId: r.operationId,
      desiredState: r.desiredState,
      dispatchedState: r.dispatchedState,
      remoteObservedState: r.remoteObservedState,
      canonicalState: r.canonicalState,
      reconciledAttemptIds: [...r.reconciledAttemptIds].sort(),
      observedEffectCount: r.observedEffectCount,
      usedRemoteObservation: r.usedRemoteObservation,
      result: r.result,
      reason: r.reason,
      ranAt: r.ranAt,
    }),
  );
}

// ===========================================================================
// 8. ROLLBACK — restore the PRESERVED preimage while protecting NEWER legitimate state
//    (FR-028 / NS-011). Only a verified full restore clears the operation; everything
//    else escalates and stays degraded.
// ===========================================================================

export const ROLLBACK_RESULTS = ['rolled_back', 'partial', 'conflict', 'unavailable', 'failed'] as const;
export type RollbackResult = (typeof ROLLBACK_RESULTS)[number];

export interface RollbackContext {
  readonly operationId: Uuid;
  /** The preserved preimage the rollback restores TO. Rollback is impossible without it. */
  readonly preimageEvidenceId: Uuid | null;
  /** The revision the operation produced (what the source should currently be). */
  readonly producedRevision: string;
  /** The revision OBSERVED on the source now (drift ⇒ newer legitimate state). */
  readonly observedRevision: string;
  readonly compensatedSteps: number;
  readonly totalSteps: number;
  /** True iff compensation is AVAILABLE (an irreversible step has no compensation). */
  readonly compensationAvailable: boolean;
  readonly compensationSucceeded: boolean;
  /** True iff post-rollback state was verified equal to the preimage via a DIRECT remote read. */
  readonly restorationVerified: boolean;
}

export interface RollbackDecision {
  readonly result: RollbackResult;
  /** True iff the operation may be cleared (only a fully verified restore). */
  readonly operationCleared: boolean;
  /** True iff newer legitimate state was protected (a straight restore refused). */
  readonly protectedNewerState: boolean;
  /** True iff the affected scope must remain visibly degraded + block further unsafe actions. */
  readonly remainsDegraded: boolean;
  readonly mustEscalate: boolean;
  readonly residualDifferences: number;
}

/**
 * Decide the rollback result against the preserved preimage. Ordering is fail-closed and newer-state-
 * protective: no preimage ⇒ `unavailable`; source drift (newer legitimate state) ⇒ `conflict`;
 * compensation not available ⇒ `unavailable`; compensation failed ⇒ `failed`; partial compensation ⇒
 * `partial`; a full compensation is complete ONLY when the restoration is verified via a direct read.
 * Only a fully verified `rolled_back` clears the operation; every other result stays degraded +
 * escalates (NS-011).
 */
export function decideRollback(ctx: RollbackContext): RollbackDecision {
  const residual = Math.max(0, ctx.totalSteps - ctx.compensatedSteps);

  if (ctx.preimageEvidenceId === null) {
    return { result: 'unavailable', operationCleared: false, protectedNewerState: false, remainsDegraded: true, mustEscalate: true, residualDifferences: residual };
  }
  // Protect newer legitimate state — a straight restore over a drifted source destroys real work.
  if (ctx.observedRevision !== ctx.producedRevision) {
    return { result: 'conflict', operationCleared: false, protectedNewerState: true, remainsDegraded: true, mustEscalate: true, residualDifferences: residual };
  }
  if (!ctx.compensationAvailable) {
    return { result: 'unavailable', operationCleared: false, protectedNewerState: false, remainsDegraded: true, mustEscalate: true, residualDifferences: residual };
  }
  if (!ctx.compensationSucceeded) {
    return { result: 'failed', operationCleared: false, protectedNewerState: false, remainsDegraded: true, mustEscalate: true, residualDifferences: residual };
  }
  if (ctx.compensatedSteps < ctx.totalSteps) {
    return { result: 'partial', operationCleared: false, protectedNewerState: false, remainsDegraded: true, mustEscalate: true, residualDifferences: residual };
  }
  if (!ctx.restorationVerified) {
    return { result: 'partial', operationCleared: false, protectedNewerState: false, remainsDegraded: true, mustEscalate: true, residualDifferences: 0 };
  }
  return { result: 'rolled_back', operationCleared: true, protectedNewerState: false, remainsDegraded: false, mustEscalate: false, residualDifferences: 0 };
}
