# Contributing to TrustCircleAI

Thank you for helping. TrustCircleAI governs consequential decisions, so changes are held to an
explicit standard: authority, tenant isolation, audit and evidence integrity are never traded for
convenience. This guide covers setup, the checks every change must pass, and how architectural
changes are governed.

- Read the [architecture overview](docs/architecture/overview.md) and the
  [project constitution](.specify/memory/constitution.md) before proposing a material change.
- Local environment details: [development bootstrap](docs/development/bootstrap.md).
- Report security issues privately to the maintainers rather than in a public issue.

## Development setup and verification

Use Node.js 22 and npm 10. Install the locked workspace dependencies, then run focused checks while
developing and the governed PR/release gates before claiming completion.

```bash
npm ci
npm run contracts:validate
npm run contracts:check
npm run typecheck
npm run lint
npm run format
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:security
npm run verify:pr
npm run verify:release
```

Release and assurance checks are separate from ordinary build success:

```bash
npm run evidence:verify
npm run test:audit-readiness
npm run verify:release:gate
```

The command result and covered evidence determine the outcome. Do not reinterpret a held or
indeterminate gate as passing.

Before opening a pull request, run `npm run verify:pr`. CI runs the same domains plus a secret scan,
provisioning checks, and axe accessibility scans of the live routes (`npm run test:a11y:live`,
which needs a local Chromium).

## Pull requests

- Keep each pull request to one coherent change, with tests that fail without it.
- Never commit secrets: `gitleaks` runs on every push, and instance secrets belong in `.provision/`
  (git-ignored).
- Pull requests to `main` merge through the Mergify queue once `verify (required)` passes and a
  reviewer has approved.

## Architecture governance

### Source-of-truth order

When artifacts disagree, resolve the conflict in this order and block the affected release until they
are synchronized:

1. The [TrustCircleAI Constitution](.specify/memory/constitution.md) defines non-negotiable principles
   and supersedes local conventions.
2. Approved feature specifications, data models, and versioned contracts define intended behavior and
   boundary semantics. Feature specifications are maintained privately by the core team; the
   published versioned contracts live in [`contracts/`](contracts/).
3. Delivery plans and task breakdowns define the approved delivery approach and sequence.
4. Code, migrations, tests, traceability, and retained evidence demonstrate what is implemented.
5. The roadmap defines prioritization and continuation; it cannot grant authority or waive a gate.

An implementation discrepancy is not resolved by silently changing a claim. Update the governing
artifact through review, or change the implementation and evidence to satisfy it.

### Required change workflow

Every material architecture change must:

1. Identify inventory and deployment boundaries, affected tenants, authoritative data, consequential
   actions, human owners, failure behavior, compatibility, rollback, evidence, and observability.
2. Update the feature specification and check it against the project constitution before design.
3. Record design decisions, the data model, and versioned contracts; check against the constitution
   again after design.
4. Plan dependency-ordered tasks, including negative-path, boundary, migration, resilience,
   accessibility, and evidence work.
5. Implement behind domain/application ports. Keep vendor and transport details at adapter or
   infrastructure boundaries.
6. Update traceability and implementation evidence with genuine command outputs and durable witnesses.
7. Synchronize related specifications and integration notes. Update the constitution or shared
   templates only when the change alters project-wide governance, not for a feature-local exception.
8. Obtain independent review where authority, tenant isolation, evidence/audit integrity, compliance
   claims, destructive remediation, or external contracts are affected.

### Review triggers and mandatory evidence

| Change area                               | Mandatory architectural proof before release                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consequential action or delegation        | Explicit human owner, SoD matrix, self-approval denial, reason and expiry rules, policy-version binding, accepted and rejected audit evidence    |
| Tenant, identity, or access boundary      | Cross-tenant negative tests, server-side role filtering, row-level policy evidence, workload identity and break-glass behavior                   |
| Audit or evidence custody                 | Atomicity, hash/provenance verification, access and retention behavior, legal-hold/disposition checks, failure-path preservation                 |
| Adapter or remote mutation                | Signed manifest, contract/conformance tests, least privilege, idempotency, timeout/lost-ack reconciliation, bounded retry and rollback behavior  |
| Public contract or event                  | Semantic-version impact, generated-contract check, consumer compatibility, ordering/unknown-field behavior, migration and rollback               |
| Read model, search, analytics, or copilot | Authorization-before-load, disclosure allowlist, freshness/partial coverage, tenant isolation, privacy negatives, citation and no-mutation proof |
| Compliance or assurance claim             | Exact scope, applicability and owner, evidence sufficiency, independent review, and wording that distinguishes readiness from certification      |
| Release or deployment topology            | Approved artifact identity, configuration/schema compatibility, health plus governance gates, rollback rehearsal, retained release evidence      |

> **Release rule:** required approval, ownership, tests, evidence, monitoring, rollback,
> reconciliation, migration, or standards mapping that is missing, stale, failing, deferred, or
> indeterminate blocks the affected release.
