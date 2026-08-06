export const PROTECTED_RESPONSE_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  pragma: 'no-cache',
  vary: 'Authorization, Cookie, X-TrustCircle-Tenant-Id, X-TrustCircle-Roles',
} as const;

export function protectedCacheKey(input: {
  readonly principalId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly contract: string;
}): string {
  return [
    input.principalId,
    input.tenantId,
    [...input.roles].sort().join(','),
    input.contract,
  ].join('|');
}
