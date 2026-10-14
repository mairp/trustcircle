import type { ConsoleSectionState } from '../lib/console-loader.ts';
import type { ConsoleRecordDetail, ConsoleRecordField } from '../lib/console-presenter.ts';
import { classifyRecordStatus, type PlatformWorkspace } from '../lib/platform-workspaces.ts';
import { relativeAge } from '../lib/relative-age.ts';

function FieldValue({ field, now }: { readonly field: ConsoleRecordField; readonly now: number }) {
  if (field.label === 'Asset ID') {
    return <a href={`/assets/${encodeURIComponent(field.value)}`}>{field.value}</a>;
  }
  if (field.emphasis === 'time' && Number.isFinite(Date.parse(field.value))) {
    return (
      <time dateTime={field.value} title={field.value}>
        {relativeAge(field.value, now) ?? field.value}
      </time>
    );
  }
  if (field.emphasis === 'identifier') return <code>{field.value}</code>;
  return <>{field.value}</>;
}

/** One governed record, resolved from its domain's current authoritative read. */
export function RecordDetail({
  workspace,
  section,
  record,
  now,
}: {
  readonly workspace: PlatformWorkspace;
  readonly section: ConsoleSectionState;
  readonly record: ConsoleRecordDetail;
  readonly now: number;
}) {
  const status = classifyRecordStatus(record);
  const observed = relativeAge(section.observedAt, now);
  return (
    <>
      <section className={`status-explanation status-explanation--${status.group}`}>
        <div>
          <p className="domain-kicker">Record status</p>
          <h2>{status.label}</h2>
          <p>{status.why}</p>
        </div>
        <p>
          <strong>Safe next action</strong>
          <span>{status.safeNextAction}</span>
        </p>
      </section>
      <div className="record-detail">
        <section className="record-detail__fields" aria-labelledby="record-fields-heading">
          <h2 id="record-fields-heading">Governed fields</h2>
          {record.subtitle ? <p className="record-detail__subtitle">{record.subtitle}</p> : null}
          <dl className="record-fields">
            <div>
              <dt>Record ID</dt>
              <dd>
                <code>{record.id}</code>
              </dd>
            </div>
            {record.fields.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd data-emphasis={field.emphasis}>
                  <FieldValue field={field} now={now} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <aside className="record-detail__source" aria-labelledby="record-source-heading">
          <h2 id="record-source-heading">Where this comes from</h2>
          <dl className="record-fields">
            <div>
              <dt>Domain</dt>
              <dd>{section.title}</dd>
            </div>
            <div>
              <dt>Read quality</dt>
              <dd>{section.quality}</dd>
            </div>
            <div>
              <dt>Observed</dt>
              <dd>
                {section.observedAt ? (
                  <time dateTime={section.observedAt} title={section.observedAt}>
                    {observed ?? section.observedAt}
                  </time>
                ) : (
                  'Observation time unavailable'
                )}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                <code>{section.source}</code>
              </dd>
            </div>
          </dl>
          <p>
            This page shows what the authoritative read returned. Nothing on it is inferred, and it
            grants no action authority.
          </p>
          <a href={workspace.href}>Back to {workspace.shortLabel}</a>
        </aside>
      </div>
    </>
  );
}
