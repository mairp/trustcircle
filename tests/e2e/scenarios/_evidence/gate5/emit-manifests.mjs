// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 (GATE5) — signed SCENARIO 5 result-manifest emitter (T150).
//
// Runs the contain-and-repair acceptance runner (tests/e2e/scenarios/integrity-remediation.ts) over
// the fixed integrity projection (tests/fixtures/integrity.ts) and emits the signed result manifest:
//
//   • scenario5-integrity-remediation.manifest.json — FR-016..022, SC-006, SC-007, SC-008, SC-009.
//
// SCENARIO 6 (integrity-surfaces ACCESSIBILITY) is emitted by its sibling vitest emitter
// (emit-scenario6.test.ts), NOT here: its runner audits the three SHIPPED `.tsx` presenters, and
// Node's built-in TypeScript support (`--experimental-strip-types`) refuses the `.tsx` extension, so
// that manifest must be produced under a runner that transforms `.tsx` (vitest). This emitter is the
// node-safe half — Scenario 5 depends only on the fixture (`.tsx` type-only) and `@trustcircle/domain`.
//
// SIGNING. The manifest is canonicalised (sorted-key JSON) and hashed with Node's built-in crypto
// (sha256) into a top-level `manifestDigest`; every criterion line additionally carries the runner's
// own per-criterion evidence (via `resultDigest`), so a single mutated byte anywhere invalidates the
// signature. Re-running over the same durable fixture reproduces byte-identical digests (the runner is
// deterministic — no clock, no randomness), which is itself the non-repudiation property.
//
// Usage:  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate5/emit-manifests.mjs [--check]
//   (default) writes the manifest next to this file.
//   --check   re-emits in memory and fails if the on-disk manifest differs (drift guard).
//
// The `.tsx` imports reached transitively here are TYPE-ONLY (erased by strip-types);
// `@trustcircle/domain` resolves through the workspace, so no transpiler beyond Node's built-in type
// stripping is required.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { runIntegrityRemediationScenario } from '../../integrity-remediation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Canonical (sorted-key) JSON serialisation — the signing input.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sign(manifestWithoutDigest) {
  const manifestDigest = `sha256:${createHash('sha256').update(canonical(manifestWithoutDigest)).digest('hex')}`;
  return { ...manifestWithoutDigest, manifestDigest };
}

// The pinned execution identity every result is bound to (User Story 3 / P1).
export const VERSION = {
  feature: '001-governance-control-plane',
  userStory: 'US3',
  userStoryTitle: 'Contain and Repair Damaged Work Safely',
  priority: 'P1',
};

export function buildManifest(scenario, scenarioTitle, result) {
  return sign({
    manifestVersion: 1,
    kind: 'scenario-result-manifest',
    scenario,
    scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/integrity-remediation.ts',
    version: VERSION,
    resultDigest: result.digest,
    allSatisfied: result.allSatisfied,
    criteria: result.criteria.map((c) => ({
      ref: c.ref,
      statement: c.statement,
      satisfied: c.satisfied,
      evidence: c.evidence,
      observedVia: c.observedVia,
      negativeControl: c.negativeControl,
    })),
  });
}

/** Serialise a manifest and either write it or drift-check it. Returns true on drift (check mode). */
export function persist(here, name, manifest, check) {
  const path = join(here, name);
  const serialised = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    let onDisk = '';
    try {
      onDisk = readFileSync(path, 'utf8');
    } catch {
      onDisk = '';
    }
    if (onDisk !== serialised) {
      console.error(`DRIFT: ${name} differs from freshly emitted manifest`);
      return true;
    }
    console.log(`OK: ${name} (${manifest.manifestDigest})`);
    return false;
  }
  writeFileSync(path, serialised);
  console.log(`wrote ${name} — allSatisfied=${manifest.allSatisfied} digest=${manifest.manifestDigest}`);
  return false;
}

const scenario5 = buildManifest(
  'Scenario-5',
  'Contain and Repair Damaged Work Safely — detect, preserve, contain, bound automation, verified closure',
  runIntegrityRemediationScenario(),
);

const check = process.argv.includes('--check');
const drift = persist(HERE, 'scenario5-integrity-remediation.manifest.json', scenario5, check);

if (!scenario5.allSatisfied) {
  console.error('FAIL: Scenario 5 has unsatisfied criteria');
  process.exit(1);
}
if (check && drift) process.exit(1);
