// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — CONTROLLER ROLLBACK (T156 · FR-028 · NS-011).
//
// RESILIENCE oracle for rollback/compensation: restoring a preserved preimage is itself a GOVERNED act
// that must never destroy newer legitimate work. This suite drives the REAL `decideControllerRollback`
// application service (packages/application/controller-rollback.ts, over the domain `decideRollback`
// oracle) across every result, proving:
//
//   * PROTECT NEWER STATE (NS-011). When the observed source revision no longer matches what the
//     operation produced, a straight restore is REFUSED as a `conflict` — newer state protected, scope
//     stays degraded, escalate. The rollback_conflict fixture is exactly this world.
//   * VERIFIED FULL RESTORE clears the operation — and ONLY a restoration verified by a DIRECT remote
//     read may clear it (FR-028 observation-first).
//   * NO PREIMAGE / NO COMPENSATION PATH fails closed as `unavailable` (nothing to restore to / an
//     irreversible step) — never a silent success.
//   * A PARTIAL compensation retains residual differences, stays degraded, and escalates.
//   * AN UNAUTHORIZED rollback fails closed as `failed` + escalate (a rollback is a governed act).
//
// Every assertion pins the service decision (result / operationCleared / protectedNewerState /
// remainsDegraded / mustEscalate) — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  decideControllerRollback,
  type ControllerRollbackContext,
} from '@trustcircle/application';

import {
  SOURCE_REVISION,
  NEWER_SOURCE_REVISION,
  uuidFromSlug,
} from '../fixtures/controllers.ts';

const OP_ID = uuidFromSlug('operation-rollback_conflict');
const PREIMAGE_ID = uuidFromSlug('preimage-evidence');

function ctx(over: Partial<ControllerRollbackContext> = {}): ControllerRollbackContext {
  return {
    operationId: OP_ID,
    preimageEvidenceId: PREIMAGE_ID,
    producedRevision: SOURCE_REVISION,
    observedRevision: SOURCE_REVISION,
    compensatedSteps: 1,
    totalSteps: 1,
    compensationAvailable: true,
    compensationSucceeded: true,
    restorationVerified: true,
    policyAuthorizesRollback: true,
    ...over,
  };
}

describe('rollback protects newer legitimate state (NS-011)', () => {
  it('a drifted observed revision REFUSES the rollback as a conflict — newer state protected, escalate', () => {
    const decision = decideControllerRollback(ctx({ observedRevision: NEWER_SOURCE_REVISION }));
    expect(decision.result).toBe('conflict');
    expect(decision.protectedNewerState).toBe(true);
    expect(decision.operationCleared).toBe(false);
    expect(decision.remainsDegraded).toBe(true);
    expect(decision.mustEscalate).toBe(true);
    expect(decision.reason).toBe('newer_legitimate_state_protected_escalated');
  });
});

describe('a fully verified restore is the ONLY path that clears the operation (FR-028)', () => {
  it('a verified full compensation clears the operation and does not escalate', () => {
    const decision = decideControllerRollback(ctx());
    expect(decision.result).toBe('rolled_back');
    expect(decision.operationCleared).toBe(true);
    expect(decision.protectedNewerState).toBe(false);
    expect(decision.remainsDegraded).toBe(false);
    expect(decision.residualDifferences).toBe(0);
  });

  it('an UNVERIFIED restoration does NOT clear the operation (observation-first)', () => {
    const decision = decideControllerRollback(ctx({ restorationVerified: false }));
    expect(decision.operationCleared).toBe(false);
    expect(decision.remainsDegraded).toBe(true);
  });
});

describe('rollback fails closed when it cannot safely restore', () => {
  it('NO preserved preimage → unavailable (nothing to restore to)', () => {
    const decision = decideControllerRollback(ctx({ preimageEvidenceId: null }));
    expect(decision.result).toBe('unavailable');
    expect(decision.operationCleared).toBe(false);
    expect(decision.remainsDegraded).toBe(true);
    expect(decision.reason).toBe('no_preserved_preimage_to_restore');
  });

  it('NO compensation path (an irreversible step) → unavailable', () => {
    const decision = decideControllerRollback(ctx({ compensationAvailable: false, compensationSucceeded: false }));
    expect(decision.result).toBe('unavailable');
    expect(decision.mustEscalate).toBe(true);
  });

  it('a PARTIAL compensation (some steps compensated, others not) stays degraded, escalates', () => {
    // compensationSucceeded true but not every step compensated → partial with residual differences.
    const decision = decideControllerRollback(
      ctx({ compensatedSteps: 1, totalSteps: 3, compensationSucceeded: true, restorationVerified: false }),
    );
    expect(decision.result).toBe('partial');
    expect(decision.residualDifferences).toBeGreaterThan(0);
    expect(decision.remainsDegraded).toBe(true);
    expect(decision.mustEscalate).toBe(true);
  });

  it('an UNAUTHORIZED rollback fails closed as failed + escalate (a rollback is a governed act)', () => {
    const decision = decideControllerRollback(ctx({ policyAuthorizesRollback: false, totalSteps: 3, compensatedSteps: 1 }));
    expect(decision.result).toBe('failed');
    expect(decision.operationCleared).toBe(false);
    expect(decision.mustEscalate).toBe(true);
    expect(decision.residualDifferences).toBe(2);
    expect(decision.reason).toBe('rollback_not_policy_authorized');
  });
});
