// @trustcircle/policy package boundary entry point.
// Re-exports the replaceable PDP port, the signed OPA bundle adapter, revision pinning, and
// signed decision evidence (Phase 44 / VO-173f7afb7801f4ab3e29), so the declared
// `exports["."]` / `main` target is real.
export * from './pdp.ts';
