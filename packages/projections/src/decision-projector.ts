// @trustcircle/projections — AUTHORITY-AWARE DECISION-QUEUE PROJECTIONS
// (Phase 4 / User Story 2 / FR-010, FR-012, AC1, SC-003, SC-004).
//
// A reviewer's queue is only trustworthy if every item shows, at a glance and WITHOUT trusting a
// mutation echo: the decision's impact and risk, how old it is and when it expires, whether its
// evidence is still current or superseded, which requirement gates remain open, whether an SoD /
// authority conflict blocks the actor, and the EXACT set of actions THIS actor may currently take.
// This module is the pure, deterministic fold that produces that queue.
//
// It is AUTHORITY-AWARE but does NOT itself resolve authority: authority is a SINGLE source of truth
// in @trustcircle/authz, resolved at effect time by the application layer. This projector accepts the
// already-resolved authority verdict + allowed actions as INPUT DATA on each row (the repo's layering:
// a projector is a pure fold over rows, it never calls a resolver). It therefore has no dependency on
// @trustcircle/authz — it only reshapes verdicts + package facets into a prioritized, reviewer-facing
// queue, deriving age/expiry/urgency at an INJECTED instant `at` (never a wall-clock read).
//
// Determinism: every derivation is a pure function of the input rows and `at`. The projector holds
// only the ingested rows; its `snapshotDigest(at)` is the independently-observable durable-effect
// witness (identical rows + identical `at` ⇒ identical digest ⇒ identical queue).

import { createHash } from 'node:crypto';
import { type Uuid, type EpochMillis } from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// Module-private guards + hashing (fail-visible; not exported by the domain).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(v: unknown): v is Uuid {
  return typeof v === 'string' && UUID_RE.test(v);
}
function reqUuid(v: unknown, label: string): Uuid {
  if (!isUuidLike(v)) throw new TypeError(`${label} must be a UUID`);
  return v;
}
function reqString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
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
// Closed vocabularies (const tuple → derived union).
// ---------------------------------------------------------------------------

export const QUEUE_RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
export type QueueRiskTier = (typeof QUEUE_RISK_TIERS)[number];

export const QUEUE_IMPACT_LEVELS = ['minimal', 'moderate', 'significant', 'severe'] as const;
export type QueueImpactLevel = (typeof QUEUE_IMPACT_LEVELS)[number];

/** Evidence currency: is the package's evidence still the version the reviewer should trust? */
export const EVIDENCE_CURRENCY = ['current', 'superseded', 'missing'] as const;
export type EvidenceCurrency = (typeof EVIDENCE_CURRENCY)[number];

/** Time posture of a decision relative to its expiry, at the query instant. */
export const TIME_POSTURE = ['fresh', 'aging', 'expiring_soon', 'expired'] as const;
export type TimePosture = (typeof TIME_POSTURE)[number];

/** The seven decision verbs a reviewer may be permitted to take (matches the domain alphabet). */
export const QUEUE_ACTIONS = [
  'approve',
  'deny',
  'delegate',
  'request_changes',
  'escalate',
  'expire',
  'cancel',
] as const;
export type QueueAction = (typeof QUEUE_ACTIONS)[number];

/** Why an item is blocked for the querying actor (empty ⇒ actionable). */
export const QUEUE_CONFLICTS = [
  'sod_violation',
  'no_authority',
  'expired_assignment',
  'admin_only',
  'requirements_open',
  'package_invalidated',
  'package_expired',
] as const;
export type QueueConflict = (typeof QUEUE_CONFLICTS)[number];

// ---------------------------------------------------------------------------
// Ingest row — the already-resolved facts the projector folds. Authority is a
// verdict computed elsewhere (application layer over @trustcircle/authz) and
// threaded in; the projector never re-derives it.
// ---------------------------------------------------------------------------

/** One open requirement gate on the package (id + type + satisfied?). */
export interface QueueRequirement {
  readonly id: Uuid;
  readonly gateType: string;
  readonly satisfied: boolean;
  /** null ⇒ non-waivable central guardrail; a UUID ⇒ a specific affected tenant's gate. */
  readonly tenantId: Uuid | null;
}

/**
 * The resolved authority verdict for the QUERYING actor against ONE decision, computed by the
 * application layer at query time. The projector trusts this verdict and does not re-resolve it.
 */
export interface ResolvedAuthorityVerdict {
  readonly principalId: Uuid;
  /** True iff the actor currently has decision authority over this package. */
  readonly permitted: boolean;
  /** The conflicts blocking the actor (empty ⇒ no authority conflict). */
  readonly conflicts: readonly QueueConflict[];
  /** The verbs the actor may currently take (already SoD/authority-filtered). */
  readonly allowedActions: readonly QueueAction[];
}

/** A single decision package plus its resolved facets, ready to fold into a queue row. */
export interface DecisionQueueInput {
  readonly decisionId: Uuid;
  readonly tenantId: Uuid;
  readonly workItemId: Uuid;
  readonly requesterPrincipalId: Uuid;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: QueueRiskTier;
  readonly impact: QueueImpactLevel;
  /** The package status (pending/in_review/…); terminal/invalidated packages are non-actionable. */
  readonly status: string;
  readonly version: number;
  readonly evidenceCurrency: EvidenceCurrency;
  readonly requirements: readonly QueueRequirement[];
  /** The affected tenants (non-empty ⇒ a cross-tenant / joint decision). */
  readonly affectedTenantIds: readonly Uuid[];
  readonly createdAt: EpochMillis;
  readonly expiresAt: EpochMillis;
  /** The resolved authority verdict for the querying actor (already SoD-filtered). */
  readonly authority: ResolvedAuthorityVerdict;
}

// ---------------------------------------------------------------------------
// The projected queue row — everything a reviewer scans, plus a numeric
// priority the queue sorts by (higher = more urgent).
// ---------------------------------------------------------------------------

export interface DecisionQueueRow {
  readonly decisionId: Uuid;
  readonly tenantId: Uuid;
  readonly workItemId: Uuid;
  readonly requesterPrincipalId: Uuid;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: QueueRiskTier;
  readonly impact: QueueImpactLevel;
  readonly status: string;
  readonly version: number;
  /** Age in millis of the package at the query instant. */
  readonly ageMillis: number;
  /** Millis until expiry (negative once expired). */
  readonly timeToExpiryMillis: number;
  readonly timePosture: TimePosture;
  readonly evidenceCurrency: EvidenceCurrency;
  /** The still-open requirement gates (unsatisfied), most-blocking first (central guardrails first). */
  readonly openRequirements: readonly QueueRequirement[];
  readonly isCrossTenant: boolean;
  /** The conflicts blocking the querying actor (authority + package-state derived). */
  readonly conflicts: readonly QueueConflict[];
  /** The verbs the querying actor may currently take (empty ⇒ view-only). */
  readonly allowedActions: readonly QueueAction[];
  /** True iff the actor can act at all (no blocking conflict AND ≥1 allowed action). */
  readonly actionable: boolean;
  /** The numeric priority the queue sorts by, higher = more urgent (SC-003 prioritization). */
  readonly priority: number;
}

// ---------------------------------------------------------------------------
// Pure derivations (all at an injected `at`).
// ---------------------------------------------------------------------------

const IMPACT_WEIGHT: Readonly<Record<QueueImpactLevel, number>> = {
  minimal: 1,
  moderate: 2,
  significant: 3,
  severe: 4,
};
const RISK_WEIGHT: Readonly<Record<QueueRiskTier, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** How close to expiry an item is at `at`. Fresh > horizon; expiring_soon within the horizon; expired past. */
export function timePostureOf(
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
  at: EpochMillis,
  expiringSoonHorizonMillis: number,
): TimePosture {
  if (at >= expiresAt) return 'expired';
  const remaining = expiresAt - at;
  if (remaining <= expiringSoonHorizonMillis) return 'expiring_soon';
  const total = expiresAt - createdAt;
  // "aging" once more than half the window has elapsed; else "fresh".
  if (total > 0 && at - createdAt >= total / 2) return 'aging';
  return 'fresh';
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'denied',
  'expired',
  'cancelled',
]);

/**
 * Derive the conflicts blocking the querying actor, combining the resolved authority conflicts with
 * package-state conflicts (invalidated / expired / open requirements). The projector NEVER invents an
 * authority conflict — it only adds the package-state ones the actor could not have resolved verdict for.
 */
function deriveConflicts(input: DecisionQueueInput, at: EpochMillis): readonly QueueConflict[] {
  const conflicts = new Set<QueueConflict>(input.authority.conflicts);
  if (input.status === 'invalidated') conflicts.add('package_invalidated');
  if (at >= input.expiresAt) conflicts.add('package_expired');
  const anyOpen = input.requirements.some((r) => !r.satisfied);
  if (anyOpen) conflicts.add('requirements_open');
  return Object.freeze([...conflicts]);
}

/**
 * The priority a row sorts by (higher = more urgent). It composes impact, risk, time pressure, and
 * actionability so an urgent, actionable, expiring, high-impact decision rises to the top of a
 * reviewer's queue (SC-003). Deterministic and monotonic — no wall clock, no randomness.
 */
export function priorityOf(row: {
  readonly impact: QueueImpactLevel;
  readonly riskTier: QueueRiskTier;
  readonly timePosture: TimePosture;
  readonly actionable: boolean;
  readonly openRequirementCount: number;
}): number {
  let p = IMPACT_WEIGHT[row.impact] * 100 + RISK_WEIGHT[row.riskTier] * 20;
  switch (row.timePosture) {
    case 'expired':
      p += 200; // expired items need immediate disposition (expire/cancel)
      break;
    case 'expiring_soon':
      p += 120;
      break;
    case 'aging':
      p += 40;
      break;
    case 'fresh':
      break;
  }
  // An item the actor can act on outranks one they can only watch (surfacing actionable work first).
  if (row.actionable) p += 30;
  // Open requirements add mild urgency (someone must close the gate) but never outrank expiry.
  p += Math.min(row.openRequirementCount, 5) * 5;
  return p;
}

function orderRequirements(reqs: readonly QueueRequirement[]): readonly QueueRequirement[] {
  // Non-waivable central guardrails (tenantId === null) are the most blocking — surface them first.
  return [...reqs]
    .filter((r) => !r.satisfied)
    .sort((a, b) => {
      const ac = a.tenantId === null ? 0 : 1;
      const bc = b.tenantId === null ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return a.id.localeCompare(b.id);
    });
}

// ---------------------------------------------------------------------------
// The projector.
// ---------------------------------------------------------------------------

export interface DecisionQueueProjectorInput {
  readonly tenantId: Uuid;
  /** Items within `expiringSoonHorizonMillis` of expiry are flagged `expiring_soon` (default 60 min). */
  readonly expiringSoonHorizonMillis?: number;
}

/**
 * A pure, deterministic decision-queue projector. Ingest already-resolved decision inputs, then read
 * a prioritized queue at any injected instant. Tenant-scoped: an ingested row whose tenant differs
 * from the projector's tenant is refused (a queue never mixes tenants). Holds only the ingested rows.
 */
export class DecisionQueueProjector {
  readonly #tenantId: Uuid;
  readonly #horizon: number;
  readonly #items = new Map<string, DecisionQueueInput>();

  constructor(input: DecisionQueueProjectorInput) {
    this.#tenantId = reqUuid(input.tenantId, 'projector.tenantId');
    const horizon = input.expiringSoonHorizonMillis ?? 60 * 60_000;
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new RangeError('expiringSoonHorizonMillis must be a positive integer');
    }
    this.#horizon = horizon;
  }

  /** The tenant this queue is scoped to. */
  get tenantId(): Uuid {
    return this.#tenantId;
  }

  /**
   * Ingest one decision input. Validated fail-visibly (a malformed row is rejected before it enters
   * the model) and tenant-guarded (a cross-tenant row is refused). Re-ingesting the same decisionId
   * replaces the prior row (last write wins — the caller resolves ordering upstream).
   */
  ingest(input: DecisionQueueInput): void {
    const decisionId = reqUuid(input.decisionId, 'input.decisionId');
    const tenantId = reqUuid(input.tenantId, 'input.tenantId');
    if (tenantId !== this.#tenantId) {
      throw new TypeError(`decision ${decisionId} belongs to another tenant — refused`);
    }
    reqUuid(input.workItemId, 'input.workItemId');
    reqUuid(input.requesterPrincipalId, 'input.requesterPrincipalId');
    reqString(input.requestedAction, 'input.requestedAction');
    reqString(input.actionClass, 'input.actionClass');
    if (!QUEUE_RISK_TIERS.includes(input.riskTier)) {
      throw new TypeError(`input.riskTier invalid: ${input.riskTier}`);
    }
    if (!QUEUE_IMPACT_LEVELS.includes(input.impact)) {
      throw new TypeError(`input.impact invalid: ${input.impact}`);
    }
    if (!EVIDENCE_CURRENCY.includes(input.evidenceCurrency)) {
      throw new TypeError(`input.evidenceCurrency invalid: ${input.evidenceCurrency}`);
    }
    reqString(input.status, 'input.status');
    reqEpoch(input.createdAt, 'input.createdAt');
    reqEpoch(input.expiresAt, 'input.expiresAt');
    reqUuid(input.authority.principalId, 'input.authority.principalId');
    for (const a of input.authority.allowedActions) {
      if (!QUEUE_ACTIONS.includes(a)) throw new TypeError(`allowedActions invalid: ${a}`);
    }
    for (const c of input.authority.conflicts) {
      if (!QUEUE_CONFLICTS.includes(c)) throw new TypeError(`conflicts invalid: ${c}`);
    }
    this.#items.set(decisionId, input);
  }

  /** Project ONE decision input into a queue row at `at`. Pure — no state mutation. */
  toRow(input: DecisionQueueInput, at: EpochMillis): DecisionQueueRow {
    const ageMillis = Math.max(0, at - input.createdAt);
    const timeToExpiryMillis = input.expiresAt - at;
    const timePosture = timePostureOf(input.createdAt, input.expiresAt, at, this.#horizon);
    const openRequirements = orderRequirements(input.requirements);
    const conflicts = deriveConflicts(input, at);
    const isCrossTenant = input.affectedTenantIds.length > 0;

    // The package state itself can void every action (terminal/invalidated/expired). When it does,
    // the actor's allowed actions collapse — except `expire`/`cancel` housekeeping on an expired item.
    const stateBlocked = TERMINAL_STATUSES.has(input.status) || input.status === 'invalidated';
    const expired = at >= input.expiresAt;
    let allowedActions: readonly QueueAction[] = stateBlocked ? [] : input.authority.allowedActions;
    if (expired && !stateBlocked) {
      // An expired-but-open package may only be closed by expire (system/requester housekeeping).
      allowedActions = allowedActions.filter((a) => a === 'expire' || a === 'cancel');
    }
    const actionable = allowedActions.length > 0 && conflicts.length === 0;

    const priority = priorityOf({
      impact: input.impact,
      riskTier: input.riskTier,
      timePosture,
      actionable,
      openRequirementCount: openRequirements.length,
    });

    return {
      decisionId: input.decisionId,
      tenantId: input.tenantId,
      workItemId: input.workItemId,
      requesterPrincipalId: input.requesterPrincipalId,
      requestedAction: input.requestedAction,
      actionClass: input.actionClass,
      riskTier: input.riskTier,
      impact: input.impact,
      status: input.status,
      version: input.version,
      ageMillis,
      timeToExpiryMillis,
      timePosture,
      evidenceCurrency: input.evidenceCurrency,
      openRequirements,
      isCrossTenant,
      conflicts,
      allowedActions: Object.freeze([...allowedActions]),
      actionable,
      priority,
    };
  }

  /**
   * The full prioritized queue at `at`, ordered by descending priority then ascending expiry then
   * decisionId (a stable, deterministic total order). Terminal/invalidated packages are INCLUDED
   * (a reviewer sees them as non-actionable) unless filtered by the caller.
   */
  queue(at: EpochMillis): readonly DecisionQueueRow[] {
    const rows = [...this.#items.values()].map((i) => this.toRow(i, at));
    return rows.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.timeToExpiryMillis !== b.timeToExpiryMillis) {
        return a.timeToExpiryMillis - b.timeToExpiryMillis;
      }
      return a.decisionId.localeCompare(b.decisionId);
    });
  }

  /** Only the rows the querying actor can currently act on (actionable = true), prioritized. */
  actionableQueue(at: EpochMillis): readonly DecisionQueueRow[] {
    return this.queue(at).filter((r) => r.actionable);
  }

  /** The row for one decision at `at`, or null if unknown. */
  rowFor(decisionId: Uuid, at: EpochMillis): DecisionQueueRow | null {
    const input = this.#items.get(decisionId);
    return input ? this.toRow(input, at) : null;
  }

  /** The count of items ingested (regardless of actionability). */
  size(): number {
    return this.#items.size;
  }

  /**
   * The content digest of the whole projected queue at `at` — the independently-observable
   * durable-effect witness. Identical ingested rows + identical `at` ⇒ identical digest ⇒ identical
   * queue, so a consumer can prove the queue it rendered matches the one the projector computed.
   */
  snapshotDigest(at: EpochMillis): string {
    const rows = this.queue(at).map((r) => ({
      decisionId: r.decisionId,
      status: r.status,
      version: r.version,
      priority: r.priority,
      timePosture: r.timePosture,
      evidenceCurrency: r.evidenceCurrency,
      conflicts: [...r.conflicts],
      allowedActions: [...r.allowedActions],
      openRequirementIds: r.openRequirements.map((q) => q.id),
    }));
    return sha256(JSON.stringify({ tenantId: this.#tenantId, at, rows }));
  }
}
