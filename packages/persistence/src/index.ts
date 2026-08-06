// @trustcircle/persistence package boundary entry point.
//
// Re-exports the PostgreSQL client, transaction wrapper, advisory locks, idempotent
// mutating-operation runner, reconciliation, and migration runner (Phase 17). This is the
// supported consumer surface; the declared package `exports["."]` / `main` target resolves
// here. Adding a symbol is an additive, backward-compatible contract change.
export * from './database.ts';
// Phase 21 (T021): the unit-of-work that atomically commits canonical state + AuditEvent +
// OutboxMessage in one transaction. Additive, backward-compatible extension of the surface.
export * from './unit-of-work.ts';
// Phase 4 (T103): the DECISION OUTCOME REPOSITORY — a decision-shaped adapter over the unit-of-work
// that atomically commits an accepted OR rejected decision outcome (record embedded in canonical
// state) together with its audit event and outbox message, with independent read-back paths.
export * from './decision-repository.ts';
export * from './operational-case-repository.ts';
