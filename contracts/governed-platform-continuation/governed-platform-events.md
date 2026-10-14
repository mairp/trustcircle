# Governed Platform Event Contract

## Envelope

Every event is additive and uses the existing governance event transport and inbox/outbox rules.

| Field | Required rule |
|---|---|
| event_id | Globally unique UUID; inbox deduplication key |
| event_type | Closed versioned name from the catalog below |
| event_version | Positive integer; historical readers retain old versions |
| occurred_at | Time the canonical transaction committed |
| tenant_id | Required tenant boundary; never inferred from payload data |
| aggregate_type / aggregate_id / aggregate_version | Exact authoritative subject and expected ordering |
| actor_principal_id / service_principal_id | Human actor and automation identity where applicable |
| accountable_owner_id | Human authority or workflow owner |
| policy_decision_id | Required for governed transitions |
| correlation_id / causation_id | Stable end-to-end command and causal chain |
| idempotency_key | Required for externally initiated mutations |
| reason | Governed reason code and bounded text |
| evidence_refs | References only; no evidence body |
| schema_ref | Stable payload schema identifier/version |
| payload | Boundary-validated event-specific data |
| integrity | Canonical digest and signature/checkpoint reference where required |

Consumers MUST reject an invalid envelope, retain dead-letter evidence, and expose a terminal or retryable state. Duplicate event IDs acknowledge the prior inbox result. Gaps or out-of-order aggregate versions remain pending reconciliation; they are not applied as success.

## Event catalog

| Event type | Emitted after | Minimum payload |
|---|---|---|
| review.snapshot.signed.v1 | Atomic snapshot/signature/audit commit | snapshot ID, review/version, digest, signer, scope, source versions |
| review.snapshot.correction-linked.v1 | Correction link commit | snapshot ID, correction record ID, reason |
| review.comparison.generated.v1 | Reproducible comparison creation | baseline/target IDs, compatibility, delta counts, source digest |
| register.record.created.v1 | Register aggregate creation | kind, owner, severity, due/review/expiry |
| register.record.transitioned.v1 | Authorized expected-version transition | prior/new status, decision authority, version |
| register.record.expired.v1 | Expiry worker closes authority | record kind, expired-at, resulting status, next action |
| governed-view.changed.v1 | View create/update/share/revoke | view ID/version, resource type, visibility, sensitivity |
| subscription.changed.v1 | Subscription create/update/suspend/revoke | subscription ID/version, event/view, channel, cadence |
| notification.intent.created.v1 | Lifecycle event selects recipients | intent ID, disclosure profile, recipient reference, channel |
| notification.delivery.updated.v1 | Adapter reports delivery/reconciliation | attempt ID, status, attempt, remote ref, failure class |
| evidence.request.issued.v1 | Request and audit commit | request ID, recipient, due, claims, scope |
| evidence.attestation.signed.v1 | Immutable attestation commit | request/attestation IDs, evidence refs, claims digest, signer |
| evidence.sufficiency.decided.v1 | Auditor decision commit | request/decision IDs, verdict, exact evidence versions |
| evidence.derivative.created.v1 | Redaction/derivative verified | original/derived IDs and digests, authority, lineage |
| evidence.package.requested.v1 | Async package operation accepted | package/operation IDs, scope, audience, member query digest |
| evidence.package.signed.v1 | Manifest verified and signed | package ID, manifest digest, signer, verification result |
| control.observation.accepted.v1 | Source observation append | source event, asset/control/condition, status, freshness, completeness |
| monitoring.case.correlated.v1 | Case create/update projection | case key/policy version, observation refs, status, uncertainty |
| monitoring.case.transitioned.v1 | Authorized case transition | prior/new status, owner, verification/decision refs |
| change.impact-preview.generated.v1 | Version-pinned traversal completes | preview ID, proposal digest, source versions, affected counts, unknowns |
| change.publication.approved.v1 | Approval and publication commit | proposal/preview IDs, target version, authority, rollback ref |
| projection.invalidation.requested.v1 | Publication or entity decision commits | projection types, affected refs, source cursor, rebuild reason |
| projection.rebuild.updated.v1 | Projector reports progress/failure | invalidation ID, status, cursor, failure/terminal state |
| ai.use-case.changed.v1 | AI use-case lifecycle or version changes | use-case ID/version, prior/new status, changed component refs |
| ai.evaluation.recorded.v1 | Immutable evaluation commit | use-case/components, plan version, measures, verdict, digest |
| ai.incident.changed.v1 | Incident lifecycle commit | incident/use-case IDs, severity/status, affected scope |
| ai.copilot.exchange-recorded.v1 | Citation or abstention response produced | exchange ID, source refs/digests, citations, limitation/abstention codes |
| connector.definition.changed.v1 | Guided definition validated/versioned | connector/version, manifest digest, author, status |
| connector.conformance.completed.v1 | Signed suite report stored | connector/version, suite/report digests, verdict/counts |
| connector.certification.changed.v1 | Certify/revoke/expire commit | exact version/digests, certifier, bounds, validity, status |
| improvement.hypothesis.changed.v1 | Hypothesis/decision/outcome commit | hypothesis/version, aggregate measure refs, owner/status |
| entity-resolution.case.changed.v1 | Proposal/decision/apply/rollback commit | case/version, proposal type, source refs, status, authority |
| framework.mapping.changed.v1 | Mapping version approved/superseded | mapping/version, source/target, type, applicability, reviewer |

## Disclosure and compatibility

- Payloads contain identifiers, classifications, bounded reasons, state, and aggregate measures; evidence bodies, secrets, arbitrary copilot prompts, direct personal identifiers, and raw notification destinations are prohibited.
- Event authorization is evaluated at command time; query and notification consumers independently enforce current recipient authority.
- New optional fields are additive. Removing or redefining a field requires a new event version, consumer notice, migration evidence, overlap window, and rollback.
- Historical signature and digest verification always uses the schema version recorded in the event.
- Telemetry may summarize event processing but is never authoritative for canonical state or delivery success.