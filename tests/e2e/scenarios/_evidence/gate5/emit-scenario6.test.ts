// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 (GATE5) — signed SCENARIO 6 (accessibility) manifest emitter + drift guard (T150).
//
// The companion to emit-manifests.mjs. Scenario 6 audits the three SHIPPED `.tsx` integrity presenters
// (IntegrityQueue / EvidenceComparison / RemediationDetail) via the accessibility oracle, so its runner
// dynamically imports a `.tsx` module. Node's built-in `--experimental-strip-types` refuses the `.tsx`
// extension, so — unlike the node-safe Scenario 5 emitter — this manifest is emitted here, under vitest,
// which transforms `.tsx`. It reuses the SAME sign/buildManifest/persist helpers the `.mjs` exports, so
// the two manifests are byte-for-byte consistent in shape and signing.
//
// Default (`vitest run`) DRIFT-CHECKS the committed manifest against a freshly emitted one — a mutated
// runner, fixture, or presenter invalidates the signature and fails the test. Set TC_EMIT=1 to WRITE the
// manifest (the authoring step, mirroring the `.mjs` default vs --check split).
//
// No workspace project globs tests/e2e/**, so this runs under the sibling dedicated config
// (./vitest.config.ts), which pins `root` to the repo so package + include resolution match the suite:
//   emit:   TC_EMIT=1 npx vitest run --config tests/e2e/scenarios/_evidence/gate5/vitest.config.ts
//   check:  npx vitest run --config tests/e2e/scenarios/_evidence/gate5/vitest.config.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// The signing/serialisation helpers are shared with the node-safe Scenario 5 emitter.
import { buildManifest, persist } from './emit-manifests.mjs';
import { runIntegrityAccessibilityScenario } from '../../integrity-remediation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'scenario6-integrity-accessibility.manifest.json';

describe('GATE5 · Scenario 6 — integrity-surfaces accessibility manifest', () => {
  it('emits or drift-checks the signed accessibility manifest', async () => {
    const result = await runIntegrityAccessibilityScenario();
    expect(result.allSatisfied, 'every accessibility criterion satisfied').toBe(true);

    const manifest = buildManifest(
      'Scenario-6',
      'Integrity Surfaces Accessibility — WCAG 2.2 AA presenters and honest empty models',
      result,
    );
    expect(manifest.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const emit = process.env['TC_EMIT'] === '1';
    const drift = persist(HERE, NAME, manifest, !emit);
    // In check mode a drift is a hard failure (the committed manifest is stale or tampered).
    expect(drift, 'committed manifest matches the freshly emitted one').toBe(false);
  });
});
