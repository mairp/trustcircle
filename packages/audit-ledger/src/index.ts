// @trustcircle/audit-ledger package boundary entry point.
//
// Re-exports the runtime audit-ledger primitives: canonical serialization, per-ledger hash
// chaining, and append verification (Phase 30 / GAR-002 / VO-d76c5d1293b91d26e094). This is the
// supported consumer surface; the `exports["."]` / `main` target in package.json resolves here.
export * from './hash-chain.ts';
