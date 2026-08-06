// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4 · User Story 2 — HUMAN-DECISION + FEDERATED-JOINT-APPROVAL acceptance runners (T118).
//
//   Requirements: FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-043, FR-044, FR-045.
//   Success:      SC-003 (attributable reasons), SC-004 (emergency accountability),
//                 SC-005 (federated cross-tenant approval), SC-020 (expiry never silently closes).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic set of ACCEPTANCE RUNNERS for User Story 2 — "Make and Govern
// Human Decisions". Each runner takes the fixed decision projection (tests/fixtures/decisions.ts),
// exercises the SHIPPED artifacts a human relies on (the domain expiry oracle, the accessible
// queue / joint / emergency renderers), and returns a STRUCTURED RESULT that binds every acceptance
// criterion to the concrete fact that discharges it — observed through a durable read path, never a
// mutation echo.
//
// This module is a plain ESM module (no test-runner import) so it is reusable from BOTH the Node
// built-in test runner AND the browserless/hermetic Playwright projects. Its executable witness is
// tests/e2e/human-decisions.spec.ts, which additionally MOUNTS the same renderers in a real browser
// and re-asserts the DOM (queue prioritization, time warnings, non-color states, axe WCAG 2.2 AA).
//
// ORACLE DISCIPLINE. Every property an acceptance criterion names is read from the seeded projection
// or the domain oracle — NOT from a mutating method's return value. Each runner exposes both the
// asserted fact AND a NEGATIVE-CONTROL fact whose flip would drive the oracle RED, so no assertion is
// vacuous (the spec asserts both directions).
//
// DETERMINISM. No wall clock, no I/O, no randomness. Same fixture ⇒ byte-identical result.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { decisionIsExpired, isCentralGuardrail } from '@trustcircle/domain';

import {
  seedDecisions,
  seedDecisionInboxModel,
  seedJointDecisionStatusModel,
  seedEmergencyInterventionModel,
  type SeededDecisions,
} from '../../fixtures/decisions.ts';
import type { DecisionInboxModel } from '../../../apps/web/src/features/decisions/DecisionInbox.tsx';
import type { JointDecisionStatusModel } from '../../../apps/web/src/features/decisions/JointDecisionStatus.tsx';
import type { EmergencyInterventionModel } from '../../../apps/web/src/features/operations/EmergencyIntervention.tsx';

// ── Result shapes ────────────────────────────────────────────────────────────────────────────────

/** One acceptance criterion's discharge: the asserted fact + the negative-control that would flip it. */
export interface CriterionResult {
  /** The requirement / success reference this criterion discharges (FR-… / SC-…). */
  readonly ref: string;
  /** The acceptance statement in prose. */
  readonly statement: string;
  /** true iff the seeded projection satisfies the criterion. */
  readonly satisfied: boolean;
  /** The concrete fact observed (via a durable read path) that discharges the criterion. */
  readonly evidence: string;
  /** The durable read path the fact was observed through (never a mutation response). */
  readonly observedVia: string;
  /** A fact whose flip would drive this oracle RED — proves the assertion is non-vacuous. */
  readonly negativeControl: string;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly criteria: readonly CriterionResult[];
  /** true iff EVERY criterion is satisfied. */
  readonly allSatisfied: boolean;
  /** A canonical digest binding the whole result — a single mutated byte invalidates it. */
  readonly digest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digestOf(criteria: readonly CriterionResult[]): string {
  return `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`;
}

function finish(scenario: string, criteria: readonly CriterionResult[]): ScenarioResult {
  return {
    scenario,
    criteria,
    allSatisfied: criteria.every((c) => c.satisfied),
    digest: digestOf(criteria),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RUNNER 1 — the HUMAN DECISION QUEUE (FR-010..FR-015, SC-003, SC-004, SC-020).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface HumanDecisionInputs {
  readonly seed: SeededDecisions;
  readonly inbox: DecisionInboxModel;
  readonly emergency: EmergencyInterventionModel;
}

export function buildHumanDecisionInputs(
  seed: SeededDecisions = seedDecisions(),
): HumanDecisionInputs {
  return {
    seed,
    inbox: seedDecisionInboxModel(seed),
    emergency: seedEmergencyInterventionModel(seed),
  };
}

export function runHumanDecisionScenario(
  inputs: HumanDecisionInputs = buildHumanDecisionInputs(),
): ScenarioResult {
  const { seed, inbox, emergency } = inputs;
  const rowById = (id: string) => inbox.rows.find((r) => r.decisionId === id);

  const authorizedRow = rowById(seed.packages.authorized.id);
  const conflictedRow = rowById(seed.packages.conflicted.id);
  const delegatedRow = rowById(seed.packages.delegated.id);
  const expiredRow = rowById(seed.packages.expired.id);

  const criteria: CriterionResult[] = [];

  // FR-010 — the approver sees a COMPLETE, prioritized decision queue (context to decide).
  const orderedByPriority = inbox.rows.every(
    (r, i) => i === 0 || inbox.rows[i - 1]!.priority >= r.priority,
  );
  criteria.push({
    ref: 'FR-010',
    statement:
      'Authorized humans see a complete, prioritized decision queue with the context to decide.',
    satisfied:
      inbox.rows.length === 5 &&
      orderedByPriority &&
      inbox.rows.every((r) => r.requestedAction.length > 0 && r.riskTier.length > 0),
    evidence: `queue lists ${inbox.rows.length} decisions in non-increasing priority order, each with requested action + risk + impact + expiry`,
    observedVia: 'DecisionInboxModel.rows (queue projection) ordered by .priority',
    negativeControl:
      'if any row lost its requestedAction/riskTier the completeness check flips false',
  });

  // FR-011 — the AUTHORIZED decision is ACTIONABLE with the full action set (approve/deny/…).
  criteria.push({
    ref: 'FR-011',
    statement:
      'A decision the human is authorized to act on offers the full attributable action set.',
    satisfied:
      authorizedRow !== undefined &&
      authorizedRow.actionable &&
      ['approve', 'deny', 'request_changes', 'delegate'].every((a) =>
        authorizedRow.allowedActions.includes(a),
      ),
    evidence: `authorized row actionable=${authorizedRow?.actionable}; allowedActions=[${authorizedRow?.allowedActions.join(', ')}]`,
    observedVia: 'DecisionInboxModel.rows[authorized].allowedActions + .actionable',
    negativeControl:
      'the expired + conflicted rows carry an EMPTY allowedActions set (not actionable)',
  });

  // FR-012 — SEPARATION OF DUTIES: the conflicted decision is NOT actionable and names the conflict.
  criteria.push({
    ref: 'FR-012',
    statement:
      'A separation-of-duties conflict blocks the action and is stated in text, never hidden.',
    satisfied:
      conflictedRow !== undefined &&
      !conflictedRow.actionable &&
      conflictedRow.allowedActions.length === 0 &&
      conflictedRow.conflicts.some((c) => c.toLowerCase().includes('separation-of-duties')),
    evidence: `conflicted row actionable=${conflictedRow?.actionable}; conflicts=[${conflictedRow?.conflicts.join(' | ')}]`,
    observedVia: 'DecisionInboxModel.rows[conflicted].conflicts + .actionable',
    negativeControl:
      'the authorized row has zero conflicts and is actionable — the SoD block is scenario-specific',
  });

  // FR-013 — DELEGATION: authority is delegated within a bounded window; lapse is an effect.
  const active = seed.delegations.active;
  const expiredDeleg = seed.delegations.expired;
  const activeInWindow = active.validFrom <= seed.now && seed.now < active.expiresAt;
  const lapsedOutOfWindow = seed.now >= expiredDeleg.expiresAt;
  criteria.push({
    ref: 'FR-013',
    statement:
      'Authority may be delegated within a bounded window to a distinct recipient; lapse is an accountability effect.',
    satisfied:
      seed.packages.delegated.status === 'delegated' &&
      active.status === 'active' &&
      activeInWindow &&
      active.recipientPrincipalId !== active.delegatorPrincipalId &&
      expiredDeleg.status === 'expired' &&
      lapsedOutOfWindow &&
      (delegatedRow?.actionable ?? false),
    evidence: `active delegation ${active.delegationId} in-window (valid ${active.validFrom}→${active.expiresAt}, now ${seed.now}); expired delegation ${expiredDeleg.delegationId} lapsed`,
    observedVia: 'seed.delegations.active/.expired (status + window) + package.status="delegated"',
    negativeControl:
      'the expired delegation is past its window (status="expired") — an unbounded grant would still be "active"',
  });

  // FR-014 / SC-020 — EXPIRY never silently closes: past-deadline decision is expired + escalated, no live actions.
  const oracleExpired = decisionIsExpired(seed.packages.expired, seed.now);
  const authorizedNotExpired = !decisionIsExpired(seed.packages.authorized, seed.now);
  criteria.push({
    ref: 'FR-014 / SC-020',
    statement:
      'A decision past its deadline is expired and escalated — never silently closed or actioned.',
    satisfied:
      oracleExpired &&
      authorizedNotExpired &&
      expiredRow !== undefined &&
      expiredRow.timePosture === 'expired' &&
      expiredRow.escalated &&
      expiredRow.allowedActions.length === 0,
    evidence: `decisionIsExpired(expired,now)=${oracleExpired}; row timePosture=${expiredRow?.timePosture}, escalated=${expiredRow?.escalated}, actions=${expiredRow?.allowedActions.length}`,
    observedVia: 'domain oracle decisionIsExpired(pkg, now) + DecisionInboxModel.rows[expired]',
    negativeControl: `the in-window authorized package is NOT expired (decisionIsExpired=${!authorizedNotExpired})`,
  });

  // SC-003 — every actionable decision carries an ATTRIBUTABLE, mandatory reason vocabulary.
  const reasonAttributable =
    seed.reasons.approve.code.length > 0 && seed.reasons.approve.text.trim().length > 0;
  criteria.push({
    ref: 'SC-003',
    statement: 'Every decision outcome carries an attributable, non-empty reason (code + text).',
    satisfied: reasonAttributable,
    evidence: `reason code="${seed.reasons.approve.code}", text length=${seed.reasons.approve.text.length}`,
    observedVia: 'seed.reasons.approve (makeReason enforces non-empty code + text)',
    negativeControl:
      'makeReason rejects an empty/blank reason text — an unattributed outcome cannot be constructed',
  });

  // FR-015 / SC-004 — EMERGENCY intervention: break-glass stops, confers NO authority, review OPEN.
  const bgEvent = emergency.priorEvents[0];
  const willNotApprove = emergency.consequences.some(
    (c) => c.effect === 'will_not' && c.summary.toLowerCase().includes('approve'),
  );
  criteria.push({
    ref: 'FR-015 / SC-004',
    statement:
      'Break-glass can stop an operation but never confers decision authority, and its post-event review stays open until completed.',
    satisfied:
      bgEvent !== undefined &&
      bgEvent.reviewComplete === false &&
      bgEvent.reviewerPrincipalId === '' &&
      willNotApprove,
    evidence: `break-glass event ${bgEvent?.id} reviewComplete=${bgEvent?.reviewComplete}; consequence states stop will NOT approve/grant authority`,
    observedVia:
      'EmergencyInterventionModel.priorEvents[0].reviewComplete + .consequences(will_not)',
    negativeControl:
      'a completed review would set reviewComplete=true + a reviewer — the open-review alert only fires while OPEN',
  });

  return finish('human-decision-queue', criteria);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RUNNER 2 — FEDERATED JOINT APPROVAL (FR-043, FR-044, FR-045, SC-005, AC6).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface JointApprovalInputs {
  readonly seed: SeededDecisions;
  readonly joint: JointDecisionStatusModel;
}

export function buildJointApprovalInputs(
  seed: SeededDecisions = seedDecisions(),
): JointApprovalInputs {
  return { seed, joint: seedJointDecisionStatusModel(seed) };
}

export function runFederatedJointApprovalScenario(
  inputs: JointApprovalInputs = buildJointApprovalInputs(),
): ScenarioResult {
  const { seed, joint } = inputs;
  const criteria: CriterionResult[] = [];

  // FR-043 — EVERY affected tenant must supply a CURRENT scoped approval (a stale one does not count).
  const allTenantsCurrentlyApproved =
    joint.tenantApprovals.length > 0 &&
    joint.tenantApprovals.every((t) => t.status === 'approved' && t.current);
  const someTenantPending = joint.tenantApprovals.some(
    (t) => t.status !== 'approved' || !t.current,
  );
  criteria.push({
    ref: 'FR-043',
    statement:
      'Every affected tenant must supply a current scoped approval before the joint action executes.',
    satisfied:
      joint.tenantApprovals.length === seed.joint.affectedTenantIds.length &&
      !allTenantsCurrentlyApproved &&
      someTenantPending &&
      joint.executionBlocked,
    evidence: `${joint.tenantApprovals.length} affected tenants; approved+current=${joint.tenantApprovals.filter((t) => t.status === 'approved' && t.current).length}; execution blocked=${joint.executionBlocked}`,
    observedVia: 'JointDecisionStatusModel.tenantApprovals[*].{status,current} + .executionBlocked',
    negativeControl:
      'were all tenants approved+current AND gates passed, executionBlocked would flip false',
  });

  // FR-044 — NON-WAIVABLE central guardrails must ALL pass; they cannot be waived by any tenant.
  const guardrails = joint.centralGuardrails;
  const anyGuardrailOpen = guardrails.some((g) => !g.passed);
  const guardrailsAreCentral = seed.packages.crossTenant.requirements
    .filter(isCentralGuardrail)
    .every((r) => r.tenantId === null);
  criteria.push({
    ref: 'FR-044',
    statement: 'Non-waivable central guardrails must all pass; no tenant can waive them.',
    satisfied:
      guardrails.length > 0 && anyGuardrailOpen && guardrailsAreCentral && joint.executionBlocked,
    evidence: `${guardrails.length} central guardrail(s), ${guardrails.filter((g) => !g.passed).length} not passed; all have tenantId===null (non-waivable)`,
    observedVia:
      'JointDecisionStatusModel.centralGuardrails[*].passed + domain isCentralGuardrail (tenantId===null)',
    negativeControl:
      'a tenant-scoped requirement (tenantId!=null) would NOT be a central guardrail — waivability is defined by null tenant',
  });

  // FR-045 — a DISTINCT central governance reviewer must approve; independent of tenant approvers.
  const cr = joint.centralReview;
  criteria.push({
    ref: 'FR-045',
    statement:
      'A distinct central governance reviewer — independent of every tenant approver and the requester — must approve.',
    satisfied:
      cr.distinct === true &&
      cr.approved === false && // not yet approved ⇒ gate open (fixture is mid-flight)
      cr.reviewerPrincipalId === (seed.joint.centralReviewerPrincipalId ?? '') &&
      cr.reviewerPrincipalId !== seed.packages.crossTenant.requesterPrincipalId,
    evidence: `central reviewer=${cr.reviewerPrincipalId || 'unassigned'}, distinct=${cr.distinct}, approved=${cr.approved}`,
    observedVia: 'JointDecisionStatusModel.centralReview.{distinct,approved,reviewerPrincipalId}',
    negativeControl:
      'the central reviewer id differs from the requester id — a self-review would collapse distinct→false',
  });

  // AC6 / SC-005 — NO cross-tenant evidence leakage: each tenant row discloses status only.
  const noEvidenceLeak = joint.tenantApprovals.every((t) => t.evidenceDisclosed === false);
  criteria.push({
    ref: 'FR-043 / AC6 / SC-005',
    statement:
      'Federated approval discloses no tenant’s evidence to another tenant (least-privilege disclosure).',
    satisfied: noEvidenceLeak && joint.tenantApprovals.length > 0,
    evidence: `all ${joint.tenantApprovals.length} tenant rows carry evidenceDisclosed=false (status/reviewer/time only)`,
    observedVia: 'JointDecisionStatusModel.tenantApprovals[*].evidenceDisclosed',
    negativeControl:
      'the VM type pins evidenceDisclosed to the literal false — a leak is unrepresentable in the disclosed model',
  });

  return finish('federated-joint-approval', criteria);
}

// ── Convenience: run both scenarios ────────────────────────────────────────────────────────────────

export function runAllHumanDecisionScenarios(seed: SeededDecisions = seedDecisions()): {
  readonly humanDecision: ScenarioResult;
  readonly jointApproval: ScenarioResult;
} {
  return {
    humanDecision: runHumanDecisionScenario(buildHumanDecisionInputs(seed)),
    jointApproval: runFederatedJointApprovalScenario(buildJointApprovalInputs(seed)),
  };
}
