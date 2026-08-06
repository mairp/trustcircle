import { apiRead } from './api-client.ts';
import type { OperatorSessionContext } from './session-context.ts';

export type GovernedReviewQuality = 'current' | 'unknown' | 'unavailable';

export interface GovernedReviewSnapshotView {
  readonly id: string;
  readonly tenantId: string;
  readonly reviewId: string;
  readonly reviewVersion: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly canonicalDigest: string;
  readonly signerRole: string;
  readonly signedAt: string;
  readonly signatureAlgorithm: string;
  readonly signatureKeyId: string;
  readonly outcomeCount: number;
  readonly evidenceRefs: readonly string[];
  readonly decisionRefs: readonly string[];
}

export { parseGovernedReviewComparison } from './governed-platform-client.ts';
export type { GovernedReviewComparisonView } from './governed-platform-client.ts';

export interface GovernedReviewWorkspaceState {
  readonly quality: GovernedReviewQuality;
  readonly snapshots: readonly GovernedReviewSnapshotView[];
  readonly sourceCursor?: string;
  readonly generatedAt?: string;
  readonly safeNextAction: string;
  readonly diagnostic?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function snapshot(value: unknown, tenantId: string): GovernedReviewSnapshotView | undefined {
  const candidate = object(value);
  if (!candidate || candidate['tenant_id'] !== tenantId) return undefined;
  const id = text(candidate['id']);
  const reviewId = text(candidate['review_id']);
  const reviewVersion = integer(candidate['review_version']);
  const periodStart = text(candidate['period_start']);
  const periodEnd = text(candidate['period_end']);
  const digest = text(candidate['canonical_digest']);
  const signerRole = text(candidate['signer_role']);
  const signedAt = text(candidate['signed_at']);
  const algorithm = text(candidate['signature_algorithm']);
  const keyId = text(candidate['signature_key_id']);
  if (
    !id ||
    !reviewId ||
    reviewVersion === undefined ||
    reviewVersion < 1 ||
    !periodStart ||
    !periodEnd ||
    !digest ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !signerRole ||
    !signedAt ||
    !algorithm ||
    !keyId
  ) {
    return undefined;
  }
  return {
    id,
    tenantId,
    reviewId,
    reviewVersion,
    periodStart,
    periodEnd,
    canonicalDigest: digest,
    signerRole,
    signedAt,
    signatureAlgorithm: algorithm,
    signatureKeyId: keyId,
    outcomeCount: Array.isArray(candidate['outcomes']) ? candidate['outcomes'].length : 0,
    evidenceRefs: strings(candidate['evidence_refs']),
    decisionRefs: strings(candidate['decision_refs']),
  };
}

export async function loadGovernedReviewWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedReviewWorkspaceState> {
  if (!session.authenticated || !session.tenantId) {
    return {
      quality: 'unavailable',
      snapshots: [],
      safeNextAction: 'Authenticate in an authorized tenant before reading signed review history.',
    };
  }
  const result = await apiRead('/v1/review-snapshots', session);
  if (!result.ok) {
    return {
      quality: result.failure === 'malformed_response' ? 'unknown' : 'unavailable',
      snapshots: [],
      safeNextAction:
        result.safeNextAction ?? 'Restore the signed-review projection before comparing periods.',
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    };
  }
  const body = object(result.body);
  const metadata = object(body?.['metadata']);
  const rows = Array.isArray(body?.['items']) ? body['items'] : undefined;
  const sourceCursor = text(metadata?.['source_cursor']);
  const generatedAt = text(metadata?.['generated_at']);
  if (!body || !metadata || !rows || !sourceCursor || !generatedAt) {
    return {
      quality: 'unknown',
      snapshots: [],
      safeNextAction:
        'Reconcile the signed-review projection; incomplete metadata is not treated as empty history.',
    };
  }
  const snapshots = rows
    .map((row) => snapshot(row, session.tenantId!))
    .filter((row): row is GovernedReviewSnapshotView => row !== undefined)
    .sort(
      (a, b) =>
        Date.parse(b.signedAt) - Date.parse(a.signedAt) ||
        b.reviewVersion - a.reviewVersion ||
        a.id.localeCompare(b.id),
    );
  if (snapshots.length !== rows.length) {
    return {
      quality: 'unknown',
      snapshots,
      sourceCursor,
      generatedAt,
      safeNextAction:
        'Inspect rejected review rows and reconcile tenant, signature, and version metadata.',
    };
  }
  return {
    quality: 'current',
    snapshots,
    sourceCursor,
    generatedAt,
    safeNextAction:
      snapshots.length < 2
        ? 'Complete and sign another compatible review period before comparing changes.'
        : 'Select two signed periods to generate an attributable comparison.',
  };
}

export interface GovernedRegisterView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly ownerPrincipalId: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly reviewAt?: string;
  readonly historyCount: number;
}

export interface GovernedSavedViewSummary {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly string[];
  readonly sharedWithPrincipalIds: readonly string[];
  readonly queryDigest: string;
}

export interface GovernedDeliveryAttemptSummary {
  readonly id: string;
  readonly channel: string;
  readonly status: string;
  readonly attempt: number;
  readonly lastAttemptAt: string;
  readonly nextAttemptAt?: string;
  readonly terminalReason?: string;
  readonly correlationId: string;
}

export interface GovernedRegisterWorkspaceState {
  readonly quality: 'current' | 'partial' | 'unavailable';
  readonly principalId: string;
  readonly records: readonly GovernedRegisterView[];
  readonly views: readonly GovernedSavedViewSummary[];
  readonly deliveries: readonly GovernedDeliveryAttemptSummary[];
  readonly safeNextAction: string;
}

function registerView(value: unknown, tenantId: string): GovernedRegisterView | undefined {
  const candidate = object(value);
  if (!candidate || candidate['tenant_id'] !== tenantId) return undefined;
  const id = text(candidate['id']);
  const kind = text(candidate['kind']);
  const title = text(candidate['title']);
  const description = text(candidate['description']);
  const status = text(candidate['status']);
  const owner = text(candidate['owner_principal_id']);
  const version = integer(candidate['version']);
  const updatedAt = text(candidate['updated_at']);
  if (
    !id ||
    !kind ||
    !title ||
    !description ||
    !status ||
    !owner ||
    version === undefined ||
    version < 1 ||
    !updatedAt
  ) {
    return undefined;
  }
  const expiresAt = text(candidate['expires_at']);
  const reviewAt = text(candidate['review_at']);
  return {
    id,
    kind,
    title,
    description,
    status,
    ownerPrincipalId: owner,
    version,
    updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(reviewAt ? { reviewAt } : {}),
    historyCount: Array.isArray(candidate['history']) ? candidate['history'].length : 0,
  };
}

function savedView(value: unknown, tenantId: string): GovernedSavedViewSummary | undefined {
  const candidate = object(value);
  const id = text(candidate?.['id']);
  const name = text(candidate?.['name']);
  const queryDigest = text(candidate?.['query_digest']);
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !name ||
    !queryDigest ||
    !/^[a-f0-9]{64}$/.test(queryDigest)
  ) {
    return undefined;
  }
  return {
    id,
    name,
    fields: strings(candidate['fields']),
    sharedWithPrincipalIds: strings(candidate['shared_with_principal_ids']),
    queryDigest,
  };
}

function deliveryAttempt(
  value: unknown,
  tenantId: string,
): GovernedDeliveryAttemptSummary | undefined {
  const candidate = object(value);
  const id = text(candidate?.['id']);
  const channel = text(candidate?.['channel']);
  const status = text(candidate?.['status']);
  const attempt = integer(candidate?.['attempt']);
  const lastAttemptAt = text(candidate?.['last_attempt_at']);
  const correlationId = text(candidate?.['correlation_id']);
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !channel ||
    !status ||
    attempt === undefined ||
    !lastAttemptAt ||
    !correlationId
  ) {
    return undefined;
  }
  const nextAttemptAt = text(candidate['next_attempt_at']);
  const terminalReason = text(candidate['terminal_reason']);
  return {
    id,
    channel,
    status,
    attempt,
    lastAttemptAt,
    correlationId,
    ...(nextAttemptAt ? { nextAttemptAt } : {}),
    ...(terminalReason ? { terminalReason } : {}),
  };
}

export async function loadGovernedRegisterWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedRegisterWorkspaceState> {
  if (!session.authenticated || !session.tenantId || !session.principalId) {
    return {
      quality: 'unavailable',
      principalId: '',
      records: [],
      views: [],
      deliveries: [],
      safeNextAction: 'Authenticate in an authorized tenant before reading governed registers.',
    };
  }
  const [registerResult, viewResult, deliveryResult] = await Promise.all([
    apiRead('/v1/register-records', session),
    apiRead('/v1/governed-views', session),
    apiRead('/v1/delivery-attempts', session),
  ]);
  const results = [registerResult, viewResult, deliveryResult];
  const failures = results.filter((result) => !result.ok).length;
  const rows = (result: (typeof results)[number]): readonly unknown[] => {
    const body = object(result.body);
    return Array.isArray(body?.['items']) ? body['items'] : [];
  };
  const records = rows(registerResult)
    .map((row) => registerView(row, session.tenantId!))
    .filter((row): row is GovernedRegisterView => row !== undefined);
  const views = rows(viewResult)
    .map((row) => savedView(row, session.tenantId!))
    .filter((row): row is GovernedSavedViewSummary => row !== undefined);
  const deliveries = rows(deliveryResult)
    .map((row) => deliveryAttempt(row, session.tenantId!))
    .filter((row): row is GovernedDeliveryAttemptSummary => row !== undefined);
  const rejectedRows =
    records.length !== rows(registerResult).length ||
    views.length !== rows(viewResult).length ||
    deliveries.length !== rows(deliveryResult).length;
  const quality =
    failures === results.length
      ? 'unavailable'
      : failures > 0 || rejectedRows
        ? 'partial'
        : 'current';
  return {
    quality,
    principalId: session.principalId,
    records,
    views,
    deliveries,
    safeNextAction:
      quality === 'current'
        ? 'Review due lifecycle actions and reconcile any delayed or terminal delivery channel.'
        : 'Restore and reconcile every unavailable register, view, or delivery projection before inferring completeness.',
  };
}

export interface GovernedEvidenceRequestView {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly requestedEvidenceTypes: readonly string[];
  readonly ownerPrincipalId: string;
  readonly dueAt: string;
  readonly expiresAt: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface GovernedEvidenceWorkspaceState {
  readonly quality: 'current' | 'unknown' | 'unavailable';
  readonly principalId: string;
  readonly requests: readonly GovernedEvidenceRequestView[];
  readonly safeNextAction: string;
}

function evidenceRequestView(
  value: unknown,
  tenantId: string,
): GovernedEvidenceRequestView | undefined {
  const candidate = object(value);
  const id = text(candidate?.['id']);
  const status = text(candidate?.['status']);
  const version = integer(candidate?.['version']);
  const owner = text(candidate?.['owner_principal_id']);
  const dueAt = text(candidate?.['due_at']);
  const expiresAt = text(candidate?.['expires_at']);
  const scope = object(candidate?.['scope']);
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !status ||
    version === undefined ||
    version < 1 ||
    !owner ||
    !dueAt ||
    !expiresAt ||
    !scope
  ) {
    return undefined;
  }
  return {
    id,
    status,
    version,
    requestedEvidenceTypes: strings(candidate['requested_evidence_types']),
    ownerPrincipalId: owner,
    dueAt,
    expiresAt,
    scope,
  };
}

export async function loadGovernedEvidenceWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedEvidenceWorkspaceState> {
  if (!session.authenticated || !session.tenantId || !session.principalId) {
    return {
      quality: 'unavailable',
      principalId: '',
      requests: [],
      safeNextAction: 'Authenticate in an authorized tenant before reading evidence requests.',
    };
  }
  const result = await apiRead('/v1/evidence-requests', session);
  if (!result.ok) {
    return {
      quality: 'unavailable',
      principalId: session.principalId,
      requests: [],
      safeNextAction:
        result.safeNextAction ??
        'Restore the evidence request projection before inferring assurance state.',
    };
  }
  const body = object(result.body);
  const rows = Array.isArray(body?.['items']) ? body['items'] : undefined;
  const metadata = object(body?.['metadata']);
  if (!rows || !text(metadata?.['source_cursor'])) {
    return {
      quality: 'unknown',
      principalId: session.principalId,
      requests: [],
      safeNextAction:
        'Reconcile evidence request metadata; incomplete history is not a verified empty inbox.',
    };
  }
  const requests = rows
    .map((row) => evidenceRequestView(row, session.tenantId!))
    .filter((row): row is GovernedEvidenceRequestView => row !== undefined);
  return {
    quality: requests.length === rows.length ? 'current' : 'unknown',
    principalId: session.principalId,
    requests,
    safeNextAction:
      requests.length === 0
        ? 'Issue a version-bound evidence request before creating an assurance package.'
        : 'Review due/expiry state, exact attestations, sufficiency history, and package verification.',
  };
}

export interface GovernedMonitoringCaseView {
  readonly id: string;
  readonly status: string;
  readonly severity: string;
  readonly assuranceOutcome: string;
  readonly ownerPrincipalId: string;
  readonly controlId: string;
  readonly lastEvaluationAt: string;
  readonly observationRefs: readonly string[];
  readonly sourceHealth: Readonly<Record<string, string>>;
  readonly freshness: string;
  readonly completeness: string;
  readonly uncertaintyReasons: readonly string[];
  readonly retryAttempts: number;
  readonly retryTerminal: boolean;
  readonly terminalFailureRef?: string;
  readonly resourceVersion: number;
}

export interface GovernedMonitoringWorkspaceState {
  readonly quality: 'current' | 'partial' | 'unknown' | 'unavailable';
  readonly principalId: string;
  readonly cases: readonly GovernedMonitoringCaseView[];
  readonly safeNextAction: string;
}

function monitoringCaseView(
  value: unknown,
  tenantId: string,
): GovernedMonitoringCaseView | undefined {
  const candidate = object(value);
  const retry = object(candidate?.['retry_state']);
  const health = object(candidate?.['source_health']);
  const id = text(candidate?.['id']);
  const status = text(candidate?.['status']);
  const severity = text(candidate?.['severity']);
  const assuranceOutcome = text(candidate?.['assurance_outcome']);
  const owner = text(candidate?.['owner_principal_id']);
  const controlId = text(candidate?.['control_id']);
  const lastEvaluationAt = text(candidate?.['last_evaluation_at']);
  const resourceVersion = integer(candidate?.['resource_version']);
  const retryAttempts = integer(retry?.['attempts']);
  const terminalFailureRef = text(candidate?.['terminal_failure_ref']);
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !status ||
    !severity ||
    !assuranceOutcome ||
    !owner ||
    !controlId ||
    !lastEvaluationAt ||
    resourceVersion === undefined ||
    retryAttempts === undefined ||
    !retry ||
    !health
  ) {
    return undefined;
  }
  const sourceHealth = Object.freeze(
    Object.fromEntries(
      Object.entries(health)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return {
    id,
    status,
    severity,
    assuranceOutcome,
    ownerPrincipalId: owner,
    controlId,
    lastEvaluationAt,
    observationRefs: strings(candidate['observation_refs']),
    sourceHealth,
    freshness: text(candidate['freshness']) ?? 'unknown',
    completeness: text(candidate['completeness']) ?? 'unknown',
    uncertaintyReasons: strings(candidate['uncertainty_reasons']),
    retryAttempts,
    retryTerminal: retry['terminal'] === true,
    ...(terminalFailureRef ? { terminalFailureRef } : {}),
    resourceVersion,
  };
}

export async function loadGovernedMonitoringWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedMonitoringWorkspaceState> {
  if (!session.authenticated || !session.tenantId || !session.principalId) {
    return {
      quality: 'unavailable',
      principalId: '',
      cases: [],
      safeNextAction: 'Authenticate in an authorized tenant before reading monitoring cases.',
    };
  }
  const result = await apiRead('/v1/monitoring-cases', session);
  if (!result.ok) {
    return {
      quality: 'unavailable',
      principalId: session.principalId,
      cases: [],
      safeNextAction:
        result.safeNextAction ??
        'Restore the monitoring projection before inferring control or source health.',
    };
  }
  const body = object(result.body);
  const rows = Array.isArray(body?.['items']) ? body['items'] : undefined;
  const metadata = object(body?.['metadata']);
  if (!rows || !text(metadata?.['source_cursor'])) {
    return {
      quality: 'unknown',
      principalId: session.principalId,
      cases: [],
      safeNextAction:
        'Reconcile monitoring metadata; an unavailable case list is not verified healthy state.',
    };
  }
  const cases = rows
    .map((row) => monitoringCaseView(row, session.tenantId!))
    .filter((row): row is GovernedMonitoringCaseView => row !== undefined);
  const partial =
    metadata?.['partial_coverage'] === true ||
    cases.some((item) => item.uncertaintyReasons.length > 0);
  const quality = cases.length !== rows.length ? 'unknown' : partial ? 'partial' : 'current';
  return {
    quality,
    principalId: session.principalId,
    cases,
    safeNextAction:
      cases.length === 0
        ? 'Restore observation coverage before treating the tenant as free of actionable conditions.'
        : partial
          ? 'Investigate uncertainty, source health, retries, and terminal evidence; do not infer pass.'
          : 'Review current case ownership and exact observation evidence.',
  };
}

export interface GovernedAiComponentView {
  readonly versionRef: string;
  readonly kind: string;
  readonly providerRef: string;
  readonly modelRef: string;
  readonly status: string;
  readonly canonicalDigest: string;
}

export interface GovernedAiEvaluationView {
  readonly id: string;
  readonly verdict: string;
  readonly componentVersionRefs: readonly string[];
  readonly limitations: readonly string[];
  readonly evaluatedAt: string;
}

export interface GovernedAiApprovalView {
  readonly id: string;
  readonly componentVersionRefs: readonly string[];
  readonly approvedByPrincipalId: string;
  readonly validUntil: string;
}

export interface GovernedAiIncidentView {
  readonly id: string;
  readonly severity: string;
  readonly status: string;
  readonly evidenceRefs: readonly string[];
  readonly detectedAt: string;
}

export interface GovernedAiUseCaseView {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly ownerPrincipalId: string;
  readonly riskClass: string;
  readonly lifecycleState: string;
  readonly activeComponentVersionRefs: readonly string[];
  readonly components: readonly GovernedAiComponentView[];
  readonly evaluations: readonly GovernedAiEvaluationView[];
  readonly approvals: readonly GovernedAiApprovalView[];
  readonly incidents: readonly GovernedAiIncidentView[];
  readonly retirementConditions: readonly string[];
  readonly resourceVersion: number;
}

export interface GovernedAiWorkspaceState {
  readonly quality: 'current' | 'partial' | 'unknown' | 'unavailable';
  readonly useCases: readonly GovernedAiUseCaseView[];
  readonly safeNextAction: string;
}

function aiUseCaseView(value: unknown, tenantId: string): GovernedAiUseCaseView | undefined {
  const candidate = object(value);
  const id = text(candidate?.['id']);
  const name = text(candidate?.['name']);
  const purpose = text(candidate?.['purpose']);
  const owner = text(candidate?.['owner_principal_id']);
  const riskClass = text(candidate?.['risk_class']);
  const lifecycleState = text(candidate?.['lifecycle_state']);
  const resourceVersion = integer(candidate?.['resource_version']);
  const componentRows = Array.isArray(candidate?.['components'])
    ? candidate['components']
    : undefined;
  const evaluationRows = Array.isArray(candidate?.['evaluations'])
    ? candidate['evaluations']
    : undefined;
  const approvalRows = Array.isArray(candidate?.['approvals']) ? candidate['approvals'] : undefined;
  const incidentRows = Array.isArray(candidate?.['incidents']) ? candidate['incidents'] : undefined;
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !name ||
    !purpose ||
    !owner ||
    !riskClass ||
    !lifecycleState ||
    resourceVersion === undefined ||
    !componentRows ||
    !evaluationRows ||
    !approvalRows ||
    !incidentRows
  ) {
    return undefined;
  }
  const components = componentRows.flatMap((row) => {
    const item = object(row);
    const versionRef = text(item?.['version_ref']);
    const kind = text(item?.['kind']);
    const providerRef = text(item?.['provider_ref']);
    const modelRef = text(item?.['model_ref']);
    const status = text(item?.['status']);
    const canonicalDigest = text(item?.['canonical_digest']);
    return versionRef && kind && providerRef && modelRef && status && canonicalDigest
      ? [{ versionRef, kind, providerRef, modelRef, status, canonicalDigest }]
      : [];
  });
  const evaluations = evaluationRows.flatMap((row) => {
    const item = object(row);
    const evaluationId = text(item?.['id']);
    const verdict = text(item?.['verdict']);
    const evaluatedAt = text(item?.['evaluated_at']);
    return evaluationId && verdict && evaluatedAt
      ? [
          {
            id: evaluationId,
            verdict,
            componentVersionRefs: strings(item?.['component_version_refs']),
            limitations: strings(item?.['limitations']),
            evaluatedAt,
          },
        ]
      : [];
  });
  const approvals = approvalRows.flatMap((row) => {
    const item = object(row);
    const approvalId = text(item?.['id']);
    const approvedByPrincipalId = text(item?.['approved_by_principal_id']);
    const validUntil = text(item?.['valid_until']);
    return approvalId && approvedByPrincipalId && validUntil
      ? [
          {
            id: approvalId,
            componentVersionRefs: strings(item?.['component_version_refs']),
            approvedByPrincipalId,
            validUntil,
          },
        ]
      : [];
  });
  const incidents = incidentRows.flatMap((row) => {
    const item = object(row);
    const incidentId = text(item?.['id']);
    const severity = text(item?.['severity']);
    const status = text(item?.['status']);
    const detectedAt = text(item?.['detected_at']);
    return incidentId && severity && status && detectedAt
      ? [
          {
            id: incidentId,
            severity,
            status,
            evidenceRefs: strings(item?.['evidence_refs']),
            detectedAt,
          },
        ]
      : [];
  });
  return {
    id,
    name,
    purpose,
    ownerPrincipalId: owner,
    riskClass,
    lifecycleState,
    activeComponentVersionRefs: strings(candidate['active_component_version_refs']),
    components,
    evaluations,
    approvals,
    incidents,
    retirementConditions: strings(candidate['retirement_conditions']),
    resourceVersion,
  };
}

export async function loadGovernedAiWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedAiWorkspaceState> {
  if (!session.authenticated || !session.tenantId) {
    return {
      quality: 'unavailable',
      useCases: [],
      safeNextAction: 'Authenticate in an authorized tenant before reading AI governance state.',
    };
  }
  const result = await apiRead('/v1/ai-use-cases', session);
  if (!result.ok) {
    return {
      quality: 'unavailable',
      useCases: [],
      safeNextAction:
        result.safeNextAction ?? 'Restore the AI governance projection before inferring authority.',
    };
  }
  const body = object(result.body);
  const rows = Array.isArray(body?.['items']) ? body['items'] : undefined;
  const metadata = object(body?.['metadata']);
  if (!rows || !text(metadata?.['source_cursor'])) {
    return {
      quality: 'unknown',
      useCases: [],
      safeNextAction: 'Reconcile AI governance metadata; zero rows is not verified safe state.',
    };
  }
  const useCases = rows
    .map((row) => aiUseCaseView(row, session.tenantId!))
    .filter((row): row is GovernedAiUseCaseView => row !== undefined);
  const partial = useCases.some(
    (item) =>
      ['constrained', 'suspended'].includes(item.lifecycleState) ||
      item.evaluations.some((evaluation) => evaluation.verdict !== 'pass') ||
      item.incidents.some((incident) => incident.status === 'open'),
  );
  return {
    quality: useCases.length !== rows.length ? 'unknown' : partial ? 'partial' : 'current',
    useCases,
    safeNextAction:
      useCases.length === 0
        ? 'Register purpose, owner, risk, components, evaluations, oversight, and retirement conditions before use.'
        : partial
          ? 'Keep constrained or suspended use cases blocked until approvals, evaluations, drift, and incidents are resolved.'
          : 'Verify exact component approval validity and continuous monitoring evidence.',
  };
}

export interface GovernedConnectorCertificationView {
  readonly id: string;
  readonly connectorId: string;
  readonly exactVersion: string;
  readonly manifestDigest: string;
  readonly reportDigest: string;
  readonly suiteVersion: string;
  readonly authorPrincipalId: string;
  readonly certifierPrincipalId: string;
  readonly allowedScopes: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly credentialClasses: readonly string[];
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

export interface GovernedConnectorHealthView {
  readonly id: string;
  readonly connectorId: string;
  readonly certificationId: string;
  readonly status: string;
  readonly lastAttemptAt: string;
  readonly lastSuccessAt?: string;
  readonly retryState: string;
  readonly terminalFailureRef?: string;
  readonly reconciliationAvailable: boolean;
}

export interface GovernedConnectorWorkspaceState {
  readonly quality: 'current' | 'partial' | 'unknown' | 'unavailable';
  readonly certifications: readonly GovernedConnectorCertificationView[];
  readonly health: readonly GovernedConnectorHealthView[];
  readonly safeNextAction: string;
}

function connectorCertificationView(
  value: unknown,
  tenantId: string,
): GovernedConnectorCertificationView | undefined {
  const candidate = object(value);
  const id = text(candidate?.['id']);
  const connectorId = text(candidate?.['connector_id']);
  const exactVersion = text(candidate?.['exact_version']);
  const manifestDigest = text(candidate?.['manifest_digest']);
  const reportDigest = text(candidate?.['report_digest']);
  const suiteVersion = text(candidate?.['suite_version']);
  const authorPrincipalId = text(candidate?.['author_principal_id']);
  const certifierPrincipalId = text(candidate?.['certifier_principal_id']);
  const validFrom = text(candidate?.['valid_from']);
  const expiresAt = text(candidate?.['expires_at']);
  const status = text(candidate?.['status']);
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !connectorId ||
    !exactVersion ||
    !manifestDigest ||
    !reportDigest ||
    !suiteVersion ||
    !authorPrincipalId ||
    !certifierPrincipalId ||
    !validFrom ||
    !expiresAt ||
    !status ||
    !/^[a-f0-9]{64}$/.test(manifestDigest) ||
    !/^[a-f0-9]{64}$/.test(reportDigest)
  ) {
    return undefined;
  }
  const revocation = object(candidate['revocation_reason']);
  const revokedAt = text(candidate['revoked_at']);
  const revocationReason = text(revocation?.['text']);
  return {
    id,
    connectorId,
    exactVersion,
    manifestDigest,
    reportDigest,
    suiteVersion,
    authorPrincipalId,
    certifierPrincipalId,
    allowedScopes: strings(candidate['allowed_scopes']),
    allowedCapabilities: strings(candidate['allowed_capabilities']),
    credentialClasses: strings(candidate['credential_classes']),
    validFrom,
    expiresAt,
    status,
    ...(revokedAt ? { revokedAt } : {}),
    ...(revocationReason ? { revocationReason } : {}),
  };
}

function connectorHealthView(
  value: unknown,
  tenantId: string,
): GovernedConnectorHealthView | undefined {
  const candidate = object(value);
  const id = text(candidate?.['id']);
  const connectorId = text(candidate?.['connector_id']);
  const certificationId = text(candidate?.['certification_id']);
  const status = text(candidate?.['status']);
  const lastAttemptAt = text(candidate?.['last_attempt_at']);
  const retryState = text(candidate?.['retry_state']);
  if (
    !candidate ||
    candidate['tenant_id'] !== tenantId ||
    !id ||
    !connectorId ||
    !certificationId ||
    !status ||
    !lastAttemptAt ||
    !retryState
  ) {
    return undefined;
  }
  const lastSuccessAt = text(candidate['last_success_at']);
  const terminalFailureRef = text(candidate['terminal_failure_ref']);
  return {
    id,
    connectorId,
    certificationId,
    status,
    lastAttemptAt,
    retryState,
    reconciliationAvailable: candidate['reconciliation_available'] === true,
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(terminalFailureRef ? { terminalFailureRef } : {}),
  };
}

export async function loadGovernedConnectorWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedConnectorWorkspaceState> {
  if (!session.authenticated || !session.tenantId) {
    return {
      quality: 'unavailable',
      certifications: [],
      health: [],
      safeNextAction:
        'Authenticate in an authorized tenant before reading connector certification state.',
    };
  }
  const [certificationResult, healthResult] = await Promise.all([
    apiRead('/v1/connector-certifications', session),
    apiRead('/v1/connector-health', session),
  ]);
  if (!certificationResult.ok || !healthResult.ok) {
    return {
      quality: 'unavailable',
      certifications: [],
      health: [],
      safeNextAction:
        certificationResult.safeNextAction ??
        healthResult.safeNextAction ??
        'Restore connector certification and health projections before enabling new work.',
    };
  }
  const certificationBody = object(certificationResult.body);
  const healthBody = object(healthResult.body);
  const certificationRows = Array.isArray(certificationBody?.['items'])
    ? certificationBody['items']
    : undefined;
  const healthRows = Array.isArray(healthBody?.['items']) ? healthBody['items'] : undefined;
  if (!certificationRows || !healthRows) {
    return {
      quality: 'unknown',
      certifications: [],
      health: [],
      safeNextAction:
        'Reconcile connector projections; absent rows are not proof of safe certification or health.',
    };
  }
  const certifications = certificationRows
    .map((row) => connectorCertificationView(row, session.tenantId!))
    .filter((row): row is GovernedConnectorCertificationView => row !== undefined);
  const health = healthRows
    .map((row) => connectorHealthView(row, session.tenantId!))
    .filter((row): row is GovernedConnectorHealthView => row !== undefined);
  const partial =
    certifications.some(
      (item) => item.status !== 'active' || Date.parse(item.expiresAt) <= Date.now(),
    ) ||
    health.some(
      (item) =>
        item.status !== 'healthy' || item.retryState === 'terminal' || item.reconciliationAvailable,
    );
  return {
    quality:
      certifications.length !== certificationRows.length || health.length !== healthRows.length
        ? 'unknown'
        : partial
          ? 'partial'
          : 'current',
    certifications,
    health,
    safeNextAction:
      certifications.length === 0
        ? 'Author a complete manifest and pass every conformance dimension before certification.'
        : partial
          ? 'Block new connector work and reconcile revoked, unhealthy, terminal, or uncertain outcomes.'
          : 'Verify exact certification bounds, source health, and reconciliation evidence.',
  };
}

export interface GovernedFrameworkMatrixRow {
  readonly id: string;
  readonly sourcePublicationId: string;
  readonly sourceClauseRef: string;
  readonly requirementType: string;
  readonly applicability: string;
  readonly duty: string;
  readonly targetType: string;
  readonly targetRef: string;
  readonly mappingType: string;
  readonly mappingStatus: string;
  readonly coverageExtent: string;
  readonly conditions: readonly string[];
  readonly controlCoverage: string;
  readonly evidenceSufficiency: string;
  readonly readiness: string;
  readonly assessment: string;
  readonly certification: string;
  readonly evidenceRefs: readonly string[];
  readonly rationale: string;
  readonly confidenceBand: string;
  readonly mappingVersion: number;
}

export interface GovernedFrameworkMatrixWorkspaceState {
  readonly quality: 'current' | 'partial' | 'unknown' | 'unavailable';
  readonly rows: readonly GovernedFrameworkMatrixRow[];
  readonly digest?: string;
  readonly generatedAt?: string;
  readonly sourceCursor?: string;
  readonly diagnostic?: string;
  readonly safeNextAction: string;
}

function frameworkMatrixRow(
  value: unknown,
  tenantId: string,
): GovernedFrameworkMatrixRow | undefined {
  const candidate = object(value);
  if (!candidate || candidate['tenant_id'] !== tenantId) return undefined;
  const required = [
    'id',
    'source_publication_id',
    'source_clause_ref',
    'requirement_type',
    'applicability',
    'duty',
    'target_type',
    'target_ref',
    'mapping_type',
    'mapping_status',
    'coverage_extent',
    'control_coverage',
    'evidence_sufficiency',
    'readiness',
    'assessment',
    'certification',
    'rationale',
    'confidence_band',
  ] as const;
  const fields = Object.fromEntries(required.map((key) => [key, text(candidate[key])]));
  const version = integer(candidate['mapping_version']);
  if (required.some((key) => !fields[key]) || version === undefined || version < 1) {
    return undefined;
  }
  return {
    id: fields['id']!,
    sourcePublicationId: fields['source_publication_id']!,
    sourceClauseRef: fields['source_clause_ref']!,
    requirementType: fields['requirement_type']!,
    applicability: fields['applicability']!,
    duty: fields['duty']!,
    targetType: fields['target_type']!,
    targetRef: fields['target_ref']!,
    mappingType: fields['mapping_type']!,
    mappingStatus: fields['mapping_status']!,
    coverageExtent: fields['coverage_extent']!,
    conditions: strings(candidate['conditions']),
    controlCoverage: fields['control_coverage']!,
    evidenceSufficiency: fields['evidence_sufficiency']!,
    readiness: fields['readiness']!,
    assessment: fields['assessment']!,
    certification: fields['certification']!,
    evidenceRefs: strings(candidate['evidence_refs']),
    rationale: fields['rationale']!,
    confidenceBand: fields['confidence_band']!,
    mappingVersion: version,
  };
}

export async function loadGovernedFrameworkMatrixWorkspace(
  session: OperatorSessionContext,
): Promise<GovernedFrameworkMatrixWorkspaceState> {
  if (!session.authenticated || !session.tenantId) {
    return {
      quality: 'unavailable',
      rows: [],
      safeNextAction: 'Authenticate in an authorized tenant before reading framework mappings.',
    };
  }
  const result = await apiRead('/v1/framework-matrix', session);
  if (!result.ok) {
    return {
      quality: result.failure === 'malformed_response' ? 'unknown' : 'unavailable',
      rows: [],
      safeNextAction:
        result.safeNextAction ??
        'Restore the framework projection before making readiness or certification claims.',
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    };
  }
  const body = object(result.body);
  const metadata = object(body?.['metadata']);
  const rawRows = Array.isArray(body?.['rows']) ? body['rows'] : undefined;
  const digest = text(body?.['digest']);
  const generatedAt = text(metadata?.['generated_at']);
  const sourceCursor = text(metadata?.['source_cursor']);
  if (
    !body ||
    body['tenant_id'] !== session.tenantId ||
    !metadata ||
    !rawRows ||
    !digest ||
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    !generatedAt ||
    !sourceCursor
  ) {
    return {
      quality: 'unknown',
      rows: [],
      safeNextAction:
        'Reconcile malformed matrix metadata; incomplete rows are not treated as compliance evidence.',
    };
  }
  const rows = rawRows
    .map((row) => frameworkMatrixRow(row, session.tenantId!))
    .filter((row): row is GovernedFrameworkMatrixRow => row !== undefined);
  const partial =
    metadata['partial_coverage'] === true ||
    rows.some(
      (row) =>
        row.mappingStatus !== 'active' ||
        ['conditional', 'undetermined'].includes(row.applicability) ||
        !['covered', 'not_applicable'].includes(row.controlCoverage) ||
        !['sufficient', 'not_applicable'].includes(row.evidenceSufficiency) ||
        !['ready', 'not_applicable'].includes(row.readiness) ||
        !['assessed', 'not_applicable'].includes(row.assessment),
    );
  return {
    quality: rows.length !== rawRows.length ? 'unknown' : partial ? 'partial' : 'current',
    rows,
    digest,
    generatedAt,
    sourceCursor,
    safeNextAction:
      rows.length === 0
        ? 'Review applicability and create independently reviewed typed framework mappings.'
        : partial
          ? 'Resolve disputed, conditional, partial, stale, or unassessed dimensions without promoting readiness to certification.'
          : 'Review each claim dimension and verify any external certification independently.',
  };
}
