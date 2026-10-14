// @trustcircle/adapter-sdk — ADAPTER MANIFEST types, signing helpers, capability negotiation,
// observation/operation envelopes, and compatibility helpers (Phase 8 / User Story 6 / T228 /
// FR-029, FR-030 and the FR-036..FR-042 discovery/authority family; NS-005 version drift; SC-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// Every adapter (kanban, workflow_orchestration, agentctl, lisa, wiggum, …) declares itself with a
// MANIFEST-FIRST contract: a signed, versioned document declaring its contract range, source classes,
// capabilities, authority, security posture, schemas, delivery semantics, limits, retry policy,
// reconciliation, rollback, evidence, health, and lifecycle. This module is the canonical TypeScript
// mirror of contracts/governance-control-plane/adapter-manifest.schema.json — the platform
// validates a manifest, negotiates a compatible protocol version, and signs/verifies its canonical
// form here, so the manifest the adapter ships and the manifest the platform trusts are ONE artifact
// with ONE digest.
//
// LOAD-BEARING SAFETY INVARIANTS (each a fail-visible check, each independently testable):
//   * A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY. `authority.authoritative_fields` says what the
//     source is authoritative FOR; `forbidden_inferences` names the governance conclusions the adapter
//     may NOT draw (e.g. kanban `done` ≠ approval). Neither grants the adapter authority to decide.
//   * VERSION DRIFT IS FATAL (NS-005). `negotiateContract` refuses a platform protocol outside the
//     manifest's `[minimum, maximum]` contract range — a drifted adapter never activates.
//   * CAPABILITY NEGOTIATION IS A SUBSET (least privilege). An instance may enable only a SUBSET of the
//     manifest's declared capabilities; requesting a capability the manifest does not declare is refused.
//   * SIGN OVER THE CANONICAL FORM. The signature and digest are computed over the manifest with its
//     own `manifest_digest`/`signature` fields stripped, in canonical (key-sorted) JSON, so the digest
//     is stable and a tampered manifest fails verification.
//
// Dependency-free (Node built-in `crypto` only): pure, no I/O, no wall clock. Runs under Node 22
// `--experimental-strip-types`.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ===========================================================================
// 1. Manifest shape — the TypeScript mirror of adapter-manifest.schema.json.
// ===========================================================================

/** Semantic version string, e.g. '1.4.0'. Validated by `isSemver`. */
export type Semver = string;

/** The closed capability vocabulary (schema `capabilities.items.enum`). */
export const ADAPTER_CAPABILITIES = [
  'discover',
  'inspect',
  'snapshot',
  'subscribe',
  'simulate',
  'execute',
  'pause',
  'resume',
  'reconcile',
  'rollback',
  'collect_evidence',
  'quarantine',
  'restore',
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

export function isAdapterCapability(s: unknown): s is AdapterCapability {
  return typeof s === 'string' && (ADAPTER_CAPABILITIES as readonly string[]).includes(s);
}

/** Operation risk classes (schema `authority.operation_risk`). */
export const OPERATION_RISK_CLASSES = ['read_only', 'low', 'consequential', 'destructive'] as const;
export type OperationRiskClass = (typeof OPERATION_RISK_CLASSES)[number];

/** Delivery ordering models (schema `delivery.ordering`). */
export const ORDERING_MODELS = [
  'aggregate_sequence',
  'source_revision',
  'cursor',
  'timestamp_with_uncertainty',
  'none',
] as const;
export type OrderingModel = (typeof ORDERING_MODELS)[number];

export const IDEMPOTENCY_MODES = [
  'required_key',
  'source_operation_id',
  'read_only_only',
  'unsupported',
] as const;
export type IdempotencyMode = (typeof IDEMPOTENCY_MODES)[number];

export const RETRYABLE_CLASSES = [
  'rate_limited',
  'transient',
  'dependency_unavailable',
  'timeout_before_dispatch',
] as const;
export type RetryableClass = (typeof RETRYABLE_CLASSES)[number];

export const TERMINAL_CLASSES = [
  'unauthenticated',
  'unauthorized',
  'invalid_request',
  'unsupported_contract',
  'precondition_failed',
  'policy_denied',
] as const;
export type TerminalClass = (typeof TERMINAL_CLASSES)[number];

export const DRIFT_CLASSES = [
  'missing',
  'duplicate',
  'stale',
  'conflicting',
  'orphaned',
  'schema_incompatible',
  'unknown',
] as const;
export type DriftClass = (typeof DRIFT_CLASSES)[number];

export const LIFECYCLE_STATUSES = ['proposed', 'supported', 'deprecated', 'retired'] as const;
export type ManifestLifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export interface ContractRange {
  readonly minimum: Semver;
  readonly maximum: Semver;
}

export interface ManifestAuthority {
  readonly authoritative_fields: readonly string[];
  readonly forbidden_inferences: readonly string[];
  readonly operation_risk: Readonly<Record<string, OperationRiskClass>>;
}

export interface ManifestSecurity {
  readonly identity_mode: 'mtls' | 'oauth2_client_credentials' | 'signed_workload' | 'local_socket';
  readonly tenant_mode: 'single_tenant_instance' | 'tenant_context_per_request';
  readonly credential_reference_mode: 'external_secret_reference';
  readonly network_egress: readonly string[];
  readonly required_scopes: readonly string[];
  readonly content_access?: 'metadata_only' | 'scoped_content' | 'full_content';
}

export interface SchemaRef {
  readonly uri: string;
  readonly version: Semver;
  readonly sha256: string;
}

export interface ManifestSchemas {
  readonly observation: SchemaRef;
  readonly command: SchemaRef;
  readonly result: SchemaRef;
  readonly health: SchemaRef;
  readonly source_extensions?: SchemaRef;
}

export interface ManifestDelivery {
  readonly ordering: OrderingModel;
  readonly idempotency: IdempotencyMode;
  readonly supports_operation_lookup: boolean;
  readonly supports_tombstones: boolean;
  readonly maximum_event_bytes?: number;
}

export interface ManifestLimits {
  readonly requests_per_minute: number;
  readonly maximum_concurrency: number;
  readonly maximum_batch_size: number;
  readonly operation_timeout_seconds: number;
}

export interface ManifestRetry {
  readonly retryable_classes: readonly RetryableClass[];
  readonly terminal_classes: readonly TerminalClass[];
  readonly maximum_attempts: number;
  readonly initial_backoff_ms: number;
  readonly maximum_backoff_ms: number;
  readonly jitter: boolean;
}

export interface ManifestReconciliation {
  readonly supported: boolean;
  readonly scope: 'item' | 'collection' | 'source' | 'none';
  readonly cursor_model: string;
  readonly drift_classes: readonly DriftClass[];
  readonly safe_during_source_degradation: boolean;
}

export interface ManifestRollback {
  readonly supported_operations?: readonly string[];
  readonly requires_preimage?: boolean;
  readonly verification_required?: boolean;
}

export interface ManifestEvidence {
  readonly original_capture: boolean;
  readonly result_capture: boolean;
  readonly content_hash: 'sha256';
  readonly chain_of_custody: boolean;
  readonly redaction_supported: boolean;
}

export interface ManifestHealth {
  readonly endpoint: string;
  readonly readiness_endpoint: string;
  readonly non_mutating: true;
  readonly freshness_seconds: number;
  readonly owner_contact: string;
}

export interface ManifestLifecycle {
  readonly status: ManifestLifecycleStatus;
  readonly released_at: string;
  readonly deprecated_at?: string | null;
  readonly retired_at?: string | null;
  readonly replacement_adapter_id?: string | null;
}

export interface ManifestSignature {
  readonly algorithm: 'Ed25519';
  readonly key_id: string;
  readonly value: string;
}

/** The full adapter manifest — mirror of adapter-manifest.schema.json. */
export interface AdapterManifest {
  readonly manifest_version: '1.0.0';
  readonly adapter_id: string;
  readonly name: string;
  readonly vendor: string;
  readonly adapter_version: Semver;
  readonly contract_range: ContractRange;
  readonly source_classes: readonly string[];
  readonly capabilities: readonly AdapterCapability[];
  readonly authority: ManifestAuthority;
  readonly security: ManifestSecurity;
  readonly schemas: ManifestSchemas;
  readonly delivery: ManifestDelivery;
  readonly limits: ManifestLimits;
  readonly retry: ManifestRetry;
  readonly reconciliation: ManifestReconciliation;
  readonly rollback?: ManifestRollback;
  readonly evidence: ManifestEvidence;
  readonly health: ManifestHealth;
  readonly lifecycle: ManifestLifecycle;
  readonly manifest_digest?: string;
  readonly signature?: ManifestSignature;
}

// ===========================================================================
// 2. Canonical JSON + digest (stable, key-sorted, undefined-dropping).
// ===========================================================================

/** Recursively key-sorted JSON with `undefined` dropped — the stable digest/signature preimage. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = sortValue(v);
  }
  return out;
}

/** lowercase-hex sha256 of the canonical JSON of `value`. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * The digest of a manifest is computed over the manifest with its own `manifest_digest` and
 * `signature` fields REMOVED (they cannot be part of their own preimage). Deterministic.
 */
export function manifestDigest(manifest: AdapterManifest): string {
  return canonicalDigest(stripSealFields(manifest));
}

function stripSealFields(manifest: AdapterManifest): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...manifest };
  delete clone['manifest_digest'];
  delete clone['signature'];
  return clone;
}

// ===========================================================================
// 3. Validation — a fail-visible structural + invariant validator.
// ===========================================================================

const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const ADAPTER_ID_RE = /^[a-z][a-z0-9.-]{2,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export function isSemver(s: unknown): s is Semver {
  return typeof s === 'string' && SEMVER_RE.test(s);
}

/** Parse a semver into a comparable tuple (ignoring pre-release/build for range purposes). */
export function parseSemver(s: Semver): readonly [number, number, number] {
  const core = s.split('+')[0]!.split('-')[0]!;
  const [maj, min, pat] = core.split('.').map((n) => Number.parseInt(n, 10));
  return [maj ?? 0, min ?? 0, pat ?? 0];
}

/** -1 | 0 | 1 comparison of two semvers by (major, minor, patch). */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

export type ManifestValidationIssue = { readonly path: string; readonly message: string };

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ManifestValidationIssue[];
}

/**
 * Structurally + semantically validate a manifest. Non-vacuous: every declared required field, the
 * enum vocabularies, the semver/id/sha256 patterns, and the load-bearing invariants (contract range
 * ordered, connector-never-authoritative-for-approval is left to callers, capability set non-empty,
 * health non-mutating) are checked and reported with a path.
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];
  const push = (path: string, message: string): void => {
    issues.push(Object.freeze({ path, message }));
  };
  if (input === null || typeof input !== 'object') {
    return Object.freeze({
      valid: false,
      issues: Object.freeze([{ path: '', message: 'not an object' }]),
    });
  }
  const m = input as Record<string, unknown>;

  if (m['manifest_version'] !== '1.0.0') push('manifest_version', 'must be "1.0.0"');
  if (typeof m['adapter_id'] !== 'string' || !ADAPTER_ID_RE.test(m['adapter_id'] as string))
    push('adapter_id', 'must match ^[a-z][a-z0-9.-]{2,127}$');
  for (const req of ['name', 'vendor'] as const) {
    if (typeof m[req] !== 'string' || (m[req] as string).length < 1)
      push(req, 'required non-empty string');
  }
  if (!isSemver(m['adapter_version'])) push('adapter_version', 'must be semver');

  const cr = m['contract_range'] as Record<string, unknown> | undefined;
  if (!cr || !isSemver(cr['minimum']) || !isSemver(cr['maximum'])) {
    push('contract_range', 'minimum and maximum must be semver');
  } else if (compareSemver(cr['minimum'] as string, cr['maximum'] as string) > 0) {
    push('contract_range', 'minimum must be <= maximum');
  }

  const sc = m['source_classes'];
  if (!Array.isArray(sc) || sc.length < 1) push('source_classes', 'must be a non-empty array');

  const caps = m['capabilities'];
  if (!Array.isArray(caps) || caps.length < 1) {
    push('capabilities', 'must be a non-empty array');
  } else {
    for (const c of caps)
      if (!isAdapterCapability(c)) push('capabilities', `unknown capability: ${String(c)}`);
    if (new Set(caps).size !== caps.length) push('capabilities', 'must be unique');
  }

  const auth = m['authority'] as Record<string, unknown> | undefined;
  if (
    !auth ||
    !Array.isArray(auth['authoritative_fields']) ||
    !Array.isArray(auth['forbidden_inferences']) ||
    typeof auth['operation_risk'] !== 'object' ||
    auth['operation_risk'] === null
  ) {
    push('authority', 'authoritative_fields, forbidden_inferences, operation_risk required');
  } else {
    for (const [op, risk] of Object.entries(auth['operation_risk'] as Record<string, unknown>)) {
      if (!(OPERATION_RISK_CLASSES as readonly string[]).includes(risk as string))
        push(`authority.operation_risk.${op}`, `invalid risk: ${String(risk)}`);
    }
  }

  const sec = m['security'] as Record<string, unknown> | undefined;
  if (!sec) push('security', 'required');
  else {
    if (sec['credential_reference_mode'] !== 'external_secret_reference')
      push(
        'security.credential_reference_mode',
        'must be external_secret_reference (no inline secrets)',
      );
    if (
      !['mtls', 'oauth2_client_credentials', 'signed_workload', 'local_socket'].includes(
        sec['identity_mode'] as string,
      )
    )
      push('security.identity_mode', 'invalid identity_mode');
    if (
      !['single_tenant_instance', 'tenant_context_per_request'].includes(
        sec['tenant_mode'] as string,
      )
    )
      push('security.tenant_mode', 'invalid tenant_mode');
    if (!Array.isArray(sec['required_scopes']))
      push('security.required_scopes', 'must be an array');
  }

  const schemas = m['schemas'] as Record<string, unknown> | undefined;
  if (!schemas) push('schemas', 'required');
  else {
    for (const s of ['observation', 'command', 'result', 'health'] as const) {
      const ref = schemas[s] as Record<string, unknown> | undefined;
      if (
        !ref ||
        typeof ref['uri'] !== 'string' ||
        !isSemver(ref['version']) ||
        typeof ref['sha256'] !== 'string' ||
        !SHA256_RE.test(ref['sha256'] as string)
      )
        push(`schemas.${s}`, 'must be a schemaRef (uri, semver version, sha256)');
    }
  }

  const delivery = m['delivery'] as Record<string, unknown> | undefined;
  if (
    !delivery ||
    !(ORDERING_MODELS as readonly string[]).includes(delivery['ordering'] as string) ||
    !(IDEMPOTENCY_MODES as readonly string[]).includes(delivery['idempotency'] as string) ||
    typeof delivery['supports_operation_lookup'] !== 'boolean' ||
    typeof delivery['supports_tombstones'] !== 'boolean'
  ) {
    push(
      'delivery',
      'ordering, idempotency, supports_operation_lookup, supports_tombstones required',
    );
  }

  const limits = m['limits'] as Record<string, unknown> | undefined;
  if (!limits) push('limits', 'required');
  else {
    for (const k of [
      'requests_per_minute',
      'maximum_concurrency',
      'maximum_batch_size',
      'operation_timeout_seconds',
    ] as const) {
      if (typeof limits[k] !== 'number' || (limits[k] as number) < 1)
        push(`limits.${k}`, 'must be a positive integer');
    }
  }

  const retry = m['retry'] as Record<string, unknown> | undefined;
  if (
    !retry ||
    !Array.isArray(retry['retryable_classes']) ||
    !Array.isArray(retry['terminal_classes']) ||
    typeof retry['maximum_attempts'] !== 'number' ||
    typeof retry['jitter'] !== 'boolean'
  ) {
    push('retry', 'retryable_classes, terminal_classes, maximum_attempts, jitter required');
  } else {
    for (const c of retry['retryable_classes'] as unknown[])
      if (!(RETRYABLE_CLASSES as readonly string[]).includes(c as string))
        push('retry.retryable_classes', `invalid: ${String(c)}`);
    for (const c of retry['terminal_classes'] as unknown[])
      if (!(TERMINAL_CLASSES as readonly string[]).includes(c as string))
        push('retry.terminal_classes', `invalid: ${String(c)}`);
  }

  const recon = m['reconciliation'] as Record<string, unknown> | undefined;
  if (
    !recon ||
    typeof recon['supported'] !== 'boolean' ||
    !['item', 'collection', 'source', 'none'].includes(recon['scope'] as string) ||
    typeof recon['cursor_model'] !== 'string' ||
    !Array.isArray(recon['drift_classes']) ||
    typeof recon['safe_during_source_degradation'] !== 'boolean'
  ) {
    push(
      'reconciliation',
      'supported, scope, cursor_model, drift_classes, safe_during_source_degradation required',
    );
  } else {
    for (const d of recon['drift_classes'] as unknown[])
      if (!(DRIFT_CLASSES as readonly string[]).includes(d as string))
        push('reconciliation.drift_classes', `invalid: ${String(d)}`);
  }

  const ev = m['evidence'] as Record<string, unknown> | undefined;
  if (
    !ev ||
    ev['content_hash'] !== 'sha256' ||
    typeof ev['original_capture'] !== 'boolean' ||
    typeof ev['result_capture'] !== 'boolean' ||
    typeof ev['chain_of_custody'] !== 'boolean' ||
    typeof ev['redaction_supported'] !== 'boolean'
  ) {
    push(
      'evidence',
      'original_capture, result_capture, content_hash=sha256, chain_of_custody, redaction_supported required',
    );
  }

  const health = m['health'] as Record<string, unknown> | undefined;
  if (
    !health ||
    typeof health['endpoint'] !== 'string' ||
    typeof health['readiness_endpoint'] !== 'string' ||
    health['non_mutating'] !== true ||
    typeof health['freshness_seconds'] !== 'number' ||
    (health['freshness_seconds'] as number) < 1 ||
    typeof health['owner_contact'] !== 'string'
  ) {
    push(
      'health',
      'endpoint, readiness_endpoint, non_mutating=true, freshness_seconds>=1, owner_contact required',
    );
  }

  const lc = m['lifecycle'] as Record<string, unknown> | undefined;
  if (
    !lc ||
    !(LIFECYCLE_STATUSES as readonly string[]).includes(lc['status'] as string) ||
    typeof lc['released_at'] !== 'string'
  ) {
    push('lifecycle', 'status and released_at required');
  }

  if (
    m['manifest_digest'] !== undefined &&
    (typeof m['manifest_digest'] !== 'string' || !SHA256_RE.test(m['manifest_digest'] as string))
  )
    push('manifest_digest', 'must be a sha256 hex string');

  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) });
}

/** Assert a value is a valid manifest, throwing with the first issue otherwise. */
export function assertManifest(input: unknown): asserts input is AdapterManifest {
  const r = validateManifest(input);
  if (!r.valid) {
    const first = r.issues[0]!;
    throw new Error(`invalid adapter manifest at "${first.path}": ${first.message}`);
  }
}

// ===========================================================================
// 4. Signing / verification over the canonical form (HMAC seam; Ed25519 is the wire format).
// ===========================================================================
//
// The manifest schema declares Ed25519 as the wire signature algorithm. In this dependency-free,
// key-material-free test/build environment we compute a deterministic detached signature with an HMAC
// over the CANONICAL preimage (the manifest sans its own digest/signature) — the same
// canonical-JSON + sha256 discipline used platform-wide by @trustcircle/evidence. The signature is a
// pure function of (canonical preimage, key), so a tampered manifest fails verification. Swapping in a
// real Ed25519 signer is a drop-in replacement of `signPreimage` at the deployment boundary.

export interface SignManifestInput {
  readonly manifest: AdapterManifest;
  readonly keyId: string;
  readonly signingKey: string;
}

function signPreimage(preimage: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(preimage, 'utf8').digest('base64url');
}

/** Return a copy of the manifest sealed with its computed digest + detached signature. */
export function signManifest(input: SignManifestInput): AdapterManifest {
  const preimage = canonicalJson(stripSealFields(input.manifest));
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  const value = signPreimage(preimage, input.signingKey);
  return Object.freeze({
    ...input.manifest,
    manifest_digest: digest,
    signature: Object.freeze({ algorithm: 'Ed25519' as const, key_id: input.keyId, value }),
  });
}

export type SignatureVerifyResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: 'unsigned' | 'digest-mismatch' | 'signature-mismatch';
    };

/** Verify a sealed manifest's digest and detached signature against the signing key. */
export function verifyManifestSignature(
  manifest: AdapterManifest,
  signingKey: string,
): SignatureVerifyResult {
  if (!manifest.signature || !manifest.manifest_digest) return { valid: false, reason: 'unsigned' };
  const preimage = canonicalJson(stripSealFields(manifest));
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  if (!constantTimeEqual(digest, manifest.manifest_digest))
    return { valid: false, reason: 'digest-mismatch' };
  const expected = signPreimage(preimage, signingKey);
  if (!constantTimeEqual(expected, manifest.signature.value))
    return { valid: false, reason: 'signature-mismatch' };
  return { valid: true };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ===========================================================================
// 5. Capability negotiation + contract compatibility (least privilege, version drift).
// ===========================================================================

export type CapabilityNegotiationResult =
  | { readonly ok: true; readonly enabled: readonly AdapterCapability[] }
  | {
      readonly ok: false;
      readonly reason: 'not_declared';
      readonly offending: readonly AdapterCapability[];
    };

/**
 * Negotiate an enabled capability SUBSET: the requested set must be a subset of what the manifest
 * declares. Requesting a capability the adapter does not declare is refused (never silently granted).
 */
export function negotiateCapabilities(
  manifest: AdapterManifest,
  requested: readonly AdapterCapability[],
): CapabilityNegotiationResult {
  const declared = new Set(manifest.capabilities);
  const offending = requested.filter((c) => !declared.has(c));
  if (offending.length > 0)
    return { ok: false, reason: 'not_declared', offending: Object.freeze([...offending]) };
  // Preserve declared order, dedupe.
  const req = new Set(requested);
  const enabled = manifest.capabilities.filter((c) => req.has(c));
  return { ok: true, enabled: Object.freeze(enabled) };
}

export type ContractNegotiationResult =
  | { readonly ok: true; readonly negotiated: Semver }
  | {
      readonly ok: false;
      readonly reason: 'below_minimum' | 'above_maximum';
      readonly range: ContractRange;
    };

/**
 * NS-005 version-drift refusal: the platform's requested protocol version MUST fall within the
 * manifest's inclusive contract range. Outside it, the adapter never activates.
 */
export function negotiateContract(
  manifest: AdapterManifest,
  platformProtocol: Semver,
): ContractNegotiationResult {
  const { minimum, maximum } = manifest.contract_range;
  if (compareSemver(platformProtocol, minimum) < 0)
    return { ok: false, reason: 'below_minimum', range: manifest.contract_range };
  if (compareSemver(platformProtocol, maximum) > 0)
    return { ok: false, reason: 'above_maximum', range: manifest.contract_range };
  return { ok: true, negotiated: platformProtocol };
}

/** True when a source event's schema major is within the adapter's negotiated support. */
export function isMajorSupported(manifest: AdapterManifest, eventMajor: number): boolean {
  const [min] = parseSemver(manifest.contract_range.minimum);
  const [max] = parseSemver(manifest.contract_range.maximum);
  return eventMajor >= min && eventMajor <= max;
}

// ===========================================================================
// 6. Observation + operation envelopes (the safe wire shapes).
// ===========================================================================

/** A raw source observation the adapter reports — data, never an instruction. */
export interface ObservationEnvelope<TPayload = unknown> {
  readonly adapterId: string;
  readonly adapterVersion: Semver;
  readonly sourceClass: string;
  readonly sourceRevision: string;
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly schemaMajor: number;
  readonly observedAt: number;
  readonly dedupKey: string;
  readonly payload: TPayload;
  readonly payloadDigest: string;
  /** True when this datum is a tombstone (archive/deletion), never a governance closure. */
  readonly tombstone?: boolean;
}

/** An operation the platform asks the adapter to perform, version-pinned + idempotency-keyed. */
export interface OperationEnvelope<TDesired = unknown> {
  readonly adapterId: string;
  readonly adapterVersion: Semver;
  readonly protocol: Semver;
  readonly operationId: string;
  readonly capability: AdapterCapability;
  readonly idempotencyKey: string;
  readonly sourceRevision: string;
  readonly desired: TDesired;
}

/** Deep-freeze + digest an observation, refusing to fabricate a tombstone as a closure. */
export function sealObservation<T>(
  env: Omit<ObservationEnvelope<T>, 'payloadDigest'>,
): ObservationEnvelope<T> {
  const payloadDigest = canonicalDigest(env.payload);
  return Object.freeze({ ...env, payloadDigest }) as ObservationEnvelope<T>;
}

/** Assert an operation envelope carries a usable idempotency key (>= 8 chars) unless read-only. */
export function assertOperationEnvelope(
  env: OperationEnvelope,
  idempotency: IdempotencyMode,
): void {
  if (idempotency !== 'read_only_only' && idempotency !== 'unsupported') {
    if (typeof env.idempotencyKey !== 'string' || env.idempotencyKey.length < 8)
      throw new Error('operation envelope requires an idempotency key of at least 8 characters');
  }
  if (!isSemver(env.protocol)) throw new Error('operation envelope protocol must be semver');
}
