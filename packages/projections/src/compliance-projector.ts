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
  type FrameworkMappingRecord,
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

export type MatrixControlCoverage =
  'covered' | 'partial' | 'unmapped' | 'disputed' | 'not_assessed' | 'not_applicable';
export type MatrixEvidenceSufficiency =
  'sufficient' | 'partial' | 'insufficient' | 'not_assessed' | 'not_applicable';
export type MatrixReadiness = 'ready' | 'not_ready' | 'not_assessed' | 'not_applicable';
export type MatrixAssessment = 'assessed' | 'not_assessed' | 'disputed' | 'not_applicable';
export type MatrixCertification = 'certified' | 'not_certified' | 'out_of_scope' | 'not_applicable';
export type MatrixDuty =
  'organizational_obligation' | 'guidance_only' | 'draft_only' | 'external_assurance_scope';

export interface FrameworkClaimFact {
  readonly mappingId: string;
  readonly tenantId: string;
  readonly controlCoverage: MatrixControlCoverage;
  readonly evidenceSufficiency: MatrixEvidenceSufficiency;
  readonly readiness: MatrixReadiness;
  readonly assessment: MatrixAssessment;
  readonly certification: MatrixCertification;
  readonly observedAt: number;
  readonly evidenceRefs: readonly string[];
}

export interface FrameworkMatrixRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sourcePublicationId: string;
  readonly sourceClauseRef: string;
  readonly requirementType: FrameworkMappingRecord['sourceMaterialType'];
  readonly applicability: FrameworkMappingRecord['applicabilityState'];
  readonly duty: MatrixDuty;
  readonly targetType: FrameworkMappingRecord['targetType'];
  readonly targetRef: string;
  readonly mappingType: FrameworkMappingRecord['mappingType'];
  readonly mappingStatus: FrameworkMappingRecord['status'];
  readonly coverageExtent: FrameworkMappingRecord['coverageExtent'];
  readonly conditions: readonly string[];
  readonly controlCoverage: MatrixControlCoverage;
  readonly evidenceSufficiency: MatrixEvidenceSufficiency;
  readonly readiness: MatrixReadiness;
  readonly assessment: MatrixAssessment;
  readonly certification: MatrixCertification;
  readonly evidenceRefs: readonly string[];
  readonly mappingOwnerPrincipalId: string;
  readonly obligationOwnerPrincipalId?: string;
  readonly rationale: string;
  readonly confidenceBand: FrameworkMappingRecord['confidenceBand'];
  readonly mappingVersion: number;
  readonly supersedesMappingId?: string;
  readonly supersededByMappingId?: string;
  readonly reviewedByPrincipalId?: string;
  readonly reviewedAt?: number;
}

export interface FrameworkMatrixModel {
  readonly tenantId: string;
  readonly publicationId?: string;
  readonly at: number;
  readonly rows: readonly FrameworkMatrixRow[];
  readonly metadata: CoverageProjectionMetadata;
  readonly digest: string;
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
  readonly #frameworkMappings = new Map<string, FrameworkMappingRecord>();
  readonly #frameworkClaims = new Map<string, FrameworkClaimFact>();

  constructor(input: ComplianceProjectorInput) {
    this.#tenantId = reqUuid(input.tenantId, 'projector.tenantId');
    const aging = input.agingHorizonMillis ?? 30 * DAY;
    const stale = input.staleHorizonMillis ?? 90 * DAY;
    if (!Number.isInteger(aging) || aging <= 0)
      throw new RangeError('agingHorizonMillis must be positive');
    if (!Number.isInteger(stale) || stale <= aging)
      throw new RangeError('staleHorizonMillis must exceed aging');
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

  ingestFrameworkMapping(mapping: FrameworkMappingRecord): void {
    this.#guardTenant(mapping.tenantId as Uuid, mapping.id);
    this.#frameworkMappings.set(reqUuid(mapping.id, 'frameworkMapping.id'), mapping);
  }
  ingestFrameworkClaim(claim: FrameworkClaimFact): void {
    this.#guardTenant(claim.tenantId as Uuid, claim.mappingId);
    reqUuid(claim.mappingId, 'frameworkClaim.mappingId');
    reqEpoch(claim.observedAt, 'frameworkClaim.observedAt');
    if (
      !['covered', 'partial', 'unmapped', 'disputed', 'not_assessed', 'not_applicable'].includes(
        claim.controlCoverage,
      )
    ) {
      throw new TypeError('framework claim control coverage is unsupported');
    }
    if (
      !['sufficient', 'partial', 'insufficient', 'not_assessed', 'not_applicable'].includes(
        claim.evidenceSufficiency,
      )
    ) {
      throw new TypeError('framework claim evidence sufficiency is unsupported');
    }
    if (!['ready', 'not_ready', 'not_assessed', 'not_applicable'].includes(claim.readiness)) {
      throw new TypeError('framework claim readiness is unsupported');
    }
    if (!['assessed', 'not_assessed', 'disputed', 'not_applicable'].includes(claim.assessment)) {
      throw new TypeError('framework claim assessment is unsupported');
    }
    if (
      !['certified', 'not_certified', 'out_of_scope', 'not_applicable'].includes(
        claim.certification,
      )
    ) {
      throw new TypeError('framework claim certification is unsupported');
    }
    if (!Array.isArray(claim.evidenceRefs) || claim.evidenceRefs.some((ref) => !ref)) {
      throw new TypeError('framework claim evidence refs must be a list of non-empty refs');
    }
    this.#frameworkClaims.set(
      claim.mappingId,
      Object.freeze({ ...claim, evidenceRefs: Object.freeze([...claim.evidenceRefs]) }),
    );
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
  coverage(
    scope: Omit<CoverageScope, 'tenantId'> & { tenantId?: Uuid },
    at: EpochMillis,
  ): ComplianceCoverageModel {
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

  frameworkMatrix(
    scope: Readonly<{ publicationId?: string }>,
    at: EpochMillis,
  ): FrameworkMatrixModel {
    reqEpoch(at, 'at');
    if (scope.publicationId !== undefined) {
      reqUuid(scope.publicationId, 'frameworkMatrix.publicationId');
    }
    const dutyFor = (mapping: FrameworkMappingRecord): MatrixDuty => {
      if (
        mapping.sourceMaterialType === 'requirement' ||
        mapping.sourceMaterialType === 'organizational_duty'
      ) {
        return 'organizational_obligation';
      }
      if (mapping.sourceMaterialType === 'guidance') return 'guidance_only';
      if (mapping.sourceMaterialType === 'draft') return 'draft_only';
      return 'external_assurance_scope';
    };
    const rows = [...this.#frameworkMappings.values()]
      .filter(
        (mapping) =>
          scope.publicationId === undefined || mapping.sourcePublicationId === scope.publicationId,
      )
      .sort(
        (a, b) =>
          a.sourceClauseRef.localeCompare(b.sourceClauseRef) ||
          a.targetRef.localeCompare(b.targetRef) ||
          a.id.localeCompare(b.id),
      )
      .map((mapping): FrameworkMatrixRow => {
        const claim = this.#frameworkClaims.get(mapping.id);
        const currentClaim = claim !== undefined && claim.observedAt <= at ? claim : undefined;
        const notApplicable =
          mapping.mappingType === 'not_applicable' ||
          mapping.applicabilityState === 'not_applicable';
        const disputed = mapping.status === 'disputed' || mapping.mappingType === 'conflicts';
        const partial =
          mapping.mappingType === 'partially_supports' || mapping.coverageExtent === 'partial';
        const controlCoverage: MatrixControlCoverage = notApplicable
          ? 'not_applicable'
          : (currentClaim?.controlCoverage ??
            (disputed
              ? 'disputed'
              : partial
                ? 'partial'
                : mapping.coverageExtent === 'none'
                  ? 'unmapped'
                  : 'not_assessed'));
        const evidenceSufficiency: MatrixEvidenceSufficiency = notApplicable
          ? 'not_applicable'
          : (currentClaim?.evidenceSufficiency ?? (partial ? 'partial' : 'not_assessed'));
        const readiness: MatrixReadiness = notApplicable
          ? 'not_applicable'
          : (currentClaim?.readiness ?? 'not_assessed');
        const assessment: MatrixAssessment = notApplicable
          ? 'not_applicable'
          : (currentClaim?.assessment ?? (disputed ? 'disputed' : 'not_assessed'));
        const certification: MatrixCertification = notApplicable
          ? 'not_applicable'
          : (currentClaim?.certification ?? 'not_certified');
        return Object.freeze({
          id: mapping.id,
          tenantId: mapping.tenantId,
          sourcePublicationId: mapping.sourcePublicationId,
          sourceClauseRef: mapping.sourceClauseRef,
          requirementType: mapping.sourceMaterialType,
          applicability: mapping.applicabilityState,
          duty: dutyFor(mapping),
          targetType: mapping.targetType,
          targetRef: mapping.targetRef,
          mappingType: mapping.mappingType,
          mappingStatus: mapping.status,
          coverageExtent: mapping.coverageExtent,
          conditions: Object.freeze([...mapping.conditions]),
          controlCoverage,
          evidenceSufficiency,
          readiness,
          assessment,
          certification,
          evidenceRefs: Object.freeze(
            [...new Set([...mapping.evidenceRefs, ...(currentClaim?.evidenceRefs ?? [])])].sort(),
          ),
          mappingOwnerPrincipalId: mapping.mappingOwnerPrincipalId,
          ...(mapping.obligationOwnerPrincipalId === undefined
            ? {}
            : { obligationOwnerPrincipalId: mapping.obligationOwnerPrincipalId }),
          rationale: mapping.rationale,
          confidenceBand: mapping.confidenceBand,
          mappingVersion: mapping.version,
          ...(mapping.supersedesMappingId === undefined
            ? {}
            : { supersedesMappingId: mapping.supersedesMappingId }),
          ...(mapping.supersededByMappingId === undefined
            ? {}
            : { supersededByMappingId: mapping.supersededByMappingId }),
          ...(mapping.reviewedByPrincipalId === undefined
            ? {}
            : { reviewedByPrincipalId: mapping.reviewedByPrincipalId }),
          ...(mapping.reviewedAt === undefined ? {} : { reviewedAt: mapping.reviewedAt }),
        });
      });
    let sourceCursor = 0;
    for (const mapping of this.#frameworkMappings.values()) {
      if (mapping.updatedAt > sourceCursor) sourceCursor = mapping.updatedAt;
    }
    for (const claim of this.#frameworkClaims.values()) {
      if (claim.observedAt <= at && claim.observedAt > sourceCursor) {
        sourceCursor = claim.observedAt;
      }
    }
    const gapCount = rows.filter(
      (row) =>
        row.mappingStatus !== 'active' ||
        row.applicability === 'conditional' ||
        row.applicability === 'undetermined' ||
        !['covered', 'not_applicable'].includes(row.controlCoverage) ||
        !['sufficient', 'not_applicable'].includes(row.evidenceSufficiency) ||
        !['ready', 'not_applicable'].includes(row.readiness) ||
        !['assessed', 'not_applicable'].includes(row.assessment),
    ).length;
    const metadata: CoverageProjectionMetadata = Object.freeze({
      generatedAt: at,
      sourceCursor: sourceCursor as EpochMillis,
      freshness: this.#freshness(sourceCursor as EpochMillis, at),
      partialCoverage: gapCount > 0,
      coverageGapCount: gapCount,
    });
    const digest =
      'sha256:' +
      sha256(
        canonical({
          tenantId: this.#tenantId,
          publicationId: scope.publicationId ?? null,
          at,
          rows,
          metadata,
        }),
      );
    return Object.freeze({
      tenantId: this.#tenantId,
      ...(scope.publicationId === undefined ? {} : { publicationId: scope.publicationId }),
      at,
      rows: Object.freeze(rows),
      metadata,
      digest,
    });
  }

  /** The count of ingested rows across all kinds. */
  size(): number {
    return (
      this.#decisions.size +
      this.#obligations.size +
      this.#mappings.size +
      this.#evaluations.size +
      this.#certifications.size +
      this.#frameworkMappings.size +
      this.#frameworkClaims.size
    );
  }

  /**
   * The content digest of the projected coverage at (scope, at) — the durable-effect witness.
   * Identical ingested rows + identical scope + identical `at` ⇒ identical digest.
   */
  snapshotDigest(
    scope: Omit<CoverageScope, 'tenantId'> & { tenantId?: Uuid },
    at: EpochMillis,
  ): string {
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
export type {
  ControlEvaluationFact,
  CoverageScope,
  CoverageResult,
} from '@trustcircle/application';
