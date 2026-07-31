// Phase 1 acceptance + verification-obligation test (GAR-010 / VO-b9b935bf93be10bdecdd).
//
// Oracle: Changes to inventory, decisions, lifecycle states, source contracts, evidence,
// mappings, and exports MUST preserve supported consumers or provide approved deprecation,
// migration, rollback, notice, and compatibility evidence.
//
// This suite makes the Phase 1 compatibility contract independently observable: the root
// package.json workspace, the Node.js 22 engine constraint, the deterministic package
// script surface consumed by quickstart.md / tasks.md, and the declared package boundaries
// (including the evidence package that later hosts packages/evidence/src/retention.ts) are
// asserted to exist and to remain consistent so downstream consumers are not silently
// broken. It uses only Node.js built-ins so it runs deterministically under `npm ci`
// without any adjacent environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
// tsconfig files are JSONC (TypeScript permits // and /* */ comments). Strip comments so we
// can validate them with JSON.parse without stripping the documentation from the configs.
const stripJsonc = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1');
const readJsonc = (rel) => JSON.parse(stripJsonc(readFileSync(join(ROOT, rel), 'utf8')));
const root = readJson('package.json');

// ---- Workspace declaration -------------------------------------------------
test('root package.json declares the npm workspace over packages/apps/adapters', () => {
  assert.equal(root.private, true, 'root workspace must be private');
  assert.ok(Array.isArray(root.workspaces), 'workspaces must be an array');
  for (const glob of ['packages/*', 'apps/*', 'adapters/*']) {
    assert.ok(root.workspaces.includes(glob), `workspaces must include ${glob}`);
  }
});

// ---- Node.js 22 engine constraint -----------------------------------------
test('root enforces the Node.js 22 engine constraint', () => {
  assert.ok(root.engines && typeof root.engines.node === 'string', 'engines.node required');
  const range = root.engines.node;
  // Must admit Node 22 and exclude Node 23+ (major pinned to 22).
  assert.match(range, />=22/, 'engine range must require Node >= 22');
  assert.match(range, /<23/, 'engine range must exclude Node 23+ to pin the major line');
  // The running interpreter (used for `npm ci`) must satisfy the constraint.
  assert.equal(process.versions.node.split('.')[0], '22', 'test host must run Node 22');
});

// ---- Deterministic package script surface ---------------------------------
// These names are fixed by specs/001-governance-control-plane/quickstart.md and tasks.md.
// Removing or renaming one is a breaking change to a supported consumer (the acceptance
// contract), which GAR-010 forbids without migration/deprecation evidence.
const REQUIRED_SCRIPTS = [
  'lint',
  'typecheck',
  'contracts:validate',
  'contracts:generate',
  'contracts:check',
  'test:unit',
  'test:contract',
  'test:integration',
  'test:security',
  'test:migrations',
  'test:resilience',
  'test:recovery',
  'test:e2e',
  'test:accessibility',
  'test:performance',
  'db:migrate',
  'fixtures:seed',
  'health',
  'verify:release',
];

test('root exposes the deterministic script surface required by quickstart.md', () => {
  assert.ok(root.scripts && typeof root.scripts === 'object', 'scripts object required');
  for (const name of REQUIRED_SCRIPTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(root.scripts, name),
      `missing required package script: ${name}`,
    );
    assert.ok(
      typeof root.scripts[name] === 'string' && root.scripts[name].trim().length > 0,
      `package script must be a non-empty command: ${name}`,
    );
  }
});

// ---- Package boundaries ----------------------------------------------------
// The plan (plan.md > Project Structure) fixes the bounded-context package set. Each
// declared member must be a real, installable workspace with a scoped name and an explicit
// engine constraint, and it must only depend on other declared workspace members (no
// undeclared cross-boundary edge). This is the "exports / package boundaries" GAR-010
// protects.
const EXPECTED_PACKAGES = [
  'packages/domain',
  'packages/application',
  'packages/persistence',
  'packages/authz',
  'packages/policy',
  'packages/audit-ledger',
  'packages/evidence', // hosts src/retention.ts per T037 / VO-b9b935bf93be10bdecdd
  'packages/projections',
  'packages/contracts',
  'packages/adapter-sdk',
  'packages/observability',
];
const EXPECTED_APPS = [
  'apps/api',
  'apps/web',
  'apps/command-worker',
  'apps/projector',
  'apps/discovery-agent',
];
const EXPECTED_ADAPTERS = [
  'adapters/kanban',
  'adapters/workflow-orchestration',
  'adapters/agentctl',
  'adapters/wiggum', // hosts src/snapshot.ts per T264 / US6 (read-only Wiggum discovery)
];

const ALL_MEMBERS = [...EXPECTED_PACKAGES, ...EXPECTED_APPS, ...EXPECTED_ADAPTERS];

// Build the set of declared workspace member package names for boundary checks.
const memberNames = new Set(ALL_MEMBERS.map((rel) => readJson(join(rel, 'package.json')).name));

test('every declared bounded-context package exists and is a private scoped workspace', () => {
  for (const rel of ALL_MEMBERS) {
    const manifestPath = join(rel, 'package.json');
    assert.ok(existsSync(join(ROOT, manifestPath)), `missing manifest: ${manifestPath}`);
    const pkg = readJson(manifestPath);
    assert.match(pkg.name, /^@trustcircle\//, `${rel} must use the @trustcircle scope`);
    assert.equal(pkg.private, true, `${rel} must be private`);
    assert.ok(
      pkg.engines && /^>=22/.test(pkg.engines.node ?? ''),
      `${rel} must inherit the Node 22 engine constraint`,
    );
  }
});

test('packages.evidence export surface is implemented and its targets exist (VO-b9b935bf93be10bdecdd)', () => {
  const evidence = readJson('packages/evidence/package.json');
  assert.equal(evidence.name, '@trustcircle/evidence');
  assert.ok(existsSync(join(ROOT, 'packages/evidence/src')), 'evidence src boundary must exist');
  // The declared exports/main target MUST exist on disk (no broken export surface).
  const exportTarget = evidence.exports?.['.'] ?? evidence.main;
  assert.ok(exportTarget, 'evidence package must declare an export entry');
  const exportRel = exportTarget.replace(/^\.\//, '');
  assert.ok(
    existsSync(join(ROOT, 'packages/evidence', exportRel)),
    `evidence export target must exist on disk: ${exportRel}`,
  );
  // The retention/legal-hold/disposition source (T037) MUST be implemented, not a scaffold.
  assert.ok(
    existsSync(join(ROOT, 'packages/evidence/src/retention.ts')),
    'packages/evidence/src/retention.ts must be implemented (T037 / VO-b9b935bf93be10bdecdd)',
  );
  const retention = readFileSync(join(ROOT, 'packages/evidence/src/retention.ts'), 'utf8');
  for (const symbol of [
    'resolveRetention',
    'evaluateDisposition',
    'recordDisposition',
    'verifyDispositionRecord',
  ]) {
    assert.match(
      retention,
      new RegExp(`export function ${symbol}\\b|export class ${symbol}\\b`),
      `retention.ts must export ${symbol}`,
    );
  }
});

test('packages.authz export surface is implemented and its targets exist (VO-173f7afb7801f4ab3e29)', () => {
  const authz = readJson('packages/authz/package.json');
  assert.equal(authz.name, '@trustcircle/authz');
  assert.ok(existsSync(join(ROOT, 'packages/authz/src')), 'authz src boundary must exist');
  const exportTarget = authz.exports?.['.'] ?? authz.main;
  assert.ok(exportTarget, 'authz package must declare an export entry');
  const exportRel = exportTarget.replace(/^\.\//, '');
  assert.ok(
    existsSync(join(ROOT, 'packages/authz', exportRel)),
    `authz export target must exist on disk: ${exportRel}`,
  );
  // The Separation-of-Duties source (T043) MUST be implemented, not a scaffold.
  assert.ok(
    existsSync(join(ROOT, 'packages/authz/src/separation-of-duties.ts')),
    'packages/authz/src/separation-of-duties.ts must be implemented (T043 / VO-173f7afb7801f4ab3e29)',
  );
  const sod = readFileSync(join(ROOT, 'packages/authz/src/separation-of-duties.ts'), 'utf8');
  for (const symbol of [
    'evaluateSeparationOfDuties',
    'evaluateWithWaiver',
    'evaluateCentralReviewerDistinctness',
  ]) {
    assert.match(
      sod,
      new RegExp(`export function ${symbol}\\b`),
      `separation-of-duties.ts must export ${symbol}`,
    );
  }
});

test('packages.application env config export surface is implemented and its targets exist (VO-ec575c4ce42b548bfb4d)', () => {
  const application = readJson('packages/application/package.json');
  assert.equal(application.name, '@trustcircle/application');
  assert.ok(
    existsSync(join(ROOT, 'packages/application/src')),
    'application src boundary must exist',
  );
  const exportTarget = application.exports?.['.'] ?? application.main;
  assert.ok(exportTarget, 'application package must declare an export entry');
  const exportRel = exportTarget.replace(/^\.\//, '');
  assert.ok(
    existsSync(join(ROOT, 'packages/application', exportRel)),
    `application export target must exist on disk: ${exportRel}`,
  );
  // The typed environment / secret-reference / safe-defaults source (Phase 7) MUST be
  // implemented, not a scaffold, and must re-export from the package entry point.
  const envRel = 'packages/application/src/config/environment.ts';
  assert.ok(
    existsSync(join(ROOT, envRel)),
    `${envRel} must be implemented (Phase 7 / VO-ec575c4ce42b548bfb4d)`,
  );
  const index = readFileSync(join(ROOT, 'packages/application', exportRel), 'utf8');
  assert.match(
    index,
    /export \* from '\.\/config\/environment\.ts'/,
    'application index must re-export the environment config surface',
  );
  const envSource = readFileSync(join(ROOT, envRel), 'utf8');
  for (const symbol of [
    'parseEnvironment',
    'parseEnvironmentOrThrow',
    'parseSecretReference',
    'toRedactedString',
  ]) {
    assert.match(
      envSource,
      new RegExp(`export function ${symbol}\\b`),
      `environment.ts must export function ${symbol}`,
    );
  }
  for (const symbol of ['EnvironmentValidationError']) {
    assert.match(
      envSource,
      new RegExp(`export class ${symbol}\\b`),
      `environment.ts must export class ${symbol}`,
    );
  }
  // The exported variable inventory + safe-default table are part of the source contract.
  for (const symbol of [
    'ENVIRONMENT_VARIABLE_NAMES',
    'SECRET_REFERENCE_VARIABLE_NAMES',
    'SECRET_REFERENCE_SCHEMES',
    'DEPLOYMENT_STAGES',
    'SAFE_DEFAULTS',
  ]) {
    assert.match(
      envSource,
      new RegExp(`export const ${symbol}\\b`),
      `environment.ts must export const ${symbol}`,
    );
  }
});

test('strict shared tsconfig base and project-reference solution exist and stay consistent (T002 / GAR-010)', () => {
  // The shared strict base must exist and actually enable strict compilation.
  assert.ok(existsSync(join(ROOT, 'tsconfig.base.json')), 'tsconfig.base.json must exist');
  const base = readJsonc('tsconfig.base.json');
  const co = base.compilerOptions ?? {};
  assert.equal(co.strict, true, 'base must enable strict');
  assert.equal(co.composite, true, 'base must enable composite for project references');
  assert.equal(co.declaration, true, 'composite requires declaration emit');
  assert.match(String(co.module), /nodenext/i, 'base must use NodeNext module resolution');

  // The root solution file must reference workspace members via project references, and every
  // referenced project must exist on disk with its own composite tsconfig — otherwise the
  // build graph is broken and consumers relying on `tsc --build` would fail.
  assert.ok(existsSync(join(ROOT, 'tsconfig.json')), 'root solution tsconfig.json must exist');
  const solution = readJsonc('tsconfig.json');
  assert.ok(
    Array.isArray(solution.references) && solution.references.length > 0,
    'solution tsconfig must declare project references',
  );
  for (const ref of solution.references) {
    const refDir = ref.path.replace(/^\.\//, '');
    assert.ok(
      existsSync(join(ROOT, refDir, 'tsconfig.json')),
      `referenced project must have a tsconfig.json: ${refDir}`,
    );
    const child = readJsonc(join(refDir, 'tsconfig.json'));
    assert.match(
      String(child.extends),
      /tsconfig\.base\.json$/,
      `${refDir}/tsconfig.json must extend the shared base`,
    );
    assert.equal(
      child.compilerOptions?.composite ?? base.compilerOptions.composite,
      true,
      `${refDir} must remain a composite project`,
    );
  }
});

test('workspace dependency edges stay inside declared boundaries (no undeclared consumers)', () => {
  for (const rel of ALL_MEMBERS) {
    const pkg = readJson(join(rel, 'package.json'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('@trustcircle/')) {
        assert.ok(memberNames.has(dep), `${rel} depends on undeclared workspace member ${dep}`);
      }
    }
  }
});

test('no undeclared @trustcircle workspace member exists on disk', () => {
  // Guard against a stray package landing outside the declared boundary map, which would
  // become an unsupported export path.
  for (const kind of ['packages', 'apps', 'adapters']) {
    const base = join(ROOT, kind);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${kind}/${entry.name}`;
      assert.ok(
        ALL_MEMBERS.includes(rel),
        `undeclared workspace member on disk: ${rel} (add it to the boundary map)`,
      );
    }
  }
});
