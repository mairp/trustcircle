import {
  assertExpectedGovernedVersion,
  assertGovernedTenant,
  governedDigest,
  type GovernedResourceIdentity,
  type ImmutableGovernedFact,
} from '@trustcircle/domain';

import { type Database, type SourceContract } from './database.ts';
import {
  commitUnitOfWork,
  readCanonicalState,
  type CommitUnitOfWorkResult,
  type CanonicalStateRow,
} from './unit-of-work.ts';

export const GOVERNED_RESOURCE_ENTITY_PREFIX = 'governed_platform.resource.';
export const GOVERNED_FACT_ENTITY_PREFIX = 'governed_platform.fact.';

export interface GovernedResourceState extends GovernedResourceIdentity {
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface CommitGovernedResourceCommand {
  readonly tenantId: string;
  readonly kind: string;
  readonly entityId: string;
  readonly expectedVersion: number;
  readonly state: GovernedResourceState;
  readonly actorPrincipalId: string;
  readonly accountableOwnerId: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly policyDecisionId: string;
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  readonly eventTopic: string;
  readonly eventPayload: Readonly<Record<string, unknown>>;
}

export interface AppendGovernedFactCommand {
  readonly tenantId: string;
  readonly kind: string;
  readonly fact: ImmutableGovernedFact;
  readonly accountableOwnerId: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly policyDecisionId: string;
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  readonly eventTopic: string;
  readonly eventPayload: Readonly<Record<string, unknown>>;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(field + ' must be non-empty.');
}

function evidenceRefs(policyDecisionId: string, refs: readonly string[]): readonly string[] {
  requireNonEmpty(policyDecisionId, 'policyDecisionId');
  return Object.freeze([
    'policy-decision:' + policyDecisionId,
    ...refs.filter((ref) => ref.trim().length > 0),
  ]);
}

function resourceEntityKind(kind: string): string {
  requireNonEmpty(kind, 'kind');
  return GOVERNED_RESOURCE_ENTITY_PREFIX + kind;
}

function factEntityKind(kind: string): string {
  requireNonEmpty(kind, 'kind');
  return GOVERNED_FACT_ENTITY_PREFIX + kind;
}

export async function commitGovernedResource(
  db: Database,
  command: CommitGovernedResourceCommand,
): Promise<CommitUnitOfWorkResult> {
  assertGovernedTenant(command.state.tenantId, command.tenantId);
  if (command.state.id !== command.entityId) {
    throw new TypeError('The canonical state ID must match the repository entity ID.');
  }
  if (command.state.kind !== command.kind) {
    throw new TypeError('The canonical state kind must match the repository entity kind.');
  }
  if (command.expectedVersion === 0) {
    if (command.state.resourceVersion !== 1) {
      throw new TypeError('A newly created governed resource must start at version 1.');
    }
  } else {
    assertExpectedGovernedVersion(command.state.resourceVersion - 1, command.expectedVersion);
  }
  const targetDigest = governedDigest(command.state);
  return commitUnitOfWork(db, {
    tenantId: command.tenantId,
    operationScope: 'governed-platform.' + command.kind,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    contract: command.contract,
    expectedContractVersion: command.expectedContractVersion,
    request: {
      kind: command.kind,
      entityId: command.entityId,
      expectedVersion: command.expectedVersion,
      stateDigest: targetDigest,
      policyDecisionId: command.policyDecisionId,
    },
    canonical: {
      entityKind: resourceEntityKind(command.kind),
      entityId: command.entityId,
      expectedVersion: command.expectedVersion,
      state: command.state,
    },
    action: command.eventTopic,
    audit: {
      actor: command.actorPrincipalId,
      owner: command.accountableOwnerId,
      reason: command.reason,
      sourceStateDigest:
        command.expectedVersion === 0 ? null : 'resource-v' + command.expectedVersion,
      targetStateDigest: targetDigest,
      scope: 'tenant:' + command.tenantId + '/' + command.kind + ':' + command.entityId,
      policyVersion: command.policyVersion,
      controlVersion: command.controlVersion,
      evidenceRefs: evidenceRefs(command.policyDecisionId, command.evidenceRefs),
    },
    outbox: {
      topic: command.eventTopic,
      payload: {
        ...command.eventPayload,
        tenantId: command.tenantId,
        aggregateType: command.kind,
        aggregateId: command.entityId,
        aggregateVersion: command.state.resourceVersion,
        correlationId: command.correlationId,
        stateDigest: targetDigest,
      },
    },
  });
}

export async function appendGovernedFact(
  db: Database,
  command: AppendGovernedFactCommand,
): Promise<CommitUnitOfWorkResult> {
  assertGovernedTenant(command.fact.tenantId, command.tenantId);
  const { canonicalDigest, ...factContent } = command.fact;
  const digest = governedDigest(factContent);
  if (digest !== canonicalDigest) {
    throw new TypeError('Immutable fact digest does not match its canonical content.');
  }
  return commitUnitOfWork(db, {
    tenantId: command.tenantId,
    operationScope: 'governed-platform.fact.' + command.kind,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.fact.correlationId,
    contract: command.contract,
    expectedContractVersion: command.expectedContractVersion,
    request: {
      kind: command.kind,
      factId: command.fact.id,
      canonicalDigest: command.fact.canonicalDigest,
      policyDecisionId: command.policyDecisionId,
    },
    canonical: {
      entityKind: factEntityKind(command.kind),
      entityId: command.fact.id,
      expectedVersion: 0,
      state: command.fact,
    },
    action: command.eventTopic,
    audit: {
      actor: command.fact.actorPrincipalId,
      owner: command.accountableOwnerId,
      reason: command.reason,
      sourceStateDigest: null,
      targetStateDigest: command.fact.canonicalDigest,
      scope: 'tenant:' + command.tenantId + '/fact:' + command.kind + ':' + command.fact.id,
      policyVersion: command.policyVersion,
      controlVersion: command.controlVersion,
      evidenceRefs: evidenceRefs(command.policyDecisionId, command.evidenceRefs),
    },
    outbox: {
      topic: command.eventTopic,
      payload: {
        ...command.eventPayload,
        tenantId: command.tenantId,
        aggregateType: command.kind,
        aggregateId: command.fact.id,
        aggregateVersion: 1,
        correlationId: command.fact.correlationId,
        canonicalDigest: command.fact.canonicalDigest,
      },
    },
  });
}

export async function readGovernedResource(
  db: Database,
  tenantId: string,
  kind: string,
  entityId: string,
): Promise<CanonicalStateRow | null> {
  return readCanonicalState(db, tenantId, resourceEntityKind(kind), entityId);
}

export async function readGovernedFact(
  db: Database,
  tenantId: string,
  kind: string,
  factId: string,
): Promise<CanonicalStateRow | null> {
  return readCanonicalState(db, tenantId, factEntityKind(kind), factId);
}
