// @trustcircle/api — INVENTORY & DISCOVERY ROUTES (Phase 73).
//
// Mounts the three governance-inventory operations from the OpenAPI contract
// (contracts/governance-control-plane/governance-api.openapi.yaml,
// mirrored in packages/contracts/src/generated/governance-api.ts) onto the
// dependency-free Hono-compatible `App` from ../server.ts:
//
//   GET  /v1/inventory/sources        → listSources           → SourceCatalogPage
//   POST /v1/inventory/discovery-runs → startDiscovery         → OperationAccepted (202)
//   GET  /v1/inventory/assets         → listGovernedAssets     → GovernedAssetPage
//
// Both list operations return CURSOR-PAGINATED pages whose `metadata` block is the
// contract `PageMetadata` (= ProjectionMetadata + next_cursor): `generated_at`,
// `source_cursor`, `freshness`, `partial_coverage`, `coverage_gaps[]`, `next_cursor`.
//
// The rows are read from the @trustcircle/application projection services
// (`InventoryService.currentStateView()` for assets, `SourceRegistry.currentStateView()`
// for sources), which already fold in the acceptance-criterion semantics:
//   AC1  each governed asset renders ONCE with its full facet set.
//   AC2  a still-visible component gap → the asset's coverage is `gap`/`partial`, its
//        health is not `healthy`, and its gap id appears in `metadata.coverage_gaps`;
//        `partial_coverage` is `true`.
//   AC3  distinct source records + their differing authoritative status fields are
//        rendered as distinct catalog entries carrying `access_state`/`health_state`.
//   AC4  a stale/unavailable source row's `evidenceState`/`staleness` downgrades the
//        page `freshness` to `aging`/`stale`; current health is NEVER inferred — the
//        row's reported health is withheld upstream, and the metadata says so.
//   AC5  discovery catalogs an unregistered source with class-or-unknown / location /
//        access / ownership / onboarding state; `startDiscovery` returns an AUDITED,
//        canonical accepted-operation as the durable discovery evidence.
//   AC6  an unsupported / inaccessible / sensitive / unowned / excluded discovered
//        source stays a VISIBLE catalog entry whose governed-source gap ids are named
//        in `coverage_gap_ids` and folded into `metadata.coverage_gaps` — never dropped.
//
// Least privilege: `startDiscovery` performs METADATA-ONLY discovery through the
// injected `DiscoveryPort`. It carries the caller's authenticated tenant + a structured
// audit `reason` and returns operation/correlation/audit handles; it NEVER reads
// protected content, secrets, or credentials, and this module has no access path to do so.
//
// The module is pure request→response plumbing over injected projections: it holds no
// mutable state, reads no wall clock (the provider carries `now`), and every response is
// assembled from an independent read of the projection surface — never a mutation echo.

import type { App, AppContext, RouteHandler } from '../server.ts';

import {
  type Uuid,
  type EpochMillis,
  type TenantId,
  isUuid,
  makeReason,
  type Reason,
  type CoverageGap,
  gapAgeMillis,
  gapIsVisible,
} from '@trustcircle/domain';
import type {
  InventoryService,
  InventoryRow,
  SourceRegistry,
  SourceStateRow,
  StatusDifference,
} from '@trustcircle/application';
import type { SourceCatalogEntry, InventoryRelationship } from '@trustcircle/domain';
import type {
  GovernanceApiGovernedAsset,
  GovernanceApiGovernedAssetPage,
  GovernanceApiSourceCatalogEntry,
  GovernanceApiSourceCatalogPage,
  GovernanceApiPageMetadata,
  GovernanceApiOperationAccepted,
  GovernanceApiCoverageGapDetail,
  GovernanceApiSourceStatusDifference,
  GovernanceApiSourceDependency,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected dependencies — the route composes projections; it never builds them.
// ===========================================================================

/**
 * A tenant-scoped projection bundle. The caller (composition root) resolves the
 * per-tenant inventory + source projections and the injected clock. The route reads
 * ONLY the read surface (`currentStateView()` and the gap/catalog queries); it performs
 * no mutation and holds no reference beyond the request.
 */
export interface TenantProjection {
  /** Reconciled current inventory (AC1/AC2/AC3/AC4) for this tenant. */
  readonly inventory: InventoryService;
  /** Registered/discovered source catalog (AC3/AC4/AC5/AC6) for this tenant. */
  readonly sources: SourceRegistry;
  /** The projection clock (ms). Deterministic; supplied by the composition root. */
  readonly now: EpochMillis;
}

/** Resolves the projection bundle for an authenticated tenant, or `undefined` when the
 *  tenant has no projection (an empty page, not an error, is then returned). */
export type ProjectionProvider = (tenantId: TenantId) => TenantProjection | undefined;

/** The outcome of a metadata-only discovery run: canonical, audited operation handles.
 *  The port MUST NOT read protected content/secrets — it records the request and returns
 *  the durable evidence handles (operation + correlation + audit). */
export interface DiscoveryAcceptance {
  readonly operationId: Uuid;
  readonly correlationId: Uuid;
  readonly auditEventId: Uuid;
  /** True iff this is an idempotent replay of a prior identical run (same idempotency key). */
  readonly idempotentReplay?: boolean;
}

/** A metadata-only discovery command carried to the injected port. */
export interface DiscoveryCommand {
  readonly tenantId: TenantId;
  readonly boundaryVersionId: Uuid;
  readonly sourceClasses: readonly string[];
  readonly reason: Reason;
  /** The request correlation id (echoed into the accepted operation). */
  readonly correlationId: string;
  /** The idempotency key (header) that scopes replay detection. */
  readonly idempotencyKey?: string;
  /** The authenticated principal that requested the run (for the audit trail). */
  readonly principalId: string;
}

/** The least-privilege discovery port. Records a metadata-only run and returns audited
 *  handles. It is the ONLY effect `startDiscovery` can produce; it reads no content. */
export type DiscoveryPort = (
  command: DiscoveryCommand,
) => DiscoveryAcceptance | Promise<DiscoveryAcceptance>;

export interface InventoryRouteDeps {
  readonly projections: ProjectionProvider;
  readonly discovery: DiscoveryPort;
}

// ===========================================================================
// 1. Contract vocabularies + a disclosure-safe Problem responder.
// ===========================================================================

const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

/** Emit an RFC-9457-shaped Problem the app's error contract accepts. Never leaks internals. */
function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
): Response {
  const correlationId = c.ctx?.correlationId ?? 'unknown';
  return c.json(
    {
      type: `about:blank#${code}`,
      title,
      status,
      code,
      detail,
      correlation_id: correlationId,
      retryable: status >= 500,
      safe_next_actions: [...safeNextActions],
    },
    status,
  );
}

/** The authenticated tenant of the request, validated as a UUID tenant scope. */
function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

// ===========================================================================
// 2. Cursor codec — opaque, self-describing, tamper-evident-enough for paging.
//    A cursor encodes the SORT KEY of the last item returned (the row's id, which
//    is a time-ordered UUIDv7) plus the page kind, so decoding validates the caller
//    is paging the same collection. Rows are stable-sorted by id upstream, so
//    "everything strictly greater than the cursor id" is a correct, gap-free page
//    window even as the projection grows.
// ===========================================================================

interface Cursor {
  readonly kind: 'assets' | 'sources';
  readonly afterId: Uuid;
}

function encodeCursor(kind: Cursor['kind'], afterId: Uuid): string {
  const raw = JSON.stringify({ k: kind, a: afterId });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor; returns `undefined` for absent, and throws `CursorError` for malformed
 *  (so the handler can answer 400 rather than silently restart pagination). */
class CursorError extends Error {}

function decodeCursor(value: string | null, kind: Cursor['kind']): Cursor | undefined {
  if (value === null || value === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('cursor is not decodable');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CursorError('cursor is malformed');
  const rec = parsed as Record<string, unknown>;
  if (rec['k'] !== kind) throw new CursorError('cursor belongs to a different collection');
  const a = rec['a'];
  if (typeof a !== 'string' || !isUuid(a)) throw new CursorError('cursor id is invalid');
  return { kind, afterId: a as Uuid };
}

/** Parse + clamp the `limit` query param. Rejects a non-integer or out-of-range value so a
 *  bad page size fails visibly rather than being silently coerced. */
function parseLimit(url: URL): number | CursorError {
  const raw = url.searchParams.get('limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return new CursorError('limit must be a non-negative integer');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
    return new CursorError(`limit must be in [${MIN_LIMIT}, ${MAX_LIMIT}]`);
  }
  return n;
}

/**
 * Slice a stable-sorted-by-id collection into a cursor page. Returns the page window plus
 * the `next_cursor` (null when the window reaches the end). Pure over the input array.
 */
function paginate<T extends { readonly id: Uuid }>(
  all: readonly T[],
  cursor: Cursor | undefined,
  limit: number,
  kind: Cursor['kind'],
): { readonly page: readonly T[]; readonly nextCursor: string | null } {
  const sorted = [...all].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const start = cursor
    ? sorted.findIndex((r) => String(r.id).localeCompare(String(cursor.afterId)) > 0)
    : 0;
  const from = start < 0 ? sorted.length : start;
  const page = sorted.slice(from, from + limit);
  const consumedThrough = from + page.length;
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const nextCursor =
    consumedThrough < sorted.length && last !== undefined ? encodeCursor(kind, last.id) : null;
  return { page, nextCursor };
}

// ===========================================================================
// 3. Time + freshness helpers (wire uses RFC3339 date-time; domain uses epoch-ms).
// ===========================================================================

/** Epoch-ms → RFC3339 UTC string (the wire `date-time`). */
function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

type Freshness = GovernanceApiPageMetadata['freshness'];

/** Fold a set of per-row freshness signals into the page-level contract freshness. A single
 *  stale/unavailable row drags the whole page to `stale`; an aging one to `aging`; the page is
 *  `current` only when EVERY contributing row is current; `unknown` when there is nothing to say. */
function foldFreshness(signals: readonly Freshness[]): Freshness {
  if (signals.length === 0) return 'unknown';
  if (signals.includes('stale')) return 'stale';
  if (signals.includes('unknown')) return 'unknown';
  if (signals.includes('aging')) return 'aging';
  return 'current';
}

// ===========================================================================
// 4. Row → wire mappers. Each maps a projection row (camelCase, epoch-ms) to the
//    generated contract shape (snake_case, RFC3339), preserving every AC facet.
// ===========================================================================

/**
 * A still-VISIBLE coverage gap → its full-content wire detail (AC2 component / AC6 governed-source):
 * reason, AGE (derived from `firstSeenAt` vs the projection `now`), impact, the required owner
 * ACTION, the required owner, and — for a governed-source gap — a review or expiry deadline. Never
 * reduced to a bare id. `now` is the projection clock (no wall-clock read here).
 */
function gapToWire(gap: CoverageGap, now: EpochMillis): GovernanceApiCoverageGapDetail {
  const detail: GovernanceApiCoverageGapDetail = {
    gap_id: String(gap.id),
    gap_class: gap.gapClass,
    reason: gap.reason,
    impact: gap.impact,
    age_millis: gapAgeMillis(gap, now),
    required_action: gap.requiredAction,
  };
  const withOwner =
    gap.requiredOwner !== undefined
      ? { ...detail, required_owner: String(gap.requiredOwner) }
      : detail;
  // AC6 "review or expiry": present iff a governed-source gap carries a deadline.
  const withReview =
    gap.reviewAt !== undefined ? { ...withOwner, review_at: iso(gap.reviewAt) } : withOwner;
  return gap.expiresAt !== undefined
    ? { ...withReview, expires_at: iso(gap.expiresAt) }
    : withReview;
}

/** AC3 per-field status difference → wire (each differing value + the record ids that reported it). */
function statusDiffToWire(d: StatusDifference): GovernanceApiSourceStatusDifference {
  return {
    field: d.field,
    values: d.values.map((v) => ({
      value: v.value,
      record_ids: v.recordIds.map((r) => String(r)),
    })),
  };
}

/** AC3 dependency edge → wire. */
function dependencyToWire(rel: InventoryRelationship): GovernanceApiSourceDependency {
  const base: GovernanceApiSourceDependency = {
    relationship_id: String(rel.id),
    from_id: String(rel.fromId),
    to_id: String(rel.toId),
  };
  return rel.fieldName !== '' ? { ...base, field_name: rel.fieldName } : base;
}

function assetToWire(
  row: InventoryRow,
  tenantId: TenantId,
  gaps: readonly CoverageGap[],
  now: EpochMillis,
): GovernanceApiGovernedAsset {
  const out: GovernanceApiGovernedAsset = {
    id: String(row.assetId),
    tenant_id: String(tenantId),
    asset_type: row.assetType,
    name: row.name,
    // AC1 ownership facet: absent owner is surfaced as an explicit null (ownership is itself a gap).
    owner_principal_id: row.ownerPrincipalId !== undefined ? String(row.ownerPrincipalId) : null,
    lifecycle_state: row.lifecycleState,
    risk_tier: row.riskTier,
    // AC4: the wire `health` carries the SAFE-to-report health (`reportedHealth`), which upstream
    // withholds (→ 'unknown') whenever evidence is not current — current health is never inferred.
    health: row.reportedHealth,
    coverage: row.coverage,
    // AC1 evidence-state + unresolved-issues facets, rendered as NAMED fields (never a status blob).
    evidence_state: row.evidenceState,
    unresolved_issues: row.unresolvedIssueCount,
    // AC4 confidence in this row's currency (alongside the last-known observation time below).
    confidence: row.confidence,
    version: row.version,
  };
  // AC2: the asset's still-visible component gaps, each with reason / age / impact / required action.
  const withGaps =
    gaps.length > 0 ? { ...out, coverage_gaps: gaps.map((g) => gapToWire(g, now)) } : out;
  if (row.lastObservationAt !== undefined) {
    return { ...withGaps, last_observed_at: iso(row.lastObservationAt) };
  }
  return withGaps;
}

function sourceToWire(
  row: SourceStateRow,
  entry: SourceCatalogEntry | undefined,
  tenantId: TenantId,
  gaps: readonly CoverageGap[],
  statusDifferences: readonly StatusDifference[],
  dependencies: readonly InventoryRelationship[],
  now: EpochMillis,
): GovernanceApiSourceCatalogEntry {
  // AC5: the discovered source's observed LOCATION(s) and discovery-window (first/last seen) come
  // from the catalog entry — the current-state row only carries the reconciled facets. When the
  // entry is momentarily unavailable we fall back to the row's last-known time (never fabricated).
  const firstSeen = entry ? entry.firstSeenAt : row.lastKnownAt;
  const out: GovernanceApiSourceCatalogEntry = {
    id: String(row.sourceId),
    tenant_id: String(tenantId),
    source_class: row.sourceClass,
    onboarding_state: row.onboardingState,
    access_state: row.accessState,
    // AC4: reported (safe) health, withheld upstream when evidence is not current.
    health_state: row.reportedHealth,
    owner_principal_id: row.ownerPrincipalId !== undefined ? String(row.ownerPrincipalId) : null,
    coverage_gap_ids: gaps.map((g) => String(g.id)),
    // AC1 evidence-state + unresolved-issues facets, rendered as NAMED fields.
    evidence_state: row.evidenceState,
    unresolved_issues: row.unresolvedIssueCount,
    // AC4 confidence in this row's currency (alongside last_seen_at, the last-known time).
    confidence: row.confidence,
    // AC5 observed location(s): the where-it-was-seen evidence for a discovered source.
    observed_locations: entry ? [...entry.observedLocations] : [],
    // AC5 sensitivity classification: an operator triages an ungoverned sensitive/restricted source
    // ahead of a normal one. Sourced from the catalog entry; a momentarily-absent entry reads as the
    // least-alarming 'normal' rather than fabricating a higher sensitivity we cannot substantiate.
    sensitivity: entry ? entry.sensitivity : 'normal',
    first_seen_at: iso(firstSeen),
    last_seen_at: iso(row.lastKnownAt),
  };
  // AC5 discovery-evidence provenance: the observation id that surfaced this source. Only rendered
  // when the catalog entry actually carries it — never fabricated for an entry-less fallback.
  const withEvidence =
    entry && entry.discoveryEvidence !== undefined
      ? { ...out, discovery_evidence: String(entry.discoveryEvidence) }
      : out;
  // AC6: the source's still-visible governed-source gaps, each with reason / impact / owner action /
  // review-or-expiry — never reduced to a bare id.
  const withGaps =
    gaps.length > 0
      ? { ...withEvidence, coverage_gaps: gaps.map((g) => gapToWire(g, now)) }
      : withEvidence;
  // AC3: the per-field status differences across this source's distinct correlated records...
  const withCorr =
    statusDifferences.length > 0
      ? { ...withGaps, correlation: statusDifferences.map(statusDiffToWire) }
      : withGaps;
  // ...and its dependency edges.
  return dependencies.length > 0
    ? { ...withCorr, dependencies: dependencies.map(dependencyToWire) }
    : withCorr;
}

/** Map an application `SourceStateRow` staleness/evidence verdict to a page freshness signal (AC4).
 *  A stale OR unavailable source both mark the page non-current: current compliance/health is never
 *  inferred from data the platform can no longer trust. `absent` evidence (a discovered-but-not-yet-
 *  contracted source) reads as `unknown` — we have a record but nothing current to assert. */
function sourceFreshness(row: SourceStateRow): Freshness {
  if (
    row.staleness === 'stale' ||
    row.staleness === 'unavailable' ||
    row.evidenceState === 'stale'
  ) {
    return 'stale';
  }
  if (row.evidenceState === 'absent') return 'unknown';
  // Fresh but not fully confident (a decaying but not-yet-stale record) reads as aging.
  if (row.confidence < 1) return 'aging';
  return 'current';
}

/** Map an asset `InventoryRow`'s evidence/confidence to a page freshness signal (AC4). */
function assetFreshness(row: InventoryRow): Freshness {
  if (row.evidenceState === 'incomplete') return 'unknown';
  if (row.evidenceState === 'stale') return 'stale';
  if (row.confidence < 1) return 'aging';
  return 'current';
}

// ===========================================================================
// 5. Handlers.
// ===========================================================================

/** GET /inventory/assets — AC1/AC2/AC4: the current-state governed-asset page. */
function listGovernedAssets(deps: InventoryRouteDeps): RouteHandler {
  return (c) => {
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
    const url = new URL(c.req.url, 'http://internal');

    const limit = parseLimit(url);
    if (limit instanceof CursorError) {
      return problem(c, 400, 'invalid_limit', 'Bad Request', limit.message, ['retry with 1..500']);
    }
    let cursor: Cursor | undefined;
    try {
      cursor = decodeCursor(url.searchParams.get('cursor'), 'assets');
    } catch (e) {
      return problem(c, 400, 'invalid_cursor', 'Bad Request', (e as Error).message, [
        'restart paging without a cursor',
      ]);
    }

    const projection = deps.projections(tenantId);
    if (projection === undefined) {
      return c.json(emptyPage('assets'), 200);
    }

    let rows: readonly InventoryRow[];
    try {
      rows = projection.inventory.currentStateView(projection.now);
    } catch {
      return problem(
        c,
        500,
        'projection_unavailable',
        'Projection unavailable',
        'The inventory projection could not be read.',
      );
    }

    // Optional filters (contract query params). Applied BEFORE pagination so the page window is
    // over the filtered collection; coverage metadata below reflects the filtered rows shown.
    const assetType = url.searchParams.get('asset_type');
    const riskTier = url.searchParams.get('risk_tier');
    const coverageState = url.searchParams.get('coverage_state');
    let filtered = rows;
    if (assetType) filtered = filtered.filter((r) => r.assetType === assetType);
    if (riskTier) filtered = filtered.filter((r) => r.riskTier === riskTier);
    if (coverageState) filtered = filtered.filter((r) => r.coverage === coverageState);

    // Pagination over id-sorted rows.
    const idRows = filtered.map((r) => ({ id: r.assetId, row: r }));
    const { page, nextCursor } = paginate(idRows, cursor, limit, 'assets');
    const pageRows = page.map((p) => p.row);

    // Read each shown asset's still-visible component gaps ONCE — reused for the wire row's AC2
    // `coverage_gaps` detail and the page coverage metadata below (a single projection read).
    const gapsByAsset = new Map<string, readonly CoverageGap[]>();
    for (const r of pageRows) {
      gapsByAsset.set(
        String(r.assetId),
        projection.inventory.gapsForAsset(r.assetId).filter((g) => gapIsVisible(g)),
      );
    }

    const items = pageRows.map((r) =>
      assetToWire(r, tenantId, gapsByAsset.get(String(r.assetId)) ?? [], projection.now),
    );

    // AC2/AC4 metadata over the ROWS SHOWN: partial coverage + the still-visible component gap ids
    // bound to those rows, and the folded freshness.
    const shownGapIds = new Set<string>();
    let partial = false;
    for (const r of pageRows) {
      if (r.hasVisibleComponentGap || r.coverage !== 'covered') partial = true;
      for (const g of gapsByAsset.get(String(r.assetId)) ?? []) shownGapIds.add(String(g.id));
    }
    const freshness = foldFreshness(pageRows.map(assetFreshness));

    const body: GovernanceApiGovernedAssetPage = {
      items,
      metadata: pageMetadata({
        generatedAt: projection.now,
        cursor,
        nextCursor,
        freshness,
        partial,
        coverageGaps: [...shownGapIds].sort(),
      }),
    };
    return c.json(body, 200);
  };
}

/** GET /inventory/sources — AC3/AC4/AC5/AC6: the current source-catalog page. */
function listSources(deps: InventoryRouteDeps): RouteHandler {
  return (c) => {
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
    const url = new URL(c.req.url, 'http://internal');

    const limit = parseLimit(url);
    if (limit instanceof CursorError) {
      return problem(c, 400, 'invalid_limit', 'Bad Request', limit.message, ['retry with 1..500']);
    }
    let cursor: Cursor | undefined;
    try {
      cursor = decodeCursor(url.searchParams.get('cursor'), 'sources');
    } catch (e) {
      return problem(c, 400, 'invalid_cursor', 'Bad Request', (e as Error).message, [
        'restart paging without a cursor',
      ]);
    }

    const projection = deps.projections(tenantId);
    if (projection === undefined) {
      return c.json(emptyPage('sources'), 200);
    }

    let rows: readonly SourceStateRow[];
    try {
      rows = projection.sources.currentStateView(projection.now);
    } catch {
      return problem(
        c,
        500,
        'projection_unavailable',
        'Projection unavailable',
        'The source projection could not be read.',
      );
    }

    // Optional `state` filter (onboarding state) from the contract query param.
    const state = url.searchParams.get('state');
    let filtered = rows;
    if (state) filtered = filtered.filter((r) => r.onboardingState === state);

    const idRows = filtered.map((r) => ({ id: r.sourceId, row: r }));
    const { page, nextCursor } = paginate(idRows, cursor, limit, 'sources');
    const pageRows = page.map((p) => p.row);

    // Index the catalog entries by source id so each wire row can carry its AC5 discovery facets
    // (observed location(s) + first-seen window) that the reconciled current-state row omits.
    const entriesById = new Map<string, SourceCatalogEntry>();
    for (const e of projection.sources.catalog()) entriesById.set(String(e.id), e);

    // AC6: attach each source's still-visible governed-source gap ids to its wire entry, and fold
    // them into the page coverage metadata — a discovered-but-unsupported/inaccessible/excluded
    // source stays VISIBLE with its gap references, never silently dropped.
    const shownGapIds = new Set<string>();
    let partial = false;
    const items: GovernanceApiSourceCatalogEntry[] = pageRows.map((r) => {
      // Still-visible governed-source gaps (AC6) + the AC3 correlation / dependency edges, read from
      // the projection for THIS source. The gap ids feed both the row's `coverage_gap_ids`, its
      // full-content `coverage_gaps`, and the page coverage metadata.
      const gaps = projection.sources.gapsForSource(r.sourceId).filter((g) => gapIsVisible(g));
      for (const g of gaps) shownGapIds.add(String(g.id));
      if (gaps.length > 0 || r.ownershipGap || r.onboardingState === 'excluded') partial = true;
      const statusDifferences = projection.sources.statusDifferencesFor(r.sourceId);
      const dependencies = projection.sources.dependenciesFor(r.sourceId);
      return sourceToWire(
        r,
        entriesById.get(String(r.sourceId)),
        tenantId,
        gaps,
        statusDifferences,
        dependencies,
        projection.now,
      );
    });

    const freshness = foldFreshness(pageRows.map(sourceFreshness));

    const body: GovernanceApiSourceCatalogPage = {
      items,
      metadata: pageMetadata({
        generatedAt: projection.now,
        cursor,
        nextCursor,
        freshness,
        partial,
        coverageGaps: [...shownGapIds].sort(),
      }),
    };
    return c.json(body, 200);
  };
}

/** POST /inventory/discovery-runs — AC5: accept a metadata-only discovery run and return an
 *  AUDITED, canonical accepted-operation. Least privilege: reads no protected content. */
function startDiscovery(deps: InventoryRouteDeps): RouteHandler {
  return async (c) => {
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

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return problem(
        c,
        400,
        'invalid_body',
        'Bad Request',
        'The request body must be a JSON object.',
      );
    }
    const bodyObj = raw as Record<string, unknown>;

    // additionalProperties:false — reject unknown fields (contract requirement / negative control).
    const allowed = new Set(['boundary_version_id', 'source_classes', 'reason']);
    for (const k of Object.keys(bodyObj)) {
      if (!allowed.has(k)) {
        return problem(c, 400, 'unexpected_field', 'Bad Request', `Unexpected field: ${k}`);
      }
    }

    const boundary = bodyObj['boundary_version_id'];
    if (typeof boundary !== 'string' || !isUuid(boundary)) {
      return problem(
        c,
        400,
        'invalid_boundary',
        'Bad Request',
        'boundary_version_id must be a uuid.',
      );
    }

    const reason = validateReason(bodyObj['reason']);
    if (reason instanceof CursorError) {
      return problem(c, 400, 'invalid_reason', 'Bad Request', reason.message);
    }

    let sourceClasses: string[] = [];
    const sc = bodyObj['source_classes'];
    if (sc !== undefined) {
      if (!Array.isArray(sc) || !sc.every((s) => typeof s === 'string' && s.length > 0)) {
        return problem(
          c,
          400,
          'invalid_source_classes',
          'Bad Request',
          'source_classes must be a string array.',
        );
      }
      sourceClasses = [...new Set(sc as string[])];
    }

    const correlationId = c.ctx?.correlationId ?? '';
    const idempotencyKey = c.req.header('idempotency-key');

    const command: DiscoveryCommand = {
      tenantId,
      boundaryVersionId: boundary as Uuid,
      sourceClasses,
      reason,
      correlationId,
      principalId: c.ctx?.principalId ?? 'unknown',
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let acceptance: DiscoveryAcceptance;
    try {
      acceptance = await deps.discovery(command);
    } catch {
      return problem(
        c,
        500,
        'discovery_failed',
        'Discovery could not be started',
        'The discovery run was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    const accepted: GovernanceApiOperationAccepted = {
      operation_id: String(acceptance.operationId),
      status: acceptance.idempotentReplay ? 'idempotent_replay' : 'accepted',
      correlation_id: String(acceptance.correlationId),
      audit_event_id: String(acceptance.auditEventId),
      idempotent_replay: acceptance.idempotentReplay ?? false,
    };
    return c.json(accepted, 202);
  };
}

// ===========================================================================
// 6. Small shared builders.
// ===========================================================================

function pageMetadata(input: {
  generatedAt: EpochMillis;
  cursor: Cursor | undefined;
  nextCursor: string | null;
  freshness: Freshness;
  partial: boolean;
  coverageGaps: readonly string[];
}): GovernanceApiPageMetadata {
  const meta: GovernanceApiPageMetadata = {
    generated_at: iso(input.generatedAt),
    // `source_cursor` is the projection read-position witness: the incoming cursor, or a
    // stable sentinel for the first page. It documents WHICH slice this page reflects.
    source_cursor: input.cursor ? encodeCursor(input.cursor.kind, input.cursor.afterId) : 'start',
    freshness: input.freshness,
    partial_coverage: input.partial,
    next_cursor: input.nextCursor,
  };
  if (input.coverageGaps.length > 0) {
    return { ...meta, coverage_gaps: [...input.coverageGaps] };
  }
  return meta;
}

function emptyPage(
  _kind: Cursor['kind'],
): GovernanceApiGovernedAssetPage & GovernanceApiSourceCatalogPage {
  return {
    items: [],
    metadata: {
      generated_at: iso(0),
      source_cursor: 'start',
      freshness: 'unknown',
      partial_coverage: false,
      next_cursor: null,
    },
  };
}

/** Validate the structured audit reason. Returns a `Reason` or a `CursorError` carrying why. */
function validateReason(raw: unknown): Reason | CursorError {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return new CursorError('reason must be an object with code + text.');
  }
  const rec = raw as Record<string, unknown>;
  const code = rec['code'];
  const text = rec['text'];
  if (typeof code !== 'string' || !REASON_CODE_RE.test(code)) {
    return new CursorError('reason.code must match /^[a-z][a-z0-9_.-]{1,63}$/.');
  }
  if (typeof text !== 'string' || text.length < 3 || text.length > 4000) {
    return new CursorError('reason.text must be 3..4000 characters.');
  }
  try {
    return makeReason(code, text);
  } catch (e) {
    return new CursorError((e as Error).message);
  }
}

// ===========================================================================
// 7. Registration.
// ===========================================================================

/**
 * Mount the inventory + discovery routes onto `app`. All three are AUTHENTICATED
 * (they carry a tenant scope + audit identity). Paths are registered WITHOUT the version
 * prefix — `App.get`/`App.post` prepend `API_PREFIX` (`/v1`).
 */
export function registerInventoryRoutes(app: App, deps: InventoryRouteDeps): App {
  app.get('/inventory/assets', listGovernedAssets(deps));
  app.get('/inventory/sources', listSources(deps));
  app.post('/inventory/discovery-runs', startDiscovery(deps));
  return app;
}
