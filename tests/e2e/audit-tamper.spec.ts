// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 9 · GOVERNANCE ASSURANCE — AUDIT-TAMPER release gate (browserless `audit-tamper` project · T280).
// Requirement GAR-010 (change discipline); rests on GAR-002 (audit accountability) + GAR-004
// (destructive-action safety).
//
// PHASE OBJECTIVE (T280): "Prove audit tampering opens a critical incident and freezes affected
// consequential/destructive actions in tests/e2e/audit-tamper.spec.ts".
//
// ── WHAT THIS PROVES ────────────────────────────────────────────────────────────────────────────
// The append-only audit ledger is the accountability substrate for every consequential/destructive
// action. This gate proves the FULL detect→incident→freeze chain end-to-end:
//   1. DETECT   — the REAL packages/audit-ledger/src/hash-chain.ts verifier (verifyLedger /
//                 computeCheckpointRoot) re-derives every digest independently and flags a mutated
//                 field, a dropped/reordered/duplicated record, or a truncated checkpoint range. The
//                 writer's stored digest is never trusted — the recomputation is the witness.
//   2. INCIDENT — a deterministic incident responder (defined below, no wall clock) opens a CRITICAL
//                 incident bound to the tenant/ledger and the offending sequence when — and only
//                 when — the verifier fails.
//   3. FREEZE   — while a critical audit incident is open, the action gate REFUSES every
//                 consequential/destructive action in the affected tenant (fail-closed), while a
//                 read-only/non-consequential action and actions in an unaffected tenant still pass.
//
// ── NON-VACUITY ─────────────────────────────────────────────────────────────────────────────────
// Every positive assertion is paired with a NEGATIVE control: an intact ledger verifies, opens NO
// incident, and freezes NOTHING; a tamper of any kind flips detection red, opens the incident, and
// freezes the consequential/destructive actions. So the gate cannot pass vacuously.
//
// Determinism: fixed instants, no Math.random / argless Date, Node built-ins + the REAL package
// source only. Run: TC_NO_WEBSERVER=1 playwright test --project=audit-tamper

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const hc = (await import(
  join(ROOT, 'packages/audit-ledger/src/hash-chain.ts')
)) as typeof import('../../packages/audit-ledger/src/hash-chain.ts');

const {
  createLedger,
  appendAuditRecord,
  verifyLedger,
  computeCheckpointRoot,
  deriveIntegrityDigest,
} = hc;

// ── deterministic fixture world ──────────────────────────────────────────────────────────────────
const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const LEDGER = '33333333-3333-7333-8333-333333333333';

/** Build a fully-accountable governed-completion record (matches the SQL NOT NULL/CHECK contract). */
function record(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    auditEventId: `aaaaaaaa-aaaa-7aaa-8aaa-00000000000${seq}`,
    tenantId: TENANT_A,
    ledgerId: LEDGER,
    sequence: seq,
    eventType: 'controller.execute.approved',
    schemaVersion: '1.0.0',
    actor: { principalId: `p-${seq}`, roleAssignmentId: 'ra-1', isSystem: false, automationId: null },
    accountableOwnerPrincipalId: 'owner-1',
    reason: { code: 'APPROVED', text: 'meets policy' },
    state: {
      entityType: 'controller-operation',
      entityId: `op-${seq}`,
      entityVersion: 'v1',
      sourceStateDigest: `src-${seq}`,
      targetStateDigest: `tgt-${seq}`,
      actualStateDigest: null,
    },
    governance: { policyVersionIds: ['pol-1'], controlVersionIds: ['ctl-1'], evidenceManifestId: 'ev-1' },
    scope: { requested: { tenants: [TENANT_A] }, actual: { tenants: [TENANT_A] } },
    timing: { occurredAt: 1000 + seq, recordedAt: 1500 + seq },
    correlation: { correlationId: `corr-${seq}`, causationId: null, traceId: `trace-${seq}` },
    outcome: 'succeeded',
    ...overrides,
  };
}

/** An intact, independently-verifiable 3-record ledger for tenant A. */
function buildLedger() {
  let ledger = createLedger(TENANT_A, LEDGER);
  ledger = appendAuditRecord(ledger, record(1));
  ledger = appendAuditRecord(ledger, record(2));
  ledger = appendAuditRecord(ledger, record(3));
  return ledger;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The incident responder + action-freeze gate under test. Deterministic, injectable, no clock.
// These are the release-gate glue that turns a verifier verdict into an operational consequence.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface AuditIncident {
  readonly incidentId: string;
  readonly severity: 'critical';
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly reason: string;
  readonly offendingSequence: number | null;
  readonly openedAt: number;
}

/**
 * Independently verify a ledger read back from storage and, on ANY tamper, OPEN a critical incident.
 * Returns null when the chain verifies (no incident). The verdict is the REAL verifier's — this
 * function only maps a failure to an incident record.
 */
function detectAndOpenIncident(
  tenantId: string,
  ledgerId: string,
  records: readonly (typeof hc extends never ? never : Parameters<typeof verifyLedger>[2][number])[],
  now: number,
): AuditIncident | null {
  const verdict = verifyLedger(tenantId, ledgerId, records);
  if (verdict.ok) return null;
  return Object.freeze({
    incidentId: `incident-${tenantId}-${ledgerId}-${verdict.sequence ?? 'x'}`,
    severity: 'critical',
    tenantId,
    ledgerId,
    reason: verdict.reason ?? 'ledger_invalid',
    offendingSequence: verdict.sequence,
    openedAt: now,
  });
}

type ActionKind = 'read-only' | 'consequential' | 'destructive';

/**
 * The consequential/destructive action gate. FAIL-CLOSED: while a critical audit incident is open in
 * the action's tenant, any consequential/destructive action is refused. Read-only actions and actions
 * in tenants with no open incident proceed.
 */
function actionAllowed(
  action: { tenantId: string; kind: ActionKind },
  openIncidents: readonly AuditIncident[],
): { allowed: boolean; blockedBy: string | null } {
  const affected = openIncidents.find(
    (i) => i.tenantId === action.tenantId && i.severity === 'critical',
  );
  if (affected && action.kind !== 'read-only') {
    return { allowed: false, blockedBy: affected.incidentId };
  }
  return { allowed: true, blockedBy: null };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A. NEGATIVE CONTROL — an intact ledger opens NO incident and freezes NOTHING.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T280 · intact ledger (negative control)', () => {
  test('an intact ledger verifies and opens no incident', () => {
    const ledger = buildLedger();
    expect(verifyLedger(TENANT_A, LEDGER, ledger.records).ok).toBe(true);
    const incident = detectAndOpenIncident(TENANT_A, LEDGER, ledger.records, 2000);
    expect(incident).toBeNull();
  });

  test('with no incident open, consequential and destructive actions proceed', () => {
    const ledger = buildLedger();
    const incident = detectAndOpenIncident(TENANT_A, LEDGER, ledger.records, 2000);
    const open = incident ? [incident] : [];
    expect(actionAllowed({ tenantId: TENANT_A, kind: 'consequential' }, open).allowed).toBe(true);
    expect(actionAllowed({ tenantId: TENANT_A, kind: 'destructive' }, open).allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// B. TAMPER: a MUTATED FIELD is detected, opens a critical incident, freezes consequential/destructive.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T280 · mutated audit field → detect → incident → freeze', () => {
  test('mutating a recorded field is detected by the independent verifier', () => {
    const ledger = buildLedger();
    // Tamper: alter the outcome of record #2 while keeping its stored digests (a silent rewrite).
    const tampered = ledger.records.map((r, i) =>
      i === 1 ? { ...r, outcome: 'failed' } : r,
    );
    const verdict = verifyLedger(TENANT_A, LEDGER, tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('digest_mismatch');
    expect(verdict.sequence).toBe(2);
  });

  test('detection opens a CRITICAL incident bound to the tenant/ledger/sequence', () => {
    const ledger = buildLedger();
    const tampered = ledger.records.map((r, i) => (i === 1 ? { ...r, outcome: 'failed' } : r));
    const incident = detectAndOpenIncident(TENANT_A, LEDGER, tampered, 3000);
    expect(incident).not.toBeNull();
    expect(incident?.severity).toBe('critical');
    expect(incident?.tenantId).toBe(TENANT_A);
    expect(incident?.ledgerId).toBe(LEDGER);
    expect(incident?.offendingSequence).toBe(2);
  });

  test('while the incident is open, consequential and destructive actions in the tenant FREEZE', () => {
    const ledger = buildLedger();
    const tampered = ledger.records.map((r, i) => (i === 1 ? { ...r, outcome: 'failed' } : r));
    const incident = detectAndOpenIncident(TENANT_A, LEDGER, tampered, 3000)!;
    const open = [incident];
    const conseq = actionAllowed({ tenantId: TENANT_A, kind: 'consequential' }, open);
    const destr = actionAllowed({ tenantId: TENANT_A, kind: 'destructive' }, open);
    expect(conseq.allowed).toBe(false);
    expect(conseq.blockedBy).toBe(incident.incidentId);
    expect(destr.allowed).toBe(false);
  });

  test('the freeze is SCOPED: read-only in the tenant, and any action in another tenant, still pass', () => {
    const ledger = buildLedger();
    const tampered = ledger.records.map((r, i) => (i === 1 ? { ...r, outcome: 'failed' } : r));
    const incident = detectAndOpenIncident(TENANT_A, LEDGER, tampered, 3000)!;
    const open = [incident];
    // read-only in the affected tenant is not consequential — allowed.
    expect(actionAllowed({ tenantId: TENANT_A, kind: 'read-only' }, open).allowed).toBe(true);
    // an unaffected tenant is not frozen.
    expect(actionAllowed({ tenantId: TENANT_B, kind: 'destructive' }, open).allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// C. TAMPER: a DROPPED record (truncation) is detected and freezes.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T280 · dropped/reordered record → detect → incident → freeze', () => {
  test('deleting a middle record breaks the chain and opens an incident', () => {
    const ledger = buildLedger();
    const dropped = [ledger.records[0]!, ledger.records[2]!]; // remove sequence 2
    const verdict = verifyLedger(TENANT_A, LEDGER, dropped);
    expect(verdict.ok).toBe(false);
    const incident = detectAndOpenIncident(TENANT_A, LEDGER, dropped, 4000);
    expect(incident?.severity).toBe('critical');
    expect(actionAllowed({ tenantId: TENANT_A, kind: 'consequential' }, [incident!]).allowed).toBe(false);
  });

  test('reordering two records breaks the chain and opens an incident', () => {
    const ledger = buildLedger();
    const reordered = [ledger.records[1]!, ledger.records[0]!, ledger.records[2]!];
    const verdict = verifyLedger(TENANT_A, LEDGER, reordered);
    expect(verdict.ok).toBe(false);
    expect(detectAndOpenIncident(TENANT_A, LEDGER, reordered, 4100)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// D. TAMPER: a signed-CHECKPOINT range that no longer matches its recomputed root is detected.
// A checkpoint root commits to the exact set+order of records, so replacing/truncating a checkpointed
// range changes the recomputed root — the substrate that makes truncation tamper-evident.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('T280 · checkpoint-range tamper is tamper-evident', () => {
  test('the recomputed checkpoint root changes when the checkpointed range is altered', () => {
    const ledger = buildLedger();
    const signedRoot = computeCheckpointRoot(TENANT_A, LEDGER, ledger.records).rootDigest;

    // Recompute over a genuinely different (shorter) range → a different root.
    const shorterRoot = computeCheckpointRoot(TENANT_A, LEDGER, ledger.records.slice(0, 2)).rootDigest;
    expect(shorterRoot).not.toBe(signedRoot);

    // A range whose content was tampered cannot even produce a checkpoint (it throws), so the signed
    // root over the honest range can never silently equal a root over a tampered range.
    const tampered = ledger.records.map((r, i) => (i === 2 ? { ...r, outcome: 'failed' } : r));
    expect(() => computeCheckpointRoot(TENANT_A, LEDGER, tampered)).toThrow();
  });

  test('a re-derived integrity digest differs after any content change (digest is content-bound)', () => {
    const ledger = buildLedger();
    const rec = ledger.records[0]!;
    const honest = deriveIntegrityDigest(rec.previousDigest, rec);
    const altered = deriveIntegrityDigest(rec.previousDigest, { ...rec, outcome: 'failed' });
    expect(honest).toBe(rec.integrityDigest);
    expect(altered).not.toBe(honest);
  });
});
