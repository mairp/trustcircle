# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`

**Created**: [DATE]

**Status**: Draft

**Input**: User description: "$ARGUMENTS"

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently - e.g., "Can be fully tested by [specific action] and delivers [specific value]"]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases.
-->

- What happens when [boundary condition]?
- How does system handle [error scenario]?
- What happens when required human authority is unavailable, denied, or revoked?
- How does the system stop when automation reaches a policy, scope, rate, or time bound?
- How are original evidence and corrupted work items preserved when repair fails partway?
- How are duplicate, delayed, out-of-order, partial, or permanently failed integrations reconciled?
- What happens when a control, mapping, owner, dependency, or telemetry source becomes stale or unavailable?
- How are unmanaged, unreachable, newly discovered, or deliberately excluded machine components represented?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: System MUST [specific capability, e.g., "allow users to create accounts"]
- **FR-002**: System MUST [specific capability, e.g., "validate email addresses"]
- **FR-003**: Users MUST be able to [key interaction, e.g., "reset their password"]
- **FR-004**: System MUST [data requirement, e.g., "persist user preferences"]
- **FR-005**: System MUST [behavior, e.g., "log all security events"]

*Example of marking unclear requirements:*

- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]
- **FR-007**: System MUST retain user data for [NEEDS CLARIFICATION: retention period not specified]

### Governance & Assurance Requirements *(mandatory)*

<!--
  ACTION REQUIRED: Replace each placeholder with concrete, testable requirements.
  If a category cannot apply to this feature, write "Not applicable — <specific rationale>".
  Empty categories or unexplained omissions fail the Constitution Check.
-->

- **GAR-001 — Human Authority & Scope**: [Declare the existing implementation and inventory
  boundary; identify consequential actions, accountable human authorities, authorized
  operator controls, decision context, escalation, and the exact bounds of any automation.]
- **GAR-002 — Accountability**: [Define attributable, reasoned, time-stamped audit records
  for every approval, denial, exception, and automated action, including policy/control versions.]
- **GAR-003 — Duties & Privilege**: [Define request, review, approval, execution, evidence,
  and assurance roles; identify conflicts and least-privilege constraints.]
- **GAR-004 — Safe Remediation**: [Define approved policy, preconditions, blast-radius and
  rate limits, cancellation, rollback, original-state preservation, and retained evidence.]
- **GAR-005 — Control Assurance**: [Identify control IDs, versions, owners, tests,
  monitoring, failure behavior, issues, exceptions, and obligation mappings.]
- **GAR-006 — Evidence Integrity**: [Define original and derived evidence, provenance,
  integrity, retention, access, repair, export, and disposition requirements.]
- **GAR-007 — Operational Visibility**: [Define reconciled inventory coverage, unmanaged
  and unreachable gaps, workflow/controller health, status, ownership, last runs, evidence,
  open issues, failures, retries, operator controls, and safe degraded behavior.]
- **GAR-008 — Integration Safety**: [Define contract versions, boundary validation,
  idempotency, correlation, reconciliation, retries, terminal failures, replay, and adapters.]
- **GAR-009 — Compliance Truth**: [Identify registry versions and distinguish requirements,
  guidance, drafts, organizational duties, internal readiness, and external certification.]
- **GAR-010 — Compatible Evolution**: [Define compatibility guarantees, extension points,
  deprecation, migration, rollback, portability, and consumer notification.]

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents, key attributes without implementation]
- **[Entity 2]**: [What it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: [Measurable metric, e.g., "Users can complete account creation in under 2 minutes"]
- **SC-002**: [Measurable metric, e.g., "System handles 1000 concurrent users without degradation"]
- **SC-003**: [User satisfaction metric, e.g., "90% of users successfully complete primary task on first attempt"]
- **SC-004**: [Business metric, e.g., "Reduce support tickets related to [X] by 50%"]
- **SC-005**: [Measurable governance outcome, e.g., "100% of consequential actions have an attributable authority decision and complete audit record"]
- **SC-006**: [Measurable resilience outcome, e.g., "All tested duplicate and partial integration outcomes reconcile without duplicate mutation or false success"]

## Assumptions

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right assumptions based on reasonable defaults
  chosen when the feature description did not specify certain details.
-->

- [Assumption about target users, e.g., "Users have stable internet connectivity"]
- [Assumption about scope boundaries, e.g., "Mobile support is out of scope for v1"]
- [Assumption about data/environment, e.g., "Existing authentication system will be reused"]
- [Dependency on existing system/service, e.g., "Requires access to the existing user profile API"]
