// @trustcircle/domain — INTEGRITY-CASE, QUARANTINE, REMEDIATION-PLAN, REPAIR-ATTEMPT, and
// VERIFICATION-RECORD aggregates (Phase 5 / User Story 3 — Contain and Repair Damaged Work Safely /
// FR-016..022, SC-006..009).
//
// This module is the value-level, dependency-free (node:crypto only) form of the durable integrity
// / remediation substrate authored in `db/migrations/0030_integrity_remediation.sql`. It is aligned
// column-for-column with that migration and with the governance-api `IntegrityCase` and
// `VerificationRecord` schemas, so a projection over the physical rows, an in-memory aggregate, and
// an API response share ONE vocabulary and ONE set of invariants.
//
// Each aggregate is constructed through an ASSERTING factory that refuses a write violating a
// fail-visible CHECK from the migration, and exposes a `*Digest` sha256 content-hash as an
// independently-observable durable-effect witness. The load-bearing invariants this module makes
// enforceable at the value level:
//
//   * PRESERVATION PRECEDES CLASSIFICATION (FR-017). `makeIntegrityCase` REQUIRES an
//     `originalEvidenceId`; a case cannot exist without its preserved original. `ownershipGap`
//     pairs with a null owner (an unownable corrupted item is an explicit gap, never a fabrication).
//   * DESTRUCTIVE AUTOMATIC REMEDIATION IS IMPOSSIBLE (FR-021 / GAR-004). A `RemediationPlan` whose
//     `authorizationMode === 'pre_authorized_low_risk'` MUST be non-destructive, low-risk, and
//     policy-bound — the factory throws otherwise, so the type system + factory make the prohibition
//     a checked invariant, not a runtime hope.
//   * UNCERTAINTY IS NOT SUCCESS (FR-022). The `RepairAttempt` outcome vocabulary keeps
//     `succeeded_unverified` and `uncertain` distinct from `verified`; only an independent
//     `VerificationRecord` with a passing gate set converts a repair into verified closure.
//   * VERIFIED CLOSURE GATE (data-model "Verified Closure Gate"). `verifiedClosureResult` evaluates
//     the NINE gate conditions and returns `passed` only when every one holds AND the verifier is
//     independent; a failed gate leaves the subject un-closed.
//
// Authority, policy currency, and independence are NOT decided here — those verdicts come from the
// application services (@trustcircle/authz, the policy PDP, the automatic-repair-policy) and are
// threaded in. This module owns the SHAPE and the fail-visible field vocabularies.

import { createHash } from 'node:crypto';
import { isUuid, type Uuid, type EpochMillis, type TenantId, type Reason } from './primitives.ts';

// ---------------------------------------------------------------------------
// Shared assert helpers (mirror decisions.ts / inventory.ts: fail-visible, throw on violation).
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

function assertUnitInterval(n: unknown, label: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new RangeError(`${label} must be a confidence in [0,1]`);
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

// ===========================================================================
// 1. Shared integrity vocabularies (mirror the migration CHECK domains exactly).
// ===========================================================================

/** The eight defect classes (six spec classes + `combined` + `unknown`). FR-016. */
export const PROBLEM_CLASSES = [
  'malformed',
  'corrupted',
  'duplicated',
  'stale',
  'conflicting',
  'orphaned',
  'combined',
  'unknown',
] as const;
export type ProblemClass = (typeof PROBLEM_CLASSES)[number];

/** The six canonical spec defect classes (excludes the `combined`/`unknown` meta-classes). */
export const CANONICAL_PROBLEM_CLASSES: readonly ProblemClass[] = [
  'malformed',
  'corrupted',
  'duplicated',
  'stale',
  'conflicting',
  'orphaned',
];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A detection's disposition — a suspected/false-positive finding is retained, not deleted. */
export const CASE_DISPOSITIONS = ['confirmed', 'suspected', 'false_positive'] as const;
export type CaseDisposition = (typeof CASE_DISPOSITIONS)[number];

export const SAFETY_IMPACTS = ['none', 'low', 'moderate', 'high', 'catastrophic'] as const;
export type SafetyImpact = (typeof SAFETY_IMPACTS)[number];

export const EVIDENCE_STATUSES = ['preserved', 'partial', 'unverifiable', 'tampered'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** IntegrityCase lifecycle. Terminal-for-resolution states are `closed`/`unresolved`/`escalated`. */
export const INTEGRITY_CASE_STATES = [
  'detected',
  'preserved',
  'classified',
  'quarantined',
  'remediation_proposed',
  'repairing',
  'verifying',
  'repaired',
  'closed',
  'unresolved',
  'escalated',
] as const;
export type IntegrityCaseState = (typeof INTEGRITY_CASE_STATES)[number];

/** States at which the case is resolved in one direction or another (no further auto-processing). */
export const TERMINAL_CASE_STATES: readonly IntegrityCaseState[] = [
  'closed',
  'unresolved',
  'escalated',
];

export function isTerminalCaseState(s: IntegrityCaseState): boolean {
  return TERMINAL_CASE_STATES.includes(s);
}

// ===========================================================================
// 1b. integrity_rule_version — an IMMUTABLE version of a stable integrity rule (FR-016).
//     An ACTIVE version MUST carry tests and an effective_from instant — a rule cannot
//     monitor production without a verification obligation and an activation time.
// ===========================================================================

export const RULE_LIFECYCLE_STATES = [
  'draft',
  'proposed',
  'active',
  'deprecated',
  'retired',
] as const;
export type RuleLifecycleState = (typeof RULE_LIFECYCLE_STATES)[number];

export interface IntegrityRuleVersion {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly ruleId: Uuid;
  readonly version: number;
  readonly problemClass: ProblemClass;
  readonly applicability: Readonly<Record<string, unknown>>;
  readonly detectionQuery: Readonly<Record<string, unknown>>;
  readonly severity: Severity;
  readonly confidenceModel: Readonly<Record<string, unknown>>;
  readonly quarantineCondition: Readonly<Record<string, unknown>>;
  readonly lowRiskRepairEligible: boolean;
  readonly tests: readonly Readonly<Record<string, unknown>>[];
  readonly monitoring: readonly Readonly<Record<string, unknown>>[];
  readonly policyControlMappings: readonly Readonly<Record<string, unknown>>[];
  readonly ownerPrincipalId: Uuid;
  readonly approvalDecisionId?: Uuid;
  readonly lifecycleState: RuleLifecycleState;
  readonly effectiveFrom?: EpochMillis;
  readonly effectiveTo?: EpochMillis;
  readonly createdAt: EpochMillis;
}

export function makeIntegrityRuleVersion(input: {
  id: Uuid;
  tenantId: TenantId;
  ruleId: Uuid;
  version: number;
  problemClass: ProblemClass;
  applicability?: Record<string, unknown>;
  detectionQuery?: Record<string, unknown>;
  severity?: Severity;
  confidenceModel?: Record<string, unknown>;
  quarantineCondition?: Record<string, unknown>;
  lowRiskRepairEligible?: boolean;
  tests?: readonly Record<string, unknown>[];
  monitoring?: readonly Record<string, unknown>[];
  policyControlMappings?: readonly Record<string, unknown>[];
  ownerPrincipalId: Uuid;
  approvalDecisionId?: Uuid;
  lifecycleState?: RuleLifecycleState;
  effectiveFrom?: EpochMillis;
  effectiveTo?: EpochMillis;
  createdAt: EpochMillis;
}): IntegrityRuleVersion {
  assertUuid(input.id, 'rule.id');
  assertTenant(input.tenantId, 'rule.tenantId');
  assertUuid(input.ruleId, 'rule.ruleId');
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new RangeError('rule.version must be ≥ 1');
  }
  assertMember(input.problemClass, PROBLEM_CLASSES, 'rule.problemClass');
  const severity = input.severity ?? 'medium';
  assertMember(severity, SEVERITIES, 'rule.severity');
  const lifecycleState = input.lifecycleState ?? 'draft';
  assertMember(lifecycleState, RULE_LIFECYCLE_STATES, 'rule.lifecycleState');
  assertUuid(input.ownerPrincipalId, 'rule.ownerPrincipalId');
  if (input.approvalDecisionId !== undefined) assertUuid(input.approvalDecisionId, 'rule.approvalDecisionId');
  const tests = (input.tests ?? []).map((t) => frozenObj(t));
  if (input.effectiveFrom !== undefined) assertEpoch(input.effectiveFrom, 'rule.effectiveFrom');
  if (input.effectiveTo !== undefined) assertEpoch(input.effectiveTo, 'rule.effectiveTo');
  // Fail-closed activation: an ACTIVE version must carry ≥1 test and an activation instant.
  if (lifecycleState === 'active') {
    if (input.effectiveFrom === undefined) {
      throw new TypeError('an active rule version requires an effectiveFrom instant (fail-closed activation)');
    }
    if (tests.length < 1) {
      throw new TypeError('an active rule version requires ≥ 1 test (fail-closed activation)');
    }
  }
  assertEpoch(input.createdAt, 'rule.createdAt');
  const draft = compact<IntegrityRuleVersion>({
    id: input.id,
    tenantId: input.tenantId,
    ruleId: input.ruleId,
    version: input.version,
    problemClass: input.problemClass,
    applicability: frozenObj(input.applicability),
    detectionQuery: frozenObj(input.detectionQuery),
    severity,
    confidenceModel: frozenObj(input.confidenceModel),
    quarantineCondition: frozenObj(input.quarantineCondition),
    lowRiskRepairEligible: input.lowRiskRepairEligible ?? false,
    tests: Object.freeze(tests),
    monitoring: Object.freeze((input.monitoring ?? []).map((m) => frozenObj(m))),
    policyControlMappings: Object.freeze((input.policyControlMappings ?? []).map((m) => frozenObj(m))),
    ownerPrincipalId: input.ownerPrincipalId,
    approvalDecisionId: input.approvalDecisionId,
    lifecycleState,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    createdAt: input.createdAt,
  });
  return draft;
}

export function integrityRuleVersionDigest(r: IntegrityRuleVersion): string {
  return sha256(
    JSON.stringify({
      id: r.id,
      tenantId: r.tenantId,
      ruleId: r.ruleId,
      version: r.version,
      problemClass: r.problemClass,
      applicability: r.applicability,
      detectionQuery: r.detectionQuery,
      severity: r.severity,
      confidenceModel: r.confidenceModel,
      quarantineCondition: r.quarantineCondition,
      lowRiskRepairEligible: r.lowRiskRepairEligible,
      tests: r.tests,
      monitoring: r.monitoring,
      policyControlMappings: r.policyControlMappings,
      ownerPrincipalId: r.ownerPrincipalId,
      approvalDecisionId: r.approvalDecisionId ?? null,
      lifecycleState: r.lifecycleState,
      effectiveFrom: r.effectiveFrom ?? null,
      effectiveTo: r.effectiveTo ?? null,
      createdAt: r.createdAt,
    }),
  );
}

/** True iff `version` is the currently-effective active version at instant `now`. */
export function ruleVersionEffectiveAt(r: IntegrityRuleVersion, now: EpochMillis): boolean {
  if (r.lifecycleState !== 'active') return false;
  if (r.effectiveFrom === undefined || now < r.effectiveFrom) return false;
  if (r.effectiveTo !== undefined && now >= r.effectiveTo) return false;
  return true;
}

// ===========================================================================
// 2. integrity_case — one detected integrity problem against a work item (FR-018).
//    The ORIGINAL evidence is mandatory (FR-017: preservation precedes
//    classification). An unownable item is an explicit `ownershipGap` (owner null).
// ===========================================================================

export interface IntegrityCase {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly workItemId: Uuid;
  readonly ruleVersionId: Uuid;
  readonly sourceRecordId: Uuid;
  /** The preserved original — REQUIRED; a case cannot exist without it (FR-017). */
  readonly originalEvidenceId: Uuid;
  readonly problemClass: ProblemClass;
  /** All constituent classes when `problemClass === 'combined'` (else the single class). */
  readonly problemClasses: readonly ProblemClass[];
  readonly severity: Severity;
  readonly confidence: number;
  readonly disposition: CaseDisposition;
  readonly safetyImpact: SafetyImpact;
  readonly businessImpact: Readonly<Record<string, unknown>>;
  readonly affectedScope: Readonly<Record<string, unknown>>;
  readonly dependentWorkIds: readonly Uuid[];
  readonly evidenceStatus: EvidenceStatus;
  readonly sourceRef: Readonly<Record<string, unknown>>;
  readonly ownerPrincipalId: Uuid | null;
  readonly ownershipGap: boolean;
  readonly quarantineId?: Uuid;
  readonly activeRemediationPlanId?: Uuid;
  readonly resolutionVerificationId?: Uuid;
  readonly state: IntegrityCaseState;
  readonly version: number;
  readonly detectedAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

export function makeIntegrityCase(input: {
  id: Uuid;
  tenantId: TenantId;
  workItemId: Uuid;
  ruleVersionId: Uuid;
  sourceRecordId: Uuid;
  originalEvidenceId: Uuid;
  problemClass: ProblemClass;
  problemClasses?: readonly ProblemClass[];
  severity?: Severity;
  confidence: number;
  disposition?: CaseDisposition;
  safetyImpact?: SafetyImpact;
  businessImpact?: Record<string, unknown>;
  affectedScope?: Record<string, unknown>;
  dependentWorkIds?: readonly Uuid[];
  evidenceStatus?: EvidenceStatus;
  sourceRef?: Record<string, unknown>;
  ownerPrincipalId?: Uuid | null;
  ownershipGap?: boolean;
  quarantineId?: Uuid;
  activeRemediationPlanId?: Uuid;
  resolutionVerificationId?: Uuid;
  state?: IntegrityCaseState;
  version?: number;
  detectedAt: EpochMillis;
  updatedAt: EpochMillis;
}): IntegrityCase {
  assertUuid(input.id, 'case.id');
  assertTenant(input.tenantId, 'case.tenantId');
  assertUuid(input.workItemId, 'case.workItemId');
  assertUuid(input.ruleVersionId, 'case.ruleVersionId');
  assertUuid(input.sourceRecordId, 'case.sourceRecordId');
  // FR-017: the ORIGINAL must have been preserved before this classified case can exist.
  assertUuid(input.originalEvidenceId, 'case.originalEvidenceId');
  assertMember(input.problemClass, PROBLEM_CLASSES, 'case.problemClass');
  const classes = input.problemClasses ?? [input.problemClass];
  for (const c of classes) assertMember(c, PROBLEM_CLASSES, 'case.problemClasses entry');
  if (input.problemClass === 'combined' && classes.filter((c) => c !== 'combined').length < 2) {
    throw new TypeError('case.problemClass=combined requires ≥ 2 constituent problemClasses');
  }
  const severity = input.severity ?? 'medium';
  assertMember(severity, SEVERITIES, 'case.severity');
  assertUnitInterval(input.confidence, 'case.confidence');
  const disposition = input.disposition ?? 'confirmed';
  assertMember(disposition, CASE_DISPOSITIONS, 'case.disposition');
  const safetyImpact = input.safetyImpact ?? 'none';
  assertMember(safetyImpact, SAFETY_IMPACTS, 'case.safetyImpact');
  const evidenceStatus = input.evidenceStatus ?? 'preserved';
  assertMember(evidenceStatus, EVIDENCE_STATUSES, 'case.evidenceStatus');
  const deps = input.dependentWorkIds ?? [];
  for (const d of deps) assertUuid(d, 'case.dependentWorkIds entry');
  // FR-017/FR-018: ownership is either a named owner OR an explicit gap — never a fabricated owner.
  const ownershipGap = input.ownershipGap ?? input.ownerPrincipalId == null;
  const owner = input.ownerPrincipalId ?? null;
  if (ownershipGap && owner !== null) {
    throw new TypeError('case.ownershipGap=true is incompatible with a named owner');
  }
  if (!ownershipGap) {
    if (owner === null) throw new TypeError('case.ownerPrincipalId required when ownershipGap=false');
    assertUuid(owner, 'case.ownerPrincipalId');
  }
  if (input.quarantineId !== undefined) assertUuid(input.quarantineId, 'case.quarantineId');
  if (input.activeRemediationPlanId !== undefined) {
    assertUuid(input.activeRemediationPlanId, 'case.activeRemediationPlanId');
  }
  if (input.resolutionVerificationId !== undefined) {
    assertUuid(input.resolutionVerificationId, 'case.resolutionVerificationId');
  }
  const state = input.state ?? 'detected';
  assertMember(state, INTEGRITY_CASE_STATES, 'case.state');
  // Verified Closure Gate: repaired/closed MUST cite a resolution verification.
  if ((state === 'repaired' || state === 'closed') && input.resolutionVerificationId === undefined) {
    throw new TypeError(`case.state=${state} requires a resolutionVerificationId (Verified Closure Gate)`);
  }
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new RangeError('case.version must be ≥ 1');
  assertEpoch(input.detectedAt, 'case.detectedAt');
  assertEpoch(input.updatedAt, 'case.updatedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    workItemId: input.workItemId,
    ruleVersionId: input.ruleVersionId,
    sourceRecordId: input.sourceRecordId,
    originalEvidenceId: input.originalEvidenceId,
    problemClass: input.problemClass,
    problemClasses: Object.freeze([...classes]),
    severity,
    confidence: input.confidence,
    disposition,
    safetyImpact,
    businessImpact: frozenObj(input.businessImpact),
    affectedScope: frozenObj(input.affectedScope),
    dependentWorkIds: Object.freeze([...deps]),
    evidenceStatus,
    sourceRef: frozenObj(input.sourceRef),
    ownerPrincipalId: owner,
    ownershipGap,
    quarantineId: input.quarantineId,
    activeRemediationPlanId: input.activeRemediationPlanId,
    resolutionVerificationId: input.resolutionVerificationId,
    state,
    version,
    detectedAt: input.detectedAt,
    updatedAt: input.updatedAt,
  });
}

export function integrityCaseDigest(k: IntegrityCase): string {
  return sha256(
    JSON.stringify({
      id: k.id,
      tenantId: k.tenantId,
      workItemId: k.workItemId,
      ruleVersionId: k.ruleVersionId,
      sourceRecordId: k.sourceRecordId,
      originalEvidenceId: k.originalEvidenceId,
      problemClass: k.problemClass,
      problemClasses: [...k.problemClasses].sort(),
      severity: k.severity,
      confidence: k.confidence,
      disposition: k.disposition,
      safetyImpact: k.safetyImpact,
      businessImpact: k.businessImpact,
      affectedScope: k.affectedScope,
      dependentWorkIds: [...k.dependentWorkIds].sort(),
      evidenceStatus: k.evidenceStatus,
      sourceRef: k.sourceRef,
      ownerPrincipalId: k.ownerPrincipalId,
      ownershipGap: k.ownershipGap,
      quarantineId: k.quarantineId ?? null,
      activeRemediationPlanId: k.activeRemediationPlanId ?? null,
      resolutionVerificationId: k.resolutionVerificationId ?? null,
      state: k.state,
      version: k.version,
      detectedAt: k.detectedAt,
      updatedAt: k.updatedAt,
    }),
  );
}

// ===========================================================================
// 3. quarantine — blocks unsafe execution while keeping the item visible (FR-019).
// ===========================================================================

export const QUARANTINE_VISIBILITY = ['visible_inspectable', 'visible_restricted'] as const;
export type QuarantineVisibility = (typeof QUARANTINE_VISIBILITY)[number];

export const QUARANTINE_STATUSES = [
  'active',
  'under_review',
  'release_proposed',
  'released',
  'expired',
] as const;
export type QuarantineStatus = (typeof QUARANTINE_STATUSES)[number];

export interface Quarantine {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly blockedCapabilities: readonly string[];
  readonly blockedDependencyIds: readonly Uuid[];
  readonly reason: Reason;
  readonly authorityRef: Readonly<Record<string, unknown>>;
  readonly visibilityPolicy: QuarantineVisibility;
  readonly originalEvidenceId: Uuid;
  readonly releasePreconditions: readonly Readonly<Record<string, unknown>>[];
  readonly releaseDecisionId?: Uuid;
  readonly reviewCadenceMs: number;
  readonly reviewDueAt: EpochMillis;
  readonly startedAt: EpochMillis;
  readonly status: QuarantineStatus;
  readonly releasedAt?: EpochMillis;
}

export function makeQuarantine(input: {
  id: Uuid;
  tenantId: TenantId;
  integrityCaseId: Uuid;
  blockedCapabilities: readonly string[];
  blockedDependencyIds?: readonly Uuid[];
  reason: Reason;
  authorityRef?: Record<string, unknown>;
  visibilityPolicy?: QuarantineVisibility;
  originalEvidenceId: Uuid;
  releasePreconditions?: readonly Record<string, unknown>[];
  releaseDecisionId?: Uuid;
  reviewCadenceMs?: number;
  reviewDueAt: EpochMillis;
  startedAt: EpochMillis;
  status?: QuarantineStatus;
  releasedAt?: EpochMillis;
}): Quarantine {
  assertUuid(input.id, 'quarantine.id');
  assertTenant(input.tenantId, 'quarantine.tenantId');
  assertUuid(input.integrityCaseId, 'quarantine.integrityCaseId');
  assertUuid(input.originalEvidenceId, 'quarantine.originalEvidenceId');
  for (const cap of input.blockedCapabilities) assertNonEmpty(cap, 'quarantine.blockedCapabilities entry');
  const deps = input.blockedDependencyIds ?? [];
  for (const d of deps) assertUuid(d, 'quarantine.blockedDependencyIds entry');
  assertNonEmpty(input.reason.code, 'quarantine.reason.code');
  assertNonEmpty(input.reason.text, 'quarantine.reason.text');
  const visibility = input.visibilityPolicy ?? 'visible_inspectable';
  assertMember(visibility, QUARANTINE_VISIBILITY, 'quarantine.visibilityPolicy');
  const status = input.status ?? 'active';
  assertMember(status, QUARANTINE_STATUSES, 'quarantine.status');
  // An ACTIVE quarantine must block at least one capability (it must actually contain effects).
  if (status === 'active' && input.blockedCapabilities.length === 0) {
    throw new TypeError('an active quarantine must block ≥ 1 capability');
  }
  // A release is a DECISION: a released quarantine must name its release decision (authority boundary).
  if (status === 'released' && input.releaseDecisionId === undefined) {
    throw new TypeError('a released quarantine must carry a releaseDecisionId (release authority)');
  }
  if (input.releaseDecisionId !== undefined) assertUuid(input.releaseDecisionId, 'quarantine.releaseDecisionId');
  const cadence = input.reviewCadenceMs ?? 86_400_000;
  if (!Number.isInteger(cadence) || cadence <= 0) {
    throw new RangeError('quarantine.reviewCadenceMs must be a positive integer');
  }
  assertEpoch(input.reviewDueAt, 'quarantine.reviewDueAt');
  assertEpoch(input.startedAt, 'quarantine.startedAt');
  if (input.releasedAt !== undefined) assertEpoch(input.releasedAt, 'quarantine.releasedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    integrityCaseId: input.integrityCaseId,
    blockedCapabilities: Object.freeze([...input.blockedCapabilities]),
    blockedDependencyIds: Object.freeze([...deps]),
    reason: { code: input.reason.code, text: input.reason.text },
    authorityRef: frozenObj(input.authorityRef),
    visibilityPolicy: visibility,
    originalEvidenceId: input.originalEvidenceId,
    releasePreconditions: Object.freeze((input.releasePreconditions ?? []).map((p) => frozenObj(p))),
    releaseDecisionId: input.releaseDecisionId,
    reviewCadenceMs: cadence,
    reviewDueAt: input.reviewDueAt,
    startedAt: input.startedAt,
    status,
    releasedAt: input.releasedAt,
  });
}

/** True iff `capability` is currently blocked by an ACTIVE/under-review quarantine (FR-019). */
export function quarantineBlocks(q: Quarantine, capability: string): boolean {
  if (q.status === 'released' || q.status === 'expired') return false;
  return q.blockedCapabilities.includes(capability);
}

/** Inspection is ALWAYS permitted while quarantined — containment blocks execution, not review. */
export function quarantinePermitsInspection(q: Quarantine): boolean {
  return q.visibilityPolicy === 'visible_inspectable' || q.visibilityPolicy === 'visible_restricted';
}

export function quarantineDigest(q: Quarantine): string {
  return sha256(
    JSON.stringify({
      id: q.id,
      tenantId: q.tenantId,
      integrityCaseId: q.integrityCaseId,
      blockedCapabilities: [...q.blockedCapabilities].sort(),
      blockedDependencyIds: [...q.blockedDependencyIds].sort(),
      reason: q.reason,
      authorityRef: q.authorityRef,
      visibilityPolicy: q.visibilityPolicy,
      originalEvidenceId: q.originalEvidenceId,
      releasePreconditions: q.releasePreconditions,
      releaseDecisionId: q.releaseDecisionId ?? null,
      reviewCadenceMs: q.reviewCadenceMs,
      reviewDueAt: q.reviewDueAt,
      startedAt: q.startedAt,
      status: q.status,
      releasedAt: q.releasedAt ?? null,
    }),
  );
}

// ===========================================================================
// 4. remediation_plan — an IMMUTABLE-per-version remediation recommendation (FR-020).
//    pre_authorized_low_risk MUST be non-destructive + low-risk + policy-bound (GAR-004).
// ===========================================================================

export const REMEDIATION_RISK_CLASSES = ['low', 'medium', 'high', 'critical'] as const;
export type RemediationRiskClass = (typeof REMEDIATION_RISK_CLASSES)[number];

export const AUTHORIZATION_MODES = ['human', 'pre_authorized_low_risk'] as const;
export type AuthorizationMode = (typeof AUTHORIZATION_MODES)[number];

export const REMEDIATION_STATUSES = [
  'draft',
  'simulated',
  'pending_approval',
  'approved',
  'expired',
  'superseded',
] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export interface RemediationPlan {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly version: number;
  readonly proposedChange: Readonly<Record<string, unknown>>;
  readonly rationale: string;
  readonly expectedResult: Readonly<Record<string, unknown>>;
  readonly riskClass: RemediationRiskClass;
  readonly destructive: boolean;
  readonly affectedScope: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly Readonly<Record<string, unknown>>[];
  readonly policyVersionId?: Uuid;
  readonly authorizationMode: AuthorizationMode;
  readonly bounds: Readonly<Record<string, unknown>>;
  readonly evidencePlan: Readonly<Record<string, unknown>>;
  readonly verificationPlan: Readonly<Record<string, unknown>>;
  readonly stopConditions: readonly Readonly<Record<string, unknown>>[];
  readonly rollbackPlan: Readonly<Record<string, unknown>>;
  readonly simulationId?: Uuid;
  readonly approvalDecisionId?: Uuid;
  readonly ownerPrincipalId: Uuid;
  readonly expiresAt: EpochMillis;
  readonly status: RemediationStatus;
  readonly createdAt: EpochMillis;
}

export function makeRemediationPlan(input: {
  id: Uuid;
  tenantId: TenantId;
  integrityCaseId: Uuid;
  version?: number;
  proposedChange?: Record<string, unknown>;
  rationale: string;
  expectedResult?: Record<string, unknown>;
  riskClass?: RemediationRiskClass;
  destructive?: boolean;
  affectedScope?: Record<string, unknown>;
  preconditions?: readonly Record<string, unknown>[];
  policyVersionId?: Uuid;
  authorizationMode?: AuthorizationMode;
  bounds?: Record<string, unknown>;
  evidencePlan?: Record<string, unknown>;
  verificationPlan?: Record<string, unknown>;
  stopConditions?: readonly Record<string, unknown>[];
  rollbackPlan?: Record<string, unknown>;
  simulationId?: Uuid;
  approvalDecisionId?: Uuid;
  ownerPrincipalId: Uuid;
  expiresAt: EpochMillis;
  status?: RemediationStatus;
  createdAt: EpochMillis;
}): RemediationPlan {
  assertUuid(input.id, 'plan.id');
  assertTenant(input.tenantId, 'plan.tenantId');
  assertUuid(input.integrityCaseId, 'plan.integrityCaseId');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new RangeError('plan.version must be ≥ 1');
  if (typeof input.rationale !== 'string' || input.rationale.trim().length < 3) {
    throw new TypeError('plan.rationale must be a non-vacuous string (≥ 3 chars)');
  }
  const riskClass = input.riskClass ?? 'medium';
  assertMember(riskClass, REMEDIATION_RISK_CLASSES, 'plan.riskClass');
  const destructive = input.destructive ?? false;
  const authorizationMode = input.authorizationMode ?? 'human';
  assertMember(authorizationMode, AUTHORIZATION_MODES, 'plan.authorizationMode');
  // GAR-004 / FR-021: pre-authorized automatic repair MUST be low-risk, non-destructive, policy-bound.
  if (authorizationMode === 'pre_authorized_low_risk') {
    if (destructive) {
      throw new TypeError('a pre_authorized_low_risk plan may not be destructive (GAR-004)');
    }
    if (riskClass !== 'low') {
      throw new TypeError('a pre_authorized_low_risk plan must be riskClass=low (FR-021)');
    }
    if (input.policyVersionId === undefined) {
      throw new TypeError('a pre_authorized_low_risk plan must bind a policyVersionId (FR-021)');
    }
  }
  if (input.policyVersionId !== undefined) assertUuid(input.policyVersionId, 'plan.policyVersionId');
  if (input.simulationId !== undefined) assertUuid(input.simulationId, 'plan.simulationId');
  if (input.approvalDecisionId !== undefined) assertUuid(input.approvalDecisionId, 'plan.approvalDecisionId');
  assertUuid(input.ownerPrincipalId, 'plan.ownerPrincipalId');
  const status = input.status ?? 'draft';
  assertMember(status, REMEDIATION_STATUSES, 'plan.status');
  assertEpoch(input.expiresAt, 'plan.expiresAt');
  assertEpoch(input.createdAt, 'plan.createdAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    integrityCaseId: input.integrityCaseId,
    version,
    proposedChange: frozenObj(input.proposedChange),
    rationale: input.rationale.trim(),
    expectedResult: frozenObj(input.expectedResult),
    riskClass,
    destructive,
    affectedScope: frozenObj(input.affectedScope),
    preconditions: Object.freeze((input.preconditions ?? []).map((p) => frozenObj(p))),
    policyVersionId: input.policyVersionId,
    authorizationMode,
    bounds: frozenObj(input.bounds),
    evidencePlan: frozenObj(input.evidencePlan),
    verificationPlan: frozenObj(input.verificationPlan),
    stopConditions: Object.freeze((input.stopConditions ?? []).map((s) => frozenObj(s))),
    rollbackPlan: frozenObj(input.rollbackPlan),
    simulationId: input.simulationId,
    approvalDecisionId: input.approvalDecisionId,
    ownerPrincipalId: input.ownerPrincipalId,
    expiresAt: input.expiresAt,
    status,
    createdAt: input.createdAt,
  });
}

/** True iff this plan is eligible for AUTOMATIC (non-human) execution (FR-021 shape gate only —
 *  policy currency, preconditions, and bounds are checked by the automatic-repair-policy service). */
export function isAutomaticEligible(p: RemediationPlan): boolean {
  return (
    p.authorizationMode === 'pre_authorized_low_risk' &&
    p.destructive === false &&
    p.riskClass === 'low' &&
    p.policyVersionId !== undefined
  );
}

export function remediationPlanDigest(p: RemediationPlan): string {
  return sha256(
    JSON.stringify({
      id: p.id,
      tenantId: p.tenantId,
      integrityCaseId: p.integrityCaseId,
      version: p.version,
      proposedChange: p.proposedChange,
      rationale: p.rationale,
      expectedResult: p.expectedResult,
      riskClass: p.riskClass,
      destructive: p.destructive,
      affectedScope: p.affectedScope,
      preconditions: p.preconditions,
      policyVersionId: p.policyVersionId ?? null,
      authorizationMode: p.authorizationMode,
      bounds: p.bounds,
      evidencePlan: p.evidencePlan,
      verificationPlan: p.verificationPlan,
      stopConditions: p.stopConditions,
      rollbackPlan: p.rollbackPlan,
      simulationId: p.simulationId ?? null,
      approvalDecisionId: p.approvalDecisionId ?? null,
      ownerPrincipalId: p.ownerPrincipalId,
      expiresAt: p.expiresAt,
      status: p.status,
      createdAt: p.createdAt,
    }),
  );
}

// ===========================================================================
// 5. repair_attempt — the execution of an approved plan version (FR-021/022).
//    One idempotency identity; uncertainty is NOT success.
// ===========================================================================

export const REPAIR_OUTCOMES = [
  'pending',
  'succeeded_unverified',
  'verified',
  'failed',
  'uncertain',
  'rolled_back',
  'rollback_failed',
] as const;
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number];

export const ROLLBACK_OUTCOMES = ['rolled_back', 'partial', 'conflict', 'failed'] as const;
export type RollbackOutcome = (typeof ROLLBACK_OUTCOMES)[number];

/** Outcomes that DO NOT constitute verified resolution — they must retain quarantine + escalate. */
export const UNRESOLVED_REPAIR_OUTCOMES: readonly RepairOutcome[] = [
  'succeeded_unverified',
  'failed',
  'uncertain',
  'rollback_failed',
];

export interface RepairStepOutcome {
  readonly step: string;
  readonly result: 'ok' | 'skipped' | 'stopped' | 'failed';
  readonly detail?: string;
}

export interface RepairAttempt {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly remediationPlanId: Uuid;
  readonly planVersion: number;
  readonly idempotencyKey: string;
  readonly preservedOriginalEvidenceId: Uuid;
  readonly expectedSourceRevision: string;
  readonly actualSourceRevision?: string;
  readonly appliedPolicyVersionId?: Uuid;
  readonly decisionId?: Uuid;
  readonly executorPrincipalId: Uuid;
  readonly stepOutcomes: readonly RepairStepOutcome[];
  readonly derivedEvidenceId?: Uuid;
  readonly sourceResponse: Readonly<Record<string, unknown>>;
  readonly killSwitchEngaged: boolean;
  readonly rollbackAttempted: boolean;
  readonly rollbackOutcome?: RollbackOutcome;
  readonly outcome: RepairOutcome;
  readonly startedAt: EpochMillis;
  readonly completedAt?: EpochMillis;
}

export function makeRepairAttempt(input: {
  id: Uuid;
  tenantId: TenantId;
  integrityCaseId: Uuid;
  remediationPlanId: Uuid;
  planVersion: number;
  idempotencyKey: string;
  preservedOriginalEvidenceId: Uuid;
  expectedSourceRevision: string;
  actualSourceRevision?: string;
  appliedPolicyVersionId?: Uuid;
  decisionId?: Uuid;
  executorPrincipalId: Uuid;
  stepOutcomes?: readonly RepairStepOutcome[];
  derivedEvidenceId?: Uuid;
  sourceResponse?: Record<string, unknown>;
  killSwitchEngaged?: boolean;
  rollbackAttempted?: boolean;
  rollbackOutcome?: RollbackOutcome;
  outcome?: RepairOutcome;
  startedAt: EpochMillis;
  completedAt?: EpochMillis;
}): RepairAttempt {
  assertUuid(input.id, 'attempt.id');
  assertTenant(input.tenantId, 'attempt.tenantId');
  assertUuid(input.integrityCaseId, 'attempt.integrityCaseId');
  assertUuid(input.remediationPlanId, 'attempt.remediationPlanId');
  const planVersion = input.planVersion;
  if (!Number.isInteger(planVersion) || planVersion < 1) {
    throw new RangeError('attempt.planVersion must be ≥ 1');
  }
  // ONE idempotency identity (FR-027 shape): a replay carries the SAME key ⇒ SAME governed effect.
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length < 8) {
    throw new TypeError('attempt.idempotencyKey must be ≥ 8 chars');
  }
  assertUuid(input.preservedOriginalEvidenceId, 'attempt.preservedOriginalEvidenceId');
  assertNonEmpty(input.expectedSourceRevision, 'attempt.expectedSourceRevision');
  if (input.actualSourceRevision !== undefined) {
    assertNonEmpty(input.actualSourceRevision, 'attempt.actualSourceRevision');
  }
  if (input.appliedPolicyVersionId !== undefined) assertUuid(input.appliedPolicyVersionId, 'attempt.appliedPolicyVersionId');
  if (input.decisionId !== undefined) assertUuid(input.decisionId, 'attempt.decisionId');
  assertUuid(input.executorPrincipalId, 'attempt.executorPrincipalId');
  if (input.derivedEvidenceId !== undefined) assertUuid(input.derivedEvidenceId, 'attempt.derivedEvidenceId');
  const outcome = input.outcome ?? 'pending';
  assertMember(outcome, REPAIR_OUTCOMES, 'attempt.outcome');
  // FR-022: a VERIFIED outcome must produce a DERIVED item (provenance) — no derived, no verified.
  if (outcome === 'verified' && input.derivedEvidenceId === undefined) {
    throw new TypeError('a verified repair must carry a derivedEvidenceId (FR-022 provenance)');
  }
  if (input.rollbackOutcome !== undefined) assertMember(input.rollbackOutcome, ROLLBACK_OUTCOMES, 'attempt.rollbackOutcome');
  const steps = (input.stepOutcomes ?? []).map((s) => {
    assertNonEmpty(s.step, 'attempt.stepOutcomes[].step');
    assertMember(s.result, ['ok', 'skipped', 'stopped', 'failed'] as const, 'attempt.stepOutcomes[].result');
    return compact<RepairStepOutcome>({ step: s.step, result: s.result, detail: s.detail });
  });
  assertEpoch(input.startedAt, 'attempt.startedAt');
  if (input.completedAt !== undefined) assertEpoch(input.completedAt, 'attempt.completedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    integrityCaseId: input.integrityCaseId,
    remediationPlanId: input.remediationPlanId,
    planVersion,
    idempotencyKey: input.idempotencyKey,
    preservedOriginalEvidenceId: input.preservedOriginalEvidenceId,
    expectedSourceRevision: input.expectedSourceRevision,
    actualSourceRevision: input.actualSourceRevision,
    appliedPolicyVersionId: input.appliedPolicyVersionId,
    decisionId: input.decisionId,
    executorPrincipalId: input.executorPrincipalId,
    stepOutcomes: Object.freeze(steps),
    derivedEvidenceId: input.derivedEvidenceId,
    sourceResponse: frozenObj(input.sourceResponse),
    killSwitchEngaged: input.killSwitchEngaged ?? false,
    rollbackAttempted: input.rollbackAttempted ?? false,
    rollbackOutcome: input.rollbackOutcome,
    outcome,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

/** True iff this attempt's outcome leaves the case UNRESOLVED (retain quarantine + escalate). */
export function repairIsUnresolved(a: RepairAttempt): boolean {
  return UNRESOLVED_REPAIR_OUTCOMES.includes(a.outcome);
}

export function repairAttemptDigest(a: RepairAttempt): string {
  return sha256(
    JSON.stringify({
      id: a.id,
      tenantId: a.tenantId,
      integrityCaseId: a.integrityCaseId,
      remediationPlanId: a.remediationPlanId,
      planVersion: a.planVersion,
      idempotencyKey: a.idempotencyKey,
      preservedOriginalEvidenceId: a.preservedOriginalEvidenceId,
      expectedSourceRevision: a.expectedSourceRevision,
      actualSourceRevision: a.actualSourceRevision ?? null,
      appliedPolicyVersionId: a.appliedPolicyVersionId ?? null,
      decisionId: a.decisionId ?? null,
      executorPrincipalId: a.executorPrincipalId,
      stepOutcomes: a.stepOutcomes,
      derivedEvidenceId: a.derivedEvidenceId ?? null,
      sourceResponse: a.sourceResponse,
      killSwitchEngaged: a.killSwitchEngaged,
      rollbackAttempted: a.rollbackAttempted,
      rollbackOutcome: a.rollbackOutcome ?? null,
      outcome: a.outcome,
      startedAt: a.startedAt,
      completedAt: a.completedAt ?? null,
    }),
  );
}

// ===========================================================================
// 6. verification_record — the INDEPENDENT verification that decides the Verified
//    Closure Gate (FR-022). The nine gate conditions are enumerated here.
// ===========================================================================

export const VERIFICATION_SUBJECT_TYPES = [
  'work_item',
  'coverage_gap',
  'integrity_case',
  'finding',
  'incident',
  'exception',
  'repair',
  'rollback',
] as const;
export type VerificationSubjectType = (typeof VERIFICATION_SUBJECT_TYPES)[number];

export const VERIFICATION_TYPES = [
  'repair',
  'closure',
  'rollback',
  'migration',
  'control',
  'evidence',
] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

export const VERIFICATION_RESULTS = ['passed', 'failed', 'indeterminate'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

/**
 * The NINE Verified Closure Gate conditions (data-model.md "Verified Closure Gate"). A subject may
 * enter `closed` ONLY when every one holds. Kept as a closed, ordered union so a dropped gate is a
 * compile error, never a silent omission from the gate.
 */
export const CLOSURE_GATES = [
  'originals_and_derivatives_present', // 1. every original + derivative present + integrity-verified
  'rule_control_tests_pass', // 2. applicable rule/control tests pass against the current version
  'state_reconciled_no_uncertainty', // 3. desired ⇄ observed reconcile, no uncertain remote outcome
  'evidence_complete', // 4. decision, policy, repair/rollback, custody, audit evidence complete
  'no_unresolved_critical_dependency', // 5. no unresolved critical/high dependency blocks closure
  'residual_risk_zero_or_excepted', // 6. residual risk zero or covered by a current approved Exception
  'verifier_independent', // 7. verifier independent of the repairer/owner where policy requires
  'tenant_and_central_reviews_current', // 8. all tenant + central review gates current
  'closure_transition_audited', // 9. the closure transition + VerificationRecord commit with an AuditEvent
] as const;
export type ClosureGate = (typeof CLOSURE_GATES)[number];

export interface GateResult {
  readonly gate: ClosureGate;
  readonly result: VerificationResult;
  readonly detail?: string;
}

export interface VerificationRecord {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly subjectType: VerificationSubjectType;
  readonly subjectId: Uuid;
  readonly subjectVersion: number;
  readonly verificationType: VerificationType;
  readonly verifierPrincipalId: Uuid;
  readonly independenceCheckId: Uuid;
  readonly verifierIndependent: boolean;
  readonly ruleControlVersions: readonly string[];
  readonly evidenceManifestId: Uuid;
  readonly expectedState: Readonly<Record<string, unknown>>;
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly reconciliationId?: Uuid;
  readonly dependencyCheck: Readonly<Record<string, unknown>>;
  readonly residualRiskCheck: Readonly<Record<string, unknown>>;
  readonly gateResults: readonly GateResult[];
  readonly result: VerificationResult;
  readonly reason: Reason;
  readonly verifiedAt: EpochMillis;
}

export function makeVerificationRecord(input: {
  id: Uuid;
  tenantId: TenantId;
  subjectType: VerificationSubjectType;
  subjectId: Uuid;
  subjectVersion: number;
  verificationType?: VerificationType;
  verifierPrincipalId: Uuid;
  independenceCheckId: Uuid;
  verifierIndependent: boolean;
  ruleControlVersions?: readonly string[];
  evidenceManifestId: Uuid;
  expectedState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
  reconciliationId?: Uuid;
  dependencyCheck?: Record<string, unknown>;
  residualRiskCheck?: Record<string, unknown>;
  gateResults: readonly GateResult[];
  result: VerificationResult;
  reason: Reason;
  verifiedAt: EpochMillis;
}): VerificationRecord {
  assertUuid(input.id, 'verification.id');
  assertTenant(input.tenantId, 'verification.tenantId');
  assertMember(input.subjectType, VERIFICATION_SUBJECT_TYPES, 'verification.subjectType');
  assertUuid(input.subjectId, 'verification.subjectId');
  if (!Number.isInteger(input.subjectVersion) || input.subjectVersion < 1) {
    throw new RangeError('verification.subjectVersion must be ≥ 1');
  }
  const verificationType = input.verificationType ?? 'closure';
  assertMember(verificationType, VERIFICATION_TYPES, 'verification.verificationType');
  assertUuid(input.verifierPrincipalId, 'verification.verifierPrincipalId');
  assertUuid(input.independenceCheckId, 'verification.independenceCheckId');
  assertUuid(input.evidenceManifestId, 'verification.evidenceManifestId');
  if (input.reconciliationId !== undefined) assertUuid(input.reconciliationId, 'verification.reconciliationId');
  const gates = input.gateResults.map((g) => {
    assertMember(g.gate, CLOSURE_GATES, 'verification.gateResults[].gate');
    assertMember(g.result, VERIFICATION_RESULTS, 'verification.gateResults[].result');
    return compact<GateResult>({ gate: g.gate, result: g.result, detail: g.detail });
  });
  const result = input.result;
  assertMember(result, VERIFICATION_RESULTS, 'verification.result');
  assertNonEmpty(input.reason.code, 'verification.reason.code');
  assertNonEmpty(input.reason.text, 'verification.reason.text');
  // A PASSED verification requires an INDEPENDENT verifier and ALL NINE gates present + passing.
  if (result === 'passed') {
    if (!input.verifierIndependent) {
      throw new TypeError('a passed verification requires an independent verifier (gate 7)');
    }
    const passedGates = new Set(gates.filter((g) => g.result === 'passed').map((g) => g.gate));
    for (const g of CLOSURE_GATES) {
      if (!passedGates.has(g)) {
        throw new TypeError(`a passed verification requires gate '${g}' to pass (Verified Closure Gate)`);
      }
    }
  }
  assertEpoch(input.verifiedAt, 'verification.verifiedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectVersion: input.subjectVersion,
    verificationType,
    verifierPrincipalId: input.verifierPrincipalId,
    independenceCheckId: input.independenceCheckId,
    verifierIndependent: input.verifierIndependent,
    ruleControlVersions: Object.freeze([...(input.ruleControlVersions ?? [])]),
    evidenceManifestId: input.evidenceManifestId,
    expectedState: frozenObj(input.expectedState),
    observedState: frozenObj(input.observedState),
    reconciliationId: input.reconciliationId,
    dependencyCheck: frozenObj(input.dependencyCheck),
    residualRiskCheck: frozenObj(input.residualRiskCheck),
    gateResults: Object.freeze(gates),
    result,
    reason: { code: input.reason.code, text: input.reason.text },
    verifiedAt: input.verifiedAt,
  });
}

/**
 * The Verified Closure Gate oracle: evaluate the nine gate conditions plus the independence rule and
 * return the resulting verification result. `passed` iff EVERY gate passes AND the verifier is
 * independent; `failed` if any gate is `failed` or the verifier is not independent; otherwise
 * `indeterminate`. This is the executable form of the data-model gate — a source-reported `done` can
 * never satisfy it because it is a function of the checked gate results, not of a source value.
 */
export function verifiedClosureResult(input: {
  gateResults: readonly GateResult[];
  verifierIndependent: boolean;
}): VerificationResult {
  if (!input.verifierIndependent) return 'failed';
  const byGate = new Map<ClosureGate, VerificationResult>();
  for (const g of input.gateResults) byGate.set(g.gate, g.result);
  let anyFailed = false;
  let anyMissingOrIndeterminate = false;
  for (const gate of CLOSURE_GATES) {
    const r = byGate.get(gate);
    if (r === 'failed') anyFailed = true;
    else if (r !== 'passed') anyMissingOrIndeterminate = true;
  }
  if (anyFailed) return 'failed';
  if (anyMissingOrIndeterminate) return 'indeterminate';
  return 'passed';
}

export function verificationRecordDigest(v: VerificationRecord): string {
  return sha256(
    JSON.stringify({
      id: v.id,
      tenantId: v.tenantId,
      subjectType: v.subjectType,
      subjectId: v.subjectId,
      subjectVersion: v.subjectVersion,
      verificationType: v.verificationType,
      verifierPrincipalId: v.verifierPrincipalId,
      independenceCheckId: v.independenceCheckId,
      verifierIndependent: v.verifierIndependent,
      ruleControlVersions: [...v.ruleControlVersions].sort(),
      evidenceManifestId: v.evidenceManifestId,
      expectedState: v.expectedState,
      observedState: v.observedState,
      reconciliationId: v.reconciliationId ?? null,
      dependencyCheck: v.dependencyCheck,
      residualRiskCheck: v.residualRiskCheck,
      gateResults: v.gateResults,
      result: v.result,
      reason: v.reason,
      verifiedAt: v.verifiedAt,
    }),
  );
}
