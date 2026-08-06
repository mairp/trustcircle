import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

// TrustCircleAI — accessible, role-aware application SHELL (Phase 77 /
// apps/web/src/app/layout.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The application shell every officer view is mounted inside: the accessible document frame,
// the TENANT SCOPE banner (which tenant + which pinned governance bundle the officer is
// looking at), the ROLE-AWARE primary navigation (the nav that is rendered is a function of the
// signed-in officer's role — an operator does not see the executive-only destinations, and no
// destination the role may not reach is ever emitted), and the GLOBAL STATUS region (a single
// `aria-live` landmark through which connection/freshness/degraded-mode announcements reach
// assistive technology no matter which view is focused). The shell then frames the six
// current-state regions the acceptance criteria (AC1–AC6) require, so the whole officer surface
// — inventory, coverage gaps, cross-source drill-down, staleness markers, the open-ended source
// catalog, and governed-source gaps — is observable *within* the shell.
//
// THE SHELL IS A PURE PRESENTER — it does not FABRICATE current-state data. `renderAppShell(props)`
// renders whatever `CurrentStateModel` it is handed (`props.currentState`). That model is DERIVED
// elsewhere by the REAL Phase-70 current-inventory assembly service
// (`packages/application/src/inventory-service.ts`), which composes the Phase-64 correlation engine
// over the Phase-63 domain value model. The accessibility spec builds that model from the real
// service and injects it here, so every AC1–AC6 assertion observes GENUINELY reconciled state:
//   • AC1 rows appear once because the SERVICE keys assets by id;
//   • AC4 `reportedHealth` is `unknown` for stale rows because the SERVICE refuses to infer health;
//   • AC2/AC6 gaps stay visible because the SERVICE never deletes them;
//   • AC3 drill-down carries the DISTINCT source records/dependencies the SERVICE correlated;
//   • AC5 catalog rows carry the discovery facets the SERVICE read back.
// The shell contributes the ACCESSIBLE, role-scoped, non-color, reflowable PRESENTATION of that
// model — nothing more, nothing invented.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React
// runtime yet, and the repo's TypeScript base sets no `jsx` option (verbatimModuleSyntax +
// isolatedModules, Node's native type-stripping runtime). A JSX element would not compile. The
// accessible *contract* of the shell, however, is specifiable now: this module expresses it as
// a pure, deterministic renderer that returns the exact accessible markup the shipped React
// `layout.tsx` must reproduce. Because the output is a self-contained HTML string, the Phase-77
// accessibility spec can mount it in a REAL browser via `page.setContent(renderAppShell(props))`
// and assert — through axe-core and the live accessibility tree — every obligation, with NO web
// server, NO React, and NO tenant-auth setup.
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

// ── Pinned execution identity (tenant scope) ───────────────────────────────────────────────────
//
// The shell is bound to exactly one governance bundle. Rendering the bundle id + semantic hash +
// work item as machine-readable, independently-readable DOM (a `<dl>` with data attributes, not a
// mutation-response echo) is the DURABLE IDENTITY witness the phase's effect-witness obligations
// require: a value observable through an independent read path, and REJECTABLE when it differs from
// the pinned input.

/** The bundle/tenant identity the shell is pinned to (Phase-77 work item ET0BFCH07V4JW5FN8SCMEGCNB7). */
export interface TenantScope {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly bundleId: string;
  readonly semanticHash: string;
  readonly workItemId: string;
  /** Deterministic ISO instant this shell projection was generated for. */
  readonly generatedAt: string;
}

/** The one tenant scope this shell is pinned to. Rejection of any other value is asserted. */
export const SHELL_TENANT: TenantScope = {
  tenantId: 'tnt-acme-governance',
  tenantName: 'Acme Governance',
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: 'ET0BFCH07V4JW5FN8SCMEGCNB7',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── Role-aware navigation ───────────────────────────────────────────────────────────────────────

/** The officer roles the shell renders navigation for. */
export type AppRole = 'operator' | 'executive' | 'auditor';

export const SHELL_ROLES: readonly AppRole[] = ['operator', 'executive', 'auditor'] as const;

/** A primary-navigation destination and the roles permitted to reach it. */
export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly regionId: string;
  /** Roles that may see AND reach this destination. Empty is illegal (never emitted). */
  readonly roles: readonly AppRole[];
}

/**
 * The full navigation catalog. `navFor(role)` projects the subset a role may reach; the shell
 * NEVER emits a destination outside the signed-in role's permission set (a link a role cannot
 * use is not merely disabled — it is absent from the DOM).
 */
export const SHELL_NAV: readonly NavItem[] = [
  {
    id: 'nav-inventory',
    label: 'Reconciled inventory',
    href: '#region-inventory',
    regionId: 'region-inventory',
    roles: ['operator', 'executive', 'auditor'],
  },
  {
    id: 'nav-coverage-gaps',
    label: 'Coverage gaps',
    href: '#region-coverage-gaps',
    regionId: 'region-coverage-gaps',
    roles: ['operator', 'executive', 'auditor'],
  },
  {
    id: 'nav-drilldown',
    label: 'Cross-source drill-down',
    href: '#region-drilldown',
    regionId: 'region-drilldown',
    roles: ['operator', 'auditor'],
  },
  {
    id: 'nav-freshness',
    label: 'Source freshness',
    href: '#region-freshness',
    regionId: 'region-freshness',
    roles: ['operator', 'executive', 'auditor'],
  },
  {
    id: 'nav-catalog',
    label: 'Source catalog',
    href: '#region-catalog',
    regionId: 'region-catalog',
    roles: ['operator', 'auditor'],
  },
  {
    id: 'nav-source-gaps',
    label: 'Governed-source gaps',
    href: '#region-source-gaps',
    regionId: 'region-source-gaps',
    roles: ['operator', 'executive', 'auditor'],
  },
  // Executive-only destination: an operator/auditor must NOT see this link.
  {
    id: 'nav-executive-posture',
    label: 'Executive posture',
    href: '#region-executive-posture',
    regionId: 'region-executive-posture',
    roles: ['executive'],
  },
  // Auditor-only destination: an operator/executive must NOT see this link.
  {
    id: 'nav-audit-log',
    label: 'Audit log',
    href: '#region-audit-log',
    regionId: 'region-audit-log',
    roles: ['auditor'],
  },
] as const;

/** Project the navigation a single role may see AND reach (least-privilege). */
export function navFor(role: AppRole): readonly NavItem[] {
  return SHELL_NAV.filter((item) => item.roles.includes(role));
}

// ── Global status ────────────────────────────────────────────────────────────────────────────

/** Overall freshness/connection posture surfaced in the global status region. */
export type GlobalConnectivity = 'connected' | 'degraded' | 'offline';

export interface GlobalStatus {
  readonly connectivity: GlobalConnectivity;
  /** Human, non-color-only summary (WCAG 1.4.1 — meaning is in the text, not the badge). */
  readonly summary: string;
  readonly lastRefreshedAt: string;
  /** 0..1 confidence in the currently displayed state. */
  readonly confidence: string;
}

/** The default global-status projection the shell renders when none is derived. */
export const SHELL_STATUS: GlobalStatus = {
  connectivity: 'degraded',
  summary:
    'Degraded: 1 source is stale; showing last-known data. Current compliance is not inferred from stale data.',
  lastRefreshedAt: '2026-07-31T09:20:00Z',
  confidence: 'medium',
} as const;

// ── The current-state VIEW MODEL (AC1–AC6) — the presenter's INPUT ─────────────────────────────
//
// These are the render-ready shapes the shell PRESENTS. They are produced by
// tests/accessibility/support/current-state-model.ts#deriveModel(), which maps the REAL Phase-70
// `InventoryService` outputs (`currentStateView`, `drillDown`, `componentGaps`,
// `governedSourceGaps`, `catalogView`) into these fields. Every field is a projection of a value
// the service COMPUTED — the shell never invents current-state facts.

/** AC1: one reconciled inventory row, carrying every authoritative field. */
export interface InventoryRowVM {
  readonly id: string;
  readonly assetType: string;
  readonly name: string;
  readonly sourceIdentity: string;
  readonly owner: string;
  readonly lifecycleState: string;
  readonly riskTier: string;
  readonly controlCoverage: string;
  readonly evidenceState: string;
  /** AC4: the health SAFE to report (the service withholds observed health when stale). */
  readonly reportedHealth: string;
  readonly observedHealth: string;
  readonly confidence: number;
  readonly lastObservedAt: string;
  readonly unresolvedIssues: number;
  readonly sourceRecordCount: number;
}

/** AC2: a discovered-not-healthy component that stays a visible coverage gap. */
export interface CoverageGapVM {
  readonly id: string;
  readonly component: string;
  readonly reasonClass: string;
  readonly reasonText: string;
  readonly ageDays: number;
  readonly impact: string;
  readonly requiredOwnerAction: string;
}

/** AC3: one distinct source record in the cross-source drill-down. */
export interface DrillDownRecordVM {
  readonly source: string;
  readonly recordId: string;
  readonly status: string;
  readonly authoritativeFields: string;
  readonly dependsOn: string;
  readonly lastObservedAt: string;
}

/** AC3: the whole drill-down for one asset. */
export interface DrillDownVM {
  readonly assetId: string;
  readonly assetName: string;
  readonly records: readonly DrillDownRecordVM[];
  readonly distinctSourceCount: number;
  readonly dependencyCount: number;
  readonly authoritativeFieldCount: number;
}

/** AC5: a discovered source in the open-ended catalog. */
export interface DiscoveredSourceVM {
  readonly id: string;
  readonly classification: string;
  readonly location: string;
  readonly accessStatus: string;
  readonly sensitivity: string;
  readonly ownershipStatus: string;
  readonly onboardingState: string;
  /** AC5: the discovery-evidence reference; absent iff the source has none. */
  readonly discoveryEvidenceRef?: string;
}

/** AC6: a discovered source that stays a governed-source gap. */
export interface SourceGapVM {
  readonly id: string;
  readonly source: string;
  readonly reasonClass: string;
  readonly reasonText: string;
  readonly impact: string;
  readonly ownerAction: string;
  readonly reviewOrExpiry: string;
  /** AC6: whether a review-or-expiry deadline is actually recorded. */
  readonly hasReviewOrExpiry: boolean;
}

/** The complete current-state model the shell frames (AC1–AC6) + its independent digest witness. */
export interface CurrentStateModel {
  readonly generatedAtIso: string;
  readonly inventory: readonly InventoryRowVM[];
  readonly coverageGaps: readonly CoverageGapVM[];
  readonly drilldown?: DrillDownVM;
  readonly stale?: InventoryRowVM;
  readonly discoveredSources: readonly DiscoveredSourceVM[];
  readonly sourceGaps: readonly SourceGapVM[];
  /** The service's content digest at the derivation instant — an independent effect witness. */
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model. The shell renders this only when no model is injected; the AC regions
 * frame their headers + captions but carry no rows, so an un-fed shell CANNOT masquerade as a
 * satisfied current-state view (the AC row-count assertions fail against it). */
export const EMPTY_CURRENT_STATE: CurrentStateModel = {
  generatedAtIso: SHELL_TENANT.generatedAt,
  inventory: [],
  coverageGaps: [],
  discoveredSources: [],
  sourceGaps: [],
  snapshotDigest: 'empty',
} as const;

// ── Shell props ──────────────────────────────────────────────────────────────────────────────

export interface AppShellProps {
  readonly role: AppRole;
  readonly tenant: TenantScope;
  readonly status: GlobalStatus;
  /** The DERIVED current-state model to present. Defaults to the empty model. */
  readonly currentState: CurrentStateModel;
}

/** The default shell props (deterministic). Role defaults to `operator`; model is empty until fed. */
export const DEFAULT_SHELL_PROPS: AppShellProps = {
  role: 'operator',
  tenant: SHELL_TENANT,
  status: SHELL_STATUS,
  currentState: EMPTY_CURRENT_STATE,
} as const;

// ── Region renderers (AC1–AC6) — pure projections of the injected model ─────────────────────────

function healthyRegion(m: CurrentStateModel): string {
  const rows = m.inventory
    .map(
      (i) => `
        <tr>
          <th scope="row">${esc(i.name)}</th>
          <td>${esc(i.assetType)}</td>
          <td>${esc(i.sourceIdentity)}</td>
          <td>${esc(i.owner)}</td>
          <td>${esc(i.lifecycleState)}</td>
          <td>${esc(i.riskTier)}</td>
          <td>${esc(i.controlCoverage)}</td>
          <td>${esc(i.evidenceState)}</td>
          <td data-testid="row-reported-health">${esc(i.reportedHealth)}</td>
          <td><time datetime="${esc(i.lastObservedAt)}">${esc(i.lastObservedAt)}</time></td>
          <td>${i.unresolvedIssues === 0 ? 'none' : `${i.unresolvedIssues} unresolved`}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-inventory" aria-labelledby="inv-h" data-testid="reconciled-inventory" tabindex="-1">
        <h2 id="inv-h">Reconciled inventory — healthy items</h2>
        <p id="inv-summary" data-testid="inventory-count">${m.inventory.length} governed item(s), each shown once with its authoritative fields.</p>
        <table aria-describedby="inv-summary">
          <caption>Healthy governed inventory (type, source identity, owner, lifecycle, risk, control coverage, evidence state, health, last observation, unresolved issues)</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Type</th>
              <th scope="col">Source identity</th>
              <th scope="col">Owner</th>
              <th scope="col">Lifecycle state</th>
              <th scope="col">Risk</th>
              <th scope="col">Control coverage</th>
              <th scope="col">Evidence state</th>
              <th scope="col">Health</th>
              <th scope="col">Last observation time</th>
              <th scope="col">Unresolved issues</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function coverageGapRegion(m: CurrentStateModel): string {
  const rows = m.coverageGaps
    .map(
      (g) => `
        <tr>
          <th scope="row">${esc(g.component)}</th>
          <td>
            <span class="badge badge--gap" data-reason="${esc(g.reasonClass)}" aria-hidden="true"></span>
            <span data-testid="gap-reason-text">${esc(g.reasonClass)}: ${esc(g.reasonText)}</span>
          </td>
          <td>${g.ageDays} day(s)</td>
          <td>${esc(g.impact)}</td>
          <td>${esc(g.requiredOwnerAction)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-coverage-gaps" aria-labelledby="gap-h" data-testid="coverage-gaps" tabindex="-1">
        <h2 id="gap-h">Coverage gaps</h2>
        <p>Discovered components that are NOT healthy remain visible here — they never appear healthy and never disappear.</p>
        <table>
          <caption>Coverage gaps (reason, age, impact, required owner action)</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Reason</th>
              <th scope="col">Age</th>
              <th scope="col">Impact</th>
              <th scope="col">Required owner action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function drilldownRegion(m: CurrentStateModel): string {
  const dd = m.drilldown;
  const rows = (dd?.records ?? [])
    .map(
      (r) => `
        <tr>
          <th scope="row">${esc(r.source)}</th>
          <td>${esc(r.recordId)}</td>
          <td>${esc(r.status)}</td>
          <td>${esc(r.authoritativeFields)}</td>
          <td>${esc(r.dependsOn)}</td>
          <td><time datetime="${esc(r.lastObservedAt)}">${esc(r.lastObservedAt)}</time></td>
        </tr>`,
    )
    .join('');
  const statuses = (dd?.records ?? []).map((r) => `${r.source}=${r.status}`).join(', ');
  return `
      <section id="region-drilldown" aria-labelledby="drill-h" data-testid="cross-source-drilldown" tabindex="-1">
        <h2 id="drill-h">Cross-source drill-down — ${esc(dd?.assetName ?? '—')}</h2>
        <p id="drill-summary" data-testid="drilldown-text-summary" data-distinct-sources="${dd?.distinctSourceCount ?? 0}" data-dependencies="${dd?.dependencyCount ?? 0}">
          Correlated across ${dd?.distinctSourceCount ?? 0} distinct registered source(s). Statuses: ${esc(statuses)}.
          ${dd?.dependencyCount ?? 0} dependency edge(s) and ${dd?.authoritativeFieldCount ?? 0} authoritative-field attribution(s) were correlated.
          Each source keeps its DISTINCT record; authoritative fields are attributed per source
          (no source overrides another's authority).
        </p>
        <table aria-describedby="drill-summary">
          <caption>Distinct source records with correlation, status differences, dependencies, and authoritative fields</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Source record ID</th>
              <th scope="col">Status</th>
              <th scope="col">Authoritative fields</th>
              <th scope="col">Depends on</th>
              <th scope="col">Last observed</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function freshnessRegion(m: CurrentStateModel): string {
  const s = m.stale;
  if (s === undefined) {
    return `
      <section id="region-freshness" aria-labelledby="stale-h" data-testid="stale-source-panel" tabindex="-1">
        <h2 id="stale-h">Source freshness</h2>
        <p data-testid="no-stale-inference" data-freshness="current">
          All contributing sources are current. Current compliance and health are NOT inferred from stale data.
        </p>
      </section>`;
  }
  return `
      <section id="region-freshness" aria-labelledby="stale-h" data-testid="stale-source-panel" tabindex="-1">
        <h2 id="stale-h">Source freshness — ${esc(s.name)}</h2>
        <p data-testid="stale-marker" data-freshness="${esc(s.evidenceState)}" data-reported-health="${esc(s.reportedHealth)}" data-observed-health="${esc(s.observedHealth)}">
          <strong>Evidence state: ${esc(s.evidenceState)}.</strong>
          Showing last-known data from
          <time datetime="${esc(s.lastObservedAt)}" data-testid="last-known-time">${esc(s.lastObservedAt)}</time>.
          Confidence: <span data-testid="confidence">${esc(s.confidence.toFixed(2))}</span>.
        </p>
        <p data-testid="no-stale-inference">
          Current compliance and health are NOT inferred from stale data: the reported health is
          <strong data-testid="stale-reported-health">${esc(s.reportedHealth)}</strong> (withheld as
          <em>unknown</em>), even though the last observation recorded
          <span data-testid="stale-observed-health">${esc(s.observedHealth)}</span>.
        </p>
      </section>`;
}

function catalogRegion(m: CurrentStateModel): string {
  const rows = m.discoveredSources
    .map(
      (d) => `
        <tr>
          <th scope="row">${esc(d.id)}</th>
          <td>${esc(d.classification)}</td>
          <td>${esc(d.location)}</td>
          <td>${esc(d.accessStatus)}</td>
          <td>${esc(d.sensitivity)}</td>
          <td>${esc(d.ownershipStatus)}</td>
          <td>${esc(d.onboardingState)}</td>
          <td data-testid="discovery-evidence-cell">${
            d.discoveryEvidenceRef
              ? `<a href="#${esc(d.discoveryEvidenceRef)}">${esc(d.discoveryEvidenceRef)}</a>`
              : '<span data-testid="no-discovery-evidence">no discovery evidence</span>'
          }</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-catalog" aria-labelledby="cat-h" data-testid="source-catalog" tabindex="-1">
        <h2 id="cat-h">Open-ended source catalog</h2>
        <table data-testid="discovered-sources">
          <caption>Newly discovered sources within the declared boundary (discovery evidence, type or unknown classification, location, access status, sensitivity, ownership status, onboarding state)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Classification</th>
              <th scope="col">Location</th>
              <th scope="col">Access status</th>
              <th scope="col">Sensitivity</th>
              <th scope="col">Ownership status</th>
              <th scope="col">Onboarding state</th>
              <th scope="col">Discovery evidence</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function sourceGapRegion(m: CurrentStateModel): string {
  const rows = m.sourceGaps
    .map(
      (g) => `
        <tr>
          <th scope="row">${esc(g.source)}</th>
          <td>
            <span class="badge badge--gap" data-reason="${esc(g.reasonClass)}" aria-hidden="true"></span>
            <span data-testid="source-gap-reason-text">${esc(g.reasonClass)}: ${esc(g.reasonText)}</span>
          </td>
          <td>${esc(g.impact)}</td>
          <td>${esc(g.ownerAction)}</td>
          <td data-testid="source-gap-review" data-has-review="${g.hasReviewOrExpiry}">${esc(g.reviewOrExpiry)}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-source-gaps" aria-labelledby="sgap-h" data-testid="governed-source-gaps" tabindex="-1">
        <h2 id="sgap-h">Governed source gaps</h2>
        <table>
          <caption>Discovered sources that remain governance gaps (reason, impact, owner action, review or expiry)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Reason</th>
              <th scope="col">Impact</th>
              <th scope="col">Owner action</th>
              <th scope="col">Review / expiry</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

/**
 * Role-scoped region: the executive-only and auditor-only destinations render their landmark
 * ONLY when the signed-in role may reach them.
 */
function executivePostureRegion(m: CurrentStateModel): string {
  const healthy = m.inventory.length;
  const gaps = m.coverageGaps.length + m.sourceGaps.length;
  return `
      <section id="region-executive-posture" aria-labelledby="exec-h" data-testid="executive-posture" tabindex="-1">
        <h2 id="exec-h">Executive posture</h2>
        <p>Aggregate governance posture for ${esc(SHELL_TENANT.tenantName)} — reported from confirmed,
          current state only (stale items are counted as unknown, never healthy):
          ${healthy} confirmed-healthy item(s), ${gaps} open gap(s).</p>
      </section>`;
}

function auditLogRegion(_m: CurrentStateModel): string {
  return `
      <section id="region-audit-log" aria-labelledby="audit-h" data-testid="audit-log" tabindex="-1">
        <h2 id="audit-h">Audit log</h2>
        <p>Immutable, provenance-preserving record of governance decisions for this tenant scope.</p>
      </section>`;
}

/** Map a nav destination's regionId to its renderer (role-gated regions included here). */
function regionRenderers(): Readonly<Record<string, (m: CurrentStateModel) => string>> {
  return {
    'region-inventory': healthyRegion,
    'region-coverage-gaps': coverageGapRegion,
    'region-drilldown': drilldownRegion,
    'region-freshness': freshnessRegion,
    'region-catalog': catalogRegion,
    'region-source-gaps': sourceGapRegion,
    'region-executive-posture': executivePostureRegion,
    'region-audit-log': auditLogRegion,
  };
}

// ── Shell chrome renderers ─────────────────────────────────────────────────────────────────────

/** The tenant-scope banner: a machine-readable identity binding + human tenant label. */
function tenantScopeBanner(tenant: TenantScope, role: AppRole): string {
  return `
      <section
        aria-labelledby="scope-h"
        data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}"
        data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}"
        data-work-item-id="${esc(tenant.workItemId)}"
        data-role="${esc(role)}"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row">
            <dt>Tenant</dt>
            <dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd>
          </div>
          <div class="scope-row">
            <dt>Signed-in role</dt>
            <dd data-testid="scope-role">${esc(role)}</dd>
          </div>
          <div class="scope-row">
            <dt>Governance bundle</dt>
            <dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd>
          </div>
          <div class="scope-row">
            <dt>Semantic hash</dt>
            <dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd>
          </div>
          <div class="scope-row">
            <dt>Work item</dt>
            <dd data-testid="scope-work-item"><code>${esc(tenant.workItemId)}</code></dd>
          </div>
          <div class="scope-row">
            <dt>Scope generated</dt>
            <dd><time datetime="${esc(tenant.generatedAt)}" data-testid="scope-generated-at">${esc(tenant.generatedAt)}</time></dd>
          </div>
        </dl>
      </section>`;
}

/** The role-aware primary navigation. Only destinations the role may reach are emitted. */
function primaryNav(role: AppRole): string {
  const items = navFor(role)
    .map(
      (item) => `
          <li>
            <a
              href="${esc(item.href)}"
              data-testid="nav-link"
              data-nav-id="${esc(item.id)}"
              data-region-id="${esc(item.regionId)}"
            >${esc(item.label)}</a>
          </li>`,
    )
    .join('');
  return `
      <nav aria-label="Primary" data-testid="primary-nav" data-role="${esc(role)}">
        <h2 id="nav-h" class="visually-hidden">Primary navigation for the ${esc(role)} role</h2>
        <ul aria-labelledby="nav-h">${items}</ul>
      </nav>`;
}

/**
 * The single GLOBAL STATUS region: an `aria-live=polite` landmark carrying the connectivity/
 * freshness posture. Meaning is in the TEXT (not the color badge, which is aria-hidden), the
 * last-refreshed instant is a machine-readable `<time>`, and confidence is present.
 */
function globalStatusRegion(status: GlobalStatus): string {
  return `
      <div
        id="global-status"
        role="status"
        aria-live="polite"
        data-testid="global-status"
        data-connectivity="${esc(status.connectivity)}"
      >
        <span class="badge badge--status" data-connectivity="${esc(status.connectivity)}" aria-hidden="true"></span>
        <span data-testid="global-status-text">${esc(status.summary)}</span>
        <span>Last refreshed:
          <time datetime="${esc(status.lastRefreshedAt)}" data-testid="global-status-time">${esc(status.lastRefreshedAt)}</time>.
        </span>
        <span>Confidence: <span data-testid="global-status-confidence">${esc(status.confidence)}</span>.</span>
      </div>`;
}

/** Render the current-state regions visible to `role`, projecting the injected model. */
function regionsFor(role: AppRole, model: CurrentStateModel): string {
  const renderers = regionRenderers();
  return navFor(role)
    .map((item) => {
      const render = renderers[item.regionId];
      return render ? render(model) : '';
    })
    .join('\n');
}

// ── The shell ─────────────────────────────────────────────────────────────────────────────────

/**
 * Render the complete accessible application shell as a standalone HTML document, PRESENTING the
 * injected `props.currentState` model. Mounted in-browser via `page.setContent(renderAppShell(props))`.
 * Single-column and wrapping (no fixed pixel widths that force horizontal scroll at 400% zoom), with
 * a visible focus indicator so keyboard focus is never invisible.
 *
 * Order: skip link → tenant-scope banner → role-aware primary navigation → global status region →
 * `<main>` framing the six current-state regions the role may reach.
 */
export function renderAppShell(props: AppShellProps = DEFAULT_SHELL_PROPS): string {
  const { role, tenant, status } = props;
  const model = props.currentState;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} governance shell</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 1rem;
      font: 16px/1.5 system-ui, sans-serif;
      color: #111; background: #fff;
      max-width: 100%; overflow-wrap: anywhere; word-break: break-word;
    }
    header, nav, main, footer, section, div { max-width: 100%; }
    main { display: block; }
    section { margin: 0 0 1.5rem; }
    nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
    nav a { display: inline-block; padding: .35rem .6rem; border: 1px solid #0b57d0; border-radius: .25rem;
            color: #0b3d91; text-decoration: none; }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 3px solid #0b57d0; outline-offset: 2px;
    }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    .badge { display: inline-block; width: .75rem; height: .75rem; border-radius: 50%;
             vertical-align: middle; margin-right: .25rem; }
    .badge--gap { background: #b3261e; }
    .badge--status { background: #a15c00; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="shell-title">${esc(tenant.tenantName)} — AI governance</h1>
    ${tenantScopeBanner(tenant, role)}
    ${primaryNav(role)}
    ${globalStatusRegion(status)}
  </header>
  <main id="main" tabindex="-1" data-testid="shell-main" data-role="${esc(role)}" data-snapshot-digest="${esc(model.snapshotDigest)}">
    ${regionsFor(role, model)}
  </main>
  <footer>
    <p data-testid="shell-footer">
      Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code>.
    </p>
  </footer>
</body>
</html>`;
}

export const metadata: Metadata = {
  title: 'TrustCircle operator console',
  description: 'Tenant-scoped, read-only governance operating picture',
};

/** Next.js production document frame. Legacy string presenters remain named exports above. */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('trustcircle-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){}})()`,
          }}
        />
        <link rel="stylesheet" href="/console.css" />
        <link rel="stylesheet" href="/console-details.css" />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to operating picture
        </a>
        {children}
      </body>
    </html>
  );
}
