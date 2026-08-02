// Phase 84 — AC6 witness (SHORT, self-contained; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// AC6: a discovered source that is unsupported/inaccessible/sensitive/unowned/excluded remains
// VISIBLE as a governed-source gap with its reason, impact, required owner action, and a review or
// expiry deadline.
//
// Durable read path: SourceRegistry.gapsForSource(excludedSourceId) — the governed-source gap is
// retained with reason/impact/action/reviewAt — plus latestContract(...).supportLevel to prove the
// UNSUPPORTED classification is backed by a contract, not merely a class name.
import { describe, it, expect } from 'vitest';
import { seedTenantProjection } from '../fixtures/inventory.ts';

describe('AC6 — unsupported/excluded source stays a governed-source gap with all facets', () => {
  const seeded = seedTenantProjection();
  const { excludedSourceId } = seeded.ids;
  const gaps = seeded.sources.gapsForSource(excludedSourceId);

  it('the excluded source remains VISIBLE as at least one OPEN governed-source gap', () => {
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((g) => g.status === 'open')).toBe(true);
  });

  it('a gap carries reason + impact + required owner action + review/expiry together', () => {
    const withDeadline = gaps.find((g) => g.reviewAt !== undefined || g.expiresAt !== undefined)!;
    expect(withDeadline).toBeDefined();
    expect(withDeadline.reason).toBeTruthy(); // reason
    expect(withDeadline.impact).toBeTruthy(); // impact
    expect(withDeadline.requiredAction.length).toBeGreaterThan(0); // required owner action
    const deadline = withDeadline.reviewAt ?? withDeadline.expiresAt!;
    expect(deadline).toBeGreaterThan(seeded.now); // review-or-expiry, in the future
  });

  it('the UNSUPPORTED classification is backed by a contract (not just a class name)', () => {
    expect(seeded.sources.latestContract(excludedSourceId)!.supportLevel).toBe('unsupported');
  });
});
