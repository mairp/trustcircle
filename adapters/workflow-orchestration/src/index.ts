// @trustcircle/adapter-workflow-orchestration package boundary entry point.
// Re-exports the read-only client + conformance drift gate (T253, T254 / US6).
export * from './client.ts';
export * from './conformance-gate.ts';
