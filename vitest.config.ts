// TrustCircleAI — root Vitest config (task T004 / GAR-010).
//
// Vitest 4 loads projects through `test.projects`. The project *definitions* live in
// ./vitest.workspace.ts (the required, named artifact); this file simply wires them in so
// `vitest run` and `vitest run --project <name>` resolve against the six required suites
// (unit, contract, integration, security, migration, resilience) plus recovery.

import { defineConfig } from 'vitest/config';
import projects from './vitest.workspace.ts';

export default defineConfig({
  test: {
    // No suite existing yet must not fail the run (Phase 1 checkpoint: empty test projects
    // run deterministically). Individual projects also set this.
    passWithNoTests: true,
    projects,
  },
});
