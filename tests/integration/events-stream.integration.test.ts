// Integration suite — Phase 83 authorized projection-change SSE stream
// (apps/api/src/routes/events.ts; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// Every assertion drives the REAL `app.fetch()` entry point (a Fetch `Request` → `Response`) —
// the same path a live server uses — and reads the observable outcome from the RESPONSE (SSE
// body + headers), never a mutation echo. The authorized change feed is seeded deterministically
// (fixed ids + clock) from tests/fixtures/projection-change-feed.ts, which composes contract-valid
// governance envelopes. Each behaviour is paired with a NEGATIVE CONTROL that flips the observable
// outcome, so the oracle is non-vacuous.
//
// Behaviour → observable-evidence map (all read from the wire):
//   SSE FRAMING     the response is text/event-stream; each change is an `id:`/`event:`/`data:`
//                   record; a leading `retry:` reconnection hint is present.
//   AUTHORIZED      only the caller's tenant's changes stream; a tenant with no feed gets an
//                   empty, current stream (not another tenant's data); a foreign-tenant cursor
//                   is rejected 400 (authorization boundary on resume).
//   CURSOR RESUME   a fresh subscription replays the retained window; resuming with the last
//                   `id:` continues STRICTLY AFTER it (gap-free, no repeats); the `x-next-cursor`
//                   header + trailing id let a client reconnect.
//   EXPIRED CURSOR  a cursor before the retained floor ⇒ a `status` record with resume=partial,
//                   partial=true, and the missed sequence span — never a silent skip.
//   STALE/PARTIAL   a stale/aging/partial projection ⇒ the head `status` marks it + a safe next
//                   action; each `change` carries stale/freshness; health is never inferred.
//   ORDERING        a duplicate is dropped (no second effect); an out-of-order change surfaces a
//                   visible `gap` record; a malformed envelope is skipped with a visible note.
//   MALFORMED CURSOR a non-decodable / wrong-kind cursor ⇒ visible 400.

import { describe, it, expect } from 'vitest';

import { createApp, type AppOptions } from '../../apps/api/src/server.ts';
import {
  registerEventsRoutes,
  encodeResumeCursor,
  EVENTS_HEADERS,
} from '../../apps/api/src/routes/events.ts';
import type { VerifiedIdentity } from '../../apps/api/src/middleware/context.ts';

import {
  buildFeed,
  providerFor,
  TENANT_ID,
  OTHER_TENANT_ID,
  HEALTHY_ASSET_ID,
} from '../fixtures/projection-change-feed.ts';

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
    verifyIdentity: officer(String(TENANT_ID)),
    readiness: () => ({ facets: [], freshnessObjectiveMs: 60_000 }),
    now: () => T0,
    ...over,
  };
}

interface Harness {
  fetch: (req: Request) => Promise<Response>;
}

function makeApp(
  feed = buildFeed(),
  over: Partial<AppOptions> = {},
  retryMillis?: number,
): Harness {
  const { app } = createApp(baseOptions(over));
  registerEventsRoutes(app, {
    feed: providerFor(feed),
    ...(retryMillis !== undefined ? { retryMillis } : {}),
  });
  return { fetch: (req) => app.fetch(req) };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://internal${path}`, { method: 'GET', headers });
}

// --- SSE parser (independent read of the wire body) --------------------------

interface SseRecord {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
}

/** Parse a raw SSE body into records, ignoring comment (`:`) lines and the leading `retry:`. */
function parseSse(body: string): { records: SseRecord[]; retry?: number; comments: string[] } {
  const records: SseRecord[] = [];
  const comments: string[] = [];
  let retry: number | undefined;
  for (const block of body.split('\n\n')) {
    if (block.trim() === '') continue;
    const rec: SseRecord = {};
    let hasField = false;
    for (const line of block.split('\n')) {
      if (line.startsWith(': ')) {
        comments.push(line.slice(2));
        continue;
      }
      if (line.startsWith('retry: ')) {
        retry = Number(line.slice(7));
        continue;
      }
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
  return { records, retry, comments };
}

async function readSse(res: Response): Promise<ReturnType<typeof parseSse>> {
  return parseSse(await res.text());
}

const changesOf = (recs: SseRecord[]): SseRecord[] => recs.filter((r) => r.event === 'change');
const statusOf = (recs: SseRecord[]): SseRecord[] => recs.filter((r) => r.event === 'status');
const gapsOf = (recs: SseRecord[]): SseRecord[] => recs.filter((r) => r.event === 'gap');

// ============================================================================
// SSE FRAMING
// ============================================================================

describe('SSE framing', () => {
  it('responds with text/event-stream, a leading retry hint, and id/event/data records', async () => {
    const app = makeApp(buildFeed(), {}, 4500);
    const res = await app.fetch(get('/v1/events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);

    const { records, retry, comments } = await readSse(res);
    expect(retry).toBe(4500); // the injected reconnection hint
    // A head status record + three change records (v1..v3), each a resumable id.
    const changes = changesOf(records);
    expect(changes.length).toBe(3);
    for (const ch of changes) {
      expect(typeof ch.id).toBe('string');
      expect(ch.id!.length).toBeGreaterThan(0);
      expect(ch.data!.event_type).toBe('governance.inventory.asset.observed');
    }
    // A keep-alive comment is present (distinguishes an open-but-idle stream from truncation).
    expect(comments).toContain('keep-alive');
  });

  it('NEGATIVE CONTROL: a non-SSE method/path does not stream', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://internal/v1/events', { method: 'POST' }));
    // GET-only route ⇒ 405 (method exists) — never an SSE body.
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
    expect([404, 405]).toContain(res.status);
  });
});

// ============================================================================
// AUTHORIZED — tenant scope + isolation
// ============================================================================

describe('authorization / tenant isolation', () => {
  it('an unauthenticated request is rejected before any stream is produced', async () => {
    const { app } = createApp(baseOptions({ verifyIdentity: () => null }));
    registerEventsRoutes(app, { feed: providerFor(buildFeed()) });
    const res = await app.fetch(get('/v1/events'));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).not.toMatch(/event-stream/);
  });

  it('a tenant with NO feed gets an empty, current stream — never another tenant’s changes', async () => {
    // Authenticate as OTHER_TENANT; the provider only serves TENANT_ID.
    const app = makeApp(buildFeed(), { verifyIdentity: officer(String(OTHER_TENANT_ID)) });
    const res = await app.fetch(get('/v1/events'));
    expect(res.status).toBe(200);
    const { records } = await readSse(res);
    expect(changesOf(records).length).toBe(0); // no cross-tenant data leaks in
    const head = statusOf(records)[0]!;
    expect(head.data!.tenant_id).toBe(String(OTHER_TENANT_ID));
    expect(head.data!.freshness).toBe('current');
  });

  it('NEGATIVE CONTROL: a resume cursor minted for ANOTHER tenant is rejected (auth boundary)', async () => {
    const app = makeApp();
    const foreign = encodeResumeCursor(String(OTHER_TENANT_ID), 1);
    const res = await app.fetch(get('/v1/events', { 'last-event-id': foreign }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_cursor');
    // sanity: the SAME position under the CALLER's tenant is accepted (proves the reject is
    // about tenancy, not the position).
    const own = encodeResumeCursor(String(TENANT_ID), 1);
    const ok = await app.fetch(get('/v1/events', { 'last-event-id': own }));
    expect(ok.status).toBe(200);
  });
});

// ============================================================================
// CURSOR RESUME — gap-free continuation
// ============================================================================

describe('cursor resume', () => {
  it('a fresh subscription replays the retained window from the floor', async () => {
    const app = makeApp();
    const { records } = await readSse(await app.fetch(get('/v1/events')));
    const head = statusOf(records)[0]!;
    expect(head.data!.resume).toBe('fresh');
    expect(head.data!.partial).toBe(false);
    expect(changesOf(records).map((c) => c.data!.sequence)).toEqual([1, 2, 3]);
  });

  it('resuming with the last id continues STRICTLY AFTER it — gap-free, no repeats', async () => {
    const app = makeApp();
    // First read; take the id of change #2.
    const first = await readSse(await app.fetch(get('/v1/events')));
    const secondChangeId = changesOf(first.records)[1]!.id!;
    // Reconnect with Last-Event-ID = change #2's id.
    const resumed = await readSse(
      await app.fetch(get('/v1/events', { 'last-event-id': secondChangeId })),
    );
    const head = statusOf(resumed.records)[0]!;
    expect(head.data!.resume).toBe('gapless');
    // Only change #3 is delivered; #1 and #2 are NOT repeated.
    const seqs = changesOf(resumed.records).map((c) => c.data!.sequence);
    expect(seqs).toEqual([3]);
  });

  it('the x-next-cursor header lets a client reconnect from the tail (no more changes on re-read)', async () => {
    const app = makeApp();
    const res = await app.fetch(get('/v1/events'));
    const next = res.headers.get(EVENTS_HEADERS.nextCursor)!;
    expect(next).toBeTruthy();
    // Reconnecting from the tail cursor yields zero new changes (fully caught up).
    const again = await readSse(await app.fetch(get('/v1/events', { 'last-event-id': next })));
    expect(changesOf(again.records).length).toBe(0);
    expect(statusOf(again.records)[0]!.data!.resume).toBe('gapless');
  });

  it('the query ?cursor= param resumes identically when no Last-Event-ID header is sent', async () => {
    const app = makeApp();
    const first = await readSse(await app.fetch(get('/v1/events')));
    const id2 = changesOf(first.records)[1]!.id!;
    const viaQuery = await readSse(
      await app.fetch(get(`/v1/events?cursor=${encodeURIComponent(id2)}`)),
    );
    expect(changesOf(viaQuery.records).map((c) => c.data!.sequence)).toEqual([3]);
  });
});

// ============================================================================
// EXPIRED CURSOR — partial resume, never a silent skip
// ============================================================================

describe('expired cursor (beyond retained window)', () => {
  it('a cursor before the retained floor ⇒ resume=partial + the missed span, never a silent skip', async () => {
    // Window floor advanced to sequence 3 (changes 1..2 evicted). The default records still
    // include seq 1..3, but the feed advertises floor=3 so 1..2 are unreplayable.
    const feed = buildFeed({ windowFloorSequence: 3 });
    const app = makeApp(feed);
    // Client resumes from sequence 0 (before floor-1 = 2).
    const cursor = encodeResumeCursor(String(TENANT_ID), 0);
    const { records } = await readSse(
      await app.fetch(get('/v1/events', { 'last-event-id': cursor })),
    );
    const head = statusOf(records)[0]!;
    expect(head.data!.resume).toBe('partial');
    expect(head.data!.partial).toBe(true);
    expect(head.data!.missed_sequence_span).toEqual({ from: 1, to: 2 });
    expect(typeof head.data!.safe_next_action).toBe('string');
    // It replays from the floor: only sequence 3 (>= floor) is delivered — not 1/2.
    expect(changesOf(records).map((c) => c.data!.sequence)).toEqual([3]);
  });

  it('NEGATIVE CONTROL: an in-window cursor is gapless (no partial flag, no missed span)', async () => {
    const feed = buildFeed({ windowFloorSequence: 1 });
    const app = makeApp(feed);
    const cursor = encodeResumeCursor(String(TENANT_ID), 1);
    const { records } = await readSse(
      await app.fetch(get('/v1/events', { 'last-event-id': cursor })),
    );
    const head = statusOf(records)[0]!;
    expect(head.data!.resume).toBe('gapless');
    expect(head.data!.partial).toBe(false);
    expect(head.data!.missed_sequence_span).toBeUndefined();
  });
});

// ============================================================================
// STALE / PARTIAL STATUS — never infer health from stale data
// ============================================================================

describe('stale / partial status', () => {
  it('a STALE projection marks the head status + every change stale, with a safe next action', async () => {
    const app = makeApp(buildFeed({ freshness: 'stale' }));
    const res = await app.fetch(get('/v1/events'));
    expect(res.headers.get(EVENTS_HEADERS.freshness)).toBe('stale');
    const { records } = await readSse(res);
    const head = statusOf(records)[0]!;
    expect(head.data!.freshness).toBe('stale');
    expect(head.data!.safe_next_action).toMatch(/not current|do not infer/i);
    for (const ch of changesOf(records)) {
      expect(ch.data!.freshness).toBe('stale');
      expect(ch.data!.stale).toBe(true); // current health is NOT inferred from a stale change
    }
  });

  it('a PARTIAL projection marks partial=true + a coverage safe next action', async () => {
    const app = makeApp(buildFeed({ partialCoverage: true }));
    const res = await app.fetch(get('/v1/events'));
    expect(res.headers.get(EVENTS_HEADERS.streamStatus)).toBe('partial');
    const head = statusOf((await readSse(res)).records)[0]!;
    expect(head.data!.partial).toBe(true);
    expect(head.data!.safe_next_action).toMatch(/partial/i);
  });

  it('NEGATIVE CONTROL: a CURRENT, complete projection carries NO stale flag / safe action', async () => {
    const app = makeApp(buildFeed({ freshness: 'current', partialCoverage: false }));
    const res = await app.fetch(get('/v1/events'));
    expect(res.headers.get(EVENTS_HEADERS.freshness)).toBe('current');
    const { records } = await readSse(res);
    const head = statusOf(records)[0]!;
    expect(head.data!.partial).toBe(false);
    expect(head.data!.safe_next_action).toBeUndefined();
    for (const ch of changesOf(records)) expect(ch.data!.stale).toBe(false);
  });
});

// ============================================================================
// ORDERING — duplicate / out-of-order / malformed (shared events runtime)
// ============================================================================

describe('ordering safety', () => {
  it('SAFE UNDER DUPLICATE: a re-delivered event id is dropped — no second change record', async () => {
    const app = makeApp(buildFeed({ includeDuplicate: true }));
    const { records } = await readSse(await app.fetch(get('/v1/events')));
    // Still exactly 3 delivered changes despite the duplicate v1 re-delivery.
    expect(changesOf(records).length).toBe(3);
    // And no gap note was emitted for the duplicate.
    expect(gapsOf(records).length).toBe(0);
  });

  it('SAFE UNDER OUT-OF-ORDER: a change with a missing predecessor surfaces a visible gap', async () => {
    const app = makeApp(buildFeed({ includeOutOfOrder: true }));
    const { records } = await readSse(await app.fetch(get('/v1/events')));
    const gaps = gapsOf(records);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.data!.decision).toBe('out_of_order');
    expect(gaps[0]!.data!.awaiting_version).toBe(1);
    // The out-of-order change is NOT delivered as an applied change record.
    expect(changesOf(records).map((c) => c.data!.aggregate_id)).not.toContain(
      gaps[0]!.data!.aggregate_id,
    );
    // And it exposes the missing versions (reconciliation view).
    expect(Array.isArray(gaps[0]!.data!.missing_versions)).toBe(true);
  });

  it('SAFE UNDER MALFORMED: an invalid envelope is skipped with a visible status note', async () => {
    const app = makeApp(buildFeed({ includeMalformed: true }));
    const { records } = await readSse(await app.fetch(get('/v1/events')));
    const skips = statusOf(records).filter((r) => r.data!.skipped === true);
    expect(skips.length).toBe(1);
    expect(skips[0]!.data!.reason).toMatch(/validation/i);
    // The three valid changes are still delivered.
    expect(changesOf(records).length).toBe(3);
  });
});

// ============================================================================
// MALFORMED CURSOR — visible 400
// ============================================================================

describe('malformed resume cursor', () => {
  it('a non-decodable cursor is a visible 400 with a restart action, not a silent restart', async () => {
    const app = makeApp();
    const res = await app.fetch(get('/v1/events', { 'last-event-id': '!!!not-base64url!!!==' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_cursor');
    expect(Array.isArray(body.safe_next_actions)).toBe(true);
    expect((body.safe_next_actions as string[]).length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL: a well-formed cursor for THIS tenant is accepted (200)', async () => {
    const app = makeApp();
    const res = await app.fetch(
      get('/v1/events', { 'last-event-id': encodeResumeCursor(String(TENANT_ID), 1) }),
    );
    expect(res.status).toBe(200);
  });

  it('the Last-Event-ID header takes precedence over ?cursor= (reconnecting EventSource behaviour)', async () => {
    const app = makeApp();
    const headerCursor = encodeResumeCursor(String(TENANT_ID), 3); // caught up ⇒ 0 changes
    const queryCursor = encodeResumeCursor(String(TENANT_ID), 0); // would replay all
    const { records } = await readSse(
      await app.fetch(
        get(`/v1/events?cursor=${encodeURIComponent(queryCursor)}`, {
          'last-event-id': headerCursor,
        }),
      ),
    );
    // Header wins: caught up, zero changes.
    expect(changesOf(records).length).toBe(0);
  });
});

// keep the healthy-asset id referenced (documents which aggregate the window streams).
void HEALTHY_ASSET_ID;
