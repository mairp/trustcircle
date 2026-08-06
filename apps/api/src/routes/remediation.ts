// @trustcircle/api — REMEDIATION + VERIFICATION COMMAND ROUTES (Phase 5 / User Story 3 /
// FR-019, FR-020, FR-021, FR-022, GAR-004, SC-007, SC-008, SC-009).
//
// Mounts the two STATE-CHANGING operations of the containment/repair surface from the OpenAPI
// contract (specs/001-governance-control-plane/contracts/governance-api.openapi.yaml) onto the
// dependency-free Hono-compatible `App` from ../server.ts:
//
//   POST /v1/integrity-cases/{caseId}/remediations → proposeOrExecuteRemediation → OperationAccepted
//        (202) — the RemediationCommand's `mode` selects recommend_only | simulate | request_approval
//        | execute_if_pre_authorized. Only the last mode may EXECUTE, and only for a pre-authorized,
//        low-risk, NON-destructive plan (GAR-004); anything else is a governed rejection, never a
//        silent destructive change.
//   POST /v1/integrity-cases/{caseId}/verification → verifyIntegrityCase → VerificationRecord
//        (200) — an INDEPENDENT nine-gate verification. A `failed`/`indeterminate` record is a valid
//        response that does NOT close the case (FR-022): closure is never a source-reported `done`.
//
// The obligations this module enforces at the boundary (each verifiable against the integrity-api
// contract checkers in @trustcircle/contracts):
//
//   * MANDATORY REASON (FR-019). Every command carries a structured `reason` {code, text}; a
//     missing/blank reason is a 422 governed rejection.
//   * If-Match OPTIMISTIC CONCURRENCY (SC-009). Both commands REQUIRE `If-Match` (the current case
//     ETag): the actor binds to the exact case they saw; a stale/mismatched If-Match is a 412.
//   * IDEMPOTENCY (FR-020). Both commands carry `Idempotency-Key`; a replay returns the SAME
//     committed outcome (never a second repair/verification), surfaced with a replay marker. This is
//     the wire face of the repair executor's single idempotency identity.
//   * PRE-AUTHORIZED-ONLY EXECUTION (GAR-004). An `execute_if_pre_authorized` request the automatic
//     -repair policy DENIES (destructive / unapproved / expired / out-of-scope / kill-switch) is a
//     governed rejection carrying an `audit_event_id` + safe next actions + the machine deny reason —
//     a durable, explained refusal, never an executed change.
//   * VERIFIED-CLOSURE HONESTY (FR-022). The verification handler returns the INDEPENDENT record as-is
//     — the route never upgrades a `failed` record to closure. The domain oracle owns the semantics.
//
// The module is pure request→response plumbing over INJECTED command handlers (a remediation handler
// and a verification handler resolved by the composition root). It holds no mutable state, reads no
// wall clock (the command carries `now`), re-implements no policy/authority logic, and assembles every
// response body from the handler's returned outcome — the handler owns the governed effect.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiRemediationCommand,
  GovernanceApiOperationAccepted,
  GovernanceApiVerificationRecord,
  GovernanceApiReason,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports.
// ===========================================================================

/** The remediation modes the contract permits (GAR-004's alphabet). Only the last may execute. */
export const REMEDIATION_MODES = [
  'recommend_only',
  'simulate',
  'request_approval',
  'execute_if_pre_authorized',
] as const;
export type RemediationMode = (typeof REMEDIATION_MODES)[number];

/** The structured, validated command a remediation request carries to the injected handler. */
export interface RemediationCommandInput {
  readonly tenantId: TenantId;
  readonly caseId: Uuid;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly mode: RemediationMode;
  readonly reason: { readonly code: string; readonly text: string };
  /** The proposed remediation plan (opaque object graph validated against the contract schema). */
  readonly plan: GovernanceApiRemediationCommand['plan'];
  /** The case version the actor bound to (decoded from `If-Match`); optimistic-concurrency guard. */
  readonly expectedVersion: number;
}

/** The structured, validated command a verification request carries to the injected handler. */
export interface VerificationCommandInput {
  readonly tenantId: TenantId;
  readonly caseId: Uuid;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly evidenceManifestId: Uuid;
  readonly expectedState: Readonly<Record<string, unknown>>;
  readonly reconciliationRunId?: Uuid;
  readonly residualRiskExceptionId?: Uuid | null;
  readonly expectedVersion: number;
}

/** The outcome of a remediation command — an accepted async operation OR a governed rejection. */
export interface RemediationOutcome {
  readonly accepted: boolean;
  /** The async operation id + audit id for an accepted command (202 OperationAccepted). */
  readonly operationId: Uuid;
  readonly auditEventId: Uuid;
  readonly idempotentReplay: boolean;
  /** The current case version AFTER the command (for the ETag the caller re-binds to). */
  readonly caseVersion: number;
  readonly caseDigest: string;
  /** For a rejection (GAR-004 deny / stale version / not-authorized): the Problem detail. */
  readonly rejection?: {
    readonly code: string;
    readonly httpStatus: number;
    readonly detail: string;
    readonly safeNextActions: readonly string[];
  };
}

/** The outcome of a verification command — the INDEPENDENT nine-gate record (may be failed). */
export interface VerificationOutcome {
  readonly record: {
    readonly id: Uuid;
    readonly verifierPrincipalId: Uuid;
    readonly evidenceManifestId: Uuid;
    readonly result: 'passed' | 'failed' | 'indeterminate';
    readonly gateResults: readonly {
      readonly gate: string;
      readonly result: 'passed' | 'failed' | 'indeterminate';
      readonly detail?: string;
    }[];
    readonly verifiedAt: EpochMillis;
  };
  readonly auditEventId: Uuid;
  readonly idempotentReplay: boolean;
  readonly caseVersion: number;
  readonly caseDigest: string;
  /** A verification command may be REFUSED before it runs (stale version / not-authorized). */
  readonly rejection?: {
    readonly code: string;
    readonly httpStatus: number;
    readonly detail: string;
    readonly safeNextActions: readonly string[];
  };
}

export type RemediationHandler = (
  command: RemediationCommandInput,
) => RemediationOutcome | Promise<RemediationOutcome>;

export type VerificationHandler = (
  command: VerificationCommandInput,
) => VerificationOutcome | Promise<VerificationOutcome>;

export interface RemediationRouteDeps {
  readonly remediate: RemediationHandler;
  readonly verify: VerificationHandler;
}

// ===========================================================================
// 1. Constants + Problem responder.
// ===========================================================================

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REASON_TEXT_MIN = 3;
const REASON_TEXT_MAX = 4000;

const REMEDIATION_MODE_SET: ReadonlySet<string> = new Set(REMEDIATION_MODES);

/** The seven plan sub-objects the contract's RemediationCommand.plan requires. */
const PLAN_REQUIRED_KEYS = [
  'proposed_change',
  'expected_result',
  'preconditions',
  'stop_conditions',
  'rollback_plan',
  'verification_plan',
  'evidence_plan',
] as const;

/** Emit an RFC-9457-shaped Problem. When `auditEventId` is supplied it is a GOVERNED rejection
 *  (FR-022): the refusal is durable + attributable. */
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

function caseIdOf(c: AppContext): Uuid | undefined {
  const id = c.req.param('caseId');
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
}

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

// ===========================================================================
// 2. ETag over the current case (shared shape with integrity-cases.ts).
// ===========================================================================

/** Build the strong ETag for a case's current state (digest + version). SC-009. */
export function caseEtag(version: number, caseDigest: string): string {
  return `"ic-${version}-${caseDigest}"`;
}

/** Parse an `If-Match` header into the version + digest it asserts, or null when unparseable. */
function parseIfMatch(value: string | undefined): { version: number; digest: string } | null {
  if (value === undefined) return null;
  const m = /^"ic-(\d+)-([0-9a-f]+)"$/.exec(value.trim());
  if (!m) return null;
  const version = Number(m[1]);
  if (!Number.isInteger(version) || version < 1) return null;
  return { version, digest: m[2] ?? '' };
}

// ===========================================================================
// 3. Body validation (wire-shape only; policy/authority live in the handler).
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

/** Validate the structured reason (FR-019). A missing/blank reason is a 422 rejection. */
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

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_field', `${field} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function asObjectArray(raw: unknown, field: string): Record<string, unknown>[] {
  if (
    !Array.isArray(raw) ||
    raw.some((x) => typeof x !== 'object' || x === null || Array.isArray(x))
  ) {
    throw new BodyError('invalid_field', `${field} must be an array of objects.`);
  }
  return raw as Record<string, unknown>[];
}

/** Validate + normalize a RemediationCommand body (contract mode enum + the seven plan sub-objects). */
function parseRemediationCommand(raw: unknown): {
  mode: RemediationMode;
  reason: GovernanceApiReason;
  plan: GovernanceApiRemediationCommand['plan'];
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!['mode', 'reason', 'plan'].includes(k)) {
      throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
    }
  }
  const mode = body['mode'];
  if (typeof mode !== 'string' || !REMEDIATION_MODE_SET.has(mode)) {
    throw new BodyError('invalid_mode', `mode must be one of ${REMEDIATION_MODES.join(', ')}.`);
  }
  const reason = validateReason(body['reason']);
  const planRaw = asObject(body['plan'], 'plan');
  for (const key of PLAN_REQUIRED_KEYS) {
    if (!(key in planRaw)) throw new BodyError('invalid_plan', `plan.${key} is required.`);
  }
  const plan: GovernanceApiRemediationCommand['plan'] = {
    proposed_change: asObject(planRaw['proposed_change'], 'plan.proposed_change'),
    expected_result: asObject(planRaw['expected_result'], 'plan.expected_result'),
    preconditions: asObjectArray(planRaw['preconditions'], 'plan.preconditions'),
    stop_conditions: asObjectArray(planRaw['stop_conditions'], 'plan.stop_conditions'),
    rollback_plan: asObject(planRaw['rollback_plan'], 'plan.rollback_plan'),
    verification_plan: asObject(planRaw['verification_plan'], 'plan.verification_plan'),
    evidence_plan: asObject(planRaw['evidence_plan'], 'plan.evidence_plan'),
  };
  return { mode: mode as RemediationMode, reason, plan };
}

/** Validate + normalize a VerificationCommand body. */
function parseVerificationCommand(raw: unknown): {
  reason: GovernanceApiReason;
  evidenceManifestId: Uuid;
  expectedState: Record<string, unknown>;
  reconciliationRunId?: Uuid;
  residualRiskExceptionId?: Uuid | null;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowed = new Set([
    'reason',
    'evidence_manifest_id',
    'expected_state',
    'reconciliation_run_id',
    'residual_risk_exception_id',
  ]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
  }
  const reason = validateReason(body['reason']);
  const em = body['evidence_manifest_id'];
  if (typeof em !== 'string' || !isUuid(em)) {
    throw new BodyError('invalid_evidence_manifest', 'evidence_manifest_id must be a uuid.');
  }
  const expectedState = asObject(body['expected_state'], 'expected_state');

  const out: {
    reason: GovernanceApiReason;
    evidenceManifestId: Uuid;
    expectedState: Record<string, unknown>;
    reconciliationRunId?: Uuid;
    residualRiskExceptionId?: Uuid | null;
  } = { reason, evidenceManifestId: em as Uuid, expectedState };

  const rr = body['reconciliation_run_id'];
  if (rr !== undefined) {
    if (typeof rr !== 'string' || !isUuid(rr)) {
      throw new BodyError('invalid_reconciliation_run', 'reconciliation_run_id must be a uuid.');
    }
    out.reconciliationRunId = rr as Uuid;
  }
  const rx = body['residual_risk_exception_id'];
  if (rx !== undefined) {
    if (rx === null) out.residualRiskExceptionId = null;
    else if (typeof rx === 'string' && isUuid(rx)) out.residualRiskExceptionId = rx as Uuid;
    else {
      throw new BodyError(
        'invalid_residual_risk',
        'residual_risk_exception_id must be a uuid or null.',
      );
    }
  }
  return out;
}

// ===========================================================================
// 4. Shared protocol preamble — tenant + case + If-Match + Idempotency-Key.
// ===========================================================================

interface CommandContext {
  readonly tenantId: TenantId;
  readonly caseId: Uuid;
  readonly ifMatch: { version: number; digest: string };
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/** Resolve the shared state-changing preamble, or a Problem Response when any precondition is unmet. */
function commandPreamble(c: AppContext): CommandContext | Response {
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
  const ifMatch = parseIfMatch(c.req.header('if-match'));
  if (ifMatch === null) {
    return problem(
      c,
      428,
      'if_match_required',
      'Precondition Required',
      'A valid If-Match header (the current case ETag) is required to act on an integrity case.',
      ['GET the case to read its current ETag, then retry with If-Match'],
    );
  }
  const idempotencyKey = c.req.header('idempotency-key');
  if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
    return problem(
      c,
      400,
      'idempotency_key_required',
      'Bad Request',
      'An Idempotency-Key header is required on a state-changing integrity command (FR-020).',
    );
  }
  return {
    tenantId,
    caseId,
    ifMatch,
    idempotencyKey,
    correlationId: c.ctx?.correlationId ?? '',
  };
}

async function readJsonObject(c: AppContext): Promise<unknown | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
  }
  return raw;
}

function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

// ===========================================================================
// 5. Handlers.
// ===========================================================================

/** POST /integrity-cases/{caseId}/remediations — propose / simulate / request-approval / execute
 *  (GAR-004). Only `execute_if_pre_authorized` may run, and only for a pre-authorized low-risk plan;
 *  a deny is a governed rejection. 202 OperationAccepted on acceptance. */
function proposeOrExecuteRemediation(deps: RemediationRouteDeps): RouteHandler {
  return async (c) => {
    const pre = commandPreamble(c);
    if (isResponse(pre)) return pre;

    const raw = await readJsonObject(c);
    if (isResponse(raw)) return raw;

    let parsed: ReturnType<typeof parseRemediationCommand>;
    try {
      parsed = parseRemediationCommand(raw);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(
          c,
          e.httpStatus,
          e.code,
          e.httpStatus === 422 ? 'Unprocessable' : 'Bad Request',
          e.message,
          e.httpStatus === 422
            ? ['supply a structured reason {code, text} justifying this remediation']
            : [],
        );
      }
      throw e;
    }

    const command: RemediationCommandInput = {
      tenantId: pre.tenantId,
      caseId: pre.caseId,
      actorPrincipalId: principalOf(c),
      correlationId: pre.correlationId,
      idempotencyKey: pre.idempotencyKey,
      mode: parsed.mode,
      reason: parsed.reason,
      plan: parsed.plan,
      expectedVersion: pre.ifMatch.version,
    };

    let outcome: RemediationOutcome;
    try {
      outcome = await deps.remediate(command);
    } catch {
      return problem(
        c,
        500,
        'remediation_failed',
        'Remediation could not be processed',
        'The remediation command was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    // Optimistic concurrency: a stale If-Match (another reviewer advanced the case) → 412.
    if (!outcome.accepted && outcome.rejection?.code === 'stale_version') {
      c.setHeader('etag', caseEtag(outcome.caseVersion, outcome.caseDigest));
      return problem(
        c,
        412,
        'precondition_failed',
        'Precondition Failed',
        'The integrity case changed since you last read it; re-read and retry.',
        ['GET the case to read its current ETag, then retry with If-Match'],
        String(outcome.auditEventId),
      );
    }

    // A governed rejection (GAR-004 deny: destructive / unapproved / expired / out-of-scope /
    // kill-switch, or not-authorized) — a durable, explained Problem with its audit event.
    if (!outcome.accepted && outcome.rejection !== undefined) {
      c.setHeader('etag', caseEtag(outcome.caseVersion, outcome.caseDigest));
      return problem(
        c,
        outcome.rejection.httpStatus,
        outcome.rejection.code,
        'Remediation rejected',
        outcome.rejection.detail,
        outcome.rejection.safeNextActions,
        String(outcome.auditEventId),
      );
    }

    // Accepted — an async governed operation (202 OperationAccepted). ETag over the CURRENT case.
    c.setHeader('etag', caseEtag(outcome.caseVersion, outcome.caseDigest));
    if (outcome.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    const body: GovernanceApiOperationAccepted = {
      operation_id: String(outcome.operationId),
      status: 'accepted',
      audit_event_id: String(outcome.auditEventId),
      correlation_id: pre.correlationId,
      ...(outcome.idempotentReplay ? { idempotent_replay: true } : {}),
    };
    return c.json(body, 202);
  };
}

/** POST /integrity-cases/{caseId}/verification — independent nine-gate verification (FR-022). A
 *  `failed`/`indeterminate` record is a valid 200 that does NOT close the case. */
function verifyIntegrityCase(deps: RemediationRouteDeps): RouteHandler {
  return async (c) => {
    const pre = commandPreamble(c);
    if (isResponse(pre)) return pre;

    const raw = await readJsonObject(c);
    if (isResponse(raw)) return raw;

    let parsed: ReturnType<typeof parseVerificationCommand>;
    try {
      parsed = parseVerificationCommand(raw);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(
          c,
          e.httpStatus,
          e.code,
          e.httpStatus === 422 ? 'Unprocessable' : 'Bad Request',
          e.message,
          e.httpStatus === 422
            ? ['supply a structured reason {code, text} justifying this verification']
            : [],
        );
      }
      throw e;
    }

    const command: VerificationCommandInput = {
      tenantId: pre.tenantId,
      caseId: pre.caseId,
      actorPrincipalId: principalOf(c),
      correlationId: pre.correlationId,
      idempotencyKey: pre.idempotencyKey,
      reason: parsed.reason,
      evidenceManifestId: parsed.evidenceManifestId,
      expectedState: parsed.expectedState,
      expectedVersion: pre.ifMatch.version,
      ...(parsed.reconciliationRunId !== undefined
        ? { reconciliationRunId: parsed.reconciliationRunId }
        : {}),
      ...(parsed.residualRiskExceptionId !== undefined
        ? { residualRiskExceptionId: parsed.residualRiskExceptionId }
        : {}),
    };

    let outcome: VerificationOutcome;
    try {
      outcome = await deps.verify(command);
    } catch {
      return problem(
        c,
        500,
        'verification_failed_internal',
        'Verification could not be processed',
        'The verification command was not completed.',
        ['retry with the same idempotency key'],
      );
    }

    if (outcome.rejection?.code === 'stale_version') {
      c.setHeader('etag', caseEtag(outcome.caseVersion, outcome.caseDigest));
      return problem(
        c,
        412,
        'precondition_failed',
        'Precondition Failed',
        'The integrity case changed since you last read it; re-read and retry.',
        ['GET the case to read its current ETag, then retry with If-Match'],
        String(outcome.auditEventId),
      );
    }
    if (outcome.rejection !== undefined) {
      c.setHeader('etag', caseEtag(outcome.caseVersion, outcome.caseDigest));
      return problem(
        c,
        outcome.rejection.httpStatus,
        outcome.rejection.code,
        'Verification rejected',
        outcome.rejection.detail,
        outcome.rejection.safeNextActions,
        String(outcome.auditEventId),
      );
    }

    // The independent record is returned AS-IS — a `failed`/`indeterminate` result is honest, not a
    // closure (FR-022). ETag over the CURRENT case the caller re-binds to.
    c.setHeader('etag', caseEtag(outcome.caseVersion, outcome.caseDigest));
    if (outcome.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    const rec = outcome.record;
    const body: GovernanceApiVerificationRecord = {
      id: String(rec.id),
      verifier_principal_id: String(rec.verifierPrincipalId),
      evidence_manifest_id: String(rec.evidenceManifestId),
      result: rec.result,
      gate_results: rec.gateResults.map((g) =>
        g.detail !== undefined
          ? { gate: g.gate, result: g.result, detail: g.detail }
          : { gate: g.gate, result: g.result },
      ),
      verified_at: iso(rec.verifiedAt),
    };
    return c.json(body, 200);
  };
}

// ===========================================================================
// 6. Registration.
// ===========================================================================

/**
 * Mount the two state-changing integrity command routes onto `app`. Both are AUTHENTICATED and
 * require `If-Match` + `Idempotency-Key`. Paths are registered WITHOUT the version prefix — `App.post`
 * prepends `API_PREFIX` (`/v1`), so they serve at `/v1/integrity-cases/{caseId}/...`.
 */
export function registerRemediationRoutes(app: App, deps: RemediationRouteDeps): App {
  app.post('/integrity-cases/:caseId/remediations', proposeOrExecuteRemediation(deps));
  app.post('/integrity-cases/:caseId/verification', verifyIntegrityCase(deps));
  return app;
}
