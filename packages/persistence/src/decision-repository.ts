// @trustcircle/persistence — DECISION OUTCOME REPOSITORY (Phase 4 / User Story 2 / FR-010, FR-011,
// FR-012, FR-013, VO-d76c5d1293b91d26e094 audit completeness, VO-7a0dbcc527946b539bf6 outbox).
//
// A human decision — ACCEPTED or REJECTED — is only durable when the FOUR facts land together: the
// new canonical decision-package state (the transition), the attributable decision RECORD (actor +
// reason + package-digest binding), the AUDIT event that makes the action accountable, and the
// OUTBOX message that notifies downstream reviewers. If any one is missing, governance is
// inconsistent — a decision no reviewer learns about, an unaccountable transition, or a phantom
// event advertising an effect that never happened.
//
// This module does NOT re-implement atomicity. It is a thin, decision-shaped ADAPTER over the
// unit-of-work in `./unit-of-work.ts`. The KEY design decision that keeps all four facts in ONE
// transaction: the attributable decision RECORD is carried INSIDE the canonical package state
// payload (`DecisionPackageState.state` embeds `{ record, package }`), so it is committed atomically
// with the audit + outbox rows by a single `commitUnitOfWork` call — there is no second transaction
// and therefore no partial-write window. The record is re-read from the canonical row through an
// independent read path (`readDecisionOutcome`), so the commit's return value is never the sole proof.
//
// A REJECTED attempt is committed with the SAME rigor as an accepted one (its refusal is a durable,
// explained record — never a silent no-op). The unit-of-work always advances the canonical version
// by exactly one, so BOTH accepted and rejected outcomes produce a new versioned canonical row; the
// package's own `status` (embedded in the state) is what distinguishes an advancing decision from a
// refusal — the refusal re-states the prior package status while still recording the rejected record.
//
// Determinism: every instant and id is injected by the caller (the record carries `decidedAt`,
// `id`, `auditEventId`); this module reads no wall clock and mints no ids.

import { type Database, type SourceContract, digest, canonicalJson } from './database.ts';
import {
  commitUnitOfWork,
  readCanonicalState,
  readAuditEvent,
  readOutboxMessage,
  type CommitUnitOfWorkResult,
  type AuditEventInput,
  type CanonicalStateRow,
  type AuditEventRow,
  type OutboxMessageRow,
} from './unit-of-work.ts';

/** The canonical-state entity kind under which a decision package is stored. */
export const DECISION_ENTITY_KIND = 'decision_package';

/**
 * The minimal decision-record shape this repository persists. It mirrors the domain `DecisionRecord`
 * (@trustcircle/domain) structurally, but the repository accepts a plain readonly object so the
 * persistence package need not depend on the domain package (layering: persistence is a leaf).
 */
export interface DecisionRecordInput {
  readonly id: string;
  readonly tenantId: string;
  readonly decisionId: string;
  readonly actorPrincipalId: string;
  readonly authorityAssignmentId?: string;
  readonly action: string;
  readonly reason: { readonly code: string; readonly text: string };
  /** 'accepted' | 'rejected'. */
  readonly status: string;
  readonly rejectionCode?: string;
  /** The digest of the package the actor bound to (AC2/AC4/FR-012). */
  readonly packageDigest: string;
  readonly decidedAt: number;
  readonly auditEventId: string;
}

/**
 * A signed policy-decision evidence reference (from @trustcircle/policy). Its id + signature are
 * recorded as audit evidence-refs so the decision's policy basis is durably bound to the audit trail.
 */
export interface PolicyEvidenceRef {
  /** Stable id of the policy-decision evidence record. */
  readonly evidenceId: string;
  /** The bundle revision the decision was rendered against. */
  readonly bundleRevision: string;
  /** The evidence signature (bound as an audit evidence ref for reconstructability). */
  readonly signature: string;
}

/** The new canonical decision-package state to persist (opaque payload + version coordinates). */
export interface DecisionPackageState {
  /** The decision package id (the canonical entity id). */
  readonly decisionId: string;
  /** The package status AFTER the transition (accepted actions change it; rejections do not). */
  readonly status: string;
  /** The FULL package payload to persist as canonical state (digested as the target witness). */
  readonly package: unknown;
  /** Expected CURRENT canonical version (optimistic concurrency); 0 for the first commit. */
  readonly expectedVersion: number;
}

/**
 * The command to commit ONE decision outcome atomically. It carries the outcome (accepted/rejected),
 * the record to persist, the new package state, the accountability facets, the policy evidence, and
 * the idempotency/correlation identity — everything `commitUnitOfWork` needs, decision-shaped.
 */
export interface CommitDecisionOutcomeCommand {
  readonly tenantId: string;
  /** Caller-supplied idempotency key (unique per logical decision attempt). */
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;

  /** True iff the attempt was ACCEPTED (the package status transitions); false ⇒ rejected. */
  readonly accepted: boolean;
  readonly record: DecisionRecordInput;
  readonly packageState: DecisionPackageState;

  /** The accountable owner of the decision (may differ from the actor). */
  readonly ownerPrincipalId: string;
  /** Governed scope string, e.g. "tenant:acme/decision:d-1". */
  readonly scope: string;
  readonly policyVersion: string;
  readonly controlVersion: string;
  /** The signed policy-decision evidence backing the outcome (its id/sig → audit evidence refs). */
  readonly policyEvidence: PolicyEvidenceRef;
  /** Additional evidence references (simulation ids, evidence-manifest ids, …). */
  readonly extraEvidenceRefs?: readonly string[];

  /** The async event topic (e.g. "governance.decision.approved"). */
  readonly outboxTopic: string;
  /** The outbox payload (the decision-event body downstream reviewers consume). */
  readonly outboxPayload: unknown;
}

export interface CommitDecisionOutcomeResult extends CommitUnitOfWorkResult {
  /** Echo of the record id committed (for the caller's independent read-back). */
  readonly decisionRecordId: string;
  /** True iff this was an accepted outcome. */
  readonly accepted: boolean;
}

/**
 * The atomically-committed canonical decision state payload: the attributable record travels WITH
 * the package inside the single canonical_state row, so both are durable-together or not at all.
 */
export interface EmbeddedDecisionState {
  readonly record: DecisionRecordInput;
  readonly package: unknown;
  readonly status: string;
  readonly accepted: boolean;
  readonly policyEvidence: PolicyEvidenceRef;
  readonly recordDigest: string;
}

/** A durable content witness of the decision record (independent of the mutation return value). */
export function decisionRecordDigest(r: DecisionRecordInput): string {
  return digest({
    id: r.id,
    tenantId: r.tenantId,
    decisionId: r.decisionId,
    actorPrincipalId: r.actorPrincipalId,
    authorityAssignmentId: r.authorityAssignmentId ?? null,
    action: r.action,
    reason: { code: r.reason.code, text: r.reason.text },
    status: r.status,
    rejectionCode: r.rejectionCode ?? null,
    packageDigest: r.packageDigest,
    decidedAt: r.decidedAt,
    auditEventId: r.auditEventId,
  });
}

/**
 * Build the audit-completeness-gated `AuditEventInput` for a decision outcome. The reason is the
 * actor's decision reason; the target-state digest is the new embedded-state digest; the evidence
 * refs bind the policy-decision evidence (id + signature) plus any extra refs, so the audit trail
 * carries a reconstructable policy basis. The gate in `commitUnitOfWork` refuses an incomplete one.
 */
function buildAudit(cmd: CommitDecisionOutcomeCommand, targetStateDigest: string): AuditEventInput {
  const evidenceRefs = [
    `policy-evidence:${cmd.policyEvidence.evidenceId}`,
    `policy-signature:${cmd.policyEvidence.signature}`,
    `decision-record:${cmd.record.id}`,
    ...(cmd.extraEvidenceRefs ?? []),
  ];
  return {
    actor: cmd.record.actorPrincipalId,
    owner: cmd.ownerPrincipalId,
    reason: { code: cmd.record.reason.code, text: cmd.record.reason.text },
    // The very first commit at version 0 is a create (null source); otherwise the prior package
    // state is the source, digested by its version so the transition is reconstructable.
    sourceStateDigest:
      cmd.packageState.expectedVersion === 0 ? null : `pkg-v${cmd.packageState.expectedVersion}`,
    targetStateDigest,
    scope: cmd.scope,
    policyVersion: cmd.policyVersion,
    controlVersion: cmd.controlVersion,
    evidenceRefs,
  };
}

/**
 * Commit ONE decision outcome (accepted OR rejected) ATOMICALLY. The attributable record is embedded
 * into the canonical state payload, so the record + package state + audit event + outbox message
 * commit in a single `commitUnitOfWork` transaction or not at all — there is no partial-write window.
 * Inherits dedup, bounded retry, reconciliation, and the audit-completeness gate from the
 * unit-of-work. A REJECTED attempt commits with the same rigor (a durable, explained refusal).
 */
export async function commitDecisionOutcome(
  db: Database,
  cmd: CommitDecisionOutcomeCommand,
): Promise<CommitDecisionOutcomeResult> {
  const operationScope = `decision.${cmd.record.action}${cmd.accepted ? '' : '.rejected'}`;

  const embedded: EmbeddedDecisionState = {
    record: cmd.record,
    package: cmd.packageState.package,
    status: cmd.packageState.status,
    accepted: cmd.accepted,
    policyEvidence: cmd.policyEvidence,
    recordDigest: decisionRecordDigest(cmd.record),
  };
  const targetStateDigest = digest(embedded);

  const result = await commitUnitOfWork(db, {
    tenantId: cmd.tenantId,
    operationScope,
    idempotencyKey: cmd.idempotencyKey,
    correlationId: cmd.correlationId,
    contract: cmd.contract,
    expectedContractVersion: cmd.expectedContractVersion,
    request: {
      recordId: cmd.record.id,
      action: cmd.record.action,
      accepted: cmd.accepted,
      packageDigest: cmd.record.packageDigest,
    },
    canonical: {
      entityKind: DECISION_ENTITY_KIND,
      entityId: cmd.packageState.decisionId,
      expectedVersion: cmd.packageState.expectedVersion,
      state: embedded,
    },
    action: cmd.record.action,
    audit: buildAudit(cmd, targetStateDigest),
    outbox: { topic: cmd.outboxTopic, payload: cmd.outboxPayload },
  });

  return { ...result, decisionRecordId: cmd.record.id, accepted: cmd.accepted };
}

// ---------------------------------------------------------------------------
// Independent read paths — the durable witnesses (never the commit return value).
// ---------------------------------------------------------------------------

/**
 * Read the current committed decision outcome (record + package + status) for a decision, extracted
 * from the canonical state row. This is the independent durable witness: it re-reads the persisted
 * row rather than trusting the commit's return value. Returns null if the decision has no state row.
 */
export async function readDecisionOutcome(
  db: Database,
  tenantId: string,
  decisionId: string,
): Promise<{
  readonly version: number;
  readonly stateDigest: string;
  readonly correlationId: string;
  readonly updatedAt: number;
  readonly embedded: EmbeddedDecisionState;
} | null> {
  const row = await readCanonicalState(db, tenantId, DECISION_ENTITY_KIND, decisionId);
  if (!row) return null;
  return {
    version: row.version,
    stateDigest: row.stateDigest,
    correlationId: row.correlationId,
    updatedAt: row.updatedAt,
    embedded: row.state as EmbeddedDecisionState,
  };
}

/**
 * Read the current committed decision RECORD for a decision (the attributable outcome), extracted
 * from the canonical state row's embedded record. Null if the decision has no committed outcome yet.
 */
export async function readDecisionRecord(
  db: Database,
  tenantId: string,
  decisionId: string,
): Promise<DecisionRecordInput | null> {
  const outcome = await readDecisionOutcome(db, tenantId, decisionId);
  return outcome ? outcome.embedded.record : null;
}

/**
 * Read the canonical decision-package state row (the raw transition witness). Thin decision-scoped
 * re-export of the unit-of-work canonical reader.
 */
export async function readDecisionPackageState(
  db: Database,
  tenantId: string,
  decisionId: string,
): Promise<CanonicalStateRow | null> {
  return readCanonicalState(db, tenantId, DECISION_ENTITY_KIND, decisionId);
}

// Re-export the unit-of-work audit/outbox readers so a decision caller reconstructs the full
// four-fact effect through ONE import surface (the decision repository).
export { readAuditEvent, readOutboxMessage };
export type { AuditEventRow, OutboxMessageRow, CanonicalStateRow };

/** The canonical outbox topics for decision outcomes (fail-closed, closed vocabulary). */
export const DECISION_OUTBOX_TOPICS = {
  approved: 'governance.decision.approved',
  denied: 'governance.decision.denied',
  changes_requested: 'governance.decision.changes_requested',
  escalated: 'governance.decision.escalated',
  delegated: 'governance.decision.delegated',
  expired: 'governance.decision.expired',
  cancelled: 'governance.decision.cancelled',
  rejected: 'governance.decision.rejected',
} as const;

/** A canonical string form of an embedded decision-package state, stable across read paths. */
export function decisionStateJson(state: unknown): string {
  return canonicalJson(state);
}
