export type ConnectorCertificationStatus = 'active' | 'revoked';

export interface ConnectorConformanceEvidence {
  readonly reportDigest: string;
  readonly manifestDigest: string;
  readonly suiteVersion: string;
  readonly passed: boolean;
  readonly signatureValid: boolean;
}

export interface ConnectorCertificationHistoryEntry {
  readonly status: ConnectorCertificationStatus;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly at: number;
}

export interface ConnectorCertification {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly exactVersion: string;
  readonly manifestDigest: string;
  readonly reportDigest: string;
  readonly suiteVersion: string;
  readonly authorPrincipalId: string;
  readonly certifierPrincipalId: string;
  readonly certificationDecisionId: string;
  readonly allowedTenantRefs: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly credentialClasses: readonly string[];
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly certifiedAt: number;
  readonly status: ConnectorCertificationStatus;
  readonly revokedAt?: number;
  readonly revokedByPrincipalId?: string;
  readonly revocationDecisionId?: string;
  readonly revocationReason?: Readonly<{ code: string; text: string }>;
  readonly history: readonly ConnectorCertificationHistoryEntry[];
}

export interface CertifyConnectorVersionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly exactVersion: string;
  readonly manifestDigest: string;
  readonly report: ConnectorConformanceEvidence;
  readonly authorPrincipalId: string;
  readonly certifierPrincipalId: string;
  readonly certificationDecisionId: string;
  readonly allowedTenantRefs: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly credentialClasses: readonly string[];
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly certifiedAt: number;
}

export interface ConnectorActivationInput {
  readonly certification: ConnectorCertification;
  readonly tenantId: string;
  readonly exactVersion: string;
  readonly manifestDigest: string;
  readonly reportDigest: string;
  readonly scope: string;
  readonly capabilities: readonly string[];
  readonly credentialClass: string;
  readonly now: number;
  readonly healthy: boolean;
  readonly compatible: boolean;
  readonly policyConformant: boolean;
}

export interface ConnectorActivationVerdict {
  readonly allowed: boolean;
  readonly failures: readonly string[];
  readonly reconciliationAvailable: boolean;
}

export interface RevokeConnectorCertificationInput {
  readonly certification: ConnectorCertification;
  readonly tenantId: string;
  readonly revokedByPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly revokedAt: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(label + ' must be a non-empty string');
  }
}

function epoch(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new RangeError(label + ' must be a non-negative epoch-ms');
  }
}

function uuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TypeError(label + ' must be a UUID');
  }
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new TypeError(label + ' must be a sha256 digest');
  }
}

function uniqueList(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(label + ' must be a non-empty list');
  }
  for (const item of value) text(item, label + ' item');
  if (new Set(value).size !== value.length) {
    throw new TypeError(label + ' must not contain duplicates');
  }
  return Object.freeze([...value]);
}

function reason(
  value: Readonly<{ code: string; text: string }>,
  label: string,
): Readonly<{ code: string; text: string }> {
  text(value?.code, label + ' code');
  text(value?.text, label + ' text');
  return Object.freeze({ code: value.code, text: value.text });
}

export function certifyConnectorVersion(
  input: CertifyConnectorVersionInput,
): ConnectorCertification {
  uuid(input.id, 'certification id');
  uuid(input.tenantId, 'tenant id');
  text(input.connectorId, 'connector id');
  if (!SEMVER_RE.test(input.exactVersion)) {
    throw new TypeError('exact connector version must be semver');
  }
  digest(input.manifestDigest, 'manifest digest');
  digest(input.report.reportDigest, 'report digest');
  digest(input.report.manifestDigest, 'report manifest digest');
  uuid(input.authorPrincipalId, 'author principal id');
  uuid(input.certifierPrincipalId, 'certifier principal id');
  text(input.certificationDecisionId, 'certification decision id');
  epoch(input.validFrom, 'valid from');
  epoch(input.expiresAt, 'expires at');
  epoch(input.certifiedAt, 'certified at');
  if (input.expiresAt <= input.validFrom) {
    throw new RangeError('certification expiry must be after validity start');
  }
  if (input.certifiedAt > input.expiresAt) {
    throw new RangeError('certification cannot be issued after expiry');
  }
  if (input.authorPrincipalId === input.certifierPrincipalId) {
    throw new RangeError(
      'connector author and certifier must be distinct; self-certification denied',
    );
  }
  if (!input.report.passed || !input.report.signatureValid) {
    throw new RangeError('connector certification requires a passing, signature-valid report');
  }
  if (input.report.manifestDigest !== input.manifestDigest) {
    throw new RangeError('conformance report manifest digest does not match the exact manifest');
  }
  text(input.report.suiteVersion, 'conformance suite version');
  const allowedTenantRefs = uniqueList(input.allowedTenantRefs, 'allowed tenant refs');
  if (!allowedTenantRefs.includes(input.tenantId)) {
    throw new RangeError('tenant certification must include its tenant in the allowed bounds');
  }
  const allowedScopes = uniqueList(input.allowedScopes, 'allowed scopes');
  const allowedCapabilities = uniqueList(input.allowedCapabilities, 'allowed capabilities');
  const credentialClasses = uniqueList(input.credentialClasses, 'credential classes');
  const initialReason = Object.freeze({
    code: 'connector.certified',
    text: 'An independent certifier approved the exact manifest and report bounds.',
  });
  const history = Object.freeze([
    Object.freeze({
      status: 'active' as const,
      actorPrincipalId: input.certifierPrincipalId,
      authorityDecisionId: input.certificationDecisionId,
      reason: initialReason,
      at: input.certifiedAt,
    }),
  ]);
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    exactVersion: input.exactVersion,
    manifestDigest: input.manifestDigest,
    reportDigest: input.report.reportDigest,
    suiteVersion: input.report.suiteVersion,
    authorPrincipalId: input.authorPrincipalId,
    certifierPrincipalId: input.certifierPrincipalId,
    certificationDecisionId: input.certificationDecisionId,
    allowedTenantRefs,
    allowedScopes,
    allowedCapabilities,
    credentialClasses,
    validFrom: input.validFrom,
    expiresAt: input.expiresAt,
    certifiedAt: input.certifiedAt,
    status: 'active',
    history,
  });
}

export function evaluateConnectorActivation(
  input: ConnectorActivationInput,
): ConnectorActivationVerdict {
  epoch(input.now, 'activation time');
  const failures: string[] = [];
  const certification = input.certification;
  if (certification.status !== 'active') failures.push('certification_not_active');
  if (input.now < certification.validFrom) failures.push('certification_not_yet_valid');
  if (input.now >= certification.expiresAt) failures.push('certification_expired');
  if (!certification.allowedTenantRefs.includes(input.tenantId)) {
    failures.push('tenant_out_of_bounds');
  }
  if (input.exactVersion !== certification.exactVersion) {
    failures.push('version_mismatch');
  }
  if (input.manifestDigest !== certification.manifestDigest) {
    failures.push('manifest_digest_mismatch');
  }
  if (input.reportDigest !== certification.reportDigest) {
    failures.push('report_digest_mismatch');
  }
  if (!certification.allowedScopes.includes(input.scope)) failures.push('scope_out_of_bounds');
  if (
    input.capabilities.some((capability) => !certification.allowedCapabilities.includes(capability))
  ) {
    failures.push('capability_out_of_bounds');
  }
  if (!certification.credentialClasses.includes(input.credentialClass)) {
    failures.push('credential_class_out_of_bounds');
  }
  if (!input.healthy) failures.push('connector_unhealthy');
  if (!input.compatible) failures.push('contract_incompatible');
  if (!input.policyConformant) failures.push('policy_nonconformant');
  return Object.freeze({
    allowed: failures.length === 0,
    failures: Object.freeze(failures),
    reconciliationAvailable: true,
  });
}

export function revokeConnectorCertification(
  input: RevokeConnectorCertificationInput,
): ConnectorCertification {
  if (input.certification.tenantId !== input.tenantId) {
    throw new RangeError('tenant mismatch while revoking connector certification');
  }
  if (input.certification.status !== 'active') {
    throw new RangeError('only an active connector certification can be revoked');
  }
  uuid(input.revokedByPrincipalId, 'revoking principal id');
  text(input.authorityDecisionId, 'revocation authority decision id');
  epoch(input.revokedAt, 'revoked at');
  if (input.revokedAt < input.certification.certifiedAt) {
    throw new RangeError('revocation cannot precede certification');
  }
  const revocationReason = reason(input.reason, 'revocation reason');
  const historyEntry = Object.freeze({
    status: 'revoked' as const,
    actorPrincipalId: input.revokedByPrincipalId,
    authorityDecisionId: input.authorityDecisionId,
    reason: revocationReason,
    at: input.revokedAt,
  });
  return Object.freeze({
    ...input.certification,
    status: 'revoked',
    revokedAt: input.revokedAt,
    revokedByPrincipalId: input.revokedByPrincipalId,
    revocationDecisionId: input.authorityDecisionId,
    revocationReason,
    history: Object.freeze([...input.certification.history, historyEntry]),
  });
}
