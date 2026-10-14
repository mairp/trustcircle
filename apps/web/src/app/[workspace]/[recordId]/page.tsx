import { notFound } from 'next/navigation';

import { AuthenticationRequired } from '../../../components/degraded-state.tsx';
import { OperatorShell } from '../../../components/operator-shell.tsx';
import { RecordDetail } from '../../../components/record-detail.tsx';
import { loadConsoleSection } from '../../../lib/console-loader.ts';
import { workspaceForHref } from '../../../lib/platform-workspaces.ts';
import { operationsWorkspaceCapabilities, permittedDomains } from '../../../lib/permissions.ts';
import { resolveOperatorSession } from '../../../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RecordPage({
  params,
}: {
  readonly params: Promise<{ readonly workspace: string; readonly recordId: string }>;
}) {
  const { workspace: workspaceId, recordId: rawRecordId } = await params;
  const workspace = workspaceForHref(`/${workspaceId}`);
  // Only domain workspaces hold records; search, copilot and capability views do not.
  if (!workspace?.domain) notFound();
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const plans = permittedDomains(session);
  const plan = plans.find((candidate) => candidate.id === workspace.domain);
  if (!plan) notFound();
  const recordId = decodeURIComponent(rawRecordId);
  const section = await loadConsoleSection(plan, session);
  const record = section.records.find((candidate) => candidate.id === recordId);
  const readable = section.quality !== 'unavailable' && section.quality !== 'unknown';
  // A complete read that does not contain the record is a real "not found"; anything less is not.
  if (!record && readable && section.hiddenRecordCount === 0) notFound();
  const capabilities = operationsWorkspaceCapabilities(session);
  return (
    <OperatorShell
      session={session}
      plans={plans}
      operationsVisible={capabilities.canRead}
      operationsMutable={!capabilities.readOnly}
      currentPath={workspace.href}
      pageEyebrow={`${workspace.shortLabel} record`}
      pageTitle={record?.title ?? 'Record not in the current read'}
      pageDescription={
        record
          ? `One governed record from ${section.title.toLowerCase()}, exactly as the authoritative read returned it.`
          : 'The record could not be shown from the current authoritative read.'
      }
      breadcrumbs={[
        { label: workspace.shortLabel, href: workspace.href },
        { label: record?.title ?? recordId },
      ]}
    >
      {record ? (
        <RecordDetail workspace={workspace} section={section} record={record} now={Date.now()} />
      ) : (
        <div className="operations-notice" role="alert">
          <strong>
            {readable
              ? `This record is not among the first ${section.records.length} records of the current read.`
              : 'The authoritative read is unavailable, so the record cannot be shown.'}
          </strong>
          <span>
            {readable
              ? 'It may exist beyond the read window. Narrow the view with search to find it.'
              : (section.safeNextAction ?? 'Retry; nothing is inferred while the read is down.')}
          </span>
          <a href={readable ? `/search?q=${encodeURIComponent(recordId)}` : workspace.href}>
            {readable ? 'Search for this record' : `Back to ${workspace.shortLabel}`}
          </a>
        </div>
      )}
    </OperatorShell>
  );
}
