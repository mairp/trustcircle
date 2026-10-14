import { notFound } from 'next/navigation';

import { AuthenticationRequired } from '../../../components/degraded-state.tsx';
import { DecisionPackage } from '../../../components/decisions/decision-package.tsx';
import { OperatorShell } from '../../../components/operator-shell.tsx';
import { statusLabel } from '../../../lib/decision-view.ts';
import { loadDecision } from '../../../lib/decisions-loader.ts';
import {
  decisionCapabilities,
  operationsWorkspaceCapabilities,
  permittedDomains,
} from '../../../lib/permissions.ts';
import { resolveOperatorSession } from '../../../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function DecisionPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly decisionId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const capabilities = decisionCapabilities(session);
  if (!capabilities.canRead) notFound();
  const { decisionId } = await params;
  const query = await searchParams;
  const state = await loadDecision(session, decisionId);
  if (state.status === 'not_found') notFound();
  const operations = operationsWorkspaceCapabilities(session);
  const decision = state.decision;
  const outcome = first(query['outcome']);
  const error = first(query['error']);
  return (
    <OperatorShell
      session={session}
      plans={permittedDomains(session)}
      operationsVisible={operations.canRead}
      operationsMutable={!operations.readOnly}
      currentPath="/decisions"
      pageEyebrow={decision ? `Decision · ${statusLabel(decision.status)}` : 'Decision'}
      pageTitle={decision?.requestedAction ?? 'Decision unavailable'}
      pageDescription={
        decision
          ? 'Review the full package before acting. Your action, reason and identity are recorded in the audit ledger.'
          : 'The decision could not be read, so no action is offered.'
      }
      breadcrumbs={[
        { label: 'Decisions', href: '/decisions' },
        { label: decision?.requestedAction ?? 'Unavailable' },
      ]}
    >
      {decision && state.etag ? (
        <DecisionPackage
          decision={decision}
          etag={state.etag}
          capabilities={capabilities}
          principalId={session.principalId}
          now={Date.now()}
          {...(outcome ? { outcome } : {})}
          {...(error ? { error: error.slice(0, 300) } : {})}
        />
      ) : (
        <div className="operations-notice" role="alert">
          <strong>The decision could not be read.</strong>
          <span>{state.safeNextAction}</span>
          {state.diagnostic ? <code>{state.diagnostic}</code> : null}
          <a href="/decisions">Back to the decision inbox</a>
        </div>
      )}
    </OperatorShell>
  );
}
