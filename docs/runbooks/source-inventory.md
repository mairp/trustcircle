# Runbook — Source Inventory: discovery authority, onboarding, exclusion, gap triage, and core-only operation

> **Audience.** The governance/compliance officer and the platform steward who operate the source
> inventory: the always-current picture of every governance-relevant source (an AI asset, a work
> system, a control record store) inside the declared computer boundary.
>
> **What this runbook is.** The operating procedure for the _authoritative_ inventory surface. It
> describes what the platform does automatically, what a human must do, and — critically — the
> invariants that keep the picture **honest**: every source appears **once**, nothing healthy hides a
> gap, nothing stale is reported as fresh, and nothing discovered silently disappears.
>
> This runbook is a **supported consumer surface**: onboarding, incident response, and the
> obligation-mapping test (`tests/tooling/source-inventory-doc.test.mjs`) read it. It is enforced —
> the test fails if a required subject or an obligation citation drifts out of the doc.

This runbook documents the behavior implemented and verified in:

- `packages/application/src/source-registry.ts` — the `SourceRegistry` aggregate (Phase 65): discovery,
  onboarding lifecycle, stewardship, exclusion, reconciliation, coverage assessment, current-state view.
- `packages/domain/src/component-profile.ts` — the two-axis component model + `evaluateExecutionGate`
  (Phase 52, NFR-010): architecture role vs. runtime **availability class** (`core` / `optional` / `on-demand`).
- `apps/discovery-agent/src/**` — the least-privilege, metadata-only discovery agent (Phases 67–69).
- `apps/discovery-agent/src/classifiers/core-architecture.ts` — the advisory two-axis classifier (Phase 69).

---

## 0. Verification obligations this runbook satisfies

This runbook is the human-readable authority for the source-inventory acceptance criteria. Each
obligation below is _also_ enforced by an automated, independently-observable test; the runbook
documents the behavior and the test proves the doc keeps documenting it.

| Obligation              | Subject                                                                                                                                                                                                                                   | Enforced by                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| VO-17f515089c2fa3df7074 | Healthy connected sources → current-state view shows each item **once** with type, source identity, owner, lifecycle state, risk, control coverage, evidence state, health, last observation time, unresolved issues.                     | §1 + `SourceRegistry.currentStateView()`; `tests/unit/source-registry.unit.test.ts` |
| VO-b0c8db36e38294f255d2 | Discovered-but-unmanaged / unreachable / stale / orphaned / excluded component → stays **visible as a coverage gap** with reason, age, impact, owner action — not healthy, not gone.                                                      | §3 + `SourceRegistry.reconcile()`                                                   |
| VO-a9b3817cf3037ba213be | Related work across registered sources (Kanban, agentctl, workflows_orchestration) → drill-down shows **distinct source records**, correlation, status differences, dependencies, authoritative fields.                                   | §4 + `SourceRegistry.drillDown()` / `statusDifferencesFor()`                        |
| VO-6e56909c42e15b9dba13 | Stale / unavailable source → data marked with **last-known time + confidence**; current compliance/health **not inferred** from stale data.                                                                                               | §5 + `SourceRegistry.currentStateView()` staleness overlay                          |
| VO-d1e59925eee504244d39 | Unregistered governance-relevant source within the declared boundary → **added to the source catalog** with discovery evidence, type-or-unknown classification, location, access status, sensitivity, ownership status, onboarding state. | §2 + `SourceRegistry.discover()`                                                    |
| VO-4c192ba5b64b4227c51a | Discovered source that is unsupported / inaccessible / sensitive / unowned / excluded → stays **visible as a governed-source gap** with reason, impact, owner action, and review-or-expiry.                                               | §6 + §7 + `SourceRegistry.assessCoverage()` / `exclude()`                           |

**Discovery authority (the least-information rule).** Discovery MUST use the least information
necessary to identify and classify a source. It MUST NOT read protected content, secrets, or
credentials beyond current authorization, and it MUST record any resulting **visibility limitation**
rather than guess. This is enforced structurally in the discovery agent — see §8.

---

## 1. The current-state view (VO-17f515089c2fa3df7074)

**When** the officer opens the current-state view, **then** every catalogued source renders **exactly
once**, carrying its full facet set. There is no second row for the same source; re-discovery is
idempotent (§2), so a source seen twice is still one row.

`SourceRegistry.currentStateView(at)` returns one `SourceStateRow` per catalog entry. Each row carries:

- **type** — `sourceClass` (e.g. `kanban`, `agentctl`, `workflow_orchestration`), plus
  `classifiedUnknown` when the class is the reserved `unknown` classification.
- **source identity** — `sourceId` (a stable UUID).
- **owner** — `ownerPrincipalId`, plus an explicit `ownershipGap` flag when unowned (never hidden).
- **lifecycle state** — `onboardingState` (`discovered` / `pending` / `onboarded` / `excluded` / `retired`).
- **risk / sensitivity** — `sensitivity` (`normal` / `sensitive` / `restricted`).
- **control coverage** — `hasControlCoverage` (true only when there are **no** visible gaps for the source).
- **evidence state** — `evidenceState` (`current` / `stale` / `absent`), derived from contract + onboarding + staleness.
- **health** — `observedHealth` (last recorded) **and** `reportedHealth` (what the officer may rely on; see §5).
- **last observation time** — `lastKnownAt`.
- **unresolved issues** — `unresolvedIssueCount` (count of visible coverage gaps for the source).

**Invariant — one row, honest facets.** The mutation response is never the proof: the officer reads
the re-readable view and its `snapshotDigest()`. A source is only reported `reportedHealth: healthy`
when it is genuinely onboarded **and** fresh.

---

## 2. Source discovery authority & onboarding (VO-d1e59925eee504244d39)

**When** an unregistered, governance-relevant source appears within the **declared computer boundary**,
**then** discovery **adds it to the source catalog** — it is never left invisible.

`SourceRegistry.discover({ externalKey, location, discoveryEvidence, at, … })` creates a
`SourceCatalogEntry` carrying:

- **discovery evidence** — `discoveryEvidence` (the metadata-only observation that justified the entry).
- **type-or-unknown classification** — `sourceClass`, defaulting to the reserved `unknown` class when the type cannot be determined.
- **location** — `observedLocations` (disclosure-safe; see §8).
- **access status** — `accessState` (`reachable` / `unreachable` / `inaccessible` / `unknown`), default `unknown`.
- **sensitivity** — `sensitivity`, default `normal`.
- **ownership status** — `ownerPrincipalId` or an ownership gap when unowned.
- **onboarding state** — `discovered` (the entry point of the lifecycle).

**Idempotent discovery.** Re-discovering an already-catalogued source (matched by `externalKey`)
refreshes `lastSeenAt` and merges any newly-observed location — it does **not** create a duplicate
row and does **not** trigger a duplicate governance action.

### Onboarding lifecycle (the guarded state machine)

```
discovered → pending → onboarded ⇄ excluded
      \          \          \         /
       \__________\__________\_______/  → retired   (terminal; history preserved, never deleted)
```

Permitted transitions (`ONBOARDING_TRANSITIONS`):

| From         | To                                 |
| ------------ | ---------------------------------- |
| `discovered` | `pending`, `excluded`, `retired`   |
| `pending`    | `onboarded`, `excluded`, `retired` |
| `onboarded`  | `excluded`, `retired`              |
| `excluded`   | `pending`, `retired`               |
| `retired`    | _(none — terminal)_                |

`transitionOnboarding()` rejects any illegal transition. **Onboarding to `onboarded` requires** a
registered, validated source **contract** _and_ a named **owner** — a source with no steward or no
contract cannot be reported as fully governed. Onboarding does **not** imply health; health is set
separately by a stewardship observation (`recordObservation()`), and a not-yet-onboarded source can
never carry a `healthy` claim (a domain invariant re-checked on every rewrite).

**Steward actions:** `assignOwner()` (closes the ownership gap), `recordObservation()` (records
access + health + last-seen), `registerContract()` (versioned, append-only, validated contract history).

---

## 3. Gap triage — reconcile keeps unhealthy sources visible (VO-b0c8db36e38294f255d2)

**When** inventory is reconciled, **then** any source that is not cleanly
onboarded-connected-healthy — **unmanaged**, **unreachable**, **stale**, or **orphaned**, or an
**excluded** one — remains **visible as a coverage gap**. It never appears healthy, and it never
disappears.

`SourceRegistry.reconcile({ at })` opens a `component`-class coverage gap for each such source. Every
gap carries:

- **reason** — `stale`, `unreachable`, `unmanaged`, `orphaned`, or `excluded`.
- **age** — `gapAge(gapId, now)` (`firstSeenAt` to now).
- **impact** — `high` for `orphaned`; `medium` otherwise.
- **required owner action** — a concrete instruction, e.g.:
  - `stale` → "Re-establish a fresh observation; do not rely on last-known state."
  - `unreachable` → "Restore connectivity to the source and re-observe."
  - `unmanaged` → "Complete onboarding so the source is governed, or exclude it with a review."
  - `orphaned` → "Re-attach the orphaned component to an owner and boundary."

**Invariants.**

- **Idempotent** per `(source, reason)`: reconciling twice does not duplicate a gap.
- **Never deletes.** Terminal/resolved gaps stay queryable (`coverageGaps()` returns history);
  `gapIsVisible()` selects the currently-open surface. History stays reconstructable.
- A discovered/pending source is `unmanaged` until onboarded; an `onboarded` source whose health is
  `unknown` is `unmanaged`; an unreachable/inaccessible source is `unreachable`; a source past the
  staleness horizon is `stale`.

---

## 4. Cross-source drill-down & correlation (VO-a9b3817cf3037ba213be)

**When** related work exists across registered sources — **Kanban**, **agentctl**,
**workflows_orchestration** — and the officer drills into an item, **then** the view shows their
**distinct source records**, their **correlation**, their **status differences**, their
**dependencies**, and the **authoritative fields**.

`SourceRegistry.drillDown(sourceId)` returns:

- **distinct source records** — `records` (`sourceRecordsFor()`): each source's raw per-source
  observation, kept **distinct** (correlated, never merged). Duplicates collapse by record identity.
- **correlation** — records are correlated to one catalog entry; relationship **edges**
  (`relationshipsFor()`) tie sources together (`correlates`, `depends_on`, authoritative-field edges).
- **status differences** — `statusDifferences` (`statusDifferencesFor()`): the per-field
  disagreements across the distinct records. Example: Kanban reports a work item `active` while
  agentctl reports it `inactive` — a difference a human reconciles, **not** one the registry silently
  collapses. Each difference names the field and every distinct value with the record ids that hold it.
- **dependencies** — `dependencies` (`dependenciesFor()`): the `depends_on` edges to the sources this
  one depends on.
- **authoritative fields** — carried on the versioned **contracts** (`contracts()` /
  `latestContract()`): which fields each source is authoritative for.

Health/authority is **never inferred from an edge** — an edge only records a declared relationship.

---

## 5. Stale / unavailable sources — last-known time + confidence (VO-6e56909c42e15b9dba13)

**When** a source becomes stale or unavailable and the view is refreshed, **then** affected data is
visibly marked with its **last-known time** and a **confidence**, and current compliance/health is
**not inferred** from stale data.

`SourceRegistry` derives a **staleness verdict** per source (`stalenessOf()`), against the injected
`stalenessHorizonMillis` (default 15 minutes — the freshness objective):

| Verdict       | Condition                                                              | Confidence              |
| ------------- | ---------------------------------------------------------------------- | ----------------------- |
| `fresh`       | last-seen within the horizon                                           | `1.0`                   |
| `stale`       | last-seen within `[horizon, 2·horizon)`                                | decays linearly `1 → 0` |
| `unavailable` | last-seen `≥ 2·horizon`, **or** access is `unreachable`/`inaccessible` | `0`                     |

Every `SourceStateRow` therefore carries: `staleness`, `lastKnownAt` (the last-known observation
time), and `confidence ∈ [0,1]`.

**Fail-visible invariant.** `reportedHealth` is downgraded to `unknown` the moment a source is not
`fresh`. Full confidence (`1.0`) is only ever reported for genuinely fresh knowledge, so the officer
is **never** told stale data is fully trustworthy, and current health/compliance is never derived from
a stale observation. `evidenceState` likewise drops to `stale` (or `absent`) rather than `current`.

---

## 6. Governed-source gaps — coverage assessment (VO-4c192ba5b64b4227c51a)

**When** coverage is assessed, **then** a discovered source that is **unsupported**, **inaccessible**,
**sensitive**, **unowned**, or intentionally **excluded** remains **visible as a governed-source gap**
with reason, impact, owner action, and a **review-or-expiry**.

`SourceRegistry.assessCoverage({ at, reviewWindowMillis })` synthesises a `governed_source`-class gap
for each condition a source exhibits:

| Reason         | Trigger                                                         | Impact | Owner action                                                                      |
| -------------- | --------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `unsupported`  | latest contract support level is `unsupported`                  | high   | "Provide a supported adapter/contract or formally accept the coverage gap."       |
| `inaccessible` | access is `inaccessible`/`unreachable`                          | high   | "Restore connectivity/credentials so the source can be observed."                 |
| `sensitive`    | sensitivity is `sensitive`/`restricted` and not yet `onboarded` | medium | "Complete a sensitivity/data-classification review before onboarding."            |
| `unowned`      | catalog entry has an ownership gap                              | medium | "Assign an accountable steward/owner for this source."                            |
| `excluded`     | onboarding state is `excluded`                                  | medium | "Review the exclusion at the scheduled date and re-onboard or confirm exclusion." |

Every governed-source gap carries a **review date** (`assessCoverage` sets `reviewAt = at +
reviewWindow`, default 30 days). Assessment is **idempotent** per `(source, reason)` — an equivalent
open gap is not duplicated. `assessCoverage()` returns the currently-visible gaps (the fail-visible
coverage surface).

---

## 7. Exclusion — intentional, reviewed, never silent (VO-4c192ba5b64b4227c51a)

Excluding a source from governance is a **deliberate, reviewable** act, not a deletion.

`SourceRegistry.exclude({ sourceId, reason, requiredAction, reviewAt | expiresAt, … })`:

1. Transitions the source's onboarding state to `excluded` (the source is **not** deleted).
2. Opens a `governed_source` coverage gap carrying the **exclusion reason** (a structured `Reason`
   with a code), the **scope/impact**, the **required owner action**, and a **mandatory review date
   or expiry** — at least one is required, else the call is rejected.

So an excluded source stays **visible** as a governed-source gap with a scheduled review; it never
silently drops off the inventory. An excluded source can later transition back to `pending` for
re-onboarding, or to `retired`. Every mutation is captured in the append-only history and the
`snapshotDigest()` — the exclusion leaves an **audit trail**.

---

## 8. Discovery authority — least information, no protected content

Discovery operates under **least privilege** and the **least-information** rule. The discovery agent
(`apps/discovery-agent/src/**`) is structurally constrained so it **cannot** exceed its authority:

- **Metadata-only sensor.** Scanners report marker names, locations, and `stat`-level metadata — never
  file **content**. Every durable record flows through a metadata-only shape and is asserted
  metadata-only before it is written.
- **Least-privilege scan scopes + fail-closed authorization.** Every target must be in the agent's
  granted scope set; a target out of scope is `denied` (`out_of_scope`) without even consulting the
  authorizer. Before any target is probed, a fail-closed authorization decision must return
  `authorized`; unknown/indeterminate/denied → the target is not read.
- **Secret-safe disclosure.** A path segment (or a marker name) that looks secret-shaped is **redacted**
  before it is written, so a disclosed identity/location never carries a secret **value**.
- **Record the visibility limitation.** When authorization or redaction limits what discovery can see,
  the limitation is **recorded** (the source is catalogued as `unknown`/limited rather than guessed
  at). Discovery never reads protected content, secrets, or credentials beyond current authorization.

The classifier (`core-architecture.ts`) is **advisory only**: it proposes an architecture role and an
availability class but **never onboards** — every emitted record keeps `registered: false` and an
onboarding state of `discovered` or `gap`, and an owner-approval step is still required.

---

## 9. Core-only operation

The inventory must stay honest even when only the platform's **core** is running. The component model
(`packages/domain/src/component-profile.ts`, NFR-010) places every component on two **independent**
axes:

1. **Architecture role** — stable, owner-approved design intent (`ARCHITECTURE_ROLES`).
2. **Runtime availability class** — how essential to the running platform: **`core`** / **`optional`**
   / **`on-demand`** (`AVAILABILITY_CLASSES`).

The axes are deliberately independent: architecture-**core** membership does **not** imply `core`
availability. For example, LISA and Wiggum are architecture-core but activated **on-demand**; Kanban,
workflow_orchestration, and agentctl are **optional** connectors (read/observed, not core-required).

**Core-only mode.** In core-only operation, only the core-required services run; `optional` and
`on-demand` components are **expected-offline**, not incidents.

- **An expected-offline component raises no incident.** Its offline state is a _distinct_ status from
  the degraded / stale / unreachable / failed incident vocabulary. A non-running optional component is
  not a coverage gap by virtue of being off.
- **Read-only visibility & escalation stay available in every gate outcome.** The fail-visible picture
  is always renderable so the officer can still see the inventory and open issues.
- **Loss of a core governance prerequisite blocks affected execution immediately** — new _and_
  in-progress — via `evaluateExecutionGate`; continuity mode cannot rescue a lost required prerequisite.
- **A degraded core component is never reported ready.**

This behavior is exercised end-to-end by the core-only profile integration witness
(`tests/integration/core-only-profile.test.ts`, VO-80051a0ad930b1560ff7), which binds the deployed
core-only control plane to the executable safe-degradation gate.

---

## 10. Operating invariants (summary)

- **One row per source.** Re-discovery is idempotent; the current-state view never duplicates a source.
- **Never healthy while stale.** `reportedHealth` is `unknown` for any non-fresh source.
- **Never inferred from stale data.** Confidence < 1 the moment a source leaves `fresh`.
- **Never disappears.** Every non-healthy source stays visible as a coverage gap; nothing is deleted —
  terminal states remain queryable and history is reconstructable via `snapshotDigest()`.
- **No governance authority for discovery/adapters.** Discovery records, classifies, and keeps visible;
  it does not onboard, repair, or infer compliance.
- **Least information.** Discovery reads only what it is authorized to; it records visibility limits
  rather than guess, and never touches protected content, secrets, or credentials.
- **The mutation response is never the proof.** Evidence is the re-readable state and its content digest.

---

## 11. Reference — code & tests

| Concern                                        | Code                                                                  | Test                                          |
| ---------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Registry / view / gaps / exclusion / reconcile | `packages/application/src/source-registry.ts`                         | `tests/unit/source-registry.unit.test.ts`     |
| Two-axis component model + execution gate      | `packages/domain/src/component-profile.ts`                            | `tests/tooling/component-profiles.test.mjs`   |
| Core-only profile safe-degradation             | `deploy/profiles/components.yaml`, `deploy/compose/control-plane.yml` | `tests/integration/core-only-profile.test.ts` |
| Least-privilege discovery agent                | `apps/discovery-agent/src/main.ts`, `.../scanners/*`                  | `tests/discovery/**`                          |
| Advisory core-architecture classifier          | `apps/discovery-agent/src/classifiers/core-architecture.ts`           | `tests/discovery/**`                          |
| This runbook (obligation mapping)              | `docs/runbooks/source-inventory.md`                                   | `tests/tooling/source-inventory-doc.test.mjs` |
