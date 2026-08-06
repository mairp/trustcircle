import { createHash } from 'node:crypto';

import { canonicalHash } from './provenance.ts';

export interface EvidencePackageArtifact {
  readonly id: string;
  readonly tenantId: string;
  readonly mediaType: string;
  readonly content: string;
  readonly contentDigest: string;
  readonly classification: string;
  readonly retentionPolicyId: string;
  readonly recordedAt: number;
  readonly derivative: boolean;
  readonly parentDigest: string | null;
  readonly transformationDigest: string | null;
  readonly redactionVerifiedAt: number | null;
  readonly redactionVerifiedBy: string | null;
}

export interface CreateEvidenceOriginalInput {
  readonly id: string;
  readonly tenantId: string;
  readonly mediaType: string;
  readonly content: string;
  readonly classification: string;
  readonly retentionPolicyId: string;
  readonly recordedAt: number;
}

export interface CreateRedactedEvidenceDerivativeInput {
  readonly id: string;
  readonly original: EvidencePackageArtifact;
  readonly tenantId: string;
  readonly content: string;
  readonly rulesetId: string;
  readonly actorPrincipalId: string;
  readonly verifiedAt: number;
  readonly verify: (candidate: {
    readonly original: EvidencePackageArtifact;
    readonly content: string;
    readonly rulesetId: string;
  }) => boolean;
}

export interface SignedEvidencePackage {
  readonly id: string;
  readonly tenantId: string;
  readonly audiencePrincipalIds: readonly string[];
  readonly scope: Readonly<Record<string, unknown>>;
  readonly entries: readonly EvidencePackageArtifact[];
  readonly generatedAt: number;
  readonly generatedByPrincipalId: string;
  readonly schemaVersion: number;
  readonly canonicalDigest: string;
  readonly signatureAlgorithm: string;
  readonly signatureKeyId: string;
  readonly signature: string;
}

export interface BuildSignedEvidencePackageInput {
  readonly id: string;
  readonly tenantId: string;
  readonly audiencePrincipalIds: readonly string[];
  readonly scope: Readonly<Record<string, unknown>>;
  readonly entries: readonly EvidencePackageArtifact[];
  readonly generatedAt: number;
  readonly generatedByPrincipalId: string;
  readonly schemaVersion: number;
  readonly signatureAlgorithm: string;
  readonly signatureKeyId: string;
  readonly signDigest: (digest: string) => string;
}

export type EvidencePackageVerificationFailure =
  | 'cross_tenant'
  | 'audience_not_authorized'
  | 'content_digest_mismatch'
  | 'manifest_digest_mismatch'
  | 'signature_invalid';

export interface EvidencePackageVerification {
  readonly valid: boolean;
  readonly reason: EvidencePackageVerificationFailure | null;
}

function text(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(field + ' is required.');
  }
  return value.trim();
}

function epoch(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(field + ' must be a non-negative epoch integer.');
  }
  return value;
}

function digestContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function freezeArtifact(artifact: EvidencePackageArtifact): EvidencePackageArtifact {
  return Object.freeze({ ...artifact });
}

export function createEvidenceOriginal(
  input: CreateEvidenceOriginalInput,
): EvidencePackageArtifact {
  const content = text(input.content, 'content');
  return freezeArtifact({
    id: text(input.id, 'id'),
    tenantId: text(input.tenantId, 'tenantId'),
    mediaType: text(input.mediaType, 'mediaType'),
    content,
    contentDigest: digestContent(content),
    classification: text(input.classification, 'classification'),
    retentionPolicyId: text(input.retentionPolicyId, 'retentionPolicyId'),
    recordedAt: epoch(input.recordedAt, 'recordedAt'),
    derivative: false,
    parentDigest: null,
    transformationDigest: null,
    redactionVerifiedAt: null,
    redactionVerifiedBy: null,
  });
}

export function createRedactedEvidenceDerivative(
  input: CreateRedactedEvidenceDerivativeInput,
): EvidencePackageArtifact {
  if (input.original.tenantId !== input.tenantId) {
    throw new TypeError('The original is outside the tenant boundary.');
  }
  if (input.original.derivative) {
    throw new TypeError('A redaction derivative must bind directly to a preserved original.');
  }
  const content = text(input.content, 'content');
  const rulesetId = text(input.rulesetId, 'rulesetId');
  const verified = input.verify({ original: input.original, content, rulesetId });
  if (!verified) throw new TypeError('Redaction verification failed; no derivative was created.');
  const verifiedAt = epoch(input.verifiedAt, 'verifiedAt');
  return freezeArtifact({
    id: text(input.id, 'id'),
    tenantId: input.tenantId,
    mediaType: input.original.mediaType,
    content,
    contentDigest: digestContent(content),
    classification: input.original.classification,
    retentionPolicyId: input.original.retentionPolicyId,
    recordedAt: verifiedAt,
    derivative: true,
    parentDigest: input.original.contentDigest,
    transformationDigest: canonicalHash({
      method: 'redaction',
      rulesetId,
      originalDigest: input.original.contentDigest,
    }),
    redactionVerifiedAt: verifiedAt,
    redactionVerifiedBy: text(input.actorPrincipalId, 'actorPrincipalId'),
  });
}

function artifactManifest(artifact: EvidencePackageArtifact): Readonly<Record<string, unknown>> {
  return {
    id: artifact.id,
    tenantId: artifact.tenantId,
    mediaType: artifact.mediaType,
    contentDigest: artifact.contentDigest,
    classification: artifact.classification,
    retentionPolicyId: artifact.retentionPolicyId,
    recordedAt: artifact.recordedAt,
    derivative: artifact.derivative,
    parentDigest: artifact.parentDigest,
    transformationDigest: artifact.transformationDigest,
    redactionVerifiedAt: artifact.redactionVerifiedAt,
    redactionVerifiedBy: artifact.redactionVerifiedBy,
  };
}

function packageManifest(
  value: Omit<SignedEvidencePackage, 'canonicalDigest' | 'signature'>,
): Readonly<Record<string, unknown>> {
  return {
    id: value.id,
    tenantId: value.tenantId,
    audiencePrincipalIds: value.audiencePrincipalIds,
    scope: value.scope,
    entries: value.entries.map(artifactManifest),
    generatedAt: value.generatedAt,
    generatedByPrincipalId: value.generatedByPrincipalId,
    schemaVersion: value.schemaVersion,
    signatureAlgorithm: value.signatureAlgorithm,
    signatureKeyId: value.signatureKeyId,
  };
}

export function buildSignedEvidencePackage(
  input: BuildSignedEvidencePackageInput,
): SignedEvidencePackage {
  const tenantId = text(input.tenantId, 'tenantId');
  if (input.entries.some((entry) => entry.tenantId !== tenantId)) {
    throw new TypeError('Every package entry must belong to the package tenant.');
  }
  if (input.audiencePrincipalIds.length === 0) {
    throw new TypeError('A signed package requires an authorized audience.');
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new RangeError('schemaVersion must be a positive integer.');
  }
  const unsigned = {
    id: text(input.id, 'id'),
    tenantId,
    audiencePrincipalIds: Object.freeze([...new Set(input.audiencePrincipalIds)].sort()),
    scope: Object.freeze(JSON.parse(JSON.stringify(input.scope)) as Record<string, unknown>),
    entries: Object.freeze(
      [...input.entries].sort((a, b) => a.id.localeCompare(b.id)).map(freezeArtifact),
    ),
    generatedAt: epoch(input.generatedAt, 'generatedAt'),
    generatedByPrincipalId: text(input.generatedByPrincipalId, 'generatedByPrincipalId'),
    schemaVersion: input.schemaVersion,
    signatureAlgorithm: text(input.signatureAlgorithm, 'signatureAlgorithm'),
    signatureKeyId: text(input.signatureKeyId, 'signatureKeyId'),
  };
  const canonicalDigest = canonicalHash(packageManifest(unsigned));
  const signature = text(input.signDigest(canonicalDigest), 'signature');
  return Object.freeze({ ...unsigned, canonicalDigest, signature });
}

export function verifySignedEvidencePackage(input: {
  readonly package: SignedEvidencePackage;
  readonly tenantId: string;
  readonly audiencePrincipalId: string;
  readonly verifySignature: (digest: string, signature: string, keyId: string) => boolean;
}): EvidencePackageVerification {
  const bundle = input.package;
  if (bundle.tenantId !== input.tenantId) return { valid: false, reason: 'cross_tenant' };
  if (!bundle.audiencePrincipalIds.includes(input.audiencePrincipalId)) {
    return { valid: false, reason: 'audience_not_authorized' };
  }
  if (bundle.entries.some((entry) => digestContent(entry.content) !== entry.contentDigest)) {
    return { valid: false, reason: 'content_digest_mismatch' };
  }
  const expected = canonicalHash(
    packageManifest({
      id: bundle.id,
      tenantId: bundle.tenantId,
      audiencePrincipalIds: bundle.audiencePrincipalIds,
      scope: bundle.scope,
      entries: bundle.entries,
      generatedAt: bundle.generatedAt,
      generatedByPrincipalId: bundle.generatedByPrincipalId,
      schemaVersion: bundle.schemaVersion,
      signatureAlgorithm: bundle.signatureAlgorithm,
      signatureKeyId: bundle.signatureKeyId,
    }),
  );
  if (expected !== bundle.canonicalDigest) {
    return { valid: false, reason: 'manifest_digest_mismatch' };
  }
  if (!input.verifySignature(expected, bundle.signature, bundle.signatureKeyId)) {
    return { valid: false, reason: 'signature_invalid' };
  }
  return { valid: true, reason: null };
}
