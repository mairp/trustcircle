import { readFileSync } from 'node:fs';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  GovernedPlatformContractError,
  decodeGovernedPageCursor,
  encodeGovernedPageCursor,
  parseGovernedCommand,
  parseGovernedSignedCommand,
  parseGovernedTransition,
  requireGovernedCorrelationId,
  requireGovernedIdempotencyKey,
  requireGovernedIfMatch,
} from '../../packages/contracts/src/governed-platform-api.ts';

const API_PATH =
  'specs/004-governed-platform-continuation/contracts/governed-platform.openapi.yaml';

describe('governed platform authored OpenAPI contract', () => {
  const document = yaml.load(readFileSync(API_PATH, 'utf8')) as {
    openapi: string;
    paths: Record<string, Record<string, { operationId?: string; parameters?: unknown[] }>>;
  };

  it('is additive v1 OpenAPI with unique operation IDs for all continuation resources', () => {
    expect(document.openapi).toBe('3.1.0');
    const operationIds = Object.values(document.paths).flatMap((path) =>
      Object.values(path)
        .map((operation) => operation.operationId)
        .filter((value): value is string => typeof value === 'string'),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).toContain('signReviewSnapshot');
    expect(operationIds).toContain('transitionRegisterRecord');
    expect(operationIds).toContain('decideEvidenceSufficiency');
    expect(operationIds).toContain('publishGovernedChange');
    expect(operationIds).toContain('transitionAiUseCase');
    expect(operationIds).toContain('certifyConnectorVersion');
    expect(operationIds).toContain('decideEntityResolution');
    expect(operationIds).toContain('getFrameworkMatrix');
  });
});

describe('governed platform runtime command contract', () => {
  const reason = { code: 'review.approved', text: 'Independent reviewer approved this action.' };

  it('accepts a bounded command but rejects tenant authority and unknown fields in the body', () => {
    expect(
      parseGovernedCommand({
        schema_version: 1,
        reason,
        input: { review_id: 'review-1' },
      }),
    ).toEqual({
      schema_version: 1,
      reason,
      input: { review_id: 'review-1' },
    });
    expect(() =>
      parseGovernedCommand({
        schema_version: 1,
        reason,
        input: {},
        tenant_id: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrowError(GovernedPlatformContractError);
  });

  it('accepts only a strict digest-bound signed command', () => {
    const signed = parseGovernedSignedCommand({
      schema_version: 1,
      reason,
      input: { evidence_versions: [{ id: 'evidence-1', version: 3 }] },
      signature: {
        algorithm: 'test-sha256',
        key_id: 'key-1',
        digest: 'a'.repeat(64),
        value: 'signature-value',
      },
    });
    expect(signed.signature.digest).toBe('a'.repeat(64));
    expect(() =>
      parseGovernedSignedCommand({
        schema_version: 1,
        reason,
        input: {},
        signature: {
          algorithm: 'test-sha256',
          key_id: 'key-1',
          digest: 'not-a-digest',
          value: 'signature-value',
          tenant_id: 'forbidden',
        },
      }),
    ).toThrowError(GovernedPlatformContractError);
  });
  it('validates reason, authority decision, transition, correlation, idempotency, and ETag', () => {
    expect(
      parseGovernedTransition({
        transition: 'approve',
        reason,
        authority_decision_id: '00000000-0000-4000-8000-000000000001',
        input: {},
      }).transition,
    ).toBe('approve');
    expect(() =>
      parseGovernedTransition({ transition: 'approve', reason, input: {} }),
    ).toThrowError(GovernedPlatformContractError);
    expect(requireGovernedCorrelationId('correlation-0001')).toBe('correlation-0001');
    expect(requireGovernedIdempotencyKey('idempotency-0001')).toBe('idempotency-0001');
    expect(requireGovernedIfMatch('"7"')).toBe(7);
    expect(() => requireGovernedIfMatch('7')).toThrowError(GovernedPlatformContractError);
  });

  it('round-trips strict opaque page cursors and rejects modified cursor data', () => {
    const cursor = encodeGovernedPageCursor({
      source_cursor: 'event-0007',
      offset: 25,
      query_digest: 'a'.repeat(64),
    });
    expect(decodeGovernedPageCursor(cursor)).toEqual({
      source_cursor: 'event-0007',
      offset: 25,
      query_digest: 'a'.repeat(64),
    });
    expect(() => decodeGovernedPageCursor('not-a-cursor')).toThrowError(
      GovernedPlatformContractError,
    );
  });
});
