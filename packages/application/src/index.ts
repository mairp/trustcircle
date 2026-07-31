// @trustcircle/application package boundary entry point.
//
// Re-exports the typed environment parsing / secret-reference validation / safe-defaults
// contract (Phase 7). This keeps the declared package `exports["."]` / `main` target real,
// so downstream consumers (apps/api, adapters) import configuration through a single stable
// surface. Adding a symbol here is an additive, backward-compatible contract change.
export * from './config/environment.ts';
