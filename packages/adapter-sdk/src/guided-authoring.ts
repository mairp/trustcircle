import { canonicalDigest, validateManifest, type AdapterManifest } from './manifest.ts';

export type PaginationMode = 'cursor' | 'offset' | 'page' | 'none';

export interface GuidedPaginationPolicy {
  readonly mode: PaginationMode;
  readonly cursorField?: string;
  readonly maximumPageSize: number;
}

export interface GuidedFailurePolicy {
  readonly correlation: 'required';
  readonly idempotency: 'required';
  readonly reconciliation: 'source_scoped' | 'item_scoped' | 'collection_scoped';
  readonly retry: 'bounded';
  readonly replay: 'source_event_identity';
  readonly terminalFailure: 'retained_for_reconciliation';
  readonly revocation: 'block_new_work_reconcile_existing';
  readonly migration: 'version_overlap';
  readonly rollback: 'verified_preimage';
}

export interface GuidedConnectorDefinitionInput {
  readonly id: string;
  readonly authorPrincipalId: string;
  readonly draftVersion: number;
  readonly manifest: AdapterManifest;
  readonly mappingRefs: readonly string[];
  readonly credentialClassRefs: readonly string[];
  readonly paginationPolicy: GuidedPaginationPolicy;
  readonly failurePolicy: GuidedFailurePolicy;
  readonly schemaVersion: number;
}

export interface GuidedConnectorDefinition {
  readonly id: string;
  readonly authorPrincipalId: string;
  readonly draftVersion: number;
  readonly manifest: AdapterManifest;
  readonly mappingRefs: readonly string[];
  readonly credentialClassRefs: readonly string[];
  readonly paginationPolicy: GuidedPaginationPolicy;
  readonly rateLimitPolicy: {
    readonly requestsPerMinute: number;
    readonly maximumConcurrency: number;
  };
  readonly healthPolicy: {
    readonly endpoint: string;
    readonly readinessEndpoint: string;
    readonly freshnessSeconds: number;
  };
  readonly failurePolicy: GuidedFailurePolicy;
  readonly schemaVersion: number;
  readonly digest: string;
  readonly status: 'draft';
}

const INPUT_KEYS = new Set([
  'id',
  'authorPrincipalId',
  'draftVersion',
  'manifest',
  'mappingRefs',
  'credentialClassRefs',
  'paginationPolicy',
  'failurePolicy',
  'schemaVersion',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(label + ' must be a non-empty string');
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new RangeError(label + ' must be a positive integer');
  }
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(label + ' must be a non-empty list');
  }
  const result = value.map((item, index) => {
    nonEmpty(item, label + '[' + index + ']');
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(label + ' must not contain duplicates');
  }
  return Object.freeze(result);
}

function exactInput(input: GuidedConnectorDefinitionInput): void {
  for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
    if (!INPUT_KEYS.has(key)) {
      const safetyLabel = /secret|token|password|credential/i.test(key)
        ? 'inline credential or secret material is prohibited'
        : 'unknown guided-definition field';
      throw new TypeError(safetyLabel + ': ' + key);
    }
  }
}

function unsealedManifest(manifest: AdapterManifest): AdapterManifest {
  const { manifest_digest: _manifestDigest, signature: _signature, ...unsealed } = manifest;
  void _manifestDigest;
  void _signature;
  return unsealed;
}

function validateFailurePolicy(policy: GuidedFailurePolicy): GuidedFailurePolicy {
  const required: Readonly<Record<keyof GuidedFailurePolicy, string>> = {
    correlation: 'required',
    idempotency: 'required',
    reconciliation: 'source_scoped|item_scoped|collection_scoped',
    retry: 'bounded',
    replay: 'source_event_identity',
    terminalFailure: 'retained_for_reconciliation',
    revocation: 'block_new_work_reconcile_existing',
    migration: 'version_overlap',
    rollback: 'verified_preimage',
  };
  for (const [key, expected] of Object.entries(required)) {
    const value = policy?.[key as keyof GuidedFailurePolicy];
    if (typeof value !== 'string' || value.length === 0 || !expected.split('|').includes(value)) {
      throw new TypeError(
        'failure policy ' +
          key.replace(/[A-Z]/g, (letter) => '.' + letter.toLowerCase()) +
          ' is required and must be ' +
          expected,
      );
    }
  }
  return Object.freeze({ ...policy });
}

export function authorGuidedConnectorDefinition(
  input: GuidedConnectorDefinitionInput,
): GuidedConnectorDefinition {
  if (!input || typeof input !== 'object') {
    throw new TypeError('guided connector definition input is required');
  }
  exactInput(input);
  if (!UUID_RE.test(input.id)) throw new TypeError('definition id must be a UUID');
  if (!UUID_RE.test(input.authorPrincipalId)) {
    throw new TypeError('author principal id must be a UUID');
  }
  positiveInteger(input.draftVersion, 'draft version');
  positiveInteger(input.schemaVersion, 'schema version');
  positiveInteger(input.paginationPolicy?.maximumPageSize, 'pagination maximum page size');
  if (!['cursor', 'offset', 'page', 'none'].includes(input.paginationPolicy?.mode)) {
    throw new TypeError('pagination mode is invalid');
  }
  if (input.paginationPolicy.mode === 'cursor') {
    nonEmpty(input.paginationPolicy.cursorField, 'pagination cursor field');
  }
  const mappingRefs = stringList(input.mappingRefs, 'mapping refs');
  const credentialClassRefs = stringList(input.credentialClassRefs, 'credential class refs');
  const failurePolicy = validateFailurePolicy(input.failurePolicy);
  const manifest = Object.freeze(unsealedManifest(input.manifest));
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    const issue = validation.issues[0]!;
    throw new TypeError('generated manifest is invalid at ' + issue.path + ': ' + issue.message);
  }
  if (manifest.security.credential_reference_mode !== 'external_secret_reference') {
    throw new TypeError('credential material must remain an external secret reference');
  }
  const paginationPolicy = Object.freeze({ ...input.paginationPolicy });
  const rateLimitPolicy = Object.freeze({
    requestsPerMinute: manifest.limits.requests_per_minute,
    maximumConcurrency: manifest.limits.maximum_concurrency,
  });
  const healthPolicy = Object.freeze({
    endpoint: manifest.health.endpoint,
    readinessEndpoint: manifest.health.readiness_endpoint,
    freshnessSeconds: manifest.health.freshness_seconds,
  });
  const preimage = {
    id: input.id,
    authorPrincipalId: input.authorPrincipalId,
    draftVersion: input.draftVersion,
    manifest,
    mappingRefs,
    credentialClassRefs,
    paginationPolicy,
    rateLimitPolicy,
    healthPolicy,
    failurePolicy,
    schemaVersion: input.schemaVersion,
    status: 'draft' as const,
  };
  return Object.freeze({
    ...preimage,
    digest: canonicalDigest(preimage),
  });
}
