import { describe, expect, it } from 'vitest';

import { rankAttentionCandidates } from '../../packages/domain/src/operations.ts';
import { candidate, OPERATIONS_NOW, source } from '../fixtures/operations-command-center.ts';

describe('operations attention ranking performance', () => {
  it('ranks 10,000 independently identified candidates within the acceptance budget', () => {
    const candidates = Array.from({ length: 10_000 }, (_, index) =>
      candidate({
        source: source({
          domain: index % 2 === 0 ? 'decision' : 'runtime',
          recordType: index % 2 === 0 ? 'decision_request' : 'runtime_component',
          recordId: `record-${String(index).padStart(5, '0')}`,
          governedProblemKey: `problem-${String(index).padStart(5, '0')}`,
          observedAt: OPERATIONS_NOW - index * 1_000,
        }),
        dependencyCount: index % 20,
        severity: index % 100 === 0 ? 'critical' : 'medium',
      }),
    );
    const started = performance.now();
    const ranked = rankAttentionCandidates(candidates, OPERATIONS_NOW);
    const elapsed = performance.now() - started;
    expect(ranked).toHaveLength(10_000);
    expect(ranked[0]?.severity).toBe('critical');
    expect(elapsed).toBeLessThan(2_000);
  });
});
