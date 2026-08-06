# Runbook — Demonstrate Compliance and Audit Readiness: standards registry, applicability with independent review, obligation/control coverage, risk & impact treatment, internal audit, management review, corrective action, reproducible signed audit export, and truthful claim boundaries

> **Audience.** The governance/compliance officer, the independent reviewer, the control owner, the
> internal auditor, and the external assessor who **operate the compliance-assurance surface** — the
> estate where a tenant reconstructs, for **an exact scope and an exact instant**, which published
> standard obligations apply, which controls and evidence cover them, where the gaps are, and what an
> auditor may be shown — **without ever representing internal readiness as external conformity,
> accreditation, or certification.**
>
> **What this runbook is.** The operating procedure for the audit-readiness surface. It describes what a
> human must do, what the platform enforces automatically, and — critically — the invariants that keep
> every claim **truthful and bounded**: publication facts are immutable and versioned; an applicability
> decision is not active until an **independent** reviewer (never the proposer) approves it with a
> reason; a non-applicability decision **expires** and its gap **reopens** rather than lingering as a
> silent exemption; coverage separates design / implementation / operating-effectiveness / evidence-
> sufficiency / readiness / assessment / certification and **never infers a current result from stale
> evidence**; the overall claim boundary reaches `certified` **only** when a verifiable external
> certificate is displayable; and an audit export is **reproducible for an exact scope and instant**,
> **tenant-authorized**, **chain-of-custody linked**, **signed**, and lists **every gap explicitly**.
>
> **Priority.** This surface is **User Story 5 (P2)** of the governance control plane — "Demonstrate
> Compliance and Audit Readiness."

This runbook documents the behavior implemented and verified in:

- `db/migrations/0050_compliance.sql` — standards publications/clauses, applicability decisions and
  versions, obligations, control mappings, control-evaluation facts, exceptions, risk treatments,
  impact assessments, internal-audit programmes, management reviews, corrective actions, external
  certifications, and audit-export operations.
- `packages/domain/src/compliance.ts` — the compliance aggregates and their oracles: the vocabularies
  (`MaterialType`, `DutyClass`, `ClaimBoundary`, `AssessmentKind`, `AssessmentResult`,
  `CertificationStatus`, `ResponsibilityParty`), the immutable publication/clause factories
  (`makeStandardPublication`, `makeClauseVersion`, `publicationSupersedes`, `publicationDutyClass`),
  and the applicability lifecycle (`applicabilityIsActive`, `nonApplicabilityReopensGap`,
  `applicabilityVersionSupersedes`).
- `packages/application/src/standards-import.ts` — pure import of the central ISO/IEC 4200x registry
  seed into validated, immutable aggregates (`importStandardsSeed`, `registryUuid`,
  `StandardsImportError`) — deterministic, records **facts only**, never a certification claim (T206
  wires the operator import endpoint on top of this).
- `packages/application/src/applicability-service.ts` — `proposeApplicability` / `reviewApplicability`
  and the independence-verdict evaluation that gates activation on an independent, reason-backed review
  (FR-052, FR-053).
- `packages/authz/src/compliance-review.ts` — proposer/reviewer/control-owner independence, mandatory
  review reasons, and the 42006 certification-body classification (FR-032, FR-055).
- `packages/application/src/control-mapping-service.ts` — obligations, shared responsibility, control
  mappings, evidence expectations, review dates, and historical versions (FR-031, FR-054).
- `packages/application/src/coverage-engine.ts` — `reconstructCoverage` / `coverageReferenceCount`:
  design, implementation, operating-effectiveness, evidence-sufficiency, readiness, assessment,
  certification, and **gap** states computed **separately**; the overall `claimBoundary` capped at
  readiness unless a certification is displayable; stale evidence surfaced as a `stale_evidence` gap and
  **never** inferred as current (FR-054, FR-055, SC-012, SC-013).
- `packages/application/src/exception-service.ts` — expiring exceptions with risk authority,
  compensating controls, review, **no silent renewal**, and verified closure (FR-054).
- `packages/application/src/risk-treatment.ts` — risk assessment, treatment options, owner, resources,
  milestones, approval, residual-risk acceptance, monitoring, and reassessment (FR-034).
- `packages/application/src/impact-assessment.ts` — ISO/IEC 42005 impact assessments, affected parties,
  uncertainty, mitigations, residual impacts, approval, access, and material-change reassessment
  (FR-034).
- `packages/application/src/internal-audit.ts` — internal-audit programmes: competence/independence,
  scope, criteria, sampling, findings, reporting, follow-up, and records (FR-034, FR-035).
- `packages/application/src/management-review.ts` — management-review cadence, participants, required
  inputs, decisions, resources, owners, due dates, outputs, and follow-up (`reviewCadenceLapsed`)
  (FR-034, FR-035).
- `packages/application/src/corrective-action.ts` — nonconformity, correction, root cause, corrective
  action, effectiveness review (`reviewEffectiveness`), recurrence, closure, reopening, and improvement
  intake (FR-035).
- `packages/application/src/external-assurance.ts` — requires issuer, certificate ID, scope, validity,
  status, and **verifiable external evidence** before an external certification may be displayed
  (FR-055, SC-012).
- `packages/projections/src/compliance-projector.ts` — the read model: compliance coverage, audit
  trace, standards versions, applicability, mappings, control state, evidence, exceptions, and gaps,
  with a stable `snapshotDigest` for reconstruction (FR-051, SC-013).
- `apps/api/src/routes/standards.ts` — `GET /v1/standards/publications` (the global versioned
  publication registry) and `POST /v1/standards/publications/import` (the **platform-admin-only**
  future-4200x import affordance, composing `importStandardsSeed`) (T206, FR-031, FR-051).
- `apps/api/src/routes/applicability.ts` — applicability propose/review/change/expire endpoints with
  authority, ETags, reasons, and audit outcomes (T207).
- `apps/api/src/routes/compliance.ts` — scoped compliance coverage, evidence-metadata, and audit-export
  request endpoints (T208): `GET /v1/compliance/coverage`, `GET /v1/evidence/{evidenceId}`,
  `POST /v1/audit/exports`.
- `apps/command-worker/src/audit-export.ts` — the asynchronous, reproducible **audit-export worker**
  (T209): coverage reconstructed as-of an exact instant, evidence references authorized to the tenant,
  a tamper-evident chain of custody, every coverage gap listed verbatim, a truthful claim boundary, and
  an HMAC-signed manifest — committed through the shared transactional unit-of-work (FR-051..056,
  SC-012, SC-013, SC-022).
- `apps/web/src/features/compliance/CoverageView.tsx`, `ApplicabilityReview.tsx`,
  `apps/web/src/features/evidence/EvidenceExplorer.tsx`, `apps/web/src/features/audit/AuditExplorer.tsx`,
  and `apps/web/src/features/compliance/claim-labels.ts` — the accessible (WCAG 2.2 AA) operator
  surfaces and the centralized truthful requirement/guidance/duty/readiness/assessment/certification
  labels (T211–T215).

---

## 1. The invariants (what the platform guarantees, and how to verify each)

| #   | Invariant                                                                                                                                                                                                                                                                                                             | Where enforced                                                                                                                                                                                  | How it is verified                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Publication facts are immutable and versioned.** A standard publication records publisher, identifier, exact title, edition, publication date, status, material type, source URI, and registry version — never a conformity claim. Superseding a publication mints a new version; the prior is retained.            | `packages/domain/src/compliance.ts` (`makeStandardPublication`, `publicationSupersedes`), `packages/application/src/standards-import.ts`                                                        | `tests/unit/standards-registry.test.ts` (frozen aggregates, supersession, deterministic import ids)                                                                               |
| 2   | **Applicability requires independent review.** A proposed decision is durable but **not active**; it activates only when an **independent** reviewer (never the proposer, never an incompatible role) approves it with a mandatory reason, producing a superseding version.                                           | `packages/application/src/applicability-service.ts`, `packages/authz/src/compliance-review.ts`, `packages/domain/src/compliance.ts` (`applicabilityIsActive`, `applicabilityVersionSupersedes`) | `tests/unit/applicability-state-machine.test.ts` (proposer≠reviewer, incompatible-role, versioning, rejection ordering)                                                           |
| 3   | **Non-applicability expires; the gap reopens.** A `not_applicable` decision past its review instant reopens its obligation gap rather than persisting as a silent exemption.                                                                                                                                          | `packages/domain/src/compliance.ts` (`nonApplicabilityReopensGap`), `packages/application/src/coverage-engine.ts`                                                                               | `tests/unit/applicability-state-machine.test.ts`, `tests/integration/compliance-coverage.test.ts` (`reopened_non_applicability` gap)                                              |
| 4   | **Coverage states are computed separately, and stale evidence is never inferred as current.** Design, implementation, operating-effectiveness, evidence-sufficiency, readiness, assessment, and certification are distinct; stale evidence surfaces a `stale_evidence` gap and caps the boundary below `ready`.       | `packages/application/src/coverage-engine.ts`                                                                                                                                                   | `tests/integration/compliance-coverage.test.ts` (stale/unmapped/reopened gaps, cross-tenant isolation, evidence windows)                                                          |
| 5   | **Readiness is never certification.** The overall `claimBoundary` reaches `certified` **only** when a verifiable, in-validity external certificate is displayable; an expired certificate never promotes the boundary.                                                                                                | `packages/application/src/coverage-engine.ts`, `packages/application/src/external-assurance.ts`                                                                                                 | `tests/integration/compliance-coverage.test.ts` (ready vs certified vs expired-cert), `tests/contract/compliance-api.contract.test.ts` (claim_boundary enum rejects `accredited`) |
| 6   | **Evidence access is tenant-authorized; bodies are never leaked.** Evidence metadata is returned only to the owning tenant; an unauthorized body is withheld with a notice, never the bodyRef.                                                                                                                        | `apps/api/src/routes/compliance.ts` (`getEvidenceMetadata`), `apps/web/src/features/evidence/EvidenceExplorer.tsx`                                                                              | `tests/contract/compliance-api.contract.test.ts` (envelope is metadata-only), `tests/e2e/compliance-audit-readiness.spec.ts` (body-withheld, no leak)                             |
| 7   | **An audit export is reproducible, authorized, custody-linked, signed, and gap-explicit.** Coverage is reconstructed as-of an exact instant; references are filtered to the tenant (excluded count shown); a tamper-evident custody chain and an HMAC-signed manifest bind the package; every gap is listed verbatim. | `apps/command-worker/src/audit-export.ts`                                                                                                                                                       | `tests/performance/evidence-export.test.ts` (100k-reference scope, access filtering, custody, signature, gaps, 15-minute objective)                                               |

Each invariant carries a **negative control** in its test: a fact whose flip drives the oracle red, so
no assertion passes vacuously.

---

## 2. Operating procedure — the audit package

An **audit package** is the reproducible, signed answer to "for exactly this scope and this window,
show me the coverage, the evidence lineage, and every gap." It is produced asynchronously so a large
scope (up to and beyond 100,000 evidence references) never blocks the request.

**Request (officer).**

1. `POST /v1/audit/exports` with `{ scope, period: { from, to }, reason: { code, text } }`. The route
   validates the wire shape, attaches the tenant + requester identity, and **enqueues** the export — it
   performs no export work inline and returns `202 Accepted` with an `operation_id`.
2. The request is **idempotent**: re-submitting the same scope + period + reason returns the same
   operation (an `idempotent-replay` header marks the replay).

**Processing (platform — `AuditExportWorker`).** 3. Coverage is reconstructed **purely** as-of `reconstructedAt` (default: `period.to`) via
`reconstructCoverage`, so the same inputs + instant always yield a **byte-identical** package
(SC-013). 4. Every candidate evidence reference is **authorized to the export's tenant**; cross-tenant references
are **excluded** and the excluded count is recorded — a visible omission, never a silent one, and
never a leak (FR-053). 5. The in-scope references are folded into an **ordered chain of custody**: each link's `chainDigest`
folds in the prior link's digest, so a reorder or drop breaks the fold (`custodyChainIsIntact`)
(FR-052). 6. Every coverage **gap** is copied into the package **verbatim** — the export never hides, downgrades,
or infers-away a gap; an all-covered scope yields an empty gap list (SC-022). 7. The claim boundary is copied from the engine and **never promoted**; the worker **refuses to sign** a
package whose boundary is `certified` without a displayable certification (FR-055, SC-012). 8. The package body is HMAC-SHA-256 **signed** (`signManifest`); `verifyManifest` re-derives and
constant-time-compares it, so tampering with any covered field is detectable (FR-056). The signed
package is persisted and the operation is committed through the shared transactional unit-of-work (an
operation-state row + the signed-manifest evidence ref + an audit event + an outbox notification,
atomic or not at all).

**Review (auditor).** 9. The auditor opens the **Auditor Trace** surface (`AuditExplorer.tsx`): the exact `from`/`to`/
`reconstructed-at` window, the ledger checkpoint, the reconstruction reference count, the decision /
mapping / finding / remediation tables, the **signed export manifests**, and the **explicit gap
list** — with a standing note that the export is internal readiness evidence, **not** an external
certification claim unless a verifiable certificate is displayed.

---

## 3. Operating procedure — management review and corrective action

**Management review (cadence).**

- A review is due on a fixed cadence; `reviewCadenceLapsed(review, now)` surfaces a lapsed cadence
  rather than silently treating an overdue review as current (`packages/application/src/management-review.ts`).
- A review captures the **required inputs** (audit results, gap/coverage status, exception status, risk
  and impact posture, corrective-action effectiveness), records **decisions** with owners, resources,
  and due dates, and tracks **follow-up** to closure.

**Corrective action (nonconformity → closure).**

- A nonconformity is recorded with its correction, **root cause**, and a corrective action with an
  owner and due date.
- Closure is gated on an **effectiveness review** (`reviewEffectiveness`) — a corrective action is not
  closed merely because it was performed; recurrence **reopens** it
  (`packages/application/src/corrective-action.ts`).
- Improvement opportunities are intake-tracked distinctly from nonconformities.

**Truthfulness throughout.** None of these operations may represent an internal result as external
conformity, accreditation, or certification. Labels and explanatory text come from the single source of
truth `apps/web/src/features/compliance/claim-labels.ts`, whose `assertNoInternalCertificationMislabel`
guard flags any rendered label that would misrepresent internal readiness as external certification.

---

## 4. Evidence manifests (Scenario 9 / Scenario 10)

The acceptance runners in `tests/e2e/scenarios/standards-applicability.ts` bind every User-Story-5
criterion (FR-031..035, FR-051..056, SC-012, SC-013, SC-022) to a durable fact observed through a real
oracle. Their results are emitted as **signed, deterministic** result manifests under
`tests/e2e/scenarios/_evidence/gate7/`:

- **Scenario 9 — standards-applicability & audit-readiness** (node-safe logic runner):
  `scenario9-standards-applicability.manifest.json`, emitted by `emit-manifests.mjs`.
- **Scenario 10 — compliance-surfaces accessibility** (WCAG 2.2 AA over the shipped `.tsx` presenters):
  `scenario10-compliance-accessibility.manifest.json`, emitted by `emit-scenario10.test.ts` under the
  sibling `vitest.emit.config.ts` (Node's `--experimental-strip-types` refuses `.tsx`, so the
  accessibility manifest must be produced under vitest).

Both manifests are canonicalised (sorted-key JSON) and hashed (sha256) into a top-level
`manifestDigest`; the runners are deterministic (no clock, no randomness), so re-running over the same
fixture reproduces byte-identical digests — the non-repudiation property.

```
# Emit (authoring step)
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate7/emit-manifests.mjs
TC_EMIT=1 npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.emit.config.ts

# Drift-check (verification step — fails if a runner/fixture/presenter changed the signed result)
node --experimental-strip-types tests/e2e/scenarios/_evidence/gate7/emit-manifests.mjs --check
npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.emit.config.ts

# (The T217 acceptance-runner WITNESS — distinct from the emitter — runs under vitest.config.ts)
npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.config.ts

# (Durable NON-VACUITY control — proves a broken presenter would go RED, so the green
#  witness is meaningful and not vacuously passing)
npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.nonvacuity.config.ts
```

### Non-vacuity control (durable)

A green accessibility witness only means something if a _broken_ presenter would go RED.
`nonvacuity.test.ts` (run under `vitest.nonvacuity.config.ts`) renders the SHIPPED CoverageView presenter
over the honest model (positive control → `ok`, 0 findings) and over two DEGRADED renders — a `ready`
boundary mislabelled as "certified" with its not-certified note scrubbed, and an uncovered obligation
whose coverage-gap marker is stripped — and asserts the oracle returns findings in each. This is a
committed, re-runnable artifact (not a throwaway probe), so the discrimination property is independently
verifiable.

---

## 5. Checkpoint

> **Coverage can be reconstructed for an exact scope and time. No mapping, artifact, or internal
> readiness result is represented as conformity, accreditation, or external certification.**

Reconstruction is `reconstructCoverage` over a scope + instant, mirrored by the projector's
`snapshotDigest` and the audit-export worker's reproducible package. The truthful-boundary invariant is
enforced in the coverage engine (`claimBoundary` capped at readiness unless a certificate is
displayable), in the external-assurance service (a certificate requires issuer, id, scope, validity,
status, and verifiable evidence), in the audit-export worker (refuses to sign a promoted package), and
in the label layer (`assertNoInternalCertificationMislabel`).
