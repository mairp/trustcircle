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
  const governedRecords = governedSections.reduce(
    (total, section) => total + (section.recordCount ?? 0),
    0,
  );
  const verifiedEmpty = governedSections.filter((section) => section.verifiedEmpty).length;
  return (
    <aside
      className={affected ? 'summary summary--attention' : 'summary'}
      aria-live="polite"
      aria-label="Console data quality and governed scope"
    >
      <span className="summary-signal" aria-hidden="true">
        {affected ? '!' : '✓'}
      </span>
      <div className="summary-copy">
        <span className="summary-kicker">System overview</span>
        <strong>
          {affected
            ? 'Attention required'
            : governedRecords > 0
              ? 'Current governed scope'
              : 'No governed resources registered'}
        </strong>
        <span>
          {affected
            ? `${affected} section${affected === 1 ? '' : 's'} are stale, partial, degraded, unavailable, or unknown.`
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
          <dd>{governedRecords}</dd>
        </div>
        <div>
          <dt>Verified empty</dt>
          <dd>
            {verifiedEmpty}/{governedSections.length}
          </dd>
        </div>
      </dl>
    </aside>
  );
}
