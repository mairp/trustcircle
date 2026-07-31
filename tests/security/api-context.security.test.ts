// Security-suite test — authenticated tenant context, CSRF protection, correlation IDs, and
// disclosure-safe errors (T041 / GAR-003 / VO-e4323651ab39776dcdbd).
//
// This proves the Vitest `security` project runs AND that the request-context middleware in
// apps/api/src/middleware/context.ts enforces its oracle behaviour. Each clause is asserted
// WITH a negative control so the oracle is non-vacuous.

import { describe, it, expect } from 'vitest';
import {
  establishRequestContext,
  csrfSatisfied,
  hasDecisionAuthority,
  isValidCorrelationId,
  resolveCorrelationId,
  disclosureSafeError,
  sanitizeUnexpectedError,
  MUTATING_METHODS,
  NON_DECISION_CONTEXT_ROLES,
  CONTEXT_HEADERS,
  type RequestLike,
  type VerifiedIdentity,
  type ContextRole,
} from '../../apps/api/src/middleware/context.ts';

// ---- Fixtures --------------------------------------------------------------

function req(overrides: Partial<RequestLike> = {}): RequestLike {
  return {
    method: 'GET',
    path: '/v1/inventory',
    headers: {},
    cookies: {},
    ...overrides,
  };
}

function identity(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    principalId: 'user-1',
    tenantId: 'tenant-a',
    roles: ['authorized_approver'] as ContextRole[],
    isBrowserSession: false,
    ...overrides,
  };
}

const allow = (id: VerifiedIdentity) => () => id;
const deny = () => null;

// ---- 1. Authenticated tenant context (fail-closed) -------------------------

describe('authenticated tenant context', () => {
  it('rejects a request with no valid identity (fail-closed, 401)', () => {
    const r = establishRequestContext(req(), deny);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(401);
      expect(r.error.body.error).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects an identity with a blank tenant (no ambient tenant allowed)', () => {
    const r = establishRequestContext(req(), allow(identity({ tenantId: '' })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.body.error).toBe('UNAUTHENTICATED');
  });

  it('POSITIVE: a verified identity yields a tenant-scoped context', () => {
    const r = establishRequestContext(req(), allow(identity()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.tenantId).toBe('tenant-a');
      expect(r.context.principalId).toBe('user-1');
    }
  });

  it('a verifier that throws is treated as denial, never surfaced', () => {
    const r = establishRequestContext(req(), () => {
      throw new Error('token store unreachable: secret=abc123');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toMatch(/abc123|token store/);
  });
});

// ---- 2. Platform-admin-alone grants no decision authority (GAR-003) --------

describe('decision-authority flag (platform admin alone → none)', () => {
  it('platform_admin/auditor/automation are non-decision roles', () => {
    for (const role of ['platform_admin', 'auditor', 'automation_principal'] as ContextRole[]) {
      expect(NON_DECISION_CONTEXT_ROLES.has(role)).toBe(true);
      expect(hasDecisionAuthority([role])).toBe(false);
    }
  });

  it('POSITIVE: a governance/approver role carries decision authority', () => {
    expect(hasDecisionAuthority(['authorized_approver'])).toBe(true);
    expect(hasDecisionAuthority(['platform_admin', 'governance_officer'])).toBe(true);
  });

  it('context surfaces hasDecisionAuthority=false for a platform-admin-only principal', () => {
    const r = establishRequestContext(req(), allow(identity({ roles: ['platform_admin'] })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.hasDecisionAuthority).toBe(false);
  });
});

// ---- 3. CSRF protection for browser mutations ------------------------------

describe('CSRF double-submit protection', () => {
  const browser = (extra: Partial<VerifiedIdentity> = {}) =>
    identity({ isBrowserSession: true, csrfSessionToken: 'sess-token', ...extra });

  it('safe methods (GET/HEAD/OPTIONS) never require CSRF', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS'] as const) {
      expect(csrfSatisfied(req({ method: m }), browser())).toBe(true);
    }
  });

  it('every mutating method requires CSRF for a browser session', () => {
    for (const m of MUTATING_METHODS) {
      const bad = csrfSatisfied(req({ method: m }), browser());
      expect(bad).toBe(false); // no header/cookie present → rejected
    }
  });

  it('NEGATIVE: browser POST with mismatched header/cookie is rejected', () => {
    const r = req({
      method: 'POST',
      headers: { [CONTEXT_HEADERS.csrf]: 'sess-token' },
      cookies: { [CONTEXT_HEADERS.csrfCookie]: 'DIFFERENT' },
    });
    expect(csrfSatisfied(r, browser())).toBe(false);
  });

  it('POSITIVE: browser POST with header==cookie==session token passes', () => {
    const r = req({
      method: 'POST',
      headers: { [CONTEXT_HEADERS.csrf]: 'sess-token' },
      cookies: { [CONTEXT_HEADERS.csrfCookie]: 'sess-token' },
    });
    expect(csrfSatisfied(r, browser())).toBe(true);
  });

  it('token-authenticated workloads (non-browser) are CSRF-exempt', () => {
    expect(csrfSatisfied(req({ method: 'POST' }), identity({ isBrowserSession: false }))).toBe(
      true,
    );
  });

  it('a browser mutation is rejected end-to-end with CSRF_REQUIRED (403)', () => {
    const r = establishRequestContext(req({ method: 'POST' }), allow(browser()));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(403);
      expect(r.error.body.error).toBe('CSRF_REQUIRED');
    }
  });
});

// ---- 4. Correlation IDs ----------------------------------------------------

describe('correlation ids', () => {
  it('accepts a well-formed inbound correlation id (trace continuity)', () => {
    expect(isValidCorrelationId('abcd-1234-EFGH')).toBe(true);
    const r = req({ headers: { [CONTEXT_HEADERS.correlation]: 'trace-abcdef01' } });
    expect(resolveCorrelationId(r)).toBe('trace-abcdef01');
  });

  it('NEGATIVE: rejects a malformed/injection inbound id and mints a fresh one', () => {
    expect(isValidCorrelationId('a b\r\nSet-Cookie: x')).toBe(false);
    const r = req({ headers: { [CONTEXT_HEADERS.correlation]: 'a b\r\nSet-Cookie: x' } });
    const resolved = resolveCorrelationId(r);
    expect(resolved).not.toContain('Set-Cookie');
    expect(isValidCorrelationId(resolved)).toBe(true); // a fresh uuid
  });

  it('a passing request is stamped with correlation + causation ids and echoes the header', () => {
    const r = establishRequestContext(req(), allow(identity()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(isValidCorrelationId(r.context.correlationId)).toBe(true);
      expect(isValidCorrelationId(r.context.causationId)).toBe(true);
      expect(r.context.causationId).not.toBe(r.context.correlationId);
      expect(r.responseHeaders[CONTEXT_HEADERS.correlation]).toBe(r.context.correlationId);
    }
  });
});

// ---- 5. Disclosure-safe errors ---------------------------------------------

describe('disclosure-safe errors', () => {
  it('error bodies carry only {error, message, correlationId}', () => {
    const e = disclosureSafeError('UNAUTHENTICATED', 'corr-12345678');
    expect(Object.keys(e.body).sort()).toEqual(['correlationId', 'error', 'message']);
    expect(e.body.correlationId).toBe('corr-12345678');
  });

  it('NEGATIVE: an unexpected internal error never leaks its message/stack', () => {
    const leaky = new Error('DB password=hunter2 at /srv/api/db.ts:42');
    const safe = sanitizeUnexpectedError(leaky, 'corr-abcdef99');
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toMatch(/hunter2|db\.ts|password/);
    expect(safe.status).toBe(500);
    expect(safe.body.correlationId).toBe('corr-abcdef99');
  });

  it('rejection bodies never contain tenant/principal/token values', () => {
    const r = establishRequestContext(
      req({ method: 'POST' }),
      allow(identity({ isBrowserSession: true, csrfSessionToken: 'super-secret-session' })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const s = JSON.stringify(r.error);
      expect(s).not.toMatch(/super-secret-session|tenant-a|user-1/);
    }
  });
});
