// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 (GATE7) — dedicated vitest config for the compliance ACCESSIBILITY runner (T217).
//
// No workspace project in vitest.workspace.ts globs tests/e2e/**, and the compliance accessibility
// scenario (runComplianceAccessibilityScenario in tests/e2e/scenarios/standards-applicability.ts) must
// run under vitest: its runner dynamically imports a `.tsx` presenter oracle, which Node's built-in
// `--experimental-strip-types` refuses. This tiny config exists ONLY to execute the two compliance
// scenarios under a `.tsx`-aware runtime, and is kept HERE beside the test (not at the repo root) so the
// workdir root stays clean. `root` is pinned to the repo root so the workspace symlink resolution
// (@trustcircle/*) and the include glob resolve exactly as they do for the rest of the suite.
//
//   run:  npx vitest run --config tests/e2e/scenarios/_evidence/gate7/vitest.config.ts
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
    include: ['tests/e2e/scenarios/_evidence/gate7/compliance-scenarios.test.ts'],
  },
});
