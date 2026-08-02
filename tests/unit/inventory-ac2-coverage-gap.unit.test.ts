// Phase 84 — AC2 witness (SHORT, self-contained; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// AC2: a component discovered but unmanaged/unreachable/stale/orphaned/excluded remains VISIBLE as
// a coverage gap with its reason, age, impact, and the required owner action — not healthy, not
// disappeared.
//
// Durable read path: InventoryService.componentGaps() (the gap is retained, never dropped) plus
// gapAge(now) for the age facet, and currentStateView(now) to prove the bound row is flagged
// (hasVisibleComponentGap) rather than shown as healthy or removed.
import { describe, it, expect } from 'vitest';
import { seedTenantProjection, NOW, GAP_ASSET_ID } from '../fixtures/inventory.ts';

describe('AC2 — discovered-but-uncovered stays a visible gap with all facets', () => {
  const seeded = seedTenantProjection();
  const gaps = seeded.inventory.componentGaps();
  const gap = gaps.find((g) => g.subjectId === GAP_ASSET_ID)!;

  it('the orphaned component remains VISIBLE as an OPEN coverage gap (not disappeared)', () => {
    expect(gap).toBeDefined();
    expect(gap.status).toBe('open');
  });

  it('the gap carries reason + impact + required owner action together', () => {
    expect(gap.reason).toBe('orphaned'); // reason
    expect(gap.impact).toBe('high'); // impact
    expect(gap.requiredAction).toContain('assign an owner'); // required owner action
  });

  it('the gap exposes a positive AGE at now (age facet)', () => {
    const age = seeded.inventory.gapAge(gap.id, NOW);
    expect(age).toBeGreaterThan(0);
  });

  it('the bound row is FLAGGED as a gap — NOT rendered healthy', () => {
    const row = seeded.inventory.rowFor(GAP_ASSET_ID, NOW);
    expect(row.hasVisibleComponentGap).toBe(true);
    expect(row.reportedHealth).not.toBe('healthy'); // never inferred healthy over an open gap
  });
});
