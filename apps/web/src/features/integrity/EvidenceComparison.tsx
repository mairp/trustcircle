// TrustCircleAI — accessible ORIGINAL-vs-CURRENT EVIDENCE COMPARISON (Phase 5 / User Story 3 / T145 /
// apps/web/src/features/integrity/EvidenceComparison.tsx / FR-017, FR-019, FR-020, SC-007).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The reviewer-facing PRESERVED-ORIGINAL comparison: for one integrity case it shows, side by side,
// the IMMUTABLE preserved original (captured BEFORE any repair touched the work — FR-017) against the
// current/quarantined state and any proposed-or-applied repair, so a reviewer can see EXACTLY what a
// repair changed, confirm the original was preserved unaltered, and confirm quarantine actually
// contains the damaged effect. It answers "was the original kept safe, and what precisely differs?"
// as a PURE PRESENTER over an already-diffed model.
//
// THE DIFF + THE PRESERVATION VERDICT ARE NOT COMPUTED HERE. The `original` digest, the `current`
// digest, each field-level `changeKind`, and the load-bearing `originalIntact` / `quarantineContains`
// verdicts come from the REAL @trustcircle/evidence + @trustcircle/domain surfaces. This view renders
// the injected comparison verbatim; it re-hashes nothing and, crucially, INVENTS NO POSITIVE
// PRESERVATION VERDICT — an un-fed comparison reports "preservation NOT confirmed", never "intact".
//
// PRESERVATION IS STATED, NOT IMPLIED BY LAYOUT. Whether the original is byte-identical to what was
// captured is a TEXT statement with a machine-readable `data-original-intact`, plus the two digests
// shown verbatim so the assertion is independently checkable. If the original was somehow mutated, the
// view says so loudly (a `role=alert`) — a tampered original can never be presented as safe.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Each diff row states its change kind (added /
// removed / changed / unchanged) as a word and a `data-change-kind`, never by color alone. The
// quarantine-containment banner and the preservation banner are sentences, not swatches.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — pure string-builder presenters. The output is a self-contained
// HTML string the e2e spec mounts via `page.setContent(renderEvidenceComparison(props))` and asserts
// through axe-core + the live accessibility tree, with no web server, no React, no tenant-auth.
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

// ── The comparison view model ─────────────────────────────────────────────────────────────────

/** One side of the comparison — a snapshot of the work at a point in the case timeline. */
export interface EvidenceSnapshotVM {
  readonly label: string;
  readonly evidenceId: string;
  /** The content digest — the value the preservation/containment claims are checked against. */
  readonly contentDigest: string;
  readonly capturedAtIso: string;
  /** True iff this snapshot is quarantined (contained). */
  readonly quarantined: boolean;
  /** A short, human-readable provenance note (who/what captured it). */
  readonly provenance: string;
}

export type EvidenceChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** One field-level difference row between original and current. */
export interface EvidenceDiffRowVM {
  readonly field: string;
  readonly changeKind: EvidenceChangeKind;
  readonly originalValue: string;
  readonly currentValue: string;
  /** True iff this field is safety-relevant (surfaced with an explicit textual marker). */
  readonly safetyRelevant: boolean;
}

/** The whole comparison: two snapshots + the field-level diff + the load-bearing verdicts. */
export interface EvidenceComparisonModel {
  readonly caseId: string;
  readonly workItemId: string;
  readonly problemClass: string;
  readonly original: EvidenceSnapshotVM;
  readonly current: EvidenceSnapshotVM;
  readonly rows: readonly EvidenceDiffRowVM[];
  /** AUTHORITATIVE — the preserved original is byte-identical to what was captured (FR-017). */
  readonly originalIntact: boolean;
  /** The independent recomputed digest of the preserved original (the intactness witness). */
  readonly originalVerifyDigest: string;
  /** AUTHORITATIVE — the quarantine currently contains the damaged effect (FR-019). */
  readonly quarantineContains: boolean;
  /** The capabilities the quarantine currently blocks (empty ⇒ nothing contained). */
  readonly blockedCapabilities: readonly string[];
  /** True iff a repair has been applied to `current` (vs merely proposed). */
  readonly repairApplied: boolean;
  /** A non-color-only one-sentence summary of the comparison (WCAG 1.4.1). */
  readonly summary: string;
}

/** An EMPTY-but-valid model — an un-fed comparison CANNOT masquerade as a confirmed-intact one. */
export const EMPTY_EVIDENCE_COMPARISON: EvidenceComparisonModel = {
  caseId: '',
  workItemId: '',
  problemClass: 'unknown',
  original: {
    label: 'preserved original',
    evidenceId: '',
    contentDigest: 'none',
    capturedAtIso: '1970-01-01T00:00:00.000Z',
    quarantined: false,
    provenance: 'no preserved original loaded',
  },
  current: {
    label: 'current state',
    evidenceId: '',
    contentDigest: 'none',
    capturedAtIso: '1970-01-01T00:00:00.000Z',
    quarantined: false,
    provenance: 'no current state loaded',
  },
  rows: [],
  // No comparison loaded ⇒ preservation is NOT confirmed, and containment is NOT asserted.
  originalIntact: false,
  originalVerifyDigest: 'none',
  quarantineContains: false,
  blockedCapabilities: [],
  repairApplied: false,
  summary: 'No evidence comparison is loaded; original preservation is NOT confirmed.',
} as const;

export interface EvidenceComparisonProps {
  readonly tenant: TenantScope;
  readonly model: EvidenceComparisonModel;
}

// ── Preservation + containment banners (the load-bearing statements) ───────────────────────────

function preservationBanner(m: EvidenceComparisonModel): string {
  const match = m.original.contentDigest === m.originalVerifyDigest;
  if (m.originalIntact && match) {
    return `
        <p data-testid="preservation-banner" data-original-intact="true" role="status">
          <strong>Original PRESERVED and intact.</strong> The preserved original
          (<code data-testid="preservation-captured-digest">${esc(m.original.contentDigest)}</code>) is
          byte-identical to an independent re-hash
          (<code data-testid="preservation-verify-digest">${esc(m.originalVerifyDigest)}</code>).
          No repair altered the captured original.
        </p>`;
  }
  return `
        <p data-testid="preservation-banner" data-original-intact="false" role="alert">
          <strong>Original preservation NOT confirmed.</strong> The captured digest
          (<code data-testid="preservation-captured-digest">${esc(m.original.contentDigest)}</code>)
          ${match ? 'is present but the case does not assert intactness' : 'does NOT match an independent re-hash'}
          (<code data-testid="preservation-verify-digest">${esc(m.originalVerifyDigest)}</code>).
          Treat the original as unverified and escalate before any repair.
        </p>`;
}

function containmentBanner(m: EvidenceComparisonModel): string {
  if (m.quarantineContains) {
    const blocked =
      m.blockedCapabilities.length > 0 ? esc(m.blockedCapabilities.join(', ')) : 'all governed use';
    return `
        <p data-testid="containment-banner" data-quarantine-contains="true" role="status"
           data-blocked="${esc(m.blockedCapabilities.join(' '))}">
          <strong>Damaged effect CONTAINED.</strong> Quarantine currently blocks: ${blocked}. The
          damaged current state cannot be used through governed paths while contained.
        </p>`;
  }
  return `
        <p data-testid="containment-banner" data-quarantine-contains="false" role="alert">
          <strong>Damaged effect NOT contained.</strong> No active quarantine is blocking the damaged
          current state; it may still be reachable through governed paths. Escalate to contain it.
        </p>`;
}

// ── Snapshot cards ─────────────────────────────────────────────────────────────────────────────

function snapshotCard(side: 'original' | 'current', s: EvidenceSnapshotVM): string {
  return `
        <article
          class="snapshot"
          data-testid="evidence-snapshot"
          data-side="${side}"
          data-evidence-id="${esc(s.evidenceId)}"
          data-digest="${esc(s.contentDigest)}"
          data-quarantined="${s.quarantined ? 'true' : 'false'}"
          aria-labelledby="snap-${side}-h"
        >
          <h3 id="snap-${side}-h" data-testid="snapshot-label">${esc(s.label)}</h3>
          <dl>
            <div class="kv"><dt>Evidence id</dt><dd><code data-testid="snapshot-evidence-id">${esc(s.evidenceId)}</code></dd></div>
            <div class="kv"><dt>Content digest</dt><dd><code data-testid="snapshot-digest">${esc(s.contentDigest)}</code></dd></div>
            <div class="kv"><dt>Captured</dt><dd><time datetime="${esc(s.capturedAtIso)}" data-testid="snapshot-captured">${esc(s.capturedAtIso)}</time></dd></div>
            <div class="kv"><dt>Provenance</dt><dd data-testid="snapshot-provenance">${esc(s.provenance)}</dd></div>
            <div class="kv"><dt>Quarantine</dt><dd data-testid="snapshot-quarantine">${s.quarantined ? 'quarantined (contained)' : 'not quarantined'}</dd></div>
          </dl>
        </article>`;
}

// ── Diff table ───────────────────────────────────────────────────────────────────────────────────

function changeKindWord(kind: EvidenceChangeKind): string {
  switch (kind) {
    case 'added':
      return 'added (present now, absent in original)';
    case 'removed':
      return 'removed (present in original, absent now)';
    case 'changed':
      return 'changed';
    case 'unchanged':
      return 'unchanged';
    default:
      return 'unknown';
  }
}

function diffRow(r: EvidenceDiffRowVM): string {
  return `
          <tr
            data-testid="diff-row"
            data-field="${esc(r.field)}"
            data-change-kind="${esc(r.changeKind)}"
            data-safety-relevant="${r.safetyRelevant ? 'true' : 'false'}"
          >
            <th scope="row" data-testid="diff-field">${esc(r.field)}${
              r.safetyRelevant
                ? ' <strong class="warn" data-testid="diff-safety">(safety-relevant)</strong>'
                : ''
            }</th>
            <td data-testid="diff-change-kind">${esc(changeKindWord(r.changeKind))}</td>
            <td data-testid="diff-original"><code>${esc(r.originalValue)}</code></td>
            <td data-testid="diff-current"><code>${esc(r.currentValue)}</code></td>
          </tr>`;
}

function diffRegion(m: EvidenceComparisonModel): string {
  const changed = m.rows.filter((r) => r.changeKind !== 'unchanged').length;
  const rows =
    m.rows.length > 0
      ? m.rows.map(diffRow).join('')
      : `<tr data-testid="diff-empty-row"><td colspan="4">No field-level differences are loaded for this comparison.</td></tr>`;
  return `
      <section id="region-diff" aria-labelledby="diff-h" data-testid="evidence-diff" tabindex="-1"
        data-changed-count="${changed}" data-total-fields="${m.rows.length}">
        <h2 id="diff-h">What the repair changed</h2>
        <p id="diff-summary" data-testid="diff-summary">
          ${changed} of ${m.rows.length} field(s) differ between the preserved original and the current
          state. Change kind is shown as a word in each row (not by color alone). The repair is
          ${m.repairApplied ? 'APPLIED to the current state' : 'PROPOSED only — not yet applied'}.
        </p>
        <table aria-describedby="diff-summary">
          <caption>Field-level differences: original vs current</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Change</th>
              <th scope="col">Original value</th>
              <th scope="col">Current value</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
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
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="kv"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="kv"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="kv"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

const COMPARE_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div, article { max-width: 100%; }
    section { margin: 0 0 1.5rem; }
    .snapshots { display: flex; flex-wrap: wrap; gap: 1rem; }
    .snapshot { flex: 1 1 18rem; border: 1px solid #999; padding: .5rem .75rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; } .kv { display: flex; flex-direction: column; margin-bottom: .35rem; }
    dt { font-weight: 600; } dd { margin: 0; }
    .warn { display: inline-block; }
    a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }`;

/**
 * Render the complete accessible ORIGINAL-vs-CURRENT comparison as a standalone HTML document,
 * PRESENTING the injected `props.model`. Mounted in-browser via
 * `page.setContent(renderEvidenceComparison(props))`. Single-column and wrapping.
 */
export function renderEvidenceComparison(props: EvidenceComparisonProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — evidence comparison for case ${esc(m.caseId)}</title>
  <style>${COMPARE_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="compare-title">Evidence comparison — case ${esc(m.caseId)}</h1>
    <p data-testid="compare-subtitle">Work item <code>${esc(m.workItemId)}</code> · problem class <strong>${esc(m.problemClass)}</strong></p>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(m.summary)}</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="compare-main"
        data-original-intact="${m.originalIntact ? 'true' : 'false'}"
        data-quarantine-contains="${m.quarantineContains ? 'true' : 'false'}"
        data-repair-applied="${m.repairApplied ? 'true' : 'false'}">
    <section id="region-verdicts" aria-labelledby="verdicts-h" data-testid="evidence-verdicts" tabindex="-1">
      <h2 id="verdicts-h">Preservation &amp; containment</h2>
      ${preservationBanner(m)}
      ${containmentBanner(m)}
    </section>
    <section id="region-snapshots" aria-labelledby="snapshots-h" data-testid="evidence-snapshots" tabindex="-1">
      <h2 id="snapshots-h">Original vs current</h2>
      <div class="snapshots">
        ${snapshotCard('original', m.original)}
        ${snapshotCard('current', m.current)}
      </div>
    </section>
    ${diffRegion(m)}
  </main>
  <footer>
    <p data-testid="compare-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · preserved-original comparison.</p>
  </footer>
</body>
</html>`;
}

export default renderEvidenceComparison;
