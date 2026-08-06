import { notFound } from 'next/navigation';

import {
  CapabilityWorkspace,
  type CapabilityWorkspaceKind,
} from '../../components/capability-workspace.tsx';
import { CopilotWorkspace } from '../../components/copilot-workspace.tsx';
import { AuthenticationRequired } from '../../components/degraded-state.tsx';
import { DiscoveryWorkspace } from '../../components/discovery-workspace.tsx';
import {
  GovernedAiWorkspace,
  GovernedConnectorWorkspace,
  GovernedEvidenceWorkspace,
  GovernedFrameworkMatrixWorkspace,
  GovernedMonitoringWorkspace,
  GovernedPlatformWorkspace,
  GovernedRegisterWorkspace,
} from '../../components/governed-platform-workspace.tsx';
import { OperatorShell } from '../../components/operator-shell.tsx';
import { WorkspaceOverview } from '../../components/workspace-overview.tsx';
import { loadConsole, loadConsoleSection } from '../../lib/console-loader.ts';
import {
  loadGovernedAiWorkspace,
  loadGovernedConnectorWorkspace,
  loadGovernedEvidenceWorkspace,
  loadGovernedFrameworkMatrixWorkspace,
  loadGovernedMonitoringWorkspace,
  loadGovernedRegisterWorkspace,
  loadGovernedReviewWorkspace,
} from '../../lib/governed-platform.ts';
import { parseDiscoveryQuery, workspaceForHref } from '../../lib/platform-workspaces.ts';
import { operationsWorkspaceCapabilities, permittedDomains } from '../../lib/permissions.ts';
import { resolveOperatorSession } from '../../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CAPABILITY_KINDS = new Set<CapabilityWorkspaceKind>([
  'trends',
  'registers',
  'automation',
  'ai-governance',
]);

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workspace: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: workspaceId } = await params;
  const workspace = workspaceForHref(`/${workspaceId}`);
  if (!workspace || workspace.href === '/operations') notFound();
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const plans = permittedDomains(session);
  const capabilities = operationsWorkspaceCapabilities(session);
  const queryParams = await searchParams;
  const plan = workspace.domain
    ? plans.find((candidate) => candidate.id === workspace.domain)
    : undefined;
  if (workspace.domain && !plan) notFound();
  const needsAllSections =
    workspace.id === 'search' ||
    workspace.id === 'copilot' ||
    CAPABILITY_KINDS.has(workspace.id as CapabilityWorkspaceKind);
  const sections = needsAllSections ? await loadConsole(plans, session) : [];
  const section = plan ? await loadConsoleSection(plan, session) : undefined;
  const reviewState =
    workspace.id === 'trends' ? await loadGovernedReviewWorkspace(session) : undefined;
  const registerState =
    workspace.id === 'registers' ? await loadGovernedRegisterWorkspace(session) : undefined;
  const evidenceState =
    workspace.id === 'evidence' ? await loadGovernedEvidenceWorkspace(session) : undefined;
  const monitoringState =
    workspace.id === 'automation' ? await loadGovernedMonitoringWorkspace(session) : undefined;
  const aiState =
    workspace.id === 'ai-governance' ? await loadGovernedAiWorkspace(session) : undefined;
  const connectorState =
    workspace.id === 'integrations' ? await loadGovernedConnectorWorkspace(session) : undefined;
  const frameworkMatrixState =
    workspace.id === 'compliance' ? await loadGovernedFrameworkMatrixWorkspace(session) : undefined;

  return (
    <OperatorShell
      session={session}
      plans={plans}
      operationsVisible={capabilities.canRead}
      operationsMutable={!capabilities.readOnly}
      currentPath={workspace.href}
      pageEyebrow={
        workspace.group === 'intelligence' ? 'Governance intelligence' : 'Governed workspace'
      }
      pageTitle={workspace.label}
      pageDescription={workspace.description}
    >
      {workspace.id === 'search' ? (
        <DiscoveryWorkspace
          sections={sections}
          query={parseDiscoveryQuery(queryParams)}
          principalId={session.principalId}
          scope={`${session.tenantId}:${session.roles.join(',')}`}
        />
      ) : workspace.id === 'copilot' ? (
        <CopilotWorkspace sections={sections} question={queryParams['question']} />
      ) : workspace.id === 'trends' && reviewState ? (
        <>
          <CapabilityWorkspace kind="trends" sections={sections} />
          <GovernedPlatformWorkspace state={reviewState} />
        </>
      ) : workspace.id === 'registers' && registerState ? (
        <>
          <CapabilityWorkspace kind="registers" sections={sections} />
          <GovernedRegisterWorkspace state={registerState} />
        </>
      ) : workspace.id === 'automation' && monitoringState ? (
        <>
          <CapabilityWorkspace kind="automation" sections={sections} />
          <GovernedMonitoringWorkspace state={monitoringState} />
        </>
      ) : workspace.id === 'ai-governance' && aiState ? (
        <>
          <CapabilityWorkspace kind="ai-governance" sections={sections} />
          <GovernedAiWorkspace state={aiState} />
        </>
      ) : CAPABILITY_KINDS.has(workspace.id as CapabilityWorkspaceKind) ? (
        <CapabilityWorkspace kind={workspace.id as CapabilityWorkspaceKind} sections={sections} />
      ) : workspace.id === 'evidence' && evidenceState && section ? (
        <>
          <WorkspaceOverview section={section} />
          <GovernedEvidenceWorkspace state={evidenceState} />
        </>
      ) : workspace.id === 'integrations' && connectorState && section ? (
        <>
          <WorkspaceOverview section={section} />
          <GovernedConnectorWorkspace state={connectorState} />
        </>
      ) : workspace.id === 'compliance' && frameworkMatrixState && section ? (
        <>
          <WorkspaceOverview section={section} />
          <GovernedFrameworkMatrixWorkspace state={frameworkMatrixState} />
        </>
      ) : section ? (
        <WorkspaceOverview section={section} />
      ) : null}
    </OperatorShell>
  );
}
