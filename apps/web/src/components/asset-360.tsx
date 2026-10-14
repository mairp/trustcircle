import type { ConsoleSectionState } from '../lib/console-loader.ts';
import type { ConsoleRecordDetail } from '../lib/console-presenter.ts';
import {
  classifyRecordStatus,
  recordDetailHref,
  relatedAssetRecords,
} from '../lib/platform-workspaces.ts';

type AssetTab = 'overview' | 'relationships' | 'history';

function field(record: ConsoleRecordDetail, label: string): string | undefined {
  return record.fields.find((candidate) => candidate.label === label)?.value;
}

export function Asset360({
  assetId,
  asset,
  inventory,
  sections,
  tab,
}: {
  readonly assetId: string;
  readonly asset: ConsoleRecordDetail;
  readonly inventory: ConsoleSectionState;
  readonly sections: readonly ConsoleSectionState[];
  readonly tab: AssetTab;
}) {
  const status = classifyRecordStatus(asset);
  const related = relatedAssetRecords(assetId, sections);
  const owner = field(asset, 'Owner') ?? 'Unknown';
  const observed = field(asset, 'Observed') ?? inventory.observedAt;
  const confidence = field(asset, 'Confidence') ?? 'Unknown';
  return (
    <article className="asset-360">
      <header className="asset-identity">
        <div>
          <p className="domain-kicker">Asset 360 · {field(asset, 'Type') ?? 'Governed asset'}</p>
          <h2>{asset.title}</h2>
          <p>
            Business identity leads this view. The stable technical identifier remains copyable and
            available for investigation.
          </p>
        </div>
        <div className={`asset-status asset-status--${status.group}`}>
          <span>{status.label}</span>
          <strong>{field(asset, 'Risk tier') ?? 'Risk unknown'}</strong>
        </div>
      </header>
      <dl className="asset-key-facts">
        <div>
          <dt>Asset ID</dt>
          <dd>
            <code>{assetId}</code>
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{owner}</dd>
        </div>
        <div>
          <dt>Environment / lifecycle</dt>
          <dd>{field(asset, 'Lifecycle') ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Control coverage</dt>
          <dd>{field(asset, 'Coverage') ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{field(asset, 'Evidence') ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{confidence}</dd>
        </div>
      </dl>
      <section className={`status-explanation status-explanation--${status.group}`}>
        <div>
          <h2>Why this asset is {status.label.toLowerCase()}</h2>
          <p>{status.why}</p>
        </div>
        <p>
          <strong>Safe next action</strong>
          <span>{status.safeNextAction}</span>
        </p>
      </section>
      <nav className="asset-tabs" aria-label="Asset 360 views">
        {(['overview', 'relationships', 'history'] as const).map((candidate) => (
          <a
            href={`/assets/${encodeURIComponent(assetId)}?tab=${candidate}`}
            aria-current={tab === candidate ? 'page' : undefined}
            key={candidate}
          >
            {candidate === 'overview'
              ? 'Overview'
              : candidate === 'relationships'
                ? 'Relationships'
                : 'Change history'}
          </a>
        ))}
      </nav>
      {tab === 'overview' ? (
        <div className="asset-panels">
          <section>
            <h2>Governed identity and posture</h2>
            <dl className="record-fields">
              {asset.fields.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd data-emphasis={item.emphasis}>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h2>Related governance records</h2>
            {related.length > 0 ? (
              <ul className="related-records">
                {related.map(({ section, record }) => (
                  <li key={`${section.id}-${record.id}`}>
                    <span>{section.title}</span>
                    <strong>
                      <a href={recordDetailHref(section.id, record)}>{record.title}</a>
                    </strong>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="verified-empty">
                <strong>No authoritative relationships returned</strong>
                <span>
                  The asset remains visible; absence of links is not treated as proof that no
                  dependencies exist.
                </span>
              </div>
            )}
          </section>
        </div>
      ) : null}
      {tab === 'relationships' ? (
        <section className="relationship-graph" aria-labelledby="relationship-title">
          <h2 id="relationship-title">Governed relationship graph</h2>
          <p>
            Every edge below is derived from a visible record reference; ambiguous relationships are
            not invented.
          </p>
          <div className="relationship-graph__canvas">
            <div className="relationship-node relationship-node--asset">
              <span>Asset</span>
              <strong>{asset.title}</strong>
              <code>{assetId}</code>
            </div>
            {related.map(({ section, record }) => (
              <div className="relationship-edge" key={`${section.id}-${record.id}`}>
                <span aria-hidden="true">→</span>
                <div className="relationship-node">
                  <span>{section.title}</span>
                  <strong>
                    <a href={recordDetailHref(section.id, record)}>{record.title}</a>
                  </strong>
                  <code>{record.id}</code>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 'history' ? (
        <section className="asset-history" aria-labelledby="history-title">
          <h2 id="history-title">Attributable observation history</h2>
          <ol>
            <li>
              <time dateTime={observed}>{observed ?? 'Observation time unavailable'}</time>
              <strong>Current inventory projection</strong>
              <span>
                Source: {inventory.source} · quality: {inventory.quality} · confidence: {confidence}
              </span>
            </li>
            {related.map(({ section, record }) => (
              <li key={`${section.id}-${record.id}`}>
                <time dateTime={section.observedAt}>
                  {section.observedAt ?? 'Observation time unavailable'}
                </time>
                <strong>{record.title}</strong>
                <span>
                  Source: {section.source} · domain: {section.title} · quality: {section.quality}
                </span>
              </li>
            ))}
          </ol>
          <p className="diagnostic">
            If an authoritative source does not expose prior versions, the history remains
            explicitly incomplete; TrustCircle does not fabricate change events.
          </p>
        </section>
      ) : null}
      <section className="asset-provenance" aria-labelledby="provenance-title">
        <h2 id="provenance-title">Provenance and synchronization</h2>
        <dl>
          <div>
            <dt>Authoritative source</dt>
            <dd>
              <code>{inventory.source}</code>
            </dd>
          </div>
          <div>
            <dt>Last synchronization</dt>
            <dd>{observed ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt>Data quality</dt>
            <dd>{inventory.quality}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{confidence}</dd>
          </div>
        </dl>
      </section>
    </article>
  );
}

export function assetTab(value: string | readonly string[] | undefined): AssetTab {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected === 'relationships' || selected === 'history' ? selected : 'overview';
}
