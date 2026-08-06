import type { ConsoleSectionState } from '../lib/console-loader.ts';
import {
  SAVED_VIEWS,
  searchConsoleSections,
  type DiscoveryQuery,
  type StatusGroup,
} from '../lib/platform-workspaces.ts';
import { SavedViewControl } from './saved-view-control.tsx';
import { SearchOutcomeAnalytics } from './search-outcome-analytics.tsx';

const STATUS_LABELS: Readonly<Record<StatusGroup, string>> = {
  needs_attention: 'Needs attention',
  blocked: 'Blocked',
  unknown: 'Unknown',
  healthy: 'Healthy',
};

function queryHref(query: DiscoveryQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.domain) params.set('domain', query.domain);
  if (query.group) params.set('group', query.group);
  if (query.quality) params.set('quality', query.quality);
  if (query.owner) params.set('owner', query.owner);
  if (query.freshness) params.set('freshness', query.freshness);
  if (query.confidence) params.set('confidence', query.confidence);
  params.set('sort', query.sort);
  params.set('page_size', String(query.pageSize));
  if (page > 1) params.set('page', String(page));
  return `/search?${params.toString()}`;
}

export function DiscoveryWorkspace({
  sections,
  query,
  principalId,
  scope,
}: {
  readonly sections: readonly ConsoleSectionState[];
  readonly query: DiscoveryQuery;
  readonly principalId?: string | undefined;
  readonly scope: string;
}) {
  const result = searchConsoleSections(sections, query, principalId);
  return (
    <>
      <SearchOutcomeAnalytics resultCount={result.total} />
      <section className="saved-view-presets" aria-labelledby="preset-title">
        <div>
          <p className="domain-kicker">Governed view presets</p>
          <h2 id="preset-title">Start with accountable work</h2>
        </div>
        <div>
          {SAVED_VIEWS.map((view) => (
            <a href={`/search?view=${view.id}`} key={view.id} title={view.description}>
              {view.label}
            </a>
          ))}
        </div>
      </section>
      <form className="discovery-form" action="/search" method="get" role="search">
        <label className="discovery-form__query">
          Search records, owners, controls, obligations, evidence, connectors, exceptions, and IDs
          <input name="q" defaultValue={query.q} type="search" maxLength={240} />
        </label>
        <label>
          Domain
          <select name="domain" defaultValue={query.domain ?? ''}>
            <option value="">All permitted domains</option>
            {sections.map((section) => (
              <option value={section.id} key={section.id}>
                {section.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status group
          <select name="group" defaultValue={query.group ?? ''}>
            <option value="">All statuses</option>
            <option value="needs_attention">Needs attention</option>
            <option value="blocked">Blocked</option>
            <option value="unknown">Unknown</option>
            <option value="healthy">Healthy</option>
          </select>
        </label>
        <label>
          Freshness quality
          <select name="quality" defaultValue={query.quality ?? ''}>
            <option value="">All freshness</option>
            <option value="current">Current</option>
            <option value="stale">Stale</option>
            <option value="partial">Partial</option>
            <option value="degraded">Degraded</option>
            <option value="unavailable">Unavailable</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Owner
          <input
            name="owner"
            defaultValue={query.owner ?? ''}
            maxLength={160}
            placeholder="me or owner ID"
          />
        </label>
        <label>
          Sort
          <select name="sort" defaultValue={query.sort}>
            <option value="priority">Priority</option>
            <option value="title">Title</option>
            <option value="recent">Most recently observed</option>
            <option value="due">Due date</option>
          </select>
        </label>
        <button type="submit">Apply scoped view</button>
      </form>
      <SavedViewControl scope={scope} />
      <section className="discovery-results" aria-labelledby="results-title">
        <div className="record-region-heading">
          <div>
            <p className="domain-kicker">Authorized results only</p>
            <h2 id="results-title">
              {result.total} governed record{result.total === 1 ? '' : 's'}
            </h2>
          </div>
          <span>
            Page {result.page} of {result.pageCount}
          </span>
        </div>
        <dl className="search-status-counts">
          {(Object.entries(result.qualityCounts) as [StatusGroup, number][]).map(
            ([group, count]) => (
              <div key={group}>
                <dt>{STATUS_LABELS[group]}</dt>
                <dd>{count}</dd>
              </div>
            ),
          )}
        </dl>
        {result.items.length > 0 ? (
          <ol className="discovery-result-list">
            {result.items.map((item) => (
              <li
                key={`${item.domain}-${item.id}`}
                className={`discovery-result discovery-result--${item.group}`}
              >
                <div className="discovery-result__heading">
                  <div>
                    <span>{item.domainLabel}</span>
                    <h3>
                      <a href={item.href}>{item.title}</a>
                    </h3>
                  </div>
                  <span className={`status-group status-group--${item.group}`}>{item.label}</span>
                </div>
                <p>{item.why}</p>
                <dl>
                  {item.owner ? (
                    <div>
                      <dt>Owner</dt>
                      <dd>{item.owner}</dd>
                    </div>
                  ) : null}
                  {item.dueAt ? (
                    <div>
                      <dt>Due / expiry</dt>
                      <dd>{item.dueAt}</dd>
                    </div>
                  ) : null}
                  {item.confidence ? (
                    <div>
                      <dt>Confidence</dt>
                      <dd>{item.confidence}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Authoritative source</dt>
                    <dd>
                      <code>{item.source}</code>
                    </dd>
                  </div>
                </dl>
                <p className="next-action">
                  <strong>Safe next action:</strong> {item.safeNextAction}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <div className="verified-empty" role="status">
            <strong>No matching governed records</strong>
            <span>
              Broaden filters. Unavailable domains remain visible in their workspace and are not
              treated as empty.
            </span>
          </div>
        )}
        {result.pageCount > 1 ? (
          <nav aria-label="Search result pages" className="pagination">
            {result.page > 1 ? (
              <a href={queryHref(query, result.page - 1)}>Previous</a>
            ) : (
              <span>Previous</span>
            )}
            <span>
              {result.page} / {result.pageCount}
            </span>
            {result.page < result.pageCount ? (
              <a href={queryHref(query, result.page + 1)}>Next</a>
            ) : (
              <span>Next</span>
            )}
          </nav>
        ) : null}
      </section>
    </>
  );
}
