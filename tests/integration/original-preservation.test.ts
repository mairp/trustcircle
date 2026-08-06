// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — ORIGINAL PRESERVATION (T122 · FR-017 / FR-016 / FR-018 · SC-006).
//
// INTEGRATION oracle for the INTEGRITY DETECTOR worker (apps/command-worker/src/integrity-detector.ts)
// driven against the REAL transactional-outbox unit-of-work via the in-memory driver. FR-017 is the
// load-bearing invariant of the whole containment flow: for a damaged record, the raw ORIGINAL must be
// preserved BEFORE the integrity case is opened, the case must BIND the preserved-original evidence id,
// and — critically — a record whose original CANNOT be preserved must FAIL VISIBLY with NO case opened
// (never a case without a recoverable original).
//
// Every effect is observed through the INDEPENDENT durable read path (`readCanonicalState`), never the
// mutation response — a source-reported success is not evidence. Each positive is paired with a
// NEGATIVE control: a clean record opens nothing; a preservation refusal opens nothing; a re-run over
// the same durable state is a no-op (dedup). Ownership honesty (FR-018) is asserted: an ownerless
// record records an explicit gap + a safe `escalate` next action.
//
// Deterministic: the clock is injected; the detector reads no wall clock and derives every id from the
// record identity + source revision. No I/O beyond the in-memory driver.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  Database,
  readCanonicalState,
  type SqlDriver,
  type SourceContract,
} from '../../packages/persistence/src/index.ts';
import {
  IntegrityDetector,
  INTEGRITY_CASE_ENTITY_KIND,
  type DetectableRecord,
  type DetectionVerdict,
  type PreservedOriginalReceipt,
  type IntegrityDetectorPorts,
  type IntegrityDetectorOracles,
  type IntegrityDetectorOptions,
} from '../../apps/command-worker/src/integrity-detector.ts';

// The UoW-aware in-memory driver (models canonical_state / audit_event / outbox_message).
import { createUowDriver } from '../persistence/uow-in-memory-driver.mjs';

// ── Fixed clock + deterministic wiring ───────────────────────────────────────────────────────────

const NOW = 1_772_070_000_000;

function makeClock() {
  let t = NOW;
  return () => (t += 1);
}

function newDb() {
  const driver = createUowDriver();
  const database = new Database(driver as unknown as SqlDriver, {
    clock: makeClock(),
    retry: { maxAttempts: 5, baseBackoffMs: 1 },
  });
  return { driver, database };
}

const contract: SourceContract = {
  sourceId: 'servicenow',
  version: '2.0.0',
  contractDigest: 'digest-integrity',
  validated: true,
};

const OPTIONS: IntegrityDetectorOptions = {
  contract,
  expectedContractVersion: '2.0.0',
  policyVersion: 'pol-integrity-1',
  controlVersion: 'ctrl-integrity-1',
  owner: 'team:governance-runtime',
  batchSize: 50,
};

const enc = new TextEncoder();

function record(overrides: Partial<DetectableRecord> = {}): DetectableRecord {
  return {
    recordId: 'rec-damaged-1',
    tenantId: 't-integrity',
    workItemId: 'wi-1',
    sourceType: 'servicenow',
    recordKind: 'change_request',
    sourceRevision: 'rev-7',
    content: enc.encode('the raw original bytes'),
    ownerPrincipalId: 'user:owner',
    classification: 'internal',
    dependentWorkIds: ['wi-2', 'wi-3'],
    ...overrides,
  };
}

const DAMAGED: DetectionVerdict = {
  damaged: true,
  problemClasses: ['corrupted'],
  severity: 'high',
  safetyImpact: 'moderate',
  suspected: false,
  detail: 'checksum mismatch against source manifest',
};

const CLEAN: DetectionVerdict = {
  damaged: false,
  problemClasses: [],
  severity: 'low',
  safetyImpact: 'none',
  suspected: false,
  detail: 'no defect',
};

/** Build a detector whose oracle returns a fixed verdict and whose preservation port is controllable. */
function buildDetector(
  database: Database,
  opts: {
    records: readonly DetectableRecord[];
    verdict: (r: DetectableRecord) => DetectionVerdict;
    preserve?: (r: DetectableRecord) => Promise<PreservedOriginalReceipt>;
  },
): { detector: IntegrityDetector; preserveCalls: string[] } {
  const preserveCalls: string[] = [];
  const defaultPreserve = async (r: DetectableRecord): Promise<PreservedOriginalReceipt> => ({
    originalEvidenceId: `ev-original-${r.recordId}-${r.sourceRevision}`,
    contentDigest: `digest-${r.recordId}`,
    deduplicated: false,
  });
  const ports: IntegrityDetectorPorts = {
    dueRecords: async () => opts.records,
    preserve: async (r, now) => {
      preserveCalls.push(r.recordId);
      return (opts.preserve ?? defaultPreserve)(r, now as unknown as never);
    },
  };
  const oracles: IntegrityDetectorOracles = { detect: (r) => opts.verdict(r) };
  return { detector: new IntegrityDetector(database, ports, oracles, OPTIONS), preserveCalls };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('FR-017 — the preserved original precedes and binds the opened case', () => {
  it('preserves the original THEN opens a case that binds the preserved-original evidence id', async () => {
    const { database } = newDb();
    const rec = record();
    const { detector, preserveCalls } = buildDetector(database, {
      records: [rec],
      verdict: () => DAMAGED,
    });

    const pass = await detector.runDetectionPass(NOW);
    expect(pass.opened).toBe(1);
    const item = pass.results[0]!;
    expect(item.disposition).toBe('opened');
    expect(item.originalEvidenceId).toBe(`ev-original-${rec.recordId}-${rec.sourceRevision}`);
    // Preservation was actually invoked (it is not a claim — the port recorded the call).
    expect(preserveCalls).toEqual([rec.recordId]);

    // INDEPENDENT read path — the durable case binds the preserved original (FR-017), never the response.
    const canonical = await readCanonicalState(
      database,
      rec.tenantId,
      INTEGRITY_CASE_ENTITY_KIND,
      item.caseId!,
    );
    expect(canonical).not.toBeNull();
    const state = canonical!.state as Record<string, unknown>;
    expect(state['originalEvidenceId']).toBe(`ev-original-${rec.recordId}-${rec.sourceRevision}`);
    expect(state['problemClass']).toBe('corrupted');
    expect(state['state']).toBe('detected');
  });

  it('NEGATIVE — a clean record opens NO case (nothing to contain)', async () => {
    const { database, driver } = newDb();
    const { detector, preserveCalls } = buildDetector(database, {
      records: [record({ recordId: 'rec-clean' })],
      verdict: () => CLEAN,
    });
    const pass = await detector.runDetectionPass(NOW);
    expect(pass.opened).toBe(0);
    expect(pass.clean).toBe(1);
    // Preservation is never invoked for a clean record, and no durable case row exists.
    expect(preserveCalls).toEqual([]);
    expect(driver.__committed.canonical_state.size).toBe(0);
  });

  it('NEGATIVE — a preservation refusal FAILS VISIBLY and opens NO case (never an unrecoverable case)', async () => {
    const { database, driver } = newDb();
    const rec = record({ recordId: 'rec-unpreservable' });
    const { detector } = buildDetector(database, {
      records: [rec],
      verdict: () => DAMAGED,
      preserve: async () => {
        throw new Error('retention store unavailable');
      },
    });
    const pass = await detector.runDetectionPass(NOW);
    expect(pass.failed).toBe(1);
    expect(pass.opened).toBe(0);
    const item = pass.results[0]!;
    expect(item.disposition).toBe('failed');
    expect(item.originalEvidenceId).toBeNull();
    expect(item.error).toMatch(/preservation refused/i);
    // The anti-masquerade guarantee: NO durable case exists for an unpreservable record.
    expect(driver.__committed.canonical_state.size).toBe(0);
    expect(
      await readCanonicalState(database, rec.tenantId, INTEGRITY_CASE_ENTITY_KIND, item.caseId!),
    ).toBeNull();
  });
});

describe('FR-018 — ownership honesty on the opened case', () => {
  it('records an explicit ownership gap + a safe escalate action for an ownerless record', async () => {
    const { database } = newDb();
    const rec = record({ recordId: 'rec-ownerless', ownerPrincipalId: null });
    const { detector } = buildDetector(database, { records: [rec], verdict: () => DAMAGED });
    const pass = await detector.runDetectionPass(NOW);
    const item = pass.results[0]!;
    expect(item.disposition).toBe('opened');
    expect(item.safeNextAction).toBe('escalate');

    const canonical = await readCanonicalState(
      database,
      rec.tenantId,
      INTEGRITY_CASE_ENTITY_KIND,
      item.caseId!,
    );
    const state = canonical!.state as Record<string, unknown>;
    expect(state['ownershipGap']).toBe(true);
    expect(state['ownerPrincipalId']).toBeNull();
  });

  it('records a named owner with no gap for an owned record (the NEGATIVE control)', async () => {
    const { database } = newDb();
    const rec = record({ recordId: 'rec-owned', ownerPrincipalId: 'user:alice' });
    const { detector } = buildDetector(database, { records: [rec], verdict: () => DAMAGED });
    const pass = await detector.runDetectionPass(NOW);
    const item = pass.results[0]!;
    expect(item.safeNextAction).toBe('none');
    const canonical = await readCanonicalState(
      database,
      rec.tenantId,
      INTEGRITY_CASE_ENTITY_KIND,
      item.caseId!,
    );
    const state = canonical!.state as Record<string, unknown>;
    expect(state['ownershipGap']).toBe(false);
    expect(state['ownerPrincipalId']).toBe('user:alice');
  });
});

describe('detection is deterministic + idempotent (revision-bound, scan-time-independent)', () => {
  it('re-running the pass over the same durable state opens the case exactly once (dedup)', async () => {
    const { database, driver } = newDb();
    const rec = record({ recordId: 'rec-dedup' });
    const { detector } = buildDetector(database, { records: [rec], verdict: () => DAMAGED });

    const first = await detector.runDetectionPass(NOW);
    const second = await detector.runDetectionPass(NOW + 10_000); // later scan instant, same revision

    expect(first.opened).toBe(1);
    expect(second.opened).toBe(0);
    expect(second.deduplicated).toBe(1);
    // Exactly ONE durable case row despite two passes.
    expect(driver.__committed.canonical_state.size).toBe(1);
    // The case id is stable across passes (derived from identity + revision, not the clock).
    expect(second.results[0]!.caseId).toBe(first.results[0]!.caseId);
  });

  it('a NEW source revision derives a fresh case (a genuine change is evaluated anew)', async () => {
    const { database, driver } = newDb();
    const { detector: d1 } = buildDetector(database, {
      records: [record({ recordId: 'rec-rev', sourceRevision: 'rev-1' })],
      verdict: () => DAMAGED,
    });
    const p1 = await d1.runDetectionPass(NOW);
    const { detector: d2 } = buildDetector(database, {
      records: [record({ recordId: 'rec-rev', sourceRevision: 'rev-2' })],
      verdict: () => DAMAGED,
    });
    const p2 = await d2.runDetectionPass(NOW + 1);
    expect(p1.opened).toBe(1);
    expect(p2.opened).toBe(1);
    expect(p2.results[0]!.caseId).not.toBe(p1.results[0]!.caseId);
    expect(driver.__committed.canonical_state.size).toBe(2);
  });
});
