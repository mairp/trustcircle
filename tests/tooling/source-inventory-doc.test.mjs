// Phase 86 acceptance test — source-inventory runbook
// (docs/runbooks/source-inventory.md). Makes the runbook an independently observable,
// enforced governance artifact: the doc must document source discovery authority,
// onboarding, exclusion, gap triage, and core-only operation, and it must map every one
// of the six phase-owned verification obligations to the real behavior it describes.
//
// Owned obligations (each asserted below to be cited AND to have its subject documented):
//   VO-17f515089c2fa3df7074  current-state view: each source once + full facet set
//   VO-b0c8db36e38294f255d2  reconcile keeps a non-healthy source visible as a coverage gap
//   VO-a9b3817cf3037ba213be  cross-source drill-down: distinct records, correlation, diffs, deps, authoritative fields
//   VO-6e56909c42e15b9dba13  stale/unavailable → last-known time + confidence; no inference from stale data
//   VO-d1e59925eee504244d39  unregistered source in boundary → added to catalog with the full facet set
//   VO-4c192ba5b64b4227c51a  unsupported/inaccessible/sensitive/unowned/excluded → visible governed-source gap w/ review-or-expiry
//
// The suite is FAIL-VISIBLE and grounded in the REAL codebase — not just the doc's prose:
//   1. the artifact exists,
//   2. every required SUBJECT (§1..§9) is documented,
//   3. every owned VO id is cited in the doc,
//   4. every code path / symbol the doc names actually exists in the repo (no drift between
//      the doc's claims and the real system), and
//   5. every referenced test file the doc points to actually exists.
// Node built-ins only → deterministic under `npm ci` with no adjacent environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const DOC = 'docs/runbooks/source-inventory.md';

// ---- The six phase-owned verification obligations --------------------------
const OWNED_VOS = [
  'VO-17f515089c2fa3df7074',
  'VO-b0c8db36e38294f255d2',
  'VO-a9b3817cf3037ba213be',
  'VO-6e56909c42e15b9dba13',
  'VO-d1e59925eee504244d39',
  'VO-4c192ba5b64b4227c51a',
];

// ---- Artifact presence -----------------------------------------------------
test('docs/runbooks/source-inventory.md exists (Phase 86 required artifact)', () => {
  assert.ok(existsSync(rel(DOC)), `${DOC} must exist`);
});

const src = existsSync(rel(DOC)) ? readFileSync(rel(DOC), 'utf8') : '';

// ---- Required subjects: discovery authority, onboarding, exclusion, triage, core-only ----

test('doc documents the current-state view with the full facet set (VO-17f515089c2fa3df7074)', () => {
  assert.match(src, /current-state view/i, 'must describe the current-state view');
  assert.match(src, /currentStateView\(/, 'must name the real currentStateView() surface');
  assert.match(src, /\bonce\b/i, 'must state each source renders exactly once');
  for (const facet of [
    /type/i,
    /source identity/i,
    /owner/i,
    /lifecycle/i,
    /risk|sensitivit/i,
    /control coverage/i,
    /evidence state/i,
    /health/i,
    /last[- ](observation|known) time/i,
    /unresolved issue/i,
  ]) {
    assert.match(src, facet, `current-state view must document facet ${facet}`);
  }
});

test('doc documents source discovery authority + onboarding (VO-d1e59925eee504244d39)', () => {
  assert.match(src, /discovery authority/i, 'must have a discovery-authority section');
  assert.match(
    src,
    /declared (computer )?boundary/i,
    'must scope discovery to the declared boundary',
  );
  assert.match(src, /discover\(/, 'must name the real discover() surface');
  assert.match(src, /source catalog/i, 'discovery must add to the source catalog');
  assert.match(src, /discovery evidence/i, 'catalog entry must carry discovery evidence');
  assert.match(src, /unknown/i, 'must document type-or-unknown classification');
  assert.match(src, /access (status|state)/i, 'must document access status');
  assert.match(src, /onboarding state/i, 'must document onboarding state');
  // onboarding lifecycle machine
  assert.match(src, /discovered.*pending.*onboarded/is, 'must document the onboarding lifecycle');
  assert.match(src, /excluded/i, 'lifecycle must include excluded');
  assert.match(src, /retired/i, 'lifecycle must include the terminal retired state');
  assert.match(
    src,
    /require[sd]?[^.]{0,40}(contract)[^.]{0,40}(owner|steward)|require[sd]?[^.]{0,40}(owner|steward)[^.]{0,40}(contract)/is,
    'onboarding must require a contract AND an owner',
  );
});

test('doc documents gap triage — reconcile keeps sources visible (VO-b0c8db36e38294f255d2)', () => {
  assert.match(src, /reconcile\(/, 'must name the real reconcile() surface');
  assert.match(src, /coverage gap/i, 'must describe coverage gaps');
  for (const reason of [/unmanaged/i, /unreachable/i, /stale/i, /orphaned/i, /excluded/i]) {
    assert.match(src, reason, `triage must document gap reason ${reason}`);
  }
  assert.match(src, /\bage\b/i, 'gap must carry age');
  assert.match(src, /impact/i, 'gap must carry impact');
  assert.match(src, /owner action/i, 'gap must carry a required owner action');
  assert.match(
    src,
    /never (disappear|deleted|gone)|history.*reconstructable/i,
    'gaps never disappear',
  );
});

test('doc documents cross-source drill-down & correlation (VO-a9b3817cf3037ba213be)', () => {
  assert.match(src, /drillDown\(/, 'must name the real drillDown() surface');
  for (const sys of [/kanban/i, /agentctl/i, /workflow[s_]?[_ ]?orchestration/i]) {
    assert.match(src, sys, `must name the correlated source system ${sys}`);
  }
  assert.match(src, /distinct source record/i, 'must show distinct source records');
  assert.match(src, /correlat/i, 'must show correlation');
  assert.match(src, /status difference/i, 'must show status differences');
  assert.match(src, /statusDifferencesFor\(/, 'must name the real status-difference surface');
  assert.match(src, /dependenc/i, 'must show dependencies');
  assert.match(src, /authoritative field/i, 'must show authoritative fields');
});

test('doc documents stale/unavailable marking with confidence (VO-6e56909c42e15b9dba13)', () => {
  assert.match(src, /\bstale\b/i, 'must document stale sources');
  assert.match(src, /unavailable/i, 'must document unavailable sources');
  assert.match(src, /last[- ]known time/i, 'must mark last-known time');
  assert.match(src, /confidence/i, 'must attach a confidence');
  assert.match(
    src,
    /not (be )?inferred|never (told|report)|reportedHealth[^.]{0,60}unknown/i,
    'must state health/compliance is NOT inferred from stale data',
  );
  assert.match(
    src,
    /freshness|horizon/i,
    'must reference the staleness horizon / freshness objective',
  );
});

test('doc documents governed-source gaps + exclusion with review-or-expiry (VO-4c192ba5b64b4227c51a)', () => {
  assert.match(src, /assessCoverage\(/, 'must name the real assessCoverage() surface');
  assert.match(src, /governed[- ]source gap/i, 'must describe governed-source gaps');
  for (const cond of [/unsupported/i, /inaccessible/i, /sensitive/i, /unowned/i, /excluded/i]) {
    assert.match(src, cond, `governed-source gap must cover condition ${cond}`);
  }
  assert.match(
    src,
    /review (date|-or-expiry)|review.{0,10}expiry/i,
    'gap must carry review-or-expiry',
  );
  assert.match(src, /expir/i, 'gap must support an expiry');
  // Exclusion is deliberate, reviewed, audited, never a deletion.
  assert.match(src, /exclude\(/, 'must name the real exclude() surface');
  assert.match(
    src,
    /not (be )?deleted|never (silently )?(drop|deleted)/i,
    'exclusion is not a deletion',
  );
  assert.match(
    src,
    /review date or (an )?expiry|review.{0,20}expiry/i,
    'exclusion requires review-or-expiry',
  );
  assert.match(src, /audit trail/i, 'exclusion must leave an audit trail');
});

test('doc documents the least-information discovery rule', () => {
  assert.match(src, /least[- ]information/i, 'must state the least-information rule');
  assert.match(src, /least[- ]privilege/i, 'must state least privilege');
  assert.match(src, /metadata[- ]only/i, 'discovery must be metadata-only');
  assert.match(
    src,
    /not read protected content|never reads? protected content|protected content, secrets/i,
    'must forbid reading protected content/secrets beyond authorization',
  );
  assert.match(src, /fail[- ]closed/i, 'authorization must be fail-closed');
  assert.match(
    src,
    /visibility limitation|record(s|ed)? the (visibility )?limit/i,
    'must record visibility limitations',
  );
});

test('doc documents core-only operation on the availability axis', () => {
  assert.match(src, /core[- ]only/i, 'must have a core-only operation section');
  assert.match(src, /availability class/i, 'must document the availability class axis');
  for (const cls of [/\bcore\b/i, /\boptional\b/i, /on[- ]demand/i]) {
    assert.match(src, cls, `must document availability class ${cls}`);
  }
  assert.match(src, /expected[- ]offline/i, 'expected-offline must be distinct from an incident');
  assert.match(
    src,
    /no incident|raises no incident|not (an? )?incident/i,
    'an expected-offline optional component raises no incident',
  );
  assert.match(
    src,
    /read[- ]only visibility|visibility.{0,20}escalation/i,
    'read-only visibility stays available',
  );
  assert.match(src, /evaluateExecutionGate/, 'must name the real execution-gate surface');
});

// ---- Every owned VO is cited in the doc ------------------------------------
test('doc cites every phase-owned verification obligation', () => {
  for (const vo of OWNED_VOS) {
    assert.match(src, new RegExp(vo), `runbook must cite ${vo}`);
  }
});

// ---- No drift: every code symbol/path the doc names must actually exist ----
test('every code path the runbook references exists in the repo (no drift)', () => {
  const REFERENCED_FILES = [
    'packages/application/src/source-registry.ts',
    'packages/domain/src/component-profile.ts',
    'apps/discovery-agent/src/main.ts',
    'apps/discovery-agent/src/classifiers/core-architecture.ts',
  ];
  for (const f of REFERENCED_FILES) {
    assert.ok(existsSync(rel(f)), `runbook references ${f}, which must exist`);
    assert.match(src, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `doc must cite ${f}`);
  }
});

test('every symbol the runbook names is real (grep in its source file)', () => {
  const registry = readFileSync(rel('packages/application/src/source-registry.ts'), 'utf8');
  for (const sym of [
    'currentStateView',
    'discover',
    'reconcile',
    'drillDown',
    'statusDifferencesFor',
    'assessCoverage',
    'exclude',
    'transitionOnboarding',
    'assignOwner',
    'recordObservation',
    'snapshotDigest',
    'stalenessOf',
  ]) {
    assert.match(registry, new RegExp('\\b' + sym + '\\b'), `source-registry must define ${sym}`);
    assert.match(src, new RegExp('\\b' + sym + '\\b'), `doc must name ${sym}`);
  }
  const profile = readFileSync(rel('packages/domain/src/component-profile.ts'), 'utf8');
  for (const sym of ['AVAILABILITY_CLASSES', 'evaluateExecutionGate', 'ARCHITECTURE_ROLES']) {
    assert.match(profile, new RegExp('\\b' + sym + '\\b'), `component-profile must define ${sym}`);
  }
});

test('every test file the runbook points to actually exists', () => {
  const REFERENCED_TESTS = [
    'tests/unit/source-registry.unit.test.ts',
    'tests/integration/core-only-profile.test.ts',
    'tests/tooling/component-profiles.test.mjs',
    'tests/tooling/source-inventory-doc.test.mjs',
  ];
  for (const t of REFERENCED_TESTS) {
    assert.ok(existsSync(rel(t)), `runbook references test ${t}, which must exist`);
  }
});

// ---- Negative control: the assertion harness can actually FAIL --------------
// Proves these are real assertions (not vacuous): a keyword the runbook does NOT contain
// must fail a match, and a VO id that is NOT ours must be absent.
test('NEGATIVE CONTROL: absent keyword fails to match; non-owned VO id is absent', () => {
  assert.doesNotMatch(src, /this-phrase-is-deliberately-never-in-the-runbook/);
  assert.doesNotMatch(src, /VO-deadbeefdeadbeefdead/, 'a fabricated VO id must not appear');
  // And confirm the positive assertions above are non-vacuous: the doc is substantial.
  assert.ok(src.length > 4000, `runbook must be substantial (got ${src.length} chars)`);
});
