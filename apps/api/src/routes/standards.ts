// @trustcircle/api — STANDARDS PUBLICATION ROUTES (Phase 7 / User Story 5 — Demonstrate Compliance
// and Audit Readiness / FR-031, FR-051, FR-055, FR-056, SC-012).
//
// Mounts the global, versioned standards-publication registry surface from the OpenAPI contract
// (specs/001-governance-control-plane/contracts/governance-api.openapi.yaml):
//
//   GET  /v1/standards/publications         → StandardPublicationPage  (global versioned publication FACTS)
//   POST /v1/standards/publications/import  → StandardsImportAccepted   (admit a FUTURE 4200x edition)
//
// A standard publication is a versioned FACT about a published standard (publisher, identifier,
// exact title, edition, publication date, status, material type, source URI, registry version). It is
// NEVER a conformity, accreditation, or certification claim — the registry only asserts "this edition
// of this standard was published", which is exactly why it is safe to serve globally (no tenant scope).
//
// The import endpoint is the operator affordance for admitting a FUTURE 4200x edition (e.g. an
// ISO/IEC 42007 draft) into the global registry without a code change (FR-051, SC-012). It is
// PLATFORM-ADMIN-ONLY (the registry is global, not tenant-scoped) and delegates the actual validation
// + aggregate construction to the INJECTED `importSeed` port (production wires
// `importStandardsSeed` from @trustcircle/application). The route validates the wire envelope and the
// admin role, then hands the parsed seed to the port; a malformed seed fails VISIBLY (422) rather than
// producing a half-registry. Import is deterministic and records only publication FACTS — it never
// marks any tenant as conforming, accredited, or certified (42006 keeps its certification_body_criteria
// material type). The registry write itself is idempotent by content digest, so a re-import is a no-op.
//
// Both routes are pure request→response plumbing over INJECTED ports. They hold no mutable state,
// read no wall clock (the import command carries `now`), and re-implement no registry logic: they
// validate the wire shape, then delegate.

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis } from '@trustcircle/domain';
import type {
  GovernanceApiStandardPublication,
  GovernanceApiStandardPublicationPage,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports — the route composes the registry read; it never builds it.
// ===========================================================================

/** One publication as the injected surface hands it to the route (already registry-authorized). */
export interface StandardPublicationView {
  readonly id: Uuid;
  readonly publisher: string;
  readonly identifier: string;
  readonly exactTitle: string;
  readonly edition: string;
  /** RFC3339 full-date (YYYY-MM-DD). */
  readonly publicationDate: string;
  readonly status: string;
  readonly materialType: string;
  readonly sourceUri: string;
  readonly registryVersion: number;
}

/** A page of publications for a cursor/limit window (from the standards registry read model). */
export interface StandardPublicationPageView {
  readonly items: readonly StandardPublicationView[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  readonly nextCursor: string | null;
}

/** Filters the registry read honours (contract query params). */
export interface StandardsQuery {
  readonly cursor?: string;
  readonly limit: number;
}

/** Resolves a page of publication facts, or undefined (empty page) when the registry is unreadable. */
export type StandardsRegistryProvider = (
  query: StandardsQuery,
) => StandardPublicationPageView | undefined | Promise<StandardPublicationPageView | undefined>;

/**
 * The parsed seed an import request carries to the injected port. Kept structurally permissive at the
 * edge (the port re-validates each entry via the domain factories); the route only asserts that the
 * top-level envelope is a JSON object with a non-empty `publications` array before delegating.
 */
export interface StandardsSeedCommand {
  readonly registryVersion?: number;
  readonly scope?: string;
  readonly publications: readonly Readonly<Record<string, unknown>>[];
  /** The createdAt stamp for the imported rows — injected by the composition root, never the caller. */
  readonly now: EpochMillis;
  /** The admitting operator (audit identity), copied from the request context. */
  readonly importedBy: string;
  readonly correlationId: string;
}

/** The receipt an import returns — the deterministic registry digest + admitted counts (fail-visible). */
export interface StandardsImportReceipt {
  /** Content digest of the imported registry snapshot — stable across re-imports of the same seed. */
  readonly registryDigest: string;
  readonly publicationCount: number;
  readonly clauseCount: number;
  /** True when the seed was already present (idempotent replay — the registry was unchanged). */
  readonly idempotentReplay: boolean;
}

/**
 * Import a parsed standards seed at `command.now`, or throw {@link StandardsSeedRejected} when the seed
 * is malformed (a half-registry is never produced). Production wires `importStandardsSeed` +
 * the registry upsert; tests wire a pure fake. The route owns NO import logic.
 */
export type StandardsSeedImporter = (
  command: StandardsSeedCommand,
) => StandardsImportReceipt | Promise<StandardsImportReceipt>;

/** A visible rejection the importer throws for a malformed seed (mapped to a 422 Problem, no leak). */
export class StandardsSeedRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardsSeedRejected';
  }
}

export interface StandardsRouteDeps {
  readonly listPublications: StandardsRegistryProvider;
  /** The future-publication import port (FR-051). Optional — when absent the import route is not mounted. */
  readonly importSeed?: StandardsSeedImporter;
  /** Resolves the injected `now` for an import command (defaults to `Date.now`). Kept injectable for tests. */
  readonly now?: () => EpochMillis;
}

// ===========================================================================
// 1. Contract vocabularies + a disclosure-safe Problem responder.
// ===========================================================================

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Emit an RFC-9457-shaped Problem the app's error contract accepts. */
function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
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
  return c.json(body, status);
}

// ===========================================================================
// 2. Wire mapper.
// ===========================================================================

function publicationToWire(p: StandardPublicationView): GovernanceApiStandardPublication {
  return {
    id: String(p.id),
    publisher: p.publisher,
    identifier: p.identifier,
    exact_title: p.exactTitle,
    edition: p.edition,
    publication_date: p.publicationDate,
    status: p.status,
    material_type: p.materialType,
    source_uri: p.sourceUri,
    registry_version: p.registryVersion,
  };
}

// ===========================================================================
// 3. Handler.
// ===========================================================================

/** GET /standards/publications — the global versioned publication registry (FR-031). */
function listStandardsPublications(deps: StandardsRouteDeps): RouteHandler {
  return async (c) => {
    const url = new URL(c.req.url, 'http://internal');

    const rawLimit = url.searchParams.get('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null && rawLimit !== '') {
      if (!/^\d+$/.test(rawLimit)) {
        return problem(
          c,
          400,
          'invalid_limit',
          'Bad Request',
          'limit must be a non-negative integer.',
        );
      }
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
        return problem(
          c,
          400,
          'invalid_limit',
          'Bad Request',
          `limit must be in [${MIN_LIMIT}, ${MAX_LIMIT}].`,
        );
      }
      limit = n;
    }

    const cursor = url.searchParams.get('cursor');
    const query: StandardsQuery = {
      limit,
      ...(cursor !== null && cursor !== '' ? { cursor } : {}),
    };

    let view: StandardPublicationPageView | undefined;
    try {
      view = await deps.listPublications(query);
    } catch {
      return problem(
        c,
        500,
        'standards_registry_unavailable',
        'Standards registry unavailable',
        'The standards publication registry could not be read.',
        ['retry after the registry is reachable'],
      );
    }

    if (view === undefined) {
      const empty: GovernanceApiStandardPublicationPage = { items: [], next_cursor: null };
      return c.json(empty, 200);
    }

    const body: GovernanceApiStandardPublicationPage = {
      items: view.items.slice(0, limit).map(publicationToWire),
      next_cursor: view.nextCursor,
    };
    return c.json(body, 200);
  };
}

/** True iff the authenticated request carries the platform_admin role (registry writes are global). */
function isPlatformAdmin(c: AppContext): boolean {
  const roles = c.ctx?.roles;
  return Array.isArray(roles) && roles.includes('platform_admin');
}

/** Validate the import envelope shape (object with a non-empty publications array); the port re-validates entries. */
function parseSeedEnvelope(raw: unknown): {
  registryVersion?: number;
  scope?: string;
  publications: readonly Readonly<Record<string, unknown>>[];
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StandardsSeedRejected('The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const pubs = body['publications'];
  if (!Array.isArray(pubs) || pubs.length === 0) {
    throw new StandardsSeedRejected('publications must be a non-empty array.');
  }
  for (const p of pubs) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      throw new StandardsSeedRejected('each publication must be a JSON object.');
    }
  }
  const registryVersion = body['registryVersion'];
  if (
    registryVersion !== undefined &&
    (typeof registryVersion !== 'number' || !Number.isInteger(registryVersion))
  ) {
    throw new StandardsSeedRejected('registryVersion must be an integer when present.');
  }
  const scope = body['scope'];
  if (scope !== undefined && typeof scope !== 'string') {
    throw new StandardsSeedRejected('scope must be a string when present.');
  }
  return {
    ...(typeof registryVersion === 'number' ? { registryVersion } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
    publications: pubs as readonly Readonly<Record<string, unknown>>[],
  };
}

/**
 * POST /standards/publications/import — admit a FUTURE 4200x edition into the global registry (FR-051,
 * SC-012). PLATFORM-ADMIN-ONLY; deterministic; records publication FACTS only (never a conformity or
 * certification claim). 202 Accepted with the deterministic registry digest; a re-import is a no-op.
 */
function importStandardsPublications(deps: StandardsRouteDeps): RouteHandler {
  const importSeed = deps.importSeed;
  const nowOf = deps.now ?? (() => Date.now() as EpochMillis);
  return async (c) => {
    if (importSeed === undefined) {
      return problem(
        c,
        501,
        'import_not_configured',
        'Not Implemented',
        'The standards import port is not configured on this deployment.',
      );
    }
    // Global registry writes are platform-admin only — NOT tenant-scoped.
    if (!isPlatformAdmin(c)) {
      return problem(
        c,
        403,
        'registry_admin_required',
        'Forbidden',
        'Importing a standards publication requires the platform_admin role.',
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }

    let envelope: {
      registryVersion?: number;
      scope?: string;
      publications: readonly Readonly<Record<string, unknown>>[];
    };
    try {
      envelope = parseSeedEnvelope(raw);
    } catch (e) {
      if (e instanceof StandardsSeedRejected) {
        return problem(c, 422, 'invalid_seed', 'Unprocessable', e.message);
      }
      throw e;
    }

    const correlationId = c.ctx?.correlationId ?? '';
    const command: StandardsSeedCommand = {
      ...(envelope.registryVersion !== undefined
        ? { registryVersion: envelope.registryVersion }
        : {}),
      ...(envelope.scope !== undefined ? { scope: envelope.scope } : {}),
      publications: envelope.publications,
      now: nowOf(),
      importedBy: c.ctx?.principalId ?? 'unknown',
      correlationId,
    };

    let receipt: StandardsImportReceipt;
    try {
      receipt = await importSeed(command);
    } catch (e) {
      // A malformed entry surfaced by the port (domain factory / importer) is a visible 422 — never a
      // half-registry, never a 500 that hides the shape error.
      if (e instanceof StandardsSeedRejected) {
        return problem(c, 422, 'invalid_seed', 'Unprocessable', e.message);
      }
      if (
        e instanceof Error &&
        (e.name === 'StandardsImportError' || e.name === 'TypeError' || e.name === 'RangeError')
      ) {
        return problem(
          c,
          422,
          'invalid_seed',
          'Unprocessable',
          `The standards seed was rejected: ${e.message}`,
        );
      }
      return problem(
        c,
        500,
        'standards_import_failed',
        'Standards import failed',
        'The standards seed could not be imported.',
        ['retry after the registry is reachable'],
      );
    }

    if (receipt.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    const body = {
      registry_digest: receipt.registryDigest,
      publication_count: receipt.publicationCount,
      clause_count: receipt.clauseCount,
      idempotent_replay: receipt.idempotentReplay,
      correlation_id: correlationId,
    };
    return c.json(body, 202);
  };
}

// ===========================================================================
// 4. Registration.
// ===========================================================================

/**
 * Mount the standards route onto `app`. It is AUTHENTICATED (it carries an audit identity) but is
 * NOT tenant-scoped — publication facts are global. The path is registered WITHOUT the version
 * prefix; `App.get` prepends `API_PREFIX` (`/v1`), so it serves at `/v1/standards/publications`.
 */
export function registerStandardsRoutes(app: App, deps: StandardsRouteDeps): App {
  app.get('/standards/publications', listStandardsPublications(deps));
  // The future-publication import (FR-051) is mounted only when the import port is wired. It is
  // platform-admin gated inside the handler (the registry is global, so the guard is role-based, not
  // tenant-scoped) and is a documented internal/operator endpoint (not part of the public OpenAPI page).
  if (deps.importSeed !== undefined) {
    app.post('/standards/publications/import', importStandardsPublications(deps));
  }
  return app;
}
