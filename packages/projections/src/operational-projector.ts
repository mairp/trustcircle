// @trustcircle/projections — OPERATIONAL PROJECTOR: the FR-029 full-field operational read model over
// connectors, controllers, and sources (Phase 8 / User Story 6 / T243 / FR-029, FR-030, NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE, deterministic fold that projects an operational posture read model. FR-029 requires that a
// connector / controller / source is trustworthy at a glance ONLY if it surfaces its FULL field set:
//   identity, version, owner, health, lifecycle status, enabled scope, last success + last attempt,
//   active operation, evidence, failures, retry state, affected work, and a SAFE NEXT ACTION.
// The projector ingests rows for each subject and derives — at an INJECTED `at` — a per-subject view
// with every one of those fields, plus:
//   * continuity posture — whether the subject is running under a bounded continuity lease (visible,
//     never hidden by a healthy status).
//   * profile — the availability class (core|optional|on-demand): a subject's optional-ness never
//     masks a core failure and vice versa.
//   * business impact — carried verbatim (never inferred from absence).
//   * safeNextAction — a conservative, never-widened action string per subject (e.g. `dispatch`,
//     `hold`, `reconcile`, `investigate`, `await_activation`, `retire`).
//
// It NEVER infers current health from stale data: a stale/absent health reading projects `unknown`
// health and a conservative next action. LEAF-CLEAN: @trustcircle/domain types + `node:crypto` ONLY
// (this package does NOT depend on application). `snapshotDigest(at)` is the durable-effect witness.

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
function reqNonEmpty(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return v;
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
// 1. Vocabulary (mirror the integrations migration column semantics).
// ===========================================================================

export const OPERATIONAL_SUBJECT_KINDS = ['connector', 'controller', 'source'] as const;
export type OperationalSubjectKind = (typeof OPERATIONAL_SUBJECT_KINDS)[number];

export const OPERATIONAL_AVAILABILITY_CLASSES = ['core', 'optional', 'on-demand'] as const;
export type OperationalAvailabilityClass = (typeof OPERATIONAL_AVAILABILITY_CLASSES)[number];

/** The projected health disposition — `unknown` is the ONLY value producible from stale/absent data. */
export const OPERATIONAL_HEALTH = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export type OperationalHealth = (typeof OPERATIONAL_HEALTH)[number];

export const OPERATIONAL_BUSINESS_IMPACT = ['none', 'low', 'medium', 'high', 'critical'] as const;
export type OperationalBusinessImpact = (typeof OPERATIONAL_BUSINESS_IMPACT)[number];

/** The conservative, never-widened safe-next-action vocabulary. */
export const SAFE_NEXT_ACTIONS = [
  'dispatch',
  'hold',
  'reconcile',
  'investigate',
  'await_activation',
  'retire',
] as const;
export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

// ===========================================================================
// 2. The ingested row — one operational subject as reported.
// ===========================================================================

/** The health telemetry AS REPORTED, with the instant it was reported (absence/stale ⇒ unknown). */
export interface SubjectHealthReport {
  readonly reportedAt: EpochMillis;
  /** The reported health (only trusted when present + fresh). */
  readonly health: OperationalHealth;
}

export interface OperationalSubjectInput {
  readonly subjectId: Uuid;
  readonly tenantId: Uuid;
  readonly kind: OperationalSubjectKind;
  readonly version: string;
  readonly ownerPrincipalId: Uuid;
  readonly availabilityClass: OperationalAvailabilityClass;
  /** The subject's lifecycle status verbatim (e.g. active/suspended/returning). */
  readonly lifecycleStatus: string;
  /** The enabled scope (capabilities/scopes) verbatim. */
  readonly enabledScope: readonly string[];
  /** The reported health snapshot (undefined = never reported ⇒ unknown). */
  readonly health?: SubjectHealthReport;
  /** Epoch-ms of the last successful operation (undefined = never succeeded). */
  readonly lastSuccessAt?: EpochMillis;
  /** Epoch-ms of the last attempt (undefined = never attempted). */
  readonly lastAttemptAt?: EpochMillis;
  /** The active operation id, if any. */
  readonly activeOperationId?: Uuid;
  /** True iff running under a bounded continuity lease (visible; never hidden). */
  readonly underContinuityLease?: boolean;
  readonly evidenceIds?: readonly Uuid[];
  readonly failureCount?: number;
  readonly retryDepth?: number;
  readonly deadLetterCount?: number;
  /** Count of work items affected by this subject's posture. */
  readonly affectedWorkCount?: number;
  readonly businessImpact?: OperationalBusinessImpact;
}

// ===========================================================================
// 3. The projected per-subject view (the FR-029 full field set).
// ===========================================================================

export interface OperationalSubjectView {
  readonly subjectId: Uuid;
  readonly tenantId: Uuid;
  readonly kind: OperationalSubjectKind;
  readonly version: string;
  readonly ownerPrincipalId: Uuid;
  readonly profile: OperationalAvailabilityClass;
  readonly lifecycleStatus: string;
  readonly enabledScope: readonly string[];
  /** Derived health — `unknown` when the report is stale/absent (never inferred from silence). */
  readonly health: OperationalHealth;
  /** True iff the health was derived from stale/absent telemetry. */
  readonly healthFromAbsence: boolean;
  readonly lastSuccessAt: EpochMillis | null;
  readonly lastAttemptAt: EpochMillis | null;
  readonly activeOperationId: Uuid | null;
  readonly underContinuityLease: boolean;
  readonly evidenceIds: readonly Uuid[];
  readonly failureCount: number;
  readonly retryDepth: number;
  readonly deadLetterCount: number;
  readonly affectedWorkCount: number;
  readonly businessImpact: OperationalBusinessImpact;
  /** A conservative, never-widened safe next action for this subject. */
  readonly safeNextAction: SafeNextAction;
}

export interface OperationalProjectorInput {
  readonly tenantId: Uuid;
  /** Health reported older than this (relative to `at`) is treated as stale ⇒ unknown (default 5m). */
  readonly freshnessHorizonMs?: number;
}

const DEFAULT_FRESHNESS_HORIZON_MS = 5 * 60_000;

// ===========================================================================
// 4. The projector.
// ===========================================================================

/**
 * A pure operational projector. Ingest per-subject rows (tenant-guarded), then read the full-field
 * operational view at an injected `at`. Never infers current health from stale data. Leaf-clean.
 */
export class OperationalProjector {
  readonly #tenantId: Uuid;
  readonly #freshnessHorizonMs: number;
  readonly #subjects = new Map<string, OperationalSubjectInput>();

  constructor(input: OperationalProjectorInput) {
    this.#tenantId = reqUuid(input.tenantId, 'projector.tenantId');
    const horizon = input.freshnessHorizonMs ?? DEFAULT_FRESHNESS_HORIZON_MS;
    if (!Number.isInteger(horizon) || horizon < 0) throw new RangeError('freshnessHorizonMs must be >= 0');
    this.#freshnessHorizonMs = horizon;
  }

  get tenantId(): Uuid {
    return this.#tenantId;
  }

  /** Ingest / replace one operational subject row (tenant-guarded, validated). */
  ingest(row: OperationalSubjectInput): void {
    reqUuid(row.subjectId, 'subject.subjectId');
    if (reqUuid(row.tenantId, 'subject.tenantId') !== this.#tenantId) {
      throw new TypeError(`subject ${row.subjectId} belongs to another tenant — refused`);
    }
    if (!(OPERATIONAL_SUBJECT_KINDS as readonly string[]).includes(row.kind)) {
      throw new TypeError(`subject.kind must be one of ${OPERATIONAL_SUBJECT_KINDS.join('|')}`);
    }
    if (!(OPERATIONAL_AVAILABILITY_CLASSES as readonly string[]).includes(row.availabilityClass)) {
      throw new TypeError(`subject.availabilityClass must be one of ${OPERATIONAL_AVAILABILITY_CLASSES.join('|')}`);
    }
    reqNonEmpty(row.version, 'subject.version');
    reqNonEmpty(row.lifecycleStatus, 'subject.lifecycleStatus');
    reqUuid(row.ownerPrincipalId, 'subject.ownerPrincipalId');
    this.#subjects.set(row.subjectId, row);
  }

  #healthAt(row: OperationalSubjectInput, at: EpochMillis): { health: OperationalHealth; fromAbsence: boolean } {
    const report = row.health;
    // ABSENCE / STALE ⇒ unknown (never infer current health from stale data).
    if (report === undefined || at - report.reportedAt > this.#freshnessHorizonMs) {
      return { health: 'unknown', fromAbsence: true };
    }
    return { health: report.health, fromAbsence: false };
  }

  #safeNextAction(
    row: OperationalSubjectInput,
    health: OperationalHealth,
    fromAbsence: boolean,
  ): SafeNextAction {
    // Conservative, never widened. Order matters — the FIRST matching rule wins.
    if (row.lifecycleStatus === 'retired') return 'retire';
    // An on-demand subject that is not active must be activated before work flows to it.
    if (row.availabilityClass === 'on-demand' && row.lifecycleStatus !== 'active') return 'await_activation';
    // Stale/absent health ⇒ we must not act on an unproven positive; investigate first.
    if (fromAbsence || health === 'unknown') return 'investigate';
    if (health === 'unhealthy') return 'investigate';
    // A dead-letter or failure backlog needs reconciliation before more work.
    if ((row.deadLetterCount ?? 0) > 0 || (row.failureCount ?? 0) > 0) return 'reconcile';
    if (health === 'degraded') return 'hold';
    // Healthy + active + no backlog ⇒ safe to dispatch.
    if (row.lifecycleStatus === 'active') return 'dispatch';
    return 'hold';
  }

  #view(row: OperationalSubjectInput, at: EpochMillis): OperationalSubjectView {
    const { health, fromAbsence } = this.#healthAt(row, at);
    const businessImpact = row.businessImpact ?? 'none';
    if (!(OPERATIONAL_BUSINESS_IMPACT as readonly string[]).includes(businessImpact)) {
      throw new TypeError(`subject.businessImpact must be one of ${OPERATIONAL_BUSINESS_IMPACT.join('|')}`);
    }
    const view: OperationalSubjectView = {
      subjectId: row.subjectId,
      tenantId: row.tenantId,
      kind: row.kind,
      version: row.version,
      ownerPrincipalId: row.ownerPrincipalId,
      profile: row.availabilityClass,
      lifecycleStatus: row.lifecycleStatus,
      enabledScope: Object.freeze([...(row.enabledScope ?? [])]),
      health,
      healthFromAbsence: fromAbsence,
      lastSuccessAt: row.lastSuccessAt ?? null,
      lastAttemptAt: row.lastAttemptAt ?? null,
      activeOperationId: row.activeOperationId ?? null,
      underContinuityLease: row.underContinuityLease === true,
      evidenceIds: Object.freeze([...(row.evidenceIds ?? [])]),
      failureCount: row.failureCount ?? 0,
      retryDepth: row.retryDepth ?? 0,
      deadLetterCount: row.deadLetterCount ?? 0,
      affectedWorkCount: row.affectedWorkCount ?? 0,
      businessImpact,
      safeNextAction: this.#safeNextAction(row, health, fromAbsence),
    };
    return Object.freeze(view);
  }

  /** Project one subject's full-field operational view (undefined if not ingested). */
  subject(subjectId: Uuid, at: EpochMillis): OperationalSubjectView | undefined {
    reqEpoch(at, 'at');
    const row = this.#subjects.get(subjectId);
    return row === undefined ? undefined : this.#view(row, at);
  }

  /** Project every subject's operational view at `at`, sorted by (kind, subjectId). Pure. */
  project(at: EpochMillis): readonly OperationalSubjectView[] {
    reqEpoch(at, 'at');
    return Object.freeze(
      [...this.#subjects.values()]
        .map((row) => this.#view(row, at))
        .sort((a, b) => (a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0)),
    );
  }

  /** The number of ingested subjects. */
  size(): number {
    return this.#subjects.size;
  }

  /** The content digest of the whole projection at `at` — the durable-effect witness. */
  snapshotDigest(at: EpochMillis): string {
    reqEpoch(at, 'at');
    return `sha256:${sha256(canonical(this.project(at)))}`;
  }
}
