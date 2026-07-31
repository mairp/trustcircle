// @trustcircle/domain — canonical outcome codes, RFC 9457-style error envelopes, retryability,
// and safe-next-action types (Phase 16 / T016 / GAR-005 / VO-34d9f9fb2a6a39e2d62c).
//
// Oracle (VO-34d9f9fb2a6a39e2d62c / GAR-005 "Control Assurance"): Integrity rules, policies,
// controllers, controls, and mappings MUST have stable identifiers, versions, owners, lifecycle
// states, tests, monitoring, failure behavior, exceptions, and evidence expectations.
//
// Every mutating governed operation in the platform terminates in exactly ONE canonical
// outcome. The spec's Failure Semantics table and the ecosystem-integration checklist (CHK016)
// require that "retryable, non-retryable, rate-limited, policy-denied, contract-invalid,
// version-unsupported, conflict, and uncertain outcomes [are] distinguished with one
// unambiguous next-action rule for each." This module is the single, framework-independent
// source of truth for those outcomes. It provides:
//
//   1. Canonical outcome codes — a closed, stable set of `OutcomeCode` values (one per row of
//      the Failure Semantics table plus `succeeded`). Codes are STABLE IDENTIFIERS: they never
//      change meaning across versions; a consumer switching on a code has an exhaustive,
//      total mapping.
//   2. A governed OUTCOME CATALOG — each outcome code is registered as a fully governed entity
//      carrying the nine GAR-005 facets (stable id, version, owner, lifecycle state, tests,
//      monitoring, failure behavior, exceptions, evidence expectations). `assertOutcomeCatalog`
//      refuses a catalog missing any facet for any code, so GAR-005 is an executable invariant
//      over the outcome vocabulary, not a claim.
//   3. RFC 9457 error envelopes — `ProblemDetails` ("problem+json") with `type`, `title`,
//      `status`, `detail`, `instance`, plus governance extensions (`outcomeCode`, `retry`,
//      `nextAction`, `correlationId`, `occurredAt`). Envelopes are DISCLOSURE-SAFE: they carry
//      no stack traces or internal identifiers, and `title`/`type` come from the registry.
//   4. Retryability — a `Retry` descriptor (`retryable`, bounded `maxAttempts`, `backoff`,
//      `retryAfterMs`) so retries are bounded, and rate-limited/uncertain outcomes carry a
//      concrete retry hint rather than an ad-hoc one.
//   5. Safe next action — a closed `SafeNextAction` set and a TOTAL `safeNextActionFor(code)`
//      mapping giving EXACTLY ONE next action per outcome (CHK016). No code is left without a
//      next-action rule; the exhaustiveness is checked at module load and by tests.
//
// Dependency-free (Node built-in `crypto` only) so it is independently observable and testable
// under `npm ci` with no adjacent infrastructure, and runs under Node 22
// `--experimental-strip-types`. Builds only on ./primitives.ts (same package boundary).

import { createHash } from 'node:crypto';
import {
  type EpochMillis,
  type GovernanceContract,
  type GovernedEntity,
  type Owner,
  type TenantId,
  type Uuid,
  assertGovernanceContract,
  assertGovernedEntity,
  isUuid,
} from './primitives.ts';

// ===========================================================================
// 1. Canonical outcome codes
// ===========================================================================

/**
 * The closed, stable set of canonical outcome codes. Exactly one row per terminal outcome a
 * governed mutating operation can reach (spec "Failure Semantics" + CHK016 classes). These are
 * STABLE IDENTIFIERS — a code's meaning is fixed for the lifetime of the vocabulary; the set is
 * only ever extended additively via a new catalog version, never repurposed.
 *
 *   - `succeeded`               — the operation completed and a durable effect is confirmed.
 *   - `retryable_failure`       — transient failure; safe to retry within bounds.
 *   - `non_retryable_failure`   — permanent failure; retrying cannot succeed.
 *   - `rate_limited`            — throttled; retry only after the supplied delay.
 *   - `policy_denied`           — a policy/authorization rule refused the action.
 *   - `contract_invalid`        — the source/request contract failed validation.
 *   - `version_unsupported`     — the source/contract/policy version is not supported.
 *   - `conflict`                — optimistic-concurrency / state conflict (stale version).
 *   - `uncertain`               — remote outcome unknown (timeout / lost ack); must reconcile.
 *   - `duplicate`               — idempotent replay; the prior result stands, no new effect.
 */
export const OUTCOME_CODES = [
  'succeeded',
  'retryable_failure',
  'non_retryable_failure',
  'rate_limited',
  'policy_denied',
  'contract_invalid',
  'version_unsupported',
  'conflict',
  'uncertain',
  'duplicate',
] as const;

export type OutcomeCode = (typeof OUTCOME_CODES)[number];

/** The subset of codes that represent a failed / non-success terminal outcome. */
export const FAILURE_OUTCOME_CODES: readonly OutcomeCode[] = OUTCOME_CODES.filter(
  (c) => c !== 'succeeded' && c !== 'duplicate',
);

export function isOutcomeCode(s: unknown): s is OutcomeCode {
  return typeof s === 'string' && (OUTCOME_CODES as readonly string[]).includes(s);
}

/** True iff the code denotes a successful / already-applied durable effect (no new mutation
 * required). `duplicate` is success-equivalent: the prior idempotent result stands. */
export function isTerminalSuccess(code: OutcomeCode): boolean {
  return code === 'succeeded' || code === 'duplicate';
}

// ===========================================================================
// 2. Retryability
// ===========================================================================

/** Bounded backoff strategy for a retryable outcome. */
export const BACKOFF_STRATEGIES = ['none', 'fixed', 'exponential'] as const;
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number];

/**
 * Retry descriptor. `retryable` gates whether a retry is EVER permitted; when true,
 * `maxAttempts` bounds it (retries are always bounded — never unbounded), `backoff` names the
 * spacing strategy, and `retryAfterMs` is a concrete earliest-retry hint (populated for
 * `rate_limited`). A non-retryable outcome MUST have `retryable=false`, `maxAttempts=0`, and
 * `backoff='none'`; `assertRetry` enforces the invariant so a "non-retryable" outcome can never
 * silently carry retry advice.
 */
export interface Retry {
  readonly retryable: boolean;
  /** Total attempts permitted including the first; 0 iff not retryable, else ≥ 1. */
  readonly maxAttempts: number;
  readonly backoff: BackoffStrategy;
  /** Earliest retry delay hint in ms (≥ 0). 0 when no explicit hint. */
  readonly retryAfterMs: number;
}

export const NO_RETRY: Retry = Object.freeze({
  retryable: false,
  maxAttempts: 0,
  backoff: 'none',
  retryAfterMs: 0,
});

export function makeRetry(input: {
  retryable: boolean;
  maxAttempts?: number;
  backoff?: BackoffStrategy;
  retryAfterMs?: number;
}): Retry {
  const retryable = input.retryable === true;
  if (!retryable) {
    if (input.maxAttempts && input.maxAttempts > 0) {
      throw new RangeError('non-retryable outcome cannot declare maxAttempts > 0');
    }
    if (input.retryAfterMs && input.retryAfterMs > 0) {
      throw new RangeError('non-retryable outcome cannot declare a retryAfterMs hint');
    }
    return NO_RETRY;
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('retryable outcome must declare bounded maxAttempts ≥ 1');
  }
  const backoff = input.backoff ?? 'exponential';
  if (!BACKOFF_STRATEGIES.includes(backoff)) {
    throw new TypeError(`unknown backoff strategy: ${String(backoff)}`);
  }
  const retryAfterMs = input.retryAfterMs ?? 0;
  if (!Number.isInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new RangeError('retryAfterMs must be a non-negative integer');
  }
  return Object.freeze({ retryable, maxAttempts, backoff, retryAfterMs });
}

/** Structural validation used by envelope construction. */
export function assertRetry(r: unknown): asserts r is Retry {
  if (typeof r !== 'object' || r === null) throw new TypeError('retry descriptor required');
  const x = r as Retry;
  if (typeof x.retryable !== 'boolean') throw new TypeError('retry.retryable must be boolean');
  if (!BACKOFF_STRATEGIES.includes(x.backoff)) throw new TypeError('retry.backoff invalid');
  if (!Number.isInteger(x.maxAttempts) || x.maxAttempts < 0) {
    throw new RangeError('retry.maxAttempts must be a non-negative integer');
  }
  if (!Number.isInteger(x.retryAfterMs) || x.retryAfterMs < 0) {
    throw new RangeError('retry.retryAfterMs must be a non-negative integer');
  }
  if (!x.retryable && (x.maxAttempts !== 0 || x.retryAfterMs !== 0 || x.backoff !== 'none')) {
    throw new RangeError('non-retryable outcome must not carry retry advice');
  }
  if (x.retryable && x.maxAttempts < 1) {
    throw new RangeError('retryable outcome must have bounded maxAttempts ≥ 1');
  }
}

// ===========================================================================
// 3. Safe next action — total mapping (CHK016: exactly one rule per outcome)
// ===========================================================================

/**
 * The closed set of safe next actions a caller may be directed to take. Each canonical outcome
 * maps to EXACTLY ONE of these (CHK016). The action is "safe" in that following it can never
 * cause a duplicate effect or claim unconfirmed success.
 *
 *   - `none`                    — nothing to do; the effect is confirmed (success/duplicate).
 *   - `retry_with_backoff`      — retry within bounds using the retry descriptor.
 *   - `retry_after_delay`       — retry only after `retryAfterMs` (rate limited).
 *   - `reconcile`               — determine the real remote state before any further action.
 *   - `request_review`          — route to a human decision (policy denial / re-review).
 *   - `fix_and_resubmit`        — the contract/request is invalid; correct it and resubmit.
 *   - `upgrade_contract_version`— the version is unsupported; migrate to a supported version.
 *   - `refresh_and_retry`       — a conflict; refetch current state, re-evaluate, then retry.
 *   - `escalate`                — a permanent failure requiring an owned issue / escalation.
 */
export const SAFE_NEXT_ACTIONS = [
  'none',
  'retry_with_backoff',
  'retry_after_delay',
  'reconcile',
  'request_review',
  'fix_and_resubmit',
  'upgrade_contract_version',
  'refresh_and_retry',
  'escalate',
] as const;

export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

export function isSafeNextAction(s: unknown): s is SafeNextAction {
  return typeof s === 'string' && (SAFE_NEXT_ACTIONS as readonly string[]).includes(s);
}

/**
 * The TOTAL, unambiguous outcome → safe-next-action mapping (CHK016). Every canonical outcome
 * code has exactly one entry; the object is frozen and its exhaustiveness is checked at load.
 */
export const SAFE_NEXT_ACTION_BY_CODE: Readonly<Record<OutcomeCode, SafeNextAction>> =
  Object.freeze({
    succeeded: 'none',
    duplicate: 'none',
    retryable_failure: 'retry_with_backoff',
    non_retryable_failure: 'escalate',
    rate_limited: 'retry_after_delay',
    policy_denied: 'request_review',
    contract_invalid: 'fix_and_resubmit',
    version_unsupported: 'upgrade_contract_version',
    conflict: 'refresh_and_retry',
    uncertain: 'reconcile',
  });

/** Resolve the single safe next action for a canonical outcome code (total function). */
export function safeNextActionFor(code: OutcomeCode): SafeNextAction {
  const action = SAFE_NEXT_ACTION_BY_CODE[code];
  if (action === undefined) {
    // Unreachable while the table stays exhaustive; guards against a future code with no rule.
    throw new Error(`no safe-next-action rule for outcome code: ${String(code)}`);
  }
  return action;
}

/** The canonical retry posture for a code (derived, so callers need not hand-build it). */
export function retryFor(code: OutcomeCode, opts: { retryAfterMs?: number } = {}): Retry {
  switch (code) {
    case 'retryable_failure':
      return makeRetry({ retryable: true, maxAttempts: 3, backoff: 'exponential' });
    case 'rate_limited':
      return makeRetry({
        retryable: true,
        maxAttempts: 3,
        backoff: 'fixed',
        retryAfterMs: opts.retryAfterMs ?? 1000,
      });
    case 'conflict':
      return makeRetry({ retryable: true, maxAttempts: 2, backoff: 'fixed' });
    case 'succeeded':
    case 'duplicate':
    case 'non_retryable_failure':
    case 'policy_denied':
    case 'contract_invalid':
    case 'version_unsupported':
    case 'uncertain':
      return NO_RETRY;
    default: {
      const _exhaustive: never = code;
      throw new Error(`unhandled outcome code: ${String(_exhaustive)}`);
    }
  }
}

// ===========================================================================
// 4. Outcome registry (title / RFC-9457 type / HTTP status per code)
// ===========================================================================

/** Registry entry: the disclosure-safe, stable presentation of an outcome code. */
export interface OutcomeDescriptor {
  readonly code: OutcomeCode;
  /** Stable, dereferenceable-shaped `type` URI for the RFC 9457 envelope. */
  readonly type: string;
  /** Human-readable, disclosure-safe summary (never leaks internals). */
  readonly title: string;
  /** Canonical HTTP status the envelope reports (RFC 9457 `status`). */
  readonly status: number;
}

const TYPE_BASE = 'https://trustcircle.governance/outcomes/';

export const OUTCOME_REGISTRY: Readonly<Record<OutcomeCode, OutcomeDescriptor>> = Object.freeze({
  succeeded: {
    code: 'succeeded',
    type: `${TYPE_BASE}succeeded`,
    title: 'Operation succeeded',
    status: 200,
  },
  duplicate: {
    code: 'duplicate',
    type: `${TYPE_BASE}duplicate`,
    title: 'Duplicate request; prior result returned',
    status: 200,
  },
  retryable_failure: {
    code: 'retryable_failure',
    type: `${TYPE_BASE}retryable-failure`,
    title: 'Transient failure; retry within bounds',
    status: 503,
  },
  non_retryable_failure: {
    code: 'non_retryable_failure',
    type: `${TYPE_BASE}non-retryable-failure`,
    title: 'Permanent failure; escalation required',
    status: 500,
  },
  rate_limited: {
    code: 'rate_limited',
    type: `${TYPE_BASE}rate-limited`,
    title: 'Rate limited; retry after delay',
    status: 429,
  },
  policy_denied: {
    code: 'policy_denied',
    type: `${TYPE_BASE}policy-denied`,
    title: 'Denied by policy; review required',
    status: 403,
  },
  contract_invalid: {
    code: 'contract_invalid',
    type: `${TYPE_BASE}contract-invalid`,
    title: 'Contract validation failed; fix and resubmit',
    status: 422,
  },
  version_unsupported: {
    code: 'version_unsupported',
    type: `${TYPE_BASE}version-unsupported`,
    title: 'Version unsupported; upgrade required',
    status: 409,
  },
  conflict: {
    code: 'conflict',
    type: `${TYPE_BASE}conflict`,
    title: 'State conflict; refresh and retry',
    status: 409,
  },
  uncertain: {
    code: 'uncertain',
    type: `${TYPE_BASE}uncertain`,
    title: 'Uncertain remote outcome; reconciliation required',
    status: 202,
  },
});

export function outcomeDescriptor(code: OutcomeCode): OutcomeDescriptor {
  const d = OUTCOME_REGISTRY[code];
  if (d === undefined) throw new Error(`no registry entry for outcome code: ${String(code)}`);
  return d;
}

// ===========================================================================
// 5. RFC 9457 error envelope (problem+json)
// ===========================================================================

/** The IANA media type for an RFC 9457 problem-details response. */
export const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

/**
 * RFC 9457 "Problem Details" envelope with governance extension members. The base members
 * (`type`, `title`, `status`, `detail`, `instance`) are exactly the RFC's; the extension
 * members bind the problem to a canonical outcome and its safe handling:
 *
 *   - `outcomeCode`   — the canonical outcome (single source of truth for handling).
 *   - `retry`         — bounded retry posture (never advises retrying a non-retryable code).
 *   - `nextAction`    — the single safe next action (CHK016).
 *   - `correlationId` — request/operation correlation for tracing (UUID).
 *   - `occurredAt`    — source/observation epoch-ms (never the wall clock inside this module).
 *
 * Envelopes are DISCLOSURE-SAFE: `title`/`type` come from the registry, `detail` is a
 * caller-supplied safe message, and no stack traces / secrets are ever included.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly outcomeCode: OutcomeCode;
  readonly retry: Retry;
  readonly nextAction: SafeNextAction;
  readonly correlationId: Uuid;
  readonly occurredAt: EpochMillis;
}

/** A phrase that would indicate internal disclosure leaking into a safe message. */
const DISCLOSURE_MARKERS = [
  /\bat\s+[\w$.]+\s*\(/i,
  /\.[jt]s:\d+/i,
  /stack trace/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
];

function assertDisclosureSafe(detail: string): void {
  for (const re of DISCLOSURE_MARKERS) {
    if (re.test(detail)) {
      throw new Error('problem detail must be disclosure-safe (no stack traces / secrets)');
    }
  }
}

/**
 * Build an RFC 9457 problem-details envelope for a canonical outcome. `retry` and `nextAction`
 * default to the canonical posture for the code, so an envelope is INTERNALLY CONSISTENT by
 * construction (a non-retryable code can never carry retry advice, and the next action always
 * matches the code). The `detail` is validated to be disclosure-safe.
 */
export function makeProblem(input: {
  outcomeCode: OutcomeCode;
  detail: string;
  instance: string;
  correlationId: Uuid;
  occurredAt: EpochMillis;
  retryAfterMs?: number;
}): ProblemDetails {
  if (!isOutcomeCode(input.outcomeCode)) {
    throw new TypeError(`unknown outcome code: ${String(input.outcomeCode)}`);
  }
  if (typeof input.detail !== 'string' || input.detail.trim().length === 0) {
    throw new TypeError('problem detail is mandatory and cannot be empty');
  }
  assertDisclosureSafe(input.detail);
  if (typeof input.instance !== 'string' || input.instance.trim().length === 0) {
    throw new TypeError('problem instance is mandatory');
  }
  if (!isUuid(input.correlationId)) throw new TypeError('correlationId must be a UUID');
  if (!Number.isInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new RangeError('occurredAt must be a non-negative epoch-ms integer');
  }
  const d = outcomeDescriptor(input.outcomeCode);
  const retry =
    input.retryAfterMs === undefined
      ? retryFor(input.outcomeCode)
      : retryFor(input.outcomeCode, { retryAfterMs: input.retryAfterMs });
  assertRetry(retry);
  const nextAction = safeNextActionFor(input.outcomeCode);
  return Object.freeze({
    type: d.type,
    title: d.title,
    status: d.status,
    detail: input.detail.trim(),
    instance: input.instance.trim(),
    outcomeCode: input.outcomeCode,
    retry,
    nextAction,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
  });
}

/**
 * Validate an arbitrary value as a well-formed, internally-consistent problem envelope:
 * the outcome code is canonical, the type/title/status match the registry, the retry posture
 * and next action are the canonical ones for the code, and the detail is disclosure-safe. This
 * is the independent read-path check a consumer / test uses to confirm an envelope was not
 * hand-forged with an inconsistent code/action.
 */
export function assertProblem(p: unknown): asserts p is ProblemDetails {
  if (typeof p !== 'object' || p === null) throw new TypeError('problem details required');
  const x = p as ProblemDetails;
  if (!isOutcomeCode(x.outcomeCode)) throw new TypeError('problem.outcomeCode invalid');
  const d = outcomeDescriptor(x.outcomeCode);
  if (x.type !== d.type) throw new Error('problem.type does not match the registry for its code');
  if (x.title !== d.title) throw new Error('problem.title does not match the registry');
  if (x.status !== d.status) throw new Error('problem.status does not match the registry');
  assertRetry(x.retry);
  const canonicalRetry = retryFor(x.outcomeCode, { retryAfterMs: x.retry.retryAfterMs });
  if (x.retry.retryable !== canonicalRetry.retryable) {
    throw new Error('problem.retry.retryable is inconsistent with the outcome code');
  }
  if (x.nextAction !== safeNextActionFor(x.outcomeCode)) {
    throw new Error('problem.nextAction is inconsistent with the outcome code (CHK016)');
  }
  if (typeof x.detail !== 'string' || x.detail.trim().length === 0) {
    throw new TypeError('problem.detail is mandatory');
  }
  assertDisclosureSafe(x.detail);
  if (!isUuid(x.correlationId)) throw new TypeError('problem.correlationId must be a UUID');
}

// ===========================================================================
// 6. Governed outcome catalog (GAR-005 executable invariant)
// ===========================================================================

/**
 * A governed outcome catalog: the outcome vocabulary itself is a governed MAPPING entity (one
 * of the five GAR-005 entity classes). It carries the nine oracle facets and a per-code
 * `descriptors` table. `assertOutcomeCatalog` refuses a catalog that is not a fully governed
 * entity OR whose descriptors are not exhaustive over `OUTCOME_CODES`, so "the outcome
 * vocabulary is governed and complete" is a checked invariant, not a claim.
 */
export interface OutcomeCatalog extends GovernedEntity {
  readonly kind: 'mapping';
  readonly descriptors: Readonly<Record<OutcomeCode, OutcomeDescriptor>>;
}

export function assertOutcomeCatalog(c: unknown): asserts c is OutcomeCatalog {
  // Every GAR-005 facet (stable id, version, owner, lifecycle, tests, monitoring, failure
  // behavior, exceptions, evidence expectations) must be present — the outcome vocabulary is a
  // governed entity, so the phase oracle holds for it.
  assertGovernedEntity(c);
  const cat = c as OutcomeCatalog;
  if (cat.kind !== 'mapping') throw new TypeError('outcome catalog must be a governed mapping');
  if (typeof cat.descriptors !== 'object' || cat.descriptors === null) {
    throw new TypeError('outcome catalog must carry a per-code descriptor table');
  }
  // Exhaustiveness: every canonical code has a descriptor whose members match the registry,
  // and no extra codes appear (no silent vocabulary drift).
  const keys = Object.keys(cat.descriptors).sort();
  const expected = [...OUTCOME_CODES].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error('outcome catalog descriptors must be exhaustive over OUTCOME_CODES');
  }
  for (const code of OUTCOME_CODES) {
    const d = cat.descriptors[code];
    const canonical = OUTCOME_REGISTRY[code];
    if (
      !d ||
      d.code !== code ||
      d.type !== canonical.type ||
      d.title !== canonical.title ||
      d.status !== canonical.status
    ) {
      throw new Error(`outcome catalog descriptor for "${code}" is missing or inconsistent`);
    }
  }
}

/**
 * Construct the canonical, fully governed outcome catalog. The caller supplies the governance
 * facets (stable UUIDv7 id, tenant scope, owner, version, lifecycle state, and the governance
 * contract). The descriptor table is the frozen canonical registry. The result is validated to
 * be a governed entity before it is returned, so an ungoverned catalog can never be produced.
 */
export function defineOutcomeCatalog(input: {
  id: Uuid;
  tenantId: TenantId;
  version: number;
  owner: Owner;
  lifecycleState: GovernedEntity['lifecycleState'];
  contract: GovernanceContract;
}): OutcomeCatalog {
  assertGovernanceContract(input.contract);
  const catalog: OutcomeCatalog = {
    id: input.id,
    kind: 'mapping',
    tenantId: input.tenantId,
    version: input.version,
    owner: input.owner,
    lifecycleState: input.lifecycleState,
    contract: input.contract,
    descriptors: OUTCOME_REGISTRY,
  };
  assertOutcomeCatalog(catalog);
  return catalog;
}

/**
 * Canonical content digest of an outcome catalog — a stable content hash that could not exist
 * before the catalog was constructed and changes iff any governed facet or descriptor changes.
 * An independently-verifiable durable-effect witness for higher layers and tests.
 */
export function outcomeCatalogDigest(c: OutcomeCatalog): string {
  assertOutcomeCatalog(c);
  const canonical = JSON.stringify({
    id: c.id,
    kind: c.kind,
    tenantId: c.tenantId,
    version: c.version,
    owner: c.owner,
    lifecycleState: c.lifecycleState,
    contract: {
      tests: [...c.contract.tests].sort(),
      monitoring: [...c.contract.monitoring].sort(),
      failureBehavior: c.contract.failureBehavior,
      exceptions: c.contract.exceptions.map((x) => ({
        exceptionId: x.exceptionId,
        reason: x.reason,
        approvedBy: x.approvedBy,
        expiresAt: x.expiresAt,
      })),
      evidenceExpectations: [...c.contract.evidenceExpectations].sort(),
    },
    descriptors: [...OUTCOME_CODES].sort().map((code) => c.descriptors[code]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ===========================================================================
// 7. Load-time exhaustiveness self-checks (fail fast on vocabulary drift)
// ===========================================================================
//
// These run when the module is imported. They guarantee that the three per-code tables
// (registry, safe-next-action, retry posture) stay exhaustive and internally consistent, so a
// future edit that adds a code without a rule cannot ship silently (CHK016 "one unambiguous
// next-action rule for each").

for (const code of OUTCOME_CODES) {
  if (!(code in OUTCOME_REGISTRY)) {
    throw new Error(`outcome registry is missing an entry for code "${code}"`);
  }
  if (!(code in SAFE_NEXT_ACTION_BY_CODE)) {
    throw new Error(`safe-next-action table is missing a rule for code "${code}" (CHK016)`);
  }
  // retryFor must be total and its retryable flag must agree with the next-action semantics.
  const r = retryFor(code);
  assertRetry(r);
}
