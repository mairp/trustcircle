/**
 * Compliance-API contract acceptance suite (Task T186).
 *
 * Phase-primary obligation: validate the compliance surface —
 *   - `listStandardsPublications` (global versioned publication facts),
 *   - `proposeApplicability` + `reviewApplicability` (independently-reviewed
 *      applicability decisions),
 *   - `getComplianceCoverage` (the SC-012 truthful-boundary coverage picture),
 *   - `getEvidenceMetadata` (a metadata-only evidence envelope),
 *   - `requestAuditExport` (an audited export command, FR-056 / SC-022)
 * against the governance API contract
 *   contracts/governance-control-plane/governance-api.openapi.yaml
 * (and, for the evidence envelope, its sibling
 *   contracts/governance-control-plane/evidence-envelope.schema.json).
 *
 * Requirements exercised: FR-031..035, FR-053, FR-056, SC-012, SC-022.
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
 * Every operation is exercised with a POSITIVE control (a contract-valid body
 * the surface must render/accept) AND at least one NEGATIVE control (a mutation
 * the contract must reject), so a broken validator or a drifted contract fails
 * loudly. Fixtures are deterministic literals — no wall clock, no randomness.
 * Realistic values are DERIVED from the shared `../fixtures/compliance.ts`
 * domain fixtures, but the WIRE bodies are built snake_case by hand (the
 * contract is snake_case; the domain fixtures are camelCase).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SOURCE_CONTRACTS } from '../../packages/contracts/scripts/generate.ts';
import { parseContract } from '../../packages/contracts/scripts/validate.ts';
import { PUBLICATION_42001, AUDIT_EXPORT_REQUEST, IDS, iso, NOW } from '../fixtures/compliance.ts';

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
 * composition. Without this, an ApplicabilityDecision (composed via `allOf`
 * over ApplicabilityProposal + the decision fields) would be wrongly rejected.
 * Non-object keywords (type/enum/format/items) are merged shallowly; the
 * compliance schemas never conflict on those.
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
 * human-readable problems (empty ⇒ valid). Supports the subset the compliance
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
// Deterministic wire fixtures. Values are DERIVED from the shared compliance
// domain fixtures, but built snake_case by hand (the wire contract is
// snake_case). All times/ids are fixed literals so the suite is clock-free.
// ---------------------------------------------------------------------------

const TENANT_ID = '018f0000-0000-7000-8000-000000000001';
const PROPOSER = '018f0000-0000-7000-8000-0000000000a1';
const REVIEWER = '018f0000-0000-7000-8000-0000000000a2';
const OWNER = '018f0000-0000-7000-8000-0000000000a3';
const CLAUSE_VERSION_ID = '018f0000-0000-7000-8000-0000000000b1';
const EVIDENCE_A = '018f0000-0000-7000-8000-0000000000c1';
const EVIDENCE_B = '018f0000-0000-7000-8000-0000000000c2';
const DECISION_ID = '018f0000-0000-7000-8000-0000000000d1';
const OPERATION_ID = '018f0000-0000-7000-8000-0000000000e1';
const CORRELATION_ID = '018f0000-0000-7000-8000-0000000000e2';
const AUDIT_EVENT_ID = '018f0000-0000-7000-8000-0000000000e3';
const REVIEW_AT = '2027-02-01T00:00:00Z';
const T_NOW = iso(NOW);

/** A global versioned publication FACT — wire shape (snake_case), derived from PUBLICATION_42001. */
const WIRE_PUBLICATION = {
  id: String(PUBLICATION_42001.id),
  publisher: PUBLICATION_42001.publisher,
  identifier: PUBLICATION_42001.identifier,
  exact_title: PUBLICATION_42001.exactTitle,
  edition: PUBLICATION_42001.edition,
  publication_date: PUBLICATION_42001.publicationDate, // format: date (YYYY-MM-DD)
  status: PUBLICATION_42001.status,
  material_type: PUBLICATION_42001.materialType,
  source_uri: PUBLICATION_42001.sourceUri,
  registry_version: Number(PUBLICATION_42001.registryVersion),
};

/** A contract-valid applicability PROPOSAL request body. */
const PROPOSAL_REQUEST = {
  clause_version_id: CLAUSE_VERSION_ID,
  system_id: String(IDS.SYSTEM_ID),
  jurisdiction: 'EU',
  use_case: { domain: 'credit-underwriting', risk_tier: 'high' },
  proposed_result: 'applicable',
  rationale: 'The clause applies: the system makes consequential automated decisions in the EU.',
  evidence_ids: [EVIDENCE_A, EVIDENCE_B],
  obligation_owner_principal_id: OWNER,
  effective_from: null,
  review_at: REVIEW_AT,
};

/** The proposal, projected to its persisted DECISION (proposal fields + decision fields). */
const DECISION_RESPONSE = {
  ...PROPOSAL_REQUEST,
  id: DECISION_ID,
  tenant_id: TENANT_ID,
  proposer_principal_id: PROPOSER,
  reviewer_principal_id: null,
  review_decision: null,
  status: 'proposed',
  version: 1,
};

/** An independently-reviewed decision (reviewer distinct from proposer) — reviewApplicability 200. */
const REVIEWED_DECISION_RESPONSE = {
  ...DECISION_RESPONSE,
  reviewer_principal_id: REVIEWER,
  review_decision: 'approve',
  status: 'active',
  version: 2,
};

/** The reviewApplicability request body — a structured action + audit reason. */
const REVIEW_REQUEST = {
  action: 'approve',
  reason: {
    code: 'independent_review_approved',
    text: 'Independent reviewer approved applicability.',
  },
};

/** A contract-valid audit-export command (scope / period{from,to} / reason{code,text}). */
const AUDIT_REQUEST = {
  scope: AUDIT_EXPORT_REQUEST.scope,
  period: { from: AUDIT_EXPORT_REQUEST.period.from, to: AUDIT_EXPORT_REQUEST.period.to },
  reason: { code: AUDIT_EXPORT_REQUEST.reason.code, text: AUDIT_EXPORT_REQUEST.reason.text },
};

/** A canonical, AUDITED accepted-operation (the export command's durable handle). */
const ACCEPTED = {
  operation_id: OPERATION_ID,
  status: 'accepted',
  correlation_id: CORRELATION_ID,
  audit_event_id: AUDIT_EVENT_ID,
  idempotent_replay: false,
};

/** The SC-012 coverage picture — truthful claim boundary + honest gap set. */
const COVERAGE_RESPONSE = {
  tenant_id: TENANT_ID,
  scope: { system_id: String(IDS.SYSTEM_ID), publication_id: String(IDS.PUB_42001_ID) },
  publications: [WIRE_PUBLICATION],
  obligations: [
    { id: '018f0000-0000-7000-8000-0000000000f1', duty_class: 'organizational_obligation' },
  ],
  controls: [{ id: '018f0000-0000-7000-8000-0000000000f2', operating_state: 'operating' }],
  evidence: [{ id: EVIDENCE_A, sufficiency: 'sufficient' }],
  gaps: [{ kind: 'stale_evidence', obligation_id: '018f0000-0000-7000-8000-0000000000f3' }],
  claim_boundary: 'ready',
  metadata: {
    generated_at: T_NOW,
    source_cursor: 'cov-0001',
    freshness: 'current',
    partial_coverage: false,
  },
};

// ===========================================================================
// Sanity: the contract wires each operation to the schema we validate. If any
// of these drift, every downstream test is reading the wrong schema, so pin
// them explicitly first.
// ===========================================================================

describe('compliance contract wiring', () => {
  it('listStandardsPublications GET → 200 StandardPublicationPage', () => {
    expect(prop(prop(pathItem('/v1/standards/publications'), 'get'), 'operationId')).toBe(
      'listStandardsPublications',
    );
    const schema = deref(responseSchema('listStandardsPublications', '200'));
    expect(prop(schema, 'required')).toEqual(expect.arrayContaining(['items', 'next_cursor']));
    expect(prop(itemSchemaOf(schema), 'required')).toEqual(
      expect.arrayContaining([
        'id',
        'publisher',
        'identifier',
        'exact_title',
        'edition',
        'publication_date',
        'status',
        'material_type',
        'source_uri',
        'registry_version',
      ]),
    );
  });

  it('proposeApplicability POST → 201 ApplicabilityDecision + a required requestBody', () => {
    const post = prop(pathItem('/v1/applicability-decisions'), 'post');
    expect(prop(post, 'operationId')).toBe('proposeApplicability');
    expect(prop(prop(post, 'requestBody'), 'required')).toBe(true);
    const decision = deref(responseSchema('proposeApplicability', '201'));
    // The decision is composed over the proposal via allOf; flatten merges both.
    expect(prop(flatten(decision), 'required')).toEqual(
      expect.arrayContaining(['id', 'tenant_id', 'proposer_principal_id', 'status', 'version']),
    );
  });

  it('reviewApplicability POST → 200 ApplicabilityDecision', () => {
    expect(
      prop(
        prop(pathItem('/v1/applicability-decisions/{applicabilityId}/actions'), 'post'),
        'operationId',
      ),
    ).toBe('reviewApplicability');
    expect(() => responseSchema('reviewApplicability', '200')).not.toThrow();
  });

  it('getComplianceCoverage GET → 200 ComplianceCoverage', () => {
    expect(prop(prop(pathItem('/v1/compliance/coverage'), 'get'), 'operationId')).toBe(
      'getComplianceCoverage',
    );
    const schema = deref(responseSchema('getComplianceCoverage', '200'));
    expect(prop(schema, 'required')).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'scope',
        'publications',
        'obligations',
        'controls',
        'evidence',
        'gaps',
        'claim_boundary',
        'metadata',
      ]),
    );
  });

  it('getEvidenceMetadata GET → 200 evidence envelope; requestAuditExport POST → 202 OperationAccepted', () => {
    expect(prop(prop(pathItem('/v1/evidence/{evidenceId}'), 'get'), 'operationId')).toBe(
      'getEvidenceMetadata',
    );
    expect(prop(prop(pathItem('/v1/audit/exports'), 'post'), 'operationId')).toBe(
      'requestAuditExport',
    );
    const accepted = deref(responseSchema('requestAuditExport', '202'));
    expect(prop(accepted, 'required')).toEqual(
      expect.arrayContaining(['operation_id', 'status', 'correlation_id', 'audit_event_id']),
    );
  });

  it('NEGATIVE CONTROL: a fabricated operationId is not in the contract', () => {
    expect(() => responseSchema('listNonexistentComplianceThings', '200')).toThrow(
      /operation not found/,
    );
  });

  it('the validator itself is non-vacuous (rejects a plainly wrong document)', () => {
    const schema = responseSchema('getComplianceCoverage', '200');
    expectInvalid(schema, 42, /expected type object/);
    expectInvalid(schema, {}, /missing required property "claim_boundary"/);
  });
});

// ===========================================================================
// FR-051 / FR-031 — Standards publications: global versioned publication facts.
// ===========================================================================

describe('listStandardsPublications · global versioned publication facts', () => {
  const pageSchema = deref(responseSchema('listStandardsPublications', '200'))!;
  const pubSchema = itemSchemaOf(pageSchema)!;

  it('a publication fact is contract-valid with every immutable-fact field present', () => {
    expectValid(pubSchema, WIRE_PUBLICATION);
    for (const facet of [
      'publisher',
      'identifier',
      'exact_title',
      'edition',
      'publication_date',
      'material_type',
      'source_uri',
      'registry_version',
    ]) {
      expect(facet in WIRE_PUBLICATION).toBe(true);
    }
  });

  it('a page renders the publications with a next_cursor (nullable)', () => {
    const page = { items: [WIRE_PUBLICATION], next_cursor: null };
    expectValid(pageSchema, page);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a publication missing its registry_version is contract-invalid', () => {
    expectInvalid(
      pubSchema,
      omit(WIRE_PUBLICATION, 'registry_version'),
      /missing required property "registry_version"/,
    );
  });

  it('NEGATIVE CONTROL: a non-integer registry_version is contract-invalid (versioning is monotone)', () => {
    expectInvalid(
      pubSchema,
      { ...WIRE_PUBLICATION, registry_version: 'v1' },
      /registry_version: expected type integer/,
    );
  });

  it('NEGATIVE CONTROL: a page missing next_cursor cannot signal end-of-stream', () => {
    expectInvalid(
      pageSchema,
      { items: [WIRE_PUBLICATION] },
      /missing required property "next_cursor"/,
    );
  });
});

// ===========================================================================
// FR-052..053 — proposeApplicability: a tenant-scoped applicability PROPOSAL
// that must await independent review (proposer ≠ reviewer).
// ===========================================================================

describe('proposeApplicability · applicability proposal + persisted decision', () => {
  const reqSchema = requestSchema('proposeApplicability');
  const respSchema = responseSchema('proposeApplicability', '201');

  it('the proposal request is contract-valid (clause/system/jurisdiction/result/rationale/evidence/review_at required)', () => {
    expectValid(reqSchema, PROPOSAL_REQUEST);
    expect(PROPOSAL_REQUEST.evidence_ids.length).toBeGreaterThan(0);
  });

  it('the 201 response is the persisted decision awaiting review (status proposed, no reviewer yet)', () => {
    expectValid(respSchema, DECISION_RESPONSE);
    // FR-053: on proposal there is no reviewer bound yet.
    expect(DECISION_RESPONSE.reviewer_principal_id).toBeNull();
    expect(DECISION_RESPONSE.status).toBe('proposed');
  });

  it('NEGATIVE CONTROL: a proposal missing its clause_version_id is rejected', () => {
    expectInvalid(
      reqSchema,
      omit(PROPOSAL_REQUEST, 'clause_version_id'),
      /missing required property "clause_version_id"/,
    );
  });

  it('NEGATIVE CONTROL: a proposal missing its rationale is rejected', () => {
    expectInvalid(
      reqSchema,
      omit(PROPOSAL_REQUEST, 'rationale'),
      /missing required property "rationale"/,
    );
  });

  it('NEGATIVE CONTROL: a made-up proposed_result is rejected (fixed applicability vocabulary)', () => {
    expectInvalid(
      reqSchema,
      { ...PROPOSAL_REQUEST, proposed_result: 'maybe' },
      /proposed_result.*not in enum/,
    );
  });

  it('NEGATIVE CONTROL: an unknown extra field is rejected (additionalProperties:false)', () => {
    expectInvalid(
      reqSchema,
      { ...PROPOSAL_REQUEST, sneaky: true },
      /additional property "sneaky" is forbidden/,
    );
  });

  it('NEGATIVE CONTROL: the persisted decision cannot omit its version (optimistic concurrency)', () => {
    expectInvalid(
      respSchema,
      omit(DECISION_RESPONSE, 'version'),
      /missing required property "version"/,
    );
  });
});

// ===========================================================================
// FR-053 — reviewApplicability: an INDEPENDENT review action binds a reviewer
// distinct from the proposer; the action + reason are the audited command.
// ===========================================================================

describe('reviewApplicability · independent review action', () => {
  const reqSchema = requestSchema('reviewApplicability');
  const respSchema = responseSchema('reviewApplicability', '200');

  it('the review request is contract-valid (action + reason required)', () => {
    expectValid(reqSchema, REVIEW_REQUEST);
  });

  it('the 200 response is the reviewed decision with a bound, DISTINCT reviewer (FR-053)', () => {
    expectValid(respSchema, REVIEWED_DECISION_RESPONSE);
    expect(REVIEWED_DECISION_RESPONSE.reviewer_principal_id).not.toBe(
      REVIEWED_DECISION_RESPONSE.proposer_principal_id,
    );
    expect(REVIEWED_DECISION_RESPONSE.status).toBe('active');
  });

  it('NEGATIVE CONTROL: a review action outside the fixed vocabulary is rejected', () => {
    expectInvalid(reqSchema, { ...REVIEW_REQUEST, action: 'rubber_stamp' }, /action.*not in enum/);
  });

  it('NEGATIVE CONTROL: a review missing its audit reason is rejected (no unaudited review)', () => {
    expectInvalid(reqSchema, omit(REVIEW_REQUEST, 'reason'), /missing required property "reason"/);
  });

  it('NEGATIVE CONTROL: a review reason with no code is contract-invalid', () => {
    expectInvalid(
      reqSchema,
      { ...REVIEW_REQUEST, reason: { text: 'approved' } },
      /reason.*missing required property "code"/,
    );
  });
});

// ===========================================================================
// SC-012 / FR-032..035 / FR-054 — getComplianceCoverage: a TRUTHFUL claim
// boundary. The boundary vocabulary must include the full readiness ladder
// (design → certified) plus `incomplete`, and CANNOT be conflated with an
// invented value like "accredited". Gaps are surfaced honestly.
// ===========================================================================

describe('getComplianceCoverage · truthful claim boundary + honest gaps (SC-012)', () => {
  const covSchema = responseSchema('getComplianceCoverage', '200');

  it('the coverage picture is contract-valid with a readiness-ladder claim_boundary', () => {
    expectValid(covSchema, COVERAGE_RESPONSE);
    expect(COVERAGE_RESPONSE.gaps.length).toBeGreaterThan(0); // gaps surfaced, not hidden
  });

  it('SC-012: the claim_boundary enum IS the truthful readiness ladder', () => {
    const enumValues = prop(prop(prop(deref(covSchema), 'properties'), 'claim_boundary'), 'enum');
    expect(enumValues).toEqual(
      expect.arrayContaining([
        'design',
        'implemented',
        'operating',
        'ready',
        'assessed',
        'certified',
        'incomplete',
      ]),
    );
  });

  it('SC-012: every ladder rung validates, so readiness is never silently upgraded', () => {
    for (const boundary of [
      'design',
      'implemented',
      'operating',
      'ready',
      'assessed',
      'certified',
      'incomplete',
    ]) {
      expectValid(covSchema, { ...COVERAGE_RESPONSE, claim_boundary: boundary });
    }
  });

  it('SC-012 NEGATIVE CONTROL: an invented boundary "accredited" is contract-invalid (certification is not conflatable)', () => {
    expectInvalid(
      covSchema,
      { ...COVERAGE_RESPONSE, claim_boundary: 'accredited' },
      /claim_boundary.*not in enum/,
    );
  });

  it('NEGATIVE CONTROL: a coverage picture missing its gaps set is contract-invalid (honesty is required)', () => {
    expectInvalid(covSchema, omit(COVERAGE_RESPONSE, 'gaps'), /missing required property "gaps"/);
  });

  it('NEGATIVE CONTROL: a coverage picture missing its claim_boundary is contract-invalid', () => {
    expectInvalid(
      covSchema,
      omit(COVERAGE_RESPONSE, 'claim_boundary'),
      /missing required property "claim_boundary"/,
    );
  });

  it('NEGATIVE CONTROL: a non-uuid tenant_id is contract-invalid', () => {
    expectInvalid(
      covSchema,
      { ...COVERAGE_RESPONSE, tenant_id: 'tenant-home' },
      /tenant_id: not a uuid/,
    );
  });
});

// ===========================================================================
// FR-034 — getEvidenceMetadata: the evidence envelope is METADATA-ONLY. The
// contract does NOT require exposing a raw/decrypted body field; content is a
// pointer-and-integrity descriptor (uri / sha256 / size), so an unauthorized
// caller receiving the envelope never receives the material itself.
//
// The 200 schema references the sibling evidence-envelope.schema.json (an
// external JSON-Schema file); we read that file's own bytes as the oracle.
// ===========================================================================

describe('getEvidenceMetadata · metadata-only evidence envelope (FR-034)', () => {
  const ENVELOPE_RAW = readFileSync(join(CONTRACTS_DIR, 'evidence-envelope.schema.json'), 'utf8');
  const ENVELOPE = JSON.parse(ENVELOPE_RAW) as Node;

  it('the 200 response wires to the external evidence-envelope schema', () => {
    const schema = jsonSchemaOf(
      deref(prop(prop(findOperation('getEvidenceMetadata'), 'responses'), '200')),
    );
    expect(prop(schema, '$ref')).toMatch(/evidence-envelope\.schema\.json$/);
  });

  it('the envelope requires metadata facets, NOT a raw/decrypted body field', () => {
    const required = prop(ENVELOPE, 'required') as string[];
    // A metadata-only envelope's required set: identity + provenance + governance facets.
    expect(required).toEqual(
      expect.arrayContaining([
        'evidence_id',
        'tenant_id',
        'evidence_type',
        'content',
        'provenance',
        'classification',
        'access',
        'integrity',
      ]),
    );
    // It must NOT require any raw-material field an unauthorized caller could read.
    for (const forbidden of [
      'body',
      'raw',
      'raw_body',
      'plaintext',
      'decrypted',
      'bytes',
      'payload',
    ]) {
      expect(required).not.toContain(forbidden);
    }
  });

  it('the `content` descriptor is a pointer + integrity metadata (uri/sha256/size), never inline material', () => {
    const content = prop(prop(ENVELOPE, 'properties'), 'content');
    const contentRequired = prop(content, 'required') as string[];
    expect(contentRequired).toEqual(
      expect.arrayContaining([
        'uri',
        'storage_version_id',
        'sha256',
        'size_bytes',
        'media_type',
        'encrypted',
      ]),
    );
    // No inline-body property is even declared on the content descriptor.
    const contentProps = Object.keys((prop(content, 'properties') as Node) ?? {});
    for (const forbidden of ['body', 'raw', 'data', 'plaintext', 'decrypted', 'bytes']) {
      expect(contentProps).not.toContain(forbidden);
    }
  });

  it('the envelope enforces tenant isolation on access (metadata cannot leak cross-tenant)', () => {
    const access = prop(prop(ENVELOPE, 'properties'), 'access');
    const accessRequired = prop(access, 'required') as string[];
    expect(accessRequired).toEqual(
      expect.arrayContaining(['policy_id', 'tenant_isolated', 'allowed_purposes']),
    );
    // tenant_isolated is pinned true by the contract (a const), not merely present.
    expect(prop(prop(prop(access, 'properties'), 'tenant_isolated'), 'const')).toBe(true);
  });
});

// ===========================================================================
// FR-056 / SC-022 — requestAuditExport: an AUDITED export command. The body
// carries scope + period{from,to} + reason{code,text}; the 202 acknowledges
// with a canonical, audited accepted-operation handle.
// ===========================================================================

describe('requestAuditExport · audited export command (FR-056 / SC-022)', () => {
  const reqSchema = requestSchema('requestAuditExport');
  const acceptedSchema = responseSchema('requestAuditExport', '202');

  it('the export request is contract-valid (scope + period{from,to} + reason{code,text})', () => {
    expectValid(reqSchema, AUDIT_REQUEST);
    expect(DATETIME_RE.test(AUDIT_REQUEST.period.from)).toBe(true);
    expect(DATETIME_RE.test(AUDIT_REQUEST.period.to)).toBe(true);
  });

  it('the 202 acknowledgement is a canonical, AUDITED accepted-operation handle', () => {
    expectValid(acceptedSchema, ACCEPTED);
    expect(UUID_RE.test(ACCEPTED.operation_id)).toBe(true);
    expect(UUID_RE.test(ACCEPTED.correlation_id)).toBe(true);
    expect(UUID_RE.test(ACCEPTED.audit_event_id)).toBe(true);
  });

  it('NEGATIVE CONTROL: an export request missing its reason is rejected (no unaudited export)', () => {
    expectInvalid(reqSchema, omit(AUDIT_REQUEST, 'reason'), /missing required property "reason"/);
  });

  it('NEGATIVE CONTROL: an export request missing its period is rejected', () => {
    expectInvalid(reqSchema, omit(AUDIT_REQUEST, 'period'), /missing required property "period"/);
  });

  it('NEGATIVE CONTROL: an export request missing its scope is rejected', () => {
    expectInvalid(reqSchema, omit(AUDIT_REQUEST, 'scope'), /missing required property "scope"/);
  });

  it('NEGATIVE CONTROL: a period missing its `to` bound is contract-invalid', () => {
    expectInvalid(
      reqSchema,
      { ...AUDIT_REQUEST, period: { from: AUDIT_REQUEST.period.from } },
      /period.*missing required property "to"/,
    );
  });

  it('NEGATIVE CONTROL: a period `from` that is not a date-time is contract-invalid', () => {
    expectInvalid(
      reqSchema,
      { ...AUDIT_REQUEST, period: { from: 'last-year', to: AUDIT_REQUEST.period.to } },
      /period\.from: not an rfc3339 date-time/,
    );
  });

  it('NEGATIVE CONTROL: an unknown extra field on the export request is rejected (additionalProperties:false)', () => {
    expectInvalid(
      reqSchema,
      { ...AUDIT_REQUEST, sneaky: true },
      /additional property "sneaky" is forbidden/,
    );
  });

  it('NEGATIVE CONTROL: an accepted-operation missing its audit handle is contract-invalid', () => {
    expectInvalid(
      acceptedSchema,
      omit(ACCEPTED, 'audit_event_id'),
      /missing required property "audit_event_id"/,
    );
  });
});
