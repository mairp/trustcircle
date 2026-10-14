import { notFound } from 'next/navigation';

import { AuthenticationRequired } from '../../components/degraded-state.tsx';
import { DecisionQueue } from '../../components/decisions/decision-queue.tsx';
import { OperatorShell } from '../../components/operator-shell.tsx';
import { loadDecisionQueue, parseDecisionQueueFilters } from '../../lib/decisions-loader.ts';
import {
  decisionCapabilities,
  operationsWorkspaceCapabilities,
  permittedDomains,
} from '../../lib/permissions.ts';
import { resolveOperatorSession } from '../../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DecisionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const capabilities = decisionCapabilities(session);
  if (!capabilities.canRead) notFound();
  const operations = operationsWorkspaceCapabilities(session);
  const filters = parseDecisionQueueFilters(await searchParams);
  const state = await loadDecisionQueue(session, filters);
  return (
    <OperatorShell
      session={session}
      plans={permittedDomains(session)}
      operationsVisible={operations.canRead}
      operationsMutable={!operations.readOnly}
      currentPath="/decisions"
      pageEyebrow="Governance"
      pageTitle="Decisions and approvals"
      pageDescription="Decision packages routed to people who hold the authority. A reason is required for every action, and nobody can approve their own request."
    >
      <DecisionQueue
        state={state}
        filters={filters}
        capabilities={capabilities}
        principalId={session.principalId}
        now={Date.now()}
      />
    </OperatorShell>
  );
}
