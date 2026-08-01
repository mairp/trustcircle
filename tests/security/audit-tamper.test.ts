// Security-suite test — AUDIT LEDGER TAMPER-EVIDENCE & ACCOUNTABILITY COMPLETENESS
// (Phase 32 / Bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item Z1Y8HAD0SJJ28K8XSS9N0NVTKP).
//
// Phase AC (the completeness gate this suite proves):
//   "Every decision and automated action MUST capture actor or principal, accountable owner,
//    reason, source and target state, policy and control versions, evidence, scope, time,
//    correlation, and outcome BEFORE it can be reported as complete."
//   (GAR-002 / VO-d76c5d1293b91d26e094, and the many contract oracles whose common obligation is
//    a complete, tamper-evident accountability record for every decision/automated action.)
//
// This file exercises the ALREADY-IMPLEMENTED runtime audit ledger through its declared source
// entry points so a regression is caught by `vitest run --project security`:
//
//   packages/audit-ledger/src/hash-chain.ts   — accountability completeness + per-ledger hash chain
//   packages/audit-ledger/src/checkpoints.ts  — Ed25519 signed checkpoints + append-only verification
//
// Four concerns, each an INDEPENDENT read-path oracle (the recomputation/re-verification is the
// witness, never the writer's stored value):
//
//   1. AUDIT COMPLETENESS — every AC clause is required before an action can be reported complete
//      (assertAccountable / assertReportable / isAccountable). One positive + one targeted negative
//      per clause; the negatives prove the oracle is non-vacuous.
//   2. REORDER / UPDATE / DELETE DETECTION — a reordered, duplicated, dropped, or field-mutated
//      record breaks the chain and is caught by verifyAppend / verifyLedger, AND the physical
//      ledger is append-only (no UPDATE / no DELETE) enforced by 0005_audit_ledger.sql triggers.
//   3. CHECKPOINT VERIFICATION — signCheckpoint / verifyCheckpointSignature /
//      verifyPublishedCheckpoint / verifyCheckpointLog make truncation / replacement / re-signing
//      tamper-evident; a wrong key, altered range, or dropped whole checkpoint is detected.
//   4. OPERATION FREEZE BEHAVIOR — (a) an incomplete action is FROZEN OUT of being reported complete
//      / appended / checkpointed; (b) a detected tamper is STICKY (`tampered` can never be laundered
//      back to `verified`), and only a currently-verified checkpoint may be anchored; (c) every
//      returned structure is deep-frozen and the input is never mutated.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  // completeness
  assertAccountable,
  assertReportable,
  isAccountable,
  AccountabilityError,
  AUDIT_OUTCOMES,
  // canonicalization + chain
  canonicalJson,
  contentDigest,
  deriveIntegrityDigest,
  GENESIS_PREVIOUS_DIGEST,
  createLedger,
  appendAuditRecord,
  LedgerAppendError,
  verifyAppend,
  verifyLedger,
  assertLedgerIntact,
  type AccountabilityRecord,
  type ChainedAuditRecord,
} from '../../packages/audit-ledger/src/hash-chain.ts';

import {
  generateSigningKey,
  verificationKeyFor,
  signCheckpoint,
  verifyCheckpointSignature,
  createCheckpointLog,
  publishCheckpoint,
  verifyCheckpointLog,
  verifyPublishedCheckpoint,
  appendVerification,
  verifyAndRecord,
  anchorCheckpoint,
  CheckpointError,
  CHECKPOINT_SIGNATURE_ALGORITHM,
} from '../../packages/audit-ledger/src/checkpoints.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT_MIGRATION = readFileSync(
  join(ROOT, 'db', 'migrations', '0005_audit_ledger.sql'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Fixtures — a fully-accountable record builder. The base carries EVERY AC clause; each negative
// test starts from this valid base and removes exactly one clause, so the failure is attributable
// to that clause alone.
// ---------------------------------------------------------------------------

const TENANT = '11111111-1111-1111-1111-111111111111';
const LEDGER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function baseRecord(overrides: Partial<AccountabilityRecord> = {}): AccountabilityRecord {
  const rec: AccountabilityRecord = {
    auditEventId: '01900000-0000-7000-8000-000000000001',
    tenantId: TENANT,
    ledgerId: LEDGER,
    sequence: 1,
    eventType: 'decision.approved',
    schemaVersion: '1.0.0',
    actor: {
      principalId: 'user:alice',
      roleAssignmentId: 'ra:approver-1',
      isSystem: false,
      automationId: null,
    },
    accountableOwnerPrincipalId: 'user:owner-bob',
    reason: { code: 'APPROVE_LOW_RISK', text: 'preconditions passed; within policy bounds' },
    state: {
      entityType: 'decision',
      entityId: 'dec-123',
      entityVersion: 'v3',
      sourceStateDigest: 'src-digest-aaa',
      targetStateDigest: 'tgt-digest-bbb',
      actualStateDigest: null,
    },
    governance: {
      policyVersionIds: ['pol:v7'],
      controlVersionIds: ['ctl:v2'],
      evidenceManifestId: 'evm:manifest-1',
    },
    scope: { requested: { tenant: TENANT }, actual: { tenant: TENANT } },
    timing: { occurredAt: 1_700_000_000_000, recordedAt: 1_700_000_000_500 },
    correlation: { correlationId: 'corr-1', causationId: 'cau-1', traceId: 'trace-1' },
    outcome: 'succeeded',
    ...overrides,
  };
  return rec;
}

/** A fully-accountable "system/automated action" record (no human principal, exempt from human-only clauses). */
function systemRecord(overrides: Partial<AccountabilityRecord> = {}): AccountabilityRecord {
  return baseRecord({
    eventType: 'reconcile.observed',
    actor: {
      principalId: null,
      roleAssignmentId: null,
      isSystem: true,
      automationId: 'auto:reconciler',
    },
    reason: { code: 'OBSERVE', text: null },
    outcome: 'uncertain',
    ...overrides,
  });
}

/** Build a valid intact ledger of N contiguous records for chain/checkpoint tests. */
function buildLedger(n: number) {
  let ledger = createLedger(TENANT, LEDGER);
  for (let i = 1; i <= n; i++) {
    ledger = appendAuditRecord(
      ledger,
      baseRecord({
        auditEventId: `01900000-0000-7000-8000-00000000000${i}`,
        sequence: i,
        correlation: { correlationId: `corr-${i}`, causationId: `cau-${i}`, traceId: `trace-${i}` },
      }),
    );
  }
  return ledger;
}

// ===========================================================================
// 1. AUDIT COMPLETENESS — every AC clause required before "reported as complete".
// ===========================================================================

describe('audit completeness — every accountability clause is required before an action can be reported complete', () => {
  it('a fully-populated record passes assertAccountable / assertReportable / isAccountable', () => {
    const r = baseRecord();
    expect(() => assertAccountable(r)).not.toThrow();
    expect(() => assertReportable(r)).not.toThrow(); // reporting-boundary alias of the same gate
    expect(isAccountable(r)).toBe(true);
  });

  it('a fully-accountable SYSTEM/automated action also passes (automation id stands in for a human principal)', () => {
    const r = systemRecord();
    expect(isAccountable(r)).toBe(true);
    expect(() => assertReportable(r)).not.toThrow();
  });

  // One negative per AC clause. Each removes exactly one clause from a valid base and asserts the
  // named AccountabilityError.clause — so completeness is enforced clause-by-clause, not in bulk.
  const clauseCases: ReadonlyArray<{
    readonly label: string;
    readonly mutate: (r: AccountabilityRecord) => unknown;
    readonly clause: RegExp;
  }> = [
    {
      label: 'ACTOR or PRINCIPAL — neither a principal nor a system automation id',
      mutate: (r) => ({ ...r, actor: { isSystem: false, principalId: null, automationId: null } }),
      clause: /actor/,
    },
    {
      label: 'ACCOUNTABLE OWNER — missing',
      mutate: (r) => ({ ...r, accountableOwnerPrincipalId: '' }),
      clause: /accountable_owner/,
    },
    {
      label: 'REASON — missing reason code',
      mutate: (r) => ({ ...r, reason: { code: '', text: 'x' } }),
      clause: /reason/,
    },
    {
      label: 'REASON — human action missing reason text',
      mutate: (r) => ({ ...r, reason: { code: 'X', text: null } }),
      clause: /reason_text_for_human/,
    },
    {
      label: 'SOURCE STATE — missing source state digest',
      mutate: (r) => ({ ...r, state: { ...r.state, sourceStateDigest: '' } }),
      clause: /source_state/,
    },
    {
      label: 'TARGET STATE — missing target state digest',
      mutate: (r) => ({ ...r, state: { ...r.state, targetStateDigest: '' } }),
      clause: /target_state/,
    },
    {
      label: 'POLICY AND CONTROL VERSIONS — governance arrays absent',
      mutate: (r) => ({ ...r, governance: { evidenceManifestId: 'e' } }),
      clause: /governance/,
    },
    {
      label: 'EVIDENCE — completed governed action missing evidence manifest',
      mutate: (r) => ({ ...r, governance: { ...r.governance, evidenceManifestId: null } }),
      clause: /governed_completion_evidence/,
    },
    {
      label: 'SCOPE — requested/actual scope objects absent',
      mutate: (r) => ({ ...r, scope: undefined }),
      clause: /scope/,
    },
    {
      label: 'TIME — timing absent',
      mutate: (r) => ({ ...r, timing: undefined }),
      clause: /time/,
    },
    {
      label: 'TIME — recorded time precedes occurrence time',
      mutate: (r) => ({ ...r, timing: { occurredAt: 1000, recordedAt: 999 } }),
      clause: /recorded_after_occurred/,
    },
    {
      label: 'CORRELATION — correlation id absent',
      mutate: (r) => ({ ...r, correlation: { correlationId: '' } }),
      clause: /correlation/,
    },
    {
      label: 'OUTCOME — not a known outcome',
      mutate: (r) => ({ ...r, outcome: 'not-a-real-outcome' }),
      clause: /outcome/,
    },
    {
      label: 'POLICY VERSIONS — completed governed action with zero policy versions',
      mutate: (r) => ({ ...r, governance: { ...r.governance, policyVersionIds: [] } }),
      clause: /governed_completion_policy_versions/,
    },
    {
      label: 'CONTROL VERSIONS — completed governed action with zero control versions',
      mutate: (r) => ({ ...r, governance: { ...r.governance, controlVersionIds: [] } }),
      clause: /governed_completion_control_versions/,
    },
  ];

  for (const c of clauseCases) {
    it(`rejects an incomplete action — ${c.label}`, () => {
      const bad = c.mutate(baseRecord());
      expect(isAccountable(bad)).toBe(false);
      let thrown: unknown;
      try {
        assertReportable(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AccountabilityError);
      expect((thrown as AccountabilityError).clause).toMatch(c.clause);
    });
  }

  it('the outcome vocabulary is exactly the closed AC set (every action resolves to a known outcome)', () => {
    // Non-vacuous: at least request/decide/execute/reconcile outcomes are representable.
    for (const o of ['succeeded', 'partial', 'failed', 'denied', 'uncertain']) {
      expect(AUDIT_OUTCOMES).toContain(o);
    }
    expect(() =>
      assertAccountable(baseRecord({ outcome: 'denied' } as Partial<AccountabilityRecord>)),
    ).not.toThrow();
  });
});

// ===========================================================================
// 2. REORDER / UPDATE / DELETE DETECTION — chain-level (recomputed) + physical append-only DDL.
// ===========================================================================

describe('reorder / update / delete detection — a tamper to any record is caught by the independent read path', () => {
  it('appending binds each record to its predecessor (integrityDigest = f(previousDigest, content))', () => {
    const ledger = buildLedger(3);
    expect(ledger.records).toHaveLength(3);
    expect(ledger.records[0]!.previousDigest).toBe(GENESIS_PREVIOUS_DIGEST);
    // Chain is intact when verified independently (recomputes every digest from content).
    expect(verifyLedger(TENANT, LEDGER, ledger.records).ok).toBe(true);
    expect(() => assertLedgerIntact(TENANT, LEDGER, ledger.records)).not.toThrow();
  });

  it('DETECTS A FIELD UPDATE — mutating a recorded field breaks the digest (content was altered)', () => {
    const ledger = buildLedger(3);
    const tampered = [...ledger.records];
    // Alter the outcome of record #2 WITHOUT re-deriving its digest (an in-place edit / DB UPDATE).
    tampered[1] = { ...tampered[1]!, outcome: 'denied' } as ChainedAuditRecord;
    const res = verifyLedger(TENANT, LEDGER, tampered);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('digest_mismatch');
    expect(res.sequence).toBe(2);
  });

  it('DETECTS A DELETE — dropping a record leaves a broken link / sequence gap in the chain', () => {
    const ledger = buildLedger(3);
    const withHole = [ledger.records[0]!, ledger.records[2]!]; // record #2 deleted
    const res = verifyLedger(TENANT, LEDGER, withHole);
    expect(res.ok).toBe(false);
    // record #2 (now at index 1) has sequence 3, so the monotone sequence check fires first.
    expect(res.reason === 'sequence_gap' || res.reason === 'broken_link').toBe(true);
  });

  it('DETECTS A REORDER — swapping two records breaks both the sequence and the chain link', () => {
    const ledger = buildLedger(3);
    const reordered = [ledger.records[0]!, ledger.records[2]!, ledger.records[1]!];
    const res = verifyLedger(TENANT, LEDGER, reordered);
    expect(res.ok).toBe(false);
    expect(res.reason === 'sequence_gap' || res.reason === 'broken_link').toBe(true);
  });

  it('DETECTS A DUPLICATE / REPLAY — re-appending the same record is refused (monotone, gap-free)', () => {
    const ledger = buildLedger(2);
    // Attempt to append a record whose sequence is not nextSequence (a duplicate/out-of-order write).
    expect(() => appendAuditRecord(ledger, baseRecord({ sequence: 2 }))).toThrow(LedgerAppendError);
    try {
      appendAuditRecord(ledger, baseRecord({ sequence: 2 }));
    } catch (e) {
      expect((e as LedgerAppendError).reason).toBe('sequence_gap');
    }
  });

  it('DETECTS A CROSS-LEDGER GRAFT — a record from another ledger cannot be spliced in', () => {
    const ledger = buildLedger(1);
    const foreign = {
      ...ledger.records[0]!,
      tenantId: '99999999-9999-9999-9999-999999999999',
    } as ChainedAuditRecord;
    const res = verifyAppend(
      { tenantId: TENANT, ledgerId: LEDGER, sequence: 1, previousDigest: GENESIS_PREVIOUS_DIGEST },
      foreign,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ledger_mismatch');
  });

  it('a forged integrityDigest does not survive re-derivation (writer value is never trusted)', () => {
    const ledger = buildLedger(1);
    const forged = { ...ledger.records[0]!, integrityDigest: 'f'.repeat(64) } as ChainedAuditRecord;
    const res = verifyAppend(
      { tenantId: TENANT, ledgerId: LEDGER, sequence: 1, previousDigest: GENESIS_PREVIOUS_DIGEST },
      forged,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('digest_mismatch');
  });

  it('canonicalization is order-independent so the digest tracks CONTENT, not key insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: [3, 2, 1] });
    const b = canonicalJson({ c: [3, 2, 1], a: 2, b: 1 });
    expect(a).toBe(b);
    // Two records equal in content have equal content digests; a single-field change diverges them.
    const r1 = baseRecord();
    const r2 = baseRecord();
    expect(contentDigest(r1)).toBe(contentDigest(r2));
    expect(contentDigest(r1)).not.toBe(contentDigest(baseRecord({ outcome: 'denied' })));
    // deriveIntegrityDigest is a pure function of (previousDigest, content).
    expect(deriveIntegrityDigest(GENESIS_PREVIOUS_DIGEST, r1)).toBe(
      deriveIntegrityDigest(GENESIS_PREVIOUS_DIGEST, r2),
    );
  });

  // Physical layer: the ledger table is append-only by DDL. Parse the migration so a silent removal
  // of either guard is caught here (mirrors tests/security/tenant-rls.test.ts's SQL-parsing style).
  it('the physical ledger table REJECTS UPDATE via a BEFORE UPDATE trigger (append-only)', () => {
    expect(/CREATE\s+TRIGGER\s+audit_event_append_only_update/i.test(AUDIT_MIGRATION)).toBe(true);
    expect(/BEFORE\s+UPDATE\s+ON\s+audit_event/i.test(AUDIT_MIGRATION)).toBe(true);
    expect(/audit_event is append-only/i.test(AUDIT_MIGRATION)).toBe(true);
  });

  it('the physical ledger table REJECTS DELETE via a BEFORE DELETE trigger (append-only)', () => {
    expect(/CREATE\s+TRIGGER\s+audit_event_append_only_delete/i.test(AUDIT_MIGRATION)).toBe(true);
    expect(/BEFORE\s+DELETE\s+ON\s+audit_event/i.test(AUDIT_MIGRATION)).toBe(true);
  });

  it('the physical CHECKPOINT table is likewise append-only (signed range/root cannot be rewritten)', () => {
    expect(/CREATE\s+TRIGGER\s+audit_checkpoint_append_only_update/i.test(AUDIT_MIGRATION)).toBe(
      true,
    );
    expect(/BEFORE\s+UPDATE\s+ON\s+audit_checkpoint/i.test(AUDIT_MIGRATION)).toBe(true);
  });
});

// ===========================================================================
// 3. CHECKPOINT VERIFICATION — signed checkpoints make truncation/replacement tamper-evident.
// ===========================================================================

describe('checkpoint verification — a signed checkpoint over a ledger range is independently verifiable', () => {
  it('a signed checkpoint over an intact range verifies (signature + recomputed root + head digest)', () => {
    const ledger = buildLedger(4);
    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published', outcome: 'succeeded' }),
      generatedAt: 1_700_000_100_000,
    });
    expect(cp.status).toBe('signed');
    expect(cp.signatureAlgorithm).toBe(CHECKPOINT_SIGNATURE_ALGORITHM);
    // Independent signature check against the verification key.
    expect(verifyCheckpointSignature(cp, verificationKeyFor(key))).toBeNull();
    // Full independent verification against the re-read records.
    const v = verifyPublishedCheckpoint({
      checkpoint: cp,
      records: ledger.records,
      key: verificationKeyFor(key),
      action: systemRecord({ eventType: 'checkpoint.verified', outcome: 'succeeded' }),
    });
    expect(v.result).toBe('verified');
    expect(v.reason).toBeNull();
  });

  it('DETECTS A WRONG KEY — a signature from another key does not verify', () => {
    const ledger = buildLedger(2);
    const key = generateSigningKey('kid-1');
    const other = generateSigningKey('kid-2');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    expect(verifyCheckpointSignature(cp, verificationKeyFor(other))).toBe('key_id_mismatch');
    // Same key id but different key material → bad_signature.
    const impostor = { keyId: 'kid-1', publicKey: verificationKeyFor(other).publicKey };
    expect(verifyCheckpointSignature(cp, impostor)).toBe('bad_signature');
  });

  it('DETECTS A TRUNCATED RANGE — dropping the last covered record fails root recomputation', () => {
    const ledger = buildLedger(4);
    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    const truncated = ledger.records.slice(0, 3); // hide the 4th record
    const v = verifyPublishedCheckpoint({
      checkpoint: cp,
      records: truncated,
      key: verificationKeyFor(key),
      action: systemRecord({ eventType: 'checkpoint.verified' }),
    });
    expect(v.result).toBe('tampered');
    // count/bounds mismatch or a root mismatch — any is a valid tamper signal for truncation.
    expect(v.reason).toMatch(/range_count_mismatch|range_bounds_mismatch|root_digest_mismatch/);
  });

  it('DETECTS A REPLACED RECORD IN RANGE — altering a covered record diverges the recomputed root', () => {
    const ledger = buildLedger(4);
    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    const swapped = [...ledger.records];
    swapped[2] = { ...swapped[2]!, outcome: 'denied' } as ChainedAuditRecord;
    const v = verifyPublishedCheckpoint({
      checkpoint: cp,
      records: swapped,
      key: verificationKeyFor(key),
      action: systemRecord({ eventType: 'checkpoint.verified' }),
    });
    expect(v.result).toBe('tampered');
    // The altered record fails the sub-chain re-derivation before the root compare.
    expect(v.reason).toMatch(/chain:|root_digest_mismatch/);
  });

  it('signCheckpoint refuses to sign a BROKEN range (a checkpoint can never bless a tamper)', () => {
    const ledger = buildLedger(3);
    const key = generateSigningKey('kid-1');
    const broken = [...ledger.records];
    broken[1] = { ...broken[1]!, outcome: 'denied' } as ChainedAuditRecord; // mutated, digest stale
    expect(() =>
      signCheckpoint({
        checkpointId: 'cp-broken',
        key,
        records: broken,
        previousRootDigest: GENESIS_PREVIOUS_DIGEST,
        action: baseRecord({ eventType: 'checkpoint.published' }),
        generatedAt: 1_700_000_100_000,
      }),
    ).toThrow(LedgerAppendError); // computeCheckpointRoot asserts intactness first
  });

  it('the checkpoint LOG is chained + monotone — a dropped whole checkpoint is detected', () => {
    const l4 = buildLedger(4);
    const l6 = buildLedger(6);
    const key = generateSigningKey('kid-1');
    let log = createCheckpointLog(TENANT, LEDGER);
    const cp1 = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: l4.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    log = publishCheckpoint(log, cp1);
    const cp2 = signCheckpoint({
      checkpointId: 'cp-2',
      key,
      records: l6.records,
      previousRootDigest: cp1.rootDigest, // chains to the prior checkpoint's root
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_200_000,
    });
    log = publishCheckpoint(log, cp2);
    expect(verifyCheckpointLog(log, verificationKeyFor(key)).ok).toBe(true);

    // Drop the first checkpoint: the second's previousRootDigest no longer links to genesis.
    const gapped = { ...log, checkpoints: [cp2] };
    const res = verifyCheckpointLog(gapped, verificationKeyFor(key));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('broken_checkpoint_chain');
  });

  it('publishCheckpoint refuses truncation/replay — a shorter/equal re-publication is rejected', () => {
    const l4 = buildLedger(4);
    const key = generateSigningKey('kid-1');
    let log = createCheckpointLog(TENANT, LEDGER);
    const cp1 = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: l4.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    log = publishCheckpoint(log, cp1);
    // Re-publish an equal-coverage checkpoint (would truncate/replay coverage) → refused.
    const cpDup = signCheckpoint({
      checkpointId: 'cp-dup',
      key,
      records: l4.records,
      previousRootDigest: cp1.rootDigest,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_150_000,
    });
    expect(() => publishCheckpoint(log, cpDup)).toThrow(CheckpointError);
    try {
      publishCheckpoint(log, cpDup);
    } catch (e) {
      expect((e as CheckpointError).message).toMatch(/non_monotone_coverage|extend/i);
    }
  });
});

// ===========================================================================
// 4. OPERATION FREEZE BEHAVIOR — incomplete actions frozen out; tamper sticky; structures immutable.
// ===========================================================================

describe('operation freeze behavior — an incomplete or tampered operation cannot be blessed as complete', () => {
  it('FREEZE: an incomplete action can never be APPENDED (so it can never be reported complete)', () => {
    const ledger = createLedger(TENANT, LEDGER);
    const incomplete = { ...baseRecord(), accountableOwnerPrincipalId: '' };
    expect(() => appendAuditRecord(ledger, incomplete as AccountabilityRecord)).toThrow(
      AccountabilityError,
    );
    // The ledger is untouched — the failed operation produced no durable record.
    expect(ledger.records).toHaveLength(0);
    expect(ledger.nextSequence).toBe(1);
  });

  it('FREEZE: an incomplete publish action can never be CHECKPOINTED', () => {
    const ledger = buildLedger(2);
    const key = generateSigningKey('kid-1');
    expect(() =>
      signCheckpoint({
        checkpointId: 'cp-x',
        key,
        records: ledger.records,
        previousRootDigest: GENESIS_PREVIOUS_DIGEST,
        action: { ...baseRecord(), reason: { code: '', text: null } } as AccountabilityRecord,
        generatedAt: 1_700_000_100_000,
      }),
    ).toThrow(AccountabilityError);
  });

  it('STICKY TAMPER: once a checkpoint is found tampered, a later passing verification cannot launder it back', () => {
    const ledger = buildLedger(3);
    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });

    // First verification: against a TAMPERED range → tampered.
    const tamperedRange = [...ledger.records];
    tamperedRange[1] = { ...tamperedRange[1]!, outcome: 'denied' } as ChainedAuditRecord;
    const r1 = verifyAndRecord({
      checkpoint: cp,
      records: tamperedRange,
      key: verificationKeyFor(key),
      action: systemRecord({
        eventType: 'checkpoint.verified',
        timing: { occurredAt: 1, recordedAt: 2 },
      }),
    });
    expect(r1.verification.result).toBe('tampered');
    expect(r1.checkpoint.status).toBe('tampered');

    // Second verification: against the CLEAN range → verified, but the status STAYS tampered.
    const r2 = verifyAndRecord({
      checkpoint: r1.checkpoint,
      records: ledger.records,
      key: verificationKeyFor(key),
      action: systemRecord({
        eventType: 'checkpoint.verified',
        timing: { occurredAt: 3, recordedAt: 4 },
      }),
    });
    expect(r2.verification.result).toBe('verified'); // the pass itself is recorded truthfully
    expect(r2.checkpoint.status).toBe('tampered'); // …but the checkpoint remains frozen as tampered
    // Append-only history retains BOTH passes (nothing overwritten).
    expect(r2.checkpoint.verificationHistory.map((v) => v.result)).toEqual([
      'tampered',
      'verified',
    ]);
  });

  it('ANCHOR GATE: a tampered/unverified checkpoint cannot be promoted to anchored', () => {
    const ledger = buildLedger(2);
    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    // status is 'signed' (not yet verified) → anchoring refused.
    expect(() => anchorCheckpoint(cp, 'anchor://ref')).toThrow(CheckpointError);

    // Verify it, THEN anchoring is allowed.
    const { checkpoint: verified } = verifyAndRecord({
      checkpoint: cp,
      records: ledger.records,
      key: verificationKeyFor(key),
      action: systemRecord({
        eventType: 'checkpoint.verified',
        timing: { occurredAt: 1, recordedAt: 2 },
      }),
    });
    expect(verified.status).toBe('verified');
    const anchored = anchorCheckpoint(verified, 'anchor://ref');
    expect(anchored.status).toBe('anchored');
    expect(anchored.externalAnchorRef).toBe('anchor://ref');
  });

  it('IMMUTABILITY: ledgers and checkpoints are deep-frozen; appends/verifications return NEW values', () => {
    const l0 = createLedger(TENANT, LEDGER);
    expect(Object.isFrozen(l0)).toBe(true);
    expect(Object.isFrozen(l0.records)).toBe(true);

    const l1 = appendAuditRecord(l0, baseRecord({ sequence: 1 }));
    expect(l1).not.toBe(l0); // new value
    expect(l0.records).toHaveLength(0); // input untouched
    expect(l1.records).toHaveLength(1);
    expect(Object.isFrozen(l1.records[0]!)).toBe(true);

    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: l1.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    expect(Object.isFrozen(cp)).toBe(true);
    const verification = verifyPublishedCheckpoint({
      checkpoint: cp,
      records: l1.records,
      key: verificationKeyFor(key),
      action: systemRecord({
        eventType: 'checkpoint.verified',
        timing: { occurredAt: 1, recordedAt: 2 },
      }),
    });
    const cp2 = appendVerification(cp, verification);
    expect(cp2).not.toBe(cp);
    expect(cp.verificationHistory).toHaveLength(0); // signed row never mutated in place
    expect(cp2.verificationHistory).toHaveLength(1);
  });

  it('APPEND-ONLY HISTORY: verification records must be monotone/gap-free (history cannot be rewritten)', () => {
    const ledger = buildLedger(2);
    const key = generateSigningKey('kid-1');
    const cp = signCheckpoint({
      checkpointId: 'cp-1',
      key,
      records: ledger.records,
      previousRootDigest: GENESIS_PREVIOUS_DIGEST,
      action: baseRecord({ eventType: 'checkpoint.published' }),
      generatedAt: 1_700_000_100_000,
    });
    const v1 = verifyPublishedCheckpoint({
      checkpoint: cp,
      records: ledger.records,
      key: verificationKeyFor(key),
      action: systemRecord({
        eventType: 'checkpoint.verified',
        timing: { occurredAt: 1, recordedAt: 2 },
      }),
    });
    const cp1 = appendVerification(cp, v1);
    // Re-appending a verification at the SAME sequence (an overwrite) is refused.
    expect(() => appendVerification(cp1, { ...v1 })).toThrow(CheckpointError);
    try {
      appendVerification(cp1, { ...v1 });
    } catch (e) {
      expect((e as CheckpointError).message).toMatch(/sequence/i);
    }
  });
});
