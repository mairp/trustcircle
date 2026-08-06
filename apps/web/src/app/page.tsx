import { redirect } from 'next/navigation';

import { AuthenticationRequired, ConsoleSummary } from '../components/degraded-state.tsx';
import { DashboardSnapshot } from '../components/dashboard-snapshot.tsx';
import { OperatorShell } from '../components/operator-shell.tsx';
import { RoleDashboard } from '../components/role-dashboard.tsx';
import { loadConsole } from '../lib/console-loader.ts';
import { operationsWorkspaceCapabilities, permittedDomains } from '../lib/permissions.ts';
import { resolveOperatorSession } from '../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const OPERATION_FILTERS = [
  'domain',
  'severity',
  'ownership',
  'time_posture',
  'freshness',
  'assignment',
] as const;

export default async function ConsolePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const incoming = await searchParams;
  const operationQuery = new URLSearchParams();
  for (const key of OPERATION_FILTERS) {
    const value = Array.isArray(incoming[key]) ? incoming[key][0] : incoming[key];
    if (value) operationQuery.set(key, value.slice(0, 160));
  }
  if (operationQuery.size > 0) redirect(`/operations?${operationQuery.toString()}`);
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const plans = permittedDomains(session);
  const capabilities = operationsWorkspaceCapabilities(session);
  const sections = await loadConsole(plans, session);
  return (
    <OperatorShell
      session={session}
      plans={plans}
      operationsVisible={capabilities.canRead}
      operationsMutable={!capabilities.readOnly}
    >
      <ConsoleSummary sections={sections} />
      <RoleDashboard session={session} plans={plans} sections={sections} />
      <DashboardSnapshot sections={sections} />
    </OperatorShell>
  );
}
