import { describe, expect, it } from 'vitest';

import {
  GOVERNED_PLATFORM_ACTIONS,
  evaluateGovernedPlatformAuthority,
  type GovernedPlatformAction,
  type RoleKey,
} from '@trustcircle/authz';
import {
  Database,
  IncompleteAuditError,
  commitUnitOfWork,
  type SqlDriver,
} from '@trustcircle/persistence';

import { createUowDriver } from '../persistence/uow-in-memory-driver.mjs';

const TENANT = 'tenant-a';

function purposeFor(action: GovernedPlatformAction): string {
  if (action === 'sign_review_snapshot') return 'review.period_close';
  if (action.includes('evidence')) return 'evidence.assurance';
  if (action.includes('connector')) return 'connector.lifecycle';
  if (action.includes('improvement')) return 'improvement.review';
  if (action.includes('entity_resolution')) return 'resolution.review';
  if (action.includes('ai_')) return 'ai.lifecycle';
  if (action.includes('copilot')) return 'copilot.assistance';
  if (action.includes('observation')) return 'monitoring.observe';
  if (action.includes('impact') || action.includes('change')) return 'change.preview';
  return 'governance.lifecycle';
}

function decision(
  action: GovernedPlatformAction,
  roles: readonly RoleKey[],
  overrides: Partial<Parameters<typeof evaluateGovernedPlatformAuthority>[0]> = {},
) {
  return evaluateGovernedPlatformAuthority({
    action,
    authenticatedTenantId: TENANT,
    resourceTenantId: TENANT,
    roles,
    purpose: purposeFor(action),
    requestedFields: ['status', 'owner_principal_id', 'updated_at'],
    actorPrincipalId: 'actor-a',
    requesterPrincipalId: 'requester-b',
    ownerPrincipalId: 'owner-c',
    ...overrides,
  });
}

describe('Spec 004 consequential authority matrix', () => {
  it('covers every declared action with an explicit allowed governance role', () => {
    expect(GOVERNED_PLATFORM_ACTIONS).toHaveLength(27);
    for (const action of GOVERNED_PLATFORM_ACTIONS) {
      expect(decision(action, ['governance_officer']), action).toEqual({
        allowed: true,
        reasons: [],
      });
    }
  });

  it('denies every action to platform administration alone and every cross-tenant request', () => {
    for (const action of GOVERNED_PLATFORM_ACTIONS) {
      expect(decision(action, ['platform_admin']).reasons, action).toContain('role_action_denied');
      expect(
        decision(action, ['governance_officer'], { resourceTenantId: 'tenant-b' }).reasons,
        action,
      ).toContain('tenant_scope_denied');
    }
  });

  it('requires a bounded action purpose and rejects direct identifiers, evidence bodies, and secrets', () => {
    for (const action of GOVERNED_PLATFORM_ACTIONS) {
      expect(
        decision(action, ['governance_officer'], { purpose: 'unrelated.use' }).reasons,
      ).toContain('purpose_denied');
      expect(
        decision(action, ['governance_officer'], {
          requestedFields: ['status', 'tenant_id', 'evidence_body', 'secret'],
        }).reasons,
      ).toContain('field_disclosure_denied');
    }
  });

  it('limits automation to observation, preview, incident reporting, and reconciliation work', () => {
    const allowed = new Set<GovernedPlatformAction>([
      'ingest_control_observation',
      'request_impact_preview',
      'report_ai_incident',
      'request_connector_reconciliation',
    ]);
    for (const action of GOVERNED_PLATFORM_ACTIONS) {
      expect(decision(action, ['automation_principal']).allowed, action).toBe(allowed.has(action));
    }
  });

  it('enforces independent decision makers for assurance, publication, certification, improvement, and resolution', () => {
    const independentActions: readonly GovernedPlatformAction[] = [
      'decide_evidence_sufficiency',
      'publish_governed_change',
      'certify_connector_version',
      'transition_improvement_hypothesis',
      'transition_entity_resolution_case',
    ];
    for (const action of independentActions) {
      expect(
        decision(action, ['governance_officer'], {
          actorPrincipalId: 'same',
          requesterPrincipalId: 'same',
          ownerPrincipalId: 'same',
        }).reasons,
        action,
      ).toContain('separation_of_duties_denied');
    }
  });

  it('preserves bounded specialist roles without granting unrelated authority', () => {
    expect(decision('transition_ai_use_case', ['ai_governance_officer']).allowed).toBe(true);
    expect(decision('create_connector_definition', ['integration_engineer']).allowed).toBe(true);
    expect(decision('publish_governed_change', ['integration_engineer']).allowed).toBe(false);
    expect(decision('certify_connector_version', ['ai_governance_officer']).allowed).toBe(false);
    expect(decision('attest_evidence', ['control_owner']).allowed).toBe(true);
    expect(decision('decide_evidence_sufficiency', ['auditor']).allowed).toBe(true);
  });
});
describe('Spec 004 audit atomicity', () => {
  it('rolls back canonical, audit, and outbox effects when accountability evidence is missing', async () => {
    const driver = createUowDriver();
    const database = new Database(driver as unknown as SqlDriver, {
      clock: () => 1_800_000_000_000,
    });
    await expect(
      commitUnitOfWork(database, {
        tenantId: TENANT,
        operationScope: 'governed-platform.register_record',
        idempotencyKey: 'audit-missing-1',
        correlationId: 'correlation-audit-missing-1',
        contract: {
          sourceId: 'trustcircle',
          version: '1.0.0',
          contractDigest: 'contract-digest',
          validated: true,
        },
        expectedContractVersion: '1.0.0',
        request: { action: 'approve' },
        canonical: {
          entityKind: 'governed_platform.resource.register_record',
          entityId: 'record-1',
          expectedVersion: 0,
          state: { status: 'approved' },
        },
        action: 'register.record.approved.v1',
        audit: {
          actor: 'approver-a',
          owner: 'owner-b',
          reason: { code: 'governance.approve', text: 'Approve independently.' },
          sourceStateDigest: 'source-digest',
          targetStateDigest: 'target-digest',
          scope: 'tenant:tenant-a/register:record-1',
          policyVersion: 'policy-1',
          controlVersion: 'control-1',
          evidenceRefs: [],
        },
        outbox: { topic: 'register.record.approved.v1', payload: { id: 'record-1' } },
      }),
    ).rejects.toBeInstanceOf(IncompleteAuditError);
    expect(driver.__committed.canonical_state.size).toBe(0);
    expect(driver.__committed.audit_event.size).toBe(0);
    expect(driver.__committed.outbox_message.size).toBe(0);
  });
});
