// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — REMEDIATION BOUNDS (T124 · GAR-004 / FR-020 / FR-021 · SC-008).
//
// SECURITY oracle for the automatic-repair authorization policy (`evaluateAutomaticRepair`,
// packages/application/src/automatic-repair-policy.ts). GAR-004 is the load-bearing safety boundary:
// automation may execute ONLY a plan that is pre-authorized low-risk — non-destructive, low risk,
// bound to the CURRENT policy version, applied to the preserved original at the SAME source revision,
// carrying way-back (rollback) + way-to-prove (evidence/verification) plans, and within every declared
// bound (scope / rate / time-window / blast-radius / kill-switch / cancellation). Anything else must be
// DENIED — never silently escalated to automatic execution.
//
// Every permitted verdict here is paired with a NEGATIVE control that flips exactly ONE fact and proves
// the boundary denies, so no check is vacuous. Fail-closed: the FIRST failing gate is the deny reason.
//
// Pure policy: no clock, no I/O. Ids are deterministic UUIDs from readable slugs.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { evaluateAutomaticRepair, type AutoRepairContext } from '@trustcircle/application';
import {
  makeRemediationPlan,
  toUuid,
  type Uuid,
  type TenantId,
  type EpochMillis,
  type RemediationPlan,
} from '@trustcircle/domain';

// ── Deterministic ids + fixed clock ──────────────────────────────────────────────────────────────

function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`remediation-bounds:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

const NOW = 1_772_070_000_000 as EpochMillis;
const TENANT = uuidFromSlug('tenant') as unknown as TenantId;
const POLICY = uuidFromSlug('policy-version-current');
const REVISION = 'rev-42';

// A canonical pre-authorized-low-risk plan: low-risk, non-destructive, policy-bound, with rollback,
// stop-conditions, evidence + verification plans, and a set of declared bounds.
function planInput(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidFromSlug('plan'),
    tenantId: TENANT,
    integrityCaseId: uuidFromSlug('case'),
    rationale: 'restore the deterministic derivative from the preserved original',
    ownerPrincipalId: uuidFromSlug('owner'),
    authorizationMode: 'pre_authorized_low_risk' as const,
    riskClass: 'low' as const,
    destructive: false,
    policyVersionId: POLICY,
    status: 'approved' as const,
    proposedChange: { op: 'restore_derivative' },
    expectedResult: { matches: true },
    preconditions: [{ check: 'original_preserved' }],
    evidencePlan: { capture: ['before', 'after'] },
    verificationPlan: { gates: 'all_nine' },
    stopConditions: [{ on: 'unexpected_write' }],
    rollbackPlan: { restore: 'checkpoint' },
    bounds: {
      maxAffectedItems: 100,
      maxAttemptsPerWindow: 3,
      windowStart: NOW - 3_600_000,
      windowEnd: NOW + 3_600_000,
      maxBlastRadius: 5,
    },
    expiresAt: (NOW + 3_600_000) as EpochMillis,
    createdAt: (NOW - 3_600_000) as EpochMillis,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): RemediationPlan {
  return makeRemediationPlan(planInput(overrides));
}

function ctx(overrides: Partial<AutoRepairContext> = {}): AutoRepairContext {
  return {
    plan: plan(),
    currentPolicyVersionId: POLICY,
    originalPreserved: true,
    planSourceRevision: REVISION,
    observedSourceRevision: REVISION,
    killSwitchEngaged: false,
    caseCancelled: false,
    requestedAffectedItems: 10,
    requestedBlastRadius: 2,
    attemptsInWindow: 0,
    now: NOW,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('GAR-004 — a pre-authorized low-risk plan is permitted only inside its bounds', () => {
  it('PERMITS the canonical pre-authorized low-risk plan and binds the current policy version', () => {
    const v = evaluateAutomaticRepair(ctx());
    expect(v.permitted).toBe(true);
    expect(v.denyReason).toBeNull();
    expect(v.appliedPolicyVersionId).toBe(POLICY);
  });

  // The construction-time boundary (makeRemediationPlan throws) is covered in the unit oracle; here we
  // exercise a plan that IS shape-eligible but is denied by an EFFECT-TIME fact — GAR-004's other half.

  it('NEGATIVE — a human-mode plan is NOT_SHAPE_ELIGIBLE (never auto-executes)', () => {
    const v = evaluateAutomaticRepair(
      ctx({ plan: plan({ authorizationMode: 'human', riskClass: 'medium' }) }),
    );
    expect(v.permitted).toBe(false);
    expect(v.denyReason).toBe('NOT_SHAPE_ELIGIBLE');
  });

  it('NEGATIVE — an unapproved plan is denied NOT_APPROVED', () => {
    const v = evaluateAutomaticRepair(ctx({ plan: plan({ status: 'pending_approval' }) }));
    expect(v.denyReason).toBe('NOT_APPROVED');
  });

  it('NEGATIVE — an expired plan is denied PLAN_EXPIRED', () => {
    const v = evaluateAutomaticRepair(ctx({ now: (NOW + 7_200_000) as EpochMillis }));
    expect(v.denyReason).toBe('PLAN_EXPIRED');
  });

  it('NEGATIVE — an unavailable PDP fails closed (POLICY_UNAVAILABLE)', () => {
    const v = evaluateAutomaticRepair(ctx({ currentPolicyVersionId: null }));
    expect(v.denyReason).toBe('POLICY_UNAVAILABLE');
  });

  it('NEGATIVE — a superseded policy version cannot authorize (POLICY_SUPERSEDED)', () => {
    const v = evaluateAutomaticRepair(
      ctx({ currentPolicyVersionId: uuidFromSlug('policy-version-newer') }),
    );
    expect(v.denyReason).toBe('POLICY_SUPERSEDED');
  });

  it('NEGATIVE — repair before preservation is denied ORIGINAL_NOT_PRESERVED (FR-017)', () => {
    const v = evaluateAutomaticRepair(ctx({ originalPreserved: false }));
    expect(v.denyReason).toBe('ORIGINAL_NOT_PRESERVED');
  });

  it('NEGATIVE — source-revision drift invalidates the plan (SOURCE_REVISION_DRIFT)', () => {
    const v = evaluateAutomaticRepair(ctx({ observedSourceRevision: 'rev-43' }));
    expect(v.denyReason).toBe('SOURCE_REVISION_DRIFT');
  });

  it('NEGATIVE — a plan without a rollback plan is denied MISSING_ROLLBACK_PLAN', () => {
    const v = evaluateAutomaticRepair(ctx({ plan: plan({ rollbackPlan: {} }) }));
    expect(v.denyReason).toBe('MISSING_ROLLBACK_PLAN');
  });

  it('NEGATIVE — a plan without stop conditions is denied MISSING_STOP_CONDITIONS', () => {
    const v = evaluateAutomaticRepair(ctx({ plan: plan({ stopConditions: [] }) }));
    expect(v.denyReason).toBe('MISSING_STOP_CONDITIONS');
  });

  it('NEGATIVE — a plan without an evidence plan is denied MISSING_EVIDENCE_PLAN', () => {
    const v = evaluateAutomaticRepair(ctx({ plan: plan({ evidencePlan: {} }) }));
    expect(v.denyReason).toBe('MISSING_EVIDENCE_PLAN');
  });

  it('NEGATIVE — a plan without a verification plan is denied MISSING_VERIFICATION_PLAN', () => {
    const v = evaluateAutomaticRepair(ctx({ plan: plan({ verificationPlan: {} }) }));
    expect(v.denyReason).toBe('MISSING_VERIFICATION_PLAN');
  });
});

describe('GAR-004 — declared bounds fail closed when violated', () => {
  it('NEGATIVE — exceeding maxAffectedItems is denied OUT_OF_SCOPE', () => {
    const v = evaluateAutomaticRepair(ctx({ requestedAffectedItems: 101 }));
    expect(v.denyReason).toBe('OUT_OF_SCOPE');
  });

  it('NEGATIVE — reaching maxAttemptsPerWindow is denied RATE_LIMIT_EXCEEDED', () => {
    const v = evaluateAutomaticRepair(ctx({ attemptsInWindow: 3 }));
    expect(v.denyReason).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('NEGATIVE — acting before the window opens is denied OUTSIDE_TIME_WINDOW', () => {
    const v = evaluateAutomaticRepair(ctx({ now: (NOW - 7_200_000) as EpochMillis }));
    // Before the window but plan not yet expired — the time-window gate fires.
    expect(v.denyReason).toBe('OUTSIDE_TIME_WINDOW');
  });

  it('NEGATIVE — exceeding maxBlastRadius is denied BLAST_RADIUS_EXCEEDED', () => {
    const v = evaluateAutomaticRepair(ctx({ requestedBlastRadius: 6 }));
    expect(v.denyReason).toBe('BLAST_RADIUS_EXCEEDED');
  });

  it('NEGATIVE — an engaged kill switch stops automatic execution (KILL_SWITCH_ENGAGED)', () => {
    const v = evaluateAutomaticRepair(ctx({ killSwitchEngaged: true }));
    expect(v.denyReason).toBe('KILL_SWITCH_ENGAGED');
  });

  it('NEGATIVE — a cancelled case is denied CASE_CANCELLED', () => {
    const v = evaluateAutomaticRepair(ctx({ caseCancelled: true }));
    expect(v.denyReason).toBe('CASE_CANCELLED');
  });

  it('a permitted verdict never carries a deny reason and a denied verdict never applies a policy', () => {
    const ok = evaluateAutomaticRepair(ctx());
    const denied = evaluateAutomaticRepair(ctx({ killSwitchEngaged: true }));
    expect(ok.permitted && ok.denyReason === null && ok.appliedPolicyVersionId !== null).toBe(true);
    expect(denied.permitted).toBe(false);
    expect(denied.appliedPolicyVersionId).toBeNull();
  });
});
