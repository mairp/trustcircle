// @trustcircle/command-worker — the DEAD-LETTER HANDLER (Phase 8 / User Story 6 / T236 /
// FR-030).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// A PURE constructor that PRESERVES a terminal message. When a delivery exhausts its retries or hits a
// terminal failure class, this module records a `DeadLetter` witness that retains — NEVER drops — the
// ORIGINAL payload and its digest, every attempt, the terminal error, the business impact, the
// accountable owner, the replay authority, and the evidence. Its two load-bearing invariants are
// NOTHING-SILENTLY-DROPPED (the original payload + `sha256` digest are always kept) and
// REPLAY-REQUIRES-AUTHORITY (a transition to `authorized`/`replayed` is REFUSED without an explicit
// `replayAuthorizedBy`, mirroring the DB CHECK `dead_letter_replay_requires_authority`).
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — PRESERVE-EVERYTHING, AUTHORITY-GATED-REPLAY, INJECTED CLOCK, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * NOTHING IS SILENTLY DROPPED (FR-030). `toDeadLetter` keeps the canonical original payload and its
//   `sha256` `originalDigest`; the digest is computed here and NEVER omitted.
// * REPLAY REQUIRES EXPLICIT AUTHORITY (FR-030 / DB CHECK dead_letter_replay_requires_authority).
//   `authorizeReplay` moves a held dead letter to `authorized` ONLY with a non-empty
//   `replayAuthorizedBy`; without it, it throws a fail-visible TypeError. `held` and `discarded` need
//   no authority; `authorized` and `replayed` always do.
// * ORIGIN-AWARE. `origin` ∈ inbox | outbox, aligned column-for-column with `dead_letter.origin`.
// * NO WALL-CLOCK. Timestamps are passed explicitly (epoch-ms) — no clock read.
// * LEAF-CLEAN. Depends on NO domain/application package: minimal structural input shape + injected
//   time. `node:crypto` is used only to digest the preserved payload and the record body.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Vocabulary (leaf-clean string constants; aligned with dead_letter).
// ===========================================================================

/** Where the terminal message originated — aligned with `dead_letter.origin`. */
export const DEAD_LETTER_ORIGINS = ['inbox', 'outbox'] as const;
export type DeadLetterOrigin = (typeof DEAD_LETTER_ORIGINS)[number];

/** Replay lifecycle — aligned with `dead_letter.replay_state`. */
export const DEAD_LETTER_REPLAY_STATES = ['held', 'authorized', 'replayed', 'discarded'] as const;
export type DeadLetterReplayState = (typeof DEAD_LETTER_REPLAY_STATES)[number];

/** Replay states that REQUIRE an explicit replay authority (mirror the DB CHECK). */
const REPLAY_STATES_REQUIRING_AUTHORITY: ReadonlySet<DeadLetterReplayState> =
  new Set<DeadLetterReplayState>(['authorized', 'replayed']);

/** True iff the replay state may only be entered with an explicit `replayAuthorizedBy`. */
export function replayStateRequiresAuthority(state: DeadLetterReplayState): boolean {
  return REPLAY_STATES_REQUIRING_AUTHORITY.has(state);
}

// ===========================================================================
// 1. Minimal structural input shapes.
// ===========================================================================

/** One recorded delivery attempt, preserved verbatim on the dead letter. */
export interface DeadLetterAttempt {
  /** 1-based attempt number. */
  readonly attempt: number;
  /** The classified failure for this attempt. */
  readonly failureClass: string;
  /** A human-legible error detail for this attempt. */
  readonly error: string;
  /** The instant this attempt was made (epoch-ms). */
  readonly at: number;
}

export interface DeadLetterInput {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly owner: string;
  /** Where the terminal message came from. */
  readonly origin: DeadLetterOrigin;
  /** The deduplication key of the terminal message. */
  readonly dedupKey: string;
  /** The terminal failure class that stopped the message. */
  readonly failureClass: string;
  /** The ORIGINAL message payload — preserved verbatim, never dropped (opaque). */
  readonly originalPayload: unknown;
  /** Every attempt made before the message became terminal. */
  readonly attempts: readonly DeadLetterAttempt[];
  /** The terminal error that ended the message. */
  readonly terminalError: string;
  /** The business impact classification if this message stays undelivered. */
  readonly businessImpact: string;
  /** Evidence references collected alongside the terminal record. */
  readonly evidenceRefs?: readonly string[];
  /** The instant the dead letter was recorded (epoch-ms). Passed explicitly — no clock read. */
  readonly createdAt: number;
}

// ===========================================================================
// 2. Dead-letter witness (aligned column-for-column with dead_letter).
// ===========================================================================

export interface DeadLetter {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly origin: DeadLetterOrigin;
  readonly dedupKey: string;
  readonly failureClass: string;
  /** The original payload, preserved verbatim (opaque). */
  readonly originalPayload: unknown;
  /** The sha-256 digest of the canonical original payload — NEVER dropped. */
  readonly originalDigest: string;
  readonly attempts: readonly DeadLetterAttempt[];
  readonly terminalError: string;
  readonly businessImpact: string;
  /** The replay lifecycle state — a fresh dead letter is always 'held'. */
  readonly replayState: DeadLetterReplayState;
  /** The principal who authorized replay, or null when unauthorized (held/discarded). */
  readonly replayAuthorizedBy: string | null;
  /** The instant replay authority was granted (epoch-ms), or null. */
  readonly replayAuthorizedAt: number | null;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: number;
  /** A stable digest of the record body (content digest; node:crypto). */
  readonly contentDigest: string;
}

// ===========================================================================
// 3. toDeadLetter — preserve a terminal message (nothing dropped).
// ===========================================================================

/**
 * Record a `DeadLetter` from `input`. The original payload is preserved verbatim and its `sha256`
 * `originalDigest` is computed here — neither is ever omitted. A fresh dead letter is always `held`
 * with no replay authority; use `authorizeReplay` to grant it.
 */
export function toDeadLetter(input: DeadLetterInput): DeadLetter {
  if (!Number.isFinite(input.createdAt)) {
    throw new RangeError('createdAt must be a finite epoch-ms instant');
  }
  if (input.originalPayload === undefined) {
    // A terminal message with no payload is never a valid dead letter — nothing to preserve.
    throw new TypeError('originalPayload must be present (a terminal payload is never dropped)');
  }

  const attempts: readonly DeadLetterAttempt[] = Object.freeze(
    input.attempts.map((a) => Object.freeze<DeadLetterAttempt>({ ...a })),
  );
  const evidenceRefs = Object.freeze([...(input.evidenceRefs ?? [])]);
  const originalDigest = digest(canonicalJson(input.originalPayload));

  const base = {
    connectorId: input.connectorId,
    tenantId: input.tenantId,
    owner: input.owner,
    origin: input.origin,
    dedupKey: input.dedupKey,
    failureClass: input.failureClass,
    originalPayload: input.originalPayload,
    originalDigest,
    attempts,
    terminalError: input.terminalError,
    businessImpact: input.businessImpact,
    // A fresh terminal message is HELD until an owner authorizes replay.
    replayState: 'held' as DeadLetterReplayState,
    replayAuthorizedBy: null,
    replayAuthorizedAt: null,
    evidenceRefs,
    createdAt: input.createdAt,
  };
  return Object.freeze({ ...base, contentDigest: digestRecord(base) });
}

// ===========================================================================
// 4. authorizeReplay — the authority-gated transition (refuses without authority).
// ===========================================================================

/**
 * Authorize replay of a HELD dead letter, moving it to `authorized`. REFUSES with a fail-visible
 * TypeError unless `authorizedBy` is a non-empty principal — mirroring the DB CHECK
 * `dead_letter_replay_requires_authority`: replay to `authorized`/`replayed` is IMPOSSIBLE without an
 * explicit authority. Only a `held` dead letter may be authorized.
 */
export function authorizeReplay(dl: DeadLetter, authorizedBy: string, at: number): DeadLetter {
  if (!Number.isFinite(at)) throw new RangeError('at must be a finite epoch-ms instant');
  if (typeof authorizedBy !== 'string' || authorizedBy.trim().length === 0) {
    throw new TypeError(
      'replay requires an explicit authority (replayAuthorizedBy must be non-empty)',
    );
  }
  if (dl.replayState !== 'held') {
    throw new TypeError(`only a 'held' dead letter may be authorized (was '${dl.replayState}')`);
  }

  const base = {
    connectorId: dl.connectorId,
    tenantId: dl.tenantId,
    owner: dl.owner,
    origin: dl.origin,
    dedupKey: dl.dedupKey,
    failureClass: dl.failureClass,
    originalPayload: dl.originalPayload,
    originalDigest: dl.originalDigest,
    attempts: dl.attempts,
    terminalError: dl.terminalError,
    businessImpact: dl.businessImpact,
    replayState: 'authorized' as DeadLetterReplayState,
    replayAuthorizedBy: authorizedBy,
    replayAuthorizedAt: at,
    evidenceRefs: dl.evidenceRefs,
    createdAt: dl.createdAt,
  };
  return Object.freeze({ ...base, contentDigest: digestRecord(base) });
}

// ===========================================================================
// 5. Utilities.
// ===========================================================================

/** Stable sha-256 digest of the record body (node:crypto; deterministic). */
function digestRecord(body: Omit<DeadLetter, 'contentDigest'>): string {
  return digest(canonicalJson(body));
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
