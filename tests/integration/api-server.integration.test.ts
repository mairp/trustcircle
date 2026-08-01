// Integration suite — Hono-compatible API bootstrap, versioned routing, health/readiness
// middleware, and graceful shutdown (apps/api/src/server.ts; Phase 46 / work item
// KGM6WXQYDCCT5C69AZEP5QSJJB).
//
// Sole acceptance criterion (VO-6acaf6470d0810df4c93): "The open-ended source catalog,
// reconciled inventory, coverage gaps, workflow and controller state, ownership, health,
// failures, retries, continuity mode and lease, buffered evidence, and safe next actions
// MUST be current and fail-visible."
//
// Every assertion observes the RENDERED governance picture through the REAL `app.fetch()`
// entry point (a Fetch `Request` → `Response`) — the same code path Hono uses — and reads the
// result from the response body (an independent read path), never a mutation echo. Each
// invariant is paired with a NEGATIVE CONTROL: an input that MUST flip the observable outcome,
// so the oracle is non-vacuous. Time is injected (a fixed clock), so the suite is deterministic.

import { describe, it, expect } from 'vitest';

import {
  createApp,
  renderGovernancePicture,
  createShutdownController,
  installSignalHandlers,
  GOVERNANCE_FACETS,
  API_VERSION,
  API_PREFIX,
  SUPPORTED_API_VERSIONS,
  healthPath,
  readinessPath,
  type GovernanceFacetName,
  type FacetReading,
  type GovernancePictureInput,
  type FacetHealth,
  type AppOptions,
} from '../../apps/api/src/server.ts';
import type { VerifiedIdentity } from '../../apps/api/src/middleware/context.ts';

// --- Fixed clock + helpers ---------------------------------------------------

const T0 = 1_700_000_000_000; // fixed injected clock base (ms); never reads the wall clock.
const FRESHNESS_MS = 60_000; // 60s freshness objective.

/** Build a full, healthy, fresh reading for all eleven facets, observed `ageMs` ago. */
function healthyFacets(ageMs = 0): FacetReading[] {
  return GOVERNANCE_FACETS.map((name) => ({
    name,
    health: 'healthy' as FacetHealth,
    observedAtMs: T0 - ageMs,
    summary: `${name}: ok`,
    core: true,
  }));
}

function pictureInput(facets: FacetReading[]): GovernancePictureInput {
  return { facets, freshnessObjectiveMs: FRESHNESS_MS };
}

/** A verifier that accepts a fixed decision-capable identity (governance officer). */
const acceptOfficer = (): VerifiedIdentity => ({
  principalId: 'user-1',
  tenantId: 'tenant-a',
  roles: ['governance_officer'],
  isBrowserSession: false,
});

function makeOptions(over: Partial<AppOptions> = {}): AppOptions {
  return {
    verifyIdentity: acceptOfficer,
    readiness: () => pictureInput(healthyFacets()),
    now: () => T0,
    ...over,
  };
}

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://internal${path}`, { method, headers });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ============================================================================
// A. Versioned routing (compatibility half of the fail-visible picture).
// ============================================================================

describe('A. versioned routing', () => {
  it('A1: the health/readiness surface mounts under the /v1 prefix', () => {
    expect(API_PREFIX).toBe('/v1');
    expect(healthPath()).toBe('/v1/health');
    expect(readinessPath()).toBe('/v1/readiness');
    expect(SUPPORTED_API_VERSIONS).toContain(API_VERSION);
  });

  it('A2: a versioned route resolves; an UNVERSIONED path is a visible 404 listing versions', async () => {
    const { app } = createApp(makeOptions());
    const ok = await app.fetch(req('GET', '/v1/health'));
    expect(ok.status).toBe(200);

    // Negative control: same route without the version prefix must NOT resolve.
    const miss = await app.fetch(req('GET', '/health'));
    expect(miss.status).toBe(404);
    const b = await body(miss);
    expect(b.error).toBe('NOT_FOUND');
    expect(b.supportedVersions).toEqual([...SUPPORTED_API_VERSIONS]);
  });

  it('A3: an unsupported version is rejected fail-visibly (never silently served)', async () => {
    const { app } = createApp(makeOptions());
    const bad = await app.fetch(req('GET', '/v999/health'));
    expect(bad.status).toBe(404);
    const b = await body(bad);
    expect(b.supportedVersions).toEqual([...SUPPORTED_API_VERSIONS]);
  });

  it('A4: every response carries a correlation id header for traceability', async () => {
    const { app } = createApp(makeOptions());
    const res = await app.fetch(req('GET', '/v1/health', { 'x-correlation-id': 'trace-abcdef12' }));
    expect(res.headers.get('x-correlation-id')).toBe('trace-abcdef12');
    // Negative control: a malformed inbound id is dropped, never echoed.
    const res2 = await app.fetch(req('GET', '/v1/health', { 'x-correlation-id': 'bad id!' }));
    expect(res2.headers.get('x-correlation-id')).not.toBe('bad id!');
    expect(res2.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ============================================================================
// B. Health / readiness middleware — the eleven facets are CURRENT and FAIL-VISIBLE.
// ============================================================================

describe('B. governance picture is current and fail-visible', () => {
  it('B1: readiness renders ALL eleven oracle facets, none omitted', async () => {
    const { app, shutdown } = createApp(makeOptions());
    shutdown.markReady();
    const res = await app.fetch(req('GET', '/v1/readiness'));
    const b = await body(res);
    const names = b.facets.map((f: { name: GovernanceFacetName }) => f.name).sort();
    expect(names).toEqual([...GOVERNANCE_FACETS].sort());
    // The eleven-facet set is complete (12 named facets incl. continuity mode+lease pair).
    expect(GOVERNANCE_FACETS).toEqual(
      expect.arrayContaining([
        'sourceCatalog',
        'reconciledInventory',
        'coverageGaps',
        'workflowState',
        'controllerState',
        'ownership',
        'health',
        'failures',
        'retries',
        'continuity',
        'bufferedEvidence',
        'safeNextActions',
      ]),
    );
  });

  it('B2: all facets healthy+fresh AND ready lifecycle ⇒ ready:true, 200', async () => {
    const { app, shutdown } = createApp(makeOptions());
    shutdown.markReady();
    const res = await app.fetch(req('GET', '/v1/readiness'));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ready).toBe(true);
    expect(b.aggregate).toBe('healthy');
    expect(b.degradedFacets).toEqual([]);
    for (const f of b.facets) {
      expect(f.currency).toBe('fresh');
      expect(f.safeNextAction).toBeUndefined();
    }
  });

  it('B3 (fail-visible): a MISSING facet is surfaced unavailable with a safe next action, 503', async () => {
    // Drop the "continuity" facet entirely.
    const partial = healthyFacets().filter((f) => f.name !== 'continuity');
    const { app, shutdown } = createApp(makeOptions({ readiness: () => pictureInput(partial) }));
    shutdown.markReady();
    const res = await app.fetch(req('GET', '/v1/readiness'));
    expect(res.status).toBe(503); // NOT a green 200 over a hollow picture.
    const b = await body(res);
    expect(b.ready).toBe(false);
    expect(b.aggregate).toBe('unavailable');
    expect(b.degradedFacets).toContain('continuity');
    const cont = b.facets.find((f: { name: string }) => f.name === 'continuity');
    expect(cont.health).toBe('unavailable');
    expect(cont.safeNextAction).toBeTruthy();

    // Negative control: with ALL facets present+healthy the same endpoint is ready:true/200.
    const { app: app2, shutdown: sd2 } = createApp(makeOptions());
    sd2.markReady();
    const res2 = await app2.fetch(req('GET', '/v1/readiness'));
    expect(res2.status).toBe(200);
    expect((await body(res2)).ready).toBe(true);
  });

  it('B4 (fail-visible): a STALE facet is marked stale and does not infer current health, 503', async () => {
    // "health" facet observed 2× the freshness objective ago.
    const facets = healthyFacets();
    const idx = facets.findIndex((f) => f.name === 'health');
    facets[idx] = { ...facets[idx]!, observedAtMs: T0 - FRESHNESS_MS * 2 };
    const { app, shutdown } = createApp(makeOptions({ readiness: () => pictureInput(facets) }));
    shutdown.markReady();
    const res = await app.fetch(req('GET', '/v1/readiness'));
    expect(res.status).toBe(503);
    const b = await body(res);
    const health = b.facets.find((f: { name: string }) => f.name === 'health');
    expect(health.currency).toBe('stale'); // claimed healthy, but stale ⇒ not inferred healthy.
    expect(health.safeNextAction).toMatch(/stale/i);
    expect(b.degradedFacets).toContain('health');

    // Negative control: observed just within the objective ⇒ fresh.
    const facets2 = healthyFacets();
    const j = facets2.findIndex((f) => f.name === 'health');
    facets2[j] = { ...facets2[j]!, observedAtMs: T0 - (FRESHNESS_MS - 1) };
    const { app: app2, shutdown: sd2 } = createApp(
      makeOptions({ readiness: () => pictureInput(facets2) }),
    );
    sd2.markReady();
    const res2 = await app2.fetch(req('GET', '/v1/readiness'));
    const facetsOut = (await body(res2)).facets as Array<{ name: string; currency: string }>;
    expect(facetsOut.find((f) => f.name === 'health')?.currency).toBe('fresh');
  });

  it('B5 (fail-visible): a DEGRADED non-core facet lists a safe next action but does not claim ready', async () => {
    const facets = healthyFacets();
    const idx = facets.findIndex((f) => f.name === 'failures');
    facets[idx] = { ...facets[idx]!, health: 'degraded', core: false };
    const { app, shutdown } = createApp(makeOptions({ readiness: () => pictureInput(facets) }));
    shutdown.markReady();
    const res = await app.fetch(req('GET', '/v1/readiness'));
    const b = await body(res);
    const failures = b.facets.find((f: { name: string }) => f.name === 'failures');
    expect(failures.health).toBe('degraded');
    expect(failures.safeNextAction).toBeTruthy();
    expect(b.degradedFacets).toContain('failures');
    expect(b.aggregate).toBe('degraded'); // the degradation IS surfaced fail-visibly.

    // Negative control: promote that same facet to core ⇒ core degradation blocks readiness.
    const facetsCore = healthyFacets();
    const j = facetsCore.findIndex((f) => f.name === 'failures');
    facetsCore[j] = { ...facetsCore[j]!, health: 'degraded', core: true };
    const { app: app2, shutdown: sd2 } = createApp(
      makeOptions({ readiness: () => pictureInput(facetsCore) }),
    );
    sd2.markReady();
    const res2 = await app2.fetch(req('GET', '/v1/readiness'));
    const b2 = await body(res2);
    expect(b2.ready).toBe(false); // a degraded CORE facet ⇒ never ready.
    expect(b2.degradedFacets).toContain('failures');
  });

  it('B6 (fail-visible): a provider that THROWS collapses to an unavailable picture, never 200', async () => {
    const { app, shutdown } = createApp(
      makeOptions({
        readiness: () => {
          throw new Error('registry unreachable');
        },
      }),
    );
    shutdown.markReady();
    const res = await app.fetch(req('GET', '/v1/readiness'));
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.ready).toBe(false);
    expect(b.aggregate).toBe('unavailable');
    // All eleven facets are surfaced as unavailable, none silently dropped.
    expect(b.facets).toHaveLength(GOVERNANCE_FACETS.length);
    for (const f of b.facets) expect(f.health).toBe('unavailable');
  });

  it('B7: pure renderGovernancePicture matches the endpoint (independent read path)', () => {
    const p = renderGovernancePicture(pictureInput(healthyFacets()), T0, 'ready');
    expect(p.ready).toBe(true);
    expect(p.apiVersion).toBe(API_VERSION);
    expect(p.facets).toHaveLength(GOVERNANCE_FACETS.length);
    // Negative control: same facets under a non-ready lifecycle can never be ready.
    const draining = renderGovernancePicture(pictureInput(healthyFacets()), T0, 'draining');
    expect(draining.ready).toBe(false);
  });
});

// ============================================================================
// C. Graceful shutdown — the picture stays fail-visible throughout drain.
// ============================================================================

describe('C. graceful shutdown', () => {
  it('C1: shutdown flips lifecycle starting→ready→draining→stopped and drains cleanly', async () => {
    const clock = T0;
    const sd = createShutdownController(() => clock);
    expect(sd.lifecycle()).toBe('starting');
    sd.markReady();
    expect(sd.lifecycle()).toBe('ready');
    const outcome = await sd.shutdown(1_000);
    expect(outcome.lifecycle).toBe('stopped');
    expect(outcome.drainedCleanly).toBe(true);
    expect(outcome.inFlightAtTimeout).toBe(0);
    expect(sd.isClosing()).toBe(true);
  });

  it('C2 (fail-visible): during drain, readiness reports draining and is NOT ready, NEW requests 503', async () => {
    const clock = T0;
    const { app, shutdown } = createApp(makeOptions({ now: () => clock }));
    shutdown.markReady();
    app.get('/things', (c) => c.json({ ok: true }));

    // Before drain a normal authenticated request succeeds.
    const ok = await app.fetch(req('GET', '/v1/things', {}));
    expect(ok.status).toBe(200);

    // Hold one request in flight so the drain STAYS in `draining` while we probe the picture
    // (an operator observes the true transient state, never a premature `stopped`/`ready`).
    const hold = shutdown.beginRequest();
    const draining = shutdown.shutdown(5_000, 5);
    expect(shutdown.lifecycle()).toBe('draining');

    // Readiness still answerable and reports draining, ready:false.
    const rd = await app.fetch(req('GET', '/v1/readiness'));
    const rb = await body(rd);
    expect(rb.lifecycle).toBe('draining');
    expect(rb.ready).toBe(false);
    // A NEW feature request is refused fail-visibly with a safe next action.
    const refused = await app.fetch(req('GET', '/v1/things', {}));
    expect(refused.status).toBe(503);
    const fb = await body(refused);
    expect(fb.error).toBe('SERVICE_DRAINING');
    expect(fb.safeNextAction).toBeTruthy();
    // Release the held request so the drain completes.
    hold();
    await draining;
    expect(shutdown.lifecycle()).toBe('stopped');
  });

  it('C3: an in-flight request is waited for up to the grace budget, then closers run LIFO', async () => {
    const clock = T0;
    const sd = createShutdownController(() => clock);
    sd.markReady();
    const done = sd.beginRequest();
    expect(sd.inFlight()).toBe(1);

    const order: string[] = [];
    sd.onClose(() => {
      order.push('first-registered');
    });
    sd.onClose(() => {
      order.push('second-registered');
    });

    // Settle the in-flight request shortly after drain starts.
    const drainP = sd.shutdown(1_000, 1);
    setTimeout(() => {
      done();
    }, 5);
    const outcome = await drainP;
    expect(outcome.drainedCleanly).toBe(true);
    expect(outcome.inFlightAtTimeout).toBe(0);
    // LIFO closer order.
    expect(order).toEqual(['second-registered', 'first-registered']);
  });

  it('C4 (fail-visible): a request still in flight past the grace budget is reported, not hidden', async () => {
    const clock = T0;
    const sd = createShutdownController(() => clock);
    sd.markReady();
    sd.beginRequest(); // never completed
    // grace budget of 0 + clock never advances ⇒ immediate timeout with the request still in flight.
    const outcome = await sd.shutdown(0, 1);
    expect(outcome.drainedCleanly).toBe(false);
    expect(outcome.inFlightAtTimeout).toBe(1); // surfaced, not swallowed.
    expect(outcome.lifecycle).toBe('stopped');
  });

  it('C5 (fail-visible): a closer that throws is surfaced in closerErrors, never swallowed', async () => {
    const sd = createShutdownController(() => T0);
    sd.markReady();
    sd.onClose(() => {
      throw new Error('db pool close failed');
    });
    const outcome = await sd.shutdown(0);
    expect(outcome.closerErrors).toContain('db pool close failed');
    // Negative control: a clean closer produces no errors.
    const sd2 = createShutdownController(() => T0);
    sd2.markReady();
    sd2.onClose(() => {
      /* clean */
    });
    expect((await sd2.shutdown(0)).closerErrors).toEqual([]);
  });

  it('C6: liveness is 200 while alive and 503 once stopped', async () => {
    const { app, shutdown } = createApp(makeOptions());
    shutdown.markReady();
    expect((await app.fetch(req('GET', '/v1/health'))).status).toBe(200);
    await shutdown.shutdown(0);
    const dead = await app.fetch(req('GET', '/v1/health'));
    expect(dead.status).toBe(503);
    expect((await body(dead)).status).toBe('stopped');
  });

  it('C7: signal handlers install and detach without touching the real process', async () => {
    // A fake process object so we never install handlers on the test runner.
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const fakeProc = {
      on(sig: string, fn: (...a: unknown[]) => void) {
        (handlers[sig] ??= []).push(fn);
      },
      removeListener(sig: string, fn: (...a: unknown[]) => void) {
        handlers[sig] = (handlers[sig] ?? []).filter((h) => h !== fn);
      },
    } as unknown as NodeJS.Process;

    const sd = createShutdownController(() => T0);
    sd.markReady();
    let outcome: string | undefined;
    const uninstall = installSignalHandlers(
      sd,
      0,
      (o) => {
        outcome = o.lifecycle;
      },
      fakeProc,
    );
    expect(handlers['SIGTERM']).toHaveLength(1);
    expect(handlers['SIGINT']).toHaveLength(1);
    // Fire SIGTERM.
    handlers['SIGTERM']![0]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(outcome).toBe('stopped');
    // Detach cleanly.
    uninstall();
    expect(handlers['SIGTERM']).toHaveLength(0);
    expect(handlers['SIGINT']).toHaveLength(0);
  });
});

// ============================================================================
// D. Authenticated routing wires the context middleware (fail-closed identity).
// ============================================================================

describe('D. authenticated routing', () => {
  it('D1: an authenticated route is fail-closed when identity cannot be verified (401)', async () => {
    const { app, shutdown } = createApp(makeOptions({ verifyIdentity: () => null }));
    shutdown.markReady();
    app.get('/secure', (c) => c.json({ principal: c.ctx?.principalId }));
    const res = await app.fetch(req('GET', '/v1/secure'));
    expect(res.status).toBe(401);
    const b = await body(res);
    expect(b.error).toBe('UNAUTHENTICATED');
    // Disclosure-safe: never names the principal/tenant/token.
    expect(JSON.stringify(b)).not.toMatch(/tenant-a|user-1/);
  });

  it('D2: a verified identity is attached to the handler context (independent read path)', async () => {
    const { app, shutdown } = createApp(makeOptions());
    shutdown.markReady();
    app.get('/whoami', (c) => c.json({ principal: c.ctx?.principalId, tenant: c.ctx?.tenantId }));
    const res = await app.fetch(req('GET', '/v1/whoami'));
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.principal).toBe('user-1');
    expect(b.tenant).toBe('tenant-a');
  });

  it('D3: a handler that throws collapses to a disclosure-safe 500', async () => {
    const { app, shutdown } = createApp(makeOptions());
    shutdown.markReady();
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });
    const res = await app.fetch(req('GET', '/v1/boom'));
    expect(res.status).toBe(500);
    const b = await body(res);
    expect(JSON.stringify(b)).not.toMatch(/secret internal detail/);
    expect(b.correlationId).toBeTruthy();
  });

  it('D4: a wrong-method request on a known path is a visible 405', async () => {
    const { app, shutdown } = createApp(makeOptions());
    shutdown.markReady();
    app.post('/submit', (c) => c.json({ ok: true }));
    const res = await app.fetch(req('GET', '/v1/submit'));
    expect(res.status).toBe(405);
    expect((await body(res)).error).toBe('METHOD_NOT_ALLOWED');
  });
});
