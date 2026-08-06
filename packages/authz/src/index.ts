// @trustcircle/authz package boundary entry point.
// Re-exports the non-waivable Separation-of-Duties surface (T043 / GAR-003 /
// VO-173f7afb7801f4ab3e29), the OIDC human-session validation surface (T044 / GAR-003 /
// VO-173f7afb7801f4ab3e29), and the distinct workload-identity / mTLS-binding / exact
// service-capability surface (T040 / GAR-003 / VO-173f7afb7801f4ab3e29), so the declared
// `exports["."]` / `main` target is real.
export * from './separation-of-duties.ts';
export * from './oidc.ts';
export * from './workload-identity.ts';
export * from './authority.ts';
export * from './governed-platform-authority.ts';

// Re-exports the INDEPENDENT COMPLIANCE-REVIEW distinctness guard (Phase 7 / User Story 5 —
// Demonstrate Compliance and Audit Readiness / FR-053, FR-055, SC-022): the applicability-review
// independence verdict (reviewer distinct from proposer AND affected control owner, carrying the
// independent-reviewer role, and only `approve` activating), decided here (authz owns WHO-MAY) while
// the durable shape/version invariants live in @trustcircle/domain compliance.ts. Additive.
export * from './compliance-review.ts';
