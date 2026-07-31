// @trustcircle/persistence package boundary entry point.
//
// Re-exports the PostgreSQL client, transaction wrapper, advisory locks, idempotent
// mutating-operation runner, reconciliation, and migration runner (Phase 17). This is the
// supported consumer surface; the declared package `exports["."]` / `main` target resolves
// here. Adding a symbol is an additive, backward-compatible contract change.
export * from './database.ts';
