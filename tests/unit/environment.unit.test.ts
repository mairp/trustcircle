// Phase 7 unit suite — typed environment parsing, secret-reference validation, and safe
// defaults (packages/application/src/config/environment.ts).
//
// Oracle (VO-ec575c4ce42b548bfb4d): "Changes to inventory, decisions, lifecycle states,
// source contracts, evidence, mappings, and exports MUST preserve supported consumers or
// provide approved deprecation, migration, rollback, notice, and compatibility evidence."
//
// This suite makes the environment source contract independently observable: the exported
// symbol inventory, the variable inventory, the safe-default table, typed coercion, the
// secret-reference grammar (inline-secret rejection), and production hardening. Each positive
// assertion is paired with a negative control so the oracle is non-vacuous. It imports the
// module directly (Node 22 strips the `.ts` types) so it runs under `vitest run --project unit`.

import { describe, it, expect } from 'vitest';
import {
  parseEnvironment,
  parseEnvironmentOrThrow,
  parseSecretReference,
  toRedactedString,
  EnvironmentValidationError,
  DEPLOYMENT_STAGES,
  SECRET_REFERENCE_SCHEMES,
  ENVIRONMENT_VARIABLE_NAMES,
  SECRET_REFERENCE_VARIABLE_NAMES,
  SAFE_DEFAULTS,
  type RawEnvironment,
  type AppEnvironment,
} from '../../packages/application/src/config/environment.ts';

// A minimally-valid raw environment: the required secret refs + DATABASE_URL, everything
// else defaulted. Individual tests override single keys.
const base = (over: Record<string, string | undefined> = {}): RawEnvironment => ({
  DATABASE_URL: 'postgres://app@db.internal:5432/trustcircle',
  SIGNING_KEY_SECRET_REF: 'vault:secret/data/signing#key',
  SESSION_SECRET_REF: 'env:SESSION_SECRET_MATERIAL',
  ...over,
});

function ok(result: ReturnType<typeof parseEnvironment>): AppEnvironment {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result.env;
}

// ---------------------------------------------------------------------------
describe('exported source contract (VO-ec575c4c: exports preserve consumers)', () => {
  it('exports the stable symbol surface consumers depend on', () => {
    expect(typeof parseEnvironment).toBe('function');
    expect(typeof parseEnvironmentOrThrow).toBe('function');
    expect(typeof parseSecretReference).toBe('function');
    expect(typeof toRedactedString).toBe('function');
    expect(typeof EnvironmentValidationError).toBe('function');
  });

  it('pins the deployment-stage and secret-scheme enums', () => {
    expect(DEPLOYMENT_STAGES).toEqual(['development', 'test', 'staging', 'production']);
    expect(SECRET_REFERENCE_SCHEMES).toContain('vault');
    expect(SECRET_REFERENCE_SCHEMES).toContain('env');
    expect(SECRET_REFERENCE_SCHEMES).toContain('awssm');
  });

  it('pins the environment-variable inventory (adding/removing is a visible contract change)', () => {
    for (const name of [
      'DEPLOYMENT_STAGE',
      'DATABASE_URL',
      'SIGNING_KEY_SECRET_REF',
      'SESSION_SECRET_REF',
      'TELEMETRY_REDACTION_ENABLED',
    ]) {
      expect(ENVIRONMENT_VARIABLE_NAMES).toContain(name);
    }
    // Negative control: a name that is NOT part of the contract is absent.
    expect(ENVIRONMENT_VARIABLE_NAMES).not.toContain('DEBUG_EVERYTHING');
  });

  it('SAFE_DEFAULTS is frozen and never defaults a secret', () => {
    expect(Object.isFrozen(SAFE_DEFAULTS)).toBe(true);
    for (const secretVar of SECRET_REFERENCE_VARIABLE_NAMES) {
      expect(secretVar in SAFE_DEFAULTS).toBe(false);
    }
    expect('DATABASE_URL' in SAFE_DEFAULTS).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('safe defaults', () => {
  it('applies safe defaults when optional variables are absent', () => {
    const env = ok(parseEnvironment(base()));
    expect(env.stage).toBe('development');
    expect(env.server.host).toBe(SAFE_DEFAULTS.HTTP_HOST);
    expect(env.server.port).toBe(SAFE_DEFAULTS.HTTP_PORT);
    expect(env.telemetry.redactionEnabled).toBe(true);
    expect(env.database.poolMax).toBe(SAFE_DEFAULTS.DATABASE_POOL_MAX);
  });

  it('honors explicit overrides over defaults (negative control for "defaults always win")', () => {
    const env = ok(parseEnvironment(base({ HTTP_PORT: '9443', HTTP_HOST: '0.0.0.0' })));
    expect(env.server.port).toBe(9443);
    expect(env.server.host).toBe('0.0.0.0');
    expect(env.server.port).not.toBe(SAFE_DEFAULTS.HTTP_PORT);
  });
});

// ---------------------------------------------------------------------------
describe('typed coercion + fail-closed validation', () => {
  it('coerces booleans and integers from strings', () => {
    const env = ok(parseEnvironment(base({ HTTP_REQUIRE_TLS: 'true', DATABASE_POOL_MAX: '42' })));
    expect(env.server.requireTls).toBe(true);
    expect(env.database.poolMax).toBe(42);
  });

  it('rejects a non-integer where an integer is required (fail-closed)', () => {
    const result = parseEnvironment(base({ HTTP_PORT: 'not-a-number' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.some((i) => i.variable === 'HTTP_PORT' && i.code === 'invalid_type')).toBe(
      true,
    );
  });

  it('rejects an out-of-range integer', () => {
    const result = parseEnvironment(base({ HTTP_PORT: '70000' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.some((i) => i.code === 'out_of_range')).toBe(true);
  });

  it('rejects an invalid deployment stage', () => {
    const result = parseEnvironment(base({ DEPLOYMENT_STAGE: 'prod' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a telemetry sample ratio outside [0,1]', () => {
    const result = parseEnvironment(base({ TELEMETRY_SAMPLE_RATIO: '2.0' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.some((i) => i.variable === 'TELEMETRY_SAMPLE_RATIO')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('required variables', () => {
  it('requires DATABASE_URL and both secret refs', () => {
    const result = parseEnvironment({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const missing = result.issues
      .filter((i) => i.code === 'missing_required')
      .map((i) => i.variable);
    expect(missing).toContain('DATABASE_URL');
    expect(missing).toContain('SIGNING_KEY_SECRET_REF');
    expect(missing).toContain('SESSION_SECRET_REF');
  });

  it('accepts a fully-populated environment (negative control for "always fails")', () => {
    expect(parseEnvironment(base()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('secret-reference validation (data-model: credential_ref = reference only)', () => {
  it('accepts every supported reference scheme', () => {
    expect('ref' in parseSecretReference('X', 'env:OTHER_VAR')).toBe(true);
    expect('ref' in parseSecretReference('X', 'file:/etc/secret')).toBe(true);
    expect('ref' in parseSecretReference('X', 'vault:secret/data/p#key')).toBe(true);
    expect('ref' in parseSecretReference('X', 'awssm:arn:aws:secretsmanager:us:1:secret:s')).toBe(
      true,
    );
    expect('ref' in parseSecretReference('X', 'k8s:ns/name#key')).toBe(true);
  });

  it('REJECTS an inline secret literal (the core safety property)', () => {
    const r = parseSecretReference('SIGNING_KEY_SECRET_REF', 'super-secret-plaintext-value');
    expect('issue' in r).toBe(true);
    if (!('issue' in r)) throw new Error('unreachable');
    expect(r.issue.code).toBe('inline_secret_forbidden');
  });

  it('REJECTS an unsupported scheme', () => {
    const r = parseSecretReference('X', 'http://leak.example/secret');
    expect('issue' in r).toBe(true);
    if (!('issue' in r)) throw new Error('unreachable');
    expect(r.issue.code).toBe('unsupported_secret_scheme');
  });

  it('REJECTS a malformed reference (missing locator / bad env name / relative file)', () => {
    expect('issue' in parseSecretReference('X', 'vault:')).toBe(true);
    expect('issue' in parseSecretReference('X', 'env:lower-case')).toBe(true);
    expect('issue' in parseSecretReference('X', 'file:relative/path')).toBe(true);
    expect('issue' in parseSecretReference('X', 'vault:no-hash-key')).toBe(true);
  });

  it('rejects an inline password embedded in DATABASE_URL', () => {
    const result = parseEnvironment(
      base({ DATABASE_URL: 'postgres://app:hunter2@db.internal:5432/tc' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(
      result.issues.some(
        (i) => i.variable === 'DATABASE_URL' && i.code === 'inline_secret_forbidden',
      ),
    ).toBe(true);
  });

  it('feeds secret-ref validation through the top-level parser', () => {
    const result = parseEnvironment(base({ SIGNING_KEY_SECRET_REF: 'inline-not-a-ref' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(
      result.issues.some(
        (i) => i.variable === 'SIGNING_KEY_SECRET_REF' && i.code === 'inline_secret_forbidden',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('production hardening (safe defaults never weaken security in production)', () => {
  const prod = (over: Record<string, string | undefined> = {}): RawEnvironment =>
    base({ DEPLOYMENT_STAGE: 'production', HTTP_REQUIRE_TLS: 'true', ...over });

  it('defaults TLS on and redaction on in production', () => {
    const env = ok(parseEnvironment(prod()));
    expect(env.isProduction).toBe(true);
    expect(env.server.requireTls).toBe(true);
    expect(env.telemetry.redactionEnabled).toBe(true);
  });

  it('REJECTS debug=true in production', () => {
    const result = parseEnvironment(prod({ SECURITY_DEBUG: 'true' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(
      result.issues.some(
        (i) => i.variable === 'SECURITY_DEBUG' && i.code === 'unsafe_in_production',
      ),
    ).toBe(true);
  });

  it('REJECTS telemetry redaction disabled in production', () => {
    const result = parseEnvironment(prod({ TELEMETRY_REDACTION_ENABLED: 'false' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.issues.some((i) => i.code === 'unsafe_in_production')).toBe(true);
  });

  it('REJECTS explicit TLS=false in production', () => {
    const result = parseEnvironment(prod({ HTTP_REQUIRE_TLS: 'false' }));
    expect(result.ok).toBe(false);
  });

  it('allows debug=true in development (negative control: hardening is prod-only)', () => {
    const env = ok(parseEnvironment(base({ SECURITY_DEBUG: 'true' })));
    expect(env.security.debug).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('disclosure-safe rendering + fail-fast boot', () => {
  it('never leaks secret locators or values in toRedactedString', () => {
    const env = ok(
      parseEnvironment(base({ SIGNING_KEY_SECRET_REF: 'vault:secret/data/topsecret#k' })),
    );
    const rendered = toRedactedString(env);
    expect(rendered).not.toContain('topsecret');
    expect(rendered).toContain('vault:<redacted>');
  });

  it('parseEnvironmentOrThrow throws an EnvironmentValidationError with no leaked values', () => {
    let thrown: unknown;
    try {
      parseEnvironmentOrThrow(base({ SIGNING_KEY_SECRET_REF: 'super-secret-plaintext' }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EnvironmentValidationError);
    expect((thrown as Error).message).not.toContain('super-secret-plaintext');
    expect((thrown as EnvironmentValidationError).issues.length).toBeGreaterThan(0);
  });

  it('parseEnvironmentOrThrow returns the typed env on success', () => {
    const env = parseEnvironmentOrThrow(base());
    expect(env.stage).toBe('development');
  });
});
