// @trustcircle/application — CURSOR RECOVERY: pure detectors for cursor loss, backlog gaps, duplicate /
// stale / out-of-order events, mapping changes, and source-identity changes (Phase 8 / User Story 6 /
// T238 / FR-029).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE family of detectors that compares a PRIOR cursor against a newly-observed batch and returns a
// typed set of FINDINGS. Recovery is never automatic and never silent — a lost or drifted cursor is
// SURFACED as a named finding an owner can act on. The detectors, each a named finding class:
//   * CURSOR LOSS — the prior cursor is absent/undefined while a backlog exists (we cannot know our
//     position; a from-scratch replay must be authorized, never assumed).
//   * BACKLOG GAP — a missing sequence number within an aggregate (a hole between the prior high-water
//     mark and the batch, or between consecutive observed sequences). Aligns with the migration
//     `connector_inbox` sequence column making a missing sequence detectable (FR-029).
//   * DUPLICATE — the same (aggregateRef, sequence) or the same dedupKey observed more than once.
//   * STALE — an observation at or below the prior cursor's high-water mark for its aggregate.
//   * OUT-OF-ORDER — within the batch, a sequence that arrives after a higher sequence for the same
//     aggregate (the stream is not monotonic).
//   * MAPPING CHANGE — the schema/mapping version the source reports differs from the prior cursor's.
//   * SOURCE-IDENTITY CHANGE — the source identity (sourceRef) differs from the prior cursor's — a
//     different source must never be silently accepted as the same stream.
//
// Pure, dependency-free (no Node built-ins needed beyond none): no wall-clock reads, no I/O, no random.
// `detect(prior, batch)` returns the full finding set; each finding class is independently constructable.

// ===========================================================================
// 0. Guards (fail-visible).
// ===========================================================================

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
// 1. Inputs — the prior cursor + the newly-observed batch.
// ===========================================================================

/**
 * The prior durable cursor for a connector's stream. `highWater` maps each aggregateRef to the last
 * durably-processed sequence. `mappingVersion` is the schema/mapping version last seen; `sourceRef`
 * is the source identity the cursor was bound to. An undefined cursor is a LOSS candidate.
 */
export interface PriorCursor {
  readonly sourceRef: string;
  readonly mappingVersion: string;
  /** Last durably-processed sequence per aggregateRef. */
  readonly highWater: Readonly<Record<string, number>>;
}

/** One event in the newly-observed batch. */
export interface BatchEvent {
  readonly dedupKey: string;
  readonly aggregateRef: string;
  readonly sequence: number;
  /** The source identity this event was delivered from. */
  readonly sourceRef: string;
  /** The schema/mapping version this event was encoded with. */
  readonly mappingVersion: string;
}

// ===========================================================================
// 2. Finding classes (each a named, typed class).
// ===========================================================================

export const CURSOR_FINDING_KINDS = [
  'cursor_loss',
  'backlog_gap',
  'duplicate',
  'stale',
  'out_of_order',
  'mapping_change',
  'source_identity_change',
] as const;
export type CursorFindingKind = (typeof CURSOR_FINDING_KINDS)[number];

/** The prior cursor is absent while a backlog exists — position unknown; replay must be authorized. */
export interface CursorLossFinding {
  readonly kind: 'cursor_loss';
  readonly backlogSize: number;
}
/** A missing sequence number within an aggregate — a hole in the ordered stream. */
export interface BacklogGapFinding {
  readonly kind: 'backlog_gap';
  readonly aggregateRef: string;
  /** The first missing sequence (inclusive). */
  readonly fromSequence: number;
  /** The last missing sequence (inclusive). */
  readonly toSequence: number;
}
/** The same (aggregateRef, sequence) or dedupKey observed more than once. */
export interface DuplicateFinding {
  readonly kind: 'duplicate';
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly dedupKey: string;
}
/** An observation at or below the prior high-water mark for its aggregate — already processed. */
export interface StaleFinding {
  readonly kind: 'stale';
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly highWater: number;
}
/** Within the batch, a lower sequence arrived after a higher one for the same aggregate. */
export interface OutOfOrderFinding {
  readonly kind: 'out_of_order';
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly afterSequence: number;
}
/** The schema/mapping version differs from the prior cursor's. */
export interface MappingChangeFinding {
  readonly kind: 'mapping_change';
  readonly priorMappingVersion: string;
  readonly observedMappingVersion: string;
}
/** The source identity differs from the prior cursor's — a different source, not the same stream. */
export interface SourceIdentityChangeFinding {
  readonly kind: 'source_identity_change';
  readonly priorSourceRef: string;
  readonly observedSourceRef: string;
}

export type CursorFinding =
  | CursorLossFinding
  | BacklogGapFinding
  | DuplicateFinding
  | StaleFinding
  | OutOfOrderFinding
  | MappingChangeFinding
  | SourceIdentityChangeFinding;

// ===========================================================================
// 3. Individual detectors (each independently constructable, pure).
// ===========================================================================

/** CURSOR LOSS: no prior cursor (undefined) while the batch is non-empty ⇒ position unknown. */
export function detectCursorLoss(
  prior: PriorCursor | undefined,
  batch: readonly BatchEvent[],
): readonly CursorLossFinding[] {
  if (prior === undefined && batch.length > 0) {
    return Object.freeze([
      Object.freeze({ kind: 'cursor_loss' as const, backlogSize: batch.length }),
    ]);
  }
  return Object.freeze([]);
}

/**
 * BACKLOG GAP: within each aggregate, a missing sequence between the prior high-water mark (exclusive)
 * and the batch's sequences, or between consecutive observed sequences. Emits one finding per hole.
 */
export function detectBacklogGaps(
  prior: PriorCursor | undefined,
  batch: readonly BatchEvent[],
): readonly BacklogGapFinding[] {
  const byAggregate = new Map<string, number[]>();
  for (const e of batch) {
    const list = byAggregate.get(e.aggregateRef) ?? [];
    list.push(e.sequence);
    byAggregate.set(e.aggregateRef, list);
  }
  const out: BacklogGapFinding[] = [];
  for (const [aggregateRef, seqs] of [...byAggregate.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    // A hole between the prior high-water mark and the first observed sequence.
    const priorHigh = prior?.highWater[aggregateRef];
    if (priorHigh !== undefined && sorted.length > 0 && sorted[0]! > priorHigh + 1) {
      out.push(
        Object.freeze({
          kind: 'backlog_gap' as const,
          aggregateRef,
          fromSequence: priorHigh + 1,
          toSequence: sorted[0]! - 1,
        }),
      );
    }
    // Holes between consecutive observed sequences.
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur > prev + 1) {
        out.push(
          Object.freeze({
            kind: 'backlog_gap' as const,
            aggregateRef,
            fromSequence: prev + 1,
            toSequence: cur - 1,
          }),
        );
      }
    }
  }
  return Object.freeze(out);
}

/** DUPLICATE: the same (aggregateRef, sequence) or the same dedupKey observed more than once. */
export function detectDuplicates(batch: readonly BatchEvent[]): readonly DuplicateFinding[] {
  const seenPair = new Set<string>();
  const seenDedup = new Set<string>();
  const out: DuplicateFinding[] = [];
  for (const e of batch) {
    const pair = `${e.aggregateRef}#${e.sequence}`;
    const isDupPair = seenPair.has(pair);
    const isDupKey = seenDedup.has(e.dedupKey);
    if (isDupPair || isDupKey) {
      out.push(
        Object.freeze({
          kind: 'duplicate' as const,
          aggregateRef: e.aggregateRef,
          sequence: e.sequence,
          dedupKey: e.dedupKey,
        }),
      );
    }
    seenPair.add(pair);
    seenDedup.add(e.dedupKey);
  }
  return Object.freeze(out);
}

/** STALE: an observation at or below the prior high-water mark for its aggregate (already processed). */
export function detectStale(
  prior: PriorCursor | undefined,
  batch: readonly BatchEvent[],
): readonly StaleFinding[] {
  if (prior === undefined) return Object.freeze([]);
  const out: StaleFinding[] = [];
  for (const e of batch) {
    const high = prior.highWater[e.aggregateRef];
    if (high !== undefined && e.sequence <= high) {
      out.push(
        Object.freeze({
          kind: 'stale' as const,
          aggregateRef: e.aggregateRef,
          sequence: e.sequence,
          highWater: high,
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** OUT-OF-ORDER: within the batch (arrival order), a sequence that arrives after a higher one. */
export function detectOutOfOrder(batch: readonly BatchEvent[]): readonly OutOfOrderFinding[] {
  const maxSeen = new Map<string, number>();
  const out: OutOfOrderFinding[] = [];
  for (const e of batch) {
    const prevMax = maxSeen.get(e.aggregateRef);
    if (prevMax !== undefined && e.sequence < prevMax) {
      out.push(
        Object.freeze({
          kind: 'out_of_order' as const,
          aggregateRef: e.aggregateRef,
          sequence: e.sequence,
          afterSequence: prevMax,
        }),
      );
    }
    if (prevMax === undefined || e.sequence > prevMax) maxSeen.set(e.aggregateRef, e.sequence);
  }
  return Object.freeze(out);
}

/** MAPPING CHANGE: any batch event whose mapping version differs from the prior cursor's. */
export function detectMappingChanges(
  prior: PriorCursor | undefined,
  batch: readonly BatchEvent[],
): readonly MappingChangeFinding[] {
  if (prior === undefined) return Object.freeze([]);
  const observed = new Set<string>();
  for (const e of batch)
    if (e.mappingVersion !== prior.mappingVersion) observed.add(e.mappingVersion);
  return Object.freeze(
    [...observed].sort().map((v) =>
      Object.freeze({
        kind: 'mapping_change' as const,
        priorMappingVersion: prior.mappingVersion,
        observedMappingVersion: v,
      }),
    ),
  );
}

/** SOURCE-IDENTITY CHANGE: any batch event whose sourceRef differs from the prior cursor's. */
export function detectSourceIdentityChanges(
  prior: PriorCursor | undefined,
  batch: readonly BatchEvent[],
): readonly SourceIdentityChangeFinding[] {
  if (prior === undefined) return Object.freeze([]);
  const observed = new Set<string>();
  for (const e of batch) if (e.sourceRef !== prior.sourceRef) observed.add(e.sourceRef);
  return Object.freeze(
    [...observed].sort().map((v) =>
      Object.freeze({
        kind: 'source_identity_change' as const,
        priorSourceRef: prior.sourceRef,
        observedSourceRef: v,
      }),
    ),
  );
}

// ===========================================================================
// 4. detect — run every detector, returning the full typed finding set.
// ===========================================================================

export interface CursorRecoveryReport {
  readonly findings: readonly CursorFinding[];
  /** True iff any finding was raised (the stream cannot be trusted as-is). */
  readonly hasFindings: boolean;
  readonly countByKind: Readonly<Record<CursorFindingKind, number>>;
}

/**
 * Run every detector against (prior, batch) and return the full typed finding set. Pure and total —
 * validates each batch event's fields, then composes the individual detectors. Nothing is auto-repaired.
 */
export function detect(
  prior: PriorCursor | undefined,
  batch: readonly BatchEvent[],
): CursorRecoveryReport {
  for (const e of batch) {
    assertNonEmpty(e.dedupKey, 'batchEvent.dedupKey');
    assertNonEmpty(e.aggregateRef, 'batchEvent.aggregateRef');
    assertNonEmpty(e.sourceRef, 'batchEvent.sourceRef');
    assertNonEmpty(e.mappingVersion, 'batchEvent.mappingVersion');
    assertSequence(e.sequence, 'batchEvent.sequence');
  }
  if (prior !== undefined) {
    assertNonEmpty(prior.sourceRef, 'priorCursor.sourceRef');
    assertNonEmpty(prior.mappingVersion, 'priorCursor.mappingVersion');
    for (const [k, v] of Object.entries(prior.highWater))
      assertSequence(v, `priorCursor.highWater[${k}]`);
  }

  const findings: CursorFinding[] = [
    ...detectCursorLoss(prior, batch),
    ...detectBacklogGaps(prior, batch),
    ...detectDuplicates(batch),
    ...detectStale(prior, batch),
    ...detectOutOfOrder(batch),
    ...detectMappingChanges(prior, batch),
    ...detectSourceIdentityChanges(prior, batch),
  ];

  const countByKind = {
    cursor_loss: 0,
    backlog_gap: 0,
    duplicate: 0,
    stale: 0,
    out_of_order: 0,
    mapping_change: 0,
    source_identity_change: 0,
  } as Record<CursorFindingKind, number>;
  for (const f of findings) countByKind[f.kind] += 1;

  return Object.freeze({
    findings: Object.freeze(findings),
    hasFindings: findings.length > 0,
    countByKind: Object.freeze(countByKind),
  });
}
