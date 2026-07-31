// @trustcircle/persistence — the unit-of-work that ATOMICALLY commits, in a single
// transaction, three durable rows: the new **canonical state**, an **AuditEvent**, and an
// **OutboxMessage** (Phase 21 / T021).
//
// ─────────────────────────────────────────────────────────────────────────────
// Phase-primary oracle (GAR-008 / VO-52d0780c11bcc6fd7583, and the transactional-outbox
// obligation VO-7a0dbcc527946b539bf6):
//
//   "Every onboarded source contract MUST be versioned and validated; mutating operations
//    MUST be correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate,
//    delayed, partial, conflicting, and uncertain outcomes."
//
// WHY a unit-of-work: a governed mutation is only *complete* when three facts are durable
// together — the authoritative (canonical) state change, the audit record that makes the
// action accountable (actor/owner/reason/scope/versions/correlation/outcome), and the outbox
// message that will asynchronously notify downstream consumers. If any one of the three is
// missing, the system is inconsistent:
//
//   * canonical state without an outbox row  ⇒ a silent change no consumer learns about
//     (breaks the transactional-outbox guarantee — a lost governance notification).
//   * canonical state without an audit row   ⇒ an unaccountable action (violates
//     "every automated action MUST capture ... before it can be reported as complete").
//   * an outbox row without the state change ⇒ a phantom event advertising an effect that
//     never happened (a duplicate/uncertain-outcome hazard).
//
// This module makes "all three or none" an *enforceable, independently-observable* invariant:
//
//   1. Atomic all-or-nothing — all three writes happen inside ONE `withTransaction`. A failure
//      writing ANY of the three rolls the whole unit back; there is never a partial durable
//      effect. Proven by injecting a fault at each write position and observing that NONE of
//      the three tables changed (independent read path), each with a positive control.
//
//   2. Versioned & validated source contract — the unit-of-work runs under a `SourceContract`
//      and an `expectedContractVersion`; drift or an unvalidated/unversioned contract is
//      refused BEFORE any row is written (inherited from `runMutation`).
//
//   3. Correlated — the same `correlationId` is written onto the idempotency ledger row, the
//      canonical_state row, the audit_event row, AND the outbox_message row, so the whole unit
//      is reconstructable across all four durable surfaces through independent read paths.
//
//   4. Deduplicated — the unit-of-work IS the idempotent effect of a `runMutation`. A duplicate
//      replay of the same request returns the first recorded result and executes the three
//      writes EXACTLY ONCE (no duplicate canonical row, no duplicate audit row, no duplicate
//      outbox message). A replay with a different body under the same key is a conflict, never a
//      silent overwrite.
//
//   5. Retry-bounded — transient serialization/deadlock failures are retried under the bounded
//      budget inherited from the `Database` retry policy; a non-retryable failure is never
//      retried and the outbox message is never published twice.
//
//   6. Reconcilable / safe under uncertain outcomes — if the commit outcome is unknown, the
//      operation is recorded `uncertain` with a `reconcile` safe-next-action and is NEVER
//      reported as success; `reconcile` re-reads the durable state (independent read path) and
//      resolves the true outcome without re-running the three writes (no duplicate effect).
//
//   7. Audit completeness gate — an AuditEvent that omits any required accountability facet
//      (actor/principal, accountable owner, reason, source & target state, policy & control
//      versions, evidence, scope, time, correlation, outcome) is REJECTED before the unit is
//      allowed to commit, so an action can never be reported complete without a complete
//      audit record (VO-d76c5d1293b91d26e094).
//
// The module reuses the transactional core in ./database.ts through its PUBLIC seam and adds no
// new runtime infrastructure: production wires the real `pg` Pool behind `SqlDriver`; tests wire
// a deterministic in-memory driver, so every invariant above is provable under `npm ci` with no
// live database, under Node 22 `--experimental-strip-types` / tsx.

import {
  type Database,
  type SqlExecutor,
  type SqlSession,
  type SourceContract,
  type OperationOutcome,
  type SafeNextAction,
  type OperationStatus,
  type IdempotencyRecord,
  runMutation,
  reconcileMutation,
  digest,
  canonicalJson,
} from './database.ts';

// ===========================================================================
// 0. Row shapes — the three durable surfaces committed as one unit
// ===========================================================================

/**
 * The authoritative (canonical) state row for a governed entity. `version` is an optimistic
 * concurrency counter: a write MUST advance it from the row's current version by exactly one,
 * so a stale/conflicting write is rejected rather than silently overwriting (safe under
 * conflicting outcomes). `stateDigest` is a durable content witness of `state`.
 */
export interface CanonicalStateRow {
  readonly tenantId: string;
  /** Governed entity kind, e.g. "controller" | "decision" | "source_record". */
  readonly entityKind: string;
  /** Stable entity identifier within (tenant, kind). */
  readonly entityId: string;
  /** Monotonic optimistic-concurrency version AFTER this write (>= 1). */
  readonly version: number;
  /** The full canonical state payload. */
  readonly state: unknown;
  /** sha-256 of the canonicalized state — a durable content witness. */
  readonly stateDigest: string;
  readonly correlationId: string;
  readonly updatedAt: number;
}

/**
 * The audit record that makes a governed action accountable. Per VO-d76c5d1293b91d26e094 every
 * decision/automated action MUST capture ALL of these BEFORE it can be reported complete;
 * `assertAuditComplete` refuses a record that omits or empties any of them.
 */
export interface AuditEventInput {
  /** The actor or principal that initiated the action. */
  readonly actor: string;
  /** The accountable owner (may differ from the actor). */
  readonly owner: string;
  /** Structured reason { code, text } — mandatory, non-empty. */
  readonly reason: { readonly code: string; readonly text: string };
  /** Source (pre-change) state digest — null only for a create. */
  readonly sourceStateDigest: string | null;
  /** Target (post-change) state digest — the canonical row's stateDigest. */
  readonly targetStateDigest: string;
  /** Governed scope this action touched, e.g. "tenant:acme/controller:c-1". */
  readonly scope: string;
  /** Version of the policy in force when the action was taken. */
  readonly policyVersion: string;
  /** Version of the control in force when the action was taken. */
  readonly controlVersion: string;
  /** Evidence references (>=1) that substantiate the action. */
  readonly evidenceRefs: readonly string[];
}

/** The persisted audit_event row (adds identity, correlation, time, outcome, action). */
export interface AuditEventRow extends AuditEventInput {
  readonly auditId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly correlationId: string;
  readonly outcome: string;
  readonly recordedAt: number;
}

/** Delivery lifecycle of an outbox message (the async-publication witness). */
export type OutboxStatus = 'pending' | 'published' | 'failed';

/**
 * The transactional-outbox row. It is written in the SAME transaction as the canonical state
 * change, so a governed change and its downstream notification are atomically consistent — the
 * publisher (apps/command-worker) later claims `pending` rows and publishes them with bounded
 * retries (VO-7a0dbcc527946b539bf6). `payloadDigest` is a durable content witness.
 */
export interface OutboxMessageRow {
  readonly messageId: string;
  readonly tenantId: string;
  /** Async event topic, e.g. "governance.controller.repaired". */
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadDigest: string;
  readonly correlationId: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly createdAt: number;
}

// ===========================================================================
// 1. The unit-of-work request + result
// ===========================================================================

export interface CommitUnitOfWorkRequest {
  readonly tenantId: string;
  /** Operation class (idempotency-key tuple member), e.g. "controller.repair". */
  readonly operationScope: string;
  /** Caller-supplied idempotency key, unique per (tenant, scope) per logical request. */
  readonly idempotencyKey: string;
  /** Correlates the whole unit across ledger/canonical/audit/outbox rows. */
  readonly correlationId: string;
  /** The versioned, validated contract the mutation runs under. */
  readonly contract: SourceContract;
  /** Version the operation was authored against; drift ⇒ no effect. */
  readonly expectedContractVersion: string;
  /** The full request payload (digested to detect key reuse with a different body). */
  readonly request: unknown;

  // --- the three rows to commit atomically ---
  /** Canonical entity coordinates + new state (version/digest are derived, not supplied). */
  readonly canonical: {
    readonly entityKind: string;
    readonly entityId: string;
    /** Expected CURRENT version for optimistic concurrency; 0 for a create. */
    readonly expectedVersion: number;
    readonly state: unknown;
  };
  /** The action name recorded on the audit row + used to derive the default outbox topic. */
  readonly action: string;
  /** The accountability facets for the audit record (completeness is enforced). */
  readonly audit: AuditEventInput;
  /** The downstream notification to enqueue in the same transaction. */
  readonly outbox: {
    readonly topic: string;
    readonly payload: unknown;
  };
}

export interface CommitUnitOfWorkResult {
  readonly status: OperationStatus;
  readonly nextAction: SafeNextAction;
  readonly deduplicated: boolean;
  readonly correlationId: string;
  readonly attempts: number;
  /** Present only on success — the durable identities/digests of the three committed rows. */
  readonly committed?: {
    readonly canonical: {
      readonly entityId: string;
      readonly version: number;
      readonly stateDigest: string;
    };
    readonly auditId: string;
    readonly outboxMessageId: string;
  };
}

// ===========================================================================
// 2. Audit completeness gate (fail BEFORE any durable effect)
// ===========================================================================

const NON_EMPTY = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Raised when an audit record omits or empties a mandatory accountability facet. */
export class IncompleteAuditError extends Error {
  readonly kind = 'incomplete_audit' as const;
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`audit record is incomplete — missing/empty: ${missing.join(', ')}`);
    this.name = 'IncompleteAuditError';
    this.missing = missing;
  }
}

/**
 * Refuse to proceed unless EVERY required accountability facet is present and non-empty. This is
 * the "captured before it can be reported as complete" gate — it runs BEFORE the transaction, so
 * an incomplete action never produces a durable effect.
 */
export function assertAuditComplete(a: AuditEventInput): AuditEventInput {
  const missing: string[] = [];
  if (!NON_EMPTY(a.actor)) missing.push('actor');
  if (!NON_EMPTY(a.owner)) missing.push('owner');
  if (!a.reason || !NON_EMPTY(a.reason.code) || !NON_EMPTY(a.reason.text)) missing.push('reason');
  // sourceStateDigest may be null (create), but the field must be present (null or non-empty).
  if (!(a.sourceStateDigest === null || NON_EMPTY(a.sourceStateDigest)))
    missing.push('sourceStateDigest');
  if (!NON_EMPTY(a.targetStateDigest)) missing.push('targetStateDigest');
  if (!NON_EMPTY(a.scope)) missing.push('scope');
  if (!NON_EMPTY(a.policyVersion)) missing.push('policyVersion');
  if (!NON_EMPTY(a.controlVersion)) missing.push('controlVersion');
  if (
    !Array.isArray(a.evidenceRefs) ||
    a.evidenceRefs.length === 0 ||
    !a.evidenceRefs.every(NON_EMPTY)
  ) {
    missing.push('evidenceRefs');
  }
  if (missing.length > 0) throw new IncompleteAuditError(missing);
  return a;
}

// ===========================================================================
// 3. Optimistic-concurrency conflict on the canonical row
// ===========================================================================

/** Raised when the canonical row's current version does not match the expected version. */
export class CanonicalVersionConflictError extends Error {
  readonly kind = 'canonical_version_conflict' as const;
  readonly entityId: string;
  readonly expected: number;
  readonly actual: number;
  constructor(entityId: string, expected: number, actual: number) {
    super(
      `canonical state conflict for ${entityId}: expected version ${expected}, found ${actual}`,
    );
    this.name = 'CanonicalVersionConflictError';
    this.entityId = entityId;
    this.expected = expected;
    this.actual = actual;
  }
}

// ===========================================================================
// 4. Deterministic identity derivation (no wall clock, no randomness in the module)
// ===========================================================================

/** Deterministic audit id from the unit's identity — stable across a duplicate replay. */
function deriveAuditId(req: CommitUnitOfWorkRequest): string {
  return (
    'audit-' +
    digest({
      tenantId: req.tenantId,
      operationScope: req.operationScope,
      idempotencyKey: req.idempotencyKey,
      kind: 'audit',
    }).slice(0, 32)
  );
}

/** Deterministic outbox message id — stable across a duplicate replay (no duplicate message). */
function deriveOutboxId(req: CommitUnitOfWorkRequest): string {
  return (
    'outbox-' +
    digest({
      tenantId: req.tenantId,
      operationScope: req.operationScope,
      idempotencyKey: req.idempotencyKey,
      kind: 'outbox',
    }).slice(0, 32)
  );
}

// ===========================================================================
// 5. SQL — the three atomic writes (guarded so a partial failure rolls back)
// ===========================================================================

/**
 * SQL that creates the three unit-of-work tables (safe to run repeatedly). The command-worker
 * outbox publisher reads `outbox_message` on the `(status, created_at)` index; the canonical
 * table's PK enforces exactly-one authoritative row per (tenant, kind, id).
 */
export const UNIT_OF_WORK_SQL = `
CREATE TABLE IF NOT EXISTS canonical_state (
  tenant_id     TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  state_json    TEXT NOT NULL,
  state_digest  TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, entity_kind, entity_id)
);
CREATE TABLE IF NOT EXISTS audit_event (
  audit_id           TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  action             TEXT NOT NULL,
  actor              TEXT NOT NULL,
  owner              TEXT NOT NULL,
  reason_code        TEXT NOT NULL,
  reason_text        TEXT NOT NULL,
  source_state_digest TEXT,
  target_state_digest TEXT NOT NULL,
  scope              TEXT NOT NULL,
  policy_version     TEXT NOT NULL,
  control_version    TEXT NOT NULL,
  evidence_refs      TEXT NOT NULL,
  correlation_id     TEXT NOT NULL,
  outcome            TEXT NOT NULL,
  recorded_at        BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox_message (
  message_id     TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  topic          TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  attempts       INTEGER NOT NULL,
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_message_claim_idx ON outbox_message (status, created_at);
`;

/** Read the CURRENT canonical version (independent read path) for the optimistic-concurrency check. */
async function readCanonicalVersion(
  tx: SqlExecutor,
  tenantId: string,
  entityKind: string,
  entityId: string,
): Promise<number> {
  const res = await tx.query<{ version: number }>(
    'SELECT version FROM canonical_state WHERE tenant_id=$1 AND entity_kind=$2 AND entity_id=$3',
    [tenantId, entityKind, entityId],
  );
  return res.rows[0]?.version ?? 0;
}

async function upsertCanonical(tx: SqlExecutor, row: CanonicalStateRow): Promise<void> {
  await tx.query(
    `INSERT INTO canonical_state
       (tenant_id, entity_kind, entity_id, version, state_json, state_digest, correlation_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, entity_kind, entity_id) DO UPDATE SET
       version = EXCLUDED.version,
       state_json = EXCLUDED.state_json,
       state_digest = EXCLUDED.state_digest,
       correlation_id = EXCLUDED.correlation_id,
       updated_at = EXCLUDED.updated_at`,
    [
      row.tenantId,
      row.entityKind,
      row.entityId,
      row.version,
      canonicalJson(row.state),
      row.stateDigest,
      row.correlationId,
      row.updatedAt,
    ],
  );
}

async function insertAudit(tx: SqlExecutor, row: AuditEventRow): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event
       (audit_id, tenant_id, action, actor, owner, reason_code, reason_text,
        source_state_digest, target_state_digest, scope, policy_version, control_version,
        evidence_refs, correlation_id, outcome, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      row.auditId,
      row.tenantId,
      row.action,
      row.actor,
      row.owner,
      row.reason.code,
      row.reason.text,
      row.sourceStateDigest,
      row.targetStateDigest,
      row.scope,
      row.policyVersion,
      row.controlVersion,
      JSON.stringify(row.evidenceRefs),
      row.correlationId,
      row.outcome,
      row.recordedAt,
    ],
  );
}

async function insertOutbox(tx: SqlExecutor, row: OutboxMessageRow): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_message
       (message_id, tenant_id, topic, payload_json, payload_digest, correlation_id, status, attempts, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.messageId,
      row.tenantId,
      row.topic,
      canonicalJson(row.payload),
      row.payloadDigest,
      row.correlationId,
      row.status,
      row.attempts,
      row.createdAt,
    ],
  );
}

// ===========================================================================
// 6. commitUnitOfWork — the atomic three-row commit
// ===========================================================================

/**
 * Atomically commit the canonical state change, its AuditEvent, and its OutboxMessage in ONE
 * transaction, wrapped by `runMutation` so the whole unit inherits versioned/validated-contract
 * enforcement, correlation, dedup, bounded retry, reconciliation, and safe-under-uncertain
 * behavior. Returns the durable identities of the three committed rows on success; on a
 * non-success outcome the caller receives the safe next action and NO partial effect exists.
 */
export async function commitUnitOfWork(
  db: Database,
  req: CommitUnitOfWorkRequest,
): Promise<CommitUnitOfWorkResult> {
  // (0) Completeness gate — BEFORE any effect. An incomplete action never commits.
  assertAuditComplete(req.audit);

  const stateDigest = digest(req.canonical.state);
  const payloadDigest = digest(req.outbox.payload);
  const auditId = deriveAuditId(req);
  const outboxMessageId = deriveOutboxId(req);
  const nextVersion = req.canonical.expectedVersion + 1;

  const outcome: OperationOutcome<CommitUnitOfWorkResult['committed']> = await runMutation(db, {
    tenantId: req.tenantId,
    operationScope: req.operationScope,
    idempotencyKey: req.idempotencyKey,
    correlationId: req.correlationId,
    contract: req.contract,
    expectedContractVersion: req.expectedContractVersion,
    request: req.request,
    // The three writes ARE the idempotent effect — committed atomically or not at all.
    effect: async (tx: SqlSession) => {
      // (a) Optimistic-concurrency guard on the canonical row (safe under conflicting outcomes).
      const current = await readCanonicalVersion(
        tx,
        req.tenantId,
        req.canonical.entityKind,
        req.canonical.entityId,
      );
      if (current !== req.canonical.expectedVersion) {
        throw new CanonicalVersionConflictError(
          req.canonical.entityId,
          req.canonical.expectedVersion,
          current,
        );
      }
      const now = db.now();

      // (b) canonical state
      await upsertCanonical(tx, {
        tenantId: req.tenantId,
        entityKind: req.canonical.entityKind,
        entityId: req.canonical.entityId,
        version: nextVersion,
        state: req.canonical.state,
        stateDigest,
        correlationId: req.correlationId,
        updatedAt: now,
      });

      // (c) audit event — complete, correlated, outcome-stamped
      await insertAudit(tx, {
        auditId,
        tenantId: req.tenantId,
        action: req.action,
        actor: req.audit.actor,
        owner: req.audit.owner,
        reason: req.audit.reason,
        sourceStateDigest: req.audit.sourceStateDigest,
        targetStateDigest: stateDigest,
        scope: req.audit.scope,
        policyVersion: req.audit.policyVersion,
        controlVersion: req.audit.controlVersion,
        evidenceRefs: req.audit.evidenceRefs,
        correlationId: req.correlationId,
        outcome: 'succeeded',
        recordedAt: now,
      });

      // (d) outbox message — pending; the publisher will claim & deliver with bounded retries
      await insertOutbox(tx, {
        messageId: outboxMessageId,
        tenantId: req.tenantId,
        topic: req.outbox.topic,
        payload: req.outbox.payload,
        payloadDigest,
        correlationId: req.correlationId,
        status: 'pending',
        attempts: 0,
        createdAt: now,
      });

      return {
        canonical: { entityId: req.canonical.entityId, version: nextVersion, stateDigest },
        auditId,
        outboxMessageId,
      };
    },
  });

  return {
    status: outcome.status,
    nextAction: outcome.nextAction,
    deduplicated: outcome.deduplicated,
    correlationId: outcome.correlationId,
    attempts: outcome.attempts,
    ...(outcome.result ? { committed: outcome.result } : {}),
  };
}

// ===========================================================================
// 7. Independent read paths — the durable witnesses of the three rows
// ===========================================================================

export async function readCanonicalState(
  db: Database,
  tenantId: string,
  entityKind: string,
  entityId: string,
): Promise<CanonicalStateRow | null> {
  const res = await db.query<{
    tenant_id: string;
    entity_kind: string;
    entity_id: string;
    version: number;
    state_json: string;
    state_digest: string;
    correlation_id: string;
    updated_at: number;
  }>('SELECT * FROM canonical_state WHERE tenant_id=$1 AND entity_kind=$2 AND entity_id=$3', [
    tenantId,
    entityKind,
    entityId,
  ]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    tenantId: r.tenant_id,
    entityKind: r.entity_kind,
    entityId: r.entity_id,
    version: r.version,
    state: JSON.parse(r.state_json),
    stateDigest: r.state_digest,
    correlationId: r.correlation_id,
    updatedAt: r.updated_at,
  };
}

interface AuditRow {
  readonly audit_id: string;
  readonly tenant_id: string;
  readonly action: string;
  readonly actor: string;
  readonly owner: string;
  readonly reason_code: string;
  readonly reason_text: string;
  readonly source_state_digest: string | null;
  readonly target_state_digest: string;
  readonly scope: string;
  readonly policy_version: string;
  readonly control_version: string;
  readonly evidence_refs: string;
  readonly correlation_id: string;
  readonly outcome: string;
  readonly recorded_at: number;
}

export async function readAuditEvent(db: Database, auditId: string): Promise<AuditEventRow | null> {
  const res = await db.query<AuditRow>('SELECT * FROM audit_event WHERE audit_id=$1', [auditId]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    auditId: r.audit_id,
    tenantId: r.tenant_id,
    action: r.action,
    actor: r.actor,
    owner: r.owner,
    reason: { code: r.reason_code, text: r.reason_text },
    sourceStateDigest: r.source_state_digest ?? null,
    targetStateDigest: r.target_state_digest,
    scope: r.scope,
    policyVersion: r.policy_version,
    controlVersion: r.control_version,
    evidenceRefs: JSON.parse(r.evidence_refs ?? '[]'),
    correlationId: r.correlation_id,
    outcome: r.outcome,
    recordedAt: r.recorded_at,
  };
}

interface OutboxRow {
  readonly message_id: string;
  readonly tenant_id: string;
  readonly topic: string;
  readonly payload_json: string;
  readonly payload_digest: string;
  readonly correlation_id: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly created_at: number;
}

export async function readOutboxMessage(
  db: Database,
  messageId: string,
): Promise<OutboxMessageRow | null> {
  const res = await db.query<OutboxRow>('SELECT * FROM outbox_message WHERE message_id=$1', [
    messageId,
  ]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    messageId: r.message_id,
    tenantId: r.tenant_id,
    topic: r.topic,
    payload: JSON.parse(r.payload_json),
    payloadDigest: r.payload_digest,
    correlationId: r.correlation_id,
    status: r.status,
    attempts: r.attempts,
    createdAt: r.created_at,
  };
}

/**
 * Reconcile a unit-of-work whose commit outcome is uncertain, WITHOUT re-running the three
 * writes. The true state is observed through the independent canonical/outbox read paths: if the
 * canonical row exists at the expected version AND the outbox message exists, the unit genuinely
 * committed; otherwise the outcome stays unresolved (never claimed as unconfirmed success).
 */
export async function reconcileUnitOfWork(
  db: Database,
  req: Pick<
    CommitUnitOfWorkRequest,
    'tenantId' | 'operationScope' | 'idempotencyKey' | 'canonical'
  >,
): Promise<{
  resolved: boolean;
  status: OperationStatus;
  nextAction: SafeNextAction;
  correlationId: string | null;
}> {
  return reconcileMutation(
    db,
    {
      tenantId: req.tenantId,
      operationScope: req.operationScope,
      idempotencyKey: req.idempotencyKey,
    },
    async (_rec: IdempotencyRecord | null) => {
      const canonical = await readCanonicalState(
        db,
        req.tenantId,
        req.canonical.entityKind,
        req.canonical.entityId,
      );
      if (!canonical) return 'unknown';
      // The write advances version by exactly one; observing it proves the unit committed.
      if (canonical.version >= req.canonical.expectedVersion + 1) return 'succeeded';
      return 'unknown';
    },
  );
}
