// Phase 85 — Scenario 1 SIGNED RESULT MANIFEST (browserless Playwright `discovery` project).
// Work item 73TQ0YZ16SPVKR0PNRDJTH8C43 · requirement RKMR5H2VVV7B7KQAEEY2D8CDXG (US1) ·
// acceptance US1-AS1..US1-AS6.
//
// This spec runs under the browserless `discovery` Playwright project (testMatch
// /discovery-.*\.spec\.ts/). It never touches `page`; it drives the manifest emitter
// tests/e2e/scenarios/discovery-open-boundary.ts (which itself runs the REAL governed discovery
// agent) and asserts the emitted manifest is signed, tamper-evident, pinned to the bundle, and
// binds every acceptance criterion to independent-read-path evidence and visible gap references.
// Each positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous.
//
// Run: npm run test:e2e:discovery   (TC_NO_WEBSERVER=1 playwright test --project=discovery)

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'tests/e2e/scenarios/discovery-open-boundary.ts'));

const {
  emitScenario1ResultManifest,
  verifyScenario1ResultManifest,
  canonicalize,
  PINNED,
  SCENARIO1_ACCEPTANCE,
} = mod as typeof import('./scenarios/discovery-open-boundary.ts');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const deep = <T>(o: T): T => JSON.parse(JSON.stringify(o));

test.describe('Scenario 1 signed result manifest', () => {
  test('emits a signed, pinned, tamper-evident manifest that verifies', async () => {
    const manifest = await emitScenario1ResultManifest();

    // Signed: the stored digest equals a fresh sha256 over the canonical manifest.
    expect(sha256(canonicalize(manifest))).toBe(manifest.manifestDigest);
    expect(manifest.signature.algorithm).toBe('sha256');

    // Pinned execution identity (version references).
    expect(manifest.version.bundleId).toBe(PINNED.bundleId);
    expect(manifest.version.contentHash).toBe(PINNED.contentHash);
    expect(manifest.version.workItemId).toBe('73TQ0YZ16SPVKR0PNRDJTH8C43');

    // Positive: the untouched manifest verifies.
    expect(verifyScenario1ResultManifest(manifest).ok).toBe(true);

    // NEGATIVE control: a single tampered byte breaks the signature.
    const tampered = deep(manifest);
    (tampered.lines[0].evidence[0] as { witnessed: string[] }).witnessed[0] += '_X';
    expect(sha256(canonicalize(tampered))).not.toBe(tampered.manifestDigest);
    expect(verifyScenario1ResultManifest(tampered).ok).toBe(false);
  });

  test('binds requirement / assertion / audit references for every US1-AS{n}', async () => {
    const manifest = await emitScenario1ResultManifest();
    expect(manifest.lines).toHaveLength(6);
    for (const spec of SCENARIO1_ACCEPTANCE) {
      const line = manifest.lines.find((l) => l.assertionRef === spec.assertionRef)!;
      expect(line).toBeTruthy();
      expect(line.requirementRef).toBe('RKMR5H2VVV7B7KQAEEY2D8CDXG');
      expect(line.auditRef.obligationRef).toBe(spec.obligationRef);
      expect(line.auditRef.obligationRef).toMatch(/^VO-[0-9a-f]{20}$/);
      expect(line.assertionText).toBe(spec.text);
      expect(line.evidence.length).toBeGreaterThanOrEqual(1);
    }

    // NEGATIVE control: removing an acceptance line fails verification.
    const missing = deep(manifest);
    missing.lines = missing.lines.filter((l) => l.assertionRef !== 'US1-AS3');
    const v = verifyScenario1ResultManifest(missing);
    expect(v.ok).toBe(false);
    expect(v.reasons.some((r) => /missing acceptance line US1-AS3/.test(r))).toBe(true);
  });

  test('gap references stay visible with reason + specific owner action', async () => {
    const manifest = await emitScenario1ResultManifest();
    const ids = manifest.gapRegister.map((g) => g.targetId).sort();
    expect(ids).toContain('kanban:board-denied'); // unmanaged
    expect(ids).toContain('agentctl:agent-down'); // unreachable
    expect(ids).toContain('secretstore:vault-1'); // excluded
    for (const g of manifest.gapRegister) {
      expect(g.ownerAction).not.toBe('investigate');
      expect(g.ownerAction.length).toBeGreaterThan(0);
    }

    // NEGATIVE control: a gap that "looks healthy" (unknown reason + generic action) is rejected.
    const bad = deep(manifest);
    bad.gapRegister[0].gapReason = 'looks_healthy' as never;
    bad.gapRegister[0].ownerAction = 'investigate';
    expect(verifyScenario1ResultManifest(bad).ok).toBe(false);
  });

  test('the five Scenario-1 success criteria are present and met', async () => {
    const manifest = await emitScenario1ResultManifest();
    const ids = manifest.successCriteria.map((s) => s.id).sort();
    expect(ids).toEqual(['SC-001', 'SC-002', 'SC-017', 'SC-018', 'SC-019']);
    for (const s of manifest.successCriteria) expect(s.met).toBe(true);

    // NEGATIVE control: an unmet SC fails verification.
    const unmet = deep(manifest);
    unmet.successCriteria.find((s) => s.id === 'SC-019')!.met = false;
    expect(verifyScenario1ResultManifest(unmet).ok).toBe(false);
  });
});
