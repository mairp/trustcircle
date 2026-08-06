// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 (GATE7) — dedicated vitest config for the DURABLE non-vacuity control (W4).
//
// Companion to ./vitest.config.ts (T217 witness) and ./vitest.emit.config.ts (T218 emitters). This
// config exists ONLY to run nonvacuity.test.ts, which imports the shipped `.tsx` compliance oracle +
// presenter (Node's `--experimental-strip-types` refuses `.tsx`, so it must run under vitest). It is
// kept HERE beside the test (not at the repo root) so the workdir root stays clean; `root` is pinned to
// the repo root so workspace resolution (@trustcircle/*) and the include glob match the rest of the suite.
//
//   run:  npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.nonvacuity.config.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// This config lives at <repo>/tests/e2e/scenarios/_evidence/gate7/ — climb five levels to the repo root
// so `include` (repo-relative) and workspace package resolution behave identically to the main suite.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export default defineConfig({
  root: REPO_ROOT,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/scenarios/_evidence/gate7/nonvacuity.test.ts'],
  },
});
