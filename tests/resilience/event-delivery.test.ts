// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — EVENT DELIVERY RESILIENCE (T221 · FR-029 · FR-030 · NS-005 · SC-011).
//
// RESILIENCE oracle for at-least-once event delivery and its safe reduction to exactly-one effect. It
// drives the REAL source-ingestion fold (`@trustcircle/application` ingest / mergedAggregate /
// rawObservationsFor / ingestionDigest), the REAL cursor-recovery detectors (missing sequences, replay,
// out-of-order), the REAL contract-major gate (`isMajorSupported`, NS-005), and the REAL dead-letter
// handler (`toDeadLetter` / `authorizeReplay`). It proves:
//
//   * AT-LEAST-ONCE → EXACTLY-ONE EFFECT (SC-011). A duplicate dedup key is a no-op — the merged view
//     and digest are identical whether an event arrives once or twice.
//   * DEDUPLICATION is counted honestly (accepted vs deduplicated).
//   * AGGREGATE ORDERING. Only a newer sequence advances the merged value; a lower/equal sequence is
//     preserved in the raw log but never overwrites the authoritative current value.
//   * MISSING SEQUENCES are detected as backlog gaps (holes stay visible, never auto-filled).
//   * REPLAY. A re-delivered batch produces zero NET new effect — the fold is idempotent.
//   * UNSUPPORTED MAJORS (NS-005). An event whose schema major is outside the contract range is refused.
//   * DEAD LETTERS. A terminal event preserves its payload + digest and is held until authorized replay.
//   * DETERMINISTIC PROJECTIONS. Identical accepted observations ⇒ identical digest regardless of order.
//
// Every assertion pins a REAL service verdict — never a re-implemented rule, never a mutation echo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  emptyIngestionState,
  ingest,
  mergedAggregate,
  rawObservationsFor,
  ingestionDigest,
  detect,
  type SourceObservation,
  type BatchEvent,
} from '@trustcircle/application';

import { isMajorSupported } from '@trustcircle/adapter-sdk';

import { toDeadLetter, authorizeReplay } from '../../apps/command-worker/src/dead-letter-handler.ts';

import { NAMED_MANIFESTS, NOW } from '../fixtures/integrations.ts';

function evt(aggregateRef: string, sequence: number, extra: Partial<SourceObservation> = {}): SourceObservation {
  return {
    dedupKey: `k-${aggregateRef}-${sequence}`,
    aggregateRef,
    sequence,
    kind: 'event',
    payload: { seq: sequence, status: `s${sequence}` },
    ...extra,
  };
}

describe('event delivery · at-least-once reduces to exactly-one effect (SC-011)', () => {
  it('a duplicate dedup key is a no-op — same merged view + digest', () => {
    const once = ingest(emptyIngestionState(), [evt('agg-1', 1)]);
    const twice = ingest(emptyIngestionState(), [evt('agg-1', 1), evt('agg-1', 1)]);

    expect(once.accepted).toBe(1);
    expect(once.deduplicated).toBe(0);
    expect(twice.accepted).toBe(1);
    expect(twice.deduplicated).toBe(1);
    // EXACTLY-ONE EFFECT: the digest is identical whether the event arrived once or twice.
    expect(twice.digest).toBe(once.digest);
  });

  it('dedup persists across folds (a re-delivered key in a later batch is a no-op)', () => {
    const first = ingest(emptyIngestionState(), [evt('agg-1', 1), evt('agg-1', 2)]);
    const replay = ingest(first.state, [evt('agg-1', 1), evt('agg-1', 2)]);
    expect(replay.accepted).toBe(0);
    expect(replay.deduplicated).toBe(2);
    // REPLAY is a no-op: the state digest is unchanged.
    expect(replay.digest).toBe(first.digest);
  });
});

describe('event delivery · aggregate ordering + out-of-order preservation', () => {
  it('only a newer sequence advances the merged value; lower/equal is preserved in the raw log', () => {
    // Deliver 3 then 1 (arrival out of order). The fold normalizes arrival order by (aggregate, seq),
    // so 3 wins the AUTHORITATIVE merged view while 1 is retained verbatim in the append-only raw log.
    const r = ingest(emptyIngestionState(), [evt('agg-1', 3), evt('agg-1', 1)]);
    const merged = mergedAggregate(r.state, 'agg-1');
    expect(merged?.sequence).toBe(3);
    const raw = rawObservationsFor(r.state, 'agg-1');
    expect(raw).toHaveLength(2);
    expect(raw.map((o) => o.sequence).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('a cross-batch LATE delivery (seq <= high-water at accept) is flagged out-of-order but preserved', () => {
    // First fold advances high-water to 3. A later, separate batch delivers seq 2 — below high-water at
    // accept → outOfOrder true, retained in the raw log, but never overwrites the authoritative value.
    const first = ingest(emptyIngestionState(), [evt('agg-1', 3)]);
    const late = ingest(first.state, [evt('agg-1', 2)]);
    const raw = rawObservationsFor(late.state, 'agg-1');
    const seq2 = raw.find((o) => o.sequence === 2);
    expect(seq2?.outOfOrder).toBe(true);
    // The authoritative merged value is still seq 3.
    expect(mergedAggregate(late.state, 'agg-1')?.sequence).toBe(3);
  });

  it('deterministic projection: arrival order does not change the merged digest', () => {
    const forward = ingest(emptyIngestionState(), [evt('a', 1), evt('a', 2), evt('b', 1)]);
    const shuffled = ingest(emptyIngestionState(), [evt('b', 1), evt('a', 2), evt('a', 1)]);
    expect(shuffled.digest).toBe(forward.digest);
    expect(ingestionDigest(shuffled.state)).toBe(ingestionDigest(forward.state));
  });
});

describe('event delivery · missing sequences + replay are detected, never auto-filled', () => {
  const prior = { sourceRef: 'src-A', mappingVersion: 'map-v1', highWater: { 'agg-1': 100 } };

  function bev(sequence: number, extra: Partial<BatchEvent> = {}): BatchEvent {
    return { dedupKey: `k-${sequence}`, aggregateRef: 'agg-1', sequence, sourceRef: 'src-A', mappingVersion: 'map-v1', ...extra };
  }

  it('a missing sequence between high-water and the batch is a backlog gap', () => {
    // High-water is 100; the batch jumps to 103 → 101..102 are missing.
    const report = detect(prior, [bev(103)]);
    const gaps = report.findings.filter((f) => f.kind === 'backlog_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ aggregateRef: 'agg-1', fromSequence: 101, toSequence: 102 });
    expect(report.hasFindings).toBe(true);
  });

  it('a re-delivered (stale) sequence at/below high-water is a stale finding, not silently applied', () => {
    const report = detect(prior, [bev(100), bev(99)]);
    const stale = report.findings.filter((f) => f.kind === 'stale');
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it('out-of-order within the batch is detected', () => {
    const report = detect(prior, [bev(102), bev(101)]);
    expect(report.countByKind.out_of_order).toBeGreaterThanOrEqual(1);
  });

  it('duplicate dedup key within the batch is detected', () => {
    const report = detect(prior, [bev(101), bev(101)]);
    expect(report.countByKind.duplicate).toBeGreaterThanOrEqual(1);
  });

  it('a healthy contiguous batch raises no findings', () => {
    const report = detect(prior, [bev(101), bev(102), bev(103)]);
    expect(report.hasFindings).toBe(false);
    expect(report.findings).toEqual([]);
  });
});

describe('event delivery · unsupported schema majors are refused (NS-005)', () => {
  it('an event whose major is outside the contract range is not accepted', () => {
    const manifest = NAMED_MANIFESTS.kanban;
    const max = Number(manifest.contract_range.maximum.split('.')[0]);
    expect(isMajorSupported(manifest, max)).toBe(true);
    // A drifted (too-new) major is refused.
    expect(isMajorSupported(manifest, max + 5)).toBe(false);
  });
});

describe('event delivery · terminal events become dead letters (nothing dropped, replay is gated)', () => {
  it('a terminal event preserves payload + digest and is held until authorized replay', () => {
    const dl = toDeadLetter({
      connectorId: 'conn-1',
      tenantId: 'tenant-1',
      owner: 'owner-1',
      origin: 'inbox',
      dedupKey: 'k-terminal',
      failureClass: 'unsupported_contract',
      originalPayload: { seq: 7, status: 'unknown-future-status' },
      attempts: [{ attempt: 1, failureClass: 'unsupported_contract', error: 'schema major drift', at: NOW }],
      terminalError: 'contract major unsupported',
      businessImpact: 'workflow event not projected',
      createdAt: NOW,
    });

    // NOTHING DROPPED: the original payload + its sha256 digest are preserved.
    expect(dl.originalPayload).toEqual({ seq: 7, status: 'unknown-future-status' });
    expect(dl.originalDigest).toMatch(/^[a-f0-9]{64}$/);
    // A fresh dead letter is HELD with no replay authority.
    expect(dl.replayState).toBe('held');
    expect(dl.replayAuthorizedBy).toBeNull();

    // REPLAY REQUIRES AUTHORITY: no authority → refused.
    expect(() => authorizeReplay(dl, '', NOW + 1)).toThrow(/authority/i);

    // With an explicit authority → authorized, payload + digest unchanged.
    const authorized = authorizeReplay(dl, 'principal:owner-1', NOW + 1);
    expect(authorized.replayState).toBe('authorized');
    expect(authorized.replayAuthorizedBy).toBe('principal:owner-1');
    expect(authorized.originalDigest).toBe(dl.originalDigest);
  });
});
