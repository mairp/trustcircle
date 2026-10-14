# Quickstart Validation Guide: TrustCircleAI Governance Control Plane

> **Current probe distinction (2026-08-04):** A JSON response from host port 14000 proves
> only the temporary fail-visible readiness proxy. Graphical acceptance requires the
> production-browser, accessibility, routing, degraded-API, and rollback evidence defined by
> run `c00a3659-463d-44fb-96c0-f5f3efab97d8`. Until its release and deployment gates pass,
> do not describe the running root as the graphical console.

This is the executable acceptance contract for the implementation phase. The repository is
currently at planning phase, so the package scripts and containers named here are work to
be created by `/speckit-tasks` and `/speckit-implement`; their names, inputs, exit behavior,
and evidence outputs are fixed by this guide.

Run commands from Linux/WSL:

```bash
cd <repo-root>
```

## Prerequisites

- Node.js 22 and npm 10
- Docker Engine with Compose v2
- At least 8 CPU cores, 16 GiB RAM, and 30 GiB free disk for the full local suite
- No production credentials; the E2E profile generates ephemeral tenants, identities,
  signing keys, source tokens, and evidence buckets
- Local ports selected by Compose or configured through `.env.e2e.local`

The validation stack contains PostgreSQL 16, NATS JetStream, an S3-compatible immutable
test store, OPA, OpenTelemetry Collector, TrustCircle API/workers/web, and deterministic
stub adapters. Live Kanban/workflow tests are opt-in and read-only by default.

## Bootstrap and contract gates

```bash
npm ci
npm run contracts:validate
npm run contracts:generate
npm run contracts:check
npm run lint
npm run typecheck
npm run test:unit
```

Expected:

- OpenAPI 3.1, AsyncAPI 3, and JSON Schema 2020-12 validate.
- Generated types have no diff.
- State-machine/property tests reject invalid and terminal-state rewrites.
- No unresolved unknown, placeholder, or unversioned public contract remains.

Start the isolated stack:

```bash
docker compose -f deploy/compose/control-plane.yml --profile e2e up -d --build --wait
npm run db:migrate
npm run fixtures:seed -- --profile e2e
npm run health
```

Expected:

- Every component reports identity, owner, version, last attempt/success, health,
  dependency state, retry state, evidence, and safe next actions.
- Governance readiness is healthy only after policy bundle signature, database RLS,
  evidence retention, NATS topology, and audit-ledger write/verify checks pass.
- The fixture command prints tenant/user/source IDs without secrets.

All scenario commands write a signed result manifest beneath
`artifacts/validation/<scenario>/<run-id>/manifest.json`. The manifest includes requirement
IDs, constitution principles, commands, assertions, audit IDs, evidence hashes, contract
versions, timestamps, and pass/fail status.

## Scenario 1 — Open-ended discovery and visible gaps

```bash
npm run test:e2e -- --scenario discovery-open-boundary
```

Fixture:

- one supported workflow source;
- one Kanban source;
- one previously unregistered repository-like source;
- one sensitive metadata-only source;
- one unsupported/unowned source; and
- one configured scan location that is unreachable.

Expected:

- every candidate appears once with discovery evidence and source provenance;
- protected content is not read from the metadata-only source;
- unsupported, unowned, inaccessible, and scan-gap states remain visible with impact,
  reason, owner action, and review;
- removing/renaming a source preserves history and marks current identity uncertain;
- dashboard coverage never treats unknown or unreachable as healthy.

Evidence: source-catalog snapshot, access-denial proof, discovery manifest, gap records,
projection cursor, and audit events.

## Scenario 2 — Human decision actions and separation of duties

```bash
npm run test:e2e -- --scenario human-decisions
```

Expected:

- an authorized approver can approve, deny, delegate, request changes, escalate, and expire
  only through valid transitions and with a reason;
- delegation is bounded, expiring, non-circular, non-expanding, and tenant-scoped;
- requester self-approval, evidence-custodian approval, expired delegation, missing reason,
  stale decision package, and platform-admin-only approval are rejected without state
  change;
- each accepted and rejected attempt has a durable AuditEvent, policy revision, actor,
  authority, reason, item version, evidence manifest, time, and correlation.

Evidence: decision records, rejection audit events, SoD evaluation, signed policy decision,
and hash-chain verification.

## Scenario 3 — Federated cross-tenant joint approval

```bash
npm run test:e2e -- --scenario cross-tenant-joint-approval
```

Expected:

- two affected tenants receive separate decision requirements;
- execution remains blocked after only one tenant approves;
- execution remains blocked after both approve until a distinct central reviewer approves;
- the central reviewer cannot also be requester, operator, control owner, or either tenant
  approver;
- revoking or expiring one tenant approval invalidates the joint package before execution;
- raw tenant evidence is not copied across boundaries without separate authorization.

Evidence: tenant-local decisions, central guardrail decision, joint package digest,
invalidation event, RLS denial tests, and cross-tenant access audit.

## Scenario 4 — Standards applicability and truthful compliance

```bash
npm run test:e2e -- --scenario standards-applicability
```

Expected:

- registry metadata contains versioned ISO/IEC 42001:2023, 42005:2025, and 42006:2025
  entries plus an importable future 4200x fixture;
- a tenant compliance owner proposes clause-level applicability with scope, rationale,
  evidence, owner, effective date, and review/expiry;
- the proposer cannot activate its own proposal;
- expired `not_applicable` reopens a coverage gap;
- 42006 is shown as audit-readiness/certification-body criteria, not organizational
  certification, unless a separately approved certification-body scope fixture is active;
- mapping, design, implementation, operating effectiveness, readiness, assessment, and
  certification remain distinct.

Evidence: registry/applicability/mapping versions, independent review, recalculated coverage,
gap events, and claim-classification assertions.

## Scenario 5 — Corrupted item preservation, quarantine, repair, and verified closure

```bash
npm run test:e2e -- --scenario integrity-remediation
```

Fixture includes malformed, corrupted, duplicated, stale, conflicting, and orphaned items.

Expected:

- the raw original and source metadata commit before normalization, quarantine, or repair;
- unsafe/ambiguous items are quarantined from execution but remain visible;
- a pre-authorized low-risk repair creates a derived item and never overwrites the original;
- a repair outside policy remains a recommendation awaiting human authority;
- verification reconciles current source state, checks evidence/control/dependencies/
  residual risk, and requires an independent verifier where applicable;
- failed or indeterminate verification remains unresolved/quarantined and escalates;
- source `done` alone cannot satisfy the Verified Closure Gate.

Evidence: original/derived SHA-256 values, provenance edges, quarantine record, plan/policy,
repair and rollback attempts, reconciliation, VerificationRecord, and closure audit.

## Scenario 6 — Destructive automation and rollback boundaries

```bash
npm run test:e2e -- --scenario destructive-remediation-boundaries
```

Expected:

- unapproved destructive remediation is denied;
- missing original, rollback, evidence plan, precondition, rate/time/blast bound, owner, or
  kill switch blocks execution;
- stale policy or source version invalidates simulation/approval;
- rollback never overwrites a newer legitimate source revision;
- rollback failure leaves visible degraded state, blocks further unsafe operations, and
  opens a critical incident.

Evidence: policy denials, zero target mutation proof, simulation binding, rollback
preimage/result, incident, and audit chain.

## Scenario 7 — Lost acknowledgement and idempotent reconciliation

```bash
npm run test:e2e -- --scenario uncertain-remote-outcome
```

Fault: the source applies a command, then the adapter connection drops before the response.

Expected:

- the operation becomes `pending_reconciliation`, never succeeded;
- resubmitting the same key returns the existing operation;
- a different request with the same key returns `409`;
- no blind second mutation occurs;
- reconciliation finds the source operation/result by key or observed state, records the
  actual revision, and then verifies completion;
- duplicate/out-of-order events do not repeat projection or source effects.

Evidence: dispatch trace, idempotency row, adapter operation lookup, inbox/outbox rows,
reconciliation diff/result, and target mutation count of one.

## Scenario 8 — Continuity-first bounded operation

```bash
npm run test:e2e -- --scenario bounded-continuity
```

Fault: controller loses control-plane connectivity after an approved operation starts.

Expected:

- only the already-approved, already-started operation enters continuity mode;
- a new operation and any new consequential/destructive step are blocked;
- every continued step validates the pinned policy snapshot, local conditions, scope,
  rollback, evidence buffer, and lease;
- lease never exceeds 15 minutes and cannot auto-renew;
- expiry stops at the next approved safe checkpoint;
- restored connectivity requires evidence flush and actual-state reconciliation before any
  subsequent mutation.

Evidence: policy snapshot/digest, lease, local observations, buffered audit/evidence,
checkpoint, stop event, and reconciliation.

## Scenario 9 — Kanban projection boundary

```bash
npm run test:e2e -- --scenario adapter-kanban
```

Expected:

- adapter reads through Kanban APIs/SSE, never SQLite;
- fixed columns map to presentation stages while raw column/workflow status remain;
- card movement cannot approve, accept risk, release quarantine, or close verified work;
- `done` maps to `source_reports_done`;
- unknown status opens a mapping gap rather than retaining an unexplained prior stage;
- duplicate, missing-link, out-of-order, deletion/tombstone, and recreation fixtures
  reconcile without losing originals or controller truth;
- unauthenticated/caller-header approval surfaces are rejected as authority.

Evidence: adapter conformance result, raw observations, mapping version, tombstone,
reconciliation, and authority-boundary tests.

## Scenario 10 — workflow_orchestration and agentctl compatibility

```bash
npm run test:e2e -- --scenario adapter-workflow-orchestration
npm run test:e2e -- --scenario adapter-agentctl
```

Expected:

- workflow adapter remains read-only while source runtime differs from its pinned
  OpenAPI/AsyncAPI contract;
- schema-version and event-subject drift is retained as an explicit contract gap;
- no direct source PostgreSQL access occurs;
- after a conforming stub is selected, snapshots plus events yield one ordered view;
- agentctl service integration uses the underlying API; CLI compatibility requires JSON
  output and never parses prose;
- CLI timeout after possible dispatch is reconciled by controller operation ID/key.

Evidence: contract comparison, egress log, credential scope, source snapshots/events,
CLI/API request digest, and reconciliation.

## Scenario 11 — Connector outage, replay, and projection rebuild

```bash
npm run test:e2e -- --scenario connector-resilience
```

Expected:

- connector outage becomes visible within 60 seconds with owner, affected work, last
  success, retry state, impact, evidence, and safe next action;
- new mutations block; read views show last-known time and stale/partial status;
- outbox/inbox and bounded retries retain events;
- exhausted retries create a dead-letter record and owned integration issue;
- after recovery, replay plus source snapshot reconciles gaps;
- deleting a dashboard projection and rebuilding it produces the same canonical digest.

Evidence: health observations, alert timing, queue metrics, dead letter, replay cursors,
source comparison, and projection digest.

## Scenario 12 — Tenant isolation, evidence retention, and tamper detection

```bash
npm run test:security -- --scenario tenant-rls
npm run test:e2e -- --scenario evidence-retention
npm run test:e2e -- --scenario audit-tamper
```

Expected:

- application/database/service/adapter paths deny cross-tenant row, object, event, cache,
  and credential access;
- evidence retention resolves to the longest approved policy/obligation/hold;
- missing retention policy blocks disposition and opens a gap;
- legal hold blocks disposition until an independently authorized release;
- disposition retains a signed record/manifest without silently rewriting evidence history;
- modifying, deleting, or reordering an audit event fails verification, opens a critical
  incident, and freezes affected consequential/destructive operations.

Evidence: adversarial RLS matrix, object namespace/key checks, hold/disposition records,
audit checkpoint signature, tamper alert, and incident.

## Scenario 13 — Contract and database evolution

```bash
npm run test:migrations -- --from previous-supported --to current
npm run test:contract -- --matrix previous-supported,current
```

Expected:

- expand migration allows old and new application versions to overlap;
- backfill emits counts, digests, skipped/quarantined records, and evidence;
- new readers tolerate old records and same-major additive fields;
- old readers tolerate approved additive events;
- unsupported major versions are retained/quarantined, not dropped;
- rollback restores the prior compatible application/schema boundary without deleting
  newly committed audit/evidence;
- contract/deprecation status is visible to connector owners.

Evidence: migration ledger checksum, compatibility matrix, before/after counts/digests,
rollback result, and signed migration manifest.

## Scenario 14 — Disaster recovery

```bash
npm run test:recovery -- --scenario canonical-restore
```

Faults: loss of the active PostgreSQL instance and read-model volumes.

Expected:

- authorized recovery point and target receive human approval;
- PostgreSQL restores within the four-hour contractual ceiling;
- committed decision/audit count and latest signed checkpoint verify with no accepted loss;
- evidence object versions/hashes and legal holds verify;
- NATS topology and pending outbox/inbox resume;
- projections rebuild deterministically;
- connectors/controllers remain paused or degraded until source reconciliation proves
  actual state;
- recovery creates incident, impact assessment, corrective action, verification, and
  control-improvement decision.

Evidence: approval, backup/restore manifests, checkpoint verification, evidence inventory,
replay/rebuild/reconciliation results, RTO/RPO measurement, and incident closure status.

## Scenario 15 — Dashboard, accessibility, scale, and export

```bash
npm run test:e2e -- --scenario role-dashboards
npm run test:accessibility
npm run test:performance -- --profile acceptance
```

Expected:

- operational, executive, compliance, auditor, and decision-queue views expose only
  authorized fields and include provenance/freshness/partial coverage;
- charts have equivalent summaries/tables; all actions work by keyboard and assistive
  technology; 400% zoom/reflow retains context; state never depends on color alone;
- 95% of primary views become usable within 3 seconds at acceptance scale;
- 99% of healthy-source changes appear within 2 minutes;
- 10,000 active-item reconciliation meets the 2-minute/95% objective;
- 100,000 evidence references export within 15 minutes or produce a complete explicit gap
  report;
- at least 90% of representative users complete their primary journey unaided.

Evidence: role/access matrix, axe/Playwright results, non-visual parity assertions,
performance report, export manifest/gap report, and usability results.

## Full release gate

```bash
npm run verify:release
```

This command must run contract, unit, integration, security, accessibility, resilience,
migration, recovery, performance, and E2E suites and then verify every produced evidence
manifest and audit checkpoint.

Release fails if any required approval, ownership, test, evidence, monitoring, rollback,
reconciliation, migration, standards mapping, tenant-isolation check, or constitution gate
is absent, stale, indeterminate, or failing.

## Teardown

```bash
docker compose -f deploy/compose/control-plane.yml --profile e2e down --volumes --remove-orphans
```

The E2E profile uses disposable fixtures only. Production evidence, source data, or
credentials must never be mounted into this teardown path.
