// @trustcircle/api — SECURITY HARDENING: response security headers, request/body size limits,
// dependency call timeouts, secret scanning, and production-safe defaults (T296 / GAR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// Phase 10 (Polish and Continuous Improvement) hardens the finished increment for production.
// This module is the single, dependency-free place where the HTTP boundary's production-safe
// posture is DECLARED and ENFORCED, so the same rules are testable under `npm ci` with no
// framework installed and compile under the strict shared base (tsconfig.base.json).
//
// It provides FIVE hardening primitives, each a pure function of its inputs (no implicit clock
// or network read), so every branch is unit-testable and deterministic:
//
//   1. SECURITY HEADERS (`securityHeaders`) — a fail-safe default set applied to every response:
//        • Content-Security-Policy — default-src 'none', locking the API surface to JSON only.
//        • Strict-Transport-Security — force HTTPS for a year, includeSubDomains + preload.
//        • X-Content-Type-Options: nosniff — no MIME sniffing.
//        • X-Frame-Options: DENY + frame-ancestors 'none' — no clickjacking embed.
//        • Referrer-Policy: no-referrer — never leak the governed path to third parties.
//        • Cross-Origin-{Opener,Embedder,Resource}-Policy — process/embedding isolation.
//        • Permissions-Policy — deny camera/mic/geo/etc. an API never needs.
//        • Cache-Control: no-store — governance responses are never cached by intermediaries.
//        The `Server`/`X-Powered-By` fingerprints are explicitly stripped.
//
//   2. REQUEST / BODY LIMITS (`enforceRequestLimits`) — a request whose declared
//      `Content-Length` (or whose actual read length) exceeds the per-route byte budget is
//      rejected fail-closed with 413 BEFORE the body is buffered, so an oversized or unbounded
//      body can never exhaust memory. Header count / URL length / field-count ceilings guard the
//      cheaper amplification vectors too.
//
//   3. DEPENDENCY TIMEOUTS (`withDependencyTimeout`) — every outbound dependency call (DB query,
//      object store, message broker, policy engine) is wrapped so it FAILS VISIBLY at a bound
//      rather than hanging forever and cascading a stall. A timed-out call rejects with a stable
//      `DependencyTimeoutError` carrying the dependency name and budget — fail-visible, never a
//      silent hang. An injected `AbortController`-style signal is honoured so the underlying work
//      is actually cancelled, not merely abandoned.
//
//   4. SECRET SCANNING (`scanForSecrets`) — a deterministic scanner that flags high-entropy /
//      well-known secret shapes (AWS keys, private-key PEM blocks, bearer/JWT tokens, connection
//      strings with inline passwords, generic long hex/base64 secrets). Used both to REDACT
//      secrets from anything about to be logged/returned and to FAIL a boot/CI check if a secret
//      is found in a place it must never be (env dump, error body, evidence artifact).
//
//   5. PRODUCTION-SAFE DEFAULTS (`resolveProductionDefaults`, `assertProductionSafe`) — the
//      configuration posture the service MUST have in production: TLS required, debug/verbose
//      errors OFF, stack traces never returned to callers, permissive CORS refused, default/blank
//      secrets refused, source maps off, sample/seed data refused. `assertProductionSafe` fails
//      CLOSED (throws) when `NODE_ENV=production` and any unsafe default is still in effect, so an
//      unhardened build cannot start in production.
//
// Dependency-free (only Node built-in `crypto` for constant-time compares). No wall clock is read
// implicitly — `withDependencyTimeout` takes an injected timer so it is deterministic under test.

import { timingSafeEqual } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 1. SECURITY HEADERS
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The immutable, fail-safe security-header set applied to every API response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // JSON-only API: lock everything down; no inline script/style, no framing, no plugins.
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  // Force HTTPS for a year across subdomains; eligible for the browser preload list.
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  // Governance responses carry authorization-scoped data — never cache them anywhere.
  'cache-control': 'no-store',
  // A machine-code error contract is returned; a caller must never rely on a fingerprint.
  'x-permitted-cross-domain-policies': 'none',
});

/** Header names whose presence leaks a fingerprint and MUST be stripped from every response. */
export const FINGERPRINT_HEADERS: readonly string[] = Object.freeze([
  'server',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
]);

/**
 * Apply the fail-safe security headers onto a mutable header sink and strip fingerprint headers.
 * Returns the same sink for chaining. Existing values for a hardened header are OVERWRITTEN
 * (a handler cannot weaken the CSP), while fingerprint headers are deleted outright.
 */
export function securityHeaders(sink: {
  set(name: string, value: string): void;
  delete(name: string): void;
}): typeof sink {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    sink.set(name, value);
  }
  for (const name of FINGERPRINT_HEADERS) {
    sink.delete(name);
  }
  return sink;
}

/** Materialize the hardened headers as a plain record (for the dependency-free server merge path). */
export function securityHeaderRecord(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 2. REQUEST / BODY LIMITS
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Byte / count ceilings enforced at the HTTP boundary before a body is buffered. */
export interface RequestLimits {
  /** Maximum request body size in bytes (default 256 KiB — a governance mutation is small). */
  readonly maxBodyBytes: number;
  /** Maximum request URL length in characters. */
  readonly maxUrlLength: number;
  /** Maximum number of request headers. */
  readonly maxHeaderCount: number;
  /** Maximum number of top-level fields in a JSON body (amplification guard). */
  readonly maxJsonFields: number;
}

/** The production-safe default request limits. */
export const DEFAULT_REQUEST_LIMITS: RequestLimits = Object.freeze({
  maxBodyBytes: 256 * 1024,
  maxUrlLength: 4096,
  maxHeaderCount: 64,
  maxJsonFields: 256,
});

/** Outcome of a request-limit check. `ok:false` carries the stable rejection code + HTTP status. */
export type LimitCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly status: number;
      readonly limit: number;
      readonly observed: number;
    };

/**
 * Reject fail-closed when a request exceeds a byte/count budget. Called with the CHEAP,
 * pre-buffer signals (declared content-length, url length, header count) so an oversized body is
 * refused with 413 BEFORE it is read into memory. A missing/blank content-length on a
 * body-bearing method is treated as unknown and the streaming reader must still enforce the byte
 * cap via {@link enforceReadLength}.
 */
export function enforceRequestLimits(
  input: {
    readonly method: string;
    readonly urlLength: number;
    readonly headerCount: number;
    readonly contentLength?: number | undefined;
  },
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
): LimitCheck {
  if (input.urlLength > limits.maxUrlLength) {
    return {
      ok: false,
      code: 'uri_too_long',
      status: 414,
      limit: limits.maxUrlLength,
      observed: input.urlLength,
    };
  }
  if (input.headerCount > limits.maxHeaderCount) {
    return {
      ok: false,
      code: 'too_many_headers',
      status: 431,
      limit: limits.maxHeaderCount,
      observed: input.headerCount,
    };
  }
  if (input.contentLength !== undefined && input.contentLength > limits.maxBodyBytes) {
    return {
      ok: false,
      code: 'payload_too_large',
      status: 413,
      limit: limits.maxBodyBytes,
      observed: input.contentLength,
    };
  }
  return { ok: true };
}

/**
 * Enforce the byte cap while a body is being read (for chunked/unknown-length bodies where
 * content-length cannot be trusted). Returns `ok:false` the moment the running total exceeds the
 * budget, so the reader can abort mid-stream instead of buffering an unbounded body.
 */
export function enforceReadLength(
  bytesReadSoFar: number,
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
): LimitCheck {
  if (bytesReadSoFar > limits.maxBodyBytes) {
    return {
      ok: false,
      code: 'payload_too_large',
      status: 413,
      limit: limits.maxBodyBytes,
      observed: bytesReadSoFar,
    };
  }
  return { ok: true };
}

/** Reject a JSON body whose top-level field count exceeds the amplification ceiling. */
export function enforceJsonFieldCount(
  fieldCount: number,
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
): LimitCheck {
  if (fieldCount > limits.maxJsonFields) {
    return {
      ok: false,
      code: 'too_many_fields',
      status: 413,
      limit: limits.maxJsonFields,
      observed: fieldCount,
    };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 3. DEPENDENCY TIMEOUTS
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Per-dependency timeout budgets in milliseconds. A call that overruns fails visibly. */
export interface DependencyTimeouts {
  readonly database: number;
  readonly objectStore: number;
  readonly messageBroker: number;
  readonly policyEngine: number;
  readonly identityProvider: number;
  /** Fallback budget for any dependency without a named entry. */
  readonly default: number;
}

/** Production-safe default dependency timeouts (ms). */
export const DEFAULT_DEPENDENCY_TIMEOUTS: DependencyTimeouts = Object.freeze({
  database: 5_000,
  objectStore: 10_000,
  messageBroker: 3_000,
  policyEngine: 2_000,
  identityProvider: 3_000,
  default: 5_000,
});

/** Raised when a dependency call overruns its timeout budget. Carries the dependency + budget. */
export class DependencyTimeoutError extends Error {
  readonly code = 'dependency_timeout' as const;
  readonly dependency: string;
  readonly budgetMs: number;
  constructor(dependency: string, budgetMs: number) {
    super(`dependency '${dependency}' exceeded ${budgetMs}ms timeout budget`);
    this.name = 'DependencyTimeoutError';
    this.dependency = dependency;
    this.budgetMs = budgetMs;
  }
}

/** Minimal injected timer so the timeout wrapper is deterministic under test (no real clock). */
export interface TimerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real Node timer, adapted to {@link TimerLike}. */
export const NODE_TIMER: TimerLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Wrap an outbound dependency call so it FAILS VISIBLY at `budgetMs` instead of hanging forever.
 * The returned promise rejects with a {@link DependencyTimeoutError} on overrun; on a normal
 * settle the timer is cleared. An optional `onTimeout` cancels the underlying work (e.g.
 * `abortController.abort()`), so the timed-out call is actually cancelled, not merely abandoned.
 */
export function withDependencyTimeout<T>(
  dependency: string,
  work: Promise<T>,
  budgetMs: number,
  options: { readonly timer?: TimerLike; readonly onTimeout?: () => void } = {},
): Promise<T> {
  const timer = options.timer ?? NODE_TIMER;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const handle = timer.setTimeout(() => {
      if (settled) return;
      settled = true;
      options.onTimeout?.();
      rejectPromise(new DependencyTimeoutError(dependency, budgetMs));
    }, budgetMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        timer.clearTimeout(handle);
        resolvePromise(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        timer.clearTimeout(handle);
        rejectPromise(err);
      },
    );
  });
}

/** Look up the timeout budget for a named dependency, falling back to `default`. */
export function timeoutFor(
  dependency: keyof DependencyTimeouts | string,
  timeouts: DependencyTimeouts = DEFAULT_DEPENDENCY_TIMEOUTS,
): number {
  return (timeouts as unknown as Record<string, number>)[dependency] ?? timeouts.default;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 4. SECRET SCANNING
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A single detected secret occurrence (kind + the redacted preview, never the raw secret). */
export interface SecretFinding {
  readonly kind: string;
  /** A short, non-reversible preview (first 4 chars + length) so a finding is actionable but safe. */
  readonly preview: string;
  readonly index: number;
}

interface SecretRule {
  readonly kind: string;
  readonly pattern: RegExp;
}

/**
 * Deterministic secret-shape detectors. Ordered most-specific first. These are DETECTORS, not
 * validators — a match is treated as a secret regardless of whether it is live.
 */
export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'private-key-pem',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'connection-string-password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi },
  { kind: 'generic-hex-secret', pattern: /\b[0-9a-f]{40,}\b/gi },
]);

/** A short, non-reversible preview of a matched secret: first 4 chars + its length. */
function preview(match: string): string {
  const head = match.slice(0, 4);
  return `${head}…(${match.length} chars)`;
}

/**
 * Scan an arbitrary string for secret shapes. Returns every finding (deterministic order). Used
 * to REDACT before logging and to FAIL a boot/CI check when a secret appears where it must not.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({ kind: rule.kind, preview: preview(m[0]), index: m.index });
      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
    }
  }
  return findings.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
}

/** True when the text contains at least one secret shape. */
export function containsSecret(text: string): boolean {
  return scanForSecrets(text).length > 0;
}

/** The replacement token substituted for a redacted secret. */
export const SECRET_REDACTION = '«redacted-secret»';

/**
 * Redact every secret occurrence in a string so it is safe to log/return. Idempotent: running it
 * on already-redacted text is a no-op.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), SECRET_REDACTION);
  }
  return out;
}

/**
 * Fail CLOSED when a value that must never carry a secret does. Throws with the finding kinds
 * (never the raw secret). Use at boot for env dumps / error bodies / evidence artifacts.
 */
export function assertNoSecret(where: string, text: string): void {
  const findings = scanForSecrets(text);
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((f) => f.kind))].join(', ');
    throw new Error(
      `secret detected in ${where}: ${kinds} (redacted; ${findings.length} occurrence(s))`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 5. PRODUCTION-SAFE DEFAULTS
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The security-relevant runtime configuration whose defaults must be production-safe. */
export interface RuntimeConfig {
  readonly nodeEnv: string;
  /** TLS/HTTPS is required at the edge. */
  readonly tlsRequired: boolean;
  /** Verbose/debug error bodies (stack traces, internal detail) returned to callers. */
  readonly verboseErrors: boolean;
  /** Whether stack traces are included in error responses. */
  readonly exposeStackTraces: boolean;
  /** CORS allow-list. `['*']` is a wildcard and refused in production. */
  readonly corsAllowedOrigins: readonly string[];
  /** The signing/session secret. Blank / well-known defaults are refused in production. */
  readonly sessionSecret: string;
  /** Source maps served to clients. */
  readonly sourceMaps: boolean;
  /** Sample/seed data loaded. */
  readonly seedData: boolean;
}

/** Secrets that are obviously placeholders and must never be used in production. */
export const FORBIDDEN_DEFAULT_SECRETS: readonly string[] = Object.freeze([
  '',
  'changeme',
  'change-me',
  'secret',
  'password',
  'default',
  'dev',
  'development',
  'test',
  'insecure',
  'trustcircle',
]);

/** The production-safe defaults — every field set to its hardened value. */
export const PRODUCTION_SAFE_DEFAULTS: Omit<RuntimeConfig, 'nodeEnv' | 'sessionSecret'> =
  Object.freeze({
    tlsRequired: true,
    verboseErrors: false,
    exposeStackTraces: false,
    corsAllowedOrigins: [],
    sourceMaps: false,
    seedData: false,
  });

/**
 * Resolve a partial runtime config to a fully-defaulted one, applying production-safe defaults
 * for any field the caller left unset. The result is what the service will actually run with.
 */
export function resolveProductionDefaults(
  partial: Partial<RuntimeConfig> & { readonly nodeEnv: string },
): RuntimeConfig {
  return {
    nodeEnv: partial.nodeEnv,
    tlsRequired: partial.tlsRequired ?? PRODUCTION_SAFE_DEFAULTS.tlsRequired,
    verboseErrors: partial.verboseErrors ?? PRODUCTION_SAFE_DEFAULTS.verboseErrors,
    exposeStackTraces: partial.exposeStackTraces ?? PRODUCTION_SAFE_DEFAULTS.exposeStackTraces,
    corsAllowedOrigins: partial.corsAllowedOrigins ?? [
      ...PRODUCTION_SAFE_DEFAULTS.corsAllowedOrigins,
    ],
    sessionSecret: partial.sessionSecret ?? '',
    sourceMaps: partial.sourceMaps ?? PRODUCTION_SAFE_DEFAULTS.sourceMaps,
    seedData: partial.seedData ?? PRODUCTION_SAFE_DEFAULTS.seedData,
  };
}

/** True when running under production. */
export function isProduction(config: Pick<RuntimeConfig, 'nodeEnv'>): boolean {
  return config.nodeEnv === 'production';
}

/** Constant-time check that a secret is not a forbidden placeholder (avoids length-leak). */
function isForbiddenSecret(secret: string): boolean {
  const lower = secret.toLowerCase();
  for (const forbidden of FORBIDDEN_DEFAULT_SECRETS) {
    if (forbidden.length === lower.length) {
      const a = Buffer.from(lower);
      const b = Buffer.from(forbidden);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } else if (forbidden === '' && lower === '') {
      return true;
    }
  }
  // A too-short secret is also unsafe regardless of the exact value.
  return secret.length < 16;
}

/**
 * Assert the resolved config is production-safe. In production, every unsafe default is a FATAL
 * boot error (the service refuses to start). Outside production the same problems are returned as
 * non-fatal warnings so a developer sees them without being blocked. Returns the list of
 * violations found (empty when clean).
 */
export function assertProductionSafe(config: RuntimeConfig): readonly string[] {
  const violations: string[] = [];
  if (isProduction(config)) {
    if (!config.tlsRequired)
      violations.push('TLS is not required (tlsRequired=false) in production');
    if (config.verboseErrors) violations.push('verbose error bodies are enabled in production');
    if (config.exposeStackTraces)
      violations.push('stack traces are exposed to callers in production');
    if (config.corsAllowedOrigins.includes('*'))
      violations.push('CORS allows any origin ("*") in production');
    if (isForbiddenSecret(config.sessionSecret))
      violations.push('session secret is blank, well-known, or too short (<16 chars)');
    if (config.sourceMaps) violations.push('source maps are served to clients in production');
    if (config.seedData) violations.push('sample/seed data is loaded in production');
    if (violations.length > 0) {
      throw new Error(
        `production-safe defaults violated — refusing to start:\n  - ${violations.join('\n  - ')}`,
      );
    }
  } else {
    if (!config.tlsRequired) violations.push('warn: TLS not required (acceptable in dev)');
    if (config.verboseErrors) violations.push('warn: verbose errors enabled (dev only)');
    if (config.corsAllowedOrigins.includes('*')) violations.push('warn: wildcard CORS (dev only)');
  }
  return violations;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// AGGREGATE POSTURE
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The fully-resolved hardening posture the boundary runs with. */
export interface HardeningPosture {
  readonly headers: Readonly<Record<string, string>>;
  readonly strippedHeaders: readonly string[];
  readonly limits: RequestLimits;
  readonly timeouts: DependencyTimeouts;
  readonly config: RuntimeConfig;
  readonly violations: readonly string[];
}

/**
 * Resolve the full hardening posture from a partial runtime config and assert it is
 * production-safe (throwing in production on any unsafe default). This is the one call a
 * bootstrap makes to obtain the headers/limits/timeouts to apply and to fail-closed on an
 * unhardened production build.
 */
export function resolveHardeningPosture(
  partial: Partial<RuntimeConfig> & { readonly nodeEnv: string },
  overrides: { readonly limits?: RequestLimits; readonly timeouts?: DependencyTimeouts } = {},
): HardeningPosture {
  const config = resolveProductionDefaults(partial);
  const violations = assertProductionSafe(config); // throws in production if unsafe
  return {
    headers: securityHeaderRecord(),
    strippedHeaders: [...FINGERPRINT_HEADERS],
    limits: overrides.limits ?? DEFAULT_REQUEST_LIMITS,
    timeouts: overrides.timeouts ?? DEFAULT_DEPENDENCY_TIMEOUTS,
    config,
    violations,
  };
}
