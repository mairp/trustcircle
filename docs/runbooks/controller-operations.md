# Runbook — Operate Governance Controllers Safely: discovery, inspection, expiring simulation, approval, guarded execution, uncertain-outcome reconciliation, idempotent one-effect dispatch, bounded continuity, safe rollback, evidence, and escalation

> **Audience.** The controller operator, the governance/compliance officer, and the platform steward
> who **operate the controller surface** — the estate where governance controllers (firewall,
> policy-store, quota, and similar effect-bearing agents) are discovered, inspected, simulated,
> approved, executed, paused/resumed, reconciled, rolled back, and evidenced — **without ever
> granting an operator unbounded power over the systems the controllers govern.**
>
> **What this runbook is.** The operating procedure for the safe-control surface. It describes what a
> human must do, what the platform enforces automatically, and — critically — the invariants that keep
> every operation **honest and bounded**: manifest-only control with an exact permitted-action set,
> version-pinned authority that a source-drift invalidates, one idempotency identity per logical
> dispatch, **an acknowledgement is never a success** (confirmation requires a direct remote
> observation), a duplicate effect surfaced not hidden, a continuity window that is bounded,
> nonrenewable, and confers no new authority, and a rollback that **never destroys newer legitimate
> state**.
>
> **Priority.** This surface is **User Story 4 (P2)** of the governance control plane — "Operate
> Governance Controllers Safely."

This runbook documents the behavior implemented and verified in:

- `db/migrations/0040_controller_operations.sql` — controller definitions/versions/instances,
  simulations, operations, continuity leases, reconciliation runs, and operation attempts (T158).
- `packages/domain/src/controllers.ts` — the controller/simulation/operation/continuity/reconciliation/
  rollback aggregates and the lifecycle oracles (`OPERATION_TRANSITIONS`, `allowedNextOperations`,
  `canOperationTransition`, `isTerminalOperationState`, `isReadOnlyOperation`, `decideRollback`,
  `continuityMayExecuteStep`) that every surface reads (T159).
- `packages/application/src/controller-registry.ts` — immutable controller-version registration
  (capabilities, risk, authority, preconditions, stop, rollback, evidence, health, tests, owner,
  approval) (T160).
- `packages/application/src/adapter-activation.ts` — adapter manifest signature, contract range,
  capabilities, least-privilege, conformance evidence, health, failure semantics, and activation
  approval (T161).
- `packages/application/src/simulation-service.ts` — expiring simulations bound to the source,
  controller, adapter, policy, scope, risk, conflict, evidence, stop, and rollback versions
  (`produceSimulation`, `checkSimulationBinding`) (T162).
- `packages/application/src/controller-operation-service.ts` — governed operation creation with
  desired/observed versions, idempotency, risk, steps, bounds, evidence, and valid-next-action
  checks (T163).
- `packages/application/src/execution-guard.ts` — the immediately-before-effect revalidation of
  authority, policy, ownership, evidence, source revision, preconditions, scope, rate/time bounds,
  and rollback (`guardExecution`) (T164).
- `apps/command-worker/src/operation-executor.ts` — claim-and-execute of approved steps with
  checkpoints, cancellation, stop conditions, attempt evidence, and uncertain outcomes (T165).
- `packages/adapter-sdk/src/client.ts` — the version-pinned, out-of-process adapter HTTP client with
  tenant credentials, idempotency, timeouts, and operation lookup (`AdapterClient`) (T166).
- `packages/application/src/continuity-service.ts` — bounded continuity for an approved-and-started
  operation only, under locally verifiable conditions (`evaluateContinuityEligibility`,
  `grantContinuityLease`, `mayExecuteContinuityStep`, `continuityLeaseActive`,
  `continuityReturnObligation`) (T167).
- `packages/application/src/operation-control.ts` — idempotent pause/resume with safe checkpoints and
  restored authority/precondition checks (T168).
- `packages/application/src/operation-reconciliation.ts` — reconciliation of desired, dispatched,
  remote, observed, and canonical states **without inferring success from acknowledgements**
  (`reconcileOperation`, `mayMutateAfterReconciliation`) (T169).
- `packages/application/src/controller-rollback.ts` — policy-approved rollback/compensation against the
  preserved preimage, verified against actual remote state (`decideControllerRollback`) (T170).
- `packages/evidence/src/operation-evidence.ts` — the operation-evidence collector (plan, attempts,
  buffered continuity records, remote observations, rollback, reconciliation, verification) (T171).
- `apps/api/src/routes/controllers.ts` — the controller list and operation create/get/action endpoints
  for the full governed lifecycle (T172).
- `packages/projections/src/controller-projector.ts` — the read projection of desired/observed state,
  operations, leases, progress, failures, evidence, retries, and permitted actions (T173).
- `apps/web/src/features/controllers/ControllerRegistry.tsx` — the accessible controller registry and
  desired-versus-observed (drift) view (T174).
- `apps/web/src/features/controllers/OperationDetail.tsx` — the accessible operation detail: simulation
  binding, approvals, progress, attempts, evidence, continuity, reconciliation, and rollback (T175).
- `apps/web/src/features/controllers/OperationActions.tsx` — the policy-aware pause/resume/reconcile/
  rollback/collect-evidence/cancel/emergency-stop controls, gated with a required idempotency key (T176).
- `apps/web/src/features/controllers/accessibility.tsx` — the presenter accessibility + control-safety
  oracle (non-color state meaning, live regions, focus, text/table alternatives) (T177).
- `tests/fixtures/adapters/stub-adapter.ts` — the deterministic contract-compliant adapter with
  controllable timeouts, partial effects, health loss, rollback, and reconciliation (T178).
- `tests/fixtures/controllers.ts` — the seeded controller/policy/simulation/approval/continuity/
  rollback/uncertain-outcome fixtures and their read-model builders (T179).

---

## 0. Acceptance criteria this runbook satisfies

This runbook is the human-readable authority for the User-Story-4 acceptance criteria. Each criterion
below is _also_ discharged by a deterministic, independently-observable acceptance runner
(`tests/e2e/scenarios/controller-operations.ts` and its three named sub-runners, tasks T180–T182),
re-asserted in a real browser against the shipped renderers by
`tests/e2e/controller-operations.spec.ts` (task T157), and signed into an evidence manifest under
`tests/e2e/scenarios/_evidence/gate6/` (task T183). The runbook documents the behavior; the runner +
manifest prove the behavior holds.

| Criterion              | Subject                                                                                                                                                                                     | Enforced by                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-023 / SC-010        | Every governed controller is **discovered** and surfaced in the operator registry.                                                                                                          | §1 + `controller-projector.ts` + `ControllerRegistry.tsx`; runner `runControllerOperationsScenario` → `FR-023 / SC-010`                                    |
| FR-024                 | Control is **manifest-only** with an **exact permitted-action set** the platform never widens; **drift is never masked** by a health verdict.                                               | §2 + §3 + `packages/domain/src/controllers.ts` `allowedNextOperations`; runner → `FR-024 (drift never masked)` + `(exact permitted actions)`               |
| FR-025 / GAR-005       | A **state-changing** action requires a **still-binding simulation** AND an **approval decision**; a read-only action does not.                                                              | §4 + `execution-guard.ts` + `OperationActions.tsx` `actionIsEnabled`; runner → `FR-025 / GAR-005`                                                          |
| FR-026 / FR-027        | Every dispatch carries **one idempotency identity** (≥ 8 chars); a retry under the **same key** yields **exactly one effect**.                                                              | §5 + `packages/adapter-sdk/src/client.ts` + `operation-reconciliation.ts`; runner (T180) → `SC-011 (one effect)`                                           |
| FR-028 / SC-010        | **An acknowledgement is not a success.** Confirmation requires a **direct remote observation**; an uncertain outcome surfaces **awaiting reconciliation**.                                  | §6 + `operation-reconciliation.ts` + `OperationDetail.tsx`; runner (T180) → `FR-028 (uncertainty ≠ success)` + `(observation-first)`                       |
| SC-011                 | One logical dispatch is **exactly one governed effect**; a **duplicate effect** is **surfaced**, never hidden.                                                                              | §6 + `OperationDetail.tsx` duplicate-effect warning; runner (T180) → `SC-011 (one effect)`                                                                 |
| NS-005                 | Authority is **version-pinned**; a **source-revision drift** between inspect/simulate/approve/execute **invalidates** the simulation and predicted effects.                                 | §4 + `simulation-service.ts` `checkSimulationBinding`; integration test `tests/integration/simulation-binding.test.ts`                                     |
| FR-046–FR-050 / SC-021 | Continuity is **in-progress-only**, **bounded ≤ 15 min**, **nonrenewable**, **step-gated**, confers **no new authority**, and **reconciles buffered effects on return**.                    | §7 + `continuity-service.ts`; runner (T181) `runBoundedContinuityScenario` → `FR-047`, `NFR-012`, `FR-046`, `FR-050`                                       |
| NS-011                 | A rollback **protects newer legitimate state**: a drifted observed revision **refuses** the rollback as a **conflict** and **escalates**; only a **verified** restore clears the operation. | §8 + `controller-rollback.ts` `decideControllerRollback`; runner (T182) `runControllerRollbackScenario` → `NS-011 (protect newer state)` + `(fail closed)` |

**The least-authority principle.** No operator may drive a controller beyond the exact action set its
current lifecycle state permits, no effect is claimed without a direct remote observation, and no
recovery mechanism (continuity or rollback) ever expands authority or destroys newer legitimate work.

---

## 1. Discover controllers

The registry (`ControllerRegistry.tsx`, projected by `controller-projector.ts`) lists **every**
governed controller instance in tenant scope, each with its owner, version, health, dependencies, and
its **desired-versus-observed** state. Discovery is complete: an un-fed registry states "No governance
controllers" — it can never masquerade coverage it does not have.

## 2. Drift is never masked

Each row carries a machine-readable `data-drift` flag and a textual `DRIFT — observed state differs
from desired state (not masked by health)` marker (`row-drift`). A controller can be `degraded` or even
`healthy` and **still** show drift; the flag is per-row truth derived from `desiredState` ≠
`observedState`, never a global health summary. The meaning is in the **word**, not a hue (WCAG 1.4.1).

## 3. Manifest-only control with an exact permitted-action set

Every row and every operation exposes exactly the projector's permitted next actions
(`allowedNextOperations(state)`). The platform never widens this set: a fresh (`requested`) operation
may `inspect`/`simulate`/`emergency_stop` but **not** `execute`; a confirmed `succeeded` operation
permits **only** the read-only `collect_evidence`; a terminal operation never permits a state-changing
re-drive. This is the honesty half of manifest-only control — the button set the operator sees is the
authority they hold, nothing more. See `tests/unit/controller-state-machines.test.ts` for the
exhaustive graph proof.

## 4. Inspect → simulate → approve → guard (version-pinned)

Before any effect, the operator inspects the controller, produces an **expiring simulation**
(`produceSimulation`) bound to the source revision, controller/adapter/policy versions, scope, risk,
conflict, evidence, stop, and rollback versions, and obtains an approval decision. A **state-changing**
action is enabled **iff** its state permits it AND simulation + approval both hold
(`actionIsEnabled`); a read-only action needs neither.

**Version pinning + source-drift invalidation (NS-005).** `checkSimulationBinding(sim, observed, now)`
binds a simulation to the current tuple only when every pinned member still matches. A drifted
`sourceRevision` (or any pinned version) yields `binds: false`, `invalidatedByDrift: true`, and the
drifted members are named — the predicted effect is invalidated and execution is refused by
`guardExecution` (`simulation-binding` + `source-revision` gates fail). An expired simulation yields
`invalidatedByExpiry`. See `tests/integration/simulation-binding.test.ts`.

## 5. One idempotency identity per dispatch (FR-026 / FR-027)

Every dispatch through `AdapterClient` carries a single idempotency key of **≥ 8 characters** (a
shorter key is rejected: the client throws on `/idempotency/i`). A retry under the **same key** after a
timeout — even with an out-of-band effect application in between — yields **exactly one** observed
effect (`observedEffectCount === 1`). The action form (`OperationActions.tsx`) presents a **required**
idempotency-key field. See `tests/contract/adapter-protocol.contract.test.ts` and
`tests/integration/operation-idempotency.test.ts`.

## 6. An acknowledgement is never a success (FR-028 / SC-011)

A plain 2xx acknowledgement returns `dispatched_unconfirmed` + `mustReconcile` — **not** confirmed. A
timed-out or severed dispatch returns `timed_out` / `uncertain` + `mustReconcile`. The operation moves
to `reconciling`, its confirmation banner reads `data-effect-confirmed="false"` and surfaces **AWAITING
RECONCILIATION**, and it can **never** jump straight to `succeeded` (`canOperationTransition('executing',
'succeeded') === false`; only `verifying → succeeded` is legal).

`reconcileOperation` establishes the true state from a **direct remote observation**, never from an
acknowledgement:

- **effect present** (`reconciled_effect_present`) → establishes state; a `succeeded` operation shows
  exactly `observedEffectCount === 1`.
- **no effect** (`reconciled_no_effect`) → also establishes state (a no-effect makes redispatch safe).
- **still uncertain** (remote unobservable) → establishes nothing; `mayMutateAfterReconciliation`
  refuses the next mutation.
- **duplicate effect** (`> 1`) → `conflict`; `OperationDetail.tsx` renders a **DUPLICATE EFFECT**
  warning (`duplicate-effect-warning`) — SC-011's one-effect rule violation is surfaced, never hidden.

See `tests/integration/operation-idempotency.test.ts` and the T180 runner
`tests/e2e/scenarios/uncertain-remote-outcome.ts`.

## 7. Bounded continuity (FR-046–FR-050 / SC-021)

When a controller loses health **mid-operation**, an **already-approved, already-started** operation
may continue for a short, **bounded, nonrenewable** window — and continuity **never creates new
authority**:

- **In-progress only (FR-047).** `evaluateContinuityEligibility` grants a lease only for an operation
  approved AND started before the failure. An unstarted or unapproved operation is refused — a lease
  for it would be power the operator never held.
- **Bounded ≤ 15 min + nonrenewable (NFR-012).** `grantContinuityLease` clamps any requested duration
  to the 15-minute ceiling (`CONTINUITY_LEASE_CEILING_MS`); a within-ceiling request is honored
  exactly; an ineligible grant throws.
- **Step-gated (FR-048 / SC-021).** `mayExecuteContinuityStep` permits a step only while the
  action-limit is not exhausted, local observations hold, and a new consequential step is locally
  revalidatable; past expiry the controller must pause.
- **Reconcile on return (FR-050).** `continuityReturnObligation` forces buffered continuity effects to
  reconcile **before** any new mutation.

The operation detail surfaces the lease's `data-continuity-active` verdict, its bounded remaining
window, and the reconcile-on-return duty. See `tests/resilience/bounded-continuity.test.ts` and the
T181 runner `tests/e2e/scenarios/bounded-continuity.ts`.

## 8. Safe rollback — protect newer legitimate state (NS-011)

Restoring a preserved preimage is itself a **governed act** that must never destroy newer legitimate
work. `decideControllerRollback`:

- **Protect newer state.** When the observed source revision no longer matches what the operation
  produced, a straight restore is **refused** as a `conflict` — newer state protected, scope stays
  degraded, **escalate**. `OperationDetail.tsx` surfaces `rollback_refused_newer_state` +
  `data-protected-newer-state="true"`, never a plain success.
- **Verified restore only (FR-028 observation-first).** Only a restoration verified by a **direct
  remote read** clears the operation; an unverified restore stays degraded.
- **Fail closed.** No preserved preimage → `unavailable`; no compensation path → `unavailable` +
  escalate; a partial compensation retains residual differences + escalate; an **unauthorized**
  rollback → `failed` + escalate. Never a silent success.

See `tests/resilience/controller-rollback.test.ts` and the T182 runner
`tests/e2e/scenarios/controller-rollback.ts`.

## 9. Evidence & escalation

Every operation collects plan, attempts, buffered continuity records, remote observations, rollback,
reconciliation, and verification evidence (`packages/evidence/src/operation-evidence.ts`), retrievable
via `collect_evidence` — the **only** action permitted on a fully-closed terminal operation. A conflict,
unavailable rollback, partial compensation, or unauthorized act **escalates** rather than closing
silently.

---

## 10. Evidence manifests (GATE6)

Two signed, deterministic result manifests bind the acceptance runners to this surface. Both are
canonicalised (sorted-key JSON) and hashed (sha256) into a top-level `manifestDigest`; the runners are
deterministic (fixed clock, no randomness), so re-emission over the same fixture reproduces
byte-identical digests — the non-repudiation property.

- **Scenario 7 — controller operations** (node-safe emitter, depends only on the fixture `.tsx`
  type-only + `@trustcircle/{domain,application}`):

  ```
  # write:
  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate6/emit-manifests.mjs
  # drift-check:
  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate6/emit-manifests.mjs --check
  ```

  → `tests/e2e/scenarios/_evidence/gate6/scenario7-controller-operations.manifest.json`

- **Scenario 8 — controller accessibility** (its runner dynamically imports a `.tsx` presenter, so it
  is emitted under vitest, which transforms `.tsx`):

  ```
  # write:
  TC_EMIT=1 npx vitest run --config tests/e2e/scenarios/_evidence/gate6/vitest.config.ts
  # drift-check:
  npx vitest run --config tests/e2e/scenarios/_evidence/gate6/vitest.config.ts
  ```

  → `tests/e2e/scenarios/_evidence/gate6/scenario8-controller-accessibility.manifest.json`

The browser journeys are run under the hermetic Playwright project:

```
TC_NO_WEBSERVER=1 npx playwright test --project=controller-operations
```
