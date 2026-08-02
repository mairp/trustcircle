// Gate 85 evidence driver — emits the signed Scenario-1 result manifest sample and
// exercises determinism + tamper/mis-pin negative controls against the independent oracle.
// Run: node --experimental-strip-types tests/e2e/scenarios/_evidence/gate85/emit-and-negative-controls.mjs
import { writeFileSync } from 'node:fs';
import {
  emitScenario1ResultManifest,
  verifyScenario1ResultManifest,
  canonicalize,
} from '../../discovery-open-boundary.ts';

const here = new URL('.', import.meta.url).pathname;

// --- Emit twice for determinism (digestA == digestB over identical observed facts) ---------
const a = await emitScenario1ResultManifest();
const b = await emitScenario1ResultManifest();

const digestA = a.manifestDigest;
const digestB = b.manifestDigest;
const deterministic = digestA === digestB;

// --- Positive control: the untouched manifest verifies -------------------------------------
const okPos = verifyScenario1ResultManifest(a);

// --- Negative control 1: tamper a single evidence witness byte -> signature rejects ---------
const tampered = JSON.parse(JSON.stringify(a));
tampered.lines[0].evidence[0].witnessed[0] =
  String(tampered.lines[0].evidence[0].witnessed[0]) + '_TAMPERED';
const okTamper = verifyScenario1ResultManifest(tampered);

// --- Negative control 2: mis-pin the bundle id -> pinned-identity check rejects -------------
const mispinned = JSON.parse(JSON.stringify(a));
mispinned.version.bundleId = 'WRONGBUNDLEID000000000000000';
const okMispin = verifyScenario1ResultManifest(mispinned);

// --- Negative control 3: drop an acceptance line -> coverage check rejects ------------------
const dropped = JSON.parse(JSON.stringify(a));
dropped.lines = dropped.lines.slice(1);
const okDropped = verifyScenario1ResultManifest(dropped);

// --- Negative control 4: force an SC unmet -> success-criteria check rejects ----------------
const unmet = JSON.parse(JSON.stringify(a));
unmet.successCriteria[0].met = false;
const okUnmet = verifyScenario1ResultManifest(unmet);

// --- Negative control 5: drop an FR MUST-clause witness -> FR-coverage check rejects ---------
const droppedFr = JSON.parse(JSON.stringify(a));
droppedFr.frClauses = droppedFr.frClauses.filter((c) => c.frId !== 'FR-006');
const okDroppedFr = verifyScenario1ResultManifest(droppedFr);

// --- Emit the sample manifest (committed-visible) ------------------------------------------
writeFileSync(here + 'manifest-sample.json', JSON.stringify(a, null, 2) + '\n');

// --- Emit the negative-controls log --------------------------------------------------------
const lines = [];
lines.push('Gate 85 — determinism + negative-control witness (independent oracle)');
lines.push('');
lines.push(`determinism: digestA=${digestA}`);
lines.push(`determinism: digestB=${digestB}`);
lines.push(`determinism: digestA==digestB -> ${deterministic ? 'PASS' : 'FAIL'}`);
lines.push('');
lines.push(
  `positive control (untouched manifest) verify.ok=${okPos.ok} -> ${okPos.ok ? 'PASS' : 'FAIL'}`,
);
lines.push('');
lines.push('negative controls (each MUST be rejected -> verify.ok=false):');
lines.push(
  `  1. tampered evidence witness   verify.ok=${okTamper.ok} rejected=${!okTamper.ok} -> ${!okTamper.ok ? 'PASS' : 'FAIL'}`,
);
lines.push(`     reasons: ${okTamper.reasons.join('; ')}`);
lines.push(
  `  2. mis-pinned bundle id        verify.ok=${okMispin.ok} rejected=${!okMispin.ok} -> ${!okMispin.ok ? 'PASS' : 'FAIL'}`,
);
lines.push(`     reasons: ${okMispin.reasons.join('; ')}`);
lines.push(
  `  3. dropped acceptance line     verify.ok=${okDropped.ok} rejected=${!okDropped.ok} -> ${!okDropped.ok ? 'PASS' : 'FAIL'}`,
);
lines.push(`     reasons: ${okDropped.reasons.join('; ')}`);
lines.push(
  `  4. forced-unmet success crit   verify.ok=${okUnmet.ok} rejected=${!okUnmet.ok} -> ${!okUnmet.ok ? 'PASS' : 'FAIL'}`,
);
lines.push(`     reasons: ${okUnmet.reasons.join('; ')}`);
lines.push(
  `  5. dropped FR MUST-clause      verify.ok=${okDroppedFr.ok} rejected=${!okDroppedFr.ok} -> ${!okDroppedFr.ok ? 'PASS' : 'FAIL'}`,
);
lines.push(`     reasons: ${okDroppedFr.reasons.join('; ')}`);
lines.push('');
lines.push(
  `frClauses witnessed: ${a.frClauses.length} (${a.frClauses.map((c) => c.frId).join(', ')})`,
);
lines.push('');

const allPass =
  deterministic &&
  okPos.ok &&
  !okTamper.ok &&
  !okMispin.ok &&
  !okDropped.ok &&
  !okUnmet.ok &&
  !okDroppedFr.ok;
lines.push(`OVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
writeFileSync(here + 'negative-controls.txt', lines.join('\n') + '\n');

// --- Sanity to stdout so the capturing run log shows outcomes ------------------------------
console.log(lines.join('\n'));
console.log('');
console.log(
  `manifest-sample.json written: verify.ok=${okPos.ok}, digest=${digestA}, lines=${a.lines.length}, gaps=${a.gapRegister.length}, successCriteria=${a.successCriteria.length}, frClauses=${a.frClauses.length}`,
);
if (!allPass) process.exitCode = 1;

// canonicalize is imported to assert it is exported and used by the oracle path.
void canonicalize;
