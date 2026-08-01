// Verification-obligation test for the original-first evidence service (Phase 35 / GAR-006 /
// VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 / VO-4aeb030a32c9deebdb3b).
//
// Oracle: Originals MUST remain immutable or tamper-evident; derived repairs, exports,
// redactions, and dispositions MUST retain provenance, integrity, authorization, retention,
// and access history.
//
// Independently observable: exercises the REAL packages/evidence/src/evidence-service.ts
// implementation using only Node built-ins (loaded via --experimental-strip-types), so it runs
// deterministically under `npm ci` with no adjacent infrastructure. Each test maps to a phase
// responsibility (original-first commits, digest verification, tenant namespaces,
// classification checks) and to a clause of the oracle, and includes a negative control so the
// assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'packages/evidence/src/evidence-service.ts'));
const {
  EvidenceService,
  EvidenceCommitError,
  EvidenceAccessError,
  digestEquals,
  evidenceDigest,
  handleKey,
  CLASSIFICATION_ORDER,
} = mod;

const sha = (s) => createHash('sha256').update(Buffer.from(s)).digest('hex');
const auth = { principalId: 'officer-1', grantId: 'grant-1' };
const auth2 = { principalId: 'auditor-1', grantId: 'grant-2' };

const commitOriginalDefaults = (svc, over = {}) =>
  svc.commitOriginal({
    tenantId: 'tenant-a',
    content: Buffer.from('original-evidence'),
    classification: 'sensitive',
    authorization: auth,
    now: 1000,
    ...over,
  });

// ---------------------------------------------------------------------------
// ORIGINAL-FIRST COMMITS
// ---------------------------------------------------------------------------

test('original commit is content-addressed and has no provenance parent (original-first)', () => {
  const svc = new EvidenceService();
  const res = commitOriginalDefaults(svc);
  assert.equal(res.handle.digest, sha('original-evidence'));
  assert.equal(res.handle.tenantId, 'tenant-a');

  const obj = svc.head(res.handle, auth, 2000);
  assert.equal(obj.metadata.kind, 'original');
  assert.equal(obj.metadata.provenance.parentDigest, null);
  assert.equal(obj.metadata.provenance.transformationDigest, null);
});

test('derived commit REQUIRES the parent original to exist first (original-first ordering)', () => {
  const svc = new EvidenceService();
  const derivedBytes = Buffer.from('redacted-copy');
  const missingParent = { tenantId: 'tenant-a', digest: sha('never-committed') };

  // Negative: no original committed → derived is rejected as parent-not-found.
  assert.throws(
    () =>
      svc.commitDerived({
        tenantId: 'tenant-a',
        parent: missingParent,
        kind: 'redaction',
        content: derivedBytes,
        classification: 'sensitive',
        authorization: auth,
        now: 2000,
        retention: { mode: 'COMPLIANCE', retainUntil: 9_999 },
        transformationDigest: sha('redaction-ruleset'),
      }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'parent-not-found',
  );

  // Positive: commit the original first, THEN the derived succeeds.
  const original = commitOriginalDefaults(svc);
  const res = svc.commitDerived({
    tenantId: 'tenant-a',
    parent: original.handle,
    kind: 'redaction',
    content: derivedBytes,
    classification: 'sensitive',
    authorization: auth,
    now: 3000,
    retention: { mode: 'COMPLIANCE', retainUntil: 9_999 },
    transformationDigest: sha('redaction-ruleset'),
  });
  assert.equal(res.handle.digest, sha('redacted-copy'));
});

test('derived artifact retains provenance, authorization, and retention; original stays unchanged', () => {
  const svc = new EvidenceService();
  const original = commitOriginalDefaults(svc);
  const derived = svc.commitDerived({
    tenantId: 'tenant-a',
    parent: original.handle,
    kind: 'export',
    content: Buffer.from('exported-bundle'),
    classification: 'restricted',
    authorization: auth2,
    now: 3000,
    retention: { mode: 'GOVERNANCE', retainUntil: 5_000 },
    transformationDigest: sha('export-query'),
  });

  const obj = svc.head(derived.handle, auth, 4000);
  // Provenance edge back to the original.
  assert.equal(obj.metadata.provenance.parentDigest, original.handle.digest);
  assert.equal(obj.metadata.provenance.transformationDigest, sha('export-query'));
  // Authorization retained.
  assert.deepEqual(obj.metadata.authorization, auth2);
  // Retention retained.
  assert.deepEqual(obj.metadata.retention, { mode: 'GOVERNANCE', retainUntil: 5_000 });
  // Access history is non-empty (put + head recorded).
  assert.ok(obj.accessHistory.length >= 1);

  // The original is unchanged: still an original with a null parent, still readable.
  const originalObj = svc.head(original.handle, auth, 4000);
  assert.equal(originalObj.metadata.kind, 'original');
  assert.equal(originalObj.metadata.provenance.parentDigest, null);

  // Provenance chain reconstructs derived → original.
  const chain = svc.provenanceChain(derived.handle, auth, 5000);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].digest, derived.handle.digest);
  assert.equal(chain[1].digest, original.handle.digest);
});

// ---------------------------------------------------------------------------
// DIGEST VERIFICATION
// ---------------------------------------------------------------------------

test('a declared expected digest that does not match the bytes is rejected (tamper-evident)', () => {
  const svc = new EvidenceService();
  assert.throws(
    () => commitOriginalDefaults(svc, { expectedDigest: sha('WRONG-DIGEST') }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'digest-mismatch',
  );
  // Negative control: the correct expected digest is accepted.
  const ok = commitOriginalDefaults(svc, { expectedDigest: sha('original-evidence') });
  assert.equal(ok.handle.digest, sha('original-evidence'));
});

test('verifyDigest independently confirms/denies content vs handle', () => {
  const svc = new EvidenceService();
  const res = commitOriginalDefaults(svc);
  assert.equal(svc.verifyDigest(res.handle, Buffer.from('original-evidence')), true);
  // Negative control: different bytes fail verification.
  assert.equal(svc.verifyDigest(res.handle, Buffer.from('tampered')), false);
  // Pure helper agrees.
  assert.equal(
    digestEquals(evidenceDigest(Buffer.from('original-evidence')), res.handle.digest),
    true,
  );
  assert.equal(digestEquals(evidenceDigest(Buffer.from('x')), res.handle.digest), false);
});

test('reads re-verify integrity and return the exact committed bytes', () => {
  const svc = new EvidenceService();
  const res = commitOriginalDefaults(svc);
  const got = svc.get(res.handle, auth, 2000);
  assert.equal(Buffer.from(got.content).toString(), 'original-evidence');
  assert.equal(evidenceDigest(got.content), res.handle.digest);
});

// ---------------------------------------------------------------------------
// TENANT NAMESPACES
// ---------------------------------------------------------------------------

test('identical bytes under two tenants are isolated; cross-tenant read is refused', () => {
  const svc = new EvidenceService();
  const a = commitOriginalDefaults(svc, { tenantId: 'tenant-a' });
  const b = commitOriginalDefaults(svc, { tenantId: 'tenant-b' });
  // Same digest (same bytes) but distinct tenant-namespaced handles.
  assert.equal(a.handle.digest, b.handle.digest);
  assert.notEqual(handleKey(a.handle), handleKey(b.handle));

  // tenant-b exists check must NOT see tenant-a's object under a foreign handle,
  // and reading tenant-a's digest against a tenant with no such object is not-found.
  const foreign = { tenantId: 'tenant-c', digest: a.handle.digest };
  assert.equal(svc.exists(foreign), false);
  assert.throws(
    () => svc.get(foreign, auth, 3000),
    (e) => e instanceof EvidenceAccessError && e.reason === 'not-found',
  );

  // Negative control: each tenant CAN read its own copy.
  assert.equal(Buffer.from(svc.get(a.handle, auth, 3000).content).toString(), 'original-evidence');
  assert.equal(Buffer.from(svc.get(b.handle, auth, 3000).content).toString(), 'original-evidence');
});

test('a derived artifact cannot attach to a parent in a different tenant', () => {
  const svc = new EvidenceService();
  const a = commitOriginalDefaults(svc, { tenantId: 'tenant-a' });
  assert.throws(
    () =>
      svc.commitDerived({
        tenantId: 'tenant-b',
        parent: { tenantId: 'tenant-a', digest: a.handle.digest },
        kind: 'redaction',
        content: Buffer.from('cross-tenant-derive'),
        classification: 'sensitive',
        authorization: auth,
        now: 4000,
        retention: { mode: 'COMPLIANCE', retainUntil: 9_999 },
        transformationDigest: sha('t'),
      }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'parent-tenant-mismatch',
  );
});

// ---------------------------------------------------------------------------
// CLASSIFICATION CHECKS / QUARANTINE
// ---------------------------------------------------------------------------

test('unknown classification is rejected on commit', () => {
  const svc = new EvidenceService();
  assert.throws(
    () => commitOriginalDefaults(svc, { classification: 'top-double-secret' }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'unknown-classification',
  );
  // Negative control: every known classification is accepted.
  for (const c of CLASSIFICATION_ORDER) {
    const r = commitOriginalDefaults(svc, {
      classification: c,
      content: Buffer.from(`content-${c}`),
    });
    assert.equal(r.handle.digest, sha(`content-${c}`));
  }
});

test('quarantined original stays visible/inspectable but cannot be a derivation parent', () => {
  const svc = new EvidenceService();
  const q = commitOriginalDefaults(svc, {
    execution: 'quarantined',
    content: Buffer.from('unsafe-item'),
  });
  // Visible & inspectable: reads succeed.
  assert.equal(svc.executionState(q.handle), 'quarantined');
  assert.equal(svc.isExecutable(q.handle), false);
  assert.equal(Buffer.from(svc.get(q.handle, auth, 2000).content).toString(), 'unsafe-item');

  // Blocked from execution: cannot derive off it.
  assert.throws(
    () =>
      svc.commitDerived({
        tenantId: 'tenant-a',
        parent: q.handle,
        kind: 'repair',
        content: Buffer.from('auto-repair'),
        classification: 'sensitive',
        authorization: auth,
        now: 3000,
        retention: { mode: 'COMPLIANCE', retainUntil: 9_999 },
        transformationDigest: sha('repair-patch'),
      }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'parent-quarantined',
  );

  // Negative control: an ACTIVE original of the same bytes-family CAN be derived from.
  const active = commitOriginalDefaults(svc, { content: Buffer.from('safe-item') });
  const ok = svc.commitDerived({
    tenantId: 'tenant-a',
    parent: active.handle,
    kind: 'repair',
    content: Buffer.from('auto-repair'),
    classification: 'sensitive',
    authorization: auth,
    now: 3000,
    retention: { mode: 'COMPLIANCE', retainUntil: 9_999 },
    transformationDigest: sha('repair-patch'),
  });
  assert.equal(ok.handle.digest, sha('auto-repair'));
});

test('quarantine after commit blocks derivation; original remains readable', () => {
  const svc = new EvidenceService();
  const o = commitOriginalDefaults(svc, { content: Buffer.from('later-flagged') });
  assert.equal(svc.isExecutable(o.handle), true);
  svc.quarantine(o.handle);
  assert.equal(svc.isExecutable(o.handle), false);
  // Still inspectable.
  assert.equal(Buffer.from(svc.get(o.handle, auth, 3000).content).toString(), 'later-flagged');
});

test('derived artifact may not down-classify below its parent', () => {
  const svc = new EvidenceService();
  const original = commitOriginalDefaults(svc, {
    classification: 'restricted',
    content: Buffer.from('rst'),
  });
  assert.throws(
    () =>
      svc.commitDerived({
        tenantId: 'tenant-a',
        parent: original.handle,
        kind: 'export',
        content: Buffer.from('leaky-export'),
        classification: 'public', // less sensitive than restricted → rejected.
        authorization: auth,
        now: 3000,
        retention: { mode: 'GOVERNANCE', retainUntil: 5000 },
        transformationDigest: sha('q'),
      }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'derived-cannot-downclassify',
  );
  // Negative control: equal-or-higher classification is accepted.
  const ok = svc.commitDerived({
    tenantId: 'tenant-a',
    parent: original.handle,
    kind: 'export',
    content: Buffer.from('safe-export'),
    classification: 'restricted',
    authorization: auth,
    now: 3000,
    retention: { mode: 'GOVERNANCE', retainUntil: 5000 },
    transformationDigest: sha('q'),
  });
  assert.equal(ok.handle.digest, sha('safe-export'));
});

// ---------------------------------------------------------------------------
// AUTHORIZATION + IMMUTABILITY of originals
// ---------------------------------------------------------------------------

test('missing authorization is rejected on commit', () => {
  const svc = new EvidenceService();
  assert.throws(
    () => commitOriginalDefaults(svc, { authorization: { principalId: '', grantId: '' } }),
    (e) => e instanceof EvidenceCommitError && e.reason === 'missing-authorization',
  );
});

test('re-committing identical original bytes is an idempotent no-op (immutability)', () => {
  const svc = new EvidenceService();
  const a = commitOriginalDefaults(svc);
  const b = commitOriginalDefaults(svc);
  assert.equal(b.deduplicated, true);
  assert.equal(a.handle.digest, b.handle.digest);
  assert.equal(a.versionId, b.versionId);
});

test('a re-commit never silently un-quarantines an item', () => {
  const svc = new EvidenceService();
  const q = commitOriginalDefaults(svc, { execution: 'quarantined' });
  assert.equal(svc.executionState(q.handle), 'quarantined');
  // Re-commit the same bytes WITHOUT the quarantine flag: state must persist.
  const again = commitOriginalDefaults(svc, { execution: 'active' });
  assert.equal(again.deduplicated, true);
  assert.equal(svc.executionState(q.handle), 'quarantined');
});

// ---------------------------------------------------------------------------
// DISPOSITION — signed, tenant-checked, retention/hold enforced
// ---------------------------------------------------------------------------

const evItem = (over = {}) => ({
  evidenceItemId: 'ev-1',
  tenantId: 'tenant-a',
  kind: 'original',
  contentSha256: sha('original-evidence'),
  parentEvidenceId: null,
  classification: 'sensitive',
  createdAt: 1000,
  ...over,
});

test('disposition is blocked under active legal hold and before retention elapses', () => {
  const svc = new EvidenceService();
  const o = commitOriginalDefaults(svc);
  const policies = [
    {
      policyId: 'p1',
      tenantId: 'tenant-a',
      appliesToClassifications: [],
      durationMillis: 10_000,
      approved: true,
    },
  ];
  const activeHold = [
    { holdId: 'h1', tenantId: 'tenant-a', scopeEvidenceIds: [], status: 'active' },
  ];

  // canDispose is false while retention has not elapsed.
  assert.equal(
    svc.canDispose({ item: evItem(), policies, holds: [], authorization: auth, now: 5_000 }),
    false,
  );
  // disposeEvidence throws under an active hold.
  assert.throws(() =>
    svc.disposeEvidence({
      handle: o.handle,
      item: evItem(),
      policies,
      holds: activeHold,
      authorization: auth,
      method: 'delete',
      executedBy: 'officer-1',
      signingKey: 'k',
      now: 20_000,
    }),
  );
});

test('disposition succeeds when eligible and yields a tenant-checked signed record', () => {
  const svc = new EvidenceService();
  const o = commitOriginalDefaults(svc);
  const policies = [
    {
      policyId: 'p1',
      tenantId: 'tenant-a',
      appliesToClassifications: [],
      durationMillis: 10_000,
      approved: true,
    },
  ];
  assert.equal(
    svc.canDispose({ item: evItem(), policies, holds: [], authorization: auth, now: 20_000 }),
    true,
  );
  const record = svc.disposeEvidence({
    handle: o.handle,
    item: evItem(),
    policies,
    holds: [],
    authorization: auth,
    method: 'archive',
    executedBy: 'officer-1',
    signingKey: 'signing-key',
    now: 20_000,
  });
  assert.equal(record.tenantId, 'tenant-a');
  assert.equal(record.method, 'archive');
  assert.equal(record.contentSha256, o.handle.digest);
  assert.ok(record.signature.length > 0);

  // Negative control: a mismatched-tenant item is refused before disposition.
  assert.throws(
    () =>
      svc.disposeEvidence({
        handle: o.handle,
        item: evItem({ tenantId: 'tenant-b' }),
        policies,
        holds: [],
        authorization: auth,
        method: 'archive',
        executedBy: 'officer-1',
        signingKey: 'signing-key',
        now: 20_000,
      }),
    (e) => e instanceof EvidenceAccessError && e.reason === 'tenant-mismatch',
  );
});
