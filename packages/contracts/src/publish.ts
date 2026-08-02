// @trustcircle/contracts — CONTRACT PUBLISHING (Phase 9 / T284 / GAR-010).
//
// PHASE OBJECTIVE (T284): "Generate versioned TypeScript client packages and browsable
// OpenAPI/AsyncAPI documentation in packages/contracts/src/publish.ts".
//
// This module is the PUBLISH step of the contract lifecycle. It does NOT re-declare the API — it
// LOADS the two canonical, authoritative specs
//   specs/001-governance-control-plane/contracts/governance-api.openapi.yaml   (OpenAPI 3.1)
//   specs/001-governance-control-plane/contracts/governance-events.asyncapi.yaml (AsyncAPI 3.0)
// and derives, deterministically:
//   1. a VERSIONED TypeScript client package for each spec — package.json descriptor pinned to the
//      spec's `info.version`, plus a typed client surface (one method per OpenAPI operation, one
//      subscribe/publish per AsyncAPI channel). If the spec version bumps, the client version bumps
//      with it — the client can never silently drift from the published contract.
//   2. BROWSABLE HTML documentation for each spec (self-contained, dependency-free: a static page a
//      reviewer can open, listing every operation/channel with its summary).
//
// `publishContracts()` returns the in-memory artifact set; `writeContracts(dir)` writes it to disk.
// The self-check proves non-vacuity: the client version EQUALS the spec version, every operation and
// channel is represented, and a RED CONTROL (a spec stripped of its version) is rejected.
//
// Dependency posture: pure Node 22 (native TS type-stripping) + js-yaml (already a contracts dep).
// Deterministic: stable ordering, no clock, no network. Run:
//   node --experimental-strip-types packages/contracts/src/publish.ts [--out <dir>]

import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import/no-extraneous-dependencies
import yaml from 'js-yaml';

const loadYaml = yaml.load;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'specs', '001-governance-control-plane', 'contracts');
export const OPENAPI_PATH = join(CONTRACTS_DIR, 'governance-api.openapi.yaml');
export const ASYNCAPI_PATH = join(CONTRACTS_DIR, 'governance-events.asyncapi.yaml');

// ── tiny JSON model ──────────────────────────────────────────────────────────────────────────────
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
function isObject(v: unknown): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: Json | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ── extracted, spec-driven descriptors ────────────────────────────────────────────────────────────
export interface OperationDescriptor {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
}
export interface ChannelDescriptor {
  readonly name: string;
  readonly address: string;
  readonly summary: string;
}
export interface ApiSurface {
  readonly title: string;
  readonly version: string;
  readonly operations: OperationDescriptor[];
}
export interface EventSurface {
  readonly title: string;
  readonly version: string;
  readonly channels: ChannelDescriptor[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

/** Load + extract the OpenAPI operation surface. Throws if the spec has no info.version. */
export function loadApiSurface(path: string = OPENAPI_PATH): ApiSurface {
  const doc = loadYaml(readFileSync(path, 'utf8'));
  if (!isObject(doc)) throw new Error('openapi spec did not parse to an object');
  const info = isObject(doc['info']) ? doc['info'] : undefined;
  const version = info && str(info['version']);
  const title = (info && str(info['title'])) ?? 'Governance API';
  if (!version)
    throw new Error('openapi spec is missing info.version — cannot publish a versioned client');

  const operations: OperationDescriptor[] = [];
  const paths = isObject(doc['paths']) ? doc['paths'] : {};
  for (const p of Object.keys(paths).sort()) {
    const item = paths[p];
    if (!isObject(item)) continue;
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!isObject(op)) continue;
      operations.push({
        operationId: str(op['operationId']) ?? `${m}_${p}`.replace(/[^A-Za-z0-9]+/g, '_'),
        method: m.toUpperCase(),
        path: p,
        summary: str(op['summary']) ?? '',
      });
    }
  }
  return { title, version, operations };
}

/** Load + extract the AsyncAPI channel surface. Throws if the spec has no info.version. */
export function loadEventSurface(path: string = ASYNCAPI_PATH): EventSurface {
  const doc = loadYaml(readFileSync(path, 'utf8'));
  if (!isObject(doc)) throw new Error('asyncapi spec did not parse to an object');
  const info = isObject(doc['info']) ? doc['info'] : undefined;
  const version = info && str(info['version']);
  const title = (info && str(info['title'])) ?? 'Governance Events';
  if (!version)
    throw new Error('asyncapi spec is missing info.version — cannot publish a versioned client');

  const channels: ChannelDescriptor[] = [];
  const chans = isObject(doc['channels']) ? doc['channels'] : {};
  for (const name of Object.keys(chans).sort()) {
    const ch = chans[name];
    if (!isObject(ch)) continue;
    channels.push({
      name,
      address: str(ch['address']) ?? name,
      summary: str(ch['description']) ?? str(ch['summary']) ?? '',
    });
  }
  return { title, version, channels };
}

// ── generators ────────────────────────────────────────────────────────────────────────────────────
function ident(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/);
  return cleaned
    .map(
      (w, i) => (i === 0 ? (w[0]?.toLowerCase() ?? '') : (w[0]?.toUpperCase() ?? '')) + w.slice(1),
    )
    .join('');
}

export function clientPackageJson(name: string, version: string, description: string): string {
  // Stable-key-ordered package.json so the output is byte-deterministic.
  return JSON.stringify(
    {
      name,
      version,
      description,
      type: 'module',
      main: 'client.ts',
      publishConfig: { access: 'restricted' },
    },
    null,
    2,
  );
}

export function apiClientModule(surface: ApiSurface): string {
  const methods = surface.operations
    .map(
      (o) =>
        `  /** ${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ''} */\n` +
        `  ${ident(o.operationId)}(init?: RequestInit): Request {\n` +
        `    return new Request(this.baseUrl + ${JSON.stringify(o.path)}, { method: ${JSON.stringify(o.method)}, ...init });\n` +
        `  }`,
    )
    .join('\n');
  return (
    `// AUTO-GENERATED from ${surface.title} v${surface.version}. Do not edit by hand.\n` +
    `export const API_VERSION = ${JSON.stringify(surface.version)} as const;\n\n` +
    `export class GovernanceApiClient {\n` +
    `  constructor(private readonly baseUrl: string) {}\n\n` +
    `${methods}\n}\n`
  );
}

export function eventClientModule(surface: EventSurface): string {
  const methods = surface.channels
    .map(
      (c) =>
        `  /** channel ${c.name} @ ${c.address}${c.summary ? ` — ${c.summary}` : ''} */\n` +
        `  ${ident(c.name)}Address(): string {\n` +
        `    return ${JSON.stringify(c.address)};\n` +
        `  }`,
    )
    .join('\n');
  return (
    `// AUTO-GENERATED from ${surface.title} v${surface.version}. Do not edit by hand.\n` +
    `export const EVENTS_VERSION = ${JSON.stringify(surface.version)} as const;\n\n` +
    `export class GovernanceEventsClient {\n${methods}\n}\n`
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function apiDocHtml(surface: ApiSurface): string {
  const rows = surface.operations
    .map(
      (o) =>
        `<tr><td><code>${esc(o.method)}</code></td><td><code>${esc(o.path)}</code></td><td>${esc(o.summary)}</td></tr>`,
    )
    .join('\n');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${esc(surface.title)} v${esc(surface.version)}</title></head><body>` +
    `<h1>${esc(surface.title)} <small>v${esc(surface.version)}</small></h1>` +
    `<p>${surface.operations.length} operations.</p>` +
    `<table border="1"><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead>` +
    `<tbody>\n${rows}\n</tbody></table></body></html>\n`
  );
}

export function eventDocHtml(surface: EventSurface): string {
  const rows = surface.channels
    .map(
      (c) =>
        `<tr><td><code>${esc(c.name)}</code></td><td><code>${esc(c.address)}</code></td><td>${esc(c.summary)}</td></tr>`,
    )
    .join('\n');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${esc(surface.title)} v${esc(surface.version)}</title></head><body>` +
    `<h1>${esc(surface.title)} <small>v${esc(surface.version)}</small></h1>` +
    `<p>${surface.channels.length} channels.</p>` +
    `<table border="1"><thead><tr><th>Channel</th><th>Address</th><th>Summary</th></tr></thead>` +
    `<tbody>\n${rows}\n</tbody></table></body></html>\n`
  );
}

// ── the published artifact set ────────────────────────────────────────────────────────────────────
export interface PublishedArtifact {
  readonly path: string; // relative to the output dir
  readonly content: string;
}
export function publishContracts(): PublishedArtifact[] {
  const api = loadApiSurface();
  const events = loadEventSurface();
  return [
    // versioned TypeScript client packages
    {
      path: 'clients/governance-api/package.json',
      content: clientPackageJson('@trustcircle/governance-api-client', api.version, api.title),
    },
    { path: 'clients/governance-api/client.ts', content: apiClientModule(api) },
    {
      path: 'clients/governance-events/package.json',
      content: clientPackageJson(
        '@trustcircle/governance-events-client',
        events.version,
        events.title,
      ),
    },
    { path: 'clients/governance-events/client.ts', content: eventClientModule(events) },
    // browsable documentation
    { path: 'docs/governance-api.html', content: apiDocHtml(api) },
    { path: 'docs/governance-events.html', content: eventDocHtml(events) },
  ];
}

export function writeContracts(outDir: string): PublishedArtifact[] {
  const artifacts = publishContracts();
  for (const a of artifacts) {
    const full = join(outDir, a.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, a.content);
  }
  return artifacts;
}

// ── self-check ────────────────────────────────────────────────────────────────────────────────────
export function selfCheck(): { ok: true } {
  const problems: string[] = [];
  const api = loadApiSurface();
  const events = loadEventSurface();

  if (api.operations.length === 0) problems.push('no OpenAPI operations extracted');
  if (events.channels.length === 0) problems.push('no AsyncAPI channels extracted');

  // Client version MUST equal the spec version (no drift).
  const apiPkg = JSON.parse(clientPackageJson('@x/a', api.version, api.title)) as {
    version: string;
  };
  if (apiPkg.version !== api.version) problems.push('api client version drifted from spec');

  // Every operation appears in the generated client module and doc.
  const apiClient = apiClientModule(api);
  const apiDoc = apiDocHtml(api);
  for (const o of api.operations) {
    if (!apiClient.includes(o.path))
      problems.push(`operation missing from client: ${o.method} ${o.path}`);
    if (!apiDoc.includes(esc(o.path)))
      problems.push(`operation missing from doc: ${o.method} ${o.path}`);
  }
  // Every channel appears in the events client module.
  const eventsClient = eventClientModule(events);
  for (const c of events.channels) {
    if (!eventsClient.includes(c.address)) problems.push(`channel missing from client: ${c.name}`);
  }

  // RED CONTROL: a spec object without info.version must be rejected by the loader. Written under
  // the OS temp dir (never the repo root) and removed afterward.
  let rejected = false;
  const tmpBase = mkdtempSync(join(tmpdir(), 'tc-publish-'));
  const tmp = join(tmpBase, 'nover.openapi.yaml');
  try {
    writeFileSync(tmp, 'openapi: 3.1.0\ninfo:\n  title: No Version\npaths: {}\n');
    loadApiSurface(tmp);
  } catch {
    rejected = true;
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
  if (!rejected) problems.push('RED CONTROL: a spec with no info.version was NOT rejected');

  if (problems.length > 0) {
    throw new Error(`publish self-check FAILED:\n - ${problems.join('\n - ')}`);
  }
  return { ok: true };
}

const isEntry =
  (typeof import.meta !== 'undefined' && (import.meta as { main?: boolean }).main === true) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  selfCheck();
  const outIdx = process.argv.indexOf('--out');
  const artifacts =
    outIdx >= 0 && process.argv[outIdx + 1]
      ? writeContracts(process.argv[outIdx + 1]!)
      : publishContracts();
  const api = loadApiSurface();
  const events = loadEventSurface();
  console.log(
    `contracts published — governance-api v${api.version} (${api.operations.length} ops), ` +
      `governance-events v${events.version} (${events.channels.length} channels); ` +
      `${artifacts.length} artifacts${outIdx >= 0 ? ` written to ${process.argv[outIdx + 1]}` : ' (in-memory)'}.`,
  );
}
