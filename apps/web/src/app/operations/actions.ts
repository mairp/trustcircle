'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import { apiCommand } from '../../lib/api-client.ts';
import { operationsWorkspaceCapabilities } from '../../lib/permissions.ts';
import { resolveOperatorSession } from '../../lib/session-context.ts';

function required(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Missing ${key}`);
  return value.trim();
}

function safeSources(value: string): readonly unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100)
    throw new Error('Invalid source references');
  return parsed;
}

async function sessionFor(capability: 'create' | 'transition' | 'verify' | 'sla') {
  const session = await resolveOperatorSession();
  const permissions = operationsWorkspaceCapabilities(session);
  const permitted =
    capability === 'create'
      ? permissions.canCreateCases
      : capability === 'verify'
        ? permissions.canVerifyCases
        : capability === 'sla'
          ? permissions.canEvaluateSla
          : permissions.canTransitionCases;
  if (!permitted) throw new Error('The verified role does not permit this operation.');
  return session;
}

function ensureSuccess(result: Awaited<ReturnType<typeof apiCommand>>): void {
  if (!result.ok) {
    throw new Error(
      `The governed operation was not confirmed (${result.diagnostic ?? result.status}). ${result.safeNextAction ?? 'Reconcile through a fresh read.'}`,
    );
  }
}

export async function createOperationalCaseAction(form: FormData): Promise<void> {
  const session = await sessionFor('create');
  const priority = required(form, 'priority');
  const sources = safeSources(required(form, 'source_references'));
  const result = await apiCommand(
    '/v1/operations/cases',
    session,
    {
      attention_item_id: required(form, 'attention_item_id'),
      source_references: sources,
      title: required(form, 'title'),
      priority,
      rationale: required(form, 'reason'),
      service_level_policy_id: `governance-${priority}`,
      service_level_policy_version: '1.0.0',
    },
    { idempotencyKey: randomUUID() },
  );
  ensureSuccess(result);
  revalidatePath('/');
}

export async function transitionOperationalCaseAction(form: FormData): Promise<void> {
  const command = required(form, 'command');
  const session = await sessionFor(command === 'verify' ? 'verify' : 'transition');
  const caseId = required(form, 'case_id');
  const expectedVersion = Number(required(form, 'expected_version'));
  const ownerId = form.get('owner_id');
  const body = {
    command,
    reason: required(form, 'reason'),
    expected_version: expectedVersion,
    ...(typeof ownerId === 'string' && ownerId.trim() ? { owner_id: ownerId.trim() } : {}),
  };
  const result = await apiCommand(`/v1/operations/cases/${caseId}/transitions`, session, body, {
    idempotencyKey: randomUUID(),
    ifMatch: required(form, 'etag'),
  });
  ensureSuccess(result);
  revalidatePath('/');
}

export async function evaluateOperationalCaseSlaAction(form: FormData): Promise<void> {
  const session = await sessionFor('sla');
  const caseId = required(form, 'case_id');
  const result = await apiCommand(
    `/v1/operations/cases/${caseId}/sla-evaluations`,
    session,
    {
      expected_version: Number(required(form, 'expected_version')),
      evaluated_at: new Date().toISOString(),
      reason: 'Authorized on-demand service-level evaluation from the command center.',
    },
    { idempotencyKey: randomUUID(), ifMatch: required(form, 'etag') },
  );
  ensureSuccess(result);
  revalidatePath('/');
}
