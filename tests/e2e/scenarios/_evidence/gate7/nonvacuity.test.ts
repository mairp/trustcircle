// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 (GATE7) — DURABLE non-vacuity control for the compliance accessibility oracle
// (W4). Companion to compliance-scenarios.test.ts (T217 witness) and emit-scenario10.test.ts (T218).
//
// The T217 witness asserts the SHIPPED compliance presenters audit CLEAN (0 findings). A green witness
// only means something if a BROKEN presenter would go RED — otherwise the oracle could be vacuously
// passing. Prior attempts proved this with a throwaway probe that was deleted after the run, so the
// claim was not independently re-verifiable from durable artifacts. This file is that probe, COMMITTED:
// it renders the SHIPPED presenter over the honest model (positive control → ok) and over two
// DEGRADED models (negative controls → the oracle MUST return findings). It imports the real
// `.tsx` oracle, so — like its siblings — it runs under vitest.emit / vitest.config, never raw node.
//
//   run:  npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.nonvacuity.config.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import { buildCoverageViewModel, COMPLIANCE_TENANT_SCOPE } from '../../_compliance-inputs.ts';
import {
  auditCoverageView,
  auditComplianceAccessibility,
} from '../../../../../apps/web/src/features/compliance/accessibility.tsx';
import { renderCoverageView } from '../../../../../apps/web/src/features/compliance/CoverageView.tsx';

describe('GATE7 · W4 non-vacuity — the compliance accessibility oracle discriminates', () => {
  it('POSITIVE CONTROL: the shipped presenter over the honest model audits clean (ok, 0 findings)', () => {
    const reports = auditComplianceAccessibility({
      tenant: COMPLIANCE_TENANT_SCOPE,
      coverage: buildCoverageViewModel(),
    });
    const findings = reports.flatMap((r) => r.findings);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(findings).toEqual([]);
  });

  it('NEGATIVE CONTROL 1: a boundary MISLABELLED as certified is caught (findings > 0, not ok)', () => {
    // Same honest model, but a `ready` (internal-readiness) boundary rendered with a "certified" label
    // by tampering the HTML the oracle audits. The CARDINAL anti-lie (FR-055 / SC-012) must fire.
    const model = buildCoverageViewModel();
    const honestHtml = renderCoverageView({ tenant: COMPLIANCE_TENANT_SCOPE, model });
    // Inject a lie into the boundary label text and strip the not-certified note.
    const lyingHtml = honestHtml
      .replace(
        /(<[^>]*\bdata-testid="claim-boundary-label"[^>]*>)([\s\S]*?)(<\/p>)/,
        '$1Externally certified and accredited$3',
      )
      .replace(/data-testid="not-certified-note"/g, 'data-testid="scrubbed-note"');
    const report = auditCoverageView(lyingHtml, model);
    expect(report.ok).toBe(false);
    expect(report.findings.length).toBeGreaterThan(0);
    // The specific anti-lie / not-certified rules must be among the findings.
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['claim-boundary-mislabel']),
    );
    expect(rules).toEqual(
      expect.arrayContaining(['not-certified-note']),
    );
  });

  it('NEGATIVE CONTROL 2: an uncovered obligation whose coverage-gap is stripped is caught (findings > 0)', () => {
    // The honest model has an UNCOVERED obligation (`obligation-unmapped`) that MUST surface a
    // coverage-gap (FR-031). Render honestly, then scrub the gap marker out of the uncovered row.
    const model = buildCoverageViewModel();
    const honestHtml = renderCoverageView({ tenant: COMPLIANCE_TENANT_SCOPE, model });
    // Remove every coverage-gap testid so no uncovered row can surface its gap.
    const gaplessHtml = honestHtml.replace(/data-testid="coverage-gap"/g, 'data-testid="scrubbed-gap"');
    const report = auditCoverageView(gaplessHtml, model);
    expect(report.ok).toBe(false);
    expect(report.findings.length).toBeGreaterThan(0);
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['uncovered-surfaces-gap']));
  });
});
