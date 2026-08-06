import {
  assertDistinctGovernedAuthority,
  assertExpectedGovernedVersion,
  assertGovernedTenant,
  canonicalGovernedJson,
  governedDigest,
} from '@trustcircle/domain';

export type AiLifecycleState =
  | 'proposed'
  | 'evaluation'
  | 'pending_approval'
  | 'approved'
  | 'active'
  | 'constrained'
  | 'suspended'
  | 'retiring'
  | 'retired'
  | 'rejected';
export interface AiLifecycleHistoryEntry {
  readonly version: number;
  readonly priorState: AiLifecycleState | null;
  readonly state: AiLifecycleState;
  readonly actorPrincipalId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly authorityDecisionId?: string;
  readonly occurredAt: number;
  readonly canonicalDigest: string;
}
export interface AiComponentVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly useCaseId: string;
  readonly kind: string;
  readonly providerRef: string;
  readonly modelRef: string;
  readonly promptDigest: string;
  readonly toolManifestDigest: string;
  readonly dataSourceRefs: readonly string[];
  readonly version: number;
  readonly versionRef: string;
  readonly changeClass: string;
  readonly approvedScope: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly createdAt: number;
  readonly canonicalDigest: string;
}
export interface AiEvaluation {
  readonly id: string;
  readonly tenantId: string;
  readonly useCaseId: string;
  readonly componentVersionRefs: readonly string[];
  readonly evaluationPlanVersion: number;
  readonly datasetEvidenceRefs: readonly string[];
  readonly measures: Readonly<Record<string, number>>;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly results: Readonly<Record<string, number>>;
  readonly limitations: readonly string[];
  readonly evaluatorPrincipalId: string;
  readonly reviewedByPrincipalId: string;
  readonly verdict: 'pass' | 'fail' | 'limited';
  readonly evaluatedAt: number;
  readonly canonicalDigest: string;
}
export interface AiApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly useCaseId: string;
  readonly componentVersionRefs: readonly string[];
  readonly approvedByPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly approvedAt: number;
  readonly validUntil: number;
  readonly canonicalDigest: string;
}
export interface AiIncident {
  readonly id: string;
  readonly tenantId: string;
  readonly useCaseId: string;
  readonly componentVersionRefs: readonly string[];
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly affectedScope: Readonly<Record<string, unknown>>;
  readonly detectedAt: number;
  readonly source: string;
  readonly evidenceRefs: readonly string[];
  readonly status: 'open';
  readonly ownerPrincipalId: string;
  readonly containment: readonly string[];
  readonly correctiveActions: readonly string[];
  readonly canonicalDigest: string;
}
export interface AiUseCase {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly purpose: string;
  readonly ownerPrincipalId: string;
  readonly affectedPeople: readonly string[];
  readonly affectedSystems: readonly string[];
  readonly riskClass: string;
  readonly obligationRefs: readonly string[];
  readonly controlRefs: readonly string[];
  readonly oversightPlan: string;
  readonly prohibitedUses: readonly string[];
  readonly monitoringRuleRefs: readonly string[];
  readonly retirementConditions: readonly string[];
  readonly lifecycleState: AiLifecycleState;
  readonly activeComponentVersionRefs: readonly string[];
  readonly components: readonly AiComponentVersion[];
  readonly evaluations: readonly AiEvaluation[];
  readonly approvals: readonly AiApproval[];
  readonly incidents: readonly AiIncident[];
  readonly history: readonly AiLifecycleHistoryEntry[];
  readonly resourceVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
function text(value: string, field: string, max = 4000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max)
    throw new TypeError(field + ' is required and bounded.');
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
function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(field + ' must be SHA-256.');
  return value;
}
function strings(values: readonly string[], field: string): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => text(value, field, 512)))].sort());
}
function immutable<T>(value: T): T {
  return Object.freeze(JSON.parse(canonicalGovernedJson(value)) as T);
}
function reason(value: { readonly code: string; readonly text: string }) {
  const code = text(value.code, 'reason.code', 64);
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(code))
    throw new TypeError('A governed reason code is required.');
  return Object.freeze({ code, text: text(value.text, 'reason.text') });
}
function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function lifecycleEntry(input: {
  version: number;
  priorState: AiLifecycleState | null;
  state: AiLifecycleState;
  actorPrincipalId: string;
  reason: { readonly code: string; readonly text: string };
  authorityDecisionId?: string;
  occurredAt: number;
}): AiLifecycleHistoryEntry {
  const content = {
    version: positive(input.version, 'history.version'),
    priorState: input.priorState,
    state: input.state,
    actorPrincipalId: text(input.actorPrincipalId, 'actorPrincipalId'),
    reason: reason(input.reason),
    ...(input.authorityDecisionId
      ? { authorityDecisionId: text(input.authorityDecisionId, 'authorityDecisionId') }
      : {}),
    occurredAt: epoch(input.occurredAt, 'occurredAt'),
  };
  return Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
}
function nextUseCase(
  useCase: AiUseCase,
  state: AiLifecycleState,
  actor: string,
  why: { readonly code: string; readonly text: string },
  now: number,
  changes: Partial<AiUseCase> = {},
  authorityDecisionId?: string,
): AiUseCase {
  const version = useCase.resourceVersion + 1;
  const entry = lifecycleEntry({
    version,
    priorState: useCase.lifecycleState,
    state,
    actorPrincipalId: actor,
    reason: why,
    ...(authorityDecisionId ? { authorityDecisionId } : {}),
    occurredAt: now,
  });
  return Object.freeze({
    ...useCase,
    ...changes,
    lifecycleState: state,
    resourceVersion: version,
    updatedAt: now,
    history: Object.freeze([...useCase.history, entry]),
  });
}
export function createAiUseCase(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly purpose: string;
  readonly ownerPrincipalId: string;
  readonly affectedPeople: readonly string[];
  readonly affectedSystems: readonly string[];
  readonly riskClass: string;
  readonly obligationRefs: readonly string[];
  readonly controlRefs: readonly string[];
  readonly oversightPlan: string;
  readonly prohibitedUses: readonly string[];
  readonly monitoringRuleRefs: readonly string[];
  readonly retirementConditions: readonly string[];
  readonly createdByPrincipalId: string;
  readonly now: number;
}): AiUseCase {
  const now = epoch(input.now, 'now');
  const base = {
    id: text(input.id, 'id'),
    tenantId: text(input.tenantId, 'tenantId'),
    name: text(input.name, 'name', 256),
    purpose: text(input.purpose, 'purpose'),
    ownerPrincipalId: text(input.ownerPrincipalId, 'ownerPrincipalId'),
    affectedPeople: strings(input.affectedPeople, 'affectedPeople'),
    affectedSystems: strings(input.affectedSystems, 'affectedSystems'),
    riskClass: text(input.riskClass, 'riskClass', 64),
    obligationRefs: strings(input.obligationRefs, 'obligationRefs'),
    controlRefs: strings(input.controlRefs, 'controlRefs'),
    oversightPlan: text(input.oversightPlan, 'oversightPlan'),
    prohibitedUses: strings(input.prohibitedUses, 'prohibitedUses'),
    monitoringRuleRefs: strings(input.monitoringRuleRefs, 'monitoringRuleRefs'),
    retirementConditions: strings(input.retirementConditions, 'retirementConditions'),
    lifecycleState: 'proposed' as const,
    activeComponentVersionRefs: Object.freeze([]),
    components: Object.freeze([]),
    evaluations: Object.freeze([]),
    approvals: Object.freeze([]),
    incidents: Object.freeze([]),
    resourceVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const entry = lifecycleEntry({
    version: 1,
    priorState: null,
    state: 'proposed',
    actorPrincipalId: input.createdByPrincipalId,
    reason: { code: 'ai.create', text: 'Create the governed AI use case.' },
    occurredAt: now,
  });
  return Object.freeze({ ...base, history: Object.freeze([entry]) });
}
export function registerAiComponentVersion(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly component: {
    readonly id: string;
    readonly kind: string;
    readonly providerRef: string;
    readonly modelRef: string;
    readonly promptDigest: string;
    readonly toolManifestDigest: string;
    readonly dataSourceRefs: readonly string[];
    readonly version: number;
    readonly changeClass: string;
    readonly approvedScope: Readonly<Record<string, unknown>>;
    readonly status: string;
  };
  readonly now: number;
}): { readonly useCase: AiUseCase; readonly component: AiComponentVersion } {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  const now = epoch(input.now, 'now');
  const version = positive(input.component.version, 'component.version');
  const versionRef = text(input.component.id, 'component.id') + ':v' + version;
  if (input.useCase.components.some((item) => item.versionRef === versionRef))
    throw new TypeError('AI component version already exists.');
  const content = {
    id: text(input.component.id, 'component.id'),
    tenantId: input.tenantId,
    useCaseId: input.useCase.id,
    kind: text(input.component.kind, 'component.kind', 64),
    providerRef: text(input.component.providerRef, 'providerRef', 512),
    modelRef: text(input.component.modelRef, 'modelRef', 512),
    promptDigest: digest(input.component.promptDigest, 'promptDigest'),
    toolManifestDigest: digest(input.component.toolManifestDigest, 'toolManifestDigest'),
    dataSourceRefs: strings(input.component.dataSourceRefs, 'dataSourceRefs'),
    version,
    versionRef,
    changeClass: text(input.component.changeClass, 'changeClass', 64),
    approvedScope: immutable(input.component.approvedScope),
    status: text(input.component.status, 'component.status', 64),
    createdAt: now,
  };
  const component = Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
  const useCase = nextUseCase(
    input.useCase,
    input.useCase.lifecycleState,
    input.actorPrincipalId,
    { code: 'ai.component', text: 'Register an exact AI component version.' },
    now,
    { components: Object.freeze([...input.useCase.components, component]) },
  );
  return Object.freeze({ useCase, component });
}
export function recordAiEvaluation(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly id: string;
  readonly componentVersionRefs: readonly string[];
  readonly evaluationPlanVersion: number;
  readonly datasetEvidenceRefs: readonly string[];
  readonly measures: Readonly<Record<string, number>>;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly results: Readonly<Record<string, number>>;
  readonly limitations: readonly string[];
  readonly evaluatorPrincipalId: string;
  readonly reviewedByPrincipalId: string;
  readonly verdict: 'pass' | 'fail' | 'limited';
  readonly evaluatedAt: number;
}): { readonly useCase: AiUseCase; readonly evaluation: AiEvaluation } {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  assertDistinctGovernedAuthority(input.evaluatorPrincipalId, input.reviewedByPrincipalId);
  const refs = strings(input.componentVersionRefs, 'componentVersionRefs');
  if (
    refs.length === 0 ||
    refs.some((ref) => !input.useCase.components.some((item) => item.versionRef === ref))
  )
    throw new TypeError('Evaluation must bind exact registered component versions.');
  const content = {
    id: text(input.id, 'evaluation.id'),
    tenantId: input.tenantId,
    useCaseId: input.useCase.id,
    componentVersionRefs: refs,
    evaluationPlanVersion: positive(input.evaluationPlanVersion, 'evaluationPlanVersion'),
    datasetEvidenceRefs: strings(input.datasetEvidenceRefs, 'datasetEvidenceRefs'),
    measures: immutable(input.measures),
    thresholds: immutable(input.thresholds),
    results: immutable(input.results),
    limitations: strings(input.limitations, 'limitations'),
    evaluatorPrincipalId: text(input.evaluatorPrincipalId, 'evaluatorPrincipalId'),
    reviewedByPrincipalId: text(input.reviewedByPrincipalId, 'reviewedByPrincipalId'),
    verdict: input.verdict,
    evaluatedAt: epoch(input.evaluatedAt, 'evaluatedAt'),
  };
  const evaluation = Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
  const useCase = nextUseCase(
    input.useCase,
    'evaluation',
    input.reviewedByPrincipalId,
    {
      code: 'ai.evaluation',
      text: 'Record the independently reviewed exact-component evaluation.',
    },
    input.evaluatedAt,
    { evaluations: Object.freeze([...input.useCase.evaluations, evaluation]) },
  );
  return Object.freeze({ useCase, evaluation });
}
export function submitAiUseCaseForApproval(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly expectedVersion: number;
  readonly reason: { readonly code: string; readonly text: string };
  readonly now: number;
}): AiUseCase {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  assertExpectedGovernedVersion(input.useCase.resourceVersion, input.expectedVersion);
  if (!input.useCase.evaluations.some((item) => item.verdict === 'pass'))
    throw new TypeError('A passing independent evaluation is required.');
  return nextUseCase(
    input.useCase,
    'pending_approval',
    input.actorPrincipalId,
    input.reason,
    input.now,
  );
}
export function approveAiUseCase(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly approvalId: string;
  readonly componentVersionRefs: readonly string[];
  readonly approvedByPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly validUntil: number;
  readonly approvedAt: number;
}): { readonly useCase: AiUseCase; readonly approval: AiApproval } {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  if (input.useCase.lifecycleState !== 'pending_approval')
    throw new TypeError('AI use case is not pending approval.');
  assertDistinctGovernedAuthority(input.useCase.ownerPrincipalId, input.approvedByPrincipalId);
  const refs = strings(input.componentVersionRefs, 'componentVersionRefs');
  const current = input.useCase.components.map((item) => item.versionRef);
  if (!sameRefs(refs, current))
    throw new TypeError('Approval must bind the exact current component set.');
  const evaluated = input.useCase.evaluations.some(
    (item) => item.verdict === 'pass' && sameRefs(item.componentVersionRefs, refs),
  );
  if (!evaluated) throw new TypeError('The exact component set lacks a passing evaluation.');
  const approvedAt = epoch(input.approvedAt, 'approvedAt');
  const validUntil = epoch(input.validUntil, 'validUntil');
  if (validUntil <= approvedAt) throw new RangeError('Approval validity must follow approval.');
  const content = {
    id: text(input.approvalId, 'approvalId'),
    tenantId: input.tenantId,
    useCaseId: input.useCase.id,
    componentVersionRefs: refs,
    approvedByPrincipalId: text(input.approvedByPrincipalId, 'approvedByPrincipalId'),
    authorityDecisionId: text(input.authorityDecisionId, 'authorityDecisionId'),
    approvedAt,
    validUntil,
  };
  const approval = Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
  const useCase = nextUseCase(
    input.useCase,
    'approved',
    input.approvedByPrincipalId,
    { code: 'ai.approve', text: 'Approve the exact independently evaluated component set.' },
    approvedAt,
    { approvals: Object.freeze([...input.useCase.approvals, approval]) },
    input.authorityDecisionId,
  );
  return Object.freeze({ useCase, approval });
}

export function activateAiUseCase(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly componentVersionRefs: readonly string[];
  readonly now: number;
}): AiUseCase {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  if (input.useCase.lifecycleState !== 'approved')
    throw new TypeError('Only an approved AI use case can activate.');
  const refs = strings(input.componentVersionRefs, 'componentVersionRefs');
  const approval = [...input.useCase.approvals]
    .reverse()
    .find((item) => sameRefs(item.componentVersionRefs, refs));
  if (!approval || input.now >= approval.validUntil)
    throw new TypeError('A current exact-component approval is required.');
  return nextUseCase(
    input.useCase,
    'active',
    input.actorPrincipalId,
    { code: 'ai.activate', text: 'Activate only the exact approved component set.' },
    input.now,
    { activeComponentVersionRefs: refs },
    approval.authorityDecisionId,
  );
}
export function evaluateAiUseCaseBoundary(
  useCase: AiUseCase,
  currentComponentVersionRefs: readonly string[],
  nowInput: number,
): {
  readonly state: 'allowed' | 'constrained' | 'suspended';
  readonly reasons: readonly string[];
} {
  const now = epoch(nowInput, 'now');
  const reasons: string[] = [];
  const approval = [...useCase.approvals]
    .reverse()
    .find((item) => sameRefs(item.componentVersionRefs, useCase.activeComponentVersionRefs));
  if (!approval) reasons.push('approval_missing');
  else if (now >= approval.validUntil) reasons.push('approval_expired');
  if (!sameRefs(currentComponentVersionRefs, useCase.activeComponentVersionRefs))
    reasons.push('component_drift');
  if (
    useCase.incidents.some(
      (item) =>
        item.status === 'open' && (item.severity === 'critical' || item.severity === 'high'),
    )
  )
    reasons.push('open_material_incident');
  const state =
    reasons.includes('approval_expired') ||
    reasons.includes('approval_missing') ||
    reasons.includes('open_material_incident')
      ? 'suspended'
      : reasons.length > 0
        ? 'constrained'
        : 'allowed';
  return Object.freeze({ state, reasons: Object.freeze(reasons.sort()) });
}
export function reportAiIncident(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly id: string;
  readonly componentVersionRefs: readonly string[];
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly affectedScope: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly evidenceRefs: readonly string[];
  readonly ownerPrincipalId: string;
  readonly containment: readonly string[];
  readonly correctiveActions: readonly string[];
  readonly detectedAt: number;
}): { readonly useCase: AiUseCase; readonly incident: AiIncident } {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  const refs = strings(input.componentVersionRefs, 'componentVersionRefs');
  if (refs.some((ref) => !input.useCase.components.some((item) => item.versionRef === ref)))
    throw new TypeError('Incident component version is not registered.');
  const content = {
    id: text(input.id, 'incident.id'),
    tenantId: input.tenantId,
    useCaseId: input.useCase.id,
    componentVersionRefs: refs,
    severity: input.severity,
    affectedScope: immutable(input.affectedScope),
    detectedAt: epoch(input.detectedAt, 'detectedAt'),
    source: text(input.source, 'incident.source', 128),
    evidenceRefs: strings(input.evidenceRefs, 'evidenceRefs'),
    status: 'open' as const,
    ownerPrincipalId: text(input.ownerPrincipalId, 'ownerPrincipalId'),
    containment: strings(input.containment, 'containment'),
    correctiveActions: strings(input.correctiveActions, 'correctiveActions'),
  };
  const incident = Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
  const nextState =
    input.severity === 'critical' || input.severity === 'high' ? 'suspended' : 'constrained';
  const useCase = nextUseCase(
    input.useCase,
    nextState,
    input.ownerPrincipalId,
    { code: 'ai.incident', text: 'Constrain operation while the AI incident remains open.' },
    input.detectedAt,
    { incidents: Object.freeze([...input.useCase.incidents, incident]) },
  );
  return Object.freeze({ useCase, incident });
}
export function retireAiUseCase(input: {
  readonly useCase: AiUseCase;
  readonly tenantId: string;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly now: number;
}): AiUseCase {
  assertGovernedTenant(input.useCase.tenantId, input.tenantId);
  return nextUseCase(
    input.useCase,
    'retired',
    input.actorPrincipalId,
    input.reason,
    input.now,
    {},
    input.authorityDecisionId,
  );
}

export interface GovernedCopilotSource {
  readonly tenantId: string;
  readonly ref: string;
  readonly version: number;
  readonly digest: string;
  readonly kind: string;
  readonly freshness: 'current' | 'aging' | 'stale' | 'unknown';
  readonly conflicting: boolean;
  readonly authorized: boolean;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}
export interface GovernedCopilotCitation {
  readonly ref: string;
  readonly version: number;
  readonly digest: string;
  readonly kind: string;
  readonly citationRef: string;
}
export interface GovernedCopilotResponse {
  readonly id: string;
  readonly tenantId: string;
  readonly label: 'generated_assistance';
  readonly authority: 'non_authoritative';
  readonly facts: readonly {
    readonly label: string;
    readonly value: string;
    readonly citationRef: string;
  }[];
  readonly inferences: readonly string[];
  readonly suggestions: readonly string[];
  readonly citations: readonly GovernedCopilotCitation[];
  readonly limitationCodes: readonly string[];
  readonly abstentionCode: string | null;
  readonly auditMetadata: Readonly<Record<string, unknown>>;
  readonly responseDigest: string;
}
function sourceRef(value: string): string {
  const checked = text(value, 'source.ref', 512);
  if (!checked.startsWith('/') || checked.startsWith('//'))
    throw new TypeError('Copilot sources require governed relative refs.');
  return checked;
}
export function generateGovernedCopilotResponse(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly purpose: string;
  readonly queryClassification: string;
  readonly policyDecisionId: string;
  readonly sources: readonly GovernedCopilotSource[];
  readonly createdAt: number;
}): GovernedCopilotResponse {
  const tenantId = text(input.tenantId, 'tenantId');
  const excluded = { cross_tenant: 0, unauthorized: 0, stale: 0, conflicting: 0 };
  const authorized: GovernedCopilotSource[] = [];
  for (const source of input.sources) {
    if (source.tenantId !== tenantId) {
      excluded.cross_tenant += 1;
      continue;
    }
    if (!source.authorized) {
      excluded.unauthorized += 1;
      continue;
    }
    if (source.conflicting) {
      excluded.conflicting += 1;
      continue;
    }
    if (source.freshness === 'stale' || source.freshness === 'unknown') {
      excluded.stale += 1;
      continue;
    }
    authorized.push(source);
  }
  authorized.sort((a, b) => a.ref.localeCompare(b.ref) || a.version - b.version);
  const limitationCodes: string[] = [];
  if (excluded.cross_tenant > 0) limitationCodes.push('cross_tenant_sources_excluded');
  if (excluded.unauthorized > 0) limitationCodes.push('unauthorized_sources_excluded');
  if (excluded.stale > 0) limitationCodes.push('stale_sources_excluded');
  if (excluded.conflicting > 0) limitationCodes.push('conflicting_sources');
  const abstentionCode =
    authorized.length === 0
      ? excluded.conflicting > 0
        ? 'conflicting_sources'
        : excluded.stale > 0
          ? 'stale_or_unknown_sources'
          : excluded.unauthorized > 0 || excluded.cross_tenant > 0
            ? 'no_authorized_sources'
            : 'insufficient_evidence'
      : null;
  if (abstentionCode && !limitationCodes.includes(abstentionCode))
    limitationCodes.push(abstentionCode);
  const citations = Object.freeze(
    authorized.map((source) => {
      const ref = sourceRef(source.ref);
      const version = positive(source.version, 'source.version');
      return Object.freeze({
        ref,
        version,
        digest: digest(source.digest, 'source.digest'),
        kind: text(source.kind, 'source.kind', 64),
        citationRef: ref + '#v' + version,
      });
    }),
  );
  const facts = abstentionCode
    ? Object.freeze([])
    : Object.freeze(
        authorized.flatMap((source, index) =>
          source.facts.map((fact) =>
            Object.freeze({
              label: text(fact.label, 'fact.label', 128),
              value: text(fact.value, 'fact.value', 1000),
              citationRef: citations[index]!.citationRef,
            }),
          ),
        ),
      );
  const inferences = Object.freeze(
    abstentionCode
      ? []
      : [
          'Authorized facts may support investigation; they do not establish approval, attestation, certification, or legal conclusion.',
        ],
  );
  const suggestions = Object.freeze(
    abstentionCode
      ? ['Restore current authorized governed evidence before relying on generated assistance.']
      : ['Open the cited exact records and use only their governed safe next actions.'],
  );
  const auditMetadata = Object.freeze({
    id: text(input.id, 'id'),
    tenantId,
    principalId: text(input.principalId, 'principalId'),
    purpose: text(input.purpose, 'purpose', 128),
    queryClassification: text(input.queryClassification, 'queryClassification', 128),
    policyDecisionId: text(input.policyDecisionId, 'policyDecisionId'),
    retrievalSourceRefs: citations.map((item) => item.citationRef),
    retrievalSourceDigests: citations.map((item) => item.digest),
    excludedSourceReasonCounts: Object.freeze(excluded),
    citationRefs: citations.map((item) => item.citationRef),
    limitationCodes: Object.freeze([...limitationCodes].sort()),
    abstentionCode,
    createdAt: epoch(input.createdAt, 'createdAt'),
  });
  const responseCore = {
    label: 'generated_assistance' as const,
    authority: 'non_authoritative' as const,
    facts,
    inferences,
    suggestions,
    citations,
    limitationCodes: Object.freeze([...limitationCodes].sort()),
    abstentionCode,
  };
  return Object.freeze({
    id: text(input.id, 'id'),
    tenantId,
    ...responseCore,
    auditMetadata,
    responseDigest: governedDigest(responseCore),
  });
}
