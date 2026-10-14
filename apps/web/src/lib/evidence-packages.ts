// Evidence packages requested from this browser session, tracked so an auditor can verify and
// download a receipt by selecting a package instead of retyping its identifier.
//
// This is a per-viewer convenience, not a record of truth: the API holds the packages, and a
// package requested elsewhere is still verified by entering its identifier. Nothing here marks a
// package as valid; only the verification endpoint's answer does.

export type SessionPackageStatus =
  | 'requested'
  | 'accepted'
  | 'not_accepted'
  | 'verified'
  | 'verification_failed'
  | 'verification_unavailable';

export interface PackageVerification {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly canonicalDigest: string;
  readonly verifiedAt: string;
}

export interface SessionPackage {
  readonly id: string;
  readonly evidenceRequestId?: string;
  readonly requestedAt: string;
  readonly status: SessionPackageStatus;
  readonly operationId?: string;
  readonly verification?: PackageVerification;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: ReadonlySet<string> = new Set<SessionPackageStatus>([
  'requested',
  'accepted',
  'not_accepted',
  'verified',
  'verification_failed',
  'verification_unavailable',
]);
const MAX_TRACKED = 50;

export function isPackageId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function packageStatusLabel(status: SessionPackageStatus): string {
  switch (status) {
    case 'requested':
      return 'Requested';
    case 'accepted':
      return 'Generation accepted';
    case 'not_accepted':
      return 'Not accepted';
    case 'verified':
      return 'Verified';
    case 'verification_failed':
      return 'Verification failed';
    case 'verification_unavailable':
      return 'Verification unavailable';
  }
}

/** Insert or replace a package, newest first, keeping at most MAX_TRACKED. */
export function upsertPackage(
  list: readonly SessionPackage[],
  entry: SessionPackage,
): readonly SessionPackage[] {
  return [entry, ...list.filter((item) => item.id !== entry.id)].slice(0, MAX_TRACKED);
}

export function updatePackage(
  list: readonly SessionPackage[],
  id: string,
  change: Partial<Omit<SessionPackage, 'id'>>,
): readonly SessionPackage[] {
  return list.map((item) => (item.id === id ? { ...item, ...change } : item));
}

/** Map the verification endpoint's JSON answer; undefined when it is not a usable answer. */
export function parseVerification(body: unknown): PackageVerification | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record['valid'] !== 'boolean') return undefined;
  return {
    valid: record['valid'],
    reason: typeof record['reason'] === 'string' ? record['reason'] : null,
    canonicalDigest:
      typeof record['canonical_digest'] === 'string' ? record['canonical_digest'] : '',
    verifiedAt:
      typeof record['verified_at'] === 'string' ? record['verified_at'] : new Date().toISOString(),
  };
}

/** The downloadable receipt: what was checked, the verdict, and where the verdict came from. */
export function verificationReceipt(entry: SessionPackage): Readonly<Record<string, unknown>> {
  if (!entry.verification) throw new Error('package has not been verified');
  return {
    schema: 'trustcircle.evidence-package-verification-receipt/v1',
    package_id: entry.id,
    ...(entry.evidenceRequestId ? { evidence_request_id: entry.evidenceRequestId } : {}),
    valid: entry.verification.valid,
    reason: entry.verification.reason,
    canonical_digest: entry.verification.canonicalDigest,
    verified_at: entry.verification.verifiedAt,
    verified_by: 'TrustCircle evidence package verification endpoint',
    claim_boundary:
      'Records the integrity check of one signed package. It is not an audit opinion or a certification.',
  };
}

/** Parse what was stored for this session; anything malformed is dropped, never trusted. */
export function parseStoredPackages(raw: string | null): readonly SessionPackage[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter(
      (item) =>
        typeof item['id'] === 'string' &&
        isPackageId(item['id']) &&
        typeof item['requestedAt'] === 'string' &&
        typeof item['status'] === 'string' &&
        STATUSES.has(item['status']),
    )
    .slice(0, MAX_TRACKED)
    .map((item) => {
      const verification = item['verification']
        ? parseVerification({
            valid: (item['verification'] as Record<string, unknown>)['valid'],
            reason: (item['verification'] as Record<string, unknown>)['reason'],
            canonical_digest: (item['verification'] as Record<string, unknown>)['canonicalDigest'],
            verified_at: (item['verification'] as Record<string, unknown>)['verifiedAt'],
          })
        : undefined;
      return {
        id: item['id'] as string,
        requestedAt: item['requestedAt'] as string,
        status: item['status'] as SessionPackageStatus,
        ...(typeof item['evidenceRequestId'] === 'string'
          ? { evidenceRequestId: item['evidenceRequestId'] }
          : {}),
        ...(typeof item['operationId'] === 'string' ? { operationId: item['operationId'] } : {}),
        ...(verification ? { verification } : {}),
      };
    });
}
