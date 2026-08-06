import type { AttentionDomain } from '@trustcircle/domain';

export type OperationsRole =
  | 'governance_officer'
  | 'control_owner'
  | 'auditor'
  | 'operator'
  | 'authorized_approver'
  | 'central_governance_reviewer'
  | 'tenant_compliance_owner'
  | 'independent_compliance_reviewer'
  | 'source_steward'
  | 'platform_admin'
  | 'automation_principal';

const GENERAL_READ_ROLES = new Set<OperationsRole>([
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

const MUTATION_ROLES = new Set<OperationsRole>([
  'governance_officer',
  'control_owner',
  'operator',
  'authorized_approver',
  'tenant_compliance_owner',
]);

const VERIFIER_ROLES = new Set<OperationsRole>([
  'governance_officer',
  'authorized_approver',
  'independent_compliance_reviewer',
]);

const ALL_OPERATIONAL_DOMAINS: readonly AttentionDomain[] = [
  'decision',
  'integrity',
  'inventory',
  'source',
  'controller',
  'compliance',
  'connector',
  'runtime',
  'coverage',
];

export interface OperationsAuthorityPlan {
  readonly domains: readonly AttentionDomain[];
  readonly canReadCases: boolean;
  readonly canCreateCases: boolean;
  readonly canTransitionCases: boolean;
  readonly canVerifyCases: boolean;
  readonly canEvaluateSla: boolean;
  readonly readOnly: boolean;
}

/** Resolve the complete feature plan before any domain adapter is invoked. */
export function operationsAuthorityPlan(roles: readonly OperationsRole[]): OperationsAuthorityPlan {
  const roleSet = new Set(roles);
  const canRead = roles.some((role) => GENERAL_READ_ROLES.has(role));
  if (!canRead) {
    return {
      domains: [],
      canReadCases: false,
      canCreateCases: false,
      canTransitionCases: false,
      canVerifyCases: false,
      canEvaluateSla: roleSet.has('automation_principal'),
      readOnly: true,
    };
  }
  const domains = [...ALL_OPERATIONAL_DOMAINS];
  if (roleSet.has('auditor') || roleSet.has('governance_officer')) domains.push('evidence');
  const canMutate = roles.some((role) => MUTATION_ROLES.has(role));
  return {
    domains,
    canReadCases: true,
    canCreateCases: canMutate,
    canTransitionCases: canMutate,
    canVerifyCases: roles.some((role) => VERIFIER_ROLES.has(role)),
    canEvaluateSla: canMutate || roleSet.has('automation_principal'),
    readOnly: !canMutate,
  };
}

export function assertOperationAuthority(
  roles: readonly OperationsRole[],
  capability: 'create' | 'transition' | 'verify' | 'evaluate_sla',
): void {
  const plan = operationsAuthorityPlan(roles);
  const allowed =
    capability === 'create'
      ? plan.canCreateCases
      : capability === 'transition'
        ? plan.canTransitionCases
        : capability === 'verify'
          ? plan.canVerifyCases
          : plan.canEvaluateSla;
  if (!allowed) throw new OperationsAuthorizationError('operation authority is not granted');
}

export class OperationsAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationsAuthorizationError';
  }
}
