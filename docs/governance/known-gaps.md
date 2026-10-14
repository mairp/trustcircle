# Known Gaps, Residual Risks & Exceptions Register — Governance Control Plane

Phase 10 · T304 · GAR-010. This register publishes, for the first release, the **known gaps**, the
**accepted residual risks**, the **active exceptions**, the **deferred sources**, the **unsupported
capabilities**, and — for every one — its **owner** and **next review date**. It exists so the
platform's limits are _visible and owned_, never silent: an operator, auditor, or executive can read
exactly what the system does not do, why that is accepted, who owns it, and when it is next revisited.

This register is fed by, and feeds, the continual-improvement backlog
(`docs/governance/continual-improvement.md`). It aligns with the threat model's residual-risk
register (`docs/security/threat-model.md` §6), the compatibility policy's exception path
(`docs/architecture/compatibility-policy.md` §7), and the truthfully-recorded deferred validation
tiers in the release/validation manifests.

**Review cadence:** every entry is reviewed at each release via the release-review checklist
(`docs/governance/release-review.md`) and no later than its stated
review date. Dates are illustrative first-release targets and are re-stamped at each review.

---

## 1. Known gaps (functional limits accepted for this release)

| ID   | Gap                                                                                                                                                                                                                                           | Impact | Owner            | Compensating control / plan                                                                                                                                            | Review date  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| KG-1 | **Second locale is partial.** `apps/web/src/i18n/catalog.ts` ships full `en-US` + a partial `ar` (direction/fallback exerciser), not a complete second language.                                                                              | Low    | Web/UX lead      | Fallback to base locale is visible-not-blank (`t()`); `missingKeys()` drives translation QA.                                                                           | 2026-11-01   |
| KG-2 | **Explain-plan regression thresholds are baselined, not yet wired into CI on live PG.** Baselines exist in `db/migrations/0090_query_tuning.sql`; the CI gate that re-runs EXPLAIN against live PostgreSQL is deferred to the infra pipeline. | Low    | Platform/DB lead | Budgets + baselines are recorded and unit-asserted; live-PG gate runs in CI where infra exists.                                                                        | 2026-10-15   |
| KG-3 | **Full-fidelity browser E2E and live-stack (Postgres/NATS/OPA/MinIO) scenarios do not run on an infra-less/browser-less host.**                                                                                                               | Low    | QA/Release lead  | Every guide scenario has a host-runnable sibling that ran and passed; the full-fidelity tier is recorded `not-run-here` / deferred-to-CI, **never** counted as passed. | Each release |
| KG-4 | **DR failover is validated by runbook + recovery suite, not by a live multi-region drill on this host.**                                                                                                                                      | Medium | SRE lead         | Recovery suite + DR runbook (T289); NFR-008 4-hour recovery objective; live drill scheduled in the infra environment.                                                  | 2026-10-01   |

## 2. Accepted residual risks (mirrors threat model §6, owned here)

| ID   | Residual risk                                | Accepted level    | Owner                    | Compensating control                                          | Review date |
| ---- | -------------------------------------------- | ----------------- | ------------------------ | ------------------------------------------------------------- | ----------- |
| RR-1 | Signing-key compromise (A4)                  | Low (accepted)    | CISO                     | KMS custody, rotation, external anchoring of checkpoint roots | 2026-11-01  |
| RR-2 | IdP / workload-identity compromise           | Low (accepted)    | CISO                     | Short-lived tokens, per-tenant scope, anomaly alerting        | 2026-11-01  |
| RR-3 | Novel cross-tenant side channel              | Low (accepted)    | Security lead            | Defense-in-depth, isolation-matrix expansion                  | 2026-10-15  |
| RR-4 | Sustained multi-region outage                | Medium (accepted) | SRE lead                 | DR runbook (T289), 4-hour recovery objective (NFR-008)        | 2026-10-01  |
| RR-5 | Policy misconfiguration → elevation of priv. | Low (accepted)    | Governance product owner | Policy tests, change control, SoD                             | 2026-11-01  |

## 3. Active exceptions (waivers, with expiry)

An exception is a **time-boxed, owned** waiver of a control or policy window. None are active at
first release. The table's shape is the register every future exception is recorded in; the
emergency-security-exception path is defined in `compatibility-policy.md` §7 and requires joint
owner + security-lead approval and an audit-ledger entry.

| ID  | Exception (what is waived)     | Trigger / reason | Approvers (owner + security) | Granted | Expires | Audit ledger ref |
| --- | ------------------------------ | ---------------- | ---------------------------- | ------- | ------- | ---------------- |
| —   | _none active at first release_ | —                | —                            | —       | —       | —                |

## 4. Deferred sources (discovered but not yet governed)

The source catalog is **open-ended**: a discovered source that is not yet governed is surfaced as a
**coverage gap** (`coverage_gap` table, reasons `unmanaged`/`unsupported`/`inaccessible`/`sensitive`/
`unowned`), never silently dropped. Deferred source _classes_ accepted for this release:

| ID   | Deferred source class                                                                  | Reason         | Owner             | Surfaced as                                  | Review date |
| ---- | -------------------------------------------------------------------------------------- | -------------- | ----------------- | -------------------------------------------- | ----------- |
| DS-1 | Sources requiring an adapter not yet built                                             | `unsupported`  | Integrations lead | `coverage_gap` (gap_class `governed_source`) | 2026-10-15  |
| DS-2 | Sources behind networks the discovery agent cannot reach                               | `inaccessible` | Integrations lead | `coverage_gap`                               | 2026-10-15  |
| DS-3 | Sources whose content is too sensitive to ingest under current least-disclosure policy | `sensitive`    | Security lead     | `coverage_gap` + threat-model A6             | 2026-11-01  |

**Invariant:** a deferred source is always a _visible_ gap with a required owner action; it can never
appear healthy or disappear (enforced by the coverage-gap constraints and the fail-visible picture).

## 5. Unsupported capabilities (explicitly out of scope for this release)

| ID   | Unsupported capability                                    | Owner                    | Note                                                                                   | Review date     |
| ---- | --------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- | --------------- |
| UC-1 | Automated _remediation execution_ of third-party controls | Governance product owner | The plane records/decides/evidences; execution stays with the source system by design. | 2026-11-01      |
| UC-2 | More than two live contract majors simultaneously         | Platform lead            | Policy caps at N and N−1 (`compatibility-policy.md` §3).                               | Each release    |
| UC-3 | In-process vendor SDK adapters                            | Security lead            | Rejected by ADR 0001 D2 (credentials/vendor code must not enter the core).             | Static (ADR)    |
| UC-4 | OFFSET-based pagination on list endpoints                 | Platform/DB lead         | Forbidden by `query_pagination_policy` (keyset only); cost-unbounded.                  | Static (policy) |

---

## 6. Ownership & escalation

Each entry names an accountable owner. An owner who cannot hold a gap/risk at its accepted level
before the review date must either (a) drive it to closure via the continual-improvement backlog, or
(b) file a dated exception in §3 with the required joint approval. An unowned or overdue entry is
itself a control failure and is fed into `continual-improvement.md`.
