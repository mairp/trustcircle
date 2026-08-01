// @trustcircle/discovery-agent — package entry surface.
// Re-exports the governed least-privilege discovery bootstrap, scan authorization, budgets,
// evidence sink, and fail-visible status snapshot (Phase 49).
export * from './main.ts';
// Phase 67: least-privilege repository & filesystem metadata discovery (no protected-content inspection).
export * from './scanners/filesystem.ts';
