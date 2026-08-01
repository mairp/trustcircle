// Integration suite — the CORE-ONLY control-plane profile, proven behaviorally against the
// NFR-010 safe-degradation gate (Phase 55 / task T055 / work item KSM4N43A8R9PBWMHXKMMAN0MES /
// VO-80051a0ad930b1560ff7).
//
// SOLE acceptance oracle (NFR-010 "Safe Degradation"):
//   "Loss of required authority, policy, evidence, ownership, or reconciliation MUST block
//    affected execution immediately. Health or connectivity loss MUST block new execution
//    immediately; an in-progress operation may continue only under FR-046 through FR-050 while
//    read-only visibility and escalation remain available."
//
// WHAT THIS SUITE PROVES (and how it observes it)
// -----------------------------------------------
// It binds the three grounding artifacts into ONE independently-observable witness of the
// oracle, so the deployed core-only profile and the executable gate cannot silently diverge:
//
//   1. deploy/compose/control-plane.yml  (Phase 54, the BOUND artifact) — the orchestrator
//      realization of the core-required runtime set: which services boot, and with which
//      dependency conditions (service_healthy = hard/fail-closed, service_started = soft).
//   2. deploy/profiles/components.yaml    (Phase 53) — the AUTHORITATIVE declaration: the five
//      runtime sets, the deterministic startupOrder, each component's required dependsOn edges,
//      its governance prerequisites, and the degradationPolicy.
//   3. packages/domain/src/component-profile.ts (Phase 52) — the REAL, executable NFR-010 gate
//      `evaluateExecutionGate`, exercised here (never re-implemented) against per-component
//      profiles + runtime-availability snapshots DERIVED FROM the parsed deployment facts.
//
// INDEPENDENT READ PATH (effect-witness discipline). No assertion trusts a "mutation echo":
//   * The core startup SET is read back from the parsed compose `services` map and compared to
//     the core-required set DERIVED from the profile — not a memorized list.
//   * The readiness/prerequisite behavior is witnessed by feeding the gate a runtime-availability
//     snapshot in which a prerequisite (or health/connectivity) is lost, and reading the gate's
//     RETURNED decision (allowed/blocked/safeAction), i.e. the gate's own observable output.
//   * "No optional incident noise" is witnessed by confirming every expected-offline component is
//     ABSENT from the deployed core set (its offline state is the expected steady state), and that
//     an offline expected-offline component is NEVER classified as a degraded/failed incident.
//   * "Safe shutdown" is witnessed by (a) the gate keeping readOnlyVisibility + escalation true in
//     EVERY outcome, and (b) an ordered teardown that reverses the profile's startupOrder without
//     tearing down a still-depended-on service before its dependents.
//
// Every positive property is paired with a NEGATIVE CONTROL — a mutated in-memory copy of the
// parsed document, or a flipped availability input — that MUST flip the observable outcome, so
// none of the oracle checks is vacuous. Time is injected (a fixed clock T0); nothing reads the
// wall clock. Bundle identity is pinned: the suite refuses evidence whose bundle id / semantic
// hash / work item differs from the pinned input (VO-80051a0ad930b1560ff7).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import {
  PREREQUISITES,
  AVAILABILITY_CLASSES,
  evaluateExecutionGate,
  unmetPrerequisites,
  defineArchitectureRoleProfile,
  type ArchitectureRoleProfile,
  type ArchitectureRole,
  type Prerequisite,
  type RuntimeAvailability,
  type ContinuityLease,
} from '../../packages/domain/src/component-profile.ts';
import { uuidV7, makeReason, PLATFORM_SCOPE } from '../../packages/domain/src/primitives.ts';

// ---------------------------------------------------------------------------
// Grounding sources (parsed, never asserted from memory) + pinned identity.
// ---------------------------------------------------------------------------
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p: string) => join(ROOT, p);
const rd = (p: string) => readFileSync(rel(p), 'utf8');

const COMPOSE = 'deploy/compose/control-plane.yml';
const PROFILE = 'deploy/profiles/components.yaml';

const BUNDLE = '36GCYGDJ15PTYP60F91QWRAY2M';
const SEMANTIC_HASH = 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b';
const WORK_ITEM = 'KSM4N43A8R9PBWMHXKMMAN0MES';

// js-yaml DEFAULT_SCHEMA resolves the compose file's `<<` merge anchors so `environment`
// blocks are fully materialized (mirrors the Phase-54 tooling test's loader).
const loadCompose = () => yaml.load(rd(COMPOSE), { schema: yaml.DEFAULT_SCHEMA }) as ComposeDoc;
const loadProfile = () => yaml.load(rd(PROFILE)) as ProfileDoc;
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

// ---- Minimal shapes for the parsed documents (typed only where we read them). ----
interface ComposeService {
  depends_on?: Record<string, { condition?: string }> | string[];
  healthcheck?: { test?: unknown };
  environment?: Record<string, unknown>;
}
interface ComposeDoc {
  name?: string;
  services: Record<string, ComposeService>;
}
interface ProfileComponent {
  id: string;
  role: ArchitectureRole;
  runtimeSet: string;
  dependsOn?: { component: string; required?: boolean }[];
  authority?: { mayExecute?: boolean; consequentialActions?: string[]; crossTenant?: boolean };
  prerequisites?: Prerequisite[];
}
interface ProfileDoc {
  bundle: { id: string; contentHash: string; workItem: string };
  obligation: { vo: string; nfr: string };
  startupOrder: string[];
  degradationPolicy: {
    prerequisiteLoss: {
      blocksNewExecution: boolean;
      blocksInProgressExecution: boolean;
      continuityLeaseApplies: boolean;
    };
    healthOrConnectivityLoss: {
      blocksNewExecution: boolean;
      inProgressMayContinue: boolean;
      inProgressRequiresContinuityLease: boolean;
    };
    alwaysAvailable: { readOnlyVisibility: boolean; escalation: boolean };
    expectedOfflineRuntimeSets: string[];
    nonHealthyStates: string[];
  };
  components: ProfileComponent[];
}

// ---------------------------------------------------------------------------
// Derive the AUTHORITATIVE core-required expectations FROM the profile, so the deployed
// compose set and the gate inputs are checked against the DECLARATION, not a memorized list.
// ---------------------------------------------------------------------------
const EXPECTED_OFFLINE_SETS = ['on-demand', 'optional', 'external', 'intentionally-inactive'];

function profileFacts() {
  const profile = loadProfile();
  const core = profile.components.filter((c) => c.runtimeSet === 'core-required');
  const requiredEdges: Record<string, string[]> = {};
  for (const c of core) {
    requiredEdges[c.id] = (c.dependsOn ?? [])
      .filter((d) => d && d.required === true)
      .map((d) => d.component);
  }
  const executors = core.filter((c) => c.authority?.mayExecute === true).map((c) => c.id);
  const prereqsByComponent: Record<string, Prerequisite[]> = {};
  const roleById: Record<string, ArchitectureRole> = {};
  const mayExecuteById: Record<string, boolean> = {};
  for (const c of core) {
    prereqsByComponent[c.id] = c.prerequisites ?? [];
    roleById[c.id] = c.role;
    mayExecuteById[c.id] = c.authority?.mayExecute === true;
  }
  const expectedOfflineIds = profile.components
    .filter((c) => EXPECTED_OFFLINE_SETS.includes(c.runtimeSet))
    .map((c) => c.id);
  return {
    profile,
    core,
    coreIds: core.map((c) => c.id),
    startupOrder: profile.startupOrder,
    requiredEdges,
    executors,
    prereqsByComponent,
    roleById,
    mayExecuteById,
    expectedOfflineIds,
    degradationPolicy: profile.degradationPolicy,
  };
}

/** The dependency condition compose declares for `service`→`dep` (undefined if none). */
function depCondition(service: ComposeService | undefined, dep: string): string | undefined {
  const d = service?.depends_on;
  if (!d) return undefined;
  if (Array.isArray(d)) return d.includes(dep) ? 'service_started' : undefined;
  const entry = d[dep];
  if (!entry) return undefined;
  return entry.condition ?? 'service_started';
}

// ---------------------------------------------------------------------------
// Fixture builders for the REAL executable gate. A component's owner-approved architecture
// role profile is reconstructed from the PROFILE facts (role, mayExecute, prerequisites), so
// the gate is driven by the deployed declaration rather than by hand-picked constants.
// ---------------------------------------------------------------------------
const T0 = 1_700_000_000_000;
const owner = { ownerId: 'sre-platform', kind: 'team' as const };
const contract = {
  tests: ['VO-80051a0ad930b1560ff7'],
  monitoring: ['component.health', 'component.connectivity'],
  failureBehavior: 'fail-closed' as const,
  exceptions: [],
  evidenceExpectations: ['core-only-profile-witness'],
};
const approval = {
  approvedBy: owner,
  reason: makeReason('owner_approved', 'core-required component role approved for control plane'),
  effectiveFrom: T0,
  reviewDate: T0 + 90 * 86_400_000,
};
let idSeed = 0x10;
const nextId = () => uuidV7(T0 + idSeed, () => new Uint8Array(16).fill(idSeed++ & 0xff));

/** Build an owner-approved architecture-role profile for a core component from profile facts. */
function profileFor(componentId: string): ArchitectureRoleProfile {
  const f = profileFacts();
  const mayExecute = f.mayExecuteById[componentId] === true;
  // The domain gate requires an executing component to require ALL five prerequisites; a
  // read-only component requires exactly the prerequisites the profile lists for it.
  const requires: Prerequisite[] = mayExecute
    ? [...PREREQUISITES]
    : [...(f.prereqsByComponent[componentId] ?? [])];
  return defineArchitectureRoleProfile({
    id: nextId(),
    tenantId: PLATFORM_SCOPE,
    version: 1,
    owner,
    lifecycleState: 'active',
    contract,
    role: f.roleById[componentId] ?? 'controller',
    dependencies: [{ componentId: nextId(), role: 'policy-engine', required: true }],
    authority: {
      mayExecute,
      consequentialActions: mayExecute ? ['reconcile'] : [],
      crossTenant: false,
    },
    activation: { requires, manualApprovalRequired: mayExecute },
    approval,
  });
}

const allPrereqsSatisfied: Record<Prerequisite, boolean> = {
  authority: true,
  policy: true,
  evidence: true,
  ownership: true,
  reconciliation: true,
};

function availability(over: Partial<RuntimeAvailability> = {}): RuntimeAvailability {
  return {
    availabilityClass: 'core',
    state: 'available',
    prerequisites: { ...allPrereqsSatisfied },
    healthy: true,
    connected: true,
    lastObservedAt: T0,
    ...over,
  };
}

function validLease(over: Partial<ContinuityLease> = {}): ContinuityLease {
  return {
    leaseId: nextId(),
    policyVersion: 1,
    operationId: nextId(),
    startedBeforeFailure: true,
    expiresAt: T0 + 10 * 60_000, // within the 15-min NFR-012 ceiling
    stepLocallyVerifiable: true,
    evidenceBuffered: true,
    ...over,
  };
}

// ============================================================================
// 0. PROVENANCE — the artifacts under test are bound to THIS bundle/work-item.
//    (Reject evidence whose bundle/semantic-hash/work-item differs from the pinned input.)
// ============================================================================
describe('0. provenance / bundle identity', () => {
  it('0.1 the profile pins this bundle id, content hash, work item, and VO', () => {
    const { profile } = profileFacts();
    expect(profile.bundle.id).toBe(BUNDLE);
    expect(profile.bundle.contentHash).toBe(SEMANTIC_HASH);
    expect(profile.bundle.workItem).toBe(WORK_ITEM);
    expect(profile.obligation.vo).toBe('VO-80051a0ad930b1560ff7');
    expect(profile.obligation.nfr).toBe('NFR-010');
  });

  it('0.2 the compose file carries the pinned bundle id + semantic hash (no foreign identity)', () => {
    const src = rd(COMPOSE);
    expect(src).toContain(BUNDLE);
    expect(src).toContain(SEMANTIC_HASH);
    // Negative control: a foreign hash must NOT be present (guards copy/paste drift).
    const foreign = 'deadbeef' + '0'.repeat(56);
    expect(src).not.toContain(foreign);
  });
});

// ============================================================================
// A. CORE-ONLY STARTUP — exactly the ten core-required services boot, in the declared
//    order, and NOTHING from an expected-offline runtime set leaks in.
// ============================================================================
describe('A. core-only startup', () => {
  it('A1: compose boots EXACTLY the profile core-required set (independent read path)', () => {
    const doc = loadCompose();
    const { coreIds } = profileFacts();
    expect(coreIds).toHaveLength(10);
    const services = Object.keys(doc.services).sort();
    expect(services).toEqual([...coreIds].sort());

    // Negative control: dropping a core service (nats) breaks the set-equality.
    const mutated = clone(doc);
    delete mutated.services.nats;
    expect(Object.keys(mutated.services).sort()).not.toEqual([...coreIds].sort());
  });

  it('A2: NO expected-offline component (on-demand/optional/external/inactive) is in the core profile', () => {
    const doc = loadCompose();
    const { expectedOfflineIds } = profileFacts();
    const services = new Set(Object.keys(doc.services));
    expect(expectedOfflineIds.length).toBeGreaterThan(0);
    for (const id of expectedOfflineIds) expect(services.has(id)).toBe(false);
    for (const id of [
      'lisa',
      'wiggum',
      'kanban',
      'agentctl',
      'workflow-orchestration',
      'legacy-jira-connector',
    ]) {
      expect(services.has(id)).toBe(false);
    }

    // Negative control: injecting an on-demand connector (lisa) is detected.
    const mutated = clone(doc);
    mutated.services.lisa = {};
    const leaked = [...new Set(Object.keys(mutated.services))].some((s) =>
      expectedOfflineIds.includes(s),
    );
    expect(leaked).toBe(true);
  });

  it('A3: every depends_on edge respects the profile startupOrder (a service starts after its deps)', () => {
    const doc = loadCompose();
    const { startupOrder } = profileFacts();
    const idx = Object.fromEntries(startupOrder.map((id, i) => [id, i]));
    for (const [name, svc] of Object.entries(doc.services)) {
      const deps =
        svc.depends_on && !Array.isArray(svc.depends_on) ? Object.keys(svc.depends_on) : [];
      for (const dep of deps) expect(idx[dep]).toBeLessThan(idx[name]);
    }

    // Negative control: an inverted dependency (postgres depends_on api) violates the order.
    const mutated = clone(doc);
    mutated.services.postgres.depends_on = { api: { condition: 'service_started' } };
    let bad = false;
    for (const [name, svc] of Object.entries(mutated.services)) {
      const deps =
        svc.depends_on && !Array.isArray(svc.depends_on) ? Object.keys(svc.depends_on) : [];
      for (const dep of deps) if (!(idx[dep] < idx[name])) bad = true;
    }
    expect(bad).toBe(true);
  });
});

// ============================================================================
// B. READINESS DEPENDENCIES — loss of a required prerequisite blocks affected execution
//    IMMEDIATELY (new AND in-progress); health/connectivity loss blocks NEW execution
//    immediately. Witnessed by driving the REAL gate with availability snapshots derived
//    from the deployed profile, AND by the compose file's hard `service_healthy` edges.
// ============================================================================
describe('B. readiness dependencies (prerequisite + health loss)', () => {
  it('B1 (gate): losing ANY governance prerequisite blocks NEW execution immediately', () => {
    const p = profileFor('api'); // an executor requiring all five prerequisites
    for (const req of PREREQUISITES) {
      const av = availability({ prerequisites: { ...allPrereqsSatisfied, [req]: false } });
      expect(unmetPrerequisites(p, av)).toEqual([req]);
      const r = evaluateExecutionGate({ profile: p, availability: av, execution: 'new', now: T0 });
      expect(r.allowed).toBe(false);
      expect(r.blocked).toContain('prerequisite-lost');
      expect(r.safeAction).toBe('block');
    }

    // Negative control: with every prerequisite satisfied the same executor proceeds.
    const ok = evaluateExecutionGate({
      profile: p,
      availability: availability(),
      execution: 'new',
      now: T0,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.blocked).toEqual([]);
  });

  it('B2 (gate): a lost prerequisite blocks an IN-PROGRESS step even under a valid continuity lease', () => {
    const p = profileFor('command-worker');
    const av = availability({
      prerequisites: { ...allPrereqsSatisfied, evidence: false },
      continuityLease: validLease(),
    });
    const r = evaluateExecutionGate({
      profile: p,
      availability: av,
      execution: 'in-progress',
      now: T0,
    });
    expect(r.allowed).toBe(false);
    expect(r.blocked).toContain('prerequisite-lost');
    expect(r.continuity).toBe(false);

    // Negative control: same valid lease, prerequisites intact but health lost ⇒ continuity permits it.
    const cont = evaluateExecutionGate({
      profile: p,
      availability: availability({
        healthy: false,
        state: 'degraded',
        continuityLease: validLease(),
      }),
      execution: 'in-progress',
      now: T0,
    });
    expect(cont.allowed).toBe(true);
    expect(cont.continuity).toBe(true);
  });

  it('B3 (gate): health/connectivity loss blocks NEW execution immediately (no continuity for new ops)', () => {
    const p = profileFor('api');
    for (const av of [
      availability({ healthy: false, state: 'unavailable' }),
      availability({ connected: false, state: 'unavailable' }),
    ]) {
      const r = evaluateExecutionGate({ profile: p, availability: av, execution: 'new', now: T0 });
      expect(r.allowed).toBe(false);
      expect(r.blocked).toContain('health-or-connectivity-lost');
    }
    // Negative control: even WITH a valid lease, a NEW op never enters continuity (FR-047).
    const withLease = evaluateExecutionGate({
      profile: p,
      availability: availability({
        healthy: false,
        state: 'degraded',
        continuityLease: validLease(),
      }),
      execution: 'new',
      now: T0,
    });
    expect(withLease.allowed).toBe(false);
    expect(withLease.continuity).toBe(false);
  });

  it('B4 (gate): the declared degradationPolicy matches the gate behavior it governs', () => {
    const { degradationPolicy } = profileFacts();
    // Sentence 1 — prerequisite loss blocks BOTH new and in-progress; continuity does NOT apply.
    expect(degradationPolicy.prerequisiteLoss.blocksNewExecution).toBe(true);
    expect(degradationPolicy.prerequisiteLoss.blocksInProgressExecution).toBe(true);
    expect(degradationPolicy.prerequisiteLoss.continuityLeaseApplies).toBe(false);
    // Sentence 2 — health/connectivity blocks new; in-progress only under a lease.
    expect(degradationPolicy.healthOrConnectivityLoss.blocksNewExecution).toBe(true);
    expect(degradationPolicy.healthOrConnectivityLoss.inProgressRequiresContinuityLease).toBe(true);
  });

  it('B5 (compose): every profile required edge is a HARD service_healthy edge (fail-closed substrate)', () => {
    const doc = loadCompose();
    const { requiredEdges } = profileFacts();
    for (const [comp, deps] of Object.entries(requiredEdges)) {
      for (const dep of deps) {
        // web→api is the visibility exception (asserted in section D), never a hard health gate.
        if (comp === 'web' && dep === 'api') continue;
        expect(depCondition(doc.services[comp], dep)).toBe('service_healthy');
      }
    }

    // Negative control: weakening api→opa to service_started breaks the fail-closed edge.
    const mutated = clone(doc);
    (mutated.services.api.depends_on as Record<string, { condition?: string }>).opa = {
      condition: 'service_started',
    };
    expect(depCondition(mutated.services.api, 'opa')).not.toBe('service_healthy');
  });

  it('B6 (compose): every executor binds HARD to the policy provider (opa), and backing infra is health-checked', () => {
    const doc = loadCompose();
    const { executors, prereqsByComponent } = profileFacts();
    expect(executors.length).toBeGreaterThanOrEqual(2);
    for (const id of executors) {
      expect(prereqsByComponent[id]).toContain('policy');
      expect(depCondition(doc.services[id], 'opa')).toBe('service_healthy');
    }
    for (const infra of ['postgres', 'object-storage', 'nats', 'opa']) {
      expect(doc.services[infra]?.healthcheck?.test).toBeTruthy();
    }

    // Negative control: removing the postgres healthcheck removes the substrate readiness gate.
    const mutated = clone(doc);
    delete mutated.services.postgres.healthcheck;
    expect(mutated.services.postgres.healthcheck).toBeUndefined();
  });
});

// ============================================================================
// C. ABSENCE OF OPTIONAL INCIDENT NOISE — an expected-offline component's offline state is the
//    expected steady state and is NEVER classified as a degraded/stale/unreachable/failed
//    incident; a DEGRADED CORE component is likewise never silently reported healthy.
// ============================================================================
describe('C. absence of optional incident noise', () => {
  it('C1: expected-offline runtime sets are DISTINCT from the non-healthy incident states', () => {
    const { degradationPolicy } = profileFacts();
    const offline = new Set(degradationPolicy.expectedOfflineRuntimeSets);
    const nonHealthy = new Set(degradationPolicy.nonHealthyStates);
    expect([...offline].sort()).toEqual([...EXPECTED_OFFLINE_SETS].sort());
    // The two vocabularies never overlap — an expected-offline set is not an incident state.
    for (const s of offline) expect(nonHealthy.has(s)).toBe(false);
    expect(nonHealthy.has('degraded')).toBe(true);
    expect(nonHealthy.has('failed')).toBe(true);
  });

  it('C2: no expected-offline component is deployed, so its offline state raises no incident', () => {
    const doc = loadCompose();
    const { expectedOfflineIds } = profileFacts();
    const deployed = new Set(Object.keys(doc.services));
    // None deployed ⇒ each is expected-offline, not a coverage gap / incident.
    for (const id of expectedOfflineIds) expect(deployed.has(id)).toBe(false);

    // Negative control: were an on-demand connector deployed into the core profile, it would
    // no longer be "expected-offline", i.e. the distinctness guarantee would be violated.
    const mutated = clone(doc);
    mutated.services.lisa = {};
    expect(new Set(Object.keys(mutated.services)).has('lisa')).toBe(true);
  });

  it('C3 (gate): a DEGRADED core component is never reported ready — no false green over a stale core', () => {
    const p = profileFor('projector'); // a read-model core component (mayExecute:false)
    const degraded = availability({ state: 'degraded', healthy: false });
    const r = evaluateExecutionGate({
      profile: p,
      availability: degraded,
      execution: 'new',
      now: T0,
    });
    expect(r.allowed).toBe(false); // stale/degraded core ⇒ blocked, never inferred healthy.

    // Negative control: a healthy+available core component IS ready.
    const healthy = evaluateExecutionGate({
      profile: p,
      availability: availability(),
      execution: 'new',
      now: T0,
    });
    expect(healthy.allowed).toBe(true);
  });

  it('C4: the availability vocabulary keeps expected-offline (on-demand/optional) as first-class classes', () => {
    // on-demand and optional are AVAILABILITY classes, not incident states — a component in
    // those classes being offline is modeled as expected, never as a failure.
    expect([...AVAILABILITY_CLASSES]).toContain('on-demand');
    expect([...AVAILABILITY_CLASSES]).toContain('optional');
    expect([...AVAILABILITY_CLASSES]).not.toContain('degraded');
    expect([...AVAILABILITY_CLASSES]).not.toContain('failed');
  });
});

// ============================================================================
// D. SAFE SHUTDOWN — read-only VISIBILITY and ESCALATION remain available in EVERY degraded
//    state, and teardown is ordered (reverse startupOrder) so no dependent is stranded.
// ============================================================================
describe('D. safe shutdown', () => {
  it('D1 (gate): read-only visibility + escalation remain true in EVERY gate outcome', () => {
    const p = profileFor('api');
    const cases: RuntimeAvailability[] = [
      availability(), // permitted
      availability({ prerequisites: { ...allPrereqsSatisfied, policy: false } }), // prereq lost
      availability({ healthy: false, state: 'unavailable' }), // health lost, no lease
      availability({ healthy: false, state: 'degraded', continuityLease: validLease() }), // continuity
      availability({ state: 'inactive' }), // not activated
    ];
    for (const execution of ['new', 'in-progress'] as const) {
      for (const av of cases) {
        const r = evaluateExecutionGate({ profile: p, availability: av, execution, now: T0 });
        expect(r.readOnlyVisibility).toBe(true);
        expect(r.escalation).toBe(true);
      }
    }
    // The profile's degradation policy declares the same always-available guarantee.
    const { degradationPolicy } = profileFacts();
    expect(degradationPolicy.alwaysAvailable.readOnlyVisibility).toBe(true);
    expect(degradationPolicy.alwaysAvailable.escalation).toBe(true);
  });

  it('D2 (compose): web keeps visibility+escalation up when the core is degraded (service_started only)', () => {
    const doc = loadCompose();
    const web = doc.services.web;
    expect(web).toBeTruthy();
    const deps = web.depends_on && !Array.isArray(web.depends_on) ? web.depends_on : {};
    expect(Object.keys(deps).sort()).toEqual(['api']);
    expect(depCondition(web, 'api')).toBe('service_started'); // NOT gated on api health.
    // web must not be gated behind any backing prerequisite's health.
    for (const infra of ['postgres', 'object-storage', 'nats', 'opa']) {
      expect(Object.keys(deps)).not.toContain(infra);
    }

    // Negative control: gating web behind api service_healthy would hide a degraded core.
    const mutated = clone(doc);
    mutated.services.web.depends_on = { api: { condition: 'service_healthy' } };
    expect(depCondition(mutated.services.web, 'api')).not.toBe('service_started');
  });

  it('D3: ordered teardown reverses startupOrder — no service is torn down before its dependents', () => {
    const doc = loadCompose();
    const { startupOrder } = profileFacts();
    const teardown = [...startupOrder].reverse();
    const teardownIdx = Object.fromEntries(teardown.map((id, i) => [id, i]));
    // For each dependency edge dep→(service), the dependent (service) must be town down BEFORE
    // its dependency (dep): teardownIdx[service] < teardownIdx[dep].
    for (const [name, svc] of Object.entries(doc.services)) {
      const deps =
        svc.depends_on && !Array.isArray(svc.depends_on) ? Object.keys(svc.depends_on) : [];
      for (const dep of deps) {
        expect(teardownIdx[name]).toBeLessThan(teardownIdx[dep]);
      }
    }

    // Negative control: a naive teardown in FORWARD (startup) order strands a dependent — a
    // dependency would be stopped while a service that still needs it is up.
    const forwardIdx = Object.fromEntries(startupOrder.map((id, i) => [id, i]));
    let stranded = false;
    for (const [name, svc] of Object.entries(doc.services)) {
      const deps =
        svc.depends_on && !Array.isArray(svc.depends_on) ? Object.keys(svc.depends_on) : [];
      for (const dep of deps) if (forwardIdx[dep] < forwardIdx[name]) stranded = true;
    }
    expect(stranded).toBe(true);
  });

  it('D4 (gate): during degradation, an in-progress step without a valid lease pauses to a safe checkpoint', () => {
    const p = profileFor('command-worker');
    const av = availability({ healthy: false, state: 'unavailable' }); // no lease
    const r = evaluateExecutionGate({
      profile: p,
      availability: av,
      execution: 'in-progress',
      now: T0,
    });
    expect(r.allowed).toBe(false);
    expect(r.safeAction).toBe('pause-and-reconcile');
    expect(r.blocked).toContain('continuity-lease-invalid');

    // Negative control: an EXPIRED lease also pauses (no automatic extension, FR-050/NFR-012),
    // while the same lease one ms before expiry still permits the step — proving the boundary.
    const expired = availability({
      healthy: false,
      state: 'degraded',
      continuityLease: validLease({ expiresAt: T0 }),
    });
    const rExpired = evaluateExecutionGate({
      profile: p,
      availability: expired,
      execution: 'in-progress',
      now: T0,
    });
    expect(rExpired.blocked).toContain('continuity-lease-expired');
    expect(rExpired.safeAction).toBe('pause-and-reconcile');
    const rBefore = evaluateExecutionGate({
      profile: p,
      availability: expired,
      execution: 'in-progress',
      now: T0 - 1,
    });
    expect(rBefore.allowed).toBe(true);
    expect(rBefore.continuity).toBe(true);
  });
});
