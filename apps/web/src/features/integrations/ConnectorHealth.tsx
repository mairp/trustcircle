// TrustCircleAI — CONNECTOR HEALTH presenter (Phase 8 / User Story 6 — Maintain Source and Workflow
// Health / T245 / apps/web/src/features/integrations/ConnectorHealth.tsx / FR-029, FR-030).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The officer-facing CONNECTOR HEALTH view: for each connector it surfaces the whole FR-029
// observable field set — identity, version, owner, health, lifecycle status, enabled scope, last
// success + last attempt, active operation, evidence, failures, retry state, affected work, and the
// SAFE NEXT ACTION — plus freshness, lag, reconciliation, and the FR-030 alerts routed to
// accountable owners on a threshold cross.
//
// THE CARDINAL POINT (FR-029 / db/migrations/0060 health_no_positive_from_absence): health is
// OBSERVED, never inferred from absence. A connector with a stale or absent observation is shown as
// `stale` / `unknown` — never rendered as if healthy. This presenter renders the model VERBATIM; it
// upgrades no missing reading to healthy and infers no current state from a last-known datum.
//
// PURE PRESENTER. The health/freshness/lag/retry/failure/affected-work/alert facts are NOT computed
// here — they come from the REAL health-observation + alert-routing projection upstream. This module
// renders whatever `ConnectorHealthModel` it is handed; it fabricates no reading and forges no alert.
//
// STATUS IS IN THE TEXT, NOT THE COLOR (WCAG 1.4.1). Every health, freshness, lifecycle, and alert
// state is spelled in words with a machine-readable data-attribute; a stale/unknown reading is
// stated as such.
//
// WHY A DEPENDENCY-FREE STRING RENDERER (not JSX/React). This `.tsx` file contains NO JSX — it is a
// pure string-builder presenter (tsconfig `jsx:preserve` only satisfies the extension resolver). The
// output is a self-contained HTML string an e2e spec can mount via `page.setContent(...)`.
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

// ── The connector-health model — a render-ready reduction, NOT recomputed here ────────────────────

/** Coarse OBSERVED health — `unknown` when no fresh observation backs it (never upgraded). */
export type ConnectorHealthState = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

/** Freshness of the backing observation — `stale`/`unknown` is never rendered as healthy. */
export type ConnectorFreshness = 'fresh' | 'stale' | 'unknown';

/** One alert routed to an accountable owner on a threshold cross (FR-030). */
export interface ConnectorAlertVM {
  readonly alertId: string;
  readonly alertClass: string;
  readonly severity: string;
  readonly ownerLabel: string;
  readonly state: string;
  readonly firstObservedAtIso: string;
  /** '' when the owner has not yet been notified — surfaced as such, never assumed. */
  readonly ownerNotifiedAtIso: string;
  /** '' when not recovered. */
  readonly recoveredAtIso: string;
}

/** One reconciliation summary for a connector (desired-vs-current drift). */
export interface ConnectorReconciliationVM {
  readonly lastRunAtIso: string;
  readonly resolved: boolean;
  readonly unresolvedDriftCount: number;
  readonly cadence: string;
}

/**
 * One connector's health row — the full FR-029 field set. `freshnessAgeMs`/`lagMs` are `null` when
 * no datum has been seen (surfaced as unknown, never zero-as-healthy).
 */
export interface ConnectorHealthRowVM {
  // identity + version + owner
  readonly connectorId: string;
  readonly adapterKey: string;
  readonly sourceRef: string;
  readonly observedVersion: string;
  readonly ownerLabel: string;
  // health + lifecycle + enabled scope
  readonly health: ConnectorHealthState;
  readonly freshness: ConnectorFreshness;
  readonly lifecycleState: string;
  readonly enabledScope: readonly string[];
  // freshness + lag
  readonly freshnessAgeMs: number | null;
  readonly lagMs: number | null;
  // last success + last attempt + active operation
  readonly lastSuccessAtIso: string;
  readonly lastAttemptAtIso: string;
  readonly activeOperationId: string;
  // failures + retry + affected work
  readonly failureCount: number;
  readonly retryDepth: number;
  readonly deadLetterCount: number;
  readonly affectedWork: readonly string[];
  readonly businessImpact: string;
  // evidence + reconciliation + alerts + safe next action
  readonly evidenceIds: readonly string[];
  readonly reconciliation: ConnectorReconciliationVM | null;
  readonly alerts: readonly ConnectorAlertVM[];
  /** '' when the connector is healthy AND fresh; else the visible, alertable safe next action. */
  readonly safeNextAction: string;
}

/** The whole connector-health model — the scope + its connector rows. */
export interface ConnectorHealthModel {
  readonly scopeLabel: string;
  readonly connectors: readonly ConnectorHealthRowVM[];
  readonly generatedAtIso: string;
  /** The projection snapshot digest — an independent effect witness. */
  readonly snapshotDigest: string;
}

/** An EMPTY-but-valid model — an un-fed health view is empty, never falsely healthy. */
export const EMPTY_CONNECTOR_HEALTH: ConnectorHealthModel = {
  scopeLabel: '',
  connectors: [],
  generatedAtIso: '1970-01-01T00:00:00.000Z',
  snapshotDigest: 'empty',
} as const;

export interface ConnectorHealthProps {
  readonly model: ConnectorHealthModel;
}

// ── Labels (health, freshness — in words) ─────────────────────────────────────────────────────────

const HEALTH_LABELS: Readonly<Record<ConnectorHealthState, string>> = {
  healthy: 'healthy',
  degraded: 'degraded',
  unavailable: 'unavailable',
  unknown: 'unknown — no fresh observation; health is not inferred',
} as const;

const FRESHNESS_LABELS: Readonly<Record<ConnectorFreshness, string>> = {
  fresh: 'fresh',
  stale: 'stale — beyond the freshness objective; current health not inferable',
  unknown: 'unknown — no observation recorded',
} as const;

function ageCell(ms: number | null, label: string): string {
  if (ms === null) {
    return `<span data-value="none">${esc(label)}: unknown</span>`;
  }
  return `<span data-value="${esc(String(ms))}">${esc(label)}: ${esc(String(ms))}ms</span>`;
}

// ── Sub-renderers ─────────────────────────────────────────────────────────────────────────────────

function scopeList(row: ConnectorHealthRowVM): string {
  if (row.enabledScope.length === 0) {
    return '<span data-testid="ch-no-scope" data-scope="none">no capabilities enabled</span>';
  }
  return `<span data-testid="ch-scope">${row.enabledScope
    .map((s) => `<code>${esc(s)}</code>`)
    .join(', ')}</span>`;
}

function affectedWorkCell(row: ConnectorHealthRowVM): string {
  if (row.affectedWork.length === 0) {
    return '<span data-testid="ch-no-affected" data-affected="none">no affected work</span>';
  }
  return `<ul data-testid="ch-affected-work">${row.affectedWork
    .map((w) => `<li>${esc(w)}</li>`)
    .join('')}</ul>`;
}

function evidenceCell(row: ConnectorHealthRowVM): string {
  if (row.evidenceIds.length === 0) {
    return '<span data-testid="ch-no-evidence" data-evidence="none">no evidence recorded</span>';
  }
  return `<span data-testid="ch-evidence">${row.evidenceIds
    .map((e) => `<code>${esc(e)}</code>`)
    .join(', ')}</span>`;
}

function reconciliationCell(row: ConnectorHealthRowVM): string {
  const r = row.reconciliation;
  if (r === null) {
    return '<span data-testid="ch-no-reconciliation" data-reconciliation="none">never reconciled</span>';
  }
  return `
        <span
          data-testid="ch-reconciliation"
          data-resolved="${r.resolved ? 'true' : 'false'}"
          data-unresolved-drift="${esc(String(r.unresolvedDriftCount))}"
          data-cadence="${esc(r.cadence)}"
        >
          last reconciled <time datetime="${esc(r.lastRunAtIso)}">${esc(r.lastRunAtIso)}</time>
          (${esc(r.cadence)}); ${
            r.resolved
              ? 'no unresolved drift'
              : `${esc(String(r.unresolvedDriftCount))} unresolved drift item(s)`
          }
        </span>`;
}

function alertCell(row: ConnectorHealthRowVM): string {
  if (row.alerts.length === 0) {
    return '<span data-testid="ch-no-alerts" data-alerts="none">no alerts</span>';
  }
  const items = row.alerts
    .map(
      (a) => `
          <li
            data-testid="ch-alert"
            data-alert-id="${esc(a.alertId)}"
            data-alert-class="${esc(a.alertClass)}"
            data-severity="${esc(a.severity)}"
            data-state="${esc(a.state)}"
            data-owner-notified="${a.ownerNotifiedAtIso === '' ? 'false' : 'true'}"
          >
            ${esc(a.alertClass)} (${esc(a.severity)}) — state ${esc(a.state)}; owner ${esc(
              a.ownerLabel,
            )};
            first observed <time datetime="${esc(a.firstObservedAtIso)}">${esc(
              a.firstObservedAtIso,
            )}</time>;
            ${
              a.ownerNotifiedAtIso === ''
                ? 'owner not yet notified'
                : `owner notified <time datetime="${esc(a.ownerNotifiedAtIso)}">${esc(
                    a.ownerNotifiedAtIso,
                  )}</time>`
            }${a.recoveredAtIso === '' ? '' : `; recovered <time datetime="${esc(a.recoveredAtIso)}">${esc(a.recoveredAtIso)}</time>`}
          </li>`,
    )
    .join('');
  return `<ul data-testid="ch-alerts">${items}</ul>`;
}

function safeNextActionCell(row: ConnectorHealthRowVM): string {
  if (row.safeNextAction === '') {
    return '<span data-testid="ch-no-action" data-safe-next-action="none">no action required</span>';
  }
  return `<strong class="warn" data-testid="ch-safe-next-action">${esc(row.safeNextAction)}</strong>`;
}

function connectorCard(row: ConnectorHealthRowVM): string {
  return `
      <article
        class="connector-health-card"
        data-testid="connector-health"
        data-connector-id="${esc(row.connectorId)}"
        data-adapter-key="${esc(row.adapterKey)}"
        data-health="${esc(row.health)}"
        data-freshness="${esc(row.freshness)}"
        data-lifecycle-state="${esc(row.lifecycleState)}"
        data-failure-count="${esc(String(row.failureCount))}"
        data-retry-depth="${esc(String(row.retryDepth))}"
        data-dead-letter-count="${esc(String(row.deadLetterCount))}"
      >
        <h3 data-testid="ch-identity">
          <code>${esc(row.adapterKey)}</code> → <code>${esc(row.sourceRef)}</code>
        </h3>
        <dl>
          <dt>Version</dt>
          <dd data-testid="ch-version">${
            row.observedVersion === ''
              ? '<span data-value="none">unknown</span>'
              : `<code>${esc(row.observedVersion)}</code>`
          }</dd>
          <dt>Owner</dt>
          <dd data-testid="ch-owner">${esc(row.ownerLabel)}</dd>
          <dt>Health</dt>
          <dd data-testid="ch-health" data-health="${esc(row.health)}">${esc(
            HEALTH_LABELS[row.health],
          )}</dd>
          <dt>Freshness</dt>
          <dd data-testid="ch-freshness" data-freshness="${esc(row.freshness)}">
            ${esc(FRESHNESS_LABELS[row.freshness])}
            (${ageCell(row.freshnessAgeMs, 'age')}; ${ageCell(row.lagMs, 'lag')})
          </dd>
          <dt>Lifecycle status</dt>
          <dd data-testid="ch-lifecycle" data-lifecycle-state="${esc(row.lifecycleState)}">${esc(
            row.lifecycleState,
          )}</dd>
          <dt>Enabled scope</dt>
          <dd data-testid="ch-scope-cell">${scopeList(row)}</dd>
          <dt>Last success</dt>
          <dd data-testid="ch-last-success">${
            row.lastSuccessAtIso === ''
              ? '<span data-value="none">never</span>'
              : `<time datetime="${esc(row.lastSuccessAtIso)}">${esc(row.lastSuccessAtIso)}</time>`
          }</dd>
          <dt>Last attempt</dt>
          <dd data-testid="ch-last-attempt">${
            row.lastAttemptAtIso === ''
              ? '<span data-value="none">never</span>'
              : `<time datetime="${esc(row.lastAttemptAtIso)}">${esc(row.lastAttemptAtIso)}</time>`
          }</dd>
          <dt>Active operation</dt>
          <dd data-testid="ch-active-operation">${
            row.activeOperationId === ''
              ? '<span data-value="none">none in flight</span>'
              : `<code>${esc(row.activeOperationId)}</code>`
          }</dd>
          <dt>Failures</dt>
          <dd data-testid="ch-failures">${esc(String(row.failureCount))} failure(s)</dd>
          <dt>Retry state</dt>
          <dd data-testid="ch-retry">retry depth ${esc(String(row.retryDepth))}; ${esc(
            String(row.deadLetterCount),
          )} dead-lettered</dd>
          <dt>Business impact</dt>
          <dd data-testid="ch-impact" data-business-impact="${esc(row.businessImpact)}">${esc(
            row.businessImpact,
          )}</dd>
          <dt>Affected work</dt>
          <dd data-testid="ch-affected-cell">${affectedWorkCell(row)}</dd>
          <dt>Evidence</dt>
          <dd data-testid="ch-evidence-cell">${evidenceCell(row)}</dd>
          <dt>Reconciliation</dt>
          <dd data-testid="ch-reconciliation-cell">${reconciliationCell(row)}</dd>
          <dt>Alerts</dt>
          <dd data-testid="ch-alerts-cell">${alertCell(row)}</dd>
          <dt>Safe next action</dt>
          <dd data-testid="ch-action-cell">${safeNextActionCell(row)}</dd>
        </dl>
      </article>`;
}

// ── The connector-health view ─────────────────────────────────────────────────────────────────────

/** Render the connector-health view as a self-contained, deterministic HTML string. */
export function renderConnectorHealth(props: ConnectorHealthProps): string {
  const m = props.model;
  const cards =
    m.connectors.length === 0
      ? '<p data-testid="ch-empty" data-connectors="0">no connectors</p>'
      : m.connectors.map(connectorCard).join('');
  return `
  <section
    id="region-connector-health"
    aria-labelledby="connector-health-h"
    data-testid="connector-health-view"
    data-scope="${esc(m.scopeLabel)}"
    data-connector-count="${esc(String(m.connectors.length))}"
    data-snapshot-digest="${esc(m.snapshotDigest)}"
    tabindex="-1"
  >
    <h2 id="connector-health-h">Connector health</h2>
    <p data-testid="ch-scope">Scope: ${esc(m.scopeLabel)}</p>
    <p data-testid="ch-generated-at">
      Generated <time datetime="${esc(m.generatedAtIso)}">${esc(m.generatedAtIso)}</time>
    </p>
    <p data-testid="ch-freshness-note">
      Health is observed. A stale or absent observation is shown as such and is never inferred to be
      healthy.
    </p>
    ${cards}
  </section>`;
}
