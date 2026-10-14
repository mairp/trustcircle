'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { apiCommand } from '../../lib/api-client.ts';
import { DecisionInputError, parseDecisionActionForm } from '../../lib/decision-view.ts';
import { decisionCapabilities } from '../../lib/permissions.ts';
import { resolveOperatorSession } from '../../lib/session-context.ts';

const MAX_MESSAGE = 300;

function back(decisionId: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `/decisions/${encodeURIComponent(decisionId)}?${query}#decision-outcome`;
}

/**
 * Record a decision action (approve, deny, request changes, escalate, delegate, withdraw).
 *
 * The form carries the ETag of the version the reviewer saw; the API refuses a stale version (412),
 * a missing authority, a separation-of-duties conflict or an expired package, and every refusal is
 * shown on the decision page rather than thrown to the error boundary. Each submission gets a fresh
 * idempotency key, so a double click cannot record two decisions.
 */
export async function actOnDecisionAction(form: FormData): Promise<void> {
  const rawId = form.get('decision_id');
  const decisionId = typeof rawId === 'string' ? rawId.trim() : '';
  let target: string;
  try {
    const parsed = parseDecisionActionForm(form);
    const action = String(parsed.body['action']);
    const session = await resolveOperatorSession();
    const capabilities = decisionCapabilities(session);
    const permitted =
      action === 'cancel'
        ? session.authenticated && capabilities.canRead
        : action === 'delegate'
          ? capabilities.canDelegate
          : capabilities.canAct;
    if (!permitted) throw new DecisionInputError('Your verified role cannot take this action.');

    const result = await apiCommand(
      `/v1/decisions/${parsed.decisionId}/actions`,
      session,
      parsed.body,
      {
        idempotencyKey: randomUUID(),
        ifMatch: parsed.etag,
      },
    );
    if (result.ok) {
      target = back(parsed.decisionId, { outcome: action });
    } else if (result.status === 412) {
      target = back(parsed.decisionId, {
        error:
          'Someone acted on this decision after you opened it. Review the current version below before acting.',
      });
    } else {
      target = back(parsed.decisionId, {
        error: `The action was not recorded${result.diagnostic ? ` (${result.diagnostic})` : ''}. ${
          result.safeNextAction ?? 'Re-read the decision and retry.'
        }`.slice(0, MAX_MESSAGE),
      });
    }
  } catch (error) {
    if (!(error instanceof DecisionInputError)) throw error;
    target = back(decisionId || 'unknown', { error: error.message.slice(0, MAX_MESSAGE) });
  }
  revalidatePath('/decisions');
  redirect(target);
}
