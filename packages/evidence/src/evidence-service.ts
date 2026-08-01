// @trustcircle/evidence — original-first evidence commits, digest verification, tenant
// namespaces, and classification checks (Phase 35 / GAR-006 /
// VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 / VO-4aeb030a32c9deebdb3b).
//
// Oracle (VO-b9b935bf93be10bdecdd): Originals MUST remain immutable or tamper-evident;
// derived repairs, exports, redactions, and dispositions MUST retain provenance, integrity,
// authorization, retention, and access history.
//
// This service is the write/read seam over the content-addressed immutable object store
// (object-store.ts) and the retention/legal-hold/disposition engine (retention.ts). It layers
// on the four responsibilities named by the phase spec:
//
//   1. ORIGINAL-FIRST COMMITS — a derived artifact (repair/export/redaction) can only be
//      committed AFTER its parent original already exists in the store, and the parent must be
//      the original the derived artifact declares as provenance. This makes "the original is
//      preserved before any change" a checked invariant, not a convention.
//   2. DIGEST VERIFICATION — every commit recomputes the SHA-256 content address; if the
//      caller supplies an expected digest it MUST match, and every read re-verifies integrity.
//      A mismatch is a hard tamper failure, never a silent overwrite.
//   3. TENANT NAMESPACES — all keys are namespaced by tenant. A read/write/derive/dispose for
//      tenant A can never observe or attach to tenant B's evidence, even if the raw content
//      digests happen to collide. Cross-tenant access is refused, not silently empty.
//   4. CLASSIFICATION CHECKS — an item classified as quarantined/unsafe is committed and
//      remains visible & inspectable to authorized readers, but is BLOCKED from being used as
//      a derivation parent (no execution/repair off a quarantined original). A derived
//      artifact may never widen (down-classify) the sensitivity of its parent.
//
// Dependency-free beyond the sibling evidence modules and Node built-in `crypto`, so it is
// independently observable and testable under `npm ci` with no adjacent infrastructure, and
// runs under Node 22 `--experimental-strip-types`.

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  InMemoryImmutableObjectStore,
  contentAddress,
  type ContentAddressedObjectStore,
  type ContentDigest,
  type GetResult,
  type ObjectKind,
  type ObjectMetadata,
  type ObjectRetention,
  type Provenance,
  type StoredObject,
} from './object-store.ts';

import {
  evaluateDisposition,
  recordDisposition,
  type Authorization,
  type DispositionMethod,
  type DispositionRecord,
  type EpochMillis,
  type EvidenceItem,
  type LegalHold,
  type RetentionPolicy,
} from './retention.ts';

// ---------------------------------------------------------------------------
// Classification model.
// ---------------------------------------------------------------------------

/**
 * Sensitivity ordering (low → high). A derived artifact may never be LESS sensitive than its
 * parent (no down-classification through a derivation), so ordering is meaningful.
 */
export const CLASSIFICATION_ORDER = ['public', 'internal', 'sensitive', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATION_ORDER)[number];

function classificationRank(c: string): number {
  const i = (CLASSIFICATION_ORDER as readonly string[]).indexOf(c);
  return i < 0 ? CLASSIFICATION_ORDER.length : i; // unknown ⇒ treated as most sensitive.
}

/**
 * Execution disposition of an item. `quarantined` items are visible and inspectable to
 * authorized users but MUST NOT drive execution or serve as a derivation parent.
 */
export type ExecutionState = 'active' | 'quarantined';

// ---------------------------------------------------------------------------
// Service-level errors — every refusal is first-class so callers can react.
// ---------------------------------------------------------------------------

export type CommitRejectionReason =
  | 'digest-mismatch'
  | 'tenant-mismatch'
  | 'original-must-have-no-parent'
  | 'derived-must-have-parent'
  | 'parent-not-found'
  | 'parent-tenant-mismatch'
  | 'parent-quarantined'
  | 'derived-cannot-downclassify'
  | 'unknown-classification'
  | 'missing-authorization'
  | 'derived-requires-retention';

export class EvidenceCommitError extends Error {
  readonly reason: CommitRejectionReason;
  constructor(reason: CommitRejectionReason, detail?: string) {
    super(`evidence commit rejected [${reason}]${detail ? `: ${detail}` : ''}`);
    this.name = 'EvidenceCommitError';
    this.reason = reason;
  }
}

export type AccessRejectionReason = 'not-found' | 'tenant-mismatch';

export class EvidenceAccessError extends Error {
  readonly reason: AccessRejectionReason;
  constructor(reason: AccessRejectionReason, detail?: string) {
    super(`evidence access rejected [${reason}]${detail ? `: ${detail}` : ''}`);
    this.name = 'EvidenceAccessError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Commit inputs / outputs.
// ---------------------------------------------------------------------------

/** A tenant-namespaced content address: no two tenants can collide on the same handle. */
export interface EvidenceHandle {
  readonly tenantId: string;
  readonly digest: ContentDigest;
}

/** Handle equality / string form so handles are comparable and loggable. */
export function handleKey(h: EvidenceHandle): string {
  return `${h.tenantId}::${h.digest}`;
}

export interface CommitOriginalInput {
  readonly tenantId: string;
  readonly content: Uint8Array;
  readonly classification: string;
  readonly authorization: Authorization;
  readonly now: EpochMillis;
  /** Optional caller-declared address; MUST match the recomputed digest if present. */
  readonly expectedDigest?: ContentDigest;
  /** WORM retention binding for the original (COMPLIANCE = un-bypassable). */
  readonly retention?: ObjectRetention;
  /** Classified quarantined ⇒ inspectable but blocked from execution / derivation. */
  readonly execution?: ExecutionState;
}

export interface CommitDerivedInput {
  readonly tenantId: string;
  readonly parent: EvidenceHandle;
  /** repair | export | redaction | derived — never 'original'. */
  readonly kind: Exclude<ObjectKind, 'original'>;
  readonly content: Uint8Array;
  readonly classification: string;
  readonly authorization: Authorization;
  readonly now: EpochMillis;
  readonly expectedDigest?: ContentDigest;
  /** Derived artifacts MUST carry a retention binding (oracle: derived retains retention). */
  readonly retention: ObjectRetention;
  /** Digest binding the transformation (redaction ruleset, export query, repair patch). */
  readonly transformationDigest: ContentDigest;
}

export interface CommitResult {
  readonly handle: EvidenceHandle;
  readonly versionId: string;
  /** True when the identical bytes already existed for this tenant (idempotent). */
  readonly deduplicated: boolean;
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

/**
 * Original-first evidence service over an immutable, content-addressed object store.
 *
 * Tenant namespacing is enforced by keying every object as `${tenantId}::${digest}` inside a
 * per-tenant store partition. The store guarantees originals are immutable/tamper-evident and
 * that every read re-verifies integrity; this service adds original-first ordering,
 * classification/quarantine gating, and no-down-classification for derived artifacts.
 */
export class EvidenceService {
  /** One immutable store partition per tenant ⇒ hard cross-tenant isolation. */
  readonly #partitions = new Map<string, ContentAddressedObjectStore>();
  /** Execution state (active/quarantined) per handle. Quarantine is inspectable, not deletable. */
  readonly #execution = new Map<string, ExecutionState>();
  readonly #newStore: () => ContentAddressedObjectStore;

  constructor(newStore: () => ContentAddressedObjectStore = () => new InMemoryImmutableObjectStore()) {
    this.#newStore = newStore;
  }

  #partition(tenantId: string): ContentAddressedObjectStore {
    let store = this.#partitions.get(tenantId);
    if (!store) {
      store = this.#newStore();
      this.#partitions.set(tenantId, store);
    }
    return store;
  }

  // -------------------------------------------------------------------------
  // ORIGINAL-FIRST COMMIT — originals.
  // -------------------------------------------------------------------------

  /**
   * Commit a raw ORIGINAL. Originals have no provenance parent and are stored WORM. Digest is
   * recomputed and (if declared) verified; classification must be known; authorization is
   * mandatory. A quarantined classification is honoured — the original is committed and stays
   * inspectable but is marked non-executable.
   */
  commitOriginal(input: CommitOriginalInput): CommitResult {
    this.#requireAuthorization(input.authorization);
    this.#requireKnownClassification(input.classification);

    const digest = contentAddress(input.content);
    if (input.expectedDigest !== undefined && !digestEquals(input.expectedDigest, digest)) {
      throw new EvidenceCommitError('digest-mismatch', `${input.expectedDigest} != ${digest}`);
    }

    const provenance: Provenance = {
      parentDigest: null,
      method: 'capture',
      transformationDigest: null,
    };
    const metadata: ObjectMetadata = {
      tenantId: input.tenantId,
      kind: 'original',
      classification: input.classification,
      provenance,
      authorization: input.authorization,
      retention: input.retention ?? null,
      createdAt: input.now,
    };

    const store = this.#partition(input.tenantId);
    const put = store.put({
      content: input.content,
      metadata,
      by: input.authorization,
      now: input.now,
      expectedDigest: digest,
    });

    const handle: EvidenceHandle = { tenantId: input.tenantId, digest: put.digest };
    // First commit wins for execution state; a re-commit (dedup) never silently un-quarantines.
    if (!this.#execution.has(handleKey(handle))) {
      this.#execution.set(handleKey(handle), input.execution ?? 'active');
    }
    return { handle, versionId: put.versionId, deduplicated: put.deduplicated };
  }

  // -------------------------------------------------------------------------
  // ORIGINAL-FIRST COMMIT — derived artifacts.
  // -------------------------------------------------------------------------

  /**
   * Commit a DERIVED artifact (repair/export/redaction/derived). Enforces original-first
   * ordering: the declared parent MUST already exist in the SAME tenant partition, must not be
   * quarantined, and the derived classification may not be LESS sensitive than the parent's.
   * The parent original is never mutated. Provenance (parent digest + transformation digest),
   * authorization, and retention are all retained on the derived object.
   */
  commitDerived(input: CommitDerivedInput): CommitResult {
    this.#requireAuthorization(input.authorization);
    this.#requireKnownClassification(input.classification);

    if (input.parent.tenantId !== input.tenantId) {
      throw new EvidenceCommitError('parent-tenant-mismatch', handleKey(input.parent));
    }

    // ORIGINAL-FIRST: the parent must already exist in this tenant's partition.
    const parent = this.tryHead(input.parent, input.authorization, input.now);
    if (!parent) {
      throw new EvidenceCommitError('parent-not-found', handleKey(input.parent));
    }

    // CLASSIFICATION: a quarantined parent cannot be a derivation source.
    if (this.executionState(input.parent) === 'quarantined') {
      throw new EvidenceCommitError('parent-quarantined', handleKey(input.parent));
    }
    // CLASSIFICATION: no down-classification through a derivation.
    if (classificationRank(input.classification) < classificationRank(parent.metadata.classification)) {
      throw new EvidenceCommitError(
        'derived-cannot-downclassify',
        `${input.classification} < ${parent.metadata.classification}`,
      );
    }

    const digest = contentAddress(input.content);
    if (input.expectedDigest !== undefined && !digestEquals(input.expectedDigest, digest)) {
      throw new EvidenceCommitError('digest-mismatch', `${input.expectedDigest} != ${digest}`);
    }

    const provenance: Provenance = {
      parentDigest: input.parent.digest,
      method: input.kind,
      transformationDigest: input.transformationDigest,
    };
    const metadata: ObjectMetadata = {
      tenantId: input.tenantId,
      kind: input.kind,
      classification: input.classification,
      provenance,
      authorization: input.authorization,
      retention: input.retention, // required for derived — retained per oracle.
      createdAt: input.now,
    };

    const store = this.#partition(input.tenantId);
    const put = store.put({
      content: input.content,
      metadata,
      by: input.authorization,
      now: input.now,
      expectedDigest: digest,
    });

    const handle: EvidenceHandle = { tenantId: input.tenantId, digest: put.digest };
    if (!this.#execution.has(handleKey(handle))) this.#execution.set(handleKey(handle), 'active');
    return { handle, versionId: put.versionId, deduplicated: put.deduplicated };
  }

  // -------------------------------------------------------------------------
  // DIGEST VERIFICATION + tenant-scoped reads.
  // -------------------------------------------------------------------------

  /**
   * Read content + metadata by tenant-namespaced handle. The store re-verifies the content
   * address on read, so a corrupted body raises rather than returning bad bytes. Cross-tenant
   * handles are refused. Quarantined items ARE readable (visible & inspectable).
   */
  get(handle: EvidenceHandle, by: Authorization, now: EpochMillis): GetResult {
    const store = this.#partitions.get(handle.tenantId);
    if (!store || !store.exists(handle.digest)) {
      throw new EvidenceAccessError('not-found', handleKey(handle));
    }
    const result = store.get(handle.digest, by, now);
    // Defence in depth: never hand back an object whose stored tenant differs from the handle.
    if (result.object.metadata.tenantId !== handle.tenantId) {
      throw new EvidenceAccessError('tenant-mismatch', handleKey(handle));
    }
    return result;
  }

  /** Metadata-only read (records access); throws if absent/cross-tenant. */
  head(handle: EvidenceHandle, by: Authorization, now: EpochMillis): StoredObject {
    const found = this.tryHead(handle, by, now);
    if (!found) throw new EvidenceAccessError('not-found', handleKey(handle));
    return found;
  }

  /** Metadata-only read that returns null instead of throwing when absent in-tenant. */
  tryHead(handle: EvidenceHandle, by: Authorization, now: EpochMillis): StoredObject | null {
    const store = this.#partitions.get(handle.tenantId);
    if (!store || !store.exists(handle.digest)) return null;
    const object = store.head(handle.digest, by, now);
    if (object.metadata.tenantId !== handle.tenantId) return null;
    return object;
  }

  /** True iff this exact content exists FOR THIS TENANT (tenant-namespaced existence). */
  exists(handle: EvidenceHandle): boolean {
    const store = this.#partitions.get(handle.tenantId);
    return store ? store.exists(handle.digest) : false;
  }

  /**
   * Recompute the content address of `content` and constant-time-compare it to the handle's
   * digest. Independent digest verification a caller can run without trusting the store.
   */
  verifyDigest(handle: EvidenceHandle, content: Uint8Array): boolean {
    return digestEquals(contentAddress(content), handle.digest);
  }

  // -------------------------------------------------------------------------
  // Classification / quarantine.
  // -------------------------------------------------------------------------

  /** Current execution state for a committed handle ('active' if unknown/absent). */
  executionState(handle: EvidenceHandle): ExecutionState {
    return this.#execution.get(handleKey(handle)) ?? 'active';
  }

  /**
   * Quarantine a committed item from execution. It remains fully readable/inspectable but can
   * no longer serve as a derivation parent. Idempotent.
   */
  quarantine(handle: EvidenceHandle): void {
    if (!this.exists(handle)) throw new EvidenceAccessError('not-found', handleKey(handle));
    this.#execution.set(handleKey(handle), 'quarantined');
  }

  /** True iff the item may drive execution / derivation (exists & not quarantined). */
  isExecutable(handle: EvidenceHandle): boolean {
    return this.exists(handle) && this.executionState(handle) === 'active';
  }

  // -------------------------------------------------------------------------
  // Provenance walk — reconstruct the derived → original chain.
  // -------------------------------------------------------------------------

  /**
   * Walk the provenance chain from a derived handle up to its original within the same tenant.
   * Returns the ordered chain [self, …, original]. Proves derived artifacts retain a
   * reconstructable link to the immutable original.
   */
  provenanceChain(handle: EvidenceHandle, by: Authorization, now: EpochMillis): readonly StoredObject[] {
    const chain: StoredObject[] = [];
    const seen = new Set<string>();
    let current: EvidenceHandle | null = handle;
    while (current) {
      const key = handleKey(current);
      if (seen.has(key)) break; // cycle guard (should never happen with content addresses).
      seen.add(key);
      const object = this.tryHead(current, by, now);
      if (!object) throw new EvidenceAccessError('not-found', key);
      chain.push(object);
      const parentDigest = object.metadata.provenance.parentDigest;
      current = parentDigest ? { tenantId: handle.tenantId, digest: parentDigest } : null;
    }
    return chain;
  }

  // -------------------------------------------------------------------------
  // DISPOSITION — delegated to the signed-record engine, tenant-checked.
  // -------------------------------------------------------------------------

  /**
   * Produce a signed disposition record for an item, ONLY when retention has elapsed, no legal
   * hold is active, and it is authorized. The parent original itself is never mutated by a
   * disposition of a derived artifact. Delegates the actual eligibility + signing to
   * retention.ts so the tamper-evident record format is shared.
   */
  disposeEvidence(input: {
    readonly handle: EvidenceHandle;
    readonly item: EvidenceItem;
    readonly policies: readonly RetentionPolicy[];
    readonly holds: readonly LegalHold[];
    readonly authorization: Authorization;
    readonly method: DispositionMethod;
    readonly executedBy: string;
    readonly signingKey: string;
    readonly now: EpochMillis;
  }): DispositionRecord {
    if (input.item.tenantId !== input.handle.tenantId) {
      throw new EvidenceAccessError('tenant-mismatch', handleKey(input.handle));
    }
    const object = this.tryHead(input.handle, input.authorization, input.now);
    if (!object) throw new EvidenceAccessError('not-found', handleKey(input.handle));
    return recordDisposition({
      item: input.item,
      policies: input.policies,
      holds: input.holds,
      authorization: input.authorization,
      now: input.now,
      method: input.method,
      executedBy: input.executedBy,
      accessHistory: object.accessHistory.map((a) => ({
        principalId: a.principalId,
        action: a.action,
        at: a.at,
      })),
      signingKey: input.signingKey,
    });
  }

  /** Whether an item may currently be disposed (no mutation). Convenience over retention.ts. */
  canDispose(input: {
    readonly item: EvidenceItem;
    readonly policies: readonly RetentionPolicy[];
    readonly holds: readonly LegalHold[];
    readonly authorization: Authorization | null;
    readonly now: EpochMillis;
  }): boolean {
    return evaluateDisposition(input).eligible;
  }

  // -------------------------------------------------------------------------
  // Guards.
  // -------------------------------------------------------------------------

  #requireAuthorization(auth: Authorization): void {
    if (!auth || !auth.principalId || !auth.grantId) {
      throw new EvidenceCommitError('missing-authorization');
    }
  }

  #requireKnownClassification(classification: string): void {
    if (!(CLASSIFICATION_ORDER as readonly string[]).includes(classification)) {
      throw new EvidenceCommitError('unknown-classification', classification);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helper (exported so tests observe digest verification directly).
// ---------------------------------------------------------------------------

/** Constant-time compare of two lowercase-hex SHA-256 digests. */
export function digestEquals(a: ContentDigest, b: ContentDigest): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Recompute the content address (SHA-256) of some bytes — re-exported for callers/tests. */
export function evidenceDigest(content: Uint8Array): ContentDigest {
  return createHash('sha256').update(content).digest('hex');
}
