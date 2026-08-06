// @trustcircle/domain — DECISION-PACKAGE, REQUIREMENT, RECORD, DELEGATION, and JOINT-PACKAGE
// aggregates (Phase 4 / User Story 2 — Make and Govern Human Decisions / FR-010..015).
//
// This module is the value-level, dependency-free (node:crypto only) form of the durable
// human-decision substrate authored in `db/migrations/0020_decisions.sql`. It is aligned
// column-for-column with that migration and with the governance-api `DecisionRequest`,
// `DecisionRequirement`, `DecisionRecord`, and `Delegation` schemas, so a projection over the
// physical rows, an in-memory aggregate, and an API response share ONE vocabulary and ONE set of
// invariants.
//
// Each aggregate is constructed through an ASSERTING factory that refuses a write violating a
// fail-visible CHECK from the migration, and exposes a `*Digest` sha256 content-hash as an
// independently-observable durable-effect witness (the mutation response is never the proof; the
// re-readable digest is). The digest is also the `package_digest` an approver's decision binds to
// (AC1/AC2/FR-012): if any facet of the package changes, the digest changes, so a decision taken
// against a superseded package is detectable.
//
// The aggregates here are pure data + invariants. Authority, separation-of-duties, and delegation
// lineage are NOT decided here — those verdicts come from @trustcircle/authz (the single source of
// truth) and are threaded into the application-layer services. This module only owns the SHAPE and
// the fail-visible field vocabularies.

import { createHash } from 'node:crypto';
import {
  isUuid,
  type Uuid,
  type EpochMillis,
  type TenantId,
  type Reason,
  isConsequentialReason,
} from './primitives.ts';

// ---------------------------------------------------------------------------
// Shared assert helpers (mirror inventory.ts: fail-visible, throw on violation).
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

function assertReason(r: unknown, label: string): asserts r is Reason {
  if (!isConsequentialReason(r)) throw new TypeError(`${label} must be a consequential reason`);
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

// ===========================================================================
// 1. Risk / action vocabularies shared by the queue and the package.
// ===========================================================================

export const DECISION_RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
export type DecisionRiskTier = (typeof DECISION_RISK_TIERS)[number];

/** The seven decision verbs (AC2 transition alphabet — matches the OpenAPI `action` enum). */
export const DECISION_ACTIONS = [
  'approve',
  'deny',
  'delegate',
  'request_changes',
  'escalate',
  'expire',
  'cancel',
] as const;
export type DecisionActionVerb = (typeof DECISION_ACTIONS)[number];

/** Decision-request lifecycle status (mirrors decision_request_status_valid). */
export const DECISION_STATUSES = [
  'pending',
  'in_review',
  'approved',
  'denied',
  'changes_requested',
  'escalated',
  'delegated',
  'expired',
  'cancelled',
  'invalidated',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Statuses at which a decision package is CLOSED — no further action may be taken. */
export const TERMINAL_DECISION_STATUSES: readonly DecisionStatus[] = [
  'approved',
  'denied',
  'expired',
  'cancelled',
];

export function isTerminalDecisionStatus(s: DecisionStatus): boolean {
  return TERMINAL_DECISION_STATUSES.includes(s);
}

// ===========================================================================
// 2. decision_requirement — a GATE that must be satisfied before a decision can
//    be finally accepted. Mirrors table `decision_requirement` and the API
//    DecisionRequirement schema. A NULL tenantId is a NON-WAIVABLE central guardrail.
// ===========================================================================

export const REQUIREMENT_GATE_TYPES = [
  'separation_of_duties',
  'tenant_approval',
  'central_guardrail',
  'central_review',
  'admin_authority',
] as const;
export type RequirementGateType = (typeof REQUIREMENT_GATE_TYPES)[number];

export const REQUIREMENT_STATUSES = ['pending', 'satisfied', 'failed', 'waived_forbidden'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface DecisionRequirement {
  readonly id: Uuid;
  readonly gateType: RequirementGateType;
  /** null ⇒ non-waivable central guardrail; a UUID ⇒ a specific affected tenant's gate. */
  readonly tenantId: Uuid | null;
  readonly status: RequirementStatus;
  readonly minimumDistinctPrincipals: number;
  readonly incompatibleRelationships: readonly string[];
  readonly satisfiedByPrincipalId?: Uuid;
  readonly satisfiedAt?: EpochMillis;
}

export function makeDecisionRequirement(input: {
  id: Uuid;
  gateType: RequirementGateType;
  tenantId: Uuid | null;
  status?: RequirementStatus;
  minimumDistinctPrincipals?: number;
  incompatibleRelationships?: readonly string[];
  satisfiedByPrincipalId?: Uuid;
  satisfiedAt?: EpochMillis;
}): DecisionRequirement {
  assertUuid(input.id, 'requirement.id');
  assertMember(input.gateType, REQUIREMENT_GATE_TYPES, 'requirement.gateType');
  if (input.tenantId !== null) assertUuid(input.tenantId, 'requirement.tenantId');
  const status = input.status ?? 'pending';
  assertMember(status, REQUIREMENT_STATUSES, 'requirement.status');
  const min = input.minimumDistinctPrincipals ?? 1;
  if (!Number.isInteger(min) || min < 1) {
    throw new RangeError('requirement.minimumDistinctPrincipals must be ≥ 1');
  }
  const rels = input.incompatibleRelationships ?? [];
  for (const r of rels) assertNonEmpty(r, 'requirement.incompatibleRelationships entry');
  if (input.satisfiedByPrincipalId !== undefined) {
    assertUuid(input.satisfiedByPrincipalId, 'requirement.satisfiedByPrincipalId');
  }
  if (input.satisfiedAt !== undefined) assertEpoch(input.satisfiedAt, 'requirement.satisfiedAt');
  return compact({
    id: input.id,
    gateType: input.gateType,
    tenantId: input.tenantId,
    status,
    minimumDistinctPrincipals: min,
    incompatibleRelationships: Object.freeze([...rels]),
    satisfiedByPrincipalId: input.satisfiedByPrincipalId,
    satisfiedAt: input.satisfiedAt,
  });
}

/** True iff this requirement is a non-waivable central guardrail (tenantId === null). */
export function isCentralGuardrail(r: DecisionRequirement): boolean {
  return r.tenantId === null;
}

// ===========================================================================
// 3. decision_request — the DECISION PACKAGE (AC1). Aligned 1:1 with the API
//    DecisionRequest schema. Carries every facet the approver must see; a package
//    with an incomplete facet is not reviewable.
// ===========================================================================

export interface DecisionPackage {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly workItemId: Uuid;
  readonly requesterPrincipalId: Uuid;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: DecisionRiskTier;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly businessImpact: Readonly<Record<string, unknown>>;
  readonly risks: readonly Readonly<Record<string, unknown>>[];
  readonly alternatives: readonly Readonly<Record<string, unknown>>[];
  readonly expectedResult: Readonly<Record<string, unknown>>;
  readonly evidenceManifestId?: Uuid;
  readonly simulationId?: Uuid;
  readonly policyRevision?: string;
  readonly controlVersion?: string;
  readonly affectedTenantIds: readonly Uuid[];
  readonly requirements: readonly DecisionRequirement[];
  readonly status: DecisionStatus;
  readonly version: number;
  readonly invalidationReason?: string;
  readonly invalidatedAt?: EpochMillis;
  readonly createdAt: EpochMillis;
  readonly expiresAt: EpochMillis;
}

function assertRecordArray(
  xs: unknown,
  label: string,
): asserts xs is readonly Record<string, unknown>[] {
  if (!Array.isArray(xs)) throw new TypeError(`${label} must be an array`);
  for (const x of xs) {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) {
      throw new TypeError(`${label} entries must be objects`);
    }
  }
}

export function makeDecisionPackage(input: {
  id: Uuid;
  tenantId: TenantId;
  workItemId: Uuid;
  requesterPrincipalId: Uuid;
  requestedAction: string;
  actionClass: string;
  riskTier?: DecisionRiskTier;
  scope: Record<string, unknown>;
  businessImpact: Record<string, unknown>;
  risks: readonly Record<string, unknown>[];
  alternatives: readonly Record<string, unknown>[];
  expectedResult: Record<string, unknown>;
  evidenceManifestId?: Uuid;
  simulationId?: Uuid;
  policyRevision?: string;
  controlVersion?: string;
  affectedTenantIds?: readonly Uuid[];
  requirements?: readonly DecisionRequirement[];
  status?: DecisionStatus;
  version?: number;
  invalidationReason?: string;
  invalidatedAt?: EpochMillis;
  createdAt: EpochMillis;
  expiresAt: EpochMillis;
}): DecisionPackage {
  assertUuid(input.id, 'decision.id');
  assertTenant(input.tenantId, 'decision.tenantId');
  assertUuid(input.workItemId, 'decision.workItemId');
  assertUuid(input.requesterPrincipalId, 'decision.requesterPrincipalId');
  assertNonEmpty(input.requestedAction, 'decision.requestedAction');
  assertNonEmpty(input.actionClass, 'decision.actionClass');
  const riskTier = input.riskTier ?? 'medium';
  assertMember(riskTier, DECISION_RISK_TIERS, 'decision.riskTier');
  // AC1: every completeness facet must be present and non-vacuous.
  assertRecordArray(input.risks, 'decision.risks');
  assertRecordArray(input.alternatives, 'decision.alternatives');
  if (input.risks.length === 0) throw new TypeError('decision.risks must be non-empty (AC1)');
  if (input.alternatives.length === 0) {
    throw new TypeError('decision.alternatives must be non-empty (AC1)');
  }
  const affected = input.affectedTenantIds ?? [];
  for (const t of affected) assertUuid(t, 'decision.affectedTenantIds entry');
  const requirements = input.requirements ?? [];
  const status = input.status ?? 'pending';
  assertMember(status, DECISION_STATUSES, 'decision.status');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError('decision.version must be ≥ 1');
  }
  // AC4: an invalidated package MUST carry both reason and instant (decision_request_invalidation_paired).
  if (status === 'invalidated') {
    assertNonEmpty(input.invalidationReason, 'decision.invalidationReason');
    assertEpoch(input.invalidatedAt, 'decision.invalidatedAt');
  }
  if (input.evidenceManifestId !== undefined) {
    assertUuid(input.evidenceManifestId, 'decision.evidenceManifestId');
  }
  if (input.simulationId !== undefined) assertUuid(input.simulationId, 'decision.simulationId');
  assertEpoch(input.createdAt, 'decision.createdAt');
  assertEpoch(input.expiresAt, 'decision.expiresAt');
  if (input.expiresAt <= input.createdAt) {
    throw new RangeError('decision.expiresAt must be after createdAt');
  }
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    workItemId: input.workItemId,
    requesterPrincipalId: input.requesterPrincipalId,
    requestedAction: input.requestedAction,
    actionClass: input.actionClass,
    riskTier,
    scope: Object.freeze({ ...input.scope }),
    businessImpact: Object.freeze({ ...input.businessImpact }),
    risks: Object.freeze(input.risks.map((r) => Object.freeze({ ...r }))),
    alternatives: Object.freeze(input.alternatives.map((a) => Object.freeze({ ...a }))),
    expectedResult: Object.freeze({ ...input.expectedResult }),
    evidenceManifestId: input.evidenceManifestId,
    simulationId: input.simulationId,
    policyRevision: input.policyRevision,
    controlVersion: input.controlVersion,
    affectedTenantIds: Object.freeze([...affected]),
    requirements: Object.freeze([...requirements]),
    status,
    version,
    invalidationReason: input.invalidationReason,
    invalidatedAt: input.invalidatedAt,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

/** AC1 completeness oracle: the twelve facets an approver must see, all non-vacuous. */
export function isDecisionPackageComplete(p: DecisionPackage): boolean {
  return (
    p.requestedAction.trim().length > 0 &&
    p.actionClass.trim().length > 0 &&
    Object.keys(p.scope).length > 0 &&
    Object.keys(p.businessImpact).length > 0 &&
    p.risks.length > 0 &&
    p.alternatives.length > 0 &&
    Object.keys(p.expectedResult).length > 0 &&
    isUuid(p.requesterPrincipalId) &&
    p.expiresAt > p.createdAt
  );
}

/** True iff the decision package has materially expired at `now` (AC2 expire / SC-005). */
export function decisionIsExpired(p: DecisionPackage, now: EpochMillis): boolean {
  return now >= p.expiresAt;
}

/**
 * The `package_digest` a decision binds to (AC2/AC4/FR-012). It covers every material facet, the
 * requirement set, and the version, so any material change (scope, evidence, policy/control
 * version, requirements, impact) changes the digest — the invalidation oracle. Requirements are
 * digested by id+status so a satisfied gate is distinguishable from a pending one.
 */
export function decisionPackageDigest(p: DecisionPackage): string {
  return sha256(
    JSON.stringify({
      id: p.id,
      tenantId: p.tenantId,
      workItemId: p.workItemId,
      requesterPrincipalId: p.requesterPrincipalId,
      requestedAction: p.requestedAction,
      actionClass: p.actionClass,
      riskTier: p.riskTier,
      scope: p.scope,
      businessImpact: p.businessImpact,
      risks: p.risks,
      alternatives: p.alternatives,
      expectedResult: p.expectedResult,
      evidenceManifestId: p.evidenceManifestId ?? null,
      simulationId: p.simulationId ?? null,
      policyRevision: p.policyRevision ?? null,
      controlVersion: p.controlVersion ?? null,
      affectedTenantIds: [...p.affectedTenantIds].sort(),
      requirements: p.requirements.map((r) => ({
        id: r.id,
        gateType: r.gateType,
        tenantId: r.tenantId,
        status: r.status,
        minimumDistinctPrincipals: r.minimumDistinctPrincipals,
      })),
      status: p.status,
      version: p.version,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    }),
  );
}

// ===========================================================================
// 4. decision_record — the ATTRIBUTABLE outcome of a decision ATTEMPT (accepted
//    OR rejected). Mirrors table `decision_record` + the API DecisionRecord schema.
//    A rejected attempt (AC3) carries a rejectionCode; both accepted and rejected
//    attempts carry a mandatory reason and an audit_event_id (non-repudiation).
// ===========================================================================

export const DECISION_OUTCOME_STATUSES = ['accepted', 'rejected'] as const;
export type DecisionOutcomeStatus = (typeof DECISION_OUTCOME_STATUSES)[number];

export interface DecisionRecord {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly decisionId: Uuid;
  readonly actorPrincipalId: Uuid;
  readonly authorityAssignmentId?: Uuid;
  readonly action: DecisionActionVerb;
  readonly reason: Reason;
  readonly status: DecisionOutcomeStatus;
  readonly rejectionCode?: string;
  readonly packageDigest: string;
  readonly decidedAt: EpochMillis;
  readonly auditEventId: Uuid;
}

export function makeDecisionRecord(input: {
  id: Uuid;
  tenantId: TenantId;
  decisionId: Uuid;
  actorPrincipalId: Uuid;
  authorityAssignmentId?: Uuid;
  action: DecisionActionVerb;
  reason: Reason;
  status: DecisionOutcomeStatus;
  rejectionCode?: string;
  packageDigest: string;
  decidedAt: EpochMillis;
  auditEventId: Uuid;
}): DecisionRecord {
  assertUuid(input.id, 'record.id');
  assertTenant(input.tenantId, 'record.tenantId');
  assertUuid(input.decisionId, 'record.decisionId');
  assertUuid(input.actorPrincipalId, 'record.actorPrincipalId');
  if (input.authorityAssignmentId !== undefined) {
    assertUuid(input.authorityAssignmentId, 'record.authorityAssignmentId');
  }
  assertMember(input.action, DECISION_ACTIONS, 'record.action');
  assertReason(input.reason, 'record.reason'); // reason capture is MANDATORY (AC2/AC3)
  assertMember(input.status, DECISION_OUTCOME_STATUSES, 'record.status');
  if (input.status === 'rejected') {
    assertNonEmpty(input.rejectionCode, 'record.rejectionCode'); // AC3: a refusal names why
  }
  assertNonEmpty(input.packageDigest, 'record.packageDigest');
  assertEpoch(input.decidedAt, 'record.decidedAt');
  assertUuid(input.auditEventId, 'record.auditEventId'); // non-repudiation
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    decisionId: input.decisionId,
    actorPrincipalId: input.actorPrincipalId,
    authorityAssignmentId: input.authorityAssignmentId,
    action: input.action,
    reason: input.reason,
    status: input.status,
    rejectionCode: input.rejectionCode,
    packageDigest: input.packageDigest,
    decidedAt: input.decidedAt,
    auditEventId: input.auditEventId,
  });
}

export function decisionRecordDigest(r: DecisionRecord): string {
  return sha256(
    JSON.stringify({
      id: r.id,
      tenantId: r.tenantId,
      decisionId: r.decisionId,
      actorPrincipalId: r.actorPrincipalId,
      authorityAssignmentId: r.authorityAssignmentId ?? null,
      action: r.action,
      reason: { code: r.reason.code, text: r.reason.text },
      status: r.status,
      rejectionCode: r.rejectionCode ?? null,
      packageDigest: r.packageDigest,
      decidedAt: r.decidedAt,
      auditEventId: r.auditEventId,
    }),
  );
}

// ===========================================================================
// 5. joint_decision_package — the FEDERATED cross-tenant approval envelope (AC6).
//    Mirrors table `joint_decision_package`. The central_state advances only when
//    every affected tenant has a current approval AND a distinct central reviewer
//    has approved. The aggregate owns the SHAPE; the guardrail/distinctness verdict
//    comes from @trustcircle/authz.
// ===========================================================================

export const JOINT_CENTRAL_STATES = [
  'collecting',
  'central_review',
  'approved',
  'revoked',
  'denied',
] as const;
export type JointCentralState = (typeof JOINT_CENTRAL_STATES)[number];

export interface JointDecisionPackage {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly decisionId: Uuid;
  readonly affectedTenantIds: readonly Uuid[];
  readonly centralReviewerPrincipalId?: Uuid;
  readonly packageDigest: string;
  readonly centralState: JointCentralState;
  readonly createdAt: EpochMillis;
  readonly updatedAt: EpochMillis;
  readonly revokedAt?: EpochMillis;
}

export function makeJointDecisionPackage(input: {
  id: Uuid;
  tenantId: TenantId;
  decisionId: Uuid;
  affectedTenantIds: readonly Uuid[];
  centralReviewerPrincipalId?: Uuid;
  packageDigest: string;
  centralState?: JointCentralState;
  createdAt: EpochMillis;
  updatedAt: EpochMillis;
  revokedAt?: EpochMillis;
}): JointDecisionPackage {
  assertUuid(input.id, 'joint.id');
  assertTenant(input.tenantId, 'joint.tenantId');
  assertUuid(input.decisionId, 'joint.decisionId');
  if (input.affectedTenantIds.length === 0) {
    throw new TypeError('joint.affectedTenantIds must be non-empty (AC6)');
  }
  for (const t of input.affectedTenantIds) assertUuid(t, 'joint.affectedTenantIds entry');
  if (input.centralReviewerPrincipalId !== undefined) {
    assertUuid(input.centralReviewerPrincipalId, 'joint.centralReviewerPrincipalId');
  }
  assertNonEmpty(input.packageDigest, 'joint.packageDigest');
  const centralState = input.centralState ?? 'collecting';
  assertMember(centralState, JOINT_CENTRAL_STATES, 'joint.centralState');
  assertEpoch(input.createdAt, 'joint.createdAt');
  assertEpoch(input.updatedAt, 'joint.updatedAt');
  if (input.revokedAt !== undefined) assertEpoch(input.revokedAt, 'joint.revokedAt');
  return compact({
    id: input.id,
    tenantId: input.tenantId,
    decisionId: input.decisionId,
    affectedTenantIds: Object.freeze([...input.affectedTenantIds].sort()),
    centralReviewerPrincipalId: input.centralReviewerPrincipalId,
    packageDigest: input.packageDigest,
    centralState,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    revokedAt: input.revokedAt,
  });
}

export function jointDecisionPackageDigest(j: JointDecisionPackage): string {
  return sha256(
    JSON.stringify({
      id: j.id,
      tenantId: j.tenantId,
      decisionId: j.decisionId,
      affectedTenantIds: [...j.affectedTenantIds].sort(),
      centralReviewerPrincipalId: j.centralReviewerPrincipalId ?? null,
      packageDigest: j.packageDigest,
      centralState: j.centralState,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      revokedAt: j.revokedAt ?? null,
    }),
  );
}
