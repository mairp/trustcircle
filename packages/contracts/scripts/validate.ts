/**
 * Contract validation command (T011 / GAR-010, VO-ec575c4ce42b548bfb4d).
 *
 * This is the compatibility *gate* for the supported source-contract surface.
 * `verify:pr` runs it through `ci:contracts` (via scripts/ci/run-if-present.mjs)
 * and `verify:release` runs it directly. It enforces three obligations, each of
 * which — if violated — would silently break a supported consumer:
 *
 *   1. CONTRACT VALIDATION. Every canonical source contract
 *      (specs/001-governance-control-plane/contracts/*) MUST parse and satisfy
 *      the structural invariants supported consumers rely on: a stable document
 *      kind + version, the declared identity/version fields, non-empty component
 *      surface, and no dangling local `$ref` (a dangling ref is a broken export).
 *
 *   2. UNRESOLVED-PLACEHOLDER REJECTION. A contract that still contains an
 *      authoring placeholder (TODO / TBD / FIXME / `<REPLACE_ME>` angle token /
 *      `${…}` interpolation / CHANGEME / a resolvable `example.com` domain) is
 *      NOT a finished, supportable contract. Shipping one would publish an
 *      unresolved surface to consumers, so validation rejects it. Note: RFC 2606
 *      `.invalid` / `.test` reserved hosts and OpenAPI `example:` sample values
 *      are legitimate and are NOT treated as unresolved placeholders.
 *
 *   3. GENERATED-DIFF CHECK. The generated TypeScript export surface
 *      (packages/contracts/src/generated/*, produced by generate.ts) MUST be
 *      byte-identical to what the current sources produce. A source-contract
 *      change that was not regenerated-and-committed drifts the generated diff;
 *      validation blocks it, forcing the reviewable regeneration that is the
 *      migration/compatibility evidence for consumers.
 *
 * Dependency posture: pure Node 22 (native TS type-stripping) + `js-yaml` (a
 * declared devDependency) for YAML. No network, no clock, no mutation of any
 * source contract. Deterministic: identical inputs → identical verdict.
 *
 * Usage:
 *   node packages/contracts/scripts/validate.ts            # validate; exit 1 on any violation
 *   node packages/contracts/scripts/validate.ts --json     # machine-readable report to stdout
 *   node packages/contracts/scripts/validate.ts --no-generated   # skip only the generated-diff leg
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Minimal js-yaml surface (no @types/js-yaml dependency).
// eslint-disable-next-line import/no-extraneous-dependencies
import yaml from 'js-yaml';

import { SOURCE_CONTRACTS, checkGenerated } from './generate.ts';
import type { SourceContract, ContractKind } from './generate.ts';

const load = (yaml as { load: (s: string) => unknown }).load;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'specs', '001-governance-control-plane', 'contracts');

// ---------------------------------------------------------------------------
// Finding model
// ---------------------------------------------------------------------------

export type FindingKind = 'contract' | 'placeholder' | 'generated';

export interface Finding {
  /** Which validation leg produced this finding. */
  readonly kind: FindingKind;
  /** Contract id (or 'generated' for the diff leg). */
  readonly contract: string;
  /** Repo-relative file path the finding is anchored to. */
  readonly file: string;
  /** 1-based line number when known (placeholder scan), else 0. */
  readonly line: number;
  /** Human-readable violation message. */
  readonly message: string;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly findings: Finding[];
  /** Contracts that were parsed & structurally validated (ids). */
  readonly validated: string[];
}

// ---------------------------------------------------------------------------
// 1. Structural contract validation
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

function isObject(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a source contract's raw bytes into an object, per kind. Throws on malformed input. */
export function parseContract(kind: ContractKind, raw: string): Node {
  const parsed = kind === 'jsonschema' ? JSON.parse(raw) : load(raw);
  if (!isObject(parsed)) {
    throw new Error('document did not parse to an object');
  }
  return parsed;
}

/** Collect every local `$ref` (`#/...`) target present anywhere in the document. */
function collectRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const el of node) collectRefs(el, out);
    return;
  }
  if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) out.push(v);
      else collectRefs(v, out);
    }
  }
}

/** Resolve a JSON-pointer `#/a/b/c` against `root`; returns undefined if dangling. */
function resolvePointer(root: Node, ref: string): unknown {
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const p of parts) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Structurally validate one parsed contract. Returns human-readable problem
 * strings (empty ⇒ valid). Enforces the invariants supported consumers depend on:
 * declared kind+version, an identity/version field, a non-empty component surface,
 * and no dangling local `$ref`.
 */
export function validateStructure(contract: SourceContract, doc: Node): string[] {
  const problems: string[] = [];
  const semver = /^\d+\.\d+\.\d+$/;

  if (contract.kind === 'openapi') {
    if (typeof doc.openapi !== 'string' || !/^3\.1\./.test(doc.openapi)) {
      problems.push(
        `missing/unsupported "openapi" version (expected 3.1.x, got ${String(doc.openapi)})`,
      );
    }
    const info = doc.info;
    if (!isObject(info) || typeof info.version !== 'string' || !semver.test(info.version)) {
      problems.push('info.version must be a semver string (compatibility version)');
    }
    if (!isObject(info) || typeof info.title !== 'string' || info.title.trim() === '') {
      problems.push('info.title is required and must be non-empty');
    }
    if (!isObject(doc.paths) || Object.keys(doc.paths as Node).length === 0) {
      problems.push('paths surface is empty — no operations for consumers');
    }
    const schemas = isObject(doc.components) ? (doc.components as Node).schemas : undefined;
    if (!isObject(schemas) || Object.keys(schemas as Node).length === 0) {
      problems.push('components.schemas is empty — no named types for the generated surface');
    }
  } else if (contract.kind === 'asyncapi') {
    if (typeof doc.asyncapi !== 'string' || !/^3\.0\./.test(doc.asyncapi)) {
      problems.push(
        `missing/unsupported "asyncapi" version (expected 3.0.x, got ${String(doc.asyncapi)})`,
      );
    }
    const info = doc.info;
    if (!isObject(info) || typeof info.version !== 'string' || !semver.test(info.version)) {
      problems.push('info.version must be a semver string (compatibility version)');
    }
    if (!isObject(doc.channels) || Object.keys(doc.channels as Node).length === 0) {
      problems.push('channels surface is empty — no event channels for consumers');
    }
    const messages = isObject(doc.components) ? (doc.components as Node).messages : undefined;
    if (!isObject(messages) || Object.keys(messages as Node).length === 0) {
      problems.push('components.messages is empty — no message payloads for the generated surface');
    }
  } else {
    // jsonschema
    if (typeof doc.$schema !== 'string' || !/json-schema\.org/.test(doc.$schema)) {
      problems.push('missing "$schema" (JSON Schema dialect) declaration');
    }
    if (typeof doc.$id !== 'string' || !/\/v\d+\.\d+\.\d+$/.test(doc.$id)) {
      problems.push('$id must carry a versioned identity (…/vX.Y.Z) for consumers');
    }
    if (doc.type !== 'object') {
      problems.push('root schema type must be "object"');
    }
    if (!Array.isArray(doc.required) || (doc.required as unknown[]).length === 0) {
      problems.push('root schema declares no required properties');
    }
    if (!isObject(doc.properties) || Object.keys(doc.properties as Node).length === 0) {
      problems.push('root schema declares no properties — empty consumer surface');
    }
  }

  // Dangling-$ref check applies to every kind: a local ref that resolves at
  // nothing is a broken export surface for whatever consumes it.
  const refs: string[] = [];
  collectRefs(doc, refs);
  for (const ref of [...new Set(refs)].sort()) {
    if (resolvePointer(doc, ref) === undefined) {
      problems.push(`dangling local $ref (resolves to nothing): ${ref}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// 2. Unresolved-placeholder rejection
// ---------------------------------------------------------------------------

/**
 * Patterns that mark an UNRESOLVED authoring placeholder. Each must be a real
 * "not finished" signal, not a legitimate value:
 *   - TODO/TBD/FIXME/XXX/HACK — authoring markers.
 *   - `<UPPER_SNAKE>` — angle-bracket fill-me token (e.g. `<REPLACE_ME>`),
 *     constrained to UPPERCASE tokens so it never matches YAML/JSON syntax,
 *     HTML in descriptions, or generics.
 *   - `${…}` — shell/template interpolation left unresolved.
 *   - CHANGEME / REPLACE_ME / PLACEHOLDER — literal fill words.
 *   - `example.com` — a *resolvable* placeholder domain (RFC 2606 `.invalid` /
 *     `.test` hosts, used intentionally in these contracts, are NOT flagged).
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'TODO marker', re: /\bTODO\b/ },
  { label: 'TBD marker', re: /\bTBD\b/ },
  { label: 'FIXME marker', re: /\bFIXME\b/ },
  { label: 'XXX marker', re: /\bXXX\b/ },
  { label: 'HACK marker', re: /\bHACK\b/ },
  { label: 'angle-bracket fill token', re: /<[A-Z][A-Z0-9_]{2,}>/ },
  { label: 'unresolved ${…} interpolation', re: /\$\{[^}]*\}/ },
  { label: 'CHANGEME literal', re: /\bCHANGEME\b/i },
  { label: 'REPLACE_ME literal', re: /\bREPLACE_ME\b/i },
  { label: 'PLACEHOLDER literal', re: /\bPLACEHOLDER\b/i },
  { label: 'resolvable example.com placeholder domain', re: /\bexample\.com\b/i },
];

/** Scan raw contract text line-by-line for unresolved placeholders. */
export function scanPlaceholders(contract: SourceContract, raw: string): Finding[] {
  const findings: Finding[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { label, re } of PLACEHOLDER_PATTERNS) {
      if (re.test(line)) {
        findings.push({
          kind: 'placeholder',
          contract: contract.id,
          file: relFromRoot(join(CONTRACTS_DIR, contract.file)),
          line: i + 1,
          message: `unresolved placeholder (${label}): ${line.trim().slice(0, 120)}`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function relFromRoot(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

export interface ValidateOptions {
  /** Skip the generated-diff leg (structural + placeholder only). Default false. */
  readonly skipGenerated?: boolean;
}

/** Run every validation leg over the canonical source contracts. Pure w.r.t. disk reads. */
export function validateContracts(opts: ValidateOptions = {}): ValidationReport {
  const findings: Finding[] = [];
  const validated: string[] = [];

  for (const contract of SOURCE_CONTRACTS) {
    const abs = join(CONTRACTS_DIR, contract.file);
    const rel = relFromRoot(abs);
    if (!existsSync(abs)) {
      findings.push({
        kind: 'contract',
        contract: contract.id,
        file: rel,
        line: 0,
        message: 'source contract file is missing (supported consumers depend on it)',
      });
      continue;
    }
    const raw = readFileSync(abs, 'utf8');

    // Leg 2: placeholder scan runs on raw bytes regardless of parseability.
    findings.push(...scanPlaceholders(contract, raw));

    // Leg 1: structural validation.
    let doc: Node;
    try {
      doc = parseContract(contract.kind, raw);
    } catch (err) {
      findings.push({
        kind: 'contract',
        contract: contract.id,
        file: rel,
        line: 0,
        message: `failed to parse ${contract.kind} document: ${(err as Error).message}`,
      });
      continue;
    }
    for (const problem of validateStructure(contract, doc)) {
      findings.push({
        kind: 'contract',
        contract: contract.id,
        file: rel,
        line: 0,
        message: problem,
      });
    }
    validated.push(contract.id);
  }

  // Leg 3: generated-diff check (delegates to the single source of truth in generate.ts).
  if (!opts.skipGenerated) {
    const gen = checkGenerated();
    if (!gen.ok) {
      const detail = [
        ...gen.missing.map((f) => `missing generated module: ${f}`),
        ...gen.drifted.map((f) => `generated module drifted from sources: ${f}`),
        ...gen.stale.map((f) => `stale generated module (no source produces it): ${f}`),
      ];
      for (const message of detail) {
        findings.push({
          kind: 'generated',
          contract: 'generated',
          file: 'packages/contracts/src/generated',
          line: 0,
          message,
        });
      }
      // Guarantee at least one finding even if detail decomposition was empty.
      if (detail.length === 0) {
        findings.push({
          kind: 'generated',
          contract: 'generated',
          file: 'packages/contracts/src/generated',
          line: 0,
          message: 'generated surface is out of date with the source contracts',
        });
      }
    }
  }

  return { ok: findings.length === 0, findings, validated };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function isMain(): boolean {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  return entry === resolve(fileURLToPath(import.meta.url));
}

function main(argv: string[]): number {
  const json = argv.includes('--json');
  const skipGenerated = argv.includes('--no-generated');
  const report = validateContracts({ skipGenerated });

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }

  if (report.ok) {
    process.stdout.write(
      `contracts:validate OK — ${report.validated.length} source contract(s) valid, ` +
        `no unresolved placeholders, generated surface in sync.\n`,
    );
    return 0;
  }

  process.stderr.write(`contracts:validate FAILED — ${report.findings.length} violation(s):\n`);
  for (const f of report.findings) {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    process.stderr.write(`  [${f.kind}] ${where} — ${f.message}\n`);
  }
  process.stderr.write(
    'Fix the source contract, remove the placeholder, and/or run ' +
      '`npm run contracts:generate` and commit the result.\n',
  );
  return 1;
}

if (isMain()) {
  process.exit(main(process.argv.slice(2)));
}
