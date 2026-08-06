// TrustCircleAI — accessible COMPLIANCE COVERAGE VIEW (Phase 7 / User Story 5 — Demonstrate
// Compliance and Audit Readiness / T211 /
// apps/web/src/features/compliance/CoverageView.tsx / FR-031..035, FR-055, SC-012).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The auditor/compliance-officer-facing COVERAGE VIEW: the single screen that answers "for this
// scope's declared-applicable obligations, which are covered by an operating control with current
// evidence, which are GAPS (unmapped, unevidenced, stale, deficient, or a reopened/expired
// applicability decision), what internal-readiness / external-assessment / external-certification
// CLAIM the scope may honestly make, and — if any — what external certification is actually valid
// right now?" — as a PURE PRESENTER over an already-reduced coverage model.
//
// THE COVERAGE, GAP, CLAIM-BOUNDARY, ASSESSMENT, AND CERTIFICATION VERDICTS ARE NOT COMPUTED HERE.
// Every obligation row's `covered`/`gapKind`, the scope's `claimBoundary`, the assessment results,
// and the certification's `displayable` window come from the REAL compliance projection/service
// upstream. This presenter renders those reduced facts VERBATIM through the centralized truthful
// label table (`./claim-labels.ts`); it re-derives no coverage, infers no operation from stale
// evidence, and — the CARDINAL anti-lie (FR-055 / SC-012) — NEVER promotes internal readiness to an
// external assessment or an accredited certification. When the model is not `certified`, the banner
// carries an explicit "internal readiness is not external certification" note, and a null/undisplayable
// certification is stated as such, never rendered as if certified.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every duty class, responsibility, design and
// operating state, evidence sufficiency, gap kind, assessment kind/result, and certification status
// is spelled in WORDS via `./claim-labels.ts`, each with a machine-readable data-attribute so the
// accessibility oracle can prove the meaning is in the text. Stale evidence surfaces as a GAP — it is
// never presented as "operating".
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — they are pure string-builder presenters (tsconfig `jsx:preserve`
// only satisfies the extension resolver). The output is a self-contained HTML string the e2e spec
// mounts via `page.setContent(renderCoverageView(props))` and asserts through axe-core + the live
// accessibility tree, with NO web server, NO React, NO tenant-auth.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no
// network, no module-level mutable state — same props ⇒ byte-identical output.

import type {
  DutyClass,
  ResponsibilityParty,
  AssessmentKind,
  AssessmentResult,
  CertificationStatus,
  ClaimBoundary,
} from '@trustcircle/domain';

import type { TenantScope } from '../../app/layout.tsx';

import {
  claimBoundaryLabel,
  claimBoundaryCaption,
  isInternalReadinessBoundary,
  isExternalCertificationBoundary,
  dutyClassLabel,
  responsibilityPartyLabel,
  assessmentKindLabel,
  assessmentResultLabel,
  certificationStatusLabel,
  coverageGapLabel,
  type CoverageGapKindKey,
} from './claim-labels.ts';

export type { TenantScope };

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── The coverage view model — a render-ready reduction, NOT recomputed here ──────────────────────

/** One obligation row: an applicable obligation and its coverage posture (covered, or a gap). */
export interface CoverageObligationRowVM {
  readonly obligationId: string;
  readonly clauseRef: string;
  readonly clauseTitle: string;
  readonly dutyClass: DutyClass;
  readonly responsibility: ResponsibilityParty;
  readonly covered: boolean;
  /** The mapped control id; '' when the obligation is unmapped. */
  readonly controlId: string;
  /** 'designed' | 'deficient' | 'unknown'. */
  readonly designState: string;
  /** 'operating' | 'not_operating' | 'unknown'. */
  readonly operatingState: string;
  /** 'sufficient' | 'stale' | 'insufficient' | 'none'. */
  readonly evidenceSufficiency: string;
  /** The latest evidence id; '' when none. */
  readonly latestEvidenceId: string;
  /** The latest evidence ISO instant; '' when none. */
  readonly latestEvidenceAtIso: string;
  /** '' when covered, else a CoverageGapKindKey describing why the obligation is a gap. */
  readonly gapKind: string;
}

/** One assessment row: an internal-readiness / internal-audit / external assessment and its result. */
export interface CoverageAssessmentRowVM {
  readonly assessmentId: string;
  readonly kind: AssessmentKind;
  readonly result: AssessmentResult;
  readonly assessedAtIso: string;
}

/** The single external certification (if any) known for this scope. */
export interface CoverageCertificationVM {
  readonly certificateId: string;
  readonly issuer: string;
  readonly status: CertificationStatus;
  readonly validFromIso: string;
  readonly validUntilIso: string;
  /** Whether the certification is in-window AND valid at the view instant. */
  readonly displayable: boolean;
  readonly verificationUri: string;
}

/** The whole coverage model: the claim boundary + obligation rows + assessments + certification. */
export interface CoverageViewModel {
  readonly scopeLabel: string;
  readonly claimBoundary: ClaimBoundary;
  readonly obligations: readonly CoverageObligationRowVM[];
  readonly assessments: readonly CoverageAssessmentRowVM[];
  /** The single external certification, or null when none exists. */
  readonly certification: CoverageCertificationVM | null;
  readonly obligationCount: number;
  readonly coveredCount: number;
  readonly complete: boolean;
  readonly generatedAtIso: string;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  /** The projection snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed coverage view CANNOT masquerade as certified or complete. */
export const EMPTY_COVERAGE_VIEW: CoverageViewModel = {
  scopeLabel: '',
  // No coverage read ⇒ the claim is INCOMPLETE, never falsely certified.
  claimBoundary: 'incomplete',
  obligations: [],
  assessments: [],
  certification: null,
  obligationCount: 0,
  coveredCount: 0,
  complete: false,
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  freshness: 'unknown',
  snapshotDigest: 'empty',
} as const;

export interface CoverageViewProps {
  readonly tenant: TenantScope;
  readonly model: CoverageViewModel;
}

// ── The claim-boundary banner — where the CARDINAL anti-lie is rendered (FR-055 / SC-012) ─────────

function claimBoundaryBanner(m: CoverageViewModel): string {
  const b = m.claimBoundary;
  const label = claimBoundaryLabel(b);
  const caption = claimBoundaryCaption(b);
  const isInternalReadiness = isInternalReadinessBoundary(b);
  const isExternalCertification = isExternalCertificationBoundary(b);
  // A displayable certification is the ONLY thing that may read as external certification.
  const hasDisplayableCert = m.certification !== null && m.certification.displayable;
  // When the boundary is not `certified`, state — verbatim — that internal readiness is NOT external
  // certification. This note is load-bearing: it makes the "not certified" fact readable, not implied.
  const notCertifiedNote =
    b !== 'certified'
      ? `
        <p data-testid="not-certified-note">
          Internal readiness is not represented as external certification.
        </p>`
      : '';
  return `
      <section
        id="region-claim-boundary"
        aria-labelledby="claim-boundary-h"
        data-testid="claim-boundary"
        data-claim-boundary="${esc(b)}"
        data-is-internal-readiness="${isInternalReadiness ? 'true' : 'false'}"
        data-is-external-certification="${isExternalCertification ? 'true' : 'false'}"
        data-has-displayable-certification="${hasDisplayableCert ? 'true' : 'false'}"
        tabindex="-1"
      >
        <h2 id="claim-boundary-h">Claim boundary</h2>
        <p data-testid="claim-boundary-label" data-boundary="${esc(b)}">
          <strong>${esc(label.label)}</strong>
        </p>
        <p data-testid="claim-boundary-explanation">${esc(label.explanation)}</p>
        <p data-testid="claim-boundary-caption">${esc(caption)}</p>${notCertifiedNote}
      </section>`;
}

// ── The obligation table — every gap surfaced; stale evidence is a GAP, never "operating" ─────────

function gapCell(r: CoverageObligationRowVM): string {
  if (r.covered) {
    return '<span data-testid="coverage-covered" data-covered="true">covered by an operating control with current evidence</span>';
  }
  const key = r.gapKind as CoverageGapKindKey;
  const gap = coverageGapLabel(key);
  return `<strong class="warn" data-testid="coverage-gap" data-gap-kind="${esc(r.gapKind)}">${esc(
    gap.label,
  )} — ${esc(gap.explanation)}</strong>`;
}

function evidenceCell(r: CoverageObligationRowVM): string {
  if (r.latestEvidenceId === '') {
    return '<span data-testid="row-no-evidence" data-evidence="none">no evidence recorded</span>';
  }
  return `<span data-testid="row-evidence" data-evidence-id="${esc(r.latestEvidenceId)}">evidence <code>${esc(
    r.latestEvidenceId,
  )}</code> at <time datetime="${esc(r.latestEvidenceAtIso)}">${esc(r.latestEvidenceAtIso)}</time></span>`;
}

function obligationRow(r: CoverageObligationRowVM): string {
  const duty = dutyClassLabel(r.dutyClass);
  const party = responsibilityPartyLabel(r.responsibility);
  const control =
    r.controlId === ''
      ? '<span data-testid="row-no-control" data-control-id="">no control mapped</span>'
      : `<code data-testid="row-control-id">${esc(r.controlId)}</code>`;
  return `
        <tr
          data-testid="coverage-row"
          data-obligation-id="${esc(r.obligationId)}"
          data-covered="${r.covered ? 'true' : 'false'}"
          data-gap-kind="${esc(r.gapKind)}"
          data-duty-class="${esc(r.dutyClass)}"
          data-responsibility="${esc(r.responsibility)}"
          data-design-state="${esc(r.designState)}"
          data-operating-state="${esc(r.operatingState)}"
          data-evidence-sufficiency="${esc(r.evidenceSufficiency)}"
        >
          <th scope="row">
            <span data-testid="row-clause-ref"><code>${esc(r.clauseRef)}</code></span>
            <span data-testid="row-clause-title">${esc(r.clauseTitle)}</span>
          </th>
          <td data-testid="row-duty-class">${esc(duty.label)} — ${esc(duty.explanation)}</td>
          <td data-testid="row-responsibility">${esc(party.label)} — ${esc(party.explanation)}</td>
          <td data-testid="row-control">${control}</td>
          <td data-testid="row-design-state">${esc(r.designState)}</td>
          <td data-testid="row-operating-state">${esc(r.operatingState)}</td>
          <td data-testid="row-evidence-cell">${evidenceCell(r)} (${esc(r.evidenceSufficiency)})</td>
          <td data-testid="row-coverage-cell">${gapCell(r)}</td>
        </tr>`;
}

function obligationsRegion(m: CoverageViewModel): string {
  const rows = m.obligations.map(obligationRow).join('');
  const gaps = m.obligations.filter((r) => !r.covered).length;
  const empty =
    m.obligations.length === 0
      ? '<p data-testid="no-obligations">No applicable obligations are recorded for this scope.</p>'
      : '';
  return `
      <section id="region-obligations" aria-labelledby="obligations-h" data-testid="obligations" tabindex="-1">
        <h2 id="obligations-h">Obligation coverage</h2>
        <p id="obligations-summary" data-testid="obligations-summary" data-covered="${m.coveredCount}" data-total="${m.obligationCount}" data-gaps="${gaps}">
          ${m.coveredCount} of ${m.obligationCount} applicable obligation(s) are covered by an operating
          control with current evidence (${gaps} gap(s)). An uncovered obligation surfaces its exact
          gap reason. Stale evidence is a gap — current operation is NEVER inferred from stale evidence.
        </p>
        ${empty}
        <table aria-describedby="obligations-summary">
          <caption>Applicable obligations (clause, duty class, responsibility, mapped control, design state, operating state, evidence, coverage or gap)</caption>
          <thead>
            <tr>
              <th scope="col">Clause</th>
              <th scope="col">Duty class</th>
              <th scope="col">Responsibility</th>
              <th scope="col">Mapped control</th>
              <th scope="col">Design state</th>
              <th scope="col">Operating state</th>
              <th scope="col">Evidence</th>
              <th scope="col">Coverage / gap</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── The assessments table — an internal assessment is NOT external certification ──────────────────

function assessmentRow(a: CoverageAssessmentRowVM): string {
  const kind = assessmentKindLabel(a.kind);
  const result = assessmentResultLabel(a.result);
  const isInternal = a.kind === 'internal_readiness' || a.kind === 'internal_audit';
  const honesty = isInternal
    ? '<span data-testid="assessment-not-certification" data-internal="true"> This is internal assurance — it is NOT an external assessment, accreditation, or certification.</span>'
    : '';
  return `
        <tr
          data-testid="assessment-row"
          data-assessment-id="${esc(a.assessmentId)}"
          data-assessment-kind="${esc(a.kind)}"
          data-assessment-result="${esc(a.result)}"
          data-internal="${isInternal ? 'true' : 'false'}"
        >
          <th scope="row" data-testid="assessment-kind">${esc(kind.label)}</th>
          <td data-testid="assessment-kind-explanation">${esc(kind.explanation)}${honesty}</td>
          <td data-testid="assessment-result">${esc(result.label)} — ${esc(result.explanation)}</td>
          <td><time datetime="${esc(a.assessedAtIso)}">${esc(a.assessedAtIso)}</time></td>
        </tr>`;
}

function assessmentsRegion(m: CoverageViewModel): string {
  const rows = m.assessments.map(assessmentRow).join('');
  const empty =
    m.assessments.length === 0
      ? '<p data-testid="no-assessments">No assessments are recorded for this scope.</p>'
      : '';
  return `
      <section id="region-assessments" aria-labelledby="assessments-h" data-testid="assessments" tabindex="-1">
        <h2 id="assessments-h">Assessments</h2>
        <p id="assessments-summary" data-testid="assessments-summary" data-count="${m.assessments.length}">
          ${m.assessments.length} assessment(s). An internal readiness or internal audit result is
          internal assurance only — it is never presented as an external assessment or certification.
        </p>
        ${empty}
        <table aria-describedby="assessments-summary">
          <caption>Assessments (kind, meaning, result, date)</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">What it means</th>
              <th scope="col">Result</th>
              <th scope="col">Assessed</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── The certification block — rendered ONLY when a certification exists; else stated as absent ─────

function certificationRegion(m: CoverageViewModel): string {
  const c = m.certification;
  if (c === null) {
    return `
      <section id="region-certification" aria-labelledby="certification-h" data-testid="no-certification" tabindex="-1">
        <h2 id="certification-h">External certification</h2>
        <p data-testid="no-certification-note" data-has-certification="false">
          No external certification exists for this scope. Internal readiness is not represented as
          external certification.
        </p>
      </section>`;
  }
  const status = certificationStatusLabel(c.status);
  return `
      <section
        id="region-certification"
        aria-labelledby="certification-h"
        data-testid="certification"
        data-certificate-id="${esc(c.certificateId)}"
        data-status="${esc(c.status)}"
        data-displayable="${c.displayable ? 'true' : 'false'}"
        tabindex="-1"
      >
        <h2 id="certification-h">External certification</h2>
        <p data-testid="certification-status">
          <strong>${esc(status.label)}</strong> — ${esc(status.explanation)}
        </p>
        <p data-testid="certification-issuer">Issued by ${esc(c.issuer)} (certificate <code>${esc(c.certificateId)}</code>).</p>
        <p data-testid="certification-window">
          Valid from <time datetime="${esc(c.validFromIso)}" data-testid="certification-valid-from">${esc(c.validFromIso)}</time>
          until <time datetime="${esc(c.validUntilIso)}" data-testid="certification-valid-until">${esc(c.validUntilIso)}</time>.
        </p>
        <p data-testid="certification-displayable-note">
          ${
            c.displayable
              ? 'This certification is in-window and valid at the view instant.'
              : 'This certification is NOT currently displayable as valid — it is out of window, suspended, withdrawn, or expired, and must not be read as a current external certification.'
          }
        </p>
        <p><a href="${esc(c.verificationUri)}" data-testid="certification-verification-link" rel="noopener">Verify this certification independently</a>.</p>
      </section>`;
}

// ── Metadata region — freshness + digest witness; a fail-visible action when not current ──────────

function metadataRegion(m: CoverageViewModel): string {
  const notCurrent = m.freshness !== 'current';
  return `
      <section id="region-coverage-metadata" aria-labelledby="coverage-md-h" data-testid="coverage-metadata" tabindex="-1"
        data-freshness="${esc(m.freshness)}" data-snapshot-digest="${esc(m.snapshotDigest)}">
        <h2 id="coverage-md-h" class="visually-hidden">Coverage freshness</h2>
        <p data-testid="coverage-freshness">
          Coverage generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>.
          Freshness: <strong data-testid="coverage-freshness-value">${esc(m.freshness)}</strong>.
          Snapshot digest <code data-testid="coverage-snapshot-digest">${esc(m.snapshotDigest)}</code>.
        </p>
        ${
          notCurrent
            ? `<p role="alert" data-testid="coverage-safe-next-action">Coverage is not current (${esc(
                m.freshness,
              )}). Refresh the projection before relying on this view; current compliance is not inferred from non-current data.</p>`
            : ''
        }
      </section>`;
}

// ── Chrome ───────────────────────────────────────────────────────────────────────────────────────

function tenantScopeBanner(tenant: TenantScope, scopeLabel: string): string {
  return `
      <section
        aria-labelledby="scope-h"
        data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}"
        data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}"
        data-work-item-id="${esc(tenant.workItemId)}"
        data-role="compliance-officer"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Compliance scope</dt><dd data-testid="scope-label">${esc(scopeLabel === '' ? '—' : scopeLabel)}</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">compliance officer</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const COVERAGE_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; } dd { margin: 0; }
    .warn { display: inline-block; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible COMPLIANCE COVERAGE VIEW as a standalone HTML document, PRESENTING
 * the injected `props.model`. Mounted in-browser via `page.setContent(renderCoverageView(props))`.
 * Single-column and wrapping, with a visible focus indicator. The claim-boundary banner NEVER
 * promotes internal readiness to external certification (FR-055 / SC-012).
 */
export function renderCoverageView(props: CoverageViewProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} compliance coverage</title>
  <style>${COVERAGE_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="coverage-title">${esc(tenant.tenantName)} — compliance coverage &amp; audit readiness</h1>
    ${tenantScopeBanner(tenant, m.scopeLabel)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(claimBoundaryLabel(m.claimBoundary).label)}: ${m.coveredCount} of ${m.obligationCount} obligation(s) covered.</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="coverage-main" data-role="compliance-officer" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${claimBoundaryBanner(m)}
    <p data-testid="coverage-summary" data-covered="${m.coveredCount}" data-total="${m.obligationCount}" data-complete="${m.complete ? 'true' : 'false'}">
      ${m.coveredCount} of ${m.obligationCount} applicable obligation(s) covered; coverage is
      ${m.complete ? 'complete' : 'incomplete'}.
    </p>
    ${obligationsRegion(m)}
    ${assessmentsRegion(m)}
    ${certificationRegion(m)}
    ${metadataRegion(m)}
  </main>
  <footer>
    <p data-testid="coverage-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · compliance coverage &amp; audit readiness.</p>
  </footer>
</body>
</html>`;
}

export default renderCoverageView;
