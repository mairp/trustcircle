# Operations Runbook — Governance Control Plane

Phase 9 · T285 · GAR-010. This runbook is the on-call operator's authoritative procedure set for
the TrustCircleAI Governance Control Plane. Every section states the **signal**, the **decision**,
the **action steps**, and the **escalation owner**. PostgreSQL governance records and the
tamper-evident audit ledger are always authoritative; when a runbook and a dashboard disagree,
trust the ledger and open an incident.

> Scope: production operations. For disaster recovery (backup/restore, PITR, NATS topology,
> checkpoint replay) see `deploy/kubernetes/recovery/runbook.md` (T289). For the threat model and
> trust boundaries see `docs/security/threat-model.md` (T286).

---

## 0. Ownership & escalation map

| Domain                                | Primary owner    | Escalation (L2)           | Executive (L3)           |
| ------------------------------------- | ---------------- | ------------------------- | ------------------------ |
| Alert triage                          | On-call SRE      | SRE lead                  | VP Engineering           |
| Dead-letter queues                    | Platform on-call | Data platform lead        | VP Engineering           |
| Reconciliation backlog                | Governance ops   | Governance product owner  | Chief Governance Officer |
| Business continuity / leases          | On-call SRE      | SRE lead + Governance ops | Chief Governance Officer |
| **Audit freeze (integrity incident)** | Security on-call | CISO delegate             | **CISO**                 |
| Evidence gaps                         | Compliance ops   | Compliance lead           | Data Protection Officer  |

Every escalation MUST be recorded as a governed audit event (`ops.escalation.opened`) with the
accountable owner principal so the escalation itself is auditable.

---

## 1. Alert triage

**Signal.** A monitoring alert fires (availability, latency SLO burn, health-detection lag,
integrity-evaluation lag, queue depth, or a governance-specific alert such as `audit.chain.invalid`).

**Decision tree.**

1. Is the alert `audit.chain.invalid` or any integrity alert? → go straight to **§5 Audit freeze**.
   Integrity incidents are never "watch and wait".
2. Is availability below the NFR-001 budget (failure ratio > 0.1%)? → page L2, begin dependency
   isolation (§ dependency outage in the resilience suite `tests/resilience/chaos.test.ts`).
3. Is it a latency SLO burn only? → confirm against the performance budgets in
   `tests/performance/config.ts` (NFR_BUDGETS). Interactive p95 must stay < 3 s (NFR-007),
   decision durability p95 < 5 s (NFR-004).
4. Otherwise triage by domain owner in §0.

**Actions.**

- Acknowledge within 5 minutes. Record `ops.alert.acknowledged`.
- Capture the current freshness/coverage banner from the dashboard — dashboards explicitly expose
  freshness and partial coverage; a stale banner changes the interpretation of every downstream
  metric.
- If the alert is spurious (verified against the authoritative store), silence with a documented
  reason and a governed `ops.alert.suppressed` event. Never silence an integrity alert.

**Escalation owner:** On-call SRE → SRE lead.

---

## 2. Dead letters

**Signal.** A consumer's dead-letter subject depth rises above zero, or a `deadletter.arrived`
event is emitted.

**Why it matters.** Delivery is at-least-once; consumers are idempotent on `event_id` +
`aggregate_version`. A dead letter means a message failed _after_ ret/redelivery — a genuine
processing defect, not a transient blip.

**Actions.**

1. Inspect the dead-lettered envelope. Confirm `event_id`, `aggregate_type`, `aggregate_version`,
   `tenant_id`, and the failure reason.
2. Classify: (a) poison message (schema/contract violation), (b) downstream dependency failure,
   (c) code defect.
3. For (a): validate against the published contract (`packages/contracts`). If the producer
   emitted an incompatible-major envelope, the breaking-change guard should already have rejected
   it upstream — treat as a contract regression and open a change-control incident.
4. For (b): once the dependency recovers, **replay** the dead letter. Idempotent consumers make
   replay safe (no duplicate governance effect).
5. For (c): quarantine the subject, open a defect, and DO NOT replay until fixed.
6. Never delete a dead letter without recording `deadletter.dispositioned` with an accountable
   owner and reason.

**Escalation owner:** Platform on-call → Data platform lead.

---

## 3. Reconciliation

**Signal.** Reconciliation backlog exceeds threshold, a scheduled reconciliation run misses its
window (NFR-006: 10k work items within 2 minutes for 95% of runs), or duplicate/out-of-order
source updates are detected.

**Actions.**

1. Confirm the backlog size and age. Compare against NFR-006 budget.
2. Trigger an on-demand reconciliation sweep. Reconciliation is idempotent: duplicate and
   out-of-order source updates reconcile to a **single** governance action, and source history
   stays reconstructable (see the `reconciliation_replay` fault profile in
   `tests/performance/config.ts`).
3. If reconciliation cannot converge (a source is unreachable), mark the affected scope **visibly
   degraded** on the dashboard rather than reporting false freshness.
4. Verify no duplicate governance action was produced; if one was, that is an integrity concern —
   escalate to §5.

**Escalation owner:** Governance ops → Governance product owner.

---

## 4. Business continuity (controller health loss & leases)

**Signal.** A controller loses health mid-operation; a continuity lease is requested or is nearing
expiry.

**Rules.**

- A valid continuity lease MAY allow the current step to continue while evidence buffers.
- A lease MUST NOT exceed the **15-minute ceiling** (NFR-012). There is no override.
- If no valid lease applies, the controller MUST pause at a safe checkpoint and require
  reconciliation before resuming.

**Actions.**

1. Confirm the lease is within the 15-minute ceiling. If it is not, force a safe-checkpoint pause.
2. Ensure buffered evidence is durably captured before allowing continuation.
3. On resume, run reconciliation (§3) so the paused window is reconciled before normal operation.

**Escalation owner:** On-call SRE → SRE lead + Governance ops.

---

## 5. Audit freeze (integrity incident)

**Signal.** The audit ledger verifier (`packages/audit-ledger`) reports a broken chain
(`digest_mismatch`, dropped/reordered/duplicated record, or a checkpoint-range mismatch), or the
`audit-tamper` E2E gate's detect→incident→freeze logic fires in production.

**This is the highest-severity operational event.** The audit ledger is the accountability
substrate for every consequential/destructive action.

**Actions (fail-closed).**

1. **FREEZE.** While a critical audit incident is open in a tenant, refuse every consequential and
   destructive action in that tenant. Read-only actions and other tenants are unaffected (scoped
   freeze — see `tests/e2e/audit-tamper.spec.ts`).
2. Open a CRITICAL incident bound to the tenant, ledger, and offending sequence.
3. Preserve evidence: snapshot the affected ledger range and the last verified checkpoint. Do NOT
   attempt to "repair" the chain — a rewritten chain destroys the tamper evidence.
4. Independently re-verify from the last **signed** checkpoint (ed25519). A signed checkpoint over
   an honest range cannot equal a root over a tampered range.
5. Notify the CISO immediately.

**Escalation owner:** Security on-call → CISO delegate → **CISO**.

---

## 6. Evidence gaps

**Signal.** An evidence retention **gap** (no applicable approved retention policy → `retainUntil`
is null), a missing evidence blob, or a disposition attempt that is blocked.

**Rules.**

- A missing policy is a **visible gap**, never a silent "retain forever" or "dispose now" (see
  `tests/e2e/evidence-retention.spec.ts` and `packages/evidence/src/retention.ts`).
- The **longest** applicable approved policy wins (MAX retain-until).
- An **active legal hold** blocks disposition even after retention elapses (fail-closed).
- Disposition produces a **signed, tamper-evident** record and preserves full access history.

**Actions.**

1. For a retention gap: assign an approved retention policy for the affected classification, then
   re-resolve retention. Until then, treat the item as retained and flag the gap on the dashboard.
2. For a missing blob: verify by content address. If the stored bytes no longer hash to the
   recorded digest, treat as an integrity incident (§5).
3. For a blocked disposition: confirm whether a legal hold or unelapsed retention is the cause.
   Never bypass a hold; route to Compliance for authorized release.

**Escalation owner:** Compliance ops → Compliance lead → Data Protection Officer.

---

## 7. Cross-cutting: recording every operator action

Every action a runbook prescribes that changes governance state MUST emit a governed audit event
with: actor/principal, accountable owner, reason, source/target state, policy & control versions,
scope, timing, correlation, and outcome. Operator convenience never overrides accountability.

## 8. Related gates & evidence

- Resilience / safe degradation: `tests/resilience/chaos.test.ts` (T290).
- Performance budgets: `tests/performance/config.ts`, `tests/performance/acceptance.ts` (T277).
- Audit tamper freeze: `tests/e2e/audit-tamper.spec.ts` (T280).
- Evidence retention/holds/disposition: `tests/e2e/evidence-retention.spec.ts` (T281).
- Disaster recovery: `deploy/kubernetes/recovery/runbook.md` (T289),
  `tests/recovery/canonical-restore.test.ts` (T279).
