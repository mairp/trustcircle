// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 / Phase 18 · User Story 5 — DEMONSTRATE COMPLIANCE & AUDIT READINESS journeys
// (T189 · FR-031..035 · FR-051..056 · SC-012 · SC-013 · SC-022).
//
// Specifies, as executable acceptance oracles mounted HERMETICALLY (real Chromium, NO web server,
// NO tenant-auth, NO React), the accessible compliance / audit-readiness experience across the four
// dependency-free string presenters — CoverageView, ApplicabilityReview, EvidenceExplorer, and
// AuditExplorer — for these journeys:
//
//   • STANDARDS REGISTRY & APPLICABILITY  — an active, independently-reviewed applicability decision
//                                           states its EXACT permitted actions and its independent
//                                           review; never widens the actions (FR-031/032).
//   • APPLICABILITY VIOLATION             — an "active" decision whose review was NOT independent of
//                                           the proposer is surfaced as a `role="alert"`, never hidden
//                                           (FR-032 / FR-053).
//   • REOPENED NON-APPLICABILITY          — a stale non-applicability reopens as a coverage gap with
//                                           the mandated sentence, not a silent suppression (FR-033).
//   • TRUTHFUL CLAIM BOUNDARY             — internal readiness ('ready') is NEVER promoted to external
//                                           certification; the not-certified note is present. A real
//                                           'certified' boundary reads as external certification and
//                                           carries no not-certified note (SC-012 / FR-055).
//   • EVIDENCE TRACE & ACCESS FILTERING   — an authorized envelope shows a body link; an unauthorized
//                                           one shows "body withheld" and its bodyRef is ABSENT from
//                                           the DOM (never leaked) (FR-053).
//   • EVIDENCE INTEGRITY ALERT            — an unverified digest is surfaced as a `role="alert"`; the
//                                           chain of custody is preserved in recorded order; a legal
//                                           hold shows its badge (FR-052).
//   • AUDIT RECONSTRUCT-AT-INSTANT        — the trace pins the exact period, the reconstruction
//                                           instant, and the ledger checkpoint; it makes no external
//                                           conformity/certification claim (SC-013 / FR-056).
//   • AUDIT EXPORT SIGNED MANIFEST + GAPS — a completed SIGNED export shows its manifest verbatim; a
//                                           completed UNSIGNED export raises a `role="alert"`; every
//                                           export reports its gap count; gaps are always shown
//                                           (SC-022 / FR-056).
//   • MANAGEMENT REVIEW / HONEST-EMPTY    — an un-fed audit / coverage view reports ZERO honestly:
//                                           gaps table still present, no fabricated coverage, no
//                                           external-certification claim (FR-034/035).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// HOW IT RUNS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// HERMETIC: the SHIPPED renderers are imported directly (they are pure `renderX(props) => string`
// HTML builders with NO React/JSX runtime — safe to import in the Playwright node process) and mounted
// in-page via `page.setContent(...)` over minimal literal view-models that satisfy each presenter's
// Props interface (the presenters are self-contained view-models — no domain aggregate is needed).
// Each journey asserts the load-bearing DOM (locators by data-testid / role / text) AND scans the page
// with axe-core (WCAG 2.2 AA). Every positive assertion is paired with its NEGATIVE control so no
// oracle is vacuous. No web server, no `setup` dependency — the suite runs anywhere a browser is
// present under TC_NO_WEBSERVER=1 (mirroring the integrity-remediation / controller-operations
// hermetic projects).
//
// ORACLE DISCIPLINE. Same props ⇒ byte-identical render (the renderers are deterministic — no wall
// clock, no randomness, no network), so assertions read a durable presentation of the injected model.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { AXE_WCAG_TAGS } from '../../playwright.config.ts';
import { SHELL_TENANT, type TenantScope } from '../../apps/web/src/app/layout.tsx';
import {
  renderCoverageView,
  EMPTY_COVERAGE_VIEW,
  type CoverageViewModel,
} from '../../apps/web/src/features/compliance/CoverageView.tsx';
import {
  renderApplicabilityReview,
  type ApplicabilityReviewModel,
} from '../../apps/web/src/features/compliance/ApplicabilityReview.tsx';
import {
  renderEvidenceExplorer,
  type EvidenceExplorerModel,
} from '../../apps/web/src/features/evidence/EvidenceExplorer.tsx';
import {
  renderAuditExplorer,
  EMPTY_AUDIT_EXPLORER,
  type AuditExplorerModel,
} from '../../apps/web/src/features/audit/AuditExplorer.tsx';

const TENANT: TenantScope = SHELL_TENANT;

/** Scan the mounted page with axe-core against the pinned WCAG 2.2 AA tag set; fail on any violation. */
async function expectNoAxe(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
  expect(
    results.violations,
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
  ).toEqual([]);
}

// ── Minimal literal view-models — self-contained; no domain aggregate needed ──────────────────────

/**
 * An ACTIVE applicability decision whose review IS independent of the proposer (the compliant path),
 * with EXACTLY the permitted actions the state allows.
 */
function activeIndependentReview(): ApplicabilityReviewModel {
  return {
    decisions: [
      {
        applicabilityId: 'ap-001',
        clauseRef: 'A.5.1',
        clauseTitle: 'Policies for information security',
        proposedResult: 'applicable',
        state: 'active',
        rationale: 'The scope processes regulated personal data; this clause applies.',
        proposerPrincipalId: 'usr-proposer',
        reviewerPrincipalId: 'usr-reviewer',
        independentReview: true,
        evidenceIds: ['ev-1001'],
        reviewByIso: '2027-01-01T00:00:00.000Z',
        expired: false,
        reopensGap: false,
        permittedActions: ['expire'],
        history: [
          {
            version: 1,
            state: 'proposed',
            result: 'applicable',
            actorPrincipalId: 'usr-proposer',
            atIso: '2026-06-01T09:00:00.000Z',
            note: 'Proposed applicable.',
          },
          {
            version: 2,
            state: 'active',
            result: 'applicable',
            actorPrincipalId: 'usr-reviewer',
            atIso: '2026-06-02T09:00:00.000Z',
            note: 'Independently reviewed and put in force.',
          },
        ],
      },
    ],
    generatedAtIso: '2026-08-02T00:00:00.000Z',
    snapshotDigest: 'sha256:applicabilityactive0000000000000000000000000000000000000000000000',
  };
}

/**
 * An "active" decision whose reviewer is the SAME principal as the proposer — an integrity violation
 * (FR-053): active requires an INDEPENDENT reviewer.
 */
function selfReviewedViolation(): ApplicabilityReviewModel {
  return {
    decisions: [
      {
        applicabilityId: 'ap-002',
        clauseRef: 'A.8.2',
        clauseTitle: 'Privileged access rights',
        proposedResult: 'applicable',
        state: 'active',
        rationale: 'Privileged access exists in scope.',
        proposerPrincipalId: 'usr-same',
        reviewerPrincipalId: 'usr-same',
        independentReview: false,
        evidenceIds: [],
        reviewByIso: '2027-01-01T00:00:00.000Z',
        expired: false,
        reopensGap: false,
        permittedActions: [],
        history: [],
      },
    ],
    generatedAtIso: '2026-08-02T00:00:00.000Z',
    snapshotDigest: 'sha256:applicabilityviolation000000000000000000000000000000000000000000',
  };
}

/**
 * A stale, active NON-applicability decision that has expired — its coverage gap REOPENS (FR-054),
 * rather than silently suppressing the obligation.
 */
function reopenedNonApplicability(): ApplicabilityReviewModel {
  return {
    decisions: [
      {
        applicabilityId: 'ap-003',
        clauseRef: 'A.7.4',
        clauseTitle: 'Physical security monitoring',
        proposedResult: 'not_applicable',
        state: 'active',
        rationale: 'No physical premises were in scope at the time of the determination.',
        proposerPrincipalId: 'usr-proposer',
        reviewerPrincipalId: 'usr-reviewer',
        independentReview: true,
        evidenceIds: ['ev-2001'],
        reviewByIso: '2026-01-01T00:00:00.000Z',
        expired: true,
        reopensGap: true,
        permittedActions: ['expire'],
        history: [],
      },
    ],
    generatedAtIso: '2026-08-02T00:00:00.000Z',
    snapshotDigest: 'sha256:applicabilityreopened00000000000000000000000000000000000000000000',
  };
}

/** A coverage view at the internal-readiness 'ready' boundary — NOT external certification. */
function readyCoverage(): CoverageViewModel {
  return {
    scopeLabel: 'ISO/IEC 27001:2022 — production scope',
    claimBoundary: 'ready',
    obligations: [
      {
        obligationId: 'ob-1',
        clauseRef: 'A.5.1',
        clauseTitle: 'Policies for information security',
        dutyClass: 'organizational_obligation',
        responsibility: 'organization',
        covered: true,
        controlId: 'ctl-1',
        designState: 'designed',
        operatingState: 'operating',
        evidenceSufficiency: 'sufficient',
        latestEvidenceId: 'ev-1',
        latestEvidenceAtIso: '2026-07-01T00:00:00.000Z',
        gapKind: '',
      },
      {
        obligationId: 'ob-2',
        clauseRef: 'A.8.8',
        clauseTitle: 'Management of technical vulnerabilities',
        dutyClass: 'organizational_obligation',
        responsibility: 'organization',
        covered: false,
        controlId: '',
        designState: 'unknown',
        operatingState: 'unknown',
        evidenceSufficiency: 'none',
        latestEvidenceId: '',
        latestEvidenceAtIso: '',
        gapKind: 'unmapped',
      },
    ],
    assessments: [
      {
        assessmentId: 'as-1',
        kind: 'internal_readiness',
        result: 'ready',
        assessedAtIso: '2026-07-15T00:00:00.000Z',
      },
    ],
    certification: null,
    obligationCount: 2,
    coveredCount: 1,
    complete: false,
    generatedAtIso: '2026-08-01T00:00:00.000Z',
    freshness: 'current',
    snapshotDigest: 'sha256:coverageready000000000000000000000000000000000000000000000000000',
  };
}

/** A coverage view at the external 'certified' boundary — a valid, displayable certification. */
function certifiedCoverage(): CoverageViewModel {
  return {
    scopeLabel: 'ISO/IEC 27001:2022 — production scope',
    claimBoundary: 'certified',
    obligations: [
      {
        obligationId: 'ob-1',
        clauseRef: 'A.5.1',
        clauseTitle: 'Policies for information security',
        dutyClass: 'organizational_obligation',
        responsibility: 'organization',
        covered: true,
        controlId: 'ctl-1',
        designState: 'designed',
        operatingState: 'operating',
        evidenceSufficiency: 'sufficient',
        latestEvidenceId: 'ev-1',
        latestEvidenceAtIso: '2026-07-01T00:00:00.000Z',
        gapKind: '',
      },
    ],
    assessments: [],
    certification: {
      certificateId: 'cert-9001',
      issuer: 'Accredited Certification Body Ltd',
      status: 'valid',
      validFromIso: '2026-01-01T00:00:00.000Z',
      validUntilIso: '2029-01-01T00:00:00.000Z',
      displayable: true,
      verificationUri: 'https://verify.example/cert-9001',
    },
    obligationCount: 1,
    coveredCount: 1,
    complete: true,
    generatedAtIso: '2026-08-01T00:00:00.000Z',
    freshness: 'current',
    snapshotDigest: 'sha256:coveragecertified000000000000000000000000000000000000000000000000',
  };
}

/** An evidence explorer with one AUTHORIZED envelope (body shown) and one UNAUTHORIZED (withheld). */
const UNAUTHORIZED_BODY_REF = 'https://evidence.internal/blob/secret-body-do-not-leak';

function mixedAccessEvidence(): EvidenceExplorerModel {
  return {
    envelopes: [
      {
        evidenceId: 'ev-auth',
        kind: 'control-attestation',
        contentType: 'application/pdf',
        digest: 'sha256:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        sizeBytes: 20480,
        provenance: {
          sourceSystem: 'grc-platform',
          collectedByPrincipalId: 'usr-collector',
          collectedAtIso: '2026-07-10T00:00:00.000Z',
          method: 'automated-export',
        },
        custody: [
          { atIso: '2026-07-10T00:00:00.000Z', actorPrincipalId: 'usr-collector', action: 'collected', note: 'Exported from GRC.' },
          { atIso: '2026-07-11T00:00:00.000Z', actorPrincipalId: 'usr-officer', action: 'reviewed', note: 'Reviewed for the audit.' },
        ],
        retentionUntilIso: '2033-07-10T00:00:00.000Z',
        legalHold: false,
        accessAuthorized: true,
        integrityVerified: true,
        bodyRef: 'https://evidence.internal/blob/ev-auth',
      },
      {
        evidenceId: 'ev-secret',
        kind: 'incident-record',
        contentType: 'application/json',
        digest: 'sha256:9999888877776666555544443333222211110000ffffeeeeddddccccbbbb5555',
        sizeBytes: 4096,
        provenance: {
          sourceSystem: 'siem',
          collectedByPrincipalId: 'usr-collector',
          collectedAtIso: '2026-07-12T00:00:00.000Z',
          method: 'manual-capture',
        },
        custody: [
          { atIso: '2026-07-12T00:00:00.000Z', actorPrincipalId: 'usr-collector', action: 'collected', note: 'Captured from SIEM.' },
        ],
        retentionUntilIso: '2033-07-12T00:00:00.000Z',
        legalHold: false,
        accessAuthorized: false,
        integrityVerified: true,
        bodyRef: UNAUTHORIZED_BODY_REF,
      },
    ],
    generatedAtIso: '2026-08-02T00:00:00.000Z',
    snapshotDigest: 'sha256:evidencemixed0000000000000000000000000000000000000000000000000000',
  };
}

/** An evidence explorer with an UNVERIFIED-integrity envelope that is under legal hold. */
function tamperedHeldEvidence(): EvidenceExplorerModel {
  return {
    envelopes: [
      {
        evidenceId: 'ev-tampered',
        kind: 'log-bundle',
        contentType: 'application/gzip',
        digest: 'sha256:cccc0000dddd1111eeee2222ffff3333aaaa4444bbbb5555cccc6666dddd7777',
        sizeBytes: 1048576,
        provenance: {
          sourceSystem: 'log-archive',
          collectedByPrincipalId: 'usr-collector',
          collectedAtIso: '2026-07-05T00:00:00.000Z',
          method: 'automated-export',
        },
        custody: [
          { atIso: '2026-07-05T00:00:00.000Z', actorPrincipalId: 'usr-collector', action: 'collected', note: 'Archived logs.' },
          { atIso: '2026-07-06T00:00:00.000Z', actorPrincipalId: 'usr-custodian', action: 'transferred', note: 'Moved to hold storage.' },
          { atIso: '2026-07-07T00:00:00.000Z', actorPrincipalId: 'usr-auditor', action: 'inspected', note: 'Digest mismatch noted.' },
        ],
        retentionUntilIso: '2035-07-05T00:00:00.000Z',
        legalHold: true,
        accessAuthorized: true,
        integrityVerified: false,
        bodyRef: 'https://evidence.internal/blob/ev-tampered',
      },
    ],
    generatedAtIso: '2026-08-02T00:00:00.000Z',
    snapshotDigest: 'sha256:evidencetampered00000000000000000000000000000000000000000000000000',
  };
}

/** A populated audit explorer: a real trace, one SIGNED completed export and one UNSIGNED completed export, and a gap. */
function populatedAudit(): AuditExplorerModel {
  return {
    trace: {
      scopeLabel: 'ISO/IEC 27001:2022 — production scope',
      fromIso: '2026-01-01T00:00:00.000Z',
      toIso: '2026-06-30T23:59:59.000Z',
      reconstructedAtIso: '2026-07-01T00:00:00.000Z',
      ledgerCheckpointDigest: 'sha256:ledger0000111122223333444455556666777788889999aaaabbbbccccdddd',
      referenceCount: 42,
    },
    decisions: [
      { decisionId: 'dec-1', clauseRef: 'A.5.1', result: 'applicable', state: 'active', atIso: '2026-02-01T00:00:00.000Z' },
    ],
    mappings: [
      { mappingId: 'map-1', obligationId: 'ob-1', controlId: 'ctl-1', responsibility: 'provider' },
    ],
    findings: [
      { findingId: 'fnd-1', severity: 'major', statement: 'Vulnerability management control unmapped.', gapKind: 'unmapped', openedAtIso: '2026-03-01T00:00:00.000Z' },
    ],
    remediations: [
      { remediationId: 'rem-1', findingId: 'fnd-1', status: 'in_progress', ownerPrincipalId: 'usr-owner', dueIso: '2026-09-01T00:00:00.000Z' },
    ],
    exports: [
      {
        operationId: 'exp-signed',
        status: 'completed',
        requestedByPrincipalId: 'usr-auditor',
        requestedAtIso: '2026-07-01T10:00:00.000Z',
        manifestDigest: 'sha256:manifest0000111122223333444455556666777788889999aaaabbbbccccdd',
        signed: true,
        gapCount: 1,
      },
      {
        operationId: 'exp-unsigned',
        status: 'completed',
        requestedByPrincipalId: 'usr-auditor',
        requestedAtIso: '2026-07-01T11:00:00.000Z',
        manifestDigest: '',
        signed: false,
        gapCount: 1,
      },
    ],
    gaps: [
      { obligationId: 'ob-2', gapKind: 'unmapped', detail: 'No control is mapped to this obligation.' },
    ],
    generatedAtIso: '2026-08-02T00:00:00.000Z',
    snapshotDigest: 'sha256:auditpopulated0000000000000000000000000000000000000000000000000000',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1 · STANDARDS REGISTRY & APPLICABILITY — active, independently reviewed; exact permitted actions.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('standards registry & applicability — independent review, exact permitted actions', () => {
  test('an active, independently-reviewed decision states its independent review, exact actions, and a live summary (FR-031/032)', async ({
    page,
  }) => {
    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: activeIndependentReview() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    // Independent review is PRESENT and marked independent.
    const review = page.getByTestId('independent-review');
    await expect(review).toHaveAttribute('data-independent-review', 'true');
    await expect(page.getByTestId('independent-review-text')).toContainText('Reviewed independently');

    // Permitted actions are EXACTLY the state's actions, verbatim, and no more.
    const actions = page.getByTestId('applicability-action');
    await expect(actions).toHaveCount(1);
    await expect(actions.first()).toHaveAttribute('data-action', 'expire');

    // The live `role="status"` summary reports the totals in TEXT.
    const summary = page.getByTestId('applicability-summary');
    await expect(summary).toHaveAttribute('role', 'status');
    await expect(summary).toHaveAttribute('data-total', '1');

    // NEGATIVE controls: this compliant decision raises no violation and reopens no gap.
    await expect(page.getByTestId('independent-review-violation')).toHaveCount(0);
    await expect(page.getByTestId('reopened-gap')).toHaveCount(0);

    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2 · APPLICABILITY VIOLATION — active, but the review was NOT independent (self-review).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('applicability violation — a non-independent active review is surfaced, not hidden', () => {
  test('a self-reviewed active decision raises a `role="alert"` independent-review violation (FR-032 / FR-053)', async ({
    page,
  }) => {
    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: selfReviewedViolation() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const violation = page.getByTestId('independent-review-violation');
    await expect(violation).toHaveCount(1);
    await expect(violation).toHaveAttribute('role', 'alert');
    await expect(violation).toContainText('NOT independent');
    await expect(page.getByTestId('independent-review')).toHaveAttribute('data-independent-review', 'false');

    // NEGATIVE control: the compliant fixture would NOT raise this alert.
    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: activeIndependentReview() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('independent-review-violation')).toHaveCount(0);

    // Re-mount the violation model for the axe scan.
    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: selfReviewedViolation() }), {
      waitUntil: 'domcontentloaded',
    });
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3 · REOPENED NON-APPLICABILITY — a stale not-applicable reopens as a coverage gap (FR-033/054).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('reopened non-applicability — the stale determination reopens as a coverage gap', () => {
  test('the reopened-gap `role="alert"` carries the mandated sentence (FR-033)', async ({ page }) => {
    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: reopenedNonApplicability() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const reopened = page.getByTestId('reopened-gap');
    await expect(reopened).toHaveCount(1);
    await expect(reopened).toHaveAttribute('role', 'alert');
    await expect(reopened).toHaveAttribute('data-reopens-gap', 'true');
    await expect(reopened).toContainText(
      'A stale non-applicability reopens as a coverage gap — it does not silently suppress the obligation.',
    );
    // The decision section reflects the reopened posture and expiry.
    const decision = page.getByTestId('applicability-decision');
    await expect(decision).toHaveAttribute('data-reopens-gap', 'true');
    await expect(decision).toHaveAttribute('data-expired', 'true');

    // NEGATIVE control: a non-reopened decision shows no reopened-gap alert.
    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: activeIndependentReview() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('reopened-gap')).toHaveCount(0);

    await page.setContent(renderApplicabilityReview({ tenant: TENANT, model: reopenedNonApplicability() }), {
      waitUntil: 'domcontentloaded',
    });
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4 · TRUTHFUL CLAIM BOUNDARY — readiness ≠ certification (SC-012 / FR-055).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('truthful claim boundary — internal readiness is never external certification', () => {
  test("a 'ready' boundary reads as internal readiness with the not-certified note (SC-012 / FR-055)", async ({
    page,
  }) => {
    await page.setContent(renderCoverageView({ tenant: TENANT, model: readyCoverage() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const boundary = page.getByTestId('claim-boundary');
    await expect(boundary).toHaveAttribute('data-claim-boundary', 'ready');
    await expect(boundary).toHaveAttribute('data-is-internal-readiness', 'true');
    await expect(boundary).toHaveAttribute('data-is-external-certification', 'false');
    await expect(boundary).toHaveAttribute('data-has-displayable-certification', 'false');

    // The CARDINAL anti-lie note is PRESENT and verbatim.
    const note = page.getByTestId('not-certified-note');
    await expect(note).toHaveCount(1);
    await expect(note).toContainText('Internal readiness is not represented as external certification.');

    // No external certification block; the absence is stated honestly.
    await expect(page.getByTestId('no-certification')).toHaveCount(1);
    await expect(page.getByTestId('certification')).toHaveCount(0);

    // An uncovered obligation surfaces its exact gap (never hidden).
    await expect(page.getByTestId('coverage-gap')).toHaveCount(1);
    await expect(page.getByTestId('coverage-gap').first()).toHaveAttribute('data-gap-kind', 'unmapped');

    await expectNoAxe(page);
  });

  test("a real 'certified' boundary reads as external certification and shows NO not-certified note (SC-012 / FR-055)", async ({
    page,
  }) => {
    await page.setContent(renderCoverageView({ tenant: TENANT, model: certifiedCoverage() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const boundary = page.getByTestId('claim-boundary');
    await expect(boundary).toHaveAttribute('data-claim-boundary', 'certified');
    await expect(boundary).toHaveAttribute('data-is-external-certification', 'true');
    await expect(boundary).toHaveAttribute('data-has-displayable-certification', 'true');

    // NEGATIVE control: at 'certified' the not-certified note is ABSENT (it would be a false disclaimer).
    await expect(page.getByTestId('not-certified-note')).toHaveCount(0);

    // The certification block is shown, displayable and verifiable.
    const cert = page.getByTestId('certification');
    await expect(cert).toHaveCount(1);
    await expect(cert).toHaveAttribute('data-displayable', 'true');
    await expect(page.getByTestId('certification-verification-link')).toBeVisible();
    await expect(page.getByTestId('no-certification')).toHaveCount(0);

    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5 · EVIDENCE TRACE & ACCESS FILTERING — authorized body shown; unauthorized withheld, ref absent.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('evidence trace & access filtering — the unauthorized body reference never leaks', () => {
  test('an authorized envelope shows a body link; an unauthorized one withholds it and NEVER emits the bodyRef (FR-053)', async ({
    page,
  }) => {
    await page.setContent(renderEvidenceExplorer({ tenant: TENANT, model: mixedAccessEvidence() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const authorized = page.locator('[data-testid="evidence-envelope"][data-evidence-id="ev-auth"]');
    const unauthorized = page.locator('[data-testid="evidence-envelope"][data-evidence-id="ev-secret"]');

    // Authorized: a body link is present.
    await expect(authorized).toHaveAttribute('data-access-authorized', 'true');
    await expect(authorized.getByTestId('evidence-body-link')).toHaveCount(1);
    await expect(authorized.getByTestId('body-withheld')).toHaveCount(0);

    // Unauthorized: "body withheld", NO link.
    await expect(unauthorized).toHaveAttribute('data-access-authorized', 'false');
    await expect(unauthorized.getByTestId('body-withheld')).toHaveCount(1);
    await expect(unauthorized.getByTestId('evidence-body-link')).toHaveCount(0);

    // CARDINAL: the withheld card's HTML does NOT contain the secret bodyRef string at all.
    const withheldHtml = await unauthorized.innerHTML();
    expect(withheldHtml).not.toContain(UNAUTHORIZED_BODY_REF);

    // Integrity words are present for both (metadata is always shown).
    await expect(page.getByTestId('integrity-status')).toHaveCount(2);

    // The live summary reports one withheld body, in TEXT.
    const status = page.getByTestId('evidence-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('data-withheld-count', '1');

    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6 · EVIDENCE INTEGRITY ALERT — an unverified digest is a `role="alert"`; custody ordered; hold.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('evidence integrity alert — an unverified digest is surfaced as a tamper alert', () => {
  test('an unverified envelope raises `role="alert"`, preserves custody order, and shows the legal-hold badge (FR-052)', async ({
    page,
  }) => {
    await page.setContent(renderEvidenceExplorer({ tenant: TENANT, model: tamperedHeldEvidence() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const integrity = page.getByTestId('integrity-status');
    await expect(integrity).toHaveAttribute('data-integrity-verified', 'false');
    await expect(integrity).toHaveAttribute('role', 'alert');
    await expect(integrity).toContainText('UNVERIFIED');

    // Custody is a table in RECORDED order (0,1,2) — never reordered.
    const events = page.getByTestId('custody-event');
    await expect(events).toHaveCount(3);
    const indices = await events.evaluateAll((els) =>
      els.map((el) => Number(el.getAttribute('data-custody-index'))),
    );
    expect(indices).toEqual([0, 1, 2]);

    // Legal-hold badge present, with the mandated text.
    const hold = page.getByTestId('legal-hold');
    await expect(hold).toHaveCount(1);
    await expect(hold).toContainText('under legal hold — retention overridden');
    await expect(page.getByTestId('retention-until')).toHaveCount(1);

    // NEGATIVE control: a verified, not-held envelope raises no alert and shows no legal-hold badge.
    await page.setContent(renderEvidenceExplorer({ tenant: TENANT, model: mixedAccessEvidence() }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await expect(page.getByTestId('legal-hold')).toHaveCount(0);

    await page.setContent(renderEvidenceExplorer({ tenant: TENANT, model: tamperedHeldEvidence() }), {
      waitUntil: 'domcontentloaded',
    });
    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7 · AUDIT RECONSTRUCT-AT-INSTANT — the trace pins period, instant, and ledger checkpoint (SC-013).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('audit reconstruct-at-instant — the trace pins the exact scope, instant, and checkpoint', () => {
  test('the trace carries the exact period, reconstruction instant, checkpoint, and no-external-claim note (SC-013 / FR-056)', async ({
    page,
  }) => {
    const model = populatedAudit();
    await page.setContent(renderAuditExplorer({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const trace = page.getByTestId('audit-trace');
    await expect(trace).toHaveAttribute('data-from', model.trace.fromIso);
    await expect(trace).toHaveAttribute('data-to', model.trace.toIso);
    await expect(trace).toHaveAttribute('data-reconstructed-at', model.trace.reconstructedAtIso);
    await expect(trace).toHaveAttribute('data-ledger-checkpoint', model.trace.ledgerCheckpointDigest);
    await expect(trace).toHaveAttribute('data-reference-count', String(model.trace.referenceCount));

    // The two period `<time>`s + the reconstruction `<time>`.
    await expect(page.getByTestId('trace-from')).toHaveAttribute('datetime', model.trace.fromIso);
    await expect(page.getByTestId('trace-to')).toHaveAttribute('datetime', model.trace.toIso);
    await expect(page.getByTestId('trace-reconstructed-at')).toHaveAttribute(
      'datetime',
      model.trace.reconstructedAtIso,
    );

    // The SC-013 statement + the FR-056 no-external-claim note, verbatim.
    await expect(page.getByTestId('audit-trace-statement')).toContainText(
      'Coverage reconstructed for an exact scope and instant.',
    );
    const noClaim = page.getByTestId('no-external-claim-note');
    await expect(noClaim).toHaveCount(1);
    await expect(noClaim).toContainText(
      'No mapping, artifact, or internal readiness result is represented as conformity, accreditation, or external certification.',
    );

    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8 · AUDIT EXPORT SIGNED MANIFEST + GAPS — signed manifest verbatim; unsigned raises alert (SC-022).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('audit export — a completed signed export shows its manifest; an unsigned one alerts', () => {
  test('the signed export shows the manifest verbatim, the unsigned raises `role="alert"`, and gaps are always shown (SC-022 / FR-056)', async ({
    page,
  }) => {
    const model = populatedAudit();
    await page.setContent(renderAuditExplorer({ tenant: TENANT, model }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    const signed = page.locator('[data-testid="audit-export"][data-operation-id="exp-signed"]');
    const unsigned = page.locator('[data-testid="audit-export"][data-operation-id="exp-unsigned"]');

    // Signed completed export: manifest shown verbatim, marked signed, no alert.
    await expect(signed).toHaveAttribute('data-status', 'completed');
    await expect(signed).toHaveAttribute('data-signed', 'true');
    await expect(signed.getByTestId('export-manifest-digest')).toHaveText(
      model.exports[0].manifestDigest,
    );
    await expect(signed.locator('[role="alert"]')).toHaveCount(0);

    // Unsigned completed export: raises a `role="alert"`.
    await expect(unsigned).toHaveAttribute('data-status', 'completed');
    await expect(unsigned).toHaveAttribute('data-signed', 'false');
    const alert = unsigned.getByTestId('audit-export-unsigned-alert');
    await expect(alert).toHaveCount(1);
    await expect(alert).toHaveAttribute('role', 'alert');

    // Every export reports its gap count.
    await expect(signed.getByTestId('export-gap-count')).toContainText('1 gap(s) included');
    await expect(unsigned.getByTestId('export-gap-count')).toContainText('1 gap(s) included');

    // The gaps table is ALWAYS present (never hidden, never represented as covered).
    await expect(page.getByTestId('audit-gaps')).toHaveCount(1);
    await expect(page.getByTestId('audit-gap')).toHaveCount(1);
    await expect(page.getByTestId('gaps-count')).toHaveAttribute('data-count', '1');

    await expectNoAxe(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 9 · MANAGEMENT REVIEW / CORRECTIVE-ACTION / HONEST-EMPTY — an un-fed view reports zero honestly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('honest empty — an un-fed audit / coverage view fabricates nothing', () => {
  test('EMPTY_AUDIT_EXPLORER reports zero, keeps the gaps table, and makes no external claim (FR-034/035)', async ({
    page,
  }) => {
    await page.setContent(renderAuditExplorer({ tenant: TENANT, model: EMPTY_AUDIT_EXPLORER }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    // The live summary reports ZERO across the board — nothing fabricated.
    const status = page.getByTestId('audit-status');
    await expect(status).toHaveAttribute('data-decisions', '0');
    await expect(status).toHaveAttribute('data-findings', '0');
    await expect(status).toHaveAttribute('data-gaps', '0');
    await expect(status).toHaveAttribute('data-exports', '0');

    // The gaps table STILL exists (an empty audit does not drop the honesty surface).
    await expect(page.getByTestId('audit-gaps')).toHaveCount(1);
    await expect(page.getByTestId('audit-gap')).toHaveCount(0);
    await expect(page.getByTestId('gaps-count')).toHaveAttribute('data-count', '0');

    // No external-certification claim; the no-external-claim note is present.
    await expect(page.getByTestId('no-external-claim-note')).toHaveCount(1);

    await expectNoAxe(page);
  });

  test('EMPTY_COVERAGE_VIEW is incomplete and NEVER falsely certified (FR-034/035 / FR-055)', async ({
    page,
  }) => {
    await page.setContent(renderCoverageView({ tenant: TENANT, model: EMPTY_COVERAGE_VIEW }), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('main#main')).toBeVisible();

    // The empty coverage view is 'incomplete', internal-only, and NOT external certification.
    const boundary = page.getByTestId('claim-boundary');
    await expect(boundary).toHaveAttribute('data-claim-boundary', 'incomplete');
    await expect(boundary).toHaveAttribute('data-is-external-certification', 'false');
    await expect(boundary).toHaveAttribute('data-has-displayable-certification', 'false');
    await expect(page.getByTestId('not-certified-note')).toHaveCount(1);

    // Zero obligations covered, no fabricated coverage, and no certification block.
    await expect(page.getByTestId('coverage-summary')).toHaveAttribute('data-covered', '0');
    await expect(page.getByTestId('coverage-summary')).toHaveAttribute('data-complete', 'false');
    await expect(page.getByTestId('no-obligations')).toHaveCount(1);
    await expect(page.getByTestId('coverage-row')).toHaveCount(0);
    await expect(page.getByTestId('no-certification')).toHaveCount(1);
    await expect(page.getByTestId('certification')).toHaveCount(0);

    await expectNoAxe(page);
  });
});
