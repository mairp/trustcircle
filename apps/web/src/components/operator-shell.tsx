import type { ReactNode } from 'react';

import { SearchShortcut } from './search-shortcut.tsx';

import {
  PLATFORM_WORKSPACES,
  deploymentIdentity,
  workspaceForDomain,
  workspaceForHref,
  type PlatformWorkspace,
} from '../lib/platform-workspaces.ts';
import type { DomainPlan } from '../lib/permissions.ts';
import type { OperatorSessionContext } from '../lib/session-context.ts';
import { ThemeToggle } from './theme-toggle.tsx';
import { ProductAnalytics } from './product-analytics.tsx';

interface ShellLink {
  readonly href: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly group: 'Overview' | 'Governance' | 'Assurance' | 'Platform' | 'Intelligence';
}

const GROUP_LABELS: Readonly<Record<PlatformWorkspace['group'], ShellLink['group']>> = {
  overview: 'Overview',
  governance: 'Governance',
  assurance: 'Assurance',
  platform: 'Platform',
  intelligence: 'Intelligence',
};

function shellLinks(
  plans: readonly DomainPlan[],
  operationsVisible: boolean,
): readonly ShellLink[] {
  const permittedDomains = new Set(plans.map((plan) => plan.id));
  const domainLinks = PLATFORM_WORKSPACES.filter(
    (workspace) => workspace.domain && permittedDomains.has(workspace.domain),
  );
  const capabilityLinks = PLATFORM_WORKSPACES.filter(
    (workspace) =>
      !workspace.domain &&
      workspace.id !== 'operations-command-center' &&
      (plans.length > 0 || workspace.id === 'search'),
  );
  return [
    { href: '/', label: 'Role dashboard', shortLabel: 'Dashboard', group: 'Overview' as const },
    ...(operationsVisible
      ? [
          {
            href: '/operations',
            label: 'Operations command center',
            shortLabel: 'Attention queue',
            group: 'Overview' as const,
          },
        ]
      : []),
    ...[...domainLinks, ...capabilityLinks].map((workspace) => ({
      href: workspace.href,
      label: workspace.label,
      shortLabel: workspace.shortLabel,
      group: GROUP_LABELS[workspace.group],
    })),
  ];
}

function Navigation({
  links,
  currentPath,
}: {
  readonly links: readonly ShellLink[];
  readonly currentPath: string;
}) {
  const groups: readonly ShellLink['group'][] = [
    'Overview',
    'Governance',
    'Assurance',
    'Platform',
    'Intelligence',
  ];
  return (
    <nav aria-label="Workspace navigation" className="workspace-navigation">
      {groups.map((group) => {
        const entries = links.filter((link) => link.group === group);
        return entries.length > 0 ? (
          <div className="workspace-navigation__group" key={group}>
            <p>{group}</p>
            <ul>
              {entries.map((link) => (
                <li key={link.href}>
                  <a href={link.href} aria-current={currentPath === link.href ? 'page' : undefined}>
                    {link.shortLabel}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null;
      })}
    </nav>
  );
}

export function OperatorShell({
  session,
  plans,
  operationsVisible,
  operationsMutable,
  currentPath = '/',
  pageTitle = 'Governance operating picture',
  pageEyebrow = 'Operator console',
  pageDescription = 'A tenant-scoped view of governance posture, evidence, and operational health.',
  children,
}: {
  readonly session: OperatorSessionContext;
  readonly plans: readonly DomainPlan[];
  readonly operationsVisible: boolean;
  readonly operationsMutable: boolean;
  readonly currentPath?: string;
  readonly pageTitle?: string;
  readonly pageEyebrow?: string;
  readonly pageDescription?: string;
  readonly children: ReactNode;
}) {
  const links = shellLinks(plans, operationsVisible);
  const activeWorkspace = workspaceForHref(currentPath);
  const build = deploymentIdentity();
  return (
    <>
      <header className="masthead">
        <div className="product-bar">
          <a className="product-mark" href="/" aria-label="TrustCircle dashboard home">
            <span className="product-mark__symbol" aria-hidden="true">
              TC
            </span>
            <span>
              <strong>TrustCircle</strong>
              <small>Governance operating system</small>
            </span>
          </a>
          <div className="product-actions">
            <a className="global-search-link" href="/search">
              <span aria-hidden="true">⌕</span>
              Search governed records
              <kbd>/</kbd>
            </a>
            <SearchShortcut />
            <span className={`deployment-mode deployment-mode--${build.mode}`}>
              {build.profile}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="workspace-frame">
        <aside className="workspace-sidebar" aria-label="Persistent workspace navigation">
          <Navigation links={links} currentPath={currentPath} />
          <div className="sidebar-scope">
            <p>Active scope</p>
            <strong>Scope verified</strong>
            <span>{session.roles.join(', ') || 'No authorized role'}</span>
          </div>
        </aside>

        <div className="workspace-content">
          <details className="mobile-workspace-navigation">
            <summary>Navigate workspaces</summary>
            <Navigation links={links} currentPath={currentPath} />
          </details>

          <nav aria-label="Breadcrumb" className="breadcrumbs">
            <ol>
              <li>
                {currentPath === '/' ? (
                  <span aria-current="page">Dashboard</span>
                ) : (
                  <a href="/">Dashboard</a>
                )}
              </li>
              {currentPath !== '/' ? (
                <li>
                  <span aria-current="page">{activeWorkspace?.shortLabel ?? pageTitle}</span>
                </li>
              ) : null}
            </ol>
          </nav>

          <section className="page-heading" aria-labelledby="page-title">
            <div className="page-heading__copy">
              <p className="eyebrow">{pageEyebrow}</p>
              <h1 id="page-title">{pageTitle}</h1>
              <p className="lede">{pageDescription}</p>
            </div>
            <aside className="compact-scope" aria-label="Authority and scope">
              <span className="scope-state">
                <span aria-hidden="true" /> Verified scope
              </span>
              <strong>{session.tenantName ?? 'Tenant unavailable'}</strong>
              <small>{session.roles.join(', ') || 'No authorized role'}</small>
            </aside>
          </section>

          <div className="authority-note">
            <span className="authority-note__icon" aria-hidden="true">
              i
            </span>
            <span>
              {operationsMutable
                ? 'Governed case commands are enabled; source-system execution remains separately authorized.'
                : 'Read-only visibility. This workspace has no approval or execution authority.'}
            </span>
          </div>
          {session.principalId === 'local-preview-operator' ? (
            <p className="preview-notice" role="status">
              Local preview mode · fixed auditor scope · no action authority
            </p>
          ) : null}

          <main id="main-content" tabIndex={-1}>
            {children}
          </main>

          <ProductAnalytics route={currentPath} />
          <footer>
            <p>
              Internal operating visibility only. Readiness, mappings, and internal evidence do not
              establish legal compliance, conformity, accreditation, or certification.
            </p>
            <details className="support-diagnostics">
              <summary>Support diagnostics</summary>
              <dl>
                <div>
                  <dt>Application version</dt>
                  <dd>{build.version}</dd>
                </div>
                <div>
                  <dt>Build commit</dt>
                  <dd>
                    <code>{build.commit}</code>
                  </dd>
                </div>
                <div>
                  <dt>Deployment profile</dt>
                  <dd>{build.profile}</dd>
                </div>
                <div>
                  <dt>Schema version</dt>
                  <dd>{build.schemaVersion}</dd>
                </div>
                <div>
                  <dt>Approved-release drift</dt>
                  <dd data-drift={build.drift}>{build.drift}</dd>
                </div>
              </dl>
            </details>
          </footer>
        </div>
      </div>
    </>
  );
}

export function workspacePathForPlan(plan: DomainPlan): string {
  return workspaceForDomain(plan.id)?.href ?? `/${plan.id}`;
}
