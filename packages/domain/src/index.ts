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
export * from './decisions.ts';
export * from './operations.ts';

// Re-exports the integrity / remediation aggregates (Phase 5 / User Story 3 — Contain and Repair
// Damaged Work Safely / FR-016..022, SC-006..009): the IntegrityCase (preservation-precedes-
// classification, ownership-gap, closure-requires-verification invariants), Quarantine (blocks
// unsafe execution while keeping the item inspectable), RemediationPlan (pre_authorized_low_risk
// ⇒ non-destructive + low-risk + policy-bound, GAR-004), RepairAttempt (uncertainty-is-not-success
// outcome vocabulary + one idempotency identity), and VerificationRecord (the nine-condition
// Verified Closure Gate oracle). Additive, backward-compatible.
export * from './integrity.ts';

// Re-exports the controller-operations aggregates (Phase 6 / User Story 4 — Operate Governance
// Controllers Safely / FR-023..028, FR-046..050, SC-010, SC-011, SC-021): the ControllerVersion
// (manifest-declared capabilities are the ONLY governable actions), ControllerInstance (visible
// desired-vs-observed drift), Simulation (version-pinned, expiring, source-drift-invalidated),
// ControllerOperation (one idempotency identity + simulate/approve-before-execute), OperationAttempt
// (acknowledgement is not confirmation), ControllerContinuityLease (≤15-min nonrenewable, in-progress-only,
// locally-verifiable), ReconciliationRun (never infer success from an ack; one-effect reconciliation),
// and the rollback oracle (protect newer legitimate state; only a verified restore clears).
// Additive, backward-compatible.
export * from './controllers.ts';

// Re-exports the COMPLIANCE aggregates (Phase 7 / User Story 5 — Demonstrate Compliance and Audit
// Readiness / FR-031..035, FR-051..056, SC-012, SC-013, SC-022): the StandardPublication (immutable
// global publication facts at PLATFORM_SCOPE — a tenant decision cannot rewrite them; supersession
// history), ClauseVersion (immutable per-clause versions), ApplicabilityDecision (independent review
// gates activation; a stale non-applicability reopens its gap; every change is a new version),
// Obligation + ControlMapping (many-to-many mappings, shared responsibility, evidence expectations),
// Assessment (internal-readiness / external-assessment distinction), and ExternalCertification
// (verifiable issuer/certificate/validity/status before display — readiness is NEVER certification).
// Additive, backward-compatible.
export * from './compliance.ts';

// Explicit named re-exports of the seven-state inventory source symbols, so the
// governed-source support taxonomy (`SupportLevel`) and the unknown-source-class
// sentinel (`UNKNOWN_SOURCE_CLASS`) are resolvable by name directly on the package
// boundary, not only via the wildcard `export *` above.
export { UNKNOWN_SOURCE_CLASS } from './inventory.ts';
export type { SupportLevel } from './inventory.ts';
