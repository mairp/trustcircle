# Rollback and Recovery Plan

## Objective

Recover the web presentation tier within 10 minutes without changing canonical data, API
routing, volumes, evidence, adjacent stacks, or unrelated worktree changes. Rollback is not
authorized for the running stack until the deployment gate is approved.

## Preconditions for Release

- Record digests for the current temporary JSON readiness source/entrypoint, last approved
  web image, candidate image, lockfile, Compose source/render, and healthcheck contract.
- Prove the prior image/entrypoint can still start in a disposable environment and serves
  `/healthz` plus fail-visible `/readiness`/root behavior.
- Record exact project/service/container/volume ownership and adjacent-stack baseline.
- Assign rollback executor and independent verifier; neither invents release approval.

## Rollback Trigger Conditions

- Root HTML is unavailable, blank, disclosure-unsafe, or materially inaccessible.
- `/healthz` or `/readiness` contract regresses or yields false green.
- Tenant/role isolation, CSP, routing, compliance-truth, or action-authority control fails.
- Candidate restarts repeatedly, cannot drain, or exceeds the recovery objective.
- Required evidence/approval is missing, revoked, expired, stale, or digest-mismatched.

## Bounded Procedure

1. Stop further web rollout only; preserve logs, response samples, image/render digests,
   timestamps, correlation metadata, and original candidate state.
2. Confirm exact project/service target and current volume/API/adjacent baseline. Abort if
   identity or scope is ambiguous.
3. Select the digest-pinned last approved graphical image or, if none, the preserved
   temporary JSON readiness entrypoint/image.
4. Replace only the web service artifact/config within the approved project scope. Do not
   rebuild, restart, recreate, or edit API, databases, event/object stores, volumes, or
   adjacent services.
5. Probe web `/healthz` and `/readiness`, API `/v1/health` and `/v1/readiness`, root content
   type/semantics, exact ports, restart count, and adjacent/volume invariants.
6. Record outcome and remaining degraded capability. A JSON fallback must be labeled as
   temporary readiness visibility, not a graphical console.
7. Open a traceable incident/corrective action and require new implementation/release
   evidence before retrying deployment.

## Abort and Escalation

Abort before mutation if the target, approved digest, prior image, API/volume invariant,
authority, or rollback evidence is uncertain. Escalate immediately for tenant disclosure,
protected-data leak, data/volume change, adjacent-stack impact, destructive command need,
or inability to restore fail-visible visibility within 10 minutes.

## Recovery Evidence

Capture actor, approver, exact scoped commands, UTC times, before/after service and routing
inventory, image/render digests, four probe results, root content classification, restart
counts, volume identities, adjacent delta, sanitized logs, incident ID, and verifier verdict.
