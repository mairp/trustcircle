// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 (GATE7) — dedicated vitest config for the SCENARIO 10 manifest EMITTER (T218).
//
// Companion to ./vitest.config.ts (which runs the T217 compliance-scenarios WITNESS). This config exists
// ONLY to run the accessibility manifest emitter/drift-guard (emit-scenario10.test.ts), which must run
// under vitest because its runner dynamically imports a `.tsx` presenter oracle that Node's built-in
// `--experimental-strip-types` refuses. It is kept HERE beside the test (not at the repo root) so the
// workdir root stays clean. `root` is pinned to the repo root so the workspace symlink resolution
// (@trustcircle/*) and the include glob resolve exactly as they do for the rest of the suite.
//
//   emit:   TC_EMIT=1 npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.emit.config.ts
//   check:          npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.emit.config.ts
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
    include: ['tests/e2e/scenarios/_evidence/gate7/emit-scenario10.test.ts'],
  },
});
