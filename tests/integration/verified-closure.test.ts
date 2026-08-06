// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — VERIFIED CLOSURE (T125 · FR-022 · SC-009).
//
// INTEGRATION oracle for the Verified Closure Gate (`verifyClosure`, gateResultsFrom,
// packages/application/src/verification-service.ts). FR-022 is the anti-masquerade boundary of the
// whole containment/repair flow: a case is closed ONLY by an INDEPENDENT verification in which ALL
// NINE gates pass. A source-reported "done", a self-verification, or eight-of-nine gates can NEVER
// close a case — closure is COMPUTED by the domain oracle from the gate facts + independence, never
// asserted by the caller.
//
// The service produces exactly ONE durable VerificationRecord whose `result` is the domain verdict,
// so a `passed` outcome provably means the gate held. Every passing case is paired with a NEGATIVE
// control flipping exactly one fact (drop independence, fail one gate) and proving closure is withheld
// with the failing gate named honestly.
//
// Pure application: no clock, no I/O. Ids are deterministic UUIDs from readable slugs. The nine gate
// facts and their 1:1 mapping to CLOSURE_GATES are exercised exhaustively.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { verifyClosure, gateResultsFrom, type ClosureGateFacts, type VerifyCommand } from '@trustcircle/application';
import {
  CLOSURE_GATES,
  makeReason,
  toUuid,
  type Uuid,
  type TenantId,
  type EpochMillis,
} from '@trustcircle/domain';

// ── Deterministic ids + fixed clock ──────────────────────────────────────────────────────────────

function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`verified-closure:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

const NOW = 1_772_070_000_000 as EpochMillis;
const TENANT = uuidFromSlug('tenant') as unknown as TenantId;

const ALL_TRUE: ClosureGateFacts = {
  originalsAndDerivativesPresent: true,
  ruleControlTestsPass: true,
  stateReconciledNoUncertainty: true,
  evidenceComplete: true,
  noUnresolvedCriticalDependency: true,
  residualRiskZeroOrExcepted: true,
  verifierIndependent: true,
  tenantAndCentralReviewsCurrent: true,
  closureTransitionAudited: true,
};

// The nine boolean fact keys, in the SAME order as CLOSURE_GATES, for exhaustive per-gate coverage.
const FACT_KEYS: readonly (keyof ClosureGateFacts)[] = [
  'originalsAndDerivativesPresent',
  'ruleControlTestsPass',
  'stateReconciledNoUncertainty',
  'evidenceComplete',
  'noUnresolvedCriticalDependency',
  'residualRiskZeroOrExcepted',
  'verifierIndependent',
  'tenantAndCentralReviewsCurrent',
  'closureTransitionAudited',
];

function verifyCommand(facts: ClosureGateFacts, overrides: Partial<VerifyCommand> = {}): VerifyCommand {
  return {
    id: uuidFromSlug('verification'),
    tenantId: TENANT,
    subjectType: 'integrity_case',
    subjectId: uuidFromSlug('case'),
    subjectVersion: 4,
    verifierPrincipalId: uuidFromSlug('independent-verifier'),
    independenceCheckId: uuidFromSlug('independence-check'),
    evidenceManifestId: uuidFromSlug('evidence-manifest'),
    ruleControlVersions: ['rule@1', 'control@1'],
    facts,
    verifiedAt: NOW,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('FR-022 — the nine-gate mapping is total and ordered', () => {
  it('gateResultsFrom emits exactly the nine gates in canonical order', () => {
    expect(CLOSURE_GATES.length).toBe(9);
    const results = gateResultsFrom(ALL_TRUE);
    expect(results.map((r) => r.gate)).toEqual([...CLOSURE_GATES]);
    expect(results.every((r) => r.result === 'passed')).toBe(true);
    expect(FACT_KEYS.length).toBe(9);
  });
});

describe('FR-022 — closure is permitted only on an independent nine-gate pass', () => {
  it('closes the case when all nine gates pass and the verifier is independent', () => {
    const out = verifyClosure(verifyCommand(ALL_TRUE));
    expect(out.result).toBe('passed');
    expect(out.closurePermitted).toBe(true);
    expect(out.failingGates).toEqual([]);
    // The durable record is the verdict — the closure claim is checkable from the record itself.
    expect(out.record.result).toBe('passed');
    expect(out.record.verifierIndependent).toBe(true);
    expect(out.record.subjectType).toBe('integrity_case');
    expect(out.record.gateResults.length).toBe(9);
  });

  it('NEGATIVE — a dependent verifier can never close, even with all gates green', () => {
    const out = verifyClosure(verifyCommand({ ...ALL_TRUE, verifierIndependent: false }));
    expect(out.result).toBe('failed');
    expect(out.closurePermitted).toBe(false);
    // The independence gate is named among the failing gates.
    expect(out.failingGates).toContain('verifier_independent');
  });

  // Exhaustive: dropping ANY single gate withholds closure and names THAT gate honestly.
  it.each(FACT_KEYS.map((k, i) => [k, CLOSURE_GATES[i]!] as const))(
    'NEGATIVE — failing gate fact %s withholds closure and names %s',
    (factKey, gate) => {
      const out = verifyClosure(verifyCommand({ ...ALL_TRUE, [factKey]: false }));
      expect(out.closurePermitted).toBe(false);
      expect(out.result).not.toBe('passed');
      expect(out.failingGates).toContain(gate);
      // The record still exists and is well-formed — a withheld closure is an honest, durable record.
      expect(out.record.gateResults.find((r) => r.gate === gate)?.result).toBe('failed');
    },
  );

  it('a passed and a withheld closure both mint a record with a structured reason', () => {
    const passed = verifyClosure(verifyCommand(ALL_TRUE));
    const withheld = verifyClosure(verifyCommand({ ...ALL_TRUE, evidenceComplete: false }));
    expect(passed.record.reason.code).toBe('verified_closure');
    expect(withheld.record.reason.code).toBe('closure_gate_unmet');
    expect(withheld.record.reason.text).toContain('evidence_complete');
  });

  it('the reason we thread is well-formed (guards the makeReason contract)', () => {
    // Sanity: makeReason accepts the shape the service builds internally.
    const r = makeReason('verified_closure', 'all nine gates passed');
    expect(r.code).toBe('verified_closure');
  });
});
