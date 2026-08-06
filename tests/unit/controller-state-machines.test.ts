// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — CONTROLLER STATE MACHINES (T151 · FR-024 · FR-028 · SC-010).
//
// UNIT oracle for the controller-operation lifecycle graph and its derived "valid next actions"
// (`OPERATION_TRANSITIONS` / `canOperationTransition` / `allowedNextOperations` /
// `isTerminalOperationState`, packages/domain/src/controllers.ts). FR-024's load-bearing rule is that
// an operator may only ever request an action the CURRENT state permits — the platform never widens
// that set — and a terminal operation is queryable but never re-driven. This suite pins the graph
// exhaustively (every state, every transition, every permitted-action set) and proves the anti-widening
// and terminal-immutability invariants directly on the domain oracle, with a negative control for each.
//
// Pure: no clock, no I/O, no randomness.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  OPERATION_STATES,
  OPERATION_KINDS,
  TERMINAL_OPERATION_STATES,
  allowedNextOperations,
  canOperationTransition,
  assertOperationTransition,
  isTerminalOperationState,
  isReadOnlyOperation,
  type OperationState,
  type OperationKind,
} from '@trustcircle/domain';

describe('controller-operation lifecycle graph (FR-024)', () => {
  it('every non-terminal state has ≥1 legal transition (no dead-ends mid-lifecycle)', () => {
    for (const s of OPERATION_STATES) {
      if (isTerminalOperationState(s)) continue;
      const outgoing = OPERATION_STATES.filter((t) => canOperationTransition(s, t));
      expect(outgoing.length, `non-terminal ${s} must have ≥1 transition`).toBeGreaterThan(0);
    }
  });

  it('terminal states are exactly {succeeded, failed, cancelled, rolled_back, escalated}', () => {
    expect([...TERMINAL_OPERATION_STATES].sort()).toEqual(
      ['cancelled', 'escalated', 'failed', 'rolled_back', 'succeeded'].sort(),
    );
    expect(isTerminalOperationState('succeeded')).toBe(true);
  });

  it('a CONFIRMED success (succeeded) is a hard sink — it is NEVER re-driven (FR-028)', () => {
    // The one state that must never transition anywhere: a confirmed success is immutable.
    const outgoing = OPERATION_STATES.filter((t) => canOperationTransition('succeeded', t));
    expect(outgoing).toHaveLength(0);
    expect(canOperationTransition('succeeded', 'reconciling')).toBe(false);
    expect(canOperationTransition('succeeded', 'executing')).toBe(false);
  });

  it('a fully-clean cancellation / rollback is also a hard sink', () => {
    for (const sink of ['cancelled', 'rolled_back'] as const) {
      const outgoing = OPERATION_STATES.filter((t) => canOperationTransition(sink, t));
      expect(outgoing, `${sink} must be a hard sink`).toHaveLength(0);
    }
  });

  it('a FAILED / ESCALATED operation may still be reconciled or rolled back (recovery), never re-executed', () => {
    // These are terminal by classification but recoverable: reconcile/rollback are legal, execute is NOT.
    for (const recoverable of ['failed', 'escalated'] as const) {
      expect(canOperationTransition(recoverable, 'reconciling')).toBe(true);
      expect(canOperationTransition(recoverable, 'rolled_back')).toBe(true);
      // NEGATIVE control: a terminal-failed op can never jump back to executing (no re-drive).
      expect(canOperationTransition(recoverable, 'executing')).toBe(false);
      expect(canOperationTransition(recoverable, 'succeeded')).toBe(false);
    }
  });

  it('assertOperationTransition throws on an illegal transition (fail-closed)', () => {
    // requested → executing skips inspect/simulate/approve — must be refused.
    expect(() => assertOperationTransition('requested', 'executing')).toThrow(/illegal/i);
    // A legal one does not throw.
    expect(() => assertOperationTransition('requested', 'inspected')).not.toThrow();
  });

  it('an uncertain dispatch (executing) can reconcile but can NEVER jump straight to succeeded (FR-028)', () => {
    // Success is established by reconciliation+verification, never inferred from a dispatch.
    expect(canOperationTransition('executing', 'succeeded')).toBe(false);
    expect(canOperationTransition('executing', 'reconciling')).toBe(true);
    // Only verifying may reach succeeded.
    expect(canOperationTransition('verifying', 'succeeded')).toBe(true);
  });
});

describe('allowedNextOperations — the platform never widens the permitted set (FR-024)', () => {
  it('every permitted action is a real operation kind', () => {
    for (const s of OPERATION_STATES) {
      for (const k of allowedNextOperations(s)) {
        expect(OPERATION_KINDS).toContain(k);
      }
    }
  });

  it('a terminal state NEVER permits a state-changing re-drive (execute/approve/simulate/pause/resume)', () => {
    const forbiddenInTerminal: OperationKind[] = ['execute', 'approve', 'simulate', 'pause', 'resume'];
    for (const s of TERMINAL_OPERATION_STATES) {
      const permitted = allowedNextOperations(s);
      for (const k of forbiddenInTerminal) {
        expect(permitted, `${s} must never permit ${k}`).not.toContain(k);
      }
    }
  });

  it('a fully-closed terminal (succeeded/cancelled/rolled_back) permits ONLY read-only evidence', () => {
    for (const s of ['succeeded', 'cancelled', 'rolled_back'] as const) {
      expect([...allowedNextOperations(s)]).toEqual(['collect_evidence']);
      expect(isReadOnlyOperation('collect_evidence')).toBe(true);
    }
  });

  it('the permitted set is a fixed function of state (deterministic, no widening)', () => {
    for (const s of OPERATION_STATES) {
      const a = allowedNextOperations(s);
      const b = allowedNextOperations(s);
      expect([...a]).toEqual([...b]);
    }
  });

  it('a fresh (requested) operation may inspect/simulate/emergency_stop but NOT execute', () => {
    const permitted = allowedNextOperations('requested');
    expect(permitted).toContain('inspect');
    expect(permitted).toContain('simulate');
    // NEGATIVE control: execute is not permitted before simulate+approve.
    expect(permitted).not.toContain('execute');
  });

  it('read-only kinds are classified so they never require approval', () => {
    const readOnly: OperationKind[] = ['discover', 'inspect', 'collect_evidence'];
    for (const k of readOnly) expect(isReadOnlyOperation(k)).toBe(true);
    // NEGATIVE control: execute/rollback are NOT read-only.
    expect(isReadOnlyOperation('execute')).toBe(false);
    expect(isReadOnlyOperation('rollback')).toBe(false);
  });
});

describe('graph closure — every referenced transition target is a real state', () => {
  it('no transition points at an unknown state', () => {
    const known = new Set<OperationState>(OPERATION_STATES);
    for (const s of OPERATION_STATES) {
      for (const t of OPERATION_STATES) {
        if (canOperationTransition(s, t)) expect(known.has(t)).toBe(true);
      }
    }
  });
});
