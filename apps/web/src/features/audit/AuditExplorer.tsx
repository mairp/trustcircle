// TrustCircleAI — accessible AUDITOR AUDIT EXPLORER (Phase 18 / T214 /
// apps/web/src/features/audit/AuditExplorer.tsx / FR-034, FR-035, FR-056, SC-013, SC-022).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The auditor-facing AUDIT EXPLORER: the single surface an external or internal auditor uses to
// reconstruct exactly what happened over an exact scope and instant. It answers the auditor's
// questions — "for THIS scope over THIS exact period, reconstructed AT THIS exact instant against
// THIS ledger checkpoint (SC-013), what decisions were made, how do obligations map to controls,
// what findings and their gap kinds are open, what remediation is owed, what did each export
// operation produce (signed manifest, gap count — SC-022), and which obligations remain explicit
// GAPS?" — as a PURE PRESENTER over an already-reconstructed audit model.
//
// THE TRACE, DECISIONS, MAPPINGS, FINDINGS, REMEDIATIONS, EXPORTS, AND GAPS ARE NOT COMPUTED HERE.
// Every field is a projection of a value the audit-reconstruction service ALREADY produced against
// the pinned ledger checkpoint. This presenter renders those rows verbatim in order; it re-derives
// no verdict, hides no gap, and never represents an internal readiness result as external
// conformity or certification (FR-056). Gaps are ALWAYS visible — never masked as covered (SC-022).
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every row states its result/state/severity/
// status in words, with machine-readable data attributes, and a completed-but-unsigned export
// surfaces an explicit `role="alert"`. A live `role="status"` region counts decisions/findings/
// gaps/exports.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — they are pure string-builder presenters (tsconfig `jsx:preserve`
// only satisfies the extension resolver). The output is a self-contained HTML string the e2e spec
// mounts via `page.setContent(renderAuditExplorer(props))` and asserts through axe-core + the live
// accessibility tree, with NO web server, NO React, NO tenant-auth.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no
// network, no module-level mutable state — same props ⇒ byte-identical output.

import type { TenantScope } from '../../app/layout.tsx';

export type { TenantScope };

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── The audit-explorer view model — the render-ready reduction of the reconstruction service ──────

/**
 * The TIME/SCOPE TRACE: the exact period + the exact instant coverage was reconstructed AT, pinned
 * to the audit-ledger checkpoint the reconstruction touched (SC-013). This is the reconstruct-at-
 * instant witness — same scope, same instant, same checkpoint ⇒ same trace.
 */
export interface AuditScopeTraceVM {
  readonly scopeLabel: string;
  readonly fromIso: string; // exact period start
  readonly toIso: string; // exact period end
  readonly reconstructedAtIso: string; // the instant coverage was reconstructed AT (SC-013)
  readonly ledgerCheckpointDigest: string; // sha256:... the audit-ledger checkpoint the trace pins
  readonly referenceCount: number; // how many references the reconstruction touched
}

/** One decision row in the reconstructed decision log (preserved in order). */
export interface AuditDecisionRowVM {
  readonly decisionId: string;
  readonly clauseRef: string;
  readonly result: string;
  readonly state: string;
  readonly atIso: string;
}

/** One obligation→control mapping row (responsibility attribution). */
export interface AuditMappingRowVM {
  readonly mappingId: string;
  readonly obligationId: string;
  readonly controlId: string;
  readonly responsibility: string;
}

/** One finding row; carries the gap kind it represents. */
export interface AuditFindingRowVM {
  readonly findingId: string;
  readonly severity: string;
  readonly statement: string;
  readonly gapKind: string;
  readonly openedAtIso: string;
}

/** One remediation row owed against a finding. */
export interface AuditRemediationRowVM {
  readonly remediationId: string;
  readonly findingId: string;
  readonly status: string;
  readonly ownerPrincipalId: string;
  readonly dueIso: string;
}

/**
 * One export operation record. A `completed` export MUST be `signed===true` with a non-empty
 * `manifestDigest`; an export always reports its gap count (SC-022).
 */
export interface AuditExportRecordVM {
  readonly operationId: string;
  readonly status: string; // 'accepted'|'running'|'completed'|'failed'
  readonly requestedByPrincipalId: string;
  readonly requestedAtIso: string;
  readonly manifestDigest: string; // '' until completed; sha256:... when signed
  readonly signed: boolean;
  readonly gapCount: number; // explicit gaps included in the export
}

/** One explicit obligation gap — ALWAYS visible, never represented as covered (SC-022). */
export interface AuditGapRowVM {
  readonly obligationId: string;
  readonly gapKind: string;
  readonly detail: string;
}

/** The whole audit-explorer model: the trace + every reconstructed table + the digest witness. */
export interface AuditExplorerModel {
  readonly trace: AuditScopeTraceVM;
  readonly decisions: readonly AuditDecisionRowVM[];
  readonly mappings: readonly AuditMappingRowVM[];
  readonly findings: readonly AuditFindingRowVM[];
  readonly remediations: readonly AuditRemediationRowVM[];
  readonly exports: readonly AuditExportRecordVM[];
  readonly gaps: readonly AuditGapRowVM[];
  readonly generatedAtIso: string;
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed explorer CANNOT masquerade as a reconstructed, gap-free one. */
export const EMPTY_AUDIT_EXPLORER: AuditExplorerModel = {
  trace: {
    scopeLabel: '',
    fromIso: '1970-01-01T00:00:00.000Z',
    toIso: '1970-01-01T00:00:00.000Z',
    reconstructedAtIso: '1970-01-01T00:00:00.000Z',
    ledgerCheckpointDigest: 'empty',
    referenceCount: 0,
  },
  decisions: [],
  mappings: [],
  findings: [],
  remediations: [],
  exports: [],
  gaps: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface AuditExplorerProps {
  readonly tenant: TenantScope;
  readonly model: AuditExplorerModel;
}

// The CHECKPOINT CONSTRAINT — rendered verbatim so no internal readiness result is ever represented
// as conformity, accreditation, or external certification (FR-056).
const NO_EXTERNAL_CLAIM =
  'No mapping, artifact, or internal readiness result is represented as conformity, accreditation, or external certification.';

// ── The time/scope trace region (SC-013 reconstruct-at-instant witness) ───────────────────────────

function traceRegion(t: AuditScopeTraceVM): string {
  return `
      <section
        id="region-audit-trace"
        aria-labelledby="trace-h"
        data-testid="audit-trace"
        data-scope-label="${esc(t.scopeLabel)}"
        data-from="${esc(t.fromIso)}"
        data-to="${esc(t.toIso)}"
        data-reconstructed-at="${esc(t.reconstructedAtIso)}"
        data-ledger-checkpoint="${esc(t.ledgerCheckpointDigest)}"
        data-reference-count="${t.referenceCount}"
        tabindex="-1"
      >
        <h2 id="trace-h">Reconstructed scope &amp; instant trace</h2>
        <p data-testid="audit-trace-statement">Coverage reconstructed for an exact scope and instant.</p>
        <dl>
          <div class="scope-row"><dt>Scope</dt><dd data-testid="trace-scope-label">${esc(t.scopeLabel)}</dd></div>
          <div class="scope-row">
            <dt>Exact period</dt>
            <dd data-testid="trace-period">
              from <time datetime="${esc(t.fromIso)}" data-testid="trace-from">${esc(t.fromIso)}</time>
              to <time datetime="${esc(t.toIso)}" data-testid="trace-to">${esc(t.toIso)}</time>
            </dd>
          </div>
          <div class="scope-row">
            <dt>Reconstructed at instant</dt>
            <dd><time datetime="${esc(t.reconstructedAtIso)}" data-testid="trace-reconstructed-at">${esc(t.reconstructedAtIso)}</time></dd>
          </div>
          <div class="scope-row">
            <dt>Ledger checkpoint</dt>
            <dd data-testid="trace-ledger-checkpoint"><code>${esc(t.ledgerCheckpointDigest)}</code></dd>
          </div>
          <div class="scope-row">
            <dt>References touched</dt>
            <dd data-testid="trace-reference-count">${t.referenceCount}</dd>
          </div>
        </dl>
        <p data-testid="no-external-claim-note">${esc(NO_EXTERNAL_CLAIM)}</p>
      </section>`;
}

// ── Reconstructed decision log ────────────────────────────────────────────────────────────────────

function decisionsRegion(rows: readonly AuditDecisionRowVM[]): string {
  const body = rows
    .map(
      (r) => `
        <tr
          data-testid="audit-decision"
          data-decision-id="${esc(r.decisionId)}"
          data-result="${esc(r.result)}"
          data-state="${esc(r.state)}"
        >
          <th scope="row"><code>${esc(r.decisionId)}</code></th>
          <td data-testid="decision-clause"><code>${esc(r.clauseRef)}</code></td>
          <td data-testid="decision-result">${esc(r.result)}</td>
          <td data-testid="decision-state">${esc(r.state)}</td>
          <td><time datetime="${esc(r.atIso)}">${esc(r.atIso)}</time></td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-audit-decisions" aria-labelledby="dec-h" data-testid="audit-decisions" tabindex="-1">
        <h2 id="dec-h">Decisions</h2>
        <p data-testid="decisions-count" data-count="${rows.length}">${rows.length} reconstructed decision(s), in order.</p>
        <table>
          <caption>Reconstructed decisions (clause, result, state, instant)</caption>
          <thead>
            <tr>
              <th scope="col">Decision</th>
              <th scope="col">Clause</th>
              <th scope="col">Result</th>
              <th scope="col">State</th>
              <th scope="col">At</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
}

// ── Obligation→control mappings ─────────────────────────────────────────────────────────────────

function mappingsRegion(rows: readonly AuditMappingRowVM[]): string {
  const body = rows
    .map(
      (r) => `
        <tr
          data-testid="audit-mapping"
          data-mapping-id="${esc(r.mappingId)}"
          data-obligation-id="${esc(r.obligationId)}"
          data-control-id="${esc(r.controlId)}"
        >
          <th scope="row"><code>${esc(r.mappingId)}</code></th>
          <td data-testid="mapping-obligation"><code>${esc(r.obligationId)}</code></td>
          <td data-testid="mapping-control"><code>${esc(r.controlId)}</code></td>
          <td data-testid="mapping-responsibility">${esc(r.responsibility)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-audit-mappings" aria-labelledby="map-h" data-testid="audit-mappings" tabindex="-1">
        <h2 id="map-h">Obligation → control mappings</h2>
        <p data-testid="mappings-count" data-count="${rows.length}">${rows.length} mapping(s), in order.</p>
        <table>
          <caption>Obligation-to-control mappings (obligation, control, responsibility)</caption>
          <thead>
            <tr>
              <th scope="col">Mapping</th>
              <th scope="col">Obligation</th>
              <th scope="col">Control</th>
              <th scope="col">Responsibility</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
}

// ── Findings (each carries its gap kind) ──────────────────────────────────────────────────────────

function findingsRegion(rows: readonly AuditFindingRowVM[]): string {
  const body = rows
    .map(
      (r) => `
        <tr
          data-testid="audit-finding"
          data-finding-id="${esc(r.findingId)}"
          data-severity="${esc(r.severity)}"
          data-gap-kind="${esc(r.gapKind)}"
        >
          <th scope="row"><code>${esc(r.findingId)}</code></th>
          <td data-testid="finding-severity">${esc(r.severity)}</td>
          <td data-testid="finding-statement">${esc(r.statement)}</td>
          <td data-testid="finding-gap-kind">${esc(r.gapKind)}</td>
          <td><time datetime="${esc(r.openedAtIso)}">${esc(r.openedAtIso)}</time></td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-audit-findings" aria-labelledby="find-h" data-testid="audit-findings" tabindex="-1">
        <h2 id="find-h">Findings</h2>
        <p data-testid="findings-count" data-count="${rows.length}">${rows.length} finding(s), in order; each carries its gap kind.</p>
        <table>
          <caption>Findings (severity, statement, gap kind, opened instant)</caption>
          <thead>
            <tr>
              <th scope="col">Finding</th>
              <th scope="col">Severity</th>
              <th scope="col">Statement</th>
              <th scope="col">Gap kind</th>
              <th scope="col">Opened</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
}

// ── Remediations ─────────────────────────────────────────────────────────────────────────────────

function remediationsRegion(rows: readonly AuditRemediationRowVM[]): string {
  const body = rows
    .map(
      (r) => `
        <tr
          data-testid="audit-remediation"
          data-remediation-id="${esc(r.remediationId)}"
          data-finding-id="${esc(r.findingId)}"
          data-status="${esc(r.status)}"
        >
          <th scope="row"><code>${esc(r.remediationId)}</code></th>
          <td data-testid="remediation-finding"><code>${esc(r.findingId)}</code></td>
          <td data-testid="remediation-status">${esc(r.status)}</td>
          <td data-testid="remediation-owner">${esc(r.ownerPrincipalId)}</td>
          <td><time datetime="${esc(r.dueIso)}">${esc(r.dueIso)}</time></td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-audit-remediations" aria-labelledby="rem-h" data-testid="audit-remediations" tabindex="-1">
        <h2 id="rem-h">Remediations</h2>
        <p data-testid="remediations-count" data-count="${rows.length}">${rows.length} remediation(s), in order.</p>
        <table>
          <caption>Remediations owed (finding, status, owner, due instant)</caption>
          <thead>
            <tr>
              <th scope="col">Remediation</th>
              <th scope="col">Finding</th>
              <th scope="col">Status</th>
              <th scope="col">Owner</th>
              <th scope="col">Due</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
}

// ── Exports (a completed export MUST be signed with a non-empty manifest; always reports gaps) ─────

function exportRow(r: AuditExportRecordVM): string {
  const completed = r.status === 'completed';
  const unsignedCompleted = completed && (!r.signed || r.manifestDigest === '');
  const alert = unsignedCompleted
    ? `<p role="alert" data-testid="audit-export-unsigned-alert">A completed export MUST be signed with a manifest digest — this one is not; do NOT treat it as authoritative.</p>`
    : '';
  const manifestCell = completed
    ? `<code data-testid="export-manifest-digest">${esc(r.manifestDigest)}</code>`
    : `<span data-testid="export-no-manifest">no manifest until completed</span>`;
  return `
        <tr
          data-testid="audit-export"
          data-operation-id="${esc(r.operationId)}"
          data-status="${esc(r.status)}"
          data-signed="${r.signed ? 'true' : 'false'}"
          data-gap-count="${r.gapCount}"
        >
          <th scope="row"><code>${esc(r.operationId)}</code></th>
          <td data-testid="export-status">${esc(r.status)}</td>
          <td data-testid="export-requested-by">${esc(r.requestedByPrincipalId)}</td>
          <td><time datetime="${esc(r.requestedAtIso)}">${esc(r.requestedAtIso)}</time></td>
          <td data-testid="export-signed">${r.signed ? 'signed' : 'not signed'}</td>
          <td>${manifestCell}</td>
          <td data-testid="export-gap-count">${r.gapCount} gap(s) included</td>
          <td>${alert || '<span data-testid="export-ok">—</span>'}</td>
        </tr>`;
}

function exportsRegion(rows: readonly AuditExportRecordVM[]): string {
  const body = rows.map(exportRow).join('');
  return `
      <section id="region-audit-exports" aria-labelledby="exp-h" data-testid="audit-exports" tabindex="-1">
        <h2 id="exp-h">Export operations</h2>
        <p data-testid="exports-count" data-count="${rows.length}">
          ${rows.length} export operation(s). A completed export is signed with a manifest digest, and
          every export reports the number of explicit gaps it included.
        </p>
        <table>
          <caption>Export operations (status, requester, requested instant, signed, manifest digest, gap count)</caption>
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Status</th>
              <th scope="col">Requested by</th>
              <th scope="col">Requested</th>
              <th scope="col">Signed</th>
              <th scope="col">Manifest digest</th>
              <th scope="col">Gaps included</th>
              <th scope="col">Alert</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
}

// ── Explicit obligation gaps — ALWAYS visible, never represented as covered (SC-022) ──────────────

function gapsRegion(rows: readonly AuditGapRowVM[]): string {
  const body = rows
    .map(
      (r) => `
        <tr
          data-testid="audit-gap"
          data-obligation-id="${esc(r.obligationId)}"
          data-gap-kind="${esc(r.gapKind)}"
        >
          <th scope="row"><code>${esc(r.obligationId)}</code></th>
          <td data-testid="gap-kind">${esc(r.gapKind)}</td>
          <td data-testid="gap-detail">${esc(r.detail)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-audit-gaps" aria-labelledby="gap-h" data-testid="audit-gaps" tabindex="-1">
        <h2 id="gap-h">Explicit obligation gaps</h2>
        <p data-testid="gaps-count" data-count="${rows.length}">
          ${rows.length} explicit gap(s). Gaps are always shown here — they are never hidden and never
          represented as covered.
        </p>
        <table>
          <caption>Obligation gaps (obligation, gap kind, detail)</caption>
          <thead>
            <tr>
              <th scope="col">Obligation</th>
              <th scope="col">Gap kind</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
}

// ── Metadata ─────────────────────────────────────────────────────────────────────────────────────

function metadataRegion(m: AuditExplorerModel): string {
  return `
      <section id="region-audit-metadata" aria-labelledby="audit-md-h" data-testid="audit-metadata" tabindex="-1"
        data-snapshot-digest="${esc(m.snapshotDigest)}">
        <h2 id="audit-md-h" class="visually-hidden">Reconstruction provenance</h2>
        <p data-testid="audit-generated-at">
          Reconstruction generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>.
          Snapshot digest <code data-testid="audit-snapshot-digest">${esc(m.snapshotDigest)}</code>.
        </p>
      </section>`;
}

// ── Chrome ───────────────────────────────────────────────────────────────────────────────────────

function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section
        aria-labelledby="scope-h"
        data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}"
        data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}"
        data-work-item-id="${esc(tenant.workItemId)}"
        data-role="auditor"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">auditor</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const AUDIT_STYLE = `
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
    [role="alert"] { color: #b3261e; font-weight: 600; margin: .25rem 0; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible AUDITOR AUDIT EXPLORER as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderAuditExplorer(props))`.
 * Single-column and wrapping, with a visible focus indicator.
 *
 * Order: skip link → tenant-scope banner → live status summary → `<main>` framing the trace,
 * decisions, mappings, findings, remediations, exports, gaps, and metadata regions.
 */
export function renderAuditExplorer(props: AuditExplorerProps): string {
  const { tenant } = props;
  const m = props.model;
  const summary = `${m.decisions.length} decision(s), ${m.findings.length} finding(s), ${m.gaps.length} explicit gap(s), and ${m.exports.length} export operation(s) in this reconstruction.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} audit explorer</title>
  <style>${AUDIT_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="audit-title">${esc(tenant.tenantName)} — audit explorer</h1>
    ${tenantScopeBanner(tenant)}
    <div
      id="audit-status"
      role="status"
      aria-live="polite"
      data-testid="audit-status"
      data-decisions="${m.decisions.length}"
      data-findings="${m.findings.length}"
      data-gaps="${m.gaps.length}"
      data-exports="${m.exports.length}"
    >
      <span data-testid="audit-status-text">${esc(summary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="audit-main" data-role="auditor" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${traceRegion(m.trace)}
    ${decisionsRegion(m.decisions)}
    ${mappingsRegion(m.mappings)}
    ${findingsRegion(m.findings)}
    ${remediationsRegion(m.remediations)}
    ${exportsRegion(m.exports)}
    ${gapsRegion(m.gaps)}
    ${metadataRegion(m)}
  </main>
  <footer>
    <p data-testid="audit-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · auditor reconstruction.</p>
  </footer>
</body>
</html>`;
}

export default renderAuditExplorer;
