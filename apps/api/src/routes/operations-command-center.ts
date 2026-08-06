import { createHash } from 'node:crypto';

import type { App, AppContext, RouteHandler } from '../server.ts';

import {
  AttentionCursorError,
  OperationsReadForbiddenError,
  OperationalCaseCommandError,
  operationsAuthorityPlan,
  type AttentionFilters,
  type AttentionQueueService,
  type OperationalCaseService,
  type OperationsRole,
} from '@trustcircle/application';
import {
  OPERATIONS_ATTENTION_DOMAINS,
  OperationsContractError,
  encodeOperationsPageCursor,
  isOperationsCaseStatus,
  operationalCaseEtag,
  parseCreateOperationalCaseRequest,
  parseOperationsLimit,
  parseOperationsPageCursor,
  parseSlaEvaluationRequest,
  parseTransitionOperationalCaseRequest,
  requireOperationalCaseIfMatch,
  requireOperationsIdempotencyKey,
  type OperationsSourceReferenceWire,
} from '@trustcircle/contracts';
import {
  isUuid,
  type AttentionDomain,
  type AttentionFreshness,
  type AttentionOwnerPosture,
  type AttentionSeverity,
  type AttentionSourceReference,
  type AttentionTimePosture,
  type OperationalCase,
} from '@trustcircle/domain';

const SEVERITIES = new Set<AttentionSeverity>(['critical', 'high', 'medium', 'low', 'unknown']);
const OWNERSHIP = new Set<AttentionOwnerPosture>([
  'assigned_to_me',
  'assigned',
  'unowned',
  'unknown',
]);
const TIME_POSTURES = new Set<AttentionTimePosture>([
  'breached',
  'imminent',
  'due',
  'none',
  'unknown',
]);
const FRESHNESS = new Set<AttentionFreshness>(['current', 'stale', 'degraded', 'unknown']);

export interface OperationsCommandCenterRouteDeps {
  readonly attention: AttentionQueueService;
  readonly cases: OperationalCaseService;
  readonly now: () => number;
}

function problem(
  c: AppContext,
  status: number,
  code: string,
  detail: string,
  safeNextActions: readonly string[] = [],
): Response {
  const titles: Readonly<Record<number, string>> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    412: 'Precondition Failed',
    422: 'Unprocessable Content',
    500: 'Internal Error',
    503: 'Unavailable',
  };
  return c.json(
    {
      type: `about:blank#${code}`,
      title: titles[status] ?? 'Request Failed',
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

function tenant(c: AppContext): string | undefined {
  const value = c.ctx?.tenantId;
  return value && isUuid(value) ? value : undefined;
}

function roles(c: AppContext): readonly OperationsRole[] {
  return (c.ctx?.roles ?? []) as readonly OperationsRole[];
}

function queryEnum<T extends string>(
  value: string | null,
  allowed: ReadonlySet<T>,
  code: string,
): T | undefined {
  if (value === null || value === '') return undefined;
  if (!allowed.has(value as T)) throw new OperationsContractError(code);
  return value as T;
}

function sourceToWire(source: AttentionSourceReference) {
  return {
    domain: source.domain,
    record_type: source.recordType,
    record_id: source.recordId,
    ...(source.recordVersion === undefined ? {} : { record_version: source.recordVersion }),
    ...(source.governedProblemKey === undefined
      ? {}
      : { governed_problem_key: source.governedProblemKey }),
    href: source.href,
    observed_at: new Date(source.observedAt).toISOString(),
    ...(source.sourceOwnerId === undefined ? {} : { source_owner_id: source.sourceOwnerId }),
    resolved: source.resolved,
  };
}

function wireToSource(
  value: OperationsSourceReferenceWire,
  tenantId: string,
): AttentionSourceReference {
  return {
    tenantId,
    domain: value.domain,
    recordType: value.record_type,
    recordId: value.record_id,
    ...(value.record_version === undefined ? {} : { recordVersion: value.record_version }),
    ...(value.governed_problem_key === undefined
      ? {}
      : { governedProblemKey: value.governed_problem_key }),
    href: value.href,
    observedAt: Date.parse(value.observed_at),
    ...(value.source_owner_id === undefined ? {} : { sourceOwnerId: value.source_owner_id }),
    resolved: value.resolved,
  };
}

function caseToWire(value: OperationalCase) {
  return {
    id: value.id,
    tenant_id: value.tenantId,
    ...(value.attentionItemId === undefined ? {} : { attention_item_id: value.attentionItemId }),
    source_references: value.sourceReferences.map(sourceToWire),
    title: value.title,
    priority: value.priority,
    status: value.status,
    creator_id: value.creatorId,
    ...(value.ownerId === undefined ? {} : { owner_id: value.ownerId }),
    source_owner_ids: [...value.sourceOwnerIds],
    rationale: value.rationale,
    opened_at: new Date(value.openedAt).toISOString(),
    ...(value.acknowledgedAt === undefined
      ? {}
      : { acknowledged_at: new Date(value.acknowledgedAt).toISOString() }),
    acknowledgement_target_at: new Date(value.acknowledgementTargetAt).toISOString(),
    resolution_target_at: new Date(value.resolutionTargetAt).toISOString(),
    ...(value.verificationTargetAt === undefined
      ? {}
      : { verification_target_at: new Date(value.verificationTargetAt).toISOString() }),
    service_level_policy_id: value.serviceLevelPolicyId,
    service_level_policy_version: value.serviceLevelPolicyVersion,
    escalation_level: value.escalationLevel,
    breach_types: [...value.breachTypes],
    evidence_references: [...value.evidenceReferences],
    ...(value.verification === undefined
      ? {}
      : {
          verification: {
            verifier_id: value.verification.verifierId,
            verified_at: new Date(value.verification.verifiedAt).toISOString(),
            reason: value.verification.reason,
            source_versions: value.verification.sourceVersions.map(sourceToWire),
            evidence_references: [...value.verification.evidenceReferences],
            closure_control_version: value.verification.closureControlVersion,
            service_level_outcome: value.verification.serviceLevelOutcome,
          },
        }),
    version: value.version,
    created_at: new Date(value.createdAt).toISOString(),
    updated_at: new Date(value.updatedAt).toISOString(),
  };
}

function commandContext(
  c: AppContext,
  tenantId: string,
  idempotencyKey: string,
  reason: string,
  at: number,
) {
  const context = c.ctx;
  if (!context) throw new OperationalCaseCommandError('unauthenticated', 401);
  return {
    tenantId,
    actor: {
      principalId: context.principalId,
      roles: roles(c),
      correlationId: context.correlationId,
      causationId: context.causationId,
    },
    idempotencyKey,
    reason,
    at,
  };
}

function transitionToWire(
  value: Awaited<ReturnType<OperationalCaseService['create']>>['mutation']['transition'],
) {
  return {
    id: value.id,
    case_id: value.caseId,
    command: value.command,
    ...(value.fromStatus === undefined ? {} : { from_status: value.fromStatus }),
    ...(value.toStatus === undefined ? {} : { to_status: value.toStatus }),
    actor_id: value.actorId,
    reason: value.reason,
    ...(value.expectedVersion === undefined ? {} : { expected_version: value.expectedVersion }),
    ...(value.actualVersion === undefined ? {} : { actual_version: value.actualVersion }),
    idempotency_key: value.idempotencyKey,
    correlation_id: value.correlationId,
    outcome: value.outcome,
    ...(value.rejectionCode === undefined ? {} : { rejection_code: value.rejectionCode }),
    ...(value.safeNextAction === undefined ? {} : { safe_next_action: value.safeNextAction }),
    occurred_at: new Date(value.occurredAt).toISOString(),
  };
}

function commandResponse(
  c: AppContext,
  result: Awaited<ReturnType<OperationalCaseService['create']>>,
  status = 200,
): Response {
  c.setHeader('etag', operationalCaseEtag(result.mutation.case));
  return c.json(
    {
      outcome: result.outcome,
      case: caseToWire(result.mutation.case),
      transition: transitionToWire(result.mutation.transition),
      reconciled: result.outcome === 'duplicate',
    },
    status,
  );
}

function handleError(c: AppContext, error: unknown): Response {
  if (error instanceof AttentionCursorError) {
    return problem(c, error.code === 'snapshot_changed' ? 409 : 400, error.code, error.message, [
      'Restart the queue traversal from the first page.',
    ]);
  }
  if (error instanceof OperationsReadForbiddenError)
    return problem(
      c,
      403,
      'forbidden',
      'No command-center domain is permitted for this verified role scope.',
    );
  if (error instanceof OperationsContractError) {
    const status = error.code === 'etag_mismatch' ? 412 : 400;
    return problem(
      c,
      status,
      error.code,
      'The request does not satisfy the versioned operations contract.',
    );
  }
  if (error instanceof OperationalCaseCommandError)
    return problem(c, error.status, error.code, error.message, [error.safeNextAction]);
  if (error instanceof RangeError || error instanceof TypeError)
    return problem(c, 422, 'invalid_operation', error.message);
  return problem(
    c,
    500,
    'operations_internal',
    'The operation failed without a confirmed outcome.',
    ['Reconcile through an independent case read before retrying.'],
  );
}

function listAttention(deps: OperationsCommandCenterRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = tenant(c);
    if (!tenantId || !c.ctx)
      return problem(c, 403, 'tenant_scope_required', 'A valid tenant scope is required.');
    try {
      const url = new URL(c.req.url, 'http://internal');
      const domain = queryEnum(
        url.searchParams.get('domain'),
        new Set<AttentionDomain>(OPERATIONS_ATTENTION_DOMAINS),
        'invalid_domain',
      );
      const severity = queryEnum(url.searchParams.get('severity'), SEVERITIES, 'invalid_severity');
      const ownership = queryEnum(
        url.searchParams.get('ownership'),
        OWNERSHIP,
        'invalid_ownership',
      );
      const timePosture = queryEnum(
        url.searchParams.get('time_posture'),
        TIME_POSTURES,
        'invalid_time_posture',
      );
      const freshness = queryEnum(
        url.searchParams.get('freshness'),
        FRESHNESS,
        'invalid_freshness',
      );
      const assignmentRaw = url.searchParams.get('assignment');
      if (assignmentRaw !== null && assignmentRaw !== 'mine' && assignmentRaw !== 'any')
        throw new OperationsContractError('invalid_assignment');
      const filters: AttentionFilters = {
        ...(domain === undefined ? {} : { domain }),
        ...(severity === undefined ? {} : { severity }),
        ...(ownership === undefined ? {} : { ownership }),
        ...(timePosture === undefined ? {} : { timePosture }),
        ...(freshness === undefined ? {} : { freshness }),
        ...(assignmentRaw === null ? {} : { assignment: assignmentRaw }),
      };
      const page = await deps.attention.page({
        tenantId,
        principalId: c.ctx.principalId,
        roles: roles(c),
        evaluatedAt: deps.now(),
        limit: parseOperationsLimit(url.searchParams.get('limit')),
        ...(url.searchParams.get('cursor') === null
          ? {}
          : { cursor: url.searchParams.get('cursor') as string }),
        filters,
      });
      return c.json({
        items: page.items.map((item) => ({
          id: item.id,
          domain: item.domain,
          title: item.title,
          sources: item.sources.map(sourceToWire),
          severity: item.severity,
          impact: item.impact,
          time_posture: item.timePosture,
          owner_posture: item.ownerPosture,
          freshness: item.freshness,
          confidence: item.confidence,
          ranking: {
            version: item.ranking.version,
            evaluated_at: new Date(item.ranking.evaluatedAt).toISOString(),
            vector: [...item.ranking.vector],
            factors: item.ranking.factors,
            display_score: item.ranking.displayScore,
            tie_breaker: item.ranking.tieBreaker,
          },
          observed_at: new Date(item.observedAt).toISOString(),
          ...(item.dueAt === undefined ? {} : { due_at: new Date(item.dueAt).toISOString() }),
          safe_next_action: item.safeNextAction,
          ...(item.caseId === undefined ? {} : { case_id: item.caseId }),
        })),
        coverage: page.coverage.map((coverage) => ({
          domain: coverage.domain,
          quality: coverage.quality,
          ...(coverage.observedAt === undefined
            ? {}
            : { observed_at: new Date(coverage.observedAt).toISOString() }),
          ...(coverage.candidateCount === undefined
            ? {}
            : { candidate_count: coverage.candidateCount }),
          ...(coverage.sourceCursor === undefined ? {} : { source_cursor: coverage.sourceCursor }),
          ...(coverage.failureCode === undefined ? {} : { failure_code: coverage.failureCode }),
          ...(coverage.safeNextAction === undefined
            ? {}
            : { safe_next_action: coverage.safeNextAction }),
        })),
        tenant_id: tenantId,
        evaluated_at: new Date(page.items[0]?.ranking.evaluatedAt ?? deps.now()).toISOString(),
        summary: {
          total: page.summary.total,
          critical: page.summary.critical,
          overdue: page.summary.overdue,
          unowned: page.summary.unowned,
          stale: page.summary.stale,
          assigned_to_me: page.summary.assignedToMe,
        },
        quality: page.quality,
        snapshot_cursor: page.snapshotCursor,
        next_cursor: page.nextCursor,
        ranking_version: page.rankingVersion,
        ...(page.safeNextAction === undefined ? {} : { safe_next_action: page.safeNextAction }),
      });
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function pageCases(input: {
  readonly tenantId: string;
  readonly items: readonly OperationalCase[];
  readonly filters: Readonly<Record<string, string>>;
  readonly limit: number;
  readonly cursor?: string;
}): {
  readonly items: readonly OperationalCase[];
  readonly snapshotCursor: string;
  readonly nextCursor: string | null;
} {
  const snapshot = createHash('sha256')
    .update(
      JSON.stringify({
        tenantId: input.tenantId,
        filters: input.filters,
        items: input.items.map((item) => ({
          id: item.id,
          version: item.version,
          updatedAt: item.updatedAt,
        })),
      }),
    )
    .digest('hex');
  const decoded = input.cursor ? parseOperationsPageCursor(input.cursor) : undefined;
  if (decoded && decoded.snapshot !== snapshot) throw new AttentionCursorError('snapshot_changed');
  const offset = decoded?.offset ?? 0;
  if (offset > input.items.length) throw new OperationsContractError('invalid_cursor');
  const items = input.items.slice(offset, offset + input.limit);
  const nextOffset = offset + items.length;
  return {
    items,
    snapshotCursor: encodeOperationsPageCursor({ snapshot, offset: 0 }),
    nextCursor:
      nextOffset < input.items.length
        ? encodeOperationsPageCursor({ snapshot, offset: nextOffset })
        : null,
  };
}

function listCases(deps: OperationsCommandCenterRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = tenant(c);
    if (!tenantId)
      return problem(c, 403, 'tenant_scope_required', 'A valid tenant scope is required.');
    if (!operationsAuthorityPlan(roles(c)).canReadCases)
      return problem(c, 403, 'forbidden', 'Case visibility is not granted.');
    try {
      const url = new URL(c.req.url, 'http://internal');
      const limit = parseOperationsLimit(url.searchParams.get('limit'));
      const status = url.searchParams.get('status');
      if (status !== null && !isOperationsCaseStatus(status))
        throw new OperationsContractError('invalid_case_status');
      const owner = url.searchParams.get('owner');
      const priority = url.searchParams.get('priority');
      if (priority !== null && !['critical', 'high', 'medium', 'low'].includes(priority))
        throw new OperationsContractError('invalid_case_priority');
      const filtered = (await deps.cases.list(tenantId)).filter(
        (item) =>
          (status === null || item.status === status) &&
          (owner === null || item.ownerId === owner) &&
          (priority === null || item.priority === priority),
      );
      const page = pageCases({
        tenantId,
        items: filtered,
        filters: {
          ...(status === null ? {} : { status }),
          ...(owner === null ? {} : { owner }),
          ...(priority === null ? {} : { priority }),
        },
        limit,
        ...(url.searchParams.get('cursor') === null
          ? {}
          : { cursor: url.searchParams.get('cursor') as string }),
      });
      return c.json({
        tenant_id: tenantId,
        observed_at: new Date(deps.now()).toISOString(),
        items: page.items.map(caseToWire),
        snapshot_cursor: page.snapshotCursor,
        next_cursor: page.nextCursor,
      });
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function getCase(deps: OperationsCommandCenterRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = tenant(c);
    const caseId = c.req.param('caseId');
    if (!tenantId)
      return problem(c, 403, 'tenant_scope_required', 'A valid tenant scope is required.');
    if (!caseId || !isUuid(caseId))
      return problem(c, 400, 'invalid_case_id', 'caseId must be a uuid.');
    if (!operationsAuthorityPlan(roles(c)).canReadCases)
      return problem(c, 403, 'forbidden', 'Case visibility is not granted.');
    const detail = await deps.cases.read(tenantId, caseId);
    if (!detail) return problem(c, 404, 'case_not_found', 'No case exists in this tenant scope.');
    c.setHeader('etag', operationalCaseEtag(detail.case));
    return c.json({
      case: caseToWire(detail.case),
      transitions: detail.transitions.map(transitionToWire),
      escalations: detail.escalations.map((item) => ({
        id: item.id,
        case_id: item.caseId,
        policy_version: item.policyVersion,
        level: item.level,
        breach_type: item.breachType,
        target_role: item.targetRole,
        opened_at: new Date(item.openedAt).toISOString(),
        status: item.status,
      })),
    });
  };
}

function createCaseHandler(deps: OperationsCommandCenterRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = tenant(c);
    if (!tenantId)
      return problem(c, 403, 'tenant_scope_required', 'A valid tenant scope is required.');
    try {
      const body = parseCreateOperationalCaseRequest(await c.req.json());
      const idempotencyKey = requireOperationsIdempotencyKey(c.req.header('idempotency-key'));
      const result = await deps.cases.create(
        commandContext(c, tenantId, idempotencyKey, body.rationale, deps.now()),
        {
          ...(body.attention_item_id === undefined
            ? {}
            : { attentionItemId: body.attention_item_id }),
          sourceReferences: body.source_references.map((source) => wireToSource(source, tenantId)),
          title: body.title,
          priority: body.priority,
          ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
          policyId: body.service_level_policy_id,
          policyVersion: body.service_level_policy_version,
        },
      );
      c.setHeader('location', `/v1/operations/cases/${result.mutation.case.id}`);
      return commandResponse(c, result, result.outcome === 'accepted' ? 201 : 200);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function transitionCaseHandler(deps: OperationsCommandCenterRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = tenant(c);
    const caseId = c.req.param('caseId');
    if (!tenantId)
      return problem(c, 403, 'tenant_scope_required', 'A valid tenant scope is required.');
    if (!caseId || !isUuid(caseId))
      return problem(c, 400, 'invalid_case_id', 'caseId must be a uuid.');
    try {
      const detail = await deps.cases.read(tenantId, caseId);
      if (!detail) return problem(c, 404, 'case_not_found', 'No case exists in this tenant scope.');
      requireOperationalCaseIfMatch(c.req.header('if-match'), detail.case);
      const body = parseTransitionOperationalCaseRequest(await c.req.json());
      const idempotencyKey = requireOperationsIdempotencyKey(c.req.header('idempotency-key'));
      const result = await deps.cases.transition(
        commandContext(c, tenantId, idempotencyKey, body.reason, deps.now()),
        caseId,
        body.expected_version,
        {
          command: body.command,
          ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
          ...(body.evidence_references === undefined
            ? {}
            : { evidenceReferences: body.evidence_references }),
          ...(body.source_versions === undefined
            ? {}
            : {
                sourceVersions: body.source_versions.map((source) =>
                  wireToSource(source, tenantId),
                ),
              }),
        },
      );
      return commandResponse(c, result);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

function evaluateSlaHandler(deps: OperationsCommandCenterRouteDeps): RouteHandler {
  return async (c) => {
    const tenantId = tenant(c);
    const caseId = c.req.param('caseId');
    if (!tenantId)
      return problem(c, 403, 'tenant_scope_required', 'A valid tenant scope is required.');
    if (!caseId || !isUuid(caseId))
      return problem(c, 400, 'invalid_case_id', 'caseId must be a uuid.');
    try {
      const detail = await deps.cases.read(tenantId, caseId);
      if (!detail) return problem(c, 404, 'case_not_found', 'No case exists in this tenant scope.');
      requireOperationalCaseIfMatch(c.req.header('if-match'), detail.case);
      const body = parseSlaEvaluationRequest(await c.req.json());
      const idempotencyKey = requireOperationsIdempotencyKey(c.req.header('idempotency-key'));
      const result = await deps.cases.evaluateSla(
        commandContext(c, tenantId, idempotencyKey, body.reason, Date.parse(body.evaluated_at)),
        caseId,
        body.expected_version,
      );
      return commandResponse(c, result);
    } catch (error) {
      return handleError(c, error);
    }
  };
}

export function registerOperationsCommandCenterRoutes(
  app: App,
  deps: OperationsCommandCenterRouteDeps,
): App {
  app.get('/operations/attention', listAttention(deps));
  app.get('/operations/cases', listCases(deps));
  app.post('/operations/cases', createCaseHandler(deps));
  app.get('/operations/cases/:caseId', getCase(deps));
  app.post('/operations/cases/:caseId/transitions', transitionCaseHandler(deps));
  app.post('/operations/cases/:caseId/sla-evaluations', evaluateSlaHandler(deps));
  return app;
}
