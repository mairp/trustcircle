import { describe, expect, it } from 'vitest';

import {
  planGovernedDeliveries,
  renderGovernedDelivery,
  type GovernedDeliveryPlan,
} from '@trustcircle/application';
import { GovernedPlatformProjector } from '@trustcircle/projections';
import {
  cancelGovernedPlatformWorkJob,
  createGovernedPlatformWorkJob,
  governedPlatformWorkerStatus,
  reconcileGovernedDelivery,
  runGovernedPlatformWorkJob,
  updateGovernedPlatformWorkProgress,
  type GovernedChannelOutcome,
} from '../../apps/command-worker/src/governed-platform-worker.ts';

const NOW = 1_800_000_000_000;

function plan(): GovernedDeliveryPlan {
  return planGovernedDeliveries({
    tenantId: 'tenant-a',
    subscriptionId: 'subscription-1',
    recipientPrincipalId: 'principal-1',
    resourceRef: '/register-records/record-1',
    payload: {
      title: 'Material gap',
      status: 'active',
      secret: 'never-disclose',
    },
    allowedFields: ['title', 'status'],
    channels: ['in_app', 'email'],
    sourceDigest: 'a'.repeat(64),
    correlationId: 'correlation-delivery-1',
    scheduledAt: NOW,
  });
}

describe('governed multichannel delivery resilience', () => {
  it('uses one stable idempotency identity per channel and deduplicates replay', () => {
    const first = plan();
    const replay = plan();
    expect(first.attempts.map((attempt) => attempt.idempotencyKey)).toEqual(
      replay.attempts.map((attempt) => attempt.idempotencyKey),
    );
    const result = reconcileGovernedDelivery({
      plan: first,
      priorDeliveredKeys: new Set([
        first.attempts.find((attempt) => attempt.channel === 'in_app')!.idempotencyKey,
      ]),
      outcomes: [
        { channel: 'in_app', status: 'delivered' },
        { channel: 'email', status: 'delivered' },
      ],
      attempt: 1,
      maxAttempts: 3,
      retryDeadline: NOW + 60_000,
      now: NOW,
    });
    expect(result.channelStates.in_app).toBe('duplicate');
    expect(result.status).toBe('delivered');
  });

  it('reauthorizes at delivery and suppresses all content after revocation', () => {
    const rendered = renderGovernedDelivery(plan(), {
      authorizeRecipient: () => false,
      authorizeField: () => true,
    });
    expect(rendered.status).toBe('revoked');
    expect(rendered.payload).toEqual({});
    expect(JSON.stringify(rendered)).not.toContain('Material gap');
  });

  it('renders only currently authorized fields and reports partial multichannel delivery', () => {
    const delivery = plan();
    const rendered = renderGovernedDelivery(delivery, {
      authorizeRecipient: () => true,
      authorizeField: (_principal, field) => field === 'title',
    });
    expect(rendered.payload).toEqual({ title: 'Material gap' });
    expect(JSON.stringify(rendered)).not.toContain('secret');

    const outcomes: GovernedChannelOutcome[] = [
      { channel: 'in_app', status: 'delivered' },
      {
        channel: 'email',
        status: 'retryable_failure',
        failureClass: 'rate_limited',
        retryAfterMs: 500,
      },
    ];
    const result = reconcileGovernedDelivery({
      plan: delivery,
      priorDeliveredKeys: new Set(),
      outcomes,
      attempt: 1,
      maxAttempts: 3,
      retryDeadline: NOW + 60_000,
      now: NOW,
    });
    expect(result.status).toBe('partial');
    expect(result.channelStates.in_app).toBe('delivered');
    expect(result.channelStates.email).toBe('retry_scheduled');
    expect(result.nextAttemptAt).toBe(NOW + 500);
  });

  it('retains terminal outcomes for reconciliation instead of retrying forever', () => {
    const delivery = plan();
    const result = reconcileGovernedDelivery({
      plan: delivery,
      priorDeliveredKeys: new Set(),
      outcomes: [
        { channel: 'in_app', status: 'delivered' },
        { channel: 'email', status: 'terminal_failure', failureClass: 'unauthorized' },
      ],
      attempt: 3,
      maxAttempts: 3,
      retryDeadline: NOW + 60_000,
      now: NOW,
    });
    expect(result.status).toBe('terminal');
    expect(result.channelStates.email).toBe('terminal');
    expect(result.safeNextAction).toMatch(/reconcile|owner/i);
    expect(result.terminalChannels).toEqual(['email']);
  });
});

describe('governed monitoring and change worker resilience', () => {
  it('uses stable identities and retains progress for correlation and pure preview work', async () => {
    const input = {
      id: 'job-correlation-1',
      tenantId: 'tenant-a',
      kind: 'monitoring_correlation' as const,
      subjectRef: '/control-observations/observation-1',
      sourceDigest: 'a'.repeat(64),
      requestedByPrincipalId: 'principal-1',
      correlationId: 'correlation-monitoring-1',
      requestedAt: NOW,
      retentionUntil: NOW + 86_400_000,
      maxAttempts: 3,
    };
    const first = createGovernedPlatformWorkJob(input);
    const replay = createGovernedPlatformWorkJob(input);
    expect(first.idempotencyKey).toBe(replay.idempotencyKey);
    const running = updateGovernedPlatformWorkProgress(first, 0.4, NOW + 1);
    expect(running.status).toBe('running');
    expect(running.progress).toBe(0.4);
    const completed = await runGovernedPlatformWorkJob({
      job: running,
      now: NOW + 2,
      retryDeadline: NOW + 60_000,
      failureEvidenceRef: '/evidence/worker-failure-1',
      execute: async () => ({
        outputRefs: ['/monitoring-cases/case-1'],
        invalidationCursor: 'cursor-monitoring-1',
      }),
    });
    expect(completed.status).toBe('completed');
    expect(completed.progress).toBe(1);
    expect(completed.outputRefs).toEqual(['/monitoring-cases/case-1']);
  });

  it('retries bounded failures then retains terminal rebuild evidence and safe next action', async () => {
    let job = createGovernedPlatformWorkJob({
      id: 'job-rebuild-1',
      tenantId: 'tenant-a',
      kind: 'projection_rebuild',
      subjectRef: '/change-publications/publication-1',
      sourceDigest: 'b'.repeat(64),
      requestedByPrincipalId: 'principal-2',
      correlationId: 'correlation-rebuild-1',
      requestedAt: NOW,
      retentionUntil: NOW + 86_400_000,
      maxAttempts: 2,
    });
    job = await runGovernedPlatformWorkJob({
      job,
      now: NOW + 1,
      retryDeadline: NOW + 60_000,
      failureEvidenceRef: '/evidence/rebuild-failure-1',
      execute: async () => {
        throw new Error('dependency details must not leak');
      },
    });
    expect(job.status).toBe('queued');
    expect(job.attempt).toBe(1);
    expect(job.nextAttemptAt).toBeGreaterThan(NOW + 1);
    job = await runGovernedPlatformWorkJob({
      job,
      now: job.nextAttemptAt!,
      retryDeadline: NOW + 60_000,
      failureEvidenceRef: '/evidence/rebuild-failure-2',
      execute: async () => {
        throw new Error('dependency details must not leak');
      },
    });
    expect(job.status).toBe('failed');
    expect(job.failureEvidence?.code).toBe('projection_rebuild_failed');
    expect(job.failureEvidence?.evidenceRef).toBe('/evidence/rebuild-failure-2');
    expect(JSON.stringify(job)).not.toContain('dependency details');
    expect(job.safeNextAction).toMatch(/reconcile|rollback|operator/i);
  });

  it('cancels queued rollback work without erasing the publication or prior failure evidence', () => {
    const job = createGovernedPlatformWorkJob({
      id: 'job-rollback-1',
      tenantId: 'tenant-a',
      kind: 'governed_rollback',
      subjectRef: '/change-publications/publication-1',
      sourceDigest: 'c'.repeat(64),
      requestedByPrincipalId: 'principal-2',
      correlationId: 'correlation-rollback-1',
      requestedAt: NOW,
      retentionUntil: NOW + 86_400_000,
      maxAttempts: 1,
    });
    const cancelled = cancelGovernedPlatformWorkJob(job, 'principal-2', NOW + 1);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.subjectRef).toBe('/change-publications/publication-1');
    expect(cancelled.sourceDigest).toBe('c'.repeat(64));
  });

  it('retains terminal connector conformance and reconciliation evidence with a connector-safe action', async () => {
    const queued = createGovernedPlatformWorkJob({
      id: 'job-connector-reconciliation-1',
      tenantId: 'tenant-a',
      kind: 'connector_reconciliation',
      subjectRef: '/connector-certifications/certification-1',
      sourceDigest: 'd'.repeat(64),
      requestedByPrincipalId: 'principal-3',
      correlationId: 'correlation-connector-1',
      requestedAt: NOW,
      retentionUntil: NOW + 86_400_000,
      maxAttempts: 1,
    });
    const failed = await runGovernedPlatformWorkJob({
      job: queued,
      now: NOW + 1,
      retryDeadline: NOW + 60_000,
      failureEvidenceRef: '/evidence/connector-terminal-1',
      execute: async () => {
        throw new Error('external connector secret must not leak');
      },
    });
    expect(failed.status).toBe('failed');
    expect(failed.failureEvidence?.code).toBe('connector_reconciliation_failed');
    expect(failed.failureEvidence?.evidenceRef).toBe('/evidence/connector-terminal-1');
    expect(failed.safeNextAction).toMatch(/connector|certification|revocation/i);
    expect(JSON.stringify(failed)).not.toContain('external connector secret');
  });
});
describe('governed projection ordering and production status', () => {
  it('buffers delayed out-of-order work, deduplicates replay, and retains conflicts for reconciliation', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    const base = {
      eventType: 'register.record.changed.v1',
      eventVersion: 1,
      tenantId: 'tenant-a',
      aggregateType: 'register_record',
      aggregateId: 'record-1',
      occurredAt: NOW,
      correlationId: 'correlation-projection-1',
      payload: { status: 'open' },
    };
    const later = { ...base, eventId: 'event-2', aggregateVersion: 2, occurredAt: NOW + 1 };
    const first = { ...base, eventId: 'event-1', aggregateVersion: 1 };
    expect(projector.apply(later)).toBe('pending_reconciliation');
    expect(projector.apply(first)).toBe('applied');
    expect(projector.apply(first)).toBe('duplicate');
    expect(
      projector.apply({
        ...first,
        eventId: 'event-conflict',
        payload: { status: 'silently-overwritten' },
      }),
    ).toBe('conflict');
    expect(projector.page('register_record', NOW + 2, 10_000).items[0]?.state).toEqual({
      status: 'open',
    });
    const status = projector.status({
      ownerPrincipalId: 'projection-owner',
      at: NOW + 2,
      freshnessHorizonMs: 10_000,
      lastAttemptAt: NOW + 2,
    });
    expect(status.health).toBe('healthy');
    expect(status.ownerPrincipalId).toBe('projection-owner');
    expect(status.lastSuccessAt).toBe(NOW);
    expect(status.retryState).toBe('none');
  });

  it('surfaces terminal projector and worker evidence with accountable recovery guidance', async () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    const projectorStatus = projector.status({
      ownerPrincipalId: 'projection-owner',
      at: NOW,
      freshnessHorizonMs: 1_000,
      lastAttemptAt: NOW,
      terminalFailureRef: '/evidence/projection-terminal-1',
    });
    expect(projectorStatus.health).toBe('unavailable');
    expect(projectorStatus.retryState).toBe('terminal');
    expect(projectorStatus.terminalFailureRef).toBe('/evidence/projection-terminal-1');

    const failed = await runGovernedPlatformWorkJob({
      job: createGovernedPlatformWorkJob({
        id: 'job-revocation-terminal',
        tenantId: 'tenant-a',
        kind: 'connector_revocation',
        subjectRef: '/connector-certifications/certification-1',
        sourceDigest: 'e'.repeat(64),
        requestedByPrincipalId: 'connector-owner',
        correlationId: 'correlation-revocation-terminal',
        requestedAt: NOW,
        retentionUntil: NOW + 86_400_000,
        maxAttempts: 1,
      }),
      now: NOW + 1,
      retryDeadline: NOW + 2,
      failureEvidenceRef: '/evidence/revocation-terminal-1',
      execute: async () => {
        throw new Error('revoked dependency');
      },
    });
    const workerStatus = governedPlatformWorkerStatus(failed);
    expect(workerStatus.ownerPrincipalId).toBe('connector-owner');
    expect(workerStatus.health).toBe('unavailable');
    expect(workerStatus.retryState).toBe('terminal');
    expect(workerStatus.terminalFailureRef).toBe('/evidence/revocation-terminal-1');
    expect(workerStatus.safeNextAction).toMatch(/reconcile|connector/i);
  });

  it('keeps delayed channels pending under the same identity without erasing delivered receipts', () => {
    const delivery = plan();
    const result = reconcileGovernedDelivery({
      plan: delivery,
      priorDeliveredKeys: new Set(),
      outcomes: [{ channel: 'in_app', status: 'delivered' }],
      attempt: 1,
      maxAttempts: 3,
      retryDeadline: NOW + 60_000,
      now: NOW,
    });
    expect(result.status).toBe('partial');
    expect(result.channelStates.in_app).toBe('delivered');
    expect(result.channelStates.email).toBe('retry_scheduled');
    expect(result.nextAttemptAt).toBeGreaterThan(NOW);
  });
});
