// @trustcircle/projections — COMPLIANCE COVERAGE PROJECTOR (Phase 7 / User Story 5 — Demonstrate
// Compliance and Audit Readiness / FR-031..035, FR-051..056, SC-012, SC-013, SC-022).
//
// A pure, deterministic fold that projects a TENANT's compliance-coverage read model — publications,
// active applicability decisions, obligations, control mappings + evaluations, and any external
// certification — into the shape the governance-api `ComplianceCoverage` response needs, at an
// INJECTED instant `at` (never a wall-clock read). It composes the application coverage engine
// (reconstructCoverage) so the SC-012 coverage picture and the readiness-vs-certification claim
// boundary are computed by ONE oracle; the projector only ingests rows, guards tenancy, and reshapes.
//
// It NEVER infers current state from stale evidence (a stale evaluation surfaces as a gap, not as
// "operating"), and NEVER reports internal readiness as external certification. Its `snapshotDigest(at)`
// is the independently-observable durable-effect witness: identical rows + identical `at` ⇒ identical
// digest ⇒ identical coverage, so a consumer can prove the coverage it rendered matches the projector's.
// It also derives a freshness posture (current/aging/stale/unknown) from the newest evidence instant.

import { createHash } from 'node:crypto';
import { type Uuid, type EpochMillis } from '@trustcircle/domain';
import {
  reconstructCoverage,
  coverageReferenceCount,
  type CoverageInputs,
  type CoverageResult,
  type CoverageScope,
  type ControlEvaluationFact,
} from '@trustcircle/application';
import type {
  ApplicabilityDecision,
  Obligation,
  ControlMapping,
  ExternalCertification,
} from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// Module-private guards + hashing (fail-visible; re-declared locally to stay a leaf).
// ---------------------------------------------------------------------------

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

/** Evidence freshness posture (mirrors the governance-api ProjectionMetadata.freshness enum). */
export const FRESHNESS = ['current', 'aging', 'stale', 'unknown'] as const;
export type CoverageFreshness = (typeof FRESHNESS)[number];

/** The projection-metadata block that every coverage read carries (SC-012 / SC-013). */
export interface CoverageProjectionMetadata {
  readonly generatedAt: EpochMillis;
  /** The newest evidence cursor the coverage was reconstructed from (0 if none). */
  readonly sourceCursor: EpochMillis;
  readonly freshness: CoverageFreshness;
  /** True iff the picture itself is partial (an obligation/control could not be resolved). */
  readonly partialCoverage: boolean;
  readonly coverageGapCount: number;
}

export interface ComplianceCoverageModel {
  readonly coverage: CoverageResult;
  readonly referenceCount: number;
  readonly metadata: CoverageProjectionMetadata;
}

export interface ComplianceProjectorInput {
  readonly tenantId: Uuid;
  /** Evidence older than this (relative to `at`) is `aging`; older still is `stale` (default 90 days). */
  readonly agingHorizonMillis?: number;
  readonly staleHorizonMillis?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A pure, deterministic compliance-coverage projector. Ingest publications / decisions / obligations /
 * mappings / evaluations / certifications, then read a coverage model for an exact (scope, at).
 * Tenant-scoped: a row whose tenant differs from the projector's is refused. Holds only ingested rows.
 */
export class ComplianceCoverageProjector {
  readonly #tenantId: Uuid;
  readonly #aging: number;
  readonly #stale: number;
  readonly #decisions = new Map<string, ApplicabilityDecision>();
  readonly #obligations = new Map<string, Obligation>();
  readonly #mappings = new Map<string, ControlMapping>();
  readonly #evaluations = new Map<string, ControlEvaluationFact>();
  readonly #certifications = new Map<string, ExternalCertification>();

  constructor(input: ComplianceProjectorInput) {
    this.#tenantId = reqUuid(input.tenantId, 'projector.tenantId');
    const aging = input.agingHorizonMillis ?? 30 * DAY;
    const stale = input.staleHorizonMillis ?? 90 * DAY;
    if (!Number.isInteger(aging) || aging <= 0) throw new RangeError('agingHorizonMillis must be positive');
    if (!Number.isInteger(stale) || stale <= aging) throw new RangeError('staleHorizonMillis must exceed aging');
    this.#aging = aging;
    this.#stale = stale;
  }

  get tenantId(): Uuid {
    return this.#tenantId;
  }

  #guardTenant(rowTenant: Uuid, id: string): void {
    if (reqUuid(rowTenant, 'row.tenantId') !== this.#tenantId) {
      throw new TypeError(`row ${id} belongs to another tenant — refused`);
    }
  }

  ingestDecision(d: ApplicabilityDecision): void {
    this.#guardTenant(d.tenantId, d.id);
    this.#decisions.set(reqUuid(d.id, 'decision.id'), d);
  }
  ingestObligation(o: Obligation): void {
    this.#guardTenant(o.tenantId, o.id);
    this.#obligations.set(reqUuid(o.id, 'obligation.id'), o);
  }
  ingestMapping(m: ControlMapping): void {
    this.#guardTenant(m.tenantId, m.id);
    this.#mappings.set(reqUuid(m.id, 'mapping.id'), m);
  }
  ingestEvaluation(e: ControlEvaluationFact): void {
    reqUuid(e.controlMappingId, 'evaluation.controlMappingId');
    reqEpoch(e.evaluatedAt, 'evaluation.evaluatedAt');
    this.#evaluations.set(e.controlMappingId, e);
  }
  ingestCertification(c: ExternalCertification): void {
    this.#guardTenant(c.tenantId, c.id);
    this.#certifications.set(reqUuid(c.id, 'certification.id'), c);
  }

  /** The newest evidence instant across ingested evaluations (0 if none) — the source cursor. */
  #sourceCursor(): EpochMillis {
    let newest = 0;
    for (const e of this.#evaluations.values()) {
      const at = e.latestEvidenceAt ?? e.evaluatedAt;
      if (at > newest) newest = at;
    }
    return newest as EpochMillis;
  }

  #freshness(sourceCursor: EpochMillis, at: EpochMillis): CoverageFreshness {
    if (sourceCursor === 0) return 'unknown';
    const age = at - sourceCursor;
    if (age < 0) return 'unknown';
    if (age <= this.#aging) return 'current';
    if (age <= this.#stale) return 'aging';
    return 'stale';
  }

  /** Assemble the coverage inputs for an exact scope, from the ingested rows. */
  #inputsFor(scope: CoverageScope, at: EpochMillis): CoverageInputs {
    return {
      scope,
      decisions: [...this.#decisions.values()],
      obligations: [...this.#obligations.values()],
      mappings: [...this.#mappings.values()],
      evaluations: [...this.#evaluations.values()],
      certifications: [...this.#certifications.values()],
      at,
    };
  }

  /**
   * Project the coverage model for an exact (scope, at). Composes the application coverage engine and
   * attaches freshness metadata. Deterministic — no state mutation, no wall clock.
   */
  coverage(scope: Omit<CoverageScope, 'tenantId'> & { tenantId?: Uuid }, at: EpochMillis): ComplianceCoverageModel {
    reqEpoch(at, 'at');
    const fullScope: CoverageScope = {
      tenantId: this.#tenantId,
      ...(scope.systemId ? { systemId: scope.systemId } : {}),
      ...(scope.publicationId ? { publicationId: scope.publicationId } : {}),
    };
    const inputs = this.#inputsFor(fullScope, at);
    const result = reconstructCoverage(inputs);
    const sourceCursor = this.#sourceCursor();
    const metadata: CoverageProjectionMetadata = Object.freeze({
      generatedAt: at,
      sourceCursor,
      freshness: this.#freshness(sourceCursor, at),
      partialCoverage: !result.complete,
      coverageGapCount: result.gaps.length,
    });
    return Object.freeze({
      coverage: result,
      referenceCount: coverageReferenceCount(inputs),
      metadata,
    });
  }

  /** The count of ingested rows across all kinds. */
  size(): number {
    return (
      this.#decisions.size +
      this.#obligations.size +
      this.#mappings.size +
      this.#evaluations.size +
      this.#certifications.size
    );
  }

  /**
   * The content digest of the projected coverage at (scope, at) — the durable-effect witness.
   * Identical ingested rows + identical scope + identical `at` ⇒ identical digest.
   */
  snapshotDigest(scope: Omit<CoverageScope, 'tenantId'> & { tenantId?: Uuid }, at: EpochMillis): string {
    const model = this.coverage(scope, at);
    return `sha256:${sha256(
      canonical({
        scope: model.coverage.scope,
        at: model.coverage.at,
        claimBoundary: model.coverage.claimBoundary,
        obligationCount: model.coverage.obligationCount,
        coveredCount: model.coverage.coveredCount,
        obligations: model.coverage.obligations,
        gaps: model.coverage.gaps,
        complete: model.coverage.complete,
        metadata: model.metadata,
      }),
    )}`;
  }
}

// Re-export the types the engine consumes so downstream ingesters can type their rows without a deep import.
export type { ControlEvaluationFact, CoverageScope, CoverageResult } from '@trustcircle/application';
