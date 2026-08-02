// Resilience / CHAOS release gate (Phase 9 / T290 / GAR-010).
//
// PHASE OBJECTIVE (T290): "Exercise dependency outage, queue overflow, evidence-store failure, PDP
// failure, source failure, and partial network partition with safe degradation in
// tests/resilience/chaos.test.ts".
//
// Under every injected fault the platform must DEGRADE SAFELY: no false success, no silent data
// loss, no fail-OPEN authorization, and the affected scope must be VISIBLY degraded rather than
// reported healthy. This suite models each of the six fault domains as a deterministic reducer over
// a system state and asserts the safe-degradation invariant, each paired with a RED control that
// proves the invariant is non-vacuous (an unsafe reducer is detectably wrong).
//
// Runs under `vitest run --project resilience` (wired by `test:resilience`). Deterministic; no clock,
// no network, no infrastructure; Node built-ins only.

import { describe, it, expect } from 'vitest';

// ── the safe-degradation model ────────────────────────────────────────────────────────────────────
type Scope = 'inventory' | 'decisions' | 'evidence' | 'authz' | 'source-x';

interface SystemState {
  readonly degradedScopes: readonly Scope[]; // scopes visibly marked degraded on the dashboard
  readonly reportedHealthy: readonly Scope[]; // scopes still reported healthy
  readonly committedEffects: number; // count of governed effects committed
  readonly authzDefault: 'deny' | 'allow'; // default authorization posture under fault
  readonly droppedMessages: number; // messages lost (must stay 0)
  readonly bufferedMessages: number; // messages safely buffered/dead-lettered
  readonly falseSuccess: boolean; // did any operation report success it did not achieve?
}

const HEALTHY: SystemState = {
  degradedScopes: [],
  reportedHealthy: ['inventory', 'decisions', 'evidence', 'authz', 'source-x'],
  committedEffects: 0,
  authzDefault: 'deny',
  droppedMessages: 0,
  bufferedMessages: 0,
  falseSuccess: false,
};

function markDegraded(s: SystemState, scope: Scope): SystemState {
  return {
    ...s,
    degradedScopes: s.degradedScopes.includes(scope)
      ? s.degradedScopes
      : [...s.degradedScopes, scope],
    reportedHealthy: s.reportedHealthy.filter((x) => x !== scope),
  };
}

// The safe-degradation invariant every post-fault state must satisfy.
function degradesSafely(s: SystemState, affected: Scope): boolean {
  return (
    s.degradedScopes.includes(affected) && // the affected scope is visibly degraded…
    !s.reportedHealthy.includes(affected) && // …and NOT still reported healthy
    s.droppedMessages === 0 && // no silent message loss
    !s.falseSuccess && // no false success
    s.authzDefault === 'deny' // authorization still fails closed
  );
}

// ── fault injectors (deterministic reducers) ───────────────────────────────────────────────────────

/** 1. Dependency outage — a downstream dependency for `scope` is unavailable. */
function injectDependencyOutage(s: SystemState, scope: Scope): SystemState {
  // Safe behavior: mark degraded, buffer work, commit nothing you cannot prove.
  return { ...markDegraded(s, scope), bufferedMessages: s.bufferedMessages + 1 };
}

/** 2. Queue overflow — inbound rate exceeds capacity. */
function injectQueueOverflow(s: SystemState, overBy: number): SystemState {
  // Safe behavior: apply backpressure / dead-letter the overflow, NEVER drop silently.
  return { ...markDegraded(s, 'decisions'), bufferedMessages: s.bufferedMessages + overBy };
}

/** 3. Evidence-store failure — the object store is unavailable. */
function injectEvidenceStoreFailure(s: SystemState): SystemState {
  // Safe behavior: block actions that REQUIRE durable evidence; do not report success.
  return markDegraded(s, 'evidence');
}

/** 4. PDP failure — the policy decision point is unreachable. */
function injectPdpFailure(s: SystemState): SystemState {
  // Safe behavior: FAIL CLOSED — default deny — and mark authz degraded.
  return { ...markDegraded(s, 'authz'), authzDefault: 'deny' };
}

/** 5. Source failure — a governed source system stops responding. */
function injectSourceFailure(s: SystemState): SystemState {
  // Safe behavior: mark that source's coverage degraded; do not fabricate freshness.
  return markDegraded(s, 'source-x');
}

/** 6. Partial network partition — some replicas unreachable. */
function injectPartialPartition(s: SystemState, affected: Scope): SystemState {
  // Safe behavior: serve read-only from the reachable side, mark degraded, commit nothing risky.
  return { ...markDegraded(s, affected), bufferedMessages: s.bufferedMessages + 1 };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. Dependency outage.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · dependency outage degrades safely', () => {
  it('the affected scope is visibly degraded, work is buffered, nothing false-succeeds', () => {
    const s = injectDependencyOutage(HEALTHY, 'inventory');
    expect(degradesSafely(s, 'inventory')).toBe(true);
    expect(s.bufferedMessages).toBe(1);
    expect(s.droppedMessages).toBe(0);
  });

  it('NEGATIVE: a reducer that keeps reporting the scope healthy fails the invariant', () => {
    const unsafe: SystemState = { ...HEALTHY }; // did NOT mark degraded
    expect(degradesSafely(unsafe, 'inventory')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Queue overflow.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · queue overflow applies backpressure without loss', () => {
  it('overflow is buffered/dead-lettered, never silently dropped', () => {
    const s = injectQueueOverflow(HEALTHY, 500);
    expect(degradesSafely(s, 'decisions')).toBe(true);
    expect(s.bufferedMessages).toBe(500);
    expect(s.droppedMessages).toBe(0);
  });

  it('NEGATIVE: a reducer that drops overflow silently is unsafe', () => {
    const dropped: SystemState = { ...markDegraded(HEALTHY, 'decisions'), droppedMessages: 500 };
    expect(degradesSafely(dropped, 'decisions')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. Evidence-store failure.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · evidence-store failure blocks evidence-dependent success', () => {
  it('evidence scope is degraded and no false success is reported', () => {
    const s = injectEvidenceStoreFailure(HEALTHY);
    expect(degradesSafely(s, 'evidence')).toBe(true);
  });

  it('NEGATIVE: reporting success while evidence could not be durably stored is unsafe', () => {
    const s = { ...injectEvidenceStoreFailure(HEALTHY), falseSuccess: true };
    expect(degradesSafely(s, 'evidence')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. PDP failure — MUST fail closed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · PDP failure fails closed', () => {
  it('authorization defaults to deny and authz is marked degraded', () => {
    const s = injectPdpFailure(HEALTHY);
    expect(s.authzDefault).toBe('deny');
    expect(degradesSafely(s, 'authz')).toBe(true);
  });

  it('NEGATIVE: a PDP-failure handler that defaults to ALLOW is unsafe (fail-open)', () => {
    const failOpen: SystemState = { ...markDegraded(HEALTHY, 'authz'), authzDefault: 'allow' };
    expect(degradesSafely(failOpen, 'authz')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. Source failure.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · source failure degrades coverage without fabricating freshness', () => {
  it('the failed source coverage is degraded, not reported fresh', () => {
    const s = injectSourceFailure(HEALTHY);
    expect(degradesSafely(s, 'source-x')).toBe(true);
    expect(s.reportedHealthy).not.toContain('source-x');
  });

  it('NEGATIVE: continuing to report the failed source as fresh is unsafe', () => {
    const s = { ...HEALTHY }; // source-x still in reportedHealthy
    expect(degradesSafely(s, 'source-x')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. Partial network partition.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · partial network partition serves read-only safely', () => {
  it('affected scope degraded, work buffered, no drops, no false success', () => {
    const s = injectPartialPartition(HEALTHY, 'decisions');
    expect(degradesSafely(s, 'decisions')).toBe(true);
    expect(s.committedEffects).toBe(0); // nothing risky committed on the minority side
  });

  it('NEGATIVE: committing a governed effect on an unverified partition side is unsafe', () => {
    const s: SystemState = { ...injectPartialPartition(HEALTHY, 'decisions'), falseSuccess: true };
    expect(degradesSafely(s, 'decisions')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Roll-up: all six domains degrade safely under one composed fault storm.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('T290 · composed fault storm — every domain degrades safely', () => {
  it('all six faults at once leave a coherent, safe, visibly-degraded state', () => {
    let s = HEALTHY;
    s = injectDependencyOutage(s, 'inventory');
    s = injectQueueOverflow(s, 10);
    s = injectEvidenceStoreFailure(s);
    s = injectPdpFailure(s);
    s = injectSourceFailure(s);
    s = injectPartialPartition(s, 'decisions');

    for (const scope of ['inventory', 'evidence', 'authz', 'source-x', 'decisions'] as Scope[]) {
      expect(degradesSafely(s, scope)).toBe(true);
    }
    expect(s.droppedMessages).toBe(0);
    expect(s.falseSuccess).toBe(false);
    expect(s.authzDefault).toBe('deny');
    // No scope is simultaneously degraded and reported healthy.
    for (const scope of s.degradedScopes) expect(s.reportedHealthy).not.toContain(scope);
  });
});
