import type { ConsoleSectionState } from '../lib/console-loader.ts';
import {
  PLATFORM_WORKSPACES,
  dashboardForRoles,
  statusExplanation,
} from '../lib/platform-workspaces.ts';
import type { DomainPlan } from '../lib/permissions.ts';
import type { OperatorSessionContext } from '../lib/session-context.ts';

export function RoleDashboard({
  session,
  plans,
  sections,
}: {
  readonly session: OperatorSessionContext;
  readonly plans: readonly DomainPlan[];
  readonly sections: readonly ConsoleSectionState[];
}) {
  const dashboard = dashboardForRoles(session.roles);
  const totalRecords = sections.reduce((total, section) => total + (section.recordCount ?? 0), 0);
  const states = sections.map(statusExplanation);
  const attention = states.filter((state) => state.group === 'needs_attention').length;
  const blocked = states.filter((state) => state.group === 'blocked').length;
  const unknown = states.filter((state) => state.group === 'unknown').length;
  const permitted = new Set(plans.map((plan) => plan.id));
  const shortcuts = PLATFORM_WORKSPACES.filter(
    (workspace) => workspace.domain && permitted.has(workspace.domain),
  ).slice(0, 6);
  return (
    <section className="role-dashboard" aria-labelledby="role-dashboard-title">
      <div className="role-dashboard__intro">
        <div>
          <p className="domain-kicker">Role-specific entry point</p>
          <h2 id="role-dashboard-title">{dashboard.title}</h2>
          <p>{dashboard.summary}</p>
        </div>
        <a className="primary-action" href={dashboard.primaryHref}>
          {dashboard.primaryLabel}
        </a>
      </div>
      <dl className="posture-strip" aria-label="Current governed posture summary">
        <div>
          <dt>Visible records</dt>
          <dd>{totalRecords}</dd>
        </div>
        <div>
          <dt>Needs attention</dt>
          <dd>{attention}</dd>
        </div>
        <div>
          <dt>Blocked domains</dt>
          <dd>{blocked}</dd>
        </div>
        <div>
          <dt>Unknown domains</dt>
          <dd>{unknown}</dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>{dashboard.readOnly ? 'Read only' : 'Policy gated'}</dd>
        </div>
      </dl>
      <div className="workspace-shortcuts" aria-label="Permitted workspace shortcuts">
        {shortcuts.map((workspace) => (
          <a
            data-quality={sections.find((section) => section.id === workspace.domain)?.quality}
            href={workspace.href}
            key={workspace.id}
          >
            <strong>{workspace.shortLabel}</strong>
            <span>{workspace.description}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
