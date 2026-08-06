import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(repositoryRoot, 'apps/web');
const runtimeRoot = resolve(webRoot, '.next/standalone/apps/web');

await mkdir(resolve(runtimeRoot, '.next'), { recursive: true });
await cp(resolve(webRoot, '.next/static'), resolve(runtimeRoot, '.next/static'), {
  recursive: true,
  force: true,
});
await cp(resolve(webRoot, 'public'), resolve(runtimeRoot, 'public'), {
  recursive: true,
  force: true,
});
