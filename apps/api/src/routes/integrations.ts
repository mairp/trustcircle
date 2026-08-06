// @trustcircle/api — INTEGRATION / SOURCE-AND-WORKFLOW-HEALTH ROUTES (Phase 8 / User Story 6 —
// Maintain Source and Workflow Health / FR-029, FR-030, NFR-010, SC-014..SC-016 / T242).
//
// Mounts the five US6 operations over the integrations substrate (db/migrations/0060_integrations.sql,
// the packages/application integration services, and the apps/command-worker health/reconciler loops):
//
//   POST /v1/adapters                                → registerAdapter    → AdapterVersionView (201)
//   GET  /v1/connectors                              → listConnectors     → ConnectorView[]     (200)
//   POST /v1/connectors/{connectorId}/reconcile      → reconcileConnector → ReconciliationView  (200/202)
//   GET  /v1/platform/health                         → platformHealth     → PlatformHealthView  (200)
//   GET  /v1/platform/readiness                      → platformReadiness  → PlatformReadinessView(200/503)
//
// The obligations this module enforces at the boundary (each verifiable against the domain +
// application services and the 0060 CHECK constraints):
//
//   * A CONNECTOR IS NEVER AUTHORITATIVE (0060 adapter_definition_no_authority). The route surfaces an
//     adapter/connector's identity, version, owner, contract, capabilities and lifecycle, but it never
//     grants — and never lets a caller claim — governance authority for a connector.
//   * HEALTH IS OBSERVED, NEVER INFERRED FROM ABSENCE (FR-029, 0060 health_no_positive_from_absence). A
//     connector without a fresh observation is surfaced as stale/unknown — the route delegates the read
//     verbatim and never upgrades a missing reading to `healthy`.
//   * FR-029 FIELD SET. The connector + platform-health views carry identity, version, owner, health,
//     lifecycle status, enabled scope, last success + last attempt, active operation, evidence,
//     failures, retry state, affected work, and a safe next action — the full observable field set.
//   * FR-030 ALERTS. Threshold breaches routed to accountable owners are surfaced (never swallowed).
//   * AVAILABILITY IS SEPARATE FROM AUTHORITY (NFR-010). The platform readiness view reports each
//     component's availability class + runtime state separately from any design authority.
//
// Pure request→response plumbing over INJECTED command/query handlers. It holds no mutable state, reads
// no wall clock (a command carries `now` when it needs one), and re-implements no health/reconciliation
// logic: it validates the wire shape, then delegates to @trustcircle/application's integration services.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';

// ===========================================================================
// 0. Injected ports — the route composes the integration services; never builds them.
// ===========================================================================

/** Availability class of a component/connector (NFR-010 — separate from design authority). */
export type AvailabilityClassWire = 'core' | 'optional' | 'on-demand';

/** Coarse observed health of a connector/component — `unknown` when no fresh observation backs it. */
export type ObservedHealth = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

/** Freshness of the backing health observation — `unknown`/`stale` is never upgraded to healthy. */
export type ObservedFreshness = 'fresh' | 'stale' | 'unknown';

// ── Adapter registration (POST /adapters) ────────────────────────────────────────────────────────

/** A registered adapter VERSION as the injected surface hands it back (already tenant-authorized). */
export interface AdapterVersionView {
  readonly id: Uuid;
  readonly definitionId: Uuid;
  readonly adapterKey: string;
  readonly displayName: string;
  readonly category: string;
  /** A connector NEVER holds governance authority (0060 adapter_definition_no_authority). */
  readonly authorityGrantable: false;
  readonly ownerPrincipalId: Uuid;
  readonly semanticVersion: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly capabilities: readonly string[];
  readonly manifestSignature: string;
  readonly signingKeyId: string;
  readonly lifecycleState: string;
  readonly contentDigest: string;
  readonly createdAt: EpochMillis;
}

/** The validated command an adapter-registration request carries to the injected handler. */
export interface RegisterAdapterCommand {
  readonly tenantId: TenantId;
  readonly registrarPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly adapterKey: string;
  readonly displayName: string;
  readonly category: string;
  readonly ownerPrincipalId: string;
  readonly semanticVersion: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly capabilities: readonly string[];
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly manifestSignature: string;
  readonly signingKeyId: string;
}

export interface RegisterAdapterResult {
  readonly version: AdapterVersionView;
  readonly idempotentReplay: boolean;
}

/** The register handler — records a signed, versioned, immutable adapter build (T228/T230). */
export type RegisterAdapterPort = (
  command: RegisterAdapterCommand,
) => RegisterAdapterResult | Promise<RegisterAdapterResult>;

// ── Connector list (GET /connectors) ─────────────────────────────────────────────────────────────

/** A single alert routed to an accountable owner (FR-030). */
export interface AlertView {
  readonly id: Uuid;
  readonly alertClass: string;
  readonly severity: string;
  readonly ownerPrincipalId: Uuid;
  readonly state: string;
  readonly firstObservedAt: EpochMillis;
  readonly ownerNotifiedAt?: EpochMillis | null;
  readonly recoveredAt?: EpochMillis | null;
}

/**
 * A connector as the injected surface hands it back, carrying the FR-029 observable field set:
 * identity, version, owner, health, lifecycle status, enabled scope, last success + attempt, active
 * operation, evidence, failures, retry state, affected work, and a safe next action.
 */
export interface ConnectorView {
  // identity + version + owner
  readonly id: Uuid;
  readonly adapterKey: string;
  readonly sourceRef: string;
  readonly definitionId: Uuid;
  readonly versionId: Uuid;
  readonly observedVersion?: string | null;
  readonly ownerPrincipalId: Uuid;
  // availability (separate from authority — NFR-010) + lifecycle status
  readonly availabilityClass: AvailabilityClassWire;
  readonly lifecycleState: string;
  // enabled scope
  readonly enabledCapabilities: readonly string[];
  readonly scopes: readonly string[];
  // health — observed, never inferred from absence (FR-029)
  readonly health: ObservedHealth;
  readonly freshness: ObservedFreshness;
  readonly freshnessAgeMs?: number | null;
  readonly lagMs?: number | null;
  // last success + last attempt + active operation
  readonly lastSuccessAt?: EpochMillis | null;
  readonly lastAttemptAt?: EpochMillis | null;
  readonly activeOperationId?: Uuid | null;
  // failures + retry state + affected work
  readonly failureCount: number;
  readonly retryDepth: number;
  readonly deadLetterCount: number;
  readonly affectedScope: readonly string[];
  readonly businessImpact: string;
  // evidence + alerts + safe next action
  readonly evidenceIds: readonly Uuid[];
  readonly alerts: readonly AlertView[];
  readonly safeNextAction?: string;
  readonly observedAt: EpochMillis;
}

/** The validated query a connector-list request carries to the injected handler. */
export interface ListConnectorsQuery {
  readonly tenantId: TenantId;
  readonly correlationId: string;
  /** Optional availability-class filter (`core` | `optional` | `on-demand`). */
  readonly availabilityClass?: AvailabilityClassWire;
  /** Optional lifecycle-state filter. */
  readonly lifecycleState?: string;
}

export interface ListConnectorsResult {
  readonly connectors: readonly ConnectorView[];
  readonly observedAt: EpochMillis;
}

/** The list handler — reads the reconciled connector inventory for the tenant. */
export type ListConnectorsPort = (
  query: ListConnectorsQuery,
) => ListConnectorsResult | Promise<ListConnectorsResult>;

// ── Reconcile (POST /connectors/{connectorId}/reconcile) ─────────────────────────────────────────

/** A single unresolved drift item found during reconciliation. */
export interface DriftItemView {
  readonly kind: string;
  readonly detail: string;
  readonly resolved: boolean;
}

/** The outcome of a reconciliation run (desired-vs-current) for a connector (T235). */
export interface ReconciliationView {
  readonly id: Uuid;
  readonly connectorId: Uuid;
  readonly cadence: string;
  readonly resolved: boolean;
  readonly driftItems: readonly DriftItemView[];
  readonly ownerPrincipalId: Uuid;
  readonly startedAt: EpochMillis;
  readonly finishedAt?: EpochMillis | null;
}

/** The validated command a reconcile request carries to the injected handler. */
export interface ReconcileConnectorCommand {
  readonly tenantId: TenantId;
  readonly connectorId: Uuid;
  readonly requesterPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly cadence: 'on_demand' | 'return_to_service';
}

export interface ReconcileConnectorResult {
  /** True iff the reconciliation completed synchronously (else it was accepted for async run). */
  readonly completed: boolean;
  readonly run: ReconciliationView;
  readonly idempotentReplay: boolean;
}

/** The reconcile handler — runs (or schedules) a desired-vs-current reconciliation (T235). */
export type ReconcilePort = (
  command: ReconcileConnectorCommand,
) => ReconcileConnectorResult | Promise<ReconcileConnectorResult>;

// ── Platform health (GET /platform/health) ───────────────────────────────────────────────────────

/** The aggregate, fail-visible platform-health picture over every connector (FR-029/FR-030). */
export interface PlatformHealthView {
  /** Worst-of the observed connector health — `unknown` when no fresh picture backs it. */
  readonly aggregate: ObservedHealth;
  readonly connectors: readonly ConnectorView[];
  /** Open alerts routed to accountable owners (FR-030). */
  readonly openAlerts: readonly AlertView[];
  /** Connectors whose backing observation is stale/absent — surfaced, never inferred healthy. */
  readonly staleConnectorIds: readonly Uuid[];
  readonly observedAt: EpochMillis;
}

export interface PlatformHealthQuery {
  readonly tenantId: TenantId;
  readonly correlationId: string;
}

/** The platform-health handler — assembles the aggregate connector-health picture. */
export type PlatformHealthPort = (
  query: PlatformHealthQuery,
) => PlatformHealthView | Promise<PlatformHealthView>;

// ── Platform readiness (GET /platform/readiness) ─────────────────────────────────────────────────

/**
 * A single governed component's readiness facet — its availability class + runtime state reported
 * SEPARATELY from any design authority (NFR-010). A core component that is not available blocks
 * readiness; an optional/on-demand one does not.
 */
export interface ComponentReadinessView {
  readonly componentKey: string;
  readonly availabilityClass: AvailabilityClassWire;
  readonly runtimeState: string;
  readonly health: ObservedHealth;
  readonly freshness: ObservedFreshness;
  /** Present iff the component is not (healthy AND fresh): the visible safe next action. */
  readonly safeNextAction?: string;
}

/** The fail-visible platform readiness picture — core availability separate from optional. */
export interface PlatformReadinessView {
  /** True iff every CORE component is available AND fresh. */
  readonly ready: boolean;
  readonly components: readonly ComponentReadinessView[];
  /** Core components that are unavailable/stale — the fail-visible surface (blocks readiness). */
  readonly unavailableCoreComponents: readonly string[];
  readonly observedAt: EpochMillis;
}

export interface PlatformReadinessQuery {
  readonly tenantId: TenantId;
  readonly correlationId: string;
}

/** The readiness handler — assembles the availability picture (core separate from optional). */
export type ReadinessPort = (
  query: PlatformReadinessQuery,
) => PlatformReadinessView | Promise<PlatformReadinessView>;

/** The injected integration ports the route composes. */
export interface IntegrationRoutePorts {
  readonly registerAdapter: RegisterAdapterPort;
  readonly listConnectors: ListConnectorsPort;
  readonly reconcile: ReconcilePort;
  readonly platformHealth: PlatformHealthPort;
  readonly readiness: ReadinessPort;
}

// ===========================================================================
// 1. Vocabularies + a disclosure-safe Problem responder.
// ===========================================================================

const ADAPTER_CATEGORIES: ReadonlySet<string> = new Set([
  'connector',
  'workflow',
  'cli',
  'governance-observer',
  'infrastructure',
]);

const RECONCILE_CADENCES: ReadonlySet<string> = new Set(['on_demand', 'return_to_service']);

const AVAILABILITY_CLASSES_WIRE: ReadonlySet<string> = new Set(['core', 'optional', 'on-demand']);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

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

/** The authenticated principal (the accountable actor). */
function principalOf(c: AppContext): string {
  return c.ctx?.principalId ?? 'unknown';
}

// ===========================================================================
// 2. Time + wire mappers (view → contract-shaped JSON).
// ===========================================================================

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: EpochMillis | null | undefined): string | null {
  return ms === undefined || ms === null ? null : iso(ms);
}

function alertToWire(a: AlertView): Record<string, unknown> {
  return {
    id: String(a.id),
    alert_class: a.alertClass,
    severity: a.severity,
    owner_principal_id: String(a.ownerPrincipalId),
    state: a.state,
    first_observed_at: iso(a.firstObservedAt),
    owner_notified_at: isoOrNull(a.ownerNotifiedAt),
    recovered_at: isoOrNull(a.recoveredAt),
  };
}

function adapterVersionToWire(v: AdapterVersionView): Record<string, unknown> {
  return {
    id: String(v.id),
    definition_id: String(v.definitionId),
    adapter_key: v.adapterKey,
    display_name: v.displayName,
    category: v.category,
    // A connector is never authoritative — echoed FALSE, never negotiable.
    authority_grantable: false,
    owner_principal_id: String(v.ownerPrincipalId),
    semantic_version: v.semanticVersion,
    protocol_min: v.protocolMin,
    protocol_max: v.protocolMax,
    capabilities: [...v.capabilities],
    manifest_signature: v.manifestSignature,
    signing_key_id: v.signingKeyId,
    lifecycle_state: v.lifecycleState,
    content_digest: v.contentDigest,
    created_at: iso(v.createdAt),
  };
}

function connectorToWire(x: ConnectorView): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: String(x.id),
    adapter_key: x.adapterKey,
    source_ref: x.sourceRef,
    definition_id: String(x.definitionId),
    version_id: String(x.versionId),
    observed_version: x.observedVersion ?? null,
    owner_principal_id: String(x.ownerPrincipalId),
    availability_class: x.availabilityClass,
    lifecycle_state: x.lifecycleState,
    enabled_capabilities: [...x.enabledCapabilities],
    scopes: [...x.scopes],
    health: x.health,
    freshness: x.freshness,
    freshness_age_ms: x.freshnessAgeMs ?? null,
    lag_ms: x.lagMs ?? null,
    last_success_at: isoOrNull(x.lastSuccessAt),
    last_attempt_at: isoOrNull(x.lastAttemptAt),
    active_operation_id: x.activeOperationId ? String(x.activeOperationId) : null,
    failure_count: x.failureCount,
    retry_depth: x.retryDepth,
    dead_letter_count: x.deadLetterCount,
    affected_scope: [...x.affectedScope],
    business_impact: x.businessImpact,
    evidence_ids: x.evidenceIds.map((e) => String(e)),
    alerts: x.alerts.map(alertToWire),
    observed_at: iso(x.observedAt),
  };
  return x.safeNextAction !== undefined ? { ...base, safe_next_action: x.safeNextAction } : base;
}

function reconciliationToWire(r: ReconciliationView): Record<string, unknown> {
  return {
    id: String(r.id),
    connector_id: String(r.connectorId),
    cadence: r.cadence,
    resolved: r.resolved,
    drift_items: r.driftItems.map((d) => ({
      kind: d.kind,
      detail: d.detail,
      resolved: d.resolved,
    })),
    owner_principal_id: String(r.ownerPrincipalId),
    started_at: iso(r.startedAt),
    finished_at: isoOrNull(r.finishedAt),
  };
}

function componentReadinessToWire(x: ComponentReadinessView): Record<string, unknown> {
  const base: Record<string, unknown> = {
    component_key: x.componentKey,
    availability_class: x.availabilityClass,
    runtime_state: x.runtimeState,
    health: x.health,
    freshness: x.freshness,
  };
  return x.safeNextAction !== undefined ? { ...base, safe_next_action: x.safeNextAction } : base;
}

// ===========================================================================
// 3. Request-body validation (wire-shape only; domain rules live in the service).
// ===========================================================================

class BodyError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Validate + normalize an adapter-registration body. */
function parseAdapterRegistration(raw: unknown): Omit<
  RegisterAdapterCommand,
  'tenantId' | 'registrarPrincipalId' | 'correlationId' | 'idempotencyKey'
> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set([
    'adapter_key',
    'display_name',
    'category',
    'owner_principal_id',
    'semantic_version',
    'protocol_min',
    'protocol_max',
    'capabilities',
    'manifest',
    'manifest_signature',
    'signing_key_id',
    'authority_grantable',
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
  }

  // A connector is NEVER authoritative: a caller asking to grant authority is a governed rejection.
  const authority = body['authority_grantable'];
  if (authority !== undefined && authority !== false) {
    throw new BodyError(
      'authority_forbidden',
      'authority_grantable must be false: a connector is never granted governance authority.',
      422,
    );
  }

  const adapterKey = body['adapter_key'];
  if (typeof adapterKey !== 'string' || adapterKey.trim().length === 0) {
    throw new BodyError('invalid_adapter_key', 'adapter_key must be a non-empty string.');
  }
  const displayName = body['display_name'];
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new BodyError('invalid_display_name', 'display_name must be a non-empty string.');
  }
  const category = body['category'];
  if (typeof category !== 'string' || !ADAPTER_CATEGORIES.has(category)) {
    throw new BodyError(
      'invalid_category',
      'category must be one of connector, workflow, cli, governance-observer, infrastructure.',
    );
  }
  const ownerPrincipalId = body['owner_principal_id'];
  if (typeof ownerPrincipalId !== 'string' || !isUuid(ownerPrincipalId)) {
    throw new BodyError('invalid_owner', 'owner_principal_id must be a uuid.');
  }
  const semanticVersion = body['semantic_version'];
  if (typeof semanticVersion !== 'string' || !SEMVER_RE.test(semanticVersion)) {
    throw new BodyError('invalid_semantic_version', 'semantic_version must be a semver string.');
  }
  const protocolMin = body['protocol_min'];
  const protocolMax = body['protocol_max'];
  if (!Number.isInteger(protocolMin) || (protocolMin as number) < 1) {
    throw new BodyError('invalid_protocol_min', 'protocol_min must be an integer >= 1.');
  }
  if (!Number.isInteger(protocolMax) || (protocolMax as number) < (protocolMin as number)) {
    throw new BodyError('invalid_protocol_max', 'protocol_max must be an integer >= protocol_min.');
  }
  const capabilities = body['capabilities'];
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((cap) => typeof cap === 'string' && cap.length > 0)
  ) {
    throw new BodyError('invalid_capabilities', 'capabilities must be an array of non-empty strings.');
  }
  const manifest = body['manifest'];
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new BodyError('invalid_manifest', 'manifest must be a JSON object.');
  }
  const manifestSignature = body['manifest_signature'];
  if (typeof manifestSignature !== 'string' || manifestSignature.trim().length === 0) {
    throw new BodyError('invalid_signature', 'manifest_signature must be a non-empty string.', 422);
  }
  const signingKeyId = body['signing_key_id'];
  if (typeof signingKeyId !== 'string' || signingKeyId.trim().length === 0) {
    throw new BodyError('invalid_signing_key', 'signing_key_id must be a non-empty string.', 422);
  }

  return {
    adapterKey,
    displayName,
    category,
    ownerPrincipalId,
    semanticVersion,
    protocolMin: protocolMin as number,
    protocolMax: protocolMax as number,
    capabilities: [...new Set(capabilities as string[])],
    manifest: manifest as Record<string, unknown>,
    manifestSignature,
    signingKeyId,
  };
}

/** Validate a reconcile body (`cadence` only; on_demand default when absent). */
function parseReconcile(raw: unknown): 'on_demand' | 'return_to_service' {
  if (raw === undefined || raw === null) return 'on_demand';
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (k !== 'cadence') throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
  }
  const cadence = body['cadence'];
  if (cadence === undefined) return 'on_demand';
  if (typeof cadence !== 'string' || !RECONCILE_CADENCES.has(cadence)) {
    throw new BodyError('invalid_cadence', 'cadence must be one of on_demand, return_to_service.');
  }
  return cadence as 'on_demand' | 'return_to_service';
}

// ===========================================================================
// 4. Handlers.
// ===========================================================================

/** POST /adapters — register a signed, versioned, immutable adapter build (T228/T230); 201. */
function registerAdapter(ports: IntegrationRoutePorts): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }

    let fields: Omit<
      RegisterAdapterCommand,
      'tenantId' | 'registrarPrincipalId' | 'correlationId' | 'idempotencyKey'
    >;
    try {
      fields = parseAdapterRegistration(raw);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(
          c,
          e.httpStatus,
          e.code,
          e.httpStatus === 422 ? 'Unprocessable' : 'Bad Request',
          e.message,
        );
      }
      throw e;
    }

    const idempotencyKey = c.req.header('idempotency-key');
    const command: RegisterAdapterCommand = {
      tenantId,
      registrarPrincipalId: principalOf(c),
      correlationId: c.ctx?.correlationId ?? '',
      ...fields,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: RegisterAdapterResult;
    try {
      result = await ports.registerAdapter(command);
    } catch {
      return problem(
        c,
        500,
        'adapter_registration_failed',
        'Adapter could not be registered',
        'The adapter registration was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    return c.json(adapterVersionToWire(result.version), 201);
  };
}

/** GET /connectors — read the reconciled connector inventory with the FR-029 field set; 200. */
function listConnectors(ports: IntegrationRoutePorts): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }

    const url = new URL(c.req.url, 'http://internal');
    const availabilityClass = url.searchParams.get('availability_class') ?? undefined;
    if (availabilityClass !== undefined && !AVAILABILITY_CLASSES_WIRE.has(availabilityClass)) {
      return problem(
        c,
        400,
        'invalid_availability_class',
        'Bad Request',
        'availability_class must be one of core, optional, on-demand.',
      );
    }
    const lifecycleState = url.searchParams.get('lifecycle_state') ?? undefined;

    const query: ListConnectorsQuery = {
      tenantId,
      correlationId: c.ctx?.correlationId ?? '',
      ...(availabilityClass !== undefined
        ? { availabilityClass: availabilityClass as AvailabilityClassWire }
        : {}),
      ...(lifecycleState !== undefined ? { lifecycleState } : {}),
    };

    let result: ListConnectorsResult;
    try {
      result = await ports.listConnectors(query);
    } catch {
      return problem(
        c,
        500,
        'connector_list_failed',
        'Connector inventory could not be read',
        'The connector inventory was not readable.',
        ['retry; if it persists, inspect the connector-service health'],
      );
    }

    return c.json(
      {
        connectors: result.connectors.map(connectorToWire),
        observed_at: iso(result.observedAt),
      },
      200,
    );
  };
}

/** POST /connectors/{connectorId}/reconcile — desired-vs-current reconciliation (T235); 200/202. */
function reconcileConnector(ports: IntegrationRoutePorts): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const connectorId = connectorIdOf(c);
    if (connectorId === undefined) {
      return problem(
        c,
        400,
        'invalid_connector_id',
        'Bad Request',
        'The connector id path segment must be a uuid.',
      );
    }

    let raw: unknown;
    if (c.req.header('content-length') === '0') {
      raw = undefined;
    } else {
      try {
        raw = await c.req.json();
      } catch {
        raw = undefined;
      }
    }

    let cadence: 'on_demand' | 'return_to_service';
    try {
      cadence = parseReconcile(raw);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(c, e.httpStatus, e.code, 'Bad Request', e.message);
      }
      throw e;
    }

    const idempotencyKey = c.req.header('idempotency-key');
    const command: ReconcileConnectorCommand = {
      tenantId,
      connectorId,
      requesterPrincipalId: principalOf(c),
      correlationId: c.ctx?.correlationId ?? '',
      cadence,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: ReconcileConnectorResult;
    try {
      result = await ports.reconcile(command);
    } catch {
      return problem(
        c,
        500,
        'reconcile_failed',
        'Reconciliation could not be run',
        'The reconciliation was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    return c.json(reconciliationToWire(result.run), result.completed ? 200 : 202);
  };
}

/** GET /platform/health — the aggregate, fail-visible connector-health picture (FR-029/FR-030); 200. */
function platformHealth(ports: IntegrationRoutePorts): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }

    let view: PlatformHealthView;
    try {
      view = await ports.platformHealth({ tenantId, correlationId: c.ctx?.correlationId ?? '' });
    } catch {
      return problem(
        c,
        500,
        'platform_health_failed',
        'Platform health could not be read',
        'The platform-health picture was not readable.',
        ['retry; a persistent failure is itself a health incident — alert the platform owner'],
      );
    }

    return c.json(
      {
        aggregate: view.aggregate,
        connectors: view.connectors.map(connectorToWire),
        open_alerts: view.openAlerts.map(alertToWire),
        stale_connector_ids: view.staleConnectorIds.map((id) => String(id)),
        observed_at: iso(view.observedAt),
      },
      200,
    );
  };
}

/** GET /platform/readiness — availability picture, core SEPARATE from optional (NFR-010); 200/503. */
function platformReadiness(ports: IntegrationRoutePorts): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }

    let view: PlatformReadinessView;
    try {
      view = await ports.readiness({ tenantId, correlationId: c.ctx?.correlationId ?? '' });
    } catch {
      // A readiness read that cannot answer is itself a fail-visible not-ready.
      return problem(
        c,
        503,
        'platform_readiness_unavailable',
        'Platform readiness could not be determined',
        'The readiness picture was not readable; treat the platform as not ready.',
        ['do not rely on optional components; alert the platform owner and reconcile'],
      );
    }

    const body = {
      ready: view.ready,
      components: view.components.map(componentReadinessToWire),
      unavailable_core_components: [...view.unavailableCoreComponents],
      observed_at: iso(view.observedAt),
    };
    // Fail-visible: ready ⇒ 200; anything else ⇒ 503 (a stale/unavailable core facet is never a 200).
    return c.json(body, view.ready ? 200 : 503);
  };
}

// ===========================================================================
// 5. Small shared helpers.
// ===========================================================================

function connectorIdOf(c: AppContext): Uuid | undefined {
  const id = c.req.param('connectorId');
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
}

// ===========================================================================
// 6. Registration.
// ===========================================================================

/**
 * Mount the five integration routes onto `app`. All are AUTHENTICATED (they carry a tenant scope +
 * audit identity). Paths are registered WITHOUT the version prefix — `App.get`/`App.post` prepend
 * `API_PREFIX` (`/v1`), so they serve at `/v1/adapters`, `/v1/connectors`, etc.
 */
export function registerIntegrationRoutes(app: App, ports: IntegrationRoutePorts): App {
  app.post('/adapters', registerAdapter(ports));
  app.get('/connectors', listConnectors(ports));
  app.post('/connectors/:connectorId/reconcile', reconcileConnector(ports));
  app.get('/platform/health', platformHealth(ports));
  app.get('/platform/readiness', platformReadiness(ports));
  return app;
}
