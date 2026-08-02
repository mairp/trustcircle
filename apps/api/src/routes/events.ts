// @trustcircle/api — AUTHORIZED PROJECTION-CHANGE STREAM (Phase 83).
//
// Streams authorized projection changes to a consumer over Server-Sent Events with
// cursor RESUME and explicit STALE / PARTIAL status, mounted onto the dependency-free
// Hono-compatible `App` from ../server.ts:
//
//   GET /v1/events   (Accept: text/event-stream)   → an SSE `Response` whose body is a
//                                                     resumable change stream for the
//                                                     authenticated tenant.
//
// SSE FRAMING. The response is `text/event-stream` and each change is one SSE record:
//     id: <opaque resume cursor>
//     event: change | status | gap | item | correlation | catalog
//     data: <one JSON line>
//   plus a leading `retry:` reconnection hint and `: keep-alive` comments. The `id:` field
//   is the STANDARD SSE resume token — a reconnecting client echoes it back in the
//   `Last-Event-ID` request header (or the `?cursor=` query param) and the stream continues
//   from strictly after it.
//
// CURSOR RESUME (the phase's headline behaviour).
//   * Absent cursor      → stream from the retained window's first change (a full replay of
//                          what the consumer is authorized to see), preceded by a `status`
//                          record announcing the read position.
//   * Valid in-window    → resume STRICTLY AFTER the cursor position: gap-free, no repeats,
//                          no skips. A `status` record confirms `resume: gapless`.
//   * Valid but EXPIRED  → the cursor points before the earliest retained change (the buffer
//     (beyond window)      has advanced past it). We DO NOT silently skip the missing span and
//                          we DO NOT pretend continuity: we replay from the window floor and
//                          emit a `status` record with `partial: true`, `resume: partial`, and
//                          the missed-version span, so the gap is VISIBLE and reconcilable.
//   * Malformed / foreign → a decode failure, or a cursor minted for another tenant/stream, is
//                          a visible 400 (never a silent restart that would hide data loss).
//
// STALE / PARTIAL STATUS (fail-visible, never inferred-healthy).
//   * The injected feed reports a projection FRESHNESS snapshot (`current|aging|stale|unknown`)
//     and whether coverage is partial. When the projection is stale or partial, the stream
//     opens with a `status` record carrying that state + a safe next action; current health is
//     NEVER inferred from a stale projection.
//   * Each `change` record carries the envelope's own `freshness`/`confidence` and a per-change
//     `stale` flag, so a consumer applying the change knows whether it can trust it as current.
//   * Ordering is checked with the SAME runtime the ingest side uses
//     (@trustcircle/contracts events: `applyDelivery` / `missingVersions`): a duplicate is
//     dropped (no second effect), an out-of-order / missing predecessor is surfaced as a `gap`
//     record (never applied out of order), and a malformed envelope is skipped with a visible
//     `status` note rather than corrupting the stream.
//
// AUTHORIZATION. The stream is tenant-scoped: the feed provider is resolved for the
// authenticated tenant only, cursors are bound to that tenant + stream kind (a foreign cursor
// is rejected), and the route reads ONLY the authorized change feed — it performs no mutation,
// holds no cross-tenant reference, and reads no wall clock (the provider carries `now`).
//
// The module is pure request→response plumbing over injected projections: same inputs ⇒ same
// SSE bytes. It builds the entire stream body eagerly from the authorized, already-buffered
// change window (a bounded catch-up read), so the `Response` is a complete, replayable artifact
// — deterministic and unit-testable via `app.fetch()` with no socket, timers, or live producer.

import type { App, AppContext, RouteHandler } from '../server.ts';

import {
  type EpochMillis,
  type TenantId,
  type Uuid,
  isUuid,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
  catalogEntryHasOwnershipGap,
  UNKNOWN_SOURCE_CLASS,
  type CoverageGap,
  type SourceCatalogEntry,
} from '@trustcircle/domain';
import {
  validateEnvelope,
  aggregateKey,
  emptyAggregateState,
  applyDelivery,
  missingVersions,
  type AggregateState,
  type DeliveryDecision,
} from '@trustcircle/contracts';
import type { InventoryService, InventoryRow } from '@trustcircle/application';

// ===========================================================================
// 0. Injected dependencies — the route composes an authorized feed; never builds it.
// ===========================================================================

/** A single authorized projection change, as the feed hands it to the route. Its `envelope` is a
 *  governance event envelope (validated with the @trustcircle/contracts runtime); `sequence` is
 *  the stream-global, strictly-increasing position that the resume cursor encodes. */
export interface ChangeRecord {
  /** Stream-global monotonic position (1-based, strictly increasing, gap-free within the window). */
  readonly sequence: number;
  /** The governance event envelope carrying the change. Validated before it is emitted. */
  readonly envelope: unknown;
}

/** The freshness of the projection the feed reads from (AC4 vocabulary, shared with the page
 *  metadata contract). `stale`/`unknown` mean current health MUST NOT be inferred from it. */
export type ProjectionFreshness = 'current' | 'aging' | 'stale' | 'unknown';

/**
 * The authorized change feed for one tenant. The composition root resolves it from the tenant's
 * real projection/outbox; the route reads ONLY this read surface.
 *
 * `records` is the RETAINED WINDOW of changes the caller is authorized to see, in ascending
 * `sequence` order. `windowFloorSequence` is the earliest sequence still retained: a resume
 * cursor pointing before it has EXPIRED (the missed span is no longer replayable in full), which
 * the route surfaces as a partial resume rather than a silent skip. `latestSequence` is the
 * newest retained position. `freshness`/`partialCoverage` describe the projection's own currency
 * so the stream can open fail-visibly. `now` is the injected projection clock.
 */
export interface TenantChangeFeed {
  readonly records: readonly ChangeRecord[];
  /** Earliest sequence still retained (1 when nothing has been evicted). */
  readonly windowFloorSequence: number;
  /** Newest retained sequence (0 when the window is empty). */
  readonly latestSequence: number;
  readonly freshness: ProjectionFreshness;
  /** True when the projection's coverage is known-incomplete (a partial picture). */
  readonly partialCoverage: boolean;
  readonly now: EpochMillis;
  /**
   * The tenant's authorized INVENTORY read model (the current-state governance view), already
   * folded from the authorized events by the composition root. When present, the stream projects
   * the current state onto the wire AFTER the change-delivery slice: one `item` record per governed
   * asset with its full facet set (AC1), a `gap` record per still-visible component gap (AC2) and
   * per governed-source gap (AC6) with reason/age/impact/owner-action (+ review/expiry for AC6), a
   * `correlation` record per asset carrying its distinct source records / status differences /
   * dependencies / authoritative fields (AC3), and a `catalog` record per discovered source with
   * its classification / location / access / sensitivity / ownership / onboarding / discovery
   * evidence (AC5). Each `item`/`catalog` carries a per-item last-known observation time AND a
   * confidence, and `reportedHealth` is withheld to 'unknown' whenever evidence is not current, so
   * current health is never inferred from stale data (AC4). Omitted for a pure change-transport
   * subscription (the change records alone are then streamed).
   */
  readonly projection?: InventoryService;
}

/** Resolves the authorized feed for an authenticated tenant, or `undefined` when the tenant has
 *  no stream (an empty, current stream — not an error — is then returned). */
export type ChangeFeedProvider = (tenantId: TenantId) => TenantChangeFeed | undefined;

export interface EventsRouteDeps {
  readonly feed: ChangeFeedProvider;
  /** SSE reconnection hint (ms) emitted as the leading `retry:` field. Default 3000. */
  readonly retryMillis?: number;
}

// ===========================================================================
// 1. Disclosure-safe Problem responder + tenant scope.
// ===========================================================================

/** Emit an RFC-9457-shaped Problem (same contract the inventory routes use). Never leaks internals. */
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
// 2. Resume-cursor codec — opaque, tenant + stream bound, position-carrying.
//    A cursor encodes the STREAM KIND, the TENANT it was minted for, and the
//    stream-global `sequence` of the last change delivered. Decoding validates
//    that the caller is resuming the SAME authorized stream (a foreign-tenant or
//    wrong-kind cursor is rejected), so resume can never cross an authorization
//    boundary or silently rebind to a different collection.
// ===========================================================================

const STREAM_KIND = 'projection-changes' as const;

interface ResumeCursor {
  readonly kind: typeof STREAM_KIND;
  readonly tenantId: string;
  readonly afterSequence: number;
}

/** Encode a resume cursor as the opaque SSE `id:` token. */
function encodeCursor(tenantId: string, afterSequence: number): string {
  const raw = JSON.stringify({ k: STREAM_KIND, t: tenantId, s: afterSequence });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** A decode failure carrier — kept distinct so the handler answers 400 rather than restarting. */
class CursorError extends Error {}

/**
 * Decode + authorize a resume cursor for `tenantId`. Returns `undefined` when absent (a fresh
 * subscription), or throws {@link CursorError} for a malformed / wrong-kind / foreign-tenant /
 * out-of-range cursor — so a bad resume token fails VISIBLY instead of silently restarting (which
 * would hide whether the consumer missed changes).
 */
function decodeCursor(
  value: string | null | undefined,
  tenantId: string,
): ResumeCursor | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('resume cursor is not decodable');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CursorError('resume cursor is malformed');
  }
  const rec = parsed as Record<string, unknown>;
  if (rec['k'] !== STREAM_KIND) {
    throw new CursorError('resume cursor belongs to a different stream');
  }
  if (rec['t'] !== tenantId) {
    // Authorization boundary: a cursor minted for another tenant can never resume this stream.
    throw new CursorError('resume cursor belongs to a different tenant');
  }
  const s = rec['s'];
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) {
    throw new CursorError('resume cursor position is invalid');
  }
  return { kind: STREAM_KIND, tenantId, afterSequence: s };
}

// ===========================================================================
// 3. SSE framing helpers.
// ===========================================================================

/** SSE event names the stream emits.
 *  - `change`      one applied projection change (transport slice + resume id).
 *  - `status`      read-position / freshness / partial note (never a resume point).
 *  - `gap`         a delivery-ordering gap (transport) OR a still-visible coverage gap (AC2/AC6).
 *  - `item`        one current-state governed-asset row with its full facet set (AC1/AC4).
 *  - `correlation` one asset's cross-source drill-down (AC3).
 *  - `catalog`     one discovered-source catalog entry (AC5). */
type SseEventName = 'change' | 'status' | 'gap' | 'item' | 'correlation' | 'catalog';

interface SseRecord {
  /** The resume `id:` (omitted for pure status/gap notes that must not become a resume point). */
  readonly id?: string;
  readonly event: SseEventName;
  readonly data: unknown;
}

/** Serialize one SSE record. `data` is JSON on a single line so a consumer parses each `data:`
 *  frame independently; newlines inside the JSON are impossible (JSON.stringify escapes them). */
function frameRecord(r: SseRecord): string {
  const lines: string[] = [];
  if (r.id !== undefined) lines.push(`id: ${r.id}`);
  lines.push(`event: ${r.event}`);
  lines.push(`data: ${JSON.stringify(r.data)}`);
  // A blank line terminates the record (SSE dispatch boundary).
  return `${lines.join('\n')}\n\n`;
}

/** An SSE comment line (`: ...`) — a keep-alive/heartbeat that is not dispatched as an event. */
function frameComment(text: string): string {
  return `: ${text}\n`;
}

// ===========================================================================
// 4. Time + per-change freshness.
// ===========================================================================

/** Epoch-ms → RFC3339 UTC string (the wire `date-time`). */
function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

/** The read-position `status` payload announced at the head of every stream. */
interface StreamStatus {
  readonly stream: typeof STREAM_KIND;
  readonly tenant_id: string;
  /** Where the stream is reading FROM (the resumed-after sequence, or the window floor - 1). */
  readonly from_sequence: number;
  /** The newest position available at open. */
  readonly latest_sequence: number;
  /** How resume was honoured. */
  readonly resume: 'fresh' | 'gapless' | 'partial';
  /** True when the delivered slice is known-incomplete: an expired cursor OR a partial projection. */
  readonly partial: boolean;
  /** The projection's freshness — stale/unknown ⇒ current health MUST NOT be inferred. */
  readonly freshness: ProjectionFreshness;
  /** For a partial resume: the sequence span that could not be replayed (missed changes). */
  readonly missed_sequence_span?: { readonly from: number; readonly to: number };
  readonly generated_at: string;
  /** A visible, alertable next action whenever the stream is not fresh + gapless. */
  readonly safe_next_action?: string;
}

/** The per-change payload. Carries the change plus the AC4 currency facets so a consumer never
 *  infers current health from a change it cannot trust as fresh. */
interface ChangePayload {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly occurred_at: string;
  readonly correlation_id: string;
  /** The change's own freshness relative to the projection snapshot. */
  readonly freshness: ProjectionFreshness;
  /** True iff this change is NOT safe to treat as current (projection stale/aging). */
  readonly stale: boolean;
}

/** Read the minimal envelope facets the SSE `change` payload needs, from a validated envelope. */
function envelopeFacets(
  env: Record<string, unknown>,
): Omit<ChangePayload, 'sequence' | 'freshness' | 'stale'> {
  return {
    event_id: String(env['event_id']),
    event_type: String(env['event_type']),
    aggregate_type: String(env['aggregate_type']),
    aggregate_id: String(env['aggregate_id']),
    aggregate_version: Number(env['aggregate_version']),
    occurred_at: String(env['occurred_at']),
    correlation_id: String(env['correlation_id']),
  };
}

/** A change is stale-to-apply iff the projection it came from is not `current`. Current health is
 *  never inferred from an aging/stale/unknown projection — the flag makes that explicit. */
function changeIsStale(freshness: ProjectionFreshness): boolean {
  return freshness !== 'current';
}

// ===========================================================================
// 4a. Projected current-state payloads — the AC1..AC6 governance view on the wire.
//
// When the feed carries the tenant's inventory read model, the stream emits, AFTER the change
// slice, a deterministic SNAPSHOT of the current state read from the projector's INDEPENDENT query
// surface (never a mutation echo). Each payload names its governance facets explicitly so the
// acceptance criteria are observable directly off the wire — not inferred from an opaque envelope.
// ===========================================================================

/** AC1 + AC4 — one governed-asset current-state row: each item ONCE with its full facet set, plus
 *  the per-item last-known observation time AND confidence, and a `reported_health` that is
 *  withheld to 'unknown' unless evidence is current (so current health is never inferred from stale
 *  data). */
interface ItemPayload {
  readonly kind: 'governed_asset';
  readonly asset_id: string;
  readonly asset_type: string;
  readonly name: string;
  /** AC1 ownership facet — an unowned item surfaces `null` + `ownership_gap: true`, never hidden. */
  readonly owner_principal_id: string | null;
  readonly ownership_gap: boolean;
  readonly lifecycle_state: string;
  readonly risk_tier: string;
  /** AC1 control-coverage facet. */
  readonly coverage: string;
  /** AC1 "health" — the health the item RECORDED (always shown). */
  readonly observed_health: string;
  /** AC4 — the health SAFE to report as current: 'unknown' unless evidence is current + confident. */
  readonly reported_health: string;
  /** AC1 evidence-state facet. */
  readonly evidence_state: string;
  /** AC1 unresolved-issues facet. */
  readonly unresolved_issues: number;
  /** AC3 related-source cardinality (distinct records that contributed). */
  readonly source_record_count: number;
  /** AC2 — true iff the item stays on-screen as a visible component coverage gap. */
  readonly has_visible_component_gap: boolean;
  /** AC4 last-known observation time (RFC3339), or `null` when never observed. */
  readonly last_observed_at: string | null;
  /** AC4 confidence ∈ [0,1] in this row's currency at the query instant. */
  readonly confidence: number;
  /** AC4 — true iff this row must NOT be treated as currently observed. */
  readonly stale: boolean;
}

/** AC2 (component) / AC6 (governed_source) — a still-VISIBLE coverage gap kept on-screen with its
 *  reason, age, impact, and required owner action (and, for a governed-source gap, a review or
 *  expiry deadline). Never reduced to a bare id, never silently dropped. */
interface GapSnapshotPayload {
  readonly kind: 'coverage_gap';
  readonly gap_id: string;
  readonly gap_class: 'component' | 'governed_source';
  readonly subject_id: string | null;
  readonly reason: string;
  readonly impact: string;
  /** AC2/AC6 "age" — millis since the gap was first seen, relative to the projection clock. */
  readonly age_millis: number;
  readonly required_action: string;
  readonly required_owner: string | null;
  /** AC6 "review or expiry" — present iff a governed-source gap carries a deadline. */
  readonly review_at?: string;
  readonly expires_at?: string;
  readonly has_deadline: boolean;
}

/** AC3 — one asset's cross-source drill-down: the DISTINCT source records that contributed, the
 *  per-field STATUS DIFFERENCES across those records (each differing value + the record ids that
 *  reported it), the DEPENDENCY edges, and the AUTHORITATIVE-field attributions. */
interface CorrelationPayload {
  readonly kind: 'correlation';
  readonly asset_id: string;
  /** The distinct source records correlated to this asset (id + class + external key + status). */
  readonly source_records: readonly {
    readonly record_id: string;
    readonly source_class: string;
    readonly external_key: string;
    readonly status: string;
  }[];
  /** Per-field status differences: fields where ≥2 distinct records disagree on a value (AC3). */
  readonly status_differences: readonly {
    readonly field: string;
    readonly values: readonly { readonly value: unknown; readonly record_ids: readonly string[] }[];
  }[];
  /** Dependency edges (`depends_on`) across the correlated sources (AC3). */
  readonly dependencies: readonly {
    readonly relationship_id: string;
    readonly from_id: string;
    readonly to_id: string;
    readonly field_name: string;
  }[];
  /** Authoritative-field attributions (`authoritative_for`) — the system of record per field (AC3). */
  readonly authoritative_fields: readonly {
    readonly relationship_id: string;
    readonly field: string;
    readonly authoritative_source_id: string;
  }[];
  /** True iff any governed field is unresolved — affected automation must pause safely (AC3). */
  readonly unresolved: boolean;
}

/** AC5 — one discovered source's catalog entry: its type-or-'unknown' classification, observed
 *  location(s), access status, sensitivity, ownership status, onboarding state, and discovery
 *  evidence. This is a real catalog entry, not a pass-through of envelope metadata. */
interface CatalogPayload {
  readonly kind: 'catalog_entry';
  readonly catalog_id: string;
  /** AC5 "type/unknown classification". */
  readonly source_class: string;
  readonly classified_unknown: boolean;
  /** AC5 "location" — the where-it-was-seen evidence. */
  readonly observed_locations: readonly string[];
  /** AC5 "access status". */
  readonly access_state: string;
  /** AC5 "sensitivity". */
  readonly sensitivity: string;
  /** AC5 "ownership status". */
  readonly owner_principal_id: string | null;
  readonly ownership_gap: boolean;
  /** AC5 "onboarding state". */
  readonly onboarding_state: string;
  /** AC5 "discovery evidence" — the observation id that surfaced this source, or `null`. */
  readonly discovery_evidence: string | null;
  /** First/last observed window (RFC3339). */
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

// ===========================================================================
// 5. The stream builder — pure over the authorized feed + resume cursor.
// ===========================================================================

// ===========================================================================
// 5a. Projected current-state emission (AC1..AC6) — read from the projector's
//     INDEPENDENT query surface, mapped to explicit-facet SSE records.
// ===========================================================================

/** AC1 + AC4: map a projector current-state row to the wire `item` payload. `stale` is derived the
 *  same way the query service does — confidence < 1 OR the row's evidence is not current — so
 *  `reported_health` is only the observed health when the item is safe to treat as current. */
function itemToWire(row: InventoryRow): ItemPayload {
  const stale = row.confidence < 1 || row.evidenceState !== 'current';
  return {
    kind: 'governed_asset',
    asset_id: String(row.assetId),
    asset_type: row.assetType,
    name: row.name,
    owner_principal_id: row.ownerPrincipalId !== undefined ? String(row.ownerPrincipalId) : null,
    ownership_gap: row.ownershipGap,
    lifecycle_state: row.lifecycleState,
    risk_tier: row.riskTier,
    coverage: row.coverage,
    observed_health: row.observedHealth,
    reported_health: row.reportedHealth,
    evidence_state: row.evidenceState,
    unresolved_issues: row.unresolvedIssueCount,
    source_record_count: row.sourceRecordCount,
    has_visible_component_gap: row.hasVisibleComponentGap,
    last_observed_at: row.lastObservationAt !== undefined ? iso(row.lastObservationAt) : null,
    confidence: row.confidence,
    stale,
  };
}

/** AC2/AC6: map a still-visible coverage gap to the wire `gap` snapshot payload. */
function gapSnapshotToWire(gap: CoverageGap, now: EpochMillis): GapSnapshotPayload {
  const base: GapSnapshotPayload = {
    kind: 'coverage_gap',
    gap_id: String(gap.id),
    gap_class: gap.gapClass,
    subject_id: gap.subjectId !== undefined ? String(gap.subjectId) : null,
    reason: gap.reason,
    impact: gap.impact,
    age_millis: gapAgeMillis(gap, now),
    required_action: gap.requiredAction,
    required_owner: gap.requiredOwner !== undefined ? String(gap.requiredOwner) : null,
    has_deadline: gapHasReviewOrExpiry(gap),
  };
  const withReview = gap.reviewAt !== undefined ? { ...base, review_at: iso(gap.reviewAt) } : base;
  return gap.expiresAt !== undefined
    ? { ...withReview, expires_at: iso(gap.expiresAt) }
    : withReview;
}

/** AC5: map a source-catalog entry to the wire `catalog` payload. */
function catalogToWire(e: SourceCatalogEntry): CatalogPayload {
  return {
    kind: 'catalog_entry',
    catalog_id: String(e.id),
    source_class: e.sourceClass,
    classified_unknown: e.sourceClass === UNKNOWN_SOURCE_CLASS,
    observed_locations: [...e.observedLocations],
    access_state: e.accessState,
    sensitivity: e.sensitivity,
    owner_principal_id: e.ownerPrincipalId !== undefined ? String(e.ownerPrincipalId) : null,
    ownership_gap: catalogEntryHasOwnershipGap(e),
    onboarding_state: e.onboardingState,
    discovery_evidence: e.discoveryEvidence !== undefined ? String(e.discoveryEvidence) : null,
    first_seen_at: iso(e.firstSeenAt),
    last_seen_at: iso(e.lastSeenAt),
  };
}

/** AC3: build one asset's cross-source correlation payload from the projector drill-down. Status
 *  differences are derived from the correlated fields whose contributing sources disagree — the
 *  distinct records + the differing values they reported. */
function correlationToWire(
  projection: InventoryService,
  assetId: Uuid,
  now: EpochMillis,
): CorrelationPayload {
  const drill = projection.drillDown(assetId, now);
  const item = drill.correlation;

  const statusDifferences = item.fields
    .filter((f) => f.contested && f.contributingSources.length >= 2)
    .map((f) => {
      // Group the contributing records by the (canonical) value they reported.
      const byValue = new Map<string, { value: unknown; recordIds: string[] }>();
      for (const cand of f.contributingSources) {
        const canonical = JSON.stringify(cand.value ?? null);
        const bucket = byValue.get(canonical) ?? { value: cand.value, recordIds: [] };
        bucket.recordIds.push(String(cand.recordId));
        byValue.set(canonical, bucket);
      }
      return {
        field: f.field,
        values: [...byValue.values()]
          .map((v) => ({ value: v.value, record_ids: [...v.recordIds].sort() }))
          .sort((a, b) => JSON.stringify(a.value).localeCompare(JSON.stringify(b.value))),
      };
    })
    // Only fields where the distinct records genuinely reported ≥2 different values.
    .filter((d) => d.values.length >= 2)
    .sort((a, b) => a.field.localeCompare(b.field));

  return {
    kind: 'correlation',
    asset_id: String(assetId),
    source_records: item.sourceRecords
      .map((r) => ({
        record_id: String(r.id),
        source_class: r.sourceClass,
        external_key: r.externalKey,
        status: r.status,
      }))
      .sort((a, b) => a.record_id.localeCompare(b.record_id)),
    status_differences: statusDifferences,
    dependencies: item.dependencies
      .map((d) => ({
        relationship_id: String(d.relationshipId),
        from_id: String(d.fromId),
        to_id: String(d.toId),
        field_name: d.fieldName,
      }))
      .sort((a, b) => a.relationship_id.localeCompare(b.relationship_id)),
    authoritative_fields: item.authoritativeFields
      .map((a) => ({
        relationship_id: String(a.relationshipId),
        field: a.field,
        authoritative_source_id: String(a.authoritativeSourceId),
      }))
      .sort((x, y) => x.relationship_id.localeCompare(y.relationship_id)),
    unresolved: item.automationPaused,
  };
}

/**
 * Emit the projected current-state SNAPSHOT (AC1..AC6) as SSE records, read from the projector's
 * independent query surface at `now`. Deterministic: identical read model ⇒ identical bytes. The
 * snapshot records carry NO resume `id:` — they are the current-state view, not resumable change
 * positions (a reconnecting client re-reads the snapshot fresh). Ordering is stable (sorted by id)
 * so the wire bytes are reproducible.
 */
function projectionSnapshotChunks(projection: InventoryService, now: EpochMillis): string[] {
  const chunks: string[] = [];

  // AC1/AC4 — one `item` record per governed asset, each ONCE, with the full facet set.
  const rows = projection.currentStateView(now);
  for (const row of rows) {
    chunks.push(frameRecord({ event: 'item', data: itemToWire(row) }));
  }

  // AC3 — one `correlation` record per asset (distinct records / status differences / deps / auth).
  for (const row of rows) {
    chunks.push(
      frameRecord({
        event: 'correlation',
        data: correlationToWire(projection, row.assetId, now),
      }),
    );
  }

  // AC2 — still-visible component coverage gaps (reason/age/impact/owner-action).
  for (const gap of projection.componentGaps().filter(gapIsVisible)) {
    chunks.push(frameRecord({ event: 'gap', data: gapSnapshotToWire(gap, now) }));
  }

  // AC6 — still-visible governed-source gaps (reason/impact/owner-action/review-or-expiry).
  for (const gap of projection.governedSourceGaps().filter(gapIsVisible)) {
    chunks.push(frameRecord({ event: 'gap', data: gapSnapshotToWire(gap, now) }));
  }

  // AC5 — the source catalog: every discovered/registered source, classified + located + governed.
  for (const entry of projection.catalog()) {
    chunks.push(frameRecord({ event: 'catalog', data: catalogToWire(entry) }));
  }

  return chunks;
}

interface BuiltStream {
  readonly body: string;
  /** The resume cursor a client should send to continue after this response (the last id, or the
   *  incoming resume point when nothing new was delivered). Surfaced as a response header too. */
  readonly nextCursor: string;
  readonly status: StreamStatus;
}

/**
 * Build the complete SSE body for one authorized catch-up read. Pure: identical (feed, cursor,
 * retryMillis) ⇒ identical bytes. Ordering is validated with the shared events runtime so a
 * duplicate is dropped, an out-of-order/missing predecessor becomes a visible `gap`, and a
 * malformed envelope is skipped with a visible note — the stream is never silently corrupted.
 */
function buildStream(
  feed: TenantChangeFeed,
  tenantId: string,
  cursor: ResumeCursor | undefined,
  retryMillis: number,
): BuiltStream {
  const records = [...feed.records].sort((a, b) => a.sequence - b.sequence);

  // --- Resolve the read position + partial/resume classification. ---
  let resume: StreamStatus['resume'];
  let partial = feed.partialCoverage;
  let fromSequence: number;
  let missed: { from: number; to: number } | undefined;

  if (cursor === undefined) {
    resume = 'fresh';
    fromSequence = feed.windowFloorSequence - 1;
  } else if (cursor.afterSequence < feed.windowFloorSequence - 1) {
    // Cursor points before the retained window: the span (cursor+1 .. floor-1) is unreplayable.
    resume = 'partial';
    partial = true;
    fromSequence = feed.windowFloorSequence - 1;
    missed = { from: cursor.afterSequence + 1, to: feed.windowFloorSequence - 1 };
  } else {
    resume = 'gapless';
    fromSequence = cursor.afterSequence;
  }

  const toDeliver = records.filter((r) => r.sequence > fromSequence);

  // --- Ordering validation over the delivered slice (per aggregate stream). ---
  //
  // The per-aggregate ordering tracker (@trustcircle/contracts events runtime) detects a missing
  // predecessor WITHIN the delivered slice. But the stream's own gap-free authority is the
  // STREAM-GLOBAL `sequence`, and on resume (or after window eviction) the consumer legitimately
  // no longer holds the earlier aggregate versions — those were either delivered on a prior read
  // (`gapless`) or surfaced as the `partial` missed span above. Re-flagging the FIRST retained
  // version of each aggregate as an out-of-order gap would be a false alarm. So we PRIME each
  // aggregate's `lastAppliedVersion` to one-below the first version actually present in the
  // delivered slice: the first retained change always applies, and only a gap INTERNAL to the
  // delivered window (a truly-missing predecessor between two delivered changes) is flagged.
  const aggregateKeyOf = (env: Record<string, unknown>): string =>
    aggregateKey({
      tenant_id: String(env['tenant_id']),
      aggregate_type: String(env['aggregate_type']),
      aggregate_id: String(env['aggregate_id']),
    });
  //
  // Priming only applies when prior history plausibly existed but is no longer in view: a RESUME
  // (a cursor was supplied) or a window whose floor has advanced past 1 (older changes evicted). A
  // FRESH read over a full window (no cursor, floor == 1) is NOT primed — there, a change whose
  // predecessor is genuinely absent is a real gap the producer never emitted, and must be surfaced.
  const priorHistoryDropped = cursor !== undefined || feed.windowFloorSequence > 1;
  const toDeliverValid = toDeliver.filter((r) => validateEnvelope(r.envelope).valid);
  const baselineVersion = new Map<string, number>();
  if (priorHistoryDropped) {
    for (const rec of toDeliverValid) {
      const env = rec.envelope as Record<string, unknown>;
      const key = aggregateKeyOf(env);
      const v = Number(env['aggregate_version']);
      const cur = baselineVersion.get(key);
      if (cur === undefined || v < cur) baselineVersion.set(key, v);
    }
  }
  const orderingByAggregate = new Map<string, AggregateState>();
  for (const [key, minVersion] of baselineVersion) {
    // Seed an already-applied history up to (minVersion - 1) so the first delivered version is the
    // expected next one. (A zero baseline means the slice starts at v1 — no priming needed.)
    if (minVersion > 1) {
      orderingByAggregate.set(key, {
        ...emptyAggregateState(),
        lastAppliedVersion: minVersion - 1,
      });
    }
  }

  const chunks: string[] = [];

  // Leading reconnection hint + the head `status` record (read position + freshness/partial).
  chunks.push(`retry: ${retryMillis}\n`);

  const notFreshOrGapless = feed.freshness !== 'current' || resume === 'partial' || partial;
  const status: StreamStatus = {
    stream: STREAM_KIND,
    tenant_id: tenantId,
    from_sequence: fromSequence,
    latest_sequence: feed.latestSequence,
    resume,
    partial,
    freshness: feed.freshness,
    ...(missed ? { missed_sequence_span: missed } : {}),
    generated_at: iso(feed.now),
    ...(notFreshOrGapless
      ? {
          safe_next_action:
            resume === 'partial'
              ? 'resume was partial: the missed sequence span is no longer retained — reconcile from the authoritative projection before trusting continuity'
              : feed.freshness !== 'current'
                ? 'projection is not current: do not infer live health from these changes; refresh from source'
                : 'projection coverage is partial: treat the stream as an incomplete picture until coverage is restored',
        }
      : {}),
  };
  chunks.push(frameRecord({ event: 'status', data: status }));

  // --- Emit each authorized change as a resumable SSE record. ---
  let lastEmittedSequence = fromSequence;
  for (const rec of toDeliver) {
    const validation = validateEnvelope(rec.envelope);
    if (!validation.valid) {
      // A malformed envelope is skipped VISIBLY (never applied, never silently dropped) so the
      // consumer knows a change could not be delivered. It does not advance the resume id — a
      // reconnecting client should not skip past an unresolved position.
      chunks.push(
        frameRecord({
          event: 'status',
          data: {
            stream: STREAM_KIND,
            tenant_id: tenantId,
            sequence: rec.sequence,
            skipped: true,
            reason: 'change envelope failed contract validation',
            problems: validation.problems.map((p) => ({ path: p.path, code: p.code })),
          },
        }),
      );
      continue;
    }

    const env = rec.envelope as Record<string, unknown>;
    const key = aggregateKeyOf(env);
    const prior = orderingByAggregate.get(key) ?? emptyAggregateState();
    const step = applyDelivery(prior, rec.envelope);
    orderingByAggregate.set(key, step.state);
    const decision: DeliveryDecision = step.classification.decision;

    if (decision === 'duplicate') {
      // Safe under duplicate: no second effect. Do not re-emit; advance the resume id so a
      // reconnecting client does not receive it again either.
      lastEmittedSequence = rec.sequence;
      continue;
    }

    if (decision === 'out_of_order' || decision === 'gap' || decision === 'conflict') {
      // A missing predecessor / conflicting slot is surfaced as a visible `gap` note and NOT
      // applied out of order. The resume id does not advance past an unresolved gap.
      chunks.push(
        frameRecord({
          event: 'gap',
          data: {
            stream: STREAM_KIND,
            tenant_id: tenantId,
            sequence: rec.sequence,
            aggregate_type: String(env['aggregate_type']),
            aggregate_id: String(env['aggregate_id']),
            aggregate_version: Number(env['aggregate_version']),
            decision,
            ...(step.classification.awaitingVersion !== undefined
              ? { awaiting_version: step.classification.awaitingVersion }
              : {}),
            // The explicit set of contiguous aggregate versions still missing before this change
            // can be applied — the reconciliation view of the gap, never a silent skip.
            missing_versions: missingVersions(step.state),
            retryable: step.classification.retryable,
            reason: step.classification.reason,
          },
        }),
      );
      continue;
    }

    // decision === 'apply' — the change is delivered with its resume id + currency facets.
    const payload: ChangePayload = {
      sequence: rec.sequence,
      ...envelopeFacets(env),
      freshness: feed.freshness,
      stale: changeIsStale(feed.freshness),
    };
    chunks.push(
      frameRecord({
        id: encodeCursor(tenantId, rec.sequence),
        event: 'change',
        data: payload,
      }),
    );
    lastEmittedSequence = rec.sequence;
  }

  // --- Projected CURRENT-STATE snapshot (AC1..AC6) — the authorized governance view on the wire. ---
  // When the feed carries the tenant's inventory read model, project its current state (read from
  // the projector's INDEPENDENT query surface) so a consumer sees each governed item ONCE with its
  // full facet set, the still-visible coverage / governed-source gaps, the per-asset cross-source
  // correlation, and the source catalog — directly off the wire, not inferred from opaque envelopes.
  if (feed.projection !== undefined) {
    for (const chunk of projectionSnapshotChunks(feed.projection, feed.now)) chunks.push(chunk);
  }

  // A trailing heartbeat comment so a consumer can distinguish "stream open, nothing more" from a
  // truncated body. Never dispatched as an event; carries no resume id.
  chunks.push(frameComment('keep-alive'));

  return {
    body: chunks.join(''),
    nextCursor: encodeCursor(tenantId, lastEmittedSequence),
    status,
  };
}

// ===========================================================================
// 6. Handler.
// ===========================================================================

/** Response headers exported so consumers + tests share the single source of truth. */
export const EVENTS_HEADERS = {
  /** The resume cursor a client should send next (mirrors the last SSE `id:`). */
  nextCursor: 'x-next-cursor',
  /** The stream's partial/resume status at open, for a client that reads headers before the body. */
  streamStatus: 'x-stream-status',
  /** The projection freshness at open. */
  freshness: 'x-projection-freshness',
} as const;

/** The standard SSE resume header a reconnecting client sends. */
const LAST_EVENT_ID_HEADER = 'last-event-id';

/** GET /events — the authorized projection-change SSE stream (cursor resume + stale/partial). */
function streamEvents(deps: EventsRouteDeps): RouteHandler {
  return (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required to subscribe to projection changes.',
      );
    }

    const url = new URL(c.req.url, 'http://internal');

    // Resume token: the standard SSE `Last-Event-ID` header, or an explicit `?cursor=` (which the
    // header takes precedence over — a reconnecting EventSource always sends the header).
    const headerCursor = c.req.header(LAST_EVENT_ID_HEADER);
    const queryCursor = url.searchParams.get('cursor');
    const rawCursor = headerCursor ?? queryCursor;

    let cursor: ResumeCursor | undefined;
    try {
      cursor = decodeCursor(rawCursor, String(tenantId));
    } catch (e) {
      return problem(c, 400, 'invalid_cursor', 'Bad Request', (e as Error).message, [
        'reconnect without a Last-Event-ID / cursor to restart the subscription from the retained window',
      ]);
    }

    const feed = deps.feed(tenantId);
    if (feed === undefined) {
      // No stream for this tenant ⇒ an empty, current stream (a valid subscription, not an error).
      const empty: TenantChangeFeed = {
        records: [],
        windowFloorSequence: 1,
        latestSequence: 0,
        freshness: 'current',
        partialCoverage: false,
        now: 0 as EpochMillis,
      };
      return sseResponse(c, buildStream(empty, String(tenantId), cursor, deps.retryMillis ?? 3000));
    }

    const built = buildStream(feed, String(tenantId), cursor, deps.retryMillis ?? 3000);
    return sseResponse(c, built);
  };
}

/** Assemble the SSE `Response` with the correct headers + the resume/status/freshness surface. */
function sseResponse(c: AppContext, built: BuiltStream): Response {
  c.setHeader('content-type', 'text/event-stream; charset=utf-8');
  // SSE proxies must not buffer or transform the stream, and it must not be cached.
  c.setHeader('cache-control', 'no-cache, no-transform');
  c.setHeader('connection', 'keep-alive');
  c.setHeader('x-accel-buffering', 'no');
  c.setHeader(EVENTS_HEADERS.nextCursor, built.nextCursor);
  c.setHeader(EVENTS_HEADERS.streamStatus, built.status.partial ? 'partial' : built.status.resume);
  c.setHeader(EVENTS_HEADERS.freshness, built.status.freshness);
  return c.text(built.body, 200);
}

// ===========================================================================
// 7. Registration.
// ===========================================================================

/**
 * Mount the authorized projection-change stream onto `app`. The route is AUTHENTICATED (it
 * carries a tenant scope). The path is registered WITHOUT the version prefix — `App.get`
 * prepends `API_PREFIX` (`/v1`), so it serves at `/v1/events`.
 */
export function registerEventsRoutes(app: App, deps: EventsRouteDeps): App {
  app.get('/events', streamEvents(deps));
  return app;
}

// Re-export the cursor codec + stream constant so tests can assert cursor opacity / tenant
// rebinding / stream binding without duplicating the encoding.
export type { ResumeCursor };
export { encodeCursor as encodeResumeCursor, STREAM_KIND as EVENTS_STREAM_KIND };
