// @trustcircle/command-worker package boundary entry point.
//
// The command-worker hosts the asynchronous side of the transactional-outbox pattern: it claims
// `pending` outbox rows written atomically by the unit-of-work (@trustcircle/persistence), then
// publishes them to the message bus with bounded retries and durable publish acknowledgements
// (Phase 27 / T027). This is the supported consumer surface.
export * from './outbox-publisher.ts';

// The governed worker bootstrap, lease ownership, checkpointing, and safe shutdown (Phase 47 /
// VO-6acaf6470d0810df4c93). `bootstrapWorker` wires the outbox publisher into a long-running,
// singleton-leased, checkpointing worker whose full state — ownership, health, failures,
// retries, continuity mode + lease, buffered evidence, and safe next action — is fail-visible
// through a single `WorkerStatus` snapshot.
export * from './main.ts';

// The deterministic decision EXPIRY worker (Phase 4 / User Story 2 / T116). Sweeps the five
// expirable governed kinds — decision packages, decision requirements, delegations, break-glass
// grants, and joint packages — and commits each lapsed-deadline expiry as an AUDITED, outboxed,
// deterministically-scheduled governed effect through the same transactional unit-of-work.
export * from './expiry-worker.ts';

// The deterministic INTEGRITY DETECTOR (Phase 5 / User Story 3 / T130 / FR-016..018). Sweeps new and
// changed source records, and for each one a detection oracle flags as damaged, preserves the raw
// original (FR-017) and opens an integrity case as an AUDITED, outboxed, deterministically-scheduled
// governed effect through the same transactional unit-of-work. Never classifies/quarantines/repairs.
export * from './integrity-detector.ts';

// The REPAIR EXECUTOR (Phase 5 / User Story 3 / T136 / FR-019..022, GAR-004). Executes only
// pre-authorized-low-risk, non-destructive repair under ONE idempotency identity — writing derived
// evidence linked to the preserved original, checkpointing, honouring a kill switch, stopping and
// escalating on an uncertain outcome, and recording `succeeded_unverified` (NEVER verified closure).
export * from './repair-executor.ts';

// The AUDIT EXPORT worker (Phase 7 / User Story 5 / T209 / FR-051..056, SC-012, SC-013, SC-022).
// Assembles a REPRODUCIBLE, SIGNED audit-export package for an exact scope + time window: coverage
// reconstructed as-of an exact instant (SC-013), evidence references authorized to the tenant (FR-053),
// a tamper-evident chain of custody (FR-052), every coverage gap listed verbatim (SC-022), a truthful
// claim boundary that never promotes internal readiness to external certification (FR-055/SC-012), and
// an HMAC-signed manifest (FR-056) — committed through the same transactional unit-of-work.
export * from './audit-export.ts';

// The CONNECTOR RECONCILER (Phase 8 / User Story 6 / T235 / FR-029, FR-036..FR-050, SC-014..SC-016).
// Pure `reconcile(input, at)` diffs a connector's DESIRED vs OBSERVED CURRENT state — source snapshots,
// cursors, versions, and mappings — and emits a `ReconciliationRun` aligned column-for-column with the
// `reconciliation_run` table, enumerating every drift under a NAMED class (missing | duplicate | stale |
// conflicting | orphaned | schema_incompatible | unknown). Unresolved drift stays visible; `resolved`
// is true ONLY when no drift remains. Scheduled | on_demand | return_to_service cadence; injected clock.
export * from './connector-reconciler.ts';

// The DEAD-LETTER HANDLER (Phase 8 / User Story 6 / T236 / FR-030). Pure `toDeadLetter(input)` PRESERVES
// a terminal message — the original payload + its `sha256` digest (NEVER dropped), every attempt, the
// terminal error, business impact, owner, replay authority, and evidence — aligned with the `dead_letter`
// table. `authorizeReplay(dl, authorizedBy, at)` refuses to reach `authorized`/`replayed` without an
// explicit authority, mirroring the DB CHECK `dead_letter_replay_requires_authority`. Nothing is dropped.
export * from './dead-letter-handler.ts';

// The COMPONENT LIFECYCLE governor (Phase 8 / User Story 6 / T247 / NFR-010; T223/T248). Pure `inspect`,
// `activate`, `deactivate`, `reconcile` commands over a component's LIVE availability — SEPARATE from
// design authority — aligned with the `component_activation` table. Only `core` runs continuously;
// everything else is intentionally-inactive / on-demand until an owner-approved activation PROVES its
// prerequisites. `activate` REFUSES to reach `active` unless identity/contract/authority/backlog are ALL
// proven, mirroring the DB CHECK `component_active_requires_preflight` — no mutation before proof.
// NOTE: its `reconcile` is re-exported as `reconcileComponent` to disambiguate from the connector
// reconciler's `reconcile`; every other member is re-exported verbatim.
export {
  reconcile as reconcileComponent,
  inspect,
  activate,
  deactivate,
  preflightPassed,
  COMPONENT_AVAILABILITY_CLASSES,
  COMPONENT_RUNTIME_STATES,
  COMPONENT_ACTIVATION_STATES,
  COMPONENT_LIFECYCLE_ACTOR,
} from './component-lifecycle.ts';
export type {
  ComponentAvailabilityClass,
  ComponentRuntimeState,
  ComponentActivationState,
  ActivationPrerequisites,
  ComponentInput,
  ComponentActivation,
} from './component-lifecycle.ts';
