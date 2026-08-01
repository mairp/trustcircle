// @trustcircle/projections package boundary entry point.
//
// Re-exports the INVENTORY PROJECTOR (Phase 75): the pure, deterministic read-model fold that
// projects inventory, source catalog, correlation, provenance, and coverage gaps from ordered
// governance events. This is the supported consumer surface for the projections package; the
// `exports["."]` / `main` target in package.json resolves here.
export * from './inventory-projector.ts';

// Re-exports the CURRENT-STATE QUERY SERVICES (Phase 76): the pure operational (per-item) and
// executive (aggregate posture) views over the projector, each carrying explicit freshness
// (last-known time + staleness) and confidence, never inferring current health from stale data.
export * from './current-state-queries.ts';
