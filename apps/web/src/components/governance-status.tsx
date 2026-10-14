import type { ConsoleSectionState } from '../lib/console-loader.ts';
import type { ConsoleRecordDetail, ConsoleRecordField } from '../lib/console-presenter.ts';
import { classifyRecordStatus, workspaceForDomain } from '../lib/platform-workspaces.ts';
import type { ReadQuality } from '../lib/read-model.ts';

const LABELS: Readonly<Record<ReadQuality, string>> = {
  current: 'Current',
  stale: 'Stale',
  partial: 'Partial',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
};

export function StatusBadge({ quality }: { readonly quality: ReadQuality }) {
  return (
    <span className={`status status--${quality}`} data-quality={quality}>
      <span aria-hidden="true">●</span> {LABELS[quality]}
    </span>
  );
}

function FieldValue({ field }: { readonly field: ConsoleRecordField }) {
  if (field.emphasis === 'time' && Number.isFinite(Date.parse(field.value))) {
    return <time dateTime={field.value}>{field.value}</time>;
  }
  return <>{field.value}</>;
}

function recordHref(section: ConsoleSectionState, record: ConsoleRecordDetail): string {
  const assetId =
    section.id === 'inventory'
      ? record.fields.find((field) => field.label === 'Asset ID')?.value
      : undefined;
  if (assetId) return `/assets/${encodeURIComponent(assetId)}`;
  // Decision records open their live detail page, where an authorized reviewer can act.
  if (section.id === 'decisions' && /^[0-9a-f-]{36}$/i.test(record.id)) {
    return `/decisions/${encodeURIComponent(record.id)}`;
  }
  const workspace = workspaceForDomain(section.id)?.href ?? `/${section.id}`;
  return `${workspace}?record=${encodeURIComponent(record.id)}#record-${encodeURIComponent(record.id)}`;
}

export function GovernanceSection({ section }: { readonly section: ConsoleSectionState }) {
  const hasDetails = section.records.length > 0;
  return (
    <section
      id={`section-${section.id}`}
      className={`governance-card${hasDetails ? ' governance-card--populated' : ''}`}
      aria-labelledby={`heading-${section.id}`}
    >
      <div className="card-heading">
        <div>
          <p className="domain-kicker">Governance domain · {section.id}</p>
          <h2 id={`heading-${section.id}`}>{section.title}</h2>
        </div>
        <StatusBadge quality={section.quality} />
      </div>

      <p className="section-description">{section.description}</p>

      <div className="section-result" aria-label={`${section.title} result`}>
        <strong>
          {section.recordCount === undefined
            ? 'Result not verified'
            : section.verifiedEmpty
              ? 'Verified empty'
              : section.id === 'posture'
                ? `${section.recordCount} governed domain${section.recordCount === 1 ? '' : 's'}`
                : `${section.recordCount} record${section.recordCount === 1 ? '' : 's'}`}
        </strong>
        <span>{section.summary}</span>
      </div>

      {section.facts.length > 0 ? (
        <dl className="section-facts" aria-label={`${section.title} at a glance`}>
          {section.facts.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd data-emphasis={field.emphasis}>
                <FieldValue field={field} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {hasDetails ? (
        <div className="record-region" aria-labelledby={`details-${section.id}`}>
          <div className="record-region-heading">
            <h3 id={`details-${section.id}`}>{section.detailsLabel}</h3>
            <span>{section.records.length} shown</span>
          </div>
          <ol className="record-list">
            {section.records.map((record) => {
              const posture = classifyRecordStatus(record);
              return (
                <li
                  className={`record-item record-item--${posture.group}`}
                  id={`record-${record.id}`}
                  key={record.id}
                >
                  <div className="record-heading">
                    <div>
                      <strong>
                        <a href={recordHref(section, record)}>{record.title}</a>
                      </strong>
                      {record.subtitle ? <span>{record.subtitle}</span> : null}
                    </div>
                    <span className={`status-group status-group--${posture.group}`}>
                      {posture.label}
                    </span>
                  </div>
                  <p className="record-status-explanation">{posture.why}</p>
                  {record.fields.length > 0 ? (
                    <dl className="record-fields">
                      {record.fields.map((field) => (
                        <div key={`${record.id}-${field.label}`}>
                          <dt>{field.label}</dt>
                          <dd data-emphasis={field.emphasis}>
                            <FieldValue field={field} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="record-withheld">
                      This record has no additional allowlisted fields for this view.
                    </p>
                  )}
                  <p className="record-safe-action">
                    <strong>Safe next action:</strong> {posture.safeNextAction}
                  </p>
                </li>
              );
            })}
          </ol>
          {section.hiddenRecordCount > 0 ? (
            <p className="record-limit" role="note">
              {section.hiddenRecordCount} additional record
              {section.hiddenRecordCount === 1 ? '' : 's'} withheld from this overview. Use the
              governed domain API or a scoped detail view for the complete result.
            </p>
          ) : null}
        </div>
      ) : section.verifiedEmpty ? (
        <div className="verified-empty" role="status">
          <strong>No records to list</strong>
          <span>{section.emptyMessage}</span>
        </div>
      ) : null}

      <dl className="metadata" aria-label={`${section.title} provenance and freshness`}>
        <div>
          <dt>Authoritative source</dt>
          <dd>
            <code>{section.source}</code>
          </dd>
        </div>
        <div>
          <dt>API route</dt>
          <dd>
            <code>{section.path}</code>
          </dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>
            {section.observedAt ? (
              <time dateTime={section.observedAt}>{section.observedAt}</time>
            ) : (
              'Unknown — metadata absent'
            )}
          </dd>
        </div>
      </dl>
      {section.diagnostic ? <p className="diagnostic">Diagnostic: {section.diagnostic}</p> : null}
      {section.safeNextAction ? (
        <p className="next-action">
          <strong>Safe next action:</strong> {section.safeNextAction}
        </p>
      ) : null}
    </section>
  );
}
