// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 — shared COMPLIANCE SCENARIO INPUTS (node-safe fixture bridge) (T217).
//
// The standards-applicability + audit-readiness acceptance runners (standards-applicability.ts) all
// project the SAME fixed compliance world (tests/fixtures/compliance.ts — the REAL domain factories +
// the REAL application coverage engine over one fixed set of rows) and read durable facts off REAL
// oracles. This module builds that shared input bundle ONCE and re-exports the fixture's builders so
// every runner reads byte-identical inputs.
//
// NODE-SAFETY. This bridge imports only the shipped `.tsx` presenter TYPES (type-only imports are
// erased by Node's `--experimental-strip-types` loader), never their runtime — so the SYNC runner and
// the raw-node smoke run stay `.tsx`-free at module-eval time. The `.tsx` accessibility ORACLE is
// loaded lazily, only inside the async accessibility runner (which runs under vitest, which transforms
// `.tsx`). See tests/e2e/scenarios/standards-applicability.ts and the controller idiom in
// tests/e2e/scenarios/_controller-inputs.ts.
//
// DETERMINISM. The fixed clock NOW, no I/O, no randomness. Same fixture ⇒ byte-identical inputs.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { NOW, TENANT, iso, IDS } from '../../fixtures/compliance.ts';

import type { EpochMillis } from '@trustcircle/domain';
import type { TenantScope } from '../../../apps/web/src/app/layout.tsx';
import type { CoverageViewModel } from '../../../apps/web/src/features/compliance/CoverageView.tsx';

// Re-export the fixture surface every runner composes so a runner imports ONE bridge, not the raw fixture.
export {
  NOW,
  iso,
  TENANT,
  OTHER_TENANT,
  COMPLIANCE_OWNER,
  INDEPENDENT_REVIEWER,
  CONTROL_OWNER,
  AUDITOR,
  ASSESSOR,
  SEVEN_COVERAGE_SCENARIOS,
  PUBLICATION_42001,
  PUBLICATION_42001_V2,
  PUBLICATION_42006,
  PUBLICATIONS,
  DUTY_CLASS_42006,
  CLAUSE_READY,
  DECISION_READY,
  DECISION_PROPOSED,
  DECISION_STALE,
  DECISION_UNMAPPED,
  DECISION_REOPENED_NA,
  DECISION_CROSS_TENANT,
  DECISIONS,
  CERTIFICATION_VALID,
  CERTIFICATION_EXPIRED,
  READY_INPUTS,
  CERTIFIED_INPUTS,
  EXPIRED_CERT_INPUTS,
  STALE_INPUTS,
  UNMAPPED_INPUTS,
  REOPENED_INPUTS,
  CROSS_TENANT_INPUTS,
  FULL_TENANT_INPUTS,
  COVERAGE_INPUTS_BY_SCENARIO,
  coverageForScenario,
  referenceCountForScenario,
  AUDIT_EXPORT_REQUEST,
  IDS,
} from '../../fixtures/compliance.ts';
export type { CoverageScenarioName, CoverageScenarioSpec } from '../../fixtures/compliance.ts';

/**
 * The tenant-scope banner the compliance presenters render into. Constructed from the fixture's fixed
 * TENANT + clock so it is deterministic and carries no wall-clock timestamp. Mirrors the controller
 * fixture's CONTROLLER_TENANT_SCOPE shape (the `TenantScope` contract from apps/web/src/app/layout.tsx).
 */
export const COMPLIANCE_TENANT_SCOPE: TenantScope = {
  tenantId: String(TENANT),
  tenantName: 'Home Tenant',
  bundleId: 'bundle-compliance-001',
  semanticHash: 'sha256:compliance-fixture-bundle',
  workItemId: String(IDS.SYSTEM_ID),
  generatedAt: iso(NOW),
};

/** The shared input bundle every compliance runner reads from. */
export interface ComplianceInputs {
  readonly at: EpochMillis;
  readonly tenant: TenantScope;
}

/** Build the shared compliance input bundle (deterministic; the fixed clock by default). */
export function buildComplianceInputs(at: EpochMillis = NOW): ComplianceInputs {
  return {
    at,
    tenant: COMPLIANCE_TENANT_SCOPE,
  };
}

/**
 * A deterministic, self-contained COVERAGE VIEW MODEL for the accessibility scenario — a render-ready
 * reduction the CoverageView presenter + accessibility oracle consume. It carries a COVERED obligation
 * (an operating control with current evidence) AND an UNCOVERED obligation (an unmapped gap), an
 * internal-readiness assessment, and NO external certification — so the `.tsx` oracle can prove the
 * cardinal anti-lie (internal readiness is NEVER labelled as external certification, FR-055 / SC-012),
 * that every uncovered row surfaces its gap (FR-031), and that a null certification is stated as absent
 * (FR-034). The boundary is `ready` (internal readiness), NEVER `certified`. Pure literal — no clock.
 */
export function buildCoverageViewModel(): CoverageViewModel {
  return {
    scopeLabel: 'ISO/IEC 42001:2023 — underwriting AI scope',
    claimBoundary: 'ready',
    obligations: [
      {
        obligationId: 'obligation-ready',
        clauseRef: '6.1.2',
        clauseTitle: 'AI risk assessment',
        dutyClass: 'organizational_obligation',
        responsibility: 'organization',
        covered: true,
        controlId: 'control-ready',
        designState: 'designed',
        operatingState: 'operating',
        evidenceSufficiency: 'sufficient',
        latestEvidenceId: 'evidence-ready-attestation',
        latestEvidenceAtIso: '2026-01-16T00:00:00.000Z',
        gapKind: '',
      },
      {
        obligationId: 'obligation-unmapped',
        clauseRef: '9.2',
        clauseTitle: 'Internal audit',
        dutyClass: 'organizational_obligation',
        responsibility: 'organization',
        covered: false,
        controlId: '',
        designState: 'unknown',
        operatingState: 'unknown',
        evidenceSufficiency: 'none',
        latestEvidenceId: '',
        latestEvidenceAtIso: '',
        gapKind: 'unmapped_obligation',
      },
    ],
    assessments: [
      {
        assessmentId: 'assessment-internal-ready',
        kind: 'internal_readiness',
        result: 'ready',
        assessedAtIso: '2026-01-16T00:00:00.000Z',
      },
    ],
    certification: null,
    obligationCount: 2,
    coveredCount: 1,
    complete: false,
    generatedAtIso: iso(NOW),
    freshness: 'current',
    snapshotDigest: 'sha256:compliancecoverageready0000000000000000000000000000000000000000',
  };
}
