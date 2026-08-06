// @trustcircle/application — INTERNAL AUDIT: plan and run an INTERNAL audit programme with an
// INDEPENDENT auditor, a declared scope/criteria/sampling, and a reported outcome (Phase 7 / User
// Story 5 — Demonstrate Compliance and Audit Readiness / FR-034).
//
// An internal audit is INTERNAL READINESS, never external assurance or certification. Pure functions
// over injected facts; every instant injected. An audit MUST declare independence (an auditor
// auditing their own control is refused) and a non-empty criteria set. Reporting an audit records the
// reported instant and produces findings downstream (corrective-action.ts).

import type { Uuid, EpochMillis } from '@trustcircle/domain';

export type AuditStatus = 'planned' | 'in_progress' | 'reported' | 'followed_up' | 'closed';

export interface InternalAudit {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly programme: string;
  readonly auditorPrincipalId: Uuid;
  readonly independent: boolean;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly criteria: readonly string[];
  readonly sampling: Readonly<Record<string, unknown>>;
  readonly status: AuditStatus;
  readonly reportedAt?: EpochMillis;
}

export interface PlanAuditCommand {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly programme: string;
  readonly auditorPrincipalId: Uuid;
  /** The principals who OWN the controls under audit — the auditor must be independent of them. */
  readonly controlOwnerPrincipalIds: readonly Uuid[];
  readonly scope: Record<string, unknown>;
  readonly criteria: readonly string[];
  readonly sampling?: Record<string, unknown>;
}

export type AuditRejectionCode = 'NOT_INDEPENDENT' | 'NO_CRITERIA' | 'BLANK_PROGRAMME';

export interface PlanAuditOutcome {
  readonly accepted: boolean;
  readonly audit: InternalAudit | null;
  readonly rejectionCode: AuditRejectionCode | null;
}

/** Plan an internal audit. Refuses a non-independent auditor, an empty criteria set, or a blank programme. */
export function planInternalAudit(cmd: PlanAuditCommand): PlanAuditOutcome {
  if (typeof cmd.programme !== 'string' || cmd.programme.trim().length === 0) {
    return { accepted: false, audit: null, rejectionCode: 'BLANK_PROGRAMME' };
  }
  if (!Array.isArray(cmd.criteria) || cmd.criteria.length < 1) {
    return { accepted: false, audit: null, rejectionCode: 'NO_CRITERIA' };
  }
  const independent = !cmd.controlOwnerPrincipalIds.includes(cmd.auditorPrincipalId);
  if (!independent) return { accepted: false, audit: null, rejectionCode: 'NOT_INDEPENDENT' };

  const audit: InternalAudit = Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    programme: cmd.programme,
    auditorPrincipalId: cmd.auditorPrincipalId,
    independent,
    scope: Object.freeze({ ...cmd.scope }),
    criteria: Object.freeze([...cmd.criteria]),
    sampling: Object.freeze({ ...(cmd.sampling ?? {}) }),
    status: 'planned',
  });
  return { accepted: true, audit, rejectionCode: null };
}

/** Advance an audit to `in_progress`. */
export function startAudit(a: InternalAudit): InternalAudit {
  return a.status === 'planned' ? Object.freeze({ ...a, status: 'in_progress' }) : a;
}

/** Report an audit at `now` (records the reported instant). */
export function reportAudit(a: InternalAudit, now: EpochMillis): InternalAudit {
  return a.status === 'in_progress' || a.status === 'planned'
    ? Object.freeze({ ...a, status: 'reported', reportedAt: now })
    : a;
}

/** True iff this is INTERNAL readiness — always true; internal audit is never external certification. */
export function isInternalReadiness(_a: InternalAudit): boolean {
  return true;
}
