// Phase 85 — Scenario 1 SIGNED RESULT MANIFEST verification obligations.
// Work item 73TQ0YZ16SPVKR0PNRDJTH8C43 · requirement RKMR5H2VVV7B7KQAEEY2D8CDXG (US1) ·
// acceptance US1-AS1..US1-AS6 · integration effect-witness obligations VO-a990a985…, VO-62c43281…,
// VO-9f597528…, VO-2f3b4fef…, VO-7e4075d3…, VO-60db0834… (verification-plan
// verification-90012e69317ff71a927b).
//
// Oracle: the emitter tests/e2e/scenarios/discovery-open-boundary.ts MUST run the REAL governed
// discovery agent over a Scenario-1 boundary and emit a SIGNED result manifest binding — for every
// acceptance criterion — its requirement, assertion, audit, evidence, version, and gap references,
// where every fact is observed through an INDEPENDENT read path (reconciled SourceCatalog, durable
// evidence sink, durable checkpoint), never a mutation return value.
//
// Independently observable: this test imports the emitter, re-derives the signature and every
// per-line digest with Node's own crypto, and checks the pinned identity — so a manifest that is
// unsigned, tampered, mis-pinned, or missing any obligation FAILS. Every positive assertion is
// paired with a NEGATIVE control (a mutated manifest) so the oracle is non-vacuous.
//
// Run: npm run test:discovery
//      (node --experimental-strip-types --test tests/discovery/**/*.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'tests/e2e/scenarios/discovery-open-boundary.ts'));

const {
  emitScenario1ResultManifest,
  verifyScenario1ResultManifest,
  canonicalize,
  runScenario1,
  PINNED,
  SCENARIO1_ACCEPTANCE,
  SCENARIO1_SUCCESS_CRITERIA,
  GAP_REASONS,
} = mod;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const deep = (o) => JSON.parse(JSON.stringify(o));

// A single emitted manifest reused by the read-only structural assertions below.
const manifest = await emitScenario1ResultManifest();

// ── 1. VERSION references — pinned execution identity is present and correct ──────────────────
test('AS-version: manifest binds the pinned bundle / content hash / work item / plan version', () => {
  assert.equal(manifest.version.bundleId, PINNED.bundleId);
  assert.equal(manifest.version.contentHash, PINNED.contentHash);
  assert.equal(manifest.version.bundleVersion, 2);
  assert.equal(manifest.version.workItemId, '73TQ0YZ16SPVKR0PNRDJTH8C43');
  assert.equal(manifest.version.requirementRef, 'RKMR5H2VVV7B7KQAEEY2D8CDXG');
  assert.equal(manifest.version.verificationPlanId, 'verification-90012e69317ff71a927b');
  assert.equal(manifest.version.verificationPlanVersion, 1);

  // NEGATIVE control: a manifest bound to a DIFFERENT bundle must be rejected by the verifier.
  const forged = deep(manifest);
  forged.version.bundleId = 'DIFFERENTBUNDLE00000000000';
  const v = verifyScenario1ResultManifest(forged);
  assert.equal(v.ok, false);
  assert.ok(
    v.reasons.some((r) => /bundle id/.test(r)),
    'mis-pinned bundle id must be flagged',
  );
});

// ── 2. SIGNATURE — recomputing the digest over the canonical manifest matches ─────────────────
test('AS-signature: the manifest is signed (sha256 over canonical form) and tamper-evident', () => {
  const recomputed = sha256(canonicalize(manifest));
  assert.equal(
    recomputed,
    manifest.manifestDigest,
    'stored digest must equal the recomputed digest',
  );
  assert.equal(manifest.signature.algorithm, 'sha256');
  assert.equal(manifest.signature.digest, manifest.manifestDigest);

  // POSITIVE: the untouched manifest verifies.
  assert.equal(verifyScenario1ResultManifest(manifest).ok, true);

  // NEGATIVE control: flip one byte of a witnessed value → digest no longer matches → rejected.
  const tampered = deep(manifest);
  tampered.lines[0].evidence[0].witnessed[0] =
    tampered.lines[0].evidence[0].witnessed[0] + '_TAMPERED';
  const recomputedTampered = sha256(canonicalize(tampered));
  assert.notEqual(
    recomputedTampered,
    tampered.manifestDigest,
    'a tampered body must not match the stored digest',
  );
  const v = verifyScenario1ResultManifest(tampered);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /manifestDigest mismatch/.test(r)));
});

// ── 3. PER-LINE digests are chained — mutating one line invalidates only that line's digest ───
test('AS-line-digest: each acceptance line carries its own verifiable digest', () => {
  for (const line of manifest.lines) {
    const { lineDigest, ...rest } = line;
    assert.equal(
      sha256(canonicalize(rest)),
      lineDigest,
      `${line.assertionRef} line digest must verify`,
    );
  }
  // NEGATIVE control: replace a line's assertionText but keep its old digest → detected.
  const tampered = deep(manifest);
  tampered.lines[2].assertionText = 'FORGED assertion text';
  const v = verifyScenario1ResultManifest(tampered);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /line US1-AS3 digest mismatch/.test(r)));
});

// ── 4. REQUIREMENT + ASSERTION + AUDIT references — one line per acceptance criterion ─────────
test('AS-refs: every US1-AS{n} line references the requirement, assertion, and audit obligation', () => {
  assert.equal(manifest.lines.length, 6);
  for (const spec of SCENARIO1_ACCEPTANCE) {
    const line = manifest.lines.find((l) => l.assertionRef === spec.assertionRef);
    assert.ok(line, `line for ${spec.assertionRef} must exist`);
    assert.equal(line.requirementRef, 'RKMR5H2VVV7B7KQAEEY2D8CDXG'); // requirement reference
    assert.equal(line.auditRef.obligationRef, spec.obligationRef); // audit reference (VO-…)
    assert.match(line.auditRef.obligationRef, /^VO-[0-9a-f]{20}$/);
    assert.equal(line.auditRef.verificationPlanId, 'verification-90012e69317ff71a927b');
    assert.equal(line.assertionText, spec.text); // verbatim Given/When/Then
  }
  // NEGATIVE control: drop an acceptance line → verifier reports the missing criterion.
  const missing = deep(manifest);
  missing.lines = missing.lines.filter((l) => l.assertionRef !== 'US1-AS5');
  const v = verifyScenario1ResultManifest(missing);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /missing acceptance line US1-AS5/.test(r)));
});

// ── 5. EVIDENCE — each line's evidence comes from an independent read path & is non-empty ─────
test('AS-evidence: each acceptance line has independent-read-path evidence with concrete witnesses', () => {
  const READ_PATHS = new Set(['source-catalog', 'evidence-sink', 'checkpoint-store']);
  for (const line of manifest.lines) {
    assert.ok(line.evidence.length >= 1, `${line.assertionRef} must have >=1 evidence witness`);
    for (const w of line.evidence) {
      assert.ok(
        READ_PATHS.has(w.readPath),
        `${line.assertionRef} read path must be independent (${w.readPath})`,
      );
      assert.ok(w.witnessed.length >= 1, `${line.assertionRef} witness must be concrete`);
      for (const wit of w.witnessed)
        assert.ok(!/MISSING/.test(wit), `${line.assertionRef} witness must not be MISSING: ${wit}`);
    }
  }
  // NEGATIVE control: empty a line's witness set → verifier flags the empty witness.
  const emptied = deep(manifest);
  emptied.lines[0].evidence[0].witnessed = [];
  const v = verifyScenario1ResultManifest(emptied);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /empty\/missing evidence witness/.test(r)));
});

// ── 6. GAP references — the seeded gaps are visible with reason + specific owner action ────────
test('AS-gaps: unmanaged/unreachable/excluded remain visible gaps with reason + owner action', () => {
  const byId = (id) => manifest.gapRegister.find((g) => g.targetId === id);
  const unmanaged = byId('kanban:board-denied');
  const unreachable = byId('agentctl:agent-down');
  const excluded = byId('secretstore:vault-1');
  assert.equal(unmanaged?.gapReason, 'unauthorized');
  assert.equal(unmanaged?.ownerAction, 'grant_or_approve_access');
  assert.equal(unreachable?.gapReason, 'probe_failed');
  assert.equal(unreachable?.ownerAction, 'restore_reachability');
  assert.equal(excluded?.gapReason, 'out_of_scope');
  assert.equal(excluded?.ownerAction, 'confirm_exclusion_or_extend_scope');
  for (const g of manifest.gapRegister) assert.ok(GAP_REASONS.includes(g.gapReason));

  // AS2 & AS6 lines carry the RELEVANT gap references.
  const as2 = manifest.lines.find((l) => l.assertionRef === 'US1-AS2');
  assert.deepEqual(as2.gapRefs.map((g) => g.targetId).sort(), [
    'agentctl:agent-down',
    'kanban:board-denied',
    'secretstore:vault-1',
  ]);
  const as6 = manifest.lines.find((l) => l.assertionRef === 'US1-AS6');
  assert.deepEqual(as6.gapRefs.map((g) => g.targetId).sort(), [
    'agentctl:agent-down',
    'secretstore:vault-1',
  ]);

  // NEGATIVE control: a gap with an unknown reason / generic owner action must be rejected.
  const bad = deep(manifest);
  bad.gapRegister[0].gapReason = 'made_up_reason';
  bad.gapRegister[0].ownerAction = 'investigate';
  const v = verifyScenario1ResultManifest(bad);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /unknown reason|lacks a specific owner action/.test(r)));
});

// ── 7. SUCCESS CRITERIA — the five Scenario-1 thresholds are present and met by observed facts ─
test('SC: the five Scenario-1 success criteria are present and met from observed facts', () => {
  const ids = manifest.successCriteria.map((s) => s.id).sort();
  assert.deepEqual(ids, ['SC-001', 'SC-002', 'SC-017', 'SC-018', 'SC-019']);
  for (const s of manifest.successCriteria) {
    assert.equal(s.met, true, `${s.id} must be met: ${s.measure}`);
    assert.ok(s.measure.length > 0);
    const spec = SCENARIO1_SUCCESS_CRITERIA.find((x) => x.id === s.id);
    assert.equal(s.text, spec.text); // verbatim threshold text
  }
  // NEGATIVE control: an unmet SC must make the verifier fail.
  const unmet = deep(manifest);
  unmet.successCriteria.find((s) => s.id === 'SC-017').met = false;
  const v = verifyScenario1ResultManifest(unmet);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => /SC-017 not met/.test(r)));
});

// ── 8. LEAST-PRIVILEGE — the out-of-scope target is NEVER probed; evidence is metadata-only ────
test('SC-019 witness: the out-of-scope target is never probed and evidence is metadata-only', async () => {
  const obs = await runScenario1();
  // Independent read path: the probe's own call log never contains the excluded (out-of-scope) target.
  assert.ok(
    !obs.probeCalls.includes('secretstore:vault-1'),
    'least privilege: out-of-scope target must never be probed',
  );
  // POSITIVE: in-scope authorized sources WERE probed (proves the check is non-vacuous).
  assert.ok(obs.probeCalls.includes('kanban:board-42'));
  // Every flushed evidence payload is metadata-only (no content/secret-bearing keys).
  const FORBIDDEN = /^(content|body|secret|password|token|credential|privateKey|apiKey)$/i;
  for (const r of obs.flushedEvidence) {
    const p = r.payload ?? {};
    for (const k of Object.keys(p))
      assert.ok(!FORBIDDEN.test(k), `payload key ${k} must be metadata-only`);
  }
});

// ── 9. RECONCILIATION — two sweeps do not duplicate rows (each item appears once) ─────────────
test('AS1 witness: reconciliation keeps each item exactly once across two sweeps', async () => {
  const obs = await runScenario1();
  const ids = obs.catalogEntries.map((e) => e.targetId);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate catalog rows after re-observation');
  for (const id of ['kanban:board-42', 'agentctl:agent-7', 'workflows_orchestration:wf-9']) {
    assert.equal(
      obs.catalogEntries.filter((e) => e.targetId === id).length,
      1,
      `${id} appears exactly once`,
    );
  }
});
