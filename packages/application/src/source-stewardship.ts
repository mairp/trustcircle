// @trustcircle/application — SOURCE STEWARDSHIP commands over the source registry (Phase 72).
//
// A source steward's consequential decisions — approve onboarding, assign ownership, declare a
// source's authoritative fields, request access, quarantine, defer, or exclude a discovered source
// — are governed COMMANDS, not silent state pokes. Each command:
//
//   • REQUIRES a mandatory structured `reason` (code + non-empty text; makeReason rejects empties),
//   • REQUIRES an explicit `scope` (a non-empty free-text statement of what the decision covers),
//   • REQUIRES a `reviewAt` review date (a future-dated commitment to revisit the decision) —
//     even the exclude/defer/quarantine commands, whose gaps additionally accept an `expiresAt`,
//   • APPENDS an immutable AUDIT-TRAIL entry (actor, command, reason, scope, reviewDate, before →
//     after state, at) that is INDEPENDENTLY re-readable via `auditTrail()` / `auditTrailFor()` —
//     the command's return value is never the proof; the append-only, digest-witnessed trail is.
//
// This is the executable core of VO-fa865d7856056565038e: "Authorized source stewards MUST be able
// to approve onboarding, assign ownership, declare authoritative fields, request access, quarantine,
// defer, or exclude a discovered source with a mandatory reason, scope, review date, and audit
// trail." The command set maps 1:1 to that obligation.
//
// Governing acceptance criteria (verified in tests/unit/source-stewardship.unit.test.ts):
//   AC1 A steward-managed source that is approved+owned+observed renders ONCE in the registry's
//       current-state view with the full facet set → `currentStateView()` delegates to the wrapped
//       registry; `approveOnboarding` + `assignOwnership` + observation produce exactly one healthy row.
//   AC2 A discovered-but-unmanaged / unreachable / stale / orphaned / excluded source stays VISIBLE
//       as a coverage gap with reason/age/impact/required owner action → `reconcile()` / `coverageGaps()`.
//   AC3 Related work across registered sources keeps DISTINCT records + contract lineage +
//       correlation + STATUS DIFFERENCES across those records + DEPENDENCY edges + authoritative
//       fields → `drillDown()` / `sourceRecordsFor()` / `statusDifferencesFor()` /
//       `dependenciesFor()` (registry pass-through).
//   AC4 A stale/unavailable source is marked with last-known time + confidence and health is NOT
//       inferred from stale data → `currentStateView()` (registry AC4 staleness overlay preserved).
//   AC5 An unregistered source is ADDED to the catalog with discovery evidence / type-or-unknown /
//       location / access / sensitivity / ownership status / onboarding state → `discover()`.
//   AC6 A discovered source that is unsupported / inaccessible / sensitive / unowned / EXCLUDED /
//       DEFERRED / QUARANTINED stays VISIBLE as a governed-source gap with reason / impact / owner
//       action / review-or-expiry → `quarantine()` / `defer()` / `exclude()` open a governed_source
//       gap carrying the review date, and `assessCoverage()` retains it.
//
// The stewardship aggregate grants NO authority beyond recording the steward's declared decision:
// it validates, keeps every decision auditable, keeps quarantined/deferred/excluded sources VISIBLE
// as governed-source gaps (never deletes, never infers health), and never touches the wall clock —
// every command takes an explicit `at: EpochMillis` and mints identity from the injected `newId`.

import {
  isUuid,
  type Uuid,
  type EpochMillis,
  type Reason,
  isConsequentialReason,
  makeReason,
} from '@trustcircle/domain';
import {
  type SourceCatalogEntry,
  type SourceContract,
  type SourceRecord,
  type CoverageGap,
  type GapImpact,
  type AccessState,
  type OnboardingState,
  sourceCatalogEntryDigest,
} from '@trustcircle/domain';
import { createHash } from 'node:crypto';
import {
  SourceRegistry,
  type IdFactory,
  type RegistryInput,
  type SourceStateRow,
  type StatusDifference,
} from './source-registry.ts';
import type { InventoryRelationship, RelationshipKind } from '@trustcircle/domain';

// ===========================================================================
// 0. Guards (mirror the registry/domain fail-visible discipline).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}
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
/** A consequential steward decision MUST carry a structured reason (code + non-empty text). */
function assertReason(r: unknown, label: string): asserts r is Reason {
  if (!isConsequentialReason(r)) {
    throw new TypeError(`${label} must be a structured reason with a code and non-empty text`);
  }
}
/** A steward decision MUST carry a review date STRICTLY AFTER the moment it is taken — a decision
 * with no future review is not a governed decision but an untracked one. */
function assertReviewDate(
  reviewAt: unknown,
  at: EpochMillis,
  label: string,
): asserts reviewAt is EpochMillis {
  assertEpoch(reviewAt, label);
  if ((reviewAt as number) <= at) {
    throw new RangeError(`${label} must be a review date strictly after the decision time (${at})`);
  }
}

function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

// ===========================================================================
// 1. The steward command vocabulary + the append-only AUDIT TRAIL.
// ===========================================================================

/** The seven governed steward commands (VO-fa865d78). Pinned so the audit trail's `command`
 * facet is a closed, machine-checkable vocabulary rather than free text. */
export const STEWARD_COMMANDS = [
  'approve_onboarding',
  'assign_ownership',
  'declare_authoritative_fields',
  'request_access',
  'quarantine',
  'defer',
  'exclude',
] as const;
export type StewardCommand = (typeof STEWARD_COMMANDS)[number];

/**
 * One immutable audit-trail entry: WHO (actor) did WHAT (command) to WHICH source, WHY (reason),
 * over WHAT (scope), with WHICH review commitment (reviewAt) + optional expiry, and the resulting
 * before→after catalog-entry digest so the durable effect is independently witnessed. Frozen so a
 * recorded decision can never be back-edited (the trail is append-only, history-preserving).
 */
export interface StewardAuditEntry {
  readonly id: Uuid;
  readonly tenantId: Uuid | 'platform';
  readonly sourceId: Uuid;
  readonly actorPrincipalId: Uuid;
  readonly command: StewardCommand;
  readonly reason: Reason;
  /** Non-empty statement of what this decision covers (which fields/access/period/etc.). */
  readonly scope: string;
  /** Mandatory forward-dated review commitment for this decision. */
  readonly reviewAt: EpochMillis;
  /** Optional hard expiry (defer/quarantine/exclude may auto-lapse). */
  readonly expiresAt?: EpochMillis;
  /** Catalog-entry content digest BEFORE the command applied (independent before-state witness). */
  readonly beforeDigest: string;
  /** Catalog-entry content digest AFTER the command applied. */
  readonly afterDigest: string;
  readonly at: EpochMillis;
}

/** A stable content digest of one audit entry — the append-only trail's tamper-evident witness. */
export function stewardAuditEntryDigest(e: StewardAuditEntry): string {
  return sha256(
    JSON.stringify({
      id: e.id,
      tenantId: e.tenantId,
      sourceId: e.sourceId,
      actorPrincipalId: e.actorPrincipalId,
      command: e.command,
      reasonCode: e.reason.code,
      reasonText: e.reason.text,
      scope: e.scope,
      reviewAt: e.reviewAt,
      expiresAt: e.expiresAt ?? null,
      beforeDigest: e.beforeDigest,
      afterDigest: e.afterDigest,
      at: e.at,
    }),
  );
}

// ===========================================================================
// 2. Common command envelope — every steward command carries these mandatory fields.
// ===========================================================================

/** The mandatory envelope shared by every steward command (VO-fa865d78): actor, reason, scope,
 * review date, decision time — plus an optional expiry for the lapsing commands. */
export interface StewardDecision {
  readonly actorPrincipalId: Uuid;
  readonly reason: Reason;
  readonly scope: string;
  readonly reviewAt: EpochMillis;
  readonly expiresAt?: EpochMillis;
  readonly at: EpochMillis;
}

function assertDecision(d: StewardDecision, label: string): void {
  assertUuid(d.actorPrincipalId, `${label}.actorPrincipalId`);
  assertReason(d.reason, `${label}.reason`);
  assertNonEmpty(d.scope, `${label}.scope`);
  assertEpoch(d.at, `${label}.at`);
  assertReviewDate(d.reviewAt, d.at, `${label}.reviewAt`);
  if (d.expiresAt !== undefined) {
    assertEpoch(d.expiresAt, `${label}.expiresAt`);
    if (d.expiresAt <= d.at) {
      throw new RangeError(`${label}.expiresAt must be strictly after the decision time (${d.at})`);
    }
  }
}

// ===========================================================================
// 3. The stewardship aggregate.
// ===========================================================================

export interface StewardshipInput extends RegistryInput {
  /** Optionally reuse a pre-populated registry (e.g. one already holding discovered sources). A
   * fresh registry is created from `RegistryInput` when omitted. */
  readonly registry?: SourceRegistry;
}

/** The result of a lapsing command (quarantine/defer/exclude): the rewritten catalog entry, the
 * governed-source coverage gap it keeps VISIBLE, and the audit entry it appended. */
export interface StewardGapResult {
  readonly entry: SourceCatalogEntry;
  readonly gap: CoverageGap;
  readonly audit: StewardAuditEntry;
}

/** The result of a non-gap command (approve/assign/declare/request): the rewritten entry (or the
 * effective contract, for declareAuthoritativeFields) and the audit entry it appended. */
export interface StewardEntryResult {
  readonly entry: SourceCatalogEntry;
  readonly audit: StewardAuditEntry;
}

export interface StewardContractResult {
  readonly contract: SourceContract;
  readonly audit: StewardAuditEntry;
}

/**
 * Governs the consequential decisions a source steward may take over a discovered source, wrapping
 * a {@link SourceRegistry}. Every command records an immutable, independently-readable audit entry
 * with a mandatory reason, scope, and forward-dated review — and the lapsing commands
 * (quarantine/defer/exclude) additionally keep the source VISIBLE as a governed-source coverage gap
 * carrying the review-or-expiry deadline. Pure + deterministic: no wall-clock reads, no I/O.
 */
export class SourceStewardship {
  private readonly registry: SourceRegistry;
  private readonly newId: IdFactory;
  private readonly tenantId: Uuid | 'platform';
  private readonly trail: StewardAuditEntry[] = [];

  constructor(input: StewardshipInput) {
    this.registry = input.registry ?? new SourceRegistry(input);
    if (typeof input.newId !== 'function')
      throw new TypeError('stewardship.newId must be a factory');
    this.newId = input.newId;
    this.tenantId = input.tenantId;
  }

  /** The wrapped registry, for callers that need its full query/mutation surface (discover, etc.). */
  registrySurface(): SourceRegistry {
    return this.registry;
  }

  // -------------------------------------------------------------------------
  // COMMAND 1 — APPROVE ONBOARDING.
  //   Advances the source through pending → onboarded (the guarded lifecycle in the registry),
  //   recording the steward's approval decision. Onboarding still requires a registered contract
  //   and a named owner (the registry enforces both), so approval cannot fabricate governance.
  // -------------------------------------------------------------------------
  approveOnboarding(input: { sourceId: Uuid } & StewardDecision): StewardEntryResult {
    assertUuid(input.sourceId, 'approveOnboarding.sourceId');
    assertDecision(input, 'approveOnboarding');
    const before = this.snapshotEntry(input.sourceId, 'approveOnboarding.sourceId');
    // Walk toward onboarded through legal transitions (discovered→pending→onboarded).
    let current = before;
    if (current.onboardingState === 'discovered') {
      current = this.registry.transitionOnboarding({
        sourceId: current.id,
        to: 'pending',
        at: input.at,
      });
    }
    if (current.onboardingState === 'excluded') {
      current = this.registry.transitionOnboarding({
        sourceId: current.id,
        to: 'pending',
        at: input.at,
      });
    }
    const entry = this.registry.transitionOnboarding({
      sourceId: current.id,
      to: 'onboarded',
      at: input.at,
    });
    const audit = this.appendAudit('approve_onboarding', input, before, entry);
    return { entry, audit };
  }

  // -------------------------------------------------------------------------
  // COMMAND 2 — ASSIGN OWNERSHIP.
  //   Names the accountable steward/owner (closes the ownership gap), with a reasoned, scoped,
  //   review-dated decision.
  // -------------------------------------------------------------------------
  assignOwnership(
    input: { sourceId: Uuid; ownerPrincipalId: Uuid } & StewardDecision,
  ): StewardEntryResult {
    assertUuid(input.sourceId, 'assignOwnership.sourceId');
    assertUuid(input.ownerPrincipalId, 'assignOwnership.ownerPrincipalId');
    assertDecision(input, 'assignOwnership');
    const before = this.snapshotEntry(input.sourceId, 'assignOwnership.sourceId');
    const entry = this.registry.assignOwner({
      sourceId: input.sourceId,
      ownerPrincipalId: input.ownerPrincipalId,
      at: input.at,
    });
    const audit = this.appendAudit('assign_ownership', input, before, entry);
    return { entry, audit };
  }

  // -------------------------------------------------------------------------
  // COMMAND 3 — DECLARE AUTHORITATIVE FIELDS.
  //   Registers (or supersedes) the source contract that DECLARES which fields this source is
  //   authoritative for — a versioned, validated, append-only contract change (AC3 authoritative
  //   fields). Records the steward's declaration decision.
  // -------------------------------------------------------------------------
  declareAuthoritativeFields(
    input: {
      sourceId: Uuid;
      version: number;
      authoritativeFields: readonly string[];
      supportLevel?: SourceContract['supportLevel'];
      accessMethod?: string;
      sensitivity?: SourceContract['sensitivity'];
    } & StewardDecision,
  ): StewardContractResult {
    assertUuid(input.sourceId, 'declareAuthoritativeFields.sourceId');
    assertDecision(input, 'declareAuthoritativeFields');
    if (!Array.isArray(input.authoritativeFields) || input.authoritativeFields.length === 0) {
      throw new TypeError(
        'declareAuthoritativeFields.authoritativeFields must be a non-empty list',
      );
    }
    for (const f of input.authoritativeFields) {
      assertNonEmpty(f, 'declareAuthoritativeFields.authoritativeFields entry');
    }
    const before = this.snapshotEntry(input.sourceId, 'declareAuthoritativeFields.sourceId');
    const contract = this.registry.registerContract({
      sourceId: input.sourceId,
      version: input.version,
      authoritativeFields: input.authoritativeFields,
      ...(input.supportLevel !== undefined ? { supportLevel: input.supportLevel } : {}),
      ...(input.accessMethod !== undefined ? { accessMethod: input.accessMethod } : {}),
      ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      at: input.at,
    });
    // The catalog entry itself is unchanged by a contract declaration; before === after digest.
    const after = this.snapshotEntry(input.sourceId, 'declareAuthoritativeFields.sourceId');
    const audit = this.appendAudit('declare_authoritative_fields', input, before, after);
    return { contract, audit };
  }

  // -------------------------------------------------------------------------
  // COMMAND 4 — REQUEST ACCESS.
  //   Records a steward's request to (re)establish access to a source whose access is currently
  //   unknown/unreachable/inaccessible. This does NOT fabricate connectivity: it records the
  //   request + review commitment and marks the access state as pending re-establishment
  //   ('unknown' — a fail-visible "not yet reachable"), keeping the source a visible gap until a
  //   fresh observation proves connectivity. Health is never promoted by a request.
  // -------------------------------------------------------------------------
  requestAccess(input: { sourceId: Uuid } & StewardDecision): StewardEntryResult {
    assertUuid(input.sourceId, 'requestAccess.sourceId');
    assertDecision(input, 'requestAccess');
    const before = this.snapshotEntry(input.sourceId, 'requestAccess.sourceId');
    // A request records intent; it must not claim the source is connected. Access stays a
    // fail-visible non-connected state ('unknown') until a genuine observation confirms access.
    const nextAccess: AccessState = 'unknown';
    const entry = this.registry.recordObservation({
      sourceId: input.sourceId,
      accessState: nextAccess,
      healthState: before.healthState === 'healthy' ? 'unknown' : before.healthState,
      at: input.at,
    });
    const audit = this.appendAudit('request_access', input, before, entry);
    return { entry, audit };
  }

  // -------------------------------------------------------------------------
  // COMMAND 5 — QUARANTINE.
  //   Isolates a source from governance participation pending review, WITHOUT deleting it. The
  //   source stays VISIBLE as a governed-source gap carrying the quarantine reason, impact, owner
  //   action, and review-or-expiry (AC6). Health is downgraded (not inferred healthy) because the
  //   source is no longer onboarded.
  // -------------------------------------------------------------------------
  quarantine(
    input: { sourceId: Uuid; impact?: GapImpact; requiredOwner?: Uuid } & StewardDecision,
  ): StewardGapResult {
    return this.lapse('quarantine', {
      ...input,
      requiredAction:
        'Complete the quarantine review by the review date; re-onboard or exclude the source.',
      impact: input.impact ?? 'high',
    });
  }

  // -------------------------------------------------------------------------
  // COMMAND 6 — DEFER.
  //   Postpones onboarding/remediation of a source to a scheduled review, keeping it VISIBLE as a
  //   governed-source gap (never silently shelved). Same review-or-expiry + audit discipline.
  // -------------------------------------------------------------------------
  defer(
    input: { sourceId: Uuid; impact?: GapImpact; requiredOwner?: Uuid } & StewardDecision,
  ): StewardGapResult {
    return this.lapse('defer', {
      ...input,
      requiredAction:
        'Revisit the deferred source at the review date and onboard, exclude, or re-defer it.',
      impact: input.impact ?? 'medium',
    });
  }

  // -------------------------------------------------------------------------
  // COMMAND 7 — EXCLUDE.
  //   Intentionally excludes a source from governance, keeping it VISIBLE as a governed-source gap
  //   with the exclusion reason + review-or-expiry (AC6). Delegates to the registry's exclusion.
  // -------------------------------------------------------------------------
  exclude(
    input: { sourceId: Uuid; impact?: GapImpact; requiredOwner?: Uuid } & StewardDecision,
  ): StewardGapResult {
    return this.lapse('exclude', {
      ...input,
      requiredAction:
        'Review the exclusion at the scheduled date and re-onboard or confirm the exclusion.',
      impact: input.impact ?? 'medium',
    });
  }

  // -------------------------------------------------------------------------
  // Shared lapsing implementation for quarantine / defer / exclude. Each transitions the source to
  // `excluded` (the registry's single "isolated from active governance" onboarding state) and opens
  // a governed_source gap carrying the reason, impact, owner action, and MANDATORY review-or-expiry.
  // The distinct steward COMMAND is preserved in the audit trail even though all three share the
  // registry's `excluded` state — so an auditor can tell a quarantine from a deferral from an
  // exclusion.
  // -------------------------------------------------------------------------
  private lapse(
    command: Extract<StewardCommand, 'quarantine' | 'defer' | 'exclude'>,
    input: {
      sourceId: Uuid;
      requiredAction: string;
      impact: GapImpact;
      requiredOwner?: Uuid;
    } & StewardDecision,
  ): StewardGapResult {
    assertUuid(input.sourceId, `${command}.sourceId`);
    assertDecision(input, command);
    const before = this.snapshotEntry(input.sourceId, `${command}.sourceId`);
    const { entry, gap } = this.registry.exclude({
      sourceId: input.sourceId,
      reason: input.reason,
      impact: input.impact,
      requiredAction: input.requiredAction,
      ...(input.requiredOwner !== undefined ? { requiredOwner: input.requiredOwner } : {}),
      reviewAt: input.reviewAt,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      at: input.at,
    });
    const audit = this.appendAudit(command, input, before, entry);
    return { entry, gap, audit };
  }

  // -------------------------------------------------------------------------
  // AUDIT-TRAIL read path — independently observable, append-only, digest-witnessed.
  // -------------------------------------------------------------------------

  /** The full append-only steward audit trail, oldest first (insertion order). Never mutated. */
  auditTrail(): readonly StewardAuditEntry[] {
    return [...this.trail];
  }

  /** The audit trail for one source, oldest first. */
  auditTrailFor(sourceId: Uuid): readonly StewardAuditEntry[] {
    assertUuid(sourceId, 'auditTrailFor.sourceId');
    return this.trail.filter((e) => e.sourceId === sourceId);
  }

  /** A stable digest over the WHOLE audit trail. Changes iff any recorded decision changes;
   * identical iff the trail is identical. The tamper-evident witness the tests read INSTEAD of a
   * command's return value. */
  auditTrailDigest(): string {
    return sha256(JSON.stringify(this.trail.map((e) => stewardAuditEntryDigest(e))));
  }

  // -------------------------------------------------------------------------
  // Registry pass-through read/mutation surface (AC1–AC5 delegate to the registry unchanged).
  // -------------------------------------------------------------------------

  discover(input: Parameters<SourceRegistry['discover']>[0]): SourceCatalogEntry {
    return this.registry.discover(input);
  }
  currentStateView(at: EpochMillis): readonly SourceStateRow[] {
    return this.registry.currentStateView(at);
  }
  coverageGaps(): readonly CoverageGap[] {
    return this.registry.coverageGaps();
  }
  gapsForSource(sourceId: Uuid): readonly CoverageGap[] {
    return this.registry.gapsForSource(sourceId);
  }
  assessCoverage(input: { at: EpochMillis; reviewWindowMillis?: number }): readonly CoverageGap[] {
    return this.registry.assessCoverage(input);
  }
  reconcile(input: { at: EpochMillis }): readonly CoverageGap[] {
    return this.registry.reconcile(input);
  }
  drillDown(sourceId: Uuid): ReturnType<SourceRegistry['drillDown']> {
    return this.registry.drillDown(sourceId);
  }
  sourceRecordsFor(sourceId: Uuid): readonly SourceRecord[] {
    return this.registry.sourceRecordsFor(sourceId);
  }
  statusDifferencesFor(sourceId: Uuid): readonly StatusDifference[] {
    return this.registry.statusDifferencesFor(sourceId);
  }
  dependenciesFor(sourceId: Uuid): readonly InventoryRelationship[] {
    return this.registry.dependenciesFor(sourceId);
  }
  relationshipsFor(sourceId: Uuid): readonly InventoryRelationship[] {
    return this.registry.relationshipsFor(sourceId);
  }
  attachRelationship(input: {
    sourceId: Uuid;
    toId: Uuid;
    relationship: RelationshipKind;
    fieldName?: string;
    at: EpochMillis;
  }): InventoryRelationship {
    return this.registry.attachRelationship(input);
  }
  catalog(): readonly SourceCatalogEntry[] {
    return this.registry.catalog();
  }
  snapshotDigest(): string {
    return this.registry.snapshotDigest();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private snapshotEntry(sourceId: Uuid, label: string): SourceCatalogEntry {
    assertUuid(sourceId, label);
    const entry = this.registry.catalog().find((e) => e.id === sourceId);
    if (!entry) throw new RangeError(`unknown source: ${sourceId}`);
    return entry;
  }

  /** Mint + append an immutable audit entry recording a steward decision, with the before/after
   * catalog-entry digests as the durable-effect witness. */
  private appendAudit(
    command: StewardCommand,
    d: StewardDecision & { sourceId: Uuid },
    before: SourceCatalogEntry,
    after: SourceCatalogEntry,
  ): StewardAuditEntry {
    const id = this.newId();
    if (!isUuid(id)) throw new TypeError('stewardship.newId must yield a UUID');
    const entry: StewardAuditEntry = Object.freeze({
      id,
      tenantId: this.tenantId,
      sourceId: d.sourceId,
      actorPrincipalId: d.actorPrincipalId,
      command,
      reason: Object.freeze({ code: d.reason.code, text: d.reason.text }),
      scope: d.scope.trim(),
      reviewAt: d.reviewAt,
      ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
      beforeDigest: sourceCatalogEntryDigest(before),
      afterDigest: sourceCatalogEntryDigest(after),
      at: d.at,
    });
    this.trail.push(entry);
    return entry;
  }
}

// Re-export the makeReason helper so callers/tests can build steward reasons from one import.
export { makeReason };
export type { OnboardingState, StatusDifference };
