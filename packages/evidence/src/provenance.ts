// @trustcircle/evidence — immutable provenance edges and signed ordered evidence manifests
// (Phase 36 / GAR-006 / VO-4aeb030a32c9deebdb3b / VO-c03b3c1cb5014d1b72e2 /
// VO-b9b935bf93be10bdecdd).
//
// Oracle (VO-4aeb030a32c9deebdb3b): Originals MUST remain immutable or tamper-evident; derived
// repairs, exports, redactions, and dispositions MUST retain provenance, integrity,
// authorization, retention, and access history.
//
// Where object-store.ts stores the immutable bytes and evidence-service.ts orchestrates
// original-first commits, THIS module is the tamper-evident LEDGER that binds those facts
// together over time:
//
//   1. IMMUTABLE PROVENANCE EDGES — every relationship "derived ← parent" (repair, export,
//      redaction, disposition) is recorded as an EDGE whose identity is the SHA-256 of its own
//      canonical body. Each appended edge chains to the hash of the previous edge in the ledger
//      (a hash chain), so the SEQUENCE is fixed and any insertion, deletion, reordering, or
//      field mutation is detectable. An edge retains, for the derived node: parent digest,
//      transformation digest, method, authorization, retention binding, classification, and the
//      count of access-history entries carried forward. Originals appear as root edges with a
//      null parent; an original edge, once appended, can never be re-parented (immutability).
//
//   2. SIGNED ORDERED EVIDENCE MANIFESTS — a manifest is a snapshot of an ordered set of
//      evidence entries. Entries are placed in a STABLE canonical order (by content digest),
//      an ordered Merkle root is computed over them, and the manifest header (tenant, count,
//      ordered leaf hashes, merkle root, prior-manifest hash) is HMAC-signed. The signature
//      makes the whole ordered set tamper-evident; recomputing the root and verifying the
//      signature detects any added/removed/reordered/altered entry. Manifests themselves chain
//      (each references the prior manifest hash) so the manifest history is also append-only.
//
// This module is dependency-free (Node built-in `crypto` only), deterministic (never reads the
// wall clock or randomness — all times are injected), and runs under Node 22
// `--experimental-strip-types`, so it is independently observable and testable under `npm ci`
// with no adjacent infrastructure.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { Authorization, EpochMillis } from './retention.ts';
import type { ContentDigest, ObjectRetention } from './object-store.ts';

// ---------------------------------------------------------------------------
// Canonical hashing helpers (shared with the rest of the evidence package).
// ---------------------------------------------------------------------------

/** Deterministic canonical JSON (recursively sorted keys, undefined dropped). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** Lowercase-hex SHA-256 over the canonical form of a value. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Constant-time compare of two lowercase-hex digests of equal length. */
export function hexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Provenance-node classification (which relationship an edge records).
// ---------------------------------------------------------------------------

/** The kind of provenance node an edge points AT. `original` edges are roots (no parent). */
export type ProvenanceNodeKind =
  'original' | 'derived' | 'repair' | 'export' | 'redaction' | 'disposition';

/** A node is a "root" (must have no parent) iff it is an original. */
export function isRootKind(kind: ProvenanceNodeKind): boolean {
  return kind === 'original';
}

// ---------------------------------------------------------------------------
// Immutable provenance edge.
// ---------------------------------------------------------------------------

/**
 * The signed/hashed body of a provenance edge. Every field is retained so that the oracle's
 * "derived … MUST retain provenance, integrity, authorization, retention, and access history"
 * is a structural property of the ledger, not a convention. The `edgeId` is the SHA-256 of this
 * body, and `previousEdgeHash` chains it to the prior edge in the ledger.
 */
export interface ProvenanceEdgeBody {
  /** Tenant that owns this edge (edges never cross tenants). */
  readonly tenantId: string;
  /** Monotonic position of this edge in its tenant ledger (0-based). */
  readonly sequence: number;
  /** Hash of the previous edge in the ledger; null only for sequence 0. */
  readonly previousEdgeHash: string | null;
  /** Kind of the node this edge records (original ⇒ root). */
  readonly nodeKind: ProvenanceNodeKind;
  /** Content address (integrity anchor) of the node this edge records. */
  readonly nodeDigest: ContentDigest;
  /** Content address of the parent this node derived from; null iff the node is an original. */
  readonly parentDigest: ContentDigest | null;
  /** Digest binding the transformation (redaction ruleset, export query, repair patch); null for originals. */
  readonly transformationDigest: ContentDigest | null;
  /** Human/audit label for how the node was produced. */
  readonly method: string;
  /** Sensitivity classification carried on the node. */
  readonly classification: string;
  /** Authorization under which the node was produced (principal + grant). */
  readonly authorization: Authorization;
  /** Retention binding carried by the node; null only for originals with no policy yet. */
  readonly retention: ObjectRetention | null;
  /** Number of access-history entries carried forward at edge-append time (never decreases). */
  readonly accessHistoryCount: number;
  /** When the edge was appended (injected; never wall-clock). */
  readonly recordedAt: EpochMillis;
}

/** A committed, hash-identified provenance edge. `edgeId === canonicalHash(body)`. */
export interface ProvenanceEdge extends ProvenanceEdgeBody {
  /** SHA-256 of the canonical edge body — the immutable identity of the edge. */
  readonly edgeId: string;
}

export type ProvenanceRejectionReason =
  | 'root-must-have-no-parent'
  | 'derived-must-have-parent'
  | 'parent-not-in-ledger'
  | 'tenant-mismatch'
  | 'duplicate-node'
  | 'missing-authorization'
  | 'derived-must-retain-transformation'
  | 'derived-must-retain-retention'
  | 'access-history-must-not-decrease';

export class ProvenanceError extends Error {
  readonly reason: ProvenanceRejectionReason;
  constructor(reason: ProvenanceRejectionReason, detail?: string) {
    super(`provenance edge rejected [${reason}]${detail ? `: ${detail}` : ''}`);
    this.name = 'ProvenanceError';
    this.reason = reason;
  }
}

/** Input for appending a new edge (identity + chaining are computed by the ledger). */
export interface AppendEdgeInput {
  readonly tenantId: string;
  readonly nodeKind: ProvenanceNodeKind;
  readonly nodeDigest: ContentDigest;
  readonly parentDigest: ContentDigest | null;
  readonly transformationDigest: ContentDigest | null;
  readonly method: string;
  readonly classification: string;
  readonly authorization: Authorization;
  readonly retention: ObjectRetention | null;
  readonly accessHistoryCount: number;
  readonly recordedAt: EpochMillis;
}

/**
 * Append-only, hash-chained provenance ledger for ONE tenant.
 *
 * Guarantees:
 *   - Root (original) edges MUST have no parent; derived edges MUST reference a parent digest
 *     that already exists as a node in the ledger (original-first ordering).
 *   - Each edge chains to the previous edge's hash, so the ORDER is fixed and any tampering
 *     (reorder/insert/delete/mutate) breaks `verify()`.
 *   - The same node digest can be recorded once (a node's provenance is immutable — you cannot
 *     re-parent an original, and you cannot silently overwrite an edge).
 *   - Derived nodes MUST retain a transformation digest and a retention binding; the carried
 *     access-history count may only grow.
 */
export class ProvenanceLedger {
  readonly #tenantId: string;
  readonly #edges: ProvenanceEdge[] = [];
  /** node digest → the (single) edge that recorded it. */
  readonly #byNode = new Map<ContentDigest, ProvenanceEdge>();

  constructor(tenantId: string) {
    this.#tenantId = tenantId;
  }

  get tenantId(): string {
    return this.#tenantId;
  }

  /** Number of edges appended so far. */
  get length(): number {
    return this.#edges.length;
  }

  /** Hash of the most recently appended edge, or null for an empty ledger (the head). */
  get headHash(): string | null {
    return this.#edges.length === 0 ? null : this.#edges[this.#edges.length - 1]!.edgeId;
  }

  /** A defensive copy of the ordered edge list. */
  edges(): readonly ProvenanceEdge[] {
    return this.#edges.slice();
  }

  /** The edge that recorded a given node digest, or null if the node is unknown here. */
  edgeForNode(nodeDigest: ContentDigest): ProvenanceEdge | null {
    return this.#byNode.get(nodeDigest) ?? null;
  }

  /**
   * Append a new immutable provenance edge. Enforces tenant, root/parent, original-first, and
   * retention/authorization/access-history invariants, then binds the edge into the hash chain.
   */
  append(input: AppendEdgeInput): ProvenanceEdge {
    if (input.tenantId !== this.#tenantId) {
      throw new ProvenanceError('tenant-mismatch', `${input.tenantId} != ${this.#tenantId}`);
    }
    if (!input.authorization || !input.authorization.principalId || !input.authorization.grantId) {
      throw new ProvenanceError('missing-authorization');
    }
    if (this.#byNode.has(input.nodeDigest)) {
      // A node's provenance is recorded once and is immutable thereafter.
      throw new ProvenanceError('duplicate-node', input.nodeDigest);
    }

    if (isRootKind(input.nodeKind)) {
      if (input.parentDigest !== null) {
        throw new ProvenanceError('root-must-have-no-parent', input.nodeDigest);
      }
    } else {
      if (input.parentDigest === null) {
        throw new ProvenanceError('derived-must-have-parent', input.nodeDigest);
      }
      // ORIGINAL-FIRST: the parent must already be recorded in this ledger.
      if (!this.#byNode.has(input.parentDigest)) {
        throw new ProvenanceError('parent-not-in-ledger', input.parentDigest);
      }
      if (input.transformationDigest === null) {
        throw new ProvenanceError('derived-must-retain-transformation', input.nodeDigest);
      }
      if (input.retention === null) {
        throw new ProvenanceError('derived-must-retain-retention', input.nodeDigest);
      }
      // Access history carried forward from parent may only grow through a derivation.
      const parentEdge = this.#byNode.get(input.parentDigest)!;
      if (input.accessHistoryCount < parentEdge.accessHistoryCount) {
        throw new ProvenanceError(
          'access-history-must-not-decrease',
          `${input.accessHistoryCount} < ${parentEdge.accessHistoryCount}`,
        );
      }
    }

    const body: ProvenanceEdgeBody = {
      tenantId: input.tenantId,
      sequence: this.#edges.length,
      previousEdgeHash: this.headHash,
      nodeKind: input.nodeKind,
      nodeDigest: input.nodeDigest,
      parentDigest: input.parentDigest,
      transformationDigest: input.transformationDigest,
      method: input.method,
      classification: input.classification,
      authorization: {
        principalId: input.authorization.principalId,
        grantId: input.authorization.grantId,
      },
      retention: input.retention,
      accessHistoryCount: input.accessHistoryCount,
      recordedAt: input.recordedAt,
    };
    const edge: ProvenanceEdge = { ...body, edgeId: canonicalHash(body) };
    this.#edges.push(edge);
    this.#byNode.set(edge.nodeDigest, edge);
    return edge;
  }

  /**
   * Walk from a node back to its original root within this tenant ledger, returning the ordered
   * edge chain [self, …, root]. Proves a derived node retains a reconstructable, tamper-evident
   * link to the immutable original. Throws if a referenced parent edge is missing.
   */
  provenanceChain(nodeDigest: ContentDigest): readonly ProvenanceEdge[] {
    const chain: ProvenanceEdge[] = [];
    const seen = new Set<string>();
    let current: ContentDigest | null = nodeDigest;
    while (current) {
      if (seen.has(current)) break; // impossible with content addresses, but guard anyway.
      seen.add(current);
      const edge = this.#byNode.get(current);
      if (!edge) throw new ProvenanceError('parent-not-in-ledger', current);
      chain.push(edge);
      current = edge.parentDigest;
    }
    return chain;
  }

  /**
   * Re-derive every edge's hash and chain link from scratch and confirm the ledger is intact.
   * Returns { valid:true } when the recomputed identities and previous-hash links match the
   * stored edges in order; otherwise the first broken edge and reason. This is the tamper check:
   * any mutation, reorder, insertion, or deletion is caught here.
   */
  verify(): ProvenanceVerifyResult {
    let previous: string | null = null;
    for (let i = 0; i < this.#edges.length; i++) {
      const edge = this.#edges[i]!;
      if (edge.sequence !== i) {
        return { valid: false, brokenAt: i, reason: 'sequence-mismatch' };
      }
      if ((edge.previousEdgeHash ?? null) !== (previous ?? null)) {
        return { valid: false, brokenAt: i, reason: 'chain-broken' };
      }
      const { edgeId, ...body } = edge;
      const recomputed = canonicalHash(body);
      if (!hexEqual(recomputed, edgeId)) {
        return { valid: false, brokenAt: i, reason: 'edge-hash-mismatch' };
      }
      previous = edgeId;
    }
    return { valid: true };
  }
}

export type ProvenanceBreakReason = 'sequence-mismatch' | 'chain-broken' | 'edge-hash-mismatch';

export type ProvenanceVerifyResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly brokenAt: number; readonly reason: ProvenanceBreakReason };

/**
 * Verify an arbitrary ordered array of edges (e.g. an exported ledger) without a live ledger
 * instance. Same tamper checks as ProvenanceLedger.verify().
 */
export function verifyEdgeChain(edges: readonly ProvenanceEdge[]): ProvenanceVerifyResult {
  let previous: string | null = null;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (edge.sequence !== i) return { valid: false, brokenAt: i, reason: 'sequence-mismatch' };
    if ((edge.previousEdgeHash ?? null) !== (previous ?? null)) {
      return { valid: false, brokenAt: i, reason: 'chain-broken' };
    }
    const { edgeId, ...body } = edge;
    if (!hexEqual(canonicalHash(body), edgeId)) {
      return { valid: false, brokenAt: i, reason: 'edge-hash-mismatch' };
    }
    previous = edgeId;
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Ordered Merkle root over evidence entries.
// ---------------------------------------------------------------------------

/** One evidence entry recorded in a manifest. */
export interface ManifestEntry {
  readonly evidenceId: string;
  readonly nodeKind: ProvenanceNodeKind;
  readonly contentDigest: ContentDigest;
  readonly parentDigest: ContentDigest | null;
  readonly classification: string;
  readonly recordedAt: EpochMillis;
}

/** Canonical leaf hash for a manifest entry (domain-separated with a 0x00 prefix). */
export function manifestLeafHash(entry: ManifestEntry): string {
  return createHash('sha256').update('\x00').update(canonicalJson(entry)).digest('hex');
}

/** Combine two child hashes into a parent node hash (domain-separated with a 0x01 prefix). */
function merkleParent(left: string, right: string): string {
  return createHash('sha256').update('\x01').update(left).update(right).digest('hex');
}

/**
 * Compute an ordered Merkle root over the given leaf hashes IN THE GIVEN ORDER. An empty list
 * hashes to the empty-tree sentinel. Odd nodes at a level are promoted (duplicated) upward. The
 * order is significant — reordering leaves changes the root, which is exactly what pins the
 * manifest's declared ordering.
 */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return createHash('sha256').update('\x02empty').digest('hex');
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(merkleParent(left, right));
    }
    level = next;
  }
  return level[0]!;
}

// ---------------------------------------------------------------------------
// Signed, ordered evidence manifest.
// ---------------------------------------------------------------------------

/** The signed header of a manifest — everything the signature covers. */
export interface EvidenceManifestHeader {
  readonly tenantId: string;
  /** Monotonic manifest number within the tenant (0-based). */
  readonly manifestSequence: number;
  /** Hash of the previous manifest in the chain; null for the first manifest. */
  readonly previousManifestHash: string | null;
  /** Number of entries in the manifest. */
  readonly entryCount: number;
  /** Ordered leaf hashes (stable canonical order), pinning the exact entry set + order. */
  readonly orderedLeafHashes: readonly string[];
  /** Ordered Merkle root over the leaf hashes. */
  readonly merkleRoot: string;
  /** When the manifest was sealed (injected; never wall-clock). */
  readonly sealedAt: EpochMillis;
  /** Principal that sealed the manifest. */
  readonly sealedBy: string;
}

/** A sealed manifest: its ordered entries, signed header, header hash, and signature. */
export interface EvidenceManifest {
  readonly header: EvidenceManifestHeader;
  /** Entries in the same stable order the leaf hashes/root were computed from. */
  readonly entries: readonly ManifestEntry[];
  /** SHA-256 over the canonical header — chains the manifest history and identifies it. */
  readonly headerHash: string;
  /** HMAC-SHA256 over the canonical header — makes the ordered set tamper-evident. */
  readonly signature: string;
}

/**
 * Stable canonical ordering of entries: primarily by contentDigest (a total order that is
 * independent of insertion order), tie-broken by evidenceId. Deterministic and reproducible.
 */
export function orderEntries(entries: readonly ManifestEntry[]): readonly ManifestEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.contentDigest !== b.contentDigest) return a.contentDigest < b.contentDigest ? -1 : 1;
    return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
  });
}

function signHeader(header: EvidenceManifestHeader, signingKey: string): string {
  return createHmac('sha256', signingKey).update(canonicalJson(header)).digest('hex');
}

export interface SealManifestInput {
  readonly tenantId: string;
  readonly manifestSequence: number;
  readonly previousManifestHash: string | null;
  readonly entries: readonly ManifestEntry[];
  readonly sealedAt: EpochMillis;
  readonly sealedBy: string;
  readonly signingKey: string;
}

/**
 * Seal a set of evidence entries into a signed, ordered manifest. Entries are placed in stable
 * canonical order, an ordered Merkle root is computed, and the header is HMAC-signed. The
 * resulting manifest is tamper-evident: any added/removed/reordered/altered entry changes the
 * ordered leaf hashes and root, and any header edit invalidates the signature.
 */
export function sealManifest(input: SealManifestInput): EvidenceManifest {
  const ordered = orderEntries(input.entries);
  const orderedLeafHashes = ordered.map(manifestLeafHash);
  const root = merkleRoot(orderedLeafHashes);
  const header: EvidenceManifestHeader = {
    tenantId: input.tenantId,
    manifestSequence: input.manifestSequence,
    previousManifestHash: input.previousManifestHash,
    entryCount: ordered.length,
    orderedLeafHashes,
    merkleRoot: root,
    sealedAt: input.sealedAt,
    sealedBy: input.sealedBy,
  };
  return {
    header,
    entries: ordered,
    headerHash: canonicalHash(header),
    signature: signHeader(header, input.signingKey),
  };
}

export type ManifestBreakReason =
  | 'header-hash-mismatch'
  | 'signature-mismatch'
  | 'entry-count-mismatch'
  | 'leaf-hash-mismatch'
  | 'ordering-mismatch'
  | 'merkle-root-mismatch';

export type ManifestVerifyResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: ManifestBreakReason };

/**
 * Independently verify a sealed manifest: recompute the header hash, the ordered leaf hashes
 * (in the manifest's declared entry order), the Merkle root, and the HMAC signature, and
 * confirm each matches. Any tampering with the entries, their order, the header, or the
 * signature is detected. Signature check is constant-time.
 */
export function verifyManifest(
  manifest: EvidenceManifest,
  signingKey: string,
): ManifestVerifyResult {
  const { header, entries } = manifest;

  if (!hexEqual(canonicalHash(header), manifest.headerHash)) {
    return { valid: false, reason: 'header-hash-mismatch' };
  }
  if (
    entries.length !== header.entryCount ||
    header.orderedLeafHashes.length !== header.entryCount
  ) {
    return { valid: false, reason: 'entry-count-mismatch' };
  }
  // Entries MUST be in the declared stable canonical order.
  const ordered = orderEntries(entries);
  for (let i = 0; i < entries.length; i++) {
    if (
      entries[i]!.contentDigest !== ordered[i]!.contentDigest ||
      entries[i]!.evidenceId !== ordered[i]!.evidenceId
    ) {
      return { valid: false, reason: 'ordering-mismatch' };
    }
  }
  // Recompute leaf hashes over the entries and compare to the header's declared leaves.
  for (let i = 0; i < entries.length; i++) {
    if (!hexEqual(manifestLeafHash(entries[i]!), header.orderedLeafHashes[i]!)) {
      return { valid: false, reason: 'leaf-hash-mismatch' };
    }
  }
  if (!hexEqual(merkleRoot(header.orderedLeafHashes), header.merkleRoot)) {
    return { valid: false, reason: 'merkle-root-mismatch' };
  }
  const expectedSig = signHeader(header, signingKey);
  if (!hexEqual(expectedSig, manifest.signature)) {
    return { valid: false, reason: 'signature-mismatch' };
  }
  return { valid: true };
}

/**
 * Verify that a manifest sequence forms an intact chain: each manifest's previousManifestHash
 * equals the prior manifest's headerHash, sequences are contiguous, and every manifest verifies
 * under the signing key. Proves the manifest HISTORY is append-only and tamper-evident.
 */
export function verifyManifestChain(
  manifests: readonly EvidenceManifest[],
  signingKey: string,
): {
  readonly valid: boolean;
  readonly brokenAt?: number;
  readonly reason?: ManifestBreakReason | 'chain-broken' | 'sequence-mismatch';
} {
  let previousHeaderHash: string | null = null;
  for (let i = 0; i < manifests.length; i++) {
    const m = manifests[i]!;
    if (m.header.manifestSequence !== i)
      return { valid: false, brokenAt: i, reason: 'sequence-mismatch' };
    if ((m.header.previousManifestHash ?? null) !== (previousHeaderHash ?? null)) {
      return { valid: false, brokenAt: i, reason: 'chain-broken' };
    }
    const res = verifyManifest(m, signingKey);
    if (!res.valid) return { valid: false, brokenAt: i, reason: res.reason };
    previousHeaderHash = m.headerHash;
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Bridge: seal a manifest directly from a provenance ledger.
// ---------------------------------------------------------------------------

/**
 * Project a provenance ledger's edges into manifest entries (one per recorded node) and seal a
 * signed, ordered manifest over them. The manifest thus attests, in tamper-evident form, the
 * exact ordered set of originals + derived artifacts the ledger has recorded.
 */
export function sealManifestFromLedger(
  ledger: ProvenanceLedger,
  opts: {
    readonly manifestSequence: number;
    readonly previousManifestHash: string | null;
    readonly sealedAt: EpochMillis;
    readonly sealedBy: string;
    readonly signingKey: string;
  },
): EvidenceManifest {
  const entries: ManifestEntry[] = ledger.edges().map((edge) => ({
    evidenceId: edge.edgeId,
    nodeKind: edge.nodeKind,
    contentDigest: edge.nodeDigest,
    parentDigest: edge.parentDigest,
    classification: edge.classification,
    recordedAt: edge.recordedAt,
  }));
  return sealManifest({
    tenantId: ledger.tenantId,
    manifestSequence: opts.manifestSequence,
    previousManifestHash: opts.previousManifestHash,
    entries,
    sealedAt: opts.sealedAt,
    sealedBy: opts.sealedBy,
    signingKey: opts.signingKey,
  });
}
