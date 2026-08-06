// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — COMPONENT PROFILES & CORE-vs-OPTIONAL READINESS (T223 · NFR-010 · FR-036 · SC-016).
//
// UNIT oracle for the two modules that jointly encode the component-profile invariant "only the CORE
// profile runs continuously; everything else is intentionally-inactive / on-demand until an
// owner-approved activation PROVES its prerequisites, and optional absence NEVER drags core down":
//
//   * COMPONENT LIFECYCLE (apps/command-worker/src/component-lifecycle.ts) — inspect / activate /
//     deactivate / reconcile, with PROOF-BEFORE-ACTIVE: a transition to activation_state `active` is
//     REFUSED unless identity+contract+authority+backlog are ALL proven (no mutation before proof).
//   * READINESS SERVICE (`@trustcircle/application` evaluateReadiness) — coreHealthy is computed ONLY
//     from core components; optional/on-demand inactivity is surfaced as an EXPLICIT inventory and can
//     NEVER change the core verdict.
//
// The profile semantics proven here:
//   - core-required   → runs continuously (inspect ⇒ active) ONLY once proven; a lapsed core is `stale`.
//   - on-demand / optional / external → intentionally_inactive until an owner-approved activation.
//   - inactive / maintenance / unavailable / degraded / stale / failed → NONE of these count as healthy
//     for readiness; only `active` is healthy.
//
// Every assertion pins a REAL module verdict — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import { evaluateReadiness } from '@trustcircle/application';

import {
  inspect,
  activate,
  deactivate,
  reconcile,
  preflightPassed,
  COMPONENT_RUNTIME_STATES,
  type ActivationPrerequisites,
  type ComponentAvailabilityClass,
} from '../../apps/command-worker/src/component-lifecycle.ts';

import { NOW, TENANT, PLATFORM_OWNER } from '../fixtures/integrations.ts';

const ALL_PROVEN: ActivationPrerequisites = Object.freeze({
  identityVerified: true,
  contractVerified: true,
  authorityVerified: true,
  backlogReconciled: true,
});

function componentInput(
  availabilityClass: ComponentAvailabilityClass,
  prerequisites: ActivationPrerequisites,
) {
  return {
    componentKey: `component-${availabilityClass}`,
    tenantId: String(TENANT),
    owner: String(PLATFORM_OWNER),
    availabilityClass,
    prerequisites,
    at: NOW as number,
  };
}

describe('component profiles · proof-before-active gate (NFR-010)', () => {
  it('preflightPassed requires ALL four prerequisites', () => {
    expect(preflightPassed(ALL_PROVEN)).toBe(true);
    for (const missing of [
      'identityVerified',
      'contractVerified',
      'authorityVerified',
      'backlogReconciled',
    ] as const) {
      expect(preflightPassed({ ...ALL_PROVEN, [missing]: false })).toBe(false);
    }
  });

  it('activate REFUSES to reach active when any prerequisite is unmet — no mutation before proof', () => {
    for (const missing of [
      'identityVerified',
      'contractVerified',
      'authorityVerified',
      'backlogReconciled',
    ] as const) {
      const unmet = { ...ALL_PROVEN, [missing]: false };
      expect(() => activate(componentInput('core', unmet))).toThrow(/refused: unmet prerequisites/);
    }
  });

  it('activate reaches active with a stamped activatedAt ONLY when fully proven', () => {
    const rec = activate(componentInput('core', ALL_PROVEN));
    expect(rec.activationState).toBe('active');
    expect(rec.runtimeState).toBe('active');
    expect(rec.preflightPassed).toBe(true);
    expect(rec.activatedAt).toBe(NOW);
    expect(rec.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('component profiles · availability class drives the continuously-expected runtime', () => {
  it('CORE-required inspect is active only once proven; unproven core is intentionally_inactive', () => {
    expect(inspect(componentInput('core', ALL_PROVEN)).runtimeState).toBe('active');
    expect(
      inspect(componentInput('core', { ...ALL_PROVEN, authorityVerified: false })).runtimeState,
    ).toBe('intentionally_inactive');
    // inspect NEVER activates — activation_state stays inactive regardless.
    expect(inspect(componentInput('core', ALL_PROVEN)).activationState).toBe('inactive');
  });

  it('OPTIONAL and ON-DEMAND inspect are intentionally_inactive even when fully proven', () => {
    // Availability is separate from authority: an optional/on-demand component does not run continuously.
    expect(inspect(componentInput('optional', ALL_PROVEN)).runtimeState).toBe(
      'intentionally_inactive',
    );
    expect(inspect(componentInput('on-demand', ALL_PROVEN)).runtimeState).toBe(
      'intentionally_inactive',
    );
  });

  it('deactivate always returns to intentionally_inactive with no active activation state', () => {
    const rec = deactivate(componentInput('core', ALL_PROVEN));
    expect(rec.runtimeState).toBe('intentionally_inactive');
    expect(rec.activationState).toBe('inactive');
    expect(rec.activatedAt).toBeNull();
  });

  it('reconcile surfaces a lapsed CORE as stale (drift-visible), never silently active', () => {
    const proven = reconcile(componentInput('core', ALL_PROVEN));
    expect(proven.runtimeState).toBe('active');

    const lapsed = reconcile(componentInput('core', { ...ALL_PROVEN, backlogReconciled: false }));
    expect(lapsed.runtimeState).toBe('stale');
    expect(lapsed.activationState).toBe('inactive'); // reconcile observes, never activates

    // A non-core component reconciles to intentionally_inactive regardless of proof.
    expect(reconcile(componentInput('optional', ALL_PROVEN)).runtimeState).toBe(
      'intentionally_inactive',
    );
  });

  it('the runtime-state vocabulary is the frozen component_activation set', () => {
    expect([...COMPONENT_RUNTIME_STATES]).toEqual([
      'active',
      'intentionally_inactive',
      'maintenance',
      'unavailable',
      'degraded',
      'stale',
      'failed',
      'returning',
    ]);
  });
});

describe('component profiles · readiness is core-only and independent of optional availability (SC-016)', () => {
  it('core healthy + every optional inactive ⇒ ready, with an EXPLICIT unavailable inventory', () => {
    const result = evaluateReadiness({
      at: NOW as number,
      activations: [
        { componentKey: 'core-control-plane', availabilityClass: 'core', runtimeState: 'active' },
        {
          componentKey: 'kanban-optional',
          availabilityClass: 'optional',
          runtimeState: 'intentionally_inactive',
          activationCondition: 'owner-approved activation of the kanban connector',
        },
        {
          componentKey: 'agentctl-on-demand',
          availabilityClass: 'on-demand',
          runtimeState: 'intentionally_inactive',
        },
      ],
    });
    expect(result.coreHealthy).toBe(true);
    expect(result.verdict).toBe('ready');
    // Optional inactivity is VISIBLE, not hidden as "everything is fine".
    expect(result.optionalUnavailable.map((f) => f.componentKey)).toEqual([
      'agentctl-on-demand',
      'kanban-optional',
    ]);
    expect(result.unhealthyCore).toEqual([]);
    expect(result.coreComponentCount).toBe(1);
  });

  it('one unhealthy CORE component ⇒ not_ready — NO optional state can rescue it', () => {
    for (const badState of [
      'intentionally_inactive',
      'maintenance',
      'unavailable',
      'degraded',
      'stale',
      'failed',
    ] as const) {
      const result = evaluateReadiness({
        at: NOW as number,
        activations: [
          { componentKey: 'core-control-plane', availabilityClass: 'core', runtimeState: badState },
          // Even with EVERY optional feature perfectly active, core being unhealthy is decisive.
          { componentKey: 'opt-a', availabilityClass: 'optional', runtimeState: 'active' },
        ],
      });
      expect(result.coreHealthy).toBe(false);
      expect(result.verdict).toBe('not_ready');
      expect(result.unhealthyCore.map((c) => c.runtimeState)).toContain(badState);
    }
  });

  it('an active optional feature is NOT listed as unavailable (only non-active optionals are)', () => {
    const result = evaluateReadiness({
      at: NOW as number,
      activations: [
        { componentKey: 'core-control-plane', availabilityClass: 'core', runtimeState: 'active' },
        { componentKey: 'opt-active', availabilityClass: 'optional', runtimeState: 'active' },
        { componentKey: 'opt-off', availabilityClass: 'optional', runtimeState: 'unavailable' },
      ],
    });
    expect(result.optionalUnavailable.map((f) => f.componentKey)).toEqual(['opt-off']);
  });

  it('readiness is deterministic — identical activations + at ⇒ identical digest', () => {
    const activations = [
      {
        componentKey: 'core-control-plane',
        availabilityClass: 'core' as const,
        runtimeState: 'active' as const,
      },
      {
        componentKey: 'opt-off',
        availabilityClass: 'optional' as const,
        runtimeState: 'unavailable' as const,
      },
    ];
    const a = evaluateReadiness({ at: NOW as number, activations });
    const b = evaluateReadiness({ at: NOW as number, activations: [...activations].reverse() });
    expect(a.digest).toBe(b.digest); // ordering-independent
  });
});
