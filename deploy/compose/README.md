# `deploy/compose/` — local Docker Compose deployment (ownership stub)

Owner: platform / deployment.
Target: local validation in WSL (`plan.md` §Target Platform — "Local validation
uses Docker Compose in WSL").

Holds the Docker Compose definitions that stand up the governance core
(`apps/api`, `apps/command-worker`, `apps/projector`, `apps/discovery-agent`,
`apps/web`), PostgreSQL, NATS JetStream, and object storage for end-to-end
quickstart validation. Deployment topology changes preserve supported operator
consumers or provide migration/rollback notice (GAR-010,
`VO-ec575c4ce42b548bfb4d`).

Concrete compose files land in a later deployment phase; this stub reserves and
documents ownership so `docs/architecture/repository-layout.md` remains truthful.
