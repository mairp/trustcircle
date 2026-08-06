// @trustcircle/api — CONTROLLER + OPERATION ROUTES (Phase 6 / User Story 4 / FR-023, FR-024, FR-026,
// FR-027, FR-028, FR-050).
//
// Mounts the controller-operations surface from the OpenAPI contract
// (specs/001-governance-control-plane/contracts/governance-api.openapi.yaml) onto the dependency-free
// Hono-compatible `App` from ../server.ts:
//
//   GET  /v1/controllers                          → the controller registry (desired/observed + drift)
//   GET  /v1/controllers/{controllerId}/operations/{operationId}
//                                                 → one governed operation (200 + ETag)
//   POST /v1/controllers/{controllerId}/operations
//                                                 → create-or-replay an operation (ONE idempotency
//                                                   identity, FR-026) → 202 OperationAccepted
//   POST /v1/controllers/{controllerId}/operations/{operationId}/actions
//                                                 → a governed lifecycle action (pause/resume/reconcile/
//                                                   rollback/…), permitted ONLY when the current state
//                                                   allows it (FR-024) → 202 OperationAccepted
//
// The obligations this module enforces at the boundary:
//
//   * REGISTRY VISIBILITY + DRIFT (FR-024). The list echoes the projection registry — version, owner,
//     health, desired/observed state, the VISIBLE drift, and the exact `next_permitted_actions` — never
//     a computed or masked view. Empty scope ⇒ an empty page, never a cross-tenant leak.
//   * ONE IDEMPOTENCY IDENTITY (FR-026). Create requires an `Idempotency-Key`; a replay under the same
//     key returns the SAME operation with `idempotent_replay: true` — never a duplicate effect.
//   * GOVERNED ACTIONS ONLY (FR-024). An action is accepted only when the injected control port reports
//     it is permitted from the operation's CURRENT state; otherwise 409 (never a silent no-op or an
//     out-of-lifecycle transition).
//   * UNCERTAINTY IS NOT SUCCESS (FR-028). The wire `outcome`/`status` are read from the projection
//     surface (the route echoes it); the route never turns an acknowledgement into a success.
//   * CURRENT-OPERATION ETag. The single read carries a strong ETag over the current operation version
//     + digest, so a subsequent action can bind to the exact operation the actor saw (`If-Match`).
//   * TENANT SCOPE. Every read/write requires a valid tenant scope; an entity in another tenant is a
//     404 in this scope (never a cross-tenant disclosure).
//
// Pure request→response plumbing over INJECTED ports (a registry provider, an operation reader, an
// operation creator, and an action applier resolved by the composition root). It holds no mutable
// state, reads no wall clock, and assembles every response body from an INDEPENDENT read of the
// projection/decision surface — never a mutation echo.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiController,
  GovernanceApiControllerPage,
  GovernanceApiControllerOperation,
  GovernanceApiOperationAccepted,
  GovernanceApiPageMetadata,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports — the route composes projections/decisions; it never builds them.
// ===========================================================================

/** A controller registry row as the injected surface hands it to the route (already tenant-authorized). */
export interface ControllerView {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerVersion: string;
  readonly desiredVersion?: number;
  readonly observedVersion?: string;
  readonly ownerPrincipalId?: Uuid;
  readonly health: string;
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly observedState: Readonly<Record<string, unknown>>;
  /** The VISIBLE next actions permitted from the active operation's state (FR-024). */
  readonly nextPermittedActions: readonly string[];
  readonly observedAt?: EpochMillis;
  readonly failureDetail?: Readonly<Record<string, unknown>> | null;
}

/** A controller registry read for a tenant (from @trustcircle/projections). */
export interface ControllerRegistryView {
  readonly items: readonly ControllerView[];
  readonly generatedAt: EpochMillis;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  readonly snapshotDigest: string;
}

/** One governed operation as the injected surface hands it to the route (already tenant-authorized). */
export interface OperationView {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly controllerId: Uuid;
  readonly operationType: GovernanceApiControllerOperation['operation_type'];
  readonly expectedObservedVersion: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly scope: Readonly<Record<string, unknown>>;
  readonly targetState: Readonly<Record<string, unknown>>;
  readonly simulationId?: Uuid | null;
  readonly decisionRequestId?: Uuid | null;
  readonly policyDecisionId: Uuid;
  readonly status: string;
  readonly outcome: GovernanceApiControllerOperation['outcome'];
  readonly continuityLeaseExpiresAt?: EpochMillis | null;
  readonly reconciliationRunId?: Uuid | null;
  readonly evidenceManifestId?: Uuid | null;
  readonly createdAt: EpochMillis;
  readonly version: number;
  /** The current operation digest — the value the ETag is derived from (optimistic concurrency). */
  readonly operationDigest: string;
}

export interface ControllerRegistryFilter {
  readonly health?: string;
  readonly drifted?: boolean;
}

export type ControllerRegistryProvider = (
  tenantId: TenantId,
  filter: ControllerRegistryFilter,
) => ControllerRegistryView | undefined;

export type OperationReader = (
  tenantId: TenantId,
  controllerId: Uuid,
  operationId: Uuid,
) => OperationView | undefined | Promise<OperationView | undefined>;

/** The input a create request carries to the injected operation creator. */
export interface CreateOperationInput {
  readonly tenantId: TenantId;
  readonly controllerId: Uuid;
  readonly idempotencyKey: string;
  readonly operationType: GovernanceApiControllerOperation['operation_type'];
  readonly expectedObservedVersion: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly scope: Readonly<Record<string, unknown>>;
  readonly targetState: Readonly<Record<string, unknown>>;
  readonly simulationId?: Uuid | null;
  readonly decisionRequestId?: Uuid | null;
}

/** The verdict the injected creator returns: the operation id + whether this was a same-key replay. */
export interface CreateOperationResult {
  readonly operationId: Uuid;
  readonly status: string;
  readonly auditEventId: Uuid;
  readonly idempotentReplay: boolean;
}

export type OperationCreator = (
  input: CreateOperationInput,
) => CreateOperationResult | Promise<CreateOperationResult>;

/** The input an action request carries to the injected action applier. */
export interface OperationActionInput {
  readonly tenantId: TenantId;
  readonly controllerId: Uuid;
  readonly operationId: Uuid;
  readonly action: string;
  readonly reason?: { readonly code: string; readonly text: string };
  /** The exact operation version the actor saw (from `If-Match`), for optimistic concurrency. */
  readonly ifMatchVersion?: number;
}

/**
 * The action verdict. `permitted:false` with `conflict:true` ⇒ the action is not allowed from the
 * current state (409, FR-024); with `notFound:true` ⇒ the operation does not exist in scope (404).
 */
export interface OperationActionResult {
  readonly permitted: boolean;
  readonly conflict: boolean;
  readonly notFound: boolean;
  readonly operationId: Uuid;
  readonly status: string;
  readonly auditEventId: Uuid;
  readonly reason: string;
}

export type OperationActionApplier = (
  input: OperationActionInput,
) => OperationActionResult | Promise<OperationActionResult>;

export interface ControllersRouteDeps {
  readonly registry: ControllerRegistryProvider;
  readonly readOperation: OperationReader;
  readonly createOperation: OperationCreator;
  readonly applyAction: OperationActionApplier;
}

// ===========================================================================
// 1. Constants + a disclosure-safe Problem responder.
// ===========================================================================

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

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

function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

// ===========================================================================
// 2. ETag over the CURRENT operation (digest + version).
// ===========================================================================

export function operationEtag(view: OperationView): string {
  return `"op-${view.version}-${view.operationDigest}"`;
}

/** Parse an `If-Match` value like `"op-<n>-<digest>"` back to its version, or undefined. */
function ifMatchVersion(c: AppContext): number | undefined {
  const raw = c.req.header('if-match');
  if (raw === undefined) return undefined;
  const m = /^"op-(\d+)-/.exec(raw.trim());
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : undefined;
}

// ===========================================================================
// 3. Time + wire mappers.
// ===========================================================================

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

function controllerToWire(view: ControllerView): GovernanceApiController {
  const base: GovernanceApiController = {
    id: String(view.id),
    tenant_id: String(view.tenantId),
    controller_version: view.controllerVersion,
    health: view.health,
    desired_state: { ...view.desiredState },
    observed_state: { ...view.observedState },
    next_permitted_actions: [...view.nextPermittedActions],
  };
  const withDesiredVersion =
    view.desiredVersion !== undefined ? { ...base, desired_version: view.desiredVersion } : base;
  const withObservedVersion =
    view.observedVersion !== undefined
      ? { ...withDesiredVersion, observed_version: view.observedVersion }
      : withDesiredVersion;
  const withOwner =
    view.ownerPrincipalId !== undefined
      ? { ...withObservedVersion, owner_principal_id: String(view.ownerPrincipalId) }
      : withObservedVersion;
  const withObservedAt =
    view.observedAt !== undefined ? { ...withOwner, observed_at: iso(view.observedAt) } : withOwner;
  return view.failureDetail !== undefined
    ? { ...withObservedAt, failure_detail: view.failureDetail === null ? null : { ...view.failureDetail } }
    : withObservedAt;
}

function operationToWire(view: OperationView): GovernanceApiControllerOperation {
  const base: GovernanceApiControllerOperation = {
    id: String(view.id),
    tenant_id: String(view.tenantId),
    controller_id: String(view.controllerId),
    operation_type: view.operationType,
    expected_observed_version: view.expectedObservedVersion,
    reason: { code: view.reason.code, text: view.reason.text },
    scope: { ...view.scope },
    target_state: { ...view.targetState },
    policy_decision_id: String(view.policyDecisionId),
    status: view.status,
    outcome: view.outcome,
    created_at: iso(view.createdAt),
    version: view.version,
  };
  const withSim =
    view.simulationId !== undefined
      ? { ...base, simulation_id: view.simulationId === null ? null : String(view.simulationId) }
      : base;
  const withDecision =
    view.decisionRequestId !== undefined
      ? { ...withSim, decision_request_id: view.decisionRequestId === null ? null : String(view.decisionRequestId) }
      : withSim;
  const withLease =
    view.continuityLeaseExpiresAt !== undefined
      ? {
          ...withDecision,
          continuity_lease_expires_at:
            view.continuityLeaseExpiresAt === null ? null : iso(view.continuityLeaseExpiresAt),
        }
      : withDecision;
  const withRecon =
    view.reconciliationRunId !== undefined
      ? { ...withLease, reconciliation_run_id: view.reconciliationRunId === null ? null : String(view.reconciliationRunId) }
      : withLease;
  return view.evidenceManifestId !== undefined
    ? { ...withRecon, evidence_manifest_id: view.evidenceManifestId === null ? null : String(view.evidenceManifestId) }
    : withRecon;
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
// 4. Body parsing for create + action.
// ===========================================================================

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseReason(v: unknown): { code: string; text: string } | undefined {
  const r = asRecord(v);
  if (r === undefined) return undefined;
  if (typeof r['code'] !== 'string' || typeof r['text'] !== 'string') return undefined;
  return { code: r['code'], text: r['text'] };
}

const OPERATION_TYPES: readonly string[] = [
  'discover', 'inspect', 'simulate', 'execute', 'pause', 'resume', 'reconcile', 'rollback', 'collect_evidence',
];

// ===========================================================================
// 5. Handlers.
// ===========================================================================

/** GET /controllers — the controller registry (FR-024). */
function listControllers(deps: ControllersRouteDeps): RouteHandler {
  return (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const url = new URL(c.req.url, 'http://internal');

    const rawLimit = url.searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null && rawLimit !== '') {
      if (!/^\d+$/.test(rawLimit)) {
        return problem(c, 400, 'invalid_limit', 'Bad Request', 'limit must be a non-negative integer.');
      }
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
        return problem(c, 400, 'invalid_limit', 'Bad Request', `limit must be in [${MIN_LIMIT}, ${MAX_LIMIT}].`);
      }
      limit = n;
    }

    const health = url.searchParams.get('health');
    const drifted = url.searchParams.get('drifted');
    const filter: ControllerRegistryFilter = {
      ...(health !== null && health !== '' ? { health } : {}),
      ...(drifted === 'true' ? { drifted: true } : drifted === 'false' ? { drifted: false } : {}),
    };

    const view = deps.registry(tenantId, filter);
    if (view === undefined) {
      const body: GovernanceApiControllerPage = { items: [], metadata: emptyMetadata() };
      return c.json(body, 200);
    }

    const items = view.items.slice(0, limit).map(controllerToWire);
    const metadata: GovernanceApiPageMetadata = {
      generated_at: iso(view.generatedAt),
      source_cursor: view.snapshotDigest,
      freshness: view.freshness,
      partial_coverage: view.partialCoverage,
      next_cursor: view.items.length > limit ? String(view.items.length) : null,
    };
    const body: GovernanceApiControllerPage = { items, metadata };
    return c.json(body, 200);
  };
}

/** GET /controllers/{controllerId}/operations/{operationId} — the current operation (200 + ETag). */
function getOperation(deps: ControllersRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const controllerId = uuidParam(c, 'controllerId');
    const operationId = uuidParam(c, 'operationId');
    if (controllerId === undefined || operationId === undefined) {
      return problem(c, 400, 'invalid_id', 'Bad Request', 'controllerId and operationId path segments must be uuids.');
    }

    const view = await deps.readOperation(tenantId, controllerId, operationId);
    if (view === undefined) {
      return problem(c, 404, 'operation_not_found', 'Not Found', 'No such operation in this tenant scope.');
    }

    c.setHeader('etag', operationEtag(view));
    return c.json(operationToWire(view), 200);
  };
}

/** POST /controllers/{controllerId}/operations — create-or-replay (FR-026) → 202 OperationAccepted. */
function createOperation(deps: ControllersRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const controllerId = uuidParam(c, 'controllerId');
    if (controllerId === undefined) {
      return problem(c, 400, 'invalid_controller_id', 'Bad Request', 'The controllerId path segment must be a uuid.');
    }
    // ONE idempotency identity (FR-026): a create MUST carry an Idempotency-Key.
    const idempotencyKey = c.req.header('idempotency-key');
    if (idempotencyKey === undefined || idempotencyKey.trim().length < 8) {
      return problem(
        c, 400, 'idempotency_key_required', 'Bad Request',
        'An Idempotency-Key header (≥ 8 chars) is required so a retry resolves to exactly one effect (FR-026).',
        ['retry with a stable Idempotency-Key'],
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_json', 'Bad Request', 'Request body must be JSON.');
    }
    const body = asRecord(raw);
    if (body === undefined) {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'Request body must be a JSON object.');
    }

    const operationType = body['operation_type'];
    if (typeof operationType !== 'string' || !OPERATION_TYPES.includes(operationType)) {
      return problem(c, 400, 'invalid_operation_type', 'Bad Request', `operation_type must be one of: ${OPERATION_TYPES.join(', ')}.`);
    }
    const expectedObservedVersion = body['expected_observed_version'];
    if (typeof expectedObservedVersion !== 'string' || expectedObservedVersion.length === 0) {
      return problem(c, 400, 'expected_observed_version_required', 'Bad Request', 'expected_observed_version is required (source-drift guard, NS-005).');
    }
    const reason = parseReason(body['reason']);
    if (reason === undefined) {
      return problem(c, 400, 'reason_required', 'Bad Request', 'A reason { code, text } is required.');
    }
    const scope = asRecord(body['scope']) ?? {};
    const targetState = asRecord(body['target_state']) ?? {};
    const simulationId = typeof body['simulation_id'] === 'string' && isUuid(body['simulation_id']) ? (body['simulation_id'] as Uuid) : null;
    const decisionRequestId = typeof body['decision_request_id'] === 'string' && isUuid(body['decision_request_id']) ? (body['decision_request_id'] as Uuid) : null;

    const result = await deps.createOperation({
      tenantId,
      controllerId,
      idempotencyKey: idempotencyKey.trim(),
      operationType: operationType as GovernanceApiControllerOperation['operation_type'],
      expectedObservedVersion,
      reason,
      scope,
      targetState,
      simulationId,
      decisionRequestId,
    });

    const accepted: GovernanceApiOperationAccepted = {
      operation_id: String(result.operationId),
      status: result.status,
      correlation_id: c.ctx?.correlationId ?? 'unknown',
      audit_event_id: String(result.auditEventId),
      idempotent_replay: result.idempotentReplay,
    };
    // A same-key replay returns the SAME operation — 200; a genuinely new operation — 202 Accepted.
    return c.json(accepted, result.idempotentReplay ? 200 : 202);
  };
}

/** POST /controllers/{controllerId}/operations/{operationId}/actions — a governed action (FR-024). */
function actOnOperation(deps: ControllersRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const controllerId = uuidParam(c, 'controllerId');
    const operationId = uuidParam(c, 'operationId');
    if (controllerId === undefined || operationId === undefined) {
      return problem(c, 400, 'invalid_id', 'Bad Request', 'controllerId and operationId path segments must be uuids.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_json', 'Bad Request', 'Request body must be JSON.');
    }
    const body = asRecord(raw);
    const action = body?.['action'];
    if (typeof action !== 'string' || action.trim().length === 0) {
      return problem(c, 400, 'action_required', 'Bad Request', 'An action is required.');
    }
    if (!OPERATION_TYPES.includes(action)) {
      return problem(c, 400, 'invalid_action', 'Bad Request', `action must be one of: ${OPERATION_TYPES.join(', ')}.`);
    }
    const reason = parseReason(body?.['reason']);
    const version = ifMatchVersion(c);

    const result = await deps.applyAction({
      tenantId,
      controllerId,
      operationId,
      action,
      ...(reason !== undefined ? { reason } : {}),
      ...(version !== undefined ? { ifMatchVersion: version } : {}),
    });

    if (result.notFound) {
      return problem(c, 404, 'operation_not_found', 'Not Found', 'No such operation in this tenant scope.');
    }
    if (!result.permitted) {
      // FR-024 — the action is not permitted from the CURRENT state; a 409, never a silent no-op.
      return problem(
        c, 409, 'action_not_permitted', 'Conflict',
        `The action '${action}' is not permitted from the operation's current state: ${result.reason}.`,
        ['re-read the operation and choose a permitted next action'],
      );
    }

    const accepted: GovernanceApiOperationAccepted = {
      operation_id: String(result.operationId),
      status: result.status,
      correlation_id: c.ctx?.correlationId ?? 'unknown',
      audit_event_id: String(result.auditEventId),
      idempotent_replay: false,
    };
    return c.json(accepted, 202);
  };
}

// ===========================================================================
// 6. Small shared helpers.
// ===========================================================================

function uuidParam(c: AppContext, name: string): Uuid | undefined {
  const id = c.req.param(name);
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
}

// ===========================================================================
// 7. Registration.
// ===========================================================================

/**
 * Mount the controller + operation routes onto `app`. All are AUTHENTICATED (they carry a tenant
 * scope). Paths are registered WITHOUT the version prefix — `App.get/post` prepends `API_PREFIX`
 * (`/v1`), so they serve at `/v1/controllers...`. The item, create, and action paths are distinct, so
 * registration order is unambiguous for the exact-path matcher.
 */
export function registerControllersRoutes(app: App, deps: ControllersRouteDeps): App {
  app.get('/controllers', listControllers(deps));
  app.get('/controllers/:controllerId/operations/:operationId', getOperation(deps));
  app.post('/controllers/:controllerId/operations', createOperation(deps));
  app.post('/controllers/:controllerId/operations/:operationId/actions', actOnOperation(deps));
  return app;
}
