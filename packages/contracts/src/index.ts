// @trustcircle/contracts package boundary entry point.
//
// Re-exports the generated TypeScript type surface produced from the canonical
// source contracts (OpenAPI / AsyncAPI / JSON Schema) by
// packages/contracts/scripts/generate.ts. These types are the supported export
// surface for API handlers, adapters, and clients (GAR-010).
export type * from './generated/index.ts';

// Runtime governance event-envelope contract (Phase 26 / T026 / GAR-008):
// versioned validation, additive same-major field handling, and aggregate
// ordering (dedup / monotonic version / gap / conflict / uncertain) checks. This
// is the runtime half of the AsyncAPI governance-events contract — the generated
// types are compile-time only and cannot enforce the GAR-008 obligation.
export * from './events.ts';
