// @trustcircle/application — RETURN TO SERVICE: a guarded revalidation checklist that must pass BEFORE
// a component/connector resumes (Phase 8 / User Story 6 / T239 / FR-036, FR-041, NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE guarded checklist. Before a component that was offline (suspended / failed / maintenance /
// returning) may resume, its prerequisites MUST be re-proven — never resumed with an unproven
// prerequisite. The checklist revalidates, each an explicit boolean input the caller supplies from a
// fresh check:
//   * identity        — the component IDENTITY still matches (not a swapped/renamed source).
//   * contracts       — the protocol/schema contract still holds (no unhandled version drift).
//   * credentials     — a valid credential reference is present and not revoked.
//   * authority       — the component's authority (ownership / policy) is intact.
//   * versions        — the bound adapter/source versions are the approved, current ones.
//   * snapshots       — a fresh reconciling snapshot has been taken (state re-observed, not assumed).
//   * backlog         — the ingestion backlog is reconciled (no unresolved gap; see cursor-recovery).
//   * evidence        — the evidence chain is intact (retained, verifiable).
//
// `readyToResume` is TRUE only when EVERY check passes. Otherwise the exact FAILING checks are
// returned so the owner sees precisely what is unproven. Pure, dependency-free (`node:crypto` only for
// the witness digest): no wall-clock reads (an explicit `at`), no I/O, no Math.random.

import { createHash } from 'node:crypto';

// ===========================================================================
// 0. Guards + hashing (fail-visible).
// ===========================================================================

function assertEpoch(ms: unknown, label: string): asserts ms is number {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${String(ms)}`);
  }
}
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

// ===========================================================================
// 1. The checklist vocabulary + inputs.
// ===========================================================================

/** The eight revalidation checks, in a stable order. Every one must pass before resume. */
export const RETURN_TO_SERVICE_CHECKS = [
  'identity',
  'contracts',
  'credentials',
  'authority',
  'versions',
  'snapshots',
  'backlog',
  'evidence',
] as const;
export type ReturnToServiceCheck = (typeof RETURN_TO_SERVICE_CHECKS)[number];

/**
 * The revalidation inputs — each an explicit boolean the caller supplies from a fresh check performed
 * at `at`. There is no default-true: an omitted-as-false check is an UNPROVEN prerequisite, and the
 * component does NOT resume. Explicit `undefined` is not permitted (exactOptionalPropertyTypes-safe):
 * every field is required so the checklist is total.
 */
export interface ReturnToServiceInput {
  readonly identityVerified: boolean;
  readonly contractsVerified: boolean;
  readonly credentialsVerified: boolean;
  readonly authorityVerified: boolean;
  readonly versionsVerified: boolean;
  readonly snapshotsVerified: boolean;
  readonly backlogReconciled: boolean;
  readonly evidenceIntact: boolean;
  /** The instant the revalidation was evaluated (epoch-ms). */
  readonly at: number;
}

// ===========================================================================
// 2. The verdict.
// ===========================================================================

export interface ReturnToServiceVerdict {
  /** TRUE only when EVERY check passes — never resume with an unproven prerequisite. */
  readonly readyToResume: boolean;
  /** The exact checks that FAILED (empty iff ready). */
  readonly failingChecks: readonly ReturnToServiceCheck[];
  /** The per-check pass/fail map, in the canonical check order. */
  readonly checks: Readonly<Record<ReturnToServiceCheck, boolean>>;
  readonly evaluatedAt: number;
  /** The durable-effect witness — identical inputs ⇒ identical digest. */
  readonly digest: string;
}

// ===========================================================================
// 3. evaluateReturnToService — the guarded checklist.
// ===========================================================================

/**
 * Evaluate the return-to-service checklist. `readyToResume` is TRUE iff all eight checks pass;
 * otherwise the exact failing checks are returned. Pure — no state, no wall clock beyond the explicit
 * `at`. NEVER resumes with an unproven prerequisite.
 */
export function evaluateReturnToService(input: ReturnToServiceInput): ReturnToServiceVerdict {
  assertEpoch(input.at, 'returnToService.at');

  const checks: Record<ReturnToServiceCheck, boolean> = {
    identity: input.identityVerified === true,
    contracts: input.contractsVerified === true,
    credentials: input.credentialsVerified === true,
    authority: input.authorityVerified === true,
    versions: input.versionsVerified === true,
    snapshots: input.snapshotsVerified === true,
    backlog: input.backlogReconciled === true,
    evidence: input.evidenceIntact === true,
  };

  const failingChecks = RETURN_TO_SERVICE_CHECKS.filter((c) => checks[c] === false);
  const readyToResume = failingChecks.length === 0;

  const evaluatedAt = input.at;
  const digest = sha256(
    canonicalJson({ checks, readyToResume, failing: [...failingChecks].sort(), evaluatedAt }),
  );

  return Object.freeze({
    readyToResume,
    failingChecks: Object.freeze([...failingChecks]),
    checks: Object.freeze(checks),
    evaluatedAt,
    digest,
  });
}
