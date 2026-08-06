import type { App, AppContext, RouteHandler } from '../server.ts';

import {
  evaluateGovernedPlatformAuthority,
  type GovernedPlatformAction,
  type RoleKey,
} from '@trustcircle/authz';
import {
  compareReviewSnapshots as compareSignedReviewSnapshots,
  createSignedReviewSnapshot,
  type AiEvaluation,
  type AiIncident,
  type AiUseCase,
  type ConnectorCertification,
  type EntityResolutionCase,
  type EvidenceAttestation,
  type EvidenceRequest,
  type ImprovementHypothesis,
  type EvidenceSufficiencyDecision,
  type GovernedCopilotResponse,
  type GovernedRegisterRecord,
  type GovernedSubscription,
  type GovernedView,
  type MonitoringCase,
  type ReviewSnapshotComparison,
  type ReviewSnapshotSource,
  type SignedReviewSnapshot,
} from '@trustcircle/application';
import {
  GovernedPlatformContractError,
  parseGovernedCommand,
  parseGovernedSignedCommand,
  parseGovernedTransition,
  requireGovernedCorrelationId,
  requireGovernedIfMatch,
  requireGovernedIdempotencyKey,
} from '@trustcircle/contracts';
import {
  GovernedPlatformInvariantError,
  assertGovernedTenant,
  governedDigest,
  isUuid,
} from '@trustcircle/domain';

export interface ReviewSnapshotCommit {
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly snapshot: SignedReviewSnapshot;
}

export interface ReviewSnapshotCommitResult {
  readonly snapshot: SignedReviewSnapshot;
  readonly idempotentReplay: boolean;
}

export interface ReviewComparisonCommit {
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly comparison: ReviewSnapshotComparison;
}

export interface GovernedReviewRouteStore {
  listSnapshots(
    tenantId: string,
  ): readonly SignedReviewSnapshot[] | Promise<readonly SignedReviewSnapshot[]>;
  readReviewSource(
    tenantId: string,
    reviewId: string,
    reviewVersion: number,
  ): ReviewSnapshotSource | undefined | Promise<ReviewSnapshotSource | undefined>;
  readSnapshot(
    tenantId: string,
    snapshotId: string,
  ): SignedReviewSnapshot | undefined | Promise<SignedReviewSnapshot | undefined>;
  commitSnapshot(
    commit: ReviewSnapshotCommit,
  ): ReviewSnapshotCommitResult | Promise<ReviewSnapshotCommitResult>;
  commitComparison(
    commit: ReviewComparisonCommit,
  ): ReviewSnapshotComparison | Promise<ReviewSnapshotComparison>;
}

export interface GovernedRouteCommandContext {
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly authorityDecisionId?: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface GovernedRouteTransitionContext extends GovernedRouteCommandContext {
  readonly recordId: string;
  readonly transition: string;
  readonly expectedVersion: number;
}

export interface GovernedDeliveryAttemptView {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly channel: string;
  readonly status: string;
  readonly attempt: number;
  readonly lastAttemptAt: number;
  readonly nextAttemptAt?: number;
  readonly terminalReason?: string;
  readonly correlationId: string;
}

export interface GovernedCollaborationRoutePort {
  listRegisterRecords(
    tenantId: string,
    query: { readonly kind?: string; readonly status?: string },
  ): readonly GovernedRegisterRecord[] | Promise<readonly GovernedRegisterRecord[]>;
  createRegisterRecord(
    command: GovernedRouteCommandContext,
  ): GovernedRegisterRecord | Promise<GovernedRegisterRecord>;
  transitionRegisterRecord(
    command: GovernedRouteTransitionContext,
  ): GovernedRegisterRecord | Promise<GovernedRegisterRecord>;
  listGovernedViews(
    tenantId: string,
    principalId: string,
  ): readonly GovernedView[] | Promise<readonly GovernedView[]>;
  createGovernedView(command: GovernedRouteCommandContext): GovernedView | Promise<GovernedView>;
  createSubscription(
    command: GovernedRouteCommandContext,
  ): GovernedSubscription | Promise<GovernedSubscription>;
  listDeliveryAttempts(
    tenantId: string,
    principalId: string,
    status?: string,
  ): readonly GovernedDeliveryAttemptView[] | Promise<readonly GovernedDeliveryAttemptView[]>;
}

export interface GovernedEvidenceAttestationCommand extends GovernedRouteCommandContext {
  readonly recordId: string;
  readonly signature: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly digest: string;
    readonly value: string;
  };
}

export type GovernedEvidenceTransitionCommand = GovernedRouteTransitionContext;

export interface GovernedEvidencePackageAccepted {
  readonly operationId: string;
  readonly status: 'accepted' | 'pending_reconciliation';
  readonly idempotentReplay: boolean;
}

export interface GovernedEvidencePackageVerificationView {
  readonly packageId: string;
  readonly valid: boolean;
  readonly reason: string | null;
  readonly verifiedAt: number;
  readonly canonicalDigest: string;
}

export interface GovernedEvidenceRoutePort {
  listEvidenceRequests(
    tenantId: string,
    principalId: string,
  ): readonly EvidenceRequest[] | Promise<readonly EvidenceRequest[]>;
  issueEvidenceRequest(
    command: GovernedRouteCommandContext,
  ): EvidenceRequest | Promise<EvidenceRequest>;
  attestEvidence(command: GovernedEvidenceAttestationCommand):
    | { readonly request: EvidenceRequest; readonly attestation: EvidenceAttestation }
    | Promise<{
        readonly request: EvidenceRequest;
        readonly attestation: EvidenceAttestation;
      }>;
  decideEvidenceSufficiency(command: GovernedEvidenceTransitionCommand):
    | {
        readonly request: EvidenceRequest;
        readonly decision: EvidenceSufficiencyDecision;
      }
    | Promise<{
        readonly request: EvidenceRequest;
        readonly decision: EvidenceSufficiencyDecision;
      }>;
  requestEvidencePackage(
    command: GovernedRouteCommandContext,
  ): GovernedEvidencePackageAccepted | Promise<GovernedEvidencePackageAccepted>;
  verifyEvidencePackage(input: {
    readonly tenantId: string;
    readonly actorPrincipalId: string;
    readonly correlationId: string;
    readonly packageId: string;
  }): GovernedEvidencePackageVerificationView | Promise<GovernedEvidencePackageVerificationView>;
}

export interface GovernedAsyncOperationAccepted {
  readonly operationId: string;
  readonly status: 'accepted' | 'completed' | 'pending_reconciliation';
  readonly idempotentReplay: boolean;
}

export interface GovernedChangePublicationCommand extends GovernedRouteCommandContext {
  readonly transition: string;
}

export interface GovernedMonitoringRoutePort {
  ingestControlObservation(
    command: GovernedRouteCommandContext,
  ): GovernedAsyncOperationAccepted | Promise<GovernedAsyncOperationAccepted>;
  listMonitoringCases(
    tenantId: string,
    principalId: string,
    status?: string,
  ): readonly MonitoringCase[] | Promise<readonly MonitoringCase[]>;
  requestImpactPreview(
    command: GovernedRouteCommandContext,
  ): GovernedAsyncOperationAccepted | Promise<GovernedAsyncOperationAccepted>;
  publishGovernedChange(
    command: GovernedChangePublicationCommand,
  ): GovernedAsyncOperationAccepted | Promise<GovernedAsyncOperationAccepted>;
}

export interface GovernedAiRecordCommand extends GovernedRouteCommandContext {
  readonly recordId: string;
}

export interface GovernedAiRoutePort {
  listAiUseCases(
    tenantId: string,
    principalId: string,
  ): readonly AiUseCase[] | Promise<readonly AiUseCase[]>;
  createAiUseCase(command: GovernedRouteCommandContext): AiUseCase | Promise<AiUseCase>;
  transitionAiUseCase(command: GovernedRouteTransitionContext): AiUseCase | Promise<AiUseCase>;
  recordAiEvaluation(
    command: GovernedAiRecordCommand,
  ):
    | { readonly useCase: AiUseCase; readonly evaluation: AiEvaluation }
    | Promise<{ readonly useCase: AiUseCase; readonly evaluation: AiEvaluation }>;
  reportAiIncident(
    command: GovernedAiRecordCommand,
  ):
    | { readonly useCase: AiUseCase; readonly incident: AiIncident }
    | Promise<{ readonly useCase: AiUseCase; readonly incident: AiIncident }>;
  createCopilotExchange(
    command: GovernedRouteCommandContext,
  ): GovernedCopilotResponse | Promise<GovernedCopilotResponse>;
}

export interface GovernedConnectorDefinitionView {
  readonly id: string;
  readonly tenantId: string;
  readonly adapterId: string;
  readonly exactVersion: string;
  readonly manifestDigest: string;
  readonly authorPrincipalId: string;
  readonly status: string;
  readonly digest: string;
}

export interface GovernedConnectorHealthView {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly certificationId: string;
  readonly status: string;
  readonly lastAttemptAt: number;
  readonly lastSuccessAt?: number;
  readonly retryState: string;
  readonly terminalFailureRef?: string;
  readonly reconciliationAvailable: boolean;
}

export interface GovernedConnectorRecordCommand extends GovernedRouteCommandContext {
  readonly recordId: string;
}

export interface GovernedConnectorRoutePort {
  createConnectorDefinition(
    command: GovernedRouteCommandContext,
  ): GovernedConnectorDefinitionView | Promise<GovernedConnectorDefinitionView>;
  requestConformanceRun(
    command: GovernedConnectorRecordCommand,
  ): GovernedAsyncOperationAccepted | Promise<GovernedAsyncOperationAccepted>;
  listConnectorCertifications(
    tenantId: string,
    principalId: string,
  ): readonly ConnectorCertification[] | Promise<readonly ConnectorCertification[]>;
  certifyConnectorVersion(
    command: GovernedRouteCommandContext,
  ): ConnectorCertification | Promise<ConnectorCertification>;
  revokeConnectorCertification(
    command: GovernedRouteTransitionContext,
  ): ConnectorCertification | Promise<ConnectorCertification>;
  listConnectorHealth(
    tenantId: string,
    principalId: string,
  ): readonly GovernedConnectorHealthView[] | Promise<readonly GovernedConnectorHealthView[]>;
  requestConnectorReconciliation(
    command: GovernedRouteCommandContext,
  ): GovernedAsyncOperationAccepted | Promise<GovernedAsyncOperationAccepted>;
}

export interface GovernedImprovementRoutePort {
  listImprovementHypotheses(
    tenantId: string,
    principalId: string,
  ): readonly ImprovementHypothesis[] | Promise<readonly ImprovementHypothesis[]>;
  createImprovementHypothesis(
    command: GovernedRouteCommandContext,
  ): ImprovementHypothesis | Promise<ImprovementHypothesis>;
  transitionImprovementHypothesis(
    command: GovernedRouteTransitionContext,
  ): ImprovementHypothesis | Promise<ImprovementHypothesis>;
}

export interface GovernedEntityResolutionRoutePort {
  listEntityResolutionCases(
    tenantId: string,
    principalId: string,
  ): readonly EntityResolutionCase[] | Promise<readonly EntityResolutionCase[]>;
  createEntityResolutionCase(
    command: GovernedRouteCommandContext,
  ): EntityResolutionCase | Promise<EntityResolutionCase>;
  transitionEntityResolutionCase(
    command: GovernedRouteTransitionContext,
  ): EntityResolutionCase | Promise<EntityResolutionCase>;
}

export interface GovernedPlatformRouteDeps {
  readonly now: () => number;
  readonly nextId: (kind: 'review-comparison') => string;
  readonly signDigest: (digest: string) => string;
  readonly reviews: GovernedReviewRouteStore;
  readonly collaboration?: GovernedCollaborationRoutePort;
  readonly evidence?: GovernedEvidenceRoutePort;
  readonly monitoring?: GovernedMonitoringRoutePort;
  readonly ai?: GovernedAiRoutePort;
  readonly connectors?: GovernedConnectorRoutePort;
  readonly improvements?: GovernedImprovementRoutePort;
  readonly entityResolution?: GovernedEntityResolutionRoutePort;
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

function problem(
  c: AppContext,
  status: number,
  code: string,
  title: string,
  detail: string,
  safeNextActions: readonly string[] = [],
): Response {
  return c.json(
    {
      type: 'about:blank#' + code,
      title,
      status,
      code,
      detail,
      correlation_id: c.ctx?.correlationId ?? 'unknown',
      retryable: status >= 500,
      safe_next_actions: [...safeNextActions],
    },
    status,
  );
}

function context(c: AppContext): {
  tenantId: string;
  principalId: string;
  roles: readonly string[];
  hasDecisionAuthority: boolean;
} {
  const ctx = c.ctx;
  if (ctx === undefined || ctx.tenantId.length === 0) {
    throw new RequestError(403, 'tenant_scope_required', 'A tenant scope is required.');
  }
  return {
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
    roles: ctx.roles,
    hasDecisionAuthority: ctx.hasDecisionAuthority,
  };
}

const GOVERNED_MUTATION_ACTIONS: readonly [RegExp, GovernedPlatformAction][] = [
  [/\/review-snapshots$/, 'sign_review_snapshot'],
  [/\/register-records\/[^/]+\/transitions$/, 'transition_register_record'],
  [/\/register-records$/, 'create_register_record'],
  [/\/governed-views$/, 'create_governed_view'],
  [/\/subscriptions$/, 'create_subscription'],
  [/\/evidence-requests\/[^/]+\/attestations$/, 'attest_evidence'],
  [/\/evidence-requests\/[^/]+\/sufficiency-decisions$/, 'decide_evidence_sufficiency'],
  [/\/evidence-requests$/, 'issue_evidence_request'],
  [/\/evidence-packages$/, 'request_evidence_package'],
  [/\/control-observations$/, 'ingest_control_observation'],
  [/\/impact-previews$/, 'request_impact_preview'],
  [/\/change-publications$/, 'publish_governed_change'],
  [/\/ai-use-cases\/[^/]+\/transitions$/, 'transition_ai_use_case'],
  [/\/ai-use-cases\/[^/]+\/evaluations$/, 'record_ai_evaluation'],
  [/\/ai-use-cases\/[^/]+\/incidents$/, 'report_ai_incident'],
  [/\/ai-use-cases$/, 'create_ai_use_case'],
  [/\/copilot\/exchanges$/, 'create_copilot_exchange'],
  [/\/connector-definitions\/[^/]+\/conformance-runs$/, 'request_connector_conformance'],
  [/\/connector-definitions$/, 'create_connector_definition'],
  [/\/connector-certifications\/[^/]+\/transitions$/, 'revoke_connector_certification'],
  [/\/connector-certifications$/, 'certify_connector_version'],
  [/\/connector-reconciliations$/, 'request_connector_reconciliation'],
  [/\/improvement-hypotheses\/[^/]+\/transitions$/, 'transition_improvement_hypothesis'],
  [/\/improvement-hypotheses$/, 'create_improvement_hypothesis'],
  [/\/entity-resolution-cases\/[^/]+\/transitions$/, 'transition_entity_resolution_case'],
  [/\/entity-resolution-cases$/, 'create_entity_resolution_case'],
];

function requireMutationAuthority(c: AppContext): void {
  const ctx = context(c);
  const action = GOVERNED_MUTATION_ACTIONS.find(([pattern]) => pattern.test(c.req.path))?.[1];
  if (action === undefined) {
    throw new RequestError(
      403,
      'governed_authority_denied',
      'The governed action is not authorized.',
    );
  }
  const decision = evaluateGovernedPlatformAuthority({
    action,
    authenticatedTenantId: ctx.tenantId,
    resourceTenantId: ctx.tenantId,
    roles: ctx.roles as readonly RoleKey[],
    boundaryOnly: true,
  });
  if (!decision.allowed) {
    throw new RequestError(
      403,
      'governed_authority_denied',
      'The governed action is not authorized.',
    );
  }
}

function operationHeaders(
  c: AppContext,
  requireIdempotency: boolean,
): { correlationId: string; idempotencyKey?: string } {
  const correlationId = requireGovernedCorrelationId(c.req.header('x-correlation-id'));
  if (!requireIdempotency) return { correlationId };
  requireMutationAuthority(c);
  return {
    correlationId,
    idempotencyKey: requireGovernedIdempotencyKey(c.req.header('idempotency-key')),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'invalid_' + field, field + ' must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RequestError(400, 'unknown_field', 'The request contains an unsupported field.');
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new RequestError(400, 'missing_field', 'The request is missing a required field.');
    }
  }
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new RequestError(400, 'invalid_' + field, field + ' must be a UUID.');
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RequestError(400, 'invalid_' + field, field + ' must be a positive integer.');
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new RequestError(400, 'invalid_' + field, field + ' must be bounded text.');
  }
  return value.trim();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RequestError(400, 'invalid_' + field, field + ' must be a boolean.');
  }
  return value;
}

function snapshotToWire(snapshot: SignedReviewSnapshot): Readonly<Record<string, unknown>> {
  return {
    id: snapshot.id,
    tenant_id: snapshot.tenantId,
    review_id: snapshot.reviewId,
    review_version: snapshot.reviewVersion,
    snapshot_schema_version: snapshot.snapshotSchemaVersion,
    scope: snapshot.scope,
    scope_digest: snapshot.scopeDigest,
    period_start: new Date(snapshot.periodStart).toISOString(),
    period_end: new Date(snapshot.periodEnd).toISOString(),
    registry_versions: snapshot.registryVersions,
    policy_versions: snapshot.policyVersions,
    source_revision_set: snapshot.sourceRevisionSet,
    outcomes: snapshot.outcomes,
    evidence_refs: snapshot.evidenceRefs,
    decision_refs: snapshot.decisionRefs,
    canonical_digest: snapshot.canonicalDigest,
    signer_principal_id: snapshot.signerPrincipalId,
    signer_role: snapshot.signerRole,
    authority_decision_id: snapshot.authorityDecisionId,
    signed_at: new Date(snapshot.signedAt).toISOString(),
    signature_algorithm: snapshot.signatureAlgorithm,
    signature_key_id: snapshot.signatureKeyId,
    signature: snapshot.signature,
    correction_notice_refs: snapshot.correctionNoticeRefs,
  };
}

function comparisonToWire(comparison: ReviewSnapshotComparison): Readonly<Record<string, unknown>> {
  return {
    id: comparison.id,
    tenant_id: comparison.tenantId,
    baseline_snapshot_id: comparison.baselineSnapshotId,
    target_snapshot_id: comparison.targetSnapshotId,
    compatibility: comparison.compatibility,
    incompatibility_reasons: comparison.incompatibilityReasons,
    added_refs: comparison.addedRefs,
    removed_refs: comparison.removedRefs,
    improved_refs: comparison.improvedRefs,
    regressed_refs: comparison.regressedRefs,
    unchanged_refs: comparison.unchangedRefs,
    unknown_refs: comparison.unknownRefs,
    generated_at: new Date(comparison.generatedAt).toISOString(),
    generated_by_principal_id: comparison.generatedByPrincipalId,
    source_digest: comparison.sourceDigest,
  };
}

function handleError(c: AppContext, error: unknown): Response {
  if (error instanceof RequestError) {
    return problem(
      c,
      error.status,
      error.code,
      error.status === 404 ? 'Not Found' : 'Bad Request',
      error.message,
    );
  }
  if (error instanceof GovernedPlatformContractError) {
    return problem(c, 400, error.code, 'Bad Request', error.message);
  }
  if (error instanceof GovernedPlatformInvariantError) {
    if (error.code === 'cross_tenant') {
      return problem(
        c,
        404,
        'resource_not_found',
        'Not Found',
        'No such resource in this tenant scope.',
      );
    }
    if (error.code === 'stale_version') {
      return problem(c, 409, 'stale_version', 'Conflict', error.message, [
        'reload the current record and retry with its version',
      ]);
    }
    if (error.code === 'self_approval') {
      return problem(c, 403, 'separation_of_duties', 'Forbidden', error.message);
    }
    return problem(c, 422, error.code, 'Unprocessable', error.message);
  }
  if (error instanceof SyntaxError) {
    return problem(c, 400, 'invalid_body', 'Bad Request', 'The request body is not valid JSON.');
  }
  if (error instanceof Error) {
    if (/tenant/i.test(error.message)) {
      return problem(
        c,
        404,
        'resource_not_found',
        'Not Found',
        'No such resource in this tenant scope.',
      );
    }
    if (
      /Impact preview publication authority is invalid: (source_drift|proposal_drift|expired)/i.test(
        error.message,
      )
    ) {
      return problem(
        c,
        409,
        'impact_preview_invalidated',
        'Conflict',
        'The preview expired or a bound proposal/source version changed; regenerate it.',
        ['regenerate the impact preview from current source versions'],
      );
    }
    return problem(c, 422, 'governed_operation_rejected', 'Unprocessable', error.message);
  }
  return problem(
    c,
    500,
    'governed_platform_failure',
    'Unavailable',
    'The governed operation failed.',
  );
}

function listReviewSnapshots(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const { tenantId } = context(c);
      const items = [...(await deps.reviews.listSnapshots(tenantId))]
        .filter((item) => item.tenantId === tenantId)
        .sort((a, b) => a.signedAt - b.signedAt || a.id.localeCompare(b.id));
      const generatedAt = deps.now();
      const sourceCursor =
        items.length === 0 ? 'none' : governedDigest(items.map((item) => item.canonicalDigest));
      return c.json(
        {
          items: items.map(snapshotToWire),
          metadata: {
            source_cursor: sourceCursor,
            generated_at: new Date(generatedAt).toISOString(),
            freshness: items.length === 0 ? 'unknown' : 'current',
            partial_coverage: false,
            coverage_gaps: [],
            safe_next_actions:
              items.length === 0
                ? ['complete and sign a governed review before comparing periods']
                : ['select two compatible signed periods to compare'],
          },
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

interface SnapshotInput {
  readonly snapshotId: string;
  readonly reviewId: string;
  readonly reviewVersion: number;
  readonly independent: boolean;
  readonly algorithm: string;
  readonly keyId: string;
}

function parseSnapshotInput(value: Readonly<Record<string, unknown>>): SnapshotInput {
  exact(value as Record<string, unknown>, [
    'snapshot_id',
    'review_id',
    'review_version',
    'require_independent_signer',
    'signature_algorithm',
    'signature_key_id',
  ]);
  return {
    snapshotId: uuid(value['snapshot_id'], 'snapshot_id'),
    reviewId: uuid(value['review_id'], 'review_id'),
    reviewVersion: positiveInteger(value['review_version'], 'review_version'),
    independent: boolean(value['require_independent_signer'], 'require_independent_signer'),
    algorithm: requiredText(value['signature_algorithm'], 'signature_algorithm'),
    keyId: requiredText(value['signature_key_id'], 'signature_key_id'),
  };
}

function signReviewSnapshot(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      if (!ctx.hasDecisionAuthority) {
        throw new RequestError(
          403,
          'signing_authority_required',
          'Current signing authority is required.',
        );
      }
      const headers = operationHeaders(c, true);
      const command = parseGovernedCommand(await c.req.json());
      if (command.authority_decision_id === undefined) {
        throw new RequestError(
          400,
          'authority_decision_required',
          'A current authority decision is required.',
        );
      }
      const input = parseSnapshotInput(command.input);
      const source = await deps.reviews.readReviewSource(
        ctx.tenantId,
        input.reviewId,
        input.reviewVersion,
      );
      if (source === undefined) {
        throw new RequestError(
          404,
          'review_not_found',
          'No such completed review in this tenant scope.',
        );
      }
      assertGovernedTenant(source.tenantId, ctx.tenantId);
      const snapshot = createSignedReviewSnapshot({
        snapshotId: input.snapshotId,
        source,
        signerPrincipalId: ctx.principalId,
        signerRole: ctx.roles[0] ?? 'unknown',
        authorityDecisionId: command.authority_decision_id,
        requireIndependentSigner: input.independent,
        signedAt: deps.now(),
        signatureAlgorithm: input.algorithm,
        signatureKeyId: input.keyId,
        signDigest: deps.signDigest,
      });
      const result = await deps.reviews.commitSnapshot({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: command.reason,
        snapshot,
      });
      if (result.idempotentReplay) c.setHeader('idempotent-replay', 'true');
      return c.json(snapshotToWire(result.snapshot), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function compareReviewPeriods(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const { correlationId } = operationHeaders(c, false);
      const body = record(await c.req.json(), 'comparison');
      exact(body, ['baseline_snapshot_id', 'target_snapshot_id']);
      const baselineId = uuid(body['baseline_snapshot_id'], 'baseline_snapshot_id');
      const targetId = uuid(body['target_snapshot_id'], 'target_snapshot_id');
      const [baseline, target] = await Promise.all([
        deps.reviews.readSnapshot(ctx.tenantId, baselineId),
        deps.reviews.readSnapshot(ctx.tenantId, targetId),
      ]);
      if (baseline === undefined || target === undefined) {
        throw new RequestError(
          404,
          'snapshot_not_found',
          'No such signed snapshot in this tenant scope.',
        );
      }
      const comparison = compareSignedReviewSnapshots({
        comparisonId: uuid(deps.nextId('review-comparison'), 'comparison_id'),
        tenantId: ctx.tenantId,
        baseline,
        target,
        generatedAt: deps.now(),
        generatedByPrincipalId: ctx.principalId,
      });
      const committed = await deps.reviews.commitComparison({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId,
        comparison,
      });
      return c.json(comparisonToWire(committed), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function collaborationPort(deps: GovernedPlatformRouteDeps): GovernedCollaborationRoutePort {
  if (deps.collaboration === undefined) {
    throw new RequestError(
      503,
      'collaboration_unavailable',
      'The governed collaboration boundary is unavailable.',
    );
  }
  return deps.collaboration;
}

function rejectTenantOverride(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const member of value) rejectTenantOverride(member);
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (normalized === 'tenantid' || normalized === 'tenant') {
      throw new RequestError(
        400,
        'tenant_override_forbidden',
        'Tenant identity is derived from authenticated context.',
      );
    }
    rejectTenantOverride(member);
  }
}

function commandContext(
  c: AppContext,
  command: ReturnType<typeof parseGovernedCommand>,
): GovernedRouteCommandContext {
  const ctx = context(c);
  const headers = operationHeaders(c, true);
  rejectTenantOverride(command.input);
  return {
    tenantId: ctx.tenantId,
    actorPrincipalId: ctx.principalId,
    correlationId: headers.correlationId,
    idempotencyKey: headers.idempotencyKey!,
    reason: command.reason,
    ...(command.authority_decision_id === undefined
      ? {}
      : { authorityDecisionId: command.authority_decision_id }),
    input: command.input,
  };
}

function registerToWire(record: GovernedRegisterRecord): Readonly<Record<string, unknown>> {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    kind: record.kind,
    title: record.title,
    description: record.description,
    owner_principal_id: record.ownerPrincipalId,
    created_by_principal_id: record.createdByPrincipalId,
    status: record.status,
    version: record.version,
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
    ...(record.expiresAt === undefined
      ? {}
      : { expires_at: new Date(record.expiresAt).toISOString() }),
    ...(record.reviewAt === undefined
      ? {}
      : { review_at: new Date(record.reviewAt).toISOString() }),
    compensating_control_refs: record.compensatingControlRefs,
    history: record.history.map((entry) => ({
      sequence: entry.sequence,
      action: entry.action,
      ...(entry.fromStatus === undefined ? {} : { from_status: entry.fromStatus }),
      to_status: entry.toStatus,
      actor_principal_id: entry.actorPrincipalId,
      ...(entry.authorityDecisionId === undefined
        ? {}
        : { authority_decision_id: entry.authorityDecisionId }),
      reason: entry.reason,
      occurred_at: new Date(entry.occurredAt).toISOString(),
      record_digest: entry.recordDigest,
    })),
  };
}

function viewToWire(view: GovernedView): Readonly<Record<string, unknown>> {
  return {
    id: view.id,
    tenant_id: view.tenantId,
    owner_principal_id: view.ownerPrincipalId,
    name: view.name,
    resource_kind: view.resourceKind,
    filter: view.filter,
    fields: view.fields,
    shared_with_principal_ids: view.sharedWithPrincipalIds,
    query_digest: view.queryDigest,
    version: view.version,
    created_at: new Date(view.createdAt).toISOString(),
  };
}

function subscriptionToWire(subscription: GovernedSubscription): Readonly<Record<string, unknown>> {
  return {
    id: subscription.id,
    tenant_id: subscription.tenantId,
    view_id: subscription.viewId,
    view_digest: subscription.viewDigest,
    recipient_principal_id: subscription.recipientPrincipalId,
    channels: subscription.channels,
    cadence_minutes: subscription.cadenceMinutes,
    ...(subscription.quietPeriod === undefined
      ? {}
      : {
          quiet_period: {
            start_minute_utc: subscription.quietPeriod.startMinuteUtc,
            end_minute_utc: subscription.quietPeriod.endMinuteUtc,
          },
        }),
    escalation_after_minutes: subscription.escalationAfterMinutes,
    created_at: new Date(subscription.createdAt).toISOString(),
    ...(subscription.lastDeliveredAt === undefined
      ? {}
      : { last_delivered_at: new Date(subscription.lastDeliveredAt).toISOString() }),
  };
}

function deliveryAttemptToWire(
  attempt: GovernedDeliveryAttemptView,
): Readonly<Record<string, unknown>> {
  return {
    id: attempt.id,
    tenant_id: attempt.tenantId,
    subscription_id: attempt.subscriptionId,
    channel: attempt.channel,
    status: attempt.status,
    attempt: attempt.attempt,
    last_attempt_at: new Date(attempt.lastAttemptAt).toISOString(),
    ...(attempt.nextAttemptAt === undefined
      ? {}
      : { next_attempt_at: new Date(attempt.nextAttemptAt).toISOString() }),
    ...(attempt.terminalReason === undefined ? {} : { terminal_reason: attempt.terminalReason }),
    correlation_id: attempt.correlationId,
  };
}

function resourcePage(
  items: readonly Readonly<Record<string, unknown>>[],
  deps: GovernedPlatformRouteDeps,
): Readonly<Record<string, unknown>> {
  return {
    items,
    metadata: {
      source_cursor: governedDigest(items),
      generated_at: new Date(deps.now()).toISOString(),
      freshness: items.length === 0 ? 'unknown' : 'current',
      partial_coverage: false,
      coverage_gaps: [],
    },
  };
}

function listRegisterRecords(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const query = new URL(c.req.url).searchParams;
      const kind = query.get('kind') ?? undefined;
      const status = query.get('status') ?? undefined;
      const records = await collaborationPort(deps).listRegisterRecords(ctx.tenantId, {
        ...(kind === undefined ? {} : { kind }),
        ...(status === undefined ? {} : { status }),
      });
      return c.json(
        resourcePage(
          records.filter((record) => record.tenantId === ctx.tenantId).map(registerToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createRegisterRecord(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      const record = await collaborationPort(deps).createRegisterRecord(commandContext(c, command));
      return c.json(registerToWire(record), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function transitionRegisterRecord(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const recordId = uuid(c.req.param('recordId'), 'record_id');
      const transition = parseGovernedTransition(await c.req.json());
      rejectTenantOverride(transition.input);
      const record = await collaborationPort(deps).transitionRegisterRecord({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: transition.reason,
        authorityDecisionId: transition.authority_decision_id,
        input: transition.input ?? {},
        recordId,
        transition: transition.transition,
        expectedVersion: requireGovernedIfMatch(c.req.header('if-match')),
      });
      c.setHeader('etag', '"' + record.version + '"');
      return c.json(registerToWire(record), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listGovernedViews(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const views = await collaborationPort(deps).listGovernedViews(ctx.tenantId, ctx.principalId);
      return c.json(
        resourcePage(views.filter((view) => view.tenantId === ctx.tenantId).map(viewToWire), deps),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createGovernedViewRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      const view = await collaborationPort(deps).createGovernedView(commandContext(c, command));
      return c.json(viewToWire(view), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createSubscriptionRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      const subscription = await collaborationPort(deps).createSubscription(
        commandContext(c, command),
      );
      return c.json(subscriptionToWire(subscription), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listDeliveryAttempts(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const status = new URL(c.req.url).searchParams.get('status') ?? undefined;
      const attempts = await collaborationPort(deps).listDeliveryAttempts(
        ctx.tenantId,
        ctx.principalId,
        status,
      );
      return c.json(
        resourcePage(
          attempts
            .filter((attempt) => attempt.tenantId === ctx.tenantId)
            .map(deliveryAttemptToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}
function aiPort(deps: GovernedPlatformRouteDeps): GovernedAiRoutePort {
  if (deps.ai === undefined) {
    throw new RequestError(
      503,
      'ai_governance_unavailable',
      'The governed AI lifecycle and assistance boundary is unavailable.',
    );
  }
  return deps.ai;
}

function aiUseCaseToWire(item: AiUseCase): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    name: item.name,
    purpose: item.purpose,
    owner_principal_id: item.ownerPrincipalId,
    affected_people: item.affectedPeople,
    affected_systems: item.affectedSystems,
    risk_class: item.riskClass,
    obligation_refs: item.obligationRefs,
    control_refs: item.controlRefs,
    oversight_plan: item.oversightPlan,
    prohibited_uses: item.prohibitedUses,
    monitoring_rule_refs: item.monitoringRuleRefs,
    retirement_conditions: item.retirementConditions,
    lifecycle_state: item.lifecycleState,
    active_component_version_refs: item.activeComponentVersionRefs,
    components: item.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      provider_ref: component.providerRef,
      model_ref: component.modelRef,
      prompt_digest: component.promptDigest,
      tool_manifest_digest: component.toolManifestDigest,
      data_source_refs: component.dataSourceRefs,
      version: component.version,
      version_ref: component.versionRef,
      change_class: component.changeClass,
      approved_scope: component.approvedScope,
      status: component.status,
      created_at: new Date(component.createdAt).toISOString(),
      canonical_digest: component.canonicalDigest,
    })),
    evaluations: item.evaluations.map((evaluation) => ({
      id: evaluation.id,
      component_version_refs: evaluation.componentVersionRefs,
      evaluation_plan_version: evaluation.evaluationPlanVersion,
      dataset_evidence_refs: evaluation.datasetEvidenceRefs,
      measures: evaluation.measures,
      thresholds: evaluation.thresholds,
      results: evaluation.results,
      limitations: evaluation.limitations,
      evaluator_principal_id: evaluation.evaluatorPrincipalId,
      reviewed_by_principal_id: evaluation.reviewedByPrincipalId,
      verdict: evaluation.verdict,
      evaluated_at: new Date(evaluation.evaluatedAt).toISOString(),
      canonical_digest: evaluation.canonicalDigest,
    })),
    approvals: item.approvals.map((approval) => ({
      id: approval.id,
      component_version_refs: approval.componentVersionRefs,
      approved_by_principal_id: approval.approvedByPrincipalId,
      authority_decision_id: approval.authorityDecisionId,
      approved_at: new Date(approval.approvedAt).toISOString(),
      valid_until: new Date(approval.validUntil).toISOString(),
      canonical_digest: approval.canonicalDigest,
    })),
    incidents: item.incidents.map((incident) => ({
      id: incident.id,
      component_version_refs: incident.componentVersionRefs,
      severity: incident.severity,
      affected_scope: incident.affectedScope,
      detected_at: new Date(incident.detectedAt).toISOString(),
      source: incident.source,
      evidence_refs: incident.evidenceRefs,
      status: incident.status,
      owner_principal_id: incident.ownerPrincipalId,
      containment: incident.containment,
      corrective_actions: incident.correctiveActions,
      canonical_digest: incident.canonicalDigest,
    })),
    history: item.history.map((history) => ({
      version: history.version,
      prior_state: history.priorState,
      state: history.state,
      actor_principal_id: history.actorPrincipalId,
      reason: history.reason,
      authority_decision_id: history.authorityDecisionId ?? null,
      occurred_at: new Date(history.occurredAt).toISOString(),
      canonical_digest: history.canonicalDigest,
    })),
    resource_version: item.resourceVersion,
    created_at: new Date(item.createdAt).toISOString(),
    updated_at: new Date(item.updatedAt).toISOString(),
  };
}

function copilotToWire(item: GovernedCopilotResponse): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    label: item.label,
    authority: item.authority,
    facts: item.facts.map((fact) => ({
      label: fact.label,
      value: fact.value,
      citation_ref: fact.citationRef,
    })),
    inferences: item.inferences,
    suggestions: item.suggestions,
    citations: item.citations.map((citation) => ({
      ref: citation.ref,
      version: citation.version,
      digest: citation.digest,
      kind: citation.kind,
      citation_ref: citation.citationRef,
    })),
    limitation_codes: item.limitationCodes,
    abstention_code: item.abstentionCode,
    audit_metadata: item.auditMetadata,
    response_digest: item.responseDigest,
  };
}

function connectorPort(deps: GovernedPlatformRouteDeps): GovernedConnectorRoutePort {
  if (deps.connectors === undefined) {
    throw new RequestError(
      503,
      'connector_governance_unavailable',
      'The governed connector authoring and certification boundary is unavailable.',
    );
  }
  return deps.connectors;
}

function connectorDefinitionToWire(
  item: GovernedConnectorDefinitionView,
): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    adapter_id: item.adapterId,
    exact_version: item.exactVersion,
    manifest_digest: item.manifestDigest,
    author_principal_id: item.authorPrincipalId,
    status: item.status,
    digest: item.digest,
  };
}

function connectorCertificationToWire(
  item: ConnectorCertification,
): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    connector_id: item.connectorId,
    exact_version: item.exactVersion,
    manifest_digest: item.manifestDigest,
    report_digest: item.reportDigest,
    suite_version: item.suiteVersion,
    author_principal_id: item.authorPrincipalId,
    certifier_principal_id: item.certifierPrincipalId,
    certification_decision_id: item.certificationDecisionId,
    allowed_tenant_refs: item.allowedTenantRefs,
    allowed_scopes: item.allowedScopes,
    allowed_capabilities: item.allowedCapabilities,
    credential_classes: item.credentialClasses,
    valid_from: new Date(item.validFrom).toISOString(),
    expires_at: new Date(item.expiresAt).toISOString(),
    certified_at: new Date(item.certifiedAt).toISOString(),
    status: item.status,
    revoked_at: item.revokedAt === undefined ? null : new Date(item.revokedAt).toISOString(),
    revoked_by_principal_id: item.revokedByPrincipalId ?? null,
    revocation_decision_id: item.revocationDecisionId ?? null,
    revocation_reason: item.revocationReason ?? null,
    history: item.history.map((entry) => ({
      status: entry.status,
      actor_principal_id: entry.actorPrincipalId,
      authority_decision_id: entry.authorityDecisionId,
      reason: entry.reason,
      at: new Date(entry.at).toISOString(),
    })),
  };
}

function connectorHealthToWire(
  item: GovernedConnectorHealthView,
): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    connector_id: item.connectorId,
    certification_id: item.certificationId,
    status: item.status,
    last_attempt_at: new Date(item.lastAttemptAt).toISOString(),
    last_success_at:
      item.lastSuccessAt === undefined ? null : new Date(item.lastSuccessAt).toISOString(),
    retry_state: item.retryState,
    terminal_failure_ref: item.terminalFailureRef ?? null,
    reconciliation_available: item.reconciliationAvailable,
  };
}

function improvementPort(deps: GovernedPlatformRouteDeps): GovernedImprovementRoutePort {
  if (deps.improvements === undefined) {
    throw new RequestError(
      503,
      'improvement_feedback_unavailable',
      'The governed product-improvement boundary is unavailable.',
    );
  }
  return deps.improvements;
}

function entityResolutionPort(deps: GovernedPlatformRouteDeps): GovernedEntityResolutionRoutePort {
  if (deps.entityResolution === undefined) {
    throw new RequestError(
      503,
      'entity_resolution_unavailable',
      'The governed entity-resolution boundary is unavailable.',
    );
  }
  return deps.entityResolution;
}

function aggregateMeasureToWire(
  measure: ImprovementHypothesis['aggregateMeasures'][number],
): Readonly<Record<string, unknown>> {
  return {
    ref: measure.ref,
    schema_version: measure.schemaVersion,
    metric: measure.metric,
    route_family: measure.routeFamily,
    window_start: new Date(measure.windowStart).toISOString(),
    window_end: new Date(measure.windowEnd).toISOString(),
    sample_count: measure.sampleCount,
    aggregation: measure.aggregation,
    retention_policy_id: measure.retentionPolicyId,
    collection_policy_decision_id: measure.collectionPolicyDecisionId,
  };
}

function improvementHypothesisToWire(
  item: ImprovementHypothesis,
): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    product_scope: item.productScope,
    analytics_schema_version: item.analyticsSchemaVersion,
    aggregate_measure_refs: item.aggregateMeasureRefs,
    aggregate_measures: item.aggregateMeasures.map(aggregateMeasureToWire),
    hypothesis: item.hypothesis,
    owner_principal_id: item.ownerPrincipalId,
    created_by_principal_id: item.createdByPrincipalId,
    expected_outcome: item.expectedOutcome,
    baseline_window: {
      start: new Date(item.baselineWindow.start).toISOString(),
      end: new Date(item.baselineWindow.end).toISOString(),
    },
    target_window: {
      start: new Date(item.targetWindow.start).toISOString(),
      end: new Date(item.targetWindow.end).toISOString(),
    },
    status: item.status,
    decision_refs: item.decisionRefs,
    delivery_status: item.deliveryStatus,
    outcome_measures: item.outcomeMeasures.map(aggregateMeasureToWire),
    conclusion: item.conclusion ?? null,
    resource_version: item.resourceVersion,
    created_at: new Date(item.createdAt).toISOString(),
    updated_at: new Date(item.updatedAt).toISOString(),
    history: item.history.map((entry) => ({
      sequence: entry.sequence,
      action: entry.action,
      actor_principal_id: entry.actorPrincipalId,
      authority_decision_id: entry.authorityDecisionId ?? null,
      reason: entry.reason,
      occurred_at: new Date(entry.occurredAt).toISOString(),
      record_digest: entry.recordDigest,
    })),
  };
}

function entityResolutionCaseToWire(item: EntityResolutionCase): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    source_identities: item.sourceIdentities.map((source) => ({
      tenant_id: source.tenantId,
      source_system_id: source.sourceSystemId,
      source_record_id: source.sourceRecordId,
      source_digest: source.sourceDigest,
    })),
    candidate_canonical_entity_id: item.candidateCanonicalEntityId,
    proposal_type: item.proposalType,
    confidence_band: item.confidenceBand,
    match_reasons: item.matchReasons,
    conflict_reasons: item.conflictReasons,
    affected_projection_refs: item.affectedProjectionRefs,
    proposed_by_principal_id: item.proposedByPrincipalId,
    status: item.status,
    reviewed_by_principal_id: item.reviewedByPrincipalId ?? null,
    decided_by_principal_id: item.decidedByPrincipalId ?? null,
    authority_decision_id: item.authorityDecisionId ?? null,
    decision_reason: item.decisionReason ?? null,
    decided_at: item.decidedAt === undefined ? null : new Date(item.decidedAt).toISOString(),
    rollback_of_case_id: item.rollbackOfCaseId ?? null,
    applied_projection_refs: item.appliedProjectionRefs,
    failed_projection_refs: item.failedProjectionRefs,
    projection_invalidations: item.projectionInvalidations.map((invalidation) => ({
      projection_ref: invalidation.projectionRef,
      reason: invalidation.reason,
      case_id: invalidation.caseId,
      case_version: invalidation.caseVersion,
    })),
    reconciliation_available: item.reconciliationAvailable,
    resource_version: item.resourceVersion,
    created_at: new Date(item.createdAt).toISOString(),
    updated_at: new Date(item.updatedAt).toISOString(),
    history: item.history.map((entry) => ({
      sequence: entry.sequence,
      transition: entry.transition,
      from_status: entry.fromStatus ?? null,
      to_status: entry.toStatus,
      actor_principal_id: entry.actorPrincipalId,
      authority_decision_id: entry.authorityDecisionId ?? null,
      reason: entry.reason,
      occurred_at: new Date(entry.occurredAt).toISOString(),
      record_digest: entry.recordDigest,
    })),
  };
}

function monitoringPort(deps: GovernedPlatformRouteDeps): GovernedMonitoringRoutePort {
  if (deps.monitoring === undefined) {
    throw new RequestError(
      503,
      'monitoring_unavailable',
      'The governed monitoring and change boundary is unavailable.',
    );
  }
  return deps.monitoring;
}
function evidencePort(deps: GovernedPlatformRouteDeps): GovernedEvidenceRoutePort {
  if (deps.evidence === undefined) {
    throw new RequestError(
      503,
      'evidence_assurance_unavailable',
      'The governed evidence-assurance boundary is unavailable.',
    );
  }
  return deps.evidence;
}

function evidenceRequestToWire(request: EvidenceRequest): Readonly<Record<string, unknown>> {
  return {
    id: request.id,
    tenant_id: request.tenantId,
    scope: request.scope,
    requested_evidence_types: request.requestedEvidenceTypes,
    owner_principal_id: request.ownerPrincipalId,
    requester_principal_id: request.requesterPrincipalId,
    due_at: new Date(request.dueAt).toISOString(),
    expires_at: new Date(request.expiresAt).toISOString(),
    reason: request.reason,
    status: request.status,
    version: request.version,
    created_at: new Date(request.createdAt).toISOString(),
    updated_at: new Date(request.updatedAt).toISOString(),
  };
}

function attestationToWire(attestation: EvidenceAttestation): Readonly<Record<string, unknown>> {
  return {
    id: attestation.id,
    tenant_id: attestation.tenantId,
    request_id: attestation.requestId,
    request_version: attestation.requestVersion,
    owner_principal_id: attestation.ownerPrincipalId,
    evidence_versions: attestation.evidenceVersions.map((binding) => ({
      evidence_id: binding.evidenceId,
      version: binding.version,
      digest: binding.digest,
    })),
    statement: attestation.statement,
    signature: attestation.signature,
    signed_at: new Date(attestation.signedAt).toISOString(),
    canonical_digest: attestation.canonicalDigest,
  };
}

function sufficiencyToWire(
  decision: EvidenceSufficiencyDecision,
): Readonly<Record<string, unknown>> {
  return {
    id: decision.id,
    tenant_id: decision.tenantId,
    request_id: decision.requestId,
    request_version: decision.requestVersion,
    attestation_id: decision.attestationId,
    attestation_digest: decision.attestationDigest,
    decision: decision.decision,
    reviewer_principal_id: decision.reviewerPrincipalId,
    reason: decision.reason,
    decided_at: new Date(decision.decidedAt).toISOString(),
    canonical_digest: decision.canonicalDigest,
  };
}

function listEvidenceRequests(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const requests = await evidencePort(deps).listEvidenceRequests(ctx.tenantId, ctx.principalId);
      return c.json(
        resourcePage(
          requests
            .filter((request) => request.tenantId === ctx.tenantId)
            .map(evidenceRequestToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function issueEvidenceRequestRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      const request = await evidencePort(deps).issueEvidenceRequest(commandContext(c, command));
      return c.json(evidenceRequestToWire(request), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function attestEvidenceRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const recordId = uuid(c.req.param('recordId'), 'record_id');
      const command = parseGovernedSignedCommand(await c.req.json());
      rejectTenantOverride(command.input);
      const result = await evidencePort(deps).attestEvidence({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: command.reason,
        ...(command.authority_decision_id === undefined
          ? {}
          : { authorityDecisionId: command.authority_decision_id }),
        input: command.input,
        recordId,
        signature: {
          algorithm: command.signature.algorithm,
          keyId: command.signature.key_id,
          digest: command.signature.digest,
          value: command.signature.value,
        },
      });
      return c.json(
        {
          request: evidenceRequestToWire(result.request),
          attestation: attestationToWire(result.attestation),
        },
        201,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function decideEvidenceSufficiencyRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const recordId = uuid(c.req.param('recordId'), 'record_id');
      const transition = parseGovernedTransition(await c.req.json());
      rejectTenantOverride(transition.input);
      const result = await evidencePort(deps).decideEvidenceSufficiency({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: transition.reason,
        authorityDecisionId: transition.authority_decision_id,
        input: transition.input ?? {},
        recordId,
        transition: transition.transition,
        expectedVersion: requireGovernedIfMatch(c.req.header('if-match')),
      });
      return c.json(
        {
          request: evidenceRequestToWire(result.request),
          decision: sufficiencyToWire(result.decision),
        },
        201,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function requestEvidencePackageRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      const governed = commandContext(c, command);
      const accepted = await evidencePort(deps).requestEvidencePackage(governed);
      if (accepted.idempotentReplay) c.setHeader('idempotent-replay', 'true');
      return c.json(
        {
          operation_id: accepted.operationId,
          status: accepted.status,
          correlation_id: governed.correlationId,
          idempotent_replay: accepted.idempotentReplay,
        },
        202,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function verifyEvidencePackageRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const { correlationId } = operationHeaders(c, false);
      const packageId = uuid(c.req.param('recordId'), 'package_id');
      const verification = await evidencePort(deps).verifyEvidencePackage({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId,
        packageId,
      });
      return c.json(
        {
          package_id: verification.packageId,
          valid: verification.valid,
          reason: verification.reason,
          verified_at: new Date(verification.verifiedAt).toISOString(),
          canonical_digest: verification.canonicalDigest,
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}
function monitoringCaseToWire(item: MonitoringCase): Readonly<Record<string, unknown>> {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    correlation_policy_id: item.correlationPolicyId,
    correlation_policy_version: item.correlationPolicyVersion,
    case_key: item.caseKey,
    control_id: item.controlId,
    affected_scope: item.affectedScope,
    condition_class: item.conditionClass,
    severity: item.severity,
    status: item.status,
    assurance_outcome: item.assuranceOutcome,
    owner_principal_id: item.ownerPrincipalId,
    first_observed_at: new Date(item.firstObservedAt).toISOString(),
    last_observed_at: new Date(item.lastObservedAt).toISOString(),
    last_evaluation_at: new Date(item.lastEvaluationAt).toISOString(),
    observation_refs: item.observationRefs,
    source_health: item.sourceHealth,
    freshness: item.freshness,
    completeness: item.completeness,
    uncertainty_reasons: item.uncertaintyReasons,
    retry_state: item.retryState,
    terminal_failure_ref: item.terminalFailureRef ?? null,
    register_record_id: item.registerRecordId ?? null,
    resource_version: item.resourceVersion,
  };
}

function acceptedOperation(
  c: AppContext,
  accepted: GovernedAsyncOperationAccepted,
  correlationId: string,
): Response {
  if (accepted.idempotentReplay) c.setHeader('idempotent-replay', 'true');
  return c.json(
    {
      operation_id: accepted.operationId,
      status: accepted.status,
      correlation_id: correlationId,
      idempotent_replay: accepted.idempotentReplay,
    },
    202,
  );
}

function ingestControlObservationRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      exact(command.input as Record<string, unknown>, [
        'id',
        'source_id',
        'source_event_id',
        'source_contract_version',
        'asset_id',
        'control_id',
        'condition_id',
        'observed_at',
        'received_at',
        'status',
        'freshness',
        'completeness',
        'confidence',
        'payload_evidence_ref',
        'source_health',
        'correlation_attributes',
      ]);
      uuid(command.input['id'], 'id');
      positiveInteger(command.input['source_contract_version'], 'source_contract_version');
      record(command.input['correlation_attributes'], 'correlation_attributes');
      const governed = commandContext(c, command);
      const accepted = await monitoringPort(deps).ingestControlObservation(governed);
      return acceptedOperation(c, accepted, governed.correlationId);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listMonitoringCasesRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const status = new URL(c.req.url).searchParams.get('status') ?? undefined;
      const cases = await monitoringPort(deps).listMonitoringCases(
        ctx.tenantId,
        ctx.principalId,
        status,
      );
      const items = cases
        .filter(
          (item) =>
            item.tenantId === ctx.tenantId && (status === undefined || item.status === status),
        )
        .map(monitoringCaseToWire);
      const gaps = [
        ...new Set(
          cases
            .filter((item) => item.tenantId === ctx.tenantId)
            .flatMap((item) => item.uncertaintyReasons),
        ),
      ].sort();
      return c.json(
        {
          items,
          metadata: {
            source_cursor: governedDigest(items),
            generated_at: new Date(deps.now()).toISOString(),
            freshness: items.length === 0 ? 'unknown' : 'current',
            partial_coverage: gaps.length > 0,
            coverage_gaps: gaps,
          },
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function requestImpactPreviewRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      exact(command.input as Record<string, unknown>, [
        'preview_id',
        'proposal_type',
        'proposal_ref',
        'proposal_digest',
        'expires_at',
      ]);
      uuid(command.input['preview_id'], 'preview_id');
      const governed = commandContext(c, command);
      const accepted = await monitoringPort(deps).requestImpactPreview(governed);
      return acceptedOperation(c, accepted, governed.correlationId);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function publishGovernedChangeRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const transition = parseGovernedTransition(await c.req.json());
      if (transition.transition !== 'publish') {
        throw new RequestError(
          400,
          'invalid_transition',
          'Only publish is accepted on this route.',
        );
      }
      const input = transition.input ?? {};
      exact(input as Record<string, unknown>, [
        'preview_id',
        'publication_id',
        'proposal_digest',
        'target_version',
        'rollback_plan_ref',
      ]);
      uuid(input['preview_id'], 'preview_id');
      uuid(input['publication_id'], 'publication_id');
      positiveInteger(input['target_version'], 'target_version');
      rejectTenantOverride(input);
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const governed: GovernedChangePublicationCommand = {
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: transition.reason,
        authorityDecisionId: transition.authority_decision_id,
        input,
        transition: transition.transition,
      };
      const accepted = await monitoringPort(deps).publishGovernedChange(governed);
      return acceptedOperation(c, accepted, governed.correlationId);
    } catch (error) {
      return handleError(c, error);
    }
  };
}
function listAiUseCasesRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const items = await aiPort(deps).listAiUseCases(ctx.tenantId, ctx.principalId);
      return c.json(
        resourcePage(
          items.filter((item) => item.tenantId === ctx.tenantId).map(aiUseCaseToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createAiUseCaseRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const command = parseGovernedCommand(await c.req.json());
      exact(command.input as Record<string, unknown>, [
        'id',
        'name',
        'purpose',
        'owner_principal_id',
        'affected_people',
        'affected_systems',
        'risk_class',
        'obligation_refs',
        'control_refs',
        'oversight_plan',
        'prohibited_uses',
        'monitoring_rule_refs',
        'retirement_conditions',
      ]);
      uuid(command.input['id'], 'id');
      const governed = commandContext(c, command);
      const created = await aiPort(deps).createAiUseCase(governed);
      assertGovernedTenant(created.tenantId, governed.tenantId);
      return c.json(aiUseCaseToWire(created), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function transitionAiUseCaseRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const transition = parseGovernedTransition(await c.req.json());
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const input = transition.input ?? {};
      rejectTenantOverride(input);
      const command: GovernedRouteTransitionContext = {
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: transition.reason,
        authorityDecisionId: transition.authority_decision_id,
        input,
        recordId: uuid(c.req.param('recordId'), 'record_id'),
        transition: transition.transition,
        expectedVersion: requireGovernedIfMatch(c.req.header('if-match')),
      };
      const updated = await aiPort(deps).transitionAiUseCase(command);
      assertGovernedTenant(updated.tenantId, ctx.tenantId);
      return c.json(aiUseCaseToWire(updated), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function recordAiEvaluationRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, [
        'evaluation_id',
        'component_version_refs',
        'evaluation_plan_version',
        'dataset_evidence_refs',
        'measures',
        'thresholds',
        'results',
        'limitations',
        'evaluator_principal_id',
        'reviewed_by_principal_id',
        'verdict',
        'evaluated_at',
      ]);
      const governed = commandContext(c, parsed);
      const result = await aiPort(deps).recordAiEvaluation({
        ...governed,
        recordId: uuid(c.req.param('recordId'), 'record_id'),
      });
      assertGovernedTenant(result.useCase.tenantId, governed.tenantId);
      return c.json(
        {
          ...aiUseCaseToWire(result.useCase),
          evaluation_id: result.evaluation.id,
          evaluation_digest: result.evaluation.canonicalDigest,
        },
        201,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function reportAiIncidentRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, [
        'incident_id',
        'component_version_refs',
        'severity',
        'affected_scope',
        'source',
        'evidence_refs',
        'owner_principal_id',
        'containment',
        'corrective_actions',
      ]);
      uuid(parsed.input['incident_id'], 'incident_id');
      const governed = commandContext(c, parsed);
      const result = await aiPort(deps).reportAiIncident({
        ...governed,
        recordId: uuid(c.req.param('recordId'), 'record_id'),
      });
      assertGovernedTenant(result.useCase.tenantId, governed.tenantId);
      return c.json(
        {
          ...aiUseCaseToWire(result.useCase),
          incident_id: result.incident.id,
          incident_digest: result.incident.canonicalDigest,
        },
        201,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createCopilotExchangeRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(
        parsed.input as Record<string, unknown>,
        ['exchange_id', 'purpose', 'query_classification'],
        ['conflicting'],
      );
      uuid(parsed.input['exchange_id'], 'exchange_id');
      const governed = commandContext(c, parsed);
      const exchange = await aiPort(deps).createCopilotExchange(governed);
      assertGovernedTenant(exchange.tenantId, governed.tenantId);
      return c.json(copilotToWire(exchange), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listImprovementHypothesesRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const items = await improvementPort(deps).listImprovementHypotheses(
        ctx.tenantId,
        ctx.principalId,
      );
      return c.json(
        resourcePage(
          items.filter((item) => item.tenantId === ctx.tenantId).map(improvementHypothesisToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createImprovementHypothesisRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, [
        'id',
        'product_scope',
        'analytics_schema_version',
        'aggregate_measures',
        'hypothesis',
        'owner_principal_id',
        'expected_outcome',
        'baseline_window',
        'target_window',
      ]);
      uuid(parsed.input['id'], 'improvement_hypothesis_id');
      const governed = commandContext(c, parsed);
      const item = await improvementPort(deps).createImprovementHypothesis(governed);
      assertGovernedTenant(item.tenantId, governed.tenantId);
      return c.json(improvementHypothesisToWire(item), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function transitionImprovementHypothesisRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedTransition(await c.req.json());
      if (
        !['approve', 'reject', 'start_delivery', 'mark_delivered', 'conclude'].includes(
          parsed.transition,
        )
      ) {
        throw new RequestError(
          422,
          'unsupported_transition',
          'The improvement-hypothesis transition is unsupported.',
        );
      }
      if (
        ['approve', 'reject', 'conclude'].includes(parsed.transition) &&
        parsed.authority_decision_id === undefined
      ) {
        throw new RequestError(
          400,
          'authority_decision_required',
          'A governed improvement decision requires current authority.',
        );
      }
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const input = parsed.input ?? {};
      rejectTenantOverride(input);
      const item = await improvementPort(deps).transitionImprovementHypothesis({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: parsed.reason,
        ...(parsed.authority_decision_id === undefined
          ? {}
          : { authorityDecisionId: parsed.authority_decision_id }),
        input,
        recordId: uuid(c.req.param('recordId'), 'improvement_hypothesis_id'),
        transition: parsed.transition,
        expectedVersion: requireGovernedIfMatch(c.req.header('if-match')),
      });
      assertGovernedTenant(item.tenantId, ctx.tenantId);
      c.setHeader('etag', '"' + item.resourceVersion + '"');
      return c.json(improvementHypothesisToWire(item), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listEntityResolutionCasesRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const items = await entityResolutionPort(deps).listEntityResolutionCases(
        ctx.tenantId,
        ctx.principalId,
      );
      return c.json(
        resourcePage(
          items.filter((item) => item.tenantId === ctx.tenantId).map(entityResolutionCaseToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function createEntityResolutionCaseRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, [
        'id',
        'source_identities',
        'candidate_canonical_entity_id',
        'proposal_type',
        'confidence_band',
        'match_reasons',
        'conflict_reasons',
        'affected_projection_refs',
      ]);
      uuid(parsed.input['id'], 'entity_resolution_case_id');
      const governed = commandContext(c, parsed);
      const item = await entityResolutionPort(deps).createEntityResolutionCase(governed);
      assertGovernedTenant(item.tenantId, governed.tenantId);
      return c.json(entityResolutionCaseToWire(item), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function transitionEntityResolutionCaseRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedTransition(await c.req.json());
      if (
        ![
          'start_review',
          'accept',
          'reject',
          'apply',
          'fail',
          'request_rollback',
          'rollback',
        ].includes(parsed.transition)
      ) {
        throw new RequestError(
          422,
          'unsupported_transition',
          'The entity-resolution transition is unsupported.',
        );
      }
      if (parsed.transition !== 'start_review' && parsed.authority_decision_id === undefined) {
        throw new RequestError(
          400,
          'authority_decision_required',
          'A consequential entity-resolution transition requires current authority.',
        );
      }
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const input = parsed.input ?? {};
      rejectTenantOverride(input);
      const item = await entityResolutionPort(deps).transitionEntityResolutionCase({
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: parsed.reason,
        ...(parsed.authority_decision_id === undefined
          ? {}
          : { authorityDecisionId: parsed.authority_decision_id }),
        input,
        recordId: uuid(c.req.param('recordId'), 'entity_resolution_case_id'),
        transition: parsed.transition,
        expectedVersion: requireGovernedIfMatch(c.req.header('if-match')),
      });
      assertGovernedTenant(item.tenantId, ctx.tenantId);
      c.setHeader('etag', '"' + item.resourceVersion + '"');
      return c.json(entityResolutionCaseToWire(item), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}
function createConnectorDefinitionRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, [
        'id',
        'adapter_id',
        'exact_version',
        'manifest_digest',
        'mapping_refs',
        'credential_class_refs',
        'pagination_policy',
        'failure_policy',
        'schema_version',
      ]);
      uuid(parsed.input['id'], 'definition_id');
      const governed = commandContext(c, parsed);
      const created = await connectorPort(deps).createConnectorDefinition(governed);
      assertGovernedTenant(created.tenantId, governed.tenantId);
      return c.json(connectorDefinitionToWire(created), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function requestConnectorConformanceRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(
        parsed.input as Record<string, unknown>,
        ['environment_digest'],
        ['fixture_digests', 'tool_versions'],
      );
      const governed = commandContext(c, parsed);
      const accepted = await connectorPort(deps).requestConformanceRun({
        ...governed,
        recordId: uuid(c.req.param('recordId'), 'definition_id'),
      });
      return acceptedOperation(c, accepted, governed.correlationId);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listConnectorCertificationsRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const items = await connectorPort(deps).listConnectorCertifications(
        ctx.tenantId,
        ctx.principalId,
      );
      return c.json(
        resourcePage(
          items.filter((item) => item.tenantId === ctx.tenantId).map(connectorCertificationToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function certifyConnectorRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, [
        'id',
        'connector_id',
        'exact_version',
        'manifest_digest',
        'report_digest',
        'report_manifest_digest',
        'suite_version',
        'report_passed',
        'report_signature_valid',
        'author_principal_id',
        'allowed_tenant_refs',
        'allowed_scopes',
        'allowed_capabilities',
        'credential_classes',
        'valid_from',
        'expires_at',
      ]);
      if (parsed.authority_decision_id === undefined) {
        throw new RequestError(
          400,
          'authority_decision_required',
          'Connector certification requires a current authority decision.',
        );
      }
      uuid(parsed.input['id'], 'certification_id');
      const governed = commandContext(c, parsed);
      const certification = await connectorPort(deps).certifyConnectorVersion(governed);
      assertGovernedTenant(certification.tenantId, governed.tenantId);
      return c.json(connectorCertificationToWire(certification), 201);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function revokeConnectorCertificationRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedTransition(await c.req.json());
      if (parsed.transition !== 'revoke') {
        throw new RequestError(
          422,
          'unsupported_transition',
          'Only the governed revoke transition is supported.',
        );
      }
      if (parsed.authority_decision_id === undefined) {
        throw new RequestError(
          400,
          'authority_decision_required',
          'Connector revocation requires a current authority decision.',
        );
      }
      const ctx = context(c);
      const headers = operationHeaders(c, true);
      const input = parsed.input ?? {};
      rejectTenantOverride(input);
      const command: GovernedRouteTransitionContext = {
        tenantId: ctx.tenantId,
        actorPrincipalId: ctx.principalId,
        correlationId: headers.correlationId,
        idempotencyKey: headers.idempotencyKey!,
        reason: parsed.reason,
        authorityDecisionId: parsed.authority_decision_id,
        input,
        recordId: uuid(c.req.param('recordId'), 'certification_id'),
        transition: parsed.transition,
        expectedVersion: requireGovernedIfMatch(c.req.header('if-match')),
      };
      const certification = await connectorPort(deps).revokeConnectorCertification(command);
      assertGovernedTenant(certification.tenantId, ctx.tenantId);
      return c.json(connectorCertificationToWire(certification), 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function listConnectorHealthRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const ctx = context(c);
      const items = await connectorPort(deps).listConnectorHealth(ctx.tenantId, ctx.principalId);
      return c.json(
        resourcePage(
          items.filter((item) => item.tenantId === ctx.tenantId).map(connectorHealthToWire),
          deps,
        ),
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function requestConnectorReconciliationRoute(deps: GovernedPlatformRouteDeps): RouteHandler {
  return async (c) => {
    try {
      const parsed = parseGovernedCommand(await c.req.json());
      exact(parsed.input as Record<string, unknown>, ['connector_id']);
      const governed = commandContext(c, parsed);
      const accepted = await connectorPort(deps).requestConnectorReconciliation(governed);
      return acceptedOperation(c, accepted, governed.correlationId);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

export function registerGovernedPlatformRoutes(app: App, deps: GovernedPlatformRouteDeps): App {
  app.get('/review-snapshots', listReviewSnapshots(deps));
  app.post('/review-snapshots', signReviewSnapshot(deps));
  app.post('/review-comparisons', compareReviewPeriods(deps));
  app.get('/register-records', listRegisterRecords(deps));
  app.post('/register-records', createRegisterRecord(deps));
  app.post('/register-records/:recordId/transitions', transitionRegisterRecord(deps));
  app.get('/governed-views', listGovernedViews(deps));
  app.post('/governed-views', createGovernedViewRoute(deps));
  app.post('/subscriptions', createSubscriptionRoute(deps));
  app.get('/delivery-attempts', listDeliveryAttempts(deps));
  app.get('/evidence-requests', listEvidenceRequests(deps));
  app.post('/evidence-requests', issueEvidenceRequestRoute(deps));
  app.post('/evidence-requests/:recordId/attestations', attestEvidenceRoute(deps));
  app.post(
    '/evidence-requests/:recordId/sufficiency-decisions',
    decideEvidenceSufficiencyRoute(deps),
  );
  app.post('/evidence-packages', requestEvidencePackageRoute(deps));
  app.post('/evidence-packages/:recordId/verify', verifyEvidencePackageRoute(deps));
  app.post('/control-observations', ingestControlObservationRoute(deps));
  app.get('/monitoring-cases', listMonitoringCasesRoute(deps));
  app.post('/impact-previews', requestImpactPreviewRoute(deps));
  app.post('/change-publications', publishGovernedChangeRoute(deps));
  app.get('/ai-use-cases', listAiUseCasesRoute(deps));
  app.post('/ai-use-cases', createAiUseCaseRoute(deps));
  app.post('/ai-use-cases/:recordId/transitions', transitionAiUseCaseRoute(deps));
  app.post('/ai-use-cases/:recordId/evaluations', recordAiEvaluationRoute(deps));
  app.post('/ai-use-cases/:recordId/incidents', reportAiIncidentRoute(deps));
  app.post('/copilot/exchanges', createCopilotExchangeRoute(deps));
  app.get('/improvement-hypotheses', listImprovementHypothesesRoute(deps));
  app.post('/improvement-hypotheses', createImprovementHypothesisRoute(deps));
  app.post(
    '/improvement-hypotheses/:recordId/transitions',
    transitionImprovementHypothesisRoute(deps),
  );
  app.get('/entity-resolution-cases', listEntityResolutionCasesRoute(deps));
  app.post('/entity-resolution-cases', createEntityResolutionCaseRoute(deps));
  app.post(
    '/entity-resolution-cases/:recordId/transitions',
    transitionEntityResolutionCaseRoute(deps),
  );
  app.post('/connector-definitions', createConnectorDefinitionRoute(deps));
  app.post(
    '/connector-definitions/:recordId/conformance-runs',
    requestConnectorConformanceRoute(deps),
  );
  app.get('/connector-certifications', listConnectorCertificationsRoute(deps));
  app.post('/connector-certifications', certifyConnectorRoute(deps));
  app.post(
    '/connector-certifications/:recordId/transitions',
    revokeConnectorCertificationRoute(deps),
  );
  app.get('/connector-health', listConnectorHealthRoute(deps));
  app.post('/connector-reconciliations', requestConnectorReconciliationRoute(deps));
  return app;
}
