import { AuthenticationRequired } from '../../components/degraded-state.tsx';
import { OperatorShell } from '../../components/operator-shell.tsx';
import { AttentionQueue } from '../../features/operations/AttentionQueue.tsx';
import { CaseWorkspace } from '../../features/operations/CaseWorkspace.tsx';
import {
  loadOperationsWorkspace,
  parseOperationsWorkspaceFilters,
} from '../../lib/operations-loader.ts';
import { operationsWorkspaceCapabilities, permittedDomains } from '../../lib/permissions.ts';
import { resolveOperatorSession } from '../../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function OperationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const plans = permittedDomains(session);
  const capabilities = operationsWorkspaceCapabilities(session);
  const filters = parseOperationsWorkspaceFilters(await searchParams);
  const operations = await loadOperationsWorkspace(session, capabilities, filters);
  return (
    <OperatorShell
      session={session}
      plans={plans}
      operationsVisible={capabilities.canRead}
      operationsMutable={!capabilities.readOnly}
      currentPath="/operations"
      pageEyebrow="Operational governance"
      pageTitle="Operations command center"
      pageDescription="One role-scoped queue for urgent governance work, accountable cases, service levels, escalation, and safe next actions."
    >
      <AttentionQueue state={operations.attention} capabilities={capabilities} filters={filters} />
      <CaseWorkspace state={operations.cases} capabilities={capabilities} />
    </OperatorShell>
  );
}
