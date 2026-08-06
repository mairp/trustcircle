import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { connect } from 'node:net';

const DEFAULT_TIMEOUT_MS = 2_000;

const POSTGRES = Object.freeze({ kind: 'tcp', name: 'postgres', host: 'postgres', port: 5432 });
const NATS = Object.freeze({ kind: 'tcp', name: 'nats', host: 'nats', port: 4222 });
const OPA = Object.freeze({ kind: 'http', name: 'opa', url: 'http://opa:8181/health' });
const OBJECT_STORAGE = Object.freeze({
  kind: 'http',
  name: 'object-storage',
  url: 'http://object-storage:9000/minio/health/live',
});

export const SERVICE_DEPENDENCIES = Object.freeze({
  api: Object.freeze([POSTGRES, NATS, OPA, OBJECT_STORAGE]),
  'command-worker': Object.freeze([POSTGRES, NATS, OPA, OBJECT_STORAGE]),
  projector: Object.freeze([POSTGRES, NATS]),
  'discovery-agent': Object.freeze([POSTGRES, NATS, OPA]),
});

export async function probeTcp(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(healthy);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function probeHttp(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkDependencies(service, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const dependencies = SERVICE_DEPENDENCIES[service];
  if (!dependencies) throw new Error(`unsupported runtime service: ${service}`);

  const results = await Promise.all(
    dependencies.map(async (dependency) => {
      const healthy =
        dependency.kind === 'tcp'
          ? await probeTcp(dependency.host, dependency.port, timeoutMs)
          : await probeHttp(dependency.url, timeoutMs);
      return Object.freeze({ name: dependency.name, healthy });
    }),
  );

  return Object.freeze({
    service,
    checkedAtMs: Date.now(),
    healthy: results.every((result) => result.healthy),
    dependencies: Object.freeze(results),
  });
}

async function updateMarker(markerPath, result) {
  if (!result.healthy) {
    await rm(markerPath, { force: true });
    return;
  }

  await mkdir(dirname(markerPath), { recursive: true });
  const temporary = `${markerPath}.tmp`;
  const payload = `${JSON.stringify({
    service: result.service,
    status: 'healthy',
    checkedAtMs: result.checkedAtMs,
    dependencies: result.dependencies,
  })}\n`;
  await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, markerPath);
}

export function startHealthSupervisor({
  service,
  markerPath,
  intervalMs = 5_000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onTransition = () => {},
}) {
  if (!SERVICE_DEPENDENCIES[service]) throw new Error(`unsupported runtime service: ${service}`);
  if (!markerPath) throw new Error('markerPath is required');

  let stopped = false;
  let timer = null;
  let lastHealthy = null;
  let inFlight = Promise.resolve();

  const tick = async () => {
    if (stopped) return;
    const result = await checkDependencies(service, timeoutMs);
    await updateMarker(markerPath, result);
    if (result.healthy !== lastHealthy) {
      lastHealthy = result.healthy;
      onTransition(result);
    }
    if (!stopped)
      timer = setTimeout(() => {
        inFlight = tick();
      }, intervalMs);
  };

  inFlight = tick();

  return Object.freeze({
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight.catch(() => {});
      await rm(markerPath, { force: true });
    },
  });
}
