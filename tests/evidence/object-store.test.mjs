// Verification-obligation test for the content-addressed object-store port and S3-compatible
// immutable adapter (T034 / GAR-006 / VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 /
// VO-4aeb030a32c9deebdb3b).
//
// Oracle: Originals MUST remain immutable or tamper-evident; derived repairs, exports,
// redactions, and dispositions MUST retain provenance, integrity, authorization, retention,
// and access history.
//
// Independently observable: exercises the REAL packages/evidence/src/object-store.ts
// implementation using only Node built-ins (loaded via --experimental-strip-types), so it
// runs deterministically under `npm ci` with no S3 or adjacent infrastructure. Each test maps
// to a clause of the oracle and includes a negative control so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'packages/evidence/src/object-store.ts'));
const {
  InMemoryImmutableObjectStore,
  ImmutableObjectError,
  contentAddress,
  deletionBlockReason,
  retainsRequiredProvenance,
} = mod;

const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');
const auth = { principalId: 'officer-1', grantId: 'grant-1' };

const originalMeta = (now, retention = null) => ({
  tenantId: 'tenant-a',
  kind: 'original',
  classification: 'sensitive',
  provenance: { parentDigest: null, method: 'capture', transformationDigest: null },
  authorization: auth,
  retention,
  createdAt: now,
});

const derivedMeta = (parentDigest, transformationDigest, now, retention) => ({
  tenantId: 'tenant-a',
  kind: 'redaction',
  classification: 'sensitive',
  provenance: { parentDigest, method: 'redaction', transformationDigest },
  authorization: auth,
  retention,
  createdAt: now,
});

// ---------------------------------------------------------------------------

test('content address IS the SHA-256 of the bytes (content-addressed)', () => {
  const bytes = Buffer.from('original-evidence');
  const store = new InMemoryImmutableObjectStore();
  const res = store.put({ content: bytes, metadata: originalMeta(0), by: auth, now: 0 });
  assert.equal(res.digest, sha('original-evidence'));
  assert.equal(contentAddress(bytes), sha('original-evidence'));

  // Negative control: a different byte string must NOT produce the same address.
  assert.notEqual(contentAddress(Buffer.from('tampered')), sha('original-evidence'));
});

test('originals are immutable: identical re-put dedupes, different bytes under a claimed key are rejected', () => {
  const store = new InMemoryImmutableObjectStore();
  const bytes = Buffer.from('original');
  const first = store.put({ content: bytes, metadata: originalMeta(0), by: auth, now: 0 });
  const again = store.put({ content: bytes, metadata: originalMeta(1), by: auth, now: 1 });
  assert.equal(again.deduplicated, true, 'identical bytes dedupe to the same version');
  assert.equal(again.versionId, first.versionId);

  // Tamper attempt: claim the original's address for different bytes.
  assert.throws(
    () =>
      store.put({
        content: Buffer.from('tampered'),
        metadata: originalMeta(2),
        by: auth,
        now: 2,
        expectedDigest: first.digest,
      }),
    (e) => e instanceof ImmutableObjectError && e.reason === 'content-address-mismatch',
  );

  // Negative control: honest re-put with no expectedDigest still succeeds (idempotent).
  assert.ok(
    store.put({ content: bytes, metadata: originalMeta(3), by: auth, now: 3 }).deduplicated,
  );
});

test('tamper-evident on read: get recomputes the address and integrity holds', () => {
  const store = new InMemoryImmutableObjectStore();
  const bytes = Buffer.from('committed-body');
  const { digest } = store.put({ content: bytes, metadata: originalMeta(0), by: auth, now: 0 });
  const got = store.get(digest, auth, 5);
  assert.deepEqual(Buffer.from(got.content), bytes, 'bytes round-trip unchanged');
  assert.equal(contentAddress(got.content), digest, 'read verifies the content address');

  // Negative control: a fabricated digest is not found (cannot conjure content).
  assert.throws(
    () => store.get(sha('never-stored'), auth, 6),
    (e) => e instanceof ImmutableObjectError && e.reason === 'not-found',
  );
});

test('legal hold blocks deletion unconditionally; COMPLIANCE retention cannot be bypassed', () => {
  const store = new InMemoryImmutableObjectStore();
  const bytes = Buffer.from('held-original');
  const retention = { mode: 'COMPLIANCE', retainUntil: 1000 };
  const { digest } = store.put({
    content: bytes,
    metadata: originalMeta(0, retention),
    by: auth,
    now: 0,
  });

  // Under COMPLIANCE retention (now < retainUntil): delete blocked, even with bypass flag.
  assert.throws(
    () => store.delete({ digest, by: auth, now: 500, bypassGovernanceRetention: true }),
    (e) => e instanceof ImmutableObjectError && e.reason === 'compliance-retention-not-elapsed',
  );

  // After retention elapses, a legal hold still blocks deletion.
  store.setLegalHold(digest, auth, 1500);
  assert.throws(
    () => store.delete({ digest, by: auth, now: 2000 }),
    (e) => e instanceof ImmutableObjectError && e.reason === 'active-legal-hold',
  );

  // Negative control: clear the hold AND let retention elapse ⇒ deletion now permitted.
  store.clearLegalHold(digest, auth, 2001);
  assert.doesNotThrow(() => store.delete({ digest, by: auth, now: 2002 }));
  assert.equal(store.exists(digest), false);
});

test('GOVERNANCE retention blocks deletion until elapsed unless an explicit bypass is authorized', () => {
  const store = new InMemoryImmutableObjectStore();
  const retention = { mode: 'GOVERNANCE', retainUntil: 1000 };
  const { digest } = store.put({
    content: Buffer.from('gov-original'),
    metadata: originalMeta(0, retention),
    by: auth,
    now: 0,
  });
  assert.throws(
    () => store.delete({ digest, by: auth, now: 500 }),
    (e) => e instanceof ImmutableObjectError && e.reason === 'governance-retention-not-elapsed',
  );
  // Explicit authorized bypass is honoured for GOVERNANCE (only).
  assert.doesNotThrow(() =>
    store.delete({ digest, by: auth, now: 500, bypassGovernanceRetention: true }),
  );

  // Negative control at the pure-helper level: without bypass it stays blocked.
  const obj = {
    digest,
    versionId: 'v',
    size: 1,
    legalHold: false,
    accessHistory: [{ principalId: 'p', action: 'put', at: 0 }],
    metadata: originalMeta(0, retention),
  };
  assert.equal(deletionBlockReason(obj, 500), 'governance-retention-not-elapsed');
  assert.equal(deletionBlockReason(obj, 500, true), null);
  assert.equal(deletionBlockReason(obj, 1000), null, 'exactly at retainUntil retention elapsed');
});

test('every operation is retained in the append-only access history', () => {
  const store = new InMemoryImmutableObjectStore();
  const { digest } = store.put({
    content: Buffer.from('audited'),
    metadata: originalMeta(0),
    by: auth,
    now: 0,
  });
  store.get(digest, auth, 1);
  store.head(digest, auth, 2);
  store.setLegalHold(digest, auth, 3);
  const head = store.head(digest, auth, 4);
  const actions = head.accessHistory.map((a) => a.action);
  assert.deepEqual(actions, ['put', 'get', 'head', 'legal-hold-set', 'head']);

  // A refused deletion is also recorded before the throw.
  assert.throws(() => store.delete({ digest, by: auth, now: 5 }));
  const after = store.head(digest, auth, 6);
  assert.ok(
    after.accessHistory.some((a) => a.action === 'delete-denied'),
    'refused deletion is retained in access history',
  );
});

test('derived artifacts retain provenance, integrity, authorization, retention, and access history', () => {
  const store = new InMemoryImmutableObjectStore();
  const parentBytes = Buffer.from('the-original');
  const parent = store.put({ content: parentBytes, metadata: originalMeta(0), by: auth, now: 0 });

  const redactedBytes = Buffer.from('the-redacted-derivative');
  const transformationDigest = sha('redaction:remove-pii:v1');
  const derived = store.put({
    content: redactedBytes,
    metadata: derivedMeta(parent.digest, transformationDigest, 10, {
      mode: 'GOVERNANCE',
      retainUntil: 9999,
    }),
    by: auth,
    now: 10,
  });

  const parentObj = store.head(parent.digest, auth, 11);
  const derivedObj = store.head(derived.digest, auth, 12);

  assert.equal(retainsRequiredProvenance(parentObj), true, 'original retains valid provenance');
  assert.equal(retainsRequiredProvenance(derivedObj), true, 'derived retains full provenance');
  assert.equal(derivedObj.metadata.provenance.parentDigest, parent.digest);
  assert.equal(derivedObj.metadata.provenance.transformationDigest, transformationDigest);
  assert.equal(derivedObj.metadata.authorization.grantId, 'grant-1');
  assert.ok(derivedObj.metadata.retention, 'derived retains a retention binding');

  // Negative control 1: a derived object missing its parent edge fails the provenance check.
  const brokenDerived = {
    ...derivedObj,
    metadata: {
      ...derivedObj.metadata,
      provenance: { parentDigest: null, method: 'redaction', transformationDigest },
    },
  };
  assert.equal(retainsRequiredProvenance(brokenDerived), false);

  // Negative control 2: a derived object with no retention binding fails.
  const noRetention = { ...derivedObj, metadata: { ...derivedObj.metadata, retention: null } };
  assert.equal(retainsRequiredProvenance(noRetention), false);

  // Negative control 3: an original that (wrongly) carries a parent edge fails.
  const badOriginal = {
    ...parentObj,
    metadata: {
      ...parentObj.metadata,
      provenance: { parentDigest: derived.digest, method: 'capture', transformationDigest: null },
    },
  };
  assert.equal(retainsRequiredProvenance(badOriginal), false);
});
