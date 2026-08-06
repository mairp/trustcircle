import type { ConsoleSectionState } from '../lib/console-loader.ts';
import {
  classifyRecordStatus,
  statusExplanation,
  type StatusGroup,
} from '../lib/platform-workspaces.ts';
import { GovernanceSection } from './governance-status.tsx';

const GROUPS: readonly StatusGroup[] = ['needs_attention', 'blocked', 'unknown', 'healthy'];

const LABELS: Readonly<Record<StatusGroup, string>> = {
  needs_attention: 'Needs attention',
  blocked: 'Blocked',
  unknown: 'Unknown',
  healthy: 'Healthy',
};

export function WorkspaceOverview({ section }: { readonly section: ConsoleSectionState }) {
  const explanation = statusExplanation(section);
  const recordGroups = section.records.reduce<Record<StatusGroup, number>>(
    (counts, record) => {
      const group = classifyRecordStatus(record).group;
      return { ...counts, [group]: counts[group] + 1 };
    },
    { needs_attention: 0, blocked: 0, unknown: 0, healthy: 0 },
  );
  return (
    <>
      <section className={`status-explanation status-explanation--${explanation.group}`}>
        <div>
          <p className="domain-kicker">Current domain posture</p>
          <h2>{explanation.label}</h2>
          <p>{explanation.why}</p>
        </div>
        <p>
          <strong>Safe next action</strong>
          <span>{explanation.safeNextAction}</span>
        </p>
      </section>
      <nav className="status-group-nav" aria-label="Record status views">
        {GROUPS.map((group) => (
          <a href={`/search?domain=${section.id}&group=${group}`} key={group}>
            <span>{LABELS[group]}</span>
            <strong>{recordGroups[group]}</strong>
          </a>
        ))}
      </nav>
      <GovernanceSection section={section} />
    </>
  );
}
