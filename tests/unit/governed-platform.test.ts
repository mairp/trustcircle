import { describe, expect, it } from 'vitest';

import {
  GOVERNED_REGISTER_KINDS,
  GOVERNED_VISIBILITY_STATES,
  GovernedPlatformInvariantError,
  assertDistinctGovernedAuthority,
  assertExpectedGovernedVersion,
  assertGovernedTenant,
  canonicalGovernedJson,
  classifyGovernedVisibility,
  governedDigest,
  isGovernedRegisterTransitionAllowed,
  makeGovernedProjectionMetadata,
} from '@trustcircle/domain';

describe('governed platform shared invariants', () => {
  it('keeps the register and visibility vocabularies closed and truthful', () => {
    expect(GOVERNED_REGISTER_KINDS).toEqual(['risk', 'gap', 'exception', 'improvement']);
    expect(GOVERNED_VISIBILITY_STATES).toContain('unknown');
    expect(GOVERNED_VISIBILITY_STATES).toContain('partial');
    expect(GOVERNED_VISIBILITY_STATES).toContain('conflicting');
    expect(GOVERNED_VISIBILITY_STATES).not.toContain('compliant');
  });

  it('canonicalizes nested objects deterministically and produces a stable SHA-256 digest', () => {
    const left = { z: 1, nested: { b: true, a: ['x', 2] }, a: null };
    const right = { a: null, nested: { a: ['x', 2], b: true }, z: 1 };
    expect(canonicalGovernedJson(left)).toBe(canonicalGovernedJson(right));
    expect(governedDigest(left)).toBe(governedDigest(right));
    expect(governedDigest(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed on cross-tenant, stale-version, and self-approval attempts', () => {
    expect(() => assertGovernedTenant('tenant-a', 'tenant-b')).toThrowError(
      GovernedPlatformInvariantError,
    );
    expect(() => assertExpectedGovernedVersion(4, 3)).toThrowError(GovernedPlatformInvariantError);
    expect(() => assertDistinctGovernedAuthority('principal-a', 'principal-a')).toThrowError(
      GovernedPlatformInvariantError,
    );
    expect(() => assertGovernedTenant('tenant-a', 'tenant-a')).not.toThrow();
    expect(() => assertExpectedGovernedVersion(4, 4)).not.toThrow();
  });

  it('allows only kind-specific register transitions and closes expired exceptions', () => {
    expect(isGovernedRegisterTransitionAllowed('gap', 'active', 'pending_verification')).toBe(true);
    expect(isGovernedRegisterTransitionAllowed('gap', 'active', 'accepted')).toBe(false);
    expect(isGovernedRegisterTransitionAllowed('exception', 'pending_approval', 'approved')).toBe(
      true,
    );
    expect(isGovernedRegisterTransitionAllowed('exception', 'expired', 'approved')).toBe(false);
  });

  it('classifies stale, missing, partial, conflicting, and unavailable inputs without false pass', () => {
    expect(classifyGovernedVisibility({ present: false, fresh: false })).toBe('unknown');
    expect(classifyGovernedVisibility({ present: true, fresh: false })).toBe('stale');
    expect(classifyGovernedVisibility({ present: true, fresh: true, partial: true })).toBe(
      'partial',
    );
    expect(classifyGovernedVisibility({ present: true, fresh: true, conflicting: true })).toBe(
      'conflicting',
    );
    expect(classifyGovernedVisibility({ present: true, fresh: true, available: false })).toBe(
      'unavailable',
    );
    expect(classifyGovernedVisibility({ present: true, fresh: true })).toBe('current');
  });

  it('requires explicit projection cursor, time, rebuild version, and visible gaps', () => {
    expect(
      makeGovernedProjectionMetadata({
        sourceCursor: 'event-42',
        generatedAt: 1_800_000_000_000,
        rebuildVersion: 2,
        visibility: 'partial',
        coverageGaps: ['connector unavailable'],
      }),
    ).toEqual({
      sourceCursor: 'event-42',
      generatedAt: 1_800_000_000_000,
      rebuildVersion: 2,
      visibility: 'partial',
      partialCoverage: true,
      coverageGaps: ['connector unavailable'],
    });
  });
});

const {
  compareReviewSnapshots,
  correctReviewSnapshot,
  createSignedReviewSnapshot,
  verifyReviewSnapshotDigest,
} = await import('../../packages/application/src/review-snapshot-service.ts');

const reviewSource = {
  tenantId: 'tenant-a',
  reviewId: 'review-1',
  reviewVersion: 2,
  completed: true,
  scope: { systemIds: ['system-1'] },
  periodStart: 1_700_000_000_000,
  periodEnd: 1_800_000_000_000,
  registryVersions: ['iso-42001:2023'],
  policyVersions: ['policy-1'],
  sourceRevisionSet: ['controls:7', 'risks:4'],
  outcomes: [
    { key: 'control:c-1', type: 'control', status: 'fail', recordRef: '/controls/c-1' },
    { key: 'risk:r-1', type: 'risk', status: 'high', recordRef: '/risks/r-1' },
  ],
  evidenceRefs: ['evidence-1'],
  decisionRefs: ['decision-1'],
  authorPrincipalIds: ['author-a'],
} as const;

function signSnapshot(overrides: Partial<Parameters<typeof createSignedReviewSnapshot>[0]> = {}) {
  return createSignedReviewSnapshot({
    snapshotId: 'snapshot-1',
    source: reviewSource,
    signerPrincipalId: 'signer-a',
    signerRole: 'governance_officer',
    authorityDecisionId: 'authority-1',
    requireIndependentSigner: true,
    signedAt: 1_800_000_000_100,
    signatureAlgorithm: 'test-sha256',
    signatureKeyId: 'test-key-1',
    signDigest: (digest) => 'signature:' + digest,
    ...overrides,
  });
}

describe('signed review snapshots and comparison', () => {
  it('creates an immutable version-bound snapshot whose digest is stable after source changes', () => {
    const mutable = structuredClone(reviewSource);
    const snapshot = signSnapshot({ source: mutable });
    mutable.outcomes[0]!.status = 'pass';
    expect(snapshot.outcomes[0]?.status).toBe('fail');
    expect(snapshot.canonicalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.signature).toBe('signature:' + snapshot.canonicalDigest);
    expect(verifyReviewSnapshotDigest(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.outcomes)).toBe(true);
  });

  it('rejects incomplete reviews, missing authority, and self-signing when independence applies', () => {
    expect(() => signSnapshot({ source: { ...reviewSource, completed: false } })).toThrow(
      /completed/i,
    );
    expect(() => signSnapshot({ authorityDecisionId: '' })).toThrow(/authority/i);
    expect(() => signSnapshot({ signerPrincipalId: 'author-a' })).toThrow(/independent/i);
  });

  it('links a correction without mutating the signed snapshot', () => {
    const snapshot = signSnapshot();
    const correction = correctReviewSnapshot({
      snapshot,
      correctionRecordId: 'correction-1',
      reason: 'Source owner corrected a later record without rewriting signed history.',
      actorPrincipalId: 'governance-officer-a',
      linkedAt: 1_800_000_000_200,
    });
    expect(correction.snapshotId).toBe(snapshot.id);
    expect(correction.originalDigest).toBe(snapshot.canonicalDigest);
    expect(snapshot.correctionNoticeRefs).toEqual([]);
    expect(verifyReviewSnapshotDigest(snapshot)).toBe(true);
  });

  it('classifies added, removed, improved, regressed, unchanged, and unknown outcomes', () => {
    const baseline = signSnapshot();
    const target = signSnapshot({
      snapshotId: 'snapshot-2',
      source: {
        ...reviewSource,
        reviewVersion: 3,
        outcomes: [
          { key: 'control:c-1', type: 'control', status: 'pass', recordRef: '/controls/c-1' },
          { key: 'risk:r-1', type: 'risk', status: 'critical', recordRef: '/risks/r-1' },
          { key: 'control:c-2', type: 'control', status: 'unknown', recordRef: '/controls/c-2' },
        ],
      },
      signedAt: 1_800_000_001_000,
    });
    const comparison = compareReviewSnapshots({
      comparisonId: 'comparison-1',
      tenantId: 'tenant-a',
      baseline,
      target,
      generatedAt: 1_800_000_001_100,
      generatedByPrincipalId: 'auditor-a',
    });
    expect(comparison.compatibility).toBe('compatible');
    expect(comparison.improvedRefs).toEqual(['/controls/c-1']);
    expect(comparison.regressedRefs).toEqual(['/risks/r-1']);
    expect(comparison.addedRefs).toEqual(['/controls/c-2']);
    expect(comparison.unknownRefs).toEqual(['/controls/c-2']);
  });

  it('fails closed for cross-tenant or incompatible scope comparisons', () => {
    const baseline = signSnapshot();
    const otherTenant = signSnapshot({
      snapshotId: 'snapshot-other',
      source: { ...reviewSource, tenantId: 'tenant-b' },
    });
    expect(() =>
      compareReviewSnapshots({
        comparisonId: 'comparison-cross',
        tenantId: 'tenant-a',
        baseline,
        target: otherTenant,
        generatedAt: 1_800_000_001_100,
        generatedByPrincipalId: 'auditor-a',
      }),
    ).toThrow(/tenant/i);

    const otherScope = signSnapshot({
      snapshotId: 'snapshot-scope',
      source: { ...reviewSource, reviewVersion: 3, scope: { systemIds: ['system-2'] } },
    });
    const comparison = compareReviewSnapshots({
      comparisonId: 'comparison-scope',
      tenantId: 'tenant-a',
      baseline,
      target: otherScope,
      generatedAt: 1_800_000_001_100,
      generatedByPrincipalId: 'auditor-a',
    });
    expect(comparison.compatibility).toBe('incompatible');
    expect(comparison.incompatibilityReasons).toContain('scope_changed');
    expect(comparison.improvedRefs).toEqual([]);
  });
});
