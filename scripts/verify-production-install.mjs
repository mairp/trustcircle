import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const packageLock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
const sandbox = await mkdtemp(join(tmpdir(), 'trustcircle-production-install-'));
const expectedPrefix = `${resolve(tmpdir())}${sep}`;

if (
  !resolve(sandbox).startsWith(expectedPrefix) ||
  !basename(sandbox).startsWith('trustcircle-production-install-')
) {
  throw new Error('refusing to use an unvalidated production-install sandbox');
}

function run(command, args, timeout) {
  const result = spawnSync(command, args, {
    cwd: sandbox,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

try {
  for (const file of ['package.json', 'package-lock.json']) {
    await cp(join(repositoryRoot, file), join(sandbox, file));
  }

  const workspaceManifestPaths = Object.keys(packageLock.packages)
    .filter((path) => /^(?:apps|adapters|packages)\/[^/]+$/.test(path))
    .sort();
  for (const workspacePath of workspaceManifestPaths) {
    const source = join(repositoryRoot, workspacePath, 'package.json');
    const destination = join(sandbox, workspacePath, 'package.json');
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }

  run('npm', ['ci', '--omit=dev'], 90_000);
  const importProof = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const m=await import('js-yaml');if(typeof m.load!=='function')process.exit(1);console.log('JS-YAML PRODUCTION IMPORT: PASS')",
    ],
    20_000,
  );
  const npmList = JSON.parse(run('npm', ['ls', '--omit=dev', 'js-yaml', '--json'], 20_000));
  const installed = JSON.parse(
    await readFile(join(sandbox, 'node_modules', 'js-yaml', 'package.json'), 'utf8'),
  );
  const rootLockEntry = packageLock.packages['node_modules/js-yaml'];

  if (
    installed.version !== '4.3.0' ||
    rootLockEntry?.version !== '4.3.0' ||
    rootLockEntry?.dev === true ||
    !importProof.includes('JS-YAML PRODUCTION IMPORT: PASS')
  ) {
    throw new Error('production js-yaml closure did not match the frozen oracle');
  }

  process.stdout.write(
    `${JSON.stringify({
      verdict: 'PRODUCTION INSTALL: PASS',
      installedVersion: installed.version,
      lockDevOnly: rootLockEntry.dev === true,
      workspaceManifestCount: workspaceManifestPaths.length,
      npmListRoot: npmList.name,
      importProof,
      usedExistingWorkspaceNodeModules: false,
    })}\n`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
