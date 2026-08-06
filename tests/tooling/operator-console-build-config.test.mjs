import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('web workspace pins the governed production runtime', async () => {
  const pkg = await json('apps/web/package.json');
  assert.match(pkg.dependencies.next, /^16\./);
  assert.match(pkg.dependencies.react, /^19\./);
  assert.match(pkg.dependencies['react-dom'], /^19\./);
  assert.match(pkg.scripts.build, /^next build/);
  assert.equal(pkg.scripts.start, 'node .next/standalone/apps/web/server.js');
  assert.equal(pkg.engines.node, '>=22.0.0 <23.0.0');
});

test('standalone Next output and lockfile are present', async () => {
  const config = await readFile(new URL('apps/web/next.config.mjs', root), 'utf8');
  const lock = await json('package-lock.json');
  assert.match(config, /output:\s*['"]standalone['"]/);
  assert.ok(lock.packages['node_modules/next']);
  assert.ok(lock.packages['node_modules/react']);
  assert.ok(lock.packages['node_modules/react-dom']);
});
