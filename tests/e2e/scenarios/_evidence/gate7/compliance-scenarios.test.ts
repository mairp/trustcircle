// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 (GATE7) — the compliance acceptance-runner witness (T217).
//
// The SYNC standards-applicability scenario is `.tsx`-free and runs under raw node; the ASYNC compliance
// accessibility scenario lazily imports the `.tsx` accessibility oracle, which Node's strip-types loader
// refuses — so it runs HERE, under vitest (which transforms `.tsx`). This test drives BOTH scenarios over
// the fixed compliance world and asserts every acceptance criterion is satisfied with no failures.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  buildComplianceInputs,
  runStandardsApplicabilityScenario,
  runComplianceAccessibilityScenario,
  runAllComplianceScenarios,
} from '../../standards-applicability.ts';

describe('GATE7 · Demonstrate Compliance and Audit Readiness (T217)', () => {
  it('the SYNC standards-applicability scenario binds every criterion to a real oracle', () => {
    const result = runStandardsApplicabilityScenario(buildComplianceInputs());
    const failed = result.criteria.filter((c) => !c.satisfied).map((c) => c.ref);
    expect(failed, 'no unsatisfied criteria').toEqual([]);
    expect(result.allSatisfied).toBe(true);
    expect(result.criteria.length).toBeGreaterThanOrEqual(10);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the ASYNC compliance accessibility scenario audits the shipped .tsx presenters clean', async () => {
    const result = await runComplianceAccessibilityScenario(buildComplianceInputs());
    const failed = result.criteria.filter((c) => !c.satisfied).map((c) => c.ref);
    expect(failed, 'no unsatisfied accessibility criteria').toEqual([]);
    expect(result.allSatisfied).toBe(true);
  });

  it('the aggregate returns both scenarios, all satisfied, deterministically', async () => {
    const a = await runAllComplianceScenarios(buildComplianceInputs());
    const b = await runAllComplianceScenarios(buildComplianceInputs());
    expect(a.applicability.allSatisfied).toBe(true);
    expect(a.accessibility.allSatisfied).toBe(true);
    // Determinism: byte-identical digests across two runs over the same fixture.
    expect(a.applicability.digest).toBe(b.applicability.digest);
    expect(a.accessibility.digest).toBe(b.accessibility.digest);
  });
});
