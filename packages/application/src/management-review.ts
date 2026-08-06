// @trustcircle/application — MANAGEMENT REVIEW: record a periodic management review with participants,
// inputs, decisions, and outputs, on a declared cadence (Phase 7 / User Story 5 — Demonstrate
// Compliance and Audit Readiness / FR-034, FR-035).
//
// Pure functions over injected facts; every instant injected. A review MUST have at least one
// participant and a non-empty input set (a review of nothing is vacuous). The next-due instant is
// derived from the cadence so a lapsed review cadence is surfaced (never inferred as still-current).

import type { Uuid, EpochMillis } from '@trustcircle/domain';

export type ReviewCadence = 'monthly' | 'quarterly' | 'biannual' | 'annual';

export interface ManagementReview {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly cadence: ReviewCadence;
  readonly participants: readonly Uuid[];
  readonly inputs: readonly string[];
  readonly decisions: readonly string[];
  readonly outputs: readonly string[];
  readonly heldAt: EpochMillis;
  readonly nextDueAt: EpochMillis;
}

const CADENCE_MILLIS: Readonly<Record<ReviewCadence, number>> = Object.freeze({
  monthly: 30 * 24 * 60 * 60 * 1000,
  quarterly: 91 * 24 * 60 * 60 * 1000,
  biannual: 182 * 24 * 60 * 60 * 1000,
  annual: 365 * 24 * 60 * 60 * 1000,
});

export interface HoldReviewCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly cadence: ReviewCadence;
  readonly participants: readonly Uuid[];
  readonly inputs: readonly string[];
  readonly decisions?: readonly string[];
  readonly outputs?: readonly string[];
  readonly heldAt: EpochMillis;
}

export type ReviewRejectionCode = 'NO_PARTICIPANTS' | 'NO_INPUTS';

export interface HoldReviewOutcome {
  readonly accepted: boolean;
  readonly review: ManagementReview | null;
  readonly rejectionCode: ReviewRejectionCode | null;
}

/** Record a management review. Refuses an empty participant set or an empty input set. */
export function holdManagementReview(cmd: HoldReviewCommand): HoldReviewOutcome {
  if (!Array.isArray(cmd.participants) || cmd.participants.length < 1) {
    return { accepted: false, review: null, rejectionCode: 'NO_PARTICIPANTS' };
  }
  if (!Array.isArray(cmd.inputs) || cmd.inputs.length < 1) {
    return { accepted: false, review: null, rejectionCode: 'NO_INPUTS' };
  }
  const review: ManagementReview = Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    cadence: cmd.cadence,
    participants: Object.freeze([...cmd.participants]),
    inputs: Object.freeze([...cmd.inputs]),
    decisions: Object.freeze([...(cmd.decisions ?? [])]),
    outputs: Object.freeze([...(cmd.outputs ?? [])]),
    heldAt: cmd.heldAt,
    nextDueAt: (cmd.heldAt + CADENCE_MILLIS[cmd.cadence]) as EpochMillis,
  });
  return { accepted: true, review, rejectionCode: null };
}

/** True iff the review cadence has lapsed at `now` (next review is due/overdue). */
export function reviewCadenceLapsed(r: ManagementReview, now: EpochMillis): boolean {
  return now >= r.nextDueAt;
}
