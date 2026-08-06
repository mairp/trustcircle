// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 (GATE6) — signed SCENARIO 7 result-manifest emitter (T183).
//
// Runs the operate-controllers-safely acceptance runner (tests/e2e/scenarios/controller-operations.ts)
// over the fixed controller world (tests/fixtures/controllers.ts) and emits the signed result manifest:
//
//   • scenario7-controller-operations.manifest.json — FR-023..028, FR-046..050, NS-005, NS-011,
//     SC-010, SC-011, SC-021.
//
// SCENARIO 8 (controller-surfaces ACCESSIBILITY) is emitted by its sibling vitest emitter
// (emit-scenario8.test.ts), NOT here: its runner audits the three SHIPPED `.tsx` presenters
// (ControllerRegistry / OperationDetail / OperationActions), and Node's built-in TypeScript support
// (`--experimental-strip-types`) refuses the `.tsx` extension, so that manifest must be produced under a
// runner that transforms `.tsx` (vitest). This emitter is the node-safe half — Scenario 7 depends only on
// the fixture (`.tsx` type-only) and @trustcircle/{domain,application}.
//
// SIGNING. The manifest is canonicalised (sorted-key JSON) and hashed with Node's built-in crypto
// (sha256) into a top-level `manifestDigest`; the runner is deterministic (no clock, no randomness), so
// re-running over the same durable fixture reproduces byte-identical digests — the non-repudiation property.
//
// Usage:  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate6/emit-manifests.mjs [--check]
//   (default) writes the manifest next to this file.
//   --check   re-emits in memory and fails if the on-disk manifest differs (drift guard).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { buildControllerInputs, runControllerOperationsScenario } from '../../controller-operations.ts';

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

// The pinned execution identity every result is bound to (User Story 4 / P2).
export const VERSION = {
  feature: '001-governance-control-plane',
  userStory: 'US4',
  userStoryTitle: 'Operate Governance Controllers Safely',
  priority: 'P2',
};

export function buildManifest(scenario, scenarioTitle, result) {
  return sign({
    manifestVersion: 1,
    kind: 'scenario-result-manifest',
    scenario,
    scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/controller-operations.ts',
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

const scenario7 = buildManifest(
  'Scenario-7',
  'Operate Governance Controllers Safely — discover, gate, uncertainty≠success, one effect, bounded continuity, protect newer state',
  runControllerOperationsScenario(buildControllerInputs()),
);

const check = process.argv.includes('--check');
const drift = persist(HERE, 'scenario7-controller-operations.manifest.json', scenario7, check);

if (!scenario7.allSatisfied) {
  console.error('FAIL: Scenario 7 has unsatisfied criteria');
  process.exit(1);
}
if (check && drift) process.exit(1);
