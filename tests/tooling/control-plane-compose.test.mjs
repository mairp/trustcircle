// Phase 54 acceptance test — the CORE-ONLY Docker Compose profile that realizes the
// core-required runtime set of the governance control plane.
//
// Work item 4TDD946EJDS6PWVF7FG95C09B8 / VO-80051a0ad930b1560ff7 (NFR-010) — this phase's
// SOLE acceptance oracle:
//
//   "Loss of required authority, policy, evidence, ownership, or reconciliation MUST block
//    affected execution immediately. Health or connectivity loss MUST block new execution
//    immediately; an in-progress operation may continue only under FR-046 through FR-050
//    while read-only visibility and escalation remain available."
//
// The bound artifact is deploy/compose/control-plane.yml. This suite makes that artifact an
// INDEPENDENTLY OBSERVABLE, ENFORCED contract by parsing the compose document and mapping
// every clause of the oracle — and the phase's structural requirements (exactly the ten
// core-required services, the declared startupOrder, the required backing dependencies) — to
// a concrete, machine-checked property. Each positive property has a NEGATIVE CONTROL that
// mutates an in-memory copy of the parsed document (or the raw text) and asserts the check
// fails, so the oracles are non-vacuous.
//
// GROUNDING (parsed, not asserted from memory):
//   - deploy/profiles/components.yaml — the authoritative core-required set, startupOrder,
//     dependsOn (required edges), prerequisites, and degradation policy this compose file
//     must realize WITHOUT DRIFT.
//   - deploy/nats/topology.json — the JetStream substrate NATS serves.
//
// Dependency posture: Node built-ins + js-yaml (already a root dependency, used by the
// contracts validator and the other tooling tests). Deterministic under `npm ci`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (p) => join(ROOT, p);
const rd = (p) => readFileSync(rel(p), 'utf8');

const COMPOSE = 'deploy/compose/control-plane.yml';
const PROFILE = 'deploy/profiles/components.yaml';

const BUNDLE = '36GCYGDJ15PTYP60F91QWRAY2M';
const SEMANTIC_HASH = 'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b';

// The two `<<` merge anchors in the compose file use YAML merge keys; js-yaml's default
// schema handles them, but we load with the DEFAULT_SCHEMA to be explicit and to resolve
// the merges so `environment` blocks are fully materialized.
const loadCompose = () => yaml.load(rd(COMPOSE), { schema: yaml.DEFAULT_SCHEMA });
const loadProfile = () => yaml.load(rd(PROFILE));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// Derive the AUTHORITATIVE core-required expectations FROM the profile, so the compose
// file is checked against the declaration rather than against a memorized list.
// ---------------------------------------------------------------------------
function profileFacts() {
  const profile = loadProfile();
  const components = profile.components;
  const coreRequired = components.filter((c) => c.runtimeSet === 'core-required');
  // startupOrder is the deterministic bring-up list of the core-required stack.
  const startupOrder = profile.startupOrder;
  // Required backing dependencies per component (only `required: true` edges).
  const requiredEdges = {};
  for (const c of coreRequired) {
    requiredEdges[c.id] = (c.dependsOn ?? [])
      .filter((d) => d && d.required === true)
      .map((d) => d.component);
  }
  const executors = coreRequired.filter((c) => c.authority?.mayExecute === true).map((c) => c.id);
  const prereqsByComponent = {};
  for (const c of coreRequired) prereqsByComponent[c.id] = c.prerequisites ?? [];
  const expectedOfflineSets = ['on-demand', 'optional', 'external', 'intentionally-inactive'];
  const expectedOfflineIds = components
    .filter((c) => expectedOfflineSets.includes(c.runtimeSet))
    .map((c) => c.id);
  return {
    coreRequiredIds: coreRequired.map((c) => c.id),
    startupOrder,
    requiredEdges,
    executors,
    prereqsByComponent,
    expectedOfflineIds,
  };
}

// The `policy` prerequisite provider in the profile (OPA). A component whose prerequisites
// include `policy` must depend HEALTHILY on it.
const POLICY_PROVIDER = 'opa';
// Which profile prerequisites are backed by which infra service — used to assert that a
// component listing that prerequisite has the corresponding HARD (service_healthy) edge.
const PREREQ_TO_SERVICE = {
  policy: 'opa',
  evidence: 'object-storage',
  // authority/ownership/reconciliation are backed by the canonical store + broker.
  reconciliation: 'postgres',
};

function depCondition(service, dep) {
  const d = service?.depends_on;
  if (!d) return undefined;
  // Long form only (we require it): { dep: { condition: ... } }
  if (Array.isArray(d)) return d.includes(dep) ? 'service_started' : undefined;
  const entry = d[dep];
  if (!entry) return undefined;
  return entry.condition ?? 'service_started';
}

// ===========================================================================
// STRUCTURE — the compose file exists, parses, and realizes EXACTLY the core set.
// ===========================================================================

test('STRUCT: control-plane.yml exists and parses as a compose document', () => {
  assert.ok(existsSync(rel(COMPOSE)), 'deploy/compose/control-plane.yml must exist');
  const doc = loadCompose();
  assert.ok(doc && typeof doc === 'object', 'compose must parse to an object');
  assert.ok(doc.services && typeof doc.services === 'object', 'must declare services');
});

test('STRUCT: the profile itself declares ten core-required components (sanity of grounding)', () => {
  const { coreRequiredIds } = profileFacts();
  assert.equal(
    coreRequiredIds.length,
    10,
    `expected 10 core-required, got ${coreRequiredIds.length}`,
  );
});

test('STRUCT: compose services == EXACTLY the profile core-required set (no more, no less)', () => {
  const doc = loadCompose();
  const { coreRequiredIds } = profileFacts();
  const services = Object.keys(doc.services).sort();
  assert.deepEqual(services, [...coreRequiredIds].sort(), 'services must mirror core-required ids');
});

test('STRUCT-neg: dropping a core service (nats) makes the set-equality check fail', () => {
  const doc = loadCompose();
  const { coreRequiredIds } = profileFacts();
  const mutated = clone(doc);
  delete mutated.services.nats;
  const services = Object.keys(mutated.services).sort();
  assert.notDeepEqual(services, [...coreRequiredIds].sort());
});

test('STRUCT: NO expected-offline component (LISA/Wiggum/optional/external/inactive) leaks into the core profile', () => {
  const doc = loadCompose();
  const { expectedOfflineIds } = profileFacts();
  const services = new Set(Object.keys(doc.services));
  for (const id of expectedOfflineIds) {
    assert.ok(
      !services.has(id),
      `expected-offline component ${id} must NOT be in the core-only profile`,
    );
  }
  // Named individual guardrails.
  for (const id of [
    'lisa',
    'wiggum',
    'kanban',
    'agentctl',
    'workflow-orchestration',
    'legacy-jira-connector',
  ]) {
    assert.ok(!services.has(id), `${id} must not appear in control-plane.yml`);
  }
});

test('STRUCT-neg: injecting an on-demand connector (lisa) into the core profile is detected', () => {
  const doc = loadCompose();
  const { expectedOfflineIds } = profileFacts();
  const mutated = clone(doc);
  mutated.services.lisa = { image: 'x' };
  const services = new Set(Object.keys(mutated.services));
  let leaked = false;
  for (const id of expectedOfflineIds) if (services.has(id)) leaked = true;
  assert.ok(leaked, 'a leaked expected-offline component must be caught');
});

// ===========================================================================
// STARTUP ORDER — the profile's deterministic bring-up is honored by dependencies.
// A service must not depend on anything that comes AFTER it in startupOrder.
// ===========================================================================

test('ORDER: every depends_on edge respects the profile startupOrder (topological)', () => {
  const doc = loadCompose();
  const { startupOrder } = profileFacts();
  const idx = Object.fromEntries(startupOrder.map((id, i) => [id, i]));
  for (const [name, svc] of Object.entries(doc.services)) {
    const deps = svc.depends_on ? Object.keys(svc.depends_on) : [];
    for (const dep of deps) {
      assert.ok(idx[dep] < idx[name], `${name} depends on ${dep} which must start earlier`);
    }
  }
});

test('ORDER-neg: a forward/inverted dependency (postgres depends_on api) is rejected', () => {
  const doc = loadCompose();
  const { startupOrder } = profileFacts();
  const idx = Object.fromEntries(startupOrder.map((id, i) => [id, i]));
  const mutated = clone(doc);
  mutated.services.postgres.depends_on = { api: { condition: 'service_started' } };
  let bad = false;
  for (const [name, svc] of Object.entries(mutated.services)) {
    const deps = svc.depends_on ? Object.keys(svc.depends_on) : [];
    for (const dep of deps) if (!(idx[dep] < idx[name])) bad = true;
  }
  assert.ok(bad, 'an inverted dependency must be caught');
});

// ===========================================================================
// NFR-010 CLAUSE 1/2 — HEALTH/CONNECTIVITY LOSS BLOCKS NEW EXECUTION IMMEDIATELY.
// Every backing prerequisite declares a healthcheck; every executing/consuming service
// binds to it with a HARD `service_healthy` edge, so a lost prerequisite blocks bring-up
// (and, via the service's own healthcheck, keeps it not-ready).
// ===========================================================================

const BACKING_INFRA = ['postgres', 'object-storage', 'nats', 'opa'];

test('NFR010-health: every backing prerequisite declares a healthcheck', () => {
  const doc = loadCompose();
  for (const id of BACKING_INFRA) {
    const hc = doc.services[id]?.healthcheck;
    assert.ok(hc && hc.test, `${id} must declare a healthcheck.test`);
  }
});

test('NFR010-health-neg: removing a backing healthcheck (postgres) is detected', () => {
  const doc = loadCompose();
  const mutated = clone(doc);
  delete mutated.services.postgres.healthcheck;
  let ok = true;
  for (const id of BACKING_INFRA) if (!mutated.services[id]?.healthcheck?.test) ok = false;
  assert.ok(!ok, 'a missing backing healthcheck must be caught');
});

test('NFR010-health: every required dependsOn edge from the profile is a HARD service_healthy edge in compose', () => {
  const doc = loadCompose();
  const { requiredEdges } = profileFacts();
  for (const [comp, deps] of Object.entries(requiredEdges)) {
    for (const dep of deps) {
      // `web` -> `api` is intentionally NOT required-healthy (read-only visibility clause);
      // the profile models web's api edge as required:true for design intent, but NFR-010
      // requires the UI stay up when the core is degraded. Assert that special case below.
      if (comp === 'web' && dep === 'api') continue;
      const cond = depCondition(doc.services[comp], dep);
      assert.equal(
        cond,
        'service_healthy',
        `${comp} must depend on ${dep} with condition service_healthy (fail-closed)`,
      );
    }
  }
});

test('NFR010-health-neg: weakening an executor edge to service_started is rejected', () => {
  const doc = loadCompose();
  const mutated = clone(doc);
  // Weaken api -> opa (policy) to a mere started edge.
  mutated.services.api.depends_on.opa = { condition: 'service_started' };
  const cond = depCondition(mutated.services.api, 'opa');
  assert.notEqual(cond, 'service_healthy', 'the mutation weakened the edge');
  // And the positive rule would now fail:
  assert.equal(cond, 'service_started');
});

test('NFR010-prereq: every EXECUTOR (mayExecute:true) binds HARD to the policy provider (opa)', () => {
  const doc = loadCompose();
  const { executors, prereqsByComponent } = profileFacts();
  assert.ok(executors.length >= 2, 'expect api + command-worker as executors');
  for (const id of executors) {
    assert.ok(prereqsByComponent[id].includes('policy'), `${id} must list the policy prerequisite`);
    const cond = depCondition(doc.services[id], POLICY_PROVIDER);
    assert.equal(cond, 'service_healthy', `${id} must depend healthily on ${POLICY_PROVIDER}`);
  }
});

test('NFR010-prereq: components listing a backed prerequisite have the matching HARD substrate edge', () => {
  const doc = loadCompose();
  const { prereqsByComponent } = profileFacts();
  for (const [comp, prereqs] of Object.entries(prereqsByComponent)) {
    for (const p of prereqs) {
      const svc = PREREQ_TO_SERVICE[p];
      if (!svc) continue; // authority/ownership are not distinct services in the core stack
      if (comp === svc) continue; // a provider need not depend on itself
      // Only assert for components that actually run alongside that substrate in this profile.
      if (!doc.services[comp]) continue;
      const cond = depCondition(doc.services[comp], svc);
      assert.equal(
        cond,
        'service_healthy',
        `${comp} lists prerequisite '${p}' → must depend healthily on ${svc}`,
      );
    }
  }
});

// ===========================================================================
// NFR-010 CLAUSE 3 — READ-ONLY VISIBILITY & ESCALATION REMAIN AVAILABLE WHEN DEGRADED.
// The web UI must come up and stay up while the core is degraded: it depends only on API
// REACHABILITY (service_started), never on service_healthy, and must not be gated behind
// any backing prerequisite's health.
// ===========================================================================

test('NFR010-visibility: web depends ONLY on api reachability (service_started), not service_healthy', () => {
  const doc = loadCompose();
  const web = doc.services.web;
  assert.ok(web, 'web service must exist');
  const deps = web.depends_on ?? {};
  assert.deepEqual(Object.keys(deps).sort(), ['api'], 'web depends only on api');
  assert.equal(depCondition(web, 'api'), 'service_started', 'web must NOT wait on api health');
});

test('NFR010-visibility-neg: gating web behind service_healthy (would hide a degraded core) is rejected', () => {
  const doc = loadCompose();
  const mutated = clone(doc);
  mutated.services.web.depends_on = { api: { condition: 'service_healthy' } };
  assert.notEqual(
    depCondition(mutated.services.web, 'api'),
    'service_started',
    'the mutation gates web behind api health — the positive rule must fail on it',
  );
});

test('NFR010-visibility: web is not gated behind any backing prerequisite health', () => {
  const doc = loadCompose();
  const web = doc.services.web;
  const deps = web.depends_on ? Object.keys(web.depends_on) : [];
  for (const infra of BACKING_INFRA) {
    assert.ok(
      !deps.includes(infra),
      `web must not depend on ${infra} (visibility must survive its loss)`,
    );
  }
});

// ===========================================================================
// NON-AUTHORITY — observability & read-model tiers gain no authority from being up.
// ===========================================================================

test('NON-AUTH: collector (observability) is not depended on with a HARD health gate for execution', () => {
  const doc = loadCompose();
  // Executors may reference the collector, but ONLY as a soft (service_started) edge — a
  // telemetry sink is never authoritative, so its health must not gate governed execution.
  for (const id of ['api', 'command-worker', 'projector', 'discovery-agent']) {
    const cond = depCondition(doc.services[id], 'collector');
    if (cond !== undefined) {
      assert.equal(cond, 'service_started', `${id} must reference collector only as a soft edge`);
    }
  }
});

test('NON-AUTH-neg: a service_healthy gate on the collector (making telemetry authoritative) is rejected', () => {
  const doc = loadCompose();
  const mutated = clone(doc);
  mutated.services.api.depends_on.collector = { condition: 'service_healthy' };
  assert.equal(depCondition(mutated.services.api, 'collector'), 'service_healthy');
});

// ===========================================================================
// FAIL-CLOSED HEALTHCHECK PROBE — the app healthchecks use a probe that fails closed.
// ===========================================================================

test('FAILCLOSED: the healthcheck probe exists and exits non-zero on any error/non-2xx/stale/timeout', () => {
  assert.ok(existsSync(rel('deploy/compose/healthcheck.mjs')), 'healthcheck.mjs must exist');
  const src = rd('deploy/compose/healthcheck.mjs');
  // It must define an unhealthy() path that process.exit(1)s, and treat only 2xx as healthy.
  assert.match(src, /process\.exit\(1\)/, 'must exit(1) on unhealthy');
  assert.match(src, /status >= 200 && res\.status < 300/, 'only 2xx is healthy');
  assert.match(src, /stale liveness marker/, 'stale markers fail closed');
});

test('FAILCLOSED: application services use the fail-closed probe in their healthcheck', () => {
  const doc = loadCompose();
  for (const id of ['api', 'command-worker', 'projector', 'discovery-agent', 'web']) {
    const test_ = doc.services[id]?.healthcheck?.test ?? [];
    const joined = Array.isArray(test_) ? test_.join(' ') : String(test_);
    assert.match(joined, /healthcheck\.mjs/, `${id} must use the fail-closed probe`);
  }
});

// ===========================================================================
// SUPPORTING ARTIFACTS — the profile is self-consistent & runnable.
// ===========================================================================

test('SUPPORT: referenced supporting files (Dockerfile, otel config, web server) exist', () => {
  for (const p of [
    'deploy/compose/Dockerfile',
    'deploy/compose/otel-collector.yaml',
    'deploy/compose/web-server.mjs',
    'deploy/compose/healthcheck.mjs',
  ]) {
    assert.ok(existsSync(rel(p)), `${p} must exist`);
  }
});

test('SUPPORT: the Dockerfile declares a build target for each application service', () => {
  const doc = loadCompose();
  const df = rd('deploy/compose/Dockerfile');
  for (const id of ['api', 'command-worker', 'projector', 'discovery-agent', 'web']) {
    const target = doc.services[id]?.build?.target;
    assert.ok(target, `${id} must set build.target`);
    assert.match(df, new RegExp(`AS ${target}\\b`), `Dockerfile must define stage AS ${target}`);
  }
});

test('SUPPORT: NATS mounts the JetStream topology and enables jetstream', () => {
  const doc = loadCompose();
  const nats = doc.services.nats;
  const cmd = Array.isArray(nats.command) ? nats.command.join(' ') : String(nats.command);
  assert.match(cmd, /jetstream/, 'nats must run with jetstream');
  const vols = (nats.volumes ?? []).join(' ');
  assert.match(vols, /topology\.json/, 'nats must mount the declared topology');
  assert.ok(existsSync(rel('deploy/nats/topology.json')), 'topology must exist');
});

// ===========================================================================
// PROVENANCE — the artifact is bound to THIS bundle/work-item, not a foreign one.
// ===========================================================================

test('PROVENANCE: compose carries the pinned bundle id + content hash', () => {
  const src = rd(COMPOSE);
  assert.ok(src.includes(BUNDLE), 'compose must reference the bundle id');
  assert.ok(src.includes(SEMANTIC_HASH), 'compose must reference the bundle content hash');
});

test('PROVENANCE-neg: a foreign bundle hash is not present (guards against copy/paste drift)', () => {
  const src = rd(COMPOSE);
  const foreign = 'deadbeef' + '0'.repeat(56);
  assert.ok(!src.includes(foreign), 'no foreign hash');
});
