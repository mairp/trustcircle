// TrustCircleAI — COVERAGE / GOVERNED-SOURCE GAP COMMAND surface (Phase 81 /
// apps/web/src/features/gaps/CoverageGaps.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer's GAP-CENTRIC command surface. Where the Phase-79 InventoryTable answers "find and
// compare the governed items / sources I care about" and the Phase-80 InventoryDetail answers
// "show me everything about ONE item", THIS view answers the question the officer asks when they
// want to WORK THE BACKLOG OF GAPS: "of everything discovered inside my boundary, what is NOT yet
// safely governed — and what is the safe next thing to do about each?"
//
// It organises every still-visible coverage / governed-source gap into the SEVEN operator views the
// Phase-81 objective names, each with an explicit SAFE NEXT ACTION:
//   • OWNERSHIP     — sources/components with no accountable owner (reason `unowned`; catalog
//                     ownership gap). Safe action: assign an accountable owner.
//   • ACCESS        — sources that cannot be reached / are access-withheld (reason `inaccessible`).
//                     Safe action: request scoped access — never assume compliant.
//   • UNSUPPORTED   — sources of a type no adapter supports yet (reason `unsupported`, `unknown`
//                     class). Safe action: file an adapter request / manual attestation.
//   • EXCLUSION     — sources explicitly excluded by an approved scope decision (reason `excluded`,
//                     onboarding `excluded`). Safe action: confirm the exclusion still holds at review.
//   • CONFLICT      — items whose registered sources reported DIFFERENT values (a status difference
//                     the correlation could not settle). Safe action: reconcile the authoritative
//                     value; automation stays PAUSED until a human resolves it.
//   • FRESHNESS     — sources whose observation is STALE / unavailable (reason `stale`). Safe action:
//                     re-probe; treat last-known data as last-known — health is NOT inferred.
//   • SCAN-GAP      — sources a connector could not scan (missed health probes; reason `unreachable`).
//                     Safe action: restore the connector; the item stays a gap, never "healthy".
//
// Every view is FAIL-VISIBLE: a gap is never shown healthy and never silently disappears — it stays
// on this surface with its reason, age, impact, required owner action, and (for governed-source gaps)
// its review-or-expiry deadline, exactly as the six current-state acceptance criteria demand:
//   • AC1 — a healthy, fully-governed item is NOT a gap; the "no gaps in this category" affordance
//     confirms the officer that nothing is outstanding there (each governed item still appears once
//     with its full identity in the sibling table/detail views — this surface is the gap backlog).
//   • AC2 — a discovered-but-unmanaged / unreachable / stale / orphaned / excluded COMPONENT stays a
//     visible coverage gap with reason, age, impact, and required owner action.
//   • AC3 — the CONFLICT view drills into the distinct source records that DISAGREE (Kanban /
//     agentctl / workflows_orchestration), showing the correlation, the status differences, and the
//     authoritative field — so a conflict is actionable, not a mystery.
//   • AC4 — the FRESHNESS view marks stale data with its last-known time and confidence and refuses
//     to infer current health from it (the reported health is withheld as `unknown`).
//   • AC5 — every governed-source gap names the discovered source's classification (type or
//     `unknown`), location, access status, sensitivity, ownership status, and onboarding state, plus
//     its discovery evidence — the same catalog facets discovery recorded.
//   • AC6 — an unsupported / inaccessible / sensitive / unowned / excluded discovered source stays a
//     visible governed-source gap with reason, impact, owner action, and review-or-expiry.
//
// THIS VIEW IS A PURE PRESENTER — it does NOT compute the gaps. `renderCoverageGaps(props)` renders
// whatever `CoverageGapsModel` it is handed. That model is DERIVED elsewhere
// (tests/accessibility/support/coverage-gaps-model.ts) by running the REAL Phase-70 current-inventory
// assembly service (packages/application/src/inventory-service.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — over an explicit deterministic scenario, and projecting
// the service's OWN `componentGaps()` / `governedSourceGaps()` / `catalogView()` / `drillDown()` /
// `currentStateView()` outputs into the seven views. Every value this view shows is therefore a
// projection of a value the service COMPUTED — the presenter invents nothing.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (and not JSX/React). apps/web has not adopted a React runtime
// yet, and the repo's TypeScript base sets no `jsx` runtime — a JSX element would not compile. The
// accessible CONTRACT of this view is specifiable now: this module expresses it as a pure,
// deterministic renderer returning the exact accessible markup the shipped React view must reproduce.
// Because the output is a self-contained HTML string, the Phase-81 accessibility spec mounts it in a
// REAL browser via `page.setContent(renderCoverageGaps(props))` and asserts — through axe-core and the
// live accessibility tree — every obligation, with NO web server, NO React, and NO tenant-auth.
//
// DETERMINISM. Pure string builders over the injected model. No wall clock, no randomness, no network,
// no module-level mutable state — same props ⇒ byte-identical output.

import type {
  CoverageGapVM,
  SourceGapVM,
  DiscoveredSourceVM,
  TenantScope,
} from '../../app/layout.tsx';

export type { CoverageGapVM, SourceGapVM, DiscoveredSourceVM, TenantScope };

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
// The gap command surface is bound to exactly one governance bundle. Rendering the bundle id +
// semantic hash + work item as machine-readable, independently-readable DOM (a `<dl>` with data
// attributes, not a mutation-response echo) is the DURABLE IDENTITY witness the phase's effect-witness
// obligations require: a value observable through an independent read path, and REJECTABLE when it
// differs from the pinned input.

/** The one tenant scope this view is pinned to (work item JK8KW3GR9WQHKGEAHJ53X75MC3). */
export const GAPS_TENANT: TenantScope = {
  tenantId: 'tnt-acme-governance',
  tenantName: 'Acme Governance',
  bundleId: '36GCYGDJ15PTYP60F91QWRAY2M',
  semanticHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
  workItemId: 'JK8KW3GR9WQHKGEAHJ53X75MC3',
  generatedAt: '2026-07-31T09:20:00Z',
} as const;

// ── The seven gap-category views ────────────────────────────────────────────────────────────────

/** The stable ids of the seven operator gap views (also the DOM region ids). */
export const GAP_VIEW_IDS = [
  'ownership',
  'access',
  'unsupported',
  'exclusion',
  'conflict',
  'freshness',
  'scan-gap',
] as const;
export type GapViewId = (typeof GAP_VIEW_IDS)[number];

// ── Gap-category view models (render-ready reductions of the REAL service outputs) ───────────────
//
// These shapes are produced by tests/accessibility/support/coverage-gaps-model.ts#deriveCoverageGaps(),
// which runs the Phase-70 `InventoryService` and projects its `componentGaps()` / `governedSourceGaps()`
// / `catalogView()` / `drillDown()` / `currentStateView()` outputs into the panels below. Every field
// is a projection of a value the service COMPUTED — the presenter invents nothing.

/** One governed-source gap enriched with the discovered source's catalog facets + a safe next action. */
export interface SourceGapEntryVM {
  /** The AC6 governed-source gap (reason / impact / owner action / review-or-expiry). */
  readonly gap: SourceGapVM;
  /** AC5: the discovered source's catalog facets (classification/location/access/sensitivity/…). */
  readonly source: DiscoveredSourceVM;
  /** AC6 gap age in whole days at the read instant. */
  readonly ageDays: number;
  /** The SAFE next action for this gap (never "assume compliant"). */
  readonly safeAction: string;
  /** True iff the source's class is authoritatively classified (false ⇒ still `unknown`). */
  readonly classified: boolean;
  /** True iff no accountable owner is recorded (ownership gap). */
  readonly ownershipGap: boolean;
}

/** One component coverage gap enriched with a safe next action (AC2). */
export interface ComponentGapEntryVM {
  readonly gap: CoverageGapVM;
  /** The SAFE next action for this component gap. */
  readonly safeAction: string;
}

/** One item whose registered sources DISAGREE (a status difference; AC3 conflict view). */
export interface ConflictEntryVM {
  readonly assetId: string;
  readonly assetName: string;
  /** The contested field's name (e.g. `status`). */
  readonly field: string;
  /** The authoritative value the correlation resolved (or "unresolved"). */
  readonly authoritativeValue: string;
  /** The authoritative source class (system-of-record), or "—". */
  readonly authoritativeSourceClass: string;
  /** True iff the field is unresolved (no safe single value) → automation paused. */
  readonly unresolved: boolean;
  /** The distinct source records that reported DIFFERENT values (source class + value). */
  readonly differingSources: readonly { readonly sourceClass: string; readonly value: string }[];
  /** The SAFE next action (reconcile; automation stays paused). */
  readonly safeAction: string;
}

/** One item / source whose observation is STALE (AC4 freshness view) — health NOT inferred. */
export interface FreshnessEntryVM {
  readonly subjectId: string;
  readonly subjectName: string;
  /** The health SAFE to report (`unknown` when withheld) vs. the health last observed. */
  readonly reportedHealth: string;
  readonly observedHealth: string;
  /** True iff the reported health was WITHHELD (evidence not current). */
  readonly healthWithheld: boolean;
  /** The last-known ISO time (an independent effect witness for staleness). */
  readonly lastKnownAtIso: string;
  /** Confidence ∈ [0,1] in the last-known reading. */
  readonly confidence: number;
  /** The SAFE next action (re-probe; treat last-known as last-known). */
  readonly safeAction: string;
}

/** The whole gap command model — the seven views + the effect witness. */
export interface CoverageGapsModel {
  // AC2 / scan-gap / freshness component gaps, grouped for the ownership/access/etc. views by reason.
  readonly componentGaps: readonly ComponentGapEntryVM[];
  // AC5/AC6 governed-source gaps enriched with catalog facets.
  readonly sourceGaps: readonly SourceGapEntryVM[];
  // AC3 conflict view.
  readonly conflicts: readonly ConflictEntryVM[];
  // AC4 freshness view.
  readonly freshness: readonly FreshnessEntryVM[];
  /** The total count of still-visible gaps across all views (the backlog size). */
  readonly totalGapCount: number;
  /** The ISO instant this projection was derived at. */
  readonly generatedAtIso: string;
  /** The service's content digest at the current instant — an independent effect witness. */
  readonly snapshotDigest: string;
}

/**
 * An EMPTY-but-valid model. The view renders this only when none is injected; the seven views frame
 * their headers/captions but carry no gap rows, so an un-fed view CANNOT masquerade as a satisfied gap
 * backlog (every gap-count assertion fails against it).
 */
export const EMPTY_COVERAGE_GAPS: CoverageGapsModel = {
  componentGaps: [],
  sourceGaps: [],
  conflicts: [],
  freshness: [],
  totalGapCount: 0,
  generatedAtIso: GAPS_TENANT.generatedAt,
  snapshotDigest: 'empty',
} as const;

// ── Props ──────────────────────────────────────────────────────────────────────────────────────

export interface CoverageGapsProps {
  readonly tenant: TenantScope;
  readonly model: CoverageGapsModel;
}

export const DEFAULT_COVERAGE_GAPS_PROPS: CoverageGapsProps = {
  tenant: GAPS_TENANT,
  model: EMPTY_COVERAGE_GAPS,
} as const;

// ── Which gap reason maps to which operator view ────────────────────────────────────────────────
//
// The seven views are reason-partitioned. `unowned` → ownership; `inaccessible` → access;
// `unsupported` → unsupported; `excluded` → exclusion; `stale` → freshness; `unreachable` → scan-gap.
// A source gap with a reason not otherwise mapped (e.g. `sensitive`) lands in the access view (its
// access is withheld pending review). CONFLICT is not a gap reason — it is derived from the
// correlation's contested/unresolved fields (AC3) — and FRESHNESS additionally lists the stale item.

const SOURCE_GAP_VIEW: Readonly<Record<string, GapViewId>> = {
  unowned: 'ownership',
  inaccessible: 'access',
  sensitive: 'access',
  unsupported: 'unsupported',
  excluded: 'exclusion',
  stale: 'freshness',
  unreachable: 'scan-gap',
  unmanaged: 'unsupported',
  orphaned: 'scan-gap',
};

const COMPONENT_GAP_VIEW: Readonly<Record<string, GapViewId>> = {
  unmanaged: 'ownership',
  unreachable: 'scan-gap',
  stale: 'freshness',
  orphaned: 'scan-gap',
  excluded: 'exclusion',
  unowned: 'ownership',
  inaccessible: 'access',
  unsupported: 'unsupported',
  sensitive: 'access',
};

function sourceGapsFor(m: CoverageGapsModel, view: GapViewId): readonly SourceGapEntryVM[] {
  return m.sourceGaps.filter((e) => SOURCE_GAP_VIEW[e.gap.reasonClass] === view);
}

function componentGapsFor(m: CoverageGapsModel, view: GapViewId): readonly ComponentGapEntryVM[] {
  return m.componentGaps.filter((e) => COMPONENT_GAP_VIEW[e.gap.reasonClass] === view);
}

// ── Human copy for each view (title + what it is + the empty-state affordance) ────────────────────

interface ViewCopy {
  readonly title: string;
  readonly intro: string;
  /** The reassurance shown when a category has NO outstanding gap (AC1: healthy ⇒ not a gap). */
  readonly emptyText: string;
}

const VIEW_COPY: Readonly<Record<GapViewId, ViewCopy>> = {
  ownership: {
    title: 'Ownership gaps',
    intro:
      'Discovered items and sources with no accountable owner. Governance cannot be delegated without one, so each stays a visible gap until an owner is assigned.',
    emptyText: 'No ownership gaps: every governed item and source has an accountable owner.',
  },
  access: {
    title: 'Access gaps',
    intro:
      'Sources that cannot be reached, or whose access is withheld pending review. Access is never assumed — an unreachable source is a gap, not a compliant one.',
    emptyText: 'No access gaps: every discovered source is reachable within its access scope.',
  },
  unsupported: {
    title: 'Unsupported gaps',
    intro:
      'Sources of a type no adapter supports yet (classified unknown), or discovered but never onboarded to a governed source contract. Each stays visible until an adapter or manual attestation covers it.',
    emptyText: 'No unsupported gaps: every discovered source type has a supporting adapter.',
  },
  exclusion: {
    title: 'Exclusion gaps',
    intro:
      'Sources explicitly excluded by an approved scope decision. An exclusion is not a disappearance — it stays visible with the reason and a review/expiry so the decision is re-confirmed.',
    emptyText: 'No exclusion gaps: no source is currently held out of scope.',
  },
  conflict: {
    title: 'Conflict gaps',
    intro:
      'Items whose registered sources — Kanban, agentctl, workflows_orchestration — reported DIFFERENT values for a governed field. The correlation cannot settle a single safe value, so automation stays PAUSED until a human reconciles it.',
    emptyText: 'No conflict gaps: every governed field resolves to a single authoritative value.',
  },
  freshness: {
    title: 'Freshness gaps',
    intro:
      'Sources whose observation is stale or unavailable. The data is shown WITH its last-known time and confidence, and current health is NOT inferred from it — a stale reading is last-known, never current.',
    emptyText: 'No freshness gaps: every source has been observed within the freshness horizon.',
  },
  'scan-gap': {
    title: 'Scan gaps',
    intro:
      'Sources a connector could not scan — missed health probes or orphaned evidence. The item stays a gap (never silently "healthy") until the connector is restored.',
    emptyText: 'No scan gaps: every connector completed its most recent scan.',
  },
};

// ── Shared row renderers ──────────────────────────────────────────────────────────────────────────

/** One governed-source gap row: AC5 catalog facets + AC6 reason/impact/action/review + safe action. */
function sourceGapRow(e: SourceGapEntryVM): string {
  const g = e.gap;
  const s = e.source;
  return `
        <tr data-testid="source-gap-row" data-gap-id="${esc(g.id)}" data-reason="${esc(g.reasonClass)}"
          data-impact="${esc(g.impact)}" data-has-review="${g.hasReviewOrExpiry ? 'true' : 'false'}"
          data-classified="${e.classified ? 'true' : 'false'}" data-ownership-gap="${e.ownershipGap ? 'true' : 'false'}"
          data-age-days="${e.ageDays}">
          <th scope="row" data-testid="source-gap-source">${esc(g.source)}</th>
          <td data-testid="source-gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td data-testid="source-gap-classification" data-classified="${e.classified ? 'true' : 'false'}">${esc(s.classification)}</td>
          <td data-testid="source-gap-location">${esc(s.location)}</td>
          <td data-testid="source-gap-access">${esc(s.accessStatus)}</td>
          <td data-testid="source-gap-sensitivity">${esc(s.sensitivity)}</td>
          <td data-testid="source-gap-ownership" data-ownership-gap="${e.ownershipGap ? 'true' : 'false'}">${esc(s.ownershipStatus)}</td>
          <td data-testid="source-gap-onboarding">${esc(s.onboardingState)}</td>
          <td data-testid="source-gap-impact">${esc(g.impact)}</td>
          <td>${e.ageDays} day(s)</td>
          <td data-testid="source-gap-review">${esc(g.reviewOrExpiry)}</td>
          <td data-testid="source-gap-discovery-evidence">${
            s.discoveryEvidenceRef
              ? `<a href="#${esc(s.discoveryEvidenceRef)}">${esc(s.discoveryEvidenceRef)}</a>`
              : '<span data-testid="source-gap-no-evidence">no discovery evidence</span>'
          }</td>
          <td data-testid="source-gap-owner-action">${esc(g.ownerAction)}</td>
          <td data-testid="source-gap-safe-action"><strong>Safe next action:</strong> ${esc(e.safeAction)}</td>
        </tr>`;
}

/** One component coverage gap row: AC2 reason/age/impact/owner-action + safe action. */
function componentGapRow(e: ComponentGapEntryVM): string {
  const g = e.gap;
  return `
        <tr data-testid="component-gap-row" data-gap-id="${esc(g.id)}" data-reason="${esc(g.reasonClass)}"
          data-impact="${esc(g.impact)}" data-age-days="${g.ageDays}">
          <th scope="row" data-testid="component-gap-component">${esc(g.component)}</th>
          <td data-testid="component-gap-reason">${esc(g.reasonClass)}: ${esc(g.reasonText)}</td>
          <td>${g.ageDays} day(s)</td>
          <td data-testid="component-gap-impact">${esc(g.impact)}</td>
          <td data-testid="component-gap-owner-action">${esc(g.requiredOwnerAction)}</td>
          <td data-testid="component-gap-safe-action"><strong>Safe next action:</strong> ${esc(e.safeAction)}</td>
        </tr>`;
}

/** A gap-category section for the reason-partitioned views (ownership/access/unsupported/exclusion/scan-gap). */
function gapCategorySection(m: CoverageGapsModel, view: GapViewId): string {
  const copy = VIEW_COPY[view];
  const src = sourceGapsFor(m, view);
  const comp = componentGapsFor(m, view);
  const count = src.length + comp.length;
  const hId = `gap-${view}-h`;
  const body =
    count === 0
      ? `<p data-testid="gap-empty-${view}" data-gap-count="0">${esc(copy.emptyText)}</p>`
      : `
        ${
          comp.length
            ? `<table aria-describedby="gap-${view}-summary" data-testid="gap-component-table-${view}">
          <caption>Component coverage gaps in this category (component, reason, age, impact, required owner action, safe next action)</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Reason</th>
              <th scope="col">Age</th>
              <th scope="col">Impact</th>
              <th scope="col">Required owner action</th>
              <th scope="col">Safe next action</th>
            </tr>
          </thead>
          <tbody>${comp.map(componentGapRow).join('')}</tbody>
        </table>`
            : ''
        }
        ${
          src.length
            ? `<table aria-describedby="gap-${view}-summary" data-testid="gap-source-table-${view}">
          <caption>Governed-source gaps in this category (source, reason, classification, location, access, sensitivity, ownership, onboarding, impact, age, review/expiry, discovery evidence, owner action, safe next action)</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Reason</th>
              <th scope="col">Classification</th>
              <th scope="col">Location</th>
              <th scope="col">Access</th>
              <th scope="col">Sensitivity</th>
              <th scope="col">Ownership</th>
              <th scope="col">Onboarding</th>
              <th scope="col">Impact</th>
              <th scope="col">Age</th>
              <th scope="col">Review / expiry</th>
              <th scope="col">Discovery evidence</th>
              <th scope="col">Required owner action</th>
              <th scope="col">Safe next action</th>
            </tr>
          </thead>
          <tbody>${src.map(sourceGapRow).join('')}</tbody>
        </table>`
            : ''
        }`;
  return `
      <section id="region-${view}" aria-labelledby="${hId}" data-testid="gap-view-${view}" tabindex="-1"
        data-view="${view}" data-gap-count="${count}">
        <h2 id="${hId}">${esc(copy.title)}</h2>
        <p id="gap-${view}-summary" data-testid="gap-summary-${view}" data-gap-count="${count}">
          ${esc(copy.intro)} ${count} outstanding gap(s) in this view.
        </p>
        ${body}
      </section>`;
}

// ── AC3 — the CONFLICT view (items whose sources disagree) ────────────────────────────────────────

function conflictSection(m: CoverageGapsModel): string {
  const copy = VIEW_COPY.conflict;
  const rows = m.conflicts
    .map(
      (c) => `
        <tr data-testid="conflict-row" data-asset-id="${esc(c.assetId)}" data-field="${esc(c.field)}"
          data-unresolved="${c.unresolved ? 'true' : 'false'}"
          data-differing-count="${c.differingSources.length}">
          <th scope="row" data-testid="conflict-asset">${esc(c.assetName)}</th>
          <td data-testid="conflict-field">${esc(c.field)}</td>
          <td data-testid="conflict-authoritative-value">${esc(c.authoritativeValue)}</td>
          <td data-testid="conflict-authoritative-source">${esc(c.authoritativeSourceClass)}</td>
          <td data-testid="conflict-differing">
            <ul class="differing" data-testid="conflict-differing-list">${c.differingSources
              .map(
                (d) => `
              <li data-testid="conflict-differing-source" data-source-class="${esc(d.sourceClass)}">
                <span data-testid="conflict-differing-class">${esc(d.sourceClass)}</span> reported
                <strong data-testid="conflict-differing-value">${esc(d.value)}</strong>
              </li>`,
              )
              .join('')}
            </ul>
          </td>
          <td data-testid="conflict-automation" data-unresolved="${c.unresolved ? 'true' : 'false'}">${
            c.unresolved ? 'PAUSED — unresolved' : 'contested — awaiting reconcile'
          }</td>
          <td data-testid="conflict-safe-action"><strong>Safe next action:</strong> ${esc(c.safeAction)}</td>
        </tr>`,
    )
    .join('');
  const body =
    m.conflicts.length === 0
      ? `<p data-testid="gap-empty-conflict" data-gap-count="0">${esc(copy.emptyText)}</p>`
      : `<table aria-describedby="gap-conflict-summary" data-testid="conflict-table">
          <caption>Items whose registered sources reported different values (item, field, authoritative value, authoritative source, differing sources, automation state, safe next action)</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Field</th>
              <th scope="col">Authoritative value</th>
              <th scope="col">Authoritative source</th>
              <th scope="col">Differing sources (status differences)</th>
              <th scope="col">Automation</th>
              <th scope="col">Safe next action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-conflict" aria-labelledby="gap-conflict-h" data-testid="gap-view-conflict" tabindex="-1"
        data-view="conflict" data-gap-count="${m.conflicts.length}">
        <h2 id="gap-conflict-h">${esc(copy.title)}</h2>
        <p id="gap-conflict-summary" data-testid="gap-summary-conflict" data-gap-count="${m.conflicts.length}">
          ${esc(copy.intro)} ${m.conflicts.length} outstanding conflict(s).
        </p>
        ${body}
      </section>`;
}

// ── AC4 — the FRESHNESS view (stale items; health NOT inferred) ───────────────────────────────────

function freshnessSection(m: CoverageGapsModel): string {
  const copy = VIEW_COPY.freshness;
  const rows = m.freshness
    .map(
      (f) => `
        <tr data-testid="freshness-row" data-subject-id="${esc(f.subjectId)}"
          data-health-withheld="${f.healthWithheld ? 'true' : 'false'}"
          data-reported-health="${esc(f.reportedHealth)}" data-observed-health="${esc(f.observedHealth)}">
          <th scope="row" data-testid="freshness-subject">${esc(f.subjectName)}</th>
          <td data-testid="freshness-reported-health" data-reported-health="${esc(f.reportedHealth)}">${esc(f.reportedHealth)}${
            f.healthWithheld
              ? ` <span class="visually-hidden" data-testid="freshness-withheld-note">(withheld as unknown; last observation recorded ${esc(
                  f.observedHealth,
                )} — not read as current)</span>`
              : ''
          }</td>
          <td><time datetime="${esc(f.lastKnownAtIso)}" data-testid="freshness-last-known">${esc(f.lastKnownAtIso)}</time></td>
          <td data-testid="freshness-confidence">${f.confidence.toFixed(2)}</td>
          <td data-testid="freshness-safe-action"><strong>Safe next action:</strong> ${esc(f.safeAction)}</td>
        </tr>`,
    )
    .join('');
  const body =
    m.freshness.length === 0
      ? `<p data-testid="gap-empty-freshness" data-gap-count="0">${esc(copy.emptyText)}</p>`
      : `<table aria-describedby="gap-freshness-summary" data-testid="freshness-table">
          <caption>Stale / unavailable sources shown with last-known time and confidence — current health is NOT inferred (subject, reported health, last known, confidence, safe next action)</caption>
          <thead>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">Reported health</th>
              <th scope="col">Last known</th>
              <th scope="col">Confidence</th>
              <th scope="col">Safe next action</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
  return `
      <section id="region-freshness" aria-labelledby="gap-freshness-h" data-testid="gap-view-freshness" tabindex="-1"
        data-view="freshness" data-gap-count="${m.freshness.length}">
        <h2 id="gap-freshness-h">${esc(copy.title)}</h2>
        <p id="gap-freshness-summary" data-testid="gap-summary-freshness" data-gap-count="${m.freshness.length}">
          ${esc(copy.intro)} ${m.freshness.length} stale source(s).
        </p>
        ${body}
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
        data-role="operator"
      >
        <h2 id="scope-h" class="visually-hidden">Tenant &amp; governance scope</h2>
        <dl>
          <div class="scope-row"><dt>Tenant</dt><dd data-testid="scope-tenant">${esc(tenant.tenantName)} (${esc(tenant.tenantId)})</dd></div>
          <div class="scope-row"><dt>Signed-in role</dt><dd data-testid="scope-role">operator</dd></div>
          <div class="scope-row"><dt>Governance bundle</dt><dd data-testid="scope-bundle"><code>${esc(tenant.bundleId)}</code></dd></div>
          <div class="scope-row"><dt>Semantic hash</dt><dd data-testid="scope-semantic-hash"><code>${esc(tenant.semanticHash)}</code></dd></div>
          <div class="scope-row"><dt>Work item</dt><dd data-testid="scope-work-item"><code>${esc(tenant.workItemId)}</code></dd></div>
          <div class="scope-row"><dt>Scope generated</dt><dd><time datetime="${esc(tenant.generatedAt)}" data-testid="scope-generated-at">${esc(tenant.generatedAt)}</time></dd></div>
        </dl>
      </section>`;
}

/** The in-page navigation across the seven gap views (each an anchor to its region). */
function viewNav(): string {
  const items = GAP_VIEW_IDS.map(
    (v) =>
      `<li><a href="#region-${v}" data-testid="gap-nav-${v}">${esc(VIEW_COPY[v].title)}</a></li>`,
  ).join('');
  return `
      <nav aria-labelledby="gap-nav-h" data-testid="gap-nav">
        <h2 id="gap-nav-h" class="visually-hidden">Gap views</h2>
        <ul>${items}</ul>
      </nav>`;
}

// ── The view ───────────────────────────────────────────────────────────────────────────────────

/**
 * Render the complete accessible COVERAGE / GOVERNED-SOURCE GAP command surface as a standalone HTML
 * document, PRESENTING the injected `props.model`. Mounted in-browser via
 * `page.setContent(renderCoverageGaps(props))`. Single-column and wrapping (no fixed pixel widths that
 * force horizontal scroll at 400% zoom), with a visible focus indicator so keyboard focus is never
 * invisible.
 *
 * Order: skip link → tenant-scope banner → global status → in-page nav → `<main>` framing the seven
 * gap views (ownership, access, unsupported, exclusion, conflict, freshness, scan-gap), each with its
 * safe next actions.
 */
export function renderCoverageGaps(props: CoverageGapsProps = DEFAULT_COVERAGE_GAPS_PROPS): string {
  const { tenant } = props;
  const m = props.model;
  const statusText = `Gap backlog: ${m.totalGapCount} outstanding gap(s) — ${m.sourceGaps.length} governed-source, ${m.componentGaps.length} component, ${m.conflicts.length} conflict, ${m.freshness.length} freshness. Nothing here is shown healthy; stale data is not read as current.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TrustCircle — ${esc(tenant.tenantName)} coverage gaps</title>
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
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; margin: .5rem 0 1rem; }
    th, td { border: 1px solid #767676; padding: .35rem .5rem; text-align: left; overflow-wrap: anywhere; vertical-align: top; }
    caption { text-align: left; font-weight: 600; margin-bottom: .25rem; }
    dl { margin: 0; display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; }
    .row, .scope-row { display: flex; flex-direction: column; }
    dt { font-weight: 600; }
    dd { margin: 0; }
    nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
    ul.differing { margin: 0; padding-left: 1.1rem; }
    ul.differing li { margin: .15rem 0; }
    a:focus-visible, button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 3px solid #0b57d0; outline-offset: 2px;
    }
    .skip-link { position: absolute; left: -9999px; }
    .skip-link:focus { position: static; left: auto; display: inline-block; padding: .35rem .6rem; }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    code { overflow-wrap: anywhere; word-break: break-all; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <a href="#main" class="skip-link" data-testid="skip-link">Skip to main content</a>
  <header>
    <h1 data-testid="gaps-title">${esc(tenant.tenantName)} — coverage &amp; governed-source gaps</h1>
    ${tenantScopeBanner(tenant)}
    <div id="global-status" role="status" aria-live="polite" data-testid="global-status">
      <span data-testid="global-status-text">${esc(statusText)}</span>
    </div>
    ${viewNav()}
  </header>
  <main id="main" tabindex="-1" data-testid="gaps-main" data-role="operator" data-total-gaps="${m.totalGapCount}" data-snapshot-digest="${esc(m.snapshotDigest)}">
    ${gapCategorySection(m, 'ownership')}
    ${gapCategorySection(m, 'access')}
    ${gapCategorySection(m, 'unsupported')}
    ${gapCategorySection(m, 'exclusion')}
    ${conflictSection(m)}
    ${freshnessSection(m)}
    ${gapCategorySection(m, 'scan-gap')}
  </main>
  <footer>
    <p data-testid="gaps-footer">
      Scoped to ${esc(tenant.tenantName)} · bundle <code>${esc(tenant.bundleId)}</code> · coverage &amp; governed-source gap backlog.
    </p>
  </footer>
</body>
</html>`;
}

/**
 * Default export: the coverage-gaps renderer. The accessible contract is `renderCoverageGaps`; a
 * framework adopter wraps it and injects a derived `model` (the gap backlog for the tenant).
 */
export default renderCoverageGaps;
