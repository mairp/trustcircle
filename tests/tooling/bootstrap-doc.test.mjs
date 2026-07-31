// Phase 13 acceptance test — developer bootstrap guide (task T013 / GAR-010 /
// VO-ec575c4ce42b548bfb4d). Makes docs/development/bootstrap.md an independently
// observable, enforced compatibility contract.
//
// Compatibility oracle (VO-ec575c4ce42b548bfb4d): changes to inventory, decisions,
// lifecycle states, source contracts, evidence, mappings, and exports MUST preserve
// supported consumers or provide approved deprecation/migration/rollback/notice/
// compatibility evidence. The standard-command table in this doc is a supported consumer
// surface (developers + onboarding + CI read it). This suite asserts:
//   1. the artifact exists and documents WSL bootstrap, test prerequisites, safe fixture
//      rules, and standard commands (the four required subjects),
//   2. every command in the machine-readable `commands` block resolves to a REAL
//      package.json script (no silent drift between the doc and the command surface),
//   3. the standard tiers named in the doc are internally consistent with the real script
//      surface (no documented script is missing; the core gate scripts are documented),
//   4. the change-discipline / compatibility obligation (VO) is documented.
// Node built-ins only → deterministic under `npm ci` with no adjacent environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const DOC = 'docs/development/bootstrap.md';

const pkg = JSON.parse(readFileSync(rel('package.json'), 'utf8'));
const SCRIPTS = pkg.scripts ?? {};

function fencedBlock(text, tag) {
  const re = new RegExp('```' + tag + '\\r?\\n([\\s\\S]*?)```', 'm');
  const m = text.match(re);
  assert.ok(m, `doc must contain a \`\`\`${tag}\`\`\` block`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|').map((c) => c.trim()));
}

// Resolve the script name a command row refers to. Rows are either a bare npm script name
// (e.g. "lint", "verify:pr") or an explicit invocation (e.g. "npm ci"). "npm ci" is a
// first-class npm subcommand, not a package script, and is treated as always-valid.
function scriptNameOf(command) {
  if (command === 'npm ci') return { kind: 'npm-builtin', name: 'ci' };
  return { kind: 'script', name: command };
}

// ---- Artifact presence -----------------------------------------------------
test('docs/development/bootstrap.md exists (T013 required artifact)', () => {
  assert.ok(existsSync(rel(DOC)), `${DOC} must exist`);
});

const src = existsSync(rel(DOC)) ? readFileSync(rel(DOC), 'utf8') : '';
const commands = src ? fencedBlock(src, 'commands') : [];

// ---- Required subjects: WSL, prerequisites, safe fixtures, standard commands ----
test('doc documents WSL bootstrap', () => {
  assert.match(src, /\bWSL\b/, 'doc must document WSL bootstrap');
  assert.match(src, /npm ci/, 'doc must document the deterministic install');
  assert.match(src, /Node(\.js)?\s*22/i, 'doc must pin Node 22');
});

test('doc documents test prerequisites', () => {
  assert.match(src, /prerequisit/i, 'doc must have a prerequisites section');
  assert.match(src, /Docker\s+(Engine|Compose)/i, 'doc must name Docker/Compose prereq');
  assert.match(src, /PostgreSQL/i, 'doc must name the database prerequisite');
});

test('doc documents safe fixture rules', () => {
  assert.match(src, /fixture/i, 'doc must discuss fixtures');
  assert.match(src, /disposable/i, 'safe fixtures must be described as disposable');
  assert.match(
    src,
    /no production (data|credential|evidence)|never (be )?(mounted|committed)/i,
    'safe fixtures must forbid production data/credentials',
  );
  assert.match(
    src,
    /without secrets|secret[- ]free|secret\s+reference/i,
    'fixtures must be secret-safe',
  );
});

test('doc documents standard commands', () => {
  assert.ok(commands.length >= 15, `commands block must be substantial (got ${commands.length})`);
  assert.match(src, /standard command/i, 'doc must have a standard-commands section');
});

// ---- Invariant (VO): every documented command resolves to a REAL script ----
test('every `commands` row resolves to a real package.json script (no drift)', () => {
  assert.ok(commands.length > 0, 'commands block must be non-empty');
  for (const row of commands) {
    const [command, category, description] = row;
    assert.ok(command && command.length > 0, 'command name required');
    assert.ok(category && category.length > 0, `category required for "${command}"`);
    assert.ok(description && description.length > 0, `description required for "${command}"`);
    const { kind, name } = scriptNameOf(command);
    if (kind === 'script') {
      assert.ok(
        Object.prototype.hasOwnProperty.call(SCRIPTS, name),
        `documented command "${command}" must be a defined package.json script (no drift)`,
      );
    }
  }
});

// ---- Consumer preservation: the core gate scripts must be documented -------
test('the core PR/release gate scripts are documented (map covers the surface)', () => {
  const documented = new Set(
    commands
      .map((r) => scriptNameOf(r[0]))
      .filter((s) => s.kind === 'script')
      .map((s) => s.name),
  );
  const mustDocument = [
    'lint',
    'format',
    'typecheck',
    'contracts:validate',
    'contracts:check',
    'test:unit',
    'test:contract',
    'test:integration',
    'test:tooling',
    'verify:pr',
    'verify:release',
    'evidence:verify',
    'fixtures:seed',
    'db:migrate',
    'health',
  ];
  for (const name of mustDocument) {
    assert.ok(
      documented.has(name),
      `standard command "${name}" must be documented in the commands block`,
    );
  }
});

// ---- Change-discipline / compatibility obligation is documented ------------
test('doc cites the compatibility obligation (GAR-010 / VO)', () => {
  assert.match(src, /VO-ec575c4ce42b548bfb4d/, 'doc must cite the compatibility VO');
  assert.match(
    src,
    /deprecation|migration|rollback/i,
    'doc must state the deprecation/migration/rollback change discipline',
  );
});
