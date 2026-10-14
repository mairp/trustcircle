import type { ChildProcess } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  STUB_DECISION,
  identityHeaders,
  startConsoleStub,
  startWeb,
  stopWeb,
  type ConsoleStub,
} from './support/console-stub.ts';

// axe-core WCAG 2.2 AA scans of the REAL production routes, for every operator role and both
// themes, plus phone-width reflow and the auditor evidence-package flow in a real browser.
//
// Needs Chromium, so it runs only with TC_A11Y_LIVE=1 (`npm run test:a11y:live`, and the
// `accessibility (live routes)` CI job, which installs the browser). Without it the suite is
// reported as skipped, never as passed.

const LIVE = process.env['TC_A11Y_LIVE'] === '1';
const webPort = 18137;
const apiPort = 18138;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ROLES = ['auditor', 'governance_officer', 'authorized_approver', 'operator'] as const;
const THEMES = ['light', 'dark'] as const;
const ROUTES = [
  '/',
  '/operations',
  '/decisions',
  `/decisions/${STUB_DECISION}`,
  '/inventory',
  '/assets/ASSET-PAY-1',
  '/integrity',
  '/integrity/integrity-case-17',
  '/evidence',
  '/compliance',
  '/search?q=fraud',
  '/trends',
];

let stub: ConsoleStub;
let web: ChildProcess | undefined;
// Playwright and axe are imported lazily so the skipped suite never needs a browser installed.
let browser: import('@playwright/test').Browser;
let AxeBuilder: typeof import('@axe-core/playwright').default;

if (!LIVE) {
  process.stdout.write(
    '::notice::accessibility-live-routes skipped: set TC_A11Y_LIVE=1 (npm run test:a11y:live)\n',
  );
}

describe.skipIf(!LIVE)('live routes: WCAG 2.2 AA, both themes, every role', () => {
  beforeAll(async () => {
    stub = await startConsoleStub(apiPort);
    web = await startWeb(webPort, apiPort);
    const { chromium } = await import('@playwright/test');
    AxeBuilder = (await import('@axe-core/playwright')).default;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    stopWeb(web);
    await stub?.close();
  });

  async function open(role: string, theme: string, path: string, width = 1280) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme as 'light' | 'dark',
      extraHTTPHeaders: identityHeaders(`${role}-a11y`, role),
    });
    await context.addInitScript((value) => {
      try {
        window.localStorage.setItem('trustcircle-theme', value);
      } catch {
        // The pre-paint script falls back to prefers-color-scheme.
      }
    }, theme);
    const page = await context.newPage();
    const response = await page.goto(`http://127.0.0.1:${webPort}${path}`, {
      waitUntil: 'networkidle',
    });
    return { context, page, status: response?.status() ?? 0 };
  }

  for (const role of ROLES) {
    for (const theme of THEMES) {
      it(`${role} · ${theme}: every permitted route has zero axe violations`, async () => {
        const failures: string[] = [];
        let scanned = 0;
        for (const path of ROUTES) {
          const { context, page, status } = await open(role, theme, path);
          try {
            if (status === 404) continue; // not permitted for this role: nothing to scan
            expect(status, path).toBe(200);
            const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
            scanned += 1;
            for (const violation of result.violations) {
              failures.push(
                `${path}: ${violation.id} (${violation.nodes.length}) ${violation.nodes
                  .slice(0, 2)
                  .map((node) => node.target.join(' '))
                  .join(' | ')}`,
              );
            }
          } finally {
            await context.close();
          }
        }
        expect(scanned).toBeGreaterThan(3);
        expect(failures).toEqual([]);
      }, 180_000);
    }
  }

  it('reflows without horizontal scrolling at 390 px', async () => {
    const overflow: string[] = [];
    for (const path of [
      '/',
      '/decisions',
      `/decisions/${STUB_DECISION}`,
      '/integrity/integrity-case-17',
      '/evidence',
    ]) {
      const { context, page } = await open('governance_officer', 'light', path, 390);
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      if (widths.scroll > widths.client + 1) overflow.push(`${path}: ${JSON.stringify(widths)}`);
      await context.close();
    }
    expect(overflow).toEqual([]);
  }, 120_000);

  it('auditor requests a package, verifies it from the list, and downloads the receipt', async () => {
    const { context, page } = await open('auditor', 'light', '/evidence');
    try {
      await page.getByRole('button', { name: 'Request signed package' }).click();
      const verify = page.getByRole('button', { name: /^Verify package / });
      await expect.poll(() => verify.count()).toBe(1);
      await verify.click();
      await expect
        .poll(() => page.locator('.evidence-package-status').first().textContent())
        .toBe('Verified');
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: /^Download verification receipt/ }).click(),
      ]);
      const receipt = JSON.parse(
        await new Promise<string>((resolve, reject) => {
          void download.createReadStream().then((stream) => {
            let data = '';
            stream.on('data', (chunk) => (data += chunk));
            stream.on('end', () => resolve(data));
            stream.on('error', reject);
          });
        }),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({ valid: true, canonical_digest: 'a'.repeat(64) });
      expect(stub.requests.some((r) => r.method === 'POST' && r.path.endsWith('/verify'))).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  }, 120_000);
});
