# TrustCircleAI Interface Contracts

These Phase 1 contracts define behavior and compatibility, not implementation ownership.
They are canonical for TrustCircleAI adapters and clients:

- [governance-api.openapi.yaml](governance-api.openapi.yaml): user, auditor, operator, and
  control-plane command/query API.
- [governance-events.asyncapi.yaml](governance-events.asyncapi.yaml): durable canonical
  event envelope and event channels.
- [adapter-protocol.openapi.yaml](adapter-protocol.openapi.yaml): out-of-process source and
  controller adapter protocol.
- [adapter-manifest.schema.json](adapter-manifest.schema.json): adapter capability,
  authority, security, ordering, failure, reconciliation, and lifecycle declaration.
- [evidence-envelope.schema.json](evidence-envelope.schema.json): evidence provenance,
  integrity, classification, access, retention, custody, and disposition.

## Contract authority

1. PostgreSQL canonical records and committed AuditEvents are authoritative for governance
   decisions, permissions, mappings, operation state, and evidence metadata.
2. An external source remains authoritative only for the fields declared in its approved
   SourceContractVersion and AdapterManifest.
3. NATS events, SSE, dashboards, search indexes, Kanban cards, and telemetry are transport
   or projections. They cannot authorize an operation or prove verified closure.
4. A contract-invalid input is preserved as evidence before quarantine. It is never
   normalized in place and never silently discarded.

## Common HTTP rules

### Authentication and tenant context

- User calls require an OIDC access token with issuer, audience, subject, expiry, and
  authentication assurance validation.
- Workload calls require a distinct workload identity and mTLS or an approved equivalent.
- `X-Tenant-ID` identifies the requested tenant but is not authority by itself. The
  authenticated principal's current assignment and request scope must allow it.
- Cross-tenant calls use an explicit joint package ID; a caller cannot submit a wildcard
  or comma-separated tenant context.

### Mutations

Every mutation requires:

- `Idempotency-Key`: 8–128 visible characters, unique for the tenant and operation scope;
- `X-Correlation-ID`: UUID;
- `If-Match`: current resource version/ETag when changing an existing aggregate;
- a mandatory reason in the body for human decisions and governance exceptions;
- a current policy decision or enough context for the API to create one; and
- an audit commit in the same transaction as state change and outbox event.

Reusing an idempotency key with the same request digest returns the original operation and
does not repeat the effect. Reusing it with a different digest returns `409 Conflict`.

### Response metadata

Responses expose:

- canonical `resource_version` or ETag;
- `correlation_id`;
- `audit_event_id` for accepted/rejected governed actions;
- `policy_decision_id` where authorization was evaluated;
- projection `generated_at`, `source_cursor`, `freshness`, and `partial_coverage` for read
  models; and
- `operation_id` plus reconciliation state for asynchronous/remote mutations.

### Error envelope

All errors use:

```json
{
  "type": "https://trustcircle.ai/problems/precondition-failed",
  "title": "Precondition failed",
  "status": 412,
  "code": "source_version_changed",
  "detail": "The source changed after simulation.",
  "correlation_id": "018f...",
  "audit_event_id": "018f...",
  "retryable": false,
  "safe_next_actions": ["inspect", "simulate", "request_changes"]
}
```

No error response exposes credentials, policy bundle content, protected evidence, another
tenant's identity, or raw source payload.

## Outcome and failure taxonomy

| Outcome/code | Meaning | Retry/reconciliation behavior |
|---|---|---|
| `confirmed` | Target source proves the requested resulting version/state | Complete only after audit/evidence verification |
| `duplicate` | Same idempotency key and request already completed or remains active | Return prior operation; no second effect |
| `accepted_pending` | Canonical request committed; asynchronous work not yet dispatched | Worker may claim |
| `pending_reconciliation` | Dispatch may have changed the source but acknowledgement/result is uncertain | Do not blind retry; inspect by operation ID/key or reconcile observed state |
| `conflict` | Expected canonical/source version no longer current | Reinspect and resimulate; prior approval invalid |
| `policy_denied` | Current policy/SoD/delegation/tenant guard disallows action | No retry until facts or authority legitimately change |
| `unauthenticated` / `unauthorized` | Identity invalid or lacks scope | Fail closed; alert if repeated |
| `invalid_contract` | Payload or schema invalid | Preserve original, quarantine, open integration issue |
| `unsupported_contract` | Major contract/capability not supported | Park/dead-letter with evidence; require compatible version |
| `rate_limited` | Source returned bounded throttling response | Retry with server hint/backoff and same key |
| `transient` | Dependency failed before dispatch | Bounded backoff with same key |
| `rollback_failed` | Compensating action failed or would overwrite newer state | Mark degraded, block unsafe operations, preserve partial result, escalate |
| `verification_failed` | Expected result, evidence, or control test not proven | Keep unresolved/quarantined; escalate |

HTTP mapping:

- `400`: malformed HTTP/body;
- `401`: unauthenticated;
- `403`: authenticated but unauthorized/policy denied;
- `404`: resource absent within the authorized tenant view;
- `409`: idempotency digest conflict, invalid state transition, or source conflict;
- `410`: retired contract/resource;
- `412`: optimistic or source precondition failed;
- `422`: schema-valid envelope with invalid domain fields;
- `429`: rate limited;
- `503`: dependency unavailable before dispatch;
- `504`: timed out; response must say whether dispatch is known not to have occurred or is
  `pending_reconciliation`.

## Event rules

- Event transport is at-least-once. Consumers persist InboxMessage by `(consumer_id,
  event_id)` before applying.
- Producers write OutboxMessage in the canonical transaction and publish using `event_id`
  as the transport deduplication ID.
- Aggregate ordering uses `aggregate_id` plus monotonically increasing
  `aggregate_version`. Timestamps never resolve ordering conflicts.
- Consumers tolerate unknown additive fields in the same major schema and quarantine
  unsupported major versions.
- An event is acknowledged only after durable apply, durable duplicate recognition, or
  durable quarantine/dead-letter. Missing correlation/linkage remains an owned orphan, not
  an acknowledged disappearance.
- NATS retention does not define evidence or audit retention.

## Adapter protocol

An adapter runs outside the canonical core process. It receives only its tenant/source
credential reference, allowed egress, and manifest-declared capability. It cannot query the
TrustCircleAI database or another source's database.

### Capability semantics

| Capability | Contract behavior |
|---|---|
| `discover` | Return authorized source metadata/candidates and scan gaps without protected content |
| `inspect` | Return a current, versioned source observation and raw-evidence reference |
| `snapshot` | Page through a source/collection with stable cursor and explicit partial coverage |
| `subscribe` | Emit observation envelopes with source ordering and tombstones |
| `simulate` | Predict scope/effects without mutation; bind result to source revision and expiry |
| `execute` | Apply only an approved operation with key, expected revision, bounds, and evidence plan |
| `pause` / `resume` | Use source-native safe checkpoint; resume requires current authority/preconditions |
| `reconcile` | Compare operation/desire to authoritative observed source state; never infer success |
| `rollback` | Restore only the approved preimage/compensation without overwriting newer legitimate state |
| `collect_evidence` | Capture versioned source evidence under classification/access/retention rules |
| `quarantine` / `restore` | Block/release source execution only within manifest and policy scope |

### Adapter activation gates

An AdapterVersion becomes active only when:

1. manifest and referenced schemas validate;
2. manifest digest/signature verify;
3. contract range overlaps the platform-supported range;
4. requested capabilities and network/credential scope are least-privilege;
5. conformance, negative-path, idempotency, reconciliation, and evidence tests pass;
6. owner, health, retry, deprecation, and failure semantics exist;
7. an authorized owner approves activation; and
8. the active version and evidence are recorded.

## Initial source mappings

### Kanban

**Source authority**:

- Native card title/details/column/order and source timestamps are Kanban fields.
- Workflow status, policy/spec identifiers, verdict, escalation, and controller cursor are
  projections of workflow_orchestration, not Kanban authority.
- Card movement cannot create approval, accept risk, release quarantine, or verify closure.

**Presentation mapping**:

| Kanban column | Canonical presentation stage |
|---|---|
| `backlog` | `intake` |
| `in-progress` | `active` |
| `review` | `under_review` |
| `done` | `source_reports_done` |
| `blocked` | `attention_required` |

The adapter preserves the raw column and workflow status separately. Unknown values map to
`unmapped` and open a mapping gap. `source_reports_done` must pass the Verified Closure
Gate before a governance item closes.

**Read surfaces**:

- `GET /api/board`, `/api/board/cards/{id}`, `/api/board/archive`,
  `/api/board/workflow-links`, and `/api/board/events`;
- health and workflow/adapter health surfaces;
- source observations are wrapped with source revision/sequence, mapping version,
  observed time, raw-evidence digest, and tenant binding.

**Write surfaces**:

- Board mutations are invoked through the owning API only.
- Existing unauthenticated or caller-header approval proxies are never used as
  TrustCircleAI authority.
- External deletion becomes a tombstone with archived/raw evidence and preserved linkage.

### workflow_orchestration

**Source authority**: workflow run/step lifecycle, runtime assignments, controller
observations, PMO source records, source approval records, and its evidence exports remain
owned by workflow_orchestration. TrustCircleAI owns whether those observations satisfy a
governance decision or control.

**Read/event surfaces**:

- `/v1/runs`, `/v1/runs/{runId}`, SSE events, evidence, operational graphs, runtimes,
  PMO, and agent registry;
- version-pinned AsyncAPI subjects after contract conformance;
- periodic snapshots are required even when event consumption is healthy.

**Command surfaces**:

- Submit/operate through its API with stable idempotency, expected versions, and
  TrustCircle decision references where supported.
- The first adapter release is read-only until observed runtime behavior matches the pinned
  OpenAPI/AsyncAPI contract and authenticated authority/audit requirements.
- No direct access to workflow PostgreSQL, operational event tables, or NATS as a substitute
  for source reconciliation.

### agentctl

agentctl is primarily a CLI client over workflow_orchestration. Service integration uses
the underlying OpenAPI rather than spawning/parsing the CLI. The agentctl adapter exists
for governed human/automation compatibility and:

- requires a machine-readable JSON output mode and explicit CLI semantic version;
- never parses human-readable prose as canonical state;
- passes stable idempotency/correlation/tenant context;
- captures command, exit status, stdout/stderr digests, controller operation ID, and
  evidence;
- treats timeout after dispatch as `pending_reconciliation`; and
- cannot add authority beyond the authenticated workflow API identity.

## Contract and schema evolution

- Contract identifiers use semantic versions. The major version is present in HTTP paths,
  manifest ranges, event schema versions, and generated SDK packages.
- Same-major changes are additive: new optional fields, enum extension with documented
  unknown handling, or new endpoints/events. Existing required meaning cannot change.
- Breaking field meaning, removal, security behavior, ordering, authority, or failure
  semantics requires a new major.
- At least the active major and one approved previous major remain supported during a
  published deprecation window, unless a critical security exception is independently
  approved.
- Database changes use expand → migrate/backfill → verify → contract. Old/new application
  overlap is tested before deployment.
- Mapping changes create a new MappingVersion and recalculate projections without
  rewriting historical source records or audit results.
- Migration and rollback produce signed evidence manifests, counts/digests, unresolved
  records, and compatibility-test results.

## Required adapter conformance scenarios

1. Manifest/schema/signature validation and over-privileged capability rejection.
2. Full and paginated discovery with a protected-content access denial.
3. Duplicate observation and command delivery.
4. Out-of-order and missing aggregate sequence.
5. Source revision conflict after simulation.
6. Timeout before dispatch versus timeout after possible dispatch.
7. Rate limiting, bounded retry, exhausted retry, and dead-letter evidence.
8. Unsupported major schema with original preservation/quarantine.
9. Source delete/tombstone and later recreation.
10. Lost link/orphan followed by reconciliation.
11. Rollback success, rollback conflict with newer state, and rollback failure.
12. Evidence store unavailable before mutation.
13. Tenant-context substitution and cross-tenant access denial.
14. Health/readiness degradation with owner, impact, lag, and safe next action.
15. Old/new adapter overlap during a supported migration.
