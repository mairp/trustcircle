import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registers = await import(join(ROOT, 'packages/application/src/governed-register-service.ts'));
const views = await import(join(ROOT, 'packages/application/src/governed-view-service.ts'));
const monitoring = await import(
  join(ROOT, 'packages/application/src/continuous-monitoring-service.ts')
);
const impact = await import(join(ROOT, 'packages/application/src/change-impact-service.ts'));
const ai = await import(join(ROOT, 'packages/application/src/ai-governance-service.ts'));
const improvement = await import(
  join(ROOT, 'packages/application/src/improvement-feedback-service.ts')
);
const entityResolution = await import(
  join(ROOT, 'packages/application/src/entity-resolution-service.ts')
);

const TENANT = '018f0000-0000-7000-8000-000000000001';
const OTHER_TENANT = '018f0000-0000-7000-8000-000000000002';
const certification = await import(
  join(ROOT, 'packages/application/src/connector-certification-service.ts')
);
const OWNER = '018f0000-0000-7000-8000-000000000010';
const REVIEWER = '018f0000-0000-7000-8000-000000000011';
const AUTHORITY = '018f0000-0000-7000-8000-000000000012';
const NOW = 1_800_000_000_000;

function create(kind = 'gap', extra = {}) {
  return registers.createGovernedRegisterRecord({
    id: '018f0000-0000-7000-8000-000000000020',
    tenantId: TENANT,
    kind,
    title: 'Unverified production control',
    description: 'The current source cannot demonstrate the control outcome.',
    ownerPrincipalId: OWNER,
    createdByPrincipalId: OWNER,
    reason: { code: 'monitoring.finding', text: 'A governed source reported a gap.' },
    now: NOW,
    ...(kind === 'exception'
      ? {
          expiresAt: NOW + 86_400_000,
          reviewAt: NOW + 43_200_000,
          compensatingControlRefs: ['/controls/c-1'],
        }
      : {}),
    ...extra,
  });
}

function transition(record, toStatus, extra = {}) {
  return registers.transitionGovernedRegisterRecord({
    record,
    tenantId: TENANT,
    expectedVersion: record.version,
    toStatus,
    actorPrincipalId: REVIEWER,
    authorityDecisionId: AUTHORITY,
    reason: { code: 'governance.transition', text: 'Apply the reviewed lifecycle decision.' },
    now: NOW + record.version,
    ...extra,
  });
}

test('governed gap verification requires a distinct verifier and retains immutable history', () => {
  const draft = create();
  const triage = transition(draft, 'triage', { actorPrincipalId: OWNER });
  const active = transition(triage, 'active', { actorPrincipalId: OWNER });
  const pending = transition(active, 'pending_verification', { actorPrincipalId: OWNER });
  assert.throws(
    () => transition(pending, 'verified', { actorPrincipalId: OWNER }),
    /distinct|self|verifier/i,
  );
  const verified = transition(pending, 'verified');
  assert.equal(verified.status, 'verified');
  assert.equal(verified.version, 5);
  assert.equal(verified.history.length, 5);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.history.length, 1);
  assert.ok(Object.isFrozen(verified.history));
});

test('risk acceptance and exception approval reject self-approval and stale writes', () => {
  let risk = create('risk');
  risk = transition(risk, 'triage', { actorPrincipalId: OWNER });
  risk = transition(risk, 'active', { actorPrincipalId: OWNER });
  risk = transition(risk, 'pending_approval', { actorPrincipalId: OWNER });
  assert.throws(
    () => transition(risk, 'accepted', { actorPrincipalId: OWNER }),
    /distinct|self|authority/i,
  );
  assert.equal(transition(risk, 'accepted').status, 'accepted');
  assert.throws(
    () => transition(risk, 'accepted', { expectedVersion: risk.version - 1 }),
    /changed|version/i,
  );

  let exception = create('exception');
  exception = transition(exception, 'triage', { actorPrincipalId: OWNER });
  exception = transition(exception, 'pending_approval', { actorPrincipalId: OWNER });
  assert.throws(
    () => transition(exception, 'approved', { actorPrincipalId: OWNER }),
    /distinct|self|authority/i,
  );
  assert.equal(transition(exception, 'approved').status, 'approved');
});

test('exceptions expire without silent renewal and remain visible as expired records', () => {
  let exception = create('exception');
  exception = transition(exception, 'triage', { actorPrincipalId: OWNER });
  exception = transition(exception, 'pending_approval', { actorPrincipalId: OWNER });
  exception = transition(exception, 'approved');
  assert.equal(
    registers.expireGovernedRegisterRecord(exception, NOW + 86_400_001).status,
    'expired',
  );
  assert.equal(exception.status, 'approved');
  assert.throws(() => create('exception', { expiresAt: NOW }), /expiry|future/i);
});

test('governed view AST is allowlisted and field disclosure is reauthorized at execution', () => {
  assert.throws(
    () =>
      views.createGovernedView({
        id: '018f0000-0000-7000-8000-000000000030',
        tenantId: TENANT,
        ownerPrincipalId: OWNER,
        name: 'Unsafe query',
        resourceKind: 'register_record',
        filter: { op: 'eq', field: 'secret', value: 'x' },
        fields: ['title'],
        sharedWithPrincipalIds: [REVIEWER],
        now: NOW,
      }),
    /field|allowlist/i,
  );

  const view = views.createGovernedView({
    id: '018f0000-0000-7000-8000-000000000030',
    tenantId: TENANT,
    ownerPrincipalId: OWNER,
    name: 'Active gaps',
    resourceKind: 'register_record',
    filter: {
      op: 'and',
      clauses: [
        { op: 'eq', field: 'kind', value: 'gap' },
        { op: 'in', field: 'status', values: ['active', 'pending_verification'] },
      ],
    },
    fields: ['id', 'title', 'status', 'ownerPrincipalId'],
    sharedWithPrincipalIds: [REVIEWER],
    now: NOW,
  });
  const rows = views.executeGovernedView({
    view,
    tenantId: TENANT,
    principalId: REVIEWER,
    records: [
      {
        id: 'r-1',
        tenantId: TENANT,
        kind: 'gap',
        title: 'Gap one',
        status: 'active',
        ownerPrincipalId: OWNER,
        secret: 'must-not-leak',
      },
      {
        id: 'r-2',
        tenantId: OTHER_TENANT,
        kind: 'gap',
        title: 'Foreign',
        status: 'active',
        ownerPrincipalId: OWNER,
      },
    ],
    authorizeField: (_principalId, record, field) =>
      record.id === 'r-1' && field !== 'ownerPrincipalId',
  });
  assert.deepEqual(rows, [{ id: 'r-1', title: 'Gap one', status: 'active' }]);
  assert.equal(JSON.stringify(rows).includes('secret'), false);
  assert.throws(
    () =>
      views.executeGovernedView({
        view,
        tenantId: TENANT,
        principalId: 'revoked-principal',
        records: [],
        authorizeField: () => true,
      }),
    /recipient|authorized|shared/i,
  );
});

test('subscriptions enforce cadence and quiet periods without broadening view authority', () => {
  const view = views.createGovernedView({
    id: '018f0000-0000-7000-8000-000000000030',
    tenantId: TENANT,
    ownerPrincipalId: OWNER,
    name: 'Due gaps',
    resourceKind: 'register_record',
    filter: { op: 'eq', field: 'kind', value: 'gap' },
    fields: ['id', 'title', 'status'],
    sharedWithPrincipalIds: [REVIEWER],
    now: NOW,
  });
  const subscription = views.createGovernedSubscription({
    id: '018f0000-0000-7000-8000-000000000031',
    tenantId: TENANT,
    view,
    recipientPrincipalId: REVIEWER,
    channels: ['in_app', 'email'],
    cadenceMinutes: 60,
    quietPeriod: { startMinuteUtc: 60, endMinuteUtc: 120 },
    escalationAfterMinutes: 180,
    createdAt: NOW,
  });
  assert.equal(subscription.viewDigest, view.queryDigest);
  assert.equal(views.isGovernedSubscriptionDue(subscription, NOW + 3_600_001), true);
  assert.equal(views.isGovernedSubscriptionQuiet(subscription, 90 * 60_000), true);
  assert.throws(
    () =>
      views.createGovernedSubscription({
        ...subscription,
        id: '018f0000-0000-7000-8000-000000000032',
        cadenceMinutes: 0,
      }),
    /cadence/i,
  );
});

test('monitoring preserves replay, out-of-order, and conflicting observations without duplicate cases', () => {
  const service = new monitoring.ContinuousMonitoringService(TENANT);
  const policy = {
    id: 'policy-control-condition',
    tenantId: TENANT,
    version: 3,
    keyAttributes: ['assetId', 'controlId', 'conditionId'],
    requiredSourceIds: ['scanner-a', 'scanner-b'],
    staleAfterMs: 60_000,
    defaultOwnerPrincipalId: OWNER,
    maxObservationRefs: 100,
  };
  const base = {
    id: 'observation-a',
    tenantId: TENANT,
    sourceId: 'scanner-a',
    sourceEventId: 'event-1',
    sourceContractVersion: 2,
    assetId: 'asset-1',
    controlId: 'control-1',
    conditionId: 'condition-1',
    observedAt: NOW - 2_000,
    receivedAt: NOW,
    status: 'fail',
    freshness: 'fresh',
    completeness: 'complete',
    confidence: 0.98,
    payloadEvidenceRef: '/evidence/observation-a',
    sourceHealth: 'healthy',
    correlationAttributes: { zone: 'production' },
  };
  const accepted = service.ingest(base, policy, NOW);
  const replay = service.ingest(base, policy, NOW + 1);
  assert.equal(accepted.ingestStatus, 'accepted');
  assert.equal(replay.ingestStatus, 'duplicate');
  assert.equal(service.observations().length, 1);
  assert.equal(service.cases().length, 1);

  const older = service.ingest(
    {
      ...base,
      id: 'observation-b',
      sourceId: 'scanner-b',
      sourceEventId: 'event-older',
      observedAt: NOW - 5_000,
      receivedAt: NOW + 2,
      status: 'pass',
    },
    policy,
    NOW + 2,
  );
  assert.equal(older.case.observationRefs.length, 2);
  assert.equal(older.case.firstObservedAt, NOW - 5_000);
  assert.equal(older.case.lastObservedAt, NOW - 2_000);
  assert.equal(older.case.status, 'open');

  assert.throws(
    () => service.ingest({ ...base, status: 'pass' }, policy, NOW + 3),
    /replay|conflict|digest/i,
  );
  assert.equal(service.observations().length, 2);
  assert.equal(service.cases().length, 1);
});

test('monitoring never infers pass from missing, stale, partial, conflicting, or unhealthy sources', () => {
  const service = new monitoring.ContinuousMonitoringService(TENANT);
  const policy = {
    id: 'policy-no-false-pass',
    tenantId: TENANT,
    version: 1,
    keyAttributes: ['assetId', 'controlId'],
    requiredSourceIds: ['source-a', 'source-b'],
    staleAfterMs: 1_000,
    defaultOwnerPrincipalId: OWNER,
    maxObservationRefs: 20,
  };
  const result = service.ingest(
    {
      id: 'observation-partial',
      tenantId: TENANT,
      sourceId: 'source-a',
      sourceEventId: 'partial-1',
      sourceContractVersion: 1,
      assetId: 'asset-2',
      controlId: 'control-2',
      conditionId: 'condition-2',
      observedAt: NOW - 2_000,
      receivedAt: NOW,
      status: 'pass',
      freshness: 'stale',
      completeness: 'partial',
      confidence: 0.5,
      payloadEvidenceRef: '/evidence/partial-1',
      sourceHealth: 'degraded',
      correlationAttributes: {},
    },
    policy,
    NOW,
  );
  assert.equal(result.case.assuranceOutcome, 'unknown');
  assert.equal(result.case.status, 'open');
  assert.deepEqual(
    [...result.case.uncertaintyReasons].sort(),
    ['missing_source:source-b', 'partial', 'source_degraded', 'stale'].sort(),
  );
  assert.throws(
    () => service.applyAutomation(result.case.id, 'close', NOW + 1),
    /human|authority|automation/i,
  );
  const drafted = service.applyAutomation(result.case.id, 'draft_register_record', NOW + 1);
  assert.equal(drafted.case.status, 'open');
  assert.equal(drafted.draftRegisterRecord?.status, 'draft');
});

test('monitoring retries and terminal failures remain visible and preserve evidence', () => {
  const service = new monitoring.ContinuousMonitoringService(TENANT);
  const policy = {
    id: 'policy-retry',
    tenantId: TENANT,
    version: 1,
    keyAttributes: ['assetId', 'controlId'],
    requiredSourceIds: ['source-a'],
    staleAfterMs: 60_000,
    defaultOwnerPrincipalId: OWNER,
    maxObservationRefs: 20,
  };
  const { case: created } = service.ingest(
    {
      id: 'observation-failed',
      tenantId: TENANT,
      sourceId: 'source-a',
      sourceEventId: 'failure-1',
      sourceContractVersion: 1,
      assetId: 'asset-3',
      controlId: 'control-3',
      conditionId: 'condition-3',
      observedAt: NOW,
      receivedAt: NOW,
      status: 'unavailable',
      freshness: 'unknown',
      completeness: 'unknown',
      confidence: 0,
      payloadEvidenceRef: '/evidence/failure-1',
      sourceHealth: 'unavailable',
      correlationAttributes: {},
    },
    policy,
    NOW,
  );
  const retrying = service.recordRetry(created.id, 'source_timeout', NOW + 10, NOW + 1_000);
  assert.equal(retrying.retryState.attempts, 1);
  const terminal = service.recordTerminalFailure(
    created.id,
    'retry_exhausted',
    '/evidence/terminal-failure-1',
    NOW + 2_000,
  );
  assert.equal(terminal.retryState.terminal, true);
  assert.equal(terminal.terminalFailureRef, '/evidence/terminal-failure-1');
  assert.ok(terminal.observationRefs.includes('observation-failed'));
});

test('impact preview is pure, version-bound, and classifies every affected governed record', () => {
  const graph = [
    { ref: '/controls/c-1', tenantId: TENANT, kind: 'control', version: 4, dependsOn: [] },
    {
      ref: '/assets/a-1',
      tenantId: TENANT,
      kind: 'asset',
      version: 2,
      dependsOn: ['/controls/c-1'],
    },
    {
      ref: '/reviews/r-1',
      tenantId: TENANT,
      kind: 'review',
      version: 7,
      dependsOn: ['/controls/c-1'],
    },
    {
      ref: '/evidence-requests/e-1',
      tenantId: TENANT,
      kind: 'evidence_request',
      version: 3,
      dependsOn: ['/assets/a-1'],
    },
    {
      ref: '/registers/g-1',
      tenantId: TENANT,
      kind: 'register_record',
      version: 5,
      dependsOn: ['/controls/c-1'],
    },
    {
      ref: '/monitoring-cases/m-1',
      tenantId: TENANT,
      kind: 'monitoring_case',
      version: 8,
      dependsOn: ['/assets/a-1'],
    },
    {
      ref: '/scores/s-1',
      tenantId: TENANT,
      kind: 'score',
      version: 6,
      dependsOn: ['/registers/g-1'],
    },
    {
      ref: '/projections/p-1',
      tenantId: TENANT,
      kind: 'projection',
      version: 9,
      dependsOn: ['/scores/s-1'],
      compatibilityRisk: 'schema_v2_required',
    },
  ];
  const before = JSON.stringify(graph);
  const preview = impact.createImpactPreview({
    id: 'preview-1',
    tenantId: TENANT,
    proposalType: 'control',
    proposalRef: '/controls/c-1',
    proposalDigest: 'a'.repeat(64),
    requestedBy: OWNER,
    graph,
    generatedAt: NOW,
    expiresAt: NOW + 60_000,
  });
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(preview.affectedAssetRefs, ['/assets/a-1']);
  assert.deepEqual(preview.reviewRefs, ['/reviews/r-1']);
  assert.deepEqual(preview.evidenceRequestRefs, ['/evidence-requests/e-1']);
  assert.deepEqual(preview.registerRecordRefs, ['/registers/g-1']);
  assert.deepEqual(preview.monitoringCaseRefs, ['/monitoring-cases/m-1']);
  assert.deepEqual(preview.scoreRefs, ['/scores/s-1']);
  assert.deepEqual(preview.projectionRefs, ['/projections/p-1']);
  assert.deepEqual(preview.compatibilityRisks, ['schema_v2_required']);
  assert.equal(preview.status, 'ready');
  assert.ok(Object.isFrozen(preview));
});

test('impact publication rejects drift, expiry, and self-approval before emitting rebuild work', () => {
  const graph = [
    { ref: '/policies/p-1', tenantId: TENANT, kind: 'policy', version: 3, dependsOn: [] },
    {
      ref: '/projections/p-2',
      tenantId: TENANT,
      kind: 'projection',
      version: 2,
      dependsOn: ['/policies/p-1'],
    },
  ];
  const preview = impact.createImpactPreview({
    id: 'preview-2',
    tenantId: TENANT,
    proposalType: 'policy',
    proposalRef: '/policies/p-1',
    proposalDigest: 'b'.repeat(64),
    requestedBy: OWNER,
    graph,
    generatedAt: NOW,
    expiresAt: NOW + 10_000,
  });
  assert.equal(
    impact.validateImpactPreview(preview, preview.sourceVersionSet, preview.proposalDigest, NOW + 1)
      .status,
    'valid',
  );
  assert.equal(
    impact.validateImpactPreview(
      preview,
      { ...preview.sourceVersionSet, '/policies/p-1': 4 },
      preview.proposalDigest,
      NOW + 1,
    ).status,
    'source_drift',
  );
  assert.equal(
    impact.validateImpactPreview(
      preview,
      preview.sourceVersionSet,
      preview.proposalDigest,
      NOW + 10_001,
    ).status,
    'expired',
  );
  assert.throws(
    () =>
      impact.publishGovernedChange({
        id: 'publication-self',
        preview,
        tenantId: TENANT,
        approvedBy: OWNER,
        approvalDecisionId: AUTHORITY,
        targetVersion: 4,
        currentSourceVersionSet: preview.sourceVersionSet,
        proposalDigest: preview.proposalDigest,
        publishedAt: NOW + 1,
        rollbackPlanRef: '/rollback/plans/preview-2',
      }),
    /distinct|self|approval/i,
  );
  const publication = impact.publishGovernedChange({
    id: 'publication-1',
    preview,
    tenantId: TENANT,
    approvedBy: REVIEWER,
    approvalDecisionId: AUTHORITY,
    targetVersion: 4,
    currentSourceVersionSet: preview.sourceVersionSet,
    proposalDigest: preview.proposalDigest,
    publishedAt: NOW + 1,
    rollbackPlanRef: '/rollback/plans/preview-2',
  });
  assert.equal(publication.rebuildStatus, 'pending');
  assert.equal(publication.rollbackStatus, 'available');
  assert.deepEqual(publication.affectedProjectionRefs, ['/projections/p-2']);
});

test('publication rebuild failures and rollback are new retained facts, never history deletion', () => {
  const preview = impact.createImpactPreview({
    id: 'preview-3',
    tenantId: TENANT,
    proposalType: 'threshold',
    proposalRef: '/thresholds/t-1',
    proposalDigest: 'c'.repeat(64),
    requestedBy: OWNER,
    graph: [
      { ref: '/thresholds/t-1', tenantId: TENANT, kind: 'threshold', version: 1, dependsOn: [] },
      {
        ref: '/projections/p-3',
        tenantId: TENANT,
        kind: 'projection',
        version: 5,
        dependsOn: ['/thresholds/t-1'],
      },
    ],
    generatedAt: NOW,
    expiresAt: NOW + 60_000,
  });
  const publication = impact.publishGovernedChange({
    id: 'publication-2',
    preview,
    tenantId: TENANT,
    approvedBy: REVIEWER,
    approvalDecisionId: AUTHORITY,
    targetVersion: 2,
    currentSourceVersionSet: preview.sourceVersionSet,
    proposalDigest: preview.proposalDigest,
    publishedAt: NOW + 1,
    rollbackPlanRef: '/rollback/plans/preview-3',
  });
  const failed = impact.updatePublicationRebuild(publication, {
    status: 'failed',
    progress: 0.5,
    failureRef: '/evidence/rebuild-failure-1',
    updatedAt: NOW + 2,
  });
  assert.equal(failed.rebuildStatus, 'failed');
  assert.deepEqual(failed.failureRefs, ['/evidence/rebuild-failure-1']);
  const rollback = impact.createGovernedRollback({
    id: 'rollback-1',
    publication: failed,
    tenantId: TENANT,
    authorizedBy: REVIEWER,
    authorityDecisionId: AUTHORITY,
    targetVersion: 3,
    evidenceRef: '/evidence/rollback-1',
    createdAt: NOW + 3,
  });
  assert.equal(rollback.rollbackOfPublicationId, publication.id);
  assert.equal(rollback.targetVersion, 3);
  assert.equal(publication.rebuildStatus, 'pending');
  assert.equal(failed.rebuildStatus, 'failed');
});

function aiUseCase() {
  return ai.createAiUseCase({
    id: 'ai-use-case-1',
    tenantId: TENANT,
    name: 'Governance evidence assistant',
    purpose: 'Summarize currently authorized governed records with exact citations.',
    ownerPrincipalId: OWNER,
    affectedPeople: ['tenant operators'],
    affectedSystems: ['trustcircle-console'],
    riskClass: 'high',
    obligationRefs: ['/obligations/ai-1'],
    controlRefs: ['/controls/ai-1'],
    oversightPlan:
      'A tenant reviewer checks evaluation, incidents, drift, and every approval boundary.',
    prohibitedUses: ['approval', 'attestation', 'certification'],
    monitoringRuleRefs: ['/monitoring-rules/ai-1'],
    retirementConditions: ['unsupported provider', 'failed safety evaluation'],
    createdByPrincipalId: OWNER,
    now: NOW,
  });
}

function evaluatedAiUseCase() {
  const created = aiUseCase();
  const registered = ai.registerAiComponentVersion({
    useCase: created,
    tenantId: TENANT,
    actorPrincipalId: OWNER,
    component: {
      id: 'component-1',
      kind: 'model',
      providerRef: '/providers/provider-1',
      modelRef: '/models/model-1',
      promptDigest: 'a'.repeat(64),
      toolManifestDigest: 'b'.repeat(64),
      dataSourceRefs: ['/sources/governed-records'],
      version: 3,
      changeClass: 'material',
      approvedScope: { purposes: ['governance_assistance'] },
      status: 'evaluated',
    },
    now: NOW + 1,
  });
  const evaluated = ai.recordAiEvaluation({
    useCase: registered.useCase,
    tenantId: TENANT,
    id: 'evaluation-1',
    componentVersionRefs: [registered.component.versionRef],
    evaluationPlanVersion: 2,
    datasetEvidenceRefs: ['/evidence/ai-evaluation-1'],
    measures: { groundedness: 0.98, abstention: 1 },
    thresholds: { groundedness: 0.95, abstention: 1 },
    results: { groundedness: 0.98, abstention: 1 },
    limitations: ['Only currently authorized sources were evaluated.'],
    evaluatorPrincipalId: REVIEWER,
    reviewedByPrincipalId: AUTHORITY,
    verdict: 'pass',
    evaluatedAt: NOW + 2,
  });
  return { ...evaluated, component: registered.component };
}

test('AI lifecycle binds an independently evaluated exact component set and denies owner approval', () => {
  const evaluated = evaluatedAiUseCase();
  const pending = ai.submitAiUseCaseForApproval({
    useCase: evaluated.useCase,
    tenantId: TENANT,
    actorPrincipalId: OWNER,
    expectedVersion: evaluated.useCase.resourceVersion,
    reason: {
      code: 'ai.approval_request',
      text: 'Request review of the exact evaluated component set.',
    },
    now: NOW + 3,
  });
  assert.throws(
    () =>
      ai.approveAiUseCase({
        useCase: pending,
        tenantId: TENANT,
        approvalId: 'approval-self',
        componentVersionRefs: [evaluated.component.versionRef],
        approvedByPrincipalId: OWNER,
        authorityDecisionId: AUTHORITY,
        validUntil: NOW + 86_400_000,
        approvedAt: NOW + 4,
      }),
    /distinct|self|owner|approval/i,
  );
  const approved = ai.approveAiUseCase({
    useCase: pending,
    tenantId: TENANT,
    approvalId: 'approval-1',
    componentVersionRefs: [evaluated.component.versionRef],
    approvedByPrincipalId: AUTHORITY,
    authorityDecisionId: 'decision-ai-1',
    validUntil: NOW + 86_400_000,
    approvedAt: NOW + 4,
  });
  const active = ai.activateAiUseCase({
    useCase: approved.useCase,
    tenantId: TENANT,
    actorPrincipalId: REVIEWER,
    componentVersionRefs: [evaluated.component.versionRef],
    now: NOW + 5,
  });
  assert.equal(active.lifecycleState, 'active');
  assert.deepEqual(active.activeComponentVersionRefs, [evaluated.component.versionRef]);
  assert.ok(active.history.length > evaluated.useCase.history.length);
});

test('AI approval expiry and material component drift constrain or suspend use fail closed', () => {
  const evaluated = evaluatedAiUseCase();
  const pending = ai.submitAiUseCaseForApproval({
    useCase: evaluated.useCase,
    tenantId: TENANT,
    actorPrincipalId: OWNER,
    expectedVersion: evaluated.useCase.resourceVersion,
    reason: { code: 'ai.approval_request', text: 'Request exact component approval.' },
    now: NOW + 3,
  });
  const approved = ai.approveAiUseCase({
    useCase: pending,
    tenantId: TENANT,
    approvalId: 'approval-2',
    componentVersionRefs: [evaluated.component.versionRef],
    approvedByPrincipalId: AUTHORITY,
    authorityDecisionId: 'decision-ai-2',
    validUntil: NOW + 100,
    approvedAt: NOW + 4,
  });
  const active = ai.activateAiUseCase({
    useCase: approved.useCase,
    tenantId: TENANT,
    actorPrincipalId: REVIEWER,
    componentVersionRefs: [evaluated.component.versionRef],
    now: NOW + 5,
  });
  const drifted = ai.evaluateAiUseCaseBoundary(active, ['component-1:v4'], NOW + 6);
  assert.equal(drifted.state, 'constrained');
  assert.ok(drifted.reasons.includes('component_drift'));
  const expired = ai.evaluateAiUseCaseBoundary(active, [evaluated.component.versionRef], NOW + 101);
  assert.equal(expired.state, 'suspended');
  assert.ok(expired.reasons.includes('approval_expired'));
});

test('AI incidents constrain operation and retirement preserves every historical component and decision', () => {
  const evaluated = evaluatedAiUseCase();

  const incident = ai.reportAiIncident({
    useCase: evaluated.useCase,
    tenantId: TENANT,
    id: 'incident-1',
    componentVersionRefs: [evaluated.component.versionRef],
    severity: 'critical',
    affectedScope: { tenants: [TENANT] },
    source: 'monitoring',
    evidenceRefs: ['/evidence/ai-incident-1'],
    ownerPrincipalId: OWNER,
    containment: ['disable generated responses'],
    correctiveActions: ['repeat independent evaluation'],
    detectedAt: NOW + 3,
  });
  assert.equal(incident.useCase.lifecycleState, 'suspended');
  const retired = ai.retireAiUseCase({
    useCase: incident.useCase,
    tenantId: TENANT,
    actorPrincipalId: AUTHORITY,
    authorityDecisionId: 'decision-retire-1',
    reason: {
      code: 'ai.retire',
      text: 'Retire after the critical incident and preserve all evidence.',
    },
    now: NOW + 4,
  });
  assert.equal(retired.lifecycleState, 'retired');
  assert.equal(retired.components.length, 1);
  assert.equal(retired.evaluations.length, 1);
  assert.equal(retired.incidents.length, 1);
  assert.ok(Object.isFrozen(retired.history));
});

test('copilot cites only exact authorized current sources and abstains on unsupported or conflicting evidence', () => {
  const currentSource = {
    tenantId: TENANT,
    ref: '/register-records/gap-1',
    version: 4,
    digest: 'd'.repeat(64),
    kind: 'register_record',
    freshness: 'current',
    conflicting: false,
    authorized: true,
    facts: [{ label: 'Status', value: 'active' }],
  };
  const response = ai.generateGovernedCopilotResponse({
    id: 'exchange-1',
    tenantId: TENANT,
    principalId: OWNER,
    purpose: 'governance_assistance',
    queryClassification: 'status_lookup',
    policyDecisionId: 'policy-decision-1',
    sources: [
      currentSource,
      { ...currentSource, tenantId: OTHER_TENANT, ref: '/register-records/foreign' },
      { ...currentSource, ref: '/register-records/revoked', authorized: false },
    ],
    createdAt: NOW,
  });
  assert.equal(response.label, 'generated_assistance');
  assert.equal(response.authority, 'non_authoritative');
  assert.equal(response.abstentionCode, null);
  assert.deepEqual(
    response.citations.map((citation) => citation.ref),
    ['/register-records/gap-1'],
  );
  assert.equal(response.citations[0].version, 4);
  assert.equal(response.facts[0].citationRef, '/register-records/gap-1#v4');
  assert.equal(JSON.stringify(response.auditMetadata).includes('Status'), false);
  assert.equal('prompt' in response.auditMetadata, false);

  const abstained = ai.generateGovernedCopilotResponse({
    id: 'exchange-2',
    tenantId: TENANT,
    principalId: OWNER,
    purpose: 'governance_assistance',
    queryClassification: 'status_lookup',
    policyDecisionId: 'policy-decision-2',
    sources: [{ ...currentSource, conflicting: true }],
    createdAt: NOW + 1,
  });
  assert.equal(abstained.abstentionCode, 'conflicting_sources');
  assert.deepEqual(abstained.facts, []);
  assert.ok(abstained.limitationCodes.includes('conflicting_sources'));
});

function certificationCommand(extra = {}) {
  return {
    id: '018f0000-0000-7000-8000-000000000820',
    tenantId: TENANT,
    connectorId: 'kanban',
    exactVersion: '2.4.0',
    manifestDigest: 'a'.repeat(64),
    report: {
      reportDigest: 'b'.repeat(64),
      manifestDigest: 'a'.repeat(64),
      suiteVersion: '2.0.0',
      passed: true,
      signatureValid: true,
    },
    authorPrincipalId: OWNER,
    certifierPrincipalId: REVIEWER,
    certificationDecisionId: AUTHORITY,
    allowedTenantRefs: [TENANT],
    allowedScopes: ['boards:read', 'cards:write'],
    allowedCapabilities: ['discover', 'execute', 'reconcile'],
    credentialClasses: ['oauth-client'],
    validFrom: NOW,
    expiresAt: NOW + 86_400_000,
    certifiedAt: NOW,
    ...extra,
  };
}

test('connector certification requires independent review and exact passing evidence', () => {
  assert.throws(
    () =>
      certification.certifyConnectorVersion(certificationCommand({ certifierPrincipalId: OWNER })),
    /distinct|self|author|certifier/i,
  );
  assert.throws(
    () =>
      certification.certifyConnectorVersion({
        ...certificationCommand(),
        report: { ...certificationCommand().report, manifestDigest: 'c'.repeat(64) },
      }),
    /digest|manifest/i,
  );
  const certified = certification.certifyConnectorVersion(certificationCommand());
  assert.equal(certified.status, 'active');
  assert.equal(certified.exactVersion, '2.4.0');
  assert.equal(certified.reportDigest, 'b'.repeat(64));
  assert.deepEqual(certified.allowedTenantRefs, [TENANT]);
});

test('connector activation fails closed outside every exact certification bound', () => {
  const certified = certification.certifyConnectorVersion(certificationCommand());
  const base = {
    certification: certified,
    tenantId: TENANT,
    exactVersion: '2.4.0',
    manifestDigest: 'a'.repeat(64),
    reportDigest: 'b'.repeat(64),
    scope: 'boards:read',
    capabilities: ['discover'],
    credentialClass: 'oauth-client',
    now: NOW + 1,
    healthy: true,
    compatible: true,
    policyConformant: true,
  };
  assert.equal(certification.evaluateConnectorActivation(base).allowed, true);
  for (const changed of [
    { exactVersion: '2.4.1' },
    { manifestDigest: 'c'.repeat(64) },
    { reportDigest: 'd'.repeat(64) },
    { tenantId: OTHER_TENANT },
    { scope: 'admin:all' },
    { capabilities: ['rollback'] },
    { credentialClass: 'static-secret' },
    { healthy: false },
    { compatible: false },
    { policyConformant: false },
    { now: NOW + 86_400_001 },
  ]) {
    const verdict = certification.evaluateConnectorActivation({ ...base, ...changed });
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.failures.length > 0);
  }
});

test('revocation blocks new work while retaining uncertain work for reconciliation', () => {
  const certified = certification.certifyConnectorVersion(certificationCommand());
  assert.throws(
    () =>
      certification.revokeConnectorCertification({
        certification: certified,
        tenantId: OTHER_TENANT,
        revokedByPrincipalId: AUTHORITY,
        authorityDecisionId: 'decision-revoke-1',
        reason: { code: 'connector.revoked', text: 'Revoke the unsafe connector version.' },
        revokedAt: NOW + 1,
      }),
    /tenant/i,
  );
  const revoked = certification.revokeConnectorCertification({
    certification: certified,
    tenantId: TENANT,
    revokedByPrincipalId: AUTHORITY,
    authorityDecisionId: 'decision-revoke-1',
    reason: { code: 'connector.revoked', text: 'Revoke the unsafe connector version.' },
    revokedAt: NOW + 1,
  });
  const verdict = certification.evaluateConnectorActivation({
    certification: revoked,
    tenantId: TENANT,
    exactVersion: '2.4.0',
    manifestDigest: 'a'.repeat(64),
    reportDigest: 'b'.repeat(64),
    scope: 'boards:read',
    capabilities: ['discover'],
    credentialClass: 'oauth-client',
    now: NOW + 2,
    healthy: true,
    compatible: true,
    policyConformant: true,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reconciliationAvailable, true);
  assert.equal(certified.status, 'active');
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revocationReason.code, 'connector.revoked');
});
function aggregateMeasure(metric = 'time_to_find', extra = {}) {
  return {
    ref: 'aggregate://product/' + metric + '/2026-07',
    schemaVersion: 2,
    metric,
    routeFamily: '/operations',
    windowStart: NOW - 86_400_000,
    windowEnd: NOW,
    sampleCount: 50,
    aggregation: 'duration_bucket_distribution',
    retentionPolicyId: 'analytics-aggregate-90d',
    collectionPolicyDecisionId: 'policy-analytics-enabled',
    ...extra,
  };
}

function improvementHypothesis(extra = {}) {
  return improvement.createImprovementHypothesis({
    id: '018f0000-0000-7000-8000-000000000830',
    tenantId: TENANT,
    productScope: 'operations-workspace',
    analyticsSchemaVersion: 2,
    aggregateMeasures: [aggregateMeasure()],
    hypothesis: 'A consolidated attention view will reduce time to find governed work.',
    ownerPrincipalId: OWNER,
    createdByPrincipalId: OWNER,
    expectedOutcome: 'Move the median duration bucket below one minute.',
    baselineWindow: { start: NOW - 86_400_000, end: NOW },
    targetWindow: { start: NOW + 1, end: NOW + 86_400_000 },
    reason: { code: 'improvement.proposed', text: 'Aggregate experience signals show delay.' },
    now: NOW,
    ...extra,
  });
}

test('improvement hypotheses accept only privacy-minimized aggregate measures', () => {
  const proposed = improvementHypothesis();
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.resourceVersion, 1);
  assert.deepEqual(proposed.aggregateMeasureRefs, ['aggregate://product/time_to_find/2026-07']);
  assert.ok(Object.isFrozen(proposed.history));

  for (const leaked of [
    { evidenceBody: 'raw evidence' },
    { directIdentifier: OWNER },
    { arbitraryContent: 'search text' },
    { secret: 'credential' },
    { sampleCount: 0 },
  ]) {
    assert.throws(
      () =>
        improvementHypothesis({ aggregateMeasures: [aggregateMeasure('time_to_find', leaked)] }),
      /aggregate|privacy|measure|sample|field/i,
    );
  }
});

test('improvement decisions, delivery, and outcomes are versioned and attributable', () => {
  const proposed = improvementHypothesis();
  assert.throws(
    () =>
      improvement.decideImprovementHypothesis({
        hypothesis: proposed,
        tenantId: TENANT,
        expectedVersion: 1,
        decision: 'approve',
        actorPrincipalId: OWNER,
        authorityDecisionId: 'decision-improvement-1',
        reason: { code: 'improvement.approve', text: 'Approve the bounded experiment.' },
        now: NOW + 1,
      }),
    /distinct|self|review/i,
  );
  const approved = improvement.decideImprovementHypothesis({
    hypothesis: proposed,
    tenantId: TENANT,
    expectedVersion: 1,
    decision: 'approve',
    actorPrincipalId: REVIEWER,
    authorityDecisionId: 'decision-improvement-1',
    reason: { code: 'improvement.approve', text: 'Approve the bounded experiment.' },
    now: NOW + 1,
  });
  const delivered = improvement.updateImprovementDelivery({
    hypothesis: approved,
    tenantId: TENANT,
    expectedVersion: approved.resourceVersion,
    deliveryStatus: 'delivered',
    actorPrincipalId: OWNER,
    reason: { code: 'improvement.delivered', text: 'The reviewed workspace change is live.' },
    now: NOW + 2,
  });
  const concluded = improvement.concludeImprovementHypothesis({
    hypothesis: delivered,
    tenantId: TENANT,
    expectedVersion: delivered.resourceVersion,
    actorPrincipalId: REVIEWER,
    authorityDecisionId: 'decision-improvement-outcome-1',
    outcomeMeasures: [
      aggregateMeasure('time_to_find', {
        ref: 'aggregate://product/time_to_find/2026-08',
        windowStart: NOW + 1,
        windowEnd: NOW + 86_400_000,
      }),
    ],
    conclusion: 'The target was met without collecting record content or direct identifiers.',
    reason: { code: 'improvement.concluded', text: 'Review the aggregate outcome.' },
    now: NOW + 86_400_001,
  });
  assert.equal(concluded.status, 'concluded');
  assert.equal(concluded.resourceVersion, 4);
  assert.deepEqual(concluded.decisionRefs, [
    'decision-improvement-1',
    'decision-improvement-outcome-1',
  ]);
  assert.equal(proposed.status, 'proposed');
  assert.equal(concluded.history.length, 4);
  assert.throws(
    () =>
      improvement.updateImprovementDelivery({
        hypothesis: approved,
        tenantId: OTHER_TENANT,
        expectedVersion: approved.resourceVersion,
        deliveryStatus: 'delivered',
        actorPrincipalId: OWNER,
        reason: { code: 'improvement.delivered', text: 'Cross tenant attempt.' },
        now: NOW + 2,
      }),
    /tenant/i,
  );
});

function resolutionCase(proposalType = 'merge', extra = {}) {
  return entityResolution.createEntityResolutionCase({
    id: '018f0000-0000-7000-8000-000000000840',
    tenantId: TENANT,
    sourceIdentities: [
      {
        tenantId: TENANT,
        sourceSystemId: 'cmdb-a',
        sourceRecordId: 'asset-101',
        sourceDigest: 'a'.repeat(64),
      },
      {
        tenantId: TENANT,
        sourceSystemId: 'scanner-b',
        sourceRecordId: 'node-77',
        sourceDigest: 'b'.repeat(64),
      },
    ],
    candidateCanonicalEntityId: 'asset-canonical-1',
    proposalType,
    confidenceBand: 'high',
    matchReasons: ['serial_hash_exact', 'hostname_normalized'],
    conflictReasons: [],
    affectedProjectionRefs: ['/inventory', '/posture', '/compliance'],
    proposedByPrincipalId: OWNER,
    reason: { code: 'resolution.proposed', text: 'Two governed sources may describe one asset.' },
    now: NOW,
    ...extra,
  });
}

function resolutionTransition(caseRecord, transition, extra = {}) {
  return entityResolution.transitionEntityResolutionCase({
    caseRecord,
    tenantId: TENANT,
    expectedVersion: caseRecord.resourceVersion,
    transition,
    actorPrincipalId: transition === 'start_review' ? REVIEWER : AUTHORITY,
    authorityDecisionId: 'decision-resolution-' + transition,
    reason: { code: 'resolution.' + transition, text: 'Apply the reviewed identity decision.' },
    now: NOW + caseRecord.resourceVersion,
    ...extra,
  });
}

test('entity resolution preserves immutable source identities and requires independent review', () => {
  const proposed = resolutionCase();
  assert.ok(Object.isFrozen(proposed.sourceIdentities));
  assert.throws(
    () =>
      resolutionCase('merge', {
        sourceIdentities: [
          {
            tenantId: OTHER_TENANT,
            sourceSystemId: 'foreign',
            sourceRecordId: 'asset-9',
            sourceDigest: 'c'.repeat(64),
          },
        ],
      }),
    /tenant/i,
  );
  const review = resolutionTransition(proposed, 'start_review');
  assert.throws(
    () => resolutionTransition(review, 'accept', { actorPrincipalId: OWNER }),
    /distinct|self|review/i,
  );
  const accepted = resolutionTransition(review, 'accept');
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.sourceIdentities, proposed.sourceIdentities);
  assert.deepEqual(
    accepted.projectionInvalidations.map((item) => item.projectionRef),
    ['/compliance', '/inventory', '/posture'],
  );
});

test('entity merge, split, rejection, partial failure, and rollback remain visible and reversible', () => {
  for (const proposalType of ['merge', 'split', 'reject_link']) {
    const proposed = resolutionCase(proposalType, {
      id:
        proposalType === 'merge'
          ? '018f0000-0000-7000-8000-000000000841'
          : proposalType === 'split'
            ? '018f0000-0000-7000-8000-000000000842'
            : '018f0000-0000-7000-8000-000000000843',
    });
    const review = resolutionTransition(proposed, 'start_review');
    const decided =
      proposalType === 'reject_link'
        ? resolutionTransition(review, 'reject')
        : resolutionTransition(review, 'accept');
    assert.equal(decided.status, proposalType === 'reject_link' ? 'rejected' : 'accepted');
  }

  const accepted = resolutionTransition(
    resolutionTransition(resolutionCase(), 'start_review'),
    'accept',
  );
  const partial = resolutionTransition(accepted, 'fail', {
    appliedProjectionRefs: ['/inventory'],
    failedProjectionRefs: ['/posture', '/compliance'],
  });
  assert.equal(partial.status, 'failed');
  assert.equal(partial.reconciliationAvailable, true);
  assert.deepEqual(partial.appliedProjectionRefs, ['/inventory']);
  assert.deepEqual(partial.failedProjectionRefs, ['/compliance', '/posture']);

  const applied = resolutionTransition(accepted, 'apply', {
    appliedProjectionRefs: ['/inventory', '/posture', '/compliance'],
  });
  const pending = resolutionTransition(applied, 'request_rollback');
  const rolledBack = resolutionTransition(pending, 'rollback');
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.rollbackOfCaseId, accepted.id);
  assert.deepEqual(rolledBack.sourceIdentities, accepted.sourceIdentities);
  assert.ok(
    rolledBack.projectionInvalidations.every((item) => item.reason === 'resolution_rollback'),
  );
  assert.equal(applied.status, 'applied');
});
