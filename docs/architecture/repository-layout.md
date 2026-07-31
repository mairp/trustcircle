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

> Note: some Vitest project directories (`tests/contract`, `tests/migration`,
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
tests/unit | qa/core | present | Vitest `unit` project
tests/integration | qa/core | present | Vitest `integration` project
tests/e2e | qa/accessibility | present | Playwright a11y/keyboard/400%-reflow specs
tests/security | qa/security | present | Vitest `security` project
tests/performance | qa/performance | present | k6 acceptance-scale + fault-injection profiles
tests/boundaries | qa/core | present | Workspace boundary acceptance tests
tests/evidence | qa/core | present | Evidence/retention acceptance tests
tests/authz | qa/security | present | Separation-of-duties acceptance tests
tests/tooling | qa/core | present | Config/tooling acceptance tests
tests/contract | qa/core | planned | Vitest `contract` project (consumer contract tests)
tests/migration | qa/core | planned | Vitest `migration` project (expand/migrate/contract DB-change tests)
tests/resilience | qa/core | planned | Vitest `resilience` project
tests/recovery | qa/core | planned | Vitest `recovery` project
tests/accessibility | qa/accessibility | planned | Playwright accessibility owner directory
```

## Source-contract artifact ownership

The following source-contract artifacts implement bundle verification
obligations and are owned by the directories above. Their paths are a supported
consumer surface; changes preserve consumers or ship migration/deprecation
evidence (GAR-010). Paths marked `planned` are owned/reserved here now and land
in the phase that implements their capability.

```contracts
packages/evidence/src/retention.ts | present | VO-b9b935bf93be10bdecdd | Retention resolution, legal-hold enforcement, signed disposition records
packages/authz/src/separation-of-duties.ts | present | VO-173f7afb7801f4ab3e29 | Non-waivable SoD / self-approval / incompatible-role guards
vitest.workspace.ts | present | VO-ec575c4ce42b548bfb4d | Vitest projects: unit/contract/integration/security/migration/resilience
apps/api/src/middleware/context.ts | present | VO-e4323651ab39776dcdbd | Tenant context, CSRF, correlation IDs, disclosure-safe error middleware
adapters/wiggum/src/snapshot.ts | present | VO-d982977672dda011fc65 | Read-only Wiggum state/progress/locks/runs/verdicts/proofs snapshot
packages/application/src/config/environment.ts | present | VO-config-env | Typed environment parsing, secret-reference validation, safe defaults
tests/performance/config.ts | present | VO-perf-config | k6 acceptance-scale + fault-injection profiles
playwright.config.ts | present | VO-a11y-config | Playwright axe / keyboard / 400%-reflow projects
tests/integration/simulation-binding.test.ts | planned | VO-a5205654a25746949236 | Source-drift between inspect/simulate/approve/execute invalidates authority
apps/web/src/features/controllers/OperationActions.tsx | planned | VO-76455e2a60fbc99a2097 | Policy-aware pause/resume/reconcile/rollback/collect-evidence/cancel/e-stop controls
packages/evidence/src/original-preservation.ts | planned | VO-40b09e5441216007c9e5 | Capture raw source content/revision/metadata/digest/custody before any transformation
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
