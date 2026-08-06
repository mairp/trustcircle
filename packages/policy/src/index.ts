// @trustcircle/policy package boundary entry point.
// Re-exports the replaceable PDP port, the signed OPA bundle adapter, revision pinning, and
// signed decision evidence (Phase 44 / VO-173f7afb7801f4ab3e29), so the declared
// `exports["."]` / `main` target is real.
export * from './pdp.ts';
// Phase 4 (T106): the normalized PDP INPUT BUILDER — turns each of the five governed operations
// (decision, delegation, joint-review, exception, emergency) into the exact PolicyQuery /
// revision-pinned DecisionRequest the port consumes, threading resolved authority through the
// canonical @trustcircle/authz bridges without re-implementing any policy. Additive surface.
export * from './decision-input.ts';
