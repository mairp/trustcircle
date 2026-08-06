import type { ConsoleSectionState } from '../lib/console-loader.ts';
import { parseDiscoveryQuery, searchConsoleSections } from '../lib/platform-workspaces.ts';

function scalar(value: string | readonly string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 400) ?? '';
}

export function CopilotWorkspace({
  sections,
  question: questionInput,
}: {
  readonly sections: readonly ConsoleSectionState[];
  readonly question: string | readonly string[] | undefined;
}) {
  const question = scalar(questionInput);
  const result = searchConsoleSections(
    sections,
    parseDiscoveryQuery({ q: question, sort: 'priority', page_size: '8' }),
  );
  const cited = question ? result.items : [];
  const blocked = cited.filter((item) => item.group === 'blocked').length;
  const uncertain = cited.filter((item) => item.group === 'unknown').length;
  return (
    <>
      <section className="copilot-boundary" aria-labelledby="copilot-boundary-title">
        <div>
          <p className="domain-kicker">Citation-only assistance</p>
          <h2 id="copilot-boundary-title">Facts stay separate from inference</h2>
        </div>
        <ul>
          <li>Only records already authorized for this tenant and role are searched.</li>
          <li>
            Every factual statement links to its governed TrustCircle record and source metadata.
          </li>
          <li>
            The copilot cannot approve, attest, verify, close, or execute any governed action.
          </li>
        </ul>
      </section>
      <form className="copilot-form" method="get" action="/copilot">
        <label htmlFor="question">
          Ask about governed posture, evidence, changes, or remediation
        </label>
        <textarea
          id="question"
          name="question"
          defaultValue={question}
          maxLength={400}
          rows={3}
          placeholder="Which high-risk systems have stale evidence?"
        />
        <div>
          <button type="submit">Answer from governed records</button>
          <span>Read-only · tenant scoped · freshness visible</span>
        </div>
      </form>
      {question ? (
        <article className="copilot-answer" aria-labelledby="copilot-answer-title">
          <p className="domain-kicker">Governed answer</p>
          <h2 id="copilot-answer-title">{question}</h2>
          <section>
            <h3>Facts</h3>
            {cited.length > 0 ? (
              <ol className="citation-list">
                {cited.map((item, index) => (
                  <li key={`${item.domain}-${item.id}`}>
                    <p>
                      <strong>
                        [{index + 1}] {item.title}
                      </strong>{' '}
                      is classified as <strong>{item.label}</strong>. {item.why}
                    </p>
                    <p>
                      Freshness: {item.observedAt ?? 'unknown'} · confidence:{' '}
                      {item.confidence ?? 'unknown'} · owner: {item.owner ?? 'unknown'}.
                    </p>
                    <a href={item.href}>Open governed record [{index + 1}]</a>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="verified-empty">
                <strong>No citable records matched</strong>
                <span>No answer is inferred from absent, unauthorized, or unavailable data.</span>
              </div>
            )}
          </section>
          <section>
            <h3>Inference</h3>
            <p>
              {cited.length > 0
                ? `The matched projection contains ${blocked} blocked and ${uncertain} unknown record${uncertain === 1 ? '' : 's'}. This suggests prioritizing authoritative investigation before relying on aggregate posture.`
                : 'There is insufficient governed evidence for an inference.'}
            </p>
          </section>
          <section>
            <h3>Recommendation</h3>
            <p>
              {cited.length > 0
                ? 'Open the highest-priority cited record, confirm its current owner and source freshness, then use only the safe next action exposed by that authoritative workflow.'
                : 'Broaden the question or restore unavailable domain reads; do not treat the empty answer as a healthy result.'}
            </p>
          </section>
        </article>
      ) : (
        <section className="copilot-starters" aria-labelledby="starter-title">
          <h2 id="starter-title">Suggested questions</h2>
          <div>
            {[
              'Why is this asset only partially covered?',
              'Which high-risk systems have stale evidence?',
              'What changed since the last audit review?',
              'Draft a remediation plan for failed controls.',
            ].map((starter) => (
              <a href={`/copilot?question=${encodeURIComponent(starter)}`} key={starter}>
                {starter}
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
