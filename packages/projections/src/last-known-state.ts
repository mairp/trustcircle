// @trustcircle/projections — LAST-KNOWN-STATE PROJECTOR: preserve the last-known source/mapping
// versions, age, confidence, retention, legal hold, and EXPLICIT staleness while a component is offline
// (Phase 8 / User Story 6 / T241 / FR-036, NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE, deterministic projector. When a component goes offline, we do NOT forget what we last saw —
// but we NEVER infer current health from that stale record. Given the LAST observation and an injected
// `at`, the projector computes:
//   * ageMs           — how old the last observation is at `at` (never negative; clamped to 0).
//   * staleness       — an EXPLICIT label current | aging | stale | unknown (unknown iff no observation
//                       or a future/negative age). Derived ONLY from age vs the aging/stale horizons.
//   * isStale         — an explicit boolean (true iff staleness is `stale` or `unknown`).
//   * retained facts  — the last-known source version, mapping version, and confidence are PRESERVED
//                       verbatim; retention window + legal-hold flags are carried forward untouched.
// It NEVER converts a stale positive reading into a current one: the projected value carries the
// staleness label so a consumer can never mistake a preserved observation for a live one.
//
// LEAF-CLEAN: depends on @trustcircle/domain types + Node built-in `node:crypto` ONLY (this package
// depends on domain + contracts, NOT application). `snapshotDigest(at)` is the durable-effect witness.

import { createHash } from 'node:crypto';

import { type Uuid, type EpochMillis } from '@trustcircle/domain';

// ===========================================================================
// 0. Guards + hashing (fail-visible; leaf-local).
// ===========================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reqUuid(v: unknown, label: string): Uuid {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new TypeError(`${label} must be a UUID`);
  return v as Uuid;
}
function reqEpoch(v: unknown, label: string): EpochMillis {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms`);
  }
  return v as EpochMillis;
}
function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ===========================================================================
// 1. Vocabulary — the explicit staleness label.
// ===========================================================================

export const STALENESS_LABELS = ['current', 'aging', 'stale', 'unknown'] as const;
export type StalenessLabel = (typeof STALENESS_LABELS)[number];

const DAY = 24 * 60 * 60 * 1000;

// ===========================================================================
// 2. Inputs — the last observation of an offline component.
// ===========================================================================

/**
 * The LAST observation retained while a component is offline. `observedAt` is when it was captured;
 * the source/mapping versions + confidence are what we last knew; retention + legal-hold flags govern
 * how long the record is kept. All fields are preserved verbatim — never a live reading.
 */
export interface LastObservation {
  readonly connectorId: Uuid;
  readonly observedAt: EpochMillis;
  readonly lastSourceVersion: string;
  readonly lastMappingVersion: string;
  /** The confidence [0,1] we had in the last observation (preserved, never re-derived). */
  readonly confidence: number;
  /** The retention window (ms) the record is kept for (undefined = indefinite). */
  readonly retentionMs?: number;
  /** True iff a legal hold pins the record beyond its retention window. */
  readonly legalHold?: boolean;
}

export interface LastKnownStateInput {
  /** The last observation, or undefined when the component was never observed. */
  readonly observation?: LastObservation;
  /** Age beyond this (ms) is `aging`; beyond `staleHorizonMs` is `stale` (defaults 1d / 7d). */
  readonly agingHorizonMs?: number;
  readonly staleHorizonMs?: number;
}

// ===========================================================================
// 3. The projected value.
// ===========================================================================

export interface LastKnownState {
  readonly connectorId: Uuid | null;
  readonly observedAt: EpochMillis | null;
  readonly lastSourceVersion: string | null;
  readonly lastMappingVersion: string | null;
  readonly confidence: number | null;
  /** Age of the last observation at `at`, or null when never observed. */
  readonly ageMs: number | null;
  /** The EXPLICIT staleness label — never a live reading. */
  readonly staleness: StalenessLabel;
  /** Explicit boolean: true iff `stale` or `unknown` (a stale record is not current health). */
  readonly isStale: boolean;
  /** The retention window (ms), preserved verbatim (null = indefinite / unknown). */
  readonly retentionMs: number | null;
  /** The legal-hold flag, preserved verbatim (record pinned beyond retention). */
  readonly legalHold: boolean;
  /** True iff the record is retained at `at` (within retention OR under legal hold). */
  readonly retained: boolean;
  readonly generatedAt: EpochMillis;
}

// ===========================================================================
// 4. The projector.
// ===========================================================================

/**
 * A pure last-known-state projector. Holds an optional last observation + the aging/stale horizons;
 * projects an explicitly-stale view at an injected `at`. NEVER infers current health from stale data.
 */
export class LastKnownStateProjector {
  readonly #observation: LastObservation | undefined;
  readonly #aging: number;
  readonly #stale: number;

  constructor(input: LastKnownStateInput) {
    if (input.observation !== undefined) {
      reqUuid(input.observation.connectorId, 'observation.connectorId');
      reqEpoch(input.observation.observedAt, 'observation.observedAt');
      const c = input.observation.confidence;
      if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
        throw new RangeError('observation.confidence must be a number in [0,1]');
      }
      if (input.observation.retentionMs !== undefined) {
        const r = input.observation.retentionMs;
        if (!Number.isInteger(r) || r < 0)
          throw new RangeError('observation.retentionMs must be a non-negative integer');
      }
    }
    const aging = input.agingHorizonMs ?? DAY;
    const stale = input.staleHorizonMs ?? 7 * DAY;
    if (!Number.isInteger(aging) || aging <= 0)
      throw new RangeError('agingHorizonMs must be positive');
    if (!Number.isInteger(stale) || stale <= aging)
      throw new RangeError('staleHorizonMs must exceed aging');
    this.#observation = input.observation;
    this.#aging = aging;
    this.#stale = stale;
  }

  #staleness(ageMs: number | null): StalenessLabel {
    if (ageMs === null || ageMs < 0) return 'unknown';
    if (ageMs <= this.#aging) return 'current';
    if (ageMs <= this.#stale) return 'aging';
    return 'stale';
  }

  /** Project the last-known state at an injected instant. Pure — no wall clock, no mutation. */
  project(at: EpochMillis): LastKnownState {
    reqEpoch(at, 'at');
    const obs = this.#observation;

    if (obs === undefined) {
      const value: LastKnownState = {
        connectorId: null,
        observedAt: null,
        lastSourceVersion: null,
        lastMappingVersion: null,
        confidence: null,
        ageMs: null,
        staleness: 'unknown',
        isStale: true,
        retentionMs: null,
        legalHold: false,
        retained: false,
        generatedAt: at,
      };
      return Object.freeze(value);
    }

    const rawAge = at - obs.observedAt;
    const ageMs = rawAge < 0 ? null : rawAge;
    const staleness = this.#staleness(ageMs);
    const isStale = staleness === 'stale' || staleness === 'unknown';
    const legalHold = obs.legalHold === true;
    const retentionMs = obs.retentionMs ?? null;
    // Retained iff under legal hold, OR retention is indefinite, OR still within the retention window.
    const retained = legalHold || retentionMs === null || (ageMs !== null && ageMs <= retentionMs);

    const value: LastKnownState = {
      connectorId: obs.connectorId,
      observedAt: obs.observedAt,
      lastSourceVersion: obs.lastSourceVersion,
      lastMappingVersion: obs.lastMappingVersion,
      confidence: obs.confidence,
      ageMs,
      staleness,
      isStale,
      retentionMs,
      legalHold,
      retained,
      generatedAt: at,
    };
    return Object.freeze(value);
  }

  /** The content digest of the projected state at `at` — the durable-effect witness. */
  snapshotDigest(at: EpochMillis): string {
    return `sha256:${sha256(canonical(this.project(at)))}`;
  }
}
