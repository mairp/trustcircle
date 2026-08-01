// Periodic & on-demand discovery SCHEDULING tests: scan budgets, source observations, and discovery
// evidence over the governed least-privilege sweep (Phase 74 / work item VG924JZDB48J1T6Q2EDCMR6G77).
//
// The phase acceptance oracle (6 criteria):
//   AC1 unified current-state view — each item appears ONCE with full attributes;
//   AC2 coverage gaps remain VISIBLE with reason/age/impact/owner-action;
//   AC3 cross-source drill-down (kanban, agentctl, workflows_orchestration) — distinct records,
//       correlation, and CONFLICTS surfaced;
//   AC4 stale/unavailable sources marked with last-known time + confidence — health NOT inferred
//       from stale data;
//   AC5 unregistered governance-relevant sources added to the catalog with discovery evidence /
//       classification / location / access / ownership / onboarding state;
//   AC6 discovered unsupported/inaccessible/sensitive/unowned/excluded sources remain visible as
//       governed source GAPS with reason / impact / owner action / review-expiry.
//
// Plus the scheduling obligations the phase names directly:
//   - PERIODIC discovery runs on a recurring cadence with no operator in the loop;
//   - ON-DEMAND discovery runs a sweep NOW;
//   - EXACTLY-ONE sweep in flight (a periodic tick + on-demand request never double-scan);
//   - SCAN BUDGETS bound the sweep (rate / duration / blast) and are fail-visible;
//   - DISCOVERY EVIDENCE is buffered/flushed to the durable sink (metadata only).
//
// Every governed property is asserted through an INDEPENDENT read path — the reconciled
// SourceCatalog, the durable evidence-sink capture, the durable checkpoint row, and the runner's
// own recorded run history / status snapshot — and each positive assertion is paired with a
// NEGATIVE control so the oracle is non-vacuous.
//
// Deterministic: a manual clock, in-memory lease/checkpoint stores, scripted sources/probes/
// authorizer. No wall clock, no real timers, no live infra.
//
// Run: npm run test:discovery
//      (node --experimental-strip-types --test tests/discovery/**/*.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = await import(join(ROOT, 'apps/discovery-agent/src/main.ts'));
const runner = await import(join(ROOT, 'apps/discovery-agent/src/discovery-runner.ts'));

const { GovernedDiscoveryAgent, AgentLease, EvidenceBuffer, SourceCatalog, isMetadataOnly } = main;

const {
  DiscoveryRunner,
  CompositeScanSource,
  RUN_TRIGGERS,
  SCHEDULE_STATES,
  COMPOSITE_ID_SEPARATOR,
  composeTargetId,
  splitCompositeTargetId,
  toUnifiedRow,
} = runner;

// ───────────────────────────────────────────────────────────────────────────
// Deterministic harness (mirrors discovery-main.test.mjs conventions)
// ───────────────────────────────────────────────────────────────────────────
function manualClock(start = 1_700_000_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => (t += ms);
  clock.set = (v) => (t = v);
  return clock;
}

function memoryLeaseStore() {
  const rows = new Map();
  return {
    rows,
    async read(resource) {
      return rows.get(resource) ?? null;
    },
    async write(lease) {
      rows.set(lease.resource, { ...lease });
    },
    async clear(resource, holder, fencingToken) {
      const cur = rows.get(resource);
      if (cur && cur.holder === holder && cur.fencingToken === fencingToken) {
        rows.set(resource, {
          resource,
          holder: null,
          fencingToken,
          expiresAt: null,
          updatedAt: cur.updatedAt,
        });
        return true;
      }
      return false;
    },
  };
}

function memoryCheckpointStore() {
  const saved = [];
  const latest = new Map();
  return {
    saved,
    latest,
    async load(resource) {
      return latest.get(resource) ?? null;
    },
    async save(cp) {
      saved.push(cp);
      latest.set(cp.resource, cp);
    },
  };
}

function capturingSink({ failTimes = 0 } = {}) {
  const flushed = [];
  let failsLeft = failTimes;
  const sink = async (records) => {
    if (failsLeft > 0) {
      failsLeft -= 1;
      throw new Error('sink unavailable');
    }
    for (const r of records) flushed.push(r);
  };
  return { flushed, sink };
}

const allowAll = {
  async authorize() {
    return { kind: 'authorized', reason: 'ok' };
  },
};

const BIG_BUDGET = Object.freeze({
  maxTargetsPerSweep: 1000,
  maxSweepDurationMs: 60_000,
  maxNewSourcesPerSweep: 1000,
});

// A scripted single-KIND source: enumerates a fixed target list and probes by a behavior map.
// `failListTimes` makes listTargets throw the first N times (used for the unavailable-source path).
function scriptedSource(sourceId, targets, { probeFor, failListTimes = 0 } = {}) {
  let failsLeft = failListTimes;
  const listCalls = { count: 0 };
  const source = {
    async listTargets() {
      listCalls.count += 1;
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new Error(`${sourceId} inventory unavailable`);
      }
      return targets;
    },
  };
  const probe = {
    async probe(target) {
      const b = probeFor ? probeFor(target) : null;
      return b ?? { reachable: true, classification: sourceId, evidence: { ok: true } };
    },
  };
  return { sourceId, source, probe, listCalls };
}

function t(id, over = {}) {
  return {
    targetId: id,
    scope: over.scope ?? 'kanban',
    location: over.location ?? `host://svc/${id}`,
    registered: over.registered ?? false,
  };
}

// Build a fully-wired, started agent + runner over a composite source.
async function buildStartedRunner(over = {}) {
  const clock = over.clock ?? manualClock();
  const leaseStore = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const sinkPair = over.sinkPair ?? capturingSink();
  const evidence = new EvidenceBuffer(sinkPair.sink);
  const catalog = new SourceCatalog();
  const lease = new AgentLease({
    store: leaseStore,
    resource: 'source-discovery',
    holder: 'agent-A',
    clock,
    ttlMs: 100_000,
  });
  const composite = new CompositeScanSource(over.sources, clock);
  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints,
    evidence,
    authorizer: over.authorizer ?? allowAll,
    targets: composite,
    probe: composite,
    catalog,
    grantedScopes: new Set(over.grantedScopes ?? ['kanban', 'agentctl', 'workflows_orchestration']),
    budgetLimits: over.budgetLimits ?? BIG_BUDGET,
    clock,
    sleep: async () => {},
    idleDelayMs: 1,
  });
  const started = await agent.start();
  assert.equal(started, true, 'agent should acquire the lease');
  const run = new DiscoveryRunner({
    agent,
    catalog,
    compositeSource: composite,
    clock,
    sleep: over.runnerSleep ?? (async () => {}),
    intervalMs: over.intervalMs ?? null,
  });
  return {
    clock,
    leaseStore,
    checkpoints,
    sinkPair,
    evidence,
    catalog,
    lease,
    composite,
    agent,
    run,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// P. Composite target-id namespacing (pure helpers, non-vacuous)
// ═══════════════════════════════════════════════════════════════════════════
test('P1 composeTargetId / splitCompositeTargetId round-trip and reject non-composite ids', () => {
  const composed = composeTargetId('kanban', 'board-7');
  assert.equal(composed, `kanban${COMPOSITE_ID_SEPARATOR}board-7`);
  assert.deepEqual(splitCompositeTargetId(composed), {
    sourceId: 'kanban',
    originTargetId: 'board-7',
  });
  // Negative control: a plain id is NOT a composite id.
  assert.equal(splitCompositeTargetId('board-7'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 + evidence + budget: an ON-DEMAND sweep discovers unregistered sources,
// records them in the reconciled catalog with full attributes, and writes
// METADATA-ONLY discovery evidence to the durable sink.
// ═══════════════════════════════════════════════════════════════════════════
test('AC5 on-demand sweep catalogs unregistered sources with full attributes + metadata-only evidence', async () => {
  const { run, catalog, sinkPair, checkpoints } = await buildStartedRunner({
    sources: [scriptedSource('kanban', [t('board-1'), t('board-2')])],
  });

  const record = await run.triggerOnDemand();

  // The run itself is observable and tagged as on-demand.
  assert.equal(record.trigger, 'on_demand');
  assert.equal(record.error, null);
  assert.equal(record.sweep.sourcesDiscovered, 2);

  // INDEPENDENT read path #1 — the reconciled catalog: each item ONCE, with full attributes.
  const sources = catalog.sources();
  assert.equal(sources.length, 2);
  for (const s of sources) {
    assert.equal(s.onboarding, 'discovered'); // unregistered => discovered
    assert.ok(s.location.startsWith('host://svc/'), 'location attribute present');
    assert.ok(s.detail.startsWith('classification='), 'classification attribute present');
    assert.equal(s.gapReason, null);
  }

  // INDEPENDENT read path #2 — the durable checkpoint: totals reflect the discovered sources.
  const cp = checkpoints.latest.get('source-discovery');
  assert.equal(cp.totals.sourcesDiscovered, 2);
  void sinkPair; // evidence-sink content is asserted in the metadata-only test below.

  // Negative control: a target that was NEVER offered is absent from the catalog.
  assert.equal(catalog.get(composeTargetId('kanban', 'board-404')), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 evidence is provably metadata-only through the durable sink read path.
// ═══════════════════════════════════════════════════════════════════════════
test('AC5 discovery evidence flushed to the durable sink is METADATA-ONLY (no content/secret rides along)', async () => {
  const { run, evidence, sinkPair } = await buildStartedRunner({
    sources: [
      scriptedSource('kanban', [t('board-1')], {
        // A probe whose evidence body is a content dump AND whose classification is secret-shaped.
        probeFor: () => ({
          reachable: true,
          classification: 'AKIA0123456789ABCDEF',
          evidence: { rows: [{ secret: 'password=hunter2' }], body: 'x'.repeat(5000) },
        }),
      }),
    ],
  });

  await run.triggerOnDemand();

  // Flush the buffered discovery evidence to the durable sink (independent read path).
  const ok = await evidence.flush();
  assert.equal(ok, true);
  const source = sinkPair.flushed.find((r) => r.kind === 'source_discovered');
  assert.ok(source, 'a source_discovered evidence record was flushed');

  // The persisted payload is the metadata-only envelope: it passes the structural predicate, the
  // content body is NOT present (only a shape tag), and the secret-shaped classification is redacted.
  assert.equal(isMetadataOnly(source.payload), true);
  const serialized = JSON.stringify(source.payload);
  assert.equal(serialized.includes('hunter2'), false, 'no secret value persisted');
  assert.equal(serialized.includes('xxxxx'), false, 'no content body persisted');
  assert.ok('evidenceShape' in source.payload, 'evidence reduced to a shape tag');

  // Negative control: the RAW probe evidence (which DOES contain the secret) is never the payload.
  assert.notEqual(serialized.includes('AKIA0123456789ABCDEF'), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1 + AC3: the unified current-state view has each item ONCE, decorated with
// its origin source, so cross-source drill-down works and re-observation does
// not duplicate rows.
// ═══════════════════════════════════════════════════════════════════════════
test('AC1/AC3 unified view: each item once + cross-source drill-down + no duplicate on re-observation', async () => {
  const { run } = await buildStartedRunner({
    sources: [
      scriptedSource('kanban', [t('board-1', { scope: 'kanban' })]),
      scriptedSource('agentctl', [t('agent-9', { scope: 'agentctl' })]),
      scriptedSource('workflows_orchestration', [t('wf-3', { scope: 'workflows_orchestration' })]),
    ],
  });

  await run.triggerOnDemand();
  const afterFirst = run.status();
  assert.equal(afterFirst.unified.length, 3, 'three distinct records across three sources');

  // Drill-down: each row carries its origin source id and un-namespaced origin id.
  const bySource = new Map(afterFirst.unified.map((r) => [r.sourceId, r]));
  assert.equal(bySource.get('kanban').originTargetId, 'board-1');
  assert.equal(bySource.get('agentctl').originTargetId, 'agent-9');
  assert.equal(bySource.get('workflows_orchestration').originTargetId, 'wf-3');

  // Re-observe (a second on-demand sweep) — the catalog reconciles: still exactly 3 rows, no dupes.
  await run.triggerOnDemand();
  const afterSecond = run.status();
  assert.equal(afterSecond.unified.length, 3, 'reconciliation: re-observation updates in place');
  assert.equal(afterSecond.catalogCounts.total, 3);

  // Negative control: the same origin id under DIFFERENT sources is NOT collapsed — a cross-source
  // CONFLICT stays as two distinct, correlated rows.
  const dup = await buildStartedRunner({
    sources: [
      scriptedSource('kanban', [t('shared-entity', { scope: 'kanban' })]),
      scriptedSource('agentctl', [t('shared-entity', { scope: 'agentctl' })]),
    ],
  });
  await dup.run.triggerOnDemand();
  const dupRows = dup.run.status().unified;
  assert.equal(dupRows.length, 2, 'same origin id in two sources => two distinct records');
  assert.deepEqual(
    dupRows.map((r) => r.sourceId).sort(),
    ['agentctl', 'kanban'],
    'both source origins preserved (conflict is visible, not silently merged)',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 + AC6: coverage gaps stay VISIBLE with a disclosure-safe reason — a target
// outside the grant set (unsupported/excluded) and an unreachable probe
// (inaccessible) both remain governed gap rows.
// ═══════════════════════════════════════════════════════════════════════════
test('AC2/AC6 gaps remain visible with reason: out_of_scope + probe_failed both stay as governed gap rows', async () => {
  const { run } = await buildStartedRunner({
    grantedScopes: ['kanban'], // agentctl is NOT granted => out_of_scope gap
    sources: [
      scriptedSource('kanban', [t('board-ok'), t('board-broken')], {
        probeFor: (target) =>
          target.targetId === 'board-broken'
            ? { reachable: false, classification: 'unknown', evidence: null } // inaccessible
            : null,
      }),
      scriptedSource('agentctl', [t('agent-x', { scope: 'agentctl' })]), // out_of_scope
    ],
  });

  await run.triggerOnDemand();
  const st = run.status();

  // The gaps subset is non-empty and every gap carries a disclosure-safe reason.
  const reasons = new Map(
    st.gaps.map((g) => [splitCompositeTargetId(g.targetId).originTargetId, g.gapReason]),
  );
  assert.equal(
    reasons.get('board-broken'),
    'probe_failed',
    'unreachable => visible probe_failed gap',
  );
  assert.equal(
    reasons.get('agent-x'),
    'out_of_scope',
    'ungranted scope => visible out_of_scope gap',
  );
  for (const g of st.gaps) {
    assert.equal(g.onboarding, 'gap');
    assert.ok(g.gapReason, 'gap carries a reason');
    assert.ok(g.detail, 'gap carries disclosure-safe detail (owner-action context)');
  }

  // Gaps live in the SAME unified view as sources (they cannot silently vanish).
  const unifiedIds = new Set(st.unified.map((r) => r.targetId));
  assert.ok(unifiedIds.has(composeTargetId('kanban', 'board-broken')));
  assert.ok(unifiedIds.has(composeTargetId('agentctl', 'agent-x')));

  // Negative control: the healthy source is NOT a gap.
  const ok = st.unified.find((r) => r.originTargetId === 'board-ok');
  assert.equal(ok.onboarding, 'discovered');
  assert.equal(ok.gapReason, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4: a source whose inventory is UNAVAILABLE is marked with its last-known
// good time + a confidence marker; health is NOT inferred from stale data.
// ═══════════════════════════════════════════════════════════════════════════
test('AC4 unavailable source is marked stale with last-known time + confidence (health not inferred from stale data)', async () => {
  const flaky = scriptedSource('runtime', [t('svc-1', { scope: 'kanban' })], { failListTimes: 0 });
  const { run, clock } = await buildStartedRunner({
    sources: [scriptedSource('kanban', [t('board-1')]), flaky],
  });

  // First sweep: both sources available. runtime's last-success time is recorded.
  await run.triggerOnDemand();
  const firstObs = run.status().sources.find((s) => s.sourceId === 'runtime');
  assert.equal(firstObs.available, true);
  assert.equal(firstObs.confidence, 'fresh');
  const knownGoodAt = firstObs.lastSuccessAt;
  assert.equal(typeof knownGoodAt, 'number');

  // Now make the runtime inventory fail on the NEXT enumeration.
  flaky.source.listTargets = async () => {
    throw new Error('runtime inventory unavailable');
  };
  clock.advance(5_000);

  await run.triggerOnDemand();
  const staleObs = run.status().sources.find((s) => s.sourceId === 'runtime');

  // Fail-visible: unavailable, confidence downgraded to stale, last-known time PRESERVED (not now).
  assert.equal(staleObs.available, false, 'source marked unavailable, not healthy');
  assert.equal(staleObs.confidence, 'stale', 'confidence downgraded — not inferred healthy');
  assert.equal(staleObs.lastSuccessAt, knownGoodAt, 'last-known good time preserved');
  assert.ok(staleObs.observedAt > knownGoodAt, 'observedAt advances past last-known-good');
  assert.ok(staleObs.detail, 'disclosure-safe failure detail present');

  // Negative control: the healthy kanban source is NOT downgraded.
  const kanbanObs = run.status().sources.find((s) => s.sourceId === 'kanban');
  assert.equal(kanbanObs.available, true);
  assert.equal(kanbanObs.confidence, 'fresh');

  // A source that NEVER succeeded reports 'unknown' confidence (distinct from 'stale').
  const neverBuilt = await buildStartedRunner({
    sources: [scriptedSource('never', [t('x')], { failListTimes: 5 })],
  });
  await neverBuilt.run.triggerOnDemand();
  const neverObs = neverBuilt.run.status().sources.find((s) => s.sourceId === 'never');
  assert.equal(neverObs.confidence, 'unknown');
  assert.equal(neverObs.lastSuccessAt, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCAN BUDGET: the blast-radius budget bounds NEW-source onboarding per sweep;
// the excess is a visible budget_blast gap and the schedule status shows the
// exhausted axis is fail-visible on the run record.
// ═══════════════════════════════════════════════════════════════════════════
test('BUDGET blast-radius bounds new-source onboarding; excess is a visible budget gap (fail-visible)', async () => {
  const { run } = await buildStartedRunner({
    budgetLimits: {
      maxTargetsPerSweep: 1000,
      maxSweepDurationMs: 60_000,
      maxNewSourcesPerSweep: 1,
    },
    sources: [
      scriptedSource('kanban', [t('a'), t('b'), t('c')]), // 3 new; budget allows 1
    ],
  });

  const rec = await run.triggerOnDemand();

  // Exactly one new source onboarded; the rest are visible budget_blast gaps.
  assert.equal(rec.sweep.sourcesDiscovered, 1);
  assert.equal(rec.sweep.stoppedByBudget, 'blast');
  const gaps = run.status().gaps.filter((g) => g.gapReason === 'budget_blast');
  assert.equal(gaps.length, 2, 'over-budget new sources remain visible as budget gaps');

  // Negative control: with an ample blast budget, all three onboard and there is no budget gap.
  const ample = await buildStartedRunner({
    budgetLimits: BIG_BUDGET,
    sources: [scriptedSource('kanban', [t('a'), t('b'), t('c')])],
  });
  const rec2 = await ample.run.triggerOnDemand();
  assert.equal(rec2.sweep.sourcesDiscovered, 3);
  assert.equal(rec2.sweep.stoppedByBudget, null);
  assert.equal(ample.run.status().gaps.filter((g) => g.gapReason === 'budget_blast').length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULING: PERIODIC discovery runs on a recurring cadence with no operator
// in the loop; the first run is 'initial', later ticks are 'periodic'.
// ═══════════════════════════════════════════════════════════════════════════
test('SCHEDULE periodic loop runs a recurring cadence (initial then periodic) until stop', async () => {
  const clock = manualClock();
  let sleeps = 0;
  const built = await buildStartedRunner({
    clock,
    intervalMs: 1000,
    sources: [scriptedSource('kanban', [t('board-1')])],
    // A sleeper that advances the clock and stops the loop after enough ticks.
    runnerSleep: async (ms) => {
      sleeps += 1;
      clock.advance(ms);
      if (sleeps >= 3) built.run.requestStop();
    },
  });

  await built.run.start();

  const triggers = built.run.runs().map((r) => r.trigger);
  assert.equal(triggers[0], 'initial', 'first run is initial');
  assert.ok(
    triggers.slice(1).every((x) => x === 'periodic'),
    'subsequent runs are periodic',
  );
  assert.ok(built.run.totalRuns >= 3, 'the cadence produced multiple runs without an operator');
  assert.equal(built.run.state, 'stopped', 'clean stop');

  // Negative control: start() on an on-demand-only runner (no interval) refuses.
  const odOnly = await buildStartedRunner({ sources: [scriptedSource('kanban', [t('x')])] });
  await assert.rejects(() => odOnly.run.start(), /requires a positive intervalMs/);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULING: EXACTLY-ONE sweep in flight — an on-demand request that races a
// running sweep JOINS it rather than starting a second concurrent governed sweep.
// ═══════════════════════════════════════════════════════════════════════════
test('SCHEDULE exactly-one-in-flight: concurrent on-demand triggers coalesce into a single sweep', async () => {
  // A source whose listTargets blocks on a gate so we can hold a sweep "in flight".
  let release;
  const gate = new Promise((r) => (release = r));
  const gated = scriptedSource('kanban', [t('board-1')]);
  const origList = gated.source.listTargets.bind(gated.source);
  let listCount = 0;
  gated.source.listTargets = async () => {
    listCount += 1;
    await gate; // hold the sweep in flight
    return origList();
  };

  const { run } = await buildStartedRunner({ sources: [gated] });

  const p1 = run.triggerOnDemand();
  const p2 = run.triggerOnDemand(); // arrives while p1 is in flight => must JOIN it
  assert.equal(run.status().sweepInFlight, true, 'a sweep is in flight');

  release();
  const [r1, r2] = await Promise.all([p1, p2]);

  // Same run record — one governed sweep, not two.
  assert.equal(r1.runNumber, r2.runNumber, 'both triggers observed the SAME run');
  assert.equal(run.totalRuns, 1, 'exactly one governed sweep executed');
  assert.equal(listCount, 1, 'the source was enumerated exactly once');
  assert.equal(run.status().sweepInFlight, false, 'no sweep in flight after completion');

  // Negative control: a SUBSEQUENT (non-racing) on-demand trigger is a NEW run.
  const r3 = await run.triggerOnDemand();
  assert.equal(r3.runNumber, r1.runNumber + 1, 'a later trigger is a distinct run');
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-VISIBLE: a sweep that THROWS is recorded on the run (error surfaced),
// never swallowed, and the schedule keeps going.
// ═══════════════════════════════════════════════════════════════════════════
test('FAIL-VISIBLE a throwing sweep is recorded with an error and the schedule survives', async () => {
  const { run, agent } = await buildStartedRunner({
    sources: [scriptedSource('kanban', [t('board-1')])],
  });

  // Force the underlying sweep to throw once.
  const origRunOnce = agent.runOnce.bind(agent);
  let calls = 0;
  agent.runOnce = async () => {
    calls += 1;
    if (calls === 1) throw new Error('sweep exploded');
    return origRunOnce();
  };

  const bad = await run.triggerOnDemand();
  assert.equal(bad.sweep, null, 'no sweep report when the sweep threw');
  assert.ok(bad.error, 'the error is recorded on the run (fail-visible)');
  assert.ok(bad.error.includes('sweep exploded'));

  // The schedule survives — a subsequent run succeeds.
  const good = await run.triggerOnDemand();
  assert.equal(good.error, null);
  assert.ok(good.sweep, 'the next run produced a real sweep report');

  // Negative control (non-vacuity): a run with no injected failure has a null error + a report.
  assert.equal(good.sweep.error ?? null, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// Vocab guards — the exported unions are exactly what the status/records use.
// ═══════════════════════════════════════════════════════════════════════════
test('VOCAB exported trigger/state unions are stable and used by the runner', () => {
  assert.deepEqual([...RUN_TRIGGERS], ['periodic', 'on_demand', 'initial']);
  assert.deepEqual([...SCHEDULE_STATES], ['idle', 'running', 'sweeping', 'stopped']);
  // toUnifiedRow decorates a plain catalog entry with a source axis.
  const row = toUnifiedRow({
    targetId: composeTargetId('kanban', 'b1'),
    scope: 'kanban',
    location: 'host://svc/b1',
    onboarding: 'discovered',
    gapReason: null,
    detail: 'classification=kanban',
    observedAt: 1,
  });
  assert.equal(row.sourceId, 'kanban');
  assert.equal(row.originTargetId, 'b1');
  // Negative control: a non-composite entry has a null source axis.
  const plain = toUnifiedRow({
    targetId: 'raw-id',
    scope: 'kanban',
    location: 'x',
    onboarding: 'gap',
    gapReason: 'out_of_scope',
    detail: 'd',
    observedAt: 1,
  });
  assert.equal(plain.sourceId, null);
  assert.equal(plain.originTargetId, 'raw-id');
});
