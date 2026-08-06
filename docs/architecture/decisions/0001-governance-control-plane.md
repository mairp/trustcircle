# ADR 0001 — Governance Control Plane Architecture

Phase 10 · T300 · GAR-010. **Status: Accepted** (final decision of record for the first release of
the TrustCircleAI Governance Control Plane).

This Architecture Decision Record captures the **final** architectural decisions of the increment,
the **alternatives that were considered and rejected** (with the reason each lost), and the
**extension points** left open so the system can evolve safely (per the compatibility policy in
`compatibility-policy.md`). It is the single durable answer to "why is it built this way, and where
may it grow?".

Companion documents: the ownership map (`docs/architecture/repository-layout.md`), the compatibility
policy (`docs/architecture/compatibility-policy.md`), the threat model (`docs/security/threat-model.md`),
the known-gaps register (`docs/governance/known-gaps.md`), and the continual-improvement backlog
(`docs/governance/continual-improvement.md`).

---

## Context

The system is a multi-tenant **governance control plane**: it maintains a canonical, tamper-evident
record of governed assets, human/automated decisions, controls, evidence, and the audit ledger, and
presents a **fail-visible operating picture** to officers. The load-bearing oracle
(VO-6acaf6470d0810df4c93) is that this picture must be _current and fail-visible_ — a stale, missing,
or degraded facet is surfaced, never inferred-healthy. Accountability (GAR-003 separation of duties)
and compatibility (GAR-010) are non-negotiable.

---

## Decisions (final, of record)

### D1 — One transactional governance core; independently deployable edge/process boundaries

A TypeScript monorepo (npm workspaces) with **one transactional core** (`packages/domain`,
`packages/application`, `packages/persistence`) and **independently deployable process boundaries**
(`apps/api`, `apps/web`, `apps/command-worker`, `apps/projector`, `apps/discovery-agent`). Bounded
contexts can later be split into separate services **without changing their canonical contracts**.

- **Rejected: a single monolith service.** Would couple the read models, the executor, and
  discovery to the API lifecycle and prevent independent scaling/deployment of the projector and
  worker.
- **Rejected: microservices-from-day-one.** Premature distribution would multiply the transactional
  boundaries before the domain was stable; the modular monorepo keeps one transaction boundary now
  and preserves the _option_ to split (see extension point X1).

### D2 — Domain independent of infrastructure; adapters out-of-process by default

Domain code depends on **no** framework (Hono), database (PostgreSQL), broker (NATS), policy engine
(OPA), or object store. Controller/source adapters are **out-of-process by default** so vendor
libraries and source credentials can never enter the canonical core.

- **Rejected: in-process vendor SDK adapters.** Would drag third-party code and live credentials
  into the core's trust boundary, breaking least-disclosure (threat-model A6) and making the core
  un-testable under `npm ci` with no infra.

### D3 — Dependency-free, framework-agnostic HTTP boundary

`apps/api` is built on the Web-Fetch `Request`/`Response` substrate (the same one Hono runs on), so
the same routes mount unchanged on Hono/Node/Bun/Workers and the bootstrap is independently testable
with **no framework installed**. Every route is version-prefixed (`/v1`).

- **Rejected: hard dependency on a specific web framework.** Would make the boundary un-testable in
  isolation and couple the version/health/shutdown contract to a framework's middleware model.

### D4 — Fail-visible operating picture (no green-over-hollow)

Readiness renders the oracle's eleven facets, each stamped with its own currency (`fresh`/`stale`);
any core facet that is unavailable/stale makes the aggregate `unavailable` and returns 503. Health
is **observed, never inferred from absence** (enforced in the DB by
`health_no_positive_from_absence`).

- **Rejected: a single boolean health check.** A green 200 over a hollow or stale picture is exactly
  the failure this system exists to prevent.

### D5 — Tamper-evident audit ledger + content-addressed immutable evidence

Every consequential action is written to an append-only, hash-chained ledger with signed
checkpoints; evidence is stored content-addressed and immutable. Accountability completeness (actor,
owner, reason, states, versions, evidence, scope, time, correlation, outcome) is enforced _before_ an
action can be reported complete.

- **Rejected: mutable audit rows / a general log store.** Would not be tamper-evident and could not
  support the accountability-completeness gate.

### D6 — Separation of duties enforced at the boundary and the data layer

Request/review/approval/execution/evidence/ownership/assurance are separated where conflicts exist;
platform administration alone grants **no** decision authority (`packages/authz`, the API context
middleware, and DB constraints all enforce this).

- **Rejected: role-name-only authorization.** Would let a platform admin be mistaken for a
  decision-maker; SoD must be structural, not naming-convention.

### D7 — Canonical JSON, signed deterministic manifests, and deterministic time

Evidence/validation manifests are canonical (sorted-key) JSON signed with sha256/HMAC over a body
that **excludes** the run timestamp, so the signed digest is reproducible. Modules never read the
wall clock implicitly — "now" is injected — so behaviour is deterministic and unit-testable.

- **Rejected: ad-hoc JSON + implicit `Date.now()`.** Non-reproducible digests and non-deterministic
  tests; a signed manifest whose digest drifts run-to-run is not evidence.

### D8 — Expand → migrate → verify → contract schema evolution, additive-only within a major

Migrations are ordered, applied-once, checksum-pinned, and idempotent. A breaking change is never
applied in place; it expands, backfills, verifies via an independent read path, and only then
contracts. Contract compatibility is additive within a major (D from `compatibility-policy.md`).

- **Rejected: destructive in-place migrations.** Would create a breaking window and make rollback
  impossible mid-migration.

### D9 — Component availability is separate from design authority (core-only default)

Only the **core profile** runs continuously; every optional component is intentionally-inactive /
on-demand until an owner-approved activation path proves identity, contract, authority, backlog, and
reconciliation. Activation/deactivation never disturbs the core decision/audit/evidence/visibility
functions.

- **Rejected: everything-on-by-default.** Would enlarge the attack surface and blur the line between
  a component being _available_ and being _authoritative_.

### D10 — Production-safe-by-default hardening, fail-closed

Security headers, request/body limits, dependency timeouts, secret scanning, and production-safe
defaults are declared in one place (`apps/api/src/security-hardening.ts`) and the service **refuses
to start** in production with an unsafe default (blank/weak secret, verbose errors, wildcard CORS).

- **Rejected: hardening as deployment-time config only.** Config drift silently reintroduces unsafe
  defaults; failing closed in code makes an unhardened production build impossible to launch.

---

## Consequences

- **Positive:** the core is testable with no infra; the picture cannot go green-over-hollow;
  accountability and SoD are structural; schema and contract evolution are safe and evidenced;
  production launches are hardened by default.
- **Negative / costs:** the dependency-free boundary and canonical-manifest discipline add
  boilerplate; the modular-monorepo boundaries require care to keep the core infra-independent; the
  core-only default means operators must explicitly activate optional components.

---

## Extension points (where the system may grow safely)

| ID  | Extension point                                                                   | How it stays safe                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | **Split a bounded context into its own service.**                                 | Canonical contracts (`packages/contracts`) are unchanged; the split is transparent to consumers (D1).                                                                                          |
| X2  | **Add a source/controller adapter.**                                              | Out-of-process, versioned, signed, immutable adapter definitions via `packages/adapter-sdk`; no vendor code enters the core (D2).                                                              |
| X3  | **Add an API major or event schema major.**                                       | Governed by `compatibility-policy.md`: N and N−1 in parallel, deprecation windows, retirement gates, migration evidence.                                                                       |
| X4  | **Localize the officer surface.**                                                 | `apps/web/src/i18n/catalog.ts` — add a locale catalog + it is direction-safe (LTR/RTL) with Intl-backed date/number/tz formatting (T298).                                                      |
| X5  | **Add a new projection/read model.**                                              | New projector read model over the canonical event stream; keyset-paginated and budgeted per `db/migrations/0090_query_tuning.sql` (T297).                                                      |
| X6  | **Activate an optional component.**                                               | Owner-approved activation path proves identity/contract/authority/backlog/reconciliation without disturbing core (D9; validated in `artifacts/validation/component-activation/manifest.json`). |
| X7  | **Add a governed action type.**                                                   | Must satisfy the accountability-completeness gate and SoD before it can report complete (D5, D6).                                                                                              |
| X8  | **Swap an infrastructure implementation** (DB/broker/object store/policy engine). | Domain depends on ports, not implementations (D2); a new adapter implements the port.                                                                                                          |

---

## Related / superseding

This is the first ADR (0001) and is the current decision of record. A future decision that changes
any of D1–D10 must be recorded as a new ADR that explicitly references and supersedes the affected
decision here, and — where it touches a consumer surface — must satisfy the compatibility policy's
change-control clause (`compatibility-policy.md` §8).
