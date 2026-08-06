// Integration-suite test — COMPLIANCE COVERAGE (Phase 7 / User Story 5 — Demonstrate Compliance and
// Audit Readiness / T187 / FR-031..035, FR-054, SC-012, SC-013).
//
// PHASE OBJECTIVE (T187): "Test many-to-many mappings, shared responsibility, evidence windows,
// control effectiveness, exceptions, and stale recalculation."
//
// This is a PURE, deterministic integration test (no Testcontainers). It composes the REAL
// application coverage engine (`reconstructCoverage` / `coverageReferenceCount`) and the REAL
// compliance projector (`ComplianceCoverageProjector`) over the ONE fixed set of fixture rows in
// `../fixtures/compliance.ts`, and asserts each SC-012 / SC-013 / FR-054 property against a genuine
// engine/projector output — never a mutation echo. Every positive assertion carries a NEGATIVE
// CONTROL so no assertion is vacuous. Determinism: one fixed injected instant (`NOW`), fixed ids.
//
// Run via `vitest run --project integration`.

import { describe, it, expect } from 'vitest';

import {
  createFrameworkMapping,
  reconstructCoverage,
  reviewFrameworkMapping,
  supersedeFrameworkMapping,
  coverageReferenceCount,
  type CoverageInputs,
  type CoverageResult,
  type CoverageScope,
  type ControlEvaluationFact,
} from '@trustcircle/application';
import { ComplianceCoverageProjector } from '@trustcircle/projections';

import {
  NOW,
  TENANT,
  OTHER_TENANT,
  IDS,
  READY_INPUTS,
  FULL_TENANT_INPUTS,
  coverageForScenario,
  referenceCountForScenario,
  SEVEN_COVERAGE_SCENARIOS,
  MAPPING_READY,
  EVAL_READY,
  EVAL_STALE,
  DECISION_READY,
  OBLIGATION_READY,
  OBLIGATION_CROSS_TENANT,
  DECISION_CROSS_TENANT,
  DECISIONS,
  OBLIGATIONS,
  MAPPINGS,
  EVALUATIONS,
  CERTIFICATIONS,
} from '../fixtures/compliance.ts';

// `CoverageResult` exposes the certification claim through `claimBoundary`: the boundary reaches
// `certified` ONLY when a verifiable external certification is displayable at `at`. "Certified" is
// therefore exactly `claimBoundary === 'certified'` — internal readiness never masquerades as it.
function isCertified(r: CoverageResult): boolean {
  return r.claimBoundary === 'certified';
}

function gapKinds(r: CoverageResult): readonly string[] {
  return r.gaps.map((g) => g.kind);
}

describe('compliance coverage (T187) — reconstruct-at-instant over the real engine + projector', () => {
  // The fixture catalogue is the acceptance-criteria index; keep it honest.
  it('seeds exactly the seven coverage scenarios (fixture ↔ engine contract)', () => {
    expect(SEVEN_COVERAGE_SCENARIOS.map((s) => s.scenario)).toEqual([
      'ready',
      'certified',
      'readiness-not-certification',
      'stale',
      'unmapped',
      'reopened-non-applicability',
      'cross-tenant',
    ]);
  });

  // 1. READY → complete, ready, zero gaps.
  it('READY reconstructs as complete/ready with zero gaps (SC-012)', () => {
    const r = coverageForScenario('ready');
    expect(r.claimBoundary).toBe('ready');
    expect(r.complete).toBe(true);
    expect(r.gaps.length).toBe(0);
    expect(r.coveredCount).toBe(r.obligationCount);
    expect(r.obligationCount).toBeGreaterThan(0);

    // NEGATIVE CONTROL: STALE is NOT complete and NOT 'ready'.
    const stale = coverageForScenario('stale');
    expect(stale.complete).toBe(false);
    expect(stale.claimBoundary).not.toBe('ready');
  });

  // 2. Certification lift + readiness ≠ certification (SC-012 / FR-055).
  it('certification lifts only when displayable; readiness is never certification', () => {
    const certified = coverageForScenario('certified');
    expect(certified.claimBoundary).toBe('certified');
    expect(isCertified(certified)).toBe(true); // NEGATIVE-CONTROL companion for the expired case

    const expired = coverageForScenario('readiness-not-certification');
    // An EXPIRED certification never lifts the boundary to 'certified'; it caps at 'ready'.
    expect(expired.claimBoundary).toBe('ready');
    expect(isCertified(expired)).toBe(false);
  });

  // 3. Stale recalculation (FR-054): current state is NOT inferred from stale evidence.
  it('STALE surfaces a stale_evidence gap and does NOT infer readiness (FR-054)', () => {
    const stale = coverageForScenario('stale');
    expect(gapKinds(stale)).toContain('stale_evidence');
    // Boundary is below 'ready' — the current operating state is not inferred from stale evidence.
    const order = [
      'incomplete',
      'design',
      'implemented',
      'operating',
      'ready',
      'assessed',
      'certified',
    ];
    expect(order.indexOf(stale.claimBoundary)).toBeLessThan(order.indexOf('ready'));

    // NEGATIVE CONTROL: READY (sufficient, in-date evidence) has NO stale_evidence gap.
    const ready = coverageForScenario('ready');
    expect(gapKinds(ready)).not.toContain('stale_evidence');
  });

  // 4. Unmapped obligation.
  it('UNMAPPED surfaces an unmapped_obligation gap', () => {
    const unmapped = coverageForScenario('unmapped');
    expect(gapKinds(unmapped)).toContain('unmapped_obligation');

    // NEGATIVE CONTROL: READY (mapped + covered) has NO unmapped_obligation gap.
    expect(gapKinds(coverageForScenario('ready'))).not.toContain('unmapped_obligation');
  });

  // 5. Reopened non-applicability.
  it('REOPENED-NA surfaces a reopened_non_applicability gap (a stale non-applicability cannot silence)', () => {
    const reopened = coverageForScenario('reopened-non-applicability');
    expect(gapKinds(reopened)).toContain('reopened_non_applicability');

    // NEGATIVE CONTROL: READY (an active, in-window applicable decision) does not reopen.
    expect(gapKinds(coverageForScenario('ready'))).not.toContain('reopened_non_applicability');
  });

  // 6. Cross-tenant isolation.
  it('cross-tenant reconstruction excludes every OTHER_TENANT obligation/gap (tenant isolation)', () => {
    const r = coverageForScenario('cross-tenant');
    // Only the single TENANT obligation is in scope — the OTHER_TENANT obligation is excluded.
    expect(r.obligationCount).toBe(1);
    expect(r.obligations.map((o) => o.obligationId)).toEqual([OBLIGATION_READY.id]);

    const otherIds = new Set<string>([
      String(OBLIGATION_CROSS_TENANT.id),
      String(DECISION_CROSS_TENANT.id),
    ]);
    for (const o of r.obligations) expect(otherIds.has(String(o.obligationId))).toBe(false);
    for (const g of r.gaps) {
      expect(otherIds.has(String(g.obligationId ?? ''))).toBe(false);
      expect(otherIds.has(String(g.decisionId ?? ''))).toBe(false);
    }
    // With the OTHER_TENANT rows excluded, the TENANT picture is still complete/ready.
    expect(r.claimBoundary).toBe('ready');
    expect(r.complete).toBe(true);

    // NEGATIVE CONTROL: reconstructing for OTHER_TENANT sees ITS obligation, not TENANT's.
    const otherScope: CoverageScope = {
      tenantId: OTHER_TENANT as unknown as CoverageScope['tenantId'],
    };
    const other = reconstructCoverage({
      scope: otherScope,
      decisions: [DECISION_READY, DECISION_CROSS_TENANT],
      obligations: [OBLIGATION_READY, OBLIGATION_CROSS_TENANT],
      mappings: MAPPINGS,
      evaluations: [EVAL_READY],
      certifications: [],
      at: NOW,
    });
    expect(other.obligations.map((o) => String(o.obligationId))).toEqual([
      String(OBLIGATION_CROSS_TENANT.id),
    ]);
    expect(other.obligations.map((o) => String(o.obligationId))).not.toContain(
      String(OBLIGATION_READY.id),
    );
  });

  // 7. Evidence windows / control effectiveness / shared responsibility.
  it('mapping carries an evidence window + responsibility; in-window evidence covers, out-of-window does not', () => {
    // Shared responsibility + evidence window are first-class mapping facts.
    expect(MAPPING_READY.evidenceWindowMillis).toBeGreaterThan(0);
    expect(MAPPING_READY.responsibility).toBeDefined();

    const scope: CoverageScope = READY_INPUTS.scope;
    const base = {
      scope,
      decisions: [DECISION_READY],
      obligations: [OBLIGATION_READY],
      mappings: [MAPPING_READY],
      certifications: [],
      at: NOW,
    } as const;

    // A sufficient, in-window evaluation → the obligation is COVERED and the control effective.
    const covered = reconstructCoverage({ ...base, evaluations: [EVAL_READY] });
    expect(covered.coveredCount).toBe(1);
    expect(covered.obligations[0]?.covered).toBe(true);
    expect(covered.complete).toBe(true);

    // The SAME mapping with STALE (out-of-window) evidence → NOT covered, stale_evidence gap.
    const staleEval: ControlEvaluationFact = { ...EVAL_STALE, controlMappingId: MAPPING_READY.id };
    const notCovered = reconstructCoverage({ ...base, evaluations: [staleEval] });
    expect(notCovered.coveredCount).toBe(0);
    expect(notCovered.obligations[0]?.covered).toBe(false);
    expect(gapKinds(notCovered)).toContain('stale_evidence');
  });

  // 8. Reconstruct-at-instant determinism (SC-013).
  it('reconstruction is deterministic and its reference count is stable & positive (SC-013)', () => {
    const a = reconstructCoverage(READY_INPUTS);
    const b = reconstructCoverage(READY_INPUTS);
    expect(a).toEqual(b);

    const count = coverageReferenceCount(READY_INPUTS);
    expect(count).toBeGreaterThan(0);
    expect(referenceCountForScenario('ready')).toBe(count);

    // NEGATIVE CONTROL: a scenario with more rows touches a different (larger) reference count.
    const full: CoverageInputs = FULL_TENANT_INPUTS;
    expect(coverageReferenceCount(full)).toBeGreaterThan(count);
  });

  // 9. Projector agreement with the engine + snapshot-digest stability (durable-effect witness).
  it('projector agrees with the engine and its snapshot digest is stable per (rows, at)', () => {
    const projector = new ComplianceCoverageProjector({
      tenantId: String(TENANT) as unknown as CoverageScope['tenantId'],
    });
    for (const d of DECISIONS) projector.ingestDecision(d);
    for (const o of OBLIGATIONS) projector.ingestObligation(o);
    for (const m of MAPPINGS) projector.ingestMapping(m);
    for (const e of EVALUATIONS) projector.ingestEvaluation(e);
    for (const c of CERTIFICATIONS) projector.ingestCertification(c);

    const model = projector.coverage({}, NOW);
    const engine = reconstructCoverage(FULL_TENANT_INPUTS);

    expect(model.coverage.claimBoundary).toBe(engine.claimBoundary);
    expect(model.coverage.obligationCount).toBe(engine.obligationCount);
    expect(model.coverage.coveredCount).toBe(engine.coveredCount);
    expect([...gapKinds(model.coverage)].sort()).toEqual([...gapKinds(engine)].sort());
    expect(model.metadata.coverageGapCount).toBe(engine.gaps.length);
    expect(model.metadata.partialCoverage).toBe(!engine.complete);

    // Snapshot digest is a sha256 witness — identical rows + identical `at` ⇒ identical digest.
    const digest = projector.snapshotDigest({}, NOW);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(projector.snapshotDigest({}, NOW)).toBe(digest);

    // NEGATIVE CONTROL 1: a different instant yields a different digest (metadata.generatedAt moves).
    expect(projector.snapshotDigest({}, (NOW + 1) as typeof NOW)).not.toBe(digest);

    // NEGATIVE CONTROL 2: ingesting a row from ANOTHER tenant is refused (tenant guard).
    const foreignDecision = {
      ...DECISION_READY,
      tenantId: OTHER_TENANT as unknown as typeof DECISION_READY.tenantId,
    };
    expect(() => projector.ingestDecision(foreignDecision)).toThrow();
  });

  // The projector injects its tenant when the scope arg omits it — {} and an explicit systemId agree
  // on the tenant slice, and a systemId narrows the scope carried on the result.
  it('projector injects the tenant into the scope arg (Omit<CoverageScope,"tenantId">)', () => {
    const projector = new ComplianceCoverageProjector({
      tenantId: String(TENANT) as unknown as CoverageScope['tenantId'],
    });
    for (const d of DECISIONS) projector.ingestDecision(d);
    for (const o of OBLIGATIONS) projector.ingestObligation(o);
    for (const m of MAPPINGS) projector.ingestMapping(m);
    for (const e of EVALUATIONS) projector.ingestEvaluation(e);

    const scoped = projector.coverage({ systemId: IDS.SYSTEM_ID }, NOW);
    expect(String(scoped.coverage.scope.tenantId)).toBe(String(TENANT));
    expect(String(scoped.coverage.scope.systemId)).toBe(String(IDS.SYSTEM_ID));
  });

  describe('Spec004 truthful multi-framework matrix (FR-048/049)', () => {
    const OWNER = '018f0000-0000-7000-8000-000000000010';
    const REVIEWER = '018f0000-0000-7000-8000-000000000011';

    function matrixMapping(
      index: number,
      mappingType:
        | 'equivalent'
        | 'partially_supports'
        | 'conditional'
        | 'conflicts'
        | 'supersedes'
        | 'not_applicable',
      sourceMaterialType:
        'requirement' | 'guidance' | 'draft' | 'organizational_duty' | 'external_certification',
    ) {
      const proposed = createFrameworkMapping({
        id: '018f0000-0000-7000-8000-0000000002' + String(index).padStart(2, '0'),
        tenantId: TENANT,
        sourcePublicationId: IDS.PUB_42001_ID,
        sourceClauseRef: 'M.' + index,
        sourceMaterialType,
        targetType: 'control',
        targetRef: '/controls/matrix-' + index,
        mappingType,
        coverageExtent:
          mappingType === 'partially_supports'
            ? 'partial'
            : mappingType === 'conditional'
              ? 'conditional'
              : mappingType === 'not_applicable'
                ? 'none'
                : mappingType === 'conflicts'
                  ? 'disputed'
                  : 'full',
        conditions: mappingType === 'conditional' ? ['Production systems only'] : [],
        applicabilityState:
          mappingType === 'not_applicable'
            ? 'not_applicable'
            : mappingType === 'conditional'
              ? 'conditional'
              : 'applicable',
        obligationOwnerPrincipalId: OWNER,
        mappingOwnerPrincipalId: OWNER,
        evidenceRefs: ['/evidence/matrix-' + index],
        rationale: 'Keep each framework relationship and claim dimension explicit.',
        confidenceBand: mappingType === 'conflicts' ? 'low' : 'high',
        now: NOW,
      });
      return reviewFrameworkMapping({
        mapping: proposed,
        tenantId: TENANT,
        expectedVersion: 1,
        reviewerPrincipalId: REVIEWER,
        authorityDecisionId: 'decision-matrix-' + index,
        verdict: mappingType === 'conflicts' ? 'disputed' : 'active',
        reason: { code: 'mapping.review', text: 'Review the typed matrix relationship.' },
        now: NOW + 1,
      });
    }

    it('preserves one-to-many, partial, conditional, disputed, superseded, and not-applicable rows', () => {
      const projector = new ComplianceCoverageProjector({
        tenantId: String(TENANT) as unknown as CoverageScope['tenantId'],
      });
      const equivalent = matrixMapping(1, 'equivalent', 'requirement');
      const partial = matrixMapping(2, 'partially_supports', 'guidance');
      const conditional = matrixMapping(3, 'conditional', 'draft');
      const disputed = matrixMapping(4, 'conflicts', 'organizational_duty');
      const superseding = matrixMapping(5, 'supersedes', 'external_certification');
      const notApplicable = matrixMapping(6, 'not_applicable', 'requirement');
      const superseded = supersedeFrameworkMapping({
        mapping: superseding,
        tenantId: TENANT,
        expectedVersion: superseding.version,
        successorMappingId: '018f0000-0000-7000-8000-000000000299',
        actorPrincipalId: REVIEWER,
        authorityDecisionId: 'decision-matrix-supersede',
        reason: { code: 'mapping.superseded', text: 'Retain the replaced relationship.' },
        now: NOW + 2,
      });
      for (const mapping of [
        equivalent,
        partial,
        conditional,
        disputed,
        superseded,
        notApplicable,
      ]) {
        projector.ingestFrameworkMapping(mapping);
      }
      projector.ingestFrameworkClaim({
        mappingId: equivalent.id,
        tenantId: TENANT,
        controlCoverage: 'covered',
        evidenceSufficiency: 'sufficient',
        readiness: 'ready',
        assessment: 'assessed',
        certification: 'not_certified',
        observedAt: NOW,
        evidenceRefs: ['/evidence/matrix-1'],
      });

      const matrix = projector.frameworkMatrix({ publicationId: IDS.PUB_42001_ID }, NOW);
      expect(matrix.rows).toHaveLength(6);
      expect(
        matrix.rows.filter((row) => row.sourceClauseRef === equivalent.sourceClauseRef),
      ).toHaveLength(1);
      expect(matrix.rows.find((row) => row.id === partial.id)?.controlCoverage).toBe('partial');
      expect(matrix.rows.find((row) => row.id === conditional.id)?.applicability).toBe(
        'conditional',
      );
      expect(matrix.rows.find((row) => row.id === disputed.id)?.mappingStatus).toBe('disputed');
      expect(matrix.rows.find((row) => row.id === superseded.id)?.mappingStatus).toBe('superseded');
      expect(matrix.rows.find((row) => row.id === notApplicable.id)?.applicability).toBe(
        'not_applicable',
      );
      expect(matrix.metadata.partialCoverage).toBe(true);
    });

    it('keeps obligation, coverage, sufficiency, readiness, assessment, and certification distinct', () => {
      const projector = new ComplianceCoverageProjector({
        tenantId: String(TENANT) as unknown as CoverageScope['tenantId'],
      });
      const mapping = matrixMapping(7, 'equivalent', 'requirement');
      projector.ingestFrameworkMapping(mapping);
      projector.ingestFrameworkClaim({
        mappingId: mapping.id,
        tenantId: TENANT,
        controlCoverage: 'covered',
        evidenceSufficiency: 'sufficient',
        readiness: 'ready',
        assessment: 'assessed',
        certification: 'not_certified',
        observedAt: NOW,
        evidenceRefs: ['/evidence/readiness-only'],
      });
      const row = projector.frameworkMatrix({}, NOW).rows[0]!;
      expect(row.requirementType).toBe('requirement');
      expect(row.applicability).toBe('applicable');
      expect(row.duty).toBe('organizational_obligation');
      expect(row.controlCoverage).toBe('covered');
      expect(row.evidenceSufficiency).toBe('sufficient');
      expect(row.readiness).toBe('ready');
      expect(row.assessment).toBe('assessed');
      expect(row.certification).toBe('not_certified');
      expect(row.certification).not.toBe('certified');
    });
  });
});
