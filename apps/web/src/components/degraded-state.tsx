import type { ConsoleSectionState } from '../lib/console-loader.ts';

export function AuthenticationRequired() {
  return (
    <main id="main-content" tabIndex={-1} className="state-page">
      <h1>Authentication required</h1>
      <p role="alert">
        No verified tenant session is available. Protected governance data has not been requested or
        rendered.
      </p>
      <p>Sign in through the approved identity provider, then return to this page.</p>
    </main>
  );
}

export function ConsoleSummary({
  sections,
}: {
  readonly sections: readonly ConsoleSectionState[];
}) {
  const affected = sections.filter((section) => section.quality !== 'current').length;
  const current = sections.length - affected;
  const governedSections = sections.filter((section) => section.id !== 'posture');
  // A section whose count is unknown is never folded in as zero: the total is a lower bound and the
  // number of uncounted sections is shown beside it, so an undercount cannot read as exact.
  const governedRecords = governedSections.reduce(
    (total, section) => total + (section.recordCount ?? 0),
    0,
  );
  const uncounted = governedSections.filter(
    (section) => section.recordCount == null && !section.verifiedEmpty,
  ).length;
  const recordsLabel = uncounted
    ? `≥${governedRecords} (${uncounted} section${uncounted === 1 ? '' : 's'} uncounted)`
    : `${governedRecords}`;
  const verifiedEmpty = governedSections.filter((section) => section.verifiedEmpty).length;
  return (
    <section
      className={affected ? 'summary summary--attention' : 'summary'}
      aria-label="Console data quality and governed scope"
    >
      <span className="summary-signal" aria-hidden="true">
        {affected ? '!' : '✓'}
      </span>
      <div className="summary-copy" role="status">
        <span className="summary-kicker">System overview</span>
        <strong>
          {affected
            ? 'Attention required'
            : uncounted
              ? 'Current governed scope (partly counted)'
              : governedRecords > 0
                ? 'Current governed scope'
                : 'No governed resources registered'}
        </strong>
        <span>
          {affected
            ? `${affected} section${affected === 1 ? '' : 's'} are stale, partial, degraded, unavailable, or unknown.`
            : uncounted
              ? `At least ${governedRecords} governed record${governedRecords === 1 ? '' : 's'} are visible; ${uncounted} read model${uncounted === 1 ? ' did' : 's did'} not report a count, so the total is a lower bound.`
              : governedRecords > 0
                ? `${governedRecords} governed record${governedRecords === 1 ? '' : 's'} are visible across the authoritative tenant and runtime read models.`
                : 'The API is current, but the authoritative tenant read models contain no assets, decisions, cases, controllers, compliance records, evidence, connectors, or health observations.'}
        </span>
      </div>
      <dl className="summary-metrics">
        <div>
          <dt>Current sections</dt>
          <dd>
            {current}/{sections.length}
          </dd>
        </div>
        <div>
          <dt>Governed records</dt>
          <dd>{recordsLabel}</dd>
        </div>
        <div>
          <dt>Verified empty</dt>
          <dd>
            {verifiedEmpty}/{governedSections.length}
          </dd>
        </div>
      </dl>
    </section>
  );
}
