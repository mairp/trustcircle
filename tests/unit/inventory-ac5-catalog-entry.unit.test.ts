// Phase 84 — AC5 witness (SHORT, self-contained; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// AC5: an unregistered governance-relevant source found within the declared boundary is ADDED to
// the source catalog with discovery evidence, a type-or-unknown classification, its location,
// access status, sensitivity, ownership status, and onboarding state.
//
// Durable read path: SourceRegistry.catalog() → the CatalogEntry list; we take the entry for the
// freshly discovered unknown-class source and assert ALL SEVEN catalog facets are present TOGETHER
// on that one entry.
import { describe, it, expect } from 'vitest';
import { UNKNOWN_SOURCE_CLASS } from '@trustcircle/domain';
import { seedTenantProjection, DISCOVERY_EVIDENCE } from '../fixtures/inventory.ts';

describe('AC5 — discovered source catalogued with the full seven-facet bundle', () => {
  const seeded = seedTenantProjection();
  const catalog = seeded.sources.catalog();
  const entry = catalog.find((e) => e.id === seeded.ids.discoveredUnknownSourceId)!;

  it('the discovered source was ADDED to the catalog', () => {
    expect(entry).toBeDefined();
  });

  it('the catalog entry carries ALL SEVEN required facets together', () => {
    // 1 discovery evidence, 2 type-or-unknown classification, 3 location, 4 access status,
    // 5 sensitivity, 6 ownership status, 7 onboarding state.
    expect(entry.discoveryEvidence).toBe(DISCOVERY_EVIDENCE); // 1
    expect(entry.sourceClass).toBe(UNKNOWN_SOURCE_CLASS); // 2 (type-or-unknown)
    expect(entry.observedLocations).toContain('s3://acme-unmapped-bucket'); // 3 location
    expect(entry.accessState).toBe('reachable'); // 4 access status
    expect(entry.sensitivity).toBe('restricted'); // 5 sensitivity
    expect(entry.ownerPrincipalId).toBeUndefined(); // 6 ownership status (unowned)
    expect(entry.onboardingState).toBe('discovered'); // 7 onboarding state
  });

  it('non-vacuity: a REGISTERED source differs (owned, known class, not restricted)', () => {
    const kanban = catalog.find((e) => e.id === seeded.ids.kanbanSourceId)!;
    expect(kanban.sourceClass).not.toBe(UNKNOWN_SOURCE_CLASS);
    expect(kanban.ownerPrincipalId).toBeDefined();
    expect(kanban.sensitivity).not.toBe(entry.sensitivity);
  });
});
