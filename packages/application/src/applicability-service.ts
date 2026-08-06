// @trustcircle/application — APPLICABILITY SERVICE: the guarded, versioned applicability-decision
// lifecycle (Phase 7 / User Story 5 — Demonstrate Compliance and Audit Readiness / FR-052..056,
// SC-022).
//
// A tenant compliance owner PROPOSES an applicability decision for a clause × system × scope; an
// INDEPENDENT reviewer (distinct from the proposer AND the affected control owner) approves it before
// it ACTIVATES and begins driving obligations (FR-053). Every review action produces EXACTLY ONE
// durable outcome — accepted (a new active/rejected/changes decision) or rejected (a durable, explained
// refusal) — and every change is a NEW VERSION superseding the prior (FR-056). A `not_applicable`
// decision is retained with its justification/evidence/owner/review date and does NOT silently
// suppress a gap once its review instant passes (FR-054, decided by the coverage engine).
//
// This is a PURE decision function over injected facts: the current decision (if any), the ALREADY
// RESOLVED independent-review verdict (from @trustcircle/authz evaluateApplicabilityReview), and an
// injected `now`. It does not itself resolve independence or persist. Determinism: all instants injected.

import {
  makeApplicabilityDecision,
  applicabilityDecisionDigest,
  applicabilityVersionSupersedes,
  type ApplicabilityDecision,
  type ApplicabilityResult,
  type ApplicabilityAction,
  type Uuid,
  type EpochMillis,
  type Reason,
} from '@trustcircle/domain';
import type { ComplianceReviewEvaluation } from '@trustcircle/authz';

export type ApplicabilityRejectionCode =
  | 'NOT_INDEPENDENTLY_REVIEWED' // reviewer not distinct from proposer/control-owner or lacks the role
  | 'NO_DECISION_TO_REVIEW' // a review action arrived with no proposed decision to act on
  | 'ALREADY_TERMINAL' // the decision is already rejected/expired/superseded
  | 'STALE_VERSION' // the actor reviewed an out-of-date version
  | 'MISSING_REASON' // no structured reason on the attempt
  | 'ILLEGAL_TRANSITION'; // the action is not valid from the current state

// The proposal a tenant compliance owner submits (mirrors the governance-api ApplicabilityProposal).
export interface ApplicabilityProposalCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly clauseVersionId: Uuid;
  readonly systemId: Uuid;
  readonly jurisdiction: string;
  readonly useCase?: Record<string, unknown>;
  readonly proposedResult: ApplicabilityResult;
  readonly rationale: string;
  readonly evidenceIds: readonly Uuid[];
  readonly obligationOwnerPrincipalId?: Uuid;
  readonly proposerPrincipalId: Uuid;
  readonly effectiveFrom?: EpochMillis;
  readonly reviewAt: EpochMillis;
  readonly now: EpochMillis;
}

// A review action against an existing proposed decision.
export interface ApplicabilityActionCommand {
  readonly current: ApplicabilityDecision;
  readonly action: ApplicabilityAction;
  readonly reviewerPrincipalId: Uuid;
  readonly reviewReason: Reason;
  /** Optimistic-concurrency token: the version the reviewer acted against. */
  readonly expectedVersion: number;
  /** The independence verdict resolved by @trustcircle/authz evaluateApplicabilityReview. */
  readonly review: ComplianceReviewEvaluation;
  /** The id for the NEW superseding decision row. */
  readonly newDecisionId: Uuid;
  readonly now: EpochMillis;
}

export interface ApplicabilityOutcome {
  readonly accepted: boolean;
  readonly decision: ApplicabilityDecision;
  readonly digest: string;
  readonly rejectionCode: ApplicabilityRejectionCode | null;
}

const TERMINAL_STATES: ReadonlySet<ApplicabilityDecision['state']> = new Set([
  'rejected',
  'expired',
  'superseded',
]);

/** The accepted next state for each review action. */
const ACTION_STATE: Readonly<Record<ApplicabilityAction, ApplicabilityDecision['state']>> =
  Object.freeze({
    approve: 'active',
    reject: 'rejected',
    request_changes: 'changes_requested',
    expire: 'expired',
  });

function reasonMissing(r: Reason | undefined | null): boolean {
  return (
    r === undefined ||
    r === null ||
    typeof r.code !== 'string' ||
    r.code.trim().length === 0 ||
    typeof r.text !== 'string' ||
    r.text.trim().length < 3
  );
}

/**
 * PROPOSE a new applicability decision (version 1, state `proposed`). The proposal is always durable;
 * activation requires a later independent review. Throws (via the domain factory) on a malformed
 * proposal — e.g. no supporting evidence — so a vacuous proposal is never recorded.
 */
export function proposeApplicability(cmd: ApplicabilityProposalCommand): ApplicabilityOutcome {
  const decision = makeApplicabilityDecision({
    id: cmd.id,
    tenantId: cmd.tenantId,
    clauseVersionId: cmd.clauseVersionId,
    systemId: cmd.systemId,
    jurisdiction: cmd.jurisdiction,
    ...(cmd.useCase ? { useCase: cmd.useCase } : {}),
    proposedResult: cmd.proposedResult,
    rationale: cmd.rationale,
    evidenceIds: cmd.evidenceIds,
    ...(cmd.obligationOwnerPrincipalId
      ? { obligationOwnerPrincipalId: cmd.obligationOwnerPrincipalId }
      : {}),
    proposerPrincipalId: cmd.proposerPrincipalId,
    state: 'proposed',
    ...(cmd.effectiveFrom ? { effectiveFrom: cmd.effectiveFrom } : {}),
    reviewAt: cmd.reviewAt,
    version: 1,
    createdAt: cmd.now,
  });
  return {
    accepted: true,
    decision,
    digest: applicabilityDecisionDigest(decision),
    rejectionCode: null,
  };
}

function rejectAction(
  cmd: ApplicabilityActionCommand,
  code: ApplicabilityRejectionCode,
): ApplicabilityOutcome {
  // The refusal is itself durable: we re-emit the CURRENT decision unchanged as the outcome record,
  // and surface the rejection code. (The transport layer persists a rejected attempt alongside.)
  return {
    accepted: false,
    decision: cmd.current,
    digest: applicabilityDecisionDigest(cmd.current),
    rejectionCode: code,
  };
}

/**
 * Apply a review ACTION to an existing proposed decision, producing EXACTLY ONE outcome. On accept it
 * returns a NEW decision row at version+1 that SUPERSEDES the current one (append-only, FR-056); on an
 * `approve` this is the ACTIVE decision, only reachable when the injected independence verdict permits
 * and activates (FR-053). Rejection ordering: terminal state → reason presence → stale version →
 * illegal transition → independence verdict. Every branch is durable and explained.
 */
export function reviewApplicability(cmd: ApplicabilityActionCommand): ApplicabilityOutcome {
  const { current, action } = cmd;

  if (TERMINAL_STATES.has(current.state)) return rejectAction(cmd, 'ALREADY_TERMINAL');
  if (reasonMissing(cmd.reviewReason)) return rejectAction(cmd, 'MISSING_REASON');
  if (cmd.expectedVersion !== current.version) return rejectAction(cmd, 'STALE_VERSION');
  if (!(action in ACTION_STATE)) return rejectAction(cmd, 'ILLEGAL_TRANSITION');

  // An `approve` MUST be backed by a permitted, ACTIVATING independence verdict (FR-053). Any other
  // action (reject/request_changes/expire) does not activate and only needs a permitted verdict.
  if (action === 'approve' && !(cmd.review.permitted && cmd.review.activates)) {
    return rejectAction(cmd, 'NOT_INDEPENDENTLY_REVIEWED');
  }
  if (action !== 'approve' && !cmd.review.permitted) {
    return rejectAction(cmd, 'NOT_INDEPENDENTLY_REVIEWED');
  }

  const nextState = ACTION_STATE[action];
  const next = makeApplicabilityDecision({
    id: cmd.newDecisionId,
    tenantId: current.tenantId,
    clauseVersionId: current.clauseVersionId,
    systemId: current.systemId,
    jurisdiction: current.jurisdiction,
    useCase: { ...current.useCase },
    proposedResult: current.proposedResult,
    rationale: current.rationale,
    evidenceIds: current.evidenceIds,
    ...(current.obligationOwnerPrincipalId
      ? { obligationOwnerPrincipalId: current.obligationOwnerPrincipalId }
      : {}),
    proposerPrincipalId: current.proposerPrincipalId,
    reviewerPrincipalId: cmd.reviewerPrincipalId,
    reviewDecision: action,
    reviewReason: cmd.reviewReason,
    state: nextState,
    ...(current.effectiveFrom ? { effectiveFrom: current.effectiveFrom } : {}),
    reviewAt: current.reviewAt,
    version: current.version + 1,
    supersedesId: current.id,
    createdAt: cmd.now,
  });

  // Defence in depth: the new row MUST be a valid supersession of the current one.
  if (!applicabilityVersionSupersedes(current, next)) {
    return rejectAction(cmd, 'ILLEGAL_TRANSITION');
  }

  return {
    accepted: true,
    decision: next,
    digest: applicabilityDecisionDigest(next),
    rejectionCode: null,
  };
}

/** The accepted next state for a review action (exposed for the projector / UI state machine). */
export function acceptedStateFor(action: ApplicabilityAction): ApplicabilityDecision['state'] {
  return ACTION_STATE[action];
}
