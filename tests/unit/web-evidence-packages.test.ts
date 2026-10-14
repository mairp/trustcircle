import { describe, expect, it } from 'vitest';

import {
  isPackageId,
  parseStoredPackages,
  parseVerification,
  updatePackage,
  upsertPackage,
  verificationReceipt,
  type SessionPackage,
} from '../../apps/web/src/lib/evidence-packages.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const base = (id: string): SessionPackage => ({
  id,
  requestedAt: '2026-10-15T10:00:00.000Z',
  status: 'requested',
});

describe('session evidence packages', () => {
  it('keeps the newest first without duplicates and updates in place', () => {
    let list = upsertPackage([], base(P1));
    list = upsertPackage(list, base(P2));
    list = upsertPackage(list, { ...base(P1), status: 'accepted' });
    expect(list.map((p) => [p.id, p.status])).toEqual([
      [P1, 'accepted'],
      [P2, 'requested'],
    ]);
    expect(updatePackage(list, P2, { status: 'not_accepted' })[1]?.status).toBe('not_accepted');
  });

  it('accepts only a boolean verdict from the verification endpoint', () => {
    expect(parseVerification({ valid: 'yes' })).toBeUndefined();
    expect(parseVerification(null)).toBeUndefined();
    expect(
      parseVerification({
        valid: false,
        reason: 'entry digest mismatch',
        canonical_digest: 'abc',
        verified_at: '2026-10-15T10:05:00.000Z',
      }),
    ).toEqual({
      valid: false,
      reason: 'entry digest mismatch',
      canonicalDigest: 'abc',
      verifiedAt: '2026-10-15T10:05:00.000Z',
    });
  });

  it('builds a receipt only for a verified package and states its claim boundary', () => {
    expect(() => verificationReceipt(base(P1))).toThrow();
    const receipt = verificationReceipt({
      ...base(P1),
      evidenceRequestId: P2,
      status: 'verified',
      verification: { valid: true, reason: null, canonicalDigest: 'd1', verifiedAt: 't1' },
    });
    expect(receipt).toMatchObject({ package_id: P1, evidence_request_id: P2, valid: true });
    expect(String(receipt['claim_boundary'])).toMatch(/not an audit opinion or a certification/);
  });

  it('drops malformed stored entries instead of trusting them', () => {
    const stored = JSON.stringify([
      base(P1),
      { id: 'not-a-uuid', requestedAt: 'x', status: 'requested' },
      { id: P2, requestedAt: 'x', status: 'certified' },
      { ...base(P2), verification: { valid: 'true' } },
    ]);
    const parsed = parseStoredPackages(stored);
    expect(parsed.map((p) => p.id)).toEqual([P1, P2]);
    expect(parsed[1]?.verification).toBeUndefined();
    expect(parseStoredPackages('{not json')).toEqual([]);
    expect(isPackageId(` ${P1} `)).toBe(true);
  });
});
