// @trustcircle/contracts — versioned governance event envelope: validation,
// additive-field (same-major) compatibility, and aggregate ordering checks.
//
// Phase 26 / task T026 / GAR-008 / VO-52d0780c11bcc6fd7583.
//
// Oracle (GAR-008 / VO-52d0780c11bcc6fd7583):
//   "Every onboarded source contract MUST be versioned and validated; mutating
//    operations MUST be correlated, deduplicated, reconcilable, retry-bounded,
//    and safe under duplicate, delayed, partial, conflicting, and uncertain
//    outcomes."
//
// The generated type surface (src/generated/governance-events.ts) is the
// *compile-time* contract derived from the canonical AsyncAPI source
// (specs/.../contracts/governance-events.asyncapi.yaml). Types alone cannot
// enforce the oracle at runtime: a redelivered event, an out-of-order aggregate
// version, or a payload with a stray field is still a `GovernanceEventsEventEnvelope`
// to the compiler. This module is the *runtime* half of the contract. It makes
// every clause of the oracle an executable, independently observable check:
//
//   VERSIONED    — `schema_version` is a required `const "1.0.0"`; the parser
//                  refuses any envelope whose declared version is not the single
//                  supported major.minor.patch. Major/minor/patch are split so a
//                  higher *minor* is treated as additive (tolerated read-only)
//                  while a higher/lower *major* is a hard incompatibility.
//   VALIDATED    — every required field, format (uuid / rfc3339 / sha256 / event
//                  type pattern), and enum from the AsyncAPI schema is checked;
//                  violations produce structured, path-anchored problems (never a
//                  thrown opaque error), so a partial/malformed message is
//                  rejected before it can drive a mutating action.
//   ADDITIVE     — unknown top-level keys and unknown `extensions`/`data` keys are
//                  TOLERATED under the same major (forward compatibility for
//                  supported consumers), but a *structural* violation of a known
//                  field is still rejected. This is the "safe under … partial"
//                  and consumer-compatibility guarantee.
//   CORRELATED   — `correlation_id` (+ optional `causation_id`/`trace_id`) is
//                  required and validated; ordering is tracked per
//                  (tenant_id, aggregate_type, aggregate_id) — the correlation key.
//   DEDUPLICATED — the ordering tracker recognises a re-delivered `event_id` and a
//                  replayed `aggregate_version` and reports `duplicate` WITHOUT
//                  advancing state, so a duplicate causes no second effect.
//   RECONCILABLE — the tracker exposes the last applied version + the full set of
//                  seen event ids per aggregate, so ingest history is
//                  reconstructable and a gap (missing version) is explicit.
//   RETRY-BOUNDED— `classifyDelivery` returns a bounded, total decision
//                  (apply / duplicate / out_of_order / gap / conflict / reject)
//                  with a `retryable` flag, so callers never loop unboundedly on a
//                  permanently-bad message.
//   SAFE UNDER   — duplicate → `duplicate`; delayed/out-of-order → `out_of_order`
//   duplicate/    (buffer, do not apply, no regression); partial/malformed →
//   delayed/      `reject`; conflicting (same version, different event id) →
//   partial/      `conflict` (visible, not silently overwritten); uncertain
//   conflicting/  (`source.ordering_uncertain`) → ordering is advisory only and a
//   uncertain     version that would regress is reported, never silently applied.
//
// Dependency-free (no imports beyond the generated *type* surface, erased at
// build under `verbatimModuleSyntax`), so it is independently testable under
// `npm ci` with no infrastructure and runs under Node 22 `--experimental-strip-types`.

import type {
  GovernanceEventsEventEnvelope,
  GovernanceEventsSourceReference,
} from './generated/governance-events.ts';

// ===========================================================================
// 0. Versioning — the single supported schema version and same-major policy
// ===========================================================================

/** The one supported envelope schema version (mirrors the AsyncAPI `const`). */
export const SUPPORTED_SCHEMA_VERSION = '1.0.0' as const;

/** A parsed semantic version. */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SUPPORTED: SemVer = { major: 1, minor: 0, patch: 0 };

/** Parse a strict `X.Y.Z` semantic version, or `null` when malformed. */
export function parseSemVer(raw: unknown): SemVer | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!m) return null;
  // The regex guarantees three capture groups exist and are all-digit.
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  return { major, minor, patch };
}

/**
 * Same-major compatibility verdict for a declared version vs the supported one.
 *
 *  - `exact`         — identical version; fully supported.
 *  - `additive`      — same major, declared minor/patch >= supported: additive
 *                      changes only; a supported consumer tolerates it read-only.
 *  - `downlevel`     — same major, declared minor/patch < supported: older but
 *                      still same-major; readable (fields are a subset).
 *  - `incompatible`  — different major (or unparsable): NOT readable.
 */
export type VersionCompatibility = 'exact' | 'additive' | 'downlevel' | 'incompatible';

/** Classify a declared schema version against the supported one. */
export function classifyVersion(declared: unknown): VersionCompatibility {
  const v = parseSemVer(declared);
  if (v === null) return 'incompatible';
  if (v.major !== SUPPORTED.major) return 'incompatible';
  if (v.minor === SUPPORTED.minor && v.patch === SUPPORTED.patch) return 'exact';
  if (v.minor > SUPPORTED.minor || (v.minor === SUPPORTED.minor && v.patch > SUPPORTED.patch)) {
    return 'additive';
  }
  return 'downlevel';
}

/** True iff an envelope of the declared version is safe for a supported consumer to read. */
export function isReadableVersion(declared: unknown): boolean {
  return classifyVersion(declared) !== 'incompatible';
}

// ===========================================================================
// 1. Structured validation problems (never throw opaque errors)
// ===========================================================================

/** A single, path-anchored validation problem. */
export interface ValidationProblem {
  /** JSON-pointer-ish path to the offending field, e.g. `/actor/principal_id`. */
  readonly path: string;
  /** Stable machine code, e.g. `required`, `format`, `enum`, `const`, `additional_property`. */
  readonly code: string;
  /** Human-readable explanation. */
  readonly message: string;
}

/** The result of validating an envelope. `valid` is true iff `problems` is empty. */
export interface ValidationResult {
  readonly valid: boolean;
  readonly problems: readonly ValidationProblem[];
  /** The declared schema version's compatibility (populated even on failure when parsable). */
  readonly versionCompatibility: VersionCompatibility;
}

// ---- format primitives (mirror the AsyncAPI `format`/`pattern` constraints) ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const EVENT_TYPE_RE = /^governance\.[a-z0-9_.-]+$/;
// RFC 3339 / ISO-8601 date-time with mandatory offset (Z or ±hh:mm).
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
function isSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}
function isDateTime(v: unknown): boolean {
  if (typeof v !== 'string' || !DATE_TIME_RE.test(v)) return false;
  // Reject impossible calendar values (e.g. month 13) that pass the shape test.
  const t = Date.parse(v);
  return Number.isFinite(t);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ACTOR_PRINCIPAL_TYPES = new Set(['human', 'service', 'automation', 'external_assessor']);

// Known top-level envelope keys (from the AsyncAPI EventEnvelope schema). Unknown
// top-level keys are the *additive* surface: tolerated same-major, never fatal.
const KNOWN_ENVELOPE_KEYS = new Set<string>([
  'schema_version',
  'event_id',
  'event_type',
  'tenant_id',
  'aggregate_type',
  'aggregate_id',
  'aggregate_version',
  'occurred_at',
  'recorded_at',
  'actor',
  'accountable_owner_principal_id',
  'reason',
  'correlation_id',
  'causation_id',
  'trace_id',
  'source',
  'policy',
  'controls',
  'evidence',
  'data',
  'extensions',
]);

function problem(path: string, code: string, message: string): ValidationProblem {
  return { path, code, message };
}

function checkActor(actor: unknown, out: ValidationProblem[]): void {
  if (!isPlainObject(actor)) {
    out.push(problem('/actor', 'type', 'actor must be an object'));
    return;
  }
  if (!isUuid(actor['principal_id'])) {
    out.push(problem('/actor/principal_id', 'format', 'principal_id must be a uuid'));
  }
  if (!ACTOR_PRINCIPAL_TYPES.has(actor['principal_type'] as string)) {
    out.push(problem('/actor/principal_type', 'enum', 'principal_type must be a known actor type'));
  }
}

function checkPolicy(policy: unknown, out: ValidationProblem[]): void {
  if (!isPlainObject(policy)) {
    out.push(problem('/policy', 'type', 'policy must be an object'));
    return;
  }
  if (!isUuid(policy['policy_version_id'])) {
    out.push(problem('/policy/policy_version_id', 'format', 'policy_version_id must be a uuid'));
  }
  if (!isUuid(policy['policy_decision_id'])) {
    out.push(problem('/policy/policy_decision_id', 'format', 'policy_decision_id must be a uuid'));
  }
  if (!isSha256(policy['bundle_digest'])) {
    out.push(problem('/policy/bundle_digest', 'format', 'bundle_digest must be a sha256 hex'));
  }
}

function checkEvidence(evidence: unknown, out: ValidationProblem[]): void {
  if (!Array.isArray(evidence)) {
    out.push(problem('/evidence', 'type', 'evidence must be an array'));
    return;
  }
  const seen = new Set<string>();
  evidence.forEach((e, i) => {
    if (!isPlainObject(e)) {
      out.push(problem(`/evidence/${i}`, 'type', 'evidence item must be an object'));
      return;
    }
    if (!isUuid(e['evidence_id'])) {
      out.push(problem(`/evidence/${i}/evidence_id`, 'format', 'evidence_id must be a uuid'));
    }
    if (!isSha256(e['sha256'])) {
      out.push(problem(`/evidence/${i}/sha256`, 'format', 'sha256 must be a sha256 hex'));
    }
    const key = `${String(e['evidence_id'])}:${String(e['sha256'])}`;
    if (seen.has(key)) {
      out.push(problem(`/evidence/${i}`, 'unique', 'evidence items must be unique'));
    }
    seen.add(key);
  });
}

function checkSource(source: unknown, out: ValidationProblem[]): void {
  if (source === null || source === undefined) return; // optional / nullable
  if (!isPlainObject(source)) {
    out.push(problem('/source', 'type', 'source must be an object or null'));
    return;
  }
  if (!isUuid(source['source_instance_id'])) {
    out.push(problem('/source/source_instance_id', 'format', 'source_instance_id must be a uuid'));
  }
  if (!isNonEmptyString(source['external_id'])) {
    out.push(problem('/source/external_id', 'required', 'external_id is required'));
  }
  if (!isNonEmptyString(source['source_revision'])) {
    out.push(problem('/source/source_revision', 'required', 'source_revision is required'));
  }
  if (!isDateTime(source['observed_at'])) {
    out.push(problem('/source/observed_at', 'format', 'observed_at must be an rfc3339 date-time'));
  }
  const seq = source['aggregate_sequence'];
  if (seq !== undefined && seq !== null) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      out.push(
        problem(
          '/source/aggregate_sequence',
          'minimum',
          'aggregate_sequence must be an integer >= 0',
        ),
      );
    }
  }
  const ou = source['ordering_uncertain'];
  if (ou !== undefined && typeof ou !== 'boolean') {
    out.push(problem('/source/ordering_uncertain', 'type', 'ordering_uncertain must be a boolean'));
  }
}

/**
 * Validate a raw value against the versioned EventEnvelope contract.
 *
 * Additive-field handling: unknown top-level keys and unknown `data`/`extensions`
 * keys are NOT errors — under the same major they are tolerated for forward
 * compatibility. A structural violation of a *known* field is always an error.
 */
export function validateEnvelope(raw: unknown): ValidationResult {
  const problems: ValidationProblem[] = [];

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      versionCompatibility: 'incompatible',
      problems: [problem('', 'type', 'envelope must be an object')],
    };
  }

  // --- versioned: schema_version first, so an incompatible major short-circuits ---
  const compat = classifyVersion(raw['schema_version']);
  if (compat === 'incompatible') {
    problems.push(
      problem(
        '/schema_version',
        'const',
        `schema_version must be same-major as ${SUPPORTED_SCHEMA_VERSION}`,
      ),
    );
    // A cross-major envelope is not safe to interpret further; stop here.
    return { valid: false, versionCompatibility: compat, problems };
  }

  // --- required identity + correlation fields ---
  if (!isUuid(raw['event_id'])) {
    problems.push(problem('/event_id', 'format', 'event_id must be a uuid'));
  }
  if (typeof raw['event_type'] !== 'string' || !EVENT_TYPE_RE.test(raw['event_type'])) {
    problems.push(
      problem('/event_type', 'pattern', 'event_type must match ^governance\\.[a-z0-9_.-]+$'),
    );
  }
  if (!isUuid(raw['tenant_id'])) {
    problems.push(problem('/tenant_id', 'format', 'tenant_id must be a uuid'));
  }
  if (!isNonEmptyString(raw['aggregate_type'])) {
    problems.push(
      problem('/aggregate_type', 'required', 'aggregate_type must be a non-empty string'),
    );
  }
  if (!isUuid(raw['aggregate_id'])) {
    problems.push(problem('/aggregate_id', 'format', 'aggregate_id must be a uuid'));
  }
  const av = raw['aggregate_version'];
  if (typeof av !== 'number' || !Number.isInteger(av) || av < 1) {
    problems.push(
      problem('/aggregate_version', 'minimum', 'aggregate_version must be an integer >= 1'),
    );
  }
  if (!isDateTime(raw['occurred_at'])) {
    problems.push(problem('/occurred_at', 'format', 'occurred_at must be an rfc3339 date-time'));
  }
  if (!isDateTime(raw['recorded_at'])) {
    problems.push(problem('/recorded_at', 'format', 'recorded_at must be an rfc3339 date-time'));
  }
  if (!isUuid(raw['correlation_id'])) {
    problems.push(problem('/correlation_id', 'format', 'correlation_id must be a uuid'));
  }

  // --- optional-but-typed correlation lineage ---
  const causation = raw['causation_id'];
  if (causation !== undefined && causation !== null && !isUuid(causation)) {
    problems.push(problem('/causation_id', 'format', 'causation_id must be a uuid or null'));
  }

  // --- nested structures ---
  checkActor(raw['actor'], problems);
  checkPolicy(raw['policy'], problems);
  checkEvidence(raw['evidence'], problems);
  checkSource(raw['source'], problems);

  // --- reason (nullable object; when present code/text are required) ---
  const reason = raw['reason'];
  if (reason !== undefined && reason !== null) {
    if (!isPlainObject(reason)) {
      problems.push(problem('/reason', 'type', 'reason must be an object or null'));
    } else {
      if (!isNonEmptyString(reason['code'])) {
        problems.push(
          problem('/reason/code', 'required', 'reason.code must be a non-empty string'),
        );
      }
      const text = reason['text'];
      if (typeof text !== 'string' || text.length < 3 || text.length > 4000) {
        problems.push(problem('/reason/text', 'length', 'reason.text length must be 3..4000'));
      }
    }
  }

  // --- data is a required object (its inner keys are the additive payload surface) ---
  if (!isPlainObject(raw['data'])) {
    problems.push(problem('/data', 'type', 'data must be an object'));
  }
  // extensions, when present, must be an object; its keys are additive & tolerated.
  const ext = raw['extensions'];
  if (ext !== undefined && !isPlainObject(ext)) {
    problems.push(problem('/extensions', 'type', 'extensions must be an object'));
  }

  // NOTE: unknown top-level keys are intentionally NOT reported — additive
  // same-major forward compatibility. We surface them for observability instead.

  return { valid: problems.length === 0, versionCompatibility: compat, problems };
}

/** True iff `raw` is a valid, same-major-readable envelope. Narrows the type. */
export function isValidEnvelope(raw: unknown): raw is GovernanceEventsEventEnvelope {
  return validateEnvelope(raw).valid;
}

/**
 * The set of top-level keys present on the envelope that are NOT in the known
 * contract surface — the additive extension keys a same-major consumer tolerates.
 * Purely observational: callers can log/telemeter unknown fields without failing.
 */
export function additiveTopLevelKeys(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  return Object.keys(raw)
    .filter((k) => !KNOWN_ENVELOPE_KEYS.has(k))
    .sort();
}

// ===========================================================================
// 2. Aggregate ordering — dedup, monotonic version, gap/conflict/uncertain
// ===========================================================================

/**
 * The correlation key an event is ordered under: the (tenant, aggregate) pair.
 * Two events with the same key form one ordered per-aggregate stream.
 */
export function aggregateKey(env: {
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
}): string {
  return `${env.tenant_id} ${env.aggregate_type} ${env.aggregate_id}`;
}

/**
 * Total, bounded classification of an event's position in its aggregate stream.
 *
 *  - `apply`        — the expected next version (last + 1); apply and advance.
 *  - `duplicate`    — event_id already seen OR version <= last applied; a
 *                     re-delivery. Do NOT apply again (no second effect).
 *  - `out_of_order` — version > last + 1: a later event arrived before its
 *                     predecessor (delayed/out-of-order). Buffer; do not apply.
 *  - `gap`          — reconciliation view of `out_of_order`: there is a missing
 *                     predecessor version between last-applied and this event.
 *  - `conflict`     — same version as one already applied but a DIFFERENT
 *                     event_id: two events claim the same aggregate slot. Visible,
 *                     never silently overwritten; needs human/authority resolution.
 *  - `reject`       — the envelope itself is invalid (cannot be ordered).
 */
export type DeliveryDecision =
  'apply' | 'duplicate' | 'out_of_order' | 'gap' | 'conflict' | 'reject';

/** The full, structured outcome of classifying one delivery. */
export interface DeliveryClassification {
  readonly decision: DeliveryDecision;
  /** Whether re-attempting delivery of THIS message could later succeed. */
  readonly retryable: boolean;
  /** For `out_of_order`/`gap`: the first missing version the stream is waiting for. */
  readonly awaitingVersion?: number;
  /** Human-readable rationale. */
  readonly reason: string;
  /** Validation problems when `decision === 'reject'`. */
  readonly problems?: readonly ValidationProblem[];
}

/** Immutable per-aggregate ordering state (what has been durably applied). */
export interface AggregateState {
  /** Highest contiguously-applied aggregate_version (0 = nothing applied yet). */
  readonly lastAppliedVersion: number;
  /** event_id -> aggregate_version for every event this aggregate has SEEN. */
  readonly seenEventIds: ReadonlyMap<string, number>;
  /** aggregate_version -> event_id for every version already applied. */
  readonly appliedVersions: ReadonlyMap<number, string>;
}

/** A fresh, empty aggregate ordering state. */
export function emptyAggregateState(): AggregateState {
  return {
    lastAppliedVersion: 0,
    seenEventIds: new Map(),
    appliedVersions: new Map(),
  };
}

function sourceOrderingUncertain(env: GovernanceEventsEventEnvelope): boolean {
  const source: GovernanceEventsSourceReference | null | undefined = env.source;
  return source != null && source.ordering_uncertain === true;
}

/**
 * Classify how `env` relates to `state` WITHOUT mutating `state`. Pure: the same
 * (state, env) always yields the same decision, so the outcome is reconstructable
 * and safe to evaluate repeatedly (idempotent classification).
 */
export function classifyDelivery(state: AggregateState, env: unknown): DeliveryClassification {
  const validation = validateEnvelope(env);
  if (!validation.valid) {
    return {
      decision: 'reject',
      retryable: false, // a malformed/partial message will not become valid on retry
      reason: 'envelope failed contract validation',
      problems: validation.problems,
    };
  }
  const e = env as GovernanceEventsEventEnvelope;

  // Deduplicate by event_id first: an exact re-delivery is a duplicate regardless
  // of version bookkeeping — this is the "safe under duplicate" guarantee.
  if (state.seenEventIds.has(e.event_id)) {
    return {
      decision: 'duplicate',
      retryable: false,
      reason: `event_id ${e.event_id} already seen`,
    };
  }

  const version = e.aggregate_version;
  const expected = state.lastAppliedVersion + 1;

  // Conflict: a DIFFERENT event already occupies this aggregate slot.
  const occupant = state.appliedVersions.get(version);
  if (occupant !== undefined && occupant !== e.event_id) {
    return {
      decision: 'conflict',
      retryable: false,
      reason: `aggregate_version ${version} already applied by a different event (${occupant})`,
    };
  }

  // Replay of an already-applied (<= last) version with a new event id that is not
  // an occupant conflict: treat as duplicate — no regression, no second effect.
  if (version <= state.lastAppliedVersion) {
    return {
      decision: 'duplicate',
      retryable: false,
      reason: `aggregate_version ${version} <= last applied ${state.lastAppliedVersion}; no regression`,
    };
  }

  if (version === expected) {
    return { decision: 'apply', retryable: false, reason: `next version ${version}` };
  }

  // version > expected: predecessors are missing. Delayed / out-of-order arrival.
  // Under source ordering uncertainty we still refuse to apply out of order — we
  // report the gap rather than silently accept an unconfirmed ordering.
  const uncertain = sourceOrderingUncertain(e);
  return {
    decision: uncertain ? 'gap' : 'out_of_order',
    retryable: true, // the missing predecessor may still arrive; safe to await/retry
    awaitingVersion: expected,
    reason: uncertain
      ? `source ordering uncertain; awaiting version ${expected} before ${version}`
      : `version ${version} arrived before expected ${expected}; buffering`,
  };
}

/**
 * Apply `env` to `state`, returning the NEW state and the decision. Only an
 * `apply` decision advances `lastAppliedVersion`; every other decision returns a
 * state that still RECORDS the event as seen (so a later exact re-delivery is
 * recognised as a duplicate) but does not advance applied history. The input
 * state is never mutated (immutable, reconcilable, safe to replay).
 */
export function applyDelivery(
  state: AggregateState,
  env: unknown,
): { readonly state: AggregateState; readonly classification: DeliveryClassification } {
  const classification = classifyDelivery(state, env);

  // A rejected (invalid) envelope never touches state.
  if (classification.decision === 'reject') {
    return { state, classification };
  }

  const e = env as GovernanceEventsEventEnvelope;

  // A duplicate (already-seen event id, or replayed version) leaves state as-is.
  if (classification.decision === 'duplicate') {
    return { state, classification };
  }

  // Record the event as seen for every non-duplicate, non-reject outcome so that
  // an exact re-delivery is later deduplicated even if it did not apply now.
  const seenEventIds = new Map(state.seenEventIds);
  seenEventIds.set(e.event_id, e.aggregate_version);

  if (classification.decision === 'apply') {
    const appliedVersions = new Map(state.appliedVersions);
    appliedVersions.set(e.aggregate_version, e.event_id);
    return {
      state: {
        lastAppliedVersion: e.aggregate_version,
        seenEventIds,
        appliedVersions,
      },
      classification,
    };
  }

  // out_of_order / gap / conflict: seen-recorded, but applied history unchanged.
  return {
    state: {
      lastAppliedVersion: state.lastAppliedVersion,
      seenEventIds,
      appliedVersions: state.appliedVersions,
    },
    classification,
  };
}

/**
 * Reconciliation view: the contiguous versions still missing between the last
 * applied version and the highest version SEEN. An empty array means the applied
 * history is contiguous (no gaps). This makes ingest history reconstructable.
 */
export function missingVersions(state: AggregateState): number[] {
  let highestSeen = state.lastAppliedVersion;
  for (const v of state.appliedVersions.keys()) if (v > highestSeen) highestSeen = v;
  for (const v of state.seenEventIds.values()) if (v > highestSeen) highestSeen = v;
  const missing: number[] = [];
  for (let v = state.lastAppliedVersion + 1; v < highestSeen; v++) {
    if (!state.appliedVersions.has(v)) missing.push(v);
  }
  return missing;
}

/**
 * Fold a batch of deliveries (in arrival order) through the ordering tracker,
 * returning the final state and each per-event decision. Callers use this to
 * reconcile a re-delivered / out-of-order / duplicated batch into a single,
 * deterministic outcome with no duplicate effects.
 */
export function reconcileBatch(
  initial: AggregateState,
  envs: readonly unknown[],
): { readonly state: AggregateState; readonly decisions: readonly DeliveryClassification[] } {
  let state = initial;
  const decisions: DeliveryClassification[] = [];
  for (const env of envs) {
    const step = applyDelivery(state, env);
    state = step.state;
    decisions.push(step.classification);
  }
  return { state, decisions };
}
