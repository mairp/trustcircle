// @trustcircle/command-worker — the DECISION EXPIRY WORKER (Phase 4 / User Story 2 / T116 /
// FR-010, FR-013, FR-014, FR-015, SC-005, AC5).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// Time is a first-class governance actor. A decision left unattended past its deadline, a
// delegation whose window has closed, a break-glass grant that has outlived its incident, and a
// joint cross-tenant package whose underlying decision has lapsed must NOT silently keep conferring
// authority — they must be EXPIRED, and that expiry must itself be an AUDITED, attributable,
// downstream-notified governed effect (never a silent flag flip). This worker is the deterministic
// scheduler that scans five expirable governed kinds and, for each one whose deadline has passed at
// the injected instant, commits exactly ONE expiry effect through the SAME transactional-outbox
// unit-of-work every human decision uses (packages/persistence/decision-repository.ts /
// unit-of-work.ts): a canonical state transition + an audit event + an outbox notification, atomic
// or not at all.
//
// The five expirable kinds (each with its own deterministic effect):
//   1. DECISION PACKAGES  — an unattended package past `expiresAt` transitions to `expired`
//      (SC-005). Only the `expire` verb may close a lapsed package (decision-service.ts).
//   2. DECISION REQUIREMENTS — a gate (SoD / tenant-approval / central) whose satisfaction window
//      lapsed is failed-closed so the parent decision cannot be accepted against a stale gate.
//   3. DELEGATIONS — a grant past its window is `expired` (delegation-service.expireDelegation);
//      revocation cascades by resolution, so an expired delegation stops granting immediately.
//   4. BREAK-GLASS GRANTS — an emergency grant past its window that was never reviewed still OWES a
//      mandatory post-event review; once past `reviewDueAt` it is REVIEW-OVERDUE and is ESCALATED,
//      never silently closed (emergency-authority.monitorBreakGlass). Break-glass NEVER confers
//      decision authority, so its expiry is an accountability effect, not a decision effect.
//   5. JOINT DECISION PACKAGES — a cross-tenant envelope whose underlying decision lapsed is
//      `revoked` (federated approval can no longer complete), notifying every affected tenant.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — DETERMINISTIC, AUDITED, FAIL-VISIBLE, INJECTABLE
// ─────────────────────────────────────────────────────────────────────────────
// * DETERMINISTIC SCHEDULING. The worker reads NO wall clock. The scan instant (`now`) is injected
//   per pass; every idempotency key, correlation id, and record id is DERIVED (sha-256 digest) from
//   the entity identity + the deadline it crossed, so re-running a pass over the same durable state
//   is a NO-OP (the unit-of-work deduplicates on the stable key). Same inputs ⇒ byte-identical
//   effects; a crash mid-pass resumes safely with no double-expiry.
// * AUDITED. Every expiry commits an audit event carrying actor=`system:expiry-worker`, the
//   accountable owner, a structured reason naming the deadline that lapsed, source/target digests,
//   and evidence refs — the audit-completeness gate refuses an incomplete one BEFORE any effect.
// * FAIL-VISIBLE. A per-kind, per-entity outcome (`expired` | `skipped` | `deduplicated` | `failed`)
//   is returned; a commit failure is captured, counted, and surfaced (never swallowed) so an
//   operator sees exactly what did and did not expire.
// * INJECTABLE / LEAF-CLEAN. Like decision-repository.ts, this module depends on NO domain package
//   at the type level: it defines minimal STRUCTURAL port shapes for each expirable entity and takes
//   the expiry ORACLES (decisionIsExpired / expireDelegation / monitorBreakGlass / …) and the read
//   ports as INJECTED functions. Production wires the domain/application oracles + real repositories;
//   tests wire pure in-memory fakes, so every branch is provable with no live DB, under Node 22
//   `--experimental-strip-types`.
//
// The worker composes with the GovernedWorker lifecycle in ./main.ts (lease ownership, checkpointing,
// safe shutdown): a deployment runs `runExpiryPass` inside a leased, checkpointed loop exactly as the
// outbox publisher's `runOnce` is run, so the expiry sweep inherits singleton ownership and
// fail-visible continuity.

import {
  commitUnitOfWork,
  readCanonicalState,
  type Database,
  type SourceContract,
  type AuditEventInput,
  type CommitUnitOfWorkResult,
  digest,
} from '@trustcircle/persistence';

// ===========================================================================
// 0. The expirable governed kinds + their canonical entity-kind keys
// ===========================================================================

/** The five governed kinds this worker sweeps for lapsed deadlines. */
export const EXPIRABLE_KINDS = [
  'decision_package',
  'decision_requirement',
  'delegation',
  'break_glass_grant',
  'joint_decision_package',
] as const;
export type ExpirableKind = (typeof EXPIRABLE_KINDS)[number];

/** The canonical `entity_kind` each expirable kind is stored under (unit-of-work canonical_state). */
export const EXPIRY_ENTITY_KIND: Readonly<Record<ExpirableKind, string>> = Object.freeze({
  decision_package: 'decision_package',
  decision_requirement: 'decision_requirement',
  delegation: 'delegation',
  break_glass_grant: 'break_glass_grant',
  joint_decision_package: 'joint_decision_package',
});

/** The canonical outbox topic each expiry effect publishes on (closed vocabulary, fail-closed). */
export const EXPIRY_OUTBOX_TOPICS: Readonly<Record<ExpirableKind, string>> = Object.freeze({
  decision_package: 'governance.decision.expired',
  decision_requirement: 'governance.decision.requirement_failed',
  delegation: 'governance.delegation.expired',
  break_glass_grant: 'governance.emergency.review_overdue',
  joint_decision_package: 'governance.joint.revoked',
});

// ===========================================================================
// 1. Minimal STRUCTURAL port shapes (leaf-clean — no domain dependency)
// ===========================================================================
//
// Each shape carries ONLY the fields the worker needs to (a) decide expiry against `now`, (b)
// identify the entity for a deterministic idempotency key, and (c) attribute + notify the effect.
// The full domain aggregates (DecisionPackage, Delegation, BreakGlassGrant, JointDecisionPackage)
// are structurally assignable to these — production passes them straight through.

/** A decision package that may be past its deadline (SC-005). */
export interface ExpirableDecision {
  readonly id: string;
  readonly tenantId: string;
  readonly requesterPrincipalId: string;
  readonly status: string;
  readonly version: number;
  readonly expiresAt: number;
}

/** A decision requirement gate that may have lapsed its satisfaction window. */
export interface ExpirableRequirement {
  readonly id: string;
  readonly tenantId: string;
  /** The owning decision (for correlation + notification). */
  readonly decisionId: string;
  readonly ownerPrincipalId: string;
  readonly status: string;
  readonly version: number;
  /** The instant by which this gate had to be satisfied. */
  readonly deadlineAt: number;
}

/** A delegation grant that may be past its window (FR-014, AC5). */
export interface ExpirableDelegation {
  readonly delegationId: string;
  readonly tenantId: string;
  readonly delegatorPrincipalId: string;
  readonly recipientPrincipalId: string;
  readonly status: string;
  readonly version: number;
  readonly expiresAt: number;
}

/** A break-glass grant that may be past its window and/or owe a post-event review (FR-015). */
export interface ExpirableBreakGlass {
  readonly grantId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly reviewerPrincipalId: string;
  readonly status: string;
  readonly version: number;
  readonly expiresAt: number;
  readonly reviewDueAt: number;
}

/** A joint cross-tenant package whose underlying decision may have lapsed (FR-013, AC6). */
export interface ExpirableJoint {
  readonly id: string;
  readonly tenantId: string;
  readonly decisionId: string;
  readonly affectedTenantIds: readonly string[];
  readonly centralState: string;
  readonly version: number;
  /** The instant the underlying decision expires (the joint can no longer complete after it). */
  readonly underlyingExpiresAt: number;
}

// ===========================================================================
// 2. Injected oracles — the expiry decision functions (from domain/application)
// ===========================================================================
//
// Production wires these to the real oracles:
//   decisionExpired      := (d, now) => decisionIsExpired(d as DecisionPackage, now)
//   requirementExpired   := (r, now) => now >= r.deadlineAt && r.status === 'pending'
//   delegationExpired    := (g, now) => expireDelegation(g as Delegation, now).status === 'expired'
//   breakGlassReviewDue  := (g, now) => monitorBreakGlass(g as BreakGlassGrant, now).reviewOverdue
//   jointLapsed          := (j, now) => now >= j.underlyingExpiresAt && !terminal(j.centralState)
// Tests wire pure fakes. The worker owns the SWEEP, never the oracle.

export interface ExpiryOracles {
  readonly decisionExpired: (d: ExpirableDecision, now: number) => boolean;
  readonly requirementExpired: (r: ExpirableRequirement, now: number) => boolean;
  readonly delegationExpired: (g: ExpirableDelegation, now: number) => boolean;
  /** True iff the grant is past its window AND its mandatory post-event review is now overdue. */
  readonly breakGlassReviewOverdue: (g: ExpirableBreakGlass, now: number) => boolean;
  readonly jointLapsed: (j: ExpirableJoint, now: number) => boolean;
}

// ===========================================================================
// 3. Read ports — find the candidate rows due for an expiry check at `now`
// ===========================================================================
//
// A read port returns the bounded batch of ACTIVE (non-terminal) rows whose deadline is on/before
// `now`. It is the ONLY I/O the worker performs besides the atomic commit; production wires it to a
// repository query, tests to an in-memory array. `limit` bounds each pass (no unbounded sweep).

export interface ExpiryReadPorts {
  readonly dueDecisions: (now: number, limit: number) => Promise<readonly ExpirableDecision[]>;
  readonly dueRequirements: (
    now: number,
    limit: number,
  ) => Promise<readonly ExpirableRequirement[]>;
  readonly dueDelegations: (now: number, limit: number) => Promise<readonly ExpirableDelegation[]>;
  readonly dueBreakGlass: (now: number, limit: number) => Promise<readonly ExpirableBreakGlass[]>;
  readonly dueJoints: (now: number, limit: number) => Promise<readonly ExpirableJoint[]>;
}

// ===========================================================================
// 4. Worker configuration
// ===========================================================================

export interface ExpiryWorkerOptions {
  /** The versioned, validated contract the expiry mutations run under. */
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  /** The policy/control versions in force (bound onto every audit event). */
  readonly policyVersion: string;
  readonly controlVersion: string;
  /** The accountable owner recorded on every expiry audit event. Default 'team:governance-runtime'. */
  readonly owner?: string;
  /** Max rows swept PER KIND per pass (bounds the pass). Default 200. */
  readonly batchSize?: number;
}

const DEFAULT_OWNER = 'team:governance-runtime';
const DEFAULT_BATCH_SIZE = 200;

/** The system principal attributed as the actor on every expiry effect (deterministic, non-human). */
export const EXPIRY_ACTOR = 'system:expiry-worker';

// ===========================================================================
// 5. Per-entity + per-pass result shapes (fail-visible witnesses)
// ===========================================================================

/** The disposition of a single expiry attempt. */
export type ExpiryDisposition = 'expired' | 'skipped' | 'deduplicated' | 'failed';

/** The outcome of expiring (or skipping) one entity. */
export interface ExpiryItemResult {
  readonly kind: ExpirableKind;
  readonly entityId: string;
  readonly tenantId: string;
  readonly disposition: ExpiryDisposition;
  /** The stable idempotency key used (a re-run derives the identical key ⇒ dedup). */
  readonly idempotencyKey: string;
  /** The correlation id under which the effect committed (deterministic). */
  readonly correlationId: string;
  /** The safe next action an operator/automation should take (escalate for overdue break-glass). */
  readonly safeNextAction: 'none' | 'escalate' | 'reconcile';
  /** Populated on `failed`: a disclosure-safe error class + message. */
  readonly error: string | null;
}

/** The aggregate result of one expiry sweep pass (per kind + overall). */
export interface ExpiryPassResult {
  readonly scannedAt: number;
  readonly perKind: Readonly<
    Record<ExpirableKind, { scanned: number; expired: number; failed: number }>
  >;
  readonly expired: number;
  readonly skipped: number;
  readonly deduplicated: number;
  readonly failed: number;
  readonly results: readonly ExpiryItemResult[];
}

// ===========================================================================
// 6. Deterministic identity derivation (no wall clock, no randomness)
// ===========================================================================
//
// The idempotency key + correlation id + record id for an expiry effect are derived from the
// entity identity and the DEADLINE it crossed — NOT from `now`. So re-running the sweep at a later
// instant over the same durable state produces the SAME key, and the unit-of-work deduplicates it:
// an entity is expired at most once, whatever the scan cadence. (Binding the key to the deadline —
// not the scan time — is what makes the schedule idempotent rather than merely retry-safe.)

/** A stable idempotency key for a single entity's expiry (deadline-bound, scan-time-independent). */
export function expiryIdempotencyKey(
  kind: ExpirableKind,
  tenantId: string,
  entityId: string,
  deadlineAt: number,
): string {
  return (
    'expire-' +
    digest({ kind, tenantId, entityId, deadlineAt, purpose: 'expiry_idempotency' }).slice(0, 40)
  );
}

/** A stable correlation id for an expiry effect (same derivation basis as the key). */
export function expiryCorrelationId(
  kind: ExpirableKind,
  tenantId: string,
  entityId: string,
  deadlineAt: number,
): string {
  return (
    'corr-expire-' +
    digest({ kind, tenantId, entityId, deadlineAt, purpose: 'expiry_correlation' }).slice(0, 32)
  );
}

/** A stable decision-record id for a decision-package expiry (bound to the deadline crossed). */
export function expiryRecordId(tenantId: string, decisionId: string, expiresAt: number): string {
  return (
    'rec-expire-' +
    digest({ tenantId, decisionId, expiresAt, purpose: 'expiry_record' }).slice(0, 32)
  );
}

/** A stable audit event id for an expiry effect. */
function expiryAuditId(
  kind: ExpirableKind,
  tenantId: string,
  entityId: string,
  deadlineAt: number,
): string {
  return (
    'audit-expire-' +
    digest({ kind, tenantId, entityId, deadlineAt, purpose: 'expiry_audit' }).slice(0, 32)
  );
}

// ===========================================================================
// 7. The expiry worker
// ===========================================================================

export class ExpiryWorker {
  readonly #db: Database;
  readonly #ports: ExpiryReadPorts;
  readonly #oracles: ExpiryOracles;
  readonly #contract: SourceContract;
  readonly #expectedContractVersion: string;
  readonly #policyVersion: string;
  readonly #controlVersion: string;
  readonly #owner: string;
  readonly #batchSize: number;

  constructor(
    db: Database,
    ports: ExpiryReadPorts,
    oracles: ExpiryOracles,
    opts: ExpiryWorkerOptions,
  ) {
    this.#db = db;
    this.#ports = ports;
    this.#oracles = oracles;
    this.#contract = opts.contract;
    this.#expectedContractVersion = opts.expectedContractVersion;
    this.#policyVersion = opts.policyVersion;
    this.#controlVersion = opts.controlVersion;
    this.#owner = opts.owner ?? DEFAULT_OWNER;
    const b = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(b) || b <= 0)
      throw new RangeError('batchSize must be a positive integer');
    this.#batchSize = b;
  }

  /**
   * Run ONE deterministic expiry sweep at the injected instant `now`. Each kind is scanned for due
   * rows and every genuinely-lapsed entity is expired atomically (canonical + audit + outbox). The
   * result is a fail-visible per-kind + per-entity summary. Reading no wall clock and deriving every
   * key from the crossed deadline, re-running the same pass is a no-op (dedup).
   */
  async runExpiryPass(now: number): Promise<ExpiryPassResult> {
    if (!Number.isFinite(now)) throw new RangeError('now must be a finite epoch-ms instant');
    const results: ExpiryItemResult[] = [];
    const perKind = emptyPerKind();

    // 1. Decision packages (SC-005).
    for (const d of await this.#ports.dueDecisions(now, this.#batchSize)) {
      perKind.decision_package.scanned += 1;
      if (!this.#oracles.decisionExpired(d, now)) {
        results.push(this.#skip('decision_package', d.id, d.tenantId, d.expiresAt));
        continue;
      }
      const r = await this.#expireDecision(d, now);
      results.push(r);
      tally(perKind.decision_package, r);
    }

    // 2. Decision requirements (fail-closed lapsed gates).
    for (const req of await this.#ports.dueRequirements(now, this.#batchSize)) {
      perKind.decision_requirement.scanned += 1;
      if (!this.#oracles.requirementExpired(req, now)) {
        results.push(this.#skip('decision_requirement', req.id, req.tenantId, req.deadlineAt));
        continue;
      }
      const r = await this.#expireRequirement(req, now);
      results.push(r);
      tally(perKind.decision_requirement, r);
    }

    // 3. Delegations (FR-014, AC5).
    for (const g of await this.#ports.dueDelegations(now, this.#batchSize)) {
      perKind.delegation.scanned += 1;
      if (!this.#oracles.delegationExpired(g, now)) {
        results.push(this.#skip('delegation', g.delegationId, g.tenantId, g.expiresAt));
        continue;
      }
      const r = await this.#expireDelegation(g, now);
      results.push(r);
      tally(perKind.delegation, r);
    }

    // 4. Break-glass grants (FR-015 — overdue post-event review is ESCALATED, never silently closed).
    for (const bg of await this.#ports.dueBreakGlass(now, this.#batchSize)) {
      perKind.break_glass_grant.scanned += 1;
      if (!this.#oracles.breakGlassReviewOverdue(bg, now)) {
        results.push(this.#skip('break_glass_grant', bg.grantId, bg.tenantId, bg.reviewDueAt));
        continue;
      }
      const r = await this.#expireBreakGlass(bg, now);
      results.push(r);
      tally(perKind.break_glass_grant, r);
    }

    // 5. Joint decision packages (FR-013, AC6 — revoke a cross-tenant envelope whose decision lapsed).
    for (const j of await this.#ports.dueJoints(now, this.#batchSize)) {
      perKind.joint_decision_package.scanned += 1;
      if (!this.#oracles.jointLapsed(j, now)) {
        results.push(this.#skip('joint_decision_package', j.id, j.tenantId, j.underlyingExpiresAt));
        continue;
      }
      const r = await this.#expireJoint(j, now);
      results.push(r);
      tally(perKind.joint_decision_package, r);
    }

    return {
      scannedAt: now,
      perKind,
      expired: results.filter((r) => r.disposition === 'expired').length,
      skipped: results.filter((r) => r.disposition === 'skipped').length,
      deduplicated: results.filter((r) => r.disposition === 'deduplicated').length,
      failed: results.filter((r) => r.disposition === 'failed').length,
      results,
    };
  }

  // --- per-kind effects -----------------------------------------------------

  /**
   * Expire a decision package (SC-005). The canonical state advances to `expired` and embeds an
   * attributable expiry decision RECORD (action `expire`, actor `system:expiry-worker`) so the lapse
   * is a durable, explained outcome exactly like a human `expire` — the queue view then shows the
   * package closed, never a phantom "still pending past its deadline".
   */
  async #expireDecision(d: ExpirableDecision, now: number): Promise<ExpiryItemResult> {
    const key = expiryIdempotencyKey('decision_package', d.tenantId, d.id, d.expiresAt);
    const correlationId = expiryCorrelationId('decision_package', d.tenantId, d.id, d.expiresAt);
    const recordId = expiryRecordId(d.tenantId, d.id, d.expiresAt);
    const reason = {
      code: 'decision_expired',
      text: `decision package ${d.id} lapsed at its deadline (expiresAt=${d.expiresAt}); closed by the expiry worker (SC-005)`,
    };
    const expiredPackage = { ...d, status: 'expired' };
    const record = {
      id: recordId,
      tenantId: d.tenantId,
      decisionId: d.id,
      actorPrincipalId: EXPIRY_ACTOR,
      action: 'expire',
      reason,
      status: 'accepted',
      packageDigest: digest({ decisionId: d.id, version: d.version, expiresAt: d.expiresAt }),
      decidedAt: now,
      auditEventId: expiryAuditId('decision_package', d.tenantId, d.id, d.expiresAt),
    };
    const state = { package: expiredPackage, record, status: 'expired', accepted: true };
    return this.#commit({
      kind: 'decision_package',
      entityId: d.id,
      tenantId: d.tenantId,
      expectedVersion: d.version,
      state,
      idempotencyKey: key,
      correlationId,
      reason,
      scope: `tenant:${d.tenantId}/decision:${d.id}`,
      evidenceRefs: [`decision-record:${recordId}`, `deadline:${d.expiresAt}`],
      outboxTopic: EXPIRY_OUTBOX_TOPICS.decision_package,
      outboxPayload: {
        eventType: 'expired',
        decisionId: d.id,
        tenantId: d.tenantId,
        requesterPrincipalId: d.requesterPrincipalId,
        expiredAt: now,
      },
      safeNextAction: 'none',
    });
  }

  /**
   * Fail-close a lapsed decision requirement gate. A gate that missed its satisfaction window is set
   * `failed` so the parent decision can NEVER be accepted against a stale gate (the projector already
   * treats a non-satisfied gate as a blocking conflict). The parent decision is named for notification.
   */
  async #expireRequirement(req: ExpirableRequirement, now: number): Promise<ExpiryItemResult> {
    const key = expiryIdempotencyKey('decision_requirement', req.tenantId, req.id, req.deadlineAt);
    const correlationId = expiryCorrelationId(
      'decision_requirement',
      req.tenantId,
      req.id,
      req.deadlineAt,
    );
    const reason = {
      code: 'requirement_lapsed',
      text: `decision requirement ${req.id} for decision ${req.decisionId} lapsed its satisfaction window (deadlineAt=${req.deadlineAt}); failed closed`,
    };
    const state = { ...req, status: 'failed', failedAt: now };
    return this.#commit({
      kind: 'decision_requirement',
      entityId: req.id,
      tenantId: req.tenantId,
      expectedVersion: req.version,
      state,
      idempotencyKey: key,
      correlationId,
      reason,
      scope: `tenant:${req.tenantId}/decision:${req.decisionId}/requirement:${req.id}`,
      evidenceRefs: [`decision:${req.decisionId}`, `deadline:${req.deadlineAt}`],
      outboxTopic: EXPIRY_OUTBOX_TOPICS.decision_requirement,
      outboxPayload: {
        eventType: 'requirement_failed',
        requirementId: req.id,
        decisionId: req.decisionId,
        tenantId: req.tenantId,
        failedAt: now,
      },
      safeNextAction: 'none',
    });
  }

  /**
   * Expire a delegation whose window has closed (FR-014, AC5). The grant transitions to `expired`;
   * because delegation authority resolves through lineage, an expired grant stops conferring
   * authority immediately (delegation-service resolution fails closed for it and every child).
   */
  async #expireDelegation(g: ExpirableDelegation, now: number): Promise<ExpiryItemResult> {
    const key = expiryIdempotencyKey('delegation', g.tenantId, g.delegationId, g.expiresAt);
    const correlationId = expiryCorrelationId(
      'delegation',
      g.tenantId,
      g.delegationId,
      g.expiresAt,
    );
    const reason = {
      code: 'delegation_expired',
      text: `delegation ${g.delegationId} from ${g.delegatorPrincipalId} to ${g.recipientPrincipalId} lapsed at expiresAt=${g.expiresAt}; expired (FR-014)`,
    };
    const state = { ...g, status: 'expired' };
    return this.#commit({
      kind: 'delegation',
      entityId: g.delegationId,
      tenantId: g.tenantId,
      expectedVersion: g.version,
      state,
      idempotencyKey: key,
      correlationId,
      reason,
      scope: `tenant:${g.tenantId}/delegation:${g.delegationId}`,
      evidenceRefs: [
        `delegator:${g.delegatorPrincipalId}`,
        `recipient:${g.recipientPrincipalId}`,
        `deadline:${g.expiresAt}`,
      ],
      outboxTopic: EXPIRY_OUTBOX_TOPICS.delegation,
      outboxPayload: {
        eventType: 'delegation_expired',
        delegationId: g.delegationId,
        tenantId: g.tenantId,
        recipientPrincipalId: g.recipientPrincipalId,
        expiredAt: now,
      },
      safeNextAction: 'none',
    });
  }

  /**
   * Escalate a break-glass grant whose mandatory post-event review is OVERDUE (FR-015). Break-glass
   * NEVER confers decision authority, so this is an ACCOUNTABILITY effect: the grant is stamped
   * review-overdue and an escalation is published so a distinct reviewer completes the mandatory
   * review — a break-glass use is never left unaccounted for. The safe next action is `escalate`.
   */
  async #expireBreakGlass(bg: ExpirableBreakGlass, now: number): Promise<ExpiryItemResult> {
    const key = expiryIdempotencyKey('break_glass_grant', bg.tenantId, bg.grantId, bg.reviewDueAt);
    const correlationId = expiryCorrelationId(
      'break_glass_grant',
      bg.tenantId,
      bg.grantId,
      bg.reviewDueAt,
    );
    const reason = {
      code: 'break_glass_review_overdue',
      text: `break-glass grant ${bg.grantId} passed its post-event review deadline (reviewDueAt=${bg.reviewDueAt}) without a distinct reviewer sign-off; escalated (FR-015)`,
    };
    const state = { ...bg, status: 'review_overdue', reviewOverdueAt: now };
    return this.#commit({
      kind: 'break_glass_grant',
      entityId: bg.grantId,
      tenantId: bg.tenantId,
      expectedVersion: bg.version,
      state,
      idempotencyKey: key,
      correlationId,
      reason,
      scope: `tenant:${bg.tenantId}/break_glass:${bg.grantId}`,
      evidenceRefs: [
        `grantee:${bg.principalId}`,
        `reviewer:${bg.reviewerPrincipalId}`,
        `review-due:${bg.reviewDueAt}`,
      ],
      outboxTopic: EXPIRY_OUTBOX_TOPICS.break_glass_grant,
      outboxPayload: {
        eventType: 'emergency_review_overdue',
        grantId: bg.grantId,
        tenantId: bg.tenantId,
        reviewerPrincipalId: bg.reviewerPrincipalId,
        overdueAt: now,
      },
      safeNextAction: 'escalate',
    });
  }

  /**
   * Revoke a joint cross-tenant package whose underlying decision has lapsed (FR-013, AC6). The joint
   * envelope can no longer complete (the decision it federates is expired), so it transitions to
   * `revoked` and EVERY affected tenant is notified — without disclosing any tenant's evidence.
   */
  async #expireJoint(j: ExpirableJoint, now: number): Promise<ExpiryItemResult> {
    const key = expiryIdempotencyKey(
      'joint_decision_package',
      j.tenantId,
      j.id,
      j.underlyingExpiresAt,
    );
    const correlationId = expiryCorrelationId(
      'joint_decision_package',
      j.tenantId,
      j.id,
      j.underlyingExpiresAt,
    );
    const reason = {
      code: 'joint_underlying_expired',
      text: `joint decision package ${j.id} for decision ${j.decisionId} can no longer complete — the underlying decision lapsed at ${j.underlyingExpiresAt}; revoked (FR-013)`,
    };
    const state = { ...j, centralState: 'revoked', revokedAt: now };
    return this.#commit({
      kind: 'joint_decision_package',
      entityId: j.id,
      tenantId: j.tenantId,
      expectedVersion: j.version,
      state,
      idempotencyKey: key,
      correlationId,
      reason,
      scope: `tenant:${j.tenantId}/joint:${j.id}`,
      // Affected-tenant ids are carried as evidence for the notifier; NO tenant evidence is disclosed.
      evidenceRefs: [
        `decision:${j.decisionId}`,
        `deadline:${j.underlyingExpiresAt}`,
        ...j.affectedTenantIds.map((t) => `affected-tenant:${t}`),
      ],
      outboxTopic: EXPIRY_OUTBOX_TOPICS.joint_decision_package,
      outboxPayload: {
        eventType: 'joint_revoked',
        jointId: j.id,
        decisionId: j.decisionId,
        tenantId: j.tenantId,
        affectedTenantIds: [...j.affectedTenantIds],
        revokedAt: now,
      },
      safeNextAction: 'reconcile',
    });
  }

  // --- the single atomic commit path ---------------------------------------

  /**
   * Commit ONE expiry effect atomically through the unit-of-work: canonical transition + audit +
   * outbox, or nothing. Maps the commit outcome onto a fail-visible per-entity result. A `duplicate`
   * status ⇒ the entity was already expired on a prior pass (dedup — idempotent schedule). Any thrown
   * error is captured and returned as `failed` (never swallowed).
   */
  async #commit(input: {
    kind: ExpirableKind;
    entityId: string;
    tenantId: string;
    expectedVersion: number;
    state: unknown;
    idempotencyKey: string;
    correlationId: string;
    reason: { code: string; text: string };
    scope: string;
    evidenceRefs: readonly string[];
    outboxTopic: string;
    outboxPayload: unknown;
    safeNextAction: ExpiryItemResult['safeNextAction'];
  }): Promise<ExpiryItemResult> {
    const targetStateDigest = digest(input.state);
    const audit: AuditEventInput = {
      actor: EXPIRY_ACTOR,
      owner: this.#owner,
      reason: input.reason,
      sourceStateDigest:
        input.expectedVersion === 0 ? null : `${input.kind}-v${input.expectedVersion}`,
      targetStateDigest,
      scope: input.scope,
      policyVersion: this.#policyVersion,
      controlVersion: this.#controlVersion,
      evidenceRefs: input.evidenceRefs,
    };
    try {
      const result: CommitUnitOfWorkResult = await commitUnitOfWork(this.#db, {
        tenantId: input.tenantId,
        operationScope: `expiry.${input.kind}`,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        contract: this.#contract,
        expectedContractVersion: this.#expectedContractVersion,
        request: {
          kind: input.kind,
          entityId: input.entityId,
          expectedVersion: input.expectedVersion,
        },
        canonical: {
          entityKind: EXPIRY_ENTITY_KIND[input.kind],
          entityId: input.entityId,
          expectedVersion: input.expectedVersion,
          state: input.state,
        },
        action: 'expire',
        audit,
        outbox: { topic: input.outboxTopic, payload: input.outboxPayload },
      });
      const disposition: ExpiryDisposition = result.deduplicated
        ? 'deduplicated'
        : result.status === 'succeeded'
          ? 'expired'
          : 'failed';
      return {
        kind: input.kind,
        entityId: input.entityId,
        tenantId: input.tenantId,
        disposition,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        safeNextAction: disposition === 'expired' ? input.safeNextAction : 'none',
        error:
          disposition === 'failed'
            ? `commit did not succeed: status=${result.status} nextAction=${result.nextAction}`
            : null,
      };
    } catch (err) {
      return {
        kind: input.kind,
        entityId: input.entityId,
        tenantId: input.tenantId,
        disposition: 'failed',
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        safeNextAction: 'reconcile',
        error: describeExpiryError(err),
      };
    }
  }

  #skip(
    kind: ExpirableKind,
    entityId: string,
    tenantId: string,
    deadlineAt: number,
  ): ExpiryItemResult {
    return {
      kind,
      entityId,
      tenantId,
      disposition: 'skipped',
      idempotencyKey: expiryIdempotencyKey(kind, tenantId, entityId, deadlineAt),
      correlationId: expiryCorrelationId(kind, tenantId, entityId, deadlineAt),
      safeNextAction: 'none',
      error: null,
    };
  }

  /**
   * Independent read path: the current canonical state of an expired entity (the durable witness of
   * the effect — never the commit return value). Returns null if the entity has no canonical row.
   */
  async readExpired(
    kind: ExpirableKind,
    tenantId: string,
    entityId: string,
  ): Promise<{ version: number; stateDigest: string; state: unknown } | null> {
    const row = await readCanonicalState(this.#db, tenantId, EXPIRY_ENTITY_KIND[kind], entityId);
    if (!row) return null;
    return { version: row.version, stateDigest: row.stateDigest, state: row.state };
  }
}

// ===========================================================================
// 8. Utilities
// ===========================================================================

function emptyPerKind(): Record<
  ExpirableKind,
  { scanned: number; expired: number; failed: number }
> {
  return {
    decision_package: { scanned: 0, expired: 0, failed: 0 },
    decision_requirement: { scanned: 0, expired: 0, failed: 0 },
    delegation: { scanned: 0, expired: 0, failed: 0 },
    break_glass_grant: { scanned: 0, expired: 0, failed: 0 },
    joint_decision_package: { scanned: 0, expired: 0, failed: 0 },
  };
}

function tally(
  bucket: { scanned: number; expired: number; failed: number },
  r: ExpiryItemResult,
): void {
  if (r.disposition === 'expired') bucket.expired += 1;
  else if (r.disposition === 'failed') bucket.failed += 1;
}

/** Disclosure-safe error description (error class + message, never internal detail dumps). */
export function describeExpiryError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
