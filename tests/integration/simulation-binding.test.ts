// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — SIMULATION BINDING (T153 · FR-025 · NS-005).
//
// INTEGRATION oracle for simulate-before-execute: a simulation PINS the exact version tuple
// (controller / adapter / policy / source revision) it was computed against and EXPIRES, and it may
// only authorize execution while that pinned world has NOT moved. This suite drives the REAL
// `produceSimulation` + `checkSimulationBinding` application service (packages/application/
// simulation-service.ts) and the REAL `guardExecution` last-gate (execution-guard.ts) over the
// deterministic controller fixtures, proving:
//
//   * A simulation binds against the SAME observed tuple, before expiry (the happy path).
//   * A SOURCE-REVISION drift between simulation and execution invalidates it (NS-005) — the single
//     most common and most dangerous drift — and names sourceRevision as the drifted member.
//   * An EXPIRED simulation cannot bind even with an unchanged tuple (FR-025 staleness).
//   * The execution guard REFUSES a state-changing operation whose simulation no longer binds, and
//     the refusal is attributable to the `simulation-binding` gate (fail-closed).
//   * A read-only operation needs no simulation (it cannot mutate the source).
//
// Every assertion pins a service verdict derived from the domain oracle — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  produceSimulation,
  checkSimulationBinding,
  guardExecution,
  type ExecutionGuardInput,
} from '@trustcircle/application';

import {
  NOW,
  TENANT,
  AUTHORIZED_TUPLE,
  DRIFTED_TUPLE,
  uuidFromSlug,
  seedSimulation,
  seedControllers,
  type ControllerScenarioName,
  type ControllerScenarioSpec,
} from '../fixtures/controllers.ts';

import type { EpochMillis } from '@trustcircle/domain';

const ONE_MINUTE = 60_000;

function specFor(name: ControllerScenarioName): ControllerScenarioSpec {
  const spec = seedControllers().find((s) => s.scenario === name);
  if (!spec) throw new Error(`no seeded scenario ${name}`);
  return spec;
}

describe('simulation binding — a pinned simulation binds only while its world is unchanged (NS-005/FR-025)', () => {
  it('binds against the SAME observed tuple before expiry', () => {
    const sim = seedSimulation('binds', { producedAt: (NOW - ONE_MINUTE) as EpochMillis });
    const verdict = checkSimulationBinding(sim, AUTHORIZED_TUPLE, NOW);
    expect(verdict.binds).toBe(true);
    expect(verdict.invalidatedByDrift).toBe(false);
    expect(verdict.invalidatedByExpiry).toBe(false);
    expect(verdict.driftedMembers).toHaveLength(0);
    expect(verdict.reason).toBe('simulation_binds');
  });

  it('a SOURCE-REVISION drift invalidates the simulation and names sourceRevision (NS-005)', () => {
    const sim = seedSimulation('drift', { producedAt: (NOW - ONE_MINUTE) as EpochMillis });
    // DRIFTED_TUPLE differs only in the source revision from AUTHORIZED_TUPLE.
    const verdict = checkSimulationBinding(sim, DRIFTED_TUPLE, NOW);
    expect(verdict.binds).toBe(false);
    expect(verdict.invalidatedByDrift).toBe(true);
    expect(verdict.driftedMembers).toContain('sourceRevision');
    expect(verdict.reason).toBe('source_or_version_drift');
  });

  it('an EXPIRED simulation cannot bind even with an unchanged tuple (FR-025 staleness)', () => {
    const producedAt = (NOW - 30 * ONE_MINUTE) as EpochMillis;
    const sim = seedSimulation('stale', {
      producedAt,
      expiresAt: (producedAt + 10 * ONE_MINUTE) as EpochMillis, // long past NOW
    });
    const verdict = checkSimulationBinding(sim, AUTHORIZED_TUPLE, NOW);
    expect(verdict.binds).toBe(false);
    expect(verdict.invalidatedByExpiry).toBe(true);
    expect(verdict.reason).toBe('simulation_expired');
  });

  it('produceSimulation builds a simulation that later binds against its own bound tuple', () => {
    const produced = produceSimulation({
      id: uuidFromSlug('produced-sim'),
      tenantId: TENANT,
      controllerInstanceId: uuidFromSlug('produced-instance'),
      operationKind: 'execute',
      bound: AUTHORIZED_TUPLE,
      producedAt: (NOW - ONE_MINUTE) as EpochMillis,
    });
    expect(produced.digest).toMatch(/^[0-9a-f]{64}$/);
    const verdict = checkSimulationBinding(produced.simulation, AUTHORIZED_TUPLE, NOW);
    expect(verdict.binds).toBe(true);
  });
});

describe('execution guard — a state-changing op is refused when its simulation no longer binds (FR-025)', () => {
  const okInput = (over: Partial<ExecutionGuardInput>): ExecutionGuardInput => {
    const spec = specFor('verified_success');
    const operation = spec.operation!;
    return {
      operation,
      simulation: spec.simulation!,
      observedVersions: AUTHORIZED_TUPLE,
      authorityStillValid: true,
      policyStillAuthorizes: true,
      ownershipStillValid: true,
      evidenceReady: true,
      preconditionsSatisfied: true,
      withinScope: true,
      withinRateTimeBounds: true,
      rollbackAvailable: true,
      now: NOW,
      ...over,
    };
  };

  it('permits a state-changing op when every gate — including a binding simulation — passes', () => {
    const verdict = guardExecution(okInput({}));
    expect(verdict.permitted).toBe(true);
    expect(verdict.failed).toHaveLength(0);
    expect(verdict.reason).toBe('all_execution_gates_passed');
  });

  it('REFUSES when the observed source revision drifted (simulation no longer binds), attributed to the gate', () => {
    const verdict = guardExecution(okInput({ observedVersions: DRIFTED_TUPLE }));
    expect(verdict.permitted).toBe(false);
    // Both the simulation binding AND the defence-in-depth source-revision gate must fail closed.
    expect(verdict.failed).toContain('simulation-binding');
    expect(verdict.failed).toContain('source-revision');
  });

  it('REFUSES a state-changing op with NO simulation bound (fail-closed)', () => {
    const input = okInput({});
    // Remove the simulation entirely (exactOptionalPropertyTypes: omit, not undefined).
    const { simulation: _drop, ...withoutSim } = input;
    const verdict = guardExecution(withoutSim as ExecutionGuardInput);
    expect(verdict.permitted).toBe(false);
    expect(verdict.failed).toContain('simulation-binding');
  });

  it('a READ-ONLY operation needs no simulation (it cannot mutate the source)', () => {
    const spec = specFor('healthy_idle');
    // Build a read-only inspect operation from the drifted instance's tuple.
    const input: ExecutionGuardInput = {
      operation: {
        ...specFor('verified_success').operation!,
        operationKind: 'inspect',
      },
      observedVersions: AUTHORIZED_TUPLE,
      authorityStillValid: true,
      policyStillAuthorizes: true,
      ownershipStillValid: true,
      evidenceReady: true,
      preconditionsSatisfied: true,
      withinScope: true,
      withinRateTimeBounds: true,
      rollbackAvailable: true,
      now: NOW,
    };
    void spec;
    const verdict = guardExecution(input);
    expect(verdict.permitted).toBe(true);
    expect(verdict.reason).toBe('read_only_permitted');
    // A read-only op skips the simulation gate entirely.
    expect(verdict.failed).not.toContain('simulation-binding');
  });
});
