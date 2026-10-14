import { describe, expect, it } from 'vitest';

import {
  DecisionInputError,
  actingPosition,
  openRequirements,
  parseDecision,
  parseDecisionActionForm,
  timePosture,
} from '../../apps/web/src/lib/decision-view.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const DECISION_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';

const wire = (overrides: Record<string, unknown> = {}) => ({
  id: DECISION_ID,
  tenant_id: '00000000-0000-4000-8000-000000000001',
  work_item_id: '44444444-4444-4444-8444-444444444444',
  requester_principal_id: REQUESTER,
  requested_action: 'Promote fraud model v7 to production',
  action_class: 'deployment',
  risk_tier: 'high',
  scope: { asset: 'fraud-model' },
  business_impact: { customers: 'all card payments' },
  risks: [{ risk: 'false declines' }],
  alternatives: [{ option: 'shadow mode for two weeks' }],
  expected_result: { metric: 'fraud loss -12%' },
  status: 'pending',
  version: 3,
  created_at: '2026-10-14T09:00:00Z',
  expires_at: '2026-10-17T09:00:00Z',
  requirements: [
    {
      id: 'r1',
      gate_type: 'risk_acceptance',
      tenant_id: null,
      status: 'pending',
      minimum_distinct_principals: 2,
    },
    {
      id: 'r2',
      gate_type: 'evidence',
      tenant_id: null,
      status: 'satisfied',
      minimum_distinct_principals: 1,
    },
  ],
  ...overrides,
});

const form = (entries: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
};

describe('parseDecision', () => {
  it('maps the wire package and refuses rows without identity or version', () => {
    const decision = parseDecision(wire());
    expect(decision?.requestedAction).toBe('Promote fraud model v7 to production');
    expect(decision?.requirements[0]?.minimumDistinctPrincipals).toBe(2);
    expect(parseDecision(wire({ id: '' }))).toBeUndefined();
    expect(parseDecision(wire({ version: 0 }))).toBeUndefined();
    expect(parseDecision('not an object')).toBeUndefined();
  });

  it('counts only satisfied gates as closed; unknown and refused waivers stay open', () => {
    const decision = parseDecision(
      wire({
        requirements: [
          { id: 'a', gate_type: 'x', status: 'satisfied', minimum_distinct_principals: 1 },
          { id: 'b', gate_type: 'x', status: 'waived_forbidden', minimum_distinct_principals: 1 },
          { id: 'c', gate_type: 'x', status: 'mystery', minimum_distinct_principals: 1 },
        ],
      }),
    )!;
    expect(openRequirements(decision).map((g) => g.id)).toEqual(['b', 'c']);
  });
});

describe('timePosture', () => {
  it('states expiry in words and never guesses', () => {
    expect(timePosture('2026-10-17T09:00:00Z', NOW)).toBe('fresh');
    expect(timePosture('2026-10-15T20:00:00Z', NOW)).toBe('expiring_soon');
    expect(timePosture('2026-10-15T11:59:00Z', NOW)).toBe('expired');
    expect(timePosture('', NOW)).toBe('unknown');
  });
});

describe('actingPosition', () => {
  const decision = parseDecision(wire())!;

  it('offers review actions to an authorized reviewer who is not the requester', () => {
    const position = actingPosition(decision, REVIEWER, true, true, NOW);
    expect(position).toMatchObject({ canReview: true, canDelegate: true, canCancel: false });
    expect(position.blockedReason).toBeUndefined();
  });

  it('refuses self-approval and explains separation of duties, but lets the requester withdraw', () => {
    const position = actingPosition(decision, REQUESTER, true, true, NOW);
    expect(position.canReview).toBe(false);
    expect(position.canCancel).toBe(true);
    expect(position.blockedReason).toMatch(/separation of duties/i);
  });

  it('explains read-only roles, closed and expired packages', () => {
    expect(actingPosition(decision, REVIEWER, false, false, NOW).blockedReason).toMatch(
      /no decision authority/i,
    );
    const closed = parseDecision(wire({ status: 'approved' }))!;
    expect(actingPosition(closed, REVIEWER, true, true, NOW)).toMatchObject({
      canReview: false,
      canCancel: false,
    });
    const expired = parseDecision(wire({ expires_at: '2026-10-15T00:00:00Z' }))!;
    expect(actingPosition(expired, REVIEWER, true, true, NOW).blockedReason).toMatch(/expired/i);
  });
});

describe('parseDecisionActionForm', () => {
  const base = { decision_id: DECISION_ID, etag: '"v3"' };

  it('builds the exact API body for a review action', () => {
    const parsed = parseDecisionActionForm(
      form({
        ...base,
        action: 'approve',
        reason_code: 'risk.accepted',
        reason_text: 'Shadow results reviewed; residual risk accepted.',
      }),
    );
    expect(parsed).toEqual({
      decisionId: DECISION_ID,
      etag: '"v3"',
      body: {
        action: 'approve',
        reason: {
          code: 'risk.accepted',
          text: 'Shadow results reviewed; residual risk accepted.',
        },
      },
    });
  });

  it('rejects a reason that does not belong to the chosen action, and a missing explanation', () => {
    const wrongCode = form({
      ...base,
      action: 'approve',
      reason_code: 'risk.unacceptable',
      reason_text: 'ok then',
    });
    expect(() => parseDecisionActionForm(wrongCode)).toThrow(DecisionInputError);
    const noText = form({
      ...base,
      action: 'deny',
      reason_code: 'risk.unacceptable',
      reason_text: ' ',
    });
    expect(() => parseDecisionActionForm(noText)).toThrow(/3 to 4000/);
    const expire = form({
      ...base,
      action: 'expire',
      reason_code: 'risk.accepted',
      reason_text: 'abc',
    });
    expect(() => parseDecisionActionForm(expire)).toThrow(/Choose an action/);
  });

  it('requires a version to bind to', () => {
    const noEtag = form({
      decision_id: DECISION_ID,
      etag: '',
      action: 'approve',
      reason_code: 'risk.accepted',
      reason_text: 'abc',
    });
    expect(() => parseDecisionActionForm(noEtag)).toThrow(/version/);
  });

  it('builds a time-bound delegation, reading datetime-local inputs as UTC', () => {
    const parsed = parseDecisionActionForm(
      form({
        ...base,
        action: 'delegate',
        reason_code: 'availability.absence',
        reason_text: 'On leave until Monday.',
        recipient_principal_id: REVIEWER,
        authority_assignment_id: '55555555-5555-4555-8555-555555555555',
        delegated_actions: ['approve', 'deny', 'approve', 'expire'],
        valid_from: '2026-10-15T13:00',
        delegation_expires_at: '2026-10-20T13:00',
      }),
    );
    expect(parsed.body['delegation']).toEqual({
      recipient_principal_id: REVIEWER,
      authority_assignment_id: '55555555-5555-4555-8555-555555555555',
      scope: { decision_id: DECISION_ID },
      actions: ['approve', 'deny'],
      reason: { code: 'availability.absence', text: 'On leave until Monday.' },
      valid_from: '2026-10-15T13:00:00.000Z',
      expires_at: '2026-10-20T13:00:00.000Z',
    });
  });

  it('refuses a delegation that ends before it starts or names no actions', () => {
    const delegation = {
      ...base,
      action: 'delegate',
      reason_code: 'availability.absence',
      reason_text: 'On leave.',
      recipient_principal_id: REVIEWER,
      authority_assignment_id: '55555555-5555-4555-8555-555555555555',
    };
    expect(() =>
      parseDecisionActionForm(
        form({
          ...delegation,
          delegated_actions: 'approve',
          valid_from: '2026-10-20T13:00',
          delegation_expires_at: '2026-10-15T13:00',
        }),
      ),
    ).toThrow(/end after it starts/);
    expect(() =>
      parseDecisionActionForm(
        form({
          ...delegation,
          valid_from: '2026-10-15T13:00',
          delegation_expires_at: '2026-10-20T13:00',
        }),
      ),
    ).toThrow(/at least one action/);
  });
});
