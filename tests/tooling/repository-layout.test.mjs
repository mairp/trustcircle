// Phase 8 acceptance test — repository directory-ownership map (task T008 / GAR-010 /
// VO-ec575c4ce42b548bfb4d). Makes docs/architecture/repository-layout.md an independently
// observable, enforced compatibility contract.
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): changes to inventory, decisions, lifecycle
// states, source contracts, evidence, mappings, and exports MUST preserve supported consumers
// or provide approved deprecation/migration/rollback/notice/compatibility evidence. The
// directory inventory and the source-contract paths in the map are a supported consumer
// surface. This suite asserts:
//   1. every `owners`/`contracts` row marked `present` exists on disk (present ⇒ exists),
//   2. every real workspace member (packages/apps/adapters) has an owners row,
//   3. every declared Vitest project has an owners row (map covers the test inventory),
//   4. every declared planned/present deploy + db directory is accounted for,
// so the map cannot silently drift from the inventory it governs. Node built-ins only →
// deterministic under `npm ci` with no adjacent environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const MAP = 'docs/architecture/repository-layout.md';

function fencedBlock(text, tag) {
  const re = new RegExp('```' + tag + '\\r?\\n([\\s\\S]*?)```', 'm');
  const m = text.match(re);
  assert.ok(m, `map must contain a \`\`\`${tag}\`\`\` block`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()));
}

// ---- Artifact presence -----------------------------------------------------
test('docs/architecture/repository-layout.md exists (T008 required artifact)', () => {
  assert.ok(existsSync(rel(MAP)), `${MAP} must exist`);
});

const src = existsSync(rel(MAP)) ? readFileSync(rel(MAP), 'utf8') : '';
const owners = src ? fencedBlock(src, 'owners') : [];
const contracts = src ? fencedBlock(src, 'contracts') : [];

// ---- The map names apps, packages, adapters, deployment, database, tests ---
test('map covers every required top-level area', () => {
  const paths = owners.map((r) => r[0]);
  const areas = ['apps/', 'packages/', 'adapters/', 'deploy/', 'db/', 'tests/'];
  for (const area of areas) {
    assert.ok(
      paths.some((p) => p.startsWith(area)),
      `owners table must include at least one ${area} row`,
    );
  }
});

// ---- Invariant 1: present ⇒ exists (owners + contracts) --------------------
test('every `present` owners row exists on disk (present ⇒ exists)', () => {
  for (const [path, owner, status] of owners) {
    assert.ok(
      status === 'present' || status === 'planned',
      `unknown status "${status}" for ${path}`,
    );
    assert.ok(owner && owner.length > 0, `owner required for ${path}`);
    if (status === 'present') {
      assert.ok(existsSync(rel(path)), `present owner path must exist on disk: ${path}`);
    }
  }
});

test('every `present` source-contract row exists on disk (present ⇒ exists)', () => {
  for (const [path, status, vo] of contracts) {
    assert.ok(vo && vo.length > 0, `contract row must cite a VO: ${path}`);
    if (status === 'present') {
      assert.ok(existsSync(rel(path)), `present source-contract must exist: ${path}`);
    }
  }
});

// ---- Invariant 2: map covers every real workspace member -------------------
test('every workspace member (packages/apps/adapters) has an owners row', () => {
  const declared = new Set(owners.map((r) => r[0]));
  for (const group of ['packages', 'apps', 'adapters']) {
    const members = readdirSync(rel(group), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(rel(join(group, d.name, 'package.json'))))
      .map((d) => `${group}/${d.name}`);
    for (const m of members) {
      assert.ok(declared.has(m), `workspace member ${m} must have an owners row (no silent drift)`);
    }
  }
});

// ---- Invariant 3: map covers every declared Vitest project -----------------
test('every declared Vitest project name has an owners row under tests/', async () => {
  const wf = await import(pathToFileURL(rel('vitest.workspace.ts')).href);
  assert.ok(
    Array.isArray(wf.PROJECT_NAMES),
    'PROJECT_NAMES must be exported by vitest.workspace.ts',
  );
  const declared = new Set(owners.map((r) => r[0]));
  for (const project of wf.PROJECT_NAMES) {
    assert.ok(
      declared.has(`tests/${project}`),
      `Vitest project "${project}" must have a tests/${project} owners row`,
    );
  }
});

// ---- Invariant 4: the source-contract paired artifacts are all mapped ------
test("this bundle's implemented source contracts are mapped as present with a VO", () => {
  const rowByPath = new Map(contracts.map((r) => [r[0], r]));
  const mustBePresent = [
    ['packages/evidence/src/retention.ts', 'VO-b9b935bf93be10bdecdd'],
    ['packages/authz/src/separation-of-duties.ts', 'VO-173f7afb7801f4ab3e29'],
    ['vitest.workspace.ts', 'VO-ec575c4ce42b548bfb4d'],
    ['apps/api/src/middleware/context.ts', 'VO-e4323651ab39776dcdbd'],
    ['adapters/wiggum/src/snapshot.ts', 'VO-d982977672dda011fc65'],
  ];
  for (const [path, vo] of mustBePresent) {
    const row = rowByPath.get(path);
    assert.ok(row, `source-contract ${path} must be in the contracts block`);
    assert.equal(row[1], 'present', `${path} must be marked present`);
    assert.equal(row[2], vo, `${path} must cite ${vo}`);
    assert.ok(existsSync(rel(path)), `${path} must exist on disk`);
  }
});

// ---- Change-discipline note is documented ----------------------------------
test('map documents the compatibility change discipline (GAR-010)', () => {
  assert.match(src, /VO-ec575c4ce42b548bfb4d/, 'map must cite the compatibility obligation');
  assert.match(
    src,
    /deprecation|migration|rollback/i,
    'map must state deprecation/migration/rollback discipline',
  );
});
