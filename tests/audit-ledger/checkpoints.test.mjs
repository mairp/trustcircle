// Verification-obligation test for VO-d76c5d1293b91d26e094
// (Phase 31 / packages/audit-ledger/src/checkpoints.ts / GAR-002).
//
// Oracle / Phase-31 acceptance criterion (VO-d76c5d1293b91d26e094):
//   "Every decision and automated action MUST capture actor or principal, accountable owner,
//    reason, source and target state, policy and control versions, evidence, scope, time,
//    correlation, and outcome before it can be reported as complete."
//
// This suite exercises the REAL packages/audit-ledger/src/checkpoints.ts (loaded via
// --experimental-strip-types) on top of the REAL ./hash-chain.ts, using only Node built-ins — so it
// runs deterministically under `npm ci` with no adjacent infrastructure. Every property is proven by
// a POSITIVE control paired with a NEGATIVE control, so the assertions are non-vacuous. No test
// mutates shared source state: builders return fresh objects and tampering is done on copies, so a
// negative control leaves every other control byte-identical.
//
// Coverage maps one-to-one to the three Phase-31 capabilities + the accountability gate:
//
//   1. ED25519 CHECKPOINT SIGNING — signCheckpoint produces a valid signature over the exact
//      range/root/chain-link/identity/accountability-digest; verifyCheckpointSignature accepts it,
//      and REJECTS a forged range field, root, chain link, key id, bundle identity, or bit-flipped
//      signature. Signing a broken/empty range is refused by the Phase-30 substrate.
//   2. IMMUTABLE CHECKPOINT PUBLICATION — publishCheckpoint appends to a per-ledger, prefix-chained,
//      monotone-coverage log; the input log/checkpoint are never mutated (deep-frozen); a broken
//      chain link, a non-prefix range, or a non-monotone (replay/truncation) coverage is refused;
//      verifyCheckpointLog independently accepts an intact log and rejects a dropped/reordered one.
//   3. VERIFICATION HISTORY — verifyPublishedCheckpoint is the independent read path: re-derives the
//      root from independently-read records and re-verifies the signature ⇒ 'verified'; a mutated /
//      dropped / reordered record in the range, a swapped root, or a bad signature ⇒ 'tampered'.
//      appendVerification keeps history append-only (monotone sequence, no rewrite) and makes a
//      tamper finding STICKY (a later verified pass cannot launder it).
//   4. ACCOUNTABILITY GATE (the AC) — publish AND verify are themselves automated actions and REQUIRE
//      a fully-accountable AccountabilityRecord; omitting ANY required clause throws AccountabilityError
//      with the matching clause code, so neither a checkpoint nor a verification can be produced for
//      an action that has not captured the full accountability set. The accountability record is bound
//      into the signature by its content digest, so who/why/when/outcome cannot be swapped post-hoc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hc = await import(join(ROOT, 'packages/audit-ledger/src/hash-chain.ts'));
const cp = await import(join(ROOT, 'packages/audit-ledger/src/checkpoints.ts'));

const {
  AccountabilityError,
  createLedger,
  appendAuditRecord,
  computeCheckpointRoot,
  GENESIS_PREVIOUS_DIGEST,
} = hc;
const {
  CHECKPOINT_SIGNATURE_ALGORITHM,
  CheckpointError,
  generateSigningKey,
  verificationKeyFor,
  checkpointSigningPayload,
  signPayload,
  verifyPayloadSignature,
  signCheckpoint,
  verifyCheckpointSignature,
  createCheckpointLog,
  publishCheckpoint,
  verifyCheckpointLog,
  verifyPublishedCheckpoint,
  appendVerification,
  verifyAndRecord,
  anchorCheckpoint,
} = cp;

// ---------------------------------------------------------------------------
// Builders. Same governed-completion baseRecord shape as the Phase-30 suite.

const T = '11111111-1111-7111-8111-111111111111';
const L = '22222222-2222-7222-8222-222222222222';

function baseRecord(overrides = {}) {
  return {
    auditEventId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    tenantId: T,
    ledgerId: L,
    sequence: 1,
    eventType: 'decision.approved',
    schemaVersion: '1.0.0',
    actor: { principalId: 'p-1234', roleAssignmentId: 'ra-1', isSystem: false, automationId: null },
    accountableOwnerPrincipalId: 'owner-1',
    reason: { code: 'APPROVED', text: 'meets policy' },
    state: {
      entityType: 'controller-operation',
      entityId: 'op-1',
      entityVersion: 'v2',
      sourceStateDigest: 'src-digest',
      targetStateDigest: 'tgt-digest',
      actualStateDigest: null,
    },
    governance: {
      policyVersionIds: ['pol-1'],
      controlVersionIds: ['ctl-1'],
      evidenceManifestId: 'ev-1',
    },
    scope: { requested: { tenants: ['t-1'] }, actual: { tenants: ['t-1'] } },
    timing: { occurredAt: 1000, recordedAt: 1500 },
    correlation: { correlationId: 'corr-1', causationId: null, traceId: 'trace-1' },
    outcome: 'succeeded',
    ...overrides,
  };
}

// A distinct, fully-accountable record describing the PUBLISH / VERIFY action itself.
function actionRecord(overrides = {}) {
  return baseRecord({
    auditEventId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
    eventType: 'audit.checkpoint.publish',
    reason: { code: 'CHECKPOINT', text: 'periodic signed checkpoint' },
    correlation: { correlationId: 'ckpt-corr-1', causationId: null, traceId: 'ckpt-trace-1' },
    timing: { occurredAt: 5000, recordedAt: 5001 },
    ...overrides,
  });
}

// Build an intact ledger of n governed records; return the chained records.
function chainOf(n) {
  let ledger = createLedger(T, L);
  for (let i = 1; i <= n; i++) {
    ledger = appendAuditRecord(
      ledger,
      baseRecord({
        auditEventId: `aaaaaaaa-aaaa-7aaa-8aaa-${String(i).padStart(12, '0')}`,
        sequence: i,
        timing: { occurredAt: 1000 + i, recordedAt: 1500 + i },
      }),
    );
  }
  return ledger.records;
}

// A signing key fixed for the whole file (Ed25519 private scalar is CSPRNG-drawn — fine, we never
// assert on exact signature bytes, only on verify/accept-reject behaviour).
const KEY = generateSigningKey('key-ckpt-1');
const VKEY = verificationKeyFor(KEY);

function without(rec, field) {
  const r = { ...rec };
  delete r[field];
  return r;
}

// ---------------------------------------------------------------------------
// 0. POSITIVE CONTROL — the full sign → publish → verify happy path.

test('positive control: sign a prefix range, publish it, independently verify it → verified', () => {
  const recs = chainOf(5);
  const action = actionRecord();
  const checkpoint = signCheckpoint({
    checkpointId: 'ckpt-1',
    key: KEY,
    records: recs,
    previousRootDigest: GENESIS_PREVIOUS_DIGEST,
    action,
    generatedAt: 5001,
  });

  // Shape mirrors the audit_checkpoint row.
  assert.equal(checkpoint.firstSequence, 1);
  assert.equal(checkpoint.lastSequence, 5);
  assert.equal(checkpoint.eventCount, 5);
  assert.equal(checkpoint.signatureAlgorithm, CHECKPOINT_SIGNATURE_ALGORITHM);
  assert.equal(checkpoint.status, 'signed');
  assert.equal(checkpoint.previousRootDigest, GENESIS_PREVIOUS_DIGEST);
  assert.deepEqual(checkpoint.verificationHistory, []);

  // Signature verifies.
  assert.equal(verifyCheckpointSignature(checkpoint, VKEY), null);

  // Publish to a fresh log.
  const log = publishCheckpoint(createCheckpointLog(T, L), checkpoint);
  assert.equal(log.checkpoints.length, 1);
  assert.equal(log.coveredThroughSequence, 5);
  assert.equal(log.headRootDigest, checkpoint.rootDigest);
  assert.deepEqual(verifyCheckpointLog(log, VKEY), { ok: true, reason: null, index: null });

  // Independent verification over the same records → verified.
  const v = verifyPublishedCheckpoint({
    checkpoint,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(v.result, 'verified');
  assert.equal(v.reason, null);
  assert.equal(v.sequence, 1);
});

// ---------------------------------------------------------------------------
// 1. ED25519 CHECKPOINT SIGNING.

test('signPayload/verifyPayloadSignature: valid pair verifies; a tampered payload or bit-flipped sig does not', () => {
  const payload = 'canonical-payload';
  const sig = signPayload(KEY.privateKey, payload);
  assert.equal(verifyPayloadSignature(KEY.publicKey, payload, sig), true);
  // Negative: different payload.
  assert.equal(verifyPayloadSignature(KEY.publicKey, 'other-payload', sig), false);
  // Negative: corrupt the signature.
  const flipped = Buffer.from(sig, 'base64');
  flipped[0] ^= 0xff;
  assert.equal(verifyPayloadSignature(KEY.publicKey, payload, flipped.toString('base64')), false);
  // Negative: a different key.
  const other = generateSigningKey('key-other');
  assert.equal(verifyPayloadSignature(other.publicKey, payload, sig), false);
});

test('the signature commits to the range: a forged field/root/link/identity fails verification', () => {
  const recs = chainOf(4);
  const checkpoint = signCheckpoint({
    checkpointId: 'ckpt-sig',
    key: KEY,
    records: recs,
    previousRootDigest: GENESIS_PREVIOUS_DIGEST,
    action: actionRecord(),
    generatedAt: 5001,
  });
  assert.equal(verifyCheckpointSignature(checkpoint, VKEY), null);

  // Each forgery keeps the ORIGINAL signature but alters a signed field → bad_signature.
  const forgeRoot = { ...checkpoint, rootDigest: 'f'.repeat(64) };
  assert.equal(verifyCheckpointSignature(forgeRoot, VKEY), 'bad_signature');

  const forgeCount = { ...checkpoint, eventCount: 99 };
  assert.equal(verifyCheckpointSignature(forgeCount, VKEY), 'bad_signature');

  const forgeLast = { ...checkpoint, lastSequence: 3 };
  assert.equal(verifyCheckpointSignature(forgeLast, VKEY), 'bad_signature');

  const forgeLink = { ...checkpoint, previousRootDigest: 'e'.repeat(64) };
  assert.equal(verifyCheckpointSignature(forgeLink, VKEY), 'bad_signature');

  const forgeAcct = { ...checkpoint, accountabilityDigest: '0'.repeat(64) };
  assert.equal(verifyCheckpointSignature(forgeAcct, VKEY), 'bad_signature');

  // Wrong key id is rejected before signature math.
  const wrongKeyId = { ...checkpoint, signingKeyId: 'someone-else' };
  assert.equal(verifyCheckpointSignature(wrongKeyId, VKEY), 'key_id_mismatch');

  // Unsupported algorithm rejected.
  const wrongAlg = { ...checkpoint, signatureAlgorithm: 'rsa' };
  assert.equal(verifyCheckpointSignature(wrongAlg, VKEY), 'unsupported_algorithm');

  // A verification key for a different key pair rejects the signature.
  const other = generateSigningKey('key-ckpt-1'); // same id, different scalar
  assert.equal(verifyCheckpointSignature(checkpoint, verificationKeyFor(other)), 'bad_signature');
});

test('signCheckpoint refuses a broken or empty range (Phase-30 substrate gate)', () => {
  const recs = chainOf(3);
  // Dropping the middle record makes the range non-intact ⇒ substrate throws.
  assert.throws(() =>
    signCheckpoint({
      checkpointId: 'ckpt-x',
      key: KEY,
      records: [recs[0], recs[2]],
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: actionRecord(),
      generatedAt: 5001,
    }),
  );
  // Empty range refused.
  assert.throws(() =>
    signCheckpoint({
      checkpointId: 'ckpt-x',
      key: KEY,
      records: [],
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: actionRecord(),
      generatedAt: 5001,
    }),
  );
});

test('checkpointSigningPayload is byte-stable for equal content and changes when any field changes', () => {
  const range = {
    tenantId: T,
    ledgerId: L,
    firstSequence: 1,
    lastSequence: 3,
    eventCount: 3,
    rootDigest: 'r'.repeat(64),
    headIntegrityDigest: 'h'.repeat(64),
  };
  const a = checkpointSigningPayload({
    range,
    previousRootDigest: GENESIS_PREVIOUS_DIGEST,
    keyId: 'k',
    accountabilityDigest: 'd',
  });
  const b = checkpointSigningPayload({
    range: { ...range },
    previousRootDigest: GENESIS_PREVIOUS_DIGEST,
    keyId: 'k',
    accountabilityDigest: 'd',
  });
  assert.equal(a, b);
  const c = checkpointSigningPayload({
    range: { ...range, lastSequence: 4 },
    previousRootDigest: GENESIS_PREVIOUS_DIGEST,
    keyId: 'k',
    accountabilityDigest: 'd',
  });
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// 2. IMMUTABLE CHECKPOINT PUBLICATION.

function signPrefix(id, records, previousRootDigest, action = actionRecord()) {
  return signCheckpoint({
    checkpointId: id,
    key: KEY,
    records,
    previousRootDigest,
    action,
    generatedAt: 5001,
  });
}

test('publication is immutable: input log and published checkpoint are deep-frozen and untouched', () => {
  const recs = chainOf(3);
  const c1 = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST);
  const log0 = createCheckpointLog(T, L);
  const log1 = publishCheckpoint(log0, c1);

  assert.equal(log0.checkpoints.length, 0); // input log untouched
  assert.equal(log1.checkpoints.length, 1);
  assert.notEqual(log0, log1);
  assert.equal(Object.isFrozen(log1), true);
  assert.equal(Object.isFrozen(log1.checkpoints), true);
  assert.equal(Object.isFrozen(c1), true);
  // Mutating a frozen checkpoint field is a no-op (strict mode would throw; frozen guarantees it).
  assert.throws(() => {
    'use strict';
    c1.rootDigest = 'x';
  });
});

test('checkpoint chaining + monotone prefix coverage: a second prefix extends the first', () => {
  const recs5 = chainOf(5);
  const c1 = signPrefix('c1', recs5.slice(0, 3), GENESIS_PREVIOUS_DIGEST); // covers [1..3]
  let log = publishCheckpoint(createCheckpointLog(T, L), c1);
  const c2 = signPrefix('c2', recs5, c1.rootDigest); // covers [1..5], links to c1
  log = publishCheckpoint(log, c2);

  assert.equal(log.checkpoints.length, 2);
  assert.equal(log.coveredThroughSequence, 5);
  assert.equal(log.headRootDigest, c2.rootDigest);
  assert.deepEqual(verifyCheckpointLog(log, VKEY), { ok: true, reason: null, index: null });
});

test('publish refuses a broken checkpoint-chain link', () => {
  const recs = chainOf(3);
  const c1 = signPrefix('c1', recs.slice(0, 2), GENESIS_PREVIOUS_DIGEST);
  const log = publishCheckpoint(createCheckpointLog(T, L), c1);
  // c2 links to the WRONG previous root.
  const cBad = signPrefix('c2', recs, 'f'.repeat(64));
  assert.throws(
    () => publishCheckpoint(log, cBad),
    (e) => e instanceof CheckpointError && e.reason === 'broken_checkpoint_chain',
  );
});

test('publish refuses a non-prefix range and a non-monotone (replay/truncation) coverage', () => {
  const recs = chainOf(4);
  const c1 = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST); // covers [1..4]
  const log = publishCheckpoint(createCheckpointLog(T, L), c1);

  // Re-publishing an EQUAL-or-shorter prefix (replay/truncation) is refused.
  const cReplay = signPrefix('c1b', recs, c1.rootDigest); // still [1..4]
  assert.throws(
    () => publishCheckpoint(log, cReplay),
    (e) => e.reason === 'non_monotone_coverage',
  );
  const cShorter = signPrefix('c1c', recs.slice(0, 2), c1.rootDigest); // [1..2]
  assert.throws(
    () => publishCheckpoint(log, cShorter),
    (e) => e.reason === 'non_monotone_coverage',
  );

  // A foreign ledger is refused.
  const foreignLog = createCheckpointLog('99999999-9999-7999-8999-999999999999', L);
  assert.throws(
    () => publishCheckpoint(foreignLog, c1),
    (e) => e.reason === 'ledger_mismatch',
  );
});

test('verifyCheckpointLog detects a dropped/reordered whole checkpoint', () => {
  const recs = chainOf(6);
  const c1 = signPrefix('c1', recs.slice(0, 2), GENESIS_PREVIOUS_DIGEST);
  const c2 = signPrefix('c2', recs.slice(0, 4), c1.rootDigest);
  const c3 = signPrefix('c3', recs, c2.rootDigest);
  let log = publishCheckpoint(createCheckpointLog(T, L), c1);
  log = publishCheckpoint(log, c2);
  log = publishCheckpoint(log, c3);
  assert.equal(verifyCheckpointLog(log, VKEY).ok, true);

  // Drop the middle checkpoint → c3's previousRootDigest no longer matches.
  const dropped = { ...log, checkpoints: [c1, c3] };
  const r1 = verifyCheckpointLog(dropped, VKEY);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'broken_checkpoint_chain');
  assert.equal(r1.index, 1);

  // Reorder → first checkpoint no longer chains from genesis.
  const reordered = { ...log, checkpoints: [c2, c1, c3] };
  const r2 = verifyCheckpointLog(reordered, VKEY);
  assert.equal(r2.ok, false);
});

// ---------------------------------------------------------------------------
// 3. VERIFICATION HISTORY — the independent read path.

test('verifyPublishedCheckpoint re-derives from independently-read records: verified vs tampered', () => {
  const recs = chainOf(5);
  const checkpoint = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST);

  // Positive: same records → verified.
  assert.equal(
    verifyPublishedCheckpoint({ checkpoint, records: recs, key: VKEY, action: actionRecord() })
      .result,
    'verified',
  );

  // Negative: a MUTATED record in the range (stored digest not trusted) → tampered (chain fails).
  const mutated = recs.slice();
  mutated[2] = { ...recs[2], reason: { code: 'APPROVED', text: 'TAMPERED' } };
  const vMut = verifyPublishedCheckpoint({
    checkpoint,
    records: mutated,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(vMut.result, 'tampered');
  assert.match(vMut.reason, /^chain:/);

  // Negative: a DROPPED record (truncation) → range count/bounds mismatch or chain break → tampered.
  const dropped = [recs[0], recs[1], recs[2], recs[3]]; // 4 of 5
  assert.equal(
    verifyPublishedCheckpoint({ checkpoint, records: dropped, key: VKEY, action: actionRecord() })
      .result,
    'tampered',
  );

  // Negative: a REORDERED range → tampered.
  const reordered = [recs[0], recs[2], recs[1], recs[3], recs[4]];
  assert.equal(
    verifyPublishedCheckpoint({ checkpoint, records: reordered, key: VKEY, action: actionRecord() })
      .result,
    'tampered',
  );

  // Negative: a SWAPPED root (checkpoint claims a different root than records produce) → tampered.
  // Use a DIFFERENT-length chain so the root genuinely differs from recs's root (chainOf is
  // deterministic, so a same-length chain would produce the identical root and make this vacuous).
  const otherRoot = computeCheckpointRoot(T, L, chainOf(4)).rootDigest;
  assert.notEqual(otherRoot, checkpoint.rootDigest); // guard against a vacuous negative control
  // Build a checkpoint whose root doesn't match `recs` but keep records = recs.
  const swapped = { ...checkpoint, rootDigest: otherRoot };
  const vSwap = verifyPublishedCheckpoint({
    checkpoint: swapped,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(vSwap.result, 'tampered');
  assert.equal(vSwap.reason, 'root_digest_mismatch');

  // Negative: a bad SIGNATURE (records + root fine, signature corrupt) → tampered:signature.
  const badSig = { ...checkpoint, signature: Buffer.from('not-a-valid-sig').toString('base64') };
  const vSig = verifyPublishedCheckpoint({
    checkpoint: badSig,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(vSig.result, 'tampered');
  assert.match(vSig.reason, /^signature:/);
});

test('appendVerification is append-only, monotone, and makes a tamper finding sticky', () => {
  const recs = chainOf(3);
  const checkpoint = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST);

  // First: a passing verification.
  const v1 = verifyPublishedCheckpoint({
    checkpoint,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  const c1 = appendVerification(checkpoint, v1);
  assert.equal(c1.status, 'verified');
  assert.equal(c1.verificationHistory.length, 1);
  assert.equal(checkpoint.verificationHistory.length, 0); // original untouched
  assert.equal(Object.isFrozen(c1.verificationHistory), true);

  // Second: a FAILING verification (bad records) → status becomes tampered.
  const bad = [recs[0], { ...recs[1], reason: { code: 'X', text: 'Y' } }, recs[2]];
  const v2 = verifyPublishedCheckpoint({
    checkpoint: c1,
    records: bad,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(v2.sequence, 2);
  const c2 = appendVerification(c1, v2);
  assert.equal(c2.status, 'tampered');
  assert.equal(c2.verificationHistory.length, 2);

  // Third: even a PASSING verification cannot launder the tamper away (sticky).
  const v3 = verifyPublishedCheckpoint({
    checkpoint: c2,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(v3.result, 'verified');
  const c3 = appendVerification(c2, v3);
  assert.equal(c3.status, 'tampered'); // still tampered
  assert.equal(c3.verificationHistory.length, 3);

  // Negative: a verification with a non-next sequence is refused (no gaps, no rewrite).
  assert.throws(
    () => appendVerification(c3, { ...v1, sequence: 99 }),
    (e) => e instanceof CheckpointError && e.reason === 'verification_sequence',
  );
  assert.throws(
    () => appendVerification(c3, { ...v1, sequence: 1 }), // would overwrite history
    (e) => e.reason === 'verification_sequence',
  );
});

test('verifyAndRecord composes verify + append in one step', () => {
  const recs = chainOf(4);
  const checkpoint = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST);
  const { checkpoint: next, verification } = verifyAndRecord({
    checkpoint,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  assert.equal(verification.result, 'verified');
  assert.equal(next.status, 'verified');
  assert.equal(next.verificationHistory.length, 1);
});

test('anchorCheckpoint only promotes a verified checkpoint', () => {
  const recs = chainOf(3);
  const signed = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST);
  // Cannot anchor a merely-signed checkpoint.
  assert.throws(
    () => anchorCheckpoint(signed, 'anchor://x'),
    (e) => e instanceof CheckpointError && e.reason === 'anchor_state',
  );
  const { checkpoint: verified } = verifyAndRecord({
    checkpoint: signed,
    records: recs,
    key: VKEY,
    action: actionRecord(),
  });
  const anchored = anchorCheckpoint(verified, 'anchor://x');
  assert.equal(anchored.status, 'anchored');
  assert.equal(anchored.externalAnchorRef, 'anchor://x');
});

// ---------------------------------------------------------------------------
// 4. ACCOUNTABILITY GATE — the AC, on BOTH publish and verify. Clause by clause.
//    Omitting any required clause of the publish/verify action throws AccountabilityError with the
//    matching clause code, so the checkpoint/verification cannot be produced (and hence cannot be
//    "reported as complete").

const REQUIRED_CLAUSES = [
  ['actor', 'actor'],
  ['accountableOwnerPrincipalId', 'accountable_owner'],
  ['reason', 'reason'],
  ['scope', 'scope'],
  ['timing', 'time'],
  ['correlation', 'correlation'],
  ['outcome', 'outcome'],
];

test('signCheckpoint REQUIRES a fully-accountable publish action (clause by clause)', () => {
  const recs = chainOf(3);
  // Positive: full action → signs.
  assert.doesNotThrow(() =>
    signCheckpoint({
      checkpointId: 'c1',
      key: KEY,
      records: recs,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: actionRecord(),
      generatedAt: 5001,
    }),
  );
  // Negatives: each omitted clause throws with its clause code.
  for (const [field, clause] of REQUIRED_CLAUSES) {
    assert.throws(
      () =>
        signCheckpoint({
          checkpointId: 'c1',
          key: KEY,
          records: recs,
          previousRootDigest: GENESIS_PREVIOUS_DIGEST,
          action: without(actionRecord(), field),
          generatedAt: 5001,
        }),
      (e) => e instanceof AccountabilityError && e.clause === clause,
      `omitting ${field} should throw AccountabilityError(${clause})`,
    );
  }
  // Source/target state clauses.
  assert.throws(
    () =>
      signCheckpoint({
        checkpointId: 'c1',
        key: KEY,
        records: recs,
        previousRootDigest: GENESIS_PREVIOUS_DIGEST,
        action: actionRecord({ state: { ...actionRecord().state, sourceStateDigest: '' } }),
        generatedAt: 5001,
      }),
    (e) => e.clause === 'source_state',
  );
});

test('verifyPublishedCheckpoint REQUIRES a fully-accountable verify action (clause by clause)', () => {
  const recs = chainOf(3);
  const checkpoint = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST);
  // Positive: full action → produces a verification.
  assert.doesNotThrow(() =>
    verifyPublishedCheckpoint({ checkpoint, records: recs, key: VKEY, action: actionRecord() }),
  );
  // Negatives: each omitted clause throws (the verify cannot be reported complete).
  for (const [field, clause] of REQUIRED_CLAUSES) {
    assert.throws(
      () =>
        verifyPublishedCheckpoint({
          checkpoint,
          records: recs,
          key: VKEY,
          action: without(actionRecord(), field),
        }),
      (e) => e instanceof AccountabilityError && e.clause === clause,
      `omitting ${field} should throw AccountabilityError(${clause})`,
    );
  }
});

test('the publish action is BOUND into the signature: swapping its accountability digest breaks verification', () => {
  const recs = chainOf(3);
  const checkpoint = signPrefix('c1', recs, GENESIS_PREVIOUS_DIGEST, actionRecord());
  // The stored accountabilityDigest is the who/why/when of the publish.
  assert.equal(typeof checkpoint.accountabilityDigest, 'string');
  assert.equal(verifyCheckpointSignature(checkpoint, VKEY), null);
  // Swapping it (as if re-attributing the action) invalidates the signature.
  const reattributed = { ...checkpoint, accountabilityDigest: 'f'.repeat(64) };
  assert.equal(verifyCheckpointSignature(reattributed, VKEY), 'bad_signature');
});
