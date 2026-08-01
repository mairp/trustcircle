// @trustcircle/domain — field-level source authority, confidence, precedence, and
// unresolved-correlation rules (Phase 64, bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// This module is the pure, dependency-free (node:crypto only) CORRELATION ENGINE that sits on
// top of the Phase-63 inventory value model (`./inventory.ts`). Where `inventory.ts` records
// each source's RAW observation (`SourceRecord`) and holds an unresolved conflict as a
// `CorrelationCase`, this module answers the harder question the governance view actually asks:
//
//   Given N distinct source records that all describe the same governed asset, WHICH source is
//   authoritative for EACH field, with what confidence, and — critically — WHEN can authority
//   rules NOT safely resolve a field, so the conflict must stay visible, affected automation must
//   pause, and an owned correlation case must be opened for a human?
//
// The engine is deliberately CONSERVATIVE: it only declares a field resolved when a single source
// clearly out-ranks the rest AND its observation is fresh enough to be trusted. Any tie in
// authority between disagreeing sources, or a would-be winner that is stale/low-confidence with no
// fresh higher-authority backup, yields an UNRESOLVED field — never a guessed value. This is the
// value-level embodiment of the safety rule "never infer current compliance/health from stale
// data, and never silently pick a side in a conflict."
//
// Acceptance-criterion map (each backed by an asserting rule here + a test in
// tests/unit/correlation.unit.test.ts, every rule paired with a non-vacuous negative control):
//   AC1 healthy connected sources → correlateAsset renders the asset ONCE (one CorrelatedItem
//       keyed by (tenant, assetId)) carrying its type/owner/lifecycle/risk/coverage/evidence/
//       health/last-observation/unresolved-issues facets, each field's authoritative value chosen
//       by resolveField.
//   AC2 a discovered-but-unmanaged/unreachable/stale/orphaned/excluded component still surfaces:
//       correlateAsset keeps every contributing source record visible via `sourceRecords` and
//       flags coverage/health from the OBSERVED field, never hiding a gap.
//   AC3 related work across Kanban/agentctl/workflows_orchestration → `sourceRecords` preserves
//       every DISTINCT source record + per-field `differingSources` (status differences) +
//       `authoritativeField` attribution; nothing is collapsed.
//   AC4 a stale/unavailable source → resolveField refuses to let a STALE observation win over a
//       fresh one, tags each resolution with `asOf` (last-known time) + `confidence`, and marks a
//       field `stale` when its winning observation is not fresh; current health is not inferred.
//   AC5/AC6 unregistered / unsupported / inaccessible / sensitive / unowned sources: the authority
//       policy assigns them LOW or ZERO field authority so they never silently become the
//       authoritative value; `FieldResolution.contributingSources` still lists them so they stay
//       visible for the catalog/gap surface.
//
// Unresolved-correlation rule (the heart of the phase): `resolveField` returns
// `resolution: 'unresolved'` — and `correlateAsset` opens a `CorrelationCase` (via `openCase`) and
// sets `automationPaused: true` — whenever authority rules CANNOT determine a single safe value:
//   * AUTHORITY TIE: two+ sources of EQUAL top authority report DIFFERENT values.
//   * NO TRUSTWORTHY WINNER: the only candidates for the field are stale/unknown-freshness or
//     below the confidence floor, so no fresh authoritative value exists.
//   * ZERO AUTHORITY: every candidate source has zero authority for the field.
// A resolved field, by contrast, requires a UNIQUE strictly-top-authority source whose observation
// clears the freshness+confidence bar. This asymmetry is what makes the engine fail-visible.

import { createHash } from 'node:crypto';
import {
  isUuid,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
} from './primitives.ts';
import {
  type SourceRecord,
  type FreshnessState,
  makeCorrelationCase,
  type CorrelationCase,
  type CorrelationCaseType,
  type GovernedAsset,
  type CoverageGap,
  type InventoryRelationship,
  type SourceCatalogEntry,
  type AssetLifecycleState,
  type AssetHealthState,
  type CoverageState,
  type RiskTier,
  type GapReason,
  type GapImpact,
  type OnboardingState,
  type AccessState,
  type CatalogSensitivity,
  UNKNOWN_SOURCE_CLASS,
  gapAgeMillis,
  gapIsVisible,
  gapHasReviewOrExpiry,
} from './inventory.ts';

// ===========================================================================
// 0. Shared helpers (mirrors the guard style of inventory.ts so both modules assert identically).
// ===========================================================================

function assertEpoch(ms: unknown, label: string): asserts ms is EpochMillis {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${String(ms)}`);
  }
}

function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertTenant(t: unknown, label: string): asserts t is TenantId {
  if (t !== PLATFORM_SCOPE && !isUuid(t)) {
    throw new TypeError(`${label} must be a tenant UUID or the platform scope`);
  }
}

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}

function assertUnitInterval(n: unknown, label: string): asserts n is number {
  if (typeof n !== 'number' || Number.isNaN(n) || n < 0 || n > 1) {
    throw new RangeError(`${label} must be a number in [0,1], got ${String(n)}`);
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** Drop keys whose value is `undefined` (required under `exactOptionalPropertyTypes: true`) and
 * freeze, matching inventory.ts `compact`. */
function compact<T extends object>(obj: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return Object.freeze(out) as T;
}

/** Stable, order-independent value equality for observed field values (JSON-shaped). Two records
 * that report the same field value must compare equal regardless of key order so an "agreement"
 * is not spuriously read as a "conflict". */
export function fieldValuesEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(v: unknown): string {
  if (v === undefined) return 'null'; // treat undefined and null alike for value comparison
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalize(val)}`).join(',')}}`;
}

// ===========================================================================
// 1. Freshness trust — the fresh > unknown > stale ordering used by every rule.
//    A stale observation can NEVER outrank a fresh one for authority purposes (AC4).
// ===========================================================================

const FRESHNESS_TRUST: Readonly<Record<FreshnessState, number>> = Object.freeze({
  fresh: 2,
  unknown: 1,
  stale: 0,
});

/** True iff the observation is fresh enough that its value may be treated as CURRENT. Any non-fresh
 * observation (stale/unknown) is "suspect" and must not be silently used as current health (AC4). */
export function observationIsCurrent(r: SourceRecord): boolean {
  return r.freshness === 'fresh';
}

// ===========================================================================
// 2. Source authority policy — per source-class, per-field PRECEDENCE.
//    Authority is a non-negative integer rank: higher wins. `0` means the class carries NO
//    authority for that field (its observation is displayed but never chosen as authoritative —
//    the AC5/AC6 treatment for unsupported/unowned/sensitive/unknown sources).
// ===========================================================================

/** A field's authority ranking is a total function class → rank. `defaultAuthority` applies to any
 * class not explicitly listed (so an UNKNOWN/unregistered class is handled — AC5). */
export interface FieldAuthorityRule {
  readonly field: string;
  /** class → authority rank (higher wins; 0 = no authority for this field). */
  readonly byClass: Readonly<Record<string, number>>;
  readonly defaultAuthority: number;
}

export interface SourceAuthorityPolicy {
  readonly id: string;
  readonly version: number;
  readonly rules: readonly FieldAuthorityRule[];
  /** Applied to any field with no explicit rule. */
  readonly defaultFieldAuthority: number;
  /** A resolution's winning observation must clear this confidence floor to be RESOLVED; below it,
   * the field is unresolved rather than guessed. */
  readonly confidenceFloor: number;
}

export function makeFieldAuthorityRule(input: {
  field: string;
  byClass?: Record<string, number>;
  defaultAuthority?: number;
}): FieldAuthorityRule {
  assertNonEmpty(input.field, 'rule.field');
  const byClass = input.byClass ?? {};
  const out: Record<string, number> = {};
  for (const [cls, rank] of Object.entries(byClass)) {
    assertNonEmpty(cls, 'rule.byClass key');
    if (!Number.isInteger(rank) || rank < 0) {
      throw new RangeError(`rule.byClass['${cls}'] must be a non-negative integer rank`);
    }
    out[cls] = rank;
  }
  const defaultAuthority = input.defaultAuthority ?? 0;
  if (!Number.isInteger(defaultAuthority) || defaultAuthority < 0) {
    throw new RangeError('rule.defaultAuthority must be a non-negative integer');
  }
  return compact({
    field: input.field.trim(),
    byClass: Object.freeze(out),
    defaultAuthority,
  });
}

export function makeSourceAuthorityPolicy(input: {
  id: string;
  version?: number;
  rules?: readonly FieldAuthorityRule[];
  defaultFieldAuthority?: number;
  confidenceFloor?: number;
}): SourceAuthorityPolicy {
  assertNonEmpty(input.id, 'policy.id');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError('policy.version must be ≥ 1');
  }
  const rules = input.rules ?? [];
  if (!Array.isArray(rules)) throw new TypeError('policy.rules must be an array');
  const seen = new Set<string>();
  for (const r of rules) {
    assertNonEmpty(r.field, 'policy.rules[].field');
    if (seen.has(r.field)) {
      throw new RangeError(`policy has duplicate rule for field '${r.field}'`);
    }
    seen.add(r.field);
  }
  const defaultFieldAuthority = input.defaultFieldAuthority ?? 0;
  if (!Number.isInteger(defaultFieldAuthority) || defaultFieldAuthority < 0) {
    throw new RangeError('policy.defaultFieldAuthority must be a non-negative integer');
  }
  const confidenceFloor = input.confidenceFloor ?? 0.5;
  assertUnitInterval(confidenceFloor, 'policy.confidenceFloor');
  return compact({
    id: input.id.trim(),
    version,
    rules: Object.freeze([...rules]),
    defaultFieldAuthority,
    confidenceFloor,
  });
}

/** The authority rank a policy assigns to `sourceClass` for `field`. Total: falls back to the
 * field rule's default, then the policy default, so an UNKNOWN/unregistered class always resolves
 * to a concrete (typically 0) rank (AC5). */
export function authorityFor(
  policy: SourceAuthorityPolicy,
  field: string,
  sourceClass: string,
): number {
  const rule = policy.rules.find((r) => r.field === field);
  if (rule) {
    if (Object.prototype.hasOwnProperty.call(rule.byClass, sourceClass)) {
      return rule.byClass[sourceClass] as number;
    }
    return rule.defaultAuthority;
  }
  return policy.defaultFieldAuthority;
}

export function sourceAuthorityPolicyDigest(p: SourceAuthorityPolicy): string {
  return sha256(
    JSON.stringify({
      id: p.id,
      version: p.version,
      defaultFieldAuthority: p.defaultFieldAuthority,
      confidenceFloor: p.confidenceFloor,
      rules: [...p.rules]
        .sort((a, b) => (a.field < b.field ? -1 : 1))
        .map((r) => ({
          field: r.field,
          defaultAuthority: r.defaultAuthority,
          byClass: Object.fromEntries(
            Object.entries(r.byClass).sort(([x], [y]) => (x < y ? -1 : 1)),
          ),
        })),
    }),
  );
}

// ===========================================================================
// 3. Field-level resolution — the core precedence + confidence + freshness rule.
//    Produces a FieldResolution: either a single authoritative value with its source, confidence,
//    and as-of time, OR `resolution: 'unresolved'` when authority rules cannot safely decide.
// ===========================================================================

export const FIELD_RESOLUTIONS = ['resolved', 'unresolved'] as const;
export type FieldResolutionStatus = (typeof FIELD_RESOLUTIONS)[number];

/** Why a field could not be resolved — pins the exact unresolved-correlation rule that fired so an
 * opened correlation case can name it (AC3, and the "conflict remains visible" safety rule). */
export const UNRESOLVED_REASONS = [
  'authority_tie', // two+ equal-top-authority sources disagree
  'no_trustworthy_winner', // the would-be winner is stale/low-confidence with no fresh backup
  'zero_authority', // no candidate source carries any authority for the field
  'no_candidates', // the field was not observed by any source
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/** One source's contribution to a single field: which source (record) reported it, that source's
 * authority for the field, the raw observed value, and the observation's freshness/confidence/
 * as-of. Every contributing source is retained so distinct source records stay visible (AC3). */
export interface FieldCandidate {
  readonly recordId: Uuid;
  readonly sourceClass: string;
  readonly externalKey: string;
  readonly authority: number;
  readonly value: unknown;
  readonly freshness: FreshnessState;
  readonly confidence: number;
  readonly asOf: EpochMillis;
}

export interface FieldResolution {
  readonly field: string;
  readonly resolution: FieldResolutionStatus;
  /** Present iff resolved: the chosen authoritative value. */
  readonly value?: unknown;
  /** Present iff resolved: the record whose value won. */
  readonly authoritativeRecordId?: Uuid;
  readonly authoritativeSourceClass?: string;
  /** Present iff resolved: confidence of the winning observation. */
  readonly confidence?: number;
  /** Present iff resolved: last-known time of the winning observation (AC4 "as-of"). */
  readonly asOf?: EpochMillis;
  /** Present iff resolved and the winning observation is NOT fresh — the value is shown with its
   * as-of time and MUST NOT be read as current health (AC4). */
  readonly stale?: boolean;
  /** Present iff unresolved: which rule fired. */
  readonly unresolvedReason?: UnresolvedReason;
  /** True iff two+ contributing sources reported DIFFERENT values (status difference; AC3). Set
   * whether or not the field ultimately resolved. */
  readonly contested: boolean;
  /** Every source that reported this field, in descending authority then descending freshness. */
  readonly contributingSources: readonly FieldCandidate[];
  /** The subset of contributing sources whose value differs from the resolved value (or, when
   * unresolved, all distinct-valued sources). Drives the "status differences" display (AC3). */
  readonly differingSources: readonly FieldCandidate[];
}

/** Extract a field candidate from a source record if it observed the field. A record observes a
 * field when its `observedState` has that key (an explicit `undefined`/absent key ⇒ no candidate).
 * The candidate's authority comes from the policy; freshness/confidence/as-of from the record. */
function candidateFor(
  policy: SourceAuthorityPolicy,
  field: string,
  r: SourceRecord,
): FieldCandidate | undefined {
  if (!Object.prototype.hasOwnProperty.call(r.observedState, field)) return undefined;
  const value = (r.observedState as Record<string, unknown>)[field];
  if (value === undefined) return undefined;
  return compact({
    recordId: r.id,
    sourceClass: r.sourceClass,
    externalKey: r.externalKey,
    authority: authorityFor(policy, field, r.sourceClass),
    value,
    freshness: r.freshness,
    confidence: r.confidence,
    asOf: r.lastKnownAt,
  });
}

function orderCandidates(a: FieldCandidate, b: FieldCandidate): number {
  // Descending authority, then descending freshness trust, then descending confidence, then
  // descending as-of (newest first). Deterministic and total.
  if (a.authority !== b.authority) return b.authority - a.authority;
  const fa = FRESHNESS_TRUST[a.freshness];
  const fb = FRESHNESS_TRUST[b.freshness];
  if (fa !== fb) return fb - fa;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.asOf !== b.asOf) return b.asOf - a.asOf;
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/**
 * Resolve ONE field across a set of source records for a single asset, under the authority policy.
 *
 * Resolution rule (fail-visible, asymmetric):
 *  - Gather every source that observed the field (candidates). No candidates ⇒ unresolved
 *    ('no_candidates').
 *  - If the maximum authority among candidates is 0 ⇒ unresolved ('zero_authority'): no source may
 *    speak authoritatively for the field.
 *  - Among the top-authority sources, if any two report DIFFERENT values ⇒ unresolved
 *    ('authority_tie'): the conflict must stay visible for a human, never auto-picked.
 *  - Otherwise a single value is agreed by the top-authority tier. The winning observation is the
 *    most-trustworthy top-authority candidate (freshest, then highest confidence). If that winner
 *    is NOT fresh OR its confidence is below the policy floor, and no fresh top-authority candidate
 *    exists ⇒ unresolved ('no_trustworthy_winner'): current state must not be inferred from stale/
 *    low-confidence data (AC4).
 *  - Else RESOLVED: the value, its authoritative source, confidence, as-of time, and a `stale` flag
 *    when the winning observation is not fresh.
 */
export function resolveField(
  policy: SourceAuthorityPolicy,
  field: string,
  records: readonly SourceRecord[],
): FieldResolution {
  assertNonEmpty(field, 'resolveField.field');
  if (!Array.isArray(records)) throw new TypeError('resolveField.records must be an array');

  const candidates: FieldCandidate[] = [];
  for (const r of records) {
    const c = candidateFor(policy, field, r);
    if (c) candidates.push(c);
  }
  candidates.sort(orderCandidates);
  const contributingSources = Object.freeze(candidates.slice());

  // Distinct values across ALL candidates → whether the field is contested at all (status diff).
  const distinctValues = dedupeValues(candidates.map((c) => c.value));
  const contested = distinctValues.length > 1;

  const unresolved = (
    reason: UnresolvedReason,
    differing: readonly FieldCandidate[],
  ): FieldResolution =>
    compact({
      field,
      resolution: 'unresolved' as const,
      unresolvedReason: reason,
      contested,
      contributingSources,
      differingSources: Object.freeze([...differing]),
    });

  if (candidates.length === 0) {
    return unresolved('no_candidates', []);
  }

  const topAuthority = candidates[0]!.authority;
  if (topAuthority === 0) {
    // No source carries any authority for the field — nothing may be chosen (AC5/AC6).
    return unresolved('zero_authority', contested ? distinctCandidates(candidates) : []);
  }

  const topTier = candidates.filter((c) => c.authority === topAuthority);
  const topDistinct = dedupeValues(topTier.map((c) => c.value));
  if (topDistinct.length > 1) {
    // AUTHORITY TIE: equal-top-authority sources disagree. Keep the conflict visible for a human.
    return unresolved('authority_tie', distinctCandidates(topTier));
  }

  // The top tier agrees on a single value. Choose the most-trustworthy witness of it.
  const winner = topTier[0]!; // already ordered: freshest, then highest confidence
  const winnerIsFresh = winner.freshness === 'fresh';
  const winnerClearsFloor = winner.confidence >= policy.confidenceFloor;

  if (!winnerIsFresh || !winnerClearsFloor) {
    // No trustworthy witness: the only support for the (agreed) value is stale or low-confidence.
    // Do NOT infer a current value from it (AC4).
    return unresolved('no_trustworthy_winner', topTier);
  }

  const differingSources = Object.freeze(
    candidates.filter((c) => !fieldValuesEqual(c.value, winner.value)),
  );

  return compact({
    field,
    resolution: 'resolved' as const,
    value: winner.value,
    authoritativeRecordId: winner.recordId,
    authoritativeSourceClass: winner.sourceClass,
    confidence: winner.confidence,
    asOf: winner.asOf,
    stale: winner.freshness !== 'fresh' ? true : undefined,
    contested,
    contributingSources,
    differingSources,
  });
}

function dedupeValues(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    const key = canonicalize(v);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/** One representative candidate per distinct value (for `differingSources` on conflicts). */
function distinctCandidates(cands: readonly FieldCandidate[]): FieldCandidate[] {
  const seen = new Set<string>();
  const out: FieldCandidate[] = [];
  for (const c of cands) {
    const key = canonicalize(c.value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export function isResolved(r: FieldResolution): boolean {
  return r.resolution === 'resolved';
}

// ===========================================================================
// 4. Correlated item — assemble many source records for ONE asset into a single view (AC1/AC2/AC3).
//    The asset appears ONCE; every contributing source record stays visible; each governed field
//    carries its authoritative value or its unresolved conflict; automation pauses if any field is
//    unresolved.
// ===========================================================================

/** The evidence state of a correlated item — whether its governed fields are backed by CURRENT
 * (fresh) authoritative observations, only STALE ones, or are MISSING entirely (AC1 "evidence
 * state", AC4 "current health not inferred from stale data"). Derived, never asserted by a source:
 *  - `current`    — every requested field resolved AND its winning observation is fresh.
 *  - `stale`      — every requested field resolved but at least one winner is stale (shown with its
 *                   as-of time; MUST NOT be read as current health).
 *  - `incomplete` — at least one requested field is unresolved (a gap remains). */
export const EVIDENCE_STATES = ['current', 'stale', 'incomplete'] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/** The AC1 enumerated FACET SET the governance view renders for each correlated item, composed from
 * the Phase-63 `GovernedAsset` value model. Every facet the acceptance criterion enumerates —
 * type, source identity, owner, lifecycle state, risk, control coverage, evidence state, health,
 * last observation time, and unresolved issues — is a named field here so a green test can witness
 * each one individually (not a generic status blob). */
export interface CorrelatedItemFacets {
  /** AC1 "type": the asset's governed type classification. */
  readonly assetType: string;
  readonly name: string;
  /** AC1 "owner": the accountable owner principal, or `undefined` when ownership is itself a gap. */
  readonly ownerPrincipalId?: Uuid;
  /** AC1 "owner": true iff the item has an unresolved OWNERSHIP gap (no owner). */
  readonly ownershipGap: boolean;
  /** AC1 "lifecycle state". */
  readonly lifecycleState: AssetLifecycleState;
  /** AC1 "risk". */
  readonly riskTier: RiskTier;
  /** AC1 "control coverage". */
  readonly coverage: CoverageState;
  /** AC1 "health". Derived-current health is NEVER inferred from stale evidence (AC4): when the
   * evidence is stale/incomplete the asset's own health facet is surfaced verbatim, but the item's
   * `evidenceState` marks it non-current so a consumer cannot read stale data as current health. */
  readonly health: AssetHealthState;
  /** AC1 "evidence state" — see {@link EvidenceState}. */
  readonly evidenceState: EvidenceState;
  /** AC1 "last observation time" — the newest last-known time across contributing source records,
   * or the asset's recorded `lastObservedAt`, or `undefined` when never observed. */
  readonly lastObservationAt?: EpochMillis;
  /** AC1 "unresolved issues" — the count of open correlation cases (mirrors `openCases`). */
  readonly unresolvedIssueCount: number;
}

/** An AC2/AC6 coverage-gap view element: a discovered-but-ungoverned subject that STAYS VISIBLE with
 * its reason, AGE, impact, required owner action, and (for AC6 governed-source gaps) a review or
 * expiry deadline. Composed from the Phase-63 `CoverageGap` value model. */
export interface CoverageGapView {
  readonly gapId: Uuid;
  /** 'component' (AC2) or 'governed_source' (AC6). */
  readonly gapClass: CoverageGap['gapClass'];
  readonly reason: GapReason;
  readonly impact: GapImpact;
  /** AC2/AC6 "age" — milliseconds since the gap was first seen, relative to `correlatedAt`. */
  readonly ageMillis: number;
  readonly requiredAction: string;
  readonly requiredOwner?: Uuid;
  /** AC6 "review or expiry" — present iff a governed-source gap carries a deadline. */
  readonly reviewAt?: EpochMillis;
  readonly expiresAt?: EpochMillis;
  readonly gap: CoverageGap;
}

/** An AC3 DEPENDENCY edge across the correlated item's source records / assets, composed from the
 * Phase-63 `InventoryRelationship` value model (`depends_on`). */
export interface DependencyView {
  readonly relationshipId: Uuid;
  readonly fromId: Uuid;
  readonly toId: Uuid;
  readonly fieldName: string;
}

/** An AC3 AUTHORITATIVE-FIELD attribution edge (`authoritative_for`) — which source is the system of
 * record for a named field, composed from `InventoryRelationship`. */
export interface AuthoritativeFieldView {
  readonly relationshipId: Uuid;
  readonly field: string;
  readonly authoritativeSourceId: Uuid;
}

/** The AC5 SOURCE-CATALOG membership view for a discovered source: its type/unknown classification,
 * observed location, access status, sensitivity, ownership status, onboarding state, and discovery
 * evidence. Composed from the Phase-63 `SourceCatalogEntry` value model. */
export interface CatalogEntryView {
  readonly catalogId: Uuid;
  /** AC5 "type/unknown classification" — the pinned `'unknown'` sentinel or a concrete class. */
  readonly sourceClass: string;
  readonly classifiedUnknown: boolean;
  /** AC5 "location". */
  readonly observedLocations: readonly string[];
  /** AC5 "access status". */
  readonly accessState: AccessState;
  /** AC5 "sensitivity". */
  readonly sensitivity: CatalogSensitivity;
  /** AC5 "ownership status" — the owner principal, plus a derived ownership-gap flag. */
  readonly ownerPrincipalId?: Uuid;
  readonly ownershipGap: boolean;
  /** AC5 "onboarding state". */
  readonly onboardingState: OnboardingState;
  /** AC5 "discovery evidence" — the discovery-evidence reference, or `undefined`. */
  readonly discoveryEvidence?: Uuid;
  readonly entry: SourceCatalogEntry;
}

export interface CorrelatedItem {
  readonly tenantId: TenantId;
  readonly assetId: Uuid;
  /** Every distinct source record that contributed, retained verbatim (AC2/AC3). */
  readonly sourceRecords: readonly SourceRecord[];
  /** Per governed field, its resolution (authoritative value or unresolved conflict). Keyed by
   * field name; a stable ordered list is exposed via `fields`. */
  readonly fields: readonly FieldResolution[];
  /** The correlation cases opened for every unresolved field (AC3 + safety rule). */
  readonly openCases: readonly CorrelationCase[];
  /** True iff ANY governed field is unresolved — affected automation must PAUSE safely. */
  readonly automationPaused: boolean;
  /** AC1 enumerated facet set (type/owner/lifecycle/risk/coverage/evidence/health/last-observation/
   * unresolved-issues), present iff a governing `GovernedAsset` was supplied. */
  readonly facets?: CorrelatedItemFacets;
  /** AC2/AC6 coverage-gap surface: discovered-but-ungoverned subjects that stay VISIBLE with
   * reason/age/impact/owner-action (and, for governed-source gaps, review/expiry). */
  readonly coverageGaps: readonly CoverageGapView[];
  /** AC3 dependency edges across the correlated sources (`depends_on`). */
  readonly dependencies: readonly DependencyView[];
  /** AC3 authoritative-field attributions (`authoritative_for`). */
  readonly authoritativeFields: readonly AuthoritativeFieldView[];
  /** AC5 source-catalog membership views for the contributing sources. */
  readonly catalogEntries: readonly CatalogEntryView[];
  readonly correlatedAt: EpochMillis;
}

const UNRESOLVED_TO_CASE_TYPE: Readonly<Record<UnresolvedReason, CorrelationCaseType>> =
  Object.freeze({
    authority_tie: 'field_conflict',
    no_trustworthy_winner: 'field_conflict',
    zero_authority: 'ambiguous_match',
    no_candidates: 'unlinked',
  });

/** Build the human-owned correlation case for an unresolved field. Produces a real
 * `CorrelationCase` (inventory.ts) with `status: 'open'`, a required human action, and the raw
 * conflicting observations — so the conflict is durably held for resolution, not dropped. */
export function openCase(input: {
  id: Uuid;
  tenantId: TenantId;
  assetId: Uuid;
  field: string;
  resolution: FieldResolution;
  openedAt: EpochMillis;
}): CorrelationCase {
  assertUuid(input.id, 'openCase.id');
  assertTenant(input.tenantId, 'openCase.tenantId');
  assertUuid(input.assetId, 'openCase.assetId');
  assertNonEmpty(input.field, 'openCase.field');
  assertEpoch(input.openedAt, 'openCase.openedAt');
  if (input.resolution.resolution !== 'unresolved') {
    throw new RangeError('openCase requires an UNRESOLVED field resolution');
  }
  const reason = input.resolution.unresolvedReason ?? 'no_candidates';
  const caseType = UNRESOLVED_TO_CASE_TYPE[reason];
  const conflicting = input.resolution.differingSources.map((c) => ({
    recordId: c.recordId,
    sourceClass: c.sourceClass,
    externalKey: c.externalKey,
    authority: c.authority,
    value: c.value,
    freshness: c.freshness,
    confidence: c.confidence,
    asOf: c.asOf,
  }));
  return makeCorrelationCase({
    id: input.id,
    tenantId: input.tenantId,
    assetId: input.assetId,
    caseType,
    status: 'open',
    conflicting,
    requiredAction:
      `Human resolution required for field '${input.field}' (${reason}): authority rules could ` +
      'not determine a single safe value; affected automation is paused until an owner resolves ' +
      'the conflict.',
    openedAt: input.openedAt,
  });
}

/** A deterministic case-id factory: callers that lack a UUIDv7 clock can derive a stable id for an
 * (asset, field) unresolved conflict so re-correlating the same conflict does not fork identities.
 * The digest is namespaced and mapped into the UUID shape; it is stable across runs. */
export function deriveCaseId(tenantId: TenantId, assetId: Uuid, field: string): Uuid {
  const h = sha256(`corr-case|${tenantId}|${assetId}|${field}`);
  // Shape the first 32 hex chars into a canonical UUID string (version nibble forced to 8 → a
  // valid, non-v1..7 identifier; deterministic, collision-resistant for our namespace).
  const s = h.slice(0, 32);
  const uuid =
    `${s.slice(0, 8)}-${s.slice(8, 12)}-8${s.slice(13, 16)}-` +
    `${((parseInt(s[16]!, 16) & 0x3) | 0x8).toString(16)}${s.slice(17, 20)}-${s.slice(20, 32)}`;
  return uuid as Uuid;
}

/**
 * Correlate every source record describing ONE asset into a single `CorrelatedItem`.
 *
 * - The asset is rendered ONCE, keyed by (tenant, assetId) (AC1).
 * - Every distinct source record is retained in `sourceRecords` (AC2/AC3) — nothing collapses.
 * - Each requested governed field is resolved by `resolveField`; a resolved field carries its
 *   authoritative value + as-of + confidence, an unresolved field carries its conflict.
 * - For every UNRESOLVED field a `CorrelationCase` is opened (deterministic id) and
 *   `automationPaused` is set — the conflict stays visible, automation pauses, an owned issue is
 *   opened for a human (AC3 + safety rule).
 *
 * All input records must share the given tenant and asset; a mismatched record is rejected so an
 * asset can never be correlated from another tenant's/asset's observations.
 */
export function correlateAsset(input: {
  tenantId: TenantId;
  assetId: Uuid;
  policy: SourceAuthorityPolicy;
  fields: readonly string[];
  records: readonly SourceRecord[];
  correlatedAt: EpochMillis;
  /** AC1: the governing asset whose enumerated facets (type/owner/lifecycle/risk/coverage/health/
   * last-observation) are surfaced on the correlated item. Optional — omitting it yields an item
   * with no `facets` block (the raw-resolution view). When supplied it MUST match the correlation
   * scope (same tenant + asset id) or the call is rejected. */
  asset?: GovernedAsset;
  /** AC2/AC6: coverage gaps (component + governed-source) that must stay visible for this item. */
  coverageGaps?: readonly CoverageGap[];
  /** AC3: inventory relationships (depends_on / authoritative_for) among this item's sources. */
  relationships?: readonly InventoryRelationship[];
  /** AC5: source-catalog entries for the contributing sources (discovery/onboarding surface). */
  catalogEntries?: readonly SourceCatalogEntry[];
}): CorrelatedItem {
  assertTenant(input.tenantId, 'correlateAsset.tenantId');
  assertUuid(input.assetId, 'correlateAsset.assetId');
  if (!Array.isArray(input.fields)) throw new TypeError('correlateAsset.fields must be an array');
  for (const f of input.fields) assertNonEmpty(f, 'correlateAsset.fields entry');
  if (!Array.isArray(input.records)) throw new TypeError('correlateAsset.records must be an array');
  assertEpoch(input.correlatedAt, 'correlateAsset.correlatedAt');

  // Tenant + asset scoping — never correlate across tenants/assets.
  for (const r of input.records) {
    if (r.tenantId !== input.tenantId) {
      throw new RangeError(
        `correlateAsset: record ${r.id} belongs to a different tenant than the correlation scope`,
      );
    }
    if (r.assetId !== undefined && r.assetId !== input.assetId) {
      throw new RangeError(
        `correlateAsset: record ${r.id} is linked to a different asset than the correlation scope`,
      );
    }
  }

  // Distinct records preserved by identity — duplicates (same id) collapse; distinct sources stay.
  const seenIds = new Set<string>();
  const sourceRecords: SourceRecord[] = [];
  for (const r of input.records) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      sourceRecords.push(r);
    }
  }

  const fields: FieldResolution[] = [];
  const openCases: CorrelationCase[] = [];
  let automationPaused = false;

  for (const field of input.fields) {
    const res = resolveField(input.policy, field, sourceRecords);
    fields.push(res);
    if (res.resolution === 'unresolved') {
      automationPaused = true;
      openCases.push(
        openCase({
          id: deriveCaseId(input.tenantId, input.assetId, field),
          tenantId: input.tenantId,
          assetId: input.assetId,
          field,
          resolution: res,
          openedAt: input.correlatedAt,
        }),
      );
    }
  }

  // ---- AC1 facets: bind the governing asset (validated against the correlation scope). ----
  let facets: CorrelatedItemFacets | undefined;
  if (input.asset !== undefined) {
    const a = input.asset;
    if (a.tenantId !== input.tenantId) {
      throw new RangeError(
        `correlateAsset: asset ${a.id} belongs to a different tenant than the correlation scope`,
      );
    }
    if (a.id !== input.assetId) {
      throw new RangeError(
        `correlateAsset: asset ${a.id} is not the asset being correlated (${input.assetId})`,
      );
    }
    facets = buildFacets(a, fields, sourceRecords, openCases.length);
  }

  // ---- AC2/AC6 coverage gaps: keep every gap visible with age/impact/owner-action. ----
  const coverageGaps: CoverageGapView[] = [];
  for (const g of input.coverageGaps ?? []) {
    if (g.tenantId !== input.tenantId) {
      throw new RangeError(
        `correlateAsset: coverage gap ${g.id} belongs to a different tenant than the scope`,
      );
    }
    coverageGaps.push(
      compact({
        gapId: g.id,
        gapClass: g.gapClass,
        reason: g.reason,
        impact: g.impact,
        ageMillis: gapAgeMillis(g, input.correlatedAt),
        requiredAction: g.requiredAction,
        requiredOwner: g.requiredOwner,
        reviewAt: g.reviewAt,
        expiresAt: g.expiresAt,
        gap: g,
      }),
    );
  }

  // ---- AC3 dependency + authoritative-field edges from inventory relationships. ----
  const dependencies: DependencyView[] = [];
  const authoritativeFields: AuthoritativeFieldView[] = [];
  for (const rel of input.relationships ?? []) {
    if (rel.tenantId !== input.tenantId) {
      throw new RangeError(
        `correlateAsset: relationship ${rel.id} belongs to a different tenant than the scope`,
      );
    }
    if (rel.relationship === 'depends_on') {
      dependencies.push(
        compact({
          relationshipId: rel.id,
          fromId: rel.fromId,
          toId: rel.toId,
          fieldName: rel.fieldName,
        }),
      );
    } else if (rel.relationship === 'authoritative_for') {
      authoritativeFields.push(
        compact({
          relationshipId: rel.id,
          field: rel.fieldName,
          authoritativeSourceId: rel.fromId,
        }),
      );
    }
  }

  // ---- AC5 source-catalog membership views. ----
  const catalogEntries: CatalogEntryView[] = [];
  for (const e of input.catalogEntries ?? []) {
    if (e.tenantId !== input.tenantId) {
      throw new RangeError(
        `correlateAsset: catalog entry ${e.id} belongs to a different tenant than the scope`,
      );
    }
    catalogEntries.push(
      compact({
        catalogId: e.id,
        sourceClass: e.sourceClass,
        classifiedUnknown: e.sourceClass === UNKNOWN_SOURCE_CLASS,
        observedLocations: e.observedLocations,
        accessState: e.accessState,
        sensitivity: e.sensitivity,
        ownerPrincipalId: e.ownerPrincipalId,
        ownershipGap: e.ownerPrincipalId === undefined,
        onboardingState: e.onboardingState,
        discoveryEvidence: e.discoveryEvidence,
        entry: e,
      }),
    );
  }

  return compact({
    tenantId: input.tenantId,
    assetId: input.assetId,
    sourceRecords: Object.freeze(sourceRecords),
    fields: Object.freeze(fields),
    openCases: Object.freeze(openCases),
    automationPaused,
    facets,
    coverageGaps: Object.freeze(coverageGaps),
    dependencies: Object.freeze(dependencies),
    authoritativeFields: Object.freeze(authoritativeFields),
    catalogEntries: Object.freeze(catalogEntries),
    correlatedAt: input.correlatedAt,
  });
}

/** Derive the AC1 facet set from the governing asset + the resolved fields. `evidenceState` is
 * computed from the field resolutions so that a STALE authoritative observation can never be read as
 * current evidence (AC4): every field must be resolved AND fresh for `current`; a resolved-but-stale
 * winner downgrades to `stale`; any unresolved field yields `incomplete`. `lastObservationAt` is the
 * newest last-known time actually observed, preferring the source records over the asset's stored
 * value. */
function buildFacets(
  a: GovernedAsset,
  fields: readonly FieldResolution[],
  records: readonly SourceRecord[],
  unresolvedIssueCount: number,
): CorrelatedItemFacets {
  const anyUnresolved = fields.some((f) => f.resolution === 'unresolved');
  const anyStaleWinner = fields.some((f) => f.resolution === 'resolved' && f.stale === true);
  const evidenceState: EvidenceState = anyUnresolved
    ? 'incomplete'
    : anyStaleWinner
      ? 'stale'
      : 'current';

  let newest: EpochMillis | undefined;
  for (const r of records) {
    if (newest === undefined || r.lastKnownAt > newest) newest = r.lastKnownAt;
  }
  const lastObservationAt = newest ?? a.lastObservedAt;

  return compact({
    assetType: a.assetType,
    name: a.name,
    ownerPrincipalId: a.ownerPrincipalId,
    ownershipGap: a.ownerPrincipalId === undefined,
    lifecycleState: a.lifecycleState,
    riskTier: a.riskTier,
    coverage: a.coverage,
    health: a.health,
    evidenceState,
    lastObservationAt,
    unresolvedIssueCount,
  });
}

/** The authoritative value for a field on a correlated item, or `undefined` when the field is
 * unresolved (never a guessed value). */
export function authoritativeValue(item: CorrelatedItem, field: string): unknown {
  const f = item.fields.find((x) => x.field === field);
  return f && f.resolution === 'resolved' ? f.value : undefined;
}

/** True iff every requested field resolved — the correlated view is fully authoritative and
 * automation may proceed. */
export function correlationIsComplete(item: CorrelatedItem): boolean {
  return item.fields.every((f) => f.resolution === 'resolved') && !item.automationPaused;
}

export function correlatedItemDigest(item: CorrelatedItem): string {
  return sha256(
    JSON.stringify({
      tenantId: item.tenantId,
      assetId: item.assetId,
      sourceRecordIds: item.sourceRecords.map((r) => r.id).sort(),
      fields: item.fields.map((f) => ({
        field: f.field,
        resolution: f.resolution,
        value: f.resolution === 'resolved' ? canonicalize(f.value) : null,
        authoritativeRecordId: f.authoritativeRecordId ?? null,
        authoritativeSourceClass: f.authoritativeSourceClass ?? null,
        confidence: f.confidence ?? null,
        asOf: f.asOf ?? null,
        stale: f.stale ?? false,
        unresolvedReason: f.unresolvedReason ?? null,
        contested: f.contested,
      })),
      openCaseIds: item.openCases.map((c) => c.id).sort(),
      automationPaused: item.automationPaused,
      // AC1 facets fold into the durable-effect witness so a change to any governed facet (type,
      // owner, lifecycle, risk, coverage, health, evidence state, last-observation) changes the hash.
      facets: item.facets
        ? {
            assetType: item.facets.assetType,
            name: item.facets.name,
            ownerPrincipalId: item.facets.ownerPrincipalId ?? null,
            ownershipGap: item.facets.ownershipGap,
            lifecycleState: item.facets.lifecycleState,
            riskTier: item.facets.riskTier,
            coverage: item.facets.coverage,
            health: item.facets.health,
            evidenceState: item.facets.evidenceState,
            lastObservationAt: item.facets.lastObservationAt ?? null,
            unresolvedIssueCount: item.facets.unresolvedIssueCount,
          }
        : null,
      // AC2/AC6 gap surface, AC3 edges, AC5 catalog membership all contribute to the witness.
      coverageGaps: item.coverageGaps
        .map((g) => ({
          gapId: g.gapId,
          gapClass: g.gapClass,
          reason: g.reason,
          impact: g.impact,
          ageMillis: g.ageMillis,
          reviewAt: g.reviewAt ?? null,
          expiresAt: g.expiresAt ?? null,
        }))
        .sort((x, y) => (x.gapId < y.gapId ? -1 : x.gapId > y.gapId ? 1 : 0)),
      dependencies: item.dependencies.map((d) => d.relationshipId).sort(),
      authoritativeFields: item.authoritativeFields
        .map((f) => `${f.field}:${f.authoritativeSourceId}`)
        .sort(),
      catalogEntryIds: item.catalogEntries.map((c) => c.catalogId).sort(),
      correlatedAt: item.correlatedAt,
    }),
  );
}

// ===========================================================================
// 5. Facet accessors — read the composed governance facets off a correlated item.
//    These are the AC1/AC2/AC3/AC5/AC6 read-side helpers the view uses.
// ===========================================================================

/** The AC1 facet set for a correlated item, or `undefined` when no governing asset was bound. */
export function correlatedItemFacets(item: CorrelatedItem): CorrelatedItemFacets | undefined {
  return item.facets;
}

/** The AC1 "evidence state" derived facet, or `undefined` when no facets were composed. Consumers
 * MUST NOT treat a non-`current` item's health as current (AC4). */
export function evidenceStateOf(item: CorrelatedItem): EvidenceState | undefined {
  return item.facets?.evidenceState;
}

/** True iff the correlated item's evidence is current — every governed field resolved AND fresh.
 * When this is false, current compliance/health MUST NOT be inferred (AC4). */
export function evidenceIsCurrent(item: CorrelatedItem): boolean {
  return item.facets?.evidenceState === 'current';
}

/** The still-VISIBLE coverage gaps for this item (open/acknowledged) — AC2 component gaps and AC6
 * governed-source gaps that must not disappear. */
export function visibleCoverageGaps(item: CorrelatedItem): readonly CoverageGapView[] {
  return item.coverageGaps.filter((g) => gapIsVisible(g.gap));
}

/** The AC6 governed-source gaps that carry a review-or-expiry deadline. */
export function governedSourceGaps(item: CorrelatedItem): readonly CoverageGapView[] {
  return item.coverageGaps.filter(
    (g) => g.gapClass === 'governed_source' && gapHasReviewOrExpiry(g.gap),
  );
}
