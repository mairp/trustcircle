// @trustcircle/domain — component profiles: owner-approved architecture roles and runtime
// availability classes (Phase 52 / VO-713cc2a06e03c63484b4).
//
// Oracle (NFR-010, VO-713cc2a06e03c63484b4):
//   Loss of required authority, policy, evidence, ownership, or reconciliation MUST block
//   affected execution immediately. Health or connectivity loss MUST block new execution
//   immediately; an in-progress operation may continue only under FR-046 through FR-050 while
//   read-only visibility and escalation remain available.
//
// This module makes that oracle *enforceable at the value level*. A governed component (a
// controller, connector, worker, projector, discovery agent, …) has:
//
//   1. An OWNER-APPROVED ARCHITECTURE ROLE  — the SEPARATE, deployment-time, owner-signed
//      classification of what the component *is* in the system (its `role`, declared
//      `dependencies` on other components, the `authority` it is granted, its `activation`
//      conditions, and an owner-approval record with `approvedBy`, `effectiveFrom`, and a
//      mandatory `reviewDate`). This is stable design intent, changed only by owner approval.
//
//   2. A RUNTIME AVAILABILITY CLASS         — the SEPARATE, live, observed classification of
//      what the component is *doing right now*: its availability class (`core` /
//      `optional` / `on-demand`), its live `state`, whether its declared dependencies and
//      required governance prerequisites currently hold, and the last-known evidence of that.
//
// Keeping the two SEPARATE (per the phase objective) is the point: design authority is not the
// same fact as runtime availability, and neither may be silently inferred from the other. The
// architecture role is what the OWNER approved; the availability class/state is what the
// PLATFORM observed. `evaluateExecutionGate` combines them into the single NFR-010 decision.
//
// The gate is FAIL-CLOSED and deterministic:
//   - GOVERNANCE PREREQUISITES (authority, policy, evidence, ownership, reconciliation): if ANY
//     is not currently satisfied, ALL affected execution is blocked IMMEDIATELY — new and
//     in-progress alike — because these are hard authorization/integrity requirements, not
//     health signals. Continuity mode CANNOT rescue a lost governance prerequisite.
//   - HEALTH / CONNECTIVITY: if lost, NEW execution is blocked immediately. An IN-PROGRESS
//     operation may continue ONLY when a valid FR-046–FR-050 continuity lease covers the current
//     step (unexpired, within its policy, step locally verifiable); otherwise it pauses at a
//     safe checkpoint and requires reconciliation. In every degraded case, READ-ONLY VISIBILITY
//     and ESCALATION remain available.
//
// Dependency-free (Node built-in `crypto` only) so it is independently observable under
// `npm ci` with no adjacent infrastructure, and runs under Node 22 `--experimental-strip-types`.

import { createHash } from 'node:crypto';
import {
  type EpochMillis,
  type GovernanceContract,
  type GovernedEntity,
  type Owner,
  type Reason,
  type TenantId,
  type Uuid,
  assertGovernanceContract,
  assertGovernedEntity,
  isConsequentialReason,
  isUuid,
} from './primitives.ts';

// ===========================================================================
// 1. Owner-approved architecture roles (design intent)
// ===========================================================================

/**
 * The closed set of owner-approved architecture roles a governed component may hold. These are
 * the platform's deployment building blocks (plan.md / control-plane compose profile). The role
 * is stable design intent — it is set by owner approval, not by runtime observation.
 */
export const ARCHITECTURE_ROLES = [
  'control-plane', // API / decision surface
  'controller', // executes governed operations against a target
  'connector', // read/observe an external source
  'worker', // background command / repair / expiry worker
  'projector', // builds read-model projections
  'discovery', // machine-wide source discovery
  'evidence-store', // durable evidence / audit ledger custody
  'policy-engine', // PDP / OPA authority evaluation
  'web', // operator-facing UI
  'observability', // telemetry (never authoritative)
] as const;
export type ArchitectureRole = (typeof ARCHITECTURE_ROLES)[number];

export function isArchitectureRole(s: unknown): s is ArchitectureRole {
  return typeof s === 'string' && (ARCHITECTURE_ROLES as readonly string[]).includes(s);
}

/**
 * A component's declared dependency on another component. `componentId` identifies the depended
 * component; `required` marks it as a hard prerequisite (its loss blocks execution) versus a
 * soft/optional dependency (its loss degrades but does not block).
 */
export interface ComponentDependency {
  readonly componentId: Uuid;
  readonly role: ArchitectureRole;
  readonly required: boolean;
}

/**
 * The consequential actions / authority a component is granted by owner approval. `mayExecute`
 * gates whether it can perform governed mutations at all; `consequentialActions` enumerates the
 * specific action classes it is permitted (empty ⇒ read-only). `crossTenant` marks authority
 * that reaches beyond a single tenant boundary (must be governed by FR-043–FR-045 centrally).
 */
export interface ComponentAuthority {
  readonly mayExecute: boolean;
  readonly consequentialActions: readonly string[];
  readonly crossTenant: boolean;
}

/**
 * Activation conditions: the design-time prerequisites that must hold before the component is
 * allowed to activate. `requires` names the governance prerequisites (see PREREQUISITES) that
 * must be satisfied; `manualApprovalRequired` marks components that never self-activate.
 */
export interface ActivationConditions {
  readonly requires: readonly Prerequisite[];
  readonly manualApprovalRequired: boolean;
}

/**
 * The owner-approval record that makes the architecture role stable design intent rather than a
 * claim: a named approver, a structured reason, when the approval takes effect, and a MANDATORY
 * review date (the role must be re-reviewed by then). Modeled after FR-039's mandatory
 * reason/scope/review-date requirement for owner decisions.
 */
export interface OwnerApproval {
  readonly approvedBy: Owner;
  readonly reason: Reason;
  readonly effectiveFrom: EpochMillis;
  readonly reviewDate: EpochMillis;
}

/**
 * The owner-approved architecture role of a governed component: a governed CONTROLLER entity
 * (it carries the nine GAR-005 facets via {@link GovernedEntity}) PLUS the role, declared
 * dependencies, granted authority, activation conditions, and owner approval. This is the design
 * fact — SEPARATE from the runtime availability profile below.
 */
export interface ArchitectureRoleProfile extends GovernedEntity {
  readonly kind: 'controller';
  readonly role: ArchitectureRole;
  readonly dependencies: readonly ComponentDependency[];
  readonly authority: ComponentAuthority;
  readonly activation: ActivationConditions;
  readonly approval: OwnerApproval;
}

// ===========================================================================
// 2. Runtime availability classes (live observation)
// ===========================================================================

/**
 * Runtime availability class — how essential the component is to the running platform:
 *   - `core`      — minimum platform must run; its loss blocks the governed feature it backs.
 *   - `optional`  — enhances governance; its loss degrades a feature but core keeps running.
 *   - `on-demand` — activated only for a specific request (e.g. an export or discovery run).
 * This is the availability facet consumed by the readiness service and the AvailabilityProfiles
 * UI (later phases). It is SEPARATE from the architecture role.
 */
export const AVAILABILITY_CLASSES = ['core', 'optional', 'on-demand'] as const;
export type AvailabilityClass = (typeof AVAILABILITY_CLASSES)[number];

export function isAvailabilityClass(s: unknown): s is AvailabilityClass {
  return typeof s === 'string' && (AVAILABILITY_CLASSES as readonly string[]).includes(s);
}

/**
 * The live runtime state of a component. Distinct from the entity's design LIFECYCLE state.
 *   - `inactive`  — approved but not yet activated (or intentionally deactivated).
 *   - `activating`— activation in progress; not yet serving.
 *   - `available` — healthy, connected, all required dependencies/prerequisites hold.
 *   - `degraded`  — reachable but a required signal is impaired; safe-visibility only.
 *   - `unavailable` — health or connectivity lost; new execution blocked.
 *   - `paused`    — stopped at a safe checkpoint; requires reconciliation before resuming.
 */
export const RUNTIME_STATES = [
  'inactive',
  'activating',
  'available',
  'degraded',
  'unavailable',
  'paused',
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export function isRuntimeState(s: unknown): s is RuntimeState {
  return typeof s === 'string' && (RUNTIME_STATES as readonly string[]).includes(s);
}

/**
 * The governance prerequisites whose loss blocks affected execution IMMEDIATELY (NFR-010, first
 * sentence). These are hard authorization/integrity facts — NOT health signals — so continuity
 * mode can never rescue them.
 */
export const PREREQUISITES = [
  'authority',
  'policy',
  'evidence',
  'ownership',
  'reconciliation',
] as const;
export type Prerequisite = (typeof PREREQUISITES)[number];

export function isPrerequisite(s: unknown): s is Prerequisite {
  return typeof s === 'string' && (PREREQUISITES as readonly string[]).includes(s);
}

/**
 * A valid continuity lease per FR-046–FR-050 / NFR-012. It authorizes an IN-PROGRESS operation
 * to continue after a health/connectivity loss, within bounds:
 *   - `policyVersion`        — the versioned continuity policy that authorized it (FR-046).
 *   - `operationId`          — the single operation it covers; started BEFORE the failure (FR-047).
 *   - `startedBeforeFailure` — proof the operation predates the failure (FR-047).
 *   - `expiresAt`            — lease expiry; a lease MUST NOT exceed 15 min (NFR-012, enforced by
 *                              the caller supplying `now`).
 *   - `stepLocallyVerifiable`— the current step's authority/scope/precondition/evidence/rollback
 *                              are still locally verifiable (FR-048); false ⇒ pause.
 *   - `evidenceBuffered`     — evidence is being buffered locally (FR-046/FR-049).
 */
export interface ContinuityLease {
  readonly leaseId: Uuid;
  readonly policyVersion: number;
  readonly operationId: Uuid;
  readonly startedBeforeFailure: boolean;
  readonly expiresAt: EpochMillis;
  readonly stepLocallyVerifiable: boolean;
  readonly evidenceBuffered: boolean;
}

/** Non-throwing structural validity check for a continuity lease (excludes expiry — that is a
 * `now`-relative check performed in the gate). Returns false for a malformed / non-FR-047 lease. */
export function isValidContinuityLease(l: unknown): l is ContinuityLease {
  if (typeof l !== 'object' || l === null) return false;
  const lease = l as ContinuityLease;
  return (
    isUuid(lease.leaseId) &&
    Number.isInteger(lease.policyVersion) &&
    lease.policyVersion >= 1 &&
    isUuid(lease.operationId) &&
    lease.startedBeforeFailure === true && // FR-047: continuity only for pre-failure operations
    Number.isInteger(lease.expiresAt) &&
    lease.expiresAt >= 0 &&
    typeof lease.stepLocallyVerifiable === 'boolean' &&
    typeof lease.evidenceBuffered === 'boolean'
  );
}

/**
 * The live runtime availability profile of a component: its availability class, current runtime
 * state, the LIVE satisfaction of each governance prerequisite, the health/connectivity signal,
 * the last-known observation time, and (optionally) an active continuity lease. This is the
 * OBSERVED fact — SEPARATE from the owner-approved architecture role above.
 */
export interface RuntimeAvailability {
  readonly availabilityClass: AvailabilityClass;
  readonly state: RuntimeState;
  /** Live satisfaction of each governance prerequisite. A prerequisite absent from the map, or
   * mapped to false, is treated as NOT satisfied (fail-closed). */
  readonly prerequisites: Readonly<Partial<Record<Prerequisite, boolean>>>;
  readonly healthy: boolean;
  readonly connected: boolean;
  readonly lastObservedAt: EpochMillis;
  readonly continuityLease?: ContinuityLease;
}

// ===========================================================================
// 3. Assertions — the two profiles are separate, complete governed facts
// ===========================================================================

function assertReviewDate(approval: OwnerApproval): void {
  if (!approval || typeof approval !== 'object') throw new TypeError('owner approval required');
  if (
    !approval.approvedBy ||
    typeof approval.approvedBy.ownerId !== 'string' ||
    approval.approvedBy.ownerId.trim().length === 0
  ) {
    throw new TypeError('architecture role must be approved by a named owner');
  }
  if (!isConsequentialReason(approval.reason)) {
    throw new TypeError('owner approval must carry a structured non-empty reason');
  }
  if (!Number.isInteger(approval.effectiveFrom) || approval.effectiveFrom < 0) {
    throw new TypeError('owner approval must have an effectiveFrom epoch');
  }
  if (!Number.isInteger(approval.reviewDate) || approval.reviewDate < 0) {
    throw new TypeError('owner approval must carry a mandatory review date');
  }
  if (approval.reviewDate <= approval.effectiveFrom) {
    throw new TypeError('owner-approval review date must be after its effective date');
  }
}

/**
 * Validate an owner-approved architecture role profile: a fully-governed controller entity PLUS
 * a valid role, well-formed dependency declarations, an authority record, activation conditions,
 * and an owner approval with a mandatory review date. "Owner-approved architecture role" is a
 * checked invariant, not a claim.
 */
export function assertArchitectureRoleProfile(p: unknown): asserts p is ArchitectureRoleProfile {
  assertGovernedEntity(p);
  const prof = p as ArchitectureRoleProfile;
  if (prof.kind !== 'controller') {
    throw new TypeError('architecture role profile must be a governed controller entity');
  }
  if (!isArchitectureRole(prof.role)) {
    throw new TypeError(`unknown architecture role: ${String(prof.role)}`);
  }
  if (!Array.isArray(prof.dependencies)) {
    throw new TypeError('architecture role must declare a dependencies array (possibly empty)');
  }
  for (const d of prof.dependencies) {
    if (!isUuid(d?.componentId)) throw new TypeError('dependency.componentId must be a UUID');
    if (!isArchitectureRole(d.role)) throw new TypeError('dependency.role must be a valid role');
    if (typeof d.required !== 'boolean') throw new TypeError('dependency.required must be boolean');
  }
  const a = prof.authority;
  if (!a || typeof a.mayExecute !== 'boolean' || typeof a.crossTenant !== 'boolean') {
    throw new TypeError('architecture role must declare authority (mayExecute, crossTenant)');
  }
  if (!Array.isArray(a.consequentialActions)) {
    throw new TypeError('authority.consequentialActions must be an array (empty ⇒ read-only)');
  }
  if (!a.mayExecute && a.consequentialActions.length > 0) {
    throw new TypeError('a component that may not execute cannot enumerate consequential actions');
  }
  const act = prof.activation;
  if (!act || !Array.isArray(act.requires) || typeof act.manualApprovalRequired !== 'boolean') {
    throw new TypeError('architecture role must declare activation conditions');
  }
  for (const r of act.requires) {
    if (!isPrerequisite(r)) throw new TypeError(`unknown activation prerequisite: ${String(r)}`);
  }
  // A component permitted to execute consequential actions MUST require authority, policy,
  // evidence, ownership, and reconciliation to activate (they cannot be optional for it).
  if (a.mayExecute) {
    for (const req of PREREQUISITES) {
      if (!act.requires.includes(req)) {
        throw new TypeError(
          `an executing component must require "${req}" as an activation condition`,
        );
      }
    }
  }
  assertReviewDate(prof.approval);
}

/** Non-throwing companion to {@link assertArchitectureRoleProfile}. */
export function isArchitectureRoleProfile(p: unknown): p is ArchitectureRoleProfile {
  try {
    assertArchitectureRoleProfile(p);
    return true;
  } catch {
    return false;
  }
}

/** Validate a runtime availability profile: a valid class, state, prerequisite map, health,
 * connectivity, and (if present) a structurally valid continuity lease. */
export function assertRuntimeAvailability(r: unknown): asserts r is RuntimeAvailability {
  if (typeof r !== 'object' || r === null) throw new TypeError('runtime availability required');
  const ra = r as RuntimeAvailability;
  if (!isAvailabilityClass(ra.availabilityClass)) {
    throw new TypeError(`unknown availability class: ${String(ra.availabilityClass)}`);
  }
  if (!isRuntimeState(ra.state)) throw new TypeError(`unknown runtime state: ${String(ra.state)}`);
  if (typeof ra.prerequisites !== 'object' || ra.prerequisites === null) {
    throw new TypeError('runtime availability must carry a prerequisite satisfaction map');
  }
  for (const k of Object.keys(ra.prerequisites)) {
    if (!isPrerequisite(k)) throw new TypeError(`unknown prerequisite key: ${k}`);
    if (typeof ra.prerequisites[k as Prerequisite] !== 'boolean') {
      throw new TypeError(`prerequisite "${k}" must map to a boolean`);
    }
  }
  if (typeof ra.healthy !== 'boolean') throw new TypeError('runtime availability.healthy required');
  if (typeof ra.connected !== 'boolean')
    throw new TypeError('runtime availability.connected required');
  if (!Number.isInteger(ra.lastObservedAt) || ra.lastObservedAt < 0) {
    throw new TypeError('runtime availability must carry lastObservedAt');
  }
  if (ra.continuityLease !== undefined && !isValidContinuityLease(ra.continuityLease)) {
    throw new TypeError('runtime availability continuityLease, if present, must be valid');
  }
}

// ===========================================================================
// 4. The NFR-010 safe-degradation execution gate
// ===========================================================================

/** What execution the caller is attempting. `new` = a new operation; `in-progress` = a step of
 * an operation approved and started before any failure. */
export type ExecutionKind = 'new' | 'in-progress';

/** The block reason categories the gate can return, most-severe/first-cause first. */
export type BlockCause =
  | 'prerequisite-lost'
  | 'health-or-connectivity-lost'
  | 'continuity-lease-invalid'
  | 'continuity-lease-expired'
  | 'step-not-locally-verifiable'
  | 'not-activated';

/**
 * The result of the safe-degradation gate. Whatever the decision:
 *   - `readOnlyVisibility` and `escalation` are ALWAYS true (NFR-010 keeps them available).
 *   - `allowed` says whether the attempted execution may proceed.
 *   - When blocked, `blocked` lists the causes and `safeAction` names the required next action.
 *   - `continuity` is true iff an in-progress operation is being allowed under FR-046–FR-050.
 */
export interface ExecutionGateResult {
  readonly allowed: boolean;
  readonly blocked: readonly BlockCause[];
  readonly continuity: boolean;
  readonly readOnlyVisibility: true;
  readonly escalation: true;
  readonly safeAction: 'proceed' | 'continue-under-continuity' | 'pause-and-reconcile' | 'block';
  readonly reason: string;
}

/** Which governance prerequisites (for this component's activation requirements) are currently
 * NOT satisfied. A prerequisite is satisfied only if it is explicitly present AND true. */
export function unmetPrerequisites(
  profile: ArchitectureRoleProfile,
  availability: RuntimeAvailability,
): readonly Prerequisite[] {
  const required =
    profile.activation.requires.length > 0 ? profile.activation.requires : PREREQUISITES;
  return required.filter((p) => availability.prerequisites[p] !== true);
}

const ALWAYS: Pick<ExecutionGateResult, 'readOnlyVisibility' | 'escalation'> = {
  readOnlyVisibility: true,
  escalation: true,
};

/**
 * Evaluate the single NFR-010 / VO-713cc2a06e03c63484b4 execution decision for a component,
 * combining its OWNER-APPROVED ARCHITECTURE ROLE and its LIVE RUNTIME AVAILABILITY. Deterministic
 * and fail-closed. `now` is injected (never the wall clock) so lease-expiry is reproducible.
 *
 * Decision order (first cause wins, and read-only visibility + escalation always remain):
 *   1. If ANY required governance prerequisite (authority/policy/evidence/ownership/
 *      reconciliation) is not currently satisfied ⇒ BLOCK immediately, new AND in-progress.
 *      Continuity mode cannot rescue a lost prerequisite.
 *   2. Otherwise, if health OR connectivity is lost:
 *        a. A NEW operation is blocked immediately.
 *        b. An IN-PROGRESS operation may continue ONLY under a valid, unexpired FR-046–FR-050
 *           continuity lease whose current step is locally verifiable; otherwise it pauses at a
 *           safe checkpoint and requires reconciliation.
 *   3. Otherwise (healthy, connected, prerequisites hold): a NEW operation may proceed only if
 *      the component is activated/available; an in-progress operation proceeds.
 */
export function evaluateExecutionGate(input: {
  profile: ArchitectureRoleProfile;
  availability: RuntimeAvailability;
  execution: ExecutionKind;
  now: EpochMillis;
}): ExecutionGateResult {
  const { profile, availability, execution, now } = input;
  assertArchitectureRoleProfile(profile);
  assertRuntimeAvailability(availability);
  if (execution !== 'new' && execution !== 'in-progress') {
    throw new TypeError(`execution must be 'new' or 'in-progress': ${String(execution)}`);
  }
  if (!Number.isInteger(now) || now < 0) throw new TypeError('now must be an epoch millis value');

  // ---- 1. Governance prerequisites — loss blocks affected execution IMMEDIATELY -------------
  const unmet = unmetPrerequisites(profile, availability);
  if (unmet.length > 0) {
    return {
      ...ALWAYS,
      allowed: false,
      blocked: ['prerequisite-lost'],
      continuity: false,
      safeAction: 'block',
      reason: `blocked: required ${unmet.join(', ')} not currently satisfied — execution blocked immediately (new and in-progress); continuity mode cannot rescue a lost governance prerequisite`,
    };
  }

  // ---- 2. Health / connectivity loss --------------------------------------------------------
  const healthLost = !availability.healthy || !availability.connected;
  if (healthLost) {
    if (execution === 'new') {
      return {
        ...ALWAYS,
        allowed: false,
        blocked: ['health-or-connectivity-lost'],
        continuity: false,
        safeAction: 'block',
        reason:
          'blocked: health or connectivity lost — new execution blocked immediately; read-only visibility and escalation remain available',
      };
    }
    // in-progress: continuity ONLY under FR-046–FR-050.
    const lease = availability.continuityLease;
    const blocked: BlockCause[] = ['health-or-connectivity-lost'];
    if (!lease || !isValidContinuityLease(lease)) {
      return {
        ...ALWAYS,
        allowed: false,
        blocked: [...blocked, 'continuity-lease-invalid'],
        continuity: false,
        safeAction: 'pause-and-reconcile',
        reason:
          'paused: no valid FR-046–FR-050 continuity lease covers the in-progress step — pause at a safe checkpoint and reconcile before any further governed mutation',
      };
    }
    if (lease.expiresAt <= now) {
      return {
        ...ALWAYS,
        allowed: false,
        blocked: [...blocked, 'continuity-lease-expired'],
        continuity: false,
        safeAction: 'pause-and-reconcile',
        reason:
          'paused: continuity lease expired (FR-050/NFR-012) — pause at a safe checkpoint; renewal requires restored health and successful reconciliation, not automatic extension',
      };
    }
    if (!lease.stepLocallyVerifiable) {
      return {
        ...ALWAYS,
        allowed: false,
        blocked: [...blocked, 'step-not-locally-verifiable'],
        continuity: false,
        safeAction: 'pause-and-reconcile',
        reason:
          'paused: current step is not locally verifiable (FR-048) — a new consequential/destructive/irreversible step must pause when its live safety conditions cannot be revalidated',
      };
    }
    // Valid, unexpired lease + locally-verifiable step ⇒ continue under continuity mode.
    return {
      ...ALWAYS,
      allowed: true,
      blocked: [],
      continuity: true,
      safeAction: 'continue-under-continuity',
      reason:
        'in-progress operation continues under a valid FR-046–FR-050 continuity lease while evidence is buffered; read-only visibility and escalation remain available',
    };
  }

  // ---- 3. Healthy, connected, prerequisites hold --------------------------------------------
  if (execution === 'new' && availability.state !== 'available') {
    return {
      ...ALWAYS,
      allowed: false,
      blocked: ['not-activated'],
      continuity: false,
      safeAction: 'block',
      reason: `blocked: component runtime state is "${availability.state}", not "available" — new execution requires an activated, available component`,
    };
  }
  return {
    ...ALWAYS,
    allowed: true,
    blocked: [],
    continuity: false,
    safeAction: 'proceed',
    reason: 'execution permitted: prerequisites satisfied, healthy and connected',
  };
}

// ===========================================================================
// 5. Constructors + durable-effect witness
// ===========================================================================

/**
 * Construct a validated owner-approved architecture role profile. The caller supplies the
 * governance facets (stable UUIDv7 id, tenant scope, owner, version, lifecycle state, governance
 * contract) plus the role, dependencies, authority, activation conditions, and owner approval.
 * The result is validated before return, so an ungoverned or unapproved profile cannot exist.
 */
export function defineArchitectureRoleProfile(input: {
  id: Uuid;
  tenantId: TenantId;
  version: number;
  owner: Owner;
  lifecycleState: GovernedEntity['lifecycleState'];
  contract: GovernanceContract;
  role: ArchitectureRole;
  dependencies: readonly ComponentDependency[];
  authority: ComponentAuthority;
  activation: ActivationConditions;
  approval: OwnerApproval;
}): ArchitectureRoleProfile {
  assertGovernanceContract(input.contract);
  const profile: ArchitectureRoleProfile = {
    id: input.id,
    kind: 'controller',
    tenantId: input.tenantId,
    version: input.version,
    owner: input.owner,
    lifecycleState: input.lifecycleState,
    contract: input.contract,
    role: input.role,
    dependencies: input.dependencies,
    authority: input.authority,
    activation: input.activation,
    approval: input.approval,
  };
  assertArchitectureRoleProfile(profile);
  return profile;
}

/**
 * Canonical content digest of an architecture role profile — a stable content hash that could
 * not exist before the profile was constructed and changes iff any governed facet, the role,
 * a dependency, the authority, activation, or the owner approval (including its review date)
 * changes. An independently-verifiable durable-effect witness for higher layers and tests.
 */
export function architectureRoleProfileDigest(p: ArchitectureRoleProfile): string {
  assertArchitectureRoleProfile(p);
  const canonical = JSON.stringify({
    id: p.id,
    kind: p.kind,
    tenantId: p.tenantId,
    version: p.version,
    owner: p.owner,
    lifecycleState: p.lifecycleState,
    contract: {
      tests: [...p.contract.tests].sort(),
      monitoring: [...p.contract.monitoring].sort(),
      failureBehavior: p.contract.failureBehavior,
      exceptions: p.contract.exceptions.map((x) => ({
        exceptionId: x.exceptionId,
        reason: x.reason,
        approvedBy: x.approvedBy,
        expiresAt: x.expiresAt,
      })),
      evidenceExpectations: [...p.contract.evidenceExpectations].sort(),
    },
    role: p.role,
    dependencies: [...p.dependencies]
      .map((d) => ({ componentId: d.componentId, role: d.role, required: d.required }))
      .sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0)),
    authority: {
      mayExecute: p.authority.mayExecute,
      consequentialActions: [...p.authority.consequentialActions].sort(),
      crossTenant: p.authority.crossTenant,
    },
    activation: {
      requires: [...p.activation.requires].sort(),
      manualApprovalRequired: p.activation.manualApprovalRequired,
    },
    approval: {
      approvedBy: p.approval.approvedBy,
      reason: p.approval.reason,
      effectiveFrom: p.approval.effectiveFrom,
      reviewDate: p.approval.reviewDate,
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** True iff the owner-approval review date for `p` is on or before `now` — i.e. the role is due
 * for owner re-review. Higher layers surface this as a governance gap rather than letting a
 * stale approval silently persist. */
export function isReviewDue(p: ArchitectureRoleProfile, now: EpochMillis): boolean {
  assertArchitectureRoleProfile(p);
  return now >= p.approval.reviewDate;
}
