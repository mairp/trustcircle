# Threat Model — Governance Control Plane

Phase 9 · T286 · GAR-010. A STRIDE-oriented threat model for the TrustCircleAI Governance Control
Plane. It enumerates **assets**, **trust boundaries**, **threats**, **mitigations**, **residual
risks**, and the **privacy / least-disclosure** decisions that constrain what the platform stores
and reveals. Mitigations reference the shipped controls and their release gates so each claim is
verifiable, not aspirational.

---

## 1. Assets

| #   | Asset                                                                       | Sensitivity    | Authoritative store                      |
| --- | --------------------------------------------------------------------------- | -------------- | ---------------------------------------- |
| A1  | Canonical governance records (inventory, decisions, controls, policies)     | High           | PostgreSQL                               |
| A2  | Tamper-evident audit ledger (accountability for every consequential action) | Critical       | Append-only ledger + signed checkpoints  |
| A3  | Evidence blobs & metadata (provenance, retention, legal holds)              | High           | Content-addressed immutable object store |
| A4  | Signing keys (ed25519 checkpoint keys, HMAC manifest keys)                  | Critical       | KMS / workload identity                  |
| A5  | Tenant boundary metadata (who may see what)                                 | High           | PostgreSQL + policy engine               |
| A6  | Personal data inside evidence / audit reason text                           | High (privacy) | Object store / ledger                    |
| A7  | Published contracts & client packages                                       | Medium         | `packages/contracts`                     |

---

## 2. Trust boundaries

```
 [ Human users / approvers ]           [ Adapters / source systems ]
            │  (OIDC)                             │  (workload identity)
            ▼                                     ▼
  ┌───────────────────────────── TB1: external ⇄ control plane ─────────────────────────────┐
  │                                                                                          │
  │   API (command/query)  ──TB2: service ⇄ policy engine (PDP)──▶  Policy decision point    │
  │        │                                                                                 │
  │        ▼                                                                                 │
  │   Application core ──TB3: app ⇄ persistence──▶  PostgreSQL (authoritative)               │
  │        │                                                                                 │
  │        ├──TB4: app ⇄ audit ledger──▶  Append-only ledger + signed checkpoints            │
  │        ├──TB5: app ⇄ evidence store──▶  Immutable content-addressed object store         │
  │        └──TB6: app ⇄ event bus──▶  NATS JetStream (at-least-once, idempotent consumers)  │
  │                                                                                          │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
                                    │  TB7: tenant ⇄ tenant (logical isolation)
```

- **TB1 external ⇄ control plane** — all external callers authenticate (OIDC for humans, workload
  identity for adapters). Untrusted input crosses here.
- **TB2 service ⇄ PDP** — authorization decisions are externalized to the policy engine; the app
  fails closed if the PDP is unavailable.
- **TB3 app ⇄ persistence** — the authoritative record boundary.
- **TB4 app ⇄ audit ledger** — the accountability boundary; writes are append-only and
  independently verifiable.
- **TB5 app ⇄ evidence store** — immutability + provenance boundary.
- **TB6 app ⇄ event bus** — delivery boundary; consumers are idempotent.
- **TB7 tenant ⇄ tenant** — the cross-tenant isolation boundary, exercised adversarially by
  `tests/security/tenant-isolation-matrix.test.ts` (T275).

---

## 3. Threats, mitigations, residual risk (STRIDE)

### 3.1 Spoofing

- **T-S1** Forged user or adapter identity crossing TB1.
  - _Mitigation:_ OIDC for humans, workload identity for adapters; no static shared secrets on the
    request path.
  - _Residual:_ compromised IdP or workload identity. Bounded by short-lived tokens and per-tenant
    scoping (TB7).

### 3.2 Tampering

- **T-T1** Silent rewrite of an audit record (A2).
  - _Mitigation:_ per-ledger hash chain with genesis sentinel and monotone gap-free sequences; the
    verifier re-derives every digest and never trusts the stored digest. Signed ed25519 checkpoints
    make truncation/replacement tamper-evident. Detection opens a critical incident and **freezes**
    consequential/destructive actions in the affected tenant (fail-closed). Gate:
    `tests/e2e/audit-tamper.spec.ts` (T280).
  - _Residual:_ an attacker with both the signing key (A4) and write access could forge a
    self-consistent chain. Bounded by KMS custody, key rotation, and external anchoring of
    checkpoint roots.
- **T-T2** Mutation of an evidence blob (A3).
  - _Mitigation:_ content-addressed immutable store; verification by content address detects any
    byte change (`packages/evidence/src/object-store.ts`; gate `tests/recovery/canonical-restore.test.ts`).
  - _Residual:_ loss of the original hash record; mitigated by including digests in signed manifests.
- **T-T3** Schema/contract drift introducing a breaking change (A7).
  - _Mitigation:_ additive-only same-major evolution with a cross-major breaking-change guard, and
    expand→migrate→verify→contract database evolution. Gate: `tests/migrations/compatibility.test.ts` (T278).

### 3.3 Repudiation

- **T-R1** An actor denies performing a consequential action.
  - _Mitigation:_ every consequential/destructive action writes a fully-accountable audit record
    (actor, accountable owner, reason, source/target state, policy & control versions, scope,
    timing, correlation, outcome). Non-repudiation rests on the tamper-evident chain (A2).
  - _Residual:_ actions taken with legitimately-issued but misused credentials; bounded by SoD and
    least privilege.

### 3.4 Information disclosure

- **T-I1** Cross-tenant data leakage across TB7.
  - _Mitigation:_ adversarial isolation matrix across application, database, event, cache, object,
    key, credential, and adapter layers. Gate: `tests/security/tenant-isolation-matrix.test.ts` (T275).
  - _Residual:_ a novel side channel not covered by the matrix; bounded by defense-in-depth and the
    least-disclosure decisions in §5.
- **T-I2** Over-disclosure of personal data (A6) in exports or dashboards.
  - _Mitigation:_ least-disclosure defaults (§5); scoped, access-filtered exports with signed
    manifests (`packages/application/src/portable-export.ts`, T287).

### 3.5 Denial of service

- **T-D1** Dependency outage, queue overflow, evidence-store failure, PDP failure, source failure,
  or partial network partition.
  - _Mitigation:_ safe, visible degradation — the affected scope is marked degraded rather than
    reporting false health; bounded retries with backoff and no duplicate governed effect. Gate:
    `tests/resilience/chaos.test.ts` (T290). PDP failure fails **closed** (deny), never open.
  - _Residual:_ sustained full-region outage; addressed by the DR objectives in
    `deploy/kubernetes/recovery/runbook.md` (T289) and NFR-008 (4-hour recovery).

### 3.6 Elevation of privilege

- **T-E1** A caller performs an action beyond its grant, or bypasses separation of duties.
  - _Mitigation:_ externalized authorization (TB2), SoD enforcement, and destructive-action safety
    gates (audit freeze on integrity incidents).
  - _Residual:_ misconfigured policy; bounded by policy tests and change control.

---

## 4. Privacy

- **Data minimization.** Only data required to govern (identify, decide, and prove) is stored.
  Free-text reason fields carry a warning that they must not contain unnecessary personal data.
- **Purpose limitation.** Evidence and audit records are used for governance and audit-readiness
  only; they are not repurposed for analytics without a separate lawful basis.
- **Retention.** Personal data inherits the longest applicable **approved** retention policy;
  absence of a policy is a **visible gap** requiring action, not indefinite retention (T281).
- **Right-to-erasure vs. immutability.** Audit records are immutable for integrity. Erasure of
  personal data is achieved via evidence **disposition** (crypto-shred / delete) under authorized
  release and legal-hold checks, leaving a signed disposition record — the _fact_ of erasure is
  itself auditable without retaining the erased content.

---

## 5. Least-disclosure decisions

| Decision                                                                                   | Rationale                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Dashboards expose **freshness and partial coverage** explicitly                            | A viewer must never mistake stale/partial data for authoritative current state.                  |
| Exports are **tenant-scoped and access-filtered** with a signed manifest                   | Prevents cross-tenant and over-broad disclosure; the manifest proves exactly what was disclosed. |
| Error envelopes carry an `audit_event_id` and safe next actions but **no internal detail** | Enough to act and to trace, without leaking implementation or other tenants' data.               |
| Server URLs and broker hosts in published specs are `*.invalid` placeholders               | Published contracts disclose shape, not deployment topology.                                     |
| Reason text is treated as **potentially sensitive** and minimized                          | Reduces incidental personal-data exposure in the ledger.                                         |
| PDP failure **denies** rather than reveals a default-allow path                            | Fail-closed prevents disclosure via degraded authorization.                                      |

---

## 6. Residual-risk register (summary)

| ID   | Residual risk                      | Owner                    | Compensating control                                          |
| ---- | ---------------------------------- | ------------------------ | ------------------------------------------------------------- |
| RR-1 | Signing-key compromise (A4)        | CISO                     | KMS custody, rotation, external anchoring of checkpoint roots |
| RR-2 | IdP / workload-identity compromise | CISO                     | Short-lived tokens, per-tenant scope, anomaly alerting        |
| RR-3 | Novel cross-tenant side channel    | Security lead            | Defense-in-depth, isolation matrix expansion                  |
| RR-4 | Sustained multi-region outage      | SRE lead                 | DR runbook (T289), 4-hour recovery objective (NFR-008)        |
| RR-5 | Policy misconfiguration → EoP      | Governance product owner | Policy tests, change control, SoD                             |

All residual risks are accepted at the documented level and reviewed at each release via the
release-review checklist (`docs/governance/release-review.md`, T274).
