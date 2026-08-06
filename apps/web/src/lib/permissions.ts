import type { OperatorRole, OperatorSessionContext } from './session-context.ts';

export type ConsoleDomain =
  | 'posture'
  | 'inventory'
  | 'gaps'
  | 'decisions'
  | 'integrity'
  | 'controllers'
  | 'compliance'
  | 'evidence'
  | 'integrations'
  | 'operations';

export interface DomainPlan {
  readonly id: ConsoleDomain;
  readonly label: string;
  readonly path: `/v1/${string}`;
  readonly roles: readonly OperatorRole[];
}

const READ_ROLES: readonly OperatorRole[] = [
  'governance_officer',
  'control_owner',
  'auditor',
  'operator',
  'authorized_approver',
  'tenant_compliance_owner',
  'independent_compliance_reviewer',
];

export const DOMAIN_PLANS: readonly DomainPlan[] = [
  {
    id: 'posture',
    label: 'Operating posture',
    path: '/v1/dashboards/governance-officer',
    roles: READ_ROLES,
  },
  { id: 'inventory', label: 'Governed inventory', path: '/v1/inventory/assets', roles: READ_ROLES },
  { id: 'gaps', label: 'Coverage gaps', path: '/v1/inventory/sources', roles: READ_ROLES },
  { id: 'decisions', label: 'Human decisions', path: '/v1/decisions', roles: READ_ROLES },
  {
    id: 'integrity',
    label: 'Integrity and remediation',
    path: '/v1/integrity-cases',
    roles: READ_ROLES,
  },
  { id: 'controllers', label: 'Controllers', path: '/v1/controllers', roles: READ_ROLES },
  {
    id: 'compliance',
    label: 'Compliance and audit readiness',
    path: '/v1/compliance/coverage',
    roles: READ_ROLES,
  },
  {
    id: 'evidence',
    label: 'Evidence posture',
    path: '/v1/dashboards/auditor',
    roles: ['auditor', 'governance_officer'],
  },
  { id: 'integrations', label: 'Integrations', path: '/v1/connectors', roles: READ_ROLES },
  {
    id: 'operations',
    label: 'Runtime components',
    path: '/v1/platform/health',
    roles: READ_ROLES,
  },
] as const;

export function permittedDomains(session: OperatorSessionContext): readonly DomainPlan[] {
  if (!session.authenticated || !session.tenantId) return [];
  return DOMAIN_PLANS.filter((domain) => domain.roles.some((role) => session.roles.includes(role)));
}

export function hasGovernanceAuthority(session: OperatorSessionContext): boolean {
  return session.roles.some((role) => role !== 'platform_admin' && role !== 'auditor');
}

export interface OperationsWorkspaceCapabilities {
  readonly canRead: boolean;
  readonly canCreateCases: boolean;
  readonly canTransitionCases: boolean;
  readonly canVerifyCases: boolean;
  readonly canEvaluateSla: boolean;
  readonly readOnly: boolean;
}

const OPERATIONS_READ_ROLES = new Set<OperatorRole>([
  'governance_officer',
  'control_owner',
  'auditor',
  'operator',
  'authorized_approver',
  'central_governance_reviewer',
  'tenant_compliance_owner',
  'independent_compliance_reviewer',
  'source_steward',
]);
const OPERATIONS_MUTATION_ROLES = new Set<OperatorRole>([
  'governance_officer',
  'control_owner',
  'operator',
  'authorized_approver',
  'tenant_compliance_owner',
]);
const OPERATIONS_VERIFIER_ROLES = new Set<OperatorRole>([
  'governance_officer',
  'authorized_approver',
  'independent_compliance_reviewer',
]);

export function operationsWorkspaceCapabilities(
  session: OperatorSessionContext,
): OperationsWorkspaceCapabilities {
  const canRead =
    session.authenticated && session.roles.some((role) => OPERATIONS_READ_ROLES.has(role));
  const canMutate = canRead && session.roles.some((role) => OPERATIONS_MUTATION_ROLES.has(role));
  const canVerify = canRead && session.roles.some((role) => OPERATIONS_VERIFIER_ROLES.has(role));
  const canEvaluateSla =
    session.authenticated && (canMutate || session.roles.includes('automation_principal'));
  return {
    canRead,
    canCreateCases: canMutate,
    canTransitionCases: canMutate,
    canVerifyCases: canVerify,
    canEvaluateSla,
    readOnly: !canMutate,
  };
}
