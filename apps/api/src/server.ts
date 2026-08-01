// @trustcircle/api — Hono-compatible API bootstrap, versioned routing, health/readiness
// middleware, and graceful shutdown (Phase 46 / work item KGM6WXQYDCCT5C69AZEP5QSJJB /
// VO-6acaf6470d0810df4c93).
//
// Oracle (VO-6acaf6470d0810df4c93): "The open-ended source catalog, reconciled inventory,
// coverage gaps, workflow and controller state, ownership, health, failures, retries,
// continuity mode and lease, buffered evidence, and safe next actions MUST be current and
// fail-visible."
//
// This module is the process-level bootstrap that MAKES that governance operating picture
// observable over HTTP and keeps it FAIL-VISIBLE:
//
//   1. A tiny, dependency-free HTTP application built on the Web Fetch `Request`/`Response`
//      types — the exact substrate Hono itself runs on (`app.fetch(request)`), so the same
//      routes mount unchanged on Hono/Node/Bun/Workers. Keeping it dependency-free means the
//      bootstrap is independently observable and testable under `npm ci` with no framework
//      installed, and it compiles under the strict shared base as a `composite` project.
//
//   2. VERSIONED ROUTING — every governed route lives under an explicit `/v{n}` prefix
//      (`API_VERSION` = 1 → `/v1/...`). An unversioned or wrong-version path is a visible
//      404 with the supported-version list, so a consumer can never silently bind to an
//      unversioned surface (the compatibility half of GAR-010).
//
//   3. HEALTH / READINESS MIDDLEWARE — `/v1/health` (liveness) and `/v1/readiness` (the full
//      governance operating picture). Readiness renders the ELEVEN oracle facets — the
//      open-ended source catalog, reconciled inventory, coverage gaps, workflow & controller
//      state, ownership, health, failures, retries, continuity mode & lease, buffered
//      evidence, and safe next actions — and stamps each with currency (`fresh` vs `stale`
//      against a freshness objective) so a stale, missing, or degraded facet is SURFACED, not
//      inferred-healthy. When any core facet is unavailable/stale the aggregate reports
//      `unavailable` and the endpoint returns 503 — fail-visible, never a green 200 over a
//      hollow picture.
//
//   4. GRACEFUL SHUTDOWN — a drain sequence that (a) flips readiness to `draining` so load
//      balancers stop routing new work, (b) stops accepting new requests (new requests get a
//      503 with a safe next action), (c) waits for in-flight requests to settle up to a bound,
//      then (d) runs registered resource closers. The picture stays fail-visible throughout:
//      an operator polling readiness sees `draining`/`stopped`, never a false `ready`.
//
// Dependency-free (Node built-in `crypto` for ids only); no clock/network is read implicitly —
// "now" is injected so the bootstrap is deterministic and unit-testable.

import { randomUUID } from 'node:crypto';

import {
  establishRequestContext,
  sanitizeUnexpectedError,
  isValidCorrelationId,
  CONTEXT_HEADERS,
  type RequestContext,
  type IdentityVerifier,
  type HttpMethod,
  type RequestLike,
} from './middleware/context.ts';

// ---------------------------------------------------------------------------
// Versioning contract.
// ---------------------------------------------------------------------------

/** The current major API version. All governed routes mount under `/v${API_VERSION}`. */
export const API_VERSION = 1 as const;

/** Every currently-served major version (only v1 today). Surfaced on version-miss 404s. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [API_VERSION];

/** The route prefix for the current version, e.g. `/v1`. */
export const API_PREFIX = `/v${API_VERSION}` as const;

// ---------------------------------------------------------------------------
// The governance operating picture (the oracle's eleven facets).
//
// Each facet is reported with its own currency so a stale/degraded facet is *visible*. The
// bootstrap does not compute these — a `ReadinessProvider` supplies them from the real
// sources (source registry, reconciliation, controllers, continuity leases, evidence buffer);
// the bootstrap's job is to render them fail-visibly and to fail closed when a facet is
// unreadable.
// ---------------------------------------------------------------------------

/** Coarse health of a single facet or of the aggregate picture. */
export type FacetHealth = 'healthy' | 'degraded' | 'unavailable';

/** Currency of a facet relative to the freshness objective. */
export type FacetCurrency = 'fresh' | 'stale';

/**
 * The eleven governance facets the oracle enumerates. Kept as a closed, exported union so a
 * dropped facet is a compile error, never a silent omission from the picture.
 */
export type GovernanceFacetName =
  | 'sourceCatalog' // the open-ended source catalog
  | 'reconciledInventory' // reconciled inventory
  | 'coverageGaps' // coverage gaps
  | 'workflowState' // workflow state
  | 'controllerState' // controller state
  | 'ownership' // ownership
  | 'health' // connector/controller health
  | 'failures' // failures
  | 'retries' // retry state
  | 'continuity' // continuity mode + lease
  | 'bufferedEvidence' // buffered evidence
  | 'safeNextActions'; // safe next actions

/** The canonical, ordered facet inventory. Every reading MUST cover exactly this set. */
export const GOVERNANCE_FACETS: readonly GovernanceFacetName[] = [
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
] as const;

/**
 * A single facet reading as supplied by the provider. `observedAtMs` is the source-observation
 * time; the bootstrap derives `stale` from it against the freshness objective — the provider
 * never gets to *claim* freshness it cannot support.
 */
export interface FacetReading {
  readonly name: GovernanceFacetName;
  readonly health: FacetHealth;
  /** When this facet was last observed from its authoritative source (ms epoch). */
  readonly observedAtMs: number;
  /** A human-safe, non-sensitive summary (counts / states) — never raw evidence content. */
  readonly summary: string;
  /** Whether this facet is required for the core control plane to be "ready". */
  readonly core: boolean;
}

/**
 * The raw picture a provider returns. It MUST include every {@link GovernanceFacetName}; a
 * missing facet is treated as `unavailable` (fail-visible), never assumed healthy.
 */
export interface GovernancePictureInput {
  readonly facets: readonly FacetReading[];
  /** Freshness objective in ms: a facet older than this is `stale`. */
  readonly freshnessObjectiveMs: number;
}

/** A facet reading enriched with derived currency + the safe next action when not fresh/healthy. */
export interface RenderedFacet {
  readonly name: GovernanceFacetName;
  readonly health: FacetHealth;
  readonly currency: FacetCurrency;
  readonly observedAtMs: number;
  readonly ageMs: number;
  readonly summary: string;
  readonly core: boolean;
  /** Present iff the facet is not (healthy AND fresh): the visible, alertable safe next action. */
  readonly safeNextAction?: string;
}

/** Lifecycle of the process as seen by an external prober. */
export type ServiceLifecycle = 'starting' | 'ready' | 'draining' | 'stopped';

/** The rendered, fail-visible governance operating picture. */
export interface GovernancePicture {
  /** Aggregate health: worst-of core facets; degraded if any non-core facet is off. */
  readonly aggregate: FacetHealth;
  readonly lifecycle: ServiceLifecycle;
  /** True iff EVERY facet is present, and every CORE facet is healthy AND fresh. */
  readonly ready: boolean;
  /** Facets that are missing, stale, or unhealthy — the fail-visible surface. */
  readonly degradedFacets: readonly GovernanceFacetName[];
  readonly facets: readonly RenderedFacet[];
  readonly freshnessObjectiveMs: number;
  readonly observedAtMs: number;
  readonly apiVersion: number;
}

/** A source of the current governance picture. Injected so the bootstrap stays pure. */
export type ReadinessProvider = () => GovernancePictureInput;

/**
 * Render the fail-visible governance picture from a provider input at time `nowMs`.
 *
 * Rules (all fail-visible):
 *   - Every one of the eleven facets MUST be present; a MISSING facet is synthesized as
 *     `unavailable`/`stale` with a safe next action — it can never silently vanish.
 *   - A facet older than the freshness objective is `stale` regardless of its claimed health.
 *   - A facet that is `unavailable` OR `stale` OR `degraded` carries a safe next action and is
 *     listed in `degradedFacets`.
 *   - Aggregate is `unavailable` if any CORE facet is unavailable or stale; otherwise
 *     `degraded` if any facet is degraded/stale; otherwise `healthy`.
 *   - `ready` is true only when every facet is present and every CORE facet is healthy AND
 *     fresh (and the lifecycle admits readiness).
 */
export function renderGovernancePicture(
  input: GovernancePictureInput,
  nowMs: number,
  lifecycle: ServiceLifecycle,
): GovernancePicture {
  const byName = new Map<GovernanceFacetName, FacetReading>();
  for (const f of input.facets) byName.set(f.name, f);

  const rendered: RenderedFacet[] = GOVERNANCE_FACETS.map((name) => {
    const reading = byName.get(name);
    if (!reading) {
      // Missing facet ⇒ fail-visible unavailable, not assumed-healthy.
      return {
        name,
        health: 'unavailable' as FacetHealth,
        currency: 'stale' as FacetCurrency,
        observedAtMs: 0,
        ageMs: Number.POSITIVE_INFINITY,
        summary: 'facet not reported',
        core: true,
        safeNextAction: safeNextActionFor(name, 'unavailable', 'stale'),
      };
    }
    const ageMs = Math.max(0, nowMs - reading.observedAtMs);
    const currency: FacetCurrency = ageMs > input.freshnessObjectiveMs ? 'stale' : 'fresh';
    const off = reading.health !== 'healthy' || currency !== 'fresh';
    return {
      name,
      health: reading.health,
      currency,
      observedAtMs: reading.observedAtMs,
      ageMs,
      summary: reading.summary,
      core: reading.core,
      ...(off ? { safeNextAction: safeNextActionFor(name, reading.health, currency) } : {}),
    };
  });

  const degradedFacets = rendered
    .filter((f) => f.health !== 'healthy' || f.currency !== 'fresh')
    .map((f) => f.name);

  const coreBroken = rendered.some(
    (f) => f.core && (f.health === 'unavailable' || f.currency === 'stale'),
  );
  const anyOff = rendered.some((f) => f.health !== 'healthy' || f.currency !== 'fresh');
  const aggregate: FacetHealth = coreBroken ? 'unavailable' : anyOff ? 'degraded' : 'healthy';

  const admitsReady = lifecycle === 'ready';
  const ready =
    admitsReady &&
    rendered.every((f) => (f.core ? f.health === 'healthy' && f.currency === 'fresh' : true));

  return {
    aggregate,
    lifecycle,
    ready,
    degradedFacets,
    facets: rendered,
    freshnessObjectiveMs: input.freshnessObjectiveMs,
    observedAtMs: nowMs,
    apiVersion: API_VERSION,
  };
}

/** A visible, alertable next action for a facet that is not (healthy AND fresh). */
function safeNextActionFor(
  name: GovernanceFacetName,
  health: FacetHealth,
  currency: FacetCurrency,
): string {
  if (health === 'unavailable') {
    return `${name} is unavailable: block dependent automation, alert the owning team, and reconcile before relying on this facet`;
  }
  if (currency === 'stale') {
    return `${name} is stale beyond the freshness objective: refresh from source and do not infer current health from last-known data`;
  }
  return `${name} is degraded: inspect ownership, last success/failure and retry state, and take the owner action before proceeding`;
}

// ---------------------------------------------------------------------------
// A minimal, dependency-free Hono-compatible application.
//
// The public surface mirrors the slice of Hono we depend on: `app.get/post(path, handler)`
// and `app.fetch(request)`. A `Context`-like object exposes the parsed request, the
// authenticated `RequestContext`, `json()`/`text()` responders, and header setters — so the
// same handlers run under Hono unchanged when the framework is present.
// ---------------------------------------------------------------------------

/** The handler context passed to each route — a compatible subset of Hono's `Context`. */
export interface AppContext {
  readonly req: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly url: string;
    header(name: string): string | undefined;
    /** Parse the request body as JSON (for POST/PUT/PATCH handlers). Rejects if the body is
     *  absent or not valid JSON — the handler is expected to translate that to a 400. Reads the
     *  underlying Fetch `Request` body exactly once. */
    json(): Promise<unknown>;
  };
  /** Populated by the context middleware once identity is verified; undefined on public routes. */
  ctx?: RequestContext;
  /** Respond with JSON and a status. */
  json(body: unknown, status?: number): Response;
  /** Respond with text and a status. */
  text(body: string, status?: number): Response;
  /** Set a response header applied to whatever the handler returns. */
  setHeader(name: string, value: string): void;
}

export type RouteHandler = (c: AppContext) => Response | Promise<Response>;

interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler;
  readonly requiresAuth: boolean;
}

/** Options controlling the app bootstrap. */
export interface AppOptions {
  /** Verifies inbound identity for authenticated routes (delegates to OIDC/workload validators). */
  readonly verifyIdentity: IdentityVerifier;
  /** Supplies the current governance picture for the readiness endpoint. */
  readonly readiness: ReadinessProvider;
  /** Injected clock (ms). Deterministic; never reads the wall clock implicitly. */
  readonly now: () => number;
}

/** Result of `app.fetch`, plus the lifecycle so probers can be tested without a socket. */
export interface App {
  /** Register a public (unauthenticated) GET route under the version prefix. */
  getPublic(path: string, handler: RouteHandler): App;
  /** Register an authenticated GET route under the version prefix. */
  get(path: string, handler: RouteHandler): App;
  /** Register an authenticated POST route under the version prefix. */
  post(path: string, handler: RouteHandler): App;
  /** Hono-compatible entry point: dispatch a Fetch `Request` to a `Response`. */
  fetch(request: Request): Promise<Response>;
  /** The current process lifecycle as seen by health probes. */
  lifecycle(): ServiceLifecycle;
}

/** Normalize a path so `/v1/health` and `v1/health` and trailing slashes route identically. */
function normalizePath(path: string): string {
  let p = path.split('?')[0] ?? path;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Parse the leading `/v{n}` segment of a path, if any. */
function parseVersion(path: string): { version: number | null; rest: string } {
  const m = /^\/v(\d+)(\/.*|)$/.exec(path);
  if (!m) return { version: null, rest: path };
  const tail = m[2] ?? '';
  return { version: Number(m[1]), rest: tail === '' ? '/' : tail };
}

/**
 * Create the API application. The returned `App` owns:
 *   - versioned route registration + dispatch,
 *   - the context (auth/CSRF/correlation) middleware for authenticated routes,
 *   - the built-in versioned health/readiness endpoints,
 *   - and the shutdown gate (`draining`/`stopped` short-circuits new requests).
 */
export function createApp(options: AppOptions): {
  readonly app: App;
  readonly shutdown: ShutdownController;
} {
  const routes: Route[] = [];
  const shutdown = createShutdownController(options.now);

  function register(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    requiresAuth: boolean,
  ): void {
    const full = normalizePath(`${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`);
    routes.push({ method, path: full, handler, requiresAuth });
  }

  const app: App = {
    getPublic(path, handler) {
      register('GET', path, handler, false);
      return app;
    },
    get(path, handler) {
      register('GET', path, handler, true);
      return app;
    },
    post(path, handler) {
      register('POST', path, handler, true);
      return app;
    },
    lifecycle() {
      return shutdown.lifecycle();
    },
    async fetch(request: Request): Promise<Response> {
      return dispatch(request, routes, options, shutdown);
    },
  };

  // Built-in, always-present versioned health surface. Registered first so a consumer always
  // has a fail-visible picture even before feature routes mount.
  registerHealthRoutes(app, options, shutdown);

  return { app, shutdown };
}

/** Extract a {@link RequestLike} view from a Fetch `Request` for the context middleware. */
function toRequestLike(request: Request, path: string): RequestLike {
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const cookies: Record<string, string | undefined> = {};
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    for (const pair of cookieHeader.split(';')) {
      const idx = pair.indexOf('=');
      if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return {
    method: request.method as HttpMethod,
    path,
    headers,
    cookies,
  };
}

/** Dispatch a request: shutdown gate → version routing → auth middleware → handler. */
async function dispatch(
  request: Request,
  routes: readonly Route[],
  options: AppOptions,
  shutdown: ShutdownController,
): Promise<Response> {
  const url = new URL(request.url, 'http://internal');
  const path = normalizePath(url.pathname);
  const method = request.method as HttpMethod;

  // Correlation id resolution happens even for rejected requests so every response is traceable.
  const inboundCorr = request.headers.get(CONTEXT_HEADERS.correlation) ?? undefined;
  const correlationId = isValidCorrelationId(inboundCorr) ? inboundCorr : randomUUID();

  // 1. Shutdown gate — once draining/stopped, NEW requests are refused fail-visibly. Health
  //    and readiness probes remain answerable so operators still see the true lifecycle.
  const isProbe = path === healthPath() || path === readinessPath();
  if (shutdown.isClosing() && !isProbe) {
    const body = {
      error: 'SERVICE_DRAINING',
      message: 'request rejected',
      correlationId,
      safeNextAction: 'the service is draining; retry against a healthy replica',
    };
    return jsonResponse(body, 503, { [CONTEXT_HEADERS.correlation]: correlationId });
  }

  // 2. Version routing. A path with no/wrong version is a visible 404 listing supported versions.
  const { version } = parseVersion(path);
  if (version === null || !SUPPORTED_API_VERSIONS.includes(version)) {
    const body = {
      error: 'NOT_FOUND',
      message: 'unknown api version or path',
      correlationId,
      supportedVersions: SUPPORTED_API_VERSIONS,
    };
    return jsonResponse(body, 404, { [CONTEXT_HEADERS.correlation]: correlationId });
  }

  // 3. Route match.
  const route = routes.find((r) => r.path === path && r.method === method);
  if (!route) {
    // Path exists at another method?
    const methodMismatch = routes.some((r) => r.path === path);
    const status = methodMismatch ? 405 : 404;
    const body = {
      error: methodMismatch ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
      message: 'unknown api version or path',
      correlationId,
      supportedVersions: SUPPORTED_API_VERSIONS,
    };
    return jsonResponse(body, status, { [CONTEXT_HEADERS.correlation]: correlationId });
  }

  // 4. Track the in-flight request so graceful shutdown can drain it.
  const done = shutdown.beginRequest();
  try {
    const extraHeaders: Record<string, string> = {};
    const reqView = {
      method,
      path,
      url: request.url,
      header: (name: string) => request.headers.get(name) ?? undefined,
      json: () => request.json(),
    };
    const c: AppContext = {
      req: reqView,
      json: (body, status = 200) => jsonResponse(body, status, extraHeaders),
      text: (body, status = 200) => textResponse(body, status, extraHeaders),
      setHeader: (name, value) => {
        extraHeaders[name] = value;
      },
    };

    // 5. Authenticated routes pass through the context middleware (identity/CSRF/correlation).
    if (route.requiresAuth) {
      const result = establishRequestContext(toRequestLike(request, path), options.verifyIdentity);
      if (!result.ok) {
        return jsonResponse(result.error.body, result.error.status, {
          [CONTEXT_HEADERS.correlation]: result.error.body.correlationId,
        });
      }
      c.ctx = result.context;
      for (const [k, v] of Object.entries(result.responseHeaders)) extraHeaders[k] = v;
    } else {
      extraHeaders[CONTEXT_HEADERS.correlation] = correlationId;
    }

    try {
      return await route.handler(c);
    } catch (err) {
      // 6. Any unexpected handler failure collapses to a disclosure-safe 500.
      const safe = sanitizeUnexpectedError(
        err,
        extraHeaders[CONTEXT_HEADERS.correlation] ?? correlationId,
      );
      return jsonResponse(safe.body, safe.status, {
        [CONTEXT_HEADERS.correlation]: extraHeaders[CONTEXT_HEADERS.correlation] ?? correlationId,
      });
    }
  } finally {
    done();
  }
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function textResponse(body: string, status: number, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}

// ---------------------------------------------------------------------------
// Built-in versioned health / readiness routes.
// ---------------------------------------------------------------------------

/** The path of the liveness endpoint (`/v1/health`). */
export function healthPath(): string {
  return normalizePath(`${API_PREFIX}/health`);
}

/** The path of the readiness endpoint (`/v1/readiness`). */
export function readinessPath(): string {
  return normalizePath(`${API_PREFIX}/readiness`);
}

function registerHealthRoutes(app: App, options: AppOptions, shutdown: ShutdownController): void {
  // Liveness — cheap "the process is up". Never 200 while stopped.
  app.getPublic('/health', (c) => {
    const lifecycle = shutdown.lifecycle();
    const alive = lifecycle !== 'stopped';
    return c.json(
      { status: alive ? 'alive' : 'stopped', lifecycle, apiVersion: API_VERSION },
      alive ? 200 : 503,
    );
  });

  // Readiness — the full, fail-visible governance operating picture.
  app.getPublic('/readiness', (c) => {
    const lifecycle = shutdown.lifecycle();
    let input: GovernancePictureInput;
    try {
      input = options.readiness();
    } catch {
      // A provider that cannot answer is itself a fail-visible unavailable picture.
      input = { facets: [], freshnessObjectiveMs: 0 };
    }
    const picture = renderGovernancePicture(input, options.now(), lifecycle);
    // Fail-visible status: ready ⇒ 200; anything else (draining/degraded/unavailable) ⇒ 503.
    const status = picture.ready ? 200 : 503;
    return c.json(picture, status);
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown controller.
// ---------------------------------------------------------------------------

/** A resource closer run during drain (db pools, bus consumers, evidence buffers, …). */
export type ResourceCloser = () => void | Promise<void>;

/** The result of a drain, so an operator/test can see exactly what happened. */
export interface DrainOutcome {
  readonly lifecycle: ServiceLifecycle;
  /** True iff in-flight requests settled within the grace budget. */
  readonly drainedCleanly: boolean;
  /** Requests still in flight when the grace budget elapsed (0 on a clean drain). */
  readonly inFlightAtTimeout: number;
  /** Closers that threw during shutdown — surfaced, never swallowed silently. */
  readonly closerErrors: readonly string[];
}

/** Controls the process lifecycle and drains in-flight work on shutdown. */
export interface ShutdownController {
  lifecycle(): ServiceLifecycle;
  /** True once shutdown has started (draining or stopped) — new work must be refused. */
  isClosing(): boolean;
  /** Number of in-flight requests currently tracked. */
  inFlight(): number;
  /** Mark the process ready to serve (starting → ready). Idempotent. */
  markReady(): void;
  /** Register a resource closer to run during drain, in LIFO order. */
  onClose(closer: ResourceCloser): void;
  /** Begin tracking an in-flight request; the returned fn MUST be called when it completes. */
  beginRequest(): () => void;
  /**
   * Gracefully shut down: flip to `draining` (readiness reports it, new requests refused),
   * wait for in-flight work up to `graceMs` (polling every `pollMs`), then run closers and
   * flip to `stopped`. Fail-visible: the returned outcome reports whether the drain was clean.
   */
  shutdown(graceMs: number, pollMs?: number): Promise<DrainOutcome>;
}

/** Create the shutdown controller with an injected clock. */
export function createShutdownController(now: () => number): ShutdownController {
  let lifecycle: ServiceLifecycle = 'starting';
  let inFlight = 0;
  const closers: ResourceCloser[] = [];

  const controller: ShutdownController = {
    lifecycle: () => lifecycle,
    isClosing: () => lifecycle === 'draining' || lifecycle === 'stopped',
    inFlight: () => inFlight,
    markReady: () => {
      if (lifecycle === 'starting') lifecycle = 'ready';
    },
    onClose: (closer) => {
      closers.push(closer);
    },
    beginRequest: () => {
      inFlight += 1;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        inFlight = Math.max(0, inFlight - 1);
      };
    },
    async shutdown(graceMs: number, pollMs = 10): Promise<DrainOutcome> {
      if (lifecycle === 'stopped') {
        return {
          lifecycle,
          drainedCleanly: inFlight === 0,
          inFlightAtTimeout: inFlight,
          closerErrors: [],
        };
      }
      // (a) Flip to draining so readiness reports it and (b) new requests are refused.
      lifecycle = 'draining';
      const deadline = now() + Math.max(0, graceMs);

      // (c) Wait for in-flight requests to settle, bounded by the grace budget.
      while (inFlight > 0 && now() < deadline) {
        await sleep(pollMs);
      }
      const drainedCleanly = inFlight === 0;
      const inFlightAtTimeout = inFlight;

      // (d) Run resource closers in LIFO order; surface (never swallow) any failures.
      const closerErrors: string[] = [];
      for (let i = closers.length - 1; i >= 0; i -= 1) {
        try {
          await closers[i]!();
        } catch (err) {
          closerErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
      lifecycle = 'stopped';
      return { lifecycle, drainedCleanly, inFlightAtTimeout, closerErrors };
    },
  };
  return controller;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// OS-signal wiring (thin, side-effecting shell around the pure controller).
//
// Kept separate from `createShutdownController` so the drain logic stays unit-testable without
// installing process handlers. `installSignalHandlers` is the only impure entry point.
// ---------------------------------------------------------------------------

/** Signals that trigger a graceful shutdown. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Install graceful-shutdown handlers for SIGTERM/SIGINT. On the first signal it drains within
 * `graceMs`; a second signal escalates to an immediate stop. Returns an uninstaller so tests
 * (and hot-reload) can detach cleanly. This is the ONLY function here that touches `process`.
 */
export function installSignalHandlers(
  shutdown: ShutdownController,
  graceMs: number,
  onOutcome?: (o: DrainOutcome) => void,
  proc: NodeJS.Process = process,
): () => void {
  let triggered = false;
  const handler = (): void => {
    if (triggered) {
      // Second signal — hard stop.
      void shutdown.shutdown(0).then((o) => onOutcome?.(o));
      return;
    }
    triggered = true;
    void shutdown.shutdown(graceMs).then((o) => onOutcome?.(o));
  };
  for (const sig of SHUTDOWN_SIGNALS) proc.on(sig, handler);
  return () => {
    for (const sig of SHUTDOWN_SIGNALS) proc.removeListener(sig, handler);
  };
}
