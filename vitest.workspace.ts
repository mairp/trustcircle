// TrustCircleAI — Vitest workspace project definitions (task T004 / GAR-010 /
// VO-ec575c4ce42b548bfb4d).
//
// This file is the single source of truth for the six required test suites — unit,
// contract, integration, security, migration, and resilience — plus the recovery suite
// wired by the package script surface. Each entry is a Vitest *project*: a named,
// independently runnable slice of the test estate (`vitest run --project <name>`).
//
// Compatibility contract (VO-ec575c4ce42b548bfb4d): the set of project NAMES here is a
// supported consumer surface. The root package.json exposes `test:unit`, `test:contract`,
// `test:integration`, `test:security`, `test:migrations`, `test:resilience`, and
// `test:recovery`, each of which resolves to `vitest run --project <name>`. Renaming or
// removing a project name is a breaking change to those consumers and is forbidden without
// deprecation/migration/compat evidence. `tests/tooling/vitest-workspace.test.mjs` asserts
// that every script-referenced project name is present, so the contract is enforced.
//
// Vitest 4 consumes these definitions through `test.projects` in ./vitest.config.ts, which
// imports this array. The named file `vitest.workspace.ts` remains the authored definition
// location so the required artifact and its project names stay stable.

import { defineProject } from 'vitest/config';

/** The canonical, ordered list of required suite names. Consumed by tests as the contract. */
export const PROJECT_NAMES = [
  'unit',
  'contract',
  'integration',
  'security',
  'migration',
  'resilience',
  'recovery',
] as const;

export type ProjectName = (typeof PROJECT_NAMES)[number];

// Shared defaults applied to every project. Empty suites must not fail the run so the
// Phase 1 checkpoint ("empty test projects run deterministically") holds before any
// `.test.ts` files exist.
const common = {
  globals: true,
  environment: 'node',
  passWithNoTests: true,
  clearMocks: true,
  restoreMocks: true,
} as const;

/**
 * Per-project include globs. Each suite owns a distinct directory and/or filename suffix so
 * the six concerns never overlap and can run in isolation.
 */
const projects = [
  // Fast, dependency-free logic tests colocated with sources and under tests/unit.
  defineProject({
    test: {
      ...common,
      name: 'unit',
      include: [
        'packages/**/src/**/*.unit.test.ts',
        'packages/**/*.test.ts',
        'tests/unit/**/*.test.ts',
      ],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
    },
  }),

  // Contract tests: OpenAPI / AsyncAPI / JSON Schema conformance against generated types.
  defineProject({
    test: {
      ...common,
      name: 'contract',
      include: ['tests/contract/**/*.test.ts', 'packages/contracts/**/*.contract.test.ts'],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
    },
  }),

  // Integration tests: multi-package / Testcontainers-backed flows (Postgres/NATS/OPA).
  defineProject({
    test: {
      ...common,
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
      // Integration suites talk to real backing services and need a longer budget.
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  }),

  // Security tests: authorization, tenant isolation, SoD, and evidence-integrity oracles.
  defineProject({
    test: {
      ...common,
      name: 'security',
      include: ['tests/security/**/*.test.ts'],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
    },
  }),

  // Migration tests: forward/rollback schema migrations and data-compatibility checks.
  defineProject({
    test: {
      ...common,
      name: 'migration',
      include: ['tests/migration/**/*.test.ts', 'db/migrations/**/*.test.ts'],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  }),

  // Resilience tests: fault-injection, degraded/offline state, retry & backpressure.
  defineProject({
    test: {
      ...common,
      name: 'resilience',
      include: ['tests/resilience/**/*.test.ts'],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
      testTimeout: 60_000,
    },
  }),

  // Recovery tests: backup/restore and disaster-recovery boundaries (wired by test:recovery).
  defineProject({
    test: {
      ...common,
      name: 'recovery',
      include: ['tests/recovery/**/*.test.ts'],
      exclude: ['**/node_modules/**', '.tsbuild/**'],
      testTimeout: 120_000,
    },
  }),
];

export default projects;
