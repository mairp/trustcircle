# Deployment Options — Governance Control Plane

Phase 9 · T293 · GAR-010. The supported deployment topologies for the TrustCircleAI Governance
Control Plane, with **component profiles**, **scaling** guidance, **data-residency** handling, and
an honest statement of **assurance limitations** per option. All topologies preserve the platform's
invariants: PostgreSQL and the tamper-evident audit ledger are authoritative; dashboards expose
freshness and partial coverage; authorization fails closed.

---

## 1. Topology overview

| Option                      | Isolation                                         | Typical use                               | Blast radius         |
| --------------------------- | ------------------------------------------------- | ----------------------------------------- | -------------------- |
| **A. Local Compose**        | Single node, single tenant                        | Development, evaluation, CI smoke         | The one machine      |
| **B. Shared HA**            | Multi-tenant, logical isolation                   | Standard SaaS production                  | Shared control plane |
| **C. Isolated tenant-cell** | One tenant per cell (dedicated data plane)        | Regulated / high-sensitivity tenants      | One tenant           |
| **D. Hybrid federation**    | Tenant-operated cells federated to a shared plane | Data-sovereignty / on-prem source systems | Per-cell             |

---

## 2. Option A — Local Compose

**What it is.** `docker compose` bringing up API, worker, projector, PostgreSQL, NATS JetStream, and
the policy engine on one host. Deterministic seed fixtures load a representative tenant.

**Component profile.** All components co-located; single replica each; ephemeral volumes by default.

**Scaling.** None — this is a single-node profile. It is sized for correctness, not load.

**Data residency.** All data on the developer's machine; no external egress.

**Assurance limitations.**

- No high availability; a single failure stops the stack.
- Not a security boundary — do not place real personal data here.
- Performance/availability NFRs (NFR-001, NFR-006, NFR-007) are **not** asserted at this scale;
  use the k6 profiles (`tests/performance/config.ts`) against Option B for acceptance.

---

## 3. Option B — Shared HA (standard production)

**What it is.** A multi-tenant, highly-available deployment on Kubernetes. Tenants share the control
plane with **logical** isolation enforced end-to-end.

**Component profile.**

| Component                            | Replicas                          | Notes                                            |
| ------------------------------------ | --------------------------------- | ------------------------------------------------ |
| API (command/query)                  | ≥3, HPA                           | Stateless; OIDC at the edge                      |
| Worker (reconciliation, controllers) | ≥2, HPA                           | Idempotent; continuity leases ≤ 15 min (NFR-012) |
| Projector (read models)              | ≥2                                | Rebuildable from events                          |
| PostgreSQL                           | Primary + ≥1 sync replica         | Authoritative; WAL archiving on                  |
| NATS JetStream                       | 3-node cluster                    | At-least-once; idempotent consumers              |
| Policy engine (PDP)                  | ≥2                                | Fails **closed** if unavailable                  |
| Object store                         | External, versioned + object-lock | Content-addressed evidence                       |

**Scaling.** Horizontal on API/worker/projector via HPA against the NFR budgets (interactive p95
< 3 s; 10k-item reconciliation < 2 min for 95% of runs; 100k-reference export < 15 min). Acceptance
scale: 100,000 governed assets, 10,000 active work items, 500 concurrent users (see
`tests/performance/acceptance.ts`).

**Data residency.** Region-pinned cluster + storage. Cross-tenant isolation is exercised
adversarially by `tests/security/tenant-isolation-matrix.test.ts` (T275). Residency is at the
**region** granularity; a single shared plane cannot satisfy per-tenant _national_ isolation — use
Option C or D for that.

**Assurance limitations.**

- Isolation is logical, not physical; the residual side-channel risk (RR-3 in the threat model) is
  accepted at the documented level.
- A control-plane-wide outage affects all tenants (blast radius) until DR completes (T289).

---

## 4. Option C — Isolated tenant-cell

**What it is.** A dedicated data plane (its own PostgreSQL, NATS, object store, and keys) per
tenant, orchestrated by a shared control-plane operator. Physical isolation between tenants.

**Component profile.** Same components as Option B, but **one stack per tenant cell**; keys and
buckets are per-cell (never shared). The shared operator provisions and upgrades cells but holds no
tenant data.

**Scaling.** Scale per cell independently. Cell density per node is a cost/isolation trade-off;
regulated tenants get dedicated nodes.

**Data residency.** Per-cell region/nation pinning — each tenant's data plane can live in a
distinct jurisdiction. Satisfies strict residency requirements Option B cannot.

**Assurance limitations.**

- Higher operational cost and upgrade fan-out (N cells to patch).
- Cross-cell analytics are not possible without an explicit, lawful, access-filtered export
  (`packages/application/src/portable-export.ts`, T287).

---

## 5. Option D — Hybrid federation

**What it is.** Tenant-operated cells (e.g. on-prem, or in the tenant's own cloud, close to their
source systems) federate to a shared governance plane. The tenant keeps custody of raw source data;
the shared plane holds canonical governance records, audit, and evidence metadata under the tenant's
policy.

**Component profile.** A lightweight **edge adapter** runs in the tenant's environment (discovery +
evidence capture), authenticating with workload identity; the shared plane runs the full component
set. Evidence blobs may remain tenant-side with only content-addressed **metadata** federated.

**Scaling.** Edge adapters scale with the tenant's source estate; the shared plane scales as Option B.

**Data residency.** Strongest residency story: raw data and (optionally) evidence blobs never leave
the tenant's jurisdiction; only least-disclosure metadata crosses the boundary (see the threat
model's least-disclosure decisions).

**Assurance limitations.**

- End-to-end assurance depends partly on the tenant-operated edge; the shared plane can only attest
  to what it receives. Gaps in edge coverage surface as **freshness/coverage** banners, never as
  false completeness.
- Network partitions between edge and plane degrade **visibly** and safely (see
  `tests/resilience/chaos.test.ts`, T290); they do not silently stall governance.

---

## 6. Choosing an option

| If you need…                                          | Choose |
| ----------------------------------------------------- | ------ |
| To try it / develop                                   | A      |
| Standard multi-tenant SaaS with HA                    | B      |
| Physical per-tenant isolation or per-nation residency | C      |
| Data sovereignty with tenant-custodied source data    | D      |

---

## 7. Cross-option guarantees & limits

**Always guaranteed:** authoritative PostgreSQL + audit ledger; fail-closed authorization;
tamper-evident audit with signed checkpoints; content-addressed immutable evidence; idempotent
at-least-once eventing; explicit freshness/coverage; 4-hour recovery objective (NFR-008).

**Never claimed:** certification of the deployment (the platform provides audit-_readiness_, not a
certificate — see `tests/fixtures/audit-readiness/`, T292); performance NFRs at Option A scale; and
protection against a compromise of the tenant's own IdP or KMS custody (threat model RR-1, RR-2).
