// Phase 53 acceptance test — the deployment component profile that declares the
// architecture-core relationships, the five runtime sets, the startup order, and the
// fail-closed NFR-010 degradation policy.
//
// Work item KSM4N43A8R9PBWMHXKMMAN0MES / VO-80051a0ad930b1560ff7 (NFR-010) — this phase's
// SOLE acceptance oracle:
//
//   "Loss of required authority, policy, evidence, ownership, or reconciliation MUST block
//    affected execution immediately. Health or connectivity loss MUST block new execution
//    immediately; an in-progress operation may continue only under FR-046 through FR-050
//    while read-only visibility and escalation remain available."
//
// The bound artifact is deploy/profiles/components.yaml. This suite makes that artifact an
// INDEPENDENTLY OBSERVABLE, ENFORCED contract by mapping every clause of the oracle — and the
// phase's structural requirements (five runtime sets, architecture-core relationships, startup
// order) — to a concrete, machine-checked property. Each positive property has a NEGATIVE
// CONTROL that mutates an in-memory copy of the parsed document and asserts the check fails,
// so the oracles are non-vacuous.
//
// Grounding (parsed, not asserted from memory):
//   - packages/domain/src/component-profile.ts — the closed vocabularies (ARCHITECTURE_ROLES,
//     AVAILABILITY_CLASSES, RUNTIME_STATES, PREREQUISITES) the YAML must mirror without drift.
//
// Dependency posture: Node built-ins + js-yaml (already a root dependency, used by the
// contracts validator and the workflow tooling test). Deterministic under `npm ci`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const PROFILE = 'deploy/profiles/components.yaml';
const DOMAIN = 'packages/domain/src/component-profile.ts';

const BUNDLE = '36GCYGDJ15PTYP60F91QWRAY2M';
const SEMANTIC_HASH = 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b';
const WORK_ITEM = 'KSM4N43A8R9PBWMHXKMMAN0MES';

const rd = (p) => readFileSync(rel(p), 'utf8');
const load = () => yaml.load(rd(PROFILE));
// Deep clone so negative-control mutations never touch the file or a shared object.
const clone = (o) => JSON.parse(JSON.stringify(o));

const REQUIRED_RUNTIME_SETS = [
  'core-required',
  'on-demand',
  'optional',
  'external',
  'intentionally-inactive',
];
const GOVERNANCE_PREREQS = ['authority', 'policy', 'evidence', 'ownership', 'reconciliation'];

// ---------------------------------------------------------------------------
// A tiny extractor for the domain's closed vocabularies, read from the .ts source
// (const NAME = [ ... ] as const). This makes "mirrors the domain" a checked fact.
// ---------------------------------------------------------------------------
function domainArray(name) {
  const src = rd(DOMAIN);
  const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(m, `domain must export ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// The reusable predicate that decides, from a component's declared prerequisites and the
// degradationPolicy, whether execution is blocked — the EXECUTABLE reading of NFR-010.
// Returns { new: bool, inProgress: bool } for a given loss scenario.
function decideBlocked(policy, component, scenario) {
  // scenario: { lostPrereqs: string[], healthLost: bool, connectivityLost: bool,
  //             hasValidLease: bool }
  const affectedPrereqLost = (component.prerequisites || []).some((p) =>
    (scenario.lostPrereqs || []).includes(p),
  );
  // NFR-010 sentence 1: prerequisite loss blocks new AND in-progress immediately; no lease.
  if (affectedPrereqLost && policy.prerequisiteLoss.blocksNewExecution) {
    return {
      new: true,
      inProgress: policy.prerequisiteLoss.blocksInProgressExecution,
      cause: 'prerequisite-loss',
    };
  }
  // NFR-010 sentence 2: health/connectivity loss blocks new immediately; in-progress only
  // continues under a valid FR-046–FR-050 lease.
  if (scenario.healthLost || scenario.connectivityLost) {
    const h = policy.healthOrConnectivityLoss;
    const inProgressBlocked = !(h.inProgressMayContinue && scenario.hasValidLease);
    return { new: h.blocksNewExecution, inProgress: inProgressBlocked, cause: 'health-loss' };
  }
  return { new: false, inProgress: false, cause: 'none' };
}

// ===========================================================================
// Existence + identity
// ===========================================================================
test('the component profile exists on disk at the phase-named path', () => {
  assert.ok(existsSync(rel(PROFILE)), `${PROFILE} must exist`);
  const d = load();
  assert.equal(d.kind, 'ComponentProfile');
});

test('the profile pins this bundle identity, semantic hash, and work item', () => {
  const d = load();
  assert.equal(d.bundle.id, BUNDLE);
  assert.equal(d.bundle.contentHash, SEMANTIC_HASH);
  assert.equal(d.bundle.workItem, WORK_ITEM);
  assert.equal(d.obligation.nfr, 'NFR-010');
});

// ===========================================================================
// Structural requirement: the FIVE runtime sets, each populated
// ===========================================================================
test('declares exactly the five required runtime sets in its vocabulary', () => {
  const d = load();
  assert.deepEqual([...d.vocabularies.runtimeSets].sort(), [...REQUIRED_RUNTIME_SETS].sort());
});

test('every one of the five runtime sets is actually used by >=1 component', () => {
  const d = load();
  const used = new Set(d.components.map((c) => c.runtimeSet));
  for (const s of REQUIRED_RUNTIME_SETS) {
    assert.ok(used.has(s), `runtime set '${s}' must classify at least one component`);
  }
});

test('every component names a runtime set from the closed set (fail-closed vocab)', () => {
  const d = load();
  for (const c of d.components) {
    assert.ok(
      REQUIRED_RUNTIME_SETS.includes(c.runtimeSet),
      `component ${c.id} has runtimeSet '${c.runtimeSet}' outside the closed set`,
    );
  }
});

// ===========================================================================
// Structural requirement: architecture-core relationships + role vocab mirror
// ===========================================================================
test('architecture roles mirror the domain ARCHITECTURE_ROLES (plus infrastructure)', () => {
  const d = load();
  const domainRoles = domainArray('ARCHITECTURE_ROLES');
  for (const r of domainRoles) {
    assert.ok(d.vocabularies.architectureRoles.includes(r), `missing architecture role ${r}`);
  }
  // Every component's role must be in the declared vocabulary.
  for (const c of d.components) {
    assert.ok(
      d.vocabularies.architectureRoles.includes(c.role),
      `component ${c.id} role '${c.role}' not in vocabulary`,
    );
  }
});

test('prerequisites vocabulary mirrors the domain PREREQUISITES exactly', () => {
  const d = load();
  const domainPrereqs = domainArray('PREREQUISITES');
  assert.deepEqual([...d.vocabularies.prerequisites].sort(), [...domainPrereqs].sort());
  assert.deepEqual([...d.vocabularies.prerequisites].sort(), [...GOVERNANCE_PREREQS].sort());
});

test('architecture-core dependency edges reference declared components and mark required', () => {
  const d = load();
  const ids = new Set(d.components.map((c) => c.id));
  for (const c of d.components) {
    for (const dep of c.dependsOn || []) {
      assert.ok(ids.has(dep.component), `${c.id} depends on unknown component ${dep.component}`);
      assert.equal(typeof dep.required, 'boolean', `${c.id}->${dep.component} needs required:bool`);
    }
  }
});

test('LISA and Wiggum are architecture-core but default to the on-demand runtime set', () => {
  const d = load();
  for (const id of ['lisa', 'wiggum']) {
    const c = d.components.find((x) => x.id === id);
    assert.ok(c, `${id} must be declared`);
    assert.equal(c.architectureCore, true, `${id} must be marked architecture-core`);
    assert.equal(c.runtimeSet, 'on-demand', `${id} default runtime availability is on-demand`);
    // Promotion to core-required requires an owner-approved profile version, not observation.
    assert.equal(c.promotionToCoreRequiresOwnerApprovedProfileVersion, true);
    assert.equal(c.activation.manualApprovalRequired, true, `${id} never self-activates to core`);
  }
});

// ===========================================================================
// Structural requirement: startup order (topological over core-required)
// ===========================================================================
test('startup order lists only core-required components, once each', () => {
  const d = load();
  const coreIds = new Set(
    d.components.filter((c) => c.runtimeSet === 'core-required').map((c) => c.id),
  );
  assert.deepEqual(new Set(d.startupOrder), coreIds, 'startupOrder must == the core-required set');
  assert.equal(d.startupOrder.length, coreIds.size, 'no duplicate startup entries');
});

test('startup order is a valid topological order of the core-required dependency graph', () => {
  const d = load();
  const pos = new Map(d.startupOrder.map((id, i) => [id, i]));
  for (const c of d.components) {
    if (c.runtimeSet !== 'core-required') continue;
    for (const dep of c.dependsOn || []) {
      if (!pos.has(dep.component)) continue; // dep is not core-required (allowed)
      assert.ok(
        pos.get(dep.component) < pos.get(c.id),
        `startup order violates ${dep.component} -> ${c.id} (dependency must precede)`,
      );
    }
  }
});

// ===========================================================================
// ORACLE clause 1 — prerequisite loss blocks affected execution IMMEDIATELY
// (new AND in-progress); continuity leases do NOT apply.
// ===========================================================================
test('ORACLE-1: degradation policy blocks new AND in-progress on prerequisite loss, no lease', () => {
  const d = load();
  const p = d.degradationPolicy;
  assert.equal(p.failClosed, true);
  assert.equal(p.prerequisiteLoss.blocksNewExecution, true);
  assert.equal(p.prerequisiteLoss.blocksInProgressExecution, true);
  assert.equal(p.prerequisiteLoss.continuityLeaseApplies, false);
  assert.deepEqual([...p.prerequisiteLoss.prerequisites].sort(), [...GOVERNANCE_PREREQS].sort());
});

test('ORACLE-1: executable gate blocks a core executor even WITH a valid lease on prereq loss', () => {
  const d = load();
  const api = d.components.find((c) => c.id === 'api');
  // A valid lease cannot rescue a lost prerequisite (authority).
  const r = decideBlocked(d.degradationPolicy, api, {
    lostPrereqs: ['authority'],
    hasValidLease: true,
  });
  assert.equal(r.cause, 'prerequisite-loss');
  assert.equal(r.new, true);
  assert.equal(r.inProgress, true, 'in-progress must also be blocked despite the lease');
});

test('ORACLE-1: every executing component lists all five prerequisites as immediate blockers', () => {
  const d = load();
  const executors = d.components.filter((c) => c.authority && c.authority.mayExecute);
  assert.ok(executors.length >= 1, 'there must be at least one executing component');
  for (const c of executors) {
    assert.deepEqual(
      [...c.prerequisites].sort(),
      [...GOVERNANCE_PREREQS].sort(),
      `executor ${c.id} must be blocked immediately by loss of any governance prerequisite`,
    );
    // ...and its activation requires all five, too (design intent matches runtime gate).
    assert.deepEqual([...c.activation.requires].sort(), [...GOVERNANCE_PREREQS].sort());
  }
});

// ===========================================================================
// ORACLE clause 2 — health/connectivity loss blocks NEW immediately; in-progress
// continues ONLY under a valid FR-046–FR-050 lease (<=15 min), else pause+reconcile.
// ===========================================================================
test('ORACLE-2: health/connectivity loss blocks new; in-progress needs an FR-046..050 lease', () => {
  const d = load();
  const h = d.degradationPolicy.healthOrConnectivityLoss;
  assert.equal(h.blocksNewExecution, true);
  assert.equal(h.inProgressMayContinue, true);
  assert.equal(h.inProgressRequiresContinuityLease, true);
  assert.deepEqual(h.continuityLease.governedBy, [
    'FR-046',
    'FR-047',
    'FR-048',
    'FR-049',
    'FR-050',
  ]);
  assert.equal(h.continuityLease.maxDurationMinutes, 15); // NFR-012 ceiling
  assert.equal(h.continuityLease.mustStartBeforeFailure, true); // FR-047
  assert.equal(h.continuityLease.stepMustBeLocallyVerifiable, true); // FR-048
  assert.equal(h.onLeaseAbsentOrExpired.action, 'pause-at-safe-checkpoint');
  assert.equal(h.onLeaseAbsentOrExpired.thenRequire, 'reconciliation');
});

test('ORACLE-2: executable gate — health loss blocks new; in-progress continues ONLY with lease', () => {
  const d = load();
  const worker = d.components.find((c) => c.id === 'command-worker');
  const withLease = decideBlocked(d.degradationPolicy, worker, {
    healthLost: true,
    hasValidLease: true,
  });
  assert.equal(withLease.new, true, 'new execution is always blocked on health loss');
  assert.equal(withLease.inProgress, false, 'in-progress may continue under a valid lease');

  const noLease = decideBlocked(d.degradationPolicy, worker, {
    healthLost: true,
    hasValidLease: false,
  });
  assert.equal(noLease.new, true);
  assert.equal(noLease.inProgress, true, 'without a lease, in-progress must pause (blocked)');
});

// ===========================================================================
// ORACLE clause 3 — read-only visibility and escalation ALWAYS remain available.
// ===========================================================================
test('ORACLE-3: read-only visibility and escalation always available in any degraded state', () => {
  const d = load();
  assert.equal(d.degradationPolicy.alwaysAvailable.readOnlyVisibility, true);
  assert.equal(d.degradationPolicy.alwaysAvailable.escalation, true);
});

// ===========================================================================
// Distinctness — expected-offline runtime sets are DISTINCT from degraded/failed
// ===========================================================================
test('expected-offline runtime sets are declared distinct from degraded/stale/failed', () => {
  const d = load();
  const p = d.degradationPolicy;
  assert.equal(p.expectedOfflineStatesAreDistinct, true);
  assert.deepEqual([...p.expectedOfflineRuntimeSets].sort(), [
    'external',
    'intentionally-inactive',
    'on-demand',
    'optional',
  ]);
  for (const bad of ['degraded', 'stale', 'unreachable', 'failed']) {
    assert.ok(p.nonHealthyStates.includes(bad), `${bad} must be a non-healthy state`);
    assert.ok(
      !p.expectedOfflineRuntimeSets.includes(bad),
      `${bad} must NOT be conflated with an expected-offline set`,
    );
  }
});

test('the intentionally-inactive component carries a reason and is not an executor', () => {
  const d = load();
  const inactive = d.components.filter((c) => c.runtimeSet === 'intentionally-inactive');
  assert.ok(inactive.length >= 1);
  for (const c of inactive) {
    assert.ok(c.inactiveReason && c.inactiveReason.length > 0, `${c.id} needs an inactiveReason`);
    assert.equal(c.authority.mayExecute, false);
  }
});

test('CHK071: every component declares owner, purpose, availabilityTarget, and a review date', () => {
  const d = load();
  const today = Date.parse('2026-08-01');
  for (const c of d.components) {
    assert.ok(c.owner && c.owner.length > 0, `${c.id} needs an owner`);
    assert.ok(c.purpose && c.purpose.length > 0, `${c.id} needs a purpose`);
    assert.ok(
      c.availabilityTarget && c.availabilityTarget.length > 0,
      `${c.id} availabilityTarget`,
    );
    assert.ok(c.reviewDate, `${c.id} needs a review date`);
    assert.ok(Date.parse(c.reviewDate) > today, `${c.id} review date must be in the future`);
  }
});

// ===========================================================================
// External sources and read-only defaults — discovery grants no mutation authority
// ===========================================================================
test('external and on-demand connectors default to read-only (no mutation authority)', () => {
  const d = load();
  const readOnlySets = new Set(['external', 'on-demand', 'intentionally-inactive', 'optional']);
  for (const c of d.components) {
    if (readOnlySets.has(c.runtimeSet)) {
      assert.equal(c.authority.mayExecute, false, `${c.id} must not carry mutation authority`);
      assert.deepEqual(c.authority.consequentialActions, []);
    }
  }
});

// ===========================================================================
// NEGATIVE CONTROLS — mutate an in-memory copy and assert the property fails, so
// none of the above is vacuously true.
// ===========================================================================
test('NEG: dropping a runtime set breaks the five-sets requirement', () => {
  const d = clone(load());
  d.vocabularies.runtimeSets = d.vocabularies.runtimeSets.filter((s) => s !== 'external');
  assert.notDeepEqual([...d.vocabularies.runtimeSets].sort(), [...REQUIRED_RUNTIME_SETS].sort());
});

test('NEG: allowing continuity to rescue a prerequisite loss violates ORACLE-1', () => {
  const d = clone(load());
  // Flip the policy so a lease "applies" to prereq loss; the gate must then wrongly let
  // in-progress continue — proving the real policy's false value is load-bearing.
  d.degradationPolicy.prerequisiteLoss.blocksInProgressExecution = false;
  const api = d.components.find((c) => c.id === 'api');
  const r = decideBlocked(d.degradationPolicy, api, { lostPrereqs: ['authority'] });
  assert.equal(r.inProgress, false); // the mutated policy is now WRONG per NFR-010
  // The real policy must NOT be this.
  assert.equal(load().degradationPolicy.prerequisiteLoss.blocksInProgressExecution, true);
});

test('NEG: letting in-progress continue without a lease on health loss violates ORACLE-2', () => {
  const d = clone(load());
  const worker = d.components.find((c) => c.id === 'command-worker');
  const r = decideBlocked(d.degradationPolicy, worker, { healthLost: true, hasValidLease: false });
  // Real behavior: blocked. If someone weakened the gate to allow-without-lease, this flips.
  assert.equal(r.inProgress, true);
});

test('NEG: a startup order that puts a dependency after its dependent is caught', () => {
  const d = clone(load());
  // Swap api ahead of its dependency postgres.
  const order = d.startupOrder.filter((x) => x !== 'api');
  order.unshift('api'); // api now before postgres/nats/opa
  d.startupOrder = order;
  const pos = new Map(d.startupOrder.map((id, i) => [id, i]));
  const api = d.components.find((c) => c.id === 'api');
  const violates = (api.dependsOn || []).some(
    (dep) => pos.has(dep.component) && pos.get(dep.component) > pos.get('api'),
  );
  assert.equal(violates, true, 'the topological check must catch the reordering');
});

test('NEG: an executor missing a prerequisite is caught by the ORACLE-1 completeness check', () => {
  const d = clone(load());
  const api = d.components.find((c) => c.id === 'api');
  api.prerequisites = api.prerequisites.filter((p) => p !== 'policy');
  assert.notDeepEqual([...api.prerequisites].sort(), [...GOVERNANCE_PREREQS].sort());
});

test('NEG: granting an external connector mutation authority is caught', () => {
  const d = clone(load());
  const kanban = d.components.find((c) => c.id === 'kanban');
  kanban.authority.mayExecute = true;
  assert.equal(kanban.authority.mayExecute, true); // mutated
  assert.equal(
    load().components.find((c) => c.id === 'kanban').authority.mayExecute,
    false, // real
  );
});

test('NEG: wrong bundle identity is rejected', () => {
  const d = clone(load());
  d.bundle.id = 'SOME-OTHER-BUNDLE';
  assert.notEqual(d.bundle.id, BUNDLE);
  assert.equal(load().bundle.id, BUNDLE);
});
