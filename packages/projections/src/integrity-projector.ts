// @trustcircle/projections — INTEGRITY-QUEUE PROJECTIONS
// (Phase 5 / User Story 3 / FR-016..022, SC-006..009).
//
// A remediation reviewer's queue is only trustworthy if every damaged-work item shows, at a glance
// and WITHOUT trusting a mutation echo: its problem class(es) and severity, its safety/business
// impact, its owner (or an explicit ownership gap), whether it is quarantined and what that blocks,
// its dependency propagation, whether a remediation is proposed / approved / executed, and — most
// importantly — whether it is VERIFIED-CLOSED or merely un-verified. This module is the pure,
// deterministic fold that produces that queue.
//
// THE LOAD-BEARING RULE (FR-022): the projector NEVER converts a source-reported `done` or a
// repair's own success into VERIFIED CLOSURE. Verified closure is an INPUT — a separately-resolved
// verdict from the independent verification service (nine-gate `VerificationRecord`) — threaded in
// on each row, exactly as the decision projector threads in an already-resolved authority verdict. A
// row that reports `sourceReportedDone: true` or `repairSucceeded: true` but carries no passing
// verification verdict is projected as `verified: false` with a visible `closureBlocked` reason. The
// projector adds derived posture; it never invents a positive closure verdict.
//
// It is a pure fold over rows: it holds only the ingested rows, derives everything at an INJECTED
// instant `at` (never a wall-clock read), and exposes a `snapshotDigest(at)` as the
// independently-observable durable-effect witness.

import { createHash } from 'node:crypto';
import { type Uuid, type EpochMillis } from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// Module-private guards + hashing (fail-visible; not exported).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(v: unknown): v is Uuid {
  return typeof v === 'string' && UUID_RE.test(v);
}
function reqUuid(v: unknown, label: string): Uuid {
  if (!isUuidLike(v)) throw new TypeError(`${label} must be a UUID`);
  return v;
}
function reqEpoch(v: unknown, label: string): EpochMillis {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms`);
  }
  return v;
}
function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Closed vocabularies (const tuple → derived union) — mirror the domain.
// ---------------------------------------------------------------------------

export const QUEUE_PROBLEM_CLASSES = [
  'malformed',
  'corrupted',
  'duplicated',
  'stale',
  'conflicting',
  'orphaned',
  'combined',
  'unknown',
] as const;
export type QueueProblemClass = (typeof QUEUE_PROBLEM_CLASSES)[number];

export const QUEUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type QueueSeverity = (typeof QUEUE_SEVERITIES)[number];

export const QUEUE_SAFETY_IMPACTS = ['none', 'low', 'moderate', 'high', 'catastrophic'] as const;
export type QueueSafetyImpact = (typeof QUEUE_SAFETY_IMPACTS)[number];

/** The lifecycle state of a case as the reviewer sees it (mirrors the domain). */
export const QUEUE_CASE_STATES = [
  'detected',
  'preserved',
  'classified',
  'quarantined',
  'remediation_proposed',
  'repairing',
  'verifying',
  'repaired',
  'closed',
  'unresolved',
  'escalated',
] as const;
export type QueueCaseState = (typeof QUEUE_CASE_STATES)[number];

/** Why a case cannot be reported verified-closed (empty ⇒ nothing blocks closure). */
export const CLOSURE_BLOCKERS = [
  'not_verified', // no passing independent verification verdict
  'original_not_preserved', // FR-017 precedence unmet
  'repair_unverified', // repair succeeded but is unverified
  'reconciliation_open', // reconciliation retained residual differences / uncertainty
  'quarantine_active', // effects are still contained
  'ownership_gap', // no owner to accept resolution
  'escalated', // escalated for human resolution
] as const;
export type ClosureBlocker = (typeof CLOSURE_BLOCKERS)[number];

// ---------------------------------------------------------------------------
// Ingest row — already-resolved facts. Verified closure is a verdict computed
// elsewhere (verification-service) and threaded in; the projector never invents it.
// ---------------------------------------------------------------------------

/**
 * The independent verification verdict for a case, resolved by the verification-service. The
 * projector TRUSTS this verdict and never fabricates a positive one. Absent ⇒ unverified.
 */
export interface ResolvedClosureVerdict {
  /** True iff an independent VerificationRecord PASSED all nine Verified Closure Gate conditions. */
  readonly verified: boolean;
  /** The verification record id backing a passing verdict (null when unverified). */
  readonly verificationRecordId: Uuid | null;
  /** True iff the verifier was independent of the repairer/owner. */
  readonly verifierIndependent: boolean;
}

export interface IntegrityQueueInput {
  readonly caseId: Uuid;
  readonly tenantId: Uuid;
  readonly workItemId: Uuid;
  readonly problemClass: QueueProblemClass;
  readonly problemClasses: readonly QueueProblemClass[];
  readonly severity: QueueSeverity;
  readonly safetyImpact: QueueSafetyImpact;
  readonly state: QueueCaseState;
  /** The resolved owner, or null for an explicit ownership gap. */
  readonly ownerPrincipalId: Uuid | null;
  readonly ownershipGap: boolean;
  /** FR-017: has the raw original been preserved (an evidence id exists)? */
  readonly originalPreserved: boolean;
  /** Is a live quarantine currently blocking effects? */
  readonly quarantineActive: boolean;
  readonly blockedCapabilities: readonly string[];
  readonly dependentWorkIds: readonly Uuid[];
  /** RAW source-reported completion — a fact, NOT a closure signal (FR-022). */
  readonly sourceReportedDone: boolean;
  /** RAW repair success — a fact, NOT a closure signal (FR-022). */
  readonly repairSucceeded: boolean;
  /** Did the latest reconciliation reconcile with no residual differences / uncertainty? */
  readonly reconciliationClean: boolean;
  /** Is the case escalated for human resolution? */
  readonly escalated: boolean;
  /** The independent verification verdict (absent ⇒ unverified). */
  readonly closure: ResolvedClosureVerdict;
  readonly detectedAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

// ---------------------------------------------------------------------------
// Projected row — everything a remediation reviewer scans.
// ---------------------------------------------------------------------------

export interface IntegrityQueueRow {
  readonly caseId: Uuid;
  readonly tenantId: Uuid;
  readonly workItemId: Uuid;
  readonly problemClass: QueueProblemClass;
  readonly problemClasses: readonly QueueProblemClass[];
  readonly severity: QueueSeverity;
  readonly safetyImpact: QueueSafetyImpact;
  readonly state: QueueCaseState;
  readonly ownerPrincipalId: Uuid | null;
  readonly ownershipGap: boolean;
  readonly quarantineActive: boolean;
  readonly blockedCapabilities: readonly string[];
  readonly dependentWorkIds: readonly Uuid[];
  readonly ageMillis: number;
  /** The AUTHORITATIVE verified-closure flag — TRUE only via an independent passing verdict. */
  readonly verified: boolean;
  /** True iff the case may be shown as closed (verified AND state is a closing state). */
  readonly closureRealized: boolean;
  /** Why closure is not (yet) realized (empty ⇒ verified-closed). Always includes the honest reasons. */
  readonly closureBlocked: readonly ClosureBlocker[];
  /** True iff human attention is required (escalated OR ownership gap OR unsafe + unverified). */
  readonly needsHumanAttention: boolean;
  readonly priority: number;
}

// ---------------------------------------------------------------------------
// Pure derivations.
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Readonly<Record<QueueSeverity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
const SAFETY_WEIGHT: Readonly<Record<QueueSafetyImpact, number>> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  catastrophic: 4,
};

const CLOSING_STATES: ReadonlySet<QueueCaseState> = new Set(['repaired', 'closed']);

/**
 * Derive the closure blockers for a case. This is where the FR-022 rule lives: source-reported
 * `done` and repair success are NEVER treated as closure — a case is only unblocked when it carries
 * an independent PASSING verification verdict AND its original is preserved AND reconciliation is
 * clean AND no quarantine/ownership-gap/escalation remains. The blockers are the honest, visible
 * reasons the case is not closed.
 */
export function closureBlockersOf(input: IntegrityQueueInput): readonly ClosureBlocker[] {
  const blockers = new Set<ClosureBlocker>();
  // The load-bearing gate: no passing independent verification ⇒ not verified, full stop.
  if (!input.closure.verified || input.closure.verificationRecordId === null) {
    blockers.add('not_verified');
  }
  if (!input.originalPreserved) blockers.add('original_not_preserved');
  // Repair success WITHOUT verification is explicitly a blocker, never a pass.
  if (input.repairSucceeded && !input.closure.verified) blockers.add('repair_unverified');
  if (!input.reconciliationClean) blockers.add('reconciliation_open');
  if (input.quarantineActive) blockers.add('quarantine_active');
  if (input.ownershipGap) blockers.add('ownership_gap');
  if (input.escalated) blockers.add('escalated');
  return Object.freeze([...blockers]);
}

/** The priority a row sorts by (higher = more urgent). Composes severity, safety, and posture. */
export function integrityPriorityOf(row: {
  readonly severity: QueueSeverity;
  readonly safetyImpact: QueueSafetyImpact;
  readonly quarantineActive: boolean;
  readonly needsHumanAttention: boolean;
  readonly dependents: number;
}): number {
  let p = SEVERITY_WEIGHT[row.severity] * 100 + SAFETY_WEIGHT[row.safetyImpact] * 60;
  if (row.quarantineActive) p += 40; // contained-but-unsafe work is urgent to resolve.
  if (row.needsHumanAttention) p += 50;
  p += Math.min(row.dependents, 10) * 5; // propagation adds urgency.
  return p;
}

// ---------------------------------------------------------------------------
// The projector.
// ---------------------------------------------------------------------------

export interface IntegrityProjectorInput {
  readonly tenantId: Uuid;
}

export class IntegrityQueueProjector {
  readonly #tenantId: Uuid;
  readonly #items = new Map<string, IntegrityQueueInput>();

  constructor(input: IntegrityProjectorInput) {
    this.#tenantId = reqUuid(input.tenantId, 'projector.tenantId');
  }

  get tenantId(): Uuid {
    return this.#tenantId;
  }

  /** Ingest one integrity-case input. Validated fail-visibly + tenant-guarded. Last write wins. */
  ingest(input: IntegrityQueueInput): void {
    const caseId = reqUuid(input.caseId, 'input.caseId');
    const tenantId = reqUuid(input.tenantId, 'input.tenantId');
    if (tenantId !== this.#tenantId) {
      throw new TypeError(`case ${caseId} belongs to another tenant — refused`);
    }
    reqUuid(input.workItemId, 'input.workItemId');
    if (!QUEUE_PROBLEM_CLASSES.includes(input.problemClass)) {
      throw new TypeError(`input.problemClass invalid: ${input.problemClass}`);
    }
    for (const c of input.problemClasses) {
      if (!QUEUE_PROBLEM_CLASSES.includes(c)) throw new TypeError(`problemClasses invalid: ${c}`);
    }
    if (!QUEUE_SEVERITIES.includes(input.severity)) {
      throw new TypeError(`input.severity invalid: ${input.severity}`);
    }
    if (!QUEUE_SAFETY_IMPACTS.includes(input.safetyImpact)) {
      throw new TypeError(`input.safetyImpact invalid: ${input.safetyImpact}`);
    }
    if (!QUEUE_CASE_STATES.includes(input.state)) {
      throw new TypeError(`input.state invalid: ${input.state}`);
    }
    if (input.ownerPrincipalId !== null) reqUuid(input.ownerPrincipalId, 'input.ownerPrincipalId');
    // A named owner and an ownership gap are mutually exclusive (defence in depth over the domain).
    if (input.ownershipGap && input.ownerPrincipalId !== null) {
      throw new TypeError('ownershipGap=true is incompatible with a named owner');
    }
    if (input.closure.verificationRecordId !== null) {
      reqUuid(input.closure.verificationRecordId, 'input.closure.verificationRecordId');
    }
    reqEpoch(input.detectedAt, 'input.detectedAt');
    reqEpoch(input.updatedAt, 'input.updatedAt');
    this.#items.set(caseId, input);
  }

  /** Project ONE case input into a queue row at `at`. Pure — no state mutation. */
  toRow(input: IntegrityQueueInput, at: EpochMillis): IntegrityQueueRow {
    const ageMillis = Math.max(0, at - input.detectedAt);
    const closureBlocked = closureBlockersOf(input);
    // AUTHORITATIVE verified flag: verified iff an independent passing verdict exists AND nothing
    // blocks closure. A source-reported `done` / repair success can never flip this on its own.
    const verified =
      input.closure.verified &&
      input.closure.verifierIndependent &&
      input.closure.verificationRecordId !== null &&
      closureBlocked.length === 0;
    const closureRealized = verified && CLOSING_STATES.has(input.state);
    const needsHumanAttention =
      input.escalated ||
      input.ownershipGap ||
      (input.quarantineActive && !verified) ||
      (input.safetyImpact === 'high' && !verified) ||
      (input.safetyImpact === 'catastrophic' && !verified);
    const priority = integrityPriorityOf({
      severity: input.severity,
      safetyImpact: input.safetyImpact,
      quarantineActive: input.quarantineActive,
      needsHumanAttention,
      dependents: input.dependentWorkIds.length,
    });

    return {
      caseId: input.caseId,
      tenantId: input.tenantId,
      workItemId: input.workItemId,
      problemClass: input.problemClass,
      problemClasses: Object.freeze([...input.problemClasses]),
      severity: input.severity,
      safetyImpact: input.safetyImpact,
      state: input.state,
      ownerPrincipalId: input.ownerPrincipalId,
      ownershipGap: input.ownershipGap,
      quarantineActive: input.quarantineActive,
      blockedCapabilities: Object.freeze([...input.blockedCapabilities]),
      dependentWorkIds: Object.freeze([...input.dependentWorkIds]),
      ageMillis,
      verified,
      closureRealized,
      closureBlocked,
      needsHumanAttention,
      priority,
    };
  }

  /** The full prioritized queue at `at`, ordered by descending priority then caseId (stable). */
  queue(at: EpochMillis): readonly IntegrityQueueRow[] {
    const rows = [...this.#items.values()].map((i) => this.toRow(i, at));
    return rows.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.caseId.localeCompare(b.caseId);
    });
  }

  /** Only the cases that still require human attention (escalated / unowned / unsafe-unverified). */
  attentionQueue(at: EpochMillis): readonly IntegrityQueueRow[] {
    return this.queue(at).filter((r) => r.needsHumanAttention);
  }

  /** Only the cases that are verified-closed (closureRealized) at `at`. */
  closedQueue(at: EpochMillis): readonly IntegrityQueueRow[] {
    return this.queue(at).filter((r) => r.closureRealized);
  }

  rowFor(caseId: Uuid, at: EpochMillis): IntegrityQueueRow | null {
    const input = this.#items.get(caseId);
    return input ? this.toRow(input, at) : null;
  }

  size(): number {
    return this.#items.size;
  }

  /** The content digest of the whole projected queue at `at` — the durable-effect witness. */
  snapshotDigest(at: EpochMillis): string {
    const rows = this.queue(at).map((r) => ({
      caseId: r.caseId,
      state: r.state,
      severity: r.severity,
      safetyImpact: r.safetyImpact,
      verified: r.verified,
      closureRealized: r.closureRealized,
      closureBlocked: [...r.closureBlocked],
      needsHumanAttention: r.needsHumanAttention,
      priority: r.priority,
    }));
    return sha256(JSON.stringify({ tenantId: this.#tenantId, at, rows }));
  }
}
