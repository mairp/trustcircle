import { describe, expect, it } from 'vitest';

import {
  caseContext,
  createCaseInput,
  createCaseService,
  OPERATIONS_NOW,
  source,
} from '../fixtures/operations-command-center.ts';

describe('governed operational case lifecycle', () => {
  it('preserves attribution and independent verification through closure', async () => {
    const { service, audit } = createCaseService();
    const created = await service.create(caseContext(), createCaseInput);
    expect(created.mutation.case.status).toBe('open');
    expect(created.mutation.case.version).toBe(1);

    const acknowledged = await service.transition(
      caseContext({ idempotencyKey: 'operation-key-0002', at: OPERATIONS_NOW + 1_000 }),
      created.mutation.case.id,
      1,
      { command: 'acknowledge' },
    );
    const progressed = await service.transition(
      caseContext({ idempotencyKey: 'operation-key-0003', at: OPERATIONS_NOW + 2_000 }),
      created.mutation.case.id,
      acknowledged.mutation.case.version,
      { command: 'progress' },
    );
    const resolvedSource = source({
      recordVersion: '5',
      resolved: true,
      observedAt: OPERATIONS_NOW + 3_000,
    });
    const submitted = await service.transition(
      caseContext({ idempotencyKey: 'operation-key-0004', at: OPERATIONS_NOW + 3_000 }),
      created.mutation.case.id,
      progressed.mutation.case.version,
      {
        command: 'submit_verification',
        sourceVersions: [resolvedSource],
        evidenceReferences: ['evidence://release-42/reconciliation'],
      },
    );
    const verified = await service.transition(
      caseContext({
        principalId: 'independent-verifier',
        roles: ['governance_officer'],
        idempotencyKey: 'operation-key-0005',
        reason: 'Independent reviewer verified current sources and evidence.',
        at: OPERATIONS_NOW + 4_000,
      }),
      created.mutation.case.id,
      submitted.mutation.case.version,
      {
        command: 'verify',
        sourceVersions: [resolvedSource],
        evidenceReferences: ['evidence://release-42/reconciliation'],
      },
    );
    const closed = await service.transition(
      caseContext({ idempotencyKey: 'operation-key-0006', at: OPERATIONS_NOW + 5_000 }),
      created.mutation.case.id,
      verified.mutation.case.version,
      { command: 'close' },
    );

    expect(closed.mutation.case.status).toBe('closed');
    expect(closed.mutation.case.verification?.verifierId).toBe('independent-verifier');
    expect(closed.mutation.case.verification?.closureControlVersion).toBe(
      'operational-case-closure/v1',
    );
    expect(audit.map((event) => event.command)).toEqual([
      'create',
      'acknowledge',
      'progress',
      'submit_verification',
      'verify',
      'close',
    ]);
    expect(audit.every((event) => event.outcome === 'accepted')).toBe(true);
  });

  it('replays an idempotent create and records SLA breaches without duplicate escalation', async () => {
    const { service } = createCaseService();
    const context = caseContext({ idempotencyKey: 'operation-key-replay' });
    const input = { ...createCaseInput, ownerId: undefined };
    const first = await service.create(context, input);
    const replay = await service.create(context, input);
    expect(replay.outcome).toBe('duplicate');
    expect(replay.mutation.case.id).toBe(first.mutation.case.id);

    const evaluated = await service.evaluateSla(
      caseContext({
        roles: ['automation_principal'],
        principalId: 'sla-evaluator',
        idempotencyKey: 'sla-evaluation-0001',
        reason: 'Scheduled SLA evaluation after resolution target.',
        at: OPERATIONS_NOW + 360_000,
      }),
      first.mutation.case.id,
      first.mutation.case.version,
    );
    expect(evaluated.mutation.case.status).toBe('escalated');
    expect(evaluated.mutation.case.breachTypes).toEqual([
      'acknowledgement',
      'resolution',
      'unowned',
    ]);
    expect(evaluated.mutation.escalations).toHaveLength(3);

    const duplicate = await service.evaluateSla(
      caseContext({
        roles: ['automation_principal'],
        principalId: 'sla-evaluator',
        idempotencyKey: 'sla-evaluation-0001',
        reason: 'Scheduled SLA evaluation after resolution target.',
        at: OPERATIONS_NOW + 360_000,
      }),
      first.mutation.case.id,
      first.mutation.case.version,
    );
    expect(duplicate.outcome).toBe('duplicate');
  });
});
