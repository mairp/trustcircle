// Security-suite test — production hardening: security headers, request/body limits, dependency
// timeouts, secret scanning, and production-safe defaults (T296 / GAR-010).
//
// Proves the Vitest `security` project runs AND that apps/api/src/security-hardening.ts enforces
// its posture. Every clause is asserted WITH a negative control so the oracle is non-vacuous.

import { describe, it, expect } from 'vitest';
import {
  SECURITY_HEADERS,
  FINGERPRINT_HEADERS,
  securityHeaders,
  securityHeaderRecord,
  DEFAULT_REQUEST_LIMITS,
  enforceRequestLimits,
  enforceReadLength,
  enforceJsonFieldCount,
  DEFAULT_DEPENDENCY_TIMEOUTS,
  DependencyTimeoutError,
  withDependencyTimeout,
  timeoutFor,
  scanForSecrets,
  containsSecret,
  redactSecrets,
  assertNoSecret,
  SECRET_REDACTION,
  resolveProductionDefaults,
  assertProductionSafe,
  isProduction,
  resolveHardeningPosture,
  type TimerLike,
} from '../../apps/api/src/security-hardening.ts';

describe('security headers', () => {
  it('applies a locked-down, fail-safe header set and strips fingerprints', () => {
    const store = new Map<string, string>([
      ['server', 'nginx/1.25'],
      ['x-powered-by', 'Express'],
    ]);
    const sink = {
      set: (n: string, v: string) => void store.set(n, v),
      delete: (n: string) => void store.delete(n),
    };
    securityHeaders(sink);
    // Positive: hardened headers present with the exact locked-down values.
    expect(store.get('content-security-policy')).toContain("default-src 'none'");
    expect(store.get('strict-transport-security')).toContain('max-age=31536000');
    expect(store.get('x-content-type-options')).toBe('nosniff');
    expect(store.get('x-frame-options')).toBe('DENY');
    expect(store.get('cache-control')).toBe('no-store');
    // Negative control: fingerprint headers were actually removed, not left behind.
    expect(store.has('server')).toBe(false);
    expect(store.has('x-powered-by')).toBe(false);
  });

  it('records every fingerprint header and exposes an immutable record', () => {
    expect(FINGERPRINT_HEADERS).toContain('server');
    expect(FINGERPRINT_HEADERS).toContain('x-powered-by');
    expect(Object.keys(securityHeaderRecord()).length).toBe(Object.keys(SECURITY_HEADERS).length);
    // Frozen: mutation attempts throw or no-op (negative control against accidental weakening).
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
  });
});

describe('request / body limits', () => {
  it('rejects an oversized body with 413 before buffering', () => {
    const over = enforceRequestLimits({
      method: 'POST',
      urlLength: 20,
      headerCount: 4,
      contentLength: DEFAULT_REQUEST_LIMITS.maxBodyBytes + 1,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.status).toBe(413);
      expect(over.code).toBe('payload_too_large');
    }
    // Negative control: an in-budget body passes.
    expect(
      enforceRequestLimits({ method: 'POST', urlLength: 20, headerCount: 4, contentLength: 100 })
        .ok,
    ).toBe(true);
  });

  it('rejects long URLs (414), too many headers (431), and unbounded reads', () => {
    expect(
      enforceRequestLimits({
        method: 'GET',
        urlLength: DEFAULT_REQUEST_LIMITS.maxUrlLength + 1,
        headerCount: 1,
      }).ok,
    ).toBe(false);
    expect(
      enforceRequestLimits({
        method: 'GET',
        urlLength: 1,
        headerCount: DEFAULT_REQUEST_LIMITS.maxHeaderCount + 1,
      }).ok,
    ).toBe(false);
    // Streaming guard fires when the running total overruns even with no content-length.
    const streamed = enforceReadLength(DEFAULT_REQUEST_LIMITS.maxBodyBytes + 10);
    expect(streamed.ok).toBe(false);
    expect(enforceReadLength(10).ok).toBe(true);
    // JSON field-count amplification guard.
    expect(enforceJsonFieldCount(DEFAULT_REQUEST_LIMITS.maxJsonFields + 1).ok).toBe(false);
    expect(enforceJsonFieldCount(3).ok).toBe(true);
  });
});

describe('dependency timeouts', () => {
  it('fails visibly and cancels the underlying work on overrun', async () => {
    let cancelled = false;
    // A timer that fires the timeout callback synchronously simulates an overrun deterministically.
    const eagerTimer: TimerLike = {
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    };
    await expect(
      withDependencyTimeout(
        'database',
        new Promise<never>(() => {}),
        DEFAULT_DEPENDENCY_TIMEOUTS.database,
        {
          timer: eagerTimer,
          onTimeout: () => {
            cancelled = true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(DependencyTimeoutError);
    expect(cancelled).toBe(true);
  });

  it('resolves the value when work settles before the timeout (negative control)', async () => {
    // A timer that never fires ensures the success path wins.
    const neverTimer: TimerLike = { setTimeout: () => 0, clearTimeout: () => {} };
    const value = await withDependencyTimeout('policyEngine', Promise.resolve(42), 1000, {
      timer: neverTimer,
    });
    expect(value).toBe(42);
  });

  it('looks up per-dependency budgets and falls back to default', () => {
    expect(timeoutFor('database')).toBe(DEFAULT_DEPENDENCY_TIMEOUTS.database);
    expect(timeoutFor('unknown-dependency')).toBe(DEFAULT_DEPENDENCY_TIMEOUTS.default);
  });
});

describe('secret scanning', () => {
  it('detects and redacts well-known secret shapes', () => {
    const text =
      'aws AKIAIOSFODNN7EXAMPLE and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    const findings = scanForSecrets(text);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('aws-access-key-id');
    expect(kinds).toContain('jwt');
    // Preview is non-reversible (no full secret leaked).
    expect(findings[0]?.preview).not.toContain('IOSFODNN7EXAMPLE');
    expect(containsSecret(text)).toBe(true);
    const redacted = redactSecrets(text);
    expect(redacted).toContain(SECRET_REDACTION);
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    // Idempotent.
    expect(redactSecrets(redacted)).toBe(redacted);
  });

  it('treats clean text as secret-free and assertNoSecret fails closed', () => {
    // Negative control: ordinary text has no findings.
    expect(scanForSecrets('the quick brown fox owns control 42')).toHaveLength(0);
    expect(() => assertNoSecret('env-dump', 'PORT=8080 LOG_LEVEL=info')).not.toThrow();
    // Fails closed when a secret appears where it must not.
    expect(() => assertNoSecret('error-body', 'db postgres://user:hunter2pw@host/db')).toThrow(
      /secret detected/,
    );
  });
});

describe('production-safe defaults', () => {
  it('refuses to start in production with unsafe defaults', () => {
    const cfg = resolveProductionDefaults({
      nodeEnv: 'production',
      tlsRequired: false,
      verboseErrors: true,
      sessionSecret: 'changeme',
    });
    expect(isProduction(cfg)).toBe(true);
    expect(() => assertProductionSafe(cfg)).toThrow(/refusing to start/);
  });

  it('accepts a properly hardened production config (negative control)', () => {
    const cfg = resolveProductionDefaults({
      nodeEnv: 'production',
      tlsRequired: true,
      sessionSecret: 'a-sufficiently-long-real-secret-value',
    });
    expect(assertProductionSafe(cfg)).toHaveLength(0);
    const posture = resolveHardeningPosture({
      nodeEnv: 'production',
      tlsRequired: true,
      sessionSecret: 'a-sufficiently-long-real-secret-value',
    });
    expect(posture.violations).toHaveLength(0);
    expect(Object.keys(posture.headers).length).toBeGreaterThan(0);
    expect(posture.strippedHeaders).toContain('server');
  });

  it('rejects a blank/short/well-known session secret and wildcard CORS in production', () => {
    for (const bad of ['', 'secret', 'dev', 'short']) {
      expect(() =>
        assertProductionSafe(
          resolveProductionDefaults({
            nodeEnv: 'production',
            tlsRequired: true,
            sessionSecret: bad,
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      assertProductionSafe(
        resolveProductionDefaults({
          nodeEnv: 'production',
          tlsRequired: true,
          sessionSecret: 'a-sufficiently-long-real-secret-value',
          corsAllowedOrigins: ['*'],
        }),
      ),
    ).toThrow(/CORS/);
  });

  it('does not throw outside production but surfaces warnings', () => {
    const violations = assertProductionSafe(
      resolveProductionDefaults({
        nodeEnv: 'development',
        tlsRequired: false,
        corsAllowedOrigins: ['*'],
      }),
    );
    expect(violations.some((v) => v.startsWith('warn:'))).toBe(true);
  });
});
