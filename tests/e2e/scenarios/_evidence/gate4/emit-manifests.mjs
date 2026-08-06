// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4 · User Story 2 (GATE4) — signed SCENARIO 2 & 3 result-manifest emitter (T119).
//
// Runs the human-decision + federated-joint-approval acceptance runners
// (tests/e2e/scenarios/human-decisions.ts) over the fixed decision projection
// (tests/fixtures/decisions.ts) and emits TWO signed result manifests:
//
//   • scenario2-human-decision.manifest.json      — FR-010..015, SC-003, SC-004, SC-020.
//   • scenario3-federated-joint.manifest.json      — FR-043, FR-044, FR-045, SC-005.
//
// SIGNING. Each manifest is canonicalised (sorted-key JSON) and hashed with Node's built-in
// crypto (sha256) into a top-level `manifestDigest`; every criterion line additionally carries the
// runner's own per-criterion evidence digest, so a single mutated byte anywhere invalidates the
// signature. Re-running the emitter over the same durable fixture reproduces byte-identical digests
// (the runners are deterministic — no clock, no randomness), which is itself the non-repudiation
// property SC-004 asserts.
//
// Usage:  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate4/emit-manifests.mjs [--check]
//   (default) writes the two manifests next to this file.
//   --check   re-emits in memory and fails if the on-disk manifests differ (drift guard).
//
// The `.tsx` imports are TYPE-ONLY (erased by strip-types); `@trustcircle/domain` resolves through
// the workspace, so no transpiler beyond Node's built-in type stripping is required.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  runHumanDecisionScenario,
  runFederatedJointApprovalScenario,
} from '../../human-decisions.ts';

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

function sign(manifestWithoutDigest) {
  const manifestDigest = `sha256:${createHash('sha256').update(canonical(manifestWithoutDigest)).digest('hex')}`;
  return { ...manifestWithoutDigest, manifestDigest };
}

// The pinned execution identity every result is bound to (User Story 2 / P1).
const VERSION = {
  feature: '001-governance-control-plane',
  userStory: 'US2',
  userStoryTitle: 'Make and Govern Human Decisions',
  priority: 'P1',
};

function buildManifest(scenario, scenarioTitle, result) {
  return sign({
    manifestVersion: 1,
    kind: 'scenario-result-manifest',
    scenario,
    scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/human-decisions.ts',
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

const scenario2 = buildManifest(
  'Scenario-2',
  'Make and Govern Human Decisions — the accessible, policy-bound decision queue',
  runHumanDecisionScenario(),
);
const scenario3 = buildManifest(
  'Scenario-3',
  'Federated Cross-Tenant Approval — three gates, independent central review, no evidence leak',
  runFederatedJointApprovalScenario(),
);

const outputs = [
  ['scenario2-human-decision.manifest.json', scenario2],
  ['scenario3-federated-joint.manifest.json', scenario3],
];

const check = process.argv.includes('--check');
let drift = false;
for (const [name, manifest] of outputs) {
  const path = join(HERE, name);
  const serialised = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    let onDisk = '';
    try {
      onDisk = readFileSync(path, 'utf8');
    } catch {
      onDisk = '';
    }
    if (onDisk !== serialised) {
      drift = true;
      console.error(`DRIFT: ${name} differs from freshly emitted manifest`);
    } else {
      console.log(`OK: ${name} (${manifest.manifestDigest})`);
    }
  } else {
    writeFileSync(path, serialised);
    console.log(`wrote ${name} — allSatisfied=${manifest.allSatisfied} digest=${manifest.manifestDigest}`);
  }
}

if (!scenario2.allSatisfied || !scenario3.allSatisfied) {
  console.error('FAIL: a scenario has unsatisfied criteria');
  process.exit(1);
}
if (check && drift) process.exit(1);
