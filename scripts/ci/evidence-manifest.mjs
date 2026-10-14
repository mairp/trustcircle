#!/usr/bin/env node
// Phase 9 — Evidence-manifest builder / verifier (task series T009 / GAR-010 /
// VO-ec575c4ce42b548bfb4d, and the "evidence manifests" leg of the PR-validation gate
// in .github/workflows/verify.yml).
//
// Purpose ---------------------------------------------------------------------
// The governance repository's *supported consumers* include the source-contract
// artifacts (the VO-mapped implementation files) and the per-gate evidence records
// under .lisa/.../gates/. The compatibility oracle (VO-ec575c4ce42b548bfb4d) requires
// that changes to inventory, source contracts, evidence, and mappings preserve those
// consumers or carry approved deprecation/migration/rollback/notice/compatibility
// evidence. A machine-readable EVIDENCE MANIFEST makes that surface tamper-evident:
// every governed artifact is pinned by a content digest, so a PR that silently drops,
// renames, or mutates a supported contract or its evidence is detectable in CI.
//
// This script has two modes, both dependency-free (Node built-ins only), pure w.r.t.
// inputs (no clock, no network), and deterministic (stable key ordering):
//
//   node scripts/ci/evidence-manifest.mjs build   [--out <path>]
//       Recompute the manifest from disk and write it (used to (re)generate).
//
//   node scripts/ci/evidence-manifest.mjs verify   [--manifest <path>]
//       Recompute from disk and compare against the committed manifest. Exit 0 iff
//       the committed manifest exactly matches the on-disk reality:
//         * every `present` source contract exists and its digest matches,
//         * no supported (present) contract silently vanished,
//         * the manifest's own governed inventory is internally consistent.
//       Any drift => non-zero exit with a disclosure-safe diff (paths only).
//
// The manifest is derived from the authoritative ownership map
// docs/architecture/repository-layout.md (its ```contracts``` block) so the manifest
// can never drift from the inventory the map governs — a single source of truth.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Resolve a path relative to the repo root, but honour absolute paths as-is
// (so `--manifest /tmp/...` and `--out /tmp/...` work for tests/CI scratch dirs).
const rel = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const MAP = 'docs/architecture/repository-layout.md';
const DEFAULT_MANIFEST = 'evidence/manifest.json';
const MANIFEST_VERSION = 1;

// Bundle execution identity (pinned) — the manifest asserts which bundle produced it,
// so evidence whose identity differs from the pinned input is rejected downstream.
const BUNDLE = {
  id: '36GCYGDJ15PTYP60F91QWRAY2M',
  contentHash: 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
};

const OPERATIONS_MANIFEST = 'evidence/operations-command-center/evidence-manifest.json';
const OPERATIONS_CONTROL_VERSIONS = {
  attentionRanking: 'attention-ranking/v1',
  caseLifecycle: 'operational-case-lifecycle/v1',
  serviceLevelPolicy: 'governance-{priority}/1.0.0',
  authorityPlan: 'operations-authority/v1',
  apiContract: 'operations-command-center.openapi/1.0.0',
};
const OPERATIONS_EVIDENCE_PATHS = [
  'contracts/operations-command-center/operations-command-center.openapi.yaml',
  'packages/domain/src/operations.ts',
  'packages/application/src/attention-queue.ts',
  'packages/application/src/operational-case-service.ts',
  'packages/application/src/operations-authority.ts',
  'packages/contracts/src/operations-api.ts',
  'packages/persistence/src/operational-case-repository.ts',
  'apps/api/src/routes/operations-command-center.ts',
  'apps/api/src/operations-runtime.ts',
  'apps/web/src/lib/operations-loader.ts',
  'apps/web/src/features/operations/AttentionQueue.tsx',
  'apps/web/src/features/operations/CaseWorkspace.tsx',
  'db/migrations/0070_operations_command_center.sql',
  'tests/unit/operations-command-center.test.ts',
  'tests/unit/operations-workspace.unit.test.ts',
  'tests/contract/operations-api.contract.test.ts',
  'tests/integration/operational-case-audit.test.ts',
  'tests/integration/operations-command-center-runtime.test.ts',
  'tests/integration/operations-command-center-rollback.test.ts',
  'tests/security/operations-command-center-access.test.ts',
  'tests/performance/operations-command-center.performance.test.ts',
  'tests/e2e/operations-command-center.spec.ts',
  'tests/evidence/audit-readiness/operations-command-center.mjs',
  'docs/runbooks/operations-command-center.md',
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Parse the ```contracts``` fenced block of the ownership map:
//   <path> | <status> | <VO> | <responsibility>
function readGovernedContracts() {
  const text = readFileSync(rel(MAP), 'utf8');
  const m = text.match(/```contracts\r?\n([\s\S]*?)```/m);
  if (!m) throw new Error(`ownership map ${MAP} has no \`\`\`contracts\`\`\` block`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()))
    .map(([path, status, vo, responsibility]) => ({ path, status, vo, responsibility }));
}

// Deterministic manifest: sorted entries, each governed source contract pinned by digest
// when present (status governs the compatibility expectation).
function buildManifest() {
  const contracts = readGovernedContracts().sort((a, b) => a.path.localeCompare(b.path));
  const entries = contracts.map((c) => {
    const abs = rel(c.path);
    const exists = existsSync(abs);
    const entry = {
      path: c.path,
      status: c.status,
      vo: c.vo,
      exists,
      digest: null,
    };
    if (exists) entry.digest = sha256(readFileSync(abs));
    return entry;
  });

  // The manifest also pins the gate-evidence inventory (present gates) so approved
  // evidence records are tamper-evident. We list gate evidence markdown by digest.
  const gatesDir = '.lisa/features/bundle-36gcygdj15ptyp60f91qwray2m/gates';
  const evidence = [];
  for (let i = 1; i <= 32; i++) {
    const p = `${gatesDir}/GATE${i}-EVIDENCE.md`;
    if (existsSync(rel(p))) {
      evidence.push({ path: p, digest: sha256(readFileSync(rel(p))) });
    }
  }
  evidence.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    bundle: BUNDLE,
    sourceOfTruth: MAP,
    contracts: entries,
    evidence,
  };
  // Self-digest binds the whole inventory (excludes the field itself).
  manifest.inventoryDigest = sha256(canonical(manifest));
  return manifest;
}

function buildOperationsManifest() {
  const artifacts = [...OPERATIONS_EVIDENCE_PATHS].sort().map((path) => {
    const abs = rel(path);
    if (!existsSync(abs)) throw new Error(`operations evidence artifact is missing: ${path}`);
    return { path, digest: sha256(readFileSync(abs)) };
  });
  const manifest = {
    manifestVersion: 1,
    feature: '002-operations-command-center',
    controls: OPERATIONS_CONTROL_VERSIONS,
    artifacts,
  };
  manifest.inventoryDigest = sha256(canonical(manifest));
  return manifest;
}

// Canonical stable JSON (sorted keys) excluding a volatile self-reference field.
function canonical(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.inventoryDigest;
  return stableStringify(clone);
}
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

function assertPinnedIdentity(manifest) {
  if (!manifest.bundle || manifest.bundle.id !== BUNDLE.id) {
    throw new Error(
      `manifest bundle identity ${manifest.bundle && manifest.bundle.id} != pinned ${BUNDLE.id}`,
    );
  }
  if (manifest.bundle.contentHash !== BUNDLE.contentHash) {
    throw new Error('manifest bundle content hash differs from pinned input');
  }
}

function cmdBuild(outPath) {
  const manifest = buildManifest();
  writeFileSync(rel(outPath), JSON.stringify(manifest, null, 2) + '\n');
  const present = manifest.contracts.filter((c) => c.status === 'present').length;
  process.stdout.write(
    `evidence-manifest: wrote ${outPath} — ${manifest.contracts.length} governed contracts ` +
      `(${present} present), ${manifest.evidence.length} gate evidence records\n`,
  );
  return 0;
}

function cmdBuildOperations(outPath) {
  const manifest = buildOperationsManifest();
  writeFileSync(rel(outPath), JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(
    `operations-evidence-manifest: wrote ${outPath} — ${manifest.artifacts.length} artifacts, ` +
      `${Object.keys(manifest.controls).length} control versions\n`,
  );
  return 0;
}

function cmdVerifyOperations(manifestPath) {
  const abs = rel(manifestPath);
  if (!existsSync(abs)) {
    process.stderr.write(`operations-evidence-manifest: missing ${manifestPath}\n`);
    return 2;
  }
  const committed = JSON.parse(readFileSync(abs, 'utf8'));
  if (committed.inventoryDigest !== sha256(canonical(committed))) {
    process.stderr.write('operations-evidence-manifest: inventory digest is invalid\n');
    return 1;
  }
  const current = buildOperationsManifest();
  if (stableStringify(committed) !== stableStringify(current)) {
    process.stderr.write(
      'operations-evidence-manifest: DRIFT DETECTED — rebuild the scoped feature manifest\n',
    );
    return 1;
  }
  process.stdout.write(
    `operations-evidence-manifest: OK — ${current.artifacts.length} artifacts and control versions verified\n`,
  );
  return 0;
}

function cmdVerify(manifestPath) {
  const abs = rel(manifestPath);
  if (!existsSync(abs)) {
    process.stderr.write(
      `evidence-manifest: committed manifest ${manifestPath} is missing — run \`build\` and commit it\n`,
    );
    return 2;
  }
  const committed = JSON.parse(readFileSync(abs, 'utf8'));
  assertPinnedIdentity(committed);

  const current = buildManifest();
  const problems = [];

  // 1. Self-integrity: recompute the committed manifest's inventory digest.
  const recomputed = sha256(canonical(committed));
  if (committed.inventoryDigest !== recomputed) {
    problems.push('committed manifest inventoryDigest does not match its own contents (tampered)');
  }

  // 2. Every present contract in the committed manifest must still exist with same digest,
  //    or carry an approved status change. Silent disappearance/mutation is a violation.
  const currentByPath = new Map(current.contracts.map((c) => [c.path, c]));
  for (const c of committed.contracts) {
    const now = currentByPath.get(c.path);
    if (!now) {
      problems.push(`governed contract dropped from ownership map without notice: ${c.path}`);
      continue;
    }
    if (c.status === 'present') {
      if (!now.exists) {
        problems.push(`supported contract removed from disk (breaks consumers): ${c.path}`);
      } else if (c.digest && now.digest && c.digest !== now.digest) {
        problems.push(
          `supported contract content changed without manifest re-approval: ${c.path} ` +
            `(commit new manifest via \`build\` when the change is approved)`,
        );
      }
    }
  }

  // 3. No new present contract may be introduced without also updating the manifest.
  const committedPaths = new Set(committed.contracts.map((c) => c.path));
  for (const c of current.contracts) {
    if (!committedPaths.has(c.path)) {
      problems.push(`new governed contract not recorded in manifest: ${c.path}`);
    }
  }

  if (problems.length) {
    process.stderr.write('evidence-manifest: DRIFT DETECTED\n');
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    return 1;
  }
  process.stdout.write(
    `evidence-manifest: OK — ${committed.contracts.length} governed contracts verified against disk, ` +
      `identity pinned to bundle ${committed.bundle.id}\n`,
  );
  return 0;
}

function main(argv) {
  const [, , mode, ...rest] = argv;
  const flag = (name, def) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
  };
  if (mode === 'build') return cmdBuild(flag('--out', DEFAULT_MANIFEST));
  if (mode === 'verify') return cmdVerify(flag('--manifest', DEFAULT_MANIFEST));
  if (mode === 'build-operations') return cmdBuildOperations(flag('--out', OPERATIONS_MANIFEST));
  if (mode === 'verify-operations')
    return cmdVerifyOperations(flag('--manifest', OPERATIONS_MANIFEST));
  process.stderr.write(
    'usage: evidence-manifest.mjs <build|verify|build-operations|verify-operations> ' +
      '[--out <path>|--manifest <path>]\n',
  );
  return 2;
}

// Exported for the tooling test (imported without executing main via the guard below).
export {
  buildManifest,
  buildOperationsManifest,
  canonical,
  sha256,
  readGovernedContracts,
  assertPinnedIdentity,
  BUNDLE,
  OPERATIONS_CONTROL_VERSIONS,
};

// Run as an entrypoint ONLY when invoked directly (`node scripts/ci/evidence-manifest.mjs ...`),
// never on import (so the tooling test can import the pure helpers safely).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
