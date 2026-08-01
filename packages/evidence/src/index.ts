// @trustcircle/evidence package boundary entry point.
// Re-exports the retention / legal-hold / signed-disposition surface (T037 / GAR-006).
export * from './retention.ts';
// Content-addressed object-store port + S3-compatible immutable adapter (T034 / GAR-006).
export * from './object-store.ts';
// Original-first evidence commits, digest verification, tenant namespaces, classification
// checks (Phase 35 / GAR-006).
export * from './evidence-service.ts';
