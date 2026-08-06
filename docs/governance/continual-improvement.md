# Continual-Improvement Backlog — Governance Control Plane

Phase 10 · T305 · GAR-010. This is the **versioned continual-improvement backlog**: the single
durable place where the six improvement input streams the standard requires — **incidents**, **audit
findings**, **control failures**, **standards changes**, **user feedback**, and **operational
metrics** — are fed in, triaged, owned, prioritized, and tracked to closure. It is how the platform
evolves _safely_ after the first release: nothing that should change the system is left in someone's
head or an email thread.

It is paired with the known-gaps register (`docs/governance/known-gaps.md`): a gap/risk/exception
that needs work becomes a backlog item here; a backlog item that is _accepted rather than fixed_
becomes an entry there.

## How this backlog is versioned

- This document is under version control; **every change is a reviewed commit**, so the backlog has
  a full, attributable history (who added/changed/closed an item, and when).
- Each item carries a stable **ID** (`CI-nnn`), a **version/first-seen release**, a **status**, an
  **owner**, and a **priority**, so an item can be traced across releases.
- The backlog is reviewed at **each release** via the release-review checklist
  (`specs/001-governance-control-plane/checklists/release-review.md`) and on the standing cadence in
  §5. Closed items are retained (not deleted) for audit.

## Intake — the six input streams

Every item is tagged with the stream(s) it came from, so no source of improvement is ignored:

| Stream                | Source                                                  | Where it is captured / detected                                                                                 |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Incidents**         | Production/operational incidents                        | Incident reviews; the fail-visible readiness picture and alert routing (`alert_record`).                        |
| **Audit findings**    | Internal & external audit                               | `internal_audit` / `compliance_finding`; audit-readiness evidence packages (`tests/fixtures/audit-readiness/`). |
| **Control failures**  | A control that did not hold                             | `control_evaluation` failures; the performance suite's red-control signals; SoD/authz rejections.               |
| **Standards changes** | ISO/IEC 42001/42005/42006 and other framework revisions | Compliance obligation tracking (`compliance_obligation`, `clause_version`).                                     |
| **User feedback**     | Officers/operators/auditors                             | Feedback intake; accessibility findings.                                                                        |
| **Metrics**           | Operational & SLA metrics                               | NFR objective measurements; query budgets & explain-plan baselines (`db/migrations/0090_query_tuning.sql`).     |

## Triage & prioritization

Each new item is triaged within one review cycle: assigned an **owner**, a **priority**
(`P1` critical / `P2` high / `P3` normal / `P4` low), and a **status**
(`intake` → `triaged` → `in-progress` → `done`, or `accepted` when it becomes an accepted gap/risk in
`known-gaps.md`, or `wont-do` with a recorded reason). A P1 (active harm, control failure, or
security exception) is escalated immediately and may trigger the emergency path in
`compatibility-policy.md` §7.

---

## Backlog (seeded for the first release)

| ID     | Stream(s)              | Item                                                                                              | Priority | Owner                    | Status  | First seen | Next review  |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------- | -------- | ------------------------ | ------- | ---------- | ------------ |
| CI-001 | Metrics                | Wire the explain-plan regression gate (0090 baselines) into CI against live PostgreSQL.           | P2       | Platform/DB lead         | triaged | v1.0       | 2026-10-15   |
| CI-002 | Metrics, Incidents     | Run the full-fidelity browser E2E + live-stack scenarios in the infra-enabled CI pipeline.        | P2       | QA/Release lead          | triaged | v1.0       | Each release |
| CI-003 | Incidents              | Execute a live multi-region DR failover drill against the 4-hour recovery objective (NFR-008).    | P2       | SRE lead                 | triaged | v1.0       | 2026-10-01   |
| CI-004 | User feedback          | Complete a full second-locale translation catalog (currently partial `ar`) — KG-1.                | P3       | Web/UX lead              | intake  | v1.0       | 2026-11-01   |
| CI-005 | Standards changes      | Track ISO/IEC 42001/42005/42006 revision cycle; refresh obligation clauses and evidence packages. | P3       | Governance product owner | triaged | v1.0       | 2026-11-01   |
| CI-006 | Audit findings         | Establish external-audit findings intake and map each to a control + owner + due date.            | P3       | Compliance lead          | triaged | v1.0       | 2026-11-01   |
| CI-007 | Control failures       | Add trend alerting on repeated `control_evaluation` failures so a recurring miss escalates.       | P3       | Governance product owner | intake  | v1.0       | 2026-10-15   |
| CI-008 | Metrics, User feedback | Add p99-latency dashboards per query budget so a budget breach is visible to operators.           | P4       | Platform lead            | intake  | v1.0       | 2026-11-01   |

_(New items are appended with the next `CI-nnn` id. Closed items keep their row with status `done`
and a closing note, retained for audit.)_

---

## Closed / historical

| ID  | Item                                   | Closed in | Outcome |
| --- | -------------------------------------- | --------- | ------- |
| —   | _none yet — this is the first release_ | —         | —       |

---

## §5 — Review cadence & ownership

- **Per-release review** (mandatory): re-triage every open item; re-stamp review dates; move
  accepted items to `known-gaps.md`; append new items from the release's incidents/findings/metrics.
- **Monthly standing review**: P1/P2 progress check.
- **On-event**: an incident, a failed control, an audit finding, or a standards change files an item
  here at the time it occurs — intake is continuous, not only at release boundaries.
- Every item has a named owner. An overdue P1/P2 with no progress is itself surfaced as a control
  failure (a new CI item) so the backlog cannot silently stall.
