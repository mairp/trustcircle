import { assertGovernedTenant, canonicalGovernedJson, governedDigest } from '@trustcircle/domain';

export type ControlObservationStatus =
  'pass' | 'fail' | 'warning' | 'unknown' | 'unavailable' | 'conflicting';
export type ObservationFreshness = 'fresh' | 'aging' | 'stale' | 'unknown';
export type ObservationCompleteness = 'complete' | 'partial' | 'unknown';
export type MonitoringSourceHealth = 'healthy' | 'degraded' | 'unavailable' | 'revoked' | 'unknown';

export interface ControlObservation {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly sourceEventId: string;
  readonly sourceContractVersion: number;
  readonly assetId: string;
  readonly controlId: string;
  readonly conditionId: string;
  readonly observedAt: number;
  readonly receivedAt: number;
  readonly status: ControlObservationStatus;
  readonly freshness: ObservationFreshness;
  readonly completeness: ObservationCompleteness;
  readonly confidence: number;
  readonly payloadEvidenceRef: string;
  readonly sourceHealth: MonitoringSourceHealth;
  readonly correlationAttributes: Readonly<Record<string, unknown>>;
  readonly canonicalDigest: string;
}
export type ControlObservationInput = Omit<ControlObservation, 'canonicalDigest'>;
export type MonitoringCorrelationAttribute = 'assetId' | 'controlId' | 'conditionId';
export interface MonitoringCorrelationPolicy {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly keyAttributes: readonly MonitoringCorrelationAttribute[];
  readonly requiredSourceIds: readonly string[];
  readonly staleAfterMs: number;
  readonly defaultOwnerPrincipalId: string;
  readonly maxObservationRefs: number;
}
export interface MonitoringRetryState {
  readonly attempts: number;
  readonly lastFailureCode?: string;
  readonly lastAttemptAt?: number;
  readonly nextRetryAt?: number;
  readonly terminal: boolean;
}
export type MonitoringAssuranceOutcome = 'pass' | 'attention' | 'unknown';
export interface MonitoringCase {
  readonly id: string;
  readonly tenantId: string;
  readonly correlationPolicyId: string;
  readonly correlationPolicyVersion: number;
  readonly caseKey: string;
  readonly controlId: string;
  readonly affectedScope: Readonly<Record<string, string>>;
  readonly conditionClass: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  readonly status:
    | 'open'
    | 'acknowledged'
    | 'investigating'
    | 'pending_decision'
    | 'remediation'
    | 'pending_verification'
    | 'resolved'
    | 'closed'
    | 'suspended';
  readonly assuranceOutcome: MonitoringAssuranceOutcome;
  readonly ownerPrincipalId: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly lastEvaluationAt: number;
  readonly observationRefs: readonly string[];
  readonly sourceHealth: Readonly<Record<string, MonitoringSourceHealth>>;
  readonly freshness: ObservationFreshness;
  readonly completeness: ObservationCompleteness;
  readonly uncertaintyReasons: readonly string[];
  readonly retryState: MonitoringRetryState;
  readonly terminalFailureRef?: string;
  readonly registerRecordId?: string;
  readonly resourceVersion: number;
}
export interface MonitoringDraftRegisterRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'gap';
  readonly status: 'draft';
  readonly monitoringCaseId: string;
  readonly ownerPrincipalId: string;
  readonly reason: Readonly<{ code: 'monitoring.case'; text: string }>;
  readonly createdAt: number;
}
export interface MonitoringIngestResult {
  readonly ingestStatus: 'accepted' | 'duplicate';
  readonly observation: ControlObservation;
  readonly case: MonitoringCase;
}

const OBSERVATION_STATUSES = new Set<ControlObservationStatus>([
  'pass',
  'fail',
  'warning',
  'unknown',
  'unavailable',
  'conflicting',
]);
const FRESHNESS = new Set<ObservationFreshness>(['fresh', 'aging', 'stale', 'unknown']);
const COMPLETENESS = new Set<ObservationCompleteness>(['complete', 'partial', 'unknown']);
const SOURCE_HEALTH = new Set<MonitoringSourceHealth>([
  'healthy',
  'degraded',
  'unavailable',
  'revoked',
  'unknown',
]);

function text(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(field + ' is required.');
  return value.trim();
}
function epoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(field + ' must be a non-negative epoch integer.');
  return value;
}
function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(field + ' must be a positive integer.');
  return value;
}
function immutableJson<T>(value: T): T {
  return Object.freeze(JSON.parse(canonicalGovernedJson(value)) as T);
}
function failureCode(value: string): string {
  const code = text(value, 'failureCode');
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(code))
    throw new TypeError('failureCode must be a bounded machine code.');
  return code;
}
function evidenceRef(value: string, field: string): string {
  const checked = text(value, field);
  if (!checked.startsWith('/') || checked.startsWith('//') || checked.length > 512)
    throw new TypeError(field + ' must be a governed relative reference.');
  return checked;
}
export function acceptControlObservation(input: ControlObservationInput): ControlObservation {
  const observedAt = epoch(input.observedAt, 'observedAt');
  const receivedAt = epoch(input.receivedAt, 'receivedAt');
  if (observedAt > receivedAt)
    throw new RangeError('An observation cannot be received before it was observed.');
  if (!OBSERVATION_STATUSES.has(input.status))
    throw new TypeError('Unsupported observation status.');
  if (!FRESHNESS.has(input.freshness)) throw new TypeError('Unsupported observation freshness.');
  if (!COMPLETENESS.has(input.completeness))
    throw new TypeError('Unsupported observation completeness.');
  if (!SOURCE_HEALTH.has(input.sourceHealth)) throw new TypeError('Unsupported source health.');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    throw new RangeError('Observation confidence must be between zero and one.');
  const content = {
    id: text(input.id, 'id'),
    tenantId: text(input.tenantId, 'tenantId'),
    sourceId: text(input.sourceId, 'sourceId'),
    sourceEventId: text(input.sourceEventId, 'sourceEventId'),
    sourceContractVersion: positive(input.sourceContractVersion, 'sourceContractVersion'),
    assetId: text(input.assetId, 'assetId'),
    controlId: text(input.controlId, 'controlId'),
    conditionId: text(input.conditionId, 'conditionId'),
    observedAt,
    receivedAt,
    status: input.status,
    freshness: input.freshness,
    completeness: input.completeness,
    confidence: input.confidence,
    payloadEvidenceRef: evidenceRef(input.payloadEvidenceRef, 'payloadEvidenceRef'),
    sourceHealth: input.sourceHealth,
    correlationAttributes: immutableJson(input.correlationAttributes),
  };
  return Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
}
function validatePolicy(
  policy: MonitoringCorrelationPolicy,
  tenantId: string,
): MonitoringCorrelationPolicy {
  assertGovernedTenant(policy.tenantId, tenantId);
  const keyAttributes = [...new Set(policy.keyAttributes)];
  if (
    keyAttributes.length === 0 ||
    keyAttributes.some((key) => !['assetId', 'controlId', 'conditionId'].includes(key))
  )
    throw new TypeError('A correlation policy requires allowlisted key attributes.');
  const requiredSourceIds = [
    ...new Set(policy.requiredSourceIds.map((source) => text(source, 'requiredSourceId'))),
  ].sort();
  if (!Number.isSafeInteger(policy.staleAfterMs) || policy.staleAfterMs < 0)
    throw new RangeError('staleAfterMs must be a non-negative integer.');
  return Object.freeze({
    id: text(policy.id, 'policy.id'),
    tenantId,
    version: positive(policy.version, 'policy.version'),
    keyAttributes: Object.freeze(keyAttributes),
    requiredSourceIds: Object.freeze(requiredSourceIds),
    staleAfterMs: policy.staleAfterMs,
    defaultOwnerPrincipalId: text(policy.defaultOwnerPrincipalId, 'defaultOwnerPrincipalId'),
    maxObservationRefs: positive(policy.maxObservationRefs, 'maxObservationRefs'),
  });
}
function caseKey(observation: ControlObservation, policy: MonitoringCorrelationPolicy): string {
  const values = Object.fromEntries(policy.keyAttributes.map((key) => [key, observation[key]]));
  return governedDigest({
    tenantId: observation.tenantId,
    policyId: policy.id,
    policyVersion: policy.version,
    values,
  });
}
function worstFreshness(values: readonly ObservationFreshness[]): ObservationFreshness {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('stale')) return 'stale';
  if (values.includes('aging')) return 'aging';
  return 'fresh';
}
function worstCompleteness(values: readonly ObservationCompleteness[]): ObservationCompleteness {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('partial')) return 'partial';
  return 'complete';
}
function severity(observations: readonly ControlObservation[]): MonitoringCase['severity'] {
  if (observations.some((item) => item.status === 'fail' || item.status === 'conflicting'))
    return 'high';
  if (observations.some((item) => item.status === 'warning')) return 'medium';
  if (observations.some((item) => ['unknown', 'unavailable'].includes(item.status))) return 'low';
  return 'informational';
}
function evaluateCase(
  previous: MonitoringCase | undefined,
  observation: ControlObservation,
  observations: readonly ControlObservation[],
  policy: MonitoringCorrelationPolicy,
  now: number,
): MonitoringCase {
  const uncertainty = new Set<string>();
  const sources = new Set(observations.map((item) => item.sourceId));
  for (const required of policy.requiredSourceIds)
    if (!sources.has(required)) uncertainty.add('missing_source:' + required);
  for (const item of observations) {
    if (item.freshness === 'stale' || now - item.observedAt > policy.staleAfterMs)
      uncertainty.add('stale');
    else if (item.freshness === 'aging') uncertainty.add('aging');
    else if (item.freshness === 'unknown') uncertainty.add('freshness_unknown');
    if (item.completeness === 'partial') uncertainty.add('partial');
    else if (item.completeness === 'unknown') uncertainty.add('completeness_unknown');
    if (item.sourceHealth !== 'healthy') uncertainty.add('source_' + item.sourceHealth);
    if (item.status === 'conflicting') uncertainty.add('conflicting');
    if (item.status === 'unknown') uncertainty.add('outcome_unknown');
    if (item.status === 'unavailable') uncertainty.add('outcome_unavailable');
  }
  if (observations.length > policy.maxObservationRefs)
    uncertainty.add('observation_reference_bound_exceeded');
  const hasAdverse = observations.some(
    (item) => item.status === 'fail' || item.status === 'warning',
  );
  const assuranceOutcome: MonitoringAssuranceOutcome =
    uncertainty.size > 0 ? 'unknown' : hasAdverse ? 'attention' : 'pass';
  const health = Object.freeze(
    Object.fromEntries(
      [...observations]
        .sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id))
        .map((item) => [item.sourceId, item.sourceHealth]),
    ),
  );
  const refs = Object.freeze(
    [...new Set(observations.map((item) => item.id))].sort((a, b) => a.localeCompare(b)),
  );
  return Object.freeze({
    id: previous?.id ?? 'monitoring-case-' + caseKey(observation, policy).slice(0, 24),
    tenantId: observation.tenantId,
    correlationPolicyId: policy.id,
    correlationPolicyVersion: policy.version,
    caseKey: caseKey(observation, policy),
    controlId: observation.controlId,
    affectedScope: immutableJson({
      assetId: observation.assetId,
      controlId: observation.controlId,
    }),
    conditionClass: observation.conditionId,
    severity: severity(observations),
    status: previous?.status ?? 'open',
    assuranceOutcome,
    ownerPrincipalId: previous?.ownerPrincipalId ?? policy.defaultOwnerPrincipalId,
    firstObservedAt: Math.min(...observations.map((item) => item.observedAt)),
    lastObservedAt: Math.max(...observations.map((item) => item.observedAt)),
    lastEvaluationAt: now,
    observationRefs: refs,
    sourceHealth: health,
    freshness: worstFreshness(observations.map((item) => item.freshness)),
    completeness: worstCompleteness(observations.map((item) => item.completeness)),
    uncertaintyReasons: Object.freeze([...uncertainty].sort()),
    retryState: previous?.retryState ?? Object.freeze({ attempts: 0, terminal: false }),
    ...(previous?.terminalFailureRef ? { terminalFailureRef: previous.terminalFailureRef } : {}),
    ...(previous?.registerRecordId ? { registerRecordId: previous.registerRecordId } : {}),
    resourceVersion: (previous?.resourceVersion ?? 0) + 1,
  });
}

export class ContinuousMonitoringService {
  readonly #tenantId: string;
  readonly #observations = new Map<string, ControlObservation>();
  readonly #observationCaseKeys = new Map<string, string>();
  readonly #cases = new Map<string, MonitoringCase>();
  readonly #drafts = new Map<string, MonitoringDraftRegisterRecord>();
  constructor(tenantId: string) {
    this.#tenantId = text(tenantId, 'tenantId');
  }
  ingest(
    input: ControlObservationInput,
    policyInput: MonitoringCorrelationPolicy,
    nowInput: number,
  ): MonitoringIngestResult {
    const now = epoch(nowInput, 'now');
    const policy = validatePolicy(policyInput, this.#tenantId);
    const observation = acceptControlObservation(input);
    assertGovernedTenant(observation.tenantId, this.#tenantId);
    const replayKey = observation.sourceId + ':' + observation.sourceEventId;
    const replay = this.#observations.get(replayKey);
    if (replay) {
      if (replay.canonicalDigest !== observation.canonicalDigest)
        throw new TypeError('A source-event replay conflict changed the canonical digest.');
      const replayCaseKey = this.#observationCaseKeys.get(replayKey);
      const replayCase = replayCaseKey ? this.#cases.get(replayCaseKey) : undefined;
      if (!replayCase) throw new Error('Monitoring replay reconciliation state is incomplete.');
      return Object.freeze({ ingestStatus: 'duplicate', observation: replay, case: replayCase });
    }
    const key = caseKey(observation, policy);
    const previous = this.#cases.get(key);
    const related = [...this.#observations.values(), observation].filter(
      (candidate) => caseKey(candidate, policy) === key,
    );
    const next = evaluateCase(previous, observation, related, policy, now);
    this.#observations.set(replayKey, observation);
    this.#observationCaseKeys.set(replayKey, key);
    this.#cases.set(key, next);
    return Object.freeze({ ingestStatus: 'accepted', observation, case: next });
  }
  observations(): readonly ControlObservation[] {
    return Object.freeze(
      [...this.#observations.values()].sort(
        (a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id),
      ),
    );
  }
  cases(): readonly MonitoringCase[] {
    return Object.freeze([...this.#cases.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }
  applyAutomation(
    caseId: string,
    action: 'draft_register_record' | 'close' | 'accept_risk' | 'approve_exception',
    nowInput: number,
  ): {
    readonly case: MonitoringCase;
    readonly draftRegisterRecord?: MonitoringDraftRegisterRecord;
  } {
    const current = this.#case(caseId);
    const now = epoch(nowInput, 'now');
    if (action !== 'draft_register_record')
      throw new TypeError('Automation cannot exercise consequential human decision authority.');
    const existing = current.registerRecordId
      ? this.#drafts.get(current.registerRecordId)
      : undefined;
    if (existing) return Object.freeze({ case: current, draftRegisterRecord: existing });
    const draft = Object.freeze({
      id: 'register-draft-' + current.caseKey.slice(0, 24),
      tenantId: this.#tenantId,
      kind: 'gap' as const,
      status: 'draft' as const,
      monitoringCaseId: current.id,
      ownerPrincipalId: current.ownerPrincipalId,
      reason: Object.freeze({
        code: 'monitoring.case' as const,
        text: 'Drafted from a fail-visible monitoring case; no consequential decision was made.',
      }),
      createdAt: now,
    });
    const next = Object.freeze({
      ...current,
      registerRecordId: draft.id,
      resourceVersion: current.resourceVersion + 1,
      lastEvaluationAt: now,
    });
    this.#cases.set(current.caseKey, next);
    this.#drafts.set(draft.id, draft);
    return Object.freeze({ case: next, draftRegisterRecord: draft });
  }
  recordRetry(
    caseId: string,
    codeInput: string,
    attemptedAtInput: number,
    nextRetryAtInput: number,
  ): MonitoringCase {
    const current = this.#case(caseId);
    const attemptedAt = epoch(attemptedAtInput, 'attemptedAt');
    const nextRetryAt = epoch(nextRetryAtInput, 'nextRetryAt');
    if (nextRetryAt <= attemptedAt)
      throw new RangeError('A retry must be scheduled after its attempt.');
    const next = Object.freeze({
      ...current,
      retryState: Object.freeze({
        attempts: current.retryState.attempts + 1,
        lastFailureCode: failureCode(codeInput),
        lastAttemptAt: attemptedAt,
        nextRetryAt,
        terminal: false,
      }),
      resourceVersion: current.resourceVersion + 1,
      lastEvaluationAt: attemptedAt,
    });
    this.#cases.set(current.caseKey, next);
    return next;
  }
  recordTerminalFailure(
    caseId: string,
    codeInput: string,
    failureRefInput: string,
    atInput: number,
  ): MonitoringCase {
    const current = this.#case(caseId);
    const at = epoch(atInput, 'at');
    const next = Object.freeze({
      ...current,
      status: 'suspended' as const,
      retryState: Object.freeze({
        attempts: current.retryState.attempts,
        lastFailureCode: failureCode(codeInput),
        lastAttemptAt: at,
        terminal: true,
      }),
      terminalFailureRef: evidenceRef(failureRefInput, 'terminalFailureRef'),
      resourceVersion: current.resourceVersion + 1,
      lastEvaluationAt: at,
    });
    this.#cases.set(current.caseKey, next);
    return next;
  }
  #case(caseId: string): MonitoringCase {
    const found = [...this.#cases.values()].find((item) => item.id === caseId);
    if (!found) throw new TypeError('Monitoring case was not found in the tenant boundary.');
    return found;
  }
}
