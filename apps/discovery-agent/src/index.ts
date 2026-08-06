// @trustcircle/discovery-agent — package entry surface.
// Re-exports the governed least-privilege discovery bootstrap, scan authorization, budgets,
// evidence sink, and fail-visible status snapshot (Phase 49).
export * from './main.ts';
// Phase 67: least-privilege repository & filesystem metadata discovery (no protected-content inspection).
export * from './scanners/filesystem.ts';
// Phase 68: least-privilege runtime metadata discovery (processes/services/containers/ports/manifests).
export * from './scanners/runtime.ts';
// Phase 69: core-architecture candidate classifier (two-axis, advisory — never auto-onboards).
export * from './classifiers/core-architecture.ts';
// Phase 8 / T267: agent-systems candidate classifier + onboarding templates (advisory — never onboards).
export * from './classifiers/agent-systems.ts';
// Phase 8 / T268: infrastructure classifier (read-vs-mutation + desired-vs-observed axes, advisory).
export * from './classifiers/infrastructure.ts';
// Phase 74: periodic & on-demand discovery scheduling over the governed least-privilege sweep.
export * from './discovery-runner.ts';
