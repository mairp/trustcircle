import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('production build emits a standalone server and build identifier', async () => {
  await access('apps/web/.next/standalone/apps/web/server.js');
  const buildId = (await readFile('apps/web/.next/BUILD_ID', 'utf8')).trim();
  assert.match(buildId, /^[A-Za-z0-9_-]+$/);
});

test('container target runs standalone as non-root on port 8080', async () => {
  const dockerfile = await readFile('deploy/compose/Dockerfile', 'utf8');
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS web-build/);
  assert.match(dockerfile, /COPY scripts \.\/scripts/);
  assert.match(dockerfile, /RUN npm run typecheck/);
  assert.match(
    dockerfile,
    /COPY --chown=node:node deploy\/compose\/healthcheck\.mjs \.\/deploy\/compose\/healthcheck\.mjs/,
  );
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /CMD \["node", "apps\/web\/server\.js"\]/);
});
