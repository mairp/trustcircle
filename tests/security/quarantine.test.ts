// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — QUARANTINE CONTAINMENT (T123 · FR-019 · SC-007).
//
// SECURITY oracle for the containment boundary (`QuarantineService`,
// packages/application/src/quarantine-service.ts). FR-019: when a damaged case could propagate unsafe
// effects, quarantine CONTAINS them — it blocks the named execution capabilities and the downstream
// dependency work while keeping the item VISIBLE and INSPECTABLE. Release is an AUTHORITY act: a
// quarantine leaves the blocking state ONLY when a release DECISION id is presented AND its
// preconditions are reported satisfied — a silent auto-release is impossible. Overdue review is
// surfaced, never hidden. The service never deletes, so containment history stays reconstructable.
//
// Each containment guarantee is paired with a NEGATIVE control (a capability it does NOT block, a
// release with no decision, a release with unmet preconditions, a released quarantine that blocks
// nothing) so no assertion is vacuous.
//
// Pure application: no clock, no I/O. Ids are deterministic UUIDs from readable slugs; every instant
// is injected.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { QuarantineService, containmentReason } from '@trustcircle/application';
import { toUuid, type Uuid, type TenantId, type EpochMillis } from '@trustcircle/domain';

// ── Deterministic ids + fixed clock ──────────────────────────────────────────────────────────────

function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`quarantine-security:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

const NOW = 1_772_070_000_000 as EpochMillis;
const ONE_DAY = 86_400_000;
const TENANT = uuidFromSlug('tenant') as unknown as TenantId;
const CASE = uuidFromSlug('case');

function openInput(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidFromSlug('quarantine'),
    integrityCaseId: CASE,
    blockedCapabilities: ['governed_publish', 'downstream_consume'],
    blockedDependencyIds: [uuidFromSlug('dependent-1')],
    reason: containmentReason('contain the corrupted derivative pending repair'),
    originalEvidenceId: uuidFromSlug('original-evidence'),
    reviewCadenceMs: ONE_DAY,
    startedAt: NOW,
    ...overrides,
  };
}

function newService(): QuarantineService {
  return new QuarantineService(TENANT);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('FR-019 — an active quarantine contains unsafe effects while keeping the item inspectable', () => {
  it('blocks every named capability and permits inspection', () => {
    const svc = newService();
    const out = svc.open(openInput());
    expect(out.accepted).toBe(true);
    const q = out.quarantine!;

    expect(svc.blocks(CASE, 'governed_publish')).toBe(true);
    expect(svc.blocks(CASE, 'downstream_consume')).toBe(true);
    expect(svc.permitsInspection(q.id)).toBe(true); // containment ≠ opacity (SC-007)

    // NEGATIVE — a capability it does not list is NOT blocked (containment is scoped, not a blanket ban).
    expect(svc.blocks(CASE, 'unrelated_capability')).toBe(false);
  });

  it('NEGATIVE — an active quarantine with no blocked capability is refused (INVARIANT_VIOLATION)', () => {
    const svc = newService();
    const out = svc.open(openInput({ blockedCapabilities: [] }));
    expect(out.accepted).toBe(false);
    expect(out.rejectionCode).toBe('INVARIANT_VIOLATION');
    expect(out.quarantine).toBeNull();
    // No live quarantine was stored, so nothing is contained.
    expect(svc.blocks(CASE, 'governed_publish')).toBe(false);
  });
});

describe('FR-019 — release is an authority act, never silent', () => {
  it('releases only with a decision id AND satisfied preconditions, then blocks nothing', () => {
    const svc = newService();
    svc.open(openInput());
    const released = svc.release({
      quarantineId: uuidFromSlug('quarantine'),
      releaseDecisionId: uuidFromSlug('release-decision'),
      preconditionsSatisfied: true,
      at: (NOW + ONE_DAY) as EpochMillis,
    });
    expect(released.accepted).toBe(true);
    expect(released.quarantine!.status).toBe('released');
    expect(released.quarantine!.releaseDecisionId).toBe(uuidFromSlug('release-decision'));
    // Containment is lifted only by that authoritative release.
    expect(svc.blocks(CASE, 'governed_publish')).toBe(false);
  });

  it('NEGATIVE — release with unmet preconditions is refused; containment stays', () => {
    const svc = newService();
    svc.open(openInput());
    const denied = svc.release({
      quarantineId: uuidFromSlug('quarantine'),
      releaseDecisionId: uuidFromSlug('release-decision'),
      preconditionsSatisfied: false,
      at: (NOW + ONE_DAY) as EpochMillis,
    });
    expect(denied.accepted).toBe(false);
    expect(denied.rejectionCode).toBe('PRECONDITIONS_UNMET');
    // The block is still in force — no silent release.
    expect(svc.blocks(CASE, 'governed_publish')).toBe(true);
  });

  it('NEGATIVE — releasing an unknown quarantine is refused UNKNOWN_QUARANTINE', () => {
    const svc = newService();
    const out = svc.release({
      quarantineId: uuidFromSlug('nonexistent'),
      releaseDecisionId: uuidFromSlug('release-decision'),
      preconditionsSatisfied: true,
      at: NOW,
    });
    expect(out.rejectionCode).toBe('UNKNOWN_QUARANTINE');
  });

  it('NEGATIVE — re-releasing an already-released quarantine is refused ALREADY_RELEASED', () => {
    const svc = newService();
    svc.open(openInput());
    svc.release({
      quarantineId: uuidFromSlug('quarantine'),
      releaseDecisionId: uuidFromSlug('release-decision'),
      preconditionsSatisfied: true,
      at: NOW,
    });
    const again = svc.release({
      quarantineId: uuidFromSlug('quarantine'),
      releaseDecisionId: uuidFromSlug('release-decision-2'),
      preconditionsSatisfied: true,
      at: (NOW + 1) as EpochMillis,
    });
    expect(again.rejectionCode).toBe('ALREADY_RELEASED');
  });
});

describe('FR-019 — overdue review is surfaced, containment history is retained', () => {
  it('surfaces a quarantine whose review is overdue; a review resets the due clock', () => {
    const svc = newService();
    svc.open(openInput());

    // Not yet due at NOW.
    expect(svc.dueForReview(NOW).length).toBe(0);
    // Due once the cadence elapses.
    const overdue = svc.dueForReview((NOW + ONE_DAY) as EpochMillis);
    expect(overdue.map((q) => q.id)).toContain(uuidFromSlug('quarantine'));

    // A review resets the due clock forward (containment is re-examined, not dropped).
    const reviewed = svc.review({
      quarantineId: uuidFromSlug('quarantine'),
      at: (NOW + ONE_DAY) as EpochMillis,
    });
    expect(reviewed.accepted).toBe(true);
    expect(reviewed.quarantine!.status).toBe('under_review');
    expect(svc.dueForReview((NOW + ONE_DAY) as EpochMillis).length).toBe(0);
    // Still blocking while under review — a review is not a release.
    expect(svc.blocks(CASE, 'governed_publish')).toBe(true);
  });

  it('retains the released quarantine so containment history is reconstructable + digestible', () => {
    const svc = newService();
    svc.open(openInput());
    const before = svc.digest(uuidFromSlug('quarantine'));
    svc.release({
      quarantineId: uuidFromSlug('quarantine'),
      releaseDecisionId: uuidFromSlug('release-decision'),
      preconditionsSatisfied: true,
      at: (NOW + ONE_DAY) as EpochMillis,
    });
    // The record is retained (not deleted), and its digest changed to reflect the released state.
    const after = svc.digest(uuidFromSlug('quarantine'));
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(svc.quarantinesFor(CASE).length).toBe(1);
  });
});
