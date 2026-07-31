/**
 * Contract type-generation command (T010 / GAR-010, VO-ec575c4c).
 *
 * Deterministically generates TypeScript type declarations for supported
 * consumers from the canonical source contracts:
 *
 *   - OpenAPI 3.1 documents   (governance-api, adapter-protocol)
 *   - AsyncAPI 3.0 document    (governance-events)
 *   - JSON Schema 2020-12       (evidence-envelope, adapter-manifest)
 *
 * Compatibility discipline (GAR-010): the generated files are a derived export
 * surface consumed by API handlers, adapters, and clients. Regeneration MUST be
 * deterministic (byte-identical output for unchanged sources) so a diff of the
 * committed generated code is exact evidence of a source-contract change. Each
 * generated file carries a provenance header pinning the SHA-256 of the exact
 * source bytes it was produced from; `--check` mode fails when committed output
 * drifts from what the current sources produce, forcing an approved regeneration
 * (migration/compatibility evidence) rather than a silent break.
 *
 * Dependency posture: pure Node 22 (native TS type-stripping) plus `js-yaml`
 * (declared devDependency) for YAML parsing. No network, no code-emitting
 * third-party codegen, no mutation of the source contracts.
 *
 * Usage:
 *   node packages/contracts/scripts/generate.ts          # write generated files
 *   node packages/contracts/scripts/generate.ts --check  # verify, do not write (CI)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Minimal js-yaml surface (no @types/js-yaml dependency).
// eslint-disable-next-line import/no-extraneous-dependencies
import yaml from 'js-yaml';

const load = (yaml as { load: (s: string) => unknown }).load;

// ---------------------------------------------------------------------------
// Paths & source-contract registry
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'specs', '001-governance-control-plane', 'contracts');
const OUT_DIR = join(REPO_ROOT, 'packages', 'contracts', 'src', 'generated');

/** Kind of source contract; drives the extraction strategy. */
export type ContractKind = 'openapi' | 'asyncapi' | 'jsonschema';

/** A source contract the generator consumes. */
export interface SourceContract {
  /** Stable id used for the generated module name. */
  readonly id: string;
  /** Source file path relative to the contracts dir. */
  readonly file: string;
  readonly kind: ContractKind;
  /** Exported namespace-ish prefix applied to generated type names. */
  readonly modulePrefix: string;
}

/**
 * The canonical, ordered registry of supported source contracts. Adding a
 * contract here (and only here) makes it part of the generated export surface.
 */
export const SOURCE_CONTRACTS: readonly SourceContract[] = [
  {
    id: 'governance-api',
    file: 'governance-api.openapi.yaml',
    kind: 'openapi',
    modulePrefix: 'GovernanceApi',
  },
  {
    id: 'adapter-protocol',
    file: 'adapter-protocol.openapi.yaml',
    kind: 'openapi',
    modulePrefix: 'AdapterProtocol',
  },
  {
    id: 'governance-events',
    file: 'governance-events.asyncapi.yaml',
    kind: 'asyncapi',
    modulePrefix: 'GovernanceEvents',
  },
  {
    id: 'evidence-envelope',
    file: 'evidence-envelope.schema.json',
    kind: 'jsonschema',
    modulePrefix: 'EvidenceEnvelope',
  },
  {
    id: 'adapter-manifest',
    file: 'adapter-manifest.schema.json',
    kind: 'jsonschema',
    modulePrefix: 'AdapterManifest',
  },
] as const;

// ---------------------------------------------------------------------------
// JSON-Schema-ish node type (OpenAPI/AsyncAPI schema objects are the same shape)
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
interface SchemaNode {
  [k: string]: unknown;
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** A named type the generator will emit. */
interface NamedType {
  readonly name: string;
  readonly body: string;
  /** Source pointer, used only for deterministic doc comments. */
  readonly origin: string;
}

// ---------------------------------------------------------------------------
// TypeScript identifier helpers
// ---------------------------------------------------------------------------

function pascal(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** A property key that is not a plain TS identifier must be quoted. */
function propKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// Schema → TypeScript type expression
// ---------------------------------------------------------------------------

class TypeEmitter {
  /** Maps a local `$ref` component name to the generated TS type name. */
  private readonly refTypeName: (refName: string) => string;

  constructor(refTypeName: (refName: string) => string) {
    this.refTypeName = refTypeName;
  }

  /** Resolve a local `$ref` string to the generated type name it points at. */
  private resolveRef(ref: string): string {
    // e.g. '#/components/schemas/SourceCatalogEntry' or '#/$defs/uuid'
    const parts = ref.split('/');
    const last = parts[parts.length - 1];
    return this.refTypeName(last);
  }

  /** Render a schema node to a TS type expression. `indent` for nested objects. */
  render(node: SchemaNode | boolean, indent = ''): string {
    if (node === true || node === undefined) return 'unknown';
    if (node === false) return 'never';
    const s = node as SchemaNode;

    if (typeof s.$ref === 'string') return this.resolveRef(s.$ref);

    // Composition keywords (allOf/oneOf/anyOf) combine WITH their sibling
    // keywords in the same node (JSON Schema semantics), so render the base
    // node without the composition keyword and intersect/union it in.
    if (Array.isArray(s.allOf) || Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
      const { allOf, oneOf, anyOf, ...base } = s as Record<string, unknown>;
      const members: string[] = [];
      const baseHasContent = Object.keys(base).some((k) => k !== 'title' && k !== 'description');
      if (baseHasContent) members.push(this.wrap(this.render(base as SchemaNode, indent)));

      if (Array.isArray(allOf)) {
        const parts = (allOf as SchemaNode[]).map((n) => this.wrap(this.render(n, indent)));
        members.push(...parts);
        return members.filter((m) => m !== 'unknown').join(' & ') || 'unknown';
      }
      const branch = (Array.isArray(oneOf) ? oneOf : anyOf) as SchemaNode[];
      const union = branch.map((n) => this.render(n, indent)).join(' | ');
      if (members.length === 0) return union;
      return `${members.join(' & ')} & (${union})`;
    }

    if ('const' in s) return JSON.stringify(s.const as JsonValue);

    if (Array.isArray(s.enum)) {
      const vals = s.enum as JsonValue[];
      if (vals.length === 0) return 'never';
      return vals.map((v) => JSON.stringify(v)).join(' | ');
    }

    // `type` may be a string or an array (e.g. ['string','null']).
    const typeField = s.type;
    if (Array.isArray(typeField)) {
      return (typeField as string[]).map((t) => this.render({ ...s, type: t }, indent)).join(' | ');
    }

    switch (typeField) {
      case 'null':
        return 'null';
      case 'boolean':
        return 'boolean';
      case 'integer':
      case 'number':
        return 'number';
      case 'string':
        return this.renderString(s);
      case 'array':
        return this.renderArray(s, indent);
      case 'object':
        return this.renderObject(s, indent);
      default:
        // No explicit type: infer from presence of `properties`.
        if (s.properties || s.additionalProperties !== undefined || s.required) {
          return this.renderObject(s, indent);
        }
        return 'unknown';
    }
  }

  private renderString(_s: SchemaNode): string {
    // Formats (uuid/date-time/etc.) are documented in the source contract; the
    // generated consumer type is a plain string to avoid false compat breaks.
    return 'string';
  }

  private renderArray(s: SchemaNode, indent: string): string {
    const items = s.items as SchemaNode | boolean | undefined;
    if (items === undefined) return 'unknown[]';
    const inner = this.render(items, indent);
    return `Array<${inner}>`;
  }

  private renderObject(s: SchemaNode, indent: string): string {
    const props = (s.properties as Record<string, SchemaNode>) ?? {};
    const required = new Set<string>((s.required as string[]) ?? []);
    const keys = Object.keys(props).sort();
    const childIndent = indent + '  ';
    const lines: string[] = [];

    for (const key of keys) {
      const optional = required.has(key) ? '' : '?';
      const value = this.render(props[key], childIndent);
      lines.push(`${childIndent}${propKey(key)}${optional}: ${value};`);
    }

    // additionalProperties: false → sealed; true/absent-with-no-props → index sig.
    const addl = s.additionalProperties;
    if (addl && typeof addl === 'object') {
      const valType = this.render(addl as SchemaNode, childIndent);
      lines.push(`${childIndent}[key: string]: ${valType};`);
    } else if (addl === true || (keys.length === 0 && addl === undefined)) {
      lines.push(`${childIndent}[key: string]: unknown;`);
    }

    if (lines.length === 0) return 'Record<string, never>';
    return `{\n${lines.join('\n')}\n${indent}}`;
  }

  /** Wrap intersection members that are unions/objects for correct precedence. */
  private wrap(expr: string): string {
    if (/[|&]/.test(expr) && !expr.startsWith('{')) return `(${expr})`;
    return expr;
  }
}

// ---------------------------------------------------------------------------
// Extraction: pull named schemas out of each contract kind
// ---------------------------------------------------------------------------

interface Extraction {
  /** componentName -> schema node */
  readonly schemas: Record<string, SchemaNode>;
  /** ordered top-level type list (e.g. named messages / root schema) */
  readonly extras: NamedType[];
}

function extractOpenApiOrAsyncApi(
  doc: SchemaNode,
  kind: ContractKind,
  prefix: string,
  emitter: () => TypeEmitter,
): Extraction {
  const components = (doc.components as SchemaNode) ?? {};
  const schemas: Record<string, SchemaNode> = {
    ...((components.schemas as Record<string, SchemaNode>) ?? {}),
  };
  // Schema-bearing parameters also contribute a named schema.
  const params = (components.parameters as Record<string, SchemaNode>) ?? {};
  for (const [pname, pnode] of Object.entries(params)) {
    if (pnode && typeof pnode === 'object' && (pnode as SchemaNode).schema) {
      schemas[`Parameter${pascal(pname)}`] = (pnode as SchemaNode).schema as SchemaNode;
    }
  }

  const extras: NamedType[] = [];
  if (kind === 'asyncapi') {
    // Each message's payload becomes a named message type.
    const messages = (components.messages as Record<string, SchemaNode>) ?? {};
    const em = emitter();
    for (const mname of Object.keys(messages).sort()) {
      const msg = messages[mname];
      const payload = (msg?.payload as SchemaNode) ?? undefined;
      if (payload) {
        const typeName = `${prefix}Message${pascal(mname)}`;
        extras.push({
          name: typeName,
          body: `export type ${typeName} = ${em.render(payload)};`,
          origin: `components/messages/${mname}/payload`,
        });
      }
    }
  }
  return { schemas, extras };
}

function extractJsonSchema(doc: SchemaNode): Extraction {
  const schemas: Record<string, SchemaNode> = {};
  const defs = (doc.$defs as Record<string, SchemaNode>) ?? {};
  for (const [dname, dnode] of Object.entries(defs)) schemas[dname] = dnode;
  // The root schema itself is the primary named type.
  const rootBody: SchemaNode = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '$defs' || k === '$schema' || k === '$id') continue;
    rootBody[k] = v;
  }
  schemas.Root = rootBody;
  return { schemas, extras: [] };
}

// ---------------------------------------------------------------------------
// Per-contract module generation
// ---------------------------------------------------------------------------

const GENERATED_HEADER_MARK = '@generated';

function provenanceHeader(contract: SourceContract, sourceHash: string): string {
  return [
    '/**',
    ` * ${GENERATED_HEADER_MARK} by packages/contracts/scripts/generate.ts — DO NOT EDIT.`,
    ` *`,
    ` * Source contract : specs/001-governance-control-plane/contracts/${contract.file}`,
    ` * Contract kind   : ${contract.kind}`,
    ` * Source sha256   : ${sourceHash}`,
    ` *`,
    ` * Regenerate with : npm run contracts:generate`,
    ` * Verify (CI)     : npm run contracts:check`,
    ` *`,
    ` * GAR-010: this derived export surface is compatibility-governed. A change to`,
    ` * the source contract changes the Source sha256 above and this file; committing`,
    ` * that diff is the deprecation/migration/compatibility evidence for consumers.`,
    ` */`,
    '',
  ].join('\n');
}

function moduleFileName(contract: SourceContract): string {
  return `${contract.id}.ts`;
}

/** Produce the full TS source for one contract module. Deterministic. */
export function generateModule(contract: SourceContract, rawSource: string): string {
  const sourceHash = sha256(rawSource);
  const parsed =
    contract.kind === 'jsonschema'
      ? (JSON.parse(rawSource) as SchemaNode)
      : (load(rawSource) as SchemaNode);

  const prefix = contract.modulePrefix;

  // Build the name map first so $ref resolution is stable regardless of order.
  const componentTypeName = (component: string): string => `${prefix}${pascal(component)}`;

  const mkEmitter = (): TypeEmitter => new TypeEmitter(componentTypeName);

  const extraction =
    contract.kind === 'jsonschema'
      ? extractJsonSchema(parsed)
      : extractOpenApiOrAsyncApi(parsed, contract.kind, prefix, mkEmitter);

  const emitter = mkEmitter();
  const named: NamedType[] = [];

  for (const component of Object.keys(extraction.schemas).sort()) {
    const typeName = componentTypeName(component);
    const body = emitter.render(extraction.schemas[component]);
    // Object-literal bodies read better as interfaces; unions/aliases as `type`.
    if (body.startsWith('{')) {
      named.push({
        name: typeName,
        body: `export interface ${typeName} ${body}`,
        origin: `schemas/${component}`,
      });
    } else {
      named.push({
        name: typeName,
        body: `export type ${typeName} = ${body};`,
        origin: `schemas/${component}`,
      });
    }
  }

  // Deterministic order: all schema types (sorted by name), then extras (sorted).
  named.sort((a, b) => a.name.localeCompare(b.name));
  const extras = [...extraction.extras].sort((a, b) => a.name.localeCompare(b.name));

  const parts: string[] = [provenanceHeader(contract, sourceHash)];
  for (const t of [...named, ...extras]) {
    parts.push(`// ${t.origin}`);
    parts.push(t.body);
    parts.push('');
  }
  // Trailing newline; strip any accidental double blanks for stability.
  return parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

/** Generate the aggregate barrel that re-exports every contract module. */
export function generateIndex(contracts: readonly SourceContract[]): string {
  const lines: string[] = [
    '/**',
    ` * ${GENERATED_HEADER_MARK} by packages/contracts/scripts/generate.ts — DO NOT EDIT.`,
    ` *`,
    ` * Aggregate export surface for all generated contract types.`,
    ` */`,
    '',
  ];
  for (const c of [...contracts].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`export * from './${c.id}.js';`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration (write / check)
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  readonly path: string; // absolute
  readonly relPath: string; // relative to repo root
  readonly content: string;
}

/** Compute the full generated file set in-memory (no disk writes). */
export function computeGeneratedFiles(): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const contract of SOURCE_CONTRACTS) {
    const src = readFileSync(join(CONTRACTS_DIR, contract.file), 'utf8');
    const content = generateModule(contract, src);
    const abs = join(OUT_DIR, moduleFileName(contract));
    files.push({ path: abs, relPath: relFromRoot(abs), content });
  }
  const indexAbs = join(OUT_DIR, 'index.ts');
  files.push({
    path: indexAbs,
    relPath: relFromRoot(indexAbs),
    content: generateIndex(SOURCE_CONTRACTS),
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function relFromRoot(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

/** Existing generated files currently on disk (for check / stale detection). */
function listOnDisk(): string[] {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(OUT_DIR, f))
    .sort();
}

export interface CheckResult {
  readonly ok: boolean;
  /** files that differ from what generation would produce */
  readonly drifted: string[];
  /** files on disk that generation would not produce (stale) */
  readonly stale: string[];
  /** files generation produces that are missing on disk */
  readonly missing: string[];
}

export function checkGenerated(): CheckResult {
  const expected = computeGeneratedFiles();
  const expectedByPath = new Map(expected.map((f) => [f.path, f.content]));
  const drifted: string[] = [];
  const missing: string[] = [];
  for (const f of expected) {
    if (!existsSync(f.path)) {
      missing.push(f.relPath);
      continue;
    }
    const actual = readFileSync(f.path, 'utf8');
    if (actual !== f.content) drifted.push(f.relPath);
  }
  const stale: string[] = [];
  for (const p of listOnDisk()) {
    if (!expectedByPath.has(p)) stale.push(relFromRoot(p));
  }
  return {
    ok: drifted.length === 0 && missing.length === 0 && stale.length === 0,
    drifted,
    stale,
    missing,
  };
}

export function writeGenerated(): GeneratedFile[] {
  mkdirSync(OUT_DIR, { recursive: true });
  // Remove stale generated .ts files so removed contracts do not linger.
  const expected = computeGeneratedFiles();
  const expectedPaths = new Set(expected.map((f) => f.path));
  for (const p of listOnDisk()) {
    if (!expectedPaths.has(p)) rmSync(p);
  }
  for (const f of expected) writeFileSync(f.path, f.content, 'utf8');
  return expected;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function isMain(): boolean {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  return entry === resolve(fileURLToPath(import.meta.url));
}

function main(argv: string[]): number {
  const check = argv.includes('--check') || argv.includes('--check-generated');
  if (check) {
    const result = checkGenerated();
    if (result.ok) {
      process.stdout.write(
        `contracts:check OK — ${computeGeneratedFiles().length} generated file(s) match sources.\n`,
      );
      return 0;
    }
    process.stderr.write('contracts:check FAILED — generated code is out of date.\n');
    for (const f of result.missing) process.stderr.write(`  missing:  ${f}\n`);
    for (const f of result.drifted) process.stderr.write(`  drifted:  ${f}\n`);
    for (const f of result.stale) process.stderr.write(`  stale:    ${f}\n`);
    process.stderr.write('Run `npm run contracts:generate` and commit the result.\n');
    return 1;
  }
  const written = writeGenerated();
  process.stdout.write(
    `contracts:generate OK — wrote ${written.length} file(s) to packages/contracts/src/generated/.\n`,
  );
  for (const f of written) process.stdout.write(`  ${f.relPath}\n`);
  return 0;
}

if (isMain()) {
  process.exit(main(process.argv.slice(2)));
}
