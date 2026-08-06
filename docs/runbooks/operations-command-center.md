# Operations Command Center Runbook

## Purpose and authority boundary

The operations command center is the tenant-scoped triage and accountability surface for unresolved
governance work. It prioritizes and links to authoritative domain records; it does not approve,
execute, remediate, certify, or replace those records. Operational cases track ownership, service
levels, evidence references, escalation, and independently verified closure.

Control versions:

- ranking and cursor contract: `attention-ranking/v1`;
- case lifecycle: `operational-case-lifecycle/v1`;
- service-level policies: `governance-{priority}/1.0.0`;
- authority plan: `operations-authority/v1`;
- API contract: `operations-command-center.openapi/1.0.0`.

## Ownership

- Service owner: Governance Operations.
- Queue/correlation control owner: Governance Platform Engineering.
- SLA policy owner: Governance Operations.
- Tenant and role-control owner: Identity and Authorization Engineering.
- PostgreSQL/RLS owner: Data Platform Operations.
- Accessibility owner: Web Platform Accessibility.
- Release evidence owner: Independent Release Reviewer.

An owner change must update this runbook, the scoped evidence manifest, and the release audit. An
unowned control or alert blocks promotion.

## Surfaces

Read APIs:

- `GET /v1/operations/attention`
- `GET /v1/operations/cases`
- `GET /v1/operations/cases/{caseId}`

Command APIs:

- `POST /v1/operations/cases`
- `POST /v1/operations/cases/{caseId}/transitions`
- `POST /v1/operations/cases/{caseId}/sla-evaluations`

The web workspace is server-rendered from verified tenant/session roles with `no-store` reads. Domain,
severity, ownership, time-posture, freshness, and assignment filters narrow visible items; critical,
overdue, unowned, stale, and assigned-to-me totals remain unfiltered.

## Role expectations

- Governance officers, control owners, operators, authorized approvers, and tenant compliance owners
  may create or transition cases within their verified tenant and command authority.
- Governance officers, authorized approvers, and independent compliance reviewers may verify only
  when lifecycle separation-of-duties checks pass.
- Auditors, central governance reviewers, and source stewards have read-only visibility.
- Automation principals may evaluate deterministic SLA state but receive no source-domain reads or
  arbitrary transition authority.
- Platform-administrator status alone grants no governance read or mutation authority.

Authorization is re-evaluated by the API for every request. Hiding a control in the browser is not an
authorization decision.

## Queue operations

1. Inspect the unfiltered summary before applying filters.
2. Review coverage quality for every permitted domain. `verified_empty` is authoritative only for a
   successfully observed domain; unknown, stale, partial, degraded, unavailable, or malformed input is
   not empty.
3. Work from the top-ranked item. Expand “Why this rank and where it came from” and confirm source
   records, observation times, owner posture, freshness, and disclosed factors.
4. Follow the governed-record link for domain action. Do not reproduce an approval or execution action
   in the command center.
5. Create a case when accountable ownership, SLA tracking, escalation, evidence, or closure review is
   required.

Correlation is conservative: only an exact governed problem key or versioned equivalence may merge
records. Conflicting or ambiguous records remain separate, with all original source references
preserved.

## Case and SLA operations

The lifecycle is `open → acknowledged → in_progress → awaiting_verification → resolved → closed`, with
`escalated` used when policy targets or ownership are breached. Every command requires a meaningful
reason, idempotency key, tenant scope, and exact current version/ETag.

- Create: preserve authoritative source references and select the priority policy.
- Assign: name an authorized owner; do not silently auto-assign a departed owner.
- Acknowledge/progress: bind the command to the current version.
- Submit for verification: supply current source versions and closure evidence references through the
  API. The UI intentionally does not infer them.
- Verify: use an independent authorized principal distinct from creator, owner, and source owner where
  required.
- Close: permitted only after verified resolution and complete evidence.
- Evaluate SLA: deterministic evaluation opens each configured escalation level once. Repeated
  delivery is idempotent.

After a timeout or uncertain command result, do not blindly retry. Read the case through the
independent case endpoint, reconcile the idempotency identity and current version, then retry only if
the authoritative outcome is absent.

## Monitoring and alerting

Monitor by tenant and control version, without protected evidence bodies:

- queue evaluation latency, candidate count, and cursor/snapshot conflicts;
- per-domain coverage quality, observation age, malformed/unavailable reads, and last successful read;
- cases by priority/status/owner and acknowledgement, resolution, and verification deadline;
- rejected, duplicate, conflict, and uncertain command outcomes;
- escalation level, deduplication key, delivery/reconciliation state, and time unowned;
- PostgreSQL transaction, RLS context, optimistic-version, and idempotency conflicts;
- audit sink failures and missing attributable outcomes.

Alert immediately when a critical domain becomes unavailable, audit persistence cannot confirm an
outcome, tenant context cannot be established, SLA escalation fails to persist, or source/evidence
reconciliation prevents closure. Alerts must name an owner and a safe next action.

## Failure handling

- Domain failure: retain successful domains, mark the failed domain visibly, and never infer healthy or
  empty aggregate state.
- Malformed response: reject the payload at the boundary and show a disclosure-safe diagnostic.
- Missing tenant/role: issue no protected reads; show authentication/authority state.
- Version conflict: return `412`, read the case, and re-author the command against current state.
- Idempotency conflict: return `409`; reconcile the original request rather than change its payload.
- Database/audit uncertainty: report an unconfirmed outcome and reconcile through a read before retry.
- Stale or absent evidence: keep the case open and retain references/history.

## Evidence and release gate

Generate and verify only the scoped feature manifest during this feature audit so unrelated dirty
global evidence is not overwritten:

```powershell
node scripts/ci/evidence-manifest.mjs build-operations
node scripts/ci/evidence-manifest.mjs verify-operations
node tests/evidence/audit-readiness/operations-command-center.mjs
```

Run the focused suites documented in
`specs/002-operations-command-center/quickstart.md`. Release is blocked by a missing owner, manifest
drift, failed feature test, serious/critical accessibility defect, destructive migration, or an
unexplained full-repository gate failure.

## Evidence-preserving rollback

Rollback is surface withdrawal, not data deletion:

1. Stop exposing the command-center navigation/UI and `/v1/operations/*` command routes in the target
   deployment configuration.
2. Leave all existing domain read/action routes and the prior governance visibility surface mounted.
3. Keep operational-case, source-reference, evidence-reference, transition, escalation, idempotency,
   and audit rows. Do not run a down migration or rewrite source/evidence history.
4. Confirm new case commands are unavailable while existing domain APIs, audit, evidence, tenant RLS,
   and source reads remain available.
5. Re-enable the additive surface with the same repository and confirm cases, transitions, evidence
   references, and escalations reconcile unchanged.

The automated rollback witness is
`tests/integration/operations-command-center-rollback.test.ts`. A destructive `DROP TABLE`, history
rewrite, tenant-boundary weakening, or deletion of referenced evidence is not an approved rollback.
