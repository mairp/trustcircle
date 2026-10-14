import type { ReactNode } from 'react';

import { actOnDecisionAction } from '../../app/decisions/actions.ts';
import {
  REASON_CODES,
  REVIEW_ACTIONS,
  actingPosition,
  isTerminal,
  openRequirements,
  outcomeLabel,
  requirementStatusLabel,
  statusLabel,
  timePosture,
  timePostureLabel,
  type DecisionActionVerb,
  type DecisionView,
} from '../../lib/decision-view.ts';
import type { DecisionCapabilities } from '../../lib/permissions.ts';
import { relativeAge } from '../../lib/relative-age.ts';

const ACTION_COPY: Readonly<
  Record<DecisionActionVerb, { title: string; submit: string; hint: string }>
> = {
  approve: {
    title: 'Approve',
    submit: 'Approve decision',
    hint: 'Approves the requested action under your authority.',
  },
  deny: { title: 'Deny', submit: 'Deny decision', hint: 'Refuses the requested action.' },
  request_changes: {
    title: 'Request changes',
    submit: 'Request changes',
    hint: 'Returns the package to the requester with what is missing.',
  },
  escalate: {
    title: 'Escalate',
    submit: 'Escalate decision',
    hint: 'Sends the decision to a higher authority.',
  },
  delegate: {
    title: 'Delegate',
    submit: 'Delegate decision',
    hint: 'Grants another principal time-bound authority over this decision.',
  },
  cancel: {
    title: 'Withdraw request',
    submit: 'Withdraw request',
    hint: 'Cancels your own open request. It cannot be reopened.',
  },
};

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not stated';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(display).join(', ') || 'None';
  return JSON.stringify(value);
}

function Facts({
  data,
  empty,
}: {
  readonly data: Readonly<Record<string, unknown>>;
  readonly empty: string;
}) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <p className="decision-missing">{empty}</p>;
  return (
    <dl className="decision-facts">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{humanize(key)}</dt>
          <dd>{display(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function FactCards({
  items,
  empty,
}: {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly empty: string;
}) {
  if (items.length === 0) return <p className="decision-missing">{empty}</p>;
  return (
    <ol className="decision-cards">
      {items.map((item, index) => (
        <li key={index}>
          <Facts data={item} empty="No detail recorded." />
        </li>
      ))}
    </ol>
  );
}

function ReasonFields({ action }: { readonly action: DecisionActionVerb }) {
  return (
    <>
      <label>
        Reason
        <select name="reason_code" required defaultValue="">
          <option value="" disabled>
            Choose a reason
          </option>
          {REASON_CODES[action].map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Explanation
        <textarea
          name="reason_text"
          required
          minLength={3}
          maxLength={4000}
          rows={3}
          placeholder="What you checked and why. This is recorded with your identity."
        />
      </label>
    </>
  );
}

function ActionForm({
  decision,
  etag,
  action,
  children,
}: {
  readonly decision: DecisionView;
  readonly etag: string;
  readonly action: DecisionActionVerb;
  readonly children?: ReactNode;
}) {
  const copy = ACTION_COPY[action];
  return (
    <details className={`decision-action decision-action--${action}`}>
      <summary>{copy.title}</summary>
      <form action={actOnDecisionAction}>
        <p>{copy.hint}</p>
        <input type="hidden" name="decision_id" value={decision.id} />
        <input type="hidden" name="etag" value={etag} />
        <input type="hidden" name="action" value={action} />
        {children}
        <ReasonFields action={action} />
        <button type="submit">{copy.submit}</button>
      </form>
    </details>
  );
}

export function DecisionPackage({
  decision,
  etag,
  capabilities,
  principalId,
  now,
  outcome,
  error,
}: {
  readonly decision: DecisionView;
  readonly etag: string;
  readonly capabilities: DecisionCapabilities;
  readonly principalId: string | undefined;
  readonly now: number;
  readonly outcome?: string;
  readonly error?: string;
}) {
  const posture = timePosture(decision.expiresAt, now);
  const gates = openRequirements(decision);
  const position = actingPosition(
    decision,
    principalId,
    capabilities.canAct,
    capabilities.canDelegate,
    now,
  );

  return (
    <div className="decision-layout">
      <div id="decision-outcome">
        {outcome ? (
          <p className="decision-banner decision-banner--ok" role="status">
            <strong>{`${outcomeLabel(outcome)}.`}</strong> Your action and reason are recorded in
            the audit ledger. The package below shows the current version.
          </p>
        ) : null}
        {error ? (
          <p className="decision-banner decision-banner--error" role="alert">
            <strong>Not recorded.</strong> {error}
          </p>
        ) : null}
      </div>

      <section className="decision-summary" aria-labelledby="decision-summary-heading">
        <h2 id="decision-summary-heading" className="visually-hidden">
          Summary
        </h2>
        <dl className="operations-summary">
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(decision.status)}</dd>
          </div>
          <div>
            <dt>Risk tier</dt>
            <dd>
              <span className={`decision-risk decision-risk--${decision.riskTier}`}>
                {decision.riskTier}
              </span>
            </dd>
          </div>
          <div>
            <dt>Expiry</dt>
            <dd>
              <span className={`decision-time decision-time--${posture}`}>
                {isTerminal(decision.status) ? 'Closed' : timePostureLabel(posture)}
              </span>
            </dd>
          </div>
          <div>
            <dt>Open gates</dt>
            <dd>{gates.length}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{decision.version}</dd>
          </div>
        </dl>
      </section>

      <div className="decision-columns">
        <div className="decision-main">
          <section className="decision-section" aria-labelledby="decision-what">
            <h2 id="decision-what">What is being decided</h2>
            <dl className="decision-facts">
              <div>
                <dt>Requested action</dt>
                <dd>{decision.requestedAction}</dd>
              </div>
              <div>
                <dt>Action class</dt>
                <dd>{decision.actionClass}</dd>
              </div>
              <div>
                <dt>Requested by</dt>
                <dd>
                  <code>{decision.requesterPrincipalId}</code>
                  {principalId === decision.requesterPrincipalId ? ' (you)' : ''}
                </dd>
              </div>
              <div>
                <dt>Requested</dt>
                <dd>
                  <time dateTime={decision.createdAt} title={decision.createdAt}>
                    {relativeAge(decision.createdAt, now) ?? 'Unknown'}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>
                  <time dateTime={decision.expiresAt}>
                    {decision.expiresAt
                      ? `${decision.expiresAt.slice(0, 16).replace('T', ' ')} UTC`
                      : 'Unknown'}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Work item</dt>
                <dd>
                  <code>{decision.workItemId}</code>
                </dd>
              </div>
            </dl>
            <h3>Scope</h3>
            <Facts data={decision.scope} empty="No scope recorded." />
            <h3>Expected result</h3>
            <Facts data={decision.expectedResult} empty="No expected result recorded." />
          </section>

          <section className="decision-section" aria-labelledby="decision-impact">
            <h2 id="decision-impact">Business impact</h2>
            <Facts data={decision.businessImpact} empty="No business impact recorded." />
          </section>

          <section className="decision-section" aria-labelledby="decision-risks">
            <h2 id="decision-risks">Risks</h2>
            <FactCards
              items={decision.risks}
              empty="No risks recorded. Ask why before approving."
            />
          </section>

          <section className="decision-section" aria-labelledby="decision-alternatives">
            <h2 id="decision-alternatives">Alternatives considered</h2>
            <FactCards items={decision.alternatives} empty="No alternatives recorded." />
          </section>

          <section className="decision-section" aria-labelledby="decision-gates">
            <h2 id="decision-gates">Approval gates</h2>
            {decision.requirements.length === 0 ? (
              <p className="decision-missing">No approval gates are attached.</p>
            ) : (
              <ul className="decision-gates">
                {decision.requirements.map((gate) => (
                  <li key={gate.id} data-gate-status={gate.status}>
                    <strong>{humanize(gate.gateType)}</strong>
                    <span className={`decision-gate decision-gate--${gate.status}`}>
                      {requirementStatusLabel(gate.status)}
                    </span>
                    <small>
                      {gate.minimumDistinctPrincipals > 1
                        ? `Needs ${gate.minimumDistinctPrincipals} different approvers`
                        : 'Needs one approver'}
                      {gate.incompatibleRelationships.length > 0
                        ? ` · may not be: ${gate.incompatibleRelationships.map(humanize).join(', ').toLowerCase()}`
                        : ''}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="decision-section" aria-labelledby="decision-evidence">
            <h2 id="decision-evidence">Evidence</h2>
            <dl className="decision-facts">
              <div>
                <dt>Evidence manifest</dt>
                <dd>
                  {decision.evidenceManifestId ? (
                    <code>{decision.evidenceManifestId}</code>
                  ) : (
                    <span className="decision-missing">None attached</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Simulation</dt>
                <dd>
                  {decision.simulationId ? <code>{decision.simulationId}</code> : 'None attached'}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <aside className="decision-panel" aria-labelledby="decision-panel-heading">
          <h2 id="decision-panel-heading">Your decision</h2>
          {position.blockedReason ? (
            <p className="decision-blocked" role="note">
              {position.blockedReason}
            </p>
          ) : (
            <p>
              You are acting on version {decision.version}. If the package changes before you
              submit, you will be asked to review it again. A reason is always required.
            </p>
          )}
          {position.canReview
            ? REVIEW_ACTIONS.map((action) => (
                <ActionForm key={action} decision={decision} etag={etag} action={action} />
              ))
            : null}
          {position.canDelegate ? (
            <ActionForm decision={decision} etag={etag} action="delegate">
              <label>
                Recipient principal ID
                <input name="recipient_principal_id" required pattern="[0-9a-fA-F-]{36}" />
              </label>
              <label>
                Authority assignment ID
                <input name="authority_assignment_id" required pattern="[0-9a-fA-F-]{36}" />
              </label>
              <fieldset>
                <legend>Actions delegated</legend>
                {REVIEW_ACTIONS.map((action) => (
                  <label key={action} className="decision-check">
                    <input type="checkbox" name="delegated_actions" value={action} />
                    {ACTION_COPY[action].title}
                  </label>
                ))}
              </fieldset>
              <label>
                Valid from (UTC)
                <input type="datetime-local" name="valid_from" required />
              </label>
              <label>
                Expires (UTC)
                <input type="datetime-local" name="delegation_expires_at" required />
              </label>
            </ActionForm>
          ) : null}
          {position.canCancel ? (
            <ActionForm decision={decision} etag={etag} action="cancel" />
          ) : null}
          <p className="decision-footnote">
            The platform prepares and records. It never approves on anyone's behalf.
          </p>
        </aside>
      </div>
    </div>
  );
}
