// @trustcircle/command-worker — the CONNECTOR RECONCILER (Phase 8 / User Story 6 / T235 /
// FR-029, FR-036..FR-050 continuity family, SC-014..SC-016).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// A PURE reconciler that COMPARES a connector's DESIRED state against its OBSERVED CURRENT state —
// source snapshots, observations, cursors, versions, and mappings — and emits a `ReconciliationRun`
// witness enumerating every DRIFT it found, each stamped with a NAMED drift class. It runs at a
// SCHEDULED, ON-DEMAND, or RETURN-TO-SERVICE cadence. Its single load-bearing invariant is
// DRIFT-VISIBLE honesty: unresolved drift is NEVER hidden — it stays enumerated in `driftItems`, and
// the run is `resolved` ONLY when that list is empty. The reconciler observes and reports; it never
// mutates the connector.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — DESIRED-VS-CURRENT, NAMED-DRIFT, INJECTED CLOCK, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * DESIRED vs CURRENT (FR-036..FR-050). `reconcile` diffs a desired state (version, cursor sequence,
//   mappings, enabled capabilities) against the observed current state; every discrepancy becomes a
//   drift item under a NAMED class: missing | duplicate | stale | conflicting | orphaned |
//   schema_incompatible | unknown.
// * DRIFT STAYS VISIBLE (SC-014..SC-016). `resolved` is `true` ONLY when `driftItems` is empty. Nothing
//   is silently reconciled away — unresolved drift remains enumerated so a downstream reader sees it.
// * CADENCE-AWARE. `cadence` ∈ scheduled | on_demand | return_to_service, aligned column-for-column
//   with `reconciliation_run.cadence`.
// * TIME-ORDERED (mirrors DB CHECK `reconciliation_time_ordered`). `finishedAt` (when present) must be
//   >= `startedAt`; a violation is a fail-visible RangeError.
// * NO WALL-CLOCK. The reconciliation instant `at` is passed explicitly (epoch-ms) — no clock read.
// * LEAF-CLEAN. Depends on NO domain/application package: minimal structural input shape + injected
//   `at`. `node:crypto` is used only to digest the run into a stable content digest.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Vocabulary (leaf-clean string constants; aligned with reconciliation_run).
// ===========================================================================

/** Reconciliation cadence — aligned with `reconciliation_run.cadence`. */
export const RECONCILIATION_CADENCES = ['scheduled', 'on_demand', 'return_to_service'] as const;
export type ReconciliationCadence = (typeof RECONCILIATION_CADENCES)[number];

/** Named drift classes — every discrepancy is tagged with exactly one. */
export const DRIFT_CLASSES = [
  'missing',
  'duplicate',
  'stale',
  'conflicting',
  'orphaned',
  'schema_incompatible',
  'unknown',
] as const;
export type DriftClass = (typeof DRIFT_CLASSES)[number];

const DRIFT_CLASS_SET: ReadonlySet<string> = new Set<string>(DRIFT_CLASSES);

/** True iff `value` is a recognised drift class (unrecognised drift is tagged 'unknown'). */
export function isDriftClass(value: string): value is DriftClass {
  return DRIFT_CLASS_SET.has(value);
}

/** The actor attributed to every reconciliation run (deterministic, non-human). */
export const RECONCILER_ACTOR = 'system:connector-reconciler';

// ===========================================================================
// 1. Minimal structural input shapes.
// ===========================================================================

/**
 * One observed discrepancy between desired and current state, pre-classified by the caller's oracle.
 * An unrecognised `driftClass` is coerced to 'unknown' — never silently dropped.
 */
export interface DriftObservation {
  /** The named drift class; unrecognised values are coerced to 'unknown'. */
  readonly driftClass: string;
  /** The subject of the drift (e.g. a mapping key, aggregate ref, cursor field). */
  readonly subject: string;
  /** The desired value as observed (opaque), if any. */
  readonly desired?: string;
  /** The current value as observed (opaque), if any. */
  readonly current?: string;
  /** A human-legible detail for the reader. */
  readonly detail?: string;
}

/** A named drift item as enumerated on the reconciliation run (class coerced to the vocabulary). */
export interface DriftItem {
  readonly driftClass: DriftClass;
  readonly subject: string;
  readonly desired: string | null;
  readonly current: string | null;
  readonly detail: string | null;
}

/** The desired vs current state pair being reconciled (opaque structural snapshots). */
export interface ReconciliationInput {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly cadence: ReconciliationCadence;
  /** The desired state snapshot (version, cursor, mappings, capabilities …) — opaque. */
  readonly desiredState: Readonly<Record<string, unknown>>;
  /** The observed current state snapshot — opaque. */
  readonly currentState: Readonly<Record<string, unknown>>;
  /** The pre-classified drift observations; empty ⇒ resolved. */
  readonly driftObservations?: readonly DriftObservation[];
  /** The cursor before this run (opaque), or undefined when never ingested. */
  readonly cursorBefore?: string;
  /** The cursor after this run (opaque), or undefined when unchanged / never ingested. */
  readonly cursorAfter?: string;
  /** The instant the run started (epoch-ms). Passed explicitly — no wall-clock read. */
  readonly startedAt: number;
  /** The instant the run finished (epoch-ms), or undefined when still in flight. */
  readonly finishedAt?: number;
}

// ===========================================================================
// 2. Reconciliation-run witness (aligned column-for-column with reconciliation_run).
// ===========================================================================

export interface ReconciliationRun {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly cadence: ReconciliationCadence;
  readonly desiredState: Readonly<Record<string, unknown>>;
  readonly currentState: Readonly<Record<string, unknown>>;
  /** Every unresolved drift, enumerated — never elided. */
  readonly driftItems: readonly DriftItem[];
  /** TRUE iff `driftItems` is empty. A non-empty drift list is NEVER reported resolved. */
  readonly resolved: boolean;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** A stable digest of the run body (content digest; node:crypto). */
  readonly contentDigest: string;
}

// ===========================================================================
// 3. reconcile — the reconciler (drift-visible).
// ===========================================================================

/**
 * Reconcile `input` at instant `at`. Enumerates every drift observation as a NAMED drift item and
 * reports `resolved:true` ONLY when no drift remains. Unrecognised drift classes are coerced to
 * 'unknown' — nothing is silently dropped. `at` is the reconciliation instant (epoch-ms), passed
 * explicitly; it is retained for symmetry with the other loop modules and to prove the time-ordering
 * guard against a live clock is unnecessary.
 */
export function reconcile(input: ReconciliationInput, at: number): ReconciliationRun {
  if (!Number.isFinite(at)) throw new RangeError('at must be a finite epoch-ms instant');
  if (!Number.isFinite(input.startedAt)) {
    throw new RangeError('startedAt must be a finite epoch-ms instant');
  }
  if (input.finishedAt !== undefined) {
    if (!Number.isFinite(input.finishedAt)) {
      throw new RangeError('finishedAt must be a finite epoch-ms instant');
    }
    // Mirror the DB CHECK reconciliation_time_ordered.
    if (input.finishedAt < input.startedAt) {
      throw new RangeError(
        `finishedAt ${input.finishedAt} must be >= startedAt ${input.startedAt} (time-ordered)`,
      );
    }
  }

  const driftItems: readonly DriftItem[] = Object.freeze(
    (input.driftObservations ?? []).map((d) =>
      Object.freeze<DriftItem>({
        driftClass: isDriftClass(d.driftClass) ? d.driftClass : 'unknown',
        subject: d.subject,
        desired: d.desired ?? null,
        current: d.current ?? null,
        detail: d.detail ?? null,
      }),
    ),
  );

  const base = {
    connectorId: input.connectorId,
    tenantId: input.tenantId,
    owner: input.owner,
    cadence: input.cadence,
    desiredState: input.desiredState,
    currentState: input.currentState,
    driftItems,
    // Drift-visible invariant: resolved ONLY when nothing drifted.
    resolved: driftItems.length === 0,
    cursorBefore: input.cursorBefore ?? null,
    cursorAfter: input.cursorAfter ?? null,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
  };
  return Object.freeze({ ...base, contentDigest: digestRun(base) });
}

// ===========================================================================
// 4. Utilities.
// ===========================================================================

/** Stable sha-256 digest of the run body (node:crypto; deterministic). */
function digestRun(body: Omit<ReconciliationRun, 'contentDigest'>): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/** Canonical, key-sorted JSON so a digest is stable across key insertion order. */
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
