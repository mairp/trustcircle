import { assertGovernedTenant, canonicalGovernedJson, governedDigest } from '@trustcircle/domain';

export interface ReviewOutcome {
  readonly key: string;
  readonly type: string;
  readonly status: string;
  readonly recordRef: string;
}

export interface ReviewSnapshotSource {
  readonly tenantId: string;
  readonly reviewId: string;
  readonly reviewVersion: number;
  readonly completed: boolean;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly registryVersions: readonly string[];
  readonly policyVersions: readonly string[];
  readonly sourceRevisionSet: readonly string[];
  readonly outcomes: readonly ReviewOutcome[];
  readonly evidenceRefs: readonly string[];
  readonly decisionRefs: readonly string[];
  readonly authorPrincipalIds: readonly string[];
}

export interface SignedReviewSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly reviewId: string;
  readonly reviewVersion: number;
  readonly snapshotSchemaVersion: number;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly scopeDigest: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly registryVersions: readonly string[];
  readonly policyVersions: readonly string[];
  readonly sourceRevisionSet: readonly string[];
  readonly outcomes: readonly ReviewOutcome[];
  readonly evidenceRefs: readonly string[];
  readonly decisionRefs: readonly string[];
  readonly canonicalDigest: string;
  readonly signerPrincipalId: string;
  readonly signerRole: string;
  readonly authorityDecisionId: string;
  readonly signedAt: number;
  readonly signatureAlgorithm: string;
  readonly signatureKeyId: string;
  readonly signature: string;
  readonly correctionNoticeRefs: readonly string[];
}

export interface CreateSignedReviewSnapshotInput {
  readonly snapshotId: string;
  readonly source: ReviewSnapshotSource;
  readonly signerPrincipalId: string;
  readonly signerRole: string;
  readonly authorityDecisionId: string;
  readonly requireIndependentSigner: boolean;
  readonly signedAt: number;
  readonly signatureAlgorithm: string;
  readonly signatureKeyId: string;
  readonly snapshotSchemaVersion?: number;
  readonly signDigest: (digest: string) => string;
}

export interface ReviewSnapshotCorrection {
  readonly id: string;
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly originalDigest: string;
  readonly reason: string;
  readonly actorPrincipalId: string;
  readonly linkedAt: number;
  readonly canonicalDigest: string;
}

export interface CorrectReviewSnapshotInput {
  readonly snapshot: SignedReviewSnapshot;
  readonly correctionRecordId: string;
  readonly reason: string;
  readonly actorPrincipalId: string;
  readonly linkedAt: number;
}

export type SnapshotCompatibility = 'compatible' | 'incompatible';

export interface ReviewSnapshotComparison {
  readonly id: string;
  readonly tenantId: string;
  readonly baselineSnapshotId: string;
  readonly targetSnapshotId: string;
  readonly compatibility: SnapshotCompatibility;
  readonly incompatibilityReasons: readonly string[];
  readonly addedRefs: readonly string[];
  readonly removedRefs: readonly string[];
  readonly improvedRefs: readonly string[];
  readonly regressedRefs: readonly string[];
  readonly unchangedRefs: readonly string[];
  readonly unknownRefs: readonly string[];
  readonly generatedAt: number;
  readonly generatedByPrincipalId: string;
  readonly sourceDigest: string;
}

export interface CompareReviewSnapshotsInput {
  readonly comparisonId: string;
  readonly tenantId: string;
  readonly baseline: SignedReviewSnapshot;
  readonly target: SignedReviewSnapshot;
  readonly generatedAt: number;
  readonly generatedByPrincipalId: string;
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(field + ' is required.');
}

function requireEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(field + ' must be a non-negative epoch integer.');
  }
}

function immutableClone<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalGovernedJson(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

function digestContent(snapshot: SignedReviewSnapshot): Readonly<Record<string, unknown>> {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    reviewId: snapshot.reviewId,
    reviewVersion: snapshot.reviewVersion,
    snapshotSchemaVersion: snapshot.snapshotSchemaVersion,
    scope: snapshot.scope,
    scopeDigest: snapshot.scopeDigest,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    registryVersions: snapshot.registryVersions,
    policyVersions: snapshot.policyVersions,
    sourceRevisionSet: snapshot.sourceRevisionSet,
    outcomes: snapshot.outcomes,
    evidenceRefs: snapshot.evidenceRefs,
    decisionRefs: snapshot.decisionRefs,
    signerPrincipalId: snapshot.signerPrincipalId,
    signerRole: snapshot.signerRole,
    authorityDecisionId: snapshot.authorityDecisionId,
    signedAt: snapshot.signedAt,
    signatureAlgorithm: snapshot.signatureAlgorithm,
    signatureKeyId: snapshot.signatureKeyId,
  };
}

export function createSignedReviewSnapshot(
  input: CreateSignedReviewSnapshotInput,
): SignedReviewSnapshot {
  requireText(input.snapshotId, 'snapshotId');
  requireText(input.signerPrincipalId, 'signerPrincipalId');
  requireText(input.signerRole, 'signerRole');
  if (input.authorityDecisionId.trim().length === 0) {
    throw new TypeError('A current signing authority decision is required.');
  }
  requireText(input.signatureAlgorithm, 'signatureAlgorithm');
  requireText(input.signatureKeyId, 'signatureKeyId');
  requireEpoch(input.signedAt, 'signedAt');
  if (!input.source.completed) throw new TypeError('Only a completed review can be signed.');
  if (
    !Number.isSafeInteger(input.source.reviewVersion) ||
    input.source.reviewVersion < 1 ||
    input.source.periodEnd < input.source.periodStart
  ) {
    throw new TypeError('Review version and period must be valid before signing.');
  }
  if (
    input.requireIndependentSigner &&
    input.source.authorPrincipalIds.includes(input.signerPrincipalId)
  ) {
    throw new TypeError('An independent signer is required for this review.');
  }

  const source = immutableClone(input.source);
  const unsigned = {
    id: input.snapshotId,
    tenantId: source.tenantId,
    reviewId: source.reviewId,
    reviewVersion: source.reviewVersion,
    snapshotSchemaVersion: input.snapshotSchemaVersion ?? 1,
    scope: source.scope,
    scopeDigest: governedDigest(source.scope),
    periodStart: source.periodStart,
    periodEnd: source.periodEnd,
    registryVersions: source.registryVersions,
    policyVersions: source.policyVersions,
    sourceRevisionSet: source.sourceRevisionSet,
    outcomes: source.outcomes,
    evidenceRefs: source.evidenceRefs,
    decisionRefs: source.decisionRefs,
    signerPrincipalId: input.signerPrincipalId,
    signerRole: input.signerRole,
    authorityDecisionId: input.authorityDecisionId,
    signedAt: input.signedAt,
    signatureAlgorithm: input.signatureAlgorithm,
    signatureKeyId: input.signatureKeyId,
  } as const;
  const canonicalDigest = governedDigest(unsigned);
  const signature = input.signDigest(canonicalDigest);
  requireText(signature, 'signature');
  return deepFreeze({
    ...unsigned,
    canonicalDigest,
    signature,
    correctionNoticeRefs: [],
  });
}

export function verifyReviewSnapshotDigest(snapshot: SignedReviewSnapshot): boolean {
  if (
    snapshot.signature.trim().length === 0 ||
    snapshot.canonicalDigest.length !== 64 ||
    snapshot.scopeDigest !== governedDigest(snapshot.scope)
  ) {
    return false;
  }
  return governedDigest(digestContent(snapshot)) === snapshot.canonicalDigest;
}

export function correctReviewSnapshot(input: CorrectReviewSnapshotInput): ReviewSnapshotCorrection {
  if (!verifyReviewSnapshotDigest(input.snapshot)) {
    throw new TypeError('The signed review snapshot failed integrity verification.');
  }
  requireText(input.correctionRecordId, 'correctionRecordId');
  requireText(input.reason, 'reason');
  requireText(input.actorPrincipalId, 'actorPrincipalId');
  requireEpoch(input.linkedAt, 'linkedAt');
  const content = {
    id: input.correctionRecordId,
    snapshotId: input.snapshot.id,
    tenantId: input.snapshot.tenantId,
    originalDigest: input.snapshot.canonicalDigest,
    reason: input.reason.trim(),
    actorPrincipalId: input.actorPrincipalId,
    linkedAt: input.linkedAt,
  };
  return deepFreeze({ ...content, canonicalDigest: governedDigest(content) });
}

const RANKS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  control: { fail: 0, unknown: 1, partial: 2, pass: 3 },
  risk: { critical: 0, high: 1, medium: 2, low: 3, none: 4 },
  gap: { open: 0, remediation: 1, pending_verification: 2, verified: 3, closed: 4 },
  exception: { rejected: 0, expired: 1, approved: 2, closed: 3 },
};

function rank(outcome: ReviewOutcome): number | undefined {
  return RANKS[outcome.type]?.[outcome.status];
}

function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function incompatibilities(
  baseline: SignedReviewSnapshot,
  target: SignedReviewSnapshot,
): readonly string[] {
  const reasons: string[] = [];
  if (baseline.snapshotSchemaVersion !== target.snapshotSchemaVersion) {
    reasons.push('snapshot_schema_changed');
  }
  if (baseline.scopeDigest !== target.scopeDigest) reasons.push('scope_changed');
  if (
    canonicalGovernedJson(baseline.registryVersions) !==
    canonicalGovernedJson(target.registryVersions)
  ) {
    reasons.push('registry_versions_changed');
  }
  return sorted(reasons);
}

export function compareReviewSnapshots(
  input: CompareReviewSnapshotsInput,
): ReviewSnapshotComparison {
  assertGovernedTenant(input.baseline.tenantId, input.tenantId);
  assertGovernedTenant(input.target.tenantId, input.tenantId);
  if (!verifyReviewSnapshotDigest(input.baseline) || !verifyReviewSnapshotDigest(input.target)) {
    throw new TypeError('Both review snapshots must be signed and integrity-valid.');
  }
  requireText(input.comparisonId, 'comparisonId');
  requireText(input.generatedByPrincipalId, 'generatedByPrincipalId');
  requireEpoch(input.generatedAt, 'generatedAt');

  const reasons = incompatibilities(input.baseline, input.target);
  const compatibility: SnapshotCompatibility = reasons.length === 0 ? 'compatible' : 'incompatible';
  const added: string[] = [];
  const removed: string[] = [];
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  const unknown: string[] = [];

  if (compatibility === 'compatible') {
    const baseline = new Map(input.baseline.outcomes.map((outcome) => [outcome.key, outcome]));
    const target = new Map(input.target.outcomes.map((outcome) => [outcome.key, outcome]));
    for (const [key, outcome] of target) {
      const prior = baseline.get(key);
      if (!prior) {
        added.push(outcome.recordRef);
        if (rank(outcome) === undefined || outcome.status === 'unknown') {
          unknown.push(outcome.recordRef);
        }
        continue;
      }
      if (
        prior.type === outcome.type &&
        prior.status === outcome.status &&
        prior.recordRef === outcome.recordRef
      ) {
        unchanged.push(outcome.recordRef);
        continue;
      }
      const priorRank = rank(prior);
      const targetRank = rank(outcome);
      if (priorRank === undefined || targetRank === undefined || prior.type !== outcome.type) {
        unknown.push(outcome.recordRef);
      } else if (targetRank > priorRank) {
        improved.push(outcome.recordRef);
      } else if (targetRank < priorRank) {
        regressed.push(outcome.recordRef);
      } else {
        unchanged.push(outcome.recordRef);
      }
    }
    for (const [key, outcome] of baseline) {
      if (!target.has(key)) removed.push(outcome.recordRef);
    }
  }

  const content = {
    id: input.comparisonId,
    tenantId: input.tenantId,
    baselineSnapshotId: input.baseline.id,
    targetSnapshotId: input.target.id,
    compatibility,
    incompatibilityReasons: reasons,
    addedRefs: sorted(added),
    removedRefs: sorted(removed),
    improvedRefs: sorted(improved),
    regressedRefs: sorted(regressed),
    unchangedRefs: sorted(unchanged),
    unknownRefs: sorted(unknown),
    generatedAt: input.generatedAt,
    generatedByPrincipalId: input.generatedByPrincipalId,
  };
  return deepFreeze({
    ...content,
    sourceDigest: governedDigest({
      baselineDigest: input.baseline.canonicalDigest,
      targetDigest: input.target.canonicalDigest,
      comparison: content,
    }),
  });
}
