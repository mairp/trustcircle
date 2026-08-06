import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
  'run_id',
  'task_ids',
  'requirement_ids',
  'actor',
  'environment',
  'command',
  'started_at',
  'ended_at',
  'duration_ms',
  'exit_code',
  'tests',
  'result',
  'artifacts',
  'digests',
  'gaps',
];

const SENSITIVE = [
  /authorization\s*:/i,
  /bearer\s+[a-z0-9._-]+/i,
  /(?:password|secret|token|cookie)\s*[=:]/i,
  /foreign[-_ ]tenant[-_ ]body/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
];

export function validateEvidence(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record))
    return ['record must be an object'];
  for (const key of REQUIRED) if (!(key in record)) errors.push(`missing ${key}`);
  if (record.run_id !== 'c00a3659-463d-44fb-96c0-f5f3efab97d8') errors.push('wrong run_id');
  if (!Array.isArray(record.task_ids) || !record.task_ids.every((id) => /^T\d{3}$/.test(id)))
    errors.push('invalid task_ids');
  if (!Array.isArray(record.requirement_ids)) errors.push('invalid requirement_ids');
  if (!['pass', 'fail', 'blocked', 'skipped'].includes(record.result))
    errors.push('invalid result');
  const serialized = JSON.stringify(record);
  for (const pattern of SENSITIVE)
    if (pattern.test(serialized)) errors.push(`sensitive marker rejected: ${pattern.source}`);
  return errors;
}

export async function appendEvidence(path, record) {
  const errors = validateEvidence(record);
  if (errors.length > 0) throw new TypeError(errors.join('; '));
  await appendFile(path, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'a',
    mode: 0o600,
  });
}

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile() && entry.name !== 'manifest.sha256') found.push(path);
  }
  return found.sort();
}

export async function buildManifest(
  directory,
  destination = resolve(directory, 'manifest.sha256'),
) {
  const lines = [];
  for (const path of await filesUnder(directory)) {
    const digest = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    lines.push(`${digest}  ${relative(process.cwd(), path)}`);
  }
  await writeFile(destination, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory] = process.argv.slice(2);
  if (command !== 'build' || !directory)
    throw new Error('usage: operator-console-evidence.mjs build <evidence-directory>');
  await buildManifest(resolve(directory));
}
