# Architecture overview

How TrustCircleAI keeps governance authority, evidence and audit trustworthy. The README has the
short version; this page is the reference for architects and reviewers evaluating the platform.

> **Architectural invariant:** a convenient UI, event, search result, dashboard, or telemetry signal
> never becomes governance authority. Consequential state changes require current human authority,
> policy and separation-of-duties checks, an atomic canonical state and audit commit, and retained
> evidence.

## Components

```mermaid
flowchart LR
  Actor["Human or workload identity"] --> Edge["Web and API boundary"]
  Edge --> App["Application use cases"]
  App --> Domain["Domain invariants and state machines"]
  App --> PDP["Replaceable policy decision port / OPA"]
  Domain --> Tx["PostgreSQL canonical transaction"]
  Tx --> Audit["Hash-chained audit ledger"]
  Tx --> Outbox["Transactional outbox"]
  Tx --> EvidenceMeta["Evidence metadata and custody"]
  EvidenceMeta --> EvidenceStore["Content-addressed immutable-capable store"]
  Outbox --> Events["NATS JetStream"]
  Events --> Workers["Command workers and projectors"]
  Workers --> ReadModels["Role- and tenant-scoped read models"]
  ReadModels --> Edge
  Workers --> Adapters["Out-of-process, version-pinned adapters"]
  Adapters --> Sources["External authoritative sources"]
  Sources -. "observations and reconciliation" .-> Adapters
```

The monorepo keeps the transactional governance core separate from independently deployable APIs,
workers, projectors, discovery, web presentation, and adapters. Domain code remains independent of
transport, database, policy-engine, object-store, and vendor libraries so those technologies remain
replaceable behind explicit ports and contracts.

## Authority and responsibility boundaries

| Boundary                                                          | Authoritative for                                                                                     | Never authoritative for                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| PostgreSQL canonical state and committed audit events             | Governance decisions, permissions, mappings, operation state, evidence metadata, and durable versions | External source fields not owned by TrustCircleAI                                          |
| External source through an approved contract                      | Only the fields declared in its active `SourceContractVersion` and adapter manifest                   | TrustCircleAI authorization, verified closure, or compliance claims                        |
| Policy decision point                                             | A version-bound decision for supplied facts                                                           | Expanding identity, tenant scope, delegation, or fixed separation-of-duties guardrails     |
| Evidence object store                                             | Preserved original and derived content by digest                                                      | Business-row state, access authority, or retention decisions                               |
| NATS, SSE, projections, search, dashboards, Kanban, and telemetry | Transport and rebuildable presentation                                                                | Authorizing commands, proving closure, or replacing canonical state                        |
| Platform workspaces and copilot                                   | Authorized, citation-bound presentation and safe navigation                                           | Mutation, independent assurance, legal advice, conformity, accreditation, or certification |

### Architectural principles

1. **Humans retain consequential authority.** Automation may recommend, simulate, prepare, or execute
   only inside an approved, versioned, time-bounded policy. Self-approval is prohibited where roles
   conflict, delegation cannot expand authority, and platform administration alone grants no governance
   data access.
2. **Tenant planning precedes every read and write.** The authenticated assignment, role set, resource
   scope, environment, action, and validity window are evaluated server-side. `X-Tenant-ID`, a route,
   hidden UI control, local cache, or client-side filter is never authority. Production persistence uses
   tenant context and forced row-level security.
3. **Canonical change and audit commit together.** State transition, policy-decision reference, audit
   event, and outbox message are one transaction. If the audit record is missing, the action failed.
4. **Remote uncertainty remains uncertainty.** A timeout or lost acknowledgement after dispatch becomes
   `pending_reconciliation`; it is not reported as success and is not blindly retried as a new effect.
5. **Original evidence is preserved.** Repair, normalization, redaction, and export create attributable
   derivatives linked by provenance. They never silently overwrite malformed, partial, or original
   material.
6. **Unknown and degraded are first-class states.** Unavailable, stale, partial, unauthorized,
   verified-empty, blocked, and unknown states stay distinct. Missing coverage cannot be converted to
   healthy, absent, compliant, or complete.
7. **Adapters are replaceable and least-privileged.** Vendor behavior and credentials stay outside the
   core. Adapters use versioned contracts, capability allowlists, idempotency, bounded retries,
   reconciliation, evidence capture, and source-native APIs—never direct foreign database access.
8. **Contracts evolve compatibly.** Same-major changes are additive. Breaking meaning, authority,
   ordering, security, or failure semantics requires a new major, consumer evidence, a deprecation
   window, migration, and rollback plan.
9. **Compliance language is deliberately narrow.** A mapping, dashboard posture, readiness assessment,
   or internal control result does not establish legal compliance or external certification.
10. **Deployment identity is not assurance.** A build version, environment profile, healthy process, or
    completed test is useful evidence, but only the governed release gate determines whether the covered
    release is approved. Deferred or indeterminate evidence blocks release and must never be relabeled.

11. **Signed review history is immutable governance truth.** A snapshot binds exact source,
    schema, registry, policy, signer, and signature versions. Corrections link to signed history;
    comparisons are reproducible only across compatible periods and preserve unknown outcomes.
12. **Registers, views, and collaboration preserve current authority.** Risk, gap, exception, and
    improvement transitions are optimistic and separation-of-duties constrained. Shared views store
    an allowlisted query AST, not authorized results, and every notification is minimized and
    reauthorized when rendered for delivery.
13. **Monitoring preserves observations and previews are pure.** Deduplication creates one actionable
    case without deleting source facts. Stale, partial, conflicting, or unhealthy signals never infer
    pass. Change impact is version-pinned and non-mutating; drift invalidates approval before
    publication, rebuild, or rollback.
14. **AI governance binds the exact component set.** Use-case activation depends on current
    independently reviewed model, provider, prompt, tool, data, evaluation, and monitoring versions.
    Copilot retrieval is authorized before invocation, cites exact governed records, labels fact versus
    inference or suggestion, abstains when support is insufficient, and cannot call approval actions.
15. **Connector certification is exact and revocable.** Guided authoring produces the canonical
    manifest; signed conformance evidence covers success and all required failure dimensions. A
    separate certifier binds the exact digest, tenant, scope, capability, credential class, validity,
    compatibility, and health bounds. Revocation blocks new work but retains uncertain work for
    reconciliation.
16. **Entity and framework truth are never flattened.** Entity resolution preserves source identities
    and reversible review history. Framework projections retain mapping ambiguity and keep
    applicability, organizational duty, control coverage, evidence sufficiency, readiness, assessment,
    and external certification as separate facts.

## Command and query behavior

### Governed command path

1. Authenticate the principal and resolve current tenant-scoped assignments, attributes, delegation,
   break-glass state, and separation-of-duties constraints.
2. Validate the versioned request contract, scope, reason, idempotency key, correlation ID, expected
   resource version, and source preconditions.
3. Evaluate the active signed policy bundle and non-waivable authority guardrails.
4. Atomically commit the requested state transition, policy-decision reference, audit event, and outbox
   message.
5. A worker revalidates time-sensitive authority and preconditions before using a version-pinned adapter.
6. Confirm the remote outcome with evidence, or retain a rejected, failed, or
   `pending_reconciliation` state until observation resolves it.

Mutations use `Idempotency-Key`, `X-Correlation-ID`, and `If-Match` where an aggregate already exists.
Reusing a key with the same digest returns the prior result; reusing it for a different request is a
conflict.

### Query and workspace path

Projectors consume committed events through durable inboxes and build reconstructable read models with
canonical version, source cursor, generated time, freshness, provenance, and partial-coverage metadata.
The web layer establishes the permitted `DomainPlan` before loading domains and then exposes only
allowlisted presentation fields.

Saved views contain filter metadata only and are scoped to the current tenant and role-set witness.
Product analytics accepts only `application/json` bodies of at most 2048 actual UTF-8 bytes containing
bounded route, outcome, duration-bucket, result-count, and binary-feedback events; queries, record
identifiers, evidence, governed content, arbitrary routes, wrong media types, oversized bodies, and
unknown fields are rejected before logging.

## Repository layout

```text
apps/
  api/                  versioned command/query APIs and runtime composition
  web/                  accessible, server-rendered governance workspaces
  command-worker/       governed operation execution
  projector/            role-specific rebuildable read models
  discovery-agent/      least-privilege source discovery
packages/
  domain/               entities, invariants, ranking, and state machines
  application/          use cases and infrastructure ports
  authz/ policy/        tenant authority, RBAC/ABAC/SoD, policy lifecycle and PDP port
  persistence/          PostgreSQL repositories, outbox/inbox, and migrations
  audit-ledger/         hash chain, checkpoints, and verification
  evidence/             content-store port, provenance, retention, and export
  projections/          operational, executive, compliance, and auditor read models
  contracts/            generated OpenAPI, AsyncAPI, and JSON Schema bindings
  adapter-sdk/          adapter protocol, conformance kit, and compatibility harness
  observability/        health, metrics, traces, and disclosure-safe telemetry
adapters/               reference adapters for internal work-tracking and agent-orchestration tools
db/migrations/          additive and reversible canonical schema evolution
deploy/                 Compose and Kubernetes deployment profiles
contracts/              machine-readable OpenAPI, AsyncAPI, and JSON Schema source contracts
roadmap/                prioritized platform evolution and honest implementation status
```

See also: [compatibility policy](compatibility-policy.md), [architecture decisions](decisions/),
[repository layout and ownership](repository-layout.md), and the
[threat model](../security/threat-model.md).
