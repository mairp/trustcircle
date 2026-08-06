import { describe, expect, it } from 'vitest';

import {
  isVerifiedEmpty,
  safeDiagnostic,
  validateEnvelope,
} from '../../apps/web/src/lib/read-model.ts';

const current = {
  apiVersion: 1,
  contractVersion: '1.0',
  tenantId: 'tenant-a',
  domain: 'inventory',
  data: { items: [] },
  source: 'API /v1/inventory/assets',
  observedAt: '2026-08-04T00:00:00Z',
  receivedAt: '2026-08-04T00:00:01Z',
  freshnessObjectiveMs: 60_000,
  quality: 'current',
  partialFailures: [],
};

describe('governed read envelope', () => {
  it('accepts a current tenant-matched envelope and proves empty', () => {
    const result = validateEnvelope<typeof current.data>(current, {
      tenantId: 'tenant-a',
      domain: 'inventory',
      nowMs: Date.parse('2026-08-04T00:00:30Z'),
    });
    expect(result.ok).toBe(true);
    expect(result.envelope && isVerifiedEmpty(result.envelope)).toBe(true);
  });

  it('derives stale and rejects tenant/version/malformed metadata', () => {
    expect(
      validateEnvelope(current, {
        tenantId: 'tenant-a',
        domain: 'inventory',
        nowMs: Date.parse('2026-08-04T00:02:00Z'),
      }).quality,
    ).toBe('stale');
    expect(
      validateEnvelope(current, { tenantId: 'tenant-b', domain: 'inventory' }).diagnostic,
    ).toBe('scope_mismatch');
    expect(
      validateEnvelope({ ...current, apiVersion: 2 }, { tenantId: 'tenant-a', domain: 'inventory' })
        .diagnostic,
    ).toBe('incompatible_version');
    expect(
      validateEnvelope(
        { ...current, observedAt: null },
        { tenantId: 'tenant-a', domain: 'inventory' },
      ).quality,
    ).toBe('unknown');
  });

  it('does not expose arbitrary upstream error content', () => {
    expect(safeDiagnostic({ error: 'FORBIDDEN', correlationId: 'corr-safe-123' })).toBe(
      'FORBIDDEN · corr-safe-123',
    );
    expect(safeDiagnostic({ error: '<script>', correlationId: 'token=secret' })).toBeUndefined();
  });
});
