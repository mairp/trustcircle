// @trustcircle/application — INTEGRITY ESCALATION: escalate destructive, consequential, unowned,
// repeated, expanding, evidence-tampered, rollback-failed, and verification-failed cases
// (Phase 5 / User Story 3 / FR-022).
//
// When an integrity case cannot be safely and automatically resolved, it must be ESCALATED for human
// resolution — never silently closed and never left to loop. This service classifies a case's
// current facts against the eight escalation TRIGGERS and, when any fires, produces a durable
// `IntegrityEscalation` value (aligned column-for-column with `integrity_escalation`). An escalation
// keeps the case VISIBLE and OWNED-for-triage; the quarantine is retained. The eight triggers:
//
//   * destructive        — a destructive change is required (only humans may authorize);
//   * consequential      — the change is consequential (per the reason taxonomy);
//   * unowned            — the case has an ownership gap (no owner to act);
//   * repeated           — repair has been attempted repeatedly without success;
//   * expanding          — the affected scope is growing across cycles;
//   * evidence_tampered  — the original evidence is tampered/unverifiable;
//   * rollback_failed    — a rollback failed or conflicted;
//   * verification_failed— verification returned failed/indeterminate.
//
// The service is pure and clock-free. It grants no authority; it records and routes. The audit event
// id is injected (the escalation commits atomically with its AuditEvent upstream).

import { type Uuid, type EpochMillis, type TenantId, makeReason, type Reason } from '@trustcircle/domain';
import { createHash } from 'node:crypto';

export const ESCALATION_TRIGGERS = [
  'destructive',
  'consequential',
  'unowned',
  'repeated',
  'expanding',
  'evidence_tampered',
  'rollback_failed',
  'verification_failed',
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export const ESCALATION_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export interface IntegrityEscalation {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly trigger: EscalationTrigger;
  readonly reason: Reason;
  readonly escalatedTo: Readonly<Record<string, unknown>>;
  readonly auditEventId: Uuid;
  readonly escalatedAt: EpochMillis;
  readonly status: EscalationStatus;
}

/** The facts an escalation decision is taken over (all already resolved upstream). */
export interface EscalationFacts {
  readonly destructiveRequired: boolean;
  readonly consequential: boolean;
  readonly ownershipGap: boolean;
  readonly repairAttemptCount: number;
  readonly repeatThreshold?: number;
  readonly affectedScopeGrew: boolean;
  readonly evidenceTampered: boolean;
  readonly rollbackFailedOrConflicted: boolean;
  readonly verificationFailed: boolean;
}

/** Default number of failed repair attempts that constitutes a `repeated` escalation. */
const DEFAULT_REPEAT_THRESHOLD = 3;

/**
 * Determine which escalation triggers fire for the given facts, in the fail-closed priority order of
 * the trigger vocabulary. Returns every firing trigger (a case may fire more than one).
 */
export function triggersFor(facts: EscalationFacts): readonly EscalationTrigger[] {
  const repeat = facts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  const out: EscalationTrigger[] = [];
  if (facts.destructiveRequired) out.push('destructive');
  if (facts.consequential) out.push('consequential');
  if (facts.ownershipGap) out.push('unowned');
  if (facts.repairAttemptCount >= repeat) out.push('repeated');
  if (facts.affectedScopeGrew) out.push('expanding');
  if (facts.evidenceTampered) out.push('evidence_tampered');
  if (facts.rollbackFailedOrConflicted) out.push('rollback_failed');
  if (facts.verificationFailed) out.push('verification_failed');
  return Object.freeze(out);
}

/** True iff any escalation trigger fires — the case cannot be auto-resolved. */
export function mustEscalate(facts: EscalationFacts): boolean {
  return triggersFor(facts).length > 0;
}

const TRIGGER_REASON_TEXT: Readonly<Record<EscalationTrigger, string>> = Object.freeze({
  destructive: 'a destructive change is required; only a human may authorize destructive remediation',
  consequential: 'the required change is consequential and must be decided by a human',
  unowned: 'the case has an ownership gap; no owner is available to act — routed for owner assignment',
  repeated: 'repair has been attempted repeatedly without a verified resolution',
  expanding: 'the affected scope is expanding across cycles; containment must be reassessed by a human',
  evidence_tampered: 'the original evidence is tampered or unverifiable; safe repair is not possible automatically',
  rollback_failed: 'a rollback failed or conflicted with newer legitimate state; human compensation required',
  verification_failed: 'verification did not pass; the case cannot reach verified closure automatically',
});

export interface EscalateCommand {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly trigger: EscalationTrigger;
  readonly auditEventId: Uuid;
  readonly escalatedTo?: Record<string, unknown>;
  readonly reasonText?: string;
  readonly escalatedAt: EpochMillis;
}

/** Construct a durable escalation record for a single fired trigger. Throws on an invalid trigger. */
export function makeIntegrityEscalation(cmd: EscalateCommand): IntegrityEscalation {
  if (!ESCALATION_TRIGGERS.includes(cmd.trigger)) {
    throw new TypeError(`escalation.trigger must be one of ${ESCALATION_TRIGGERS.join('|')}`);
  }
  const reason = makeReason(
    `escalation_${cmd.trigger}`,
    cmd.reasonText ?? TRIGGER_REASON_TEXT[cmd.trigger],
  );
  return Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    integrityCaseId: cmd.integrityCaseId,
    trigger: cmd.trigger,
    reason,
    escalatedTo: Object.freeze({ ...(cmd.escalatedTo ?? {}) }),
    auditEventId: cmd.auditEventId,
    escalatedAt: cmd.escalatedAt,
    status: 'open' as EscalationStatus,
  });
}

export function integrityEscalationDigest(e: IntegrityEscalation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: e.id,
        tenantId: e.tenantId,
        integrityCaseId: e.integrityCaseId,
        trigger: e.trigger,
        reason: e.reason,
        escalatedTo: e.escalatedTo,
        auditEventId: e.auditEventId,
        escalatedAt: e.escalatedAt,
        status: e.status,
      }),
    )
    .digest('hex');
}
