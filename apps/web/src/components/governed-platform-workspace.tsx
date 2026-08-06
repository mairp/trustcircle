'use client';

import { useMemo, useState } from 'react';

import {
  parseGovernedReviewComparison,
  type GovernedReviewComparisonView,
} from '../lib/governed-platform-client.ts';
import type {
  GovernedAiWorkspaceState,
  GovernedConnectorWorkspaceState,
  GovernedEvidenceWorkspaceState,
  GovernedFrameworkMatrixWorkspaceState,
  GovernedMonitoringWorkspaceState,
  GovernedRegisterWorkspaceState,
  GovernedReviewSnapshotView,
  GovernedReviewWorkspaceState,
} from '../lib/governed-platform.ts';

function shortDigest(value: string): string {
  return value.length > 20 ? value.slice(0, 12) + '...' + value.slice(-8) : value;
}

function governedLink(ref: string): string | undefined {
  return ref.startsWith('/') && !ref.startsWith('//') ? ref : undefined;
}

function DeltaList({
  title,
  values,
  tone,
}: {
  readonly title: string;
  readonly values: readonly string[];
  readonly tone: string;
}) {
  return (
    <section className={'review-delta review-delta--' + tone} aria-label={title}>
      <strong>{title}</strong>
      <span>{values.length}</span>
      {values.length > 0 ? (
        <ul>
          {values.map((ref) => (
            <li key={ref}>{governedLink(ref) ? <a href={ref}>{ref}</a> : <span>{ref}</span>}</li>
          ))}
        </ul>
      ) : (
        <small>No attributable records in this class.</small>
      )}
    </section>
  );
}

function SnapshotCard({
  snapshot,
  label,
}: {
  readonly snapshot: GovernedReviewSnapshotView;
  readonly label: string;
}) {
  return (
    <article className="review-snapshot-card">
      <p>{label}</p>
      <h3>Review version {snapshot.reviewVersion}</h3>
      <dl>
        <div>
          <dt>Period</dt>
          <dd>
            <time dateTime={snapshot.periodStart}>
              {new Date(snapshot.periodStart).toLocaleDateString()}
            </time>
            {'  /  '}
            <time dateTime={snapshot.periodEnd}>
              {new Date(snapshot.periodEnd).toLocaleDateString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>Signed</dt>
          <dd>
            <time dateTime={snapshot.signedAt}>{new Date(snapshot.signedAt).toLocaleString()}</time>
            {' by '}
            {snapshot.signerRole}
          </dd>
        </div>
        <div>
          <dt>Signature</dt>
          <dd>
            {snapshot.signatureAlgorithm} / {snapshot.signatureKeyId}
          </dd>
        </div>
        <div>
          <dt>Immutable digest</dt>
          <dd title={snapshot.canonicalDigest}>{shortDigest(snapshot.canonicalDigest)}</dd>
        </div>
      </dl>
      <p>
        {snapshot.outcomeCount} outcomes / {snapshot.evidenceRefs.length} evidence links /{' '}
        {snapshot.decisionRefs.length} decision links
      </p>
    </article>
  );
}

export function GovernedPlatformWorkspace({
  state,
}: {
  readonly state: GovernedReviewWorkspaceState;
}) {
  const [baselineId, setBaselineId] = useState(
    state.snapshots[1]?.id ?? state.snapshots[0]?.id ?? '',
  );
  const [targetId, setTargetId] = useState(state.snapshots[0]?.id ?? '');
  const [comparison, setComparison] = useState<GovernedReviewComparisonView>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const byId = useMemo(
    () => new Map(state.snapshots.map((snapshot) => [snapshot.id, snapshot])),
    [state.snapshots],
  );
  const baseline = byId.get(baselineId);
  const target = byId.get(targetId);

  async function compare(): Promise<void> {
    setMessage('');
    setComparison(undefined);
    if (!baseline || !target || baseline.id === target.id) {
      setMessage('Choose two distinct signed periods.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/governed-platform/review-comparisons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseline_snapshot_id: baseline.id,
          target_snapshot_id: target.id,
        }),
      });
      const body: unknown = await response.json();
      const parsed = response.ok ? parseGovernedReviewComparison(body) : undefined;
      if (!parsed) {
        setMessage(
          response.status === 422
            ? 'These signed periods are incompatible. Align scope and registry versions before comparing.'
            : 'The comparison is unavailable. Reconcile the review projection and try again.',
        );
        return;
      }
      setComparison(parsed);
      setMessage(
        parsed.compatibility === 'compatible'
          ? 'Comparison generated from immutable signed periods.'
          : 'Comparison retained, but the periods are incompatible.',
      );
    } catch {
      setMessage('The comparison service is unavailable. No review history was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="review-comparison"
      className="governed-review-workspace"
      aria-labelledby="review-comparison-title"
    >
      <div className="record-region-heading">
        <div>
          <p className="domain-kicker">Immutable review history</p>
          <h2 id="review-comparison-title">Compare signed review periods</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </div>

      {state.quality !== 'current' || state.snapshots.length === 0 ? (
        <div className="status-explanation status-explanation--unknown">
          <div>
            <h3>Signed history is not currently comparable</h3>
            <p>
              Missing or incomplete projection metadata is never presented as an empty or healthy
              review history.
            </p>
          </div>
          <p>
            <strong>Safe next action</strong>
            <span>{state.safeNextAction}</span>
          </p>
        </div>
      ) : (
        <>
          <form
            className="review-period-selector"
            onSubmit={(event) => {
              event.preventDefault();
              void compare();
            }}
          >
            <label>
              Baseline signed period
              <select value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
                {state.snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    Review {snapshot.reviewVersion} /{' '}
                    {new Date(snapshot.periodEnd).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Target signed period
              <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                {state.snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    Review {snapshot.reviewVersion} /{' '}
                    {new Date(snapshot.periodEnd).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy || state.snapshots.length < 2}>
              {busy ? 'Comparing...' : 'Compare signed periods'}
            </button>
          </form>

          <div className="review-snapshot-grid">
            {baseline ? <SnapshotCard snapshot={baseline} label="Baseline" /> : null}
            {target ? <SnapshotCard snapshot={target} label="Target" /> : null}
          </div>

          <p role="status" aria-live="polite">
            {message || state.safeNextAction}
          </p>

          {comparison ? (
            <section className="review-comparison-result" aria-labelledby="review-result-title">
              <div>
                <h3 id="review-result-title">
                  {comparison.compatibility === 'compatible'
                    ? 'Attributable change summary'
                    : 'Incompatible signed periods'}
                </h3>
                <p title={comparison.sourceDigest}>
                  Source digest {shortDigest(comparison.sourceDigest)}
                </p>
              </div>
              {comparison.compatibility === 'incompatible' ? (
                <div className="status-explanation status-explanation--unknown">
                  <div>
                    <h3>Comparison cannot classify change safely</h3>
                    <p>
                      {comparison.incompatibilityReasons.join(', ') ||
                        'Compatibility metadata is incomplete.'}
                    </p>
                  </div>
                  <p>
                    <strong>Safe next action</strong>
                    <span>
                      Align scope, schema, and registry versions; never infer improvement from
                      incompatible periods.
                    </span>
                  </p>
                </div>
              ) : (
                <div className="review-delta-grid">
                  <DeltaList title="Improved" values={comparison.improvedRefs} tone="positive" />
                  <DeltaList title="Regressed" values={comparison.regressedRefs} tone="negative" />
                  <DeltaList title="Added" values={comparison.addedRefs} tone="neutral" />
                  <DeltaList title="Removed" values={comparison.removedRefs} tone="neutral" />
                  <DeltaList title="Unchanged" values={comparison.unchangedRefs} tone="neutral" />
                  <DeltaList title="Unknown" values={comparison.unknownRefs} tone="unknown" />
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

export function GovernedRegisterWorkspace({
  state,
}: {
  readonly state: GovernedRegisterWorkspaceState;
}) {
  const [viewId, setViewId] = useState(state.views[0]?.id ?? '');
  const [channel, setChannel] = useState('in_app');
  const [cadence, setCadence] = useState(60);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function subscribe(): Promise<void> {
    if (!viewId || !state.principalId) {
      setMessage('Choose an authorized governed view before subscribing.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/governed-platform/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          reason: {
            code: 'subscription.create',
            text: 'Subscribe the current principal to this governed view.',
          },
          input: {
            id: crypto.randomUUID(),
            view_id: viewId,
            recipient_principal_id: state.principalId,
            channels: [channel],
            cadence_minutes: cadence,
            escalation_after_minutes: Math.max(cadence * 3, cadence),
          },
        }),
      });
      setMessage(
        response.ok
          ? 'Subscription created. Recipient and field authority will be checked again at delivery.'
          : 'Subscription was not created. Verify current view authority and retry safely.',
      );
    } catch {
      setMessage('The subscription service is unavailable. No subscription was created.');
    } finally {
      setBusy(false);
    }
  }

  const failures = state.deliveries.filter(
    (delivery) =>
      delivery.status === 'partial' ||
      delivery.status === 'terminal' ||
      delivery.status === 'retry_scheduled',
  );

  return (
    <section
      id="governed-register-workspace"
      className="governed-register-workspace"
      aria-labelledby="governed-register-title"
    >
      <div className="record-region-heading">
        <div>
          <p className="domain-kicker">Canonical lifecycle and collaboration</p>
          <h2 id="governed-register-title">Governed register records</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </div>

      {state.records.length > 0 ? (
        <ol className="governed-register-list">
          {state.records.map((record) => (
            <li id={'register-' + record.id} key={record.id}>
              <div>
                <span className="domain-kicker">{record.kind}</span>
                <h3>{record.title}</h3>
                <p>{record.description}</p>
              </div>
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>{record.status.replaceAll('_', ' ')}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{record.ownerPrincipalId}</dd>
                </div>
                <div>
                  <dt>Version/history</dt>
                  <dd>
                    {record.version} / {record.historyCount} entries
                  </dd>
                </div>
                {record.reviewAt ? (
                  <div>
                    <dt>Review</dt>
                    <dd>
                      <time dateTime={record.reviewAt}>
                        {new Date(record.reviewAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                ) : null}
                {record.expiresAt ? (
                  <div>
                    <dt>Expiry</dt>
                    <dd>
                      <time dateTime={record.expiresAt}>
                        {new Date(record.expiresAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <div className="status-explanation status-explanation--unknown">
          <div>
            <h3>No authoritative register rows are available</h3>
            <p>
              An unavailable or partial projection is not presented as a verified empty register.
            </p>
          </div>
          <p>
            <strong>Safe next action</strong>
            <span>{state.safeNextAction}</span>
          </p>
        </div>
      )}

      <section
        id="subscription-controls"
        className="governed-subscription-panel"
        aria-labelledby="subscription-title"
      >
        <div>
          <h3 id="subscription-title">Saved and shared governed views</h3>
          <p>
            Sharing a view never broadens record or field authority; authorization is evaluated
            again for every delivery.
          </p>
        </div>
        {state.views.length > 0 ? (
          <>
            <ul className="governed-view-list">
              {state.views.map((view) => (
                <li key={view.id}>
                  <strong>{view.name}</strong>
                  <span>{view.fields.join(', ')}</span>
                  <small>
                    Shared with {view.sharedWithPrincipalIds.length} principal
                    {view.sharedWithPrincipalIds.length === 1 ? '' : 's'} / digest{' '}
                    {shortDigest(view.queryDigest)}
                  </small>
                </li>
              ))}
            </ul>
            <form
              className="governed-subscription-form"
              onSubmit={(event) => {
                event.preventDefault();
                void subscribe();
              }}
            >
              <label>
                Governed view
                <select value={viewId} onChange={(event) => setViewId(event.target.value)}>
                  {state.views.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Channel
                <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                  <option value="in_app">In-app</option>
                  <option value="email">Email</option>
                  <option value="chat">Chat</option>
                  <option value="webhook">Webhook</option>
                </select>
              </label>
              <label>
                Cadence in minutes
                <input
                  type="number"
                  min="1"
                  max="10080"
                  value={cadence}
                  onChange={(event) => setCadence(Number(event.target.value))}
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Creating...' : 'Create subscription'}
              </button>
            </form>
          </>
        ) : (
          <p>No currently authorized saved/shared view is available for subscription.</p>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>

      <section className="governed-delivery-panel" aria-labelledby="delivery-title">
        <h3 id="delivery-title">Delivery reconciliation</h3>
        {failures.length > 0 ? (
          <ol>
            {failures.map((delivery) => (
              <li key={delivery.id}>
                <strong>
                  {delivery.channel} / {delivery.status.replaceAll('_', ' ')}
                </strong>
                <span>Attempt {delivery.attempt}</span>
                {delivery.nextAttemptAt ? (
                  <span>
                    Retry{' '}
                    <time dateTime={delivery.nextAttemptAt}>
                      {new Date(delivery.nextAttemptAt).toLocaleString()}
                    </time>
                  </span>
                ) : null}
                {delivery.terminalReason ? <span>{delivery.terminalReason}</span> : null}
                <small>Correlation {delivery.correlationId}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p>No delayed, partial, retrying, or terminal delivery is currently visible.</p>
        )}
        <p>
          <strong>Safe next action</strong> {state.safeNextAction}
        </p>
      </section>
    </section>
  );
}

export function GovernedEvidenceWorkspace({
  state,
}: {
  readonly state: GovernedEvidenceWorkspaceState;
}) {
  const [requestId, setRequestId] = useState(state.requests[0]?.id ?? '');
  const [packageId, setPackageId] = useState('');
  const [message, setMessage] = useState('');
  const [verification, setVerification] = useState<
    { readonly valid: boolean; readonly reason: string | null; readonly digest: string } | undefined
  >();
  const [busy, setBusy] = useState(false);
  const selected = state.requests.find((request) => request.id === requestId);

  async function requestPackage(): Promise<void> {
    if (!selected || !state.principalId) {
      setMessage('Choose an evidence request before creating a package.');
      return;
    }
    const id = crypto.randomUUID();
    setPackageId(id);
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/governed-platform/evidence-packages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          reason: {
            code: 'evidence.package',
            text: 'Create a signed package for the selected exact evidence request.',
          },
          input: {
            package_id: id,
            evidence_request_id: selected.id,
            audience_principal_ids: [state.principalId],
            scope: selected.scope,
          },
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      setMessage(
        response.ok
          ? 'Package generation accepted as operation ' + String(body['operation_id']) + '.'
          : 'Package generation was not accepted. No evidence source was changed.',
      );
    } catch {
      setMessage('Package generation is unavailable. No evidence source was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyPackage(): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(packageId)) {
      setMessage('Enter a valid package identifier to verify.');
      return;
    }
    setBusy(true);
    setMessage('');
    setVerification(undefined);
    try {
      const response = await fetch(
        '/api/governed-platform/evidence-packages/' + encodeURIComponent(packageId) + '/verify',
        { method: 'POST' },
      );
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof body['valid'] !== 'boolean') {
        setMessage('Package verification is unavailable. Do not release the package.');
        return;
      }
      setVerification({
        valid: body['valid'],
        reason: typeof body['reason'] === 'string' ? body['reason'] : null,
        digest: typeof body['canonical_digest'] === 'string' ? body['canonical_digest'] : '',
      });
      setMessage(
        body['valid']
          ? 'Package signature, manifest, entries, audience, and tenant boundary verified.'
          : 'Package verification failed. Retain failure evidence and do not release it.',
      );
    } catch {
      setMessage('Package verification is unavailable. Do not release the package.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="evidence-assurance-workspace"
      className="governed-register-workspace"
      aria-labelledby="evidence-assurance-title"
    >
      <div className="record-region-heading">
        <div>
          <p className="domain-kicker">Request, attest, decide, package</p>
          <h2 id="evidence-assurance-title">Evidence assurance inbox</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </div>

      <div className="evidence-lineage-legend" aria-label="Evidence lineage distinction">
        <article>
          <strong>Original</strong>
          <span>Immutable source content with custody, classification, and retention.</span>
        </article>
        <article>
          <strong>Verified derivative</strong>
          <span>Separate redacted content linked to the original digest and ruleset.</span>
        </article>
      </div>

      {state.requests.length > 0 ? (
        <ol className="governed-register-list">
          {state.requests.map((request) => (
            <li key={request.id}>
              <div>
                <span className="domain-kicker">{request.status}</span>
                <h3>Evidence request {request.id}</h3>
                <p>{request.requestedEvidenceTypes.join(', ')}</p>
              </div>
              <dl>
                <div>
                  <dt>Owner</dt>
                  <dd>{request.ownerPrincipalId}</dd>
                </div>
                <div>
                  <dt>Exact request version</dt>
                  <dd>{request.version}</dd>
                </div>
                <div>
                  <dt>Due</dt>
                  <dd>
                    <time dateTime={request.dueAt}>{new Date(request.dueAt).toLocaleString()}</time>
                  </dd>
                </div>
                <div>
                  <dt>Expiry</dt>
                  <dd>
                    <time dateTime={request.expiresAt}>
                      {new Date(request.expiresAt).toLocaleString()}
                    </time>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <p>
          <strong>Safe next action</strong> {state.safeNextAction}
        </p>
      )}

      <section className="governed-subscription-panel" aria-labelledby="attestation-boundary-title">
        <h3 id="attestation-boundary-title">Attestation and sufficiency boundary</h3>
        <p>
          Owners attest only exact evidence versions. Independent reviewers decide sufficiency in a
          separate immutable record; an attestation cannot certify broader scope or later content.
        </p>
      </section>

      <section className="governed-subscription-panel" aria-labelledby="package-controls-title">
        <h3 id="package-controls-title">Signed package and independent verification</h3>
        <form
          className="governed-subscription-form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestPackage();
          }}
        >
          <label>
            Evidence request
            <select value={requestId} onChange={(event) => setRequestId(event.target.value)}>
              {state.requests.map((request) => (
                <option key={request.id} value={request.id}>
                  {request.id} / {request.status}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy || state.requests.length === 0}>
            {busy ? 'Working...' : 'Request signed package'}
          </button>
        </form>
        <form
          className="governed-subscription-form"
          onSubmit={(event) => {
            event.preventDefault();
            void verifyPackage();
          }}
        >
          <label>
            Package identifier
            <input
              value={packageId}
              onChange={(event) => setPackageId(event.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
            />
          </label>
          <button type="submit" disabled={busy}>
            Verify package independently
          </button>
        </form>
        <p role="status" aria-live="polite">
          {message || state.safeNextAction}
        </p>
        {verification ? (
          <div
            className={
              'status-explanation status-explanation--' +
              (verification.valid ? 'healthy' : 'unknown')
            }
          >
            <div>
              <h3>
                {verification.valid ? 'Package integrity verified' : 'Package verification failed'}
              </h3>
              <p>
                {verification.valid
                  ? 'The manifest is attributable to the exact signed entries and authorized audience.'
                  : (verification.reason ?? 'Verification evidence is incomplete.')}
              </p>
            </div>
            <p title={verification.digest}>
              <strong>Manifest digest</strong>
              <span>{shortDigest(verification.digest)}</span>
            </p>
          </div>
        ) : null}
      </section>
    </section>
  );
}

export function GovernedMonitoringWorkspace({
  state,
}: {
  readonly state: GovernedMonitoringWorkspaceState;
}) {
  const [proposalType, setProposalType] = useState('control');
  const [proposalRef, setProposalRef] = useState('/controls/');
  const [proposalDigest, setProposalDigest] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [targetVersion, setTargetVersion] = useState('1');
  const [rollbackPlanRef, setRollbackPlanRef] = useState('/rollback/plans/');
  const [message, setMessage] = useState('');
  const [rebuildStatus, setRebuildStatus] = useState('not requested');
  const [rollbackStatus, setRollbackStatus] = useState('not available');
  const [busy, setBusy] = useState(false);

  async function requestPreview(): Promise<void> {
    if (!/^\/[A-Za-z0-9._/-]{2,511}$/.test(proposalRef) || proposalRef.startsWith('//')) {
      setMessage('Enter a governed relative proposal reference.');
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(proposalDigest)) {
      setMessage('Enter the exact 64-character proposal SHA-256 digest.');
      return;
    }
    const id = crypto.randomUUID();
    setPreviewId(id);
    if (rollbackPlanRef === '/rollback/plans/') setRollbackPlanRef('/rollback/plans/' + id);
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/governed-platform/impact-previews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          reason: {
            code: 'change.preview',
            text: 'Generate a non-mutating impact preview from exact current source versions.',
          },
          input: {
            preview_id: id,
            proposal_type: proposalType,
            proposal_ref: proposalRef,
            proposal_digest: proposalDigest,
            expires_at: Date.now() + 60 * 60 * 1000,
          },
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      setMessage(
        response.ok
          ? 'Preview accepted as operation ' +
              String(body['operation_id']) +
              '. It has no mutation authority.'
          : 'Preview was not accepted. Authoritative state was not changed.',
      );
    } catch {
      setMessage('Preview generation is unavailable. Authoritative state was not changed.');
    } finally {
      setBusy(false);
    }
  }

  async function publishChange(): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(previewId)) {
      setMessage('Enter a valid preview identifier produced from exact current versions.');
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(proposalDigest)) {
      setMessage('Enter the exact proposal digest bound to the preview.');
      return;
    }
    if (!/^\/[A-Za-z0-9._/-]{2,511}$/.test(rollbackPlanRef) || rollbackPlanRef.startsWith('//')) {
      setMessage('Enter a governed rollback plan reference before publication.');
      return;
    }
    const version = Number(targetVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      setMessage('Enter a positive target version.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/governed-platform/change-publications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transition: 'publish',
          reason: {
            code: 'change.publish',
            text: 'Publish the exact independently approved preview and retain rollback authority.',
          },
          authority_decision_id: crypto.randomUUID(),
          input: {
            preview_id: previewId,
            publication_id: crypto.randomUUID(),
            proposal_digest: proposalDigest,
            target_version: version,
            rollback_plan_ref: rollbackPlanRef,
          },
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? 'Publication is blocked because the preview expired or a bound source changed. Regenerate it.'
            : response.status === 403
              ? 'Publication requires an authorized principal distinct from the proposer.'
              : 'Publication was not accepted. No authoritative change was inferred.',
        );
        return;
      }
      setRebuildStatus('pending - operation ' + String(body['operation_id']));
      setRollbackStatus('available through ' + rollbackPlanRef);
      setMessage(
        'Publication accepted. Rebuild progress and any failure remain visible until reconciled.',
      );
    } catch {
      setMessage('Publication is unavailable. No authoritative change was inferred.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="governed-monitoring-workspace"
      className="governed-register-workspace"
      aria-labelledby="governed-monitoring-title"
    >
      <div className="record-region-heading">
        <div>
          <p className="domain-kicker">Observe, correlate, preview, publish</p>
          <h2 id="governed-monitoring-title">Continuous monitoring and safe change</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </div>

      {state.cases.length > 0 ? (
        <ol className="governed-register-list">
          {state.cases.map((item) => (
            <li key={item.id}>
              <div>
                <span className="domain-kicker">{item.severity} severity</span>
                <h3>{item.status} monitoring case</h3>
                <p>
                  Assurance outcome: <strong>{item.assuranceOutcome}</strong>. Freshness{' '}
                  {item.freshness}; completeness {item.completeness}.
                </p>
                {item.uncertaintyReasons.length > 0 ? (
                  <ul className="monitoring-uncertainty-list" aria-label="Uncertainty reasons">
                    {item.uncertaintyReasons.map((reason) => (
                      <li key={reason}>{reason.replaceAll('_', ' ')}</li>
                    ))}
                  </ul>
                ) : (
                  <p>No declared uncertainty reason.</p>
                )}
              </div>
              <dl>
                <div>
                  <dt>Owner</dt>
                  <dd>{item.ownerPrincipalId}</dd>
                </div>
                <div>
                  <dt>Control</dt>
                  <dd>{item.controlId}</dd>
                </div>
                <div>
                  <dt>Observation evidence</dt>
                  <dd>{item.observationRefs.length} retained reference(s)</dd>
                </div>
                <div>
                  <dt>Source health</dt>
                  <dd>
                    {Object.entries(item.sourceHealth)
                      .map(([source, health]) => source + ': ' + health)
                      .join(', ') || 'unknown'}
                  </dd>
                </div>
                <div>
                  <dt>Last evaluation</dt>
                  <dd>
                    <time dateTime={item.lastEvaluationAt}>
                      {new Date(item.lastEvaluationAt).toLocaleString()}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Retry / terminal</dt>
                  <dd>
                    {item.retryAttempts} attempt(s);{' '}
                    {item.retryTerminal ? 'terminal' : 'reconcilable'}
                  </dd>
                </div>
              </dl>
              {item.terminalFailureRef ? (
                <p className="monitoring-terminal-evidence">
                  Terminal evidence: <span>{item.terminalFailureRef}</span>
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p>
          <strong>Safe next action</strong> {state.safeNextAction}
        </p>
      )}

      <section className="governed-subscription-panel" aria-labelledby="impact-preview-title">
        <h3 id="impact-preview-title">Non-mutating impact preview</h3>
        <p>
          Traversal is pinned to exact source versions. Missing dependencies, expiry, or drift block
          publication instead of weakening the gate.
        </p>
        <form
          className="governed-subscription-form monitoring-change-form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestPreview();
          }}
        >
          <label>
            Proposal type
            <select value={proposalType} onChange={(event) => setProposalType(event.target.value)}>
              {['obligation', 'control', 'policy', 'mapping', 'ownership', 'threshold'].map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Governed proposal reference
            <input value={proposalRef} onChange={(event) => setProposalRef(event.target.value)} />
          </label>
          <label>
            Exact proposal SHA-256
            <input
              value={proposalDigest}
              onChange={(event) => setProposalDigest(event.target.value.toLowerCase())}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Working...' : 'Generate preview'}
          </button>
        </form>
      </section>

      <section className="governed-subscription-panel" aria-labelledby="change-publication-title">
        <h3 id="change-publication-title">Independent publication, rebuild, and rollback</h3>
        <p>
          A separately authorized approver can enter the exact preview identity. Publication emits
          invalidation/rebuild work and retains a new-version rollback path.
        </p>
        <form
          className="governed-subscription-form monitoring-change-form"
          onSubmit={(event) => {
            event.preventDefault();
            void publishChange();
          }}
        >
          <label>
            Preview identifier
            <input value={previewId} onChange={(event) => setPreviewId(event.target.value)} />
          </label>
          <label>
            Target version
            <input
              inputMode="numeric"
              value={targetVersion}
              onChange={(event) => setTargetVersion(event.target.value)}
            />
          </label>
          <label>
            Rollback plan reference
            <input
              value={rollbackPlanRef}
              onChange={(event) => setRollbackPlanRef(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Publish approved preview
          </button>
        </form>
        <dl className="monitoring-change-status">
          <div>
            <dt>Rebuild</dt>
            <dd>{rebuildStatus}</dd>
          </div>
          <div>
            <dt>Rollback</dt>
            <dd>{rollbackStatus}</dd>
          </div>
        </dl>
        <p role="status" aria-live="polite">
          {message || state.safeNextAction}
        </p>
      </section>
    </section>
  );
}

export function GovernedAiWorkspace({ state }: { readonly state: GovernedAiWorkspaceState }) {
  return (
    <section
      id="governed-ai-workspace"
      className="governed-register-workspace"
      aria-labelledby="governed-ai-title"
    >
      <div className="record-region-heading">
        <div>
          <p className="domain-kicker">Purpose, evaluate, approve, monitor, retire</p>
          <h2 id="governed-ai-title">AI lifecycle governance</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </div>

      <section className="governed-subscription-panel ai-authority-boundary">
        <h3>Human authority boundary</h3>
        <p>
          This workspace presents lifecycle evidence only. It does not expose an approval action,
          and generated assistance cannot become an approval, attestation, certification, or
          authoritative compliance conclusion.
        </p>
      </section>

      {state.useCases.length > 0 ? (
        <ol className="ai-governance-list">
          {state.useCases.map((item) => {
            const constrained = ['constrained', 'suspended'].includes(item.lifecycleState);
            const expiredApproval = item.approvals.some(
              (approval) => Date.parse(approval.validUntil) <= Date.now(),
            );
            return (
              <li key={item.id}>
                <header>
                  <div>
                    <span className="domain-kicker">{item.riskClass} risk</span>
                    <h3>{item.name}</h3>
                    <p>{item.purpose}</p>
                  </div>
                  <span
                    className={
                      'status-group status-group--' +
                      (constrained || expiredApproval ? 'unknown' : 'healthy')
                    }
                  >
                    {item.lifecycleState}
                  </span>
                </header>
                <dl className="monitoring-change-status">
                  <div>
                    <dt>Owner</dt>
                    <dd>{item.ownerPrincipalId}</dd>
                  </div>
                  <div>
                    <dt>Resource version</dt>
                    <dd>{item.resourceVersion}</dd>
                  </div>
                  <div>
                    <dt>Exact active set</dt>
                    <dd>{item.activeComponentVersionRefs.join(', ') || 'not active'}</dd>
                  </div>
                  <div>
                    <dt>Retirement triggers</dt>
                    <dd>{item.retirementConditions.join(', ') || 'not declared'}</dd>
                  </div>
                </dl>

                <section aria-labelledby={'components-' + item.id}>
                  <h4 id={'components-' + item.id}>Exact component versions</h4>
                  {item.components.length > 0 ? (
                    <ul className="ai-evidence-list">
                      {item.components.map((component) => (
                        <li key={component.versionRef}>
                          <strong>{component.versionRef}</strong>
                          <span>
                            {component.kind} · {component.status}
                          </span>
                          <span>
                            {component.providerRef} / {component.modelRef}
                          </span>
                          <span title={component.canonicalDigest}>
                            Digest {shortDigest(component.canonicalDigest)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No component version is registered; activation must remain blocked.</p>
                  )}
                </section>

                <section aria-labelledby={'evaluations-' + item.id}>
                  <h4 id={'evaluations-' + item.id}>Evaluations and limitations</h4>
                  {item.evaluations.length > 0 ? (
                    <ul className="ai-evidence-list">
                      {item.evaluations.map((evaluation) => (
                        <li key={evaluation.id}>
                          <strong>{evaluation.verdict}</strong>
                          <span>{evaluation.componentVersionRefs.join(', ')}</span>
                          <span>
                            {evaluation.limitations.join('; ') || 'No declared limitation.'}
                          </span>
                          <time dateTime={evaluation.evaluatedAt}>
                            {new Date(evaluation.evaluatedAt).toLocaleString()}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No independent evaluation is recorded.</p>
                  )}
                </section>

                <section aria-labelledby={'approvals-' + item.id}>
                  <h4 id={'approvals-' + item.id}>Approval bounds</h4>
                  {item.approvals.length > 0 ? (
                    <ul className="ai-evidence-list">
                      {item.approvals.map((approval) => (
                        <li key={approval.id}>
                          <strong>
                            {Date.parse(approval.validUntil) <= Date.now() ? 'expired' : 'current'}
                          </strong>
                          <span>{approval.componentVersionRefs.join(', ')}</span>
                          <span>Approved by {approval.approvedByPrincipalId}</span>
                          <time dateTime={approval.validUntil}>
                            Valid until {new Date(approval.validUntil).toLocaleString()}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No exact-component approval is recorded.</p>
                  )}
                </section>

                <section aria-labelledby={'incidents-' + item.id}>
                  <h4 id={'incidents-' + item.id}>Incidents and constraints</h4>
                  {item.incidents.length > 0 ? (
                    <ul className="ai-evidence-list">
                      {item.incidents.map((incident) => (
                        <li key={incident.id}>
                          <strong>
                            {incident.severity} · {incident.status}
                          </strong>
                          <span>{incident.evidenceRefs.join(', ') || 'Evidence unavailable'}</span>
                          <time dateTime={incident.detectedAt}>
                            {new Date(incident.detectedAt).toLocaleString()}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No incident is visible in the current projection.</p>
                  )}
                </section>
              </li>
            );
          })}
        </ol>
      ) : (
        <p>
          <strong>Safe next action</strong> {state.safeNextAction}
        </p>
      )}
    </section>
  );
}

function governedCommand(
  reasonCode: string,
  reasonText: string,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: 1,
    reason: { code: reasonCode, text: reasonText },
    input,
  };
}

export function GovernedConnectorWorkspace({
  state,
}: {
  readonly state: GovernedConnectorWorkspaceState;
}) {
  const [adapterId, setAdapterId] = useState('');
  const [exactVersion, setExactVersion] = useState('');
  const [manifestDigest, setManifestDigest] = useState('');
  const [mappingRef, setMappingRef] = useState('');
  const [credentialClass, setCredentialClass] = useState('');
  const [definitionId, setDefinitionId] = useState('');
  const [environmentDigest, setEnvironmentDigest] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function authorDefinition(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const id = crypto.randomUUID();
      const response = await fetch('/api/governed-platform/connector-definitions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          governedCommand(
            'connector.definition.author',
            'Author a complete connector definition for independent conformance review.',
            {
              id,
              adapter_id: adapterId,
              exact_version: exactVersion,
              manifest_digest: manifestDigest,
              mapping_refs: [mappingRef],
              credential_class_refs: [credentialClass],
              pagination_policy: {
                mode: 'cursor',
                cursor_field: 'next_cursor',
                maximum_page_size: 100,
              },
              failure_policy: {
                correlation: 'required',
                idempotency: 'required',
                reconciliation: 'source_scoped',
                retry: 'bounded',
                replay: 'source_event_identity',
                terminal_failure: 'retained_for_reconciliation',
                revocation: 'block_new_work_reconcile_existing',
                migration: 'version_overlap',
                rollback: 'verified_preimage',
              },
              schema_version: 1,
            },
          ),
        ),
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result['title'] ?? result['code'] ?? 'rejected'));
      setDefinitionId(String(result['id'] ?? id));
      setMessage('Draft definition retained. Run conformance against this exact version.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connector definition was rejected.');
    } finally {
      setBusy(false);
    }
  }

  async function runConformance(): Promise<void> {
    if (!definitionId) {
      setMessage('Create or enter a definition identifier before requesting conformance.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        '/api/governed-platform/connector-definitions/' +
          encodeURIComponent(definitionId) +
          '/conformance-runs',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            governedCommand(
              'connector.conformance.request',
              'Run every required connector conformance dimension.',
              { environment_digest: environmentDigest },
            ),
          ),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result['title'] ?? result['code'] ?? 'rejected'));
      setMessage(
        'Conformance accepted as ' +
          String(result['operation_id'] ?? 'a governed asynchronous operation') +
          '.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Conformance request was rejected.');
    } finally {
      setBusy(false);
    }
  }

  async function reconcile(connectorId: string): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/governed-platform/connector-reconciliations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          governedCommand(
            'connector.reconcile',
            'Reconcile retained uncertain or partial connector outcomes.',
            { connector_id: connectorId },
          ),
        ),
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result['title'] ?? result['code'] ?? 'rejected'));
      setMessage(
        'Reconciliation accepted as ' +
          String(result['operation_id'] ?? 'a governed asynchronous operation') +
          '.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Reconciliation was rejected.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="governed-connector-workspace"
      className="governed-register-workspace"
      aria-labelledby="governed-connector-title"
    >
      <div className="record-region-heading">
        <div>
          <p className="domain-kicker">Author, test, certify, monitor, reconcile</p>
          <h2 id="governed-connector-title">Governed connector lifecycle</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </div>

      <section className="governed-subscription-panel connector-authority-boundary">
        <h3>Certification authority boundary</h3>
        <p>
          Authors can prepare definitions and request conformance. A separate authorized certifier
          binds an exact manifest, report, tenant, scope, capability, credential class, and validity
          interval. This workspace never treats connector conformance as vendor security or legal
          certification.
        </p>
      </section>

      <section className="governed-subscription-panel">
        <h3>Guided definition and conformance</h3>
        <form
          className="governed-subscription-form connector-authoring-form"
          onSubmit={(event) => {
            event.preventDefault();
            void authorDefinition();
          }}
        >
          <label>
            Adapter identifier
            <input
              required
              value={adapterId}
              onChange={(event) => setAdapterId(event.target.value)}
            />
          </label>
          <label>
            Exact semantic version
            <input
              required
              value={exactVersion}
              onChange={(event) => setExactVersion(event.target.value)}
            />
          </label>
          <label>
            Manifest SHA-256
            <input
              required
              pattern="[a-f0-9]{64}"
              value={manifestDigest}
              onChange={(event) => setManifestDigest(event.target.value)}
            />
          </label>
          <label>
            Mapping reference
            <input
              required
              value={mappingRef}
              onChange={(event) => setMappingRef(event.target.value)}
            />
          </label>
          <label>
            Credential class
            <input
              required
              value={credentialClass}
              onChange={(event) => setCredentialClass(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Retain draft definition
          </button>
        </form>
        <form
          className="governed-subscription-form connector-conformance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runConformance();
          }}
        >
          <label>
            Definition identifier
            <input
              required
              value={definitionId}
              onChange={(event) => setDefinitionId(event.target.value)}
            />
          </label>
          <label>
            Environment SHA-256
            <input
              required
              pattern="[a-f0-9]{64}"
              value={environmentDigest}
              onChange={(event) => setEnvironmentDigest(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            Run all conformance dimensions
          </button>
        </form>
        <p role="status" aria-live="polite">
          {message || state.safeNextAction}
        </p>
      </section>

      <section className="governed-subscription-panel">
        <h3>Exact certification evidence</h3>
        {state.certifications.length > 0 ? (
          <ol className="connector-governance-list">
            {state.certifications.map((item) => (
              <li key={item.id}>
                <header>
                  <div>
                    <strong>{item.connectorId}</strong>
                    <span>Version {item.exactVersion}</span>
                  </div>
                  <span
                    className={
                      'status-group status-group--' +
                      (item.status === 'active' && Date.parse(item.expiresAt) > Date.now()
                        ? 'healthy'
                        : 'unknown')
                    }
                  >
                    {item.status}
                  </span>
                </header>
                <dl className="monitoring-change-status">
                  <div>
                    <dt>Manifest digest</dt>
                    <dd title={item.manifestDigest}>{shortDigest(item.manifestDigest)}</dd>
                  </div>
                  <div>
                    <dt>Conformance report</dt>
                    <dd title={item.reportDigest}>
                      {shortDigest(item.reportDigest)} ? suite {item.suiteVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>Independent certifier</dt>
                    <dd>{item.certifierPrincipalId}</dd>
                  </div>
                  <div>
                    <dt>Validity</dt>
                    <dd>
                      <time dateTime={item.validFrom}>
                        {new Date(item.validFrom).toLocaleString()}
                      </time>{' '}
                      ?{' '}
                      <time dateTime={item.expiresAt}>
                        {new Date(item.expiresAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Scopes</dt>
                    <dd>{item.allowedScopes.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>Capabilities</dt>
                    <dd>{item.allowedCapabilities.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>Credential classes</dt>
                    <dd>{item.credentialClasses.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>Author / certifier</dt>
                    <dd>
                      {item.authorPrincipalId} / {item.certifierPrincipalId}
                    </dd>
                  </div>
                </dl>
                {item.revocationReason ? (
                  <p className="case-breach">Revoked: {item.revocationReason}</p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>
            No connector certification is visible. Draft or conformance state is not activation
            authority.
          </p>
        )}
      </section>

      <section className="governed-subscription-panel">
        <h3>Health, failure evidence, and reconciliation</h3>
        {state.health.length > 0 ? (
          <ol className="connector-governance-list">
            {state.health.map((item) => (
              <li key={item.id}>
                <header>
                  <div>
                    <strong>{item.connectorId}</strong>
                    <span>{item.status}</span>
                  </div>
                  <span>{item.retryState}</span>
                </header>
                <p>
                  Last attempt{' '}
                  <time dateTime={item.lastAttemptAt}>
                    {new Date(item.lastAttemptAt).toLocaleString()}
                  </time>
                  {item.lastSuccessAt ? (
                    <>
                      {' '}
                      ? last success{' '}
                      <time dateTime={item.lastSuccessAt}>
                        {new Date(item.lastSuccessAt).toLocaleString()}
                      </time>
                    </>
                  ) : (
                    ' ? no verified success'
                  )}
                </p>
                {item.terminalFailureRef ? (
                  <p>Terminal evidence: {item.terminalFailureRef}</p>
                ) : null}
                {item.reconciliationAvailable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void reconcile(item.connectorId)}
                  >
                    Reconcile retained outcomes
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>No connector health projection is available; do not infer healthy operation.</p>
        )}
      </section>
    </section>
  );
}
function frameworkClaimLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

export function GovernedFrameworkMatrixWorkspace({
  state,
}: {
  readonly state: GovernedFrameworkMatrixWorkspaceState;
}) {
  return (
    <section
      className="governed-workspace framework-matrix-workspace"
      aria-labelledby="framework-matrix-title"
    >
      <header className="governed-workspace__header">
        <div>
          <p className="workspace-eyebrow">Truthful framework claims</p>
          <h2 id="framework-matrix-title">Framework applicability and assurance matrix</h2>
        </div>
        <span
          className={
            'status-group status-group--' + (state.quality === 'current' ? 'healthy' : 'unknown')
          }
        >
          {state.quality}
        </span>
      </header>

      <p className="framework-matrix-boundary">
        This matrix does not produce one compliant status. Applicability, duty, mapping, control
        coverage, evidence sufficiency, readiness, assessment, and external certification remain
        separate. Readiness is never certification.
      </p>

      {state.rows.length > 0 ? (
        <div
          className="framework-matrix-table-wrap"
          tabIndex={0}
          aria-label="Scrollable framework matrix"
        >
          <table className="framework-matrix-table">
            <caption>
              Independently review each claim. Conditional, partial, disputed, superseded, and
              not-applicable mappings remain visible.
            </caption>
            <thead>
              <tr>
                <th scope="col">Source and target</th>
                <th scope="col">Mapping</th>
                <th scope="col">Applicability and duty</th>
                <th scope="col">Coverage and evidence</th>
                <th scope="col">Readiness and assessment</th>
                <th scope="col">External certification</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.sourceClauseRef}</strong>
                    <span>{frameworkClaimLabel(row.requirementType)}</span>
                    <span>{row.sourcePublicationId}</span>
                    <span>
                      {frameworkClaimLabel(row.targetType)}: {row.targetRef}
                    </span>
                  </td>
                  <td>
                    <strong>{frameworkClaimLabel(row.mappingType)}</strong>
                    <span>Status: {frameworkClaimLabel(row.mappingStatus)}</span>
                    <span>Extent: {frameworkClaimLabel(row.coverageExtent)}</span>
                    <span>Confidence: {frameworkClaimLabel(row.confidenceBand)}</span>
                    <span>Version {row.mappingVersion}</span>
                  </td>
                  <td>
                    <strong>Applicability: {frameworkClaimLabel(row.applicability)}</strong>
                    <span>Duty: {frameworkClaimLabel(row.duty)}</span>
                    {row.conditions.length > 0 ? (
                      <details>
                        <summary>{row.conditions.length} condition(s)</summary>
                        <ul>
                          {row.conditions.map((condition) => (
                            <li key={condition}>{condition}</li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <span>No mapping conditions recorded.</span>
                    )}
                  </td>
                  <td>
                    <strong>Control: {frameworkClaimLabel(row.controlCoverage)}</strong>
                    <span>Evidence: {frameworkClaimLabel(row.evidenceSufficiency)}</span>
                    <span>{row.evidenceRefs.length} governed evidence reference(s)</span>
                  </td>
                  <td>
                    <strong>Readiness: {frameworkClaimLabel(row.readiness)}</strong>
                    <span>Assessment: {frameworkClaimLabel(row.assessment)}</span>
                  </td>
                  <td>
                    <strong>{frameworkClaimLabel(row.certification)}</strong>
                    <span>No readiness inference is permitted.</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="framework-matrix-empty">
          No framework matrix projection is available. Absence is not evidence of applicability,
          readiness, assessment, certification, or compliance.
        </p>
      )}

      <dl className="framework-matrix-metadata">
        {state.generatedAt ? (
          <div>
            <dt>Generated</dt>
            <dd>
              <time dateTime={state.generatedAt}>
                {new Date(state.generatedAt).toLocaleString()}
              </time>
            </dd>
          </div>
        ) : null}
        {state.sourceCursor ? (
          <div>
            <dt>Source cursor</dt>
            <dd>{state.sourceCursor}</dd>
          </div>
        ) : null}
        {state.digest ? (
          <div>
            <dt>Projection digest</dt>
            <dd title={state.digest}>{shortDigest(state.digest)}</dd>
          </div>
        ) : null}
      </dl>
      <p role="status">{state.safeNextAction}</p>
    </section>
  );
}
