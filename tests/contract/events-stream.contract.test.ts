// Contract suite — Phase 83 SSE projection-change stream framing + resume-cursor codec
// (apps/api/src/routes/events.ts; bundle 36GCYGDJ15PTYP60F91QWRAY2M).
//
// This suite pins the WIRE CONTRACT the stream exposes to consumers, exercised through the real
// `app.fetch()` surface and the exported cursor codec — independent of the integration behaviour
// suite. Every positive assertion has a negative control so the contract is non-vacuous.
//
// Contract clauses:
//   SSE FIELDS      each dispatched record uses `id:`/`event:`/`data:` fields, a blank-line
//                   dispatch boundary, single-line JSON `data`, and a leading `retry:` hint.
//   EVENT NAMES     a pure change-transport subscription uses only {change,status,gap}; when the
//                   inventory projection is attached the closed set additionally admits
//                   {item,correlation,catalog} — and no name outside that set ever appears.
//   RESUME OPACITY  the `id:` cursor is opaque (base64url), round-trips to its position, and is
//                   bound to (stream-kind, tenant) — a foreign or wrong-kind cursor is rejected.
//   PROJECTION      the projected current-state records carry NO resume `id:` (they are a re-read
//                   snapshot, not a resumable change position).

import { describe, it, expect } from 'vitest';

import { createApp, type AppOptions } from '../../apps/api/src/server.ts';
import { registerEventsRoutes, encodeResumeCursor } from '../../apps/api/src/routes/events.ts';
import type { VerifiedIdentity } from '../../apps/api/src/middleware/context.ts';

import {
  buildFeed,
  providerFor,
  TENANT_ID,
  OTHER_TENANT_ID,
} from '../fixtures/projection-change-feed.ts';

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

function makeApp(feed = buildFeed()): (req: Request) => Promise<Response> {
  const { app } = createApp(baseOptions());
  registerEventsRoutes(app, { feed: providerFor(feed) });
  return (req) => app.fetch(req);
}

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`http://internal${path}`, { method: 'GET', headers });

// ============================================================================
// SSE FIELDS + EVENT NAMES
// ============================================================================

describe('SSE wire framing contract', () => {
  it('every record is field-shaped, JSON-lined, blank-line-delimited, with a leading retry hint', async () => {
    const fetchApp = makeApp(buildFeed({ includeOutOfOrder: true, includeMalformed: true }));
    const body = await (await fetchApp(get('/v1/events'))).text();

    // Leading reconnection hint.
    expect(body.startsWith('retry: ')).toBe(true);

    // Split on the blank-line dispatch boundary; each non-comment block is a well-formed record.
    const blocks = body.split('\n\n').filter((b) => b.trim() !== '');
    let dispatched = 0;
    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l !== '');
      // Comment-only / retry-only blocks are allowed but not dispatched records.
      const fieldLines = lines.filter((l) => !l.startsWith(': ') && !l.startsWith('retry: '));
      if (fieldLines.length === 0) continue;
      dispatched += 1;
      // Exactly one `event:` and one `data:`; `data:` is single-line valid JSON.
      const eventLines = fieldLines.filter((l) => l.startsWith('event: '));
      const dataLines = fieldLines.filter((l) => l.startsWith('data: '));
      expect(eventLines.length).toBe(1);
      expect(dataLines.length).toBe(1);
      expect(() => JSON.parse(dataLines[0]!.slice(6))).not.toThrow();
      // `id:` is optional but at most one.
      expect(fieldLines.filter((l) => l.startsWith('id: ')).length).toBeLessThanOrEqual(1);
    }
    expect(dispatched).toBeGreaterThan(0);
  });

  it('a pure change-transport subscription uses only the closed set {change,status,gap}', async () => {
    const fetchApp = makeApp(buildFeed({ includeOutOfOrder: true, includeMalformed: true }));
    const body = await (await fetchApp(get('/v1/events'))).text();
    const names = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(['change', 'status', 'gap']).toContain(n);
    // NEGATIVE CONTROL: an unknown event name would fail the membership check above — assert the
    // set actually observed includes the three we exercise (proving the check is meaningful), and
    // that the projection-only names are ABSENT without a projection.
    expect(new Set(names)).toEqual(new Set(['change', 'status', 'gap']));
  });
});

// ============================================================================
// PROJECTION — the enriched closed event-name set + snapshot framing contract
// ============================================================================

describe('projected current-state wire contract', () => {
  it('with the inventory projection attached, only {change,status,gap,item,correlation,catalog} appear', async () => {
    const fetchApp = makeApp(buildFeed({ withProjection: true }));
    const body = await (await fetchApp(get('/v1/events'))).text();
    const names = new Set([...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]));
    const allowed = new Set(['change', 'status', 'gap', 'item', 'correlation', 'catalog']);
    for (const n of names) expect(allowed).toContain(n);
    // The three projection record types are actually present (the projection carries all six ACs).
    expect(names.has('item')).toBe(true);
    expect(names.has('correlation')).toBe(true);
    expect(names.has('catalog')).toBe(true);
  });

  it('projected item/correlation/catalog records carry NO resume id (snapshot, not a change position)', async () => {
    const fetchApp = makeApp(buildFeed({ withProjection: true }));
    const body = await (await fetchApp(get('/v1/events'))).text();
    for (const block of body.split('\n\n')) {
      const lines = block.split('\n').filter((l) => l !== '');
      const ev = lines.find((l) => l.startsWith('event: '))?.slice(7);
      if (ev === 'item' || ev === 'correlation' || ev === 'catalog') {
        expect(lines.some((l) => l.startsWith('id: '))).toBe(false);
      }
    }
    // NEGATIVE CONTROL: `change` records DO carry a resume id (proving the absence above is specific).
    const changeBlocks = body
      .split('\n\n')
      .filter((b) => b.split('\n').some((l) => l === 'event: change'));
    expect(changeBlocks.length).toBeGreaterThan(0);
    for (const b of changeBlocks) {
      expect(b.split('\n').some((l) => l.startsWith('id: '))).toBe(true);
    }
  });
});

// ============================================================================
// RESUME CURSOR — opacity + binding
// ============================================================================

describe('resume-cursor codec contract', () => {
  it('the id emitted on a change round-trips to a resumable cursor for the same tenant', async () => {
    const fetchApp = makeApp();
    const body = await (await fetchApp(get('/v1/events'))).text();
    const firstId = /^id: (.+)$/m.exec(body)?.[1];
    expect(firstId).toBeTruthy();
    // Opaque base64url (no JSON structure leaked on the wire).
    expect(firstId!).toMatch(/^[A-Za-z0-9_-]+$/);
    // Re-issuing the encoder for the same tenant + position reproduces the exact token (stable,
    // deterministic — the resume contract).
    expect(encodeResumeCursor(String(TENANT_ID), 1)).toBe(firstId);
  });

  it('NEGATIVE CONTROL: a cursor for another tenant is rejected 400 (not silently accepted)', async () => {
    const fetchApp = makeApp();
    const foreign = encodeResumeCursor(String(OTHER_TENANT_ID), 1);
    const res = await fetchApp(get('/v1/events', { 'last-event-id': foreign }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('invalid_cursor');
  });

  it('NEGATIVE CONTROL: a wrong-kind / garbage cursor is rejected 400', async () => {
    const fetchApp = makeApp();
    const garbage = Buffer.from(
      JSON.stringify({ k: 'not-this-stream', t: String(TENANT_ID), s: 1 }),
    ).toString('base64url');
    const res = await fetchApp(get('/v1/events', { 'last-event-id': garbage }));
    expect(res.status).toBe(400);
  });
});
