import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { appendEvidence, validateEvidence } from '../../scripts/operator-console-evidence.mjs';

const base = {
  run_id: 'c00a3659-463d-44fb-96c0-f5f3efab97d8',
  task_ids: ['T004'],
  requirement_ids: ['FR-022'],
  actor: 'implementation-worker',
  environment: 'local-disposable',
  command: 'node --test example',
  started_at: '2026-08-04T00:00:00.000Z',
  ended_at: '2026-08-04T00:00:01.000Z',
  duration_ms: 1000,
  exit_code: 0,
  tests: { total: 1, passed: 1, failed: 0, skipped: 0 },
  result: 'pass',
  artifacts: [],
  digests: {},
  gaps: [],
};

test('validates and appends additive JSONL evidence', async () => {
  assert.deepEqual(validateEvidence(base), []);
  const dir = await mkdtemp(join(tmpdir(), 'tc-evidence-'));
  const path = join(dir, 'records.jsonl');
  await appendEvidence(path, base);
  const text = await readFile(path, 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.equal(JSON.parse(text).run_id, base.run_id);
});

test('rejects credentials and protected body markers', () => {
  assert.ok(
    validateEvidence({ ...base, command: 'curl -H "Authorization: Bearer secret"' }).length > 0,
  );
  assert.ok(validateEvidence({ ...base, gaps: ['foreign-tenant-body=canary'] }).length > 0);
});
