// @trustcircle/api — DELEGATION ROUTES (Phase 4 / User Story 2 / FR-013, FR-014, AC3).
//
// Mounts the delegation operation from the OpenAPI contract onto the dependency-free
// Hono-compatible `App` from ../server.ts:
//
//   POST /v1/delegations   → createDelegation   → Delegation (201)
//
// A delegation transfers a NARROW, non-expanding slice of decision authority from a delegator to a
// recipient for a bounded window. The obligations enforced here (verifiable against the contract
// checkers in @trustcircle/contracts/decision-api):
//
//   * NON-EXPANDING GRANT (FR-014). The requested `actions` + `scope` must be a subset of the
//     delegator's own authority on the cited `authority_assignment_id`; the injected delegation
//     service enforces `delegationDoesNotExpand` and the SoD policy (a delegation must not create an
//     incompatible duty pairing). A request that would EXPAND authority is a governed rejection
//     carrying its audit event — never silently narrowed or granted.
//   * SCOPED AUTHORITY DISCLOSURE (AC3). The 201 response discloses ONLY the delegation the caller
//     is authorized to see: the resulting `Delegation` (its id, tenant, delegator, recipient, the
//     GRANTED actions/scope, validity window, and status) — never the delegator's full authority
//     graph, other principals' assignments, or any authority the recipient did not receive. The
//     route maps exactly the contract `Delegation` fields; nothing broader crosses the boundary.
//   * MANDATORY REASON (FR-012). The grant carries a structured `reason`; a missing/blank reason is
//     a 422, so every delegation is attributable.
//   * IDEMPOTENCY (FR-011). `Idempotency-Key` makes a replay return the SAME committed delegation.
//   * GOVERNED REJECTION (FR-013). A refused grant (expansion, SoD conflict, expired assignment,
//     unknown assignment) is a Problem carrying an `audit_event_id` + safe next actions.
//
// Pure request→response plumbing over an INJECTED delegation handler resolved by the composition
// root. Holds no mutable state, reads no wall clock, and re-implements no authority/SoD logic.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type { GovernanceApiDelegation, GovernanceApiReason } from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected port.
// ===========================================================================

/** A delegation as the injected surface hands it to the route (already tenant-authorized). Mirrors
 *  the contract `Delegation` — the delegator's full authority graph is NEVER carried here (AC3). */
export interface DelegationView {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly delegatorPrincipalId: Uuid;
  readonly recipientPrincipalId: Uuid;
  readonly authorityAssignmentId: Uuid;
  readonly scope: Readonly<Record<string, unknown>>;
  /** The GRANTED actions (already narrowed to the delegator's authority — never expanded). */
  readonly actions: readonly string[];
  readonly reason: { readonly code: string; readonly text: string };
  readonly validFrom: EpochMillis;
  readonly expiresAt: EpochMillis;
  readonly status: string;
}

/** The structured, validated command a create request carries to the injected handler. */
export interface CreateDelegationCommand {
  readonly tenantId: TenantId;
  readonly delegatorPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly recipientPrincipalId: Uuid;
  readonly authorityAssignmentId: Uuid;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly actions: readonly string[];
  readonly reason: { readonly code: string; readonly text: string };
  readonly validFrom: EpochMillis;
  readonly expiresAt: EpochMillis;
}

/** The outcome of a create — the committed delegation or a governed rejection (FR-013/FR-014). */
export interface CreateDelegationResult {
  readonly accepted: boolean;
  /** The committed delegation (present iff accepted). */
  readonly delegation?: DelegationView;
  readonly auditEventId: Uuid;
  readonly idempotentReplay: boolean;
  /** For a rejection: the machine code + status + safe next actions the Problem surfaces. */
  readonly rejection?: {
    readonly code: string;
    readonly httpStatus: number;
    readonly detail: string;
    readonly safeNextActions: readonly string[];
  };
}

/** The delegation handler — enforces non-expansion + SoD and commits the grant (FR-014). */
export type CreateDelegationHandler = (
  command: CreateDelegationCommand,
) => CreateDelegationResult | Promise<CreateDelegationResult>;

export interface DelegationRouteDeps {
  readonly create: CreateDelegationHandler;
}

// ===========================================================================
// 1. Problem responder + scope helpers.
// ===========================================================================

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REASON_TEXT_MIN = 3;
const REASON_TEXT_MAX = 4000;

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

function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

function principalOf(c: AppContext): string {
  return c.ctx?.principalId ?? 'unknown';
}

class BodyError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

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

// ===========================================================================
// 2. Wire mapping.
// ===========================================================================

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

/** Map a committed delegation to the contract `Delegation` — SCOPED disclosure only (AC3). */
function delegationToWire(d: DelegationView): GovernanceApiDelegation {
  return {
    id: String(d.id),
    tenant_id: String(d.tenantId),
    delegator_principal_id: String(d.delegatorPrincipalId),
    recipient_principal_id: String(d.recipientPrincipalId),
    authority_assignment_id: String(d.authorityAssignmentId),
    scope: { ...d.scope },
    actions: [...d.actions],
    reason: { code: d.reason.code, text: d.reason.text },
    valid_from: iso(d.validFrom),
    expires_at: iso(d.expiresAt),
    status: d.status,
  };
}

// ===========================================================================
// 3. Request-body validation (wire-shape only; expansion/SoD live in the service).
// ===========================================================================

interface ParsedDelegationRequest {
  readonly recipientPrincipalId: Uuid;
  readonly authorityAssignmentId: Uuid;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly actions: readonly string[];
  readonly reason: GovernanceApiReason;
  readonly validFrom: EpochMillis;
  readonly expiresAt: EpochMillis;
}

function parseDelegationRequest(raw: unknown): ParsedDelegationRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set([
    'recipient_principal_id',
    'authority_assignment_id',
    'scope',
    'actions',
    'reason',
    'valid_from',
    'expires_at',
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
  }

  const recipient = body['recipient_principal_id'];
  if (typeof recipient !== 'string' || !isUuid(recipient)) {
    throw new BodyError('invalid_recipient', 'recipient_principal_id must be a uuid.');
  }
  const assignment = body['authority_assignment_id'];
  if (typeof assignment !== 'string' || !isUuid(assignment)) {
    throw new BodyError('invalid_assignment', 'authority_assignment_id must be a uuid.');
  }
  const scope = body['scope'];
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new BodyError('invalid_scope', 'scope must be a JSON object.');
  }
  const actionsRaw = body['actions'];
  if (
    !Array.isArray(actionsRaw) ||
    actionsRaw.length < 1 ||
    !actionsRaw.every((a) => typeof a === 'string' && a.length > 0)
  ) {
    throw new BodyError('invalid_actions', 'actions must be a non-empty string array.');
  }
  const actions = [...new Set(actionsRaw as string[])];
  const reason = validateReason(body['reason']);

  const validFromRaw = body['valid_from'];
  if (typeof validFromRaw !== 'string' || Number.isNaN(Date.parse(validFromRaw))) {
    throw new BodyError('invalid_valid_from', 'valid_from must be an RFC3339 date-time.');
  }
  const expiresAtRaw = body['expires_at'];
  if (typeof expiresAtRaw !== 'string' || Number.isNaN(Date.parse(expiresAtRaw))) {
    throw new BodyError('invalid_expires_at', 'expires_at must be an RFC3339 date-time.');
  }
  const validFrom = Date.parse(validFromRaw) as EpochMillis;
  const expiresAt = Date.parse(expiresAtRaw) as EpochMillis;
  if (expiresAt <= validFrom) {
    throw new BodyError('invalid_window', 'expires_at must be strictly after valid_from.', 422);
  }

  return {
    recipientPrincipalId: recipient as Uuid,
    authorityAssignmentId: assignment as Uuid,
    scope: scope as Record<string, unknown>,
    actions,
    reason,
    validFrom,
    expiresAt,
  };
}

// ===========================================================================
// 4. Handler.
// ===========================================================================

/** POST /delegations — create a non-expanding delegation (FR-014); 201 with scoped disclosure. */
function createDelegation(deps: DelegationRouteDeps): RouteHandler {
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

    let parsed: ParsedDelegationRequest;
    try {
      parsed = parseDelegationRequest(raw);
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

    const correlationId = c.ctx?.correlationId ?? '';
    const idempotencyKey = c.req.header('idempotency-key');
    const command: CreateDelegationCommand = {
      tenantId,
      delegatorPrincipalId: principalOf(c),
      correlationId,
      recipientPrincipalId: parsed.recipientPrincipalId,
      authorityAssignmentId: parsed.authorityAssignmentId,
      scope: parsed.scope,
      actions: parsed.actions,
      reason: parsed.reason,
      validFrom: parsed.validFrom,
      expiresAt: parsed.expiresAt,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: CreateDelegationResult;
    try {
      result = await deps.create(command);
    } catch {
      return problem(
        c,
        500,
        'delegation_create_failed',
        'Delegation could not be created',
        'The delegation was not committed.',
        ['retry with the same idempotency key'],
      );
    }

    // Governed rejection (expansion, SoD conflict, expired/unknown assignment) — durable + audited.
    if (!result.accepted || result.delegation === undefined) {
      const rej = result.rejection ?? {
        code: 'delegation_rejected',
        httpStatus: 422,
        detail: 'The delegation was not granted.',
        safeNextActions: ['narrow the requested actions/scope to your own authority and retry'],
      };
      return problem(
        c,
        rej.httpStatus,
        rej.code,
        'Delegation rejected',
        rej.detail,
        rej.safeNextActions,
        String(result.auditEventId),
      );
    }

    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    return c.json(delegationToWire(result.delegation), 201);
  };
}

// ===========================================================================
// 5. Registration.
// ===========================================================================

/**
 * Mount the delegation route onto `app`. AUTHENTICATED (carries a tenant scope + audit identity).
 * Registered WITHOUT the version prefix — `App.post` prepends `API_PREFIX` (`/v1`), serving at
 * `/v1/delegations`.
 */
export function registerDelegationRoutes(app: App, deps: DelegationRouteDeps): App {
  app.post('/delegations', createDelegation(deps));
  return app;
}
