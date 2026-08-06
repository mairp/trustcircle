// @trustcircle/projections package boundary entry point.
//
// Re-exports the INVENTORY PROJECTOR (Phase 75): the pure, deterministic read-model fold that
// projects inventory, source catalog, correlation, provenance, and coverage gaps from ordered
// governance events. This is the supported consumer surface for the projections package; the
// `exports["."]` / `main` target in package.json resolves here.
export * from './inventory-projector.ts';

// Re-exports the CURRENT-STATE QUERY SERVICES (Phase 76): the pure operational (per-item) and
// executive (aggregate posture) views over the projector, each carrying explicit freshness
// (last-known time + staleness) and confidence, never inferring current health from stale data.
export * from './current-state-queries.ts';

// Re-exports the AUTHORITY-AWARE DECISION-QUEUE PROJECTOR (Phase 4 / T107): the pure, deterministic
// fold that projects a prioritized human-decision queue — impact, risk, age, expiry posture, evidence
// currency, open requirements, actor conflicts, and the exact allowed actions — from already-resolved
// decision inputs at an injected instant, with a snapshot digest witness. Additive surface.
export * from './decision-projector.ts';

// Re-exports the INTEGRITY-QUEUE PROJECTOR (Phase 5 / User Story 3 / FR-016..022): the pure,
// deterministic fold that projects a prioritized damaged-work queue — problem class, severity,
// safety impact, owner / ownership gap, quarantine, dependency propagation, and — critically — the
// AUTHORITATIVE verified-closure flag that NEVER converts a source-reported `done` or repair success
// into verified closure (closure is an injected independent-verification verdict). Additive surface.
export * from './integrity-projector.ts';

// Re-exports the CONTROLLER + OPERATION PROJECTOR (Phase 6 / User Story 4 / FR-023, FR-024, FR-027,
// FR-028, FR-050): the pure, deterministic fold that projects two read models — a controller registry
// (version, owner, health, desired-vs-observed state + visible DRIFT, dependencies, active operation)
// and a governed-operation queue (lifecycle state, bounded continuity lease, progress, attempts,
// failures, retries, evidence, and the EXACT domain-permitted next actions). It NEVER infers success
// from an acknowledgement: an uncertain latest attempt projects `awaitingReconciliation` until a
// reconciliation established actual state. Additive surface.
export * from './controller-projector.ts';

// Re-exports the COMPLIANCE COVERAGE PROJECTOR (Phase 7 / User Story 5 / FR-031..035, FR-051..056,
// SC-012, SC-013, SC-022): the pure, deterministic fold that projects a tenant's compliance-coverage
// read model — publications, active applicability decisions, obligations, control mappings +
// evaluations, and external certifications — for an EXACT (scope, instant), composing the application
// coverage engine so the coverage picture and the readiness-vs-certification claim boundary are ONE
// oracle. It never infers current state from stale evidence and never reports readiness as
// certification; it carries freshness metadata and a snapshot-digest witness. Additive surface.
export * from './compliance-projector.ts';

// Re-exports the LAST-KNOWN-STATE PROJECTOR (Phase 8 / User Story 6 / T241 / FR-036, NFR-010): the
// pure projector that preserves the last-known source/mapping versions, age, confidence, retention,
// and legal hold while a component is offline, and computes an EXPLICIT staleness label (current /
// aging / stale / unknown) + an explicit `isStale` at an injected instant — NEVER inferring current
// health from stale data. Leaf-clean (domain + node:crypto), with a snapshot-digest witness.
export * from './last-known-state.ts';

// Re-exports the OPERATIONAL PROJECTOR (Phase 8 / User Story 6 / T243 / FR-029, FR-030, NFR-010): the
// pure fold that projects the FR-029 full field set per connector / controller / source subject —
// identity, version, owner, health, lifecycle status, enabled scope, last success + attempt, active
// operation, evidence, failures, retry state, dead-letter count, continuity posture, profile
// (availability class), business impact, affected work, and a conservative SAFE NEXT ACTION — at an
// injected `at`. It never infers current health from stale data. Leaf-clean, snapshot-digest witness.
export * from './operational-projector.ts';
export * from './governed-platform-projector.ts';
