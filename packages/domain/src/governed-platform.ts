import { createHash } from 'node:crypto';

export const GOVERNED_REGISTER_KINDS = ['risk', 'gap', 'exception', 'improvement'] as const;
export type GovernedRegisterKind = (typeof GOVERNED_REGISTER_KINDS)[number];

export const GOVERNED_VISIBILITY_STATES = [
  'current',
  'aging',
  'stale',
  'unknown',
  'partial',
  'conflicting',
  'unavailable',
] as const;
export type GovernedVisibilityState = (typeof GOVERNED_VISIBILITY_STATES)[number];

export const GOVERNED_REGISTER_STATUSES = [
  'draft',
  'triage',
  'active',
  'pending_approval',
  'accepted',
  'approved',
  'remediation',
  'pending_verification',
  'verified',
  'closed',
  'expired',
  'rejected',
  'suspended',
] as const;
export type GovernedRegisterStatus = (typeof GOVERNED_REGISTER_STATUSES)[number];

export type GovernedPlatformErrorCode =
  | 'cross_tenant'
  | 'stale_version'
  | 'self_approval'
  | 'invalid_transition'
  | 'invalid_canonical_value'
  | 'invalid_projection_metadata';

export class GovernedPlatformInvariantError extends Error {
  readonly code: GovernedPlatformErrorCode;

  constructor(code: GovernedPlatformErrorCode, message: string) {
    super(message);
    this.name = 'GovernedPlatformInvariantError';
    this.code = code;
  }
}

export function assertGovernedTenant(actualTenantId: string, expectedTenantId: string): void {
  if (actualTenantId.length === 0 || actualTenantId !== expectedTenantId) {
    throw new GovernedPlatformInvariantError(
      'cross_tenant',
      'The governed record is outside the authenticated tenant boundary.',
    );
  }
}

export function assertExpectedGovernedVersion(
  currentVersion: number,
  expectedVersion: number,
): void {
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 1 ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion !== currentVersion
  ) {
    throw new GovernedPlatformInvariantError(
      'stale_version',
      'The governed record changed; reload current state before deciding.',
    );
  }
}

export function assertDistinctGovernedAuthority(
  requesterPrincipalId: string,
  authorityPrincipalId: string,
): void {
  if (
    requesterPrincipalId.length === 0 ||
    authorityPrincipalId.length === 0 ||
    requesterPrincipalId === authorityPrincipalId
  ) {
    throw new GovernedPlatformInvariantError(
      'self_approval',
      'The accountable authority must be distinct from the requester.',
    );
  }
}

type JsonPrimitive = string | number | boolean | null;
type CanonicalJson =
  JsonPrimitive | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function normalizeCanonical(value: unknown, path: string, seen: Set<object>): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new GovernedPlatformInvariantError(
        'invalid_canonical_value',
        'Non-finite number at ' + path + ' cannot be signed.',
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new GovernedPlatformInvariantError(
      'invalid_canonical_value',
      'Unsupported value at ' + path + ' cannot be signed.',
    );
  }
  if (seen.has(value)) {
    throw new GovernedPlatformInvariantError(
      'invalid_canonical_value',
      'Cyclic value at ' + path + ' cannot be signed.',
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeCanonical(item, path + '[' + index + ']', seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new GovernedPlatformInvariantError(
        'invalid_canonical_value',
        'Only plain JSON objects can be signed at ' + path + '.',
      );
    }
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) {
        throw new GovernedPlatformInvariantError(
          'invalid_canonical_value',
          'Undefined member at ' + path + '.' + key + ' cannot be signed.',
        );
      }
      output[key] = normalizeCanonical(member, path + '.' + key, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalGovernedJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value, '$', new Set()));
}

export function governedDigest(value: unknown): string {
  return createHash('sha256').update(canonicalGovernedJson(value), 'utf8').digest('hex');
}

const REGISTER_TRANSITIONS: Readonly<
  Record<
    GovernedRegisterKind,
    Readonly<Partial<Record<GovernedRegisterStatus, readonly GovernedRegisterStatus[]>>>
  >
> = {
  risk: {
    draft: ['triage', 'rejected'],
    triage: ['active', 'rejected'],
    active: ['pending_approval', 'remediation', 'suspended'],
    pending_approval: ['accepted', 'rejected', 'active'],
    accepted: ['remediation', 'expired', 'suspended'],
    remediation: ['pending_verification', 'suspended'],
    pending_verification: ['verified', 'remediation'],
    verified: ['closed'],
    suspended: ['active', 'closed'],
  },
  gap: {
    draft: ['triage', 'rejected'],
    triage: ['active', 'rejected'],
    active: ['remediation', 'pending_verification', 'suspended'],
    remediation: ['pending_verification', 'suspended'],
    pending_verification: ['verified', 'remediation'],
    verified: ['closed'],
    suspended: ['active', 'closed'],
  },
  exception: {
    draft: ['triage', 'rejected'],
    triage: ['pending_approval', 'rejected'],
    pending_approval: ['approved', 'rejected', 'triage'],
    approved: ['expired', 'closed', 'suspended'],
    suspended: ['approved', 'closed', 'expired'],
    expired: ['closed'],
  },
  improvement: {
    draft: ['triage', 'rejected'],
    triage: ['active', 'rejected'],
    active: ['remediation', 'pending_verification', 'suspended'],
    remediation: ['pending_verification', 'suspended'],
    pending_verification: ['verified', 'remediation'],
    verified: ['closed'],
    suspended: ['active', 'closed'],
  },
};

export function isGovernedRegisterTransitionAllowed(
  kind: GovernedRegisterKind,
  from: GovernedRegisterStatus,
  to: GovernedRegisterStatus,
): boolean {
  return REGISTER_TRANSITIONS[kind][from]?.includes(to) ?? false;
}

export function assertGovernedRegisterTransition(
  kind: GovernedRegisterKind,
  from: GovernedRegisterStatus,
  to: GovernedRegisterStatus,
): void {
  if (!isGovernedRegisterTransitionAllowed(kind, from, to)) {
    throw new GovernedPlatformInvariantError(
      'invalid_transition',
      'Transition ' + kind + ':' + from + ' -> ' + to + ' is not permitted.',
    );
  }
}

export interface GovernedVisibilityInput {
  readonly present: boolean;
  readonly fresh: boolean;
  readonly available?: boolean;
  readonly partial?: boolean;
  readonly conflicting?: boolean;
  readonly aging?: boolean;
}

export function classifyGovernedVisibility(
  input: GovernedVisibilityInput,
): GovernedVisibilityState {
  if (!input.present) return 'unknown';
  if (input.available === false) return 'unavailable';
  if (input.conflicting === true) return 'conflicting';
  if (input.partial === true) return 'partial';
  if (!input.fresh) return 'stale';
  if (input.aging === true) return 'aging';
  return 'current';
}

export interface GovernedProjectionMetadataInput {
  readonly sourceCursor: string;
  readonly generatedAt: number;
  readonly rebuildVersion: number;
  readonly visibility: GovernedVisibilityState;
  readonly coverageGaps?: readonly string[];
}

export interface GovernedProjectionMetadata {
  readonly sourceCursor: string;
  readonly generatedAt: number;
  readonly rebuildVersion: number;
  readonly visibility: GovernedVisibilityState;
  readonly partialCoverage: boolean;
  readonly coverageGaps: readonly string[];
}

export function makeGovernedProjectionMetadata(
  input: GovernedProjectionMetadataInput,
): GovernedProjectionMetadata {
  if (
    input.sourceCursor.length === 0 ||
    !Number.isSafeInteger(input.generatedAt) ||
    input.generatedAt < 0 ||
    !Number.isSafeInteger(input.rebuildVersion) ||
    input.rebuildVersion < 1
  ) {
    throw new GovernedPlatformInvariantError(
      'invalid_projection_metadata',
      'Projection metadata requires cursor, generated time, and positive rebuild version.',
    );
  }
  const coverageGaps = Object.freeze([...(input.coverageGaps ?? [])]);
  const partialCoverage =
    input.visibility !== 'current' && input.visibility !== 'aging' ? true : coverageGaps.length > 0;
  return Object.freeze({
    sourceCursor: input.sourceCursor,
    generatedAt: input.generatedAt,
    rebuildVersion: input.rebuildVersion,
    visibility: input.visibility,
    partialCoverage,
    coverageGaps,
  });
}

export interface GovernedResourceIdentity {
  readonly id: string;
  readonly tenantId: string;
  readonly schemaVersion: number;
  readonly resourceVersion: number;
  readonly status: string;
  readonly ownerPrincipalId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ImmutableGovernedFact {
  readonly id: string;
  readonly tenantId: string;
  readonly schemaVersion: number;
  readonly canonicalDigest: string;
  readonly recordedAt: number;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
}
