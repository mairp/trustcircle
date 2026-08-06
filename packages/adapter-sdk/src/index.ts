// @trustcircle/adapter-sdk package boundary entry point.
// Version-pinned, idempotency-keyed out-of-process adapter HTTP client — the safe seam the platform
// uses to drive a controller adapter (Phase 6 / User Story 4 / FR-024, FR-026, FR-027, NS-005, SC-011).
export * from './client.ts';

// Phase 8 / User Story 6 / T228 — manifest types, signing helpers, capability negotiation,
// observation/operation envelopes, and version-compatibility helpers. The manifest-first contract
// every adapter (kanban, workflow_orchestration, agentctl, lisa, wiggum, …) declares itself with.
// Additive, backward-compatible.
export * from './manifest.ts';

// Phase 8 / User Story 6 / T229 — the language-neutral conformance runner and signed result manifest
// format that gates an adapter version's activation. Additive, backward-compatible.
export * from './conformance.ts';
