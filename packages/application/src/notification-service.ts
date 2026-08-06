// @trustcircle/application — POLICY-ROUTED DECISION NOTIFICATIONS (Phase 4 / User Story 2 / FR-045).
//
// A decision that no one is told about is a decision that quietly bypasses its reviewers. When a
// decision is requested, escalated, delegated, invalidated, expiring, or emergency-intervened, the
// right principals must be NOTIFIED — but ONLY the ones a policy actually routes to, so notifications
// are neither dropped (a silent bypass) nor sprayed cross-tenant (a leak). This module is the
// policy-routed notification planner: given a decision event and a routing policy, it computes the
// exact, de-duplicated, tenant-scoped recipient set and a durable notification row per recipient.
//
// It routes fail-closed and tenant-safe: a recipient is only ever emitted for the decision's own
// tenant (or an explicitly affected tenant on a joint event), never inferred; an event type with no
// matching policy rule produces ZERO notifications rather than a broadcast. The notification row is a
// durable artifact (mirrors table `decision_notification`, which is append-only + immutable), so the
// "who was told, when, and why" is itself auditable. Determinism: the emitted-at instant and the row
// ids are injected; no wall clock, no id generation at module scope.

import { type Uuid, type EpochMillis } from '@trustcircle/domain';

export const DECISION_EVENT_TYPES = [
  'requested',
  'escalated',
  'delegated',
  'changes_requested',
  'invalidated',
  'expiring',
  'approved',
  'denied',
  'emergency_intervention',
  'joint_review_ready',
] as const;
export type DecisionEventType = (typeof DECISION_EVENT_TYPES)[number];

export const NOTIFICATION_ROLES = [
  'requester',
  'approver',
  'delegate',
  'central_reviewer',
  'affected_tenant_admin',
  'incident_responder',
] as const;
export type NotificationRole = (typeof NOTIFICATION_ROLES)[number];

/** A routing rule: an event type routes to a set of recipient ROLES. */
export interface RoutingRule {
  readonly eventType: DecisionEventType;
  readonly roles: readonly NotificationRole[];
}

/** The default policy: which roles are notified for each event (fail-closed — unlisted ⇒ none). */
export const DEFAULT_ROUTING_POLICY: readonly RoutingRule[] = Object.freeze([
  { eventType: 'requested', roles: ['approver'] },
  { eventType: 'escalated', roles: ['central_reviewer', 'approver'] },
  { eventType: 'delegated', roles: ['delegate', 'requester'] },
  { eventType: 'changes_requested', roles: ['requester'] },
  { eventType: 'invalidated', roles: ['requester', 'approver'] },
  { eventType: 'expiring', roles: ['approver', 'requester'] },
  { eventType: 'approved', roles: ['requester'] },
  { eventType: 'denied', roles: ['requester'] },
  { eventType: 'emergency_intervention', roles: ['incident_responder', 'central_reviewer'] },
  { eventType: 'joint_review_ready', roles: ['central_reviewer', 'affected_tenant_admin'] },
]);

/** A candidate recipient, tagged with its role and owning tenant (for tenant-safe routing). */
export interface RecipientCandidate {
  readonly principalId: Uuid;
  readonly role: NotificationRole;
  readonly tenantId: Uuid;
}

/** A planned, durable notification (mirrors table decision_notification). */
export interface PlannedNotification {
  readonly id: Uuid;
  readonly tenantId: Uuid;
  readonly decisionId: Uuid;
  readonly recipientPrincipalId: Uuid;
  readonly role: NotificationRole;
  readonly eventType: DecisionEventType;
  readonly emittedAt: EpochMillis;
}

/** The roles a policy routes an event to (empty ⇒ no rule ⇒ no notifications). */
export function rolesForEvent(
  eventType: DecisionEventType,
  policy: readonly RoutingRule[] = DEFAULT_ROUTING_POLICY,
): readonly NotificationRole[] {
  const rule = policy.find((r) => r.eventType === eventType);
  return rule ? rule.roles : [];
}

export interface NotificationPlanInput {
  readonly decisionId: Uuid;
  /** The decision's OWN tenant — the default routing scope. */
  readonly tenantId: Uuid;
  readonly eventType: DecisionEventType;
  readonly candidates: readonly RecipientCandidate[];
  /** Tenants explicitly in scope for this event (the decision tenant + any affected tenants). */
  readonly allowedTenantIds: readonly Uuid[];
  /** Injected id factory: index → row id. Keeps id generation out of this module. */
  readonly idAt: (index: number) => Uuid;
  readonly now: EpochMillis;
}

/**
 * Plan the notifications for a decision event. A candidate is emitted iff (a) its role is routed by
 * the policy for this event, and (b) its tenant is in the allowed set (the decision's own tenant plus
 * any explicitly-affected tenants) — so a notification never crosses to an unrelated tenant. The plan
 * is de-duplicated per (recipient, role) so the same principal is told at most once per event. An
 * event with no policy rule yields an EMPTY plan (fail-closed, no broadcast). Determinism: ids and
 * instant are injected.
 */
export function planNotifications(input: NotificationPlanInput): readonly PlannedNotification[] {
  const routedRoles = new Set(rolesForEvent(input.eventType));
  if (routedRoles.size === 0) return [];
  const allowed = new Set(input.allowedTenantIds.map((t) => String(t)));
  allowed.add(String(input.tenantId));

  const seen = new Set<string>();
  const out: PlannedNotification[] = [];
  for (const c of input.candidates) {
    if (!routedRoles.has(c.role)) continue;
    if (!allowed.has(String(c.tenantId))) continue; // tenant-safe: never route cross-tenant.
    const key = `${c.principalId}:${c.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: input.idAt(out.length),
      tenantId: input.tenantId,
      decisionId: input.decisionId,
      recipientPrincipalId: c.principalId,
      role: c.role,
      eventType: input.eventType,
      emittedAt: input.now,
    });
  }
  return Object.freeze(out);
}
