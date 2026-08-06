// @trustcircle/evidence package boundary entry point.
// Re-exports the retention / legal-hold / signed-disposition surface (T037 / GAR-006).
export * from './retention.ts';
// Content-addressed object-store port + S3-compatible immutable adapter (T034 / GAR-006).
export * from './object-store.ts';
// Original-first evidence commits, digest verification, tenant namespaces, classification
// checks (Phase 35 / GAR-006).
export * from './evidence-service.ts';
// Immutable provenance edges + signed ordered evidence manifests (Phase 36 / GAR-006 /
// VO-4aeb030a32c9deebdb3b).
export * from './provenance.ts';
// Original preservation — capture raw source content / revision / metadata / digest / custody /
// classification / retention BEFORE any transformation (Phase 5 / User Story 3 / FR-017).
export * from './original-preservation.ts';
// Operation evidence — the ordered, content-addressed bundle for a controller operation: plan,
// attempts, buffered continuity effects, remote observations, rollback, reconciliation, verification
// (Phase 6 / User Story 4 / FR-025, FR-027, FR-028, FR-049, NS-011, SC-011).
export * from './operation-evidence.ts';
