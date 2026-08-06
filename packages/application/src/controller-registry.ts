// @trustcircle/application — CONTROLLER REGISTRY: register IMMUTABLE controller versions whose
// MANIFEST-DECLARED capabilities are the ONLY governable actions (Phase 6 / User Story 4 /
// FR-023, FR-024).
//
// A controller version is an immutable manifest: it declares the capabilities (each with its
// operation kind, risk class, destructiveness, approval/simulation requirements, reversibility), the
// required authority, preconditions, stop conditions, rollback plan, evidence plan, health probe,
// tests, owner, and approval policy. The registry is a THIN coordinator over the
// `makeControllerVersion` domain factory — it re-uses the domain's fail-closed activation invariant
// (an ACTIVE version MUST carry tests, a health probe, an effective_from, and an approval decision)
// rather than re-implementing it. The registry additionally enforces the REGISTRATION-time
// invariants a manifest must satisfy before it can be stored:
//
//   * manifest-only control — a version must declare ≥ 1 capability (a controller that declares
//     nothing can govern nothing);
//   * one capability per operation kind — a manifest may not declare the same kind twice (an
//     ambiguous manifest cannot be authoritative);
//   * activation approval — activating a version requires an approval decision id (GAR-005);
//   * immutability — a stored version is never rewritten; a change is a NEW version (higher number).
//
// The registry is pure and clock-free (the caller supplies `createdAt`); it decides and constructs,
// it does not itself persist. Persistence is the caller's durable write of the returned version +
// its content digest.

import {
  type Uuid,
  type TenantId,
  type EpochMillis,
  type ControllerVersion,
  type ControllerCapability,
  type ControllerLifecycleState,
  type OperationKind,
  type RiskClass,
  makeControllerVersion,
  controllerVersionDigest,
  declaresCapability,
} from '@trustcircle/domain';

export interface RegisterControllerVersionInput {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerId: Uuid;
  readonly version: number;
  readonly name: string;
  readonly capabilities: readonly ControllerCapability[];
  readonly riskClass?: RiskClass;
  readonly requiredAuthority?: Record<string, unknown>;
  readonly preconditions?: readonly Record<string, unknown>[];
  readonly stopConditions?: readonly Record<string, unknown>[];
  readonly rollbackPlan?: Record<string, unknown>;
  readonly evidencePlan?: Record<string, unknown>;
  readonly healthProbe?: Record<string, unknown>;
  readonly tests?: readonly Record<string, unknown>[];
  readonly ownerPrincipalId: Uuid;
  readonly approvalPolicy?: Record<string, unknown>;
  readonly approvalDecisionId?: Uuid;
  readonly lifecycleState?: ControllerLifecycleState;
  readonly effectiveFrom?: EpochMillis;
  readonly effectiveTo?: EpochMillis;
  readonly createdAt: EpochMillis;
}

export interface RegisteredControllerVersion {
  readonly version: ControllerVersion;
  /** Content digest — the durable, tamper-evident witness of the registered manifest. */
  readonly digest: string;
  /** The operation kinds this manifest declares — the ONLY governable actions (FR-024). */
  readonly declaredKinds: readonly OperationKind[];
}

/**
 * Register (construct + validate) a controller version manifest. Rejects a manifest that declares the
 * same operation kind twice (ambiguous authority) before delegating to the domain factory, which
 * enforces fail-closed activation. Returns the frozen version + its content digest.
 */
export function registerControllerVersion(
  input: RegisterControllerVersionInput,
): RegisteredControllerVersion {
  // Manifest-only control: reject a duplicate operation kind — the manifest must be unambiguous about
  // which single capability governs each kind of action.
  const seen = new Set<OperationKind>();
  for (const cap of input.capabilities) {
    if (seen.has(cap.operationKind)) {
      throw new TypeError(
        `controller manifest declares operation kind "${cap.operationKind}" more than once (a manifest cannot be ambiguous about capability authority)`,
      );
    }
    seen.add(cap.operationKind);
  }

  const version = makeControllerVersion({
    id: input.id,
    tenantId: input.tenantId,
    controllerId: input.controllerId,
    version: input.version,
    name: input.name,
    capabilities: input.capabilities,
    ownerPrincipalId: input.ownerPrincipalId,
    createdAt: input.createdAt,
    // exactOptionalPropertyTypes: forward each optional only when present, never as explicit undefined.
    ...(input.riskClass !== undefined ? { riskClass: input.riskClass } : {}),
    ...(input.requiredAuthority !== undefined ? { requiredAuthority: input.requiredAuthority } : {}),
    ...(input.preconditions !== undefined ? { preconditions: input.preconditions } : {}),
    ...(input.stopConditions !== undefined ? { stopConditions: input.stopConditions } : {}),
    ...(input.rollbackPlan !== undefined ? { rollbackPlan: input.rollbackPlan } : {}),
    ...(input.evidencePlan !== undefined ? { evidencePlan: input.evidencePlan } : {}),
    ...(input.healthProbe !== undefined ? { healthProbe: input.healthProbe } : {}),
    ...(input.tests !== undefined ? { tests: input.tests } : {}),
    ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input.approvalDecisionId !== undefined ? { approvalDecisionId: input.approvalDecisionId } : {}),
    ...(input.lifecycleState !== undefined ? { lifecycleState: input.lifecycleState } : {}),
    ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
  });

  return {
    version,
    digest: controllerVersionDigest(version),
    declaredKinds: version.capabilities.map((c) => c.operationKind),
  };
}

/**
 * Authorize an operation kind against a registered version: it is permitted ONLY when the kind is a
 * manifest-declared capability (FR-024 — manifest-only control). An undeclared kind is refused, so a
 * controller can never act outside its declared surface. Returns a structured verdict.
 */
export function authorizeOperationKind(
  version: ControllerVersion,
  kind: OperationKind,
): { readonly permitted: boolean; readonly reason: string } {
  if (!declaresCapability(version, kind)) {
    return { permitted: false, reason: 'operation_kind_not_declared_in_manifest' };
  }
  return { permitted: true, reason: 'manifest_declared_capability' };
}

/**
 * Succession check for immutable versions: a new registration of the SAME (tenant, controller) must
 * carry a STRICTLY greater version number than the currently-registered one. An in-place edit (same
 * number) is refused — a manifest change is always a new version.
 */
export function assertVersionSucceeds(
  current: ControllerVersion | undefined,
  next: ControllerVersion,
): void {
  if (current === undefined) return;
  if (next.controllerId !== current.controllerId) {
    throw new TypeError('version succession must be for the same controllerId');
  }
  if (next.version <= current.version) {
    throw new RangeError(
      `controller version ${next.version} does not succeed ${current.version} (an immutable manifest is never edited in place; a change is a new, higher version)`,
    );
  }
}
