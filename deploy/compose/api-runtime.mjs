import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import yaml from 'js-yaml';
import pg from 'pg';

import {
  DEFAULT_LOCAL_PREVIEW_PRINCIPAL_ID,
  DEFAULT_LOCAL_PREVIEW_TENANT_ID,
  PostgresRuntimeReadModelRepository,
  createProductionApiRuntime,
} from '../../apps/api/src/production-runtime.ts';
import { PostgresOperationalCaseRepository } from '../../packages/persistence/src/operational-case-repository.ts';
import { reconcileLocalPreviewData } from '../../apps/api/src/local-preview-reconciliation.ts';
import { GOVERNANCE_FACETS } from '../../apps/api/src/server.ts';
import { reconcileRuntimeComponentProfile } from './runtime-component-reconciler.mjs';
import { checkDependencies, probeHttp, probeTcp } from './runtime-health.mjs';

const { Pool } = pg;
const PORT = Number(process.env.API_PORT ?? 3000);
const FRESHNESS_OBJECTIVE_MS = 15_000;
const PREVIEW_ENABLED = process.env.LOCAL_OPERATOR_PREVIEW === 'true';
const PREVIEW_TENANT_ID = process.env.LOCAL_PREVIEW_TENANT_ID ?? DEFAULT_LOCAL_PREVIEW_TENANT_ID;
const PREVIEW_PRINCIPAL_ID =
  process.env.LOCAL_PREVIEW_PRINCIPAL_ID ?? DEFAULT_LOCAL_PREVIEW_PRINCIPAL_ID;
const PREVIEW_SOURCE_HOST = process.env.LOCAL_PREVIEW_SOURCE_HOST ?? 'web';
const PREVIEW_RECONCILIATION_ENABLED =
  PREVIEW_ENABLED && process.env.LOCAL_PREVIEW_RECONCILIATION !== 'false';
const PREVIEW_DNS_TTL_MS = 2_000;
const COMPONENT_REFRESH_MS = Number(process.env.RUNTIME_COMPONENT_REFRESH_MS ?? 2_000);
const COMPONENT_PROBE_TIMEOUT_MS = Number(process.env.RUNTIME_COMPONENT_PROBE_TIMEOUT_MS ?? 2_000);
const COMPONENT_PROFILE_PATH =
  process.env.COMPONENT_PROFILE ?? '/app/deploy/profiles/components.yaml';

const componentProfile = yaml.load(await readFile(COMPONENT_PROFILE_PATH, 'utf8'));
// Validate the declaration at startup. A malformed profile is a composition error and must not
// degrade into a plausible-looking empty component list.
reconcileRuntimeComponentProfile(componentProfile, {}, Date.now());

let dependencyState = Object.freeze({
  service: 'api',
  checkedAtMs: 0,
  healthy: false,
  dependencies: Object.freeze([]),
});
let probeInFlight = false;
let trustedPreviewAddresses = new Set();
let trustedPreviewAddressesAt = 0;
let runtimeComponentRows = null;
let runtimeComponentRowsAt = 0;
let runtimeComponentProbeInFlight = null;

async function refreshDependencies() {
  if (probeInFlight) return;
  probeInFlight = true;
  try {
    dependencyState = await checkDependencies('api');
  } finally {
    probeInFlight = false;
  }
}

function normalizedAddress(address) {
  if (typeof address !== 'string') return undefined;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

async function refreshTrustedPreviewAddresses() {
  const now = Date.now();
  if (now - trustedPreviewAddressesAt < PREVIEW_DNS_TTL_MS) return;
  trustedPreviewAddressesAt = now;
  try {
    const resolved = await lookup(PREVIEW_SOURCE_HOST, { all: true, verbatim: true });
    trustedPreviewAddresses = new Set(
      resolved.map((entry) => normalizedAddress(entry.address)).filter(Boolean),
    );
  } catch {
    trustedPreviewAddresses = new Set();
  }
}

async function isTrustedPreviewTransport(request) {
  if (!PREVIEW_ENABLED || request.method !== 'GET') return false;
  await refreshTrustedPreviewAddresses();
  const remote = normalizedAddress(request.socket.remoteAddress);
  return remote !== undefined && trustedPreviewAddresses.has(remote);
}

async function probeHttpComponent(url, runtimeState = 'running') {
  const reachable = await probeHttp(url, COMPONENT_PROBE_TIMEOUT_MS);
  return {
    reachable,
    operational: reachable,
    runtimeState: reachable ? runtimeState : 'unavailable',
  };
}

async function probeTcpComponent(host, port, runtimeState = 'running') {
  const reachable = await probeTcp(host, port, COMPONENT_PROBE_TIMEOUT_MS);
  return {
    reachable,
    operational: reachable,
    runtimeState: reachable ? runtimeState : 'unavailable',
  };
}

async function probeWorkerComponent(url, workloadName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPONENT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const body = await response.json().catch(() => ({}));
    const workloadStarted = body?.workloadStarted === true;
    const mode =
      typeof body?.processMode === 'string' && body.processMode.length > 0
        ? body.processMode
        : workloadStarted
          ? 'running'
          : 'unknown';
    return {
      reachable: true,
      operational: response.ok && workloadStarted,
      runtimeState: mode,
      detail: workloadStarted
        ? `${workloadName} workload reports operational`
        : `${workloadName} module loaded; governed workload loop not started`,
    };
  } catch {
    return {
      reachable: false,
      operational: false,
      runtimeState: 'unavailable',
      detail: `${workloadName} status endpoint is unreachable`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function observeCoreComponent(componentId) {
  switch (componentId) {
    case 'postgres':
      return probeTcpComponent('postgres', 5432);
    case 'object-storage':
      return probeHttpComponent('http://object-storage:9000/minio/health/live');
    case 'nats':
      return probeHttpComponent('http://nats:8222/healthz?js-enabled-only=true');
    case 'opa':
      return probeHttpComponent('http://opa:8181/health');
    case 'collector':
      return probeTcpComponent('collector', 4317);
    case 'api':
      return {
        reachable: true,
        operational: dependencyState.healthy,
        runtimeState: dependencyState.healthy ? 'serving' : 'degraded-read-only',
        detail: dependencyState.healthy
          ? 'API serving with required dependencies reachable'
          : 'API serving read-only while one or more required dependencies are unavailable',
      };
    case 'command-worker':
      return probeWorkerComponent('http://command-worker:3101/healthz', 'command-worker');
    case 'projector':
      return probeWorkerComponent('http://projector:3102/healthz', 'projector');
    case 'discovery-agent':
      return probeWorkerComponent('http://discovery-agent:3103/healthz', 'discovery-agent');
    case 'web':
      return probeHttpComponent('http://web:8080/healthz', 'serving');
    default:
      return {
        reachable: false,
        operational: false,
        runtimeState: 'unobserved',
        detail: 'No approved live probe is configured for this core component',
      };
  }
}

async function refreshRuntimeComponents() {
  const now = Date.now();
  if (runtimeComponentRows && now - runtimeComponentRowsAt < COMPONENT_REFRESH_MS) {
    return runtimeComponentRows;
  }
  if (runtimeComponentProbeInFlight) return runtimeComponentProbeInFlight;
  runtimeComponentProbeInFlight = (async () => {
    const coreComponents = componentProfile.components.filter(
      (component) => component.runtimeSet === 'core-required',
    );
    const entries = await Promise.all(
      coreComponents.map(async (component) => [
        component.id,
        await observeCoreComponent(component.id),
      ]),
    );
    const observedAtMs = Date.now();
    const reconciled = reconcileRuntimeComponentProfile(
      componentProfile,
      Object.fromEntries(entries),
      observedAtMs,
    );
    runtimeComponentRows = reconciled;
    runtimeComponentRowsAt = observedAtMs;
    return reconciled;
  })();
  try {
    return await runtimeComponentProbeInFlight;
  } finally {
    runtimeComponentProbeInFlight = null;
  }
}

await refreshDependencies();
const probeTimer = setInterval(() => {
  void refreshDependencies();
}, 5_000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.API_READ_POOL_SIZE ?? 4),
  connectionTimeoutMillis: Number(process.env.API_READ_CONNECT_TIMEOUT_MS ?? 2_000),
  idleTimeoutMillis: Number(process.env.API_READ_IDLE_TIMEOUT_MS ?? 10_000),
  application_name: 'trustcircle-api-read-models',
});
if (PREVIEW_RECONCILIATION_ENABLED) {
  const adapterPaths = [
    'adapters/agentctl/manifest.json',
    'adapters/kanban/manifest.json',
    'adapters/lisa/manifest.json',
    'adapters/wiggum/manifest.json',
    'adapters/workflow-orchestration/manifest.json',
  ];
  const adapterManifests = await Promise.all(
    adapterPaths.map(async (path) => ({
      path,
      manifest: JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')),
    })),
  );
  const standardsRegistry = JSON.parse(
    await readFile(new URL('../../db/seeds/iso-4200x.json', import.meta.url), 'utf8'),
  );
  const reconciliation = await reconcileLocalPreviewData(pool, {
    tenantId: PREVIEW_TENANT_ID,
    tenantName: 'Local read-only preview',
    componentProfile,
    adapterManifests,
    standardsRegistry,
    observedAtMs: Date.now(),
  });
  process.stdout.write(`api: local preview reconciled ${JSON.stringify(reconciliation)}\n`);
}
const repository = new PostgresRuntimeReadModelRepository(
  pool,
  () => Date.now(),
  refreshRuntimeComponents,
);
const runtime = createProductionApiRuntime({
  repository,
  operationsRepository: new PostgresOperationalCaseRepository(pool),
  preview: {
    enabled: PREVIEW_ENABLED,
    tenantId: PREVIEW_TENANT_ID,
    principalId: PREVIEW_PRINCIPAL_ID,
    roles: ['auditor'],
  },
  now: () => Date.now(),
  readiness: () => {
    const unavailable = dependencyState.dependencies
      .filter((dependency) => !dependency.healthy)
      .map((dependency) => dependency.name);
    return {
      freshnessObjectiveMs: FRESHNESS_OBJECTIVE_MS,
      facets: GOVERNANCE_FACETS.map((name) => ({
        name,
        health: dependencyState.healthy ? 'healthy' : 'unavailable',
        observedAtMs: dependencyState.checkedAtMs,
        summary: dependencyState.healthy
          ? 'core runtime dependencies reachable'
          : `blocked by unavailable core dependencies: ${unavailable.join(',') || 'unknown'}`,
        core: true,
      })),
    };
  },
});
runtime.shutdown.onClose(() => repository.close());
runtime.shutdown.markReady();

async function bodyFor(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
    const body = method === 'GET' || method === 'HEAD' ? undefined : await bodyFor(request);
    const fetchRequest = new Request(url, {
      method,
      headers: request.headers,
      ...(body ? { body } : {}),
    });
    const fetchResponse = await runtime.fetch(fetchRequest, {
      trustedPreviewTransport: await isTrustedPreviewTransport(request),
    });
    const headers = {};
    fetchResponse.headers.forEach((value, key) => {
      headers[key] = value;
    });
    response.writeHead(fetchResponse.status, headers);
    if (method === 'HEAD') {
      response.end();
      return;
    }
    response.end(Buffer.from(await fetchResponse.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: 'INTERNAL_ERROR',
        message: 'request failed',
        safeNextAction: 'inspect the API runtime and dependency health',
      }),
    );
    process.stderr.write(
      `api: request failure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '0.0.0.0', resolve);
});
process.stdout.write(`api: listening on :${PORT}\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(probeTimer);
  process.stdout.write(`api: draining on ${signal}\n`);
  await new Promise((resolve) => server.close(resolve));
  await runtime.shutdown.shutdown(5_000);
  process.exit(0);
}

process.once('SIGTERM', () => {
  void stop('SIGTERM');
});
process.once('SIGINT', () => {
  void stop('SIGINT');
});
