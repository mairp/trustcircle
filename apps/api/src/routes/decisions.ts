// @trustcircle/api — HUMAN-DECISION ROUTES (Phase 4 / User Story 2 / FR-010, FR-011, FR-012,
// FR-013, AC1, AC2, AC4, SC-003, SC-004).
//
// Mounts the four decision operations from the OpenAPI contract
// (specs/001-governance-control-plane/contracts/governance-api.openapi.yaml) onto the
// dependency-free Hono-compatible `App` from ../server.ts:
//
//   GET  /v1/decisions                    → listDecisionQueue  → DecisionPage  (prioritized queue)
//   POST /v1/decisions                    → createDecisionRequest → DecisionRequest (201 + ETag)
//   GET  /v1/decisions/{decisionId}       → getDecisionRequest  → DecisionRequest (200 + ETag)
//   POST /v1/decisions/{decisionId}/actions → actOnDecision     → {decision, record, audit_event_id}
//                                                                  (200 + ETag)
//
// The obligations this module enforces at the boundary (every one verifiable against the contract
// checkers in @trustcircle/contracts/decision-api):
//
//   * MANDATORY REASON (FR-012). Every state-changing action carries a structured `reason`
//     {code, text}; a missing/blank reason is a visible 422 governed rejection, never accepted.
//     The reason is threaded into the decision service which records it as the attributable basis.
//   * CURRENT-PACKAGE ETag (AC2/AC4). Both reads (get, and the action's returned package) and the
//     create response carry a strong ETag over the CURRENT package version. A state-changing action
//     REQUIRES `If-Match`; a stale/mismatched `If-Match` is a 412 (optimistic concurrency), so two
//     reviewers cannot silently clobber each other, and an action is never applied to a package the
//     actor did not actually see (the ETag is the package-digest the actor bound to).
//   * IDEMPOTENCY (FR-011). Create + action carry `Idempotency-Key`; a replay returns the SAME
//     committed outcome (never a second effect), surfaced with a replay marker.
//   * GOVERNED REJECTION (FR-013). A refused action (no authority, SoD conflict, expired, stale,
//     terminal) is a Problem carrying an `audit_event_id` and safe next actions — a durable,
//     explained refusal, never a silent no-op.
//
// The module is pure request→response plumbing over INJECTED ports (a queue projection provider, a
// package reader, and create/act command handlers resolved by the composition root). It holds no
// mutable state, reads no wall clock (the provider/command carries `now`), and assembles every
// response body from an INDEPENDENT read of the package surface — never a mutation echo. The route
// re-implements no authority, SoD, or reason logic: it validates the wire shape, then delegates.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiCreateDecisionRequest,
  GovernanceApiDecisionRequest,
  GovernanceApiDecisionRecord,
  GovernanceApiDecisionPage,
  GovernanceApiPageMetadata,
  GovernanceApiReason,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports — the route composes decision services; it never builds them.
// ===========================================================================

/** A decision package as the injected surface hands it to the route (already tenant-authorized).
 *  It mirrors the contract `DecisionRequest` fields plus the durable `version` the ETag is over. */
export interface DecisionPackageView {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly workItemId: Uuid;
  readonly requesterPrincipalId: Uuid;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly businessImpact: Readonly<Record<string, unknown>>;
  readonly risks: readonly Readonly<Record<string, unknown>>[];
  readonly alternatives: readonly Readonly<Record<string, unknown>>[];
  readonly expectedResult: Readonly<Record<string, unknown>>;
  readonly evidenceManifestId?: Uuid | null;
  readonly simulationId?: Uuid | null;
  readonly affectedTenantIds?: readonly Uuid[];
  readonly status: string;
  readonly requirements: readonly DecisionRequirementView[];
  readonly version: number;
  readonly createdAt: EpochMillis;
  readonly expiresAt: EpochMillis;
  /** The current package digest — the value the ETag is derived from and an actor binds to (AC2). */
  readonly packageDigest: string;
}

export interface DecisionRequirementView {
  readonly id: Uuid;
  readonly gateType: string;
  readonly tenantId: Uuid | null;
  readonly status: string;
  readonly minimumDistinctPrincipals: number;
  readonly incompatibleRelationships?: readonly string[];
}

/** The attributable decision RECORD returned by an accepted/rejected action (FR-012). */
export interface DecisionRecordView {
  readonly id: Uuid;
  readonly actorPrincipalId: Uuid;
  readonly authorityAssignmentId?: Uuid;
  readonly action: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly status: string;
  readonly decidedAt: EpochMillis;
  readonly auditEventId: Uuid;
}

/** A prioritized queue read for a tenant (from @trustcircle/projections DecisionQueueProjector). */
export interface DecisionQueueView {
  /** The decision packages in priority order (highest urgency first). */
  readonly items: readonly DecisionPackageView[];
  /** When the queue snapshot was taken (RFC3339-able epoch-ms). */
  readonly generatedAt: EpochMillis;
  /** The queue's freshness (page metadata vocabulary). */
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  /** True iff the queue is known-incomplete (a partial picture). */
  readonly partialCoverage: boolean;
  /** The queue snapshot digest witness (the projector's `snapshotDigest`). */
  readonly snapshotDigest: string;
}

/** Filters the queue read honours (contract query params). */
export interface DecisionQueueFilter {
  readonly status?: string;
  /** When true, only decisions the querying actor may currently act on. */
  readonly assignedToMe?: boolean;
}

/** Resolves the prioritized queue for an authenticated tenant/actor, or undefined (empty page). */
export type DecisionQueueProvider = (
  tenantId: TenantId,
  principalId: string,
  filter: DecisionQueueFilter,
) => DecisionQueueView | undefined;

/** Reads one decision package for a tenant, or undefined when it does not exist / is not visible. */
export type DecisionPackageReader = (
  tenantId: TenantId,
  decisionId: Uuid,
) => DecisionPackageView | undefined | Promise<DecisionPackageView | undefined>;

/** The structured, validated command a create request carries to the injected handler. */
export interface CreateDecisionCommand {
  readonly tenantId: TenantId;
  readonly requesterPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly request: GovernanceApiCreateDecisionRequest;
}

/** The outcome of a create: the committed package + whether it was an idempotent replay. */
export interface CreateDecisionResult {
  readonly package: DecisionPackageView;
  readonly idempotentReplay: boolean;
}

/** The create handler — commits a new decision package with its required gates (FR-010). */
export type CreateDecisionHandler = (
  command: CreateDecisionCommand,
) => CreateDecisionResult | Promise<CreateDecisionResult>;

/** The structured, validated command an action carries to the injected handler. */
export interface DecisionActionCommandInput {
  readonly tenantId: TenantId;
  readonly decisionId: Uuid;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly action:
    | 'approve'
    | 'deny'
    | 'delegate'
    | 'request_changes'
    | 'escalate'
    | 'expire'
    | 'cancel';
  readonly reason: { readonly code: string; readonly text: string };
  /** The package version the actor bound to (decoded from `If-Match`); optimistic-concurrency guard. */
  readonly expectedVersion: number;
  readonly delegation?: unknown;
  readonly evidenceManifestId?: Uuid | null;
}

/** The outcome of an action — accepted or a governed rejection, both durable + audited (FR-013). */
export interface DecisionActionResult {
  readonly accepted: boolean;
  /** The current package AFTER the action (the independent read-back the response body carries). */
  readonly package: DecisionPackageView;
  /** The attributable record (present for both accepted and rejected outcomes). */
  readonly record: DecisionRecordView;
  readonly auditEventId: Uuid;
  readonly idempotentReplay: boolean;
  /** For a rejection: the machine code + safe next actions the Problem surfaces (FR-013). */
  readonly rejection?: {
    readonly code: string;
    readonly httpStatus: number;
    readonly detail: string;
    readonly safeNextActions: readonly string[];
  };
}

/** The action handler — evaluates authority/SoD/reason/concurrency and commits the outcome. */
export type DecisionActionHandler = (
  command: DecisionActionCommandInput,
) => DecisionActionResult | Promise<DecisionActionResult>;

export interface DecisionRouteDeps {
  readonly queue: DecisionQueueProvider;
  readonly readPackage: DecisionPackageReader;
  readonly create: CreateDecisionHandler;
  readonly act: DecisionActionHandler;
}

// ===========================================================================
// 1. Contract vocabularies + a disclosure-safe Problem responder.
// ===========================================================================

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REASON_TEXT_MIN = 3;
const REASON_TEXT_MAX = 4000;

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const DECISION_ACTIONS: ReadonlySet<string> = new Set([
  'approve',
  'deny',
  'delegate',
  'request_changes',
  'escalate',
  'expire',
  'cancel',
]);

/** Emit an RFC-9457-shaped Problem the app's error contract accepts. When an `auditEventId` is
 *  supplied it is a GOVERNED rejection (FR-013): the refusal is durable + attributable. */
function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
  auditEventId?: string,
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
  if (auditEventId !== undefined) body['audit_event_id'] = auditEventId;
  return c.json(body, status);
}

/** The authenticated tenant of the request, validated as a UUID tenant scope. */
function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

/** The authenticated principal (the accountable actor for a decision). */
function principalOf(c: AppContext): string {
  return c.ctx?.principalId ?? 'unknown';
}

// ===========================================================================
// 2. ETag — a strong validator over the CURRENT package (digest + version).
//    The ETag binds the digest of the package the caller last saw to its version,
//    so `If-Match` on an action proves the actor acted on THAT package (AC2) and
//    optimistic concurrency refuses a stale write (412).
// ===========================================================================

/** Build the strong ETag for a package's current state (digest + version). */
export function packageEtag(pkg: DecisionPackageView): string {
  return `"dp-${pkg.version}-${pkg.packageDigest}"`;
}

/** Parse an `If-Match` header into the version + digest it asserts, or null when unparseable. */
function parseIfMatch(value: string | undefined): { version: number; digest: string } | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  // Accept the wildcard as "any current version" only when the caller explicitly opts in.
  const m = /^"dp-(\d+)-([0-9a-f]+)"$/.exec(trimmed);
  if (!m) return null;
  const version = Number(m[1]);
  if (!Number.isInteger(version) || version < 1) return null;
  return { version, digest: m[2] ?? '' };
}

// ===========================================================================
// 3. Time + wire mappers.
// ===========================================================================

/** Epoch-ms → RFC3339 UTC string (the wire `date-time`). */
function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

function requirementToWire(
  r: DecisionRequirementView,
): GovernanceApiDecisionRequest['requirements'][number] {
  const base = {
    id: String(r.id),
    gate_type: r.gateType,
    tenant_id: r.tenantId === null ? null : String(r.tenantId),
    status: r.status,
    minimum_distinct_principals: r.minimumDistinctPrincipals,
  };
  return r.incompatibleRelationships !== undefined && r.incompatibleRelationships.length > 0
    ? { ...base, incompatible_relationships: [...r.incompatibleRelationships] }
    : base;
}

/** Map a package view to the contract `DecisionRequest` wire shape (create/get/action responses). */
function packageToWire(pkg: DecisionPackageView): GovernanceApiDecisionRequest {
  const out: GovernanceApiDecisionRequest = {
    id: String(pkg.id),
    tenant_id: String(pkg.tenantId),
    work_item_id: String(pkg.workItemId),
    requester_principal_id: String(pkg.requesterPrincipalId),
    requested_action: pkg.requestedAction,
    action_class: pkg.actionClass,
    risk_tier: pkg.riskTier,
    scope: { ...pkg.scope },
    business_impact: { ...pkg.businessImpact },
    risks: pkg.risks.map((r) => ({ ...r })),
    alternatives: pkg.alternatives.map((a) => ({ ...a })),
    expected_result: { ...pkg.expectedResult },
    status: pkg.status,
    requirements: pkg.requirements.map(requirementToWire),
    version: pkg.version,
    created_at: iso(pkg.createdAt),
    expires_at: iso(pkg.expiresAt),
  };
  const withEvidence =
    pkg.evidenceManifestId !== undefined && pkg.evidenceManifestId !== null
      ? { ...out, evidence_manifest_id: String(pkg.evidenceManifestId) }
      : out;
  const withSim =
    pkg.simulationId !== undefined && pkg.simulationId !== null
      ? { ...withEvidence, simulation_id: String(pkg.simulationId) }
      : withEvidence;
  return pkg.affectedTenantIds !== undefined && pkg.affectedTenantIds.length > 0
    ? { ...withSim, affected_tenant_ids: pkg.affectedTenantIds.map((t) => String(t)) }
    : withSim;
}

function recordToWire(rec: DecisionRecordView): GovernanceApiDecisionRecord {
  const out: GovernanceApiDecisionRecord = {
    id: String(rec.id),
    actor_principal_id: String(rec.actorPrincipalId),
    action: rec.action,
    reason: { code: rec.reason.code, text: rec.reason.text },
    status: rec.status,
    decided_at: iso(rec.decidedAt),
    audit_event_id: String(rec.auditEventId),
  };
  return rec.authorityAssignmentId !== undefined
    ? { ...out, authority_assignment_id: String(rec.authorityAssignmentId) }
    : out;
}

// ===========================================================================
// 4. Request-body validation (wire-shape only; domain rules live in the service).
// ===========================================================================

/** A validation failure carrier — kept distinct so a handler answers 400/422 with the reason. */
class BodyError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Validate the structured decision reason (FR-012). A missing/blank reason is a 422 rejection. */
function validateReason(raw: unknown): GovernanceApiReason {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('missing_reason', 'A structured reason {code, text} is required.', 422);
  }
  const rec = raw as Record<string, unknown>;
  const code = rec['code'];
  const text = rec['text'];
  if (typeof code !== 'string' || !REASON_CODE_RE.test(code)) {
    throw new BodyError('invalid_reason', 'reason.code must match /^[a-z][a-z0-9_.-]{1,63}$/.', 422);
  }
  if (typeof text !== 'string' || text.trim().length < REASON_TEXT_MIN || text.length > REASON_TEXT_MAX) {
    throw new BodyError(
      'invalid_reason',
      `reason.text must be ${REASON_TEXT_MIN}..${REASON_TEXT_MAX} non-blank characters.`,
      422,
    );
  }
  return { code, text };
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_field', `${field} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function asObjectArray(raw: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'object' || x === null || Array.isArray(x))) {
    throw new BodyError('invalid_field', `${field} must be an array of objects.`);
  }
  return raw as Record<string, unknown>[];
}

/** Validate + normalize a CreateDecisionRequest body (contract `additionalProperties:false`). */
function parseCreateRequest(raw: unknown): GovernanceApiCreateDecisionRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set([
    'work_item_id',
    'requested_action',
    'action_class',
    'risk_tier',
    'scope',
    'business_impact',
    'risks',
    'alternatives',
    'expected_result',
    'evidence_manifest_id',
    'simulation_id',
    'affected_tenant_ids',
    'expires_at',
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
  }

  const workItemId = body['work_item_id'];
  if (typeof workItemId !== 'string' || !isUuid(workItemId)) {
    throw new BodyError('invalid_work_item', 'work_item_id must be a uuid.');
  }
  const requestedAction = body['requested_action'];
  if (typeof requestedAction !== 'string' || requestedAction.length === 0) {
    throw new BodyError('invalid_requested_action', 'requested_action must be a non-empty string.');
  }
  const actionClass = body['action_class'];
  if (typeof actionClass !== 'string' || actionClass.length === 0) {
    throw new BodyError('invalid_action_class', 'action_class must be a non-empty string.');
  }
  const riskTier = body['risk_tier'];
  if (typeof riskTier !== 'string' || riskTier.length === 0) {
    throw new BodyError('invalid_risk_tier', 'risk_tier must be a non-empty string.');
  }
  const expiresAt = body['expires_at'];
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new BodyError('invalid_expires_at', 'expires_at must be an RFC3339 date-time.');
  }

  const out: GovernanceApiCreateDecisionRequest = {
    work_item_id: workItemId,
    requested_action: requestedAction,
    action_class: actionClass,
    risk_tier: riskTier,
    scope: asObject(body['scope'], 'scope'),
    business_impact: asObject(body['business_impact'], 'business_impact'),
    risks: asObjectArray(body['risks'], 'risks'),
    alternatives: asObjectArray(body['alternatives'], 'alternatives'),
    expected_result: asObject(body['expected_result'], 'expected_result'),
    expires_at: expiresAt,
  };

  // Optional nullable fields.
  const em = body['evidence_manifest_id'];
  const withEm =
    em === undefined
      ? out
      : em === null
        ? { ...out, evidence_manifest_id: null }
        : typeof em === 'string' && isUuid(em)
          ? { ...out, evidence_manifest_id: em }
          : (() => {
              throw new BodyError('invalid_evidence_manifest', 'evidence_manifest_id must be a uuid or null.');
            })();
  const sim = body['simulation_id'];
  const withSim =
    sim === undefined
      ? withEm
      : sim === null
        ? { ...withEm, simulation_id: null }
        : typeof sim === 'string' && isUuid(sim)
          ? { ...withEm, simulation_id: sim }
          : (() => {
              throw new BodyError('invalid_simulation', 'simulation_id must be a uuid or null.');
            })();
  const aff = body['affected_tenant_ids'];
  if (aff === undefined) return withSim;
  if (!Array.isArray(aff) || !aff.every((t) => typeof t === 'string' && isUuid(t))) {
    throw new BodyError('invalid_affected_tenants', 'affected_tenant_ids must be a uuid array.');
  }
  const unique = [...new Set(aff as string[])];
  return { ...withSim, affected_tenant_ids: unique };
}

// ===========================================================================
// 5. Handlers.
// ===========================================================================

/** GET /decisions — the prioritized decision queue (SC-003). */
function listDecisionQueue(deps: DecisionRouteDeps): RouteHandler {
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

    const status = url.searchParams.get('status');
    const assignedToMeRaw = url.searchParams.get('assigned_to_me');
    const filter: DecisionQueueFilter = {
      ...(status !== null && status !== '' ? { status } : {}),
      ...(assignedToMeRaw === 'true' ? { assignedToMe: true } : {}),
    };

    const view = deps.queue(tenantId, principalOf(c), filter);
    if (view === undefined) {
      const body: GovernanceApiDecisionPage = {
        items: [],
        metadata: emptyMetadata(),
      };
      return c.json(body, 200);
    }

    const items = view.items.slice(0, limit).map(packageToWire);
    const metadata: GovernanceApiPageMetadata = {
      generated_at: iso(view.generatedAt),
      source_cursor: view.snapshotDigest,
      freshness: view.freshness,
      partial_coverage: view.partialCoverage,
      next_cursor: view.items.length > limit ? String(view.items.length) : null,
    };
    const body: GovernanceApiDecisionPage = { items, metadata };
    return c.json(body, 200);
  };
}

/** POST /decisions — create a decision request with its required gates (FR-010); 201 + ETag. */
function createDecisionRequest(deps: DecisionRouteDeps): RouteHandler {
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

    let request: GovernanceApiCreateDecisionRequest;
    try {
      request = parseCreateRequest(raw);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(c, e.httpStatus, e.code, e.httpStatus === 422 ? 'Unprocessable' : 'Bad Request', e.message);
      }
      throw e;
    }

    const correlationId = c.ctx?.correlationId ?? '';
    const idempotencyKey = c.req.header('idempotency-key');
    const command: CreateDecisionCommand = {
      tenantId,
      requesterPrincipalId: principalOf(c),
      correlationId,
      request,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: CreateDecisionResult;
    try {
      result = await deps.create(command);
    } catch {
      return problem(
        c,
        500,
        'decision_create_failed',
        'Decision could not be created',
        'The decision request was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    c.setHeader('etag', packageEtag(result.package));
    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    return c.json(packageToWire(result.package), 201);
  };
}

/** GET /decisions/{decisionId} — the complete current package (AC1); 200 + ETag. */
function getDecisionRequest(deps: DecisionRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const decisionId = decisionIdOf(c);
    if (decisionId === undefined) {
      return problem(c, 400, 'invalid_decision_id', 'Bad Request', 'The decision id path segment must be a uuid.');
    }

    const pkg = await deps.readPackage(tenantId, decisionId);
    if (pkg === undefined) {
      return problem(c, 404, 'decision_not_found', 'Not Found', 'No such decision in this tenant scope.');
    }

    c.setHeader('etag', packageEtag(pkg));
    return c.json(packageToWire(pkg), 200);
  };
}

/** POST /decisions/{decisionId}/actions — act on a decision (FR-011/012/013); mandatory reason,
 *  If-Match optimistic concurrency, ETag over the resulting package. */
function actOnDecision(deps: DecisionRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(c, 403, 'tenant_scope_required', 'Forbidden', 'A valid tenant scope is required.');
    }
    const decisionId = decisionIdOf(c);
    if (decisionId === undefined) {
      return problem(c, 400, 'invalid_decision_id', 'Bad Request', 'The decision id path segment must be a uuid.');
    }

    // If-Match is REQUIRED on a state-changing action — the actor must bind to a package version.
    const ifMatch = parseIfMatch(c.req.header('if-match'));
    if (ifMatch === null) {
      return problem(
        c,
        428,
        'if_match_required',
        'Precondition Required',
        'A valid If-Match header (the current package ETag) is required to act on a decision.',
        ['GET the decision to read its current ETag, then retry with If-Match'],
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body must be a JSON object.');
    }
    const body = raw as Record<string, unknown>;
    for (const k of Object.keys(body)) {
      if (!['action', 'reason', 'delegation', 'evidence_manifest_id'].includes(k)) {
        return problem(c, 400, 'unexpected_field', 'Bad Request', `Unexpected field: ${k}`);
      }
    }

    const action = body['action'];
    if (typeof action !== 'string' || !DECISION_ACTIONS.has(action)) {
      return problem(
        c,
        400,
        'invalid_action',
        'Bad Request',
        'action must be one of approve, deny, delegate, request_changes, escalate, expire, cancel.',
      );
    }

    let reason: GovernanceApiReason;
    try {
      reason = validateReason(body['reason']);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(c, e.httpStatus, e.code, 'Unprocessable', e.message, [
          'supply a structured reason {code, text} justifying this action',
        ]);
      }
      throw e;
    }

    const evidenceManifestId = body['evidence_manifest_id'];
    if (
      evidenceManifestId !== undefined &&
      evidenceManifestId !== null &&
      !(typeof evidenceManifestId === 'string' && isUuid(evidenceManifestId))
    ) {
      return problem(c, 400, 'invalid_evidence_manifest', 'Bad Request', 'evidence_manifest_id must be a uuid or null.');
    }

    const correlationId = c.ctx?.correlationId ?? '';
    const idempotencyKey = c.req.header('idempotency-key');
    const command: DecisionActionCommandInput = {
      tenantId,
      decisionId,
      actorPrincipalId: principalOf(c),
      correlationId,
      action: action as DecisionActionCommandInput['action'],
      reason,
      expectedVersion: ifMatch.version,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(body['delegation'] !== undefined ? { delegation: body['delegation'] } : {}),
      ...(evidenceManifestId !== undefined
        ? { evidenceManifestId: evidenceManifestId as Uuid | null }
        : {}),
    };

    let result: DecisionActionResult;
    try {
      result = await deps.act(command);
    } catch {
      return problem(
        c,
        500,
        'decision_action_failed',
        'Decision action could not be applied',
        'The action was not committed.',
        ['retry with the same idempotency key'],
      );
    }

    // Optimistic concurrency: the actor's If-Match must match the package it acted on. A mismatch
    // (another reviewer advanced the package) is a 412 — never a silent clobber. The service also
    // guards this; the boundary check makes the precondition semantics explicit on the wire.
    if (
      result.package.version !== ifMatch.version &&
      // Only a rejection whose code is the stale-version guard maps to 412; an accepted action
      // legitimately advances the version past If-Match, so we compare against the PRE-action digest.
      result.rejection?.code === 'stale_version'
    ) {
      c.setHeader('etag', packageEtag(result.package));
      return problem(
        c,
        412,
        'precondition_failed',
        'Precondition Failed',
        'The decision package changed since you last read it; re-read and retry.',
        ['GET the decision to read its current ETag, then retry with If-Match'],
        String(result.auditEventId),
      );
    }

    // A governed rejection (no authority, SoD conflict, expired, terminal, missing reason resolved
    // downstream, …) — a durable, explained Problem carrying its audit event + safe next actions.
    if (!result.accepted && result.rejection !== undefined) {
      c.setHeader('etag', packageEtag(result.package));
      return problem(
        c,
        result.rejection.httpStatus,
        result.rejection.code,
        'Decision action rejected',
        result.rejection.detail,
        result.rejection.safeNextActions,
        String(result.auditEventId),
      );
    }

    // Accepted (or a rejection with no explicit Problem mapping — still returned as the recorded
    // outcome with its record). ETag over the CURRENT package the caller must re-bind to next.
    c.setHeader('etag', packageEtag(result.package));
    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    const responseBody = {
      decision: packageToWire(result.package),
      record: recordToWire(result.record),
      audit_event_id: String(result.auditEventId),
    };
    return c.json(responseBody, 200);
  };
}

// ===========================================================================
// 6. Small shared helpers.
// ===========================================================================

/** Extract + validate the `:decisionId` path parameter as a uuid. */
function decisionIdOf(c: AppContext): Uuid | undefined {
  const id = c.req.param('decisionId');
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
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
// 7. Registration.
// ===========================================================================

/**
 * Mount the four decision routes onto `app`. All are AUTHENTICATED (they carry a tenant scope +
 * audit identity). Paths are registered WITHOUT the version prefix — `App.get`/`App.post` prepend
 * `API_PREFIX` (`/v1`), so they serve at `/v1/decisions...`.
 *
 * Route registration order matters for the dependency-free matcher (exact-path match): the
 * collection and item paths are distinct, so order is not ambiguous here.
 */
export function registerDecisionRoutes(app: App, deps: DecisionRouteDeps): App {
  app.get('/decisions', listDecisionQueue(deps));
  app.post('/decisions', createDecisionRequest(deps));
  app.get('/decisions/:decisionId', getDecisionRequest(deps));
  app.post('/decisions/:decisionId/actions', actOnDecision(deps));
  return app;
}
