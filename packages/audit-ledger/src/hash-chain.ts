// packages/audit-ledger/src/hash-chain.ts
//
// Phase 30 / task T030 / GAR-002 / VO-d76c5d1293b91d26e094.
//
// The RUNTIME half of the append-only, hash-chained tenant audit ledger. Phase 29
// (db/migrations/0005_audit_ledger.sql) is the PHYSICAL enforcement — the `audit_event` row is
// NOT NULL / CHECK-guarded on exactly the accountability columns. This module is the
// application-layer contract that PRODUCES rows that satisfy that schema and CANNOT be reported
// complete unless every accountability field is present. It gives the persistence/unit-of-work
// layer three deterministic, dependency-free capabilities:
//
//   1. CANONICAL SERIALIZATION — `canonicalizeAuditRecord` turns an accountability record into a
//      byte-stable canonical form (sorted keys, normalized arrays, no ambient state), so two
//      independent processes derive the SAME digest for the SAME content. This is the substrate
//      the hash chain and the signed checkpoints are computed over.
//
//   2. PER-LEDGER HASH CHAINING — `appendAuditRecord` / `AuditLedger` link each record's
//      `previousDigest` to the prior record's `integrityDigest` within a single (tenant, ledger)
//      ledger, and derive `integrityDigest = sha256(previousDigest || canonical(content))`. The
//      chain is a strict total order (monotone sequence, genesis previousDigest) that cannot fork.
//
//   3. APPEND VERIFICATION — `verifyAppend` (single step) and `verifyLedger` (whole chain) are the
//      INDEPENDENT READ PATH: they re-derive every digest and re-check the accountability contract
//      and the linkage, so a missing field, a mutated field, a reordered/duplicated/dropped record,
//      or a broken link is detected. `assertReportable` is the gate the phase AC names directly:
//      an action cannot be "reported as complete" unless the record is fully accountable.
//
// The AC clause → field mapping is spelled out on `AccountabilityRecord`. The completeness rules
// here mirror the SQL CHECK constraints in 0005_audit_ledger.sql byte-for-byte in intent:
//   * actor_present, reason_text_for_human, recorded_after_occurred, sequence_positive,
//   * governed_completion_requires_versions_and_evidence.
//
// Dependency policy: Node built-in `crypto` only (+ type-only import from @trustcircle/domain,
// erased under verbatimModuleSyntax). No clock, no fs, no network — fully deterministic, so it runs
// under Node 22 `--experimental-strip-types` with no adjacent infrastructure.

import { createHash } from 'node:crypto';
import type { OutcomeCode } from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// Outcome vocabulary of the LEDGER (mirrors the `audit_outcome` enum in 0005_audit_ledger.sql).
// This is the terminal disposition the AC's "outcome" clause requires. Kept as a closed, stable
// set so an unknown outcome is rejected at the boundary.

export const AUDIT_OUTCOMES = [
  'succeeded',
  'failed',
  'denied',
  'rejected',
  'partial',
  'uncertain',
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export function isAuditOutcome(s: unknown): s is AuditOutcome {
  return typeof s === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(s);
}

/**
 * The outcomes that mean the action reached COMPLETION (and therefore trigger the
 * policy/control-version + evidence completeness requirement). A denied/rejected/failed attempt
 * never reached completion; an uncertain outcome is still pending reconciliation.
 * Mirrors `outcome IN ('succeeded','partial')` in the SQL CHECK.
 */
export const COMPLETED_OUTCOMES: readonly AuditOutcome[] = Object.freeze(['succeeded', 'partial']);

export function isCompletedOutcome(o: AuditOutcome): boolean {
  return (COMPLETED_OUTCOMES as readonly string[]).includes(o);
}

// Bridge to the domain outcome vocabulary. The domain OutcomeCode is the broader
// request-processing vocabulary; the ledger records the terminal audit disposition. This total
// map lets a caller that already has a domain OutcomeCode record the correct audit outcome.
export const AUDIT_OUTCOME_BY_OUTCOME_CODE: Readonly<Record<OutcomeCode, AuditOutcome>> =
  Object.freeze({
    succeeded: 'succeeded',
    duplicate: 'succeeded',
    retryable_failure: 'failed',
    non_retryable_failure: 'failed',
    rate_limited: 'failed',
    policy_denied: 'denied',
    contract_invalid: 'rejected',
    version_unsupported: 'rejected',
    conflict: 'rejected',
    uncertain: 'uncertain',
  });

// ---------------------------------------------------------------------------
// The accountability record — the AC clauses, one to one.
//
// Phase-30 AC (GAR-002 / VO-d76c5d1293b91d26e094): "Every decision and automated action MUST
// capture actor or principal, accountable owner, reason, source and target state, policy and
// control versions, evidence, scope, time, correlation, and outcome before it can be reported as
// complete."

/** ACTOR / PRINCIPAL (AC: "actor or principal"). */
export interface AuditActor {
  /** Human/service principal id. Required unless the action is a system/automated action. */
  readonly principalId?: string | null;
  /** The role assignment the actor exercised (authority provenance). */
  readonly roleAssignmentId?: string | null;
  /** True when this is a system/automated action (no human principal). */
  readonly isSystem: boolean;
  /** Automation identifier — required when `isSystem` is true. */
  readonly automationId?: string | null;
}

/** REASON (AC: "reason"). Machine code always; human text required for a non-system action. */
export interface AuditReason {
  readonly code: string;
  readonly text?: string | null;
}

/** BOUND TARGET + SOURCE/TARGET/ACTUAL STATE (AC: "source and target state") as digests. */
export interface AuditStateBinding {
  readonly entityType: string;
  readonly entityId: string;
  readonly entityVersion?: string | null;
  readonly sourceStateDigest: string;
  readonly targetStateDigest: string;
  /** Filled on reconciliation of an uncertain/partial outcome. */
  readonly actualStateDigest?: string | null;
}

/** POLICY AND CONTROL VERSIONS + EVIDENCE (AC: "policy and control versions", "evidence"). */
export interface AuditGovernance {
  readonly policyVersionIds: readonly string[];
  readonly controlVersionIds: readonly string[];
  /** Immutable evidence manifest backing a completed governed action. */
  readonly evidenceManifestId?: string | null;
}

/** SCOPE (AC: "scope"). Requested vs actual scope objects. */
export interface AuditScope {
  readonly requested: Readonly<Record<string, unknown>>;
  readonly actual: Readonly<Record<string, unknown>>;
}

/** TIME (AC: "time"). Both domain occurrence time and ledger recording time (epoch ms). */
export interface AuditTiming {
  readonly occurredAt: number;
  readonly recordedAt: number;
}

/** CORRELATION (AC: "correlation"). */
export interface AuditCorrelation {
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly traceId?: string | null;
}

/**
 * The full accountability record for one decision/automated action. Every AC clause maps to a
 * required member here; `assertAccountable` enforces the same completeness the SQL schema does.
 * `sequence` is the record's position in its (tenant, ledger) ledger (1-based, monotone).
 */
export interface AccountabilityRecord {
  readonly auditEventId: string;
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly sequence: number;

  readonly eventType: string;
  readonly schemaVersion: string;

  readonly actor: AuditActor; // AC: actor or principal
  readonly accountableOwnerPrincipalId: string; // AC: accountable owner
  readonly reason: AuditReason; // AC: reason
  readonly state: AuditStateBinding; // AC: source and target state
  readonly governance: AuditGovernance; // AC: policy and control versions + evidence
  readonly scope: AuditScope; // AC: scope
  readonly timing: AuditTiming; // AC: time
  readonly correlation: AuditCorrelation; // AC: correlation
  readonly outcome: AuditOutcome; // AC: outcome
}

// ---------------------------------------------------------------------------
// Completeness / accountability contract — the "before it can be reported as complete" gate.

export class AccountabilityError extends Error {
  /** Machine code identifying the missing/invalid accountability clause. */
  readonly clause: string;
  constructor(clause: string, message: string) {
    super(message);
    this.name = 'AccountabilityError';
    this.clause = clause;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/**
 * Assert a record carries EVERY accountability field required by the AC before it may be recorded
 * (and therefore before the action can be reported complete). Throws `AccountabilityError` naming
 * the first violated clause. The clause set mirrors 0005_audit_ledger.sql (NOT NULL columns +
 * the five CHECK constraints), so the runtime gate and the physical schema agree.
 */
export function assertAccountable(r: unknown): asserts r is AccountabilityRecord {
  if (typeof r !== 'object' || r === null) {
    throw new AccountabilityError('record', 'accountability record must be an object');
  }
  const rec = r as Record<string, unknown>;

  // Identity + ledger position.
  if (!isNonEmptyString(rec['auditEventId'])) {
    throw new AccountabilityError('identity', 'auditEventId is required');
  }
  if (!isNonEmptyString(rec['tenantId'])) {
    throw new AccountabilityError('identity', 'tenantId is required');
  }
  if (!isNonEmptyString(rec['ledgerId'])) {
    throw new AccountabilityError('identity', 'ledgerId is required');
  }
  // sequence_positive: monotone, >= 1.
  const seq = rec['sequence'];
  if (!isFiniteInt(seq) || seq < 1) {
    throw new AccountabilityError('sequence', 'sequence must be an integer >= 1');
  }
  if (!isNonEmptyString(rec['eventType'])) {
    throw new AccountabilityError('event_type', 'eventType is required');
  }
  if (!isNonEmptyString(rec['schemaVersion'])) {
    throw new AccountabilityError('schema_version', 'schemaVersion is required');
  }

  // ACTOR / PRINCIPAL — actor_present: known principal OR explicit system+automation id.
  const actor = rec['actor'] as AuditActor | undefined;
  if (typeof actor !== 'object' || actor === null || typeof actor.isSystem !== 'boolean') {
    throw new AccountabilityError('actor', 'actor with an isSystem flag is required');
  }
  const hasPrincipal = isNonEmptyString(actor.principalId);
  const hasSystemActor = actor.isSystem === true && isNonEmptyString(actor.automationId);
  if (!hasPrincipal && !hasSystemActor) {
    throw new AccountabilityError(
      'actor_present',
      'actor is required: a principal id, or a system action carrying an automation id',
    );
  }

  // ACCOUNTABLE OWNER — always required.
  if (!isNonEmptyString(rec['accountableOwnerPrincipalId'])) {
    throw new AccountabilityError('accountable_owner', 'accountableOwnerPrincipalId is required');
  }

  // REASON — code always required; text required for a human (non-system) action.
  const reason = rec['reason'] as AuditReason | undefined;
  if (typeof reason !== 'object' || reason === null || !isNonEmptyString(reason.code)) {
    throw new AccountabilityError('reason', 'reason.code is required');
  }
  if (actor.isSystem !== true && !isNonEmptyString(reason.text)) {
    throw new AccountabilityError(
      'reason_text_for_human',
      'reason.text is required for a human (non-system) action',
    );
  }

  // SOURCE AND TARGET STATE.
  const state = rec['state'] as AuditStateBinding | undefined;
  if (typeof state !== 'object' || state === null) {
    throw new AccountabilityError('state', 'state binding is required');
  }
  if (!isNonEmptyString(state.entityType) || !isNonEmptyString(state.entityId)) {
    throw new AccountabilityError('state', 'state.entityType and state.entityId are required');
  }
  if (!isNonEmptyString(state.sourceStateDigest)) {
    throw new AccountabilityError('source_state', 'state.sourceStateDigest is required');
  }
  if (!isNonEmptyString(state.targetStateDigest)) {
    throw new AccountabilityError('target_state', 'state.targetStateDigest is required');
  }

  // POLICY AND CONTROL VERSIONS + EVIDENCE.
  const gov = rec['governance'] as AuditGovernance | undefined;
  if (
    typeof gov !== 'object' ||
    gov === null ||
    !Array.isArray(gov.policyVersionIds) ||
    !Array.isArray(gov.controlVersionIds)
  ) {
    throw new AccountabilityError(
      'governance',
      'governance with policyVersionIds and controlVersionIds arrays is required',
    );
  }

  // SCOPE.
  const scope = rec['scope'] as AuditScope | undefined;
  if (
    typeof scope !== 'object' ||
    scope === null ||
    typeof scope.requested !== 'object' ||
    scope.requested === null ||
    typeof scope.actual !== 'object' ||
    scope.actual === null
  ) {
    throw new AccountabilityError('scope', 'scope with requested and actual objects is required');
  }

  // TIME — both present; recorded_after_occurred.
  const timing = rec['timing'] as AuditTiming | undefined;
  if (
    typeof timing !== 'object' ||
    timing === null ||
    !isFiniteInt(timing.occurredAt) ||
    !isFiniteInt(timing.recordedAt)
  ) {
    throw new AccountabilityError('time', 'timing.occurredAt and timing.recordedAt are required');
  }
  if (timing.recordedAt < timing.occurredAt) {
    throw new AccountabilityError(
      'recorded_after_occurred',
      'timing.recordedAt cannot precede timing.occurredAt',
    );
  }

  // CORRELATION.
  const corr = rec['correlation'] as AuditCorrelation | undefined;
  if (typeof corr !== 'object' || corr === null || !isNonEmptyString(corr.correlationId)) {
    throw new AccountabilityError('correlation', 'correlation.correlationId is required');
  }

  // OUTCOME.
  const outcome = rec['outcome'];
  if (!isAuditOutcome(outcome)) {
    throw new AccountabilityError('outcome', `outcome must be one of ${AUDIT_OUTCOMES.join(', ')}`);
  }

  // governed_completion_requires_versions_and_evidence: a COMPLETED (succeeded/partial) governed
  // (non-system) action must have been evaluated against >=1 policy AND >=1 control version and
  // must reference the evidence manifest that backs it. denied/rejected/failed/uncertain are
  // exempt (never reached completion); a system observation is exempt.
  const isGovernedCompletion = actor.isSystem !== true && isCompletedOutcome(outcome);
  if (isGovernedCompletion) {
    if (gov.policyVersionIds.length < 1) {
      throw new AccountabilityError(
        'governed_completion_policy_versions',
        'a completed governed action requires at least one policy version id',
      );
    }
    if (gov.controlVersionIds.length < 1) {
      throw new AccountabilityError(
        'governed_completion_control_versions',
        'a completed governed action requires at least one control version id',
      );
    }
    if (!isNonEmptyString(gov.evidenceManifestId)) {
      throw new AccountabilityError(
        'governed_completion_evidence',
        'a completed governed action requires an evidence manifest reference',
      );
    }
  }
}

/** Non-throwing predicate form of {@link assertAccountable}. */
export function isAccountable(r: unknown): r is AccountabilityRecord {
  try {
    assertAccountable(r);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gate the phase AC names directly: an action cannot be "reported as complete" unless its
 * accountability record is fully populated. This is a semantic alias of {@link assertAccountable}
 * used at the reporting boundary so call sites read intentionally.
 */
export function assertReportable(r: unknown): asserts r is AccountabilityRecord {
  assertAccountable(r);
}

// ---------------------------------------------------------------------------
// 1. CANONICAL SERIALIZATION.

/**
 * Deterministically canonicalize any JSON-ish value: object keys are emitted in sorted order,
 * arrays preserve order, and `undefined` is normalized to `null` so absence is explicit. The
 * result is byte-stable for equal content regardless of the insertion order the caller used.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/**
 * Canonical serialization of an accountability record's CONTENT — the exact, stable byte-form the
 * hash chain and the signed checkpoints are computed over. Arrays whose order is not semantically
 * meaningful (policy/control version ids) are sorted so an equivalent record always canonicalizes
 * identically. The `previousDigest`/`integrityDigest` chain fields are deliberately NOT part of
 * the content digest input — they wrap the content, they are not part of it.
 *
 * Throws `AccountabilityError` if the record is not fully accountable, so a canonical form can
 * never be produced for an incomplete record.
 */
export function canonicalizeAuditRecord(r: AccountabilityRecord): string {
  assertAccountable(r);
  const content = {
    auditEventId: r.auditEventId,
    tenantId: r.tenantId,
    ledgerId: r.ledgerId,
    sequence: r.sequence,
    eventType: r.eventType,
    schemaVersion: r.schemaVersion,
    actor: {
      principalId: r.actor.principalId ?? null,
      roleAssignmentId: r.actor.roleAssignmentId ?? null,
      isSystem: r.actor.isSystem,
      automationId: r.actor.automationId ?? null,
    },
    accountableOwnerPrincipalId: r.accountableOwnerPrincipalId,
    reason: { code: r.reason.code, text: r.reason.text ?? null },
    state: {
      entityType: r.state.entityType,
      entityId: r.state.entityId,
      entityVersion: r.state.entityVersion ?? null,
      sourceStateDigest: r.state.sourceStateDigest,
      targetStateDigest: r.state.targetStateDigest,
      actualStateDigest: r.state.actualStateDigest ?? null,
    },
    governance: {
      // Sorted: version-id set membership is order-independent.
      policyVersionIds: [...r.governance.policyVersionIds].sort(),
      controlVersionIds: [...r.governance.controlVersionIds].sort(),
      evidenceManifestId: r.governance.evidenceManifestId ?? null,
    },
    scope: {
      requested: canonicalize(r.scope.requested),
      actual: canonicalize(r.scope.actual),
    },
    timing: { occurredAt: r.timing.occurredAt, recordedAt: r.timing.recordedAt },
    correlation: {
      correlationId: r.correlation.correlationId,
      causationId: r.correlation.causationId ?? null,
      traceId: r.correlation.traceId ?? null,
    },
    outcome: r.outcome,
  };
  return canonicalJson(content);
}

/** SHA-256 hex digest of a record's canonical content form. */
export function contentDigest(r: AccountabilityRecord): string {
  return sha256Hex(canonicalizeAuditRecord(r));
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 2. PER-LEDGER HASH CHAINING.

/**
 * The genesis link a ledger's first record chains from. A constant, well-known sentinel so the
 * first record is unambiguous and cannot be silently prepended (any record claiming sequence 1
 * MUST carry this previousDigest).
 */
export const GENESIS_PREVIOUS_DIGEST =
  '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Derive the integrity digest for a record given the digest of the record before it. The chain
 * binds the content to its predecessor: `integrityDigest = sha256(previousDigest || contentDigest)`.
 * Any change to the content, or to the predecessor, changes this digest.
 */
export function deriveIntegrityDigest(previousDigest: string, r: AccountabilityRecord): string {
  if (!isNonEmptyString(previousDigest)) {
    throw new AccountabilityError('previous_digest', 'previousDigest is required');
  }
  return sha256Hex(`${previousDigest}:${contentDigest(r)}`);
}

/** A record together with its chain linkage — the shape persisted as one `audit_event` row. */
export interface ChainedAuditRecord extends AccountabilityRecord {
  readonly previousDigest: string;
  readonly integrityDigest: string;
}

/**
 * The append-only, per-ledger hash chain state. Deep-frozen and immutable: `append` returns a NEW
 * ledger; the receiver is never mutated. `records` is the ordered chain. This is the in-memory
 * projection of one (tenant, ledger) `audit_event` sequence.
 */
export interface AuditLedger {
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly records: readonly ChainedAuditRecord[];
  readonly headDigest: string;
  readonly nextSequence: number;
}

/** Create an empty ledger for a (tenant, ledger) pair. */
export function createLedger(tenantId: string, ledgerId: string): AuditLedger {
  if (!isNonEmptyString(tenantId) || !isNonEmptyString(ledgerId)) {
    throw new AccountabilityError('ledger', 'tenantId and ledgerId are required');
  }
  return Object.freeze({
    tenantId,
    ledgerId,
    records: Object.freeze([]) as readonly ChainedAuditRecord[],
    headDigest: GENESIS_PREVIOUS_DIGEST,
    nextSequence: 1,
  });
}

export class LedgerAppendError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'LedgerAppendError';
    this.reason = reason;
  }
}

/**
 * Append one accountability record to a ledger. The record is:
 *   1. checked for full accountability (`assertAccountable`) — an incomplete action can never be
 *      appended, and therefore can never be reported complete;
 *   2. bound to the ledger — tenant/ledger must match, sequence must be exactly `nextSequence`
 *      (monotone, gap-free), so records cannot be reordered, duplicated, or skipped;
 *   3. linked — `previousDigest` is set to the current head digest and `integrityDigest` is
 *      derived over (previousDigest || contentDigest).
 *
 * Returns a NEW ledger with the record appended; the input ledger is untouched.
 */
export function appendAuditRecord(ledger: AuditLedger, record: AccountabilityRecord): AuditLedger {
  assertAccountable(record);

  if (record.tenantId !== ledger.tenantId || record.ledgerId !== ledger.ledgerId) {
    throw new LedgerAppendError(
      'ledger_mismatch',
      `record (tenant ${record.tenantId}, ledger ${record.ledgerId}) does not belong to ledger ` +
        `(tenant ${ledger.tenantId}, ledger ${ledger.ledgerId})`,
    );
  }
  if (record.sequence !== ledger.nextSequence) {
    throw new LedgerAppendError(
      'sequence_gap',
      `record sequence ${record.sequence} is not the expected next sequence ${ledger.nextSequence}`,
    );
  }

  const previousDigest = ledger.headDigest;
  const integrityDigest = deriveIntegrityDigest(previousDigest, record);

  const chained: ChainedAuditRecord = Object.freeze({
    ...record,
    previousDigest,
    integrityDigest,
  });

  return Object.freeze({
    tenantId: ledger.tenantId,
    ledgerId: ledger.ledgerId,
    records: Object.freeze([...ledger.records, chained]) as readonly ChainedAuditRecord[],
    headDigest: integrityDigest,
    nextSequence: ledger.nextSequence + 1,
  });
}

// ---------------------------------------------------------------------------
// 3. APPEND VERIFICATION — the independent read path.

export interface VerificationResult {
  readonly ok: boolean;
  /** Machine reason when `ok` is false; `null` when the record/chain verifies. */
  readonly reason: string | null;
  /** Human-readable detail. */
  readonly detail: string | null;
  /** The offending record's sequence when applicable. */
  readonly sequence: number | null;
}

function ok(): VerificationResult {
  return Object.freeze({ ok: true, reason: null, detail: null, sequence: null });
}

function fail(reason: string, detail: string, sequence: number | null): VerificationResult {
  return Object.freeze({ ok: false, reason, detail, sequence });
}

/**
 * Verify a SINGLE append step against the expected predecessor state, WITHOUT trusting any digest
 * the record carries — every digest is re-derived from content. This is the effect-witness: the
 * proof is the recomputation, not the writer's stored value.
 *
 * Checks, in order: full accountability; ledger binding; monotone sequence; the record's
 * `previousDigest` equals the expected predecessor digest; the record's `integrityDigest` equals
 * the independently re-derived digest.
 */
export function verifyAppend(
  expected: { tenantId: string; ledgerId: string; sequence: number; previousDigest: string },
  record: ChainedAuditRecord,
): VerificationResult {
  try {
    assertAccountable(record);
  } catch (e) {
    const err = e as AccountabilityError;
    return fail(
      `accountability:${err.clause ?? 'unknown'}`,
      err.message,
      typeof record?.sequence === 'number' ? record.sequence : null,
    );
  }

  if (record.tenantId !== expected.tenantId || record.ledgerId !== expected.ledgerId) {
    return fail(
      'ledger_mismatch',
      'record does not belong to the expected ledger',
      record.sequence,
    );
  }
  if (record.sequence !== expected.sequence) {
    return fail(
      'sequence_gap',
      `expected sequence ${expected.sequence}, got ${record.sequence}`,
      record.sequence,
    );
  }
  if (record.previousDigest !== expected.previousDigest) {
    return fail(
      'broken_link',
      `previousDigest does not match the predecessor's integrityDigest`,
      record.sequence,
    );
  }
  const rederived = deriveIntegrityDigest(record.previousDigest, record);
  if (record.integrityDigest !== rederived) {
    return fail(
      'digest_mismatch',
      'integrityDigest does not match the re-derived digest (content was altered)',
      record.sequence,
    );
  }
  return ok();
}

/**
 * Verify an ENTIRE per-ledger chain from a list of chained records read back independently (e.g.
 * `SELECT ... ORDER BY sequence`). Detects: a non-accountable record, a wrong tenant/ledger, a
 * reordered/duplicated/dropped record (sequence must be 1,2,3,… with no gaps), a genesis record
 * whose previousDigest is not the sentinel, a broken link, or a mutated field (digest mismatch).
 *
 * A tamper — deleting, reordering, or altering ANY record — is detected because every subsequent
 * digest is a function of it.
 */
export function verifyLedger(
  tenantId: string,
  ledgerId: string,
  records: readonly ChainedAuditRecord[],
): VerificationResult {
  let previousDigest = GENESIS_PREVIOUS_DIGEST;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const expectedSequence = i + 1;
    const step = verifyAppend(
      { tenantId, ledgerId, sequence: expectedSequence, previousDigest },
      record,
    );
    if (!step.ok) return step;
    previousDigest = record.integrityDigest;
  }
  return ok();
}

/** Throwing form of {@link verifyLedger}. */
export function assertLedgerIntact(
  tenantId: string,
  ledgerId: string,
  records: readonly ChainedAuditRecord[],
): void {
  const result = verifyLedger(tenantId, ledgerId, records);
  if (!result.ok) {
    throw new LedgerAppendError(
      result.reason ?? 'ledger_invalid',
      `ledger verification failed at sequence ${result.sequence ?? '?'}: ${result.detail ?? result.reason}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Signed-checkpoint root — the range digest a Phase-29 `audit_checkpoint` row is signed over.

export interface CheckpointRange {
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;
  readonly rootDigest: string;
  readonly headIntegrityDigest: string;
}

/**
 * Compute the signed-checkpoint root over a CONTIGUOUS ledger range. The root is a rolling digest
 * folded over the records' integrity digests, so it commits to the exact set and order of records
 * in the range. Re-computing it over the stored range and comparing to the signed value is how a
 * checkpoint makes truncation/replacement tamper-evident (Phase-29 `audit_checkpoint`). This first
 * verifies the range is an intact sub-chain, so a checkpoint can never be produced over a broken
 * or reordered range.
 */
export function computeCheckpointRoot(
  tenantId: string,
  ledgerId: string,
  records: readonly ChainedAuditRecord[],
): CheckpointRange {
  if (records.length === 0) {
    throw new LedgerAppendError(
      'empty_range',
      'a checkpoint range must contain at least one record',
    );
  }
  assertLedgerIntact(tenantId, ledgerId, records);

  let root = GENESIS_PREVIOUS_DIGEST;
  for (const record of records) {
    root = sha256Hex(`${root}:${record.integrityDigest}`);
  }
  const first = records[0]!;
  const last = records[records.length - 1]!;
  return Object.freeze({
    tenantId,
    ledgerId,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    eventCount: records.length,
    rootDigest: root,
    headIntegrityDigest: last.integrityDigest,
  });
}
