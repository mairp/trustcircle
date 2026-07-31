// @trustcircle/application — typed environment parsing, secret-reference validation, and
// safe defaults (Phase 7 / T0-env / VO-ec575c4ce42b548bfb4d).
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): "Changes to inventory, decisions,
// lifecycle states, source contracts, evidence, mappings, and exports MUST preserve
// supported consumers or provide approved deprecation, migration, rollback, notice, and
// compatibility evidence."
//
// This module is a *source contract*: the exported `parseEnvironment`, the `AppEnvironment`
// shape, the `ENVIRONMENT_VARIABLE_NAMES` inventory, the `SAFE_DEFAULTS` table, and the
// secret-reference grammar are a supported consumer surface (apps/api and adapters read
// their configuration through it). The paired unit suite pins every one of these so a
// silent breaking change to the parsing contract, the variable inventory, the default
// table, or the exported symbol set is caught before it can reach a consumer.
//
// Design invariants (grounded in the spec):
//   1. TYPED parsing — every consumed variable is coerced to a declared TypeScript type with
//      an explicit, bounded validator; unknown/blank inputs fall back to a SAFE DEFAULT, and
//      malformed inputs FAIL CLOSED with an actionable, disclosure-safe error.
//   2. SECRET-REFERENCE validation — secret-bearing variables (`*_SECRET_REF`,
//      `CREDENTIAL_REF`, …) MUST carry a *reference* (`env:NAME`, `vault:path#key`,
//      `file:/abs/path`, `awssm:arn`, `gcpsm:…`), never an inline secret literal. This
//      mirrors data-model.md ConnectorInstance.credential_ref ("Secret reference only") and
//      plan.md Telemetry ("no secrets … by default"). Inline-looking values are rejected and
//      the resolved secret value is NEVER stored on the returned config — only the reference.
//   3. SAFE DEFAULTS — production tightens automatically (no debug, TLS required, telemetry
//      redaction on); the defaults never weaken security in production.
//
// Dependency-free (no runtime imports) so it is independently observable and testable under
// `npm ci` with no adjacent infrastructure, and it never reads `process.env` implicitly — the
// raw record is INJECTED, keeping the parser pure and deterministic.

// ---------------------------------------------------------------------------
// Public types (the exported source contract).
// ---------------------------------------------------------------------------

/** Deployment stages. Ordered from most-permissive to most-locked-down. */
export const DEPLOYMENT_STAGES = ['development', 'test', 'staging', 'production'] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

/** Supported secret-reference schemes. A secret MUST be one of these — never an inline value. */
export const SECRET_REFERENCE_SCHEMES = [
  'env', // env:OTHER_VAR_NAME — indirect through another environment variable
  'file', // file:/absolute/path — mounted secret file
  'vault', // vault:secret/data/path#key — HashiCorp Vault
  'awssm', // awssm:arn:aws:secretsmanager:… — AWS Secrets Manager
  'gcpsm', // gcpsm:projects/p/secrets/s/versions/v — GCP Secret Manager
  'k8s', // k8s:namespace/secret#key — Kubernetes secret
] as const;
export type SecretReferenceScheme = (typeof SECRET_REFERENCE_SCHEMES)[number];

/**
 * A validated secret *reference*. Carries only the pointer, never the resolved secret value,
 * so the config object is safe to log/serialize (see `toRedactedString`).
 */
export interface SecretReference {
  readonly scheme: SecretReferenceScheme;
  /** The scheme-specific locator (path, arn, vault path, etc.) — NOT the secret itself. */
  readonly locator: string;
  /** The original `scheme:locator` string, for exact provenance. */
  readonly raw: string;
}

/** The fully-typed, validated application environment consumed by apps/adapters. */
export interface AppEnvironment {
  readonly stage: DeploymentStage;
  /** True only in `production`. Convenience flag for consumers. */
  readonly isProduction: boolean;
  readonly server: {
    readonly host: string;
    readonly port: number;
    /** TLS is REQUIRED in production; a safe default enforces it there. */
    readonly requireTls: boolean;
  };
  readonly database: {
    /** Connection URL with any embedded password redacted to a secret reference form. */
    readonly urlRef: SecretReference;
    readonly poolMax: number;
    readonly connectTimeoutMillis: number;
  };
  readonly messaging: {
    readonly natsUrl: string;
    readonly streamPrefix: string;
  };
  readonly telemetry: {
    /** Redaction is ON by default and cannot be disabled in production (plan.md Telemetry). */
    readonly redactionEnabled: boolean;
    readonly sampleRatio: number;
    readonly endpointRef: SecretReference | null;
  };
  readonly security: {
    /** Debug/verbose disclosure is forbidden in production (fail-closed default). */
    readonly debug: boolean;
    /** Signing key for evidence/disposition records — reference only, never inline. */
    readonly signingKeyRef: SecretReference;
    readonly sessionSecretRef: SecretReference;
  };
  readonly limits: {
    readonly requestTimeoutMillis: number;
    readonly maxUploadBytes: number;
  };
}

/** A single field diagnostic. Messages are disclosure-safe (no values echoed). */
export interface EnvironmentIssue {
  readonly variable: string;
  readonly code:
    | 'missing_required'
    | 'invalid_type'
    | 'out_of_range'
    | 'inline_secret_forbidden'
    | 'unsupported_secret_scheme'
    | 'malformed_secret_reference'
    | 'unsafe_in_production';
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly env: AppEnvironment; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly issues: readonly EnvironmentIssue[] };

/** Raw environment record (e.g. `process.env`) — injected, never read implicitly. */
export type RawEnvironment = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Variable inventory + safe defaults (part of the exported contract).
// ---------------------------------------------------------------------------

/**
 * The canonical inventory of every environment variable this parser consumes. Kept exported
 * and asserted so adding/removing a variable is a visible, tested contract change.
 */
export const ENVIRONMENT_VARIABLE_NAMES = [
  'DEPLOYMENT_STAGE',
  'HTTP_HOST',
  'HTTP_PORT',
  'HTTP_REQUIRE_TLS',
  'DATABASE_URL',
  'DATABASE_POOL_MAX',
  'DATABASE_CONNECT_TIMEOUT_MS',
  'NATS_URL',
  'NATS_STREAM_PREFIX',
  'TELEMETRY_REDACTION_ENABLED',
  'TELEMETRY_SAMPLE_RATIO',
  'TELEMETRY_ENDPOINT_SECRET_REF',
  'SECURITY_DEBUG',
  'SIGNING_KEY_SECRET_REF',
  'SESSION_SECRET_REF',
  'REQUEST_TIMEOUT_MS',
  'MAX_UPLOAD_BYTES',
] as const;
export type EnvironmentVariableName = (typeof ENVIRONMENT_VARIABLE_NAMES)[number];

/**
 * The names that MUST carry a secret *reference* (never an inline value). Any of these that
 * is present is validated by the secret-reference grammar; `DATABASE_URL` is handled
 * specially because it may embed a password that we downgrade to a reference.
 */
export const SECRET_REFERENCE_VARIABLE_NAMES = [
  'TELEMETRY_ENDPOINT_SECRET_REF',
  'SIGNING_KEY_SECRET_REF',
  'SESSION_SECRET_REF',
] as const;

/**
 * Safe, non-secret defaults applied when a variable is absent or blank. These are the values
 * used in `development`; `applyProductionHardening` tightens security-relevant ones for
 * `production`. No secret ever has a default — required secret refs must be supplied.
 */
export const SAFE_DEFAULTS = Object.freeze({
  DEPLOYMENT_STAGE: 'development' as DeploymentStage,
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: 8080,
  HTTP_REQUIRE_TLS: false,
  DATABASE_POOL_MAX: 10,
  DATABASE_CONNECT_TIMEOUT_MS: 5_000,
  NATS_URL: 'nats://127.0.0.1:4222',
  NATS_STREAM_PREFIX: 'trustcircle',
  TELEMETRY_REDACTION_ENABLED: true,
  TELEMETRY_SAMPLE_RATIO: 0.1,
  SECURITY_DEBUG: false,
  REQUEST_TIMEOUT_MS: 30_000,
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
});

// ---------------------------------------------------------------------------
// Secret-reference grammar + inline-secret heuristic.
// ---------------------------------------------------------------------------

const SCHEME_SET = new Set<string>(SECRET_REFERENCE_SCHEMES);

/**
 * Parse a value as a secret reference. Returns an issue if it is not a supported reference or
 * if it looks like an INLINE secret (the primary safety property: no raw secret in env).
 */
export function parseSecretReference(
  variable: string,
  value: string,
): { readonly ref: SecretReference } | { readonly issue: EnvironmentIssue } {
  const trimmed = value.trim();
  const sep = trimmed.indexOf(':');
  if (sep <= 0) {
    return {
      issue: {
        variable,
        code: 'inline_secret_forbidden',
        message: `${variable} must be a secret reference like "env:NAME" or "vault:path#key", not an inline value`,
      },
    };
  }
  const scheme = trimmed.slice(0, sep);
  const locator = trimmed.slice(sep + 1);
  if (!SCHEME_SET.has(scheme)) {
    return {
      issue: {
        variable,
        code: 'unsupported_secret_scheme',
        message: `${variable} uses unsupported secret scheme "${scheme}"; expected one of ${SECRET_REFERENCE_SCHEMES.join(', ')}`,
      },
    };
  }
  if (locator.trim().length === 0) {
    return {
      issue: {
        variable,
        code: 'malformed_secret_reference',
        message: `${variable} secret reference "${scheme}:" is missing its locator`,
      },
    };
  }
  // Per-scheme structural checks — reference form only, never the material itself.
  const scopedIssue = validateLocator(variable, scheme as SecretReferenceScheme, locator);
  if (scopedIssue) return { issue: scopedIssue };
  return { ref: { scheme: scheme as SecretReferenceScheme, locator, raw: `${scheme}:${locator}` } };
}

function validateLocator(
  variable: string,
  scheme: SecretReferenceScheme,
  locator: string,
): EnvironmentIssue | null {
  const malformed = (why: string): EnvironmentIssue => ({
    variable,
    code: 'malformed_secret_reference',
    message: `${variable} ${scheme} reference is malformed: ${why}`,
  });
  switch (scheme) {
    case 'env':
      // Must name another env var (UPPER_SNAKE) — indirection, not a literal.
      return /^[A-Z][A-Z0-9_]*$/.test(locator)
        ? null
        : malformed('expected an UPPER_SNAKE_CASE variable name after "env:"');
    case 'file':
      return locator.startsWith('/') ? null : malformed('expected an absolute path after "file:"');
    case 'vault':
      return locator.includes('#') ? null : malformed('expected "path#key" after "vault:"');
    case 'k8s':
      return locator.includes('/') && locator.includes('#')
        ? null
        : malformed('expected "namespace/secret#key" after "k8s:"');
    case 'awssm':
    case 'gcpsm':
      return null; // opaque arns/resource names — presence checked above
    default:
      return malformed('unknown scheme');
  }
}

// ---------------------------------------------------------------------------
// Typed primitive coercion.
// ---------------------------------------------------------------------------

function coerceBoolean(
  variable: string,
  value: string,
  issues: EnvironmentIssue[],
): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  issues.push({
    variable,
    code: 'invalid_type',
    message: `${variable} must be a boolean (true/false), received an unrecognized token`,
  });
  return undefined;
}

function coerceInt(
  variable: string,
  value: string,
  bounds: { min: number; max: number },
  issues: EnvironmentIssue[],
): number | undefined {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    issues.push({
      variable,
      code: 'invalid_type',
      message: `${variable} must be an integer`,
    });
    return undefined;
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < bounds.min || n > bounds.max) {
    issues.push({
      variable,
      code: 'out_of_range',
      message: `${variable} must be within [${bounds.min}, ${bounds.max}]`,
    });
    return undefined;
  }
  return n;
}

function coerceRatio(
  variable: string,
  value: string,
  issues: EnvironmentIssue[],
): number | undefined {
  const trimmed = value.trim();
  if (!/^\d*(\.\d+)?$/.test(trimmed) || trimmed === '') {
    issues.push({ variable, code: 'invalid_type', message: `${variable} must be a number` });
    return undefined;
  }
  const n = Number.parseFloat(trimmed);
  if (n < 0 || n > 1) {
    issues.push({
      variable,
      code: 'out_of_range',
      message: `${variable} must be a ratio within [0, 1]`,
    });
    return undefined;
  }
  return n;
}

function coerceStage(value: string, issues: EnvironmentIssue[]): DeploymentStage | undefined {
  const v = value.trim().toLowerCase();
  if ((DEPLOYMENT_STAGES as readonly string[]).includes(v)) return v as DeploymentStage;
  issues.push({
    variable: 'DEPLOYMENT_STAGE',
    code: 'invalid_type',
    message: `DEPLOYMENT_STAGE must be one of ${DEPLOYMENT_STAGES.join(', ')}`,
  });
  return undefined;
}

/** Present iff the value is a non-empty, non-whitespace string. */
function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// DATABASE_URL — downgrade any embedded password to a secret reference.
// ---------------------------------------------------------------------------

/**
 * Convert a database URL that may embed a password into a `SecretReference`. If a password is
 * embedded inline we FLAG it (inline secret) and require the reference form
 * `env:DATABASE_URL_PASSWORD` or an explicit secret scheme; otherwise the whole URL is treated
 * as a non-secret connection reference (`env:` self-reference by name).
 */
function parseDatabaseUrl(value: string, issues: EnvironmentIssue[]): SecretReference | undefined {
  const trimmed = value.trim();
  // If it is already a secret reference, validate it as one.
  if (SCHEME_SET.has(trimmed.slice(0, Math.max(0, trimmed.indexOf(':'))))) {
    const parsed = parseSecretReference('DATABASE_URL', trimmed);
    if ('issue' in parsed) {
      issues.push(parsed.issue);
      return undefined;
    }
    return parsed.ref;
  }
  // Detect an inline password in a URL like scheme://user:PASSWORD@host/db.
  const authMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i.exec(trimmed);
  if (authMatch && authMatch[1] !== undefined) {
    const auth = authMatch[1];
    const colon = auth.indexOf(':');
    if (colon >= 0 && auth.slice(colon + 1).length > 0) {
      issues.push({
        variable: 'DATABASE_URL',
        code: 'inline_secret_forbidden',
        message:
          'DATABASE_URL embeds an inline password; supply the password via a secret reference (e.g. env:DATABASE_URL_PASSWORD) and keep only a non-secret DSN inline',
      });
      return undefined;
    }
  }
  // No embedded secret: treat the DSN itself as a non-secret reference by name.
  return { scheme: 'env', locator: 'DATABASE_URL', raw: 'env:DATABASE_URL' };
}

// ---------------------------------------------------------------------------
// Core parser.
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw environment record into a fully-typed `AppEnvironment`.
 * Pure and deterministic: it reads only the injected `raw` record and never touches the wall
 * clock, filesystem, or `process.env`. Returns a discriminated result; never throws for user
 * input (only `parseEnvironmentOrThrow` throws, for call sites that want fail-fast boot).
 */
export function parseEnvironment(raw: RawEnvironment): ParseResult {
  const issues: EnvironmentIssue[] = [];
  const warnings: string[] = [];

  // Read via bracket access — RawEnvironment is an index signature and the strict base sets
  // noPropertyAccessFromIndexSignature.
  const get = (name: EnvironmentVariableName): string | undefined => raw[name];

  const rawStage = get('DEPLOYMENT_STAGE');
  const stage = present(rawStage)
    ? (coerceStage(rawStage, issues) ?? SAFE_DEFAULTS.DEPLOYMENT_STAGE)
    : SAFE_DEFAULTS.DEPLOYMENT_STAGE;
  const isProduction = stage === 'production';

  // --- server ---
  const rawHost = get('HTTP_HOST');
  const host = present(rawHost) ? rawHost.trim() : SAFE_DEFAULTS.HTTP_HOST;
  const rawPort = get('HTTP_PORT');
  const port = present(rawPort)
    ? (coerceInt('HTTP_PORT', rawPort, { min: 1, max: 65_535 }, issues) ?? SAFE_DEFAULTS.HTTP_PORT)
    : SAFE_DEFAULTS.HTTP_PORT;
  const rawRequireTls = get('HTTP_REQUIRE_TLS');
  let requireTls = present(rawRequireTls)
    ? (coerceBoolean('HTTP_REQUIRE_TLS', rawRequireTls, issues) ?? SAFE_DEFAULTS.HTTP_REQUIRE_TLS)
    : SAFE_DEFAULTS.HTTP_REQUIRE_TLS;

  // --- database ---
  const rawDbUrl = get('DATABASE_URL');
  let urlRef: SecretReference | undefined;
  if (present(rawDbUrl)) {
    urlRef = parseDatabaseUrl(rawDbUrl, issues);
  } else {
    issues.push({
      variable: 'DATABASE_URL',
      code: 'missing_required',
      message: 'DATABASE_URL is required',
    });
  }
  const rawPoolMax = get('DATABASE_POOL_MAX');
  const poolMax = present(rawPoolMax)
    ? (coerceInt('DATABASE_POOL_MAX', rawPoolMax, { min: 1, max: 1_000 }, issues) ??
      SAFE_DEFAULTS.DATABASE_POOL_MAX)
    : SAFE_DEFAULTS.DATABASE_POOL_MAX;
  const rawConnectTimeout = get('DATABASE_CONNECT_TIMEOUT_MS');
  const connectTimeoutMillis = present(rawConnectTimeout)
    ? (coerceInt(
        'DATABASE_CONNECT_TIMEOUT_MS',
        rawConnectTimeout,
        { min: 100, max: 120_000 },
        issues,
      ) ?? SAFE_DEFAULTS.DATABASE_CONNECT_TIMEOUT_MS)
    : SAFE_DEFAULTS.DATABASE_CONNECT_TIMEOUT_MS;

  // --- messaging ---
  const rawNatsUrl = get('NATS_URL');
  const natsUrl = present(rawNatsUrl) ? rawNatsUrl.trim() : SAFE_DEFAULTS.NATS_URL;
  const rawStreamPrefix = get('NATS_STREAM_PREFIX');
  const streamPrefix = present(rawStreamPrefix)
    ? rawStreamPrefix.trim()
    : SAFE_DEFAULTS.NATS_STREAM_PREFIX;

  // --- telemetry ---
  const rawRedaction = get('TELEMETRY_REDACTION_ENABLED');
  let redactionEnabled = present(rawRedaction)
    ? (coerceBoolean('TELEMETRY_REDACTION_ENABLED', rawRedaction, issues) ??
      SAFE_DEFAULTS.TELEMETRY_REDACTION_ENABLED)
    : SAFE_DEFAULTS.TELEMETRY_REDACTION_ENABLED;
  const rawSampleRatio = get('TELEMETRY_SAMPLE_RATIO');
  const sampleRatio = present(rawSampleRatio)
    ? (coerceRatio('TELEMETRY_SAMPLE_RATIO', rawSampleRatio, issues) ??
      SAFE_DEFAULTS.TELEMETRY_SAMPLE_RATIO)
    : SAFE_DEFAULTS.TELEMETRY_SAMPLE_RATIO;
  const rawEndpointRef = get('TELEMETRY_ENDPOINT_SECRET_REF');
  const endpointRef = present(rawEndpointRef)
    ? resolveSecretRef('TELEMETRY_ENDPOINT_SECRET_REF', rawEndpointRef, issues)
    : null;

  // --- security ---
  const rawDebug = get('SECURITY_DEBUG');
  let debug = present(rawDebug)
    ? (coerceBoolean('SECURITY_DEBUG', rawDebug, issues) ?? SAFE_DEFAULTS.SECURITY_DEBUG)
    : SAFE_DEFAULTS.SECURITY_DEBUG;
  const signingKeyRef = requireSecretRef(
    'SIGNING_KEY_SECRET_REF',
    get('SIGNING_KEY_SECRET_REF'),
    issues,
  );
  const sessionSecretRef = requireSecretRef(
    'SESSION_SECRET_REF',
    get('SESSION_SECRET_REF'),
    issues,
  );

  // --- limits ---
  const rawReqTimeout = get('REQUEST_TIMEOUT_MS');
  const requestTimeoutMillis = present(rawReqTimeout)
    ? (coerceInt('REQUEST_TIMEOUT_MS', rawReqTimeout, { min: 100, max: 600_000 }, issues) ??
      SAFE_DEFAULTS.REQUEST_TIMEOUT_MS)
    : SAFE_DEFAULTS.REQUEST_TIMEOUT_MS;
  const rawMaxUpload = get('MAX_UPLOAD_BYTES');
  const maxUploadBytes = present(rawMaxUpload)
    ? (coerceInt(
        'MAX_UPLOAD_BYTES',
        rawMaxUpload,
        { min: 1, max: 5 * 1024 * 1024 * 1024 },
        issues,
      ) ?? SAFE_DEFAULTS.MAX_UPLOAD_BYTES)
    : SAFE_DEFAULTS.MAX_UPLOAD_BYTES;

  // --- production hardening: safe defaults that never weaken security in production ---
  if (isProduction) {
    if (debug) {
      issues.push({
        variable: 'SECURITY_DEBUG',
        code: 'unsafe_in_production',
        message: 'SECURITY_DEBUG must be false in production (disclosure-safe default)',
      });
      debug = false;
    }
    if (!redactionEnabled) {
      issues.push({
        variable: 'TELEMETRY_REDACTION_ENABLED',
        code: 'unsafe_in_production',
        message:
          'TELEMETRY_REDACTION_ENABLED must remain true in production (no secrets in telemetry)',
      });
      redactionEnabled = true;
    }
    if (!requireTls && !present(rawRequireTls)) {
      // Safe default tightening: production requires TLS unless explicitly (and validly) set.
      requireTls = true;
      warnings.push('HTTP_REQUIRE_TLS defaulted to true for production');
    } else if (!requireTls) {
      issues.push({
        variable: 'HTTP_REQUIRE_TLS',
        code: 'unsafe_in_production',
        message: 'HTTP_REQUIRE_TLS must be true in production',
      });
      requireTls = true;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const env: AppEnvironment = {
    stage,
    isProduction,
    server: { host, port, requireTls },
    database: { urlRef: urlRef!, poolMax, connectTimeoutMillis },
    messaging: { natsUrl, streamPrefix },
    telemetry: { redactionEnabled, sampleRatio, endpointRef },
    security: { debug, signingKeyRef: signingKeyRef!, sessionSecretRef: sessionSecretRef! },
    limits: { requestTimeoutMillis, maxUploadBytes },
  };
  return { ok: true, env, warnings };
}

function resolveSecretRef(
  variable: string,
  value: string,
  issues: EnvironmentIssue[],
): SecretReference | null {
  const parsed = parseSecretReference(variable, value);
  if ('issue' in parsed) {
    issues.push(parsed.issue);
    return null;
  }
  return parsed.ref;
}

function requireSecretRef(
  variable: string,
  value: string | undefined,
  issues: EnvironmentIssue[],
): SecretReference | null {
  if (!present(value)) {
    issues.push({
      variable,
      code: 'missing_required',
      message: `${variable} is required and must be a secret reference`,
    });
    return null;
  }
  return resolveSecretRef(variable, value, issues);
}

/**
 * Fail-fast variant for application boot. Throws an `EnvironmentValidationError` carrying the
 * disclosure-safe issue list (no values are ever embedded in the message).
 */
export function parseEnvironmentOrThrow(raw: RawEnvironment): AppEnvironment {
  const result = parseEnvironment(raw);
  if (!result.ok) {
    throw new EnvironmentValidationError(result.issues);
  }
  return result.env;
}

export class EnvironmentValidationError extends Error {
  readonly issues: readonly EnvironmentIssue[];
  constructor(issues: readonly EnvironmentIssue[]) {
    super(
      `environment validation failed for ${issues.length} variable(s): ${issues
        .map((i) => `${i.variable} (${i.code})`)
        .join(', ')}`,
    );
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Disclosure-safe rendering — proves the config never leaks secrets.
// ---------------------------------------------------------------------------

/**
 * Render an `AppEnvironment` to a string that is safe to log: secret references are shown as
 * `scheme:<redacted>` so neither the locator nor any resolved value is disclosed. This is the
 * property that lets consumers log their effective config without exfiltrating secrets.
 */
export function toRedactedString(env: AppEnvironment): string {
  const ref = (r: SecretReference | null): string => (r ? `${r.scheme}:<redacted>` : 'none');
  return JSON.stringify(
    {
      stage: env.stage,
      server: env.server,
      database: { urlRef: ref(env.database.urlRef), poolMax: env.database.poolMax },
      messaging: env.messaging,
      telemetry: {
        redactionEnabled: env.telemetry.redactionEnabled,
        sampleRatio: env.telemetry.sampleRatio,
        endpointRef: ref(env.telemetry.endpointRef),
      },
      security: {
        debug: env.security.debug,
        signingKeyRef: ref(env.security.signingKeyRef),
        sessionSecretRef: ref(env.security.sessionSecretRef),
      },
      limits: env.limits,
    },
    null,
    2,
  );
}
