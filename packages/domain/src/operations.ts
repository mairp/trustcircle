import { createHash } from 'node:crypto';

export const ATTENTION_DOMAINS = [
  'decision',
  'integrity',
  'inventory',
  'source',
  'controller',
  'compliance',
  'evidence',
  'connector',
  'runtime',
  'coverage',
] as const;
export type AttentionDomain = (typeof ATTENTION_DOMAINS)[number];

export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type AttentionImpact = 'blocking' | 'material' | 'limited' | 'unknown';
export type AttentionTimePosture = 'breached' | 'imminent' | 'due' | 'none' | 'unknown';
export type AttentionOwnerPosture = 'assigned_to_me' | 'assigned' | 'unowned' | 'unknown';
export type AttentionFreshness = 'current' | 'stale' | 'degraded' | 'unknown';
export type AttentionReadQuality =
  'current' | 'stale' | 'partial' | 'degraded' | 'unavailable' | 'unknown' | 'verified_empty';

export interface AttentionSourceReference {
  readonly tenantId: string;
  readonly domain: AttentionDomain;
  readonly recordType: string;
  readonly recordId: string;
  readonly recordVersion?: string;
  readonly governedProblemKey?: string;
  readonly href: `/v1/${string}`;
  readonly observedAt: number;
  readonly sourceOwnerId?: string;
  readonly resolved: boolean | 'unknown';
}

export interface AttentionSafeNextAction {
  readonly label: string;
  readonly href?: `/v1/${string}`;
}

export interface AttentionCandidate {
  readonly tenantId: string;
  readonly source: AttentionSourceReference;
  readonly title: string;
  readonly severity: AttentionSeverity;
  readonly impact: AttentionImpact;
  readonly timePosture: AttentionTimePosture;
  readonly ownerPosture: AttentionOwnerPosture;
  readonly freshness: AttentionFreshness;
  readonly confidence: number;
  readonly dependencyCount: number;
  readonly actionable: boolean;
  readonly safeNextAction: AttentionSafeNextAction;
  readonly dueAt?: number;
  readonly rankingFacts: readonly string[];
}

export interface RankingFactor {
  readonly code: string;
  readonly label: string;
  readonly value: string | number | boolean;
  readonly contribution: number;
  readonly provenance: string;
}

export interface RankingExplanation {
  readonly version: 'attention-ranking/v1';
  readonly evaluatedAt: number;
  readonly vector: readonly number[];
  readonly factors: readonly RankingFactor[];
  readonly displayScore: number;
  readonly tieBreaker: string;
}

export interface AttentionItem {
  readonly id: string;
  readonly tenantId: string;
  readonly domain: AttentionDomain;
  readonly title: string;
  readonly sources: readonly AttentionSourceReference[];
  readonly severity: AttentionSeverity;
  readonly impact: AttentionImpact;
  readonly timePosture: AttentionTimePosture;
  readonly ownerPosture: AttentionOwnerPosture;
  readonly freshness: AttentionFreshness;
  readonly confidence: number;
  readonly dependencyCount: number;
  readonly actionable: boolean;
  readonly ranking: RankingExplanation;
  readonly observedAt: number;
  readonly dueAt?: number;
  readonly safeNextAction: AttentionSafeNextAction;
  readonly caseId?: string;
}

export interface AttentionCoverage {
  readonly domain: AttentionDomain;
  readonly quality: AttentionReadQuality;
  readonly observedAt?: number;
  readonly candidateCount?: number;
  readonly sourceCursor?: string;
  readonly failureCode?: string;
  readonly safeNextAction?: string;
}

const severityRank: Readonly<Record<AttentionSeverity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};
const impactRank: Readonly<Record<AttentionImpact, number>> = {
  blocking: 3,
  material: 2,
  limited: 1,
  unknown: 0,
};
const timeRank: Readonly<Record<AttentionTimePosture, number>> = {
  breached: 4,
  imminent: 3,
  due: 2,
  unknown: 1,
  none: 0,
};
const ownerRank: Readonly<Record<AttentionOwnerPosture, number>> = {
  unowned: 3,
  unknown: 2,
  assigned_to_me: 1,
  assigned: 0,
};
const freshnessRank: Readonly<Record<AttentionFreshness, number>> = {
  degraded: 3,
  stale: 2,
  unknown: 1,
  current: 0,
};

function assertCandidate(candidate: AttentionCandidate): void {
  if (candidate.tenantId !== candidate.source.tenantId) {
    throw new TypeError('attention candidate and source tenant must match');
  }
  if (candidate.title.trim().length === 0) throw new TypeError('attention title is required');
  if (
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    throw new RangeError('attention confidence must be between 0 and 1');
  }
  if (!Number.isInteger(candidate.dependencyCount) || candidate.dependencyCount < 0) {
    throw new RangeError('dependencyCount must be a non-negative integer');
  }
  if (!Number.isFinite(candidate.source.observedAt) || candidate.source.observedAt < 0) {
    throw new RangeError('source observation time must be a non-negative epoch millisecond');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function correlationKey(candidate: AttentionCandidate): string {
  const source = candidate.source;
  const problem = source.governedProblemKey?.trim();
  return problem
    ? `${candidate.tenantId}:problem:${problem}`
    : `${candidate.tenantId}:source:${source.domain}:${source.recordType}:${source.recordId}`;
}

function worst<T extends string>(values: readonly T[], rank: Readonly<Record<T, number>>): T {
  const first = values[0];
  if (first === undefined) throw new TypeError('cannot select from an empty value set');
  return values.reduce(
    (selected, value) => (rank[value] > rank[selected] ? value : selected),
    first,
  );
}

function rankingFor(input: {
  readonly severity: AttentionSeverity;
  readonly impact: AttentionImpact;
  readonly timePosture: AttentionTimePosture;
  readonly ownerPosture: AttentionOwnerPosture;
  readonly freshness: AttentionFreshness;
  readonly dependencyCount: number;
  readonly actionable: boolean;
  readonly observedAt: number;
  readonly evaluatedAt: number;
  readonly tieBreaker: string;
}): RankingExplanation {
  const ageHours = Math.min(
    100_000,
    Math.floor(Math.max(0, input.evaluatedAt - input.observedAt) / 3_600_000),
  );
  const vector = [
    impactRank[input.impact],
    severityRank[input.severity],
    timeRank[input.timePosture],
    ownerRank[input.ownerPosture],
    Math.min(100_000, input.dependencyCount),
    freshnessRank[input.freshness],
    input.actionable ? 1 : 0,
    ageHours,
    input.tieBreaker.charCodeAt(0) || 0,
    input.tieBreaker.length,
  ] as const;
  const factors: readonly RankingFactor[] = [
    {
      code: 'impact',
      label: 'Impact',
      value: input.impact,
      contribution: vector[0],
      provenance: 'authoritative source adapter',
    },
    {
      code: 'severity',
      label: 'Severity',
      value: input.severity,
      contribution: vector[1],
      provenance: 'authoritative source adapter',
    },
    {
      code: 'time_pressure',
      label: 'Time pressure',
      value: input.timePosture,
      contribution: vector[2],
      provenance: 'source target and evaluation time',
    },
    {
      code: 'ownership',
      label: 'Ownership',
      value: input.ownerPosture,
      contribution: vector[3],
      provenance: 'source owner posture',
    },
    {
      code: 'dependencies',
      label: 'Affected dependencies',
      value: input.dependencyCount,
      contribution: vector[4],
      provenance: 'source dependency projection',
    },
    {
      code: 'freshness',
      label: 'Freshness',
      value: input.freshness,
      contribution: vector[5],
      provenance: 'source observation quality',
    },
    {
      code: 'actionability',
      label: 'Safe action available',
      value: input.actionable,
      contribution: vector[6],
      provenance: 'authorized source adapter',
    },
    {
      code: 'age_hours',
      label: 'Observation age (hours)',
      value: ageHours,
      contribution: vector[7],
      provenance: 'source observation time',
    },
  ];
  return {
    version: 'attention-ranking/v1',
    evaluatedAt: input.evaluatedAt,
    vector,
    factors,
    displayScore: vector.slice(0, 8).reduce((sum, value) => sum + value, 0),
    tieBreaker: input.tieBreaker,
  };
}

function compareVector(left: AttentionItem, right: AttentionItem): number {
  const size = Math.max(left.ranking.vector.length, right.ranking.vector.length);
  for (let index = 0; index < size; index += 1) {
    const difference = (right.ranking.vector[index] ?? 0) - (left.ranking.vector[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.ranking.tieBreaker.localeCompare(right.ranking.tieBreaker);
}

/** Correlate only proven identities and rank the resulting items deterministically. */
export function rankAttentionCandidates(
  candidates: readonly AttentionCandidate[],
  evaluatedAt: number,
): readonly AttentionItem[] {
  if (!Number.isFinite(evaluatedAt) || evaluatedAt < 0)
    throw new RangeError('evaluatedAt must be valid');
  const groups = new Map<string, AttentionCandidate[]>();
  for (const candidate of candidates) {
    assertCandidate(candidate);
    const key = correlationKey(candidate);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const items: AttentionItem[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group].sort((left, right) => {
      const a = `${left.source.domain}:${left.source.recordType}:${left.source.recordId}`;
      const b = `${right.source.domain}:${right.source.recordType}:${right.source.recordId}`;
      return a.localeCompare(b);
    });
    const first = ordered[0];
    if (first === undefined) continue;
    const sources = ordered.map((candidate) => candidate.source);
    const severity = worst(
      ordered.map((candidate) => candidate.severity),
      severityRank,
    );
    const impact = worst(
      ordered.map((candidate) => candidate.impact),
      impactRank,
    );
    const timePosture = worst(
      ordered.map((candidate) => candidate.timePosture),
      timeRank,
    );
    const ownerPosture = worst(
      ordered.map((candidate) => candidate.ownerPosture),
      ownerRank,
    );
    const freshness = worst(
      ordered.map((candidate) => candidate.freshness),
      freshnessRank,
    );
    const observedAt = Math.min(...sources.map((source) => source.observedAt));
    const dueTimes = ordered.flatMap((candidate) =>
      candidate.dueAt === undefined ? [] : [candidate.dueAt],
    );
    const dueAt = dueTimes.length > 0 ? Math.min(...dueTimes) : undefined;
    const tieBreaker = `${first.source.domain}:${first.source.recordType}:${first.source.recordId}`;
    const dependencyCount = Math.max(...ordered.map((candidate) => candidate.dependencyCount));
    const actionable = ordered.some((candidate) => candidate.actionable);
    const ranking = rankingFor({
      severity,
      impact,
      timePosture,
      ownerPosture,
      freshness,
      dependencyCount,
      actionable,
      observedAt,
      evaluatedAt,
      tieBreaker,
    });
    const base = {
      id: digest(
        `attention-correlation/v1:${key}:${sources.map((source) => `${source.domain}:${source.recordType}:${source.recordId}`).join('|')}`,
      ),
      tenantId: first.tenantId,
      domain: first.source.domain,
      title: first.title,
      sources,
      severity,
      impact,
      timePosture,
      ownerPosture,
      freshness,
      confidence: Math.min(...ordered.map((candidate) => candidate.confidence)),
      dependencyCount,
      actionable,
      ranking,
      observedAt,
      safeNextAction: first.safeNextAction,
    };
    items.push(dueAt === undefined ? base : { ...base, dueAt });
  }
  return items.sort(compareVector);
}

export const CASE_STATUSES = [
  'open',
  'acknowledged',
  'in_progress',
  'awaiting_verification',
  'escalated',
  'resolved',
  'closed',
] as const;
export type OperationalCaseStatus = (typeof CASE_STATUSES)[number];
export type OperationalCasePriority = 'critical' | 'high' | 'medium' | 'low';
export type CaseBreachType = 'unowned' | 'acknowledgement' | 'resolution' | 'verification';

export interface ServiceLevelPolicy {
  readonly id: string;
  readonly version: string;
  readonly priority: OperationalCasePriority;
  readonly acknowledgementMs: number;
  readonly resolutionMs: number;
  readonly verificationMs: number;
  readonly escalationTargetRoles: readonly string[];
  readonly ownerId: string;
}

export interface ClosureVerification {
  readonly verifierId: string;
  readonly verifiedAt: number;
  readonly reason: string;
  readonly sourceVersions: readonly AttentionSourceReference[];
  readonly evidenceReferences: readonly string[];
  readonly closureControlVersion: 'operational-case-closure/v1';
  readonly serviceLevelOutcome:
    | 'met'
    | 'acknowledgement_breached'
    | 'resolution_breached'
    | 'verification_breached'
    | 'multiple_breaches';
}

export interface OperationalCase {
  readonly id: string;
  readonly tenantId: string;
  readonly attentionItemId?: string;
  readonly sourceReferences: readonly AttentionSourceReference[];
  readonly title: string;
  readonly priority: OperationalCasePriority;
  readonly status: OperationalCaseStatus;
  readonly creatorId: string;
  readonly ownerId?: string;
  readonly sourceOwnerIds: readonly string[];
  readonly rationale: string;
  readonly openedAt: number;
  readonly acknowledgedAt?: number;
  readonly acknowledgementTargetAt: number;
  readonly resolutionTargetAt: number;
  readonly verificationTargetAt?: number;
  readonly serviceLevelPolicyId: string;
  readonly serviceLevelPolicyVersion: string;
  readonly escalationLevel: number;
  readonly breachTypes: readonly CaseBreachType[];
  readonly evidenceReferences: readonly string[];
  readonly verification?: ClosureVerification;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateOperationalCaseInput {
  readonly id: string;
  readonly tenantId: string;
  readonly attentionItemId?: string;
  readonly sourceReferences: readonly AttentionSourceReference[];
  readonly title: string;
  readonly priority: OperationalCasePriority;
  readonly creatorId: string;
  readonly ownerId?: string;
  readonly rationale: string;
  readonly policy: ServiceLevelPolicy;
  readonly at: number;
}

function meaningfulReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 8)
    throw new TypeError('a meaningful reason of at least 8 characters is required');
  return value;
}

export function createOperationalCase(input: CreateOperationalCaseInput): OperationalCase {
  if (input.sourceReferences.length === 0)
    throw new TypeError('at least one source reference is required');
  if (input.sourceReferences.some((source) => source.tenantId !== input.tenantId)) {
    throw new TypeError('all case sources must match the case tenant');
  }
  if (input.policy.priority !== input.priority)
    throw new TypeError('service-level policy priority mismatch');
  if (
    input.policy.acknowledgementMs <= 0 ||
    input.policy.resolutionMs < input.policy.acknowledgementMs
  ) {
    throw new RangeError('invalid service-level policy targets');
  }
  const sourceOwnerIds = [
    ...new Set(input.sourceReferences.flatMap((source) => source.sourceOwnerId ?? [])),
  ].sort();
  const common = {
    id: input.id,
    tenantId: input.tenantId,
    sourceReferences: [...input.sourceReferences],
    title: meaningfulReason(input.title),
    priority: input.priority,
    status: 'open' as const,
    creatorId: input.creatorId,
    sourceOwnerIds,
    rationale: meaningfulReason(input.rationale),
    openedAt: input.at,
    acknowledgementTargetAt: input.at + input.policy.acknowledgementMs,
    resolutionTargetAt: input.at + input.policy.resolutionMs,
    serviceLevelPolicyId: input.policy.id,
    serviceLevelPolicyVersion: input.policy.version,
    escalationLevel: 0,
    breachTypes: [] as readonly CaseBreachType[],
    evidenceReferences: [] as readonly string[],
    version: 1,
    createdAt: input.at,
    updatedAt: input.at,
  };
  return {
    ...common,
    ...(input.attentionItemId === undefined ? {} : { attentionItemId: input.attentionItemId }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
  };
}

export interface CaseCommandInput {
  readonly command:
    'assign' | 'acknowledge' | 'progress' | 'submit_verification' | 'verify' | 'close';
  readonly actorId: string;
  readonly reason: string;
  readonly at: number;
  readonly ownerId?: string;
  readonly targetStatus?: 'in_progress';
  readonly evidenceReferences?: readonly string[];
  readonly sourceVersions?: readonly AttentionSourceReference[];
  readonly verifierRoles?: readonly string[];
  readonly independentVerificationRequired?: boolean;
}

function serviceLevelOutcome(
  breaches: readonly CaseBreachType[],
): ClosureVerification['serviceLevelOutcome'] {
  if (breaches.length === 0) return 'met';
  if (breaches.length > 1) return 'multiple_breaches';
  const breach = breaches[0];
  if (breach === 'acknowledgement') return 'acknowledgement_breached';
  if (breach === 'verification') return 'verification_breached';
  return 'resolution_breached';
}

export function applyOperationalCaseCommand(
  current: OperationalCase,
  input: CaseCommandInput,
  verificationMs: number,
): OperationalCase {
  if (current.status === 'closed') throw new TypeError('closed cases are terminal');
  const reason = meaningfulReason(input.reason);
  if (input.command === 'assign') {
    if (!input.ownerId?.trim()) throw new TypeError('ownerId is required for assignment');
    return {
      ...current,
      ownerId: input.ownerId,
      rationale: reason,
      version: current.version + 1,
      updatedAt: input.at,
    };
  }
  if (input.command === 'acknowledge') {
    if (!current.ownerId) throw new TypeError('a case must have an owner before acknowledgement');
    if (current.status !== 'open' && current.status !== 'escalated')
      throw new TypeError('case cannot be acknowledged from its current status');
    return {
      ...current,
      status: 'acknowledged',
      acknowledgedAt: input.at,
      rationale: reason,
      version: current.version + 1,
      updatedAt: input.at,
    };
  }
  if (input.command === 'progress') {
    if (current.status !== 'acknowledged' && current.status !== 'escalated')
      throw new TypeError('case cannot enter progress from its current status');
    return {
      ...current,
      status: 'in_progress',
      rationale: reason,
      version: current.version + 1,
      updatedAt: input.at,
    };
  }
  if (input.command === 'submit_verification') {
    if (current.status !== 'in_progress' && current.status !== 'escalated')
      throw new TypeError('case is not ready for verification');
    const sources = input.sourceVersions ?? [];
    const evidence = input.evidenceReferences ?? [];
    if (sources.length === 0 || sources.some((source) => source.resolved !== true))
      throw new TypeError('current resolved source versions are required');
    if (evidence.length === 0) throw new TypeError('closure evidence references are required');
    return {
      ...current,
      status: 'awaiting_verification',
      sourceReferences: [...sources],
      evidenceReferences: [...new Set([...current.evidenceReferences, ...evidence])],
      verificationTargetAt: input.at + verificationMs,
      rationale: reason,
      version: current.version + 1,
      updatedAt: input.at,
    };
  }
  if (input.command === 'verify') {
    if (current.status !== 'awaiting_verification')
      throw new TypeError('case is not awaiting verification');
    const sources = input.sourceVersions ?? current.sourceReferences;
    const evidence = input.evidenceReferences ?? current.evidenceReferences;
    if (sources.length === 0 || sources.some((source) => source.resolved !== true))
      throw new TypeError('all current sources must be resolved');
    if (evidence.length === 0) throw new TypeError('closure evidence is required');
    const verifierRoles = input.verifierRoles ?? [];
    if (
      !verifierRoles.some(
        (role) =>
          role === 'governance_officer' ||
          role === 'independent_compliance_reviewer' ||
          role === 'authorized_approver',
      )
    ) {
      throw new TypeError('an authorized verifier role is required');
    }
    if (input.independentVerificationRequired !== false) {
      const conflicts = new Set(
        [current.creatorId, current.ownerId, ...current.sourceOwnerIds].filter(
          (value): value is string => Boolean(value),
        ),
      );
      if (conflicts.has(input.actorId)) throw new TypeError('closure verifier must be independent');
    }
    const verification: ClosureVerification = {
      verifierId: input.actorId,
      verifiedAt: input.at,
      reason,
      sourceVersions: [...sources],
      evidenceReferences: [...evidence],
      closureControlVersion: 'operational-case-closure/v1',
      serviceLevelOutcome: serviceLevelOutcome(current.breachTypes),
    };
    return {
      ...current,
      status: 'resolved',
      verification,
      rationale: reason,
      version: current.version + 1,
      updatedAt: input.at,
    };
  }
  if (current.status !== 'resolved' || !current.verification)
    throw new TypeError('verified resolution is required before closure');
  if (current.sourceReferences.some((source) => source.resolved !== true))
    throw new TypeError('source regression blocks closure');
  return {
    ...current,
    status: 'closed',
    rationale: reason,
    version: current.version + 1,
    updatedAt: input.at,
  };
}

export interface EscalationRecord {
  readonly id: string;
  readonly caseId: string;
  readonly tenantId: string;
  readonly policyVersion: string;
  readonly level: number;
  readonly breachType: CaseBreachType;
  readonly targetRole: string;
  readonly openedAt: number;
  readonly status: 'open' | 'acknowledged' | 'resolved';
  readonly idempotencyIdentity: string;
}

export function evaluateOperationalCaseSla(
  current: OperationalCase,
  policy: ServiceLevelPolicy,
  at: number,
): { readonly case: OperationalCase; readonly escalations: readonly EscalationRecord[] } {
  if (current.status === 'closed') return { case: current, escalations: [] };
  const breaches = new Set<CaseBreachType>(current.breachTypes);
  if (!current.ownerId) breaches.add('unowned');
  if (!current.acknowledgedAt && at > current.acknowledgementTargetAt)
    breaches.add('acknowledgement');
  if (current.status !== 'resolved' && at > current.resolutionTargetAt) breaches.add('resolution');
  if (
    current.status === 'awaiting_verification' &&
    current.verificationTargetAt !== undefined &&
    at > current.verificationTargetAt
  )
    breaches.add('verification');
  const newBreaches = [...breaches]
    .filter((breach) => !current.breachTypes.includes(breach))
    .sort();
  if (newBreaches.length === 0) return { case: current, escalations: [] };
  const nextLevel = current.escalationLevel + 1;
  const targetRole =
    policy.escalationTargetRoles[
      Math.min(nextLevel - 1, policy.escalationTargetRoles.length - 1)
    ] ?? 'governance_officer';
  const escalations = newBreaches.map((breach) => {
    const idempotencyIdentity = `${current.id}:${policy.version}:${nextLevel}:${breach}`;
    return {
      id: digest(idempotencyIdentity).slice(0, 32),
      caseId: current.id,
      tenantId: current.tenantId,
      policyVersion: policy.version,
      level: nextLevel,
      breachType: breach,
      targetRole,
      openedAt: at,
      status: 'open' as const,
      idempotencyIdentity,
    };
  });
  return {
    case: {
      ...current,
      status: 'escalated',
      escalationLevel: nextLevel,
      breachTypes: [...breaches].sort(),
      version: current.version + 1,
      updatedAt: at,
    },
    escalations,
  };
}
