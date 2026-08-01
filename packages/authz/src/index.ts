// @trustcircle/authz package boundary entry point.
// Re-exports the non-waivable Separation-of-Duties surface (T043 / GAR-003 /
// VO-173f7afb7801f4ab3e29), the OIDC human-session validation surface (T044 / GAR-003 /
// VO-173f7afb7801f4ab3e29), and the distinct workload-identity / mTLS-binding / exact
// service-capability surface (T040 / GAR-003 / VO-173f7afb7801f4ab3e29), so the declared
// `exports["."]` / `main` target is real.
export * from './separation-of-duties.ts';
export * from './oidc.ts';
export * from './workload-identity.ts';
