// @trustcircle/api — COMPLIANCE COVERAGE / EVIDENCE / AUDIT-EXPORT ROUTES (Phase 7 / User Story 5 —
// Demonstrate Compliance and Audit Readiness / FR-031..035, FR-053..056, SC-012, SC-013, SC-022).
//
// Mounts the three remaining User-Story-5 operations from the OpenAPI contract
// (specs/001-governance-control-plane/contracts/governance-api.openapi.yaml):
//
//   GET  /v1/compliance/coverage        → getComplianceCoverage → ComplianceCoverage (200)
//   GET  /v1/evidence/{evidenceId}       → getEvidenceMetadata   → EvidenceEnvelope   (200)
//   POST /v1/audit/exports               → requestAuditExport    → OperationAccepted  (202)
//
// The obligations this module enforces at the boundary (verifiable against the coverage engine,
// projector, and contract checkers):
//
//   * TRUTHFUL CLAIM BOUNDARY (FR-055, SC-012). The coverage response reports EXACTLY the claim
//     boundary the coverage engine reconstructs — design/implemented/operating/ready/assessed/
//     certified/incomplete — and NEVER promotes internal readiness to external certification. The route
//     copies the boundary verbatim; it re-derives nothing.
//   * RECONSTRUCTABLE-AT-INSTANT (SC-013). Coverage is scoped to an exact (system/publication) and an
//     exact instant `at` (defaulting to now only when omitted); the projector recomputes it purely, so
//     a consumer can reconstruct the same picture for the same scope + instant.
//   * EVIDENCE AUTHORIZATION (FR-053). Evidence metadata is returned only for the querying tenant; a
//     cross-tenant or unknown id is a visible 404 in the tenant scope, never a leak.
//   * ASYNC EXPORT (FR-056, SC-022). An audit export is ACCEPTED (202) and processed by the
//     audit-export worker; the route validates the scope/period/reason wire shape and hands an
//     idempotent command to the injected enqueue port — it performs no export work inline.
//
// Pure request→response plumbing over INJECTED ports (a coverage projector read, an evidence-metadata
// reader, an export enqueue command). No mutable state, no wall clock (each command carries `now`).

import type { App, AppContext, RouteHandler } from '../server.ts';

import { type Uuid, type EpochMillis, type TenantId, isUuid } from '@trustcircle/domain';
import type {
  GovernanceApiComplianceCoverage,
  GovernanceApiStandardPublication,
  GovernanceApiProjectionMetadata,
  GovernanceApiReason,
  GovernanceApiOperationAccepted,
} from '@trustcircle/contracts';

// ===========================================================================
// 0. Injected ports.
// ===========================================================================

/** A publication fact as it appears within a coverage read (same shape as the standards registry). */
export interface CoveragePublicationView {
  readonly id: Uuid;
  readonly publisher: string;
  readonly identifier: string;
  readonly exactTitle: string;
  readonly edition: string;
  readonly publicationDate: string;
  readonly status: string;
  readonly materialType: string;
  readonly sourceUri: string;
  readonly registryVersion: number;
}

/** The projection-metadata block a coverage read carries (freshness / partial-coverage / cursor). */
export interface CoverageMetadataView {
  readonly generatedAt: EpochMillis;
  readonly sourceCursor: string;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly partialCoverage: boolean;
  readonly coverageGaps?: readonly string[];
}

/** The reconstructed coverage a scope/instant read returns (from @trustcircle/projections). */
export interface CoverageView {
  readonly tenantId: TenantId;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly publications: readonly CoveragePublicationView[];
  readonly obligations: readonly Readonly<Record<string, unknown>>[];
  readonly controls: readonly Readonly<Record<string, unknown>>[];
  readonly evidence: readonly Readonly<Record<string, unknown>>[];
  readonly gaps: readonly Readonly<Record<string, unknown>>[];
  /** The claim boundary the coverage engine reconstructed — copied verbatim, never re-derived. */
  readonly claimBoundary:
    'design' | 'implemented' | 'operating' | 'ready' | 'assessed' | 'certified' | 'incomplete';
  readonly metadata: CoverageMetadataView;
}

/** The scope + instant a coverage read is reconstructed for. */
export interface CoverageQuery {
  readonly tenantId: TenantId;
  readonly systemId?: Uuid;
  readonly publicationId?: Uuid;
  /** The instant to reconstruct coverage AT; the composition root defaults it to `now` when omitted. */
  readonly at?: EpochMillis;
}

/** Resolves reconstructed coverage for an exact scope + instant, or undefined (empty coverage). */
export type CoverageProvider = (
  query: CoverageQuery,
) => CoverageView | undefined | Promise<CoverageView | undefined>;

export interface FrameworkMatrixRowView {
  readonly id: string;
  readonly tenantId: string;
  readonly sourcePublicationId: string;
  readonly sourceClauseRef: string;
  readonly requirementType: string;
  readonly applicability: string;
  readonly duty: string;
  readonly targetType: string;
  readonly targetRef: string;
  readonly mappingType: string;
  readonly mappingStatus: string;
  readonly coverageExtent: string;
  readonly conditions: readonly string[];
  readonly controlCoverage: string;
  readonly evidenceSufficiency: string;
  readonly readiness: string;
  readonly assessment: string;
  readonly certification: string;
  readonly evidenceRefs: readonly string[];
  readonly mappingOwnerPrincipalId: string;
  readonly obligationOwnerPrincipalId?: string;
  readonly rationale: string;
  readonly confidenceBand: string;
  readonly mappingVersion: number;
  readonly supersedesMappingId?: string;
  readonly supersededByMappingId?: string;
  readonly reviewedByPrincipalId?: string;
  readonly reviewedAt?: EpochMillis;
}

export interface FrameworkMatrixView {
  readonly tenantId: TenantId;
  readonly publicationId?: Uuid;
  readonly at: EpochMillis;
  readonly rows: readonly FrameworkMatrixRowView[];
  readonly metadata: CoverageMetadataView;
  readonly digest: string;
}

export interface FrameworkMatrixQuery {
  readonly tenantId: TenantId;
  readonly publicationId?: Uuid;
  readonly at?: EpochMillis;
}

export type FrameworkMatrixProvider = (
  query: FrameworkMatrixQuery,
) => FrameworkMatrixView | undefined | Promise<FrameworkMatrixView | undefined>;

/** Evidence metadata as the injected surface hands it to the route (an already-shaped envelope). */
export type EvidenceEnvelopeView = Readonly<Record<string, unknown>>;

/** Reads one evidence envelope's metadata for a tenant, or undefined when absent / not visible. */
export type EvidenceMetadataReader = (
  tenantId: TenantId,
  evidenceId: Uuid,
) => EvidenceEnvelopeView | undefined | Promise<EvidenceEnvelopeView | undefined>;

/** The validated command an audit-export request carries to the injected enqueue port. */
export interface AuditExportCommand {
  readonly tenantId: TenantId;
  readonly requesterPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly reason: { readonly code: string; readonly text: string };
}

/** The outcome of enqueueing an export — the accepted operation id + whether it was a replay. */
export interface AuditExportResult {
  readonly operationId: Uuid;
  readonly auditEventId: Uuid;
  readonly status: string;
  readonly idempotentReplay: boolean;
}

/** Enqueue an audit export for asynchronous processing (the worker owns the actual export). */
export type AuditExportEnqueue = (
  command: AuditExportCommand,
) => AuditExportResult | Promise<AuditExportResult>;

export interface ComplianceRouteDeps {
  readonly coverage: CoverageProvider;
  readonly frameworkMatrix?: FrameworkMatrixProvider;
  readonly readEvidence: EvidenceMetadataReader;
  readonly enqueueExport: AuditExportEnqueue;
}

// ===========================================================================
// 1. Contract vocabularies + a disclosure-safe Problem responder.
// ===========================================================================

const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REASON_TEXT_MIN = 3;
const REASON_TEXT_MAX = 4000;

function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
): Response {
  const correlationId = c.ctx?.correlationId ?? 'unknown';
  const body: Record<string, unknown> = {
    type: `about:blank#${code}`,
    title,
    status,
    code,
    detail,
    correlation_id: correlationId,
    retryable: status >= 500,
    safe_next_actions: [...safeNextActions],
  };
  return c.json(body, status);
}

function requireTenant(c: AppContext): TenantId | undefined {
  const t = c.ctx?.tenantId;
  if (typeof t === 'string' && isUuid(t)) return t as TenantId;
  return undefined;
}

function principalOf(c: AppContext): string {
  return c.ctx?.principalId ?? 'unknown';
}

// ===========================================================================
// 2. Wire mappers.
// ===========================================================================

function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

function publicationToWire(p: CoveragePublicationView): GovernanceApiStandardPublication {
  return {
    id: String(p.id),
    publisher: p.publisher,
    identifier: p.identifier,
    exact_title: p.exactTitle,
    edition: p.edition,
    publication_date: p.publicationDate,
    status: p.status,
    material_type: p.materialType,
    source_uri: p.sourceUri,
    registry_version: p.registryVersion,
  };
}

function metadataToWire(m: CoverageMetadataView): GovernanceApiProjectionMetadata {
  const base: GovernanceApiProjectionMetadata = {
    generated_at: iso(m.generatedAt),
    source_cursor: m.sourceCursor,
    freshness: m.freshness,
    partial_coverage: m.partialCoverage,
  };
  return m.coverageGaps !== undefined && m.coverageGaps.length > 0
    ? { ...base, coverage_gaps: [...m.coverageGaps] }
    : base;
}

function coverageToWire(v: CoverageView): GovernanceApiComplianceCoverage {
  return {
    tenant_id: String(v.tenantId),
    scope: { ...v.scope },
    publications: v.publications.map(publicationToWire),
    obligations: v.obligations.map((o) => ({ ...o })),
    controls: v.controls.map((ctl) => ({ ...ctl })),
    evidence: v.evidence.map((e) => ({ ...e })),
    gaps: v.gaps.map((g) => ({ ...g })),
    claim_boundary: v.claimBoundary,
    metadata: metadataToWire(v.metadata),
  };
}

function frameworkMatrixToWire(view: FrameworkMatrixView): Readonly<Record<string, unknown>> {
  return {
    tenant_id: String(view.tenantId),
    publication_id: view.publicationId === undefined ? null : String(view.publicationId),
    at: iso(view.at),
    rows: view.rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenantId,
      source_publication_id: row.sourcePublicationId,
      source_clause_ref: row.sourceClauseRef,
      requirement_type: row.requirementType,
      applicability: row.applicability,
      duty: row.duty,
      target_type: row.targetType,
      target_ref: row.targetRef,
      mapping_type: row.mappingType,
      mapping_status: row.mappingStatus,
      coverage_extent: row.coverageExtent,
      conditions: row.conditions,
      control_coverage: row.controlCoverage,
      evidence_sufficiency: row.evidenceSufficiency,
      readiness: row.readiness,
      assessment: row.assessment,
      certification: row.certification,
      evidence_refs: row.evidenceRefs,
      mapping_owner_principal_id: row.mappingOwnerPrincipalId,
      obligation_owner_principal_id: row.obligationOwnerPrincipalId ?? null,
      rationale: row.rationale,
      confidence_band: row.confidenceBand,
      mapping_version: row.mappingVersion,
      supersedes_mapping_id: row.supersedesMappingId ?? null,
      superseded_by_mapping_id: row.supersededByMappingId ?? null,
      reviewed_by_principal_id: row.reviewedByPrincipalId ?? null,
      reviewed_at: row.reviewedAt === undefined ? null : iso(row.reviewedAt),
    })),
    metadata: metadataToWire(view.metadata),
    digest: view.digest,
  };
}

// ===========================================================================
// 3. Request validation helpers.
// ===========================================================================

class BodyError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function validateReason(raw: unknown): GovernanceApiReason {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('missing_reason', 'A structured reason {code, text} is required.', 422);
  }
  const rec = raw as Record<string, unknown>;
  const code = rec['code'];
  const text = rec['text'];
  if (typeof code !== 'string' || !REASON_CODE_RE.test(code)) {
    throw new BodyError(
      'invalid_reason',
      'reason.code must match /^[a-z][a-z0-9_.-]{1,63}$/.',
      422,
    );
  }
  if (
    typeof text !== 'string' ||
    text.trim().length < REASON_TEXT_MIN ||
    text.length > REASON_TEXT_MAX
  ) {
    throw new BodyError(
      'invalid_reason',
      `reason.text must be ${REASON_TEXT_MIN}..${REASON_TEXT_MAX} non-blank characters.`,
      422,
    );
  }
  return { code, text };
}

interface ParsedExport {
  readonly scope: Record<string, unknown>;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly reason: GovernanceApiReason;
}

/** Validate + normalize an audit-export body (contract `additionalProperties:false`). */
function parseExportRequest(raw: unknown): ParsedExport {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BodyError('invalid_body', 'The request body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!['scope', 'period', 'reason'].includes(k)) {
      throw new BodyError('unexpected_field', `Unexpected field: ${k}`);
    }
  }

  const scope = body['scope'];
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new BodyError('invalid_scope', 'scope must be a JSON object.');
  }
  const period = body['period'];
  if (typeof period !== 'object' || period === null || Array.isArray(period)) {
    throw new BodyError('invalid_period', 'period must be a JSON object with from/to.');
  }
  const p = period as Record<string, unknown>;
  const from = p['from'];
  const to = p['to'];
  if (typeof from !== 'string' || Number.isNaN(Date.parse(from))) {
    throw new BodyError('invalid_period_from', 'period.from must be an RFC3339 date-time.');
  }
  if (typeof to !== 'string' || Number.isNaN(Date.parse(to))) {
    throw new BodyError('invalid_period_to', 'period.to must be an RFC3339 date-time.');
  }
  if (Date.parse(to) < Date.parse(from)) {
    throw new BodyError('invalid_period', 'period.to must be at or after period.from.', 422);
  }
  const reason = validateReason(body['reason']);

  return {
    scope: scope as Record<string, unknown>,
    periodFrom: from,
    periodTo: to,
    reason,
  };
}

// ===========================================================================
// 4. Handlers.
// ===========================================================================

/** GET /compliance/coverage — the reconstructed scoped coverage picture (SC-012 / SC-013). */
function getComplianceCoverage(deps: ComplianceRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required.',
      );
    }
    const url = new URL(c.req.url, 'http://internal');

    const systemIdRaw = url.searchParams.get('system_id');
    if (systemIdRaw !== null && systemIdRaw !== '' && !isUuid(systemIdRaw)) {
      return problem(c, 400, 'invalid_system_id', 'Bad Request', 'system_id must be a uuid.');
    }
    const publicationIdRaw = url.searchParams.get('publication_id');
    if (publicationIdRaw !== null && publicationIdRaw !== '' && !isUuid(publicationIdRaw)) {
      return problem(
        c,
        400,
        'invalid_publication_id',
        'Bad Request',
        'publication_id must be a uuid.',
      );
    }
    const atRaw = url.searchParams.get('at');
    let at: EpochMillis | undefined;
    if (atRaw !== null && atRaw !== '') {
      const parsed = Date.parse(atRaw);
      if (Number.isNaN(parsed)) {
        return problem(c, 400, 'invalid_at', 'Bad Request', 'at must be an RFC3339 date-time.');
      }
      at = parsed as EpochMillis;
    }

    const query: CoverageQuery = {
      tenantId,
      ...(systemIdRaw !== null && systemIdRaw !== '' ? { systemId: systemIdRaw as Uuid } : {}),
      ...(publicationIdRaw !== null && publicationIdRaw !== ''
        ? { publicationId: publicationIdRaw as Uuid }
        : {}),
      ...(at !== undefined ? { at } : {}),
    };

    let view: CoverageView | undefined;
    try {
      view = await deps.coverage(query);
    } catch {
      return problem(
        c,
        500,
        'coverage_unavailable',
        'Coverage unavailable',
        'The compliance coverage could not be reconstructed.',
        ['retry after the coverage projection is reachable'],
      );
    }

    if (view === undefined) {
      return problem(
        c,
        404,
        'coverage_not_found',
        'Not Found',
        'No coverage in this tenant scope for the requested scope.',
      );
    }

    return c.json(coverageToWire(view), 200);
  };
}

/** GET /evidence/{evidenceId} — the authorized evidence envelope metadata (FR-053). */

function getFrameworkMatrix(deps: ComplianceRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required.',
      );
    }
    if (deps.frameworkMatrix === undefined) {
      return problem(
        c,
        503,
        'framework_matrix_unavailable',
        'Framework matrix unavailable',
        'The truthful framework-matrix projection is not configured.',
        ['restore the framework mapping projection before making compliance claims'],
      );
    }
    const url = new URL(c.req.url, 'http://internal');
    const publicationIdRaw = url.searchParams.get('publication_id');
    if (publicationIdRaw !== null && publicationIdRaw !== '' && !isUuid(publicationIdRaw)) {
      return problem(
        c,
        400,
        'invalid_publication_id',
        'Bad Request',
        'publication_id must be a uuid.',
      );
    }
    const atRaw = url.searchParams.get('at');
    let at: EpochMillis | undefined;
    if (atRaw !== null && atRaw !== '') {
      const parsed = Date.parse(atRaw);
      if (Number.isNaN(parsed)) {
        return problem(c, 400, 'invalid_at', 'Bad Request', 'at must be an RFC3339 date-time.');
      }
      at = parsed as EpochMillis;
    }
    const query: FrameworkMatrixQuery = {
      tenantId,
      ...(publicationIdRaw !== null && publicationIdRaw !== ''
        ? { publicationId: publicationIdRaw as Uuid }
        : {}),
      ...(at === undefined ? {} : { at }),
    };
    let view: FrameworkMatrixView | undefined;
    try {
      view = await deps.frameworkMatrix(query);
    } catch {
      return problem(
        c,
        500,
        'framework_matrix_failed',
        'Framework matrix unavailable',
        'The framework matrix could not be reconstructed.',
        ['retry after the framework projection is reachable'],
      );
    }
    if (view === undefined || view.tenantId !== tenantId) {
      return problem(
        c,
        404,
        'framework_matrix_not_found',
        'Not Found',
        'No framework matrix exists in this tenant scope.',
      );
    }
    const tenantRows = view.rows.filter((row) => row.tenantId === tenantId);
    return c.json(frameworkMatrixToWire({ ...view, rows: tenantRows }), 200);
  };
}
function getEvidenceMetadata(deps: ComplianceRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required.',
      );
    }
    const evidenceId = evidenceIdOf(c);
    if (evidenceId === undefined) {
      return problem(
        c,
        400,
        'invalid_evidence_id',
        'Bad Request',
        'The evidence id path segment must be a uuid.',
      );
    }

    let envelope: EvidenceEnvelopeView | undefined;
    try {
      envelope = await deps.readEvidence(tenantId, evidenceId);
    } catch {
      return problem(
        c,
        500,
        'evidence_unavailable',
        'Evidence unavailable',
        'The evidence envelope could not be read.',
        ['retry after the evidence store is reachable'],
      );
    }

    if (envelope === undefined) {
      return problem(
        c,
        404,
        'evidence_not_found',
        'Not Found',
        'No such evidence in this tenant scope.',
      );
    }

    return c.json({ ...envelope }, 200);
  };
}

/** POST /audit/exports — enqueue an asynchronous audit export (FR-056, SC-022); 202. */
function requestAuditExport(deps: ComplianceRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = requireTenant(c);
    if (tenantId === undefined) {
      return problem(
        c,
        403,
        'tenant_scope_required',
        'Forbidden',
        'A valid tenant scope is required.',
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
    }

    let parsed: ParsedExport;
    try {
      parsed = parseExportRequest(raw);
    } catch (e) {
      if (e instanceof BodyError) {
        return problem(
          c,
          e.httpStatus,
          e.code,
          e.httpStatus === 422 ? 'Unprocessable' : 'Bad Request',
          e.message,
        );
      }
      throw e;
    }

    const correlationId = c.ctx?.correlationId ?? '';
    const idempotencyKey = c.req.header('idempotency-key');
    const command: AuditExportCommand = {
      tenantId,
      requesterPrincipalId: principalOf(c),
      correlationId,
      scope: parsed.scope,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
      reason: parsed.reason,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    let result: AuditExportResult;
    try {
      result = await deps.enqueueExport(command);
    } catch {
      return problem(
        c,
        500,
        'audit_export_failed',
        'Audit export could not be enqueued',
        'The audit export request was not accepted.',
        ['retry with the same idempotency key'],
      );
    }

    if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
    const body: GovernanceApiOperationAccepted = {
      operation_id: String(result.operationId),
      status: result.status,
      correlation_id: correlationId,
      audit_event_id: String(result.auditEventId),
      idempotent_replay: result.idempotentReplay,
    };
    return c.json(body, 202);
  };
}

// ===========================================================================
// 5. Small shared helpers.
// ===========================================================================

function evidenceIdOf(c: AppContext): Uuid | undefined {
  const id = c.req.param('evidenceId');
  if (id !== undefined && isUuid(id)) return id as Uuid;
  return undefined;
}

// ===========================================================================
// 6. Registration.
// ===========================================================================

/**
 * Mount the three compliance routes onto `app`. All are AUTHENTICATED and tenant-scoped. Paths are
 * registered WITHOUT the version prefix — `App.get`/`App.post` prepend `API_PREFIX` (`/v1`).
 */
export function registerComplianceRoutes(app: App, deps: ComplianceRouteDeps): App {
  app.get('/compliance/coverage', getComplianceCoverage(deps));
  app.get('/framework-matrix', getFrameworkMatrix(deps));
  app.get('/evidence/:evidenceId', getEvidenceMetadata(deps));
  app.post('/audit/exports', requestAuditExport(deps));
  return app;
}
