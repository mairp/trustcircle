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

// Runtime DECISION-API contract surface (Phase 88 / Work item BJG3PZHMWX4DHWZ9RMEZ33F9GZ):
// validates decision / action / delegation requests, headers, ETags, idempotency, errors, and
// responses against the loaded governance-api.openapi.yaml. Runtime half of the OpenAPI decision
// surface — the generated types are compile-time only.
export * from './decision-api.ts';

// Runtime INTEGRITY-API contract surface (Phase 5 / User Story 3 / T121 / FR-016..022, GAR-004):
// validates integrity-case queue/detail, remediation (propose/simulate/execute), and verification
// requests, headers, ETags, idempotency, errors, and responses against the SAME loaded
// governance-api.openapi.yaml. A thin specialisation over decision-api's shared validators; adds the
export * from './operations-api.ts';
// integrity-specific named validators bound to the four `Integrity`-tagged operations.
export * from './integrity-api.ts';
export * from './governed-platform-api.ts';
