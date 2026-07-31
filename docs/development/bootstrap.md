# Development Bootstrap: WSL Setup, Test Prerequisites, Safe Fixtures, and Standard Commands

This is the authoritative developer bootstrap guide for the TrustCircleAI Governance
Control Plane. It documents how to bring the repository up on **Linux/WSL**, the
prerequisites the local test suite needs, the **safe fixture rules** that keep production
data and secrets out of the validation path, and the **standard commands** used across
development and the release/PR gates.

It is grounded in and consistent with the executable acceptance contract in
[`specs/001-governance-control-plane/quickstart.md`](../../specs/001-governance-control-plane/quickstart.md)
and in the real `package.json` script surface. The standard-command table below is a
**supported consumer surface** (`VO-ec575c4ce42b548bfb4d`): every command it names must
resolve to a real, defined npm script, and changes to it must preserve consumers or ship
deprecation/migration/rollback/notice/compatibility evidence (see **Change discipline**).

---

## 1. WSL bootstrap

The target platform is Linux containers; local validation uses Docker Compose inside
**WSL** (`specs/001-governance-control-plane/plan.md` §Target Platform). Run every command
from a Linux/WSL shell, never from a Windows (PowerShell/CMD) prompt, so that path
semantics, file permissions, and line endings match CI.

```bash
# From your WSL distribution (e.g. Ubuntu on WSL2):
cd <repo-root>
```

### 1.1 Toolchain (pinned)

- **Node.js 22** and **npm 10** — the root `package.json` pins
  `engines.node = ">=22.0.0 <23.0.0"`, `engines.npm = ">=10.0.0"`, and
  `packageManager = "npm@10.9.8"`. TypeScript sources run directly under Node 22 type
  stripping (`--experimental-strip-types`); no separate transpile step or `tsx` is
  required for the tooling suites.
- Use a version manager (e.g. `nvm`) **inside** WSL so the Node binary is the WSL-native
  one, not a Windows interop shim.

Verify the toolchain before bootstrapping:

```bash
node --version   # expect v22.x
npm --version    # expect 10.x
```

### 1.2 WSL host requirements

- At least **8 CPU cores, 16 GiB RAM, and 30 GiB free disk** for the full local suite
  (mirrors the quickstart prerequisites). Configure these in `.wslconfig` on the Windows
  host if the defaults are lower.
- **Docker Engine with Compose v2**, reachable from WSL (Docker Desktop WSL integration or
  a native Docker Engine install inside the distribution). Compose is only needed for the
  full end-to-end stack (Section 4); the unit/contract/tooling gates run without it.
- Keep the repository on the **Linux filesystem** (`/home/...`), not on a `/mnt/c` Windows
  mount — Windows mounts are slow and change file-permission/inode semantics that the
  boundary and evidence tests depend on.

### 1.3 Install (deterministic)

```bash
npm ci
```

`npm ci` performs a clean, lockfile-exact install of every workspace member
(`packages/*`, `apps/*`, `adapters/*`). It is deterministic: the same `package-lock.json`
always yields the same tree, so CI and local installs match.

---

## 2. Test prerequisites

There are two tiers of local validation. Know which tier a command belongs to before you
run it.

### 2.1 Tier A — no containers required

These run against the source tree directly after `npm ci`, with **no Docker, database, or
network**. They are the fast inner loop and the core of the PR gate:

- `lint`, `format`, `typecheck`
- `contracts:validate`, `contracts:generate`, `contracts:check`
- `test:unit`, `test:contract`, `test:integration`
- `test:boundaries`, `test:evidence`, `test:sod`, `test:tooling`
- `test:performance` (self-check of the k6 profiles; no load is issued without a real
  `k6 run`)
- `evidence:verify`

They require only Node 22 + npm 10. This is what `npm run verify:pr` and
`npm run verify:release` exercise for their non-container legs.

### 2.2 Tier B — full stack (Docker Compose in WSL)

These require the isolated validation stack from the quickstart — PostgreSQL 16, NATS
JetStream, an S3-compatible immutable test store, OPA, an OpenTelemetry Collector, the
TrustCircle API/workers/web, and deterministic stub adapters:

- `db:migrate`, `fixtures:seed`, `health`
- `test:e2e`, `test:accessibility`
- `test:migrations`, `test:resilience`, `test:recovery`

Bring the stack up and down with Docker Compose (Section 4). Live Kanban/workflow tests are
**opt-in and read-only** by default.

### 2.3 Environment configuration

- Local ports and per-run configuration come from Compose or from a git-ignored
  `.env.e2e.local` (Section 3). Never commit a populated `.env`; only `.env.example` is
  tracked.
- Secrets are supplied as **references** (`env:` / `file:` / `vault:` / `awssm:` /
  `gcpsm:` / `k8s:`), never inline literals — enforced by
  `packages/application/src/config/environment.ts`.

---

## 3. Safe fixture rules

The E2E/validation path uses **disposable fixtures only**. These rules are non-negotiable
and mirror the quickstart's fixture and teardown contract:

1. **No production data or credentials, ever.** The E2E profile generates ephemeral
   tenants, identities, signing keys, source tokens, and evidence buckets. Production
   evidence, source data, or credentials must never be mounted into the seed, run, or
   teardown paths.
2. **Fixtures are secret-free output.** `npm run fixtures:seed -- --profile e2e` prints
   tenant/user/source IDs **without secrets**. If a fixture needs a credential, it uses a
   secret **reference**, never an inline literal.
3. **Disposable by construction.** Fixtures are seeded into the isolated stack and torn
   down with `--volumes --remove-orphans`. Nothing a fixture creates is retained after
   teardown.
4. **Retained fixtures are checked in and governed.** Golden/contract test fixtures that
   _are_ retained (under `tests/**/fixtures/**`, `**/*.fixture.*`, `**/*.golden.*`, the
   canonical contracts under `specs/**`, and the signed `evidence/manifest.json`) are
   explicitly **re-included** by `.gitignore` so no broad disposable pattern can sweep them
   out. They are a supported consumer surface — treat changes to them under the change
   discipline in Section 6.
5. **Isolation from real sources.** Live Kanban/workflow integrations are opt-in and
   read-only; a fixture run must not perform a mutating call against a real external
   source.

---

## 4. Full-stack lifecycle (Docker Compose, WSL)

Bring the isolated stack up, migrate, seed disposable fixtures, and check health:

```bash
docker compose -f deploy/compose/control-plane.yml --profile e2e up -d --build --wait
npm run db:migrate
npm run fixtures:seed -- --profile e2e
npm run health
```

Tear it down (disposable fixtures + volumes are destroyed):

```bash
docker compose -f deploy/compose/control-plane.yml --profile e2e down --volumes --remove-orphans
```

`npm run health` reports, for every component: identity, owner, version, last
attempt/success, health, dependency state, retry state, evidence, and safe next actions.

---

## 5. Standard commands

Every command below is a defined npm script in the root `package.json`. The
machine-readable table (parsed by `tests/tooling/bootstrap-doc.test.mjs`) is the contract:
each `script` name here must exist as a real `package.json` script, so this doc can never
silently drift from the command surface it documents.

```commands
npm ci | install | Deterministic, lockfile-exact install of all workspace members (Tier A prerequisite)
lint | quality | eslint . — dependency-boundary + type-aware lint (Tier A)
format | quality | prettier --check . — formatting gate (Tier A)
typecheck | quality | tsc --build — strict project-reference typecheck (Tier A)
contracts:validate | contracts | Structural validation + unresolved-placeholder rejection + generated-diff gate (Tier A)
contracts:generate | contracts | Regenerate OpenAPI/AsyncAPI/JSON-Schema types deterministically (Tier A)
contracts:check | contracts | Fail on generated-type drift vs source contracts (Tier A)
test:unit | test | Vitest unit project (Tier A)
test:contract | test | Vitest contract project — consumer contract tests (Tier A)
test:integration | test | Vitest integration project (Tier A)
test:security | test | Vitest security project (Tier A)
test:boundaries | test | Workspace dependency-boundary acceptance tests (Tier A)
test:evidence | test | Evidence/retention acceptance tests (Tier A)
test:sod | test | Separation-of-duties acceptance tests (Tier A)
test:tooling | test | Config/tooling/doc acceptance tests (Tier A)
test:performance | test | k6 acceptance-scale + fault-injection profile self-check (Tier A)
test:migrations | test | Vitest migration project — expand/migrate/contract DB changes (Tier B)
test:resilience | test | Vitest resilience project (Tier B)
test:recovery | test | Vitest recovery project — disaster-recovery scenarios (Tier B)
test:e2e | test | Playwright end-to-end scenarios against the stack (Tier B)
test:accessibility | test | Playwright axe / keyboard / 400%-reflow accessibility project (Tier B)
db:migrate | stack | Apply ordered expand→migrate→contract PostgreSQL migrations (Tier B)
fixtures:seed | stack | Seed disposable E2E fixtures; prints IDs without secrets (Tier B)
health | stack | Report per-component identity/health/owner/next-action (Tier B)
evidence:verify | evidence | Verify the signed evidence manifest against on-disk contracts (Tier A)
verify:pr | gate | Full PR-validation gate: contracts/generated/lint/types/tests/evidence (Tier A)
verify:release | gate | Full release gate over the supported-contract + test surface (Tier A)
```

### 5.1 Inner-loop cheat sheet

```bash
# Fast local validation before pushing (no containers):
npm run lint && npm run typecheck && npm run test:unit && npm run test:tooling

# Reproduce the PR gate locally (no containers):
npm run verify:pr

# Full release gate:
npm run verify:release
```

---

## 6. Change discipline (compatibility obligation)

This document — specifically its `commands` table and the fixture/prerequisite rules — is a
supported consumer surface under **`VO-ec575c4ce42b548bfb4d`**: _changes to inventory,
decisions, lifecycle states, source contracts, evidence, mappings, and exports MUST
preserve supported consumers or provide approved deprecation, migration, rollback, notice,
and compatibility evidence._

Therefore:

1. **Every `commands`-table entry must name a real `package.json` script.** A command that
   does not resolve to a defined script is drift and fails
   `tests/tooling/bootstrap-doc.test.mjs`. Add a command here only when its script exists.
2. **Renaming or removing a documented command** is a breaking change for developers and
   CI: it requires updating this table _and_ the underlying script together, with a
   deprecation/migration note, so downstream consumers (docs, onboarding, CI) are never
   silently broken.
3. **Safe fixture rules are load-bearing.** Weakening them (mounting real data/credentials,
   emitting secrets, retaining fixtures past teardown) is prohibited; the retained-fixture
   set is protected by `.gitignore` re-includes and the evidence manifest.
4. This file is itself recorded in the ownership map
   (`docs/architecture/repository-layout.md`) and sha256-pinned in the signed
   `evidence/manifest.json`, so its integrity is tamper-evident under `npm run
evidence:verify`.
