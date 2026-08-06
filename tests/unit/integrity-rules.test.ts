// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — INTEGRITY DOMAIN RULES (T120 · FR-016..022 · GAR-004 · SC-006..009).
//
// Unit oracle for the integrity/remediation aggregates in @trustcircle/domain. Each block pins one
// load-bearing rule of "Contain and Repair Damaged Work Safely" AND its NEGATIVE control, so no
// assertion is vacuous:
//
//   • PRESERVED ORIGINAL (FR-017)     — a case CANNOT be constructed without an originalEvidenceId.
//   • OWNERSHIP HONESTY (FR-018)      — either a named owner OR an explicit gap; never a fabricated one.
//   • QUARANTINE CONTAINMENT (FR-019) — an active quarantine blocks its capabilities and must block ≥1;
//                                       a released/expired quarantine blocks nothing; inspection stays.
//   • BOUNDED AUTOMATIC REPAIR (GAR-004/FR-021) — pre_authorized_low_risk is admissible ONLY when it is
//                                       low-risk, non-destructive, and policy-bound; any deviation throws.
//   • VERIFIED CLOSURE GATE (FR-022)  — closure is `passed` ONLY when ALL NINE gates pass AND the
//                                       verifier is independent; a source-reported "done" can never
//                                       satisfy it. Missing/indeterminate → indeterminate; any fail or a
//                                       dependent verifier → failed. repaired/closed states must cite a
//                                       resolution verification.
//
// Pure domain: no clock, no I/O. Ids are deterministic UUIDs from readable slugs.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
  makeIntegrityCase,
  makeQuarantine,
  makeRemediationPlan,
  makeVerificationRecord,
  verifiedClosureResult,
  quarantineBlocks,
  quarantinePermitsInspection,
  isAutomaticEligible,
  isTerminalCaseState,
  integrityCaseDigest,
  CLOSURE_GATES,
  TERMINAL_CASE_STATES,
  toUuid,
  makeReason,
  type Uuid,
  type TenantId,
  type EpochMillis,
  type GateResult,
  type ClosureGate,
} from '@trustcircle/domain';

// ── Deterministic ids + fixed clock ──────────────────────────────────────────────────────────────

function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`integrity-rules:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

const NOW = 1_772_060_000_000 as EpochMillis;
const TENANT = uuidFromSlug('tenant') as unknown as TenantId;
const REASON = makeReason('integrity_rule', 'unit-test rationale for the integrity rule');

function baseCaseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidFromSlug('case'),
    tenantId: TENANT,
    workItemId: uuidFromSlug('work-item'),
    ruleVersionId: uuidFromSlug('rule-version'),
    sourceRecordId: uuidFromSlug('source-record'),
    originalEvidenceId: uuidFromSlug('original-evidence'),
    problemClass: 'corrupted' as const,
    confidence: 0.9,
    ownerPrincipalId: uuidFromSlug('owner'),
    detectedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ── FR-017 — a case cannot exist without a preserved original ────────────────────────────────────

describe('FR-017 — preserved original is mandatory', () => {
  it('constructs a case when an original evidence id is supplied', () => {
    const c = makeIntegrityCase(baseCaseInput());
    expect(c.originalEvidenceId).toBe(uuidFromSlug('original-evidence'));
    expect(c.evidenceStatus).toBe('preserved'); // default is the preserved posture
  });

  it('NEGATIVE — refuses a case with no/invalid original evidence id', () => {
    expect(() => makeIntegrityCase(baseCaseInput({ originalEvidenceId: 'not-a-uuid' }))).toThrow();
  });
});

// ── FR-018 — ownership is a named owner OR an explicit gap, never fabricated ─────────────────────

describe('FR-018 — ownership honesty', () => {
  it('records an explicit ownership gap with no owner', () => {
    const c = makeIntegrityCase(baseCaseInput({ ownerPrincipalId: null }));
    expect(c.ownershipGap).toBe(true);
    expect(c.ownerPrincipalId).toBeNull();
  });

  it('records a named owner with no gap', () => {
    const c = makeIntegrityCase(baseCaseInput());
    expect(c.ownershipGap).toBe(false);
    expect(c.ownerPrincipalId).toBe(uuidFromSlug('owner'));
  });

  it('NEGATIVE — refuses a fabricated owner alongside an asserted gap', () => {
    expect(() =>
      makeIntegrityCase(
        baseCaseInput({ ownershipGap: true, ownerPrincipalId: uuidFromSlug('owner') }),
      ),
    ).toThrow(/ownershipGap/);
  });
});

// ── FR-019 — quarantine contains unsafe effects while keeping the item inspectable ───────────────

describe('FR-019 — quarantine containment', () => {
  const quarantineInput = (overrides: Record<string, unknown> = {}) => ({
    id: uuidFromSlug('quarantine'),
    tenantId: TENANT,
    integrityCaseId: uuidFromSlug('case'),
    blockedCapabilities: ['governed_publish', 'downstream_consume'],
    reason: REASON,
    originalEvidenceId: uuidFromSlug('original-evidence'),
    reviewDueAt: (NOW + 86_400_000) as EpochMillis,
    startedAt: NOW,
    ...overrides,
  });

  it('an active quarantine blocks its listed capabilities but still permits inspection', () => {
    const q = makeQuarantine(quarantineInput());
    expect(quarantineBlocks(q, 'governed_publish')).toBe(true);
    expect(quarantineBlocks(q, 'downstream_consume')).toBe(true);
    expect(quarantinePermitsInspection(q)).toBe(true);
    // NEGATIVE — a capability it does not list is not blocked.
    expect(quarantineBlocks(q, 'unrelated_capability')).toBe(false);
  });

  it('NEGATIVE — an active quarantine must block at least one capability', () => {
    expect(() => makeQuarantine(quarantineInput({ blockedCapabilities: [] }))).toThrow(/block/);
  });

  it('NEGATIVE — a released quarantine blocks nothing (containment is lifted only by a decision)', () => {
    const q = makeQuarantine(
      quarantineInput({ status: 'released', releaseDecisionId: uuidFromSlug('release-decision') }),
    );
    expect(quarantineBlocks(q, 'governed_publish')).toBe(false);
  });

  it('NEGATIVE — a released quarantine must name its release decision', () => {
    expect(() => makeQuarantine(quarantineInput({ status: 'released' }))).toThrow(
      /releaseDecisionId/,
    );
  });
});

// ── GAR-004 / FR-021 — pre-authorized automatic repair is bounded ────────────────────────────────

describe('GAR-004 / FR-021 — bounded automatic repair', () => {
  const planInput = (overrides: Record<string, unknown> = {}) => ({
    id: uuidFromSlug('plan'),
    tenantId: TENANT,
    integrityCaseId: uuidFromSlug('case'),
    rationale: 'restore the deterministic derivative from the preserved original',
    ownerPrincipalId: uuidFromSlug('owner'),
    expiresAt: (NOW + 3_600_000) as EpochMillis,
    createdAt: NOW,
    ...overrides,
  });

  it('a low-risk, non-destructive, policy-bound plan is automatic-eligible', () => {
    const p = makeRemediationPlan(
      planInput({
        authorizationMode: 'pre_authorized_low_risk',
        riskClass: 'low',
        destructive: false,
        policyVersionId: uuidFromSlug('policy-version'),
      }),
    );
    expect(isAutomaticEligible(p)).toBe(true);
  });

  it('NEGATIVE — a human-mode plan is never automatic-eligible', () => {
    const p = makeRemediationPlan(planInput({ authorizationMode: 'human', riskClass: 'medium' }));
    expect(isAutomaticEligible(p)).toBe(false);
  });

  it('NEGATIVE — a destructive pre-authorized plan is rejected outright', () => {
    expect(() =>
      makeRemediationPlan(
        planInput({
          authorizationMode: 'pre_authorized_low_risk',
          riskClass: 'low',
          destructive: true,
          policyVersionId: uuidFromSlug('policy-version'),
        }),
      ),
    ).toThrow(/destructive/);
  });

  it('NEGATIVE — a non-low-risk pre-authorized plan is rejected outright', () => {
    expect(() =>
      makeRemediationPlan(
        planInput({
          authorizationMode: 'pre_authorized_low_risk',
          riskClass: 'high',
          policyVersionId: uuidFromSlug('policy-version'),
        }),
      ),
    ).toThrow(/riskClass=low/);
  });

  it('NEGATIVE — a pre-authorized plan with no bound policy is rejected outright', () => {
    expect(() =>
      makeRemediationPlan(
        planInput({ authorizationMode: 'pre_authorized_low_risk', riskClass: 'low' }),
      ),
    ).toThrow(/policyVersionId/);
  });
});

// ── FR-022 — the Verified Closure Gate: only an independent nine-gate pass closes a case ──────────

describe('FR-022 — verified closure gate', () => {
  const allPassing: readonly GateResult[] = CLOSURE_GATES.map((gate: ClosureGate) => ({
    gate,
    result: 'passed' as const,
  }));

  it('passes ONLY when every one of the nine gates passes and the verifier is independent', () => {
    expect(CLOSURE_GATES.length).toBe(9); // the gate count is load-bearing
    expect(verifiedClosureResult({ gateResults: allPassing, verifierIndependent: true })).toBe(
      'passed',
    );
  });

  it('NEGATIVE — a dependent verifier can never yield a pass, even with all gates green', () => {
    expect(verifiedClosureResult({ gateResults: allPassing, verifierIndependent: false })).toBe(
      'failed',
    );
  });

  it('NEGATIVE — any single failed gate fails closure', () => {
    const oneFailed = allPassing.map((g, i) => (i === 3 ? { ...g, result: 'failed' as const } : g));
    expect(verifiedClosureResult({ gateResults: oneFailed, verifierIndependent: true })).toBe(
      'failed',
    );
  });

  it('NEGATIVE — a missing gate yields indeterminate, never a pass (no source-reported "done")', () => {
    const missingOne = allPassing.slice(1); // drop gate 1
    expect(verifiedClosureResult({ gateResults: missingOne, verifierIndependent: true })).toBe(
      'indeterminate',
    );
  });

  it('a passed VerificationRecord requires all nine gates + independence at construction', () => {
    const rec = makeVerificationRecord({
      id: uuidFromSlug('verification'),
      tenantId: TENANT,
      subjectType: 'integrity_case',
      subjectId: uuidFromSlug('case'),
      subjectVersion: 3,
      verifierPrincipalId: uuidFromSlug('verifier'),
      independenceCheckId: uuidFromSlug('independence-check'),
      verifierIndependent: true,
      evidenceManifestId: uuidFromSlug('evidence-manifest'),
      gateResults: allPassing,
      result: 'passed',
      reason: REASON,
      verifiedAt: NOW,
    });
    expect(rec.result).toBe('passed');
    expect(rec.verifierIndependent).toBe(true);
  });

  it('NEGATIVE — a "passed" record with a dependent verifier is rejected at construction', () => {
    expect(() =>
      makeVerificationRecord({
        id: uuidFromSlug('verification'),
        tenantId: TENANT,
        subjectType: 'integrity_case',
        subjectId: uuidFromSlug('case'),
        subjectVersion: 3,
        verifierPrincipalId: uuidFromSlug('verifier'),
        independenceCheckId: uuidFromSlug('independence-check'),
        verifierIndependent: false,
        evidenceManifestId: uuidFromSlug('evidence-manifest'),
        gateResults: allPassing,
        result: 'passed',
        reason: REASON,
        verifiedAt: NOW,
      }),
    ).toThrow(/independent/);
  });

  it('NEGATIVE — a case cannot enter a closed/repaired state without a resolution verification', () => {
    expect(() => makeIntegrityCase(baseCaseInput({ state: 'closed' }))).toThrow(
      /resolutionVerificationId/,
    );
  });
});

// ── Terminal-state + digest determinism (guards against silent mutation) ─────────────────────────

describe('terminal states + digest determinism', () => {
  it('every declared terminal state reports terminal; a live state does not', () => {
    for (const s of TERMINAL_CASE_STATES) expect(isTerminalCaseState(s)).toBe(true);
    expect(isTerminalCaseState('detected')).toBe(false); // NEGATIVE control
  });

  it('the case digest is deterministic for identical inputs and changes on any field change', () => {
    const a = makeIntegrityCase(baseCaseInput());
    const b = makeIntegrityCase(baseCaseInput());
    expect(integrityCaseDigest(a)).toBe(integrityCaseDigest(b));
    const c = makeIntegrityCase(baseCaseInput({ severity: 'critical' }));
    expect(integrityCaseDigest(c)).not.toBe(integrityCaseDigest(a)); // NEGATIVE control
  });
});
