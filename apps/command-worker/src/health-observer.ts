// @trustcircle/command-worker — the HEALTH OBSERVER (Phase 8 / User Story 6 / T232 /
// FR-057, FR-058, FR-059, FR-060, SC-024).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// A PURE evaluator that COLLECTS a connector's health signals — owner, version, readiness, liveness,
// freshness, lag, retry counts, failure counts, business impact, and evidence references — into ONE
// `HealthObservation` witness. Its single load-bearing invariant is OBSERVATION-FIRST honesty: it NEVER
// infers a POSITIVE reading (ready / live / fresh) from the ABSENCE of telemetry. When the health
// telemetry is missing, never-reported, or older than the freshness horizon, readiness and liveness
// collapse to 'unknown' and freshness to 'stale', and `inferredFromAbsence` is flagged true — so a
// downstream reader can NEVER mistake silence for health.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — OBSERVATION-FIRST, ABSENCE-HONEST, INJECTED CLOCK, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * ABSENCE IS NEVER HEALTH (SC-024). `observeHealth` takes an optional telemetry snapshot. When it is
//   undefined (never reported) OR its `reportedAt` is older than `freshnessHorizonMs` before `now`, the
//   observation reports readiness 'unknown' / liveness 'stale' / freshness 'stale' and sets
//   `inferredFromAbsence:true`. A positive reading is produced ONLY from present, non-expired telemetry.
// * PRESENT-TELEMETRY PATH. When telemetry is present AND fresh, the reported readiness/liveness are
//   passed through faithfully and freshness is 'fresh'; `inferredFromAbsence` is false.
// * NO WALL-CLOCK. `now` is passed explicitly (epoch-ms). `isObservationStale` compares an observation's
//   `reportedAt` against a horizon so a test can prove the stale boundary directly.
// * LEAF-CLEAN. Depends on NO domain/application package: minimal structural input shape + injected
//   `now`. `node:crypto` is used only to digest the collected observation into a stable evidence ref.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Vocabulary (leaf-clean string constants).
// ===========================================================================

/** Readiness disposition — 'unknown' is the ONLY value producible from absence. */
export const HEALTH_READINESS = ['ready', 'not_ready', 'unknown'] as const;
export type HealthReadiness = (typeof HEALTH_READINESS)[number];

/** Liveness disposition — 'stale' is the absence-safe value (never 'live' from silence). */
export const HEALTH_LIVENESS = ['live', 'not_live', 'stale'] as const;
export type HealthLiveness = (typeof HEALTH_LIVENESS)[number];

/** Freshness disposition — 'stale' whenever telemetry is absent or past the horizon. */
export const HEALTH_FRESHNESS = ['fresh', 'stale'] as const;
export type HealthFreshness = (typeof HEALTH_FRESHNESS)[number];

/** The actor attributed to every collected observation (deterministic, non-human). */
export const HEALTH_OBSERVER_ACTOR = 'system:health-observer';

// ===========================================================================
// 1. Minimal structural input shapes.
// ===========================================================================

/**
 * A telemetry snapshot AS REPORTED by the connector's health endpoint. Its presence is the ONLY basis
 * for a positive readiness/liveness reading. Absent (`undefined`) telemetry ⇒ absence path.
 */
export interface HealthTelemetry {
  /** Epoch-ms instant the telemetry was reported by the connector. */
  readonly reportedAt: number;
  /** The connector's own readiness assertion (only trusted when present + fresh). */
  readonly ready: boolean;
  /** The connector's own liveness assertion (only trusted when present + fresh). */
  readonly live: boolean;
  /** Epoch-ms of the most recent successfully processed datum, if any. */
  readonly lastProgressAt?: number;
  /** Observed processing lag in ms, if reported. */
  readonly lagMs?: number;
  /** Retry count observed in the reporting window. */
  readonly retryCount?: number;
  /** Failure count observed in the reporting window. */
  readonly failureCount?: number;
}

/** The identity + governance context of the connector being observed. */
export interface HealthObserverInput {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly connectorVersion: string;
  /** The telemetry snapshot, or undefined when the connector never reported. */
  readonly telemetry?: HealthTelemetry;
  /** How stale (ms) telemetry may be before it is treated as absent for positive readings. */
  readonly freshnessHorizonMs: number;
  /** The business impact classification if this connector degrades (collected, not inferred). */
  readonly businessImpact: string;
  /** Evidence references collected alongside the observation. */
  readonly evidenceRefs?: readonly string[];
  /** The observation instant (epoch-ms). Passed explicitly — no wall-clock read. */
  readonly now: number;
}

// ===========================================================================
// 2. Observation witness.
// ===========================================================================

export interface HealthObservation {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly connectorVersion: string;
  readonly observedAt: number;
  /** Epoch-ms the underlying telemetry was reported, or null when absent. */
  readonly reportedAt: number | null;
  readonly readiness: HealthReadiness;
  readonly liveness: HealthLiveness;
  readonly freshness: HealthFreshness;
  /** Age in ms of the telemetry at `observedAt`, or null when absent. */
  readonly ageMs: number | null;
  readonly lagMs: number | null;
  readonly retryCount: number | null;
  readonly failureCount: number | null;
  readonly businessImpact: string;
  /**
   * TRUE iff readiness/liveness/freshness were derived from ABSENT or EXPIRED telemetry. A true value
   * GUARANTEES readiness==='unknown', liveness==='stale', freshness==='stale' — never a positive reading.
   */
  readonly inferredFromAbsence: boolean;
  readonly evidenceRefs: readonly string[];
  /** A stable digest of the collected observation (evidence ref; node:crypto). */
  readonly observationDigest: string;
}

// ===========================================================================
// 3. Freshness horizon check (proves the stale boundary directly).
// ===========================================================================

/**
 * True iff telemetry reported at `reportedAt` is OLDER than `freshnessHorizonMs` at `now` (inclusive of
 * the boundary → an age exactly equal to the horizon is fresh; strictly greater is stale). Absence
 * (`reportedAt` null/undefined) is ALWAYS stale.
 */
export function isObservationStale(
  reportedAt: number | null | undefined,
  now: number,
  freshnessHorizonMs: number,
): boolean {
  if (reportedAt === null || reportedAt === undefined) return true;
  if (!Number.isFinite(reportedAt) || !Number.isFinite(now)) return true;
  return now - reportedAt > freshnessHorizonMs;
}

// ===========================================================================
// 4. observeHealth — the collector (absence-honest).
// ===========================================================================

/**
 * Collect one `HealthObservation` from `input`. CRITICAL: a positive readiness/liveness/freshness is
 * produced ONLY from present, non-expired telemetry. Absent or expired telemetry ⇒ readiness 'unknown',
 * liveness 'stale', freshness 'stale', `inferredFromAbsence:true`.
 */
export function observeHealth(input: HealthObserverInput): HealthObservation {
  if (!Number.isFinite(input.now)) throw new RangeError('now must be a finite epoch-ms instant');
  if (!Number.isFinite(input.freshnessHorizonMs) || input.freshnessHorizonMs < 0) {
    throw new RangeError('freshnessHorizonMs must be a non-negative finite number');
  }

  const telemetry = input.telemetry;
  const evidenceRefs = Object.freeze([...(input.evidenceRefs ?? [])]);

  // ── Absence path: telemetry missing OR past the freshness horizon. ──────────
  if (
    telemetry === undefined ||
    isObservationStale(telemetry.reportedAt, input.now, input.freshnessHorizonMs)
  ) {
    const reportedAt = telemetry?.reportedAt ?? null;
    const base = {
      connectorId: input.connectorId,
      tenantId: input.tenantId,
      owner: input.owner,
      connectorVersion: input.connectorVersion,
      observedAt: input.now,
      reportedAt,
      // A POSITIVE reading may NEVER be produced from absence.
      readiness: 'unknown' as const,
      liveness: 'stale' as const,
      freshness: 'stale' as const,
      ageMs: reportedAt === null ? null : input.now - reportedAt,
      lagMs: telemetry?.lagMs ?? null,
      retryCount: telemetry?.retryCount ?? null,
      failureCount: telemetry?.failureCount ?? null,
      businessImpact: input.businessImpact,
      inferredFromAbsence: true,
      evidenceRefs,
    };
    return Object.freeze({ ...base, observationDigest: digestObservation(base) });
  }

  // ── Present-telemetry path: fresh + trusted pass-through. ───────────────────
  const base = {
    connectorId: input.connectorId,
    tenantId: input.tenantId,
    owner: input.owner,
    connectorVersion: input.connectorVersion,
    observedAt: input.now,
    reportedAt: telemetry.reportedAt,
    readiness: (telemetry.ready ? 'ready' : 'not_ready') as HealthReadiness,
    liveness: (telemetry.live ? 'live' : 'not_live') as HealthLiveness,
    freshness: 'fresh' as const,
    ageMs: input.now - telemetry.reportedAt,
    lagMs: telemetry.lagMs ?? null,
    retryCount: telemetry.retryCount ?? null,
    failureCount: telemetry.failureCount ?? null,
    businessImpact: input.businessImpact,
    inferredFromAbsence: false,
    evidenceRefs,
  };
  return Object.freeze({ ...base, observationDigest: digestObservation(base) });
}

// ===========================================================================
// 5. Utilities.
// ===========================================================================

/** Stable sha-256 digest of the collected observation body (node:crypto; deterministic). */
function digestObservation(body: Omit<HealthObservation, 'observationDigest'>): string {
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
