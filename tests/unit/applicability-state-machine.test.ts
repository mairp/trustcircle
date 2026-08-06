// TrustCircleAI — Task T185 (Phase 7 / User Story 5 — Demonstrate Compliance and Audit Readiness).
//
// Unit tests for the APPLICABILITY state machine: proposal, INDEPENDENT review, non-applicability
// expiry / reopened gaps, versioning + supersession, and the durable rejection/invalidation ordering.
// Requirements exercised: FR-052 (evidence-backed proposal), FR-053 (independent review gates
// activation), FR-054 (a stale non-applicability must reopen its coverage gap).
//
// Every assertion observes a GENUINE returned value from the REAL domain (`@trustcircle/domain`),
// the REAL application service (`@trustcircle/application`), and the REAL authz independence guard
// (`@trustcircle/authz`) over the shared compliance fixtures — never a mutation echo. Each positive
// case is paired with a NEGATIVE control so no invariant passes vacuously.

import { describe, it, expect } from 'vitest';

import {
  makeApplicabilityDecision,
  applicabilityIsActive,
  nonApplicabilityReopensGap,
  applicabilityVersionSupersedes,
  makeReason,
  type ApplicabilityDecision,
  type Reason,
  type Uuid,
  type EpochMillis,
} from '@trustcircle/domain';

import {
  proposeApplicability,
  reviewApplicability,
  acceptedStateFor,
  type ApplicabilityProposalCommand,
  type ApplicabilityActionCommand,
  type ApplicabilityOutcome,
} from '@trustcircle/application';

import {
  evaluateApplicabilityReview,
  type ApplicabilityReviewContext,
} from '@trustcircle/authz';

import {
  NOW,
  TENANT,
  COMPLIANCE_OWNER,
  INDEPENDENT_REVIEWER,
  CONTROL_OWNER,
  DECISION_READY,
  DECISION_PROPOSED,
  DECISION_REOPENED_NA,
  CLAUSE_READY,
  IDS,
} from '../fixtures/compliance.ts';

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Local, deterministic helpers — no wall clock, no RNG. Ids are pinned constants the domain accepts.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const TENANT_ID = TENANT as unknown as Uuid;
const ONE_DAY = 86_400_000;

const PROPOSAL_ID = '0f1e2d3c-4b5a-7c8d-9e0f-a1b2c3d4e5f6' as Uuid;
const NEW_DECISION_ID = '1a2b3c4d-5e6f-7a8b-9c0d-e1f2a3b4c5d6' as Uuid;
const EVIDENCE_ID = IDS.EVIDENCE_APPLICABILITY;

const APPROVE_REASON: Reason = makeReason('independent_review_approved', 'Independent reviewer approved.');

function proposalCommand(
  overrides: Partial<ApplicabilityProposalCommand> = {},
): ApplicabilityProposalCommand {
  return {
    id: PROPOSAL_ID,
    tenantId: TENANT_ID,
    clauseVersionId: CLAUSE_READY.id,
    systemId: IDS.SYSTEM_ID,
    jurisdiction: 'EU',
    useCase: { domain: 'credit-underwriting' },
    proposedResult: 'applicable',
    rationale: 'The clause applies to the underwriting system.',
    evidenceIds: [EVIDENCE_ID],
    obligationOwnerPrincipalId: CONTROL_OWNER,
    proposerPrincipalId: COMPLIANCE_OWNER,
    reviewAt: (NOW + 180 * ONE_DAY) as EpochMillis,
    now: NOW,
    ...overrides,
  };
}

function reviewContext(
  overrides: Partial<ApplicabilityReviewContext> = {},
): ApplicabilityReviewContext {
  return {
    proposerPrincipalId: COMPLIANCE_OWNER,
    controlOwnerPrincipalId: CONTROL_OWNER,
    reviewerPrincipalId: INDEPENDENT_REVIEWER,
    reviewerRoles: ['independent_compliance_reviewer'],
    action: 'approve',
    ...overrides,
  };
}

function actionCommand(
  overrides: Partial<ApplicabilityActionCommand> = {},
): ApplicabilityActionCommand {
  const current = overrides.current ?? DECISION_PROPOSED;
  return {
    current,
    action: 'approve',
    reviewerPrincipalId: INDEPENDENT_REVIEWER,
    reviewReason: APPROVE_REASON,
    expectedVersion: current.version,
    review: evaluateApplicabilityReview(reviewContext()),
    newDecisionId: NEW_DECISION_ID,
    now: NOW,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. PROPOSAL (FR-052) — a proposal is durable but NEVER active, and requires ≥ 1 evidence id.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('applicability PROPOSAL (FR-052)', () => {
  it('produces a durable proposed decision that is never active', () => {
    const outcome: ApplicabilityOutcome = proposeApplicability(proposalCommand());

    expect(outcome.accepted).toBe(true);
    expect(outcome.rejectionCode).toBeNull();
    expect(outcome.decision.state).toBe('proposed');
    expect(outcome.decision.version).toBe(1);
    // A stable, non-empty digest is emitted for the durable proposal record.
    expect(typeof outcome.digest).toBe('string');
    expect(outcome.digest.length).toBeGreaterThan(0);
    // Determinism: the same proposal digests identically.
    expect(proposeApplicability(proposalCommand()).digest).toBe(outcome.digest);
    // A proposal is NEVER active — activation requires a later independent review (FR-053).
    expect(applicabilityIsActive(outcome.decision)).toBe(false);
  });

  it('NEGATIVE CONTROL: a proposal with zero evidence ids is rejected (never recorded)', () => {
    expect(() => proposeApplicability(proposalCommand({ evidenceIds: [] }))).toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. INDEPENDENT REVIEW (FR-053) — an independent approve activates; self-review does not.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('applicability INDEPENDENT REVIEW — approve activates (FR-053)', () => {
  it('an independent reviewer approving yields a permitted, activating verdict and an ACTIVE decision', () => {
    const verdict = evaluateApplicabilityReview(reviewContext());
    expect(verdict.permitted).toBe(true);
    expect(verdict.activates).toBe(true);
    expect(verdict.violations).toHaveLength(0);
    // The domain-projected accepted state for an approve is `active`.
    expect(acceptedStateFor('approve')).toBe('active');

    const outcome = reviewApplicability(actionCommand({ review: verdict }));

    expect(outcome.accepted).toBe(true);
    expect(outcome.rejectionCode).toBeNull();
    expect(outcome.decision.state).toBe('active');
    expect(outcome.decision.reviewerPrincipalId).toBe(INDEPENDENT_REVIEWER);
    expect(outcome.decision.reviewDecision).toBe('approve');
    // The activated decision passes the domain's independent-activation predicate (FR-053).
    expect(applicabilityIsActive(outcome.decision)).toBe(true);
    // It is a new version superseding the proposal.
    expect(outcome.decision.version).toBe(DECISION_PROPOSED.version + 1);
    expect(outcome.decision.supersedesId).toBe(DECISION_PROPOSED.id);
  });

  it('NEGATIVE CONTROL: reviewer === proposer is not independent and cannot activate', () => {
    const verdict = evaluateApplicabilityReview(
      reviewContext({ reviewerPrincipalId: COMPLIANCE_OWNER }),
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.activates).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('REVIEWER_IS_PROPOSER');

    // A self-review action is rejected as NOT_INDEPENDENTLY_REVIEWED, and the current row is unchanged.
    const outcome = reviewApplicability(
      actionCommand({ reviewerPrincipalId: COMPLIANCE_OWNER, review: verdict }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejectionCode).toBe('NOT_INDEPENDENTLY_REVIEWED');
    expect(outcome.decision).toBe(DECISION_PROPOSED);
    expect(applicabilityIsActive(outcome.decision)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. INCOMPATIBLE REVIEWER ROLE (FR-053) — the reviewer must be role-independent of the proposal.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('applicability INDEPENDENT REVIEW — incompatible reviewer role (FR-053)', () => {
  it('a reviewer also holding control_owner is not permitted (INCOMPATIBLE_ROLE)', () => {
    const verdict = evaluateApplicabilityReview(
      reviewContext({
        reviewerPrincipalId: INDEPENDENT_REVIEWER,
        reviewerRoles: ['independent_compliance_reviewer', 'control_owner'],
      }),
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.activates).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('REVIEWER_INCOMPATIBLE_ROLE');
  });

  it('a reviewer also holding tenant_compliance_owner is not permitted (INCOMPATIBLE_ROLE)', () => {
    const verdict = evaluateApplicabilityReview(
      reviewContext({
        reviewerRoles: ['independent_compliance_reviewer', 'tenant_compliance_owner'],
      }),
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('REVIEWER_INCOMPATIBLE_ROLE');
  });

  it('a reviewer lacking the independent role is not permitted (NOT_INDEPENDENT_ROLE)', () => {
    const verdict = evaluateApplicabilityReview(
      reviewContext({ reviewerRoles: ['auditor'] }),
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.violations.map((v) => v.code)).toContain('REVIEWER_NOT_INDEPENDENT_ROLE');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. VERSIONING / SUPERSESSION (FR-056) — every accepted review is a strictly-newer superseding row.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('applicability VERSIONING / supersession (FR-056)', () => {
  it('an accepted review produces version+1 that supersedes the prior row', () => {
    const outcome = reviewApplicability(actionCommand());
    expect(outcome.accepted).toBe(true);

    const next = outcome.decision;
    expect(next.version).toBe(DECISION_PROPOSED.version + 1);
    // Domain supersession predicate: (prior, next) — next validly supersedes the proposal.
    expect(applicabilityVersionSupersedes(DECISION_PROPOSED, next)).toBe(true);
  });

  it('NEGATIVE CONTROL: the reverse supersession (next, prior) is false', () => {
    const outcome = reviewApplicability(actionCommand());
    const next = outcome.decision;
    expect(applicabilityVersionSupersedes(next, DECISION_PROPOSED)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 5. NON-APPLICABILITY EXPIRY / REOPENED GAP (FR-054) — a stale not_applicable reopens its gap.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('non-applicability EXPIRY / reopened gap (FR-054)', () => {
  it('an active not_applicable whose review instant has PASSED reopens the gap', () => {
    // The fixture is `not_applicable`, active, with reviewAt in the past at NOW.
    expect(DECISION_REOPENED_NA.proposedResult).toBe('not_applicable');
    expect(DECISION_REOPENED_NA.reviewAt).toBeLessThan(NOW);
    expect(nonApplicabilityReopensGap(DECISION_REOPENED_NA, NOW)).toBe(true);
  });

  it('NEGATIVE CONTROL: an applicable decision (reviewAt in the future) never reopens', () => {
    expect(DECISION_READY.proposedResult).toBe('applicable');
    expect(DECISION_READY.reviewAt).toBeGreaterThan(NOW);
    expect(nonApplicabilityReopensGap(DECISION_READY, NOW)).toBe(false);
  });

  it('NEGATIVE CONTROL: an active not_applicable whose review is in the FUTURE does not reopen', () => {
    const futureNa: ApplicabilityDecision = makeApplicabilityDecision({
      id: PROPOSAL_ID,
      tenantId: TENANT_ID,
      clauseVersionId: CLAUSE_READY.id,
      systemId: IDS.SYSTEM_ID,
      jurisdiction: 'EU',
      proposedResult: 'not_applicable',
      rationale: 'Judged not applicable; its review window is still open.',
      evidenceIds: [EVIDENCE_ID],
      proposerPrincipalId: COMPLIANCE_OWNER,
      reviewerPrincipalId: INDEPENDENT_REVIEWER,
      reviewDecision: 'approve',
      reviewReason: APPROVE_REASON,
      state: 'active',
      reviewAt: (NOW + 90 * ONE_DAY) as EpochMillis,
      version: 1,
      createdAt: (NOW - 30 * ONE_DAY) as EpochMillis,
    });
    expect(futureNa.reviewAt).toBeGreaterThan(NOW);
    expect(nonApplicabilityReopensGap(futureNa, NOW)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 6. REJECTION ORDERING / INVALIDATION — terminal → missing reason → stale version → illegal → indep.
// ───────────────────────────────────────────────────────────────────────────────────────────────

describe('applicability REJECTION ordering / invalidation', () => {
  const TERMINAL_DECISION: ApplicabilityDecision = makeApplicabilityDecision({
    id: DECISION_PROPOSED.id,
    tenantId: TENANT_ID,
    clauseVersionId: CLAUSE_READY.id,
    systemId: IDS.SYSTEM_ID,
    jurisdiction: 'EU',
    proposedResult: 'applicable',
    rationale: 'A previously rejected applicability decision (terminal).',
    evidenceIds: [EVIDENCE_ID],
    proposerPrincipalId: COMPLIANCE_OWNER,
    reviewerPrincipalId: INDEPENDENT_REVIEWER,
    reviewDecision: 'reject',
    reviewReason: APPROVE_REASON,
    state: 'rejected',
    reviewAt: (NOW + 30 * ONE_DAY) as EpochMillis,
    version: 3,
    createdAt: (NOW - 30 * ONE_DAY) as EpochMillis,
  });

  // A structured but insufficient reason (text < 3 chars) that the service treats as MISSING.
  const SHORT_REASON = { code: 'r', text: 'ab' } as unknown as Reason;

  it('an already-terminal decision yields ALREADY_TERMINAL even when the reason is also missing', () => {
    const outcome = reviewApplicability(
      actionCommand({
        current: TERMINAL_DECISION,
        action: 'approve',
        reviewReason: SHORT_REASON,
        expectedVersion: 999, // also stale — but terminal precedes it in the ordering
      }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejectionCode).toBe('ALREADY_TERMINAL');
    // The refusal is durable: the current (terminal) row is re-emitted unchanged.
    expect(outcome.decision).toBe(TERMINAL_DECISION);
  });

  it('a missing reason precedes a stale version (MISSING_REASON)', () => {
    const outcome = reviewApplicability(
      actionCommand({ reviewReason: SHORT_REASON, expectedVersion: 999 }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejectionCode).toBe('MISSING_REASON');
  });

  it('a stale expectedVersion (reason present) yields STALE_VERSION', () => {
    const outcome = reviewApplicability(
      actionCommand({ expectedVersion: DECISION_PROPOSED.version + 5 }),
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejectionCode).toBe('STALE_VERSION');
    expect(outcome.decision).toBe(DECISION_PROPOSED);
  });
});
