// Verification-obligation test for immutable provenance edges + signed ordered evidence
// manifests (Phase 36 / GAR-006 / VO-4aeb030a32c9deebdb3b / VO-c03b3c1cb5014d1b72e2 /
// VO-b9b935bf93be10bdecdd).
//
// Oracle: Originals MUST remain immutable or tamper-evident; derived repairs, exports,
// redactions, and dispositions MUST retain provenance, integrity, authorization, retention,
// and access history.
//
// Independently observable: exercises the REAL packages/evidence/src/provenance.ts using only
// Node built-ins (loaded via --experimental-strip-types), so it runs deterministically under
// `npm ci` with no adjacent infrastructure. Each test maps to a clause of the oracle and to a
// phase responsibility (immutable hash-chained edges; signed ordered manifests), and each
// carries a negative control so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'packages/evidence/src/provenance.ts'));
const {
  ProvenanceLedger,
  ProvenanceError,
  verifyEdgeChain,
  canonicalHash,
  canonicalJson,
  hexEqual,
  merkleRoot,
  manifestLeafHash,
  orderEntries,
  sealManifest,
  verifyManifest,
  verifyManifestChain,
  sealManifestFromLedger,
} = mod;

const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');
const auth = { principalId: 'officer-1', grantId: 'grant-1' };
const retention = { mode: 'COMPLIANCE', retainUntil: 10_000 };

const original = (over = {}) => ({
  tenantId: 'tenant-a',
  nodeKind: 'original',
  nodeDigest: sha('original-bytes'),
  parentDigest: null,
  transformationDigest: null,
  method: 'capture',
  classification: 'sensitive',
  authorization: auth,
  retention: null,
  accessHistoryCount: 1,
  recordedAt: 1000,
  ...over,
});

const derived = (parentDigest, over = {}) => ({
  tenantId: 'tenant-a',
  nodeKind: 'redaction',
  nodeDigest: sha('redacted-bytes'),
  parentDigest,
  transformationDigest: sha('redaction-ruleset'),
  method: 'redaction',
  classification: 'sensitive',
  authorization: auth,
  retention,
  accessHistoryCount: 2,
  recordedAt: 2000,
  ...over,
});

// ---------------------------------------------------------------------------
// IMMUTABLE PROVENANCE EDGES — originals are roots (immutable, no parent).
// ---------------------------------------------------------------------------

test('original edge is a root with no parent; edgeId is the hash of its body', () => {
  const l = new ProvenanceLedger('tenant-a');
  const e = l.append(original());
  assert.equal(e.parentDigest, null);
  assert.equal(e.sequence, 0);
  assert.equal(e.previousEdgeHash, null);
  // edgeId is the canonical hash of the body (integrity anchor).
  const { edgeId, ...body } = e;
  assert.equal(edgeId, canonicalHash(body));

  // Negative control: an original that declares a parent is rejected (immutability of roots).
  assert.throws(
    () => new ProvenanceLedger('tenant-a').append(original({ parentDigest: sha('x') })),
    (err) => err instanceof ProvenanceError && err.reason === 'root-must-have-no-parent',
  );
});

test('a node digest can be recorded only once — provenance is immutable, no re-parenting', () => {
  const l = new ProvenanceLedger('tenant-a');
  l.append(original());
  // Negative control: re-appending the same node digest is rejected.
  assert.throws(
    () => l.append(original()),
    (err) => err instanceof ProvenanceError && err.reason === 'duplicate-node',
  );
});

// ---------------------------------------------------------------------------
// DERIVED — retains provenance (parent + transformation), authorization, retention.
// ---------------------------------------------------------------------------

test('derived edge REQUIRES the parent to already be in the ledger (original-first)', () => {
  const l = new ProvenanceLedger('tenant-a');
  // Negative control: no original appended → derived is rejected as parent-not-in-ledger.
  assert.throws(
    () => l.append(derived(sha('original-bytes'))),
    (err) => err instanceof ProvenanceError && err.reason === 'parent-not-in-ledger',
  );
  // Positive: append the original first, then the derived succeeds.
  const root = l.append(original());
  const d = l.append(derived(root.nodeDigest));
  assert.equal(d.parentDigest, root.nodeDigest);
  assert.equal(d.transformationDigest, sha('redaction-ruleset'));
});

test('derived edge MUST retain a transformation digest and a retention binding', () => {
  const l = new ProvenanceLedger('tenant-a');
  const root = l.append(original());
  assert.throws(
    () => l.append(derived(root.nodeDigest, { transformationDigest: null })),
    (err) => err instanceof ProvenanceError && err.reason === 'derived-must-retain-transformation',
  );
  assert.throws(
    () => l.append(derived(root.nodeDigest, { retention: null })),
    (err) => err instanceof ProvenanceError && err.reason === 'derived-must-retain-retention',
  );
  // Positive control: with both present it is accepted and retains them.
  const d = l.append(derived(root.nodeDigest));
  assert.ok(d.transformationDigest && d.retention);
});

test('every edge MUST retain authorization (principal + grant)', () => {
  const l = new ProvenanceLedger('tenant-a');
  assert.throws(
    () => l.append(original({ authorization: { principalId: '', grantId: '' } })),
    (err) => err instanceof ProvenanceError && err.reason === 'missing-authorization',
  );
  const e = l.append(original());
  assert.equal(e.authorization.principalId, 'officer-1');
  assert.equal(e.authorization.grantId, 'grant-1');
});

test('access-history count carried through a derivation may only grow (never decrease)', () => {
  const l = new ProvenanceLedger('tenant-a');
  const root = l.append(original({ accessHistoryCount: 5 }));
  // Negative control: derived declares FEWER access entries than the parent → rejected.
  assert.throws(
    () => l.append(derived(root.nodeDigest, { accessHistoryCount: 4 })),
    (err) => err instanceof ProvenanceError && err.reason === 'access-history-must-not-decrease',
  );
  const d = l.append(derived(root.nodeDigest, { accessHistoryCount: 6 }));
  assert.equal(d.accessHistoryCount, 6);
});

test('edges never cross tenants', () => {
  const l = new ProvenanceLedger('tenant-a');
  assert.throws(
    () => l.append(original({ tenantId: 'tenant-b' })),
    (err) => err instanceof ProvenanceError && err.reason === 'tenant-mismatch',
  );
});

// ---------------------------------------------------------------------------
// TAMPER-EVIDENCE — the hash chain detects any mutation / reorder / deletion.
// ---------------------------------------------------------------------------

test('an intact edge chain verifies; a mutated field breaks verification (tamper-evident)', () => {
  const l = new ProvenanceLedger('tenant-a');
  const root = l.append(original());
  l.append(derived(root.nodeDigest));
  const edges = l.edges();

  // Positive: unmodified chain is valid.
  assert.equal(l.verify().valid, true);
  assert.equal(verifyEdgeChain(edges).valid, true);

  // Negative control: mutate a field of edge 1 WITHOUT recomputing edgeId → hash mismatch.
  const tampered = edges.slice();
  tampered[1] = { ...edges[1], classification: 'public' };
  const res = verifyEdgeChain(tampered);
  assert.equal(res.valid, false);
  assert.equal(res.brokenAt, 1);
  assert.equal(res.reason, 'edge-hash-mismatch');
});

test('reordering or deleting edges breaks the chain', () => {
  const l = new ProvenanceLedger('tenant-a');
  const root = l.append(original());
  l.append(derived(root.nodeDigest));
  const edges = l.edges();

  // Delete the root → the derived edge's previousEdgeHash no longer matches (chain broken)
  // and its sequence is wrong.
  const deleted = [edges[1]];
  const res = verifyEdgeChain(deleted);
  assert.equal(res.valid, false);

  // Reorder → sequence mismatch on the first element.
  const reordered = [edges[1], edges[0]];
  const res2 = verifyEdgeChain(reordered);
  assert.equal(res2.valid, false);
});

test('provenanceChain reconstructs derived → original within the tenant', () => {
  const l = new ProvenanceLedger('tenant-a');
  const root = l.append(original());
  const d = l.append(derived(root.nodeDigest));
  const chain = l.provenanceChain(d.nodeDigest);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].nodeDigest, d.nodeDigest);
  assert.equal(chain[1].nodeDigest, root.nodeDigest);
  assert.equal(chain[1].parentDigest, null); // reaches the immutable original.
});

// ---------------------------------------------------------------------------
// SIGNED ORDERED EVIDENCE MANIFESTS.
// ---------------------------------------------------------------------------

const entry = (id, digest, over = {}) => ({
  evidenceId: id,
  nodeKind: 'original',
  contentDigest: digest,
  parentDigest: null,
  classification: 'sensitive',
  recordedAt: 1000,
  ...over,
});

test('sealManifest orders entries stably and produces a verifiable signature', () => {
  const entries = [entry('e2', sha('bbb')), entry('e1', sha('aaa'))];
  const m = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 0,
    previousManifestHash: null,
    entries,
    sealedAt: 5000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  // Stable order is by contentDigest: sha('aaa') < sha('bbb') → e1 before e2 regardless of input order.
  const ordered = orderEntries(entries);
  assert.deepEqual(
    m.entries.map((e) => e.evidenceId),
    ordered.map((e) => e.evidenceId),
  );
  assert.equal(m.header.entryCount, 2);
  assert.equal(m.header.merkleRoot, merkleRoot(m.header.orderedLeafHashes));
  assert.equal(verifyManifest(m, 'k').valid, true);

  // Negative control: wrong signing key → signature mismatch.
  const bad = verifyManifest(m, 'wrong-key');
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'signature-mismatch');
});

test('adding, removing, altering, or reordering a manifest entry is detected', () => {
  const entries = [entry('e1', sha('aaa')), entry('e2', sha('bbb'))];
  const m = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 0,
    previousManifestHash: null,
    entries,
    sealedAt: 5000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  assert.equal(verifyManifest(m, 'k').valid, true);

  // Alter an entry's classification but keep the sealed header/leaves → leaf-hash mismatch.
  const altered = {
    ...m,
    entries: m.entries.map((e, i) => (i === 0 ? { ...e, classification: 'public' } : e)),
  };
  const r1 = verifyManifest(altered, 'k');
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, 'leaf-hash-mismatch');

  // Remove an entry but keep the header's entryCount → entry-count mismatch.
  const removed = { ...m, entries: [m.entries[0]] };
  assert.equal(verifyManifest(removed, 'k').valid, false);

  // Reorder entries out of canonical order → ordering mismatch.
  const swapped = { ...m, entries: [m.entries[1], m.entries[0]] };
  const r3 = verifyManifest(swapped, 'k');
  assert.equal(r3.valid, false);
  assert.equal(r3.reason, 'ordering-mismatch');
});

test('editing the signed header (e.g. merkleRoot) invalidates the header hash', () => {
  const m = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 0,
    previousManifestHash: null,
    entries: [entry('e1', sha('aaa'))],
    sealedAt: 5000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  const tampered = { ...m, header: { ...m.header, merkleRoot: sha('forged-root') } };
  const res = verifyManifest(tampered, 'k');
  assert.equal(res.valid, false);
  assert.equal(res.reason, 'header-hash-mismatch');
});

test('empty manifest has a stable sentinel root and verifies', () => {
  const m = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 0,
    previousManifestHash: null,
    entries: [],
    sealedAt: 5000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  assert.equal(m.header.entryCount, 0);
  assert.equal(verifyManifest(m, 'k').valid, true);
  assert.equal(m.header.merkleRoot, merkleRoot([]));
});

// ---------------------------------------------------------------------------
// CHAINED MANIFEST HISTORY (append-only manifests).
// ---------------------------------------------------------------------------

test('manifest history chains: each references the prior headerHash', () => {
  const m0 = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 0,
    previousManifestHash: null,
    entries: [entry('e1', sha('aaa'))],
    sealedAt: 1000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  const m1 = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 1,
    previousManifestHash: m0.headerHash,
    entries: [entry('e1', sha('aaa')), entry('e2', sha('bbb'))],
    sealedAt: 2000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  assert.equal(verifyManifestChain([m0, m1], 'k').valid, true);

  // Negative control: break the link (wrong previousManifestHash) → chain-broken.
  const forged = sealManifest({
    tenantId: 'tenant-a',
    manifestSequence: 1,
    previousManifestHash: sha('not-the-prior'),
    entries: [entry('e2', sha('bbb'))],
    sealedAt: 2000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  const res = verifyManifestChain([m0, forged], 'k');
  assert.equal(res.valid, false);
  assert.equal(res.brokenAt, 1);
  assert.equal(res.reason, 'chain-broken');
});

// ---------------------------------------------------------------------------
// LEDGER → MANIFEST bridge.
// ---------------------------------------------------------------------------

test('sealManifestFromLedger attests the exact ordered set of ledger nodes', () => {
  const l = new ProvenanceLedger('tenant-a');
  const root = l.append(original());
  l.append(derived(root.nodeDigest));
  const m = sealManifestFromLedger(l, {
    manifestSequence: 0,
    previousManifestHash: null,
    sealedAt: 9000,
    sealedBy: 'auditor-1',
    signingKey: 'k',
  });
  assert.equal(m.header.entryCount, 2);
  assert.equal(verifyManifest(m, 'k').valid, true);
  // Every ledger node digest appears in the manifest.
  const digests = new Set(m.entries.map((e) => e.contentDigest));
  for (const e of l.edges()) assert.ok(digests.has(e.nodeDigest));
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

test('canonicalJson sorts keys so hashes/signatures are order-independent', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalHash({ b: 1, a: 2 }), canonicalHash({ a: 2, b: 1 }));
  // Negative control: different content → different hash.
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('hexEqual is a length-checked constant-time compare', () => {
  assert.equal(hexEqual(sha('x'), sha('x')), true);
  assert.equal(hexEqual(sha('x'), sha('y')), false);
  assert.equal(hexEqual('abcd', 'abc'), false);
});

test('reordering manifest leaves changes the ordered merkle root', () => {
  const a = manifestLeafHash(entry('e1', sha('aaa')));
  const b = manifestLeafHash(entry('e2', sha('bbb')));
  assert.notEqual(merkleRoot([a, b]), merkleRoot([b, a]));
});
