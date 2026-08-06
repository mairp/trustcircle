// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — BOUNDED CONTINUITY (T155 · FR-046 · FR-047 · FR-048 · FR-049 · FR-050 ·
// NFR-012 · SC-021).
//
// RESILIENCE oracle for continuity: when a controller loses health mid-operation it may CONTINUE an
// already-approved, already-started operation for a short, BOUNDED, NONRENEWABLE window — and continuity
// NEVER creates new authority. This suite drives the REAL continuity application service
// (packages/application/continuity-service.ts) over the deterministic fixtures, proving the four
// load-bearing invariants:
//
//   * IN-PROGRESS ONLY (FR-047). A lease is eligible ONLY for an operation approved AND started before
//     the failure. An unstarted or unapproved operation is refused — a lease for it would be new authority.
//   * BOUNDED ≤ 15 MIN + NONRENEWABLE (NFR-012). A requested duration over the 15-minute ceiling is
//     clamped; the domain factory rejects an over-ceiling lease outright.
//   * STEP-GATED (FR-048 / SC-021). Under an active lease a step runs only while its action-limit is not
//     exhausted, its local observations hold, and a NEW consequential step is locally revalidatable; past
//     expiry the controller MUST pause.
//   * RECONCILE ON RETURN (FR-050). Buffered continuity effects reconcile BEFORE any new mutation.
//
// Every assertion pins a service verdict backed by the domain oracle — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  evaluateContinuityEligibility,
  grantContinuityLease,
  mayExecuteContinuityStep,
  continuityLeaseActive,
  continuityReturnObligation,
} from '@trustcircle/application';

import {
  NOW,
  TENANT,
  OWNER,
  CONTINUITY_POLICY_VERSION_ID,
  uuidFromSlug,
  seedControllers,
  seedContinuityLease,
  type ControllerScenarioName,
  type ControllerScenarioSpec,
} from '../fixtures/controllers.ts';

import type { EpochMillis } from '@trustcircle/domain';

const ONE_MINUTE = 60_000;
const CEILING_MS = 15 * ONE_MINUTE;

function specFor(name: ControllerScenarioName): ControllerScenarioSpec {
  const spec = seedControllers().find((s) => s.scenario === name);
  if (!spec) throw new Error(`no seeded scenario ${name}`);
  return spec;
}

describe('continuity eligibility — in-progress-only, never new authority (FR-047)', () => {
  it('an approved + started operation is eligible', () => {
    const op = specFor('continuity').operation!;
    const verdict = evaluateContinuityEligibility({
      operation: op,
      operationApproved: true,
      operationStartedBeforeFailure: true,
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBe('approved_and_in_progress');
  });

  it('an operation NOT started before failure is refused (a lease would be new authority)', () => {
    const op = specFor('continuity').operation!;
    const verdict = evaluateContinuityEligibility({
      operation: op,
      operationApproved: true,
      operationStartedBeforeFailure: false,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('operation_not_started_before_failure');
  });

  it('an UNAPPROVED operation is refused', () => {
    const op = specFor('verified_success').operation!;
    const verdict = evaluateContinuityEligibility({
      operation: { ...op, approvalDecisionId: undefined },
      operationApproved: false,
      operationStartedBeforeFailure: true,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('operation_not_approved');
  });
});

describe('continuity lease — bounded to 15 minutes, nonrenewable (NFR-012)', () => {
  const grantInput = (over: Partial<Parameters<typeof grantContinuityLease>[0]> = {}) => ({
    id: uuidFromSlug('lease-under-test'),
    tenantId: TENANT,
    operation: specFor('continuity').operation!,
    continuityPolicyVersionId: CONTINUITY_POLICY_VERSION_ID,
    ownerPrincipalId: OWNER,
    operationApproved: true,
    operationStartedBeforeFailure: true,
    grantedAt: NOW as EpochMillis,
    ...over,
  });

  it('a requested duration OVER the ceiling is clamped to 15 minutes', () => {
    const granted = grantContinuityLease(grantInput({ requestedDurationMs: 60 * ONE_MINUTE }));
    const span = (granted.lease.expiresAt as number) - (granted.lease.grantedAt as number);
    expect(span).toBe(CEILING_MS);
    expect(granted.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a within-ceiling duration is honored exactly', () => {
    const granted = grantContinuityLease(grantInput({ requestedDurationMs: 7 * ONE_MINUTE }));
    const span = (granted.lease.expiresAt as number) - (granted.lease.grantedAt as number);
    expect(span).toBe(7 * ONE_MINUTE);
  });

  it('granting a lease for an INELIGIBLE operation throws (continuity never grants new authority)', () => {
    expect(() =>
      grantContinuityLease(grantInput({ operationStartedBeforeFailure: false })),
    ).toThrow(/continuity lease refused/i);
  });
});

describe('continuity lease activity + step gate (FR-048 / SC-021)', () => {
  it('an unexpired lease is active; a lease is NOT active past its expiry (must pause)', () => {
    const lease = seedContinuityLease('active', {
      grantedAt: (NOW - 3 * ONE_MINUTE) as EpochMillis,
      durationMs: 10 * ONE_MINUTE,
    });
    expect(continuityLeaseActive(lease, NOW)).toBe(true);
    // Well past expiry → inactive → controller must pause.
    expect(continuityLeaseActive(lease, (NOW + 30 * ONE_MINUTE) as EpochMillis)).toBe(false);
  });

  it('a step within the action limit + local observations satisfied is permitted', () => {
    const lease = seedContinuityLease('gate-ok');
    const verdict = mayExecuteContinuityStep({
      lease,
      operationKind: 'execute',
      now: NOW as EpochMillis,
      localObservationsSatisfied: true,
      stepIsNewConsequential: false,
      liveSafetyLocallyVerifiable: true,
      actionsAlreadyTaken: 0,
    });
    expect(verdict.permitted).toBe(true);
  });

  it('a step past the action limit is refused (bounded action budget)', () => {
    const lease = seedContinuityLease('gate-limit');
    const verdict = mayExecuteContinuityStep({
      lease,
      operationKind: 'execute',
      now: NOW as EpochMillis,
      localObservationsSatisfied: true,
      stepIsNewConsequential: false,
      liveSafetyLocallyVerifiable: true,
      actionsAlreadyTaken: 3, // == actionLimit from the seed → exhausted
    });
    expect(verdict.permitted).toBe(false);
  });

  it('a NEW consequential step that is NOT locally revalidatable is refused (pauses)', () => {
    const lease = seedContinuityLease('gate-unsafe');
    const verdict = mayExecuteContinuityStep({
      lease,
      operationKind: 'execute',
      now: NOW as EpochMillis,
      localObservationsSatisfied: true,
      stepIsNewConsequential: true,
      liveSafetyLocallyVerifiable: false,
      actionsAlreadyTaken: 0,
    });
    expect(verdict.permitted).toBe(false);
  });

  it('a step under an EXPIRED lease is refused (past the bounded window)', () => {
    const lease = seedContinuityLease('gate-expired', {
      grantedAt: (NOW - 30 * ONE_MINUTE) as EpochMillis,
      durationMs: 10 * ONE_MINUTE,
    });
    const verdict = mayExecuteContinuityStep({
      lease,
      operationKind: 'execute',
      now: NOW as EpochMillis,
      localObservationsSatisfied: true,
      stepIsNewConsequential: false,
      liveSafetyLocallyVerifiable: true,
      actionsAlreadyTaken: 0,
    });
    expect(verdict.permitted).toBe(false);
  });
});

describe('reconcile on return — buffered effects reconcile before any new mutation (FR-050)', () => {
  it('any buffered continuity effect forces a reconcile-before-mutation obligation', () => {
    const obligation = continuityReturnObligation({ bufferedEffectCount: 2 });
    expect(obligation.mustReconcileBeforeMutation).toBe(true);
    expect(obligation.reason).toBe('buffered_continuity_effects_must_reconcile_first');
  });

  it('no buffered effects → no obligation', () => {
    const obligation = continuityReturnObligation({ bufferedEffectCount: 0 });
    expect(obligation.mustReconcileBeforeMutation).toBe(false);
  });
});
