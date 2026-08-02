// Integration suite — Phase 73 inventory & discovery API routes
// (apps/api/src/routes/inventory.ts; work item N74N7VJTPB8TWW8MXM18WHBQQ4,
// bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// Every assertion drives the REAL `app.fetch()` entry point (a Fetch `Request` → `Response`) —
// the same path a live server uses — and reads the observable outcome from the RESPONSE BODY
// (an independent read of the projection), never a mutation echo. The projection is seeded once,
// deterministically (fixed ids + clock), from tests/fixtures/inventory.ts, which composes the REAL
// @trustcircle/application services over the REAL @trustcircle/domain value model. Each acceptance
// criterion is paired with a NEGATIVE CONTROL: an input that MUST flip the observable outcome, so
// the oracle is non-vacuous.
//
// Acceptance-criterion → observable-evidence map (all read from the wire response):
//   AC1  GET /v1/inventory/assets → the healthy asset appears ONCE with type/owner/lifecycle/
//        risk/coverage/health/last-observation, and page freshness='current', partial_coverage=false.
//   AC2  the orphaned component stays a VISIBLE row with coverage='gap' + health≠'healthy'; the page
//        marks partial_coverage=true and names the component gap id in metadata.coverage_gaps.
//   AC3  GET /v1/inventory/sources → the kanban + agentctl sources appear as DISTINCT entries with
//        DIFFERING authoritative access_state (correlation / status difference).
//   AC4  the stale/unavailable warehouse source's reported health_state is withheld (not 'healthy'),
//        and the page freshness downgrades to 'stale' — current health is never inferred.
//   AC5  POST /v1/inventory/discovery-runs → an AUDITED accepted-operation (operation+correlation+
//        audit ids); the discovered unknown-class source is catalogued with class/location/access/
//        ownership/onboarding facets and least-privilege (metadata-only) command forwarding.
//   AC6  the unsupported/inaccessible/excluded source stays a VISIBLE entry carrying its governed-
//        source gap ids in coverage_gap_ids, folded into metadata.coverage_gaps — never dropped.
//   PAGINATION  a limit=1 page returns exactly one item + a next_cursor; following the cursor
//        returns the next item and never repeats — a stable, gap-free window.

import { describe, it, expect } from 'vitest';

import { createApp, type AppOptions } from '../../apps/api/src/server.ts';
import { registerInventoryRoutes } from '../../apps/api/src/routes/inventory.ts';
import type { VerifiedIdentity } from '../../apps/api/src/middleware/context.ts';

import {
  seedTenantProjection,
  providerFor,
  recordingDiscoveryPort,
  TENANT,
  OTHER_TENANT,
  HEALTHY_ASSET_ID,
  GAP_ASSET_ID,
  DISCOVERY_EVIDENCE,
} from '../fixtures/inventory.ts';

// --- Harness -----------------------------------------------------------------

const T0 = 1_772_000_000_000;

/** A verifier that authenticates a governance officer scoped to the given tenant. */
function officer(tenantId: string): () => VerifiedIdentity {
  return () => ({
    principalId: '018f0000-0000-7000-8000-0000000000d0',
    tenantId,
    roles: ['governance_officer'],
    isBrowserSession: false,
  });
}

function baseOptions(over: Partial<AppOptions> = {}): AppOptions {
  return {
    verifyIdentity: officer(String(TENANT)),
    // The route does not use readiness; supply a trivially-healthy provider.
    readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
    now: () => T0,
    ...over,
  };
}

interface Harness {
  fetch: (req: Request) => Promise<Response>;
  discoveryCommands: () => ReturnType<typeof recordingDiscoveryPort>['commands'];
  seeded: ReturnType<typeof seedTenantProjection>;
}

function makeApp(over: Partial<AppOptions> = {}): Harness {
  const seeded = seedTenantProjection();
  const rec = recordingDiscoveryPort();
  const { app } = createApp(baseOptions(over));
  registerInventoryRoutes(app, { projections: providerFor(seeded), discovery: rec.port });
  return { fetch: (req) => app.fetch(req), discoveryCommands: () => rec.commands, seeded };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://internal${path}`, { method: 'GET', headers });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
/** A permissive wire-object shape: property access yields `unknown`, which `expect()` accepts —
 *  so the suite stays `any`-free while still reading arbitrary response fields. */
type Rec = Record<string, unknown>;
interface WirePage {
  items: Rec[];
  metadata: Rec;
}
async function json(res: Response): Promise<WirePage> {
  return (await res.json()) as WirePage;
}

// ============================================================================
// AC1 — healthy connected sources render once with the full facet set.
// ============================================================================

describe('AC1 · current-state governed-asset view (GET /v1/inventory/assets)', () => {
  it('a healthy asset appears ONCE carrying type/owner/lifecycle/risk/coverage/health/last-observation', async () => {
    const app = makeApp();
    const res = await app.fetch(get('/v1/inventory/assets'));
    expect(res.status).toBe(200);
    const body = await json(res);

    const healthy = body.items.find((i: Rec) => i.id === String(HEALTHY_ASSET_ID));
    expect(healthy).toBeTruthy();
    // Appears exactly once.
    expect(body.items.filter((i: Rec) => i.id === String(HEALTHY_ASSET_ID)).length).toBe(1);
    // Every enumerated AC1 facet is a NAMED field.
    expect(healthy.asset_type).toBe('service');
    expect(healthy.owner_principal_id).toBeTruthy();
    expect(healthy.lifecycle_state).toBe('operating');
    expect(healthy.risk_tier).toBe('moderate');
    expect(healthy.coverage).toBe('covered');
    expect(healthy.health).toBe('healthy'); // reported health IS healthy — evidence is current.
    expect(typeof healthy.last_observed_at).toBe('string');
    expect(healthy.tenant_id).toBe(String(TENANT));
    expect(Number.isInteger(healthy.version)).toBe(true);
    // AC1 evidence-state + unresolved-issues facets are NAMED wire fields (never a status blob).
    expect(healthy.evidence_state).toBe('current');
    expect(healthy.unresolved_issues).toBe(0);
    // AC4 confidence value accompanies the last-observation time — a current row is fully confident.
    expect(healthy.confidence).toBe(1);
  });

  it('each asset row carries the AC1 evidence-state + unresolved-issues facets, and the incomplete row differs from the current one', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/assets')));

    const healthy = body.items.find((i: Rec) => i.id === String(HEALTHY_ASSET_ID));
    const gap = body.items.find((i: Rec) => i.id === String(GAP_ASSET_ID));
    expect(healthy).toBeTruthy();
    expect(gap).toBeTruthy();

    // The orphaned/uncorrelated row's evidence is NOT current, and it names its open issue(s) — the
    // facet is data-driven, not a constant (the two rows disagree on all three facets).
    expect(gap.evidence_state).toBe('incomplete');
    expect(gap.unresolved_issues).toBeGreaterThanOrEqual(1);
    expect(gap.confidence).toBeLessThan(1);
    // Non-vacuity: the healthy row and the gap row carry DIFFERENT evidence_state + confidence.
    expect(gap.evidence_state).not.toBe(healthy.evidence_state);
    expect(gap.confidence).not.toBe(healthy.confidence);
  });

  it('AC1 FULL BUNDLE: a SINGLE rendered item carries ALL TEN required attributes together (type, source identity, owner, lifecycle, risk, control coverage, evidence state, health, last-observation time, unresolved issues)', async () => {
    // The critic's AC1 oracle: not ten attributes proven across ten tests, but ONE projected
    // inventory item that simultaneously carries the entire required attribute set. This reads a
    // single wire item and asserts every one of the ten SPEC attributes is present and correct on
    // THAT item, observed together in one projection read.
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/assets')));
    const item = body.items.find((i: Rec) => i.id === String(HEALTHY_ASSET_ID)) as Rec;
    expect(item).toBeTruthy();

    // The ten SPEC attributes, each a NAMED field on this ONE item:
    const bundle = {
      // 1. type
      asset_type: item.asset_type,
      // 2. source identity (the item's own governed identity: id + tenant, a stable handle)
      id: item.id,
      tenant_id: item.tenant_id,
      name: item.name,
      // 3. owner
      owner_principal_id: item.owner_principal_id,
      // 4. lifecycle state
      lifecycle_state: item.lifecycle_state,
      // 5. risk
      risk_tier: item.risk_tier,
      // 6. control coverage
      coverage: item.coverage,
      // 7. evidence state
      evidence_state: item.evidence_state,
      // 8. health
      health: item.health,
      // 9. last observation time
      last_observed_at: item.last_observed_at,
      // 10. unresolved issues
      unresolved_issues: item.unresolved_issues,
    };
    // EVERY attribute is present (none undefined) on this single item — the bundle is complete.
    for (const [key, value] of Object.entries(bundle)) {
      expect(
        value,
        `AC1 attribute '${key}' must be present on the single item`,
      ).not.toBeUndefined();
    }
    // …and each carries its correct, data-driven value (a healthy, owned, covered service):
    expect(bundle.asset_type).toBe('service');
    expect(bundle.id).toBe(String(HEALTHY_ASSET_ID));
    expect(bundle.tenant_id).toBe(String(TENANT));
    expect(bundle.name).toBe('orders-api');
    expect(bundle.owner_principal_id).toBeTruthy();
    expect(bundle.lifecycle_state).toBe('operating');
    expect(bundle.risk_tier).toBe('moderate');
    expect(bundle.coverage).toBe('covered');
    expect(bundle.evidence_state).toBe('current');
    expect(bundle.health).toBe('healthy');
    expect(typeof bundle.last_observed_at).toBe('string');
    expect(bundle.unresolved_issues).toBe(0);

    // Appears exactly ONCE (AC1 "each item appears once").
    expect(body.items.filter((i: Rec) => i.id === String(HEALTHY_ASSET_ID)).length).toBe(1);
  });

  it('NEGATIVE CONTROL: an unauthenticated request cannot read the inventory', async () => {
    const app = makeApp({ verifyIdentity: () => null });
    const res = await app.fetch(get('/v1/inventory/assets'));
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
  });
});

// ============================================================================
// AC2 — a discovered-but-unmanaged component stays a VISIBLE coverage gap.
// ============================================================================

describe('AC2 · orphaned component stays a visible coverage gap', () => {
  it('the gap asset is retained with coverage=gap + non-healthy, and the page marks partial coverage + names the gap id', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/assets')));

    const gap = body.items.find((i: Rec) => i.id === String(GAP_ASSET_ID));
    // Stays VISIBLE — not dropped.
    expect(gap).toBeTruthy();
    expect(gap.coverage).toBe('gap');
    expect(gap.health).not.toBe('healthy');
    // Unowned ownership gap is surfaced as an explicit null (not hidden).
    expect(gap.owner_principal_id).toBeNull();

    // Page-level coverage metadata reflects the visible component gap.
    expect(body.metadata.partial_coverage).toBe(true);
    expect(Array.isArray(body.metadata.coverage_gaps)).toBe(true);
    expect(body.metadata.coverage_gaps.length).toBeGreaterThan(0);
    // Every named gap id is a uuid.
    for (const g of body.metadata.coverage_gaps) {
      expect(g).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('the visible component gap is rendered with its FULL content: reason, age, impact, and required owner action', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/assets')));

    const gap = body.items.find((i: Rec) => i.id === String(GAP_ASSET_ID));
    expect(Array.isArray(gap.coverage_gaps)).toBe(true);
    expect(gap.coverage_gaps.length).toBeGreaterThan(0);

    const detail = gap.coverage_gaps[0];
    // AC2 requires the gap to carry — NOT merely a bare id — its reason, age, impact, owner action.
    expect(detail.gap_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(detail.gap_class).toBe('component');
    expect(detail.reason).toBe('orphaned');
    expect(detail.impact).toBe('high');
    expect(detail.required_action).toBe(
      'assign an owner and onboard the batch job under a control',
    );
    // Age is a concrete non-negative duration (firstSeen was 3h before `now` → 10_800_000 ms).
    expect(Number.isInteger(detail.age_millis)).toBe(true);
    expect(detail.age_millis).toBe(3 * 60 * 60_000);
  });

  it('AC2 FULL BUNDLE: the still-visible coverage gap carries reason + age + impact + required owner action TOGETHER on one detail', async () => {
    // The critic's AC2 oracle: a discovered/unmanaged/orphaned item that remains visible must
    // surface — on ONE gap detail, together — its reason, its age, its impact, and the required
    // OWNER ACTION. This reads that single detail and asserts all four (plus the required owner)
    // are present at once, then proves each is data-driven via a differing sibling.
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/assets')));
    const gap = body.items.find((i: Rec) => i.id === String(GAP_ASSET_ID)) as Rec;
    // The item stays VISIBLE (never dropped) even though it is orphaned/unmanaged.
    expect(gap).toBeTruthy();
    expect(gap.coverage).toBe('gap');
    expect(Array.isArray(gap.coverage_gaps)).toBe(true);
    const detail = (gap.coverage_gaps as Rec[])[0] as Rec;

    // All four required fields + the required owner action's owner, present TOGETHER on one detail:
    const bundle = {
      reason: detail.reason, // WHY it is a gap
      age_millis: detail.age_millis, // AGE
      impact: detail.impact, // IMPACT
      required_action: detail.required_action, // required OWNER ACTION
    };
    for (const [key, value] of Object.entries(bundle)) {
      expect(
        value,
        `AC2 attribute '${key}' must be present on the single gap detail`,
      ).not.toBeUndefined();
    }
    expect(bundle.reason).toBe('orphaned');
    expect(bundle.impact).toBe('high');
    expect(bundle.required_action).toBe(
      'assign an owner and onboard the batch job under a control',
    );
    // AGE is a concrete non-negative duration derived from firstSeen (3h before `now`).
    expect(Number.isInteger(bundle.age_millis)).toBe(true);
    expect(bundle.age_millis as number).toBe(3 * 60 * 60_000);
    // The owner action is directed at the missing owner: the item itself is unowned (explicit null).
    expect(gap.owner_principal_id).toBeNull();

    // NON-VACUITY: the healthy asset carries NO coverage_gaps detail — so the bundle above is a
    // real property of the gap item, not a constant on every row.
    const healthy = body.items.find((i: Rec) => i.id === String(HEALTHY_ASSET_ID)) as Rec;
    expect(
      healthy.coverage_gaps === undefined || (healthy.coverage_gaps as unknown[]).length === 0,
    ).toBe(true);
  });

  it('NEGATIVE CONTROL: filtering to only covered assets removes the gap AND clears partial coverage', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/assets?coverage_state=covered')));
    expect(body.items.some((i: Rec) => i.id === String(GAP_ASSET_ID))).toBe(false);
    // With no visible gap rows shown, the page is no longer partial.
    expect(body.metadata.partial_coverage).toBe(false);
  });
});

// ============================================================================
// AC3 — related work across sources: distinct records with status differences.
// ============================================================================

describe('AC3 · distinct source records correlate with differing status', () => {
  it('the kanban and agentctl sources are DISTINCT entries with differing access_state', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));

    const byClass = Object.fromEntries(body.items.map((i: Rec) => [i.source_class, i]));
    expect(byClass.kanban).toBeTruthy();
    expect(byClass.agentctl).toBeTruthy();
    // Distinct identities.
    expect(byClass.kanban.id).not.toBe(byClass.agentctl.id);
    // Differing authoritative status field (the correlation / status-difference surface).
    expect(byClass.kanban.access_state).toBe('connected');
    expect(byClass.agentctl.access_state).toBe('degraded');
    expect(byClass.kanban.access_state).not.toBe(byClass.agentctl.access_state);
  });

  it('the kanban source drill-down exposes CORRELATION (per-field status differences across its distinct records)', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));

    const kanban = body.items.find((i: Rec) => i.source_class === 'kanban');
    expect(Array.isArray(kanban.correlation)).toBe(true);
    // The three distinct records (kanban/agentctl/workflows_orchestration) disagree on `status` and
    // on `observedState.pipeline_state`.
    const fields = kanban.correlation.map((d: Rec) => d.field).sort();
    expect(fields).toContain('status');
    expect(fields).toContain('observedState.pipeline_state');

    const statusDiff = kanban.correlation.find((d: Rec) => d.field === 'status');
    // All three distinct values are named, each attributed to the record ids that reported it.
    const values = statusDiff.values.map((v: Rec) => v.value).sort();
    expect(values).toEqual(['active', 'conflicting', 'inactive']);
    for (const v of statusDiff.values) {
      expect(Array.isArray(v.record_ids)).toBe(true);
      expect(v.record_ids.length).toBeGreaterThan(0);
      for (const r of v.record_ids) expect(r).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('the kanban source drill-down exposes its DEPENDENCY edges (depends_on)', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));

    const kanban = body.items.find((i: Rec) => i.source_class === 'kanban');
    expect(Array.isArray(kanban.dependencies)).toBe(true);
    expect(kanban.dependencies.length).toBeGreaterThan(0);

    const dep = kanban.dependencies[0];
    expect(dep.relationship_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(dep.from_id).toBe(kanban.id);
    // The declared edge points at the agentctl source (the seeded dependency target).
    expect(dep.to_id).toBe(String(app.seeded.ids.agentctlSourceId));
    expect(dep.field_name).toBe('deployment_target');
  });

  it('AC3 FULL BUNDLE: one source drill-down surfaces distinct source records + correlation + status differences + dependencies + authoritative fields TOGETHER', async () => {
    // The critic's AC3 oracle: a drill-down across related work must show, together on ONE source
    // view: (a) DISTINCT source records, (b) their CORRELATION, (c) STATUS DIFFERENCES, (d)
    // DEPENDENCIES, and (e) AUTHORITATIVE FIELDS. This reads the single kanban catalog entry from
    // the wire and asserts every one of those five is present at once.
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    const kanban = body.items.find((i: Rec) => i.source_class === 'kanban') as Rec;
    const agentctl = body.items.find((i: Rec) => i.source_class === 'agentctl') as Rec;
    const workflows = body.items.find(
      (i: Rec) => i.source_class === 'workflows_orchestration',
    ) as Rec;
    expect(kanban).toBeTruthy();
    expect(agentctl).toBeTruthy();
    expect(workflows).toBeTruthy(); // AC3: the THIRD named source is catalogued on the wire.

    // (a) DISTINCT source records: the correlation surface is built from THREE distinct records
    //     (kanban + agentctl + workflows_orchestration) that each reported a value; their record
    //     ids are named and distinct.
    const correlation = kanban.correlation as Rec[];
    expect(Array.isArray(correlation)).toBe(true);
    expect(correlation.length).toBeGreaterThan(0);
    const allRecordIds = new Set<string>();
    for (const d of correlation) {
      for (const v of d.values as Rec[]) {
        for (const r of v.record_ids as string[]) allRecordIds.add(r);
      }
    }
    expect(allRecordIds.size).toBeGreaterThanOrEqual(3); // THREE distinct records

    // (b)+(c) CORRELATION / STATUS DIFFERENCES: the three records DISAGREE on named fields three
    //     ways, and each differing value is attributed to the record ids that reported it.
    const fields = correlation.map((d) => d.field).sort();
    expect(fields).toContain('status');
    expect(fields).toContain('observedState.pipeline_state');
    const statusDiff = correlation.find((d) => d.field === 'status') as Rec;
    const values = (statusDiff.values as Rec[]).map((v) => v.value).sort();
    expect(values).toEqual(['active', 'conflicting', 'inactive']); // a THREE-WAY status DIFFERENCE
    const pipelineDiff = correlation.find((d) => d.field === 'observedState.pipeline_state') as Rec;
    const pipelineValues = (pipelineDiff.values as Rec[]).map((v) => v.value).sort();
    expect(pipelineValues).toEqual(['failed', 'paused', 'running']);

    // (d) DEPENDENCIES: the declared depends_on edges to BOTH other named sources.
    const deps = kanban.dependencies as Rec[];
    expect(Array.isArray(deps)).toBe(true);
    expect(deps.length).toBe(2);
    expect(deps.every((d) => d.from_id === kanban.id)).toBe(true);
    const depTargets = deps.map((d) => d.to_id).sort();
    expect(depTargets).toEqual(
      [String(app.seeded.ids.agentctlSourceId), String(app.seeded.ids.workflowsSourceId)].sort(),
    );

    // (e) AUTHORITATIVE FIELDS: the three entries carry distinct identities and THREE DIFFERING
    //     authoritative statuses (access_state) — the field a human reconciles across the records.
    expect(new Set([kanban.id, agentctl.id, workflows.id]).size).toBe(3);
    expect(kanban.access_state).toBe('connected');
    expect(agentctl.access_state).toBe('degraded');
    expect(workflows.access_state).toBe('inaccessible');
    expect(new Set([kanban.access_state, agentctl.access_state, workflows.access_state]).size).toBe(
      3,
    );

    // All five AC3 surfaces present TOGETHER on this one drill-down view.
    const present = {
      distinct_records: allRecordIds.size >= 3,
      correlation: correlation.length > 0,
      status_differences: values.length >= 3,
      dependencies: deps.length >= 2,
      authoritative_field_difference:
        new Set([kanban.access_state, agentctl.access_state, workflows.access_state]).size === 3,
    };
    for (const [k, v] of Object.entries(present)) {
      expect(v, `AC3 surface '${k}' must be present on the drill-down`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: a source with no distinct-record disagreement exposes NO correlation entries (non-vacuity)', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    // The warehouse source has a single record → no status differences to render.
    const warehouse = body.items.find((i: Rec) => i.source_class === 'warehouse');
    expect(warehouse.correlation === undefined || warehouse.correlation.length === 0).toBe(true);
  });

  it('NEGATIVE CONTROL: every catalog entry carries its authoritative source_class (no anonymous rows)', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    for (const i of body.items) {
      expect(typeof i.source_class).toBe('string');
      expect(i.source_class.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// AC4 — a stale/unavailable source: marked with last-known time + freshness;
// current health is NOT inferred from stale data.
// ============================================================================

describe('AC4 · stale/unavailable source is marked, health not inferred', () => {
  it('the warehouse source withholds a healthy reported health, and the page freshness is stale', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));

    const warehouse = body.items.find((i: Rec) => i.source_class === 'warehouse');
    expect(warehouse).toBeTruthy();
    // last-known time is present (marked, not dropped).
    expect(typeof warehouse.last_seen_at).toBe('string');
    // Current health is NOT inferred — an unreachable source never reports 'healthy'.
    expect(warehouse.health_state).not.toBe('healthy');
    // The page-level freshness signals staleness (an unavailable source drags the page to stale).
    expect(body.metadata.freshness).toBe('stale');
    // A stale page is never asserted as fully current.
    expect(body.metadata.freshness).not.toBe('current');

    // AC4: a CONFIDENCE value accompanies the last-known time; a stale/unavailable source's
    // confidence is degraded below 1 (current currency is not inferred from stale data).
    expect(typeof warehouse.confidence).toBe('number');
    expect(warehouse.confidence).toBeLessThan(1);
    expect(warehouse.confidence).toBeGreaterThanOrEqual(0);
    // Its evidence-state facet reflects the stale knowledge, too.
    expect(warehouse.evidence_state).not.toBe('current');
  });

  it('AC4 FULL BUNDLE: the stale source is marked with last-known time AND confidence together, and its current health is NOT inferred from that stale data', async () => {
    // The critic's AC4 oracle: a stale/unavailable source must be marked with BOTH a last-known
    // time AND a confidence, on the SAME rendered item — and current compliance/health must NOT be
    // inferred from the stale data. This reads the single warehouse item and asserts both markers
    // are present together, then proves the (fresh) observed health was WITHHELD, not reported.
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    const stale = body.items.find((i: Rec) => i.source_class === 'warehouse') as Rec;
    expect(stale).toBeTruthy();

    // BOTH markers present TOGETHER on the one item:
    const bundle = {
      last_seen_at: stale.last_seen_at, // last-KNOWN time (marked, not dropped)
      confidence: stale.confidence, // CONFIDENCE in that stale knowledge
      evidence_state: stale.evidence_state, // the currency verdict
    };
    for (const [k, v] of Object.entries(bundle)) {
      expect(v, `AC4 marker '${k}' must be present on the stale item`).not.toBeUndefined();
    }
    expect(typeof bundle.last_seen_at).toBe('string'); // last-known time is a real timestamp
    expect(typeof bundle.confidence).toBe('number');
    expect(bundle.confidence as number).toBeLessThan(1); // degraded — not full confidence
    expect(bundle.confidence as number).toBeGreaterThanOrEqual(0);
    expect(bundle.evidence_state).not.toBe('current'); // knowledge is not current

    // CURRENT HEALTH IS NOT INFERRED FROM STALE DATA: the fixture seeded this unreachable source at
    // an OLD time; its reported health is WITHHELD (never inferred to 'healthy'), and the whole page
    // freshness is downgraded to 'stale' rather than asserted current.
    expect(stale.health_state).not.toBe('healthy');
    expect(body.metadata.freshness).toBe('stale');
    expect(body.metadata.freshness).not.toBe('current');
  });

  it('NEGATIVE CONTROL: a FRESH source carries full confidence (1), proving the degraded value above is data-driven', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    // The freshly-discovered unknown source was seen at `now` → confidence is exactly 1.
    const fresh = body.items.find((i: Rec) => i.source_class === 'unknown');
    expect(fresh.confidence).toBe(1);
    expect(fresh.confidence).not.toBe(
      body.items.find((i: Rec) => i.source_class === 'warehouse').confidence,
    );
  });

  it('NEGATIVE CONTROL: the healthy-asset page (no stale rows shown) is fresh, proving the stale signal is non-vacuous', async () => {
    const app = makeApp();
    // Filtering assets to the covered/healthy one yields a current page — the stale signal above
    // therefore came from the data, not a constant.
    const body = await json(await app.fetch(get('/v1/inventory/assets?coverage_state=covered')));
    expect(body.metadata.freshness).toBe('current');
  });
});

// ============================================================================
// AC5 — discovery catalogs an unregistered source; startDiscovery is audited +
// least-privilege (metadata-only).
// ============================================================================

describe('AC5 · discovery accepts a metadata-only run and catalogs an unknown source', () => {
  const DISCOVERY_BODY = {
    boundary_version_id: '018f0000-0000-7000-8000-0000000000b0',
    source_classes: ['unknown', 'object-store'],
    reason: { code: 'boundary_scan', text: 'scheduled boundary discovery sweep' },
  };

  it('POST returns 202 with an AUDITED accepted-operation (operation+correlation+audit ids)', async () => {
    const app = makeApp();
    const res = await app.fetch(
      post('/v1/inventory/discovery-runs', DISCOVERY_BODY, { 'idempotency-key': 'idem-1' }),
    );
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.operation_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.correlation_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.audit_event_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.status).toBe('accepted');
  });

  it('least privilege: the forwarded command carries only metadata (boundary + reason + classes), never content/credentials', async () => {
    const app = makeApp();
    await app.fetch(
      post('/v1/inventory/discovery-runs', DISCOVERY_BODY, { 'idempotency-key': 'idem-2' }),
    );
    const cmds = app.discoveryCommands();
    expect(cmds.length).toBe(1);
    const cmd = cmds[0];
    // Only metadata-shaped keys — no body/content/secret field can appear.
    expect(new Set(Object.keys(cmd))).toEqual(
      new Set([
        'tenantId',
        'boundaryVersionId',
        'sourceClasses',
        'reason',
        'correlationId',
        'principalId',
        'idempotencyKey',
      ]),
    );
    expect(cmd.boundaryVersionId).toBe(DISCOVERY_BODY.boundary_version_id);
    expect(cmd.reason.code).toBe('boundary_scan');
    expect(cmd.tenantId).toBe(TENANT);
  });

  it('the discovered unknown-class source is catalogued with class/location/access/sensitivity/discovery-evidence/ownership/onboarding facets', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    const unknown = body.items.find((i: Rec) => i.source_class === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.observed_locations.length).toBeGreaterThan(0); // location
    expect(unknown.access_state).toBe('reachable'); // access status
    expect(unknown.onboarding_state).toBe('discovered'); // onboarding state
    expect(unknown.owner_principal_id).toBeNull(); // ownership status: unowned
    // AC5 SENSITIVITY: the discovered source carries its data-sensitivity classification verbatim —
    // 'restricted', the seeded non-default value an operator would triage ahead of a 'normal' source.
    expect(unknown.sensitivity).toBe('restricted');
    // AC5 DISCOVERY EVIDENCE: the provenance (observation id that surfaced the source) is rendered,
    // and it is EXACTLY the seeded evidence id — not fabricated, not a placeholder.
    expect(unknown.discovery_evidence).toBe(DISCOVERY_EVIDENCE);
  });

  it('AC5 non-vacuity: the class-or-unknown source_class, sensitivity, and discovery_evidence are the seeded values — a distinct source has DIFFERENT sensitivity/evidence, proving they are not constants', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    const unknown = body.items.find((i: Rec) => i.source_class === 'unknown');
    expect(unknown).toBeTruthy();
    // The type-or-'unknown' classification: this source's class was never asserted, so it is the
    // pinned 'unknown' sentinel — the discovered-but-unclassified case AC5 requires.
    expect(unknown.source_class).toBe('unknown');
    // Sensitivity is the seeded 'restricted' — and it is a governed-vocabulary member, not free text.
    expect(['normal', 'sensitive', 'restricted']).toContain(unknown.sensitivity);
    expect(unknown.sensitivity).toBe('restricted');

    // NON-VACUITY: a DIFFERENT catalogued source (the healthy kanban) carries the DEFAULT 'normal'
    // sensitivity — so 'restricted' above is bound to the discovered source's own facet, not a field
    // the route stamps identically on every row. Two rows, two distinct sensitivities.
    const kanban = body.items.find((i: Rec) => i.source_class === 'kanban');
    expect(kanban).toBeTruthy();
    expect(kanban.sensitivity).toBe('normal');
    expect(kanban.sensitivity).not.toBe(unknown.sensitivity);
  });

  it('AC5 FULL BUNDLE: the catalogued discovered source carries discovery evidence + type/unknown classification + location + access status + sensitivity + ownership status + onboarding state TOGETHER', async () => {
    // The critic's AC5 oracle: an unregistered governance-relevant source, once discovered, is
    // added to the catalog carrying — on ONE entry, together — its (a) discovery evidence, (b)
    // type-or-'unknown' classification, (c) location, (d) access status, (e) sensitivity, (f)
    // ownership status, and (g) onboarding state. This reads the single unknown-class entry and
    // asserts all seven are present at once.
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    const item = body.items.find((i: Rec) => i.source_class === 'unknown') as Rec;
    expect(item).toBeTruthy();

    const bundle = {
      // (a) discovery evidence (provenance observation id)
      discovery_evidence: item.discovery_evidence,
      // (b) type/unknown classification
      source_class: item.source_class,
      // (c) location(s)
      observed_locations: item.observed_locations,
      // (d) access status
      access_state: item.access_state,
      // (e) sensitivity
      sensitivity: item.sensitivity,
      // (f) ownership status (unowned → explicit null, still a present field)
      owner_principal_id: item.owner_principal_id,
      // (g) onboarding state
      onboarding_state: item.onboarding_state,
    };
    // All seven keys are present on this ONE entry (owner is null but the field exists).
    for (const key of Object.keys(bundle)) {
      expect(key in item, `AC5 attribute '${key}' must be a field on the discovered entry`).toBe(
        true,
      );
    }
    // …and each carries its correct, data-driven value:
    expect(bundle.discovery_evidence).toBe(DISCOVERY_EVIDENCE); // exact seeded provenance
    expect(bundle.source_class).toBe('unknown'); // classified as the unknown sentinel
    expect(Array.isArray(bundle.observed_locations)).toBe(true);
    expect((bundle.observed_locations as unknown[]).length).toBeGreaterThan(0);
    expect(bundle.access_state).toBe('reachable');
    expect(['normal', 'sensitive', 'restricted']).toContain(bundle.sensitivity);
    expect(bundle.sensitivity).toBe('restricted');
    expect(bundle.owner_principal_id).toBeNull(); // ownership status: unowned
    expect(bundle.onboarding_state).toBe('discovered');

    // NON-VACUITY: a DIFFERENT catalogued source (kanban) carries a different classification,
    // sensitivity, and a present owner — so the bundle above is this entry's own facets, not
    // constants stamped on every row.
    const kanban = body.items.find((i: Rec) => i.source_class === 'kanban') as Rec;
    expect(kanban.sensitivity).toBe('normal');
    expect(kanban.owner_principal_id).toBeTruthy();
    expect(kanban.source_class).not.toBe(item.source_class);
  });

  it('NEGATIVE CONTROL: a discovery request missing boundary_version_id is rejected 400 (no run started)', async () => {
    const app = makeApp();
    const res = await app.fetch(
      post(
        '/v1/inventory/discovery-runs',
        { reason: { code: 'x', text: 'yyy' } },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(400);
    expect(app.discoveryCommands().length).toBe(0);
  });

  it('NEGATIVE CONTROL: an unknown extra field is rejected (additionalProperties:false)', async () => {
    const app = makeApp();
    const res = await app.fetch(
      post(
        '/v1/inventory/discovery-runs',
        { ...DISCOVERY_BODY, sneaky: true },
        { 'idempotency-key': 'k2' },
      ),
    );
    expect(res.status).toBe(400);
    expect(app.discoveryCommands().length).toBe(0);
  });
});

// ============================================================================
// AC6 — an unsupported/inaccessible/excluded discovered source stays a VISIBLE
// governed-source gap.
// ============================================================================

describe('AC6 · excluded/inaccessible source stays a visible governed gap', () => {
  it('the excluded source is retained and carries its governed-source gap ids in coverage_gap_ids', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));

    const excluded = body.items.find((i: Rec) => i.source_class === 'unsupported-vendor-x');
    expect(excluded).toBeTruthy(); // stays VISIBLE — never dropped.
    expect(excluded.access_state).toBe('inaccessible');
    expect(excluded.onboarding_state).toBe('excluded');
    // The gap is expressed, not hidden.
    expect(excluded.coverage_gap_ids.length).toBeGreaterThan(0);
    for (const g of excluded.coverage_gap_ids) expect(g).toMatch(/^[0-9a-f-]{36}$/i);

    // The gap ids are folded into the page coverage metadata.
    expect(body.metadata.partial_coverage).toBe(true);
    for (const g of excluded.coverage_gap_ids) {
      expect(body.metadata.coverage_gaps).toContain(g);
    }
  });

  it('the excluded source renders its governed-source gap with FULL content: reason, impact, owner action, and a review OR expiry', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));

    const excluded = body.items.find((i: Rec) => i.source_class === 'unsupported-vendor-x');
    expect(Array.isArray(excluded.coverage_gaps)).toBe(true);
    expect(excluded.coverage_gaps.length).toBeGreaterThan(0);

    // Every governed-source gap carries — NOT a bare id — its reason, impact, and required action.
    for (const g of excluded.coverage_gaps) {
      expect(g.gap_class).toBe('governed_source');
      expect(typeof g.reason).toBe('string');
      expect(g.reason.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high', 'critical', 'unknown']).toContain(g.impact);
      expect(typeof g.required_action).toBe('string');
      expect(g.required_action.length).toBeGreaterThan(0);
    }

    // AC6 "review or expiry": the exclusion gap carries a scheduled review (or an expiry) deadline.
    const exclusionGap = excluded.coverage_gaps.find((g: Rec) => g.reason === 'excluded');
    expect(exclusionGap).toBeTruthy();
    expect(
      typeof exclusionGap.review_at === 'string' || typeof exclusionGap.expires_at === 'string',
    ).toBe(true);
    expect(exclusionGap.impact).toBe('high');
    expect(exclusionGap.required_action).toBe(
      'document the exclusion and schedule a governance review',
    );
  });

  it('AC6 FULL BUNDLE: the governed-source gap is visible carrying reason + impact + owner action + review-or-expiry TOGETHER on one detail', async () => {
    // The critic's AC6 oracle: a discovered source that is unsupported/inaccessible/sensitive/
    // unowned/excluded remains VISIBLE as a governed-source gap carrying — on ONE gap detail,
    // together — its reason, impact, required owner action, and a review OR expiry deadline. This
    // reads the single exclusion gap detail and asserts all four are present at once.
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    const excluded = body.items.find((i: Rec) => i.source_class === 'unsupported-vendor-x') as Rec;
    expect(excluded).toBeTruthy(); // stays VISIBLE — never dropped.
    expect(excluded.access_state).toBe('inaccessible');
    expect(excluded.onboarding_state).toBe('excluded');

    const gaps = excluded.coverage_gaps as Rec[];
    expect(Array.isArray(gaps)).toBe(true);
    const detail = gaps.find((g) => g.reason === 'excluded') as Rec;
    expect(detail).toBeTruthy();

    // All four required fields present TOGETHER on this one governed-source gap detail:
    const hasReviewOrExpiry =
      typeof detail.review_at === 'string' || typeof detail.expires_at === 'string';
    const bundle = {
      reason: detail.reason, // WHY governed coverage is missing
      impact: detail.impact, // IMPACT
      required_action: detail.required_action, // required OWNER ACTION
      review_or_expiry: hasReviewOrExpiry, // REVIEW or EXPIRY deadline
    };
    for (const [k, v] of Object.entries(bundle)) {
      expect(v, `AC6 attribute '${k}' must be present on the governed-source gap`).toBeTruthy();
    }
    expect(detail.gap_class).toBe('governed_source');
    expect(bundle.reason).toBe('excluded');
    expect(bundle.impact).toBe('high');
    expect(bundle.required_action).toBe('document the exclusion and schedule a governance review');
    expect(hasReviewOrExpiry).toBe(true);

    // The gap stays folded into page coverage metadata (visible, not silently dropped).
    expect(body.metadata.partial_coverage).toBe(true);
    for (const g of excluded.coverage_gap_ids as string[]) {
      expect(body.metadata.coverage_gaps).toContain(g);
    }
  });

  it('NEGATIVE CONTROL: an onboarded/covered source exposes NO governed-source gaps (non-vacuity)', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources')));
    // The kanban source is connected/owned → no governed-source gap details attached.
    const kanban = body.items.find((i: Rec) => i.source_class === 'kanban');
    expect(kanban.coverage_gaps === undefined || kanban.coverage_gaps.length === 0).toBe(true);
    expect(kanban.coverage_gap_ids.length).toBe(0);
  });

  it('NEGATIVE CONTROL: filtering to onboarded sources removes the excluded one (proving the filter is real)', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources?state=onboarded')));
    expect(body.items.some((i: Rec) => i.source_class === 'unsupported-vendor-x')).toBe(false);
  });
});

// ============================================================================
// Cursor pagination + partial-coverage metadata.
// ============================================================================

describe('cursor pagination over the source catalog', () => {
  it('limit=1 returns exactly one item + a next_cursor; following the cursor walks the collection without repeats', async () => {
    const app = makeApp();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const path = cursor
        ? `/v1/inventory/sources?limit=1&cursor=${encodeURIComponent(cursor)}`
        : '/v1/inventory/sources?limit=1';
      const body = await json(await app.fetch(get(path)));
      expect(body.items.length).toBeLessThanOrEqual(1);
      for (const i of body.items) {
        // No id is ever repeated across pages (stable, gap-free window).
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      // source_cursor documents which slice this page reflects.
      expect(typeof body.metadata.source_cursor).toBe('string');
      cursor = body.metadata.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(50); // loop guard
    } while (cursor !== null);

    // Every seeded source was visited exactly once across the paged walk (6 sources:
    // kanban, agentctl, workflows_orchestration, warehouse/stale, discovered-unknown, excluded).
    expect(seen.size).toBe(6);
  });

  it('the last page has next_cursor=null', async () => {
    const app = makeApp();
    const body = await json(await app.fetch(get('/v1/inventory/sources?limit=500')));
    expect(body.metadata.next_cursor).toBeNull();
  });

  it('NEGATIVE CONTROL: a malformed cursor is a visible 400, not a silent restart', async () => {
    const app = makeApp();
    const res = await app.fetch(get('/v1/inventory/sources?cursor=not-a-real-cursor'));
    expect(res.status).toBe(400);
  });

  it('NEGATIVE CONTROL: an out-of-range limit is a visible 400', async () => {
    const app = makeApp();
    const res = await app.fetch(get('/v1/inventory/sources?limit=99999'));
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// Tenant scoping — a request scoped to another tenant sees an empty page, never
// this tenant's rows (isolation).
// ============================================================================

describe('tenant scoping', () => {
  it('a request authenticated for a DIFFERENT tenant sees an empty page (no cross-tenant leakage)', async () => {
    const app = makeApp({ verifyIdentity: officer(String(OTHER_TENANT)) });
    const assets = await json(await app.fetch(get('/v1/inventory/assets')));
    const sources = await json(await app.fetch(get('/v1/inventory/sources')));
    expect(assets.items.length).toBe(0);
    expect(sources.items.length).toBe(0);
  });
});
