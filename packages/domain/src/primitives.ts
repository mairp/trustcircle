// @trustcircle/domain — governance primitives (Phase 14 / VO-34d9f9fb2a6a39e2d62c /
// VO-3e0ee6687f6754efc03c).
//
// Oracle (VO-34d9f9fb2a6a39e2d62c): Integrity rules, policies, controllers, controls, and
// mappings MUST have stable identifiers, versions, owners, lifecycle states, tests,
// monitoring, failure behavior, exceptions, and evidence expectations.
//
// This module is the framework-independent foundation the rest of the platform builds on. It
// makes the oracle *enforceable at the type and value level* by providing:
//
//   1. Stable identifiers — UUIDv7 values, generated deterministically (injectable clock +
//      randomness, never the wall clock) and exposed as opaque, validated strings. UUIDv7 is
//      time-ordered, so identifiers are stable, unique, and sortable by creation without
//      leaking business meaning.
//   2. Separate time types — source time (`occurredAt`), platform observation time
//      (`observedAt`), and commit/recorded time (`recordedAt`) are DISTINCT branded types so
//      they cannot be confused (data-model.md "Modeling conventions").
//   3. Structured reasons — `{ code, text }` where consequential decisions cannot use an
//      empty or whitespace-only reason (data-model.md "Reasons are structured …").
//   4. Tenant-scoped entity primitives — every governed record carries `tenantId`, `version`,
//      `owner`, a `lifecycleState`, and a `GovernanceContract` (tests, monitoring, failure
//      behavior, exceptions, evidence expectations). `assertGovernedEntity` refuses any
//      governed entity missing one of the nine oracle facets, so "governed" is not a claim —
//      it is a checked invariant.
//
// Dependency-free (Node built-in `crypto` only) so it is independently observable and
// testable under `npm ci` with no adjacent infrastructure, and runs under Node 22
// `--experimental-strip-types`.

import { createHash, randomFillSync } from 'node:crypto';

// ===========================================================================
// 1. Stable identifiers — UUIDv7
// ===========================================================================

/** Opaque, validated canonical identifier. Branded so a raw string cannot be passed where a
 * validated UUIDv7 is required. */
export type Uuid = string & { readonly __brand: 'Uuid' };

/** Milliseconds since the Unix epoch (deterministic, injectable — never reads the wall clock). */
export type EpochMillis = number;

/** Injectable entropy source. Defaults to the crypto RNG; tests pass a deterministic one. */
export type RandomBytes = (n: number) => Uint8Array;

const cryptoRandomBytes: RandomBytes = (n) => randomFillSync(new Uint8Array(n));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True iff `s` is a syntactically valid lowercase canonical UUID string. */
export function isUuid(s: unknown): s is Uuid {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** True iff `s` is a valid UUID whose version nibble is 7 (time-ordered UUIDv7). */
export function isUuidV7(s: unknown): s is Uuid {
  return isUuid(s) && s[14] === '7' && '89ab'.includes(s[19]!);
}

/** Parse/validate an opaque identifier, throwing on malformed input. */
export function toUuid(s: string): Uuid {
  if (!isUuid(s)) throw new TypeError(`invalid UUID: ${JSON.stringify(s)}`);
  return s as Uuid;
}

function byteToHex(b: number): string {
  return b.toString(16).padStart(2, '0');
}

/**
 * Generate a UUIDv7 (RFC 9562): 48-bit big-endian Unix-millisecond timestamp, version 7, and
 * 74 bits of randomness, with the variant bits set. Time-ordered ⇒ identifiers sort by
 * creation time. `atMillis` and `random` are injectable so identity generation is
 * deterministic and independently reproducible in tests (never touches the wall clock here).
 */
export function uuidV7(atMillis: EpochMillis, random: RandomBytes = cryptoRandomBytes): Uuid {
  if (!Number.isInteger(atMillis) || atMillis < 0 || atMillis > 0xffffffffffff) {
    throw new RangeError(`uuidV7 timestamp out of range: ${atMillis}`);
  }
  const bytes = new Uint8Array(16);
  // 48-bit timestamp, big-endian.
  bytes[0] = (atMillis / 2 ** 40) & 0xff;
  bytes[1] = (atMillis / 2 ** 32) & 0xff;
  bytes[2] = (atMillis / 2 ** 24) & 0xff;
  bytes[3] = (atMillis / 2 ** 16) & 0xff;
  bytes[4] = (atMillis / 2 ** 8) & 0xff;
  bytes[5] = atMillis & 0xff;
  // 74 random bits fill the remaining 10 bytes.
  const rnd = random(10);
  if (rnd.length < 10) throw new Error('random source returned too few bytes');
  bytes.set(rnd.subarray(0, 10), 6);
  // Version 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant (10xx) in the high bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = Array.from(bytes, byteToHex).join('');
  const s = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return s as Uuid;
}

/** Recover the embedded 48-bit millisecond timestamp from a UUIDv7. */
export function uuidV7Timestamp(id: Uuid): EpochMillis {
  if (!isUuidV7(id)) throw new TypeError(`not a UUIDv7: ${id}`);
  const hex = id.replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16);
}

/**
 * A monotonic UUIDv7 factory. Guarantees strictly increasing identifiers even when many are
 * minted within the same millisecond (bumps the embedded timestamp by 1ms once the current
 * millisecond is exhausted), so ordering-by-id is a stable, reconstructable total order — the
 * property duplicate/out-of-order reconciliation elsewhere relies on.
 */
export function createIdFactory(random: RandomBytes = cryptoRandomBytes): {
  next(atMillis: EpochMillis): Uuid;
} {
  let last = -1;
  return {
    next(atMillis: EpochMillis): Uuid {
      const t = atMillis <= last ? last + 1 : atMillis;
      last = t;
      return uuidV7(t, random);
    },
  };
}

// ===========================================================================
// 2. Source / observation / recorded time — three distinct branded types
// ===========================================================================

/** When the event happened at the source (`occurred_at`). */
export type OccurredAt = EpochMillis & { readonly __time: 'occurred' };
/** When the platform observed it (`observed_at`). */
export type ObservedAt = EpochMillis & { readonly __time: 'observed' };
/** When it was committed to canonical state (`recorded_at`). */
export type RecordedAt = EpochMillis & { readonly __time: 'recorded' };

function assertEpoch(ms: number, label: string): void {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${ms}`);
  }
}

export const occurredAt = (ms: EpochMillis): OccurredAt => (
  assertEpoch(ms, 'occurredAt'),
  ms as OccurredAt
);
export const observedAt = (ms: EpochMillis): ObservedAt => (
  assertEpoch(ms, 'observedAt'),
  ms as ObservedAt
);
export const recordedAt = (ms: EpochMillis): RecordedAt => (
  assertEpoch(ms, 'recordedAt'),
  ms as RecordedAt
);

/**
 * The three timestamps of a single observation, plus explicit ordering-uncertainty. The
 * platform NEVER conflates source time with observation/commit time; the causal invariant
 * `occurred ≤ observed ≤ recorded` is checked so a record cannot claim to have been observed
 * or committed before it happened.
 */
export interface SourceTiming {
  readonly occurredAt: OccurredAt;
  readonly observedAt: ObservedAt;
  readonly recordedAt: RecordedAt;
  /** True when source ordering could not be established (data-model "ordering uncertainty"). */
  readonly orderingUncertain: boolean;
}

export function makeSourceTiming(input: {
  occurredAt: EpochMillis;
  observedAt: EpochMillis;
  recordedAt: EpochMillis;
  orderingUncertain?: boolean;
}): SourceTiming {
  const o = occurredAt(input.occurredAt);
  const obs = observedAt(input.observedAt);
  const rec = recordedAt(input.recordedAt);
  if (!(o <= obs)) throw new RangeError('occurredAt must be ≤ observedAt');
  if (!(obs <= rec)) throw new RangeError('observedAt must be ≤ recordedAt');
  return {
    occurredAt: o,
    observedAt: obs,
    recordedAt: rec,
    orderingUncertain: input.orderingUncertain ?? false,
  };
}

// ===========================================================================
// 3. Structured reasons
// ===========================================================================

/**
 * A structured reason: a stable machine `code` plus a mandatory human-readable `text`.
 * Consequential decisions cannot use an empty or whitespace-only reason (data-model.md).
 */
export interface Reason {
  readonly code: string;
  readonly text: string;
}

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

export function makeReason(code: string, text: string): Reason {
  if (!REASON_CODE_RE.test(code)) {
    throw new TypeError(`reason code must match ${REASON_CODE_RE}, got ${JSON.stringify(code)}`);
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('reason text is mandatory and cannot be empty or whitespace-only');
  }
  return { code, text: text.trim() };
}

/** Predicate form used by consequential-decision guards elsewhere. */
export function isConsequentialReason(r: unknown): r is Reason {
  return (
    typeof r === 'object' &&
    r !== null &&
    REASON_CODE_RE.test((r as Reason).code) &&
    typeof (r as Reason).text === 'string' &&
    (r as Reason).text.trim().length > 0
  );
}

// ===========================================================================
// 4. Tenant-scoped, governed entity primitives
// ===========================================================================

/** Reserved platform (non-tenant) scope for global publication facts (data-model.md). */
export const PLATFORM_SCOPE = 'platform' as const;
export type TenantId = Uuid | typeof PLATFORM_SCOPE;

/** Lifecycle state machine shared by governed entities (rules, policies, controllers,
 * controls, mappings). Terminal states are queryable, never deleted. */
export const LIFECYCLE_STATES = ['draft', 'proposed', 'active', 'deprecated', 'retired'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  draft: ['proposed', 'retired'],
  proposed: ['active', 'draft', 'retired'],
  active: ['deprecated', 'retired'],
  deprecated: ['retired', 'active'],
  retired: [],
};

export function isLifecycleState(s: unknown): s is LifecycleState {
  return typeof s === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(s);
}

/** True iff `to` is a permitted lifecycle transition from `from`. Terminal `retired` is a
 * sink: no transition leaves it. */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) {
    throw new RangeError(`illegal lifecycle transition: ${from} → ${to}`);
  }
}

/** Accountable ownership: a governed entity is owned by a named principal/team, and its
 * decisions are attributable to an accountable owner. */
export interface Owner {
  readonly ownerId: string;
  readonly kind: 'user' | 'team' | 'service';
}

/**
 * The governance contract every integrity rule / policy / controller / control / mapping MUST
 * carry, per the oracle. Each field is REQUIRED and non-vacuous; `assertGovernanceContract`
 * refuses a contract that omits or empties any of them.
 *
 *   - `tests`               — verification obligation IDs / test refs proving the entity works.
 *   - `monitoring`          — signals/alerts that observe the entity in production.
 *   - `failureBehavior`     — how it behaves on failure (fail-closed / fail-open / degrade).
 *   - `exceptions`          — the approved-exception register (may be empty array, but present).
 *   - `evidenceExpectations`— what evidence the entity must produce to be reported complete.
 */
export type FailureBehavior = 'fail-closed' | 'fail-open' | 'degrade' | 'pause-safe';

export interface GovernanceException {
  readonly exceptionId: Uuid;
  readonly reason: Reason;
  readonly approvedBy: Owner;
  readonly expiresAt: EpochMillis;
}

export interface GovernanceContract {
  readonly tests: readonly string[];
  readonly monitoring: readonly string[];
  readonly failureBehavior: FailureBehavior;
  readonly exceptions: readonly GovernanceException[];
  readonly evidenceExpectations: readonly string[];
}

const FAILURE_BEHAVIORS: readonly FailureBehavior[] = [
  'fail-closed',
  'fail-open',
  'degrade',
  'pause-safe',
];

/** The classes of governed entity the oracle enumerates. */
export const GOVERNED_ENTITY_KINDS = [
  'integrity-rule',
  'policy',
  'controller',
  'control',
  'mapping',
] as const;
export type GovernedEntityKind = (typeof GOVERNED_ENTITY_KINDS)[number];

export function isGovernedEntityKind(s: unknown): s is GovernedEntityKind {
  return typeof s === 'string' && (GOVERNED_ENTITY_KINDS as readonly string[]).includes(s);
}

/**
 * A tenant-scoped governed entity. This is the primitive that carries every facet the oracle
 * requires: stable identifier, version, owner, lifecycle state, and a governance contract
 * (tests, monitoring, failure behavior, exceptions, evidence expectations).
 */
export interface GovernedEntity {
  readonly id: Uuid;
  readonly kind: GovernedEntityKind;
  readonly tenantId: TenantId;
  /** Monotonic optimistic-concurrency version; ≥ 1. */
  readonly version: number;
  readonly owner: Owner;
  readonly lifecycleState: LifecycleState;
  readonly contract: GovernanceContract;
}

function nonEmptyStrings(xs: unknown, label: string): asserts xs is readonly string[] {
  if (!Array.isArray(xs) || xs.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  for (const x of xs) {
    if (typeof x !== 'string' || x.trim().length === 0) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
  }
}

/** Validate that a governance contract is complete and non-vacuous. */
export function assertGovernanceContract(c: unknown): asserts c is GovernanceContract {
  if (typeof c !== 'object' || c === null) throw new TypeError('governance contract required');
  const gc = c as GovernanceContract;
  nonEmptyStrings(gc.tests, 'contract.tests');
  nonEmptyStrings(gc.monitoring, 'contract.monitoring');
  if (!FAILURE_BEHAVIORS.includes(gc.failureBehavior)) {
    throw new TypeError(`contract.failureBehavior must be one of ${FAILURE_BEHAVIORS.join('|')}`);
  }
  if (!Array.isArray(gc.exceptions))
    throw new TypeError('contract.exceptions must be present (possibly empty)');
  for (const e of gc.exceptions) {
    if (!isUuid(e.exceptionId)) throw new TypeError('exception.exceptionId must be a UUID');
    if (!isConsequentialReason(e.reason))
      throw new TypeError('exception.reason must be a structured non-empty reason');
    if (
      !e.approvedBy ||
      typeof e.approvedBy.ownerId !== 'string' ||
      e.approvedBy.ownerId.length === 0
    ) {
      throw new TypeError('exception.approvedBy must be a named owner');
    }
    assertEpoch(e.expiresAt, 'exception.expiresAt');
  }
  nonEmptyStrings(gc.evidenceExpectations, 'contract.evidenceExpectations');
}

/**
 * Validate that a value is a fully-governed entity: it carries a STABLE IDENTIFIER (UUIDv7),
 * a VERSION, an OWNER, a LIFECYCLE STATE, and a complete governance CONTRACT (TESTS,
 * MONITORING, FAILURE BEHAVIOR, EXCEPTIONS, EVIDENCE EXPECTATIONS). This is the executable
 * form of the phase oracle — "governed" is a checked invariant, not a claim.
 */
export function assertGovernedEntity(e: unknown): asserts e is GovernedEntity {
  if (typeof e !== 'object' || e === null) throw new TypeError('governed entity required');
  const g = e as GovernedEntity;
  if (!isUuidV7(g.id)) throw new TypeError('governed entity must have a stable UUIDv7 identifier');
  if (!isGovernedEntityKind(g.kind))
    throw new TypeError(`unknown governed entity kind: ${String(g.kind)}`);
  if (g.tenantId !== PLATFORM_SCOPE && !isUuid(g.tenantId)) {
    throw new TypeError('governed entity must be tenant-scoped (tenantId UUID or platform scope)');
  }
  if (!Number.isInteger(g.version) || g.version < 1)
    throw new TypeError('governed entity must have version ≥ 1');
  if (!g.owner || typeof g.owner.ownerId !== 'string' || g.owner.ownerId.trim().length === 0) {
    throw new TypeError('governed entity must have a named owner');
  }
  if (!['user', 'team', 'service'].includes(g.owner.kind))
    throw new TypeError('owner.kind invalid');
  if (!isLifecycleState(g.lifecycleState))
    throw new TypeError('governed entity must have a lifecycle state');
  assertGovernanceContract(g.contract);
}

/** Non-throwing predicate companion to {@link assertGovernedEntity}. */
export function isGovernedEntity(e: unknown): e is GovernedEntity {
  try {
    assertGovernedEntity(e);
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical content digest of a governed entity — a stable content hash that could not exist
 * before the entity was constructed and that changes iff any governed facet changes. Used as
 * an independently-verifiable durable-effect witness by higher layers.
 */
export function governedEntityDigest(e: GovernedEntity): string {
  assertGovernedEntity(e);
  const canonical = JSON.stringify({
    id: e.id,
    kind: e.kind,
    tenantId: e.tenantId,
    version: e.version,
    owner: e.owner,
    lifecycleState: e.lifecycleState,
    contract: {
      tests: [...e.contract.tests].sort(),
      monitoring: [...e.contract.monitoring].sort(),
      failureBehavior: e.contract.failureBehavior,
      exceptions: e.contract.exceptions.map((x) => ({
        exceptionId: x.exceptionId,
        reason: x.reason,
        approvedBy: x.approvedBy,
        expiresAt: x.expiresAt,
      })),
      evidenceExpectations: [...e.contract.evidenceExpectations].sort(),
    },
  });
  return createHash('sha256').update(canonical).digest('hex');
}
