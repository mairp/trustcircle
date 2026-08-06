// @trustcircle/application — SIMULATION SERVICE: produce an EXPIRING simulation bound to the EXACT
// source / controller / adapter / policy versions it was computed against, and decide when SOURCE
// DRIFT invalidates it (Phase 6 / User Story 4 / FR-025, NS-005).
//
// Simulate-before-execute is the core of manifest-safe control: before any state-changing operation
// executes, the operator sees a PREDICTED effect. That prediction is only trustworthy if the world it
// was computed against has not moved. So a simulation PINS a version tuple — controller version,
// adapter version, policy version, and the source revision — and EXPIRES. At approval/execution time
// the service re-reads the observed tuple; if ANY member drifted (most commonly the source revision,
// NS-005), or the simulation has expired, the simulation no longer binds and the operation MUST be
// re-simulated. This is the `sourceDriftInvalidates` domain oracle; this service is the thin
// coordinator that builds the simulation and applies the oracle.
//
// Pure and clock-free: the caller supplies `producedAt`, `expiresAt`, and the `now` used for the
// drift check.

import {
  type Uuid,
  type TenantId,
  type EpochMillis,
  type OperationKind,
  type RiskClass,
  type Simulation,
  type BoundVersions,
  makeSimulation,
  simulationDigest,
  simulationIsCurrent,
  sourceDriftInvalidates,
  boundVersionsEqual,
} from '@trustcircle/domain';

/** The default simulation validity window: a simulation older than this cannot authorize execution. */
export const DEFAULT_SIMULATION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ProduceSimulationInput {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerInstanceId: Uuid;
  readonly operationKind: OperationKind;
  readonly bound: BoundVersions;
  readonly predictedScope?: Record<string, unknown>;
  readonly predictedImpact?: Record<string, unknown>;
  readonly preconditions?: readonly Record<string, unknown>[];
  readonly conflicts?: readonly Record<string, unknown>[];
  readonly evidencePlan?: Record<string, unknown>;
  readonly stopConditions?: readonly Record<string, unknown>[];
  readonly rollbackPlan?: Record<string, unknown>;
  readonly riskClass?: RiskClass;
  readonly producedAt: EpochMillis;
  /** Optional explicit expiry; defaults to producedAt + DEFAULT_SIMULATION_TTL_MS. */
  readonly expiresAt?: EpochMillis;
}

export interface ProducedSimulation {
  readonly simulation: Simulation;
  readonly digest: string;
}

/** Produce (construct) a version-pinned, expiring simulation. Delegates the "must expire" invariant
 *  to the domain factory. */
export function produceSimulation(input: ProduceSimulationInput): ProducedSimulation {
  const expiresAt = input.expiresAt ?? input.producedAt + DEFAULT_SIMULATION_TTL_MS;
  const simulation = makeSimulation({
    id: input.id,
    tenantId: input.tenantId,
    controllerInstanceId: input.controllerInstanceId,
    operationKind: input.operationKind,
    bound: input.bound,
    // exactOptionalPropertyTypes: forward each optional only when present, never as an explicit
    // `undefined` (the factory params are `x?: T`, not `x?: T | undefined`).
    ...(input.predictedScope !== undefined ? { predictedScope: input.predictedScope } : {}),
    ...(input.predictedImpact !== undefined ? { predictedImpact: input.predictedImpact } : {}),
    ...(input.preconditions !== undefined ? { preconditions: input.preconditions } : {}),
    ...(input.conflicts !== undefined ? { conflicts: input.conflicts } : {}),
    ...(input.evidencePlan !== undefined ? { evidencePlan: input.evidencePlan } : {}),
    ...(input.stopConditions !== undefined ? { stopConditions: input.stopConditions } : {}),
    ...(input.rollbackPlan !== undefined ? { rollbackPlan: input.rollbackPlan } : {}),
    ...(input.riskClass !== undefined ? { riskClass: input.riskClass } : {}),
    producedAt: input.producedAt,
    expiresAt,
  });
  return { simulation, digest: simulationDigest(simulation) };
}

export interface SimulationBindingVerdict {
  /** True iff the simulation STILL binds — it is current and the observed tuple is unchanged. */
  readonly binds: boolean;
  /** True iff the simulation was invalidated by source (or any version) drift (NS-005). */
  readonly invalidatedByDrift: boolean;
  /** True iff the simulation was invalidated by expiry (a stale simulation cannot bind). */
  readonly invalidatedByExpiry: boolean;
  /** Which version members drifted (empty when none). */
  readonly driftedMembers: readonly string[];
  readonly reason: string;
}

/**
 * Decide whether a simulation still binds against the tuple OBSERVED at approval/execution time. This
 * is the authority gate NS-005 requires: a source change (or any pinned-version change) between
 * simulation and execution invalidates the predicted effect, so execution must be refused and the
 * operation re-simulated.
 */
export function checkSimulationBinding(
  simulation: Simulation,
  observed: BoundVersions,
  now: EpochMillis,
): SimulationBindingVerdict {
  const expired = !simulationIsCurrent(simulation, now);
  const drifted = !boundVersionsEqual(simulation.bound, observed);
  const invalidated = sourceDriftInvalidates(simulation, observed, now);

  const driftedMembers: string[] = [];
  if (simulation.bound.controllerVersionId !== observed.controllerVersionId)
    driftedMembers.push('controllerVersionId');
  if (simulation.bound.adapterVersionId !== observed.adapterVersionId)
    driftedMembers.push('adapterVersionId');
  if (simulation.bound.policyVersionId !== observed.policyVersionId)
    driftedMembers.push('policyVersionId');
  if (simulation.bound.sourceRevision !== observed.sourceRevision)
    driftedMembers.push('sourceRevision');

  let reason: string;
  if (!invalidated) reason = 'simulation_binds';
  else if (expired && !drifted) reason = 'simulation_expired';
  else reason = 'source_or_version_drift';

  return {
    binds: !invalidated,
    invalidatedByDrift: invalidated && drifted,
    invalidatedByExpiry: invalidated && expired,
    driftedMembers: Object.freeze(driftedMembers),
    reason,
  };
}
