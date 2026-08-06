import type { RoleKey } from './separation-of-duties.ts';

export const GOVERNED_PLATFORM_ACTIONS = [
  'sign_review_snapshot',
  'create_register_record',
  'transition_register_record',
  'create_governed_view',
  'create_subscription',
  'issue_evidence_request',
  'attest_evidence',
  'decide_evidence_sufficiency',
  'request_evidence_package',
  'verify_evidence_package',
  'ingest_control_observation',
  'request_impact_preview',
  'publish_governed_change',
  'create_ai_use_case',
  'transition_ai_use_case',
  'record_ai_evaluation',
  'report_ai_incident',
  'create_copilot_exchange',
  'create_connector_definition',
  'request_connector_conformance',
  'certify_connector_version',
  'revoke_connector_certification',
  'request_connector_reconciliation',
  'create_improvement_hypothesis',
  'transition_improvement_hypothesis',
  'create_entity_resolution_case',
  'transition_entity_resolution_case',
] as const;

export type GovernedPlatformAction = (typeof GOVERNED_PLATFORM_ACTIONS)[number];

const DECISION_ROLES: readonly RoleKey[] = [
  'governance_officer',
  'authorized_approver',
  'tenant_compliance_owner',
  'central_governance_reviewer',
  'independent_compliance_reviewer',
];

const ACTION_ROLES: Readonly<Record<GovernedPlatformAction, readonly RoleKey[]>> = {
  sign_review_snapshot: ['governance_officer', 'tenant_compliance_owner'],
  create_register_record: ['governance_officer', 'control_owner', 'tenant_compliance_owner'],
  transition_register_record: DECISION_ROLES,
  create_governed_view: [
    'governance_officer',
    'control_owner',
    'auditor',
    'operator',
    'tenant_compliance_owner',
    'source_steward',
  ],
  create_subscription: [
    'governance_officer',
    'control_owner',
    'auditor',
    'operator',
    'tenant_compliance_owner',
    'source_steward',
  ],
  issue_evidence_request: [
    'governance_officer',
    'control_owner',
    'auditor',
    'tenant_compliance_owner',
    'independent_compliance_reviewer',
  ],
  attest_evidence: ['control_owner', 'source_steward', 'governance_officer'],
  decide_evidence_sufficiency: [
    'auditor',
    'independent_compliance_reviewer',
    'tenant_compliance_owner',
    'governance_officer',
  ],
  request_evidence_package: [
    'auditor',
    'independent_compliance_reviewer',
    'tenant_compliance_owner',
    'governance_officer',
  ],
  verify_evidence_package: [
    'auditor',
    'independent_compliance_reviewer',
    'tenant_compliance_owner',
    'governance_officer',
  ],
  ingest_control_observation: [
    'automation_principal',
    'operator',
    'control_owner',
    'governance_officer',
  ],
  request_impact_preview: [
    'automation_principal',
    'operator',
    'control_owner',
    'governance_officer',
    'tenant_compliance_owner',
  ],
  publish_governed_change: DECISION_ROLES,
  create_ai_use_case: [
    'ai_governance_officer',
    'governance_officer',
    'control_owner',
    'tenant_compliance_owner',
  ],
  transition_ai_use_case: ['ai_governance_officer', ...DECISION_ROLES],
  record_ai_evaluation: [
    'ai_governance_officer',
    'independent_compliance_reviewer',
    'control_owner',
    'governance_officer',
  ],
  report_ai_incident: [
    'automation_principal',
    'ai_governance_officer',
    'operator',
    'control_owner',
    'governance_officer',
    'tenant_compliance_owner',
  ],
  create_copilot_exchange: [
    'governance_officer',
    'ai_governance_officer',
    'control_owner',
    'auditor',
    'operator',
    'tenant_compliance_owner',
    'source_steward',
  ],
  create_connector_definition: [
    'integration_engineer',
    'operator',
    'source_steward',
    'governance_officer',
  ],
  request_connector_conformance: [
    'integration_engineer',
    'operator',
    'source_steward',
    'governance_officer',
  ],
  certify_connector_version: [
    'integration_engineer',
    'independent_compliance_reviewer',
    'authorized_approver',
    'governance_officer',
  ],
  revoke_connector_certification: ['integration_engineer', ...DECISION_ROLES],
  request_connector_reconciliation: [
    'automation_principal',
    'integration_engineer',
    'operator',
    'source_steward',
    'governance_officer',
  ],
  create_improvement_hypothesis: ['operator', 'governance_officer', 'tenant_compliance_owner'],
  transition_improvement_hypothesis: DECISION_ROLES,
  create_entity_resolution_case: [
    'source_steward',
    'operator',
    'governance_officer',
    'tenant_compliance_owner',
  ],
  transition_entity_resolution_case: [
    'source_steward',
    'authorized_approver',
    'governance_officer',
    'tenant_compliance_owner',
    'independent_compliance_reviewer',
  ],
};

function purposePrefixes(action: GovernedPlatformAction): readonly string[] {
  if (action === 'sign_review_snapshot') return ['review.'];
  if (action.includes('evidence')) return ['evidence.', 'audit.'];
  if (action.includes('connector')) return ['connector.', 'governance.'];
  if (action.includes('improvement')) return ['improvement.', 'governance.'];
  if (action.includes('entity_resolution')) return ['resolution.', 'governance.'];
  if (action.includes('ai_')) return ['ai.', 'governance.'];
  if (action.includes('copilot')) return ['copilot.', 'governance.'];
  if (action.includes('observation')) return ['monitoring.', 'control.'];
  if (action.includes('impact') || action.includes('change')) return ['change.', 'governance.'];
  return ['governance.', 'risk.', 'gap.', 'exception.', 'collaboration.'];
}

const FORBIDDEN_FIELDS = new Set([
  'tenant',
  'tenantid',
  'evidencebody',
  'rawcontent',
  'prompt',
  'secret',
  'token',
  'password',
  'credential',
]);

export interface GovernedPlatformAuthorityInput {
  readonly action: GovernedPlatformAction;
  readonly authenticatedTenantId: string;
  readonly resourceTenantId: string;
  readonly roles: readonly RoleKey[];
  readonly purpose?: string;
  readonly requestedFields?: readonly string[];
  readonly actorPrincipalId?: string;
  readonly requesterPrincipalId?: string;
  readonly ownerPrincipalId?: string;
  readonly boundaryOnly?: boolean;
}

export interface GovernedPlatformAuthorityDecision {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export function evaluateGovernedPlatformAuthority(
  input: GovernedPlatformAuthorityInput,
): GovernedPlatformAuthorityDecision {
  const reasons: string[] = [];
  if (
    input.authenticatedTenantId.length === 0 ||
    input.resourceTenantId.length === 0 ||
    input.authenticatedTenantId !== input.resourceTenantId
  ) {
    reasons.push('tenant_scope_denied');
  }
  if (!input.roles.some((role) => ACTION_ROLES[input.action].includes(role))) {
    reasons.push('role_action_denied');
  }
  if (!input.boundaryOnly) {
    const purpose = input.purpose?.trim();
    if (!purpose || !purposePrefixes(input.action).some((prefix) => purpose.startsWith(prefix))) {
      reasons.push('purpose_denied');
    }
    if (
      (input.requestedFields ?? []).some((field) =>
        FORBIDDEN_FIELDS.has(field.replace(/[_-]/g, '').toLowerCase()),
      )
    ) {
      reasons.push('field_disclosure_denied');
    }
    const sameRequester =
      input.actorPrincipalId !== undefined &&
      input.requesterPrincipalId !== undefined &&
      input.actorPrincipalId === input.requesterPrincipalId;
    const sameOwner =
      input.actorPrincipalId !== undefined &&
      input.ownerPrincipalId !== undefined &&
      input.actorPrincipalId === input.ownerPrincipalId;
    if (
      (sameRequester || sameOwner) &&
      [
        'decide_evidence_sufficiency',
        'publish_governed_change',
        'certify_connector_version',
        'transition_improvement_hypothesis',
        'transition_entity_resolution_case',
      ].includes(input.action)
    ) {
      reasons.push('separation_of_duties_denied');
    }
  }
  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}
