// Phase 84 — AC1 witness (SHORT, self-contained; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// AC1: opening the current-state view, each item appears ONCE carrying its type, source identity,
// owner, lifecycle state, risk, control coverage, evidence state, health, last observation time,
// and unresolved issues.
//
// Durable read path: InventoryService.currentStateView(now) → InventoryRow[]. We assert the healthy
// seeded asset (HEALTHY_ASSET_ID) renders EXACTLY ONCE and that ALL TEN AC1 attributes are present
// TOGETHER on that single row — not spot-checked one at a time. A non-vacuity guard proves the
// row is the seeded asset, not a constant.
import { describe, it, expect } from 'vitest';
import { seedTenantProjection, NOW, HEALTHY_ASSET_ID, OWNER } from '../fixtures/inventory.ts';

describe('AC1 — each item appears once with the full attribute bundle', () => {
  const seeded = seedTenantProjection();
  const rows = seeded.inventory.currentStateView(NOW);

  it('the healthy asset appears EXACTLY ONCE in the current-state view', () => {
    const matches = rows.filter((r) => r.assetId === HEALTHY_ASSET_ID);
    expect(matches).toHaveLength(1);
  });

  it('that single row carries ALL TEN required attributes together', () => {
    const row = rows.find((r) => r.assetId === HEALTHY_ASSET_ID)!;
    // 1 type, 2 source identity, 3 owner, 4 lifecycle, 5 risk, 6 control coverage,
    // 7 evidence state, 8 health, 9 last observation time, 10 unresolved issues.
    expect(row.assetType).toBe('service'); // 1
    expect(row.assetId).toBe(HEALTHY_ASSET_ID); // 2
    expect(row.ownerPrincipalId).toBe(OWNER); // 3
    expect(row.lifecycleState).toBe('operating'); // 4
    expect(row.riskTier).toBe('moderate'); // 5
    expect(row.coverage).toBe('covered'); // 6
    expect(row.evidenceState).toBe('current'); // 7
    expect(row.reportedHealth).toBe('healthy'); // 8 (reported == observed only when current)
    expect(row.lastObservationAt).toBe(NOW); // 9
    expect(row.unresolvedIssueCount).toBe(0); // 10
  });

  it('non-vacuity: a DIFFERENT seeded asset has different facets (row is not a constant)', () => {
    const healthy = rows.find((r) => r.assetId === HEALTHY_ASSET_ID)!;
    const other = rows.find((r) => r.assetId !== HEALTHY_ASSET_ID);
    expect(other).toBeDefined();
    // The orphaned asset is unowned + gapped: it MUST differ on owner/coverage/health.
    expect(other!.ownerPrincipalId).toBeUndefined();
    expect(other!.coverage).not.toBe(healthy.coverage);
  });
});
