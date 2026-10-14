import { createOperationalCaseAction } from '../../app/operations/actions.ts';
import {
  OPERATIONS_FILTER_OPTIONS,
  type OperationsAttentionState,
  type OperationsWorkspaceFilters,
} from '../../lib/operations-loader.ts';
import type { OperationsWorkspaceCapabilities } from '../../lib/permissions.ts';
import {
  operationPriorityClass,
  operationsQualityMessage,
  operationsStatusLabel,
} from './accessibility.tsx';

function priorityFromSeverity(severity: string): 'critical' | 'high' | 'medium' | 'low' {
  return severity === 'critical' || severity === 'high' || severity === 'medium' ? severity : 'low';
}

export function AttentionQueue({
  state,
  capabilities,
  filters,
}: {
  readonly state: OperationsAttentionState;
  readonly capabilities: OperationsWorkspaceCapabilities;
  readonly filters: OperationsWorkspaceFilters;
}) {
  if (!capabilities.canRead) return null;
  return (
    <section
      id="operations-command-center"
      className="operations-workspace"
      aria-labelledby="operations-heading"
    >
      <header className="operations-heading">
        <div>
          <p className="eyebrow">Operations command center</p>
          <h2 id="operations-heading">Prioritized attention queue</h2>
          <p>
            One explainable order across permitted governance domains. No source action runs
            automatically.
          </p>
        </div>
        <p className={`operations-quality operations-quality--${state.quality}`} role="status">
          <strong>{operationsStatusLabel(state.quality)}</strong> ·{' '}
          {operationsQualityMessage(state.quality)}
        </p>
      </header>

      <dl className="operations-summary" aria-label="Unfiltered urgent work summary">
        {[
          ['Total', state.summary.total],
          ['Critical', state.summary.critical],
          ['Overdue', state.summary.overdue],
          ['Unowned', state.summary.unowned],
          ['Stale', state.summary.stale],
          ['Assigned to me', state.summary.assignedToMe],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <form className="operations-filters" method="get" action="/operations">
        <fieldset>
          <legend>Narrow the visible queue</legend>
          <label>
            Domain
            <select name="domain" defaultValue={filters.domain ?? ''}>
              <option value="">All domains</option>
              {OPERATIONS_FILTER_OPTIONS.domain.map((value) => (
                <option key={value} value={value}>
                  {operationsStatusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select name="severity" defaultValue={filters.severity ?? ''}>
              <option value="">All severities</option>
              {OPERATIONS_FILTER_OPTIONS.severity.map((value) => (
                <option key={value} value={value}>
                  {operationsStatusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ownership
            <select name="ownership" defaultValue={filters.ownership ?? ''}>
              <option value="">Any ownership</option>
              {OPERATIONS_FILTER_OPTIONS.ownership.map((value) => (
                <option key={value} value={value}>
                  {operationsStatusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Deadline
            <select name="time_posture" defaultValue={filters.timePosture ?? ''}>
              <option value="">Any deadline</option>
              {OPERATIONS_FILTER_OPTIONS.timePosture.map((value) => (
                <option key={value} value={value}>
                  {operationsStatusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Freshness
            <select name="freshness" defaultValue={filters.freshness ?? ''}>
              <option value="">Any freshness</option>
              {OPERATIONS_FILTER_OPTIONS.freshness.map((value) => (
                <option key={value} value={value}>
                  {operationsStatusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignment
            <select name="assignment" defaultValue={filters.assignment ?? ''}>
              <option value="">Any assignment</option>
              <option value="mine">Assigned to me</option>
              <option value="any">All assignments</option>
            </select>
          </label>
          <div className="operations-filter-actions">
            <button type="submit">Apply filters</button>
            <a href="#operations-command-center">Keep current view</a>
            <a href="/operations">Clear filters</a>
          </div>
        </fieldset>
        <p>Urgent totals above are unfiltered so hidden critical work remains visible.</p>
      </form>

      {!state.available || state.safeNextAction ? (
        <div className="operations-notice" role="alert">
          <strong>Coverage is not authoritative.</strong>
          <span>
            {state.safeNextAction ??
              'Restore the command-center API and retry; do not infer an empty queue.'}
          </span>
          {state.diagnostic ? <code>{state.diagnostic}</code> : null}
        </div>
      ) : null}

      <details className="operations-coverage">
        <summary>Source coverage ({state.coverage.length} domains)</summary>
        <ul>
          {state.coverage.map((coverage) => (
            <li key={coverage.domain}>
              <strong>{coverage.domain}</strong>: {operationsStatusLabel(coverage.quality)}
              {coverage.failureCode ? ` · ${coverage.failureCode}` : ''}
              {coverage.candidateCount === undefined
                ? ''
                : ` · ${coverage.candidateCount} candidates`}
            </li>
          ))}
        </ul>
      </details>

      <ol className="attention-list" aria-label="Ranked attention items">
        {state.items.map((item, index) => (
          <li key={item.id} className="attention-item">
            <article>
              <header>
                <span className="attention-rank" aria-label={`Rank ${index + 1}`}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <p className="attention-kicker">
                    {item.domain} · {operationsStatusLabel(item.timePosture)}
                  </p>
                  <h3>{item.title}</h3>
                </div>
                <span className={operationPriorityClass(item.severity)}>{item.severity}</span>
              </header>
              <dl className="attention-facts">
                <div>
                  <dt>Impact</dt>
                  <dd>{operationsStatusLabel(item.impact)}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{operationsStatusLabel(item.ownerPosture)}</dd>
                </div>
                <div>
                  <dt>Freshness</dt>
                  <dd>{operationsStatusLabel(item.freshness)}</dd>
                </div>
                <div>
                  <dt>Sources</dt>
                  <dd>{item.sources.length}</dd>
                </div>
              </dl>
              <details>
                <summary>Why this rank and where it came from</summary>
                <ul>
                  {item.rankingFactors.map((factor) => (
                    <li key={factor.label}>
                      {factor.label}: {factor.value}
                    </li>
                  ))}
                </ul>
                <ul>
                  {item.sources.map((source) => (
                    <li key={`${source.domain}:${source.recordId}`}>
                      <a href={source.href}>
                        {source.recordType} · {source.recordId}
                      </a>
                      {source.recordVersion ? ` · version ${source.recordVersion}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
              <div className="operations-actions">
                {item.safeNextAction.href ? (
                  <a className="operations-link" href={item.safeNextAction.href}>
                    {item.safeNextAction.label}
                  </a>
                ) : (
                  <span>{item.safeNextAction.label}</span>
                )}
                {capabilities.canCreateCases ? (
                  <form action={createOperationalCaseAction}>
                    <input type="hidden" name="attention_item_id" value={item.id} />
                    <input type="hidden" name="title" value={item.title} />
                    <input
                      type="hidden"
                      name="priority"
                      value={priorityFromSeverity(item.severity)}
                    />
                    <input
                      type="hidden"
                      name="source_references"
                      value={JSON.stringify(item.sources.map((source) => source.wire))}
                    />
                    <label>
                      Case rationale{' '}
                      <input
                        name="reason"
                        required
                        minLength={8}
                        maxLength={2000}
                        placeholder="Why this needs governed ownership"
                      />
                    </label>
                    <button type="submit">Open governed case</button>
                  </form>
                ) : (
                  <span className="operations-readonly">
                    Read-only role · no case command authority
                  </span>
                )}
              </div>
            </article>
          </li>
        ))}
      </ol>
      {state.available && state.items.length === 0 ? (
        <p className="operations-empty">
          No items were returned. Confirm every coverage row before treating this as a verified
          empty queue.
        </p>
      ) : null}
    </section>
  );
}
