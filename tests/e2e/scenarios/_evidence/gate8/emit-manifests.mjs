// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 (GATE8) — signed SCENARIO 9–11 + profile evidence-manifest emitter (T272).
//
// Runs the two node-safe US6 acceptance runners over the fixed integrations world
// (tests/fixtures/integrations.ts) and emits the signed result manifests that back
// docs/runbooks/ecosystem-integrations.md:
//
//   • scenario9-kanban-projection.manifest.json         — Kanban-projection JOURNEY manifest (Kanban
//                                                          adapter line only). FR-008/FR-029.
//   • scenario10-workflow-agentctl.manifest.json        — workflow_orchestration + agentctl JOURNEY
//                                                          manifest (those two adapter lines only).
//                                                          FR-008/FR-029, NS-005.
//   • scenario11-connector-resilience.manifest.json     — connector-resilience runner. FR-029/FR-030,
//                                                          SC-011 (outage, bounded retry, dead letter,
//                                                          replay→exactly-one-effect, reconciliation,
//                                                          order-independent projection rebuild).
//   • profile-core-only-activation.manifest.json        — core-only activation PROFILE journey manifest
//                                                          (core activation line + full optional gap
//                                                          inventory, NO adapter lines). NFR-010, SC-024.
//
// DISTINCT PER-JOURNEY EVIDENCE. Scenario 9, Scenario 10, and the core-only profile are DISTINCT
// journeys. Each is emitted as its OWN signed `journey-result-manifest` via projectJourneyManifest():
// the manifest carries a `journeyScope` discriminator and ONLY that journey's content (Scenario 9 =
// the Kanban adapter line; Scenario 10 = workflow_orchestration + agentctl lines; profile = the core
// activation line + full optional gap inventory, no adapter lines). Every digest is recomputed over
// the reduced content, so the three journeys have THREE DISTINCT digests — a drift in the Kanban
// journey changes only scenario9's digest and can never be masked by the agentctl or profile journey.
// verifyJourneyManifest re-derives each from a fresh full run AND asserts no two journeys share a
// digest, so the artifacts are independently falsifiable, not copies under different names.
//
// SIGNING. Each runner canonicalises its manifest (sorted-key JSON, excluding the self-reference
// digest/signature fields) and hashes it with sha256 into `manifestDigest` + a bound `signature`.
// The runners are deterministic (fixed `NOW`, no randomness, no I/O), so re-emitting over the same
// durable fixture reproduces byte-identical digests — the non-repudiation property. Before writing,
// each manifest is re-checked through its OWN independent verifier; a manifest that does not verify is
// never written and the emitter exits non-zero.
//
// Usage:  node --experimental-strip-types tests/e2e/scenarios/_evidence/gate8/emit-manifests.mjs [--check]
//   (default) writes the four manifests next to this file.
//   --check   re-emits in memory and fails if any on-disk manifest differs (drift guard).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  emitNamedAdaptersManifest,
  verifyNamedAdaptersManifest,
  JOURNEYS,
  projectJourneyManifest,
  verifyJourneyManifest,
} from '../../named-adapters.ts';
import {
  emitConnectorResilienceManifest,
  verifyConnectorResilienceManifest,
} from '../../connector-resilience.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');

// Guard: the emit/write block runs ONLY when this file is executed directly as a script, NEVER on
// import — so importing it (e.g. to reuse a helper) can never rewrite the committed manifests as a
// side effect (the filesystem-race class of defect).
const INVOKED_DIRECTLY = process.argv[1] === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  main();
}

function main() {

/** Serialise a manifest and either write it or drift-check it. Returns true on drift (check mode). */
function persist(name, manifest) {
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
      console.error(`DRIFT: ${name} differs from freshly emitted manifest`);
      return true;
    }
    console.log(`OK: ${name} (${manifest.manifestDigest.slice(0, 16)}…)`);
    return false;
  }
  writeFileSync(path, serialised);
  console.log(`wrote ${name} — digest=${manifest.manifestDigest.slice(0, 16)}…`);
  return false;
}

// ── Emit the base runs (deterministic). ──────────────────────────────────────────────────────────
const named = emitNamedAdaptersManifest();
const resilience = emitConnectorResilienceManifest();

// ── Project the THREE distinct per-journey manifests from the single full named-adapters run. ─────
// Each carries only its own journey's content, so each has a distinct digest.
const journeyByScope = new Map(JOURNEYS.map((j) => [j.scope, projectJourneyManifest(j, named)]));
const j9 = journeyByScope.get('scenario-9-kanban-projection');
const j10 = journeyByScope.get('scenario-10-workflow-agentctl');
const jProfile = journeyByScope.get('profile-core-only-activation');

// ── Independently verify each BEFORE writing — never persist a manifest that does not verify. ─────
const failures = [];
const namedVerdict = verifyNamedAdaptersManifest(named);
if (!namedVerdict.ok) failures.push(`named-adapters: ${namedVerdict.reasons.join('; ')}`);
const resilienceVerdict = verifyConnectorResilienceManifest(resilience);
if (!resilienceVerdict.ok) failures.push(`connector-resilience: ${resilienceVerdict.reasons.join('; ')}`);
for (const [scope, m] of journeyByScope) {
  const v = verifyJourneyManifest(m);
  if (!v.ok) failures.push(`journey ${scope}: ${v.reasons.join('; ')}`);
}

if (failures.length > 0) {
  console.error('FAIL: a US6 scenario/journey manifest did not verify:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// ── Distinctness invariant — the three journey digests MUST be pairwise distinct (the whole point of
//    T272: per-journey evidence, so a drift in one journey cannot be masked by another). ──────────
const journeyDigests = [
  ['scenario9-kanban', j9.manifestDigest],
  ['scenario10-workflow-agentctl', j10.manifestDigest],
  ['profile-core-only', jProfile.manifestDigest],
];
const seen = new Map();
for (const [name, d] of journeyDigests) {
  if (seen.has(d)) {
    console.error(`FAIL: journeys ${seen.get(d)} and ${name} share digest ${d.slice(0, 16)}… (not distinct evidence)`);
    process.exit(1);
  }
  seen.set(d, name);
}

// Determinism proof — re-emit / re-project and compare digests.
const namedAgain = emitNamedAdaptersManifest();
const resilienceAgain = emitConnectorResilienceManifest();
if (namedAgain.manifestDigest !== named.manifestDigest) {
  console.error('FAIL: named-adapters manifest is non-deterministic');
  process.exit(1);
}
if (resilienceAgain.manifestDigest !== resilience.manifestDigest) {
  console.error('FAIL: connector-resilience manifest is non-deterministic');
  process.exit(1);
}
for (const j of JOURNEYS) {
  const a = projectJourneyManifest(j, named).manifestDigest;
  const b = projectJourneyManifest(j).manifestDigest; // fresh full run inside
  if (a !== b) {
    console.error(`FAIL: journey ${j.scope} manifest is non-deterministic`);
    process.exit(1);
  }
}

// ── Write the four scenario / profile evidence files — each a DISTINCT signed journey/scenario. ───
let drift = false;
drift = persist('scenario9-kanban-projection.manifest.json', j9) || drift;
drift = persist('scenario10-workflow-agentctl.manifest.json', j10) || drift;
drift = persist('scenario11-connector-resilience.manifest.json', resilience) || drift;
drift = persist('profile-core-only-activation.manifest.json', jProfile) || drift;

if (check && drift) {
  console.error('FAIL: manifest drift detected');
  process.exit(1);
}
  console.log(
    check
      ? 'OK: all four US6 evidence manifests match their freshly emitted, independently verified form'
      : 'wrote all four US6 evidence manifests (each independently verified before writing)',
  );
}
