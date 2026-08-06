# Compatibility & Deprecation Policy — Governance Control Plane

Phase 10 · T299 · GAR-010. This policy defines the **supported contract majors**, the **consumer
notice** obligation, the **deprecation windows**, the **retirement gates**, the **migration
evidence** required to retire anything, and the narrow **emergency security exception** path. It is
the load-bearing "compatibility half" of GAR-010: a consumer must never silently bind to an
unsupported or about-to-break surface, and nothing that a consumer depends on may be retired without
proof that the consumer can move.

The policy is **enforced in code and tests**, not merely asserted here:

| Enforcement point                                                                                                                     | What it guarantees                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/server.ts` — `API_VERSION=1`, `SUPPORTED_API_VERSIONS`, `/v1` prefix                                                    | Every route is version-prefixed; an unversioned/wrong-version path is a visible 404 that lists the supported versions.                                                         |
| `packages/contracts/src/events.ts` — `SUPPORTED_SCHEMA_VERSION=1.0.0`, `classifyVersion`, `isReadableVersion`, `additiveTopLevelKeys` | Same-major additive evolutions are `readable`; a cross-major bump is `incompatible` and rejected.                                                                              |
| `tests/migrations/compatibility.test.ts` (T278)                                                                                       | Proves additive contract compatibility AND expand→migrate→verify→contract DB evolution from the previous supported version, with negative controls.                            |
| `vitest.workspace.ts` project-name set                                                                                                | The set of test **project names** is itself a supported consumer surface — renaming/removing one is a breaking change (asserted by `tests/tooling/vitest-workspace.test.mjs`). |

---

## 1. Versioned surfaces under this policy

Three consumer-facing contract surfaces are versioned and governed here:

1. **HTTP API** — every governed route mounts under an explicit `/v{major}` prefix. Current major:
   **v1** (`API_VERSION = 1`). `SUPPORTED_API_VERSIONS` lists every currently-served major.
2. **Event / message envelope** — the canonical event schema. Current version:
   **`SUPPORTED_SCHEMA_VERSION = 1.0.0`** (semver: `major.minor.patch`).
3. **Published contract artifacts & tooling surface** — the generated OpenAPI/AsyncAPI/JSON-Schema
   contracts (`contracts:publish`) and the test **project names** consumers script against
   (`test:unit`, `test:contract`, …).

## 2. Semantic-version discipline

- **MAJOR** — a breaking change (a removed/renamed field, a narrowed type, a removed route, a
  changed required-ness, a removed test-project name). Requires a new major surface running **in
  parallel** with the outgoing one for the full deprecation window (§4).
- **MINOR** — a backward-compatible **additive** change (a new optional field, a new route, a new
  event type). A consumer pinned to a lower same-major minor keeps working: `classifyVersion`
  classifies it `readable` and `additiveTopLevelKeys` reports the extra keys a forward-compatible
  reader ignores.
- **PATCH** — a behaviour-preserving fix. No consumer action required.

**Additive-only within a major.** Inside a live major, only MINOR/PATCH changes are allowed. Any
breaking change forces a new MAJOR — it is never shipped in place.

## 3. Supported contract majors

- **N and N−1 are supported simultaneously.** When a new major `N` ships, the previous major `N−1`
  remains fully supported for the entire deprecation window, so consumers can migrate on their own
  schedule. Today only **v1** exists, so v1 is the sole supported major and there is nothing in a
  deprecation window.
- **At most two majors live at once.** Introducing `N` while `N−2` is still live is forbidden;
  `N−2` must complete retirement first.
- Each supported major is independently released, health-checked, and covered by the release gate.

## 4. Consumer notice & deprecation windows

Deprecation is a **published, timed** process — never a surprise removal.

| Surface                           | Minimum notice before deprecation announcement takes effect | Minimum deprecation window (announced → eligible for retirement) |
| --------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| HTTP API major                    | 30 days                                                     | **180 days**                                                     |
| Event/envelope major              | 30 days                                                     | **180 days**                                                     |
| Published contract / tooling name | 30 days                                                     | **90 days**                                                      |

**Consumer notice obligations** during a deprecation window:

1. A machine-readable `Deprecation` and `Sunset` response header (RFC 8594) is emitted on every
   response from a deprecated API major, carrying the sunset date and a link to the migration guide.
2. A deprecation entry is published in the release notes and in
   `docs/governance/continual-improvement.md` (the versioned backlog) with the owner and the sunset
   date.
3. The deprecated surface keeps working **unchanged** for the full window — deprecation announces
   intent; it never degrades behaviour.
4. Usage of the deprecated surface is measured; if a known consumer is still calling it as the
   sunset date approaches, retirement is **blocked** (see §5, gate R4) until they migrate or accept
   a documented exception.

## 5. Retirement gates

A surface may be retired **only** when every gate below is satisfied. Each gate produces evidence
retained under `artifacts/validation/` or `docs/governance/`.

| Gate | Requirement                                                                                                                       | Evidence                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R1   | The full deprecation window (§4) has elapsed since the announcement.                                                              | Release notes + `continual-improvement.md` entry with dates.               |
| R2   | A supported successor surface exists and is GA (the replacement major is live and release-gated).                                 | `artifacts/release/approval-manifest.json`.                                |
| R3   | A **migration path** is documented and executable (expand→migrate→verify→contract for data; a field/route mapping for contracts). | Migration guide + `tests/migrations/compatibility.test.ts`.                |
| R4   | **No known consumer** still depends on the surface, OR every remaining dependant has a signed, dated exception (§7).              | Usage measurement + exception register in `docs/governance/known-gaps.md`. |
| R5   | Migration **evidence** proves a consumer can move without data or authority loss.                                                 | See §6.                                                                    |
| R6   | Retirement is executed as a **contract** migration (the removal only lands after expand+migrate+verify).                          | Migration runner history (`schema_migrations`).                            |

Retirement of a **test-project name** (a scripted consumer surface) additionally requires that the
`vitest.workspace.ts` name set change be additive-superset-safe during the window (the old name kept
until sunset), enforced by `tests/tooling/vitest-workspace.test.mjs`.

## 6. Migration evidence

Before any retirement (gate R5), the following evidence must exist and pass:

- **Contract compatibility proof** — `tests/migrations/compatibility.test.ts` shows a consumer
  pinned to the outgoing version can still read messages produced under the successor, and that a
  cross-major bump is correctly rejected (the breaking-change guard, non-vacuous with negative
  controls).
- **Database evolution proof** — expand→migrate→verify→contract on the real migration runner
  (`packages/persistence/src/database.ts`), applied-once, checksum-pinned, idempotent, with the
  legacy column/table dropped **only** in the contract step after backfill.
- **End-to-end migration rehearsal** — the successor surface passes the release gate
  (`artifacts/release/approval-manifest.json`) and the full-quickstart validation
  (`artifacts/validation/full-quickstart/manifest.json`) with the migration applied.
- **Rollback plan** — the expand step is reversible until the contract step lands, so an
  in-progress migration can be abandoned without data loss.

## 7. Emergency security exceptions

The deprecation windows in §4 exist to protect consumers, but they must not be able to **trap the
platform on a vulnerable surface**. A narrow emergency path is defined:

- **Trigger.** A surface (route, field, envelope, dependency) carries an actively-exploited or
  critical vulnerability with no backward-compatible fix, such that continuing to serve it endangers
  tenants.
- **Authority.** An emergency exception requires **joint approval** by the accountable service owner
  **and** the security lead — separation of duties (GAR-003) applies; neither can invoke it alone.
- **Effect.** The affected surface may be disabled or fast-tracked to retirement **inside** the
  normal window, but:
  - the change is still executed as a versioned, evidenced migration (gates R3, R5, R6 still apply);
  - affected consumers get the **maximum feasible** (not full) notice — as much as safety allows;
  - the emergency exception is **recorded** with trigger, approvers, date, scope, and the compressed
    timeline in `docs/governance/known-gaps.md` (exception register), and fed into
    `docs/governance/continual-improvement.md`.
- **Audit.** Every emergency exception is a consequential action and is written to the tamper-evident
  audit ledger with actor, accountable owner, reason, scope, and outcome — an emergency path can
  never be an unaccountable one.

## 8. Change control

Changes to **this policy** are themselves versioned and reviewed. A change that weakens a window, a
gate, or the notice obligation requires the same joint owner+security approval as an emergency
exception (§7), so the compatibility guarantees cannot be quietly eroded.
