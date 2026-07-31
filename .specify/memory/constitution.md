<!--
Sync Impact Report
- Version change: unratified template -> 1.0.0
- Modified principles:
  - Template placeholders -> I. Human Authority Over Consequential Actions
  - Template placeholders -> II. Attributable, Reasoned, and Auditable Decisions
  - Template placeholders -> III. Separation of Duties and Least Privilege
  - Template placeholders -> IV. Bounded and Reversible Automated Remediation
  - Template placeholders -> V. Versioned and Continuously Assured Controls
  - Template placeholders -> VI. Evidence Preservation and Repair Integrity
  - Template placeholders -> VII. Observable, Owned, and Fail-Visible Operations
  - Template placeholders -> VIII. Resilient, Versioned Integration Contracts
  - Template placeholders -> IX. Truthful Compliance and Assurance Claims
  - Template placeholders -> X. Compatible Evolution and Continuous Improvement
- Added sections:
  - Control and Assurance Baseline
  - Standards Registry and Compliance Truth
  - Delivery and Operational Gates
- Removed sections:
  - None; all template placeholders were replaced.
- Templates requiring updates:
  - ✅ .specify/templates/plan-template.md
  - ✅ .specify/templates/spec-template.md
  - ✅ .specify/templates/tasks-template.md
  - ✅ .agents/skills/speckit-*/SKILL.md reviewed; no command changes required
- Follow-up TODOs: None
-->
# TrustCircleAI Constitution

TrustCircleAI is a vendor-neutral AI governance control plane for continuous visibility,
human oversight, control orchestration, evidence management, compliance mapping, issue
remediation, and ecosystem integration across an explicitly declared deployment boundary,
including machine-wide deployments over existing implementations. This constitution
defines the non-negotiable conditions under which the platform is specified, built,
operated, and changed.

## Core Principles

### I. Human Authority Over Consequential Actions

An accountable human MUST retain final authority over any action that can materially affect
rights, access, safety, employment, finances, legal or compliance posture, production
availability, policy status, or retained evidence. The platform MAY recommend, prepare, or
execute an action only within a human-approved policy whose scope, duration, risk limits,
and escalation path are explicit. An action outside those bounds MUST stop safely and
request authorized human review. Interfaces MUST present the decision context, affected
scope, material risks, evidence, alternatives, and expected result before approval.

**Rationale**: TrustCircleAI augments accountable decision-makers; it does not displace
their authority for consequential outcomes.

### II. Attributable, Reasoned, and Auditable Decisions

Every approval, denial, exception, and automated action MUST produce a durable audit record
containing the authenticated actor or service principal, accountable owner, role, rationale,
timestamp, input and evidence references, applicable policy and control versions, requested
and actual scope, outcome, and correlation identifier. Automated actions MUST identify both
the executing principal and the human-approved policy that granted authority. Audit records
MUST be append-only or tamper-evident, access-controlled, queryable, exportable, and retained
under an approved retention schedule. A missing audit record MUST be treated as a failed
action, not a successful one.

**Rationale**: Accountability requires evidence that can reconstruct what happened, why it
happened, under whose authority, and with which governing rules.

### III. Separation of Duties and Least Privilege

Authorization MUST separate request, review, approval, execution, evidence administration,
control ownership, and assurance functions wherever combining them creates a conflict of
interest. A principal MUST NOT approve its own consequential request or alter the evidence
used to assess its own action. Permissions MUST be purpose-bound, least-privileged,
environment-scoped, time-bounded where feasible, and regularly recertified. Service
identities MUST be distinct and attributable. Break-glass access MUST require explicit
activation, enhanced monitoring, a reason, expiry, and independent post-event review.

**Rationale**: Independent checks and narrow authority limit misuse, error propagation, and
unreviewed concentration of power.

### IV. Bounded and Reversible Automated Remediation

TrustCircleAI MUST NOT perform destructive automatic remediation unless an approved,
versioned policy explicitly permits it and defines preconditions, authorized resources,
blast-radius limits, rate and time limits, rollback, stop conditions, evidence retention,
and accountable ownership. The platform MUST validate those bounds immediately before
execution and retain the original state plus the remediation plan. If rollback cannot be
demonstrated or evidence cannot be retained, automation MUST stop after creating a
remediation proposal or issue for human action. Kill switches and safe cancellation MUST
exist for every automated controller with destructive capability.

**Rationale**: Remediation must reduce risk without creating an unbounded or irrecoverable
second incident.

### V. Versioned and Continuously Assured Controls

Every control MUST have a stable identifier, version, owner, objective, scope, logic,
inputs, outputs, dependencies, exceptions, failure behavior, evidence contract, tests,
monitoring signals, and obligation mappings. Control definitions and changes MUST be
reviewable and reproducible. A control MUST pass unit, contract, integration, negative-path,
and regression tests appropriate to its risk before activation. Active controls MUST be
continuously monitored for coverage, execution health, effectiveness, drift, stale mappings,
and unsupported dependencies. Failed or degraded controls MUST open or update a traceable
issue and expose their resulting assurance gap.

**Rationale**: A named control is not assurance unless its design, operation, evidence, and
continued effectiveness can be demonstrated.

### VI. Evidence Preservation and Repair Integrity

Original evidence and corrupted, malformed, partial, or otherwise repairable work items
MUST be preserved before transformation or repair. Repair MUST create a new derived item
linked to the original through provenance, integrity metadata, actor, reason, timestamp,
method, and outcome. Original content MUST NOT be silently overwritten, normalized, or
discarded. Redaction or access restriction MAY protect sensitive material, but the
authorized original MUST remain retained under policy with access events recorded.

**Rationale**: Preserving source material and chain of custody protects audit validity,
supports investigation, and prevents a repair from rewriting history.

### VII. Observable, Owned, and Fail-Visible Operations

Every workflow and controller MUST expose its identity, version, accountable owner, current
health, lifecycle status, enabled scope, last successful and attempted runs, evidence links,
open issues, failure details, retry state, and next permitted action. Failures, degraded
states, skipped work, exhausted retries, and stale data MUST be visible and alertable; they
MUST NOT be represented as healthy or complete. Loss of required telemetry or ownership
MUST cause safe degradation or suspension based on the approved policy. Within the declared
deployment boundary, governance-relevant assets, agents, controllers, workflows, controls,
policies, integrations, evidence stores, and unmanaged discoveries MUST appear in a
continuously reconciled inventory. Unknown, unreachable, or uncovered state MUST be shown
as an explicit visibility gap, never as compliant or healthy.

**Rationale**: Governance cannot rely on workflows whose operating state, ownership, or
failures are hidden.

### VIII. Resilient, Versioned Integration Contracts

Every API, event, file, adapter, and connector contract MUST be explicitly versioned and
validated at its boundary. Mutating operations MUST support idempotency, correlation, and
reconciliation. Integrations MUST define authentication, authorization, ordering,
deduplication, timeouts, bounded retries with backoff, terminal failure handling, replay or
recovery, compatibility guarantees, and evidence of the remote outcome. Uncertain or
partial outcomes MUST remain pending or failed until reconciled; they MUST NOT be reported
as success. Vendor-specific behavior MUST remain behind replaceable adapters and canonical
platform contracts.

**Rationale**: Ecosystem integration must remain safe under duplication, delay, outage,
partial failure, and vendor change.

### IX. Truthful Compliance and Assurance Claims

Compliance mappings and user interfaces MUST distinguish normative requirements, guidance,
drafts or work items, organizational policies, contractual duties, and external
certification criteria. They MUST separately identify applicability, obligation owner,
control design, implementation, operating effectiveness, evidence sufficiency, assessment
status, and external certification status. A mapping or internal readiness assessment MUST
NOT be presented as legal compliance, conformity, accreditation, or certification.
External certification MUST be recorded only with its issuer, scope, validity period, and
verifiable evidence.

**Rationale**: Precise claims prevent misleading assurance and keep responsibility with the
organization or accredited external party that actually bears it.

### X. Compatible Evolution and Continuous Improvement

Platform evolution MUST prefer backward-compatible contracts, explicit extension points,
portable data, documented deprecation windows, and tested migrations. A breaking change
MUST have an approved impact assessment, version boundary, migration and rollback plan,
consumer notice, and retained compatibility evidence. Incidents, audit findings, control
failures, user feedback, regulatory change, and standards revisions MUST feed prioritized
improvement work. Improvements MUST preserve vendor neutrality and MUST NOT bypass the
other principles of this constitution.

**Rationale**: Governance infrastructure must evolve without stranding evidence,
integrations, obligations, or users.

## Control and Assurance Baseline

- Every governed asset, control, policy, workflow, issue, evidence item, integration, and
  standards mapping MUST have a stable identity, lifecycle state, owner, version, and
  change history.
- Every deployment MUST declare its inventory boundary and continuously reconcile observed
  governance-relevant state against managed state. Discovered, unmanaged, unreachable,
  stale, and excluded items MUST remain visible with ownership and coverage status.
- Authorized operators MUST be able to inspect, approve, deny, stop, suspend, retry,
  reconcile, and escalate governed workflows within their assigned roles. Operator control
  MUST pass through the same policy, separation-of-duties, audit, evidence, and safety
  requirements as automated control.
- Consequence and risk classification MUST determine required human authority, separation
  of duties, test depth, monitoring, retention, and release gates.
- Control and policy lifecycles MUST include proposed, tested, approved, active, suspended,
  superseded, and retired states. Only authorized transitions MAY activate or weaken a
  control.
- Exceptions MUST identify the requirement affected, risk acceptance authority, rationale,
  scope, compensating controls, start and expiry times, review cadence, and closure
  evidence. Exceptions MUST expire closed and MUST NOT silently renew.
- Issues MUST retain source finding, severity, affected scope, owner, target date, status,
  evidence, remediation history, verification result, and accepted residual risk.
- Evidence contracts MUST define provenance, integrity protection, access, retention,
  classification, export, and disposition. Destruction MUST follow an approved retention
  policy and produce a disposition record.
- The platform MUST support tenant and organizational boundary enforcement without making
  vendor-specific services the system of record for canonical governance state.

## Standards Registry and Compliance Truth

TrustCircleAI MUST maintain a versioned standards registry. Each registry entry MUST record
the identifier, exact title, publisher, edition or publication date, lifecycle status,
source URI, retrieval date, applicability, obligation type and owner, supersession
relationships, mapping version, mapping owner, and next review date. Registry history MUST
be preserved so an audit can reconstruct which publication and mapping governed an action.

The initial registry baseline MUST include:

- [ISO/IEC 42001:2023](https://www.iso.org/standard/42001): the published requirements
  baseline for establishing, implementing, maintaining, and continually improving an AI
  management system. TrustCircleAI controls and evidence MAY support an organization's
  conformity program, but the platform MUST NOT claim certification on that basis.
- [ISO/IEC 42005:2025](https://www.iso.org/standard/42005): published guidance for AI
  system impact assessment. Impact assessment records MUST be versioned and revisited when
  intended use, affected people, context, data, model, control posture, or foreseeable
  impact materially changes.
- [ISO/IEC 42006:2025](https://www.iso.org/standard/42006): published requirements for
  bodies providing audit and certification of AI management systems. TrustCircleAI MUST
  support audit-ready evidence packages, scope boundaries, traceability, competence and
  independence records, finding workflows, and reproducible exports suitable for
  assessment. It MUST identify these as audit-readiness capabilities and MUST NOT imply
  that an organization or the platform is a certification body or is externally certified.

Future ISO/IEC 4200x publications, amendments, corrigenda, drafts, and work items MUST be
added as new registry versions rather than silently changing existing entries. Draft or
guidance material MUST remain labeled as such and MUST NOT become a mandatory control
source unless an authorized organizational policy explicitly adopts it. Mappings MUST be
many-to-many, evidence-backed, reviewable, and able to distinguish shared platform
capabilities from responsibilities retained by each organization or external assessor.

## Delivery and Operational Gates

- Every feature specification MUST identify deployment and inventory boundaries,
  consequential actions, actors and authorities, authorized operator controls, audit
  events, evidence handling, control impact, failure behavior, integrations, standards
  mappings, compatibility obligations, and measurable assurance outcomes. A category MAY
  be marked not applicable only with an explicit rationale.
- Every implementation plan MUST pass a Constitution Check before research and again after
  design. The check MUST name owners, approval boundaries, separation-of-duties controls,
  tests, monitoring, rollback, evidence, integration contracts, mappings, and migrations.
- Every task set MUST include the constitution-mandated tests and operational work needed
  for the feature. Tests for approval gates, destructive remediation, audit integrity,
  evidence preservation, access control, control behavior, integration failure, and
  migration MUST NOT be treated as optional when those concerns apply.
- A change affecting consequential authority, destructive remediation, audit or evidence
  integrity, access boundaries, compliance claims, or externally consumed contracts MUST
  receive independent review from the accountable control or domain owner.
- Release MUST be blocked when required approval, tests, evidence, ownership, monitoring,
  rollback, reconciliation, migration, or standards mapping is absent or failing.
- Production incidents MUST preserve original evidence before containment or repair.
  Recovery MUST produce a traceable incident record, impact assessment, corrective action,
  verification, and control-improvement decision.

## Governance

This constitution supersedes conflicting project practices, feature documents, plans,
tasks, and local conventions. The designated TrustCircleAI governance authority owns its
interpretation and enforcement. No exception may waive a Core Principle; a time-bounded
implementation deviation is valid only when the constitution permits it and the exception
meets the Control and Assurance Baseline.

Amendments MUST be proposed through a reviewed change containing the rationale, affected
principles and artifacts, risk and compatibility impact, migration needs, and Sync Impact
Report. Approval MUST include the governance authority and independent review appropriate
to the affected security, compliance, operational, and human-oversight domains.

Constitution versions follow semantic versioning:

- **MAJOR**: removes or incompatibly redefines a principle or governance obligation.
- **MINOR**: adds a principle or materially expands mandatory governance.
- **PATCH**: clarifies wording without changing obligations.

Every feature review and release review MUST verify constitution compliance and retain the
result as evidence. Active controls and mappings MUST be reviewed on their risk-based
cadence; the constitution and standards registry MUST be reviewed at least annually and
whenever a material incident, law, obligation, certification criterion, or relevant
standard changes. Unresolved violations MUST block release or operation within the affected
scope.

**Version**: 1.0.0 | **Ratified**: 2026-07-31 | **Last Amended**: 2026-07-31
