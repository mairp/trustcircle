import { describe, expect, it } from 'vitest';

import { OperationalCaseCommandError } from '../../packages/application/src/operational-case-service.ts';
import {
  caseContext,
  createCaseInput,
  createCaseService,
  OPERATIONS_NOW,
  OPERATIONS_TENANT,
  OTHER_TENANT,
  source,
} from '../fixtures/operations-command-center.ts';

describe('operations command center authority and tenant isolation', () => {
  it('denies administrator-only case authority and records the rejected attempt', async () => {
    const { service, audit } = createCaseService();
    await expect(
      service.create(
        caseContext({
          principalId: 'platform-admin',
          roles: ['platform_admin'],
          idempotencyKey: 'admin-attempt-0001',
        }),
        createCaseInput,
      ),
    ).rejects.toMatchObject<Partial<OperationalCaseCommandError>>({
      code: 'forbidden',
      status: 403,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: 'platform-admin',
      outcome: 'rejected',
      rejectionCode: 'forbidden',
    });
  });

  it('does not expose a tenant A case through a tenant B lookup', async () => {
    const { service } = createCaseService();
    const created = await service.create(caseContext(), createCaseInput);
    expect(await service.read(OPERATIONS_TENANT, created.mutation.case.id)).toBeDefined();
    expect(await service.read(OTHER_TENANT, created.mutation.case.id)).toBeUndefined();
    expect(await service.list(OTHER_TENANT)).toEqual([]);
  });

  it('blocks an owner from acting as the independent closure verifier', async () => {
    const { service, audit } = createCaseService();
    const created = await service.create(caseContext(), createCaseInput);
    const acknowledged = await service.transition(
      caseContext({ idempotencyKey: 'owner-path-0002' }),
      created.mutation.case.id,
      1,
      { command: 'acknowledge' },
    );
    const progressed = await service.transition(
      caseContext({ idempotencyKey: 'owner-path-0003' }),
      created.mutation.case.id,
      acknowledged.mutation.case.version,
      { command: 'progress' },
    );
    const resolvedSource = source({ resolved: true, recordVersion: '5' });
    const submitted = await service.transition(
      caseContext({ idempotencyKey: 'owner-path-0004' }),
      created.mutation.case.id,
      progressed.mutation.case.version,
      {
        command: 'submit_verification',
        sourceVersions: [resolvedSource],
        evidenceReferences: ['evidence://release-42/reconciliation'],
      },
    );

    await expect(
      service.transition(
        caseContext({
          principalId: 'owner-a',
          roles: ['governance_officer'],
          idempotencyKey: 'owner-verify-0005',
          reason: 'Owner attempted to verify their own operational work.',
          at: OPERATIONS_NOW + 5_000,
        }),
        created.mutation.case.id,
        submitted.mutation.case.version,
        {
          command: 'verify',
          sourceVersions: [resolvedSource],
          evidenceReferences: ['evidence://release-42/reconciliation'],
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition', status: 422 });
    expect(audit.at(-1)).toMatchObject({
      outcome: 'rejected',
      rejectionCode: 'invalid_transition',
    });
  });
});
