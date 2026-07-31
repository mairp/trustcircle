# `db/migrations/` — PostgreSQL schema migrations (ownership stub)

Owner: `packages/persistence` (canonical governance core).
Change discipline: **expand → migrate → contract** only. A supported column,
table, or view is never dropped without a completed deprecation window and
migration/rollback evidence (GAR-010 compatibility obligation,
`VO-ec575c4ce42b548bfb4d`).

This directory holds the ordered SQL migrations for the transactional core
(canonical state, transactional **outbox/inbox**, audit hash chain,
checkpoints). It is authoritative for the physical schema; no service reaches
another service's database directly (see
`docs/architecture/repository-layout.md`).

Referenced by the `db:migrate` script
(`packages/persistence/src/database.ts migrate`). Migrations land here in a
later implementation phase (spec task series T0xx of the persistence context);
this stub reserves and documents ownership so the repository-layout map remains
truthful.
