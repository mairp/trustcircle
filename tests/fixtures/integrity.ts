// Test fixtures — a deterministic, multi-scenario INTEGRITY / REMEDIATION projection for Phase 5 /
// User Story 3 (Contain and Repair Damaged Work Safely). Seeds every damaged-work shape the integrity
// routes, the accessible web surfaces (IntegrityQueue / EvidenceComparison / RemediationDetail), and
// the acceptance runners consume — plus the domain aggregates + worker inputs the containment / repair
// flows govern.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FIXTURE EXISTS  (T148 — FR-016..022, GAR-004, SC-006..009)
// ───────────────────────────────────────────────────────────────────────────────────────────
// The e2e integrity-remediation scenarios (tests/e2e/scenarios/integrity-remediation.ts) and the
// DOM spec mount the REAL web renderers over a KNOWN, FIXED projection and assert genuine facets —
// never a mutation echo. This builder is that fixed projection. Every seeded case maps to an
// acceptance obligation the containment / repair surface must satisfy, and each carries an
// `observedVia` naming the exact durable read path an assertion pins, so no assertion is vacuous.
//
// The SIX seeded integrity scenarios:
//   1. DETECTED-PRESERVED  — a corrupted derivative detected; the ORIGINAL was preserved BEFORE any
//                            repair (FR-017). The comparison shows the original intact.
//   2. QUARANTINED         — a high-safety-impact case whose damaged effect is CONTAINED by an active
//                            quarantine blocking downstream use (FR-019); still inspectable.
//   3. AUTO-REPAIRABLE     — a low-risk, non-destructive, policy-bound plan eligible for pre-authorized
//                            automatic repair (GAR-004); its attempt is succeeded_unverified (NOT closed).
//   4. NEEDS-APPROVAL      — a destructive/high-risk plan that must NOT auto-execute; execute is gated.
//   5. VERIFIED-CLOSED     — a case whose independent nine-gate verification PASSED → verified-closed
//                            (FR-022). The only scenario a presenter may show as closed.
//   6. UNRESOLVED-ESCALATED— an ownership-gap / rollback-failed case that is NOT auto-resolvable and is
//                            escalated for human attention (FR-018/FR-022).
//
// DETERMINISM. No wall clock, no I/O. The clock is the fixed `NOW`; ids come from readable slugs
// sha256'd into valid v7-shaped UUIDs, so the whole projection — including id tails — is byte-identical
// every call. Same input ⇒ same output.

import { createHash } from 'node:crypto';

import {
  makeIntegrityCase,
  makeQuarantine,
  makeRemediationPlan,
  makeVerificationRecord,
  verifiedClosureResult,
  toUuid,
  makeReason,
  CLOSURE_GATES,
  type Uuid,
  type TenantId,
  type EpochMillis,
  type IntegrityCase,
  type Quarantine,
  type RemediationPlan,
  type VerificationRecord,
  type GateResult,
  type ClosureGate,
} from '@trustcircle/domain';

// The view-model shapes the shipped web renderers consume — imported TYPE-ONLY so the fixture stays
// in lock-step with the exact surfaces under test and never drifts from what the renderer reads.
import type {
  IntegrityQueueModel,
  IntegrityQueueRowVM,
  IntegrityFilterChipVM,
} from '../../apps/web/src/features/integrity/IntegrityQueue.tsx';
import type { EvidenceComparisonModel } from '../../apps/web/src/features/integrity/EvidenceComparison.tsx';
import type {
  RemediationDetailModel,
  RemediationStepVM,
} from '../../apps/web/src/features/integrity/RemediationDetail.tsx';
import type { TenantScope } from '../../apps/web/src/app/layout.tsx';

// ── Fixed clock & identity ──────────────────────────────────────────────────────────────────────

/** The single fixed "now" every seeded deadline is measured against — distinct from the other
 *  fixtures' NOW so a mixed run cannot alias projections. */
export const NOW: EpochMillis = 1_772_070_000_000 as EpochMillis;

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

/** A deterministic, legible-in-source UUID derived from a readable slug (v7-shaped, valid). */
export function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`integrity-fixture:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

// ── Stable principals & tenant ────────────────────────────────────────────────────────────────────

export const TENANT: TenantId = uuidFromSlug('tenant-home-integrity') as unknown as TenantId;

export const REVIEWER: Uuid = uuidFromSlug('principal-remediation-reviewer');
export const REPAIRER: Uuid = uuidFromSlug('principal-repairer');
export const INDEPENDENT_VERIFIER: Uuid = uuidFromSlug('principal-independent-verifier');
export const POLICY_VERSION: Uuid = uuidFromSlug('policy-version-low-risk-repair');
export const APPROVAL_DECISION: Uuid = uuidFromSlug('decision-approve-remediation');

export const TENANT_SCOPE: TenantScope = {
  tenantId: String(TENANT),
  tenantName: 'Home Tenant',
  bundleId: 'bundle-integrity-001',
  semanticHash: 'sha256:integrity-fixture-bundle',
  workItemId: String(uuidFromSlug('work-item-scope')),
  generatedAt: iso(NOW),
};

// ── The seeded scenario catalogue (each maps to an acceptance obligation) ─────────────────────────

export type IntegrityScenarioName =
  | 'detected_preserved'
  | 'quarantined'
  | 'auto_repairable'
  | 'needs_approval'
  | 'verified_closed'
  | 'unresolved_escalated';

/** A named seeded integrity scenario + the durable read path an assertion witnesses it through. */
export interface IntegrityScenarioSpec {
  readonly scenario: IntegrityScenarioName;
  readonly title: string;
  readonly observedVia: string;
  readonly case: IntegrityCase;
  readonly quarantine: Quarantine | null;
  readonly plan: RemediationPlan | null;
  readonly verification: VerificationRecord | null;
}

const REASON = (code: string, text: string) => makeReason(code, text);

function caseFor(
  scenario: IntegrityScenarioName,
  overrides: Record<string, unknown>,
): IntegrityCase {
  return makeIntegrityCase({
    id: uuidFromSlug(`case-${scenario}`),
    tenantId: TENANT,
    workItemId: uuidFromSlug(`work-item-${scenario}`),
    ruleVersionId: uuidFromSlug(`rule-version-${scenario}`),
    sourceRecordId: uuidFromSlug(`source-record-${scenario}`),
    originalEvidenceId: uuidFromSlug(`original-evidence-${scenario}`),
    problemClass: 'corrupted',
    confidence: 0.92,
    detectedAt: NOW - 2 * ONE_HOUR,
    updatedAt: NOW - ONE_HOUR,
    ...overrides,
  });
}

function activeQuarantine(scenario: IntegrityScenarioName): Quarantine {
  return makeQuarantine({
    id: uuidFromSlug(`quarantine-${scenario}`),
    tenantId: TENANT,
    integrityCaseId: uuidFromSlug(`case-${scenario}`),
    blockedCapabilities: ['governed_publish', 'downstream_consume'],
    blockedDependencyIds: [uuidFromSlug(`dependent-${scenario}-1`)],
    reason: REASON('quarantine_containment', 'contain the corrupted derivative pending repair'),
    originalEvidenceId: uuidFromSlug(`original-evidence-${scenario}`),
    reviewCadenceMs: ONE_DAY,
    reviewDueAt: (NOW + ONE_DAY) as EpochMillis,
    startedAt: (NOW - ONE_HOUR) as EpochMillis,
  });
}

function lowRiskPlan(scenario: IntegrityScenarioName): RemediationPlan {
  return makeRemediationPlan({
    id: uuidFromSlug(`plan-${scenario}`),
    tenantId: TENANT,
    integrityCaseId: uuidFromSlug(`case-${scenario}`),
    rationale: 'restore the deterministic derivative from the preserved original',
    ownerPrincipalId: REVIEWER,
    riskClass: 'low',
    destructive: false,
    authorizationMode: 'pre_authorized_low_risk',
    policyVersionId: POLICY_VERSION,
    proposedChange: { op: 'restore_derivative', from: 'original' },
    expectedResult: { derivative_matches_original: true },
    preconditions: [{ check: 'original_preserved' }],
    evidencePlan: { capture: ['before', 'after'] },
    verificationPlan: { gates: 'all_nine' },
    stopConditions: [{ on: 'unexpected_write' }],
    rollbackPlan: { restore: 'checkpoint' },
    approvalDecisionId: APPROVAL_DECISION,
    status: 'approved',
    expiresAt: (NOW + 6 * ONE_HOUR) as EpochMillis,
    createdAt: (NOW - ONE_HOUR) as EpochMillis,
  });
}

function destructivePlan(scenario: IntegrityScenarioName): RemediationPlan {
  return makeRemediationPlan({
    id: uuidFromSlug(`plan-${scenario}`),
    tenantId: TENANT,
    integrityCaseId: uuidFromSlug(`case-${scenario}`),
    rationale: 'rebuild the record set from scratch — destructive, requires human approval',
    ownerPrincipalId: REVIEWER,
    riskClass: 'high',
    destructive: true,
    authorizationMode: 'human',
    proposedChange: { op: 'rebuild', drop: true },
    expectedResult: { rebuilt: true },
    preconditions: [{ check: 'human_approval' }],
    evidencePlan: { capture: ['before', 'after'] },
    verificationPlan: { gates: 'all_nine' },
    stopConditions: [{ on: 'any_write_failure' }],
    rollbackPlan: { restore: 'checkpoint' },
    status: 'pending_approval',
    expiresAt: (NOW + 6 * ONE_HOUR) as EpochMillis,
    createdAt: (NOW - ONE_HOUR) as EpochMillis,
  });
}

/** The nine gate results, all passing — the ONLY input that yields a verified closure. */
export const ALL_GATES_PASSING: readonly GateResult[] = CLOSURE_GATES.map((gate: ClosureGate) => ({
  gate,
  result: 'passed' as const,
}));

function passingVerification(scenario: IntegrityScenarioName): VerificationRecord {
  return makeVerificationRecord({
    id: uuidFromSlug(`verification-${scenario}`),
    tenantId: TENANT,
    subjectType: 'integrity_case',
    subjectId: uuidFromSlug(`case-${scenario}`),
    subjectVersion: 4,
    verifierPrincipalId: INDEPENDENT_VERIFIER,
    independenceCheckId: uuidFromSlug(`independence-${scenario}`),
    verifierIndependent: true,
    evidenceManifestId: uuidFromSlug(`manifest-${scenario}`),
    ruleControlVersions: ['rule@1', 'control@1'],
    gateResults: ALL_GATES_PASSING,
    result: 'passed',
    reason: REASON('verify_closure', 'independent nine-gate verification of the repair passed'),
    verifiedAt: (NOW - 10 * ONE_MINUTE) as EpochMillis,
  });
}

/** Build the complete, deterministic, fixed integrity projection (all six scenarios). */
export function seedIntegrity(): readonly IntegrityScenarioSpec[] {
  const detectedPreserved: IntegrityScenarioSpec = {
    scenario: 'detected_preserved',
    title: 'Corrupted derivative detected — original preserved before any repair',
    observedVia: 'integrity_case.original_evidence_id + evidence comparison intact verdict',
    case: caseFor('detected_preserved', {
      state: 'preserved',
      ownerPrincipalId: REVIEWER,
      severity: 'medium',
      safetyImpact: 'low',
    }),
    quarantine: null,
    plan: null,
    verification: null,
  };

  const quarantined: IntegrityScenarioSpec = {
    scenario: 'quarantined',
    title: 'High-safety-impact case contained by an active quarantine',
    observedVia: 'quarantine.blockedCapabilities via quarantineBlocks()',
    case: caseFor('quarantined', {
      state: 'quarantined',
      ownerPrincipalId: REVIEWER,
      severity: 'high',
      safetyImpact: 'high',
      quarantineId: uuidFromSlug('quarantine-quarantined'),
      dependentWorkIds: [
        uuidFromSlug('dependent-quarantined-1'),
        uuidFromSlug('dependent-quarantined-2'),
      ],
    }),
    quarantine: activeQuarantine('quarantined'),
    plan: null,
    verification: null,
  };

  const autoRepairable: IntegrityScenarioSpec = {
    scenario: 'auto_repairable',
    title: 'Low-risk, policy-bound plan eligible for pre-authorized automatic repair',
    observedVia:
      'remediation_plan.authorizationMode=pre_authorized_low_risk via isAutomaticEligible()',
    case: caseFor('auto_repairable', {
      state: 'remediation_proposed',
      ownerPrincipalId: REVIEWER,
      severity: 'medium',
      safetyImpact: 'low',
      activeRemediationPlanId: uuidFromSlug('plan-auto_repairable'),
    }),
    quarantine: activeQuarantine('auto_repairable'),
    plan: lowRiskPlan('auto_repairable'),
    verification: null,
  };

  const needsApproval: IntegrityScenarioSpec = {
    scenario: 'needs_approval',
    title: 'Destructive plan that must not auto-execute — execute is gated',
    observedVia: 'remediation_plan.destructive=true → isAutomaticEligible()=false',
    case: caseFor('needs_approval', {
      state: 'remediation_proposed',
      ownerPrincipalId: REVIEWER,
      severity: 'critical',
      safetyImpact: 'moderate',
      activeRemediationPlanId: uuidFromSlug('plan-needs_approval'),
    }),
    quarantine: activeQuarantine('needs_approval'),
    plan: destructivePlan('needs_approval'),
    verification: null,
  };

  const verifiedClosed: IntegrityScenarioSpec = {
    scenario: 'verified_closed',
    title: 'Case closed only by an independent nine-gate verification pass',
    observedVia: 'verification_record.result=passed via verifiedClosureResult()',
    case: caseFor('verified_closed', {
      state: 'closed',
      ownerPrincipalId: REVIEWER,
      severity: 'medium',
      safetyImpact: 'low',
      resolutionVerificationId: uuidFromSlug('verification-verified_closed'),
    }),
    quarantine: null,
    plan: lowRiskPlan('verified_closed'),
    verification: passingVerification('verified_closed'),
  };

  const unresolvedEscalated: IntegrityScenarioSpec = {
    scenario: 'unresolved_escalated',
    title: 'Ownership-gap / rollback-failed case escalated for human attention',
    observedVia: 'integrity_case.ownershipGap=true + state=escalated',
    case: caseFor('unresolved_escalated', {
      state: 'escalated',
      ownerPrincipalId: null,
      ownershipGap: true,
      severity: 'high',
      safetyImpact: 'high',
    }),
    quarantine: activeQuarantine('unresolved_escalated'),
    plan: null,
    verification: null,
  };

  return [
    detectedPreserved,
    quarantined,
    autoRepairable,
    needsApproval,
    verifiedClosed,
    unresolvedEscalated,
  ];
}

// ── Web view models (byte-identical presenter inputs) ────────────────────────────────────────────

const PRIORITY: Record<IntegrityScenarioName, number> = {
  unresolved_escalated: 100,
  quarantined: 90,
  needs_approval: 80,
  auto_repairable: 60,
  detected_preserved: 40,
  verified_closed: 10,
};

function rowFor(spec: IntegrityScenarioSpec): IntegrityQueueRowVM {
  const k = spec.case;
  const verified = spec.verification?.result === 'passed';
  const closureRealized = verified && k.state === 'closed';
  const closureBlocked = closureRealized
    ? []
    : verified
      ? ['closure transition not yet recorded']
      : ['independent verification not passed'];
  const needsAttention = k.ownershipGap || k.state === 'escalated' || k.state === 'unresolved';
  const blocked = spec.quarantine?.blockedCapabilities ?? [];
  const searchIndex =
    `${spec.scenario} ${k.problemClass} ${k.severity} ${k.safetyImpact} ${k.state} ${spec.title}`.toLowerCase();
  return {
    caseId: String(k.id),
    workItemId: String(k.workItemId),
    problemClass: k.problemClass,
    problemClasses: [...k.problemClasses],
    severity: k.severity,
    safetyImpact: k.safetyImpact,
    state: k.state,
    ownerPrincipalId: k.ownerPrincipalId ? String(k.ownerPrincipalId) : '',
    ownershipGap: k.ownershipGap,
    quarantineActive: spec.quarantine !== null && spec.quarantine.status === 'active',
    blockedCapabilities: [...blocked],
    dependentCount: k.dependentWorkIds.length,
    verified,
    closureRealized,
    closureBlocked,
    needsHumanAttention: needsAttention,
    priority: PRIORITY[spec.scenario],
    searchIndex,
    matches: true,
    filteredOutReason: '',
  };
}

/** The IntegrityQueue view model over all six seeded scenarios, ordered by priority (descending). */
export function seedIntegrityQueueModel(
  specs: readonly IntegrityScenarioSpec[] = seedIntegrity(),
): IntegrityQueueModel {
  const rows = [...specs].map(rowFor).sort((a, b) => b.priority - a.priority);
  const filters: readonly IntegrityFilterChipVM[] = [
    { facet: 'severity', value: 'critical', label: 'Critical severity', active: false },
    { facet: 'safety', value: 'high', label: 'High safety impact', active: false },
    { facet: 'quarantine', value: 'active', label: 'Quarantined', active: false },
    { facet: 'ownership', value: 'gap', label: 'Ownership gap', active: false },
    { facet: 'closure', value: 'verified', label: 'Verified-closed', active: false },
    { facet: 'attention', value: 'needed', label: 'Needs attention', active: false },
  ];
  const visible = rows.filter((r) => r.matches).length;
  const attentionVisible = rows.filter((r) => r.matches && r.needsHumanAttention).length;
  const verifiedClosedVisible = rows.filter((r) => r.matches && r.closureRealized).length;
  return {
    rows,
    filters,
    query: {
      text: '',
      activeFilters: [],
      visible,
      total: rows.length,
      attentionVisible,
      verifiedClosedVisible,
      resultSummary: `${visible} of ${rows.length} damaged-work case(s) shown; ${attentionVisible} need human attention; ${verifiedClosedVisible} verified-closed.`,
    },
    metadata: {
      generatedAtIso: iso(NOW),
      freshness: 'current',
      partialCoverage: false,
      snapshotDigest: 'sha256:integrity-queue-snapshot',
      safeNextAction: '',
    },
  };
}

/** The EvidenceComparison model for the detected-preserved case — original intact, contained. */
export function seedEvidenceComparisonModel(
  specs: readonly IntegrityScenarioSpec[] = seedIntegrity(),
): EvidenceComparisonModel {
  const spec = specs.find((s) => s.scenario === 'quarantined')!;
  const originalDigest = 'sha256:preserved-original-abc';
  return {
    caseId: String(spec.case.id),
    workItemId: String(spec.case.workItemId),
    problemClass: spec.case.problemClass,
    original: {
      label: 'preserved original',
      evidenceId: String(spec.case.originalEvidenceId),
      contentDigest: originalDigest,
      capturedAtIso: iso((NOW - 3 * ONE_HOUR) as EpochMillis),
      quarantined: false,
      provenance: 'captured by the integrity detector before any repair (FR-017)',
    },
    current: {
      label: 'current (quarantined) state',
      evidenceId: String(uuidFromSlug('current-evidence-quarantined')),
      contentDigest: 'sha256:current-corrupted-def',
      capturedAtIso: iso((NOW - ONE_HOUR) as EpochMillis),
      quarantined: true,
      provenance: 'the damaged derivative, contained by an active quarantine',
    },
    rows: [
      {
        field: 'checksum',
        changeKind: 'changed',
        originalValue: 'abc',
        currentValue: 'def',
        safetyRelevant: true,
      },
      {
        field: 'record_count',
        changeKind: 'changed',
        originalValue: '1000',
        currentValue: '742',
        safetyRelevant: true,
      },
      {
        field: 'schema_version',
        changeKind: 'unchanged',
        originalValue: 'v3',
        currentValue: 'v3',
        safetyRelevant: false,
      },
    ],
    originalIntact: true,
    originalVerifyDigest: originalDigest,
    quarantineContains: true,
    blockedCapabilities: [...(spec.quarantine?.blockedCapabilities ?? [])],
    repairApplied: false,
    summary:
      'Original preserved and intact; damaged current state is contained by an active quarantine.',
  };
}

/** The RemediationDetail model for the auto-repairable case — execute enabled (all steps pre-authorized). */
export function seedRemediationDetailModel(
  specs: readonly IntegrityScenarioSpec[] = seedIntegrity(),
): RemediationDetailModel {
  const spec = specs.find((s) => s.scenario === 'auto_repairable')!;
  const steps: readonly RemediationStepVM[] = [
    {
      stepId: String(uuidFromSlug('step-checkpoint')),
      ordinal: 1,
      description: 'checkpoint current state before applying the repair',
      riskClass: 'low',
      preAuthorizedLowRisk: true,
      reversible: true,
      gateReason: '',
    },
    {
      stepId: String(uuidFromSlug('step-restore')),
      ordinal: 2,
      description: 'restore the deterministic derivative from the preserved original',
      riskClass: 'low',
      preAuthorizedLowRisk: true,
      reversible: true,
      gateReason: '',
    },
  ];
  return {
    caseId: String(spec.case.id),
    workItemId: String(spec.case.workItemId),
    problemClass: spec.case.problemClass,
    severity: spec.case.severity,
    ownerPrincipalId: String(REVIEWER),
    ownershipGap: false,
    planId: String(spec.plan!.id),
    planVersion: spec.plan!.version,
    recommendation:
      'Restore the deterministic derivative from the preserved original (low-risk, reversible).',
    steps,
    availableModes: ['recommend_only', 'simulate', 'request_approval', 'execute_if_pre_authorized'],
    attempt: {
      attemptId: String(uuidFromSlug('attempt-auto_repairable')),
      outcome: 'succeeded_unverified',
      startedAtIso: iso((NOW - 15 * ONE_MINUTE) as EpochMillis),
      stepsAttempted: 2,
      stepsTotal: 2,
      safeNextAction: 'run independent verification before closing the case',
      killEngaged: false,
      rollbackAvailable: true,
      auditEventId: String(uuidFromSlug('audit-auto_repairable')),
    },
    verification: {
      verificationId: '',
      allGatesPassed: false,
      gates: [],
      caseClosed: false,
      closureBlocked: ['independent verification has not been run'],
    },
    summary:
      'Repair succeeded but is NOT verified; the case is NOT verified-closed until independent verification passes.',
  };
}

/** The RemediationDetail model for the VERIFIED-CLOSED case — the only closed presenter input. */
export function seedVerifiedClosedDetailModel(
  specs: readonly IntegrityScenarioSpec[] = seedIntegrity(),
): RemediationDetailModel {
  const spec = specs.find((s) => s.scenario === 'verified_closed')!;
  const base = seedRemediationDetailModel(specs);
  return {
    ...base,
    caseId: String(spec.case.id),
    workItemId: String(spec.case.workItemId),
    planId: String(spec.plan!.id),
    attempt: { ...base.attempt, attemptId: String(uuidFromSlug('attempt-verified_closed')) },
    verification: {
      verificationId: String(spec.verification!.id),
      allGatesPassed: true,
      gates: CLOSURE_GATES.map((g) => ({
        name: g,
        passed: true,
        detail: 'gate passed under independent verification',
      })),
      caseClosed: true,
      closureBlocked: [],
    },
    summary: 'Verified-closed: an independent nine-gate verification passed.',
  };
}

/** Convenience — assert the seeded verified-closed case genuinely satisfies the closure oracle. */
export function verifiedClosureHolds(spec: IntegrityScenarioSpec): boolean {
  if (spec.verification === null) return false;
  return (
    verifiedClosureResult({
      gateResults: spec.verification.gateResults,
      verifierIndependent: spec.verification.verifierIndependent,
    }) === 'passed'
  );
}
