// TrustCircleAI — AVAILABILITY PROFILES presenter (Phase 8 / User Story 6 — Maintain Source and
// Workflow Health / T246 / apps/web/src/features/integrations/AvailabilityProfiles.tsx / NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer-facing AVAILABILITY PROFILES view: for each governed component it renders the
// availability CLASS (core / optional / on-demand), the live runtime STATE, the features that are
// currently UNAVAILABLE, the LAST-KNOWN evidence backing the reading, the ACTIVATION CONDITIONS an
// on-demand/optional component must satisfy before it may activate, and the ASSURANCE GAPS that keep
// it from being relied upon.
//
// THE CARDINAL POINT (NFR-010 / db/migrations/0060 component_activation): CORE HEALTH is shown
// SEPARATELY from OPTIONAL AVAILABILITY. The core-profile section reports whether the minimum
// platform is running; the optional/on-demand section reports enhancements whose loss degrades a
// feature but does NOT block the core. A reader can never confuse an optional outage for a core one,
// nor an on-demand component's dormancy for a failure. Availability is separate from design
// authority — a component's availability never grants it authority.
//
// PURE PRESENTER. The classes/states/gaps/conditions are NOT computed here — they come from the REAL
// component-profile projection upstream. This module renders whatever `AvailabilityProfilesModel` it
// is handed; it fabricates no state and never upgrades a stale/unavailable component to available.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every availability class, runtime state, and
// assurance-gap is spelled in words with a machine-readable data-attribute.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). This `.tsx` file contains NO JSX — it is a
// pure string-builder presenter (tsconfig `jsx:preserve` only satisfies the extension resolver).
//
// DETERMINISM. Pure string builders over the injected model. Same props ⇒ byte-identical output.

/** Escape text for safe insertion into HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── The availability-profiles model — a render-ready reduction, NOT recomputed here ───────────────

/** Runtime availability class (NFR-010 — separate from design authority). */
export type ProfileAvailabilityClass = 'core' | 'optional' | 'on-demand';

/** The live runtime state of a component (distinct from its design lifecycle). */
export type ProfileRuntimeState =
  | 'inactive'
  | 'activating'
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'paused';

/** A feature that is currently unavailable because a component backing it is not available. */
export interface UnavailableFeatureVM {
  readonly featureId: string;
  readonly featureLabel: string;
  readonly reason: string;
}

/** The last-known evidence backing a component's availability reading. */
export interface LastKnownEvidenceVM {
  readonly evidenceId: string;
  readonly observedAtIso: string;
  /** Whether the last-known evidence is stale (older than the freshness objective). */
  readonly stale: boolean;
}

/** One activation prerequisite an optional/on-demand component must satisfy before activating. */
export interface ActivationConditionVM {
  readonly key: string;
  readonly description: string;
  readonly satisfied: boolean;
}

/** One assurance gap that keeps a component from being relied upon. */
export interface AssuranceGapVM {
  readonly kind: string;
  readonly detail: string;
  readonly ownerAction: string;
}

/**
 * One component's availability profile: its class, runtime state, unavailable features, last-known
 * evidence, activation conditions, and assurance gaps. `manualApprovalRequired` marks a component
 * that never self-activates (an owner-approved activation path is required).
 */
export interface ComponentProfileVM {
  readonly componentKey: string;
  readonly displayName: string;
  readonly availabilityClass: ProfileAvailabilityClass;
  readonly runtimeState: ProfileRuntimeState;
  readonly ownerLabel: string;
  readonly manualApprovalRequired: boolean;
  readonly unavailableFeatures: readonly UnavailableFeatureVM[];
  readonly lastKnownEvidence: LastKnownEvidenceVM | null;
  readonly activationConditions: readonly ActivationConditionVM[];
  readonly assuranceGaps: readonly AssuranceGapVM[];
}

/** The whole availability-profiles model — the scope + its component profiles. */
export interface AvailabilityProfilesModel {
  readonly scopeLabel: string;
  readonly components: readonly ComponentProfileVM[];
  readonly generatedAtIso: string;
  /** The projection snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed availability view is empty, never falsely available. */
export const EMPTY_AVAILABILITY_PROFILES: AvailabilityProfilesModel = {
  scopeLabel: '',
  components: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface AvailabilityProfilesProps {
  readonly model: AvailabilityProfilesModel;
}

// ── Labels (availability class, runtime state — in words) ─────────────────────────────────────────

const CLASS_LABELS: Readonly<Record<ProfileAvailabilityClass, string>> = {
  core: 'core — the minimum platform must run; its loss blocks the governed feature it backs',
  optional: 'optional — enhances governance; its loss degrades a feature but core keeps running',
  'on-demand': 'on-demand — activated only for a specific request; dormancy is not a failure',
} as const;

const STATE_LABELS: Readonly<Record<ProfileRuntimeState, string>> = {
  inactive: 'inactive — approved but not activated (or intentionally deactivated)',
  activating: 'activating — activation in progress; not yet serving',
  available: 'available — healthy, connected, prerequisites hold',
  degraded: 'degraded — reachable but a required signal is impaired',
  unavailable: 'unavailable — health or connectivity lost; new execution blocked',
  paused: 'paused — stopped at a safe checkpoint; requires reconciliation before resuming',
} as const;

// ── Sub-renderers ─────────────────────────────────────────────────────────────────────────────────

function unavailableFeaturesCell(c: ComponentProfileVM): string {
  if (c.unavailableFeatures.length === 0) {
    return '<span data-testid="ap-no-unavailable" data-unavailable="none">no features unavailable</span>';
  }
  const items = c.unavailableFeatures
    .map(
      (f) => `
          <li data-testid="ap-unavailable-feature" data-feature-id="${esc(f.featureId)}">
            <strong>${esc(f.featureLabel)}</strong> — ${esc(f.reason)}
          </li>`,
    )
    .join('');
  return `<ul data-testid="ap-unavailable-features">${items}</ul>`;
}

function lastKnownEvidenceCell(c: ComponentProfileVM): string {
  const e = c.lastKnownEvidence;
  if (e === null) {
    return '<span data-testid="ap-no-evidence" data-evidence="none">no last-known evidence</span>';
  }
  return `
        <span
          data-testid="ap-last-known-evidence"
          data-evidence-id="${esc(e.evidenceId)}"
          data-stale="${e.stale ? 'true' : 'false'}"
        >
          <code>${esc(e.evidenceId)}</code> at
          <time datetime="${esc(e.observedAtIso)}">${esc(e.observedAtIso)}</time>${
            e.stale ? ' (stale — current availability not inferred from this)' : ''
          }
        </span>`;
}

function activationConditionsCell(c: ComponentProfileVM): string {
  if (c.activationConditions.length === 0) {
    return '<span data-testid="ap-no-conditions" data-conditions="none">no activation conditions declared</span>';
  }
  const items = c.activationConditions
    .map(
      (a) => `
          <li
            data-testid="ap-activation-condition"
            data-condition-key="${esc(a.key)}"
            data-satisfied="${a.satisfied ? 'true' : 'false'}"
          >
            <code>${esc(a.key)}</code> — ${esc(a.description)} (${
              a.satisfied ? 'satisfied' : 'not satisfied'
            })
          </li>`,
    )
    .join('');
  return `<ul data-testid="ap-activation-conditions">${items}</ul>`;
}

function assuranceGapsCell(c: ComponentProfileVM): string {
  if (c.assuranceGaps.length === 0) {
    return '<span data-testid="ap-no-gaps" data-gaps="none">no assurance gaps</span>';
  }
  const items = c.assuranceGaps
    .map(
      (g) => `
          <li data-testid="ap-assurance-gap" data-gap-kind="${esc(g.kind)}">
            <strong class="warn">${esc(g.kind)}</strong> — ${esc(g.detail)};
            owner action: ${esc(g.ownerAction)}
          </li>`,
    )
    .join('');
  return `<ul data-testid="ap-assurance-gaps">${items}</ul>`;
}

function componentCard(c: ComponentProfileVM): string {
  return `
      <article
        class="availability-profile-card"
        data-testid="availability-profile"
        data-component-key="${esc(c.componentKey)}"
        data-availability-class="${esc(c.availabilityClass)}"
        data-runtime-state="${esc(c.runtimeState)}"
        data-manual-approval-required="${c.manualApprovalRequired ? 'true' : 'false'}"
      >
        <h4 data-testid="ap-name"><code>${esc(c.componentKey)}</code> — ${esc(c.displayName)}</h4>
        <dl>
          <dt>Availability class</dt>
          <dd data-testid="ap-class" data-availability-class="${esc(c.availabilityClass)}">${esc(
            CLASS_LABELS[c.availabilityClass],
          )}</dd>
          <dt>Runtime state</dt>
          <dd data-testid="ap-state" data-runtime-state="${esc(c.runtimeState)}">${esc(
            STATE_LABELS[c.runtimeState],
          )}</dd>
          <dt>Owner</dt>
          <dd data-testid="ap-owner">${esc(c.ownerLabel)}</dd>
          <dt>Activation</dt>
          <dd data-testid="ap-activation">${
            c.manualApprovalRequired
              ? 'never self-activates — an owner-approved activation path is required'
              : 'may activate automatically once conditions hold'
          }</dd>
          <dt>Unavailable features</dt>
          <dd data-testid="ap-unavailable-cell">${unavailableFeaturesCell(c)}</dd>
          <dt>Last-known evidence</dt>
          <dd data-testid="ap-evidence-cell">${lastKnownEvidenceCell(c)}</dd>
          <dt>Activation conditions</dt>
          <dd data-testid="ap-conditions-cell">${activationConditionsCell(c)}</dd>
          <dt>Assurance gaps</dt>
          <dd data-testid="ap-gaps-cell">${assuranceGapsCell(c)}</dd>
        </dl>
      </article>`;
}

function section(
  id: string,
  heading: string,
  note: string,
  components: readonly ComponentProfileVM[],
  emptyText: string,
): string {
  const cards =
    components.length === 0
      ? `<p data-testid="${esc(id)}-empty" data-components="0">${esc(emptyText)}</p>`
      : components.map(componentCard).join('');
  return `
    <section
      id="region-${esc(id)}"
      aria-labelledby="${esc(id)}-h"
      data-testid="${esc(id)}"
      data-component-count="${esc(String(components.length))}"
      tabindex="-1"
    >
      <h3 id="${esc(id)}-h">${esc(heading)}</h3>
      <p data-testid="${esc(id)}-note">${esc(note)}</p>
      ${cards}
    </section>`;
}

// ── The availability-profiles view ────────────────────────────────────────────────────────────────

/**
 * Render the availability-profiles view as a self-contained, deterministic HTML string. CORE health
 * is rendered in its OWN section, SEPARATE from the optional/on-demand availability section — an
 * optional outage can never be read as a core one.
 */
export function renderAvailabilityProfiles(props: AvailabilityProfilesProps): string {
  const m = props.model;
  const core = m.components.filter((c) => c.availabilityClass === 'core');
  const optional = m.components.filter((c) => c.availabilityClass !== 'core');
  const coreSection = section(
    'core-availability',
    'Core availability (health of the minimum platform)',
    'These components must run continuously. The loss of any core component blocks the governed feature it backs.',
    core,
    'no core components',
  );
  const optionalSection = section(
    'optional-availability',
    'Optional and on-demand availability',
    'These components enhance governance. Their loss degrades a feature but does not block the core; an on-demand component being dormant is not a failure.',
    optional,
    'no optional or on-demand components',
  );
  return `
  <section
    id="region-availability-profiles"
    aria-labelledby="availability-profiles-h"
    data-testid="availability-profiles"
    data-scope="${esc(m.scopeLabel)}"
    data-component-count="${esc(String(m.components.length))}"
    data-core-count="${esc(String(core.length))}"
    data-optional-count="${esc(String(optional.length))}"
    data-snapshot-digest="${esc(m.snapshotDigest)}"
    tabindex="-1"
  >
    <h2 id="availability-profiles-h">Availability profiles</h2>
    <p data-testid="ap-scope">Scope: ${esc(m.scopeLabel)}</p>
    <p data-testid="ap-generated-at">
      Generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>
    </p>
    <p data-testid="ap-separation-note">
      Core health is reported separately from optional availability. Availability never grants a
      component design authority.
    </p>
    ${coreSection}
    ${optionalSection}
  </section>`;
}
