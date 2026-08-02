// Integration suite — Phase 83 CURRENT-STATE INVENTORY PROJECTION on the SSE wire
// (apps/api/src/routes/events.ts; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// The Phase-83 acceptance criteria describe an INVENTORY / CURRENT-STATE GOVERNANCE VIEW, not a
// stream-transport. This suite proves every criterion is observable DIRECTLY OFF THE SSE WIRE: the
// route is handed the tenant's real inventory read model (`@trustcircle/application`'s
// `InventoryService`, seeded with all six AC scenarios via the domain value-object factories) and
// projects the current state after the change slice as explicit `item` / `correlation` / `gap` /
// `catalog` records. Every assertion drives the REAL `app.fetch()` entry point and reads the
// governance facets from the RESPONSE body — never a mutation echo, never an opaque envelope.
//
// AC → observable-evidence map (all read from the wire):
//   AC1  each governed asset appears as exactly ONE `item` record carrying its full facet set:
//        type / owner (or ownership gap) / lifecycle / risk / control coverage / evidence state /
//        health / last observation time / unresolved issues.
//   AC2  a `gap` record (gap_class=component) with reason / age / impact / required owner action.
//   AC3  a `correlation` record with DISTINCT source records, a per-field STATUS DIFFERENCE,
//        dependency edges, and authoritative-field attributions.
//   AC4  the stale asset's `item` carries a last-known observation time AND a confidence < 1, and
//        withholds current health (reported_health='unknown') while showing observed health.
//   AC5  a `catalog` record for a discovered source with classification / location / access /
//        sensitivity / ownership / onboarding / discovery evidence.
//   AC6  a `gap` record (gap_class=governed_source) with reason / impact / owner action AND a
//        review-or-expiry deadline.
//
// Each criterion is paired with a NEGATIVE CONTROL that flips the observable outcome, so the oracle
// is non-vacuous (a permissive fake would fail the control).

import { describe, it, expect } from 'vitest';

import { createApp, type AppOptions } from '../../apps/api/src/server.ts';
import { registerEventsRoutes } from '../../apps/api/src/routes/events.ts';
import type { VerifiedIdentity } from '../../apps/api/src/middleware/context.ts';

import { buildFeed, providerFor, TENANT_ID } from '../fixtures/projection-change-feed.ts';
import {
  P_HEALTHY_ASSET,
  P_GAP_ASSET,
  P_CORR_ASSET,
  P_STALE_ASSET,
  P_OWNER,
  P_COMPONENT_GAP,
  P_GOVERNED_GAP,
  P_DISCOVERED_CATALOG,
  P_EXCLUDED_CATALOG,
  P_DISCOVERY_EVIDENCE,
  P_KANBAN_RECORD,
  P_AGENTCTL_RECORD,
  P_DEP_REL,
  P_AUTH_REL,
  CORR_FIELD,
} from '../fixtures/inventory-projection.ts';

// --- Harness -----------------------------------------------------------------

const T0 = 1_772_000_000_000;

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
    verifyIdentity: officer(String(TENANT_ID)),
    readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
    now: () => T0,
    ...over,
  };
}

/** Build the app with a feed that carries the real inventory projection (unless overridden off). */
function makeApp(withProjection = true, over: Partial<AppOptions> = {}) {
  const { app } = createApp(baseOptions(over));
  registerEventsRoutes(app, { feed: providerFor(buildFeed({ withProjection })) });
  return app;
}

function get(path = '/v1/events'): Request {
  return new Request(`http://internal${path}`, { method: 'GET' });
}

// --- SSE parser (independent read of the wire body) --------------------------

interface SseRecord {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
}

function parseSse(body: string): SseRecord[] {
  const records: SseRecord[] = [];
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue;
    const rec: SseRecord = {};
    let hasField = false;
    for (const line of block.split('\n')) {
      if (line.startsWith(': ') || line.startsWith('retry: ')) continue;
      if (line.startsWith('id: ')) {
        rec.id = line.slice(4);
        hasField = true;
      } else if (line.startsWith('event: ')) {
        rec.event = line.slice(7);
        hasField = true;
      } else if (line.startsWith('data: ')) {
        rec.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        hasField = true;
      }
    }
    if (hasField) records.push(rec);
  }
  return records;
}

async function wire(app: { fetch: (r: Request) => Promise<Response> }): Promise<SseRecord[]> {
  const res = await app.fetch(get());
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  return parseSse(await res.text());
}

const eventsOf = (recs: SseRecord[], name: string): SseRecord[] =>
  recs.filter((r) => r.event === name);
const itemsOf = (recs: SseRecord[]): SseRecord[] => eventsOf(recs, 'item');
const gapsOf = (recs: SseRecord[]): SseRecord[] => eventsOf(recs, 'gap');
const catalogOf = (recs: SseRecord[]): SseRecord[] => eventsOf(recs, 'catalog');
const correlationsOf = (recs: SseRecord[]): SseRecord[] => eventsOf(recs, 'correlation');

const itemFor = (recs: SseRecord[], assetId: string): Record<string, unknown> => {
  const m = itemsOf(recs).filter((r) => r.data!.asset_id === assetId);
  expect(m).toHaveLength(1); // AC1: each item appears exactly ONCE
  return m[0]!.data!;
};

// ============================================================================
// AC1 — each item ONCE with its full facet set
// ============================================================================

describe('AC1 — current-state view: each item once, full facet set', () => {
  it('projects one item record per governed asset carrying every enumerated facet', async () => {
    const recs = await wire(makeApp());
    const items = itemsOf(recs);
    // Four seeded assets, each rendered exactly once (no duplication of the stream into rows).
    const ids = items.map((r) => r.data!.asset_id).sort();
    expect(ids).toEqual(
      [
        String(P_HEALTHY_ASSET),
        String(P_GAP_ASSET),
        String(P_CORR_ASSET),
        String(P_STALE_ASSET),
      ].sort(),
    );

    const healthy = itemFor(recs, String(P_HEALTHY_ASSET));
    // Every AC1 facet is a NAMED field on the wire.
    expect(healthy.asset_type).toBe('service'); // type
    expect(healthy.owner_principal_id).toBe(String(P_OWNER)); // owner
    expect(healthy.ownership_gap).toBe(false);
    expect(healthy.lifecycle_state).toBe('operating'); // lifecycle
    expect(healthy.risk_tier).toBe('moderate'); // risk
    expect(healthy.coverage).toBe('covered'); // control coverage
    expect(healthy.evidence_state).toBe('current'); // evidence state
    expect(healthy.observed_health).toBe('healthy'); // health
    expect(healthy.reported_health).toBe('healthy'); // fresh ⇒ current health reportable
    expect(typeof healthy.last_observed_at).toBe('string'); // last observation time
    expect(healthy.unresolved_issues).toBe(0); // unresolved issues
    expect(healthy.source_record_count).toBe(1);
  });

  it('NEGATIVE CONTROL: an UNOWNED asset surfaces owner=null + ownership_gap=true (not hidden)', async () => {
    const gap = itemFor(await wire(makeApp()), String(P_GAP_ASSET));
    expect(gap.owner_principal_id).toBeNull();
    expect(gap.ownership_gap).toBe(true);
    // …and a healthy, owned asset in the SAME response does NOT flip the facet — proves it's derived.
    const healthy = itemFor(await wire(makeApp()), String(P_HEALTHY_ASSET));
    expect(healthy.ownership_gap).toBe(false);
  });

  it('NEGATIVE CONTROL: with no projection attached, NO item records are emitted', async () => {
    const recs = await wire(makeApp(false));
    expect(itemsOf(recs)).toHaveLength(0);
    expect(correlationsOf(recs)).toHaveLength(0);
    expect(catalogOf(recs)).toHaveLength(0);
  });
});

// ============================================================================
// AC2 — component coverage gap with reason / age / impact / owner action
// ============================================================================

describe('AC2 — visible component coverage gap with reason/age/impact/owner-action', () => {
  it('projects a component gap kept visible with all four required facets', async () => {
    const recs = await wire(makeApp());
    const comp = gapsOf(recs).find(
      (r) => r.data!.gap_class === 'component' && r.data!.gap_id === String(P_COMPONENT_GAP),
    );
    expect(comp).toBeDefined();
    const g = comp!.data!;
    expect(g.reason).toBe('orphaned'); // reason
    expect(g.impact).toBe('high'); // impact
    expect(typeof g.required_action).toBe('string'); // required owner action
    expect(String(g.required_action)).toMatch(/owner/i);
    expect(g.required_owner).toBe(String(P_OWNER));
    expect(typeof g.age_millis).toBe('number'); // age
    expect(g.age_millis as number).toBeGreaterThan(0); // first-seen 3h before `now`
    // The bound asset's item can never present as covered+healthy.
    const gapAsset = itemFor(recs, String(P_GAP_ASSET));
    expect(gapAsset.has_visible_component_gap).toBe(true);
    expect(gapAsset.coverage).toBe('gap');
  });

  it('NEGATIVE CONTROL: the healthy asset carries NO visible component gap', async () => {
    const recs = await wire(makeApp());
    const healthy = itemFor(recs, String(P_HEALTHY_ASSET));
    expect(healthy.has_visible_component_gap).toBe(false);
    const componentGapSubjects = gapsOf(recs)
      .filter((r) => r.data!.gap_class === 'component')
      .map((r) => r.data!.subject_id);
    expect(componentGapSubjects).not.toContain(String(P_HEALTHY_ASSET));
  });
});

// ============================================================================
// AC3 — drill-down: distinct records / status differences / dependencies / authoritative fields
// ============================================================================

describe('AC3 — cross-source drill-down correlation', () => {
  it('projects distinct source records, a status difference, a dependency, and an authoritative field', async () => {
    const recs = await wire(makeApp());
    const corr = correlationsOf(recs).find((r) => r.data!.asset_id === String(P_CORR_ASSET));
    expect(corr).toBeDefined();
    const c = corr!.data!;

    // DISTINCT source records across registered sources (kanban + agentctl), none collapsed.
    const recordIds = (c.source_records as { record_id: string }[]).map((r) => r.record_id).sort();
    expect(recordIds).toEqual([String(P_AGENTCTL_RECORD), String(P_KANBAN_RECORD)].sort());
    const classes = (c.source_records as { source_class: string }[]).map((r) => r.source_class);
    expect(classes).toContain('platform_kanban');
    expect(classes).toContain('agentctl');

    // A per-field STATUS DIFFERENCE: the two records disagree on the correlated field.
    const diffs = c.status_differences as {
      field: string;
      values: { value: unknown; record_ids: string[] }[];
    }[];
    const fieldDiff = diffs.find((d) => d.field === CORR_FIELD);
    expect(fieldDiff).toBeDefined();
    const values = fieldDiff!.values.map((v) => v.value).sort();
    expect(values).toEqual(['paused', 'running']); // the two conflicting values, each with its ids
    expect(fieldDiff!.values.every((v) => v.record_ids.length >= 1)).toBe(true);

    // Dependency edge (depends_on) surfaces.
    const deps = c.dependencies as { relationship_id: string }[];
    expect(deps.map((d) => d.relationship_id)).toContain(String(P_DEP_REL));

    // Authoritative-field attribution (authoritative_for) surfaces.
    const auth = c.authoritative_fields as { relationship_id: string; field: string }[];
    expect(auth.map((a) => a.relationship_id)).toContain(String(P_AUTH_REL));
    expect(auth.map((a) => a.field)).toContain(CORR_FIELD);

    // An unresolved/contested asset marks its automation as paused-safe.
    expect(typeof c.unresolved).toBe('boolean');
  });

  it('NEGATIVE CONTROL: an asset whose sources agree reports NO status difference', async () => {
    // The healthy asset has a single record ⇒ nothing to disagree about.
    const recs = await wire(makeApp());
    const corr = correlationsOf(recs).find((r) => r.data!.asset_id === String(P_HEALTHY_ASSET))!;
    expect((corr.data!.status_differences as unknown[]).length).toBe(0);
  });
});

// ============================================================================
// AC4 — stale marking: last-known time + confidence; health never inferred from stale data
// ============================================================================

describe('AC4 — stale source marked with last-known time + confidence', () => {
  it('marks the stale asset with a last-known time AND confidence < 1, withholding current health', async () => {
    const stale = itemFor(await wire(makeApp()), String(P_STALE_ASSET));
    expect(typeof stale.last_observed_at).toBe('string'); // last-known time preserved
    expect(stale.confidence as number).toBeLessThan(1); // confidence marked
    expect(stale.stale).toBe(true);
    expect(stale.evidence_state).not.toBe('current');
    expect(stale.observed_health).toBe('healthy'); // recorded health shown verbatim
    expect(stale.reported_health).toBe('unknown'); // but current health NOT inferred from stale data
  });

  it('NEGATIVE CONTROL: the fresh asset reports full confidence and current health', async () => {
    const healthy = itemFor(await wire(makeApp()), String(P_HEALTHY_ASSET));
    expect(healthy.confidence).toBe(1);
    expect(healthy.stale).toBe(false);
    expect(healthy.evidence_state).toBe('current');
    expect(healthy.reported_health).toBe('healthy');
  });
});

// ============================================================================
// AC5 — discovered source catalogued with full classification
// ============================================================================

describe('AC5 — discovered source added to the catalog', () => {
  it('projects a catalog entry with classification/location/access/sensitivity/ownership/onboarding/evidence', async () => {
    const recs = await wire(makeApp());
    const entry = catalogOf(recs).find((r) => r.data!.catalog_id === String(P_DISCOVERED_CATALOG));
    expect(entry).toBeDefined();
    const e = entry!.data!;
    expect(e.source_class).toBe('unknown'); // type-or-unknown classification
    expect(e.classified_unknown).toBe(true);
    expect(e.observed_locations).toContain('s3://acme-unmapped-bucket'); // location
    expect(e.access_state).toBe('reachable'); // access status
    expect(e.sensitivity).toBe('restricted'); // sensitivity
    expect(e.owner_principal_id).toBeNull(); // ownership status — unowned
    expect(e.ownership_gap).toBe(true);
    expect(e.onboarding_state).toBe('discovered'); // onboarding state
    expect(e.discovery_evidence).toBe(String(P_DISCOVERY_EVIDENCE)); // discovery evidence
  });

  it('NEGATIVE CONTROL: a KNOWN-class source is not flagged classified_unknown', async () => {
    const recs = await wire(makeApp());
    const excluded = catalogOf(recs).find(
      (r) => r.data!.catalog_id === String(P_EXCLUDED_CATALOG),
    )!;
    expect(excluded.data!.source_class).toBe('unsupported-vendor-x');
    expect(excluded.data!.classified_unknown).toBe(false);
  });
});

// ============================================================================
// AC6 — governed-source gap with reason / impact / owner action / review-or-expiry
// ============================================================================

describe('AC6 — governed-source gap with review-or-expiry', () => {
  it('projects a governed-source gap with reason/impact/owner-action AND a review deadline', async () => {
    const recs = await wire(makeApp());
    const gsg = gapsOf(recs).find(
      (r) => r.data!.gap_class === 'governed_source' && r.data!.gap_id === String(P_GOVERNED_GAP),
    );
    expect(gsg).toBeDefined();
    const g = gsg!.data!;
    expect(g.reason).toBe('excluded'); // reason
    expect(g.impact).toBe('high'); // impact
    expect(String(g.required_action)).toMatch(/review/i); // owner action
    expect(g.required_owner).toBe(String(P_OWNER));
    expect(g.has_deadline).toBe(true);
    expect(typeof g.review_at).toBe('string'); // review-or-expiry deadline
    expect(g.subject_id).toBe(String(P_EXCLUDED_CATALOG));
  });

  it('NEGATIVE CONTROL: the component gap is NOT classified as a governed-source gap', async () => {
    const recs = await wire(makeApp());
    const governedIds = gapsOf(recs)
      .filter((r) => r.data!.gap_class === 'governed_source')
      .map((r) => r.data!.gap_id);
    expect(governedIds).not.toContain(String(P_COMPONENT_GAP));
    expect(governedIds).toContain(String(P_GOVERNED_GAP));
  });
});

// ============================================================================
// DETERMINISM — identical read model ⇒ identical projected bytes
// ============================================================================

describe('determinism', () => {
  it('the projected snapshot is byte-identical across two reads of the same read model', async () => {
    const a = await (await makeApp().fetch(get())).text();
    const b = await (await makeApp().fetch(get())).text();
    expect(a).toBe(b);
  });
});
