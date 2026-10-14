import type { ConsoleSectionState } from '../lib/console-loader.ts';
import {
  parseDiscoveryQuery,
  searchConsoleSections,
  statusExplanation,
} from '../lib/platform-workspaces.ts';
import { relativeAge } from '../lib/relative-age.ts';

export type CapabilityWorkspaceKind = 'trends' | 'registers' | 'automation' | 'ai-governance';

const CAPABILITIES: Readonly<
  Record<CapabilityWorkspaceKind, readonly { title: string; description: string; href: string }[]>
> = {
  trends: [
    {
      title: 'Coverage and confidence',
      description: 'Current record coverage and source quality by governed domain.',
      href: '/compliance',
    },
    {
      title: 'Evidence freshness forecast',
      description: 'Expiry and stale-evidence posture from authorized evidence metadata.',
      href: '/search?view=expiring-evidence',
    },
    {
      title: 'Reliability and synchronization',
      description: 'Connector and runtime freshness, health, lag, and failure state.',
      href: '/search?view=connector-health',
    },
    {
      title: 'What changed since review',
      description: 'Attributable snapshots only; unavailable history is shown as a gap.',
      href: '/trends#review-comparison',
    },
  ],
  registers: [
    {
      title: 'Risk and treatment',
      description: 'Material risks, treatment posture, accepted levels, owners, and review dates.',
      href: '/search?q=risk+treatment',
    },
    {
      title: 'Gaps and exceptions',
      description: 'Uncovered, unowned, stale, expiring, and compensating-control records.',
      href: '/gaps',
    },
    {
      title: 'Findings and remediation',
      description: 'Integrity findings, corrective actions, verification, and residual risk.',
      href: '/integrity',
    },
    {
      title: 'Continual improvement',
      description:
        'Operational cases connect incidents, audit findings, failures, and feedback to accountable work.',
      href: '/operations',
    },
  ],
  automation: [
    {
      title: 'Continuous control monitoring',
      description:
        'Health observation, recurring-failure correlation, alert routing, and case updates.',
      href: '/runtime',
    },
    {
      title: 'Evidence lifecycle automation',
      description:
        'Expiry evaluation, custody, sufficiency metadata, export, retention, and legal-hold boundaries.',
      href: '/evidence',
    },
    {
      title: 'Impact preview and simulation',
      description:
        'Policy results, affected scope, risk delta, approvals, source binding, and rollback before execution.',
      href: '/controllers',
    },
    {
      title: 'Notification routing',
      description:
        'Escalation records and governed links preserve the authoritative TrustCircle context.',
      href: '/operations',
    },
  ],
  'ai-governance': [
    {
      title: 'Use-case and model inventory',
      description:
        'AI systems, models, providers, versions, intended use, owners, and lifecycle state.',
      href: '/inventory?q=ai',
    },
    {
      title: 'Evaluation and oversight',
      description: 'Evaluation evidence, limitations, human oversight, findings, and thresholds.',
      href: '/evidence',
    },
    {
      title: 'Lineage and impact',
      description:
        'Reference data, model dependencies, impact assessment, and governed relationships.',
      href: '/compliance',
    },
    {
      title: 'Production incidents and retirement',
      description: 'Monitoring, rollback, remediation, supersession, and retirement evidence.',
      href: '/integrity',
    },
  ],
};

export function CapabilityWorkspace({
  kind,
  sections,
}: {
  readonly kind: CapabilityWorkspaceKind;
  readonly sections: readonly ConsoleSectionState[];
}) {
  const unhealthy = searchConsoleSections(
    sections,
    parseDiscoveryQuery({ sort: 'priority', page_size: '12' }),
  ).items.filter((item) => item.group !== 'healthy');
  const sectionStates = sections.map((section) => ({ section, state: statusExplanation(section) }));
  return (
    <>
      <section className="capability-grid" aria-label="Platform capability entry points">
        {CAPABILITIES[kind].map((capability) => (
          <a href={capability.href} key={capability.title}>
            <strong>{capability.title}</strong>
            <span>{capability.description}</span>
          </a>
        ))}
      </section>
      {kind === 'trends' ? (
        <section id="trend-overview" className="trend-board" aria-labelledby="trend-title">
          <div className="record-region-heading">
            <div>
              <p className="domain-kicker">Current review snapshot</p>
              <h2 id="trend-title">Domain coverage and confidence</h2>
            </div>
            <span>No inferred history</span>
          </div>
          <div className="trend-domain-list">
            {sectionStates.map(({ section, state }) => (
              <article key={section.id}>
                <span>{section.title}</span>
                <strong>{section.recordCount ?? 'Unknown'} records</strong>
                <span className={`status-group status-group--${state.group}`}>{state.label}</span>
                <small>
                  {section.observedAt ? (
                    <time dateTime={section.observedAt} title={section.observedAt}>
                      {relativeAge(section.observedAt) ?? section.observedAt}
                    </time>
                  ) : (
                    'Observation time unavailable'
                  )}
                </small>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="cross-domain-attention" aria-labelledby="cross-domain-title">
          <div className="record-region-heading">
            <div>
              <p className="domain-kicker">Cross-domain governed state</p>
              <h2 id="cross-domain-title">Records requiring follow-through</h2>
            </div>
            <a href="/search?sort=priority">Open full scoped search</a>
          </div>
          {unhealthy.length > 0 ? (
            <ol className="compact-attention-list">
              {unhealthy.map((item) => (
                <li key={`${item.domain}-${item.id}`}>
                  <span className={`status-group status-group--${item.group}`}>{item.label}</span>
                  <div>
                    <strong>
                      <a href={item.href}>{item.title}</a>
                    </strong>
                    <span>
                      {item.domainLabel} · {item.why}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="verified-empty">
              <strong>No unhealthy records in the authorized projection</strong>
              <span>
                Unavailable or incomplete domains remain visible in their workspaces and are not
                treated as healthy.
              </span>
            </div>
          )}
        </section>
      )}
    </>
  );
}
