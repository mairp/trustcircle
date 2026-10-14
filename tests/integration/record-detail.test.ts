import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  identityHeaders,
  startConsoleStub,
  startWeb,
  stopWeb,
  type ConsoleStub,
} from './support/console-stub.ts';

// Record detail routes (/<workspace>/<record id>) on the production web build: every domain record
// link resolves to a page, a complete read without the record is a 404, and dashboards link records
// to those pages instead of dead `?record=` anchors.

const webPort = 18133;
const apiPort = 18134;
let stub: ConsoleStub;
let web: ChildProcess | undefined;

async function page(path: string, roles = 'governance_officer') {
  const response = await fetch(`http://127.0.0.1:${webPort}${path}`, {
    headers: identityHeaders('officer-1', roles),
  });
  return { status: response.status, html: await response.text() };
}

beforeAll(async () => {
  stub = await startConsoleStub(apiPort);
  web = await startWeb(webPort, apiPort);
}, 30_000);

afterAll(async () => {
  stopWeb(web);
  await stub.close();
});

describe('record detail route', () => {
  it('shows one integrity record with its fields, source and breadcrumbs', async () => {
    const { status, html } = await page('/integrity/integrity-case-17');
    expect(status).toBe(200);
    expect(html).toContain('Stale evidence');
    expect(html).toContain('integrity-case-17');
    expect(html).toContain('Where this comes from');
    expect(html).toContain('postgresql-read-model:integrity');
    expect(html).toMatch(/<a href="\/integrity">[^<]*<\/a>/);
  });

  it('is a 404 for a record absent from a complete read, and for non-domain workspaces', async () => {
    expect((await page('/integrity/integrity-nope')).status).toBe(404);
    expect((await page('/search/anything')).status).toBe(404);
    expect((await page('/not-a-workspace/x')).status).toBe(404);
  });

  it('is a 404 for a domain the role cannot read', async () => {
    expect((await page('/evidence/evidence-ev-9', 'operator')).status).toBe(404);
  });

  it('links workspace records to their detail pages, not dead ?record= anchors', async () => {
    const { html } = await page('/integrity');
    expect(html).toContain('href="/integrity/integrity-case-17"');
    expect(html).not.toContain('?record=');
    const decisions = await page('/search?q=fraud');
    expect(decisions.html).not.toContain('?record=');
  });
});
