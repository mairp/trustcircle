// @trustcircle/command-worker — the AUDIT EXPORT worker (Phase 7 / User Story 5 — Demonstrate
// Compliance and Audit Readiness / T209 / FR-051..056, SC-012, SC-013, SC-022).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// An auditor asks: "show me, for EXACTLY this scope and this time window, the coverage picture, the
// evidence that backs it, and every gap — and prove none of it was fabricated or promoted." This
// worker answers that asynchronously (the API route accepts a request 202; the worker owns the export)
// by assembling a REPRODUCIBLE, SIGNED audit-export package:
//
//   * AUTHORIZATION / TENANT ISOLATION (FR-053). Every evidence reference is filtered to the export's
//     tenant. A reference owned by another tenant is EXCLUDED from the package (never leaked), and the
//     excluded set is COUNTED so the omission is visible, not silent.
//   * EXACT TIME SCOPE / RECONSTRUCTABLE-AT-INSTANT (SC-013). Coverage is reconstructed purely AS-OF an
//     exact instant (`reconstructedAt`, defaulting to the period end) over the scoped inputs. The same
//     (scope, period, inputs, instant) always yields a byte-identical package.
//   * EVIDENCE LINEAGE / CHAIN OF CUSTODY (FR-052). Each in-scope reference becomes an ordered custody
//     link whose `chainDigest` folds in the PRIOR link's digest, so the chain is a tamper-evident
//     sequence — reorder or drop a link and the recomputed chain no longer matches the manifest.
//   * EXPLICIT GAPS (SC-022). The coverage engine's gaps are copied VERBATIM into the package. The
//     export never hides, downgrades, or infers-away a gap; an all-covered scope yields an empty gap
//     list, and any deficiency surfaces with its kind.
//   * TRUTHFUL CLAIM BOUNDARY (FR-055, SC-012). The package's `claimBoundary` is copied from the engine
//     and NEVER promoted: internal readiness stays `ready`; only a displayable external certification
//     reaches `certified`. The worker asserts this invariant and refuses to sign a promoted package.
//   * SIGNED MANIFEST (FR-056). The manifest is an HMAC-SHA-256 signature over the canonical digest of
//     the package body. Signing is deterministic (same body + key ⇒ same signature); `verifyManifest`
//     re-derives and constant-time-compares it, so tampering with ANY covered field is detectable.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — PURE BUILDER + LEAF-CLEAN WORKER
// ─────────────────────────────────────────────────────────────────────────────
// The package assembly (`buildAuditExportPackage`), custody chain (`buildCustodyChain`), signing
// (`signManifest`), and verification (`verifyManifest`) are PURE exported functions of their inputs —
// no wall clock, no randomness, no I/O — so a performance/contract test can drive the exact export
// logic in-memory at 100k references with a deterministic result. The `AuditExportWorker` class is the
// leaf-clean orchestration shell: it pulls due export requests via an injected port, builds + signs the
// package purely, then commits the outcome through the SAME transactional-outbox unit-of-work every
// governed effect uses (an export-operation state row + the signed-manifest evidence ref + an audit
// event + an outbox notification, atomic or not at all). Re-running the pass is a no-op: the operation
// identity is derived from tenant + scope + period + reason, so a crash mid-export resumes safely.
//
// It composes the REAL coverage engine (`reconstructCoverage`, `coverageReferenceCount`) at the TYPE
// and VALUE level; it depends on NO persistence internals beyond the shared unit-of-work surface.

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  reconstructCoverage,
  coverageReferenceCount,
  type CoverageInputs,
  type CoverageResult,
  type CoverageScope,
  type CoverageGap,
} from '@trustcircle/application';
import {
  commitUnitOfWork,
  readCanonicalState,
  digest,
  canonicalJson,
  type Database,
  type SourceContract,
  type AuditEventInput,
  type CommitUnitOfWorkResult,
} from '@trustcircle/persistence';

// ===========================================================================
// 0. Vocabulary + constants.
// ===========================================================================

/** The disposition the worker records for one export request. */
export const AUDIT_EXPORT_OUTCOMES = ['completed', 'failed', 'empty'] as const;
export type AuditExportOutcome = (typeof AUDIT_EXPORT_OUTCOMES)[number];

/** The canonical `entity_kind` an export operation is stored under. */
export const AUDIT_EXPORT_ENTITY_KIND = 'audit_export_operation';

/** The outbox topic a completed export publishes on. */
export const AUDIT_EXPORT_TOPIC = 'governance.compliance.audit_export_completed';

/** The system principal attributed as the actor on every export effect (deterministic, non-human). */
export const AUDIT_EXPORT_ACTOR = 'system:audit-export-worker';

/** The signature scheme recorded on every manifest (so a verifier knows how to re-derive it). */
export const AUDIT_EXPORT_SIGNATURE_ALG = 'HMAC-SHA-256';

/** The internal-readiness boundaries — a package at any of these is NEVER an external certification. */
const INTERNAL_READINESS_BOUNDARIES: ReadonlySet<string> = new Set([
  'design',
  'implemented',
  'operating',
  'ready',
  'assessed',
  'incomplete',
]);

// ===========================================================================
// 1. Evidence references + the export request (structural, leaf-clean).
// ===========================================================================

/**
 * One evidence reference eligible for an export. `tenantId` is the OWNING tenant — the authorization
 * filter keeps only references owned by the export's tenant (FR-053). `recordedAt` is the instant the
 * reference entered custody; `contentDigest` is its immutable content witness.
 */
export interface EvidenceReference {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly obligationId?: string;
  readonly recordedAt: number;
  readonly contentDigest: string;
  /** Whether the querying tenant is authorized to read the body (metadata is always listable). */
  readonly accessAuthorized: boolean;
}

/** One tamper-evident custody link — its `chainDigest` folds in the prior link's digest (FR-052). */
export interface CustodyLink {
  readonly sequence: number;
  readonly evidenceId: string;
  readonly contentDigest: string;
  readonly recordedAt: number;
  /** sha-256 over {prior chainDigest, this link's identity} — a reorder/drop breaks the fold. */
  readonly chainDigest: string;
}

/** The exact scope + period + reason an export is reconstructed for. */
export interface AuditExportRequest {
  readonly operationRequestId: string;
  readonly tenantId: string;
  readonly requesterPrincipalId: string;
  readonly scope: CoverageScope;
  /** The reconstruction window — inclusive bounds, RFC3339 epoch-ms. */
  readonly periodFrom: number;
  readonly periodTo: number;
  /** The instant coverage is reconstructed AS-OF (SC-013). Defaults to `periodTo` when omitted. */
  readonly reconstructedAt?: number;
  readonly reason: { readonly code: string; readonly text: string };
  /** The coverage inputs (decisions/obligations/mappings/evaluations/certifications) for the scope. */
  readonly coverageInputs: Omit<CoverageInputs, 'scope' | 'at'>;
  /** All candidate evidence references (across tenants) — filtered to the export tenant on the way in. */
  readonly evidenceReferences: readonly EvidenceReference[];
}

// ===========================================================================
// 2. The signed audit-export package (the reproducible witness).
// ===========================================================================

/** The immutable body an export produces — everything the signature is computed over. */
export interface AuditExportBody {
  readonly tenantId: string;
  readonly scope: CoverageScope;
  readonly periodFrom: number;
  readonly periodTo: number;
  readonly reconstructedAt: number;
  readonly reason: { readonly code: string; readonly text: string };
  /** The reconstructed coverage — claimBoundary copied verbatim, never promoted (FR-055). */
  readonly claimBoundary: CoverageResult['claimBoundary'];
  readonly obligationCount: number;
  readonly coveredCount: number;
  readonly complete: boolean;
  /** The exact reference count in scope (SC-013) — excludes cross-tenant references. */
  readonly referenceCount: number;
  /** The number of candidate references EXCLUDED by the tenant-authorization filter (visible omission). */
  readonly excludedReferenceCount: number;
  /** The ordered chain of custody over the in-scope references (FR-052). */
  readonly custody: readonly CustodyLink[];
  /** Every coverage gap, copied VERBATIM from the engine (SC-022) — never hidden. */
  readonly gaps: readonly CoverageGap[];
  /**
   * The truthful external-claim disclaimer, always present: an audit export is internal readiness
   * evidence unless it carries a displayable external certification. It is NEVER a conformity,
   * accreditation, or certification claim by itself.
   */
  readonly externalClaimNote: string;
}

/** The signature envelope over an {@link AuditExportBody}. */
export interface AuditExportManifest {
  readonly algorithm: typeof AUDIT_EXPORT_SIGNATURE_ALG;
  /** Canonical digest of the body the signature covers (independent of key). */
  readonly bodyDigest: string;
  /** Identifier of the signing key (so a verifier selects the right key; never the key material). */
  readonly keyId: string;
  /** HMAC-SHA-256 hex over the body digest with the signing key. */
  readonly signature: string;
}

/** The complete, signed, reproducible export package. */
export interface AuditExportPackage {
  readonly body: AuditExportBody;
  readonly manifest: AuditExportManifest;
}

export const EXTERNAL_CLAIM_NOTE =
  'This audit export is internal readiness evidence reconstructed for an exact scope and instant. ' +
  'It is not, by itself, a conformity, accreditation, or external certification claim; external ' +
  'certification is represented only when a verifiable external certificate is displayed.';

// ===========================================================================
// 3. Pure builders — reconstruct, filter, chain, sign, verify.
// ===========================================================================

/** Keep only references owned by `tenantId` (FR-053). Returns the kept set + the excluded count. */
export function authorizeReferences(
  references: readonly EvidenceReference[],
  tenantId: string,
): { readonly kept: readonly EvidenceReference[]; readonly excluded: number } {
  const kept: EvidenceReference[] = [];
  let excluded = 0;
  for (const ref of references) {
    if (ref.tenantId === tenantId) kept.push(ref);
    else excluded += 1;
  }
  return { kept, excluded };
}

/**
 * Deterministically order references (by recordedAt, then evidenceId) and fold each into a
 * tamper-evident custody chain: link N's `chainDigest = sha256(link N-1 chainDigest ‖ link N identity)`.
 * Reordering or dropping any link changes every subsequent `chainDigest` (FR-052).
 */
export function buildCustodyChain(references: readonly EvidenceReference[]): readonly CustodyLink[] {
  const ordered = [...references].sort((a, b) =>
    a.recordedAt !== b.recordedAt
      ? a.recordedAt - b.recordedAt
      : a.evidenceId < b.evidenceId
        ? -1
        : a.evidenceId > b.evidenceId
          ? 1
          : 0,
  );
  const chain: CustodyLink[] = [];
  let prior = 'genesis';
  for (let i = 0; i < ordered.length; i += 1) {
    const ref = ordered[i]!;
    const identity = {
      sequence: i,
      evidenceId: ref.evidenceId,
      contentDigest: ref.contentDigest,
      recordedAt: ref.recordedAt,
    };
    const chainDigest = digest({ prior, identity });
    chain.push({ ...identity, chainDigest });
    prior = chainDigest;
  }
  return chain;
}

/** True iff the custody chain is a valid fold (recomputing it yields the same digests). Tamper check. */
export function custodyChainIsIntact(chain: readonly CustodyLink[]): boolean {
  let prior = 'genesis';
  for (let i = 0; i < chain.length; i += 1) {
    const link = chain[i]!;
    if (link.sequence !== i) return false;
    const expected = digest({
      prior,
      identity: {
        sequence: link.sequence,
        evidenceId: link.evidenceId,
        contentDigest: link.contentDigest,
        recordedAt: link.recordedAt,
      },
    });
    if (expected !== link.chainDigest) return false;
    prior = link.chainDigest;
  }
  return true;
}

/** True iff a claim boundary represents internal readiness (never an external certification claim). */
export function isInternalReadinessBoundary(boundary: string): boolean {
  return INTERNAL_READINESS_BOUNDARIES.has(boundary);
}

/**
 * Build the immutable export BODY purely from a request — reconstruct coverage AS-OF the instant,
 * authorize references to the tenant, fold the custody chain, and copy gaps + boundary VERBATIM. No
 * wall clock, no randomness: identical inputs ⇒ identical body. Throws if the request tenant does not
 * match the scope tenant (a scope/tenant mismatch is a programming error, never silently exported).
 */
export function buildAuditExportBody(request: AuditExportRequest): AuditExportBody {
  if (request.scope.tenantId !== request.tenantId) {
    throw new AuditExportError(
      `scope tenant ${request.scope.tenantId} does not match export tenant ${request.tenantId}`,
    );
  }
  const reconstructedAt = request.reconstructedAt ?? request.periodTo;

  const inputs: CoverageInputs = {
    scope: request.scope,
    decisions: request.coverageInputs.decisions,
    obligations: request.coverageInputs.obligations,
    mappings: request.coverageInputs.mappings,
    evaluations: request.coverageInputs.evaluations,
    certifications: request.coverageInputs.certifications,
    at: reconstructedAt,
  };
  const coverage = reconstructCoverage(inputs);

  // FR-055 / SC-012 — the engine's boundary is copied verbatim; the worker NEVER promotes it. If the
  // engine somehow returned 'certified' with no displayable certification, the invariant below (in the
  // worker) refuses to sign — here we only copy what the engine truthfully computed.
  const { kept, excluded } = authorizeReferences(request.evidenceReferences, request.tenantId);
  const custody = buildCustodyChain(kept);

  return {
    tenantId: request.tenantId,
    scope: request.scope,
    periodFrom: request.periodFrom,
    periodTo: request.periodTo,
    reconstructedAt,
    reason: request.reason,
    claimBoundary: coverage.claimBoundary,
    obligationCount: coverage.obligationCount,
    coveredCount: coverage.coveredCount,
    complete: coverage.complete,
    referenceCount: kept.length,
    excludedReferenceCount: excluded,
    custody,
    gaps: coverage.gaps, // SC-022 — verbatim, never filtered.
    externalClaimNote: EXTERNAL_CLAIM_NOTE,
  };
}

/** The canonical digest of an export body — the value a signature is computed over (key-independent). */
export function auditExportBodyDigest(body: AuditExportBody): string {
  return digest(body);
}

/** Sign an export body with a keyed HMAC (FR-056). Deterministic: same body + key ⇒ same signature. */
export function signManifest(body: AuditExportBody, key: SigningKey): AuditExportManifest {
  const bodyDigest = auditExportBodyDigest(body);
  const signature = createHmac('sha256', key.secret).update(bodyDigest).digest('hex');
  return { algorithm: AUDIT_EXPORT_SIGNATURE_ALG, bodyDigest, keyId: key.keyId, signature };
}

/**
 * Verify a signed package: the body digest must match the body, and the HMAC must re-derive (constant
 * time). Any tampering with a covered field, the custody chain, the gaps, or the boundary fails here.
 */
export function verifyManifest(pkg: AuditExportPackage, key: SigningKey): boolean {
  if (pkg.manifest.keyId !== key.keyId) return false;
  if (pkg.manifest.algorithm !== AUDIT_EXPORT_SIGNATURE_ALG) return false;
  const expectedBodyDigest = auditExportBodyDigest(pkg.body);
  if (pkg.manifest.bodyDigest !== expectedBodyDigest) return false;
  if (!custodyChainIsIntact(pkg.body.custody)) return false;
  const expectedSig = createHmac('sha256', key.secret).update(expectedBodyDigest).digest('hex');
  const a = Buffer.from(pkg.manifest.signature, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A named signing key (the secret never leaves the worker; the keyId is recorded on the manifest). */
export interface SigningKey {
  readonly keyId: string;
  readonly secret: string | Uint8Array;
}

/**
 * Assemble the full SIGNED package purely (build body → assert truthful boundary → sign). Throws
 * {@link AuditExportError} if the body would misrepresent internal readiness as external certification.
 */
export function buildAuditExportPackage(
  request: AuditExportRequest,
  key: SigningKey,
): AuditExportPackage {
  const body = buildAuditExportBody(request);
  assertTruthfulBoundary(body, request);
  const manifest = signManifest(body, key);
  return { body, manifest };
}

/**
 * FR-055 / SC-012 guard: a `certified` boundary is only truthful when the scope actually carries at
 * least one external certification input; otherwise the export would promote internal readiness to an
 * external claim. Refuse to sign such a package.
 */
export function assertTruthfulBoundary(body: AuditExportBody, request: AuditExportRequest): void {
  if (body.claimBoundary === 'certified' && request.coverageInputs.certifications.length === 0) {
    throw new AuditExportError(
      'refusing to sign: claimBoundary is certified but no external certification is present ' +
        '(internal readiness must never be promoted to external certification)',
    );
  }
  // A readiness/internal boundary must never be relabelled — this is a copy check, not a re-derivation.
  if (
    !isInternalReadinessBoundary(body.claimBoundary) &&
    body.claimBoundary !== 'certified'
  ) {
    throw new AuditExportError(`unexpected claim boundary "${body.claimBoundary}" in export body`);
  }
}

/** The in-scope reference count for a request (SC-013) — matches the built body's `referenceCount`. */
export function exportReferenceCount(request: AuditExportRequest): number {
  return authorizeReferences(request.evidenceReferences, request.tenantId).kept.length;
}

/** The engine's own coverage reference count for the reconstructed scope (independent cross-check). */
export function coverageReferenceCountFor(request: AuditExportRequest): number {
  return coverageReferenceCount({
    scope: request.scope,
    decisions: request.coverageInputs.decisions,
    obligations: request.coverageInputs.obligations,
    mappings: request.coverageInputs.mappings,
    evaluations: request.coverageInputs.evaluations,
    certifications: request.coverageInputs.certifications,
    at: request.reconstructedAt ?? request.periodTo,
  });
}

export class AuditExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditExportError';
  }
}

// ===========================================================================
// 4. Injected ports + worker configuration (leaf-clean orchestration).
// ===========================================================================

export interface AuditExportPorts {
  /** The bounded batch of accepted, not-yet-processed export requests at `now` (repository query). */
  readonly dueExports: (now: number, limit: number) => Promise<readonly AuditExportRequest[]>;
  /**
   * Persist the signed package to durable export storage and return its storage ref (the worker records
   * the ref + manifest digest as evidence). Idempotent by (tenant, operationId).
   */
  readonly persistPackage: (
    request: AuditExportRequest,
    pkg: AuditExportPackage,
    now: number,
  ) => Promise<{ readonly storageRef: string }>;
}

export interface AuditExportOptions {
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly signingKey: SigningKey;
  readonly owner?: string;
  /** Max exports processed per pass. Default 10 (an export can be large). */
  readonly batchSize?: number;
}

const DEFAULT_OWNER = 'team:governance-runtime';
const DEFAULT_BATCH_SIZE = 10;

// ===========================================================================
// 5. Per-export + per-pass result shapes (fail-visible witnesses).
// ===========================================================================

export interface AuditExportItemResult {
  readonly operationId: string;
  readonly tenantId: string;
  readonly outcome: AuditExportOutcome;
  readonly referenceCount: number;
  readonly excludedReferenceCount: number;
  readonly gapCount: number;
  readonly claimBoundary: string;
  readonly manifestSignature: string | null;
  readonly storageRef: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly deduplicated: boolean;
  readonly error: string | null;
}

export interface AuditExportPassResult {
  readonly scannedAt: number;
  readonly scanned: number;
  readonly completed: number;
  readonly empty: number;
  readonly failed: number;
  readonly deduplicated: number;
  readonly results: readonly AuditExportItemResult[];
}

// ===========================================================================
// 6. Deterministic identity derivation (ONE idempotency identity).
// ===========================================================================

/** The stable identity basis for an export operation (tenant + scope + period + reason + requestId). */
export function exportIdentityBasis(request: AuditExportRequest): Readonly<Record<string, unknown>> {
  return {
    operationRequestId: request.operationRequestId,
    tenantId: request.tenantId,
    scope: request.scope,
    periodFrom: request.periodFrom,
    periodTo: request.periodTo,
    reconstructedAt: request.reconstructedAt ?? request.periodTo,
    reasonCode: request.reason.code,
  };
}

export function exportOperationId(request: AuditExportRequest): string {
  return 'audit-export-' + digest({ ...exportIdentityBasis(request), purpose: 'operation_id' }).slice(0, 32);
}

export function exportIdempotencyKey(request: AuditExportRequest): string {
  return 'export-' + digest({ ...exportIdentityBasis(request), purpose: 'idempotency' }).slice(0, 40);
}

export function exportCorrelationId(request: AuditExportRequest): string {
  return 'corr-export-' + digest({ ...exportIdentityBasis(request), purpose: 'correlation' }).slice(0, 32);
}

// ===========================================================================
// 7. The audit-export worker.
// ===========================================================================

export class AuditExportWorker {
  readonly #db: Database;
  readonly #ports: AuditExportPorts;
  readonly #contract: SourceContract;
  readonly #expectedContractVersion: string;
  readonly #policyVersion: string;
  readonly #controlVersion: string;
  readonly #signingKey: SigningKey;
  readonly #owner: string;
  readonly #batchSize: number;

  constructor(db: Database, ports: AuditExportPorts, opts: AuditExportOptions) {
    this.#db = db;
    this.#ports = ports;
    this.#contract = opts.contract;
    this.#expectedContractVersion = opts.expectedContractVersion;
    this.#policyVersion = opts.policyVersion;
    this.#controlVersion = opts.controlVersion;
    this.#signingKey = opts.signingKey;
    this.#owner = opts.owner ?? DEFAULT_OWNER;
    const b = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(b) || b <= 0) throw new RangeError('batchSize must be a positive integer');
    this.#batchSize = b;
  }

  /**
   * Run ONE deterministic export pass at `now`. Each accepted request is reconstructed AS-OF its exact
   * instant, tenant-filtered, custody-chained, gap-listed, and HMAC-signed, then committed through the
   * shared unit-of-work (operation state + signed-manifest evidence + audit event + outbox). Re-running
   * the pass over the same durable state is a no-op (dedup on the single idempotency identity).
   */
  async runExportPass(now: number): Promise<AuditExportPassResult> {
    if (!Number.isFinite(now)) throw new RangeError('now must be a finite epoch-ms instant');
    const results: AuditExportItemResult[] = [];
    for (const request of await this.#ports.dueExports(now, this.#batchSize)) {
      results.push(await this.#exportOne(request, now));
    }
    const count = (o: AuditExportOutcome): number =>
      results.filter((r) => r.outcome === o && !r.deduplicated).length;
    return {
      scannedAt: now,
      scanned: results.length,
      completed: count('completed'),
      empty: count('empty'),
      failed: count('failed'),
      deduplicated: results.filter((r) => r.deduplicated).length,
      results,
    };
  }

  async #exportOne(request: AuditExportRequest, now: number): Promise<AuditExportItemResult> {
    const operationId = exportOperationId(request);
    const idempotencyKey = exportIdempotencyKey(request);
    const correlationId = exportCorrelationId(request);
    const base = {
      operationId,
      tenantId: request.tenantId,
      idempotencyKey,
      correlationId,
    };

    // Build + sign the package PURELY. A truthful-boundary violation or a scope/tenant mismatch is a
    // visible failure — never a promoted or leaked export.
    let pkg: AuditExportPackage;
    try {
      pkg = buildAuditExportPackage(request, this.#signingKey);
    } catch (err) {
      return {
        ...base,
        outcome: 'failed',
        referenceCount: 0,
        excludedReferenceCount: 0,
        gapCount: 0,
        claimBoundary: 'incomplete',
        manifestSignature: null,
        storageRef: null,
        deduplicated: false,
        error: describeAuditExportError(err),
      };
    }

    // Persist the package to durable storage (idempotent by tenant+operation).
    let storageRef: string;
    try {
      const persisted = await this.#ports.persistPackage(request, pkg, now);
      storageRef = persisted.storageRef;
    } catch (err) {
      return {
        ...base,
        outcome: 'failed',
        referenceCount: pkg.body.referenceCount,
        excludedReferenceCount: pkg.body.excludedReferenceCount,
        gapCount: pkg.body.gaps.length,
        claimBoundary: pkg.body.claimBoundary,
        manifestSignature: null,
        storageRef: null,
        deduplicated: false,
        error: `package persistence failed: ${describeAuditExportError(err)}`,
      };
    }

    // An export with no in-scope references AND no obligations is `empty` (honest — not a fabricated
    // "all clear"): it still commits a signed package so the emptiness itself is provable.
    const outcome: AuditExportOutcome =
      pkg.body.referenceCount === 0 && pkg.body.obligationCount === 0 ? 'empty' : 'completed';

    return this.#commit(request, pkg, storageRef, now, outcome);
  }

  async #commit(
    request: AuditExportRequest,
    pkg: AuditExportPackage,
    storageRef: string,
    now: number,
    outcome: AuditExportOutcome,
  ): Promise<AuditExportItemResult> {
    const operationId = exportOperationId(request);
    const idempotencyKey = exportIdempotencyKey(request);
    const correlationId = exportCorrelationId(request);
    const idBasis = exportIdentityBasis(request);

    const state = {
      id: operationId,
      tenantId: request.tenantId,
      operationRequestId: request.operationRequestId,
      requesterPrincipalId: request.requesterPrincipalId,
      scope: request.scope,
      periodFrom: request.periodFrom,
      periodTo: request.periodTo,
      reconstructedAt: pkg.body.reconstructedAt,
      claimBoundary: pkg.body.claimBoundary,
      referenceCount: pkg.body.referenceCount,
      excludedReferenceCount: pkg.body.excludedReferenceCount,
      gapCount: pkg.body.gaps.length,
      manifestDigest: pkg.manifest.bodyDigest,
      manifestSignature: pkg.manifest.signature,
      signatureKeyId: pkg.manifest.keyId,
      storageRef,
      outcome,
      exportedBy: AUDIT_EXPORT_ACTOR,
      exportedAt: now,
    };

    const evidenceRefs = [
      `export-package:${storageRef}`,
      `manifest-digest:${pkg.manifest.bodyDigest}`,
      `manifest-signature:${pkg.manifest.signature}`,
      `signing-key:${pkg.manifest.keyId}`,
      `custody-links:${pkg.body.custody.length}`,
      ...pkg.body.gaps.map((g, i) => `gap:${i}:${g.kind}`),
    ];

    const audit: AuditEventInput = {
      actor: AUDIT_EXPORT_ACTOR,
      owner: this.#owner,
      reason: { code: `audit_export_${outcome}`, text: request.reason.text },
      sourceStateDigest: digest({ ...idBasis, phase: 'export_requested' }),
      targetStateDigest: digest(state),
      scope: `tenant:${request.tenantId}/audit_export:${operationId}`,
      policyVersion: this.#policyVersion,
      controlVersion: this.#controlVersion,
      evidenceRefs,
    };

    const baseResult = {
      operationId,
      tenantId: request.tenantId,
      referenceCount: pkg.body.referenceCount,
      excludedReferenceCount: pkg.body.excludedReferenceCount,
      gapCount: pkg.body.gaps.length,
      claimBoundary: pkg.body.claimBoundary,
      idempotencyKey,
      correlationId,
    };

    try {
      const result: CommitUnitOfWorkResult = await commitUnitOfWork(this.#db, {
        tenantId: request.tenantId,
        operationScope: 'compliance.audit_export',
        idempotencyKey,
        correlationId,
        contract: this.#contract,
        expectedContractVersion: this.#expectedContractVersion,
        request: { kind: 'audit_export', entityId: operationId, expectedVersion: 0 },
        canonical: {
          entityKind: AUDIT_EXPORT_ENTITY_KIND,
          entityId: operationId,
          expectedVersion: 0,
          state,
        },
        action: 'export',
        audit,
        outbox: {
          topic: AUDIT_EXPORT_TOPIC,
          payload: {
            eventType: 'audit_export_completed',
            tenantId: request.tenantId,
            operationId,
            outcome,
            claimBoundary: pkg.body.claimBoundary,
            referenceCount: pkg.body.referenceCount,
            gapCount: pkg.body.gaps.length,
            manifestSignature: pkg.manifest.signature,
            storageRef,
            exportedAt: now,
          },
        },
      });
      if (result.deduplicated) {
        return {
          ...baseResult,
          outcome,
          manifestSignature: pkg.manifest.signature,
          storageRef,
          deduplicated: true,
          error: null,
        };
      }
      if (result.status !== 'succeeded') {
        return {
          ...baseResult,
          outcome: 'failed',
          manifestSignature: null,
          storageRef,
          deduplicated: false,
          error: `commit did not succeed: status=${result.status} nextAction=${result.nextAction}`,
        };
      }
      return {
        ...baseResult,
        outcome,
        manifestSignature: pkg.manifest.signature,
        storageRef,
        deduplicated: false,
        error: null,
      };
    } catch (err) {
      return {
        ...baseResult,
        outcome: 'failed',
        manifestSignature: null,
        storageRef,
        deduplicated: false,
        error: describeAuditExportError(err),
      };
    }
  }

  /**
   * Independent read path: the current canonical state of a committed export operation (the durable
   * witness — never the commit return value). Returns null if no canonical row exists.
   */
  async readExport(
    tenantId: string,
    operationId: string,
  ): Promise<{ version: number; stateDigest: string; state: unknown } | null> {
    const row = await readCanonicalState(this.#db, tenantId, AUDIT_EXPORT_ENTITY_KIND, operationId);
    if (!row) return null;
    return { version: row.version, stateDigest: row.stateDigest, state: row.state };
  }
}

// ===========================================================================
// 8. Utilities.
// ===========================================================================

/** The canonical serialization of a package (stable across processes) — for out-of-band verification. */
export function serializeAuditExportPackage(pkg: AuditExportPackage): string {
  return canonicalJson(pkg);
}

/** Disclosure-safe error description (class + message, never internal dumps). */
export function describeAuditExportError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
