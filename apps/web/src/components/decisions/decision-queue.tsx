import {
  DECISION_STATUSES,
  actingPosition,
  isTerminal,
  openRequirements,
  statusLabel,
  timePosture,
  timePostureLabel,
  type DecisionView,
} from '../../lib/decision-view.ts';
import type { DecisionQueueFilters, DecisionQueueState } from '../../lib/decisions-loader.ts';
import type { DecisionCapabilities } from '../../lib/permissions.ts';
import { relativeAge } from '../../lib/relative-age.ts';

function positionLabel(
  decision: DecisionView,
  principalId: string | undefined,
  capabilities: DecisionCapabilities,
  now: number,
): { label: string; tone: 'act' | 'own' | 'read' | 'closed' } {
  if (isTerminal(decision.status)) return { label: 'Closed', tone: 'closed' };
  const position = actingPosition(
    decision,
    principalId,
    capabilities.canAct,
    capabilities.canDelegate,
    now,
  );
  if (position.canReview) return { label: 'Awaiting your decision', tone: 'act' };
  if (position.canCancel) return { label: 'You requested this', tone: 'own' };
  return { label: 'Read only', tone: 'read' };
}

/** Open decisions first, soonest expiry first; closed decisions last. Stable for equal keys. */
export function orderDecisions(items: readonly DecisionView[]): readonly DecisionView[] {
  const expiry = (d: DecisionView) => {
    const at = Date.parse(d.expiresAt);
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  };
  return [...items].sort(
    (a, b) => Number(isTerminal(a.status)) - Number(isTerminal(b.status)) || expiry(a) - expiry(b),
  );
}

export function DecisionQueue({
  state,
  filters,
  capabilities,
  principalId,
  now,
}: {
  readonly state: DecisionQueueState;
  readonly filters: DecisionQueueFilters;
  readonly capabilities: DecisionCapabilities;
  readonly principalId: string | undefined;
  readonly now: number;
}) {
  const items = orderDecisions(state.items);
  const open = items.filter((d) => !isTerminal(d.status));
  const awaiting = open.filter(
    (d) => positionLabel(d, principalId, capabilities, now).tone === 'act',
  );
  const expiring = open.filter((d) => timePosture(d.expiresAt, now) === 'expiring_soon');
  const expired = open.filter((d) => timePosture(d.expiresAt, now) === 'expired');
  const generated = relativeAge(state.generatedAt, now);

  return (
    <section
      className="operations-workspace decision-queue"
      aria-labelledby="decision-queue-heading"
    >
      <header className="operations-heading">
        <div>
          <p className="eyebrow">Human decisions</p>
          <h2 id="decision-queue-heading">Decision inbox</h2>
          <p>
            Decision packages waiting on a person with authority. Opening one shows the full
            package; every action needs a reason and is recorded in the audit ledger.
          </p>
        </div>
        <p
          className={`operations-quality operations-quality--${state.available ? state.freshness : 'unavailable'}`}
          role="status"
        >
          {state.available ? (
            <>
              <strong>{statusLabel(state.freshness)}</strong>
              {state.partialCoverage ? ' · partial coverage' : ''}
              {generated ? ` · read ${generated}` : ''}
            </>
          ) : (
            <strong>Unavailable</strong>
          )}
        </p>
      </header>

      {!state.available ? (
        <div className="operations-notice" role="alert">
          <strong>The decision queue could not be read.</strong>
          <span>{state.safeNextAction ?? 'Retry; no decision is shown as resolved.'}</span>
          {state.diagnostic ? <code>{state.diagnostic}</code> : null}
        </div>
      ) : null}

      <dl className="operations-summary" aria-label="Decision queue summary">
        {(
          [
            ['Open', open.length],
            ['Awaiting your decision', awaiting.length],
            ['Expiring within 24 h', expiring.length],
            ['Expired, still open', expired.length],
            ['Closed', items.length - open.length],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{state.available ? value : '—'}</dd>
          </div>
        ))}
      </dl>

      <form className="operations-filters" method="get" action="/decisions">
        <fieldset>
          <legend>Narrow the inbox</legend>
          <label>
            Status
            <select name="status" defaultValue={filters.status ?? ''}>
              <option value="">Any status</option>
              {DECISION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="decision-filter-check">
            <input
              type="checkbox"
              name="assigned"
              value="me"
              defaultChecked={filters.assignedToMe}
            />
            Assigned to me
          </label>
          <div className="operations-filter-actions">
            <button type="submit">Apply filters</button>
            <a href="/decisions">Clear filters</a>
          </div>
        </fieldset>
      </form>

      {state.unreadable > 0 ? (
        <p className="operations-notice" role="alert">
          {state.unreadable === 1
            ? '1 decision could not be read and is not listed. The queue is incomplete.'
            : `${state.unreadable} decisions could not be read and are not listed. The queue is incomplete.`}
        </p>
      ) : null}

      {state.available && items.length === 0 ? (
        <p className="operations-empty">
          No decisions match.{' '}
          {filters.status || filters.assignedToMe ? 'Clear the filters to see all.' : ''}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="decision-table-wrap" role="region" aria-label="Decisions" tabIndex={0}>
          <table className="decision-table">
            <caption className="visually-hidden">
              Decisions, open first and soonest expiry first
            </caption>
            <thead>
              <tr>
                <th scope="col">Decision</th>
                <th scope="col">Risk</th>
                <th scope="col">Status</th>
                <th scope="col">Expiry</th>
                <th scope="col">Open gates</th>
                <th scope="col">Your position</th>
              </tr>
            </thead>
            <tbody>
              {items.map((decision) => {
                const posture = timePosture(decision.expiresAt, now);
                const gates = openRequirements(decision).length;
                const position = positionLabel(decision, principalId, capabilities, now);
                return (
                  <tr key={decision.id} data-status={decision.status}>
                    <th scope="row">
                      <a href={`/decisions/${decision.id}`}>{decision.requestedAction}</a>
                      <small>
                        {decision.actionClass} · v{decision.version}
                      </small>
                    </th>
                    <td>
                      <span className={`decision-risk decision-risk--${decision.riskTier}`}>
                        {decision.riskTier}
                      </span>
                    </td>
                    <td>{statusLabel(decision.status)}</td>
                    <td>
                      <span className={`decision-time decision-time--${posture}`}>
                        {isTerminal(decision.status) ? 'Closed' : timePostureLabel(posture)}
                      </span>
                      {decision.expiresAt ? (
                        <small>
                          <time dateTime={decision.expiresAt} title={decision.expiresAt}>
                            {decision.expiresAt.slice(0, 16).replace('T', ' ')} UTC
                          </time>
                        </small>
                      ) : null}
                    </td>
                    <td>
                      {isTerminal(decision.status) ? '—' : gates === 0 ? 'None' : `${gates} open`}
                    </td>
                    <td>
                      <span className={`decision-position decision-position--${position.tone}`}>
                        {position.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {state.hasMore ? (
        <p className="operations-readonly">
          Showing the first 100 decisions. Narrow the inbox with a status filter to see the rest.
        </p>
      ) : null}
    </section>
  );
}
