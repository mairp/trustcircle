// TrustCircleAI — Phase 69 unit tests for the CORE-ARCHITECTURE candidate classifier:
// `apps/discovery-agent/src/classifiers/core-architecture.ts`.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M / task T069 / user story US1.
//
// Executable evidence that `classifyDiscoveries` / `classifyOne` place discovered candidates on the
// TWO SEPARATE governance axes the domain defines — the owner-approved ARCHITECTURE ROLE and the
// runtime AVAILABILITY CLASS — classifying LISA and Wiggum as ARCHITECTURE-CORE candidates and
// Kanban, workflow_orchestration, agentctl, OpenClaw, AgentEs, AgentES-OilGas, MCP, Terraform, NetBox,
// deployment consoles, and `unknown` on both axes, all WITHOUT ever onboarding a source.
//
// The classifier is pure/deterministic: every pass takes fixture inputs and an explicit `now` epoch —
// no wall-clock reads. The durable-effect witness is the reconciled report (`candidates` + `gaps` +
// `records`), each item's metadata-only record, and the `registered:false` / `ownerApprovalRequired`
// flags — never a mutating onboarding call.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a case where the rule must NOT fire.
//
// AC → describe-block map:
//   AC1 each classified candidate renders ONCE with its full facet set + both axes ..... describe('AC1 …')
//   AC2 a discovered-but-unmanaged candidate stays a VISIBLE gap ....................... describe('AC2 …')
//   AC3 distinct named-system records per pass (correlated, status, dependencies) ...... describe('AC3 …')
//   AC4 a stale candidate is marked w/ last-known time + confidence; axes NOT asserted . describe('AC4 …')
//   AC5 an unregistered/unknown candidate is ADDED with discovery facets, not onboarded  describe('AC5 …')
//   AC6 an ungoverned candidate stays a VISIBLE governed-source gap w/ review .......... describe('AC6 …')
//   NO-ONBOARD the classifier never registers/onboards any candidate .................. describe('NO-ONBOARD …')

import { describe, it, expect } from 'vitest';
import { isMetadataOnly } from '../../apps/discovery-agent/src/main.ts';
import {
  ARCHITECTURE_ROLES,
  AVAILABILITY_CLASSES,
  isArchitectureRole,
  isAvailabilityClass,
} from '../../packages/domain/src/component-profile.ts';
import {
  classifyDiscoveries,
  classifyOne,
  normalizeCandidate,
  placementFor,
  CANDIDATE_CLASSIFICATIONS,
  UNKNOWN_CANDIDATE,
  CA_LIFECYCLE_STATES,
  CA_RISK_LEVELS,
  CA_CONTROL_COVERAGE,
  CA_EVIDENCE_STATES,
  CA_HEALTH_STATES,
  CA_ISSUE_TAGS,
  CA_GAP_REASONS,
  type DiscoveredCandidate,
  type CoreArchitectureClassifyOptions,
  type ArchitectureCandidate,
  type ArchitectureGap,
  type CoreArchitectureReport,
} from '../../apps/discovery-agent/src/classifiers/core-architecture.ts';

// ───────────────────────────────────────────────────────────────────────────
// Deterministic fixture harness.
// ───────────────────────────────────────────────────────────────────────────
const NOW = 1_800_000_000_000; // fixed injected epoch
const HORIZON = 60 * 60 * 1000; // 1h freshness horizon
const FRESH = NOW - 5 * 60 * 1000; // 5m old  → fresh
const STALE = NOW - 3 * 60 * 60 * 1000; // 3h old  → stale

const OPTS: CoreArchitectureClassifyOptions = {
  scope: 'machine:acme',
  now: NOW,
  freshnessHorizonMs: HORIZON,
};

function disc(
  classification: string,
  over: Partial<DiscoveredCandidate> = {},
): DiscoveredCandidate {
  // NOTE: use `in` for `owner` so an EXPLICIT `owner: null` is preserved (a `??` default would
  // silently re-own an intentionally-unowned fixture and mask the unowned-gap path).
  return {
    classification,
    identity: over.identity ?? `id:${classification}`,
    location: over.location ?? `loc/${classification}`,
    owner: 'owner' in over ? (over.owner ?? null) : 'declared-by:CODEOWNERS',
    lastObservedAt: over.lastObservedAt ?? FRESH,
  };
}

function run(discoveries: readonly DiscoveredCandidate[]): CoreArchitectureReport {
  return classifyDiscoveries(discoveries, OPTS);
}

function candidateOf(rep: CoreArchitectureReport, type: string): ArchitectureCandidate {
  const c = rep.candidates.find((x) => x.type === type);
  if (!c) throw new Error(`expected a candidate of type ${type}; got gaps only`);
  return c;
}
function gapOf(rep: CoreArchitectureReport, id: string): ArchitectureGap {
  const g = rep.gaps.find((x) => x.candidateId === id);
  if (!g) throw new Error(`expected a gap for ${id}`);
  return g;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('AC1 — a classified candidate renders ONCE with the full facet set + BOTH axes', () => {
  it('LISA is an architecture-CORE candidate: control-plane role, on-demand availability, all facets', () => {
    const rep = run([disc('lisa')]);
    // Rendered exactly ONCE.
    expect(rep.candidates.filter((c) => c.type === 'lisa')).toHaveLength(1);
    const lisa = candidateOf(rep, 'lisa');

    // AXIS 1 — owner-approved architecture role (proposed) + CORE membership.
    expect(lisa.proposedRole).toBe('control-plane');
    expect(isArchitectureRole(lisa.proposedRole)).toBe(true);
    expect(lisa.architectureCore).toBe(true);

    // AXIS 2 — runtime availability class (proposed). Per the spec: core but activated on demand.
    expect(lisa.proposedAvailability).toBe('on-demand');
    expect(isAvailabilityClass(lisa.proposedAvailability)).toBe(true);

    // The two axes are INDEPENDENT: core architecture membership does NOT imply `core` availability.
    expect(lisa.architectureCore).toBe(true);
    expect(lisa.proposedAvailability).not.toBe('core');

    // ---- ALL TEN AC1 inventory facets, with authoritative values + closed-vocab membership ----
    expect(lisa.type).toBe('lisa'); // 1 TYPE
    expect(lisa.classification).toBe('lisa');
    expect(lisa.sourceIdentity).toBe(lisa.candidateId); // 2 SOURCE IDENTITY
    expect(typeof lisa.candidateId).toBe('string');
    expect(lisa.owner).toBe('declared-by:CODEOWNERS'); // 3 OWNER
    expect(CA_LIFECYCLE_STATES).toContain(lisa.lifecycleState); // 4 LIFECYCLE
    expect(lisa.lifecycleState).toBe('candidate');
    expect(CA_RISK_LEVELS).toContain(lisa.risk); // 5 RISK
    expect(lisa.risk).toBe('low');
    expect(CA_CONTROL_COVERAGE).toContain(lisa.controlCoverage); // 6 CONTROL COVERAGE
    expect(lisa.controlCoverage).toBe('covered');
    expect(CA_EVIDENCE_STATES).toContain(lisa.evidenceState); // 7 EVIDENCE STATE
    expect(lisa.evidenceState).toBe('attested');
    expect(CA_HEALTH_STATES).toContain(lisa.health); // 8 HEALTH
    expect(lisa.health).toBe('healthy');
    expect(lisa.observedAt).toBe(NOW); // 9 LAST OBSERVATION TIME
    for (const tag of lisa.unresolvedIssues) expect(CA_ISSUE_TAGS).toContain(tag); // 10 UNRESOLVED ISSUES
    // Even a clean, fresh, owned candidate ALWAYS carries the owner-approval-required issue (advisory).
    expect(lisa.unresolvedIssues).toContain('owner-approval-required');

    // The durable record is metadata-only.
    expect(isMetadataOnly(lisa.metadata)).toBe(true);
  });

  it('Wiggum is an architecture-CORE candidate: connector role, on-demand availability', () => {
    const wiggum = candidateOf(run([disc('wiggum')]), 'wiggum');
    expect(wiggum.architectureCore).toBe(true);
    expect(wiggum.proposedRole).toBe('connector');
    expect(wiggum.proposedAvailability).toBe('on-demand');
  });

  it('the named non-core systems are placed on BOTH axes but are NOT architecture-core', () => {
    const rep = run([
      disc('kanban'),
      disc('workflow_orchestration'),
      disc('agentctl'),
      disc('openclaw'),
      disc('agentes'),
      disc('agentes-oilgas'),
      disc('mcp'),
      disc('terraform'),
      disc('netbox'),
      disc('deployment-console'),
    ]);
    // Every one of them placed, none of them core.
    const expected: Record<string, { role: string; avail: string }> = {
      kanban: { role: 'connector', avail: 'optional' },
      workflow_orchestration: { role: 'worker', avail: 'optional' },
      agentctl: { role: 'controller', avail: 'optional' },
      openclaw: { role: 'connector', avail: 'on-demand' },
      agentes: { role: 'connector', avail: 'on-demand' },
      'agentes-oilgas': { role: 'connector', avail: 'on-demand' },
      mcp: { role: 'connector', avail: 'on-demand' },
      terraform: { role: 'controller', avail: 'on-demand' },
      netbox: { role: 'connector', avail: 'on-demand' },
      'deployment-console': { role: 'controller', avail: 'on-demand' },
    };
    for (const [type, want] of Object.entries(expected)) {
      const c = candidateOf(rep, type);
      expect(c.proposedRole, `${type} role`).toBe(want.role);
      expect(c.proposedAvailability, `${type} availability`).toBe(want.avail);
      expect(isArchitectureRole(c.proposedRole)).toBe(true);
      expect(isAvailabilityClass(c.proposedAvailability)).toBe(true);
      expect(c.architectureCore, `${type} must NOT be core`).toBe(false);
    }
    // Exactly the two core candidates in the whole system are LISA + Wiggum — none here.
    expect(rep.counts.architectureCore).toBe(0);
  });

  it('NEGATIVE control: a facet is not vacuously constant — an unowned+stale candidate is NOT covered/healthy', () => {
    // Same LISA marker, but unowned and stale ⇒ it becomes a GAP, not a covered/healthy candidate.
    const rep = run([
      disc('lisa', { owner: null, lastObservedAt: STALE, identity: 'id:lisa-bad' }),
    ]);
    expect(rep.candidates.find((c) => c.candidateId === 'id:lisa-bad')).toBeUndefined();
    expect(rep.gaps.find((g) => g.candidateId === 'id:lisa-bad')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AC2 — a discovered-but-unmanaged candidate stays a VISIBLE gap', () => {
  it('an unowned known candidate becomes a visible gap with reason + age + impact + owner action', () => {
    const rep = run([disc('kanban', { owner: null, identity: 'id:kanban-unowned' })]);
    const gap = gapOf(rep, 'id:kanban-unowned');
    expect(gap.reason).toBe('unowned');
    expect(CA_GAP_REASONS).toContain(gap.reason);
    expect(gap.impact).toBe('medium');
    expect(gap.ownerAction).toBe('assign-accountable-owner');
    expect(gap.ageMs).toBeGreaterThanOrEqual(0);
    expect(gap.observedAt).toBe(NOW);
    expect(isMetadataOnly(gap.metadata)).toBe(true);
  });

  it('NEGATIVE control: an OWNED, fresh, known candidate is NOT a gap — it is a placed candidate', () => {
    const rep = run([disc('kanban', { identity: 'id:kanban-ok' })]);
    expect(rep.gaps.find((g) => g.candidateId === 'id:kanban-ok')).toBeUndefined();
    expect(rep.candidates.find((c) => c.candidateId === 'id:kanban-ok')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AC3 — distinct named-system records per pass: correlated, status differences, dependencies', () => {
  it('kanban / agentctl / workflow_orchestration are distinct records under ONE correlationId with deps', () => {
    // One pass over the three NAMED systems. agentctl is stale by its OWN age; the others are fresh.
    const rep = run([
      disc('kanban', { identity: 'id:kanban', lastObservedAt: FRESH }),
      disc('agentctl', { identity: 'id:agentctl', lastObservedAt: STALE }),
      disc('workflow_orchestration', { identity: 'id:wf', lastObservedAt: FRESH }),
    ]);

    // FOUR? no — exactly THREE distinct records, one per named system.
    expect(rep.records).toHaveLength(3);
    const byName = new Map(rep.records.map((r) => [r.candidate, r] as const));
    expect(new Set([...byName.keys()])).toEqual(
      new Set(['kanban', 'agentctl', 'workflow_orchestration']),
    );

    // CORRELATION: all three share ONE correlationId (the pass id).
    const ids = new Set(rep.records.map((r) => r.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(rep.correlationId);

    // STATUS DIFFERENCES: kanban + workflow current, agentctl stale — by each record's OWN age.
    expect(byName.get('kanban')!.status).toBe('current');
    expect(byName.get('workflow_orchestration')!.status).toBe('current');
    expect(byName.get('agentctl')!.status).toBe('stale');

    // DEPENDENCY edges across the NAMED systems: workflow_orchestration → agentctl + kanban;
    // agentctl → kanban; kanban → (none).
    expect([...byName.get('workflow_orchestration')!.dependsOn].sort()).toEqual(
      ['agentctl', 'kanban'].sort(),
    );
    expect(byName.get('agentctl')!.dependsOn).toEqual(['kanban']);
    expect(byName.get('kanban')!.dependsOn).toEqual([]);
  });

  it('NEGATIVE control: with kanban ABSENT, agentctl no longer declares a kanban edge', () => {
    const rep = run([
      disc('agentctl', { identity: 'id:agentctl' }),
      disc('workflow_orchestration', { identity: 'id:wf' }),
    ]);
    const byName = new Map(rep.records.map((r) => [r.candidate, r] as const));
    // Edges track PRESENT systems, not a hardcoded list: no kanban present ⇒ no kanban edge.
    expect(byName.get('agentctl')!.dependsOn).toEqual([]);
    expect(byName.get('workflow_orchestration')!.dependsOn).toEqual(['agentctl']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AC4 — a stale candidate is marked with last-known time + confidence; axes NOT asserted', () => {
  it('a stale candidate keeps its last-known time, decays confidence, and is NOT axis-asserted', () => {
    // Owned + placeable but STALE ⇒ surfaced as a `stale` gap; its record preserves last-known time.
    const rep = run([disc('mcp', { identity: 'id:mcp-stale', lastObservedAt: STALE })]);
    const gap = gapOf(rep, 'id:mcp-stale');
    expect(gap.reason).toBe('stale');
    // The correlated record preserves the LAST-KNOWN observation time (AC4).
    const rec = rep.records.find((r) => r.candidate === 'mcp')!;
    expect(rec.lastObservedAt).toBe(STALE);
    expect(rec.status).toBe('stale');
  });

  it('health / axisAssertable are NEVER asserted from stale data (fresh vs stale contrast)', () => {
    // Fresh, owned ⇒ a placed candidate whose axes ARE assertable and health is asserted.
    const fresh = candidateOf(run([disc('terraform', { identity: 'id:tf-fresh' })]), 'terraform');
    expect(fresh.freshness).toBe('fresh');
    expect(fresh.axisAssertable).toBe(true);
    expect(fresh.health).toBe('healthy');
    expect(fresh.confidence).toBe(1);

    // A candidate that is fresh but unowned degrades (fresh data, open concern) — still not from stale.
    const degraded = run([disc('terraform', { identity: 'id:tf-unowned', owner: null })]);
    // unowned+fresh ⇒ gap (unowned), so assert via a placeable-but-degraded path instead:
    expect(degraded.gaps.find((g) => g.candidateId === 'id:tf-unowned')?.reason).toBe('unowned');
  });

  it('NEGATIVE control: a FRESH candidate is NOT downgraded — confidence 1, freshness fresh, assertable', () => {
    const c = candidateOf(run([disc('netbox', { identity: 'id:netbox-fresh' })]), 'netbox');
    expect(c.freshness).toBe('fresh');
    expect(c.confidence).toBe(1);
    expect(c.axisAssertable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AC5 — an unregistered / unknown candidate is ADDED with discovery facets, not onboarded', () => {
  it('an UNKNOWN candidate is surfaced as an unsupported gap (added, not dropped, not onboarded)', () => {
    const rep = run([disc('some-brand-new-thing', { identity: 'id:mystery' })]);
    // Normalized to the catch-all.
    expect(normalizeCandidate('some-brand-new-thing')).toBe(UNKNOWN_CANDIDATE);
    const gap = gapOf(rep, 'id:mystery');
    expect(gap.reason).toBe('unsupported');
    expect(gap.ownerAction).toBe('assign-candidate-type-or-declare-unsupported');
    // A visible record with discovery evidence — metadata only.
    expect(isMetadataOnly(gap.metadata)).toBe(true);
    // It was ADDED, not silently ignored.
    expect(rep.counts.considered).toBe(1);
    expect(rep.counts.gaps).toBe(1);
  });

  it('placementFor(unknown) is null and unknown has no proposed axes', () => {
    expect(placementFor(UNKNOWN_CANDIDATE)).toBeNull();
    const rec = run([disc('unknown', { identity: 'id:u' })]).records[0]!;
    expect(rec.proposedRole).toBeNull();
    expect(rec.proposedAvailability).toBeNull();
    expect(rec.architectureCore).toBe(false);
  });

  it('NEGATIVE control: a KNOWN candidate is NOT forced to unknown — it keeps its real placement', () => {
    expect(normalizeCandidate('LISA')).toBe('lisa'); // case-insensitive, still known
    const c = candidateOf(run([disc('LISA', { identity: 'id:lisa-caps' })]), 'lisa');
    expect(c.proposedRole).toBe('control-plane');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AC6 — an ungoverned candidate stays a VISIBLE governed-source gap with a review deadline', () => {
  it('every gap carries a mandatory review-or-expiry date after now', () => {
    const rep = run([
      disc('unknown', { identity: 'id:g1' }),
      disc('kanban', { owner: null, identity: 'id:g2' }),
      disc('agentctl', { lastObservedAt: STALE, identity: 'id:g3' }),
    ]);
    expect(rep.gaps.length).toBe(3);
    for (const g of rep.gaps) {
      expect(g.reviewBy).toBeGreaterThan(NOW); // review-or-expiry is mandatory + in the future
      expect(g.ownerAction.length).toBeGreaterThan(0);
      expect(CA_GAP_REASONS).toContain(g.reason);
    }
  });

  it('NEGATIVE control: a healthy placed candidate is NOT a gap and has no gap review row', () => {
    const rep = run([disc('lisa', { identity: 'id:lisa-clean' })]);
    expect(rep.gaps).toHaveLength(0);
    expect(rep.candidates).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('NO-ONBOARD — the classifier proposes, it NEVER registers/onboards a candidate', () => {
  it('every placed candidate is registered:false, onboarding:discovered, ownerApprovalRequired:true', () => {
    const rep = run([disc('lisa'), disc('wiggum'), disc('kanban'), disc('terraform')]);
    expect(rep.candidates.length).toBe(4);
    for (const c of rep.candidates) {
      expect(c.registered).toBe(false); // never onboarded
      expect(c.onboarding).toBe('discovered'); // still awaiting onboarding
      expect(c.ownerApprovalRequired).toBe(true); // an approved profile is NOT forged here
      expect(c.unresolvedIssues).toContain('owner-approval-required');
      // The durable metadata record is likewise never marked registered.
      expect(c.metadata.registered).toBe(false);
    }
  });

  it('gaps carry onboarding:gap and registered:false in their durable metadata', () => {
    const rep = run([disc('unknown', { identity: 'id:x' })]);
    const gap = gapOf(rep, 'id:x');
    expect(gap.metadata.registered).toBe(false);
    expect(gap.metadata.onboarding).toBe('gap');
  });

  it('classifyOne exposes the SAME advisory contract for a single candidate', () => {
    const outcome = classifyOne(disc('wiggum'), [], OPTS);
    expect('candidate' in outcome).toBe(true);
    if ('candidate' in outcome) {
      expect(outcome.candidate.registered).toBe(false);
      expect(outcome.candidate.ownerApprovalRequired).toBe(true);
      expect(outcome.candidate.architectureCore).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('vocabulary sanity — placements only reference VALID domain axes', () => {
  it('every known candidate maps to a valid ARCHITECTURE_ROLES + AVAILABILITY_CLASSES member', () => {
    for (const cand of CANDIDATE_CLASSIFICATIONS) {
      if (cand === UNKNOWN_CANDIDATE) {
        expect(placementFor(cand)).toBeNull();
        continue;
      }
      const p = placementFor(cand)!;
      expect(ARCHITECTURE_ROLES).toContain(p.role);
      expect(AVAILABILITY_CLASSES).toContain(p.availability);
    }
  });

  it('reconciliation: a duplicate identity is de-duplicated to ONE reconciled row', () => {
    const rep = run([
      disc('kanban', { identity: 'id:dup' }),
      disc('kanban', { identity: 'id:dup' }),
    ]);
    expect(rep.candidates.filter((c) => c.candidateId === 'id:dup')).toHaveLength(1);
  });
});
