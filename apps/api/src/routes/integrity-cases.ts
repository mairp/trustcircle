// @trustcircle/api — INTEGRITY-CASE READ ROUTES (Phase 5 / User Story 3 / FR-016, FR-017, FR-018,
// FR-022, SC-006, SC-009).
//
// Mounts the two READ operations of the containment/repair surface from the OpenAPI contract
// (specs/001-governance-control-plane/contracts/governance-api.openapi.yaml) onto the dependency-free
// Hono-compatible `App` from ../server.ts:
//
//   GET /v1/integrity-cases            → listIntegrityCases → IntegrityCasePage (the damaged-work queue)
//   GET /v1/integrity-cases/{caseId}   → getIntegrityCase   → IntegrityCase (200 + ETag)
//
// The obligations this module enforces at the boundary (each verifiable against the integrity-api
// contract checkers in @trustcircle/contracts):
//
//   * QUEUE VISIBILITY (FR-016, SC-006). The list is the prioritized damaged-work queue for the
//     authenticated tenant — problem class, severity, quarantine, remediation-plan, verification.
//     Empty scope ⇒ an empty page, never a leak of another tenant's cases.
//   * VERIFIED-CLOSURE HONESTY (FR-022). The wire `state`/`verification_id` are read from the
//     projection surface, which NEVER converts a source-reported `done` into verified closure — the
//     route echoes the projection, it does not compute closure.
//   * CURRENT-CASE ETag (SC-009). The single-case read carries a strong ETag over the CURRENT case
//     version, so a subsequent remediation/verification action can bind to the exact case the actor
//     saw (`If-Match`), and two reviewers cannot silently clobber each other.
//   * TENANT SCOPE. Every read requires a valid tenant scope; a case that belongs to another tenant
//     is a 404 in this scope (never a cross-tenant disclosure).
//
// The module is pure request→response plumbing over INJECTED read ports (a queue projection provider
// and a single-case reader resolved by the composition root). It holds no mutable state, reads no wall
// clock (the provider carries `generatedAt`), and assembles every response body from an INDEPENDENT
// read of the projection surface — never a mutation echo.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiIntegrityCase,
  GovernanceApiIntegrityCasePage,
  GovernanceApiPageMetadata,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports — the route composes projections; it never builds them.
// ===========================================================================

/** An integrity case as the injected surface hands it to the route (already tenant-authorized).
 *  Mirrors the contract `IntegrityCase` fields plus the durable `version` the ETag is over and the
 *  case digest the ETag binds to. */
export interface IntegrityCaseView {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly problemClass: string;
  readonly severity: string;
  readonly originalEvidenceId: Uuid;
  readonly quarantineId?: Uuid | null;
  readonly remediationPlanId?: Uuid | null;
  readonly verificationId?: Uuid | null;
  readonly state: string;
  readonly version: number;
  /** The current case digest — the value the ETag is derived from (SC-009 optimistic-concurrency). */
  readonly caseDigest: string;
}

/** A prioritized integrity queue read for a tenant (from @trustcircle/projections). */
export interface IntegrityQueueView {
  readonly items: readonly IntegrityCaseView[];
  readonly generatedAt: EpochMillis;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  /** The queue snapshot digest witness (the projector's `snapshotDigest`). */
  readonly snapshotDigest: string;
}

/** Filters the queue read honours (contract query params). */
export interface IntegrityQueueFilter {
  readonly state?: string;
  readonly problemClass?: string;
}

/** Resolves the prioritized queue for an authenticated tenant, or undefined (empty page). */
export type IntegrityQueueProvider = (
  tenantId: TenantId,
  filter: IntegrityQueueFilter,
) => IntegrityQueueView | undefined;

/** Reads one integrity case for a tenant, or undefined when it does not exist / is not visible. */
export type IntegrityCaseReader = (
  tenantId: TenantId,
  caseId: Uuid,
) => IntegrityCaseView | undefined | Promise<IntegrityCaseView | undefined>;

export interface IntegrityCasesRouteDeps {
  readonly queue: IntegrityQueueProvider;
  readonly readCase: IntegrityCaseReader;
}

// ===========================================================================
// 1. Constants + a disclosure-safe Problem responder.
// ===========================================================================

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Emit an RFC-9457-shaped Problem the app's error contract accepts. */
function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
): Response {
  const correlationId = c.ctx?.correlationId ?? 'unknown';
  const body: Record<string, unknown> = {
    type: `about:blank#${code}`,
    title,
    status,
    code,
    detail,
    correlation_id: correlationId,
    retryable: status >= 500,
    safe_next_actions: [...safeNextActions],
  };
  return c.json(body, status);
}

/** The authenticated tenant of the request, validated as a UUID tenant scope. */
function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

// ===========================================================================
// 2. ETag — a strong validator over the CURRENT case (digest + version).
// ===========================================================================

/** Build the strong ETag for a case's current state (digest + version). */
export function caseEtag(view: IntegrityCaseView): string {
  return `"ic-${view.version}-${view.caseDigest}"`;
}

// ===========================================================================
// 3. Time + wire mappers.
// ===========================================================================

/** Epoch-ms → RFC3339 UTC string (the wire `date-time`). */
function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

/** Map a case view to the contract `IntegrityCase` wire shape. Optional nullable ids conditionally
 *  spread so an absent quarantine/plan/verification is omitted, not sent as a bogus value. */
function caseToWire(view: IntegrityCaseView): GovernanceApiIntegrityCase {
  const out: GovernanceApiIntegrityCase = {
    id: String(view.id),
    tenant_id: String(view.tenantId),
    problem_class: view.problemClass as GovernanceApiIntegrityCase['problem_class'],
    severity: view.severity,
    original_evidence_id: String(view.originalEvidenceId),
    state: view.state,
    version: view.version,
  };
  const withQ =
    view.quarantineId !== undefined
      ? { ...out, quarantine_id: view.quarantineId === null ? null : String(view.quarantineId) }
      : out;
  const withP =
    view.remediationPlanId !== undefined
      ? {
          ...withQ,
          remediation_plan_id:
            view.remediationPlanId === null ? null : String(view.remediationPlanId),
        }
      : withQ;
  return view.verificationId !== undefined
    ? {
        ...withP,
        verification_id: view.verificationId === null ? null : String(view.verificationId),
      }
    : withP;
}

function emptyMetadata(): GovernanceApiPageMetadata {
  return {
    generated_at: iso(0 as EpochMillis),
    source_cursor: 'start',
    freshness: 'unknown',
    partial_coverage: false,
    next_cursor: null,
  };
}

// ===========================================================================
// 4. Handlers.
// ===========================================================================

/** GET /integrity-cases — the prioritized damaged-work queue (FR-016, SC-006). */
function listIntegrityCases(deps: IntegrityCasesRouteDeps): RouteHandler {
  return (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required.',
      );
    }
    const url = new URL(c.req.url, 'http://internal');

    const rawLimit = url.searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null && rawLimit !== '') {
      if (!/^\d+$/.test(rawLimit)) {
        return problem(
          c,
          400,
          'invalid_limit',
          'Bad Request',
          'limit must be a non-negative integer.',
        );
      }
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
        return problem(
          c,
          400,
          'invalid_limit',
          'Bad Request',
          `limit must be in [${MIN_LIMIT}, ${MAX_LIMIT}].`,
        );
      }
      limit = n;
    }

    const state = url.searchParams.get('state');
    const problemClass = url.searchParams.get('problem_class');
    const filter: IntegrityQueueFilter = {
      ...(state !== null && state !== '' ? { state } : {}),
      ...(problemClass !== null && problemClass !== '' ? { problemClass } : {}),
    };

    const view = deps.queue(tenantId, filter);
    if (view === undefined) {
      const body: GovernanceApiIntegrityCasePage = { items: [], metadata: emptyMetadata() };
      return c.json(body, 200);
    }

    const items = view.items.slice(0, limit).map(caseToWire);
    const metadata: GovernanceApiPageMetadata = {
      generated_at: iso(view.generatedAt),
      source_cursor: view.snapshotDigest,
      freshness: view.freshness,
      partial_coverage: view.partialCoverage,
      next_cursor: view.items.length > limit ? String(view.items.length) : null,
    };
    const body: GovernanceApiIntegrityCasePage = { items, metadata };
    return c.json(body, 200);
  };
}

/** GET /integrity-cases/{caseId} — the complete current case (FR-017/018/022); 200 + ETag (SC-009). */
function getIntegrityCase(deps: IntegrityCasesRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required.',
      );
    }
    const caseId = caseIdOf(c);
    if (caseId === undefined) {
      return problem(
        c,
        400,
        'invalid_case_id',
        'Bad Request',
        'The case id path segment must be a uuid.',
      );
    }

    const view = await deps.readCase(tenantId, caseId);
    if (view === undefined) {
      return problem(
        c,
        404,
        'integrity_case_not_found',
        'Not Found',
        'No such integrity case in this tenant scope.',
      );
    }

    c.setHeader('etag', caseEtag(view));
    return c.json(caseToWire(view), 200);
  };
}

// ===========================================================================
// 5. Small shared helpers.
// ===========================================================================

/** Extract + validate the `:caseId` path parameter as a uuid. */
function caseIdOf(c: AppContext): Uuid | undefined {
  const id = c.req.param('caseId');
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
}

// ===========================================================================
// 6. Registration.
// ===========================================================================

/**
 * Mount the two integrity-case READ routes onto `app`. Both are AUTHENTICATED (they carry a tenant
 * scope). Paths are registered WITHOUT the version prefix — `App.get` prepends `API_PREFIX` (`/v1`),
 * so they serve at `/v1/integrity-cases...`. The collection and item paths are distinct, so
 * registration order is unambiguous for the exact-path matcher.
 */
export function registerIntegrityCasesRoutes(app: App, deps: IntegrityCasesRouteDeps): App {
  app.get('/integrity-cases', listIntegrityCases(deps));
  app.get('/integrity-cases/:caseId', getIntegrityCase(deps));
  return app;
}
