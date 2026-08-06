// Test fixtures — a deterministic, multi-scenario CONTROLLER-OPERATIONS world for Phase 6 / User Story
// 4 (Operate Governance Controllers Safely). Seeds every controller/operation shape the controller
// routes, the accessible web surfaces (ControllerRegistry / OperationDetail / OperationActions), the
// projector, and the acceptance runners consume — plus the domain aggregates + application-service
// inputs the discovery / inspection / simulation / approval / execution / continuity / reconciliation /
// rollback flows govern.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FIXTURE EXISTS  (T179 — FR-023..029, FR-046..050, NS-005, NS-011, SC-010, SC-011)
// ───────────────────────────────────────────────────────────────────────────────────────────
// The e2e controller scenarios (uncertain-remote-outcome / bounded-continuity / controller-rollback)
// and the integration/resilience tests drive the REAL domain oracles + application services + adapter
// client over a KNOWN, FIXED world and assert genuine facts — never a mutation echo. This builder is
// that fixed world. Every seeded scenario maps to an acceptance obligation, and each carries an
// `observedVia` naming the exact durable read path an assertion pins, so no assertion is vacuous.
//
// The seeded controller scenarios:
//   1. HEALTHY-IDLE         — an active, healthy controller with observed==desired (no drift, no op).
//   2. DRIFTED              — desired ≠ observed state: the drift MUST be visible (FR-024), never masked.
//   3. UNCERTAIN-OUTCOME    — an operation whose dispatch timed out: latest attempt uncertain, awaiting
//                             reconciliation; NEVER shown as succeeded (FR-028 / SC-011).
//   4. CONTINUITY           — an approved+started operation running under a bounded (≤15min) continuity
//                             lease after health loss (FR-046..050).
//   5. ROLLBACK-CONFLICT    — a rollback refused because newer legitimate state landed (NS-011).
//   6. VERIFIED-SUCCESS     — an operation confirmed by DIRECT remote observation + reconciliation, the
//                             only scenario projected succeeded.
//
// DETERMINISM. No wall clock, no I/O, no randomness. The clock is the fixed `NOW`; ids come from
// readable slugs sha256'd into valid v7-shaped UUIDs, so the world is byte-identical every call.

import { createHash } from 'node:crypto';

import {
  makeControllerVersion,
  makeControllerInstance,
  makeSimulation,
  makeControllerOperation,
  makeOperationAttempt,
  makeControllerContinuityLease,
  toUuid,
  type Uuid,
  type TenantId,
  type EpochMillis,
  type ControllerCapability,
  type ControllerVersion,
  type ControllerInstance,
  type BoundVersions,
  type Simulation,
  type ControllerOperation,
  type OperationAttempt,
  type ControllerContinuityLease,
  type OperationState,
  type HealthState,
  type AttemptOutcome,
} from '@trustcircle/domain';

import type { AdapterManifest } from '@trustcircle/application';

import {
  ControllerProjector,
  type ControllerRegistryInput,
  type OperationProjectionInput,
  type ControllerRegistryRow,
  type OperationRow,
} from '@trustcircle/projections';

import type {
  ControllerRegistryModel,
  ControllerRegistryRowVM,
  ControllerFilterChipVM,
} from '../../apps/web/src/features/controllers/ControllerRegistry.tsx';
import type {
  OperationDetailModel,
  OperationAttemptVM,
} from '../../apps/web/src/features/controllers/OperationDetail.tsx';
import type {
  OperationActionsModel,
  OperationActionVM,
} from '../../apps/web/src/features/controllers/OperationActions.tsx';

// ── Fixed clock & identity ──────────────────────────────────────────────────────────────────────

/** The single fixed "now" — distinct from the other fixtures' NOW so a mixed run cannot alias. */
export const NOW: EpochMillis = 1_772_500_000_000 as EpochMillis;

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;

/** A deterministic, legible-in-source UUID derived from a readable slug (v7-shaped, valid). */
export function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`controllers-fixture:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

export function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

// ── Stable principals, tenant, versions ───────────────────────────────────────────────────────────

export const TENANT: TenantId = uuidFromSlug('tenant-home-controllers') as unknown as TenantId;

export const OPERATOR: Uuid = uuidFromSlug('principal-operator');
export const APPROVER: Uuid = uuidFromSlug('principal-approver');
export const OWNER: Uuid = uuidFromSlug('principal-controller-owner');

export const CONTROLLER_ID: Uuid = uuidFromSlug('controller-firewall');
export const CONTROLLER_VERSION_ID: Uuid = uuidFromSlug('controller-version-1');
export const ADAPTER_ID: Uuid = uuidFromSlug('adapter-firewall');
export const ADAPTER_VERSION_ID: Uuid = uuidFromSlug('adapter-version-1');
export const POLICY_VERSION_ID: Uuid = uuidFromSlug('policy-version-1');
export const CONTINUITY_POLICY_VERSION_ID: Uuid = uuidFromSlug('continuity-policy-version-1');
export const APPROVAL_DECISION_ID: Uuid = uuidFromSlug('decision-approve-execute');

export const SOURCE_REVISION = 'rev-1000';
export const NEWER_SOURCE_REVISION = 'rev-2000';

/** The version tuple every operation is authorized against (the desired tuple). */
export const AUTHORIZED_TUPLE: BoundVersions = Object.freeze({
  controllerVersionId: CONTROLLER_VERSION_ID,
  adapterVersionId: ADAPTER_VERSION_ID,
  policyVersionId: POLICY_VERSION_ID,
  sourceRevision: SOURCE_REVISION,
});

/** A DRIFTED observed tuple — the source moved after authorization (NS-005). */
export const DRIFTED_TUPLE: BoundVersions = Object.freeze({
  ...AUTHORIZED_TUPLE,
  sourceRevision: NEWER_SOURCE_REVISION,
});

// ── Controller version + capabilities ─────────────────────────────────────────────────────────────

export const CAPABILITIES: readonly ControllerCapability[] = Object.freeze([
  {
    name: 'discover',
    operationKind: 'discover',
    riskClass: 'low',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
  {
    name: 'inspect',
    operationKind: 'inspect',
    riskClass: 'low',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
  {
    name: 'simulate',
    operationKind: 'simulate',
    riskClass: 'low',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
  {
    name: 'execute',
    operationKind: 'execute',
    riskClass: 'high',
    destructive: true,
    requiresApproval: true,
    requiresSimulation: true,
    reversible: true,
  },
  {
    name: 'pause',
    operationKind: 'pause',
    riskClass: 'medium',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
  {
    name: 'resume',
    operationKind: 'resume',
    riskClass: 'medium',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
  {
    name: 'reconcile',
    operationKind: 'reconcile',
    riskClass: 'medium',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
  {
    name: 'rollback',
    operationKind: 'rollback',
    riskClass: 'high',
    destructive: true,
    requiresApproval: true,
    requiresSimulation: true,
    reversible: true,
  },
  {
    name: 'collect_evidence',
    operationKind: 'collect_evidence',
    riskClass: 'low',
    destructive: false,
    requiresApproval: false,
    requiresSimulation: false,
    reversible: true,
  },
]);

export function seedControllerVersion(): ControllerVersion {
  return makeControllerVersion({
    id: CONTROLLER_VERSION_ID,
    tenantId: TENANT,
    controllerId: CONTROLLER_ID,
    version: 1,
    name: 'Firewall Controller',
    capabilities: CAPABILITIES,
    riskClass: 'high',
    requiredAuthority: { role: 'operator', scope: 'firewall' },
    preconditions: [{ check: 'source_reachable' }],
    stopConditions: [{ on: 'unexpected_deny_all' }],
    rollbackPlan: { restore: 'preimage' },
    evidencePlan: { capture: ['plan', 'attempt', 'observation', 'verification'] },
    healthProbe: { path: '/healthz' },
    tests: [{ name: 'conformance', passed: true }],
    ownerPrincipalId: OWNER,
    approvalPolicy: { execute: 'requires_human_approval' },
    lifecycleState: 'active',
    effectiveFrom: (NOW - 30 * 24 * ONE_HOUR) as EpochMillis,
    createdAt: (NOW - 30 * 24 * ONE_HOUR) as EpochMillis,
  });
}

// ── The signed adapter manifest (activation input) ────────────────────────────────────────────────

const MANIFEST_CONTENT_DIGEST = createHash('sha256')
  .update('controllers-fixture:adapter-manifest')
  .digest('hex');

/** A well-formed, signed adapter manifest that activates against the controller version. */
export function seedAdapterManifest(overrides: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    adapterId: ADAPTER_ID,
    adapterVersionId: ADAPTER_VERSION_ID,
    name: 'Firewall Adapter',
    protocolMin: 1,
    protocolMax: 1,
    advertisedCapabilities: [
      'discover',
      'inspect',
      'simulate',
      'execute',
      'pause',
      'resume',
      'reconcile',
      'rollback',
      'collect_evidence',
    ],
    contentDigest: MANIFEST_CONTENT_DIGEST,
    signature: `sig:${MANIFEST_CONTENT_DIGEST}`,
    conformanceEvidenceId: uuidFromSlug('conformance-evidence-1'),
    conformancePassed: true,
    declaresHealthProbe: true,
    declaresFailureSemantics: true,
    requiresApprovalDecisionId: APPROVAL_DECISION_ID,
    ...overrides,
  };
}

/** A signature verifier matching the fixture's `sig:<digest>` convention (injected — no crypto policy). */
export function fixtureVerifySignature(contentDigest: string, signature: string): boolean {
  return signature === `sig:${contentDigest}`;
}

// ── Instances (one per scenario state) ────────────────────────────────────────────────────────────

function instance(
  slug: string,
  overrides: {
    health?: HealthState;
    desiredState?: Record<string, unknown>;
    observedState?: Record<string, unknown>;
    sourceRevision?: string;
    activeOperationId?: Uuid;
    dependencies?: readonly Record<string, unknown>[];
  } = {},
): ControllerInstance {
  const desired = overrides.desiredState ?? { ruleset: 'baseline', deny_all: false };
  return makeControllerInstance({
    id: uuidFromSlug(`instance-${slug}`),
    tenantId: TENANT,
    controllerId: CONTROLLER_ID,
    controllerVersionId: CONTROLLER_VERSION_ID,
    adapterId: ADAPTER_ID,
    adapterVersionId: ADAPTER_VERSION_ID,
    ownerPrincipalId: OWNER,
    enabledScope: { zone: 'edge' },
    desiredState: desired,
    observedState: overrides.observedState ?? desired,
    health: overrides.health ?? 'healthy',
    sourceRevision: overrides.sourceRevision ?? SOURCE_REVISION,
    dependencies: overrides.dependencies ?? [{ name: 'policy-store', healthy: true }],
    ...(overrides.activeOperationId !== undefined
      ? { activeOperationId: overrides.activeOperationId }
      : {}),
    lastObservationAt: (NOW - 2 * ONE_MINUTE) as EpochMillis,
    state: 'observed',
    version: 1,
    updatedAt: (NOW - ONE_MINUTE) as EpochMillis,
  });
}

// ── Simulation (version-pinned, current) ──────────────────────────────────────────────────────────

export function seedSimulation(
  slug: string,
  opts: { producedAt?: EpochMillis; expiresAt?: EpochMillis; bound?: BoundVersions } = {},
): Simulation {
  const producedAt = opts.producedAt ?? ((NOW - 5 * ONE_MINUTE) as EpochMillis);
  return makeSimulation({
    id: uuidFromSlug(`simulation-${slug}`),
    tenantId: TENANT,
    controllerInstanceId: uuidFromSlug(`instance-${slug}`),
    operationKind: 'execute',
    bound: opts.bound ?? AUTHORIZED_TUPLE,
    predictedScope: { rules_changed: 1 },
    predictedImpact: { blast_radius: 'single_zone' },
    preconditions: [{ check: 'source_reachable', satisfied: true }],
    conflicts: [],
    evidencePlan: { capture: ['before', 'after'] },
    stopConditions: [{ on: 'deny_all' }],
    rollbackPlan: { restore: 'preimage' },
    riskClass: 'high',
    status: 'fresh',
    producedAt,
    expiresAt: opts.expiresAt ?? ((producedAt + 10 * ONE_MINUTE) as EpochMillis),
  });
}

// ── Operations (one per scenario) ─────────────────────────────────────────────────────────────────

function operation(
  slug: string,
  overrides: {
    state?: OperationState;
    operationKind?: import('@trustcircle/domain').OperationKind;
    observedVersions?: BoundVersions;
    simulationId?: Uuid;
    approvalDecisionId?: Uuid;
    continuityLeaseId?: Uuid;
  } = {},
): ControllerOperation {
  const kind = overrides.operationKind ?? 'execute';
  return makeControllerOperation({
    id: uuidFromSlug(`operation-${slug}`),
    tenantId: TENANT,
    controllerInstanceId: uuidFromSlug(`instance-${slug}`),
    operationKind: kind,
    requestedByPrincipalId: OPERATOR,
    ownerPrincipalId: OWNER,
    idempotencyKey: `idem-${slug}-0001`,
    riskClass: 'high',
    desiredVersions: AUTHORIZED_TUPLE,
    observedVersions: overrides.observedVersions ?? AUTHORIZED_TUPLE,
    ...(overrides.simulationId !== undefined ? { simulationId: overrides.simulationId } : {}),
    ...(overrides.approvalDecisionId !== undefined
      ? { approvalDecisionId: overrides.approvalDecisionId }
      : {}),
    ...(overrides.continuityLeaseId !== undefined
      ? { continuityLeaseId: overrides.continuityLeaseId }
      : {}),
    steps: [{ id: 'step-1', apply: 'ruleset' }],
    bounds: { max_rules: 10 },
    evidencePlan: { capture: ['plan', 'attempt', 'observation'] },
    state: overrides.state ?? 'requested',
    version: 1,
    requestedAt: (NOW - 8 * ONE_MINUTE) as EpochMillis,
    updatedAt: (NOW - ONE_MINUTE) as EpochMillis,
  });
}

// ── Attempts (outcomes per scenario) ──────────────────────────────────────────────────────────────

function attempt(
  slug: string,
  outcome: AttemptOutcome,
  opts: { remoteEffectObserved?: boolean; acknowledged?: boolean; attemptNumber?: number } = {},
): OperationAttempt {
  return makeOperationAttempt({
    id: uuidFromSlug(`attempt-${slug}-${opts.attemptNumber ?? 1}`),
    tenantId: TENANT,
    operationId: uuidFromSlug(`operation-${slug}`),
    stepId: 'step-1',
    attemptNumber: opts.attemptNumber ?? 1,
    dispatchIdempotencyKey: `idem-${slug}-0001`,
    boundAdapterVersionId: ADAPTER_VERSION_ID,
    acknowledged:
      opts.acknowledged ?? (outcome === 'confirmed' || outcome === 'dispatched_unconfirmed'),
    remoteEffectObserved: opts.remoteEffectObserved ?? outcome === 'confirmed',
    response: { echoed: true },
    checkpoint: { preimage: 'captured' },
    bufferedForContinuity: false,
    outcome,
    startedAt: (NOW - 6 * ONE_MINUTE) as EpochMillis,
    completedAt: (NOW - 5 * ONE_MINUTE) as EpochMillis,
  });
}

// ── Continuity lease (bounded, ≤15min, in-progress-only) ──────────────────────────────────────────

export function seedContinuityLease(
  slug: string,
  opts: {
    grantedAt?: EpochMillis;
    durationMs?: number;
    state?: import('@trustcircle/domain').ControllerContinuityLeaseState;
  } = {},
): ControllerContinuityLease {
  const grantedAt = opts.grantedAt ?? ((NOW - 3 * ONE_MINUTE) as EpochMillis);
  const durationMs = opts.durationMs ?? 10 * ONE_MINUTE;
  return makeControllerContinuityLease({
    id: uuidFromSlug(`lease-${slug}`),
    tenantId: TENANT,
    operationId: uuidFromSlug(`operation-${slug}`),
    continuityPolicyVersionId: CONTINUITY_POLICY_VERSION_ID,
    policySnapshot: { max_actions: 3, no_new_scope: true },
    eligibleOperationClasses: ['execute', 'pause', 'reconcile'],
    actionLimit: 3,
    resourceLimits: { rate_per_min: 2 },
    requiredLocalObservations: ['local_health_ok'],
    stopConditions: [{ on: 'deny_all' }],
    ownerPrincipalId: OWNER,
    operationStartedBeforeFailure: true,
    grantedAt,
    expiresAt: (grantedAt + durationMs) as EpochMillis,
    ...(opts.state !== undefined ? { state: opts.state } : {}),
  });
}

// ── The seeded scenario catalogue ─────────────────────────────────────────────────────────────────

export type ControllerScenarioName =
  | 'healthy_idle'
  | 'drifted'
  | 'uncertain_outcome'
  | 'continuity'
  | 'rollback_conflict'
  | 'verified_success';

export interface ControllerScenarioSpec {
  readonly scenario: ControllerScenarioName;
  readonly title: string;
  readonly observedVia: string;
  readonly instance: ControllerInstance;
  readonly operation: ControllerOperation | null;
  readonly attempts: readonly OperationAttempt[];
  readonly simulation: Simulation | null;
  readonly lease: ControllerContinuityLease | null;
}

export function seedControllers(): readonly ControllerScenarioSpec[] {
  const healthyIdle: ControllerScenarioSpec = {
    scenario: 'healthy_idle',
    title: 'Healthy controller with observed == desired (no drift, no active operation)',
    observedVia: 'controller_instance.health=healthy + instanceHasDrift()=false',
    instance: instance('healthy_idle'),
    operation: null,
    attempts: [],
    simulation: null,
    lease: null,
  };

  const drifted: ControllerScenarioSpec = {
    scenario: 'drifted',
    title: 'Controller with desired ≠ observed state — the drift must be visible',
    observedVia: 'instanceHasDrift()=true (desiredState.deny_all ≠ observedState.deny_all)',
    instance: instance('drifted', {
      health: 'degraded',
      desiredState: { ruleset: 'baseline', deny_all: false },
      observedState: { ruleset: 'baseline', deny_all: true },
      dependencies: [{ name: 'policy-store', healthy: false }],
    }),
    operation: null,
    attempts: [],
    simulation: null,
    lease: null,
  };

  const uncertainOutcome: ControllerScenarioSpec = {
    scenario: 'uncertain_outcome',
    title: 'Operation whose dispatch timed out — uncertain, awaiting reconciliation, NOT succeeded',
    observedVia:
      'operation_attempt.outcome=timed_out via attemptIsUncertain()=true; no confirming observation',
    instance: instance('uncertain_outcome', {
      activeOperationId: uuidFromSlug('operation-uncertain_outcome'),
    }),
    operation: operation('uncertain_outcome', {
      state: 'reconciling',
      simulationId: uuidFromSlug('simulation-uncertain_outcome'),
      approvalDecisionId: APPROVAL_DECISION_ID,
    }),
    attempts: [
      attempt('uncertain_outcome', 'timed_out', {
        acknowledged: false,
        remoteEffectObserved: false,
      }),
    ],
    simulation: seedSimulation('uncertain_outcome'),
    lease: null,
  };

  const continuity: ControllerScenarioSpec = {
    scenario: 'continuity',
    title:
      'Approved+started operation running under a bounded (≤15min) continuity lease after health loss',
    observedVia: 'continuity_lease.expiresAt (≤ grantedAt+15min) + operation.state=continuity',
    instance: instance('continuity', {
      health: 'unavailable',
      activeOperationId: uuidFromSlug('operation-continuity'),
    }),
    operation: operation('continuity', {
      state: 'continuity',
      simulationId: uuidFromSlug('simulation-continuity'),
      approvalDecisionId: APPROVAL_DECISION_ID,
      continuityLeaseId: uuidFromSlug('lease-continuity'),
    }),
    attempts: [attempt('continuity', 'confirmed', { remoteEffectObserved: true })],
    simulation: seedSimulation('continuity'),
    lease: seedContinuityLease('continuity'),
  };

  const rollbackConflict: ControllerScenarioSpec = {
    scenario: 'rollback_conflict',
    title:
      'Rollback refused because newer legitimate state landed on the source (protect newer state)',
    observedVia:
      'operation.observedVersions.sourceRevision != producedRevision → decideControllerRollback()=conflict',
    instance: instance('rollback_conflict', {
      sourceRevision: NEWER_SOURCE_REVISION,
      observedState: { ruleset: 'baseline-v2', deny_all: false },
    }),
    operation: operation('rollback_conflict', {
      state: 'rolled_back',
      operationKind: 'execute',
      observedVersions: DRIFTED_TUPLE,
      simulationId: uuidFromSlug('simulation-rollback_conflict'),
      approvalDecisionId: APPROVAL_DECISION_ID,
    }),
    attempts: [attempt('rollback_conflict', 'confirmed', { remoteEffectObserved: true })],
    simulation: seedSimulation('rollback_conflict'),
    lease: null,
  };

  const verifiedSuccess: ControllerScenarioSpec = {
    scenario: 'verified_success',
    title: 'Operation confirmed by DIRECT remote observation + reconciliation — the only success',
    observedVia:
      'operation_attempt.outcome=confirmed with remoteEffectObserved=true; reconciliation established',
    instance: instance('verified_success'),
    operation: operation('verified_success', {
      state: 'succeeded',
      simulationId: uuidFromSlug('simulation-verified_success'),
      approvalDecisionId: APPROVAL_DECISION_ID,
    }),
    attempts: [attempt('verified_success', 'confirmed', { remoteEffectObserved: true })],
    simulation: seedSimulation('verified_success'),
    lease: null,
  };

  return [healthyIdle, drifted, uncertainOutcome, continuity, rollbackConflict, verifiedSuccess];
}

// ── Projector inputs (byte-identical read-model fold inputs) ──────────────────────────────────────

/** Build the ControllerProjector registry input for a seeded scenario's instance. */
export function controllerProjectionInputFor(
  spec: ControllerScenarioSpec,
): ControllerRegistryInput {
  const i = spec.instance;
  return {
    instanceId: i.id,
    tenantId: i.tenantId as unknown as Uuid,
    controllerId: i.controllerId,
    controllerVersionId: i.controllerVersionId,
    controllerVersion: 1,
    name: 'Firewall Controller',
    ownerPrincipalId: i.ownerPrincipalId,
    adapterVersionId: i.adapterVersionId,
    health: i.health,
    desiredState: i.desiredState,
    observedState: i.observedState,
    sourceRevision: i.sourceRevision,
    dependencies: i.dependencies,
    activeOperationId: i.activeOperationId ?? null,
    lastObservationAt: i.lastObservationAt,
    updatedAt: i.updatedAt,
  };
}

/** Build the ControllerProjector operation input for a seeded scenario's operation (null if none). */
export function operationProjectionInputFor(
  spec: ControllerScenarioSpec,
): OperationProjectionInput | null {
  const op = spec.operation;
  if (op === null) return null;
  const latest = spec.attempts.length > 0 ? spec.attempts[spec.attempts.length - 1]! : null;
  const reconciliationEstablished = spec.scenario === 'verified_success';
  return {
    operationId: op.id,
    tenantId: op.tenantId as unknown as Uuid,
    controllerInstanceId: op.controllerInstanceId,
    operationKind: op.operationKind,
    state: op.state,
    ownerPrincipalId: op.ownerPrincipalId,
    requestedByPrincipalId: op.requestedByPrincipalId,
    authorizedRevisionDrift:
      op.desiredVersions.sourceRevision !== op.observedVersions.sourceRevision,
    simulationId: op.simulationId ?? null,
    approvalDecisionId: op.approvalDecisionId ?? null,
    continuityLeaseId: op.continuityLeaseId ?? null,
    continuityLeaseExpiresAt: spec.lease?.expiresAt ?? null,
    totalSteps: 1,
    completedSteps: op.state === 'succeeded' ? 1 : 0,
    attemptCount: spec.attempts.length,
    latestAttemptOutcome: latest?.outcome ?? null,
    reconciliationEstablished,
    reconciliationRunId: reconciliationEstablished
      ? uuidFromSlug(`reconciliation-${spec.scenario}`)
      : null,
    rollbackResult: spec.scenario === 'rollback_conflict' ? 'conflict' : null,
    evidenceBundleId: uuidFromSlug(`evidence-${spec.scenario}`),
    failureDetail: null,
    requestedAt: op.requestedAt,
    updatedAt: op.updatedAt,
  };
}

// ── Projected read-model rows (drive the REAL ControllerProjector) ─────────────────────────────────
//
// The web-VM builders below are NOT allowed to re-derive drift / attention / permitted-actions /
// awaiting-reconciliation — those verdicts are the projector's job (FR-024, FR-028). So we fold the
// seeded world through the REAL `ControllerProjector` and map its rows into the presenter VMs verbatim.

/** Fold every seeded scenario through the real projector; return its controller + operation rows. */
export function projectControllers(at: EpochMillis = NOW): {
  readonly controllerRows: readonly ControllerRegistryRow[];
  readonly operationRows: readonly OperationRow[];
  readonly snapshotDigest: string;
} {
  const specs = seedControllers();
  const projector = new ControllerProjector({ tenantId: TENANT as unknown as Uuid });
  for (const spec of specs) {
    projector.ingestController(controllerProjectionInputFor(spec));
    const opInput = operationProjectionInputFor(spec);
    if (opInput !== null) projector.ingestOperation(opInput);
  }
  return {
    controllerRows: projector.controllers(at),
    operationRows: projector.operations(at),
    snapshotDigest: projector.snapshotDigest(at),
  };
}

/** Map one projected controller row into the registry-presenter row VM (verbatim — no re-derivation). */
export function controllerRowVMOf(
  row: ControllerRegistryRow,
  operationRows: readonly OperationRow[],
): ControllerRegistryRowVM {
  const active = operationRows.find((o) => o.controllerInstanceId === row.instanceId) ?? null;
  const nextPermittedActions = active !== null ? active.nextPermittedActions.map(String) : [];
  const searchIndex = [
    row.name,
    row.instanceId,
    row.ownerPrincipalId,
    row.health,
    row.sourceRevision,
    row.drift ? 'drift' : 'no-drift',
  ]
    .join(' ')
    .toLowerCase();
  return {
    instanceId: String(row.instanceId),
    controllerId: String(row.controllerId),
    name: row.name,
    controllerVersion: row.controllerVersion,
    controllerVersionId: String(row.controllerVersionId),
    adapterVersionId: String(row.adapterVersionId),
    ownerPrincipalId: String(row.ownerPrincipalId),
    sourceRevision: row.sourceRevision,
    health: row.health,
    desiredState: row.desiredState,
    observedState: row.observedState,
    drift: row.drift,
    dependencyDegraded: row.dependencyDegraded,
    needsAttention: row.needsAttention,
    activeOperationId: row.activeOperationId !== null ? String(row.activeOperationId) : '',
    nextPermittedActions,
    priority: row.priority,
    searchIndex,
    matches: true,
    filteredOutReason: '',
  };
}

/** Build the full ControllerRegistry model from the seeded world (all rows visible, honest metadata). */
export function seedControllerRegistryModel(at: EpochMillis = NOW): ControllerRegistryModel {
  const { controllerRows, operationRows, snapshotDigest } = projectControllers(at);
  const rows = controllerRows.map((r) => controllerRowVMOf(r, operationRows));
  const attention = rows.filter((r) => r.needsAttention).length;
  const drifted = rows.filter((r) => r.drift).length;
  const filters: readonly ControllerFilterChipVM[] = [
    { facet: 'health', value: 'healthy', label: 'Healthy', active: false },
    { facet: 'drift', value: 'drifted', label: 'Drifted', active: false },
    { facet: 'attention', value: 'attention', label: 'Needs attention', active: false },
    { facet: 'continuity', value: 'continuity', label: 'In continuity', active: false },
  ];
  return {
    rows,
    filters,
    query: {
      text: '',
      activeFilters: [],
      visible: rows.length,
      total: rows.length,
      attentionVisible: attention,
      driftedVisible: drifted,
      resultSummary: `${rows.length} controller(s); ${attention} need attention, ${drifted} drifted.`,
    },
    metadata: {
      generatedAtIso: iso(at),
      freshness: 'current',
      partialCoverage: false,
      snapshotDigest,
      safeNextAction: '',
    },
  };
}

function attemptVMsOf(spec: ControllerScenarioSpec): readonly OperationAttemptVM[] {
  const uncertain = new Set(['dispatched_unconfirmed', 'uncertain', 'timed_out']);
  return spec.attempts.map((a, idx) => ({
    attemptId: String(a.id),
    ordinal: idx + 1,
    outcome: a.outcome,
    uncertain: uncertain.has(a.outcome),
    detail: a.remoteEffectObserved
      ? 'remote effect directly observed'
      : a.acknowledged
        ? 'acknowledged only — remote effect NOT observed'
        : 'no acknowledgement received',
  }));
}

/** Build a full OperationDetail model for a scenario, using the projected operation row's verdicts. */
export function seedOperationDetailModel(
  scenario: ControllerScenarioName,
  at: EpochMillis = NOW,
): OperationDetailModel {
  const spec = seedControllers().find((s) => s.scenario === scenario)!;
  if (spec.operation === null) {
    throw new TypeError(`scenario ${scenario} has no operation to detail`);
  }
  const { operationRows, snapshotDigest } = projectControllers(at);
  const row = operationRows.find((o) => o.operationId === spec.operation!.id)!;
  const op = spec.operation;
  const effectConfirmed =
    row.state === 'succeeded' && !row.latestOutcomeUncertain && !row.awaitingReconciliation;
  const duplicateEffect = false;
  const tupleStr = (t: BoundVersions): string =>
    `ctrl=${t.controllerVersionId} adapter=${t.adapterVersionId} policy=${t.policyVersionId} src=${t.sourceRevision}`;
  return {
    operationId: String(row.operationId),
    controllerInstanceId: String(row.controllerInstanceId),
    operationKind: row.operationKind,
    state: row.state,
    ownerPrincipalId: String(row.ownerPrincipalId),
    requestedByPrincipalId: String(row.requestedByPrincipalId),
    desiredVersionTuple: tupleStr(op.desiredVersions),
    observedVersionTuple: tupleStr(op.observedVersions ?? op.desiredVersions),
    authorizedRevisionDrift: row.authorizedRevisionDrift,
    simulation:
      spec.simulation !== null
        ? {
            simulationId: String(spec.simulation.id),
            binds: true,
            invalidatedByDrift: false,
            invalidatedByExpiry: false,
            driftedMembers: [],
            reason: 'simulation_binds',
          }
        : null,
    approvalDecisionId: row.approvalDecisionId !== null ? String(row.approvalDecisionId) : '',
    totalSteps: row.totalSteps,
    completedSteps: row.completedSteps,
    progress: row.progress,
    attempts: attemptVMsOf(spec),
    latestAttemptOutcome: row.latestAttemptOutcome ?? '',
    latestOutcomeUncertain: row.latestOutcomeUncertain,
    effectConfirmed,
    awaitingReconciliation: row.awaitingReconciliation,
    reconciliation:
      row.reconciliationRunId !== null || row.latestOutcomeUncertain
        ? {
            runId: row.reconciliationRunId !== null ? String(row.reconciliationRunId) : '',
            result:
              row.state === 'succeeded'
                ? 'reconciled_effect_present'
                : row.awaitingReconciliation
                  ? 'still_uncertain'
                  : 'none',
            usedRemoteObservation: row.state === 'succeeded',
            observedEffectCount: row.state === 'succeeded' ? 1 : 0,
            duplicateEffect,
            establishedState: row.state === 'succeeded',
            reason: row.awaitingReconciliation
              ? 'remote_unobservable'
              : row.state === 'succeeded'
                ? 'effect_present'
                : 'no_reconciliation',
          }
        : null,
    continuityLease:
      spec.lease !== null
        ? {
            leaseId: String(spec.lease.id),
            active: row.continuityLeaseActive,
            expiresAtIso: iso(spec.lease.expiresAt),
            remainingMs: Math.max(0, (spec.lease.expiresAt as number) - (at as number)),
            mustReconcileOnReturn: true,
          }
        : null,
    rollback:
      scenario === 'rollback_conflict'
        ? {
            result: 'rollback_refused_newer_state',
            reason:
              'the remote holds a different, newer legitimate state; rollback refused to protect it (NS-011)',
          }
        : { result: 'none', reason: '' },
    evidenceBundleId: row.evidenceBundleId !== null ? String(row.evidenceBundleId) : '',
    failed: row.failed,
    failureDetail: row.failureDetail ?? '',
    terminal: row.terminal,
    nextPermittedActions: row.nextPermittedActions.map(String),
    generatedAtIso: iso(at),
    snapshotDigest,
  };
}

/** Build the action-controls model for a scenario, gating each kind exactly by the projector row. */
export function seedOperationActionsModel(
  scenario: ControllerScenarioName,
  at: EpochMillis = NOW,
): OperationActionsModel {
  const spec = seedControllers().find((s) => s.scenario === scenario)!;
  if (spec.operation === null) {
    throw new TypeError(`scenario ${scenario} has no operation`);
  }
  const { operationRows, snapshotDigest } = projectControllers(at);
  const row = operationRows.find((o) => o.operationId === spec.operation!.id)!;
  const permitted = new Set(row.nextPermittedActions.map(String));
  const simulationSatisfied = spec.simulation !== null;
  const approvalSatisfied = row.approvalDecisionId !== null;

  const stateChangingKinds = new Set([
    'execute',
    'pause',
    'resume',
    'reconcile',
    'rollback',
    'emergency_stop',
  ]);
  const destructiveKinds = new Set(['execute', 'rollback', 'emergency_stop']);
  const allKinds = [
    'inspect',
    'simulate',
    'execute',
    'pause',
    'resume',
    'reconcile',
    'rollback',
    'collect_evidence',
    'emergency_stop',
  ];

  const actions: readonly OperationActionVM[] = allKinds.map((kind) => {
    const stateChanging = stateChangingKinds.has(kind);
    const permittedByState = permitted.has(kind);
    const enabled =
      !row.terminal &&
      permittedByState &&
      (!stateChanging || (simulationSatisfied && approvalSatisfied));
    let disabledReason = '';
    if (!enabled) {
      if (row.terminal) disabledReason = 'the operation is terminal; no action may be requested';
      else if (!permittedByState)
        disabledReason = `not permitted from the current state (${kind} is not in the allowed next actions)`;
      else if (stateChanging && !simulationSatisfied)
        disabledReason = 'a state-changing action requires a still-binding simulation (FR-025)';
      else if (stateChanging && !approvalSatisfied)
        disabledReason = 'a state-changing action requires an approval decision (GAR-005)';
    }
    return {
      kind,
      label: kind.replace(/_/g, ' '),
      stateChanging,
      destructive: destructiveKinds.has(kind),
      permittedByState,
      simulationSatisfied,
      approvalSatisfied,
      enabled,
      disabledReason,
    };
  });

  return {
    operationId: String(row.operationId),
    controllerId: String(row.controllerInstanceId),
    state: row.state,
    permittedActions: row.nextPermittedActions.map(String),
    actions,
    terminal: row.terminal,
    idempotencyKey: spec.operation.idempotencyKey,
    generatedAtIso: iso(at),
    snapshotDigest,
  };
}
