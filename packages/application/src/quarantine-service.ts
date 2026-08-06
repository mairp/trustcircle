// @trustcircle/application — QUARANTINE SERVICE: block unsafe execution dependencies while
// preserving inspection, impact, owner, evidence, review, and release controls
// (Phase 5 / User Story 3 / FR-019).
//
// Quarantine is CONTAINMENT, not deletion. When a case's defect could propagate unsafe effects, the
// service opens a `Quarantine` that blocks the named execution capabilities (and downstream
// dependency work) while keeping the item VISIBLE and INSPECTABLE — a reviewer can always read the
// original, the classification, and the impact. Release is an AUTHORITY act: a quarantine only
// leaves the blocking state when a release DECISION is presented and its preconditions are met, so a
// silent auto-release is impossible. Overdue review (`review_due_at` elapsed) is surfaced, never
// hidden, so stale containment gets re-examined.
//
// The service is pure and clock-free: every call takes an explicit instant and an injected id, and
// every mutation is independently readable afterwards (`get`, `blocks`, `dueForReview`, `digest`).
// It grants no authority of its own: the release DECISION verdict is resolved elsewhere and threaded
// in. It never deletes — a released/expired quarantine is retained so containment history stays
// reconstructable.

import { type Uuid, type EpochMillis, type TenantId, makeReason, type Reason } from '@trustcircle/domain';
import {
  makeQuarantine,
  quarantineDigest,
  quarantineBlocks,
  quarantinePermitsInspection,
  type Quarantine,
  type QuarantineVisibility,
  type QuarantineStatus,
} from '@trustcircle/domain';

export type QuarantineRejectionCode =
  | 'UNKNOWN_QUARANTINE'
  | 'ALREADY_RELEASED'
  | 'NOT_RELEASABLE'
  | 'PRECONDITIONS_UNMET'
  | 'NO_RELEASE_DECISION'
  | 'INVARIANT_VIOLATION';

export interface QuarantineOutcome {
  readonly accepted: boolean;
  readonly quarantine: Quarantine | null;
  readonly rejectionCode: QuarantineRejectionCode | null;
}

function accept(q: Quarantine): QuarantineOutcome {
  return { accepted: true, quarantine: q, rejectionCode: null };
}

function reject(code: QuarantineRejectionCode): QuarantineOutcome {
  return { accepted: false, quarantine: null, rejectionCode: code };
}

export class QuarantineService {
  readonly #tenantId: TenantId;
  readonly #byId = new Map<Uuid, Quarantine>();
  readonly #byCase = new Map<Uuid, Uuid[]>();

  constructor(tenantId: TenantId) {
    this.#tenantId = tenantId;
  }

  /** Open a quarantine containing the named capabilities + dependency work for a case. */
  open(input: {
    id: Uuid;
    integrityCaseId: Uuid;
    blockedCapabilities: readonly string[];
    blockedDependencyIds?: readonly Uuid[];
    reason: Reason;
    originalEvidenceId: Uuid;
    authorityRef?: Record<string, unknown>;
    visibilityPolicy?: QuarantineVisibility;
    releasePreconditions?: readonly Record<string, unknown>[];
    reviewCadenceMs?: number;
    startedAt: EpochMillis;
  }): QuarantineOutcome {
    const cadence = input.reviewCadenceMs ?? 86_400_000;
    let q: Quarantine;
    try {
      q = makeQuarantine({
        id: input.id,
        tenantId: this.#tenantId,
        integrityCaseId: input.integrityCaseId,
        blockedCapabilities: input.blockedCapabilities,
        ...(input.blockedDependencyIds !== undefined
          ? { blockedDependencyIds: input.blockedDependencyIds }
          : {}),
        reason: input.reason,
        originalEvidenceId: input.originalEvidenceId,
        ...(input.authorityRef !== undefined ? { authorityRef: input.authorityRef } : {}),
        ...(input.visibilityPolicy !== undefined ? { visibilityPolicy: input.visibilityPolicy } : {}),
        ...(input.releasePreconditions !== undefined
          ? { releasePreconditions: input.releasePreconditions }
          : {}),
        reviewCadenceMs: cadence,
        reviewDueAt: (input.startedAt + cadence) as EpochMillis,
        startedAt: input.startedAt,
        status: 'active',
      });
    } catch {
      return reject('INVARIANT_VIOLATION');
    }
    this.#store(q);
    return accept(q);
  }

  /** Mark a quarantine as under review (records the review happened, resets the due clock). */
  review(input: { quarantineId: Uuid; at: EpochMillis }): QuarantineOutcome {
    const current = this.#byId.get(input.quarantineId);
    if (current === undefined) return reject('UNKNOWN_QUARANTINE');
    if (current.status === 'released' || current.status === 'expired') return reject('ALREADY_RELEASED');
    const next = this.#rebuild(current, {
      status: 'under_review',
      reviewDueAt: (input.at + current.reviewCadenceMs) as EpochMillis,
    });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  /**
   * Release a quarantine — an AUTHORITY act. Requires (a) a release DECISION id, and (b) that all
   * release preconditions are reported satisfied by the caller. Absent either, the quarantine stays
   * blocking and the refusal is an explained outcome (never a silent release).
   */
  release(input: {
    quarantineId: Uuid;
    releaseDecisionId: Uuid;
    preconditionsSatisfied: boolean;
    at: EpochMillis;
  }): QuarantineOutcome {
    const current = this.#byId.get(input.quarantineId);
    if (current === undefined) return reject('UNKNOWN_QUARANTINE');
    if (current.status === 'released') return reject('ALREADY_RELEASED');
    if (current.status === 'expired') return reject('NOT_RELEASABLE');
    if (!input.preconditionsSatisfied) return reject('PRECONDITIONS_UNMET');
    const next = this.#rebuild(current, {
      status: 'released',
      releaseDecisionId: input.releaseDecisionId,
      releasedAt: input.at,
    });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  // ---- queries -----------------------------------------------------------

  get(id: Uuid): Quarantine | undefined {
    return this.#byId.get(id);
  }

  quarantinesFor(caseId: Uuid): readonly Quarantine[] {
    return Object.freeze((this.#byCase.get(caseId) ?? []).map((id) => this.#byId.get(id)!));
  }

  /** True iff ANY live quarantine for `caseId` blocks `capability` (FR-019 containment gate). */
  blocks(caseId: Uuid, capability: string): boolean {
    return this.quarantinesFor(caseId).some((q) => quarantineBlocks(q, capability));
  }

  /** True iff inspection is permitted (it always is while quarantined — containment ≠ opacity). */
  permitsInspection(id: Uuid): boolean {
    const q = this.#byId.get(id);
    return q !== undefined && quarantinePermitsInspection(q);
  }

  /** Every live quarantine whose review is overdue at `now` — surfaced for re-examination. */
  dueForReview(now: EpochMillis): readonly Quarantine[] {
    const out: Quarantine[] = [];
    for (const q of this.#byId.values()) {
      if (q.status === 'released' || q.status === 'expired') continue;
      if (q.reviewDueAt <= now) out.push(q);
    }
    return Object.freeze(out);
  }

  digest(id: Uuid): string | undefined {
    const q = this.#byId.get(id);
    return q ? quarantineDigest(q) : undefined;
  }

  // ---- internals ---------------------------------------------------------

  #store(q: Quarantine): void {
    this.#byId.set(q.id, q);
    const list = this.#byCase.get(q.integrityCaseId) ?? [];
    if (!list.includes(q.id)) list.push(q.id);
    this.#byCase.set(q.integrityCaseId, list);
  }

  #rebuild(
    current: Quarantine,
    patch: {
      status?: QuarantineStatus;
      reviewDueAt?: EpochMillis;
      releaseDecisionId?: Uuid;
      releasedAt?: EpochMillis;
    },
  ): Quarantine | null {
    try {
      return makeQuarantine({
        id: current.id,
        tenantId: current.tenantId,
        integrityCaseId: current.integrityCaseId,
        blockedCapabilities: current.blockedCapabilities,
        blockedDependencyIds: current.blockedDependencyIds,
        reason: current.reason,
        originalEvidenceId: current.originalEvidenceId,
        authorityRef: current.authorityRef as Record<string, unknown>,
        visibilityPolicy: current.visibilityPolicy,
        releasePreconditions: current.releasePreconditions as readonly Record<string, unknown>[],
        ...(patch.releaseDecisionId !== undefined
          ? { releaseDecisionId: patch.releaseDecisionId }
          : current.releaseDecisionId !== undefined
            ? { releaseDecisionId: current.releaseDecisionId }
            : {}),
        reviewCadenceMs: current.reviewCadenceMs,
        reviewDueAt: patch.reviewDueAt ?? current.reviewDueAt,
        startedAt: current.startedAt,
        status: patch.status ?? current.status,
        ...(patch.releasedAt !== undefined
          ? { releasedAt: patch.releasedAt }
          : current.releasedAt !== undefined
            ? { releasedAt: current.releasedAt }
            : {}),
      });
    } catch {
      return null;
    }
  }
}

/** Convenience constructor for the mandatory containment reason. */
export function containmentReason(text: string): Reason {
  return makeReason('quarantine_containment', text);
}
