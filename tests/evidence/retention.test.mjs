// Verification-obligation test for VO-b9b935bf93be10bdecdd (T037 / GAR-006).
//
// Oracle: Originals MUST remain immutable or tamper-evident; derived repairs, exports,
// redactions, and dispositions MUST retain provenance, integrity, authorization, retention,
// and access history.
//
// Independently observable: exercises the real packages/evidence/src/retention.ts
// implementation using only Node built-ins (loaded via --experimental-strip-types), so it
// runs deterministically under `npm ci` with no adjacent infrastructure. Each test maps to a
// clause of the oracle and includes a negative control so the assertions are non-vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(join(ROOT, 'packages/evidence/src/retention.ts'));
const {
  verifyContentIntegrity,
  hasValidProvenance,
  resolveRetention,
  activeHoldsFor,
  evaluateDisposition,
  recordDisposition,
  verifyDispositionRecord,
  DispositionNotPermittedError,
} = mod;

const sha = (s) => createHash('sha256').update(s).digest('hex');

const originalBytes = Buffer.from('original-evidence-content');
const original = {
  evidenceItemId: 'ev-1',
  tenantId: 'tenant-a',
  kind: 'original',
  contentSha256: sha('original-evidence-content'),
  parentEvidenceId: null,
  classification: 'sensitive',
  createdAt: 1_000_000,
};

const derived = {
  evidenceItemId: 'ev-2',
  tenantId: 'tenant-a',
  kind: 'redaction',
  contentSha256: sha('redacted-content'),
  parentEvidenceId: 'ev-1',
  classification: 'sensitive',
  createdAt: 1_000_000,
};

// ---- Clause: originals immutable / tamper-evident --------------------------
test('original content integrity is tamper-evident (matching digest passes, altered fails)', () => {
  assert.equal(verifyContentIntegrity(original, originalBytes), true);
  // Negative control: a single altered byte must be detected.
  const tampered = Buffer.from(originalBytes);
  tampered[0] ^= 0xff;
  assert.equal(verifyContentIntegrity(original, tampered), false);
});

// ---- Clause: derived items retain provenance -------------------------------
test('originals have no parent; derived repairs/redactions/exports retain a provenance edge', () => {
  assert.equal(hasValidProvenance(original), true);
  assert.equal(hasValidProvenance(derived), true);
  // Negative controls: an original with a parent, or a derived item without one, is invalid.
  assert.equal(hasValidProvenance({ ...original, parentEvidenceId: 'x' }), false);
  assert.equal(hasValidProvenance({ ...derived, parentEvidenceId: null }), false);
});

// ---- Clause: retention resolution (longest applicable) ---------------------
test('resolveRetention returns the MAX expiry across applicable approved policies', () => {
  const policies = [
    { policyId: 'p-short', tenantId: 'tenant-a', appliesToClassifications: [], durationMillis: 100, approved: true },
    { policyId: 'p-long', tenantId: 'tenant-a', appliesToClassifications: ['sensitive'], durationMillis: 5_000, approved: true },
    { policyId: 'p-unapproved', tenantId: 'tenant-a', appliesToClassifications: [], durationMillis: 9_999_999, approved: false },
    { policyId: 'p-othertenant', tenantId: 'tenant-b', appliesToClassifications: [], durationMillis: 9_999_999, approved: true },
  ];
  const res = resolveRetention(original, policies);
  assert.deepEqual([...res.appliedPolicyIds].sort(), ['p-long', 'p-short']);
  assert.equal(res.retainUntil, original.createdAt + 5_000); // longest wins
  // Negative control: unapproved / cross-tenant policies do NOT extend retention.
  assert.notEqual(res.retainUntil, original.createdAt + 9_999_999);
});

// ---- Clause: legal-hold enforcement ----------------------------------------
test('activeHoldsFor detects covering active holds and ignores released / out-of-scope holds', () => {
  const holds = [
    { holdId: 'h-active', tenantId: 'tenant-a', scopeEvidenceIds: [], status: 'active' },
    { holdId: 'h-released', tenantId: 'tenant-a', scopeEvidenceIds: [], status: 'released' },
    { holdId: 'h-scoped-other', tenantId: 'tenant-a', scopeEvidenceIds: ['ev-999'], status: 'active' },
  ];
  assert.deepEqual([...activeHoldsFor(original, holds)], ['h-active']);
  // Negative control: no active covering holds => empty.
  assert.deepEqual([...activeHoldsFor(original, [holds[1], holds[2]])], []);
});

// ---- Clause: disposition invariant (hold / retention / authorization) ------
test('disposition is blocked by active hold, unexpired retention, or missing authorization', () => {
  const policies = [{ policyId: 'p', tenantId: 'tenant-a', appliesToClassifications: [], durationMillis: 5_000, approved: true }];
  const auth = { principalId: 'officer-1', grantId: 'grant-1' };

  // Blocked: retention not elapsed.
  const early = evaluateDisposition({ item: original, policies, holds: [], authorization: auth, now: original.createdAt + 1 });
  assert.equal(early.eligible, false);
  assert.ok(early.reasons.includes('retention-not-elapsed'));

  // Blocked: active legal hold even after retention elapsed.
  const held = evaluateDisposition({
    item: original, policies,
    holds: [{ holdId: 'h', tenantId: 'tenant-a', scopeEvidenceIds: [], status: 'active' }],
    authorization: auth, now: original.createdAt + 10_000,
  });
  assert.equal(held.eligible, false);
  assert.ok(held.reasons.includes('active-legal-hold'));

  // Blocked: unauthorized.
  const unauth = evaluateDisposition({ item: original, policies, holds: [], authorization: null, now: original.createdAt + 10_000 });
  assert.equal(unauth.eligible, false);
  assert.ok(unauth.reasons.includes('unauthorized'));

  // Eligible: retention elapsed, no holds, authorized.
  const ok = evaluateDisposition({ item: original, policies, holds: [], authorization: auth, now: original.createdAt + 10_000 });
  assert.equal(ok.eligible, true);
  assert.deepEqual([...ok.reasons], []);
});

// ---- Clause: signed disposition records w/ provenance + access history ------
test('recordDisposition emits a signed, tamper-evident record retaining provenance/authorization/access history', () => {
  const policies = [{ policyId: 'p', tenantId: 'tenant-a', appliesToClassifications: [], durationMillis: 5_000, approved: true }];
  const auth = { principalId: 'officer-1', grantId: 'grant-1' };
  const accessHistory = [
    { principalId: 'auditor-9', action: 'read', at: original.createdAt + 500 },
    { principalId: 'officer-1', action: 'review', at: original.createdAt + 9_000 },
  ];
  const signingKey = 'test-signing-key';

  const record = recordDisposition({
    item: original, policies, holds: [], authorization: auth,
    now: original.createdAt + 10_000, method: 'crypto-shred',
    executedBy: 'officer-1', accessHistory, signingKey,
  });

  // Provenance / integrity / authorization / retention / access history all retained.
  assert.equal(record.contentSha256, original.contentSha256);
  assert.deepEqual([...record.resolvedPolicyIds], ['p']);
  assert.deepEqual(record.authorization, auth);
  assert.equal(record.executedBy, 'officer-1');
  assert.deepEqual(record.accessHistory, accessHistory);
  assert.equal(typeof record.signature, 'string');
  assert.ok(record.signature.length > 0);

  // Signature verifies; tampering with any field or the wrong key fails (negative controls).
  assert.equal(verifyDispositionRecord(record, signingKey), true);
  assert.equal(verifyDispositionRecord({ ...record, method: 'delete' }, signingKey), false);
  assert.equal(verifyDispositionRecord({ ...record, executedBy: 'attacker' }, signingKey), false);
  assert.equal(verifyDispositionRecord(record, 'wrong-key'), false);
});

test('recordDisposition refuses to sign a record while disposition is not permitted', () => {
  const policies = [{ policyId: 'p', tenantId: 'tenant-a', appliesToClassifications: [], durationMillis: 5_000, approved: true }];
  const auth = { principalId: 'officer-1', grantId: 'grant-1' };
  assert.throws(
    () => recordDisposition({
      item: original, policies,
      holds: [{ holdId: 'h', tenantId: 'tenant-a', scopeEvidenceIds: [], status: 'active' }],
      authorization: auth, now: original.createdAt + 10_000,
      method: 'delete', executedBy: 'officer-1', accessHistory: [], signingKey: 'k',
    }),
    DispositionNotPermittedError,
  );
});
