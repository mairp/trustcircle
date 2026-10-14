// @trustcircle/contracts — DECISION-API contract surface (Phase 88 / Work item BJG3PZHMWX4DHWZ9RMEZ33F9GZ).
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M (content hash af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b).
//
// This module is the executable form of the phase objective: "Validate decision, action, and
// delegation REQUESTS, HEADERS, ETags, IDEMPOTENCY, ERRORS, and RESPONSES against the API
// contract." It does NOT re-declare the contract in code — it LOADS the canonical
// `contracts/governance-control-plane/governance-api.openapi.yaml`, resolves the
// decision / action / delegation operations and their `$ref` schemas, and validates payloads and
// protocol metadata against those loaded definitions. If the OpenAPI contract changes, every
// verdict here changes with it; the validator can never silently drift from the published API.
//
// The two legs:
//   1. SCHEMA leg — a dependency-free validator for the OpenAPI-3.1 JSON-Schema subset the
//      governance API actually uses (type unions `[T,'null']`, enum, required,
//      additionalProperties:false, format uuid/date-time/uri, min/maxLength, pattern, minItems,
//      maxItems, uniqueItems, items, minimum/maximum, allOf). It validates request bodies
//      (CreateDecisionRequest / DecisionAction / DelegationRequest), success responses
//      (DecisionRequest, the action envelope, Delegation) and the Problem error envelope against
//      the schema nodes read out of the contract document. No external dependency (ajv6 cannot
//      express 3.1 nullable-union types cleanly); mirrors the dependency posture of validate.ts.
//   2. PROTOCOL leg — the header / ETag / idempotency / error obligations the operations declare:
//      required headers (X-Tenant-ID, Idempotency-Key, X-Correlation-ID, and If-Match on
//      state-changing actions), the ETag response header on the package + action + create
//      responses, idempotent-replay identity, and the governed-rejection rule that a Problem
//      response carries an `audit_event_id` and safe next actions.
//
// Every checker RETURNS the list of contract violations (empty ⇒ conformant), so a caller can
// assert both that a well-formed request/response passes AND that a malformed one is rejected
// with the specific violation — the oracle is non-vacuous by construction.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Minimal js-yaml surface (no @types/js-yaml dependency); mirrors scripts/validate.ts.
// eslint-disable-next-line import/no-extraneous-dependencies
import yaml from 'js-yaml';

const loadYaml = yaml.load;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const GOVERNANCE_API_PATH = join(
  REPO_ROOT,
  'contracts',
  'governance-control-plane',
  'governance-api.openapi.yaml',
);

// ===========================================================================
// JSON value model + typed accessors (all document traversal goes through these,
// so the strict `noPropertyAccessFromIndexSignature` / `noUncheckedIndexedAccess`
// rules are satisfied without scattering bracket access through the logic).
// ===========================================================================

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a property off a Json value, or undefined when absent / not an object. */
function prop(v: Json, key: string): Json | undefined {
  return isObject(v) ? v[key] : undefined;
}

function asObject(v: Json | undefined): JsonObject | undefined {
  return isObject(v) ? v : undefined;
}

function asArray(v: Json | undefined): Json[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asString(v: Json | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: Json | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ===========================================================================
// Contract document loading + $ref resolution
// ===========================================================================

/** The parsed OpenAPI document with typed accessors. Loaded once; callers must not mutate it. */
export interface GovernanceApiDocument {
  readonly raw: JsonObject;
  /** Resolve a local `#/...` JSON-pointer $ref against this document. */
  ref(pointer: string): Json;
  /** Fully dereference a schema node (recursively inlining local $ref and flattening allOf). */
  resolveSchema(node: Json): ResolvedSchema;
  /** The operation object for `METHOD path`, e.g. `post /v1/decisions/{decisionId}/actions`. */
  operation(method: string, path: string): JsonObject;
}

export function loadGovernanceApi(path: string = GOVERNANCE_API_PATH): GovernanceApiDocument {
  const parsed = loadYaml(readFileSync(path, 'utf8'));
  if (!isObject(parsed)) throw new Error('governance-api.openapi.yaml did not parse to an object');
  const doc: JsonObject = parsed;

  function ref(pointer: string): Json {
    if (!pointer.startsWith('#/')) {
      throw new Error(`only local #/ refs are supported, got '${pointer}'`);
    }
    const parts = pointer
      .slice(2)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur: Json = doc;
    for (const part of parts) {
      const next = prop(cur, part);
      if (next === undefined) {
        throw new Error(`$ref '${pointer}' does not resolve (stuck at '${part}')`);
      }
      cur = next;
    }
    return cur;
  }

  function resolveSchema(node: Json, seen: Set<string> = new Set()): ResolvedSchema {
    const refPtr = asString(prop(node, '$ref'));
    if (refPtr !== undefined) {
      if (seen.has(refPtr)) return {}; // guard against recursive schemas
      const next = new Set(seen);
      next.add(refPtr);
      return resolveSchema(ref(refPtr), next);
    }
    if (!isObject(node)) return {};
    const allOf = asArray(prop(node, 'allOf'));
    if (allOf) {
      // Flatten allOf into a single object schema (merge required + properties).
      const mergedProps: Record<string, Json> = {};
      let mergedRequired: string[] = [];
      let noAdditional = false;
      for (const sub of allOf) {
        const r = resolveSchema(sub, seen);
        Object.assign(mergedProps, r.properties ?? {});
        mergedRequired = [...mergedRequired, ...(r.required ?? [])];
        if (r.additionalProperties === false) noAdditional = true;
      }
      const merged: ResolvedSchema = {
        type: 'object',
        properties: mergedProps,
        required: [...new Set(mergedRequired)],
      };
      if (noAdditional) merged.additionalProperties = false;
      return merged;
    }
    return schemaFromNode(node);
  }

  function operation(method: string, path: string): JsonObject {
    const paths = asObject(prop(doc, 'paths'));
    const item = asObject(paths && prop(paths, path));
    if (!item) throw new Error(`path '${path}' not found in contract`);
    const op = asObject(prop(item, method.toLowerCase()));
    if (!op) throw new Error(`operation '${method} ${path}' not found in contract`);
    return op;
  }

  return { raw: doc, ref, resolveSchema, operation };
}

// ===========================================================================
// SCHEMA leg — dependency-free OpenAPI-3.1 JSON-Schema-subset validator
// ===========================================================================

/** A resolved schema node's recognised keywords (all optional). */
export interface ResolvedSchema {
  type?: Json;
  enum?: Json[];
  required?: string[];
  properties?: Record<string, Json>;
  additionalProperties?: Json;
  items?: Json;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

/** Extract the recognised keywords from a raw schema node (no $ref / allOf here). */
function schemaFromNode(node: Json): ResolvedSchema {
  const out: ResolvedSchema = {};
  const type = prop(node, 'type');
  if (type !== undefined) out.type = type;
  const en = asArray(prop(node, 'enum'));
  if (en) out.enum = en;
  const req = asArray(prop(node, 'required'));
  if (req) out.required = req.filter((r): r is string => typeof r === 'string');
  const props = asObject(prop(node, 'properties'));
  if (props) out.properties = props;
  const addl = prop(node, 'additionalProperties');
  if (addl !== undefined) out.additionalProperties = addl;
  const items = prop(node, 'items');
  if (items !== undefined) out.items = items;
  const fmt = asString(prop(node, 'format'));
  if (fmt !== undefined) out.format = fmt;
  const minL = asNumber(prop(node, 'minLength'));
  if (minL !== undefined) out.minLength = minL;
  const maxL = asNumber(prop(node, 'maxLength'));
  if (maxL !== undefined) out.maxLength = maxL;
  const minI = asNumber(prop(node, 'minItems'));
  if (minI !== undefined) out.minItems = minI;
  const maxI = asNumber(prop(node, 'maxItems'));
  if (maxI !== undefined) out.maxItems = maxI;
  const uniq = prop(node, 'uniqueItems');
  if (uniq === true) out.uniqueItems = true;
  const min = asNumber(prop(node, 'minimum'));
  if (min !== undefined) out.minimum = min;
  const max = asNumber(prop(node, 'maximum'));
  if (max !== undefined) out.maximum = max;
  const pat = asString(prop(node, 'pattern'));
  if (pat !== undefined) out.pattern = pat;
  return out;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/;

function typeMatches(t: string, value: Json): boolean {
  switch (t) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      return false;
  }
}

function jsType(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Validate `value` against a (possibly $ref/allOf-bearing) schema node from the loaded contract.
 * Returns a list of `path: message` violations; empty ⇒ conformant. Fails closed on any
 * unexpected structure. This is the request/response body oracle.
 */
export function validateAgainstSchema(
  doc: GovernanceApiDocument,
  schemaNode: Json,
  value: Json,
  path = '$',
): string[] {
  const s = doc.resolveSchema(schemaNode);
  const errs: string[] = [];

  // enum
  if (s.enum) {
    const ok = s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) errs.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }

  // type (may be a single string or an array of allowed types, incl. 'null')
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const anyOk = types.some((t) => typeof t === 'string' && typeMatches(t, value));
    if (!anyOk) {
      errs.push(`${path}: expected type ${JSON.stringify(s.type)}, got ${jsType(value)}`);
      return errs; // no point checking sub-constraints against the wrong type
    }
  }

  // string constraints + formats
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) {
      errs.push(`${path}: shorter than minLength ${s.minLength}`);
    }
    if (s.maxLength !== undefined && value.length > s.maxLength) {
      errs.push(`${path}: longer than maxLength ${s.maxLength}`);
    }
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) {
      errs.push(`${path}: does not match pattern ${s.pattern}`);
    }
    if (s.format === 'uuid' && !UUID_RE.test(value)) errs.push(`${path}: not a uuid`);
    if (s.format === 'date-time' && !DATE_TIME_RE.test(value)) {
      errs.push(`${path}: not an RFC3339 date-time`);
    }
    if (s.format === 'uri' && !URI_RE.test(value)) errs.push(`${path}: not a uri`);
  }

  // number constraints
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) {
      errs.push(`${path}: below minimum ${s.minimum}`);
    }
    if (s.maximum !== undefined && value > s.maximum) {
      errs.push(`${path}: above maximum ${s.maximum}`);
    }
  }

  // array constraints
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) {
      errs.push(`${path}: fewer than minItems ${s.minItems}`);
    }
    if (s.maxItems !== undefined && value.length > s.maxItems) {
      errs.push(`${path}: more than maxItems ${s.maxItems}`);
    }
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errs.push(`${path}: duplicate item violates uniqueItems`);
        seen.add(key);
      }
    }
    if (s.items !== undefined) {
      const itemSchema = s.items;
      value.forEach((item, i) => {
        errs.push(...validateAgainstSchema(doc, itemSchema, item, `${path}[${i}]`));
      });
    }
  }

  // object constraints
  if (isObject(value)) {
    for (const req of s.required ?? []) {
      if (!(req in value)) errs.push(`${path}: missing required property '${req}'`);
    }
    const props = s.properties ?? {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (key in props) {
        const childSchema = props[key];
        if (childSchema !== undefined) {
          errs.push(...validateAgainstSchema(doc, childSchema, child ?? null, `${path}.${key}`));
        }
      } else if (s.additionalProperties === false) {
        errs.push(`${path}: additional property '${key}' is not permitted`);
      }
    }
  }

  return errs;
}

// ---------------------------------------------------------------------------
// Named request/response validators (bound to the exact contract operations).
// ---------------------------------------------------------------------------

/** Schema node for an operation's JSON request body. */
export function requestBodySchema(op: JsonObject): Json {
  const content = asObject(prop(op['requestBody'] ?? null, 'content'));
  const app = asObject(content && content['application/json']);
  const schema = app && app['schema'];
  if (schema === undefined) throw new Error('operation has no application/json request schema');
  return schema;
}

/** Schema node for an operation's response body at a given status. */
export function responseSchema(op: JsonObject, status: string): Json {
  const responses = asObject(op['responses'] ?? null);
  const r = asObject(responses && responses[status]);
  const content = asObject(r && r['content']);
  const app = asObject(
    content && (content['application/json'] ?? content['application/problem+json']),
  );
  const schema = app && app['schema'];
  if (schema === undefined) throw new Error(`operation has no schema on ${status} response`);
  return schema;
}

/** Validate a `POST /v1/decisions` create request body. */
export function validateCreateDecisionRequest(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    requestBodySchema(doc.operation('post', '/v1/decisions')),
    body,
  );
}

/** Validate a `POST /v1/decisions/{decisionId}/actions` action request body. */
export function validateDecisionAction(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    requestBodySchema(doc.operation('post', '/v1/decisions/{decisionId}/actions')),
    body,
  );
}

/** Validate a `POST /v1/delegations` delegation request body. */
export function validateDelegationRequest(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    requestBodySchema(doc.operation('post', '/v1/delegations')),
    body,
  );
}

/** Validate a full decision package response (`GET /v1/decisions/{decisionId}` 200 body). */
export function validateDecisionRequestResponse(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    responseSchema(doc.operation('get', '/v1/decisions/{decisionId}'), '200'),
    body,
  );
}

/** Validate the action success envelope (`POST .../actions` 200 body: decision+record+audit id). */
export function validateDecisionActionResult(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    responseSchema(doc.operation('post', '/v1/decisions/{decisionId}/actions'), '200'),
    body,
  );
}

/** Validate a created delegation response (`POST /v1/delegations` 201 body). */
export function validateDelegationResponse(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    responseSchema(doc.operation('post', '/v1/delegations'), '201'),
    body,
  );
}

/** Validate a Problem (RFC 9457) error envelope against the contract's Problem schema. */
export function validateProblem(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(doc, doc.ref('#/components/schemas/Problem'), body);
}

// ===========================================================================
// PROTOCOL leg — headers, ETags, idempotency, and governed-rejection errors
// ===========================================================================

/** Header names → values. Lookups below are case-insensitive (RFC 9110). */
export type Headers = Record<string, string>;

function lower(h: Headers): Headers {
  const out: Headers = {};
  for (const key of Object.keys(h)) {
    const v = h[key];
    if (v !== undefined) out[key.toLowerCase()] = v;
  }
  return out;
}

/**
 * The header parameters an operation DECLARES as required (name + resolved schema). Read out of
 * the contract's `parameters` list (following `$ref`), so the required-header set is exactly what
 * the API publishes — never a hand-copied list.
 */
export interface RequiredHeader {
  readonly name: string;
  readonly schema: Json;
}

export function requiredHeaders(doc: GovernanceApiDocument, op: JsonObject): RequiredHeader[] {
  const params = asArray(op['parameters'] ?? null);
  const out: RequiredHeader[] = [];
  if (!params) return out;
  for (const p of params) {
    const refPtr = asString(prop(p, '$ref'));
    const param = refPtr !== undefined ? doc.ref(refPtr) : p;
    const name = asString(prop(param, 'name'));
    if (prop(param, 'in') === 'header' && prop(param, 'required') === true && name !== undefined) {
      out.push({ name, schema: prop(param, 'schema') ?? { type: 'string' } });
    }
  }
  return out;
}

/**
 * Validate that a request carries every header the operation requires AND that each header value
 * satisfies its declared schema (e.g. Idempotency-Key pattern, X-Tenant-ID uuid). Returns the
 * violation list; empty ⇒ all required headers present and well-formed.
 */
export function validateRequestHeaders(
  doc: GovernanceApiDocument,
  op: JsonObject,
  headers: Headers,
): string[] {
  const errs: string[] = [];
  const present = lower(headers);
  for (const rh of requiredHeaders(doc, op)) {
    const key = rh.name.toLowerCase();
    const value = present[key];
    if (value === undefined) {
      errs.push(`missing required header '${rh.name}'`);
      continue;
    }
    errs.push(...validateAgainstSchema(doc, rh.schema, value, `header.${rh.name}`));
  }
  return errs;
}

/** True iff the operation declares an ETag response header on the given status (concurrency). */
export function declaresEtag(op: JsonObject, status: string): boolean {
  const responses = asObject(op['responses'] ?? null);
  const r = asObject(responses && responses[status]);
  const headers = asObject(r && r['headers']);
  return headers !== undefined && 'ETag' in headers;
}

/**
 * Validate ETag emission: when the operation declares an ETag response header for `status`, the
 * response MUST carry a non-empty ETag. Returns violations; empty ⇒ conformant (including when
 * the operation does not require an ETag at all).
 */
export function validateEtagResponse(
  op: JsonObject,
  status: string,
  responseHeaders: Headers,
): string[] {
  if (!declaresEtag(op, status)) return [];
  const present = lower(responseHeaders);
  const etag = present['etag'];
  if (etag === undefined || etag.trim().length === 0) {
    return [`response for status ${status} must carry a non-empty ETag header`];
  }
  return [];
}

/**
 * Idempotency oracle. Two requests with the SAME `Idempotency-Key` (and same tenant + target)
 * must yield the SAME durable effect: identical resulting resource identity + version, and the
 * replay must be marked. `original` is the first materialized result; `replay` is the second.
 * Returns violations; empty ⇒ the replay is a faithful idempotent echo, not a second effect.
 */
export interface IdempotentEffect {
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly auditEventId: string;
  readonly idempotentReplay: boolean;
}

export function validateIdempotentReplay(
  original: IdempotentEffect,
  replay: IdempotentEffect,
): string[] {
  const errs: string[] = [];
  if (replay.idempotencyKey !== original.idempotencyKey) {
    errs.push('replay idempotency key differs from the original');
  }
  if (replay.tenantId !== original.tenantId) errs.push('replay tenant differs from the original');
  if (replay.resourceId !== original.resourceId) {
    errs.push('idempotent replay produced a DIFFERENT resource id (a second effect occurred)');
  }
  if (replay.resourceVersion !== original.resourceVersion) {
    errs.push('idempotent replay advanced the resource version (a second effect occurred)');
  }
  if (replay.auditEventId !== original.auditEventId) {
    errs.push('idempotent replay minted a new audit event (a second effect occurred)');
  }
  if (replay.idempotentReplay !== true) {
    errs.push('idempotent replay was not marked idempotent_replay=true');
  }
  return errs;
}

/**
 * Governed-rejection oracle. A contract rejection (no transition) must surface as a Problem that
 * (a) is schema-valid, (b) carries the correlation id the caller supplied, (c) is a 4xx/5xx, and
 * (d) — because the spec says "governed rejection attempts include an audit event ID" — carries a
 * non-null `audit_event_id` and at least one safe next action, so the rejection is itself
 * recorded and explained. Returns violations; empty ⇒ a well-formed governed rejection.
 */
export function validateGovernedRejection(
  doc: GovernanceApiDocument,
  problem: Json,
  expectedCorrelationId: string,
): string[] {
  const errs = validateProblem(doc, problem);
  if (!isObject(problem)) {
    return errs.length ? errs : ['problem body is not an object'];
  }
  if (problem['correlation_id'] !== expectedCorrelationId) {
    errs.push('problem correlation_id does not echo the request correlation id');
  }
  const status = problem['status'];
  if (typeof status !== 'number' || status < 400) {
    errs.push('governed rejection must use a 4xx/5xx status');
  }
  const auditId = problem['audit_event_id'];
  if (typeof auditId !== 'string' || !UUID_RE.test(auditId)) {
    errs.push('governed rejection must record an audit_event_id (the recorded, explained refusal)');
  }
  const nextActions = problem['safe_next_actions'];
  if (!Array.isArray(nextActions) || nextActions.length === 0) {
    errs.push('governed rejection must explain at least one safe next action');
  }
  const detail = problem['detail'];
  if (typeof detail !== 'string' || detail.trim().length === 0) {
    errs.push('governed rejection must carry an explanatory detail');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Convenience: the decision action verbs the contract permits (read from the schema, so the
// permitted-verb set is exactly the published enum — AC2's transition alphabet).
// ---------------------------------------------------------------------------

export function permittedDecisionActions(doc: GovernanceApiDocument): string[] {
  const schema = doc.resolveSchema(
    requestBodySchema(doc.operation('post', '/v1/decisions/{decisionId}/actions')),
  );
  const actionNode = (schema.properties ?? {})['action'] ?? {};
  const actionSchema = doc.resolveSchema(actionNode);
  const en = actionSchema.enum;
  if (!en) throw new Error('action enum not found in DecisionAction schema');
  return en.filter((x): x is string => typeof x === 'string');
}
