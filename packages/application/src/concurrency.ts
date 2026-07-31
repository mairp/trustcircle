// @trustcircle/application — optimistic version checks, ETags, If-Match parsing, and conflict
// responses (Phase 22 / T022 / VO-52d0780c11bcc6fd7583).
//
// Oracle (VO-52d0780c11bcc6fd7583, the phase's sole acceptance criterion): "Every onboarded
// source contract MUST be versioned and validated; mutating operations MUST be correlated,
// deduplicated, reconcilable, retry-bounded, and safe under duplicate, delayed, partial,
// conflicting, and uncertain outcomes."
//
// This module is the HTTP/transport-boundary half of that guarantee. The persistence layer
// (packages/persistence/database.ts `runMutation` + unit-of-work.ts `commitUnitOfWork`) already
// enforces optimistic concurrency INSIDE the transaction (WHERE version = expectedVersion). This
// module makes the same concurrency contract observable and enforceable at the EDGE — before a
// mutating request is ever admitted to the write path — via HTTP conditional requests (RFC 9110
// §8.8 / §13):
//
//   1. VERSIONED + VALIDATED — every governed resource is versioned (monotonic ≥ 1). An ETag is
//      derived deterministically from the resource's (id, version, tenant, content-digest). A
//      strong ETag is a validated, stable identity of a specific resource version; a change to
//      any of those fields changes the ETag. `parseETag`/`assertETag` VALIDATE the wire form —
//      a malformed validator is rejected rather than silently trusted.
//
//   2. IF-MATCH PARSING — `parseIfMatch` parses the RFC 9110 `If-Match` header grammar
//      (`*` | 1#entity-tag), including weak-tag markers and comma-separated lists, and REJECTS
//      malformed input. A mutating request that omits `If-Match` is UNCONDITIONAL and is refused
//      (`preconditionRequired`), so a client can never blind-overwrite a versioned resource — a
//      lost update is structurally impossible.
//
//   3. OPTIMISTIC VERSION CHECK — `evaluatePrecondition` compares the client's `If-Match`
//      validator(s) against the resource's CURRENT ETag. It resolves to exactly one of a closed
//      set of outcomes: proceed (validator matches — safe to mutate), conflict (validator is
//      stale — the resource moved under the client), precondition-required (no validator on a
//      mutation), or not-found. `*` matches any existing representation (create-if-exists).
//
//   4. CONFLICT RESPONSES — a stale precondition yields an RFC 9457 problem+json conflict
//      envelope carrying the canonical `conflict` outcome code, the single safe next action
//      (`refresh_and_retry`), the current server ETag, and a bounded retry posture — so the
//      caller reconciles against current state and retries within bounds rather than forcing a
//      duplicate or lost-update effect. This is the transport witness of the "safe under
//      conflicting outcomes" clause.
//
// Idempotency (the "deduplicated / safe under duplicate & uncertain" clause) is also surfaced at
// this boundary: `parseIdempotencyKey` validates the `Idempotency-Key` header, and
// `classifyReplay` decides — from a same-key/same-digest vs. same-key/different-digest
// comparison — whether an inbound retry is a safe DUPLICATE replay (return the stored result, no
// new effect) or an idempotency-key CONFLICT (same key, different request → refuse). This mirrors
// the durable idempotency ledger in persistence, at the edge.
//
// Dependency-free beyond @trustcircle/domain (which itself uses only Node built-in `crypto`), so
// it is independently observable and testable under `npm ci` with no adjacent infrastructure, and
// runs under Node 22 `--experimental-strip-types`. Pure and deterministic: no wall clock, no
// network, no randomness — every time/identity input is injected by the caller.

import { createHash } from 'node:crypto';
import {
  type EpochMillis,
  type OutcomeCode,
  type ProblemDetails,
  type Retry,
  type SafeNextAction,
  type Uuid,
  makeProblem,
  retryFor,
  safeNextActionFor,
} from '@trustcircle/domain';

// ===========================================================================
// 0. Resource version identity (the thing an ETag validates)
// ===========================================================================

/**
 * The versioned identity of a governed resource representation. An ETag is a deterministic
 * function of these fields, so a validator uniquely pins a *specific version* of a *specific*
 * resource in a *specific* tenant. `contentDigest` is any stable content hash of the
 * representation body (e.g. the persistence-layer canonical-state digest); it makes the ETag
 * sensitive to content changes even if the caller reuses a version number by mistake.
 */
export interface ResourceVersion {
  /** Stable resource identifier (opaque; not validated as UUID here so non-UUID keys work). */
  readonly id: string;
  /** Tenant scope the resource belongs to (isolation: an ETag never matches across tenants). */
  readonly tenantId: string;
  /** Monotonic optimistic-concurrency version; ≥ 1. */
  readonly version: number;
  /** Stable content hash of the representation body. */
  readonly contentDigest: string;
}

function assertResourceVersion(r: unknown): asserts r is ResourceVersion {
  if (typeof r !== 'object' || r === null) throw new TypeError('resource version required');
  const x = r as ResourceVersion;
  if (typeof x.id !== 'string' || x.id.trim().length === 0) {
    throw new TypeError('resource version must have a non-empty id');
  }
  if (typeof x.tenantId !== 'string' || x.tenantId.trim().length === 0) {
    throw new TypeError('resource version must have a non-empty tenantId');
  }
  if (!Number.isInteger(x.version) || x.version < 1) {
    throw new RangeError('resource version must be an integer ≥ 1');
  }
  if (typeof x.contentDigest !== 'string' || x.contentDigest.trim().length === 0) {
    throw new TypeError('resource version must have a non-empty contentDigest');
  }
}

// ===========================================================================
// 1. ETags — RFC 9110 §8.8.3 entity-tags
// ===========================================================================

/**
 * A parsed HTTP entity-tag (RFC 9110 §8.8.3). `value` is the opaque quoted-string content
 * (without the surrounding quotes); `weak` is true for a `W/`-prefixed weak validator. Strong
 * validators are required for If-Match precondition evaluation on mutations (a weak validator is
 * not usable for the byte-exact equivalence that a safe optimistic write demands).
 */
export interface ETag {
  readonly value: string;
  readonly weak: boolean;
}

// entity-tag = [ weak ] opaque-tag ; opaque-tag = DQUOTE *etagc DQUOTE
// etagc = %x21 / %x23-7E / obs-text  (i.e. any VCHAR except DQUOTE(%x22))
const ETAGC_RE = /^[\x21\x23-\x7e\x80-\xff]*$/;

/** Format a resource version as a STRONG ETag header value, e.g. `"v3-<hash>"`. Deterministic. */
export function makeETag(resource: ResourceVersion): string {
  assertResourceVersion(resource);
  const canonical = JSON.stringify({
    id: resource.id,
    tenantId: resource.tenantId,
    version: resource.version,
    contentDigest: resource.contentDigest,
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `"v${resource.version}-${hash}"`;
}

/** Parse a single entity-tag header value into a structured {@link ETag}, throwing on malformed
 * input. Accepts an optional `W/` weakness prefix followed by a quoted opaque tag. */
export function parseETag(raw: string): ETag {
  if (typeof raw !== 'string') throw new TypeError('ETag must be a string');
  let s = raw.trim();
  let weak = false;
  if (s.startsWith('W/')) {
    weak = true;
    s = s.slice(2);
  }
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') {
    throw new TypeError(`malformed entity-tag (must be a quoted string): ${JSON.stringify(raw)}`);
  }
  const value = s.slice(1, -1);
  if (!ETAGC_RE.test(value)) {
    throw new TypeError(`entity-tag contains illegal characters: ${JSON.stringify(raw)}`);
  }
  return { value, weak };
}

/** Non-throwing structural check that a value is a well-formed {@link ETag}. */
export function assertETag(t: unknown): asserts t is ETag {
  if (typeof t !== 'object' || t === null) throw new TypeError('ETag object required');
  const x = t as ETag;
  if (typeof x.value !== 'string' || !ETAGC_RE.test(x.value)) {
    throw new TypeError('ETag.value must be a valid opaque-tag string');
  }
  if (typeof x.weak !== 'boolean') throw new TypeError('ETag.weak must be a boolean');
}

/**
 * RFC 9110 §8.8.3.2 comparison.
 *   - STRONG comparison (used by If-Match on mutations): both tags MUST be strong and their
 *     opaque values MUST be octet-equal.
 *   - WEAK comparison (used by If-None-Match / caching): opaque values equal regardless of the
 *     weakness flag.
 */
export function eTagMatches(a: ETag, b: ETag, mode: 'strong' | 'weak' = 'strong'): boolean {
  assertETag(a);
  assertETag(b);
  if (mode === 'strong') {
    return !a.weak && !b.weak && a.value === b.value;
  }
  return a.value === b.value;
}

// ===========================================================================
// 2. If-Match parsing — RFC 9110 §13.1.1
// ===========================================================================

/**
 * A parsed `If-Match` precondition. Either the wildcard `*` (matches any current representation)
 * or a non-empty list of candidate entity-tags (1#entity-tag). An ABSENT header is represented by
 * `parseIfMatch(undefined) === null` — the caller decides whether absence is allowed (it is NOT,
 * for a mutation).
 */
export type IfMatch =
  { readonly wildcard: true } | { readonly wildcard: false; readonly tags: readonly ETag[] };

/**
 * Parse the RFC 9110 `If-Match` header. Returns `null` iff the header is absent (undefined/empty).
 * Returns `{ wildcard: true }` for `*`. Otherwise splits the comma-separated 1#entity-tag list and
 * parses each member as an entity-tag, THROWING on any malformed member (a mutating request with a
 * garbled precondition must be refused, not silently treated as unconditional).
 */
export function parseIfMatch(raw: string | undefined | null): IfMatch | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (s === '*') return { wildcard: true };
  // Split on commas that separate list members. Entity-tag opaque values may not contain a bare
  // comma outside quotes in the wire form we accept, so a top-level split on `,` is correct after
  // trimming optional whitespace (RFC 9110 OWS).
  const members = splitListMembers(s);
  if (members.length === 0) {
    throw new TypeError('If-Match must be `*` or a non-empty list of entity-tags');
  }
  const tags = members.map((m) => parseETag(m));
  return { wildcard: false, tags };
}

/** Split an HTTP 1#element list on commas, honouring quoted strings (a `,` inside quotes is not a
 * separator) and trimming optional whitespace around each member. Empty members are rejected. */
function splitListMembers(s: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  const members = out.filter((m) => m.length > 0);
  if (out.some((m) => m.length === 0)) {
    // A trailing/leading/double comma produced an empty member → malformed list.
    throw new TypeError(`malformed If-Match list (empty member): ${JSON.stringify(s)}`);
  }
  return members;
}

// ===========================================================================
// 3. Optimistic precondition evaluation
// ===========================================================================

/** The closed set of precondition-evaluation results. Exactly one is produced per request. */
export const PRECONDITION_RESULTS = [
  'proceed',
  'conflict',
  'precondition_required',
  'not_found',
] as const;
export type PreconditionResult = (typeof PRECONDITION_RESULTS)[number];

/** Outcome of evaluating a mutating request's precondition against current server state. */
export interface PreconditionDecision {
  readonly result: PreconditionResult;
  /** The resource's current strong ETag (present when the resource exists). */
  readonly currentETag: string | null;
  /** Human-readable, disclosure-safe explanation of the decision. */
  readonly reason: string;
}

/**
 * Evaluate an optimistic-concurrency precondition for a MUTATING request (RFC 9110 §13.1.1
 * If-Match semantics), the edge counterpart of the persistence `WHERE version = expectedVersion`
 * check:
 *
 *   - resource ABSENT + `If-Match: *`      → `not_found` (nothing to match).
 *   - resource ABSENT + specific validator → `not_found`.
 *   - `If-Match` MISSING                   → `precondition_required` (unconditional mutation
 *                                            refused; a lost update is structurally impossible).
 *   - `If-Match: *` + resource present     → `proceed`.
 *   - a strong validator STRONG-matches the current ETag → `proceed`.
 *   - a validator is present but NONE matches (stale)     → `conflict`.
 *
 * `ifMatch === null` means the header was absent. The function is pure — it never reads a clock or
 * mutates anything; it only compares the parsed precondition to the supplied current state.
 */
export function evaluatePrecondition(input: {
  ifMatch: IfMatch | null;
  current: ResourceVersion | null;
}): PreconditionDecision {
  const { ifMatch, current } = input;
  const currentETag = current === null ? null : makeETag(current);

  if (ifMatch === null) {
    return {
      result: 'precondition_required',
      currentETag,
      reason: 'a mutating request must carry an If-Match precondition to avoid lost updates',
    };
  }

  if (current === null) {
    return {
      result: 'not_found',
      currentETag: null,
      reason: 'the target resource does not exist; there is no representation to match',
    };
  }

  const currentTag = parseETag(currentETag!);

  if (ifMatch.wildcard) {
    return {
      result: 'proceed',
      currentETag,
      reason: 'If-Match: * matched an existing representation',
    };
  }

  const matched = ifMatch.tags.some((t) => eTagMatches(t, currentTag, 'strong'));
  if (matched) {
    return {
      result: 'proceed',
      currentETag,
      reason: 'the supplied validator matches the current resource version',
    };
  }
  return {
    result: 'conflict',
    currentETag,
    reason: 'the supplied validator is stale; the resource has changed since it was read',
  };
}

// ===========================================================================
// 4. Conflict / precondition responses (RFC 9457 problem+json)
// ===========================================================================

/**
 * A precondition/conflict HTTP response: the numeric status, the current server ETag to echo in
 * the `ETag` response header (so the client can immediately re-read/retry against current state),
 * the canonical outcome code, the single safe next action, a bounded retry posture, and the
 * RFC 9457 problem+json body.
 */
export interface ConflictResponse {
  readonly status: number;
  readonly outcomeCode: OutcomeCode;
  readonly nextAction: SafeNextAction;
  readonly retry: Retry;
  /** Value for the `ETag` response header (current version), or null when the resource is gone. */
  readonly etagHeader: string | null;
  readonly problem: ProblemDetails;
}

/**
 * Build the transport response for a non-`proceed` precondition decision. Only failing decisions
 * have a response (a `proceed` decision continues to the write path), so `proceed` is rejected.
 *
 *   - `conflict`              → 409 + canonical `conflict` outcome + `refresh_and_retry` + bounded
 *                               retry; echoes the current ETag so the caller reconciles & retries.
 *   - `precondition_required` → 428 + `contract_invalid` outcome + `fix_and_resubmit` (the request
 *                               is missing the mandatory precondition).
 *   - `not_found`             → 404 + `non_retryable_failure` outcome + `escalate`.
 *
 * The problem body is disclosure-safe by construction (built via the domain `makeProblem`). The
 * caller supplies a correlation id and the source/observation `occurredAt` (never a wall clock).
 */
export function buildConflictResponse(input: {
  decision: PreconditionDecision;
  instance: string;
  /** Request/operation correlation id (validated as a UUID by the domain envelope). */
  correlationId: Uuid;
  /** Source/observation time in epoch-ms (never a wall clock read inside this module). */
  occurredAt: EpochMillis;
}): ConflictResponse {
  const { decision } = input;
  if (decision.result === 'proceed') {
    throw new Error('buildConflictResponse must not be called for a "proceed" decision');
  }
  const outcomeCode: OutcomeCode =
    decision.result === 'conflict'
      ? 'conflict'
      : decision.result === 'precondition_required'
        ? 'contract_invalid'
        : 'non_retryable_failure';

  const problem = makeProblem({
    outcomeCode,
    detail: decision.reason,
    instance: input.instance,
    // The domain envelope re-validates the correlationId is a UUID and occurredAt is epoch-ms.
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
  });

  return {
    status: problem.status,
    outcomeCode,
    nextAction: safeNextActionFor(outcomeCode),
    retry: retryFor(outcomeCode),
    etagHeader: decision.currentETag,
    problem,
  };
}

// ===========================================================================
// 5. Idempotency-key replay classification (dedup / safe-under-duplicate)
// ===========================================================================

/** A validated `Idempotency-Key` (opaque, bounded length, non-empty). */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Parse/validate the `Idempotency-Key` request header. Returns `null` when absent; throws on a
 * malformed (empty / over-long / control-char) key. */
export function parseIdempotencyKey(raw: string | undefined | null): IdempotencyKey | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  if (!IDEMPOTENCY_KEY_RE.test(s)) {
    throw new TypeError('Idempotency-Key must be 1..255 printable ASCII characters');
  }
  return s as IdempotencyKey;
}

/** The closed set of replay classifications for an inbound keyed mutation. */
export const REPLAY_CLASSES = ['first', 'duplicate', 'idempotency_conflict'] as const;
export type ReplayClass = (typeof REPLAY_CLASSES)[number];

export interface ReplayDecision {
  readonly class: ReplayClass;
  /** The outcome the caller should surface: undefined for `first` (proceed to execute). */
  readonly outcomeCode?: OutcomeCode;
  readonly reason: string;
}

/**
 * Classify an inbound keyed mutation against the durable idempotency ledger, the edge counterpart
 * of persistence `runMutation`'s dedup:
 *
 *   - no prior record for this key                       → `first` (execute; then record).
 *   - prior record, SAME request digest                 → `duplicate` (safe replay; return the
 *                                                          stored result, cause NO new effect).
 *   - prior record, DIFFERENT request digest (same key) → `idempotency_conflict` (a different
 *                                                          request reused a key; refuse — never
 *                                                          apply, never claim the prior success).
 *
 * `requestDigest` is a stable hash of the request the caller is about to (re)apply; `stored` is
 * the ledger row for the key, or null if none. Pure and deterministic.
 */
export function classifyReplay(input: {
  requestDigest: string;
  stored: { readonly requestDigest: string } | null;
}): ReplayDecision {
  if (typeof input.requestDigest !== 'string' || input.requestDigest.trim().length === 0) {
    throw new TypeError('requestDigest is required to classify a replay');
  }
  if (input.stored === null) {
    return { class: 'first', reason: 'no prior record for this idempotency key; execute once' };
  }
  if (input.stored.requestDigest === input.requestDigest) {
    return {
      class: 'duplicate',
      outcomeCode: 'duplicate',
      reason: 'same idempotency key and request digest; safe replay — return the stored result',
    };
  }
  return {
    class: 'idempotency_conflict',
    outcomeCode: 'conflict',
    reason: 'same idempotency key with a different request digest; refuse to avoid a lost update',
  };
}
