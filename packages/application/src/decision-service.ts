// @trustcircle/application — DECISION SERVICE: guarded, idempotent decision transitions
// (Phase 4 / User Story 2 / FR-010, FR-011, FR-012, AC2/AC3).
//
// This service turns a human's decision ATTEMPT into a durable, attributable OUTCOME. The seven
// verbs — approve, deny, request_changes, escalate, expire, delegate, cancel — each fire AT MOST
// ONCE per (decision, idempotency-key) and produce EXACTLY ONE decision record, whether ACCEPTED
// (AC2) or REJECTED (AC3). The service is a pure decision function over injected facts: it does not
// itself resolve authority or persist — it takes the ALREADY-RESOLVED authority verdict (from
// decision-authority.ts, resolved at effect time), the current package, and a validated reason, and
// computes the outcome record + the next package status. Persistence commits the record + audit +
// outbox atomically (decision-repository.ts).
//
// Fail-closed and non-vacuous: a reason is MANDATORY on every attempt; an unauthorised /
// conflicting-duty / stale-version / expired attempt yields a REJECTED record (never a silent
// no-op) so the refusal is itself durable and explained. Determinism: all instants injected.

import {
  makeDecisionRecord,
  makeReason,
  isConsequentialReason,
  isTerminalDecisionStatus,
  decisionIsExpired,
  type DecisionPackage,
  type DecisionRecord,
  type DecisionActionVerb,
  type DecisionStatus,
} from '@trustcircle/domain';
import { type Uuid, type EpochMillis, type Reason } from '@trustcircle/domain';

/**
 * A rejection record still MUST carry a reason (the schema mandates it). When the actor's reason is
 * missing / vacuous, that IS the cause of the rejection — so we substitute a machine-generated
 * placeholder reason that documents the refusal, keeping the rejected attempt itself durable and
 * explained rather than un-recordable.
 */
const MISSING_REASON_PLACEHOLDER: Reason = makeReason(
  'reason_missing',
  'the actor did not supply a meaningful reason; attempt refused (FR-011)',
);

export type DecisionRejectionCode =
  | 'NO_AUTHORITY'
  | 'SOD_VIOLATION'
  | 'MISSING_REASON'
  | 'STALE_VERSION'
  | 'EXPIRED_ASSIGNMENT'
  | 'ALREADY_TERMINAL'
  | 'PACKAGE_EXPIRED'
  | 'PACKAGE_INVALIDATED'
  | 'POLICY_UNAVAILABLE'
  | 'ILLEGAL_TRANSITION';

/** The authority verdict resolved at EFFECT time (from decision-authority.ts). */
export interface EffectAuthorityVerdict {
  readonly permitted: boolean;
  readonly denyReason: DecisionRejectionCode | null;
  readonly authorityAssignmentId: string | null;
}

export interface DecisionActionCommand {
  readonly decision: DecisionPackage;
  readonly action: DecisionActionVerb;
  readonly actorPrincipalId: Uuid;
  readonly reason: Reason;
  /** Optimistic-concurrency token the caller acted against (the package version it saw). */
  readonly expectedVersion: number;
  /** Effect-time authority verdict. */
  readonly authority: EffectAuthorityVerdict;
  /** True iff the signed PDP bundle was available (fail-closed if not). */
  readonly policyAvailable: boolean;
  readonly newRecordId: Uuid;
  readonly auditEventId: Uuid;
  readonly now: EpochMillis;
}

export interface DecisionActionOutcome {
  readonly accepted: boolean;
  readonly record: DecisionRecord;
  /** The package status AFTER the action (unchanged on rejection). */
  readonly nextStatus: DecisionStatus;
  /** True iff the package version advances (accepted, mutating actions only). */
  readonly versionAdvances: boolean;
  readonly rejectionCode: DecisionRejectionCode | null;
}

/** The accepted next-status for each verb (the AC2 transition map). */
const ACCEPTED_STATUS: Readonly<Record<DecisionActionVerb, DecisionStatus>> = Object.freeze({
  approve: 'approved',
  deny: 'denied',
  request_changes: 'changes_requested',
  escalate: 'escalated',
  delegate: 'delegated',
  expire: 'expired',
  cancel: 'cancelled',
});

/** Verbs that, when accepted, close the package (terminal) vs. keep it open. */
function isMutatingAdvance(action: DecisionActionVerb): boolean {
  // Every accepted action advances the version (it is a durable state change), including escalate
  // and request_changes which keep the package open but at a new version.
  return action in ACCEPTED_STATUS;
}

function reject(
  cmd: DecisionActionCommand,
  code: DecisionRejectionCode,
  packageDigest: string,
): DecisionActionOutcome {
  // The rejection record still needs a valid reason; if the actor's reason is unusable, that is
  // itself the cause and we bind the placeholder so the refusal remains recordable and explained.
  const recordReason = isConsequentialReason(cmd.reason) ? cmd.reason : MISSING_REASON_PLACEHOLDER;
  const record = makeDecisionRecord({
    id: cmd.newRecordId,
    tenantId: cmd.decision.tenantId,
    decisionId: cmd.decision.id,
    actorPrincipalId: cmd.actorPrincipalId,
    ...(cmd.authority.authorityAssignmentId
      ? { authorityAssignmentId: cmd.authority.authorityAssignmentId as Uuid }
      : {}),
    action: cmd.action,
    reason: recordReason,
    status: 'rejected',
    rejectionCode: code,
    packageDigest,
    decidedAt: cmd.now,
    auditEventId: cmd.auditEventId,
  });
  return {
    accepted: false,
    record,
    nextStatus: cmd.decision.status,
    versionAdvances: false,
    rejectionCode: code,
  };
}

/**
 * Decide a single decision attempt. Returns EXACTLY ONE outcome record — accepted or rejected.
 * The rejection ordering is deliberate: terminal/expired/invalidated package first (no action is
 * possible), then reason presence, then policy availability, then version staleness, then the
 * effect-time authority verdict. Every branch produces a durable, explained record.
 *
 * `packageDigest` is the digest of the CURRENT package the actor acted against — it is bound onto
 * the record so a decision taken against a superseded package is detectable (AC4/FR-012).
 */
export function decideDecisionAction(
  cmd: DecisionActionCommand,
  packageDigest: string,
): DecisionActionOutcome {
  const { decision, action } = cmd;

  if (decision.status === 'invalidated') {
    return reject(cmd, 'PACKAGE_INVALIDATED', packageDigest);
  }
  if (isTerminalDecisionStatus(decision.status)) {
    return reject(cmd, 'ALREADY_TERMINAL', packageDigest);
  }
  // An expired package may only be closed by the `expire` verb; any other verb is refused.
  if (decisionIsExpired(decision, cmd.now) && action !== 'expire') {
    return reject(cmd, 'PACKAGE_EXPIRED', packageDigest);
  }
  // Reason capture is mandatory for EVERY attempt (the record factory would throw; we surface it).
  if (reasonMissing(cmd.reason)) {
    return reject(cmd, 'MISSING_REASON', packageDigest);
  }
  // Fail-closed when the signed policy bundle is unavailable (spec: unavailable-policy rejection).
  if (!cmd.policyAvailable) {
    return reject(cmd, 'POLICY_UNAVAILABLE', packageDigest);
  }
  // Optimistic concurrency: a stale version means the actor reviewed an out-of-date package (AC4).
  if (cmd.expectedVersion !== decision.version) {
    return reject(cmd, 'STALE_VERSION', packageDigest);
  }
  // Effect-time authority. `expire` and `cancel` are system/requester housekeeping verbs that do not
  // require decision authority; the consequential verbs do.
  const requiresAuthority = action !== 'expire' && action !== 'cancel';
  if (requiresAuthority && !cmd.authority.permitted) {
    return reject(cmd, cmd.authority.denyReason ?? 'NO_AUTHORITY', packageDigest);
  }

  const record = makeDecisionRecord({
    id: cmd.newRecordId,
    tenantId: decision.tenantId,
    decisionId: decision.id,
    actorPrincipalId: cmd.actorPrincipalId,
    ...(cmd.authority.authorityAssignmentId
      ? { authorityAssignmentId: cmd.authority.authorityAssignmentId as Uuid }
      : {}),
    action,
    reason: cmd.reason,
    status: 'accepted',
    packageDigest,
    decidedAt: cmd.now,
    auditEventId: cmd.auditEventId,
  });

  return {
    accepted: true,
    record,
    nextStatus: ACCEPTED_STATUS[action],
    versionAdvances: isMutatingAdvance(action),
    rejectionCode: null,
  };
}

/** True iff the reason is absent or vacuous (defence in depth over the record factory). */
function reasonMissing(reason: Reason | undefined | null): boolean {
  return (
    reason === undefined ||
    reason === null ||
    typeof reason.code !== 'string' ||
    reason.code.trim().length === 0 ||
    typeof reason.text !== 'string' ||
    reason.text.trim().length < 3
  );
}

/** The accepted next-status for a verb (exposed for the projector / dashboard). */
export function acceptedStatusFor(action: DecisionActionVerb): DecisionStatus {
  return ACCEPTED_STATUS[action];
}
