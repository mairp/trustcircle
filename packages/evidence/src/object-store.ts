// @trustcircle/evidence — content-addressed object-store port and S3-compatible immutable
// adapter (T034 / GAR-006 / VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 /
// VO-4aeb030a32c9deebdb3b).
//
// Oracle: Originals MUST remain immutable or tamper-evident; derived repairs, exports,
// redactions, and dispositions MUST retain provenance, integrity, authorization, retention,
// and access history.
//
// Design (specs/001-governance-control-plane/plan.md §Storage, research.md Decision 8):
//   - Evidence bodies are CONTENT-ADDRESSED by SHA-256. The object key IS the digest, so an
//     object can never be silently overwritten with different bytes — a mismatch between the
//     declared key and the recomputed digest is a hard integrity failure.
//   - The store is IMMUTABLE-CAPABLE, modelled on the S3 Object Lock feature set: per-object
//     retain-until (WORM retention) and legal hold, plus versioning. While an object is under
//     a COMPLIANCE-mode retention or an active legal hold it can never be overwritten or
//     deleted — not even by an administrator — which is exactly the "originals immutable"
//     guarantee. Overwrites of an existing key with IDENTICAL bytes are idempotent no-ops;
//     overwrites with DIFFERENT bytes are rejected (content-address collision is impossible
//     for SHA-256 in practice, so this is a tamper signal).
//   - Every mutating and read operation appends to an in-object ACCESS HISTORY (append-only),
//     and every stored object retains its PROVENANCE (parent digest + method + transformation
//     digest), INTEGRITY (content digest + size), and AUTHORIZATION (principal + grant) at the
//     moment of write. None of these fields can be rewritten after commit.
//
// This module is dependency-free (Node built-in `crypto` only). The concrete
// InMemoryImmutableObjectStore is a faithful, deterministic S3-compatible reference adapter
// so the port contract is independently observable under `npm ci` with no live S3.

import { createHash, timingSafeEqual } from 'node:crypto';

// Shared with retention.ts (single source of truth for these primitives), so the package
// export surface stays unambiguous.
import type { Authorization, EpochMillis } from './retention.ts';

// ---------------------------------------------------------------------------
// Shared primitives.
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 digest — the content address of an object. */
export type ContentDigest = string;

/** Object Lock retention modes, mirroring S3 Object Lock semantics. */
export type RetentionMode = 'GOVERNANCE' | 'COMPLIANCE';

/** Provenance edge retained with a derived object (redaction, export, repair, …). */
export interface Provenance {
  /** Content address of the parent this object derived from; null for originals. */
  readonly parentDigest: ContentDigest | null;
  /** How the object was produced (e.g. 'capture', 'redaction', 'export', 'repair'). */
  readonly method: string;
  /** Digest binding the transformation that produced this object; null for originals. */
  readonly transformationDigest: ContentDigest | null;
}

export type ObjectKind = 'original' | 'derived' | 'export' | 'redaction' | 'repair';

/** One entry in an object's append-only access history. */
export interface AccessEntry {
  readonly principalId: string;
  readonly action: 'put' | 'get' | 'head' | 'legal-hold-set' | 'legal-hold-clear' | 'delete-denied';
  readonly at: EpochMillis;
}

/** Immutable retention binding for an object (S3 Object Lock retention). */
export interface ObjectRetention {
  readonly mode: RetentionMode;
  readonly retainUntil: EpochMillis;
}

/** Metadata retained alongside the content of a stored object version. */
export interface ObjectMetadata {
  readonly tenantId: string;
  readonly kind: ObjectKind;
  readonly classification: string;
  readonly provenance: Provenance;
  readonly authorization: Authorization;
  readonly retention: ObjectRetention | null;
  readonly createdAt: EpochMillis;
}

/** An immutable, content-addressed object version as stored. */
export interface StoredObject {
  readonly digest: ContentDigest;
  readonly versionId: string;
  readonly size: number;
  readonly metadata: ObjectMetadata;
  readonly legalHold: boolean;
  /** Append-only access history — every read and write is recorded. */
  readonly accessHistory: readonly AccessEntry[];
}

// ---------------------------------------------------------------------------
// The content-addressed object-store PORT.
// ---------------------------------------------------------------------------

export interface PutRequest {
  /** Raw content bytes; the object key is derived from their SHA-256. */
  readonly content: Uint8Array;
  readonly metadata: ObjectMetadata;
  readonly by: Authorization;
  readonly now: EpochMillis;
  /**
   * Caller's expected content address. If supplied it MUST equal the recomputed digest, or
   * the write is rejected as a tamper/integrity failure.
   */
  readonly expectedDigest?: ContentDigest;
}

export interface PutResult {
  readonly digest: ContentDigest;
  readonly versionId: string;
  /** True when an identical object already existed (idempotent no-op). */
  readonly deduplicated: boolean;
}

export interface GetResult {
  readonly object: StoredObject;
  readonly content: Uint8Array;
}

/**
 * Content-addressed, immutable-capable object-store port. Implementations MUST guarantee:
 *   - keys are SHA-256 content addresses (put derives the key from the bytes);
 *   - a committed object's bytes, size, provenance, authorization, and creation time are
 *     immutable (tamper-evident): re-putting different bytes under the same key is rejected;
 *   - while under COMPLIANCE retention or an active legal hold an object cannot be deleted;
 *   - every operation appends to the object's access history.
 */
export interface ContentAddressedObjectStore {
  /** Store content under its content address. Idempotent for identical bytes. */
  put(req: PutRequest): PutResult;
  /** Fetch content + metadata by content address; verifies integrity on read. */
  get(digest: ContentDigest, by: Authorization, now: EpochMillis): GetResult;
  /** Fetch metadata only (no body); records access. */
  head(digest: ContentDigest, by: Authorization, now: EpochMillis): StoredObject;
  /** True if an object with this content address exists. */
  exists(digest: ContentDigest): boolean;
  /** Place a legal hold on an object (blocks deletion regardless of retention). */
  setLegalHold(digest: ContentDigest, by: Authorization, now: EpochMillis): StoredObject;
  /** Release a legal hold. GOVERNANCE-only: does not shorten COMPLIANCE retention. */
  clearLegalHold(digest: ContentDigest, by: Authorization, now: EpochMillis): StoredObject;
  /**
   * Delete an object. MUST throw while the object is under active legal hold or unexpired
   * COMPLIANCE retention. GOVERNANCE retention may be bypassed only with an explicit
   * bypass-authorized principal.
   */
  delete(req: DeleteRequest): void;
  /** All content addresses currently stored (for a tenant when scoped). */
  list(tenantId?: string): readonly ContentDigest[];
}

export interface DeleteRequest {
  readonly digest: ContentDigest;
  readonly by: Authorization;
  readonly now: EpochMillis;
  /** Only honoured for GOVERNANCE-mode retention; never overrides COMPLIANCE or legal hold. */
  readonly bypassGovernanceRetention?: boolean;
}

// ---------------------------------------------------------------------------
// Errors — deletion / mutation refusals are first-class so callers can react.
// ---------------------------------------------------------------------------

export type ImmutabilityViolationReason =
  | 'content-address-mismatch'
  | 'overwrite-with-different-bytes'
  | 'active-legal-hold'
  | 'compliance-retention-not-elapsed'
  | 'governance-retention-not-elapsed'
  | 'not-found';

export class ImmutableObjectError extends Error {
  readonly reason: ImmutabilityViolationReason;
  readonly digest: ContentDigest;
  constructor(reason: ImmutabilityViolationReason, digest: ContentDigest) {
    super(`immutable object-store violation [${reason}] for ${digest}`);
    this.name = 'ImmutableObjectError';
    this.reason = reason;
    this.digest = digest;
  }
}

// ---------------------------------------------------------------------------
// Digest helper.
// ---------------------------------------------------------------------------

/** Compute the lowercase-hex SHA-256 content address of some bytes. */
export function contentAddress(content: Uint8Array): ContentDigest {
  return createHash('sha256').update(content).digest('hex');
}

function digestsEqual(a: ContentDigest, b: ContentDigest): boolean {
  if (a.length !== b.length) return false;
  // Constant-time compare over the ASCII hex to avoid leaking via early-exit.
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// S3-compatible immutable adapter (in-memory reference implementation).
// ---------------------------------------------------------------------------

interface StoredEntry {
  readonly content: Uint8Array;
  readonly object: StoredObject;
}

/**
 * Deterministic, S3-Object-Lock-compatible immutable object store. Bytes are addressed by
 * SHA-256; committed objects are WORM — their content/provenance/authorization are frozen and
 * deletion is blocked under COMPLIANCE retention or legal hold. Version IDs are derived from
 * the digest + write ordinal (no wall-clock / randomness) so runs are reproducible.
 */
export class InMemoryImmutableObjectStore implements ContentAddressedObjectStore {
  readonly #objects = new Map<ContentDigest, StoredEntry>();
  #writeCounter = 0;

  put(req: PutRequest): PutResult {
    const digest = contentAddress(req.content);
    if (req.expectedDigest !== undefined && !digestsEqual(req.expectedDigest, digest)) {
      throw new ImmutableObjectError('content-address-mismatch', req.expectedDigest);
    }

    const existing = this.#objects.get(digest);
    if (existing) {
      // Content-addressed: identical key ⇒ identical bytes (SHA-256). Defensively verify and
      // reject any collision as a tamper signal; otherwise the write is an idempotent no-op.
      if (!bytesEqual(existing.content, req.content)) {
        throw new ImmutableObjectError('overwrite-with-different-bytes', digest);
      }
      return { digest, versionId: existing.object.versionId, deduplicated: true };
    }

    const versionId = `${digest}:${(this.#writeCounter++).toString(36)}`;
    const object: StoredObject = {
      digest,
      versionId,
      size: req.content.byteLength,
      metadata: req.metadata,
      legalHold: false,
      accessHistory: [{ principalId: req.by.principalId, action: 'put', at: req.now }],
    };
    // Store a defensive copy so the caller cannot mutate committed bytes afterwards.
    this.#objects.set(digest, { content: Uint8Array.from(req.content), object });
    return { digest, versionId, deduplicated: false };
  }

  get(digest: ContentDigest, by: Authorization, now: EpochMillis): GetResult {
    const entry = this.#require(digest);
    // Integrity is verified on every read: recompute the address and compare.
    const actual = contentAddress(entry.content);
    if (!digestsEqual(actual, digest)) {
      throw new ImmutableObjectError('content-address-mismatch', digest);
    }
    const object = this.#append(entry, { principalId: by.principalId, action: 'get', at: now });
    return { object, content: Uint8Array.from(entry.content) };
  }

  head(digest: ContentDigest, by: Authorization, now: EpochMillis): StoredObject {
    const entry = this.#require(digest);
    return this.#append(entry, { principalId: by.principalId, action: 'head', at: now });
  }

  exists(digest: ContentDigest): boolean {
    return this.#objects.has(digest);
  }

  setLegalHold(digest: ContentDigest, by: Authorization, now: EpochMillis): StoredObject {
    const entry = this.#require(digest);
    const object: StoredObject = { ...entry.object, legalHold: true };
    const withHistory = appendHistory(object, {
      principalId: by.principalId,
      action: 'legal-hold-set',
      at: now,
    });
    this.#objects.set(digest, { content: entry.content, object: withHistory });
    return withHistory;
  }

  clearLegalHold(digest: ContentDigest, by: Authorization, now: EpochMillis): StoredObject {
    const entry = this.#require(digest);
    const object: StoredObject = { ...entry.object, legalHold: false };
    const withHistory = appendHistory(object, {
      principalId: by.principalId,
      action: 'legal-hold-clear',
      at: now,
    });
    this.#objects.set(digest, { content: entry.content, object: withHistory });
    return withHistory;
  }

  delete(req: DeleteRequest): void {
    const entry = this.#require(req.digest);
    const reason = deletionBlockReason(entry.object, req.now, req.bypassGovernanceRetention);
    if (reason) {
      // Record the refused attempt in the access history before throwing.
      const denied = appendHistory(entry.object, {
        principalId: req.by.principalId,
        action: 'delete-denied',
        at: req.now,
      });
      this.#objects.set(req.digest, { content: entry.content, object: denied });
      throw new ImmutableObjectError(reason, req.digest);
    }
    this.#objects.delete(req.digest);
  }

  list(tenantId?: string): readonly ContentDigest[] {
    const out: ContentDigest[] = [];
    for (const [digest, entry] of this.#objects) {
      if (tenantId === undefined || entry.object.metadata.tenantId === tenantId) out.push(digest);
    }
    return out;
  }

  #require(digest: ContentDigest): StoredEntry {
    const entry = this.#objects.get(digest);
    if (!entry) throw new ImmutableObjectError('not-found', digest);
    return entry;
  }

  #append(entry: StoredEntry, access: AccessEntry): StoredObject {
    const object = appendHistory(entry.object, access);
    this.#objects.set(object.digest, { content: entry.content, object });
    return object;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so tests can observe the immutability decisions directly).
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function appendHistory(object: StoredObject, access: AccessEntry): StoredObject {
  return { ...object, accessHistory: [...object.accessHistory, access] };
}

/**
 * Decide whether an object may be deleted at `now`. Returns the blocking reason, or null if
 * deletion is permitted. Legal hold blocks unconditionally. COMPLIANCE retention blocks until
 * it elapses and CANNOT be bypassed. GOVERNANCE retention blocks until it elapses unless an
 * explicit bypass is authorized.
 */
export function deletionBlockReason(
  object: StoredObject,
  now: EpochMillis,
  bypassGovernanceRetention?: boolean,
): ImmutabilityViolationReason | null {
  if (object.legalHold) return 'active-legal-hold';
  const retention = object.metadata.retention;
  if (retention && now < retention.retainUntil) {
    if (retention.mode === 'COMPLIANCE') return 'compliance-retention-not-elapsed';
    if (!bypassGovernanceRetention) return 'governance-retention-not-elapsed';
  }
  return null;
}

/**
 * Verify that a stored object retains complete provenance for its kind: originals have no
 * parent edge, every derived object (repair/export/redaction/derived) retains a parent digest
 * plus a transformation digest, authorization, and retention. Used to assert the oracle that
 * derived artifacts "retain provenance, integrity, authorization, retention, and access
 * history."
 */
export function retainsRequiredProvenance(object: StoredObject): boolean {
  const { kind, provenance, authorization, retention } = object.metadata;
  if (!authorization.principalId || !authorization.grantId) return false;
  if (object.accessHistory.length === 0) return false;
  if (kind === 'original') {
    return provenance.parentDigest === null && provenance.transformationDigest === null;
  }
  // Derived artifacts MUST retain provenance (parent + transformation), authorization, AND a
  // retention binding.
  return (
    provenance.parentDigest !== null &&
    provenance.transformationDigest !== null &&
    retention !== null
  );
}
