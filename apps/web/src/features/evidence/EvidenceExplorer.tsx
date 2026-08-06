// TrustCircleAI — accessible EVIDENCE EXPLORER (Phase 18 / User Story / T213 /
// apps/web/src/features/evidence/EvidenceExplorer.tsx / FR-053).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer-facing EVIDENCE EXPLORER: the surface through which an officer inspects an evidence
// envelope's METADATA — its kind, content-type, integrity DIGEST, size, PROVENANCE (where it came
// from, who collected it, when, by what method), its CHAIN OF CUSTODY (the ordered ledger of who
// handled it and how), its RETENTION deadline, and its LEGAL-HOLD posture — as a PURE PRESENTER
// over an already-authorized envelope model.
//
// THE CARDINAL RULE (FR-053). The evidence BODY is a privileged artifact. It is rendered ONLY when
// the querying tenant/role is AUTHORIZED for it (`accessAuthorized === true`). When authorization is
// absent the presenter renders an explicit "body withheld" notice and NEVER emits the `bodyRef` link
// at all — an unauthorized body reference is not merely hidden, it is ABSENT from the DOM, so it
// cannot leak through source, copy-paste, or the accessibility tree. METADATA — digest, provenance,
// custody, retention, hold — is ALWAYS shown; only the body is gated. The `accessAuthorized` verdict
// is NOT computed here; it arrives already decided in the injected model, and this presenter obeys it
// verbatim, widening access for no envelope.
//
// INTEGRITY IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Each envelope surfaces its `digest` and states
// in WORDS whether the digest recomputation matched (verified) or did not (unverified). An unverified
// digest is a tamper signal and is surfaced as a `role="alert"` — never as color alone.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// these `.tsx` files contain NO JSX — they are pure string-builder presenters. The output is a
// self-contained HTML string the e2e spec mounts via `page.setContent(renderEvidenceExplorer(props))`
// and asserts through axe-core + the live accessibility tree, with NO web server, NO React, NO
// tenant-auth.
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

// ── The evidence view model — the render-ready reduction of an authorized envelope ───────────────

/** Where an evidence artifact came from and how it was collected. */
export interface EvidenceProvenanceVM {
  readonly sourceSystem: string;
  readonly collectedByPrincipalId: string;
  readonly collectedAtIso: string;
  readonly method: string;
}

/** One entry in the ordered chain of custody (who handled the evidence, when, how, and why). */
export interface EvidenceCustodyEventVM {
  readonly atIso: string;
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly note: string;
}

/** One evidence envelope: ALWAYS-visible metadata + a body that is gated by `accessAuthorized`. */
export interface EvidenceEnvelopeVM {
  readonly evidenceId: string;
  readonly kind: string;
  readonly contentType: string;
  /** sha256:... integrity digest. */
  readonly digest: string;
  readonly sizeBytes: number;
  readonly provenance: EvidenceProvenanceVM;
  /** Chain of custody, in recorded order (never reordered by the view). */
  readonly custody: readonly EvidenceCustodyEventVM[];
  readonly retentionUntilIso: string;
  readonly legalHold: boolean;
  /** Whether THIS querying tenant/role may see the BODY (the FR-053 gate). */
  readonly accessAuthorized: boolean;
  /** Whether the digest recomputation matched (integrity verified). */
  readonly integrityVerified: boolean;
  /** A link to the body — '' unless `accessAuthorized`; NEVER emitted when unauthorized. */
  readonly bodyRef: string;
}

/** The whole explorer model: the envelopes + generation instant + an independent digest witness. */
export interface EvidenceExplorerModel {
  readonly envelopes: readonly EvidenceEnvelopeVM[];
  readonly generatedAtIso: string;
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed explorer CANNOT masquerade as a set of authorized envelopes. */
export const EMPTY_EVIDENCE_EXPLORER: EvidenceExplorerModel = {
  envelopes: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface EvidenceExplorerProps {
  readonly tenant: TenantScope;
  readonly model: EvidenceExplorerModel;
}

// ── Envelope sub-renderers ──────────────────────────────────────────────────────────────────────

/**
 * The BODY cell — the FR-053 gate. When authorized, a link to the body is emitted. When NOT
 * authorized, a "body withheld" notice is emitted and the `bodyRef` link is ABSENT from the DOM
 * (never leaked through source, copy, or the accessibility tree).
 */
function bodyCell(e: EvidenceEnvelopeVM): string {
  if (e.accessAuthorized) {
    return `
          <div data-testid="body-available" data-access-authorized="true">
            <p>You are authorized to view the evidence body for this envelope.</p>
            <a href="${esc(e.bodyRef)}" data-testid="evidence-body-link" data-body-ref="${esc(e.bodyRef)}">Open evidence body</a>
          </div>`;
  }
  // Unauthorized: state the withholding in words, and DO NOT emit the bodyRef link at all.
  return `
          <div data-testid="body-withheld" data-access-authorized="false">
            <strong class="warn">Body withheld — you are not authorized to view the evidence body for this envelope.</strong>
            <p>Only the metadata below (integrity digest, provenance, chain of custody, retention, and hold status) is shown. The body reference is not disclosed.</p>
          </div>`;
}

/** The integrity block — the digest + a WORDS (not color) verdict; unverified is a `role="alert"`. */
function integrityBlock(e: EvidenceEnvelopeVM): string {
  const status = e.integrityVerified
    ? `<span data-testid="integrity-status" data-integrity-verified="true">Integrity verified — the recomputed digest matched the recorded digest.</span>`
    : `<strong class="warn" role="alert" data-testid="integrity-status" data-integrity-verified="false">Integrity UNVERIFIED — the recomputed digest did NOT match the recorded digest; treat this evidence as potentially tampered.</strong>`;
  return `
          <div data-testid="evidence-integrity" data-integrity-verified="${e.integrityVerified ? 'true' : 'false'}">
            <p>Integrity digest: <code data-testid="evidence-digest">${esc(e.digest)}</code></p>
            ${status}
          </div>`;
}

/** The provenance block — sourceSystem, collectedBy, collectedAt (as `<time>`), method. */
function provenanceBlock(p: EvidenceProvenanceVM): string {
  return `
          <div data-testid="evidence-provenance">
            <h4>Provenance</h4>
            <dl>
              <div class="kv-row"><dt>Source system</dt><dd data-testid="provenance-source-system">${esc(p.sourceSystem)}</dd></div>
              <div class="kv-row"><dt>Collected by</dt><dd data-testid="provenance-collected-by">${esc(p.collectedByPrincipalId)}</dd></div>
              <div class="kv-row"><dt>Collected at</dt><dd><time datetime="${esc(p.collectedAtIso)}" data-testid="provenance-collected-at">${esc(p.collectedAtIso)}</time></dd></div>
              <div class="kv-row"><dt>Method</dt><dd data-testid="provenance-method">${esc(p.method)}</dd></div>
            </dl>
          </div>`;
}

/** The chain-of-custody block — an ordered table preserving recorded order (never reordered). */
function custodyBlock(events: readonly EvidenceCustodyEventVM[]): string {
  if (events.length === 0) {
    return `
          <div data-testid="evidence-custody" data-custody-count="0">
            <h4>Chain of custody</h4>
            <p data-testid="no-custody">No chain-of-custody events are recorded for this envelope.</p>
          </div>`;
  }
  const rows = events
    .map(
      (c, i) => `
              <tr data-testid="custody-event" data-custody-index="${i}">
                <td><time datetime="${esc(c.atIso)}">${esc(c.atIso)}</time></td>
                <td>${esc(c.actorPrincipalId)}</td>
                <td>${esc(c.action)}</td>
                <td>${esc(c.note)}</td>
              </tr>`,
    )
    .join('');
  return `
          <div data-testid="evidence-custody" data-custody-count="${events.length}">
            <h4>Chain of custody</h4>
            <table>
              <caption>Chain of custody in recorded order (time, actor, action, note)</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
}

/** The retention + legal-hold block — retention as `<time>`, hold badge with mandated text. */
function retentionBlock(e: EvidenceEnvelopeVM): string {
  const hold = e.legalHold
    ? `<strong class="warn" data-testid="legal-hold" data-legal-hold="true">under legal hold — retention overridden</strong>`
    : `<span data-testid="no-legal-hold" data-legal-hold="false">not under legal hold</span>`;
  return `
          <div data-testid="evidence-retention" data-legal-hold="${e.legalHold ? 'true' : 'false'}">
            <h4>Retention &amp; hold</h4>
            <p>Retention until <time datetime="${esc(e.retentionUntilIso)}" data-testid="retention-until">${esc(e.retentionUntilIso)}</time>.</p>
            <p>${hold}</p>
          </div>`;
}

/** One evidence envelope card — always-visible metadata + the gated body. */
function envelopeCard(e: EvidenceEnvelopeVM): string {
  return `
      <section
        class="envelope"
        data-testid="evidence-envelope"
        data-evidence-id="${esc(e.evidenceId)}"
        data-access-authorized="${e.accessAuthorized ? 'true' : 'false'}"
        data-integrity-verified="${e.integrityVerified ? 'true' : 'false'}"
        data-legal-hold="${e.legalHold ? 'true' : 'false'}"
        aria-labelledby="envelope-${esc(e.evidenceId)}-h"
        tabindex="-1"
      >
        <h3 id="envelope-${esc(e.evidenceId)}-h" data-testid="envelope-title">Evidence <code>${esc(e.evidenceId)}</code> — ${esc(e.kind)}</h3>
        <dl>
          <div class="kv-row"><dt>Kind</dt><dd data-testid="envelope-kind">${esc(e.kind)}</dd></div>
          <div class="kv-row"><dt>Content type</dt><dd data-testid="envelope-content-type"><code>${esc(e.contentType)}</code></dd></div>
          <div class="kv-row"><dt>Size</dt><dd data-testid="envelope-size">${e.sizeBytes} byte(s)</dd></div>
        </dl>
        ${integrityBlock(e)}
        ${provenanceBlock(e.provenance)}
        ${custodyBlock(e.custody)}
        ${retentionBlock(e)}
        <div data-testid="evidence-body">
          <h4>Evidence body</h4>
          ${bodyCell(e)}
        </div>
      </section>`;
}

// ── Regions ──────────────────────────────────────────────────────────────────────────────────────

function explorerRegion(m: EvidenceExplorerModel): string {
  const cards = m.envelopes.map(envelopeCard).join('');
  const empty =
    m.envelopes.length === 0
      ? '<p data-testid="no-envelopes">No evidence envelopes are in this explorer.</p>'
      : '';
  return `
      <section id="region-evidence" aria-labelledby="evidence-h" data-testid="evidence-explorer" tabindex="-1">
        <h2 id="evidence-h">Evidence envelopes</h2>
        <p id="evidence-intro" data-testid="evidence-intro">
          Each card shows an evidence envelope's metadata — integrity digest, provenance, chain of
          custody, retention, and legal-hold status — which is ALWAYS visible. The evidence BODY is
          shown ONLY when you are authorized for it; an unauthorized body is withheld and its
          reference is never disclosed.
        </p>
        ${empty}${cards}
      </section>`;
}

function metadataRegion(m: EvidenceExplorerModel): string {
  return `
      <section id="region-evidence-metadata" aria-labelledby="evidence-md-h" data-testid="evidence-metadata" tabindex="-1"
        data-snapshot-digest="${esc(m.snapshotDigest)}">
        <h2 id="evidence-md-h" class="visually-hidden">Explorer freshness</h2>
        <p data-testid="evidence-generated-at">
          Explorer generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>.
          Snapshot digest: <code data-testid="evidence-snapshot-digest">${esc(m.snapshotDigest)}</code>.
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
        data-role="evidence-explorer"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">evidence explorer</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
        </dl>
      </section>`;
}

/** The live status region: how many envelopes, and how many bodies are withheld (WCAG 1.4.1 text). */
function statusSummary(m: EvidenceExplorerModel): string {
  const total = m.envelopes.length;
  const withheld = m.envelopes.filter((e) => !e.accessAuthorized).length;
  const summary = `${total} evidence envelope(s); ${withheld} body(ies) withheld for lack of authorization.`;
  return `
      <div
        id="evidence-status"
        role="status"
        aria-live="polite"
        data-testid="evidence-status"
        data-envelope-count="${total}"
        data-withheld-count="${withheld}"
      >
        <span data-testid="evidence-status-text">${esc(summary)}</span>
      </div>`;
}

const EVIDENCE_STYLE = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1rem; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    .envelope { border: 1px solid #999; border-radius: .25rem; padding: 1rem; margin: 0 0 1.5rem; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0 0 .75rem; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row, .kv-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; } dd { margin: 0; }
    h3, h4 { margin: .75rem 0 .35rem; }
    .warn { display: inline-block; color: #b3261e; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 3px solid #0b57d0; outline-offset: 2px; }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }`;

/**
 * Render the complete accessible EVIDENCE EXPLORER as a standalone HTML document, PRESENTING the
 * injected `props.model`. Mounted in-browser via `page.setContent(renderEvidenceExplorer(props))`.
 * Single-column and wrapping, with a visible focus indicator. The evidence body is emitted ONLY for
 * authorized envelopes (FR-053); an unauthorized `bodyRef` is never disclosed.
 */
export function renderEvidenceExplorer(props: EvidenceExplorerProps): string {
  const { tenant } = props;
  const m = props.model;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} evidence explorer</title>
  <style>${EVIDENCE_STYLE}
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="evidence-title">${esc(tenant.tenantName)} — evidence explorer</h1>
    ${tenantScopeBanner(tenant)}
    ${statusSummary(m)}
  </header>
  <main id="main" tabindex="-1" data-testid="evidence-main" data-role="evidence-explorer" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${explorerRegion(m)}
    ${metadataRegion(m)}
  </main>
  <footer>
    <p data-testid="evidence-footer">Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · evidence explorer.</p>
  </footer>
</body>
</html>`;
}

export default renderEvidenceExplorer;
