// Phase 84 — AC4 witness (SHORT, self-contained; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// AC4: when a source becomes stale/unavailable, its affected data is visibly marked with the
// last-known time and a confidence, and current compliance/health is NOT inferred from stale data.
//
// Durable read path: SourceRegistry.currentStateView(now) → SourceStateRow for the stale warehouse
// source. We assert the row carries a last-known time and a confidence, is marked stale, and — the
// safety rule — reportedHealth is downgraded (never a positive current-health claim from stale data).
import { describe, it, expect } from 'vitest';
import { seedTenantProjection, NOW } from '../fixtures/inventory.ts';

describe('AC4 — stale source marked with last-known time + confidence, no inference', () => {
  const seeded = seedTenantProjection();
  const rows = seeded.sources.currentStateView(NOW);
  const stale = rows.find((r) => r.sourceId === seeded.ids.staleSourceId)!;
  const fresh = rows.find((r) => r.sourceId === seeded.ids.kanbanSourceId)!;

  it('the stale source is visibly marked stale (not fresh, not disappeared)', () => {
    expect(stale).toBeDefined();
    expect(stale.staleness).not.toBe('fresh'); // 'stale' or 'unavailable'
    expect(stale.evidenceState).not.toBe('current'); // never a current-evidence claim
  });

  it('it carries a LAST-KNOWN time and a CONFIDENCE', () => {
    expect(typeof stale.lastKnownAt).toBe('number'); // last-known time present
    expect(stale.lastKnownAt).toBeLessThan(NOW); // and it is genuinely in the past
    expect(stale.confidence).toBeGreaterThanOrEqual(0);
    expect(stale.confidence).toBeLessThan(1); // degraded — not full confidence
  });

  it('current health is NOT inferred from stale data (reportedHealth downgraded)', () => {
    expect(stale.reportedHealth).toBe('unknown'); // never a positive current-health claim
  });

  it('non-vacuity: a FRESH source keeps full confidence and current evidence', () => {
    expect(fresh.confidence).toBe(1);
    expect(fresh.staleness).toBe('fresh');
  });
});
