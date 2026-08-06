import { createHash } from 'node:crypto';

import {
  applyOperationalCaseCommand,
  createOperationalCase,
  evaluateOperationalCaseSla,
  type AttentionSourceReference,
  type CaseCommandInput,
  type EscalationRecord,
  type OperationalCase,
  type OperationalCasePriority,
  type ServiceLevelPolicy,
} from '@trustcircle/domain';

import { assertOperationAuthority, type OperationsRole } from './operations-authority.ts';

export type CaseCommandName =
  | 'create'
  | 'assign'
  | 'acknowledge'
  | 'progress'
  | 'submit_verification'
  | 'verify'
  | 'close'
  | 'evaluate_sla';

export interface OperationalCaseTransition {
  readonly id: string;
  readonly caseId: string;
  readonly tenantId: string;
  readonly command: CaseCommandName;
  readonly fromStatus?: OperationalCase['status'];
  readonly toStatus?: OperationalCase['status'];
  readonly actorId: string;
  readonly actorRoles: readonly OperationsRole[];
  readonly reason: string;
  readonly expectedVersion?: number;
  readonly actualVersion?: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly outcome: 'accepted' | 'rejected' | 'duplicate' | 'conflict' | 'uncertain';
  readonly rejectionCode?: string;
  readonly safeNextAction?: string;
  readonly occurredAt: number;
}

export interface OperationalCaseDetail {
  readonly case: OperationalCase;
  readonly transitions: readonly OperationalCaseTransition[];
  readonly escalations: readonly EscalationRecord[];
}

export interface CaseMutation {
  readonly case: OperationalCase;
  readonly transition: OperationalCaseTransition;
  readonly escalations?: readonly EscalationRecord[];
}

export interface CaseRepositoryTransactionInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly expectedVersion?: number;
}

export interface CaseRepositoryTransactionResult {
  readonly outcome: 'accepted' | 'duplicate';
  readonly mutation: CaseMutation;
}

export interface OperationalCaseRepository {
  transact(
    input: CaseRepositoryTransactionInput,
    effect: (current: OperationalCase | undefined) => CaseMutation,
  ): Promise<CaseRepositoryTransactionResult>;
  read(tenantId: string, caseId: string): Promise<OperationalCaseDetail | undefined>;
  list(tenantId: string): Promise<readonly OperationalCase[]>;
  appendRejected(transition: OperationalCaseTransition): Promise<void>;
}

export interface OperationsAuditRecord {
  readonly tenantId: string;
  readonly caseId: string;
  readonly actorId: string;
  readonly actorRoles: readonly OperationsRole[];
  readonly command: CaseCommandName;
  readonly reason: string;
  readonly expectedVersion?: number;
  readonly actualVersion?: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly outcome: OperationalCaseTransition['outcome'];
  readonly rejectionCode?: string;
  readonly occurredAt: number;
  readonly controlVersions: Readonly<Record<string, string>>;
}

export interface OperationsAuditSink {
  record(event: OperationsAuditRecord): void | Promise<void>;
}

export interface CaseActor {
  readonly principalId: string;
  readonly roles: readonly OperationsRole[];
  readonly correlationId: string;
  readonly causationId: string;
}

export interface CaseCommandContext {
  readonly tenantId: string;
  readonly actor: CaseActor;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly at: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function validateContext(context: CaseCommandContext): void {
  if (context.reason.trim().length < 8)
    throw new OperationalCaseCommandError('reason_required', 422);
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(context.idempotencyKey)) {
    throw new OperationalCaseCommandError('invalid_idempotency_key', 400);
  }
}

export class OperationalCaseCommandError extends Error {
  readonly code: string;
  readonly status: number;
  readonly safeNextAction: string;
  constructor(
    code: string,
    status: number,
    safeNextAction = 'Read the current case and submit an authorized request bound to its version.',
  ) {
    super(code);
    this.name = 'OperationalCaseCommandError';
    this.code = code;
    this.status = status;
    this.safeNextAction = safeNextAction;
  }
}

export class OperationalCaseService {
  readonly #repository: OperationalCaseRepository;
  readonly #audit: OperationsAuditSink;
  readonly #policy: (
    priority: OperationalCasePriority,
    policyId: string,
    version: string,
  ) => ServiceLevelPolicy | undefined;
  readonly #newId: () => string;

  constructor(input: {
    readonly repository: OperationalCaseRepository;
    readonly audit: OperationsAuditSink;
    readonly policy: (
      priority: OperationalCasePriority,
      policyId: string,
      version: string,
    ) => ServiceLevelPolicy | undefined;
    readonly newId: () => string;
  }) {
    this.#repository = input.repository;
    this.#audit = input.audit;
    this.#policy = input.policy;
    this.#newId = input.newId;
  }

  async create(
    context: CaseCommandContext,
    input: {
      readonly attentionItemId?: string;
      readonly sourceReferences: readonly AttentionSourceReference[];
      readonly title: string;
      readonly priority: OperationalCasePriority;
      readonly ownerId?: string;
      readonly policyId: string;
      readonly policyVersion: string;
    },
  ): Promise<CaseRepositoryTransactionResult> {
    validateContext(context);
    try {
      assertOperationAuthority(context.actor.roles, 'create');
    } catch {
      await this.#reject(context, this.#newId(), 'create', 'forbidden', undefined);
      throw new OperationalCaseCommandError('forbidden', 403);
    }
    const policy = this.#policy(input.priority, input.policyId, input.policyVersion);
    if (!policy) throw new OperationalCaseCommandError('service_level_policy_not_found', 422);
    const caseId = this.#newId();
    const requestDigest = digest({
      context: { tenantId: context.tenantId, reason: context.reason },
      input,
    });
    try {
      const result = await this.#repository.transact(
        {
          tenantId: context.tenantId,
          caseId,
          scope: 'operational_case:create',
          idempotencyKey: context.idempotencyKey,
          requestDigest,
        },
        (current) => {
          if (current) throw new OperationalCaseCommandError('case_already_exists', 409);
          const created = createOperationalCase({
            id: caseId,
            tenantId: context.tenantId,
            ...(input.attentionItemId === undefined
              ? {}
              : { attentionItemId: input.attentionItemId }),
            sourceReferences: input.sourceReferences,
            title: input.title,
            priority: input.priority,
            creatorId: context.actor.principalId,
            ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
            rationale: context.reason,
            policy,
            at: context.at,
          });
          return {
            case: created,
            transition: this.#transition(context, created.id, 'create', 'accepted', {
              toStatus: created.status,
              actualVersion: created.version,
            }),
          };
        },
      );
      await this.#auditMutation(context, result.mutation.transition);
      return result;
    } catch (error) {
      if (error instanceof OperationalCaseCommandError) {
        await this.#reject(context, caseId, 'create', error.code, undefined);
      }
      throw error;
    }
  }

  async transition(
    context: CaseCommandContext,
    caseId: string,
    expectedVersion: number,
    input: Omit<CaseCommandInput, 'actorId' | 'reason' | 'at' | 'verifierRoles'>,
  ): Promise<CaseRepositoryTransactionResult> {
    validateContext(context);
    const command = input.command;
    try {
      assertOperationAuthority(context.actor.roles, command === 'verify' ? 'verify' : 'transition');
    } catch {
      await this.#reject(context, caseId, command, 'forbidden', expectedVersion);
      throw new OperationalCaseCommandError('forbidden', 403);
    }
    const requestDigest = digest({
      caseId,
      expectedVersion,
      context: { tenantId: context.tenantId, reason: context.reason },
      input,
    });
    try {
      const result = await this.#repository.transact(
        {
          tenantId: context.tenantId,
          caseId,
          scope: `operational_case:${command}`,
          idempotencyKey: context.idempotencyKey,
          requestDigest,
          expectedVersion,
        },
        (current) => {
          if (!current) throw new OperationalCaseCommandError('case_not_found', 404);
          if (current.tenantId !== context.tenantId)
            throw new OperationalCaseCommandError('case_not_found', 404);
          if (current.version !== expectedVersion)
            throw new OperationalCaseCommandError('version_conflict', 412);
          const policy = this.#policy(
            current.priority,
            current.serviceLevelPolicyId,
            current.serviceLevelPolicyVersion,
          );
          if (!policy) throw new OperationalCaseCommandError('service_level_policy_not_found', 422);
          const updated = applyOperationalCaseCommand(
            current,
            {
              ...input,
              actorId: context.actor.principalId,
              reason: context.reason,
              at: context.at,
              verifierRoles: context.actor.roles,
            },
            policy.verificationMs,
          );
          return {
            case: updated,
            transition: this.#transition(context, caseId, command, 'accepted', {
              fromStatus: current.status,
              toStatus: updated.status,
              expectedVersion,
              actualVersion: updated.version,
            }),
          };
        },
      );
      await this.#auditMutation(context, result.mutation.transition);
      return result;
    } catch (error) {
      const normalized =
        error instanceof OperationalCaseCommandError
          ? error
          : error instanceof Error
            ? new OperationalCaseCommandError('invalid_transition', 422, error.message)
            : new OperationalCaseCommandError('invalid_transition', 422);
      await this.#reject(context, caseId, command, normalized.code, expectedVersion);
      throw normalized;
    }
  }

  async evaluateSla(
    context: CaseCommandContext,
    caseId: string,
    expectedVersion: number,
  ): Promise<CaseRepositoryTransactionResult> {
    validateContext(context);
    try {
      assertOperationAuthority(context.actor.roles, 'evaluate_sla');
    } catch {
      await this.#reject(context, caseId, 'evaluate_sla', 'forbidden', expectedVersion);
      throw new OperationalCaseCommandError('forbidden', 403);
    }
    const requestDigest = digest({
      caseId,
      expectedVersion,
      evaluatedAt: context.at,
      reason: context.reason,
    });
    try {
      const result = await this.#repository.transact(
        {
          tenantId: context.tenantId,
          caseId,
          scope: 'operational_case:evaluate_sla',
          idempotencyKey: context.idempotencyKey,
          requestDigest,
          expectedVersion,
        },
        (current) => {
          if (!current || current.tenantId !== context.tenantId)
            throw new OperationalCaseCommandError('case_not_found', 404);
          if (current.version !== expectedVersion)
            throw new OperationalCaseCommandError('version_conflict', 412);
          const policy = this.#policy(
            current.priority,
            current.serviceLevelPolicyId,
            current.serviceLevelPolicyVersion,
          );
          if (!policy) throw new OperationalCaseCommandError('service_level_policy_not_found', 422);
          const evaluated = evaluateOperationalCaseSla(current, policy, context.at);
          const changed = evaluated.case.version !== current.version;
          const transition = this.#transition(context, caseId, 'evaluate_sla', 'accepted', {
            fromStatus: current.status,
            toStatus: evaluated.case.status,
            expectedVersion,
            actualVersion: evaluated.case.version,
          });
          return {
            case: changed ? evaluated.case : { ...current },
            transition,
            escalations: evaluated.escalations,
          };
        },
      );
      await this.#auditMutation(context, result.mutation.transition);
      return result;
    } catch (error) {
      const normalized =
        error instanceof OperationalCaseCommandError
          ? error
          : new OperationalCaseCommandError('sla_evaluation_failed', 422);
      await this.#reject(context, caseId, 'evaluate_sla', normalized.code, expectedVersion);
      throw normalized;
    }
  }

  read(tenantId: string, caseId: string): Promise<OperationalCaseDetail | undefined> {
    return this.#repository.read(tenantId, caseId);
  }

  list(tenantId: string): Promise<readonly OperationalCase[]> {
    return this.#repository.list(tenantId);
  }

  #transition(
    context: CaseCommandContext,
    caseId: string,
    command: CaseCommandName,
    outcome: OperationalCaseTransition['outcome'],
    optional: Pick<
      OperationalCaseTransition,
      'fromStatus' | 'toStatus' | 'expectedVersion' | 'actualVersion'
    >,
  ): OperationalCaseTransition {
    return {
      id: this.#newId(),
      caseId,
      tenantId: context.tenantId,
      command,
      actorId: context.actor.principalId,
      actorRoles: [...context.actor.roles],
      reason: context.reason.trim(),
      idempotencyKey: context.idempotencyKey,
      correlationId: context.actor.correlationId,
      causationId: context.actor.causationId,
      outcome,
      occurredAt: context.at,
      ...(optional.fromStatus === undefined ? {} : { fromStatus: optional.fromStatus }),
      ...(optional.toStatus === undefined ? {} : { toStatus: optional.toStatus }),
      ...(optional.expectedVersion === undefined
        ? {}
        : { expectedVersion: optional.expectedVersion }),
      ...(optional.actualVersion === undefined ? {} : { actualVersion: optional.actualVersion }),
    };
  }

  async #reject(
    context: CaseCommandContext,
    caseId: string,
    command: CaseCommandName,
    code: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    const transition: OperationalCaseTransition = {
      id: this.#newId(),
      caseId,
      tenantId: context.tenantId,
      command,
      actorId: context.actor.principalId,
      actorRoles: [...context.actor.roles],
      reason: context.reason.trim(),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      idempotencyKey: context.idempotencyKey,
      correlationId: context.actor.correlationId,
      causationId: context.actor.causationId,
      outcome: 'rejected',
      rejectionCode: code,
      safeNextAction:
        'Read the current case, confirm authority and evidence, then submit a new version-bound request.',
      occurredAt: context.at,
    };
    await this.#repository.appendRejected(transition);
    await this.#auditMutation(context, transition);
  }

  async #auditMutation(
    context: CaseCommandContext,
    transition: OperationalCaseTransition,
  ): Promise<void> {
    await this.#audit.record({
      tenantId: transition.tenantId,
      caseId: transition.caseId,
      actorId: transition.actorId,
      actorRoles: transition.actorRoles,
      command: transition.command,
      reason: transition.reason,
      ...(transition.expectedVersion === undefined
        ? {}
        : { expectedVersion: transition.expectedVersion }),
      ...(transition.actualVersion === undefined
        ? {}
        : { actualVersion: transition.actualVersion }),
      idempotencyKey: transition.idempotencyKey,
      correlationId: transition.correlationId,
      causationId: transition.causationId,
      outcome: transition.outcome,
      ...(transition.rejectionCode === undefined
        ? {}
        : { rejectionCode: transition.rejectionCode }),
      occurredAt: transition.occurredAt,
      controlVersions: {
        lifecycle: 'operational-case-lifecycle/v1',
        sla: 'operational-case-sla/v1',
        closure: 'operational-case-closure/v1',
      },
    });
    void context;
  }
}
