// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 (GATE5) — dedicated vitest config for the Scenario-6 accessibility emitter.
//
// No workspace project in vitest.workspace.ts globs tests/e2e/**, and the Scenario-6 emitter must run
// under vitest (its runner dynamically imports a `.tsx` presenter, which Node's --experimental-strip-types
// refuses). This tiny config exists ONLY to emit/drift-check that one manifest, and is kept HERE beside the
// emitter (not at the repo root) so the workdir root stays clean. `root` is pinned to the repo root so the
// workspace symlink resolution (@trustcircle/*) and the include glob both resolve exactly as they do for
// the rest of the suite.
//
//   emit:   TC_EMIT=1 npx vitest run --config tests/e2e/scenarios/_evidence/gate5/vitest.config.ts
//   check:  npx vitest run --config tests/e2e/scenarios/_evidence/gate5/vitest.config.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// This config lives at <repo>/tests/e2e/scenarios/_evidence/gate5/ — climb five levels to the repo root
// so `include` (repo-relative) and workspace package resolution behave identically to the main suite.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export default defineConfig({
  root: REPO_ROOT,
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/scenarios/_evidence/gate5/emit-scenario6.test.ts'],
  },
});
