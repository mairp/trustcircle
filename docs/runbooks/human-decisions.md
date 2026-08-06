# Runbook — Human Decisions: the accessible, policy-bound decision queue, delegation, expiry, emergency intervention, and federated cross-tenant approval

> **Audience.** The authorized approver, the governance/compliance officer, and the platform steward
> who **operate the human-decision surface** — the queue where consequential governance actions are
> approved, denied, delegated, escalated, or expired, with attributable reasons and enforced
> separation of duties.
>
> **What this runbook is.** The operating procedure for the human-decision authority surface. It
> describes what a human must do, what the platform enforces automatically, and — critically — the
> invariants that keep every decision **accountable**: no action without authority, no outcome
> without an attributable reason, no self-approval, no unbounded delegation, no silent expiry, no
> emergency stop that quietly becomes an approval, and no cross-tenant execution until every gate
> passes with **no evidence leaked** between tenants.
>
> **Priority.** This surface is **User Story 2 (P1)** of the governance control plane — "Make and
> Govern Human Decisions."

This runbook documents the behavior implemented and verified in:

- `apps/api/src/persistence/decision-repository.ts` — the decision-package store (T103): pending
  packages, requirements, reasons, delegations, and the append-only audit trail.
- `apps/api/src/policy/decision-input.ts` — submit-time revalidation (T106): authority, scope,
  separation-of-duties, delegation validity, evidence currency, and package version (FR-012).
- `apps/api/src/routes/decisions.ts` / `apps/api/src/routes/delegations.ts` — the decision-action and
  delegation endpoints (T104, T105).
- `apps/api/src/projections/decision-projector.ts` — the queue / joint / emergency read projections (T107).
- `apps/api/src/routes/decision-dashboard.ts` — the officer's dashboard route (T108).
- `apps/web/src/features/decisions/DecisionInbox.tsx` — the accessible, prioritized decision queue (T109–T114).
- `apps/web/src/features/decisions/JointDecisionStatus.tsx` — the federated cross-tenant approval status surface.
- `apps/web/src/features/operations/EmergencyIntervention.tsx` — the emergency break-glass / post-event-review surface.
- `apps/api/src/workers/expiry-worker.ts` — the expiry escalation worker (T116): expiry never silently closes.
- `packages/domain/src/decisions.ts` — the decision factories + the `decisionIsExpired` /
  `isCentralGuardrail` oracles that the queue and joint surfaces read.

---

## 0. Acceptance criteria this runbook satisfies

This runbook is the human-readable authority for the User-Story-2 acceptance criteria. Each criterion
below is _also_ discharged by a deterministic, independently-observable acceptance runner
(`tests/e2e/scenarios/human-decisions.ts`, task T118), re-asserted in a real browser against the
shipped renderers by `tests/e2e/human-decisions.spec.ts` (task T093), and signed into an evidence
manifest under `tests/e2e/scenarios/_evidence/gate4/` (task T119). The runbook documents the behavior;
the runner + manifest prove the behavior holds.

| Criterion       | Subject                                                                                                                                                                               | Enforced by                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| FR-010          | Authorized approvers can approve / deny / delegate / request-changes / escalate / expire a pending task **when the transition is valid** for its current state.                       | §1 + §2 + `DecisionInbox.tsx` `allowedActions`; runner `runHumanDecisionScenario` → `FR-010`                     |
| FR-011 / SC-003 | Every human decision **requires a non-empty, attributable reason** (code + text) appropriate to the action.                                                                           | §3 + `packages/domain/src/decisions.ts` `makeReason`; runner → `SC-003`                                          |
| FR-012 / SC-005 | Authority, scope, **separation-of-duties**, delegation validity, evidence currency, and item version are **revalidated on submit** — a self-conflicted action is blocked.             | §4 + `apps/api/src/policy/decision-input.ts`; runner → `FR-012`                                                  |
| FR-013          | Delegation identifies delegator, recipient, scope, authority source, reason, start, expiry, revocation; it **creates no circular or expanded authority** and is bounded.              | §5 + `apps/api/src/routes/delegations.ts`; runner → `FR-013`                                                     |
| FR-014 / SC-020 | Every decision event creates an **attributable, reasoned, time-stamped audit record**; a past-deadline decision is **expired + escalated, never silently closed**.                    | §3 + §6 + `apps/api/src/workers/expiry-worker.ts`; runner → `FR-014 / SC-020`                                    |
| FR-015          | A **material change** to the decision package **invalidates any unsubmitted decision** and forces review of the current package.                                                      | §4 + `apps/api/src/policy/decision-input.ts` version check; runner → `FR-012` (version) + §4                     |
| FR-015 / SC-004 | Emergency **break-glass can stop** an operation but **never confers decision authority**, and its **post-event review stays open** until completed.                                   | §7 + `apps/web/src/features/operations/EmergencyIntervention.tsx`; runner → `FR-015 / SC-004`                    |
| FR-043          | Central policy defines **non-waivable guardrails**; each tenant **retains authority** over effects in its own boundary. No tenant can waive a central guardrail.                      | §8 + `JointDecisionStatus.tsx` `centralGuardrails`; runner `runFederatedJointApprovalScenario` → `FR-043/FR-044` |
| FR-044 / SC-020 | A multi-tenant consequential action **MUST NOT execute** until **every affected tenant** supplies a **current** scoped approval **and** an **independent central reviewer** approves. | §8 + `JointDecisionStatus.tsx` `executionBlocked`; runner → `FR-043`, `FR-044`                                   |
| FR-045          | The central reviewer is a **different principal** from the requester, operator, control owner, and every tenant approver; each tenant approval stays **separately attributable**.     | §8 + `JointDecisionStatus.tsx` `centralReview`; runner → `FR-045`                                                |
| AC6 / SC-005    | Federated approval **discloses no tenant's evidence to another tenant** — status/reviewer/time only.                                                                                  | §8 + `JointDecisionStatus.tsx` `tenantApprovals[*].evidenceDisclosed`; runner → `FR-043 / AC6 / SC-005`          |

**The accountability rule (the least-authority principle).** No decision may take effect without a
principal who **currently holds** the authority for it, an **attributable reason**, and a passing
**separation-of-duties** check. Authority is never inferred from an emergency stop, never expanded by
delegation, and never survives a material change to the package it was granted against.

---

## 1. The decision queue (FR-010)

**When** an authorized human opens the decision queue, **then** every pending decision renders as a
row ordered by **priority** (impact × risk × time-to-expiry), highest first, carrying the full context
needed to decide.

`DecisionInbox.tsx` renders one `inbox-row` per pending package. Each row carries, in **text** (never
color-only):

- **requested action** — approve / deny / delegate / request-changes / escalate / expire.
- **risk tier** and **impact** — the consequence class of acting.
- **expiry** and **time posture** — `ample` / `expiring_soon` / `expired`; expiring/expired rows carry
  a textual `row-time-warning` with a `data-severity`, so the warning survives with color removed.
- **allowed actions** (`row-allowed-actions[data-actions]`) — the subset of FR-010 transitions that are
  **valid for this package's current state and this human's authority**. An action absent here is one
  the human may not take right now; it is withheld with a stated reason, never silently greyed.
- **actionability** (`data-actionable`) and **escalation** (`data-escalated`) flags.

**Invariant — complete and honest ordering.** The queue lists every pending decision; a filter never
drops one. Priority ordering is non-increasing (`rows[i-1].priority >= rows[i].priority`). The proof is
the re-readable projection, not a mutation echo.

---

## 2. Taking a decision action (FR-010)

**When** a human acts on a row, **then** the action is accepted **only if the transition is valid for
the package's current state** (`POST /decisions/:id/actions` in `apps/api/src/routes/decisions.ts`).
`allowedActions` on the row is the authoritative list — the API rejects any action outside it with a
stated reason and **no state change** (SC-005). The six FR-010 transitions are: **approve, deny,
delegate, request-changes, escalate, expire**.

---

## 3. Mandatory attributable reasons & the audit record (FR-011, FR-014, SC-003)

**When** any decision event occurs — approval, denial, delegation, change request, escalation, expiry,
exception, or automated action — **then** it MUST carry a **non-empty reason** and MUST append an
**attributable, reasoned, time-stamped audit record** linked to the applicable evidence, policy,
control, item, and version.

- **Reason.** `makeReason(code, text)` in `packages/domain/src/decisions.ts` **rejects an empty or
  blank reason** — an unattributed outcome cannot be constructed. The reason travels on the audit
  record and (for outcomes that alter state) is required by the submit path.
- **Audit.** `decision-repository.ts` appends the record; it names the acting principal, the reason,
  the timestamp, and the linked evidence/policy/control/item/version. The record is **append-only** —
  history is never rewritten.

**Invariant — no silent outcome.** Every state change has a named principal and a reason. This is the
non-repudiation property `SC-004` asserts; the signed manifests in §9 reproduce byte-identical digests
over the same fixture, which is that property made mechanical.

---

## 4. Submit-time revalidation & separation of duties (FR-012, FR-015, SC-005)

**When** a decision is **submitted**, **then** `apps/api/src/policy/decision-input.ts` **revalidates**
all of the following against the **current** package — never against what was true when the queue was
first opened:

1. **Authority** — the principal currently holds the authority for this action.
2. **Scope** — the action is within the granted scope.
3. **Separation of duties** — the principal is **not conflicted** (e.g. the requester of an access
   grant may not approve their own grant). A `separation-of-duties` conflict **blocks the action**,
   names the conflict in text (`row-conflicts-cell`), and empties `allowedActions`.
4. **Delegation validity** — if acting under a delegation, the delegation is active and in-window (§5).
5. **Evidence currency** — the evidence the decision relies on is current, not stale.
6. **Package version** — the submitted decision targets the **current** package version.

**FR-015 — material change invalidates.** If the decision package has **materially changed** since the
human last reviewed it, any **unsubmitted** decision is **invalidated** and the human must review the
current package before acting. The version check (item 6) is how this is enforced: a stale target
version is rejected with **no state change**.

**Invariant — revalidate on submit, not on open.** Authority seen at open time is advisory; the
authority that governs the outcome is the one revalidated at submit.

---

## 5. Bounded delegation, revocation, and expiry (FR-013)

**When** a human delegates authority, **then** the delegation MUST identify **delegator, recipient,
scope, authority source, reason, start, expiry, and revocation**, and it MUST NOT create **circular or
expanded** authority (`apps/api/src/routes/delegations.ts`).

- **Distinct recipient.** The recipient is a different principal from the delegator.
- **Bounded window.** A delegation is only effective while `validFrom <= now < expiresAt`. Outside the
  window its status is `expired` and it confers nothing. An unbounded grant is not representable.
- **No expansion.** The recipient's authority is a **subset** of the delegator's scope — never a
  superset — and the delegation chain cannot loop back (`parentDelegationId` cannot form a cycle).
- **Revocation.** A delegation may be revoked before expiry; revocation is itself an audited event (§3).
- **Lapse is an accountability effect.** When a delegation lapses, the decisions it covered do not
  silently close — they revert to requiring the original authority (or escalate, §6).

**Invariant — delegation narrows, never widens.** Authority delegated is authority the delegator held,
for a bounded time, to a distinct recipient, revocably.

---

## 6. Expiry never silently closes (FR-014, SC-020)

**When** a decision passes its deadline, **then** it is marked **expired** and **escalated** — it is
**never silently closed** and its live actions are **withdrawn**.

- The domain oracle `decisionIsExpired(pkg, now)` is the single source of truth for expiry; the queue
  row reads it (`data-time-posture="expired"`), sets `data-escalated="true"`, and empties
  `allowedActions` so no stale action can be taken.
- `apps/api/src/workers/expiry-worker.ts` performs the escalation out-of-band: it detects past-deadline
  packages, escalates them (an audited event, §3), and never closes them without a record.

**Invariant — an expired decision is loud.** The negative control: an **in-window** package is **not**
expired (`decisionIsExpired = false`) and keeps its actions — so the expired-and-escalated state is
scenario-specific, not a blanket flag.

---

## 7. Emergency intervention — break-glass stops, never approves (FR-015, SC-004)

**When** an operator invokes emergency break-glass, **then** it may **STOP** an operation but it
**NEVER confers decision authority**, and it **owes a post-event review** that stays **open** until
completed (`apps/web/src/features/operations/EmergencyIntervention.tsx`).

- **Stop-only.** The surface states in text (`no-decision-authority`) that break-glass will **never
  APPROVE / grant authority** (`data-confers-decision-authority="false"`). Its scope allows only the
  stop action; an approval taken "under break-glass" is not a representable state.
- **Owed review.** Each break-glass event carries a mandatory post-event review. While
  `reviewComplete=false` (and no reviewer assigned) the event is surfaced as a **blocking alert**
  (`open-reviews-alert`, `data-open-reviews="1"`). A completed review sets `reviewComplete=true` and
  names a reviewer — only then does the alert clear.

**Invariant — accountability outlives the emergency.** The emergency stop buys time; it does not buy
authority, and it does not discharge itself. The open review is the debt the operator still owes.

---

## 8. Federated cross-tenant joint approval (FR-043, FR-044, FR-045, AC6, SC-005, SC-020)

**When** a consequential action affects **more than one tenant**, **then** it **MUST NOT execute**
until **three gates** all pass, and it discloses **no tenant's evidence to another tenant**
(`apps/web/src/features/decisions/JointDecisionStatus.tsx`).

**Gate 1 — non-waivable central guardrails (FR-043).** Central governance policy defines guardrails
that **no tenant can waive**; each is a requirement with `tenantId === null` (`isCentralGuardrail`).
Every central guardrail must pass. Each tenant still retains authority over effects **within its own
boundary** — central guardrails and tenant authority are complementary, not competing.

**Gate 2 — every affected tenant's current approval (FR-044).** Every affected tenant must supply a
**current**, scoped approval. A **stale** approval does not count; revoking any tenant's approval
**re-blocks** the joint decision. `data-all-tenants-approved` is `false` until every affected tenant is
`approved AND current`.

**Gate 3 — independent central reviewer (FR-045).** A **distinct** central governance reviewer —
different from the requester, operator, control owner, and **every** tenant approver — must approve the
**complete** joint package (`central-review[data-distinct="true"]`). Until they do,
`data-approved="false"` and the `central-open` gate is shown. Each required tenant approval remains
**separately attributable** even when one principal holds authority in more than one tenant.

**No evidence leak (AC6 / SC-005).** Each tenant row (`tenant-approval-row`) discloses **status,
reviewer, and time only** — `data-evidence-disclosed="false"` on every row, with **no** `"true"`
anywhere. A tenant sees _that_ another tenant approved, never _the evidence_ they approved on. This is
pinned in the disclosed view model as the literal `false`, so a leak is **unrepresentable**.

**Invariant — execution is blocked until all three gates pass (SC-020).** `data-execution-blocked`
stays `true` while any gate is open. The negative control: were all guardrails passed, all tenants
approved-and-current, and a distinct central reviewer approved, `executionBlocked` would flip `false` —
so the block is a live conjunction of the three gates, not a constant.

---

## 9. Signed evidence manifests (T119)

The two User-Story-2 scenarios are signed into evidence manifests under
`tests/e2e/scenarios/_evidence/gate4/`:

- `scenario2-human-decision.manifest.json` — FR-010, FR-011, FR-012, FR-013, FR-014/SC-020, SC-003,
  FR-015/SC-004.
- `scenario3-federated-joint.manifest.json` — FR-043, FR-044, FR-045, FR-043/AC6/SC-005.

Each manifest is produced by `emit-manifests.mjs` (in the same directory), which runs the deterministic
acceptance runners (`tests/e2e/scenarios/human-decisions.ts`) and, for each criterion, records the
asserted **evidence**, the durable **read path** it was observed through (`observedVia`), and the
**negative control** whose flip would drive the oracle red. The full result is canonicalised
(sorted-key JSON) and hashed with sha256 into a top-level `manifestDigest`; because the runners use no
clock, no I/O, and no randomness, re-emission over the same fixture reproduces **byte-identical**
digests — the non-repudiation property SC-004 asserts.

**Regenerate / verify:**

```
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate4/emit-manifests.mjs          # (re)write
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate4/emit-manifests.mjs --check  # drift guard
```

The browser-driven witness (`tests/e2e/human-decisions.spec.ts`, project `human-decisions`) mounts the
shipped renderers via `page.setContent`, re-asserts the same DOM contracts, and scans each surface with
axe-core (WCAG 2.2 AA), so the logic oracle and the presentation oracle agree.
