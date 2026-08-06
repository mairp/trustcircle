// @trustcircle/application — SOURCE INGESTION: deterministic merge of periodic snapshots and ordered
// events, PRESERVING raw observations, tombstones, unknown values, and source authority (Phase 8 /
// User Story 6 / T237 / FR-029, FR-030).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE, deterministic projection that folds a batch of source OBSERVATIONS — periodic snapshots and
// ordered incremental events — into an ingestion state. Its load-bearing invariants, aligned with the
// migration 0060 `connector_inbox` shapes (dedup_key + aggregate_ref + sequence_no):
//   * AT-LEAST-ONCE → EXACTLY-ONE EFFECT. Observations are DEDUPLICATED by `dedupKey`: a re-delivery
//     under a key already seen is a no-op (mirrors the migration UNIQUE (tenant, connector, dedup_key)).
//   * AGGREGATE ORDERING PRESERVED. Per `aggregateRef`, observations are ordered by `sequence` and the
//     newest sequence WINS for the merged projection, but a LOWER sequence arriving later is retained
//     as a raw observation and flagged out-of-order — never silently discarded.
//   * RAW OBSERVATIONS ARE PRESERVED. Every accepted observation is appended to an append-only raw log
//     — the merge is a VIEW, never a replacement of the source record.
//   * TOMBSTONES ARE TOMBSTONES. A tombstone marks an aggregate as deleted-at-source; it is NEVER a
//     governance closure. The projection carries `tombstoned: true` with the raw record retained.
//   * UNKNOWN VALUES ARE KEPT VERBATIM. An unknown enum / status value is preserved exactly as the
//     source reported it (never coerced to a default, never dropped) so nothing is lost in translation.
//   * SOURCE AUTHORITY PRESERVED. The merged value records WHICH source datum it derives from and its
//     sequence — the source remains authoritative for its own data; ingestion never invents facts.
//
// Pure, dependency-free (Node built-in `node:crypto` only): no wall-clock reads, no I/O, no Math.random.
// `ingest(state, observations)` returns a NEW state plus a content digest — the durable-effect witness.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Hashing (fail-visible, canonical).
// ===========================================================================

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
function assertSequence(n: unknown, label: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative integer sequence, got ${String(n)}`);
  }
}

// ===========================================================================
// 1. The observation input shape (a periodic snapshot datum OR an ordered event).
// ===========================================================================

/** The kind of source datum. A snapshot is a full state assertion; an event is an incremental change. */
export const OBSERVATION_KINDS = ['snapshot', 'event'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * A single raw source observation. `dedupKey` deduplicates at-least-once delivery; `aggregateRef` +
 * `sequence` order it within its aggregate; `tombstone` marks a source-deletion. `payload` is the raw
 * source datum — unknown values are preserved verbatim, never coerced.
 */
export interface SourceObservation {
  readonly dedupKey: string;
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly kind: ObservationKind;
  /** True iff this observation asserts the aggregate was DELETED at source (a tombstone). */
  readonly tombstone?: boolean;
  /** The raw source datum, preserved verbatim (unknown enum/status values kept as-is). */
  readonly payload: unknown;
}

// ===========================================================================
// 2. The retained raw-observation record + the merged aggregate view.
// ===========================================================================

/** An append-only raw-observation log entry — the source record is never replaced, only appended. */
export interface RawObservation {
  readonly dedupKey: string;
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly kind: ObservationKind;
  readonly tombstone: boolean;
  readonly payload: unknown;
  /** True iff this observation arrived with a sequence <= the aggregate's high-water mark at accept. */
  readonly outOfOrder: boolean;
}

/**
 * The MERGED view of one aggregate — a deterministic projection, never a replacement of the source.
 * It records the authoritative source datum, the winning sequence, whether it is tombstoned, and the
 * raw payload verbatim (unknown values intact).
 */
export interface MergedAggregate {
  readonly aggregateRef: string;
  /** The highest sequence observed for this aggregate (the authority high-water mark). */
  readonly sequence: number;
  /** The dedup key of the observation that produced the current merged value. */
  readonly sourceDedupKey: string;
  /** True iff the aggregate is tombstoned at source (deleted) — NEVER a governance closure. */
  readonly tombstoned: boolean;
  /** The raw source payload for the current merged value, verbatim. */
  readonly payload: unknown;
}

/** The full ingestion state: dedup ledger + append-only raw log + merged-aggregate view. */
export interface IngestionState {
  /** Every dedup key ever accepted (the exactly-one-effect ledger). */
  readonly seenDedupKeys: readonly string[];
  /** The append-only raw-observation log (source record preserved). */
  readonly rawLog: readonly RawObservation[];
  /** The merged per-aggregate view, keyed by aggregateRef (deterministic projection). */
  readonly aggregates: Readonly<Record<string, MergedAggregate>>;
}

/** An empty ingestion state (the fold's identity element). */
export function emptyIngestionState(): IngestionState {
  return Object.freeze({
    seenDedupKeys: Object.freeze([]),
    rawLog: Object.freeze([]),
    aggregates: Object.freeze({}),
  });
}

// ===========================================================================
// 3. ingest — the deterministic fold.
// ===========================================================================

export interface IngestResult {
  readonly state: IngestionState;
  /** How many observations were accepted (net of dedup no-ops). */
  readonly accepted: number;
  /** How many observations were deduplicated no-ops (at-least-once → exactly-one effect). */
  readonly deduplicated: number;
  /** The content digest of the resulting state — the durable-effect witness. */
  readonly digest: string;
}

/**
 * Fold `observations` into `state`, returning a NEW state + a content digest. Deterministic: the
 * same (state, observations) always yields the same result. Observations are processed in a stable
 * order — first by aggregateRef, then by sequence, then by dedupKey — so the fold is order-independent
 * of the input batch's arrival order (aggregate ordering preserved by sequence, not by arrival).
 */
export function ingest(
  state: IngestionState,
  observations: readonly SourceObservation[],
): IngestResult {
  const seen = new Set(state.seenDedupKeys);
  const rawLog: RawObservation[] = [...state.rawLog];
  const aggregates: Record<string, MergedAggregate> = { ...state.aggregates };
  let accepted = 0;
  let deduplicated = 0;

  // Stable, arrival-order-independent processing order so the fold is deterministic.
  const ordered = [...observations].sort((a, b) => {
    if (a.aggregateRef !== b.aggregateRef) return a.aggregateRef < b.aggregateRef ? -1 : 1;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0;
  });

  for (const obs of ordered) {
    assertNonEmpty(obs.dedupKey, 'observation.dedupKey');
    assertNonEmpty(obs.aggregateRef, 'observation.aggregateRef');
    assertSequence(obs.sequence, 'observation.sequence');
    if (obs.kind !== 'snapshot' && obs.kind !== 'event') {
      throw new TypeError(`observation.kind must be one of ${OBSERVATION_KINDS.join('|')}`);
    }

    // AT-LEAST-ONCE → EXACTLY-ONE EFFECT: a re-delivered dedup key is a no-op.
    if (seen.has(obs.dedupKey)) {
      deduplicated += 1;
      continue;
    }
    seen.add(obs.dedupKey);
    accepted += 1;

    const current = aggregates[obs.aggregateRef];
    const highWater = current?.sequence ?? -1;
    const outOfOrder = obs.sequence <= highWater;
    const tombstone = obs.tombstone === true;

    // RAW OBSERVATION PRESERVED (append-only) — verbatim payload, out-of-order flag intact.
    rawLog.push(
      Object.freeze({
        dedupKey: obs.dedupKey,
        aggregateRef: obs.aggregateRef,
        sequence: obs.sequence,
        kind: obs.kind,
        tombstone,
        payload: obs.payload,
        outOfOrder,
      }),
    );

    // AGGREGATE ORDERING: only a NEWER sequence advances the merged view; a lower/equal sequence is
    // retained in the raw log (above) but does NOT overwrite the authoritative current value.
    if (obs.sequence > highWater) {
      aggregates[obs.aggregateRef] = Object.freeze({
        aggregateRef: obs.aggregateRef,
        sequence: obs.sequence,
        sourceDedupKey: obs.dedupKey,
        // TOMBSTONE IS A TOMBSTONE — carried explicitly, NEVER a governance closure.
        tombstoned: tombstone,
        // UNKNOWN VALUES KEPT VERBATIM — the raw payload is the merged value.
        payload: obs.payload,
      });
    }
  }

  const nextState: IngestionState = Object.freeze({
    seenDedupKeys: Object.freeze([...seen].sort()),
    rawLog: Object.freeze(rawLog),
    aggregates: Object.freeze(aggregates),
  });

  return Object.freeze({
    state: nextState,
    accepted,
    deduplicated,
    digest: ingestionDigest(nextState),
  });
}

// ===========================================================================
// 4. Queries + content digest.
// ===========================================================================

/** The merged view of one aggregate (undefined if never observed). */
export function mergedAggregate(
  state: IngestionState,
  aggregateRef: string,
): MergedAggregate | undefined {
  return state.aggregates[aggregateRef];
}

/** The raw-observation log for one aggregate, in accepted order (source record preserved). */
export function rawObservationsFor(
  state: IngestionState,
  aggregateRef: string,
): readonly RawObservation[] {
  return Object.freeze(state.rawLog.filter((r) => r.aggregateRef === aggregateRef));
}

/**
 * A stable content digest over the whole ingestion state (dedup ledger + raw log + merged view).
 * Identical accepted observations ⇒ identical digest — the durable-effect witness.
 */
export function ingestionDigest(state: IngestionState): string {
  const aggParts = Object.keys(state.aggregates)
    .sort()
    .map((k) => canonicalJson(state.aggregates[k]));
  const rawParts = [...state.rawLog].map((r) => canonicalJson(r)).sort();
  return sha256(
    canonicalJson({
      seen: [...state.seenDedupKeys].sort(),
      raw: rawParts,
      aggregates: aggParts,
    }),
  );
}
