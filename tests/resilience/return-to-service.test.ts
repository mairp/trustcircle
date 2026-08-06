// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — RETURN TO SERVICE RESILIENCE (T224 · FR-036 · FR-041 · NFR-010 · NS-005 · SC-011).
//
// RESILIENCE oracle for the full "safe resume" path a component/connector walks after being offline. It
// drives the REAL services end to end:
//
//   * OFFLINE DISPATCH (`@trustcircle/application` dispatch) — while a component is intentionally
//     inactive / impaired, work gets a BOUNDED, HONEST disposition (defer / queue / request_activation /
//     reject / expire) — never an unbounded retry storm, never a fake success.
//   * RETURN-TO-SERVICE CHECKLIST (`@trustcircle/application` evaluateReturnToService) — resume is
//     REFUSED unless ALL eight prerequisites are re-proven; a single unproven check names itself.
//   * BACKLOG / CURSOR RECOVERY (`@trustcircle/application` detect) — the backlog is reconciled: gaps,
//     duplicates, stale re-deliveries, out-of-order, mapping drift, and source-identity drift are all
//     SURFACED, never auto-filled.
//   * VERSION DRIFT (`@trustcircle/adapter-sdk` isMajorSupported, NS-005) — a drifted contract major is
//     refused, so resume cannot proceed on an unsupported protocol.
//
// The composed invariant: work is bounded while offline → the backlog is honestly reconciled → every
// prerequisite (including reconciled backlog + supported contract) is re-proven → ONLY THEN resume.
//
// Every assertion pins a REAL service verdict — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  dispatch,
  evaluateReturnToService,
  detect,
  RETURN_TO_SERVICE_CHECKS,
  type ReturnToServiceInput,
  type BatchEvent,
} from '@trustcircle/application';

import { isMajorSupported } from '@trustcircle/adapter-sdk';

import { NOW, ONE_HOUR, NAMED_MANIFESTS } from '../fixtures/integrations.ts';

const PASSING: Omit<ReturnToServiceInput, 'at'> = {
  identityVerified: true,
  contractsVerified: true,
  credentialsVerified: true,
  authorityVerified: true,
  versionsVerified: true,
  snapshotsVerified: true,
  backlogReconciled: true,
  evidenceIntact: true,
};

/** Map each named checklist input flag to the failing-check label the verdict reports. */
const CHECK_FLAG: ReadonlyArray<
  readonly [keyof typeof PASSING, (typeof RETURN_TO_SERVICE_CHECKS)[number]]
> = [
  ['identityVerified', 'identity'],
  ['contractsVerified', 'contracts'],
  ['credentialsVerified', 'credentials'],
  ['authorityVerified', 'authority'],
  ['versionsVerified', 'versions'],
  ['snapshotsVerified', 'snapshots'],
  ['backlogReconciled', 'backlog'],
  ['evidenceIntact', 'evidence'],
];

describe('return to service · offline work gets a bounded, honest disposition (never a retry storm)', () => {
  const work = { workId: 'w-1', deferrable: true };
  const nonDeferrable = { workId: 'w-2', deferrable: false };

  it('intentionally-inactive + deferrable ⇒ defer (held, not retried)', () => {
    const d = dispatch({
      runtimeState: 'intentionally_inactive',
      availabilityClass: 'optional',
      work,
      now: NOW,
      expiresAt: NOW + ONE_HOUR,
    });
    expect(d.disposition).toBe('defer');
    expect(d.expired).toBe(false);
  });

  it('on-demand + inactive ⇒ request_activation (ask, do not fail)', () => {
    const d = dispatch({
      runtimeState: 'intentionally_inactive',
      availabilityClass: 'on-demand',
      work,
      now: NOW,
      expiresAt: NOW + ONE_HOUR,
    });
    expect(d.disposition).toBe('request_activation');
  });

  it('transient (returning) + deferrable ⇒ queue to drain on recovery', () => {
    const d = dispatch({
      runtimeState: 'returning',
      availabilityClass: 'optional',
      work,
      now: NOW,
      expiresAt: NOW + ONE_HOUR,
    });
    expect(d.disposition).toBe('queue');
  });

  it('hard-unavailable + non-deferrable ⇒ visible governed rejection (never fake success)', () => {
    const d = dispatch({
      runtimeState: 'unavailable',
      availabilityClass: 'optional',
      work: nonDeferrable,
      now: NOW,
      expiresAt: NOW + ONE_HOUR,
    });
    expect(d.disposition).toBe('reject');
  });

  it('past the expiry deadline ⇒ expire — BOUNDED, never retried forever', () => {
    const d = dispatch({
      runtimeState: 'intentionally_inactive',
      availabilityClass: 'optional',
      work,
      now: NOW + 2 * ONE_HOUR,
      expiresAt: NOW + ONE_HOUR,
    });
    expect(d.disposition).toBe('expire');
    expect(d.expired).toBe(true);
  });
});

describe('return to service · resume is refused unless every prerequisite is re-proven', () => {
  it('a fully-passing checklist resumes (readyToResume, no failing checks)', () => {
    const v = evaluateReturnToService({ ...PASSING, at: NOW as number });
    expect(v.readyToResume).toBe(true);
    expect(v.failingChecks).toEqual([]);
    expect(v.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a SINGLE unproven prerequisite blocks resume and names itself', () => {
    for (const [flag, label] of CHECK_FLAG) {
      const v = evaluateReturnToService({ ...PASSING, [flag]: false, at: NOW as number });
      expect(v.readyToResume).toBe(false);
      expect(v.failingChecks).toEqual([label]);
      expect(v.checks[label]).toBe(false);
    }
  });

  it('the checklist is total — the eight checks are the frozen return-to-service set', () => {
    expect([...RETURN_TO_SERVICE_CHECKS]).toEqual([
      'identity',
      'contracts',
      'credentials',
      'authority',
      'versions',
      'snapshots',
      'backlog',
      'evidence',
    ]);
  });
});

describe('return to service · backlog + cursor recovery is surfaced, never auto-filled', () => {
  const prior = { sourceRef: 'src-A', mappingVersion: 'map-v1', highWater: { 'agg-1': 100 } };

  function bev(sequence: number, extra: Partial<BatchEvent> = {}): BatchEvent {
    return {
      dedupKey: `k-${sequence}`,
      aggregateRef: 'agg-1',
      sequence,
      sourceRef: 'src-A',
      mappingVersion: 'map-v1',
      ...extra,
    };
  }

  it('a reconciled (contiguous, in-order, single-source) backlog has NO findings — safe to resume', () => {
    const report = detect(prior, [bev(101), bev(102), bev(103)]);
    expect(report.hasFindings).toBe(false);
  });

  it('a gap + duplicate + mapping drift + source-identity drift are all SURFACED together', () => {
    const report = detect(prior, [
      bev(102, { mappingVersion: 'map-v2', sourceRef: 'src-B' }), // gap (101 missing), mapping+source drift
      bev(104), // gap (103 missing)
      bev(104), // duplicate
    ]);
    expect(report.hasFindings).toBe(true);
    expect(report.countByKind.backlog_gap).toBeGreaterThanOrEqual(1);
    expect(report.countByKind.duplicate).toBe(1);
    expect(report.countByKind.mapping_change).toBe(1);
    expect(report.countByKind.source_identity_change).toBe(1);
  });

  it('a stale re-delivery below high-water is flagged stale (dedup: already processed, not re-applied)', () => {
    const report = detect(prior, [bev(100), bev(99)]);
    expect(report.countByKind.stale).toBe(2);
  });

  it('a lost cursor with a pending backlog demands authorized replay (never assumed position)', () => {
    const report = detect(undefined, [bev(1), bev(2)]);
    expect(report.countByKind.cursor_loss).toBe(1);
  });
});

describe('return to service · version drift is refused before resume (NS-005)', () => {
  it('a supported major resumes; a drifted (too-new) major is refused', () => {
    const manifest = NAMED_MANIFESTS['workflow-orchestration']!;
    const max = Number(manifest.contract_range.maximum.split('.')[0]);
    expect(isMajorSupported(manifest, max)).toBe(true);
    expect(isMajorSupported(manifest, max + 1)).toBe(false);
  });
});

describe('return to service · the composed safe-resume path', () => {
  const prior = { sourceRef: 'src-A', mappingVersion: 'map-v1', highWater: { 'agg-1': 100 } };
  const manifest = NAMED_MANIFESTS.kanban;

  function bev(sequence: number): BatchEvent {
    return {
      dedupKey: `k-${sequence}`,
      aggregateRef: 'agg-1',
      sequence,
      sourceRef: 'src-A',
      mappingVersion: 'map-v1',
    };
  }

  it('bounded offline hold → reconciled backlog → supported contract → every check proven ⇒ resume', () => {
    // 1. While offline, deferrable work is bounded (deferred), not retried forever.
    expect(
      dispatch({
        runtimeState: 'intentionally_inactive',
        availabilityClass: 'optional',
        work: { workId: 'w', deferrable: true },
        now: NOW,
        expiresAt: NOW + ONE_HOUR,
      }).disposition,
    ).toBe('defer');

    // 2. The backlog reconciles cleanly (no findings) and the contract major is supported.
    const backlog = detect(prior, [bev(101), bev(102), bev(103)]);
    const max = Number(manifest.contract_range.maximum.split('.')[0]);
    const contractOk = isMajorSupported(manifest, max);

    // 3. Only with a reconciled backlog + supported contract can the backlog/contract checks be TRUE.
    const v = evaluateReturnToService({
      ...PASSING,
      backlogReconciled: !backlog.hasFindings,
      contractsVerified: contractOk,
      at: NOW as number,
    });
    expect(v.readyToResume).toBe(true);
  });

  it('an UNreconciled backlog keeps the backlog check false ⇒ resume refused', () => {
    const backlog = detect(prior, [bev(103)]); // 101..102 missing → a gap
    expect(backlog.hasFindings).toBe(true);
    const v = evaluateReturnToService({
      ...PASSING,
      backlogReconciled: !backlog.hasFindings,
      at: NOW as number,
    });
    expect(v.readyToResume).toBe(false);
    expect(v.failingChecks).toEqual(['backlog']);
  });
});
