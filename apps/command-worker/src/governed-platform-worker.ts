import { scheduleRetry } from './retry-scheduler.ts';
import { governedDigest } from '@trustcircle/domain';
import { verifySignedEvidencePackage, type SignedEvidencePackage } from '@trustcircle/evidence';
import type { GovernedDeliveryChannel, GovernedDeliveryPlan } from '@trustcircle/application';

export interface GovernedChannelOutcome {
  readonly channel: GovernedDeliveryChannel;
  readonly status: 'delivered' | 'retryable_failure' | 'terminal_failure';
  readonly failureClass?: string;
  readonly retryAfterMs?: number;
}

export type GovernedChannelState = 'duplicate' | 'delivered' | 'retry_scheduled' | 'terminal';

export interface GovernedDeliveryReconciliation {
  readonly status: 'delivered' | 'retry_scheduled' | 'partial' | 'terminal';
  readonly channelStates: Readonly<Record<GovernedDeliveryChannel, GovernedChannelState>>;
  readonly nextAttemptAt: number | null;
  readonly terminalChannels: readonly GovernedDeliveryChannel[];
  readonly safeNextAction: string;
}

export interface ReconcileGovernedDeliveryInput {
  readonly plan: GovernedDeliveryPlan;
  readonly priorDeliveredKeys: ReadonlySet<string>;
  readonly outcomes: readonly GovernedChannelOutcome[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryDeadline: number;
  readonly now: number;
}

export function reconcileGovernedDelivery(
  input: ReconcileGovernedDeliveryInput,
): GovernedDeliveryReconciliation {
  const channelStates: Partial<Record<GovernedDeliveryChannel, GovernedChannelState>> = {};
  const terminalChannels: GovernedDeliveryChannel[] = [];
  let nextAttemptAt: number | null = null;
  let completed = 0;
  let retrying = 0;

  for (const attempt of input.plan.attempts) {
    if (input.priorDeliveredKeys.has(attempt.idempotencyKey)) {
      channelStates[attempt.channel] = 'duplicate';
      completed += 1;
      continue;
    }
    const outcome = input.outcomes.find((candidate) => candidate.channel === attempt.channel);
    if (outcome?.status === 'delivered') {
      channelStates[attempt.channel] = 'delivered';
      completed += 1;
      continue;
    }
    if (outcome?.status === 'terminal_failure') {
      channelStates[attempt.channel] = 'terminal';
      terminalChannels.push(attempt.channel);
      continue;
    }
    const retry = scheduleRetry({
      idempotencyKey: attempt.idempotencyKey,
      failureClass: outcome?.failureClass ?? 'dependency_unavailable',
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      initialBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      ...(outcome?.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      deadline: input.retryDeadline,
      jitterSeed: attempt.idempotencyKey,
      now: input.now,
    });
    if (retry.action === 'retry') {
      channelStates[attempt.channel] = 'retry_scheduled';
      retrying += 1;
      nextAttemptAt =
        nextAttemptAt === null
          ? retry.nextAttemptAt
          : Math.min(nextAttemptAt, retry.nextAttemptAt!);
    } else {
      channelStates[attempt.channel] = 'terminal';
      terminalChannels.push(attempt.channel);
    }
  }

  const status =
    terminalChannels.length > 0
      ? 'terminal'
      : retrying > 0 && completed > 0
        ? 'partial'
        : retrying > 0
          ? 'retry_scheduled'
          : 'delivered';
  return Object.freeze({
    status,
    channelStates: Object.freeze(
      channelStates as Record<GovernedDeliveryChannel, GovernedChannelState>,
    ),
    nextAttemptAt,
    terminalChannels: Object.freeze([...terminalChannels].sort()),
    safeNextAction:
      status === 'terminal'
        ? 'Reconcile terminal channels with the subscription owner; do not infer recipient acknowledgement.'
        : status === 'partial'
          ? 'Retain delivered-channel evidence and retry only the bounded failed channels.'
          : status === 'retry_scheduled'
            ? 'Wait for the bounded same-key retry and keep the delay visible.'
            : 'No delivery action is required; retain channel receipts for reconciliation.',
  });
}

export type EvidencePackageJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface EvidencePackageFailureEvidence {
  readonly code: string;
  readonly occurredAt: number;
  readonly retryable: boolean;
  readonly canonicalDigest: string;
}

export interface EvidencePackageJob {
  readonly id: string;
  readonly tenantId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAt: number;
  readonly retentionUntil: number;
  readonly status: EvidencePackageJobStatus;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly cancelledAt?: number;
  readonly cancelledByPrincipalId?: string;
  readonly package?: SignedEvidencePackage;
  readonly failureEvidence?: EvidencePackageFailureEvidence;
  readonly verificationStatus?: 'verified' | 'failed';
  readonly verifiedAt?: number;
}

export function createEvidencePackageJob(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAt: number;
  readonly retentionUntil: number;
}): EvidencePackageJob {
  if (
    input.id.length === 0 ||
    input.tenantId.length === 0 ||
    input.requesterPrincipalId.length === 0
  ) {
    throw new TypeError('Package job identity is required.');
  }
  if (
    !Number.isSafeInteger(input.requestedAt) ||
    !Number.isSafeInteger(input.retentionUntil) ||
    input.retentionUntil <= input.requestedAt
  ) {
    throw new RangeError('Package retention must end after the request instant.');
  }
  return Object.freeze({ ...input, status: 'queued' });
}

export function cancelEvidencePackageJob(
  job: EvidencePackageJob,
  actorPrincipalId: string,
  cancelledAt: number,
): EvidencePackageJob {
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  if (actorPrincipalId.length === 0 || !Number.isSafeInteger(cancelledAt)) {
    throw new TypeError('Cancellation authority and time are required.');
  }
  return Object.freeze({
    ...job,
    status: 'cancelled',
    cancelledAt,
    cancelledByPrincipalId: actorPrincipalId,
  });
}

function packageFailure(
  code: string,
  occurredAt: number,
  retryable: boolean,
): EvidencePackageFailureEvidence {
  const content = { code, occurredAt, retryable };
  return Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
}

export async function runEvidencePackageJob(input: {
  readonly job: EvidencePackageJob;
  readonly now: number;
  readonly generate: () => Promise<SignedEvidencePackage>;
}): Promise<EvidencePackageJob> {
  if (input.job.status === 'cancelled' || input.job.status === 'completed') return input.job;
  if (input.job.status === 'failed') return input.job;
  try {
    const bundle = await input.generate();
    if (bundle.tenantId !== input.job.tenantId) {
      throw new TypeError('cross tenant package result');
    }
    return Object.freeze({
      ...input.job,
      status: 'completed',
      startedAt: input.now,
      completedAt: input.now,
      package: bundle,
    });
  } catch {
    return Object.freeze({
      ...input.job,
      status: 'failed',
      startedAt: input.now,
      completedAt: input.now,
      failureEvidence: packageFailure('package_generation_failed', input.now, true),
    });
  }
}

export function verifyEvidencePackageJob(
  job: EvidencePackageJob,
  input: {
    readonly tenantId: string;
    readonly audiencePrincipalId: string;
    readonly verifySignature: (digest: string, signature: string, keyId: string) => boolean;
    readonly verifiedAt: number;
  },
): EvidencePackageJob {
  if (job.status !== 'completed' || job.package === undefined) {
    throw new TypeError('Only a completed evidence package job can be verified.');
  }
  const verification = verifySignedEvidencePackage({
    package: job.package,
    tenantId: input.tenantId,
    audiencePrincipalId: input.audiencePrincipalId,
    verifySignature: input.verifySignature,
  });
  return Object.freeze({
    ...job,
    verificationStatus: verification.valid ? 'verified' : 'failed',
    verifiedAt: input.verifiedAt,
    ...(verification.valid
      ? {}
      : {
          failureEvidence: packageFailure(
            verification.reason ?? 'package_verification_failed',
            input.verifiedAt,
            false,
          ),
        }),
  });
}

export type GovernedPlatformWorkKind =
  | 'monitoring_correlation'
  | 'impact_preview'
  | 'projection_invalidation'
  | 'projection_rebuild'
  | 'governed_rollback'
  | 'connector_conformance'
  | 'connector_health_check'
  | 'connector_revocation'
  | 'connector_reconciliation';

export type GovernedPlatformWorkStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface GovernedPlatformWorkFailureEvidence {
  readonly code: string;
  readonly evidenceRef: string;
  readonly occurredAt: number;
  readonly retryable: boolean;
  readonly canonicalDigest: string;
}

export interface GovernedPlatformWorkJob {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: GovernedPlatformWorkKind;
  readonly subjectRef: string;
  readonly sourceDigest: string;
  readonly requestedByPrincipalId: string;
  readonly ownerPrincipalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: number;
  readonly retentionUntil: number;
  readonly maxAttempts: number;
  readonly status: GovernedPlatformWorkStatus;
  readonly attempt: number;
  readonly progress: number;
  readonly lastAttemptAt?: number;
  readonly nextAttemptAt?: number;
  readonly completedAt?: number;
  readonly cancelledAt?: number;
  readonly cancelledByPrincipalId?: string;
  readonly outputRefs: readonly string[];
  readonly invalidationCursor?: string;
  readonly failureEvidence?: GovernedPlatformWorkFailureEvidence;
  readonly safeNextAction: string;
}

function workText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(field + ' is required.');
  }
  return value.trim();
}

function workEpoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(field + ' must be a non-negative epoch integer.');
  }
  return value;
}

function workRef(value: string, field: string): string {
  const checked = workText(value, field);
  if (!checked.startsWith('/') || checked.startsWith('//') || checked.length > 512) {
    throw new TypeError(field + ' must be a governed relative reference.');
  }
  return checked;
}

function workDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError('sourceDigest must be SHA-256.');
  return value;
}

function workSafeNextAction(
  kind: GovernedPlatformWorkKind,
  status: GovernedPlatformWorkStatus,
): string {
  if (status === 'failed') {
    if (kind.startsWith('connector_')) {
      return 'Keep the connector blocked, preserve certification and revocation evidence, and reconcile uncertain or partial source outcomes with the accountable owner.';
    }
    return kind === 'projection_rebuild' || kind === 'projection_invalidation'
      ? 'Reconcile the failed projection work, inspect retained evidence, and use the governed rollback path if authority requires it.'
      : 'Reconcile the terminal work with the accountable operator and retain its failure evidence.';
  }
  if (status === 'cancelled') {
    return 'Review the preserved subject and source digest before requesting replacement work.';
  }
  if (kind.startsWith('connector_') && status === 'completed') {
    return 'Retain the exact manifest/report outputs and re-evaluate certification, health, revocation, and reconciliation bounds before new work.';
  }
  if (status === 'completed') {
    return 'Retain the output references and verify downstream projection or decision state.';
  }
  return 'Keep progress visible and retry only within the declared attempt and deadline bounds.';
}

export function createGovernedPlatformWorkJob(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: GovernedPlatformWorkKind;
  readonly subjectRef: string;
  readonly sourceDigest: string;
  readonly requestedByPrincipalId: string;
  readonly correlationId: string;
  readonly requestedAt: number;
  readonly retentionUntil: number;
  readonly maxAttempts: number;
}): GovernedPlatformWorkJob {
  const requestedAt = workEpoch(input.requestedAt, 'requestedAt');
  const retentionUntil = workEpoch(input.retentionUntil, 'retentionUntil');
  if (retentionUntil <= requestedAt)
    throw new RangeError('Work retention must follow its request.');
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) {
    throw new RangeError('maxAttempts must be between one and twenty.');
  }
  const identity = {
    tenantId: workText(input.tenantId, 'tenantId'),
    kind: input.kind,
    subjectRef: workRef(input.subjectRef, 'subjectRef'),
    sourceDigest: workDigest(input.sourceDigest),
  };
  return Object.freeze({
    id: workText(input.id, 'id'),
    ...identity,
    requestedByPrincipalId: workText(input.requestedByPrincipalId, 'requestedByPrincipalId'),
    ownerPrincipalId: workText(input.requestedByPrincipalId, 'requestedByPrincipalId'),
    correlationId: workText(input.correlationId, 'correlationId'),
    idempotencyKey: governedDigest(identity),
    requestedAt,
    retentionUntil,
    maxAttempts: input.maxAttempts,
    status: 'queued',
    attempt: 0,
    progress: 0,
    outputRefs: Object.freeze([]),
    safeNextAction: workSafeNextAction(input.kind, 'queued'),
  });
}

export function updateGovernedPlatformWorkProgress(
  job: GovernedPlatformWorkJob,
  progress: number,
  updatedAt: number,
): GovernedPlatformWorkJob {
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
    return job;
  if (!Number.isFinite(progress) || progress < job.progress || progress >= 1) {
    throw new RangeError('Running work progress must be monotonic and less than one.');
  }
  return Object.freeze({
    ...job,
    status: 'running',
    progress,
    lastAttemptAt: workEpoch(updatedAt, 'updatedAt'),
    safeNextAction: workSafeNextAction(job.kind, 'running'),
  });
}

function workFailure(
  job: GovernedPlatformWorkJob,
  evidenceRef: string,
  occurredAt: number,
  retryable: boolean,
): GovernedPlatformWorkFailureEvidence {
  const content = {
    code: job.kind + '_failed',
    evidenceRef: workRef(evidenceRef, 'failureEvidenceRef'),
    occurredAt,
    retryable,
  };
  return Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
}

export async function runGovernedPlatformWorkJob(input: {
  readonly job: GovernedPlatformWorkJob;
  readonly now: number;
  readonly retryDeadline: number;
  readonly failureEvidenceRef: string;
  readonly execute: () => Promise<{
    readonly outputRefs: readonly string[];
    readonly invalidationCursor?: string;
  }>;
}): Promise<GovernedPlatformWorkJob> {
  if (
    input.job.status === 'completed' ||
    input.job.status === 'failed' ||
    input.job.status === 'cancelled'
  ) {
    return input.job;
  }
  const now = workEpoch(input.now, 'now');
  const retryDeadline = workEpoch(input.retryDeadline, 'retryDeadline');
  const attempt = input.job.attempt + 1;
  try {
    const result = await input.execute();
    const outputRefs = Object.freeze(
      [...new Set(result.outputRefs.map((item) => workRef(item, 'outputRef')))].sort(),
    );
    return Object.freeze({
      ...input.job,
      status: 'completed',
      attempt,
      progress: 1,
      lastAttemptAt: now,
      completedAt: now,
      outputRefs,
      ...(result.invalidationCursor === undefined
        ? {}
        : { invalidationCursor: workText(result.invalidationCursor, 'invalidationCursor') }),
      safeNextAction: workSafeNextAction(input.job.kind, 'completed'),
    });
  } catch {
    const canRetry = attempt < input.job.maxAttempts && now < retryDeadline;
    const failureEvidence = workFailure(input.job, input.failureEvidenceRef, now, canRetry);
    if (canRetry) {
      const retry = scheduleRetry({
        idempotencyKey: input.job.idempotencyKey,
        failureClass: 'dependency_unavailable',
        attempt,
        maxAttempts: input.job.maxAttempts,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
        deadline: retryDeadline,
        jitterSeed: input.job.idempotencyKey,
        now,
      });
      if (retry.action === 'retry') {
        return Object.freeze({
          ...input.job,
          status: 'queued',
          attempt,
          lastAttemptAt: now,
          nextAttemptAt: retry.nextAttemptAt!,
          failureEvidence,
          safeNextAction: workSafeNextAction(input.job.kind, 'queued'),
        });
      }
    }
    return Object.freeze({
      ...input.job,
      status: 'failed',
      attempt,
      lastAttemptAt: now,
      completedAt: now,
      failureEvidence: workFailure(input.job, input.failureEvidenceRef, now, false),
      safeNextAction: workSafeNextAction(input.job.kind, 'failed'),
    });
  }
}

export function cancelGovernedPlatformWorkJob(
  job: GovernedPlatformWorkJob,
  actorPrincipalId: string,
  cancelledAt: number,
): GovernedPlatformWorkJob {
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')
    return job;
  return Object.freeze({
    ...job,
    status: 'cancelled',
    cancelledAt: workEpoch(cancelledAt, 'cancelledAt'),
    cancelledByPrincipalId: workText(actorPrincipalId, 'actorPrincipalId'),
    safeNextAction: workSafeNextAction(job.kind, 'cancelled'),
  });
}
export interface GovernedPlatformWorkerStatus {
  readonly component: 'governed-platform-worker';
  readonly health: 'healthy' | 'degraded' | 'unavailable';
  readonly ownerPrincipalId: string;
  readonly lastAttemptAt?: number;
  readonly lastSuccessAt?: number;
  readonly retryState: 'none' | 'pending' | 'terminal';
  readonly nextAttemptAt?: number;
  readonly terminalFailureRef?: string;
  readonly safeNextAction: string;
}

export function governedPlatformWorkerStatus(
  job: GovernedPlatformWorkJob,
): GovernedPlatformWorkerStatus {
  const failed = job.status === 'failed';
  const retryPending = job.status === 'queued' && job.attempt > 0;
  return Object.freeze({
    component: 'governed-platform-worker',
    health: job.status === 'completed' ? 'healthy' : failed ? 'unavailable' : 'degraded',
    ownerPrincipalId: job.ownerPrincipalId,
    ...(job.lastAttemptAt === undefined ? {} : { lastAttemptAt: job.lastAttemptAt }),
    ...(job.completedAt === undefined || job.status !== 'completed'
      ? {}
      : { lastSuccessAt: job.completedAt }),
    retryState: failed ? 'terminal' : retryPending ? 'pending' : 'none',
    ...(job.nextAttemptAt === undefined ? {} : { nextAttemptAt: job.nextAttemptAt }),
    ...(failed && job.failureEvidence
      ? { terminalFailureRef: job.failureEvidence.evidenceRef }
      : {}),
    safeNextAction: job.safeNextAction,
  });
}
