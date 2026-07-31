// @trustcircle/api — authenticated tenant context, CSRF protection, correlation IDs, and
// disclosure-safe error middleware (T041 / GAR-003 / VO-e4323651ab39776dcdbd).
//
// Oracle (VO-e4323651ab39776dcdbd): Request, review, approval, execution, evidence
// administration, control ownership, and assurance MUST be separated where conflicts
// exist; platform administration alone MUST NOT grant decision authority, and the
// independent central reviewer for a cross-tenant action MUST NOT hold an incompatible
// action role.
//
// This middleware establishes the authenticated *request context* that every downstream
// authorization decision (the SoD guard in packages/authz/src/separation-of-duties.ts)
// depends on. It enforces, at the HTTP boundary:
//
//   1. Authenticated tenant context — a request with no valid identity/tenant is rejected
//      fail-closed BEFORE any handler runs; platform-admin-only principals are marked as
//      carrying NO decision authority so the SoD layer cannot be tricked into treating a
//      platform administrator as a decision-maker (GAR-003: "platform administration alone
//      MUST NOT grant decision authority").
//   2. CSRF protection — browser-originated *mutations* (POST/PUT/PATCH/DELETE) require a
//      double-submit token whose header value matches the bound session cookie, so a review
//      or approval cannot be forged cross-site.
//   3. Correlation IDs — every request is stamped with a stable, syntactically-validated
//      correlation id (and a per-request causation id) so request → review → approval →
//      execution can be traced as separated steps across services.
//   4. Disclosure-safe errors — rejections return a stable machine code + correlation id and
//      NEVER leak identity, tenant, token, stack, or internal detail to the caller.
//
// The module is dependency-free (only Node built-in `crypto`) so it is independently
// observable and testable under `npm ci` with no adjacent infrastructure, and compiles under
// the strict shared base (tsconfig.base.json) as a `composite` project.

import { randomUUID, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Framework-agnostic request/response shapes. A thin adapter maps Hono/Fetch
// `Request` onto these; keeping the core pure makes every branch unit-testable.
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Methods that mutate state and therefore require CSRF protection for browser callers. */
export const MUTATING_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/** A minimal, read-only view of an inbound HTTP request. */
export interface RequestLike {
  readonly method: HttpMethod;
  readonly path: string;
  /** Header names are compared case-insensitively via {@link header}. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Parsed cookies (name → value). */
  readonly cookies?: Readonly<Record<string, string | undefined>>;
}

/** Case-insensitive header lookup. Returns `undefined` when absent or blank. */
export function header(req: RequestLike, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === target) {
      return v && v.trim().length > 0 ? v : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Verified identity → tenant context.
// ---------------------------------------------------------------------------

/**
 * Roles surfaced onto the request context. Mirrors the authz role table; the only concern of
 * this middleware is whether a role carries *any* decision authority at the HTTP boundary.
 */
export type ContextRole =
  | 'governance_officer'
  | 'control_owner'
  | 'auditor'
  | 'operator'
  | 'authorized_approver'
  | 'central_governance_reviewer'
  | 'tenant_compliance_owner'
  | 'independent_compliance_reviewer'
  | 'source_steward'
  | 'platform_admin'
  | 'automation_principal';

/** Roles that grant NO governance decision authority on their own (GAR-003). */
export const NON_DECISION_CONTEXT_ROLES: ReadonlySet<ContextRole> = new Set<ContextRole>([
  'platform_admin',
  'auditor',
  'automation_principal',
]);

/**
 * The result of validating a bearer/session token. In production this is produced by the OIDC
 * validator (packages/authz/src/oidc.ts, T039) or the workload-identity validator (T040); the
 * middleware only consumes a *verified* claim set and never trusts unverified header values.
 */
export interface VerifiedIdentity {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly ContextRole[];
  /** Bound CSRF session secret (the cookie counterpart of the double-submit token). */
  readonly csrfSessionToken?: string;
  /** True when the token was minted for a browser session (cookie-bearing, CSRF-eligible). */
  readonly isBrowserSession: boolean;
}

/**
 * A token verifier. MUST return `null` for any absent, malformed, expired, or otherwise
 * untrusted credential — the middleware fails closed on `null`.
 */
export type IdentityVerifier = (req: RequestLike) => VerifiedIdentity | null;

/**
 * The authenticated context attached to a request once it passes the middleware. Downstream
 * authorization (SoD) reads `hasDecisionAuthority` to honour "platform administration alone
 * grants no decision authority".
 */
export interface RequestContext {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly ContextRole[];
  /** False iff the principal holds ONLY non-decision roles (platform_admin/auditor/automation). */
  readonly hasDecisionAuthority: boolean;
  readonly correlationId: string;
  readonly causationId: string;
}

/** True iff at least one held role carries decision authority. */
export function hasDecisionAuthority(roles: readonly ContextRole[]): boolean {
  return roles.some((r) => !NON_DECISION_CONTEXT_ROLES.has(r));
}

// ---------------------------------------------------------------------------
// Correlation / causation IDs.
// ---------------------------------------------------------------------------

const CORRELATION_HEADER = 'x-correlation-id';
// RFC-4122-shaped uuid OR an opaque 8–128 char token of url-safe characters.
const CORRELATION_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** True iff the value is an acceptable inbound correlation id (prevents header injection). */
export function isValidCorrelationId(value: string | undefined): value is string {
  return typeof value === 'string' && CORRELATION_RE.test(value);
}

/**
 * Resolve the correlation id for a request: reuse a well-formed inbound id (so a trace spans
 * services) or mint a fresh uuid. Malformed inbound ids are dropped, never echoed.
 */
export function resolveCorrelationId(req: RequestLike): string {
  const inbound = header(req, CORRELATION_HEADER);
  if (isValidCorrelationId(inbound)) return inbound;
  return randomUUID();
}

// ---------------------------------------------------------------------------
// CSRF double-submit verification.
// ---------------------------------------------------------------------------

const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = 'tc_csrf';

/** Constant-time string comparison; false when lengths differ (never leaks via timing). */
function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * CSRF is required only for browser-session mutations. Returns true when the double-submit
 * token in the `x-csrf-token` header matches BOTH the bound session secret and the cookie.
 * Non-browser (workload) callers and safe methods are exempt.
 */
export function csrfSatisfied(req: RequestLike, identity: VerifiedIdentity): boolean {
  if (!MUTATING_METHODS.has(req.method)) return true;
  if (!identity.isBrowserSession) return true; // token-authenticated workloads are not CSRF-eligible

  const headerToken = header(req, CSRF_HEADER);
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const sessionToken = identity.csrfSessionToken;

  if (!headerToken || !cookieToken || !sessionToken) return false;
  // Double-submit: header must equal the cookie AND the server-bound session secret.
  return safeEquals(headerToken, cookieToken) && safeEquals(headerToken, sessionToken);
}

// ---------------------------------------------------------------------------
// Disclosure-safe errors.
// ---------------------------------------------------------------------------

export type ContextErrorCode =
  | 'UNAUTHENTICATED' // no valid identity/tenant
  | 'CSRF_REQUIRED' // browser mutation missing/failed CSRF
  | 'FORBIDDEN'; // reserved for downstream authz denials rendered through this shape

/** HTTP statuses per code — stable machine codes only, never internal detail. */
const STATUS_BY_CODE: Record<ContextErrorCode, number> = {
  UNAUTHENTICATED: 401,
  CSRF_REQUIRED: 403,
  FORBIDDEN: 403,
};

/** Fixed, non-revealing messages. They MUST NOT vary by tenant, principal, or token state. */
const MESSAGE_BY_CODE: Record<ContextErrorCode, string> = {
  UNAUTHENTICATED: 'authentication required',
  CSRF_REQUIRED: 'request rejected',
  FORBIDDEN: 'request rejected',
};

/**
 * The ONLY error body ever returned to a caller. It carries a stable machine code, a fixed
 * message, and the correlation id (so operators can join to server logs) — and nothing else.
 * No stack, tenant, principal, token, or reason string is disclosed.
 */
export interface DisclosureSafeError {
  readonly status: number;
  readonly body: {
    readonly error: ContextErrorCode;
    readonly message: string;
    readonly correlationId: string;
  };
}

/** Build the disclosure-safe error body for a rejection. */
export function disclosureSafeError(
  code: ContextErrorCode,
  correlationId: string,
): DisclosureSafeError {
  return {
    status: STATUS_BY_CODE[code],
    body: {
      error: code,
      message: MESSAGE_BY_CODE[code],
      correlationId,
    },
  };
}

/**
 * Convert ANY thrown value (including an unexpected internal error) into a disclosure-safe
 * body. Internal failures collapse to a generic 500 that reveals only the correlation id, so
 * stack traces / messages never reach the client.
 */
export function sanitizeUnexpectedError(
  _err: unknown,
  correlationId: string,
): { readonly status: number; readonly body: Readonly<Record<string, string>> } {
  return {
    status: 500,
    body: {
      error: 'INTERNAL',
      message: 'internal error',
      correlationId,
    },
  };
}

// ---------------------------------------------------------------------------
// The middleware.
// ---------------------------------------------------------------------------

export type ContextResult =
  | {
      readonly ok: true;
      readonly context: RequestContext;
      readonly responseHeaders: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error: DisclosureSafeError };

/**
 * Establish the authenticated request context, enforcing (in order, fail-closed):
 *   verified identity/tenant → CSRF for browser mutations → correlation id stamping.
 *
 * Returns either an `ok` context (with response headers to echo the correlation id) or a
 * disclosure-safe error. It NEVER throws for a rejected request and NEVER leaks internals.
 */
export function establishRequestContext(req: RequestLike, verify: IdentityVerifier): ContextResult {
  const correlationId = resolveCorrelationId(req);

  // 1. Authenticated tenant context (fail-closed on any untrusted credential).
  let identity: VerifiedIdentity | null;
  try {
    identity = verify(req);
  } catch {
    // A verifier that throws is treated as denial — never surfaced to the caller.
    identity = null;
  }
  if (
    !identity ||
    typeof identity.principalId !== 'string' ||
    identity.principalId.length === 0 ||
    typeof identity.tenantId !== 'string' ||
    identity.tenantId.length === 0
  ) {
    return { ok: false, error: disclosureSafeError('UNAUTHENTICATED', correlationId) };
  }

  // 2. CSRF protection for browser-originated mutations.
  if (!csrfSatisfied(req, identity)) {
    return { ok: false, error: disclosureSafeError('CSRF_REQUIRED', correlationId) };
  }

  // 3. Stamp correlation + causation and expose the decision-authority flag downstream.
  const context: RequestContext = {
    principalId: identity.principalId,
    tenantId: identity.tenantId,
    roles: identity.roles,
    hasDecisionAuthority: hasDecisionAuthority(identity.roles),
    correlationId,
    causationId: randomUUID(),
  };

  return {
    ok: true,
    context,
    responseHeaders: { [CORRELATION_HEADER]: correlationId },
  };
}

/** Header/cookie names exported so consumers and tests share the single source of truth. */
export const CONTEXT_HEADERS = {
  correlation: CORRELATION_HEADER,
  csrf: CSRF_HEADER,
  csrfCookie: CSRF_COOKIE,
} as const;
