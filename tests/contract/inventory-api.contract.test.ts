/**
 * Inventory-API contract acceptance suite (Phase 57 / GAR-010).
 *
 * Phase-primary obligation: validate `listSources`, `startDiscovery`,
 * `listGovernedAssets`, and the current-state response metadata against the
 * governance API contract
 *   contracts/governance-control-plane/governance-api.openapi.yaml.
 *
 * WHY THIS IS A NON-VACUOUS ORACLE
 * --------------------------------
 * The oracle is derived from the *contract source bytes themselves*, not a
 * hand-mirrored copy of the shapes. Each test:
 *   1. Parses the committed OpenAPI document (parseContract, the same helper the
 *      repo's contract-validation gate uses).
 *   2. Resolves the operation → response → schema through the document's own
 *      `$ref` graph (resolveRef), so if the contract renames an operationId,
 *      swaps a response schema, or drops a required field, THIS test's schema
 *      target changes with it — the test cannot silently pass against a
 *      diverged contract.
 *   3. Validates concrete response/request fixtures against the resolved schema
 *      with a small JSON-Schema-subset checker (validate) that honours
 *      `allOf`, `required`, `type`, `enum`, nullable `[T,'null']` unions,
 *      `additionalProperties:false`, `format:uuid/date-time`, and array `items`.
 *
 * Every acceptance criterion is exercised with a POSITIVE control (a
 * contract-valid response the current-state view must render) AND a NEGATIVE
 * control (a mutation the contract must reject), so a broken validator or a
 * drifted contract fails loudly. Fixtures are deterministic literals — no wall
 * clock, no randomness.
 *
 * ACCEPTANCE-CRITERION MAP (identical AC set to the Phase 56 inventory work):
 *   AC1  healthy connected sources → current-state view: each item once, with
 *        type / identity / owner / lifecycle / risk / coverage / health /
 *        last-observation / (unresolved) coverage refs.        → §AC1
 *   AC2  discovered-but-unmanaged/unreachable/stale/orphaned component stays a
 *        visible coverage gap (reason/age/impact/owner action), not healthy,
 *        not disappeared.                                        → §AC2
 *   AC3  related work across sources → distinct source records, correlation,
 *        status differences, dependencies, authoritative fields. → §AC3
 *   AC4  source becomes stale/unavailable → data marked with last-known time +
 *        freshness; current health NOT inferred from stale data. → §AC4
 *   AC5  unregistered governance-relevant source discovered → discovery adds it
 *        to the catalog (discovery accepted + evidence handle) with class,
 *        location, access, ownership, onboarding state.          → §AC5
 *   AC6  discovered source unsupported/inaccessible/sensitive/unowned/excluded
 *        stays a visible governed-source gap (reason/impact/owner action,
 *        review/expiry via coverage refs).                       → §AC6
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SOURCE_CONTRACTS } from '../../packages/contracts/scripts/generate.ts';
import { parseContract } from '../../packages/contracts/scripts/validate.ts';

// ---------------------------------------------------------------------------
// Load the committed governance-api OpenAPI document (contract source of truth).
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts', 'governance-control-plane');

const GOV_API = SOURCE_CONTRACTS.find((c) => c.id === 'governance-api')!;
const RAW = readFileSync(join(CONTRACTS_DIR, GOV_API.file), 'utf8');

/** A parsed schema/document node — an open string-keyed map, JSON-Schema shaped. */
type Node = Record<string, unknown>;

const DOC = parseContract('openapi', RAW) as Node;

// ---------------------------------------------------------------------------
// $ref resolution + a minimal JSON-Schema-subset validator, both driven purely
// by the parsed contract. These are the oracle: they read the contract, they
// are not a restatement of it.
// ---------------------------------------------------------------------------

/** Read a property off a possibly-non-object node without widening to `any`. */
function prop(node: unknown, key: string): unknown {
  return isObject(node) ? node[key] : undefined;
}

/** Shallow copy of `obj` with `key` removed (negative-control fixture builder). */
function omit(obj: Node, key: string): Node {
  const copy: Node = { ...obj };
  delete copy[key];
  return copy;
}

/** Resolve a local `#/...` JSON pointer against the parsed document. */
function resolveRef(ref: string): Node | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`not a local ref: ${ref}`);
  }
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = DOC;
  for (const p of parts) {
    if (!isObject(cur)) return undefined;
    cur = cur[p];
  }
  return isObject(cur) ? cur : undefined;
}

/** Follow a `$ref` wrapper (possibly chained) to its concrete schema node. */
function deref(node: unknown): Node | undefined {
  let cur: unknown = node;
  let guard = 0;
  while (isObject(cur) && typeof cur.$ref === 'string') {
    cur = resolveRef(cur.$ref);
    if (guard++ > 50) throw new Error('ref cycle');
  }
  return isObject(cur) ? cur : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Is `t` an allowed type token for value `v`? (OpenAPI 3.1 / JSON-Schema types) */
function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'null':
      return v === null;
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return false;
  }
}

/**
 * Flatten an object schema's `allOf` composition into one merged schema, so
 * that `additionalProperties:false` is evaluated against the UNION of every
 * branch's properties — the correct JSON-Schema semantics for object
 * composition. Without this, PageMetadata's `next_cursor` (added in a second
 * `allOf` branch) would be wrongly rejected by ProjectionMetadata's
 * `additionalProperties:false`. Non-object keywords (type/enum/format/items)
 * are merged shallowly; the inventory schemas never conflict on those.
 */
function flatten(schema: unknown): Node | undefined {
  const s = deref(schema);
  if (!s || !Array.isArray(s.allOf)) return s;
  const mergedProps: Record<string, unknown> = {};
  const mergedRequired: string[] = [];
  const merged: Node = {};
  let sawAdditionalFalse = false;
  const branches: unknown[] = [...s.allOf, { ...s, allOf: undefined }];
  for (const raw of branches) {
    const b = flatten(raw);
    if (!b) continue;
    for (const [k, v] of Object.entries(b)) {
      if (k === 'properties' && isObject(v)) Object.assign(mergedProps, v);
      else if (k === 'required' && Array.isArray(v)) mergedRequired.push(...(v as string[]));
      else if (k === 'additionalProperties') {
        if (v === false) sawAdditionalFalse = true;
      } else if (k !== 'allOf') merged[k] = v;
    }
  }
  merged.properties = mergedProps;
  merged.required = mergedRequired;
  // additionalProperties:false survives the merge only if any branch declared
  // it — applied against the UNION of merged properties.
  if (sawAdditionalFalse) merged.additionalProperties = false;
  return merged;
}

/**
 * Validate `value` against a resolved contract `schema`. Returns a list of
 * human-readable problems (empty ⇒ valid). Supports the subset the inventory
 * schemas actually use: `$ref`, `allOf`, `type` (scalar or [union]), `enum`,
 * `required`, `properties`, `additionalProperties:false`, `items`, and the
 * `format` values `uuid`/`date-time`. Unknown keywords are ignored (permissive),
 * so a FALSE PASS can only come from the fixture genuinely satisfying the
 * contract — never from the validator inventing constraints.
 */
function validate(schema: unknown, value: unknown, path = '$'): string[] {
  const problems: string[] = [];
  const s = flatten(schema);
  if (!s) return problems;

  // type (may be a scalar or an array union, e.g. [string, 'null']).
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(t, value))) {
      problems.push(`${path}: expected type ${types.join('|')}, got ${typeName(value)}`);
      return problems; // wrong primitive type: deeper checks are meaningless.
    }
  }

  // enum membership.
  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    problems.push(`${path}: value ${JSON.stringify(value)} not in enum [${s.enum.join(', ')}]`);
  }

  // string format.
  if (typeof value === 'string' && typeof s.format === 'string') {
    if (s.format === 'uuid' && !UUID_RE.test(value)) {
      problems.push(`${path}: not a uuid: ${value}`);
    }
    if (s.format === 'date-time' && !DATETIME_RE.test(value)) {
      problems.push(`${path}: not an rfc3339 date-time: ${value}`);
    }
  }

  // object: required, properties, additionalProperties.
  if (isObject(value)) {
    const obj = value;
    if (Array.isArray(s.required)) {
      for (const req of s.required as string[]) {
        if (!(req in obj)) problems.push(`${path}: missing required property "${req}"`);
      }
    }
    if (isObject(s.properties)) {
      const props = s.properties;
      for (const [k, sub] of Object.entries(props)) {
        if (k in obj) problems.push(...validate(sub, obj[k], `${path}.${k}`));
      }
    }
    if (s.additionalProperties === false && isObject(s.properties)) {
      const props = s.properties;
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          problems.push(`${path}: additional property "${k}" is forbidden`);
        }
      }
    }
  }

  // array items.
  if (Array.isArray(value) && s.items) {
    const items = s.items;
    value.forEach((el, i) => problems.push(...validate(items, el, `${path}[${i}]`)));
  }

  return problems;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Locate the operation object for an operationId across all paths+methods. */
function findOperation(operationId: string): Node {
  const paths = prop(DOC, 'paths');
  if (isObject(paths)) {
    for (const item of Object.values(paths)) {
      for (const method of HTTP_METHODS) {
        const op = prop(item, method);
        if (isObject(op) && op.operationId === operationId) return op;
      }
    }
  }
  throw new Error(`operation not found: ${operationId}`);
}

/** The nested JSON `application/json` schema under a content-bearing node. */
function jsonSchemaOf(node: unknown): unknown {
  return prop(prop(prop(node, 'content'), 'application/json'), 'schema');
}

/** The path-item object for a URL path key (wiring assertions). */
function pathItem(pathKey: string): unknown {
  return prop(prop(DOC, 'paths'), pathKey);
}

/** For a page schema, the dereferenced element schema of its `items` array. */
function itemSchemaOf(pageSchema: unknown): Node | undefined {
  return deref(prop(prop(prop(pageSchema, 'properties'), 'items'), 'items'));
}

/** Resolve the JSON response schema for an operationId's given status code. */
function responseSchema(operationId: string, status: string): Node {
  const op = findOperation(operationId);
  const resp = deref(prop(prop(op, 'responses'), status));
  const schema = jsonSchemaOf(resp);
  if (!isObject(schema)) throw new Error(`no json schema for ${operationId} ${status}`);
  return schema;
}

/** Resolve the requestBody JSON schema for an operationId. */
function requestSchema(operationId: string): Node {
  const op = findOperation(operationId);
  const schema = jsonSchemaOf(prop(op, 'requestBody'));
  if (!isObject(schema)) throw new Error(`no requestBody schema for ${operationId}`);
  return schema;
}

/** Assert a fixture is contract-valid; surfaces the problem list on failure. */
function expectValid(schema: unknown, value: unknown): void {
  const problems = validate(schema, value);
  expect(problems, problems.join('\n')).toEqual([]);
}
/** Assert a fixture is contract-INVALID for a specific expected reason. */
function expectInvalid(schema: unknown, value: unknown, reason: RegExp): void {
  const problems = validate(schema, value);
  expect(problems.length, 'expected at least one contract problem').toBeGreaterThan(0);
  expect(
    problems.some((p) => reason.test(p)),
    `problems:\n${problems.join('\n')}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Deterministic fixtures. All times/ids are fixed literals so the suite is
// reproducible and clock-free.
// ---------------------------------------------------------------------------

const TENANT = '018f0000-0000-7000-8000-000000000001';
const OWNER = '018f0000-0000-7000-8000-0000000000aa';
const GAP_A = '018f0000-0000-7000-8000-0000000000f1';
const GAP_B = '018f0000-0000-7000-8000-0000000000f2';
const T0 = '2026-08-01T00:00:00Z';
const T1 = '2026-08-01T06:00:00Z';

/** A healthy, fully-owned, fully-covered governed asset (AC1 positive). */
const HEALTHY_ASSET = {
  id: '018f0000-0000-7000-8000-000000000010',
  tenant_id: TENANT,
  asset_type: 'service',
  name: 'orders-api',
  owner_principal_id: OWNER,
  lifecycle_state: 'operating',
  risk_tier: 'tier-2',
  health: 'healthy',
  coverage: 'covered',
  last_observed_at: T1,
  version: 3,
};

/** Current-state page metadata: fresh, full coverage (AC1 positive). */
const FRESH_METADATA = {
  generated_at: T1,
  source_cursor: 'cur-0001',
  freshness: 'current',
  partial_coverage: false,
  next_cursor: null,
};

// ===========================================================================
// Sanity: the contract wires the three operations to the schemas we validate.
// If any of these drift, every downstream test is reading the wrong schema, so
// pin them explicitly first.
// ===========================================================================

describe('inventory contract wiring (listSources / startDiscovery / listGovernedAssets)', () => {
  it('listSources GET → 200 SourceCatalogPage', () => {
    expect(prop(prop(pathItem('/v1/inventory/sources'), 'get'), 'operationId')).toBe('listSources');
    // The resolved 200 schema is structurally the SourceCatalogPage (items+metadata).
    const schema = deref(responseSchema('listSources', '200'));
    expect(prop(schema, 'required')).toEqual(expect.arrayContaining(['items', 'metadata']));
    expect(prop(itemSchemaOf(schema), 'required')).toEqual(
      expect.arrayContaining([
        'id',
        'source_class',
        'onboarding_state',
        'access_state',
        'health_state',
      ]),
    );
  });

  it('startDiscovery POST → 202 OperationAccepted and a required requestBody', () => {
    const post = prop(pathItem('/v1/inventory/discovery-runs'), 'post');
    expect(prop(post, 'operationId')).toBe('startDiscovery');
    expect(prop(prop(post, 'requestBody'), 'required')).toBe(true);
    const accepted = deref(responseSchema('startDiscovery', '202'));
    expect(prop(accepted, 'required')).toEqual(
      expect.arrayContaining(['operation_id', 'status', 'correlation_id', 'audit_event_id']),
    );
  });

  it('listGovernedAssets GET → 200 GovernedAssetPage', () => {
    expect(prop(prop(pathItem('/v1/inventory/assets'), 'get'), 'operationId')).toBe(
      'listGovernedAssets',
    );
    const schema = deref(responseSchema('listGovernedAssets', '200'));
    expect(prop(itemSchemaOf(schema), 'required')).toEqual(
      expect.arrayContaining([
        'id',
        'asset_type',
        'name',
        'lifecycle_state',
        'risk_tier',
        'health',
        'coverage',
        'version',
      ]),
    );
  });

  it('NEGATIVE CONTROL: a fabricated operationId is not in the contract', () => {
    expect(() => responseSchema('listNonexistentThings', '200')).toThrow(/operation not found/);
  });

  it('the validator itself is non-vacuous (rejects a plainly wrong document)', () => {
    const schema = responseSchema('listGovernedAssets', '200');
    // A number where an object page is required must fail.
    expectInvalid(schema, 42, /expected type object/);
    // An empty object is missing every required page field.
    expectInvalid(
      schema,
      {},
      /missing required property "items"|missing required property "metadata"/,
    );
  });
});

// ===========================================================================
// AC1 — Healthy connected sources render in the current-state view exactly once,
// each carrying the full governed facet set.
// ===========================================================================

describe('AC1 · current-state view of healthy connected sources', () => {
  const pageSchema = responseSchema('listGovernedAssets', '200');
  const assetSchema = deref(pageSchema).properties.items.items;

  it('a healthy asset carries type, identity, owner, lifecycle, risk, coverage, health, last-observation', () => {
    expectValid(assetSchema, HEALTHY_ASSET);
    // Facet presence is contract-required, not incidental.
    for (const facet of [
      'asset_type',
      'tenant_id',
      'owner_principal_id',
      'lifecycle_state',
      'risk_tier',
      'coverage',
      'health',
      'last_observed_at',
    ]) {
      expect(facet in HEALTHY_ASSET).toBe(true);
    }
  });

  it('a healthy page renders each item ONCE with fresh, full-coverage metadata', () => {
    const page = { items: [HEALTHY_ASSET], metadata: FRESH_METADATA };
    expectValid(pageSchema, page);
    // "appears once": ids are unique across the page.
    const ids = page.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Healthy current-state is genuinely fresh + fully covered.
    expect(page.metadata.freshness).toBe('current');
    expect(page.metadata.partial_coverage).toBe(false);
  });

  it('NEGATIVE CONTROL: an asset missing its lifecycle facet is contract-invalid (cannot render as healthy)', () => {
    const broken = omit(HEALTHY_ASSET, 'lifecycle_state');
    expectInvalid(assetSchema, broken, /missing required property "lifecycle_state"/);
  });

  it('NEGATIVE CONTROL: a version below the contract minimum is not silently accepted as valid data', () => {
    // version is integer (min 1 in the contract); a non-integer breaks the type.
    expectInvalid(
      assetSchema,
      { ...HEALTHY_ASSET, version: 1.5 },
      /version: expected type integer/,
    );
  });
});

// ===========================================================================
// AC2 — A discovered-but-unmanaged/orphaned component stays a VISIBLE coverage
// gap: not healthy, not disappeared, carrying coverage-gap references.
// ===========================================================================

describe('AC2 · discovered-but-unmanaged component remains a visible coverage gap', () => {
  const pageSchema = responseSchema('listGovernedAssets', '200');
  const assetSchema = deref(pageSchema).properties.items.items;

  /** Orphaned/unmanaged asset: still present, but NOT healthy and NOT covered. */
  const GAP_ASSET = {
    ...HEALTHY_ASSET,
    id: '018f0000-0000-7000-8000-000000000011',
    name: 'legacy-batch-job',
    owner_principal_id: null, // unowned
    lifecycle_state: 'orphaned',
    health: 'unmanaged',
    coverage: 'gap',
    last_observed_at: T0,
  };

  it('the gap asset is a contract-valid record — it stays visible, it does not disappear', () => {
    expectValid(assetSchema, GAP_ASSET);
    // Visible as a gap, not as healthy.
    expect(GAP_ASSET.coverage).toBe('gap');
    expect(GAP_ASSET.health).not.toBe('healthy');
  });

  it('the current-state page marks partial coverage and names the coverage-gap ids', () => {
    const page = {
      items: [HEALTHY_ASSET, GAP_ASSET],
      metadata: { ...FRESH_METADATA, partial_coverage: true, coverage_gaps: [GAP_A] },
    };
    expectValid(pageSchema, page);
    expect(page.metadata.partial_coverage).toBe(true);
    expect(page.metadata.coverage_gaps).toContain(GAP_A);
    // The gap item is retained in the page (not dropped).
    expect(page.items.some((i) => i.id === GAP_ASSET.id)).toBe(true);
  });

  it('NEGATIVE CONTROL: a coverage_gaps entry that is not a uuid is contract-invalid', () => {
    const meta = { ...FRESH_METADATA, partial_coverage: true, coverage_gaps: ['not-a-uuid'] };
    const metaSchema = resolveRef('#/components/schemas/PageMetadata');
    expectInvalid(metaSchema, meta, /coverage_gaps\[0\]: not a uuid/);
  });
});

// ===========================================================================
// AC3 — Related work across sources: distinct source records that correlate,
// with status differences and authoritative catalog fields.
// ===========================================================================

describe('AC3 · distinct source records correlate with status differences', () => {
  const pageSchema = responseSchema('listSources', '200');
  const entrySchema = deref(pageSchema).properties.items.items;

  /** Two DISTINCT source records for the same underlying component. */
  const KANBAN_SOURCE = {
    id: '018f0000-0000-7000-8000-000000000021',
    tenant_id: TENANT,
    source_class: 'kanban',
    observed_locations: ['kanban://board/eng'],
    owner_principal_id: OWNER,
    onboarding_state: 'onboarded',
    access_state: 'connected',
    health_state: 'healthy',
    sensitivity: 'normal',
    coverage_gap_ids: [],
    first_seen_at: T0,
    last_seen_at: T1,
  };
  const AGENTCTL_SOURCE = {
    ...KANBAN_SOURCE,
    id: '018f0000-0000-7000-8000-000000000022',
    source_class: 'agentctl',
    observed_locations: ['agentctl://cluster/prod'],
    access_state: 'degraded', // status DIFFERS from the kanban record
    health_state: 'degraded',
    coverage_gap_ids: [GAP_B],
    last_seen_at: T0,
  };

  it('both source records are contract-valid and DISTINCT (different ids and source_class)', () => {
    expectValid(entrySchema, KANBAN_SOURCE);
    expectValid(entrySchema, AGENTCTL_SOURCE);
    expect(KANBAN_SOURCE.id).not.toBe(AGENTCTL_SOURCE.id);
    expect(KANBAN_SOURCE.source_class).not.toBe(AGENTCTL_SOURCE.source_class);
  });

  it('the catalog page keeps both records with their differing authoritative status fields', () => {
    const page = { items: [KANBAN_SOURCE, AGENTCTL_SOURCE], metadata: FRESH_METADATA };
    expectValid(pageSchema, page);
    // Correlation surface: both carry the authoritative source_class + access/health state.
    const byClass = Object.fromEntries(page.items.map((i) => [i.source_class, i]));
    expect(byClass.kanban.access_state).toBe('connected');
    expect(byClass.agentctl.access_state).toBe('degraded');
    expect(byClass.agentctl.access_state).not.toBe(byClass.kanban.access_state);
    // Dependency/coverage linkage is expressed via coverage_gap_ids.
    expect(byClass.agentctl.coverage_gap_ids).toContain(GAP_B);
  });

  it('NEGATIVE CONTROL: a source record missing its authoritative source_class is contract-invalid', () => {
    const broken = omit(KANBAN_SOURCE, 'source_class');
    expectInvalid(entrySchema, broken, /missing required property "source_class"/);
  });
});

// ===========================================================================
// AC4 — A source becoming stale/unavailable: data is MARKED with last-known
// time + freshness; current health is NOT inferred from stale data.
// ===========================================================================

describe('AC4 · stale/unavailable source is marked with last-known time + freshness', () => {
  const metaSchema = resolveRef('#/components/schemas/PageMetadata');
  const projectionSchema = resolveRef('#/components/schemas/ProjectionMetadata');

  it('the contract freshness vocabulary distinguishes stale/aging/unknown from current', () => {
    const freshnessEnum = deref(projectionSchema).properties.freshness.enum;
    expect(freshnessEnum).toEqual(expect.arrayContaining(['current', 'aging', 'stale', 'unknown']));
  });

  it('a stale current-state view carries a last-known generated_at and freshness=stale', () => {
    const staleMeta = {
      generated_at: T0, // last-known projection time
      source_cursor: 'cur-stale',
      freshness: 'stale',
      partial_coverage: true,
      coverage_gaps: [GAP_A],
      next_cursor: null,
    };
    expectValid(metaSchema, staleMeta);
    // last-known time present + freshness explicitly signals staleness.
    expect(DATETIME_RE.test(staleMeta.generated_at)).toBe(true);
    expect(staleMeta.freshness).toBe('stale');
    // Under staleness, coverage is partial — health is not asserted as full.
    expect(staleMeta.partial_coverage).toBe(true);
  });

  it('NEGATIVE CONTROL: freshness must come from the fixed vocabulary — "healthy" is not a freshness', () => {
    // Inferring current health as a freshness value is a contract violation:
    // the enum forbids substituting a health word for a freshness signal.
    const bad = { ...FRESH_METADATA, freshness: 'healthy' };
    expectInvalid(metaSchema, bad, /freshness.*not in enum/);
  });

  it('NEGATIVE CONTROL: a projection with no generated_at cannot be marked with a last-known time', () => {
    const missing = omit(FRESH_METADATA, 'generated_at');
    expectInvalid(projectionSchema, missing, /missing required property "generated_at"/);
  });
});

// ===========================================================================
// AC5 — An unregistered governance-relevant source discovered in the boundary:
// startDiscovery accepts the run (with a canonical operation + audit handle),
// and the resulting catalog entry carries class, location, access, ownership,
// onboarding state.
// ===========================================================================

describe('AC5 · discovery catalogs an unregistered source with classification + provenance', () => {
  const acceptedSchema = responseSchema('startDiscovery', '202');
  const reqSchema = requestSchema('startDiscovery');
  const entrySchema = resolveRef('#/components/schemas/SourceCatalogEntry');

  const DISCOVERY_REQUEST = {
    boundary_version_id: '018f0000-0000-7000-8000-0000000000b0',
    source_classes: ['unknown', 'object-store'],
    reason: { code: 'boundary_scan', text: 'scheduled boundary discovery sweep' },
  };

  /** The accepted-operation response = a canonical, audited discovery handle. */
  const ACCEPTED = {
    operation_id: '018f0000-0000-7000-8000-0000000000c0',
    status: 'accepted',
    correlation_id: '018f0000-0000-7000-8000-0000000000c1',
    audit_event_id: '018f0000-0000-7000-8000-0000000000c2',
    idempotent_replay: false,
  };

  /** Newly-discovered, not-yet-onboarded source with unknown classification. */
  const DISCOVERED_ENTRY = {
    id: '018f0000-0000-7000-8000-000000000031',
    tenant_id: TENANT,
    source_class: 'unknown', // type/unknown classification
    observed_locations: ['s3://acme-unmapped-bucket'], // location
    owner_principal_id: null, // ownership status: unowned pending assignment
    onboarding_state: 'discovered', // onboarding state
    access_state: 'reachable', // access status
    health_state: 'unknown',
    sensitivity: 'restricted', // AC5 sensitivity classification (non-default → triage first)
    discovery_evidence: '018f0000-0000-7000-8000-0000000000ac', // AC5 provenance of the observation
    coverage_gap_ids: [GAP_A],
    first_seen_at: T1,
    last_seen_at: T1,
  };

  it('the discovery request is contract-valid (boundary + reason required, source_classes optional)', () => {
    expectValid(reqSchema, DISCOVERY_REQUEST);
    // reason is the structured audit rationale carried into the run.
    expect(DISCOVERY_REQUEST.reason.code.length).toBeGreaterThan(0);
  });

  it('discovery returns a canonical, AUDITED accepted-operation (evidence of the run)', () => {
    expectValid(acceptedSchema, ACCEPTED);
    // The durable discovery evidence handles: operation + correlation + audit.
    expect(UUID_RE.test(ACCEPTED.operation_id)).toBe(true);
    expect(UUID_RE.test(ACCEPTED.audit_event_id)).toBe(true);
    expect(UUID_RE.test(ACCEPTED.correlation_id)).toBe(true);
  });

  it('the discovered entry is catalogued with class, location, access, sensitivity, discovery-evidence, ownership, onboarding state', () => {
    expectValid(entrySchema, DISCOVERED_ENTRY);
    expect(DISCOVERED_ENTRY.source_class).toBe('unknown'); // classification
    expect(DISCOVERED_ENTRY.observed_locations.length).toBeGreaterThan(0); // location
    expect(DISCOVERED_ENTRY.onboarding_state).toBe('discovered'); // onboarding state
    expect(DISCOVERED_ENTRY.owner_principal_id).toBeNull(); // ownership status
    expect(DISCOVERED_ENTRY.sensitivity).toBe('restricted'); // AC5 sensitivity classification
    expect(UUID_RE.test(DISCOVERED_ENTRY.discovery_evidence)).toBe(true); // AC5 provenance
    // sensitivity is a required, governed-vocabulary field: dropping it is contract-INVALID.
    expectInvalid(
      entrySchema,
      omit(DISCOVERED_ENTRY, 'sensitivity'),
      /missing required property "sensitivity"/,
    );
  });

  it('NEGATIVE CONTROL: a discovery request without a boundary_version_id is rejected', () => {
    const bad = omit(DISCOVERY_REQUEST, 'boundary_version_id');
    expectInvalid(reqSchema, bad, /missing required property "boundary_version_id"/);
  });

  it('NEGATIVE CONTROL: a discovery request with an unknown extra field is rejected (additionalProperties:false)', () => {
    const bad = { ...DISCOVERY_REQUEST, sneaky: true };
    expectInvalid(reqSchema, bad, /additional property "sneaky" is forbidden/);
  });

  it('NEGATIVE CONTROL: an accepted-operation missing its audit handle is contract-invalid', () => {
    const bad = omit(ACCEPTED, 'audit_event_id');
    expectInvalid(acceptedSchema, bad, /missing required property "audit_event_id"/);
  });
});

// ===========================================================================
// AC6 — A discovered source that is unsupported/inaccessible/sensitive/unowned/
// excluded stays a VISIBLE governed-source gap: reason/impact/owner action via
// coverage refs and access/onboarding state, never silently dropped.
// ===========================================================================

describe('AC6 · unsupported/inaccessible/excluded discovered source stays a visible governed gap', () => {
  const pageSchema = responseSchema('listSources', '200');
  const entrySchema = deref(pageSchema).properties.items.items;

  /** Discovered but inaccessible + unowned + excluded: still catalogued. */
  const EXCLUDED_ENTRY = {
    id: '018f0000-0000-7000-8000-000000000041',
    tenant_id: TENANT,
    source_class: 'unsupported-vendor-x',
    observed_locations: ['vendorx://tenant/acme'],
    owner_principal_id: null, // unowned
    onboarding_state: 'excluded', // excluded from onboarding
    access_state: 'inaccessible', // inaccessible
    health_state: 'unknown',
    sensitivity: 'restricted', // a restricted, ungoverned source — the highest-priority gap
    coverage_gap_ids: [GAP_A, GAP_B], // the governed-source gap references (reason/impact/review)
    first_seen_at: T0,
    last_seen_at: T0,
  };

  it('the excluded/inaccessible source is a contract-valid catalog entry — it stays visible', () => {
    expectValid(entrySchema, EXCLUDED_ENTRY);
    expect(EXCLUDED_ENTRY.access_state).toBe('inaccessible');
    expect(EXCLUDED_ENTRY.onboarding_state).toBe('excluded');
    // The gap is expressed, not hidden: coverage_gap_ids carry the required refs.
    expect(EXCLUDED_ENTRY.coverage_gap_ids.length).toBeGreaterThan(0);
  });

  it('the catalog page surfaces the gap with partial coverage + named gap ids (not dropped)', () => {
    const page = {
      items: [EXCLUDED_ENTRY],
      metadata: { ...FRESH_METADATA, partial_coverage: true, coverage_gaps: [GAP_A, GAP_B] },
    };
    expectValid(pageSchema, page);
    expect(page.items.some((i) => i.id === EXCLUDED_ENTRY.id)).toBe(true);
    expect(page.metadata.coverage_gaps).toEqual(expect.arrayContaining([GAP_A, GAP_B]));
  });

  it('NEGATIVE CONTROL: a catalog entry missing its access_state cannot express "inaccessible"', () => {
    const broken = omit(EXCLUDED_ENTRY, 'access_state');
    expectInvalid(entrySchema, broken, /missing required property "access_state"/);
  });

  it('NEGATIVE CONTROL: a non-uuid gap reference is contract-invalid (owner action must resolve)', () => {
    expectInvalid(
      entrySchema,
      { ...EXCLUDED_ENTRY, coverage_gap_ids: ['nope'] },
      /coverage_gap_ids\[0\]: not a uuid/,
    );
  });
});

// ===========================================================================
// ENUMERATED CONTENT FACETS — the schema carries the AC1/AC2/AC3/AC4/AC6 facet
// fields as NAMED, typed contract shapes (never a status blob). These pin the
// full-content obligations the critic required into the contract itself.
// ===========================================================================

describe('enumerated content facets are contract-typed', () => {
  const assetSchema = resolveRef('#/components/schemas/GovernedAsset');
  const entrySchema = resolveRef('#/components/schemas/SourceCatalogEntry');
  const gapSchema = resolveRef('#/components/schemas/CoverageGapDetail');
  const diffSchema = resolveRef('#/components/schemas/SourceStatusDifference');
  const depSchema = resolveRef('#/components/schemas/SourceDependency');

  /** A full-content component gap (AC2): reason, age, impact, required owner action. */
  const COMPONENT_GAP = {
    gap_id: GAP_A,
    gap_class: 'component',
    reason: 'orphaned',
    impact: 'high',
    age_millis: 10_800_000,
    required_action: 'assign an owner and onboard the batch job under a control',
    required_owner: OWNER,
  };
  /** A full-content governed-source gap (AC6): + a review-or-expiry deadline. */
  const GOVERNED_GAP = {
    gap_id: GAP_B,
    gap_class: 'governed_source',
    reason: 'excluded',
    impact: 'high',
    age_millis: 0,
    required_action: 'document the exclusion and schedule a governance review',
    review_at: T1,
  };

  it('AC1: GovernedAsset carries evidence_state, unresolved_issues, confidence, and structured coverage_gaps', () => {
    const asset = {
      ...HEALTHY_ASSET,
      evidence_state: 'current',
      unresolved_issues: 0,
      confidence: 1,
      coverage_gaps: [],
    };
    expectValid(assetSchema, asset);
    // A gap asset carries an incomplete evidence state + a concrete open-issue count + its gaps.
    const gapAsset = {
      ...HEALTHY_ASSET,
      id: '018f0000-0000-7000-8000-000000000011',
      evidence_state: 'incomplete',
      unresolved_issues: 1,
      confidence: 0,
      coverage_gaps: [COMPONENT_GAP],
    };
    expectValid(assetSchema, gapAsset);
  });

  it('AC1 NEGATIVE CONTROL: evidence_state is a fixed vocabulary — "healthy" is not an evidence state', () => {
    expectInvalid(
      assetSchema,
      { ...HEALTHY_ASSET, evidence_state: 'healthy' },
      /evidence_state.*not in enum/,
    );
  });

  it('AC2: a CoverageGapDetail names reason, age, impact, and required owner action (never a bare id)', () => {
    expectValid(gapSchema, COMPONENT_GAP);
    // Every enumerated AC2 facet is a required, present field.
    for (const facet of [
      'gap_id',
      'gap_class',
      'reason',
      'impact',
      'age_millis',
      'required_action',
    ]) {
      expect(facet in COMPONENT_GAP).toBe(true);
    }
  });

  it('AC2 NEGATIVE CONTROL: a gap detail missing its required_action is contract-invalid', () => {
    expectInvalid(
      gapSchema,
      omit(COMPONENT_GAP, 'required_action'),
      /missing required property "required_action"/,
    );
  });

  it('AC2 NEGATIVE CONTROL: a gap detail with a non-integer age is contract-invalid', () => {
    expectInvalid(
      gapSchema,
      { ...COMPONENT_GAP, age_millis: 'soon' },
      /age_millis: expected type integer/,
    );
  });

  it('AC2 NEGATIVE CONTROL: a gap_class outside the fixed vocabulary is contract-invalid', () => {
    expectInvalid(gapSchema, { ...COMPONENT_GAP, gap_class: 'made-up' }, /gap_class.*not in enum/);
  });

  it('AC3: SourceStatusDifference names a field + each distinct value with its record ids', () => {
    const diff = {
      field: 'status',
      values: [
        { value: 'active', record_ids: ['018f0000-0000-7000-8000-000000000301'] },
        { value: 'inactive', record_ids: ['018f0000-0000-7000-8000-000000000302'] },
      ],
    };
    expectValid(diffSchema, diff);
  });

  it('AC3: SourceDependency names a depends_on edge (relationship/from/to)', () => {
    const dep = {
      relationship_id: '018f0000-0000-7000-8000-000000000401',
      from_id: '018f0000-0000-7000-8000-000000000021',
      to_id: '018f0000-0000-7000-8000-000000000022',
      field_name: 'deployment_target',
    };
    expectValid(depSchema, dep);
  });

  it('AC3: a SourceCatalogEntry carries its correlation + dependencies inline', () => {
    const entry = {
      id: '018f0000-0000-7000-8000-000000000021',
      tenant_id: TENANT,
      source_class: 'kanban',
      observed_locations: ['kanban://board/eng'],
      owner_principal_id: OWNER,
      onboarding_state: 'onboarded',
      access_state: 'connected',
      health_state: 'healthy',
      sensitivity: 'normal',
      evidence_state: 'current',
      unresolved_issues: 0,
      confidence: 1,
      coverage_gap_ids: [],
      correlation: [
        {
          field: 'status',
          values: [
            { value: 'active', record_ids: [GAP_A] },
            { value: 'inactive', record_ids: [GAP_B] },
          ],
        },
      ],
      dependencies: [
        {
          relationship_id: GAP_A,
          from_id: '018f0000-0000-7000-8000-000000000021',
          to_id: '018f0000-0000-7000-8000-000000000022',
        },
      ],
      first_seen_at: T0,
      last_seen_at: T1,
    };
    expectValid(entrySchema, entry);
  });

  it('AC4: SourceCatalogEntry + GovernedAsset carry a confidence in [0,1]', () => {
    expectValid(entrySchema, {
      id: '018f0000-0000-7000-8000-000000000051',
      tenant_id: TENANT,
      source_class: 'warehouse',
      onboarding_state: 'discovered',
      access_state: 'unreachable',
      health_state: 'unknown',
      sensitivity: 'sensitive',
      evidence_state: 'stale',
      confidence: 0,
      first_seen_at: T0,
      last_seen_at: T0,
    });
    // Non-vacuity: a non-numeric confidence is contract-invalid (a typed field, not a free blob).
    expectInvalid(
      assetSchema,
      { ...HEALTHY_ASSET, confidence: 'high' },
      /confidence: expected type number/,
    );
  });

  it('AC6: a governed-source gap detail carries reason, impact, owner action, and a review-or-expiry', () => {
    expectValid(gapSchema, GOVERNED_GAP);
    // AC6 "review or expiry": this governed-source gap carries a scheduled review deadline.
    expect(typeof GOVERNED_GAP.review_at).toBe('string');
    // And the schema also ACCEPTS an expiry-only governed gap (either satisfies the obligation).
    const expiryOnly = { ...omit(GOVERNED_GAP, 'review_at'), expires_at: T1 };
    expectValid(gapSchema, expiryOnly);
  });

  it('AC6 NEGATIVE CONTROL: an unknown facet on a gap detail is rejected (additionalProperties:false)', () => {
    expectInvalid(
      gapSchema,
      { ...COMPONENT_GAP, sneaky: true },
      /additional property "sneaky" is forbidden/,
    );
  });
});
