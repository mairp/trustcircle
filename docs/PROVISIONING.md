# Provisioning the TrustCircle control plane

This guide is for **consumers**: teams that want to run their own instance of the governance
control plane. One script, `scripts/provision.sh`, stands up the core-only runtime profile
(`deploy/profiles/components.yaml`) on Docker Compose or Kubernetes. It generates per-instance
secrets and writes a provisioning receipt you can keep as change evidence.

If you use Claude Code, the `provisioner` agent (`.claude/agents/provisioner.md`) runs the same
steps interactively: it checks prerequisites, asks for missing choices, runs the script and explains
failures.

## What gets deployed

Ten core components, in a fixed startup order:

| #   | Component         | Role                                                                            |
| --- | ----------------- | ------------------------------------------------------------------------------- |
| 0   | `postgres`        | Canonical governance store (migrations from `db/migrations` run on first start) |
| 1   | `object-storage`  | S3-compatible evidence custody (MinIO)                                          |
| 2   | `nats`            | JetStream delivery substrate                                                    |
| 3   | `opa`             | Policy decision point; fail-closed authorization                                |
| 4   | `collector`       | OpenTelemetry collector (telemetry only, never authoritative)                   |
| 5   | `api`             | Tenant-scoped decision and read API                                             |
| 6   | `command-worker`  | Governed command execution                                                      |
| 7   | `projector`       | Read-model projections                                                          |
| 8   | `discovery-agent` | Metadata-only discovery within the declared boundary                            |
| 9   | `web`             | Operator console (read-only visibility and escalation)                          |

Optional and on-demand connectors are not started. Activating one is an owner-approved, separate
step.

## Prerequisites

| Target       | Requirements                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both         | `bash`, `git`, `openssl`, `python3`, `sha256sum`                                                                                                                                |
| `compose`    | Docker Engine 24+ with Compose v2; 8 GiB RAM recommended; free ports 14000 and 14001                                                                                            |
| `kubernetes` | `kubectl` 1.27+ with rights to create a namespace (or deployments in an existing one); a default StorageClass; Docker if you build images; a registry the cluster can pull from |

## Quick start: Docker Compose (evaluation and pilot)

```bash
git clone <your-fork-or-mirror> trustcircle && cd trustcircle
scripts/provision.sh --target compose
# Web UI  → http://localhost:14000
# API     → http://localhost:14001/v1/readiness
```

Tear down with `docker compose -f deploy/compose/control-plane.yml -f .provision/compose.override.yml --env-file .provision/compose.env down`.
Add `-v` to delete the data volumes as well.

## Kubernetes

```bash
# Build, push to your registry and deploy into namespace "trustcircle"
scripts/provision.sh --target kubernetes --registry registry.example.com/trustcircle --push

# Use pre-built images, a custom namespace and an explicit context
scripts/provision.sh --target kubernetes --no-build \
  --registry registry.example.com/trustcircle --tag v1.2.0 \
  --namespace governance-prod --context my-cluster

# See what would happen, change nothing
scripts/provision.sh --target kubernetes --registry registry.example.com/trustcircle --dry-run
```

The script:

1. Creates the namespace.
2. Creates the `trustcircle-secrets` Secret from the env file.
3. Creates ConfigMaps for migrations, the collector config and the NATS topology.
4. Generates a kustomize overlay in `.provision/kubernetes/` that sets the namespace and your
   image references.
5. Applies `deploy/kubernetes/base` and waits for every rollout.

Reach the UI with `kubectl -n <namespace> port-forward svc/web 14000:8080`. You can also add your
own Ingress in front of `svc/web`.

## Secrets

- On the first run the script generates random secrets into `.provision/<target>.env` (mode 0600,
  git-ignored). Later runs reuse that file, so re-running is safe.
- To supply your own values, copy `.env.example`, fill it in and pass `--env-file`.
- `--rotate-secrets` generates new values. Existing PostgreSQL data keeps the old password, so
  rotate the database role in the same change window.
- Secret values are never printed, logged or written to the receipt.

## Identity and access

Out of the box the console runs in **local operator preview**: a read-only auditor principal for
one preview tenant. For real use, put an identity gateway (OIDC) in front of `web` and `api`,
set `TRUST_IDENTITY_HEADERS=true` on `web`, and turn off `LOCAL_OPERATOR_PREVIEW`. Separation of
duties, delegation and approvals only take effect with real identities.

## Provisioning receipt (evidence)

Each successful run writes `.provision/receipt-<UTC>.json`. It records:

- target and namespace
- git commit and whether the tree had local changes
- image references
- a SHA-256 over every deployment source applied
- component health
- the operator

Keep it with your change records. It supports ISO/IEC 42001 operational-planning and change-control
evidence (see [`docs/compliance/ISO42001.md`](compliance/ISO42001.md)). It is not a certification
artefact.

## Troubleshooting

| Symptom                                         | Likely cause and fix                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port 14000 is in use`                          | Another service owns the port. Stop it, or change the published ports in a compose override                                                             |
| `pull access denied`                            | The registry is unreachable or needs `docker login`. For Kubernetes, add an `imagePullSecret` to the namespace's default service account                |
| `api` unhealthy, `web` up                       | Expected fail-closed behaviour while a prerequisite (postgres, nats, opa, object-storage) is unhealthy. Check `docker compose ps` or `kubectl get pods` |
| Postgres auth failures after `--rotate-secrets` | The existing volume keeps the old password. Run `ALTER ROLE` or recreate the volume                                                                     |
