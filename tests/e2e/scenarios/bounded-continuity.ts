// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — BOUNDED CONTINUITY acceptance runner (T181 · FR-046..050 · NFR-012 · SC-021).
//
// When a controller loses health mid-operation, an already-approved, already-started operation may
// CONTINUE for a SHORT, BOUNDED (≤15 min), NONRENEWABLE window — and continuity NEVER creates new
// authority. This runner reads the continuity verdicts off the projected OperationDetail model for the
// `continuity` scenario (its operation is in state `continuity` under an active lease) and drives the
// REAL continuity application service to prove the ceiling + the reconcile-on-return obligation. The
// negative control is any non-continuity scenario, which carries NO lease at all.
//
// Pure, deterministic: model facts + the real continuity-service oracle, never a mutation echo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import {
  evaluateContinuityEligibility,
  grantContinuityLease,
  continuityReturnObligation,
} from '@trustcircle/application';

import {
  seedControllers,
  seedOperationDetailModel,
} from './_controller-inputs.ts';
import type { ControllerInputs } from './_controller-inputs.ts';

import {
  NOW,
  TENANT,
  OWNER,
  CONTINUITY_POLICY_VERSION_ID,
  uuidFromSlug,
} from '../../fixtures/controllers.ts';

import type { EpochMillis } from '@trustcircle/domain';

const ONE_MINUTE = 60_000;
const CEILING_MS = 15 * ONE_MINUTE;

export interface CriterionResult {
  readonly ref: string;
  readonly statement: string;
  readonly satisfied: boolean;
  readonly evidence: string;
  readonly observedVia: string;
  readonly negativeControl: string;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly criteria: readonly CriterionResult[];
  readonly allSatisfied: boolean;
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

function finish(scenario: string, criteria: readonly CriterionResult[]): ScenarioResult {
  return {
    scenario,
    criteria,
    allSatisfied: criteria.every((c) => c.satisfied),
    digest: `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`,
  };
}

export function runBoundedContinuityScenario(inputs: ControllerInputs): ScenarioResult {
  const seed = seedControllers();
  const continuitySpec = seed.find((s) => s.scenario === 'continuity')!;
  const continuityOp = continuitySpec.operation!;
  const detail = seedOperationDetailModel('continuity', inputs.at);
  const nonContinuity = seedOperationDetailModel('verified_success', inputs.at);
  const criteria: CriterionResult[] = [];

  // FR-047 — IN-PROGRESS ONLY: continuity is eligible only for an approved + started operation.
  const eligible = evaluateContinuityEligibility({
    operation: continuityOp,
    operationApproved: true,
    operationStartedBeforeFailure: true,
  });
  const unstarted = evaluateContinuityEligibility({
    operation: continuityOp,
    operationApproved: true,
    operationStartedBeforeFailure: false,
  });
  criteria.push({
    ref: 'FR-047 (in-progress only)',
    statement: 'A continuity lease is eligible only for an operation approved AND started before the failure — never new authority.',
    satisfied:
      eligible.eligible === true &&
      eligible.reason === 'approved_and_in_progress' &&
      unstarted.eligible === false &&
      unstarted.reason === 'operation_not_started_before_failure',
    evidence: `eligible(started)=${eligible.eligible}; eligible(unstarted)=${unstarted.eligible} (${unstarted.reason})`,
    observedVia: 'evaluateContinuityEligibility({operation, approved, startedBeforeFailure})',
    negativeControl: 'an unstarted operation is refused — a lease for it would grant power the operator never held',
  });

  // NFR-012 — BOUNDED ≤ 15 MIN: an over-ceiling request is clamped; a within-ceiling request is exact.
  const grantInput = (durationMs: number) => ({
    id: uuidFromSlug('lease-continuity-runner'),
    tenantId: TENANT,
    operation: continuityOp,
    continuityPolicyVersionId: CONTINUITY_POLICY_VERSION_ID,
    ownerPrincipalId: OWNER,
    operationApproved: true,
    operationStartedBeforeFailure: true,
    grantedAt: NOW as EpochMillis,
    requestedDurationMs: durationMs,
  });
  const clamped = grantContinuityLease(grantInput(60 * ONE_MINUTE));
  const clampedSpan = (clamped.lease.expiresAt as number) - (clamped.lease.grantedAt as number);
  const honored = grantContinuityLease(grantInput(7 * ONE_MINUTE));
  const honoredSpan = (honored.lease.expiresAt as number) - (honored.lease.grantedAt as number);
  criteria.push({
    ref: 'NFR-012 (bounded ≤ 15 min)',
    statement: 'A requested continuity duration is clamped to the 15-minute ceiling; a within-ceiling request is honored exactly.',
    satisfied: clampedSpan === CEILING_MS && honoredSpan === 7 * ONE_MINUTE,
    evidence: `requested 60min → span=${clampedSpan / ONE_MINUTE}min (ceiling ${CEILING_MS / ONE_MINUTE}); requested 7min → span=${honoredSpan / ONE_MINUTE}min`,
    observedVia: 'grantContinuityLease(...).lease.expiresAt − grantedAt vs CONTINUITY_LEASE_CEILING_MS',
    negativeControl: 'a 60-minute request cannot buy 60 minutes — the ceiling is a hard clamp, not a suggestion',
  });

  // FR-046 — the projected lease surfaces its active verdict + remaining window (bounded, nonrenewable).
  criteria.push({
    ref: 'FR-046 (lease surfaced)',
    statement: 'The continuity operation surfaces an active lease with a positive, bounded remaining window and a reconcile-on-return duty.',
    satisfied:
      detail.continuityLease !== null &&
      detail.continuityLease.active === true &&
      detail.continuityLease.remainingMs > 0 &&
      detail.continuityLease.remainingMs <= CEILING_MS &&
      detail.continuityLease.mustReconcileOnReturn === true,
    evidence: `lease active=${detail.continuityLease?.active}, remainingMs=${detail.continuityLease?.remainingMs}, mustReconcileOnReturn=${detail.continuityLease?.mustReconcileOnReturn}`,
    observedVia: 'OperationDetailModel(continuity).continuityLease.{active,remainingMs,mustReconcileOnReturn}',
    negativeControl: `a non-continuity operation carries NO lease at all (continuityLease=${nonContinuity.continuityLease === null ? 'null' : 'present'}) — a lease is never fabricated`,
  });

  // FR-050 — RECONCILE ON RETURN: buffered continuity effects reconcile BEFORE any new mutation.
  const withBuffered = continuityReturnObligation({ bufferedEffectCount: 2 });
  const noBuffered = continuityReturnObligation({ bufferedEffectCount: 0 });
  criteria.push({
    ref: 'FR-050 (reconcile on return)',
    statement: 'Any buffered continuity effect forces a reconcile-before-mutation obligation on return.',
    satisfied:
      withBuffered.mustReconcileBeforeMutation === true &&
      withBuffered.reason === 'buffered_continuity_effects_must_reconcile_first' &&
      noBuffered.mustReconcileBeforeMutation === false,
    evidence: `buffered=2 → mustReconcile=${withBuffered.mustReconcileBeforeMutation}; buffered=0 → mustReconcile=${noBuffered.mustReconcileBeforeMutation}`,
    observedVia: 'continuityReturnObligation({bufferedEffectCount})',
    negativeControl: 'with zero buffered effects there is no obligation — the duty is a function of real buffered work, not blanket',
  });

  return finish('bounded-continuity', criteria);
}

export default runBoundedContinuityScenario;
