# `deploy/kubernetes/` — hybrid central-catalog / federated-cell deployment

Owner: platform / deployment.
Target: Linux containers, hybrid central-catalog/federated-cell deployment
(`plan.md` §Scale/Scope).

Holds the Kubernetes manifests for the independently deployable process
boundaries (`apps/api`, `apps/command-worker`, `apps/projector`,
`apps/discovery-agent`, `apps/web`) and the out-of-process controller adapters
(`adapters/*`) that run as sidecars. Deployment/topology changes preserve
supported operator consumers or provide migration/rollback notice (GAR-010,
`VO-ec575c4ce42b548bfb4d`).

## Layout

- `base/` — kustomize base for the core-only profile, mirroring `deploy/compose/control-plane.yml`
  (same pinned infrastructure images and the same fail-closed health probes). The base is
  namespace-agnostic and holds no secret values.
- `recovery/` — disaster-recovery runbook.

Deploy with `scripts/provision.sh --target kubernetes` (see `docs/PROVISIONING.md`). The script
creates the namespace-scoped Secret and ConfigMaps the base references, then applies a generated
overlay that sets the namespace and image references. Federated-cell and sidecar adapter
manifests are still to come.
