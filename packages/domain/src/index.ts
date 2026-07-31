// @trustcircle/domain package boundary entry point.
//
// Re-exports the governance primitives (UUIDv7 stable identifiers, source/observation/recorded
// time types, structured reasons, and tenant-scoped governed-entity primitives). This is the
// supported consumer surface for the domain package; the `exports["."]` / `main` target in
// package.json resolves here.
export * from './primitives.ts';
