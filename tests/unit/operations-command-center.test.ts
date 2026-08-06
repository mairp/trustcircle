import { describe, expect, it } from 'vitest';

import {
  AttentionQueueService,
  OperationsReadForbiddenError,
} from '../../packages/application/src/attention-queue.ts';
import { rankAttentionCandidates } from '../../packages/domain/src/operations.ts';
import {
  OPERATIONS_NOW,
  OPERATIONS_TENANT,
  candidate,
  source,
} from '../fixtures/operations-command-center.ts';

describe('operations command center attention ranking', () => {
  it('correlates only an explicit governed problem identity and explains the deterministic rank', () => {
    const related = candidate({
      source: source({
        domain: 'integrity',
        recordType: 'integrity_case',
        recordId: 'integrity-7',
      }),
      severity: 'critical',
      impact: 'blocking',
      title: 'Related integrity block',
    });
    const separate = candidate({
      source: source({
        domain: 'runtime',
        recordType: 'runtime_component',
        recordId: 'runtime-2',
        governedProblemKey: undefined,
      }),
      title: 'Runtime component is degraded',
    });
    const items = rankAttentionCandidates([candidate(), separate, related], OPERATIONS_NOW);

    expect(items).toHaveLength(2);
    expect(items[0]?.sources).toHaveLength(2);
    expect(items[0]?.severity).toBe('critical');
    expect(items[0]?.ranking.version).toBe('attention-ranking/v1');
    expect(items[0]?.ranking.factors.map((factor) => factor.code)).toContain('time_pressure');
    expect(rankAttentionCandidates([related, separate, candidate()], OPERATIONS_NOW)).toEqual(
      items,
    );
  });
});

describe('role-aware attention collection', () => {
  it('does not invoke any adapter when the verified role plan has no readable domains', async () => {
    let calls = 0;
    const queue = new AttentionQueueService([
      {
        domain: 'decision',
        read: () => {
          calls += 1;
          return {
            candidates: [candidate()],
            coverage: { domain: 'decision', quality: 'current', candidateCount: 1 },
          };
        },
      },
    ]);

    await expect(
      queue.page({
        tenantId: OPERATIONS_TENANT,
        principalId: 'admin-only',
        roles: ['platform_admin'],
        evaluatedAt: OPERATIONS_NOW,
      }),
    ).rejects.toBeInstanceOf(OperationsReadForbiddenError);
    expect(calls).toBe(0);
  });

  it('keeps successful items visible while declaring missing domain coverage', async () => {
    const queue = new AttentionQueueService([
      {
        domain: 'decision',
        read: () => ({
          candidates: [candidate()],
          coverage: {
            domain: 'decision',
            quality: 'current',
            observedAt: OPERATIONS_NOW,
            candidateCount: 1,
          },
        }),
      },
    ]);
    const page = await queue.page({
      tenantId: OPERATIONS_TENANT,
      principalId: 'operator-a',
      roles: ['operator'],
      evaluatedAt: OPERATIONS_NOW,
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.quality).toBe('unavailable');
    expect(page.coverage.find((item) => item.domain === 'runtime')?.failureCode).toBe(
      'source_read_failed',
    );
    expect(page.safeNextAction).toMatch(/incomplete/i);
  });
});
