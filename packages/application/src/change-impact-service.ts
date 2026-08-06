import {
  assertDistinctGovernedAuthority,
  assertGovernedTenant,
  canonicalGovernedJson,
  governedDigest,
} from '@trustcircle/domain';

export type GovernedDependencyKind =
  | 'obligation'
  | 'control'
  | 'policy'
  | 'mapping'
  | 'ownership'
  | 'threshold'
  | 'asset'
  | 'review'
  | 'evidence_request'
  | 'register_record'
  | 'monitoring_case'
  | 'score'
  | 'projection';
export interface GovernedDependencyNode {
  readonly ref: string;
  readonly tenantId: string;
  readonly kind: GovernedDependencyKind;
  readonly version: number;
  readonly dependsOn: readonly string[];
  readonly compatibilityRisk?: string;
}
export type ImpactPreviewStatus =
  'ready' | 'partial' | 'expired' | 'source_drift' | 'proposal_drift';
export interface ImpactPreview {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalType: string;
  readonly proposalRef: string;
  readonly proposalDigest: string;
  readonly requestedBy: string;
  readonly sourceVersionSet: Readonly<Record<string, number>>;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly affectedAssetRefs: readonly string[];
  readonly reviewRefs: readonly string[];
  readonly evidenceRequestRefs: readonly string[];
  readonly registerRecordRefs: readonly string[];
  readonly monitoringCaseRefs: readonly string[];
  readonly scoreRefs: readonly string[];
  readonly projectionRefs: readonly string[];
  readonly compatibilityRisks: readonly string[];
  readonly unknownDependencies: readonly string[];
  readonly sourceDigest: string;
  readonly status: ImpactPreviewStatus;
}
export interface CreateImpactPreviewInput {
  readonly id: string;
  readonly tenantId: string;
  readonly proposalType: string;
  readonly proposalRef: string;
  readonly proposalDigest: string;
  readonly requestedBy: string;
  readonly graph: readonly GovernedDependencyNode[];
  readonly generatedAt: number;
  readonly expiresAt: number;
}
export interface ImpactPreviewValidation {
  readonly status: 'valid' | 'expired' | 'source_drift' | 'proposal_drift' | 'partial';
  readonly changedSourceRefs: readonly string[];
}
export type PublicationRebuildStatus = 'pending' | 'running' | 'completed' | 'failed';
export interface ChangePublication {
  readonly id: string;
  readonly tenantId: string;
  readonly previewId: string;
  readonly proposalDigest: string;
  readonly approvedBy: string;
  readonly approvalDecisionId: string;
  readonly publishedAt: number;
  readonly targetVersion: number;
  readonly invalidationCursor: string;
  readonly affectedProjectionRefs: readonly string[];
  readonly rebuildStatus: PublicationRebuildStatus;
  readonly rebuildProgress: number;
  readonly rollbackPlanRef: string;
  readonly rollbackStatus: 'available' | 'requested' | 'completed' | 'failed';
  readonly failureRefs: readonly string[];
  readonly updatedAt: number;
}
export interface GovernedRollback {
  readonly id: string;
  readonly tenantId: string;
  readonly rollbackOfPublicationId: string;
  readonly authorizedBy: string;
  readonly authorityDecisionId: string;
  readonly targetVersion: number;
  readonly evidenceRef: string;
  readonly status: 'planned';
  readonly createdAt: number;
  readonly canonicalDigest: string;
}
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
function digest(value: string, field: string): string {
  const checked = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(checked)) throw new TypeError(field + ' must be SHA-256.');
  return checked;
}
function ref(value: string, field: string): string {
  const checked = text(value, field);
  if (!checked.startsWith('/') || checked.startsWith('//') || checked.length > 512)
    throw new TypeError(field + ' must be a governed relative reference.');
  return checked;
}
function immutable<T>(value: T): T {
  return Object.freeze(JSON.parse(canonicalGovernedJson(value)) as T);
}
function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((a, b) => a.localeCompare(b)));
}

export function createImpactPreview(input: CreateImpactPreviewInput): ImpactPreview {
  const tenantId = text(input.tenantId, 'tenantId');
  const generatedAt = epoch(input.generatedAt, 'generatedAt');
  const expiresAt = epoch(input.expiresAt, 'expiresAt');
  if (expiresAt <= generatedAt)
    throw new RangeError('Impact preview expiry must follow generation.');
  const nodes = new Map<string, GovernedDependencyNode>();
  for (const candidate of input.graph) {
    assertGovernedTenant(candidate.tenantId, tenantId);
    const candidateRef = ref(candidate.ref, 'node.ref');
    if (nodes.has(candidateRef)) throw new TypeError('Dependency graph references must be unique.');
    nodes.set(
      candidateRef,
      Object.freeze({
        ref: candidateRef,
        tenantId,
        kind: candidate.kind,
        version: positive(candidate.version, 'node.version'),
        dependsOn: sorted(
          candidate.dependsOn.map((dependency) => ref(dependency, 'node.dependsOn')),
        ),
        ...(candidate.compatibilityRisk
          ? { compatibilityRisk: text(candidate.compatibilityRisk, 'compatibilityRisk') }
          : {}),
      }),
    );
  }
  const proposalRef = ref(input.proposalRef, 'proposalRef');
  if (!nodes.has(proposalRef))
    throw new TypeError('The proposal reference is absent from the dependency graph.');
  const reverse = new Map<string, string[]>();
  for (const node of nodes.values())
    for (const dependency of node.dependsOn) {
      const dependents = reverse.get(dependency) ?? [];
      dependents.push(node.ref);
      reverse.set(dependency, dependents);
    }
  const visited = new Set<string>([proposalRef]);
  const queue = [proposalRef];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of [...(reverse.get(current) ?? [])].sort()) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      queue.push(dependent);
    }
  }
  const affected = [...visited]
    .filter((candidate) => candidate !== proposalRef)
    .map((candidate) => nodes.get(candidate)!);
  const unknown = new Set<string>();
  for (const candidateRef of visited)
    for (const dependency of nodes.get(candidateRef)!.dependsOn)
      if (!nodes.has(dependency)) unknown.add(dependency);
  const versionEntries = [...visited]
    .sort((a, b) => a.localeCompare(b))
    .map((candidateRef) => [candidateRef, nodes.get(candidateRef)!.version] as const);
  const sourceVersionSet = immutable(Object.fromEntries(versionEntries));
  const byKind = (kind: GovernedDependencyKind) =>
    sorted(affected.filter((node) => node.kind === kind).map((node) => node.ref));
  const compatibilityRisks = sorted(
    affected.flatMap((node) => (node.compatibilityRisk ? [node.compatibilityRisk] : [])),
  );
  const unknownDependencies = sorted(unknown);
  const sourceDigest = governedDigest({
    tenantId,
    proposalRef,
    sourceVersionSet,
    edges: [...visited].sort().map((candidateRef) => ({
      ref: candidateRef,
      dependsOn: nodes.get(candidateRef)!.dependsOn,
    })),
  });
  return Object.freeze({
    id: text(input.id, 'id'),
    tenantId,
    proposalType: text(input.proposalType, 'proposalType'),
    proposalRef,
    proposalDigest: digest(input.proposalDigest, 'proposalDigest'),
    requestedBy: text(input.requestedBy, 'requestedBy'),
    sourceVersionSet,
    generatedAt,
    expiresAt,
    affectedAssetRefs: byKind('asset'),
    reviewRefs: byKind('review'),
    evidenceRequestRefs: byKind('evidence_request'),
    registerRecordRefs: byKind('register_record'),
    monitoringCaseRefs: byKind('monitoring_case'),
    scoreRefs: byKind('score'),
    projectionRefs: byKind('projection'),
    compatibilityRisks,
    unknownDependencies,
    sourceDigest,
    status: unknownDependencies.length > 0 ? 'partial' : 'ready',
  });
}
export function validateImpactPreview(
  preview: ImpactPreview,
  currentVersionSet: Readonly<Record<string, number>>,
  proposalDigestInput: string,
  nowInput: number,
): ImpactPreviewValidation {
  const now = epoch(nowInput, 'now');
  if (now >= preview.expiresAt)
    return Object.freeze({ status: 'expired', changedSourceRefs: Object.freeze([]) });
  if (digest(proposalDigestInput, 'proposalDigest') !== preview.proposalDigest)
    return Object.freeze({
      status: 'proposal_drift',
      changedSourceRefs: Object.freeze([preview.proposalRef]),
    });
  const keys = new Set([
    ...Object.keys(preview.sourceVersionSet),
    ...Object.keys(currentVersionSet),
  ]);
  const changed = sorted(
    [...keys].filter((key) => preview.sourceVersionSet[key] !== currentVersionSet[key]),
  );
  if (changed.length > 0)
    return Object.freeze({ status: 'source_drift', changedSourceRefs: changed });
  if (preview.status !== 'ready')
    return Object.freeze({ status: 'partial', changedSourceRefs: preview.unknownDependencies });
  return Object.freeze({ status: 'valid', changedSourceRefs: Object.freeze([]) });
}
export function publishGovernedChange(input: {
  readonly id: string;
  readonly preview: ImpactPreview;
  readonly tenantId: string;
  readonly approvedBy: string;
  readonly approvalDecisionId: string;
  readonly targetVersion: number;
  readonly currentSourceVersionSet: Readonly<Record<string, number>>;
  readonly proposalDigest: string;
  readonly publishedAt: number;
  readonly rollbackPlanRef: string;
}): ChangePublication {
  assertGovernedTenant(input.preview.tenantId, input.tenantId);
  assertDistinctGovernedAuthority(input.preview.requestedBy, input.approvedBy);
  const publishedAt = epoch(input.publishedAt, 'publishedAt');
  const validation = validateImpactPreview(
    input.preview,
    input.currentSourceVersionSet,
    input.proposalDigest,
    publishedAt,
  );
  if (validation.status !== 'valid')
    throw new TypeError(
      'Impact preview publication authority is invalid: ' + validation.status + '.',
    );
  const targetVersion = positive(input.targetVersion, 'targetVersion');
  const proposalVersion = input.preview.sourceVersionSet[input.preview.proposalRef];
  if (proposalVersion !== undefined && targetVersion <= proposalVersion)
    throw new RangeError('A publication target version must advance the proposal version.');
  const content = {
    id: text(input.id, 'id'),
    tenantId: input.tenantId,
    previewId: input.preview.id,
    proposalDigest: input.preview.proposalDigest,
    approvedBy: text(input.approvedBy, 'approvedBy'),
    approvalDecisionId: text(input.approvalDecisionId, 'approvalDecisionId'),
    publishedAt,
    targetVersion,
    affectedProjectionRefs: input.preview.projectionRefs,
    rollbackPlanRef: ref(input.rollbackPlanRef, 'rollbackPlanRef'),
  };
  return Object.freeze({
    ...content,
    invalidationCursor: governedDigest(content),
    rebuildStatus: 'pending',
    rebuildProgress: 0,
    rollbackStatus: 'available',
    failureRefs: Object.freeze([]),
    updatedAt: publishedAt,
  });
}
export function updatePublicationRebuild(
  publication: ChangePublication,
  update: {
    readonly status: PublicationRebuildStatus;
    readonly progress: number;
    readonly failureRef?: string;
    readonly updatedAt: number;
  },
): ChangePublication {
  if (!Number.isFinite(update.progress) || update.progress < 0 || update.progress > 1)
    throw new RangeError('Rebuild progress must be between zero and one.');
  if (update.status === 'completed' && update.progress !== 1)
    throw new TypeError('A completed rebuild requires complete progress.');
  if (update.status === 'failed' && !update.failureRef)
    throw new TypeError('A failed rebuild requires retained failure evidence.');
  const failureRefs = update.failureRef
    ? sorted([...publication.failureRefs, ref(update.failureRef, 'failureRef')])
    : publication.failureRefs;
  return Object.freeze({
    ...publication,
    rebuildStatus: update.status,
    rebuildProgress: update.progress,
    failureRefs,
    updatedAt: epoch(update.updatedAt, 'updatedAt'),
  });
}
export function createGovernedRollback(input: {
  readonly id: string;
  readonly publication: ChangePublication;
  readonly tenantId: string;
  readonly authorizedBy: string;
  readonly authorityDecisionId: string;
  readonly targetVersion: number;
  readonly evidenceRef: string;
  readonly createdAt: number;
}): GovernedRollback {
  assertGovernedTenant(input.publication.tenantId, input.tenantId);
  const targetVersion = positive(input.targetVersion, 'targetVersion');
  if (targetVersion <= input.publication.targetVersion)
    throw new RangeError('Rollback is a new version and cannot rewrite publication history.');
  const content = {
    id: text(input.id, 'id'),
    tenantId: input.tenantId,
    rollbackOfPublicationId: input.publication.id,
    authorizedBy: text(input.authorizedBy, 'authorizedBy'),
    authorityDecisionId: text(input.authorityDecisionId, 'authorityDecisionId'),
    targetVersion,
    evidenceRef: ref(input.evidenceRef, 'evidenceRef'),
    status: 'planned' as const,
    createdAt: epoch(input.createdAt, 'createdAt'),
  };
  return Object.freeze({ ...content, canonicalDigest: governedDigest(content) });
}
