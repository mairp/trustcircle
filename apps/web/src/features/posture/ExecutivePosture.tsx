// TrustCircleAI — EXECUTIVE POSTURE view (Phase 78 /
// apps/web/src/features/posture/ExecutivePosture.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executive-facing GOVERNANCE POSTURE view. It answers the executive's four questions on top
// of the six current-state acceptance criteria (AC1–AC6) the whole officer surface must satisfy:
//   • an executive POSTURE SUMMARY — the aggregate counts an executive reads first (confirmed-
//     healthy items, open coverage gaps, open governed-source gaps, and items whose currency is
//     UNKNOWN because their evidence is stale — never silently folded into "healthy");
//   • BUSINESS-IMPACT ORDERING — every gap list is ordered most-material-first by a business-impact
//     rank (gap impact × subject risk), so the executive triages by consequence, not by id;
//   • CONFIDENCE — a posture-level confidence (the weakest-link of the per-row confidences the
//     service computed) so the executive knows how much to trust the numbers, plus the per-row
//     confidence behind each summary figure;
//   • GAP TRENDS — the direction each gap class is moving (opened / closed / aged) between an
//     earlier baseline snapshot and the current one, so the executive sees whether posture is
//     improving or deteriorating, not just a static count.
//
// THIS VIEW IS A PURE PRESENTER — it does NOT compute posture. `renderExecutivePosture(props)`
// renders whatever `ExecutivePostureModel` it is handed. That model is DERIVED elsewhere
// (tests/accessibility/support/executive-posture-model.ts) by running the REAL Phase-70
// current-inventory assembly service (packages/application/src/inventory-service.ts) — the same
// aggregate proven in tests/unit/inventory-service.unit.test.ts — over an explicit deterministic
// scenario, at TWO instants (a baseline and now) so trends are a genuine function of gap age.
// Every number this view shows is therefore a projection of a value the service COMPUTED:
//   • AC1 rows appear once because the SERVICE keys assets by id;
//   • AC2/AC6 gaps stay visible because the SERVICE never deletes them;
//   • AC3 drill-down carries the DISTINCT source records/dependencies the SERVICE correlated;
//   • AC4 stale rows report health `unknown` because the SERVICE refuses to infer current health,
//     and the posture summary counts them as UNKNOWN (never healthy);
//   • AC5 catalog rows carry the discovery facets the SERVICE read back;
//   • the executive SUMMARY / ORDERING / CONFIDENCE / TREND are pure reductions of those same
//     service outputs — the presenter invents nothing.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React
// runtime yet, and the repo's TypeScript base sets no `jsx` option (verbatimModuleSyntax +
// isolatedModules, Node's native type-stripping runtime). A JSX element would not compile. The
// accessible *contract* of this view, however, is specifiable now: this module expresses it as a
// pure, deterministic renderer that returns the exact accessible markup the shipped React view
// must reproduce. Because the output is a self-contained HTML string, the Phase-78 accessibility
// spec mounts it in a REAL browser via `page.setContent(renderExecutivePosture(props))` and
// asserts — through axe-core and the live accessibility tree — every obligation, with NO web
// server, NO React, and NO tenant-auth setup.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no
// network, no module-level mutable state — same props ⇒ byte-identical output.

import type {
  CurrentStateModel,
  InventoryRowVM,
  CoverageGapVM,
  SourceGapVM,
  DrillDownVM,
  DiscoveredSourceVM,
  TenantScope,
} from '../../app/layout.tsx';

export type {
  CurrentStateModel,
  InventoryRowVM,
  CoverageGapVM,
  SourceGapVM,
  DrillDownVM,
  DiscoveredSourceVM,
  TenantScope,
};

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
// The executive posture view is bound to exactly one governance bundle. Rendering the bundle id +
// semantic hash + work item as machine-readable, independently-readable DOM (a `<dl>` with data
// attributes, not a mutation-response echo) is the DURABLE IDENTITY witness the phase's
// effect-witness obligations require: a value observable through an independent read path, and
// REJECTABLE when it differs from the pinned input.

/** The one tenant scope this view is pinned to (Phase-78 work item TRRGYA7N0K97QZ8JAMD077BRWP). */
export const POSTURE_TENANT: TenantScope = {
  tenantId: 'tnt-acme-governance',
  tenantName: 'Acme Governance',
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: 'TRRGYA7N0K97QZ8JAMD077BRWP',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── Executive additions — the posture-specific view model ───────────────────────────────────────
//
// These shapes are the render-ready reductions of the REAL service outputs. They are produced by
// tests/accessibility/support/executive-posture-model.ts#deriveExecutivePosture(), which runs the
// Phase-70 `InventoryService` at two instants and folds its `currentStateView`, `componentGaps`,
// `governedSourceGaps`, and `catalogView` into summary / ordering / confidence / trend figures.
// Every field is a projection of a value the service COMPUTED — the presenter invents nothing.

/**
 * The executive POSTURE SUMMARY: the aggregate figures an executive reads first. `unknownCount`
 * counts rows whose currency is withheld (stale evidence → reportedHealth `unknown`); those are
 * NEVER folded into `confirmedHealthyCount` (AC4 discipline at the summary level).
 */
export interface PostureSummaryVM {
  /** Rows the service reports as currently healthy (evidence current, no visible component gap). */
  readonly confirmedHealthyCount: number;
  /** Rows whose current health is WITHHELD as unknown because their evidence is stale (AC4). */
  readonly unknownCount: number;
  /** Open component coverage gaps still visible (AC2). */
  readonly coverageGapCount: number;
  /** Open governed-source gaps still visible with a review-or-expiry (AC6). */
  readonly sourceGapCount: number;
  /** Total governed items observed (each once). */
  readonly totalItems: number;
  /** A one-line, non-color-only narrative of the posture (WCAG 1.4.1 — meaning is in the text). */
  readonly narrative: string;
}

/** Which business-impact class a gap was ranked into (highest consequence first). */
export type ImpactBand = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';

/** A gap enriched with its business-impact rank so lists order by consequence, not by id (AC2/AC6). */
export interface RankedGapVM {
  readonly id: string;
  /** The subject label (component name for AC2, source label for AC6). */
  readonly subject: string;
  readonly reasonClass: string;
  readonly reasonText: string;
  readonly impact: string;
  readonly impactBand: ImpactBand;
  /** The numeric business-impact rank (higher = more material). Deterministic, service-derived. */
  readonly impactRank: number;
  readonly ageDays: number;
  readonly requiredOwnerAction: string;
  /** AC6 only: the review-or-expiry deadline (empty for AC2 component gaps). */
  readonly reviewOrExpiry: string;
}

/**
 * The posture CONFIDENCE block: the weakest-link confidence across contributing rows (0..1) with a
 * human band, plus the count of rows whose confidence dragged the aggregate down.
 */
export interface PostureConfidenceVM {
  /** The aggregate confidence ∈ [0,1] — the MINIMUM of the per-row confidences (weakest link). */
  readonly aggregate: number;
  /** A non-color band label derived from `aggregate` (high / medium / low). */
  readonly band: 'high' | 'medium' | 'low';
  /** How many rows are below full confidence (drag the aggregate down). */
  readonly lowConfidenceRowCount: number;
  /** A one-line rationale naming the weakest contributing row. */
  readonly rationale: string;
}

/** The direction one gap class is moving between the baseline snapshot and now. */
export type TrendDirection = 'improving' | 'worsening' | 'steady' | 'aging';

/** A gap-trend row: how a gap class changed between the baseline and current snapshot. */
export interface GapTrendVM {
  /** Which gap class this trend tracks. */
  readonly gapClass: 'coverage' | 'governed_source';
  readonly label: string;
  /** Open count at the earlier baseline snapshot. */
  readonly baselineCount: number;
  /** Open count at the current snapshot. */
  readonly currentCount: number;
  /** currentCount − baselineCount (positive = more gaps opened; negative = gaps closed). */
  readonly delta: number;
  /** How many still-open gaps have aged past the ageing threshold since baseline. */
  readonly agedCount: number;
  readonly direction: TrendDirection;
  /** A non-color-only sentence describing the movement (arrow is decorative only). */
  readonly summary: string;
}

/** The whole executive-posture model: the current state + the four executive reductions. */
export interface ExecutivePostureModel {
  /** The underlying current-state model (AC1–AC6), derived from the real service at `now`. */
  readonly currentState: CurrentStateModel;
  /** Executive SUMMARY figures. */
  readonly summary: PostureSummaryVM;
  /** BUSINESS-IMPACT-ORDERED coverage gaps (AC2), most material first. */
  readonly rankedCoverageGaps: readonly RankedGapVM[];
  /** BUSINESS-IMPACT-ORDERED governed-source gaps (AC6), most material first. */
  readonly rankedSourceGaps: readonly RankedGapVM[];
  /** Posture CONFIDENCE. */
  readonly confidence: PostureConfidenceVM;
  /** GAP TRENDS per class. */
  readonly trends: readonly GapTrendVM[];
  /** The ISO instant of the earlier baseline snapshot the trends compare against. */
  readonly baselineAtIso: string;
  /** The ISO instant of the current snapshot. */
  readonly currentAtIso: string;
  /** The service's content digest at the current instant — an independent effect witness. */
  readonly snapshotDigest: string;
}

/**
 * An EMPTY-but-valid model. The view renders this only when none is injected; the regions frame
 * their headers/captions but carry no rows, so an un-fed view CANNOT masquerade as a satisfied
 * posture (every row-count / summary assertion fails against it).
 */
export const EMPTY_POSTURE: ExecutivePostureModel = {
  currentState: {
    generatedAtIso: POSTURE_TENANT.generatedAt,
    inventory: [],
    coverageGaps: [],
    discoveredSources: [],
    sourceGaps: [],
    snapshotDigest: 'empty',
  },
  summary: {
    confirmedHealthyCount: 0,
    unknownCount: 0,
    coverageGapCount: 0,
    sourceGapCount: 0,
    totalItems: 0,
    narrative: 'No governance posture has been derived yet.',
  },
  rankedCoverageGaps: [],
  rankedSourceGaps: [],
  confidence: {
    aggregate: 0,
    band: 'low',
    lowConfidenceRowCount: 0,
    rationale: 'No rows have been observed.',
  },
  trends: [],
  baselineAtIso: POSTURE_TENANT.generatedAt,
  currentAtIso: POSTURE_TENANT.generatedAt,
  snapshotDigest: 'empty',
} as const;

// ── Props ──────────────────────────────────────────────────────────────────────────────────────

export interface ExecutivePostureProps {
  readonly tenant: TenantScope;
  readonly model: ExecutivePostureModel;
}

export const DEFAULT_POSTURE_PROPS: ExecutivePostureProps = {
  tenant: POSTURE_TENANT,
  model: EMPTY_POSTURE,
} as const;

// ── Executive-addition region renderers (pure projections) ──────────────────────────────────────

/** The executive posture SUMMARY region: aggregate figures, each machine-readable via data-*. */
function summaryRegion(m: ExecutivePostureModel): string {
  const s = m.summary;
  return `
      <section id="region-posture-summary" aria-labelledby="sum-h" data-testid="posture-summary" tabindex="-1">
        <h2 id="sum-h">Executive posture summary</h2>
        <p data-testid="posture-narrative">${esc(s.narrative)}</p>
        <dl
          data-testid="posture-summary-figures"
          data-confirmed-healthy="${s.confirmedHealthyCount}"
          data-unknown="${s.unknownCount}"
          data-coverage-gaps="${s.coverageGapCount}"
          data-source-gaps="${s.sourceGapCount}"
          data-total-items="${s.totalItems}"
        >
          <div class="fig-row">
            <dt>Confirmed healthy</dt>
            <dd data-testid="fig-confirmed-healthy">${s.confirmedHealthyCount}</dd>
          </div>
          <div class="fig-row">
            <dt>Unknown (stale — not inferred healthy)</dt>
            <dd data-testid="fig-unknown">${s.unknownCount}</dd>
          </div>
          <div class="fig-row">
            <dt>Open coverage gaps</dt>
            <dd data-testid="fig-coverage-gaps">${s.coverageGapCount}</dd>
          </div>
          <div class="fig-row">
            <dt>Open governed-source gaps</dt>
            <dd data-testid="fig-source-gaps">${s.sourceGapCount}</dd>
          </div>
          <div class="fig-row">
            <dt>Total governed items</dt>
            <dd data-testid="fig-total-items">${s.totalItems}</dd>
          </div>
        </dl>
      </section>`;
}

/** The posture CONFIDENCE region: aggregate confidence + band + rationale (non-color). */
function confidenceRegion(m: ExecutivePostureModel): string {
  const c = m.confidence;
  return `
      <section id="region-posture-confidence" aria-labelledby="conf-h" data-testid="posture-confidence" tabindex="-1">
        <h2 id="conf-h">Posture confidence</h2>
        <p
          data-testid="posture-confidence-line"
          data-confidence="${c.aggregate.toFixed(2)}"
          data-confidence-band="${esc(c.band)}"
          data-low-confidence-rows="${c.lowConfidenceRowCount}"
        >
          <span class="badge badge--conf" data-confidence-band="${esc(c.band)}" aria-hidden="true"></span>
          Aggregate confidence in the displayed posture is
          <strong data-testid="confidence-value">${c.aggregate.toFixed(2)}</strong>
          (<span data-testid="confidence-band">${esc(c.band)}</span>).
          <span data-testid="confidence-low-rows">${c.lowConfidenceRowCount}</span> row(s) sit below full
          confidence. ${esc(c.rationale)}
        </p>
      </section>`;
}

/** Render one business-impact-ordered gap table (shared by AC2 coverage + AC6 source lists). */
function rankedGapTable(opts: {
  readonly regionId: string;
  readonly testid: string;
  readonly headingId: string;
  readonly heading: string;
  readonly caption: string;
  readonly subjectHeader: string;
  readonly showReview: boolean;
  readonly gaps: readonly RankedGapVM[];
}): string {
  const rows = opts.gaps
    .map(
      (g, i) => `
        <tr data-testid="ranked-gap-row" data-impact-rank="${g.impactRank}" data-order-index="${i}" data-impact-band="${esc(g.impactBand)}">
          <td data-testid="rank-position">${i + 1}</td>
          <th scope="row">${esc(g.subject)}</th>
          <td>
            <span class="badge badge--band" data-impact-band="${esc(g.impactBand)}" aria-hidden="true"></span>
            <span data-testid="ranked-gap-impact">${esc(g.impactBand)} impact (rank ${g.impactRank})</span>
          </td>
          <td data-testid="ranked-gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td>${g.ageDays} day(s)</td>
          <td>${esc(g.requiredOwnerAction)}</td>${
            opts.showReview
              ? `\n          <td data-testid="ranked-gap-review">${esc(g.reviewOrExpiry)}</td>`
              : ''
          }
        </tr>`,
    )
    .join('');
  const reviewHead = opts.showReview ? '\n              <th scope="col">Review / expiry</th>' : '';
  return `
      <section id="${opts.regionId}" aria-labelledby="${opts.headingId}" data-testid="${opts.testid}" tabindex="-1">
        <h2 id="${opts.headingId}">${esc(opts.heading)}</h2>
        <p data-testid="${opts.testid}-note">Ordered most business-material first (business-impact rank = gap impact × subject risk). Every gap stays visible; ordering never hides one.</p>
        <table>
          <caption>${esc(opts.caption)}</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">${esc(opts.subjectHeader)}</th>
              <th scope="col">Business impact</th>
              <th scope="col">Reason</th>
              <th scope="col">Age</th>
              <th scope="col">Required owner action</th>${reviewHead}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

/** The GAP TRENDS region: per-class movement between baseline and current snapshots. */
function trendsRegion(m: ExecutivePostureModel): string {
  const rows = m.trends
    .map(
      (t) => `
        <tr data-testid="gap-trend-row" data-gap-class="${esc(t.gapClass)}" data-direction="${esc(t.direction)}" data-delta="${t.delta}" data-aged="${t.agedCount}">
          <th scope="row">${esc(t.label)}</th>
          <td data-testid="trend-baseline">${t.baselineCount}</td>
          <td data-testid="trend-current">${t.currentCount}</td>
          <td data-testid="trend-delta">${t.delta > 0 ? '+' : ''}${t.delta}</td>
          <td data-testid="trend-aged">${t.agedCount}</td>
          <td>
            <span class="badge badge--trend" data-direction="${esc(t.direction)}" aria-hidden="true"></span>
            <span data-testid="trend-summary">${esc(t.direction)}: ${esc(t.summary)}</span>
          </td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-gap-trends" aria-labelledby="trend-h" data-testid="gap-trends" tabindex="-1">
        <h2 id="trend-h">Gap trends</h2>
        <p data-testid="gap-trends-window">
          Movement from the baseline snapshot
          <time datetime="${esc(m.baselineAtIso)}" data-testid="trend-baseline-at">${esc(m.baselineAtIso)}</time>
          to the current snapshot
          <time datetime="${esc(m.currentAtIso)}" data-testid="trend-current-at">${esc(m.currentAtIso)}</time>.
          Direction meaning is in the TEXT, not the arrow colour.
        </p>
        <table>
          <caption>Gap trend by class (baseline count, current count, delta, newly aged, direction)</caption>
          <thead>
            <tr>
              <th scope="col">Gap class</th>
              <th scope="col">Baseline</th>
              <th scope="col">Current</th>
              <th scope="col">Delta</th>
              <th scope="col">Newly aged</th>
              <th scope="col">Direction</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

// ── Current-state region renderers (AC1–AC6) — pure projections of the injected model ────────────

function inventoryRegion(m: CurrentStateModel): string {
  const rows = m.inventory
    .map(
      (i: InventoryRowVM) => `
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
          <td data-testid="row-confidence">${i.confidence.toFixed(2)}</td>
          <td><time datetime="${esc(i.lastObservedAt)}">${esc(i.lastObservedAt)}</time></td>
          <td>${i.unresolvedIssues === 0 ? 'none' : `${i.unresolvedIssues} unresolved`}</td>
        </tr>`,
    )
    .join('');
  return `
      <section id="region-inventory" aria-labelledby="inv-h" data-testid="reconciled-inventory" tabindex="-1">
        <h2 id="inv-h">Reconciled inventory — healthy items</h2>
        <p id="inv-summary" data-testid="inventory-count">${m.inventory.length} confirmed-healthy governed item(s), each shown once with its authoritative fields.</p>
        <table aria-describedby="inv-summary">
          <caption>Confirmed-healthy governed inventory (type, source identity, owner, lifecycle, risk, control coverage, evidence state, health, confidence, last observation, unresolved issues)</caption>
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
              <th scope="col">Confidence</th>
              <th scope="col">Last observation time</th>
              <th scope="col">Unresolved issues</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function drilldownRegion(m: CurrentStateModel): string {
  const dd: DrillDownVM | undefined = m.drilldown;
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
      (d: DiscoveredSourceVM) => `
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

// ── Chrome ───────────────────────────────────────────────────────────────────────────────────────

/** The tenant-scope banner: a machine-readable identity binding + human tenant label. */
function tenantScopeBanner(tenant: TenantScope): string {
  return `
      <section
        aria-labelledby="scope-h"
        data-testid="tenant-scope"
        data-tenant-id="${esc(tenant.tenantId)}"
        data-bundle-id="${esc(tenant.bundleId)}"
        data-semantic-hash="${esc(tenant.semanticHash)}"
        data-work-item-id="${esc(tenant.workItemId)}"
        data-role="executive"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">executive</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
          <div class="scope-row"><dt>Work item</dt><dd data-testid="scope-work-item"><code>${esc(tenant.workItemId)}</code></dd></div>
          <div class="scope-row"><dt>Scope generated</dt><dd><time datetime="${esc(tenant.generatedAt)}" data-testid="scope-generated-at">${esc(tenant.generatedAt)}</time></dd></div>
        </dl>
      </section>`;
}

// ── The view ───────────────────────────────────────────────────────────────────────────────────

/**
 * Render the complete accessible EXECUTIVE POSTURE view as a standalone HTML document, PRESENTING
 * the injected `props.model`. Mounted in-browser via `page.setContent(renderExecutivePosture(props))`.
 * Single-column and wrapping (no fixed pixel widths that force horizontal scroll at 400% zoom), with
 * a visible focus indicator so keyboard focus is never invisible.
 *
 * Order: skip link → tenant-scope banner → global status → `<main>` framing the executive additions
 * (summary, confidence, business-impact-ordered gaps, trends) then the AC1–AC6 current-state regions.
 */
export function renderExecutivePosture(
  props: ExecutivePostureProps = DEFAULT_POSTURE_PROPS,
): string {
  const { tenant } = props;
  const m = props.model;
  const cs = m.currentState;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} executive posture</title>
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
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #999; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .scope-row, .fig-row { display: flex; flex-direction: column; }
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
    .badge--band { background: #b3261e; }
    .badge--trend { background: #444; }
    .badge--conf { background: #a15c00; }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="posture-title">${esc(tenant.tenantName)} — executive posture</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status" data-confidence-band="${esc(m.confidence.band)}">
      <span data-testid="global-status-text">${esc(m.summary.narrative)}</span>
      <span>Aggregate confidence: <span data-testid="global-status-confidence">${m.confidence.aggregate.toFixed(2)}</span> (${esc(m.confidence.band)}).</span>
    </div>
  </header>
  <main id="main" tabindex="-1" data-testid="posture-main" data-role="executive" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${summaryRegion(m)}
    ${confidenceRegion(m)}
    ${rankedGapTable({
      regionId: 'region-ranked-coverage-gaps',
      testid: 'ranked-coverage-gaps',
      headingId: 'rcg-h',
      heading: 'Coverage gaps — by business impact',
      caption:
        'Coverage gaps ordered most business-material first (business impact, reason, age, required owner action)',
      subjectHeader: 'Component',
      showReview: false,
      gaps: m.rankedCoverageGaps,
    })}
    ${rankedGapTable({
      regionId: 'region-ranked-source-gaps',
      testid: 'ranked-source-gaps',
      headingId: 'rsg-h',
      heading: 'Governed-source gaps — by business impact',
      caption:
        'Governed-source gaps ordered most business-material first (business impact, reason, age, owner action, review or expiry)',
      subjectHeader: 'Source',
      showReview: true,
      gaps: m.rankedSourceGaps,
    })}
    ${trendsRegion(m)}
    ${inventoryRegion(cs)}
    ${drilldownRegion(cs)}
    ${freshnessRegion(cs)}
    ${catalogRegion(cs)}
  </main>
  <footer>
    <p data-testid="posture-footer">
      Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · executive posture.
    </p>
  </footer>
</body>
</html>`;
}

/**
 * Default export: the executive-posture renderer. The accessible contract is
 * `renderExecutivePosture`; a framework adopter wraps it and injects a derived `model`.
 */
export default renderExecutivePosture;
