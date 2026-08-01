// TrustCircleAI — Phase 68 unit tests for the least-privilege RUNTIME METADATA scanner:
// `apps/discovery-agent/src/scanners/runtime.ts`.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item QBY0EVXEA2226PHHBADJ6H7X7P.
//
// Executable evidence that `RuntimeScanner` — the injected sensing substrate that enumerates the
// governance-relevant runtime entities (processes, services, containers, listening ports, manifests)
// living on a declared host boundary — satisfies acceptance criteria AC1–AC6 WITHOUT ever inspecting
// protected runtime content (environment, logs, command output, config/manifest bodies).
//
// The scanner is pure/deterministic: every sweep takes an injected read-only `RuntimeInventoryPort`
// (an in-memory fixture here) and an explicit `now` epoch — no wall-clock reads, no ambient host
// access. The durable-effect witness for a sweep is its reconciled report (`sources` + `gaps`), each
// item's metadata-only record, and the correlated `records` — NOT a mutating call's transient value.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a case where the rule must NOT fire,
// so a green run is not a permissive fake.
//
// AC → describe-block map:
//   AC1 a healthy discovered entity renders ONCE with its full facet set ........... describe('AC1 …')
//   AC2 a discovered-but-unmanaged/unreachable/excluded component stays a VISIBLE gap describe('AC2 …')
//   AC3 distinct correlated records per source (status differences + dependencies) .. describe('AC3 …')
//   AC4 a stale entity is marked w/ last-known time + confidence; health NOT inferred describe('AC4 …')
//   AC5 an unregistered entity ADDED to the view with the full discovery facets ..... describe('AC5 …')
//   AC6 an ungoverned discovered entity stays a VISIBLE governed-source gap w/ review describe('AC6 …')

import { describe, it, expect } from 'vitest';
import { isMetadataOnly } from '../../apps/discovery-agent/src/main.ts';
import {
  RuntimeScanner,
  RUNTIME_UNKNOWN_CLASSIFICATION,
  RT_GAP_REASONS,
  RT_SENSITIVITIES,
  RT_OWNERSHIP_STATUSES,
  RT_FRESHNESS,
  RT_LIFECYCLE_STATES,
  RT_RISK_LEVELS,
  RT_CONTROL_COVERAGE,
  RT_EVIDENCE_STATES,
  RT_HEALTH_STATES,
  RT_ISSUE_TAGS,
  DEFAULT_EXCLUDED_ENTITY_NAMES,
  type RuntimeInventoryPort,
  type RuntimeEntitySummary,
  type RuntimeEntityDetail,
  type RuntimeMarker,
  type RuntimeSource,
  type RuntimeGap,
} from '../../apps/discovery-agent/src/scanners/runtime.ts';

// ---------------------------------------------------------------------------
// An in-memory read-only RuntimeInventoryPort fixture. It exposes ONLY listEntities + inspect (no
// readEnv / readLogs / exec), so the scanner is structurally incapable of reading runtime content from
// it. An entity may be marked `denied` so its inspect rejects — exercising the fail-visible
// inaccessible gap. `deniedList` makes listEntities itself reject.
// ---------------------------------------------------------------------------
interface EntityNode {
  readonly summary: RuntimeEntitySummary;
  readonly detail?: RuntimeEntityDetail; // absent ⇒ inspect rejects (inaccessible)
  readonly denied?: boolean; // inspect rejects
}

function buildRuntime(
  nodes: readonly EntityNode[],
  opts?: { deniedList?: boolean },
): RuntimeInventoryPort {
  const byId = new Map(nodes.map((n) => [n.summary.entityId, n] as const));
  return {
    async listEntities() {
      if (opts?.deniedList) throw new Error('EACCES: runtime inventory denied');
      return nodes.map((n) => n.summary);
    },
    async inspect(entityId: string) {
      const node = byId.get(entityId);
      if (!node) throw new Error(`ENOENT: no such entity '${entityId}'`);
      if (node.denied || !node.detail) throw new Error(`EACCES: inspect denied '${entityId}'`);
      return node.detail;
    },
  };
}

const NOW = 1_700_000_000_000;
const HORIZON = 30 * 24 * 60 * 60 * 1000; // 30 days
const FRESH_HB = NOW - 1000; // well inside the horizon
const STALE_HB = NOW - 3 * HORIZON; // well outside the horizon

function marker(name: string, kind: RuntimeMarker['kind'], heartbeatMs?: number): RuntimeMarker {
  return heartbeatMs === undefined ? { name, kind } : { name, kind, heartbeatMs };
}

function entity(
  entityId: string,
  name: string,
  kind: RuntimeEntitySummary['kind'],
  detail?: Partial<RuntimeEntityDetail> & { denied?: boolean },
): EntityNode {
  const denied = detail?.denied ?? false;
  return {
    summary: { entityId, name, kind },
    denied,
    detail: denied
      ? undefined
      : {
          kind,
          markers: detail?.markers ?? [],
          listeningPorts: detail?.listeningPorts ?? [],
          heartbeatMs: detail?.heartbeatMs ?? FRESH_HB,
        },
  };
}

function scanner(runtime: RuntimeInventoryPort, over?: Partial<Parameters<typeof makeOpts>[0]>) {
  return new RuntimeScanner(makeOpts({ runtime, ...over }));
}
function makeOpts(o: {
  runtime: RuntimeInventoryPort;
  boundary?: string;
  now?: number;
  freshnessHorizonMs?: number;
  excludedEntityNames?: readonly string[];
}) {
  return {
    boundary: o.boundary ?? 'host-1',
    scope: 'runtime',
    runtime: o.runtime,
    now: o.now ?? NOW,
    freshnessHorizonMs: o.freshnessHorizonMs ?? HORIZON,
    excludedEntityNames: o.excludedEntityNames,
  } as const;
}

const bySource = (r: { sources: readonly RuntimeSource[] }, id: string) =>
  r.sources.find((s) => s.targetId === id);
const byGap = (r: { gaps: readonly RuntimeGap[] }, id: string) =>
  r.gaps.find((g) => g.targetId === id);

// Ownership marker that makes an entity OWNED (kept in one place so tests read clearly).
const OWNED = marker('owner-label', 'other');

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — a healthy discovered entity renders ONCE with its full facet set.
// ═══════════════════════════════════════════════════════════════════════════
describe('AC1 healthy runtime entity appears once with the full facet set', () => {
  // A well-formed governed service: runs the kanban workload, is OWNED, has a fresh heartbeat.
  const runtime = buildRuntime([
    entity('svc/kanban-1', 'kanban-board', 'service', {
      markers: [marker('kanban', 'service', FRESH_HB), OWNED],
      listeningPorts: [8080, 9090],
      heartbeatMs: FRESH_HB,
    }),
  ]);

  it('C1 renders the entity exactly once carrying ALL TEN inventory facets with authoritative values', async () => {
    const report = await scanner(runtime).scan();

    // Appears exactly ONCE (reconciled — no duplicate rows).
    const matches = report.sources.filter((s) => s.targetId === 'svc/kanban-1');
    expect(matches.length).toBe(1);
    const src = matches[0];

    // ── The AC1 required facet set: type, source identity, owner, lifecycle state, risk, control
    //    coverage, evidence state, health, last-observation time, unresolved issues. ──

    // facet 1 — TYPE
    expect(src.type).toBe('kanban');
    expect(src.classification).toBe('kanban'); // alias kept in sync
    // facet 2 — SOURCE IDENTITY
    expect(src.sourceIdentity).toBe('svc/kanban-1');
    expect(src.targetId).toBe('svc/kanban-1');
    expect(src.location).toBe('svc/kanban-1');
    // facet 3 — OWNER (declared via a runtime owner-label marker; owner is a reference, not its value)
    expect(src.ownership).toBe('owned');
    expect(src.owner).toBe('declared-by:owner-label');
    // facet 4 — LIFECYCLE STATE (fresh + reachable ⇒ active)
    expect(src.lifecycleState).toBe('active');
    expect(RT_LIFECYCLE_STATES).toContain(src.lifecycleState);
    // facet 5 — RISK (owned + fresh + normal ⇒ low)
    expect(src.risk).toBe('low');
    expect(RT_RISK_LEVELS).toContain(src.risk);
    // facet 6 — CONTROL COVERAGE (owned AND supported type ⇒ covered)
    expect(src.controlCoverage).toBe('covered');
    expect(RT_CONTROL_COVERAGE).toContain(src.controlCoverage);
    // facet 7 — EVIDENCE STATE (fresh markers inspected ⇒ attested)
    expect(src.evidenceState).toBe('attested');
    expect(RT_EVIDENCE_STATES).toContain(src.evidenceState);
    // facet 8 — HEALTH (fresh + owned + normal ⇒ healthy; also assertable + full confidence)
    expect(src.health).toBe('healthy');
    expect(RT_HEALTH_STATES).toContain(src.health);
    expect(src.confidence).toBe(1);
    expect(src.healthAssertable).toBe(true);
    // facet 9 — LAST OBSERVATION TIME
    expect(src.observedAt).toBe(NOW);
    expect(src.lastKnownAt).toBe(FRESH_HB);
    // facet 10 — UNRESOLVED ISSUES (a clean source has an empty, closed-vocabulary list)
    expect(Array.isArray(src.unresolvedIssues)).toBe(true);
    expect(src.unresolvedIssues).toEqual([]);
    for (const t of src.unresolvedIssues) expect(RT_ISSUE_TAGS).toContain(t);

    // Supporting facets carried alongside the ten.
    expect(src.access).toBe('reachable');
    expect(src.sensitivity).toBe('normal');
    expect(src.onboarding).toBe('discovered');
    expect(src.freshness).toBe('fresh');
    // Listening ports are METADATA (numbers) captured as discovery evidence.
    expect(src.listeningPorts).toEqual([8080, 9090]);

    // The durable metadata record is metadata-only (defensive post-condition holds).
    expect(isMetadataOnly(src.metadata)).toBe(true);

    // NEGATIVE control (non-vacuity): a healthy owned fresh entity is NOT a gap.
    expect(byGap(report, 'svc/kanban-1')).toBeUndefined();
    expect(report.gaps.some((g) => g.targetId === 'svc/kanban-1')).toBe(false);
  });

  it('C1b facets SHIFT with the source condition (non-vacuous facets)', async () => {
    // A recognized-but-UNOWNED, STALE entity: the facet values must move away from the clean case.
    const degraded = buildRuntime([
      entity('svc/legacy', 'workflow-engine', 'service', {
        markers: [marker('workflows_orchestration', 'service', STALE_HB)], // no owner-label ⇒ unowned
        heartbeatMs: STALE_HB,
      }),
    ]);
    const report = await scanner(degraded).scan();
    // Unowned+stale means it is surfaced as a gap, not a healthy source.
    expect(bySource(report, 'svc/legacy')).toBeUndefined();
    const gap = byGap(report, 'svc/legacy');
    expect(gap).toBeDefined();
    expect(['unowned', 'stale']).toContain(gap!.reason);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — a discovered-but-unmanaged / unreachable / excluded component stays a VISIBLE coverage gap.
// ═══════════════════════════════════════════════════════════════════════════
describe('AC2 non-healthy components remain visible coverage gaps with reason/age/impact/owner-action', () => {
  const runtime = buildRuntime([
    // healthy control
    entity('svc/ok', 'agentctl', 'service', {
      markers: [marker('agentctl', 'service', FRESH_HB), OWNED],
      heartbeatMs: FRESH_HB,
    }),
    // inaccessible: inspecting this entity is denied
    entity('svc/locked', 'locked-svc', 'service', { denied: true }),
    // excluded: a systemd entity (default exclusion) still surfaced as a gap
    entity('proc/systemd', 'systemd', 'process', {
      markers: [marker('agentctl', 'service', FRESH_HB)],
      heartbeatMs: FRESH_HB,
    }),
  ]);

  it('C2 an inaccessible and an excluded component both remain visible gaps with reason, age, impact, owner action, review anchor', async () => {
    const report = await scanner(runtime).scan();

    // Inaccessible → visible gap (never a silent skip).
    const locked = byGap(report, 'svc/locked');
    expect(locked).toBeDefined();
    expect(locked!.reason).toBe('inaccessible');
    expect(locked!.impact).toBe('high');
    expect(locked!.ownerAction.length).toBeGreaterThan(0); // required owner action
    expect(typeof locked!.ageMs).toBe('number'); // age
    expect(locked!.ageMs).toBeGreaterThanOrEqual(0);
    expect(locked!.observedAt).toBe(NOW);
    expect(locked!.reviewBy).toBe(NOW + 7 * 24 * 60 * 60 * 1000); // review/expiry anchor
    expect(isMetadataOnly(locked!.metadata)).toBe(true);
    // Inaccessible ⇒ no confident "live" claim.
    expect(locked!.confidence).toBe(0);
    expect(locked!.lastKnownAt).toBeNull();

    // Excluded entity → visible gap (intentional exclusion stays visible, not dropped).
    const excluded = byGap(report, 'proc/systemd');
    expect(excluded).toBeDefined();
    expect(excluded!.reason).toBe('excluded');
    expect(excluded!.impact).toBe('low');
    expect(excluded!.ownerAction.length).toBeGreaterThan(0);
    // The excluded entity was NOT inspected (it appears as neither a source nor any other gap kind).
    expect(bySource(report, 'proc/systemd')).toBeUndefined();

    // NEGATIVE control: the healthy control is a SOURCE, not a gap (discrimination → non-vacuous).
    expect(bySource(report, 'svc/ok')).toBeDefined();
    expect(byGap(report, 'svc/ok')).toBeUndefined();

    // Every gap reason produced is a member of the declared reason vocabulary.
    for (const g of report.gaps) expect(RT_GAP_REASONS).toContain(g.reason);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — the NAMED source systems (Kanban, agentctl, workflows_orchestration) show DISTINCT,
// CORRELATED records with authoritative fields, STATUS DIFFERENCES, and DEPENDENCY edges.
// ═══════════════════════════════════════════════════════════════════════════
describe('AC3 distinct correlated records across Kanban/agentctl/workflows_orchestration with status differences and dependencies', () => {
  // ONE governed entity ("platform") that hosts all three named source systems. Each named system
  // produces a SEPARATE authoritative record under one correlated entity. The markers carry DIFFERENT
  // heartbeats so their per-record STATUS genuinely differs: kanban is fresh (`current`), while
  // agentctl and the workflow engine are past the horizon (`stale`) — a real status difference across
  // records of the same source, not a uniform rollup.
  const runtime = buildRuntime([
    entity('svc/platform', 'platform', 'service', {
      markers: [
        marker('kanban', 'service', FRESH_HB), // kanban — the board agentctl drives (fresh)
        marker('agentctl', 'service', STALE_HB), // agentctl — depends on kanban (STALE)
        marker('workflows_orchestration', 'service', STALE_HB), // depends on agentctl + kanban (STALE)
        OWNED, // ownership so the correlated source stays a healthy SOURCE (records live on sources)
      ],
      // The entity heartbeat is fresh (its most-recent live signal), so the source rollup is fresh.
      heartbeatMs: FRESH_HB,
    }),
  ]);

  it('C3 the three named source systems appear as distinct correlated records with status differences and dependency edges', async () => {
    const report = await scanner(runtime).scan();
    const source = bySource(report, 'svc/platform');
    expect(source).toBeDefined();

    const byMarker = new Map(source!.records.map((r) => [r.marker, r]));

    // ── DISTINCT records: each named source system is its OWN record, never collapsed. ──
    expect(byMarker.has('kanban')).toBe(true);
    expect(byMarker.has('agentctl')).toBe(true);
    expect(byMarker.has('workflows_orchestration')).toBe(true);
    expect(source!.records.length).toBe(3);

    // ── Authoritative fields: each record carries the NAMED classification. ──
    expect(byMarker.get('kanban')!.classification).toBe('kanban');
    expect(byMarker.get('agentctl')!.classification).toBe('agentctl');
    expect(byMarker.get('workflows_orchestration')!.classification).toBe('workflows_orchestration');
    const namedClasses = new Set(source!.records.map((r) => r.classification));
    expect(namedClasses).toEqual(new Set(['kanban', 'agentctl', 'workflows_orchestration']));

    // ── CORRELATION: all records share ONE correlationId tying them to the single governed entity. ──
    const correlationIds = new Set(source!.records.map((r) => r.correlationId));
    expect(correlationIds.size).toBe(1);
    expect([...correlationIds][0]).toBe('svc/platform');

    // ── STATUS DIFFERENCES: records under the SAME source differ — the fresh marker is `current`,
    //    horizon-exceeded markers are `stale`. This is a genuine per-record difference. ──
    expect(byMarker.get('kanban')!.status).toBe('current');
    expect(byMarker.get('agentctl')!.status).toBe('stale');
    expect(byMarker.get('workflows_orchestration')!.status).toBe('stale');
    const statuses = new Set(source!.records.map((r) => r.status));
    expect(statuses).toEqual(new Set(['current', 'stale'])); // both present ⇒ a real difference

    // ── DEPENDENCIES: correlated dependency edges across the named systems (by classification). ──
    //   workflows_orchestration depends on agentctl and kanban.
    expect(byMarker.get('workflows_orchestration')!.dependsOn).toEqual(
      expect.arrayContaining(['agentctl', 'kanban']),
    );
    //   agentctl depends on kanban.
    expect(byMarker.get('agentctl')!.dependsOn).toEqual(['kanban']);
    //   kanban is the root board — it depends on nothing here.
    expect(byMarker.get('kanban')!.dependsOn).toEqual([]);

    // Authoritative per-record heartbeats are genuinely distinct.
    const hbs = new Set(source!.records.map((r) => r.heartbeatMs));
    expect(hbs.size).toBeGreaterThanOrEqual(2);

    // ── NEGATIVE control (non-vacuity #1): a single-marker source has exactly ONE record with NO
    //    dependency edges and a uniform status. ──
    const single = buildRuntime([
      entity('svc/solo', 'solo', 'service', {
        markers: [marker('kanban', 'service', FRESH_HB), OWNED],
        heartbeatMs: FRESH_HB,
      }),
    ]);
    const soloReport = await scanner(single).scan();
    const solo = bySource(soloReport, 'svc/solo')!;
    expect(solo.records.map((r) => r.marker)).toEqual(['kanban']);
    expect(solo.records[0].dependsOn).toEqual([]); // no siblings ⇒ no edges
    expect(new Set(solo.records.map((r) => r.status))).toEqual(new Set(['current'])); // uniform

    // ── NEGATIVE control (non-vacuity #2): when kanban is ABSENT, agentctl's dependency on kanban does
    //    NOT appear — the edges track the actual present classifications, not a hardcoded list. ──
    const noKanban = buildRuntime([
      entity('svc/p2', 'p2', 'service', {
        markers: [marker('agentctl', 'service', FRESH_HB), OWNED],
        heartbeatMs: FRESH_HB,
      }),
    ]);
    const rep2 = await scanner(noKanban).scan();
    const p2 = bySource(rep2, 'svc/p2')!;
    const agentctlRec = p2.records.find((r) => r.marker === 'agentctl')!;
    expect(agentctlRec.dependsOn).toEqual([]); // kanban absent ⇒ no kanban edge
    expect(agentctlRec.dependsOn).not.toContain('kanban');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — a stale entity is marked with last-known time + confidence; health NOT inferred from it.
// ═══════════════════════════════════════════════════════════════════════════
describe('AC4 stale entity marked with last-known time + confidence; health not inferred', () => {
  const runtime = buildRuntime([
    // fresh control
    entity('svc/live', 'live', 'service', {
      markers: [marker('kanban', 'service', FRESH_HB), OWNED],
      heartbeatMs: FRESH_HB,
    }),
    // stale: every marker's heartbeat (and the entity heartbeat) is far older than the horizon
    entity('svc/stale', 'stale', 'service', {
      markers: [marker('kanban', 'service', STALE_HB), OWNED],
      heartbeatMs: STALE_HB,
    }),
  ]);

  it('C4 the stale entity is a stale gap carrying its last-known heartbeat and reduced confidence; health is not asserted', async () => {
    const report = await scanner(runtime).scan();

    // The stale entity is surfaced as a stale gap (not silently kept as healthy).
    const stale = byGap(report, 'svc/stale');
    expect(stale).toBeDefined();
    expect(stale!.reason).toBe('stale');
    // Last-known observation time is preserved (the stalest heartbeat) — confidence anchor.
    expect(stale!.lastKnownAt).toBe(STALE_HB);
    expect(stale!.ageMs).toBeGreaterThan(HORIZON); // genuinely aged past the horizon
    expect(stale!.observedAt).toBe(NOW);
    // Confidence is reduced (below full) but not zero, per the decay model.
    expect(stale!.confidence).toBeLessThan(1);
    expect(stale!.confidence).toBeGreaterThanOrEqual(0.1);
    expect(isMetadataOnly(stale!.metadata)).toBe(true);

    // Health is NOT inferred healthy from stale data — the stale target never appears as a source.
    expect(bySource(report, 'svc/stale')).toBeUndefined();

    // NEGATIVE control: the fresh source IS a healthy source with full confidence + assertable health.
    const live = bySource(report, 'svc/live');
    expect(live).toBeDefined();
    expect(live!.freshness).toBe('fresh');
    expect(live!.confidence).toBe(1);
    expect(live!.healthAssertable).toBe(true);
    expect(live!.health).toBe('healthy');
    // The vocab of freshness states is closed.
    for (const s of report.sources) expect(RT_FRESHNESS).toContain(s.freshness);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — an UNREGISTERED entity of unknown type is ADDED to the view with the full discovery facets.
// ═══════════════════════════════════════════════════════════════════════════
describe('AC5 unregistered entity added with discovery evidence, classification, location, access, sensitivity, ownership, onboarding', () => {
  // An entity that is NOT a recognized source type (no governed markers) but sits within the boundary.
  // It must be surfaced (not ignored) with an unknown classification and the full facet set.
  const runtime = buildRuntime([
    entity('proc/mystery', 'mystery-daemon', 'process', {
      markers: [], // no governed markers ⇒ unknown type
      listeningPorts: [4242],
      heartbeatMs: FRESH_HB,
    }),
  ]);

  it('C5 an unknown-type entity is surfaced as an unsupported governed-source gap with all discovery facets present', async () => {
    const report = await scanner(runtime).scan();

    // It is surfaced (added to the view), not silently ignored.
    const mystery = byGap(report, 'proc/mystery');
    expect(mystery).toBeDefined();
    // Classification is UNKNOWN (type could not be determined) — an authoritative facet, not dropped.
    expect(mystery!.reason).toBe('unsupported'); // discovered-but-unsupported
    // Discovery facets carried in the disclosure-safe detail + metadata record.
    expect(mystery!.detail).toContain(`class=${RUNTIME_UNKNOWN_CLASSIFICATION}`);
    expect(mystery!.detail).toContain('sensitivity=');
    expect(mystery!.detail).toContain('ownership=');
    expect(mystery!.location).toBe('proc/mystery'); // location
    expect(mystery!.metadata.reachable).toBe(true); // access status
    expect(mystery!.metadata.onboarding).toBe('gap'); // onboarding state
    expect(mystery!.metadata.registered).toBe(false); // unregistered
    expect(isMetadataOnly(mystery!.metadata)).toBe(true);

    // NEGATIVE control (non-vacuity): a recognized, owned, fresh entity is a SOURCE, not an unsupported
    // gap — so the unknown-classification path is discriminating, not a blanket outcome.
    const recognized = buildRuntime([
      entity('svc/known', 'known', 'service', {
        markers: [marker('kanban', 'service', FRESH_HB), OWNED],
        heartbeatMs: FRESH_HB,
      }),
    ]);
    const rep2 = await scanner(recognized).scan();
    const known = bySource(rep2, 'svc/known');
    expect(known).toBeDefined();
    expect(known!.classification).toBe('kanban');
    expect(known!.onboarding).toBe('discovered');
    // The full facet vocabularies are closed.
    expect(RT_SENSITIVITIES).toContain(known!.sensitivity);
    expect(RT_OWNERSHIP_STATUSES).toContain(known!.ownership);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — an ungoverned discovered source stays a VISIBLE governed-source gap with reason/impact/action/review.
// ═══════════════════════════════════════════════════════════════════════════
describe('AC6 ungoverned discovered sources remain visible governed-source gaps with review/expiry', () => {
  // Distinct un-governable reasons, plus a healthy control:
  //  - sensitive:    an entity running a vault/secrets workload (must not be auto-onboarded)
  //  - unowned:      a recognized fresh service with NO owner-label
  //  - excluded:     a systemd entity (default exclusion)
  //  - inaccessible: a denied entity
  const runtime = buildRuntime([
    // healthy control (owned, fresh, recognized)
    entity('svc/good', 'good', 'service', {
      markers: [marker('agentctl', 'service', FRESH_HB), OWNED],
      heartbeatMs: FRESH_HB,
    }),
    // sensitive (name signals a secrets/vault workload)
    entity('svc/vaultish', 'vault-sidecar', 'service', {
      markers: [marker('kanban', 'service', FRESH_HB), OWNED],
      heartbeatMs: FRESH_HB,
    }),
    // unowned (no owner-label)
    entity('svc/orphan', 'orphan', 'service', {
      markers: [marker('kanban', 'service', FRESH_HB)],
      heartbeatMs: FRESH_HB,
    }),
    // excluded
    entity('proc/systemd', 'systemd', 'process', {
      markers: [marker('kanban', 'service', FRESH_HB)],
      heartbeatMs: FRESH_HB,
    }),
    // inaccessible
    entity('svc/blocked', 'blocked', 'service', { denied: true }),
  ]);

  it('C6 each ungovernable source is a visible governed-source gap with reason, impact, owner action, and a review/expiry deadline', async () => {
    const report = await scanner(runtime).scan();

    const expectations: ReadonlyArray<[string, string]> = [
      ['svc/vaultish', 'sensitive'],
      ['svc/orphan', 'unowned'],
      ['proc/systemd', 'excluded'],
      ['svc/blocked', 'inaccessible'],
    ];
    for (const [id, reason] of expectations) {
      const g = byGap(report, id);
      expect(g, `expected a gap for ${id}`).toBeDefined();
      expect(g!.reason).toBe(reason); // reason
      expect(['low', 'medium', 'high', 'critical', 'unknown']).toContain(g!.impact); // impact
      expect(g!.ownerAction.length).toBeGreaterThan(0); // required owner action
      // Every governed-source gap carries a mandatory review-or-expiry deadline.
      expect(g!.reviewBy).not.toBeNull();
      expect(g!.reviewBy!).toBeGreaterThan(NOW);
      expect(isMetadataOnly(g!.metadata)).toBe(true);
      // Disclosure-safe: gap detail carries no un-redacted secret shape.
      expect(g!.detail).not.toMatch(/-----BEGIN|AKIA|xox[bap]-|ghp_/);
    }

    // The sensitive one is classified sensitive (not normal), and its impact is elevated.
    const vaultish = byGap(report, 'svc/vaultish')!;
    expect(['high', 'critical']).toContain(vaultish.impact);

    // NEGATIVE control (non-vacuity): the healthy control is a SOURCE — it is NOT a governed-source
    // gap, so the four gap classifications are discriminating.
    expect(bySource(report, 'svc/good')).toBeDefined();
    expect(byGap(report, 'svc/good')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Harness sanity — the fixture and default vocab are non-vacuous.
// ═══════════════════════════════════════════════════════════════════════════
describe('harness sanity', () => {
  it('S1 the injected RuntimeInventoryPort exposes no content-reading capability (least privilege by construction)', () => {
    const rt = buildRuntime([]);
    const surface = rt as unknown as Record<string, unknown>;
    expect('readEnv' in surface).toBe(false);
    expect('readLogs' in surface).toBe(false);
    expect('exec' in surface).toBe(false);
    expect('readManifestBody' in surface).toBe(false);
    expect(typeof rt.listEntities).toBe('function');
    expect(typeof rt.inspect).toBe('function');
  });

  it('S2 default exclusions include the well-known kernel/init entities', () => {
    expect(DEFAULT_EXCLUDED_ENTITY_NAMES).toContain('systemd');
    expect(DEFAULT_EXCLUDED_ENTITY_NAMES).toContain('kworker');
  });

  it('S3 the constructor rejects an invalid freshness horizon (guards deterministic inputs)', () => {
    const rt = buildRuntime([]);
    expect(() => scanner(rt, { freshnessHorizonMs: 0 })).toThrow();
  });

  it('S4 a denied listEntities becomes a single fail-visible boundary gap (never a silent empty sweep)', async () => {
    const rt = buildRuntime([], { deniedList: true });
    const report = await scanner(rt, { boundary: 'host-x' }).scan();
    expect(report.sources).toEqual([]);
    const boundaryGap = byGap(report, 'host-x');
    expect(boundaryGap).toBeDefined();
    expect(boundaryGap!.reason).toBe('inaccessible');
  });
});
