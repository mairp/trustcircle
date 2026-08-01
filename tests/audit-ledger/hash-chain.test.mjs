// Verification-obligation test for VO-d76c5d1293b91d26e094
// (Phase 30 / packages/audit-ledger/src/hash-chain.ts / GAR-002).
//
// Oracle / Phase-30 acceptance criterion:
//   "Every decision and automated action MUST capture actor or principal, accountable owner,
//    reason, source and target state, policy and control versions, evidence, scope, time,
//    correlation, and outcome before it can be reported as complete."
//
// This suite exercises the REAL packages/audit-ledger/src/hash-chain.ts using only Node built-ins
// (loaded via --experimental-strip-types), so it runs deterministically under `npm ci` with no
// adjacent infrastructure. Every property is proven by a POSITIVE control paired with a NEGATIVE
// control, so the assertions are non-vacuous:
//
//   * ACCOUNTABILITY GATE (the AC, clause-by-clause): a fully-populated record is accountable and
//     appendable; OMITTING or invalidating ANY required clause (actor/owner/reason/state/versions/
//     evidence/scope/time/correlation/outcome) is REJECTED — so an action with a missing field
//     cannot be recorded and therefore cannot be "reported as complete". Each of the eleven+
//     clauses has its own negative control. This mirrors the SQL NOT NULL / CHECK contract in
//     0005_audit_ledger.sql, and the clause codes match the SQL constraint names.
//   * CANONICAL SERIALIZATION: byte-stable for equal content regardless of key insertion order or
//     version-id array order; a changed field changes the canonical form and therefore the digest.
//   * PER-LEDGER HASH CHAINING: previousDigest links to the prior integrityDigest; genesis is the
//     sentinel; sequence is monotone/gap-free; a foreign tenant/ledger is refused; the chain
//     cannot fork.
//   * APPEND VERIFICATION (independent read path): verifyLedger re-derives every digest and
//     detects a mutated field, a reordered/duplicated/dropped record, or a broken link. The digest
//     the writer stored is never trusted — the recomputation is the witness.
//   * SIGNED-CHECKPOINT ROOT: a range root commits to the exact set+order of records; recomputing
//     over a tampered range differs — the substrate that makes truncation/replacement tamper-evident.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hc = await import(join(ROOT, 'packages/audit-ledger/src/hash-chain.ts'));

const {
  AUDIT_OUTCOMES,
  isAuditOutcome,
  COMPLETED_OUTCOMES,
  isCompletedOutcome,
  AUDIT_OUTCOME_BY_OUTCOME_CODE,
  AccountabilityError,
  assertAccountable,
  isAccountable,
  assertReportable,
  canonicalJson,
  canonicalizeAuditRecord,
  contentDigest,
  GENESIS_PREVIOUS_DIGEST,
  deriveIntegrityDigest,
  createLedger,
  appendAuditRecord,
  LedgerAppendError,
  verifyAppend,
  verifyLedger,
  assertLedgerIntact,
  computeCheckpointRoot,
} = hc;

// ---------------------------------------------------------------------------
// Builders. `baseRecord` is a FULLY-accountable governed-completion record; each negative control
// deletes/invalidates exactly one clause via `without` / `withOverride`.

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
    actor: {
      principalId: 'p-1234',
      roleAssignmentId: 'ra-1',
      isSystem: false,
      automationId: null,
    },
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

function without(field) {
  const r = baseRecord();
  delete r[field];
  return r;
}

// ---------------------------------------------------------------------------
// 0. Sanity: the positive control is accountable + appendable (so negatives are meaningful).

test('positive control: a fully-populated record is accountable, reportable, appendable', () => {
  const r = baseRecord();
  assert.doesNotThrow(() => assertAccountable(r));
  assert.equal(isAccountable(r), true);
  assert.doesNotThrow(() => assertReportable(r));
  const ledger = appendAuditRecord(createLedger(T, L), r);
  assert.equal(ledger.records.length, 1);
});

// ---------------------------------------------------------------------------
// 1. ACCOUNTABILITY GATE — the AC, clause by clause. Each clause: OMITTING it is rejected.
//    "before it can be reported as complete" ⇒ assertReportable rejects too.

test('AC clause "actor or principal": missing actor entirely is rejected', () => {
  assert.throws(
    () => assertAccountable(without('actor')),
    (e) => e instanceof AccountabilityError && e.clause === 'actor',
  );
});

test('AC clause "actor or principal": no principal and not a system actor is rejected (actor_present)', () => {
  const r = baseRecord({ actor: { principalId: null, isSystem: false, automationId: null } });
  assert.throws(
    () => assertAccountable(r),
    (e) => e.clause === 'actor_present',
  );
  // POSITIVE counterpart: a system actor WITH an automation id is accepted.
  const sys = baseRecord({
    actor: { principalId: null, isSystem: true, automationId: 'auto-9' },
    reason: { code: 'SYS', text: null }, // system ⇒ reason text not required
    outcome: 'uncertain', // avoid governed-completion evidence requirement for a pure system path
  });
  assert.doesNotThrow(() => assertAccountable(sys));
});

test('AC clause "actor or principal": system actor WITHOUT automation id is rejected', () => {
  const r = baseRecord({ actor: { principalId: null, isSystem: true, automationId: null } });
  assert.throws(
    () => assertAccountable(r),
    (e) => e.clause === 'actor_present',
  );
});

test('AC clause "accountable owner": missing accountable owner is rejected', () => {
  assert.throws(
    () => assertAccountable(without('accountableOwnerPrincipalId')),
    (e) => e.clause === 'accountable_owner',
  );
});

test('AC clause "reason": missing reason.code is rejected', () => {
  assert.throws(
    () => assertAccountable(baseRecord({ reason: { text: 'x' } })),
    (e) => e.clause === 'reason',
  );
});

test('AC clause "reason": a human (non-system) action MUST carry human reason text (reason_text_for_human)', () => {
  const r = baseRecord({ reason: { code: 'APPROVED', text: null } });
  assert.throws(
    () => assertAccountable(r),
    (e) => e.clause === 'reason_text_for_human',
  );
});

test('AC clause "source and target state": missing source or target state digest is rejected', () => {
  const noSrc = baseRecord({ state: { ...baseRecord().state, sourceStateDigest: '' } });
  assert.throws(
    () => assertAccountable(noSrc),
    (e) => e.clause === 'source_state',
  );
  const noTgt = baseRecord({ state: { ...baseRecord().state, targetStateDigest: '' } });
  assert.throws(
    () => assertAccountable(noTgt),
    (e) => e.clause === 'target_state',
  );
});

test('AC clause "policy and control versions" + "evidence": a completed governed action requires both + evidence', () => {
  const noPol = baseRecord({
    governance: { policyVersionIds: [], controlVersionIds: ['ctl-1'], evidenceManifestId: 'ev-1' },
  });
  assert.throws(
    () => assertAccountable(noPol),
    (e) => e.clause === 'governed_completion_policy_versions',
  );
  const noCtl = baseRecord({
    governance: { policyVersionIds: ['pol-1'], controlVersionIds: [], evidenceManifestId: 'ev-1' },
  });
  assert.throws(
    () => assertAccountable(noCtl),
    (e) => e.clause === 'governed_completion_control_versions',
  );
  const noEv = baseRecord({
    governance: {
      policyVersionIds: ['pol-1'],
      controlVersionIds: ['ctl-1'],
      evidenceManifestId: null,
    },
  });
  assert.throws(
    () => assertAccountable(noEv),
    (e) => e.clause === 'governed_completion_evidence',
  );
});

test('AC completion rule: a DENIED/REJECTED/FAILED attempt is exempt from the versions+evidence requirement', () => {
  // Never reached completion ⇒ no versions/evidence required, but still fully accountable otherwise.
  const denied = baseRecord({
    outcome: 'denied',
    governance: { policyVersionIds: [], controlVersionIds: [], evidenceManifestId: null },
  });
  assert.doesNotThrow(() => assertAccountable(denied));
});

test('AC clause "scope": missing requested/actual scope objects are rejected', () => {
  assert.throws(
    () => assertAccountable(without('scope')),
    (e) => e.clause === 'scope',
  );
});

test('AC clause "time": missing occurred/recorded time is rejected; recorded cannot precede occurred', () => {
  assert.throws(
    () => assertAccountable(without('timing')),
    (e) => e.clause === 'time',
  );
  const backwards = baseRecord({ timing: { occurredAt: 2000, recordedAt: 1000 } });
  assert.throws(
    () => assertAccountable(backwards),
    (e) => e.clause === 'recorded_after_occurred',
  );
});

test('AC clause "correlation": missing correlation id is rejected', () => {
  assert.throws(
    () => assertAccountable(without('correlation')),
    (e) => e.clause === 'correlation',
  );
});

test('AC clause "outcome": missing/unknown outcome is rejected; the vocabulary is closed', () => {
  assert.throws(
    () => assertAccountable(without('outcome')),
    (e) => e.clause === 'outcome',
  );
  assert.throws(
    () => assertAccountable(baseRecord({ outcome: 'MAYBE' })),
    (e) => e.clause === 'outcome',
  );
  for (const o of AUDIT_OUTCOMES) assert.equal(isAuditOutcome(o), true);
  assert.equal(isAuditOutcome('MAYBE'), false);
  // COMPLETED_OUTCOMES is exactly {succeeded, partial}.
  assert.deepEqual([...COMPLETED_OUTCOMES].sort(), ['partial', 'succeeded']);
  assert.equal(isCompletedOutcome('succeeded'), true);
  assert.equal(isCompletedOutcome('denied'), false);
});

test('AC clause "sequence": sequence must be a positive integer', () => {
  assert.throws(
    () => assertAccountable(baseRecord({ sequence: 0 })),
    (e) => e.clause === 'sequence',
  );
  assert.throws(
    () => assertAccountable(baseRecord({ sequence: 1.5 })),
    (e) => e.clause === 'sequence',
  );
});

test('domain OutcomeCode → AuditOutcome bridge is total and maps duplicate→succeeded, policy_denied→denied', () => {
  assert.equal(AUDIT_OUTCOME_BY_OUTCOME_CODE.duplicate, 'succeeded');
  assert.equal(AUDIT_OUTCOME_BY_OUTCOME_CODE.policy_denied, 'denied');
  assert.equal(AUDIT_OUTCOME_BY_OUTCOME_CODE.uncertain, 'uncertain');
  for (const v of Object.values(AUDIT_OUTCOME_BY_OUTCOME_CODE))
    assert.equal(isAuditOutcome(v), true);
});

// ---------------------------------------------------------------------------
// 2. CANONICAL SERIALIZATION.

test('canonicalJson is byte-stable regardless of key insertion order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  // Negative control: different content ⇒ different canonical form.
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

test('canonicalizeAuditRecord is stable across version-id array order and equal-content re-encoding', () => {
  const a = baseRecord({
    governance: {
      policyVersionIds: ['pol-2', 'pol-1'],
      controlVersionIds: ['ctl-1'],
      evidenceManifestId: 'ev-1',
    },
  });
  const b = baseRecord({
    governance: {
      policyVersionIds: ['pol-1', 'pol-2'],
      controlVersionIds: ['ctl-1'],
      evidenceManifestId: 'ev-1',
    },
  });
  assert.equal(canonicalizeAuditRecord(a), canonicalizeAuditRecord(b));
  assert.equal(contentDigest(a), contentDigest(b));
  // Negative control: a changed field changes the digest.
  const c = baseRecord({ reason: { code: 'APPROVED', text: 'DIFFERENT' } });
  assert.notEqual(contentDigest(a), contentDigest(c));
});

test('canonicalizeAuditRecord refuses to serialize a non-accountable record', () => {
  assert.throws(
    () => canonicalizeAuditRecord(without('outcome')),
    (e) => e instanceof AccountabilityError,
  );
});

// ---------------------------------------------------------------------------
// 3. PER-LEDGER HASH CHAINING.

function chainOf(n) {
  let ledger = createLedger(T, L);
  const recs = [];
  for (let i = 1; i <= n; i++) {
    const r = baseRecord({
      auditEventId: `aaaaaaaa-aaaa-7aaa-8aaa-${String(i).padStart(12, '0')}`,
      sequence: i,
      timing: { occurredAt: 1000 + i, recordedAt: 1500 + i },
    });
    ledger = appendAuditRecord(ledger, r);
    recs.push(ledger.records[ledger.records.length - 1]);
  }
  return { ledger, recs };
}

test('genesis: the first record chains from the genesis sentinel; head advances', () => {
  const { ledger } = chainOf(1);
  assert.equal(ledger.records[0].previousDigest, GENESIS_PREVIOUS_DIGEST);
  assert.equal(ledger.headDigest, ledger.records[0].integrityDigest);
  assert.equal(ledger.nextSequence, 2);
});

test('each record.previousDigest links to the prior record.integrityDigest', () => {
  const { recs } = chainOf(3);
  assert.equal(recs[0].previousDigest, GENESIS_PREVIOUS_DIGEST);
  assert.equal(recs[1].previousDigest, recs[0].integrityDigest);
  assert.equal(recs[2].previousDigest, recs[1].integrityDigest);
  // integrityDigest = sha256(previousDigest || contentDigest) — re-derivable.
  assert.equal(recs[1].integrityDigest, deriveIntegrityDigest(recs[0].integrityDigest, recs[1]));
});

test('integrityDigest genuinely DEPENDS on the predecessor: identical content, different previousDigest ⇒ different digest', () => {
  // This pins the chain PROPERTY independently of the derivation formula: a record's integrity
  // digest must differ when its predecessor differs, otherwise records could be re-parented (moved
  // to another ledger or position) without changing their digest. Re-deriving with the same
  // (possibly-broken) formula cannot catch that regression; comparing two predecessors can.
  const r = baseRecord({ sequence: 1 });
  const predecessorA = 'a'.repeat(64);
  const predecessorB = 'b'.repeat(64);
  const digestA = deriveIntegrityDigest(predecessorA, r);
  const digestB = deriveIntegrityDigest(predecessorB, r);
  assert.notEqual(digestA, digestB);
  // And the genesis record's digest differs from the same content chained after another record —
  // so a genesis row cannot be swapped for a mid-chain row of identical content.
  assert.notEqual(deriveIntegrityDigest(GENESIS_PREVIOUS_DIGEST, r), digestA);
});

test('append is immutable: the input ledger is untouched (a NEW ledger is returned)', () => {
  const l0 = createLedger(T, L);
  const l1 = appendAuditRecord(l0, baseRecord());
  assert.equal(l0.records.length, 0);
  assert.equal(l1.records.length, 1);
  assert.notEqual(l0, l1);
});

test('sequence gap / reorder / duplicate is refused at append', () => {
  const l1 = appendAuditRecord(createLedger(T, L), baseRecord({ sequence: 1 }));
  // Next must be sequence 2 — a duplicate 1 or a skip to 3 is refused.
  assert.throws(
    () => appendAuditRecord(l1, baseRecord({ sequence: 1 })),
    (e) => e instanceof LedgerAppendError && e.reason === 'sequence_gap',
  );
  assert.throws(
    () => appendAuditRecord(l1, baseRecord({ sequence: 3 })),
    (e) => e.reason === 'sequence_gap',
  );
});

test('a record for a foreign tenant/ledger is refused (chain cannot mix ledgers)', () => {
  const l1 = createLedger(T, L);
  assert.throws(
    () => appendAuditRecord(l1, baseRecord({ tenantId: '99999999-9999-7999-8999-999999999999' })),
    (e) => e.reason === 'ledger_mismatch',
  );
});

// ---------------------------------------------------------------------------
// 4. APPEND VERIFICATION — the independent read path.

test('verifyLedger accepts an intact chain and re-derives every digest independently', () => {
  const { recs } = chainOf(4);
  const result = verifyLedger(T, L, recs);
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => assertLedgerIntact(T, L, recs));
});

test('verifyLedger detects a MUTATED field (stored digest not trusted)', () => {
  const { recs } = chainOf(3);
  // Tamper the middle record's content but keep its stored digests (a naive forger).
  const tampered = recs.slice();
  tampered[1] = { ...recs[1], reason: { code: 'APPROVED', text: 'TAMPERED' } };
  const result = verifyLedger(T, L, tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'digest_mismatch');
  assert.equal(result.sequence, 2);
});

test('verifyLedger detects a DROPPED record (truncation) via sequence + broken link', () => {
  const { recs } = chainOf(3);
  const dropped = [recs[0], recs[2]]; // remove seq 2
  const result = verifyLedger(T, L, dropped);
  assert.equal(result.ok, false);
  // seq check fires first (record at index 1 has sequence 3, expected 2).
  assert.equal(result.reason, 'sequence_gap');
});

test('verifyLedger detects a REORDERED chain', () => {
  const { recs } = chainOf(3);
  const reordered = [recs[0], recs[2], recs[1]];
  const result = verifyLedger(T, L, reordered);
  assert.equal(result.ok, false);
});

test('verifyLedger detects a BROKEN LINK (previousDigest re-pointed)', () => {
  const { recs } = chainOf(3);
  const forged = recs.slice();
  forged[2] = { ...recs[2], previousDigest: GENESIS_PREVIOUS_DIGEST };
  const result = verifyLedger(T, L, forged);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'broken_link');
});

test('verifyAppend rejects a non-accountable record on the read path', () => {
  const bad = { ...baseRecord(), previousDigest: GENESIS_PREVIOUS_DIGEST, integrityDigest: 'x' };
  delete bad.outcome;
  const result = verifyAppend(
    { tenantId: T, ledgerId: L, sequence: 1, previousDigest: GENESIS_PREVIOUS_DIGEST },
    bad,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /^accountability:/);
});

// ---------------------------------------------------------------------------
// 5. SIGNED-CHECKPOINT ROOT.

test('computeCheckpointRoot commits to the exact range; a tampered range yields a different root', () => {
  const { recs } = chainOf(5);
  const cp = computeCheckpointRoot(T, L, recs);
  assert.equal(cp.firstSequence, 1);
  assert.equal(cp.lastSequence, 5);
  assert.equal(cp.eventCount, 5);
  assert.equal(cp.headIntegrityDigest, recs[4].integrityDigest);
  // Recompute over the same range ⇒ identical root (determinism).
  assert.equal(computeCheckpointRoot(T, L, recs).rootDigest, cp.rootDigest);
  // Negative control: dropping a record makes the range non-intact ⇒ refuses to checkpoint.
  assert.throws(() => computeCheckpointRoot(T, L, [recs[0], recs[2], recs[3], recs[4]]));
  // Negative control: empty range refused.
  assert.throws(
    () => computeCheckpointRoot(T, L, []),
    (e) => e instanceof LedgerAppendError,
  );
});
