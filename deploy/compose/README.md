# `deploy/compose/` — local Docker Compose deployment (core-only profile)

Owner: platform / deployment.
Target: local validation in WSL (`plan.md` §Target Platform — "Local validation
uses Docker Compose in WSL").

## `control-plane.yml` — the core-only profile (Phase 54 / T054 / NFR-010)

Stands up **exactly** the ten `core-required` components declared in
[`deploy/profiles/components.yaml`](../profiles/components.yaml), in that file's
deterministic `startupOrder`:

| #   | service           | role                                           | mayExecute |
| --- | ----------------- | ---------------------------------------------- | ---------- |
| 0   | `postgres`        | infrastructure                                 | no         |
| 1   | `object-storage`  | infrastructure                                 | no         |
| 2   | `nats`            | infrastructure                                 | no         |
| 3   | `opa`             | policy-engine (`policy` prerequisite provider) | no         |
| 4   | `collector`       | observability (never authoritative)            | no         |
| 5   | `api`             | control-plane                                  | **yes**    |
| 6   | `command-worker`  | worker                                         | **yes**    |
| 7   | `projector`       | projector                                      | no         |
| 8   | `discovery-agent` | discovery                                      | no         |
| 9   | `web`             | web (read-only visibility)                     | no         |

Nothing from the expected-offline runtime sets (on-demand LISA/Wiggum, optional,
external Kanban/agentctl/workflow_orchestration, intentionally-inactive) is present —
their offline state stays **distinct** from a degraded core.

### How the profile enforces NFR-010 (fail-closed)

- Every backing prerequisite (`postgres`, `object-storage`, `nats`, `opa`) declares a
  `healthcheck`, and every executing/consuming service declares
  `depends_on: { <prereq>: { condition: service_healthy } }`. A lost/unreachable
  prerequisite therefore **blocks new execution immediately** at the substrate level.
- `web` depends only on `api` reachability (`service_started`, not `service_healthy`)
  so **read-only visibility and escalation remain available** while the core is degraded.
- `healthcheck.mjs` fails **closed**: any error/non-2xx/stale marker/timeout ⇒ unhealthy.

### Supporting files

- `Dockerfile` — shared multi-stage image; one `target` per app process boundary.
- `healthcheck.mjs` — dependency-free, fail-closed HTTP/file liveness probe.
- `web-server.mjs` — minimal read-only visibility + escalation surface for the web tier.
- `otel-collector.yaml` — collector config; telemetry sink only, never authoritative.

### Usage (WSL)

```bash
docker compose -f deploy/compose/control-plane.yml config      # validate + render
docker compose -f deploy/compose/control-plane.yml up -d       # bring up the core
docker compose -f deploy/compose/control-plane.yml ps          # fail-visible health
```

The profile and `components.yaml` are kept in lockstep by
`tests/tooling/control-plane-compose.test.mjs` (runs under `npm run test:tooling`).
Deployment topology changes preserve supported operator consumers or provide
migration/rollback notice (GAR-010, `VO-ec575c4ce42b548bfb4d`).
