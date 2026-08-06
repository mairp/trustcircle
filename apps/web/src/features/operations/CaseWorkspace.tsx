import {
  evaluateOperationalCaseSlaAction,
  transitionOperationalCaseAction,
} from '../../app/operations/actions.ts';
import type { OperationalCaseView, OperationsCasesState } from '../../lib/operations-loader.ts';
import type { OperationsWorkspaceCapabilities } from '../../lib/permissions.ts';
import {
  operationPriorityClass,
  operationsDeadlineLabel,
  operationsStatusLabel,
} from './accessibility.tsx';

function transitionFor(
  item: OperationalCaseView,
  canVerify: boolean,
): { command: string; label: string } | undefined {
  if (item.status === 'open' && item.ownerId)
    return { command: 'acknowledge', label: 'Acknowledge' };
  if (item.status === 'acknowledged' || item.status === 'escalated')
    return { command: 'progress', label: 'Start progress' };
  if (item.status === 'awaiting_verification' && canVerify)
    return { command: 'verify', label: 'Verify resolution' };
  if (item.status === 'resolved') return { command: 'close', label: 'Close verified case' };
  return undefined;
}

function HiddenCaseFields({ item }: { readonly item: OperationalCaseView }) {
  return (
    <>
      <input type="hidden" name="case_id" value={item.id} />
      <input type="hidden" name="expected_version" value={item.version} />
      <input type="hidden" name="etag" value={item.etag} />
    </>
  );
}

export function CaseWorkspace({
  state,
  capabilities,
}: {
  readonly state: OperationsCasesState;
  readonly capabilities: OperationsWorkspaceCapabilities;
}) {
  if (!capabilities.canRead) return null;
  return (
    <section
      id="operations-cases"
      className="operations-workspace operations-cases"
      aria-labelledby="cases-heading"
    >
      <header className="operations-heading">
        <div>
          <p className="eyebrow">Governed ownership</p>
          <h2 id="cases-heading">Operational cases and service levels</h2>
          <p>
            Durable work ownership, optimistic versioning, evidence-bound verification, and explicit
            escalation.
          </p>
        </div>
        <p className="operations-authority" role="status">
          {capabilities.readOnly ? 'Read-only case visibility' : 'Governed case commands available'}
        </p>
      </header>
      {!state.available ? (
        <div className="operations-notice" role="alert">
          <strong>Cases are unavailable.</strong>
          <span>{state.safeNextAction ?? 'Restore the case read before retrying a command.'}</span>
          {state.diagnostic ? <code>{state.diagnostic}</code> : null}
        </div>
      ) : null}
      <div className="case-grid">
        {state.items.map((item) => {
          const transition = transitionFor(item, capabilities.canVerifyCases);
          return (
            <article key={item.id} className="case-card">
              <header>
                <div>
                  <p className="attention-kicker">
                    Case {item.id} · version {item.version}
                  </p>
                  <h3>{item.title}</h3>
                </div>
                <span className={operationPriorityClass(item.priority)}>{item.priority}</span>
              </header>
              <dl className="case-facts">
                <div>
                  <dt>Status</dt>
                  <dd>{operationsStatusLabel(item.status)}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{item.ownerId ?? 'Unowned'}</dd>
                </div>
                <div>
                  <dt>Acknowledge</dt>
                  <dd>{operationsDeadlineLabel(item.acknowledgementTargetAt)}</dd>
                </div>
                <div>
                  <dt>Resolve</dt>
                  <dd>{operationsDeadlineLabel(item.resolutionTargetAt)}</dd>
                </div>
                <div>
                  <dt>Escalation</dt>
                  <dd>Level {item.escalationLevel}</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>{item.evidenceReferences.length}</dd>
                </div>
              </dl>
              {item.breachTypes.length > 0 ? (
                <p className="case-breach" role="alert">
                  Breached: {item.breachTypes.map(operationsStatusLabel).join(', ')}
                </p>
              ) : null}
              <details>
                <summary>Sources and control state</summary>
                <ul>
                  {item.sources.map((source) => (
                    <li key={`${source.domain}:${source.recordId}`}>
                      <a href={source.href}>
                        {source.recordType} · {source.recordId}
                      </a>{' '}
                      ·{' '}
                      {source.resolved === true
                        ? 'resolved'
                        : source.resolved === false
                          ? 'open'
                          : 'unknown'}
                    </li>
                  ))}
                </ul>
              </details>
              <div className="case-commands">
                {capabilities.canTransitionCases && !item.ownerId ? (
                  <form action={transitionOperationalCaseAction}>
                    <HiddenCaseFields item={item} />
                    <input type="hidden" name="command" value="assign" />
                    <label>
                      Assign owner <input name="owner_id" required maxLength={160} />
                    </label>
                    <label>
                      Reason <input name="reason" required minLength={8} maxLength={2000} />
                    </label>
                    <button type="submit">Assign</button>
                  </form>
                ) : null}
                {capabilities.canTransitionCases && transition ? (
                  <form action={transitionOperationalCaseAction}>
                    <HiddenCaseFields item={item} />
                    <input type="hidden" name="command" value={transition.command} />
                    <label>
                      Reason{' '}
                      <input
                        name="reason"
                        required
                        minLength={8}
                        maxLength={2000}
                        placeholder="Attributable command reason"
                      />
                    </label>
                    <button type="submit">{transition.label}</button>
                  </form>
                ) : null}
                {item.status === 'in_progress' || (item.status === 'escalated' && item.ownerId) ? (
                  <p className="operations-readonly">
                    Submit-for-verification remains API-gated until current resolved source versions
                    and evidence references are supplied; this workspace will not infer them.
                  </p>
                ) : null}
                {capabilities.canEvaluateSla && item.status !== 'closed' ? (
                  <form action={evaluateOperationalCaseSlaAction}>
                    <HiddenCaseFields item={item} />
                    <button type="submit">Evaluate SLA now</button>
                  </form>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {state.available && state.items.length === 0 ? (
        <p className="operations-empty">No operational cases exist in this tenant scope.</p>
      ) : null}
    </section>
  );
}
