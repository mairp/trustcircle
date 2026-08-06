import { createServer } from 'node:http';

import { ensureNatsTopology } from './nats-topology-bootstrap.mjs';
import { startHealthSupervisor, SERVICE_DEPENDENCIES } from './runtime-health.mjs';

const service = process.argv[2];
const statusPortByService = Object.freeze({
  'command-worker': 3101,
  projector: 3102,
  'discovery-agent': 3103,
});
const moduleByService = Object.freeze({
  'command-worker': '../../apps/command-worker/src/main.ts',
  projector: '../../apps/projector/src/main.ts',
  'discovery-agent': '../../apps/discovery-agent/src/main.ts',
});

if (!service || !moduleByService[service] || !SERVICE_DEPENDENCIES[service]) {
  throw new Error(`worker-runtime: unsupported service ${JSON.stringify(service)}`);
}

// Loading the service module is a production-image contract check: missing runtime
// dependencies or an invalid TypeScript entrypoint must fail the container visibly.
await import(new URL(moduleByService[service], import.meta.url));

// The command worker owns outbox publication, so it also materializes the immutable
// JetStream topology declared in deploy/nats/topology.json. Existing streams/consumers
// are validated and never deleted or weakened; incompatible drift fails the service.
if (service === 'command-worker') {
  const topology = await ensureNatsTopology();
  process.stdout.write(`command-worker: NATS topology ready ${JSON.stringify(topology)}\n`);
}

let lastDependencyResult = null;
const markerPath = `/app/.health/${service}`;
const supervisor = startHealthSupervisor({
  service,
  markerPath,
  onTransition(result) {
    lastDependencyResult = result;
    const failed = result.dependencies
      .filter((dependency) => !dependency.healthy)
      .map((dependency) => dependency.name);
    process.stdout.write(
      `${service}: runtime ${result.healthy ? 'healthy' : 'blocked'}${
        failed.length > 0 ? `; unavailable=${failed.join(',')}` : ''
      }\n`,
    );
  },
});

// This endpoint makes the process boundary observable to the API composition root. It is explicit
// that this image currently supervises dependency health but does not start the injected governed
// workload, so reachability cannot be misreported as command/discovery/projection health.
const statusServer = createServer((request, response) => {
  if (request.url !== '/healthz') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const dependencyHealthy = lastDependencyResult?.healthy === true;
  response.writeHead(dependencyHealthy ? 200 : 503, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(
    JSON.stringify({
      service,
      processMode: 'dependency-supervisor',
      workloadStarted: false,
      dependencyHealthy,
      checkedAtMs: lastDependencyResult?.checkedAtMs ?? null,
      dependencies: lastDependencyResult?.dependencies ?? [],
    }),
  );
});
const statusPort = Number(process.env.RUNTIME_STATUS_PORT ?? statusPortByService[service]);
await new Promise((resolve, reject) => {
  statusServer.once('error', reject);
  statusServer.listen(statusPort, '0.0.0.0', resolve);
});
process.stdout.write(`${service}: status listening on :${statusPort}\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${service}: stopping on ${signal}\n`);
  await new Promise((resolve) => statusServer.close(resolve));
  await supervisor.stop();
  process.exit(0);
}

process.once('SIGTERM', () => {
  void stop('SIGTERM');
});
process.once('SIGINT', () => {
  void stop('SIGINT');
});
