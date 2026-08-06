import { describe, expect, it } from 'vitest';

import {
  OperationsContractError,
  encodeOperationsPageCursor,
  operationalCaseEtag,
  parseCreateOperationalCaseRequest,
  parseOperationsLimit,
  parseOperationsPageCursor,
  parseSlaEvaluationRequest,
  parseTransitionOperationalCaseRequest,
  requireOperationalCaseIfMatch,
  requireOperationsIdempotencyKey,
} from '../../packages/contracts/src/operations-api.ts';

const source = {
  domain: 'decision',
  record_type: 'decision_request',
  record_id: 'decision-1',
  record_version: '4',
  governed_problem_key: 'release-42-governance',
  href: '/v1/decisions/decision-1',
  observed_at: '2027-01-15T08:00:00.000Z',
  source_owner_id: 'owner-a',
  resolved: false,
} as const;

describe('operations API command contracts', () => {
  it('accepts a complete case request and rejects unknown or cross-contract fields', () => {
    const request = {
      source_references: [source],
      title: 'Governed production release response',
      priority: 'high',
      owner_id: 'owner-a',
      rationale: 'Operator confirmed the governed operational response.',
      service_level_policy_id: 'ops-standard',
      service_level_policy_version: '2026.1',
    };
    expect(parseCreateOperationalCaseRequest(request).source_references).toHaveLength(1);
    expect(() =>
      parseCreateOperationalCaseRequest({ ...request, tenant_id: 'tenant-a' }),
    ).toThrowError(OperationsContractError);
  });

  it('validates governed transitions, SLA evaluation, pagination, and idempotency boundaries', () => {
    expect(
      parseTransitionOperationalCaseRequest({
        command: 'submit_verification',
        reason: 'Current sources are resolved and evidence is attached.',
        expected_version: 4,
        evidence_references: ['evidence://run/42'],
        source_versions: [{ ...source, resolved: true }],
      }).command,
    ).toBe('submit_verification');
    expect(
      parseSlaEvaluationRequest({
        expected_version: 1,
        evaluated_at: '2027-01-15T08:06:00.000Z',
        reason: 'Scheduled service level evaluation completed.',
      }).expected_version,
    ).toBe(1);
    expect(parseOperationsLimit('500')).toBe(500);
    expect(() => parseOperationsLimit('501')).toThrowError(OperationsContractError);
    expect(requireOperationsIdempotencyKey('operations-key-01')).toBe('operations-key-01');
    expect(() => requireOperationsIdempotencyKey('short')).toThrowError(OperationsContractError);
  });

  it('round-trips strict opaque page cursors and rejects malformed cursor state', () => {
    const cursor = encodeOperationsPageCursor({ snapshot: 'a'.repeat(64), offset: 100 });
    expect(parseOperationsPageCursor(cursor)).toEqual({ snapshot: 'a'.repeat(64), offset: 100 });
    expect(() =>
      parseOperationsPageCursor(
        Buffer.from(JSON.stringify({ snapshot: 'a'.repeat(64), offset: -1 }), 'utf8').toString(
          'base64url',
        ),
      ),
    ).toThrowError(OperationsContractError);
    expect(() => parseOperationsPageCursor('not-json')).toThrowError(OperationsContractError);
  });

  it('requires an exact case ETag for optimistic concurrency', () => {
    const current = { version: 7 };
    const tag = operationalCaseEtag(current);
    expect(() => requireOperationalCaseIfMatch(tag, current)).not.toThrow();
    expect(() => requireOperationalCaseIfMatch('"oc-6-stale"', current)).toThrowError(
      OperationsContractError,
    );
  });
});
