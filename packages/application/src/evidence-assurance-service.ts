import {
  assertDistinctGovernedAuthority,
  assertExpectedGovernedVersion,
  assertGovernedTenant,
  canonicalGovernedJson,
  governedDigest,
} from '@trustcircle/domain';

export type EvidenceRequestStatus = 'issued' | 'submitted' | 'accepted' | 'rejected' | 'expired';

export interface EvidenceRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly requestedEvidenceTypes: readonly string[];
  readonly ownerPrincipalId: string;
  readonly requesterPrincipalId: string;
  readonly dueAt: number;
  readonly expiresAt: number;
  readonly reason: { readonly code: string; readonly text: string };
  readonly status: EvidenceRequestStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EvidenceVersionBinding {
  readonly evidenceId: string;
  readonly version: number;
  readonly digest: string;
}

export interface EvidenceAttestation {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly ownerPrincipalId: string;
  readonly evidenceVersions: readonly EvidenceVersionBinding[];
  readonly statement: string;
  readonly signature: string;
  readonly signedAt: number;
  readonly canonicalDigest: string;
}

export type EvidenceSufficiency = 'sufficient' | 'insufficient';

export interface EvidenceSufficiencyDecision {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly attestationId: string;
  readonly attestationDigest: string;
  readonly decision: EvidenceSufficiency;
  readonly reviewerPrincipalId: string;
  readonly reason: { readonly code: string; readonly text: string };
  readonly decidedAt: number;
  readonly canonicalDigest: string;
}

export interface IssueEvidenceRequestInput {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly requestedEvidenceTypes: readonly string[];
  readonly ownerPrincipalId: string;
  readonly requesterPrincipalId: string;
  readonly dueAt: number;
  readonly expiresAt: number;
  readonly reason: { readonly code: string; readonly text: string };
  readonly now: number;
}

export interface SubmitEvidenceAttestationInput {
  readonly request: EvidenceRequest;
  readonly tenantId: string;
  readonly expectedRequestVersion: number;
  readonly attestationId: string;
  readonly actorPrincipalId: string;
  readonly evidenceVersions: readonly EvidenceVersionBinding[];
  readonly statement: string;
  readonly signature: string;
  readonly signedAt: number;
}

export interface DecideEvidenceSufficiencyInput {
  readonly request: EvidenceRequest;
  readonly attestation: EvidenceAttestation;
  readonly tenantId: string;
  readonly expectedRequestVersion: number;
  readonly decisionId: string;
  readonly actorPrincipalId: string;
  readonly decision: EvidenceSufficiency;
  readonly reason: { readonly code: string; readonly text: string };
  readonly decidedAt: number;
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

function reason(value: { readonly code: string; readonly text: string }) {
  const code = text(value?.code, 'reason.code');
  const detail = text(value?.text, 'reason.text');
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(code) || detail.length < 3 || detail.length > 4000) {
    throw new TypeError('A governed structured reason is required.');
  }
  return Object.freeze({ code, text: detail });
}

function immutableJson<T>(value: T): T {
  return Object.freeze(JSON.parse(canonicalGovernedJson(value)) as T);
}

export function issueEvidenceRequest(input: IssueEvidenceRequestInput): EvidenceRequest {
  const id = text(input.id, 'id');
  const tenantId = text(input.tenantId, 'tenantId');
  const ownerPrincipalId = text(input.ownerPrincipalId, 'ownerPrincipalId');
  const requesterPrincipalId = text(input.requesterPrincipalId, 'requesterPrincipalId');
  const createdAt = epoch(input.now, 'now');
  const dueAt = epoch(input.dueAt, 'dueAt');
  const expiresAt = epoch(input.expiresAt, 'expiresAt');
  if (dueAt <= createdAt || expiresAt <= dueAt) {
    throw new RangeError('Evidence request due and expiry must be future ordered instants.');
  }
  if (input.requestedEvidenceTypes.length === 0) {
    throw new TypeError('At least one requested evidence type is required.');
  }
  return Object.freeze({
    id,
    tenantId,
    scope: immutableJson(input.scope),
    requestedEvidenceTypes: Object.freeze([...new Set(input.requestedEvidenceTypes)].sort()),
    ownerPrincipalId,
    requesterPrincipalId,
    dueAt,
    expiresAt,
    reason: reason(input.reason),
    status: 'issued',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

function validateEvidenceVersions(
  versions: readonly EvidenceVersionBinding[],
): readonly EvidenceVersionBinding[] {
  if (versions.length === 0)
    throw new TypeError('At least one exact evidence version is required.');
  const seen = new Set<string>();
  const validated = versions.map((binding) => {
    text(binding.evidenceId, 'evidenceId');
    if (!Number.isSafeInteger(binding.version) || binding.version < 1) {
      throw new RangeError('Evidence version must be a positive integer.');
    }
    if (!/^[a-f0-9]{64}$/.test(binding.digest)) {
      throw new TypeError('Evidence version digest must be SHA-256.');
    }
    const key = binding.evidenceId + ':' + binding.version;
    if (seen.has(key)) throw new TypeError('Duplicate evidence version binding.');
    seen.add(key);
    return Object.freeze({ ...binding });
  });
  return Object.freeze(validated.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)));
}

export function submitEvidenceAttestation(input: SubmitEvidenceAttestationInput): {
  readonly request: EvidenceRequest;
  readonly attestation: EvidenceAttestation;
} {
  assertGovernedTenant(input.request.tenantId, input.tenantId);
  assertExpectedGovernedVersion(input.request.version, input.expectedRequestVersion);
  if (input.request.status !== 'issued') {
    throw new TypeError('Only an issued evidence request can be attested.');
  }
  if (input.actorPrincipalId !== input.request.ownerPrincipalId) {
    throw new TypeError('The assigned evidence owner authority is required.');
  }
  const signedAt = epoch(input.signedAt, 'signedAt');
  if (signedAt >= input.request.expiresAt)
    throw new RangeError('The evidence request has expired.');
  const content = {
    id: text(input.attestationId, 'attestationId'),
    tenantId: input.tenantId,
    requestId: input.request.id,
    requestVersion: input.request.version,
    ownerPrincipalId: input.actorPrincipalId,
    evidenceVersions: validateEvidenceVersions(input.evidenceVersions),
    statement: text(input.statement, 'statement'),
    signature: text(input.signature, 'signature'),
    signedAt,
  };
  const attestation = Object.freeze({
    ...content,
    canonicalDigest: governedDigest(content),
  });
  const request = Object.freeze({
    ...input.request,
    status: 'submitted' as const,
    version: input.request.version + 1,
    updatedAt: signedAt,
  });
  return Object.freeze({ request, attestation });
}

export function decideEvidenceSufficiency(input: DecideEvidenceSufficiencyInput): {
  readonly request: EvidenceRequest;
  readonly decision: EvidenceSufficiencyDecision;
} {
  assertGovernedTenant(input.request.tenantId, input.tenantId);
  assertGovernedTenant(input.attestation.tenantId, input.tenantId);
  assertExpectedGovernedVersion(input.request.version, input.expectedRequestVersion);
  if (input.request.status !== 'submitted') {
    throw new TypeError('Only submitted evidence can receive a sufficiency decision.');
  }
  if (
    input.attestation.requestId !== input.request.id ||
    input.attestation.requestVersion !== input.request.version - 1
  ) {
    throw new TypeError('The attestation is not bound to the exact prior request version.');
  }
  assertDistinctGovernedAuthority(input.request.ownerPrincipalId, input.actorPrincipalId);
  const decidedAt = epoch(input.decidedAt, 'decidedAt');
  if (decidedAt < input.attestation.signedAt) {
    throw new RangeError('A sufficiency decision cannot predate its attestation.');
  }
  const content = {
    id: text(input.decisionId, 'decisionId'),
    tenantId: input.tenantId,
    requestId: input.request.id,
    requestVersion: input.request.version,
    attestationId: input.attestation.id,
    attestationDigest: input.attestation.canonicalDigest,
    decision: input.decision,
    reviewerPrincipalId: input.actorPrincipalId,
    reason: reason(input.reason),
    decidedAt,
  };
  const decision = Object.freeze({
    ...content,
    canonicalDigest: governedDigest(content),
  });
  const request = Object.freeze({
    ...input.request,
    status: input.decision === 'sufficient' ? ('accepted' as const) : ('rejected' as const),
    version: input.request.version + 1,
    updatedAt: decidedAt,
  });
  return Object.freeze({ request, decision });
}

export type EvidenceRequestAttention = 'current' | 'overdue' | 'expired';

export function evidenceRequestAttention(
  request: EvidenceRequest,
  nowInput: number,
): EvidenceRequestAttention {
  const now = epoch(nowInput, 'now');
  if (request.status === 'expired' || now >= request.expiresAt) return 'expired';
  if (now >= request.dueAt) return 'overdue';
  return 'current';
}

export function expireEvidenceRequest(request: EvidenceRequest, nowInput: number): EvidenceRequest {
  const now = epoch(nowInput, 'now');
  if ((request.status === 'issued' || request.status === 'submitted') && now >= request.expiresAt) {
    return Object.freeze({
      ...request,
      status: 'expired',
      version: request.version + 1,
      updatedAt: now,
    });
  }
  return request;
}
