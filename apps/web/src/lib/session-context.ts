import { headers } from 'next/headers';

export const OPERATOR_ROLES = [
  'governance_officer',
  'control_owner',
  'auditor',
  'operator',
  'authorized_approver',
  'tenant_compliance_owner',
  'independent_compliance_reviewer',
  'platform_admin',
  'central_governance_reviewer',
  'source_steward',
  'automation_principal',
] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export interface OperatorSessionContext {
  readonly authenticated: boolean;
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly tenantName?: string;
  readonly roles: readonly OperatorRole[];
  readonly correlationId?: string;
  readonly authorization?: string;
  readonly cookie?: string;
  readonly csrfToken?: string;
}

export function validateSessionClaims(input: {
  readonly trusted: boolean;
  readonly principalId?: string | null;
  readonly tenantId?: string | null;
  readonly tenantName?: string | null;
  readonly roles?: string | null;
  readonly correlationId?: string | null;
  readonly authorization?: string | null;
  readonly cookie?: string | null;
}): OperatorSessionContext {
  if (!input.trusted || !input.principalId || !input.tenantId) {
    return { authenticated: false, roles: [] };
  }
  const csrfToken = input.cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === 'tc_csrf')?.[1];
  const roles = (input.roles ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is OperatorRole => OPERATOR_ROLES.includes(role as OperatorRole));
  return {
    authenticated: true,
    principalId: input.principalId,
    tenantId: input.tenantId,
    tenantName: input.tenantName || input.tenantId,
    roles,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.authorization ? { authorization: input.authorization } : {}),
    ...(input.cookie ? { cookie: input.cookie } : {}),
    ...(csrfToken ? { csrfToken: decodeURIComponent(csrfToken) } : {}),
  };
}

export const DEFAULT_LOCAL_PREVIEW_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export function resolveLocalPreviewSession(
  enabled: boolean,
  tenantId = process.env['LOCAL_PREVIEW_TENANT_ID'] ?? DEFAULT_LOCAL_PREVIEW_TENANT_ID,
  principalId = process.env['LOCAL_PREVIEW_PRINCIPAL_ID'] ?? 'local-preview-operator',
): OperatorSessionContext | undefined {
  if (!enabled) return undefined;
  return validateSessionClaims({
    trusted: true,
    principalId,
    tenantId,
    tenantName: 'Local read-only preview',
    roles: 'auditor',
  });
}

export async function resolveOperatorSession(): Promise<OperatorSessionContext> {
  const localPreview = resolveLocalPreviewSession(process.env['LOCAL_OPERATOR_PREVIEW'] === 'true');
  if (localPreview) return localPreview;
  const incoming = await headers();
  return validateSessionClaims({
    trusted: process.env['TRUST_IDENTITY_HEADERS'] === 'true',
    principalId: incoming.get('x-trustcircle-principal'),
    tenantId: incoming.get('x-trustcircle-tenant-id'),
    tenantName: incoming.get('x-trustcircle-tenant-name'),
    roles: incoming.get('x-trustcircle-roles'),
    correlationId: incoming.get('x-correlation-id'),
    authorization: incoming.get('authorization'),
    cookie: incoming.get('cookie'),
  });
}
