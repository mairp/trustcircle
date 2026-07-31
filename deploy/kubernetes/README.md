# `deploy/kubernetes/` — hybrid central-catalog / federated-cell deployment (ownership stub)

Owner: platform / deployment.
Target: Linux containers, hybrid central-catalog/federated-cell deployment
(`plan.md` §Scale/Scope).

Holds the Kubernetes manifests for the independently deployable process
boundaries (`apps/api`, `apps/command-worker`, `apps/projector`,
`apps/discovery-agent`, `apps/web`) and the out-of-process controller adapters
(`adapters/*`) that run as sidecars. Deployment/topology changes preserve
supported operator consumers or provide migration/rollback notice (GAR-010,
`VO-ec575c4ce42b548bfb4d`).

Concrete manifests land in a later deployment phase; this stub reserves and
documents ownership so `docs/architecture/repository-layout.md` remains truthful.
