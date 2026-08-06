// @trustcircle/api — DECISION DASHBOARD ROUTE (Phase 4 / User Story 2 / FR-010, AC1, SC-003, SC-004).
//
// Mounts the role-specific dashboard read model from the OpenAPI contract onto the dependency-free
// Hono-compatible `App` from ../server.ts:
//
//   GET /v1/dashboards/{view}   → getDashboard   → DashboardResponse
//
// This module owns the `decision_queue` view: a PRIORITIZED decision-queue read model for the
// authenticated reviewer, assembled from an injected queue projection (the @trustcircle/projections
// DecisionQueueProjector, folded by the composition root). The response is a `DashboardResponse`
// whose `data` carries the prioritized queue and whose `metadata` is the contract
// `ProjectionMetadata` — `generated_at`, `source_cursor` (the projector snapshot digest), the
// FRESHNESS (`current|aging|stale|unknown`), and `partial_coverage` — so a reviewer is never shown a
// decision queue that SILENTLY omits items or presents a stale picture as current (SC-004). A stale
// or partial projection is surfaced fail-visibly with a safe next action in the payload; current
// health is never inferred from a stale queue.
//
// The queue itself is prioritized by the projector (impact × risk × time-pressure × actionability,
// SC-003) — this route does not re-derive priority; it renders the projector's ordered rows and
// exposes each item's queue facets (impact, risk, age, time posture, evidence currency, open
// requirements, conflicts, and the actor's allowed actions) so the reviewer can triage at a glance.
//
// Views OTHER than `decision_queue` are delegated to an optional injected `otherViews` provider
// (the operational/executive/compliance/auditor dashboards owned elsewhere); when none is wired,
// they are a visible 404 rather than a fabricated empty view. The route holds no mutable state,
// reads no wall clock (the provider carries `generatedAt`), and reads only the authorized surface.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiDashboardResponse,
  GovernanceApiProjectionMetadata,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports.
// ===========================================================================

/** The five dashboard views the contract enumerates. */
export const DASHBOARD_VIEWS = [
  'operational',
  'executive',
  'compliance',
  'auditor',
  'decision_queue',
] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/** One prioritized decision-queue item exposed on the dashboard (a projected queue row). The route
 *  renders the projector's ordered rows verbatim; it does not re-derive priority or authority. */
export interface DecisionQueueDashboardItem {
  readonly decisionId: string;
  readonly workItemId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: string;
  readonly impact: string;
  readonly status: string;
  readonly ageMillis: number;
  readonly timeToExpiryMillis: number;
  readonly timePosture: string;
  readonly evidenceCurrency: string;
  readonly openRequirementIds: readonly string[];
  readonly isCrossTenant: boolean;
  readonly conflicts: readonly string[];
  readonly allowedActions: readonly string[];
  readonly actionable: boolean;
  readonly priority: number;
}

/** The prioritized decision-queue read the composition root resolves from the projector. */
export interface DecisionQueueDashboard {
  readonly items: readonly DecisionQueueDashboardItem[];
  readonly generatedAt: EpochMillis;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  /** The projector `snapshotDigest` — the read-position witness on `metadata.source_cursor`. */
  readonly snapshotDigest: string;
}

/** Resolves the prioritized decision queue for an authenticated tenant/reviewer, or undefined. */
export type DecisionQueueDashboardProvider = (
  tenantId: TenantId,
  principalId: string,
  at: EpochMillis | undefined,
) => DecisionQueueDashboard | undefined;

/** A pre-assembled non-decision dashboard view (owned elsewhere), delegated by this route. */
export interface ForeignDashboardView {
  readonly data: Readonly<Record<string, unknown>>;
  readonly metadata: GovernanceApiProjectionMetadata;
}

/** Resolves one of the OTHER dashboard views, or undefined when it is not available. */
export type OtherDashboardProvider = (
  view: Exclude<DashboardView, 'decision_queue'>,
  tenantId: TenantId,
  principalId: string,
  scopeId: string | undefined,
  at: EpochMillis | undefined,
) => ForeignDashboardView | undefined;

export interface DecisionDashboardRouteDeps {
  readonly decisionQueue: DecisionQueueDashboardProvider;
  /** Optional: the other views. Absent ⇒ a request for them is a visible 404. */
  readonly otherViews?: OtherDashboardProvider;
}

// ===========================================================================
// 1. Problem responder + scope.
// ===========================================================================

function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
): Response {
  const correlationId = c.ctx?.correlationId ?? 'unknown';
  return c.json(
    {
      type: `about:blank#${code}`,
      title,
      status,
      code,
      detail,
      correlation_id: correlationId,
      retryable: status >= 500,
      safe_next_actions: [...safeNextActions],
    },
    status,
  );
}

function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

function principalOf(c: AppContext): string {
  return c.ctx?.principalId ?? 'unknown';
}

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

// ===========================================================================
// 2. Handler.
// ===========================================================================

/** GET /dashboards/{view} — the role-specific read model; `decision_queue` is the prioritized queue. */
function getDashboard(deps: DecisionDashboardRouteDeps): RouteHandler {
  return (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const view = c.req.param('view');
    if (view === undefined || !DASHBOARD_VIEWS.includes(view as DashboardView)) {
      return problem(
        c,
        400,
        'invalid_view',
        'Bad Request',
        `view must be one of ${DASHBOARD_VIEWS.join(', ')}.`,
      );
    }

    const url = new URL(c.req.url, 'http://internal');
    const scopeId = url.searchParams.get('scope_id') ?? undefined;
    const atRaw = url.searchParams.get('at');
    let at: EpochMillis | undefined;
    if (atRaw !== null && atRaw !== '') {
      const parsed = Date.parse(atRaw);
      if (Number.isNaN(parsed)) {
        return problem(c, 400, 'invalid_at', 'Bad Request', 'at must be an RFC3339 date-time.');
      }
      at = parsed as EpochMillis;
    }

    const principalId = principalOf(c);

    if (view === 'decision_queue') {
      const dash = deps.decisionQueue(tenantId, principalId, at);
      if (dash === undefined) {
        // No queue for this reviewer ⇒ an empty, explicitly-unknown-freshness view (not an error).
        return c.json(emptyDecisionQueueResponse(at), 200);
      }
      return c.json(decisionQueueResponse(dash), 200);
    }

    // A non-decision view — delegate to the injected provider, or 404 when none is wired here.
    if (deps.otherViews === undefined) {
      return problem(
        c,
        404,
        'view_unavailable',
        'Not Found',
        `The ${view} dashboard is not served by this endpoint.`,
      );
    }
    const foreign = deps.otherViews(
      view as Exclude<DashboardView, 'decision_queue'>,
      tenantId,
      principalId,
      scopeId,
      at,
    );
    if (foreign === undefined) {
      return problem(c, 404, 'view_unavailable', 'Not Found', `No ${view} dashboard for this scope.`);
    }
    const body: GovernanceApiDashboardResponse = {
      view,
      data: { ...foreign.data },
      metadata: foreign.metadata,
    };
    return c.json(body, 200);
  };
}

// ===========================================================================
// 3. Response builders.
// ===========================================================================

/** Build the `decision_queue` DashboardResponse — the prioritized queue + fail-visible metadata. */
function decisionQueueResponse(dash: DecisionQueueDashboard): GovernanceApiDashboardResponse {
  const notCurrent = dash.freshness !== 'current' || dash.partialCoverage;
  const data: Record<string, unknown> = {
    // The queue is ALREADY prioritized by the projector (SC-003). Rendered in order.
    items: dash.items.map((i) => ({
      decision_id: i.decisionId,
      work_item_id: i.workItemId,
      requester_principal_id: i.requesterPrincipalId,
      requested_action: i.requestedAction,
      action_class: i.actionClass,
      risk_tier: i.riskTier,
      impact: i.impact,
      status: i.status,
      age_millis: i.ageMillis,
      time_to_expiry_millis: i.timeToExpiryMillis,
      time_posture: i.timePosture,
      evidence_currency: i.evidenceCurrency,
      open_requirement_ids: [...i.openRequirementIds],
      is_cross_tenant: i.isCrossTenant,
      conflicts: [...i.conflicts],
      allowed_actions: [...i.allowedActions],
      actionable: i.actionable,
      priority: i.priority,
    })),
    total: dash.items.length,
    actionable_count: dash.items.filter((i) => i.actionable).length,
    // Fail-visible: when the queue is not current/complete, name the safe next action (SC-004).
    ...(notCurrent
      ? {
          safe_next_action:
            dash.freshness !== 'current'
              ? 'the decision queue projection is not current: refresh from source before relying on prioritization; do not infer that no urgent decisions exist'
              : 'the decision queue coverage is partial: treat it as an incomplete picture until coverage is restored',
        }
      : {}),
  };
  return {
    view: 'decision_queue',
    data,
    metadata: {
      generated_at: iso(dash.generatedAt),
      source_cursor: dash.snapshotDigest,
      freshness: dash.freshness,
      partial_coverage: dash.partialCoverage,
    },
  };
}

function emptyDecisionQueueResponse(at: EpochMillis | undefined): GovernanceApiDashboardResponse {
  return {
    view: 'decision_queue',
    data: { items: [], total: 0, actionable_count: 0 },
    metadata: {
      generated_at: iso(at ?? (0 as EpochMillis)),
      source_cursor: 'start',
      // No queue read ⇒ freshness is UNKNOWN, never falsely 'current' (SC-004).
      freshness: 'unknown',
      partial_coverage: false,
    },
  };
}

// ===========================================================================
// 4. Registration.
// ===========================================================================

/**
 * Mount the dashboard route onto `app`. AUTHENTICATED (carries a tenant scope + audit identity).
 * Registered WITHOUT the version prefix — `App.get` prepends `API_PREFIX` (`/v1`), serving at
 * `/v1/dashboards/{view}`.
 */
export function registerDecisionDashboardRoutes(
  app: App,
  deps: DecisionDashboardRouteDeps,
): App {
  app.get('/dashboards/:view', getDashboard(deps));
  return app;
}
