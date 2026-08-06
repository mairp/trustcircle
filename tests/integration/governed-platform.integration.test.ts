import { describe, expect, it } from 'vitest';

import {
  ContinuousMonitoringService,
  concludeImprovementHypothesis,
  createEntityResolutionCase,
  createImprovementHypothesis,
  decideImprovementHypothesis,
  transitionEntityResolutionCase,
  updateImprovementDelivery,
  certifyConnectorVersion,
  revokeConnectorCertification,
  createAiUseCase,
  generateGovernedCopilotResponse,
  createGovernedRegisterRecord,
  createImpactPreview,
  publishGovernedChange,
  reportAiIncident,
  retireAiUseCase,
  createGovernedSubscription,
  createGovernedView,
  createSignedReviewSnapshot,
  decideEvidenceSufficiency,
  issueEvidenceRequest,
  submitEvidenceAttestation,
  transitionGovernedRegisterRecord,
  type AiUseCase,
  type ChangePublication,
  type ConnectorCertification,
  type EntityResolutionCase,
  type ImprovementHypothesis,
  type AggregateProductMeasure,
  type GovernedRegisterRecord,
  type ImpactPreview,
  type GovernedSubscription,
  type EvidenceAttestation,
  type EvidenceRequest,
  type GovernedView,
  type ReviewSnapshotSource,
  type SignedReviewSnapshot,
} from '@trustcircle/application';
import { createApp, type AppOptions } from '../../apps/api/src/server.ts';
import {
  registerGovernedPlatformRoutes,
  type GovernedAiRoutePort,
  type GovernedConnectorRoutePort,
  type GovernedCollaborationRoutePort,
  type GovernedEntityResolutionRoutePort,
  type GovernedImprovementRoutePort,
  type GovernedDeliveryAttemptView,
  type GovernedEvidenceRoutePort,
  type GovernedMonitoringRoutePort,
  type GovernedPlatformRouteDeps,
  type ReviewComparisonCommit,
  type ReviewSnapshotCommit,
} from '../../apps/api/src/routes/governed-platform.ts';
import type { VerifiedIdentity } from '../../apps/api/src/middleware/context.ts';

const TENANT = '018f0000-0000-7000-8000-000000000001';
const OTHER_TENANT = '018f0000-0000-7000-8000-000000000002';
const PRINCIPAL = '018f0000-0000-7000-8000-000000000010';
const REVIEW = '018f0000-0000-7000-8000-000000000020';
const AUTHORITY = '018f0000-0000-7000-8000-000000000030';
const BASELINE = '018f0000-0000-7000-8000-000000000040';
const TARGET = '018f0000-0000-7000-8000-000000000041';
const COMPARISON = '018f0000-0000-7000-8000-000000000050';
const NOW = 1_800_000_000_000;

function identity(tenantId = TENANT): () => VerifiedIdentity {
  return () => ({
    principalId: PRINCIPAL,
    tenantId,
    roles: ['governance_officer'],
    isBrowserSession: false,
  });
}

function source(tenantId: string, version: number, status: string): ReviewSnapshotSource {
  return {
    tenantId,
    reviewId: REVIEW,
    reviewVersion: version,
    completed: true,
    scope: { systemIds: ['system-1'] },
    periodStart: NOW - 86_400_000,
    periodEnd: NOW,
    registryVersions: ['iso-42001:2023'],
    policyVersions: ['policy-1'],
    sourceRevisionSet: ['controls:' + version],
    outcomes: [{ key: 'control:c-1', type: 'control', status, recordRef: '/controls/c-1' }],
    evidenceRefs: ['evidence-1'],
    decisionRefs: ['decision-1'],
    authorPrincipalIds: ['author-a'],
  };
}

function signed(
  tenantId: string,
  id: string,
  version: number,
  status: string,
): SignedReviewSnapshot {
  return createSignedReviewSnapshot({
    snapshotId: id,
    source: source(tenantId, version, status),
    signerPrincipalId: PRINCIPAL,
    signerRole: 'governance_officer',
    authorityDecisionId: AUTHORITY,
    requireIndependentSigner: true,
    signedAt: NOW + version,
    signatureAlgorithm: 'test-sha256',
    signatureKeyId: 'test-key',
    signDigest: (digest) => 'signature:' + digest,
  });
}

function harness(tenantId = TENANT) {
  const snapshots = new Map<string, SignedReviewSnapshot>();
  snapshots.set(BASELINE, signed(TENANT, BASELINE, 1, 'fail'));
  snapshots.set(TARGET, signed(TENANT, TARGET, 2, 'pass'));
  const foreignId = '018f0000-0000-7000-8000-000000000042';
  snapshots.set(foreignId, signed(OTHER_TENANT, foreignId, 1, 'fail'));
  const commits: ReviewSnapshotCommit[] = [];
  const comparisons: ReviewComparisonCommit[] = [];

  const deps: GovernedPlatformRouteDeps = {
    now: () => NOW,
    nextId: (kind) => (kind === 'review-comparison' ? COMPARISON : TARGET),
    signDigest: (digest) => 'signature:' + digest,
    reviews: {
      listSnapshots: (scopeTenantId) =>
        [...snapshots.values()].filter((item) => item.tenantId === scopeTenantId),
      readReviewSource: (scopeTenantId, reviewId, reviewVersion) =>
        reviewId === REVIEW && scopeTenantId === tenantId
          ? source(scopeTenantId, reviewVersion, reviewVersion === 1 ? 'fail' : 'pass')
          : undefined,
      readSnapshot: (scopeTenantId, snapshotId) => {
        const item = snapshots.get(snapshotId);
        return item?.tenantId === scopeTenantId ? item : undefined;
      },
      commitSnapshot: (commit) => {
        const replay = snapshots.has(commit.snapshot.id);
        if (!replay) snapshots.set(commit.snapshot.id, commit.snapshot);
        commits.push(commit);
        return { snapshot: snapshots.get(commit.snapshot.id)!, idempotentReplay: replay };
      },
      commitComparison: (commit) => {
        comparisons.push(commit);
        return commit.comparison;
      },
    },
  };
  const options: AppOptions = {
    verifyIdentity: identity(tenantId),
    readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
    now: () => NOW,
  };
  const { app } = createApp(options);
  registerGovernedPlatformRoutes(app, deps);
  return { fetch: (request: Request) => app.fetch(request), commits, comparisons, foreignId };
}

function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://internal' + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const operationHeaders = {
  'x-correlation-id': 'correlation-review-0001',
  'idempotency-key': 'idempotency-review-0001',
};

describe('governed review snapshot API', () => {
  it('lists only immutable snapshots in the authenticated tenant with truthful metadata', async () => {
    const app = harness();
    const response = await app.fetch(request('/v1/review-snapshots'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const items = body['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items.every((item) => item['tenant_id'] === TENANT)).toBe(true);
    expect((body['metadata'] as Record<string, unknown>)['source_cursor']).toBeTruthy();
  });

  it('signs from the tenant-scoped source, ignores no caller tenant, and binds operation metadata', async () => {
    const app = harness();
    const response = await app.fetch(
      request(
        '/v1/review-snapshots',
        'POST',
        {
          schema_version: 1,
          reason: { code: 'review.period_close', text: 'Close the approved review period.' },
          authority_decision_id: AUTHORITY,
          input: {
            snapshot_id: TARGET,
            review_id: REVIEW,
            review_version: 2,
            require_independent_signer: true,
            signature_algorithm: 'test-sha256',
            signature_key_id: 'test-key',
          },
        },
        operationHeaders,
      ),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['tenant_id']).toBe(TENANT);
    expect(body['canonical_digest']).toMatch(/^[a-f0-9]{64}$/);
    expect(app.commits[0]?.tenantId).toBe(TENANT);
    expect(app.commits[0]?.correlationId).toBe(operationHeaders['x-correlation-id']);
  });

  it('compares two compatible tenant snapshots and returns attributable deltas', async () => {
    const app = harness();
    const response = await app.fetch(
      request(
        '/v1/review-comparisons',
        'POST',
        { baseline_snapshot_id: BASELINE, target_snapshot_id: TARGET },
        { 'x-correlation-id': operationHeaders['x-correlation-id'] },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['compatibility']).toBe('compatible');
    expect(body['improved_refs']).toEqual(['/controls/c-1']);
    expect(app.comparisons).toHaveLength(1);
  });

  it('does not disclose a foreign snapshot during comparison', async () => {
    const app = harness();
    const response = await app.fetch(
      request(
        '/v1/review-comparisons',
        'POST',
        { baseline_snapshot_id: BASELINE, target_snapshot_id: app.foreignId },
        { 'x-correlation-id': operationHeaders['x-correlation-id'] },
      ),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(OTHER_TENANT);
  });

  it('fails closed for missing operation headers and unrecognized snapshot fields', async () => {
    const app = harness();
    const body = {
      schema_version: 1,
      reason: { code: 'review.period_close', text: 'Close the approved review period.' },
      authority_decision_id: AUTHORITY,
      input: {
        snapshot_id: TARGET,
        review_id: REVIEW,
        review_version: 2,
        require_independent_signer: true,
        signature_algorithm: 'test-sha256',
        signature_key_id: 'test-key',
        tenant_id: OTHER_TENANT,
      },
    };
    expect((await app.fetch(request('/v1/review-snapshots', 'POST', body))).status).toBe(400);
    expect(
      (await app.fetch(request('/v1/review-snapshots', 'POST', body, operationHeaders))).status,
    ).toBe(400);
  });
});

const REGISTER_ID = '018f0000-0000-7000-8000-000000000060';
const VIEW_ID = '018f0000-0000-7000-8000-000000000070';
const SUBSCRIPTION_ID = '018f0000-0000-7000-8000-000000000080';

function commandBody(input: Record<string, unknown>) {
  return {
    schema_version: 1,
    reason: { code: 'governance.change', text: 'Apply the tenant-authorized governed change.' },
    authority_decision_id: AUTHORITY,
    input,
  };
}

function requiredInputText(input: Readonly<Record<string, unknown>>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string') throw new TypeError(field + ' is required');
  return value;
}

function collaborationHarness() {
  const records = new Map<string, GovernedRegisterRecord>();
  const views = new Map<string, GovernedView>();
  const subscriptions = new Map<string, GovernedSubscription>();
  const attempts: GovernedDeliveryAttemptView[] = [
    {
      id: '018f0000-0000-7000-8000-000000000090',
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION_ID,
      channel: 'email',
      status: 'partial',
      attempt: 2,
      lastAttemptAt: NOW,
      nextAttemptAt: NOW + 1_000,
      correlationId: 'correlation-delivery-0001',
    },
    {
      id: '018f0000-0000-7000-8000-000000000091',
      tenantId: TENANT,
      subscriptionId: SUBSCRIPTION_ID,
      channel: 'webhook',
      status: 'terminal',
      attempt: 3,
      lastAttemptAt: NOW,
      terminalReason: 'recipient authority revoked',
      correlationId: 'correlation-delivery-0002',
    },
    {
      id: '018f0000-0000-7000-8000-000000000092',
      tenantId: OTHER_TENANT,
      subscriptionId: SUBSCRIPTION_ID,
      channel: 'chat',
      status: 'terminal',
      attempt: 3,
      lastAttemptAt: NOW,
      terminalReason: 'foreign tenant',
      correlationId: 'correlation-delivery-0003',
    },
  ];

  const collaboration: GovernedCollaborationRoutePort = {
    listRegisterRecords: (tenantId, query) =>
      [...records.values()]
        .filter(
          (record) =>
            record.tenantId === tenantId &&
            (query.kind === undefined || record.kind === query.kind) &&
            (query.status === undefined || record.status === query.status),
        )
        .map((record) => ({ ...record, secret: 'must-not-leak' })),
    createRegisterRecord: (command) => {
      const input = command.input;
      const kind = requiredInputText(input, 'kind') as Parameters<
        typeof createGovernedRegisterRecord
      >[0]['kind'];
      const record = createGovernedRegisterRecord({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        kind,
        title: requiredInputText(input, 'title'),
        description: requiredInputText(input, 'description'),
        ownerPrincipalId: requiredInputText(input, 'owner_principal_id'),
        createdByPrincipalId: command.actorPrincipalId,
        reason: command.reason,
        now: NOW,
        ...(typeof input['expires_at'] === 'number' ? { expiresAt: input['expires_at'] } : {}),
        ...(typeof input['review_at'] === 'number' ? { reviewAt: input['review_at'] } : {}),
        ...(Array.isArray(input['compensating_control_refs'])
          ? { compensatingControlRefs: input['compensating_control_refs'] as string[] }
          : {}),
      });
      records.set(record.id, record);
      return record;
    },
    transitionRegisterRecord: (command) => {
      const current = records.get(command.recordId);
      if (!current) throw new TypeError('register record not found');
      const record = transitionGovernedRegisterRecord({
        record: current,
        tenantId: command.tenantId,
        expectedVersion: command.expectedVersion,
        toStatus: command.transition as Parameters<
          typeof transitionGovernedRegisterRecord
        >[0]['toStatus'],
        actorPrincipalId: command.actorPrincipalId,
        authorityDecisionId: command.authorityDecisionId,
        reason: command.reason,
        now: NOW + current.version,
      });
      records.set(record.id, record);
      return record;
    },
    listGovernedViews: (tenantId, principalId) =>
      [...views.values()].filter(
        (view) =>
          view.tenantId === tenantId &&
          (view.ownerPrincipalId === principalId ||
            view.sharedWithPrincipalIds.includes(principalId)),
      ),
    createGovernedView: (command) => {
      const input = command.input;
      const view = createGovernedView({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        ownerPrincipalId: command.actorPrincipalId,
        name: requiredInputText(input, 'name'),
        resourceKind: requiredInputText(input, 'resource_kind') as 'register_record',
        filter: input['filter'] as Parameters<typeof createGovernedView>[0]['filter'],
        fields: input['fields'] as Parameters<typeof createGovernedView>[0]['fields'],
        sharedWithPrincipalIds:
          (input['shared_with_principal_ids'] as readonly string[] | undefined) ?? [],
        now: NOW,
      });
      views.set(view.id, view);
      return view;
    },
    createSubscription: (command) => {
      const input = command.input;
      const view = views.get(requiredInputText(input, 'view_id'));
      if (!view) throw new TypeError('governed view not found');
      const subscription = createGovernedSubscription({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        view,
        recipientPrincipalId: requiredInputText(input, 'recipient_principal_id'),
        channels: input['channels'] as Parameters<typeof createGovernedSubscription>[0]['channels'],
        cadenceMinutes: Number(input['cadence_minutes']),
        escalationAfterMinutes: Number(input['escalation_after_minutes']),
        createdAt: NOW,
      });
      subscriptions.set(subscription.id, subscription);
      return subscription;
    },
    listDeliveryAttempts: (tenantId, _principalId, status) =>
      attempts.filter(
        (attempt) =>
          attempt.tenantId === tenantId && (status === undefined || attempt.status === status),
      ),
  };

  const review = harness();
  const options: AppOptions = {
    verifyIdentity: identity(),
    readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
    now: () => NOW,
  };
  const { app } = createApp(options);
  registerGovernedPlatformRoutes(app, {
    now: () => NOW,
    nextId: () => COMPARISON,
    signDigest: (digest) => 'signature:' + digest,
    reviews: {
      listSnapshots: () => [],
      readReviewSource: () => undefined,
      readSnapshot: () => undefined,
      commitSnapshot: () => {
        throw new Error('not used');
      },
      commitComparison: () => {
        throw new Error('not used');
      },
    },
    collaboration,
  });
  return {
    fetch: (request: Request) => app.fetch(request),
    records,
    views,
    subscriptions,
    attempts,
    review,
  };
}

describe('governed register, view, subscription, and delivery API', () => {
  it('creates and version-transitions a tenant register with stale-write conflict handling', async () => {
    const app = collaborationHarness();
    const createResponse = await app.fetch(
      request(
        '/v1/register-records',
        'POST',
        commandBody({
          id: REGISTER_ID,
          kind: 'gap',
          title: 'Unverified production control',
          description: 'The current source cannot demonstrate the control outcome.',
          owner_principal_id: PRINCIPAL,
        }),
        operationHeaders,
      ),
    );
    expect(createResponse.status, JSON.stringify(await createResponse.clone().json())).toBe(201);
    expect(((await createResponse.json()) as Record<string, unknown>)['tenant_id']).toBe(TENANT);

    const transitionBody = {
      transition: 'triage',
      reason: { code: 'governance.triage', text: 'Move the reviewed gap into triage.' },
      authority_decision_id: AUTHORITY,
    };
    const transitioned = await app.fetch(
      request('/v1/register-records/' + REGISTER_ID + '/transitions', 'POST', transitionBody, {
        ...operationHeaders,
        'if-match': '"1"',
      }),
    );
    expect(transitioned.status).toBe(200);
    expect(((await transitioned.json()) as Record<string, unknown>)['version']).toBe(2);

    const stale = await app.fetch(
      request('/v1/register-records/' + REGISTER_ID + '/transitions', 'POST', transitionBody, {
        ...operationHeaders,
        'if-match': '"1"',
      }),
    );
    expect(stale.status).toBe(409);
  });

  it('returns only allowlisted tenant fields and keeps delivery failures visible', async () => {
    const app = collaborationHarness();
    await app.fetch(
      request(
        '/v1/register-records',
        'POST',
        commandBody({
          id: REGISTER_ID,
          kind: 'gap',
          title: 'Material gap',
          description: 'A gap that must remain visible.',
          owner_principal_id: PRINCIPAL,
        }),
        operationHeaders,
      ),
    );
    const recordsResponse = await app.fetch(request('/v1/register-records?kind=gap'));
    expect(recordsResponse.status).toBe(200);
    const recordsBody = (await recordsResponse.json()) as Record<string, unknown>;
    expect(JSON.stringify(recordsBody)).not.toContain('must-not-leak');

    const deliveries = await app.fetch(request('/v1/delivery-attempts'));
    const deliveryBody = (await deliveries.json()) as Record<string, unknown>;
    const items = deliveryBody['items'] as Record<string, unknown>[];
    expect(items.map((item) => item['status']).sort()).toEqual(['partial', 'terminal']);
    expect(JSON.stringify(deliveryBody)).not.toContain(OTHER_TENANT);
  });

  it('creates a governed view and subscription but rejects caller-supplied tenant scope', async () => {
    const app = collaborationHarness();
    const viewResponse = await app.fetch(
      request(
        '/v1/governed-views',
        'POST',
        commandBody({
          id: VIEW_ID,
          name: 'Active gaps',
          resource_kind: 'register_record',
          filter: { op: 'eq', field: 'kind', value: 'gap' },
          fields: ['id', 'title', 'status'],
          shared_with_principal_ids: [],
        }),
        operationHeaders,
      ),
    );
    expect(viewResponse.status, JSON.stringify(await viewResponse.clone().json())).toBe(201);
    expect(((await viewResponse.json()) as Record<string, unknown>)['query_digest']).toMatch(
      /^[a-f0-9]{64}$/,
    );

    const subscriptionResponse = await app.fetch(
      request(
        '/v1/subscriptions',
        'POST',
        commandBody({
          id: SUBSCRIPTION_ID,
          view_id: VIEW_ID,
          recipient_principal_id: PRINCIPAL,
          channels: ['in_app', 'email'],
          cadence_minutes: 60,
          escalation_after_minutes: 180,
        }),
        operationHeaders,
      ),
    );
    expect(subscriptionResponse.status).toBe(201);

    const injected = await app.fetch(
      request(
        '/v1/governed-views',
        'POST',
        commandBody({
          id: VIEW_ID,
          tenant_id: OTHER_TENANT,
          name: 'Injected scope',
          resource_kind: 'register_record',
          filter: { op: 'eq', field: 'kind', value: 'gap' },
          fields: ['id'],
          shared_with_principal_ids: [],
        }),
        operationHeaders,
      ),
    );
    expect(injected.status).toBe(400);
  });
});

const AUDITOR = '018f0000-0000-7000-8000-000000000011';
const EVIDENCE_REQUEST_ID = '018f0000-0000-7000-8000-0000000000a0';
const ATTESTATION_ID = '018f0000-0000-7000-8000-0000000000a1';
const DECISION_ID = '018f0000-0000-7000-8000-0000000000a2';
const PACKAGE_ID = '018f0000-0000-7000-8000-0000000000a3';
const PACKAGE_OPERATION_ID = '018f0000-0000-7000-8000-0000000000a4';

function evidenceHarness() {
  const requests = new Map<string, EvidenceRequest>();
  const attestations = new Map<string, EvidenceAttestation>();
  const foreign = issueEvidenceRequest({
    id: '018f0000-0000-7000-8000-0000000000af',
    tenantId: OTHER_TENANT,
    scope: { controlIds: ['foreign'] },
    requestedEvidenceTypes: ['configuration'],
    ownerPrincipalId: PRINCIPAL,
    requesterPrincipalId: AUDITOR,
    dueAt: NOW + 10_000,
    expiresAt: NOW + 20_000,
    reason: { code: 'audit.sample', text: 'Foreign tenant request.' },
    now: NOW,
  });
  requests.set(foreign.id, foreign);

  const evidence: GovernedEvidenceRoutePort = {
    listEvidenceRequests: () => [...requests.values()],
    issueEvidenceRequest: (command) => {
      const input = command.input;
      const created = issueEvidenceRequest({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        scope: input['scope'] as Record<string, unknown>,
        requestedEvidenceTypes: input['requested_evidence_types'] as string[],
        ownerPrincipalId: requiredInputText(input, 'owner_principal_id'),
        requesterPrincipalId: command.actorPrincipalId,
        dueAt: Number(input['due_at']),
        expiresAt: Number(input['expires_at']),
        reason: command.reason,
        now: NOW,
      });
      requests.set(created.id, created);
      return created;
    },
    attestEvidence: (command) => {
      const request = requests.get(command.recordId);
      if (!request) throw new TypeError('evidence request not found');
      const input = command.input;
      const evidenceVersions = (input['evidence_versions'] as Record<string, unknown>[]).map(
        (binding) => ({
          evidenceId: requiredInputText(binding, 'evidence_id'),
          version: Number(binding['version']),
          digest: requiredInputText(binding, 'digest'),
        }),
      );
      const submitted = submitEvidenceAttestation({
        request,
        tenantId: command.tenantId,
        expectedRequestVersion: Number(input['expected_request_version']),
        attestationId: requiredInputText(input, 'attestation_id'),
        actorPrincipalId: command.actorPrincipalId,
        evidenceVersions,
        statement: requiredInputText(input, 'statement'),
        signature: command.signature.value,
        signedAt: NOW + 1,
      });
      requests.set(submitted.request.id, submitted.request);
      attestations.set(submitted.attestation.requestId, submitted.attestation);
      return submitted;
    },
    decideEvidenceSufficiency: (command) => {
      const request = requests.get(command.recordId);
      const attestation = attestations.get(command.recordId);
      if (!request || !attestation) throw new TypeError('submitted evidence not found');
      const decided = decideEvidenceSufficiency({
        request,
        attestation,
        tenantId: command.tenantId,
        expectedRequestVersion: command.expectedVersion,
        decisionId: requiredInputText(command.input, 'decision_id'),
        actorPrincipalId: command.actorPrincipalId,
        decision: command.transition as 'sufficient' | 'insufficient',
        reason: command.reason,
        decidedAt: NOW + 2,
      });
      requests.set(decided.request.id, decided.request);
      return decided;
    },
    requestEvidencePackage: () => ({
      operationId: PACKAGE_OPERATION_ID,
      status: 'accepted',
      idempotentReplay: false,
    }),
    verifyEvidencePackage: (input) => ({
      packageId: input.packageId,
      valid: true,
      reason: null,
      verifiedAt: NOW + 3,
      canonicalDigest: 'b'.repeat(64),
    }),
  };

  const client = (principalId: string, tenantId = TENANT) => {
    const options: AppOptions = {
      verifyIdentity: () => ({
        principalId,
        tenantId,
        roles: principalId === AUDITOR ? ['auditor'] : ['control_owner'],
        isBrowserSession: false,
      }),
      readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
      now: () => NOW,
    };
    const { app } = createApp(options);
    registerGovernedPlatformRoutes(app, {
      now: () => NOW,
      nextId: () => COMPARISON,
      signDigest: (digest) => 'signature:' + digest,
      reviews: {
        listSnapshots: () => [],
        readReviewSource: () => undefined,
        readSnapshot: () => undefined,
        commitSnapshot: () => {
          throw new Error('not used');
        },
        commitComparison: () => {
          throw new Error('not used');
        },
      },
      evidence,
    });
    return (request: Request) => app.fetch(request);
  };
  return { owner: client(PRINCIPAL), auditor: client(AUDITOR), requests, attestations };
}

describe('governed evidence assurance API', () => {
  it('issues, attests, and independently decides exact-version evidence', async () => {
    const app = evidenceHarness();
    const issuedResponse = await app.owner(
      request(
        '/v1/evidence-requests',
        'POST',
        commandBody({
          id: EVIDENCE_REQUEST_ID,
          scope: { controlIds: ['control-1'] },
          requested_evidence_types: ['configuration'],
          owner_principal_id: PRINCIPAL,
          due_at: NOW + 10_000,
          expires_at: NOW + 20_000,
        }),
        operationHeaders,
      ),
    );
    expect(issuedResponse.status).toBe(201);

    const attestationResponse = await app.owner(
      request(
        '/v1/evidence-requests/' + EVIDENCE_REQUEST_ID + '/attestations',
        'POST',
        {
          schema_version: 1,
          reason: { code: 'evidence.attest', text: 'Attest the exact evidence version.' },
          input: {
            expected_request_version: 1,
            attestation_id: ATTESTATION_ID,
            evidence_versions: [{ evidence_id: 'evidence-1', version: 3, digest: 'a'.repeat(64) }],
            statement: 'The evidence is complete for the requested scope.',
          },
          signature: {
            algorithm: 'test-sha256',
            key_id: 'owner-key',
            digest: 'c'.repeat(64),
            value: 'owner-signature',
          },
        },
        operationHeaders,
      ),
    );
    expect(attestationResponse.status).toBe(201);

    const decisionResponse = await app.auditor(
      request(
        '/v1/evidence-requests/' + EVIDENCE_REQUEST_ID + '/sufficiency-decisions',
        'POST',
        {
          transition: 'sufficient',
          reason: {
            code: 'evidence.sufficient',
            text: 'The exact attested version satisfies the request.',
          },
          authority_decision_id: AUTHORITY,
          input: { decision_id: DECISION_ID },
        },
        { ...operationHeaders, 'if-match': '"2"' },
      ),
    );
    expect(decisionResponse.status).toBe(201);
    const body = (await decisionResponse.json()) as Record<string, unknown>;
    expect((body['request'] as Record<string, unknown>)['status']).toBe('accepted');
    expect((body['decision'] as Record<string, unknown>)['attestation_digest']).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('filters foreign requests and exposes asynchronous package acceptance and verification', async () => {
    const app = evidenceHarness();
    const list = await app.owner(request('/v1/evidence-requests'));
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain(OTHER_TENANT);

    const accepted = await app.auditor(
      request(
        '/v1/evidence-packages',
        'POST',
        commandBody({
          package_id: PACKAGE_ID,
          audience_principal_ids: [AUDITOR],
          scope: { controlIds: ['control-1'] },
        }),
        operationHeaders,
      ),
    );
    expect(accepted.status).toBe(202);
    expect(((await accepted.json()) as Record<string, unknown>)['operation_id']).toBe(
      PACKAGE_OPERATION_ID,
    );

    const verified = await app.auditor(
      request('/v1/evidence-packages/' + PACKAGE_ID + '/verify', 'POST', undefined, {
        'x-correlation-id': operationHeaders['x-correlation-id'],
      }),
    );
    expect(verified.status).toBe(200);
    expect(((await verified.json()) as Record<string, unknown>)['valid']).toBe(true);
  });
});

const OBSERVATION_OPERATION_ID = '018f0000-0000-7000-8000-0000000000b0';
const PREVIEW_ID = '018f0000-0000-7000-8000-0000000000b1';
const PREVIEW_OPERATION_ID = '018f0000-0000-7000-8000-0000000000b2';
const PUBLICATION_ID = '018f0000-0000-7000-8000-0000000000b3';
const PUBLICATION_OPERATION_ID = '018f0000-0000-7000-8000-0000000000b4';

function monitoringHarness() {
  const service = new ContinuousMonitoringService(TENANT);
  const previews = new Map<string, ImpactPreview>();
  const publications = new Map<string, ChangePublication>();
  const sourceVersions: Record<string, number> = { '/controls/c-1': 2, '/projections/p-1': 4 };
  const graph = [
    {
      ref: '/controls/c-1',
      tenantId: TENANT,
      kind: 'control' as const,
      version: 2,
      dependsOn: [],
    },
    {
      ref: '/projections/p-1',
      tenantId: TENANT,
      kind: 'projection' as const,
      version: 4,
      dependsOn: ['/controls/c-1'],
    },
  ];
  const monitoring: GovernedMonitoringRoutePort = {
    ingestControlObservation: (command) => {
      const input = command.input;
      const result = service.ingest(
        {
          id: requiredInputText(input, 'id'),
          tenantId: command.tenantId,
          sourceId: requiredInputText(input, 'source_id'),
          sourceEventId: requiredInputText(input, 'source_event_id'),
          sourceContractVersion: Number(input['source_contract_version']),
          assetId: requiredInputText(input, 'asset_id'),
          controlId: requiredInputText(input, 'control_id'),
          conditionId: requiredInputText(input, 'condition_id'),
          observedAt: Number(input['observed_at']),
          receivedAt: Number(input['received_at']),
          status: requiredInputText(input, 'status') as 'pass',
          freshness: requiredInputText(input, 'freshness') as 'fresh',
          completeness: requiredInputText(input, 'completeness') as 'complete',
          confidence: Number(input['confidence']),
          payloadEvidenceRef: requiredInputText(input, 'payload_evidence_ref'),
          sourceHealth: requiredInputText(input, 'source_health') as 'healthy',
          correlationAttributes:
            (input['correlation_attributes'] as Readonly<Record<string, unknown>>) ?? {},
        },
        {
          id: 'production-control-condition',
          tenantId: command.tenantId,
          version: 1,
          keyAttributes: ['assetId', 'controlId', 'conditionId'],
          requiredSourceIds: ['scanner-a', 'scanner-b'],
          staleAfterMs: 60_000,
          defaultOwnerPrincipalId: PRINCIPAL,
          maxObservationRefs: 100,
        },
        NOW,
      );
      return {
        operationId: OBSERVATION_OPERATION_ID,
        status: result.ingestStatus === 'duplicate' ? 'completed' : 'accepted',
        idempotentReplay: result.ingestStatus === 'duplicate',
      };
    },
    listMonitoringCases: (tenantId, _principalId, status) =>
      service
        .cases()
        .filter(
          (item) => item.tenantId === tenantId && (status === undefined || item.status === status),
        ),
    requestImpactPreview: (command) => {
      const input = command.input;
      const preview = createImpactPreview({
        id: requiredInputText(input, 'preview_id'),
        tenantId: command.tenantId,
        proposalType: requiredInputText(input, 'proposal_type'),
        proposalRef: requiredInputText(input, 'proposal_ref'),
        proposalDigest: requiredInputText(input, 'proposal_digest'),
        requestedBy: command.actorPrincipalId,
        graph,
        generatedAt: NOW,
        expiresAt: Number(input['expires_at']),
      });
      previews.set(preview.id, preview);
      return {
        operationId: PREVIEW_OPERATION_ID,
        status: 'accepted',
        idempotentReplay: false,
      };
    },
    publishGovernedChange: (command) => {
      const input = command.input;
      const preview = previews.get(requiredInputText(input, 'preview_id'));
      if (!preview) throw new TypeError('impact preview not found');
      const publication = publishGovernedChange({
        id: requiredInputText(input, 'publication_id'),
        preview,
        tenantId: command.tenantId,
        approvedBy: command.actorPrincipalId,
        approvalDecisionId: command.authorityDecisionId ?? '',
        targetVersion: Number(input['target_version']),
        currentSourceVersionSet: sourceVersions,
        proposalDigest: requiredInputText(input, 'proposal_digest'),
        publishedAt: NOW + 1,
        rollbackPlanRef: requiredInputText(input, 'rollback_plan_ref'),
      });
      publications.set(publication.id, publication);
      return {
        operationId: PUBLICATION_OPERATION_ID,
        status: 'accepted',
        idempotentReplay: false,
      };
    },
  };

  const client = (principalId: string) => {
    const options: AppOptions = {
      verifyIdentity: () => ({
        principalId,
        tenantId: TENANT,
        roles: ['governance_officer'],
        isBrowserSession: false,
      }),
      readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
      now: () => NOW,
    };
    const { app } = createApp(options);
    registerGovernedPlatformRoutes(app, {
      now: () => NOW,
      nextId: () => COMPARISON,
      signDigest: (value) => 'signature:' + value,
      reviews: {
        listSnapshots: () => [],
        readReviewSource: () => undefined,
        readSnapshot: () => undefined,
        commitSnapshot: () => {
          throw new Error('not used');
        },
        commitComparison: () => {
          throw new Error('not used');
        },
      },
      monitoring,
    });
    return (request: Request) => app.fetch(request);
  };
  return {
    operator: client(PRINCIPAL),
    approver: client(AUDITOR),
    service,
    previews,
    publications,
    sourceVersions,
    graph,
  };
}

function observationCommand(extra: Record<string, unknown> = {}) {
  return commandBody({
    id: '018f0000-0000-7000-8000-0000000000b5',
    source_id: 'scanner-a',
    source_event_id: 'source-event-1',
    source_contract_version: 1,
    asset_id: 'asset-1',
    control_id: 'control-1',
    condition_id: 'condition-1',
    observed_at: NOW - 1_000,
    received_at: NOW,
    status: 'pass',
    freshness: 'fresh',
    completeness: 'partial',
    confidence: 0.75,
    payload_evidence_ref: '/evidence/monitoring-1',
    source_health: 'degraded',
    correlation_attributes: {},
    ...extra,
  });
}

function previewCommand() {
  return commandBody({
    preview_id: PREVIEW_ID,
    proposal_type: 'control',
    proposal_ref: '/controls/c-1',
    proposal_digest: 'd'.repeat(64),
    expires_at: NOW + 60_000,
  });
}

function publicationCommand() {
  return {
    transition: 'publish',
    reason: { code: 'change.publish', text: 'Publish the independently approved change.' },
    authority_decision_id: AUTHORITY,
    input: {
      preview_id: PREVIEW_ID,
      publication_id: PUBLICATION_ID,
      proposal_digest: 'd'.repeat(64),
      target_version: 3,
      rollback_plan_ref: '/rollback/plans/control-c-1',
    },
  };
}

describe('governed monitoring and impact API', () => {
  it('accepts observations idempotently and exposes fail-visible tenant cases', async () => {
    const app = monitoringHarness();
    const accepted = await app.operator(
      request('/v1/control-observations', 'POST', observationCommand(), operationHeaders),
    );
    expect(accepted.status).toBe(202);
    const replay = await app.operator(
      request('/v1/control-observations', 'POST', observationCommand(), operationHeaders),
    );
    expect(replay.status).toBe(202);
    expect((await replay.json())['idempotent_replay']).toBe(true);
    expect(app.service.observations()).toHaveLength(1);
    expect(app.service.cases()).toHaveLength(1);

    const cases = await app.operator(request('/v1/monitoring-cases'));
    expect(cases.status).toBe(200);
    const body = (await cases.json()) as Record<string, unknown>;
    const item = (body['items'] as Record<string, unknown>[])[0]!;
    expect(item['assurance_outcome']).toBe('unknown');
    expect(item['uncertainty_reasons']).toEqual(
      expect.arrayContaining(['missing_source:scanner-b', 'partial', 'source_degraded']),
    );
    expect(JSON.stringify(body)).not.toContain(OTHER_TENANT);
  });

  it('rejects caller-supplied observation tenant scope before any monitoring effect', async () => {
    const app = monitoringHarness();
    const response = await app.operator(
      request(
        '/v1/control-observations',
        'POST',
        observationCommand({ tenant_id: OTHER_TENANT }),
        operationHeaders,
      ),
    );
    expect(response.status).toBe(400);
    expect(app.service.observations()).toHaveLength(0);
    expect(app.service.cases()).toHaveLength(0);
  });

  it('creates a pure preview and publishes only with independent current authority', async () => {
    const app = monitoringHarness();
    const graphBefore = JSON.stringify(app.graph);
    const preview = await app.operator(
      request('/v1/impact-previews', 'POST', previewCommand(), operationHeaders),
    );
    expect(preview.status).toBe(202);
    expect(JSON.stringify(app.graph)).toBe(graphBefore);
    expect(app.previews.get(PREVIEW_ID)?.projectionRefs).toEqual(['/projections/p-1']);

    const selfApproval = await app.operator(
      request('/v1/change-publications', 'POST', publicationCommand(), operationHeaders),
    );
    expect(selfApproval.status).toBe(403);
    expect(app.publications).toHaveLength(0);

    const published = await app.approver(
      request('/v1/change-publications', 'POST', publicationCommand(), operationHeaders),
    );
    expect(published.status).toBe(202);
    expect(app.publications.get(PUBLICATION_ID)?.rebuildStatus).toBe('pending');
  });

  it('returns conflict and emits no publication when any preview-bound source drifts', async () => {
    const app = monitoringHarness();
    await app.operator(request('/v1/impact-previews', 'POST', previewCommand(), operationHeaders));
    app.sourceVersions['/controls/c-1'] = 3;
    const response = await app.approver(
      request('/v1/change-publications', 'POST', publicationCommand(), operationHeaders),
    );
    expect(response.status).toBe(409);
    expect(app.publications).toHaveLength(0);
  });
});

const AI_USE_CASE_ID = '018f0000-0000-7000-8000-0000000000c0';
const AI_INCIDENT_ID = '018f0000-0000-7000-8000-0000000000c1';

function aiCommand(extra: Record<string, unknown> = {}) {
  return commandBody({
    id: AI_USE_CASE_ID,
    name: 'Governance evidence assistant',
    purpose: 'Summarize authorized governed records with exact citations.',
    owner_principal_id: PRINCIPAL,
    affected_people: ['tenant operators'],
    affected_systems: ['trustcircle-console'],
    risk_class: 'high',
    obligation_refs: ['/obligations/ai-1'],
    control_refs: ['/controls/ai-1'],
    oversight_plan:
      'Independent evaluation, approval, monitoring, incident response, and retirement.',
    prohibited_uses: ['approval', 'attestation', 'certification'],
    monitoring_rule_refs: ['/monitoring-rules/ai-1'],
    retirement_conditions: ['failed safety evaluation'],
    ...extra,
  });
}

function aiHarness() {
  const useCases = new Map<string, AiUseCase>();
  const foreign = createAiUseCase({
    id: '018f0000-0000-7000-8000-0000000000cf',
    tenantId: OTHER_TENANT,
    name: 'Foreign assistant',
    purpose: 'Must never be disclosed.',
    ownerPrincipalId: PRINCIPAL,
    affectedPeople: ['foreign operators'],
    affectedSystems: ['foreign-console'],
    riskClass: 'high',
    obligationRefs: ['/obligations/foreign'],
    controlRefs: ['/controls/foreign'],
    oversightPlan: 'Foreign tenant oversight.',
    prohibitedUses: ['approval'],
    monitoringRuleRefs: ['/monitoring-rules/foreign'],
    retirementConditions: ['retire'],
    createdByPrincipalId: PRINCIPAL,
    now: NOW,
  });
  useCases.set(foreign.id, foreign);
  const ai: GovernedAiRoutePort = {
    listAiUseCases: () => [...useCases.values()],
    createAiUseCase: (command) => {
      const input = command.input;
      const created = createAiUseCase({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        name: requiredInputText(input, 'name'),
        purpose: requiredInputText(input, 'purpose'),
        ownerPrincipalId: requiredInputText(input, 'owner_principal_id'),
        affectedPeople: input['affected_people'] as string[],
        affectedSystems: input['affected_systems'] as string[],
        riskClass: requiredInputText(input, 'risk_class'),
        obligationRefs: input['obligation_refs'] as string[],
        controlRefs: input['control_refs'] as string[],
        oversightPlan: requiredInputText(input, 'oversight_plan'),
        prohibitedUses: input['prohibited_uses'] as string[],
        monitoringRuleRefs: input['monitoring_rule_refs'] as string[],
        retirementConditions: input['retirement_conditions'] as string[],
        createdByPrincipalId: command.actorPrincipalId,
        now: NOW,
      });
      useCases.set(created.id, created);
      return created;
    },
    transitionAiUseCase: (command) => {
      const current = useCases.get(command.recordId);
      if (!current) throw new TypeError('AI use case not found');
      if (command.transition !== 'retire') throw new TypeError('unsupported test transition');
      const retired = retireAiUseCase({
        useCase: current,
        tenantId: command.tenantId,
        actorPrincipalId: command.actorPrincipalId,
        authorityDecisionId: command.authorityDecisionId,
        reason: command.reason,
        now: NOW + 2,
      });
      useCases.set(retired.id, retired);
      return retired;
    },
    recordAiEvaluation: () => {
      throw new Error('not used');
    },
    reportAiIncident: (command) => {
      const current = useCases.get(command.recordId);
      if (!current) throw new TypeError('AI use case not found');
      const input = command.input;
      const result = reportAiIncident({
        useCase: current,
        tenantId: command.tenantId,
        id: requiredInputText(input, 'incident_id'),
        componentVersionRefs: (input['component_version_refs'] as string[]) ?? [],
        severity: requiredInputText(input, 'severity') as 'critical',
        affectedScope: input['affected_scope'] as Record<string, unknown>,
        source: requiredInputText(input, 'source'),
        evidenceRefs: input['evidence_refs'] as string[],
        ownerPrincipalId: requiredInputText(input, 'owner_principal_id'),
        containment: input['containment'] as string[],
        correctiveActions: input['corrective_actions'] as string[],
        detectedAt: NOW + 1,
      });
      useCases.set(result.useCase.id, result.useCase);
      return result;
    },
    createCopilotExchange: (command) => {
      const conflicting = command.input['conflicting'] === true;
      return generateGovernedCopilotResponse({
        id: requiredInputText(command.input, 'exchange_id'),
        tenantId: command.tenantId,
        principalId: command.actorPrincipalId,
        purpose: requiredInputText(command.input, 'purpose'),
        queryClassification: requiredInputText(command.input, 'query_classification'),
        policyDecisionId: AUTHORITY,
        sources: [
          {
            tenantId: command.tenantId,
            ref: '/register-records/gap-1',
            version: 4,
            digest: 'e'.repeat(64),
            kind: 'register_record',
            freshness: 'current',
            conflicting,
            authorized: true,
            facts: [{ label: 'Status', value: 'active' }],
          },
          {
            tenantId: OTHER_TENANT,
            ref: '/register-records/foreign',
            version: 1,
            digest: 'f'.repeat(64),
            kind: 'register_record',
            freshness: 'current',
            conflicting: false,
            authorized: true,
            facts: [{ label: 'Secret', value: 'must-not-leak' }],
          },
        ],
        createdAt: NOW,
      });
    },
  };

  const client = (principalId: string) => {
    const options: AppOptions = {
      verifyIdentity: () => ({
        principalId,
        tenantId: TENANT,
        roles: ['ai_governance_officer'],
        isBrowserSession: false,
      }),
      readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
      now: () => NOW,
    };
    const { app } = createApp(options);
    registerGovernedPlatformRoutes(app, {
      now: () => NOW,
      nextId: () => COMPARISON,
      signDigest: (value) => 'signature:' + value,
      reviews: {
        listSnapshots: () => [],
        readReviewSource: () => undefined,
        readSnapshot: () => undefined,
        commitSnapshot: () => {
          throw new Error('not used');
        },
        commitComparison: () => {
          throw new Error('not used');
        },
      },
      ai,
    });
    return (request: Request) => app.fetch(request);
  };
  return { owner: client(PRINCIPAL), reviewer: client(AUDITOR), useCases };
}

describe('governed AI lifecycle and copilot API', () => {
  it('creates and lists only tenant AI use cases while rejecting tenant injection before effect', async () => {
    const app = aiHarness();
    const rejected = await app.owner(
      request('/v1/ai-use-cases', 'POST', aiCommand({ tenant_id: OTHER_TENANT }), operationHeaders),
    );
    expect(rejected.status).toBe(400);
    expect(app.useCases).toHaveLength(1);

    const created = await app.owner(
      request('/v1/ai-use-cases', 'POST', aiCommand(), operationHeaders),
    );
    expect(created.status).toBe(201);
    expect(((await created.json()) as Record<string, unknown>)['tenant_id']).toBe(TENANT);
    const listed = await app.owner(request('/v1/ai-use-cases'));
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(JSON.stringify(body)).not.toContain(OTHER_TENANT);
    expect(JSON.stringify(body)).not.toContain('Must never be disclosed');
  });

  it('records an incident and retires without deleting lifecycle history', async () => {
    const app = aiHarness();
    await app.owner(request('/v1/ai-use-cases', 'POST', aiCommand(), operationHeaders));
    const incident = await app.reviewer(
      request(
        '/v1/ai-use-cases/' + AI_USE_CASE_ID + '/incidents',
        'POST',
        commandBody({
          incident_id: AI_INCIDENT_ID,
          component_version_refs: [],
          severity: 'critical',
          affected_scope: { systems: ['trustcircle-console'] },
          source: 'monitoring',
          evidence_refs: ['/evidence/ai-incident-1'],
          owner_principal_id: PRINCIPAL,
          containment: ['disable generated responses'],
          corrective_actions: ['repeat independent evaluation'],
        }),
        operationHeaders,
      ),
    );
    expect(incident.status).toBe(201);
    expect(((await incident.json()) as Record<string, unknown>)['lifecycle_state']).toBe(
      'suspended',
    );
    const retired = await app.reviewer(
      request(
        '/v1/ai-use-cases/' + AI_USE_CASE_ID + '/transitions',
        'POST',
        {
          transition: 'retire',
          reason: { code: 'ai.retire', text: 'Retire and preserve incident evidence.' },
          authority_decision_id: AUTHORITY,
        },
        { ...operationHeaders, 'if-match': '"2"' },
      ),
    );
    expect(retired.status).toBe(200);
    const body = (await retired.json()) as Record<string, unknown>;
    expect(body['lifecycle_state']).toBe('retired');
    expect((body['history'] as unknown[]).length).toBeGreaterThan(1);
    expect((body['incidents'] as unknown[]).length).toBe(1);
  });

  it('returns exact authorized citations, minimized metadata, and abstention for conflict', async () => {
    const app = aiHarness();
    const response = await app.owner(
      request(
        '/v1/copilot/exchanges',
        'POST',
        commandBody({
          exchange_id: '018f0000-0000-7000-8000-0000000000c2',
          purpose: 'governance_assistance',
          query_classification: 'status_lookup',
          conflicting: false,
        }),
        operationHeaders,
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['label']).toBe('generated_assistance');
    expect(body['authority']).toBe('non_authoritative');
    expect((body['citations'] as Record<string, unknown>[])[0]?.['citation_ref']).toBe(
      '/register-records/gap-1#v4',
    );
    expect(JSON.stringify(body)).not.toContain(OTHER_TENANT);
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body['audit_metadata'])).not.toContain('active');

    const abstained = await app.owner(
      request(
        '/v1/copilot/exchanges',
        'POST',
        commandBody({
          exchange_id: '018f0000-0000-7000-8000-0000000000c3',
          purpose: 'governance_assistance',
          query_classification: 'status_lookup',
          conflicting: true,
        }),
        operationHeaders,
      ),
    );
    const abstainedBody = (await abstained.json()) as Record<string, unknown>;
    expect(abstainedBody['abstention_code']).toBe('conflicting_sources');
    expect(abstainedBody['facts']).toEqual([]);
  });
});

const CONNECTOR_DEFINITION_ID = '018f0000-0000-7000-8000-0000000000d0';
const CONNECTOR_CERTIFICATION_ID = '018f0000-0000-7000-8000-0000000000d1';

function connectorDefinitionCommand(extra: Record<string, unknown> = {}) {
  return commandBody({
    id: CONNECTOR_DEFINITION_ID,
    adapter_id: 'kanban',
    exact_version: '2.4.0',
    manifest_digest: 'a'.repeat(64),
    mapping_refs: ['/connector-mappings/kanban-v1'],
    credential_class_refs: ['oauth-client'],
    pagination_policy: { mode: 'cursor', cursor_field: 'next_cursor', maximum_page_size: 100 },
    failure_policy: {
      correlation: 'required',
      idempotency: 'required',
      reconciliation: 'source_scoped',
      retry: 'bounded',
      replay: 'source_event_identity',
      terminal_failure: 'retained_for_reconciliation',
      revocation: 'block_new_work_reconcile_existing',
      migration: 'version_overlap',
      rollback: 'verified_preimage',
    },
    schema_version: 1,
    ...extra,
  });
}

function connectorCertificationCommand(extra: Record<string, unknown> = {}) {
  return commandBody({
    id: CONNECTOR_CERTIFICATION_ID,
    connector_id: 'kanban',
    exact_version: '2.4.0',
    manifest_digest: 'a'.repeat(64),
    report_digest: 'b'.repeat(64),
    report_manifest_digest: 'a'.repeat(64),
    suite_version: '2.0.0',
    report_passed: true,
    report_signature_valid: true,
    author_principal_id: PRINCIPAL,
    allowed_tenant_refs: [TENANT],
    allowed_scopes: ['boards:read'],
    allowed_capabilities: ['discover', 'reconcile'],
    credential_classes: ['oauth-client'],
    valid_from: NOW,
    expires_at: NOW + 86_400_000,
    ...extra,
  });
}

function connectorHarness() {
  const definitions: Record<string, unknown>[] = [];
  const certifications = new Map<string, ConnectorCertification>();
  const connectors: GovernedConnectorRoutePort = {
    createConnectorDefinition: (command) => {
      const created = {
        id: requiredInputText(command.input, 'id'),
        tenantId: command.tenantId,
        adapterId: requiredInputText(command.input, 'adapter_id'),
        exactVersion: requiredInputText(command.input, 'exact_version'),
        manifestDigest: requiredInputText(command.input, 'manifest_digest'),
        authorPrincipalId: command.actorPrincipalId,
        status: 'draft',
        digest: 'c'.repeat(64),
      };
      definitions.push(created);
      return created;
    },
    requestConformanceRun: (command) => ({
      operationId: 'connector-conformance:' + command.recordId,
      status: 'accepted',
      idempotentReplay: false,
    }),
    listConnectorCertifications: () => [
      ...certifications.values(),
      {
        ...certifyConnectorVersion({
          id: '018f0000-0000-7000-8000-0000000000df',
          tenantId: OTHER_TENANT,
          connectorId: 'foreign',
          exactVersion: '1.0.0',
          manifestDigest: 'd'.repeat(64),
          report: {
            reportDigest: 'e'.repeat(64),
            manifestDigest: 'd'.repeat(64),
            suiteVersion: '2.0.0',
            passed: true,
            signatureValid: true,
          },
          authorPrincipalId: PRINCIPAL,
          certifierPrincipalId: AUDITOR,
          certificationDecisionId: AUTHORITY,
          allowedTenantRefs: [OTHER_TENANT],
          allowedScopes: ['foreign:read'],
          allowedCapabilities: ['discover'],
          credentialClasses: ['oauth-client'],
          validFrom: NOW,
          expiresAt: NOW + 86_400_000,
          certifiedAt: NOW,
        }),
      },
    ],
    certifyConnectorVersion: (command) => {
      const input = command.input;
      const created = certifyConnectorVersion({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        connectorId: requiredInputText(input, 'connector_id'),
        exactVersion: requiredInputText(input, 'exact_version'),
        manifestDigest: requiredInputText(input, 'manifest_digest'),
        report: {
          reportDigest: requiredInputText(input, 'report_digest'),
          manifestDigest: requiredInputText(input, 'report_manifest_digest'),
          suiteVersion: requiredInputText(input, 'suite_version'),
          passed: input['report_passed'] === true,
          signatureValid: input['report_signature_valid'] === true,
        },
        authorPrincipalId: requiredInputText(input, 'author_principal_id'),
        certifierPrincipalId: command.actorPrincipalId,
        certificationDecisionId: command.authorityDecisionId ?? '',
        allowedTenantRefs: input['allowed_tenant_refs'] as string[],
        allowedScopes: input['allowed_scopes'] as string[],
        allowedCapabilities: input['allowed_capabilities'] as string[],
        credentialClasses: input['credential_classes'] as string[],
        validFrom: input['valid_from'] as number,
        expiresAt: input['expires_at'] as number,
        certifiedAt: NOW,
      });
      certifications.set(created.id, created);
      return created;
    },
    revokeConnectorCertification: (command) => {
      const current = certifications.get(command.recordId);
      if (!current) throw new TypeError('connector certification not found');
      const revoked = revokeConnectorCertification({
        certification: current,
        tenantId: command.tenantId,
        revokedByPrincipalId: command.actorPrincipalId,
        authorityDecisionId: command.authorityDecisionId ?? '',
        reason: command.reason,
        revokedAt: NOW + 1,
      });
      certifications.set(revoked.id, revoked);
      return revoked;
    },
    listConnectorHealth: () => [
      {
        id: 'health-1',
        tenantId: TENANT,
        connectorId: 'kanban',
        certificationId: CONNECTOR_CERTIFICATION_ID,
        status: 'healthy',
        lastAttemptAt: NOW,
        lastSuccessAt: NOW,
        retryState: 'idle',
        reconciliationAvailable: true,
      },
      {
        id: 'health-foreign',
        tenantId: OTHER_TENANT,
        connectorId: 'foreign',
        certificationId: 'foreign-certification',
        status: 'failed',
        lastAttemptAt: NOW,
        retryState: 'terminal',
        reconciliationAvailable: true,
      },
    ],
    requestConnectorReconciliation: () => ({
      operationId: 'connector-reconciliation:kanban',
      status: 'accepted',
      idempotentReplay: false,
    }),
  };
  const client = (principalId: string) => {
    const options: AppOptions = {
      verifyIdentity: () => ({
        principalId,
        tenantId: TENANT,
        roles: ['integration_engineer'],
        isBrowserSession: false,
      }),
      readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
      now: () => NOW,
    };
    const { app } = createApp(options);
    registerGovernedPlatformRoutes(app, {
      now: () => NOW,
      nextId: () => COMPARISON,
      signDigest: (value) => 'signature:' + value,
      reviews: {
        listSnapshots: () => [],
        readReviewSource: () => undefined,
        readSnapshot: () => undefined,
        commitSnapshot: () => {
          throw new Error('not used');
        },
        commitComparison: () => {
          throw new Error('not used');
        },
      },
      connectors,
    });
    return (request: Request) => app.fetch(request);
  };
  return { author: client(PRINCIPAL), certifier: client(AUDITOR), definitions, certifications };
}

describe('governed connector authoring and certification API', () => {
  it('derives tenant/author identity, rejects tenant injection, and accepts conformance work', async () => {
    const app = connectorHarness();
    const rejected = await app.author(
      request(
        '/v1/connector-definitions',
        'POST',
        connectorDefinitionCommand({ tenant_id: OTHER_TENANT }),
        operationHeaders,
      ),
    );
    expect(rejected.status).toBe(400);
    expect(app.definitions).toHaveLength(0);
    expect(
      (
        await app.author(
          request(
            '/v1/connector-definitions',
            'POST',
            connectorDefinitionCommand(),
            operationHeaders,
          ),
        )
      ).status,
    ).toBe(201);
    expect((app.definitions[0] as Record<string, unknown>)['tenantId']).toBe(TENANT);
    expect(
      (
        await app.author(
          request(
            '/v1/connector-definitions/' + CONNECTOR_DEFINITION_ID + '/conformance-runs',
            'POST',
            commandBody({ environment_digest: 'f'.repeat(64) }),
            operationHeaders,
          ),
        )
      ).status,
    ).toBe(202);
  });

  it('certifies independently, hides foreign records, revokes, and retains reconciliation access', async () => {
    const app = connectorHarness();
    expect(
      (
        await app.author(
          request(
            '/v1/connector-certifications',
            'POST',
            connectorCertificationCommand(),
            operationHeaders,
          ),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.certifier(
          request(
            '/v1/connector-certifications',
            'POST',
            connectorCertificationCommand(),
            operationHeaders,
          ),
        )
      ).status,
    ).toBe(201);
    const listed = await app.certifier(request('/v1/connector-certifications'));
    expect(JSON.stringify(await listed.json())).not.toContain(OTHER_TENANT);
    const revoked = await app.certifier(
      request(
        '/v1/connector-certifications/' + CONNECTOR_CERTIFICATION_ID + '/transitions',
        'POST',
        {
          transition: 'revoke',
          reason: { code: 'connector.revoke', text: 'Revoke the exact unsafe version.' },
          authority_decision_id: AUTHORITY,
        },
        { ...operationHeaders, 'if-match': '"1"' },
      ),
    );
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as Record<string, unknown>)['status']).toBe('revoked');
    const health = await app.certifier(request('/v1/connector-health'));
    expect(JSON.stringify(await health.json())).not.toContain(OTHER_TENANT);
    expect(
      (
        await app.certifier(
          request(
            '/v1/connector-reconciliations',
            'POST',
            commandBody({ connector_id: 'kanban' }),
            operationHeaders,
          ),
        )
      ).status,
    ).toBe(202);
  });
});

const IMPROVEMENT_ID = '018f0000-0000-7000-8000-0000000000e0';
const RESOLUTION_ID = '018f0000-0000-7000-8000-0000000000e1';

function measureFromWire(value: unknown, tenantSchemaVersion: number): AggregateProductMeasure {
  const item = value as Record<string, unknown>;
  return {
    ref: requiredInputText(item, 'ref'),
    schemaVersion: (item['schema_version'] as number) ?? tenantSchemaVersion,
    metric: item['metric'] as AggregateProductMeasure['metric'],
    routeFamily: requiredInputText(item, 'route_family'),
    windowStart: item['window_start'] as number,
    windowEnd: item['window_end'] as number,
    sampleCount: item['sample_count'] as number,
    aggregation: item['aggregation'] as AggregateProductMeasure['aggregation'],
    retentionPolicyId: requiredInputText(item, 'retention_policy_id'),
    collectionPolicyDecisionId: requiredInputText(item, 'collection_policy_decision_id'),
  };
}

function crossCuttingHarness() {
  const improvements = new Map<string, ImprovementHypothesis>();
  const resolutionCases = new Map<string, EntityResolutionCase>();
  const foreignMeasure: AggregateProductMeasure = {
    ref: 'aggregate://product/time_to_find/2026-07',
    schemaVersion: 2,
    metric: 'time_to_find',
    routeFamily: '/operations',
    windowStart: NOW - 86_400_000,
    windowEnd: NOW,
    sampleCount: 50,
    aggregation: 'duration_bucket_distribution',
    retentionPolicyId: 'analytics-90d',
    collectionPolicyDecisionId: 'policy-foreign',
  };
  const foreignImprovement = createImprovementHypothesis({
    id: '018f0000-0000-7000-8000-0000000000ef',
    tenantId: OTHER_TENANT,
    productScope: 'foreign',
    analyticsSchemaVersion: 2,
    aggregateMeasures: [foreignMeasure],
    hypothesis: 'Foreign tenant hypothesis.',
    ownerPrincipalId: PRINCIPAL,
    createdByPrincipalId: PRINCIPAL,
    expectedOutcome: 'Foreign outcome.',
    baselineWindow: { start: NOW - 86_400_000, end: NOW },
    targetWindow: { start: NOW + 1, end: NOW + 86_400_000 },
    reason: { code: 'improvement.proposed', text: 'Foreign tenant aggregate.' },
    now: NOW,
  });
  const foreignResolution = createEntityResolutionCase({
    id: '018f0000-0000-7000-8000-0000000000ee',
    tenantId: OTHER_TENANT,
    sourceIdentities: [
      {
        tenantId: OTHER_TENANT,
        sourceSystemId: 'foreign-a',
        sourceRecordId: 'one',
        sourceDigest: 'e'.repeat(64),
      },
      {
        tenantId: OTHER_TENANT,
        sourceSystemId: 'foreign-b',
        sourceRecordId: 'two',
        sourceDigest: 'f'.repeat(64),
      },
    ],
    candidateCanonicalEntityId: 'foreign-canonical',
    proposalType: 'merge',
    confidenceBand: 'high',
    matchReasons: ['foreign_match'],
    conflictReasons: [],
    affectedProjectionRefs: ['/inventory'],
    proposedByPrincipalId: PRINCIPAL,
    reason: { code: 'resolution.proposed', text: 'Foreign tenant proposal.' },
    now: NOW,
  });

  const improvementPort: GovernedImprovementRoutePort = {
    listImprovementHypotheses: () => [...improvements.values(), foreignImprovement],
    createImprovementHypothesis: (command) => {
      const input = command.input;
      const schemaVersion = input['analytics_schema_version'] as number;
      const baseline = input['baseline_window'] as Record<string, number>;
      const target = input['target_window'] as Record<string, number>;
      const item = createImprovementHypothesis({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        productScope: requiredInputText(input, 'product_scope'),
        analyticsSchemaVersion: schemaVersion,
        aggregateMeasures: (input['aggregate_measures'] as unknown[]).map((measure) =>
          measureFromWire(measure, schemaVersion),
        ),
        hypothesis: requiredInputText(input, 'hypothesis'),
        ownerPrincipalId: requiredInputText(input, 'owner_principal_id'),
        createdByPrincipalId: command.actorPrincipalId,
        expectedOutcome: requiredInputText(input, 'expected_outcome'),
        baselineWindow: { start: baseline['start']!, end: baseline['end']! },
        targetWindow: { start: target['start']!, end: target['end']! },
        reason: command.reason,
        now: NOW,
      });
      improvements.set(item.id, item);
      return item;
    },
    transitionImprovementHypothesis: (command) => {
      const current = improvements.get(command.recordId);
      if (!current) throw new TypeError('improvement hypothesis not found');
      let item: ImprovementHypothesis;
      if (command.transition === 'approve' || command.transition === 'reject') {
        item = decideImprovementHypothesis({
          hypothesis: current,
          tenantId: command.tenantId,
          expectedVersion: command.expectedVersion,
          decision: command.transition,
          actorPrincipalId: command.actorPrincipalId,
          authorityDecisionId: command.authorityDecisionId ?? '',
          reason: command.reason,
          now: NOW + command.expectedVersion,
        });
      } else if (
        command.transition === 'start_delivery' ||
        command.transition === 'mark_delivered'
      ) {
        item = updateImprovementDelivery({
          hypothesis: current,
          tenantId: command.tenantId,
          expectedVersion: command.expectedVersion,
          deliveryStatus: command.transition === 'start_delivery' ? 'in_progress' : 'delivered',
          actorPrincipalId: command.actorPrincipalId,
          reason: command.reason,
          now: NOW + command.expectedVersion,
        });
      } else {
        const schemaVersion = current.analyticsSchemaVersion;
        item = concludeImprovementHypothesis({
          hypothesis: current,
          tenantId: command.tenantId,
          expectedVersion: command.expectedVersion,
          actorPrincipalId: command.actorPrincipalId,
          authorityDecisionId: command.authorityDecisionId ?? '',
          outcomeMeasures: (command.input['outcome_measures'] as unknown[]).map((measure) =>
            measureFromWire(measure, schemaVersion),
          ),
          conclusion: requiredInputText(command.input, 'conclusion'),
          reason: command.reason,
          now: NOW + 86_400_001,
        });
      }
      improvements.set(item.id, item);
      return item;
    },
  };

  const entityPort: GovernedEntityResolutionRoutePort = {
    listEntityResolutionCases: () => [...resolutionCases.values(), foreignResolution],
    createEntityResolutionCase: (command) => {
      const input = command.input;
      const item = createEntityResolutionCase({
        id: requiredInputText(input, 'id'),
        tenantId: command.tenantId,
        sourceIdentities: (input['source_identities'] as Record<string, unknown>[]).map(
          (source) => ({
            tenantId: command.tenantId,
            sourceSystemId: requiredInputText(source, 'source_system_id'),
            sourceRecordId: requiredInputText(source, 'source_record_id'),
            sourceDigest: requiredInputText(source, 'source_digest'),
          }),
        ),
        candidateCanonicalEntityId: requiredInputText(input, 'candidate_canonical_entity_id'),
        proposalType: input['proposal_type'] as EntityResolutionCase['proposalType'],
        confidenceBand: input['confidence_band'] as EntityResolutionCase['confidenceBand'],
        matchReasons: input['match_reasons'] as string[],
        conflictReasons: input['conflict_reasons'] as string[],
        affectedProjectionRefs: input['affected_projection_refs'] as string[],
        proposedByPrincipalId: command.actorPrincipalId,
        reason: command.reason,
        now: NOW,
      });
      resolutionCases.set(item.id, item);
      return item;
    },
    transitionEntityResolutionCase: (command) => {
      const current = resolutionCases.get(command.recordId);
      if (!current) throw new TypeError('entity resolution case not found');
      const item = transitionEntityResolutionCase({
        caseRecord: current,
        tenantId: command.tenantId,
        expectedVersion: command.expectedVersion,
        transition: command.transition as Parameters<
          typeof transitionEntityResolutionCase
        >[0]['transition'],
        actorPrincipalId: command.actorPrincipalId,
        authorityDecisionId: command.authorityDecisionId,
        reason: command.reason,
        appliedProjectionRefs: command.input['applied_projection_refs'] as string[] | undefined,
        failedProjectionRefs: command.input['failed_projection_refs'] as string[] | undefined,
        now: NOW + command.expectedVersion,
      });
      resolutionCases.set(item.id, item);
      return item;
    },
  };

  const client = (principalId: string) => {
    const { app } = createApp({
      verifyIdentity: () => ({
        principalId,
        tenantId: TENANT,
        roles: ['governance_officer'],
        isBrowserSession: false,
      }),
      readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
      now: () => NOW,
    });
    registerGovernedPlatformRoutes(app, {
      now: () => NOW,
      nextId: () => COMPARISON,
      signDigest: (value) => 'signature:' + value,
      reviews: {
        listSnapshots: () => [],
        readReviewSource: () => undefined,
        readSnapshot: () => undefined,
        commitSnapshot: () => {
          throw new Error('not used');
        },
        commitComparison: () => {
          throw new Error('not used');
        },
      },
      improvements: improvementPort,
      entityResolution: entityPort,
    });
    return (request: Request) => app.fetch(request);
  };
  return { owner: client(PRINCIPAL), reviewer: client(AUDITOR) };
}

function analyticsMeasure(ref = 'aggregate://product/time_to_find/2026-07') {
  return {
    ref,
    schema_version: 2,
    metric: 'time_to_find',
    route_family: '/operations',
    window_start: NOW - 86_400_000,
    window_end: NOW,
    sample_count: 50,
    aggregation: 'duration_bucket_distribution',
    retention_policy_id: 'analytics-90d',
    collection_policy_decision_id: 'policy-analytics-enabled',
  };
}

describe('governed improvement and entity-resolution API', () => {
  it('creates, independently decides, delivers, and concludes aggregate-only improvements', async () => {
    const app = crossCuttingHarness();
    const createBody = commandBody({
      id: IMPROVEMENT_ID,
      product_scope: 'operations-workspace',
      analytics_schema_version: 2,
      aggregate_measures: [analyticsMeasure()],
      hypothesis: 'Reduce aggregate time to find.',
      owner_principal_id: PRINCIPAL,
      expected_outcome: 'Move the median duration below one minute.',
      baseline_window: { start: NOW - 86_400_000, end: NOW },
      target_window: { start: NOW + 1, end: NOW + 86_400_000 },
    });
    expect(
      (
        await app.owner(
          request(
            '/v1/improvement-hypotheses',
            'POST',
            {
              ...createBody,
              input: { ...createBody.input, tenant_id: OTHER_TENANT },
            },
            operationHeaders,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.owner(request('/v1/improvement-hypotheses', 'POST', createBody, operationHeaders)))
        .status,
    ).toBe(201);
    expect(
      (
        await app.owner(
          request(
            '/v1/improvement-hypotheses/' + IMPROVEMENT_ID + '/transitions',
            'POST',
            {
              transition: 'approve',
              reason: { code: 'improvement.approve', text: 'Self approval is denied.' },
              authority_decision_id: AUTHORITY,
            },
            { ...operationHeaders, 'if-match': '"1"' },
          ),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.reviewer(
          request(
            '/v1/improvement-hypotheses/' + IMPROVEMENT_ID + '/transitions',
            'POST',
            {
              transition: 'approve',
              reason: { code: 'improvement.approve', text: 'Approve the aggregate experiment.' },
              authority_decision_id: AUTHORITY,
            },
            { ...operationHeaders, 'if-match': '"1"' },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.owner(
          request(
            '/v1/improvement-hypotheses/' + IMPROVEMENT_ID + '/transitions',
            'POST',
            {
              transition: 'mark_delivered',
              reason: { code: 'improvement.delivered', text: 'The bounded change is delivered.' },
              authority_decision_id: AUTHORITY,
            },
            { ...operationHeaders, 'if-match': '"2"' },
          ),
        )
      ).status,
    ).toBe(200);
    const outcome = analyticsMeasure('aggregate://product/time_to_find/2026-08');
    outcome.window_start = NOW + 1;
    outcome.window_end = NOW + 86_400_000;
    const concluded = await app.reviewer(
      request(
        '/v1/improvement-hypotheses/' + IMPROVEMENT_ID + '/transitions',
        'POST',
        {
          transition: 'conclude',
          reason: { code: 'improvement.conclude', text: 'Review the aggregate outcome.' },
          authority_decision_id: AUTHORITY,
          input: {
            outcome_measures: [outcome],
            conclusion: 'The aggregate target was met without retaining governed content.',
          },
        },
        { ...operationHeaders, 'if-match': '"3"' },
      ),
    );
    expect(concluded.status).toBe(200);
    expect(((await concluded.json()) as Record<string, unknown>)['status']).toBe('concluded');
    const listed = await app.owner(request('/v1/improvement-hypotheses'));
    expect(JSON.stringify(await listed.json())).not.toContain(OTHER_TENANT);
  });

  it('preserves source identities through independent merge review, partial failure, and listing', async () => {
    const app = crossCuttingHarness();
    const created = await app.owner(
      request(
        '/v1/entity-resolution-cases',
        'POST',
        commandBody({
          id: RESOLUTION_ID,
          source_identities: [
            {
              source_system_id: 'cmdb-a',
              source_record_id: 'asset-101',
              source_digest: 'a'.repeat(64),
            },
            {
              source_system_id: 'scanner-b',
              source_record_id: 'node-77',
              source_digest: 'b'.repeat(64),
            },
          ],
          candidate_canonical_entity_id: 'asset-canonical-1',
          proposal_type: 'merge',
          confidence_band: 'high',
          match_reasons: ['serial_hash_exact'],
          conflict_reasons: [],
          affected_projection_refs: ['/inventory', '/posture'],
        }),
        operationHeaders,
      ),
    );
    expect(created.status).toBe(201);
    const startReview = await app.reviewer(
      request(
        '/v1/entity-resolution-cases/' + RESOLUTION_ID + '/transitions',
        'POST',
        {
          transition: 'start_review',
          reason: { code: 'resolution.review', text: 'Begin independent source review.' },
          authority_decision_id: AUTHORITY,
        },
        { ...operationHeaders, 'if-match': '"1"' },
      ),
    );
    expect(startReview.status).toBe(200);
    const accepted = await app.reviewer(
      request(
        '/v1/entity-resolution-cases/' + RESOLUTION_ID + '/transitions',
        'POST',
        {
          transition: 'accept',
          reason: { code: 'resolution.accept', text: 'Accept the governed merge proposal.' },
          authority_decision_id: AUTHORITY,
        },
        { ...operationHeaders, 'if-match': '"2"' },
      ),
    );
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as Record<string, unknown>)['source_identities']).toHaveLength(
      2,
    );
    const failed = await app.reviewer(
      request(
        '/v1/entity-resolution-cases/' + RESOLUTION_ID + '/transitions',
        'POST',
        {
          transition: 'fail',
          reason: { code: 'resolution.partial', text: 'One projection rejected the update.' },
          authority_decision_id: AUTHORITY,
          input: {
            applied_projection_refs: ['/inventory'],
            failed_projection_refs: ['/posture'],
          },
        },
        { ...operationHeaders, 'if-match': '"3"' },
      ),
    );
    expect(failed.status).toBe(200);
    const failureBody = (await failed.json()) as Record<string, unknown>;
    expect(failureBody['status']).toBe('failed');
    expect(failureBody['reconciliation_available']).toBe(true);
    const listed = await app.owner(request('/v1/entity-resolution-cases'));
    expect(JSON.stringify(await listed.json())).not.toContain(OTHER_TENANT);
  });
});
