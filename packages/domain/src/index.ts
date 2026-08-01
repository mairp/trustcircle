// @trustcircle/domain package boundary entry point.
//
// Re-exports the governance primitives (UUIDv7 stable identifiers, source/observation/recorded
// time types, structured reasons, and tenant-scoped governed-entity primitives) and the
// reusable guarded state-machine transitions with terminal-history preservation. This is the
// supported consumer surface for the domain package; the `exports["."]` / `main` target in
// package.json resolves here.
export * from './primitives.ts';
export * from './state-machine.ts';
export * from './outcomes.ts';
export * from './component-profile.ts';
export * from './inventory.ts';
export * from './correlation.ts';
