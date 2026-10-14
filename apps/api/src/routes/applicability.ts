// @trustcircle/api — APPLICABILITY DECISION ROUTES (Phase 7 / User Story 5 — Demonstrate Compliance
// and Audit Readiness / FR-031, FR-051, FR-052, SC-013).
//
// Mounts the two applicability operations from the OpenAPI contract
// (contracts/governance-control-plane/governance-api.openapi.yaml):
//
//   POST /v1/applicability-decisions                        → proposeApplicability → ApplicabilityDecision (201)
//   POST /v1/applicability-decisions/{applicabilityId}/actions → reviewApplicability → ApplicabilityDecision (200)
//
// The obligations this module enforces at the boundary (every one verifiable against the domain +
// application services and the contract checkers):
//
//   * INDEPENDENT REVIEW (FR-051). A proposal is only a PROPOSAL until an INDEPENDENT reviewer (never
//     the proposer, never the control owner) approves it; the route surfaces the reviewed decision as
//     a NEW superseding version — the proposer can never self-activate an applicability decision.
//   * MANDATORY REASON (FR-052). Every review action carries a structured `reason` {code, text}; a
//     missing/blank reason is a visible 422 governed rejection, never accepted.
//   * EVIDENCE-BACKED (FR-031). A proposal carries a non-empty evidence set; the wire validator refuses
//     an empty evidence array before the service is even consulted.
//   * OPTIMISTIC CONCURRENCY. A review action REQUIRES `If-Match` (the decision version the reviewer
//     bound to); a stale version is a governed rejection, so two reviewers cannot clobber each other.
//
// Pure request→response plumbing over INJECTED command handlers. It holds no mutable state, reads no
// wall clock (the command carries `now`), and re-implements no independence/SoD/state-machine logic:
// it validates the wire shape, then delegates to @trustcircle/application's applicability service.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiApplicabilityProposal,
  GovernanceApiApplicabilityDecision,
  GovernanceApiReason,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports — the route composes the applicability service; never builds it.
// ===========================================================================

/** An applicability decision as the injected surface hands it to the route (already tenant-authorized).
 *  Mirrors the contract `ApplicabilityDecision` plus the durable `version` for optimistic concurrency. */
export interface ApplicabilityDecisionView {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly clauseVersionId: Uuid;
  readonly systemId: Uuid;
  readonly jurisdiction: string;
  readonly useCase: Readonly<Record<string, unknown>>;
  readonly proposedResult: 'applicable' | 'partially_applicable' | 'not_applicable' | 'uncertain';
  readonly rationale: string;
  readonly evidenceIds: readonly Uuid[];
  readonly obligationOwnerPrincipalId?: Uuid | null;
  readonly effectiveFrom?: EpochMillis | null;
  readonly reviewAt: EpochMillis;
  readonly proposerPrincipalId: Uuid;
  readonly reviewerPrincipalId?: Uuid | null;
  readonly reviewDecision?: string | null;
  readonly status: string;
  readonly version: number;
}

/** The validated command a propose request carries to the injected handler. */
export interface ProposeApplicabilityCommand {
  readonly tenantId: TenantId;
  readonly proposerPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly proposal: GovernanceApiApplicabilityProposal;
}

export interface ProposeApplicabilityResult {
  readonly decision: ApplicabilityDecisionView;
  readonly idempotentReplay: boolean;
}

/** The propose handler — records an applicability PROPOSAL awaiting independent review (FR-051). */
export type ProposeApplicabilityHandler = (
  command: ProposeApplicabilityCommand,
) => ProposeApplicabilityResult | Promise<ProposeApplicabilityResult>;

/** The validated command a review action carries to the injected handler. */
export interface ReviewApplicabilityCommand {
  readonly tenantId: TenantId;
  readonly applicabilityId: Uuid;
  readonly reviewerPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly action: 'approve' | 'reject' | 'request_changes' | 'expire';
  readonly reason: { readonly code: string; readonly text: string };
  /** The decision version the reviewer bound to (decoded from `If-Match`); concurrency guard. */
  readonly expectedVersion?: number;
}

/** The outcome of a review action — accepted (new superseding version) or a governed rejection. */
export interface ReviewApplicabilityResult {
  readonly accepted: boolean;
  /** The current decision AFTER the action (the independent read-back the response body carries). */
  readonly decision: ApplicabilityDecisionView;
  readonly auditEventId: Uuid;
  readonly idempotentReplay: boolean;
  /** For a rejection: the machine code + safe next actions the Problem surfaces. */
  readonly rejection?: {
    readonly code: string;
    readonly httpStatus: number;
    readonly detail: string;
    readonly safeNextActions: readonly string[];
  };
}

/** The review handler — evaluates independence/SoD/reason/concurrency and commits the outcome. */
export type ReviewApplicabilityHandler = (
  command: ReviewApplicabilityCommand,
) => ReviewApplicabilityResult | Promise<ReviewApplicabilityResult>;

export interface ApplicabilityRouteDeps {
  readonly propose: ProposeApplicabilityHandler;
  readonly review: ReviewApplicabilityHandler;
}

// ===========================================================================
// 1. Contract vocabularies + a disclosure-safe Problem responder.
// ===========================================================================

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REASON_TEXT_MIN = 3;
const REASON_TEXT_MAX = 4000;

const PROPOSED_RESULTS: ReadonlySet<string> = new Set([
  'applicable',
  'partially_applicable',
  'not_applicable',
  'uncertain',
]);

const REVIEW_ACTIONS: ReadonlySet<string> = new Set([
  'approve',
  'reject',
  'request_changes',
  'expire',
]);

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

/** The authenticated principal (the accountable actor). */
function principalOf(c: AppContext): string {
  return c.ctx?.principalId ?? 'unknown';
}

// ===========================================================================
// 2. ETag — a strong validator over the CURRENT decision version.
// ===========================================================================

/** Build the strong ETag for a decision's current state (version). */
export function decisionEtag(d: ApplicabilityDecisionView): string {
  return `"ad-${d.version}"`;
}

/** Parse an `If-Match` header into the version it asserts, or null when unparseable. */
function parseIfMatch(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^"ad-(\d+)"$/.exec(value.trim());
  if (!m) return null;
  const version = Number(m[1]);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

// ===========================================================================
// 3. Time + wire mappers.
// ===========================================================================

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

/** Map a decision view to the contract `ApplicabilityDecision` wire shape. */
function decisionToWire(d: ApplicabilityDecisionView): GovernanceApiApplicabilityDecision {
  const base: GovernanceApiApplicabilityDecision = {
    id: String(d.id),
    tenant_id: String(d.tenantId),
    clause_version_id: String(d.clauseVersionId),
    system_id: String(d.systemId),
    jurisdiction: d.jurisdiction,
    use_case: { ...d.useCase },
    proposed_result: d.proposedResult,
    rationale: d.rationale,
    evidence_ids: d.evidenceIds.map((e) => String(e)),
    review_at: iso(d.reviewAt),
    proposer_principal_id: String(d.proposerPrincipalId),
    status: d.status,
    version: d.version,
  };
  const withOwner =
    d.obligationOwnerPrincipalId !== undefined && d.obligationOwnerPrincipalId !== null
      ? { ...base, obligation_owner_principal_id: String(d.obligationOwnerPrincipalId) }
      : base;
  const withEffective =
    d.effectiveFrom !== undefined && d.effectiveFrom !== null
      ? { ...withOwner, effective_from: iso(d.effectiveFrom) }
      : withOwner;
  const withReviewer =
    d.reviewerPrincipalId !== undefined && d.reviewerPrincipalId !== null
      ? { ...withEffective, reviewer_principal_id: String(d.reviewerPrincipalId) }
      : withEffective;
  return d.reviewDecision !== undefined && d.reviewDecision !== null
    ? { ...withReviewer, review_decision: d.reviewDecision }
    : withReviewer;
}

// ===========================================================================
// 4. Request-body validation (wire-shape only; domain rules live in the service).
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

function validateReason(raw: unknown): GovernanceApiReason {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('missing_reason', 'A structured reason {code, text} is required.', 422);
  }
  const rec = raw as Record<string, unknown>;
  const code = rec['code'];
  const text = rec['text'];
  if (typeof code !== 'string' || !REASON_CODE_RE.test(code)) {
    throw new BodyError(
      'invalid_reason',
      'reason.code must match /^[a-z][a-z0-9_.-]{1,63}$/.',
      422,
    );
  }
  if (
    typeof text !== 'string' ||
    text.trim().length < REASON_TEXT_MIN ||
    text.length > REASON_TEXT_MAX
  ) {
    throw new BodyError(
      'invalid_reason',
      `reason.text must be ${REASON_TEXT_MIN}..${REASON_TEXT_MAX} non-blank characters.`,
      422,
    );
  }
  return { code, text };
}

/** Validate + normalize an ApplicabilityProposal body (contract `additionalProperties:false`). */
function parseProposal(raw: unknown): GovernanceApiApplicabilityProposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set([
    'clause_version_id',
    'system_id',
    'jurisdiction',
    'use_case',
    'proposed_result',
    'rationale',
    'evidence_ids',
    'obligation_owner_principal_id',
    'effective_from',
    'review_at',
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
  }

  const clauseVersionId = body['clause_version_id'];
  if (typeof clauseVersionId !== 'string' || !isUuid(clauseVersionId)) {
    throw new BodyError('invalid_clause_version', 'clause_version_id must be a uuid.');
  }
  const systemId = body['system_id'];
  if (typeof systemId !== 'string' || !isUuid(systemId)) {
    throw new BodyError('invalid_system', 'system_id must be a uuid.');
  }
  const jurisdiction = body['jurisdiction'];
  if (typeof jurisdiction !== 'string' || jurisdiction.length === 0) {
    throw new BodyError('invalid_jurisdiction', 'jurisdiction must be a non-empty string.');
  }
  const useCase = body['use_case'];
  if (typeof useCase !== 'object' || useCase === null || Array.isArray(useCase)) {
    throw new BodyError('invalid_use_case', 'use_case must be a JSON object.');
  }
  const proposedResult = body['proposed_result'];
  if (typeof proposedResult !== 'string' || !PROPOSED_RESULTS.has(proposedResult)) {
    throw new BodyError(
      'invalid_proposed_result',
      'proposed_result must be one of applicable, partially_applicable, not_applicable, uncertain.',
    );
  }
  const rationale = body['rationale'];
  if (typeof rationale !== 'string' || rationale.trim().length < 3) {
    throw new BodyError('invalid_rationale', 'rationale must be at least 3 characters.');
  }
  const evidenceIds = body['evidence_ids'];
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length < 1 ||
    !evidenceIds.every((e) => typeof e === 'string' && isUuid(e))
  ) {
    throw new BodyError('invalid_evidence', 'evidence_ids must be a non-empty uuid array.', 422);
  }
  const reviewAt = body['review_at'];
  if (typeof reviewAt !== 'string' || Number.isNaN(Date.parse(reviewAt))) {
    throw new BodyError('invalid_review_at', 'review_at must be an RFC3339 date-time.');
  }

  const out: GovernanceApiApplicabilityProposal = {
    clause_version_id: clauseVersionId,
    system_id: systemId,
    jurisdiction,
    use_case: useCase as Record<string, unknown>,
    proposed_result: proposedResult as GovernanceApiApplicabilityProposal['proposed_result'],
    rationale,
    evidence_ids: [...new Set(evidenceIds as string[])],
    review_at: reviewAt,
  };

  const owner = body['obligation_owner_principal_id'];
  const withOwner =
    owner === undefined
      ? out
      : owner === null
        ? { ...out, obligation_owner_principal_id: null }
        : typeof owner === 'string' && isUuid(owner)
          ? { ...out, obligation_owner_principal_id: owner }
          : (() => {
              throw new BodyError(
                'invalid_owner',
                'obligation_owner_principal_id must be a uuid or null.',
              );
            })();
  const eff = body['effective_from'];
  if (eff === undefined) return withOwner;
  if (eff === null) return { ...withOwner, effective_from: null };
  if (typeof eff !== 'string' || Number.isNaN(Date.parse(eff))) {
    throw new BodyError(
      'invalid_effective_from',
      'effective_from must be an RFC3339 date-time or null.',
    );
  }
  return { ...withOwner, effective_from: eff };
}

// ===========================================================================
// 5. Handlers.
// ===========================================================================

/** POST /applicability-decisions — record a proposal awaiting independent review (FR-051); 201 + ETag. */
function proposeApplicability(deps: ApplicabilityRouteDeps): RouteHandler {
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

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }

    let proposal: GovernanceApiApplicabilityProposal;
    try {
      proposal = parseProposal(raw);
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
    const command: ProposeApplicabilityCommand = {
      tenantId,
      proposerPrincipalId: principalOf(c),
      correlationId,
      proposal,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: ProposeApplicabilityResult;
    try {
      result = await deps.propose(command);
    } catch {
      return problem(
        c,
        500,
        'applicability_propose_failed',
        'Applicability proposal could not be recorded',
        'The applicability proposal was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    c.setHeader('etag', decisionEtag(result.decision));
    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    return c.json(decisionToWire(result.decision), 201);
  };
}

/** POST /applicability-decisions/{applicabilityId}/actions — independently review a proposal (FR-051/052). */
function reviewApplicability(deps: ApplicabilityRouteDeps): RouteHandler {
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
    const applicabilityId = applicabilityIdOf(c);
    if (applicabilityId === undefined) {
      return problem(
        c,
        400,
        'invalid_applicability_id',
        'Bad Request',
        'The applicability id path segment must be a uuid.',
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return problem(
        c,
        400,
        'invalid_body',
        'Bad Request',
        'The request body must be a JSON object.',
      );
    }
    const body = raw as Record<string, unknown>;
    for (const k of Object.keys(body)) {
      if (!['action', 'reason'].includes(k)) {
        return problem(c, 400, 'unexpected_field', 'Bad Request', `Unexpected field: ${k}`);
      }
    }

    const action = body['action'];
    if (typeof action !== 'string' || !REVIEW_ACTIONS.has(action)) {
      return problem(
        c,
        400,
        'invalid_action',
        'Bad Request',
        'action must be one of approve, reject, request_changes, expire.',
      );
    }

    let reason: GovernanceApiReason;
    try {
      reason = validateReason(body['reason']);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(c, e.httpStatus, e.code, 'Unprocessable', e.message, [
          'supply a structured reason {code, text} justifying this review action',
        ]);
      }
      throw e;
    }

    const ifMatch = parseIfMatch(c.req.header('if-match'));
    const correlationId = c.ctx?.correlationId ?? '';
    const idempotencyKey = c.req.header('idempotency-key');
    const command: ReviewApplicabilityCommand = {
      tenantId,
      applicabilityId,
      reviewerPrincipalId: principalOf(c),
      correlationId,
      action: action as ReviewApplicabilityCommand['action'],
      reason,
      ...(ifMatch !== null ? { expectedVersion: ifMatch } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: ReviewApplicabilityResult;
    try {
      result = await deps.review(command);
    } catch {
      return problem(
        c,
        500,
        'applicability_review_failed',
        'Applicability review could not be applied',
        'The review action was not committed.',
        ['retry with the same idempotency key'],
      );
    }

    if (!result.accepted && result.rejection !== undefined) {
      c.setHeader('etag', decisionEtag(result.decision));
      return problem(
        c,
        result.rejection.httpStatus,
        result.rejection.code,
        'Applicability review rejected',
        result.rejection.detail,
        result.rejection.safeNextActions,
        String(result.auditEventId),
      );
    }

    c.setHeader('etag', decisionEtag(result.decision));
    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    return c.json(decisionToWire(result.decision), 200);
  };
}

// ===========================================================================
// 6. Small shared helpers.
// ===========================================================================

function applicabilityIdOf(c: AppContext): Uuid | undefined {
  const id = c.req.param('applicabilityId');
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
}

// ===========================================================================
// 7. Registration.
// ===========================================================================

/**
 * Mount the two applicability routes onto `app`. Both are AUTHENTICATED (they carry a tenant scope +
 * audit identity). Paths are registered WITHOUT the version prefix — `App.post` prepends `API_PREFIX`
 * (`/v1`), so they serve at `/v1/applicability-decisions...`.
 */
export function registerApplicabilityRoutes(app: App, deps: ApplicabilityRouteDeps): App {
  app.post('/applicability-decisions', proposeApplicability(deps));
  app.post('/applicability-decisions/:applicabilityId/actions', reviewApplicability(deps));
  return app;
}
