import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOperationsManifest,
  canonical,
  sha256,
} from '../../../scripts/ci/evidence-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const manifest = JSON.parse(read('specs/002-operations-command-center/evidence-manifest.json'));
assert.equal(manifest.feature, '002-operations-command-center');
assert.equal(manifest.inventoryDigest, sha256(canonical(manifest)));
assert.deepEqual(manifest, buildOperationsManifest());
for (const control of [
  'attentionRanking',
  'caseLifecycle',
  'serviceLevelPolicy',
  'authorityPlan',
  'apiContract',
]) {
  assert.ok(manifest.controls[control], `missing control version: ${control}`);
}

const audit = read('specs/002-operations-command-center/implementation-audit.md');
for (let i = 1; i <= 20; i += 1) {
  assert.match(audit, new RegExp(`FR-${String(i).padStart(3, '0')}\\b`));
}
for (let i = 1; i <= 10; i += 1) {
  assert.match(audit, new RegExp(`GAR-${String(i).padStart(3, '0')}\\b`));
  assert.match(audit, new RegExp(`SC-${String(i).padStart(3, '0')}\\b`));
}
for (const section of [
  'Baseline and preservation',
  'Owners and control versions',
  'Verification results',
  'Requirement traceability',
  'Rollback witness',
  'Known gaps and release decision',
]) {
  assert.match(audit, new RegExp(`## ${section}`));
}

const runbook = read('docs/runbooks/operations-command-center.md');
for (const section of [
  'Ownership',
  'Monitoring and alerting',
  'Failure handling',
  'Evidence-preserving rollback',
]) {
  assert.match(runbook, new RegExp(`## ${section}`));
}

process.stdout.write(
  `operations-audit-readiness: OK — ${manifest.artifacts.length} artifacts, complete FR/GAR/SC traceability, owned rollback\n`,
);
