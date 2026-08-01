// @trustcircle/application package boundary entry point.
//
// Re-exports the typed environment parsing / secret-reference validation / safe-defaults
// contract (Phase 7). This keeps the declared package `exports["."]` / `main` target real,
// so downstream consumers (apps/api, adapters) import configuration through a single stable
// surface. Adding a symbol here is an additive, backward-compatible contract change.
export * from './config/environment.ts';

// Re-exports the optimistic-concurrency / ETag / If-Match / conflict-response contract
// (Phase 22 / VO-52d0780c11bcc6fd7583) — the transport-boundary half of the versioned,
// deduplicated, conflict-safe mutating-operation guarantee. Additive, backward-compatible.
export * from './concurrency.ts';

// Re-exports the source-registry application service (Phase 65): source-contract registration
// (versioned + validated), onboarding lifecycle, stewardship actions, exclusion reviews, and
// ownership-gap / coverage-gap synthesis over the domain inventory model. Additive, backward-
// compatible — a single stable surface for the governed-source registry (AC1–AC6).
export * from './source-registry.ts';

// Re-exports the discovery ports (Phase 66): the SCAN / CANDIDATE / METADATA / ACCESS-LIMIT /
// SCAN-GAP hexagonal boundary plus an in-memory reference implementation composing the domain
// inventory model. Additive, backward-compatible — the stable surface for boundary discovery,
// candidate classification, stale-aware metadata reads, and coverage/governed-source gap
// synthesis (AC1–AC6).
export * from './discovery-ports.ts';

// Re-exports the current-inventory assembly service (Phase 70): a fleet-level aggregate that
// composes the domain's single-item correlation into a collection where each governed asset renders
// ONCE with its full facet set (type / owner / lifecycle / risk / coverage / evidence / health /
// last-observation / unresolved issues), keeps discovered-but-ungoverned components + sources
// VISIBLE as coverage / governed-source gaps, drills down into distinct source records + status
// differences + dependencies + authoritative fields, refuses to infer current health from stale
// data, and catalogs unregistered sources. Additive, backward-compatible (AC1–AC6).
export * from './inventory-service.ts';

// Re-exports the snapshot / observation reconciliation service (Phase 71): a fleet-level aggregate
// that reconciles successive discovery/observation cycles against the prior known-source set and
// classifies every deviation into one of ten named source-anomaly classes — missing, duplicate,
// stale, conflicting, orphaned, changed, moved, split, merged, disappeared — keeping each anomaly
// VISIBLE and OWNED (coverage / governed-source gaps), composing the current-inventory service for
// the healthy render, marking stale/absent sources with last-known time + confidence (never
// inferring current health from stale data), and cataloguing unregistered sources. Additive,
// backward-compatible (AC1–AC6).
export * from './inventory-reconciliation.ts';
