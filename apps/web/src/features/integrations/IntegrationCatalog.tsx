// TrustCircleAI — INTEGRATION CATALOG presenter (Phase 8 / User Story 6 — Maintain Source and
// Workflow Health / T244 / apps/web/src/features/integrations/IntegrationCatalog.tsx / FR-029,
// NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer-facing INTEGRATION CATALOG: for each registered adapter/connector it renders the
// contracts it speaks, the capabilities it declares, its AUTHORITY posture, its versions,
// ownership, lifecycle, availability PROFILE (availability class), and its discovery/attestation
// EVIDENCE.
//
// THE CARDINAL POINT (NFR-010 / db/migrations/0060 adapter_definition_no_authority): a connector is
// an OBSERVER/DRIVER of an external source; it is NEVER authoritative for governance. Every adapter
// card states this in WORDS — the forbidden-inferences note and the explicit "not authoritative for
// governance" caption — so a reader can never mistake a connector's reach for governance authority.
//
// PURE PRESENTER. The contracts / capabilities / authority posture / versions / lifecycle / profile /
// evidence are NOT computed here — they come from the REAL adapter-registry + component-profile
// projection upstream. This module renders whatever `IntegrationCatalogModel` it is handed VERBATIM;
// it fabricates no capability, forges no owner, and NEVER upgrades a connector to authoritative.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every lifecycle state, availability class, and
// authority posture is spelled in words with a machine-readable data-attribute.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). apps/web has not adopted a React runtime;
// this `.tsx` file contains NO JSX — it is a pure string-builder presenter (tsconfig `jsx:preserve`
// only satisfies the extension resolver). The output is a self-contained HTML string an e2e spec can
// mount via `page.setContent(renderIntegrationCatalog(props))` and assert through axe-core.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no
// network, no module-level mutable state — same props ⇒ byte-identical output.

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── The catalog model — a render-ready reduction, NOT recomputed here ─────────────────────────────

/** Runtime availability class of a component (NFR-010 — separate from design authority). */
export type CatalogAvailabilityClass = 'core' | 'optional' | 'on-demand';

/** One protocol/contract an adapter speaks (a min..max protocol-major range). */
export interface CatalogContractVM {
  readonly name: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
}

/** One declared capability an adapter offers (read/observe/drive — always non-authoritative). */
export interface CatalogCapabilityVM {
  readonly key: string;
  readonly description: string;
}

/** One version build of an adapter and its lifecycle state. */
export interface CatalogVersionVM {
  readonly semanticVersion: string;
  readonly lifecycleState: string;
  readonly signingKeyId: string;
  readonly signed: boolean;
  readonly createdAtIso: string;
}

/** A discovery/attestation evidence pointer backing a catalog entry. */
export interface CatalogEvidenceVM {
  readonly evidenceId: string;
  readonly kind: string;
  readonly recordedAtIso: string;
}

/**
 * One catalog entry: an adapter/connector with its contracts, capabilities, AUTHORITY posture,
 * versions, ownership, lifecycle, profile, and evidence. `authorityGrantable` is ALWAYS false — a
 * connector is never authoritative for governance — and `forbiddenInferences` enumerates the
 * conclusions a reader must NOT draw from the connector's reach.
 */
export interface IntegrationCatalogEntryVM {
  readonly adapterKey: string;
  readonly displayName: string;
  readonly category: string;
  readonly ownerLabel: string;
  readonly lifecycleState: string;
  readonly availabilityClass: CatalogAvailabilityClass;
  readonly contracts: readonly CatalogContractVM[];
  readonly capabilities: readonly CatalogCapabilityVM[];
  /** ALWAYS false: a connector never holds governance authority (0060 CHECK). */
  readonly authorityGrantable: false;
  /** The conclusions a reader must NOT infer from this connector (rendered verbatim). */
  readonly forbiddenInferences: readonly string[];
  readonly versions: readonly CatalogVersionVM[];
  readonly evidence: readonly CatalogEvidenceVM[];
}

/** The whole catalog model — the scope + its adapter/connector entries. */
export interface IntegrationCatalogModel {
  readonly scopeLabel: string;
  readonly entries: readonly IntegrationCatalogEntryVM[];
  readonly generatedAtIso: string;
  /** The projection snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed catalog is empty, never a fabricated adapter set. */
export const EMPTY_INTEGRATION_CATALOG: IntegrationCatalogModel = {
  scopeLabel: '',
  entries: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface IntegrationCatalogProps {
  readonly model: IntegrationCatalogModel;
}

// ── Availability-class label (the availability PROFILE, in words) ─────────────────────────────────

const AVAILABILITY_LABELS: Readonly<Record<CatalogAvailabilityClass, string>> = {
  core: 'core — must run continuously; its loss blocks the governed feature it backs',
  optional: 'optional — enhances governance; its loss degrades a feature but core keeps running',
  'on-demand': 'on-demand — activated only for a specific request; not running continuously',
} as const;

function availabilityLabel(a: CatalogAvailabilityClass): string {
  return AVAILABILITY_LABELS[a];
}

// ── Card sub-renderers ────────────────────────────────────────────────────────────────────────────

function contractsList(entry: IntegrationCatalogEntryVM): string {
  if (entry.contracts.length === 0) {
    return '<p data-testid="catalog-no-contracts" data-contracts="none">no contracts declared</p>';
  }
  const items = entry.contracts
    .map(
      (c) => `
          <li
            data-testid="catalog-contract"
            data-contract-name="${esc(c.name)}"
            data-protocol-min="${esc(String(c.protocolMin))}"
            data-protocol-max="${esc(String(c.protocolMax))}"
          >${esc(c.name)} (protocol ${esc(String(c.protocolMin))}..${esc(String(c.protocolMax))})</li>`,
    )
    .join('');
  return `<ul data-testid="catalog-contracts">${items}</ul>`;
}

function capabilitiesList(entry: IntegrationCatalogEntryVM): string {
  if (entry.capabilities.length === 0) {
    return '<p data-testid="catalog-no-capabilities" data-capabilities="none">no capabilities declared</p>';
  }
  const items = entry.capabilities
    .map(
      (c) => `
          <li data-testid="catalog-capability" data-capability-key="${esc(c.key)}">
            <code>${esc(c.key)}</code> — ${esc(c.description)}
          </li>`,
    )
    .join('');
  return `<ul data-testid="catalog-capabilities">${items}</ul>`;
}

function authoritySection(entry: IntegrationCatalogEntryVM): string {
  // The forbidden-inferences note + the "not authoritative for governance" caption, verbatim.
  const forbidden =
    entry.forbiddenInferences.length === 0
      ? ''
      : `
          <ul data-testid="catalog-forbidden-inferences">${entry.forbiddenInferences
            .map(
              (f) => `
            <li data-testid="catalog-forbidden-inference">${esc(f)}</li>`,
            )
            .join('')}
          </ul>`;
  return `
        <div
          data-testid="catalog-authority"
          data-authority-grantable="false"
        >
          <p data-testid="catalog-not-authoritative">
            <strong>Not authoritative for governance.</strong> This connector observes and/or drives an
            external source; it is never granted governance authority.
          </p>${forbidden}
        </div>`;
}

function versionsList(entry: IntegrationCatalogEntryVM): string {
  if (entry.versions.length === 0) {
    return '<p data-testid="catalog-no-versions" data-versions="none">no versions registered</p>';
  }
  const items = entry.versions
    .map(
      (v) => `
          <li
            data-testid="catalog-version"
            data-semantic-version="${esc(v.semanticVersion)}"
            data-lifecycle-state="${esc(v.lifecycleState)}"
            data-signed="${v.signed ? 'true' : 'false'}"
          >
            <code>${esc(v.semanticVersion)}</code> — lifecycle: ${esc(v.lifecycleState)};
            ${v.signed ? `signed by <code>${esc(v.signingKeyId)}</code>` : 'unsigned'};
            registered <time datetime="${esc(v.createdAtIso)}">${esc(v.createdAtIso)}</time>
          </li>`,
    )
    .join('');
  return `<ul data-testid="catalog-versions">${items}</ul>`;
}

function evidenceList(entry: IntegrationCatalogEntryVM): string {
  if (entry.evidence.length === 0) {
    return '<p data-testid="catalog-no-evidence" data-evidence="none">no evidence recorded</p>';
  }
  const items = entry.evidence
    .map(
      (e) => `
          <li data-testid="catalog-evidence" data-evidence-id="${esc(e.evidenceId)}" data-evidence-kind="${esc(
            e.kind,
          )}">
            <code>${esc(e.evidenceId)}</code> (${esc(e.kind)}) at
            <time datetime="${esc(e.recordedAtIso)}">${esc(e.recordedAtIso)}</time>
          </li>`,
    )
    .join('');
  return `<ul data-testid="catalog-evidence-list">${items}</ul>`;
}

function catalogCard(entry: IntegrationCatalogEntryVM): string {
  return `
      <article
        class="catalog-card"
        data-testid="catalog-entry"
        data-adapter-key="${esc(entry.adapterKey)}"
        data-category="${esc(entry.category)}"
        data-lifecycle-state="${esc(entry.lifecycleState)}"
        data-availability-class="${esc(entry.availabilityClass)}"
        data-authority-grantable="false"
      >
        <h3 data-testid="catalog-name"><code>${esc(entry.adapterKey)}</code> — ${esc(
          entry.displayName,
        )}</h3>
        <dl>
          <dt>Category</dt>
          <dd data-testid="catalog-category">${esc(entry.category)}</dd>
          <dt>Owner</dt>
          <dd data-testid="catalog-owner">${esc(entry.ownerLabel)}</dd>
          <dt>Lifecycle</dt>
          <dd data-testid="catalog-lifecycle" data-lifecycle-state="${esc(
            entry.lifecycleState,
          )}">${esc(entry.lifecycleState)}</dd>
          <dt>Availability profile</dt>
          <dd data-testid="catalog-availability" data-availability-class="${esc(
            entry.availabilityClass,
          )}">${esc(availabilityLabel(entry.availabilityClass))}</dd>
        </dl>
        <section aria-label="Contracts" data-testid="catalog-contracts-section">
          <h4>Contracts</h4>
          ${contractsList(entry)}
        </section>
        <section aria-label="Capabilities" data-testid="catalog-capabilities-section">
          <h4>Capabilities</h4>
          ${capabilitiesList(entry)}
        </section>
        <section aria-label="Authority" data-testid="catalog-authority-section">
          <h4>Authority</h4>
          ${authoritySection(entry)}
        </section>
        <section aria-label="Versions" data-testid="catalog-versions-section">
          <h4>Versions</h4>
          ${versionsList(entry)}
        </section>
        <section aria-label="Evidence" data-testid="catalog-evidence-section">
          <h4>Evidence</h4>
          ${evidenceList(entry)}
        </section>
      </article>`;
}

// ── The catalog view ──────────────────────────────────────────────────────────────────────────────

/** Render the integration catalog as a self-contained, deterministic HTML string. */
export function renderIntegrationCatalog(props: IntegrationCatalogProps): string {
  const m = props.model;
  const cards =
    m.entries.length === 0
      ? '<p data-testid="catalog-empty" data-entries="0">no adapters or connectors registered</p>'
      : m.entries.map(catalogCard).join('');
  return `
  <section
    id="region-integration-catalog"
    aria-labelledby="integration-catalog-h"
    data-testid="integration-catalog"
    data-scope="${esc(m.scopeLabel)}"
    data-entry-count="${esc(String(m.entries.length))}"
    data-snapshot-digest="${esc(m.snapshotDigest)}"
    tabindex="-1"
  >
    <h2 id="integration-catalog-h">Integration catalog</h2>
    <p data-testid="catalog-scope">Scope: ${esc(m.scopeLabel)}</p>
    <p data-testid="catalog-generated-at">
      Generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>
    </p>
    <p data-testid="catalog-authority-note">
      Adapters and connectors observe and drive external sources. None is authoritative for
      governance.
    </p>
    ${cards}
  </section>`;
}
