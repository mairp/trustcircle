# Runbook — Contain and Repair Damaged Work Safely: detection, original preservation, quarantine, bounded automatic repair, reconciliation, verified closure, safe rollback, and escalation

> **Audience.** The governance/compliance officer, the remediation operator, and the platform steward
> who **operate the integrity surface** — the estate where damaged governance work (malformed,
> corrupted, duplicated, stale, conflicting, orphaned) is detected, contained, repaired only within
> pre-authorized bounds, and closed only under an independent nine-gate verification.
>
> **What this runbook is.** The operating procedure for the contain-and-repair authority surface. It
> describes what a human must do, what the platform enforces automatically, and — critically — the
> invariants that keep every repair **safe and accountable**: never mutate before the original is
> preserved, never let a damaged effect flow downstream, never auto-execute a destructive or
> not-pre-authorized plan, never convert a source-reported "done" or a bare repair success into a
> closed case, and never close a case without an independent verifier passing all nine closure gates.
>
> **Priority.** This surface is **User Story 3 (P1)** of the governance control plane — "Contain and
> Repair Damaged Work Safely."

This runbook documents the behavior implemented and verified in:

- `db/migrations/0030_integrity_remediation.sql` — the integrity schema (T127): integrity rules/cases,
  quarantines, remediation plans, repair attempts, reconciliation links, and verification records.
- `packages/domain/src/integrity.ts` — the integrity-case / quarantine / remediation-plan /
  repair-attempt / verification aggregates and the `isAutomaticEligible` and `verifiedClosureResult`
  oracles the surfaces read (T128).
- `packages/application/src/integrity-rule-registry.ts` — immutable, versioned integrity-rule
  definitions, applicability, tests, monitoring, approval, and activation (T129).
- `apps/command-worker/src/integrity-detector.ts` — evaluation of new/changed source records for
  malformed, corrupted, duplicate, conflicting, stale, orphaned, combined, and unknown defects (T130).
- `packages/evidence/src/original-preservation.ts` — capture of raw content, revision, metadata,
  digest, custody, classification, and retention **before any transformation** (T131).
- `packages/application/src/integrity-classifier.ts` — severity, confidence, safety/business impact,
  scope, dependencies, evidence status, and ownership-gap classification (T132).
- `packages/application/src/quarantine-service.ts` — blocking of unsafe execution dependencies while
  preserving inspection, impact, owner, evidence, review, and release controls (T133).
- `packages/application/src/remediation-planner.ts` — versioned remediation recommendations carrying
  risk, scope, preconditions, policy authority, evidence, verification, stop, rollback, expiry, and
  owner (T134).
- `packages/application/src/automatic-repair-policy.ts` — enforcement of current low-risk policy,
  source version, preservation, scope/rate/time/blast bounds, cancellation, rollback, and evidence
  gates (T135).
- `apps/command-worker/src/repair-executor.ts` — repair-step execution with one idempotency identity,
  derived evidence, checkpoints, kill switch, and uncertain-outcome handling (T136).
- `packages/application/src/rollback-service.ts` — protection of newer legitimate state, compensation,
  partial rollback, verification, failure, and escalation (T137).
- `packages/application/src/repair-reconciliation.ts` — reconciliation of the expected repair outcome
  with the authoritative current source, retaining every difference (T138).
- `packages/application/src/verification-service.ts` — enforcement of all nine Verified Closure Gate
  conditions and the independent-verifier rules (T139).
- `packages/application/src/integrity-escalation.ts` — escalation of destructive, consequential,
  unowned, repeated, expanding, evidence-tampered, rollback-failed, and verification-failed cases (T140).
- `apps/api/src/routes/integrity-cases.ts` — integrity-case list/get with original, quarantine,
  dependencies, plan, attempts, verification, and safe actions (T141).
- `apps/api/src/routes/remediation.ts` — propose/execute remediation and verification commands with
  ETags, idempotency, policy decisions, and audit outcomes (T142).
- `packages/projections/src/integrity-projector.ts` — the integrity-queue projection that **never**
  converts source `done` or a bare repair success into verified closure (T143).
- `apps/web/src/features/integrity/IntegrityQueue.tsx` — the accessible damaged-work queue (T144).
- `apps/web/src/features/integrity/EvidenceComparison.tsx` — the immutable original/derived provenance,
  custody, hash, version, and source-state comparison UI (T145).
- `apps/web/src/features/integrity/RemediationDetail.tsx` — the remediation recommendation, authority,
  simulation, bounds, stop, rollback, and verification detail UI (T146).
- `apps/web/src/features/integrity/accessibility.tsx` — non-visual defect explanations, correction
  guidance, keyboard quarantine actions, focus-managed async results, and the honest-empty-model audit
  (T147).

---

## 0. Acceptance criteria this runbook satisfies

This runbook is the human-readable authority for the User-Story-3 acceptance criteria. Each criterion
below is _also_ discharged by a deterministic, independently-observable acceptance runner
(`tests/e2e/scenarios/integrity-remediation.ts`, task T149), re-asserted in a real browser against the
shipped renderers by `tests/e2e/integrity-remediation.spec.ts` (task T126), and signed into an evidence
manifest under `tests/e2e/scenarios/_evidence/gate5/` (task T150). The runbook documents the behavior;
the runner + manifest prove the behavior holds.

| Criterion                | Subject                                                                                                                                                                                                         | Enforced by                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| FR-016 / SC-006          | Damaged governance work is **detected** with explicit, versioned integrity rules and surfaced in a **prioritized** queue, highest-attention first.                                                              | §1 + `integrity-detector.ts` + `integrity-rule-registry.ts` + `IntegrityQueue.tsx`; runner → `FR-016 / SC-006`          |
| FR-017 / SC-006/007      | The **original** item + source metadata is **preserved before any mutation** and is independently verifiable as **intact** (digest match).                                                                      | §2 + `packages/evidence/src/original-preservation.ts` + `EvidenceComparison.tsx`; runner → `FR-017 / SC-007`            |
| FR-018                   | Each problem is **classified** by type, severity, confidence, scope, safety impact, evidence status, source, and **owner** — an ownerless case names an **explicit gap**, never a fabricated owner.             | §3 + `integrity-classifier.ts` + `IntegrityQueue.tsx` ownership honesty; runner → `FR-018`                              |
| FR-019 / SC-007          | Unsafe/ambiguous items are **quarantined from execution** (named blocked capabilities) while remaining **visible, reviewable, and linked**.                                                                     | §4 + `quarantine-service.ts` + `EvidenceComparison.tsx` containment banner; runner → `FR-019 / SC-007`                  |
| FR-020                   | Remediation recommendations state change, rationale, expected result, risk, scope, preconditions, policy authority, evidence plan, verification, **stop**, and **rollback**.                                    | §5 + `remediation-planner.ts` + `RemediationDetail.tsx`; runner → `FR-020`                                              |
| FR-021 / SC-008          | **Automatic repair is limited to pre-authorized low-risk** cases whose current policy, preconditions, evidence preservation, scope, and rollback checks all pass; a destructive plan **must not** auto-execute. | §6 + `automatic-repair-policy.ts` + domain `isAutomaticEligible`; runner → `FR-020 / FR-021 / SC-008`                   |
| FR-020 (closure)         | A repair that **succeeded is succeeded-unverified, not closed** — closure is a separate verification act; rollback stays available.                                                                             | §7 + `repair-executor.ts` + `integrity-projector.ts` (no `done`→closed) + `RemediationDetail.tsx`; runner → `FR-020`    |
| FR-022 / SC-009          | A case is **verified-closed only when an independent verifier passes all nine closure gates**; failure/uncertainty **retains quarantine and escalates**.                                                        | §8 + `verification-service.ts` + domain `verifiedClosureResult` + `integrity-escalation.ts`; runner → `FR-022 / SC-009` |
| SC-006 / SC-007 / SC-009 | The three integrity presenters carry **zero** structural/semantic accessibility violations (WCAG 2.2 AA); state/verdict is stated **in text**, never color-only.                                                | §9 + `accessibility.tsx` + `integrity-remediation.spec.ts` axe scan; accessibility runner → `SC-006 / SC-007 / SC-009`  |
| FR-017 / FR-022          | An **un-fed** (empty) presenter is **honest**: not intact, not closed, execute disabled, empty queue stated — no false containment or closure claim.                                                            | §9 + `accessibility.tsx` `auditEmptyModelsAreHonest`; accessibility runner → `FR-017 / FR-022 / GAR-004`                |

**The safety rule (never mutate blind, never close unverified).** No repair may run before the
original is preserved; no damaged effect may reach downstream work while a case is open; no repair may
auto-execute unless it is provably a bounded pre-authorized low-risk plan; and no case may close until
an **independent** verifier passes **all nine** closure gates. A source that reports "done," or a
repair that merely succeeded, never closes a case on its own.

---

## 1. Detection and the prioritized queue (FR-016, SC-006)

**When** the platform ingests a new or changed source record, **then**
`apps/command-worker/src/integrity-detector.ts` evaluates it against the **explicit, versioned**
integrity rules held immutably in `packages/application/src/integrity-rule-registry.ts`, and any
detected defect — malformed, corrupted, duplicate, conflicting, stale, orphaned, combined, or unknown —
opens an integrity case.

`apps/web/src/features/integrity/IntegrityQueue.tsx` renders one `integrity-row` per case, ordered by
**priority** (severity × safety impact × ownership/escalation posture), highest first. Each row carries,
in **text** (never color-only): the problem class, safety impact, owner (or explicit gap), quarantine
state, dependency count, and escalation/attention flags. The `integrity-result-status` summary states
the total count in text.

**Invariant — complete, non-increasing ordering.** The queue lists every open case; priority ordering
is non-increasing (`rows[i-1].priority >= rows[i].priority`) and the escalated, human-attention case is
`row[0]`. The negative control: the verified-closed case has the lowest priority and
`data-needs-attention="false"` — it is never surfaced first. The proof is the re-readable projection,
not a mutation echo.

---

## 2. Original preservation before any mutation (FR-017, SC-006, SC-007)

**When** a defect is detected, **then** the **original raw content, revision, available metadata,
digest, custody, classification, and retention** are captured by
`packages/evidence/src/original-preservation.ts` **before** any normalization, quarantine, correlation
change, or repair. Preservation is a precondition of every downstream step — no transformation may run
until the original commit lands.

`apps/web/src/features/integrity/EvidenceComparison.tsx` presents the preserved original beside the
current (damaged) state. The `preservation-banner` (`role="status"`) reports `data-original-intact`, and
intactness is **checkable**: the captured `preservation-captured-digest` equals the independent
`preservation-verify-digest`. The original snapshot renders `data-quarantined="false"`; the current
snapshot renders `data-quarantined="true"`.

**Invariant — an un-fed view cannot masquerade as intact.** The negative control: the EMPTY comparison
model reports `originalIntact=false`. Intactness is asserted only from a matching verify digest, so a
view with no preserved original can never claim it is intact.

---

## 3. Classification and ownership honesty (FR-018)

**When** a case is opened, **then** `packages/application/src/integrity-classifier.ts` classifies it by
**type, severity, confidence, affected scope, safety impact, evidence status, source, and owner**. The
classification travels on the queue row and the detail.

**Ownership is a named owner or an explicit gap — never a fabricated owner.** When no owner can be
attributed, the row renders `data-ownership-gap="true"`, an empty `ownerPrincipalId`, a visible
`row-ownership-gap` marker, and `data-needs-attention="true"` — and it renders **no** fabricated owner
cell (`row-owner` count is 0).

**Invariant — the gap is scenario-specific.** The negative control: an owned case (e.g. detected-
preserved) shows a named owner and `data-ownership-gap="false"`. A missing owner is disclosed as a gap
that demands human attention, never papered over.

---

## 4. Quarantine contains the damage, keeps it inspectable (FR-019, SC-007)

**When** an item is unsafe or ambiguous, **then** `packages/application/src/quarantine-service.ts`
**quarantines it from execution** — blocking the **named** downstream capabilities — while keeping it
**visible, reviewable, and linked to dependent work**. Quarantine has explicit inspection, impact,
owner, evidence, review, and release controls; release is an authorized, audited act, and quarantine
carries an expiry review.

`EvidenceComparison.tsx` renders the `containment-banner` (`role="status"`) with
`data-quarantine-contains="true"` and a non-empty `data-blocked` list of the named blocked
capabilities. Containment is **not** opacity: the full diff (`diff-row` per field) renders, and a
safety-relevant change (e.g. `checksum`) is **disclosed** (`data-safety-relevant="true"`,
`data-change-kind="changed"`), not hidden.

**Invariant — containment without concealment.** The negative control: the EMPTY comparison reports
`quarantineContains=false` — with no active quarantine, no false containment is ever claimed. A real
active quarantine blocks execution _and_ keeps every field inspectable.

---

## 5. Remediation recommendations are fully specified (FR-020)

**When** a case warrants repair, **then** `packages/application/src/remediation-planner.ts` builds a
**versioned** remediation plan that states the **proposed change, rationale, expected result, risk,
affected scope, preconditions, policy authority, evidence plan, verification, stop conditions, and
rollback**. `apps/web/src/features/integrity/RemediationDetail.tsx` renders each step
(`remediation-step`) with its risk class and pre-authorization posture, plus the stop and rollback
affordances.

A plan's `status` is one of `draft | simulated | pending_approval | approved | expired | superseded` —
there is no ad-hoc "proposed" state; a plan that needs human approval sits in `pending_approval`.

**Invariant — no unspecified repair.** A plan that omits any of the required fields cannot be
constructed; the recommendation is the complete, reviewable contract for the change.

---

## 6. Bounded automatic repair — pre-authorized low-risk only (FR-021, SC-008)

**When** a plan is a candidate for **automatic** execution, **then**
`packages/application/src/automatic-repair-policy.ts` admits it **only** if the **current low-risk
policy, source-version binding, evidence preservation, and scope/rate/time/blast-radius bounds** all
pass, with cancellation and rollback available. The domain oracle is the single gate:

```
isAutomaticEligible(plan) === true
  ⟺ plan.authorizationMode === 'pre_authorized_low_risk'
   ∧ plan.destructive === false
   ∧ plan.riskClass === 'low'
   ∧ plan.policyVersionId !== undefined
```

`RemediationDetail.tsx` enables the `execute_if_pre_authorized` mode (`data-execute-enabled="true"`)
**only** when every rendered step is `data-pre-authorized="true"` and there is no ownership gap.

**Invariant — a destructive plan can never auto-execute.** The negative control: the destructive
needs-approval plan is **not** `isAutomaticEligible` (`destructive === true` fails the conjunction), so
its execute mode is gated. Automatic repair is a narrowly bounded exception, never the default.

---

## 7. A successful repair is not a closed case (FR-020)

**When** a pre-authorized repair runs, **then** `apps/command-worker/src/repair-executor.ts` executes
its steps under **one idempotency identity**, emits **derived** evidence with provenance, takes
**checkpoints**, honors the **kill switch**, and handles **uncertain outcomes** conservatively. A repair
that completes lands in outcome `succeeded_unverified` — **not** closed.

`packages/projections/src/integrity-projector.ts` **never** converts a source `done` flag or a bare
repair success into verified closure. `RemediationDetail.tsx` therefore shows, for a succeeded repair:
`remediation-attempt[data-outcome="succeeded_unverified"]`, `data-rollback-available="true"`,
`detail-main[data-case-closed="false"]`, a `closure-banner` with `role="alert"` and
`data-case-closed="false"`, and a `verification-none` marker (zero gates verified).

**Invariant — success is a claim, closure is a verdict.** The negative control: the verified-closed
detail carries `caseClosed=true` **only** because its independent verification passed (§8). A
source-reported "done," or a repair that merely succeeded, never closes a case.

---

## 8. Verified closure — an independent nine-gate pass (FR-022, SC-009)

**When** closure is attempted, **then** `packages/application/src/verification-service.ts` enforces
**all nine Verified Closure Gate conditions** and the **independent-verifier** rule. The nine gates
(`CLOSURE_GATES`, length 9) are:

1. `originals_and_derivatives_present`
2. `rule_control_tests_pass`
3. `state_reconciled_no_uncertainty`
4. `evidence_complete`
5. `no_unresolved_critical_dependency`
6. `residual_risk_zero_or_excepted`
7. `verifier_independent`
8. `tenant_and_central_reviews_current`
9. `closure_transition_audited`

The domain oracle is authoritative:

```
verifiedClosureResult({ gateResults, verifierIndependent }) === 'passed'
  ⟺ every one of the nine gate results is passed ∧ verifierIndependent === true
```

State reconciliation (gate 3) is produced by `packages/application/src/repair-reconciliation.ts`, which
reconciles the expected repair outcome against the **authoritative current source** and **retains every
difference** — an unreconciled uncertainty fails the gate. `RemediationDetail.tsx` renders the
verified-closed detail with `detail-main[data-case-closed="true"]`, a `closure-banner` with
`role="status"`, `remediation-verification[data-all-gates-passed="true"]`, and exactly nine
`verification-gate` rows each `data-passed="true"`.

**Failure or uncertainty retains quarantine and escalates.** If any gate fails, or the verifier is not
independent, the case is **not** closed; `packages/application/src/integrity-escalation.ts` escalates
destructive, consequential, unowned, repeated, expanding, evidence-tampered, rollback-failed, and
verification-failed cases, and the quarantine stays active. Rollback is handled by
`packages/application/src/rollback-service.ts`, which protects newer legitimate state, supports
compensation and partial rollback, verifies the result, and escalates on failure.

**Invariant — closure is a live conjunction, not a flag.** The negative control: the auto-repaired
detail is **not** closed (0 gates verified). Flipping any single gate false, or making the verifier
non-independent, drives `verifiedClosureResult` away from `passed`.

---

## 9. Accessibility and honest empty models (SC-006, SC-007, SC-009; WCAG 2.2 AA)

The three integrity presenters state every problem, containment, gating, and closure **verdict in text**
(never color-only, WCAG 1.4.1), expose name/role/state and live regions for asynchronous repair results,
and support keyboard quarantine actions with managed focus
(`apps/web/src/features/integrity/accessibility.tsx`, T147).

- **Zero violations.** `auditIntegrityAccessibility({tenant, queue, comparison, detail})` renders the
  three shipped presenters and returns findings; the audit reports **zero**. The browser witness
  (`tests/e2e/integrity-remediation.spec.ts`, project `integrity-remediation`) additionally scans each
  surface with axe-core against the WCAG 2.2 AA tag set.
- **Honest empty models.** `auditEmptyModelsAreHonest(tenant)` proves an **un-fed** presenter tells the
  truth: an empty comparison reports **not intact**, an empty detail reports **not closed** with execute
  **disabled**, and an empty queue **states** it is empty. Were an empty comparison to claim intact, or
  an empty detail to claim closed, the audit would report a finding.

**Invariant — the surface never over-claims.** Accessibility here is not decoration: it is the mechanism
by which a reviewer relying on assistive technology reads the same intact/contained/gated/closed
verdicts, and by which an empty view is prevented from silently implying safety it has not established.

---

## 10. Signed evidence manifests (T150)

The two User-Story-3 scenarios are signed into evidence manifests under
`tests/e2e/scenarios/_evidence/gate5/`:

- `scenario5-integrity-remediation.manifest.json` — FR-016, FR-017, FR-018, FR-019, FR-020, FR-021,
  FR-022, SC-006, SC-007, SC-008, SC-009 (detect · preserve · contain · bound · succeeded-≠-closed ·
  verified closure).
- `scenario6-integrity-accessibility.manifest.json` — the three integrity presenters' WCAG 2.2 AA
  audit and the honest-empty-model obligations (SC-006/007/009, FR-017/FR-022).

Each manifest records, for every criterion, the asserted **evidence**, the durable **read path** it was
observed through (`observedVia`), and the **negative control** whose flip would drive the oracle red.
The full result is canonicalised (sorted-key JSON) and hashed with sha256 into a top-level
`manifestDigest`; because the runners use **no clock, no I/O, and no randomness**, re-emission over the
same fixture (`tests/fixtures/integrity.ts`) reproduces **byte-identical** digests — the
non-repudiation property SC-009 rests on.

**Why two emitters.** Scenario 5 depends only on the fixture (`.tsx` imports type-only) and
`@trustcircle/domain`, so it is emitted by a node-safe raw-Node script. Scenario 6's runner **renders
the shipped `.tsx` presenters** via the accessibility oracle; Node's built-in
`--experimental-strip-types` loader refuses the `.tsx` extension, so that manifest is emitted under
vitest (which transforms `.tsx`) via a dedicated config kept beside the emitter. Both emitters share the
same `sign` / `buildManifest` / `persist` helpers, so the manifests are shape- and signing-consistent.

**Regenerate / verify:**

```
# Scenario 5 (node-safe): (re)write, then drift-guard
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate5/emit-manifests.mjs
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate5/emit-manifests.mjs --check

# Scenario 6 (needs .tsx → vitest): TC_EMIT=1 writes; default run drift-guards
TC_EMIT=1 npx vitest run --config tests/e2e/scenarios/_evidence/gate5/vitest.config.ts
npx vitest run --config tests/e2e/scenarios/_evidence/gate5/vitest.config.ts
```

The browser-driven witness (`tests/e2e/integrity-remediation.spec.ts`, project
`integrity-remediation`) mounts the shipped renderers via `page.setContent`, re-asserts the same DOM
contracts (queue prioritization + ownership honesty, original-intact + containment banners, execute
gating, succeeded-≠-closed, nine-gate verified closure), and scans each surface with axe-core (WCAG 2.2
AA), so the logic oracle and the presentation oracle agree.
