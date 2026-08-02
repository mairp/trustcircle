// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 9 · GOVERNANCE ASSURANCE — EVIDENCE-RETENTION release gate (browserless `evidence-retention`
// project · T281). Requirement GAR-010 (change discipline); rests on GAR-006 (evidence immutability
// / provenance / retention / access history).
//
// PHASE OBJECTIVE (T281): "Prove longest-policy retention, missing-policy gaps, legal holds,
// authorized release, disposition, and history preservation in tests/e2e/evidence-retention.spec.ts".
//
// ── WHAT THIS PROVES ────────────────────────────────────────────────────────────────────────────
// Drives the REAL packages/evidence/src/retention.ts (never a re-implementation):
//   1. LONGEST POLICY      — resolveRetention() returns the MAXIMUM retain-until across all applicable
//                            approved policies; a shorter policy never shortens retention.
//   2. MISSING-POLICY GAP  — when no approved policy applies, retainUntil is null (a visible GAP, not a
//                            silent "retain forever" or "dispose now"); the gate surfaces it explicitly.
//   3. LEGAL HOLDS         — while an active hold covers the item, evaluateDisposition() blocks
//                            disposition (fail-closed) even after retention elapses.
//   4. AUTHORIZED RELEASE  — releasing the hold (status → released) removes the block; an unauthorized
//                            request is still refused.
//   5. DISPOSITION         — recordDisposition() produces a SIGNED, tamper-evident record only when
//                            eligible, and throws DispositionNotPermittedError otherwise.
//   6. HISTORY PRESERVED   — the disposition record retains provenance (contentSha256, policy/hold IDs),
//                            authorization, executor, and the full access history.
//
// ── NON-VACUITY ─────────────────────────────────────────────────────────────────────────────────
// Every positive is paired with a NEGATIVE control (a tampered signature fails verification; an
// active hold blocks; an unauthorized request throws; retention-not-elapsed blocks).
//
// Determinism: fixed instants, no clock, Node built-ins + the REAL package source only.
// Run: TC_NO_WEBSERVER=1 playwright test --project=evidence-retention

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ret = (await import(
  join(ROOT, 'packages/evidence/src/retention.ts')
)) as typeof import('../../packages/evidence/src/retention.ts');

const {
  resolveRetention,
  activeHoldsFor,
  evaluateDisposition,
  recordDisposition,
  verifyDispositionRecord,
  DispositionNotPermittedError,
} = ret;

type EvidenceItem = import('../../packages/evidence/src/retention.ts').EvidenceItem;
type RetentionPolicy = import('../../packages/evidence/src/retention.ts').RetentionPolicy;
type LegalHold = import('../../packages/evidence/src/retention.ts').LegalHold;

const TENANT = '11111111-1111-7111-8111-111111111111';
const DAY = 24 * 60 * 60 * 1000;
const CREATED = 1_700_000_000_000;
const SIGNING_KEY = 'test-signing-key-do-not-ship';

const item: EvidenceItem = Object.freeze({
  evidenceItemId: 'ev-1',
  tenantId: TENANT,
  kind: 'original',
  contentSha256: 'a'.repeat(64),
  parentEvidenceId: null,
  classification: 'restricted',
  createdAt: CREATED,
});

function policy(id: string, days: number, opts: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return {
    policyId: id,
    tenantId: TENANT,
    appliesToClassifications: [],
    durationMillis: days * DAY,
    approved: true,
    ...opts,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. LONGEST-POLICY retention.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T281 · longest-applicable retention wins', () => {
  test('resolved retain-until is the MAX across applicable approved policies', () => {
    const r = resolveRetention(item, [policy('p30', 30), policy('p365', 365), policy('p90', 90)]);
    expect(r.retainUntil).toBe(CREATED + 365 * DAY);
    expect([...r.appliedPolicyIds].sort()).toEqual(['p30', 'p365', 'p90']);
  });

  test('NEGATIVE: an UNAPPROVED longer policy does not extend retention', () => {
    const r = resolveRetention(item, [policy('p30', 30), policy('pDraft', 1000, { approved: false })]);
    expect(r.retainUntil).toBe(CREATED + 30 * DAY);
    expect(r.appliedPolicyIds).not.toContain('pDraft');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. MISSING-POLICY GAP — no applicable policy is a visible gap (retainUntil === null).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T281 · missing-policy gap is explicit', () => {
  test('no applicable approved policy → retainUntil is null (a GAP, not silent forever/now)', () => {
    const r = resolveRetention(item, [
      policy('other-tenant', 30, { tenantId: '99999999-9999-7999-8999-999999999999' }),
      policy('other-class', 30, { appliesToClassifications: ['public'] }),
    ]);
    expect(r.retainUntil).toBeNull();
    expect(r.appliedPolicyIds).toEqual([]);
  });

  test('NEGATIVE: a class-matching policy is applied (proves the gap check is non-vacuous)', () => {
    const r = resolveRetention(item, [policy('match', 30, { appliesToClassifications: ['restricted'] })]);
    expect(r.retainUntil).toBe(CREATED + 30 * DAY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. LEGAL HOLDS block disposition even after retention elapses.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T281 · active legal hold blocks disposition', () => {
  const policies = [policy('p30', 30)];
  const afterRetention = CREATED + 31 * DAY;

  test('an active hold that covers the item blocks disposition after retention', () => {
    const holds: LegalHold[] = [
      { holdId: 'h1', tenantId: TENANT, scopeEvidenceIds: ['ev-1'], status: 'active' },
    ];
    expect(activeHoldsFor(item, holds)).toEqual(['h1']);
    const e = evaluateDisposition({
      item,
      policies,
      holds,
      authorization: { principalId: 'p', grantId: 'g' },
      now: afterRetention,
    });
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain('active-legal-hold');
  });

  test('NEGATIVE: a released hold no longer blocks (authorized release)', () => {
    const holds: LegalHold[] = [
      { holdId: 'h1', tenantId: TENANT, scopeEvidenceIds: ['ev-1'], status: 'released' },
    ];
    expect(activeHoldsFor(item, holds)).toEqual([]);
    const e = evaluateDisposition({
      item,
      policies,
      holds,
      authorization: { principalId: 'p', grantId: 'g' },
      now: afterRetention,
    });
    expect(e.eligible).toBe(true);
    expect(e.reasons).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. AUTHORIZED RELEASE / DISPOSITION + HISTORY PRESERVATION.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T281 · signed disposition preserves history & authorization', () => {
  const policies = [policy('p30', 30)];
  const afterRetention = CREATED + 31 * DAY;
  const accessHistory = [
    { principalId: 'auditor-1', action: 'view', at: CREATED + DAY },
    { principalId: 'steward-1', action: 'export', at: CREATED + 2 * DAY },
  ];

  test('an eligible, authorized disposition produces a signed record that verifies and retains history', () => {
    const rec = recordDisposition({
      item,
      policies,
      holds: [],
      authorization: { principalId: 'officer-1', grantId: 'grant-1' },
      now: afterRetention,
      method: 'crypto-shred',
      executedBy: 'officer-1',
      accessHistory,
      signingKey: SIGNING_KEY,
    });
    // signature verifies (tamper-evident)
    expect(verifyDispositionRecord(rec, SIGNING_KEY)).toBe(true);
    // provenance + authorization + executor + history preserved
    expect(rec.contentSha256).toBe(item.contentSha256);
    expect(rec.resolvedPolicyIds).toEqual(['p30']);
    expect(rec.authorization).toEqual({ principalId: 'officer-1', grantId: 'grant-1' });
    expect(rec.executedBy).toBe('officer-1');
    expect(rec.accessHistory).toEqual(accessHistory);
  });

  test('NEGATIVE: a tampered disposition record fails signature verification', () => {
    const rec = recordDisposition({
      item,
      policies,
      holds: [],
      authorization: { principalId: 'officer-1', grantId: 'grant-1' },
      now: afterRetention,
      method: 'delete',
      executedBy: 'officer-1',
      accessHistory,
      signingKey: SIGNING_KEY,
    });
    const tampered = { ...rec, method: 'archive' as const };
    expect(verifyDispositionRecord(tampered, SIGNING_KEY)).toBe(false);
  });

  test('NEGATIVE: an unauthorized disposition throws (fail-closed)', () => {
    expect(() =>
      recordDisposition({
        item,
        policies,
        holds: [],
        authorization: null,
        now: afterRetention,
        method: 'delete',
        executedBy: 'nobody',
        accessHistory,
        signingKey: SIGNING_KEY,
      }),
    ).toThrow(DispositionNotPermittedError);
  });

  test('NEGATIVE: disposing before retention elapses throws (retention-not-elapsed)', () => {
    let thrown: unknown = null;
    try {
      recordDisposition({
        item,
        policies,
        holds: [],
        authorization: { principalId: 'officer-1', grantId: 'grant-1' },
        now: CREATED + DAY, // before the 30-day retention
        method: 'delete',
        executedBy: 'officer-1',
        accessHistory,
        signingKey: SIGNING_KEY,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DispositionNotPermittedError);
    expect((thrown as InstanceType<typeof DispositionNotPermittedError>).reasons).toContain(
      'retention-not-elapsed',
    );
  });
});
