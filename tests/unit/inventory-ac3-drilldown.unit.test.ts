// Phase 84 — AC3 witness (SHORT, self-contained; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// AC3: drilling into related work across registered sources (kanban, agentctl,
// workflows_orchestration) shows their DISTINCT source records, the correlation, status
// differences, dependencies, and authoritative fields.
//
// Durable read path: SourceRegistry.drillDown(kanbanSourceId) — distinct records, statusDifferences,
// dependencies — plus latestContract(...).authoritativeFields on each of the THREE named sources.
import { describe, it, expect } from 'vitest';
import { seedTenantProjection } from '../fixtures/inventory.ts';

describe('AC3 — three distinct correlated sources with differences, deps, authority', () => {
  const seeded = seedTenantProjection();
  const { kanbanSourceId, agentctlSourceId, workflowsSourceId } = seeded.ids;
  const drill = seeded.sources.drillDown(kanbanSourceId);

  it('exactly THREE distinct source records are correlated on the kanban anchor', () => {
    const classes = drill.records.map((r) => r.sourceClass).sort();
    expect(classes).toEqual(['agentctl', 'kanban', 'workflows_orchestration']);
    const ids = new Set(drill.records.map((r) => r.id));
    expect(ids.size).toBe(3); // distinct records, never merged
  });

  it('status differences surface where the three records DISAGREE', () => {
    const fields = drill.statusDifferences.map((d) => d.field);
    expect(fields).toContain('status'); // active / inactive / conflicting
    expect(fields).toContain('observedState.pipeline_state'); // running / paused / failed
  });

  it('kanban DEPENDS_ON both agentctl and workflows_orchestration (two declared edges)', () => {
    const targets = new Set(drill.dependencies.map((d) => d.toId));
    expect(targets.has(agentctlSourceId)).toBe(true);
    expect(targets.has(workflowsSourceId)).toBe(true);
  });

  it('each named source owns a DISTINCT authoritative field (authority not collapsed)', () => {
    const auth = (id: import('@trustcircle/domain').Uuid) =>
      seeded.sources.latestContract(id)!.authoritativeFields;
    expect(auth(kanbanSourceId)).toEqual(['status']);
    expect(auth(agentctlSourceId)).toEqual(['pipeline_state']);
    expect(auth(workflowsSourceId)).toEqual(['deployment_target']);
  });
});
