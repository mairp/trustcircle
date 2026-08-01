<!-- T008 / GAR-010 — Authoritative repository directory-ownership map. -->
<!-- Compatibility obligation VO-ec575c4ce42b548bfb4d: this map is a supported -->
<!-- consumer surface. Every `present` owner path below MUST exist on disk, and -->
<!-- every workspace member / test suite / planned directory MUST be accounted -->
<!-- for here. The machine-readable `owners` table is enforced by -->
<!-- tests/tooling/repository-layout.test.mjs so the map cannot silently drift -->
<!-- from the inventory it governs. -->

# Repository Layout & Directory Ownership Map

This document is the **authoritative ownership map** for the TrustCircle
governance control plane monorepo. It names every planned top-level area —
**apps, packages, adapters, deployment, database, and tests** — and, for each,
its owner, lifecycle status, and responsibility.

It exists to satisfy task **T008 (GAR-010)** and the compatibility obligation
**VO-ec575c4ce42b548bfb4d**: _changes to inventory, decisions, lifecycle states,
source contracts, evidence, mappings, and exports MUST preserve supported
consumers or provide approved deprecation, migration, rollback, notice, and
compatibility evidence._ The directory inventory and the source-contract paths
listed here are a supported consumer surface. A companion test
(`tests/tooling/repository-layout.test.mjs`, run via `npm run test:tooling`)
verifies this map against the real repository so it stays truthful.

## Structure Decision (from `specs/001-governance-control-plane/plan.md`)

A TypeScript monorepo with **one transactional governance core** and
**independently deployable edge/process boundaries**. Domain code stays
independent of Hono, PostgreSQL, NATS, OPA, and object storage. Controller
adapters are **out-of-process by default** so vendor libraries and source
credentials cannot enter the canonical core. Bounded contexts can be split into
services later **without changing their canonical contracts**.

## Lifecycle status legend

| Status    | Meaning                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `present` | Directory/file exists on disk now; its owner path is verified by the layout test.      |
| `planned` | Reserved by `plan.md`; ownership is declared here now, contents land in a later phase. |

## Directory tree (planned + present)

```text
apps/                                # independently deployable process boundaries
├── api/                             # command/query API and SSE            [present]
├── web/                             # accessible governance console         [present]
├── command-worker/                  # governed operation executor          [present]
├── projector/                       # role-specific read models            [present]
└── discovery-agent/                 # least-privilege machine source discovery [present]

packages/                            # shared libraries (canonical core + ports)
├── domain/                          # entities, invariants, state machines [present]
├── application/                     # use cases, ports, typed environment  [present]
├── persistence/                     # PostgreSQL repos, outbox/inbox, migrations [present]
├── authz/                           # identity ctx, RBAC/ABAC/SoD/delegation, PDP port [present]
├── policy/                          # versioned bundle lifecycle, OPA reference adapter [present]
├── audit-ledger/                    # hash chain, checkpoints, verification [present]
├── evidence/                        # content-store port, provenance, retention, export [present]
├── projections/                     # operational/executive/compliance/auditor models [present]
├── contracts/                       # generated OpenAPI/AsyncAPI/JSON Schema types [present]
├── adapter-sdk/                     # sidecar SDK, test kit, compatibility harness [present]
└── observability/                   # metrics, traces, health, redaction    [present]

adapters/                            # out-of-process controller adapters (sidecars)
├── kanban/                                                                  [present]
├── workflow-orchestration/                                                  [present]
├── agentctl/                                                                [present]
└── wiggum/                          # read-only Wiggum feature-state snapshot [present]

db/                                  # authoritative physical schema
└── migrations/                      # expand→migrate→contract SQL migrations [present]

deploy/                              # deployment topology
├── compose/                         # local Docker Compose (WSL validation)  [present]
└── kubernetes/                      # hybrid central-catalog/federated-cell   [present]

tests/                               # cross-cutting acceptance/verification suites
├── unit/                            # Vitest `unit` project                 [present]
├── contract/                        # Vitest `contract` project             [planned]
├── integration/                     # Vitest `integration` project          [present]
├── e2e/                             # Playwright specs (a11y/keyboard/reflow) [present]
├── security/                        # Vitest `security` project             [present]
├── migration/                       # Vitest `migration` project (also globs db/migrations) [planned]
├── accessibility/                   # Playwright accessibility owner dir     [planned]
├── resilience/                      # Vitest `resilience` project           [planned]
├── recovery/                        # Vitest `recovery` project             [planned]
├── performance/                     # k6 scale + fault-injection profiles    [present]
├── boundaries/                      # workspace boundary acceptance tests    [present]
├── evidence/                        # evidence/retention acceptance tests    [present]
├── authz/                           # separation-of-duties acceptance tests  [present]
└── tooling/                         # config/tooling acceptance tests        [present]
```

> Note: some Vitest project directories (`tests/migration`,
> `tests/resilience`, `tests/recovery`) and `tests/accessibility` are `planned`:
> the Vitest/
> Playwright **project names** already exist as a supported consumer surface
> (see `vitest.workspace.ts` / `playwright.config.ts`), and the projects
> resolve via `passWithNoTests`; the physical owner directory is populated when
> the corresponding suites are authored in a later phase.

## Ownership table (machine-readable)

The fenced `owners` block below is the enforced contract. Each row is
`path | owner | status | responsibility`. The layout test asserts that every
`present` path exists and every workspace member / declared Vitest project is
represented.

```owners
apps/api | @trustcircle/api | present | Command/query API, SSE, authenticated tenant context, CSRF, correlation IDs, disclosure-safe errors
apps/web | @trustcircle/web | present | Accessible governance console; operator controller actions
apps/command-worker | @trustcircle/command-worker | present | Governed operation executor (pause/resume/rollback/reconcile bounds)
apps/projector | @trustcircle/projector | present | Role-specific read-model projectors over durable inboxes
apps/discovery-agent | @trustcircle/discovery-agent | present | Least-privilege machine source discovery
packages/domain | @trustcircle/domain | present | Entities, invariants, state machines (framework-independent)
packages/application | @trustcircle/application | present | Use cases, ports, typed environment/secret-reference parsing
packages/persistence | @trustcircle/persistence | present | PostgreSQL repositories, transactional outbox/inbox, migrations
packages/authz | @trustcircle/authz | present | Identity context, RBAC/ABAC, non-waivable separation-of-duties, PDP port
packages/policy | @trustcircle/policy | present | Versioned policy bundle lifecycle, OPA reference adapter
packages/audit-ledger | @trustcircle/audit-ledger | present | Audit hash chain, checkpoints, verification
packages/evidence | @trustcircle/evidence | present | Content-store port, provenance, retention, legal hold, disposition, export
packages/projections | @trustcircle/projections | present | Operational/executive/compliance/auditor read models
packages/contracts | @trustcircle/contracts | present | Generated OpenAPI/AsyncAPI/JSON Schema types (supported contract surface)
packages/adapter-sdk | @trustcircle/adapter-sdk | present | Sidecar SDK, test kit, compatibility harness
packages/observability | @trustcircle/observability | present | Metrics, traces, health, redaction
adapters/kanban | @trustcircle/adapter-kanban | present | Kanban controller adapter (out-of-process sidecar)
adapters/workflow-orchestration | @trustcircle/adapter-workflow-orchestration | present | Workflow-orchestration controller adapter
adapters/agentctl | @trustcircle/adapter-agentctl | present | Agent-control controller adapter
adapters/wiggum | @trustcircle/adapter-wiggum | present | Read-only Wiggum feature-state snapshot/correlation adapter
db/migrations | packages/persistence | present | Ordered expand→migrate→contract PostgreSQL migrations
deploy/compose | platform/deployment | present | Local Docker Compose deployment (WSL validation)
deploy/kubernetes | platform/deployment | present | Hybrid central-catalog/federated-cell Kubernetes manifests
deploy/nats | platform/deployment | present | Tenant-scoped NATS JetStream delivery topology (streams/subjects/retention/consumers/dead-letter routing)
tests/unit | qa/core | present | Vitest `unit` project
tests/integration | qa/core | present | Vitest `integration` project
tests/e2e | qa/accessibility | present | Playwright a11y/keyboard/400%-reflow specs
tests/security | qa/security | present | Vitest `security` project
tests/performance | qa/performance | present | k6 acceptance-scale + fault-injection profiles
tests/boundaries | qa/core | present | Workspace boundary acceptance tests
tests/evidence | qa/core | present | Evidence/retention acceptance tests
tests/authz | qa/security | present | Separation-of-duties acceptance tests
tests/domain | qa/core | present | Domain governance-primitive acceptance tests (UUIDv7/time/reasons/governed-entity)
tests/tooling | qa/core | present | Config/tooling acceptance tests
tests/contract | qa/core | present | Vitest `contract` project (consumer contract tests)
tests/migration | qa/core | planned | Vitest `migration` project (expand/migrate/contract DB-change tests)
tests/resilience | qa/core | planned | Vitest `resilience` project
tests/recovery | qa/core | planned | Vitest `recovery` project
tests/accessibility | qa/accessibility | planned | Playwright accessibility owner directory
.github/workflows | platform/ci | present | Pull-request validation gate (contracts/generated/lint/types/tests/migrations/evidence)
scripts/ci | platform/ci | present | CI helper scripts (evidence-manifest builder/verifier, guarded step runner)
scripts/spec | governance/spec | present | Spec tooling: deterministic traceability-matrix generator/drift-checker
evidence | platform/ci | present | Machine-readable evidence manifest (tamper-evident supported-contract inventory)
.gitignore | platform/ci | present | Version-control ignore contract: disposable data ignored, signed manifests + fixtures retained
docs/development | docs/onboarding | present | Developer bootstrap guide: WSL setup, test prerequisites, safe fixture rules, standard commands
specs/001-governance-control-plane | governance/spec | present | Feature specification, plan, data-model, tasks, and the FR/GAR/AR/NFR/SC-to-task-to-test-to-evidence traceability matrix
```

## Source-contract artifact ownership

The following source-contract artifacts implement bundle verification
obligations and are owned by the directories above. Their paths are a supported
consumer surface; changes preserve consumers or ship migration/deprecation
evidence (GAR-010). Paths marked `planned` are owned/reserved here now and land
in the phase that implements their capability.

```contracts
specs/001-governance-control-plane/spec.md | present | VO-52d0780c11bcc6fd7583 | Requirement catalog (FR/GAR/AR/NFR/SC) — the source-of-truth grounding surface the traceability matrix parses; sha256-pinned so its 108 governed requirements cannot silently drift
specs/001-governance-control-plane/tasks.md | present | VO-52d0780c11bcc6fd7583 | Task breakdown (T001..) with task→requirement links — the source-of-truth grounding surface for every task ID cited by the traceability matrix; sha256-pinned so cited task IDs remain verifiable
packages/domain/src/primitives.ts | present | VO-34d9f9fb2a6a39e2d62c | UUIDv7 stable identifiers, source/observation/recorded time types, structured reasons, tenant-scoped governed-entity primitives (version/owner/lifecycle/tests/monitoring/failure/exceptions/evidence)
packages/domain/src/state-machine.ts | present | VO-34d9f9fb2a6a39e2d62c | Reusable guarded state-machine transitions: governed-entity machines, optimistic-version concurrency, guard-recorded rejections, terminal-history preservation (append-only, terminal states are sinks)
packages/domain/src/outcomes.ts | present | VO-34d9f9fb2a6a39e2d62c | Canonical outcome codes, RFC 9457 problem+json envelopes, bounded retryability, and total safe-next-action mapping; the outcome vocabulary is a governed mapping entity carrying all nine GAR-005 facets
packages/persistence/src/database.ts | present | VO-52d0780c11bcc6fd7583 | PostgreSQL client seam, atomic transaction wrapper, session advisory locks, ordered checksum-pinned expand→migrate→contract migration runner, and idempotent mutating-operation runner: versioned/validated source contracts, correlated + deduplicated effects, bounded retry, reconciliation — safe under duplicate/delayed/partial/conflicting/uncertain outcomes
packages/persistence/src/unit-of-work.ts | present | VO-52d0780c11bcc6fd7583 | Unit-of-work that ATOMICALLY commits canonical state + AuditEvent + OutboxMessage in ONE transaction (all-three-or-none): runs under runMutation so the whole unit inherits versioned/validated source-contract enforcement, correlation across ledger/canonical/audit/outbox rows, exactly-once dedup, bounded retry, reconciliation, and safe-under-uncertain behavior; enforces an audit-completeness gate (actor/owner/reason/source+target state/policy+control version/evidence/scope/time/correlation/outcome captured before an action is reported complete) and an optimistic-concurrency guard on the canonical row; the transactional-outbox row is committed with the state change so downstream notification is atomically consistent for the command-worker publisher
db/migrations/0001_tenancy_authority.sql | present | VO-52d0780c11bcc6fd7583 | Expand-only tenancy/identity/authority schema: tenant, principal, role_definition, role_assignment, delegation, sod_constraint, break_glass_grant tables with enum-bounded status, versioned role definitions, and authority invariants (no self-delegation, bounded/immutable validity, non-waivable central SoD guardrail, independent break-glass review); applied once & checksum-pinned by the migration runner
db/migrations/0002_tenant_rls.sql | present | VO-52d0780c11bcc6fd7583 | Expand-only tenant-isolation schema: forced row-level security (ENABLE + FORCE) with restrictive tenant + explicit WITH CHECK policies keyed on current_tenant() (fail-closed on missing context) on every tenant-scoped authority table; composite (tenant_id, id) foreign keys so FKs never cross tenants; non-owner application roles (app_rw/app_ro, NOBYPASSRLS/NOSUPERUSER/NOLOGIN) with least-privilege DML grants; applied once & checksum-pinned by the migration runner
db/migrations/0003_idempotency.sql | present | VO-3cc80819915c2d5e64ba | Expand-only scoped idempotency ledger: durable, governed idempotency_ledger keyed on the scope tuple (tenant_id, operation_scope, idempotency_key) with request/response digests, correlation id, contract version, canonical operation id, first/last seen + attempts, and bounded expiry; scoped UNIQUE key (the deduplication contract) + partial expiry/status indexes; a BEFORE-UPDATE plpgsql conflict-guard trigger (idempotency_ledger_conflict_guard) that RAISEs unique_violation when a recorded request_digest would be overwritten by a materially different one — the database-level defense-in-depth backstop mirroring runMutation's app-level IdempotencyConflictError so same-key/different-digest reuse is refused and a duplicate replay is deduplicated without re-executing the effect; composes with the runner's bootstrapped ledger (IF NOT EXISTS/ADD COLUMN IF NOT EXISTS/CREATE OR REPLACE/DO-guarded), applied once & checksum-pinned by the migration runner
db/migrations/0004_delivery.sql | present | VO-52d0780c11bcc6fd7583 | Expand-only durable delivery substrate: formalizes the bootstrapped outbox_message and ADDS its delivery-lifecycle columns (entity_version, dedup_key, ordering_key, next_attempt_at, max_attempts, ack_ref, terminal_error) with a partial dedup UNIQUE key (a deterministic per-effect key enqueues at most once) + publisher claim/due indexes; creates the consumer-side inbox_message keyed on the dedup identity (tenant_id, consumer, event_id) so a redelivered event is processed once; a dead_letter_record retaining the ORIGINAL message evidence before transformation/replay with paired replay-authorization; an APPEND-ONLY delivery_attempt history (BEFORE-UPDATE guard delivery_attempt_append_only RAISEs restrict_violation) making retry reconstructable; and a MONOTONIC inbox_cursor (BEFORE-UPDATE guard inbox_cursor_no_regress refuses a backward cursor_seq so out-of-order/duplicate reconciliation causes no regression) with an append-only inbox_cursor_history trail; bounded-retry CHECK constraints (attempts <= max_attempts) — so mutating delivery is correlated, deduplicated, reconcilable, retry-bounded, and safe under duplicate/delayed/partial/conflicting/uncertain outcomes; composes with the Phase-21 bootstrapped outbox (IF NOT EXISTS/ADD COLUMN IF NOT EXISTS/CREATE OR REPLACE/DROP TRIGGER IF EXISTS+re-CREATE/DO-guarded), applied once & checksum-pinned by the migration runner
db/migrations/0005_audit_ledger.sql | present | VO-d76c5d1293b91d26e094 | Expand-only append-only tenant AUDIT LEDGER + signed CHECKPOINT metadata: audit_event captures every decision/automated action's accountability set — actor/principal (actor_principal_id OR system+automation_id, CHECK audit_event_actor_present), accountable owner (NOT NULL), reason (reason_code NOT NULL + reason_text required for a human action, CHECK audit_event_reason_text_for_human), source/target state digests (NOT NULL), policy+control version arrays and evidence manifest (CHECK audit_event_governed_completion_requires_versions_and_evidence gates a completed governed action on non-empty policy+control versions AND an evidence reference), requested/actual scope (NOT NULL), occurred/recorded time (NOT NULL, CHECK recorded>=occurred), correlation/causation/trace, and outcome (audit_outcome NOT NULL) — so an action CANNOT be recorded, and therefore cannot be reported complete, with any mandatory accountability field missing; rows are IMMUTABLE (BEFORE UPDATE/DELETE guards audit_event_reject_update/_delete RAISE restrict_violation) and HASH-CHAINED (previous_digest -> prior integrity_digest, integrity_digest UNIQUE per (tenant, ledger) so the chain cannot fork); audit_checkpoint pins a contiguous ledger range, root digest, event count, signing-key id + signature, and verification history (append-only, count-matches-range CHECK) making truncation/replacement tamper-evident; applied once & checksum-pinned by the migration runner
packages/audit-ledger/src/hash-chain.ts | present | VO-d76c5d1293b91d26e094 | Runtime half of the append-only, hash-chained tenant audit ledger (the application-layer counterpart to 0005_audit_ledger.sql): CANONICAL SERIALIZATION (canonicalizeAuditRecord/canonicalJson — sorted keys, order-independent policy/control version-id sets, undefined→null, chain fields excluded from content) yields a byte-stable digest input so two independent processes derive the SAME content digest; an ACCOUNTABILITY GATE (assertAccountable/assertReportable) enforces the AC clause set one-to-one with the SQL contract — actor/principal (principal id OR system+automation id, clause actor_present), accountable owner, reason (code always + human reason_text for a non-system action, clause reason_text_for_human), source/target state digests, policy+control version arrays and evidence manifest gated for a completed governed action (clauses governed_completion_policy_versions/_control_versions/_evidence), requested/actual scope, occurred/recorded time (clause recorded_after_occurred), correlation, and closed-vocabulary outcome — so a record MISSING any mandatory accountability field can never be canonicalized, appended, or reported complete; PER-LEDGER HASH CHAINING (createLedger/appendAuditRecord — immutable deep-frozen ledger, genesis sentinel previousDigest, monotone gap-free sequence, integrity_digest = sha256(previousDigest || contentDigest), ledger-binding + fork refusal); and APPEND VERIFICATION (verifyAppend/verifyLedger/assertLedgerIntact/computeCheckpointRoot — the INDEPENDENT read path that re-derives every digest and re-checks accountability+linkage, detecting a mutated field, reordered/duplicated/dropped record, or broken link, and folds the signed-checkpoint root over an intact range); Node crypto only, deterministic (no clock/fs/network); enforced by tests/audit-ledger/hash-chain.test.mjs
packages/audit-ledger/src/checkpoints.ts | present | VO-d76c5d1293b91d26e094 | Signed-checkpoint half of the audit ledger (application-layer counterpart to the audit_checkpoint table in 0005_audit_ledger.sql), built on the Phase-30 computeCheckpointRoot: (1) ED25519 CHECKPOINT SIGNING (generateSigningKey/signCheckpoint/verifyCheckpointSignature — Node crypto Ed25519, no external deps) signs a canonical payload committing to the pinned bundle identity, the whole covered range (tenant/ledger/first/last/count), the root + head integrity digests, the checkpoint-chain link (previousRootDigest), the signing-key id, AND the content digest of the publish action's accountability record — so a forged range field, root, chain link, identity, or re-attributed actor/owner/reason/scope/time/outcome fails signature verification; (2) IMMUTABLE CHECKPOINT PUBLICATION (createCheckpointLog/publishCheckpoint/verifyCheckpointLog) appends signed PREFIX checkpoints to a per-ledger, deep-frozen, checkpoint-chained log with strictly monotone coverage (previousRootDigest links to the prior checkpoint's rootDigest, firstSequence=1, lastSequence strictly increasing) so a whole checkpoint cannot be dropped, reordered, replayed, or truncated undetected, and a published checkpoint is never mutated in place; (3) VERIFICATION HISTORY (verifyPublishedCheckpoint/appendVerification/verifyAndRecord/anchorCheckpoint) is the INDEPENDENT read path — it re-derives the range root from independently-read ledger records, re-checks the chain and the Ed25519 signature, and records an APPEND-ONLY, monotone-sequence verification history (status verified/tampered) where a tamper finding is STICKY (a later verified pass cannot launder it) and only a verified checkpoint can be anchored; ACCOUNTABILITY GATE — signCheckpoint AND verifyPublishedCheckpoint are themselves automated actions that REQUIRE a fully-accountable AccountabilityRecord (assertAccountable, clause-by-clause) so a checkpoint or verification CANNOT be produced (and therefore cannot be reported complete) with any mandatory accountability field missing; Node crypto only, deterministic (no clock/fs/network); enforced by tests/audit-ledger/checkpoints.test.mjs
deploy/nats/topology.json | present | VO-52d0780c11bcc6fd7583 | Tenant-scoped NATS JetStream delivery topology: GOVERNANCE_EVENTS + GOVERNANCE_DLQ streams whose subjects mirror the AsyncAPI channel taxonomy (governance.{tenantId}.<domain>.<eventName>) and the 0004_delivery outbox/inbox/dead_letter substrate; VERSIONED (topologyVersion semver) + VALIDATED (deploy/nats/topology.schema.json draft-07); mutating delivery is CORRELATED (dead-letter routing preserves the original message + correlation id), DEDUPLICATED (per-stream duplicateWindow keyed on the outbox dedup_key), RECONCILABLE (durable pull consumers, deliver:all replay, append-only denyDelete+denyPurge streams), RETRY-BOUNDED (finite consumer maxDeliver mirroring max_attempts; overflow dead-lettered), and SAFE under duplicate/delayed/partial/conflicting/uncertain outcomes (discard:new fail-visible eviction, quorum replicas>=3, retention duration resolved from the governed schedule not invented, terminal non-auto-retried DLQ with paired replay authorization); enforced by tests/tooling/nats-topology.test.mjs
deploy/nats/topology.schema.json | present | VO-52d0780c11bcc6fd7583 | JSON Schema (draft-07) that VERSIONS and VALIDATES the delivery topology contract — the machine-checked validator behind the topology's "versioned and validated" guarantee (rejects non-tenant-scoped subjects, unbounded consumers, tamper-able streams, wrong bundle identity)
tests/security/tenant-rls.test.ts | present | VO-52d0780c11bcc6fd7583 | Tenant-isolation security oracle over 0002_tenant_rls.sql: cross-tenant read/write denial, missing-context default-deny, owner/BYPASSRLS safeguards, driven by role attrs + policy predicates parsed from the migration (faithful FORCE-RLS model), each with a negative control
packages/evidence/src/retention.ts | present | VO-b9b935bf93be10bdecdd | Retention resolution, legal-hold enforcement, signed disposition records
packages/authz/src/separation-of-duties.ts | present | VO-173f7afb7801f4ab3e29 | Non-waivable SoD / self-approval / incompatible-role guards
vitest.workspace.ts | present | VO-ec575c4ce42b548bfb4d | Vitest projects: unit/contract/integration/security/migration/resilience
apps/api/src/middleware/context.ts | present | VO-e4323651ab39776dcdbd | Tenant context, CSRF, correlation IDs, disclosure-safe error middleware
adapters/wiggum/src/snapshot.ts | present | VO-d982977672dda011fc65 | Read-only Wiggum state/progress/locks/runs/verdicts/proofs snapshot
packages/application/src/config/environment.ts | present | VO-config-env | Typed environment parsing, secret-reference validation, safe defaults
packages/application/src/concurrency.ts | present | VO-52d0780c11bcc6fd7583 | Transport-boundary optimistic-concurrency contract: deterministic strong ETags derived from (id, tenant, version, content-digest); RFC 9110 If-Match parsing/validation (rejects malformed, refuses unconditional mutations); optimistic precondition evaluation (proceed/conflict/precondition_required/not_found) so a stale validator yields a conflict and a lost update is structurally impossible; RFC 9457 problem+json conflict responses carrying the canonical conflict outcome, refresh_and_retry next action, bounded retry, and the current server ETag; Idempotency-Key parsing + replay classification (first/duplicate/idempotency_conflict) so duplicate retries return the stored result with no new effect and same-key/different-request retries are refused — the edge half of the versioned/deduplicated/conflict-safe mutating-operation guarantee
tests/performance/config.ts | present | VO-perf-config | k6 acceptance-scale + fault-injection profiles
playwright.config.ts | present | VO-a11y-config | Playwright axe / keyboard / 400%-reflow projects
packages/contracts/scripts/generate.ts | present | VO-ec575c4ce42b548bfb4d | OpenAPI/AsyncAPI/JSON Schema type-generation; deterministic, provenance-pinned, drift-checking
packages/contracts/scripts/validate.ts | present | VO-ec575c4ce42b548bfb4d | Contract validation, unresolved-placeholder rejection, and generated-diff compatibility gate
packages/contracts/src/events.ts | present | VO-52d0780c11bcc6fd7583 | Runtime governance event-envelope contract (the runtime half of the AsyncAPI governance-events source contract): VERSIONED schema_version (single supported 1.0.0 with same-major additive/downlevel policy) + VALIDATED envelope (every required field, uuid/rfc3339/sha256/event-type-pattern format, enum, and nested actor/policy/evidence/source/reason structure, structured path-anchored problems, never a thrown opaque error) so a partial/malformed message is refused before it can drive a mutating action; ADDITIVE same-major forward compatibility (unknown top-level + data/extensions keys tolerated read-only, structural violations of KNOWN fields still rejected — supported-consumer compatibility); and aggregate ordering checks over the (tenant, aggregate_type, aggregate_id) CORRELATION key: DEDUPLICATED (a re-delivered event_id or replayed aggregate_version is recognised and applied at most once — no second effect), RECONCILABLE (immutable per-aggregate state exposes last-applied version + seen event ids + a missingVersions gap view so ingest history is reconstructable; reconcileBatch folds a duplicated/out-of-order batch deterministically), RETRY-BOUNDED (classifyDelivery is a total, pure, non-throwing decision — apply/duplicate/out_of_order/gap/conflict/reject with a retryable flag so callers never loop unboundedly on a permanently-bad message), and SAFE under duplicate (duplicate), delayed/out-of-order (out_of_order — buffered, no regression), partial/malformed (reject — state untouched), conflicting (conflict — same version different event id stays visible, never silently overwritten), and uncertain (source.ordering_uncertain ⇒ gap — ordering advisory only, never silently advances state); enforced by tests/contract/governance-events-envelope.contract.test.ts
apps/projector/src/inbox-consumer.ts | present | VO-52d0780c11bcc6fd7583 | Durable INBOX consumer (the consumer half of the transactional-outbox/durable-inbox pattern; the producer half is packages/persistence/src/unit-of-work.ts + apps/command-worker/src/outbox-publisher.ts): consumes governance events off the bus and applies them to the read model exactly-once-in-effect and IN AGGREGATE ORDER. VERSIONED + VALIDATED — every message passes packages/contracts/src/events.ts validateEnvelope/classifyVersion BEFORE it can drive a mutating apply; a malformed or cross-major message is rejected and dead-lettered with its ORIGINAL evidence retained, never applied. DEDUPLICATED / safe under duplicate — durable dedup keyed on (tenant_id, consumer, event_id) via INSERT ... ON CONFLICT DO NOTHING (0004 inbox_message dedup identity); a re-delivered or already-terminal event returns `duplicate` and the projector apply fires AT MOST ONCE. CORRELATED — dedup + ordering are scoped per (tenant, consumer) and the (tenant, aggregate_type, aggregate_id) aggregate key; each delivery_attempt row carries the event correlation_id so the ingest trail is reconstructable; distinct consumers of the same event apply independently (fan-out). ORDERED / safe under delayed — applyDelivery classifies each event over durable per-aggregate state (rebuilt from applied inbox_message rows via rebuildAggregateState, which SELECTs the retained payload_json added by 0008_inbox_payload); an out-of-order (delayed) event is BUFFERED and NACKed, never applied ahead of its predecessor, and the MONOTONIC inbox_cursor (0004 inbox_cursor_no_regress) never regresses. SAFE under conflicting — a second, different event claiming an already-applied aggregate_version is QUARANTINED (visible + inspectable via listQuarantined), never silently overwriting the applied occupant, cursor unchanged. SAFE under uncertain — a source.ordering_uncertain forward jump is treated as a `gap` (buffered), so ambiguous ordering never silently advances state. Unsafe/ambiguous actions flagged by an injectable UnsafeActionGuard are quarantined (blocked from execution, retained). RETRY-BOUNDED / safe under partial — a transient apply failure records an append-only delivery_attempt and retries UP TO max_attempts (attempts <= max_attempts CHECK) then dead-letters (failureClass=retry_exhausted); a FatalApplyError dead-letters immediately (non_retryable); acknowledgement rules (ackFor) NACK only buffered/retry and ACK every terminal disposition so the bus never loops unboundedly on a permanently-bad message. All effects are observed through independent read paths (readInboxMessage/readInboxAttempts/readInboxCursor/listQuarantined/readInboxDeadLetter), never the consume() response; enforced by tests/worker/inbox-consumer.test.mjs
tests/integration/simulation-binding.test.ts | planned | VO-a5205654a25746949236 | Source-drift between inspect/simulate/approve/execute invalidates authority
apps/web/src/features/controllers/OperationActions.tsx | planned | VO-76455e2a60fbc99a2097 | Policy-aware pause/resume/reconcile/rollback/collect-evidence/cancel/e-stop controls
packages/evidence/src/original-preservation.ts | planned | VO-40b09e5441216007c9e5 | Capture raw source content/revision/metadata/digest/custody before any transformation
.github/workflows/verify.yml | present | VO-ec575c4ce42b548bfb4d | PR-validation gate: contracts/generated/lint/types/tests/migrations/evidence-manifest
scripts/ci/evidence-manifest.mjs | present | VO-ec575c4ce42b548bfb4d | Tamper-evident evidence-manifest builder/verifier over supported source contracts
scripts/ci/run-if-present.mjs | present | VO-ec575c4ce42b548bfb4d | Guarded PR-validation runner: present⇒run, absent⇒visible skip (never silent pass)
.gitignore | present | VO-ec575c4ce42b548bfb4d | Ignore disposable local data; retain signed validation manifest (evidence/manifest.json) + contract/test fixtures
docs/development/bootstrap.md | present | VO-ec575c4ce42b548bfb4d | Developer bootstrap: WSL setup, test prerequisites, safe fixture rules, standard-command surface (script-drift enforced)
specs/001-governance-control-plane/traceability.md | present | VO-52d0780c11bcc6fd7583 | FR/GAR/AR/NFR/SC-to-task-to-test-to-evidence traceability matrix: every spec requirement mapped to its governing tasks.md task(s), on-disk implementing artifact/test, and independently observable evidence; the versioned-&-validated-source-contract + correlated/deduplicated/reconcilable/retry-bounded/safe-outcome obligation clauses mapped to genuine built artifacts (persistence runMutation/reconcileMutation, contracts validate.ts, migration runner); deterministically generated + drift-checked by scripts/spec/build-traceability.mjs
```

## Change discipline (compatibility obligation)

Because this map is a supported consumer surface (`VO-ec575c4ce42b548bfb4d`):

1. **Adding** a workspace member, adapter, deploy target, or test suite requires
   a corresponding `owners` row (the layout test fails otherwise — no silent
   inventory drift).
2. **Renaming or removing** a `present` owner path is a breaking change: it
   requires a deprecation window, migration/rollback notice, and updated
   compatibility evidence before the row may change status or be deleted.
3. **Promoting** a `planned` path to `present` requires the owner directory/file
   to exist on disk; the layout test enforces the `present ⇒ exists` invariant.
4. Generated code (`packages/contracts/src/generated`, `*.gen.ts`) and build
   output (`.tsbuild/`) are owned by their generators and excluded from lint /
   format / the layout inventory; they are never edited by hand.
