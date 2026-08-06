// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 (GATE7) — signed SCENARIO 9 result-manifest emitter (T218).
//
// Runs the standards-applicability & audit-readiness acceptance runner
// (tests/e2e/scenarios/standards-applicability.ts) over the fixed compliance world
// (tests/fixtures/compliance.ts) and emits the signed result manifest:
//
//   • scenario9-standards-applicability.manifest.json — FR-031..035, FR-051..056, SC-012, SC-013, SC-022.
//
// SCENARIO 10 (compliance-surfaces ACCESSIBILITY) is emitted by its sibling vitest emitter
// (emit-scenario10.test.ts), NOT here: its runner audits the SHIPPED `.tsx` compliance presenters
// (CoverageView / ApplicabilityReview / EvidenceExplorer / AuditExplorer) via the accessibility oracle,
// and Node's built-in TypeScript support (`--experimental-strip-types`) refuses the `.tsx` extension, so
// that manifest must be produced under a runner that transforms `.tsx` (vitest). This emitter is the
// node-safe half — Scenario 9 (`runStandardsApplicabilityScenario`) is SYNC and `.tsx`-free, depending
// only on the fixture (`.tsx` type-only) and @trustcircle/{domain,application,persistence}.
//
// SIGNING. The manifest is canonicalised (sorted-key JSON) and hashed with Node's built-in crypto
// (sha256) into a top-level `manifestDigest`; the runner is deterministic (no clock, no randomness), so
// re-running over the same durable fixture reproduces byte-identical digests — the non-repudiation property.
//
// Usage:  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate7/emit-manifests.mjs [--check]
//   (default) writes the manifest next to this file.
//   --check   re-emits in memory and fails if the on-disk manifest differs (drift guard).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { buildComplianceInputs, runStandardsApplicabilityScenario } from '../../standards-applicability.ts';

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

// The pinned execution identity every result is bound to (User Story 5 / P2).
export const VERSION = {
  feature: '001-governance-control-plane',
  userStory: 'US5',
  userStoryTitle: 'Demonstrate Compliance and Audit Readiness',
  priority: 'P2',
};

export function buildManifest(scenario, scenarioTitle, result) {
  return sign({
    manifestVersion: 1,
    kind: 'scenario-result-manifest',
    scenario,
    scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/standards-applicability.ts',
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

// ── Script entrypoint ──────────────────────────────────────────────────────────────────────────
// This block runs ONLY when the file is executed directly (`node … emit-manifests.mjs [--check]`).
// When the module is *imported* (e.g. emit-scenario10.test.ts reuses `buildManifest`/`persist`), the
// guard is false so importing has NO filesystem side effects — importing must never rewrite or churn
// the committed scenario9 manifest, which is what kept its mtime moving under the orchestrator snapshot.
const INVOKED_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);

if (INVOKED_DIRECTLY) {
  const scenario9 = buildManifest(
    'Scenario-9',
    'Demonstrate Compliance and Audit Readiness — standards registry, independent applicability, coverage without inference, reproducible signed export, truthful boundaries',
    runStandardsApplicabilityScenario(buildComplianceInputs()),
  );

  const check = process.argv.includes('--check');
  const drift = persist(HERE, 'scenario9-standards-applicability.manifest.json', scenario9, check);

  if (!scenario9.allSatisfied) {
    console.error('FAIL: Scenario 9 has unsatisfied criteria');
    process.exit(1);
  }
  if (check && drift) process.exit(1);
}
