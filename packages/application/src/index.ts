// @trustcircle/application package boundary entry point.
//
// Re-exports the typed environment parsing / secret-reference validation / safe-defaults
// contract (Phase 7). This keeps the declared package `exports["."]` / `main` target real,
// so downstream consumers (apps/api, adapters) import configuration through a single stable
// surface. Adding a symbol here is an additive, backward-compatible contract change.
export * from './config/environment.ts';

// Re-exports the optimistic-concurrency / ETag / If-Match / conflict-response contract
// (Phase 22 / VO-52d0780c11bcc6fd7583) — the transport-boundary half of the versioned,
// deduplicated, conflict-safe mutating-operation guarantee. Additive, backward-compatible.
export * from './concurrency.ts';

// Re-exports the source-registry application service (Phase 65): source-contract registration
// (versioned + validated), onboarding lifecycle, stewardship actions, exclusion reviews, and
// ownership-gap / coverage-gap synthesis over the domain inventory model. Additive, backward-
// compatible — a single stable surface for the governed-source registry (AC1–AC6).
export * from './source-registry.ts';

// Explicit named re-export of the governed-source registry class, so the
// `latestContract(sourceId).supportLevel` read path (AC1 healthy-render / AC6
// governed-gap support classification) is resolvable by name on the package boundary.
export { SourceRegistry } from './source-registry.ts';

// Re-exports the discovery ports (Phase 66): the SCAN / CANDIDATE / METADATA / ACCESS-LIMIT /
// SCAN-GAP hexagonal boundary plus an in-memory reference implementation composing the domain
// inventory model. Additive, backward-compatible — the stable surface for boundary discovery,
// candidate classification, stale-aware metadata reads, and coverage/governed-source gap
// synthesis (AC1–AC6).
export * from './discovery-ports.ts';

// Re-exports the current-inventory assembly service (Phase 70): a fleet-level aggregate that
// composes the domain's single-item correlation into a collection where each governed asset renders
// ONCE with its full facet set (type / owner / lifecycle / risk / coverage / evidence / health /
// last-observation / unresolved issues), keeps discovered-but-ungoverned components + sources
// VISIBLE as coverage / governed-source gaps, drills down into distinct source records + status
// differences + dependencies + authoritative fields, refuses to infer current health from stale
// data, and catalogs unregistered sources. Additive, backward-compatible (AC1–AC6).
export * from './inventory-service.ts';

// Re-exports the snapshot / observation reconciliation service (Phase 71): a fleet-level aggregate
// that reconciles successive discovery/observation cycles against the prior known-source set and
// classifies every deviation into one of ten named source-anomaly classes — missing, duplicate,
// stale, conflicting, orphaned, changed, moved, split, merged, disappeared — keeping each anomaly
// VISIBLE and OWNED (coverage / governed-source gaps), composing the current-inventory service for
// the healthy render, marking stale/absent sources with last-known time + confidence (never
// inferring current health from stale data), and cataloguing unregistered sources. Additive,
// backward-compatible (AC1–AC6).
export * from './inventory-reconciliation.ts';

// Explicit named re-export of the reconciliation service, so the
// `deltasOfClass('moved')` lineage read path (the seventh, `renamed`, seeded source
// state) is resolvable by name on the package boundary.
export { SourceReconciler } from './inventory-reconciliation.ts';

// Re-exports the source-stewardship command service (Phase 72 / VO-fa865d78): the governed steward
// commands over a discovered source — approve onboarding, assign ownership, declare authoritative
// fields, request access, quarantine, defer, exclude — each requiring a mandatory structured
// reason, an explicit scope, a forward-dated review date, and an immutable, independently-readable
// AUDIT-TRAIL entry (actor / command / reason / scope / review / before→after digest). The lapsing
// commands (quarantine / defer / exclude) keep the source VISIBLE as a governed-source coverage gap
// carrying the review-or-expiry deadline (never deleting, never inferring health). Additive,
// backward-compatible (AC1–AC6).
export * from './source-stewardship.ts';

// ---------------------------------------------------------------------------
// Phase 4 — User Story 2: Make and Govern Human Decisions.
// The application-layer decision surface: structured reason validation, current-authority
// resolution, delegation use cases, the decision-service state transitions, material-change
// invalidation, federated joint decisions, emergency (break-glass) authority, and the policy-
// approved notification router. Each is a thin coordinator over the @trustcircle/authz source of
// truth and the @trustcircle/domain decision aggregates — no guard is re-implemented. Additive,
// backward-compatible (US2 AC1–AC6, FR-010..015, FR-043..045).
// ---------------------------------------------------------------------------
export * from './reasons.ts';
export * from './decision-authority.ts';
export * from './delegation-service.ts';
export * from './decision-service.ts';
export * from './decision-invalidation.ts';
export * from './joint-decisions.ts';
export * from './emergency-authority.ts';
export * from './notification-service.ts';

// ---------------------------------------------------------------------------
// Phase 5 — User Story 3: Contain and Repair Damaged Work Safely (FR-016..022).
// The application-layer integrity/remediation surface: the integrity-rule registry (immutable
// versions + fail-closed activation), the classifier (severity/confidence/impact/ownership-gap),
// the quarantine service (containment with inspection + release authority), the remediation planner
// (versioned recommendations), the automatic-repair policy gate (GAR-004: no destructive automatic
// repair), the rollback service (protect newer legitimate state), repair reconciliation (retain
// every difference), the verification service (nine-condition Verified Closure Gate), and the
// escalation router. Each is a pure coordinator over the @trustcircle/domain integrity aggregates —
// no invariant is re-implemented. Additive, backward-compatible (US3 AC1–AC6).
// ---------------------------------------------------------------------------
export * from './integrity-rule-registry.ts';
export * from './integrity-classifier.ts';
export * from './quarantine-service.ts';
export * from './remediation-planner.ts';
export * from './automatic-repair-policy.ts';
export * from './rollback-service.ts';
export * from './repair-reconciliation.ts';
export * from './verification-service.ts';
export * from './integrity-escalation.ts';

// ---------------------------------------------------------------------------
// Phase 6 — User Story 4: Operate Governance Controllers Safely
// (FR-024..028, FR-046..050, NS-005, NS-011, NFR-012, SC-010, SC-011, SC-021).
// The application-layer controller-operation surface: the controller-version registry (manifest-only
// authorization), adapter activation (least-privilege + conformance), the simulation service
// (version-pinned binding + source-drift invalidation), the operation service (one idempotency
// identity), the execution guard (revalidate-immediately-before-effect + reconcile-before-mutation),
// bounded continuity (in-progress-only, 15-min nonrenewable lease), pause/resume control, operation
// reconciliation (confirmation≠acknowledgement, one-effect), and controller rollback (protect newer
// legitimate state — DISTINCT `Controller`-prefixed names to avoid the US3 rollback-service symbols).
// Each is a pure, clock-free coordinator over the @trustcircle/domain controller aggregates — no
// invariant is re-implemented. Additive, backward-compatible (US4 AC1–AC6).
// ---------------------------------------------------------------------------
export * from './controller-registry.ts';
export * from './adapter-activation.ts';
export * from './simulation-service.ts';
export * from './controller-operation-service.ts';
export * from './execution-guard.ts';
export * from './continuity-service.ts';
export * from './operation-control.ts';
export * from './operation-reconciliation.ts';
export * from './controller-rollback.ts';

// ---------------------------------------------------------------------------
// Phase 7 — User Story 5: Demonstrate Compliance and Audit Readiness
// (FR-031..035, FR-051..056, SC-012, SC-013, SC-022).
// The application-layer compliance / audit-readiness surface: the versioned standards registry
// (immutable ISO/IEC 4200x publication facts) and its seed importer, the independent-review-gated
// applicability lifecycle, obligation→control mapping with shared responsibility + evidence
// expectations, the coverage engine (reconstruct 100% coverage for an exact scope & instant, with the
// readiness-vs-certification claim boundary), the exception service (expiring, no silent renewal),
// risk treatment, ISO/IEC 42005 impact assessment, internal audit, management review, corrective
// action, and external assurance (readiness is NEVER certification). Each is a pure, clock-free
// function over the @trustcircle/domain compliance aggregates. Additive, backward-compatible (US5 AC1–AC6).
// ---------------------------------------------------------------------------
export * from './standards-registry.ts';
export * from './standards-import.ts';
export * from './applicability-service.ts';
export * from './control-mapping-service.ts';
export * from './coverage-engine.ts';
export * from './exception-service.ts';
export * from './risk-treatment.ts';
export * from './impact-assessment.ts';
export * from './internal-audit.ts';
export * from './management-review.ts';
export * from './corrective-action.ts';
export * from './external-assurance.ts';

// ---------------------------------------------------------------------------
// Phase 8 — User Story 6: Maintain Source and Workflow Health
// (FR-029, FR-030, FR-036, FR-041, NFR-010, SC-014..SC-016).
// The application-layer source/workflow-health surface: the connector service (tenant/source binding
// with credential_ref-only credentials, a negotiated enabled-capability SUBSET, guarded lifecycle, and
// a monotonic ingestion cursor), alert routing (threshold breaches routed to accountable owners with
// 60s-visibility / 5m-owner-notify objectives), source ingestion (deterministic dedup + ordered merge
// preserving raw observations, tombstones, unknown values, and source authority), cursor recovery
// (typed detectors for cursor loss / backlog gaps / duplicate / stale / out-of-order / mapping + source
// identity changes), return-to-service (a guarded revalidation checklist — never resume an unproven
// prerequisite), offline dispatch (a bounded, visible disposition for work targeting an inactive
// component — never an unbounded retry or a false failure), and the readiness service (minimum-core
// health evaluated SEPARATELY from optional availability, with an explicit unavailable-feature
// inventory). Each is pure and clock-free (explicit `at`/`now`). Additive, backward-compatible (US6).
// ---------------------------------------------------------------------------
export * from './connector-service.ts';
export * from './alert-routing.ts';
export * from './source-ingestion.ts';
export * from './cursor-recovery.ts';
export * from './return-to-service.ts';
export * from './offline-dispatch.ts';
export * from './readiness-service.ts';
export * from './operations-authority.ts';
export * from './attention-queue.ts';
export * from './operational-case-service.ts';
