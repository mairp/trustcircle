import type { ConsoleSectionState } from '../lib/console-loader.ts';
import { GovernanceSection } from './governance-status.tsx';

const DASHBOARD_DOMAINS = new Set(['posture', 'inventory', 'decisions']);

export function DashboardSnapshot({
  sections,
}: {
  readonly sections: readonly ConsoleSectionState[];
}) {
  const snapshot = sections.filter((section) => DASHBOARD_DOMAINS.has(section.id));
  return (
    <details className="dashboard-snapshot">
      <summary>
        <span>
          <strong>Current governed snapshot</strong>
          <small>Posture, priority inventory, and decision availability</small>
        </span>
        <span>{snapshot.length} domains</span>
      </summary>
      <div className="section-grid">
        {snapshot.map((section) => (
          <GovernanceSection key={section.id} section={section} />
        ))}
      </div>
    </details>
  );
}
