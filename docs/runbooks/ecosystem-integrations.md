# Runbook — Maintain Source and Workflow Health: named source adapters, least-privilege connectors, core-only activation, bounded retry, dead-letter preservation, authority-gated replay, drift-visible reconciliation, and order-independent projection rebuild

> **Audience.** The source steward, the platform owner, and the on-call operator who **keep the
> integration estate healthy** — the surface where a tenant connects named sources (Kanban,
> workflow_orchestration, agentctl, LISA, Wiggum), watches connector health, replays after an outage,
> reconciles drift, and rebuilds projections — **without ever letting a connector make a governance
> decision, and without ever inferring health from silence.**
>
> **What this runbook is.** The operating procedure for the ecosystem-integrations surface. It
> describes what a human must do, what the platform enforces automatically, and — critically — the
> invariants that keep the estate **safe and honest**:
>
> - **A connector is never granted governance authority.** Every named adapter maps its source to raw
>   observations only; none may approve, accept risk, close, release quarantine, or sign off. This holds
>   **even where a write capability exists** (agentctl declares `execute` and still grants zero
>   governance authority).
> - **Credentials are never stored.** A connector carries only an opaque `credentialRef`; the platform
>   never persists the secret itself.
> - **Absence is never inferred as health (SC-024).** An optional/on-demand source that is inactive is
>   surfaced as an explicit, owned inventory gap — never silently treated as "fine".
> - **At-least-once delivery reduces to exactly-one effect (SC-011).** A re-delivered event never
>   produces a second governance effect.
> - **Only the core profile runs continuously (NFR-010).** Named connectors are optional/on-demand and
>   are `intentionally_inactive` until an owner approves activation; core-only readiness never drags
>   down on optional inactivity.
> - **Drift stays visible.** A reconciliation run that cannot resolve a conflict reports
>   `resolved=false`, enumerates every drift item, pauses affected automation safely, and opens an owned
>   issue for human resolution.
> - **A terminal message is preserved, not dropped (FR-030).** An exhausted retry budget produces a
>   dead-letter record held for its owner; replay is refused without authority and permitted only once an
>   owner authorizes it.
> - **Contract-major drift is refused (NS-005).** A source that reports a contract major outside the
>   adapter's supported range is refused, not silently accepted.
>
> **Priority.** This surface is **User Story 6 (P3)** of the governance control plane — "Maintain
> Source and Workflow Health."

This runbook documents the behavior implemented and verified in:

- `packages/adapter-sdk/src/manifest.ts` — the adapter manifest model and its oracles:
  `validateManifest`, `negotiateCapabilities` (least-privilege capability subset; an undeclared
  capability is refused with `not_declared`), `negotiateContract` / `isMajorSupported` (the
  contract-major gate, NS-005), and `manifestDigest` (a stable content digest that catches silent
  manifest body drift). The manifest's `authority` block declares `authoritative_fields`,
  `forbidden_inferences`, and a closed `operation_risk` class range — the structural guarantee that a
  connector cannot name an approval/decision/closure.
- `tests/fixtures/integrations.ts` — the deterministic integrations world: the five shipped named
  adapter manifests (`NAMED_MANIFESTS`), the connector specs (`CONNECTOR_SPECS`, each with a `slug`,
  `adapterId`, `availabilityClass`, and an opaque `credentialRef`), the core component
  (`CORE_COMPONENT`), and `integrationsWorldDigest()` — a single content digest every scenario manifest
  is pinned to. No wall clock, no I/O, no randomness (a fixed `NOW`).
- `apps/command-worker/src/retry-scheduler.ts` — `scheduleRetry` and the retry-class predicates
  (`isRetryableClass` / `isTerminalClass`): a transient failure retries under the **same idempotency
  key** with bounded backoff; a terminal class (e.g. `unauthorized`) and an exhausted attempt budget
  both **stop** (no retry storm).
- `apps/command-worker/src/dead-letter-handler.ts` — `toDeadLetter` (preserves the terminal payload +
  a sha256 `originalDigest`, attributes it to an owner, records business impact, and holds it with
  `replayState=held`) and `authorizeReplay` (refuses replay without authority; transitions to
  `replayState=authorized` only when an authorized principal approves) — FR-030.
- `apps/command-worker/src/connector-reconciler.ts` — `reconcile`: a clean run reports
  `resolved=true`; a run with conflicting drift enumerates every drift item and reports
  `resolved=false` (the conflict stays visible, never elided) — FR-029.
- `apps/command-worker/src/component-lifecycle.ts` — `inspect` / `activate` / `reconcile` /
  `preflightPassed`: proof-before-active lifecycle. An unproven component is `intentionally_inactive`;
  activation reaches `active` only when all four prerequisites (identity, contract, authority, backlog)
  are proven; a lapsed component reconciles to `stale`. Every named connector is optional/on-demand and
  stays `intentionally_inactive` even when fully proven — only core runs continuously (NFR-010).
- `packages/application/src/source-ingestion.ts` — `emptyIngestionState` / `ingest` /
  `ingestionDigest` / `rawObservationsFor`: an append-only, dedup-keyed fold. Re-ingesting the same
  batch is a no-op (exactly-one effect, SC-011); rebuilding from the preserved raw log in a **different
  arrival order** reproduces the same content digest (order-independent projection rebuild).
- `packages/application/src/cursor-recovery.ts` — `detect`: surfaces duplicate, backlog-gap,
  out-of-order, mapping-change, and source-identity-change findings as **named** anomalies (never
  silently applied, never auto-filled).
- `packages/application/src/readiness-service.ts` — `evaluateReadiness`: core-only readiness. Core
  active + every named connector `intentionally_inactive` ⇒ `ready`, with an **explicit** unavailable
  inventory; optional inactivity never marks core unhealthy.

---

## 1. Named source adapters (Scenario 9 / Scenario 10)

The five shipped named adapters are pinned, both by an expectation table and by the load-bearing safety
invariant, in `tests/contract/named-adapters.contract.test.ts` (T225) and driven end-to-end by
`tests/e2e/scenarios/named-adapters.ts` (T271).

| Adapter | Source class | Content access | Idempotency | Operation-risk range | Grants governance authority |
|---|---|---|---|---|---|
| `kanban` | `kanban` | `metadata_only` | `read_only_only` | `read_only` | **no** |
| `workflow-orchestration` | `workflow_orchestration` | `scoped_content` | `read_only_only` | `read_only` | **no** |
| `agentctl` | `agentctl` | `scoped_content` | `source_operation_id` | `read_only`, `consequential` | **no** |
| `lisa` | `lisa` | `metadata_only` | `read_only_only` | `read_only` | **no** |
| `wiggum` | `wiggum` | `metadata_only` | `read_only_only` | `read_only` | **no** |

**Scenario 9 — Kanban projection boundary.** The Kanban adapter reads through Kanban APIs/SSE and maps
source columns to presentation stages while retaining raw status; card movement **cannot** approve,
accept risk, release quarantine, or close verified work; an unknown status opens a mapping gap rather
than retaining an unexplained prior stage. The named-adapters runner witnesses this as: the shipped
manifest validates, negotiates a least-privilege capability subset, refuses an undeclared capability
(`reason=not_declared`), passes the contract-major gate (`supportedMajor=true`, `driftedMajor=false`),
and grants **zero** governance authority.

**Scenario 10 — workflow_orchestration and agentctl compatibility.** The workflow adapter stays
read-only; schema-version and event-subject drift is retained as an explicit contract gap (NS-005). The
agentctl integration is the **only** named adapter that declares a write capability (`execute`,
operation-risk class `consequential`) — and it **still** grants zero governance authority, proving
least privilege is enforced even where a write path exists.

**How each is proven.** Every assertion reads a **real SDK verdict** (`validateManifest`,
`negotiateCapabilities`, `negotiateContract` / `isMajorSupported`) or a real shipped-manifest field —
never a re-implemented rule. The governance-authority "smell test" (`APPROVAL_RE`) asserts no
authoritative field names an approval / acceptance / decision / sign-off / closure /
`governance_verdict` / quarantine.

**Credentials.** Each `ConnectorSpec` in the fixture carries only an opaque `credentialRef`; the secret
is never stored. Activating a connector supplies the reference to the platform's secret broker at
runtime — the platform persists the reference, never the credential.

---

## 2. Core-only activation profile (NFR-010)

Only the **core** profile runs continuously. Every named connector is optional/on-demand and is
`intentionally_inactive` until an owner approves activation.

The core-only-activation profile (driven by `runNamedAdapters` → `runCoreOnlyActivation` in
`tests/e2e/scenarios/named-adapters.ts`, over `apps/command-worker/src/component-lifecycle.ts` and
`packages/application/src/readiness-service.ts`) witnesses:

- **Proof-before-active.** An unproven core (`authorityVerified=false`) inspects to
  `intentionally_inactive`; `activate` reaches `activationState=active | runtimeState=active` **only**
  when all four prerequisites are proven; a lapsed core (`backlogReconciled=false`) reconciles to
  `stale` (drift-visible).
- **Core-only continuity.** Every named connector inspects to `intentionally_inactive` even when fully
  proven — only core runs continuously.
- **Core-only readiness.** `evaluateReadiness` returns `verdict=ready | coreHealthy=true` with an
  **explicit** `optionalUnavailable` inventory; optional inactivity never marks core unhealthy.
- **Absence is never inferred as health (SC-024).** Every intentionally-inactive named source appears
  in the manifest's `gapRegister` with `runtimeState=intentionally_inactive` and
  `ownerAction=owner_approved_activation_to_enable` — a visible, owned inventory item, never hidden.

**Operator procedure — activate an optional named source.**

1. Confirm the connector's four prerequisites are proven: identity verified, contract verified,
   authority scoped (least-privilege capability subset), backlog reconciled.
2. Supply the opaque `credentialRef` (the platform resolves it via the secret broker; the credential is
   never stored).
3. Record the owner-approved activation decision. Until then the source stays
   `intentionally_inactive` and remains a visible gap — it is **not** treated as healthy by omission.

---

## 3. Connector outage, replay, dead letter, reconciliation, and projection rebuild (Scenario 11)

Driven by `tests/e2e/scenarios/connector-resilience.ts` (T270) over the real worker + application
modules. It witnesses, against the durable artifact each module produces (never a mutation return
boolean):

- **Outage + bounded retry** (`retry-scheduler.ts`). A transient outage retries under the **same
  idempotency key** (`op-outage-42`) with bounded backoff; a terminal class (`unauthorized`) stops; an
  exhausted budget (attempt 5/5) stops — no retry storm.
- **Dead letter + authority-gated replay** (`dead-letter-handler.ts`, FR-030). A terminal message is
  preserved (payload + sha256 digest), attributed to an owner, with business impact and a safe next
  action; `replayState=held`; replay **without** authority is refused; `authorizeReplay(principal:…)`
  transitions it to `replayState=authorized`. Nothing is dropped.
- **Replay → exactly-one effect** (`source-ingestion.ts`, SC-011). Re-delivering the same batch is a
  no-op: the ingestion content digest is byte-identical whether the batch arrived once or twice
  (`onceDigest === twiceDigest`).
- **Order-independent projection rebuild.** Rebuilding the projection from the preserved append-only
  raw log in a **reversed arrival order** reproduces the same content digest
  (`forwardDigest === rebuiltDigest`) — deleting a dashboard projection and rebuilding it produces the
  same canonical digest.
- **Drift-visible reconciliation** (`connector-reconciler.ts`, FR-029). A clean run reports
  `resolved=true`; a run with `stale` + `conflicting` drift enumerates every drift item and reports
  `resolved=false` — the conflict stays visible, affected automation pauses safely, and an owned issue
  (the dead-letter record) is opened for human resolution.
- **Surfaced anomalies** (`cursor-recovery.ts`). Duplicate, backlog-gap, mapping-change, and
  source-identity-change findings are surfaced as named anomalies in the `gapRegister`, each with a
  specific owner action (never "investigate", never auto-filled).
- **Contract-major gate** (`manifest.ts`, NS-005). `supportedMajor=true` for the declared range;
  `driftedMajor=false` for a major outside it (refused).

---

## 4. Evidence manifests (Scenario 9–11 + profile)

The two acceptance runners bind every User-Story-6 criterion (FR-008, FR-027–FR-030, FR-036–FR-042,
NFR-010, SC-011, SC-024) to a durable fact observed through a real oracle. Their results are emitted as
**signed, deterministic** result manifests under `tests/e2e/scenarios/_evidence/gate8/`:

- **Scenario 9 — Kanban projection boundary:** `scenario9-kanban-projection.manifest.json`
  (`journeyScope=scenario-9-kanban-projection`; the **Kanban** adapter line only, no core line).
- **Scenario 10 — workflow_orchestration & agentctl compatibility:**
  `scenario10-workflow-agentctl.manifest.json`
  (`journeyScope=scenario-10-workflow-agentctl`; the **workflow-orchestration + agentctl** adapter
  lines only, no core line).
- **Scenario 11 — connector outage, replay, and projection rebuild:**
  `scenario11-connector-resilience.manifest.json` (the connector-resilience runner's own manifest).
- **Profile — core-only activation:** `profile-core-only-activation.manifest.json`
  (`journeyScope=profile-core-only-activation`; the **core activation line + full optional gap
  inventory**, no adapter lines).

**Each of the four is a DISTINCT signed artifact — never a copy under another name.** Scenario 9,
Scenario 10, and the profile are three *distinct journeys* projected from the single deterministic
named-adapters run via `projectJourneyManifest()` (`kind: journey-result-manifest`): each journey
manifest carries a `journeyScope` discriminator and **only that journey's content** — Scenario 9 the
Kanban line, Scenario 10 the workflow_orchestration + agentctl lines, the profile the core line plus
the full optional gap inventory. Every digest is recomputed over the reduced content, so the three
journeys have **three distinct `manifestDigest` values** (a drift in the Kanban journey changes only
Scenario 9's digest and can never be masked by the agentctl or profile journey). `verifyJourneyManifest`
re-derives each journey from a fresh full run **and asserts no two journeys share a digest**, so the
per-journey evidence is independently falsifiable. Scenario 11 is the connector-resilience manifest.

Each manifest is canonicalised (sorted-key JSON, excluding the self-reference `manifestDigest` /
`signature` fields), hashed (sha256) into `manifestDigest`, and bound to `PINNED.worldDigest` via
`signature` (journey manifests additionally bind `signature.boundJourney` to their `journeyScope`).
Each adapter/core line also carries a chained `lineDigest`, so a single mutated line invalidates its
own digest. The run is deterministic (fixed `NOW`, no randomness, no I/O), so re-emitting over the same
fixture reproduces byte-identical digests — the non-repudiation property. **Before writing, the emitter
re-checks each manifest through its own independent verifier, asserts the three journey digests are
pairwise distinct, and refuses to write one that does not verify.**

```
# Emit (authoring step) — writes the four manifests, each independently verified first
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate8/emit-manifests.mjs

# Drift-check (verification step — fails if a runner / fixture / module changed the signed result)
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate8/emit-manifests.mjs --check
```

### Browserless acceptance witness + negative controls

`tests/e2e/ecosystem-health.spec.ts` (T226) runs under the browserless Playwright `ecosystem-health`
project (`testMatch /ecosystem-health\.spec\.ts/`). It never touches `page`; it drives both scenario
emitters/verifiers and asserts each manifest is **signed** (`sha256(canonicalize(m)) ===
m.manifestDigest`), **pinned** (scenario + world digest), and **tamper-evident**, with a **paired
negative control** for every positive claim:

- tamper a single witnessed byte → digest mismatch **and** `verify().ok === false`;
- remove an acceptance line → `verify().ok === false` with reason `missing acceptance line US6-AS3`;
- forge the drifted reconciliation run as `resolved=true` → reason
  `US6-AS4 does not witness the conflict staying visible`;
- forge an adapter as granting governance authority → reason `GRANTS governance authority`;
- forge core runtime away from `active` → `verify().ok === false`.

```
TC_NO_WEBSERVER=1 npx playwright test --project=ecosystem-health
```

The frozen `PLAYWRIGHT_PROJECT_NAMES` compatibility contract is **not** altered; `ecosystem-health` is
a separate browserless project (its own `testMatch`, no browser `use`, no `setup` dependency), mirroring
the existing `discovery` model.

---

## 5. Invariants at a glance

| Invariant | Enforced by | Witnessed by |
|---|---|---|
| A connector is never granted governance authority | `manifest.ts` authority block; `APPROVAL_RE` | `named-adapters.ts`; `named-adapters.contract.test.ts` |
| Credentials are never stored (opaque `credentialRef`) | `tests/fixtures/integrations.ts` `ConnectorSpec` | fixture + activation procedure (§2) |
| Absence is never inferred as health (SC-024) | `readiness-service.ts`; `gapRegister` | `named-adapters.ts` profile facet |
| At-least-once → exactly-one effect (SC-011) | `source-ingestion.ts` | `connector-resilience.ts` (US6-AS3) |
| Order-independent projection rebuild | `source-ingestion.ts` | `connector-resilience.ts` (US6-AS3) |
| Only core runs continuously (NFR-010) | `component-lifecycle.ts`; `readiness-service.ts` | `named-adapters.ts` profile facet |
| Drift stays visible; automation pauses safely (FR-029) | `connector-reconciler.ts` | `connector-resilience.ts` (US6-AS4) |
| Dead-letter preserved; authority-gated replay (FR-030) | `dead-letter-handler.ts` | `connector-resilience.ts` (US6-AS2) |
| Bounded retry (no storm) | `retry-scheduler.ts` | `connector-resilience.ts` (US6-AS2) |
| Contract-major drift refused (NS-005) | `manifest.ts` `isMajorSupported` | both runners |
